#!/usr/bin/env node
// tools/apk/make-art-packs.mjs — 素材包（art pack）构建器：用 Node 自己写 zip，保证 Windows/CI 字节确定。
//
//   node tools/apk/make-art-packs.mjs --art-version 1
//        [--webroot android/app/src/main/assets/webroot] [--out <art-packs.json>] [--packs-dir <dir>]
//        [--pack id=relpath ...]        # 默认单一常驻包 core.ui=assets/ui（P0 范围）
//
// WHY A HAND-WRITTEN ZIP WRITER: tar.exe (Windows/bsdtar) 与 Info-ZIP 产出的字节不同，Info-ZIP 还会
// 写 mtime —— 签名清单里的 sha256 描述的是「这个文件」，构建必须是可复现的（同输入同字节）。
// 这里只写 store（不压缩）条目：素材本身就是 webp/mp3 等已压缩格式，省下 zlib 版本差异这一变量，
// 也避免了解压端的任何兼容假设。固定 DOS 时间戳 1980-01-01，条目按路径排序。
//
// 产出（P0：一个包）
//   <packs-dir>/<id>-<artVersion>.zip          字节确定的 pack（条目路径是 webroot 相对路径，如 assets/ui/x.webp）
//   <out>                                      art-packs.json：[{id,sha256,size,files,bytes,urls,optional,warm}]
//                                              → 交给 gen-manifest.mjs --packs 写进签名清单（§7.3）
//
// 内容策略（构建期第一道门）：pack 只允许 webroot 下的 assets/** 条目；relpath 越界、入口不在 assets/
// 之下、或 webroot 之外，一律报错退出——设备端的 ArtStore 也会拒绝（第二道门）。
//
// urls[] 只写 Updater.ALLOWED_HOSTS 里真实存在的 host（fail-closed）：CDN/R2 主源在前，盒侧镜像在后。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS_BASE, ASSETS_DIR } from './line.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const DIST = path.resolve(repo, '..', 'dl-cache', 'dist');

/** pack id 的唯一合法形态（与方案 §7.3 一致；禁 `/`、`.`、`..`）。 */
export const PACK_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

/** 盒侧（dl 线）镜像 base；只有当其 host 在 Updater.ALLOWED_HOSTS 里时才写进 urls[]。 */
export const BOX_PACKS_BASE = `https://dl.jiangjiangze.icu/${ASSETS_DIR}/packs/`;
/** CDN/R2 主源（line.mjs 的 ASSETS_BASE，永远排第一）。 */
export const PACKS_BASE = `${ASSETS_BASE}packs/`;

export const packZipName = (id, artVersion) => `${id}-${artVersion}.zip`;

/** Splits an id=relpath spec; the value may itself contain '=' (query strings), only the first splits. */
export function parsePackSpec(spec) {
  const i = String(spec).indexOf('=');
  if (i <= 0 || i === spec.length - 1) throw new Error(`--pack must be id=relpath (got ${JSON.stringify(spec)})`);
  return { id: spec.slice(0, i), rel: spec.slice(i + 1) };
}

/**
 * The hosts the device updater may ever talk to, parsed straight out of Updater.java's
 * ALLOWED_HOSTS list. Fail-closed: a missing/empty list yields [], and callers then refuse to
 * emit any URL (a wrong guess here becomes a pack that can never download).
 */
export function updaterAllowedHosts(javaPath) {
  const file = javaPath || path.resolve(repo, 'android/app/src/main/java/icu/jiangjiangze/stronghold/Updater.java');
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const m = /ALLOWED_HOSTS\s*=\s*Arrays\.asList\(([\s\S]*?)\)/.exec(src);
  if (!m) return [];
  const hosts = [];
  for (const q of m[1].matchAll(/"([^"]+)"/g)) {
    const h = q[1].toLowerCase();
    if (!hosts.includes(h)) hosts.push(h);
  }
  return hosts;
}

/** host of an absolute http(s) URL, or null. */
export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Every candidate URL whose host the device updater actually allows (fail-closed). */
export function packUrls(id, artVersion, allowedHosts) {
  const name = packZipName(id, artVersion);
  const candidates = [PACKS_BASE + name, BOX_PACKS_BASE + name];
  const out = [];
  for (const url of candidates) {
    if (!url.startsWith('https://')) continue;
    const host = hostOf(url);
    if (host && (allowedHosts || []).includes(host)) out.push(url);
  }
  return out;
}

// ---------------------------------------------------------------------------
// deterministic zip (store method)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;        // 00:00:00
const DOS_DATE = 0x0021;   // 1980-01-01

/**
 * Builds a ZIP archive from [{name, data}] with byte-deterministic output:
 * entries sorted by name, no extra fields, no data descriptors, fixed 1980-01-01 timestamp,
 * store method (0). Re-running on the same input produces identical bytes on any machine.
 */
export function buildZip(entries) {
  const list = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seen = new Set();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of list) {
    const name = String(e.name).replace(/\\/g, '/');
    if (!name || name.startsWith('/') || name.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      throw new Error(`unsafe zip entry name: ${JSON.stringify(e.name)}`);
    }
    if (seen.has(name)) throw new Error(`duplicate zip entry: ${name}`);
    seen.add(name);
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const flags = /[^\x00-\x7f]/.test(name) ? 0x0800 : 0; // EFS: UTF-8 names
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);           // method: store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra len
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);             // extra
    cd.writeUInt16LE(0, 32);             // comment
    cd.writeUInt16LE(0, 34);             // disk
    cd.writeUInt16LE(0, 36);             // internal attrs
    cd.writeUInt32LE(0, 38);             // external attrs (no unix mode bits: deterministic)
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(list.length, 8);
  eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/** Recursively lists files under dir (sorted), returning webroot-relative '/'-joined paths. */
export function listFilesRecursive(root, relBase) {
  const out = [];
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(childAbs);
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) out.push(childRel);
      // symlinks and everything else are skipped: the device extractor only writes regular files
    }
  };
  walk(path.join(root, relBase), relBase);
  return out;
}

/** Normalizes a pack relpath; rejects anything that is not a plain relative path (no `..`). */
export function normalizeRel(rel) {
  const p = String(rel).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!p || p.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`unsafe pack relpath: ${JSON.stringify(rel)}`);
  }
  return p;
}

/** Builds one pack: {entry, zip} — the art-packs.json record and the deterministic zip bytes. */
export function buildPack({ webroot, id, rel, artVersion, allowedHosts }) {
  if (!PACK_ID_RE.test(id)) throw new Error(`bad pack id ${JSON.stringify(id)} (must match ${PACK_ID_RE})`);
  const norm = normalizeRel(rel);
  const files = listFilesRecursive(webroot, norm);
  if (!files.length) throw new Error(`pack ${id}: no files under ${norm} in ${webroot}`);
  for (const f of files) {
    if (!f.startsWith('assets/')) {
      throw new Error(`pack ${id}: entry ${f} is outside assets/ — an art pack may never carry code trees`);
    }
  }
  const entries = files.map((f) => ({ name: f, data: fs.readFileSync(path.join(webroot, f)) }));
  const zip = buildZip(entries);
  const bytes = entries.reduce((n, e) => n + e.data.length, 0);
  const urls = packUrls(id, artVersion, allowedHosts);
  if (!urls.length) {
    throw new Error(`pack ${id}: no candidate URL passes Updater.ALLOWED_HOSTS (fail-closed)`);
  }
  return {
    entry: {
      id,
      sha256: crypto.createHash('sha256').update(zip).digest('hex'),
      size: zip.length,
      files: entries.length,
      bytes,
      urls,
      optional: false,
      warm: true,
    },
    zip,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

function args(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1]) out.push(process.argv[i + 1]);
  }
  return out;
}

function main() {
  const artVersion = Number(arg('--art-version'));
  if (!Number.isInteger(artVersion) || artVersion < 1) {
    throw new Error('--art-version <N> is required (positive integer; it names the pack URLs)');
  }
  const webroot = arg('--webroot') || path.resolve(repo, 'android/app/src/main/assets/webroot');
  if (!fs.existsSync(webroot)) throw new Error(`webroot not found: ${webroot} (run build-webroot.mjs first)`);
  const out = arg('--out') || path.join(DIST, 'art-packs.json');
  const packsDir = arg('--packs-dir') || path.join(DIST, 'art-packs');
  const specs = args('--pack').length ? args('--pack') : ['core.ui=assets/ui'];
  const allowedHosts = updaterAllowedHosts(arg('--updater-java'));
  if (!allowedHosts.length) throw new Error('Updater.ALLOWED_HOSTS is empty/unreadable — refusing to emit pack URLs (fail-closed)');

  const parsed = specs.map(parsePackSpec);
  const ids = new Set();
  for (const p of parsed) {
    if (ids.has(p.id)) throw new Error(`duplicate pack id: ${p.id}`);
    ids.add(p.id);
  }

  fs.mkdirSync(packsDir, { recursive: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const records = [];
  for (const p of parsed) {
    const { entry, zip } = buildPack({ webroot, id: p.id, rel: p.rel, artVersion, allowedHosts });
    const file = path.join(packsDir, packZipName(entry.id, artVersion));
    fs.writeFileSync(file, zip);
    records.push(entry);
    console.log(`pack ${entry.id}: ${entry.files} files, ${(entry.size / 1024 / 1024).toFixed(2)} MB zip, `
      + `${(entry.bytes / 1024 / 1024).toFixed(2)} MB raw`);
    console.log(`  ${file}`);
    console.log(`  sha256 ${entry.sha256}`);
    for (const u of entry.urls) console.log(`  url    ${u}`);
  }
  fs.writeFileSync(out, JSON.stringify(records, null, 2) + '\n');
  console.log(`art-packs.json: ${out} (${records.length} pack(s), artVersion ${artVersion})`);
}

const isEntry = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntry) {
  main();
}
