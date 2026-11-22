import { TrailGraph, buildRoute, pointAt, hav, CONNECTOR_MAX_M } from "./trails.js";
import { elevations, climb } from "./elevation.js";
import { stampPdf } from "./geopdf.js";

const MI = 1609.344, FT = 0.3048, COLOR = "#d81b7a";
const AREAS = [
  { id: "ecdm", title: "El Corte de Madera Creek (Midpen)", file: "data/ecdm.json" },
];
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const $ = (id) => document.getElementById(id);
const graph = new TrailGraph();
const segCache = new Map();
const state = { waypoints: [], route: null, name: "", startPlace: null, elev: null, elevPromise: null };
let areaBounds = null, elevToken = 0;

// ------------------------------------------------------------------ map

const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView([37.402, -122.312], 14);
L.control.zoom({ position: "topright" }).addTo(map);
const USGS = "https://basemap.nationalmap.gov/arcgis/rest/services/";
const bases = {
  "USGS Topo": L.tileLayer(USGS + "USGSTopo/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 18, maxNativeZoom: 16,
    attribution: 'Basemap: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS The National Map</a>',
  }),
  "OpenTopoMap": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 18, maxNativeZoom: 17,
    attribution: 'Map: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  }),
  "Satellite": L.tileLayer(USGS + "USGSImageryTopo/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 18, maxNativeZoom: 16, attribution: "Imagery: USGS The National Map",
  }),
};
bases["USGS Topo"].addTo(map);
L.control.layers(bases, null, { position: "topright" }).addTo(map);
map.attributionControl.setPrefix(false);
map.attributionControl.addAttribution('Trails &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors');

map.createPane("trails").style.zIndex = 410;
map.createPane("route").style.zIndex = 420;
// The route is drawn on its own canvas above the trails. A canvas takes every mouse
// event over the whole map, so let them through to the trails underneath; otherwise
// trail hover (highlight + name) stops working as soon as a route exists.
map.getPane("route").style.pointerEvents = "none";
const trailRenderer = L.canvas({ pane: "trails", tolerance: 7 });
const routeRenderer = L.canvas({ pane: "route" });
const trailLayer = L.layerGroup().addTo(map);
const parkingLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const markLayer = L.layerGroup().addTo(map);
const hoverDot = L.circleMarker([0, 0], { renderer: routeRenderer, radius: 6, color: "#fff", weight: 2.5, fillColor: COLOR, fillOpacity: 1, interactive: false });
const drawnWays = new Set(), drawnParking = new Set();

function drawData() {
  for (const [id, w] of graph.ways) {
    if (drawnWays.has(id)) continue;
    drawnWays.add(id);
    const line = L.polyline(w.coords, { renderer: trailRenderer, color: "#3b2a1a", weight: 2.4, opacity: 0.72, interactive: !!w.name });
    if (!w.name) { trailLayer.addLayer(line); continue; } // short unnamed connector between trails
    line.bindTooltip(w.name, { sticky: true, direction: "top", offset: [0, -8], className: "trail-tip" });
    line.on("mouseover", () => line.setStyle({ weight: 5, opacity: 0.95 }));
    line.on("mouseout", () => line.setStyle({ weight: 2.4, opacity: 0.72 }));
    trailLayer.addLayer(line);
  }
  graph.parking.forEach((p, i) => {
    if (drawnParking.has(i)) return;
    drawnParking.add(i);
    const m = L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: "pk", html: "P", iconSize: [20, 20] }), keyboard: false, riseOnHover: true,
    });
    m.bindTooltip(p.name === "Parking" ? "Parking" : `${p.name} (parking)`, { direction: "top", offset: [0, -10] });
    m.on("click", (e) => { L.DomEvent.stop(e); addWaypoint([p.lat, p.lon], { place: p.name, meters: 400 }); });
    parkingLayer.addLayer(m);
  });
}

// ------------------------------------------------------------------ data loading

async function loadArea(area) {
  const res = await fetch(area.file);
  if (!res.ok) throw new Error("couldn't load " + area.file);
  const data = await res.json();
  graph.loadCompact(data);
  areaBounds = L.latLngBounds([data.bounds.slice(0, 2), data.bounds.slice(2, 4)]);
  segCache.clear();
  drawData();
}

async function loadOverpass(bounds) {
  const bb = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()].map((v) => v.toFixed(5)).join(",");
  const hw = `["highway"~"^(path|track|footway|bridleway|steps|pedestrian|cycleway)$"]`;
  const q = `[out:json][timeout:60];(way${hw}["name"](${bb});` +
    `way${hw}[!"name"](if:length()<=${CONNECTOR_MAX_M})(${bb});` + // candidate connectors
    `way["amenity"="parking"](${bb}););out body geom;`;
  let json = null, why = "";
  for (const url of OVERPASS) {  // main server first, then a mirror
    try {
      const res = await fetch(url, {
        method: "POST", body: "data=" + encodeURIComponent(q), signal: AbortSignal.timeout(30000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      if (res.ok) { json = await res.json(); break; }
      why = res.status === 429 ? "OpenStreetMap is busy" : "server said " + res.status;
    } catch (err) { why = err.name === "TimeoutError" ? "timed out" : err.message; }
  }
  if (!json) throw new Error(`trail download failed (${why}). Try again in a minute`);
  const n = graph.loadOverpass(json);
  segCache.clear();
  drawData();
  return n;
}

$("load-view").addEventListener("click", async () => {
  if (map.getZoom() < 12) return toast("Zoom in a bit more first (to a single park or two).");
  const btn = $("load-view");
  btn.disabled = true; btn.textContent = "Loading trails…";
  try {
    const n = await loadOverpass(map.getBounds());
    toast(n ? `Loaded ${n} trail segments.` : "No new named trails in this view.");
  } catch (err) { toast("Couldn't load trails: " + err.message); }
  btn.disabled = false; btn.textContent = "Load trails in this view";
});

// ------------------------------------------------------------------ building the route

function screenNearest(latlng, px) {
  const c = map.latLngToContainerPoint(latlng);
  return graph.nearest([latlng.lat, latlng.lng], px, (_, q) => map.latLngToContainerPoint(q).distanceTo(c));
}

function segment(a, b) {
  const key = a + ">" + b;
  if (!segCache.has(key)) segCache.set(key, graph.shortest(a, b));
  return segCache.get(key);
}

function addWaypoint(p, { place = null, meters = null, node = null } = {}) {
  const id = node ?? (meters ? graph.nearest(p, meters) : screenNearest(L.latLng(p), 40));
  if (id == null) return toast(meters ? "No mapped trail near that spot." : "Click on or near a trail (the dark lines).");
  const wps = state.waypoints;
  if (wps.length && wps[wps.length - 1] === id) return;
  if (wps.length && !segment(wps[wps.length - 1], id)) return toast("That trail isn't connected to your route by official trails.");
  if (!wps.length) state.startPlace = place;
  wps.push(id);
  update();
}

map.on("click", (e) => addWaypoint([e.latlng.lat, e.latlng.lng]));

$("undo").onclick = () => { state.waypoints.pop(); if (!state.waypoints.length) state.startPlace = null; update(); };
$("clear").onclick = () => { state.waypoints = []; state.startPlace = null; update(); };
$("reverse").onclick = () => { state.waypoints.reverse(); state.startPlace = null; update(); };
$("loop").onclick = () => {
  const w = state.waypoints;
  if (w.length >= 2 && w[w.length - 1] !== w[0]) { w.push(w[0]); update(); }
};
$("name").addEventListener("input", (e) => { state.name = e.target.value.trim(); writeHash(); });

function update() {
  const w = state.waypoints;
  state.route = w.length >= 2 ? buildRoute(graph, w.slice(1).map((id, i) => segment(w[i], id))) : null;
  state.elev = null;
  render();
  writeHash();
  state.elevPromise = state.route ? loadElevation() : null;
}

// ------------------------------------------------------------------ drawing

function bearing(a, b) {
  const dy = b[0] - a[0], dx = (b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180);
  return Math.atan2(dx, dy) * 180 / Math.PI;
}

function render() {
  routeLayer.clearLayers();
  markLayer.clearLayers();
  const r = state.route, w = state.waypoints;
  if (r) {
    L.polyline(r.pts, { renderer: routeRenderer, color: "#fff", weight: 9, opacity: 0.75, interactive: false, lineJoin: "round" }).addTo(routeLayer);
    L.polyline(r.pts, { renderer: routeRenderer, color: COLOR, weight: 5, opacity: 0.95, interactive: false, lineJoin: "round" }).addTo(routeLayer);
    const miles = [];
    for (let m = 1; m * MI <= r.length; m++) miles.push(m * MI);
    for (let d = 0.125 * MI; d < r.length - 100; d += 0.25 * MI) {
      if (miles.some((m) => Math.abs(m - d) < 120)) continue;
      const a = bearing(pointAt(r, d - 15), pointAt(r, d + 15));
      L.marker(pointAt(r, d), {
        interactive: false, keyboard: false,
        icon: L.divIcon({
          className: "arrow", iconSize: [13, 13],
          html: `<svg viewBox="0 0 12 12" style="transform:rotate(${a.toFixed(0)}deg)"><circle cx="6" cy="6" r="5.1"/><path d="M6 2.6 8.7 7.9 6 6.6 3.3 7.9z"/></svg>`,
        }),
      }).addTo(markLayer);
    }
    miles.forEach((m, i) => L.marker(pointAt(r, m), {
      interactive: false, keyboard: false, icon: L.divIcon({ className: "mile", iconSize: [20, 20], html: String(i + 1) }),
    }).addTo(markLayer));
  }
  const loop = w.length > 2 && w[0] === w[w.length - 1];
  w.forEach((id, i) => {
    if (loop && i === w.length - 1) return;
    const first = i === 0, last = i === w.length - 1 && w.length > 1;
    const label = first ? (loop ? "S/F" : "S") : last ? "F" : "";
    const m = L.marker(graph.ll.get(id), {
      draggable: true, keyboard: false, zIndexOffset: 1000,
      icon: L.divIcon({ className: "wp" + (label ? " end" : ""), html: label, iconSize: label ? [24, 24] : [14, 14] }),
    });
    m.bindTooltip(w.length > 1 ? "Drag to move · click to remove" : "Start · click a trail to continue", { direction: "top", offset: [0, -12] });
    m.on("click", (e) => {
      L.DomEvent.stop(e);
      if (loop && first) w.pop();
      w.splice(i, 1);
      if (i === 0) state.startPlace = null;
      update();
    });
    m.on("dragend", () => {
      const id2 = screenNearest(m.getLatLng(), 60);
      if (id2 == null) { toast("Drop points on a trail."); return update(); }
      w[i] = id2;
      if (loop && first) w[w.length - 1] = id2;
      if (i === 0) state.startPlace = null;
      update();
    });
    m.addTo(markLayer);
  });
  renderPanel();
}

// ------------------------------------------------------------------ panel

const fmtMi = (m) => (m / MI).toFixed(m < 10 * MI ? 2 : 1);
const fmtFt = (m) => Math.round(m / FT / 10) * 10;
const upDown = (u, d) => {
  const U = Math.round(u / 10) * 10, D = Math.round(d / 10) * 10;
  return `${U ? "+" + U.toLocaleString() : "0"} / ${D ? "−" + D.toLocaleString() : "0"} ft`;
};

function renderPanel() {
  const r = state.route, has = state.waypoints.length > 0;
  $("empty").hidden = has;
  $("summary").hidden = !has;
  $("export").hidden = !r;
  $("s-dist").textContent = r ? (r.length / MI).toFixed(1) : "0.0";
  const e = state.elev;
  $("s-up").textContent = e ? fmtFt(e.up).toLocaleString() : (r ? "…" : "–");
  $("s-time").textContent = e && r ? (Math.round((r.length / MI / 2.5 + e.up / FT / 2000) * 2) / 2).toFixed(1) : "–";
  const legs = $("legs");
  legs.innerHTML = "";
  for (const leg of r ? r.legs : []) {
    const li = document.createElement("li");
    const climbTxt = leg.upFt != null ? `<span class="climb">${upDown(leg.upFt, leg.downFt)}</span>` : "";
    li.innerHTML = `<span class="tn"></span><span class="d">${fmtMi(leg.m)} mi</span>${climbTxt}`;
    li.querySelector(".tn").textContent = leg.name;
    li.addEventListener("mouseenter", () => showAt(leg.start + leg.m / 2));
    li.addEventListener("mouseleave", hideAt);
    legs.appendChild(li);
  }
  renderProfile();
  $("loop").disabled = state.waypoints.length < 2;
}

function renderProfile() {
  const fig = $("profile"), r = state.route, e = state.elev;
  if (!r) { fig.innerHTML = ""; return; }
  if (!e) { fig.innerHTML = `<div class="loading">${e === false ? "Elevation unavailable" : "Getting elevation…"}</div>`; return; }
  const W = 340, H = 128, l = 40, rt = 8, t = 14, b = 18, L = r.length;
  const ft = e.el.map((v) => v / FT);
  const lo = Math.floor(Math.min(...ft) / 100) * 100, hi = Math.ceil(Math.max(...ft) / 100) * 100 || lo + 100;
  const X = (d) => l + (W - l - rt) * d / L, Y = (v) => H - b - (H - t - b) * (v - lo) / ((hi - lo) || 1);
  const line = e.d.map((d, i) => `${X(d).toFixed(1)},${Y(ft[i]).toFixed(1)}`).join(" ");
  const step = L > 6 * MI ? MI : L > 2 * MI ? MI / 2 : MI / 4;
  let ticks = "";
  for (let d = 0; d <= L + 1; d += step) ticks += `<text x="${X(d).toFixed(1)}" y="${H - 4}" class="ax" text-anchor="middle">${+(d / MI).toFixed(2)}</text>`;
  const breaks = r.legs.slice(1).map((leg) => `<line x1="${X(leg.start)}" x2="${X(leg.start)}" y1="${t}" y2="${H - b}" class="brk"/>`).join("");
  const nums = r.legs.map((leg, i) => (X(leg.start + leg.m) - X(leg.start) > 10
    ? `<text x="${X(leg.start + leg.m / 2).toFixed(1)}" y="${t - 4}" class="ln" text-anchor="middle">${i + 1}</text>` : "")).join("");
  fig.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Elevation profile">
    <line x1="${l}" x2="${W - rt}" y1="${Y(hi)}" y2="${Y(hi)}" class="grid"/><line x1="${l}" x2="${W - rt}" y1="${Y(lo)}" y2="${Y(lo)}" class="grid"/>
    <text x="${l - 5}" y="${Y(hi) + 3}" class="ax" text-anchor="end">${hi.toLocaleString()}</text>
    <text x="${l - 5}" y="${Y(lo) + 3}" class="ax" text-anchor="end">${lo.toLocaleString()}</text>
    <text x="${l - 5}" y="${H - 4}" class="ax" text-anchor="end">mi</text>
    ${breaks}<polygon points="${X(0)},${H - b} ${line} ${X(L)},${H - b}" class="area"/><polyline points="${line}" class="pl"/>
    ${ticks}${nums}<line id="cur" class="cur" y1="${t}" y2="${H - b}" x1="-10" x2="-10"/>
    <rect x="${l}" y="0" width="${W - l - rt}" height="${H}" fill="transparent" id="hit"/></svg>
    <figcaption id="readout">Elevation (ft). Hover to find a spot on the map.</figcaption>`;
  const svg = fig.querySelector("svg"), hit = fig.querySelector("#hit");
  const move = (ev) => {
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const x = pt.matrixTransform(svg.getScreenCTM().inverse()).x;
    const d = Math.max(0, Math.min(L, (x - l) / (W - l - rt) * L));
    showAt(d);
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", hideAt);
}

function showAt(d) {
  const r = state.route, e = state.elev;
  if (!r) return;
  hoverDot.setLatLng(pointAt(r, d)).addTo(map);
  const cur = document.getElementById("cur");
  if (cur && e) {
    const W = 340, l = 40, rt = 8, x = l + (W - l - rt) * d / r.length;
    cur.setAttribute("x1", x); cur.setAttribute("x2", x);
    const i = Math.min(e.d.length - 1, Math.round(d / r.length * (e.d.length - 1)));
    $("readout").textContent = `Mile ${(d / MI).toFixed(2)} · ${Math.round(e.el[i] / FT).toLocaleString()} ft`;
  }
}
function hideAt() {
  hoverDot.remove();
  const cur = document.getElementById("cur");
  if (cur) { cur.setAttribute("x1", -10); cur.setAttribute("x2", -10); }
}

// ------------------------------------------------------------------ elevation

async function loadElevation() {
  const r = state.route, token = ++elevToken;
  const n = Math.min(1500, Math.max(2, Math.round(r.length / 30)));
  const d = Array.from({ length: n + 1 }, (_, i) => r.length * i / n);
  try {
    const el = await elevations(d.map((x) => pointAt(r, x)));
    if (token !== elevToken) return;
    const [up, down] = climb(el);
    for (const leg of r.legs) {
      const seg = el.filter((_, i) => d[i] >= leg.start - 1 && d[i] <= leg.start + leg.m + 1);
      const [u, dn] = seg.length > 1 ? climb(seg) : [0, 0];
      leg.upFt = u / FT; leg.downFt = dn / FT;
    }
    state.elev = { d, el, up, down };
  } catch (err) {
    if (token !== elevToken) return;
    console.warn(err);
    state.elev = false;
  }
  renderPanel();
}

// ------------------------------------------------------------------ naming + exports

function placeNear(p) {
  let best = null, bd = 250;
  for (const q of graph.parking) {
    const d = hav(p, [q.lat, q.lon]);
    if (d < bd && q.name !== "Parking") { bd = d; best = q.name; }
  }
  return best;
}

function routeName() { return state.name || "My route"; }

function pdfRoute() {
  const r = state.route, e = state.elev, first = r.pts[0], last = r.pts[r.pts.length - 1];
  const startName = state.startPlace && state.startPlace !== "Parking" ? state.startPlace : placeNear(first) || r.legs[0].name;
  const endName = hav(first, last) < 30 ? startName : placeNear(last) || r.legs[r.legs.length - 1].name;
  const out = { name: routeName(), pts: r.pts, cum: r.cum, length: r.length, legs: r.legs, startName, endName };
  if (e) Object.assign(out, { elevD: e.d, elevFt: e.el.map((v) => v / FT), gainFt: e.up / FT, lossFt: e.down / FT });
  return out;
}

const slug = (s) => s.replace(/[^\w\- ]+/g, "").trim() || "route";

function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

$("gpx").onclick = () => {
  const r = state.route;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const pts = r.pts.map(([la, lo]) => `<trkpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}"/>`).join("\n");
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="trailroute" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `<trk><name>${esc(routeName())}</name><trkseg>\n${pts}\n</trkseg></trk></gpx>\n`;
  download(new Blob([gpx], { type: "application/gpx+xml" }), slug(routeName()) + ".gpx");
};

$("share").onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); toast("Link copied. It opens this exact route."); }
  catch { prompt("Copy this link:", location.href); }
};

$("pdf").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file || !state.route) return;
  const label = $("pdf-label");
  label.classList.add("busy");
  try {
    if (state.elevPromise) await state.elevPromise;
    const out = await stampPdf(new Uint8Array(await file.arrayBuffer()), pdfRoute(), { color: COLOR, card: $("card").checked });
    download(new Blob([out], { type: "application/pdf" }), `${file.name.replace(/\.pdf$/i, "")} - ${slug(routeName())}.pdf`);
    toast("Done. The route is on its own layer in the PDF.");
  } catch (err) {
    console.error(err);
    toast(err.message || "Couldn't stamp that PDF.");
  }
  label.classList.remove("busy");
});

// ------------------------------------------------------------------ share links

function writeHash() {
  const w = state.waypoints;
  if (!w.length) { history.replaceState(null, "", location.pathname + location.search); return; }
  const p = new URLSearchParams();
  if (state.name) p.set("n", state.name);
  if (state.startPlace) p.set("s", state.startPlace);
  p.set("w", w.map((id) => graph.ll.get(id).map((v) => v.toFixed(5)).join(",")).join(";"));
  history.replaceState(null, "", "#" + p.toString());
}

async function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const w = (p.get("w") || "").split(";").filter(Boolean).map((s) => s.split(",").map(Number));
  if (!w.length || w.some((q) => q.length !== 2 || q.some(isNaN))) return false;
  const bounds = L.latLngBounds(w);
  if (!areaBounds || !areaBounds.pad(0.05).contains(bounds)) {
    try { await loadOverpass(bounds.pad(0.25)); } catch (err) { toast("Couldn't load trails for this link: " + err.message); }
  }
  state.name = p.get("n") || "";
  $("name").value = state.name;
  for (const q of w) {
    const id = graph.nearest(q, 60);
    if (id != null && state.waypoints[state.waypoints.length - 1] !== id) state.waypoints.push(id);
  }
  state.startPlace = p.get("s");
  update();
  if (state.route) map.fitBounds(L.latLngBounds(state.route.pts), fitPad());
  return true;
}

// ------------------------------------------------------------------ misc

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3800);
}

// keep fitted content clear of the side panel (desktop) or bottom sheet (phones)
function fitPad() {
  if (window.innerWidth > 760) return { paddingTopLeft: [400, 30], paddingBottomRight: [30, 30] };
  return { paddingTopLeft: [20, 20], paddingBottomRight: [20, $("panel").offsetHeight + 20] };
}

async function start() {
  const sel = $("area");
  for (const a of AREAS) sel.add(new Option(a.title, a.id));
  sel.add(new Option("Somewhere else: use “Load trails in this view”", ""));
  sel.addEventListener("change", async () => {
    const a = AREAS.find((x) => x.id === sel.value);
    if (!a) return toast("Pan and zoom to a park, then press “Load trails in this view”.");
    await loadArea(a);
    map.fitBounds(areaBounds, fitPad());
  });
  try { await loadArea(AREAS[0]); } catch (err) { toast(err.message); }
  const fromLink = await readHash();
  if (!fromLink && areaBounds) map.fitBounds(areaBounds, fitPad());
  render();
  window.trailroute = { map, graph, state, addWaypoint, stampPdf, pdfRoute, ready: true };
}

start();
