/* global window, location */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here

// js/ui/updatePanel.js -- the hot-update interface (owner 2026-10-11: "checking for updates currently
// pops up TWO interfaces -- keep only the customizable-style hot-update interface"). This panel IS
// that one interface: the native side (MainActivity.checkUpdateQuiet) pushes events to
// window.__SP_UPDATE.onEvent, and this module draws them with the overlay's own kit (the same Modal
// frame + progress bar the preload block uses), so the whole check/install flow has ONE, hot-updatable
// look -- no GameDialog stacks on top of it any more.
//
// WHY the native side needs a claim: an old content tree ships no update panel, so the native dialogs
// must keep working there. On load this module calls window.shell.claimUpdateUi() (MainActivity
// flips updateUiOnPage) -- from that moment the native GameDialogs stand down and every update event
// comes here instead. Without the bridge (an APK older than vc2019) the claim is a no-op and the
// panel says so rather than pretending to own the flow.
//
// EVENTS (MainActivity.updateJson): {k:'checking'} | {k:'latest',tag,apk} |
// {k:'needApk',minApk,current} | {k:'progress',stage,bytes,total,tag} | {k:'done',tag,apk,auto} |
// {k:'failed',msg}. Unknown kinds are ignored (a newer native build may add some); a malformed
// payload never throws.
//
// Contract: ESM + htm (no build step), no third-party dependency beyond the shell's own vendor
// modules, degrades to shims (never throws) when a dependency is absent, idempotent.

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

async function loadDeps() {
  let kit = null;
  try { kit = await import('./overlayKit.js'); } catch (e) { /* keep the shims */ }
  const g = (typeof window !== 'undefined' && window.__SP_UI_KIT) ? window.__SP_UI_KIT : null;
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

function shell() {
  try { return (typeof window !== 'undefined' && window.shell) ? window.shell : null; } catch (e) { return null; }
}

function mb(bytes) {
  const n = typeof bytes === 'number' && isFinite(bytes) ? bytes : 0;
  return (n / 1048576).toFixed(1) + ' MB';
}

const IDLE = { k: 'idle' };

/** Human wording for one event (the panel only formats what the native side reports). */
function headText(ev) {
  const k = (ev && ev.k) || 'idle';
  if (k === 'checking') return '正在检查更新…';
  if (k === 'progress') return ev.stage ? String(ev.stage) : '正在下载更新…';
  if (k === 'latest') return '内容已是最新';
  if (k === 'needApk') return '需要新版应用';
  if (k === 'done') return '内容已更新';
  if (k === 'failed') return '检查/更新失败';
  return '尚未检查';
}

function pctOf(ev) {
  const total = ev && typeof ev.total === 'number' && isFinite(ev.total) ? ev.total : 0;
  const bytes = ev && typeof ev.bytes === 'number' && isFinite(ev.bytes) ? ev.bytes : 0;
  if (total <= 0) return -1; // indeterminate: the shell has not reported a Content-Length yet
  return Math.max(0, Math.min(100, Math.floor(bytes * 100 / total)));
}

const HEAD_STYLE = 'border-top:1px solid #1e2823;margin-top:.12rem;padding-top:.14rem';

/** 本面板自己的样式表（2026-10-20 业主「更新检查更新页的样式」）。
 *  只作用在 .sp-update 作用域里 —— 不碰 kit 的 .set-row/.set-apply（别的面板也在用），
 *  也不复用 .sp-preload 的 id 作用域（那是预载面板的）。放大口径与主界面/预载面板一致：
 *  行高、字号整体上抬，进度条加粗，操作按钮 44px 触摸下限。 */
const UPDATE_STYLE_ID = 'sp-update-panel-style';
function updateStyleCss() {
  return [
    '.sp-update .set-row{min-height:max(.52rem,44px);padding:.06rem 0;font-size:.2rem;line-height:1.55}',
    '.sp-update .set-row__label{font-size:.2rem;color:#cfe6dd}',
    '.sp-update .set-row__val{font-size:.22rem}',
    '.sp-update .set-list{display:flex;flex-direction:column;gap:.1rem}',
    // 状态行：文字放大 + 进度条加粗（6px → 10px），百分比可读
    '.sp-update .set-row [style*="height:6px"]{height:10px;border-radius:5px}',
    // 操作按钮：44px 触摸下限 + 字号（kit 的 .set-apply 是 .16rem / .4rem）
    '.sp-update .set-apply{min-height:max(.52rem,44px);font-size:.19rem;padding:.06rem .18rem}',
    '.sp-update .set-hint{font-size:.18rem;line-height:1.6}',
  ].join('');
}
/** One-shot injector (idempotent on #sp-update-panel-style). No DOM / no head -> silent no-op. */
function injectUpdateStyles() {
  try {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
    if (typeof document.getElementById === 'function' && document.getElementById(UPDATE_STYLE_ID)) return true;
    const el = document.createElement('style');
    el.setAttribute('id', UPDATE_STYLE_ID);
    el.textContent = updateStyleCss();
    const head = document.head || document.documentElement;
    if (!head || typeof head.appendChild !== 'function') return false;
    head.appendChild(el);
    return true;
  } catch (e) { return false; }
}

function layerHead(title, micro) {
  return html`<div class="set-row" style=${HEAD_STYLE}>
    <span class="set-row__label" style="color:#4ed8af">${title}<${MicroLabel}>${micro}<//></span>
  </div>`;
}

function stateRow(stateText, pct) {
  return html`<div class="set-row">
    <span class="set-row__label">状态<${MicroLabel}>STATE<//></span>
    <div style="grid-column:2 / 4;min-width:0;display:flex;align-items:center;gap:.1rem">
      <span style="min-width:0;opacity:.92;overflow-wrap:anywhere">${stateText}</span>
      <div style="flex:1;height:6px;background:rgba(255,255,255,0.12);border-radius:3px;overflow:hidden">
        <div style=${'height:6px;width:' + (pct < 0 ? 30 : pct) + '%;background:#4ED8AF'
          + (pct < 0 ? ';opacity:.55' : '')}></div>
      </div>
      <span class="set-row__val" style="width:auto;text-align:right">${pct < 0 ? '—' : pct + '%'}</span>
    </div>
  </div>`;
}

// ---- the panel ---------------------------------------------------------------------------------
/** props.onClose: close the panel (the shell host passes it). Opening it starts ONE check
 *  (window.shell.checkUpdateQuiet) and renders every event the native side pushes afterwards. */
export function UpdatePanel(props) {
  const onClose = props && props.onClose;
  const evState = useState(IDLE);
  const ev = evState[0];
  const setEv = evState[1];
  const noteState = useState('');
  const note = noteState[0];
  const setNote = noteState[1];
  const native = !!(shell() && typeof shell().checkUpdateQuiet === 'function');

  function runCheck() {
    const sh = shell();
    if (!sh || typeof sh.checkUpdateQuiet !== 'function') {
      setNote('当前版本不支持页面内检查更新（旧 APK 仍用原生弹窗）');
      return;
    }
    setEv({ k: 'checking' });
    try { sh.checkUpdateQuiet(); } catch (e) { setEv({ k: 'failed', msg: '检查失败' }); }
  }

  // One check per open. The subscription is registered FIRST so the events the native side pushes
  // right after the call cannot be missed.
  useEffect(function () {
    const off = subscribe(function (e) { setEv(e); });
    runCheck();
    return function () { try { off(); } catch (e) { /* ignore */ } };
  }, []);

  const pct = pctOf(ev);
  const k = (ev && ev.k) || 'idle';

  return html`<${Modal} open=${true} onClose=${onClose} title="检查更新" micro="UPDATE"
    width="min(88vw,40rem)"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>关闭<//>`}>
    <div class="set-list sp-update">
      ${layerHead('热更新', 'HOT UPDATE')}
      ${stateRow(headText(ev), pct)}
      ${k === 'progress' && typeof ev.total === 'number' && ev.total > 0
        ? html`<div class="set-row"><span class="set-row__label">进度<${MicroLabel}>PROGRESS<//></span>
            <span style="grid-column:2 / 4;min-width:0;opacity:.92">${mb(ev.bytes)} / ${mb(ev.total)}</span></div>`
        : null}
      ${k === 'latest' ? html`<div class="set-row"><span class="set-row__label">当前<${MicroLabel}>VERSION<//></span>
        <span style="grid-column:2 / 4;min-width:0;opacity:.92;overflow-wrap:anywhere">${ev.tag || ''}${ev.apk ? ' · 应用 v' + ev.apk : ''}</span></div>` : null}
      ${k === 'needApk' ? html`<div class="set-row"><span class="set-row__label">版本要求<${MicroLabel}>MIN APK<//></span>
        <span style="grid-column:2 / 4;min-width:0;opacity:.92">需要应用版本 ${ev.minApk}，当前 ${ev.current}</span></div>` : null}
      ${k === 'done' ? html`<div class="set-row"><span class="set-row__label">已更新到<${MicroLabel}>DONE<//></span>
        <span style="grid-column:2 / 4;min-width:0;opacity:.92;overflow-wrap:anywhere">${ev.tag || ''}${ev.apk ? ' · 应用 v' + ev.apk : ''}</span></div>` : null}
      ${k === 'failed' && ev.msg ? html`<div class="set-row"><span class="set-row__label">原因<${MicroLabel}>ERROR<//></span>
        <span style="grid-column:2 / 4;min-width:0;opacity:.92;overflow-wrap:anywhere">${ev.msg}</span></div>` : null}

      <div class="set-row">
        <span class="set-row__label">操作<${MicroLabel}>ACTION<//></span>
        <div style="grid-column:2 / 4;min-width:0;display:flex;flex-wrap:wrap;gap:.08rem">
          <button type="button" class="set-apply" disabled=${k === 'checking' || k === 'progress'} onClick=${runCheck}>重新检查</button>
          ${k === 'done' ? html`<button type="button" class="set-apply" onClick=${function () { try { location.reload(); } catch (e) { /* ignore */ } }}>立即重载</button>` : null}
          ${(k === 'done' && ev.apk) || k === 'needApk'
            ? html`<button type="button" class="set-apply" onClick=${function () {
                const sh = shell();
                if (sh && typeof sh.openApkDownload === 'function') { try { sh.openApkDownload(); return; } catch (e) { /* fall through */ } }
                setNote('请在下载站安装最新 APK');
              }}>前往下载</button>`
            : null}
        </div>
      </div>
      ${k === 'done' ? html`<p class="set-hint set-hint--tight" style="margin:0">已下载并切换完成；「立即重载」让新内容生效（对局中可稍后，下次启动也会生效）。</p>` : null}
      ${!native ? html`<p class="set-hint set-hint--tight" style="margin:0">当前版本不支持页面内检查更新；请用壳菜单的「检查更新」（原生弹窗）。</p>` : null}
      ${note ? html`<p class="set-hint set-hint--tight">${note}</p>` : null}
    </div>
  <//>`;
}

// ---- the event sink + registration --------------------------------------------------------------
/** window.__SP_UPDATE: the native side calls onEvent(<json>) on the MAIN thread (it is an
 *  evaluateJavascript payload), so a plain listener list is enough -- no async ordering to worry
 *  about. The panel subscribes on mount; with no subscriber the events are dropped (the native side
 *  only pushes them once claimUpdateUi() was called, i.e. when this module is loaded). */
const listeners = new Set();

function emitEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  for (const fn of Array.from(listeners)) {
    try { fn(ev); } catch (e) { /* one bad listener must not stop the rest */ }
  }
}

try {
  if (typeof window !== 'undefined' && !window.__SP_UPDATE) {
    window.__SP_UPDATE = {
      ready: true,
      onEvent: emitEvent,
      /** subscribe; returns an unsubscribe function. */
      subscribe: function (fn) {
        if (typeof fn !== 'function') return function () {};
        listeners.add(fn);
        return function () { listeners.delete(fn); };
      },
    };
  }
} catch (e) { /* no window (tests) */ }

/** The panel subscribes through the global when it exists (tests / a page where this module was
 *  evaluated twice get the SAME sink). */
function subscribe(fn) {
  try {
    if (window.__SP_UPDATE && typeof window.__SP_UPDATE.subscribe === 'function') return window.__SP_UPDATE.subscribe(fn);
  } catch (e) { /* ignore */ }
  return function () {};
}

async function registerSelf() {
  const specs = ['../../js/ui/shellPanels.js', './shellPanels.js'];
  for (let i = 0; i < specs.length; i++) {
    try {
      const m = await import(specs[i]);
      if (m && typeof m.registerPanel === 'function') { m.registerPanel('update', UpdatePanel); return true; }
    } catch (e) { /* this channel is absent on this page: try the next */ }
  }
  // 2026-10-20 审计：注册失败原来是彻底的静默 —— openPanel('update') 打不开、原生兜底又被
  // openPanel 的恒 true 吞掉，业主看到的就是「点了检查更新完全没反应」。这里留一行可诊断痕迹
  // （页面 console），并把「本模块没能接管更新界面」这件事如实告诉调用方。
  try {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[update] panel host unreachable on this page — the update UI cannot be drawn here');
    }
  } catch (e) { /* no console */ }
  try { window.__SP_UPDATE_PANEL_UNMOUNTED = true; } catch (e) { /* no window */ }
  return false;
}

/** Claim the native update UI (the GameDialogs stand down) + register the panel. Both are
 *  best-effort: an old APK has no claimUpdateUi, and a page without the panel host has no registry. */
async function init() {
  await loadDeps();
  injectUpdateStyles(); // 装载即注入：面板第一次打开时样式已就位（不闪一下裸样式）
  try {
    const sh = shell();
    if (sh && typeof sh.claimUpdateUi === 'function') sh.claimUpdateUi();
  } catch (e) { /* old APK: the native dialogs stay */ }
  await registerSelf();
}

// Synchronous marker: shell-bridge.js checks it so a re-run never injects this module twice.
try { if (typeof window !== 'undefined') window.__SP_UPDATE_PANEL = true; } catch (e) { /* no window (tests) */ }

export const depsReady = init();
export function whenDepsReady() { return depsReady; }
