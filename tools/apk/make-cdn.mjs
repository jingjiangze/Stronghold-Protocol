#!/usr/bin/env node
// Builds the GitHub Pages artifact: ONLY the static asset tree (public/assets/**),
// which the box-served manifests point at (webshu.jiangjiangze.icu is the web entry,
// its frontend stays on the box; heavy assets come from the Pages CDN with
// Access-Control-Allow-Origin: *). No client code is modified or deployed here.
//   node tools/apk/make-cdn.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const src = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot', 'assets');
const out = path.resolve(repo, '..', 'dl-cache', 'pages-cdn');

function main() {
  if (!fs.existsSync(src)) throw new Error(`assets tree missing at ${src}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.cpSync(src, path.join(out, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  console.log(`pages-cdn ready: ${out} (${(dirSize(out) / 1024 / 1024).toFixed(0)} MB)`);
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

main();
