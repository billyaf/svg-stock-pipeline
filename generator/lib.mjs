// Shared SVG drawing helpers for stock asset generators.
export let DEFS = [];
let uid = 0;
export const id = p => `${p}${++uid}`;
let GCACHE = new Map(); // identical gradients are defined once per document
export const resetDefs = () => { DEFS = []; GCACHE = new Map(); };

export function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const r1 = n => Math.round(n * 10) / 10;

export function shade(hex, amt) { // amt -1..1 (neg = darker)
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const t = amt < 0 ? 0 : 255, p = Math.abs(amt);
  r = Math.round((t - r) * p + r); g = Math.round((t - g) * p + g); b = Math.round((t - b) * p + b);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

const stops = s => s.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('');
function gradient(tag, attrs, s) {
  const key = tag + attrs + stops(s);
  if (!GCACHE.has(key)) {
    const i = id(tag === 'linearGradient' ? 'lg' : 'rg');
    DEFS.push(`<${tag} id="${i}" ${attrs}>${stops(s)}</${tag}>`);
    GCACHE.set(key, `url(#${i})`);
  }
  return GCACHE.get(key);
}
export const lg = (s, x1 = 0, y1 = 0, x2 = 0, y2 = 1) => gradient('linearGradient', `x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"`, s);
export const rg = (s, cx = 0.5, cy = 0.5, r = 0.5) => gradient('radialGradient', `cx="${cx}" cy="${cy}" r="${r}"`, s);

// Everything is clipped to the artboard: stock reviewers reject vectors with objects hanging outside it.
export function svgDoc(w, h, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><clipPath id="artboard"><rect width="${w}" height="${h}"/></clipPath>${DEFS.join('')}</defs><g clip-path="url(#artboard)">${body}</g></svg>`;
}

// Repeat motif(x,y) on a periodic lattice covering the canvas -> seamless when W,H are multiples of t.
export function tile(W, H, t, bases, motif) {
  let out = '';
  for (let i = -1; i <= Math.ceil(W / t); i++)
    for (let j = -1; j <= Math.ceil(H / t); j++)
      for (const [bx, by, k] of bases) out += motif(bx + i * t, by + j * t, k);
  return out;
}

// ---------- motifs ----------
export function star8pts(cx, cy, R, rot = 0) {
  const p = [];
  for (let k = 0; k < 16; k++) {
    const a = rot + k * Math.PI / 8, rr = k % 2 ? R * 0.7654 : R;
    p.push(`${r1(cx + rr * Math.cos(a))},${r1(cy + rr * Math.sin(a))}`);
  }
  return p.join(' ');
}

export function sparkle(x, y, r, fill, op = 1) {
  return `<path d="M${r1(x)},${r1(y - r)} Q${r1(x)},${r1(y)} ${r1(x + r)},${r1(y)} Q${r1(x)},${r1(y)} ${r1(x)},${r1(y + r)} Q${r1(x)},${r1(y)} ${r1(x - r)},${r1(y)} Q${r1(x)},${r1(y)} ${r1(x)},${r1(y - r)}Z" fill="${fill}" opacity="${op}"/>`;
}

// ---------- colour + curves ----------
const f = p => `${r1(p[0])},${r1(p[1])}`;
const lerp = (a, b, t) => a + (b - a) * t;
export function mix(c1, c2, t) {
  const a = parseInt(c1.slice(1), 16), b = parseInt(c2.slice(1), 16);
  const ch = s => Math.round(lerp((a >> s) & 255, (b >> s) & 255, t));
  return '#' + ((1 << 24) + (ch(16) << 16) + (ch(8) << 8) + ch(0)).toString(16).slice(1);
}
export function smooth(pts, closed = false) {
  const n = pts.length, Q = i => closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
  let d = `M${f(pts[0])}`;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = Q(i - 1), p1 = Q(i), p2 = Q(i + 1), p3 = Q(i + 2);
    d += `C${f([p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6])} ${f([p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6])} ${f(p2)}`;
  }
  return d + (closed ? 'Z' : '');
}
