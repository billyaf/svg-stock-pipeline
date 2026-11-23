// Build one campaign from a theme script: numbered SVGs in <out>/upload, metadata.csv, .sizes.txt.
//   node generator/build.mjs <outDir> <theme>        e.g. node generator/build.mjs out/geo-confetti geo-confetti
import { run } from './kit.mjs';

const [out, name] = process.argv.slice(2);
if (!out || !name || !/^[a-z0-9-]+$/.test(name)) { console.error('usage: node generator/build.mjs <outDir> <theme>'); process.exit(1); }
const mod = await import(`./themes/${name}.mjs`);
run(out, mod.theme, mod.build());
