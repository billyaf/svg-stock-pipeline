// Demo theme: playful geometric confetti. Six assets that each use a different composition
// (seamless scatter, seamless lattice, icon sheet, layered hills, ribbon banner, star field) so the set
// is not just one layout recoloured. Every colour is opaque: the export pipeline then marks them "ready".
import { G, rect, rng, r1, shade, mix, scatterTile, tile, sheet, hills, ribbon, sparkle, star8pts, TAU } from '../kit.mjs';

export const theme = {
  lead: 'geometric confetti, abstract geometric, confetti pattern',
  base: 'abstract, geometric, shapes, confetti, colorful, modern, playful, minimal, flat, decorative, background, design element, celebration, party, fun, memphis',
};

const PAL = [
  { bg: '#FFF6EC', ink: ['#FF6B4A', '#2D5BFF', '#FFC233', '#1FB58F', '#B55BFF'], name: 'warm cream multicolor' },
  { bg: '#14163A', ink: ['#FF7AB6', '#5BE0FF', '#FFE45B', '#7CFF9E', '#B9A4FF'], name: 'navy neon' },
  { bg: '#EAF7F2', ink: ['#0F6B5C', '#F28C28', '#2A9D8F', '#E9C46A', '#264653'], name: 'mint earthy' },
];

// One confetti piece: circle, triangle, ring, squiggle or plus, drawn around (0,0) with size s.
function piece(kind, s, c) {
  switch (kind % 5) {
    case 0: return `<circle r="${r1(s * 0.5)}" fill="${c}"/>`;
    case 1: return `<path d="M0,${r1(-s * 0.6)} L${r1(s * 0.55)},${r1(s * 0.4)} L${r1(-s * 0.55)},${r1(s * 0.4)}Z" fill="${c}"/>`;
    case 2: return `<circle r="${r1(s * 0.42)}" fill="none" stroke="${c}" stroke-width="${r1(s * 0.16)}"/>`;
    case 3: { let d = `M${r1(-s)},0`; for (let k = 1; k <= 8; k++) d += ` L${r1(-s + k * s / 4)},${r1(k % 2 ? -s * 0.25 : s * 0.25)}`; return `<path d="${d}" fill="none" stroke="${c}" stroke-width="${r1(s * 0.14)}" stroke-linecap="round" stroke-linejoin="round"/>`; }
    default: return `<path d="M${r1(-s * 0.45)},0H${r1(s * 0.45)}M0,${r1(-s * 0.45)}V${r1(s * 0.45)}" stroke="${c}" stroke-width="${r1(s * 0.18)}" stroke-linecap="round"/>`;
  }
}

function scatter(pi) {
  const P = PAL[pi], W = 6000, H = 6000, t = 1000;
  const s = rect(W, H, P.bg) + scatterTile(W, H, t, 14, 40 + pi, (x, y, k, r) => G(x, y, 1, piece(k, 70 + r() * 60, P.ink[k % P.ink.length]), r() * 360), 150);
  return { slug: 'geometric-confetti-seamless', W, H, svg: s, color: P.name,
    title: `Seamless geometric confetti pattern with circles, triangles, rings and squiggles, ${P.name}`,
    kw: 'seamless pattern, repeat, tile, wallpaper, wrapping paper, fabric print, textile, scattered shapes' };
}

function lattice() {
  const P = PAL[2], W = 6000, H = 6000, t = 600;
  let s = rect(W, H, P.bg);
  s += tile(W, H, t, [[0, 0, 0], [t / 2, t / 2, 1]], (x, y, k) => `<polygon points="${star8pts(x, y, t * 0.2, k * Math.PI / 8)}" fill="${P.ink[k ? 1 : 0]}"/>`);
  s += tile(W, H, t, [[t / 2, 0], [0, t / 2]], (x, y) => `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(t * 0.05)}" fill="${P.ink[3]}"/>`);
  return { slug: 'eight-point-star-lattice-seamless', W, H, svg: s, color: P.name,
    title: `Seamless eight point star lattice pattern, modern geometric tile, ${P.name}`,
    kw: 'seamless pattern, star pattern, eight point star, lattice, tile, geometric tile, repeat, wallpaper' };
}

function iconSheet() {
  const P = PAL[0], W = 6000, H = 4000;
  const s = sheet(W, H, 6, 4, (x, y, R, k) => G(x, y, 1, piece(k, R * 1.4, P.ink[(k * 2) % P.ink.length])), { bg: P.bg });
  return { slug: 'geometric-shapes-element-set', W, H, svg: s, color: P.name,
    title: `Set of 24 flat geometric shape elements, circles, triangles, rings, zigzags and plus signs, ${P.name}`,
    kw: 'set, collection, elements, icons, shapes, isolated, flat, design elements, bundle' };
}

function landscape() {
  const P = PAL[1], W = 6000, H = 4000, r = rng(7);
  let s = rect(W, H, P.bg);
  for (let k = 0; k < 60; k++) s += sparkle(r() * W, r() * H * 0.55, 18 + r() * 30, mix(P.ink[k % 5], P.bg, 0.3));
  [0.55, 0.65, 0.76, 0.88].forEach((y, k) => { s += `<path d="${hills(W, H, H * y, H * 0.05, 1 + k * 0.4, k * 1.7, H * 0.015)}" fill="${mix(P.ink[k], P.bg, 0.55 - k * 0.1)}"/>`; });
  return { slug: 'neon-geometric-hills-background', W, H, svg: s, color: P.name,
    title: `Layered geometric hills under a starry sky, flat abstract night landscape background, ${P.name}`,
    kw: 'landscape, hills, night, sky, stars, layered, background, wallpaper, banner, poster' };
}

function banner() {
  const P = PAL[0], W = 6000, H = 3000;
  let s = rect(W, H, P.bg);
  const pts = Array.from({ length: 7 }, (_, k) => [-200 + k * (W + 400) / 6, H * (0.5 + 0.18 * Math.sin(k * 1.3))]);
  s += ribbon(pts, H * 0.22, P.ink[1], shade(P.ink[1], -0.25), { twist: 2.5 });
  const r = rng(3);
  for (let k = 0; k < 70; k++) s += G(r() * W, r() * H, 1, piece(k, 40 + r() * 50, P.ink[k % 5]), r() * 360);
  return { slug: 'ribbon-confetti-banner', W, H, svg: s, color: P.name,
    title: `Flowing ribbon with geometric confetti, wide celebration banner background, ${P.name}`,
    kw: 'ribbon, banner, celebration, party, header, wide, horizontal, festive, greeting' };
}

function starField() {
  const P = PAL[1], W = 5000, H = 5000, r = rng(11);
  let s = rect(W, H, P.bg);
  for (let k = 0; k < 9; k++) { const R = 260 + k * 230; s += `<circle cx="${W / 2}" cy="${H / 2}" r="${R}" fill="none" stroke="${mix(P.ink[k % 5], P.bg, 0.6)}" stroke-width="18"/>`; }
  for (let k = 0; k < 90; k++) { const a = r() * TAU, d = 300 + r() * 2100; s += G(W / 2 + Math.cos(a) * d, H / 2 + Math.sin(a) * d, 1, piece(k, 50 + r() * 70, P.ink[k % 5]), r() * 360); }
  return { slug: 'radial-confetti-burst', W, H, svg: s, color: P.name,
    title: `Radial burst of geometric confetti around concentric rings, abstract celebration background, ${P.name}`,
    kw: 'burst, radial, concentric circles, rings, explosion, celebration, square, social media post' };
}

export const build = () => [() => scatter(0), () => scatter(1), lattice, iconSheet, landscape, banner, starField];
