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
// SECURITY (Mimosa 验收口径，tools/apk/mods-panel.test.mjs 里逐条断言)
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

// ---- 包身份（内容摘要）：算法取自 Forge（2026-10-14 业主「mod 管理器版本用 Forge 这个」）-------------
// 出处：Stronghold-Protocol-Forge `shared/modIdentity.js` 的 `canonicalJson`（:168-174）与
// `modManifestDigest`（:182-196，sha256 over 按路径排序的 [path, hash] 对）。逐字同算法，用来给一个包
// 一个**与 zip 打包方式无关**的身份：同一个包重新压一遍（zip 元数据/压缩率变了）摘要不变；内容改一个
// 字节就变。现有 source.json 的 zip sha256 做不到这一点（重压即变），zip 字节数更做不到。
//
// **诚实边界**：Forge 的 modManifestDigest 里，**声明的内容文件**参与哈希的是**归一化后的记录**
// （canonicalJson(normalized)），kits/assets 才是原始字节。Forge 那套归一化在
// shared/workshop.js 的 normalizePackManifest（742 行，依赖散在 4473 行里）——逐字搬它等于 vendor
// 整套 shared 层（~5k 行、需长期跟随上游），那是业主级的取舍，**本次不搬**。所以这里的
// canonicalContentDigest 对**每个文件都取原始字节**（= Forge 对 kits/assets 的规则），
// 因此同一包在两边算出的数字**不会相等**；它是同算法、同形状的**我们这侧**的内容身份。
// 要拿到与 Forge 逐字相等的摘要，必须先 vendor 那个归一化器。

/** Forge 的 canonical JSON：对象按键排序、丢弃 undefined、数组保序、其它走 JSON.stringify。
 *  （逐字同 shared/modIdentity.js:168-174；null 与"非对象"都走 JSON.stringify。） */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

/** sha256 over 按 path 排序的 [path, hash] 对（同 Forge modManifestDigest 的口径）。 */
export function manifestDigestOf(manifest) {
  const pairs = (Array.isArray(manifest) ? manifest : [])
    .filter((e) => e && typeof e.path === 'string' && typeof e.hash === 'string')
    .map((e) => [e.path, e.hash])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Hex(Buffer.from(canonicalJson(pairs), 'utf8'));
}

/** 一棵已落盘包目录的内容摘要：按相对路径排序、逐文件 sha256（原始字节），再走 manifestDigestOf。
 *  跳过大目录噪声（.git 之类不可能出现，但防御性跳过 dot 文件）与零字节目录项。 */
export function packContentDigest(root) {
  const entries = [];
  const walk = (dir, rel) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const name of names) {
      if (name.startsWith('.')) continue;                      // dot 文件不参与身份（编辑器临时文件等）
      const abs = path.join(dir, name);
      const r = rel ? rel + '/' + name : name;
      let st = null;
      try { st = fs.statSync(abs); } catch (e) { continue; }
      if (st.isDirectory()) { walk(abs, r); continue; }
      if (!st.isFile()) continue;
      let buf = null;
      try { buf = fs.readFileSync(abs); } catch (e) { continue; }
      entries.push({ path: r, hash: sha256Hex(buf) });
    }
  };
  walk(root, '');
  return { digest: manifestDigestOf(entries), files: entries.length };
}

/** Overlay loader contract (server/overlay-loader.mjs). */
export const overlayApi = 1;
export const id = 'sp-mods';

/** `/sp/mods/loader` 响应体的世代（给客户端对版本用）。字段语义一变就抬，客户端不匹配即退回「未生效」。 */
export const LOADER_API = 1;

/** 这台设备认得的 Forge 面板槽名清单（与 ui/modPanels.js 的 SLOT_ANCHORS 一致）。
 *  随响应下发，mod 管理器据此判断「这包声明的槽我们有没有」——契约可查，不必硬编码。
 *  上游 shared/workshop.js:383 `CLIENT_PANEL_SLOTS`：**闭枚举**，写成自由字符串的话一个拼错的挂载点
 *  就是一块永远不出现的界面。装载期按这份名单判死（CLIENT_BAD_PANEL_SLOT）。 */
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

/** 面板模块的扩展名（上游 shared/workshop.js:679 `CLIENT_PANEL_MODULE_EXT`）：`.js` 是唯一一种。 */
export const PANEL_MODULE_EXT = '.js';
/** 面板 record id 的字符集（上游 `RECORD_ID_RE`，:255）：键与其它 record id 同一套。 */
export const PANEL_ID_RE = /^[A-Za-z0-9_\-.:]{1,64}$/;

/**
 * 面板声明是否**这台设备装得上**（上游 `isSafeModulePath` + `CLIENT_PANEL_SLOTS.includes` + 存在性，
 * 装载期判死而不是让页面 import 一个 404）。四件事全过才给 URL：
 *   ① `id` 是 record id（否则挂载点写不进 DOM、日志也指不定是谁）；
 *   ② `slot` 在闭枚举里（一个拼错的槽 = 永远不出现的界面）；
 *   ③ `module` 是包内相对 `.js`（与 preDispatch 的 `.mjs` 同一条路径规则，另一个扩展名）；
 *   ④ 那个文件**真的在这个包里**（上游只有形状层，我们多这一条：URL 是我们自己拼的，
 *      拼出一个 404 只会让页面上多一条 import 失败，而真相是「这包没带这个模块」）。
 */
export function panelEntryOk(panel, exists) {
  if (!panel || typeof panel !== 'object') return false;
  if (typeof panel.id !== 'string' || !PANEL_ID_RE.test(panel.id)) return false;
  if (typeof panel.slot !== 'string' || PANEL_SLOT_NAMES.indexOf(panel.slot) < 0) return false;
  if (typeof panel.module !== 'string' || !panel.module) return false;
  if (!isSafeRelativePackPath(panel.module)) return false;
  if (!panel.module.endsWith(PANEL_MODULE_EXT) || panel.module.length <= PANEL_MODULE_EXT.length) return false;
  if (typeof exists === 'function' && !exists(panel.module)) return false;
  return true;
}

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
export const version = 3;

// ---- pack.json 校验（2026-10-11：从「只收 A 层」改成「按 Forge 的闭集收全部层」）----------------------
// 业主口径（2026-10-11）：「mod 管理器界面里抓取该网站，可一键安装（参考 mod 管理器默认加载方式，安装完
// 默认启用，界面内提示热重载或重新打开 apk）」。站点目录实测 14 个包里只有 5 个是纯 A 层，其余是
// C（客户端界面）/ B（服务端逻辑）/ A+kits —— 只收 A 层等于让「一键安装」对 9/14 的包直接失败。
// 于是判据改成 Forge 的闭集：字段必须在 PACK_FIELDS 里，`api` 区间必须容得下当前世代；**层不再拒收**，
// 而是**算出来并回报**（面板据此打「含代码 / 服务端逻辑」标记，见 layerOf）。
// 需要的包结构见 Forge 的 SKILL.md §3②（PACK_FIELDS）与 docs/MOD-SURFACE.md（A/B/C 三层语义）。
export const CODE_ENTRY_FIELDS = ['server', 'client', 'kits', 'routes'];
export const KNOWN_FIELDS = [
  // ---- 身份与元信息（Forge 0.18.6 shared/workshop.js:134-169 的 PACK_FIELDS，逐字对齐）----
  'id', 'name', 'version', 'author', 'license', 'description', 'gameVersion', 'game', 'api', 'layer', 'combat',
  // 内容与覆盖
  'content', 'overrides',
  // 素材与声明（贡献项）
  'voices', 'voiceLangs', 'bondIcons', 'itemIcons', 'art', 'skins', 'support', 'operators', 'i18n',
  // 形态（clip set）与静态相位通道
  'forms', 'fx',
  // 纯文本声明（§28.15）
  'notices',
  // 行为开关（**不是**贡献项）
  'playtest',
  // 启用声明（§28.50）：装好 ≠ 生效，`false` = 装载期跳过
  'enabled',
  // 变体 / 口径声明（§28.39 / §28.51）：只声明轴的闭枚举里有的选项名，值由引擎自己给
  'variants',
  // 行为开关声明（§28.43）
  'behaviour',
  // 中间层四组能力声明（§28.13）
  'assets', 'client', 'server', 'routes',
  // 目标引擎（§28.46）：`forge`（缺省，本引擎装）或 `stardust`（声明型包）
  'target',
  // 管理器合同（§28.48）：对**其它工坊包**的依赖与互斥，形状 [{ id, range? }]
  'dependencies', 'conflicts',
  // 代码入口（B/C 层）：收下并记录，装载能力见文件头「装载边界」。
  // 注：`kits` 不在 Forge 的 PACK_FIELDS 里（它在 `server`/`client` 声明内部），但老包会把它写在顶层，
  // 收下只是**比引擎宽**，不会放行任何引擎会拒的东西。
  'kits',
  // 旧树遗留：Forge 0.13 时代有过 `media`，0.18.6 的闭集里没有它。留着是为了**不拒收老包**。
  // 这条闭集的纪律：允许比引擎宽（宽进来的包引擎自己会判），绝不允许比引擎窄（那会把新包挡在门外）。
  'media',
];

/** 包可以声明的数据表（Forge 0.18.6 `shared/workshop.js:51-53` 的 WORKSHOP_CONTENT_FILES，逐字 15 项）。
 *  最后一项 `variants` 是 §28.51 的**口径数据通道**：它不是一张数据表，而是「给**已经存在**的记录写
 *  字段级补丁」的声明（不许发明记录 / 不许发明键 / 不许发明轴）。这里与其余 14 张一视同仁地列出来 ——
 *  本层只判「名字认不认识」，语义由引擎在装载期判（本机没有引擎，见文件头「装载边界」）。 */
export const WORKSHOP_CONTENT_FILES = Object.freeze([
  'chess', 'units', 'items', 'enemies', 'stages', 'waves', 'tokens', 'bosses', 'factions', 'garrisons',
  'bands', 'bonds', 'effects', 'choices', 'variants',
]);

/** `pack.json.target` 的闭枚举（Forge 0.18.6 `shared/workshop.js:172`）：`forge`（缺省）本引擎装载；
 *  `stardust` 是给 Stardust 宿主的**声明型包** —— 本引擎（以及本管理器）只认识它、不装载它。 */
export const PACK_TARGETS = Object.freeze(['forge', 'stardust']);

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
  // 内容表名（2026-10-15 对齐 Forge 0.18.6）：引擎对 `content` 里的名字是**闭集点名拒**
  // （`CONTENT_UNKNOWN_FILE`，shared/workshop.js:1849-1852）—— 一个引擎不认识的名字永远不会被读，
  // 包会「装了但那张表没进来」。这里同口径拦下来，把失败留在**下载之前**。
  const content = pack.content;
  if (content !== undefined) {
    if (!Array.isArray(content)) return { ok: false, reason: 'CONTENT_NOT_ARRAY' };
    const bad = content.filter((f) => typeof f !== 'string' || WORKSHOP_CONTENT_FILES.indexOf(f) < 0);
    if (bad.length) return { ok: false, reason: 'CONTENT_UNKNOWN_FILE', fields: bad.slice(0, 8).map(String) };
  }
  // 目标引擎（§28.46）：闭枚举之外的值是**拼错**，不是新特性 —— 点名拒，别让它在装载期才炸。
  const target = asText(pack.target, 20);
  if (target !== '' && PACK_TARGETS.indexOf(target) < 0) return { ok: false, reason: 'BAD_TARGET', fields: [target] };
  // 管理器合同（§28.48）：这里只判**形状**（引擎在装载期才裁决语义：缺失依赖 / 版本不合 / 互斥 / 级联 /
  // 循环）。形状写歪的包在引擎那边同样是装载期整包拒，提前挡掉能省一次下载。
  for (const key of ['dependencies', 'conflicts']) {
    const decl = pack[key];
    if (decl === undefined) continue;
    if (!Array.isArray(decl)) return { ok: false, reason: 'BAD_MOD_REFS', fields: [key] };
    for (const e of decl) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, reason: 'BAD_MOD_REFS', fields: [key] };
      const keys = Object.keys(e);
      if (keys.some((k) => k !== 'id' && k !== 'range')) return { ok: false, reason: 'BAD_MOD_REFS', fields: [key] };
      if (asText(e.id, 128) === '') return { ok: false, reason: 'BAD_MOD_REFS', fields: [key] };
      if (e.range !== undefined && (typeof e.range !== 'string' || e.range === '')) {
        return { ok: false, reason: 'BAD_MOD_REFS', fields: [key] };
      }
    }
  }
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
      // ---- Forge 0.18.6 新增声明（2026-10-15）：收下并回报，面板据此打标记 ----
      // 目标引擎：'' = 缺省 forge；'stardust' = 声明型包（本管理器只认识、不装载，如实标出来）
      target: target,
      // `enabled:false` = 包自己声明「装了但不参与装载」（§28.50）。注意它与本管理器的 enabled.json
      // **是两层**：那是引擎侧声明，这是我们侧的开关；这里只如实回报，不去改我们的开关。
      declaredEnabled: pack.enabled !== false,
      // 依赖 / 互斥的**条数**（语义裁决归引擎，见文件头「装载边界」）
      dependencies: Array.isArray(pack.dependencies) ? pack.dependencies.length : 0,
      conflicts: Array.isArray(pack.conflicts) ? pack.conflicts.length : 0,
      // 口径轴（§28.39）/ 行为开关（§28.43）各声明了几格
      variants: Array.isArray(pack.variants) ? pack.variants.length : 0,
      behaviour: Array.isArray(pack.behaviour) ? pack.behaviour.length : 0,
    },
  };
}

/** ">=1 <2" / "1.x" / "1" 这些写法里，世代 1 是否在区间内。空/不可解析 → 放行（引擎只校验合法性）。 */
export function apiAllows(range, version) {
  const s = String(range).trim();
  if (s === '') return true;
  // `*` / `x` = 全匹配（Forge shared/packs.js:91）。`||` = 或（:114/:127）。
  if (s === '*' || s === 'x' || s === 'X') return true;
  if (s.indexOf('||') >= 0) return s.split('||').some((one) => apiAllows(one, version));
  let ok = false;
  const parts = s.split(/\s+/).filter(Boolean);
  for (const p of parts) {
    // `^1.0.0` → >=1 <2；`~1.2` → >=1.2 <1.3（Forge shared/packs.js:101-102 的边界展开）。
    let m = /^\^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(p);
    if (m) {
      const lo = Number(m[1]);
      if (version < lo) return false;
      if (version >= lo + 1) return false;
      ok = true; continue;
    }
    m = /^~\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(p);
    if (m) {
      const lo = Number(m[1]);
      const hi = Number(m[2] || 0) + 1;
      if (version < lo) return false;
      if (Number(m[2] || 0) > 0 && version >= hi) return false;
      ok = true; continue;
    }
    m = /^>=\s*(\d+)(?:\.\d+)*$/.exec(p);
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
      // 内容摘要（Forge 算法的我们这侧口径，见文件头）：与 zip 怎么打无关。老装机没有 = 空串，
      // 消费方据此判定「这条判据不可用」——绝不拿空串去比，那会把每个包都判成「变过」。
      contentDigest: src && typeof src.contentDigest === 'string' ? src.contentDigest : '',
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

// ---- 服务端接缝：preDispatch（叠加层端点，2026-10-12；2026-10-15 对齐 Forge 0.18.6）------------------
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
//   · 契约照抄真包：模块导出 **`createPreDispatch(deps)`**，deps = `{pack, policy, policyFile, intercepts, c2s,
//     log, now, send}`（八个键，见下方 PRE_DISPATCH_DEPS），
//     返回 `{preDispatch(conn, msg) → boolean}`，**true = 消费**（这条消息不再进引擎）；可选导出
//     `validatePolicy(policy)`（返回字符串 = 装载期点名拒绝）。**每个连接一个实例**（挂在 conn 上）。
//   · 失败姿态：装载期点名拒绝（模块导入失败 / 工厂没返回 preDispatch / validatePolicy 拒绝）；运行期钩子抛错
//     = **不否决**（fail-open，消息照常分发）并记一条 error —— 与 Forge 逐字同姿态。
//
// 2026-10-15 与 Forge 0.18.6 `server/modDispatch.js` 逐条对齐（取证：_tmp/forge-0186-merge/src/）：
//   · **deps 八个键一个不多一个不少**：`pack, policy, policyFile, intercepts, c2s, log, now, send`
//     （上游 `PRE_DISPATCH_DEPS`，:38）。此前少 `pack` / `policyFile`，多一个测试遗留的 `c2sHooks`。
//     注入面就是「这个钩子能碰到什么」的全部答案 —— 刻意**没有** data / lobby / Match / 任何对局对象。
//   · **policy 深冻结**：策略文件是包给的**数据**，一个连接改它不该让别的连接看见（上游 deepFreeze）。
//   · **intercepts 装载期按本仓 `C2S` 校验**（上游 shared/workshop.js:566
//     `PRE_DISPATCH_INTERCEPTS = Object.freeze(Object.keys(C2S).sort())`）：刻意**从协议反推**而不是抄一份
//     名单 —— 抄一份就是第二个会漂移的真相，而漂移的方向是「作者声明了一个拦不住的类型」。我们的 C2S 有 45
//     个类型（`shared/protocol.js:379`），名单由那里现取，协议加类型这里自动跟上。
//   · **c2s 同步且冻结**：上游 `FROZEN_C2S` 是进程级可变全局状态的冻结副本 —— 一个包改不动 C2S，也看不到
//     别的包写了什么。此前我们是异步 `import()` 后赋值（`let c2sTable = null`），于是每个连接的**第一个**
//     hello 之前 c2s 可能是 null；现在装载期 await 到再装配。
//   · **now 可注入**（上游 `now = Date.now` 形参）：测试不必造假时钟。
//   · **`onConnection`**：上游在连接建立时给每个钩子一次「连接私有的初始化」机会（资源挑战就在这里发）。
//     我们的落点是 `handleConnection` 的**影子**（同一套「实例方法可被影子采纳」的机制），没有它
//     hello 钩子就是无初始化启动。**本线不接 `meta/modules/battle/room` 那四组**（SERVER_HOOK_MEMBERS
//     里的其余项）—— 那些要 Forge 的 modModules 通道与 matchClass 接线，本线没有，面板如实标。
export const SERVER_HOOK_MEMBERS = ['preDispatch', 'meta', 'modules', 'battle', 'room'];

/** 分发前钩子的 deps 键（上游 `PRE_DISPATCH_DEPS`，一个不多一个不少；测试钉住这份名单）。 */
export const PRE_DISPATCH_DEPS = Object.freeze(['pack', 'policy', 'policyFile', 'intercepts', 'c2s', 'log', 'now', 'send']);

/** JSON 数据深冻结：策略文件是包给的**数据**，一个连接改它不该让别的连接看见。 */
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
}

/** 冻结的协议目录副本（上游 `FROZEN_C2S`）：一个包改不动 `C2S`，也看不到别的包写了什么。 */
function frozenCatalogue(c2s) {
  const out = {};
  for (const [type, spec] of Object.entries(c2s || {})) {
    if (!spec || typeof spec !== 'object') { out[type] = spec; continue; }
    const copy = Object.assign({}, spec);
    if (Array.isArray(spec.$optional)) copy.$optional = Object.freeze([...spec.$optional]);
    out[type] = Object.freeze(copy);
  }
  return Object.freeze(out);
}

/**
 * 本仓 `shared/protocol.js` 的 `C2S`（装载期同步取到；拿不到时回 null，钩子契约里 c2s 是只读信息）。
 * 部署形状：`<webroot>/server/overlay/sp-mods.mjs` 与 `<webroot>/shared/protocol.js` —— 两步上溯。
 * 刻意**现取**而不是抄一份名单：抄一份就是第二个会漂移的真相（上游 shared/workshop.js:566 的同一条理由）。
 */
async function loadC2S() {
  try {
    const here = path.dirname(pathToFileURLSafe(import.meta.url).replace(/^file:\/\//, ''));
    const m = await import(pathToFileURLSafe(path.join(here, '..', '..', 'shared', 'protocol.js')));
    return m && m.C2S && typeof m.C2S === 'object' ? m.C2S : null;
  } catch (e) {
    return null;
  }
}

/**
 * 读一个包的 `server.preDispatch` 声明（形状层；不认识就不认这条钩子）。
 *
 * `module` 必须是包内**相对**的 `.mjs`（它是**服务端**加载的 ESM，浏览器不加载）—— 上游
 * `PRE_DISPATCH_MODULE_EXT`。此前只判「非空字符串」，一条 `https://evil/x.mjs` 或 `/abs/x.mjs`
 * 会走进 `path.join(p.dir, decl.module)`：join 对绝对路径会**丢掉前缀**，于是越出包目录读代码。
 * 现在与模块装载期的路径判据（下面 loadPreDispatchHooks 的 BAD_MODULE_PATH）同一条规则前置。
 */
export function readPreDispatchDecl(pack) {
  const srv = pack && typeof pack.server === 'object' && pack.server ? pack.server : null;
  if (!srv) return null;
  const pd = srv.preDispatch;
  if (!pd || typeof pd !== 'object') return null;
  const module_ = asText(pd.module, 256);
  if (!module_) return null;
  if (!isSafeRelativePackPath(module_) || !module_.endsWith('.mjs')) return null;
  const policy = asText(pd.policy, 256);
  return {
    module: module_,
    policy: policy && isSafeRelativePackPath(policy) ? policy : '',
    intercepts: Array.isArray(pd.intercepts)
      ? [...new Set(pd.intercepts.filter((t) => typeof t === 'string' && t))].sort().slice(0, 32)
      : [],
  };
}

/** 包内相对路径：相对、无穿越、无绝对/盘符、无反斜杠、目录段不以 `.` 开头（上游 isSafeRelativePath 同一条）。 */
export function isSafeRelativePackPath(p) {
  if (typeof p !== 'string' || !p || p.length > 200) return false;
  if (p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return false; // https: / data: / file: 之类的 scheme 前缀
  const segs = p.split('/');
  return !segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'));
}

/**
 * 装载期校验 `intercepts`（上游 shared/workshop.js:1150-1158 的 PREDISPATCH_BAD_INTERCEPTS /
 * PREDISPATCH_UNKNOWN_TYPE）。**空数组 = 点名拒绝**：一个拦不住任何东西的钩子等于没声明，
 * 却会让作者以为拦住了什么。类型必须在**本仓** `C2S` 里 —— 拿不到协议表时退回宽松（只判非空），
 * 并在 note 里写明，不假装校验过。
 * @param {string[]} intercepts
 * @param {object|null} c2s `shared/protocol.js` 的 C2S
 * @returns {null|string} null = 通过；字符串 = 点名拒绝的理由
 */
export function checkIntercepts(intercepts, c2s) {
  if (!Array.isArray(intercepts) || !intercepts.length) {
    return 'PREDISPATCH_BAD_INTERCEPTS: intercepts must be a non-empty array of C2S types (a hook that intercepts nothing gates nothing)';
  }
  if (!c2s) {
    return 'PREDISPATCH_C2S_UNAVAILABLE: the protocol table could not be read, so the declared types were not verified';
  }
  for (const t of intercepts) {
    if (typeof t !== 'string' || !Object.hasOwn(c2s, t)) {
      return 'PREDISPATCH_UNKNOWN_TYPE: "' + String(t).slice(0, 64) + '" is not a message type of shared/protocol.js C2S (the bus never delivers a name no client sends)';
    }
  }
  return null;
}

/**
 * 装载全部启用包的 preDispatch 钩子。返回 `{hooks, notes}`：hooks 每项 = `{pack, decl, create}`，
 * `create` 是那个模块的工厂（每连接调用一次）。**任何一条装不上都点名**（notes），不影响别的包。
 *
 * `c2s`（本仓 shared/protocol.js 的 C2S）在**装载期**校验 `intercepts`：上游把这一步放在加载期而不是运行期，
 * 因为「作者声明了一个拦不住的类型」是最坏的失败方向 —— 它静默，且看起来在工作。缺省自己现取（部署形状：
 * overlay/sp-mods.mjs 与 shared/protocol.js 差两步）；测试可注入一张表。
 */
export async function loadPreDispatchHooks(packs, log, opts) {
  const options = opts || {};
  const c2s = options.c2s === undefined ? await loadC2S() : options.c2s;
  const hooks = [];
  const notes = [];
  for (const p of packs) {
    const decl = readPreDispatchDecl(p.doc);
    if (!decl) continue;
    // 装载期点名拒绝：空 intercepts / 协议里不存在的类型（上游 shared/workshop.js:1150-1158）
    const issue = checkIntercepts(decl.intercepts, c2s);
    if (issue) {
      notes.push({ pack: p.id, reason: issue.slice(0, issue.indexOf(':')), detail: issue });
      continue;
    }
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
      : (typeof mod.default === 'function' && mod.default.createPreDispatch === 'function' ? mod.default.createPreDispatch : null));
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
    hooks.push({ pack: p.id, decl: decl, create: create, policy: policy, policyFile: decl.policy || null });
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
 *
 * 2026-10-15 对齐 Forge 0.18.6 `createModDispatch`：
 *   · 每个包一份**冻结** deps（与连接无关，工厂每连接用它建一个实例）；八个键 = PRE_DISPATCH_DEPS。
 *   · `c2s` 是**冻结的目录副本**（不是进程级可变全局的引用），装载期同步拿到（`opts.c2s`）。
 *   · 包 id 次序排序（上游 byPackId）：钩子的调用次序不随发现顺序 / 声明顺序变。
 *   · `onConnection`：连接建立时给每个钩子一次「连接私有的初始化」机会（上游的资源挑战就在这里发）。
 *     落点是 `handleConnection` 的影子 —— 与 onHelloMsg / onMessage 同一套机制。
 */
export function attachServerHooks(srv, hooks, log, opts) {
  const options = opts || {};
  const c2s = options.c2s === undefined ? null : options.c2s;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
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

  // 包 id 次序（DESIGN §28.3 的同一条规则）：钩子的调用次序不随发现顺序 / 声明顺序变。
  const list = hooks.filter((h) => h && typeof h.pack === 'string' && typeof h.create === 'function')
    .slice()
    .sort((a, b) => (a.pack < b.pack ? -1 : a.pack > b.pack ? 1 : 0));
  if (!list.length) return { installed: [], notes: notes, detach: () => {} };
  const installed = list.map((h) => ({ pack: h.pack, intercepts: h.decl.intercepts, installed: true }));
  const logger = {
    info: (...a) => { try { if (typeof log === 'function') log(a.join(' ')); } catch (e) { /* ignore */ } },
    warn: (...a) => { try { if (typeof log === 'function') log('WARN ' + a.join(' ')); } catch (e) { /* ignore */ } },
    error: (...a) => { try { if (typeof log === 'function') log('ERROR ' + a.join(' ')); } catch (e) { /* ignore */ } },
    debug: (...a) => { try { if (typeof log === 'function') log('DEBUG ' + a.join(' ')); } catch (e) { /* ignore */ } },
  };
  const frozenLog = Object.freeze(logger);
  const catalogue = c2s ? frozenCatalogue(c2s) : null;

  const origOnHelloMsg = net.onHelloMsg;
  const origOnMessage = handler && typeof handler.onMessage === 'function' ? handler.onMessage : null;
  const origHandleConnection = typeof net.handleConnection === 'function' ? net.handleConnection : null;

  /** 每个连接一份实例（契约：deps 冻结、实例只挂这条连接）。 */
  function instancesFor(conn) {
    if (conn.__spPreInstances) return conn.__spPreInstances;
    const out = [];
    for (const h of list) {
      // 每个包一份**冻结** deps（与连接无关）：注入面就是「这个钩子能碰到什么」的全部答案。
      const deps = Object.freeze({
        pack: h.pack,
        policy: deepFreeze(h.policy === undefined || h.policy === null ? {} : h.policy),
        policyFile: typeof h.policyFile === 'string' ? h.policyFile : null,
        intercepts: Object.freeze([...(h.decl.intercepts || [])]),
        c2s: catalogue,
        log: frozenLog,
        now: now,
        send: (c, m) => { try { return net.reply(c, m); } catch (e) { return null; } },
      });
      let inst = null;
      try {
        inst = h.create(deps);
      } catch (e) {
        logger.error('[sp-mods] ' + h.pack + ': preDispatch factory threw — hook not installed on this connection', String((e && e.message) || e));
        continue;
      }
      if (!inst || typeof inst.preDispatch !== 'function') {
        logger.error('[sp-mods] ' + h.pack + ': factory returned no preDispatch(conn, msg) — hook not installed on this connection');
        continue;
      }
      out.push({ pack: h.pack, intercepts: h.decl.intercepts, instance: inst });
    }
    conn.__spPreInstances = out;
    return out;
  }

  /** 连接建立时：给每个钩子一次「连接私有的初始化」机会（资源挑战就是在这里发出去的）。 */
  function onConnectionHooks(conn) {
    for (const it of instancesFor(conn)) {
      if (typeof it.instance.onConnection !== 'function') continue;
      try { it.instance.onConnection(conn); } catch (e) {
        logger.error('[sp-mods] ' + it.pack + ': preDispatch.onConnection crashed', String((e && e.message) || e));
      }
    }
  }

  /** 跑一类钩子；任一返回 true = 消费（不调原方法）。钩子抛错 = 不否决（fail-open）。 */
  function runHooks(conn, msg, list_) {
    for (const it of instancesFor(conn)) {
      if (list_ === 'hello' && it.intercepts.indexOf('hello') < 0) continue;
      if (list_ === 'c2s' && it.intercepts.indexOf('hello') >= 0) continue;
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

  net.onHelloMsg = function (conn, msg, now_) {
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
  // onConnection 的影子（上游 createModDispatch 的第三个出口）。`handleConnection` 是实例方法，
  // 与 onHelloMsg 同一套机制；没有它就不挂（不半挂）。
  if (origHandleConnection) {
    net.handleConnection = function (ws, req) {
      const r = origHandleConnection.apply(this, arguments);
      try {
        const conn = net.conns && typeof net.conns.get === 'function' ? net.conns.get(ws) : null;
        if (conn) onConnectionHooks(conn);
      } catch (e) { /* ignore */ }
      return r;
    };
  }

  const detach = () => {
    try {
      net.onHelloMsg = origOnHelloMsg;
      if (origOnMessage) handler.onMessage = origOnMessage;
      if (origHandleConnection) net.handleConnection = origHandleConnection;
      delete net.__spModHooks;
    } catch (e) { /* ignore */ }
  };
  net.__spModHooks = { installed: installed, notes: notes, detach: detach };
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
  let panelRefused = []; // 装载期点名「这包装不上的面板」（loaderManifest 收；每次装载重建）

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
    // 包身份（内容摘要，Forge 算法的我们这侧口径）：与 zip 怎么打无关，只认包里的字节。
    // 它让「同一个包重新压一遍」不再被当成新包，也给诊断一个稳定标识（见 source.json 的 contentDigest）。
    let contentDigest = '';
    try { contentDigest = packContentDigest(dest).digest; } catch (e) { contentDigest = ''; }
    writeSource(dest, {
      siteId: String(packId), url: hit.download, sha256: sha, kind: asText(hit.kind, 40),
      name: asText(hit.name, 200), at: new Date().toISOString(),
      // zip 字节数：与站点 size 同单位，catalog() 判「同 id 换了内容」时比这个（比解包后的目录大小永远不等）
      bytes: r.buf.length,
      // 内容摘要（与 zip 打包方式无关）。老装机没有这个字段 = 空串，消费方据此判定「这条判据不可用」。
      contentDigest: contentDigest,
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
    panelRefused = []; // 每次装载重建（这是「此刻」的快照，不是历史累积）
    const packs = enabledPacks().map((p) => {
      const client = p.doc.client && typeof p.doc.client === 'object' ? p.doc.client : {};
      const declared = Array.isArray(client.panels) ? client.panels : [];
      const panels = declared.map((x) => {
        const panel = x && typeof x === 'object' ? x : {};
        const bad = !panelEntryOk(panel, (rel) => !!assetFile(p.id, rel));
        if (bad) {
          // 点名而不是静默丢掉：作者声明了一个装不上的面板，设备上必须看得见「为什么没有」
          panelRefused.push({ pack: p.id, id: asText(panel.id, 64) || '(none)', module: asText(panel.module, 128) });
          return null;
        }
        return {
          id: asText(panel.id, 64),
          slot: asText(panel.slot, 64),
          order: asNum(panel.order),
          gate: panel.gate === undefined ? null : panel.gate,
          module: packAssetUrl(p.id, panel.module),
          styles: Array.isArray(panel.styles)
            ? panel.styles.filter((s) => typeof s === 'string' && s && isSafeRelativePackPath(s) && s.endsWith('.css') && assetFile(p.id, s))
              .map((s) => packAssetUrl(p.id, s)).slice(0, 8)
            : [],
        };
      }).filter(Boolean);
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
    // panelRefused：装载期点名「这包装不上的面板」（闭枚举之外的槽 / 不带模块 / 模块不在包里），
    // 只在本轮装载里收集，不进 return —— 面板读它显示「声明了但没生效」。
    return {
      feature: featureEnabled(dir),
      packs: packs,
      dataKinds: Array.from(new Set(packs.reduce((a, p) => a.concat(p.content), []))).sort(),
      panelCount: packs.reduce((a, p) => a + p.panels.length, 0),
      panelRefused: panelRefused,
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
  // c2s 只读一次：装载期校验（intercepts 是否本协议类型）与运行期冻结目录共用同一张表，避免
  // 「装载时读一份、运行时又 import 一份」两个真相漂移。读不到就如实降级：装载校验会标
  // PREDISPATCH_C2S_UNAVAILABLE，钩子仍可装（上游对未知类型一律原样放行），但清单里点名。
  const attachHooks = () => {
    if (!ctx || !ctx.server) return;
    Promise.resolve()
      .then(() => loadC2S())
      .then((c2s) => loadPreDispatchHooks(controller.enabledPacks(), log, { c2s })
        .then((r) => ({ c2s: c2s, r: r })))
      .then(({ c2s, r }) => {
        if (!r.hooks.length) {
          controller.setServerHooks(r.notes.length ? r.notes.map((n) => ({ pack: n.pack, installed: false, reason: n.reason })) : []);
          return;
        }
        const att = attachServerHooks(ctx.server, r.hooks, log, { c2s });
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
