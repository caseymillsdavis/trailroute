#!/usr/bin/env python3
"""
trailroute.py - draw a planned hiking route on a georeferenced park map (GeoPDF).

Built for the Midpen preserve maps (ArcGIS Pro GeoPDF exports), standard library only.

    python3 trailroute.py MAP.pdf ROUTE.json [-o OUT.pdf] [--gpx OUT.gpx] [--png OUT.png]

ROUTE.json:

    {
      "name":   "Classic deep loop",
      "start":  "Skeggs Point",                  # a named place, or [lat, lon]
      "trails": ["Sierra Morena", "Fir", "Resolution",
                 "El Corte de Madera Creek", "Sierra Morena"],
      "end":    "Skeggs Point",                  # optional, defaults to start
      "color":  "#D81B7A"                        # optional
    }

The route walks the listed trails in order and takes the shortest path that uses
each one in sequence. Trail lines come from OpenStreetMap (fetched once for the
map's area and cached); only named, official (non-informal, publicly accessible)
trails are used. Elevation comes from USGS 3DEP 10 m data via OpenTopoData.

The output is the original PDF plus an incremental update: the route is drawn in
its own optional-content layer ("Planned route: <name>"), so it can be toggled in
Acrobat/Preview-style layer panels, and the GeoPDF georeferencing is untouched
(the file still works in Avenza Maps etc.).
"""
import argparse
import difflib
import heapq
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zlib

UA = "trailroute/0.1 (https://github.com/caseymillsdavis/trailroute)"
OVERPASS_URLS = ["https://overpass-api.de/api/interpreter",
                 "https://overpass.kumi.systems/api/interpreter"]

# Named places that OSM doesn't name, as (lat, lon). Matched to the parking icons
# on the 5/19/2026 El Corte de Madera Creek map; add your own as needed.
# ("Skeggs Point Parking" comes from OSM itself.)
EXTRA_PLACES = {
    "Methuselah": (37.405982, -122.304365),
    "Gordon Mill": (37.401022, -122.297898),
    "El Corte de Madera": (37.399520, -122.295083),  # Bear Gulch Rd lot, equestrian parking
    "Star Hill": (37.401576, -122.336343),
}

# --------------------------------------------------------------------------- PDF reading

OBJ_RE = re.compile(rb"(\d+)\s+(\d+)\s+obj\b")


class PDF:
    """Minimal object reader: enough for single-page ArcGIS exports."""

    def __init__(self, path):
        self.path = path
        self.data = open(path, "rb").read()
        self.objs = {}
        for m in OBJ_RE.finditer(self.data):
            num, start = int(m.group(1)), m.end()
            body = self.data[start:self.data.find(b"endobj", start)]
            si = body.find(b"stream")
            if si != -1 and body[:si].rstrip().endswith(b">>"):
                s = si + 6
                s += 2 if body[s:s + 2] == b"\r\n" else (1 if body[s:s + 1] in b"\r\n" else 0)
                self.objs[num] = (body[:si].strip(), body[s:body.rfind(b"endstream")])
            else:
                self.objs[num] = (body.strip(), None)
        for num, (head, raw) in list(self.objs.items()):
            if raw is not None and b"/ObjStm" in head:
                st = self.stream(num)
                n = int(re.search(rb"/N\s+(\d+)", head).group(1))
                first = int(re.search(rb"/First\s+(\d+)", head).group(1))
                nums = list(map(int, st[:first].split()))
                pairs = [(nums[i], nums[i + 1]) for i in range(0, 2 * n, 2)]
                for i, (onum, off) in enumerate(pairs):
                    end = pairs[i + 1][1] if i + 1 < len(pairs) else len(st) - first
                    self.objs.setdefault(onum, (st[first + off:first + end].strip(), None))

    def stream(self, num):
        head, raw = self.objs[num]
        lm = re.search(rb"/Length\s+(\d+)(\s+0\s+R)?", head)
        if lm:
            n = int(self.objs[int(lm.group(1))][0].split()[0]) if lm.group(2) else int(lm.group(1))
            raw = raw[:n]
        return zlib.decompress(raw) if b"/FlateDecode" in head else raw

    def find(self, pattern):
        return [n for n, (h, _) in sorted(self.objs.items()) if re.search(pattern, h)]

    def trailer(self):
        """(prev startxref offset, /Root ref, /Info ref, /ID array, /Size)."""
        prev = int(self.data[self.data.rfind(b"startxref") + 9:].split()[0])
        self.classic_xref = self.data[prev:prev + 4] == b"xref"
        at = self.data.find(b"trailer", prev) if self.classic_xref else prev
        tail = self.data[at:at + 4096]

        def get(p):
            m = re.search(p, tail)
            return m.group(1) if m else None
        root = get(rb"/Root\s+(\d+\s+\d+\s+R)")
        info = get(rb"/Info\s+(\d+\s+\d+\s+R)")
        ident = get(rb"/ID\s*(\[[^\]]*\])")
        size = int(get(rb"/Size\s+(\d+)") or max(self.objs) + 1)
        return prev, root, info, ident, size


# --------------------------------------------------------------------------- georeferencing

def lcc(wkt):
    """Lambert Conformal Conic (2SP) forward projection from an Esri WKT, in meters."""
    def par(name):
        return float(re.search(r'PARAMETER\["%s",([-0-9.eE]+)\]' % name, wkt).group(1))
    sph = re.search(r'SPHEROID\["[^"]*",([0-9.]+),([0-9.]+)\]', wkt)
    a, f = float(sph.group(1)), 1 / float(sph.group(2))
    e = math.sqrt(2 * f - f * f)
    r = math.radians
    p1, p2 = r(par("Standard_Parallel_1")), r(par("Standard_Parallel_2"))
    p0, l0 = r(par("Latitude_Of_Origin")), r(par("Central_Meridian"))
    m = lambda p: math.cos(p) / math.sqrt(1 - (e * math.sin(p)) ** 2)
    t = lambda p: math.tan(math.pi / 4 - p / 2) / ((1 - e * math.sin(p)) / (1 + e * math.sin(p))) ** (e / 2)
    n = (math.log(m(p1)) - math.log(m(p2))) / (math.log(t(p1)) - math.log(t(p2)))
    F = m(p1) / (n * t(p1) ** n)
    rho0 = a * F * t(p0) ** n

    def fwd(lat, lon):
        rho, th = a * F * t(r(lat)) ** n, n * (r(lon) - l0)
        return rho * math.sin(th), rho0 - rho * math.cos(th)
    return fwd


def solve3(A, b):
    M = [row[:] + [v] for row, v in zip(A, b)]
    for i in range(3):
        p = max(range(i, 3), key=lambda k: abs(M[k][i]))
        M[i], M[p] = M[p], M[i]
        for k in range(3):
            if k != i:
                f = M[k][i] / M[i][i]
                M[k] = [x - f * y for x, y in zip(M[k], M[i])]
    return [M[i][3] / M[i][i] for i in range(3)]


class Georef:
    def __init__(self, pdf):
        pages = pdf.find(rb"/Type\s*/Page\b")
        if not pages:
            sys.exit("No page found in PDF")
        self.page = pages[0]
        head = pdf.objs[self.page][0]
        mb = re.search(rb"/MediaBox\s*\[([^\]]+)\]", head)
        self.mediabox = [float(v) for v in mb.group(1).split()]
        if b"/VP" not in head or b"/GPTS" not in head:
            sys.exit("This PDF has no /VP + /GPTS georeferencing (not a GeoPDF).")
        vp = head[head.find(b"/VP"):]
        num = lambda key: [float(v) for v in re.search(key + rb"\s*\[([^\]]+)\]", vp).group(1).split()]
        bx0, by0, bx1, by1 = num(rb"/BBox")
        g, l = num(rb"/GPTS"), num(rb"/LPTS")
        wkt = re.search(rb"/WKT\s*\((.*?)\)\s*>>", vp, re.S)
        wkt = wkt.group(1).decode("latin-1") if wkt else ""
        if "Lambert_Conformal_Conic" in wkt and "Standard_Parallel_2" in wkt:
            self.proj = lcc(wkt)
        else:  # small-area fallback: local equirectangular
            lat0 = math.radians(sum(g[0::2]) / (len(g) // 2))
            self.proj = lambda la, lo: (lo * math.cos(lat0), la)
        src, dst = [], []
        for i in range(len(g) // 2):
            src.append(self.proj(g[2 * i], g[2 * i + 1]))
            dst.append((bx0 + l[2 * i] * (bx1 - bx0), by0 + l[2 * i + 1] * (by1 - by0)))
        AtA = [[0.0] * 3 for _ in range(3)]
        Atx, Aty = [0.0] * 3, [0.0] * 3
        for (E, N), (x, y) in zip(src, dst):
            v = (E, N, 1.0)
            for i in range(3):
                Atx[i] += v[i] * x
                Aty[i] += v[i] * y
                for j in range(3):
                    AtA[i][j] += v[i] * v[j]
        self.ax, self.ay = solve3(AtA, Atx), solve3(AtA, Aty)
        self.residual = max(math.hypot(*(a - b for a, b in zip(self._aff(E, N), d)))
                            for (E, N), d in zip(src, dst))
        self.frame = (bx0, by0, bx1, by1)
        lats, lons = g[0::2], g[1::2]
        self.bounds = (min(lats), min(lons), max(lats), max(lons))

    def _aff(self, E, N):
        return (self.ax[0] * E + self.ax[1] * N + self.ax[2],
                self.ay[0] * E + self.ay[1] * N + self.ay[2])

    def xy(self, lat, lon):
        return self._aff(*self.proj(lat, lon))

    def latlon(self, x, y):
        """Inverse of xy(), by Newton iteration (page points -> lat, lon)."""
        la, lo = sum(self.bounds[0::2]) / 2, sum(self.bounds[1::2]) / 2
        for _ in range(20):
            fx, fy = self.xy(la, lo)
            h = 1e-6
            ax, ay = self.xy(la + h, lo)
            bx, by = self.xy(la, lo + h)
            j11, j12, j21, j22 = (ax - fx) / h, (bx - fx) / h, (ay - fy) / h, (by - fy) / h
            det = j11 * j22 - j12 * j21
            dx, dy = x - fx, y - fy
            la, lo = la + (j22 * dx - j12 * dy) / det, lo + (-j21 * dx + j11 * dy) / det
        return la, lo


# --------------------------------------------------------------------------- trails (OSM)

FOOT_HIGHWAYS = {"path", "track", "footway", "bridleway", "steps", "pedestrian", "cycleway"}
CONNECTOR_MAX_M = 150  # unnamed links up to this long can join two named trails


def routable_ways(elements):
    """Yield (way, name) for each named official trail, then (way, "") for each
    short unnamed connector whose two ends are on different named trails.

    Trailheads are often mapped that way: at Skeggs Point, Fir Trail reaches
    Tafoni / El Corte de Madera Creek only through an unnamed bit of track by the gate.
    Longer unnamed paths, dead-end spurs and shortcuts back onto the same trail stay out.
    """
    ways = [w for w in elements if w["type"] == "way" and w.get("geometry")
            and Trails.usable(w.get("tags", {}))]
    on = {}
    for w in ways:
        name = w["tags"].get("name")
        if name:
            yield w, name
            for n in w["nodes"]:
                on.setdefault(n, set()).update(norm(x) for x in name.split(";"))
    for w in ways:
        if w["tags"].get("name"):
            continue
        a, b = on.get(w["nodes"][0]), on.get(w["nodes"][-1])
        g = [(p["lat"], p["lon"]) for p in w["geometry"]]
        if a and b and not (a & b) and sum(hav(p, q) for p, q in zip(g, g[1:])) <= CONNECTOR_MAX_M:
            yield w, ""


def fetch_osm(bounds, path):
    s, w, n, e = bounds
    pad = 0.004
    bb = "%.5f,%.5f,%.5f,%.5f" % (s - pad, w - pad, n + pad, e + pad)
    q = ('[out:json][timeout:90];(way["highway"](%s);way["amenity"="parking"](%s););out body geom;'
         % (bb, bb))
    print("Fetching trail data from OpenStreetMap ...", file=sys.stderr)
    why = ""
    for url in OVERPASS_URLS:  # main server first, then a mirror
        req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(),
                                     headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            json.loads(data)
            break
        except (OSError, ValueError) as ex:  # HTTP errors, timeouts, bad JSON
            why = str(ex)
    else:
        sys.exit("Couldn't download trail data from OpenStreetMap (%s). Try again in a minute." % why)
    with open(path, "wb") as f:
        f.write(data)


def norm(name):
    words = re.sub(r"[^a-z0-9 ]", " ", name.lower()).split()
    return " ".join(w for w in words if w not in ("trail", "tr", "the"))


def hav(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


class Trails:
    def __init__(self, osm_path):
        els = json.load(open(osm_path))["elements"]
        self.ll, self.adj, self.display = {}, {}, {}
        self.places, self.lots = {}, []
        for w in els:
            if w["type"] != "way":
                continue
            t = w.get("tags", {})
            geom = w.get("geometry") or []
            if t.get("amenity") == "parking" and geom:
                c = (sum(p["lat"] for p in geom) / len(geom), sum(p["lon"] for p in geom) / len(geom))
                self.lots.append((t.get("name") or "lot %d" % w["id"], c))
                if t.get("name"):
                    self.places[t["name"]] = c
        for w, name in routable_ways(els):
            # connectors get no names: the router lets any leg pass through them
            names = frozenset(norm(n) for n in name.split(";") if n.strip())
            for n in name.split(";"):
                if n.strip():
                    self.display.setdefault(norm(n), n.strip())
            ids, geom = w["nodes"], w["geometry"]
            for nid, p in zip(ids, geom):
                self.ll[nid] = (p["lat"], p["lon"])
            for a, b in zip(ids, ids[1:]):
                d = hav(self.ll[a], self.ll[b])
                self.adj.setdefault(a, []).append((b, names, d))
                self.adj.setdefault(b, []).append((a, names, d))
        self.places.update(EXTRA_PLACES)

    @staticmethod
    def usable(t):
        return (t.get("highway") in FOOT_HIGHWAYS and t.get("informal") != "yes"
                and t.get("access") not in ("no", "private") and t.get("foot") not in ("no", "private"))

    def resolve(self, name):
        k = norm(name)
        if k in self.display:
            return k
        close = difflib.get_close_matches(k, self.display, n=3, cutoff=0.5)
        hint = (" Did you mean: " + ", ".join(self.display[c] for c in close) + "?") if close else ""
        sys.exit('Unknown trail "%s".%s  (--list-trails shows them all)' % (name, hint))

    def place(self, spec):
        if isinstance(spec, (list, tuple)):
            return (float(spec[0]), float(spec[1])), "%.5f, %.5f" % tuple(spec)
        k = norm(spec)
        for name, ll in self.places.items():
            if norm(name) == k or norm(name).startswith(k):
                return ll, spec
        sys.exit('Unknown place "%s". Known: %s. Or use [lat, lon].'
                 % (spec, ", ".join(sorted(self.places))))

    def nodes_on(self, key):
        return {u for u, es in self.adj.items() if any(key in n for _, n, _ in es)}

    def route(self, keys, start_ll, end_ll):
        K = len(keys)
        s = min(self.nodes_on(keys[0]), key=lambda u: hav(self.ll[u], start_ll))
        t = min(self.nodes_on(keys[-1]), key=lambda u: hav(self.ll[u], end_ll))
        dist, prev = {(s, 0): 0.0}, {}
        pq = [(0.0, s, 0)]
        while pq:
            d, u, k = heapq.heappop(pq)
            if d > dist.get((u, k), math.inf):
                continue
            if (u, k) == (t, K - 1):
                break
            for v, names, L in self.adj.get(u, ()):
                for nk in ((k,) if not names else (k, k + 1)):  # unnamed connector: stay on this leg
                    if nk < K and (not names or keys[nk] in names) and d + L < dist.get((v, nk), math.inf):
                        dist[(v, nk)] = d + L
                        prev[(v, nk)] = (u, k)
                        heapq.heappush(pq, (d + L, v, nk))
        if (t, K - 1) not in dist:
            for a, b in zip(keys, keys[1:]):
                if not (self.nodes_on(a) & self.nodes_on(b)):
                    sys.exit("%s and %s don't meet. Add the connecting trail between them."
                             % (self.display[a], self.display[b]))
            sys.exit("No route found that follows those trails in that order.")
        states = [(t, K - 1)]
        while states[-1] in prev:
            states.append(prev[states[-1]])
        states.reverse()
        return [(self.ll[u], k) for u, k in states]


# --------------------------------------------------------------------------- elevation

def fetch_elevations(points, cache_path):
    cache = {}
    if os.path.exists(cache_path):
        cache = json.load(open(cache_path))
    key = lambda p: "%.5f,%.5f" % p
    todo = [p for p in points if key(p) not in cache]
    todo = list(dict.fromkeys(key(p) for p in todo))
    for i in range(0, len(todo), 100):
        batch = todo[i:i + 100]
        url = "https://api.opentopodata.org/v1/ned10m?locations=" + "|".join(batch)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            res = json.load(r)["results"]
        for k, item in zip(batch, res):
            cache[k] = item["elevation"]
        if i + 100 < len(todo):
            time.sleep(1.1)
    if todo:
        json.dump(cache, open(cache_path, "w"))
    return [cache[key(p)] for p in points]


def climb(elev_m, thr=3.0):
    """Total ascent/descent in meters, ignoring wiggles smaller than thr."""
    up = down = 0.0
    ref = elev_m[0]
    for e in elev_m[1:]:
        if e - ref >= thr:
            up, ref = up + e - ref, e
        elif ref - e >= thr:
            down, ref = down + ref - e, e
    return up, down


# --------------------------------------------------------------------------- route geometry

class Path:
    def __init__(self, pts):
        self.pts = pts
        self.cum = [0.0]
        for a, b in zip(pts, pts[1:]):
            self.cum.append(self.cum[-1] + hav(a, b))
        self.length = self.cum[-1]

    def at(self, d):
        d = max(0.0, min(d, self.length))
        i = max(1, next((j for j, c in enumerate(self.cum) if c >= d), len(self.cum) - 1))
        seg = self.cum[i] - self.cum[i - 1]
        f = (d - self.cum[i - 1]) / seg if seg else 0.0
        a, b = self.pts[i - 1], self.pts[i]
        return (a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]))


# --------------------------------------------------------------------------- drawing

HELV = dict(zip(range(32, 127), [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778,
    722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
    278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]))
HELVB = dict(zip(range(32, 127), [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778,
    722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
    278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584]))
EXTRA_W = {"–": 556, "·": 278, "−": 584, "×": 584}


def text_width(s, size, bold=False):
    tbl = HELVB if bold else HELV
    return sum(tbl.get(ord(c), EXTRA_W.get(c, 556)) for c in s) * size / 1000.0


def pdf_text(s):
    b = s.replace("−", "–").encode("cp1252", "replace")
    return "(" + b.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)").decode("latin-1") + ")"


def rgb(hexstr):
    h = hexstr.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


class Canvas:
    K = 0.5523

    def __init__(self):
        self.ops, self.gstates = [], {}

    def o(self, *parts):
        self.ops.append(" ".join(parts))

    def alpha(self, a):
        name = "A%d" % round(a * 100)
        self.gstates[name] = a
        self.o("/%s gs" % name)

    def stroke(self, c):
        self.o("%.3f %.3f %.3f RG" % c)

    def fill(self, c):
        self.o("%.3f %.3f %.3f rg" % c)

    def poly(self, pts):
        self.o("%.2f %.2f m" % pts[0])
        for p in pts[1:]:
            self.o("%.2f %.2f l" % p)

    def circle(self, x, y, r):
        k = self.K * r
        self.o("%.2f %.2f m" % (x + r, y))
        self.o("%.2f %.2f %.2f %.2f %.2f %.2f c" % (x + r, y + k, x + k, y + r, x, y + r))
        self.o("%.2f %.2f %.2f %.2f %.2f %.2f c" % (x - k, y + r, x - r, y + k, x - r, y))
        self.o("%.2f %.2f %.2f %.2f %.2f %.2f c" % (x - r, y - k, x - k, y - r, x, y - r))
        self.o("%.2f %.2f %.2f %.2f %.2f %.2f c" % (x + k, y - r, x + r, y - k, x + r, y))

    def rrect(self, x, y, w, h, r):
        k = self.K * r
        self.o("%.2f %.2f m" % (x + r, y))
        self.o("%.2f %.2f l" % (x + w - r, y))
        self.o("%.2f %.2f %.2f %.2f %.2f %.2f c" % (x + w - r + k, y, x + w, y + r - k, x + w, y + r))
        self.o("%.2f %.2f l" % (x + w, y + h - r))
        self.o("%.2f %.2f %.2f %.2f %.2f %.2f c" % (x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h))
        self.o("%.2f %.2f l" % (x + r, y + h))
        self.o("%.2f %.2f %.2f %.2f %.2f %.2f c" % (x + r - k, y + h, x, y + h - r + k, x, y + h - r))
        self.o("%.2f %.2f l" % (x, y + r))
        self.o("%.2f %.2f %.2f %.2f %.2f %.2f c" % (x, y + r - k, x + r - k, y, x + r, y))
        self.o("h")

    def text(self, x, y, s, size, color=(0, 0, 0), bold=False, align="left"):
        w = text_width(s, size, bold)
        x -= {"left": 0, "center": w / 2, "right": w}[align]
        self.fill(color)
        self.o("BT /%s %.2f Tf %.2f %.2f Td %s Tj ET" % ("F2" if bold else "F1", size, x, y, pdf_text(s)))
        return w


WHITE, INK, MUTED, RULE = (1, 1, 1), (0.13, 0.13, 0.13), (0.38, 0.38, 0.38), (0.82, 0.82, 0.82)


def up_down(up_ft, down_ft):
    u, d = int(round(up_ft, -1)), int(round(down_ft, -1))
    return "%s / %s ft" % ("+" + format(u, ",") if u else "0", "−" + format(d, ",") if d else "0")
MI, FT = 1609.344, 0.3048


def draw_route(cv, geo, route, color):
    """Route line, connectors, direction chevrons, junction dots, mile markers, start/end."""
    pts = [geo.xy(*p) for p in route["trail_pts"]]
    fx0, fy0, fx1, fy1 = geo.frame
    cv.o("q %.2f %.2f %.2f %.2f re W n 1 J 1 j" % (fx0, fy0, fx1 - fx0, fy1 - fy0))
    cv.alpha(0.7)
    cv.stroke(WHITE)
    cv.o("7.5 w")
    cv.poly(pts)
    cv.o("S")
    for conn in route["connectors"]:
        cv.poly([geo.xy(*p) for p in conn])
        cv.o("S")
    cv.alpha(0.9)
    cv.stroke(color)
    cv.o("3.8 w")
    cv.poly(pts)
    cv.o("S")
    cv.o("[3 2.5] 0 d 2.6 w")
    for conn in route["connectors"]:
        cv.poly([geo.xy(*p) for p in conn])
        cv.o("S")
    cv.o("[] 0 d")
    cv.alpha(1)

    path = route["path"]
    miles = [m * MI for m in range(1, int(path.length / MI) + 1)]
    # direction arrows
    step = 0.25 * MI
    d = step / 2
    cv.fill(WHITE)
    while d < path.length - 120:
        if all(abs(d - m) > 120 for m in miles):
            x0, y0 = geo.xy(*path.at(d - 15))
            x1, y1 = geo.xy(*path.at(d + 15))
            x, y = geo.xy(*path.at(d))
            a = math.atan2(y1 - y0, x1 - x0)
            c, s = math.cos(a), math.sin(a)
            cv.o("q %.4f %.4f %.4f %.4f %.2f %.2f cm" % (c, s, -s, c, x, y))
            cv.o("-2.2 2.3 m 2.6 0 l -2.2 -2.3 l -1 0 l h f Q")
        d += step
    # junction dots where the trail changes
    cv.o("1.4 w")
    for p in route["junctions"]:
        x, y = geo.xy(*p)
        cv.fill(WHITE)
        cv.stroke(color)
        cv.circle(x, y, 2.8)
        cv.o("B")
    # mile markers
    for i, m in enumerate(miles, 1):
        x, y = geo.xy(*path.at(m))
        cv.fill(color)
        cv.stroke(WHITE)
        cv.o("1.2 w")
        cv.circle(x, y, 6.6)
        cv.o("B")
        cv.text(x, y - 2.7, str(i), 7.6, WHITE, bold=True, align="center")
    # start / finish
    loop = hav(route["start_ll"], route["end_ll"]) < 30
    ends = [(route["start_ll"], "S/F" if loop else "S")] + ([] if loop else [(route["end_ll"], "F")])
    for ll, label in ends:
        x, y = geo.xy(*ll)
        cv.fill(INK)
        cv.stroke(WHITE)
        cv.o("1.6 w")
        cv.circle(x, y, 9)
        cv.o("B")
        cv.text(x, y - 2.4, label, 6.6 if len(label) > 1 else 8.5, WHITE, bold=True, align="center")
    cv.o("Q")


def draw_card(cv, route, color, box):
    """Summary card: title, totals, per-leg table, elevation profile."""
    x0, y0, x1, y1 = box
    pad = 10
    legs, elev = route["legs"], route.get("elev_ft")
    rows = len(legs)
    # fit everything into the box: squeeze rows first, then the profile
    head_h, stats_h, foot_h, gap = 24, 33, 13, 6
    prof_min, prof_max, prof_lbl = 36, 90, 20
    avail = y1 - y0
    fixed = head_h + stats_h + foot_h + gap + (prof_lbl + prof_min if elev else 0)
    row_h = max(9.0, min(11.5, (avail - fixed) / max(rows, 1)))
    fs = min(8.5, row_h * 0.8)
    prof_h = max(prof_min, min(prof_max, avail - fixed + prof_min - rows * row_h)) if elev else 0
    h = head_h + stats_h + rows * row_h + gap + (prof_h + prof_lbl if elev else 0) + foot_h
    if h > avail + 0.5:
        print("warning: route card is %.0f pt taller than its box" % (h - avail), file=sys.stderr)
    top, w = y1, x1 - x0
    bottom = top - h
    cv.o("q")
    cv.alpha(0.96)
    cv.fill(WHITE)
    cv.stroke(RULE)
    cv.o("0.8 w")
    cv.rrect(x0, bottom, w, h, 5)
    cv.o("B")
    cv.alpha(1)
    cv.fill(color)
    cv.rrect(x0, top - head_h, w, head_h, 5)
    cv.o("f")
    cv.o("%.2f %.2f %.2f %.2f re f" % (x0, top - head_h, w, 6))
    cv.text(x0 + pad, top - 16.5, "Planned route: " + route["name"], 12, WHITE, bold=True)

    y = top - head_h - 16
    dist_mi = route["path"].length / MI
    stats = "%.1f mi" % dist_mi
    if elev:
        stats += "  ·  +%s ft / −%s ft" % (format(round(route["gain_ft"], -1), ",.0f"),
                                                    format(round(route["loss_ft"], -1), ",.0f"))
        hrs = dist_mi / 2.5 + route["gain_ft"] / 2000
        stats += "  ·  ~%.1f h" % (round(hrs * 2) / 2)
    cv.text(x0 + pad, y, stats, 11, INK, bold=True)
    y -= 12
    sub = "Start: %s" % route["start_name"]
    if hav(route["start_ll"], route["end_ll"]) < 30:
        sub = "Start & finish: %s" % route["start_name"]
    else:
        sub += "   Finish: %s" % route["end_name"]
    if elev:
        sub += "   ·   time at 2.5 mph + 1 h per 2,000 ft"
    cv.text(x0 + pad, y, sub, 7.5, MUTED)

    cursor = top - head_h - stats_h  # running top edge of the next block
    cx_dist, cx_up = x1 - pad - 110, x1 - pad
    for i, leg in enumerate(legs, 1):
        y = cursor - row_h * i + (row_h - fs) / 2 + 1
        cv.text(x0 + pad, y, str(i), fs, color, bold=True)
        cv.text(x0 + pad + 13, y, leg["name"], fs, INK)
        cv.text(cx_dist, y, "%.2f mi" % (leg["m"] / MI), fs, INK, align="right")
        if elev:
            cv.text(cx_up, y, up_down(leg["up_ft"], leg["down_ft"]), fs, MUTED, align="right")
    cursor -= rows * row_h + gap
    if elev:
        px0, px1 = x0 + pad + 30, x1 - pad
        py1 = cursor - 9  # room above for leg numbers
        py0 = py1 - prof_h
        L = route["path"].length
        lo, hi = min(elev), max(elev)
        lo_t, hi_t = math.floor(lo / 100) * 100, math.ceil(hi / 100) * 100
        X = lambda d: px0 + (px1 - px0) * d / L
        Y = lambda e: py0 + (py1 - py0) * (e - lo_t) / ((hi_t - lo_t) or 1)
        prof = [(X(d), Y(e)) for d, e in zip(route["elev_d"], elev)]
        cv.stroke(RULE)
        cv.o("0.5 w")
        for v, dy in ((lo_t, 1), (hi_t, -2.5)):
            cv.poly([(px0, Y(v)), (px1, Y(v))])
            cv.o("S")
            cv.text(px0 - 4, Y(v) + dy, format(int(v), ",") + " ft", 6.5, MUTED, align="right")
        cv.o("[1 1.5] 0 d")
        for d in route["leg_breaks"]:
            cv.poly([(X(d), py0), (X(d), py1)])
            cv.o("S")
        cv.o("[] 0 d")
        cv.alpha(0.22)
        cv.fill(color)
        cv.poly([(px0, py0)] + prof + [(px1, py0)])
        cv.o("f")
        cv.alpha(1)
        cv.stroke(color)
        cv.o("1.2 w 1 j")
        cv.poly(prof)
        cv.o("S")
        starts = [0.0] + route["leg_breaks"]
        ends_ = route["leg_breaks"] + [L]
        for i, (a, b) in enumerate(zip(starts, ends_), 1):
            if X(b) - X(a) > 8:
                cv.text((X(a) + X(b)) / 2, py1 + 2.5, str(i), 6, color, bold=True, align="center")
        cv.text(px0 - 4, py0 - 8, "mi", 6.5, MUTED, align="right")
        for m in range(0, int(L / MI) + 1):
            cv.text(X(m * MI), py0 - 8, "%d" % m, 6.5, MUTED, align="center")
    cv.text(x0 + pad, bottom + 5, "Trails © OpenStreetMap contributors (ODbL)  ·  elevation USGS 3DEP "
            "via OpenTopoData  ·  distances approximate  ·  stay on designated trails",
            5.6, MUTED)
    cv.o("Q")


# --------------------------------------------------------------------------- PDF writing

def write_overlay(pdf, geo, content, gstates, layer_name, out_path):
    src = pdf.data
    prev, root, info, ident, size = pdf.trailer()
    page_num = geo.page
    page_head = pdf.objs[page_num][0]
    root_num = int(root.split()[0])
    cat_head = pdf.objs[root_num][0]
    nxt = max(size, max(pdf.objs) + 1)
    n_ocg, n_f1, n_f2, n_form, n_cont, n_xref = range(nxt, nxt + 6)

    out = bytearray(src)
    if not out.endswith(b"\n"):
        out += b"\n"
    offsets = {}

    def emit(num, body):
        offsets[num] = len(out)
        out.extend(b"%d 0 obj\n" % num + body + b"\nendobj\n")

    def emit_stream(num, head, data):
        z = zlib.compress(data, 9)
        emit(num, head[:-2] + b"/Filter /FlateDecode /Length %d>>\nstream\n" % len(z) + z + b"\nendstream")

    emit(n_ocg, b"<</Type /OCG /Name " + pdf_text(layer_name).encode("latin-1") + b">>")
    emit(n_f1, b"<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>")
    emit(n_f2, b"<</Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding>>")
    gs = b"".join(b"/%s <</Type /ExtGState /CA %.2f /ca %.2f>>" % (k.encode(), a, a) for k, a in gstates.items())
    W, H = geo.mediabox[2], geo.mediabox[3]
    emit_stream(n_form, b"<</Type /XObject /Subtype /Form /BBox [0 0 %g %g] /OC %d 0 R "
                b"/Resources <</Font <</F1 %d 0 R /F2 %d 0 R>> /ExtGState <<%s>>>>>>"
                % (W, H, n_ocg, n_f1, n_f2, gs), content.encode("latin-1"))
    emit_stream(n_cont, b"<<>>", b"q /TrailRoute Do Q\n")

    # page: append our content stream, add our XObject to its resources (inline copy)
    res_ref = re.search(rb"/Resources\s+(\d+)\s+0\s+R", page_head)
    if res_ref:
        res = pdf.objs[int(res_ref.group(1))][0]
    else:
        m = re.search(rb"/Resources\s*<<", page_head)
        depth, i = 0, m.end() - 2
        for j in range(i, len(page_head)):
            if page_head[j:j + 2] == b"<<":
                depth += 1
            elif page_head[j:j + 2] == b">>":
                depth -= 1
                if depth == 0:
                    break
        res = page_head[i:j + 2]
    if re.search(rb"/XObject\s*<<", res):
        res = re.sub(rb"/XObject\s*<<", b"/XObject << /TrailRoute %d 0 R " % n_form, res, count=1)
    elif re.search(rb"/XObject\s+\d+\s+0\s+R", res):
        xo = int(re.search(rb"/XObject\s+(\d+)\s+0\s+R", res).group(1))
        inner = pdf.objs[xo][0].strip()[2:-2]
        res = re.sub(rb"/XObject\s+\d+\s+0\s+R", b"/XObject << /TrailRoute %d 0 R %s>>" % (n_form, inner), res)
    else:
        res = res[:2] + b"/XObject << /TrailRoute %d 0 R >> " % n_form + res[2:]
    cm = re.search(rb"/Contents\s+(\d+\s+0\s+R|\[[^\]]*\])", page_head)
    old = cm.group(1)
    old = old[1:-1] if old.startswith(b"[") else old
    new_page = page_head[:cm.start()] + b"/Contents [" + old + b" %d 0 R]" % n_cont + page_head[cm.end():]
    if res_ref:
        new_page = new_page.replace(res_ref.group(0), b"/Resources " + res)
    else:
        new_page = new_page.replace(re.search(rb"/Resources\s*", new_page).group(0) + res, b"/Resources " + res)
    emit(page_num, new_page)

    ocgs = [n_ocg] + [n for n in pdf.find(rb"/Type\s*/OCG")]
    refs = b" ".join(b"%d 0 R" % n for n in ocgs)
    ocprops = b"/OCProperties <</OCGs [%s] /D <</Order [%s] /ON [%s]>>>> " % (refs, refs, refs)
    cat = re.sub(rb"/OCProperties\s*<<(?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>)*>>", b"", cat_head)
    emit(root_num, b"<<" + ocprops + cat.strip()[2:])

    if pdf.classic_xref:  # original uses a classic xref table: append one of those
        nums = sorted(offsets)
        x = b"xref\n"
        i = 0
        while i < len(nums):
            j = i
            while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
                j += 1
            x += b"%d %d\n" % (nums[i], j - i + 1)
            x += b"".join(b"%010d 00000 n \n" % offsets[n] for n in nums[i:j + 1])
            i = j + 1
        xoff = len(out)
        t = b"trailer\n<</Size %d /Prev %d /Root %s" % (n_cont + 1, prev, root)
        t += (b" /Info " + info if info else b"") + (b" /ID " + ident if ident else b"")
        out.extend(x + t + b">>\nstartxref\n%d\n%%%%EOF\n" % xoff)
        with open(out_path, "wb") as f:
            f.write(out)
        return

    # cross-reference stream for this update
    offsets[n_xref] = len(out)
    nums = sorted(offsets)
    index, run = [], [nums[0], 1]
    for a, b in zip(nums, nums[1:]):
        if b == a + 1:
            run[1] += 1
        else:
            index += run
            run = [b, 1]
    index += run
    rows = b"".join(b"\x01" + offsets[n].to_bytes(4, "big") + b"\x00\x00" for n in nums)
    head = (b"<</Type /XRef /Size %d /W [1 4 2] /Index [%s] /Prev %d /Root %s"
            % (n_xref + 1, b" ".join(b"%d" % v for v in index), prev, root))
    if info:
        head += b" /Info " + info
    if ident:
        head += b" /ID " + ident
    head += b" /Length %d>>" % len(rows)
    out.extend(b"%d 0 obj\n" % n_xref + head + b"\nstream\n" + rows + b"\nendstream\nendobj\n")
    out.extend(b"startxref\n%d\n%%%%EOF\n" % offsets[n_xref])
    with open(out_path, "wb") as f:
        f.write(out)


def write_gpx(route, path):
    esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;")
    pts = route["path"].pts
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<gpx version="1.1" creator="trailroute" xmlns="http://www.topografix.com/GPX/1/1">',
             "<trk><name>%s</name><trkseg>" % esc(route["name"])]
    lines += ['<trkpt lat="%.6f" lon="%.6f"/>' % p for p in pts]
    lines += ["</trkseg></trk></gpx>"]
    open(path, "w").write("\n".join(lines) + "\n")


# --------------------------------------------------------------------------- main

def build(args):
    pdf = PDF(args.map)
    geo = Georef(pdf)
    if geo.residual > 2:
        print("warning: georeference fit residual %.1f pt" % geo.residual, file=sys.stderr)
    stem = os.path.splitext(os.path.basename(args.map))[0]
    cache_dir = os.path.expanduser(args.cache_dir)
    os.makedirs(cache_dir, exist_ok=True)
    base = os.path.join(cache_dir, stem)
    out_dir = os.path.dirname(os.path.abspath(args.route)) if args.route else os.getcwd()
    osm_path = args.osm or base + ".osm.json"
    if args.refresh_osm or not os.path.exists(osm_path):
        fetch_osm(geo.bounds, osm_path)
    trails = Trails(osm_path)
    if args.debug_trails:
        cv = Canvas()
        cv.o("q 0 0.75 0.9 RG 1.2 w 1 J")
        seen = set()
        for u, es in trails.adj.items():
            for v, _, _ in es:
                if (v, u) not in seen:
                    seen.add((u, v))
                    cv.poly([geo.xy(*trails.ll[u]), geo.xy(*trails.ll[v])])
                    cv.o("S")
        for name, ll in trails.lots:
            x, y = geo.xy(*ll)
            cv.fill((0.9, 0.1, 0.1))
            cv.circle(x, y, 4)
            cv.o("f")
            cv.text(x + 6, y - 3, name, 8, (0.9, 0.1, 0.1), bold=True)
        cv.o("Q")
        out = args.output or os.path.join(out_dir, stem + " - debug trails.pdf")
        write_overlay(pdf, geo, "\n".join(cv.ops) + "\n", cv.gstates, "OSM trails (debug)", out)
        print("Wrote %s (fit residual %.2f pt)" % (out, geo.residual))
        return
    if args.list_trails:
        for k in sorted(trails.display):
            print(trails.display[k])
        print("\nPlaces:", ", ".join(sorted(trails.places)))
        return
    if not args.route:
        sys.exit("Give a route file (or --list-trails).")

    spec = json.load(open(args.route))
    keys = [trails.resolve(t) for t in spec["trails"]]
    start_ll, start_name = trails.place(spec["start"])
    end_ll, end_name = trails.place(spec.get("end", spec["start"]))
    steps = trails.route(keys, start_ll, end_ll)

    trail_pts = [p for p, _ in steps]
    connectors = []
    full = list(trail_pts)
    off = 0
    if hav(start_ll, trail_pts[0]) > 8:
        connectors.append([start_ll, trail_pts[0]])
        full.insert(0, start_ll)
        off = 1
    if hav(end_ll, trail_pts[-1]) > 8:
        connectors.append([trail_pts[-1], end_ll])
        full.append(end_ll)
    path = Path(full)

    # legs: distance + where each starts (distance along path)
    legs = [{"name": trails.display[k], "m": 0.0} for k in keys]
    breaks, junctions = [], []
    for i in range(1, len(steps)):
        k = steps[i][1]
        legs[k]["m"] += path.cum[i + off] - path.cum[i - 1 + off]
        if k != steps[i - 1][1]:
            breaks.append(path.cum[i - 1 + off])
            junctions.append(steps[i - 1][0])
    legs[0]["m"] += path.cum[off]
    legs[-1]["m"] += path.length - path.cum[len(steps) - 1 + off]

    route = {"name": spec.get("name", "Route"), "path": path, "trail_pts": trail_pts,
             "connectors": connectors, "junctions": junctions, "legs": legs, "leg_breaks": breaks,
             "start_ll": start_ll, "end_ll": end_ll, "start_name": start_name, "end_name": end_name}

    if not args.no_elevation:
        try:
            n = max(2, int(path.length / 40))
            ds = [path.length * i / n for i in range(n + 1)]
            samples = [path.at(d) for d in ds]
            el = fetch_elevations(samples, base + ".elev.json")
            ft = [e / FT for e in el]
            route["elev_d"], route["elev_ft"] = ds, ft
            up, down = climb(el)
            route["gain_ft"], route["loss_ft"] = up / FT, down / FT
            edges = [0.0] + breaks + [path.length]
            for leg, a, b in zip(legs, edges, edges[1:]):
                seg = [e for d, e in zip(ds, el) if a <= d <= b]
                u, dn = climb(seg) if len(seg) > 1 else (0, 0)
                leg["up_ft"], leg["down_ft"] = u / FT, dn / FT
        except Exception as ex:  # network trouble: still draw the route
            print("warning: no elevation data (%s)" % ex, file=sys.stderr)

    color = rgb(spec.get("color", args.color))
    cv = Canvas()
    draw_route(cv, geo, route, color)
    draw_card(cv, route, color, tuple(args.card))
    out = args.output or os.path.join(out_dir, stem + " - " + re.sub(r"[^\w\- ]", "", route["name"]) + ".pdf")
    write_overlay(pdf, geo, "\n".join(cv.ops) + "\n", cv.gstates, "Planned route: " + route["name"], out)
    print("Wrote %s" % out)
    if args.gpx:
        write_gpx(route, args.gpx)
        print("Wrote %s" % args.gpx)
    if args.png:
        stem = os.path.splitext(args.png)[0]
        subprocess.run(["pdftoppm", "-r", str(args.png_dpi), "-png", "-singlefile", out, stem], check=True)
        print("Wrote %s" % args.png)

    print("\n%s: %.2f mi" % (route["name"], path.length / MI), end="")
    if "gain_ft" in route:
        print(", +%.0f ft / -%.0f ft" % (route["gain_ft"], route["loss_ft"]), end="")
    print()
    for i, leg in enumerate(legs, 1):
        extra = ("   +%.0f / -%.0f ft" % (leg["up_ft"], leg["down_ft"])) if "up_ft" in leg else ""
        print("  %d. %-32s %5.2f mi%s" % (i, leg["name"], leg["m"] / MI, extra))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("map", help="GeoPDF park map (e.g. Midpen map_ECDM.pdf)")
    ap.add_argument("route", nargs="?", help="route JSON file")
    ap.add_argument("-o", "--output", help="output PDF (default: '<map> - <route name>.pdf')")
    ap.add_argument("--gpx", help="also write the route as GPX")
    ap.add_argument("--png", help="also render a PNG preview")
    ap.add_argument("--png-dpi", type=int, default=100)
    ap.add_argument("--osm", help="OSM trail data file (default: <cache-dir>/<map>.osm.json)")
    ap.add_argument("--cache-dir", default="~/.cache/trailroute",
                    help="where downloaded trail + elevation data is kept")
    ap.add_argument("--refresh-osm", action="store_true", help="re-download trail data")
    ap.add_argument("--no-elevation", action="store_true")
    ap.add_argument("--color", default="#D81B7A", help="route color (default magenta)")
    ap.add_argument("--card", type=float, nargs=4, default=[1458, 428, 1844, 690],
                    metavar=("X0", "Y0", "X1", "Y1"), help="summary card box in PDF points")
    ap.add_argument("--list-trails", action="store_true", help="list trail and place names")
    ap.add_argument("--debug-trails", action="store_true",
                    help="draw every usable OSM trail, to check alignment with the map")
    build(ap.parse_args())


if __name__ == "__main__":
    main()
