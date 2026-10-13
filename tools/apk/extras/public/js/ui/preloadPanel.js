/* global window, document */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here

// js/ui/preloadPanel.js -- the floating window's screen (kind 'preload' in ui/shellPanels.js'
// add-on registry; openPanel('preload') renders it -- preload-center.js open() and art-prefetch.js'
// floating chip both call that).
//
// LAYOUT (owner 2026-10-13, branch ui/redraw-function-panel). The window lost its whole connect
// block: 「本地服务 / 加入局域网 / 加入服务器」 + every control inside them (the 进入本地服务 button,
// 房号/复制链接, 扫描 + 房间列表, 服务器地址输入 + 连接 + 服务器列表, 本机虚拟局域网 IP 提示,
// 自定义地址只在本机连接… hint) are GONE from here -- the owner moved them onto the full-screen first
// interface (js/first-screen.js) and said so: 「里面的悬浮窗界面去掉「本地服务 / 加入局域网 / 加入服务器」
// 和里面的（…）」. The bodies were MOVED (not copied) to ui/connect-core.js, so there is exactly one
// implementation and this file's tests assert none of them live here any more. The 「房间列表」 button
// is gone from the menu row for the same round (owner: 「房间列表按钮可以去掉了」).
//
// What is left, in ONE screen, THREE equal bands (owner: 「不可滚动、三处 height 相等（无滚动条）」 --
// `flex:1 1 0` bands + a fixed content height, so the three band heights are equal by construction and
// no band can push the box into a scrollbar):
//   (1) 功能 FUNCTIONS  four equal cells in ONE row: mod 管理器 / 全局设置 / 检查更新 / 开始预载
//       (the preload toggle is the 4th cell; its start/cancel wiring is unchanged).
//   (2) 房间 ROOMS  the LAN room list, inline (业主 2026-10-13: the 「房间列表」 button is gone, the
//       rooms are listed right here). 扫描 / 加入 走 ui/connect-core.js —— 与全屏第一界面同一份实现。
//       （感谢名单这一格已按业主口径搬到全屏第一界面，不再留在这里。）
//   (3) 资源预载 RESOURCE PRELOAD  the status text + percentage + progress bar + the 本地可用 line.
//
// LOOK (owner 2026-10-13: 「参考样式参考站点，Paper-Yuan 布局按他的来」+ 「硬直角/括角、薄荷强调」):
// hard corners everywhere (no border-radius), hairline --sp-line2 borders, mint accents, and the
// colours come from the overlay's OWN kit tokens (ui/shellPanels.js `.sp-ui`), whose values ARE the
// reference site's six: --sp-mint #4ed8af / --sp-line2 #3e4b45 / --sp-text-hi #f2f2f2 /
// --sp-text #c3cbc7 / --sp-text-lo #8a948f / --sp-text-dim #5d6863. The nine homebrew hexes the older
// revisions used (#67d9b5 / #3d7463 / #45685d / #1e2823 / #889894 / #2f8f76 / #1d2825 / #8c9c96 /
// #6c7a74) are gone from this file. The red/amber zone tinting stays gone (owner: 不加红/绿区域底色).
//
// This panel adds ONE extra sheet (injectPanelStyles, id #sp-preload-panel-style) for what inline
// styles cannot express -- the four-cell grid, the media queries and the marquee @keyframes. EVERY
// selector in it starts with .sp-preload (narrower than .sp-ui), so it cannot leak.
//
// Contract: ESM + htm (no build step), the only third-party dependency is the shell's own vendor
// modules, degrades to shims (never throws) when a dependency is absent, idempotent.

import { shell, openPanel, lanSupported, scanLan, joinLan, matchLan, lanRoomKey, lanRoomLabel } from './connect-core.js';

let html;
let Modal;
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
    <div class="modal__body" style="max-width:92vw;max-height:86vh;overflow:auto;padding:12px;background:#0f1815;border:1px solid #3e4b45">
      ${q.children}
    </div>
  </div>`;
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
  MicroLabel = shimMicroLabel;
  toast = shimToast;
}
installShims();

/** Resolve the shared overlay UI kit (ui/overlayKit.js) -- the SAME instance every overlay module
 *  uses (the kit registers window.__SP_UI_KIT; the first loader wins, later ones reuse it). No page
 *  module is imported: the page's js/ui/components.js may be a different version, or absent.
 *  ui/connect-core.js is a STATIC import on purpose: it is a dependency-free sibling in this
 *  siblings in this same directory (the same delivery unit, /__sp/ui/), not shell modules. */
async function loadDeps() {
  let kit = null;
  try { kit = await import('./overlayKit.js'); } catch (e) { /* keep the shims */ }
  const g = (typeof window !== 'undefined' && window.__SP_UI_KIT) ? window.__SP_UI_KIT : null;
  if (g) kit = g;
  if (kit && typeof kit.html === 'function' && typeof kit.Modal === 'function'
      && typeof kit.MicroLabel === 'function') {
    html = kit.html;
    Modal = kit.Modal;
    MicroLabel = kit.MicroLabel;
    if (typeof kit.toast === 'function') toast = kit.toast; // self-owned feedback (no page ToastHost)
    if (typeof kit.useState === 'function') useState = kit.useState;
    if (typeof kit.useEffect === 'function') useEffect = kit.useEffect;
  }
}

// ---- this panel's own scoped stylesheet ---------------------------------------------------------
const PANEL_STYLE_ID = 'sp-preload-panel-style';

/** The panel stylesheet as one string (one rule per array line, static-extractable -- the same
 *  convention srvStyleCss/panelLayoutCss/overlayStyleCss use). Colours ride the kit's own tokens
 *  (--sp-*), whose values are the reference site's six; every corner is hard (radius 0). */
function panelStyleCss() {
  return [
    // Fixed window: the content area does not grow with the data. height = the modal's 88vh ceiling
    // minus the frame (stripe + head + body padding + footer ~ 2.2rem; 2.3rem leaves a few px of
    // slack so a font-fallback line-box cannot push the body into a scrollbar), and overflow:hidden
    // is the owner's 「页面不可滚动」 rule. Inside it: THREE bands of EQUAL height (owner: 三处 height
    // 相等) -- flex:1 1 0 each, minus the two gaps.
    // 业主 2026-10-13：原来固定 88vh 高 + 三条带各占 1/3 ⇒ 内容撑不满就显得空。改成**按内容收**：
    // 面板高度 auto（由 .modal__body 的 max-height 兜底），三条带 flex:0 0 auto。
    '.sp-preload{box-sizing:border-box;display:flex;flex-direction:column;gap:.14rem;height:auto;overflow:hidden}',
    '.sp-preload__band{box-sizing:border-box;flex:0 0 auto;min-height:0;display:flex;flex-direction:column;gap:.08rem;',
    'padding:.12rem .16rem;border:1px solid var(--sp-line2);background:rgba(10,13,12,.5)}',
    // (1) 功能：四格同排（同宽），保持 .set-apply 按钮风格；按钮在带内垂直居中等高排布
    '.sp-preload__menu{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));align-items:center;gap:.12rem;flex:1 1 auto;min-height:0}',
    '.sp-preload__menu .set-apply{width:100%;min-height:max(.6rem,40px);max-height:.74rem;font-size:.2rem;padding:.04rem .06rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sp-preload__menu .set-apply.is-on{background:var(--sp-mint);border-color:var(--sp-mint);color:#04140f;font-weight:700}',
    // (2) 感谢名单：裁剪框固定（只有轨道在动），四条完全相同的副本竖排 -> translateY(-25%) 正好一份，首尾无缝
    // 房间带（取代原来的感谢名单带）：一个横排的扫描按钮 + 一列房间按钮，扫到多少列多少
    // 四块布局：左列 = 匹配和加入房间 + 预载数据（上下），右列 = 房间列表（通高）。
    '.sp-preload__grid{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:auto 1fr;gap:.12rem;align-items:start;min-width:0}',
    '.sp-preload__grid>[data-band="rooms"]{grid-column:1;grid-row:1}',
    '.sp-preload__grid>[data-band="preload"]{grid-column:1;grid-row:2}',
    '.sp-preload__grid>[data-band="list"]{grid-column:2;grid-row:1 / span 2}',
    '.sp-preload__rooms-rows{display:flex;flex-direction:column;gap:.06rem;max-height:calc(8 * 1rem);overflow-y:auto;min-width:0}',
    '.sp-preload__room.is-picked{border-color:var(--sp-mint);box-shadow:inset 0 0 0 1px rgba(78,216,175,.35)}',
    '.sp-preload__rooms{display:flex;flex-wrap:wrap;align-items:center;gap:.08rem;min-width:0}',
    '.sp-preload__room{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;max-width:100%;',
    'min-height:max(.42rem,36px);padding:0 .12rem;background:rgba(10,13,12,.5);border:1px solid var(--sp-line2);color:var(--sp-text);',
    'font-size:.16rem;letter-spacing:.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sp-preload__room:hover{border-color:var(--sp-mint);color:var(--sp-mint)}',
    '.sp-preload__scan{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;',
    'min-height:max(.42rem,36px);padding:0 .18rem;background:rgba(10,13,12,.5);border:1px solid var(--sp-mint);color:var(--sp-mint);',
    'font-size:.16rem;letter-spacing:.02em;white-space:nowrap}',
    '.sp-preload__scan:disabled{opacity:.45;cursor:default}',
    // (3) 资源预载：状态行 + 进度条 + 本地可用行 + 提示，整块在带内居中，收缩时先让位
    '.sp-preload__preload{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;justify-content:center;gap:.08rem;overflow:hidden}',
    '.sp-preload__state{display:flex;align-items:baseline;gap:.14rem;min-width:0}',
    '.sp-preload__state-label{flex:none;font-size:.16rem;letter-spacing:.16em;color:var(--sp-mint)}',
    '.sp-preload__state-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.16rem;color:var(--sp-text)}',
    '.sp-preload__state-pct{flex:none;font-size:.16rem;color:var(--sp-mint);font-variant-numeric:tabular-nums}',
    // 硬直角：进度条是一个矩形槽 + 矩形填充（不再有 .14rem 圆角）
    '.sp-preload__bar{height:.24rem;border:1px solid var(--sp-line2);background:#0a0d0c;overflow:hidden}',
    '.sp-preload__bar-fill{height:100%;background:linear-gradient(90deg,#2a9e7f,#4ed8af);transition:width .3s linear}',
    '.sp-preload__meta{display:flex;align-items:baseline;gap:.1rem;margin:0;min-width:0;font-size:.14rem;color:var(--sp-text-lo)}',
    '.sp-preload__meta-label{display:inline-flex;align-items:baseline;gap:.08rem;flex:none;color:var(--sp-text-lo)}',
    '.sp-preload__meta-val{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sp-preload__hint{margin:0;font-size:.13rem;line-height:1.55;color:var(--sp-text-dim);overflow-wrap:anywhere}',
    '.sp-preload__note{margin:0;font-size:.14rem;color:var(--sp-text);overflow-wrap:anywhere}',
    // 窄屏 / 竖屏: tighter type + padding; the four cells stay ONE row, the three bands stay stacked
    '@media (max-width:720px){.sp-preload{gap:.1rem}',
    '.sp-preload__band{gap:.06rem;padding:.08rem .1rem}',
    '.sp-preload__menu{gap:.08rem}',
    '.sp-preload__menu .set-apply{min-height:max(.44rem,40px);font-size:.16rem;padding:0 .02rem}',
    '.sp-preload__state-label,.sp-preload__state-text,.sp-preload__state-pct{font-size:.14rem}',
    '.sp-preload__bar{height:.2rem}}',
  ].join('');
}

/** One-shot injector (idempotent on #sp-preload-panel-style). No DOM / no head -> silent no-op,
 *  never throws (tests and old shells keep working). */
export function injectPreloadPanelStyles() {
  try {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
    if (typeof document.getElementById === 'function' && document.getElementById(PANEL_STYLE_ID)) return true;
    const el = document.createElement('style');
    el.setAttribute('id', PANEL_STYLE_ID);
    el.textContent = panelStyleCss();
    const head = document.head || document.documentElement;
    if (!head || typeof head.appendChild !== 'function') return false;
    head.appendChild(el);
    return true;
  } catch (e) { return false; }
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

// 感谢名单（credits）已整体搬到全屏第一界面：first-screen.js 画它，ui/credits.js 供数据。


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

// ---- block helpers -----------------------------------------------------------------------------
/** 预载区第一行 + 进度条（业主：「进度条固定在按钮区域下方，横向、显示百分比」）。
 *  状态文字与进度条同排，百分比右对齐；条子本身是矩形槽 + 内联宽度的填充。 */
function stateRow(stateText, pct) {
  return html`<div class="sp-preload__state">
    <span class="sp-preload__state-label">RESOURCE PRELOAD</span>
    <span class="sp-preload__state-text">${stateText}</span>
    <span class="sp-preload__state-pct">${pct}%</span>
  </div>
  <div class="sp-preload__bar">
    <div class="sp-preload__bar-fill" style=${'width:' + pct + '%'}></div>
  </div>`;
}

/** 本地可用 / 缓存字节 / 待预载 —— 一行压缩显示（数据与拆分口径不变，只是排版变紧凑）。 */
function infoRow(label, micro, value) {
  return html`<p class="sp-preload__meta">
    <span class="sp-preload__meta-label">${label}<${MicroLabel}>${micro}<//></span>
    <span class="sp-preload__meta-val">${value}</span>
  </p>`;
}

// ---- the panel ---------------------------------------------------------------------------------
/** props.onClose: close the panel (the shell host passes it). Reads window.__SP_PRELOAD for the
 *  progress/state and the shell bridge for the cache reading. Owner 2026-10-13: the connect block and
 *  the 房间列表 entry are gone (they live on the full-screen first interface / were dropped); what is
 *  left is 四格功能 + 感谢名单 + 预载进度. */
export function PreloadPanel(props) {
  const onClose = props && props.onClose;
  const noteState = useState('');
  const note = noteState[0];
  const setNote = noteState[1];
  // 房间列表（业主 2026-10-13：「房间列表」按钮删掉，改成面板里直接列出）。状态形状与第一界面一致，
  // 扫描/加入走同一份 ui/connect-core.js；面板关掉即丢弃，不做跨面板共享（两处各扫各的）。
  const roomsState = useState({ state: 'idle', rooms: [], note: '' });
  const rooms = roomsState[0];
  const setRooms = roomsState[1];
  const roomsList = rooms.rooms;
  // 列表里点选一行，再用「加入房间」进（选择先行，与第一界面同口径）。
  const pickedState = useState(null);
  const pickedRoom = pickedState[0];
  const setPickedRoom = pickedState[1];
  const roomsStateName = rooms.state;
  useTick();

  const s = readState();
  const phase = (s && s.phase) || 'idle';
  const done = num(s && s.done);
  const total = num(s && s.total);
  const pending = num(s && s.pending);
  const failed = num(s && s.failed);
  const pct = total > 0 ? Math.floor(done * 100 / total) : 0;
  const running = phase === 'running' || phase === 'scanning';

  // Cache bytes: prefer the shell bridge reading; fall back to the state API's own figure (browser
  // cache on the web), which folds the same bridge. Absent everywhere -> 0, honestly drawn.
  const cache = readCache();
  const store = cache ? 'android' : ((s && s.store) || '');
  const bytes = cache ? num(cache.cachedBytes) : num(s && s.bytes);

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

  // ---- the preload toggle (the 4th cell in the row) ----------------------------------------------
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

  // 四格一排（业主 2026-10-13：去掉「房间列表」，五格变四格）：mod 管理器 / 全局设置 / 检查更新 /
  // 开始预载。「外观设置」+「联机偏好」合并成一个「全局设置」。三条连接入口**不在这里** —— 它们
  // 已经搬到全屏第一界面（js/first-screen.js），本窗不再画任何连接控件。
  const FUNCS = [
    ['mod 管理器', 'mods'],
    ['全局设置', 'settings'],
    ['检查更新', null],
  ];

  // 三条出口保持不变（业主 2026-10-13：右下角「完成」主按钮去掉，出口不只这一颗）：① Modal 自带的
  // 「点遮罩关闭」（overlayKit.js 的 .modal 在 onMouseDown 判定 e.target === e.currentTarget 就调
  // onClose，closeOnBackdrop 默认 true）；② 每条出路先 onClose()（openPanel(kind, onClose) 在打开其它
  // 面板前先关本面板）。
  // ---- 房间带（业主 2026-10-13：按钮变内联列表）------------------------------------------------
  // 扫描/加入的本体都在 ui/connect-core.js（第一界面用同一份），这里只做面板内的状态与提示。
  const ctx = { say: function (msg) { try { setNote(msg); } catch (e) { /* no state */ } }, onClose: onClose };
  const lanOk = typeof lanSupported === 'function' ? lanSupported() : false;
  // 业主 2026-10-13：**扫描功能与按钮都去掉** —— 面板不再自己扫（房间列表只显示已经拿到的房间）。
  const roomsHint = !lanOk ? '当前版本不支持局域网扫描'
    : (roomsStateName === 'done' ? '没扫到已公开的房间' : '还没有房间 —— 点「匹配」找一局');

  return html`<${Modal} open=${true} onClose=${onClose} title="功能" micro="MENU"
    width="min(80vw,34rem)">

    <div class="sp-preload">

      <section class="sp-preload__band" data-band="menu">
        <${MicroLabel}>FUNCTIONS<//>
        <div class="sp-preload__menu">
          ${FUNCS.map(function (it) {
            const label = it[0];
            const kind = it[1];
            return html`<button key=${label} type="button" class="set-apply"
              onClick=${function () { if (kind) openPanel(kind, onClose); else checkUpdate(); }}>${label}</button>`;
          })}
          <button type="button" class=${running ? 'set-apply is-on' : 'set-apply'} onClick=${togglePreload}>
            ${running ? '停止预载' : '开始预载'}</button>
        </div>
      </section>

      <!-- 业主 2026-10-13：感谢名单搬到全屏第一界面了，这一带换成**房间列表**（「房间列表」按钮已删，
           改成直接内联列出局域网房间）。扫描与加入都走 ui/connect-core.js，和第一界面同一份实现。 -->
      <!-- 业主 2026-10-13 第十一轮：四块布局 —— 顶部通栏按钮 / 左下「匹配和加入房间」/
           右侧通高「房间列表」/ 左下「预载数据」。**扫描按钮与扫描功能都去掉**（面板不再自己扫，
           房间列表只显示已经拿到的房间；「匹配」是它自己的动作）。 -->
      <div class="sp-preload__grid">
        <section class="sp-preload__band" data-band="rooms">
          <${MicroLabel}>MATCH<//>
          <div class="sp-preload__rooms">
            <button type="button" class="sp-preload__scan" disabled=${!lanOk}
              onClick=${function () { matchLan(ctx); }}>匹配</button>
            <button type="button" class="sp-preload__scan" disabled=${!pickedRoom}
              onClick=${function () { const r = (roomsList || [])[pickedRoom]; if (r) joinLan(r, ctx); }}>加入房间</button>
          </div>
          <p class="sp-preload__hint">${roomsHint}</p>
        </section>

        <section class="sp-preload__band" data-band="list">
          <${MicroLabel}>ROOMS<//>
          <div class="sp-preload__rooms-rows">
            ${roomsList.length ? roomsList.map(function (r, i) {
              return html`<button key=${lanRoomKey(r, i)} type="button" class=${"sp-preload__room" + (pickedRoom === i ? " is-picked" : "")}
                onClick=${function () { setPickedRoom(i); }}>${lanRoomLabel(r)}</button>`;
            }) : html`<p class="sp-preload__hint">${roomsHint}</p>`}
          </div>
        </section>

        <section class="sp-preload__band" data-band="preload">
        <div class="sp-preload__preload">
          ${stateRow(headText(phase, failed), pct)}
          ${infoRow('本地可用', 'LOCAL', done + ' / ' + total + ' · '
            + (store === 'android' ? '回源缓存' : '浏览器缓存') + ' ' + mb(bytes)
            + (pending > 0 ? ' · 待预载 ' + pending : ''))}
          <p class="sp-preload__hint">需要预载大部分资源才能正常加载；预载在后台进行，可随时停止。</p>
          ${note ? html`<p class="sp-preload__note">${note}</p>` : null}
        </div>
        </section>
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
  injectPreloadPanelStyles();
  await registerSelf();
}

// Synchronous marker: shell-bridge.js checks it so a re-run never injects this module twice.
try { if (typeof window !== 'undefined') window.__SP_PRELOAD_PANEL = true; } catch (e) { /* no window (tests) */ }

/** Dependency-resolution signal (tests await it before reading the registry). */
export const depsReady = init();
export function whenDepsReady() { return depsReady; }
