// sp-mods.mjs — mod 管理器（overlay API 1）：目录代理 + 下载安装 + 启用标记。
//
// WHY (业主 2026-10-11): 「mod 管理器面板放到悬浮窗内单独按钮 …… mod 可下载 http://47.103.14.217:25570/mods」。
// 那个站只提供 /api/mods（JSON）与包 zip，**没有 CORS 头**，而页面的源是 http://127.0.0.1:<port> ——
// 浏览器直连必然被 CORS 挡掉。所以抓取与下载放在**本机 Node 侧**，页面只跟本机同源说话：
//
//   面板 → GET  /sp/mods/catalog    → 本服务去抓站点的 /api/mods，归一化后回给页面（页面零跨域）
//   面板 → POST /sp/mods/install    → 本服务下载包 zip → 校验 → 解包到 filesDir/workshop/<id>/
//   面板 → GET  /sp/mods/installed  → 已装清单（含启用状态）
//   面板 → POST /sp/mods/state      → 单个 mod 的启用开关（默认关闭）
//   面板 → POST /sp/mods/uninstall  → 删目录
//   面板 → POST /sp/mods/feature    → 管理器总开关（**默认关闭**，见下）
//
// ZERO UPSTREAM CONFLICT: 纯新增文件（tools/apk/overlay/ → 构建后 webroot/server/overlay/，随 L1 slim 热更），
// 由 extras/server/overlay-loader.mjs 在 startServer() 之后加载。不改上游一个字节，无补丁，无需重打包 APK。
//
// 落点（审计③ §2 已用代码判定）：包目录 = filesDir/workshop/，是 webroot 的**兄弟目录**。
// 热更只做 dst(webroot)→old、staging→dst 两次 rename；唯一的整目录删除 migrateWipe() 是硬编码白名单，
// 不含兄弟目录。先例是 filesDir/art（ArtStore）。**绝不能写进 webroot/**（会被整目录换掉）。
//
// 默认关闭（业主口径）：管理器总开关落在 filesDir/workshop/feature.json，**缺省 = 关闭**。
//   · 关闭时：catalog / installed / feature 仍可用（否则面板无法把开关打开，是死锁）；
//     而 install / state / uninstall 一律回 FEATURE_OFF —— 关闭状态下不会下载、不会落盘、不会生效。
//   · 单个 mod 另有一层 enabled 标记（filesDir/workshop/enabled.json），缺省 = 关闭。
//   · 注意：本行至今**没有 mod 装载器**（上游树里没有 mod 层）。所以「启用」目前只记录并回报状态，
//     不会把包的内容并进对局。装载是单独的一件事（见审计③ §5 路 A），不在这里假装做到。
//
// SECURITY (Mimosa 验收口径，tools/apk/overlay-sp-mods.test.mjs 里逐条断言)
//   1. 控制面路由只答**环回对端 + 环回 Origin**（复用 sp-connect 的 isLoopback / originAllowed）。
//   2. 出网只允许 http/https，且 host **必须在白名单里**（= 站点那一个 host），
//      环回/私网/保留/文档/组播地址一律在**发请求之前**拒掉（isDeniedTargetHost）。
//      目录里给的 download 若不是同一 host，具名拒绝 —— 目录内容**不能**把我们指向任意主机。
//   3. 解包防 zip-slip：条目名必须相对、无 `..`、无绝对路径、无反斜杠，且归一化后仍在包目录之内；
//      条目数 / 单包字节 / 解包总字节都有上限；未过校验的字节不落盘。
//   4. install() 抛异常时由 loader 记日志并跳过 —— 本文件的缺陷永远不会阻断启动。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { isDeniedTargetHost, isLoopback, originAllowed } from './sp-connect.mjs';

/** Overlay loader contract (server/overlay-loader.mjs). */
export const overlayApi = 1;
export const id = 'sp-mods';

// ---- routes -------------------------------------------------------------------------------------
export const ROUTE_CATALOG = '/sp/mods/catalog';
export const ROUTE_INSTALLED = '/sp/mods/installed';
export const ROUTE_INSTALL = '/sp/mods/install';
export const ROUTE_STATE = '/sp/mods/state';
export const ROUTE_UNINSTALL = '/sp/mods/uninstall';
export const ROUTE_FEATURE = '/sp/mods/feature';
export const ROUTES = [ROUTE_CATALOG, ROUTE_INSTALLED, ROUTE_INSTALL, ROUTE_STATE, ROUTE_UNINSTALL, ROUTE_FEATURE];

// ---- the one site we are allowed to dial --------------------------------------------------------
/** 工坊包站点（业主给定）。**唯一**被允许的出网目标。 */
export const MODS_SITE_ORIGIN = 'http://47.103.14.217:25570';
export const CATALOG_PATH = '/api/mods';

export const CATALOG_TTL_MS = 120000;
export const FETCH_TIMEOUT_MS = 15000;
export const MAX_PACK_BYTES = 64 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
export const MAX_ENTRIES = 4096;
export const MAX_NAME_LEN = 512;
export const BODY_LIMIT = 8 * 1024;

export const WORKSHOP_SUBDIR = 'workshop';
export const FEATURE_FILE = 'feature.json';
export const STATE_FILE = 'enabled.json';
export const PACK_ENTRY = 'pack.json';

/** 引擎的 mod API 世代（Forge SKILL.md §3③：当前 = 1，包要写 ">=1 <2" 或 "1.x"）。 */
export const MOD_API_VERSION = 1;

/** 本模块的版本自检（审计② §2「文件名稳定 + 模块内版本自检」）。
 *  热更只覆盖同名文件、删不掉旧文件：万一设备上同时存在本文件的另一份拷贝（改名/回退的历史残留），
 *  两份都会被 overlay-loader import 并各自 install() 一次 —— 两个版本同时挂路由。文件名必须稳定，
 *  而版本号写进日志/状态里，让「同一能力被装了两遍」在设备上可见而不是隐形。 */
export const version = 2;

// ---- A 层白名单（审计③ §5 路 A）-------------------------------------------------------------------
// 本行至今**没有 mod 装载器**（上游树里没有 mod 层），所以只收「数据层」的包：
//   · 代码入口（server / client / kits / routes）——**具名拒绝**。装了也跑不起来，还会让「已启用」
//     变成一句空话；明确拒绝比静默收下再不动要诚实。
//   · 未知字段 —— 也具名拒绝（闭集：不认识的东西不进设备，与 Stardust 适配器 v1 同判据）。
// 需要的包结构、pack.json 字段全集见 Forge 的 SKILL.md §3②（PACK_FIELDS）。
export const CODE_ENTRY_FIELDS = ['server', 'client', 'kits', 'routes'];
export const KNOWN_FIELDS = [
  // 元数据（无能力）
  'id', 'name', 'version', 'author', 'license', 'description', 'gameVersion', 'game', 'api', 'layer', 'combat',
  'playtest',
  // 声明为「数据/素材」的部分：本行收这些
  'content', 'overrides', 'operators', 'media', 'notices', 'i18n', 'assets', 'art', 'skins',
  'voices', 'voiceLangs', 'bondIcons', 'itemIcons', 'support',
  // 代码入口：出现即拒（列在这里只是为了让「未知字段」与「代码入口」两种拒绝理由分得开）
].concat(['server', 'client', 'kits', 'routes']);

// ---- paths --------------------------------------------------------------------------------------
/** filesDir/workshop —— webroot 的兄弟目录（upstreamDir = filesDir/webroot/server）。 */
export function workshopDirOf(upstreamDir) {
  if (typeof upstreamDir !== 'string' || !upstreamDir) return '';
  return path.join(path.dirname(path.dirname(upstreamDir)), WORKSHOP_SUBDIR);
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJsonFile(file, doc) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc) + String.fromCharCode(10));
    return true;
  } catch (e) {
    return false;
  }
}

/** 管理器总开关：**缺省 = 关闭**（业主口径「默认关闭」）。 */
export function featureEnabled(dir) {
  const doc = dir ? readJsonFile(path.join(dir, FEATURE_FILE)) : null;
  return !!(doc && doc.enabled === true);
}

export function setFeature(dir, on) {
  return writeJsonFile(path.join(dir, FEATURE_FILE), { enabled: on === true, at: new Date().toISOString() });
}

/** 单个 mod 的启用标记：缺省 = 关闭。 */
export function readState(dir) {
  const doc = dir ? readJsonFile(path.join(dir, STATE_FILE)) : null;
  return doc && typeof doc === 'object' && doc.mods && typeof doc.mods === 'object' ? doc.mods : {};
}

export function setState(dir, packId, on) {
  const mods = readState(dir);
  if (on === true) mods[packId] = true;
  else delete mods[packId];
  return writeJsonFile(path.join(dir, STATE_FILE), { mods: mods });
}

// ---- the site allow-list ------------------------------------------------------------------------
function siteHost() {
  try {
    return new URL(MODS_SITE_ORIGIN).hostname;
  } catch (e) {
    return '';
  }
}

/** 出网前判定：只有 http/https、只有白名单 host、且不是环回/私网/保留地址才放行。
 *  返回 {ok, reason}；reason 是具名的，页面/日志里能直接读到。 */
export function assertFetchable(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch (e) {
    return { ok: false, reason: 'BAD_URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'BAD_SCHEME' };
  if (u.username || u.password) return { ok: false, reason: 'BAD_URL' };
  const host = u.hostname.toLowerCase();
  if (isDeniedTargetHost(host)) return { ok: false, reason: 'HOST_DENIED' };
  if (host !== siteHost()) return { ok: false, reason: 'HOST_NOT_ALLOWED' };
  return { ok: true, reason: '' };
}

// ---- catalog ------------------------------------------------------------------------------------
function asText(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

function asNum(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** 站点条目 → 面板要的形状。只保留**已知字段**（目录内容不当指令用），download 一律绝对化。 */
export function normalizeEntry(raw, flagged) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const dl = asText(m.download, 2048);
  let abs = '';
  try {
    abs = dl ? new URL(dl, MODS_SITE_ORIGIN).toString() : '';
  } catch (e) {
    abs = '';
  }
  const out = {
    id: asText(m.id, 128),
    name: asText(m.name, 200),
    size: asNum(m.size),
    uploadedAt: asText(m.uploadedAt, 40),
    note: asText(m.note, 4000),
    homepage: asText(m.homepage, 2048),
    download: abs,
    flagged: flagged === true,
    suspectedReasons: Array.isArray(m.suspectedReasons)
      ? m.suspectedReasons.map((r) => asText(r, 120)).filter(Boolean).slice(0, 12)
      : [],
  };
  // 目录里若给了一个不是本站的下载地址，我们不隐藏它，但**标记为不可用**（下载前还会再判一次）。
  out.downloadAllowed = abs !== '' && assertFetchable(abs).ok;
  return out;
}

export function normalizeCatalog(json) {
  const j = json && typeof json === 'object' ? json : {};
  const mods = Array.isArray(j.mods) ? j.mods.map((m) => normalizeEntry(m, false)) : [];
  const flagged = Array.isArray(j.flagged) ? j.flagged.map((m) => normalizeEntry(m, true)) : [];
  return mods.concat(flagged).filter((m) => m.id !== '');
}

// ---- zip (self-contained reader; the device Node has no unzip API) -------------------------------
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/** 条目名安全判定（zip-slip 防护）。必须相对、无 ..、无反斜杠、无盘符、长度受限。 */
export function isSafeEntryName(name) {
  if (typeof name !== 'string' || name === '' || name.length > MAX_NAME_LEN) return false;
  if (name.includes(String.fromCharCode(92))) return false;           // 反斜杠
  if (name.startsWith('/')) return false;                             // 绝对路径
  if (/^[a-zA-Z]:/.test(name)) return false;                          // 盘符
  const parts = name.split('/');
  for (const p of parts) {
    if (p === '..') return false;
  }
  return true;
}

/** 解出中央目录里的条目表（不落盘）。返回 {ok, entries|reason}。 */
export function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return { ok: false, reason: 'BAD_ZIP' };
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return { ok: false, reason: 'BAD_ZIP' };
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) return { ok: false, reason: 'TOO_MANY_ENTRIES' };
  if (cdOff + cdSize > buf.length) return { ok: false, reason: 'BAD_ZIP' };
  const entries = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) return { ok: false, reason: 'BAD_ZIP' };
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lfhOff = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + cmtLen > buf.length) return { ok: false, reason: 'BAD_ZIP' };
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name: name, method: method, compSize: compSize, size: size, lfhOff: lfhOff });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return { ok: true, entries: entries };
}

/** 取一条条目的字节（store 或 deflate）。 */
export function readZipEntryData(buf, e) {
  if (e.lfhOff + 30 > buf.length || buf.readUInt32LE(e.lfhOff) !== LFH_SIG) return null;
  const nameLen = buf.readUInt16LE(e.lfhOff + 26);
  const extraLen = buf.readUInt16LE(e.lfhOff + 28);
  const start = e.lfhOff + 30 + nameLen + extraLen;
  if (start + e.compSize > buf.length) return null;
  const raw = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) {
    try {
      return zlib.inflateRawSync(raw, { maxOutputLength: MAX_UNPACKED_BYTES });
    } catch (err) {
      return null;
    }
  }
  return null; // 其它压缩法（bzip2/lzma/…）：具名拒绝，不猜
}

/**
 * 把包 zip 解到 destDir。**先全量校验再落盘**：任何一条不安全 / 解不开 / 超限 → 整包拒绝，
 * 目录里不留半截内容（调用方负责在失败时清掉 destDir）。
 * 返回 {ok, entries, bytes|reason}。
 */
export function extractPackZip(buf, destDir) {
  const r = readZipEntries(buf);
  if (!r.ok) return r;
  let total = 0;
  const plan = [];
  for (const e of r.entries) {
    if (e.name.endsWith('/')) continue;                    // 目录条目
    if (!isSafeEntryName(e.name)) return { ok: false, reason: 'UNSAFE_ENTRY' };
    if (e.size > MAX_UNPACKED_BYTES) return { ok: false, reason: 'ENTRY_TOO_LARGE' };
    total += e.size;
    if (total > MAX_UNPACKED_BYTES) return { ok: false, reason: 'UNPACKED_TOO_LARGE' };
    plan.push(e);
  }
  const written = [];
  for (const e of plan) {
    const data = readZipEntryData(buf, e);
    if (!data) return { ok: false, reason: 'UNSUPPORTED_ENTRY', entry: e.name };
    if (data.length !== e.size) return { ok: false, reason: 'BAD_ZIP' };
    const out = path.join(destDir, e.name);
    // 二次确认：归一化之后必须仍在 destDir 之内（与 isSafeEntryName 双保险）。
    const rel = path.relative(destDir, out);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: 'UNSAFE_ENTRY' };
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
      written.push(out);
    } catch (err) {
      return { ok: false, reason: 'WRITE_FAILED' };
    }
  }
  return { ok: true, entries: plan.length, bytes: total };
}

// ---- pack.json validation ------------------------------------------------------------------------
/** 只读**已知字段**；api 区间按 Forge 口径判定（当前世代 = 1）；
 *  **A 层白名单**：代码入口与未知字段具名拒绝（审计③ §5 路 A）。
 *  返回 {ok, pack|reason, fields}；reason 是具名的，fields 是命中的字段名（给面板解释用）。 */
export function validatePack(pack, dirName) {
  if (!pack || typeof pack !== 'object') return { ok: false, reason: 'BAD_PACK_JSON' };
  const pid = asText(pack.id, 128);
  if (pid === '') return { ok: false, reason: 'BAD_PACK_JSON' };
  if (dirName && pid !== dirName) return { ok: false, reason: 'ID_MISMATCH' };
  // 先判代码入口（比「未知字段」更具体的理由），再判未知字段。
  const code = CODE_ENTRY_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(pack, f));
  if (code.length) return { ok: false, reason: 'MOD_CODE_ENTRY_UNSUPPORTED', fields: code };
  const unknown = Object.keys(pack).filter((f) => KNOWN_FIELDS.indexOf(f) < 0);
  if (unknown.length) return { ok: false, reason: 'MOD_UNSUPPORTED_FIELD', fields: unknown.slice(0, 12) };
  const api = asText(pack.api, 40);
  if (api !== '' && !apiAllows(api, MOD_API_VERSION)) return { ok: false, reason: 'API_MISMATCH' };
  return {
    ok: true,
    pack: {
      id: pid,
      name: asText(pack.name, 200) || pid,
      version: asText(pack.version, 60),
      author: asText(pack.author, 200),
      license: asText(pack.license, 120),
      description: asText(pack.description, 4000),
      layer: asText(pack.layer, 8).toUpperCase(),
      combat: pack.combat === true,
      api: api,
      game: asText(pack.game, 40) || asText(pack.gameVersion, 40),
    },
  };
}

/** ">=1 <2" / "1.x" / "1" 这些写法里，世代 1 是否在区间内。空/不可解析 → 放行（引擎只校验合法性）。 */
export function apiAllows(range, version) {
  const s = String(range).trim();
  if (s === '') return true;
  let ok = false;
  const parts = s.split(/\s+/).filter(Boolean);
  for (const p of parts) {
    let m = /^>=\s*(\d+)(?:\.\d+)*$/.exec(p);
    if (m) { if (version >= Number(m[1])) ok = true; else return false; continue; }
    m = /^>\s*(\d+)(?:\.\d+)*$/.exec(p);
    if (m) { if (version > Number(m[1])) ok = true; else return false; continue; }
    m = /^<=\s*(\d+)(?:\.\d+)*$/.exec(p);
    if (m) { if (version <= Number(m[1])) ok = true; else return false; continue; }
    m = /^<\s*(\d+)(?:\.\d+)*$/.exec(p);
    if (m) { if (version < Number(m[1])) ok = true; else return false; continue; }
    m = /^(\d+)\.x$/.exec(p);
    if (m) { if (version === Number(m[1])) ok = true; else return false; continue; }
    m = /^(\d+)$/.exec(p);
    if (m) { if (version === Number(m[1])) ok = true; else return false; continue; }
    return true; // 无法解析的写法：不猜，放行（与引擎「只校验合法性」一致）
  }
  return ok;
}

// ---- installed inventory --------------------------------------------------------------------------
export function listInstalled(dir) {
  if (!dir) return [];
  let kids = [];
  try {
    kids = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const state = readState(dir);
  const out = [];
  for (const k of kids) {
    if (!k.isDirectory() || k.name.startsWith('.')) continue;
    const packFile = path.join(dir, k.name, PACK_ENTRY);
    const v = validatePack(readJsonFile(packFile), k.name);
    if (!v.ok) continue;
    let bytes = 0;
    try {
      bytes = dirBytes(path.join(dir, k.name));
    } catch (e) { bytes = 0; }
    out.push(Object.assign({}, v.pack, { bytes: bytes, enabled: state[k.name] === true }));
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

function dirBytes(dir) {
  let n = 0;
  const kids = fs.readdirSync(dir, { withFileTypes: true });
  for (const k of kids) {
    const p = path.join(dir, k.name);
    if (k.isDirectory()) n += dirBytes(p);
    else {
      try { n += fs.statSync(p).size; } catch (e) { /* skip */ }
    }
  }
  return n;
}

// ---- outbound fetch ------------------------------------------------------------------------------
async function fetchBuffer(url, doFetch, limit) {
  const verdict = assertFetchable(url);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  let res;
  try {
    const init = { cache: 'no-store', redirect: 'follow' };
    try { init.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS); } catch (e) { /* older runtime */ }
    res = await doFetch(url, init);
  } catch (e) {
    return { ok: false, reason: 'FETCH_FAILED' };
  }
  if (!res || res.ok !== true) return { ok: false, reason: 'HTTP_' + ((res && res.status) || 0) };
  let buf;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, reason: 'FETCH_FAILED' };
  }
  if (buf.length > limit) return { ok: false, reason: 'TOO_LARGE' };
  return { ok: true, buf: buf };
}

// ---- controller ------------------------------------------------------------------------------------
/**
 * 全部依赖可注入（fetch / clock / 目录），测试里不碰网络也不碰真盘。
 */
export function createController(options = {}) {
  const doFetch = options.fetchImpl || globalThis.fetch;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const dir = typeof options.workshopDir === 'string' ? options.workshopDir : '';
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  let cache = { at: 0, mods: [], errors: [] };

  async function catalog(force) {
    if (!force && cache.at && now() - cache.at < CATALOG_TTL_MS) return cache;
    const url = MODS_SITE_ORIGIN + CATALOG_PATH;
    const r = await fetchBuffer(url, doFetch, MAX_PACK_BYTES);
    if (!r.ok) {
      cache = { at: now(), mods: [], errors: [r.reason] };
      return cache;
    }
    let json = null;
    try {
      json = JSON.parse(r.buf.toString('utf8'));
    } catch (e) {
      json = null;
    }
    if (json === null) {
      cache = { at: now(), mods: [], errors: ['BAD_CATALOG'] };
      return cache;
    }
    const installed = listInstalled(dir);
    const byId = {};
    for (const m of installed) byId[m.id] = m;
    const mods = normalizeCatalog(json).map((m) => Object.assign({}, m, {
      installed: !!byId[m.id],
      enabled: !!(byId[m.id] && byId[m.id].enabled),
    }));
    cache = { at: now(), mods: mods, errors: [] };
    return cache;
  }

  async function install(packId) {
    if (!featureEnabled(dir)) return { ok: false, error: 'FEATURE_OFF' };
    const cat = await catalog(false);
    const hit = cat.mods.filter((m) => m.id === packId)[0];
    if (!hit) return { ok: false, error: 'NO_SUCH_MOD' };
    if (!hit.download || !hit.downloadAllowed) return { ok: false, error: 'DOWNLOAD_NOT_ALLOWED' };
    const r = await fetchBuffer(hit.download, doFetch, MAX_PACK_BYTES);
    if (!r.ok) return { ok: false, error: r.reason };
    const dest = path.join(dir, packId);
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
    } catch (e) {
      return { ok: false, error: 'WRITE_FAILED' };
    }
    const ex = extractPackZip(r.buf, dest);
    if (!ex.ok) {
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      return { ok: false, error: ex.reason, entry: ex.entry || '' };
    }
    const v = validatePack(readJsonFile(path.join(dest, PACK_ENTRY)), packId);
    if (!v.ok) {
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      return { ok: false, error: v.reason, fields: v.fields || [] };
    }
    setState(dir, packId, false); // 新装的包默认**不启用**
    log('[sp-mods] installed ' + packId + ' (' + ex.entries + ' files, ' + ex.bytes + ' B, layer ' + (v.pack.layer || '?') + ')');
    return { ok: true, id: packId, layer: v.pack.layer, api: v.pack.api, entries: ex.entries, bytes: ex.bytes };
  }

  function setEnabled(packId, on) {
    if (!featureEnabled(dir)) return { ok: false, error: 'FEATURE_OFF' };
    const known = listInstalled(dir).filter((m) => m.id === packId)[0];
    if (!known) return { ok: false, error: 'NO_SUCH_MOD' };
    if (!setState(dir, packId, on)) return { ok: false, error: 'WRITE_FAILED' };
    return { ok: true, id: packId, enabled: on === true };
  }

  function uninstall(packId) {
    if (!featureEnabled(dir)) return { ok: false, error: 'FEATURE_OFF' };
    if (!/^[A-Za-z0-9._-]+$/.test(String(packId))) return { ok: false, error: 'BAD_ID' };
    const dest = path.join(dir, packId);
    const rel = path.relative(dir, dest);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'BAD_ID' };
    try {
      fs.rmSync(dest, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, error: 'WRITE_FAILED' };
    }
    setState(dir, packId, false);
    return { ok: true, id: packId };
  }

  return {
    workshopDir: dir,
    catalog: catalog,
    install: install,
    setEnabled: setEnabled,
    uninstall: uninstall,
    installed: () => listInstalled(dir),
    feature: () => featureEnabled(dir),
    setFeature: (on) => {
      const r = setFeature(dir, on);
      return r ? { ok: true, enabled: on === true } : { ok: false, error: 'WRITE_FAILED' };
    },
    status: () => ({
      ok: true,
      version: version,
      dir: dir,
      site: MODS_SITE_ORIGIN,
      feature: featureEnabled(dir),
      installed: listInstalled(dir).length,
      modApi: MOD_API_VERSION,
    }),
  };
}

// ---- HTTP ------------------------------------------------------------------------------------------
function sendJson(res, status, doc) {
  const text = JSON.stringify(doc);
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  } catch (e) { /* client went away */ }
}

function readJsonBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          finish({});
          try { req.destroy(); } catch (e) { /* ignore */ }
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch (e) {
          finish({});
        }
      });
      req.on('error', () => finish({}));
    } catch (e) {
      finish({});
    }
  });
}

function resolveHttpServer(ctx) {
  const s = ctx && ctx.server ? ctx.server.server : null;
  if (s && typeof s.on === 'function' && typeof s.removeAllListeners === 'function') return s;
  const direct = ctx && ctx.server;
  if (direct && typeof direct.on === 'function' && typeof direct.removeAllListeners === 'function') return direct;
  return null;
}

/**
 * install(ctx) — loader contract. 控制面路由挂在上游 listener 之前，其余路径一字不动地转交。
 */
export async function install(ctx) {
  const log = typeof (ctx && ctx.log) === 'function' ? ctx.log : (m) => console.log(m);
  const workshopDir = workshopDirOf(ctx && ctx.upstreamDir);
  const controller = createController({
    log: log,
    workshopDir: workshopDir,
    // ctx.fetchImpl 只给测试/诊断用：生产永远用平台 fetch，没有任何可配置的 URL 能被拨出去。
    fetchImpl: typeof (ctx && ctx.fetchImpl) === 'function' ? ctx.fetchImpl : undefined,
  });
  if (workshopDir) {
    try { fs.mkdirSync(workshopDir, { recursive: true }); } catch (e) { /* 只读树：留着，面板会报 WRITE_FAILED */ }
  }
  log('[sp-mods] workshop=' + (workshopDir || '<none>') + ' feature=' + (controller.feature() ? 'on' : 'off (default)'));

  const server = resolveHttpServer(ctx);
  if (!server) {
    log('[sp-mods] no http server in ctx — routes not attached (controller returned for tests)');
    return controller;
  }

  const prev = server.listeners('request').slice();
  for (const l of prev) server.removeListener('request', l);

  server.on('request', (req, res) => {
    let pathname = '';
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch (e) {
      pathname = '';
    }
    if (ROUTES.indexOf(pathname) < 0) {
      for (const l of prev) l.call(server, req, res);
      return;
    }
    // 控制面：环回对端 + 环回 Origin —— 不满足就什么都不做（与 sp-connect / sp-lobby 同一道门）。
    const peerOk = isLoopback(req.socket && req.socket.remoteAddress);
    const originOk = originAllowed(req.headers && req.headers.origin);
    if (!peerOk || !originOk) {
      sendJson(res, 403, { ok: false, error: 'FORBIDDEN' });
      return;
    }
    const method = String(req.method || '').toUpperCase();

    if (pathname === ROUTE_CATALOG) {
      if (method !== 'GET') { sendJson(res, 405, { ok: false, error: 'METHOD' }); return; }
      controller.catalog(false).then((c) => {
        sendJson(res, 200, { ok: c.errors.length === 0, site: MODS_SITE_ORIGIN, at: c.at, mods: c.mods, errors: c.errors, feature: controller.feature() });
      }, () => sendJson(res, 200, { ok: false, site: MODS_SITE_ORIGIN, mods: [], errors: ['FETCH_FAILED'], feature: controller.feature() }));
      return;
    }
    if (pathname === ROUTE_INSTALLED) {
      if (method !== 'GET') { sendJson(res, 405, { ok: false, error: 'METHOD' }); return; }
      sendJson(res, 200, { ok: true, dir: workshopDir, mods: controller.installed(), feature: controller.feature() });
      return;
    }
    if (method !== 'POST') { sendJson(res, 405, { ok: false, error: 'METHOD' }); return; }

    readJsonBody(req).then(async (body) => {
      try {
        const packId = asText(body && body.id, 128);
        if (pathname === ROUTE_FEATURE) {
          sendJson(res, 200, controller.setFeature(body && body.on === true));
          return;
        }
        if (pathname === ROUTE_INSTALL) {
          sendJson(res, 200, await controller.install(packId));
          return;
        }
        if (pathname === ROUTE_STATE) {
          sendJson(res, 200, controller.setEnabled(packId, body && body.enabled === true));
          return;
        }
        if (pathname === ROUTE_UNINSTALL) {
          sendJson(res, 200, controller.uninstall(packId));
          return;
        }
      } catch (e) {
        sendJson(res, 200, { ok: false, error: 'INTERNAL' });
      }
    });
  });

  return controller;
}
