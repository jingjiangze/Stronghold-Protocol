#!/usr/bin/env node
// tools/apk/gen-manifest.mjs — builds and SIGNS the hot-update manifest (最终执行方案 §1.2).
//
//   node tools/apk/gen-manifest.mjs --tag shell-v2.6.0 [--upstream v0.1.0] [--min-apk 12]
//        [--slim <zip>] [--slim-url <url>] [--out <path>]
//
// The signature covers the canonical form of everything except `sig`, so the on-device verifier
// (Ed25519.java + CanonicalJson.java) can check it offline. Signing happens locally: the private
// key stays on this machine and CI only ever sees the signed result.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalBytes } from './canonical.mjs';
import { privateKeyFromSeed, rawPublicOf, sign as edSign } from './ed25519.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const KEY_DIR = process.env.SP_SIGN_DIR || path.join(process.env.USERPROFILE || process.env.HOME, '.sp-sign');

const ART_BASE = 'https://weishucdn.jiangjiangze.icu/assets/';
// dl.* is the Pages site: files live under /data/ (the bare root serves the HTML page)
const SERVERS_URL = 'https://dl.jiangjiangze.icu/data/servers.json';
const MIRRORS = ['ghfast', 'ghproxy', 'llkk', 'ghproxynet', 'r2', 'box'];
const KEY_ID = 'sp-2026-10';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** shell-ui/version.txt out of the slim zip (bsdtar on Windows, unzip on POSIX), or null when the
 *  bundle carries no shell-ui/ at all. A present-but-malformed file is a hard error — the manifest
 *  must never describe the overlay channel with a made-up version. */
function slimShellOverlayVersion(slim) {
  let body;
  try {
    body = process.platform === 'win32'
      ? execFileSync('C:/Windows/System32/tar.exe', ['-xOf', slim, 'shell-ui/version.txt'],
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      : execFileSync('unzip', ['-p', slim, 'shell-ui/version.txt'],
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null; // no such entry: the slim has no shell-ui/ (version 0 = channel off)
  }
  const m = /^\s*(\d+)\s*$/.exec(body);
  if (!m) {
    throw new Error(`slim carries shell-ui/version.txt but it is not a non-negative integer: ${JSON.stringify(body)}`);
  }
  return Number(m[1]);
}

function main() {
  const tag = arg('--tag');
  if (!tag) throw new Error('--tag is required (e.g. --tag shell-v2.6.0)');
  const upstream = arg('--upstream') || 'v0.1.0';
  const minApk = Number(arg('--min-apk') || 12);
  const slim = arg('--slim') || path.resolve(repo, '..', 'dl-cache', 'dist', `content-slim-${tag}.zip`);
  if (!fs.existsSync(slim)) throw new Error(`slim bundle not found: ${slim} (run tools/apk/make-bundle.mjs first)`);
  const slimUrl = arg('--slim-url')
    || `https://github.com/jingjiangze/stronghold-master-play/releases/download/${tag}/content-slim-${tag}.zip`;

  // The sha we sign must describe the file that ACTUALLY ships inside the APK. build-webroot
  // mirrors its baked list back into tools/apk/shell, so the two are identical; we still prefer
  // the baked asset when present so manifest.servers.sha256 can never describe an older copy
  // (审计 §2). Fall back to the checked-in tools copy on a tree that was never built.
  const bakedServers = path.resolve(repo, 'android', 'app', 'src', 'main', 'assets', 'shell', 'servers.json');
  const serversFile = fs.existsSync(bakedServers)
    ? bakedServers
    : path.join(here, 'shell', 'servers.json');
  if (!fs.existsSync(serversFile)) throw new Error(`signed server list missing: ${serversFile}`);
  console.log(`servers hash source: ${path.relative(repo, serversFile)}`);

  const manifest = {
    buildTag: tag,
    upstreamTag: upstream,
    minApk,
    slim: { url: slimUrl, sha256: sha256(slim), size: fs.statSync(slim).size },
    art: { base: ART_BASE },
    servers: { url: SERVERS_URL, sha256: sha256(serversFile) },
    mirrors: MIRRORS,
    keyId: KEY_ID,
  };

  // Content-pack shell overlay (shell-ui/): the version is read OUT OF THE SLIM itself, so the
  // field can never describe a bundle other than the one whose sha256 sits right above. Trust
  // chain: manifest.sig (Ed25519 over the canonical doc) → slim.sha256 → every byte of the slim,
  // including shell-ui/version.txt and the extras/patches snapshot — one signature chain, no
  // second trust root. Absent shell-ui/ => field omitted and old-shape manifests stay unchanged.
  const overlayVersion = slimShellOverlayVersion(slim);
  if (overlayVersion != null) manifest.shellOverlay = { version: overlayVersion };

  const seed = Buffer.from(fs.readFileSync(path.join(KEY_DIR, 'ed25519.key'), 'utf8').trim(), 'hex');
  if (seed.length !== 32) throw new Error(`malformed private key at ${KEY_DIR}/ed25519.key`);
  manifest.sig = edSign(canonicalBytes(manifest), seed).toString('base64');

  const out = arg('--out') || path.join(here, 'shell', 'manifest.json');
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`manifest: ${out}`);

  // keep the APK's embedded baseline in step (build-webroot copies this into assets/shell)
  const embedded = path.resolve(repo, 'android', 'app', 'src', 'main', 'assets', 'shell', 'manifest.json');
  if (fs.existsSync(path.dirname(embedded))) {
    fs.writeFileSync(embedded, fs.readFileSync(out));
    console.log(`embedded baseline: ${embedded}`);
  }
  console.log(`  buildTag ${tag}, slim ${(manifest.slim.size / 1024 / 1024).toFixed(1)} MB sha256 ${manifest.slim.sha256.slice(0, 16)}…`);
  if (overlayVersion != null) {
    console.log(`  shellOverlay v${overlayVersion} (signed; payload covered by the same chain via slim.sha256)`);
  }
  console.log(`  signed by ${rawPublicOf(privateKeyFromSeed(seed)).toString('hex').slice(0, 16)}…`);

  // publishable copy for the download site / R2
  const pub = path.resolve(repo, '..', 'dl-cache', 'dist', 'manifest.json');
  fs.mkdirSync(path.dirname(pub), { recursive: true });
  fs.writeFileSync(pub, fs.readFileSync(out));
  console.log(`publish copy: ${pub}`);
}

main();
