#!/usr/bin/env node
// SVG -> Magnific upload set: <name>.eps (100% vector, RGB) + <name>.jpg (sRGB preview) + metadata-magnific.csv
//
// Usage:
//   node tools/pipeline/export.mjs <svgDir> <outDir> [--meta file.csv] [--model "Claude"] [--only a,b] [--keep-work]
//
//   --meta   CSV with columns Filename,Title,Keywords (Adobe Stock style, comma separated) and optional Prompt.
//            Without it the CSV is written with empty Title/Keywords for you to fill in.
//   --model  value for the CSV "Model" column (AI label). Default "Claude".
//   --only   comma separated list of file stems to process.
//   --keep-work  keep the flattened SVG and intermediate PDF in <outDir>/_work.
//   --no-preview do not embed the TIFF preview in the EPS (plain PostScript EPS).
//
// Steps per file: flatten transparency (in Chrome) -> lint -> PDF (Chrome print) -> EPS (Poppler pdftops, PostScript Level 3)
// -> verify the EPS has no raster images -> JPG preview >= 4 MP and >= 1.5 MB with an sRGB profile.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MB = 1024 * 1024;
const LIMITS = { epsMin: 0.5 * MB, epsMax: 80 * MB, jpgMin: 1.5 * MB, jpgMax: 80 * MB, pxMin: 2000, pxMax: 10000, mpMin: 4e6, mpMax: 100e6 };
const SRGB = '/System/Library/ColorSync/Profiles/sRGB Profile.icc';
const GS = process.env.GS_PATH || 'gs';

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--keep-work', '--no-preview'].includes(argv[i - 1])));
const [svgDir, outDir] = positional;
if (!svgDir || !outDir) { console.error('Usage: node export.mjs <svgDir> <outDir> [--meta file.csv] [--model "Claude"] [--only a,b] [--keep-work]'); process.exit(1); }
const model = flag('--model', 'Claude');
const only = flag('--only', '') ? new Set(flag('--only').split(',').map(s => s.trim().replace(/\.svg$/, ''))) : null;
const keepWork = argv.includes('--keep-work');
const noPreview = argv.includes('--no-preview');
const PREVIEW_LONG = 1500; // px, long side of the TIFF preview inside the EPS
const meta = flag('--meta') ? readMeta(flag('--meta')) : new Map();

const work = path.join(outDir, '_work');
fs.mkdirSync(work, { recursive: true });

// ---------- lint: what must never reach the EPS ----------
function lint(svg) {
  const errors = [], warnings = [];
  const bad = [
    [/<text[\s>]/i, 'contains <text> (no text allowed)'], [/<image[\s>]/i, 'contains <image> (raster)'],
    [/<filter[\s>]/i, 'contains <filter> (rasterised in EPS)'], [/<mask[\s>]/i, 'contains <mask> (transparency)'],
    [/<foreignObject/i, 'contains <foreignObject>'], [/mix-blend-mode|isolation:\s*isolate/i, 'uses blend modes'],
    [/(?:^|[\s;"])(?:fill-|stroke-|stop-)?opacity\s*[=:]\s*"?\s*0?\.\d/i, 'still has opacity < 1'],
    [/rgba\(|hsla\(/i, 'uses rgba/hsla colours'], [/(?:href)="(?:https?:|data:)/i, 'references external or embedded data'],
    [/<font|font-family/i, 'uses fonts'],
  ];
  for (const [re, msg] of bad) if (re.test(svg)) errors.push(msg);
  if (/<pattern[\s>]/i.test(svg)) warnings.push('uses <pattern> fill (check the EPS in a vector editor)');
  return { errors, warnings };
}

// ---------- metadata ----------
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}
function readMeta(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const head = rows.shift().map(h => h.trim().toLowerCase());
  const col = n => head.indexOf(n);
  const m = new Map();
  for (const r of rows) {
    const stem = (r[col('filename')] || '').trim().replace(/\.(svg|eps|jpg)$/i, '');
    if (stem) m.set(stem, { title: r[col('title')] || '', keywords: r[col('keywords')] || '', prompt: col('prompt') >= 0 ? r[col('prompt')] : '' });
  }
  return m;
}
// Magnific: 5-20 English keywords, no file types, no repeats; "_ai_generated" marks AI content in CSV uploads.
const DROP = new Set(['vector', 'vectors', 'eps', 'eps10', 'jpg', 'jpeg', 'svg', 'png', 'ai', 'ai generated', 'generative ai', 'design', 'illustration']);
function magnificKeywords(raw) {
  const seen = new Set(), out = [];
  for (let k of String(raw).split(',')) {
    k = k.trim().toLowerCase().replace(/[;"#]/g, '').replace(/\s+/g, ' ');
    if (!k || DROP.has(k) || seen.has(k)) continue;
    seen.add(k); out.push(k);
    if (out.length === 19) break;
  }
  return [...out, '_ai_generated'];
}
const cleanTitle = t => String(t).replace(/\b(vector|eps10?|jpe?g|svg)\b/gi, '').replace(/[;"]/g, '').replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim();
const csvCell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';

// ---------- JPEG helpers ----------
// Insert an APP2 ICC_PROFILE segment right after SOI so the preview is tagged sRGB (lossless, no re-encode).
function embedIcc(jpg, icc) {
  const header = Buffer.from('ICC_PROFILE\0', 'latin1');
  const len = 2 + header.length + 2 + icc.length;
  if (len > 0xffff) return jpg;
  const seg = Buffer.concat([Buffer.from([0xff, 0xe2, len >> 8, len & 0xff]), header, Buffer.from([1, 1]), icc]);
  return Buffer.concat([jpg.subarray(0, 2), seg, jpg.subarray(2)]);
}
function previewSize(W, H) {
  let s = 1;
  const long = Math.max(W, H);
  if (long * s > LIMITS.pxMax) s = LIMITS.pxMax / long;
  if (W * H * s * s > LIMITS.mpMax) s = Math.sqrt(LIMITS.mpMax / (W * H));
  if (Math.min(W, H) * s < LIMITS.pxMin) s = LIMITS.pxMin / Math.min(W, H);
  if (W * H * s * s < LIMITS.mpMin) s = Math.sqrt(LIMITS.mpMin / (W * H)) * 1.001;
  return [Math.round(W * s), Math.round(H * s)];
}

// ---------- EPS ----------
// Poppler's pdftops writes PostScript Level 3, so gradients stay as native smooth shadings (shfill).
// (Ghostscript eps2write emits Level 2 and turns every gradient into a small raster image.)
async function pdfToEps(pdf, eps, title) {
  await run('pdftops', ['-eps', '-level3', pdf, eps], { maxBuffer: 64 * MB });
  // Replace the Creator comment (it carries the headless browser string) and add a Title.
  const buf = fs.readFileSync(eps);
  const headEnd = buf.indexOf('%%EndComments');
  if (headEnd > 0) {
    let head = buf.subarray(0, headEnd).toString('latin1')
      .replace(/^%%Creator:.*$/m, '%%Creator: magnific_project pipeline')
      .replace(/^%%Title:.*\n?/m, '');
    head = head.replace(/^(%%Creator:.*)$/m, `$1\n%%Title: ${title.replace(/[^\x20-\x7e]/g, '')}`);
    fs.writeFileSync(eps, Buffer.concat([Buffer.from(head, 'latin1'), buf.subarray(headEnd)]));
  }
}
// Baseline uncompressed RGB TIFF (little endian, one strip).
function tiffRGB(rgb, w, h) {
  const entries = [
    [256, 4, 1, w], [257, 4, 1, h], [258, 3, 3, 158], [259, 3, 1, 1], [262, 3, 1, 2], [273, 4, 1, 180],
    [277, 3, 1, 3], [278, 4, 1, h], [279, 4, 1, w * h * 3], [282, 5, 1, 164], [283, 5, 1, 172], [296, 3, 1, 2],
  ];
  const head = Buffer.alloc(180);
  head.write('II', 0, 'latin1'); head.writeUInt16LE(42, 2); head.writeUInt32LE(8, 4);
  head.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, count, value], k) => {
    const o = 10 + k * 12;
    head.writeUInt16LE(tag, o); head.writeUInt16LE(type, o + 2); head.writeUInt32LE(count, o + 4);
    if (type === 3 && count === 1) head.writeUInt16LE(value, o + 8); else head.writeUInt32LE(value, o + 8);
  });
  head.writeUInt32LE(0, 10 + entries.length * 12); // no next IFD (ends at 158)
  [8, 8, 8].forEach((v, i) => head.writeUInt16LE(v, 158 + i * 2));
  head.writeUInt32LE(72, 164); head.writeUInt32LE(1, 168); head.writeUInt32LE(72, 172); head.writeUInt32LE(1, 176);
  return Buffer.concat([head, rgb]);
}
// DOS EPS binary: 30-byte header + PostScript + TIFF preview. This is the layout Adobe Illustrator writes
// ("TIFF 8-bit color" preview), so vector editors and file browsers can show a thumbnail.
function withTiffPreview(eps, tiff) {
  const ps = fs.readFileSync(eps);
  const hdr = Buffer.alloc(30);
  hdr.writeUInt32BE(0xC5D0D3C6, 0);
  hdr.writeUInt32LE(30, 4); hdr.writeUInt32LE(ps.length, 8);
  hdr.writeUInt32LE(0, 12); hdr.writeUInt32LE(0, 16);
  hdr.writeUInt32LE(30 + ps.length, 20); hdr.writeUInt32LE(tiff.length, 24);
  hdr.writeUInt16LE(0xFFFF, 28);
  fs.writeFileSync(eps, Buffer.concat([hdr, ps, tiff]));
}

// Re-distil the EPS to PDF and count raster images in it: must be 0 for a clean vector file.
async function epsRasterCount(eps) {
  const back = eps + '.check.pdf';
  await run(GS, ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-dEPSCrop', '-sDEVICE=pdfwrite', '-o', back, eps], { maxBuffer: 64 * MB });
  const { stdout } = await run('pdfimages', ['-list', back]);
  fs.rmSync(back, { force: true });
  return stdout.split('\n').slice(2).filter(l => l.trim()).length;
}

// ---------- main ----------
const files = fs.readdirSync(svgDir).filter(f => f.toLowerCase().endsWith('.svg')).sort()
  .filter(f => !only || only.has(f.replace(/\.svg$/i, '')));
if (!files.length) { console.error('No SVG files found in ' + svgDir); process.exit(1); }

const page = await launch();
await page.send('Page.enable');
await page.evaluate(`document.head.innerHTML = '<style>html,body{margin:0;padding:0;background:white} .host{line-height:0}</style>';
  document.body.innerHTML = '<div id="host" class="host"></div>'; true`);
await page.evaluate(fs.readFileSync(path.join(HERE, 'page.js'), 'utf8'));

const report = [];
const epsJobs = [];
let running = 0;
const MAX_GS = 3;
const SAMPLE_LONG = 3000;
// Above these, the flattened file no longer looks like the original: it goes to _review instead of the upload set.
const REVIEW = { meanDiff: 5.0, pctOver24: 0.3 };
const t0 = Date.now();

for (const f of files) {
  const stem = f.replace(/\.svg$/i, '');
  const r = { file: stem, status: 'fail', ok: false, errors: [], warnings: [] };
  report.push(r);
  try {
    const src = fs.readFileSync(path.join(svgDir, f), 'utf8');
    if (/<text[\s>]/i.test(src)) r.warnings.push('source has <text>');

    // 1) flatten transparency (viewport must cover the sampling size for hit-testing)
    const vbm = /viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/.exec(src);
    const W0 = vbm ? +vbm[1] : +(/width="([\d.]+)/.exec(src) || [])[1];
    const H0 = vbm ? +vbm[2] : +(/height="([\d.]+)/.exec(src) || [])[1];
    const s = SAMPLE_LONG / Math.max(W0, H0);
    await page.send('Emulation.setDeviceMetricsOverride', { width: Math.ceil(W0 * s) + 2, height: Math.ceil(H0 * s) + 2, deviceScaleFactor: 1, mobile: false });
    const flat = await page.evaluate(`MP.flatten(${JSON.stringify(src)}, ${SAMPLE_LONG})`);
    r.flatten = flat.stats;
    const st = flat.stats, why = [];
    if (st.glowsOverChangingBackdrop) why.push(`${st.glowsOverChangingBackdrop} transparent glow/gradient(s) over a changing background`);
    if (st.largeShapesOverChangingBackdrop) why.push(`${st.largeShapesOverChangingBackdrop} large semi-transparent shape(s) over a changing background`);
    if (st.meanDiff > REVIEW.meanDiff || st.pctOver24 > REVIEW.pctOver24) why.push(`look changed (mean diff ${st.meanDiff}, ${st.pctOver24}% of pixels off by > 24)`);
    if (why.length) r.review = why.join('; ') + ': check _review/ preview, or redesign with opaque colours';
    const flatSvg = path.join(work, stem + '.svg');
    fs.writeFileSync(flatSvg, flat.svg);

    // 2) lint
    const l = lint(flat.svg);
    r.errors.push(...l.errors); r.warnings.push(...l.warnings);
    if (l.errors.length) { console.log(`✗ ${stem}: ${l.errors.join('; ')}`); continue; }

    // 3) PDF via Chrome print at the artboard's native size (1 CSS px = 0.75 pt)
    await page.send('Emulation.clearDeviceMetricsOverride');
    await page.evaluate(`MP.mountForPrint(${JSON.stringify(flat.svg)}, ${W0}, ${H0})`);
    const pdf = await page.send('Page.printToPDF', {
      paperWidth: W0 / 96, paperHeight: H0 / 96, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
      printBackground: true, pageRanges: '1', preferCSSPageSize: false,
    });
    const pdfPath = path.join(work, stem + '.pdf');
    fs.writeFileSync(pdfPath, Buffer.from(pdf.data, 'base64'));

    // 4) JPG preview
    let [pw, ph] = previewSize(W0, H0);
    let jpg, q;
    for (let tries = 0; ; tries++) {
      for (q of [0.92, 0.96, 0.98, 1.0]) {
        jpg = Buffer.from(await page.evaluate(`MP.jpeg(${JSON.stringify(flat.svg)}, ${pw}, ${ph}, ${q})`), 'base64');
        if (jpg.length >= LIMITS.jpgMin) break;
      }
      // Flat artwork compresses very well; a larger preview is the honest way to reach the 1.5 MB minimum.
      const k = 1.25;
      if (jpg.length >= LIMITS.jpgMin || tries > 6 || Math.max(pw, ph) * k > LIMITS.pxMax || pw * ph * k * k > LIMITS.mpMax) break;
      pw = Math.round(pw * k); ph = Math.round(ph * k);
    }
    if (jpg.length < LIMITS.jpgMin) {
      // Very flat artwork: Chrome's JPEG encoder always subsamples chroma. macOS ImageIO at quality 100 does not,
      // so re-encode from a lossless PNG render, growing the preview until it reaches 1.5 MB.
      [pw, ph] = previewSize(W0, H0);
      const png = path.join(work, stem + '.preview.png'), out = path.join(work, stem + '.preview.jpg');
      for (let tries = 0; tries < 8; tries++) {
        fs.writeFileSync(png, Buffer.from(await page.evaluate(`MP.jpeg(${JSON.stringify(flat.svg)}, ${pw}, ${ph}, 1, 'image/png')`), 'base64'));
        await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '100', png, '--out', out]);
        jpg = fs.readFileSync(out); q = 'imageio-100';
        const k = 1.25;
        if (jpg.length >= LIMITS.jpgMin || Math.max(pw, ph) * k > LIMITS.pxMax || pw * ph * k * k > LIMITS.mpMax) break;
        pw = Math.round(pw * k); ph = Math.round(ph * k);
      }
      // sips may already have tagged a profile; embedIcc below adds sRGB only if none is present.
    }
    if (fs.existsSync(SRGB) && jpg.indexOf('ICC_PROFILE') < 0) jpg = embedIcc(jpg, fs.readFileSync(SRGB));
    fs.writeFileSync(path.join(outDir, stem + '.jpg'), jpg);
    r.jpg = { width: pw, height: ph, mp: +(pw * ph / 1e6).toFixed(1), mb: +(jpg.length / MB).toFixed(2), quality: q };
    if (jpg.length < LIMITS.jpgMin) r.errors.push(`JPG ${r.jpg.mb} MB < 1.5 MB minimum`);

    // 5) EPS (pdftops runs in the background while Chrome moves on), with a TIFF preview like Illustrator writes
    const tl = Math.max(W0, H0), ts = Math.min(1, PREVIEW_LONG / tl);
    const tw = Math.max(1, Math.round(W0 * ts)), th = Math.max(1, Math.round(H0 * ts));
    const tiff = noPreview ? null : tiffRGB(Buffer.from(await page.evaluate(`MP.rgb(${JSON.stringify(flat.svg)}, ${tw}, ${th})`), 'base64'), tw, th);
    running++;
    epsJobs.push((async () => {
      const eps = path.join(outDir, stem + '.eps');
      await pdfToEps(pdfPath, eps, stem);
      if (tiff) withTiffPreview(eps, tiff);
      const size = fs.statSync(eps).size;
      const rasters = await epsRasterCount(eps);
      r.eps = { mb: +(size / MB).toFixed(2), rasterImages: rasters, tiffPreview: tiff ? `${tw}x${th}` : null };
      if (rasters) r.errors.push(`EPS contains ${rasters} raster image(s)`);
      if (size < LIMITS.epsMin) r.errors.push(`EPS ${r.eps.mb} MB < 0.5 MB minimum (artwork too simple: add detail or combine into a set)`);
      if (size > LIMITS.epsMax) r.errors.push(`EPS ${r.eps.mb} MB > 80 MB maximum`);
      r.ok = !r.errors.length;
      r.status = !r.ok ? 'fail' : r.review ? 'review' : 'ready';
      console.log(`${{ ready: '✓', review: '?', fail: '✗' }[r.status]} ${stem}  eps ${r.eps.mb} MB  jpg ${r.jpg.width}x${r.jpg.height} ${r.jpg.mb} MB  flattened ${r.flatten.flattened}  diff ${r.flatten.meanDiff}${r.errors.length ? '  ' + r.errors.join('; ') : ''}${r.review ? '  REVIEW: ' + r.review : ''}`);
    })().catch(e => { r.errors.push('EPS: ' + e.message.split('\n')[0]); console.log(`✗ ${stem}: ${e.message.split('\n')[0]}`); })
      .finally(() => { running--; }));
    while (running >= MAX_GS) await new Promise(r2 => setTimeout(r2, 200));
  } catch (e) {
    r.errors.push(e.message.split('\n')[0]);
    console.log(`✗ ${stem}: ${r.errors.at(-1)}`);
  }
}
await Promise.all(epsJobs);
await page.close();

// ---------- CSV (semicolon separated, as in the Magnific guidelines) ----------
const lines = ['File name;Title;Keywords;Prompt;Model'];
// Only upload-ready files go in the CSV and stay in <outDir>; review files move to <outDir>/_review, failures are removed.
const reviewDir = path.join(outDir, '_review');
for (const r of report) {
  const files2 = ['.eps', '.jpg'].map(e => [path.join(outDir, r.file + e), path.join(reviewDir, r.file + e)]);
  if (r.status === 'review') { fs.mkdirSync(reviewDir, { recursive: true }); files2.forEach(([a, b]) => fs.existsSync(a) && fs.renameSync(a, b)); }
  if (r.status === 'fail') files2.forEach(([a]) => fs.rmSync(a, { force: true }));
}
for (const r of report.filter(x => x.status === 'ready')) {
  const m = meta.get(r.file) || { title: '', keywords: '', prompt: '' };
  const title = cleanTitle(m.title);
  const kws = magnificKeywords(m.keywords);
  r.keywordCount = kws.length;
  if (kws.length < 6) r.warnings.push('fewer than 5 keywords in the CSV: fill them in before upload');
  lines.push([r.file + '.eps', title, kws.join(','), m.prompt || title, model].map(csvCell).join(';'));
}
fs.writeFileSync(path.join(outDir, 'metadata-magnific.csv'), lines.join('\n') + '\n');

if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
const count = st => report.filter(r => r.status === st).length;
const ready = count('ready');
console.log(`\n${ready} ready, ${count('review')} to review (_review/), ${count('fail')} failed, of ${report.length} in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${outDir}`);
console.log('Details: ' + path.join(outDir, 'report.json'));
process.exit(ready === report.length ? 0 : 2);
