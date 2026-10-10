/* global window */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here

// js/ui/preloadPanel.js — the preload center's PANEL, as a Preact component (owner direction
// 2026-10-09/10: "the preload panel moves to Preact, laid out in layers"; 2026-10-10: "the floating
// panel's first-level buttons are exactly 公开大厅 / 提交房间 / 外观设置 / 检查更新" and "drop the
// load-rate lines -- the panel shows numbers only, with the progress bar inside it"). The DATA/state
// stays in preload-center.js (window.__SP_PRELOAD); this module only draws. It registers itself as
// kind 'preload' into ui/shellPanels.js' add-on registry -- the same dynamic-import + registerPanel
// pattern lobby.js uses (lobby.js:1474 imports shellPanels.js, lobby.js:2592 calls
// registerPanel('lobby', LobbyPanel)). The panel host then renders it on openPanel('preload')
// (shellPanels.js:1400 ShellPanelHost -> panelRegistry).
//
// LOOK: identical to the lobby panel -- the overlay's OWN Modal frame + .set-list/.set-row/.set-row__label
// (MicroLabel) + .set-apply buttons, from ui/overlayKit.js. Nothing here re-implements a style, and
// nothing borrows the PAGE's design system: the overlay carries its own kit + stylesheet (scoped
// .sp-ui) so it renders the same on the local tree page and on any third-party server page.
//
// LAYERS (owner: "layered design", now TWO blocks instead of three): each block is its own
// .set-list separated by a border-top header row -- (1) 预载进度: the value lines (状态 / 本地可用 /
// 回源缓存 / 待预载) + the progress bar, (2) 快捷入口: ONE row with the four first-level buttons
// 公开大厅 / 提交房间 / 外观设置 / 检查更新 (they fit one row at the panel's width; flex-wrap stays
// on as the graceful fallback). The 公开房间 / 加入房间 / 自动匹配 buttons are gone -- they only
// duplicated what 公开大厅 opens; the capability itself stays in the lobby panel. The load-rate
// lines (下载速度 / 解压速度 / 预载速度 / 预计剩余) are GONE from the panel display: the rate/pack
// numbers still exist in preload-center.js' state API (rates/pack) for other readers -- only the
// DISPLAY was removed.
//
// WHY './overlayKit.js' (a sibling of THIS file, not the page's js/ui/components.js): shell-bridge.js
// injects this file as a MODULE at /__sp/ui/preloadPanel.js, so './overlayKit.js' resolves to
// /__sp/ui/overlayKit.js -- always served from this machine (never the page's origin) and the same
// module instance the lobby panel and the panel host use. The kit registers window.__SP_UI_KIT so all
// overlay modules share ONE preact copy. No page module is imported; only the game's own store.js/net.js
// stay page-origin (in lobby.js), because the overlay's hooks attach to the page's game instance.
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
/** html shim: a plain marked object, never throws. Only reachable without htm+preact at all. */
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
/** toast shim: console-only, never throws. Only reachable without the real kit. */
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
 *  uses (the kit registers window.__SP_UI_KIT; the first loader wins, later ones reuse it). No page
 *  module is imported: the page's js/ui/components.js may be a different version, or absent. */
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
    if (typeof kit.toast === 'function') toast = kit.toast; // self-owned feedback (no page ToastHost)
    if (typeof kit.useState === 'function') useState = kit.useState;
    if (typeof kit.useEffect === 'function') useEffect = kit.useEffect;
  }
}

// ---- data formatting (the panel only formats what the state API hands it; nothing is guessed) ----
function num(v) {
  const n = typeof v === 'number' && isFinite(v) ? v : 0;
  return n < 0 ? 0 : n;
}

function mb(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }

function headText(phase, failed) {
  let h = phase === 'scanning' ? '正在解析资源依赖清单…'
    : phase === 'running' ? '正在后台预载…'
    : phase === 'paused' ? '预载已暂停'
    : phase === 'done' ? '资源预载完成'
    : phase === 'failed' ? '资源预载未完成' : '资源预载';
  if (failed) h += ' (' + failed + ' 失败)';
  return h;
}

// ---- data sources -----------------------------------------------------------------------------
/** Progress/state API of preload-center.js (null before it loads: the panel still renders). */
function readState() {
  try {
    const p = window.__SP_PRELOAD;
    if (p && typeof p.state === 'function') return p.state();
  } catch (e) { /* no module */ }
  return null;
}

/** The Android art-cache reading (回源缓存 bytes). Absent -> null and the panel falls back to the
 *  state API's own byte figure (browser cache on the web), never a fabricated number. */
function readCache() {
  try {
    const sh = window.__SP_SHELL;
    if (sh && sh.artCacheBridge === true && typeof sh.artCacheStatus === 'function') {
      const o = JSON.parse(sh.artCacheStatus());
      if (o && o.ok !== false) return o;
    }
  } catch (e) { /* no bridge / bad json */ }
  return null;
}

// The four speed lines (owner ask 2026-10-09) were REMOVED from the display 2026-10-10 (owner:
// "去掉缓存载入参数"). The walk/pack rate numbers still live in preload-center.js' state API
// (rates/pack) for other readers -- this panel no longer formats or draws them anywhere.

// ---- lobby / settings / update entries (delegate; the panel is only the entry point) ------------
/** 公开大厅: the lobby panel is the only implementation (公开房间 / 加入房间 / 自动匹配 used to be
 *  three separate buttons in here, all calling the same open()). When there is no lobby module at
 *  all, the panel says so in its hint line instead of leaving a dead click. */
function lobbyOpen(setNote) {
  try {
    const lb = window.__SP_LOBBY;
    if (lb && typeof lb.open === 'function') { lb.open(); return; }
  } catch (e) { /* no lobby (plain web / old APK) */ }
  try { if (typeof setNote === 'function') setNote('当前页面不支持联机大厅'); } catch (e) { /* ignore */ }
}

/** The current room code (the game store's room.code); '' when there is no room. */
function currentRoomCode() {
  try {
    const sp = window.__SP__;
    const st = (sp && sp.store && typeof sp.store.get === 'function') ? sp.store.get() : null;
    const c = (st && st.room && st.room.code) ? String(st.room.code).toUpperCase() : '';
    return /^[A-Z0-9]{4}$/.test(c) ? c : '';
  } catch (e) { return ''; }
}

/** 提交房间: the SAME action the removed 公开到大厅 button had -- read the current room code and
 *  hand it to the lobby's togglePublic (which publishes/unpublishes the room). */
function submitRoom(setNote) {
  const code = currentRoomCode();
  if (!code) { setNote('还没有房间'); return; }
  try {
    const lb = window.__SP_LOBBY;
    const pr = (lb && typeof lb.togglePublic === 'function') ? lb.togglePublic(code) : null;
    if (pr && typeof pr.then === 'function') {
      pr.then((res) => setNote(res && res.ok ? '已提交到大厅' : '提交失败'), () => setNote('提交失败'));
    } else {
      setNote('提交失败');
    }
  } catch (e) { setNote('提交失败'); }
}

/** 检查更新: window.shell.checkUpdate() is the shell's own update entry (owner direction 2026-10-10)
 *  -- the native bridge starts the whole check/install flow and reports the result itself (toast /
 *  dialog). An APK too old for it, or the plain web, goes through shell-bridge's wrapper, which is
 *  the same native call on an APK and a cache-buster reload on a plain page. With NEITHER present
 *  the panel must not leave a dead click: it toasts + notes that this page cannot check for updates
 *  (owner: "没有就静默降级，并且要有可见反馈"). shell-bridge.js is injected into EVERY page (local
 *  and third-party server) by MainActivity.injectShellHtml, so the wrapper is present on both. */
function checkUpdate(setNote) {
  const say = function (msg) {
    try { toast(msg); } catch (e) { /* no kit (tests): the note below still carries it */ }
    try { if (typeof setNote === 'function') setNote(msg); } catch (e) { /* no state */ }
  };
  try {
    const sh = window.shell;
    if (sh && typeof sh.checkUpdate === 'function') { sh.checkUpdate(); say('已发起检查更新'); return; }
  } catch (e) { /* fall through to the shell-bridge wrapper */ }
  try {
    const s = window.__SP_SHELL;
    if (s && typeof s.checkUpdate === 'function') { s.checkUpdate(); say('已发起检查更新'); return; }
  } catch (e) { /* fall through */ }
  say('当前页面不支持检查更新');
}

/** Settings entry: the appearance panel is a shell panel of its own kind. Close this panel first --
 *  its modal sits at a higher z-index and would otherwise cover the appearance modal (the old ES5
 *  openSettings() did exactly this). */
function openAppearance(onClose) {
  try { if (typeof onClose === 'function') onClose(); } catch (e) { /* ignore */ }
  try {
    const s = window.__SP_SHELL;
    if (s && typeof s.openPanel === 'function') s.openPanel('appearance');
  } catch (e) { /* no shell panel host (plain web / old APK): silent */ }
}

// ---- live repaint (the progress bar + counters must keep moving while the panel is open) --------
function useTick() {
  const st = useState(0);
  const setTick = st[1];
  useEffect(function () {
    let alive = true;
    let raf = 0;
    let last = 0;
    function loop(stamp) {
      if (!alive) return;
      const t = typeof stamp === 'number' ? stamp : Date.now();
      if (t - last >= 1000) { last = t; setTick(function (n) { return n + 1; }); }
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        raf = window.requestAnimationFrame(loop);
      }
    }
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      raf = window.requestAnimationFrame(loop);
    }
    return function () {
      alive = false;
      if (raf && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        try { window.cancelAnimationFrame(raf); } catch (e) { /* ignore */ }
      }
    };
  }, []);
}

// ---- layer helpers (the shellPanels.js section idiom: a mint label row + the layer's rows) -------
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

function progressRow(pct) {
  return html`<div class="set-row">
    <span class="set-row__label">进度<${MicroLabel}>PROGRESS<//></span>
    <div style="grid-column:2 / 4;min-width:0;display:flex;align-items:center;gap:.1rem">
      <div style="flex:1;height:6px;background:rgba(255,255,255,0.12);border-radius:3px;overflow:hidden">
        <div style=${'height:6px;width:' + pct + '%;background:#4ED8AF'}></div>
      </div>
      <span class="set-row__val" style="width:auto;text-align:right">${pct}%</span>
    </div>
  </div>`;
}

// ---- the panel ---------------------------------------------------------------------------------
/** props.onClose: close the panel (the shell host passes it). Reads window.__SP_PRELOAD for the
 *  progress/state and the shell bridge for the cache reading. Owner 2026-10-10: NUMBERS only (状态 /
 *  本地可用 / 回源缓存 / 待预载) + the progress bar; no load-rate/ETA lines (their numbers stay in
 *  preload-center.js' state API, only this display dropped them). */
export function PreloadPanel(props) {
  const onClose = props && props.onClose;
  const noteState = useState('');
  const note = noteState[0];
  const setNote = noteState[1];
  useTick();

  const s = readState();
  const phase = (s && s.phase) || 'idle';
  const done = num(s && s.done);
  const total = num(s && s.total);
  const pending = num(s && s.pending);
  const failed = num(s && s.failed);
  const pct = total > 0 ? Math.floor(done * 100 / total) : 0;

  // Cache bytes: prefer the shell bridge reading; fall back to the state API's own figure (browser
  // cache on the web), which folds the same bridge. Absent everywhere -> 0, honestly drawn.
  const cache = readCache();
  const store = cache ? 'android' : ((s && s.store) || '');
  const bytes = cache ? num(cache.cachedBytes) : num(s && s.bytes);

  return html`<${Modal} open=${true} onClose=${onClose} title="资源预载与离线缓存中心" micro="PRELOAD"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      ${layerHead('预载进度', 'PROGRESS')}
      ${infoRow('状态', 'STATE', headText(phase, failed))}
      ${infoRow('本地可用', 'LOCAL', done + ' / ' + total)}
      ${infoRow(store === 'android' ? '回源缓存' : '浏览器缓存', 'CACHE', mb(bytes))}
      ${pending > 0 ? infoRow('待预载', 'PENDING', String(pending)) : null}
      ${progressRow(pct)}
    </div>
    <div class="set-list" style="margin-top:.04rem">
      ${layerHead('快捷入口', 'ENTRIES')}
      ${actRow('入口', 'ACTIONS', html`
        <button type="button" class="set-apply" style="white-space:nowrap" onClick=${function () { lobbyOpen(setNote); }}>公开大厅</button>
        <button type="button" class="set-apply" style="white-space:nowrap" onClick=${function () { submitRoom(setNote); }}>提交房间</button>
        <button type="button" class="set-apply" style="white-space:nowrap" onClick=${function () { openAppearance(onClose); }}>外观设置</button>
        <button type="button" class="set-apply" style="white-space:nowrap" onClick=${function () { checkUpdate(setNote); }}>检查更新</button>`)}
      ${note ? html`<p class="set-hint set-hint--tight">${note}</p>` : null}
    </div>
  <//>`;
}

// ---- registration (dynamic import so this file never hard-fails on a missing shell module) -------
/** The panel host lives in whichever shellPanels.js instance mounted it. On a local page that is
 *  the lobby's '/js/ui/shellPanels.js' -- the URL '../../js/ui/shellPanels.js' resolves to, i.e. the
 *  SAME module instance, so registerPanel lands in the mounted registry. When that channel is absent
 *  (a server page whose own /js/ client carries no shellPanels, or a 404) the /__sp/ sibling
 *  './shellPanels.js' -- always served from this machine -- is the fallback. The FIRST module that
 *  actually exposes registerPanel wins, so no second instance is loaded on the local page. */
async function registerSelf() {
  const specs = ['../../js/ui/shellPanels.js', './shellPanels.js'];
  for (let i = 0; i < specs.length; i++) {
    try {
      const m = await import(specs[i]);
      if (m && typeof m.registerPanel === 'function') { m.registerPanel('preload', PreloadPanel); return true; }
    } catch (e) { /* this channel is absent on this page: try the next */ }
  }
  return false;
}

async function init() {
  await loadDeps();
  await registerSelf();
}

// Synchronous marker: shell-bridge.js checks it so a re-run never injects this module twice.
try { if (typeof window !== 'undefined') window.__SP_PRELOAD_PANEL = true; } catch (e) { /* no window (tests) */ }

/** Dependency-resolution signal (tests await it before reading the registry). */
export const depsReady = init();
export function whenDepsReady() { return depsReady; }
