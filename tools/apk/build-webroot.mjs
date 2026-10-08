#!/usr/bin/env node
// Builds the APK's embedded webroot from an upstream integration zip:
//
//   node tools/apk/build-webroot.mjs [--zip <path|url>] [--tag vX.Y.Z] [--no-assets]
//
// Pipeline: fetch upstream zip → extract → copy the shell-relevant subset →
// copy tools/apk/extras (shell-owned files: dc-bridge.js, webrtc-bridge.mjs) →
// apply tools/apk/patches/*.json (settings, font scale, side pad, /_shell/rooms,
// dc-bridge import) → npm install werift (host-side WebRTC bridge, pure JS) →
// rewrite manifests to the CDN base → PNG → WebP transcode + manifest sync + manifest/disk gate
// (tools/apk/transcode-assets.mjs, off with --no-webp / SP_NO_WEBP=1).
// A missing patch anchor fails the build loudly — patches are data, never silent.
//
// --no-assets (or SP_NO_ASSETS=1): DO NOT copy the upstream `public/assets/**` tree (~410 MB) into
// the APK. The asset manifests (data/assets.json, data/local-assets.json) are still copied and still
// rewritten to the CDN prefix — the paths are NOT rewritten away from the CDN just because the bytes
// are gone. PREREQUISITE (semantic contract): every /assets/** the page asks for must be reachable
// from the CDN base (Line.ASSETS_CDN_PREFIX, i.e. <CDN>/assets-re/). On device, MainActivity resolves
// the local tree (filesDir) and the APK first, and on a miss re-fetches the same relative path from
// that CDN base, caches it under filesDir/art/cache/<manifest hash>/ (inside ArtStore's art root), and serves it SAME-ORIGIN
// (cross-origin images taint the canvas — see 方案-静态资源热更新-2026-10-08.md §6.3). Without a
// reachable CDN, a first launch shows missing art. The PNG→WebP bytes are NOT produced (nothing is
// embedded), but the conversion PLAN is still computed from the UPSTREAM source tree and the
// manifests are rewritten to the same .webp refs a full build bakes (planOnlyTranscode) — otherwise
// the WebP CDN tree would 404 every converted file. stamp.txt / slim-manifest.txt are unaffected
// because the slim top-level set excludes `assets` by construction (tools/apk/slim-top.mjs).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformManifestsDir } from './transform-assets.mjs';
import { transcodeAssets, planOnlyTranscode, webpEnabled } from './transcode-assets.mjs';
import { canonicalBytes } from './canonical.mjs';
import { verify as edVerify } from './ed25519.mjs';
import { ASSETS_DIR, CDN, SERVERS_URL } from './line.mjs';
import { deriveSlimTop } from './slim-top.mjs';

const UPSTREAM_API = 'https://api.github.com/repos/sganggs/Stronghold-Protocol/releases/latest';
const MIRROR_PREFIX = 'https://gh-proxy.com/';
/** CDN base the APK-embedded manifests point at (browser clients fetch heavy assets from here). */
const CDN_BASE = process.env.SP_CDN_BASE || CDN;
// The slim set the on-device host service materialises (assets stay APK-local / CDN — never copied).
// DERIVED from the assembled tree (tools/apk/slim-top.mjs): a fixed whitelist silently dropped a new
// upstream top-level dir, and the hot update replaces the whole tree, so it was lost permanently
// (审计 §6.2 / R-04). Call sites compute it with deriveSlimTop(outDir) just before use.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const outDir = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot');
const patchesDir = path.join(here, 'patches');
const extrasDir = path.join(here, 'extras');

async function main() {
  // --no-assets / SP_NO_ASSETS=1: keep the asset manifests but ship no `assets/**` bytes (see header).
  const noAssets = noAssetsRequested();
  if (noAssets) console.log('no-assets: the ~410 MB assets tree will NOT be embedded (CDN is the only art source)');
  // --reuse: keep the assembled webroot and only re-apply the shell's own overlays (extras +
  // signed assets). Patches are skipped because they were already applied to this tree.
  if (process.argv.includes('--reuse')) {
    if (!fs.existsSync(path.join(outDir, 'index.html'))) throw new Error(`no webroot to reuse at ${outDir}`);
    console.log(`reusing webroot: ${outDir}`);
    copyExtras();
    copyOverlays();
    await copyShellAssets();
    // the tree was transcoded on the build that assembled it; re-running is cheap (0 conversions)
    // and both picks up PNGs an overlay may have added and re-asserts the manifest/disk gate.
    // A --no-assets tree has no assets/ at all, so the transcode (and its disk gate) must be skipped.
    if (hasAssetsTree(outDir)) {
      await transcodeAssets({ webrootDir: outDir });
    } else {
      console.log('transcode: skipped (no assets tree in the reused webroot — --no-assets build)');
    }
    // content just changed (extras/patches) → the stamp must change too, or devices that already
    // materialised the old tree would keep serving it (the stamp is what skips re-materialising)
    const slimTop = deriveSlimTop(outDir);
    const stamp = contentStamp(outDir, slimTop);
    fs.writeFileSync(path.join(outDir, 'stamp.txt'), stamp + '\n');
    fs.writeFileSync(path.join(outDir, 'slim-manifest.txt'), slimTop.join('\n') + '\nstamp.txt\n');
    console.log(`webroot stamp: ${stamp}`);
    console.log(`slim set (${slimTop.length}): ${slimTop.join(' ')}`);
    console.log('reuse complete (patches left as-is)');
    return;
  }
  const argZip = process.argv.indexOf('--zip');
  let zipPath = argZip > 0 ? process.argv[argZip + 1] : null;
  let tag = argvValue('--tag');
  if (!zipPath) {
    const rel = await latestRelease();
    tag = tag ?? rel.tag;
    zipPath = path.resolve(repo, '..', 'dl-cache', `upstream-${rel.tag}.zip`);
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    const want = Number(rel.size) || 0; // API 报的资产字节数（0 = 未知，退回宽松阈值）
    const complete = (f) => {
      try {
        const n = fs.statSync(f).size;
        if (want > 0) return n === want;
        return n > 100_000_000;
      } catch (e) { return false; }
    };
    if (!complete(zipPath)) {
      // 下载源顺序（业主 2026-10-07）：本地缓存（上面已判）→ **我们的 R2 镜像** → gh-proxy 镜像 → GitHub 直连。
      // 直连在大陆线路上只有几十 KB/s（428MB 要几小时），镜像/R2 是 1.5MB/s 级；每个源下载完都要过
      // 「>100MB 才算完整包」的校验，不合格就换下一个（防再次抓到 lite/update）。
      const name = path.basename(new URL(rel.zipUrl).pathname);
      const sources = [
        `${CDN_BASE}/upstream/${name}`,
        MIRROR_PREFIX + rel.zipUrl,
        rel.zipUrl,
      ];
      let ok = false;
      for (const src of sources) {
        try {
          await download(src, zipPath);
          if (complete(zipPath)) {
            ok = true;
            console.log(`upstream package downloaded from: ${src} (${fs.statSync(zipPath).size} bytes)`);
            break;
          }
          const got = (() => { try { return fs.statSync(zipPath).size; } catch (e) { return -1; } })();
          console.warn(`incomplete download (${got}/${want || '>100MB'} bytes) from ${src} — trying the next source`);
        } catch (e) {
          console.warn(`download failed (${e.message}) — trying the next source`);
        }
      }
      if (!ok) throw new Error('could not fetch the upstream full package from any source (cache/R2/gh-proxy/direct)');
    }
  }
  console.log(`upstream zip: ${zipPath} (tag ${tag ?? 'unknown'})`);

  const staging = path.resolve(repo, '..', 'dl-cache', 'upstream-extracted');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const zip = path.resolve(zipPath);
  if (process.platform === 'win32') execFileSync('C:/Windows/System32/tar.exe', ['-xf', zip, '-C', staging]);
  else execFileSync('unzip', ['-q', zip, '-d', staging]);

  const [srcRoot] = fs.readdirSync(staging).filter((n) => fs.statSync(path.join(staging, n)).isDirectory());
  const src = path.join(staging, srcRoot);
  if (!fs.existsSync(path.join(src, 'server', 'index.js'))) throw new Error(`unexpected zip layout under ${src}`);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const name of fs.readdirSync(path.join(src, 'public'))) {
    if (name === 'dev') continue;
    // --no-assets: the heavy `assets/**` tree stays out of the APK entirely (never copied, so the
    // build also never pays the ~410 MB copy). Everything else (index.html/js/css/…) is unchanged.
    if (noAssets && name === 'assets') {
      console.log('no-assets: skipped public/assets (the CDN is the only art source)');
      continue;
    }
    fs.cpSync(path.join(src, 'public', name), path.join(outDir, name), { recursive: true });
  }
  // node_modules is NOT copied from upstream (131 MB with pixi/three/puppeteer blowup).
  // The host runtime needs only {ws, werift} — installed below from a temporary manifest.
  for (const dir of ['data', 'shared', 'server']) {
    fs.cpSync(path.join(src, dir), path.join(outDir, dir), { recursive: true });
  }
  fs.copyFileSync(path.join(src, 'package.json'), path.join(outDir, 'package.json'));
  fs.cpSync(path.join(src, 'server', 'sim'), path.join(outDir, 'sim'), { recursive: true });

  fs.writeFileSync(path.join(outDir, 'data.js'), `// Generated by server/index.js — browser stand-in for server/data.js (DESIGN §14 client-side combat).
// The simulation's content modules (/sim/content/support/index.js) import getData() from here; it returns the game data
// the page injected with /sim/simdata.js setSimData(data).
import { getSimData } from './sim/simdata.js';
export function getData() { return getSimData() || {}; }
export function resetData() {}
`);

  // shell-owned extras (over-write whatever upstream shipped at those paths)
  copyExtras();

  // shell server overlays (v2.8.0): additive server/overlay/*.mjs
  copyOverlays();

  // shell patches (settings, dc-bridge wiring, /_shell/rooms)
  applyPatches(outDir);

  // Host runtime dependencies only: install {ws, werift} from a temporary manifest so the
  // client-side libraries (pixi.js/three/@pixi-spine) and test tooling (puppeteer-core) never
  // enter the tree. The upstream package.json (type:module etc.) is restored afterwards —
  // the server reads it at boot.
  console.log('installing host runtime deps (ws, werift)…');
  const upstreamPkg = fs.readFileSync(path.join(outDir, 'package.json'), 'utf-8');
  fs.writeFileSync(path.join(outDir, 'package.json'),
    JSON.stringify({ name: 'stronghold-host-runtime', private: true, dependencies: { ws: '^8', werift: '*' } }, null, 1));
  fs.rmSync(path.join(outDir, 'node_modules'), { recursive: true, force: true });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: outDir, stdio: 'inherit', shell: process.platform === 'win32' });
  fs.writeFileSync(path.join(outDir, 'package.json'), upstreamPkg);
  fs.rmSync(path.join(outDir, 'package-lock.json'), { force: true });

  // the main repo (sganggs/Stronghold-Protocol) is the single source of truth for game code AND assets:
  // fail loudly if its manifest looks truncated, instead of silently shipping a thinner asset tree
  // (this is exactly the gap Fuhua-code's mobile-termux branch shipped: 29 audio files / 1.67 MB short).
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'data', 'assets.json'), 'utf-8'));
  const manifestFiles = manifest?.stats?.files ?? 0;
  if (manifestFiles < 3900) {
    throw new Error(`data/assets.json looks truncated (stats.files=${manifestFiles}); expected the main-repo manifest`);
  }
  console.log(`assets manifest: ${manifestFiles} files (main repo sganggs/Stronghold-Protocol)`);

  // Manifest URLs → CDN base: BROWSER clients joining a room fetch heavy assets from R2/weishucdn.
  // APK clients stay fully local: the shell interceptor resolves these CDN URLs against the embedded
  // tree (MainActivity's CDN branch), so they never touch the network either.
  const manifestCounts = transformManifestsDir(path.join(outDir, 'data'), CDN_BASE, ASSETS_DIR);
  console.log(`manifests → ${CDN_BASE}/${ASSETS_DIR}: ${JSON.stringify(manifestCounts)}`);

  // PNG → WebP (in place, so make-cdn's whole-tree copy of webroot/assets ships WebP too).
  // Runs AFTER transform-assets (the manifests are upstream-generated — the sync must see the
  // final URL form) and on EVERY build, for the same reason. Only standalone PNGs convert:
  // spine atlas pages are name-derived by the client (js/assets.js spinePages() maps the .skel
  // path to .png) and must keep their names; a WebP that is not smaller keeps its PNG.
  // Disable with --no-webp / SP_NO_WEBP=1. The step also gates: every /assets/** ref in the
  // manifests must exist on disk, else the build fails here.
  // A --no-assets build has no assets/ tree at all: the transcode (and its manifest/disk gate,
  // which would fail on every /assets/** ref) is skipped instead of erroring out. But the manifests
  // MUST still carry the same .webp refs a full build bakes, or the (WebP) CDN tree 404s ~4000
  // files — so run the SAME conversion plan against the UPSTREAM source tree and rewrite the
  // manifests only (no bytes copied, nothing encoded into the webroot).
  if (hasAssetsTree(outDir)) {
    await transcodeAssets({ webrootDir: outDir });
  } else if (noAssets && webpEnabled()) {
    await planOnlyTranscode({
      sourceAssetsDir: path.join(src, 'public', 'assets'),
      dataDir: path.join(outDir, 'data'),
    });
  } else {
    console.log('transcode: skipped (no assets tree — --no-assets / SP_NO_ASSETS=1)');
  }

  // Version stamp (non-dot name: aapt drops dotfiles under assets/ — the old ".stamp" never made
  // it into any APK, which is why every launch looked like a cold start). Hash covers the SLIM set
  // only, because only the slim set is ever materialised to filesDir. The set is DERIVED from the
  // tree, so an upstream top-level dir added later still rides the slim (audit §6.2 / R-04).
  const slimTop = deriveSlimTop(outDir);
  const stamp = contentStamp(outDir, slimTop);
  fs.writeFileSync(path.join(outDir, 'stamp.txt'), stamp + '\n');
  fs.writeFileSync(path.join(outDir, 'slim-manifest.txt'), slimTop.join('\n') + '\nstamp.txt\n');
  console.log(`webroot stamp: ${stamp}`);
  console.log(`slim set (${slimTop.length}): ${slimTop.join(' ')}`);

  const size = dirSize(outDir);
  console.log(`webroot ready: ${outDir} (${(size / 1024 / 1024).toFixed(0)} MB)`);

  await copyShellAssets();
}

/**
 * Bakes the shell's own signed assets next to the webroot: the pinned public key, the signed
 * server list and manifest baseline, plus the extras/patches the on-device hot updater replays.
 * The live server list is preferred when it verifies; otherwise the checked-in snapshot is used.
 */
async function copyShellAssets() {
  const shellSrc = path.join(here, 'shell');
  const shellOut = path.join(path.dirname(outDir), 'shell');
  fs.rmSync(shellOut, { recursive: true, force: true });
  fs.mkdirSync(shellOut, { recursive: true });

  const pubFile = path.join(shellSrc, 'pubkey.bin');
  if (!fs.existsSync(pubFile)) throw new Error(`missing ${pubFile} (pinned Ed25519 public key)`);
  fs.copyFileSync(pubFile, path.join(shellOut, 'pubkey.bin'));
  const pub = fs.readFileSync(pubFile);

  const manifestFile = path.join(shellSrc, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    // first build on a clean machine: gen-manifest.mjs runs after make-bundle.mjs and writes it
    console.warn('shell: manifest.json absent — run make-bundle.mjs then gen-manifest.mjs, then rebuild');
  } else {
    if (!verifyDoc(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), pub)) {
      throw new Error('shell/manifest.json fails signature verification against shell/pubkey.bin');
    }
    fs.copyFileSync(manifestFile, path.join(shellOut, 'manifest.json'));
  }

  let listText = null;
  let listSource = 'checked-in snapshot';
  for (const url of [SERVERS_URL,
                     'https://weishucdn.jiangjiangze.icu/site/servers.json',
                     'https://dl.jiangjiangze.icu/data/servers.json']) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        console.warn(`shell: ${url} HTTP ${res.status} — skipped`);
        continue;
      }
      const body = await res.text();
      let doc;
      try {
        doc = JSON.parse(body);
      } catch (e) {
        // never swallow: the bare root once served the HTML site, and a silent JSON.parse failure
        // made the build quietly bake a stale checked-in snapshot instead (审计 §2).
        console.warn(`shell: ${url} is not JSON (${e.message}) — skipped`);
        continue;
      }
      if (verifyDoc(doc, pub)) {
        listText = body;
        listSource = url;
        break;
      }
      console.warn(`shell: ${url} failed signature verification — skipped`);
    } catch (e) {
      // offline or unreachable: fall back to the checked-in snapshot (warn so drift is visible)
      console.warn(`shell: ${url} unreachable (${e.message}) — skipped`);
    }
  }
  if (listText === null) {
    const snap = path.join(shellSrc, 'servers.json');
    if (!verifyDoc(JSON.parse(fs.readFileSync(snap, 'utf8')), pub)) {
      throw new Error('shell/servers.json fails signature verification against shell/pubkey.bin');
    }
    listText = fs.readFileSync(snap, 'utf8');
  }
  fs.writeFileSync(path.join(shellOut, 'servers.json'), listText);
  // Single source of truth: mirror the exact bytes that were baked into assets back into
  // tools/apk/shell. gen-manifest then hashes this file, so manifest.servers.sha256 can no longer
  // describe an old copy while a different one ships in the APK (审计 §2).
  fs.writeFileSync(path.join(shellSrc, 'servers.json'), listText);
  console.log(`shell: servers.json ← ${listSource} (mirrored to tools/apk/shell/servers.json)`);

  // extras + patches travel with the APK so a hot update can re-apply the shell's own wiring
  copyTree(extrasDir ? path.join(extrasDir, 'public') : null, path.join(shellOut, 'extras', 'public'));
  copyTree(extrasDir ? path.join(extrasDir, 'server') : null, path.join(shellOut, 'extras', 'server'));
  copyTree(patchesDir, path.join(shellOut, 'patches'));
  console.log('shell: extras + patches bundled');

  // Device baseline for the content-pack shell overlay channel: the integer in
  // tools/apk/shell-ui-version.txt is burned next to extras/patches, so Updater can decide
  // "slim-carried shell-ui/ newer than the APK baseline?" (absent file on old APKs = 0).
  let shellUiVersion = 0;
  try {
    const m = /(\d+)/.exec(fs.readFileSync(path.join(here, 'shell-ui-version.txt'), 'utf-8'));
    if (m) shellUiVersion = Number(m[1]);
  } catch { /* no version file: baseline 0 */ }
  fs.writeFileSync(path.join(shellOut, 'shell-ui-version.txt'), shellUiVersion + '\n');
  console.log(`shell: shell-ui-version.txt = ${shellUiVersion} (content-pack overlay baseline)`);
}

/** Signature check over the canonical form (the `sig` field is excluded by canonicalBytes). */
function verifyDoc(doc, rawPub) {
  if (typeof doc?.sig !== 'string') return false;
  return edVerify(canonicalBytes(doc), Buffer.from(doc.sig, 'base64'), rawPub);
}

function copyTree(from, to) {
  if (!from || !fs.existsSync(from)) return;
  for (const p of walk(from)) {
    const dst = path.join(to, path.relative(from, p));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(p, dst);
  }
}

/** Content hash over (path, size) of the given top-level roots — stable for identical content. */
function contentStamp(dir, roots) {
  const h = crypto.createHash('sha256');
  const entries = [];
  const walkInto = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walkInto(p, r);
      else entries.push(`${r}:${fs.statSync(p).size}`);
    }
  };
  for (const root of roots) {
    const p = path.join(dir, root);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) walkInto(p, root);
    else entries.push(`${root}:${fs.statSync(p).size}`);
  }
  for (const line of entries) h.update(line).update('\n');
  return h.digest('hex').slice(0, 24);
}

/**
 * Shell server overlays (v2.8.0): server/overlay/*.mjs from tools/apk/overlay/.
 * Additive, hot-updatable files — the on-device loader (extras/server/overlay-loader.mjs)
 * imports them after startServer(); the same files ride the L1 slim via make-bundle.
 */
function copyOverlays() {
  const src = path.join(here, 'overlay');
  let mods = [];
  try { mods = fs.readdirSync(src).filter((n) => n.endsWith('.mjs')); } catch { return; }
  const dst = path.join(outDir, 'server', 'overlay');
  fs.rmSync(dst, { recursive: true, force: true });
  if (!mods.length) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const n of mods) fs.copyFileSync(path.join(src, n), path.join(dst, n));
  console.log(`overlay: ${mods.length} module(s) → server/overlay/`);
}

function copyExtras() {
  if (!fs.existsSync(extrasDir)) return;
  // extras/public/* mirrors the webroot ROOT (the interceptor serves /js/... from root);
  // extras/server/* mirrors webroot/server/*.
  const sides = [
    { from: path.join(extrasDir, 'public'), to: outDir, label: '' },
    { from: path.join(extrasDir, 'server'), to: path.join(outDir, 'server'), label: 'server/' },
  ];
  for (const side of sides) {
    if (!fs.existsSync(side.from)) continue;
    for (const p of walk(side.from)) {
      const rel = path.relative(side.from, p);
      const dst = path.join(side.to, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(p, dst);
      console.log(`extra: ${side.label}${rel.split(path.sep).join('/')}`);
    }
  }
}

function applyPatches(outDir) {
  // deterministic order: settings-v2.1 → settings-v2.2 (later patches build on earlier text)
  // Each patch entry may carry:
  //   minApp / maxApp — apply only when the tree's client version (shared/constants.js
  //                     APP_VERSION) is within the range (semver-ish string compare is NOT
  //                     used: dotted-numeric compare, e.g. "0.1.0" < "0.1.1").
  //   optional: true  — when the anchor is absent AND the target exists, skip instead of
  //                     throwing (an upstream build already carrying the change).
  const app = appVersionOf(outDir);
  for (const pf of fs.readdirSync(patchesDir).filter((n) => n.endsWith('.json')).sort()) {
    const spec = JSON.parse(fs.readFileSync(path.join(patchesDir, pf), 'utf-8'));
    for (const p of spec.patches) {
      if (p.minApp && cmpVer(app, p.minApp) < 0) { console.log(`skipped (${p.file}): tree app ${app} < minApp ${p.minApp}`); continue; }
      if (p.maxApp && cmpVer(app, p.maxApp) > 0) { console.log(`skipped (${p.file}): tree app ${app} > maxApp ${p.maxApp}`); continue; }
      const target = path.join(outDir, p.file);
      if (!fs.existsSync(target)) throw new Error(`patch target missing: ${p.file}`);
      // CRLF → LF: Windows checkouts / zips must match the LF anchors, and the shipped
      // tree stays LF no matter which platform ran the build.
      const text = fs.readFileSync(target, 'utf-8').replace(/\r\n/g, '\n');
      if (!text.includes(p.find)) {
        if (p.replace && text.includes(p.replace)) { console.log(`already applied: ${p.file}`); continue; }
        // shrink: the first non-blank anchor line exists but the full multi-line context
        // drifted (upstream reflowed the middle lines) — locate by that line only.
        if (p.shrink) {
          const first = p.find.split('\n').map((l) => l).find((l) => l.trim() !== '');
          if (first != null && text.includes(first)) {
            const lines = text.split('\n');
            const at = lines.findIndex((l) => l.includes(first));
            lines.splice(at, 1, text.includes(p.replace) ? lines[at] : p.replace);
            fs.writeFileSync(target, lines.join('\n'));
            console.log(`patched (shrink@line ${at + 1}): ${p.file}`);
            continue;
          }
        }
        if (p.optional) { console.log(`optional anchor absent (${p.file}): skipped`); continue; }
        throw new Error(`patch anchor not found in ${p.file}: ${JSON.stringify(p.find.slice(0, 80))}`);
      }
      fs.writeFileSync(target, text.split(p.find).join(p.replace));
      console.log(`patched: ${p.file}`);
    }
  }
}

/** APP_VERSION of the built tree (shared/constants.js), or null when unresolvable. */
function appVersionOf(outDir) {
  try {
    const t = fs.readFileSync(path.join(outDir, 'shared', 'constants.js'), 'utf-8');
    const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(t) || /APP_VERSION\s*=\s*"([^"]+)"/.exec(t);
    return m ? m[1] : null;
  } catch { return null; }
}

/** Dotted-numeric version compare: -1 / 0 / 1. Non-numeric segments compare as strings. */
function cmpVer(a, b) {
  if (a == null) return 0; // unknown → treat as matching any range
  const A = String(a).split('.'), B = String(b).split('.');
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? '0', y = B[i] ?? '0';
    const nx = Number(x), ny = Number(y);
    const c = (Number.isFinite(nx) && Number.isFinite(ny)) ? Math.sign(nx - ny) : (x < y ? -1 : x > y ? 1 : 0);
    if (c) return c;
  }
  return 0;
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function argvValue(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

async function latestRelease() {
  // SP_UPSTREAM_TAG pins a specific upstream release (the sync workflow passes the
  // newly detected tag); empty/absent = latest.
  const tag = (process.env.SP_UPSTREAM_TAG || '').trim();
  const api = tag
    ? `https://api.github.com/repos/sganggs/Stronghold-Protocol/releases/tags/${encodeURIComponent(tag)}`
    : UPSTREAM_API;
  const headers = { 'User-Agent': 'stronghold-shell' };
  // GITHUB_TOKEN is what Actions provides; GH_TOKEN is the local convention. Without one the
  // shared runner IP hits the unauthenticated rate limit and the build dies with HTTP 403.
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(api, { headers });
  if (!res.ok) throw new Error(`upstream API HTTP ${res.status}`);
  const json = await res.json();
  // 2026-10-07：v0.2.0 起上游 release 带**两个** zip —— `-lite`（~21MB，无美术）与完整包（~427MB）。
  // 构建要的是带美术的完整包；「取第一个 .zip」会抓到 lite（webroot/assets 缺失，构建当场失败）。
  const zips = (json.assets ?? []).filter((a) => a.name.toLowerCase().endsWith('.zip'));
  // v0.2.x 起一个 release 带多个 zip：`-lite`（~22MB 无美术）、`-update`（~2MB 增量）、完整包（~428MB）。
  // **取最大的那个**（= 带美术的完整包）；「取第一个」会抓到 lite/update，构建当场失败。
  const asset = zips.slice().sort((x, y) => (y.size || 0) - (x.size || 0))[0];
  if (!asset) throw new Error('upstream release has no usable zip asset');
  return { tag: json.tag_name, zipUrl: asset.browser_download_url, size: Number(asset.size) || 0 };
}

async function download(url, dest) {
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`saved ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

/**
 * --no-assets / SP_NO_ASSETS=1: embed the asset manifests but none of the `assets/**` bytes.
 * Pure (no fs / no process access) so it is unit-testable; see tools/apk/build-webroot.test.mjs.
 */
export function noAssetsRequested(argv = process.argv, env = process.env) {
  if (Array.isArray(argv) && argv.includes('--no-assets')) return true;
  const v = String(env && env.SP_NO_ASSETS != null ? env.SP_NO_ASSETS : '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** True when the assembled webroot carries an `assets/` directory (i.e. the transcode step can run). */
export function hasAssetsTree(webrootDir) {
  try {
    return fs.statSync(path.join(webrootDir, 'assets')).isDirectory();
  } catch {
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
