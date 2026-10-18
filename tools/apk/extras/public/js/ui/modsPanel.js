// js/ui/modsPanel.js — mod 管理器的 PANEL，作为 Preact 组件（业主 2026-10-11：
// 「mod 管理器面板放到悬浮窗内单独按钮 …… ui 还是按悬浮窗内的 ui 样式来 …… mod 可下载
//  http://47.103.14.217:25570/mods 抓这个网站」）。
//
// LOOK: 与预载面板（ui/preloadPanel.js）**逐条同款** —— 叠加层自己的 Modal 框 + .set-list / .set-row /
// .set-row__label（MicroLabel）+ .set-apply 按钮，全部来自 ui/overlayKit.js。这里不重写任何样式，
// 也不借页面自己的设计系统：叠加层自带 kit + 作用域样式表（.sp-ui），所以它在本地树页面和任何
// 第三方服页面上长得一样。
//
// LAYERS（业主的「分层式」口径，两块）：
//   (1) mod 管理器 —— 总开关（**默认关闭**）+ 站点 / 包目录 / 已装数量三行
//   (2) 可下载的 mod —— 目录里的每一项一行：名字 + 大小/日期 + 备注 + [安装] / [启用|停用] / [卸载]
// 失败/被拒的原因走 Modal 底部的 hint 行（响亮，不静默）。
//
// WHY 面板只跟**本机**说话：站点的 /api/mods **没有 CORS 头**，页面的源是 http://127.0.0.1:<port>，
// 浏览器直连必被挡。抓取/下载/解包全在 server/overlay/sp-mods.mjs（本机 Node）里做，面板只打
// 同源的 /sp/mods/*。所以本文件**不**、也不能直接 fetch 那个站点。
// 「同源」只在**本机页面**上才等于本机 Node：第三方服务器页面（业主 2026-10-11 报的
// http://103.205.253.194:27527/）上同源就是**那台服务器**，有些页面还把 window.fetch 包一层改写路径
// —— 于是管理器的请求会去打人家的服务器。所以那种页面上面板一个请求都不发，只画一条说明
// （isOwnHostPage()，判据与 lobby.js 的回环判定逐字一致）。
//
// Contract: ESM + htm（无构建步骤），除壳自带 vendor 模块外无第三方依赖，依赖缺失时降级为 shim
// （永不抛），幂等。
//
// 与「加载 mod」的边界：本行至今**没有 mod 装载器**（上游树里没有 mod 层）。面板能把包装进来、
// 记录启用状态、卸载；把包内容并进对局是另一件事（见审计③ §5 路 A），这里不假装做到。

let html;
let Modal;
let Button;
let MicroLabel;
let toast;
let copyText = null;
let useState;
let useEffect;

// ---- shims (last resort; only used when the real modules cannot be loaded) ----------------------
function shimHtml(strings) {
  const parts = [];
  for (let i = 0; i < strings.length; i++) {
    parts.push(strings[i]);
    if (i + 1 < arguments.length) parts.push(arguments[i + 1]);
  }
  return { __spDegraded: true, parts };
}
function shimUseState(v) { return [typeof v === 'function' ? v() : v, function () {}]; }
function shimUseEffect() {}
function shimModal(p) {
  const q = p || {};
  return html`<div class="modal" role="presentation"
    style="position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147482000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)">
    <div class="modal__body" style="max-width:92vw;max-height:86vh;overflow:auto;padding:12px;background:#0f1815;border:1px solid #2c3a35;border-radius:6px">
      ${q.children}
    </div>
  </div>`;
}
function shimButton(p) {
  const q = p || {};
  return html`<button type="button" class="btn" disabled=${!!q.disabled} onClick=${q.onClick}>${q.children}</button>`;
}
function shimMicroLabel(p) { return html`<span class="micro">${(p || {}).children}</span>`; }
function shimToast(text) {
  try { if (typeof console !== 'undefined' && console.log) console.log('[shell] ' + text); } catch (e) { /* ignore */ }
}

function installShims() {
  html = shimHtml;
  useState = shimUseState;
  useEffect = shimUseEffect;
  Modal = shimModal;
  Button = shimButton;
  MicroLabel = shimMicroLabel;
  toast = shimToast;
}
installShims();

/** Resolve the shared overlay UI kit (ui/overlayKit.js) -- the SAME instance every overlay module
 *  uses (the kit registers window.__SP_UI_KIT; the first loader wins, later ones reuse it). */
async function loadDeps() {
  let kit = null;
  try { kit = await import('./overlayKit.js'); } catch (e) { /* keep the shims */ }
  try { const cc = await import('./connect-core.js'); if (cc && typeof cc.copyText === 'function') copyText = cc.copyText; } catch (e) { /* no clipboard bridge: the row says so */ }
  // globalThis.window rather than a bare `window`: this file is linted against the node globals table
  // (tools/** is nodeFiles), where a bare window is a no-undef error. In a browser globalThis === window,
  // so the semantics are identical; in the node tests globalThis.window is what the harness sets.
  const win = typeof globalThis.window === 'undefined' ? null : globalThis.window;
  const g = (win && win.__SP_UI_KIT) ? win.__SP_UI_KIT : null;
  if (g) kit = g;
  if (kit && typeof kit.html === 'function' && typeof kit.Modal === 'function'
      && typeof kit.Button === 'function' && typeof kit.MicroLabel === 'function') {
    html = kit.html;
    Modal = kit.Modal;
    Button = kit.Button;
    MicroLabel = kit.MicroLabel;
    if (typeof kit.toast === 'function') toast = kit.toast;
    if (typeof kit.useState === 'function') useState = kit.useState;
    if (typeof kit.useEffect === 'function') useEffect = kit.useEffect;
  }
}

// ---- formatting (the panel only formats what the API hands it; nothing is guessed) --------------
function mb(bytes) {
  const n = typeof bytes === 'number' && isFinite(bytes) ? bytes : 0;
  return n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : Math.round(n / 1024) + ' KB';
}

function dayOf(iso) {
  const s = typeof iso === 'string' ? iso : '';
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

/** The rejection / failure vocabulary the overlay returns, in the owner's language. Unknown codes are
 *  shown verbatim -- a new code must never be swallowed into a generic "失败". */
const REASONS = {
  FEATURE_OFF: '管理器总开关是关闭的（先打开它）',
  NO_SUCH_MOD: '目录里没有这个包',
  DOWNLOAD_NOT_ALLOWED: '下载地址不在允许的站点上（已拒）',
  HOST_NOT_ALLOWED: '下载地址的主机不在白名单里（已拒）',
  HOST_DENIED: '下载地址是环回/私网/保留地址（已拒）',
  BAD_SCHEME: '下载地址不是 http/https（已拒）',
  BAD_URL: '下载地址不合法（已拒）',
  TOO_LARGE: '包太大（超过上限）',
  BAD_ZIP: '不是有效的 zip',
  UNSAFE_ENTRY: 'zip 里有越界路径（已拒，未落盘）',
  UNSUPPORTED_ENTRY: 'zip 用了不支持的压缩方式（已拒）',
  TOO_MANY_ENTRIES: 'zip 条目过多（已拒）',
  ENTRY_TOO_LARGE: 'zip 里有超大条目（已拒）',
  UNPACKED_TOO_LARGE: '解包总量超过上限（已拒）',
  BAD_PACK_JSON: '包里没有合法的 pack.json',
  ID_MISMATCH: 'pack.json 的 id 与目录名不一致',
  API_MISMATCH: '包的 api 区间与本引擎世代不符',
  MOD_CODE_ENTRY_UNSUPPORTED: '这个包带代码入口（server / client / kits / routes）——本版只收数据层的包，已拒绝',
  MOD_UNSUPPORTED_FIELD: '这个包声明了本版不认识的字段，已拒绝',
  WRITE_FAILED: '写盘失败（只读树？）',
  FETCH_FAILED: '网络取不到（站点不通 / 离线）',
  BAD_CATALOG: '站点返回的不是合法 JSON',
  FORBIDDEN: '本机控制面只答环回来源',
  METHOD: '请求方法不对',
  INTERNAL: '内部错误',
  BAD_ID: '包 id 不合法',
};

function reasonText(code, entry) {
  const c = typeof code === 'string' ? code : '';
  if (!c) return '';
  const base = REASONS[c] || c;
  return entry ? base + '（' + entry + '）' : base;
}

// ---- the local overlay API (same-origin; never the mod site directly) ---------------------------
const API = {
  catalog: '/sp/mods/catalog',
  installed: '/sp/mods/installed',
  install: '/sp/mods/install',
  state: '/sp/mods/state',
  uninstall: '/sp/mods/uninstall',
  feature: '/sp/mods/feature',
};

// ---- 插件工作台（upstream 0.3.1 /studio，2026-10-18 业主：「抄一下他的 mod 管理器逻辑，用我的
// mod 管理器界面」）--------------------------------------------------------------------------------
// The Forge launcher's PLUGIN STUDIO page is upstream's own workbench (server/studio/*): a left rail
// with 新建插件 / 从目录安装 / 从 Forge 包导入, a plugin list, zip packing and hot reload. This panel
// keeps OUR overlay kit look and drives the same API instead of re-drawing that page:
//   GET  /studio/api/info + /studio/api/plugins     read, no key (gate: loopback/LAN only)
//   POST /studio/api/plugins                        new plugin { template, id, name, target }
//   POST /studio/api/forge/import                   Forge pack { zip: base64 }
//   POST /studio/api/plugins/<id>/pack              write plugin.lock.json
//   GET  /studio/api/plugins/<id>/zip               download (the DownloadListener saves it)
//   POST /studio/api/plugins/remove                 { ids: [...] } -> plugins/_removed/<id>-<time>/
// Writes carry X-SP-Studio (plugins/.studio-key). The key reaches the page through shell.studioKey(),
// which the native side answers ONLY on the loopback origin — so a third-party server's page cannot
// write into this device's plugins/.
const STUDIO = {
  info: '/studio/api/info',
  plugins: '/studio/api/plugins',
  remove: '/studio/api/plugins/remove',
  targets: '/studio/api/targets',
  suggest: '/studio/api/suggest-id',
  forgeImport: '/studio/api/forge/import',
};

/** The studio's write key from the native bridge ('' on a plain page / an old APK). */
function studioKey() {
  try {
    const win = typeof globalThis.window === 'undefined' ? null : globalThis.window;
    const sh = win && win.shell;
    if (!sh || typeof sh.studioKey !== 'function') return '';
    const v = sh.studioKey();
    return (v == null) ? '' : String(v);
  } catch (e) { return ''; }
}

/** One studio API call: {ok, status, json, error}. Body => POST (with the key header). */
async function studioFetch(path, body, key) {
  try {
    const headers = {};
    if (key) headers['X-SP-Studio'] = key;
    let init;
    if (body) {
      headers['content-type'] = 'application/json';
      init = { method: 'POST', headers: headers, body: JSON.stringify(body) };
    } else {
      init = { method: 'GET', headers: headers };
    }
    const res = await fetch(path, init);
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    const out = json && typeof json === 'object' ? json : {};
    const err = out.error ? String(out.error) : (res.ok ? '' : 'HTTP_' + res.status);
    return { ok: res.ok && !out.error, status: res.status, json: out, error: err };
  } catch (e) {
    return { ok: false, status: 0, json: {}, error: 'FETCH_FAILED' };
  }
}

/** A File -> base64 (no data: prefix), for the Forge-zip upload. Rejects when FileReader is absent. */
function fileToBase64(file) {
  return new Promise(function (resolve, reject) {
    try {
      const FR = typeof globalThis.FileReader === 'function' ? globalThis.FileReader : null;
      if (!FR) { reject(new Error('no FileReader')); return; }
      const fr = new FR();
      fr.onload = function () {
        const s = String(fr.result || '');
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : '');
      };
      fr.onerror = function () { reject(new Error('read failed')); };
      fr.readAsDataURL(file);
    } catch (e) { reject(e); }
  });
}

/** Studio error code -> the panel's language (unknown codes are shown verbatim, never swallowed). */
const STUDIO_REASONS = {
  NO_KEY: '只读：没有工作台密钥（plugins/.studio-key）',
  PLUGIN_STUDIO_KEY: '工作台密钥不对（服务已重启？）',
  PLUGIN_STUDIO_TEMPLATE: '模板不存在',
  PLUGIN_STUDIO_TARGET: '目标不存在（先试写官方名字/键）',
  PLUGIN_ID: '插件 id 不合法',
  TARGET_NOT_FOUND: '没找到这个目标',
  ID_FAILED: '生成插件 id 失败',
  FETCH_FAILED: '本机服务没应答（node 没启动？）',
  PLUGIN_FILE_SIZE: '文件太大',
  PLUGIN_STUDIO_SIZE: '上传内容超过上限',
};
function studioReason(code) {
  const c = typeof code === 'string' ? code : '';
  if (!c) return '';
  return STUDIO_REASONS[c] || c;
}

/**
 * Is this page served by THIS device's own server (the one the sp-mods overlay is registered on)?
 *
 * 这些端点是**本机** Node 的路由，面板只打同源的 /sp/mods/*。第三方服页面（业主 2026-10-11 报的
 * http://103.205.253.194:27527/）上同源即那台服务器 —— 打过去既没有这条路由（404），有的页面还会
 * 把 window.fetch 包一层改写路径，等于我们拿管理器的请求去撞人家的服务器。所以非本机页面**一个
 * 请求都不发**，直接说明「只在本机可用」。
 *
 * 判据与 lobby.js isOwnHostPage() 逐字一致（回环才算本机）：局域网访客打开的是**房主**的私网地址，
 * 私网 hostname 也会被判成「本机」，而访客页面的 /sp/mods/* 只会落到房主那台机器上（其控制面本来
 * 就只答环回来源，见 FORBIDDEN）。没有 location（测试沙箱 / 非浏览器）时按「未知」处理成**非本机**：
 * 宁可少给功能，也不猜。
 */
function isOwnHostPage() {
  try {
    const loc = typeof globalThis.location === 'undefined' ? null : globalThis.location;
    const hostname = loc && typeof loc.hostname === 'string' ? loc.hostname : '';
    const h = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
    return h === '127.0.0.1' || h === '::1' || h === 'localhost';
  } catch (e) { return false; }
}

async function call(path, body) {
  try {
    const init = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method: 'GET' };
    const res = await fetch(path, init);
    const json = await res.json();
    return json && typeof json === 'object' ? json : { ok: false, error: 'INTERNAL' };
  } catch (e) {
    return { ok: false, error: 'FETCH_FAILED' };
  }
}

// ---- layer helpers (the shellPanels.js / preloadPanel.js idiom) ---------------------------------
const HEAD_STYLE = 'border-top:1px solid #1e2823;margin-top:.12rem;padding-top:.14rem';

function layerHead(title, micro) {
  return html`<div class="set-row" style=${HEAD_STYLE}>
    <span class="set-row__label" style="color:#4ed8af">${title}<${MicroLabel}>${micro}<//></span>
  </div>`;
}

/** 反馈群号（业主 2026-10-17）：写死一个常量，不从站点取 —— 站点给不了群号，取来反而会把
 *  「人的反馈入口」和「机器的抓取入口」耦在一起。 */
const QUN_NO = '293032860';

/** 点群号复制。copyText 走 App 剪贴板桥（shell.copyText）→ 浏览器 API → textarea 兜底三级，
 *  任一环可用就能复制；桥整体缺席时把号念出来，让玩家手动抄。
 *  反馈同时落在 kit 的 toast（有 kit 时）和 hint 回调（面板自己的 hint 行）——两条路都兜住，
 *  因为 kit 在第三方页面上可能缺席，而 hint 行永远在。setNote 是组件里的闭包，所以当参数传进来。 */
function copyQun(setNote) {
  const done = function (ok) {
    const msg = ok ? '已复制反馈群号：' + QUN_NO : '复制失败，请手动记下群号：' + QUN_NO;
    if (typeof setNote === 'function') setNote(msg);
    try { if (typeof toast === 'function') toast(msg); } catch (e) { /* no kit (tests) */ }
  };
  if (typeof copyText === 'function') {
    try {
      copyText(QUN_NO).then(function (ok) { done(!!ok); }, function () { done(false); });
    } catch (e) { done(false); }
    return;
  }
  done(false);
}

function infoRow(label, micro, value) {
  return html`<div class="set-row">
    <span class="set-row__label">${label}<${MicroLabel}>${micro}<//></span>
    <span style="grid-column:2 / 4;min-width:0;opacity:.92;overflow-wrap:anywhere">${value}</span>
  </div>`;
}

function actRow(label, micro, buttons) {
  return html`<div class="set-row">
    <span class="set-row__label">${label}<${MicroLabel}>${micro}<//></span>
    <div style="grid-column:2 / 4;min-width:0;display:flex;flex-wrap:wrap;gap:.08rem">${buttons}</div>
  </div>`;
}

const BTN = 'set-apply';

function applyBtn(text, onClick, disabled) {
  return html`<button type="button" class=${BTN} style="white-space:nowrap" disabled=${!!disabled}
    onClick=${onClick}>${text}</button>`;
}

/** 层与代码入口的标记（Forge 口径：A 数据 / B 服务端逻辑 / C 客户端界面）。 */
const LAYER_LABEL = { A: '数据层', B: '服务端逻辑', C: '客户端界面' };

/**
 * 生效边界（2026-10-12，业主口径「做成热更新好更新的形式」）：
 * 三条车道的热更边界**不一样**，所以提示不能一刀切喊「重开 APK」——
 *   A 数据/素材 → 随 slim 热更树下发，下一轮更新自动生效，不用重载；
 *   C 客户端界面/主题 → 同样随热更树下发；只有**改启用状态**要重载页面（钩子/面板在页面加载时读一次）；
 *   B 服务端钩子 → 钩子在 host 启动时装载，必须重启服务（这不是缺陷：消息级接缝只能挂在活对象上）。
 * 依据：MainActivity.openLocal() 先查 filesDir/webroot（热更树）再查 APK assets，
 * 而 Updater.applyExtras() 把 shell-ui/extras 的 public/ 铺进那棵树。
 */
function applyHint(m) {
  const layer = (m && m.layer) || 'A';
  if (layer === 'B') return '服务端钩子在 host 启动时装载 —— 重启服务（或重开 APK）后生效';
  if (layer === 'C') return '客户端界面随热更树下发；改了启用状态要重载页面才生效';
  return '数据层随热更树下发 —— 下一轮热更新即生效，无需重载';
}

/** One catalogue entry as a CARD (业主 2026-10-13：一行两个 mod)。
 *  `noteOpen` / `onToggleNote`: 站点备注默认**折叠**（业主 2026-10-12）—— 站点的 note 动辄上千字
 *  （改了什么、逐字节比对结论…），铺开会把整页挤满；要看的自己点开。 */
function modCard(m, busy, onInstall, onToggle, onUninstall, noteOpen, onToggleNote) {
  const meta = [mb(m.size), dayOf(m.uploadedAt)].filter(Boolean).join(' · ');
  const by = [m.author, m.compatAuthor ? '改写 ' + m.compatAuthor : ''].filter(Boolean).join(' · ');
  const buttons = [];
  // 站点有新版（catalog 比过 uploadedAt / zip 大小）：按钮文案从「安装」变「更新」。装的是同一个 pack id，
  // 走的还是 install() 的覆盖安装（旧目录改名到一边、新包原子搬入），所以「更新」不是一个新能力，是一个提示。
  if (!m.installed) {
    buttons.push(applyBtn(busy ? '安装中…' : '安装', onInstall, busy));
  } else if (m.updateAvailable) {
    buttons.push(applyBtn(busy ? '更新中…' : '更新', onInstall, busy));
    buttons.push(applyBtn('卸载', onUninstall, busy));
  } else {
    buttons.push(applyBtn(m.enabled ? '停用' : '启用', onToggle, busy));
    buttons.push(applyBtn('卸载', onUninstall, busy));
  }
  // 分类标签用**站点给的中文**（funcKindTitle），站点没给就退回 key —— 本地不另编一套。
  const catLabel = m.funcKindTitle || m.funcKind || '';
  const cat = catLabel ? html`<span class="sp-mod-badge">${catLabel}</span>` : null;
  const layer = m.layer ? html`<span class="sp-mod-badge">${LAYER_LABEL[m.layer] || m.layer}</span>` : null;
  const code = (m.code && m.code.length)
    ? html`<span class="sp-mod-badge sp-mod-badge--warn" title=${'含代码入口：' + m.code.join(' / ')}>含代码</span>`
    : null;
  const suspected = (m.flagged || m.suspected)
    ? html`<span class="sp-mod-badge sp-mod-badge--warn" title=${(m.suspectedReasons || []).join('；')}>含疑似官方素材</span>`
    : null;
  // 同一个 pack id 在站点上有另一条（站侧「改名重投」/「旧 compat 被取代」的产物）：如实列出来，
  // 不替用户挑 —— 哪条该留只有站点 note 里的人知道，代码猜不了。
  const dup = (m.installed && m.sameIdCount)
    ? html`<span class="sp-mod-badge sp-mod-badge--warn" title=${'同一个 pack id 在站点上还有 ' + m.sameIdCount + ' 条。装哪条都会覆盖另一条，请看条目备注再选。'}>同 id ${m.sameIdCount} 条</span>`
    : null;
  // 名字：外层量宽、内层滚（超 70% 才滚，见面板里的 useEffect）。title 始终给全名，滚不动也能看。
  return html`<div class="sp-mod-card">
    <span class="sp-mod-card__name" title=${m.name || m.id}><span>${m.name || m.id}</span></span>
    <div class="sp-mod-badges">${cat}${suspected}${code}${dup}${layer}</div>
    <span class="sp-mod-meta">${meta}${by ? ' · ' + by : ''}${m.installed ? (m.enabled ? ' · 已装并启用' : ' · 已装未启用') : ''}${m.installed && m.updateAvailable ? ' · 站点有新版' : ''}</span>
    <div class="sp-mod-acts">${buttons}</div>
    ${m.note ? html`<div class="sp-mod-note">
      <button type="button" class=${BTN} style="white-space:nowrap;align-self:flex-start;opacity:.85"
        onClick=${onToggleNote}>${noteOpen ? '收起备注' : '查看备注'}</button>
      ${noteOpen ? html`<span class="sp-mod-note__body">${m.note}</span>` : null}
    </div>` : null}
  </div>`;
}

/** One plugin folder of the studio as OUR card: name / class / version / state + 打包 / 下载 zip / 移除. */
function studioCard(p, busy, onPack, onRemove) {
  const status = String(p.status || '');
  return html`<div class="sp-mod-card">
    <a class="sp-mod-card__name" href="/studio/"
      title=${'打开插件工作台（会离开当前页面，返回键回来）：' + (p.name || p.id)}><span>${p.name || p.id}</span></a>
    <div class="sp-mod-badges">
      ${p.class ? html`<span class="sp-mod-badge">${p.class}</span>` : null}
      ${p.version ? html`<span class="sp-mod-badge">v${p.version}</span>` : null}
      ${status ? html`<span class="sp-mod-badge">${status === 'skipped' ? '未装载' : status}</span>` : null}
      ${p.problems ? html`<span class="sp-mod-badge sp-mod-badge--warn">${p.problems} 个问题</span>` : null}
    </div>
    <span class="sp-mod-meta">${p.id}</span>
    <div class="sp-mod-acts">
      ${applyBtn(busy ? '处理中…' : '打包', onPack, busy)}
      <a class="sp-mod-link" href=${'/studio/api/plugins/' + encodeURIComponent(p.id) + '/zip'}>下载 zip</a>
      ${applyBtn('移除', onRemove, busy)}
    </div>
  </div>`;
}

// ---- 面板自己的样式表（业主 2026-10-13：一行两个 mod / 放大尺寸 / 长名左右滚动）------------------
// 与本模块其余部分同一条纪律：只加一张自己的表，每个选择器都带 sp-mod* 前缀，不碰上游与 kit 的类。
const PANEL_STYLE_ID = 'sp-mods-panel-style';

/** 样式表（每条规则一行，静态可抽取 —— 与 preloadPanel.js 的 panelStyleCss 同一写法）。
 *  颜色走 kit 令牌（--sp-*），并带 var() 兜底（第三方页面上 kit 缺席时仍看得见）。 */
function panelStyleCss() {
  return [
    // 分类筛选条（分类键与中文标签都由**站点**给，见 sp-mods.mjs 的 catalog）
    '.sp-mods-chips{display:flex;flex-wrap:wrap;gap:.06rem;align-items:center;margin:.02rem 0 .06rem}',
    '.sp-mod-chip{box-sizing:border-box;display:inline-flex;align-items:center;gap:.05rem;min-height:max(.34rem,32px);',
    'padding:0 .1rem;background:rgba(10,13,12,.5);border:1px solid var(--sp-line2,#3e4b45);color:var(--sp-text,#c3cbc7);',
    'font-size:.15rem;letter-spacing:.02em;white-space:nowrap;cursor:pointer}',
    '.sp-mod-chip:hover{border-color:var(--sp-mint,#4ed8af);color:var(--sp-mint,#4ed8af)}',
    '.sp-mod-chip.is-on{border-color:var(--sp-mint,#4ed8af);color:var(--sp-mint,#4ed8af);background:rgba(78,216,175,.12)}',
    '.sp-mod-chip__n{opacity:.65;font-size:.86em}',
    // 两列卡片网格（窄屏回落单列，否则卡片会被压得读不了）
    '.sp-mods-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.08rem;align-items:start}',
    '@media (max-width:720px){.sp-mods-grid{grid-template-columns:minmax(0,1fr)}}',
    '.sp-mod-card{box-sizing:border-box;display:flex;flex-direction:column;gap:.06rem;min-width:0;padding:.1rem;',
    'border:1px solid var(--sp-line2,#3e4b45);background:rgba(10,13,12,.42)}',
    '.sp-mod-card:hover{border-color:var(--sp-mint,#4ed8af)}',
    // 名字：默认单行省略；超过卡片可用宽 70%（脚本量出来的）才加 is-scroll 左右来回滚
    '.sp-mod-card__name{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    'font-size:.17rem;font-weight:700;color:var(--sp-text-hi,#f2f2f2);text-decoration:none}',
    '.sp-mod-card__name.is-scroll{text-overflow:clip}',
    '.sp-mod-card__name.is-scroll>span{display:inline-block;white-space:nowrap;',
    'animation:sp-mod-name 6.5s ease-in-out infinite alternate}',
    '@keyframes sp-mod-name{from{transform:translateX(0)}to{transform:translateX(var(--sp-mod-shift,0px))}}',
    '@media (prefers-reduced-motion:reduce){.sp-mod-card__name.is-scroll>span{animation:none}}',
    '.sp-mod-badges{display:flex;flex-wrap:wrap;gap:.05rem;align-items:center}',
    '.sp-mod-badge{font-size:.12rem;padding:.01rem .06rem;border:1px solid var(--sp-line2,#3e4b45);color:var(--sp-text-lo,#8a948f)}',
    '.sp-mod-badge--warn{border-color:#e0b050;color:#e0b050}',
    '.sp-mod-meta{font-size:.13rem;line-height:1.5;color:var(--sp-text-lo,#8a948f);overflow-wrap:anywhere}',
    // 反馈群号（业主 2026-10-17）：一颗带框、可点复制的号。颜色走 kit 令牌并带 var() 兜底，
    // 与 sp-mod-chip 同一套边框语言（叠加层自带 kit，第三方页面上也长得一样）。
    '.sp-mod-qun{box-sizing:border-box;display:inline-flex;align-items:center;min-height:max(.34rem,32px);',
    'padding:0 .16rem;background:rgba(10,13,12,.5);border:1px solid var(--sp-mint,#4ed8af);color:var(--sp-mint,#4ed8af);',
    'font-size:.16rem;font-weight:700;letter-spacing:.06em;white-space:nowrap;cursor:pointer;',
    'font-family:inherit;transition:border-color .15s ease,color .15s ease,background .15s ease}',
    '.sp-mod-qun:hover{background:rgba(78,216,175,.12)}',
    '.sp-mod-qun:active{transform:translateY(1px)}',
    '.sp-mod-qun.is-copied{border-color:var(--sp-mint,#4ed8af);color:var(--sp-text-hi,#f2f2f2)}',
    '.sp-mod-acts{display:flex;flex-wrap:wrap;gap:.06rem;align-items:center;margin-top:.02rem}',
    '.sp-mod-note{display:flex;flex-direction:column;gap:.05rem;min-width:0}',
    '.sp-mod-note__body{font-size:.13rem;line-height:1.55;color:var(--sp-text,#c3cbc7);overflow-wrap:anywhere;max-height:8rem;overflow:auto}',
    // 插件工作台（2026-10-18）：输入框 / 下拉 / 下载链接 —— 与 set-row 的按钮同高同边框语言
    '.sp-mod-input{box-sizing:border-box;min-height:max(.34rem,32px);max-width:11rem;padding:0 .08rem;',
    'background:#0a0d0c;border:1px solid var(--sp-line2,#3e4b45);color:var(--sp-text-hi,#f2f2f2);',
    'font-family:inherit;font-size:.14rem;outline:none}',
    '.sp-mod-input:focus{border-color:var(--sp-mint,#4ed8af)}',
    '.sp-mod-link{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;',
    'min-height:max(.34rem,32px);padding:0 .12rem;background:#121816;border:1px solid var(--sp-line2,#3e4b45);',
    'color:var(--sp-text-hi,#f2f2f2);font-size:.14rem;text-decoration:none;white-space:nowrap}',
    '.sp-mod-link:hover{border-color:var(--sp-mint,#4ed8af);color:var(--sp-mint,#4ed8af)}',
  ].join('');
}

/** 一次性注入（按 id 幂等）。无 DOM / 无 head → 静默 no-op，永不抛（测试与老壳继续可用）。 */
export function injectModsPanelStyles() {
  try {
    // 用 globalThis 取（与本文件其余部分一致：这个模块被当 node 源检查，裸 document 会 no-undef）
    const doc = typeof globalThis === 'undefined' ? null : globalThis.document;
    if (!doc || typeof doc.createElement !== 'function') return false;
    if (typeof doc.getElementById === 'function' && doc.getElementById(PANEL_STYLE_ID)) return true;
    const el = doc.createElement('style');
    el.setAttribute('id', PANEL_STYLE_ID);
    el.textContent = panelStyleCss();
    const head = doc.head || doc.documentElement;
    if (!head || typeof head.appendChild !== 'function') return false;
    head.appendChild(el);
    return true;
  } catch (e) { return false; }
}

// ---- the panel -----------------------------------------------------------------------------------
/** props.onClose: close the panel (the shell host passes it). Everything it draws comes from the
 *  local overlay's /sp/mods/* replies; a failure is always visible in the hint line. */
export function ModsPanel(props) {
  const onClose = props && props.onClose;
  const noteState = useState('');
  const note = noteState[0];
  const setNote = noteState[1];
  const catState = useState({ mods: [], errors: [], site: '', feature: false, loaded: false });
  const cat = catState[0];
  const setCat = catState[1];
  const instState = useState({ mods: [], dir: '' });
  const inst = instState[0];
  const setInst = instState[1];
  const busyState = useState('');
  const busy = busyState[0];
  const setBusy = busyState[1];
  // 哪几条的站点备注被展开（默认全折叠 —— 业主 2026-10-12）。按条目 id 记，多条目可同时开着。
  const openNotesState = useState({});
  const openNotes = openNotesState[0];
  const setOpenNotes = openNotesState[1];
  const toggleNote = (id) => setOpenNotes(Object.assign({}, openNotes, { [id]: !openNotes[id] }));
  const reloadState = useState('');
  const reloadHint = reloadState[0];
  const setReloadHint = reloadState[1];
  // 插件工作台（2026-10-18）：列表/状态 + 新建表单的三个字段
  const studioState = useState({ loaded: false, ok: false, err: '', info: null, plugins: [] });
  const studio = studioState[0];
  const setStudio = studioState[1];
  const nsNameState = useState('');
  const nsName = nsNameState[0];
  const setNsName = nsNameState[1];
  const nsTplState = useState('');
  const nsTpl = nsTplState[0];
  const setNsTpl = nsTplState[1];
  const nsTargetState = useState('');
  const nsTarget = nsTargetState[0];
  const setNsTarget = nsTargetState[1];

  function refresh() {
    // 非本机页面：一个请求都不发（see isOwnHostPage）。目录/已装都留空，画面走「只在本机可用」那层。
    if (!isOwnHostPage()) return Promise.resolve();
    return Promise.all([call(API.catalog), call(API.installed)]).then(([c, i]) => {
      if (c && typeof c === 'object') {
        setCat({
          mods: Array.isArray(c.mods) ? c.mods : [],
          errors: Array.isArray(c.errors) ? c.errors : [],
          site: typeof c.site === 'string' ? c.site : '',
          // 分类清单由服务端从站点透出（业主 2026-10-13「分类按站上来」）—— 本地不硬编码。
          funcs: Array.isArray(c.funcs) ? c.funcs : [],
          feature: c.feature === true,
          loaded: true,
        });
        if (c.errors && c.errors.length) setNote(reasonText(c.errors[0], ''));
      }
      if (i && typeof i === 'object') {
        setInst({ mods: Array.isArray(i.mods) ? i.mods : [], dir: typeof i.dir === 'string' ? i.dir : '' });
      }
    });
  }

  useEffect(function () {
    injectModsPanelStyles(); // 两列卡片 / 分类条 / 长名滚动的那张表（按 id 幂等）
    refresh();
    refreshStudio();
  }, []);

  /** Studio info + plugin list (reads; no key). A server without /studio answers 404 -> ok:false. */
  function refreshStudio() {
    if (!isOwnHostPage()) {
      // 非本机页面：不发请求，也不能停在「读取中…」（Sourcery 审计 #5）。
      setStudio({ loaded: true, ok: false, err: 'LOCAL_ONLY', info: null, plugins: [] });
      return Promise.resolve();
    }
    return studioFetch(STUDIO.info).then(function (info) {
      if (!info.ok) { setStudio({ loaded: true, ok: false, err: info.error, info: null, plugins: [] }); return; }
      return studioFetch(STUDIO.plugins).then(function (list) {
        setStudio({
          loaded: true,
          ok: true,
          err: '',
          info: info.json,
          plugins: (list.json && Array.isArray(list.json.plugins)) ? list.json.plugins : [],
        });
      });
    });
  }

  function run(label, promise, reloadHintText) {
    setBusy(label);
    return promise.then((r) => {
      setBusy('');
      const detail = (r && r.entry) || ((r && r.fields && r.fields.length) ? r.fields.join(', ') : '');
      if (!r || r.ok !== true) setNote(reasonText(r && r.error, detail));
      else {
        setNote('');
        // 业主口径 2026-10-11：装上即启用，**生效在下次加载** —— 明说「热重载或重开 APK」，
        // 并给一个就地重载的按钮（不然用户只能自己找刷新）。
        if (reloadHintText) setReloadHint(reloadHintText);
      }
      return refresh();
    }, () => {
      setBusy('');
      setNote(reasonText('INTERNAL', ''));
    });
  }

  // ---- 插件工作台 handlers（2026-10-18）-----------------------------------------------------------
  /** 一次工作台操作的**业务**结果（HTTP 200 不等于成功）：返回要显示的问题，'' = 真成功。
   *  Forge 导入会带 report.ok=false / 没有产出；移除会带 refused[]（在用的房间/受保护的包）。 */
  function studioResultProblem(action, json) {
    const o = json && typeof json === 'object' ? json : {};
    if (action === 'forge') {
      const rep = o.report && typeof o.report === 'object' ? o.report : null;
      if (rep && rep.ok === false) {
        const first = Array.isArray(rep.issues) && rep.issues.length ? rep.issues[0] : null;
        const why = first ? String(first.code || first.detail || '') : '';
        return 'Forge 包校验未通过' + (why ? '：' + why : '');
      }
      const products = Array.isArray(o.plugins) ? o.plugins : [];
      if (!products.length) return 'Forge 包没有产出可安装的插件';
      return '';
    }
    if (action === 'rm') {
      const refused = Array.isArray(o.refused) ? o.refused : [];
      if (refused.length) {
        const first = refused[0] && typeof refused[0] === 'object' ? refused[0] : {};
        return '有 ' + refused.length + ' 个插件未移除' + (first.error ? '（' + String(first.error) + '）' : '');
      }
      const removed = Array.isArray(o.removed) ? o.removed : [];
      if (!removed.length) return '没有插件被移除';
      return '';
    }
    return '';
  }

  function runStudio(action, promise, okText) {
    setBusy('studio');
    return promise.then(function (r) {
      setBusy('');
      if (!r || r.ok !== true) { setNote('插件工作台：' + (studioReason(r && r.error) || '失败')); }
      else {
        const problem = studioResultProblem(action, r.json);
        setNote(problem ? '插件工作台：' + problem : (okText || ''));
      }
      return refreshStudio();
    }, function () {
      setBusy('');
      setNote('插件工作台：内部错误');
    });
  }

  /** 新建插件：目标名先查 targets（取第一个），再要一个空闲 id，最后 POST /studio/api/plugins. */
  function createStudioPlugin(key) {
    if (!key) { setNote('插件工作台：' + studioReason('NO_KEY')); return; }
    if (!nsTpl) { setNote('插件工作台：先选一个模板'); return; }
    const name = String(nsName || '').trim();
    const targetText = String(nsTarget || '').trim();
    const request = (targetText
      ? studioFetch(STUDIO.targets + '?q=' + encodeURIComponent(targetText) + '&limit=1')
      : Promise.resolve({ ok: true, json: { targets: [] } })
    ).then(function (tr) {
      const first = (tr.json && Array.isArray(tr.json.targets)) ? tr.json.targets[0] : null;
      if (targetText && !first) return { ok: false, error: 'TARGET_NOT_FOUND' };
      const target = first ? (String(first.kind) + ':' + String(first.key)) : '';
      const q = STUDIO.suggest + '?name=' + encodeURIComponent(name) + '&template=' + encodeURIComponent(nsTpl)
        + (target ? '&target=' + encodeURIComponent(target) : '');
      return studioFetch(q).then(function (ir) {
        const id = (ir.json && ir.json.id) ? String(ir.json.id) : '';
        if (!id) return { ok: false, error: 'ID_FAILED' };
        const body = { template: nsTpl, id: id, name: name || id };
        if (target) body.target = target;
        return studioFetch(STUDIO.plugins, body, key);
      });
    });
    runStudio('create', request, '插件已创建 —— 在工作台页面里细调，或重载页面后生效');
  }

  /** Forge 包导入：<input type=file> 的 zip -> base64 -> POST /studio/api/forge/import { zip }.
   *  上游只收 JSON base64（没有 raw 上传口），所以大包先在本机拦下：base64 会把体积放大约 4/3，
   *  超过请求体上限的包在 WebView 里会把内存打爆（Sourcery 审计 #3）。 */
  function importStudioForge(file, key) {
    if (!file) return;
    if (!key) { setNote('插件工作台：' + studioReason('NO_KEY')); return; }
    const cap = studio.info && studio.info.limits && Number(studio.info.limits.bodyBytes);
    if (cap > 0) {
      const maxRaw = Math.floor((cap - 4096) / 4) * 3;
      if (file.size > maxRaw) {
        setNote('插件工作台：这个包 ' + mb(file.size) + '，超过面板可上传上限（约 ' + mb(maxRaw)
          + '）—— 请用 /studio/ 页面导入（同样的接口，但它按原始文件流处理）');
        return;
      }
    }
    setBusy('studio');
    fileToBase64(file).then(function (b64) {
      if (!b64) { setBusy(''); setNote('插件工作台：读取文件失败'); return; }
      return runStudio('forge', studioFetch(STUDIO.forgeImport, { zip: b64 }, key), 'Forge 包已导入 —— 重载页面后生效');
    }, function () { setBusy(''); setNote('插件工作台：读取文件失败'); });
  }

  function packStudioPlugin(id, key) {
    runStudio('pack', studioFetch(STUDIO.plugins + '/' + encodeURIComponent(id) + '/pack', {}, key), '已打包 plugin.lock.json');
  }

  function removeStudioPlugin(id, key) {
    runStudio('rm', studioFetch(STUDIO.remove, { ids: [id] }, key), '已移除（移到 plugins/_removed/<id>-<时间>/，可手动还原）');
  }

  const feature = cat.feature === true;
  const mods = cat.mods || [];
  const local = isOwnHostPage();
  // 插件工作台（2026-10-18）：密钥只在回环页面拿（native 也只在回环 origin 交出）；只读时按钮禁用。
  const skey = local ? studioKey() : '';
  const templates = (studio.info && Array.isArray(studio.info.templates)) ? studio.info.templates : [];
  const studioPlugins = Array.isArray(studio.plugins) ? studio.plugins : [];
  const studioBusy = busy === 'studio';
  // ---- 分类筛选（业主 2026-10-13「分类按站上来（做成可更新样式）」）-----------------------------
  // 分类键与中文标签都来自服务端（= 站点 /api/mods 的 funcs / funcKindTitles），站点加一个新分类
  // 下次拉目录就自动出现在这里 —— 本地不硬编码任何分类名。'' = 全部。
  const funcState = useState('');
  const funcPick = funcState[0];
  const setFuncPick = funcState[1];
  const funcs = Array.isArray(cat.funcs) ? cat.funcs : [];
  const shown = funcPick ? mods.filter(function (m) { return m.funcKind === funcPick; }) : mods;
  // 名字超过卡片可用宽 70% 时左右来回滚（业主口径）。量宽必须等 DOM 落地，所以放 effect 里按
  // 选择器扫一遍；每次渲染都重算（筛选切换后节点全变）。拿不到 DOM（测试沙箱）静默跳过。
  useEffect(function () {
    try {
      const doc = globalThis.document;
      if (!doc || typeof doc.querySelectorAll !== 'function') return;
      const nodes = doc.querySelectorAll('.sp-mod-card__name');
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        const inner = el.firstElementChild;
        if (!inner) continue;
        const box = typeof el.clientWidth === 'number' ? el.clientWidth : 0;
        const text = typeof inner.scrollWidth === 'number' ? inner.scrollWidth : 0;
        // 业主口径：名字占用超过卡片可用宽的 70% 就滚（滚动距离 = 溢出量）
        if (box > 0 && text > box * 0.7) {
          el.classList.add('is-scroll');
          el.style.setProperty('--sp-mod-shift', (-(text - box)) + 'px');
        } else {
          el.classList.remove('is-scroll');
        }
      }
    } catch (e) { /* 无 DOM：静默 */ }
  });
  // 本页此刻**已经生效**的东西：装载器在页面加载时读过一次 /sp/mods/loader（见 ui/modsLoader.js）。
  // 面板只读它、不自己再拉一次 —— 装完/改完要重载页面才会变，正好对上「热重载或重开 APK」这句话。
  let active = null;
  try { active = (globalThis.window && globalThis.window.__SP_MODS_LOADER) || null; } catch (e) { active = null; }
  const activePacks = active && Array.isArray(active.packs) ? active.packs : [];
  let panelInfo = null;
  try { panelInfo = (globalThis.window && globalThis.window.__SP_MOD_PANELS) || null; } catch (e) { panelInfo = null; }
  const declaredPanels = activePacks.reduce(function (a, p) { return a + ((p.panels && p.panels.length) || 0); }, 0);
  const mountedPanels = panelInfo && typeof panelInfo.mounted === 'number' ? panelInfo.mounted : 0;
  // 服务端接缝的装载结果（钩子是开机时读的，改完启用状态要重载才变；这里只如实显示此刻）。
  const hookRows = active && Array.isArray(active.serverHooks) ? active.serverHooks : [];
  const hooksText = hookRows.length
    ? hookRows.map(function (h) {
      return h.installed === true
        ? h.pack + '=' + ((h.intercepts || []).join('/') || 'none')
        : h.pack + '(' + (h.reason || '?') + ')';
    }).join(' ')
    : '';
  // 装载期点名「这包装不上的面板」（槽不在闭枚举 / 不带 .js 模块 / 模块不在包里）。与钩子同一档：
  // 静默丢掉一个声明 == 作者以为装了、设备上什么也没发生。这里如实报数。
  const refusedRows = active && Array.isArray(active.panelRefused) ? active.panelRefused : [];
  const refusedText = refusedRows.length
    ? ' · 面板未生效 ' + refusedRows.map(function (r) { return r.pack + '/' + r.id; }).join(' ')
    : '';
  const activeText = !active
    ? '本页还没读到装载器（重载页面后应用）'
    : (activePacks.length
      ? activePacks.length + ' 个包已生效'
        + (active.themeApplied ? '（含主题）' : '')
        + (active.dataKinds.length ? ' · 数据 ' + active.dataKinds.join('/') : '')
        + (declaredPanels ? ' · 面板 ' + mountedPanels + '/' + declaredPanels : '')
        + (refusedText ? refusedText : '')
        + (hooksText ? ' · 服务端钩子 ' + hooksText : '')
      : '当前没有启用的包');
  const localOnly = html`<div class="set-list">
    ${layerHead('mod 管理器', 'MANAGER')}
    <p class="set-hint set-hint--tight">mod 管理器只在本机服务器（127.0.0.1）上可用：下载、安装与启用都发生在
      手机上，面板也只跟本机说话。当前这页不是本机服务器，所以这里不发任何请求。</p>
  </div>`;

  return html`<${Modal} open=${true} onClose=${onClose} title="mod 管理器" micro="MODS"
    width="min(94vw,44rem)"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    ${!local ? localOnly : html`<div class="set-list">
      ${layerHead('mod 管理器', 'MANAGER')}
      ${actRow('总开关', 'ENABLE', html`
        ${applyBtn(feature ? '关闭' : '开启', function () { run('feature', call(API.feature, { on: !feature })); }, busy !== '')}
        <span style="align-self:center;opacity:.85">${feature ? '已开启（默认）' : '已关闭'}</span>`)}
      <!-- 业主 2026-10-17：「mod 界面里加上反馈群号 293032860，去掉 mod 网址，点击群号可复制
           （加上框）」。站点 URL 只服务于抓取（sp-mods.mjs 打的是本机 Node），摆到面板上既不能点、
           也没有用处；反馈群号反过来是给人看的 —— 做成一颗可点的框，点一下复制到剪贴板。 -->
      ${infoRow('反馈群', 'QUN', html`<button type="button" class="sp-mod-qun"
        title="点击复制群号 ${QUN_NO}"
        onClick=${function () { copyQun(setNote); }}>${QUN_NO}</button>`)}
      ${infoRow('包目录', 'DIR', inst.dir || '—')}
      ${infoRow('已装', 'INSTALLED', String((inst.mods || []).length) + ' 个')}
      ${infoRow('本页生效', 'ACTIVE', activeText)}
      <!-- 业主 2026-10-15：「mod 界面里加上热加载选项」—— 常驻一行（原来那颗按钮只在
           装/卸/启停之后才出现一次，错过就没了）。装载发生在**页面加载时**（modsLoader.js
           读 /sp/mods/loader 一次），所以改完启用状态必须重载页面才生效 —— 这颗就是那个重载。
           只 reload 当前页面：不重启 host、不动服务端钩子（那要重启服务/重开 APK，上面已写明）。 -->
      ${actRow('热加载', 'RELOAD', html`
        <span style="align-self:center;opacity:.85">重载本页，让启用/停用的包立即生效</span>
        ${applyBtn('热加载', function () {
          try { if (globalThis.window && globalThis.window.location && globalThis.window.location.reload) globalThis.window.location.reload(); } catch (e) { /* ignore */ }
        }, false)}`)}
      ${reloadHint ? actRow('需要重载', 'RELOAD', html`
        <span style="align-self:center;opacity:.9">${reloadHint}</span>
        ${applyBtn('立即重载', function () {
          try { if (globalThis.window && globalThis.window.location && globalThis.window.location.reload) globalThis.window.location.reload(); } catch (e) { /* ignore */ }
        }, false)}`) : null}
    </div>
    <!-- 插件工作台（2026-10-18）：upstream /studio 的逻辑，画在本面板自己的 kit 样式里。
         只读 = 没有工作台密钥（native 只在回环 origin 交出），写入按钮置灰并写明原因。 -->
    <div class="set-list" style="margin-top:.04rem">
      ${layerHead('插件工作台', 'STUDIO')}
      ${!studio.loaded ? html`<p class="set-hint set-hint--tight">读取中…</p>` : null}
      ${studio.loaded && !studio.ok ? html`<p class="set-hint set-hint--tight">这个版本的服务器没有插件工作台（/studio/api/info 无应答：${studio.err}）。</p>` : null}
      ${studio.ok ? html`
        ${infoRow('状态', 'STATUS', (studio.info && studio.info.app ? studio.info.app : '未知版本')
          + ' · ' + (studio.info && studio.info.watching ? '热重载已开' : '热重载未开')
          + ' · ' + studioPlugins.length + ' 个插件' + (skey ? '' : ' · 只读'))}
        ${!skey ? html`<p class="set-hint set-hint--tight">只能查看：新建 / 导入 / 打包 / 移除要工作台密钥
          （服务启动时写在 plugins/.studio-key，只有本机回环页面读得到）。</p>` : null}
        ${actRow('新建插件', 'NEW', html`
          <input class="sp-mod-input" placeholder="插件名" value=${nsName}
            onInput=${function (e) { setNsName(e && e.currentTarget ? e.currentTarget.value : ''); }} />
          <select class="sp-mod-input" value=${nsTpl}
            onChange=${function (e) { setNsTpl(e && e.currentTarget ? e.currentTarget.value : ''); }}>
            <option value="">选模板…</option>
            ${templates.map(function (t) {
              return html`<option key=${t.id} value=${t.id}>${t.id}${t.class ? ' · ' + t.class : ''}</option>`;
            })}
          </select>
          <input class="sp-mod-input" placeholder="目标（可留空，如 char_102_texas）" value=${nsTarget}
            onInput=${function (e) { setNsTarget(e && e.currentTarget ? e.currentTarget.value : ''); }} />
          ${applyBtn(studioBusy ? '处理中…' : '新建', function () { createStudioPlugin(skey); }, studioBusy || !skey)}
        `)}
        ${actRow('从 Forge 包导入', 'IMPORT', html`
          <input class="sp-mod-input" type="file" accept=".zip,application/zip" disabled=${studioBusy || !skey}
            onChange=${function (e) {
              const input = e && e.currentTarget ? e.currentTarget : null;
              const file = input && input.files ? input.files[0] : null;
              importStudioForge(file, skey);
              if (input) input.value = '';
            }} />
          <span style="align-self:center;opacity:.75">选一个 Forge 包 zip；导入后 plugins/&lt;id&gt;/ 即出现</span>
        `)}
        <p class="set-hint set-hint--tight" style="opacity:.8">参考工作台的第三个入口「从目录安装」在这里就是下面的
          「可下载的 mod」（站点目录 → 安装）；已经在本机磁盘上的插件目录，直接放进 <code>plugins/&lt;id&gt;/</code>
          即可，服务器会自己捡起来（热重载）。</p>
        ${studioPlugins.length ? html`<div class="sp-mods-grid">${studioPlugins.map(function (p) {
          return studioCard(p, studioBusy,
            function () { packStudioPlugin(p.id, skey); },
            function () { removeStudioPlugin(p.id, skey); });
        })}</div>` : html`<p class="set-hint set-hint--tight">plugins/ 里还没有插件：上面「新建插件」起一个，或导入 Forge 包。</p>`}
        <p class="set-hint set-hint--tight" style="opacity:.7">工作台的改动是**热**的：插件列表与事件由服务器自己刷新；
          页面里的外观/玩法要在**重载本页**后生效（同上面的热加载）。深编辑（素材槽 / 预览 / DSL）点插件名可去
          <code>/studio/</code> 页面 —— 它和本面板写的是同一个 plugins/ 目录。</p>
      ` : null}
    </div>
    <div class="set-list" style="margin-top:.04rem">
      ${layerHead('可下载的 mod', 'CATALOG')}
      <!-- 分类筛选：全部 + 站点给的每个功能分类（带条数）。分类清单来自站点，站点加分类这里自动多一格。 -->
      ${cat.loaded && funcs.length ? html`<div class="sp-mods-chips">
        <button type="button" class=${'sp-mod-chip' + (funcPick === '' ? ' is-on' : '')}
          onClick=${function () { setFuncPick(''); }}>全部<span class="sp-mod-chip__n">${mods.length}</span></button>
        ${funcs.map(function (f) {
          return html`<button key=${f.kind} type="button" class=${'sp-mod-chip' + (funcPick === f.kind ? ' is-on' : '')}
            onClick=${function () { setFuncPick(funcPick === f.kind ? '' : f.kind); }}>${f.title}<span class="sp-mod-chip__n">${f.count}</span></button>`;
        })}
      </div>` : null}
      ${!cat.loaded ? html`<p class="set-hint set-hint--tight">载入中…</p>` : null}
      ${cat.loaded && mods.length === 0 ? html`<p class="set-hint set-hint--tight">站点上还没有通过审核的包。</p>` : null}
      ${cat.loaded && mods.length > 0 && shown.length === 0 ? html`<p class="set-hint set-hint--tight">这个分类下暂时没有包。</p>` : null}
      ${shown.length ? html`<div class="sp-mods-grid">${shown.map(function (m) {
        return modCard(
          m,
          busy !== '',
          function () {
            const what = m.installed ? '已更新' : '已安装并启用';
            run(m.id, call(API.install, { id: m.id }), what + ' —— ' + applyHint(m));
          },
          function () { run(m.id, call(API.state, { id: m.id, enabled: !m.enabled }), '启用状态已改 —— ' + applyHint(m)); },
          function () { run(m.id, call(API.uninstall, { id: m.id }), '已卸载 —— ' + applyHint(m)); },
          !!openNotes[m.id],
          function () { toggleNote(m.id); }
        );
      })}</div>` : null}
      ${note ? html`<p class="set-hint set-hint--tight">${note}</p>` : null}
      <p class="set-hint set-hint--tight" style="opacity:.7">装上即启用（Forge 的默认加载方式）。生效在**下次加载**：
        数据层（content / overrides）由本机装载器并进 /data/*.json，包内素材走 /sp/mods/asset/&lt;包&gt;/…；
        主题（client.theme）在页面加载时注入。<br />
        <strong>生效边界按层不同</strong>：A 层随热更树下一轮生效；C 层（客户端面板）已能真挂载，改启用状态要重载页面；
        B 层（服务端 preDispatch 钩子）在 host 启动时装载，要重启服务。<code>kits</code>（战斗件）注册表在上游是冻结的，
        <strong>不动上游就跑不了</strong>，面板照实标记 —— 存量包装不上不影响管理器本身的热更。<br />
        <strong>更新怎么判断</strong>：站点没有版本号字段，所以「站点有新版」按上传时间（或 zip 大小变化）比对已装记录。
        更新走的是同一条覆盖安装 —— 旧目录整个换掉、新包原子搬入，所以**旧版本的文件不会残留**。
        同一个 pack id 在站点上有两条时（站侧改名重投 / 旧版被取代），两条只能装一条，装哪条都会覆盖另一条，
        请先看条目备注再选。</p>
    </div>`}
  <//>`;
}

// ---- registration (dynamic import so this file never hard-fails on a missing shell module) -------
async function registerSelf() {
  const specs = ['../../js/ui/shellPanels.js', './shellPanels.js'];
  for (let i = 0; i < specs.length; i++) {
    try {
      const m = await import(specs[i]);
      if (m && typeof m.registerPanel === 'function') { m.registerPanel('mods', ModsPanel); return true; }
    } catch (e) { /* this channel is absent on this page: try the next */ }
  }
  return false;
}

async function init() {
  await loadDeps();
  await registerSelf();
}

// Synchronous marker: shell-bridge.js checks it so a re-run never injects this module twice.
try { if (typeof globalThis.window !== 'undefined') globalThis.window.__SP_MODS_PANEL = true; } catch (e) { /* no window (tests) */ }

/** Dependency-resolution signal (tests await it before reading the registry). */
export const depsReady = init();
export function whenDepsReady() { return depsReady; }
