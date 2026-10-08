#!/usr/bin/env node
// tools/apk/make-art-packs.mjs — 素材包（art pack）构建器：用 Node 自己写 zip，保证 Windows/CI 字节确定。
//
//   node tools/apk/make-art-packs.mjs --art-version 1 --buckets
//        [--webroot android/app/src/main/assets/webroot] [--out <art-packs.json>] [--packs-dir <dir>]
//        [--max-pack-mb 64] [--manifest data/assets.json ...]
//   node tools/apk/make-art-packs.mjs --art-version 1 --pack id=relpath [--pack ...]   # 显式单目录包
//
// WHY A HAND-WRITTEN ZIP WRITER: tar.exe (Windows/bsdtar) 与 Info-ZIP 产出的字节不同，Info-ZIP 还会
// 写 mtime —— 签名清单里的 sha256 描述的是「这个文件」，构建必须是可复现的（同输入同字节）。
// 这里只写 store（不压缩）条目：素材本身就是 webp/mp3 等已压缩格式，省下 zlib 版本差异这一变量，
// 也避免了解压端的任何兼容假设。固定 DOS 时间戳 1980-01-01，条目按路径排序。
//
// 两种模式：
//   · --buckets（默认，当 webroot 里有 data/assets.json 时）—— 按分桶表把**清单引用集**分到若干
//     大包（方案-静态资源热更新 §5 layer② / 设计-按需下载 §2）。每个 /assets/** 引用必须且只能属于
//     一个 pack（构建期完整性闸门：逐条 fs.statSync 必须在盘上，覆盖率会打印出来）。任何超过
//     --max-pack-mb 的桶按「实体目录（干员/敌人/语音角色）」确定性分卷成 <id>.1、<id>.2 …，让每个
//     落地 zip 都留在能流式续传的大小窗口里（默认 64 MB，方案要求 32–128 MB）。
//   · --pack id=rel —— 显式把某个目录整个打成包（老用法，逐文件扫目录，不做清单闸门）。
//
// 产出
//   <packs-dir>/<id>-<artVersion>.zip          字节确定的 pack（条目路径是 webroot 相对路径，如 assets/ui/x.webp）
//   <out>                                      art-packs.json：[{id,sha256,size,files,bytes,urls,requires,optional,warm,prefixes}]
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

/** 单个 pack 的体积上限：超过就按实体目录确定性分卷（方案要求 32–128 MB，默认 64 MB）。 */
export const DEFAULT_MAX_PACK_BYTES = 64 * 1024 * 1024;

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
// manifest refs -> buckets (pure; see BUCKET_RULES)
// ---------------------------------------------------------------------------

/**
 * The bucketing table (设计-按需下载 §2.2/§2.3 的分类，按业主 2026-10-08「a few big zips」目标合并成
 * 粗粒度大包)：**有序，首个匹配生效**，因此每个引用只会落进一个桶。`assets/` 兜底规则保证任何
 * 引用都有归属（未匹配 = 构建期报错）。
 *
 * `optional:true` 的桶（语音、教学图）失败不阻塞「素材就绪」；其余桶是常驻集（warm，清单一到即预取）。
 * 超过 DEFAULT_MAX_PACK_BYTES 的桶由 bucketize() 按实体目录分卷成 `<id>.1`、`<id>.2` …
 */
export const BUCKET_RULES = [
  { prefix: 'assets/ui/guide/', id: 'core.guide', optional: true },
  { prefix: 'assets/ui/', id: 'core.ui' },
  { prefix: 'assets/local/guide/', id: 'local.guide', optional: true },
  { prefix: 'assets/local/map/', id: 'local.map' },
  { prefix: 'assets/local/ui/', id: 'local.ui' },
  { prefix: 'assets/local/emoticon/', id: 'local.emoticon' },
  { prefix: 'assets/local/module/', id: 'local.module' },
  { prefix: 'assets/local/mesh/', id: 'local.mesh' },
  { prefix: 'assets/local/spine/', id: 'local.spine' },
  { prefix: 'assets/local/projectiles/', id: 'local.projectiles' },
  { prefix: 'assets/local/', id: 'local.misc' },
  { prefix: 'assets/audio/bgm/', id: 'audio.bgm' },
  { prefix: 'assets/audio/sfx/', id: 'audio.sfx' },
  { prefix: 'assets/audio/voice/', id: 'audio.voice', optional: true },
  { prefix: 'assets/audio/', id: 'audio.misc' },
  { prefix: 'assets/spine/token/', id: 'core.chrome' },
  { prefix: 'assets/spine/enemy/', id: 'core.spine.enemy' },
  { prefix: 'assets/spine/op/', id: 'core.spine.op' },
  { prefix: 'assets/spine/', id: 'core.spine' },
  { prefix: 'assets/char/', id: 'char.all' },
  { prefix: 'assets/enemy/', id: 'core.enemyicon' },
  { prefix: 'assets/module/', id: 'core.chrome' },
  { prefix: 'assets/prof/', id: 'core.chrome' },
  { prefix: 'assets/bond/', id: 'core.chrome' },
  { prefix: 'assets/band/', id: 'core.chrome' },
  { prefix: 'assets/item/', id: 'core.chrome' },
  { prefix: 'assets/skill/', id: 'core.chrome' },
  { prefix: 'assets/token/', id: 'core.chrome' },
  { prefix: 'assets/', id: 'misc' },
];

/**
 * Any manifest string that names an asset → the `assets/<rel>` key the pack tree uses. Mirrors
 * ArtCdn.assetPathOf / art-prefetch.js toLocalPath: `<anything>/assets-re/<rel>` (the CDN form
 * build-webroot bakes in) and `<anything>/assets/<rel>` both normalise to `assets/<rel>`; anything
 * else → null. `assets-re` is checked first (its own prefix contains no `/assets/` substring).
 */
export function assetPathOf(value) {
  if (typeof value !== 'string') return null;
  const i = value.indexOf(`/${ASSETS_DIR}/`);
  if (i >= 0) return safeRef(value.slice(i + ASSETS_DIR.length + 2));
  const j = value.indexOf('/assets/');
  if (j >= 0) return safeRef(value.slice(j + '/assets/'.length));
  if (value.startsWith('assets/')) return safeRef(value.slice('assets/'.length)); // already-normalised key
  return null;
}

/** `rel` (no leading slash) → `assets/rel`, or null when it is empty/unsafe (traversal, absolute). */
function safeRef(rel) {
  if (typeof rel !== 'string') return null;
  const p = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p || p.endsWith('/')) return null;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return null;
  }
  return `assets/${p}`;
}

function walkStrings(node, visit) {
  if (node == null) return;
  if (typeof node === 'string') { visit(node); return; }
  if (typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const v of node) walkStrings(v, visit); return; }
  for (const k of Object.keys(node)) walkStrings(node[k], visit);
}

/** The manifest files whose refs a pack set must cover (方案 §2.6：以清单引用集为准). */
export const REF_MANIFESTS = ['data/assets.json', 'data/local-assets.json'];

/**
 * Collects the referenced `/assets/**` set out of `<webroot>/data/assets.json` (+ local-assets.json).
 * Returns `{ refs: Set<assets/…>, byFile: {file: count} }`. Missing manifest files are simply 0.
 */
export function collectRefs(webroot, manifests = REF_MANIFESTS) {
  const refs = new Set();
  const byFile = {};
  for (const rel of manifests) {
    const file = path.join(webroot, rel);
    let n = 0;
    if (fs.existsSync(file)) {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      const set = new Set();
      walkStrings(doc, (s) => { const a = assetPathOf(s); if (a) set.add(a); });
      n = set.size;
      for (const r of set) refs.add(r);
    }
    byFile[rel] = n;
  }
  return { refs, byFile };
}

/** The first rule whose prefix the ref starts with (null when none — the `assets/` fallback covers all). */
export function bucketOf(ref, rules = BUCKET_RULES) {
  for (const r of rules) if (ref.startsWith(r.prefix)) return r;
  return null;
}

/**
 * Assigns every ref to exactly one bucket (first matching rule), merges rules that share an id, then
 * shards any bucket whose total size exceeds maxBytes into `<id>.1`, `<id>.2`, … Sharding is by the
 * entity directory right after the matched prefix (a whole operator/enemy/voice-char stays in one
 * shard); a single entity bigger than maxBytes is split by sorted file order.
 *
 * Pure: sizes come in through `sizeOf(ref)`. Returns `{ packs, unassigned }` where each pack is
 * `{ id, prefixes, refs, optional, warm, requires, bytes }`.
 */
export function bucketize(refs, sizeOf, opts = {}) {
  const rules = opts.rules || BUCKET_RULES;
  const maxBytes = opts.maxBytes || DEFAULT_MAX_PACK_BYTES;
  const groups = new Map();
  const unassigned = [];
  for (const ref of [...refs].sort()) {
    const rule = bucketOf(ref, rules);
    if (!rule) { unassigned.push(ref); continue; }
    let g = groups.get(rule.id);
    if (!g) {
      g = { id: rule.id, rules: new Set(), items: [], optional: false, warm: true, requires: [], bytes: 0 };
      groups.set(rule.id, g);
    }
    g.rules.add(rule.prefix);
    g.optional = g.optional || !!rule.optional;
    if (rule.warm === false) g.warm = false;
    const tail = ref.slice(rule.prefix.length);
    const key = tail.includes('/') ? tail.slice(0, tail.indexOf('/')) : '';
    g.items.push({ ref, prefix: rule.prefix, key });
    g.bytes += sizeOf(ref);
  }
  const packs = [];
  for (const g of [...groups.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    for (const shard of shardGroup(g, maxBytes, sizeOf)) packs.push(shard);
  }
  return { packs, unassigned };
}

function finalize(g, refs, id, sizeOf) {
  const sorted = refs.slice().sort();
  return {
    id,
    prefixes: [...g.rules].sort(),
    refs: sorted,
    optional: g.optional,
    warm: g.warm,
    requires: g.requires.slice(),
    bytes: sorted.reduce((n, r) => n + sizeOf(r), 0),
  };
}

function shardGroup(g, maxBytes, sizeOf) {
  if (g.bytes <= maxBytes) return [finalize(g, g.items.map((it) => it.ref), g.id, sizeOf)];
  const ents = new Map();
  for (const it of g.items) {
    const k = it.key || it.ref;
    if (!ents.has(k)) ents.set(k, []);
    ents.get(k).push(it.ref);
  }
  const shards = [];
  let cur = [];
  let curBytes = 0;
  const flush = () => { if (cur.length) { shards.push(cur); cur = []; curBytes = 0; } };
  for (const k of [...ents.keys()].sort()) {
    const refs = ents.get(k).slice().sort();
    const bytes = refs.reduce((n, r) => n + sizeOf(r), 0);
    if (bytes > maxBytes) {
      flush();
      let part = [];
      let pb = 0;
      for (const r of refs) {
        const rb = sizeOf(r);
        if (part.length && pb + rb > maxBytes) { shards.push(part); part = []; pb = 0; }
        part.push(r);
        pb += rb;
      }
      if (part.length) shards.push(part);
      continue;
    }
    if (cur.length && curBytes + bytes > maxBytes) flush();
    for (const r of refs) cur.push(r);
    curBytes += bytes;
  }
  flush();
  if (shards.length === 1) return [finalize(g, shards[0], g.id, sizeOf)];
  return shards.map((refs, i) => finalize(g, refs, `${g.id}.${i + 1}`, sizeOf));
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

/**
 * Builds one pack from an explicit file list: `{entry, zip}` — the art-packs.json record and the
 * deterministic zip bytes. Every entry must live under `assets/**` (an art pack may never carry a
 * code tree: js/server/index.html/__sp/extras/patches). Missing files throw (a ref must be on disk).
 */
export function buildPackFromFiles({ webroot, id, files, artVersion, allowedHosts, optional = false, warm = true, requires = [], prefixes = [] }) {
  if (!PACK_ID_RE.test(id)) throw new Error(`bad pack id ${JSON.stringify(id)} (must match ${PACK_ID_RE})`);
  const list = [...files].map(normalizeRel).sort();
  if (!list.length) throw new Error(`pack ${id}: no files`);
  const entries = [];
  let bytes = 0;
  for (const f of list) {
    if (!f.startsWith('assets/')) {
      throw new Error(`pack ${id}: entry ${f} is outside assets/ — an art pack may never carry code trees`);
    }
    const data = fs.readFileSync(path.join(webroot, f));
    bytes += data.length;
    entries.push({ name: f, data });
  }
  const zip = buildZip(entries);
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
      requires: requires.slice(),
      optional: !!optional,
      warm: !!warm,
      prefixes: prefixes.slice().sort(),
    },
    zip,
  };
}

/** Builds one pack from a whole directory (the explicit `--pack id=rel` mode). */
export function buildPack({ webroot, id, rel, artVersion, allowedHosts }) {
  const norm = normalizeRel(rel);
  const files = listFilesRecursive(webroot, norm);
  if (!files.length) throw new Error(`pack ${id}: no files under ${norm} in ${webroot}`);
  return buildPackFromFiles({ webroot, id, files, artVersion, allowedHosts, prefixes: [`${norm}/`] });
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

/** Builds the whole bucket set from the manifest refs; returns the records (in pack-id order). */
export function buildBuckets({ webroot, artVersion, allowedHosts, maxBytes, manifests }) {
  const { refs, byFile } = collectRefs(webroot, manifests);
  if (!refs.size) throw new Error(`no /assets/** refs found in ${webroot}/data (run build-webroot.mjs first)`);
  const missing = [];
  const sizeOf = (ref) => {
    try {
      return fs.statSync(path.join(webroot, ref)).size;
    } catch {
      missing.push(ref);
      return 0;
    }
  };
  const { packs, unassigned } = bucketize(refs, sizeOf, { maxBytes });
  if (unassigned.length) {
    throw new Error(`${unassigned.length} ref(s) matched no bucket rule, e.g. ${unassigned.slice(0, 3).join(', ')}`);
  }
  if (missing.length) {
    throw new Error(`${missing.length} referenced file(s) missing on disk, e.g. ${missing.slice(0, 3).join(', ')}`);
  }
  const records = [];
  for (const p of packs) {
    const { entry, zip } = buildPackFromFiles({
      webroot, id: p.id, files: p.refs, artVersion, allowedHosts,
      optional: p.optional, warm: p.warm, requires: p.requires, prefixes: p.prefixes,
    });
    records.push({ entry, zip, refs: p.refs.length });
  }
  return { records, refs, byFile };
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
  const allowedHosts = updaterAllowedHosts(arg('--updater-java'));
  if (!allowedHosts.length) throw new Error('Updater.ALLOWED_HOSTS is empty/unreadable — refusing to emit pack URLs (fail-closed)');

  const packSpecs = args('--pack');
  const wantBuckets = process.argv.includes('--buckets')
    || (!packSpecs.length && fs.existsSync(path.join(webroot, 'data', 'assets.json')));

  fs.mkdirSync(packsDir, { recursive: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const records = [];

  if (wantBuckets) {
    const maxMb = Number(arg('--max-pack-mb') || DEFAULT_MAX_PACK_BYTES / 1024 / 1024);
    if (!(maxMb > 0)) throw new Error('--max-pack-mb must be a positive number');
    const manifests = args('--manifest');
    const { records: built, refs, byFile } = buildBuckets({
      webroot, artVersion, allowedHosts, maxBytes: Math.round(maxMb * 1024 * 1024),
      manifests: manifests.length ? manifests : REF_MANIFESTS,
    });
    let rawBytes = 0;
    for (const { entry, zip } of built) {
      const file = path.join(packsDir, packZipName(entry.id, artVersion));
      fs.writeFileSync(file, zip);
      records.push(entry);
      rawBytes += entry.bytes;
      console.log(`pack ${entry.id.padEnd(22)} ${String(entry.files).padStart(5)} files  `
        + `${(entry.size / 1048576).toFixed(2).padStart(7)} MB zip  ${(entry.bytes / 1048576).toFixed(2).padStart(7)} MB raw`
        + `${entry.optional ? '  [optional]' : ''}`);
    }
    // 覆盖率证明：清单里每一个 /assets/** 引用都必须且只能落进一个 pack。
    const covered = built.reduce((n, r) => n + r.refs, 0);
    const perFile = Object.entries(byFile).map(([f, n]) => `${f}=${n}`).join(', ');
    console.log(`coverage: ${perFile}; total refs ${refs.size}, covered ${covered}/${refs.size} `
      + `(${records.length} packs, ${(rawBytes / 1048576).toFixed(1)} MB raw)`);
    if (covered !== refs.size) {
      throw new Error(`coverage gate FAILED: ${refs.size - covered} ref(s) not in exactly one pack`);
    }
  } else {
    const specs = packSpecs.length ? packSpecs : ['core.ui=assets/ui'];
    const parsed = specs.map(parsePackSpec);
    const ids = new Set();
    for (const p of parsed) {
      if (ids.has(p.id)) throw new Error(`duplicate pack id: ${p.id}`);
      ids.add(p.id);
    }
    for (const p of parsed) {
      const { entry, zip } = buildPack({ webroot, id: p.id, rel: p.rel, artVersion, allowedHosts });
      fs.writeFileSync(path.join(packsDir, packZipName(entry.id, artVersion)), zip);
      records.push(entry);
      console.log(`pack ${entry.id}: ${entry.files} files, ${(entry.size / 1024 / 1024).toFixed(2)} MB zip, `
        + `${(entry.bytes / 1024 / 1024).toFixed(2)} MB raw`);
      console.log(`  ${path.join(packsDir, packZipName(entry.id, artVersion))}`);
      console.log(`  sha256 ${entry.sha256}`);
      for (const u of entry.urls) console.log(`  url    ${u}`);
    }
  }

  fs.writeFileSync(out, JSON.stringify(records, null, 2) + '\n');
  console.log(`art-packs.json: ${out} (${records.length} pack(s), artVersion ${artVersion})`);
}

const isEntry = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntry) {
  main();
}
