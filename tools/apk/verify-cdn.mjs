#!/usr/bin/env node
// Verifies the Pages CDN artifact against the asset manifests: every URL listed in
// data/assets.json + data/local-assets.json (/assets/... form) must exist in the
// pages-cdn output. Catches "web content missing" class bugs at build time.
//   node tools/apk/verify-cdn.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const webroot = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot');
const cdn = path.resolve(repo, '..', 'dl-cache', 'pages-cdn');

function urlsFrom(file) {
  const p = path.join(webroot, 'data', file);
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf-8');
  const out = new Set();
  for (const m of text.matchAll(/"(\/assets\/[^"]+)"/g)) out.add(m[1]);
  return [...out];
}

let checked = 0;
const missing = [];
for (const f of ['assets.json', 'local-assets.json']) {
  for (const url of urlsFrom(f)) {
    checked++;
    const rel = url.replace(/^\/+/, '');
    if (!fs.existsSync(path.join(cdn, rel))) missing.push(url);
  }
}
console.log(`verify-cdn: checked ${checked} manifest URLs against ${cdn}`);
if (missing.length) {
  console.error(`verify-cdn: ${missing.length} MISSING, e.g.:`);
  for (const m of missing.slice(0, 10)) console.error('  ' + m);
  process.exit(1);
}
console.log('verify-cdn: all manifest assets present in the CDN artifact');
