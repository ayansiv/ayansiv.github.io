(function () {
  var source = window.SATELLITES;
  var figure = document.getElementById("map");
  var canvas = document.getElementById("globe");
  var gl = source && canvas.getContext("webgl", { alpha: false, antialias: true });
  if (!gl) return;
  figure.hidden = false;

  var TILT = 20 * Math.PI / 180;
  var YAW_PER_SECOND = 0.75 * Math.PI / 180;
  var PICK_RADIUS = 12;
  var J2 = 1.082616e-3;
  var XKE = 0.07436691613;
  var TWO_PI = 2 * Math.PI;

  var bytes = Uint8Array.from(atob(source.data), function (c) { return c.charCodeAt(0); });
  var count = bytes.length / 33;
  var elements = new Float32Array(bytes.buffer, 0, count * 8);
  var group = bytes.subarray(count * 32);

  // Published mean motion is in the Kozai convention, so it is converted first, as
  // SGP4 does. Precession then comes from Earth's equatorial bulge (J2), and drag from
  // the published decay rate.
  var orbit = new Float64Array(count * 8);
  var info = new Float32Array(count * 2);
  var totals = source.groups.map(function () { return 0; });
  for (var s = 0; s < count; s++) {
    var kozai = elements[s * 8], e = elements[s * 8 + 1], inclination = elements[s * 8 + 2];
    var root = Math.sqrt(1 - e * e);
    var cosI = Math.cos(inclination), sinI = Math.sin(inclination);
    var ak = Math.pow(XKE / kozai, 2 / 3);
    var d1 = 0.75 * J2 * (3 * cosI * cosI - 1) / (root * root * root);
    var del = d1 / (ak * ak);
    var adel = ak * (1 - del * del - del * (1 / 3 + 134 * del * del / 81));
    var motion = kozai / (1 + d1 / (adel * adel));
    var a = Math.pow(XKE / motion, 2 / 3);
    var p = a * root * root;
    var bulge = 1.5 * J2 * motion / (p * p);
    orbit.set([a, a * root, bulge * -cosI, bulge * (2 - 2.5 * sinI * sinI),
      motion + bulge * root * (1 - 1.5 * sinI * sinI), cosI, sinI, e], s * 8);
    info[s * 2] = a < 2 ? 0 : (e < 0.05 && Math.abs(a - 6.61) < 0.2 ? 2 : 1);
    info[s * 2 + 1] = group[s];
    if (group[s]) totals[group[s] - 1]++;
  }

  var positions = new Float32Array(count * 3);
  var propagated = 0;

  function propagate() {
    propagated = Date.now();
    var minutes = (propagated - source.ref) / 60000;
    for (var i = 0; i < count; i++) {
      var el = i * 8, o = i * 8;
      var dt = minutes - elements[el + 6];
      var ecc = orbit[o + 7];
      var mean = (elements[el + 5] + orbit[o + 4] * dt + elements[el + 7] * dt * dt) % TWO_PI;
      var E = mean + ecc * Math.sin(mean);
      for (var k = ecc < 0.01 ? 2 : 8; k > 0; k--) {
        E -= (E - ecc * Math.sin(E) - mean) / (1 - ecc * Math.cos(E));
      }
      var xp = orbit[o] * (Math.cos(E) - ecc);
      var yp = orbit[o + 1] * Math.sin(E);
      var node = elements[el + 3] + orbit[o + 2] * dt;
      var arg = elements[el + 4] + orbit[o + 3] * dt;
      var cn = Math.cos(node), sn = Math.sin(node), ca = Math.cos(arg), sa = Math.sin(arg);
      var ci = orbit[o + 5], si = orbit[o + 6];
      positions[i * 3] = xp * (cn * ca - sn * sa * ci) - yp * (cn * sa + sn * ca * ci);
      positions[i * 3 + 1] = xp * (sn * ca + cn * sa * ci) - yp * (sn * sa - cn * ca * ci);
      positions[i * 3 + 2] = xp * sa * si + yp * ca * si;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
  }

  function shader(type, text) {
    var compiled = gl.createShader(type);
    gl.shaderSource(compiled, text);
    gl.compileShader(compiled);
    return compiled;
  }

  var program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, `
    attribute vec3 position;
    attribute vec2 info;
    uniform vec4 frame;
    uniform vec4 view;
    uniform vec2 sizes;
    uniform float highlight;
    uniform float layer;
    uniform float ink;
    varying float glyph;
    varying vec4 color;
    void main() {
      float x = position.x * view.x - position.y * view.y;
      float y = position.x * view.y + position.y * view.x;
      float up = y * view.w + position.z * view.z;
      float near = position.z * view.w - y * view.z;
      gl_Position = vec4(x * frame.x + frame.z, up * frame.y + frame.w, 0.0, 1.0);
      gl_PointSize = info.x < 0.5 ? sizes.x : sizes.y;
      glyph = info.x;
      if (layer < 0.5) {
        color = vec4(0.55, 0.55, 0.55, 1.0);
        return;
      }
      bool chosen = abs(info.y - highlight) < 0.5;
      bool behind = near < 0.0 && x * x + up * up < 1.0;
      if (behind || (layer > 1.5) != chosen) {
        gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
        return;
      }
      float depth = near < 0.0 ? 0.5 : 1.0;
      if (layer > 1.5) {
        color = vec4(0.91, 0.267, 0.039, depth);
      } else {
        float strength = info.x < 0.5 ? ink : 0.95;
        color = vec4(0.07, 0.07, 0.07, strength * depth * (highlight < 0.0 ? 1.0 : 0.16));
      }
    }`));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    uniform float edge;
    varying float glyph;
    varying vec4 color;
    void main() {
      if (glyph > 0.5) {
        vec2 p = abs(gl_PointCoord - 0.5);
        if (glyph < 1.5 ? min(p.x, p.y) > edge * 0.5 : max(p.x, p.y) < 0.5 - edge) discard;
      }
      gl_FragColor = color;
    }`));
  gl.linkProgram(program);
  gl.useProgram(program);

  var uniforms = {};
  ["frame", "view", "sizes", "highlight", "layer", "edge", "ink"].forEach(function (name) {
    uniforms[name] = gl.getUniformLocation(program, name);
  });
  var positionSlot = gl.getAttribLocation(program, "position");
  var infoSlot = gl.getAttribLocation(program, "info");
  var positionBuffer = gl.createBuffer();
  var infoBuffer = gl.createBuffer();
  var lineBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, infoBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, info, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(positionSlot);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(1, 1, 1, 1);

  var width, height, scale, centerX, centerY;
  var yaw = 0, cosYaw = 1, sinYaw = 0;
  var cosTilt = Math.cos(TILT), sinTilt = Math.sin(TILT);
  var hover = -1, pinned = -1, highlight = -1, dirty = true;

  function resize() {
    var rect = canvas.getBoundingClientRect();
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    gl.viewport(0, 0, canvas.width, canvas.height);
    if (window.matchMedia("(min-width: 1100px) and (min-height: 720px)").matches) {
      var textEdge = document.querySelector("main").getBoundingClientRect().right + 16;
      var room = width - textEdge;
      centerX = textEdge + room / 2;
      scale = Math.min(room / 2 / 6.9, height * 0.5 / 4.6);
    } else {
      centerX = width / 2;
      scale = Math.min(width, height) / 2 / 4.6;
    }
    centerY = height / 2;
    var glyph = 2 * Math.round(ratio * 2) + 1;
    gl.uniform2f(uniforms.sizes, Math.max(1.5, ratio * 0.95), glyph);
    gl.uniform1f(uniforms.edge, Math.max(1, Math.round(ratio)) / glyph);
    gl.uniform1f(uniforms.ink, Math.min(0.6, Math.max(0.3, scale / 120)));
    gl.uniform4f(uniforms.frame, 2 * scale / width, 2 * scale / height, 2 * centerX / width - 1, 1 - 2 * centerY / height);
    dirty = true;
  }

  var SEGMENTS = 180;
  var lines = new Float32Array(4 * SEGMENTS * 6);

  function buildLines() {
    var used = 0;
    function circle(ux, uy, uz, vx, vy, vz, dashed) {
      for (var i = 0; i < SEGMENTS; i++) {
        var a0 = i / SEGMENTS * TWO_PI, a1 = (i + 1) / SEGMENTS * TWO_PI;
        var c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        var x0 = ux * c0 + vx * s0, y0 = uy * c0 + vy * s0, z0 = uz * c0 + vz * s0;
        var back = z0 * sinTilt - (x0 * sinYaw + y0 * cosYaw) * cosTilt < 0;
        if (dashed && back && i % 4 > 1) continue;
        lines.set([x0, y0, z0, ux * c1 + vx * s1, uy * c1 + vy * s1, uz * c1 + vz * s1], used);
        used += 6;
      }
    }
    circle(cosYaw, -sinYaw, 0, sinTilt * sinYaw, sinTilt * cosYaw, cosTilt, false);
    circle(1, 0, 0, 0, 1, 0, true);
    circle(1, 0, 0, 0, 0, 1, true);
    circle(0, 1, 0, 0, 0, 1, true);
    return used / 3;
  }

  function draw() {
    dirty = false;
    cosYaw = Math.cos(yaw);
    sinYaw = Math.sin(yaw);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform4f(uniforms.view, cosYaw, sinYaw, cosTilt, sinTilt);
    gl.uniform1f(uniforms.highlight, highlight);

    drawSatellites(1);

    var vertices = buildLines();
    gl.uniform1f(uniforms.layer, 0);
    gl.disableVertexAttribArray(infoSlot);
    gl.vertexAttrib2f(infoSlot, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, lines, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(positionSlot, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINES, 0, vertices);

    if (highlight >= 0) drawSatellites(2);
  }

  function drawSatellites(layer) {
    gl.enableVertexAttribArray(infoSlot);
    gl.bindBuffer(gl.ARRAY_BUFFER, infoBuffer);
    gl.vertexAttribPointer(infoSlot, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(positionSlot, 3, gl.FLOAT, false, 0, 0);
    gl.uniform1f(uniforms.layer, layer);
    gl.drawArrays(gl.POINTS, 0, count);
  }

  function pick(event) {
    var rect = canvas.getBoundingClientRect();
    var px = event.clientX - rect.left, py = event.clientY - rect.top;
    var best = -1, bestDistance = PICK_RADIUS * PICK_RADIUS;
    for (var i = 0; i < count; i++) {
      var wx = positions[i * 3], wy = positions[i * 3 + 1], wz = positions[i * 3 + 2];
      var vx = wx * cosYaw - wy * sinYaw;
      var ry = wx * sinYaw + wy * cosYaw;
      var vy = ry * sinTilt + wz * cosTilt;
      if (wz * sinTilt - ry * cosTilt < 0 && vx * vx + vy * vy < 1) continue;
      var dx = centerX + vx * scale - px, dy = centerY - vy * scale - py;
      var distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best >= 0 && group[best] ? group[best] : -1;
  }

  var list = document.getElementById("groups");
  var readout = document.getElementById("readout");
  document.getElementById("updated").textContent = new Date(source.date + "T12:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

  var buttons = source.groups.map(function (entry, index) {
    var id = index + 1;
    var button = document.createElement("button");
    var total = document.createElement("span");
    button.type = "button";
    button.textContent = entry[0];
    total.textContent = totals[index].toLocaleString("en-US");
    button.appendChild(total);
    button.addEventListener("pointerenter", function (event) { if (event.pointerType === "mouse") setHover(id); });
    button.addEventListener("pointerleave", function (event) { if (event.pointerType === "mouse") setHover(-1); });
    button.addEventListener("focus", function () { if (button.matches(":focus-visible")) setHover(id); });
    button.addEventListener("blur", function () { setHover(-1); });
    button.addEventListener("click", function () { pinned = pinned === id ? -1 : id; refresh(); });
    var item = document.createElement("li");
    item.appendChild(button);
    list.appendChild(item);
    return button;
  });

  function setHover(id) {
    if (hover === id) return;
    hover = id;
    refresh();
  }

  function refresh() {
    highlight = hover >= 0 ? hover : pinned;
    buttons.forEach(function (button, index) { button.classList.toggle("on", index + 1 === highlight); });
    readout.classList.toggle("on", highlight >= 0);
    if (highlight >= 0) {
      var entry = source.groups[highlight - 1];
      readout.textContent = entry[0] + ", " + entry[1] + ", " + totals[highlight - 1].toLocaleString("en-US") + " satellites.";
    } else {
      readout.textContent = "";
    }
    dirty = true;
  }

  canvas.addEventListener("pointermove", function (event) { if (event.pointerType === "mouse") setHover(pick(event)); });
  canvas.addEventListener("pointerleave", function () { setHover(-1); });
  canvas.addEventListener("click", function (event) { pinned = pick(event); refresh(); });
  window.addEventListener("resize", resize);

  var still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function tick(now) {
    var moved = !still;
    if (Date.now() - propagated > (still ? 60000 : 1000)) {
      propagate();
      moved = true;
    }
    if (!still) yaw = now / 1000 * YAW_PER_SECOND;
    if (moved || dirty) draw();
    window.requestAnimationFrame(tick);
  }

  resize();
  refresh();
  window.requestAnimationFrame(tick);
})();
