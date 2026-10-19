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

import {
  shell, openPanel, matchOnline, joinServerRow, pickMatchVenue,
  isLocalService, localBase, currentRoomCode, localRoomUrl, copyText, scanLan, onLanScan, joinLan,
  lanRoomKey, lanRoomLabel,
} from './connect-core.js';

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
    // 业主 2026-10-14：面板里的清单一律**两列**（服务器清单与房间清单都是），行内省略号。
    '.sp-preload__rooms-rows{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.06rem;max-height:calc(8 * 1rem);overflow-y:auto;min-width:0}',
    '.sp-preload__srv-rows{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.06rem;max-height:calc(4 * 1rem);overflow-y:auto;min-width:0}',
    '.sp-preload__srv-row{box-sizing:border-box;display:flex;align-items:center;gap:.06rem;min-width:0;width:100%;',
    'min-height:max(.42rem,40px);padding:0 .08rem;background:rgba(10,13,12,.5);border:1px solid var(--sp-line2);',
    'color:var(--sp-text);font-size:.15rem;cursor:pointer;overflow:hidden}',
    '.sp-preload__srv-row:hover{border-color:var(--sp-mint);color:var(--sp-mint)}',
    '.sp-preload__srv-row.is-picked{border-color:var(--sp-mint);box-shadow:inset 0 0 0 1px rgba(78,216,175,.35)}',
    '.sp-preload__srv-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    // 延迟三色：与 connect-core 的 serverLevel 一一对应（阈值同 shellPanels 的 rttDot）
    '.sp-preload__srv-dot{flex:0 0 auto;width:.1rem;height:.1rem;border-radius:50%;background:var(--sp-text-lo,#8a948f)}',
    '.sp-preload__srv-dot.is-ok{background:var(--sp-mint)}',
    '.sp-preload__srv-dot.is-warn{background:#e0b64a}',
    '.sp-preload__srv-dot.is-bad{background:#e06c5a}',
    // 三个按钮**等宽**（grid 三列 1fr），「加入房间」永远在最右（源码顺序即视觉顺序）
    '.sp-preload__btns{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.08rem;align-items:center;min-width:0}',
    '.sp-preload__btns .sp-preload__scan{width:100%;padding:0 .06rem;overflow:hidden;text-overflow:ellipsis}',
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
    // 本地联机带的链接输入框（业主 2026-10-20）：与 .scan 同高、可伸缩
    '.sp-preload__link{box-sizing:border-box;flex:1 1 auto;min-width:0;height:max(.42rem,36px);padding:0 .12rem;',
    'background:rgba(10,13,12,.5);border:1px solid var(--sp-line2);color:var(--sp-text);font-size:.16rem;outline:none}',
    '.sp-preload__link:focus{border-color:var(--sp-mint)}',
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
  // 房间列表（业主 2026-10-15：「右边需要是房间列表」）。数据源 = **大厅房间牌**
  // （window.__SP_LOBBY.rooms()，lobby.js 的 boardStore）。原来那一列是局域网房间，可面板自己早就
  // 不扫了（扫描按钮与功能都已删）⇒ 它永远是空的，画在那里等于没有。订阅即布防 15s 轮询、面板
  // 关闭即撤防，「按需」这条纪律不变（见 2026-10-14 的 sp-lobby 审计）。
  const liveState = useState([]);
  const liveRooms = liveState[0];
  const setLiveRooms = liveState[1];
  // 列表里点选一行，再用「加入房间」进（选择先行，与第一界面同口径）。
  const pickedState = useState(null);
  const pickedRoom = pickedState[0];
  const setPickedRoom = pickedState[1];
  useTick();
  useEffect(function () {
    let unsub = null;
    let timer = 0;
    function pull() {
      try {
        const L = window.__SP_LOBBY;
        if (!L) return false;
        if (typeof L.rooms === 'function') setLiveRooms(L.rooms() || []);
        if (!unsub && typeof L.subscribeRooms === 'function') {
          unsub = L.subscribeRooms(function () {
            try { setLiveRooms(L.rooms() || []); } catch (e) { /* ignore */ }
          });
        }
        return true;
      } catch (e) { return false; }
    }
    // lobby.js 是后加载的：这里等它出现（最多 20 s），拿到就订阅。
    if (!pull()) {
      let tries = 0;
      timer = setInterval(function () {
        tries += 1;
        if (pull() || tries >= 40) { clearInterval(timer); timer = 0; }
      }, 500);
    }
    return function () {
      if (timer) clearInterval(timer);
      try { if (typeof unsub === 'function') unsub(); } catch (e) { /* ignore */ }
    };
  }, []);

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

  /** 大厅房间牌一行 → 文案（房号 · 服务器 · 剩余分钟）。字段见 lobby.js 的 roomsSnapshot 注释：
   *  { code, server, serverId, note, url, host, left }。缺什么就少画什么，绝不编一个。 */
  function boardRoomLabel(r) {
    const o = r || {};
    const code = String(o.code || '').toUpperCase();
    const bits = [];
    if (o.server) bits.push(String(o.server));
    const left = Number(o.left);
    if (isFinite(left) && left > 0) bits.push(Math.max(1, Math.round(left / 60)) + ' 分钟');
    return code + (bits.length ? ' · ' + bits.join(' · ') : '');
  }

  /** 加入大厅房间牌上的一行：走 lobby.js 的 joinRoom（模块级，与大厅面板**同一实现**）——
   *  它自己处理 native 切服 / 网页跳转 / 状态门控（playing/full/closed/gone），失败原因写在 note 里。 */
  function joinBoardRoom(r) {
    if (!r) { setNote('请先选一个房间'); return false; }
    try {
      const L = window.__SP_LOBBY;
      if (!L || typeof L.joinRoom !== 'function') { setNote('房间列表未就绪'); return false; }
      const res = L.joinRoom(r, {});
      if (res && res.ok) {
        try { if (typeof onClose === 'function') onClose(); } catch (e) { /* ignore */ }
        return true;
      }
      setNote((res && res.note) || '加入失败');
      return false;
    } catch (e) { setNote('加入失败'); return false; }
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

  // ---- 第 4 格（返回首页）见上面的 backHome() ------------------------------------------------------
  // 原「开始预载 / 停止预载」开关已删：预载现在由「进入线路」自动开跑（connect-core 的 autoPreload），
  // 面板只**看**进度。业主 2026-10-15 的原话是「开始预载按钮改为返回首页」。

  // 四格一排（业主 2026-10-13：去掉「房间列表」，五格变四格）：mod 管理器 / 全局设置 / 检查更新 /
  // 开始预载。「外观设置」+「联机偏好」合并成一个「全局设置」。三条连接入口**不在这里** —— 它们
  // 已经搬到全屏第一界面（js/first-screen.js），本窗不再画任何连接控件。
  // 业主 2026-10-15：第 4 格从「开始预载」改成「返回首页」—— 预载现在**进入线路即自动开跑**
  // （ui/connect-core.js 的 autoPreload），这一格再放「开始预载」就是个已经做完的动作；而玩家从
  // 首页进到服务器之后，需要一个回到那张全屏首页的出口（不然只能杀进程重开）。
  // 2026-10-20「mod 管理器界面未生效」：/mod 由**本机 Node 服务**应答。在远程服务器上这一格会把
  // 玩家导航到 127.0.0.1 —— 那边没人监听，页面就是空白。所以本地才显示这一格；远程时换成
  // 指向**当前 origin** 的插件工作室（上游 /studio/），那才是远程服务器上真正存在的管理面。
  const local = isLocalService();
  const FUNCS = local ? [
    // 本机服务：/mod（server/overlay/sp-modmgr.mjs：启用/停用 + 上传 + 从站抓取，写 plugins/config.json）
    ['MOD 管理器', 'modmgr'],
    ['全局设置', 'settings'],
    ['检查更新', null],
  ] : [
    // 远程服务器：本机 MOD 页不可用，给出该服务器自己的插件工作室（局域网/本机门禁由上游把守）
    ['插件工作室', 'studio'],
    ['全局设置', 'settings'],
    ['检查更新', null],
  ];

  /** Open the local MOD manager page (same origin, served by the embedded host). */
  function openModManager() {
    try { if (typeof onClose === 'function') onClose(); } catch (e) { /* ignore */ }
    try { window.location.href = '/mod'; return true; }
    catch (e) { try { setNote('无法打开 MOD 管理器'); } catch (e2) { /* ignore */ } return false; }
  }

  /** 远程面板：打开当前 origin 的插件工作室（上游 /studio/）。门禁在上游，打不开时它会自己说明。 */
  function openStudio() {
    try { if (typeof onClose === 'function') onClose(); } catch (e) { /* ignore */ }
    try { window.location.href = '/studio/'; return true; }
    catch (e) { try { setNote('无法打开插件工作室'); } catch (e2) { /* ignore */ } return false; }
  }

  /** 第 4 格：返回首页（全屏第一界面）。先关本面板再开层 —— 层的 z-index 比面板宿主低
   *  （first-screen 2147479000 < host 2147481000），不关面板的话首页会被本窗盖住。 */
  function backHome() {
    try { if (typeof onClose === 'function') onClose(); } catch (e) { /* ignore */ }
    try {
      const f = window.__SP_FIRST;
      if (f && typeof f.open === 'function') { f.open(); return true; }
    } catch (e) { /* 旧树：没有全屏首页 */ }
    try { setNote('当前版本没有首页层'); } catch (e) { /* no state */ }
    return false;
  }

  // 三条出口保持不变（业主 2026-10-13：右下角「完成」主按钮去掉，出口不只这一颗）：① Modal 自带的
  // 「点遮罩关闭」（overlayKit.js 的 .modal 在 onMouseDown 判定 e.target === e.currentTarget 就调
  // onClose，closeOnBackdrop 默认 true）；② 每条出路先 onClose()（openPanel(kind, onClose) 在打开其它
  // 面板前先关本面板）。
  // ---- 房间带（业主 2026-10-13：按钮变内联列表）------------------------------------------------
  // 扫描/加入的本体都在 ui/connect-core.js（第一界面用同一份），这里只做面板内的状态与提示。
  const ctx = { say: function (msg) { try { setNote(msg); } catch (e) { /* no state */ } }, onClose: onClose };
  // 业主 2026-10-15：面板里那一列**服务器清单**已删（面板自己的两列服务器网格整段移除）。
  // 那份清单现在只有第一界面（js/first-screen.js）有；面板左侧只留三颗按钮。
  const roomsHint = liveRooms.length ? '' : '大厅暂无公开房间，点「匹配」自动加入互通服务器并开一局';

  // ---- 业主 2026-10-20：本地 / 远程两套面板（判据见上面 FUNCS 处，同一份 local）---------------
  // 本机这一套是**本地联机**：本机地址与房号、复制邀请链接、输入链接加入、扫附近房间；
  // 远程这一套保持原样（匹配 / 加入服务器 / 大厅房间牌）。
  const linkState = useState('');
  const link = linkState[0];
  const setLink = linkState[1];
  const nearState = useState([]);
  const nearRooms = nearState[0];
  const setNearRooms = nearState[1];
  const nearPhaseState = useState('idle');
  const nearPhase = nearPhaseState[0];
  const setNearPhase = nearPhaseState[1];
  useEffect(function () {
    if (!local) return undefined;      // 远程面板不需要这条订阅
    return onLanScan(function (rooms) { setNearRooms(Array.isArray(rooms) ? rooms.slice() : []); setNearPhase('done'); });
  }, [local]);
  function copyLocalInvite() {
    const code = currentRoomCode();
    const url = localRoomUrl(code) || (localBase() ? localBase().replace(/\/+$/, '') + '/' : '');
    if (!url) { ctx.say('还没拿到本机地址，请稍后再试'); return; }
    copyText(url).then(function (ok) { ctx.say(ok ? '已复制邀请链接：' + url : '复制失败，请手动复制：' + url); });
  }
  function joinByLink() {
    const v = String(link || '').trim();
    if (!v) { ctx.say('先填对方的邀请链接'); return; }
    let room = '';
    try { const m = /[?&]room=([A-Za-z0-9]{4})/.exec(v); if (m) room = m[1].toUpperCase(); } catch (e) { /* 不是链接：当成地址 */ }
    const host = (() => { try { const u = new URL(/^https?:\/\//i.test(v) ? v : 'http://' + v); return u.host; } catch (e) { return ''; } })();
    if (!host) { ctx.say('链接格式不对：应是 http://地址:端口/?room=房号'); return; }
    const sh = shell();
    if (sh && typeof sh.joinOnOrigin === 'function') {
      try { sh.joinOnOrigin('lan:' + host, room); ctx.say(room ? '正在加入房间 ' + room : '正在连接 ' + host); return; }
      catch (e) { ctx.say('加入失败：' + String((e && e.message) || e)); return; }
    }
    try { window.location.href = v; } catch (e) { ctx.say('无法跳转：' + v); }
  }
  function scanNear() {
    scanLan({
      state: nearPhase === 'scanning' ? 'scanning' : 'idle',
      say: ctx.say,
      onState: function (st, rooms, noteText) {
        if (st === 'scanning') { setNearPhase('scanning'); return; }
        if (st === 'idle') { setNearPhase('idle'); if (noteText) ctx.say(noteText); return; }
        setNearPhase('done');
        setNearRooms(Array.isArray(rooms) ? rooms.slice() : []);
      },
    });
  }

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
              onClick=${function () {
                if (kind === 'modmgr') openModManager();
                else if (kind === 'studio') openStudio();
                else if (kind) openPanel(kind, onClose);
                else checkUpdate();
              }}>${label}</button>`;
          })}
          <button type="button" class="set-apply" onClick=${backHome}>返回首页</button>
        </div>
      </section>

      <!-- 业主 2026-10-13：感谢名单搬到全屏第一界面了，这一带换成**房间列表**（「房间列表」按钮已删，
           改成直接内联列出局域网房间）。扫描与加入都走 ui/connect-core.js，和第一界面同一份实现。 -->
      <!-- 业主 2026-10-13 第十一轮：四块布局 —— 顶部通栏按钮 / 左下「匹配和加入房间」/
           右侧通高「房间列表」/ 左下「预载数据」。**扫描按钮与扫描功能都去掉**（面板不再自己扫，
           房间列表只显示已经拿到的房间；「匹配」是它自己的动作）。 -->
      <div class="sp-preload__grid">
        ${local ? html`
        <!-- 本机服务：本地联机一套（业主 2026-10-20）。没有任何远程内容。 -->
        <section class="sp-preload__band" data-band="local">
          <${MicroLabel}>LOCAL<//>
          <div class="sp-preload__btns">
            <button type="button" class="sp-preload__scan"
              onClick=${copyLocalInvite}>复制邀请链接</button>
            <button type="button" class="sp-preload__scan"
              onClick=${backHome}>返回首页</button>
          </div>
          <div class="sp-preload__btns" style="margin-top:8px">
            <input class="sp-preload__link" type="text" value=${link}
              placeholder="对方的邀请链接（http://地址:端口/?room=房号）"
              onInput=${function (e) { setLink(e && e.currentTarget ? e.currentTarget.value : ''); }} />
            <button type="button" class="sp-preload__scan"
              onClick=${joinByLink}>加入</button>
          </div>
          <div class="sp-preload__btns" style="margin-top:8px">
            <button type="button" class="sp-preload__scan" disabled=${nearPhase === 'scanning'}
              onClick=${scanNear}>${nearPhase === 'scanning' ? '扫描中…' : '扫附近房间'}</button>
          </div>
          <div class="sp-preload__rooms-rows" style="margin-top:8px">
            ${nearRooms.length ? nearRooms.map(function (r, i) {
              return html`<button key=${lanRoomKey(r, i)} type="button" class="sp-preload__room"
                onClick=${function () { joinLan(r, ctx); }}>${lanRoomLabel(r) || '房间 ' + (i + 1)}</button>`;
            }) : html`<p class="sp-preload__hint">${nearPhase === 'scanning' ? '正在扫描同一局域网 / 虚拟局域网…' : '点「扫附近房间」找同一网络里的房间'}</p>`}
          </div>
        </section>
        ` : html`
        <!-- 远程服务器：匹配 / 加入服务器 / 房间牌（原有形态，一字不动） -->
        <section class="sp-preload__band" data-band="rooms">
          <${MicroLabel}>MATCH<//>
          <!-- 业主 2026-10-15：面板里的两列服务器网格已删（那份清单只在第一界面）。
               三颗按钮仍然等宽，「加入房间」仍在最右。
               「加入服务器」的目标改由 connect-core 的 pickMatchVenue() 现挑（与「匹配」同一份挑选
               口径，区别是**不建房间**）：面板里没有清单可点，这一颗仍然得有事可做。 -->
          <div class="sp-preload__btns">
            <button type="button" class="sp-preload__scan"
              onClick=${function () { matchOnline(ctx); }}>匹配</button>
            <button type="button" class="sp-preload__scan"
              onClick=${function () {
                const row = pickMatchVenue();
                if (!row) { setNote('没有可用的互通服务器（本机服务不能作为匹配场地）'); return; }
                joinServerRow(row, ctx);
              }}>加入服务器</button>
            <button type="button" class="sp-preload__scan" disabled=${pickedRoom == null}
              onClick=${function () { joinBoardRoom(liveRooms[pickedRoom]); }}>加入房间</button>
          </div>
          <p class="sp-preload__hint">${roomsHint}</p>
        </section>

        <section class="sp-preload__band" data-band="list">
          <${MicroLabel}>ROOMS<//>
          <div class="sp-preload__rooms-rows">
            ${liveRooms.length ? liveRooms.map(function (r, i) {
              return html`<button key=${'rm:' + String((r && r.code) || i)} type="button" class=${"sp-preload__room" + (pickedRoom === i ? " is-picked" : "")}
                onClick=${function () { setPickedRoom(pickedRoom === i ? null : i); }}>${boardRoomLabel(r)}</button>`;
            }) : html`<p class="sp-preload__hint">${roomsHint}</p>`}
          </div>
        </section>
        `}

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
