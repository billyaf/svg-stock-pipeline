// Shared campaign plumbing: write SVGs to upload/, collect metadata, write metadata.csv + .sizes.txt.
import fs from 'fs';
import path from 'path';
import { svgDoc, resetDefs } from './lib.mjs';

export function campaign(OUT) {
  fs.mkdirSync(path.join(OUT, 'upload'), { recursive: true });
  const assets = [];
  return {
    save(code, w, h, body, meta) {
      fs.writeFileSync(path.join(OUT, 'upload', code + '.svg'), svgDoc(w, h, body));
      assets.push({ code, w, h, ...meta });
      resetDefs();
    },
    finish() {
      const esc = v => `"${String(v).replace(/"/g, '""')}"`;
      const rows = assets.map(a => [esc(a.code + '.svg'), esc(a.title), esc(a.keywords), a.category, ''].join(','));
      fs.writeFileSync(path.join(OUT, 'metadata.csv'), ['Filename,Title,Keywords,Category,Releases', ...rows].join('\n') + '\n');
      fs.writeFileSync(path.join(OUT, '.sizes.txt'), assets.map(a => `${a.code} ${a.w} ${a.h}`).join('\n') + '\n');
      for (const a of assets) {
        const k = a.keywords.split(', ').length;
        if (a.title.length > 200 || k > 49 || a.w * a.h < 15e6) throw new Error(`metadata/size check failed for ${a.code}`);
      }
      console.log(assets.map(a => `${a.code} ${a.w}x${a.h} t=${a.title.length} k=${a.keywords.split(', ').length}`).join('\n'));
    },
  };
}

export const kw = (...groups) => {
  const out = [];
  for (const g of groups) for (let k of g.split(',')) { k = k.trim().toLowerCase(); if (k && !out.includes(k)) out.push(k); }
  return out.slice(0, 49).join(', ');
};
