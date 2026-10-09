/* global window */ // 浏览器全局：extras 源码在 tools 树里（ESLint node 预设覆盖），壳桥全局 window 在此声明
// ================================================================================================
// title.js — **我方副本（vendor）**：上游 0.2.2 标题屏 + 旧线 2.9.31 的构建期补丁净效果。
//
// 为什么有这个文件
//   re 线是「零构建期补丁」线（tools/apk/patches/ 为空），首页原先是 home-layer.js 在**上游标题屏**
//   上叠一层控件 —— 观感与 2.9.31 不完全一致，因为 0.2.1 的标题屏本身变了。用户口径：
//   「把我们那份打过补丁的 title.js/title.css vendor 进 extras 让页面加载我们的副本」= 完整复用
//   2.9.31 首页，同时**上游仓库文件一个字节都不改**。
//
// 来源（provenance）
//   upstream tag/commit : v0.2.2 / 62eb113419123d9a3a63606107bbf85230c5dd2f
//   上游原文路径         : public/js/screens/title.js
//   上游原文 sha256      : 6813626a511d093e798145183ae0f2d511f256172b7ee1846c23fbfeced45924 (14186 B)
//   （即本仓库 public/js/screens/title.js 的字节；lineage.json 的 upstream 字段同源）
//   0.2.2 上游增量（**原样套**，不算我们的 op）：`import openStats from './stats.js'` +
//                        右上角把 LangToggle 包进 .title-corner__tools 并加「统计」按钮
//   补丁来源             : tag shell-v2.9.31 的 tools/apk/patches/settings-v2.2 … v5.6.json
//                          中所有 file == js/screens/title.js 的 ops，按版本序取**净效果**
//
// 加载机制（怎么让页面拿到这个副本）
//   build-webroot.mjs copyExtras() 把 tools/apk/extras/public/** 铺到 webroot **根**（同名覆盖上游），
//   所以装配后 webroot/js/screens/title.js 就是本文件；设备侧 Updater.applyExtras() 把
//   extras/public/** 覆盖到热更树根（REPLACE_EXISTING），MainActivity.openLocal() 先 filesDir
//   热更树、后 assets/webroot 兜底 —— 两条链拿到的都是本副本，**不需要任何 Java 改动**。
//
// 与 home-layer.js 互斥
//   本文件在模块求值时置 window.__SP_TITLE_VENDORED；home-layer.js 的 wanted() 看到该标记即整体
//   让位（不再挂叠加层、不再屏蔽上游节点），避免同一批控件渲染两遍。
//
// 同步纪律（上游改了标题屏怎么办）
//   本副本**不会自动跟随上游**。tools/apk/vendor-title.test.mjs 里钉死了上面两条 sha256 作为
//   「上游基线」：上游一旦改动 public/js/screens/title.js|css，该测试会**大声失败**，提示人工同步
//   ——重做逐条 ops 判定、更新本文件头部的来源与差异清单、再刷新基线 hash。
//   重算 hash：node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('public/js/screens/title.js')).digest('hex'))"
//
// 套用的 ops（净效果，按版本序；详细逐条判定见 tools/apk/vendor-title.test.mjs 与交付报告）
//   v2.2 op2  title-conn 状态行包进 .title-conn__sw 按钮（v4.5 op0 的「无操作」被口径 O9 覆盖）
//   v2.2 op3  title-corner--tr 之后插入 .title-side（+ v2.3/v3.0/v3.5 收敛为侧栏按钮组）
//   v3.3 op0  title-foot 右端包 .title-foot__meta + 追加 .title-foot__update「检查更新」
//   v3.5 op0  import 加 useEffect
//   v3.5 op2  isValidName 之后追加 readProfileName / openShellPanel / LOCAL_POLL_MS / localServiceReady
//   v3.5 op3  代号预填 readProfileName()
//   v3.5 op4  本地服务状态机（点「本地」→ 500ms 轮询 → 120s 兜底回可重试）
//   v3.6 op0  .title-duo：登录面板「本地 | 大厅」等宽横排（左本地、右大厅 primary）
//   v3.6 op1  takeAutostart() 一次性消费 → 400ms 后自动 start()
//   v3.6 op2  duo 与 .title-local 的半宽 CSS（另见 title.css 的 ops 段）
//   v3.7 op0  「线上服务」→「大厅」，点击 openShellPanel('lobby')（服务器选择收进大厅面板）
//   v4.2 op0/op1  本地按钮一键进入：未就绪先 startLocal() + pendingEnter，就绪后自动 start()
//   v4.2 op2  大厅按钮**不** gate 代号（v3.6 的 disabled=${!valid} 去掉）
//   v5.2 op0/1 大厅访客数（5 分钟缓存，仅 online）
//   v5.6 op0/1 观战邀请横幅（pendingSpectate）
//
// 用户口径覆盖（2026-10-08 第二轮追加，**优先级高于 2.9.31 的 ops**：本副本是首页唯一来源）
//   O1  去掉「全屏」：不渲染上游 FullscreenButton，import 一并删（不留 unused）
//   O2  登录面板入口 = 2.9.31 的 .title-duo（左「本地」右「大厅」）：恢复 v3.5 op4 状态机与
//       v4.2 op0/op1 一键进入；「本地」未就绪时文案「启动中…」，就绪后点它走 start() 进入
//   O3  去掉「玩法说明」：GuideButton 渲染处与 import 一起删（v4.2 op3 的 ${null} 占位也去掉）
//   O4  「大厅」不再是侧栏项：侧栏去掉 servers 按钮；大厅入口只在 login duo（动作 = openPanel('lobby')）
//   O5  设置不再映射上游设置弹窗：openPanel('appearance')（我们自己的设置面板，只含字体大小/左右边距）
//      —— 上游 .title-settings 齿轮按口径**原样保留**（仍可开上游设置：语言/音量/画质/伤害数字）
//   O6  侧栏 = 设置/参数/配置（3 项；**「战绩」入口按业主 2026-10-09 口径去掉** —— 上游 0.2.2 自带的
//       右上角「统计」取代了它；records 面板实现仍在 shellPanels，只是首页不再入口）
//   O7  控件加稳定属性 data-sp-title-btn="settings|params|config|local|lobby|update"
//   O8  .title-side 的 top 让开上游右上角块（角块底边实测 ≈1.51rem）→ 取 1.7rem
//   O9  状态行 .title-conn__sw = 「点按打开大厅」（v3.8 语义；v4.5 op0 的无操作被本次口径覆盖）
//
// 未套（判定为「上游 0.2.1 已有」/「净零」/「废弃」）
//   v2.2 op0/op1  SettingsModal import 与 settingsOpen state —— 上游已有（原为 find==replace 断言）
//   v2.3 op0 + v3.5 op1  ShellPanelHost import 增删配对 → 净零
//   v3.5 op6  删除 <${ShellPanelHost} /> → 从未加入，净零
//   v4.5 op0  .title-conn__sw 改无操作 → **口径 O9 覆盖**（v3.8 的「点按打开大厅」为准）
//   v5.2 的 「线上服务」旧文案 / v3.6 的 servers 面板入口 → 被 v3.7 op0 改名与口径 O4 取代
//
// 与上游 0.2.1 的差异（可枚举，逐处）
//   D1  import hooks：+useEffect
//   D2  import device.js：去掉 FullscreenButton（只留 detectFeatures）
//   D3  import guide.js：整行删除（GuideButton 不再需要）
//   D4  import components.js：+Button（duo 用；上游 import 里本来就有 Button）
//   D5  模块顶部：+window.__SP_TITLE_VENDORED 标记（try/catch 包裹）
//   D6  isValidName 之后：+readProfileName / openShellPanel / LOCAL_POLL_MS / localServiceReady 辅助
//   D7  TitleScreen 顶部：+visitors state 与 5 分钟拉取 effect（v5.2）
//   D8  TitleScreen 顶部：+pendingSpectate 读取（v5.6）
//   D9  name 初值：+|| readProfileName()（v3.5）
//   D10 start() 之后：+本地服务状态机与 pendingEnter 一键进入（v3.5 op4 + v4.2 op0/op1）
//   D11 start() 之后：+takeAutostart 一次性自动进入 effect（v3.6）
//   D12 title-corner--tr 之后：+<div class="title-side">（侧栏 4 按钮：设置/参数/配置/战绩）
//   D13 邀请横幅：+观战分支（保留上游 t() 包裹）
//   D14 登录面板：上游 `${t('开始')}` 主按钮 → **2.9.31 的 .title-duo**（左「本地」右「大厅」；
//       大厅 = primary xl block，动作 openPanel('lobby')；输入框回车仍走 start()）
//   D15 title-conn：状态 dot/文案/访客数/PingPill 包进 .title-conn__sw（点按打开大厅）；
//       **删掉**上游 GuideButton 渲染处与 FullscreenButton 渲染处
//   D16 title-foot：版本号包进 .title-foot__meta，+「检查更新」按钮；DEV_BUILD 标签原样保留
//   D17 模块顶部注释：本文件头（来源/ops/差异/同步）
//   保留未动：CONTROL_CHARS / stripLoneSurrogates / sanitizeName / isValidName / enterSession /
//             BACKDROP_KEYS / findUiAsset / EMBLEM / Emblem / Ridges / STATUS_TEXT / 背景 /
//             SettingsModal + .title-settings 齿轮（口径 O5 保留）/ LangToggle / title-dev
//
// 已知缺口（不改上游、留作未决）：本副本对新增文案用字面量（设置/参数/配置/战绩/本地/启动中…/大厅/
// 检查更新/点按打开大厅），未走 t()；非中文语言下这些按钮不翻译（上游 0.2.1 原生控件仍走 t()，未受影响）。
//
// 外部可测性（口径 O7）：六个控件都带稳定属性，外部模拟脚本按属性点击即可，不依赖文案/类名：
//   data-sp-title-btn="settings" | "params" | "config"       （侧栏三个；records 已按 2026-10-09 口径去掉）
//   data-sp-title-btn="local" | "lobby"                       （登录面板 duo）
//   data-sp-title-btn="update"                                （页脚检查更新）
// ================================================================================================
// ↓↓↓ 以下是上游 0.2.1 原文（public/js/screens/title.js）自带的模块注释，原样保留 ↓↓↓
// Title screen: season-style backdrop, big title 卫戍协议：盟约, remembered nickname, 开始, the language menu
// (中文 | English | every pack in public/i18n/, ui/lang.js; a title in an alphabetic script — English — is the big one and
// the small wordmark above it hides).
//
// Pressing 开始 validates the nickname (1..NAME_MAX_LEN chars, no control characters), stores it,
// marks this tab as "entered" (so reloads skip the title) and hands the name to net.js, which
// sends `hello` (now, or as soon as the socket is open). The router then shows the lobby.
//
// Backdrop art: if data/assets.json lists a UI backdrop (`ui.titleBackdrop`, or one of the
// entry/loading illustration names) it is layered under the CSS art; otherwise the screen is
// pure CSS/SVG (radar, ridgelines, glow), so it never issues a request that can 404.
// ↑↑↑ 上游注释到此结束 ↑↑↑
// ================================================================================================

import { useEffect, useMemo, useState } from '../../vendor/hooks.module.js';
import { NAME_MAX_LEN, APP_VERSION, DEV_BUILD } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, TextField, PingPill } from '../ui/components.js';
import { toast } from '../ui/toasts.js';
import { net, identity } from '../net.js';
import { store, useStore, shallowEqual } from '../store.js';
import { data, useData } from '../data.js';
import { detectFeatures } from '../ui/device.js';
import { LangToggle, useLang } from '../ui/lang.js';
import { t, N_ } from '../../../shared/i18n.js';
import { scriptOf } from '../../../shared/i18nPacks.js';
import { GIcon } from '../ui/gameComponents.js';
import { openStats } from './stats.js';
import { SettingsModal } from '../ui/settings.js';

// 本文件是我们的副本（vendor）：home-layer.js 看到这个标记就整体让位（两者互斥，见文件头）。
try { if (typeof window !== 'undefined') window.__SP_TITLE_VENDORED = 'shell-v2.9.31'; } catch (e) { /* 只读 window：忽略 */ }

// Same character classes as server/net.js sanitizeName (control, zero-width, bidi, BOM), so a name
// the client accepts is never rejected by the server's hello validation.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
// Lone surrogates are removed by a scan, not a regex: the lookbehind such a regex needs is a *syntax error* in Safari
// < 16.4, which would stop the whole client from loading there.
export function stripLoneSurrogates(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { out += str[i] + str[i + 1]; i++; }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += str[i];
  }
  return out;
}

/**
 * Normalise a nickname like the server does (NFC, strip lone surrogates / control / invisible /
 * bidi characters, collapse whitespace, trim), then clamp to NAME_MAX_LEN UTF-16 code units — the
 * protocol's `hello.name` limit — without splitting a surrogate pair.
 * @param {any} raw
 * @returns {string}
 */
export function sanitizeName(raw) {
  let s = String(raw ?? '');
  try { s = s.normalize('NFC'); } catch { /* keep as is */ }
  s = stripLoneSurrogates(s).replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').replace(/ {2,}/g, ' ').trim();
  if (s.length > NAME_MAX_LEN) {
    s = s.slice(0, NAME_MAX_LEN);
    // Don't leave half a surrogate pair at the end.
    if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
    s = s.trim();
  }
  return s;
}

/** @param {any} raw @returns {boolean} */
export const isValidName = (raw) => sanitizeName(raw).length > 0;

// shell (v3.5): 玩家数据 v1 代号预填 —— 该 origin 没有记住的代号时，取本地玩家数据的 profile.name。
// App 走 window.spData.get()（Java 桥，filesDir/player-v1.json），网页走 window.__SP_DATA
// （player-data.js 的 exportJSON）；前后端都静默，读不到就保持空。
function readProfileName() {
  try {
    let raw = null;
    if (window.spData && typeof window.spData.get === 'function') raw = window.spData.get();
    if (!raw && window.__SP_DATA && typeof window.__SP_DATA.exportJSON === 'function') raw = window.__SP_DATA.exportJSON();
    if (!raw) return '';
    const doc = JSON.parse(raw);
    const n = doc && doc.profile && typeof doc.profile.name === 'string' ? doc.profile.name : '';
    return sanitizeName(n) || '';
  } catch (e) { return ''; }
}

// shell (v3.5): 打开 in-page 面板（宿主已挂到应用根组件，任何界面都可用）。
// 口径 O5：设置走 'appearance'（我们自己的设置面板，只含字体大小/左右边距）。
function openShellPanel(kind) {
  try { window.__SP_SHELL && window.__SP_SHELL.openPanel && window.__SP_SHELL.openPanel(kind); } catch (e) { /* shell bridge absent */ }
}

// shell (v3.5): 本地服务 —— 就绪指「本机线路正在为这个页面提供内容」（内嵌房主服务已启动）。
const LOCAL_POLL_MS = 500;
function localServiceReady() {
  try { return !!(window.__SP_SHELL && window.__SP_SHELL.localServiceReady && window.__SP_SHELL.localServiceReady()); } catch (e) { return false; }
}

/**
 * Enter the game shell with a nickname (title → lobby).
 * @param {string} rawName
 * @returns {boolean} false when the name is invalid
 */
export function enterSession(rawName) {
  const name = sanitizeName(rawName);
  if (!name) return false;
  identity.saveName(name);
  identity.setEntered(true);
  store.set((s) => ({ me: { ...s.me, name }, session: { ...s.session, entered: true } }));
  net.setName(name);
  return true;
}

// data/assets.json `ui` keys are 'group/key' (docs/ASSETS.md).
const BACKDROP_KEYS = ['titleBackdrop', 'entry/bkg_01', 'entry/bkg_02'];
const RIDGE_KEYS = ['titleRidges', 'entry/bg_mountains_tiled'];

/**
 * Find a UI image URL in data/assets.json (tolerant of a few plausible shapes).
 * @param {any} assets
 * @param {string[]} names
 * @returns {string|null}
 */
export function findUiAsset(assets, names) {
  if (!assets || typeof assets !== 'object') return null;
  const asUrl = (v) => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v.url || v.path || v.src || null;
    return null;
  };
  const ui = assets.ui;
  if (ui && typeof ui === 'object' && !Array.isArray(ui)) {
    for (const n of names) {
      const u = asUrl(ui[n]);
      if (u) return u;
    }
  }
  const lists = [Array.isArray(ui) ? ui : null, Array.isArray(assets.files) ? assets.files : null].filter(Boolean);
  for (const list of lists) {
    for (const n of names) {
      const hit = list.map(asUrl).find((u) => typeof u === 'string' && u.includes('/ui/') && u.toLowerCase().split('/').pop().startsWith(n.toLowerCase()));
      if (hit) return hit;
    }
  }
  return null;
}

// Dot-matrix watchtower emblem (13×14 bitmap; dots grow toward the base for depth).
const EMBLEM = [
  'XXX..XXX..XXX',
  'XXX..XXX..XXX',
  'XXXXXXXXXXXXX',
  '.XXXXXXXXXXX.',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '..XXXX.XXXX..',
  '..XXXX.XXXX..',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '.XXXXXXXXXXX.',
  'XXXXXXXXXXXXX',
  'XXXXXXXXXXXXX',
];

function Emblem() {
  const dots = useMemo(() => {
    const out = [];
    EMBLEM.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        if (ch !== 'X') return;
        const rad = 0.2 + (r / (EMBLEM.length - 1)) * 0.2;
        const accent = (r === 6 || r === 7) && (c === 5 || c === 7);
        out.push({ cx: c + 0.5, cy: r + 0.5, r: rad, accent, d: (r * 13 + c) % 7 });
      });
    });
    return out;
  }, []);
  return html`<div class="emblem" aria-hidden="true">
    <span class="emblem__bracket emblem__bracket--l"></span>
    <svg class="emblem__svg" viewBox="-0.5 -0.5 14 15">
      ${dots.map((d, i) => html`<circle key=${i} cx=${d.cx} cy=${d.cy} r=${d.r} class=${d.accent ? 'is-accent' : `d${d.d}`} />`)}
    </svg>
    <span class="emblem__bracket emblem__bracket--r"></span>
  </div>`;
}

function Ridges() {
  return html`<svg class="title-bg__ridges" viewBox="0 0 1920 420" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="ridge-far" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#16231f" /><stop offset="1" stop-color="#0a0e0d" />
      </linearGradient>
      <linearGradient id="ridge-near" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0f1714" /><stop offset=".6" stop-color="#080b0a" />
      </linearGradient>
      <linearGradient id="ridge-edge" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#17f9b7" stop-opacity="0" />
        <stop offset=".3" stop-color="#17f9b7" stop-opacity=".55" />
        <stop offset=".7" stop-color="#17f9b7" stop-opacity=".55" />
        <stop offset="1" stop-color="#17f9b7" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path class="ridge ridge--far" fill="url(#ridge-far)" stroke="url(#ridge-edge)"
      d="M0 420V250l120-40 90 30 90-70 60 20 80-70 80 55 80-25 90 70 90-20 80 50 100-15 90 25 90-55 90-55 70-55 70 45 80-20 90 65 80-20 100 55 100-20 100 40v180z" />
    <path class="ridge ridge--near" fill="url(#ridge-near)" stroke="url(#ridge-edge)"
      d="M0 420V322l160-32 100 20 120-50 90 40 130-20 120 50 140-30 140 35 120-35 140 20 140-50 120 30 120-20 120 40 160-20v147z" />
  </svg>`;
}

const STATUS_TEXT = {
  idle: N_('准备连接'), connecting: N_('正在连接服务器'), connected: N_('已连接服务器'), handshaking: N_('正在验证身份'),
  online: N_('已连接服务器'), reconnecting: N_('连接中断，正在重连'), closed: N_('连接已关闭'),
};

/** Title screen component. */
export function TitleScreen() {
  const conn = useStore((s) => s.connection, shallowEqual);
  // 外壳侧栏（设置/参数/配置/战绩/大厅）的显示门。**必须是响应式的**：`window.__SP_SHELL` 由
  // shell-bridge.js 建立，而它是被**动态插入**的脚本（async），可能晚于本模块首帧渲染 ——
  // 旧线靠构建期补丁把装载器写进 <head>（parser-blocking）才没有这个竞态。这里改成：
  // 首帧若还没就绪就轮询（200ms，最多 5s），就绪后 setState 触发重渲染。
  const [shellReady, setShellReady] = useState(() => {
    try { return !!(window.__SP_SHELL && window.__SP_SHELL.isApp && typeof window.__SP_SHELL.openPanel === 'function'); } catch (e) { return false; }
  });
  useEffect(() => {
    if (shellReady) return undefined;
    let tries = 0;
    const id = setInterval(() => {
      let ready = false;
      try { ready = !!(window.__SP_SHELL && window.__SP_SHELL.isApp && typeof window.__SP_SHELL.openPanel === 'function'); } catch (e) { ready = false; }
      if (ready) { setShellReady(true); clearInterval(id); return; }
      if (++tries >= 25) clearInterval(id);
    }, 200);
    return () => clearInterval(id);
  }, [shellReady]);
  // v5.2：大厅访客数（状态行右侧）——读 5 分钟缓存，最多每 5 分钟刷一次（免费额度纪律：
  // 页面上只此一条低频请求；面板打开时由房间牌的 60s 心跳顺带刷新，这里直接复用缓存）。
  const [visitors, setVisitors] = useState(() => {
    try { return window.__SP_LOBBY && typeof window.__SP_LOBBY.visitorsCached === 'function' ? window.__SP_LOBBY.visitorsCached() : null; } catch (e) { return null; }
  });
  useEffect(() => {
    if (conn.status !== 'online') return undefined;
    let alive = true;
    const pull = () => {
      try {
        if (!(window.__SP_LOBBY && typeof window.__SP_LOBBY.fetchVisitors === 'function')) return;
        Promise.resolve(window.__SP_LOBBY.fetchVisitors(false)).then((n) => { if (alive && typeof n === 'number') setVisitors(n); });
      } catch (e) { /* 静默 */ }
    };
    pull();
    const timer = setInterval(pull, 300000);
    return () => { alive = false; clearInterval(timer); };
  }, [conn.status]);
  const pendingJoin = useStore((s) => s.ui.pendingJoin);
  const pendingSpectate = useStore((s) => s.ui.pendingSpectate === true); // v5.6 观战邀请
  useLang(); // re-render on a language switch
  const [name, setName] = useState(() => store.get().me.name || identity.loadName() || readProfileName() || '');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const assetsSettled = useData('assets');
  const assets = data.get('assets');
  const backdrop = findUiAsset(assets, BACKDROP_KEYS);
  const ridges = findUiAsset(assets, RIDGE_KEYS);
  // Track load/fail per URL (not as booleans reset in effects: an image can load before an effect runs).
  const [bgLoadedUrl, setBgLoadedUrl] = useState(null);
  const [ridgesLoadedUrl, setRidgesLoadedUrl] = useState(null);
  const [ridgesFailedUrl, setRidgesFailedUrl] = useState(null);
  const bgLoaded = !!backdrop && bgLoadedUrl === backdrop;
  const ridgesLoaded = !!ridges && ridgesLoadedUrl === ridges;
  const ridgesFailed = !!ridges && ridgesFailedUrl === ridges;
  // CSS ridgelines only when there is no ridge art (avoids a swap flash when the art arrives).
  const cssRidges = assetsSettled && (!ridges || ridgesFailed);

  const valid = isValidName(name);
  const start = () => {
    if (!valid) { toast(t('请输入博士代号'), 'warn'); return; }
    enterSession(name);
  };

  // shell (v3.5 op4 + v4.2 op0/op1)：本地服务状态机 idle → starting（点「本地」后每 500ms 轮询）→ ready。
  // 当前线路已是本机服务（页面由内嵌 Node 提供）时初始就是 ready。
  // shell (v4.2)：按钮语义 = 一键进入 —— 未就绪先 startLocal() 并置 pendingEnter，
  // 就绪后由下方 effect 自动 start() 完成进入；已就绪直接 start()。
  const [localState, setLocalState] = useState(() => (localServiceReady() ? 'ready' : 'idle'));
  const [pendingEnter, setPendingEnter] = useState(false);
  useEffect(() => {
    if (localState !== 'starting') return undefined;
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (localServiceReady()) { setLocalState('ready'); return; }
      if (Date.now() - t0 > 120000) { // 兜底：壳内 60s 起有诊断，页面这里超时恢复可重试
        setLocalState('idle');
        toast('本地服务启动超时，可重试', 'warn');
      }
    }, LOCAL_POLL_MS);
    return () => clearInterval(timer);
  }, [localState]);
  // shell (v4.2)：一键进入消费端 —— 本地服务就绪且有待进入标志时，自动走既有 start()。
  useEffect(() => {
    if (localState === 'ready' && pendingEnter) { setPendingEnter(false); start(); }
  }, [localState, pendingEnter]);
  const startLocal = () => {
    if (localState !== 'idle') return;
    let started = false;
    try { started = !!(window.__SP_SHELL && window.__SP_SHELL.startLocalService && window.__SP_SHELL.startLocalService()); } catch (e) { /* shell bridge absent */ }
    if (started) setLocalState('starting');
  };
  // 口径（2026-10-08 更新）：左键文案 = 「进入」（本机服务一键进入，回到 v4.2 的「进入」口径）；
  // 启动中显示「启动中…」。行为不变：未就绪 → startLocal() + pendingEnter，就绪后自动 start()。
  const localLabel = localState === 'starting' ? '启动中…' : '进入';

  // shell (v3.6): 一键进服消费端 —— 服务器面板选中后 window.shell.setAutostart() 布防（随后切服重载），
  // 标题页初始化在此取用一次：takeAutostart() === '1' 时等 400ms（等代号预填与 socket 就绪）
  // 自动走既有 start()；取用即清除（Java 侧 commit），无名/桥缺失静默回退手动。
  useEffect(() => {
    let armed = false;
    try {
      armed = !!(window.shell && typeof window.shell.takeAutostart === 'function'
        && String(window.shell.takeAutostart()) === '1');
    } catch (e) { armed = false; }
    if (!armed) return undefined;
    const timer = setTimeout(() => {
      try { if (isValidName(name)) start(); } catch (e) { /* 手动回退 */ }
    }, 400);
    return () => clearTimeout(timer);
  }, []);

  const online = conn.status === 'online' || conn.status === 'connected';
  const dotClass = online ? 'is-on' : conn.status === 'reconnecting' || conn.status === 'connecting' || conn.status === 'handshaking' ? 'is-warn' : 'is-bad';

  // touch screens: no autofocus (it would pop the on-screen keyboard over a landscape phone's whole view)
  const touchUi = useMemo(() => detectFeatures().coarse, []);
  // a title in an alphabetic script (English, French …) is the big one in the display face and the wordmark above it
  // hides; a CJK / kana / Hangul title keeps the Chinese layout (shared/i18nPacks.js scriptOf — a pack needs no flag)
  const alphabetic = scriptOf(t('卫戍协议')) === 'alphabetic';
  return html`<div class="screen title-screen">
    <div class=${`title-bg${bgLoaded ? ' has-art' : ''}${ridgesLoaded ? ' has-ridges' : ''}`} aria-hidden="true">
      ${backdrop ? html`<img class="title-bg__art" src=${backdrop} alt="" draggable=${false}
        onLoad=${() => setBgLoadedUrl(backdrop)} />` : null}
      <div class="title-bg__glow"></div>
      <div class="title-bg__radar"><div class="title-bg__sweep"></div></div>
      <div class="title-bg__target"></div>
      ${cssRidges ? html`<${Ridges} />` : null}
      ${ridges && !ridgesFailed ? html`<div class="title-bg__ridge-art" style=${`background-image:url("${ridges}")`}>
        <img src=${ridges} alt="" hidden onLoad=${() => setRidgesLoadedUrl(ridges)} onError=${() => setRidgesFailedUrl(ridges)} />
      </div>` : null}
      <div class="title-bg__haze"></div>
      <span class="cross" style="left:7%;top:22%"></span>
      <span class="cross" style="left:93%;top:30%"></span>
      <span class="cross" style="left:14%;top:70%"></span>
      <span class="cross" style="left:88%;top:62%"></span>
      <span class="cross" style="left:60%;top:12%"></span>
    </div>

    <div class="title-corner title-corner--tl">
      <span class="title-corner__mark"></span>
      <div><${MicroLabel} tone="mint">RHODES ISLAND // SIMULATION SERVICE<//><br /><${MicroLabel}>TACTICAL CO-OP NODE · 02<//></div>
    </div>
    <div class="title-corner title-corner--tr">
      <div>
        <div class="title-corner__tools">
          <${Button} variant="ghost" size="sm" icon="chart" class="title-stats" onClick=${openStats} title=${t('统计数据')}>${t('统计')}<//>
          <${LangToggle} class="title-lang" />
        </div>
        <${MicroLabel} tone="hi">TARGET POINT<//><br /><${MicroLabel}>STRONGHOLD PROTOCOL<//>
      </div>
    </div>
    <div class="title-side">
      ${shellReady ? html`<div class="title-room">
        <button type="button" class="title-room__cfg" data-sp-title-btn="settings" onClick=${() => openShellPanel('appearance')}>设置</button>
        <button type="button" class="title-room__cfg" data-sp-title-btn="params" onClick=${() => openShellPanel('params')}>参数</button>
        <button type="button" class="title-room__cfg" data-sp-title-btn="config" onClick=${() => openShellPanel('config')}>配置</button>
      </div>` : null}
    </div>

    <main class="title-main">
      <${Emblem} />
      ${alphabetic ? null : html`<div class="title-en">
        <span class="title-en__a">STRONGHOLD PROTOCOL</span>
        <span class="title-en__b">ALLIANCE</span>
      </div>`}
      <h1 class=${`title-cn${alphabetic ? ' title-cn--latin' : ''}`}>${t('卫戍协议')}<span class="title-cn__colon">${alphabetic ? ': ' : '：'}</span><em>${t('盟约')}</em></h1>
      <p class="title-tag">${t('调配资金与干员，与同伴协同布防，抵御多波次进攻，直至击败敌方领袖。')}</p>

      <div class="title-login">
        ${pendingJoin ? html`<div class="title-invite">
          <${Icon} name="key" />
          <span>${pendingSpectate ? t('收到观战邀请') : t('收到同盟邀请')}</span><b class="num">${pendingJoin}</b><span class="t-lo">${pendingSpectate ? t('· 输入代号后将自动观战') : t('· 输入代号后将自动加入')}</span>
        </div>` : null}
        <${TextField} label=${t('博士代号')} micro="CALLSIGN" size="lg" icon="user" value=${name} maxLength=${NAME_MAX_LEN}
          placeholder=${t('输入你的代号（最多 {NAME_MAX_LEN} 字）', { NAME_MAX_LEN })} autoFocus=${!touchUi}
          onInput=${setName} onEnter=${start} />
        <div class="title-duo">
          <${Button} variant="secondary" size="xl" block=${true} class="title-local" data-sp-title-btn="local"
            iconRight=${localState === 'ready' ? 'chevrons' : undefined}
            loading=${localState === 'starting'}
            disabled=${!valid || localState === 'starting'}
            onClick=${() => { if (localState === 'ready') start(); else { setPendingEnter(true); startLocal(); } }}>${localLabel}<//>
          <${Button} variant="primary" size="xl" block=${true} iconRight="chevrons" data-sp-title-btn="lobby"
            onClick=${() => openShellPanel('lobby')}>大厅<//>
        </div>
        <div class="title-conn">
          <button type="button" class="title-conn__sw" title="点按打开大厅" onClick=${() => openShellPanel('lobby')}>
            <span class=${`status-dot ${dotClass}`}></span>
            <span>${STATUS_TEXT[conn.status] ? t(STATUS_TEXT[conn.status]) : conn.status}</span>
            ${typeof visitors === 'number' && conn.status === 'online'
              ? html`<span style="margin-left:.06rem;opacity:.66;font-size:.9em">· 大厅 ${visitors} 人</span>`
              : null}
            ${conn.status === 'online' ? html`<${PingPill} ms=${conn.ping} />` : null}
          </button>
          <button type="button" class="title-settings fsbtn tapx" aria-label=${t('设置')} title=${t('设置')}
            onClick=${() => setSettingsOpen(true)}><${GIcon} name="gear" /></button>
        </div>
      </div>
    </main>

    <${SettingsModal} open=${settingsOpen} onClose=${() => setSettingsOpen(false)} />

    <footer class="title-foot">
      <span>${t('非官方同人复刻 · 游戏素材版权归 上海鹰角网络 / Yostar 所有')}</span>
      <span class="title-foot__meta">
        <${MicroLabel}>v${APP_VERSION} · WEB SIMULATION<//>
        <button type="button" class="title-foot__update" data-sp-title-btn="update" title="检查内容更新" onClick=${() => { try { window.__SP_SHELL && window.__SP_SHELL.checkUpdate && window.__SP_SHELL.checkUpdate(); } catch (e) { /* shell bridge absent */ } }}>检查更新</button>
      </span>
      ${DEV_BUILD ? html`<span class="title-dev" role="note">${t('开发版 · 不稳定，请勿用于公开服务器')}</span>` : null}
    </footer>
  </div>`;
}
