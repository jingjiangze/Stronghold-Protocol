/* global window, document, location */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here
// js/ui/shellPanels.js — in-page shell panels styled exactly like the game's own settings modal
// (Modal frame + .set-list/.set-row/.set-seg — same components the QUALITY row uses).
// Panels: 服务器 (line switching), 参数 (host-server parameters, App only), 配置 (player-data
// summary + export/import), 战绩 (local battle log) and 设置 (our own appearance items). The host
// (ShellPanelHost) is mounted by mountShellPanelHost() from the overlay itself (lobby.js calls it
// after the deps are ready); it no longer depends on a build-time patch into upstream js/main.js.
// Domains are never shown: lines are identified by name only.
//
// v7.4 依赖加固（审计-上游冲突面-2026-10-08.md §3.2 M1–M4 / R-03）：这四条原来是**静态 ESM import**，
// 上游一旦改名/搬走（components.js / toasts.js / store.js / vendor/hooks.module.js），本模块**加载即失败**，
// 于是服务器/参数/配置/战绩四个面板整块静默消失（lobby.js 的 .catch 把它吞成「面板不可用」）。
// 现在改成**动态 import + 逐模块本地垫片**：任何一条拿不到，只降级它自己需要的东西，模块照样加载、
// 其它面板照样可用；depsReport() 说明每个依赖实际来自哪里（upstream / fallback / shim）。
let useEffect;
let useState;
let html;
let Modal;
let Button;
let MicroLabel;
let toast;
let store;

/** 每个依赖实际来源：'upstream' | 'fallback' | 'shim'（诊断 + 测试）。 */
const depsSource = { hooks: 'shim', components: 'shim', toasts: 'shim', store: 'shim' };

/** 最小 hooks 垫片：静态渲染一次。真反应式需要 preact 的 hooks；拿不到时面板仍能渲染而不是整块消失。 */
function shimUseState(initial) { return [typeof initial === 'function' ? initial() : initial, function () {}]; }
function shimUseEffect() {}

/** html 垫片（最后手段）：返回一个带标记的普通对象，绝不抛。只有连 vendor/htm.module.js 都没有时才用到。 */
function shimHtml(strings) {
  const parts = [];
  for (let i = 0; i < strings.length; i++) {
    parts.push(strings[i]);
    if (i + 1 < arguments.length) parts.push(arguments[i + 1]);
  }
  return { __spDegraded: true, parts };
}

/** toast 垫片：console + 自绘提示（无 ToastHost 时也不静默）。 */
function shimToast(text) {
  const msg = String(text == null ? '' : text);
  try { if (typeof console !== 'undefined' && console.log) console.log('[shell] ' + msg); } catch (e) { /* ignore */ }
  try {
    if (typeof document === 'undefined' || !document.body || !msg) return;
    const el = document.createElement('div');
    el.className = 'sp-toast-fallback';
    el.setAttribute('role', 'status');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;left:50%;bottom:14%;transform:translateX(-50%);z-index:2147483000;'
      + 'padding:8px 14px;border-radius:6px;background:rgba(12,20,17,.92);color:#d8e3de;'
      + 'border:1px solid #2c3a35;font-size:13px;pointer-events:none';
    document.body.appendChild(el);
    setTimeout(() => { try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) { /* ignore */ } }, 2600);
  } catch (e) { /* 没有 DOM（测试）：只留 console */ }
}

/** store 垫片：get() 恒返回空对象 —— inMatch() 退化为 false（对局中可切服），但面板照常渲染。 */
const shimStore = { get: function () { return {}; } };

/** Modal / Button / MicroLabel 垫片：用当前可用的 html 自绘最小实现。 */
function makeModal() {
  return function ModalShim(props) {
    const p = props || {};
    return html`<div class="modal" role="presentation"
      style="position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147482000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)">
      <div class="modal__body" style="max-width:92vw;max-height:86vh;overflow:auto;padding:12px;background:#0f1815;border:1px solid #2c3a35;border-radius:6px">
        ${p.title ? html`<h2 class="modal__title">${p.title}</h2>` : null}
        ${p.children}
      </div>
    </div>`;
  };
}
function makeButton() {
  return function ButtonShim(props) {
    const p = props || {};
    return html`<button type="button" class=${'btn btn--' + (p.variant || 'secondary')}
      disabled=${!!p.disabled} onClick=${p.onClick}>${p.children}</button>`;
  };
}
function makeMicroLabel() {
  return function MicroLabelShim(props) {
    const p = props || {};
    return html`<span class="micro-label">${p.children}</span>`;
  };
}

/** 初始化到垫片，保证「依赖还没落地就渲染」也不会 TypeError（降级渲染而不是整块消失）。 */
function installShims() {
  useEffect = shimUseEffect;
  useState = shimUseState;
  html = shimHtml;
  toast = shimToast;
  store = shimStore;
  Modal = makeModal();
  Button = makeButton();
  MicroLabel = makeMicroLabel();
}
installShims();

/** html 回退：components.js 拿不到时，直接用上游的 htm + preact 现绑一个（仍然渲染真 vnode）。 */
async function loadHtmlFallback() {
  try {
    const [htmMod, preactMod] = await Promise.all([
      import('../../vendor/htm.module.js'),
      import('../../vendor/preact.module.js'),
    ]);
    const htm = htmMod.default || htmMod;
    const h = preactMod.h || (preactMod.default && preactMod.default.h);
    if (typeof htm === 'function' && typeof h === 'function') return { html: htm.bind(h), source: 'fallback' };
  } catch (e) { /* fall through to the stub */ }
  return { html: shimHtml, source: 'shim' };
}

/** 逐个解析依赖：任何一个失败都只影响它自己，绝不抛出、绝不让模块加载失败。 */
async function loadDeps() {
  // hooks（useEffect / useState）
  try {
    const m = await import('../../vendor/hooks.module.js');
    if (typeof m.useState === 'function' && typeof m.useEffect === 'function') {
      useState = m.useState;
      useEffect = m.useEffect;
      depsSource.hooks = 'upstream';
    }
  } catch (e) { /* keep the shim */ }
  if (depsSource.hooks !== 'upstream') {
    const g = globalThis.__SP_HOOKS; // lobby.js / home-layer.js 已成功导入过 hooks 时回填
    if (g && typeof g.useState === 'function' && typeof g.useEffect === 'function') {
      useState = g.useState;
      useEffect = g.useEffect;
      depsSource.hooks = 'fallback';
    }
  }
  // components（html / Modal / Button / MicroLabel）
  try {
    const m = await import('./components.js');
    if (typeof m.html === 'function' && typeof m.Modal === 'function'
        && typeof m.Button === 'function' && typeof m.MicroLabel === 'function') {
      html = m.html;
      Modal = m.Modal;
      Button = m.Button;
      MicroLabel = m.MicroLabel;
      depsSource.components = 'upstream';
    }
  } catch (e) { /* keep the shim */ }
  if (depsSource.components !== 'upstream') {
    const r = await loadHtmlFallback();
    html = r.html;
    Modal = makeModal();
    Button = makeButton();
    MicroLabel = makeMicroLabel();
    depsSource.components = r.source;
  }
  // toasts（toast）
  try {
    const m = await import('./toasts.js');
    if (typeof m.toast === 'function') { toast = m.toast; depsSource.toasts = 'upstream'; }
  } catch (e) { /* keep the shim */ }
  // store（store.get().room.inMatch）
  try {
    const m = await import('../store.js');
    if (m.store && typeof m.store.get === 'function') { store = m.store; depsSource.store = 'upstream'; }
  } catch (e) { /* keep the shim */ }
  if (depsSource.store !== 'upstream') {
    const s = globalThis.__SP__ && globalThis.__SP__.store; // 上游 main.js 暴露的同一单例
    if (s && typeof s.get === 'function') { store = s; depsSource.store = 'fallback'; }
  }
  return depsSource;
}

/** 依赖解析完成的信号：lobby.js 在注册/渲染面板前 await 它，保证首帧就用真组件。 */
export const depsReady = loadDeps();
export function whenDepsReady() { return depsReady; }
/** 诊断：每个依赖实际来自哪里（'upstream' | 'fallback' | 'shim'）。 */
export function depsReport() { return Object.assign({}, depsSource); }

/** v4.0: 构造跳转 URL —— 保留目标 origin/pathname，合并当前页查询（room 可覆盖），`#` 始终最后。
 *  统一替代旧的 `url.replace(/\/+$/,'') + '/' + location.search`（在 /play 上补回 `/` 产生 404）。 */
function navUrl(base, room) {
  const u = new URL(String(base || ''), location.href);
  new URLSearchParams(location.search).forEach((v, k) => u.searchParams.set(k, v));
  if (room != null) u.searchParams.set('room', String(room));
  return u.toString();
}

/** v4.1: 延迟色点 —— 不再显示数值，返回 { color, title }。
 *  已停用灰 / 不可达红 / 未知灰 / <150ms 绿 / <400ms 黄 / 其余红（title 不写 ms）。 */
function rttDot(ms, enabled, reachable) {
  if (enabled === false) return { color: '#8a9a93', title: '已停用' };
  if (!Number.isFinite(ms) || ms <= 0) {
    if (reachable === false) return { color: '#e06c5a', title: '无法连接' };
    return { color: '#8a9a93', title: '延迟未知' };
  }
  // v5.3 阈值与大厅网格同步（国内直连 ~60ms、CF 前置 1–3s；旧 150/400 会把 CF 生态全标红）
  if (ms < 250) return { color: '#4ed8af', title: '延迟良好' };
  if (ms < 900) return { color: '#e0b64a', title: '延迟一般' };
  return { color: '#e06c5a', title: '延迟较差' };
}

/** True while a match is running — the shell bans server switching from start to finish. */
function inMatch() {
  try {
    return !!(store.get().room && store.get().room.inMatch);
  } catch (e) {
    return false;
  }
}

// ---- v8.0: shell-prefs namespace (cross-origin shell settings) -----------------------------------
// The last/custom server choice and the transport tier are mirrored through window.__SP_PREFS
// (player-v1 doc.prefs) so they survive switching servers. On the App the Java bridge stays the
// authority (SharedPreferences already persist); the vault is the page-side record + the web fallback.

/** Write one shell pref through (silent when the namespace is absent). */
function rememberPref(key, value) {
  try {
    if (window.__SP_PREFS && typeof window.__SP_PREFS.set === 'function') window.__SP_PREFS.set(key, value);
  } catch (e) { /* ignore */ }
}

/** Read one shell pref (null when the namespace is absent). */
function readPref(key) {
  try {
    if (window.__SP_PREFS && typeof window.__SP_PREFS.get === 'function') return window.__SP_PREFS.get(key);
  } catch (e) { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// 服务端界面（「用该服自有客户端」，业主口径 2026-10-08）—— **默认开**，设置面板里可改回本地客户端。
//
// 借 Paper-Yuan 的做法：**页面与静态资源都走服务端 origin**（浏览器缓存提速），UI/玩法自然与该服一致。
// 外壳本来就有这条链：MainActivity.remoteClientFor(host)（pref `remote-client:<host>`，MainActivity.java:799）
// + 桥 useRemoteClient(id, on)（同文件 :3445）。缺的只是「界面可用的开关 + 默认值」。
//
// 已审计的语义（每条都有测试钉住，见 tools/apk/remote-client.test.mjs）：
//   • id = **签名清单条目 id**（ServerList.Entry.id），不是 host：Java 侧 findEntry(id) 找条目、
//     hostOfEntry(id) 自己解析 host，域名永远不下发到页面（MainActivity.java:3305/3437）。
//     因此自定义线路（custom:…）、局域网房间、本机服务/自动线路都**没有条目** → 桥是空操作 →
//     这里必须禁用并给出原因，绝不假装成功（这也就是「没有自有客户端的服回退本地树」）。
//   • 生效时机（切换即重载，无需用户手动刷新）：on=true → setRemoteClient(host,true) + applyOrigin(该服 url)
//     （切服并导航，该服页面 + 资源接管）；on=false → 若当前就在该 host 上则 web.reload()（就地回到本地树），
//     否则只写 pref（下次进入该服生效）。
//   • 拦截器语义：remoteClientFor(host) 为真时 shouldInterceptRequest 直接放行到网络（MainActivity.java:1837）
//     —— 本地树完全不参与，这就是「服务端资源优先」。
//   • 兜底（已成立，无需补）：开启后该服不可达 → 主帧 onReceivedError → ensureHostAndSwitch（本地服务）
//     (MainActivity.java:2123)，落在 127.0.0.1 —— 它不是已知服务器 host → 本地树接管。
//   • 安全：只有签名清单条目可开（ServerList.isPublicHttpUrl 已拒 localhost/.local/.internal、环回/私有/
//     保留地址、userinfo 与非 http(s)；ServerList.java:860）；页面拿不到 URL，也就构造不出任意 host。
//
// 能力门（APK 轴 —— 详见交付报告）：默认值与安全退出口都需要新 APK：
//   ① remoteClientFor 的 pref 缺省是 **false**（要「默认开」必须 Java 改缺省，且只对已知服务器 host 生效）；
//   ② 开启后远程客户端路径跳过 SHELL_INJECT → 页内没有外壳界面（面板/设置都点不到），而 origin 与 pref
//      都会持久化 → 冷启动再次直连该服；页内唯一的退出口是原生菜单（showShellMenu 的「回到本地客户端」），
//      那是新 APK 才有的；
//   ③ 本地树不再渲染 → Updater.markHealthy 永不消费 pending 标记 → 下一次冷启动把热更内容回滚
//      （健康/回滚机制假定本地树至少渲染过一次）—— 这一条必须与 ① 一起改。
//   所以：**开启方向**只在原生提供退出口时可用（`window.__SP_SHELL.remoteClientEscape`，shell-bridge.js
//   探测 `shell.remoteClientCurrent` 得到）；旧 APK 上显示禁用 + 原因，绝不把用户锁在服务器页里。
//   **关闭方向**永远可用 —— 它是退路，不能被门反过来挡住。
// ---------------------------------------------------------------------------------------------------

/** 偏好键：与上游 store.js loadPref/savePref 同构（localStorage `sp.pref.<key>`，JSON 值），
 *  以便「设置跨源持久化」把同一命名空间的偏好统一接管。 */
export const REMOTE_CLIENT_PREF = 'remoteClient';
const REMOTE_CLIENT_LS = 'sp.pref.' + REMOTE_CLIENT_PREF;

/** 用户偏好：true = 优先使用服务器自带界面（**默认**）；false = 本地客户端优先。绝不抛。 */
export function readRemoteClientPref() {
  try {
    const raw = typeof window !== 'undefined' && window.localStorage
      ? window.localStorage.getItem(REMOTE_CLIENT_LS) : null;
    if (raw == null) return true; // 默认：服务端界面优先
    return JSON.parse(raw) !== false;
  } catch (e) { return true; }
}

/** 写入偏好（幂等、可逆）。返回是否写成功。新 APK 上同时把全局默认值交给 Java 的拦截器。 */
export function writeRemoteClientPref(on) {
  const v = on !== false;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(REMOTE_CLIENT_LS, JSON.stringify(v));
    }
  } catch (e) { /* 隐私模式 / 配额：偏好仍在本进程内生效 */ }
  const caps = remoteClientCaps();
  if (caps.default) { // APK 轴：让 remoteClientFor 的缺省来源跟着设置走
    try {
      if (typeof window.__SP_SHELL.setRemoteClientDefault === 'function') window.__SP_SHELL.setRemoteClientDefault(v);
      else window.shell.setRemoteClientDefault(v);
    } catch (e) { /* 老壳忽略 */ }
  }
  return true;
}

/** 原生能力探测（只读、绝不抛）。app=有外壳桥；bridge=桥提供 useRemoteClient；
 *  escape=有原生退出口（新 APK）；default=能把全局默认值交给 Java（新 APK）。
 *  两处都查：shell-bridge.js 的适配层优先，退一步直接看 window.shell 的原生方法（适配层没装载时）。 */
export function remoteClientCaps() {
  const at = (name) => {
    try { return (typeof window !== 'undefined' && window[name]) || null; } catch (e) { return null; }
  };
  const sh = at('shell');
  const shell = at('__SP_SHELL');
  const has = (o, n) => !!(o && typeof o[n] === 'function');
  return {
    app: !!sh,
    bridge: has(shell, 'useRemoteClient') || has(sh, 'useRemoteClient'),
    escape: (shell && shell.remoteClientEscape === true) || has(sh, 'remoteClientCurrent'),
    default: has(shell, 'setRemoteClientDefault') || has(sh, 'setRemoteClientDefault'),
  };
}

/** 调桥（适配层优先，退化到原生方法）。返回是否调用成功（绝不抛）。 */
function callUseRemoteClient(id, on) {
  try {
    if (typeof window !== 'undefined' && window.__SP_SHELL
      && typeof window.__SP_SHELL.useRemoteClient === 'function') {
      return !!window.__SP_SHELL.useRemoteClient(id, on);
    }
  } catch (e) { /* 退化到原生方法 */ }
  try {
    if (typeof window !== 'undefined' && window.shell
      && typeof window.shell.useRemoteClient === 'function') {
      window.shell.useRemoteClient(id, on);
      return true;
    }
  } catch (e) { /* 桥不可用 */ }
  return false;
}

/** 当前**实际生效**的是哪一种（要求：UI 上可见）：'on' | 'off' | 'unknown'。
 *  优先问原生（权威 —— 拦截器读的就是这个 pref），退化到清单里当前条目的 remoteClient 标注。 */
export function remoteClientEffective() {
  try {
    if (typeof window !== 'undefined' && window.shell
      && typeof window.shell.remoteClientCurrent === 'function') {
      return String(window.shell.remoteClientCurrent()) === '1' ? 'on' : 'off';
    }
  } catch (e) { /* 老壳：退化到清单标注 */ }
  try {
    const list = readServerList();
    const cur = (list.entries || []).find((e) => e && e.current && e.id !== 'local' && e.id !== 'auto');
    if (cur) return cur.remoteClient ? 'on' : 'off';
  } catch (e) { /* ignore */ }
  return 'unknown';
}

/** 纯判定（可测）：这一行能不能操作服务端界面开关；不能时给出**用户看得懂的原因**。
 *  ok = 开关本身可用；onOk = 「开」这个方向安全（需要原生退出口）。 */
export function remoteClientGate(row, caps) {
  const r = row || {};
  const c = caps || remoteClientCaps();
  const blocked = (reason) => ({ ok: false, reason, onOk: false, onReason: reason });
  if (!c.app) return blocked('仅在 App 内可用：网页版始终使用本地界面。');
  if (!c.bridge) return blocked('当前 App 版本不支持该开关（需更新 App）。');
  if (r.roomScoped) return blocked('房间制服务器由该服自有客户端进入，不在此切换。');
  if (!r.id || r.id === 'local' || r.id === 'auto' || r.id === 'custom') {
    return blocked('该线路没有自有客户端（本机服务 / 自动线路 / 自定义线路）—— 自动使用本地界面。');
  }
  if (!r.signed) return blocked('不在签名服务器清单内（自定义 / 局域网线路）—— 自动使用本地界面。');
  if (r.enabled === false) return blocked('该服务器已停用。');
  if (r.locked) return blocked('对局进行中，无法切换服务器。结束后再切换。');
  return {
    ok: true,
    reason: '',
    onOk: !!c.escape,
    onReason: c.escape ? '' : '需更新 App：当前版本开启后页内无法关闭（会停在服务器页面里），暂不能开启。',
  };
}

/** 纯决策（可测）：这次点击该做什么。ok=false 时 note 就是原因（面板原样显示）。
 *  on = 取反（幂等：点两次回到原状态，且**不会**对同值重复调桥）。 */
export function remoteClientPlan(row, caps) {
  const r = row || {};
  const name = String(r.name || r.label || r.id || '该服务器');
  const gate = remoteClientGate(r, caps);
  if (!gate.ok) return { ok: false, on: !!r.remoteClient, id: '', note: gate.reason };
  const on = !r.remoteClient;
  if (on && !gate.onOk) return { ok: false, on: false, id: String(r.id || ''), note: gate.onReason };
  return {
    ok: true,
    on,
    id: String(r.id || ''),
    note: on
      ? '已开启：' + name + ' 的页面与资源改由该服务器提供，页面即将重新加载…'
      : (r.current
        ? '已关闭：页面即将重新加载，回到本地界面…'
        : '已关闭：下次进入 ' + name + ' 时使用本地界面。'),
  };
}

/** 执行一次切换（薄封装：只调桥，桥异常返回 false）。返回 { ok, note }。 */
function applyRemoteClient(row, caps, setNote) {
  const plan = remoteClientPlan(row, caps);
  if (typeof setNote === 'function') setNote(plan.note);
  if (!plan.ok) return { ok: false, note: plan.note };
  const done = callUseRemoteClient(plan.id, plan.on) === true;
  if (!done && typeof setNote === 'function') setNote('切换失败，请重试（或更新 App）。');
  return { ok: done, note: done ? plan.note : '切换失败，请重试（或更新 App）。' };
}

/** 服务端界面开关（按服）：开=薄荷「服端」，关=灰「本地」；不可用时禁用 + title 就是原因。
 *  独立于 .sp-srv-main 的兄弟节点（绝不嵌套按钮），所以点它不会顺带切服。 */
function remoteClientChip(e, gate, onToggle) {
  const on = !!e.remoteClient;
  // 关闭方向永远可用（它是退路）；开启方向需要原生退出口（gate.onOk）。
  const usable = !!(gate && gate.ok && (on || gate.onOk));
  const reason = String((gate && (gate.ok ? gate.onReason : gate.reason)) || '不可用');
  const title = usable
    ? (on
      ? '正在用该服自有客户端：页面与静态资源都来自该服务器（UI/玩法与该服一致）。点击改回本地界面。'
      : '点击改用该服自有客户端：页面与静态资源都来自该服务器（UI/玩法与该服一致；首屏每个文件要重新校验，略慢）。')
    : reason;
  return html`<button type="button" data-sp-rc=${String(e.id || '')}
    class=${'sp-srv-rc' + (on ? ' is-on' : '')}
    disabled=${!usable} title=${title}
    onClick=${() => { if (usable && typeof onToggle === 'function') onToggle(e); }}>${on ? '服端' : '本地'}</button>`;
}

/**
 * 服务器声明式配置的一行可见摘要（2026-10-08）。
 *
 * 服务端可以放 /stronghold-client.json（或 /.well-known/stronghold-client.json）声明公告 / 功能开关 /
 * 匹配参数；Java 侧（ServerConfigHub）取回校验后经桥交给页面（window.__SP_SERVER_CONFIG，只读）。
 * **解析到的东西必须在界面上看得见**，否则"服务端下发配置"等于不存在（业主口径：rainya 那边界面有
 * 同盟匹配、我方连一行声明都没有）。未声明时写明「未声明」+ 该放的文件名，让服务端知道怎么开。
 * 任何异常都退化成「未声明」，绝不打断面板渲染。
 */
function serverConfigLine() {
  let C = null;
  try {
    C = typeof window !== 'undefined' ? window.__SP_SERVER_CONFIG : null;
  } catch (e) {
    C = null;
  }
  if (!C || typeof C.version !== 'function') {
    return html`<p class="set-hint set-hint--tight">服务器配置：<b>未声明</b>（本页未加载 server-config 模块；APK 需 vc2003+）</p>`;
  }
  let v = 0, a = null, m = null, ids = [];
  try {
    v = Number(C.version()) || 0;
    a = typeof C.announce === 'function' ? C.announce() : null;
    m = typeof C.matchmaking === 'function' ? C.matchmaking() : null;
    const f = (C.get ? C.get() : null) || {};
    ids = (f.features && typeof f.features === 'object') ? Object.keys(f.features) : [];
  } catch (e) { /* 退化成「未声明」 */ }
  if (!v) {
    return html`<p class="set-hint set-hint--tight">服务器配置：<b>未声明</b>（服务端可放 <code>/stronghold-client.json</code> 下发公告 / 功能开关 / 匹配参数）</p>`;
  }
  const parts = [`v${v}`];
  if (a) parts.push(`公告：${a.title || '有'}`);
  if (ids.length) parts.push(`功能：${ids.slice(0, 3).join('/')}${ids.length > 3 ? '…' : ''}`);
  if (m) parts.push(`匹配：${m.enabled ? '开启' : '关闭'}`);
  return html`<p class="set-hint set-hint--tight">服务器配置：${parts.join(' · ')}</p>`;
}

/** Panel store: 'servers' | 'params' | 'join' | 'config' | 'records' | null, broadcast on a
 *  window event so the shell can drive it too. */
let panelState = null;
const listeners = new Set();

function setPanel(kind) {
  panelState = kind;
  for (const fn of listeners) fn(kind);
  try { window.dispatchEvent(new CustomEvent('sp-panel', { detail: kind })); } catch (e) { /* old browser */ }
}

export function openShellPanel(kind) {
  setPanel(kind);
}

export function useShellPanel() {
  const [kind, set] = useState(panelState);
  useEffect(() => {
    const fn = (k) => set(k);
    listeners.add(fn);
    const onEvt = (e) => set(e.detail || null);
    window.addEventListener('sp-panel', onEvt);
    return () => { listeners.delete(fn); window.removeEventListener('sp-panel', onEvt); };
  }, []);
  return [kind, () => setPanel(null)];
}

// ---------------------------------------------------------------------------------------------------
// Server switching (name-only list; URLs stay inside the shell)
// ---------------------------------------------------------------------------------------------------

function fmtRtt(ms) {
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) + 'ms' : '--';
}

/** 版本(app)：0.1.2 → v0.1.2；已带前缀就原样显示。 */
function fmtApp(app) {
  const s = String(app || '');
  if (!s) return '';
  return /^\d/.test(s) ? 'v' + s : s;
}

/** 清单更新时间（Java 侧新增 updated 字段后才显示；秒/毫秒/ISO 字符串都接受）。 */
function fmtUpdated(v) {
  if (v == null || v === '') return '';
  let d;
  if (typeof v === 'number' && Number.isFinite(v)) d = new Date(v < 1e12 ? v * 1000 : v);
  else d = new Date(v);
  if (!Number.isFinite(d.getTime())) return '';
  try { return d.toLocaleString('zh-CN', { hour12: false }); } catch (e) { return ''; }
}

// ---------------------------------------------------------------------------------------------------
// 玩家数据 v1（配置 / 战绩 面板的只读来源；导出/导入按钮）
// App：Java 桥 window.spData.get()（真源 filesDir/player-v1.json）；网页：window.__SP_DATA
// （player-data.js，IndexedDB/localStorage）。所有访问 try/catch 静默，面板永不打断游戏。
// ---------------------------------------------------------------------------------------------------

function readPlayerDoc() {
  const parse = (raw) => {
    try {
      const d = raw ? JSON.parse(raw) : null;
      return d && typeof d === 'object' ? d : null;
    } catch (e) { return null; }
  };
  try {
    if (window.spData && typeof window.spData.get === 'function') {
      const d = parse(window.spData.get());
      if (d) return d;
    }
  } catch (e) { /* no shell bridge */ }
  try {
    if (window.__SP_DATA && typeof window.__SP_DATA.exportJSON === 'function') {
      const d = parse(window.__SP_DATA.exportJSON());
      if (d) return d;
    }
  } catch (e) { /* no player-data module */ }
  return null;
}

/** The doc as text for the export button (same source order as readPlayerDoc). */
function exportPlayerJson() {
  try {
    if (window.__SP_DATA && typeof window.__SP_DATA.exportJSON === 'function') {
      const t = String(window.__SP_DATA.exportJSON() || '');
      if (t) return t;
    }
  } catch (e) { /* ignore */ }
  try {
    if (window.spData && typeof window.spData.get === 'function') return String(window.spData.get() || '');
  } catch (e) { /* ignore */ }
  return '';
}

/** 复制：App 剪贴板桥 window.shell.copyText → navigator.clipboard → textarea 选中兜底。 */
function copyText(text) {
  const s = String(text == null ? '' : text);
  if (!s) return Promise.resolve(false);
  try {
    if (window.shell && typeof window.shell.copyText === 'function') {
      window.shell.copyText(s);
      return Promise.resolve(true);
    }
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

function readServerList() {
  try {
    if (window.shell && window.shell.getServerList) {
      const o = JSON.parse(window.shell.getServerList());
      if (o && Array.isArray(o.entries)) {
        // v7.6: 条目标上 signed（= 来自签名清单，桥的 useRemoteClient(id) 才认得这个 id）并把
        // remoteClient 强制成布尔（Java 侧已按 host 标注；老壳/老 payload 缺字段时按关处理）。
        const entries = o.entries.map((e) => (e && typeof e === 'object'
          ? { ...e, signed: true, remoteClient: !!e.remoteClient }
          : e));
        return { ...o, entries };
      }
    }
  } catch (e) { /* ignore */ }
  return { source: '', entries: [] };
}

/** 网页（无 shell）回退行：__SP_SHELL.getServers()（shell-bridge.js 的静态线路表）→ 面板行；
 *  拿不到就只留「自动线路」（= 当前网页）。 */
function webRows() {
  let arr = [];
  try {
    if (window.__SP_SHELL && typeof window.__SP_SHELL.getServers === 'function') {
      const r = window.__SP_SHELL.getServers();
      const parsed = typeof r === 'string' ? JSON.parse(r) : r;
      if (Array.isArray(parsed) && parsed.length) arr = parsed;
    }
  } catch (e) { arr = []; }
  if (!arr.length) arr = [{ id: 'auto', label: '自动线路', url: '', current: true }];
  return arr.map((s, i) => ({
    key: 'web:' + (s.id || i),
    id: s.id || 'auto',
    name: s.label || '自动线路',
    note: '', app: '', rttMs: -1, enabled: true,
    current: !!s.current,
    url: typeof s.url === 'string' ? s.url : '',
    // v7.6: 网页版没有外壳桥 → 服务端客户端开关恒禁用（原因由 remoteClientGate 给）。
    signed: false, remoteClient: false,
  }));
}

/** v4.5: 一次性布防（v3.6 契约）—— 服务器面板与大厅 QuickModes 共用。
 *  切服/重载后由标题页 takeAutostart() 取用一次，随即自动进入。 */
function armAutostart() {
  try { if (window.shell && typeof window.shell.setAutostart === 'function') window.shell.setAutostart(); } catch (e) { /* ignore */ }
}

/** v4.5: 统一切服 / 跳转（服务器面板 pick 与 QuickModes 共用，避免两处复制逻辑）。
 *  row: { id, enabled, url }；opts: { onClose, onNote, locked }。
 *  返回 true 表示已处理（已切换 / 已跳转 / 自动线路无需动作）。 */
function switchTo(row, opts) {
  const o = opts || {};
  const close = typeof o.onClose === 'function' ? o.onClose : function () {};
  const note = typeof o.onNote === 'function' ? o.onNote : function () {};
  if (o.locked) { note('对局进行中，无法切换服务器。结束后再切换。'); return false; }
  const native = typeof window !== 'undefined' && window.shell && typeof window.shell.setServer === 'function';
  if (!native) {
    const url = String(row.url || '');
    if (!url) {
      if (row.id === 'auto') { close(); return true; } // 自动 = 当前 origin，无需跳转
      note('无法获取该线路地址，请用下方自定义服务器手动切换');
      return false;
    }
    try { rememberPref('server', { id: String(row.id || ''), url: url }); location.href = navUrl(url); return true; } catch (e) { note('无法跳转，请手动切换服务器'); return false; }
  }
  if (row.enabled === false) return false; // 已停用：禁止加入（v3.3 起版本差异不再拦截）
  rememberPref('server', { id: String(row.id || ''), url: String(row.url || '') }); // v8.0 跨服记录选择
  try { window.shell.setServer(row.id); } catch (e) { /* ignore */ } // auto/local 走原语义
  armAutostart(); // 选中即进入：面板关闭 → 切服重载 → 标题页自动 start()
  close();
  return true;
}

// ---------------------------------------------------------------------------------------------------
// v7.5: the 2.9.31 server-row stylesheet, injected from the overlay (id #sp-srv-style).
//
// The .sp-srv-* rules used to be a BUILD-TIME patch (patches/settings-v3.6.json -> css/screens/game.css).
// The patch lane was zeroed on 2026-10-07 (commit ee1f9b80) and this block was never re-homed, so on a
// zero-patch build every 服务器 row fell back to plain block layout: cells hugged their content (one
// column, cramped) and the latency dot -- an EMPTY inline span whose width/height only take effect once
// the parent is a flex row -- collapsed to zero width (owner screenshot, 2026-10-08). The stylesheet
// lives here, not in a patch, so it travels with the hot-updatable overlay.
//
// Scaling: every length is rem (or a %/unitless value), so the rows follow the root font-size, i.e.
// fontScale (--sp-font-scale) and the viewport. The only px values are min-width/min-height FLOORS on
// the dot / current bullet: a floor can never break a 1.5x layout (at that scale the rem size is far
// above it) and it guarantees the dot is visible when a very small root would round .11rem away.
const SRV_STYLE_ID = 'sp-srv-style';

/** The .sp-srv-* stylesheet as one string (2.9.31 verbatim layout + the scale-safety floors). */
function srvStyleCss() {
  return [
    // two equal columns; the min-width:0 keeps a long name from blowing the grid open
    '.sp-srv-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.1rem;min-width:0}',
    '.sp-srv-cell{box-sizing:border-box;display:flex;align-items:center;min-width:0;height:.56rem;',
    'background:rgba(8,11,10,.55);border:1px solid var(--line-2,#3e4b45);border-radius:.04rem;overflow:hidden}',
    '.sp-srv-cell.is-cur{border-color:var(--mint-500,#4ed8af);box-shadow:inset 0 0 0 1px rgba(23,249,183,.22)}',
    '.sp-srv-cell.is-off{opacity:.45}',
    '.sp-srv-main{box-sizing:border-box;display:flex;align-items:center;gap:.08rem;flex:1 1 auto;min-width:0;',
    'height:100%;padding:0 .1rem 0 .12rem;background:transparent;border:0;color:var(--text-hi,#f2f2f2);',
    'font-size:.16rem;cursor:pointer;text-align:left}',
    '.sp-srv-main:disabled{cursor:not-allowed}',
    '.sp-srv-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sp-srv-ver{flex:0 0 auto;font-size:.14rem;color:var(--text-lo,#8a948f);white-space:nowrap}',
    // the dot itself: geometry + floor here, colour always inline (grey 延迟未知 when rtt is unknown)
    '.sp-srv-rtt{flex:0 0 auto;display:inline-block;width:.11rem;height:.11rem;min-width:4px;min-height:4px;border-radius:50%}',
    '.sp-srv-cur{flex:0 0 auto;width:.08rem;height:.08rem;min-width:4px;min-height:4px;border-radius:50%;',
    'background:var(--mint-500,#4ed8af);box-shadow:0 0 .08rem rgba(23,249,183,.8)}',
    // v7.6 「服务端客户端」开关胶囊（按服）：开=薄荷描边文字，关=灰字，禁用=半透明。
    // 尺寸一律 rem（沿用 v7.5 的缩放安全口径），唯一的 px 是 1px 发丝边（与 .sp-srv-cell 同款）。
    '.sp-srv-rc{flex:0 0 auto;margin-right:.05rem;padding:0 .07rem;background:transparent;',
    'border:1px solid var(--line-2,#3e4b45);border-radius:.03rem;color:var(--text-lo,#8a948f);',
    'font-size:.11rem;line-height:1;height:.34rem;cursor:pointer;white-space:nowrap}',
    '.sp-srv-rc.is-on{border-color:var(--mint-500,#4ed8af);color:var(--mint-500,#4ed8af)}',
    '.sp-srv-rc:disabled{opacity:.45;cursor:not-allowed}',
    // narrow screens fall back to one column (2.9.31 behavior)
    '@media (max-width:600px){.sp-srv-grid{grid-template-columns:1fr}}',
  ].join('');
}

/** One-shot injector (idempotent on #sp-srv-style). No DOM / no head -> silent no-op, never throws.
 *  Called at module load and again on host mount, so any page that can render a panel gets the rows. */
export function injectSrvStyles() {
  try {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
    if (typeof document.getElementById === 'function' && document.getElementById(SRV_STYLE_ID)) return true;
    const el = document.createElement('style');
    el.setAttribute('id', SRV_STYLE_ID);
    el.textContent = srvStyleCss();
    const head = document.head || document.documentElement;
    if (!head || typeof head.appendChild !== 'function') return false;
    head.appendChild(el);
    return true;
  } catch (e) { return false; }
}

// Module load: any importer (lobby.js today) gets the styles before its first render.
try { injectSrvStyles(); } catch (e) { /* silent: mount retries */ }

// v7.6: the adaptive-layout stylesheet for the shell's own panels (id #sp-panel-layout).
//
// 业主 2026-10-08：「字体小是大厅界面过窄导致字体被左右压缩」。根因不在字形，而在**面板比视口宽**：
// 我们的面板把 Modal 的 width 硬写成内联 `10.4rem`，把上游 `.modal__box{width:min(6.4rem,94vw)}`
// 的视口上限整个盖掉。实测（tools/pwshot/panel-layout-measure.mjs，390x844，deviceScaleFactor 1）：
//   root font = 40px（theme.css 的地板，19.2rem 虚拟画布）→ 10.4rem = 416px > 390px 视口；
//   `.modal` 居中 + padding .3rem，盒子左移出屏 13px、右侧溢出 38px —— 文字左右边缘被屏幕切掉，
//   这就是业主看到的「字体被左右压缩」（实测 letter-spacing 全为 normal、transform 全为 none，
//   即**没有** scaleX / 负字距；是 nowrap+溢出被裁，不是字形被压）。
// 另外 `.set-row` 的 label 列固定 3.3rem（40px root 下 132px，占 416px 面板的 1/3），把值列挤到
// ~246px，房间行里的 flex 子项（min-width:0）被压到贴边、单行文本被裁。
//
// 这里只注入我们自己的规则，且**全部限定在 [data-sp-panel-host] 之内**（宿主 div 是每个面板 Modal 的
// DOM 祖先）—— 上游自己的 Modal（设置/结算等）一格不受影响：
//   ① 自适应宽度：桌面维持 2.9.31 的 10.4rem（min() 里它更小，视觉不变），任何视口都不超过 100vw 减边距；
//      窄屏/竖屏媒体查询（<=720px）切到「近满宽 + 8px 边距」，并收紧左右内边距、缩窄 label 列。
//   ② 不压缩字形：值列 minmax(0,1fr) 允许收缩，label 列 minmax(0,…) 允许收缩；长 token 断行、
//      单行格用省略号（绝不 scaleX / 负字距）。
//   ③ 保留滚动：body 是唯一滚动区（flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain），
//      页脚是它的 flex 兄弟、不随滚动消失；box 仍有上游 max-height:88vh 兜底。
const PANEL_STYLE_ID = 'sp-panel-layout';

/** The adaptive-layout stylesheet as one string (one rule per array line, static-extractable). */
function panelLayoutCss() {
  return [
    // ① adaptive width: desktop keeps the 2.9.31 10.4rem, never wider than the viewport minus a margin
    '[data-sp-panel-host] .modal__box{width:min(10.4rem,calc(100vw - 1.5rem));max-width:calc(100vw - 1.5rem);}',
    // ② no horizontal squeeze: the value column and the label column may both shrink
    '[data-sp-panel-host] .set-row{grid-template-columns:minmax(0,3.3rem) minmax(0,1fr) auto;}',
    '[data-sp-panel-host] .set-row__label{min-width:0;}',
    '[data-sp-panel-host] .set-input,[data-sp-panel-host] .set-range,[data-sp-panel-host] .set-seg,[data-sp-panel-host] .set-toggle{min-width:0;max-width:100%;}',
    // long tokens wrap instead of pushing the grid open (glyphs keep their aspect: no scaleX / negative tracking)
    '[data-sp-panel-host] .set-hint,[data-sp-panel-host] .modal__title{overflow-wrap:anywhere;}',
    // ③ keep scrolling: the body is the only scroller; the footer is its flex sibling and stays put
    '[data-sp-panel-host] .modal__body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;}',
    // narrow / portrait: near-full-width with a small margin, tighter side padding, narrower label column
    '@media (max-width:720px){',
    '[data-sp-panel-host] .modal{padding:8px;}',
    '[data-sp-panel-host] .modal__box{width:calc(100vw - 16px);max-width:calc(100vw - 16px);}',
    '[data-sp-panel-host] .modal__head,[data-sp-panel-host] .modal__body,[data-sp-panel-host] .modal__actions{padding-left:.18rem;padding-right:.18rem;}',
    '[data-sp-panel-host] .set-row{grid-template-columns:minmax(0,2.1rem) minmax(0,1fr) auto;gap:.12rem;}',
    '[data-sp-panel-host] .set-row__label{white-space:normal;}',
    '}',
  ].join('');
}

/** One-shot injector (idempotent on #sp-panel-layout). No DOM / no head -> silent no-op, never throws.
 *  Called at module load and again on host mount, so any page that can render a panel gets the layout. */
export function injectPanelLayoutStyles() {
  try {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
    if (typeof document.getElementById === 'function' && document.getElementById(PANEL_STYLE_ID)) return true;
    const el = document.createElement('style');
    el.setAttribute('id', PANEL_STYLE_ID);
    el.textContent = panelLayoutCss();
    const head = document.head || document.documentElement;
    if (!head || typeof head.appendChild !== 'function') return false;
    head.appendChild(el);
    return true;
  } catch (e) { return false; }
}

try { injectPanelLayoutStyles(); } catch (e) { /* silent: mount retries */ }

/** v4.5: 单行格（服务器面板与 QuickModes 共用）—— 名称 · v版本 · 延迟色点；
 *  「当前」= 小圆点 + 薄荷描边。截断/不换行/两列网格都在 CSS（.sp-srv-*），行内只留延迟色点。
 *  v7.6: 可选的「服务端客户端」开关胶囊（第 3 个参数给了 onRc 才渲染，独立兄弟节点、绝不嵌套）。 */
function serverCell(e, onPick, onRc) {
  // v4.9: 行可自带固定点（本机服务/自动线路没有 RTT 概念 → 恒绿点「可用」）；停用行仍走灰点。
  const dot = e.enabled === false
    ? rttDot(e.rttMs, false, e.reachable)
    : (e.dot ? { color: e.dot, title: e.dotTitle || '' } : rttDot(e.rttMs, e.enabled, e.reachable));
  const rc = typeof onRc === 'function' ? remoteClientChip(e, remoteClientGate(e), onRc) : null;
  return html`<div key=${e.key} class=${'sp-srv-cell' + (e.current ? ' is-cur' : '') + (!e.enabled ? ' is-off' : '')}>
    <button type="button" class="sp-srv-main" title=${(e.note ? e.note + ' · ' : '') + e.name}
      disabled=${!e.enabled}
      onClick=${() => onPick(e)}>
      ${e.current ? html`<span class="sp-srv-cur"></span>` : null}
      <span class="sp-srv-name">${e.name}</span>
      ${e.app ? html`<span class="sp-srv-ver">${fmtApp(e.app)}</span>` : null}
      <span class="sp-srv-rtt" style=${'flex:0 0 auto;display:inline-block;width:.11rem;height:.11rem;min-width:4px;min-height:4px;border-radius:50%;background:' + dot.color} title=${dot.title}></span>
    </button>
    ${rc}
  </div>`;
}

/** v4.5: 顶部快捷入口（本机服务 / 自动线路）—— 服务器面板与大厅面板共用同一组件与同一套切换行为。
 *  props: onClose（关闭面板）、onNote（可选，就地提示）、locked（对局中只读）。
 *  内部读取本机服务版本 / 当前态；无 hooks，便于测试直接调用取 vnode。
 *  网页（无 shell）时「本机服务」置灰（App 专属），「自动线路」= 当前页。 */
export function QuickModes(props) {
  const onClose = props && props.onClose;
  const onNote = props && props.onNote;
  const locked = !!(props && props.locked);
  const native = typeof window !== 'undefined' && window.shell && typeof window.shell.setServer === 'function';
  const list = readServerList();
  let localCurrent = false;
  try {
    const arr = JSON.parse(window.shell.getServers());
    const l = Array.isArray(arr) ? arr.find((x) => x && x.id === 'local') : null;
    localCurrent = !!(l && l.current);
  } catch (e) { /* 旧壳 / 网页：无当前态 */ }
  const pick = (e) => switchTo(e, { onClose: onClose, onNote: onNote, locked: locked });
  // v4.9: 本机服务 / 自动线路没有 RTT 概念（不是远端房间），固定绿点表示「可用」。
  const rows = [
    { key: 'local', id: 'local', name: '本机服务', note: '单机开房', app: native ? (list.localApp || '') : '', rttMs: -1, enabled: native, current: native && localCurrent, dot: '#4ed8af', dotTitle: '可用' },
    { key: 'auto', id: 'auto', name: '自动线路', note: '清单首选', app: '', rttMs: -1, enabled: true, current: !native, dot: '#4ed8af', dotTitle: '可用' },
  ];
  return rows.map((e) => serverCell(e, pick));
}

function ServerPanel({ onClose }) {
  const native = typeof window !== 'undefined' && window.shell && typeof window.shell.setServer === 'function';
  const [list, setList] = useState(readServerList);
  // v4.5: 本机服务版本 / 当前态由 QuickModes 组件内部读取（顶部两格与大厅共用）。
  // v8.0: 自定义输入框预填上一次的跨服选择（没有就留空）。
  const [custom, setCustom] = useState(() => {
    const last = readPref('server');
    return (last && typeof last === 'object' && typeof last.url === 'string') ? last.url : '';
  });
  const [customOpen, setCustomOpen] = useState(false);
  const [note, setNote] = useState('');

  // the shell pushes a fresh (verified, probed) list after refreshServerList()
  useEffect(() => {
    const onServers = (e) => { try { setList(JSON.parse(e.detail)); } catch (err) { /* ignore */ } };
    window.addEventListener('sp-servers', onServers);
    if (native && window.shell.refreshServerList) {
      try { window.shell.refreshServerList(); } catch (e) { /* ignore */ }
    }
    return () => window.removeEventListener('sp-servers', onServers);
  }, []);

  const locked = inMatch(); // 战斗中禁切：面板只读（owner 决定：inMatch 即禁）

  function blocked() { return locked; } // v4.5: 连接路径弹窗已移除，只保留对局禁切判断

  // v4.5: 切换行为已抽到模块级 switchTo（QuickModes 共用），这里只做面板侧接线。
  function pick(row) { switchTo(row, { onClose: onClose, onNote: setNote, locked: locked }); }

  // v7.6: 服务端界面开关（按服）。caps 每次渲染重算（shell-bridge 可能晚于本模块落地）。
  const caps = remoteClientCaps();
  function toggleRemoteClient(row) {
    if (locked) { setNote('对局进行中，无法切换服务器。结束后再切换。'); return; }
    applyRemoteClient(row, caps, setNote);
  }

  function applyCustom() {
    if (blocked()) return;
    let v = String(custom || '').trim();
    if (!v) return;
    if (!/^https?:\/\//.test(v)) v = 'https://' + v;
    v = v.replace(/\/+$/, '');
    rememberPref('server', { id: 'custom', url: v }); // v8.0 跨服记录自定义服务器
    if (native) {
      try { window.shell.setServer('custom:' + v); } catch (e) { /* ignore */ }
      armAutostart();
      onClose();
      return;
    }
    location.href = navUrl(v);
  }

  const entries = list.entries || [];
  // 清单更新时间：Java 侧可能新增顶层 updated 或条目内 updated（有就显示，无则静默）
  const updatedRaw = list.updated != null
    ? list.updated
    : (entries.find((e) => e && e.updated != null) || {}).updated;
  const updatedText = fmtUpdated(updatedRaw);
  // 统一列表（v3.6）：清单服务器同列；自定义输入行殿后。
  // v4.5: 本机服务 / 自动线路 改由顶部 QuickModes 渲染（与大厅面板同一组件），此处只列清单条目。
  // 房间制（CF Workers）服务器不展示：Java getServerList 已过滤，这里再滤一次旧 payload。
  // 仅隐藏展示：邀请码路径（shell.joinOnOrigin）对房间制服务器的底层能力不变。
  const rows = (native ? entries.map((e) => ({ ...e, key: e.id })) : webRows())
    .filter((e) => e && !e.roomScoped && e.id !== 'local' && e.id !== 'auto')
    .map((e) => ({ ...e, locked })); // v7.6: 对局中开关一并禁用（原因由 remoteClientGate 给）

  // v7.6: 「服务端客户端」小节 —— 当前线路的状态 + 一行解释。当前线路不在清单里（本机服务 / 自动线路 /
  // 自定义线路）时，用一个恒不满足的行让 gate 给出对应原因（禁用 + 原因，而不是静默不显示）。
  const currentRow = rows.find((e) => e.current) || {
    id: '', name: '当前线路', current: true, signed: false, remoteClient: false, locked,
  };
  const rcGate = remoteClientGate(currentRow, caps);
  const rcOn = !!currentRow.remoteClient;

  /** 单行格：名称 · v版本 · 延迟色点；「当前」= 小圆点 + 薄荷描边。
   *  v4.5: 渲染与点击行为都抽到模块级 serverCell / QuickModes，这里不再复制。 */

  return html`<${Modal} open=${true} onClose=${onClose} title="服务器" micro="SERVER"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      ${locked ? html`<p class="set-hint" style="margin:0 0 6px;border:1px solid #e0b64a;border-radius:4px;padding:8px 10px;color:#e0b64a">
        对局进行中，无法切换服务器。结束后再切换。
      </p>` : null}
      <div class="set-row">
        <span class="set-row__label">服务器清单<${MicroLabel}>LIST<//></span>
        <div style="grid-column:2 / 4;min-width:0">
          <div class="sp-srv-grid"><${QuickModes} onClose=${onClose} onNote=${setNote} locked=${locked} />${rows.map((e) => serverCell(e, pick, toggleRemoteClient))}</div>
          ${!rows.length ? html`<p class="set-hint set-hint--tight">${list.loading ? '正在获取清单…' : '暂无可用服务器'}</p>` : null}
          ${updatedText ? html`<p class="set-hint set-hint--tight">清单更新于 ${updatedText}</p>` : null}
          ${native && window.shell.refreshServerList
            ? html`<button type="button" class="set-apply" onClick=${() => { try { window.shell.refreshServerList(); } catch (e) { /* ignore */ } }}>刷新清单</button>`
            : null}
        </div>
      </div>
      <div class="set-row">
        <span class="set-row__label">服务端界面<${MicroLabel}>SERVER UI<//></span>
        <div style="grid-column:2 / 4;min-width:0">
          <div class="sp-srv-grid">
            <div class=${'sp-srv-cell' + (currentRow.current ? ' is-cur' : '')}>
              <span class="sp-srv-main" style="cursor:default">
                <span class="sp-srv-name">${currentRow.name || '当前线路'} · ${rcOn ? '服务器自带界面' : '本地界面'}</span>
              </span>
              ${remoteClientChip(currentRow, rcGate, toggleRemoteClient)}
            </div>
          </div>
          <p class="set-hint set-hint--tight">
            当前实际使用：<b>${rcOn ? '服务器自带界面（页面与资源来自该服务器）' : '本地界面'}</b>${rcGate.ok ? '' : ' —— ' + rcGate.reason}
          </p>
          <p class="set-hint set-hint--tight">
            点行尾「服端」= 改用该服自有客户端：页面与静态资源都直接来自该服务器（浏览器缓存提速，UI/玩法与该服完全一致），
            代价是每个静态文件都要重新校验、首屏略慢；服务器不可用时自动回退本地界面。点「本地」= 回到本地客户端。
            默认在设置面板里配置（默认「服务端界面」）；切换后页面会立即重新加载生效。
          </p>
        </div>
      </div>
      <div class="set-row">
        <span class="set-row__label">自定义服务器<${MicroLabel}>CUSTOM<//></span>
        <input class="set-input" type="text" value=${custom} placeholder="输入地址"
          onFocus=${() => setCustomOpen(true)}
          onInput=${(e) => setCustom(e.currentTarget.value)} />
        <button type="button" class="set-apply" disabled=${!customOpen || custom === ''} onClick=${applyCustom}>应用</button>
      </div>
      ${note ? html`<p class="set-hint set-hint--tight">${note}</p>` : null}
      ${serverConfigLine()}
      <p class="set-hint">
        点格子即切换到该服务器并自动进入。「本机服务」= 单机开房（按需启动）；「自动线路」= 优先取网页服务器清单（dl.jiangjiangze.icu/servers）的第一个服务器，不可达时按实测延迟选最优。
        清单为签名清单，验签失败会自动回退内置；延迟由本机实测，未探测显示 --。
      </p>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------------
// 跨服邀请码（v2.7.0）：输入 4 位码 → shell-join.js 并发探针（目录 + 各 node 服 WS 试探）→
// 单一命中直接加入；多服命中弹本选择器（按本机延迟排序，域名不出现在界面）。
// ---------------------------------------------------------------------------------------------------

const FONT_SEG = [['0.85', '较小'], ['0.95', '标准'], ['1.05', '较大'], ['1.15', '特大']];
const PAD_SEG = [['0', '无'], ['8', '小'], ['16', '中'], ['24', '大']];

function JoinPanel({ onClose }) {
  const native = typeof window !== 'undefined' && window.shell && typeof window.shell.joinOnOrigin === 'function';
  const [code, setCode] = useState('');
  const [state, setState] = useState('idle'); // idle | probing | pick | none | cooldown
  const [entries, setEntries] = useState([]);
  const [note, setNote] = useState('');

  const normalized = String(code || '').toUpperCase().replace(/[^A-HJ-NP-Z]/g, '').slice(0, 4);
  const locked = inMatch(); // 跨服加入同样会切服：对局中一并禁止（与服务器面板一致）

  function pick(entry) {
    if (locked) { setState('none'); setNote('对局进行中，无法跨服加入。结束后再试。'); return; }
    if (native) {
      try { window.shell.joinOnOrigin(entry.id, normalized); } catch (e) { /* ignore */ }
      onClose();
      return;
    }
    // plain web build: navigate with the deep link (same-origin probe hit)
    try { location.href = navUrl(location.href, normalized); } catch (e) { /* ignore */ }
  }

  function go() {
    if (normalized.length !== 4) return;
    if (!window.__SP_JOIN) { setNote('探测模块未加载（较旧版本）'); setState('none'); return; }
    setState('probing');
    setNote('正在跨服查找 ' + normalized + ' …');
    window.__SP_JOIN.resolveCode(normalized).then((r) => {
      if (r.kind === 'directory') {
        // phone-host room: hand the code to the existing room-code join flow
        if (native && window.shell.join) { try { window.shell.join(); } catch (e) { /* ignore */ } }
        setState('none');
        setNote('这是手机房主的房间：请在弹出的房号框直接输入 ' + normalized);
      } else if (r.kind === 'single') {
        pick(r.entry);
      } else if (r.kind === 'conflict') {
        setEntries(r.entries);
        setState('pick');
      } else {
        setState(r.kind === 'cooldown' ? 'cooldown' : 'none');
        setNote(r.note || '未找到该房间');
      }
    }).catch(() => { setState('none'); setNote('查找失败，请稍后重试'); });
  }

  return html`<${Modal} open=${true} onClose=${onClose} title="邀请码加入" micro="INVITE"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      <div class="set-row">
        <span class="set-row__label">邀请码<${MicroLabel}>CODE<//></span>
        <input class="set-input" type="text" value=${code} placeholder="4 位字母或数字"
          maxLength="4" style="text-transform:uppercase;letter-spacing:.08em"
          onInput=${(e) => setCode(e.currentTarget.value)} />
        <button type="button" class="set-apply" disabled=${normalized.length !== 4 || state === 'probing'}
          onClick=${go}>${state === 'probing' ? '查找中…' : '查找'}</button>
      </div>
      ${state === 'pick' ? html`
        <div class="set-row">
          <span class="set-row__label">选择服务器<${MicroLabel}>PICK<//></span>
          <div>${entries.map((e) => html`<button key=${e.id} type="button"
            style=${'display:block;width:100%;margin:4px 0;padding:8px 10px;background:transparent;'
              + 'border:1px solid #2c3a35;color:#d8e3de;border-radius:4px;font-size:13px;cursor:pointer;text-align:left'}
            onClick=${() => pick(e)}>
            ${e.name} · ${fmtRtt(e.rttMs)}${e.note ? ' · ' + e.note : ''}
          </button>`)}</div>
        </div>` : null}
      ${note ? html`<p class="set-hint set-hint--tight">${note}</p>` : null}
      <p class="set-hint">
        同一邀请码可能存在于多台服务器；查找会并发试探清单内全部服务器（约 3 秒），
        多处命中时按本机延迟排序供选择。手机房主的房间仍走房号直连。
      </p>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------------
// Host-server parameters (App only) — segmented controls in the game's own style, hot-switched
// ---------------------------------------------------------------------------------------------------

const HOST_BIND = [['::', '全部网卡'], ['127.0.0.1', '仅本机']];
const COMBAT = [['client', '各自模拟'], ['server', '房主统一']];
const VERIFY = [['off', '不校验'], ['sample', '抽查'], ['all', '全量']];
const PROXY = [['auto', 'auto'], ['1', '信任'], ['0', '不信任']];
// v5.4: 联机传输方案 —— auto 为稳定度层层递减（局域网 → 虚拟网 → IPv6 → 打洞）；
// 选具体档位 = 优先该档，失败后仍按 auto 顺序降级。旧 APK 无 getTransport → 该行置灰。
const TRANSPORT = [['auto', '自动'], ['lan', '优先局域网'], ['zt', '优先虚拟网'], ['v6', '优先 IPv6'], ['dc', '优先打洞']];
// v6.10: 外观（字体缩放 / 左右边距）—— 2026-10-07 补丁清零后，这两项原来由构建期补丁写进**上游设置弹窗**；
// 现在由 extras 的 appearance.js 在运行时注入 CSS 变量（--sp-font-scale / --sp-side-pad）。
// 设置面板是**唯一写者**（单一真源；参数面板不再出现外观分区），App 与网页都可用（不依赖原生桥）。
// 字体 5 档沿用 appearance.js 自己的 5 个倍率（0.85 / 1 / 1.15 / 1.3 / 1.5），挡位名由 owner 定为 小杯→EW；
// 边距 8/16/24 预设改成 0–40px 滑动条（与 appearance.js 的 normPad 钳制范围一致）。
const FONT_SCALE = [['0.85', '小杯'], ['1', '中杯'], ['1.15', '大杯'], ['1.3', '超大杯'], ['1.5', 'EW']];
const PAD_MIN = 0, PAD_MAX = 40, PAD_STEP = 2;

/** 读外观：没有 appearance.js（老内容包）就返回 null → 整节不渲染。绝不抛。 */
function readAppearance() {
  try {
    const a = window.__SP_APPEARANCE;
    if (a && typeof a.get === 'function') {
      const v = a.get() || {};
      return { fontScale: String(v.fontScale == null ? '1' : v.fontScale), sidePad: String(v.sidePad == null ? '0' : v.sidePad) };
    }
  } catch (e) { /* ignore */ }
  return null;
}

/** 写外观：立即生效 + 持久化（由 appearance.js 负责）。 */
function setAppearance(patch) {
  try {
    const a = window.__SP_APPEARANCE;
    if (a && typeof a.set === 'function') a.set(patch);
  } catch (e) { /* ignore */ }
}

function readParams() {
  try {
    if (window.shell && window.shell.getParams) return JSON.parse(window.shell.getParams());
  } catch (e) { /* fall through to defaults */ }
  return { port: 3000, hostBind: '::', spCombat: 'client', spVerify: 'off', trustProxy: 'auto' };
}

/** v5.4: 传输方案读取 —— 只认返回非空字符串的新桥；旧 APK（无 getTransport / 返回 undefined）
 *  返回 { supported:false, value:'auto' }，面板据此把该行置灰并提示「需更新 APK 后生效」。绝不抛。
 *  审查发现#3：读写必须成对存在才算「支持」—— 只有 getter 的壳会让面板显示可编辑却存不下去。 */
function readTransport() {
  try {
    const sh = window.shell;
    if (sh && typeof sh.getTransport === 'function' && typeof sh.setTransport === 'function') {
      const v = sh.getTransport();
      if (typeof v === 'string' && v) return { supported: true, value: v };
    }
  } catch (e) { /* 旧壳 / 桥异常：按不支持处理 */ }
  // v8.0: 没有原生桥时回显上一次记录在 shell-prefs 命名空间里的档位（只读；不支持保存）。
  const cached = readPref('transport');
  return { supported: false, value: (typeof cached === 'string' && cached) ? cached : 'auto' };
}

function SegRow({ label, micro, options, value, onChange, note, disabled }) {
  return html`<div class="set-row">
    <span class="set-row__label">${label}<${MicroLabel}>${micro}<//></span>
    <div class="set-seg" role="radiogroup" style=${disabled ? 'opacity:.45' : ''}>
      ${options.map(([id, text]) => html`<button key=${id} type="button" role="radio"
        aria-checked=${value === id ? 'true' : 'false'} class=${value === id ? 'is-on' : ''}
        disabled=${!!disabled}
        onClick=${() => { if (!disabled) onChange(id); }}>${text}</button>`)}
    </div>
    ${note ? html`<p class="set-hint set-hint--tight">${note}</p>` : null}
  </div>`;
}

/** v6.10: 滑动条行（左右边距 0–40px）—— 复用上游设置弹窗自己的 .set-range 视觉
 *  （--pct 渐变、.set-row__val 读数），不新造样式类。onInput 每拖动一格就写一次
 *  （appearance.js 即时生效 + 持久化 + 钳制到 [0,40]）；disabled 时整行置灰。 */
function SliderRow({ label, micro, min, max, step, value, unit, onChange, note, disabled }) {
  const n = Number(value);
  const v = isFinite(n) ? Math.max(min, Math.min(max, min + Math.round((n - min) / step) * step)) : min;
  const pct = max > min ? Math.round(((v - min) / (max - min)) * 100) : 0;
  return html`<div class="set-row">
    <span class="set-row__label">${label}<${MicroLabel}>${micro}<//></span>
    <input class="set-range" type="range" min=${min} max=${max} step=${step} value=${v} style=${'--pct:' + pct + '%' + (disabled ? ';opacity:.45' : '')}
      disabled=${!!disabled}
      onInput=${(e) => { if (!disabled) onChange(Number(e.currentTarget.value)); }} />
    <span class="set-row__val num">${v + (unit || '')}</span>
    ${note ? html`<p class="set-hint set-hint--tight">${note}</p>` : null}
  </div>`;
}

function ParamsPanel({ onClose }) {
  const native = typeof window !== 'undefined' && window.shell && typeof window.shell.setParamsJson === 'function';
  const [p, setP] = useState(readParams);
  // v5.4: 传输方案独立于 5 个房主参数（不进 setParamsJson 载荷、不触发 restartHost）。
  const transport0 = readTransport();
  const [transport, setTransport] = useState(transport0.value);
  const transportSupported = transport0.supported;
  const upd = (k, v) => setP((old) => ({ ...old, [k]: v }));

  if (!native) {
    return html`<${Modal} open=${true} onClose=${onClose} title="参数（仅本地服务）" micro="PARAMS"
      actions=${html`<${Button} variant="primary" onClick=${onClose}>完成<//>`}>
      <div class="set-list">
        <p class="set-hint">房主参数仅在 App 版可用，且只作用于本机房主服务。</p>
      </div>
    <//>`;
  }

  function save() {
    try {
      window.shell.setParamsJson(JSON.stringify(p));
      if (window.shell.restartHost) window.shell.restartHost();
    } catch (e) { /* ignore */ }
    onClose();
  }

  // v5.4: 传输方案单独保存 —— 只调 setTransport，不重启房主服务、不写 setParamsJson。
  // 审查发现#3：只有真的写成功才提示成功；桥返回 false（原生抛异常）或方法缺失时给出失败文案，
  // 否则用户以为改好了、下次入局仍走旧档位。
  function saveTransport() {
    if (!transportSupported) return;
    let ok = false;
    try {
      if (window.shell && typeof window.shell.setTransport === 'function') ok = window.shell.setTransport(transport) !== false;
    } catch (e) { ok = false; }
    if (ok) rememberPref('transport', transport); // v8.0 页面侧跨服记录（Java 仍是 App 的真源）
    try { toast(ok ? '传输方案已保存' : '传输方案保存失败'); } catch (e) { /* ToastHost 不在时静默 */ }
  }

  return html`<${Modal} open=${true} onClose=${onClose} title="参数（仅本地服务）" micro="PARAMS"
    actions=${html`<${Button} variant="secondary" onClick=${() => setP(readParams())}>恢复默认<//>
      <${Button} variant="primary" icon="check" onClick=${save}>保存并重启房主服务<//>`}>
    <div class="set-list">
      <p class="set-hint set-hint--tight">（仅本地服务）以下参数只作用于本机开启的房主服务，不影响线上线路。</p>
      <div class="set-row">
        <span class="set-row__label">端口<${MicroLabel}>PORT<//></span>
        <input class="set-input" type="number" min="1024" max="65535" value=${p.port}
          onInput=${(e) => upd('port', Number(e.currentTarget.value) || 3000)} />
      </div>
      <${SegRow} label="监听地址" micro="HOST" options=${HOST_BIND} value=${p.hostBind}
        onChange=${(v) => upd('hostBind', v)} note="全部网卡 = 朋友可直连（推荐）；仅本机 = 单机练习" />
      <${SegRow} label="战斗模拟" micro="COMBAT" options=${COMBAT} value=${p.spCombat}
        onChange=${(v) => upd('spCombat', v)} note="各自模拟省电（推荐）；房主统一模拟耗电高，仅设备强时选" />
      <${SegRow} label="结果校验" micro="VERIFY" options=${VERIFY} value=${p.spVerify}
        onChange=${(v) => upd('spVerify', v)} note="全量校验最耗性能；抽查为折中" />
      <${SegRow} label="信任代理" micro="TRUST PROXY" options=${PROXY} value=${p.trustProxy}
        onChange=${(v) => upd('trustProxy', v)} note="直连场景保持 auto 即可" />
      <div class="set-row" style="border-top:1px solid #1e2823;margin-top:.06rem;padding-top:.14rem">
        <span class="set-row__label" style="color:#4ed8af">联机（加入别人）<${MicroLabel}>JOIN<//></span>
      </div>
      <div class="set-row">
        <span class="set-row__label">传输方案<${MicroLabel}>TRANSPORT<//></span>
        <div style="grid-column:2 / 4;min-width:0;display:flex;flex-direction:column;gap:.06rem">
          <div class="set-seg" role="radiogroup" style=${transportSupported ? '' : 'opacity:.45'}>
            ${TRANSPORT.map(([id, text]) => html`<button key=${id} type="button" role="radio"
              aria-checked=${transport === id ? 'true' : 'false'} class=${transport === id ? 'is-on' : ''}
              disabled=${!transportSupported}
              onClick=${() => { if (transportSupported) setTransport(id); }}>${text}</button>`)}
          </div>
          <p class="set-hint set-hint--tight" style="margin:0">自动 = 按稳定度层层递减：局域网 → 虚拟网 → IPv6 → 打洞</p>
          <p class="set-hint set-hint--tight" style="margin:0">选具体档位表示优先它，失败后仍按自动顺序降级</p>
          ${!transportSupported ? html`<p class="set-hint set-hint--tight" style="margin:0">需更新 APK 后生效</p>` : null}
          ${transportSupported
            ? html`<button type="button" class="set-apply" style="align-self:flex-start" onClick=${saveTransport}>保存传输方案</button>`
            : null}
        </div>
      </div>
      <p class="set-hint">保存后自动热切换（仅重启内嵌房主服务，约 2 秒），无需重启应用。</p>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------------
// 设置 (v6.9; v6.10 挡位/滑动条): OUR own settings panel (kind 'appearance') -- only the shell's own
// appearance items (font size tiers 小杯→EW / side padding slider). It deliberately does NOT re-use the
// upstream settings modal (language / audio / quality): those belong to the game and have no entry here.
// The write path is window.__SP_APPEARANCE (appearance.js); when it is absent the rows are disabled
// with an explanation instead of silently doing nothing.
// ---------------------------------------------------------------------------------------------------

function AppearancePanel({ onClose }) {
  const [appearance, setAppearanceState] = useState(readAppearance);
  const available = !!appearance;
  const value = appearance || { fontScale: '1', sidePad: '0' };
  const apply = (patch) => { setAppearance(patch); setAppearanceState(readAppearance()); };
  return html`<${Modal} open=${true} onClose=${onClose} title="设置" micro="SETTINGS"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      <div class="set-row" style="border-top:1px solid #1e2823;margin-top:.06rem;padding-top:.14rem">
        <span class="set-row__label" style="color:#4ed8af">外观<${MicroLabel}>APPEARANCE<//></span>
      </div>
      <${SegRow} label="字体大小" micro="UI SCALE" options=${FONT_SCALE} value=${value.fontScale}
        onChange=${(v) => apply({ fontScale: Number(v) })} disabled=${!available}
        note="立即生效；存本机，换服不丢" />
      <${SliderRow} label="左右边距" micro="SIDE PAD" min=${PAD_MIN} max=${PAD_MAX} step=${PAD_STEP}
        value=${value.sidePad} unit="px" onChange=${(v) => apply({ sidePad: v })} disabled=${!available}
        note="0–40px 滑动；立即生效，窄屏安全边距" />
      ${!available
        ? html`<p class="set-hint">外观模块未加载（缺少 appearance.js），以上选项暂不可用。</p>`
        : null}
      <div class="set-row" style="border-top:1px solid #1e2823;margin-top:.06rem;padding-top:.14rem">
        <span class="set-row__label" style="color:#4ed8af">服务器界面<${MicroLabel}>SERVER UI<//></span>
      </div>
      <${ServerUiRow} />
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------------
// 设置：服务器界面（业主口径 2026-10-08）—— **默认「服务端界面」**（页面/资源走服务端 origin，浏览器
// 缓存提速、UI/玩法与该服一致），可改回「本地客户端」。偏好落 `sp.pref.remoteClient`（与上游
// store.js loadPref/savePref 同键空间，便于「设置跨源持久化」统一接管）；新 APK 上同时把该值交给
// Java 的 remoteClientFor 缺省来源。**实际生效的是哪一种始终显示出来**（要求：UI 上可见），
// 当前 App 版本还不能安全切换时如实说明（原因见文件头的能力门注释）。
// ---------------------------------------------------------------------------------------------------
const SERVER_UI_SEG = [['server', '服务端界面'], ['local', '本地客户端']];

function ServerUiRow() {
  const [pref, setPref] = useState(readRemoteClientPref);
  const caps = remoteClientCaps();
  const eff = remoteClientEffective();
  const value = pref ? 'server' : 'local';
  const apply = (v) => { writeRemoteClientPref(v === 'server'); setPref(v === 'server'); };
  const base = '优先使用服务器自带界面：换服后 UI/玩法立即一致；服务器不可用时自动回退本地。';
  let tail;
  if (!caps.app) tail = '（网页版始终使用本地界面）';
  else if (!caps.escape) tail = '当前 App 版本暂不能安全切换（需更新 App），实际仍用本地界面。';
  else tail = '当前实际使用：' + (eff === 'on' ? '服务器自带界面' : '本地界面') + '。切换后页面立即重新加载。';
  return html`<${SegRow} label="界面来源" micro="SOURCE" options=${SERVER_UI_SEG} value=${value}
    onChange=${apply} disabled=${!caps.app || !caps.bridge} note=${base + tail} />`;
}

// ---------------------------------------------------------------------------------------------------
// 配置 (player data): summary of the local doc + export/import (v3.5)
// ---------------------------------------------------------------------------------------------------

function ConfigPanel({ onClose }) {
  const [doc, setDoc] = useState(readPlayerDoc);
  const [note, setNote] = useState('');
  const profile = (doc && doc.profile) || {};
  const count = (map) => (doc && map && typeof map === 'object' ? Object.keys(map).length : 0);
  const loadouts = count(doc && doc.loadouts);
  const servers = count(doc && doc.servers);
  const rooms = count(doc && doc.rooms);
  const battles = doc && Array.isArray(doc.battles) ? doc.battles.length : 0;
  const dev = doc && typeof doc.deviceId === 'string' ? doc.deviceId.slice(0, 8) : '';

  function copy() {
    const text = exportPlayerJson();
    if (!text) { setNote('暂无玩家数据可导出'); return; }
    copyText(text).then((ok) => setNote(ok ? '已复制导出 JSON，可粘贴保存或分享' : '复制失败：请改用系统导出方式'));
  }

  function importFromClipboard() {
    let text = null;
    try {
      if (window.shell && typeof window.shell.readClipboard === 'function') text = String(window.shell.readClipboard() || '');
    } catch (e) { text = null; }
    if (text == null) { setNote('剪贴板读取不可用（需 App 支持）'); return; }
    if (!text.trim()) { setNote('剪贴板为空'); return; }
    let ok = false;
    try {
      if (window.__SP_DATA && typeof window.__SP_DATA.importJSON === 'function') ok = !!window.__SP_DATA.importJSON(text);
      // old App trees without player-data.js: the Java bridge owns the same merge
      else if (window.spData && typeof window.spData.importJson === 'function') ok = !!window.spData.importJson(text);
    } catch (e) { ok = false; }
    if (ok) { setDoc(readPlayerDoc()); setNote('导入成功：数据已合并到本机'); }
    else setNote('导入失败：剪贴板内容不是有效的玩家数据');
  }

  return html`<${Modal} open=${true} onClose=${onClose} title="配置" micro="PLAYER DATA"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      <div class="set-row">
        <span class="set-row__label">代号<${MicroLabel}>CALLSIGN<//></span>
        <p class="set-hint set-hint--tight" style="grid-column:2 / 4;margin:0">${profile.name || '—'}</p>
      </div>
      <div class="set-row">
        <span class="set-row__label">数据摘要<${MicroLabel}>SUMMARY<//></span>
        <p class="set-hint set-hint--tight" style="grid-column:2 / 4;margin:0">
          干员配置 ${loadouts} 条 · 服务器 ${servers} 个 · 房间 ${rooms} 个 · 战绩 ${battles} 条
        </p>
      </div>
      <div class="set-row">
        <span class="set-row__label">设备标识<${MicroLabel}>DEVICE<//></span>
        <p class="set-hint set-hint--tight" style="grid-column:2 / 4;margin:0">${dev ? dev + '…' : '—'}</p>
      </div>
      <div class="set-row">
        <span class="set-row__label">导出备份<${MicroLabel}>EXPORT<//></span>
        <button type="button" class="set-apply" onClick=${copy}>复制导出 JSON</button>
      </div>
      <div class="set-row">
        <span class="set-row__label">恢复导入<${MicroLabel}>IMPORT<//></span>
        <button type="button" class="set-apply" onClick=${importFromClipboard}>从剪贴板导入</button>
      </div>
      ${note ? html`<p class="set-hint set-hint--tight">${note}</p>` : null}
      <p class="set-hint">
        玩家数据仅保存在本机（App 为应用私有目录，网页为浏览器存储），与当前线路无关；
        导出文本可在其他设备或线路导入合并，导入只补新、不改写较新的本机记录。
      </p>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------------
// 战绩 (local battle log, v4.10): summary + filters + newest-first rows + per-battle detail.
// Data = the local player-v1 document; aggregation via __SP_DATA.battleStats (the same 口径 as
// the Workers-based servers, so numbers are comparable). All local — no account, no network.
// ---------------------------------------------------------------------------------------------------

const DIFF_LABELS = { FUNNY: '标准', NORMAL: '险境', HARD: '绝境', ABYSS: '终极' };
const DIFF_ORDER = ['FUNNY', 'NORMAL', 'HARD', 'ABYSS'];
const STAT_LABELS = [
  ['dmgDealt', '造成伤害'], ['kills', '击倒敌人'], ['bossDamage', '领袖伤害'], ['healing', '治疗量'],
  ['merges', '晋升次数'], ['itemsEquipped', '配发装备'], ['gold', '消耗资金'], ['perfectRounds', '完美作战'],
  ['refreshes', '刷新次数'], ['leaks', '未击倒'], ['lpLost', '损失生命'], ['activatedLayers', '盟约层数'],
  ['buys', '购买次数'], ['sells', '出售次数'], ['fundsGained', '获得资金'],
];

function fmtDuration(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function resultLabel(r) {
  return r === 'win' ? '胜利' : r === 'lose' ? '失败' : '—';
}

function resultColor(r) {
  return r === 'win' ? '#4ed8af' : r === 'lose' ? '#e06c5a' : '#8a9a93';
}

function diffLabel(d) {
  const k = String(d || '').toUpperCase();
  return DIFF_LABELS[k] || (d ? String(d) : '—');
}

function modeLabel(m) {
  return m === 'coop' ? '同盟' : m === 'solo' ? '独立' : (m || '—');
}

function statusOf(b) {
  if (b && b.status === 'left') return { text: '提前离开', color: '#e0b64a' };
  if (b && b.status === 'interrupted') return { text: '对局中断', color: '#8a9a93' };
  return { text: resultLabel(b && b.result), color: resultColor(b && b.result) };
}

function fmtPct(v) {
  return Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '—';
}

function fmtTs(ms) {
  const d = new Date(Number(ms) || 0);
  if (!Number.isFinite(d.getTime()) || !d.getTime()) return '—';
  return (d.getMonth() + 1) + '/' + d.getDate() + ' '
    + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

function RecordsPanel({ onClose }) {
  const doc = readPlayerDoc();
  const all = doc && Array.isArray(doc.battles) ? doc.battles.slice() : [];
  all.sort((a, b) => (Number(b && b.ts) || 0) - (Number(a && a.ts) || 0)); // 新 → 旧
  const [mode, setMode] = useState('');
  const [diff, setDiff] = useState('');
  const [openId, setOpenId] = useState('');
  const servers = (doc && doc.servers) || {};
  const serverName = (id) => (id && servers[id] && servers[id].name) || id || '未知服务器';
  const rows = all.filter((b) => (!mode || b.mode === mode)
    && (!diff || String(b.difficulty || '').toUpperCase() === diff)).slice(0, 50);
  let stats = null;
  try {
    if (window.__SP_DATA && typeof window.__SP_DATA.battleStats === 'function') {
      stats = window.__SP_DATA.battleStats(all, { mode: mode, difficulty: diff });
    }
  } catch (e) { stats = null; }
  const rowStyle = 'display:flex;align-items:baseline;gap:10px;padding:6px 2px 5px;'
    + 'border-bottom:1px solid #1e2823;font-size:12px';
  const cell = 'font-variant-numeric:tabular-nums';

  return html`<${Modal} open=${true} onClose=${onClose} title="战绩" micro="RECORDS"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      ${stats && stats.total
        ? html`<div class="set-row">
            <span class="set-row__label">统计<${MicroLabel}>STATS<//></span>
            <div style="grid-column:2 / 4;min-width:0;display:flex;flex-direction:column;gap:6px">
              <div style=${rowStyle}>
                <span style="opacity:.75">总场次 <b style=${cell + ';color:#e8e6df'}>${stats.total}</b></span>
                <span style="opacity:.75">胜率 <b style=${cell + ';color:#4ed8af'}>${fmtPct(stats.winRate)}</b></span>
                <span style="opacity:.75">最高回合 <b style=${cell + ';color:#e8e6df'}>${stats.highestRound || '—'}</b></span>
                <span style="opacity:.75">通关 <b style=${cell + ';color:#e8e6df'}>${stats.hidden}</b></span>
                <span style="margin-left:auto;opacity:.55">离开 ${stats.left} · 中断 ${stats.interrupted}</span>
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:4px 14px;opacity:.75;font-size:12px">
                ${STAT_LABELS.map(([k, label]) => (stats.totals[k]
                  ? html`<span key=${k}>${label} <b style=${cell}>${stats.totals[k]}</b></span>` : null))}
              </div>
              ${stats.operators.length
                ? html`<div style="font-size:12px;opacity:.75">常用干员：${stats.operators.slice(0, 6).map((op) => op.id + '×' + op.matches).join(' · ')}</div>`
                : null}
            </div>
          </div>`
        : null}
      <${SegRow} label="模式" micro="MODE" value=${mode}
        options=${[['', '全部'], ['solo', '独立'], ['coop', '同盟']]} onChange=${setMode} />
      <${SegRow} label="难度" micro="DIFF" value=${diff}
        options=${[['', '全部']].concat(DIFF_ORDER.map((d) => [d, DIFF_LABELS[d]]))} onChange=${setDiff} />
      <div class="set-row">
        <span class="set-row__label">记录<${MicroLabel}>MATCHES<//></span>
        <div style="grid-column:2 / 4;min-width:0">
          ${rows.length
            ? html`<div>${rows.map((b, i) => {
                const st = statusOf(b);
                const key = b.id || String(i);
                const open = openId === key;
                return html`<div key=${key}>
                  <div style=${rowStyle + ';cursor:pointer'} onClick=${() => setOpenId(open ? '' : key)}>
                    <b style=${'min-width:3.4em;color:' + st.color}>${st.text}</b>
                    <span style="opacity:.8">${diffLabel(b.difficulty)}</span>
                    <span style=${'opacity:.8;' + cell}>${b.round ? 'R' + b.round : ''}</span>
                    <span style=${'opacity:.8;' + cell}>${fmtDuration(b.duration)}</span>
                    <span style="opacity:.65">${modeLabel(b.mode)}</span>
                    <span style=${'opacity:.55;' + cell}>${fmtTs(b.ts)}</span>
                    <span style="margin-left:auto;opacity:.55;max-width:32%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                      title=${serverName(b.serverId)}>${serverName(b.serverId)}</span>
                  </div>
                  ${open
                    ? html`<div style="padding:6px 2px 8px 12px;border-bottom:1px solid #1e2823;font-size:12px;opacity:.85">
                        ${b.title ? html`<div style="margin-bottom:4px">评语：${b.title}</div>` : null}
                        ${b.operators && b.operators.length
                          ? html`<div style="margin-bottom:4px">干员：${b.operators.join(' · ')}</div>` : null}
                        ${b.stats
                          ? html`<div style="display:flex;flex-wrap:wrap;gap:4px 14px">
                              ${STAT_LABELS.map(([k, label]) => (typeof b.stats[k] === 'number'
                                ? html`<span key=${k}>${label} <b style=${cell}>${b.stats[k]}</b></span>` : null))}
                            </div>`
                          : html`<div style="opacity:.6">该场次无明细（旧记录）</div>`}
                      </div>`
                    : null}
                </div>`;
              })}</div>`
            : html`<p class="set-hint set-hint--tight">${all.length ? '当前筛选下暂无记录' : '暂无战绩'}</p>`}
          <p class="set-hint set-hint--tight">按结算时间倒序，最多显示最近 50 条（筛选后）。点一行展开明细；统计口径与服务器端一致。</p>
        </div>
      </div>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------------
// Panel registry (v2.9): extra panels register themselves instead of editing this file
// (lobby.js calls registerPanel('lobby', LobbyPanel) after its dynamic import).
const panelRegistry = new Map();

export function registerPanel(kind, component) {
  if (typeof kind === 'string' && kind && typeof component === 'function') panelRegistry.set(kind, component);
}

export function ShellPanelHost() {
  const [kind, close] = useShellPanel();
  const custom = kind ? panelRegistry.get(kind) : null;
  if (custom) return html`<${custom} onClose=${close} />`;
  if (kind === 'servers') return html`<${ServerPanel} onClose=${close} />`;
  if (kind === 'params') return html`<${ParamsPanel} onClose=${close} />`;
  if (kind === 'join') return html`<${JoinPanel} onClose=${close} />`;
  if (kind === 'appearance') return html`<${AppearancePanel} onClose=${close} />`;
  if (kind === 'config') return html`<${ConfigPanel} onClose=${close} />`;
  if (kind === 'records') return html`<${RecordsPanel} onClose=${close} />`;
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Panel host mounting (v6.9): the host used to be mounted by a BUILD-TIME PATCH into upstream
// js/main.js (`<${ShellPanelHost} />`). Patches are gone on the re line, so openShellPanel() only set
// state and NOTHING rendered -- every panel button was dead (audit 2026-10-08 §A). This mounts the
// host from the overlay itself, so the built-in panels (and any registered one) work on a zero-patch
// build. Idempotent (one container, marked with HOST_ATTR); silent on any failure -- a broken mount
// must never affect the game.
const HOST_ATTR = 'data-sp-panel-host';

/** Mount ShellPanelHost into its own container under `parent` (default `.app-root`, else body).
 *  Returns the host element (the existing one on a repeat call), or null when there is no DOM or no
 *  renderer. Never throws. */
export async function mountShellPanelHost(parent) {
  try {
    try { injectSrvStyles(); } catch (e) { /* silent */ } // rows must be styled before the first paint
    try { injectPanelLayoutStyles(); } catch (e) { /* silent */ } // adaptive width/scroll, same reason
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    let host = null;
    try { if (typeof document.querySelector === 'function') host = document.querySelector('[' + HOST_ATTR + ']'); } catch (e) { host = null; }
    if (!host) {
      let target = parent || null;
      if (!target) { try { target = document.querySelector('.app-root'); } catch (e) { target = null; } }
      if (!target) { try { target = document.body; } catch (e) { target = null; } }
      if (!target || typeof target.appendChild !== 'function') return null;
      host = document.createElement('div');
      host.setAttribute(HOST_ATTR, '');
      // No style/z-index: a plain wrapper (like the old patch's mount point) so the panel's own
      // position:fixed modal keeps participating in the ROOT stacking context. A z-index here would
      // create a stacking context and trap the modal below other page chrome.
      target.appendChild(host);
    }
    let render = null;
    try {
      const mod = await import('../../vendor/preact.module.js');
      render = mod.render || (mod.default && mod.default.render);
    } catch (e) { render = null; }
    if (typeof render !== 'function') return host; // container exists but no renderer: nothing to draw
    const draw = () => { try { render(html`<${ShellPanelHost} />`, host); } catch (e) { /* silent */ } };
    draw();
    // Safety net: repaint on every panel-state change even when the hooks shim is in use (no reactive
    // hooks). With real Preact this reconciles the same component type and is a no-op. Registered once.
    if (!host.__spPanelBound) {
      host.__spPanelBound = true;
      try { if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('sp-panel', draw); } catch (e) { /* silent */ }
    }
    return host;
  } catch (e) { return null; }
}

// Shell menu / notification can open panels without touching the Preact tree.
try {
  window.__SP_SHELL = window.__SP_SHELL || {};
  window.__SP_SHELL.openPanel = openShellPanel;
  // v6.9 诊断：依赖来源 / 就绪信号对外可见（过去外部拿不到，排障很痛）。
  window.__SP_SHELL.depsReport = depsReport;
  window.__SP_SHELL.whenDepsReady = whenDepsReady;
  // the shell pushes a freshly verified + probed list here (see MainActivity.pushServerList)
  window.__SP_SHELL.onServers = (json) => {
    try {
      window.dispatchEvent(new CustomEvent('sp-servers', { detail: json }));
    } catch (e) { /* old browser */ }
  };
} catch (e) { /* no window (tests) */ }
