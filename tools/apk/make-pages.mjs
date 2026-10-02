#!/usr/bin/env node
// Prunes the built webroot into a GitHub Pages site (browser players only) and rewrites
// absolute paths so the site works under a project subpath (…github.io/Stronghold-Protocol/)
// without a custom domain:
//   - index.html / JS URL strings / manifest JSONs: URLs resolve against the PAGE, so
//     "/x" → "./x" (page sits at the site root).
//   - CSS url(...): resolves against the CSS FILE, so "/x" → "<../ per depth>x".
// Host-only pieces (server/, node_modules/) are dropped. Output: <repo>/../dl-cache/pages-dist
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const src = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot');
const out = path.resolve(repo, '..', 'dl-cache', 'pages-dist');

const DROP = new Set(['server', 'node_modules']);
const ASSET_ROOTS = '(assets|js|css|fonts|vendor|data|shared|sim)';

function main() {
  if (!fs.existsSync(path.join(src, 'index.html'))) throw new Error(`webroot missing at ${src}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (DROP.has(name)) continue;
    fs.cpSync(path.join(src, name), path.join(out, name), { recursive: true });
  }
  fs.writeFileSync(path.join(out, '.nojekyll'), '');

  let rewrites = 0;
  rewrites += rewritePage(path.join(out, 'index.html'));
  for (const p of walk(out)) {
    const rel = path.relative(out, p).split(path.sep).join('/');
    if (rel === 'index.html') continue;
    if (rel.endsWith('.css')) rewrites += rewriteCss(p, rel);
    else if (rel.endsWith('.js') || rel.endsWith('.mjs')) rewrites += rewriteJs(p);
    else if (rel.endsWith('.json') && (rel.startsWith('data/'))) rewrites += rewriteJson(p);
  }
  console.log(`pages rewrites applied: ${rewrites}`);
  console.log(`pages-dist ready: ${out} (${(dirSize(out) / 1024 / 1024).toFixed(0)} MB)`);
}

/** Page-level refs: href/src/importmap all resolve against the page — "./" is enough. */
function rewritePage(file) {
  let text = fs.readFileSync(file, 'utf-8');
  let n = 0;
  text = text.replace(new RegExp(`(href|src)="/${ASSET_ROOTS}/`, 'g'), (m, attr) => {
    n++;
    return `${attr}="./`;
  });
  text = text.replace(new RegExp(`"/${ASSET_ROOTS}/`, 'g'), () => {
    n++;
    return `"./`;
  });
  fs.writeFileSync(file, text);
  return n;
}

/** CSS url(): resolves against the css file → prefix with ../ per nesting depth. */
function rewriteCss(file, rel) {
  const depth = rel.split('/').length - 1;
  const prefix = depth === 0 ? './' : '../'.repeat(depth);
  let text = fs.readFileSync(file, 'utf-8');
  let n = 0;
  text = text.replace(new RegExp(`url\\('?/(${ASSET_ROOTS})/`, 'g'), (m, roots) => {
    n++;
    const quote = m.includes("'") ? "'" : '';
    return `url(${quote}${prefix}${roots}/`;
  });
  fs.writeFileSync(file, text);
  return n;
}

/** JS URL strings consumed by fetch/src resolve against the page → "./". */
function rewriteJs(file) {
  let text = fs.readFileSync(file, 'utf-8');
  let n = 0;
  text = text.replace(new RegExp(`(["'\`])/${ASSET_ROOTS}/`, 'g'), (m, q) => {
    n++;
    return `${q}./`;
  });
  fs.writeFileSync(file, text);
  return n;
}

/** Manifest JSON URLs are used by the page's loaders → "./". */
function rewriteJson(file) {
  let text = fs.readFileSync(file, 'utf-8');
  let n = 0;
  text = text.replace(new RegExp(`"/${ASSET_ROOTS}/`, 'g'), () => {
    n++;
    return `"./`;
  });
  fs.writeFileSync(file, text);
  return n;
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
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
