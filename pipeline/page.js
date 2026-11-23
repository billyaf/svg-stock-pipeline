// Runs inside headless Chrome. Exposes window.MP with:
//   flatten(svgText, sampleLong) -> { svg, stats }   remove all transparency by baking it into opaque colours
//   jpeg(svgText, w, h, quality) -> base64 JPEG      render a preview
//   mountForPrint(svgText, w, h)                     show the SVG at its native size for Page.printToPDF
// Why: PostScript/EPS has no transparency, so Ghostscript rasterises any page that uses it.
// Baking alpha into opaque colours keeps the EPS 100% vector.
(() => {
  const PAINTED = 'path,circle,ellipse,rect,line,polygon,polyline';
  const NS = 'http://www.w3.org/2000/svg';
  // A transparent gradient, or a large semi-transparent shape, over a backdrop that is not uniform cannot become
  // one opaque shape without a visible edge. These thresholds (max channel spread of the backdrop) send it to review.
  const RISK = { gradSpread: 4, solidSpread: 10, area: 0.01, localMean: 10, seamFrac: 0.25 };
  const NONRENDER = 'defs,clipPath,mask,pattern,symbol,marker';
  const host = () => document.getElementById('host');

  const parseColor = s => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return { c: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
  };
  const hex = c => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
  const mix = (c, b, a) => [0, 1, 2].map(i => a * c[i] + (1 - a) * b[i]);

  function mount(svgText, w, h) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const err = doc.querySelector('parsererror');
    if (err) throw new Error('SVG parse error: ' + err.textContent.slice(0, 200));
    const svg = document.importNode(doc.documentElement, true);
    host().replaceChildren(svg);
    const vb = svg.viewBox.baseVal;
    const W = (vb && vb.width) || parseFloat(svg.getAttribute('width'));
    const H = (vb && vb.height) || parseFloat(svg.getAttribute('height'));
    const orig = { width: svg.getAttribute('width'), height: svg.getAttribute('height') };
    if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', w); svg.setAttribute('height', h);
    svg.style.display = 'block';
    return { svg, W, H, orig };
  }

  function serialize(svg, orig) {
    const c = svg.cloneNode(true);
    c.removeAttribute('style');
    if (orig) { c.setAttribute('width', orig.width); c.setAttribute('height', orig.height); }
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(c);
  }

  async function raster(svg, w, h) {
    const c = svg.cloneNode(true);
    c.setAttribute('width', w); c.setAttribute('height', h); c.removeAttribute('style');
    const blob = new Blob([new XMLSerializer().serializeToString(c)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    return { cv, ctx, data: ctx.getImageData(0, 0, w, h).data };
  }

  function groupAlpha(el, svg) {
    let a = 1;
    for (let n = el; n && n !== svg.parentNode; n = n.parentElement) a *= parseFloat(getComputedStyle(n).opacity);
    return a;
  }

  // Paint of one side ('fill' | 'stroke') with its total alpha, or null when it paints nothing.
  function paint(el, side, ga) {
    const cs = getComputedStyle(el);
    const v = cs[side];
    if (!v || v === 'none') return null;
    if (side === 'stroke' && parseFloat(cs.strokeWidth) <= 0) return null;
    const so = parseFloat(side === 'fill' ? cs.fillOpacity : cs.strokeOpacity);
    if (v.startsWith('url(')) {
      const id = /url\(["']?#([^"')]+)/.exec(v);
      return id ? { grad: id[1], a: so * ga } : null;
    }
    const col = parseColor(v);
    return col ? { c: col.c, a: col.a * so * ga } : null;
  }

  function gradientStops(svg, id) {
    let g = svg.querySelector('#' + CSS.escape(id));
    const seen = new Set();
    while (g && !g.querySelector('stop') && !seen.has(g)) {
      seen.add(g);
      const href = g.getAttribute('href') || g.getAttribute('xlink:href');
      g = href ? svg.querySelector(href) : null;
    }
    return g ? [...g.querySelectorAll('stop')] : [];
  }
  const gradTranslucent = (svg, id) => gradientStops(svg, id).some(s => parseFloat(getComputedStyle(s).stopOpacity) < 1);

  // Grid of screen points inside an element's bounding box (clamped to the viewport).
  function gridPoints(el, maxSide, n = 9, nyMax = n) {
    const r = el.getBoundingClientRect();
    const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top);
    const x1 = Math.min(maxSide.w - 1, r.right), y1 = Math.min(maxSide.h - 1, r.bottom);
    if (x1 < x0 || y1 < y0) return [];
    const pts = [[(x0 + x1) / 2, (y0 + y1) / 2]];
    const nx = Math.max(1, Math.min(n, Math.ceil(x1 - x0))), ny = Math.max(1, Math.min(nyMax, Math.ceil(y1 - y0)));
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++)
      pts.push([x0 + (i + 0.5) * (x1 - x0) / nx, y0 + (j + 0.5) * (y1 - y0) / ny]);
    return pts;
  }
  const toUser = (el, x, y) => {
    const m = el.getScreenCTM();
    return m ? new DOMPoint(x, y).matrixTransform(m.inverse()) : null;
  };
  // Largest channel distance of any backdrop sample from the mean: 0 means the backdrop is uniform.
  const spreadOf = list => {
    if (!list.length) return 0;
    const m = [0, 1, 2].map(i => list.reduce((t, c) => t + c[i], 0) / list.length);
    return Math.max(...list.map(c => Math.max(...[0, 1, 2].map(i => Math.abs(c[i] - m[i])))));
  };
  // Fraction of points along an element's outline where flattening created a new colour step across the edge
  // (a hard edge that was not there before). This is what the eye sees as a "disc" around a glow.
  function seamFraction(el, before, after, w, h) {
    if (typeof el.getTotalLength !== 'function') return 0;
    let L;
    try { L = el.getTotalLength(); } catch { return 0; }
    const m = el.getScreenCTM();
    if (!L || !m) return 0;
    const N = 96, step = (x, y) => [x, y];
    let n = 0, bad = 0;
    const at = (d, side, nx, ny, x, y) => { const X = Math.round(x + side * 3 * nx), Y = Math.round(y + side * 3 * ny); return X >= 0 && Y >= 0 && X < w && Y < h ? (Y * w + X) * 4 : -1; };
    const jump = (data, i, k) => Math.max(...[0, 1, 2].map(c => Math.abs(data[i + c] - data[k + c])));
    for (let t = 0; t < N; t++) {
      const p0 = el.getPointAtLength((t / N) * L), p1 = el.getPointAtLength(Math.min(L, (t / N) * L + L / (N * 4)));
      const a = new DOMPoint(p0.x, p0.y).matrixTransform(m), b = new DOMPoint(p1.x, p1.y).matrixTransform(m);
      let tx = b.x - a.x, ty = b.y - a.y; const len = Math.hypot(tx, ty);
      if (!len) continue;
      const nx = -ty / len, ny = tx / len;
      const i = at(0, 1, nx, ny, a.x, a.y), k = at(0, -1, nx, ny, a.x, a.y);
      if (i < 0 || k < 0) continue;
      n++;
      if (jump(after, i, k) - jump(before, i, k) > 6) bad++;
    }
    return n ? bad / n : 0;
  }
  const px = (data, w, x, y) => { const i = (Math.floor(y) * w + Math.floor(x)) * 4; return [data[i], data[i + 1], data[i + 2]]; };

  async function flatten(svgText, sampleLong = 3000) {
    // Display at a sampling size; the viewport must be at least this big (set from Node).
    const probe = mount(svgText, 10, 10);
    const s = sampleLong / Math.max(probe.W, probe.H);
    const w = Math.round(probe.W * s), h = Math.round(probe.H * s);
    const { svg, orig } = mount(svgText, w, h);
    window.scrollTo(0, 0);
    const before = await raster(svg, w, h);

    const els = [...svg.querySelectorAll(PAINTED)].filter(e => !e.closest(NONRENDER) && getComputedStyle(e).display !== 'none');
    const jobs = []; // { el, fill, stroke, B: [sum r,g,b], n, needHidden }
    for (const el of els) {
      const ga = groupAlpha(el, svg);
      const fill = paint(el, 'fill', ga), stroke = el.tagName === 'line' ? paint(el, 'stroke', ga) : paint(el, 'stroke', ga);
      const tr = p => p && (p.a < 0.999 || (p.grad && gradTranslucent(svg, p.grad)));
      if (!tr(fill) && !tr(stroke) && ga >= 0.999) continue;
      const r = el.getBoundingClientRect();
      jobs.push({ el, fill, stroke, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, B: [0, 0, 0], n: 0, needHidden: !!((fill && fill.grad) || (stroke && stroke.grad)),
        isGrad: !!((fill && fill.grad) || (stroke && stroke.grad)), area: (r.width * r.height) / (w * h) });
    }

    // Pass 1: where a translucent solid paint is the topmost thing, backdrop B = (P - aC) / (1 - a).
    for (const j of jobs) {
      if (j.needHidden) continue;
      for (const [x, y] of gridPoints(j.el, { w, h })) {
        if (document.elementFromPoint(x, y) !== j.el) continue;
        const u = toUser(j.el, x, y);
        if (!u) continue;
        let p = null;
        if (j.stroke && j.el.isPointInStroke(u)) p = j.stroke;
        else if (j.fill && j.el.tagName !== 'line' && j.el.isPointInFill(u)) p = j.fill;
        if (!p || p.grad || p.a >= 0.999) continue;
        const P = px(before.data, w, x, y);
        const B = p.a <= 0.001 ? P : [0, 1, 2].map(i => Math.max(0, Math.min(255, (P[i] - p.a * p.c[i]) / (1 - p.a))));
        for (let i = 0; i < 3; i++) j.B[i] += B[i];
        j.n++;
        (j.bs = j.bs || []).push(B);
      }
      if (!j.n) j.needHidden = true;
      else j.spread = spreadOf(j.bs);
    }

    // Pass 2: gradients and elements without a clean sample: render once with them hidden and read the backdrop.
    const hidden = jobs.filter(j => j.needHidden);
    if (hidden.length) {
      // Choose sample points while everything is still visible: inside the element, and preferably where
      // nothing is painted on top of it (otherwise shapes above it would leak into its "backdrop").
      for (const j of hidden) {
        const inside = [], top = [];
        for (const [x, y] of gridPoints(j.el, { w, h }, 16)) {
          const u = toUser(j.el, x, y);
          if (!u) continue;
          const ins = (j.fill && j.el.tagName !== 'line' && j.el.isPointInFill(u)) || (j.stroke && j.el.isPointInStroke(u));
          if (!ins) continue;
          inside.push([x, y, u.y]);
          if (document.elementFromPoint(x, y) === j.el) top.push([x, y, u.y]);
        }
        j.pts = top.length ? top : inside;
      }
      hidden.forEach(j => j.el.setAttribute('visibility', 'hidden'));
      const bg = await raster(svg, w, h);
      hidden.forEach(j => j.el.removeAttribute('visibility'));
      for (const j of hidden) {
        const samples = j.pts.map(([x, y, uy]) => ({ P: px(bg.data, w, x, y), uy }));
        if (!samples.length) { // degenerate (zero-area) element: use the pixel under its centre
          const [x, y] = gridPoints(j.el, { w, h }, 1)[0] || [0, 0];
          samples.push({ P: px(bg.data, w, x, y), uy: 0 });
        }
        j.B = [0, 1, 2].map(i => samples.reduce((t, s2) => t + s2.P[i], 0));
        j.n = samples.length;
        // A translucent gradient over a backdrop that changes (a glow across a horizon or over a sky gradient)
        // cannot be expressed as one opaque shape: it will show a hard edge. Record it so the file goes to review.
        j.spread = spreadOf(samples.map(s2 => s2.P));
      }
    }

    // Apply: bake alpha into opaque colours (computed for every job before any change is applied).
    let gradClones = 0;
    const paintFor = (p, B) => {
      if (!p.grad) return { color: hex(mix(p.c, B, p.a)) };
      return {
        grad: p.grad,
        stops: gradientStops(svg, p.grad).map(st => {
          const cs = getComputedStyle(st);
          const col = parseColor(cs.stopColor) || { c: [0, 0, 0], a: 1 };
          return { offset: st.getAttribute('offset') || '0', c: hex(mix(col.c, B, col.a * parseFloat(cs.stopOpacity) * p.a)) };
        }),
      };
    };
    const makeGrad = o => {
      const src = svg.querySelector('#' + CSS.escape(o.grad));
      const clone = src.cloneNode(false);
      const id = `${o.grad}_flat${++gradClones}`;
      clone.setAttribute('id', id);
      clone.removeAttribute('href'); clone.removeAttribute('xlink:href');
      let ref = src; // inherit geometry attributes along an href chain
      while (ref && (ref.getAttribute('href') || ref.getAttribute('xlink:href'))) {
        ref = svg.querySelector(ref.getAttribute('href') || ref.getAttribute('xlink:href'));
        if (ref) for (const a of ref.attributes) if (!clone.hasAttribute(a.name) && a.name !== 'id') clone.setAttribute(a.name, a.value);
      }
      for (const st of o.stops) {
        const n = document.createElementNS(NS, 'stop');
        n.setAttribute('offset', st.offset); n.setAttribute('stop-color', st.c); n.setAttribute('stop-opacity', '1');
        clone.appendChild(n);
      }
      src.parentNode.insertBefore(clone, src.nextSibling);
      return id;
    };
    const setPaint = (el, side, o) => {
      el.setAttribute(side, o.color ? o.color : `url(#${makeGrad(o)})`);
      el.setAttribute(side + '-opacity', '1');
      el.style.removeProperty(side + '-opacity');
      el.style.removeProperty(side);
    };
    const updates = jobs.map(j => {
      const B = j.B.map(v => v / j.n);
      const plan = ['fill', 'stroke'].filter(side => j[side]).map(side => [side, paintFor(j[side], B)]);
      return () => plan.forEach(([side, o]) => setPaint(j.el, side, o));
    });
    updates.forEach(fn => fn());
    // Neutralise every remaining opacity attribute/property, then drop gradients nobody uses any more.
    for (const n of svg.querySelectorAll('*')) {
      for (const a of ['opacity', 'fill-opacity', 'stroke-opacity']) {
        if (n.hasAttribute(a) && parseFloat(n.getAttribute(a)) < 1) n.setAttribute(a, '1');
        n.style && n.style.removeProperty(a);
      }
    }
    const used = new Set();
    for (const n of svg.querySelectorAll('*')) for (const a of n.attributes) {
      for (const m of a.value.matchAll(/url\(#([^)]+)\)/g)) used.add(m[1]);
      if (a.name === 'href' || a.name === 'xlink:href') used.add(a.value.replace(/^#/, ''));
    }
    let removedGrad = 0;
    for (const g of svg.querySelectorAll('linearGradient,radialGradient')) if (!used.has(g.id)) { g.remove(); removedGrad++; }

    const after = await raster(svg, w, h);
    // Local check for each element whose backdrop was not uniform: how much did its own area change?
    const cand = jobs.filter(j => (j.spread || 0) > (j.isGrad ? RISK.gradSpread : RISK.solidSpread) && (j.isGrad || j.area > RISK.area));
    for (const j of cand) {
      const r = j.rect;
      const x0 = Math.max(0, Math.floor(r.left)), y0 = Math.max(0, Math.floor(r.top));
      const x1 = Math.min(w, Math.ceil(r.right)), y1 = Math.min(h, Math.ceil(r.bottom));
      let sum = 0, over = 0, n = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const i = (y * w + x) * 4;
        const d = Math.max(Math.abs(before.data[i] - after.data[i]), Math.abs(before.data[i + 1] - after.data[i + 1]), Math.abs(before.data[i + 2] - after.data[i + 2]));
        sum += d; if (d > 8) over++; n++;
      }
      j.local = { mean: n ? sum / n : 0, over8: n ? over / n : 0, seam: seamFraction(j.el, before.data, after.data, w, h) };
      // Risky when its outline became a visible hard edge, or its whole area changed a lot.
      j.risky = j.local.seam > RISK.seamFrac || j.local.mean > RISK.localMean;
    }
    let sum = 0, over = 0, max = 0;
    const N = w * h;
    for (let i = 0; i < N * 4; i += 4) {
      const d = Math.max(Math.abs(before.data[i] - after.data[i]), Math.abs(before.data[i + 1] - after.data[i + 1]), Math.abs(before.data[i + 2] - after.data[i + 2]));
      sum += d; if (d > 24) over++; if (d > max) max = d;
    }
    return {
      svg: serialize(svg, orig),
      stats: {
        width: probe.W, height: probe.H, flattened: jobs.length, viaHiddenRender: hidden.length,
        gradientsBaked: gradClones, gradientsRemoved: removedGrad, glowsOverChangingBackdrop: cand.filter(j => j.risky && j.isGrad).length,
        largeShapesOverChangingBackdrop: cand.filter(j => j.risky && !j.isGrad).length,
        candidates: cand.map(j => [j.isGrad ? 'grad' : 'solid', +j.area.toFixed(3), Math.round(j.spread), +j.local.mean.toFixed(2), +j.local.seam.toFixed(2)]).sort((a, b) => b[3] - a[3]).slice(0, 8),
        meanDiff: +(sum / N).toFixed(3), pctOver24: +(100 * over / N).toFixed(3), maxDiff: max,
      },
    };
  }

  async function jpeg(svgText, w, h, quality, type = 'image/jpeg') {
    const { svg } = mount(svgText, w, h);
    const r = await raster(svg, w, h);
    const url = r.cv.toDataURL(type, quality);
    host().replaceChildren();
    return url.slice(url.indexOf(',') + 1);
  }

  // Raw RGB pixels (base64) for the TIFF preview embedded in the EPS.
  async function rgb(svgText, w, h) {
    const { svg } = mount(svgText, w, h);
    const r = await raster(svg, w, h);
    host().replaceChildren();
    const out = new Uint8Array(w * h * 3);
    for (let i = 0, o = 0; i < r.data.length; i += 4) { out[o++] = r.data[i]; out[o++] = r.data[i + 1]; out[o++] = r.data[i + 2]; }
    let s = '';
    for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function mountForPrint(svgText, w, h) {
    mount(svgText, w, h);
    return true;
  }

  window.MP = { flatten, jpeg, rgb, mountForPrint };
})();
