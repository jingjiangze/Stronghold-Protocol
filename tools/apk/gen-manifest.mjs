#!/usr/bin/env node
// tools/apk/gen-manifest.mjs — builds and SIGNS the hot-update manifest (最终执行方案 §1.2).
//
//   node tools/apk/gen-manifest.mjs --tag shell-v2.6.0 [--upstream v0.1.0] [--min-apk 12]
//        [--slim <zip>] [--slim-url <url>] [--out <path>]
//        [--packs <art-packs.json> --art-version <N> [--art-format 1] [--art-mirrors id=base,...]]
//
// The signature covers the canonical form of everything except `sig`, so the on-device verifier
// (Ed25519.java + CanonicalJson.java) can check it offline. Signing happens locally: the private
// key stays on this machine and CI only ever sees the signed result.
//
// --packs (P0 素材热更): adds the §7.3 art block — {base, version, format, mirrors, packs} — built
// from make-art-packs.mjs's output. Every field is validated here (ids, 64-hex sha256, absolute
// https URLs whose hosts are in Updater.ALLOWED_HOSTS, format must be 1); nothing is written when
// --packs is absent, so old-shape manifests stay byte-identical.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalBytes } from './canonical.mjs';
import { privateKeyFromSeed, rawPublicOf, sign as edSign } from './ed25519.mjs';
import { ASSETS_BASE, SERVERS_URL } from './line.mjs';
import { PACK_ID_RE, hostOf, updaterAllowedHosts } from './make-art-packs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const KEY_DIR = process.env.SP_SIGN_DIR || path.join(process.env.USERPROFILE || process.env.HOME, '.sp-sign');

// Both come from line.mjs: the re-apk line's manifests must point at ITS asset tree and ITS signed
// server list, never at the apk line's (see the comment in line.mjs).
const ART_BASE = ASSETS_BASE;
const MIRRORS = ['ghfast', 'ghproxy', 'llkk', 'ghproxynet', 'r2', 'box'];
const KEY_ID = 'sp-2026-10';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * The §7.3 art block: {base, version, format, mirrors, packs}. Validated hard — a malformed pack
 * would otherwise be signed, and every device would then refuse (or worse, half-install) it.
 * Mirrors are download-only hints; the page never reads them (§6.1).
 */
export function artBlockFrom(packsFile, opts) {
  const { artVersion, format = 1, mirrorsSpec = null, allowedHosts, base = ART_BASE } = opts || {};
  if (!Number.isInteger(artVersion) || artVersion < 1) {
    throw new Error('--art-version <N> (positive integer) is required together with --packs');
  }
  if (Number(format) !== 1) {
    throw new Error(`--art-format must be 1 — the only pack layout this shell implements (got ${format})`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(packsFile, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read --packs ${packsFile}: ${e.message}`);
  }
  if (!Array.isArray(raw) || !raw.length) throw new Error(`--packs ${packsFile}: expected a non-empty array`);
  const seen = new Set();
  const packs = [];
  for (const p of raw) {
    const id = p && p.id;
    if (typeof id !== 'string' || !PACK_ID_RE.test(id)) {
      throw new Error(`--packs ${packsFile}: bad pack id ${JSON.stringify(id)} (must match ${PACK_ID_RE})`);
    }
    if (seen.has(id)) throw new Error(`--packs ${packsFile}: duplicate pack id ${id}`);
    seen.add(id);
    if (typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.sha256)) {
      throw new Error(`pack ${id}: sha256 must be 64 lowercase hex chars`);
    }
    for (const k of ['size', 'files', 'bytes']) {
      if (!Number.isInteger(p[k]) || p[k] < 0) throw new Error(`pack ${id}: ${k} must be a non-negative integer`);
    }
    if (!Array.isArray(p.urls) || !p.urls.length) throw new Error(`pack ${id}: urls must be a non-empty array`);
    const urls = [];
    for (const u of p.urls) {
      if (typeof u !== 'string' || !/^https:\/\//.test(u)) {
        throw new Error(`pack ${id}: every url must be absolute https (got ${JSON.stringify(u)})`);
      }
      const host = hostOf(u);
      if (!host || !allowedHosts.includes(host)) {
        throw new Error(`pack ${id}: host ${host} is not in Updater.ALLOWED_HOSTS (fail-closed)`);
      }
      if (!urls.includes(u)) urls.push(u);
    }
    if (!urls[0].startsWith(base)) {
      throw new Error(`pack ${id}: primary url must be this line's asset base ${base} (got ${urls[0]})`);
    }
    packs.push({
      id, sha256: p.sha256, size: p.size, files: p.files, bytes: p.bytes,
      urls,
      requires: packRequires(id, p.requires),
      optional: !!p.optional,
      warm: !!p.warm,
      prefixes: packPrefixes(id, p.prefixes),
    });
  }
  // `requires` must name packs in THIS set and must be acyclic (方案 §7.3：前置包拓扑序；环 = 非法清单).
  for (const p of packs) {
    for (const r of p.requires) {
      if (!seen.has(r)) throw new Error(`pack ${p.id}: requires unknown pack ${r}`);
    }
  }
  assertAcyclic(packs);
  return { base, version: artVersion, format: 1, mirrors: parseMirrors(mirrorsSpec, allowedHosts), packs };
}

/** `requires` field: absent → []; otherwise an array of pack ids (validated by the caller). */
function packRequires(id, value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`pack ${id}: requires must be an array`);
  const out = [];
  for (const r of value) {
    if (typeof r !== 'string' || !PACK_ID_RE.test(r)) {
      throw new Error(`pack ${id}: requires entry ${JSON.stringify(r)} is not a pack id`);
    }
    if (r === id) throw new Error(`pack ${id}: requires itself`);
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

/**
 * `prefixes` field (informational, covered by the same signature): the `assets/…/` directory
 * prefixes the pack covers. The device does NOT depend on it — MainActivity enumerates the actually
 * installed pack files into `/__sp/local-assets.txt`, which is exact and reflects what is on disk;
 * this field makes the signed document self-describing for audits. Absent → [].
 */
function packPrefixes(id, value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`pack ${id}: prefixes must be an array`);
  const out = [];
  for (const pre of value) {
    if (typeof pre !== 'string' || !/^assets(\/[A-Za-z0-9._:-]+)*\/$/.test(pre)) {
      throw new Error(`pack ${id}: prefix ${JSON.stringify(pre)} must be an assets/…/ directory`);
    }
    if (!out.includes(pre)) out.push(pre);
  }
  return out;
}

/** Rejects a `requires` cycle (the device would otherwise wait forever on a pack that never installs). */
function assertAcyclic(packs) {
  const deps = new Map(packs.map((p) => [p.id, p.requires]));
  const state = new Map(); // 0 visiting, 1 done
  const visit = (id, stack) => {
    if (state.get(id) === 1) return;
    if (state.get(id) === 0) throw new Error(`pack requires cycle: ${[...stack, id].join(' -> ')}`);
    state.set(id, 0);
    for (const r of deps.get(id) || []) visit(r, [...stack, id]);
    state.set(id, 1);
  };
  for (const p of packs) visit(p.id, []);
}

/** `--art-mirrors id=base,...` → [{id, base}]; hosts are fail-closed against ALLOWED_HOSTS too. */
function parseMirrors(spec, allowedHosts) {
  if (!spec) return [];
  const out = [];
  const seen = new Set();
  for (const item of String(spec).split(',')) {
    const t = item.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i <= 0 || i === t.length - 1) throw new Error(`--art-mirrors entry must be id=base (got ${JSON.stringify(t)})`);
    const id = t.slice(0, i);
    const base = t.slice(i + 1);
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(id)) {
      throw new Error(`mirror id must match ^[a-z0-9][a-z0-9._-]{0,31}$ (got ${JSON.stringify(id)})`);
    }
    if (seen.has(id)) throw new Error(`duplicate mirror id: ${id}`);
    seen.add(id);
    if (!/^https:\/\/.+/.test(base)) throw new Error(`mirror ${id}: base must be an absolute https URL`);
    const host = hostOf(base);
    if (!host || !allowedHosts.includes(host)) {
      throw new Error(`mirror ${id}: host ${host} is not in Updater.ALLOWED_HOSTS (fail-closed)`);
    }
    out.push({ id, base });
  }
  return out;
}

/** shell-ui/version.txt out of the slim zip (bsdtar on Windows, unzip on POSIX), or null when the
 *  bundle carries no shell-ui/ at all. A present-but-malformed file is a hard error — the manifest
 *  must never describe the overlay channel with a made-up version. */
function slimShellOverlayVersion(slim) {
  const read = () => (process.platform === 'win32'
    ? execFileSync('C:/Windows/System32/tar.exe', ['-xOf', slim, 'shell-ui/version.txt'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    : execFileSync('unzip', ['-p', slim, 'shell-ui/version.txt'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const list = () => (process.platform === 'win32'
    ? execFileSync('C:/Windows/System32/tar.exe', ['-tf', slim], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    : execFileSync('unzip', ['-Z1', slim], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }));
  let body = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3 && body === null; attempt++) {
    try { body = read(); } catch (e) { lastErr = e; }
  }
  if (body === null) {
    // "no such entry" (legal: the slim has no shell-ui/, channel off) and "the entry exists but
    // could not be read" are very different outcomes. The second one signs a manifest WITHOUT
    // shellOverlay, so devices never accept the overlay and the whole content update silently
    // stops reaching them (2026-10-08 release 109 did exactly that: one failed extraction, a
    // silent null, no field in the signed document). Retry, then tell the two apart by listing.
    let names = null;
    try { names = list(); } catch { /* archive itself unreadable — treat as absent below */ }
    if (names !== null && /(^|\/)shell-ui\/version\.txt\s*$/m.test(names)) {
      throw new Error('slim carries shell-ui/version.txt but it could not be read after 3 attempts'
        + (lastErr ? ` (${lastErr.message})` : '')
        + ' — refusing to sign a manifest without shellOverlay (devices would ignore the overlay)');
    }
    return null;
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
    || `https://github.com/jingjiangze/Stronghold-Protocol/releases/download/${tag}/content-slim-${tag}.zip`;

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

  // 素材热更（P0，§7.3）：--packs 存在时 art 块变成 {base, version, format, mirrors, packs}。
  // 一份 Ed25519 签名覆盖全部 pack 字节（art.packs[].sha256），不引入第二信任根；缺省（无 --packs）
  // 时 art 保持 {base} 旧形状，输出与旧版逐字节一致。
  const packsFile = arg('--packs');
  if (packsFile) {
    manifest.art = artBlockFrom(packsFile, {
      artVersion: Number(arg('--art-version')),
      format: Number(arg('--art-format') || 1),
      mirrorsSpec: arg('--art-mirrors'),
      allowedHosts: updaterAllowedHosts(),
    });
  }

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
  if (manifest.art.packs) {
    const packed = manifest.art.packs.reduce((n, p) => n + p.size, 0);
    console.log(`  art v${manifest.art.version} format ${manifest.art.format}: ${manifest.art.packs.length} pack(s), `
      + `${(packed / 1024 / 1024).toFixed(2)} MB zipped (sha256 per pack, signed by the same chain)`);
  }
  console.log(`  signed by ${rawPublicOf(privateKeyFromSeed(seed)).toString('hex').slice(0, 16)}…`);

  // publishable copy for the download site / R2
  const pub = path.resolve(repo, '..', 'dl-cache', 'dist', 'manifest.json');
  fs.mkdirSync(path.dirname(pub), { recursive: true });
  fs.writeFileSync(pub, fs.readFileSync(out));
  console.log(`publish copy: ${pub}`);
}

main();
