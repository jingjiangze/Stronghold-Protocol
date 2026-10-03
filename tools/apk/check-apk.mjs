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

const size = fs.statSync(APK).size;
console.log(`check-apk: OK — ${(size / 1024 / 1024).toFixed(0)} MB @ ${APK}`);

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
