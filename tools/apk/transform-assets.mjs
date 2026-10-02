#!/usr/bin/env node
// Rewrites the asset-manifest JSONs for the BOX deployment so that browser clients
// fetch heavy assets from the GitHub Pages CDN instead of the box's home uplink.
// Pure data transform: only URL strings change; no client code is touched.
//   node tools/apk/transform-assets.mjs [--base https://host/path]
// Output: <repo>/../dl-cache/cdn-manifests/{assets.json,local-assets.json}
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const dataDir = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot', 'data');
const out = path.resolve(repo, '..', 'dl-cache', 'cdn-manifests');

const argBase = process.argv.indexOf('--base');
const BASE = (argBase > 0 ? process.argv[argBase + 1] : 'https://jingjiangze.github.io/Stronghold-Protocol')
  .replace(/\/+$/, '');

function transform(file) {
  const src = path.join(dataDir, file);
  if (!fs.existsSync(src)) {
    console.log(`skip (absent): ${file}`);
    return;
  }
  const before = fs.readFileSync(src, 'utf-8');
  let count = 0;
  const after = before.replace(/"\/assets\//g, () => {
    count++;
    return `"${BASE}/assets/`;
  });
  fs.writeFileSync(path.join(out, file), after);
  console.log(`${file}: rewrote ${count} asset URLs -> ${BASE}/assets/`);
}

fs.mkdirSync(out, { recursive: true });
transform('assets.json');
transform('local-assets.json');
console.log(`cdn manifests ready: ${out}`);
