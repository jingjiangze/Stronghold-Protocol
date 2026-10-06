// home-layer.js — 首页覆盖层（**热更**：放 extras 里随外壳热更下发，由 shell-bridge.js 的加载器从
// `/__sp/home-layer.js` 取 —— 外壳自有前缀：serveShellAsset 先读 filesDir 热更树、再读 APK，绝不走网络）。
//
// 为什么是"盖一层"而不是改页面：re-apk 线的架构是 —— 首页 = 我们的一层本地附加层，直接盖在上传方
// （服务器 / 上游）的首页上面；其余界面 / 玩法跟随上传方。所以这一层：
//   · 不引入页面的任何模块（页面的脚本将来跟上传方走）—— 只用 DOM/CSS + `window.shell` 原生桥；
//   · 必须能热更 —— 只能从外壳自有前缀 `/__sp/` 取（见上），绝不落进会跟上传方走的页面脚本路径；
//   · 样式跟上游 —— 复用页面的 CSS 变量与类（--bg-0/--mint-700/--text-hi/--text-lo、.btn、.brackets），
//     自己只注入一小段补充样式（面板框架 + hover 反馈），不冻结任何一份 CSS。
//
// 状态机（"要不要盖"由我们自己的状态决定，不看页面内部状态）：
//   window.__SP_HOME = { show(), hide(), visible(), suppress(), sweep() }
//   · shown/hidden 是我们的**意图**，唯一真源；点任一"进入游戏"的按钮 → **先 hide() 再调桥**；
//     Java 返回键 / 其它外壳模块也可以直接调 show() / hide()；
//   · "首页态" = 上传方标题屏特征存在（TITLE_MARKS，一层 querySelector，不做启发式）。层只在
//     （意图=显示 && 首页态 && 未被 suppress）时真的显示：显示时全屏盖住对方首页并吃掉指针事件；
//     离开首页态（标题屏卸载 —— 例如 autostart 自动进入对局）立即收起，绝不盖住玩法界面；回到
//     首页态（返回键回首页 / 页面重载）再次盖上。特征判定失败 = 层不显示 = 现状（本层刻意选
//     "宁可少盖"的失败方向：探测拿不准时，用户看到的是上传方首页，而不是被一块错位的面板挡住）。
//   · 兜底探测：意图=隐藏但首页态又出现了（页面自己重载、切服落回首页、Java 没叫我们…）→ show()。
//     这是"首页永远该由我们盖着"的兜底；`data-sp-home-suppress` 标记（html 或 body 上任一处）
//     可整体关掉它，并让层立刻让开 —— 那是用户"我想看对方首页"的开关，不做任何抵抗。
//
// 层次（z-index）：层挂在页面的 `.app-root` 里，z-index 取 70 —— 高于 --z-screen(1) 盖住首页，
// 低于 --z-modal(80)：页面自己的 in-page 面板（壳面板 / 设置弹窗都走 .modal）才能弹在层上面，
// 「大厅 / 参数 / 配置 / 战绩」四个按钮才有意义。拿不到 .app-root（对方 DOM 不同）→ 挂 body、
// 用大 z-index（那种页面上 openPanel 桥一般也不存在，面板按钮会自动禁用，层级冲突不成立）。
//
// 幂等 / 防御：`window.__SP_HOME_LAYER` 守卫（重复注入只生效一次）；MutationObserver 回调合并
// （60ms 窗口，照 room-hook）；写 DOM 前先比对，不自激；任何 DOM / 桥异常都静默降级 —— 最坏情况是
// "层不显示"，等于现状。只用 document/window 标准 API（目标下限 Chromium 80：不用空值合并、
// 可选链这类新语法，也不碰页面的任何模块路径）。
(function () {
  'use strict';
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (window.__SP_HOME_LAYER) return;                  // 幂等：多次注入只生效一次
  window.__SP_HOME_LAYER = 1;

  var LAYER_ID = 'sp-home-layer';
  var STYLE_ID = LAYER_ID + '-style';
  var SUPPRESS_ATTR = 'data-sp-home-suppress';
  var SWEEP_MS = 60;                                   // 观察器回调合并窗口：一次 DOM 风暴只换来一次扫描
  var POLL_MS = 500;                                   // 本地服务就绪轮询（照标题页）
  var POLL_MAX_MS = 120000;                            // 轮询上限：超时回到未就绪（照标题页）
  var READY_CACHE_MS = 400;                            // 就绪查询节流：桥是同步 JNI，别每轮扫描都问一遍
  var Z_APP = 70;                                      // .app-root 内：> --z-screen(1)，< --z-modal(80)
  var Z_BODY = 2147482000;                             // 兜底挂 body：盖得住未知页面，仍低于 shell-bridge 弹窗的 2147483000
  var TITLE_MARKS = ['.title-screen', '.title-main', '.title-cn', '.title-login'];  // 上传方标题屏特征（首页态）

  var shown = true;            // 我们的状态（意图）：唯一真源。默认"要盖首页"。
  var root = null;             // 覆盖层节点
  var inAppRoot = null;        // root 是否挂在 .app-root 里（null = 还没挂过；决定 z-index 语义）
  var btns = {};               // act -> 按钮
  var why = {};                // act -> 禁用原因（给 title / 提示行）
  var hintEl = null;
  var localStarting = false;   // 本地服务启动中（轮询中）
  var localSince = 0;
  var localNote = '';          // 本地服务的临时提示（超时 / 起不来）
  var pollTimer = 0;
  var queued = 0;              // 观察器合并窗口内只扫一次
  var armed = false;
  var readyCache = null;       // 就绪缓存（null = 还没问过）
  var readyAt = 0;

  function nowMs() { return new Date().getTime(); }

  function docEl() { return document.documentElement || null; }

  function bodyEl() { return document.body || null; }

  /** 用户/Java 说"我想看对方首页"：标记在 html 或 body 上任一处即生效。 */
  function suppressed() {
    try {
      var d = docEl();
      var b = bodyEl();
      if (d && d.hasAttribute && d.hasAttribute(SUPPRESS_ATTR)) return true;
      if (b && b.hasAttribute && b.hasAttribute(SUPPRESS_ATTR)) return true;
    } catch (e) { /* 读不到标记：按未抑制处理（宁可盖上） */ }
    return false;
  }

  /** 首页态？只 querySelector 一层特征，命中一个即认（不写复杂启发式）。 */
  function homePresent() {
    if (typeof document.querySelector !== 'function') return false;
    for (var i = 0; i < TITLE_MARKS.length; i++) {
      var el = null;
      try { el = document.querySelector(TITLE_MARKS[i]); } catch (e) { el = null; }
      if (el) return true;
    }
    return false;
  }

  /** 层此刻应该真的显示吗：意图 + 首页态 + 未被抑制，三者缺一不可。 */
  function wanted() { return shown && !suppressed() && homePresent(); }

  /** 本地服务就绪：优先壳桥（已把 Java 的 "0"/"1" 归一），其次直接问原生。
   *  Java 返回字符串，`"0"` 不能当真（v4.2 的教训：旧写法 !!v 在 App 内恒真）。 */
  function readReady() {
    try {
      var api = window.__SP_SHELL;
      if (api && typeof api.localServiceReady === 'function') return api.localServiceReady() === true;
    } catch (e) { /* 落到原生桥 */ }
    try {
      var sh = window.shell;
      if (sh && typeof sh.localServiceReady === 'function') {
        var v = sh.localServiceReady();
        return v === true || String(v) === '1';
      }
    } catch (e) { /* 桥缺失 = 未就绪 */ }
    return false;
  }

  /** 就绪查询的节流包装（paint 每轮扫描都会问；轮询自己用 readReady 拿新鲜值）。 */
  function ready() {
    var t = nowMs();
    if (readyCache !== null && (t - readyAt) < READY_CACHE_MS) return readyCache;
    readyAt = t;
    readyCache = readReady();
    return readyCache;
  }

  /** 起本机服务：__SP_SHELL 的包装优先，其次原生 startLocalService，最后退到 setServer('local')（旧壳同语义）。 */
  function startLocalService() {
    try {
      var api = window.__SP_SHELL;
      if (api && typeof api.startLocalService === 'function') return api.startLocalService() !== false;
    } catch (e) { /* 试原生 */ }
    try {
      var sh = window.shell;
      if (sh && typeof sh.startLocalService === 'function') { sh.startLocalService(); return true; }
      if (sh && typeof sh.setServer === 'function') { sh.setServer('local'); return true; }
    } catch (e) { /* 桥异常：下面统一报不可用 */ }
    return false;
  }

  function canLocal() {
    try {
      var api = window.__SP_SHELL;
      if (api && typeof api.startLocalService === 'function') return true;
      var sh = window.shell;
      if (sh && (typeof sh.startLocalService === 'function' || typeof sh.setServer === 'function')) return true;
    } catch (e) { /* 不可用 */ }
    return false;
  }

  /** 一键进入：布防 autostart —— 切线路 / 起本地服务都会重载页面，重载后由上传方标题页
   *  takeAutostart() 消费一次自动 start()（我们进不了页面的 enterSession，这是桥上的既有进入路径）。 */
  function armAutostart() {
    try {
      if (window.shell && typeof window.shell.setAutostart === 'function') window.shell.setAutostart();
    } catch (e) { /* 旧壳没有：切完线路落在对方的（被我们盖住的）首页，用户再点一次 */ }
  }

  function canOnline() {
    try {
      return !!(window.shell && typeof window.shell.setServer === 'function'
        && typeof window.shell.setAutostart === 'function');
    } catch (e) { return false; }
  }

  function canPanels() {
    try { return !!(window.__SP_SHELL && typeof window.__SP_SHELL.openPanel === 'function'); } catch (e) { return false; }
  }

  // ---- 覆盖层 DOM ------------------------------------------------------------------------------

  /** 极少量补充样式：只给这一层自己的类，颜色/字体一律复用页面变量（取不到时给等值兜底）。 */
  function injectStyle() {
    try {
      if (!document.head || typeof document.createElement !== 'function') return;
      if (document.getElementById && document.getElementById(STYLE_ID)) return;
      var st = document.createElement('style');
      st.setAttribute('id', STYLE_ID);
      st.textContent = [
        '#' + LAYER_ID + '{-webkit-user-select:none;user-select:none}',
        '#' + LAYER_ID + '[data-sp-home="off"]{display:none}',
        '.sp-home__panel{position:relative;width:min(30rem,86vw);padding:.4rem .48rem .3rem;',
        'border:1px solid var(--line-2,#3e4b45);background:linear-gradient(180deg,rgba(20,24,22,.97),rgba(12,15,14,.97));',
        'box-shadow:0 .12rem .4rem rgba(0,0,0,.5)}',
        '.sp-home__micro{font-family:var(--font-display,inherit);font-size:.13rem;letter-spacing:.3em;color:var(--mint-700,#2a9e7f)}',
        '.sp-home__title{margin:.06rem 0 .04rem;font-size:.4rem;letter-spacing:.22em;color:var(--text-hi,#f2f2f2)}',
        '.sp-home__sub{margin:0 0 .26rem;font-size:.14rem;color:var(--text-lo,#8a948f)}',
        '.sp-home__btns{display:flex;flex-direction:column;gap:.12rem}',
        '.sp-home__row{display:flex;gap:.12rem}',
        '.sp-home__row>*{flex:1 1 0;min-width:0}',
        '.sp-home__hint{margin:.16rem 0 0;min-height:1em;font-size:.12rem;color:var(--text-lo,#8a948f);opacity:.85}',
      ].join('');
      document.head.appendChild(st);
    } catch (e) { /* 注入失败：行内几何兜底仍在，层照常可用 */ }
  }

  /** 层里的指针事件不冒泡到页面的 document 级处理器："吃掉指针事件"的 JS 侧保险。 */
  function stopEvent(ev) {
    try { if (ev && ev.stopPropagation) ev.stopPropagation(); } catch (e) { /* 静默 */ }
  }

  function mkBtn(act, label, cls) {
    var b = document.createElement('button');
    b.setAttribute('type', 'button');
    b.setAttribute('data-sp-home-btn', act);
    b.className = cls;                                  // 复用页面 .btn 样式（缺失时是浏览器默认按钮，仍可点）
    b.textContent = label;
    b.addEventListener('click', function (ev) { onAct(act, ev); }, false);
    return b;
  }

  function build() {
    if (root) return root;
    var el = null;
    try { el = document.createElement('div'); } catch (e) { return null; }   // 拿不到节点 = 层不显示（现状）
    root = el;
    el.setAttribute('id', LAYER_ID);
    el.setAttribute('data-sp-home', 'on');
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', '本地首页');
    el.className = 'sp-home';
    // 全屏几何用行内 style：不依赖注入的样式表。inset 是现代写法，四边 longhand 给老引擎兜底。
    el.setAttribute('style', [
      'position:fixed', 'top:0', 'right:0', 'bottom:0', 'left:0', 'inset:0',
      'z-index:' + Z_APP,
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:var(--bg-0,#0c0f0e)', 'color:var(--text-hi,#f2f2f2)',
      'pointer-events:auto', 'touch-action:manipulation', '-webkit-user-select:none', 'user-select:none'
    ].join(';'));

    var panel = document.createElement('div');
    panel.className = 'sp-home__panel brackets';
    var micro = document.createElement('div');
    micro.className = 'sp-home__micro';
    micro.textContent = 'STRONGHOLD PROTOCOL // HOME LAYER';
    var title = document.createElement('h1');
    title.className = 'sp-home__title';
    title.textContent = '卫戍协议：盟约';
    var sub = document.createElement('p');
    sub.className = 'sp-home__sub';
    sub.textContent = '首页由本地外壳承担；其余界面与玩法跟随当前服务器。';
    var list = document.createElement('div');
    list.className = 'sp-home__btns';
    btns.local = mkBtn('local', '本地服务', 'btn btn--primary btn--xl btn--block sp-home__btn');
    btns.online = mkBtn('online', '进入线上', 'btn btn--secondary btn--xl btn--block sp-home__btn');
    btns.lobby = mkBtn('lobby', '大厅', 'btn btn--secondary btn--lg btn--block sp-home__btn');
    var row = document.createElement('div');
    row.className = 'sp-home__row';
    btns.params = mkBtn('params', '参数', 'btn btn--ghost btn--sm sp-home__btn');
    btns.config = mkBtn('config', '配置', 'btn btn--ghost btn--sm sp-home__btn');
    btns.records = mkBtn('records', '战绩', 'btn btn--ghost btn--sm sp-home__btn');

    list.appendChild(btns.local);
    list.appendChild(btns.online);
    list.appendChild(btns.lobby);
    list.appendChild(row);
    row.appendChild(btns.params);
    row.appendChild(btns.config);
    row.appendChild(btns.records);
    hintEl = document.createElement('p');
    hintEl.className = 'sp-home__hint';
    hintEl.setAttribute('data-sp-home-hint', '');
    panel.appendChild(micro);
    panel.appendChild(title);
    panel.appendChild(sub);
    panel.appendChild(list);
    panel.appendChild(hintEl);
    el.appendChild(panel);
    el.addEventListener('click', stopEvent, false);
    return el;
  }

  /** 挂点与层级：.app-root 内（页面面板在其 --z-modal 之上）优先；拿不到就挂 body 并用大 z-index。 */
  function ensureParent() {
    var target = null;
    var inRoot = false;
    try { if (typeof document.querySelector === 'function') target = document.querySelector('.app-root'); } catch (e) { target = null; }
    if (target) inRoot = true;
    else target = bodyEl() || docEl();
    if (!target || !target.appendChild) return false;
    if (root.parentNode !== target) {
      try { target.appendChild(root); } catch (e) { return false; }
    }
    if (inAppRoot !== inRoot) {
      inAppRoot = inRoot;
      try { root.style.zIndex = String(inRoot ? Z_APP : Z_BODY); } catch (e) { /* 行内 z-index 兜底仍在 */ }
    }
    return true;
  }

  function setDisplay(on) {
    if (!root) return;
    if (root.__spOn === on) return;                      // 写前比对：不自激观察器
    root.__spOn = on;
    try { root.style.display = on ? '' : 'none'; } catch (e) { /* style 不可用：靠属性 + CSS */ }
    try { root.setAttribute('data-sp-home', on ? 'on' : 'off'); } catch (e) { /* 静默 */ }
  }

  /** 就绪/桥态 → 按钮：写前比对（不自激），桥是"后来才出现"的（shellPanels.js 是模块脚本）所以每轮都重算。 */
  function setBtn(act, label, enabled, reason) {
    var b = btns[act];
    if (!b) return;
    if (b.textContent !== label) b.textContent = label;
    var dis = !enabled;
    why[act] = dis ? (reason || 'unavailable') : '';
    if (b.disabled !== dis) { try { b.disabled = dis; } catch (e) { /* 属性兜底 */ } }
    try {
      if (dis) {
        if (b.getAttribute('disabled') === null) b.setAttribute('disabled', '');
        if (b.getAttribute('data-sp-home-why') !== why[act]) b.setAttribute('data-sp-home-why', why[act]);
        if (b.getAttribute('title') !== why[act]) b.setAttribute('title', why[act]);
      } else {
        b.removeAttribute('disabled');
        b.removeAttribute('data-sp-home-why');
        b.removeAttribute('title');
      }
    } catch (e) { /* 属性写失败不影响点击逻辑 */ }
  }

  function hintText() {
    var out = [];
    for (var act in btns) {
      if (btns.hasOwnProperty && !btns.hasOwnProperty(act)) continue;
      if (btns[act] && btns[act].disabled && why[act] && out.indexOf(why[act]) < 0) out.push(why[act]);
    }
    if (out.length) return '不可用：' + out.join('；');
    if (localNote) return localNote;
    return '';
  }

  function paint() {
    try {
      if (!root) return;
      var rdy = ready();
      if (rdy) { localStarting = false; localNote = ''; }
      var localLabel = localStarting ? '启动中…' : (rdy ? '进入' : '本地服务');
      var hi = canLocal(), on = canOnline(), pa = canPanels();
      setBtn('local', hi ? localLabel : '本地服务', hi, hi ? '' : '本地服务需要 App 版（缺少本地服务桥）');
      setBtn('online', '进入线上', on, on ? '' : '进入线上需要 App 版（缺少切服 / 自动进入桥）');
      setBtn('lobby', '大厅', pa, pa ? '' : '面板未加载（缺少 openPanel 桥）');
      setBtn('params', '参数', pa, pa ? '' : '面板未加载（缺少 openPanel 桥）');
      setBtn('config', '配置', pa, pa ? '' : '面板未加载（缺少 openPanel 桥）');
      setBtn('records', '战绩', pa, pa ? '' : '面板未加载（缺少 openPanel 桥）');
      var text = hintText();
      if (hintEl && hintEl.textContent !== text) hintEl.textContent = text;
    } catch (e) { /* 静默：按钮渲染失败不影响状态机 */ }
  }

  function sync() {
    try {
      var w = wanted();
      if (w && !root) build();
      if (root) {
        if (w) ensureParent();
        setDisplay(w);
      }
      paint();
    } catch (e) { /* 静默降级：最坏情况 = 层不显示（等于现状） */ }
  }

  /** 兜底探测 + 重画：隐藏着但首页态又出现了 → show()；否则只按当前状态重画。 */
  function sweep() {
    try {
      if (!shown && !suppressed() && homePresent()) shown = true;   // 用户没说要对方首页 → 重新盖上
      sync();
    } catch (e) { /* 静默：这条兜底失败就什么都不做 */ }
  }

  function show() { shown = true; sync(); }

  function hide() { shown = false; sync(); }

  /** 层此刻是不是真的盖在屏上（意图 + 首页态 + 未被抑制，全部成立且节点已挂上）。 */
  function visible() {
    try { return !!(root && root.__spOn === true); } catch (e) { return false; }
  }

  /** 读/写 suppress：true = 让开且之后不再自动盖上；false = 解除（首页态再次出现时自动盖上）。
   *  不加参数 = 读当前值。只认 html/body 上的属性，方便 Java 或其它外壳模块直接改。 */
  function suppressApi(on) {
    var v = (typeof on === 'undefined') ? suppressed() : !!on;
    if (typeof on !== 'undefined') {
      try {
        var d = docEl();
        if (d) {
          if (v) { d.setAttribute(SUPPRESS_ATTR, '1'); shown = false; }   // 立刻让开：用户要看对方首页
          else d.removeAttribute(SUPPRESS_ATTR);
        }
      } catch (e) { /* 静默 */ }
      sweep();
    }
    return v;
  }

  // ---- 按钮动作 --------------------------------------------------------------------------------

  /** 「本地服务」：未就绪 → 启动并轮询；就绪 → 「进入」。两态都先 hide() 再调桥（照 spec），
   *  并布防 autostart（起服务/切线路都会重载页面，重载后由标题页自动 start() 完成进入）。 */
  function clickLocal() {
    hide();
    armAutostart();
    var started = startLocalService();
    if (!started) { localNote = '本地服务启动失败（缺少启动桥）'; paint(); return; }
    if (!readReady()) startPoll();
    paint();
  }

  /** 「进入线上」：自动线路 + 自动进入。先 hide()，再按序 setServer('auto') → setAutostart()。 */
  function clickOnline() {
    hide();
    try {
      var sh = window.shell || null;
      if (sh && typeof sh.setServer === 'function') sh.setServer('auto');
    } catch (e) { /* 桥异常：可用性每轮扫描重算，最多是这次没切成 */ }
    armAutostart();
  }

  function startPoll() {
    if (pollTimer) return;
    localStarting = true;
    localNote = '';
    localSince = nowMs();
    var tick = function () {
      pollTimer = 0;
      try {
        if (!localStarting) return;
        var rdy = readReady();
        readyCache = rdy;
        readyAt = nowMs();
        if (rdy) { localStarting = false; paint(); return; }
        if (nowMs() - localSince > POLL_MAX_MS) { localStarting = false; localNote = '本地服务启动超时，可重试'; paint(); return; }
        pollTimer = setTimeout(tick, POLL_MS);
      } catch (e) { pollTimer = 0; }
    };
    try { pollTimer = setTimeout(tick, POLL_MS); } catch (e) { pollTimer = 0; localStarting = false; }
  }

  /** 面板按钮：层**不**隐藏（.app-root 内 z-index 70 < 页面面板的 80，面板弹在层上面）。
   *  兜底场景（没挂进 .app-root、用的高 z-index）：先让开，面板关掉后由兜底探测自动盖上。 */
  function openPanel(kind) {
    var api = null;
    try { api = window.__SP_SHELL || null; } catch (e) { api = null; }
    if (!api || typeof api.openPanel !== 'function') return false;
    if (!inAppRoot) hide();
    try { api.openPanel(kind); return true; } catch (e) { if (!inAppRoot) show(); return false; }
  }

  function onAct(act, ev) {
    try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* 静默 */ }
    try {
      if (act === 'local') { clickLocal(); return; }
      if (act === 'online') { clickOnline(); return; }
      openPanel(act);                                   // 'lobby' | 'params' | 'config' | 'records'
    } catch (e) { /* 静默：点坏了什么也不做（页面的原行为本来就被盖着） */ }
  }

  // ---- 观察器（照 room-hook：回调合并，60ms 窗口一次扫描） --------------------------------------

  function schedule() {
    if (queued) return;
    queued = 1;
    try { setTimeout(function () { queued = 0; sweep(); }, SWEEP_MS); } catch (e) { queued = 0; }
  }

  function arm() {
    if (armed) return;
    armed = true;
    injectStyle();
    sweep();
    try {
      var mo = new MutationObserver(schedule);
      mo.observe(docEl() || document, { childList: true, subtree: true, characterData: true });
    } catch (e) { /* 老引擎没有 MutationObserver：只靠首次扫描 + 桥调用时的 sync + 探针 */ }
  }

  // ---- 对外（Java 返回键 / 其它外壳模块 / 调试） ------------------------------------------------

  var api = {
    show: show,
    hide: hide,
    visible: visible,
    suppress: suppressApi,
    sweep: sweep
  };
  try { window.__SP_HOME = api; } catch (e) { /* window 只读（极端沙箱）：层仍然工作 */ }
  try { window.__SP_HOME_LAYER_SWEEP = sweep; } catch (e) { /* 同上 */ }

  if (document.readyState === 'loading') {
    try { document.addEventListener('DOMContentLoaded', arm, false); } catch (e) { arm(); }
  } else {
    arm();
  }
})();
