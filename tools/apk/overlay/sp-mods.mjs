// sp-mods.mjs — mod 管理器（overlay API 1）：目录代理 + 下载安装 + 启用标记。
//
// WHY (业主 2026-10-11): 「mod 管理器面板放到悬浮窗内单独按钮 …… mod 可下载 http://47.103.14.217:25570/mods」。
// 那个站只提供 /api/mods（JSON）与包 zip，**没有 CORS 头**，而页面的源是 http://127.0.0.1:<port> ——
// 浏览器直连必然被 CORS 挡掉。所以抓取与下载放在**本机 Node 侧**，页面只跟本机同源说话：
//
//   面板 → GET  /sp/mods/catalog    → 本服务去抓站点的 /api/mods，归一化后回给页面（页面零跨域）
//   面板 → POST /sp/mods/install    → 本服务下载包 zip → 校验 → 解到 filesDir/workshop/<pack.json 的 id>/
//                                     → 记来源（source.json：站点 id/URL/sha256）→ **装上即启用**
//   面板 → GET  /sp/mods/installed  → 已装清单（含启用状态与站点 id）
//   面板 → POST /sp/mods/state      → 单个 mod 的启用开关（缺省启用；显式 false = 停用）
//   面板 → POST /sp/mods/uninstall  → 删目录
//   面板 → POST /sp/mods/feature    → 管理器总开关（**缺省开启**，只用来一键停用全部）
//   页面 → GET  /sp/mods/loader     → 本页启用了哪些包、各自带什么（装载器客户端侧读它，见 modsLoader.js）
//   页面 → GET  /sp/mods/asset/<包>/<rel> → 包内素材（只读、只在包目录之内）
//   页面 → GET  /data/<kind>.json   → **有启用的包声明该 kind 时**由本服务合并后返回，否则原样转交上游
//
// 装载边界（2026-10-11，**别把没做的当已做**）：
//   · A 层（content / overrides）：**真的装载** —— 按 Forge 语义（默认只增不改；`overrides` 里写了的
//     `<kind>:<id>` 才做字段级补丁）并进 /data/*.json，包内素材路径改写成 /sp/mods/asset/…。
//   · 主题（client.theme.vars）：**真的装载** —— 客户端在页面加载时注入成一张 :root 表。
//   · 代码入口（server / client / kits / routes）：**只装不跑**。面板模块要 Forge 的面板槽契约
//     （docs/MOD-SURFACE.md 的九槽表 + 包装组件表），服务端模块要 preDispatch 钩子契约；这两套接缝
//     还没搬到本线。面板对这类包如实标「含代码」，不让「已启用」变成一句空话。
//   生效时机与 Forge 一致：**装载发生在加载时**（本服务启动/页面加载），所以装完要热重载页面或重开 APK。
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
import crypto from 'node:crypto';
import { isDeniedTargetHost, isLoopback, originAllowed } from './sp-connect.mjs';

/** zip 字节的 sha256（hex）——记进 source.json，用来对「站点上换了同 id 的包」做一眼可见的判断。 */
function sha256Hex(buf) {
  try {
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch (e) {
    return '';
  }
}

/** Overlay loader contract (server/overlay-loader.mjs). */
export const overlayApi = 1;
export const id = 'sp-mods';

/** `/sp/mods/loader` 响应体的世代（给客户端对版本用）。字段语义一变就抬，客户端不匹配即退回「未生效」。 */
export const LOADER_API = 1;

/** 这台设备认得的 Forge 面板槽名清单（与 ui/modPanels.js 的 SLOT_ANCHORS 一致）。
 *  随响应下发，mod 管理器据此判断「这包声明的槽我们有没有」——契约可查，不必硬编码。 */
export const PANEL_SLOT_NAMES = [
  'root.overlays',
  'root.guide',
  'screen.game.aside',
  'screen.game.hud',
  'screen.game.overlay',
  'screen.result.footer',
  'screen.loadout.detail',
  'screen.game.shopCard',
  'screen.game.bondStrip',
];

// ---- routes -------------------------------------------------------------------------------------
export const ROUTE_CATALOG = '/sp/mods/catalog';
export const ROUTE_INSTALLED = '/sp/mods/installed';
export const ROUTE_INSTALL = '/sp/mods/install';
export const ROUTE_STATE = '/sp/mods/state';
export const ROUTE_UNINSTALL = '/sp/mods/uninstall';
export const ROUTE_FEATURE = '/sp/mods/feature';
export const ROUTE_LOADER = '/sp/mods/loader';
export const ROUTES = [ROUTE_CATALOG, ROUTE_INSTALLED, ROUTE_INSTALL, ROUTE_STATE, ROUTE_UNINSTALL, ROUTE_FEATURE, ROUTE_LOADER];
/** 包内素材的对外前缀（装载器把包内相对路径改写成它；GET，只读包目录之内）。 */
export const ROUTE_ASSET_PREFIX = '/sp/mods/asset/';

/** 极小的 MIME 表（包内素材种类有限：图/音频/文本/字体）。未知类型一律 application/octet-stream。 */
function mimeOf(file) {
  const ext = String(file).slice(String(file).lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'json') return 'application/json; charset=utf-8';
  if (ext === 'txt' || ext === 'md') return 'text/plain; charset=utf-8';
  if (ext === 'css') return 'text/css; charset=utf-8';
  if (ext === 'js' || ext === 'mjs') return 'text/javascript; charset=utf-8';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'ogg') return 'audio/ogg';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'skel' || ext === 'atlas' || ext === 'bin') return 'application/octet-stream';
  return 'application/octet-stream';
}

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

// ---- pack.json 校验（2026-10-11：从「只收 A 层」改成「按 Forge 的闭集收全部层」）----------------------
// 业主口径（2026-10-11）：「mod 管理器界面里抓取该网站，可一键安装（参考 mod 管理器默认加载方式，安装完
// 默认启用，界面内提示热重载或重新打开 apk）」。站点目录实测 14 个包里只有 5 个是纯 A 层，其余是
// C（客户端界面）/ B（服务端逻辑）/ A+kits —— 只收 A 层等于让「一键安装」对 9/14 的包直接失败。
// 于是判据改成 Forge 的闭集：字段必须在 PACK_FIELDS 里，`api` 区间必须容得下当前世代；**层不再拒收**，
// 而是**算出来并回报**（面板据此打「含代码 / 服务端逻辑」标记，见 layerOf）。
// 需要的包结构见 Forge 的 SKILL.md §3②（PACK_FIELDS）与 docs/MOD-SURFACE.md（A/B/C 三层语义）。
export const CODE_ENTRY_FIELDS = ['server', 'client', 'kits', 'routes'];
export const KNOWN_FIELDS = [
  // 元数据（无能力）
  'id', 'name', 'version', 'author', 'license', 'description', 'gameVersion', 'game', 'api', 'layer', 'combat',
  'playtest',
  // 数据 / 素材（A 层，本机装载器会真的合并进 /data/*.json 并接管包内素材路径）
  'content', 'overrides', 'operators', 'media', 'notices', 'i18n', 'assets', 'art', 'skins',
  'voices', 'voiceLangs', 'bondIcons', 'itemIcons', 'support', 'forms', 'fx',
  // 代码入口（B/C 层）：收下并记录，装载能力见文件头「装载边界」
  'server', 'client', 'kits', 'routes',
];

/**
 * 包的层（Forge 的派生口径，逐条对齐 docs/MOD-SURFACE.md）：
 * 显式 `layer` 优先；否则按声明的入口推：有服务端逻辑 → B；只有客户端界面/主题 → C；纯数据 → A。
 * 返回 'A' | 'B' | 'C'（B+C 的包按 B 报，因为它能在服务端做事）。
 */
export function layerOf(pack) {
  const p = pack && typeof pack === 'object' ? pack : {};
  const declared = asText(p.layer, 8).toUpperCase();
  if (declared === 'A' || declared === 'B' || declared === 'C') return declared;
  const hasServer = p.server !== undefined || p.routes !== undefined;
  const hasClient = p.client !== undefined;
  const hasKits = p.kits !== undefined;
  if (hasServer) return 'B';
  if (hasClient) return 'C';
  if (hasKits) return 'A'; // kits 是干员战斗件：数据形状，装载器当 A 层收
  return 'A';
}

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

/** 管理器总开关（2026-10-11 业主口径改为**缺省 = 开启**）：装了 mod 就该生效，开关只用来一键停用全部。
 *  显式写 {enabled:false} 才是关；文件缺失/损坏 = 开（与 Forge「目录在即生效」的默认加载方式一致）。 */
export function featureEnabled(dir) {
  const doc = dir ? readJsonFile(path.join(dir, FEATURE_FILE)) : null;
  if (!doc || typeof doc !== 'object') return true;
  return doc.enabled !== false;
}

export function setFeature(dir, on) {
  return writeJsonFile(path.join(dir, FEATURE_FILE), { enabled: on === true, at: new Date().toISOString() });
}

/** 单个 mod 的启用标记（2026-10-11 起**缺省 = 开启**：装上即启用，见 install()）。
 *  显式 false 才是停用；条目不存在 = 启用。 */
export function readState(dir) {
  const doc = dir ? readJsonFile(path.join(dir, STATE_FILE)) : null;
  return doc && typeof doc === 'object' && doc.mods && typeof doc.mods === 'object' ? doc.mods : {};
}

export function setState(dir, packId, on) {
  const mods = readState(dir);
  mods[packId] = on === true; // 显式记 true/false：缺省虽是「开」，但停用必须留痕
  return writeJsonFile(path.join(dir, STATE_FILE), { mods: mods });
}

/** 一个包此刻是否启用：显式 false = 停用，其余（true / 无记录）= 启用。 */
export function isEnabled(state, packId) {
  const s = state && typeof state === 'object' ? state : {};
  return s[packId] !== false;
}

// ---- 来源记账（source.json）：目录 id ≠ 站点 catalogue id，两边都要记 -------------------------------
export const SOURCE_FILE = 'source.json';

/** 安装时写下的来源：站点条目 id（哈希）、下载 URL、zip sha256、时间。目录名 = pack.json 的 id。 */
export function readSource(packDir) {
  return readJsonFile(path.join(packDir, SOURCE_FILE));
}

function writeSource(packDir, doc) {
  return writeJsonFile(path.join(packDir, SOURCE_FILE), doc);
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
    // 站点 2026-10 起的字段：kind（compat=兼容改写版）、原作者 / 兼容改写者 / 由哪个原件改写、
    // 疑似官方素材的原因。面板照实显示（目录内容当数据用，不当指令）。
    kind: asText(m.kind, 40),
    author: asText(m.author, 200),
    compatAuthor: asText(m.compatAuthor, 200),
    compatOf: asText(m.compatOf, 64),
    compatNote: asText(m.compatNote, 2000),
    suspected: m.suspected === true,
    suspectedReasons: Array.isArray(m.suspectedReasons)
      ? m.suspectedReasons.map((r) => asText(r, 120)).filter(Boolean).slice(0, 12)
      : [],
    // 站点 2026-10 起的字段：这条条目对应的 pack.json id（「同 id 多条」与「已装」判据都要它）。
    packId: asText(m.packId, 128),
    // 站点 2026-10-13 起的**分类**字段（业主：「分类按站上来」）：packKind = 技术维度
    // （functional 装上会生效 / documentation 只是说明 / unknown），funcKind = 功能维度
    // （gameplay / utility / expansion / assets / documentation），funcKindTitle = 它的中文标签。
    // 面板据此做筛选；标签一律**用站点给的那份**，不在本地另编一套（站点加了新分类要能自动出现）。
    packKind: asText(m.packKind, 40),
    funcKind: asText(m.funcKind, 40),
    funcKindTitle: asText(m.funcKindTitle, 40),
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
/** 只读**已知字段**；api 区间按 Forge 口径判定（当前世代 = 1）；**层不拒收，算出来回报**（见 layerOf）。
 *  返回 {ok, pack|reason, fields}；reason 是具名的，fields 是命中的字段名（给面板解释用）。 */
export function validatePack(pack, dirName) {
  if (!pack || typeof pack !== 'object') return { ok: false, reason: 'BAD_PACK_JSON' };
  const pid = asText(pack.id, 128);
  if (pid === '') return { ok: false, reason: 'BAD_PACK_JSON' };
  if (dirName && pid !== dirName) return { ok: false, reason: 'ID_MISMATCH' };
  const unknown = Object.keys(pack).filter((f) => KNOWN_FIELDS.indexOf(f) < 0);
  if (unknown.length) return { ok: false, reason: 'MOD_UNSUPPORTED_FIELD', fields: unknown.slice(0, 12) };
  const api = asText(pack.api, 40);
  if (api !== '' && !apiAllows(api, MOD_API_VERSION)) return { ok: false, reason: 'API_MISMATCH' };
  const code = CODE_ENTRY_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(pack, f));
  return {
    ok: true,
    pack: {
      id: pid,
      name: asText(pack.name, 200) || pid,
      version: asText(pack.version, 60),
      author: asText(pack.author, 200),
      license: asText(pack.license, 120),
      description: asText(pack.description, 4000),
      layer: layerOf(pack),
      // 代码入口：收下但**如实回报**（面板给「含代码」标记；能不能跑见文件头「装载边界」）
      code: code,
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
    const src = readSource(path.join(dir, k.name));
    out.push(Object.assign({}, v.pack, {
      bytes: bytes,
      enabled: isEnabled(state, k.name),
      // 站点条目 id（哈希）：目录名是 pack.json 的 id，两者不同，面板靠它对上目录
      siteId: src && typeof src.siteId === 'string' ? src.siteId : '',
      installedAt: src && typeof src.at === 'string' ? src.at : '',
      // 下载当时的 zip 字节数（装完就没再量过）。与站点 size 同单位，是「同 id 换了内容」的兜底判据；
      // source.json 是老格式（没有 bytes 字段）时为 0，调用方据此判定「这条判据不可用」。
      zipBytes: src && typeof src.bytes === 'number' ? src.bytes : 0,
    }));
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

// ---- 装载器 v1（A 层数据合并 + 包内素材接管；B/C 的代码入口见文件头「装载边界」）-------------------
/**
 * 把一个 data 文件的记录表与一个包的记录表合并（Forge 的语义，逐条对齐 docs/WORKSHOP.md）：
 *   · **默认只增不改**：官方已有、且没写进 `overrides` 的 id —— 跳过（不动官方数据）。
 *   · `overrides` 里写了 `<kind>:<id>` 的 —— **按字段打补丁**（不是整条替换）：包给的字段覆盖，
 *     包没给的字段保留官方的。
 *   · 官方没有的 id —— 直接新增。
 * 返回 {records, added, patched, skipped}；纯函数（不碰盘、不改入参）。
 */
export function mergeRecords(base, packRecords, overrides, kind) {
  const out = Object.assign({}, base && typeof base === 'object' ? base : {});
  const add = packRecords && typeof packRecords === 'object' ? packRecords : {};
  const allow = {};
  for (const o of Array.isArray(overrides) ? overrides : []) {
    const s = String(o);
    const i = s.indexOf(':');
    if (i > 0 && s.slice(0, i) === kind) allow[s.slice(i + 1)] = true;
  }
  let added = 0, patched = 0, skipped = 0;
  for (const id of Object.keys(add)) {
    const rec = add[id];
    if (!rec || typeof rec !== 'object') continue;
    const has = Object.prototype.hasOwnProperty.call(out, id);
    if (!has) { out[id] = rec; added++; continue; }
    if (!allow[id]) { skipped++; continue; }           // 官方已有 + 未声明覆盖 ⇒ 不动
    const prev = out[id] && typeof out[id] === 'object' ? out[id] : {};
    out[id] = Object.assign({}, prev, rec);            // 字段级补丁
    patched++;
  }
  return { records: out, added: added, patched: patched, skipped: skipped };
}

/** 包内素材的对外 URL（同源，走本服务的 /sp/mods/asset/<packId>/<rel>）。 */
export function packAssetUrl(packId, rel) {
  return '/sp/mods/asset/' + encodeURIComponent(packId) + '/' + String(rel).split('/').map(encodeURIComponent).join('/');
}

/**
 * 把一条记录里「包内相对素材路径」改写成可取的 URL：只有**当那个文件真的在该包里存在**时才改写
 * （inPack 判定注入进来，纯函数好测）。字符串值以 '/' 开头、或以 http(s) 开头的都不动 —— 那些不是
 * 包内相对路径。递归走对象与数组，深度受限。
 */
export function rewritePackPaths(value, inPack, urlOf, depth) {
  const d = typeof depth === 'number' ? depth : 0;
  if (d > 8) return value;
  if (typeof value === 'string') {
    if (!value || value.charAt(0) === '/' || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value;
    return inPack(value) ? urlOf(value) : value;
  }
  if (Array.isArray(value)) return value.map((v) => rewritePackPaths(v, inPack, urlOf, d + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = rewritePackPaths(value[k], inPack, urlOf, d + 1);
    return out;
  }
  return value;
}

// ---- 服务端接缝：preDispatch（叠加层端点，2026-10-12）------------------------------------------------
// 业主口径：「给 mod 管理器做叠加层端点，不和上游冲突」。审计结论（server/index.js:135、net.js:508/563/613、
// lobby.js:334）：
//   · 上游**不导出任何模块级单例** —— http server / wss / network / lobby / registry 只活在 startServer()
//     的返回对象里，而这个对象经 overlay loader 原样交给 overlay（ctx.server = {server,wss,lobby,network,
//     registry,packs}，见 tools/apk/extras/server/overlay-loader.mjs 的契约）。
//   · 于是「不改上游一个字节」也能在**实例方法**上做前置钩子：`ws.on('message')` 回调里是 `this.onFrame(...)`，
//     onFrame 里是 `this.onHelloMsg(...)`，而 `network.handler.onMessage` 也是普通实例属性 —— **每次读取**，
//     所以影子方法（own property）会被采纳；卸载时 delete 影子即恢复原样。
//   · 钩子次序照 Forge（docs/WORKSHOP.md §1.9.1、其 server/modDispatch.js）：速率限制 → 解码 → validateC2S →
//     **preDispatch** → ping/hello 与会话检查 → 分发。我们的等价落点：`intercepts` 含 'hello' 的挂在
//     `onHelloMsg` 之前；其余类型挂在 `handler.onMessage` 之前（都在校验之后、真正处理之前）。
//   · 契约照抄真包：模块导出 **`createPreDispatch(deps)`**，deps = `{policy, intercepts, c2s, log, now, send}`，
//     返回 `{preDispatch(conn, msg) → boolean}`，**true = 消费**（这条消息不再进引擎）；可选导出
//     `validatePolicy(policy)`（返回字符串 = 装载期点名拒绝）。**每个连接一个实例**（挂在 conn 上）。
//   · 失败姿态：装载期点名拒绝（模块导入失败 / 工厂没返回 preDispatch / validatePolicy 拒绝）；运行期钩子抛错
//     = **不否决**（fail-open，消息照常分发）并记一条 error —— 与 Forge 逐字同姿态。
export const SERVER_HOOK_MEMBERS = ['preDispatch', 'meta', 'modules', 'battle', 'room'];

/** 读一个包的 `server.preDispatch` 声明（形状层；不认识就不认这条钩子）。 */
export function readPreDispatchDecl(pack) {
  const srv = pack && typeof pack.server === 'object' && pack.server ? pack.server : null;
  if (!srv) return null;
  const pd = srv.preDispatch;
  if (!pd || typeof pd !== 'object') return null;
  const module_ = asText(pd.module, 256);
  if (!module_) return null;
  return {
    module: module_,
    policy: asText(pd.policy, 256),
    intercepts: Array.isArray(pd.intercepts)
      ? pd.intercepts.filter((t) => typeof t === 'string' && t).slice(0, 32)
      : [],
  };
}

/**
 * 装载全部启用包的 preDispatch 钩子。返回 `{hooks, notes}`：hooks 每项 = `{pack, decl, create}`，
 * `create` 是那个模块的工厂（每连接调用一次）。**任何一条装不上都点名**（notes），不影响别的包。
 */
export async function loadPreDispatchHooks(packs, log) {
  const hooks = [];
  const notes = [];
  for (const p of packs) {
    const decl = readPreDispatchDecl(p.doc);
    if (!decl) continue;
    const file = path.join(p.dir, decl.module);
    const rel = path.relative(p.dir, file);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      notes.push({ pack: p.id, reason: 'BAD_MODULE_PATH' });
      continue;
    }
    let mod = null;
    try {
      mod = await import(pathToFileURLSafe(file));
    } catch (e) {
      notes.push({ pack: p.id, reason: 'IMPORT_FAILED', detail: String((e && e.message) || e).slice(0, 160) });
      continue;
    }
    const create = mod && (typeof mod.createPreDispatch === 'function' ? mod.createPreDispatch
      : (mod.default && typeof mod.default.createPreDispatch === 'function' ? mod.default.createPreDispatch : null));
    if (typeof create !== 'function') {
      notes.push({ pack: p.id, reason: 'NO_FACTORY' });
      continue;
    }
    // 可选自检（Forge 的「加载期点名拒绝」）：返回字符串 = 拒绝理由。
    let policy = null;
    if (decl.policy) {
      const pf = path.join(p.dir, decl.policy);
      const prel = path.relative(p.dir, pf);
      if (prel === '' || prel.startsWith('..') || path.isAbsolute(prel)) {
        notes.push({ pack: p.id, reason: 'BAD_POLICY_PATH' });
        continue;
      }
      policy = readJsonFile(pf);
      if (policy === null) {
        notes.push({ pack: p.id, reason: 'POLICY_UNREADABLE', detail: decl.policy });
        continue;
      }
    }
    if (typeof mod.validatePolicy === 'function') {
      let verdict = null;
      try {
        verdict = mod.validatePolicy(policy);
      } catch (e) {
        verdict = 'validatePolicy threw: ' + String((e && e.message) || e).slice(0, 120);
      }
      if (typeof verdict === 'string' && verdict) {
        notes.push({ pack: p.id, reason: 'POLICY_REJECTED', detail: verdict.slice(0, 160) });
        continue;
      }
    }
    hooks.push({ pack: p.id, decl: decl, create: create, policy: policy });
  }
  if (notes.length && typeof log === 'function') {
    for (const n of notes) log('[sp-mods] server hook not installed: ' + n.pack + ' (' + n.reason + (n.detail ? ': ' + n.detail : '') + ')');
  }
  return { hooks: hooks, notes: notes };
}

/** file:// URL（Windows 路径要先转正斜杠；pathToFileURL 在这里手写，避免为一行引入 node:url 的差异）。 */
function pathToFileURLSafe(file) {
  let p = String(file).replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  return 'file://' + p.split('/').map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join('/');
}

/**
 * 把钩子装到**活的**服务端对象上（ctx.server）。返回 `{installed, notes, detach}`；detach 用来恢复原样
 * （测试与「停用管理器」都需要）。任何一步失败都退回原方法，绝不半挂。
 */
export function attachServerHooks(srv, hooks, log) {
  const notes = [];
  const net = srv && srv.network ? srv.network : null;
  const handler = net && net.handler ? net.handler : null;
  if (!hooks || !hooks.length) return { installed: [], notes: notes, detach: () => {} };
  // 唯一的硬要求是 `onHelloMsg`（hello 钩子的落点）与 `reply`（钩子回帧）；C2S 那条路是可选的
  // （handler.onMessage 不存在时只装 hello 钩子，不半挂）。
  if (!net || typeof net.onHelloMsg !== 'function' || typeof net.reply !== 'function') {
    notes.push({ reason: 'NO_NETWORK_SEAM' });
    return { installed: [], notes: notes, detach: () => {} };
  }
  if (net.__spModHooks) return { installed: net.__spModHooks.installed, notes: net.__spModHooks.notes, detach: net.__spModHooks.detach };

  const helloHooks = hooks.filter((h) => h.decl.intercepts.indexOf('hello') >= 0);
  const c2sHooks = hooks.filter((h) => h.decl.intercepts.indexOf('hello') < 0);
  const installed = hooks.map((h) => ({ pack: h.pack, intercepts: h.decl.intercepts, installed: true }));
  const logger = {
    info: (...a) => { try { if (typeof log === 'function') log(a.join(' ')); } catch (e) { /* ignore */ } },
    warn: (...a) => { try { if (typeof log === 'function') log('WARN ' + a.join(' ')); } catch (e) { /* ignore */ } },
    error: (...a) => { try { if (typeof log === 'function') log('ERROR ' + a.join(' ')); } catch (e) { /* ignore */ } },
  };
  let c2sTable = null; // shared/protocol.js 的 C2S（拿不到就 null：钩子契约里它是只读信息）

  const origOnHelloMsg = net.onHelloMsg;
  const origOnMessage = handler && typeof handler.onMessage === 'function' ? handler.onMessage : null;

  /** 每个连接一份实例（契约：deps 冻结、实例只挂这条连接）。 */
  function instancesFor(conn) {
    if (conn.__spPreInstances) return conn.__spPreInstances;
    const deps = Object.freeze({
      intercepts: Object.freeze(hooks.reduce((a, h) => a.concat(h.decl.intercepts), [])),
      c2s: c2sTable,
      log: Object.freeze(logger),
      now: () => Date.now(),
      send: (c, m) => { try { return net.reply(c, m); } catch (e) { return null; } },
    });
    const out = [];
    for (const h of hooks) {
      try {
        const inst = h.create(Object.assign({ policy: h.policy }, deps));
        if (!inst || typeof inst.preDispatch !== 'function') {
          logger.error('[sp-mods] ' + h.pack + ': factory returned no preDispatch(conn, msg) — hook not installed on this connection');
          continue;
        }
        out.push({ pack: h.pack, intercepts: h.decl.intercepts, instance: inst });
      } catch (e) {
        logger.error('[sp-mods] ' + h.pack + ': preDispatch factory threw — hook not installed on this connection', String((e && e.message) || e));
      }
    }
    conn.__spPreInstances = out;
    return out;
  }

  /** 跑一类钩子；任一返回 true = 消费（不调原方法）。钩子抛错 = 不否决（fail-open）。 */
  function runHooks(conn, msg, list) {
    const insts = instancesFor(conn);
    for (const it of insts) {
      if (list === 'hello' && it.intercepts.indexOf('hello') < 0) continue;
      if (list === 'c2s' && it.intercepts.indexOf('hello') >= 0) continue;
      let verdict = false;
      try {
        verdict = it.instance.preDispatch(conn, msg) === true;
      } catch (e) {
        logger.error('[sp-mods] ' + it.pack + ': preDispatch threw — treating as NO veto', String((e && e.message) || e));
        verdict = false;
      }
      if (verdict) {
        logger.info('[sp-mods] ' + it.pack + ': consumed ' + (msg && msg.t) + ' before dispatch');
        return true;
      }
    }
    return false;
  }

  // session → conn：`onMessage(session, msg)` 只拿到 session，而钩子契约要的是 conn（`deps.send(conn, …)`
  // 要用它回帧）。hello 那条路径本来就有 conn，所以在那里记一笔即可；没有 conn 就不跑 c2s 钩子（点名一次）。
  const connByWs = new WeakMap();
  let c2sNoConnNoted = false;

  net.onHelloMsg = function (conn, msg, now) {
    try { if (conn && conn.ws) connByWs.set(conn.ws, conn); } catch (e) { /* ignore */ }
    if (runHooks(conn, msg, 'hello')) return; // 被否掉的 hello 不进大厅（也不建会话）
    return origOnHelloMsg.apply(this, arguments);
  };
  if (origOnMessage) {
    handler.onMessage = function (session, msg) {
      const conn = session && session.ws ? connByWs.get(session.ws) : null;
      if (conn && runHooks(conn, msg, 'c2s')) return undefined;
      if (!conn && !c2sNoConnNoted) {
        c2sNoConnNoted = true;
        logger.warn('[sp-mods] a C2S message arrived with no known connection — the c2s hooks were skipped for it');
      }
      return origOnMessage.apply(this, arguments);
    };
  }

  const detach = () => {
    try {
      net.onHelloMsg = origOnHelloMsg;
      if (origOnMessage) handler.onMessage = origOnMessage;
      delete net.__spModHooks;
    } catch (e) { /* ignore */ }
  };
  net.__spModHooks = { installed: installed, notes: notes, detach: detach };
  // c2s 表：best-effort（拿不到不影响 hello 钩子）
  try {
    const here = path.dirname(pathToFileURLSafe(import.meta.url).replace('file://', ''));
    import(pathToFileURLSafe(path.join(here, '..', '..', 'shared', 'protocol.js'))).then((m) => {
      c2sTable = m && m.C2S ? m.C2S : null;
    }, () => { /* 拿不到就 null */ });
  } catch (e) { /* ignore */ }
  return { installed: installed, notes: notes, detach: detach };
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
  let serverHooks = []; // 服务端接缝的装载结果（install(ctx) 里填；面板据此显示「服务端钩子」）

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
    // 站点条目 id（哈希）≠ 包 id：两边都试（source.json 记的 siteId 优先，兼容早期按目录名装的包）。
    const bySite = {};
    const byPack = {};
    for (const m of installed) {
      if (m.siteId) bySite[m.siteId] = m;
      byPack[m.id] = m;
    }
    // 同一个 pack id 在站点上出现多条（站侧「改名重投」「旧 compat 被新版取代」的产物）：按 packId 归组，
    // 组内 >1 条就逐条标注，让面板如实显示「同 id 另一条：<名称>」——不替用户挑，因为只有站点 note
    // 知道哪条是该留的（duel-assets 的 note 明写「请以本条为准」，那是人写的判断，不是可推的）。
    const normalized = normalizeCatalog(json);
    const byPackId = {};
    for (const m of normalized) if (m.packId) (byPackId[m.packId] = byPackId[m.packId] || []).push(m);
    // 分类清单（业主 2026-10-13「分类按站上来（做成可更新样式）」）：**不本地硬编码**。
    // 站点 /api/mods 顶层给了 funcs（分类键）与 funcKindTitles（中文标签），有就用它；
    // 缺了就从条目里推。只保留**有条目**的分类（空分类是噪音），顺序跟站点的声明序。
    // 站点加一个新分类 → 下次拉目录自动出现在面板里，不需要改我们的代码。
    const funcCounts = {};
    for (const m of normalized) if (m.funcKind) funcCounts[m.funcKind] = (funcCounts[m.funcKind] || 0) + 1;
    const declaredFuncs = Array.isArray(json.funcs) ? json.funcs.map((x) => asText(x, 40)).filter(Boolean) : [];
    const funcTitles = (json.funcKindTitles && typeof json.funcKindTitles === 'object') ? json.funcKindTitles : {};
    const funcOrder = declaredFuncs.length ? declaredFuncs : Object.keys(funcCounts);
    const funcs = funcOrder
      .filter((k) => funcCounts[k] > 0)
      .map((k) => ({ kind: k, title: asText(funcTitles[k], 40) || k, count: funcCounts[k] }));
    const mods = normalized.map((m) => {
      const hit = bySite[m.id] || byPack[m.id] || null;
      // 「站点有新版」：站点条目比本机这份新。站点没有版本号字段（只有 uploadedAt / size），所以判据用
      // ① 站点上传时间晚于本机安装时间（source.json.at）② 或 zip 字节数不同（同 id 换内容的兜底）。
      // 注意②比的是**zip 大小对 zip 大小**：站点 size 是压缩包字节，装机侧只有解包后的目录大小
      // （dirBytes），两者永远不相等 —— 早期版本拿它们相比，结果是对每个包都恒报「有新版」。
      // source.json 里没有 bytes 的存量装机一律不参与②：宁可漏报，不要误报一个「更新」。
      let updateAvailable = false;
      if (hit && typeof hit.installedAt === 'string' && hit.installedAt) {
        const siteAt = typeof m.uploadedAt === 'string' ? Date.parse(m.uploadedAt) : NaN;
        const mineAt = Date.parse(hit.installedAt);
        if (Number.isFinite(siteAt) && Number.isFinite(mineAt)) updateAvailable = siteAt > mineAt;
        else if (typeof m.size === 'number' && typeof hit.zipBytes === 'number' && hit.zipBytes > 0) updateAvailable = m.size !== hit.zipBytes;
      }
      const sameId = m.packId ? (byPackId[m.packId] || []).filter((x) => x.id !== m.id) : [];
      return Object.assign({}, m, {
        installed: !!hit,
        enabled: !!(hit && hit.enabled),
        // packId 原样透出站点声明的那一个（= 这条条目装上去的 pack.json id），同 id 归组就靠它。
        // 已装目录的 id 另起一个名字：它和 packId 在「站点改名重投」时并不同值，合成一个字段会互相盖。
        installedId: hit ? hit.id : '',
        layer: hit ? hit.layer : '',
        installedAt: hit && typeof hit.installedAt === 'string' ? hit.installedAt : '',
        updateAvailable: updateAvailable,
        sameIdCount: sameId.length,
        sameIdNames: sameId.map((x) => x.name || x.id).slice(0, 4),
      });
    });
    cache = { at: now(), mods: mods, errors: [], funcs: funcs };
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
    // 站点条目 id（哈希）**不是**包 id：先解到临时目录，读 pack.json 拿到真 id，校验通过再原子改名。
    // （原来直接解到 dir/<站点 id> 再按目录名校验 ⇒ 站点上每一个包都必然 ID_MISMATCH，一键安装全废。）
    const stage = path.join(dir, '.stage-' + String(packId).replace(/[^A-Za-z0-9._-]/g, '_'));
    try {
      fs.rmSync(stage, { recursive: true, force: true });
      fs.mkdirSync(stage, { recursive: true });
    } catch (e) {
      return { ok: false, error: 'WRITE_FAILED' };
    }
    const ex = extractPackZip(r.buf, stage);
    if (!ex.ok) {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      return { ok: false, error: ex.reason, entry: ex.entry || '' };
    }
    const raw = readJsonFile(path.join(stage, PACK_ENTRY));
    const rawId = asText(raw && raw.id, 128);
    if (rawId === '' || !/^[A-Za-z0-9._-]+$/.test(rawId)) {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      return { ok: false, error: 'BAD_PACK_JSON' };
    }
    const v = validatePack(raw, rawId); // 目录名 = 包自己的 id ⇒ ID_MISMATCH 只对「真的自相矛盾」的包报
    if (!v.ok) {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      return { ok: false, error: v.reason, fields: v.fields || [] };
    }
    const dest = path.join(dir, rawId);
    // 覆盖安装：**先把旧目录整个改名到一边**（而不是直接删），新包原子搬入成功后再删备份。
    // 顺序反过来的话，rmSync 之后一旦 rename 失败，现场只剩一个新目录的残骸：旧包没了，
    // enabled.json 里还留着一条启用标记 —— 面板上是个「已启用但读不出来」的幽灵。
    // 改名到 .old-<id> 让失败路径变成「把备份改名回来」，一次 rename 就完整还原（文件、启用标记、
    // source.json 全在），不需要把任何东西读进内存再拼回去。
    const backup = path.join(dir, '.old-' + rawId);
    let moved = false;
    try {
      try { fs.rmSync(backup, { recursive: true, force: true }); } catch (e0) { /* 本来就没有 */ }
      if (fs.existsSync(dest)) { fs.renameSync(dest, backup); moved = true; }
      fs.renameSync(stage, dest);
    } catch (e) {
      if (moved) {
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
        try { fs.renameSync(backup, dest); } catch (e2) {
          // 连还原都失败：旧包还在 .old- 里，下一次装同一个包时会被清掉。日志里必须看得见。
          log('[sp-mods] install of ' + rawId + ' failed AND the rollback failed; the old copy is at '
            + backup + ': ' + (e2 && e2.message));
        }
      }
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
      log('[sp-mods] install of ' + rawId + ' failed; the previous version was kept: ' + (e && e.message));
      return { ok: false, error: 'WRITE_FAILED' };
    }
    if (moved) {
      try { fs.rmSync(backup, { recursive: true, force: true }); } catch (e) { /* 新包已就位，备份删不掉只是占点空间 */ }
    }
    const sha = sha256Hex(r.buf);
    writeSource(dest, {
      siteId: String(packId), url: hit.download, sha256: sha, kind: asText(hit.kind, 40),
      name: asText(hit.name, 200), at: new Date().toISOString(),
      // zip 字节数：与站点 size 同单位，catalog() 判「同 id 换了内容」时比这个（比解包后的目录大小永远不等）
      bytes: r.buf.length,
    });
    setState(dir, rawId, true); // 业主口径 2026-10-11：**装上即启用**（Forge 的默认加载方式）
    log('[sp-mods] installed ' + rawId + ' (site ' + packId + ', ' + ex.entries + ' files, ' + ex.bytes
      + ' B, layer ' + (v.pack.layer || '?') + ', code ' + (v.pack.code || []).join('/') + ')');
    return {
      ok: true, id: rawId, siteId: String(packId), layer: v.pack.layer, code: v.pack.code,
      api: v.pack.api, entries: ex.entries, bytes: ex.bytes, enabled: true, sha256: sha,
    };
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

  /** 启用的包（含各自 pack.json 全文；装载器与 /sp/mods/loader 都从这里取）。 */
  function enabledPacks() {
    if (!featureEnabled(dir)) return [];
    const state = readState(dir);
    const out = [];
    for (const m of listInstalled(dir)) {
      if (!isEnabled(state, m.id)) continue;
      const doc = readJsonFile(path.join(dir, m.id, PACK_ENTRY));
      if (!doc) continue;
      out.push({ id: m.id, layer: m.layer, code: m.code || [], doc: doc, dir: path.join(dir, m.id) });
    }
    return out;
  }

  /** 一个 data 文件的合并结果；没有启用的包声明它 → null（调用方原样转交上游）。 */
  function dataFile(kind) {
    const packs = enabledPacks().filter((p) => Array.isArray(p.doc.content) && p.doc.content.indexOf(kind) >= 0);
    if (!packs.length) return null;
    const base = readJsonFile(path.join(path.dirname(dir), 'webroot', 'data', kind + '.json'));
    if (!base || typeof base !== 'object') return null;
    let records = base;
    const report = [];
    for (const p of packs) {
      const add = readJsonFile(path.join(dir, p.id, kind + '.json'));
      if (!add || typeof add !== 'object') continue;
      const m = mergeRecords(records, add, p.doc.overrides, kind);
      const packRoot = path.join(dir, p.id);
      const seen = {};                                   // 包内存在性：一次 stat 一次，避免逐字符串重复探
      const inPack = (rel) => {
        if (Object.prototype.hasOwnProperty.call(seen, rel)) return seen[rel];
        let yes = false;
        try {
          const f = path.join(packRoot, rel);
          const r = path.relative(packRoot, f);
          yes = r !== '' && !r.startsWith('..') && !path.isAbsolute(r) && fs.statSync(f).isFile();
        } catch (e) { yes = false; }
        seen[rel] = yes;
        return yes;
      };
      const urlOf = (rel) => packAssetUrl(p.id, rel);
      const out = {};
      for (const id of Object.keys(m.records)) out[id] = rewritePackPaths(m.records[id], inPack, urlOf, 0);
      records = out;
      report.push({ id: p.id, added: m.added, patched: m.patched, skipped: m.skipped });
    }
    return { kind: kind, records: records, report: report };
  }

  /** 包内素材文件（安全解析到包目录之内）；不给就返回 null。 */
  function assetFile(packId, rel) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(packId))) return null;
    const parts = String(rel || '').split('/').filter(Boolean);
    if (!parts.length || parts.some((p) => p === '..' || p === '.')) return null;
    const root = path.join(dir, String(packId));
    const f = path.join(root, parts.join('/'));
    const r = path.relative(root, f);
    if (r === '' || r.startsWith('..') || path.isAbsolute(r)) return null;
    try {
      return fs.statSync(f).isFile() ? f : null;
    } catch (e) {
      return null;
    }
  }

  /** 页面在**加载时**读一次：哪些包启用了、各自带什么（A 层内容 / 主题 / 代码入口 / 面板数）。
   *  客户端据此注入主题、挂面板（见 ui/modsLoader.js 与 ui/modPanels.js）；热重载/重开 APK 后重新读一次即可。
   *  面板条目里的 module/styles 一律换成**本服务可取的 URL**（/sp/mods/asset/<包>/<rel>），页面拿到就能
   *  `import()` —— Forge 用 /workshop-panels/<包>/<模块>，我们复用素材路由，语义一致（只服务包内登记的文件）。 */
  function loaderManifest() {
    const packs = enabledPacks().map((p) => {
      const client = p.doc.client && typeof p.doc.client === 'object' ? p.doc.client : {};
      const panels = Array.isArray(client.panels) ? client.panels.map((x) => {
        const panel = x && typeof x === 'object' ? x : {};
        return {
          id: asText(panel.id, 64),
          slot: asText(panel.slot, 64),
          order: asNum(panel.order),
          gate: panel.gate === undefined ? null : panel.gate,
          module: typeof panel.module === 'string' && panel.module ? packAssetUrl(p.id, panel.module) : '',
          styles: Array.isArray(panel.styles)
            ? panel.styles.filter((s) => typeof s === 'string' && s).map((s) => packAssetUrl(p.id, s)).slice(0, 8)
            : [],
        };
      }).filter((x) => x.id && x.slot && x.module) : [];
      return {
        id: p.id,
        layer: p.layer,
        code: p.code,
        content: Array.isArray(p.doc.content) ? p.doc.content.slice(0, 24) : [],
        theme: client.theme && typeof client.theme === 'object' ? client.theme : null,
        panels: panels,
        combat: p.doc.combat === true,
      };
    });
    // 契约版本（2026-10-12）：热更只覆盖同名文件、删不掉旧文件，新旧两端可能短暂错配。
    // 客户端（ui/modsLoader.js）先比 loaderApi 再用响应，不匹配就静默退回「未生效」——
    // 免得老客户端按新语义去读一个它不认识的字段，装出谁也说不清的结果。
    // slots 是这台设备认得的槽名清单：mod 管理器可以自己查，不必硬编码九槽表。
    return {
      feature: featureEnabled(dir),
      packs: packs,
      dataKinds: Array.from(new Set(packs.reduce((a, p) => a.concat(p.content), []))).sort(),
      panelCount: packs.reduce((a, p) => a + p.panels.length, 0),
      serverHooks: serverHooks,
      loaderApi: LOADER_API,
      overlayApi: overlayApi,
      fileVersion: version,
      slots: PANEL_SLOT_NAMES,
    };
  }

  return {
    workshopDir: dir,
    catalog: catalog,
    install: install,
    setEnabled: setEnabled,
    uninstall: uninstall,
    installed: () => listInstalled(dir),
    feature: () => featureEnabled(dir),
    dataFile: dataFile,
    assetFile: assetFile,
    loaderManifest: loaderManifest,
    enabledPacks: enabledPacks,
    setServerHooks: (list) => { serverHooks = Array.isArray(list) ? list : []; },
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

  // ---- 服务端接缝（叠加层端点，2026-10-12）-------------------------------------------------------
  // 把启用包的 `server.preDispatch` 装到**活的服务端对象**上（ctx.server.network / .handler 的实例方法上做
  // 影子包裹；上游文件一个字节不动，detach 即恢复）。钩子只在管理器开着时存在；任何一条装不上都点名。
  const attachHooks = () => {
    if (!ctx || !ctx.server) return;
    Promise.resolve().then(() => loadPreDispatchHooks(controller.enabledPacks(), log)).then((r) => {
      if (!r.hooks.length) {
        controller.setServerHooks(r.notes.length ? r.notes.map((n) => ({ pack: n.pack, installed: false, reason: n.reason })) : []);
        return;
      }
      const att = attachServerHooks(ctx.server, r.hooks, log);
      const report = att.installed.map((x) => ({ pack: x.pack, intercepts: x.intercepts, installed: true }));
      for (const n of r.notes) report.push({ pack: n.pack, installed: false, reason: n.reason });
      for (const n of att.notes) report.push({ pack: '', installed: false, reason: n.reason });
      controller.setServerHooks(report);
      log('[sp-mods] server hooks: ' + (report.map((x) => x.pack + (x.installed ? '=' + x.intercepts.join('/') : '(' + x.reason + ')')).join(' ') || '(none)'));
    }, (e) => log('[sp-mods] server hook load failed: ' + String((e && e.message) || e)));
  };

  const server = resolveHttpServer(ctx);
  if (!server) {
    log('[sp-mods] no http server in ctx — routes not attached (controller returned for tests)');
    attachHooks();
    return controller;
  }
  attachHooks();

  const prev = server.listeners('request').slice();
  for (const l of prev) server.removeListener('request', l);

  server.on('request', (req, res) => {
    let pathname = '';
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch (e) {
      pathname = '';
    }
    const method = String(req.method || '').toUpperCase();
    // 装载器：`/data/<kind>.json` —— **只在真有启用的包声明了它**时才接管（否则一字不动地转交上游，
    // 零开销、零风险）。合并后的记录里，包内素材路径已被改写成 /sp/mods/asset/<packId>/<rel>。
    if (method === 'GET' && pathname.indexOf('/data/') === 0 && pathname.endsWith('.json')) {
      const kind = pathname.slice('/data/'.length, -'.json'.length);
      if (/^[a-z0-9_]+$/.test(kind)) {
        let merged = null;
        try { merged = controller.dataFile(kind); } catch (e) { merged = null; }
        if (merged) {
          const body = JSON.stringify(merged.records);
          try {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(body);
          } catch (e) { /* client went away */ }
          return;
        }
      }
    }
    if (ROUTES.indexOf(pathname) < 0 && pathname.indexOf('/sp/mods/asset/') !== 0) {
      for (const l of prev) l.call(server, req, res);
      return;
    }
    // 控制面：环回对端 + 环回 Origin —— 不满足就什么都不做（与 sp-connect / sp-lobby 同一道门）。
    // **2026-10-12 端到端实测修的真 bug**：同源 GET **不带 Origin 头**（浏览器只在跨源、以及同源的非简单请求上
    // 才发），而 originAllowed 把「没有 Origin」判为拒绝 —— 于是面板的 catalog / installed 一律 403，
    // 面板在真机上只会停在「载入中…」。环回对端 + 头缺失 = 本机页面跟自己说话，必须放行；
    // 显式 `Origin: null`（沙箱 iframe / file://）仍然拒，跨源页面的 Origin 仍然不是环回、也仍然拒。
    const peerOk = isLoopback(req.socket && req.socket.remoteAddress);
    const originHeader = req.headers ? req.headers.origin : undefined;
    const originOk = originAllowed(originHeader) || (peerOk && originHeader === undefined);
    if (!peerOk || !originOk) {
      sendJson(res, 403, { ok: false, error: 'FORBIDDEN' });
      return;
    }

    // 包内素材（只读、只在包目录之内）：路径安全由 controller.assetFile 复核。
    if (pathname.indexOf('/sp/mods/asset/') === 0) {
      if (method !== 'GET') { sendJson(res, 405, { ok: false, error: 'METHOD' }); return; }
      const rest = pathname.slice('/sp/mods/asset/'.length);
      const slash = rest.indexOf('/');
      const packId = slash < 0 ? '' : decodeURIComponent(rest.slice(0, slash));
      const rel = slash < 0 ? '' : rest.slice(slash + 1).split('/').map(decodeURIComponent).join('/');
      const file = controller.assetFile(packId, rel);
      if (!file) { sendJson(res, 404, { ok: false, error: 'NO_SUCH_ASSET' }); return; }
      try {
        const buf = fs.readFileSync(file);
        res.writeHead(200, { 'content-type': mimeOf(file), 'cache-control': 'no-cache' });
        res.end(buf);
      } catch (e) { sendJson(res, 500, { ok: false, error: 'READ_FAILED' }); }
      return;
    }

    if (pathname === ROUTE_LOADER) {
      if (method !== 'GET') { sendJson(res, 405, { ok: false, error: 'METHOD' }); return; }
      sendJson(res, 200, Object.assign({ ok: true, dir: workshopDir }, controller.loaderManifest()));
      return;
    }
    if (pathname === ROUTE_CATALOG) {
      if (method !== 'GET') { sendJson(res, 405, { ok: false, error: 'METHOD' }); return; }
      controller.catalog(false).then((c) => {
        sendJson(res, 200, { ok: c.errors.length === 0, site: MODS_SITE_ORIGIN, at: c.at, mods: c.mods, errors: c.errors, funcs: c.funcs || [], feature: controller.feature() });
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
