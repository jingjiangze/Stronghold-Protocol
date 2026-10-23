#!/usr/bin/env node
// check-webroot-overlays.mjs — the assembled webroot must carry EVERY overlay the source tree has,
// byte for byte.
//
// WHY (2026-10-23 真机报障「点 MOD 管理器没有页面」): `android/app/src/main/assets/webroot/` is a
// BUILD PRODUCT and gitignored, so `git status` stays clean while it silently rots. The device's
// tree was missing `server/overlay/sp-modmgr.mjs` entirely (and carried stale sp-lobby / sp-mods) —
// `overlay-loader` only readdir()s that one directory, so a missing module is not even logged as
// "skipped": the route simply has no answer and `/mod` comes back blank. Nothing in CI noticed.
//
//   node tools/apk/check-webroot-overlays.mjs [--webroot <dir>] [--src <dir>]
//
// Exit 1 on: a missing overlay, an extra one, or any byte difference.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const srcDir = path.resolve(arg('--src', path.join(here, 'overlay')));
const webroot = path.resolve(arg('--webroot', path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot')));
const dstDir = path.join(webroot, 'server', 'overlay');

const mods = (dir) => {
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.mjs')).sort(); } catch { return []; }
};

const src = mods(srcDir);
const dst = mods(dstDir);
if (!src.length) {
  console.error(`WEBROOT-OVERLAY FAIL: no overlay modules in ${srcDir} — wrong --src?`);
  process.exit(1);
}

const problems = [];
for (const n of src) {
  const a = path.join(srcDir, n);
  const b = path.join(dstDir, n);
  if (!fs.existsSync(b)) {
    problems.push(`missing in webroot: server/overlay/${n} — its routes would have no answer`);
    continue;
  }
  if (!fs.readFileSync(a).equals(fs.readFileSync(b))) {
    problems.push(`stale in webroot: server/overlay/${n} differs from tools/apk/overlay/${n}`);
  }
}
for (const n of dst) if (!src.includes(n)) problems.push(`unexpected in webroot: server/overlay/${n} (not in the source tree)`);

if (problems.length) {
  console.error('WEBROOT-OVERLAY FAIL — run `node tools/apk/build-webroot.mjs` to refresh the tree:');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`webroot overlays: ${src.length} module(s), byte-identical to the source tree (${path.relative(repo, dstDir)})`);
