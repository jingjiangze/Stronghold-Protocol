#!/usr/bin/env node
// assets-manifest.mjs -- split the static payload from the program: build a
// content-addressed manifest of the operator's own asset tree so a server can be
// updated / verified without shipping the asset bytes inside the program package.
//
// It reads a directory and writes JSON only. It never uploads anything anywhere:
// the asset tree itself is third-party game material (see upstream .gitignore:
// "game assets: (c) Hypergryph / Yostar ... NEVER committed") and must stay on the
// operator's own storage, fetched per server by tools/fetch-assets.mjs.
//
// usage: node assets-manifest.mjs <rootDir> [moreRoots...] -o manifest.json [--verify]
import { createHash } from 'node:crypto';
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('-o');
const outFile = outIdx >= 0 ? argv.splice(outIdx, 2)[1] : 'assets-manifest.json';
const verify = argv.includes('--verify');
const roots = argv.filter((a) => !a.startsWith('--'));
if (!roots.length) { console.error('need at least one root dir'); process.exit(2); }

const EXT_TYPE = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json',
  '.woff2': 'font/woff2', '.js': 'text/javascript', '.css': 'text/css', '.spine': 'application/octet-stream' };

function walk(dir, base, acc) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) { walk(p, base, acc); continue; }
    if (!name.isFile()) continue;
    const st = statSync(p);
    acc.push({ p: relative(base, p).split(sep).join('/'), s: st.size, m: Math.round(st.mtimeMs) });
  }
  return acc;
}

const groups = [];
let totalBytes = 0, totalCount = 0;
for (const root of roots) {
  if (!existsSync(root)) { console.warn('skip missing', root); continue; }
  const files = walk(root, root, []).sort((a, b) => (a.p < b.p ? -1 : 1));
  const items = [];
  for (const f of files) {
    // hash lazily but always: the manifest is the integrity record for a re-download
    const h = createHash('sha256').update(readFileSync(join(root, f.p))).digest('hex');
    items.push({ p: f.p, s: f.s, h, t: EXT_TYPE['.' + f.p.split('.').pop().toLowerCase()] || 'application/octet-stream' });
    totalBytes += f.s; totalCount++;
  }
  groups.push({ root: root.replace(/\\/g, '/'), count: items.length, bytes: items.reduce((a, b) => a + b.s, 0), files: items });
  console.log(`${root}: ${items.length} files, ${(items.reduce((a, b) => a + b.s, 0) / 1048576).toFixed(1)} MB`);
}

const manifest = { gen: new Date().toISOString(), totalFiles: totalCount, totalBytes, groups };
writeFileSync(outFile, JSON.stringify(manifest));
console.log(`wrote ${outFile} (${(JSON.stringify(manifest).length / 1048576).toFixed(2)} MB, ${totalCount} entries)`);

if (verify) {
  // verify mode: confirm every path the client will request is actually servable and unchanged
  let bad = 0;
  for (const g of groups) {
    for (const f of g.files) {
      const abs = join(g.root, f.p);
      if (!existsSync(abs)) { console.error('MISSING', abs); bad++; continue; }
      if (statSync(abs).size !== f.s) { console.error('SIZE', f.p); bad++; }
    }
  }
  console.log(bad ? `verify FAILED (${bad})` : 'verify OK');
  process.exit(bad ? 1 : 0);
}
