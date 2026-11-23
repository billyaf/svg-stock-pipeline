// Shared toolkit for per-theme campaign scripts (generator/themes/*.mjs).
// Every theme script decides its OWN asset mix — there is no common template.
export * from './lib.mjs';
import { campaign, kw } from './campaign.mjs';
import { rng, r1, tile, shade, resetDefs, smooth, mix } from './lib.mjs';
export { kw };

export const TAU = Math.PI * 2;
export const P2 = p => `${r1(p[0])},${r1(p[1])}`;
export const G = (x, y, s, inner, rot = 0) => `<g transform="translate(${r1(x)},${r1(y)}) rotate(${r1(rot)}) scale(${r1(s * 1000) / 1000})">${inner}</g>`;
export const rect = (W, H, fill) => `<rect width="${W}" height="${H}" fill="${fill}"/>`;
export const fmtKw = (W, H) => W === H ? 'square, social media post' : (H > W ? 'vertical, portrait, story' : 'horizontal, wide, banner');

// Runner: theme scripts return a list of assets; numbering + metadata + checks happen here.
export function run(outDir, theme, assets) {
  const C = campaign(outDir);
  assets.forEach((fn, i) => {
    resetDefs();
    const a = typeof fn === 'function' ? fn() : fn;
    const code = `${String(i + 1).padStart(2, '0')}-${a.slug}`;
    C.save(code, a.W, a.H, a.svg, {
      title: a.title,
      keywords: kw(theme.lead, a.kw, theme.base, a.W && fmtKw(a.W, a.H), a.color || '', 'vector, illustration, design'),
      category: 8,
    });
  });
  C.finish();
}

// Grid sheet of isolated elements ("set of ... icons / elements") on a plain background.
export function sheet(W, H, cols, rows, draw, { bg = '#FFFFFF', pad = 0.08, jitter = 0 } = {}) {
  const r = rng(W + cols * 7 + rows), cw = W * (1 - 2 * pad) / cols, ch = H * (1 - 2 * pad) / rows;
  let s = rect(W, H, bg), k = 0;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++, k++) {
    const x = W * pad + cw * (i + 0.5) + (r() - 0.5) * cw * jitter, y = H * pad + ch * (j + 0.5) + (r() - 0.5) * ch * jitter;
    s += draw(x, y, Math.min(cw, ch) * 0.36, k);
  }
  return s;
}

// Seamless pattern: random scatter inside one tile, repeated with tile() so every edge matches.
export function scatterTile(W, H, t, n, seed, draw, minD = 0) {
  const r = rng(seed), pts = [];
  let guard = 0;
  while (pts.length < n && guard++ < n * 60) {
    const p = [r() * t, r() * t];
    if (minD && pts.some(q => { const dx = Math.min(Math.abs(p[0] - q[0]), t - Math.abs(p[0] - q[0])), dy = Math.min(Math.abs(p[1] - q[1]), t - Math.abs(p[1] - q[1])); return Math.hypot(dx, dy) < minD; })) continue;
    pts.push(p);
  }
  return tile(W, H, t, pts.map((p, k) => [p[0], p[1], k]), (x, y, k) => draw(x, y, k, rng(seed * 31 + k)));
}

// Bumpy cloud bank (filled to the bottom), for paper-cut scenes.
export function cloudBank(W, y, R, color, seed, H, flip = false) {
  const r = rng(seed); let d = `M${-R},${H + R}`, x = -R;
  const pts = [];
  while (x < W + R) { const rr = R * (0.6 + r() * 0.6); pts.push([x + rr, y - r() * R * 0.5, rr]); x += rr * 1.5; }
  d += ` L${-R},${r1(y)}`;
  for (const [cx, cy, rr] of pts) d += ` A${r1(rr)},${r1(rr)} 0 0 1 ${r1(cx + rr)},${r1(cy)}`;
  d += ` L${W + R * 2},${r1(y)} L${W + R * 2},${H + R}Z`;
  return `<path d="${d}" fill="${color}"${flip ? ` transform="translate(0,${H}) scale(1,-1)"` : ''}/>`;
}

// Paper-cut stack: draws shapes back-to-front with a soft drop shadow under each.
export const paper = (d, fill, m, o = 0.16) => `<path d="${d}" fill="#000" opacity="${o}" transform="translate(0,${r1(m * 0.008)})"/><path d="${d}" fill="${fill}"/>`;

// Smooth layered hills along the bottom.
export function hills(W, H, y, amp, freq, phase, extra = 0) {
  const pts = []; for (let k = 0; k <= 30; k++) { const x = -0.05 * W + k / 30 * 1.1 * W; pts.push([x, y + amp * Math.sin(freq * TAU * x / W + phase) + extra * Math.sin(3.1 * TAU * x / W + phase * 2)]); }
  return smooth(pts) + ` L${W * 1.06},${H + 50} L${-W * 0.06},${H + 50}Z`;
}

// Flowing two-tone ribbon along a centerline.
export function ribbon(pts, w, cTop, cBot, { twist = 2, shadeAmt = 0.18, edge = null } = {}) {
  const c = []; const N = 120;
  // resample the smooth curve: Catmull-Rom on given points
  const P = i => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let s = 0; s < pts.length - 1; s++) for (let q = 0; q < N / (pts.length - 1); q++) {
    const t = q / (N / (pts.length - 1)), p0 = P(s - 1), p1 = P(s), p2 = P(s + 1), p3 = P(s + 2);
    const f = (a, b, cc, d) => 0.5 * ((2 * b) + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t * t + (-a + 3 * b - 3 * cc + d) * t * t * t);
    c.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
  }
  c.push(pts[pts.length - 1]);
  const top = [], mid = [], bot = [], wd = [];
  c.forEach((p, i) => {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L, ny = dx / L, k = i / (c.length - 1), ww = w * (0.35 + 0.65 * Math.abs(Math.cos(k * Math.PI * twist + 0.6)));
    wd.push(ww); top.push([p[0] + nx * ww / 2, p[1] + ny * ww / 2]); mid.push(p); bot.push([p[0] - nx * ww / 2, p[1] - ny * ww / 2]);
  });
  const poly = (A, B) => `M${A.map(P2).join(' L')} L${B.slice().reverse().map(P2).join(' L')}Z`;
  // shading: darker where the ribbon is narrow (it is turning away)
  const g1 = shade(cTop, -shadeAmt), g2 = shade(cBot, -shadeAmt * 0.6);
  let s = `<path d="${poly(top, mid)}" fill="${cTop}"/><path d="${poly(mid, bot)}" fill="${cBot}"/>`;
  for (let i = 0; i < c.length - 1; i += 2) {
    const o = 1 - wd[i] / w; if (o < 0.3) continue;
    const seg = j => [top[j], mid[j], bot[j]];
    const A = seg(i), B = seg(Math.min(i + 2, c.length - 1));
    s += `<path d="M${P2(A[0])} L${P2(B[0])} L${P2(B[1])} L${P2(A[1])}Z" fill="${g1}" opacity="${r1(o * 0.7 * 10) / 10}"/>`;
    s += `<path d="M${P2(A[1])} L${P2(B[1])} L${P2(B[2])} L${P2(A[2])}Z" fill="${g2}" opacity="${r1(o * 0.7 * 10) / 10}"/>`;
  }
  if (edge) s += `<path d="M${bot.map(P2).join(' L')}" fill="none" stroke="${edge}" stroke-width="${r1(w * 0.02)}" opacity="0.6"/>`;
  return s;
}

// Hanging string from the top edge.
export const hang = (x, len, color, w) => `<line x1="${r1(x)}" y1="-10" x2="${r1(x)}" y2="${r1(len)}" stroke="${color}" stroke-width="${r1(w)}"/>`;
// Sagging garland curve between two x positions at height y.
export function sag(x1, x2, y, depth) { return `M${r1(x1)},${r1(y)} Q${r1((x1 + x2) / 2)},${r1(y + depth * 2)} ${r1(x2)},${r1(y)}`; }
export const sagPt = (x1, x2, y, depth, t) => [x1 + (x2 - x1) * t, y + depth * 2 * 2 * t * (1 - t)];

