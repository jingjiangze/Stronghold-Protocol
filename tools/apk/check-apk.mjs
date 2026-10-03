#!/usr/bin/env node
// tools/apk/check-apk.mjs — post-build gate (ported idea from Fuhua-code's check-apk, simplified for the
// Gradle pipeline): signature verifies, every ABI carries the full Termux runtime set, and the embedded
// webroot has its critical files. Fails the build on any problem.
//
//   node tools/apk/check-apk.mjs [--apk <path>] [--bt <build-tools dir>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const APK = arg('--apk') || path.join(repo, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const BT = arg('--bt') || process.env.SP_BUILD_TOOLS || findBuildTools();

const ABIS = ['arm64-v8a', 'x86_64'];
const RUNTIME = ['libnode.so', 'libc++_shared.so', 'libcares.so', 'libcrypto.so', 'libicudata.so',
  'libicui18n.so', 'libicuuc.so', 'libsqlite3.so', 'libssl.so', 'libz.so'];
const CRITICAL_ASSETS = ['assets/webroot/index.html', 'assets/webroot/data/assets.json', 'assets/webroot/server/index.js'];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

function findBuildTools() {
  const root = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || 'C:/Users/16891/android-build/sdk';
  const dir = path.join(root, 'build-tools');
  if (!fs.existsSync(dir)) return '';
  const versions = fs.readdirSync(dir).sort();
  return versions.length ? path.join(dir, versions[versions.length - 1]) : '';
}

function fail(msg) {
  console.error(`check-apk: ${msg}`);
  process.exit(1);
}

// 1) signature
if (!BT) fail('build-tools not found (pass --bt or set ANDROID_HOME)');
const apksigner = path.join(BT, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
execFileSync(apksigner, ['verify', '--print-certs', APK], {
  stdio: 'pipe',
  env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME },
  shell: process.platform === 'win32', // Node 18+ on Windows refuses to spawn .bat without a shell
});
console.log('check-apk: signature verifies');

// 2) entries
const listing = listEntries(APK);
for (const abi of ABIS) {
  const missing = RUNTIME.filter((lib) => !listing.has(`lib/${abi}/${lib}`));
  if (missing.length) fail(`${abi}: missing runtime files: ${missing.join(', ')}`);
  console.log(`check-apk: ${abi}: full runtime present (${RUNTIME.length} files)`);
}
for (const a of CRITICAL_ASSETS) {
  if (!listing.has(a)) fail(`missing embedded asset: ${a}`);
}
console.log('check-apk: critical webroot assets present');

// 3) shell wiring: the DataChannel config key injected into index.html must be the one dc-bridge reads,
// otherwise the join-by-code P2P fallback is silently dead in the shell (see 审计方案-三端.md B1).
const webroot = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot');
const indexHtml = fs.readFileSync(path.join(webroot, 'index.html'), 'utf-8');
const dcBridge = fs.readFileSync(path.join(webroot, 'js', 'dc-bridge.js'), 'utf-8');
if (!indexHtml.includes('__SP_DC_INPUT')) fail('index.html does not inject __SP_DC_INPUT (DC fallback would be dead)');
if (!dcBridge.includes('__SP_DC_INPUT')) fail('dc-bridge.js does not read __SP_DC_INPUT (DC fallback would be dead)');
console.log('check-apk: shell DC wiring consistent');

// 4) slim-package assertions (v2.5): stamp reaches the APK (aapt drops dotfiles — the old ".stamp"
// never shipped, which is why every launch re-materialised), and the heavy client/test dependencies
// must stay out of node_modules (the host runtime needs {ws, werift} only — 131 MB → ~30 MB).
if (!fs.existsSync(path.join(webroot, 'stamp.txt'))) fail('build artifact lacks stamp.txt (run build-webroot)');
if (![...listing].some((e) => e === 'assets/webroot/stamp.txt')) {
  fail('assets/webroot/stamp.txt missing from the APK (aapt dotfile/stamp regression: cold-start skip would be dead)');
}
console.log('check-apk: slim stamp present in APK');
// mediabunny is intentionally allowed: it is a werift runtime dependency (media handling), not
// client/test tooling — the slim tree lands at ~26 MB with it.
for (const heavy of ['pixi.js', 'three', '@pixi-spine', 'puppeteer-core', 'chromium-bidi']) {
  const prefix = `assets/webroot/node_modules/${heavy}/`;
  if ([...listing].some((e) => e.startsWith(prefix))) {
    fail(`heavy dependency present in the slim tree: node_modules/${heavy} (host runtime needs only ws, werift)`);
  }
}
console.log('check-apk: node_modules trimmed to host runtime deps');

// 5) manifests must carry the CDN base — the shell interceptor resolves these URLs against the
// embedded tree (APK clients stay local) while browsers fetch them from R2/weishucdn.
const assetsManifest = readEntry(APK, 'assets/webroot/data/assets.json');
if (!assetsManifest.includes('weishucdn.jiangjiangze.icu/assets/')) {
  fail('data/assets.json is not CDN-prefixed (build-webroot transform missing)');
}
console.log('check-apk: manifests point at the CDN base');

const size = fs.statSync(APK).size;
console.log(`check-apk: OK — ${(size / 1024 / 1024).toFixed(0)} MB @ ${APK}`);

/** Reads one entry out of the APK (bsdtar on Windows, unzip on POSIX). */
function readEntry(apk, entry) {
  if (process.platform === 'win32') {
    return execFileSync('C:/Windows/System32/tar.exe', ['-xOf', apk, entry], {
      encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
    });
  }
  return execFileSync('unzip', ['-p', apk, entry], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

function listEntries(apk) {
  const out = process.platform === 'win32'
    ? execFileSync('C:/Windows/System32/tar.exe', ['-tf', apk], { encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024 })
    : execFileSync('unzip', ['-l', apk], { encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024 });
  const set = new Set();
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (process.platform === 'win32') set.add(t);
    else {
      const m = /^\s*\d+\s+\S+\s+\S+\s+(.+)$/.exec(line);
      if (m && m[1] !== 'Name') set.add(m[1].trim());
    }
  }
  return set;
}
