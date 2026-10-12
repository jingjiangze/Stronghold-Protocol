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
// LAYOUT (owner 2026-10-12, given as an SVG sketch -- that sketch is the *visual* baseline, this
// module is the implementation). Top to bottom, ONE screen, fixed window size, no scrolling:
//   (1) 三列竖框  本地服务 / 加入局域网 / 加入服务器 -- three EQUAL columns side by side, the whole
//       group taking exactly HALF of the content height (flex:0 0 50%). Each column keeps the
//       connect controls it always had (进入本地服务 / 复制链接 / 扫描 / 房间按钮 / 地址输入 / 连接 /
//       服务器列表), so no entry was lost in the re-layout.
//   (2) 五按钮一排  mod 管理器 / 房间列表 / 全局设置 / 检查更新 / 开始预载 -- five EQUAL cells in ONE
//       row (repeat(5,minmax(0,1fr))), plain .set-apply buttons (owner: 不做大卡片, keep the button
//       style). The 5th is the preload toggle, whose start/cancel wiring is unchanged.
//   (3) 感谢名单跑马灯  the credits list, scrolling right-to-left like a game's opening credits.
//   (4) 预载进度条  the horizontal bar + percentage, pinned at the bottom (owner: fixed below the
//       button area; the credits sit ABOVE the bar -- this order deliberately differs from the
//       sketch, per the owner's written correction).
//
// The zone tinting of the previous revision (a red CONNECT zone + an amber FUNCTIONS zone) is GONE
// (owner: 不加红/绿区域底色); what is left is the Stronghold look the overlay always had: the
// translucent dark plate, hairline mint borders, mint titles/accents, .set-apply buttons.
//
// LOOK: the overlay's OWN kit (ui/overlayKit.js) + this panel's own scoped sheet. Nothing borrows the
// PAGE's design system: the overlay carries its kit + stylesheet (scoped .sp-ui) so it renders the
// same on the local tree page and on any third-party server page. This panel adds ONE extra sheet
// (injectPanelStyles, id #sp-preload-panel-style) for what inline styles cannot express -- the
// 3-column / 5-cell grids, the media queries and the marquee @keyframes. EVERY selector in it starts
// with .sp-preload (narrower than .sp-ui), so it cannot leak into other panels or the page.
//
// WHY './overlayKit.js' (a sibling of THIS file, not the page's js/ui/components.js): shell-bridge.js
// injects this file as a MODULE at /__sp/ui/preloadPanel.js, so './overlayKit.js' resolves to
// /__sp/ui/overlayKit.js -- always served from this machine (never the page's origin) and the same
// module instance the lobby panel and the panel host use. The kit registers window.__SP_UI_KIT so all
// overlay modules share ONE preact copy. No page module is imported.
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

// ---- this panel's own scoped stylesheet ---------------------------------------------------------
// Inline styles cover the one-off spacing, but three things cannot be written inline: the multi-line
// grids (three columns / five equal cells), the narrow-screen media queries, and the credits
// marquee's @keyframes. So this panel ships its own sheet, exactly like shellPanels.js ships
// #sp-ui-style / #sp-panel-layout. EVERY selector is prefixed with the panel's own root class
// (.sp-preload), so nothing here can reach another panel or the page.
const PANEL_STYLE_ID = 'sp-preload-panel-style';

/** The panel stylesheet as one string (one rule per array line, static-extractable -- the same
 *  convention srvStyleCss/panelLayoutCss/overlayStyleCss use). */
function panelStyleCss() {
  return [
    // Fixed window: the content area does not grow with the data -- its height is the modal's 88vh
    // ceiling minus the frame (stripe + head + body padding + footer ~ 2.2rem; 2.3rem leaves a few px
    // of slack so a font-fallback line-box cannot push the body into a scrollbar), and overflow:hidden
    // is the owner's "页面不可滚动" rule. Everything below is laid out inside this one screen.
    '.sp-preload{box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between;gap:.16rem;height:calc(88vh - 2.3rem);overflow:hidden}',
    // (1) three vertical columns, side by side; the GROUP is exactly half the content height
    '.sp-preload__zones{flex:0 0 50%;min-height:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.22rem}',
    '.sp-preload__zone{box-sizing:border-box;min-width:0;min-height:0;display:flex;flex-direction:column;gap:.1rem;padding:.18rem;border:1px solid #3d7463;border-radius:6px;background:rgba(15,22,21,.8)}',
    '.sp-preload__zone-title{margin:0;text-align:center;font-size:.26rem;font-weight:700;letter-spacing:.06em;color:#67d9b5}',
    '.sp-preload__zone-micro{display:block;text-align:center;color:#8c9c96}',
    '.sp-preload__zone-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;justify-content:center;gap:.08rem}',
    '.sp-preload__acts{display:flex;flex-wrap:wrap;align-items:center;gap:.08rem;min-width:0}',
    '.sp-preload__acts .set-apply{flex:0 1 auto;min-width:0}',
    // (2) five equal cells in ONE row, plain .set-apply buttons (no card, no tint)
    '.sp-preload__menu{flex:0 0 auto;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:.14rem}',
    '.sp-preload__menu .set-apply{width:100%;min-height:.56rem;font-size:.18rem;padding:.04rem .06rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sp-preload__menu .set-apply.is-on{background:var(--sp-mint);border-color:#6fe8c4;color:#04140f;font-weight:700}',
    // (3) the credits marquee: four identical copies, translateX(-25%) == one copy, so the loop is
    // seamless; the two hairline rules keep it a distinct strip inside the plate.
    '.sp-preload__credits{flex:0 0 auto;position:relative;overflow:hidden;padding:.07rem 0;border-top:1px solid #1e2823;border-bottom:1px solid #1e2823;',
    'mask-image:linear-gradient(90deg,transparent 0,#000 6%,#000 94%,transparent 100%);-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 6%,#000 94%,transparent 100%)}',
    '.sp-preload__roll{display:flex;width:max-content;will-change:transform;animation:sp-preload-marquee 30s linear infinite}',
    '.sp-preload__roll-copy{display:inline-flex;align-items:baseline}',
    '.sp-preload__credit{display:inline-flex;align-items:baseline;gap:.08rem;padding:0 .34rem;white-space:nowrap}',
    '.sp-preload__credit-name{font-size:.24rem;font-weight:700;letter-spacing:.03em;color:#f4f6f5}',
    '.sp-preload__credit-name--lead{color:#67d9b5}',
    '.sp-preload__credit-pre{color:#67d9b5;font-weight:500}',
    '.sp-preload__credit-role{font-size:.13rem;letter-spacing:.14em;color:#889894}',
    '.sp-preload__credit-dot{color:#3d7463}',
    '@keyframes sp-preload-marquee{from{transform:translate3d(0,0,0)}to{transform:translate3d(-25%,0,0)}}',
    '@media (prefers-reduced-motion:reduce){.sp-preload__roll{animation:none}}',
    // (4) the preload bar, pinned at the bottom: horizontal, with the percentage read-out.
    // natural height (the surplus height becomes the breathing room between the four blocks --
    // justify-content:space-between above), shrinkable so a short screen squeezes THIS block first.
    '.sp-preload__preload{flex:0 1 auto;min-height:0;display:flex;flex-direction:column;justify-content:flex-start;gap:.08rem;overflow:hidden}',
    '.sp-preload__state{display:flex;align-items:baseline;gap:.14rem;min-width:0}',
    '.sp-preload__state-label{flex:none;font-size:.16rem;letter-spacing:.16em;color:#67d9b5}',
    '.sp-preload__state-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.16rem;color:#c3cbc7}',
    '.sp-preload__state-pct{flex:none;font-size:.16rem;color:#67d9b5;font-variant-numeric:tabular-nums}',
    '.sp-preload__bar{height:.27rem;border:1px solid #45685d;border-radius:.14rem;background:#1d2825;overflow:hidden}',
    '.sp-preload__bar-fill{height:100%;background:linear-gradient(90deg,#2f8f76,#4ed8af);border-radius:inherit;transition:width .3s linear}',
    '.sp-preload__meta{display:flex;align-items:baseline;gap:.1rem;margin:0;min-width:0;font-size:.14rem;color:#8c9c96}',
    '.sp-preload__meta-label{display:inline-flex;align-items:baseline;gap:.08rem;flex:none;color:#8c9c96}',
    '.sp-preload__meta-val{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sp-preload__hint{margin:0;font-size:.13rem;line-height:1.55;color:#6c7a74;overflow-wrap:anywhere}',
    '.sp-preload__note{margin:0;font-size:.14rem;color:#c3cbc7;overflow-wrap:anywhere}',
    '.sp-preload__code{color:#4ed8af;letter-spacing:.04em}',
    '.sp-preload__input{flex:none}',
    // 窄屏 / 竖屏: tighter type + padding; the five cells stay ONE row and the columns stay side by side
    '@media (max-width:720px){.sp-preload{gap:.12rem}',
    '.sp-preload__zones{gap:.12rem}',
    '.sp-preload__zone{padding:.12rem .1rem;gap:.06rem}',
    '.sp-preload__zone-title{font-size:.2rem}',
    '.sp-preload__zone-micro{font-size:.1rem}',
    '.sp-preload__menu{gap:.08rem}',
    '.sp-preload__menu .set-apply{min-height:.44rem;font-size:.16rem;padding:0 .02rem}',
    '.sp-preload__credit{padding:0 .22rem}',
    '.sp-preload__credit-name{font-size:.2rem}',
    '.sp-preload__credit-role{font-size:.11rem}',
    '.sp-preload__state-label,.sp-preload__state-text,.sp-preload__state-pct{font-size:.14rem}',
    '.sp-preload__bar{height:.22rem}}',
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

// ---- 感谢名单（credits）--------------------------------------------------------------------------
// 真源（2026-10-12 核对，按 owner 口径「用真实名单，不编造」）：
//   线上 KV  GET https://ganxiemingdan.jiangjiangze.icu/api/thanks  → v=2, updated 2026-10-11, 7 条；
//   仓库副本 C:\DDDD\Agent Work\stronghold-thanks\data\thanks.json（v=1 内置兜底，6 条）与
//            C:\DDDD\Agent Work\_thanks-deploy\data\thanks.json（同一份，字节相同）。
// 这里内嵌 KV 那一版（条数更全，且是维护页真正在用的真源），并按网页同一套排版口径渲染：
//   大字 = 名字（前缀 bilibili_ 用 mint 小字，见 stronghold-thanks/js/thanks.js displayName/buildUnits），
//   小字 = 角色备注（见 stronghold-thanks/css/thanks.css .thanks-item__name / .thanks-item__role）。
// 为什么内嵌而不 fetch：叠加层面板不联网（服务器页上跨域、也怕拖慢首屏），名单随面板一起热更新
// —— 改名单 = 改这里 + 重新分发 extras。跨域抓取留给网页版感谢名单页（它自己带缓存与降级）。
const CREDITS_PREFIX = 'bilibili_';
const CREDITS_NAMES = [
  { name: '纸鸢安好', role: '项目发起人' },
  { name: '水沫沐沐', role: 'Mod管理器作者' },
  { name: 'jingjiangze', role: '' },
  { name: '剑光卤煮-斩尽牛杂', role: '' },
  { name: '不知名信箱', role: '' },
  { name: '雨千代Chiyo', role: '' },
  { name: '伊佐那邪_', role: '' },
];

/** 一条名单的显示名与拆出的前缀（与 stronghold-thanks/js/thanks.js 的 displayName 同口径）。 */
function creditUnit(item) {
  const name = String((item && item.name) || '').trim();
  const role = String((item && item.role) || '').trim();
  const p = (item && Object.prototype.hasOwnProperty.call(item, 'prefix')) ? String(item.prefix == null ? '' : item.prefix) : CREDITS_PREFIX;
  const full = (p && name.indexOf(p) !== 0) ? p + name : name;
  const pre = (p && name.indexOf(p) !== 0) ? p : '';
  return { label: pre ? full.slice(pre.length) : full, pre: pre, role: role, lead: false };
}

/** 跑马灯里的全部条目：先「感谢名单 / THANKS LIST」标题条，再逐条真实名单。 */
function creditList() {
  const out = [{ label: '感谢名单', pre: '', role: 'THANKS LIST', lead: true }];
  for (let i = 0; i < CREDITS_NAMES.length; i++) out.push(creditUnit(CREDITS_NAMES[i]));
  return out;
}

/** 一条名单节点：大字名字（前缀 mint）+ 小字角色备注 + 分隔点（网页版同一套「大字 + 小字备注」）。 */
function creditItem(it, key) {
  return html`<span class="sp-preload__credit" key=${key}>
    <span class=${it.lead ? 'sp-preload__credit-name sp-preload__credit-name--lead' : 'sp-preload__credit-name'}>${it.pre ? html`<span class="sp-preload__credit-pre">${it.pre}</span>` : null}${it.label}</span>
    ${it.role ? html`<span class="sp-preload__credit-role">${it.role}</span>` : null}
    <span class="sp-preload__credit-dot">·</span>
  </span>`;
}

/** 四份完全相同的副本 -> 轨道宽度 = 4C，动画走 -25% 正好是一份 C：首尾无缝。
 *  （一份 C 至少要能盖住容器宽度的 1/3，四份足够覆盖宽屏与窄屏两种极端。） */
const CREDIT_COPIES = [0, 1, 2, 3];

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

// ---- block helpers -----------------------------------------------------------------------------
const CELL = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:.42rem';
const GRID2 = 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.06rem;min-width:0';

/** 一个竖框的标题区：中文标题（mint，居中）+ 英文副题（克制的小字，业主 SVG 的 22px/14px 层次）。 */
function zoneHead(title, micro) {
  return html`<h3 class="sp-preload__zone-title">${title}</h3>
    <${MicroLabel} class="sp-preload__zone-micro">${micro}<//>`;
}

/** 预载区第一行 + 进度条（业主：「进度条固定在按钮区域下方，横向、显示百分比」）。
 *  状态文字与进度条同排，百分比右对齐；条子本身是 .sp-preload__bar 轨道 + 内联宽度的填充。 */
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
 *  progress/state and the shell bridge for the cache reading + the LAN addresses. Owner 2026-10-11 +
 *  2026-10-12: the panel IS the floating window's first screen -- three connect columns, the five
 *  function buttons in one row, the credits marquee, then the preload bar with its one start/stop
 *  button (which now lives in the five-button row). */
export function PreloadPanel(props) {
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

  // ---- the three CONNECT entries (now the three side-by-side columns) ----------------------------
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

  // ---- the preload toggle (the 5th button in the row) --------------------------------------------
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

  // 五按钮一排（业主 2026-10-12 SVG：mod 管理器 / 房间列表 / 全局设置 / 检查更新 / 开始预载）。
  // 「外观设置」+「联机偏好」合并成**一个**「全局设置」（settings 面板里两块分区上下排）；
  // 「服务器列表」不在这排——它收进「加入服务器」那个竖框（业主口径）。第 5 格是预载开关，
  // 它的 start/cancel 绑定与旧版完全一致，只是位置从底部的整宽按钮挪到了这一排。
  const FUNCS = [
    ['mod 管理器', 'mods'],
    ['房间列表', 'rooms'],
    ['全局设置', 'settings'],
    ['检查更新', null],
  ];
  const credits = creditList();

  return html`<${Modal} open=${true} onClose=${onClose} title="功能" micro="MENU"
    width="min(80vw,34rem)"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>

    <div class="sp-preload">

      <div class="sp-preload__zones">
        <section class="sp-preload__zone" data-zone="local">
          ${zoneHead('本地服务', 'LOCAL SERVICE')}
          <div class="sp-preload__zone-body">
            <div class="sp-preload__acts">
              <button type="button" class="set-apply" style=${CELL} onClick=${startLocal}>进入本地服务</button>
              ${roomCode ? html`<span class="num sp-preload__code">${roomCode}</span>` : null}
              ${roomCode ? html`<button type="button" class="set-apply" style=${CELL} onClick=${copyLink}>复制链接</button>` : null}
            </div>
            <p class="sp-preload__hint">${lanIpLine()}</p>
            ${!native ? html`<p class="sp-preload__hint">本地服务 / 局域网仅 App 版可用；自定义地址在网页版同样可用。</p>` : null}
          </div>
        </section>

        <section class="sp-preload__zone" data-zone="lan">
          ${zoneHead('加入局域网', 'LAN DISCOVERY')}
          <div class="sp-preload__zone-body">
            <p class="sp-preload__hint">${lanSupported
              ? (lan.state === 'done' ? '发现 ' + lan.rooms.length + ' 个已公开房间' : '同一 Wi-Fi / 虚拟局域网下已公开的房间')
              : '当前版本不支持局域网扫描'}</p>
            <div class="sp-preload__acts">
              <button type="button" class="set-apply" style=${CELL} disabled=${!lanSupported || lan.state === 'scanning'}
                onClick=${scanLan}>${lan.state === 'scanning' ? '扫描中…' : '扫描'}</button>
            </div>
            ${lan.rooms.length ? html`<div style=${GRID2}>${lan.rooms.map(function (r, i) {
              const key = 'lan:' + String(r.ip || '') + ':' + (Number(r.port) || 0) + '#' + (r.code || i);
              const label = String(r.code || '') + (r.name ? ' · ' + String(r.name) : '');
              return html`<button key=${key} type="button" class="set-apply" style=${CELL}
                onClick=${function () { joinLan(r); }}>${label}</button>`;
            })}</div>` : null}
            ${lan.note ? html`<p class="sp-preload__hint">${lan.note}</p>` : null}
          </div>
        </section>

        <section class="sp-preload__zone" data-zone="server">
          ${zoneHead('加入服务器', 'SERVER CONNECT')}
          <div class="sp-preload__zone-body">
            <input class="set-input sp-preload__input" type="text" value=${custom} placeholder="输入服务器地址（如 example.com）"
              onInput=${(e) => setCustom(e.currentTarget.value)} />
            <div class="sp-preload__acts">
              <button type="button" class="set-apply" style=${CELL} disabled=${!custom} onClick=${joinCustom}>连接</button>
              <button type="button" class="set-apply" style=${CELL}
                onClick=${function () { openPanel('servers', onClose); }}>服务器列表</button>
            </div>
            <p class="sp-preload__hint">自定义地址只在本机连接，不会同步到服务器清单站。</p>
          </div>
        </section>
      </div>

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

      <div class="sp-preload__credits">
        <div class="sp-preload__roll">
          ${CREDIT_COPIES.map(function (c) {
            return html`<span class="sp-preload__roll-copy" key=${'copy' + c}>${credits.map(function (it, i) {
              return creditItem(it, 'c' + c + '-' + i);
            })}</span>`;
          })}
        </div>
      </div>

      <div class="sp-preload__preload">
        ${stateRow(headText(phase, failed), pct)}
        ${infoRow('本地可用', 'LOCAL', done + ' / ' + total + ' · '
          + (store === 'android' ? '回源缓存' : '浏览器缓存') + ' ' + mb(bytes)
          + (pending > 0 ? ' · 待预载 ' + pending : ''))}
        <p class="sp-preload__hint">需要预载大部分资源才能正常加载；预载在后台进行，可随时停止。</p>
        ${note ? html`<p class="sp-preload__note">${note}</p>` : null}
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
