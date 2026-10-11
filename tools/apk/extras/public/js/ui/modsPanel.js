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

/** One catalogue entry: its own row, so the four 快捷入口 buttons in the preload panel stay untouched. */
function modRow(m, busy, onInstall, onToggle, onUninstall) {
  const meta = [mb(m.size), dayOf(m.uploadedAt)].filter(Boolean).join(' · ');
  const buttons = [];
  if (!m.installed) {
    buttons.push(applyBtn(busy ? '安装中…' : '安装', onInstall, busy));
  } else {
    buttons.push(applyBtn(m.enabled ? '停用' : '启用', onToggle, busy));
    buttons.push(applyBtn('卸载', onUninstall, busy));
  }
  return html`<div class="set-row">
    <span class="set-row__label">${m.name || m.id}<${MicroLabel}>${m.id}<//></span>
    <div style="grid-column:2 / 4;min-width:0;display:flex;flex-wrap:wrap;gap:.08rem;align-items:center">
      ${m.flagged ? html`<span class="badge warn" style="color:#e0b050;border:1px solid #e0b050;font-size:11px;padding:1px 6px;border-radius:99px">含疑似官方素材</span>` : null}
      <span style="opacity:.75;font-size:.92em">${meta}${m.installed ? (m.enabled ? ' · 已启用' : ' · 已装未启用') : ''}</span>
      ${buttons}
    </div>
    ${m.note ? html`<span style="grid-column:2 / 4;min-width:0;opacity:.8;font-size:.92em;overflow-wrap:anywhere">${m.note}</span>` : null}
  </div>`;
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

  function refresh() {
    return Promise.all([call(API.catalog), call(API.installed)]).then(([c, i]) => {
      if (c && typeof c === 'object') {
        setCat({
          mods: Array.isArray(c.mods) ? c.mods : [],
          errors: Array.isArray(c.errors) ? c.errors : [],
          site: typeof c.site === 'string' ? c.site : '',
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
    refresh();
  }, []);

  function run(label, promise) {
    setBusy(label);
    return promise.then((r) => {
      setBusy('');
      const detail = (r && r.entry) || ((r && r.fields && r.fields.length) ? r.fields.join(', ') : '');
      if (!r || r.ok !== true) setNote(reasonText(r && r.error, detail));
      else setNote('');
      return refresh();
    }, () => {
      setBusy('');
      setNote(reasonText('INTERNAL', ''));
    });
  }

  const feature = cat.feature === true;
  const mods = cat.mods || [];

  return html`<${Modal} open=${true} onClose=${onClose} title="mod 管理器" micro="MODS"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      ${layerHead('mod 管理器', 'MANAGER')}
      ${actRow('总开关', 'ENABLE', html`
        ${applyBtn(feature ? '关闭' : '开启', function () { run('feature', call(API.feature, { on: !feature })); }, busy !== '')}
        <span style="align-self:center;opacity:.85">${feature ? '已开启' : '默认关闭'}</span>`)}
      ${infoRow('站点', 'SITE', cat.site || '—')}
      ${infoRow('包目录', 'DIR', inst.dir || '—')}
      ${infoRow('已装', 'INSTALLED', String((inst.mods || []).length) + ' 个')}
    </div>
    <div class="set-list" style="margin-top:.04rem">
      ${layerHead('可下载的 mod', 'CATALOG')}
      ${!cat.loaded ? html`<p class="set-hint set-hint--tight">载入中…</p>` : null}
      ${cat.loaded && mods.length === 0 ? html`<p class="set-hint set-hint--tight">站点上还没有通过审核的包。</p>` : null}
      ${mods.map(function (m) {
        return modRow(
          m,
          busy !== '',
          function () { run(m.id, call(API.install, { id: m.id })); },
          function () { run(m.id, call(API.state, { id: m.id, enabled: !m.enabled })); },
          function () { run(m.id, call(API.uninstall, { id: m.id })); }
        );
      })}
      ${note ? html`<p class="set-hint set-hint--tight">${note}</p>` : null}
      <p class="set-hint set-hint--tight" style="opacity:.7">包装进来后默认不启用；本版只做管理（下载/安装/启用/卸载），把包内容并进对局由后续的装载器负责。</p>
    </div>
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
