/* global window, document */
// js/ui/forge-layer.js — Forge 0.18.6 合并层的**本机服务门禁**（overlay 层，零上游冲突）
//
// WHY (业主 2026-10-15 指令)
// ----------------------------------------------------------------------------
// 「全合并，然后这些 Forge 的内容也是**仅在本机服务展示**」。
//
// 22 个 Forge 独有 `js/ui/` 模块已全部落到 `extras/public/js/ui/`（与上游零同名冲突）。本文件决定它们
// **什么时候才被加载**：只有页面跑在本机服务（手机自开服 / 局域网）上时才 import；连线上或社区服务器时
// **一个 Forge 模块都不 import、一点 DOM 都不碰**，只在 window 上留一条诊断标记。
//
// 判据（既有，不新造）
// ----------------------------------------------------------------------------
// `extras/public/js/lobby.js:2831` `window.__SP_LOBBY.localService = isLocalService;`
// `isLocalService()`（lobby.js:354-361）= `window.shell.currentServerId()` ∈ {`sp-phone-host`,`local`}
// **或** hostname 是私网/环回。既有先例：`room-hook.js:124` 的「公开到大厅」置灰判据用的就是它。
//
// ⚠ 两个语义必须分清（lobby.js:363-373 已论证过）：
//   · `isLocalService()`     = 本机或局域网访客（私网皆真）  ← **本门禁采用这个**
//   · `isOwnHostPage()`      = 只有 127.0.0.1 / ::1 / localhost
// 社区服 / 线上是公网 origin，两个都为假，所以用 `isLocalService()` 足够区分，且与房间页既有口径一致。
//
// 三条边界
// ----------------------------------------------------------------------------
// 1. **绝不走网络**：所有 Forge 模块都经 `/__sp/` 通道由本机提供（MainActivity.java serveShellAsset），
//    与 shell-bridge.js 注入其余 overlay 的方式逐字一致。任何 import 失败都静默降级，不弹错、不阻断启动。
// 2. **幂等**：`window.__SP_FORGE` 守卫，重复注入只做一次判定。
// 3. **可观测**：无论走哪条分支都写 `window.__SP_FORGE_GATE`，探针据此验收，不靠猜。
//    实际只会是两个值：`'local'`（本机服务，模块已挂载）/ `'online'`（线上或社区服，什么都没挂）。
//    判据不可得（`__SP_LOBBY` 还没就位 / `localService()` 抛异常）时 `isLocalService()` 保守返回
//    false，于是也写 `'online'` —— **故意没有第三个 `'unknown'` 值**：探针与测试只需要一个二值的
//    「Forge 层到底挂没挂」，多一个状态只会让「线上却显示 unknown」这类读法出现。
//
// 关于 `room.support`（唯一需要探测的协议面）
// ----------------------------------------------------------------------------
// Forge 的 `supportSync.js:111` 会 `net.request('room.support', { entries })`，而本 APK 的
// `shared/protocol.js:379` C2S 表里**没有 `room.support`**（45 键均无此项）—— 服务端 `validateC2S`
// 会回 `unknown type`。所以助战同步**只在确认服务器认识这个消息之后才安装**：探测一次空选择
// （`entries: []` 是 Forge 契约里永远合法的值，见 support-shim 的 checkSupport），
// 被拒就永远不装，绝不向社区服反复发协议外的消息。

/** `--fit-*` 的消费层（screenFit.js 的 CSS 那一半），一行一条规则（与 first-screen.js 的样式表同范式）。
 *
 * 为什么内联在这里而不放 css/forge-fit.css + <link>：`MainActivity.serveShellAsset()` 把
 * `/__sp/<name>` 硬编码解析成 `openLocal("/js/" + name)`，那条链只服务 js/ 之下的文件；
 * 而上游 index.html 的 <link> 清单里没有这个新增文件。内联 + 幂等 id 是本 overlay 既有做法。
 *
 * 与 devices.css:15-18 的 `--sa-*`（系统安全区，env(safe-area-inset-*)）是**相加**关系：
 * `--fit-*` 是用户级微调。任何一边未设置时 fallback 0px ⇒ 整体退化成与 devices.css 相同的布局。 */
var FIT_CSS = [
  /* 布局根：固定盒（theme.css:244 .app-root position:fixed; inset:0）按 系统安全区 + 用户微调 内缩。
     每个 .screen 都是它里面 position:absolute; inset:0 的层（theme.css:285），所以跟着走。 */
  ':where(html[data-fit] .app-root){',
  'top:calc(var(--sa-t,0px) + var(--fit-t,0px));',
  'right:calc(var(--sa-r,0px) + var(--fit-r,0px));',
  'bottom:calc(var(--sa-b,0px) + var(--fit-b,0px));',
  'left:calc(var(--sa-l,0px) + var(--fit-l,0px));',
  '}',
  /* 对局内 HUD：与 devices.css:36 的 .gm__hud 同构相加。对局中棋盘（canvas）保持全幅，
     挖孔下面照样走子；只有 HUD 层收进来。 */
  ':where(html[data-fit] .gm__hud){',
  'top:calc(var(--sa-t,0px) + var(--fit-t,0px));',
  'right:calc(var(--sa-r,0px) + var(--fit-r,0px));',
  'bottom:calc(var(--sa-b,0px) + var(--fit-b,0px));',
  'left:calc(var(--sa-l,0px) + var(--fit-l,0px));',
  '}',
  /* 全页面板：.modal 是 fixed 全屏遮罩，只推内边距，让面板本身离开被挡的边。 */
  ':where(html[data-fit] .modal){',
  'padding-top:calc(var(--sa-t,0px) + var(--fit-t,0px));',
  'padding-right:calc(var(--sa-r,0px) + var(--fit-r,0px));',
  'padding-bottom:calc(var(--sa-b,0px) + var(--fit-b,0px));',
  'padding-left:calc(var(--sa-l,0px) + var(--fit-l,0px));',
  '}',
  /* 保持整屏的浮层：toasts 与连接横幅不缩 —— 它们是提示，被挖孔挡一角也比被推着跑更好。
     这里显式声明，防止将来有人误加。 */
  ':where(html[data-fit] .toast-host){margin-top:var(--sa-t,0px)}',
  ':where(html[data-fit] .conn-banner){margin-bottom:var(--sa-b,0px)}',
].join('');

(function () {
  var win = typeof window !== 'undefined' ? window : null;
  if (!win) return;
  if (win.__SP_FORGE) return;                      // 幂等：重复注入只判一次

  /** 本机服务判据。拿不到 lobby 模块时保守判「非本机」（绝不因此向公网服务器暴露 Forge 层）。 */
  function isLocalService() {
    try {
      var L = win.__SP_LOBBY;
      return !!(L && typeof L.localService === 'function' && L.localService());
    } catch (e) { return false; }
  }

  /** 记一条诊断标记（验收探针读它）。写不进去（window 冻结）也不报错。 */
  function gate(v) { try { win.__SP_FORGE_GATE = v; } catch (e) { /* frozen */ } }

  /** import 一个 Forge 模块；失败只记录，不抛出。返回 promise（永不 reject）。
   *
   * ⚠ 为什么有两层 catch：`Promise.resolve(import(url))` **挡不住链接期失败**。
   * `import()` 失败时返回的是一个 already-rejected promise，`Promise.resolve()` 会原样透传
   * 那个 rejection，同步 try/catch 根本看不见它 —— 它只会变成一条 unhandledRejection，
   * 在控制台留一条红（并可能被运行方的「页面有无报错」判定抓住）。
   * 这正是 2026-10-15 实测踩到的：extensions.js 一度 import 了一个不存在的
   * `../resources/sources.js`，模块静默没挂上，同时 console 多了一条 unhandled rejection。
   * 所以这里显式 `.catch()` 吞掉，让「一个模块挂了不影响其余、也不留报错」成为可断言的契约
   * （tools/apk/forge-gate.test.mjs 的「load() never rejects」一例就是拿它当靶子）。
   */
  function load(url) {
    var p;
    try { p = win.importModule ? win.importModule(url) : import(url); }
    catch (e) { return Promise.resolve(null); }
    return Promise.resolve(p).then(function (m) { return m || null; }, function () { return null; });
  }

  var local = isLocalService();

  // ---- 分支 A：线上 / 社区服 —— 什么都不加载 ------------------------------------------------
  if (!local) {
    gate('online');
    try { win.__SP_FORGE = { gate: 'online', mounted: [] }; } catch (e) { /* frozen */ }
    return;
  }

  // ---- 分支 B：本机服务 —— 先补这一层的样式表，再逐个挂载 ---------------------------------------
  // `--fit-*` 的消费层：screenFit.js 只往 <html> 写变量并广播 resize，不缩任何东西；
  // 变量没人消费 = 滑块动了而布局不动。所以这里把那一半 CSS 一起带上。
  //
  // ⚠ 为什么是**内联 <style>** 而不是 <link href="/__sp/css/forge-fit.css">：
  // `MainActivity.serveShellAsset()` 把 `/__sp/<name>` 硬编码解析成 `openLocal("/js/" + name)`
  // （2026-10-09 为 ui/shellPanels.js 放开子路径时定的形），所以 `/__sp/css/…` 会变成
  // `/js/css/…` 而 404 —— 那条链只服务 js/ 之下的文件。上游 index.html 的 <link> 清单里也没有
  // 这个文件（它是 overlay 新增，不是同名覆盖），所以照 first-screen.js:363-376 的既有范式
  // 一次性内联注入，幂等于 id，无 DOM 就静默跳过。
  // 与 devices.css 的 --sa-* 是**相加**关系（系统安全区 + 用户微调），未调过任何一边时 fallback 0px，
  // 整体退化成与 devices.css 相同的布局 —— 没有双重刘海，也没有回归。
  (function injectFitCss() {
    try {
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
      if (typeof document.getElementById === 'function' && document.getElementById('sp-forge-fit-css')) return;
      var st = document.createElement('style');
      st.setAttribute('id', 'sp-forge-fit-css');
      st.textContent = FIT_CSS;
      var head = document.head || document.documentElement;
      if (!head || typeof head.appendChild !== 'function') return;
      head.appendChild(st);
    } catch (e) { /* no DOM: the layer still loads, the panel just has no styling */ }
  })();

  // ---- 分支 B：本机服务 —— 逐个挂载 ---------------------------------------------------------
  gate('local');
  var mounted = [];
  try { win.__SP_FORGE = { gate: 'local', mounted: mounted }; } catch (e) { /* frozen */ }
  var mark = function (name) { mounted.push(name); };

  // B1. 异形屏适配（screenFit.js）—— **import 即生效**：它在模块顶层建 store 并调 applyFit()，
  //     往 <html> 写 data-fit 与 --fit-l/r/t/b 并广播 resize。偏好为全 0 时是 no-op。
  //     消费这些变量的 CSS 见 css/screens/forge-fit.css。
  load('/__sp/ui/screenFit.js').then(function (m) { if (m) mark('screenFit'); });

  // B2. 大厅音乐（lobbyMusic.js）—— 向 audio 单例挂 lobbyMusicOverride，并注册 window/document 监听。
  load('/__sp/ui/lobbyMusic.js').then(function (m) { if (m) mark('lobbyMusic'); });

  // B3. 枢纽背景（hubBackdrop.js）与匹配流程（matchFlow.js）、公告（notices.js）——
  //     均为 preact-htm 组件，落位即可被上层屏幕引用。
  //     2026-10-25（上游 0.3.3 同步）：protocolScene.js 上游已自带（public/js/ui/protocolScene.js），
  //     extras 里那份同名副本按「上游优先」撤掉，这里不再预载 —— 页面自己 import 上游模块。
  load('/__sp/ui/hubBackdrop.js').then(function (m) { if (m) mark('hubBackdrop'); });
  load('/__sp/ui/matchFlow.js').then(function (m) { if (m) mark('matchFlow'); });
  load('/__sp/ui/notices.js').then(function (m) { if (m) mark('notices'); });

  // B4. 立绘解析链（portraitChain.js）与组件级改写（modComponents.js）—— 被 extensions.js import，
  //     这里显式落位一次，保证 Forge 模块面在本机服务下是完整的（audit: 两者顶层零副作用，纯声明）。
  load('/__sp/ui/portraitChain.js').then(function (m) { if (m) mark('portraitChain'); });
  load('/__sp/ui/modComponents.js').then(function (m) { if (m) mark('modComponents'); });

  // B5. mod 面板 C 层（extensions.js）—— 我方已有等效移植 `modPanels.js`（见其头注：契约照抄 Forge
  //     的 C 层）。这里仍把 Forge 原版落位，供诊断与逐条比对，**不替代** modPanels.js 的接线。
  load('/__sp/ui/extensions.js').then(function (m) { if (m) mark('extensions'); });

  // B6. 助战（supportModel.js / supportSync.js）—— 唯一需要先探测协议面的模块。
  //     不认识 `room.support` 的服务器（= 全部社区服，也可能包括本机服的旧热更树）一律不装，
  //     否则每次改选择都会发一条必被服务端拒的消息。
  function installSupport() {
    var net = win.net;
    if (!net || typeof net.request !== 'function') return;    // 页面还没起来：本局不同步，不猜
    // 空选择是 Forge 契约里永远合法的值（checkSupport 对空数组直接 ok），用它做探测不发任何实质状态。
    var probe;
    try { probe = Promise.resolve(net.request('room.support', { entries: [] })); }
    catch (e) { return; }                                     // 同步就拒 = 协议表里没有，不装
    if (!probe || typeof probe.then !== 'function') return;
    probe.then(function () {
      // 服务器认识这个消息 → 装同步。deps 全部显式注入（installSupportSync 的设计本意）。
      return load('/__sp/ui/supportSync.js').then(function (m) {
        if (!m || typeof m.installSupportSync !== 'function') return;
        try {
          m.installSupportSync({
            net: net,
            timers: { setTimeout: function (fn, ms) { return win.setTimeout(fn, ms); }, clearTimeout: function (id) { return win.clearTimeout(id); } },
            notify: function (text) { try { win.__SP_FORGE_SUPPORT_NOTE = String(text); } catch (e) { /* frozen */ } },
          });
          mark('supportSync');
        } catch (e) { /* 安装失败只影响助战同步，不影响其余 Forge 层 */ }
      });
    }, function () { /* 探测被拒 = 服务器不认识 room.support：不装，也不重试 */ });
  }

  // supportModel 与探测解耦：模型是纯逻辑，先落位；同步装不装由探测决定。
  load('/__sp/ui/supportModel.js').then(function (m) {
    if (!m) return;
    mark('supportModel');
    // 等页面把 net 建起来（本机服务首页时 net 已就绪；未就绪则本轮不同步）。
    if (win.net) installSupport();
    else {
      var waited = 0;
      var iv = win.setInterval(function () {
        waited += 200;
        if (win.net) { win.clearInterval(iv); installSupport(); }
        else if (waited >= 5000) { win.clearInterval(iv); }   // 5s 拿不到就放弃，不占轮询
      }, 200);
    }
  });
})();
