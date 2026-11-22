// Stamp a route onto a GeoPDF map, entirely in the browser.
// JS port of trailroute.py: reads the page's /VP georeferencing, draws the route
// and a summary card into a Form XObject on its own optional-content layer, and
// appends everything as an incremental update (the original bytes are untouched).

const MI = 1609.344, FT = 0.3048;

// ---------------------------------------------------------------- bytes & zlib

const toBytes = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
const toStr = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return s; };
async function pipe(u8, stream) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer()); }
const inflate = (u8) => pipe(u8, new DecompressionStream("deflate"));
const deflate = (u8) => pipe(u8, new CompressionStream("deflate"));

// ---------------------------------------------------------------- reading

export async function readPdf(bytes) {
  const s = toStr(bytes), objs = new Map(), re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = +m[1], start = re.lastIndex, end = s.indexOf("endobj", start);
    if (end < 0) break;
    const region = s.slice(start, end), si = region.indexOf("stream");
    if (si !== -1 && region.slice(0, si).trimEnd().endsWith(">>")) {
      let k = start + si + 6;
      k += s.startsWith("\r\n", k) ? 2 : (s[k] === "\n" || s[k] === "\r") ? 1 : 0;
      const es = s.indexOf("endstream", k);
      objs.set(num, { head: region.slice(0, si).trim(), start: k, end: es });
      re.lastIndex = s.indexOf("endobj", es) + 6;
    } else {
      objs.set(num, { head: region.trim(), start: -1 });
      re.lastIndex = end + 6;
    }
  }
  const pdf = { bytes, s, objs };
  pdf.raw = (num) => {
    const o = objs.get(num);
    const lm = /\/Length\s+(\d+)(\s+0\s+R)?/.exec(o.head);
    let n = o.end - o.start;
    if (lm) n = lm[2] ? parseInt(objs.get(+lm[1]).head) : +lm[1];
    return bytes.subarray(o.start, o.start + n);
  };
  pdf.stream = async (num) => (/\/FlateDecode/.test(objs.get(num).head) ? inflate(pdf.raw(num)) : pdf.raw(num));
  for (const [num, o] of [...objs]) {
    if (o.start < 0 || !/\/ObjStm/.test(o.head)) continue;
    const st = toStr(await pdf.stream(num));
    const n = +/\/N\s+(\d+)/.exec(o.head)[1], first = +/\/First\s+(\d+)/.exec(o.head)[1];
    const nums = st.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const end = i + 1 < n ? nums[2 * i + 3] : st.length - first;
      if (!objs.has(nums[2 * i])) objs.set(nums[2 * i], { head: st.slice(first + nums[2 * i + 1], first + end).trim(), start: -1 });
    }
  }
  return pdf;
}

function trailer(pdf) {
  const s = pdf.s, prev = parseInt(s.slice(s.lastIndexOf("startxref") + 9).trim());
  const classic = s.startsWith("xref", prev);
  const at = classic ? s.indexOf("trailer", prev) : prev;
  const tail = s.slice(at, at + 4096);
  const get = (re) => { const m = re.exec(tail); return m ? m[1] : null; };
  return {
    prev, classic,
    root: get(/\/Root\s+(\d+\s+\d+\s+R)/), info: get(/\/Info\s+(\d+\s+\d+\s+R)/),
    id: get(/\/ID\s*(\[[^\]]*\])/), size: +(get(/\/Size\s+(\d+)/) || 0),
  };
}

// ---------------------------------------------------------------- georeferencing

function lcc(wkt) {
  const par = (n) => parseFloat(new RegExp(`PARAMETER\\["${n}",([-0-9.eE]+)\\]`).exec(wkt)[1]);
  const sph = /SPHEROID\["[^"]*",([0-9.]+),([0-9.]+)\]/.exec(wkt);
  const a = +sph[1], f = 1 / +sph[2], e = Math.sqrt(2 * f - f * f), r = Math.PI / 180;
  const p1 = par("Standard_Parallel_1") * r, p2 = par("Standard_Parallel_2") * r;
  const p0 = par("Latitude_Of_Origin") * r, l0 = par("Central_Meridian") * r;
  const mm = (p) => Math.cos(p) / Math.sqrt(1 - (e * Math.sin(p)) ** 2);
  const t = (p) => Math.tan(Math.PI / 4 - p / 2) / ((1 - e * Math.sin(p)) / (1 + e * Math.sin(p))) ** (e / 2);
  const n = (Math.log(mm(p1)) - Math.log(mm(p2))) / (Math.log(t(p1)) - Math.log(t(p2)));
  const F = mm(p1) / (n * t(p1) ** n), rho0 = a * F * t(p0) ** n;
  return (lat, lon) => {
    const rho = a * F * t(lat * r) ** n, th = n * (lon * r - l0);
    return [rho * Math.sin(th), rho0 - rho * Math.cos(th)];
  };
}

function solve3(A, b) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    [M[i], M[p]] = [M[p], M[i]];
    for (let k = 0; k < 3; k++) {
      if (k === i) continue;
      const f = M[k][i] / M[i][i];
      M[k] = M[k].map((x, j) => x - f * M[i][j]);
    }
  }
  return [0, 1, 2].map((i) => M[i][3] / M[i][i]);
}

export function georef(pdf) {
  const page = [...pdf.objs].find(([, o]) => /\/Type\s*\/Page(?![a-zA-Z])/.test(o.head));
  if (!page) throw new Error("No page found in this PDF.");
  const head = page[1].head;
  if (!/\/VP/.test(head) || !/\/GPTS/.test(head)) {
    throw new Error("This PDF isn't a GeoPDF (no georeferencing found). Midpen's preserve maps are GeoPDFs.");
  }
  const vp = head.slice(head.indexOf("/VP"));
  const nums = (k) => new RegExp(k + "\\s*\\[([^\\]]+)\\]").exec(vp)[1].trim().split(/\s+/).map(Number);
  const [bx0, by0, bx1, by1] = nums("/BBox"), g = nums("/GPTS"), l = nums("/LPTS");
  const mb = /\/MediaBox\s*\[([^\]]+)\]/.exec(head)[1].trim().split(/\s+/).map(Number);
  const wm = /\/WKT\s*\(([\s\S]*?)\)\s*>>/.exec(vp), wkt = wm ? wm[1] : "";
  let proj;
  if (/Lambert_Conformal_Conic/.test(wkt) && /Standard_Parallel_2/.test(wkt)) proj = lcc(wkt);
  else {
    const lat0 = (g.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / (g.length / 2)) * Math.PI / 180;
    proj = (la, lo) => [lo * Math.cos(lat0), la];
  }
  const AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Atx = [0, 0, 0], Aty = [0, 0, 0];
  for (let i = 0; i < g.length / 2; i++) {
    const [E, N] = proj(g[2 * i], g[2 * i + 1]), v = [E, N, 1];
    const x = bx0 + l[2 * i] * (bx1 - bx0), y = by0 + l[2 * i + 1] * (by1 - by0);
    for (let a = 0; a < 3; a++) {
      Atx[a] += v[a] * x; Aty[a] += v[a] * y;
      for (let b = 0; b < 3; b++) AtA[a][b] += v[a] * v[b];
    }
  }
  const ax = solve3(AtA, Atx), ay = solve3(AtA, Aty);
  return {
    pageNum: page[0], pageHead: head, mediabox: mb, frame: [bx0, by0, bx1, by1],
    xy(lat, lon) { const [E, N] = proj(lat, lon); return [ax[0] * E + ax[1] * N + ax[2], ay[0] * E + ay[1] * N + ay[2]]; },
  };
}

// ---------------------------------------------------------------- drawing

const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778,
  722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVB = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778,
  722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const EXTRA_W = { "–": 556, "·": 278, "−": 584, "©": 737 };

function textWidth(s, size, bold) {
  const t = bold ? HELVB : HELV;
  let w = 0;
  for (const c of s) { const k = c.charCodeAt(0); w += (k >= 32 && k < 127) ? t[k - 32] : (EXTRA_W[c] || 556); }
  return w * size / 1000;
}

function pdfText(s) {
  let out = "";
  for (const c of s) {
    let k = c.charCodeAt(0);
    if (c === "–" || c === "−") k = 0x96;
    else if (!(k >= 32 && k < 127) && !(k >= 160 && k < 256)) k = 63;
    const ch = String.fromCharCode(k);
    out += ch === "\\" || ch === "(" || ch === ")" ? "\\" + ch : ch;
  }
  return "(" + out + ")";
}

const rgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.replace("#", "").slice(i, i + 2), 16) / 255);
const f2 = (v) => (Math.round(v * 100) / 100).toString();
const WHITE = [1, 1, 1], INK = [0.13, 0.13, 0.13], MUTED = [0.38, 0.38, 0.38], RULE = [0.82, 0.82, 0.82];
const K = 0.5523;

class Canvas {
  constructor() { this.ops = []; this.gstates = new Map(); }
  o(s) { this.ops.push(s); }
  alpha(a) { const n = "A" + Math.round(a * 100); this.gstates.set(n, a); this.o(`/${n} gs`); }
  stroke(c) { this.o(`${c.map((v) => v.toFixed(3)).join(" ")} RG`); }
  fill(c) { this.o(`${c.map((v) => v.toFixed(3)).join(" ")} rg`); }
  poly(pts) { this.o(`${f2(pts[0][0])} ${f2(pts[0][1])} m`); for (const p of pts.slice(1)) this.o(`${f2(p[0])} ${f2(p[1])} l`); }
  circle(x, y, r) {
    const k = K * r, c = (...v) => this.o(v.map(f2).join(" ") + " c");
    this.o(`${f2(x + r)} ${f2(y)} m`);
    c(x + r, y + k, x + k, y + r, x, y + r); c(x - k, y + r, x - r, y + k, x - r, y);
    c(x - r, y - k, x - k, y - r, x, y - r); c(x + k, y - r, x + r, y - k, x + r, y);
  }
  rrect(x, y, w, h, r) {
    const k = K * r, c = (...v) => this.o(v.map(f2).join(" ") + " c"), l = (a, b) => this.o(`${f2(a)} ${f2(b)} l`);
    this.o(`${f2(x + r)} ${f2(y)} m`);
    l(x + w - r, y); c(x + w - r + k, y, x + w, y + r - k, x + w, y + r);
    l(x + w, y + h - r); c(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h);
    l(x + r, y + h); c(x + r - k, y + h, x, y + h - r + k, x, y + h - r);
    l(x, y + r); c(x, y + r - k, x + r - k, y, x + r, y);
    this.o("h");
  }
  text(x, y, s, size, color = INK, bold = false, align = "left") {
    const w = textWidth(s, size, bold);
    x -= { left: 0, center: w / 2, right: w }[align];
    this.fill(color);
    this.o(`BT /${bold ? "F2" : "F1"} ${f2(size)} Tf ${f2(x)} ${f2(y)} Td ${pdfText(s)} Tj ET`);
  }
}

function pointAt(route, d) {
  const { pts, cum } = route;
  d = Math.max(0, Math.min(d, route.length));
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < d) lo = m + 1; else hi = m; }
  const i = Math.max(1, lo), seg = cum[i] - cum[i - 1];
  const f = seg ? (d - cum[i - 1]) / seg : 0, a = pts[i - 1], b = pts[i];
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
}

function drawRoute(cv, geo, route, color) {
  const pts = route.pts.map((p) => geo.xy(...p));
  const [fx0, fy0, fx1, fy1] = geo.frame;
  cv.o(`q ${f2(fx0)} ${f2(fy0)} ${f2(fx1 - fx0)} ${f2(fy1 - fy0)} re W n 1 J 1 j`);
  cv.alpha(0.7); cv.stroke(WHITE); cv.o("7.5 w"); cv.poly(pts); cv.o("S");
  cv.alpha(0.9); cv.stroke(color); cv.o("3.8 w"); cv.poly(pts); cv.o("S");
  cv.alpha(1);
  const at = (d) => geo.xy(...pointAt(route, d));
  const miles = [];
  for (let m = 1; m * MI <= route.length; m++) miles.push(m * MI);
  cv.fill(WHITE);
  for (let d = 0.125 * MI; d < route.length - 120; d += 0.25 * MI) {
    if (miles.some((m) => Math.abs(d - m) <= 120)) continue;
    const [x0, y0] = at(d - 15), [x1, y1] = at(d + 15), [x, y] = at(d);
    const a = Math.atan2(y1 - y0, x1 - x0), c = Math.cos(a), s = Math.sin(a);
    cv.o(`q ${c.toFixed(4)} ${s.toFixed(4)} ${(-s).toFixed(4)} ${c.toFixed(4)} ${f2(x)} ${f2(y)} cm`);
    cv.o("-2.2 2.3 m 2.6 0 l -2.2 -2.3 l -1 0 l h f Q");
  }
  cv.o("1.4 w");
  for (const leg of route.legs.slice(1)) {
    const [x, y] = geo.xy(...leg.junction);
    cv.fill(WHITE); cv.stroke(color); cv.circle(x, y, 2.8); cv.o("B");
  }
  miles.forEach((m, i) => {
    const [x, y] = at(m);
    cv.fill(color); cv.stroke(WHITE); cv.o("1.2 w"); cv.circle(x, y, 6.6); cv.o("B");
    cv.text(x, y - 2.7, String(i + 1), 7.6, WHITE, true, "center");
  });
  const first = route.pts[0], last = route.pts[route.pts.length - 1];
  const loop = haversine(first, last) < 30;
  const ends = loop ? [[first, "S/F"]] : [[first, "S"], [last, "F"]];
  for (const [ll, label] of ends) {
    const [x, y] = geo.xy(...ll);
    cv.fill(INK); cv.stroke(WHITE); cv.o("1.6 w"); cv.circle(x, y, 9); cv.o("B");
    cv.text(x, y - 2.4, label, label.length > 1 ? 6.6 : 8.5, WHITE, true, "center");
  }
  cv.o("Q");
}

function haversine(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin((b[0] - a[0]) * r / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

const fmtInt = (v) => Math.round(v).toLocaleString("en-US");
const r10 = (v) => Math.round(v / 10) * 10;

function drawCard(cv, route, color, box) {
  const [x0, y0, x1, y1] = box, pad = 10, legs = route.legs, elev = route.elevFt;
  const rows = legs.length;
  const headH = 24, statsH = 33, footH = 13, gap = 6, profMin = 36, profMax = 90, profLbl = 20;
  const avail = y1 - y0;
  const fixed = headH + statsH + footH + gap + (elev ? profLbl + profMin : 0);
  const rowH = Math.max(9, Math.min(11.5, (avail - fixed) / Math.max(rows, 1)));
  const fs = Math.min(8.5, rowH * 0.8);
  const profH = elev ? Math.max(profMin, Math.min(profMax, avail - fixed + profMin - rows * rowH)) : 0;
  const h = headH + statsH + rows * rowH + gap + (elev ? profH + profLbl : 0) + footH;
  const top = y1, w = x1 - x0, bottom = top - h;
  cv.o("q");
  cv.alpha(0.96); cv.fill(WHITE); cv.stroke(RULE); cv.o("0.8 w"); cv.rrect(x0, bottom, w, h, 5); cv.o("B");
  cv.alpha(1); cv.fill(color); cv.rrect(x0, top - headH, w, headH, 5); cv.o("f");
  cv.o(`${f2(x0)} ${f2(top - headH)} ${f2(w)} 6 re f`);
  cv.text(x0 + pad, top - 16.5, "Planned route: " + route.name, 12, WHITE, true);

  const distMi = route.length / MI;
  let stats = `${distMi.toFixed(1)} mi`;
  if (elev) {
    const hrs = distMi / 2.5 + route.gainFt / 2000;
    stats += `  ·  +${fmtInt(r10(route.gainFt))} ft / −${fmtInt(r10(route.lossFt))} ft  ·  ~${(Math.round(hrs * 2) / 2).toFixed(1)} h`;
  }
  cv.text(x0 + pad, top - headH - 16, stats, 11, INK, true);
  const first = route.pts[0], last = route.pts[route.pts.length - 1];
  let sub = haversine(first, last) < 30 ? `Start & finish: ${route.startName}` : `Start: ${route.startName}   Finish: ${route.endName}`;
  if (elev) sub += "   ·   time at 2.5 mph + 1 h per 2,000 ft";
  cv.text(x0 + pad, top - headH - 28, sub, 7.5, MUTED);

  let cursor = top - headH - statsH;
  const cxDist = x1 - pad - 110, cxUp = x1 - pad;
  legs.forEach((leg, i) => {
    const y = cursor - rowH * (i + 1) + (rowH - fs) / 2 + 1;
    cv.text(x0 + pad, y, String(i + 1), fs, color, true);
    cv.text(x0 + pad + 13, y, leg.name, fs, INK);
    cv.text(cxDist, y, `${(leg.m / MI).toFixed(2)} mi`, fs, INK, false, "right");
    if (elev) {
      const U = r10(leg.upFt), D = r10(leg.downFt);
      cv.text(cxUp, y, `${U ? "+" + fmtInt(U) : "0"} / ${D ? "−" + fmtInt(D) : "0"} ft`, fs, MUTED, false, "right");
    }
  });
  cursor -= rows * rowH + gap;
  if (elev) {
    const px0 = x0 + pad + 30, px1 = x1 - pad, py1 = cursor - 9, py0 = py1 - profH, L = route.length;
    const lo = Math.floor(Math.min(...elev) / 100) * 100, hi = Math.ceil(Math.max(...elev) / 100) * 100;
    const X = (d) => px0 + (px1 - px0) * d / L, Y = (e) => py0 + (py1 - py0) * (e - lo) / ((hi - lo) || 1);
    const prof = route.elevD.map((d, i) => [X(d), Y(elev[i])]);
    cv.stroke(RULE); cv.o("0.5 w");
    for (const [v, dy] of [[lo, 1], [hi, -2.5]]) {
      cv.poly([[px0, Y(v)], [px1, Y(v)]]); cv.o("S");
      cv.text(px0 - 4, Y(v) + dy, `${fmtInt(v)} ft`, 6.5, MUTED, false, "right");
    }
    const breaks = legs.slice(1).map((l) => l.start);
    cv.o("[1 1.5] 0 d");
    for (const d of breaks) { cv.poly([[X(d), py0], [X(d), py1]]); cv.o("S"); }
    cv.o("[] 0 d");
    cv.alpha(0.22); cv.fill(color); cv.poly([[px0, py0], ...prof, [px1, py0]]); cv.o("f");
    cv.alpha(1); cv.stroke(color); cv.o("1.2 w 1 j"); cv.poly(prof); cv.o("S");
    const starts = [0, ...breaks], ends = [...breaks, L];
    starts.forEach((a, i) => {
      if (X(ends[i]) - X(a) > 8) cv.text((X(a) + X(ends[i])) / 2, py1 + 2.5, String(i + 1), 6, color, true, "center");
    });
    cv.text(px0 - 4, py0 - 8, "mi", 6.5, MUTED, false, "right");
    for (let m = 0; m * MI <= L; m++) cv.text(X(m * MI), py0 - 8, String(m), 6.5, MUTED, false, "center");
  }
  cv.text(x0 + pad, bottom + 5, "Trails © OpenStreetMap contributors (ODbL)  ·  elevation: AWS Terrain Tiles / USGS 3DEP  " +
    "·  distances approximate  ·  stay on designated trails", 5.6, MUTED);
  cv.o("Q");
}

// Where the summary card goes: the empty legend space on Midpen's 26x24" maps,
// otherwise the top-left corner of the map frame.
function cardBox(geo) {
  const [, , W, H] = geo.mediabox;
  if (Math.abs(W - 1872) < 1 && Math.abs(H - 1728) < 1) return [1458, 428, 1844, 690];
  const [fx0, , , fy1] = geo.frame;
  return [fx0 + 12, fy1 - 12 - 250, fx0 + 12 + 340, fy1 - 12];
}

// ---------------------------------------------------------------- writing

async function writeOverlay(pdf, geo, content, gstates, layerName) {
  const tr = trailer(pdf);
  const objNums = [...pdf.objs.keys()];
  const nxt = Math.max(tr.size, Math.max(...objNums) + 1);
  const [nOcg, nF1, nF2, nForm, nCont] = [0, 1, 2, 3, 4].map((i) => nxt + i);
  const chunks = [pdf.bytes];
  let len = pdf.bytes.length;
  const add = (u8) => { chunks.push(u8); len += u8.length; };
  if (pdf.bytes[len - 1] !== 10) add(toBytes("\n"));
  const offsets = new Map();
  const emit = (num, body) => { offsets.set(num, len); add(toBytes(`${num} 0 obj\n`)); add(typeof body === "string" ? toBytes(body) : body); add(toBytes("\nendobj\n")); };
  const emitStream = async (num, dict, data) => {
    const z = await deflate(toBytes(data));
    offsets.set(num, len);
    add(toBytes(`${num} 0 obj\n${dict.slice(0, -2)}/Filter /FlateDecode /Length ${z.length}>>\nstream\n`));
    add(z);
    add(toBytes("\nendstream\nendobj\n"));
  };

  emit(nOcg, `<</Type /OCG /Name ${pdfText(layerName)}>>`);
  emit(nF1, "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>");
  emit(nF2, "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding>>");
  const gs = [...gstates].map(([k, a]) => `/${k} <</Type /ExtGState /CA ${a.toFixed(2)} /ca ${a.toFixed(2)}>>`).join("");
  const [, , W, H] = geo.mediabox;
  await emitStream(nForm, `<</Type /XObject /Subtype /Form /BBox [0 0 ${W} ${H}] /OC ${nOcg} 0 R ` +
    `/Resources <</Font <</F1 ${nF1} 0 R /F2 ${nF2} 0 R>> /ExtGState <<${gs}>>>>>>`, content);
  await emitStream(nCont, "<<>>", "q /TrailRoute Do Q\n");

  // page: add our content stream and our XObject (resources copied inline)
  const ph = geo.pageHead;
  const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(ph);
  let res, inlineRes = null;
  if (resRef) res = pdf.objs.get(+resRef[1]).head;
  else {
    const i = ph.search(/\/Resources\s*<</), j0 = ph.indexOf("<<", i);
    let depth = 0, j = j0;
    for (; j < ph.length; j++) {
      if (ph.startsWith("<<", j)) { depth++; j++; } else if (ph.startsWith(">>", j)) { depth--; j++; if (!depth) break; }
    }
    res = inlineRes = ph.slice(j0, j + 1);
  }
  if (/\/XObject\s*<</.test(res)) res = res.replace(/\/XObject\s*<</, `/XObject << /TrailRoute ${nForm} 0 R `);
  else if (/\/XObject\s+\d+\s+0\s+R/.test(res)) {
    const inner = pdf.objs.get(+/\/XObject\s+(\d+)\s+0\s+R/.exec(res)[1]).head.trim().slice(2, -2);
    res = res.replace(/\/XObject\s+\d+\s+0\s+R/, `/XObject << /TrailRoute ${nForm} 0 R ${inner}>>`);
  } else res = `<< /XObject << /TrailRoute ${nForm} 0 R >> ` + res.trim().slice(2);
  const cm = /\/Contents\s+(\d+\s+0\s+R|\[[^\]]*\])/.exec(ph);
  const old = cm[1].startsWith("[") ? cm[1].slice(1, -1) : cm[1];
  let newPage = ph.slice(0, cm.index) + `/Contents [${old} ${nCont} 0 R]` + ph.slice(cm.index + cm[0].length);
  newPage = resRef ? newPage.replace(resRef[0], "/Resources " + res) : newPage.replace(inlineRes, res);
  emit(geo.pageNum, newPage);

  // catalog: declare the layer
  const rootNum = parseInt(tr.root);
  const ocgs = [nOcg, ...[...pdf.objs].filter(([, o]) => /\/Type\s*\/OCG\b/.test(o.head)).map(([n]) => n)];
  const refs = ocgs.map((n) => `${n} 0 R`).join(" ");
  const cat = pdf.objs.get(rootNum).head.replace(/\/OCProperties\s*<<(?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>)*>>/, "");
  emit(rootNum, `<</OCProperties <</OCGs [${refs}] /D <</Order [${refs}] /ON [${refs}]>>>> ` + cat.trim().slice(2));

  // cross-reference section for this update
  if (tr.classic) {
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    let x = "xref\n";
    for (let i = 0; i < nums.length;) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      x += `${nums[i]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) x += `${String(offsets.get(nums[k])).padStart(10, "0")} 00000 n \n`;
      i = j + 1;
    }
    const xoff = len;
    let t = `trailer\n<</Size ${nCont + 1} /Prev ${tr.prev} /Root ${tr.root}`;
    if (tr.info) t += ` /Info ${tr.info}`;
    if (tr.id) t += ` /ID ${tr.id}`;
    add(toBytes(x + t + `>>\nstartxref\n${xoff}\n%%EOF\n`));
  } else {
    const nX = nCont + 1;
    offsets.set(nX, len);
    const nums = [...offsets.keys()].sort((a, b) => a - b), index = [];
    for (let i = 0; i < nums.length;) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      index.push(nums[i], j - i + 1);
      i = j + 1;
    }
    const rows = new Uint8Array(nums.length * 7);
    nums.forEach((n, i) => {
      const o = offsets.get(n);
      rows.set([1, (o >>> 24) & 255, (o >>> 16) & 255, (o >>> 8) & 255, o & 255, 0, 0], i * 7);
    });
    let d = `<</Type /XRef /Size ${nX + 1} /W [1 4 2] /Index [${index.join(" ")}] /Prev ${tr.prev} /Root ${tr.root}`;
    if (tr.info) d += ` /Info ${tr.info}`;
    if (tr.id) d += ` /ID ${tr.id}`;
    d += ` /Length ${rows.length}>>`;
    const xoff = len;
    add(toBytes(`${nX} 0 obj\n${d}\nstream\n`)); add(rows); add(toBytes(`\nendstream\nendobj\nstartxref\n${xoff}\n%%EOF\n`));
  }
  const out = new Uint8Array(len);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

// ---------------------------------------------------------------- public

// route: {name, pts:[[lat,lon]], cum:[m], length, legs:[{name, m, start, junction, upFt, downFt}],
//         elevD, elevFt, gainFt, lossFt, startName, endName}
export async function stampPdf(bytes, route, { color = "#D81B7A", card = true } = {}) {
  const pdf = await readPdf(bytes);
  const geo = georef(pdf);
  const [fx0, fy0, fx1, fy1] = geo.frame;
  const inside = route.pts.filter((p) => { const [x, y] = geo.xy(...p); return x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1; });
  if (inside.length < route.pts.length * 0.5) throw new Error("This route isn't on this map. Pick the map for the park you're routing in.");
  const cv = new Canvas(), c = rgb(color);
  drawRoute(cv, geo, route, c);
  if (card) drawCard(cv, route, c, cardBox(geo));
  return writeOverlay(pdf, geo, cv.ops.join("\n") + "\n", cv.gstates, "Planned route: " + route.name);
}
