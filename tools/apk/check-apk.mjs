#!/usr/bin/env node
// tools/apk/check-apk.mjs — post-build gate (ported idea from Fuhua-code's check-apk, simplified for the
// Gradle pipeline): signature verifies, every ABI carries the full Termux runtime set, and the embedded
// webroot has its critical files. Fails the build on any problem.
//
//   node tools/apk/check-apk.mjs [--apk <path>] [--bt <build-tools dir>]
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalBytes } from './canonical.mjs';
import { verify as edVerify } from './ed25519.mjs';
import { ASSETS_BASE, SERVERS_URL } from './line.mjs';

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
if (!assetsManifest.includes(ASSETS_BASE)) {
  fail(`data/assets.json is not prefixed with this line's CDN base (${ASSETS_BASE}) — build-webroot transform missing or pointing at the other line's tree`);
}
console.log('check-apk: manifests point at the CDN base');

// 6) signed shell assets. The pinned public key, the signed server list and the manifest
// baseline must ship inside the APK and must actually verify — a broken signature silently
// disables the entire server-list / hot-update trust chain on device.
const shellDir = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'shell');
const pubPath = path.join(shellDir, 'pubkey.bin');
if (!fs.existsSync(pubPath)) fail('assets/shell/pubkey.bin missing (signed lists could never verify)');
const pub = fs.readFileSync(pubPath);
if (pub.length !== 32) fail(`shell/pubkey.bin must be a raw 32-byte Ed25519 key (got ${pub.length})`);
for (const a of ['assets/shell/pubkey.bin', 'assets/shell/servers.json', 'assets/shell/manifest.json']) {
  if (!listing.has(a)) fail(`missing embedded asset: ${a}`);
}
function verifyDoc(doc) {
  return typeof doc?.sig === 'string'
    && edVerify(canonicalBytes(doc), Buffer.from(doc.sig, 'base64'), pub);
}
const serversDoc = JSON.parse(fs.readFileSync(path.join(shellDir, 'servers.json'), 'utf8'));
if (!verifyDoc(serversDoc)) fail('assets/shell/servers.json fails Ed25519 verification against pubkey.bin');
if (!Array.isArray(serversDoc.servers) || !serversDoc.servers.length) fail('embedded server list is empty');
const manifestDoc = JSON.parse(fs.readFileSync(path.join(shellDir, 'manifest.json'), 'utf8'));
if (!verifyDoc(manifestDoc)) fail('assets/shell/manifest.json fails Ed25519 verification against pubkey.bin');
if (!manifestDoc.buildTag) fail('embedded manifest has no buildTag');
// the manifest's servers pointer must be THIS line's signed endpoint — an http(s) JSON URL on one
// of our own hosts, never the other line's copy and never a site's HTML page. The expected value
// comes from line.mjs, so a baseline regenerated by gen-manifest (which writes Line.SERVERS_URL)
// passes instead of failing the build.
if (manifestDoc.servers?.url !== SERVERS_URL) {
  fail(`manifest.servers.url must be ${SERVERS_URL} (got ${manifestDoc.servers?.url})`);
}
console.log('check-apk: signed shell assets verify');

// 7) the on-device hot updater replays extras + patches from assets — without them an update
// would drop the bridge scripts and the DC wiring (the regression the plan calls out).
if (!listing.has('assets/shell/extras/public/js/shell-bridge.js')) {
  fail('assets/shell/extras/public/js/shell-bridge.js missing (hot update would drop the bridge)');
}
const patchCount = [...listing].filter((e) => e.startsWith('assets/shell/patches/') && e.endsWith('.json')).length;
if (patchCount === 0) fail('assets/shell/patches/*.json missing (hot update would drop settings/dc patches)');
console.log(`check-apk: hot-update overlay present (${patchCount} patches)`);

// 7b) the overlay loading point (v2.8.0): the loader must ship in the APK (webroot + assets/shell)
// and the Android entry must call it — otherwise slim-delivered overlays would never start.
if (!listing.has('assets/webroot/server/overlay-loader.mjs')) {
  fail('assets/webroot/server/overlay-loader.mjs missing (overlay loading point not built)');
}
if (!listing.has('assets/shell/extras/server/overlay-loader.mjs')) {
  fail('assets/shell/extras/server/overlay-loader.mjs missing (hot update would drop the overlay loader)');
}
const androidMainPath = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot', 'server', 'android-main.mjs');
if (!fs.existsSync(androidMainPath) || !fs.readFileSync(androidMainPath, 'utf-8').includes('loadOverlays')) {
  fail('android-main.mjs does not call loadOverlays (slim-delivered overlays would never start)');
}
console.log('check-apk: overlay loading point wired (loader shipped + android-main hook)');

// 7c) content-pack shell overlay baseline (v2.8.x): Updater reads this integer to decide whether a
// slim-carried shell-ui/ snapshot (extras+patches, signed via the manifest's slim.sha256) is newer
// than the APK's own overlay. Absent on device = 0 (old behavior), so this gate keeps a silent
// baseline regression from shipping without disabling the channel.
if (!listing.has('assets/shell/shell-ui-version.txt')) {
  fail('assets/shell/shell-ui-version.txt missing (slim-overlay baseline could never be read)');
}
if (!/^\d+\s*$/.test(readEntry(APK, 'assets/shell/shell-ui-version.txt'))) {
  fail('assets/shell/shell-ui-version.txt is not a non-negative integer');
}
console.log('check-apk: shell-ui baseline version present');

// 8) P0-2 injection + the pure-Java verifier must be in the source; the third-party consent gate
// must be GONE (v2.7.7: local misses go straight to the current server, no disclaimer dialog)
const shellSrc = path.join(repo, 'android', 'app', 'src', 'main', 'java', 'icu', 'jiangjiangze', 'stronghold');
const mainActivity = fs.readFileSync(path.join(shellSrc, 'MainActivity.java'), 'utf-8');
if (!mainActivity.includes('injectShellHtml')) fail('MainActivity lacks the P0-2 HTML injection');
if (mainActivity.includes('requestConsent')) fail('MainActivity still contains the third-party consent gate (removed in v2.7.7)');
if (!fs.existsSync(path.join(shellSrc, 'Ed25519.java'))) fail('Ed25519.java missing (signed lists could not verify on API 26)');
if (!fs.existsSync(path.join(shellSrc, 'ServerList.java'))) fail('ServerList.java missing');
console.log('check-apk: P0-2 injection + Ed25519 verifier present; consent gate removed (v2.7.7)');

// 9) server-list freshness + advisor verdict (审计 §2). Three independent checks:
//   (a) manifest.servers.sha256 must describe the servers.json that ACTUALLY ships in assets —
//       gen-manifest used to hash tools/apk/shell/servers.json while build-webroot baked a
//       different copy, so the signed sha silently described a file the APK never contained;
//   (b) the baked list must not be stale (its ISO `updated` stamp within SERVERS_FRESH_DAYS);
//   (c) the baked list must not carry an advisor-invalidated entry (status invalid/pending). The
//       signed servers.json has no status field today, so this is skipped-with-a-note until the
//       publisher starts baking the verdict in.
const SERVERS_FRESH_DAYS = 7; // freshness ceiling for the baked baseline (ISO `updated` stamp)
const sha256Buf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const bakedServersBytes = fs.readFileSync(path.join(shellDir, 'servers.json'));
const bakedSha = sha256Buf(bakedServersBytes);
// (a) is a WARNING, not a gate: the CI build re-fetches the live list, so the baked bytes change
// every time the publisher updates servers.json while the committed manifest keeps the hash of the
// build that signed it. As an error this turned CI red on every list update (run 37200402900) and
// skipped the release/R2 steps behind it. The drift it was meant to catch — gen-manifest hashing a
// different file than build-webroot bakes — is now prevented inside gen-manifest itself, which
// prints `servers hash source:` and prefers the baked copy.
if (manifestDoc.servers?.sha256 !== bakedSha) {
  console.warn(
    `check-apk: manifest.servers.sha256 (${manifestDoc.servers?.sha256}) != sha256(assets/shell/servers.json) (${bakedSha})`
      + ' — expected after a live list update; re-run gen-manifest before publishing.',
  );
} else {
  console.log('check-apk: manifest.servers.sha256 matches the baked servers.json');
}
const serversUpdatedMs = Date.parse(serversDoc.updated || '');
if (Number.isFinite(serversUpdatedMs)) {
  const ageDays = (Date.now() - serversUpdatedMs) / 86400000;
  if (ageDays > SERVERS_FRESH_DAYS) {
    fail(`embedded servers.json is stale: updated ${serversDoc.updated} (${ageDays.toFixed(1)} days > ${SERVERS_FRESH_DAYS})`);
  }
  console.log(`check-apk: embedded servers.json is fresh (${ageDays.toFixed(1)} days ≤ ${SERVERS_FRESH_DAYS})`);
} else {
  console.warn(`check-apk: servers.json has no parseable updated stamp (${JSON.stringify(serversDoc.updated)}) — freshness skipped`);
}
const annotated = (serversDoc.servers || []).filter((s) => typeof s?.status === 'string' && s.status !== '');
if (!annotated.length) {
  console.warn('check-apk: embedded servers.json carries no per-entry status — invalid/pending gate skipped');
} else {
  const bad = annotated.filter((s) => s.status === 'invalid' || s.status === 'pending');
  if (bad.length) {
    fail(`embedded servers.json contains unavailable entries: ${bad.map((s) => `${s.id}=${s.status}`).join(', ')}`);
  }
  console.log(`check-apk: embedded servers.json has no invalid/pending entries (${annotated.length} annotated)`);
}

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
