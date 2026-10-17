/* global window, document */
// js/first-screen.js -- THE FULL-SCREEN FIRST INTERFACE (owner 2026-10-13: 「第一界面改为全屏，优先
// 为本机服务局域网和加入线上（叠加层）」). It is an OVERLAY LAYER: it paints above the upstream title
// screen (and above every page the shell reaches) and, like every other shell layer, it is closable --
// 「进入游戏」 / Esc / window.__SP_FIRST.close() -- so the title screen's own entry (代号 + 开始), its
// language menu, its settings gear and its footer stay reachable the moment the player leaves.
//
// WHERE THE THREE ENTRIES COME FROM (they are NOT a second implementation):
//   · 本机服务   -> ui/connect-core.js startLocal()   (was preloadPanel.js 进入本地服务)
//   · 局域网     -> ui/connect-core.js scanLan()      (was preloadPanel.js 扫描 + joinLan)
//   · 加入线上   -> ui/connect-core.js joinCustom()   (was preloadPanel.js 地址输入 + 连接)
//                   + the shell's own 服务器列表 panel (openPanel('servers'))
// The owner took that whole block out of the floating window, so these functions were MOVED (not
// copied) into ui/connect-core.js: one body, one behaviour, two UIs can never disagree. This file only
// draws them and owns the layer.
//
// LOOK (owner: 「参考样式参考站点，Paper-Yuan 布局按他的来」):
//   · layout   Paper-Yuan's title screen: ONE single-column card (the .title-login idiom -- width
//              ~4.9rem, .24/.28/.2rem padding, .16rem gap, a 1px #3e4b45 border over a near-black
//              gradient, blur(4px), and the 2px mint hairline across the top edge drawn by ::before).
//              The three entries are rows INSIDE that card,中文大字 + 英文 micro, and the two that need
//              a second step (局域网 / 加入线上) expand in place (no second window).
//   · tokens   the reference site's own tokens, taken with a var() fallback so the layer looks the
//              same on our pages (which define them) and on a third-party page (which does not):
//              --mint-500 #4ed8af / --line-2 #3e4b45 / --text-hi #f2f2f2 / --text-md #c3cbc7 /
//              --text-lo #8a948f / --text-dim #5d6863. The nine homebrew hexes the older overlay used
//              (#67d9b5 / #3d7463 / #45685d / #1e2823 / #889894 / #2f8f76 / #1d2825 / #8c9c96 /
//              #6c7a74) do not appear here at all.
//   · texture  hard corners everywhere (no border-radius), the four L-shaped bracket corners, and the
//              panel scanline texture (repeating-linear-gradient(0deg, rgba(255,255,255,.016) 0 1px,
//              transparent 1px 3px)) over the backdrop.
//   · scale    the layer carries its own unit -- see --sp-f-u below -- so a full-screen layout is
//              correct even on a page that never loaded the game's theme.css.
//
// 感谢名单 runs along the BOTTOM, horizontally (right -> left), four identical copies in one row with
// translateX(-25%) -- the same seam-free trick the window's vertical runner uses, rotated, and the
// same real data (ui/credits.js).
//
// LAYER ORDER (ui/shellPanels.js publishes the scale: notice 2147480000 / panel host 2147481000 /
// modal 2147482000 / toast 2147483000 / chip 2147483647). This layer sits BELOW the panel host on
// purpose: a panel opened from here (服务器列表) or by an entry (预载提示) must paint ON TOP of it.
//
// Contract: ESM + htm, no page module, no network, degrades to shims (never throws) when the kit is
// absent, idempotent (window.__SP_FIRST_SCREEN guards the injection in shell-bridge.js).

import { CREDIT_COPIES, creditList, fetchCredits } from './ui/credits.js';
import {
  shell, openPanel, currentRoomCode, localBase, lanSupported, onLanScan, lanNote,
  lanRoomKey, lanRoomLabel, scanLan, joinLan, startLocal, joinCustom, joinServerRow, copyRoomLink,
  copySegmentLink, localAddresses, serverLevel, visibleServers,
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
 *  a panel, another overlay layer or the page. */
function firstStyleCss() {
  return [
    // host wrapper: the layer owns its z-index in the ROOT stacking context (inline style would break
    // the "all selectors are .sp-first*" rule, so the number lives here).
    '.sp-first-host{position:relative;z-index:2147479000}',
    // the layer itself: fixed, never scrolls (owner: 整页不可滚动), own unit + own colour tokens.
    // --sp-f-u: our OWN scale, so the layer is right even where the game theme never loaded. On our
    // pages --t is 1rem (= the theme's html clamp), so the value is exactly the design system's.
    // 业主 2026-10-13：背景照参考站 dl.jiangjiangze.icu 的 .app-bg（数值逐字抄）——
    // ① 三渐变底 ② 勘测网格（.8rem 双方向 + 径向遮罩）③ 扫描线 + 暗角。
    '.sp-first{box-sizing:border-box;position:fixed;inset:0;display:flex;flex-direction:column;overflow:hidden;',
    '--sp-f-u:var(--t,clamp(40px,min(calc(100vw / 19.2),calc(100vh / 10.8)),240px));',
    '--sp-f-mint:#4ed8af;--sp-f-mint-dim:#2a9e7f;',
    '--sp-f-line:#3e4b45;--sp-f-line-lo:#2f3a35;',
    '--sp-f-hi:#f2f2f2;--sp-f-md:#c3cbc7;--sp-f-lo:#8a948f;--sp-f-dim:#5d6863;',
    '--sp-f-bk-l:calc(.14 * var(--sp-f-u));--sp-f-bk-w:2px;',
    'font-family:"Oxanium","Rajdhani",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
    'font-size:calc(.18 * var(--sp-f-u));line-height:1.5;color:var(--sp-f-md);',
    'background:radial-gradient(120% 80% at 50% 110%,rgba(23,249,183,.10),transparent 55%),radial-gradient(80% 60% at 50% 40%,rgba(40,60,52,.35),transparent 70%),linear-gradient(180deg,#0b0e0d 0%,#0e1311 55%,#0a0d0c 100%)}',
    // ---- 背景图层（参考站 screens/title.css 的 .title-bg*，数值逐条抄；rem → calc(N * --sp-f-u)）----
    '.sp-first__bg{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0}',
    // .title-bg__glow：底部薄荷辉光 + 呼吸
    '.sp-first__bg-glow{position:absolute;left:-10%;right:-10%;bottom:0;height:calc(6 * var(--sp-f-u));filter:blur(6px);animation:sp-first-glow 3.5s ease-in-out infinite alternate;',
    'background:radial-gradient(48% 42% at 50% 78%,rgba(23,249,183,.40),rgba(23,249,183,.08) 62%,transparent 76%),radial-gradient(26% 26% at 50% 80%,rgba(120,255,215,.30),transparent 70%)}',
    '@keyframes sp-first-glow{from{opacity:1}to{opacity:.78}}',
    // .title-bg__radar：同心环 + 十字准线，圆形遮罩淡出
    '.sp-first__bg-radar{position:absolute;left:17%;top:40%;width:calc(5.6 * var(--sp-f-u));height:calc(5.6 * var(--sp-f-u));transform:translate(-50%,-50%);border-radius:50%;',
    'background:radial-gradient(circle,transparent 0 .05rem,rgba(78,216,175,.5) .05rem .065rem,transparent .065rem),repeating-radial-gradient(circle,transparent 0 .69rem,rgba(78,216,175,.16) .69rem .7rem),linear-gradient(rgba(78,216,175,.12),rgba(78,216,175,.12)) center / 100% 1px no-repeat,linear-gradient(rgba(78,216,175,.12),rgba(78,216,175,.12)) center / 1px 100% no-repeat;',
    'mask-image:radial-gradient(circle,#000 55%,transparent 71%);-webkit-mask-image:radial-gradient(circle,#000 55%,transparent 71%)}',
    // .title-bg__sweep：锥形扫描，6s 一圈
    '.sp-first__bg-sweep{position:absolute;inset:0;border-radius:50%;animation:sp-first-sweep 6s linear infinite;',
    'background:conic-gradient(from 0deg,rgba(23,249,183,.28),rgba(23,249,183,0) 22%,transparent 100%)}',
    '@keyframes sp-first-sweep{to{transform:rotate(360deg)}}',
    // .title-bg__target：右上琥珀色目标点 + 脉冲环
    '.sp-first__bg-target{position:absolute;right:12%;top:22%;width:calc(1.3 * var(--sp-f-u));height:calc(1.3 * var(--sp-f-u));border-radius:50%;',
    'background:radial-gradient(circle,rgba(246,163,41,.9) 0 .06rem,transparent .065rem),radial-gradient(circle,transparent 0 .2rem,rgba(246,163,41,.5) .2rem .215rem,transparent .215rem)}',
    // 减少动效：扫描与呼吸都停
    '@media (prefers-reduced-motion:reduce){.sp-first__bg-sweep,.sp-first__bg-glow{animation:none}}',
    // 勘测网格（参考站 .app-bg::before）
    '.sp-first::before{content:"";position:absolute;inset:0;pointer-events:none;z-index:0;',
    'background:linear-gradient(rgba(78,216,175,.045) 1px,transparent 1px) 0 0 / calc(.8 * var(--sp-f-u)) calc(.8 * var(--sp-f-u)),linear-gradient(90deg,rgba(78,216,175,.045) 1px,transparent 1px) 0 0 / calc(.8 * var(--sp-f-u)) calc(.8 * var(--sp-f-u));',
    'mask-image:radial-gradient(90% 80% at 50% 50%,#000 30%,transparent 85%);-webkit-mask-image:radial-gradient(90% 80% at 50% 50%,#000 30%,transparent 85%)}',
    // 扫描线 + 暗角（参考站 .app-bg::after）
    '.sp-first::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:0;opacity:.9;',
    'background:repeating-linear-gradient(0deg,rgba(255,255,255,.02) 0 1px,transparent 1px 3px),radial-gradient(130% 100% at 50% 50%,transparent 55%,rgba(0,0,0,.65) 100%)}',
    // scanline texture + vignette (the reference site's panel texture; ::before sits under the content)
    '.sp-first::before{content:"";position:absolute;inset:0;pointer-events:none;z-index:0;',
    'background:repeating-linear-gradient(0deg,rgba(255,255,255,.016) 0 1px,transparent 1px 3px),radial-gradient(135% 100% at 50% 50%,transparent 55%,rgba(0,0,0,.6) 100%)}',
    // main column: centred, shrinks before anything can clip (overflow stays hidden: no page scroll)
    // 业主 2026-10-13：最上面那行英文去掉、整体往上挪 —— 顶部留白收窄，靠上对齐（不再是居中）。
    // 业主 2026-10-13：上半部分整体居中（原来靠上顶边太近）；底部感谢名单在 main 之外，仍贴底。
    // 业主 2026-10-15：main 此前**没有** overflow —— 内容一旦比可用高度高，子元素就直接画到盒子外面
    // （真机实测：进入游戏按钮压在底部感谢名单上、下沿被视口裁掉 = 业主说的「错位」）。收口在这里，
    // 并把卡片改成可收缩（flex:0 1 auto + min-height:0），让服务器清单那段滚动区先让位。
    // 业主 2026-10-15：「把整体除了卫戍协议文字再往上挪一点，进入的按钮还是在原位置」——
    // 组居中（justify-content:center）时清单一长高，标题会被往上挤、按钮被往下挤。改成
    // flex-start（标题贴顶 = 挪上来的效果），按钮用 margin-top:auto 钉在 main 底沿（= 原位置），
    // 清单长高只吃中间的空隙，两头都不动。
    '.sp-first__main{position:relative;z-index:1;flex:1 1 auto;min-height:0;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;',
    'gap:calc(.18 * var(--sp-f-u));padding:calc(.3 * var(--sp-f-u)) calc(.28 * var(--sp-f-u)) calc(.2 * var(--sp-f-u))}',
    // title block (Paper-Yuan's own type ladder: .34 / .38 / 1.02 / .19rem)
    '.sp-first__title{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:calc(.04 * var(--sp-f-u));text-align:center}',
    '.sp-first__en-a{width:100%;text-align:justify;text-align-last:justify;font-size:calc(.3 * var(--sp-f-u));letter-spacing:.4em;color:var(--sp-f-md)}',
    '.sp-first__en-b{font-size:calc(.44 * var(--sp-f-u));font-weight:700;letter-spacing:.26em;color:var(--sp-f-hi)}',
    // 业主 2026-10-13：「卫戍协议：盟约」那组字整体再放大（1u → 1.18u，行距与字距同步）。
    '.sp-first__cn{font-size:calc(1.18 * var(--sp-f-u));font-weight:900;letter-spacing:.08em;color:var(--sp-f-hi);line-height:1.18}',
    '.sp-first__tag{width:100%;text-align:justify;text-align-last:justify;font-size:calc(.17 * var(--sp-f-u));color:var(--sp-f-lo)}',
    // the single-column card (.title-login idiom): hard corners, 1px line-2 border, blur, 2px mint
    // hairline across the TOP edge (::before) + the four L-shaped bracket corners (::after).
    // 业主 2026-10-13：全屏第一界面改成**左右两列** —— 左侧一列 = 本机服务 + 其下的局域网（含扫描），
    // 右侧一列 = 线上（地址 + 连接 + 服务器列表）。每列宽 ~400px（按最小可用宽兜底，窄屏自动叠成单列）。
    // 列间距与板块内边距一起放大（业主：每个板块的左右间距都要放大）。
    '.sp-first__card{position:relative;box-sizing:border-box;flex:0 1 auto;min-height:0;display:flex;flex-direction:column;gap:calc(.28 * var(--sp-f-u));',
    // 宽度必须**容得下两列 400 + 间距 + 内边距**（业主：左右各占 400），否则 grid 会把两列压回去 ——
    // 实测：1280 宽下旧值 min(10.4u, 100vw-.9u) 只有 693px，两列被压成 301。改成按内容算宽度。
    'width:min(calc(400px * 2 + calc(.56 * var(--sp-f-u)) + calc(.8 * var(--sp-f-u))),calc(100vw - calc(.4 * var(--sp-f-u))));padding:calc(.34 * var(--sp-f-u)) calc(.4 * var(--sp-f-u))}',
    // 两列：各 minmax(0, 400px)（窄屏下被下面的媒体查询收成单列）
    // align-items:stretch（grid 默认）让两列等高 —— 右列的清单才能靠 flex:1 吃到「扫描」那一行的高度。
    '.sp-first__cols{display:grid;grid-template-columns:repeat(2,minmax(0,400px));grid-template-rows:minmax(0,auto);align-items:stretch;justify-content:center;gap:calc(.56 * var(--sp-f-u));min-height:0}',
    '.sp-first__col{display:flex;flex-direction:column;gap:calc(.2 * var(--sp-f-u));min-width:0}',
    'background:linear-gradient(180deg,rgba(20,25,23,.82),rgba(10,13,12,.88));border:1px solid var(--sp-f-line);',
    '-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);box-shadow:0 calc(.2 * var(--sp-f-u)) calc(.5 * var(--sp-f-u)) rgba(0,0,0,.5)}',
    '.sp-first__card::before{content:"";position:absolute;left:-1px;right:-1px;top:-1px;height:2px;background:linear-gradient(90deg,var(--sp-f-mint),transparent 60%)}',
    '.sp-first__card::after{content:"";position:absolute;inset:-1px;pointer-events:none;',
    'background:linear-gradient(var(--sp-f-mint-dim),var(--sp-f-mint-dim)) top left / var(--sp-f-bk-l) var(--sp-f-bk-w) no-repeat,',
    'linear-gradient(var(--sp-f-mint-dim),var(--sp-f-mint-dim)) top left / var(--sp-f-bk-w) var(--sp-f-bk-l) no-repeat,',
    'linear-gradient(var(--sp-f-mint-dim),var(--sp-f-mint-dim)) bottom right / var(--sp-f-bk-l) var(--sp-f-bk-w) no-repeat,',
    'linear-gradient(var(--sp-f-mint-dim),var(--sp-f-mint-dim)) bottom right / var(--sp-f-bk-w) var(--sp-f-bk-l) no-repeat}',
    // status row (the .title-conn idiom: dot + text inside the card)
    '.sp-first__conn{display:flex;align-items:center;gap:calc(.1 * var(--sp-f-u));min-height:calc(.3 * var(--sp-f-u));font-size:calc(.14 * var(--sp-f-u));color:var(--sp-f-lo)}',
    '.sp-first__dot{flex:none;width:calc(.1 * var(--sp-f-u));height:calc(.1 * var(--sp-f-u));background:var(--sp-f-dim)}',
    '.sp-first__dot.is-on{background:var(--sp-f-mint)}',
    '.sp-first__conn-addr{margin-left:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:calc(.13 * var(--sp-f-u));color:var(--sp-f-dim)}',
    // the three entries: one row each, hard corners, mint on hover / when open
    // 三个入口块：业主 2026-10-13「后边加一层稍微深一点的背景」—— 比原 #121816 再深一档
    // （#0d1412），让三块从卡片底色里浮出来、但不抢薄荷强调。
    '.sp-first__entry{box-sizing:border-box;display:flex;align-items:center;gap:calc(.12 * var(--sp-f-u));width:100%;',
    'min-height:max(calc(.62 * var(--sp-f-u)),40px);padding:0 calc(.16 * var(--sp-f-u));',
    'background:#121816;border:1px solid var(--sp-f-line);color:var(--sp-f-hi);font-family:inherit;font-size:calc(.26 * var(--sp-f-u));',
    'font-weight:700;letter-spacing:.04em;text-align:left;cursor:pointer}',
    '.sp-first__entry:not(:disabled):hover{border-color:var(--sp-f-mint);color:var(--sp-f-mint)}',
    '.sp-first__entry.is-open{background:#16201d;border-color:var(--sp-f-mint);color:var(--sp-f-mint)}',
    '.sp-first__entry-micro{margin-left:auto;font-size:calc(.11 * var(--sp-f-u));font-weight:400;letter-spacing:.18em;text-transform:uppercase;color:var(--sp-f-dim);white-space:nowrap}',
    '.sp-first__entry-go{flex:none;font-size:calc(.2 * var(--sp-f-u));color:var(--sp-f-mint-dim)}',
    // 业主 2026-10-17：左列两枚入口**等宽并排**（合计宽度 = 右列输入框宽），第二行「直接开服/扫描」
    // 与复制按钮也是等宽对（grid 1fr 1fr）；地址行可点复制。
    '.sp-first__duo{display:grid;grid-template-columns:1fr 1fr;gap:calc(.1 * var(--sp-f-u));min-width:0}',
    '.sp-first__duo--acts{margin-top:calc(-.04 * var(--sp-f-u))}',
    '.sp-first__btn--half{width:100%;flex:1 1 auto}',
    '.sp-first__addr{display:block;cursor:pointer;color:var(--sp-f-hi)}',
    '.sp-first__addr code{font-size:calc(.13 * var(--sp-f-u));color:var(--sp-f-mint);word-break:break-all}',
    '.sp-first__addr:hover code{color:var(--sp-f-mint)}',
    '.sp-first__hint--fixed{color:var(--sp-f-dim)}',
    // the in-place second step (局域网 / 加入线上): a mint rail on the left, the controls inside
    '.sp-first__sub{display:flex;flex-direction:column;gap:calc(.08 * var(--sp-f-u));padding:calc(.06 * var(--sp-f-u)) 0 calc(.08 * var(--sp-f-u)) calc(.14 * var(--sp-f-u));border-left:1px solid var(--sp-f-mint-dim)}',
    '.sp-first__acts{display:flex;flex-wrap:wrap;align-items:center;gap:calc(.08 * var(--sp-f-u));min-width:0}',
    '.sp-first__btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:calc(.08 * var(--sp-f-u));white-space:nowrap;flex:0 0 auto;',
    'min-height:max(calc(.5 * var(--sp-f-u)),40px);padding:0 calc(.24 * var(--sp-f-u));background:#121816;border:1px solid var(--sp-f-line);',
    'color:var(--sp-f-hi);font-family:inherit;font-size:calc(.16 * var(--sp-f-u));cursor:pointer}',
    '.sp-first__btn:not(:disabled):hover{border-color:var(--sp-f-mint);color:var(--sp-f-mint)}',
    '.sp-first__btn:disabled{opacity:.45;cursor:not-allowed}',
    '.sp-first__btn--go{background:var(--sp-f-mint);border-color:var(--sp-f-mint);color:#04140f;font-weight:700}',
    '.sp-first__btn--go:not(:disabled):hover{color:#04140f;background:#59f4ca}',
    '.sp-first__input{box-sizing:border-box;width:100%;min-width:0;height:max(calc(.5 * var(--sp-f-u)),40px);padding:0 calc(.12 * var(--sp-f-u));',
    'background:#0a0d0c;border:1px solid var(--sp-f-line);color:var(--sp-f-hi);font-family:inherit;font-size:calc(.17 * var(--sp-f-u));outline:none}',
    '.sp-first__input:focus{border-color:var(--sp-f-mint)}',
    '.sp-first__rooms{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:calc(.06 * var(--sp-f-u));min-width:0}',
    '.sp-first__rooms .sp-first__btn{width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:calc(.15 * var(--sp-f-u))}',
    '.sp-first__code{font-size:calc(.2 * var(--sp-f-u));font-weight:700;letter-spacing:.16em;color:var(--sp-f-mint)}',
    '.sp-first__hint{font-size:calc(.14 * var(--sp-f-u));line-height:1.6;color:var(--sp-f-dim);overflow-wrap:anywhere}',
    '.sp-first__note{font-size:calc(.15 * var(--sp-f-u));color:var(--sp-f-mint);overflow-wrap:anywhere}',
    '.sp-first__micro{margin-left:auto}',
    // the way OUT (never trap the player): one wide button under the card
    // 业主 2026-10-13：**进入游戏**才是高亮 CTA（薄荷实底、深色粗字、右侧 »、右缘斜纹），
    // 加入线上不是（它回归普通标签）。
    '.sp-first__enter{position:relative;box-sizing:border-box;flex:0 0 auto;margin-top:auto;display:inline-flex;align-items:center;justify-content:center;gap:calc(.14 * var(--sp-f-u));overflow:hidden;',
    'width:min(calc(6.4 * var(--sp-f-u)),calc(100vw - calc(.6 * var(--sp-f-u))));min-height:max(calc(.86 * var(--sp-f-u)),56px);',
    'padding-right:calc(.34 * var(--sp-f-u));background:var(--sp-f-mint);border:1px solid var(--sp-f-mint);color:#06110d;font-family:inherit;',
    'font-size:calc(.32 * var(--sp-f-u));font-weight:700;letter-spacing:.3em;text-indent:.3em;cursor:pointer}',
    '.sp-first__enter::after{content:"";position:absolute;right:0;top:0;bottom:0;width:calc(.2 * var(--sp-f-u));pointer-events:none;',
    'background:repeating-linear-gradient(-55deg,rgba(6,17,13,.55) 0 2px,transparent 2px 6px)}',
    '.sp-first__enter:hover{filter:brightness(1.08)}',
    // 感谢名单: the bottom strip, horizontal, right -> left (4 identical copies, -25%)
    // 内联服务器清单（业主 2026-10-13）：一行一个、**可滑动**（max-height + overflow-y:auto），
    // 滚动只发生在这块内部，整页仍不可滚动。行样式与 shellPanels 的 .sp-srv-cell 同族
    // （同一底色/边框/薄荷当前行），保证不是突兀的另一种东西。
    // 清单块 flex:1 吃掉右列剩余高度 ⇒ 上沿贴着输入区、下沿与左列「扫描」齐平（业主给的范围）；行容器自身滚动，整页仍不滚动。
    // ② 徽记加大：整个标题块 = [徽记 | 文本列]，徽记高度由 align-items:stretch 拉到与文本列同高
    //   （上到英文行、下到小字说明）。
    // 渐隐渐入（业主 2026-10-13）：进场淡入 + 轻微上浮；关闭时 data-closing 淡出（卸载在 JS 里延时）。
    // 适配：prefers-reduced-motion 下不做任何动画。
    '.sp-first{animation:sp-first-in 220ms cubic-bezier(.2,.7,.3,1) both}',
    // 淡出的 170ms 里 DOM 与按钮**还在**（卸载在 JS 里延时）：没有这一句，穿透的第二击会
    // 再触发一次 startLocal/joinServerRow（连点在 Java 侧会 bump generation + 起第二个轮询线程）。
    '.sp-first-host[data-closing="1"] .sp-first{animation:none;opacity:0;transition:opacity 170ms ease;pointer-events:none}',
    '@keyframes sp-first-in{from{opacity:0;transform:translate3d(0,calc(.06 * var(--sp-f-u)),0)}to{opacity:1;transform:none}}',
    '@media (prefers-reduced-motion:reduce){.sp-first{animation:none}.sp-first-host[data-closing="1"] .sp-first{transition:none}}',
    // 选中态（选择先行）：被选中的入口/行给一条薄荷描边 + 内描边，未选中的「进入游戏」压暗。
    '.sp-first__entry.is-open,.sp-first__online-label.is-picked{border-color:var(--sp-f-mint);color:var(--sp-f-mint)}',
    '.sp-first__online-label.is-picked{border:1px solid var(--sp-f-mint)}',
    '.sp-first__srv-row.is-picked,.sp-first__btn.is-picked{border-color:var(--sp-f-mint);box-shadow:inset 0 0 0 1px rgba(78,216,175,.35)}',
    '.sp-first__enter.is-idle{background:rgba(78,216,175,.16);border-color:var(--sp-f-line);color:var(--sp-f-lo);cursor:default}',
    '.sp-first__brand{display:flex;align-items:stretch;justify-content:center;gap:calc(.2 * var(--sp-f-u));min-width:0}',
    // 业主 2026-10-13：三行字左右布局一致 —— 以「卫戍协议：盟约」那行为宽度基准，
    // 英文行与说明行两端对齐（text-align-last:justify），左沿齐「卫」、右沿齐「约」。
    '.sp-first__brand-text{display:flex;flex-direction:column;align-items:stretch;gap:calc(.04 * var(--sp-f-u));min-width:0}',
    '.sp-first__emblem{position:relative;flex:0 0 auto;display:flex;align-items:center;justify-content:center;padding:calc(.06 * var(--sp-f-u)) 0}',
    // 业主 2026-10-13：徽记放大到左上角红框那个尺寸（≈3u 见方），与「卫戍协议」文本整体居中。
    // 业主 2026-10-13：按比例缩放（保 14:15），高度跟着文本列走，不再拉伸变形。
    // 业主 2026-10-13：图标**缩小** —— 高度仍跨 EN 行到说明行，但宽度收窄（不再占满那一段）。
    '.sp-first__emblem-svg{display:block;height:100%;width:auto;aspect-ratio:14 / 15;max-width:calc(1.5 * var(--sp-f-u));min-height:calc(2.4 * var(--sp-f-u))}',
    // 右列第一行 = 加入线上（标签 + 输入 + 连接），与左列「本机服务」同一行高。
    // 业主 2026-10-13：徽记在「卫戍协议：盟约」左边，两者作为一组整体居中。
    '.sp-first__emblem{position:relative;flex:0 0 auto;display:flex;align-items:center;justify-content:center;padding:calc(.08 * var(--sp-f-u))}',
    '.sp-first__emblem-svg circle{fill:rgba(205,214,209,.5)}',
    '.sp-first__emblem-svg circle.is-accent{fill:var(--sp-f-mint)}',
    '.sp-first__emblem-svg circle.d0{fill:rgba(205,214,209,.34)}',
    '.sp-first__emblem-svg circle.d1{fill:rgba(205,214,209,.42)}',
    '.sp-first__emblem-svg circle.d2{fill:rgba(205,214,209,.5)}',
    '.sp-first__emblem-svg circle.d3{fill:rgba(205,214,209,.58)}',
    '.sp-first__emblem-svg circle.d4{fill:rgba(205,214,209,.66)}',
    '.sp-first__emblem-svg circle.d5{fill:rgba(205,214,209,.74)}',
    '.sp-first__emblem-svg circle.d6{fill:rgba(205,214,209,.82)}',
    '.sp-first__emblem-bracket{position:absolute;width:calc(.14 * var(--sp-f-u));height:calc(.14 * var(--sp-f-u));border:1px solid var(--sp-f-line)}',
    '.sp-first__emblem-bracket--l{left:0;top:0;border-right:0;border-bottom:0}',
    '.sp-first__emblem-bracket--r{right:0;bottom:0;border-left:0;border-top:0}',
    // 业主 2026-10-13：加入线上按钮做成参考站 CTA 的样子（薄荷实底、深色粗字、右侧 »、右缘斜纹）。
    '.sp-first__online{box-sizing:border-box;display:flex;align-items:center;gap:calc(.08 * var(--sp-f-u));width:100%;min-height:max(calc(.62 * var(--sp-f-u)),40px);padding:0 calc(.12 * var(--sp-f-u));background:#121816;border:1px solid var(--sp-f-line)}',
    // 它是个 <button>（要可点选），但没给背景 ⇒ 浏览器默认按钮底色露出来了（业主：加入线上样式怎么变了）。
    '.sp-first__online-label{flex:0 0 auto;display:inline-flex;align-items:baseline;gap:calc(.06 * var(--sp-f-u));background:transparent;border:0;font-family:inherit;cursor:pointer;font-size:calc(.2 * var(--sp-f-u));font-weight:700;letter-spacing:.04em;color:var(--sp-f-hi)}',
    '.sp-first__online-micro{font-size:calc(.1 * var(--sp-f-u));letter-spacing:.14em;color:var(--sp-f-lo)}',
    // width:auto + flex-basis:0 —— 基类 .sp-first__input 的 width:100% 会让 flex-basis 取满整行，
    // 把右边的「连接」按钮挤出边框（实测就是这个原因）。
    '.sp-first__input--online{flex:1 1 0;width:auto;min-width:0;height:max(calc(.42 * var(--sp-f-u)),32px);font-size:calc(.15 * var(--sp-f-u))}',
    '.sp-first__srv{display:flex;flex-direction:column;gap:calc(.05 * var(--sp-f-u));flex:1 1 auto;min-height:0;max-height:100%;margin-top:calc(.06 * var(--sp-f-u));min-width:0}',
    // 业主 2026-10-13：清单**可滑动**（原来全显示会把界面撑乱）；高度上限跟着左列那段（本机房间→扫描），
    // 行多时在块内滚，绝不撑破卡片。
    // 业主 2026-10-13 真机实测：清单长到把下面顶出屏幕。上限必须**绝对**（百分比在未约束的父链上无效），
    // 取约 2.8u（1280 下 ~187px）—— 行多只在块内滚，四个功能键永远留在视口里。
    // 业主 2026-10-14：清单**一行两个服务器**。业主 2026-10-15：「把服务器清单再往下拓展一点，
    // 现在太挤太小了」—— 上限 2.4u → 3.6u（1280 下约 187px → 280px，多露两行）。配合下面的
    // 「卡片上移 + 进入游戏钉底」，清单变高不再把按钮顶出视口。
    '.sp-first__srv-rows{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:calc(.04 * var(--sp-f-u));max-height:calc(3.6 * var(--sp-f-u));overflow-y:auto;overflow-x:hidden;min-width:0;min-height:0}',
    // 等高占位（见 markup 注释）：与 .sp-first__entry 的 min-height 逐字一致，只为不让「进入游戏」挪位。
    '.sp-first__entry-spacer{display:block;width:100%;min-height:max(calc(.62 * var(--sp-f-u)),40px)}',
    '.sp-first__srv-row{box-sizing:border-box;display:flex;align-items:center;gap:calc(.08 * var(--sp-f-u));min-width:0;width:100%;',
    'min-height:max(calc(.5 * var(--sp-f-u)),40px);padding:0 calc(.12 * var(--sp-f-u));background:rgba(8,11,10,.55);',
    'border:1px solid var(--sp-f-line);color:var(--sp-f-hi);font-family:inherit;font-size:calc(.17 * var(--sp-f-u));text-align:left;cursor:pointer}',
    '.sp-first__srv-row:hover{border-color:var(--sp-f-mint);color:var(--sp-f-mint)}',
    '.sp-first__srv-row.is-cur{border-color:var(--sp-f-mint);box-shadow:inset 0 0 0 1px rgba(78,216,175,.22)}',
    '.sp-first__srv-row.is-off{opacity:.45;cursor:default}',
    '.sp-first__srv-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sp-first__srv-ver{flex:0 0 auto;font-size:calc(.13 * var(--sp-f-u));color:var(--sp-f-lo);white-space:nowrap}',
    '.sp-first__srv-dot{flex:0 0 auto;width:calc(.1 * var(--sp-f-u));height:calc(.1 * var(--sp-f-u));border-radius:50%;background:var(--sp-f-lo)}',
    '.sp-first__srv-dot.is-cur{background:var(--sp-f-mint)}',
    // 业主 2026-10-14：清单点按延迟分三色（绿/黄/红），未知与已停用另算。阈值与 shellPanels 的
    // rttDot 逐字一致（<250 良好 / <900 一般 / 其余较差），改这里等于改那处的颜色语义。
    '.sp-first__srv-dot.is-ok{background:var(--sp-f-mint)}',
    '.sp-first__srv-dot.is-warn{background:#e0b64a}',
    '.sp-first__srv-dot.is-bad{background:#e06c5a}',
    '.sp-first__srv-dot.is-dead{background:var(--sp-f-dim)}',
    '.sp-first__srv-dot.is-unknown{background:var(--sp-f-lo)}',
    '.sp-first__srv-dot.is-off{background:var(--sp-f-dim)}',
    '.sp-first__credits{position:relative;z-index:1;flex:0 0 auto;overflow:hidden;height:calc(.58 * var(--sp-f-u));padding:calc(.05 * var(--sp-f-u)) 0;',
    'border-top:1px solid var(--sp-f-line-lo);border-bottom:1px solid var(--sp-f-line-lo);',
    'mask-image:linear-gradient(90deg,transparent 0,#000 6%,#000 94%,transparent 100%);-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 6%,#000 94%,transparent 100%)}',
    '.sp-first__roll{display:inline-flex;flex-direction:row;align-items:center;white-space:nowrap;will-change:transform;animation:sp-first-marquee 34s linear infinite}',
    '.sp-first__roll-copy{display:inline-flex;flex-direction:row;align-items:baseline}',
    '.sp-first__credit{display:inline-flex;align-items:baseline;gap:calc(.06 * var(--sp-f-u));padding:0 calc(.12 * var(--sp-f-u))}',
    '.sp-first__credit-name{font-size:calc(.18 * var(--sp-f-u));font-weight:700;letter-spacing:.03em;color:var(--sp-f-hi)}',
    '.sp-first__credit-name--lead{color:var(--sp-f-mint)}',
    '.sp-first__credit-pre{color:var(--sp-f-mint);font-weight:500}',
    '.sp-first__credit-role{font-size:calc(.11 * var(--sp-f-u));letter-spacing:.14em;color:var(--sp-f-lo)}',
    '.sp-first__credit-dot{color:var(--sp-f-mint-dim)}',
    '@keyframes sp-first-marquee{from{transform:translate3d(0,0,0)}to{transform:translate3d(-25%,0,0)}}',
    '@media (prefers-reduced-motion:reduce){.sp-first__roll{animation:none}}',
    // narrow screens (390x844): 400px 列放不下 —— 收成单列，卡片吃满可用宽
    '@media (max-width:720px){.sp-first__main{gap:calc(.16 * var(--sp-f-u))}',
    '.sp-first__card{width:100%;padding:calc(.22 * var(--sp-f-u)) calc(.18 * var(--sp-f-u))}',
    '.sp-first__cols{grid-template-columns:minmax(0,1fr);gap:calc(.18 * var(--sp-f-u))}',
    '.sp-first__enter{width:100%;font-size:calc(.2 * var(--sp-f-u));letter-spacing:.2em}',
    '.sp-first__cn{font-size:calc(1 * var(--sp-f-u))}',
    '.sp-first__en-a{font-size:calc(.24 * var(--sp-f-u))}',
    '.sp-first__en-b{font-size:calc(.36 * var(--sp-f-u))}',
    '.sp-first__entry{font-size:calc(.24 * var(--sp-f-u))}',
    '.sp-first__top{padding:calc(.12 * var(--sp-f-u)) calc(.16 * var(--sp-f-u))}}',
    // short screens (landscape phones, 844x390): compact the ladder so nothing can clip
    '@media (max-height:520px){.sp-first__main{gap:calc(.1 * var(--sp-f-u))}',
    '.sp-first__en-a{font-size:calc(.22 * var(--sp-f-u))}',
    '.sp-first__en-b{font-size:calc(.32 * var(--sp-f-u))}',
    '.sp-first__cn{font-size:calc(.8 * var(--sp-f-u))}',
    '.sp-first__tag{font-size:calc(.15 * var(--sp-f-u))}',
    '.sp-first__credits{height:calc(.62 * var(--sp-f-u))}}',
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

// ---- live repaint (the LAN address + the room code appear once the shell has them) --------------
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

/** 一条名单节点：大字名字（前缀 mint）+ 小字角色备注 + 分隔点（与网页版/浮窗同一套排版）。 */
function creditItem(it, key) {
  return html`<span class="sp-first__credit" key=${key}>
    <span class=${it.lead ? 'sp-first__credit-name sp-first__credit-name--lead' : 'sp-first__credit-name'}>${it.pre ? html`<span class="sp-first__credit-pre">${it.pre}</span>` : null}${it.label}</span>
    ${it.role ? html`<span class="sp-first__credit-role">${it.role}</span>` : null}
    <span class="sp-first__credit-dot">·</span>
  </span>`;
}

/** The three entries, in the owner's order. `act` doubles as the section id for the expandable ones. */
const ENTRIES = [
  ['本机服务', 'LOCAL SERVICE', 'local'],
  ['局域网', 'LAN DISCOVERY', 'lan'],
  ['加入线上', 'ONLINE', 'online'],
];

// ---- the layer ----------------------------------------------------------------------------------
/** props.onClose: leave the layer (进入游戏 / Esc / the host API). Everything else is read live from
 *  the bridge through ui/connect-core.js -- this component paints and delegates, it owns no logic. */
// 点阵徽记（形状逐字取自 screens/title.js 的 EMBLEM；本层自带样式，不依赖上游 CSS）。
const FIRST_EMBLEM = [
  'XXX..XXX..XXX', 'XXX..XXX..XXX', 'XXXXXXXXXXXXX', '.XXXXXXXXXXX.', '..XXXXXXXXX..',
  '..XXXXXXXXX..', '..XXXX.XXXX..', '..XXXX.XXXX..', '..XXXXXXXXX..', '..XXXXXXXXX..',
  '..XXXXXXXXX..', '.XXXXXXXXXXX.', 'XXXXXXXXXXXXX', 'XXXXXXXXXXXXX',
];
/** 徽记：四角括角 + 点阵 SVG（r6/r7 的第 5、7 列是 mint 强调点 —— 上游同款）。 */
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
    <span class="sp-first__emblem-bracket sp-first__emblem-bracket--l"></span>
    <svg class="sp-first__emblem-svg" viewBox="-0.5 -0.5 14 15">
      ${dots.map(function (d, i) { return html`<circle key=${i} cx=${d.cx} cy=${d.cy} r=${d.r} class=${d.accent ? 'is-accent' : 'd' + d.d} />`; })}
    </svg>
    <span class="sp-first__emblem-bracket sp-first__emblem-bracket--r"></span>
  </div>`;
}
export function FirstScreen(props) {
  const done = (props && typeof props.onClose === 'function') ? props.onClose : function () {};
  // 业主 2026-10-15：「局域网默认展开」—— 进层就是展开态（原来初始为 ''，要点一下才展开）。
  const sectionState = useState('lan');
  const section = sectionState[0];
  const setSection = sectionState[1];
  const noteState = useState('');
  const note = noteState[0];
  const setNote = noteState[1];
  const lanState = useState({ state: 'idle', rooms: [], note: '' });
  const lan = lanState[0];
  const setLan = lanState[1];
  // 业主 2026-10-13：**选择先行** —— 三个入口只做选择，真正执行统一由「进入游戏」触发。
  // pick: null | 'match' | 'local' | 'lan' | 'online'；target: 选中的服务器 id / 局域网房间 key。
  // 'match'（业主 2026-10-13：主页「匹配」= 自动加入默认配置 json 里的互通服务器 → 创房间 → 公开）：
  // 它也是**只选中**，执行同样交给「进入游戏」—— 与其它三条同一口径，不搞第二套触发方式。
  const pickState = useState(null);
  const pick = pickState[0];
  const setPick = pickState[1];
  // 选中行的**整行对象**：进入游戏要用它走 joinServerRow（按条目 id），不能只留 id 再拼 URL。
  const targetRowState = useState(null);
  const targetRow = targetRowState[0];
  const setTargetRow = targetRowState[1];
  const targetState = useState(null);
  const target = targetState[0];
  const setTarget = targetState[1];
  const addrState = useState('');
  const addr = addrState[0];
  const setAddr = addrState[1];
  // 服务器清单（业主 2026-10-13：直接内联到「加入线上」下面，不是按钮开面板）。数据来自同一处签名清单
  // （window.shell.getServerList / __SP_SHELL.getServers），行内点一下就连接；清单可滑动。
  const srvState = useState(null);
  const srv = srvState[0];
  const setSrv = srvState[1];
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
  // 「加入线上」展开时读一次（并让 shell 刷新）；之后监听 sp-servers 事件保持新鲜。
  // 清单**默认可见**（业主 2026-10-13）⇒ 进层就读一次，不再等「点开加入线上」。
  useEffect(function () {
    setSrv(readServerListInline());
    // 2026-10-17 业主口径：**node 只在玩家进入本机服务时启动**。这里原来在首界面挂载就调原生的
    // 预热桥（2026-10-15「启动就开始启动node服务器」），冷启动会立刻拉起 45 MB 解包 + Node 三变体，
    // 与首屏读 APK 本地树抢 IO —— 那是「启动很慢」的来源之一。原生侧的 2.5 s 兜底预热也已同时删除；
    // 进入本机服务走 startLocalService → ensureHostAndSwitch。
    const native = typeof window !== 'undefined' && window.shell && typeof window.shell.setServer === 'function';
    if (native && window.shell.refreshServerList) { try { window.shell.refreshServerList(); } catch (e) { /* ignore */ } }
    const onServers = function (e) { try { setSrv(Object.assign({}, readServerListInline(), JSON.parse(e.detail))); } catch (err) { /* ignore */ } };
    window.addEventListener('sp-servers', onServers);
    return function () { window.removeEventListener('sp-servers', onServers); };
  }, []);

  // LAN results come back through the bridge's single callback slot (this layer is the only consumer
  // of it in the shell now: the floating window's LAN block was removed by the owner's 2026-10-13 call).
  useEffect(function () {
    onLanScan(function (rooms, data) {
      setLan({ state: 'done', rooms: Array.isArray(rooms) ? rooms : [], note: lanNote(data) });
    });
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
  // 业主 2026-10-17：每段地址一行（本地局域网 / 虚拟局域网），可点复制完整链接；没有该段就如实说没有。
  const addrLine = function (kind) {
    const o = localAddresses();
    const label = kind === 'zt' ? '虚拟局域网' : kind === 'v6' ? 'IPv6' : '本地局域网';
    if (!o) return label + '：本机地址需 App 版提供';
    const v = typeof o[kind] === 'string' ? o[kind].replace(/\/+$/, '') : '';
    if (!v) return label + '：暂无地址';
    const url = /^[A-Z0-9]{4}$/.test(String(currentRoomCode() || '').toUpperCase())
      ? v + '/?room=' + String(currentRoomCode()).toUpperCase()
      : v + '/';
    return html`<span class="sp-first__addr" title=${'点击复制 ' + url}
      onClick=${function () { copySegmentLink(kind, ctx); }}>${label}　<code>${url}</code></span>`;
  };
  // The connect core's ctx: every entry reports through this layer's own lines, and 进入线路 closes
  // the layer exactly like the floating window's old entries did (onClose first, then the预载提示).
  const ctx = { say: say, toast: sayToast, onClose: function () { done(); } };

  const native = !!shell();
  const lanOk = lanSupported();
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
  const open = function (id) { setSection(section === id ? '' : id); };

  const entry = function (label, micro, act, onClick, isOpen) {
    return html`<button type="button" class=${isOpen ? 'sp-first__entry is-open' : 'sp-first__entry'}
      onClick=${onClick} aria-expanded=${act === 'local' ? undefined : (isOpen ? 'true' : 'false')}>
      <span class="sp-first__entry-name">${label}</span>
      <${MicroLabel} class="sp-first__entry-micro">${micro}<//>
      <span class="sp-first__entry-go">${act === 'local' ? '›' : (isOpen ? '▾' : '›')}</span>
    </button>`;
  };

  // 服务器清单：过滤掉「本机服务 / 自动线路 / 房间制」三种不该列的行（与 shellPanels 的口径一致），
  // 展开「加入线上」时渲染在输入框下面。
  const srvAll = srv && Array.isArray(srv.entries) ? srv.entries : [];
  // 业主 2026-10-14：**离线不显示**、按**延迟升序**（未知排最后）—— 排序与延迟档走 connect-core 的
  // visibleServers / serverLevel，与悬浮窗面板同一份口径（两处不许各排各的）。
  const srvList = visibleServers(srvAll.filter(function (e) {
    return e && typeof e === 'object' && !e.roomScoped && e.id !== 'local' && e.id !== 'auto';
  }));
  // 清单还没拿到（Java 首次拉取/刷新中）时如实说「正在加载」，而不是空清单说「暂无」。
  const srvLoading = !!(srv && srv.loading === true);

  return html`<div class="sp-first">
    <!-- 业主 2026-10-13：背景照 dl.jiangjiangze.icu —— theme.css 的 .app-bg（见样式表的渐变/网格/扫描线）
         + screens/title.css 的 .title-bg 六个图层（glow / haze / radar / ridges / sweep / target）。 -->
    <div class="sp-first__bg" aria-hidden="true">
      <div class="sp-first__bg-glow"></div>
      <div class="sp-first__bg-radar"><div class="sp-first__bg-sweep"></div></div>
      <div class="sp-first__bg-target"></div>
    </div>
    <div class="sp-first__main">
      <div class="sp-first__title">
        <!-- 业主 2026-10-13：徽记加大到跨整个标题块（上到英文行、下到小字说明），
             文本列在它右边，整体居中。 -->
        <div class="sp-first__brand">
          <${FirstEmblem} />
          <div class="sp-first__brand-text">
            <span class="sp-first__en-a">STRONGHOLD PROTOCOL</span>
            <span class="sp-first__en-b">ALLIANCE</span>
            <h1 class="sp-first__cn">卫戍协议：盟约</h1>
            <p class="sp-first__tag">调配资金与干员，与同伴协同布防，抵御多波次进攻，直至击败敌方领袖。</p>
          </div>
        </div>
      </div>

      <section class="sp-first__card">
        <!-- 业主 2026-10-13：去掉「本机外壳就绪 · 三条线路可用」那行（连地址行一起去掉）。 -->

        <div class="sp-first__cols">
          <!-- 业主 2026-10-14：「匹配」按钮从第一界面**去掉**（连同它下面那行提示）。
               但同一条要求里还有「加入游戏按钮不要动位置」—— 而这一列是 flex 列，少一个子元素就会
               整列变矮、把下面的「进入游戏」整条往上挪。所以原位留一个**等高占位**（高度与
               .sp-first__entry 的 min-height 逐字一致），列的构成（子元素个数与高度）与去掉之前完全相同，
               「进入游戏」一个像素都不动。将来若要收掉这块空白，删这一个 div 即可。 -->
          <!-- 业主 2026-10-15：「本机服务上面对齐加入线上」—— 左列顶上那个**等高占位**（2026-10-14 为
               「加入游戏按钮不要动位置」而留）已删除：它让「本机服务」比右列的「加入线上」整整低一格，
               两列的第一行对不齐。业主本轮把「对齐」排在了「按钮不动」之前，所以占位撤掉。 -->
          <div class="sp-first__col">
            <!-- 业主 2026-10-17（本轮重排，布局稿见 _tmp/ui-overhaul-2026-10-17/plan.md）：
                 左列第一行 = 「本机服务」「局域网」两个**等宽**按钮（grid 1fr 1fr，合计宽度与右列
                 「加入线上」输入框等宽）；下面一行「直接开服 / 扫描」两个等宽小按钮，
                 再下面是邀请码 + 复制链接、本地/虚拟局域网链接与固定提示。 -->
            <div class="sp-first__duo">
              ${entry('本机服务', 'LOCAL SERVICE', 'local', function () { setPick('local'); setTarget(null); startLocal(ctx); }, pick === 'local')}
              ${entry('局域网', 'LAN DISCOVERY', 'lan', function () { setPick('lan'); setTarget(null); open('lan'); }, pick === 'lan')}
            </div>

            <div class="sp-first__duo sp-first__duo--acts">
              <button type="button" class="sp-first__btn sp-first__btn--half"
                onClick=${function () { setPick('local'); setTarget(null); startLocal(ctx); }}>直接开服</button>
              <button type="button" class="sp-first__btn sp-first__btn--half" disabled=${!lanOk || lan.state === 'scanning'}
                onClick=${function () { setPick('lan'); setTarget(null); setSection('lan'); scanLan({ state: lan.state, say: say, onState: function (st, rooms, n) { setLan({ state: st, rooms: rooms, note: n }); } }); }}>${lan.state === 'scanning' ? '扫描中…' : '扫描'}</button>
            </div>

            <div class="sp-first__sub">
              <span class="sp-first__hint">${room
                ? html`本机房间 <b class="sp-first__code">${room}</b> 已就绪`
                : '本机房间尚未就绪：进入本机服务后自动生成邀请码'}</span>
              <div class="sp-first__duo sp-first__duo--acts">
                <button type="button" class="sp-first__btn sp-first__btn--half" disabled=${!room}
                  onClick=${function () { copyRoomLink(ctx); }}>复制邀请链接</button>
              </div>
              <span class="sp-first__hint">${addrLine('lan')}</span>
              <span class="sp-first__hint">${addrLine('zt')}</span>
            </div>
            <span class="sp-first__hint sp-first__hint--fixed">提示：在「加入线上」输入邀请链接即可加入</span>

            ${section === 'lan' ? html`<span class="sp-first__hint">${lan.state === 'done'
              ? '发现 ' + lan.rooms.length + ' 个已公开房间'
              : (lan.state === 'scanning' ? '正在扫描同一 Wi-Fi / 虚拟局域网…' : '同一 Wi-Fi / 虚拟局域网下已公开的房间')}</span>` : null}
            ${section === 'lan' && lan.rooms.length ? html`<div class="sp-first__rooms">${lan.rooms.map(function (r, i) {
              const k = lanRoomKey(r, i);
              return html`<button key=${k} type="button" class=${'sp-first__btn' + (pick === 'lan' && target === k ? ' is-picked' : '')}
                onClick=${function () { setPick('lan'); setTarget(k); }}>${lanRoomLabel(r)}</button>`;
            })}</div>` : null}
            ${section === 'lan' && lan.note ? html`<span class="sp-first__hint">${lan.note}</span>` : null}
          </div>

          <!-- 右列：线上（地址 + 连接 + 服务器列表） -->
          <div class="sp-first__col">
            <!-- 业主 2026-10-13：右列第一行**就是**「加入线上」——点一下即可直接输入自定义服务器地址
                 后加入（不再是标题行 + 下面另起一行输入）。它占的是与左列「本机服务」同一行的高度，
                 所以下面的服务器清单顶沿正好落在「本机房间」那一行、底沿与「扫描」齐平。 -->
            <div class="sp-first__online">
              <button type="button" class=${"sp-first__online-label" + (pick === "online" ? " is-picked" : "")} onClick=${function () { setPick("online"); open("online"); }}><span class="sp-first__entry-name">加入线上</span><${MicroLabel} class="sp-first__online-micro">ONLINE<//></button>
              <input class="sp-first__input sp-first__input--online" type="text" value=${addr} placeholder="输入服务器地址（如 example.com）"
                onInput=${function (e) { setAddr(e && e.currentTarget ? e.currentTarget.value : ''); }}
                onKeyDown=${function (e) { if (e && (e.key === 'Enter' || e.keyCode === 13)) joinCustom(addr, ctx); }} />
              <!-- 业主 2026-10-13：去掉「连接」按钮 —— 执行统一由「进入游戏」触发。 -->
            </div>

            <div class="sp-first__srv">
              <span class="sp-first__hint">${'服务器清单'}</span>
              <div class="sp-first__srv-rows">
                ${srvList.length ? srvList.map(function (e) {
                  const id = e.id || e.name;
                  return html`<button key=${id} type="button" class=${'sp-first__srv-row' + (e.current ? ' is-cur' : '') + (e.enabled === false ? ' is-off' : '') + (pick === 'online' && target === id ? ' is-picked' : '')}
                    disabled=${e.enabled === false}
                    onClick=${function () { setPick('online'); setTarget(id); setTargetRow(e); }}>
                    <span class="sp-first__srv-name">${e.name}</span>
                    ${e.app ? html`<span class="sp-first__srv-ver">${e.app}</span>` : null}
                    <span class=${'sp-first__srv-dot is-' + serverLevel(e) + (e.current ? ' is-cur' : '')}></span>
                  </button>`;
                }) : html`<p class="sp-first__hint">${srvLoading ? '正在加载…' : '暂无可用服务器'}</p>`}
              </div>
            </div>
          </div>
        </div>

        ${note ? html`<span class="sp-first__note">${note}</span>` : null}
      </section>

      <button type="button" class=${'sp-first__enter' + (pick ? '' : ' is-idle')} disabled=${!pick}
        onClick=${function () {
          if (pick === 'local') { startLocal(ctx); return; }
          if (pick === 'lan') {
            const r = (lan.rooms || []).find(function (x, i) { return lanRoomKey(x, i) === target; });
            if (r) { joinLan(r, ctx); return; }
            say('请先选一个局域网房间'); return;
          }
          if (pick === 'online') {
            // 选了清单条目 → 按条目 id 加入（修 DNS bug）；只输了地址 → 才走 joinCustom。
            if (targetRow) { joinServerRow(targetRow, ctx); return; }
            joinCustom(addr, ctx); return;
          }
          done();
        }}>
        进入游戏<span class="sp-first__enter-chev">»</span><${MicroLabel} class="sp-first__micro">ENTER<//>
      </button>
    </div>

    <footer class="sp-first__credits">
      <div class="sp-first__roll">
        ${CREDIT_COPIES.map(function (c) {
          return html`<span class="sp-first__roll-copy" key=${'copy' + c}>${credits.map(function (it, i) {
            return creditItem(it, 'f' + c + '-' + i);
          })}</span>`;
        })}
      </div>
    </footer>
  </div>`;
}

// ---- host + open/close ---------------------------------------------------------------------------
const HOST_ID = 'sp-first-host';
let HOST = null;
let OPEN_SEQ = 0;   // bumped by open()/close(): a draw that is still waiting on the kit is dropped
let DEPS_OK = false; // the kit resolved (or shims were kept): renders are safe from here on
let KIT_OK = false;  // the kit really can render (html + render): otherwise open() reports failure

/** The layer's host: ONE div, attached to documentElement (the ROOT stacking context -- the same
 *  outermost spot mountShellPanelHost uses, so no page container can trap the layer under its own
 *  stacking context). */
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

/** Show the first interface (idempotent). false = no DOM to draw into (an old engine / a test).
 *  The kit resolves asynchronously, so a call that lands before it does draws as soon as it lands --
 *  and a close() in between cancels that draw (OPEN_SEQ), so the layer can never reappear by itself. */
export function openFirstScreen() {
  const el = hostNode();
  if (!el) return false;
  if (DEPS_OK && !KIT_OK) { drawBootFallback(el); return false; } // no renderer: static boot layer, then let the caller fall back
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

/** 无渲染器兜底（业主 2026-10-16「首页不能黑屏」）：纯 DOM 画一张最小启动层（标题 + 正在启动 +
 *  不确定进度条），与 loading 覆盖层同一观感；KIT 就绪后的正式 draw 会整体重画 host，无需专门清理，
 *  close()/OPEN_SEQ 取消路径把 data-boot 一并复位。绝不 throw —— 兜底层自己失败就放弃（原样黑底）。 */
function drawBootFallback(el) {
  try {
    if (el.getAttribute("data-boot") === "1") return;
    el.setAttribute("data-boot", "1");
    el.setAttribute("data-open", "1");
    const bar = document.createElement("div");
    bar.setAttribute("style", "position:fixed;inset:0;z-index:2147479000;background:#0C0F0E;"
      + "display:flex;flex-direction:column;align-items:center;justify-content:center;"
      + "font-family:sans-serif;gap:14px");
    const title = document.createElement("div");
    title.setAttribute("style", "color:#4ED8AF;font-size:22px;letter-spacing:2px");
    title.textContent = "卫戍协议 · 盟约";
    const text = document.createElement("div");
    text.setAttribute("style", "color:#8A9A93;font-size:13px");
    text.textContent = "正在启动…";
    const track = document.createElement("div");
    track.setAttribute("style", "width:220px;height:6px;border-radius:3px;background:#3E4B45;overflow:hidden");
    const fill = document.createElement("div");
    fill.setAttribute("style", "width:40%;height:100%;border-radius:3px;background:#4ED8AF;"
      + "animation:spboot 1.1s ease-in-out infinite alternate");
    const keyframes = document.createElement("style");
    keyframes.textContent = "@keyframes spboot{from{margin-left:0;width:40%}to{margin-left:60%;width:40%}}";
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

/** Leave the first interface. The layer is unmounted (not hidden): nothing of ours is left on the
 *  page, so the title screen underneath is interactive again. */
export function closeFirstScreen() {
  OPEN_SEQ += 1; // any draw still waiting on the kit is cancelled
  const el = HOST;
  if (!el) return true;
  const seq = OPEN_SEQ;
  // 业主 2026-10-13：叠加层要**渐隐渐入**。关闭时先打 data-closing 让 CSS 淡出，
  // 到点再卸载；期间若被重新打开（seq 变了）就放弃这次卸载。
  // 适配：prefers-reduced-motion（或壳设置 reduceMotion）下**不做动画**，立即卸载。
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

/** 是否应当跳过动效：系统 prefers-reduced-motion，或壳设置里的 reduceMotion（业主口径「设置适配」）。 */
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
    // 淡出期间（data-closing）就算「已不可见」：过渡只是视觉，语义上它已经关了。
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
