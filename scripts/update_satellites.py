#!/usr/bin/env python3
"""Rebuild satellites.js from CelesTrak's list of active satellites."""

import argparse
import base64
import csv
import io
import json
import math
import os
import struct
import sys
import urllib.request
from datetime import datetime, timezone

SOURCE = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=csv"
OUTPUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "satellites.js")
MIN_SATELLITES = 10000
MIN_SHARE_OF_PREVIOUS = 0.9
RECORD_SIZE = 33

# Name prefix in the data, label shown on the page, operator or country.
GROUPS = [
    ("STARLINK", "Starlink", "SpaceX"),
    ("ONEWEB", "OneWeb", "Eutelsat"),
    ("KUIPER", "Kuiper", "Amazon"),
    ("QIANFAN", "Qianfan", "Spacesail"),
    ("HULIANWANG DIGUI", "Guowang", "China SatNet"),
    ("YAOGAN", "Yaogan", "China"),
    ("COSMOS", "Cosmos", "Russia"),
    ("FLOCK", "Flock", "Planet"),
    ("LEMUR", "Lemur", "Spire"),
    ("IRIDIUM", "Iridium", "Iridium"),
]


def read_source(path):
    if path:
        with open(path, encoding="utf-8") as source:
            return source.read()
    request = urllib.request.Request(SOURCE, headers={"User-Agent": "ayansiv.github.io monthly update"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read().decode("utf-8")


def previous_count():
    try:
        with open(OUTPUT, encoding="ascii") as current:
            text = current.read()
        payload = json.loads(text[text.index("{"):text.rindex("}") + 1])
        return len(base64.b64decode(payload["data"])) // RECORD_SIZE
    except (OSError, ValueError, KeyError):
        return 0


def group_of(name):
    for index, (prefix, _, _) in enumerate(GROUPS):
        if name.startswith(prefix):
            return index + 1
    return 0


def parse(row, reference):
    motion = float(row["MEAN_MOTION"]) * 2 * math.pi / 1440
    eccentricity = float(row["ECCENTRICITY"])
    if motion <= 0 or not 0 <= eccentricity < 1:
        raise ValueError("unusable orbit")
    epoch = datetime.fromisoformat(row["EPOCH"]).replace(tzinfo=timezone.utc)
    return (
        motion,
        eccentricity,
        math.radians(float(row["INCLINATION"])),
        math.radians(float(row["RA_OF_ASC_NODE"])),
        math.radians(float(row["ARG_OF_PERICENTER"])),
        math.radians(float(row["MEAN_ANOMALY"])),
        (epoch - reference).total_seconds() / 60,
        float(row["MEAN_MOTION_DOT"]) * 2 * math.pi / (1440 * 1440),
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="read a saved CSV instead of downloading")
    args = parser.parse_args()

    now = datetime.now(timezone.utc).replace(microsecond=0)
    try:
        text = read_source(args.input)
    except (OSError, ValueError) as error:
        sys.exit(f"Download failed ({error}), keeping the existing data.")
    rows = csv.DictReader(io.StringIO(text))
    if "MEAN_MOTION" not in (rows.fieldnames or []):
        sys.exit("Unexpected response from CelesTrak, keeping the existing data.")

    orbits = bytearray()
    groups = bytearray()
    for row in rows:
        try:
            orbit = parse(row, now)
        except (KeyError, ValueError):
            continue
        orbits += struct.pack("<8f", *orbit)
        groups.append(group_of(row["OBJECT_NAME"].strip().upper()))

    if len(groups) < max(MIN_SATELLITES, int(previous_count() * MIN_SHARE_OF_PREVIOUS)):
        sys.exit(f"Only {len(groups)} satellites parsed, keeping the existing data.")

    payload = {
        "date": now.date().isoformat(),
        "ref": int(now.timestamp() * 1000),
        "groups": [[label, owner] for _, label, owner in GROUPS],
        "data": base64.b64encode(bytes(orbits + groups)).decode("ascii"),
    }
    temporary = OUTPUT + ".tmp"
    with open(temporary, "w", encoding="ascii", newline="\n") as output:
        output.write("window.SATELLITES = " + json.dumps(payload, separators=(",", ":")) + ";\n")
    os.replace(temporary, OUTPUT)
    print(f"Wrote {len(groups)} satellites.")


if __name__ == "__main__":
    main()
