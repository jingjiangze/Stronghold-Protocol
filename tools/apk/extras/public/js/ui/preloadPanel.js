/* global window, document */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here

// js/ui/preloadPanel.js -- the floating window's FIRST SCREEN: the FUNCTION LIST (owner direction
// 2026-10-11: "the floating window's art N/M becomes a FUNCTION"; "tapping the floating window's
// first screen opens the function list"; "three sections first: 本地服务 / 加入局域网 / 加入服务器
// (custom domain input, NOT synced to the server-list site)"; "then 服务器列表 / mod 管理器 /
// 房间列表 / 外观设置 / 联机偏好 (with a 默认公开房间 option) / 检查更新"; "the preload block goes at
// the very bottom, with a progress bar and ONE button to start / stop it"; "these UIs must all fit
// without scrolling"; "the panel is hot-updatable and takes ~80% of the screen"; "it opens by
// default"). The DATA/state stays in preload-center.js (window.__SP_PRELOAD); this module only draws
// and delegates. It registers itself as kind 'preload' into ui/shellPanels.js' add-on registry -- the
// same dynamic-import + registerPanel pattern lobby.js uses -- so the panel host renders it on
// openPanel('preload') (which is what preload-center.js open() and art-prefetch.js' floating button
// both call).
//
// LOOK: identical to the lobby panel -- the overlay's OWN Modal frame + .set-list/.set-row/
// .set-row__label (MicroLabel) + .set-apply buttons, from ui/overlayKit.js. Nothing here
// re-implements a style, and nothing borrows the PAGE's design system: the overlay carries its own
// kit + stylesheet (scoped .sp-ui) so it renders the same on the local tree page and on any
// third-party server page. The ONLY inline styles are the compact grids that keep the whole list
// visible without scrolling (the owner's "no scrolling" rule) and the progress bar.
//
// LAYERS (owner: "layered design"; each block is its own .set-list separated by a mint header row):
//   (1) 连接 CONNECT   -- 本地服务 (starts the local host ON DEMAND), 加入局域网 (scan + join, plus
//       the local room's 复制链接), 加入服务器 (custom domain -> setServer, deliberately NOT
//       published to the room board);
//   (2) 功能 FUNCTIONS -- five equal tiles: mod 管理器 / 房间列表 / 全局设置 / 检查更新 / 开始预载;
//       the fifth tile is a real start/stop toggle backed by window.__SP_PRELOAD.
//   (3) 资源预载 PRELOAD -- status + local/cache figures, then a full-width progress strip as the
//       final body element. The panel title is intentionally omitted; the layer labels carry the
//       hierarchy without the redundant top-level “功能 / MENU” header.
//
// WHY './overlayKit.js' (a sibling of THIS file, not the page's js/ui/components.js): shell-bridge.js
// injects this file as a MODULE at /__sp/ui/preloadPanel.js, so './overlayKit.js' resolves to
// /__sp/ui/overlayKit.js -- always served from this machine (never the page's origin) and the same
// module instance the lobby panel and the panel host use. The kit registers window.__SP_UI_KIT so all
// overlay modules share ONE preact copy. No page module is imported: the page's js/ui/components.js
// may be a different version, or absent.
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
    : phase === 'cancelled' ? '预载已停止'
    : phase === 'done' ? '资源预载完成'
    : phase === 'failed' ? '资源预载未完成' : '尚未开始预载';
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

// ---- shell plumbing (every call is guarded: an old shell degrades, it never throws) -------------
function shell() {
  try { return (typeof window !== 'undefined' && window.shell) ? window.shell : null; } catch (e) { return null; }
}

/** Opens one of the shell's own panels by kind (the panel host owns the registry). Closes this
 *  panel first: its modal sits at a higher z-index and would otherwise cover the next one. */
function openPanel(kind, onClose) {
  try { if (typeof onClose === 'function') onClose(); } catch (e) { /* ignore */ }
  try {
    const s = window.__SP_SHELL;
    if (s && typeof s.openPanel === 'function') { s.openPanel(kind); return true; }
  } catch (e) { /* no panel host (plain web / old APK) */ }
  return false;
}

/** 复制：App 剪贴板桥 window.shell.copyText → navigator.clipboard → textarea 选中兜底。 */
function copyText(text) {
  const s = String(text == null ? '' : text);
  if (!s) return Promise.resolve(false);
  const sh = shell();
  try {
    if (sh && typeof sh.copyText === 'function') { sh.copyText(s); return Promise.resolve(true); }
  } catch (e) { /* fall through to the browser API */ }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(s).then(() => true, () => fallbackCopy(s));
    }
  } catch (e) { /* fall through */ }
  return Promise.resolve(fallbackCopy(s));
}

function fallbackCopy(s) {
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ta.setSelectionRange(0, ta.value.length); } catch (e) { /* ignore */ }
    const ok = document.execCommand ? document.execCommand('copy') : false;
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) { return false; }
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

/** The device's own host addresses for a share link. The shell computes them natively (zt = a
 *  ZeroTier/VPN interface, lan = any other private IPv4, v6 = global-unicast IPv6) and the owner's
 *  rule is "prefer the VPN address (usually the virtual LAN), then the LAN address" -- so zt wins,
 *  lan is the fallback, and the v6 form is only used when neither exists. '' when the bridge is
 *  absent (an old APK / a plain web page): the panel then says so instead of copying a dead link. */
function localBase() {
  const sh = shell();
  try {
    if (sh && typeof sh.hostAddresses === 'function') {
      const o = JSON.parse(sh.hostAddresses());
      if (o && typeof o === 'object') {
        const pick = ['zt', 'lan', 'v6'].find((k) => typeof o[k] === 'string' && o[k]);
        if (pick) return String(o[pick]).replace(/\/+$/, '');
      }
    }
  } catch (e) { /* old shell / no JSON */ }
  return '';
}

/** The LAN/VPN deep link for a room on THIS device, or '' when there is no address to build it from. */
function localRoomUrl(code) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(c)) return '';
  const base = localBase();
  return base ? base + '/?room=' + c : '';
}

// ---- 本机地址（业主 2026-10-12：「显示当前局域网 IP，优先虚拟局域网其次局域网」）------------------
// hostAddresses() 的返回里 zt = 虚拟局域网（ZeroTier / EasyTier 一类 VPN 网卡），lan = 普通私有
// IPv4，v6 = 全局单播 IPv6。显示口径与「复制链接」完全一致（同一个 localBase()），玩家照着这个
// 地址填就不会填错——两者必须是同一个值，否则「提示的 IP」和「复制出去的链接」会打架。
function localAddresses() {
  const sh = shell();
  try {
    if (sh && typeof sh.hostAddresses === 'function') {
      const o = JSON.parse(sh.hostAddresses());
      if (o && typeof o === 'object') return o;
    }
  } catch (e) { /* old shell / no JSON */ }
  return null;
}

/** 提示行：本机 IP（虚拟局域网优先）与它来自哪张网卡。取不到就如实说，绝不编一个地址。 */
function lanIpLine() {
  const o = localAddresses();
  if (!o) return '本机地址需 App 版提供';
  const zt = typeof o.zt === 'string' ? o.zt.replace(/\/+$/, '') : '';
  const lan = typeof o.lan === 'string' ? o.lan.replace(/\/+$/, '') : '';
  if (zt) return '本机虚拟局域网 IP：' + zt + '（对方需在同一个虚拟局域网）';
  if (lan) return '本机局域网 IP：' + lan + '（对方需在同一 Wi-Fi / 网段）';
  const v6 = typeof o.v6 === 'string' ? o.v6.replace(/\/+$/, '') : '';
  if (v6) return '本机 IPv6 地址：' + v6;
  return '未取到本机地址：请连接 Wi-Fi 或虚拟局域网后重试';
}

/**
 * 进入线路后的预载提示（业主 2026-10-12：「进入服务器和本地服务或局域网后提示预载资源窗口」）。
 * 只**提醒**、不代跑：三条进入路径（startLocal / joinCustom / joinLan）各自调它，再由 preload
 * 中心弹它自己的面板（window.__SP_PRELOAD.open()）——提示与开启仍是两个动作，玩家可忽略。
 */
function hintPreload() {
  try {
    const p = window.__SP_PRELOAD;
    if (p && typeof p.open === 'function') { p.open(); return true; }
  } catch (e) { /* no preload center */ }
  try { if (openPanel('preload')) return true; } catch (e) { /* no panel host */ }
  return false;
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
// The compact grids that keep the whole list on screen (owner: "these UIs must fit without
// scrolling"): equal columns, a small gap, cells that truncate rather than push the grid open.
const GRID2 = 'grid-column:1 / -1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.08rem;min-width:0';
const GRID3 = 'grid-column:1 / -1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.08rem;min-width:0';
const CELL = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:.42rem';

// ---- 分区容器（业主 2026-10-12 口径：红色区 / 黄色区，整屏不滑动）--------------------------------
// 两区各是一个 .set-list，背景色区分：红区 = 三条「进入游戏」的线路（本地服务 / 加入局域网 /
// 加入服务器，服务器列表按钮收进「加入服务器」这一格）；黄区 = 四个功能按钮**一行并列**（mod 管理器 /
// 房间列表 / 全局设置 / 检查更新）。红区三格**竖排**（每格一整行），黄区四格**横排**（一行）。
// 「这个界面不可滑动」是硬口径：所有行只用 fr 与 minmax(0,1fr)，不设任何固定 px 高度，溢出靠
// ellipsis 截断而不是把网格顶开（沿用既有 GRID2/GRID3/CELL 的不滑动约定）。
const ZONE_RED = 'border:1px solid rgba(224,108,90,.55);background:linear-gradient(180deg,rgba(224,108,90,.16),rgba(224,108,90,.07));border-radius:6px';
const ZONE_YELLOW = 'border:1px solid rgba(232,184,74,.5);background:linear-gradient(180deg,rgba(232,184,74,.14),rgba(232,184,74,.05));border-radius:6px';
const ZONE_PAD = 'padding:.1rem .12rem .12rem';
// 红区一格：左侧标题竖排，右侧操作区填满剩余宽度（与 .set-row 同为 grid 的 3 列布局）。
const LANE = 'grid-column:2 / 4;min-width:0;display:flex;flex-direction:column;gap:.06rem';
const GRID5 = 'grid-column:1 / -1;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:.12rem;min-width:0';

// The panel is hosted over arbitrary server pages, so its cards own their styles and do not rely on
// that page's stylesheet. All rules are scoped to these component classes and remain hot-updatable.
const PRELOAD_STYLE_ID = 'sp-preload-panel-style';
function injectPreloadStyles() {
  try {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
    if (typeof document.getElementById === 'function' && document.getElementById(PRELOAD_STYLE_ID)) return true;
    const el = document.createElement('style');
    el.setAttribute('id', PRELOAD_STYLE_ID);
    el.textContent = [
      '.sp-ui .sp-preload-layout{display:flex;flex-direction:column;gap:.1rem;min-width:0}',
      '.sp-ui .sp-preload-action-grid{grid-column:1 / -1;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:.12rem;min-width:0}',
      '.sp-ui .sp-preload-action{box-sizing:border-box;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.07rem;min-width:0;min-height:1.02rem;width:100%;padding:.1rem .06rem;background:linear-gradient(180deg,rgba(29,38,33,.96),rgba(12,17,15,.96));border:1px solid rgba(104,128,116,.48);border-radius:.06rem;color:var(--sp-text-hi);font-family:inherit;font-size:.17rem;font-weight:700;line-height:1.25;text-align:center;white-space:normal;overflow-wrap:anywhere;cursor:pointer;transition:border-color .16s ease,background .16s ease,transform .16s ease}',
      '.sp-ui .sp-preload-action::before{content:attr(data-glyph);box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:.36rem;height:.36rem;border:1px solid rgba(78,216,175,.38);border-radius:50%;background:rgba(78,216,175,.08);color:var(--sp-mint);font-size:.2rem;font-weight:500;line-height:1}',
      '.sp-ui .sp-preload-action:not(:disabled):hover{border-color:var(--sp-mint);background:linear-gradient(180deg,rgba(41,65,55,.98),rgba(14,28,22,.98));transform:translateY(-1px)}',
      '.sp-ui .sp-preload-action:focus-visible{outline:2px solid var(--sp-mint);outline-offset:2px}',
      '.sp-ui .sp-preload-action[data-action="preload"]{border-color:rgba(78,216,175,.72);background:linear-gradient(180deg,rgba(78,216,175,.18),rgba(18,38,30,.96))}',
      '.sp-ui .sp-preload-action[data-action="preload"]::before{border-radius:.06rem;background:var(--sp-mint);color:#06150f;border-color:var(--sp-mint)}',
      '.sp-ui .sp-preload-action[data-action="preload"][data-preload-state="running"]{border-color:rgba(224,108,90,.7);background:linear-gradient(180deg,rgba(224,108,90,.16),rgba(32,20,17,.96))}',
      '.sp-ui .sp-preload-action[data-action="preload"][data-preload-state="running"]::before{border-color:var(--sp-red);background:var(--sp-red);color:#1a0b08}',
      '.sp-ui .sp-preload-state{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:.12rem;min-width:0;padding:.02rem 0}',
      '.sp-ui .sp-preload-state__text{min-width:0;color:var(--sp-text-hi);font-size:.17rem;overflow-wrap:anywhere}',
      '.sp-ui .sp-preload-state__pct{color:var(--sp-mint);font-family:var(--sp-font);font-size:.19rem;font-variant-numeric:tabular-nums}',
      '.sp-ui .sp-preload-resource-zone .set-row{min-height:.34rem}',
      '.sp-ui .sp-preload-resource-zone .set-hint{margin:0}',
      '.sp-ui .sp-preload-progress{box-sizing:border-box;width:100%;height:.14rem;overflow:hidden;border:1px solid rgba(78,216,175,.22);border-radius:999px;background:rgba(255,255,255,.09);box-shadow:inset 0 1px 2px rgba(0,0,0,.28)}',
      '.sp-ui .sp-preload-progress__fill{height:100%;border-radius:inherit;background:linear-gradient(90deg,#22a77e,#66edc1);box-shadow:0 0 .12rem rgba(78,216,175,.3);transition:width .25s ease}',
      '.sp-ui .sp-preload-function-zone .set-row__label{color:var(--sp-mint)}',
      '@media (max-width:720px){.sp-ui .sp-preload-action-grid{gap:.06rem}.sp-ui .sp-preload-action{min-height:.82rem;padding:.06rem .03rem;font-size:.14rem}.sp-ui .sp-preload-action::before{width:.28rem;height:.28rem;font-size:.16rem}.sp-ui .sp-preload-layout{gap:.07rem}}',
      '@media (prefers-reduced-motion:reduce){.sp-ui .sp-preload-action,.sp-ui .sp-preload-progress__fill{transition:none}}',
    ].join('');
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

function infoRow(label, micro, value) {
  return html`<div class="set-row">
    <span class="set-row__label">${label}<${MicroLabel}>${micro}<//></span>
    <span style="grid-column:2 / 4;min-width:0;opacity:.92;overflow-wrap:anywhere">${value}</span>
  </div>`;
}

/** Compact state read-out; the actual progress strip is kept last in the panel body. */
function stateRow(stateText, pct) {
  return html`<div class="sp-preload-state">
    <span class="sp-preload-state__text">${stateText}</span>
    <span class="sp-preload-state__pct">${pct}%</span>
  </div>`;
}

function progressBar(pct) {
  return html`<div class="sp-preload-progress" role="progressbar" aria-label="资源预载进度"
    aria-valuemin="0" aria-valuemax="100" aria-valuenow=${pct}>
    <div class="sp-preload-progress__fill" style=${'width:' + pct + '%'}></div>
  </div>`;
}

// ---- the panel ---------------------------------------------------------------------------------
/** props.onClose: close the panel (the shell host passes it). Reads window.__SP_PRELOAD for the
 *  progress/state and the shell bridge for the cache reading + the LAN addresses. Owner 2026-10-11:
 *  the panel IS the floating window's first screen -- three CONNECT sections, then the function
 *  grid, then the preload block with its single start/stop button. */
export function PreloadPanel(props) {
  injectPreloadStyles();
  const onClose = props && props.onClose;
  const noteState = useState('');
  const note = noteState[0];
  const setNote = noteState[1];
  const lanState = useState({ state: 'idle', rooms: [], note: '' });
  const lan = lanState[0];
  const setLan = lanState[1];
  const customState = useState('');
  const custom = customState[0];
  const setCustom = customState[1];
  useTick();

  const s = readState();
  const phase = (s && s.phase) || 'idle';
  const done = num(s && s.done);
  const total = num(s && s.total);
  const pending = num(s && s.pending);
  const failed = num(s && s.failed);
  const pct = total > 0 ? Math.floor(done * 100 / total) : 0;
  const running = phase === 'running' || phase === 'scanning';
  const roomCode = currentRoomCode();

  // Cache bytes: prefer the shell bridge reading; fall back to the state API's own figure (browser
  // cache on the web), which folds the same bridge. Absent everywhere -> 0, honestly drawn.
  const cache = readCache();
  const store = cache ? 'android' : ((s && s.store) || '');
  const bytes = cache ? num(cache.cachedBytes) : num(s && s.bytes);

  const sh = shell();
  const native = !!sh;
  const lanSupported = !!(sh && typeof sh.lanScan === 'function');

  // ---- LAN discovery: ONE scan per click, results pushed back by Java through __SP_LAN.onScan ----
  useEffect(function () {
    if (!lanSupported) return undefined;
    if (!window.__SP_LAN || typeof window.__SP_LAN.onScan !== 'function') return undefined;
    window.__SP_LAN.onScan(function (rooms, data) {
      let n = '';
      if (data && data.ok === false) n = '扫描失败，请稍后重试';
      else if (data && data.unreachable === true) n = '扫描没打通：可能不在同一网段，或路由器隔离了设备';
      setLan({ state: 'done', rooms: Array.isArray(rooms) ? rooms : [], note: n });
    });
    return undefined;
  }, []);

  function scanLan() {
    if (lan.state === 'scanning') return;
    const sh2 = shell();
    if (!sh2 || typeof sh2.lanScan !== 'function') { setNote('当前版本不支持局域网扫描'); return; }
    let res = null;
    try { res = sh2.lanScan('rooms', ''); } catch (e) {
      setLan({ state: 'idle', rooms: [], note: '扫描失败，请稍后重试' });
      return;
    }
    if (res == null) { setNote('需更新 APK 后生效'); return; }
    if (window.__SP_LAN && typeof window.__SP_LAN.begin === 'function') window.__SP_LAN.begin();
    setLan({ state: 'scanning', rooms: [], note: '' });
  }

  function joinLan(r) {
    if (!r) return;
    const sh2 = shell();
    if (!sh2 || typeof sh2.joinOnOrigin !== 'function') { setNote('当前版本不支持局域网加入'); return; }
    const id = 'lan:' + String(r.ip || '') + ':' + (Number(r.port) || 0);
    let ok = true;
    try { ok = sh2.joinOnOrigin(id, String(r.code || '').toUpperCase()) !== false; } catch (e) { ok = false; }
    if (ok) { onClose(); hintPreload(); return; } // 业主 2026-10-12：进入后提示预载
    setNote('加入失败：目标房间不可达');
  }

  // ---- the three CONNECT entries -----------------------------------------------------------------
  /** 本地服务: start the local host ON DEMAND and switch to it. This is the ONLY thing that starts
   *  the bundled Node runtime (owner 2026-10-11: the host must not start at boot, so it cannot race
   *  the preload / freeze the first frame). */
  function startLocal() {
    const sh2 = shell();
    if (!sh2) { setNote('当前页面不支持本地服务'); return; }
    try {
      if (typeof sh2.startLocalService === 'function') sh2.startLocalService();
      else if (typeof sh2.setServer === 'function') sh2.setServer('local');
      else { setNote('当前版本不支持本地服务'); return; }
    } catch (e) { setNote('本地服务启动失败'); return; }
    try { toast('本地服务启动中…'); } catch (e) { /* no kit */ }
    onClose();
    hintPreload(); // 业主 2026-10-12：进入后提示预载（只提醒，由玩家决定）
  }

  /** 加入服务器 (custom domain): connect straight to the address. Deliberately NOT submitted to the
   *  room board / the server-list site (owner 2026-10-11) -- this is a private, one-off connection. */
  function joinCustom() {
    let v = String(custom || '').trim();
    if (!v) { setNote('请输入服务器地址'); return; }
    if (!/^https?:\/\//.test(v)) v = 'https://' + v;
    v = v.replace(/\/+$/, '');
    const sh2 = shell();
    if (!sh2 || typeof sh2.setServer !== 'function') { setNote('当前版本不支持自定义服务器'); return; }
    try { sh2.setServer('custom:' + v); } catch (e) { setNote('连接失败：地址无效'); return; }
    try { toast('正在连接 ' + v); } catch (e) { /* no kit */ }
    onClose();
    hintPreload(); // 业主 2026-10-12：进入后提示预载
  }

  /** 复制链接: the room's LAN/VPN deep link (owner 2026-10-11: the copied link uses the current LAN
   *  address, preferring the VPN one). */
  function copyLink() {
    const url = localRoomUrl(roomCode);
    if (!url) { setNote(native ? '尚未取得本机地址，请先进入本地服务' : '当前页面不支持复制链接'); return; }
    copyText(url).then((ok) => setNote(ok ? '已复制房间链接：' + url : '复制失败，请手动复制：' + url));
  }

  /** 检查更新 (owner 2026-10-11: "checking for updates currently pops up TWO interfaces -- keep only
   *  the customizable-style hot-update interface"): the page draws the hot-update UI itself (kind
   *  'update', ui/updatePanel.js), which claims the native side (claimUpdateUi) so no GameDialog
   *  stacks on top. An APK without the quiet bridge falls back to the legacy native entry below. */
  function checkUpdate() {
    const sh2 = shell();
    if (sh2 && typeof sh2.checkUpdateQuiet === 'function' && openPanel('update', onClose)) return;
    const say = function (msg) {
      try { toast(msg); } catch (e) { /* no kit (tests): the note below still carries it */ }
      try { setNote(msg); } catch (e) { /* no state */ }
    };
    try {
      if (window.shell && typeof window.shell.checkUpdate === 'function') {
        window.shell.checkUpdate(); say('已发起检查更新'); return;
      }
    } catch (e) { /* fall through to the shell-bridge wrapper */ }
    try {
      const s2 = window.__SP_SHELL;
      if (s2 && typeof s2.checkUpdate === 'function') { s2.checkUpdate(); say('已发起检查更新'); return; }
    } catch (e) { /* fall through */ }
    say('当前页面不支持检查更新');
  }

  // ---- the preload block's ONE button ------------------------------------------------------------
  // Start = BOTH channels: the pack channel (shell.syncArt, idempotent -- installed packs are not
  // re-downloaded) and the file walk (the center delegates to art-prefetch). Stop = cancel the walk
  // (the pack channel has no cancel; it finishes the pack it is on -- honest wording below).
  function togglePreload() {
    const p = window.__SP_PRELOAD;
    if (!p) { setNote('预载模块未加载'); return; }
    try {
      if (running) { if (typeof p.cancel === 'function') p.cancel(); }
      else {
        const sh2 = shell();
        try { if (sh2 && typeof sh2.syncArt === 'function') sh2.syncArt(); } catch (e) { /* 包通道失败：文件走查照旧 */ }
        if (typeof p.start === 'function') p.start();
      }
    } catch (e) { setNote('预载操作失败'); }
  }

  // Five equal function tiles; the fifth drives the same preload-center API as before.
  const FUNCS = [
    ['mod 管理器', 'mods', '▧'],
    ['房间列表', 'rooms', '▦'],
    ['全局设置', 'settings', '⚙'],
    ['检查更新', null, '↻'],
    ['开始预载', 'preload', '↓'],
  ];

  // Three connect rows first, five actions next, then resource details and a bottom-edge progress strip.
  return html`<${Modal} open=${true} onClose=${onClose}
    width="min(80vw,34rem)"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>

    <div class="sp-preload-layout">
    <div class="set-list sp-preload-connect-zone" style=${ZONE_RED + ';' + ZONE_PAD}>
      ${layerHead('进入游戏', 'CONNECT')}
      <div class="set-row">
        <span class="set-row__label">本地服务<${MicroLabel}>LOCAL<//></span>
        <div style=${LANE}>
          <div style="display:flex;flex-wrap:wrap;gap:.08rem;align-items:center">
            <button type="button" class="set-apply" style=${CELL} onClick=${startLocal}>进入本地服务</button>
            ${roomCode ? html`<span class="num" style="color:#4ed8af;letter-spacing:.04em">${roomCode}</span>` : null}
            ${roomCode ? html`<button type="button" class="set-apply" style=${CELL} onClick=${copyLink}>复制链接</button>` : null}
          </div>
          <p class="set-hint set-hint--tight" style="margin:0">${lanIpLine()}</p>
        </div>
      </div>
      <div class="set-row">
        <span class="set-row__label">加入局域网<${MicroLabel}>LAN<//></span>
        <div style=${LANE}>
          <div style="display:flex;align-items:center;gap:.08rem;min-width:0">
            <span style="flex:1;min-width:0;opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              ${lanSupported
                ? (lan.state === 'done' ? '发现 ' + lan.rooms.length + ' 个已公开房间' : '同一 Wi-Fi / 虚拟局域网下已公开的房间')
                : '当前版本不支持局域网扫描'}</span>
            <button type="button" class="set-apply" style=${CELL} disabled=${!lanSupported || lan.state === 'scanning'}
              onClick=${scanLan}>${lan.state === 'scanning' ? '扫描中…' : '扫描'}</button>
          </div>
          ${lan.rooms.length ? html`<div style=${GRID2}>${lan.rooms.map(function (r, i) {
            const key = 'lan:' + String(r.ip || '') + ':' + (Number(r.port) || 0) + '#' + (r.code || i);
            const label = String(r.code || '') + (r.name ? ' · ' + String(r.name) : '');
            return html`<button key=${key} type="button" class="set-apply" style=${CELL}
              onClick=${function () { joinLan(r); }}>${label}</button>`;
          })}</div>` : null}
          ${lan.note ? html`<p class="set-hint set-hint--tight" style="margin:0">${lan.note}</p>` : null}
        </div>
      </div>
      <div class="set-row">
        <span class="set-row__label">加入服务器<${MicroLabel}>SERVER<//></span>
        <div style=${LANE}>
          <div style="display:flex;align-items:center;gap:.08rem;min-width:0">
            <input class="set-input" type="text" value=${custom} placeholder="输入服务器地址（如 example.com）"
              style="flex:1;min-width:0" onInput=${(e) => setCustom(e.currentTarget.value)} />
            <button type="button" class="set-apply" style=${CELL} disabled=${!custom} onClick=${joinCustom}>连接</button>
            <button type="button" class="set-apply" style=${CELL} onClick=${function () { openPanel('servers', onClose); }}>服务器列表</button>
          </div>
        </div>
      </div>
      ${!native ? html`<p class="set-hint set-hint--tight">本地服务 / 局域网仅 App 版可用；自定义地址在网页版同样可用。</p>` : null}
    </div>

    <div class="set-list sp-preload-function-zone" style=${ZONE_YELLOW + ';' + ZONE_PAD + ';margin-top:.1rem'}>
      ${layerHead('功能', 'FUNCTIONS')}
      <div class="sp-preload-action-grid" style=${GRID5}>
        ${FUNCS.map(function (it) {
          const baseLabel = it[0];
          const kind = it[1];
          const label = kind === 'preload' ? (running ? '停止预载' : '开始预载') : baseLabel;
          return html`<button key=${baseLabel} type="button" class="sp-preload-action"
            data-glyph=${kind === 'preload' && running ? '■' : it[2]}
            data-action=${kind === 'preload' ? 'preload' : 'function'}
            data-preload-state=${running ? 'running' : 'idle'}
            onClick=${function () {
              if (kind === 'preload') togglePreload();
              else if (kind) openPanel(kind, onClose);
              else checkUpdate();
            }}>${label}</button>`;
        })}
      </div>
      <p class="set-hint set-hint--tight" style="margin:0">自定义地址只在本机连接，不会同步到服务器清单站。</p>
    </div>

    <div class="set-list sp-preload-resource-zone" style="margin-top:.04rem">
      ${layerHead('资源预载', 'PRELOAD')}
      ${stateRow(headText(phase, failed), pct)}
      ${infoRow('本地可用', 'LOCAL', done + ' / ' + total + ' · '
        + (store === 'android' ? '回源缓存' : '浏览器缓存') + ' ' + mb(bytes)
        + (pending > 0 ? ' · 待预载 ' + pending : ''))}
      <p class="set-hint set-hint--tight" style="margin:0">预载在后台进行；运行中可随时停止。</p>
      ${note ? html`<p class="set-hint set-hint--tight">${note}</p>` : null}
      ${progressBar(pct)}
    </div>
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
