/* global window, document */
// js/ui/connect-core.js -- the three connect paths (本机服务 / 局域网 / 加入线上) + the shell plumbing
// they need, in ONE place. No UI, no imports, no DOM: every entry is a function of its inputs plus an
// injected ctx {say, toast, onClose, onState} -- so it is callable from any shell layer and testable
// without a browser.
//
// PROVENANCE (2026-10-13, branch ui/redraw-function-panel) -- this is a MOVE, not a rewrite. Every
// function below is the body that shipped inside js/ui/preloadPanel.js (its lines 312-424 for the
// plumbing, 538-614 for the connect handlers, in the 2026-10-13 revision; the functions that closed
// over the panel's own React state are the only ones that got a parameter -- setNote -> ctx.say,
// the panel's close -> ctx.onClose, the kit's toast -> ctx.toast). Why the move is the right shape:
// the owner took those controls OUT of the floating window ("去掉「本地服务 / 加入局域网 / 加入服务器」
// 和里面的（…）") and put them on the full-screen first interface, so the panel draws no connect
// control any more and this module has exactly ONE drawing consumer (js/first-screen.js). There is no
// second implementation to drift: tools/apk/preload-panel.test.mjs asserts the panel no longer holds
// any of these bodies, and tools/apk/first-screen.test.mjs drives these very functions.
//
// Contract: ESM, zero imports, degrades silently (never throws) when a bridge is absent -- a plain
// web page still resolves every call; the caller decides what to say.

function noop() {}

/** The App's own JS interface (window.shell), or null on the plain web / an old APK. */
export function shell() {
  try { return (typeof window !== 'undefined' && window.shell) ? window.shell : null; } catch (e) { return null; }
}

/** Opens one of the shell's own panels by kind (the panel host owns the registry). Closes the caller's
 *  own layer first: its modal sits at a higher z-index and would otherwise cover the next one. */
export function openPanel(kind, onClose) {
  try { if (typeof onClose === 'function') onClose(); } catch (e) { /* ignore */ }
  try {
    const s = window.__SP_SHELL;
    if (s && typeof s.openPanel === 'function') { s.openPanel(kind); return true; }
  } catch (e) { /* no panel host (plain web / old APK) */ }
  return false;
}

/** 复制：App 剪贴板桥 window.shell.copyText → navigator.clipboard → textarea 选中兜底。 */
export function copyText(text) {
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
export function currentRoomCode() {
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
 *  absent (an old APK / a plain web page): the caller then says so instead of copying a dead link. */
export function localAddresses() {
  const sh = shell();
  try {
    if (sh && typeof sh.hostAddresses === 'function') {
      const o = JSON.parse(sh.hostAddresses());
      if (o && typeof o === 'object') return o;
    }
  } catch (e) { /* old shell / no JSON */ }
  return null;
}

/** The preferred base URL for a share link ('' when the device has no address to build one from). */
export function localBase() {
  const o = localAddresses();
  if (!o) return '';
  const pick = ['zt', 'lan', 'v6'].find((k) => typeof o[k] === 'string' && o[k]);
  return pick ? String(o[pick]).replace(/\/+$/, '') : '';
}

/** The LAN/VPN deep link for a room on THIS device, or '' when there is no address to build it from. */
export function localRoomUrl(code) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(c)) return '';
  const base = localBase();
  return base ? base + '/?room=' + c : '';
}

/** 提示行：本机 IP（虚拟局域网优先）与它来自哪张网卡。取不到就如实说，绝不编一个地址。
 *  显示口径与「复制链接」完全一致（同一个 localBase()）：玩家照着这个地址填就不会填错
 *  —— 两者必须是同一个值，否则「提示的 IP」和「复制出去的链接」会打架。 */
export function lanIpLine() {
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
 * 进入线路后的预载（业主 2026-10-15：「点击进入按钮后进到服务器后即开始预载」）。
 *
 * 这里**直接开跑**，不再只弹提示。上一版（2026-10-12 口径）是「只提醒、不代跑」——进入后弹一个
 * 预载面板，玩家还得再点一下「开始预载」。业主的原话是「是多了一层跳转吗，怎么点一下还进不去」：
 * 那一层提示就是多出来的那一步。现在进入即开跑，面板仍可随时打开看进度（悬浮窗齿轮按钮）。
 *
 * 开跑的两条通道与面板里那颗按钮**逐字同一套**（ui/preloadPanel.js 的 togglePreload）：
 *   ① 包通道 shell.syncArt()（幂等：已装好的分卷包不会重下）
 *   ② 文件走查 window.__SP_PRELOAD.start()
 * 两条各自 try/catch：一条不可用不影响另一条，全不可用也只是少跑一次预载（进入本身照常）。
 * 返回 true = 至少踢动了一条通道（调用方据此说一句话，而不是报假成功）。
 */
export function autoPreload() {
  let kicked = false;
  try {
    const sh = shell();
    if (sh && typeof sh.syncArt === 'function') { sh.syncArt(); kicked = true; }
  } catch (e) { /* 包通道不可用：文件走查照旧 */ }
  try {
    const p = window.__SP_PRELOAD;
    if (p && typeof p.start === 'function') { p.start(); kicked = true; }
  } catch (e) { /* 预载中心不可用 */ }
  // 业主 2026-10-15：「进度条不动」的根因不是面板没开 —— 是**这一脚踢错了页面**。
  // 进入任何线路都会换 origin、整页重载：本页的 start() 跟着旧页面一起被丢掉，落地页从没
  // 跑过预载（面板自然停在 0%）。所以这里再写一条**跨 origin** 的一次性旗标（__SP_PREFS
  // 走 player-v1 vault，切服后仍读得到），由落地页的 preload-center 消费一次自己 start()。
  // 不自动弹面板：业主 2026-10-15 抱怨过「多了一层跳转」；进度条在玩家自己开面板时是活的。
  try {
    const pf = window.__SP_PREFS;
    if (pf && typeof pf.set === 'function') { pf.set('preload.auto', Date.now()); kicked = true; }
  } catch (e) { /* 无 vault：本页的 start() 照旧（同 origin 场景仍有效） */ }
  return kicked;
}

/** 旧名保留（别的层/测试还在 import 它）：语义已改为「进入即开跑」，不再是「只弹提示」。 */
export const hintPreload = autoPreload;


// ---- LAN discovery ------------------------------------------------------------------------------
/** 能力探测：旧 APK / 网页没有 shell.lanScan —— 局域网入口据此置灰，绝不假装能扫。 */
export function lanSupported() {
  const sh = shell();
  return !!(sh && typeof sh.lanScan === 'function');
}

/** 注册扫描结果回调（单槽：后注册者覆盖前者，避免层反复开关累积陈旧闭包）。 */
export function onLanScan(fn) {
  try {
    if (window.__SP_LAN && typeof window.__SP_LAN.onScan === 'function') { window.__SP_LAN.onScan(fn); return true; }
  } catch (e) { /* no bridge */ }
  return false;
}

/** 扫描失败/打不通的如实说法（空串 = 本轮正常，不画任何行）。 */
export function lanNote(data) {
  if (data && data.ok === false) return '扫描失败，请稍后重试';
  if (data && data.unreachable === true) return '扫描没打通：可能不在同一网段，或路由器隔离了设备';
  return '';
}

/** 一个房间按钮的稳定 key（ip+port+房号）。 */
export function lanRoomKey(r, i) {
  return 'lan:' + String((r && r.ip) || '') + ':' + (Number(r && r.port) || 0) + '#' + String((r && r.code) || i || '');
}

/** 一个房间按钮的文案：房号 + 可选房间名。 */
export function lanRoomLabel(r) {
  return String((r && r.code) || '') + ((r && r.name) ? ' · ' + String(r.name) : '');
}

/**
 * 发起一次局域网扫描。ctx: { state (本轮扫描状态), say, onState(state, rooms, note) }。
 * 返回 true = 已发出（等 __SP_LAN 回吐结果），false = 没发出去（并已 say 原因）。
 */
export function scanLan(ctx) {
  const c = ctx || {};
  const say = typeof c.say === 'function' ? c.say : noop;
  const onState = typeof c.onState === 'function' ? c.onState : noop;
  if (c.state === 'scanning') return false;
  const sh = shell();
  if (!sh || typeof sh.lanScan !== 'function') { say('当前版本不支持局域网扫描'); return false; }
  let res = null;
  try { res = sh.lanScan('rooms', ''); } catch (e) {
    onState('idle', [], '扫描失败，请稍后重试');
    return false;
  }
  if (res == null) { say('需更新 APK 后生效'); return false; }
  if (window.__SP_LAN && typeof window.__SP_LAN.begin === 'function') window.__SP_LAN.begin();
  onState('scanning', [], '');
  return true;
}

/** 加入一个扫描到的房间。ctx: { say, onClose }。true = 已切到该 origin。 */
/** 「匹配」：扫一遍局域网，加入扫到的第一个可用房间（业主 2026-10-13：匹配按钮放在房间列表旁边）。
 *  审计说明：全仓原本**没有**任何匹配实现，所以这是新行为，语义按「尽快帮我找一局」取最保守的一种。
 *  扫描复用 scanLan，加入复用 joinLan —— 不新增第二条连接路径。 */
export function matchLan(ctx) {
  const c = ctx || {};
  const say = typeof c.say === 'function' ? c.say : noop;
  scanLan({
    state: 'idle',
    say: say,
    onState: function (st, rooms) {
      if (st !== 'done') return;
      if (!rooms || !rooms.length) { say('没扫到可加入的房间'); return; }
      joinLan(rooms[0], c);
    },
  });
}

// ---- 线上匹配（业主 2026-10-13：主页「匹配」= 自动加入默认配置 json 里的互通服务器 → 创房间 → 公开）---
// 语义按业主口径落地：默认配置 json（tools/apk/shell/servers.json，真源经 window.shell.getServerList()
// 到页面）里所有 enabled 的互通服务器都是候选；点「匹配」= 挑一台 → 切过去 → 自动创房间并公开。
//
// 为什么这里只做「挑场地 + 切服」，创建与公开交给 lobby.js 的待办钩子：
// 建房要 net.request('room.create')，那是**目标 origin 的页面**才有的实例（切服会重载，本页的 net
// 立刻失效）。lobby.js 已有这条链：写 sp.match.pending 待办 → 切服 → 落地钩子 doPendingCreate 消费
// （lobby.js:1696 / 1746）。复用它 = 不新增第二条建房路径。

/** 读服务器清单（与 first-screen.js 的 readServerListInline 同一口径：native 优先，网页回退）。 */
export function readServerEntries() {
  try {
    if (window.shell && typeof window.shell.getServerList === 'function') {
      const o = JSON.parse(window.shell.getServerList());
      if (o && Array.isArray(o.entries)) return o.entries;
    }
  } catch (e) { /* 拿不到就返回空 */ }
  try {
    const r = window.__SP_SHELL && typeof window.__SP_SHELL.getServers === 'function'
      ? window.__SP_SHELL.getServers() : null;
    const arr = typeof r === 'string' ? JSON.parse(r) : r;
    if (Array.isArray(arr)) return arr;
  } catch (e) { /* ignore */ }
  return [];
}

/** 语义化版本比较（"0.1.10" > "0.1.9"；缺失位按 0）。与 lobby.js 的 cmpApp 同一口径。 */
function cmpApp(a, b) {
  const pa = String(a || '').split('.');
  const pb = String(b || '').split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = parseInt(pa[i] || '0', 10) || 0;
    const vb = parseInt(pb[i] || '0', 10) || 0;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

// ---- 服务器清单的排序与延迟档（业主 2026-10-14：按延迟排序、绿/黄/红、离线不显示）--------------
// 纯函数，两个 UI（首页第一界面 / 悬浮窗面板）共用同一份口径 —— 免得两处各排各的、看出不同的顺序。
// 阈值与 shellPanels.js 的 rttDot 逐字一致（<250 良好 / <900 一般 / 其余较差），那套数字是
// 「国内直连 ~60ms、CF 前置 1–3s」下定的，改这里等于改两处的颜色语义。

/** 一台服务器的延迟档：'ok' | 'warn' | 'bad' | 'dead' | 'unknown'。 */
export function serverLevel(e) {
  const o = e || {};
  if (o.enabled === false) return 'dead';                       // 已停用
  const ms = Number(o.rttMs);
  if (!isFinite(ms) || ms <= 0) return o.reachable === false ? 'dead' : 'unknown';
  if (ms < 250) return 'ok';
  if (ms < 900) return 'warn';
  return 'bad';
}

/** 清单里该显示的服务器：**离线（停用 / 探过不可达）不显示**，其余按延迟升序（未知排最后），
 *  同延迟按名字稳定排序（免得每次刷新顺序跳）。返回新数组，不改入参。 */
export function visibleServers(entries) {
  const arr = Array.isArray(entries) ? entries : [];
  const keep = [];
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    if (!e || typeof e !== 'object') continue;
    const lv = serverLevel(e);
    if (lv === 'dead') continue;                                 // 离线不显示
    // 2026-10-17 业主：**未探测到版本号**的服务器不列出。必须带 probed 守卫 ——
    // 探测在途时 probed 还是 false，不加守卫整张表会在启动瞬间塌缩。
    if (e.probed === true && !e.app) continue;
    const ms = Number(e.rttMs);
    keep.push({ e: e, lv: lv, ms: (isFinite(ms) && ms > 0) ? ms : Infinity, name: String(e.name || e.id || '') });
  }
  keep.sort(function (a, b) {
    if (a.ms !== b.ms) return a.ms - b.ms;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return keep.map(function (x) { return x.e; });
}

/** 本机服务 / 自动线路永不做场地（它们进不了公共大厅，见 lobby.js INTERNAL_SERVER_IDS）。 */
const INTERNAL_IDS = { 'sp-phone-host': 1, local: 1, auto: 1 };

/** 纯函数：从服务器清单里挑一台可做场地的服务器。口径与 lobby.js 的 pickVenue 逐条一致 ——
 *  排除停用 / 房间制 / 本机与自动线路 / 无版本号 / 已探测且不可达；排序 = 版本 desc → 延迟 asc。
 *  可注入 list 以便测试（不依赖桥）。 */
export function pickMatchVenue(list) {
  const arr = Array.isArray(list) ? list : readServerEntries();
  const cand = [];
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    if (!e || !e.id) continue;
    if (e.enabled === false || e.roomScoped) continue;
    if (INTERNAL_IDS[String(e.id).toLowerCase()]) continue;
    if (!e.app) continue;                                       // 无版本号不选
    if (e.probed === true && e.reachable === false) continue;   // 探测过且不可达
    cand.push(e);
  }
  cand.sort(function (a, b) {
    const c = cmpApp(b.app, a.app);
    if (c) return c;
    const ar = Number(a.rttMs) > 0 ? Number(a.rttMs) : 1e9;
    const br = Number(b.rttMs) > 0 ? Number(b.rttMs) : 1e9;
    return ar - br;
  });
  return cand[0] || null;
}

/** 写「切服后自动建房」待办。三处都写，因为**切服会换 origin**，而 localStorage 是按 origin 隔离的：
 *   ① window.__SP_PREFS（player-v1 doc.prefs）—— 跨 origin **真源**，切服重载后仍读得到（v8.0 通道）；
 *   ② player-data 的 recordMatchPending —— 跨 origin 通道（当前实现是 no-op，保留只为兼容旧树）；
 *   ③ localStorage —— 同 origin 兜底（网页版无 vault 时唯一可用的载体）。
 *  lobby.js 的 readPendingAny 按同样顺序读。ts 必须是**绝对**时间戳：lobby.js 用它判 10 分钟
 *  过期（wallNow 口径 ≈ Date.now()）。
 *  业主 2026-10-13：带 public:true —— 落地处据此把新房公开到大厅（见 lobby.js doPendingCreate）。 */
export function writeMatchPending(venueId, opts) {
  const o = opts || {};
  const pending = {
    difficulty: String(o.difficulty || ''),
    venueId: String(venueId || ''),
    public: o.public !== false,
    ts: Date.now(),
  };
  let stored = false;
  try {
    stored = !!(window.__SP_PREFS && typeof window.__SP_PREFS.set === 'function'
      && window.__SP_PREFS.set('match.pending', pending));
  } catch (e) { stored = false; }
  if (!stored) {
    try {
      stored = !!(window.__SP_DATA && typeof window.__SP_DATA.recordMatchPending === 'function'
        && window.__SP_DATA.recordMatchPending(pending));
    } catch (e) { stored = false; }
  }
  if (!stored) {
    try { localStorage.setItem('sp.match.pending', JSON.stringify(pending)); } catch (e) { /* 无存储 */ }
  }
  return pending;
}

/** 「匹配」（线上）：挑一台互通服务器 → 写待办（自动建房 + 公开）→ 切过去 → 布防自动进入。
 *  建房与公开由 lobby.js 的落地钩子在**目标 origin 的页面**上完成（切服会重载，本页什么都做不了）。
 *  ctx: { say, onClose }。返回 true = 已发起。 */
export function matchOnline(ctx) {
  const c = ctx || {};
  const say = typeof c.say === 'function' ? c.say : noop;
  const venue = pickMatchVenue();
  if (!venue) { say('没有可用的互通服务器（本机服务不能作为匹配场地）'); return false; }
  writeMatchPending(venue.id, { public: true });
  const sh = shell();
  if (sh && typeof sh.setServer === 'function') {
    try { sh.setServer(String(venue.id)); } catch (e) { say('连接失败'); return false; }
    // 切服重载后由标题页 takeAutostart 消费一次 → 自动进入（与 shellPanels.switchTo 同款布防）
    try { if (typeof sh.setAutostart === 'function') sh.setAutostart(); } catch (e) { /* 旧壳 */ }
    if (typeof c.onClose === 'function') c.onClose();
    say('正在加入「' + String(venue.name || venue.id) + '」并创建房间…');
    return true;
  }
  // 网页回退（无原生壳）：只有拿到 url 才能跳
  const url = String(venue.url || '');
  if (!url) { say('无法获取该线路地址，请用手输地址'); return false; }
  try { window.location.href = url; return true; } catch (e) { say('无法跳转'); return false; }
}

export function joinLan(r, ctx) {
  const c = ctx || {};
  const say = typeof c.say === 'function' ? c.say : noop;
  if (!r) return false;
  const sh = shell();
  if (!sh || typeof sh.joinOnOrigin !== 'function') { say('当前版本不支持局域网加入'); return false; }
  const id = 'lan:' + String(r.ip || '') + ':' + (Number(r.port) || 0);
  let ok = true;
  try { ok = sh.joinOnOrigin(id, String(r.code || '').toUpperCase()) !== false; } catch (e) { ok = false; }
  if (ok) {
    if (typeof c.onClose === 'function') c.onClose();
    autoPreload(); // 业主 2026-10-15：进入即开跑预载（不再只弹提示）。切服已由 joinOnOrigin 布防自动进入。
    return true;
  }
  say('加入失败：目标房间不可达');
  return false;
}

/** 本机服务：按需启动本机房主服务并切过去。这是**唯一**会拉起内置 Node 的动作
 *  （业主 2026-10-11：房主不得开机即起，否则与预载抢首帧、冻住第一屏）。 */
export function startLocal(ctx) {
  const c = ctx || {};
  const say = typeof c.say === 'function' ? c.say : noop;
  const toast = typeof c.toast === 'function' ? c.toast : noop;
  const sh = shell();
  if (!sh) { say('当前页面不支持本地服务'); return false; }
  try {
    if (typeof sh.startLocalService === 'function') sh.startLocalService();
    else if (typeof sh.setServer === 'function') sh.setServer('local');
    else { say('当前版本不支持本地服务'); return false; }
  } catch (e) { say('本地服务启动失败'); return false; }
  try { toast('本地服务启动中…'); } catch (e) { /* no kit */ }
  if (typeof c.onClose === 'function') c.onClose();
  autoPreload(); // 业主 2026-10-15：进入即开跑预载（第一界面不会重弹 —— 见 shell-bridge 的跨 origin 标记）
  return true;
}

/** 加入线上（自定义地址）：直连该地址。**故意不提交**到房间板 / 服务器清单站
 *  （业主 2026-10-11）—— 这是一次性、本机私有的连接。 */
/** 加入**签名清单里的服务器**（业主 2026-10-13 修 bug）：必须走 `shell.setServer(条目 id)` ——
 *  Java 侧 findEntry(id) 找的是签名清单条目。**不能**走 joinCustom：那是给手输地址用的，
 *  它会把值当域名拼成 `https://<值>/`，把条目 id 当主机名 ⇒ DNS 解析失败（实测线上报错页）。
 *  shellPanels.switchTo 的 native 分支就是这三步（setServer + armAutostart + close），这里取前两步，
 *  自动开始交给调用方（第一界面的「进入游戏」本来就会关层）。 */
export function joinServerRow(row, ctx) {
  const c = ctx || {};
  const say = typeof c.say === 'function' ? c.say : noop;
  if (!row || row.enabled === false) { say('该线路已停用'); return false; }
  // 2026-10-14（业主：点「加入服务器」时提示页要保持悬浮窗叠加）：切服前记一条待办。
  // 目标服连不上时，MainActivity 会回退到**本地树**（那条链上我们的外壳是注入的），下一个页面的
  // 落地检查读到这条待办，就用**我们自己的层**（notice-board 的顶部条）报「没连上」——
  // 提示是我们画的，悬浮窗按层序天然在它之上。远端 4xx 走 WebView 原生渲染、拿不到注入，
  // 那种页面本就无法承载任何叠加层（见 2026-10-14 审计），这里覆盖的是"回得来"的那条主路径。
  try {
    if (localStorage) localStorage.setItem('sp.join.pending', JSON.stringify({ id: String(row.id || ''), name: String(row.name || row.id || ''), ts: Date.now() }));
  } catch (e) { /* 无存储：只是少了这条提示 */ }
  const sh = shell();
  const id = String(row.id || '');
  if (sh && typeof sh.setServer === 'function' && id) {
    try { sh.setServer(id); } catch (e) { say('连接失败'); return false; }
    if (typeof c.onClose === 'function') c.onClose();
    autoPreload();    // 业主 2026-10-15：进到服务器即开跑预载
    return true;
  }
  // 网页回退（无原生壳）：只有拿到 url 才能跳
  const url = String(row.url || '');
  if (!url) { say('无法获取该线路地址，请用手输地址'); return false; }
  try { window.location.href = url; return true; } catch (e) { say('无法跳转'); return false; }
}

export function joinCustom(addr, ctx) {
  const c = ctx || {};
  const say = typeof c.say === 'function' ? c.say : noop;
  const toast = typeof c.toast === 'function' ? c.toast : noop;
  let v = String(addr == null ? '' : addr).trim();
  if (!v) { say('请输入服务器地址'); return false; }
  if (!/^https?:\/\//.test(v)) v = 'https://' + v;
  v = v.replace(/\/+$/, '');
  const sh = shell();
  if (!sh || typeof sh.setServer !== 'function') { say('当前版本不支持自定义服务器'); return false; }
  try { sh.setServer('custom:' + v); } catch (e) { say('连接失败：地址无效'); return false; }
  try { toast('正在连接 ' + v); } catch (e) { /* no kit */ }
  if (typeof c.onClose === 'function') c.onClose();
  autoPreload();   // 业主 2026-10-15：进入即开跑预载
  return true;
}

/** 复制本机房间链接（业主 2026-10-11：复制出去的链接用当前局域网地址，优先虚拟局域网）。 */
export function copyRoomLink(ctx) {
  const c = ctx || {};
  const say = typeof c.say === 'function' ? c.say : noop;
  const url = localRoomUrl(currentRoomCode());
  if (!url) { say(shell() ? '尚未取得本机地址，请先进入本地服务' : '当前页面不支持复制链接'); return false; }
  copyText(url).then((ok) => say(ok ? '已复制房间链接：' + url : '复制失败，请手动复制：' + url));
  return true;
}
