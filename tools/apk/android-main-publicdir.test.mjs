// android-main-publicdir.test.mjs — the device entry MUST tell startServer() where the webroot is.
//
//   node --test tools/apk/android-main-publicdir.test.mjs
//
// WHY (2026-10-17 现场故障：本机服务「游戏脚本加载失败」/ 启动极慢):
// The APK ships a FLATTENED webroot — upstream `public/*` lands at the ROOT of filesDir/webroot,
// beside `server/`, `data/`, `shared/`. But `server/http/config.js serveDirs()` defaults
// `publicDir` to `ROOT/public`, and on the device ROOT *is* the webroot, so that default points at
// `<webroot>/public` — a directory that does not exist. Measured on the assembled 0.3.0 tree:
//   startServer({port,host,quiet})            → /index.html 404, /js/main.js 404, /css/* 404
//   startServer({..., publicDir: webroot})    → all 200
// The WebView interceptor hides most of that for the phone's own page (it answers from the local
// tree), but anything Node is the only source for breaks: /studio, and every other client that
// reaches the phone host over LAN / ZeroTier (those requests are NOT intercepted).
//
// The entry cannot be imported here (it calls main() at module load and would process.exit), so the
// gate is a static assertion on the shipped source plus the path arithmetic it performs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, 'extras', 'server', 'android-main.mjs');
const src = fs.readFileSync(SRC, 'utf8');

test('android-main.mjs derives the webroot from the upstream entry path', () => {
  assert.match(
    src,
    /const webroot = path\.dirname\(path\.dirname\(upstream\)\)/,
    'android-main.mjs must derive the webroot as the parent of server/ (upstreamEntry = <webroot>/server/index.js)',
  );
});

test('android-main.mjs passes publicDir into startServer()', () => {
  const at = src.indexOf('await startServer(');
  assert.ok(at > 0, 'startServer() call not found');
  // take the object literal that follows (balanced braces, no nesting tricks needed here)
  const open = src.indexOf('{', at);
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { close = i; break; } }
  }
  assert.ok(close > open, 'unterminated startServer() options object');
  const opts = src.slice(open, close + 1);
  assert.match(opts, /publicDir\s*:\s*webroot/, 'startServer() must receive publicDir: webroot — '
    + 'without it serveDirs() falls back to ROOT/public, which does not exist in the flattened APK tree');
});

test('the webroot arithmetic matches the shipped layout', () => {
  // <webroot>/server/index.js  →  <webroot>
  const upstream = path.join(path.sep + 'files', 'webroot', 'server', 'index.js');
  assert.equal(path.dirname(path.dirname(upstream)), path.join(path.sep + 'files', 'webroot'));
});
