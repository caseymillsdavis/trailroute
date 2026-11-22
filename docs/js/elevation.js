// Elevation from AWS Terrain Tiles (Terrarium encoding; USGS 3DEP in the US).
// Tiles are fetched once and decoded through a canvas.

const URL_T = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const Z = 15;
const tiles = new Map();

function loadTile(x, y) {
  const key = `${x}/${y}`;
  if (!tiles.has(key)) {
    tiles.set(key, new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = 256;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        resolve(g.getImageData(0, 0, 256, 256).data);
      };
      img.onerror = () => { tiles.delete(key); reject(new Error("elevation tile failed: " + key)); };
      img.src = URL_T.replace("{z}", Z).replace("{x}", x).replace("{y}", y);
    }));
  }
  return tiles.get(key);
}

function pixel(lat, lon) {
  const n = 256 * 2 ** Z, r = lat * Math.PI / 180;
  return [(lon + 180) / 360 * n, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n];
}

// points: [[lat, lon]] -> meters (bilinear)
export async function elevations(points) {
  const px = points.map(([la, lo]) => pixel(la, lo));
  const need = new Set();
  for (const [x, y] of px) {
    for (const dx of [0, 1]) for (const dy of [0, 1]) {
      need.add(`${Math.floor((x - 0.5 + dx) / 256)}/${Math.floor((y - 0.5 + dy) / 256)}`);
    }
  }
  const data = new Map();
  await Promise.all([...need].map(async (k) => {
    const [x, y] = k.split("/").map(Number);
    data.set(k, await loadTile(x, y));
  }));
  const at = (X, Y) => {
    const t = data.get(`${Math.floor(X / 256)}/${Math.floor(Y / 256)}`);
    const i = ((Y % 256) * 256 + (X % 256)) * 4;
    return t[i] * 256 + t[i + 1] + t[i + 2] / 256 - 32768;
  };
  return px.map(([x, y]) => {
    const X = x - 0.5, Y = y - 0.5, x0 = Math.floor(X), y0 = Math.floor(Y), fx = X - x0, fy = Y - y0;
    return at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) +
      at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
  });
}

// total ascent / descent in meters, ignoring wiggles smaller than thr
export function climb(el, thr = 3) {
  let up = 0, down = 0, ref = el[0];
  for (const e of el.slice(1)) {
    if (e - ref >= thr) { up += e - ref; ref = e; }
    else if (ref - e >= thr) { down += ref - e; ref = e; }
  }
  return [up, down];
}
