#!/usr/bin/env node
// tools/apk/fetch-termux-node.mjs — download the Termux Node runtime inputs, extract them and stage an
// Android-legal copy into the app's jniLibs. Ported from Fuhua-code/Stronghold-Protocol (mobile/build-apk.mjs
// runtime section, GPL-3.0-or-later, same project family), adapted to this shell's layout.
//
//   node tools/apk/fetch-termux-node.mjs [--abis arm64-v8a,x86_64] [--force]
//
// Why: nodejs-mobile's libnode (Node 18) is EOL and hits GWP-ASan/16KB-page problems on new Android;
// the Termux Node 24 build is a plain PIE executable + shared libs that runs as a child process.
// The .deb members need `xz` on Linux (decompression via `xz -dk`; Python's lzma on Windows when xz
// is absent). Archives are unpacked with Node's zlib + a JS tar walker — no system tar is invoked
// (a natively spawned MSYS tar on Windows truncates large gzip members; reproduced 2026-10-10).
//
// Supply chain (2026-10-10) — archive first, living mirrors only as fallback:
//   CI was killed twice by the Termux pool being a LIVING repository: the day a revision moved,
//   `libsqlite_3.53.4_aarch64.deb` 404'd on packages.termux.dev and the CN mirror refused the
//   connection. The build had no archived copy of its own inputs. The runtime inputs are now pinned
//   to an immutable archive that must verify byte-for-byte:
//
//     archive-first:  download ARCHIVE_PIN.url
//                  → sha256 MUST equal ARCHIVE_PIN.sha256 (the pin; enforced before anything is unpacked)
//                  → unpack with Node zlib + the same JS tar walker the .deb path uses
//                  → verify EVERY file against the archive's own input-manifest.json
//                    (path + byte size + sha256 + totalBytes; ANY mismatch is a hard failure — never
//                     silently build from bad bytes)
//                  → the pinned `termux/<arch>/<pkg>.deb` members feed the exact same
//                    extract/stage/patch pipeline the mirror path uses.
//     fallback:     archive unreachable or failing its sha256 check → loud warning + the original
//                   live-mirror path (SP_TERMUX_MIRROR → packages.termux.dev → tuna). The archive is
//                   an improvement, not a new single point of failure.
//
//   Default pin = Fuhua-code/Stronghold-Protocol release `android-runtime-node24.18.0-r1`
//   (tar.gz, 115 734 545 B, sha256 5bab822a770b2609394bd107412b539a3c013c7f0ad8e320e8f5ce77ae7bab76):
//   a snapshot of the original aarch64/x86_64 .debs, the signed Termux repository metadata and the
//   license notices. Verify the pin yourself before touching any env:
//     sha256sum stronghold-runtime-node24.18.0-r1.tar.gz
//
//   Expected archive layout (checked against input-manifest.json, never assumed):
//     input-manifest.json                           {"schema":1,"kind":"runtime","version":"…",
//                                                    "files":[{"path","bytes","sha256"},…],"totalBytes"}
//     termux/<arch>/<pkg>.deb                       original Termux debs (arch = aarch64 | x86_64)
//     termux/repository/…, licenses/…, runtime/<abi>/…   signed metadata, notices, pre-extracted copy
//
//   Knobs (one-line switch):
//     SP_TERMUX_RUNTIME_ARCHIVE=off             skip the archive entirely (live mirrors only)
//     SP_TERMUX_RUNTIME_ARCHIVE_URL=<https url> different archive location
//     SP_TERMUX_RUNTIME_ARCHIVE_SHA256=<64 hex> the pin for that archive (change TOGETHER with the URL)
//
//   Self-host migration: upload the SAME BYTES to one of our own releases, then change ONLY the URL
//   (the constants below, or the env passed by .github/workflows/apk-re.yml). The trust anchor is the
//   sha256 — never repoint the URL at bytes we have not hashed, and do not "fix" a failing download by
//   editing the hash: either deliver the exact pinned bytes, or let the build take the mirror fallback.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { patchRuntimeDir, androidLibName } from './patch-elf-sonames.mjs';

/** The default archive pin (see the header). Swap URL + sha256 TOGETHER; the sha256 is the trust anchor. */
export const ARCHIVE_PIN = Object.freeze({
  url: 'https://github.com/Fuhua-code/Stronghold-Protocol/releases/download/android-runtime-node24.18.0-r1/stronghold-runtime-node24.18.0-r1.tar.gz',
  sha256: '5bab822a770b2609394bd107412b539a3c013c7f0ad8e320e8f5ce77ae7bab76',
});

const TERMUX = {
  bases: process.env.SP_TERMUX_MIRROR
    ? [process.env.SP_TERMUX_MIRROR]
    : ['https://packages.termux.dev/apt/termux-main',
       'https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main'], // CN fallback, ~8 MB/s
  packages: [
    { pkg: 'nodejs-lts', file: 'pool/main/n/nodejs-lts/nodejs-lts_24.18.0-1_<arch>.deb', bins: { 'bin/node': 'node' } },
    { pkg: 'libc++', file: 'pool/main/libc/libc++/libc++_30_<arch>.deb', libs: { 'lib/libc++_shared.so': 'libc++_shared.so' } },
    { pkg: 'openssl', file: 'pool/main/o/openssl/openssl_1%3A3.6.5_<arch>.deb', libs: { 'lib/libcrypto.so.3': 'libcrypto.so.3', 'lib/libssl.so.3': 'libssl.so.3' } },
    { pkg: 'libicu', file: 'pool/main/libi/libicu/libicu_78.3_<arch>.deb', libs: { 'lib/libicuuc.so.78.3': 'libicuuc.so.78', 'lib/libicui18n.so.78.3': 'libicui18n.so.78', 'lib/libicudata.so.78.3': 'libicudata.so.78' } },
    { pkg: 'c-ares', file: 'pool/main/c/c-ares/c-ares_1.34.8_<arch>.deb', libs: { 'lib/libcares.so': 'libcares.so' } },
    { pkg: 'libsqlite', file: 'pool/main/libs/libsqlite/libsqlite_3.53.4_<arch>.deb', libs: { 'lib/libsqlite3.so.3.53.4': 'libsqlite3.so' } },
    { pkg: 'zlib', file: 'pool/main/z/zlib/zlib_1.3.2_<arch>.deb', libs: { 'lib/libz.so.1.3.2': 'libz.so.1' } },
  ],
};

const ABI_TERMUX = { 'arm64-v8a': 'aarch64', 'x86_64': 'x86_64' };

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const jniRoot = path.join(repo, 'android', 'app', 'src', 'main', 'jniLibs');
const cache = path.resolve(repo, '..', 'dl-cache', 'termux-runtime');

function fail(msg) {
  console.error(`fetch-termux-node: ${msg}`);
  process.exit(1);
}

/** An error that must kill the build (bad pinned bytes) — never downgraded to the mirror fallback. */
function fatal(msg) {
  return Object.assign(new Error(msg), { fatal: true });
}

/** https only, and reject localhost / loopback / private / reserved literals (workspace security rule). */
function assertSafeUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') fail(`non-https url: ${url}`);
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    fail(`private host rejected: ${host}`);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224) fail(`private/reserved host rejected: ${host}`);
    if (a === 169 && b === 254) fail(`link-local host rejected: ${host}`);
    if (a === 172 && b >= 16 && b <= 31) fail(`private host rejected: ${host}`);
    if (a === 192 && b === 168) fail(`private host rejected: ${host}`);
  }
}

/**
 * Resolve the archive source (URL + pinned sha256) from the environment.
 * `SP_TERMUX_RUNTIME_ARCHIVE=off` disables it (mirrors only); otherwise URL/hash default to
 * ARCHIVE_PIN and may be overridden one line at a time for a self-hosted copy of the same bytes.
 * @returns {{url: string, sha256: string}|null}
 */
export function archiveSource(env = process.env) {
  if (String(env.SP_TERMUX_RUNTIME_ARCHIVE || '').trim().toLowerCase() === 'off') return null;
  const url = String(env.SP_TERMUX_RUNTIME_ARCHIVE_URL || '').trim() || ARCHIVE_PIN.url;
  const sha256 = String(env.SP_TERMUX_RUNTIME_ARCHIVE_SHA256 || '').trim().toLowerCase() || ARCHIVE_PIN.sha256;
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw fatal(`SP_TERMUX_RUNTIME_ARCHIVE_SHA256 must be 64 hex chars, got "${sha256}"`);
  }
  return { url, sha256 };
}

/** The member path of a pinned Termux deb inside the archive (the layout contract, verified per file). */
export function debMemberPath(pkgName, arch) {
  return `termux/${arch}/${pkgName}.deb`;
}

/** The exact set of Android-legal files this pipeline stages into jniLibs (the 10 .so of the runtime). */
export function stagedLibNames() {
  const names = new Set();
  for (const p of TERMUX.packages) {
    for (const to of Object.values(p.libs || {})) names.add(androidLibName(to) ?? to);
    for (const to of Object.values(p.bins || {})) names.add(androidLibName(to) ?? to);
  }
  return [...names].sort();
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Locate input-manifest.json: at the extraction root, or inside its single top-level directory. */
export function findManifestRoot(dir) {
  if (fs.existsSync(path.join(dir, 'input-manifest.json'))) return dir;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = path.join(dir, e.name);
    if (fs.existsSync(path.join(sub, 'input-manifest.json'))) return sub;
  }
  return null;
}

/**
 * Verify every file in an unpacked archive against the archive's own input-manifest.json.
 * Throws a `fatal` error on the FIRST mismatch (missing file, byte size, sha256, totalBytes, unsafe
 * path, malformed entry) — the caller must not fall back silently when the pinned bytes are wrong.
 * @returns {{checked: number, bytes: number}}
 */
export function verifyManifest(rootDir, manifest) {
  if (!manifest || typeof manifest !== 'object' || manifest.schema !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw fatal(`input-manifest.json: unsupported shape (schema=${manifest && manifest.schema}, files=${manifest && manifest.files && manifest.files.length})`);
  }
  let checked = 0;
  let bytes = 0;
  for (const f of manifest.files) {
    if (!f || typeof f.path !== 'string' || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes < 0) {
      throw fatal(`input-manifest.json: malformed entry ${JSON.stringify(f).slice(0, 160)}`);
    }
    const segs = f.path.split('/');
    if (!segs.length || segs.some((s) => !s || s === '.' || s === '..' || s.includes('\\') || s.includes(':'))) {
      throw fatal(`input-manifest.json: unsafe path ${JSON.stringify(f.path)}`);
    }
    const p = path.join(rootDir, ...segs);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw fatal(`input-manifest.json: missing ${f.path}`);
    const size = fs.statSync(p).size;
    if (size !== f.bytes) throw fatal(`input-manifest.json: ${f.path} is ${size} bytes, manifest pins ${f.bytes}`);
    const got = sha256File(p);
    if (got.toLowerCase() !== f.sha256.toLowerCase()) throw fatal(`input-manifest.json: ${f.path} sha256 ${got} != ${f.sha256}`);
    checked++;
    bytes += size;
  }
  if (Number.isSafeInteger(manifest.totalBytes) && bytes !== manifest.totalBytes) {
    throw fatal(`input-manifest.json: totalBytes ${manifest.totalBytes} != verified ${bytes}`);
  }
  return { checked, bytes };
}

async function download(url, dest) {
  assertSafeUrl(url);
  console.log(`  downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 4000) throw new Error(`too small (${buf.length} bytes)`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

/**
 * Get the pinned archive bytes, verify the full-file sha256, unpack and per-file verify the manifest.
 * Resolves to null (after a loud warning) when the archive cannot be used, so callers fall back to the
 * live mirrors. A pin-verified archive whose manifest does not check out is fatal instead.
 * @returns {Promise<{root: string, files: Map<string, {bytes: number, sha256: string}>, version: string}|null>}
 */
async function prepareArchive(src) {
  const dir = path.join(cache, 'archive');
  const name = path.basename(new URL(src.url).pathname) || 'runtime-inputs.tar.gz';
  const file = path.join(dir, name);
  const root = path.join(dir, `unpacked-${src.sha256.slice(0, 12)}`);
  try {
    if (fs.existsSync(file) && sha256File(file) === src.sha256) {
      console.log(`  archive cache hit — sha256 ${src.sha256} verified`);
    } else {
      fs.mkdirSync(dir, { recursive: true });
      fs.rmSync(file, { force: true });
      await download(src.url, file);
      const got = sha256File(file);
      if (got !== src.sha256) {
        fs.rmSync(file, { force: true }); // never leave a non-matching file behind to poison the cache
        throw new Error(`sha256 mismatch — expected ${src.sha256}, got ${got}`);
      }
      console.log(`  archive sha256 verified: ${src.sha256}`);
    }

    let base = findManifestRoot(root);
    const marker = base && path.join(base, '.verified');
    const markerOk = base && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === src.sha256;
    if (!markerOk) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      // Pure-Node unpack: the system GNU tar in CI would work, but a natively spawned MSYS tar on
      // Windows dies mid-pipe on a 115 MB gzip member ("gzip: stdin: unexpected end of file",
      // reproduced locally 2026-10-10) — and the JS walker is the same one the .deb path trusts.
      const members = extractTarBuffer(zlib.gunzipSync(fs.readFileSync(file)), root);
      if (!members.length) throw fatal(`${name}: no regular files were unpacked`);
      base = findManifestRoot(root);
      if (!base) throw fatal(`input-manifest.json not found in ${name}`);
    }
    // Re-run the per-file verification on EVERY call: a corrupted cache tree must be caught here
    // (hard fail), never sail into the build. ~1 s over 234 MB, and only when the stamp is cold.
    const manifest = JSON.parse(fs.readFileSync(path.join(base, 'input-manifest.json'), 'utf8'));
    const stats = verifyManifest(base, manifest);
    if (!markerOk) {
      fs.writeFileSync(path.join(base, '.verified'), `${src.sha256}\n`);
      console.log(`  archive unpacked + per-file manifest verified: ${stats.checked} files, ${stats.bytes} bytes (${manifest.version})`);
    } else {
      console.log(`  archive unpacked (cache hit) — per-file manifest re-verified: ${stats.checked} files, ${stats.bytes} bytes (${manifest.version})`);
    }
    const files = new Map(manifest.files.map((f) => [f.path, { bytes: f.bytes, sha256: f.sha256 }]));
    return { root: base, files, version: manifest.version };
  } catch (e) {
    if (e && e.fatal) fail(e.message);
    console.warn(`::warning::fetch-termux-node: pinned archive unavailable (${e.message})`);
    console.warn('::warning::fetch-termux-node: falling back to the live Termux mirrors (packages.termux.dev → tuna)');
    return null;
  }
}

/** Extract selected members out of a .deb (ar container + data.tar.xz); symlinks are skipped (Windows-safe). */
async function extractDeb(deb, destDir) {
  const work = path.join(cache, 'work', path.basename(deb));
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const buf = fs.readFileSync(deb);
  if (buf.subarray(0, 8).toString('ascii') !== '!<arch>\n') fail(`${deb} is not an ar archive`);
  let p = 8;
  let payload = null;
  let payloadName = '';
  while (p + 60 <= buf.length) {
    const name = buf.subarray(p, p + 16).toString('ascii').trim();
    const size = Number(buf.subarray(p + 48, p + 58).toString('ascii').trim());
    const start = p + 60;
    if (name.startsWith('data.tar')) { payload = buf.subarray(start, start + size); payloadName = name; }
    p = start + size + (size % 2);
  }
  if (!payload) fail(`${deb}: no data.tar member found`);

  const dataTar = path.join(work, 'data.tar');
  if (payloadName.endsWith('.gz')) {
    fs.writeFileSync(dataTar, zlib.gunzipSync(payload));
  } else {
    const dataXz = path.join(work, 'data.tar.xz');
    fs.writeFileSync(dataXz, payload);
    try {
      // decompress ONLY (never extract members here: the .deb contains symlinks Windows cannot create)
      execFileSync('xz', ['-dkf', dataXz], { stdio: 'inherit' }); // -> data.tar next to it
    } catch (e) {
      if (process.platform === 'win32') {
        // no xz installed: Python's stdlib lzma writes the tar without touching any members
        execFileSync('python', ['-c',
          'import lzma,sys;open(sys.argv[2],"wb").write(lzma.open(sys.argv[1]).read())',
          dataXz, dataTar], { stdio: 'inherit' });
      } else {
        throw e;
      }
    }
    fs.rmSync(dataXz, { force: true });
  }
  if (!fs.existsSync(dataTar)) fail(`${deb}: decompression produced no tar`);

  const out = extractTarBuffer(fs.readFileSync(dataTar), destDir);
  fs.rmSync(dataTar, { force: true });
  return out;
}

/**
 * Walk a POSIX tar buffer and write its regular files under destDir. Symlinks / devices / directories
 * are skipped — .deb and archive members must not rely on entries Windows cannot create. Shared by the
 * .deb pipeline and the pinned-archive unpack so both extract identical bytes from identical tars.
 * @param {Buffer} tar @returns {string[]} written member paths
 */
function extractTarBuffer(tar, destDir) {
  const out = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const nameField = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    const full = prefix ? `${prefix}/${nameField}` : nameField;
    const dataStart = off + 512;
    if ((type === '0' || type === '\0') && full && !full.endsWith('/')) {
      const dest = path.join(destDir, ...full.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, tar.subarray(dataStart, dataStart + size));
      out.push(full);
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** True when a previous run already staged this ABI (stamp + libnode.so both present). */
function isCached(abi) {
  const stamp = path.join(cache, abi, 'RUNTIME.json');
  return fs.existsSync(stamp) && fs.existsSync(path.join(jniRoot, abi, 'libnode.so'));
}

/**
 * Make sure `cache/debs/<pkg>-<arch>.deb` exists. The pinned archive wins when it carries the member;
 * otherwise (archive absent, or this package missing from its manifest) the live mirror loop runs.
 */
async function ensureDeb(p, arch, force, archive) {
  const deb = path.join(cache, 'debs', `${p.pkg}-${arch}.deb`);
  if (archive) {
    const rel = debMemberPath(p.pkg, arch);
    if (archive.files.has(rel)) {
      const src = path.join(archive.root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(deb), { recursive: true });
      fs.copyFileSync(src, deb);
      console.log(`  ${p.pkg} (${arch}): pinned archive member ${rel}`);
      return deb;
    }
    console.warn(`  ${p.pkg} (${arch}): ${rel} not in the archive manifest — live mirrors for this package`);
  }
  if (force || !fs.existsSync(deb)) {
    let lastErr = null;
    for (const base of TERMUX.bases) {
      try {
        await download(`${base}/${p.file.replace('<arch>', arch)}`, deb);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`  ${base} failed (${e.message}), trying next mirror`);
      }
    }
    if (lastErr) fail(`${p.pkg} (${arch}): all mirrors failed — ${lastErr.message}`);
  }
  return deb;
}

async function fetchAbi(abi, force, archive) {
  const arch = ABI_TERMUX[abi];
  if (!arch) fail(`unsupported ABI ${abi} (Termux publishes aarch64 and x86_64 only)`);
  const stage = path.join(cache, abi);
  const stamp = path.join(stage, 'RUNTIME.json');
  const jniDir = path.join(jniRoot, abi);
  if (!force && isCached(abi)) {
    const info = JSON.parse(fs.readFileSync(stamp, 'utf8'));
    console.log(`${abi}: cached runtime — Node ${info.node} already staged in jniLibs`);
    return;
  }
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  let nodeVersion = null;
  const libs = [];
  for (const p of TERMUX.packages) {
    const deb = await ensureDeb(p, arch, force, archive);
    const out = path.join(stage, 'unpack', p.pkg);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const members = await extractDeb(deb, out);
    if (!members.length) fail(`${p.pkg}: the package has no regular files`);
    const usr = path.join(out, 'data', 'data', 'com.termux', 'files', 'usr');
    const wanted = { ...(p.bins || {}), ...(p.libs || {}) };
    const missing = Object.keys(wanted).filter((rel) => !fs.existsSync(path.join(usr, ...rel.split('/'))));
    if (missing.length) fail(`${p.pkg} (${arch}): ${missing.join(', ')} not found in the package`);
    for (const [from, to] of Object.entries(wanted)) {
      fs.copyFileSync(path.join(usr, ...from.split('/')), path.join(stage, to));
      if (p.libs) libs.push(to);
    }
    if (p.bins) nodeVersion = /nodejs-lts_(\d+\.\d+\.\d+)/.exec(p.file)?.[1] || '24.x';
  }

  // stage into jniLibs with the Android-legal shape (rename + ELF DT_NEEDED/DT_SONAME rewrite)
  fs.rmSync(jniDir, { recursive: true, force: true });
  fs.mkdirSync(jniDir, { recursive: true });
  fs.copyFileSync(path.join(stage, 'node'), path.join(jniDir, 'node'));
  for (const lib of libs) fs.copyFileSync(path.join(stage, lib), path.join(jniDir, lib));
  const patched = await patchRuntimeDir(jniDir);
  const entries = fs.readdirSync(jniDir).sort();
  if (!entries.includes('libnode.so')) fail(`${abi}: libnode.so missing after patch`);
  console.log(`${abi}: Node ${nodeVersion} staged — ${entries.length} entries, ${patched.patched} ELF patched`);

  fs.writeFileSync(stamp, JSON.stringify({ abi, arch, node: nodeVersion, libs, packages: TERMUX.packages.map((p) => p.pkg), fetchedAt: new Date().toISOString() }, null, 1) + '\n');
}

async function main() {
  const force = process.argv.includes('--force');
  const abisArg = process.argv.find((a) => a.startsWith('--abis='));
  const abis = abisArg ? abisArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean) : ['arm64-v8a', 'x86_64'];

  let archive = null;
  if (force || abis.some((abi) => !isCached(abi))) {
    const src = archiveSource(process.env);
    if (src) {
      console.log(`archive source: ${src.url}`);
      console.log(`  pin sha256: ${src.sha256}`);
      archive = await prepareArchive(src);
      if (archive) console.log(`archive in use: ${archive.version} (${archive.files.size} manifest entries)`);
    } else {
      console.log('archive disabled (SP_TERMUX_RUNTIME_ARCHIVE=off) — live mirrors only');
    }
  }
  for (const abi of abis) await fetchAbi(abi, force, archive);
  console.log('fetch-termux-node: done');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => fail(e.stack || String(e)));
}
