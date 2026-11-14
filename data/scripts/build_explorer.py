"""
build_explorer.py — Build the data file behind the parcel explorer (explorer/).

Everything comes from the City of Norfolk's public GIS server and open-data portal:
  Zoning           gisshare.norfolk.gov  OpenData/Planning/FeatureServer/1   (ZONE = HC-G2, HC-G3)
  Parcels          gisshare.norfolk.gov  OpenData/Parcels/FeatureServer/1
  Buildings        gisshare.norfolk.gov  InteractiveMapper/Property_Information_Group_IM/MapServer/1
  Street centerline gisshare.norfolk.gov OpenData/Public_Works/FeatureServer/1
  Addresses        data.norfolk.gov      ere7-kake  (Address Information)
  Assessment FY26  data.norfolk.gov      m5ya-5grb  (use, class, year built, lot size; owner is NOT kept)
  Assessor photos  api.spatialest.com    the city assessor's photo index (the photos stay on gisshare.norfolk.gov)

Geometry is requested in Virginia State Plane South (EPSG:2284, US feet) and written in metres,
relative to the district's centre, with +x east and +y north.

Run:  python3 data/scripts/build_explorer.py
Out:  explorer/data/ghent.json
Needs: shapely (see requirements.txt)
"""

import json
import math
import os
import time
import urllib.parse
import urllib.request
from datetime import date

from shapely.geometry import LineString, MultiPolygon, Point, Polygon, shape
from shapely.ops import unary_union

GIS = "https://gisshare.norfolk.gov/pubserver/rest/services"
ZONING = f"{GIS}/OpenData/Planning/FeatureServer/1"
PARCELS = f"{GIS}/OpenData/Parcels/FeatureServer/1"
BUILDINGS = f"{GIS}/InteractiveMapper/Property_Information_Group_IM/MapServer/1"
STREETS = f"{GIS}/OpenData/Public_Works/FeatureServer/1"
SOCRATA = "https://data.norfolk.gov/resource"
PHOTOS = "https://api.spatialest.com/v1/va/norfolk/images?type=photo&json=1&id="

FT = 0.3048                      # US survey foot ≈ international foot at this precision
UA = {"User-Agent": "ghent-streets-explorer/1.0 (+https://github.com/jedelman/ghent-zoning-reform)"}
OUT = os.path.join(os.path.dirname(__file__), "../../explorer/data/ghent.json")


def get_json(url, params=None, tries=3):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))


def arcgis_query(layer, where="1=1", envelope=None, out_fields="*"):
    """All features of an ArcGIS layer (paged), as GeoJSON-like dicts in EPSG:2284 feet."""
    feats, offset = [], 0
    while True:
        p = {"where": where, "outFields": out_fields, "outSR": 2284, "f": "geojson",
             "resultOffset": offset, "resultRecordCount": 1000}
        if envelope:
            p.update({"geometry": ",".join(f"{v:.1f}" for v in envelope),
                      "geometryType": "esriGeometryEnvelope", "inSR": 2284,
                      "spatialRel": "esriSpatialRelIntersects"})
        d = get_json(f"{layer}/query", p)
        page = d.get("features", [])
        feats += page
        if len(page) < 1000 and not d.get("exceededTransferLimit") and not d.get("properties", {}).get("exceededTransferLimit"):
            return feats
        offset += len(page)


def socrata(dataset, field, values, select):
    rows = []
    vals = sorted(set(values))
    for i in range(0, len(vals), 150):
        chunk = ",".join(f"'{v}'" for v in vals[i:i + 150])
        rows += get_json(f"{SOCRATA}/{dataset}.json", {"$select": select, "$where": f"{field} in({chunk})", "$limit": 5000})
    return rows


def geom(f):
    g = f.get("geometry")
    return shape(g) if g else None


def affine_fit(pairs):
    """Least-squares lat = a·x + b·y + c and lng = d·x + e·y + f, from (x, y, lat, lng) samples."""
    n = len(pairs)
    if n < 3:
        raise RuntimeError("not enough address points to fit coordinates")
    mx = sum(p[0] for p in pairs) / n
    my = sum(p[1] for p in pairs) / n
    sxx = sum((p[0] - mx) ** 2 for p in pairs)
    syy = sum((p[1] - my) ** 2 for p in pairs)
    sxy = sum((p[0] - mx) * (p[1] - my) for p in pairs)
    det = sxx * syy - sxy * sxy

    def solve(k):
        mv = sum(p[k] for p in pairs) / n
        sxv = sum((p[0] - mx) * (p[k] - mv) for p in pairs)
        syv = sum((p[1] - my) * (p[k] - mv) for p in pairs)
        a = (sxv * syy - syv * sxy) / det
        b = (syv * sxx - sxv * sxy) / det
        return a, b, mv - a * mx - b * my

    la, lo = solve(2), solve(3)
    return lambda x, y: (la[0] * x + la[1] * y + la[2], lo[0] * x + lo[1] * y + lo[2])


def main():
    # 1. The district, and the HC-G3 pocket next to it.
    g2 = unary_union([geom(f) for f in arcgis_query(ZONING, "ZONE='HC-G2'", out_fields="ZONE") if geom(f)])
    g3 = unary_union([geom(f) for f in arcgis_query(ZONING, "ZONE='HC-G3'", out_fields="ZONE") if geom(f)])
    minx, miny, maxx, maxy = g2.bounds
    env = (minx - 250, miny - 250, maxx + 250, maxy + 250)
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2

    def local(x, y):
        return [round((x - cx) * FT, 1), round((y - cy) * FT, 1)]

    def ring(poly):
        # Rounded to 0.1 m, then without repeated neighbours (three.js's extrusion divides by
        # an edge's length, so a zero-length edge turns into NaN).
        pts = []
        for x, y in list(poly.exterior.coords)[:-1]:
            q = local(x, y)
            if not pts or q != pts[-1]:
                pts.append(q)
        if len(pts) > 1 and pts[0] == pts[-1]:
            pts.pop()
        return pts

    def polys(g):
        return [g] if isinstance(g, Polygon) else list(g.geoms) if isinstance(g, MultiPolygon) else []

    # 2. Parcels whose interior point lies in HC-G2.
    parcels = []
    for f in arcgis_query(PARCELS, envelope=env, out_fields="GPIN"):
        g = geom(f)
        gpin = (f["properties"].get("GPIN") or "").strip()
        if not g or not gpin or not g2.contains(g.representative_point()):
            continue
        parcels.append({"gpin": gpin, "geom": g})

    # 3. Streets: centerlines with names, for corners and frontages.
    streets = []
    for f in arcgis_query(STREETS, envelope=env, out_fields="FULLNAME,ROW"):
        g = geom(f)
        name = (f["properties"].get("FULLNAME") or "").strip()
        if g and name:
            streets.append({"name": name, "row": f["properties"].get("ROW"), "geom": g})

    # Corner lots: the parcel's edge comes within half a right-of-way (plus a little) of two
    # differently named streets, and those streets meet within 120 ft of the parcel.
    by_name = {}
    for s in streets:
        by_name.setdefault(s["name"], []).append(s["geom"])
    merged = {n: unary_union(gs) for n, gs in by_name.items()}
    for p in parcels:
        g = p["geom"]
        near = []
        for n, line in merged.items():
            reach = 45  # ft from a centerline to the lot line: half of a typical 50–60 ft right-of-way, plus slack
            if g.distance(line) <= reach:
                near.append((g.distance(line), n))
        near.sort()
        names = [n for _, n in near]
        p["streets"] = names
        corner = False
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                meet = merged[names[i]].intersection(merged[names[j]])
                if not meet.is_empty and g.distance(meet) <= 120:
                    corner = True
        p["corner"] = corner

    # 4. Buildings, each assigned to the parcel holding its interior point.
    buildings = []
    for f in arcgis_query(BUILDINGS, envelope=env, out_fields="ELEV,FTR_CODE,DEMO"):
        g = geom(f)
        pr = f["properties"]
        if not g or pr.get("DEMO") == 1:
            continue
        pt = g.representative_point()
        owner = next((p for p in parcels if p["geom"].contains(pt)), None)
        area_ft2 = g.area
        elev = pr.get("ELEV")
        # ELEV is labelled only "Elevation". Read as roof elevation in feet and take off ~7 ft of
        # ground; where it's missing, assume a two-story house, or a shed for small footprints.
        if elev and elev > 12:
            h_ft = min(max(elev - 7, 10), 140)
        else:
            h_ft = 11 if area_ft2 < 450 else 26
        for poly in polys(g):
            buildings.append({"parcel": owner["gpin"] if owner else None,
                              "h": round(h_ft * FT, 1), "poly": ring(poly.simplify(0.5))})

    # 5. Addresses and assessment, by GPIN (owner deliberately not requested).
    gpins = [p["gpin"] for p in parcels]
    addr, pairs = {}, []
    for r in socrata("ere7-kake", "gpin", gpins,
                     "gpin,full_address,parcel_centroid_latitude,parcel_centroid_longitude,"
                     "state_plane_x_coordinate,state_plane_y_coordinate"):
        a = (r.get("full_address") or "").strip()
        if a and a.upper() != "NO ADDRESS":
            addr.setdefault(r["gpin"], []).append(a)
        try:
            pairs.append((float(r["state_plane_x_coordinate"]), float(r["state_plane_y_coordinate"]),
                          float(r["parcel_centroid_latitude"]), float(r["parcel_centroid_longitude"])))
        except (KeyError, TypeError, ValueError):
            pass

    # State plane feet → latitude/longitude: an affine fit to the city's own address points,
    # which carry both. Over a district under a kilometre across it's good to well under a metre.
    to_ll = affine_fit(pairs)
    worst = max(math.hypot((to_ll(x, y)[0] - la) * 111000, (to_ll(x, y)[1] - lo) * 89000) for x, y, la, lo in pairs)
    print(f"coordinate fit: {len(pairs)} address points, worst residual {worst:.2f} m")

    # A Street View viewpoint for each parcel: the nearest point on its nearest street,
    # looking at the parcel.
    for p in parcels:
        p["sv"] = None
        if not p["streets"]:
            continue
        line = merged[p["streets"][0]]
        c = p["geom"].representative_point()
        on = line.interpolate(line.project(c))
        lat, lng = to_ll(on.x, on.y)
        heading = (math.degrees(math.atan2(c.x - on.x, c.y - on.y)) + 360) % 360
        p["sv"] = [round(lat, 6), round(lng, 6), round(heading)]
    assess = {}
    for r in socrata("m5ya-5grb", "gpin", gpins,
                     "gpin,parcel_id,property_class_description,property_use,improvement_year_built,"
                     "land_square_footage,commercial_building_area"):
        assess.setdefault(r["gpin"], r)

    # 6. The assessor's street photo, for corner lots (the explorer's featured parcels).
    for p in parcels:
        a = assess.get(p["gpin"], {})
        p["pid"] = a.get("parcel_id")
        p["photo"] = None
        if p["corner"] and p["pid"]:
            try:
                urls = get_json(PHOTOS + urllib.parse.quote(p["pid"]))
                if urls:
                    # The index gives Windows paths (001\\0031\\1300C012.jpg). The server takes forward
                    # slashes as well, and some proxies refuse a backslash in a path.
                    p["photo"] = urls[0].replace("\\", "/")
            except Exception:
                pass
            time.sleep(0.2)

    def num(v):
        try:
            return int(float(v))
        except (TypeError, ValueError):
            return None

    out_parcels = []
    for p in parcels:
        a = assess.get(p["gpin"], {})
        poly = max(polys(p["geom"]), key=lambda q: q.area)
        out_parcels.append({
            "gpin": p["gpin"],
            "pid": p["pid"],
            "address": sorted(addr.get(p["gpin"], []))[0] if addr.get(p["gpin"]) else None,
            "addresses": len(addr.get(p["gpin"], [])),
            "use": a.get("property_use"),
            "cls": a.get("property_class_description"),
            "built": num(a.get("improvement_year_built")),
            "lot_sqft": num(a.get("land_square_footage")),
            "corner": p["corner"],
            "streets": p["streets"][:3],
            "photo": p["photo"],
            "sv": p["sv"],
            "poly": ring(poly.simplify(0.5)),
        })

    clip = Polygon([(env[0], env[1]), (env[2], env[1]), (env[2], env[3]), (env[0], env[3])])
    out = {
        "meta": {
            "built": date.today().isoformat(),
            "crs": "metres east/north of the HC-G2 centre; source EPSG:2284 (VA State Plane South, US ft)",
            "centre_ft": [round(cx, 1), round(cy, 1)],
            "sources": {
                "zoning": ZONING, "parcels": PARCELS, "buildings": BUILDINGS, "streets": STREETS,
                "addresses": "https://data.norfolk.gov/d/ere7-kake",
                "assessment": "https://data.norfolk.gov/d/m5ya-5grb",
                "photos": "City of Norfolk Real Estate Assessor (via air.norfolk.gov)",
            },
            "heights": "approximate: the city's building 'Elevation' field read as roof elevation in feet, less ~7 ft of ground",
        },
        "district": [ring(q) for q in polys(g2)],
        "g3": [ring(q) for q in polys(g3)],
        "parcels": out_parcels,
        "buildings": buildings,
        "streets": [{"name": s["name"], "kind": s["row"],  # the layer's ROW field is a class: residential, arterial/collector
                     "line": [local(x, y) for x, y in s["geom"].intersection(clip).coords]}
                    for s in streets if isinstance(s["geom"].intersection(clip), LineString)
                    and not s["geom"].intersection(clip).is_empty],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    corners = sum(1 for p in out_parcels if p["corner"])
    photos = sum(1 for p in out_parcels if p["photo"])
    print(f"{len(out_parcels)} parcels ({corners} corner, {photos} with photos), "
          f"{len(buildings)} buildings, {len(out['streets'])} street pieces → {os.path.relpath(OUT)} "
          f"({os.path.getsize(OUT) // 1024} KB)")


if __name__ == "__main__":
    main()
