// Trail graph: official trails from OpenStreetMap, densified so clicks snap
// close to where you click, plus shortest-path routing between points.

const FOOT = new Set(["path", "track", "footway", "bridleway", "steps", "pedestrian", "cycleway"]);
const STEP_M = 25; // densify trail geometry to roughly this spacing
export const CONNECTOR_MAX_M = 150; // unnamed links up to this long can join two named trails

// a foot trail the public may use (named or not)
function isPublic(t) {
  return FOOT.has(t.highway) && t.informal !== "yes" &&
    !["no", "private"].includes(t.access) && !["no", "private"].includes(t.foot);
}

export function usable(t) { return isPublic(t) && !!t.name; }

// "Fir Trail" and "Fir" are the same trail (matches norm() in trailroute.py)
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
  .filter((w) => w && !["trail", "tr", "the"].includes(w)).join(" ");

export function hav(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin((b[0] - a[0]) * r / 2) ** 2 +
    Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) {
    const a = this.a; a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

export class TrailGraph {
  constructor() {
    this.ll = new Map();     // node id -> [lat, lon]
    this.adj = new Map();    // node id -> [{to, names, d}]
    this.ways = new Map();   // way id -> {name, coords}
    this.parking = [];       // {name, lat, lon}
    this.nextId = 1e15;      // synthetic ids for densified points
  }

  addWay(id, name, nodeIds, coords) {
    if (this.ways.has(id) || nodeIds.length < 2) return false;
    this.ways.set(id, { name, coords });
    const names = name.split(";").map((s) => s.trim()).filter(Boolean);
    this.ll.set(nodeIds[0], coords[0]);
    for (let i = 1; i < nodeIds.length; i++) {
      const a = coords[i - 1], b = coords[i];
      this.ll.set(nodeIds[i], b);
      const d = hav(a, b), n = Math.max(1, Math.ceil(d / STEP_M));
      let last = nodeIds[i - 1];
      for (let k = 1; k < n; k++) {
        const f = k / n, id2 = this.nextId++;
        this.ll.set(id2, [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]);
        this._edge(last, id2, names, d / n);
        last = id2;
      }
      this._edge(last, nodeIds[i], names, d / n);
    }
    return true;
  }

  _edge(a, b, names, d) {
    if (!this.adj.has(a)) this.adj.set(a, []);
    if (!this.adj.has(b)) this.adj.set(b, []);
    this.adj.get(a).push({ to: b, names, d });
    this.adj.get(b).push({ to: a, names, d });
  }

  addParking(name, lat, lon) {
    if (this.parking.some((p) => hav([p.lat, p.lon], [lat, lon]) < 40)) return;
    this.parking.push({ name: name || "Parking", lat, lon });
  }

  loadCompact(data) {
    let added = 0;
    for (const w of data.ways) added += this.addWay(w.id, w.name, w.n, w.c) ? 1 : 0;
    for (const p of data.parking || []) this.addParking(p.name, p.lat, p.lon);
    return added;
  }

  // Named official trails, plus short unnamed connectors whose two ends are on
  // different named trails. Trailheads are often mapped that way: at Skeggs Point,
  // Fir Trail reaches Tafoni / El Corte de Madera Creek only through an unnamed bit
  // of track by the gate. (Same rule as routable_ways() in trailroute.py.)
  loadOverpass(json) {
    let added = 0;
    const unnamed = [], on = new Map();
    for (const e of json.elements || []) {
      if (e.type !== "way" || !e.geometry) continue;
      const t = e.tags || {};
      if (t.amenity === "parking") {
        if (["private", "no", "customers"].includes(t.access)) continue;
        const g = e.geometry;
        this.addParking(t.name, g.reduce((s, p) => s + p.lat, 0) / g.length,
          g.reduce((s, p) => s + p.lon, 0) / g.length);
      } else if (isPublic(t)) {
        if (!t.name) { unnamed.push(e); continue; }
        added += this.addWay(e.id, t.name, e.nodes, e.geometry.map((p) => [p.lat, p.lon])) ? 1 : 0;
        const names = t.name.split(";").map(norm);
        for (const n of e.nodes) {
          if (!on.has(n)) on.set(n, new Set());
          names.forEach((x) => on.get(n).add(x));
        }
      }
    }
    for (const e of unnamed) {
      const a = on.get(e.nodes[0]), b = on.get(e.nodes[e.nodes.length - 1]);
      const g = e.geometry.map((p) => [p.lat, p.lon]);
      let len = 0;
      for (let i = 1; i < g.length; i++) len += hav(g[i - 1], g[i]);
      if (a && b && ![...a].some((x) => b.has(x)) && len <= CONNECTOR_MAX_M) {
        added += this.addWay(e.id, "", e.nodes, g) ? 1 : 0;
      }
    }
    return added;
  }

  // nearest node to [lat, lon]; dist(a,b) lets the caller measure in screen pixels
  nearest(p, maxDist = Infinity, dist = hav) {
    let best = null, bd = maxDist;
    for (const [id, q] of this.ll) {
      if (!this.adj.has(id)) continue;
      const d = dist(p, q);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  // Dijkstra; returns {nodes:[ids], edges:[{names, d}]} or null
  shortest(s, t) {
    if (s === t) return { nodes: [s], edges: [] };
    const dist = new Map([[s, 0]]), prev = new Map(), heap = new Heap();
    heap.push(0, s);
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > dist.get(u)) continue;
      if (u === t) break;
      for (const e of this.adj.get(u) || []) {
        const nd = d + e.d;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd); prev.set(e.to, [u, e]); heap.push(nd, e.to);
        }
      }
    }
    if (!prev.has(t)) return null;
    const nodes = [t], edges = [];
    for (let v = t; v !== s;) {
      const [u, e] = prev.get(v);
      nodes.push(u); edges.push(e); v = u;
    }
    return { nodes: nodes.reverse(), edges: edges.reverse() };
  }
}

// Stitch per-waypoint segments into one route with trail-name legs.
export function buildRoute(graph, segments) {
  const pts = [], cum = [], legs = [];
  let total = 0, cur = null;
  for (const seg of segments) {
    if (!seg) continue;
    seg.nodes.forEach((id, i) => {
      if (pts.length && i === 0) return; // shared waypoint
      const p = graph.ll.get(id);
      if (pts.length) {
        const e = seg.edges[i - 1];
        total += e.d;
        // unnamed connector edges (no names) stay in whatever leg they're in
        const name = !e.names.length ? (cur ? cur.name : null)
          : cur && e.names.includes(cur.name) ? cur.name : e.names[0];
        if (cur && cur.name === null && name) cur.name = name; // route began on a connector
        else if (!cur || cur.name !== name) {
          cur = { name, m: 0, start: total - e.d, junction: pts[pts.length - 1] };
          legs.push(cur);
        }
        cur.m += e.d;
      }
      pts.push(p); cum.push(total);
    });
  }
  // fold away tiny legs (e.g. a few meters of a crossing trail) into neighbours
  for (let i = legs.length - 1; i >= 0 && legs.length > 1; i--) {
    if (legs[i].m < 15) {
      const into = legs[i - 1] || legs[i + 1];
      into.m += legs[i].m;
      if (into === legs[i + 1]) { into.start = legs[i].start; into.junction = legs[i].junction; }
      legs.splice(i, 1);
    }
  }
  for (let i = legs.length - 1; i > 0; i--) {
    if (legs[i].name === legs[i - 1].name) { legs[i - 1].m += legs[i].m; legs.splice(i, 1); }
  }
  for (const leg of legs) leg.name ??= "Connector";
  return { pts, cum, length: total, legs };
}

export function pointAt(route, d) {
  const { pts, cum } = route;
  if (!pts.length) return null;
  d = Math.max(0, Math.min(d, route.length));
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < d) lo = m + 1; else hi = m; }
  const i = Math.max(1, lo), seg = cum[i] - cum[i - 1];
  const f = seg ? (d - cum[i - 1]) / seg : 0, a = pts[i - 1], b = pts[i];
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
}
