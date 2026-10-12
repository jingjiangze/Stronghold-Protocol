/* global window */ // 浏览器全局：extras 源码在 tools 树里（ESLint node 预设覆盖），window 在此声明
// js/ui/modPanels.js — mod 装载器的**面板宿主**（C 层，v1，业主 2026-10-12）。
//
// 它把 `pack.json` 的 `client.panels[]` 变成真的界面。契约照抄 Forge 的 C 层（docs/MOD-SURFACE.md
// §28.8 / §28.24 / §28.25，实现在 Forge 的 public/js/ui/extensions.js）：
//
//   · 模块导出 `mount(ctx)`（实包就是 `mount(ctx)` + `ctx.host`，不是 `mount(host, ctx)`）；
//   · `ctx` 是**冻结**的 `{ id, pack, slot, order, gate, log, host, session, net, me, data }`：
//       - `host` 是注册表自己拥有的一个普通元素，包往里面画，别处不许碰；
//       - `session.setPreload({required, ready})` 是**唯一**的 store 写口（入口闸门那两位）；
//       - `net.{on, status(), welcome()}` 是**唯一**的网络面：`status()`/`welcome()` 是只读快照，
//         没有读数时返回 null（面板可以画错，不能算错）；
//       - `me` 是**只读会话态 getter**（`playerId` / `name` / `room{code,mode,difficulty,inMatch,mySeat,
//         spectating,mods}`）—— 每次读都取当前值，因为面板挂上之后不会重挂；
//       - 没有 store 句柄、没有 engine、没有对局状态：**边界就是没传进来的东西**。
//   · 面板自己的 `styles[]` 以 <link> 注入（同一素材路由），主题由 ui/modsLoader.js 负责。
//   · **用不了的声明要点名**，绝不静默半挂（Forge 的立场）：未知槽位 / 拿不到模块 / 模块没有 mount
//     → 各一条 console 行，且不建任何容器。
//
// 与 Forge 的差异（如实写在代码里，不假装一样）：
//   ① 槽位宿主：Forge 让**上游组件自己**渲染 `[data-mod-slot]`；我们这条线不许改上游文件，所以由本模块
//      **在页面里找锚点**（下表 SLOT_ANCHORS）把容器插进去 —— 找不到锚点时退到该屏的根元素，再找不到就
//      不挂并点名。槽位名保持 Forge 的九个，锚点是我们这边的映射。
//   ② `net.welcome()`：上游 net.js 只留下 `serverName`/`playerId`，不保留整帧 welcome（Forge 在他们那棵树
//      里加了这一格）。这里返回能诚实给出的那部分 + `mods: null`；面板照约定「读不到就不画」。
//   ③ `ctx.session.prefs`（面板自己的偏好表）与 `ctx.data.get()`：上游没有对应的表，给 null / 空实现，
//      并在点名行里说明 —— 站点上 6 个面板包都没声明 `data[]`，prefs 也只有个别包用。
(function () {
  var win = (typeof window !== 'undefined' && window) ? window
    : (typeof globalThis === 'undefined' ? null : globalThis);
  if (!win || win.__SP_MOD_PANELS_READY) return;
  var doc = win.document;
  if (!doc || typeof doc.createElement !== 'function' || typeof doc.querySelector !== 'function') return;
  var loc = win.location || {};
  var host = String(loc.hostname || '').toLowerCase();
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') return; // 只在**本机页面**上挂
  win.__SP_MOD_PANELS_READY = true;

  var HOST_ATTR = 'data-sp-mod-slot';
  var LAYER = 2147480000; // 与公告板同层：在面板宿主（2147481000）之下、页面之上

  /** Forge 的九个槽位 → 我们这边的锚点选择器（按序取第一个命中的）。空数组 = 浮层（挂 documentElement）。 */
  var SLOT_ANCHORS = {
    'root.overlays': [],
    'root.guide': [],
    'screen.game.aside': ['.gm__corner', '.gm__gear', '.screen.gm'],
    'screen.game.hud': ['.gm__hud', '.screen.gm'],
    'screen.game.overlay': ['.gm__effects', '.gm__vignette', '.screen.gm'],
    'screen.result.footer': ['.result__main', '.screen.result'],
    'screen.loadout.detail': ['.lo', '.screen.loadout'],
    'screen.game.shopCard': [], // 可重复宿主（每张卡一个）：本版不挂，见点名
    'screen.game.bondStrip': ['.gm__bonds', '.gm__bond-list', '.screen.gm'],
  };

  var mounted = [];   // { id, pack, slot, host }
  var pending = [];   // 锚点还没出现的面板（下一轮 MutationObserver 再试）
  var observer = null;
  var logged = {};

  /** 对外报「挂了几个、都在哪些槽」（面板读它显示「本页生效」）。挂载是异步的，所以每次挂上都刷一次。 */
  function report() {
    try {
      win.__SP_MOD_PANELS = {
        at: new Date().toISOString(),
        mounted: mounted.length,
        slots: mounted.map(function (m) { return m.slot; }),
        ids: mounted.map(function (m) { return m.id; }),
      };
    } catch (e) { /* ignore */ }
  }

  function logOnce(key, msg) {
    if (logged[key]) return;
    logged[key] = 1;
    try { if (win.console && win.console.warn) win.console.warn('[sp-mods] ' + msg); } catch (e) { /* ignore */ }
  }

  function anchorFor(slot) {
    var sels = SLOT_ANCHORS[slot];
    if (!sels || !sels.length) return null;
    for (var i = 0; i < sels.length; i++) {
      try {
        var el = doc.querySelector(sels[i]);
        if (el) return el;
      } catch (e) { /* bad selector: try the next */ }
    }
    return null;
  }

  /** 建（或取回）这个面板的宿主容器；浮层槽位挂 documentElement，组件槽位挂进锚点。 */
  function hostFor(panel, pack) {
    var el = null;
    try { el = doc.querySelector('[' + HOST_ATTR + '="' + panel.id + '"]'); } catch (e) { el = null; }
    if (!el) {
      el = doc.createElement('div');
      el.setAttribute(HOST_ATTR, panel.id);
      el.setAttribute('data-sp-mod-pack', pack);
      el.setAttribute('class', 'sp-ui sp-mod-panel');
      var floating = !(SLOT_ANCHORS[panel.slot] || []).length;
      if (floating) {
        el.setAttribute('style', 'position:fixed;right:.24rem;bottom:.24rem;z-index:' + LAYER + ';pointer-events:auto');
      }
    }
    // 目标容器：锚点优先；锚点还没出现（SPA 还没渲染那一屏）就留在文档外层等下一轮。
    var target = anchorFor(panel.slot);
    var parent = target || (floatingTarget());
    if (parent && el.parentNode !== parent) {
      try { parent.appendChild(el); } catch (e) { return null; }
    }
    return el;
  }

  function floatingTarget() {
    try { return doc.documentElement || doc.body; } catch (e) { return null; }
  }

  /** 注入面板自己的样式表（同一素材路由）。 */
  function injectStyles(panel, pack) {
    for (var i = 0; i < panel.styles.length; i++) {
      var href = panel.styles[i];
      var id = 'sp-mod-css-' + pack + '-' + i;
      var have = null;
      try { have = doc.getElementById(id); } catch (e) { have = null; }
      if (have) continue;
      try {
        var link = doc.createElement('link');
        link.setAttribute('id', id);
        link.setAttribute('rel', 'stylesheet');
        link.setAttribute('href', href);
        var head = doc.head || doc.documentElement;
        if (head) head.appendChild(link);
      } catch (e) { /* ignore */ }
    }
  }

  /** 页面的 net / store / data 单例（懒加载，拿不到就 null —— 面板按约定「读不到就不画」）。 */
  var deps = { net: undefined, store: undefined, data: undefined };
  function loadDeps() {
    var specs = [['net', '/js/net.js'], ['store', '/js/store.js'], ['data', '/js/data.js']];
    return Promise.all(specs.map(function (s) {
      return import(s[1]).then(function (m) {
        if (s[0] === 'net') deps.net = m.net || null;
        if (s[0] === 'store') deps.store = m.store || null;
        if (s[0] === 'data') deps.data = m.data || null;
      }, function () { deps[s[0]] = null; });
    }));
  }

  /** `me` 的只读会话态（getter：每次读取当前值，因为面板不重挂）。 */
  function meView() {
    function snap() {
      var st = null;
      try { st = deps.store && typeof deps.store.get === 'function' ? deps.store.get() : null; } catch (e) { st = null; }
      var mine = (st && st.me) || {};
      var room = (st && st.room) || {};
      var seats = Array.isArray(room.seats) ? room.seats : null;
      var pid = mine.playerId != null ? mine.playerId : (deps.net && deps.net.playerId) || null;
      var idx = seats && pid != null ? seats.findIndex(function (s) { return s && s.playerId === pid; }) : -1;
      var spec = Array.isArray(room.spectators) ? room.spectators : [];
      return Object.freeze({
        playerId: pid,
        name: typeof mine.name === 'string' ? mine.name : null,
        room: Object.freeze({
          code: typeof room.code === 'string' ? room.code : null,
          mode: typeof room.mode === 'string' ? room.mode : null,
          difficulty: typeof room.difficulty === 'string' ? room.difficulty : null,
          inMatch: !!room.inMatch,
          mySeat: idx >= 0 ? idx : null,
          spectating: spec.some(function (s) { return s && s.playerId === pid; }),
          // 上游 room 里没有「本局声明的包集合」（Forge 的 W-A 加的），没有就是 null
          mods: Array.isArray(room.mods) ? Object.freeze(room.mods.slice(0, 32)) : null,
        }),
      });
    }
    var cache = null;
    return Object.freeze({
      get playerId() { if (!cache) cache = snap(); return cache.playerId; },
      get name() { if (!cache) cache = snap(); return cache.name; },
      get room() { return snap().room; },
    });
  }

  /** ctx：冻结的只读面（Forge 的九格 + me/data；写口只有 session.setPreload）。 */
  function panelContext(panel, pack, hostEl) {
    var log = Object.freeze({
      info: function () { try { win.console.log.apply(win.console, ['[mod ' + pack + ']'].concat([].slice.call(arguments))); } catch (e) { /* ignore */ } },
      warn: function () { try { win.console.warn.apply(win.console, ['[mod ' + pack + ']'].concat([].slice.call(arguments))); } catch (e) { /* ignore */ } },
      error: function () { try { win.console.error.apply(win.console, ['[mod ' + pack + ']'].concat([].slice.call(arguments))); } catch (e) { /* ignore */ } },
    });
    var session = Object.freeze({
      setPreload: function (state) {
        var patch = {};
        if (state && typeof state.required === 'boolean') patch.preloadRequired = state.required;
        if (state && typeof state.ready === 'boolean') patch.preloadReady = state.ready;
        if (!Object.keys(patch).length) return false;
        try {
          if (deps.store && typeof deps.store.patch === 'function') { deps.store.patch('session', patch); return true; }
        } catch (e) { /* ignore */ }
        return false;
      },
      // 上游没有「面板自己的偏好表」这一格：给一个内存实现（面板挂着的这段时间有效），并点名一次。
      prefs: (function () {
        var table = {};
        return Object.freeze({
          get: function (k) { return Object.prototype.hasOwnProperty.call(table, k) ? table[k] : null; },
          set: function (k, v) { table[k] = v; return true; },
        });
      })(),
    });
    var netFacade = Object.freeze({
      on: function (type, fn) {
        try { if (deps.net && typeof deps.net.on === 'function') return deps.net.on(type, fn); } catch (e) { /* ignore */ }
        return null;
      },
      sendResourceMessage: function () {
        logOnce('srm', 'net.sendResourceMessage is unavailable on this line (no raw-send seam) — ignored');
        return false;
      },
      status: function () {
        try { if (deps.net && typeof deps.net.snapshot === 'function') return Object.freeze(deps.net.snapshot()); } catch (e) { /* ignore */ }
        return null;
      },
      welcome: function () {
        // 上游 net.js 不保留整帧 welcome（只留 serverName / playerId）—— 只报能诚实给出的那部分。
        try {
          if (deps.net) return Object.freeze({ serverName: deps.net.serverName || null, playerId: deps.net.playerId || null, mods: null });
        } catch (e) { /* ignore */ }
        return null;
      },
    });
    var dataFacade = Object.freeze({
      get: function (name) {
        try {
          if (deps.data && typeof deps.data.get === 'function') return deps.data.get(name);
        } catch (e) { /* ignore */ }
        return null;
      },
    });
    return Object.freeze({
      id: panel.id,
      pack: pack,
      slot: panel.slot,
      order: panel.order,
      gate: panel.gate,
      log: log,
      host: hostEl,
      session: session,
      net: netFacade,
      me: meView(),
      data: dataFacade,
    });
  }

  function mountAll(manifest) {
    var packs = manifest && Array.isArray(manifest.packs) ? manifest.packs : [];
    var jobs = [];
    for (var i = 0; i < packs.length; i++) {
      var pack = packs[i];
      var panels = Array.isArray(pack.panels) ? pack.panels.slice() : [];
      panels.sort(function (a, b) { return (a.order || 0) - (b.order || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
      for (var j = 0; j < panels.length; j++) jobs.push({ pack: pack, panel: panels[j] });
    }
    if (!jobs.length) return;
    return loadDeps().then(function () {
      jobs.forEach(function (job) { mountOne(job.pack, job.panel); });
      keepAttached(); // 挂上之后：屏幕切来切去，宿主容器要跟着锚点走
    });
  }

  /** 挂一个面板：校验槽位 → 注入样式 → 建宿主 → import 模块 → `mount(ctx)`。用不了的声明一律点名。 */
  function mountOne(pack, panel) {
    if (!Object.prototype.hasOwnProperty.call(SLOT_ANCHORS, panel.slot)) {
      logOnce('slot:' + panel.slot, 'panel ' + panel.id + ' names an unknown slot "' + panel.slot + '" — not mounted');
      return;
    }
    if (SLOT_ANCHORS[panel.slot].length === 0 && panel.slot !== 'root.overlays' && panel.slot !== 'root.guide') {
      logOnce('repeat:' + panel.slot, 'panel ' + panel.id + ' wants the repeatable slot "' + panel.slot
        + '" (one host per card) — not mounted on this line');
      return;
    }
    for (var k = 0; k < mounted.length; k++) if (mounted[k].id === panel.id) return; // 已挂
    injectStyles(panel, pack.id);
    var hostEl = hostFor(panel, pack.id);
    if (!hostEl) {
      if (!pending.some(function (x) { return x.panel.id === panel.id; })) pending.push({ pack: pack.id, panel: panel });
      return; // 锚点还没出现：留待 MutationObserver 下一轮
    }
    var slot = panel.slot;
    import(panel.module).then(function (mod) {
      var fn = mod && (mod.mount || (mod.default && mod.default.mount));
      if (typeof fn !== 'function') {
        logOnce('mount:' + panel.id, 'module for panel ' + panel.id + ' exports no mount() — not mounted');
        return;
      }
      try {
        fn(panelContext(panel, pack.id, hostEl));
        mounted.push({ id: panel.id, pack: pack.id, slot: slot, host: hostEl });
        try { hostEl.setAttribute('data-sp-mod-mounted', '1'); } catch (e) { /* ignore */ }
        report();
      } catch (e) {
        logOnce('throw:' + panel.id, 'panel ' + panel.id + ' threw while mounting: ' + (e && e.message));
      }
    }, function () {
      logOnce('import:' + panel.id, 'panel module failed to load: ' + panel.module);
    });
  }

  /** 宿主掉出文档 / 锚点换了位置 → 把**同一个**容器搬回去（SPA 切屏时不重挂模块、不重画）。 */
  function keepAttached() {
    for (var i = 0; i < mounted.length; i++) {
      var m = mounted[i];
      var el = m.host;
      var connected = true;
      try { connected = el.isConnected !== false; } catch (e) { connected = true; }
      // 锚点现在出现了（切到那一屏了）→ 把**同一个**容器搬进槽位（模块画的 DOM 不重挂、不重画）。
      var target = anchorFor(m.slot);
      if (target && el.parentNode !== target) {
        try { target.appendChild(el); } catch (e) { /* ignore */ }
        continue;
      }
      if (!connected) {
        var back = hostFor({ id: m.id, slot: m.slot, styles: [] }, m.pack);
        if (back) logOnce('reattach:' + m.id, 're-attached panel ' + m.id + ' after a screen swap');
      }
    }
    if (pending.length) {
      var again = pending.slice();
      pending = [];
      for (var j = 0; j < again.length; j++) {
        // 锚点出现了就补挂：hostFor 建宿主，mountOne 走完 import + mount（mounted 去重挡住重复）
        mountOne({ id: again[j].pack }, again[j].panel);
      }
    }
    if (!observer) {
      try {
        if (typeof win.MutationObserver === 'function') {
          observer = new win.MutationObserver(function () {
            try { keepAttached(); } catch (e) { /* ignore */ }
          });
          observer.observe(doc.documentElement, { childList: true, subtree: true });
        }
      } catch (e) { observer = null; }
    }
  }

  function run() {
    var pr = null;
    try { pr = win.fetch('/sp/mods/loader', { cache: 'no-store' }); } catch (e) { pr = null; }
    if (!pr || typeof pr.then !== 'function') return;
    pr.then(function (r) { return r && r.ok === true ? r.json() : null; }).then(function (doc2) {
      if (!doc2 || typeof doc2 !== 'object') return;
      if (doc2.feature !== true) return;
      mountAll(doc2);
      report();
    }, function () { /* 离线 / 老 APK：静默 */ });
  }

  run();
})();
