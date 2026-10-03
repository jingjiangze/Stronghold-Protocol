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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalBytes } from './canonical.mjs';
import { privateKeyFromSeed, rawPublicOf, sign as edSign } from './ed25519.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const KEY_DIR = process.env.SP_SIGN_DIR || path.join(process.env.USERPROFILE || process.env.HOME, '.sp-sign');

const ART_BASE = 'https://weishucdn.jiangjiangze.icu/assets/';
const SERVERS_URL = 'https://dl.jiangjiangze.icu/servers.json';
const MIRRORS = ['ghfast', 'ghproxy', 'llkk', 'ghproxynet', 'r2', 'box'];
const KEY_ID = 'sp-2026-10';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const tag = arg('--tag');
  if (!tag) throw new Error('--tag is required (e.g. --tag shell-v2.6.0)');
  const upstream = arg('--upstream') || 'v0.1.0';
  const minApk = Number(arg('--min-apk') || 12);
  const slim = arg('--slim') || path.resolve(repo, '..', 'dl-cache', 'dist', `content-slim-${tag}.zip`);
  if (!fs.existsSync(slim)) throw new Error(`slim bundle not found: ${slim} (run tools/apk/make-bundle.mjs first)`);
  const slimUrl = arg('--slim-url')
    || `https://github.com/jingjiangze/Stronghold-Protocol/releases/download/${tag}/content-slim-${tag}.zip`;

  const serversFile = path.join(here, 'shell', 'servers.json');
  if (!fs.existsSync(serversFile)) throw new Error(`signed server list missing: ${serversFile}`);

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
  console.log(`  signed by ${rawPublicOf(privateKeyFromSeed(seed)).toString('hex').slice(0, 16)}…`);

  // publishable copy for the download site / R2
  const pub = path.resolve(repo, '..', 'dl-cache', 'dist', 'manifest.json');
  fs.mkdirSync(path.dirname(pub), { recursive: true });
  fs.writeFileSync(pub, fs.readFileSync(out));
  console.log(`publish copy: ${pub}`);
}

main();
