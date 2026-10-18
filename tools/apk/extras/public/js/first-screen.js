/* global window, document */
// js/first-screen.js -- THE FULL-SCREEN FIRST INTERFACE (owner 2026-10-18: 「主界面重新做，左侧本机服务，
// 右侧加入线上，重做 ui，保留内容（局域网不加）」).
//
// It is an OVERLAY LAYER: it paints above the upstream title screen (and above every page the shell
// reaches) and, like every other shell layer, it is closable -- 「进入游戏」 / Esc /
// window.__SP_FIRST.close() -- so the title screen's own entry stays reachable.
//
// TWO ENTRIES ONLY (2026-10-18 owner call):
//   · 本机服务  -> ui/connect-core.js startLocal()   (starts the embedded Node host and switches to it)
//   · 加入线上  -> ui/connect-core.js joinCustom() / joinServerRow() (typed address or the signed list)
// LAN discovery (scanning, joining, the room grid) was REMOVED from this layer by that same call. The
// functions stay in connect-core.js because they are pure plumbing and other layers/tests still import
// them; this file no longer imports or draws any of them.
//
// LOOK (owner: 「他的布局也可以参考」 -- the Forge launcher's PLUGIN STUDIO page):
//   · a flat top bar (brand left, live status right), hard corners, 1px #3e4b45 lines;
//   · a two-pane workbench: LEFT 本机服务, RIGHT 加入线上, each pane with its own head + body;
//   · one bottom strip: 感谢名单 runner + the 进入游戏 CTA pinned to the right (the studio's 回游戏);
//   · the same dark/mint tokens and the reference site's background layers (glow / radar / sweep +
//     survey grid + scanlines) that this layer has carried since 2026-10-13.
//
// 复制链接 (owner 2026-10-18: 「node 服务启动后显示复制链接」): the copy affordances are NOT shown until
// the host reports READY (window.shell.localServiceReady()). Ready + a room code copies
// <base>/?room=CODE; ready without a room (the room is created on the local page after the origin
// switch) copies the bare <base>/ so the same link can be handed out anyway.
//
// Contract: ESM + htm, no page module, no network, degrades to shims (never throws) when the kit is
// absent, idempotent (window.__SP_FIRST_SCREEN guards the injection in shell-bridge.js).

import { CREDIT_COPIES, creditList, fetchCredits } from './ui/credits.js';
import {
  shell, currentRoomCode, localBase, startLocal, joinCustom, joinServerRow, copyRoomLink,
  copySegmentLink, copyText, localAddresses, serverLevel, visibleServers,
} from './ui/connect-core.js';

let html;
let MicroLabel;
let toast;
let useState;
let useEffect;
let render;

// ---- shims (last resort; only used when the real kit cannot be loaded) --------------------------
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
function shimMicroLabel(p) { return html`<span class="micro">${(p || {}).children}</span>`; }
function shimToast(text) {
  try { if (typeof console !== 'undefined' && console.log) console.log('[shell] ' + text); } catch (e) { /* ignore */ }
}
function shimRender() { return false; }

function installShims() {
  html = shimHtml;
  useState = shimUseState;
  useEffect = shimUseEffect;
  MicroLabel = shimMicroLabel;
  toast = shimToast;
  render = shimRender;
}
installShims();

/** Resolve the shared overlay UI kit -- the SAME instance every overlay module uses (the kit
 *  registers window.__SP_UI_KIT; the first loader wins, later ones reuse it). No page module. */
async function loadDeps() {
  let kit = null;
  try { kit = await import('./ui/overlayKit.js'); } catch (e) { /* keep the shims */ }
  const g = (typeof window !== 'undefined' && window.__SP_UI_KIT) ? window.__SP_UI_KIT : null;
  if (g) kit = g;
  if (kit && typeof kit.html === 'function' && typeof kit.MicroLabel === 'function') {
    html = kit.html;
    MicroLabel = kit.MicroLabel;
    if (typeof kit.toast === 'function') toast = kit.toast;
    if (typeof kit.useState === 'function') useState = kit.useState;
    if (typeof kit.useEffect === 'function') useEffect = kit.useEffect;
    if (typeof kit.render === 'function') render = kit.render;
  }
  // A layer with no renderer must never pretend to be open: openFirstScreen() returns false and the
  // caller (shell-bridge's auto-open) falls back to the floating window's own first screen.
  KIT_OK = !!(kit && typeof kit.html === 'function' && typeof kit.render === 'function');
}

// ---- this layer's own scoped stylesheet ---------------------------------------------------------
const STYLE_ID = 'sp-first-style';

/** 淡出时长（ms）：与样式表里 data-closing 的 transition 对齐；reduced-motion 下不走这条。 */
const FADE_MS = 180;

/** The layer stylesheet as one string (one rule per array line, static-extractable). EVERY selector
 *  starts with `.sp-first` -- the host wrapper included (.sp-first-host) -- so nothing here can reach
 *  a panel, another overlay layer or the page.
 *
 *  2026-10-18 rewrite: the two-pane workbench (top bar / left 本机服务 / right 加入线上 / bottom strip)
 *  replaces the single centred card. Class names that other modules' tests still read
 *  (.sp-first__entry, .sp-first__btn, .sp-first__input, .sp-first__srv-row, .sp-first__code) are kept. */
function firstStyleCss() {
  return [
    // host wrapper: the layer owns its z-index in the ROOT stacking context.
    '.sp-first-host{position:relative;z-index:2147479000}',
    // the layer itself: fixed, never scrolls; own unit + own colour tokens.
    '.sp-first{box-sizing:border-box;position:fixed;inset:0;display:flex;flex-direction:column;overflow:hidden;',
    '--sp-f-u:var(--t,clamp(40px,min(calc(100vw / 19.2),calc(100vh / 10.8)),240px));',
    '--sp-f-mint:#4ed8af;--sp-f-mint-dim:#2a9e7f;',
    '--sp-f-line:#3e4b45;--sp-f-line-lo:#2a352f;',
    '--sp-f-hi:#f2f2f2;--sp-f-md:#c3cbc7;--sp-f-lo:#8a948f;--sp-f-dim:#5d6863;',
    '--sp-f-bk-l:calc(.14 * var(--sp-f-u));--sp-f-bk-w:2px;',
    'font-family:"Oxanium","Rajdhani",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
    'font-size:calc(.18 * var(--sp-f-u));line-height:1.5;color:var(--sp-f-md);',
    'background:radial-gradient(120% 80% at 50% 110%,rgba(23,249,183,.10),transparent 55%),radial-gradient(80% 60% at 50% 40%,rgba(40,60,52,.35),transparent 70%),linear-gradient(180deg,#0b0e0d 0%,#0e1311 55%,#0a0d0c 100%)}',
    // ---- background layers (kept from 2026-10-13: the reference site's glow / radar / sweep / target)
    '.sp-first__bg{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0}',
    '.sp-first__bg-glow{position:absolute;left:-10%;right:-10%;bottom:0;height:calc(6 * var(--sp-f-u));filter:blur(6px);animation:sp-first-glow 3.5s ease-in-out infinite alternate;',
    'background:radial-gradient(48% 42% at 50% 78%,rgba(23,249,183,.40),rgba(23,249,183,.08) 62%,transparent 76%),radial-gradient(26% 26% at 50% 80%,rgba(120,255,215,.30),transparent 70%)}',
    '@keyframes sp-first-glow{from{opacity:1}to{opacity:.78}}',
    '.sp-first__bg-radar{position:absolute;left:17%;top:40%;width:calc(5.6 * var(--sp-f-u));height:calc(5.6 * var(--sp-f-u));transform:translate(-50%,-50%);border-radius:50%;',
    'background:radial-gradient(circle,transparent 0 .05rem,rgba(78,216,175,.5) .05rem .065rem,transparent .065rem),repeating-radial-gradient(circle,transparent 0 .69rem,rgba(78,216,175,.16) .69rem .7rem),linear-gradient(rgba(78,216,175,.12),rgba(78,216,175,.12)) center / 100% 1px no-repeat,linear-gradient(rgba(78,216,175,.12),rgba(78,216,175,.12)) center / 1px 100% no-repeat;',
    'mask-image:radial-gradient(circle,#000 55%,transparent 71%);-webkit-mask-image:radial-gradient(circle,#000 55%,transparent 71%)}',
    '.sp-first__bg-sweep{position:absolute;inset:0;border-radius:50%;animation:sp-first-sweep 6s linear infinite;',
    'background:conic-gradient(from 0deg,rgba(23,249,183,.28),rgba(23,249,183,0) 22%,transparent 100%)}',
    '@keyframes sp-first-sweep{to{transform:rotate(360deg)}}',
    '.sp-first__bg-target{position:absolute;right:12%;top:22%;width:calc(1.3 * var(--sp-f-u));height:calc(1.3 * var(--sp-f-u));border-radius:50%;',
    'background:radial-gradient(circle,rgba(246,163,41,.9) 0 .06rem,transparent .065rem),radial-gradient(circle,transparent 0 .2rem,rgba(246,163,41,.5) .2rem .215rem,transparent .215rem)}',
    '@media (prefers-reduced-motion:reduce){.sp-first__bg-sweep,.sp-first__bg-glow{animation:none}}',
    // survey grid + scanlines + vignette
    '.sp-first::before{content:"";position:absolute;inset:0;pointer-events:none;z-index:0;',
    'background:linear-gradient(rgba(78,216,175,.045) 1px,transparent 1px) 0 0 / calc(.8 * var(--sp-f-u)) calc(.8 * var(--sp-f-u)),linear-gradient(90deg,rgba(78,216,175,.045) 1px,transparent 1px) 0 0 / calc(.8 * var(--sp-f-u)) calc(.8 * var(--sp-f-u));',
    'mask-image:radial-gradient(90% 80% at 50% 50%,#000 30%,transparent 85%);-webkit-mask-image:radial-gradient(90% 80% at 50% 50%,#000 30%,transparent 85%)}',
    '.sp-first::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:0;opacity:.9;',
    'background:repeating-linear-gradient(0deg,rgba(255,255,255,.016) 0 1px,transparent 1px 3px),radial-gradient(130% 100% at 50% 50%,transparent 55%,rgba(0,0,0,.65) 100%)}',
    // ---- top bar -------------------------------------------------------------------------------
    '.sp-first__top{position:relative;z-index:2;flex:0 0 auto;display:flex;align-items:center;gap:calc(.2 * var(--sp-f-u));',
    'padding:calc(.12 * var(--sp-f-u)) calc(.3 * var(--sp-f-u));border-bottom:1px solid var(--sp-f-line);background:rgba(10,13,12,.72);',
    '-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}',
    '.sp-first__brand{display:flex;align-items:center;gap:calc(.14 * var(--sp-f-u));min-width:0}',
    '.sp-first__brand-text{display:flex;flex-direction:column;min-width:0}',
    '.sp-first__emblem{flex:0 0 auto;display:flex;align-items:center;justify-content:center}',
    '.sp-first__emblem-svg{display:block;width:calc(.5 * var(--sp-f-u));height:auto;aspect-ratio:14 / 15}',
    '.sp-first__brand-en{font-size:calc(.1 * var(--sp-f-u));letter-spacing:.24em;color:var(--sp-f-dim);white-space:nowrap}',
    '.sp-first__brand-cn{font-size:calc(.26 * var(--sp-f-u));font-weight:900;letter-spacing:.06em;color:var(--sp-f-hi);line-height:1.15;white-space:nowrap}',
    '.sp-first__top-actions{margin-left:auto;display:flex;align-items:center;gap:calc(.1 * var(--sp-f-u));flex:0 0 auto}',
    '.sp-first__chip{display:inline-flex;align-items:center;gap:calc(.07 * var(--sp-f-u));min-height:max(calc(.34 * var(--sp-f-u)),30px);padding:0 calc(.12 * var(--sp-f-u));',
    'border:1px solid var(--sp-f-line);color:var(--sp-f-lo);font-size:calc(.13 * var(--sp-f-u));white-space:nowrap}',
    '.sp-first__chip.is-on{border-color:var(--sp-f-mint-dim);color:var(--sp-f-mint)}',
    '.sp-first__chip.is-bad{border-color:#e06c5a;color:#e06c5a}',
    // ---- two-pane workbench --------------------------------------------------------------------
    '.sp-first__body{position:relative;z-index:1;flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(0,.95fr) minmax(0,1.05fr);',
    'gap:calc(.24 * var(--sp-f-u));padding:calc(.26 * var(--sp-f-u)) calc(.3 * var(--sp-f-u));align-items:stretch;overflow:hidden}',
    '.sp-first__panel{position:relative;box-sizing:border-box;display:flex;flex-direction:column;min-height:0;min-width:0;',
    'background:linear-gradient(180deg,rgba(20,25,23,.82),rgba(10,13,12,.88));border:1px solid var(--sp-f-line);',
    '-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);box-shadow:0 calc(.2 * var(--sp-f-u)) calc(.5 * var(--sp-f-u)) rgba(0,0,0,.5)}',
    '.sp-first__panel::before{content:"";position:absolute;left:-1px;right:-1px;top:-1px;height:2px;background:linear-gradient(90deg,var(--sp-f-mint),transparent 62%)}',
    // the reference page's four L-shaped bracket corners (same drawing as the old card, now per pane)
    '.sp-first__panel::after{content:"";position:absolute;inset:-1px;pointer-events:none;',
    'background:linear-gradient(var(--sp-f-mint-dim),var(--sp-f-mint-dim)) top left / var(--sp-f-bk-l) var(--sp-f-bk-w) no-repeat,',
    'linear-gradient(var(--sp-f-mint-dim),var(--sp-f-mint-dim)) top left / var(--sp-f-bk-w) var(--sp-f-bk-l) no-repeat,',
    'linear-gradient(var(--sp-f-mint-dim),var(--sp-f-mint-dim)) bottom right / var(--sp-f-bk-l) var(--sp-f-bk-w) no-repeat,',
    'linear-gradient(var(--sp-f-mint-dim),var(--sp-f-mint-dim)) bottom right / var(--sp-f-bk-w) var(--sp-f-bk-l) no-repeat}',
    '.sp-first__panel-head{flex:0 0 auto;display:flex;align-items:baseline;gap:calc(.1 * var(--sp-f-u));padding:calc(.12 * var(--sp-f-u)) calc(.18 * var(--sp-f-u));',
    'border-bottom:1px solid var(--sp-f-line-lo);background:rgba(8,11,10,.5)}',
    '.sp-first__panel-title{font-size:calc(.22 * var(--sp-f-u));font-weight:800;letter-spacing:.04em;color:var(--sp-f-hi)}',
    '.sp-first__panel-micro{font-size:calc(.1 * var(--sp-f-u));letter-spacing:.2em;color:var(--sp-f-dim)}',
    '.sp-first__panel-body{flex:1 1 auto;min-height:0;overflow:auto;padding:calc(.16 * var(--sp-f-u)) calc(.18 * var(--sp-f-u));',
    'display:flex;flex-direction:column;gap:calc(.12 * var(--sp-f-u))}',
    // ---- status row ----------------------------------------------------------------------------
    '.sp-first__conn{display:flex;align-items:center;gap:calc(.1 * var(--sp-f-u));min-height:calc(.3 * var(--sp-f-u));font-size:calc(.15 * var(--sp-f-u));color:var(--sp-f-lo)}',
    '.sp-first__dot{flex:none;width:calc(.1 * var(--sp-f-u));height:calc(.1 * var(--sp-f-u));background:var(--sp-f-dim)}',
    '.sp-first__dot.is-on{background:var(--sp-f-mint)}',
    '.sp-first__dot.is-warn{background:#e0b64a}',
    '.sp-first__dot.is-bad{background:#e06c5a}',
    '.sp-first__status-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    // ---- buttons / inputs ----------------------------------------------------------------------
    '.sp-first__entry{box-sizing:border-box;display:flex;align-items:center;gap:calc(.1 * var(--sp-f-u));width:100%;',
    'min-height:max(calc(.56 * var(--sp-f-u)),42px);padding:0 calc(.16 * var(--sp-f-u));',
    'background:#121816;border:1px solid var(--sp-f-line);color:var(--sp-f-hi);font-family:inherit;font-size:calc(.2 * var(--sp-f-u));',
    'font-weight:700;letter-spacing:.04em;text-align:left;cursor:pointer}',
    '.sp-first__entry:not(:disabled):hover{border-color:var(--sp-f-mint);color:var(--sp-f-mint)}',
    '.sp-first__entry:disabled{opacity:.5;cursor:not-allowed}',
    '.sp-first__entry-micro{margin-left:auto;font-size:calc(.1 * var(--sp-f-u));font-weight:400;letter-spacing:.18em;text-transform:uppercase;color:var(--sp-f-dim);white-space:nowrap}',
    '.sp-first__btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:calc(.06 * var(--sp-f-u));white-space:nowrap;flex:0 0 auto;',
    'min-height:max(calc(.46 * var(--sp-f-u)),40px);padding:0 calc(.2 * var(--sp-f-u));background:#121816;border:1px solid var(--sp-f-line);',
    'color:var(--sp-f-hi);font-family:inherit;font-size:calc(.15 * var(--sp-f-u));cursor:pointer}',
    '.sp-first__btn:not(:disabled):hover{border-color:var(--sp-f-mint);color:var(--sp-f-mint)}',
    '.sp-first__btn:disabled{opacity:.45;cursor:not-allowed}',
    '.sp-first__btn--go{background:var(--sp-f-mint);border-color:var(--sp-f-mint);color:#04140f;font-weight:700}',
    '.sp-first__btn--go:not(:disabled):hover{color:#04140f;background:#59f4ca}',
    '.sp-first__btn--wide{width:100%}',
    '.sp-first__input{box-sizing:border-box;width:100%;min-width:0;height:max(calc(.46 * var(--sp-f-u)),40px);padding:0 calc(.12 * var(--sp-f-u));',
    'background:#0a0d0c;border:1px solid var(--sp-f-line);color:var(--sp-f-hi);font-family:inherit;font-size:calc(.17 * var(--sp-f-u));outline:none}',
    '.sp-first__input:focus{border-color:var(--sp-f-mint)}',
    '.sp-first__row{display:flex;align-items:center;gap:calc(.08 * var(--sp-f-u));min-width:0}',
    '.sp-first__row--online .sp-first__input{flex:1 1 0;width:auto}',
    '.sp-first__label{font-size:calc(.13 * var(--sp-f-u));letter-spacing:.12em;color:var(--sp-f-dim);text-transform:uppercase;white-space:nowrap}',
    // ---- room code + links ---------------------------------------------------------------------
    '.sp-first__code{font-size:calc(.24 * var(--sp-f-u));font-weight:800;letter-spacing:.18em;color:var(--sp-f-mint)}',
    '.sp-first__hint{font-size:calc(.14 * var(--sp-f-u));line-height:1.6;color:var(--sp-f-dim);overflow-wrap:anywhere}',
    '.sp-first__note{font-size:calc(.15 * var(--sp-f-u));color:var(--sp-f-mint);overflow-wrap:anywhere}',
    '.sp-first__error{font-size:calc(.14 * var(--sp-f-u));line-height:1.6;color:#e06c5a;overflow-wrap:anywhere}',
    // a clickable address line (click = copy that segment's link)
    '.sp-first__addr{display:block;cursor:pointer;color:var(--sp-f-hi);font-size:calc(.14 * var(--sp-f-u));line-height:1.7}',
    '.sp-first__addr code{font-size:calc(.14 * var(--sp-f-u));color:var(--sp-f-mint);word-break:break-all}',
    '.sp-first__addr:hover code{color:#59f4ca}',
    // ---- server list ---------------------------------------------------------------------------
    '.sp-first__srv{display:flex;flex-direction:column;gap:calc(.06 * var(--sp-f-u));flex:1 1 auto;min-height:0;min-width:0}',
    '.sp-first__srv-head{display:flex;align-items:center;gap:calc(.08 * var(--sp-f-u));min-width:0}',
    '.sp-first__srv-head .sp-first__label{margin-right:auto}',
    '.sp-first__srv-rows{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:calc(.06 * var(--sp-f-u));',
    'max-height:calc(4.4 * var(--sp-f-u));overflow-y:auto;overflow-x:hidden;min-width:0;min-height:0}',
    '.sp-first__srv-row{box-sizing:border-box;display:flex;align-items:center;gap:calc(.08 * var(--sp-f-u));min-width:0;width:100%;',
    'min-height:max(calc(.5 * var(--sp-f-u)),40px);padding:0 calc(.12 * var(--sp-f-u));background:rgba(8,11,10,.55);',
    'border:1px solid var(--sp-f-line);color:var(--sp-f-hi);font-family:inherit;font-size:calc(.17 * var(--sp-f-u));text-align:left;cursor:pointer}',
    '.sp-first__srv-row:hover{border-color:var(--sp-f-mint);color:var(--sp-f-mint)}',
    '.sp-first__srv-row.is-cur{border-color:var(--sp-f-mint);box-shadow:inset 0 0 0 1px rgba(78,216,175,.22)}',
    '.sp-first__srv-row.is-picked{border-color:var(--sp-f-mint);box-shadow:inset 0 0 0 1px rgba(78,216,175,.35)}',
    '.sp-first__srv-row.is-off{opacity:.45;cursor:default}',
    '.sp-first__srv-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sp-first__srv-ver{flex:0 0 auto;font-size:calc(.13 * var(--sp-f-u));color:var(--sp-f-lo);white-space:nowrap}',
    '.sp-first__srv-dot{flex:0 0 auto;width:calc(.1 * var(--sp-f-u));height:calc(.1 * var(--sp-f-u));border-radius:50%;background:var(--sp-f-lo)}',
    '.sp-first__srv-dot.is-ok{background:var(--sp-f-mint)}',
    '.sp-first__srv-dot.is-warn{background:#e0b64a}',
    '.sp-first__srv-dot.is-bad{background:#e06c5a}',
    '.sp-first__srv-dot.is-dead,.sp-first__srv-dot.is-off{background:var(--sp-f-dim)}',
    '.sp-first__srv-dot.is-unknown{background:var(--sp-f-lo)}',
    // ---- bottom strip: credits runner + 进入游戏 ------------------------------------------------
    '.sp-first__foot{position:relative;z-index:2;flex:0 0 auto;display:flex;align-items:center;gap:calc(.2 * var(--sp-f-u));',
    'padding:calc(.1 * var(--sp-f-u)) calc(.3 * var(--sp-f-u));border-top:1px solid var(--sp-f-line-lo);background:rgba(10,13,12,.72)}',
    '.sp-first__credits{flex:1 1 auto;min-width:0;overflow:hidden;height:calc(.48 * var(--sp-f-u));padding:calc(.04 * var(--sp-f-u)) 0;',
    'mask-image:linear-gradient(90deg,transparent 0,#000 6%,#000 94%,transparent 100%);-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 6%,#000 94%,transparent 100%)}',
    '.sp-first__roll{display:inline-flex;flex-direction:row;align-items:center;white-space:nowrap;will-change:transform;animation:sp-first-marquee 34s linear infinite}',
    '.sp-first__roll-copy{display:inline-flex;flex-direction:row;align-items:baseline}',
    '.sp-first__credit{display:inline-flex;align-items:baseline;gap:calc(.06 * var(--sp-f-u));padding:0 calc(.12 * var(--sp-f-u))}',
    '.sp-first__credit-name{font-size:calc(.16 * var(--sp-f-u));font-weight:700;letter-spacing:.03em;color:var(--sp-f-hi)}',
    '.sp-first__credit-name--lead{color:var(--sp-f-mint)}',
    '.sp-first__credit-pre{color:var(--sp-f-mint);font-weight:500}',
    '.sp-first__credit-role{font-size:calc(.1 * var(--sp-f-u));letter-spacing:.14em;color:var(--sp-f-lo)}',
    '.sp-first__credit-dot{color:var(--sp-f-mint-dim)}',
    '@keyframes sp-first-marquee{from{transform:translate3d(0,0,0)}to{transform:translate3d(-25%,0,0)}}',
    '@media (prefers-reduced-motion:reduce){.sp-first__roll{animation:none}}',
    // 进入游戏 = the reference page's 回游戏: bottom-right, outlined, never the loudest thing in a
    // workbench that has two working entries above it.
    '.sp-first__enter{position:relative;box-sizing:border-box;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:calc(.1 * var(--sp-f-u));',
    'min-width:calc(3.2 * var(--sp-f-u));min-height:max(calc(.56 * var(--sp-f-u)),44px);padding:0 calc(.26 * var(--sp-f-u));',
    'background:#121816;border:1px solid var(--sp-f-mint);color:var(--sp-f-mint);font-family:inherit;',
    'font-size:calc(.22 * var(--sp-f-u));font-weight:700;letter-spacing:.16em;cursor:pointer}',
    '.sp-first__enter:hover{background:rgba(78,216,175,.12)}',
    '.sp-first__enter-chev{font-size:calc(.2 * var(--sp-f-u))}',
    // ---- narrow screens: stack the panes -------------------------------------------------------
    '@media (max-width:820px){.sp-first__body{grid-template-columns:minmax(0,1fr);overflow:auto;gap:calc(.16 * var(--sp-f-u))}',
    '.sp-first__panel{min-height:calc(3.4 * var(--sp-f-u))}',
    '.sp-first__top{padding:calc(.1 * var(--sp-f-u)) calc(.16 * var(--sp-f-u))}',
    '.sp-first__foot{padding:calc(.08 * var(--sp-f-u)) calc(.16 * var(--sp-f-u))}',
    '.sp-first__enter{min-width:calc(2.2 * var(--sp-f-u));letter-spacing:.08em}',
    '.sp-first__srv-rows{max-height:calc(3.2 * var(--sp-f-u))}}',
    '@media (max-height:520px){.sp-first__body{padding:calc(.14 * var(--sp-f-u)) calc(.18 * var(--sp-f-u))}',
    '.sp-first__panel-body{padding:calc(.1 * var(--sp-f-u)) calc(.12 * var(--sp-f-u))}',
    '.sp-first__srv-rows{max-height:calc(2.4 * var(--sp-f-u))}}',
    // entrance / exit (unchanged semantics: a second click during the fade must not reach a button)
    '.sp-first{animation:sp-first-in 220ms cubic-bezier(.2,.7,.3,1) both}',
    '.sp-first-host[data-closing="1"] .sp-first{animation:none;opacity:0;transition:opacity 170ms ease;pointer-events:none}',
    '@keyframes sp-first-in{from{opacity:0;transform:translate3d(0,calc(.06 * var(--sp-f-u)),0)}to{opacity:1;transform:none}}',
    '@media (prefers-reduced-motion:reduce){.sp-first{animation:none}.sp-first-host[data-closing="1"] .sp-first{transition:none}}',
  ].join('');
}

/** One-shot injector (idempotent on #sp-first-style). No DOM / no head -> silent no-op, never throws. */
export function injectFirstScreenStyles() {
  try {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
    if (typeof document.getElementById === 'function' && document.getElementById(STYLE_ID)) return true;
    const el = document.createElement('style');
    el.setAttribute('id', STYLE_ID);
    el.textContent = firstStyleCss();
    const head = document.head || document.documentElement;
    if (!head || typeof head.appendChild !== 'function') return false;
    head.appendChild(el);
    return true;
  } catch (e) { return false; }
}

// ---- live repaint (ready state + room code + addresses arrive while the layer is open) -----------
/** Same shape as ui/preloadPanel.js' useTick (kept local: each overlay module resolves the kit's
 *  hooks for itself, and this layer must not import a panel). */
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

/** A credit entry: bold name (mint prefix) + small role + separator dot. */
function creditItem(it, key) {
  return html`<span class="sp-first__credit" key=${key}>
    <span class=${it.lead ? 'sp-first__credit-name sp-first__credit-name--lead' : 'sp-first__credit-name'}>${it.pre ? html`<span class="sp-first__credit-pre">${it.pre}</span>` : null}${it.label}</span>
    ${it.role ? html`<span class="sp-first__credit-role">${it.role}</span>` : null}
    <span class="sp-first__credit-dot">·</span>
  </span>`;
}

// 点阵徽记（形状逐字取自 screens/title.js 的 EMBLEM；本层自带样式，不依赖上游 CSS）。
const FIRST_EMBLEM = [
  'XXX..XXX..XXX', 'XXX..XXX..XXX', 'XXXXXXXXXXXXX', '.XXXXXXXXXXX.', '..XXXXXXXXX..',
  '..XXXXXXXXX..', '..XXXX.XXXX..', '..XXXX.XXXX..', '..XXXXXXXXX..', '..XXXXXXXXX..',
  '..XXXXXXXXX..', '.XXXXXXXXXXX.', 'XXXXXXXXXXXXX', 'XXXXXXXXXXXXX',
];
/** 徽记：点阵 SVG（r6/r7 的第 5、7 列是 mint 强调点 —— 上游同款）。 */
function FirstEmblem() {
  const dots = [];
  FIRST_EMBLEM.forEach(function (row, r) {
    row.split('').forEach(function (ch, c) {
      if (ch !== 'X') return;
      const rad = 0.2 + (r / (FIRST_EMBLEM.length - 1)) * 0.2;
      const accent = (r === 6 || r === 7) && (c === 5 || c === 7);
      dots.push({ cx: c + 0.5, cy: r + 0.5, r: rad, accent: accent, d: (r * 13 + c) % 7 });
    });
  });
  return html`<div class="sp-first__emblem" aria-hidden="true">
    <svg class="sp-first__emblem-svg" viewBox="-0.5 -0.5 14 15" width="26" height="28">
      ${dots.map(function (d, i) { return html`<circle key=${i} cx=${d.cx} cy=${d.cy} r=${d.r} fill=${d.accent ? '#4ed8af' : 'rgba(205,214,209,.62)'} />`; })}
    </svg>
  </div>`;
}

// ---- the layer ----------------------------------------------------------------------------------
/** The host's READY flag (window.shell.localServiceReady). false on a plain page / an old shell. */
function localReady() {
  try {
    const sh = shell();
    if (!sh || typeof sh.localServiceReady !== 'function') return false;
    const v = sh.localServiceReady();
    return v === true || String(v) === '1';
  } catch (e) { return false; }
}

/** The node's own failure reason (window.shell.localServiceError), '' when there is none. */
function localError() {
  try {
    const sh = shell();
    if (!sh || typeof sh.localServiceError !== 'function') return '';
    const v = sh.localServiceError();
    return (v == null) ? '' : String(v);
  } catch (e) { return ''; }
}

/** Copy <base>/?room=CODE when a room exists, else the bare <base>/ (ready but no room yet). */
function copyLocalLink(ctx) {
  const code = currentRoomCode();
  if (code) return copyRoomLink(ctx);
  const base = localBase();
  if (!base) { if (ctx && ctx.say) ctx.say('尚未取得本机地址，请稍后再试'); return false; }
  const url = base.replace(/\/+$/, '') + '/';
  copyText(url).then(function (ok) {
    if (ctx && ctx.say) ctx.say(ok ? '已复制本机链接：' + url : '复制失败，请手动复制：' + url);
  });
  return true;
}

/** props.onClose: leave the layer (进入游戏 / Esc / the host API). Everything else is read live from
 *  the bridge through ui/connect-core.js -- this component paints and delegates, it owns no logic. */
export function FirstScreen(props) {
  const done = (props && typeof props.onClose === 'function') ? props.onClose : function () {};
  const noteState = useState('');
  const note = noteState[0];
  const setNote = noteState[1];
  const pickedState = useState(null);   // null | 'local' | 'online'
  const pick = pickedState[0];
  const setPick = pickedState[1];
  const targetRowState = useState(null);
  const targetRow = targetRowState[0];
  const setTargetRow = targetRowState[1];
  const addrState = useState('');
  const addr = addrState[0];
  const setAddr = addrState[1];
  const srvState = useState(null);
  const srv = srvState[0];
  const setSrv = srvState[1];
  // The start request lives until READY (or until an error shows up): the pane then says 「启动中…」
  // instead of flipping back to 「未启动」, which is what the old one-shot toast did.
  const startingState = useState(false);
  const starting = startingState[0];
  const setStarting = startingState[1];
  // 2026-10-18 审计 C1：starting 原来没有复位点 —— 旧壳没有 localServiceError 时会永久停在
  // 「启动中…」。记下发起时刻，超时后如实说「超时」并允许重试（不假装还在进行）。
  const startAtState = useState(0);
  const startAt = startAtState[0];
  const setStartAt = startAtState[1];
  useTick();

  function readServerListInline() {
    let out = { entries: [], updated: 0, current: '', loading: false };
    try {
      if (window.shell && typeof window.shell.getServerList === 'function') {
        const o = JSON.parse(window.shell.getServerList());
        if (o && Array.isArray(o.entries)) out = Object.assign(out, o);
      } else if (window.__SP_SHELL && typeof window.__SP_SHELL.getServers === 'function') {
        const r = window.__SP_SHELL.getServers();
        const arr = typeof r === 'string' ? JSON.parse(r) : r;
        if (Array.isArray(arr)) out.entries = arr;
      }
    } catch (e) { /* ignore: 拿不到就显示空态 */ }
    return out;
  }

  // 服务器清单：进层读一次 + sp-servers 事件保持新鲜（与 shellPanels 面板同一份数据）。
  useEffect(function () {
    setSrv(readServerListInline());
    // node 只在玩家进入本机服务时启动（2026-10-17 口径）：这里**不**预热，只刷新清单。
    const native = typeof window !== 'undefined' && window.shell && typeof window.shell.setServer === 'function';
    if (native && window.shell.refreshServerList) { try { window.shell.refreshServerList(); } catch (e) { /* ignore */ } }
    const onServers = function (e) { try { setSrv(Object.assign({}, readServerListInline(), JSON.parse(e.detail))); } catch (err) { /* ignore */ } };
    window.addEventListener('sp-servers', onServers);
    return function () { window.removeEventListener('sp-servers', onServers); };
  }, []);

  useEffect(function () {
    function onKey(e) {
      const k = e && (e.key || e.code);
      if (k === 'Escape' || k === 'Esc' || (e && e.keyCode === 27)) done();
    }
    try { if (typeof window !== 'undefined') window.addEventListener('keydown', onKey); } catch (e) { /* no window */ }
    return function () {
      try { if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey); } catch (e) { /* ignore */ }
    };
  }, []);

  const say = function (m) { if (m) setNote(String(m)); };
  const sayToast = function (m) { try { toast(m); } catch (e) { /* no kit */ } };
  const ctx = { say: say, toast: sayToast, onClose: function () { done(); } };
  // Starting from the pane must NOT close the layer: the native side keeps this page until the host
  // is ready, and the READY transition is exactly what reveals the link below.
  const startCtx = { say: say, toast: sayToast };

  const native = !!shell();
  const ready = localReady();
  const err = localError();
  const room = currentRoomCode();
  const base = localBase();

  // 名单：先用内嵌常量渲染（秒开），再**静默**拉线上覆盖 —— 拿不到就保持兜底，不提示、不报错。
  const creditsState = useState(creditList());
  const credits = creditsState[0];
  const setCredits = creditsState[1];
  useEffect(function () {
    let alive = true;
    fetchCredits().then(function (list) { if (alive && list && list.length) setCredits(list); });
    return function () { alive = false; };
  }, []);

  const srvAll = srv && Array.isArray(srv.entries) ? srv.entries : [];
  const srvList = visibleServers(srvAll.filter(function (e) {
    return e && typeof e === 'object' && !e.roomScoped && e.id !== 'local' && e.id !== 'auto';
  }));
  const srvLoading = !!(srv && srv.loading === true);

  // 状态一行：失败 > 就绪 > 启动中 > 未启动。误差优先（有 error 时 ready 不该为真）。
  // 240 s 覆盖「解包 180 s + Node 60 s」的硬上限；过点仍未就绪就如实说超时，别让它永远转。
  const STALL_MS = 240000;
  const stalled = !!(starting && !ready && !err && startAt > 0 && (Date.now() - startAt) > STALL_MS);
  const statusTone = err ? 'is-bad' : ready ? 'is-on' : (starting ? 'is-warn' : '');
  const statusText = err
    ? '本机服务启动失败'
    : ready
      ? ('本机服务已就绪' + (base ? ' · ' + base : ''))
      : stalled
        ? '本机服务启动超时（后台可能仍在尝试）'
        : (starting ? '本机服务启动中…（首次启动要解包资源，请稍候）' : '本机服务未启动');

  // 地址行：每段一个可点复制的链接（ready 之前不显示 —— 那时地址表还没有端口）。
  const addrLine = function (kind) {
    const o = localAddresses();
    const label = kind === 'zt' ? '虚拟局域网' : kind === 'v6' ? 'IPv6' : '局域网';
    if (!o) return null;
    const v = typeof o[kind] === 'string' ? o[kind].replace(/\/+$/, '') : '';
    if (!v) return null;
    const url = room ? v + '/?room=' + room : v + '/';
    return html`<span class="sp-first__addr" title=${'点击复制 ' + url}
      onClick=${function () { copySegmentLink(kind, ctx); }}>${label} <code>${url}</code></span>`;
  };
  const addrRows = ready ? [addrLine('zt'), addrLine('lan'), addrLine('v6')].filter(Boolean) : [];

  const startLocalNow = function () {
    setPick('local');
    setTargetRow(null);
    if (ready) { startLocal(ctx); return; }   // already up: this click enters it
    setStarting(true);
    setStartAt(Date.now());
    // 2026-10-18: start the host WITHOUT switching origin, so this pane can show 「已就绪 + 复制链接」
    // the moment node answers. Old APKs have no such bridge -> startLocal() (it switches on ready).
    const sh = shell();
    if (sh && typeof sh.startLocalHostOnly === 'function') {
      try { if (sh.startLocalHostOnly()) return; } catch (e) { /* fall through */ }
    }
    startLocal(startCtx);
  };

  return html`<div class="sp-first">
    <div class="sp-first__bg" aria-hidden="true">
      <div class="sp-first__bg-glow"></div>
      <div class="sp-first__bg-radar"><div class="sp-first__bg-sweep"></div></div>
      <div class="sp-first__bg-target"></div>
    </div>

    <!-- 顶栏（参考工作台：左品牌 / 右状态），与两条入口同屏，不再是大标题压住整个页面。 -->
    <header class="sp-first__top">
      <div class="sp-first__brand">
        <${FirstEmblem} />
        <div class="sp-first__brand-text">
          <span class="sp-first__brand-en">STRONGHOLD PROTOCOL · ALLIANCE</span>
          <span class="sp-first__brand-cn">卫戍协议：盟约</span>
        </div>
      </div>
      <div class="sp-first__top-actions">
        <span class=${'sp-first__chip' + (statusTone === 'is-on' ? ' is-on' : statusTone === 'is-bad' ? ' is-bad' : '')}
          title=${statusText}>
          <span class=${'sp-first__dot ' + (statusTone || '')}></span>${err ? '启动失败' : ready ? '本机服务就绪' : starting ? '启动中' : '未启动'}
        </span>
      </div>
    </header>

    <div class="sp-first__body">
      <!-- 左：本机服务 -->
      <section class="sp-first__panel">
        <div class="sp-first__panel-head">
          <span class="sp-first__panel-title">本机服务</span>
          <${MicroLabel} class="sp-first__panel-micro">LOCAL SERVICE<//>
        </div>
        <div class="sp-first__panel-body">
          <div class="sp-first__conn">
            <span class=${'sp-first__dot ' + (statusTone || '')}></span>
            <span class="sp-first__status-text">${statusText}</span>
          </div>
          ${err ? html`<span class="sp-first__error">${err}</span>` : null}
          ${err ? html`<span class="sp-first__hint">根因在设备日志 run/server.log（App 数据目录）里；把最近几行发给开发者可定位。</span>` : null}

          <button type="button" class=${'sp-first__btn sp-first__btn--go sp-first__btn--wide'}
            disabled=${!native || (starting && !ready && !err && !stalled)}
            onClick=${startLocalNow}>${ready ? '进入本机服务' : (err || stalled ? '重试启动' : (starting ? '启动中…' : '启动本机服务'))}</button>
          ${stalled ? html`<span class="sp-first__error">启动超时：240 秒内没有拿到就绪握手。可以点「重试启动」；若反复超时，把 run/server.log 最近几行发给开发者。</span>` : null}

          ${ready ? html`
            <div class="sp-first__row">
              <span class="sp-first__label">房间</span>
              ${room
                ? html`<span class="sp-first__code">${room}</span>`
                : html`<span class="sp-first__hint">房间尚未创建（进入游戏后自动生成邀请码）</span>`}
              <button type="button" class="sp-first__btn" style="margin-left:auto"
                onClick=${function () { copyLocalLink(ctx); }}>复制链接</button>
            </div>
            ${addrRows.length ? html`<div class="sp-first__row" style="flex-direction:column;align-items:stretch;gap:.04rem">${addrRows}</div>` : null}
            <span class="sp-first__hint">把链接发给同一局域网 / 虚拟局域网里的同伴，对方在「加入线上」粘贴即可。</span>
          ` : html`
            <span class="sp-first__hint">启动后会在本机运行内置 Node 服务，并生成可分享的邀请链接；首次启动需要解包资源，可能要等一会儿。</span>
            <span class="sp-first__hint">服务未就绪前不显示复制链接 —— 那时端口还没分配，复制出去的地址会打不开。</span>
          `}
        </div>
      </section>

      <!-- 右：加入线上 -->
      <section class="sp-first__panel">
        <div class="sp-first__panel-head">
          <span class="sp-first__panel-title">加入线上</span>
          <${MicroLabel} class="sp-first__panel-micro">ONLINE<//>
        </div>
        <div class="sp-first__panel-body">
          <div class="sp-first__row sp-first__row--online">
            <input class="sp-first__input" type="text" value=${addr} placeholder="输入服务器地址（如 example.com）"
              onInput=${function (e) { setAddr(e && e.currentTarget ? e.currentTarget.value : ''); }}
              onKeyDown=${function (e) { if (e && (e.key === 'Enter' || e.keyCode === 13)) joinCustom(addr, ctx); }} />
            <button type="button" class="sp-first__btn sp-first__btn--go"
              onClick=${function () { setPick('online'); setTargetRow(null); joinCustom(addr, ctx); }}>连接</button>
          </div>

          <div class="sp-first__srv">
            <div class="sp-first__srv-head">
              <span class="sp-first__label">服务器清单</span>
              <button type="button" class="sp-first__btn" onClick=${function () {
                try { if (window.shell && window.shell.refreshServerList) window.shell.refreshServerList(); } catch (e) { /* ignore */ }
                setSrv(readServerListInline());
              }}>刷新</button>
            </div>
            <div class="sp-first__srv-rows">
              ${srvList.length ? srvList.map(function (e) {
                const id = e.id || e.name;
                return html`<button key=${id} type="button" class=${'sp-first__srv-row' + (e.current ? ' is-cur' : '') + (e.enabled === false ? ' is-off' : '') + (pick === 'online' && targetRow && (targetRow.id || targetRow.name) === id ? ' is-picked' : '')}
                  disabled=${e.enabled === false}
                  onClick=${function () { setPick('online'); setTargetRow(e); }}>
                  <span class="sp-first__srv-name">${e.name}</span>
                  ${e.app ? html`<span class="sp-first__srv-ver">${e.app}</span>` : null}
                  <span class=${'sp-first__srv-dot is-' + serverLevel(e) + (e.current ? ' is-cur' : '')}></span>
                </button>`;
              }) : html`<p class="sp-first__hint" style="grid-column:1 / -1">${srvLoading ? '正在加载…' : '暂无可用服务器'}</p>`}
            </div>
            ${pick === 'online' && targetRow ? html`<button type="button"
              class="sp-first__btn sp-first__btn--go sp-first__btn--wide"
              onClick=${function () { joinServerRow(targetRow, ctx); }}>加入「${targetRow.name || targetRow.id}」</button>` : null}
          </div>

          ${note ? html`<span class="sp-first__note">${note}</span>` : null}
          ${!native ? html`<span class="sp-first__hint">当前是网页版：本机服务不可用，只能加入已有服务器。</span>` : null}
        </div>
      </section>
    </div>

    <footer class="sp-first__foot">
      <div class="sp-first__credits">
        <div class="sp-first__roll">
          ${CREDIT_COPIES.map(function (c) {
            return html`<span class="sp-first__roll-copy" key=${'copy' + c}>${credits.map(function (it, i) {
              return creditItem(it, 'f' + c + '-' + i);
            })}</span>`;
          })}
        </div>
      </div>
      <button type="button" class="sp-first__enter"
        onClick=${function () {
          if (pick === 'local') { startLocal(ctx); return; }
          if (pick === 'online') { if (targetRow) { joinServerRow(targetRow, ctx); return; } joinCustom(addr, ctx); return; }
          done();
        }}>
        进入游戏<span class="sp-first__enter-chev">»</span>
      </button>
    </footer>
  </div>`;
}

// ---- host + open/close ---------------------------------------------------------------------------
const HOST_ID = 'sp-first-host';
let HOST = null;
let OPEN_SEQ = 0;   // bumped by open()/close(): a draw that is still waiting on the kit is dropped
let DEPS_OK = false; // the kit resolved (or shims were kept): renders are safe from here on
let KIT_OK = false;  // the kit really can render (html + render): otherwise open() reports failure

/** The layer's host: ONE div, attached to documentElement (the ROOT stacking context). */
function hostNode() {
  try {
    if (typeof document === 'undefined' || !document.documentElement) return null;
    if (HOST && HOST.parentNode) return HOST;
    const existing = (typeof document.getElementById === 'function') ? document.getElementById(HOST_ID) : null;
    if (existing) { HOST = existing; return existing; }
    const el = document.createElement('div');
    el.setAttribute('id', HOST_ID);
    el.setAttribute('class', 'sp-first-host');
    document.documentElement.appendChild(el);
    HOST = el;
    return el;
  } catch (e) { return null; }
}

/** Show the first interface (idempotent). false = no DOM to draw into (an old engine / a test). */
export function openFirstScreen() {
  const el = hostNode();
  if (!el) return false;
  if (DEPS_OK && !KIT_OK) { drawBootFallback(el); return false; }
  injectFirstScreenStyles();
  OPEN_SEQ += 1;
  const seq = OPEN_SEQ;
  try { el.setAttribute('data-open', '1'); } catch (e) { /* ignore */ }
  const draw = function () {
    if (seq !== OPEN_SEQ) return false;
    if (!KIT_OK) { try { el.setAttribute('data-open', '0'); } catch (e) { /* ignore */ } return false; }
    return drawFirstScreen(el);
  };
  if (DEPS_OK) return draw();
  try { depsReady.then(draw, draw); } catch (e) { return draw(); }
  return true;
}

/** 无渲染器兜底（业主 2026-10-16「首页不能黑屏」）：纯 DOM 画一张最小启动层。 */
function drawBootFallback(el) {
  try {
    if (el.getAttribute('data-boot') === '1') return;
    el.setAttribute('data-boot', '1');
    el.setAttribute('data-open', '1');
    const bar = document.createElement('div');
    bar.setAttribute('style', 'position:fixed;inset:0;z-index:2147479000;background:#0C0F0E;'
      + 'display:flex;flex-direction:column;align-items:center;justify-content:center;'
      + 'font-family:sans-serif;gap:14px');
    const title = document.createElement('div');
    title.setAttribute('style', 'color:#4ED8AF;font-size:22px;letter-spacing:2px');
    title.textContent = '卫戍协议 · 盟约';
    const text = document.createElement('div');
    text.setAttribute('style', 'color:#8A9A93;font-size:13px');
    text.textContent = '正在启动…';
    const track = document.createElement('div');
    track.setAttribute('style', 'width:220px;height:6px;border-radius:3px;background:#3E4B45;overflow:hidden');
    const fill = document.createElement('div');
    fill.setAttribute('style', 'width:40%;height:100%;border-radius:3px;background:#4ED8AF;'
      + 'animation:spboot 1.1s ease-in-out infinite alternate');
    const keyframes = document.createElement('style');
    keyframes.textContent = '@keyframes spboot{from{margin-left:0;width:40%}to{margin-left:60%;width:40%}}';
    track.appendChild(fill);
    bar.appendChild(keyframes);
    bar.appendChild(title);
    bar.appendChild(text);
    bar.appendChild(track);
    el.appendChild(bar);
  } catch (e) { /* 兜底层失败就放弃：与旧行为一致 */ }
}

function drawFirstScreen(el) {
  try {
    render(html`<${FirstScreen} onClose=${closeFirstScreen} />`, el);
    return true;
  } catch (e) { return false; }
}

/** Leave the first interface. The layer is unmounted (not hidden). */
export function closeFirstScreen() {
  OPEN_SEQ += 1; // any draw still waiting on the kit is cancelled
  const el = HOST;
  if (!el) return true;
  const seq = OPEN_SEQ;
  const unmount = function () {
    if (seq !== OPEN_SEQ) return;
    try { render(null, el); } catch (e) { /* shim / no renderer */ }
    try { el.removeAttribute('data-closing'); el.setAttribute('data-open', '0'); } catch (e) { /* ignore */ }
  };
  if (reduceMotion()) { unmount(); return true; }
  try { el.setAttribute('data-closing', '1'); } catch (e) { /* ignore */ }
  setTimeout(unmount, FADE_MS);
  return true;
}

/** 是否应当跳过动效：系统 prefers-reduced-motion，或壳设置里的 reduceMotion。 */
function reduceMotion() {
  try {
    if (typeof window !== "undefined" && window.__SP_PREFS && window.__SP_PREFS.reduceMotion === true) return true;
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

export function firstScreenVisible() {
  try {
    return !!(HOST && HOST.getAttribute('data-open') === '1' && !HOST.getAttribute('data-closing'));
  } catch (e) { return false; }
}

export function toggleFirstScreen() {
  return firstScreenVisible() ? closeFirstScreen() : openFirstScreen();
}

async function init() {
  await loadDeps();
  DEPS_OK = true;
  injectFirstScreenStyles();
}

// Synchronous marker: shell-bridge.js checks it so a re-run never injects this module twice.
try {
  if (typeof window !== 'undefined') {
    window.__SP_FIRST_SCREEN = true;
    window.__SP_FIRST = {
      open: openFirstScreen,
      close: closeFirstScreen,
      toggle: toggleFirstScreen,
      visible: firstScreenVisible,
    };
  }
} catch (e) { /* no window (tests) / read-only window */ }

/** Dependency-resolution signal (tests await it before reading the layer). */
export const depsReady = init();
export function whenDepsReady() { return depsReady; }
