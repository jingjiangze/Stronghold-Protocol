// Rewrite the built client's data/assets.json to serve art from the R2 CDN origin
// (https://weishucdn.jiangjiangze.icu/assets/…) instead of the same origin — the policy both
// jiangjiangze deployments ship (players fetch the 300 MB of art from the CDN; the APK's local
// mode de-CDNs these URLs back to its embedded tree in its WebView interceptor, and the web
// Service Worker only intercepts same-origin requests, so the CDN fetches bypass it cleanly).
//
// resource-manifest.json deliberately stays SAME-ORIGIN: public/js/resources/common.js
// validateResourceUrl only accepts /assets|/fonts relative paths — a CDN URL there makes the
// resource manager (and its ZIP import) reject the whole manifest.
//
// Usage: node tools/rewrite-cdn-assets.mjs [dist/client]   (idempotent: already-absolute URLs stay)
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://weishucdn.jiangjiangze.icu';

function walk(value) {
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v);
    return out;
  }
  return typeof value === 'string' && value.startsWith('/assets/') ? BASE + value : value;
}

function count(value) {
  if (Array.isArray(value)) return value.reduce((n, v) => n + count(v), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce((n, v) => n + count(v), 0);
  return typeof value === 'string' && value.startsWith(BASE + '/assets/') ? 1 : 0;
}

const dist = path.resolve(process.argv[2] || 'dist/client');
const file = path.join(dist, 'data', 'assets.json');
const source = JSON.parse(await fs.readFile(file, 'utf8'));
const rewritten = walk(source);
await fs.writeFile(file, JSON.stringify(rewritten, null, 0), 'utf8');
console.log(`rewrite-cdn-assets: ${count(rewritten)} /assets/ URLs -> ${BASE} (was ${count(source)} same-origin)`);
