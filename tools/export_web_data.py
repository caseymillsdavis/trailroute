#!/usr/bin/env python3
"""Turn an Overpass trail download into the compact JSON the web app ships with.

    python3 tools/export_web_data.py OSM.json "El Corte de Madera Creek" docs/data/ecdm.json

Keeps only routable trails (named, not informal, publicly accessible, plus short
unnamed connectors between them: the same rules trailroute.py uses), and parking
lots. Connectors are written with an empty name. The download must include unnamed
ways (trailroute.py's cache does). Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import trailroute  # noqa: E402


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    src, title, dst = sys.argv[1:]
    els = json.load(open(src))["elements"]
    ways, parking = [], []
    lats, lons = [], []
    for w in els:
        if w["type"] != "way":
            continue
        t, geom = w.get("tags", {}), w.get("geometry") or []
        if t.get("amenity") == "parking" and geom:
            if t.get("access") in ("private", "no", "customers"):
                continue
            parking.append({"name": t.get("name", ""),
                            "lat": round(sum(p["lat"] for p in geom) / len(geom), 6),
                            "lon": round(sum(p["lon"] for p in geom) / len(geom), 6)})
    for w, name in trailroute.routable_ways(els):
        coords = [[round(p["lat"], 6), round(p["lon"], 6)] for p in w["geometry"]]
        lats += [c[0] for c in coords]
        lons += [c[1] for c in coords]
        ways.append({"id": w["id"], "name": name, "n": w["nodes"], "c": coords})
    named = {p["name"] for p in parking if p["name"]}
    for name, (la, lo) in trailroute.EXTRA_PLACES.items():
        if name not in named:
            parking.append({"name": name, "lat": la, "lon": lo})
    out = {"title": title,
           "attribution": "Trail data © OpenStreetMap contributors (ODbL)",
           "bounds": [min(lats), min(lons), max(lats), max(lons)],
           "ways": ways,
           "parking": parking}
    with open(dst, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print("%s: %d trails, %d parking areas, %d bytes" % (dst, len(ways), len(parking), os.path.getsize(dst)))


if __name__ == "__main__":
    main()
