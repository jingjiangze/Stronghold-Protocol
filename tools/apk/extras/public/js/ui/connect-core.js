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
 * 进入线路后的预载提示（业主 2026-10-12：「进入服务器和本地服务或局域网后提示预载资源窗口」）。
 * 只**提醒**、不代跑：三条进入路径（startLocal / joinCustom / joinLan）各自调它，再由 preload
 * 中心弹它自己的面板（window.__SP_PRELOAD.open()）——提示与开启仍是两个动作，玩家可忽略。
 */
export function hintPreload() {
  try {
    const p = window.__SP_PRELOAD;
    if (p && typeof p.open === 'function') { p.open(); return true; }
  } catch (e) { /* no preload center */ }
  try { if (openPanel('preload')) return true; } catch (e) { /* no panel host */ }
  return false;
}

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
    hintPreload(); // 业主 2026-10-12：进入后提示预载
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
  hintPreload(); // 业主 2026-10-12：进入后提示预载（只提醒，由玩家决定）
  return true;
}

/** 加入线上（自定义地址）：直连该地址。**故意不提交**到房间板 / 服务器清单站
 *  （业主 2026-10-11）—— 这是一次性、本机私有的连接。 */
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
  hintPreload(); // 业主 2026-10-12：进入后提示预载
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
