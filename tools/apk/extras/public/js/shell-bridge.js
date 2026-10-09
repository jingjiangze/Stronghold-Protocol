/* global window, document, location, HTMLImageElement */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here
// shell-bridge.js — platform adapter for the shell features the patched client calls:
// title-screen server switch (点击「已连接服务器」), the host/room panel and the
// latency click-through path popup. On the APK the native JS interface ("shell",
// added by MainActivity) takes over each action; on the plain web version this file
// provides self-contained fallbacks (server-switch overlay that navigates, host
// actions disabled with a hint, path info inferred from the page origin).
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  // ---- global image CORS guard (must run before every module) --------------------------------
  // Assets are served from the CDN (weishucdn) and every texture path composites images into
  // canvases; without crossOrigin the canvas gets TAINTED and WebGL refuses the upload
  // ("texImage2D ... Tainted canvases may not be loaded"), which killed the 3D board.
  // Forcing crossOrigin='anonymous' on every <img> makes all loads CORS-mode; the CDN and the
  // shell interceptor both answer with Access-Control-Allow-Origin, so canvases stay clean.
  // Same-origin images are unaffected.
  try {
    var desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (desc && desc.set && !window.__SP_CORS_HOOK) {
      window.__SP_CORS_HOOK = 1;
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        get: desc.get,
        set: function (value) {
          try {
            if (value && !this.crossOrigin) this.crossOrigin = 'anonymous';
          } catch (e) { /* ignore */ }
          desc.set.call(this, value); // setter 不得返回值（no-setter-return）；该返回值本来就被忽略
        },
      });
    }
  } catch (e) { /* very old engine: leave as is */ }

  var NATIVE = window.shell && typeof window.shell.pickServer === 'function' ? window.shell : null;

  // Known server hosts → labels (used by the switch overlay and the path popup).
  var SERVER_HOSTS = {
    'stronghold.jiangjiangze.icu': '盒子 · CF 隧道（主）',
    'weishu.jiangjiangze.icu': '盒子 · CF 隧道（网页入口）',
    'stronghold2.jiangjiangze.icu': '盒子 · CF 隧道（备用 B）',
    'weishu2.jiangjiangze.icu': '盒子 · CF 隧道（备用 B）',
    'map.u712507.nyat.app': '樱花内网穿透（高速）'
  };
  // Extra fallback origins discovered from config.json (same origin only).
  var SERVER_LIST = [
    { url: '', label: '自动（当前）' },
    { url: 'https://map.u712507.nyat.app:38916', label: '樱花内网穿透（高速）' },
    { url: 'https://stronghold.jiangjiangze.icu', label: '盒子 · CF 隧道（主）' },
    { url: 'https://stronghold2.jiangjiangze.icu', label: '盒子 · CF 隧道（备用 B）' }
  ];

  try {
    fetch('/dl/config.json', { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (cfg) {
      if (!cfg || !Array.isArray(cfg.fallbackOrigins)) return;
      for (var i = 0; i < cfg.fallbackOrigins.length; i++) {
        var u = cfg.fallbackOrigins[i];
        if (typeof u === 'string' && u.indexOf('https://') === 0
          && !SERVER_LIST.some(function (s) { return s.url === u; })) {
          SERVER_LIST.push({ url: u, label: u.replace(/^https:\/\//, '') });
        }
      }
    }).catch(function () { /* offline or host origin: static list stands */ });
  } catch (e) { /* fetch unavailable */ }

  /** v4.0: 构造跳转 URL —— 保留目标 origin/pathname，合并当前页查询，`#` 始终最后。
   *  替代旧的 `url.replace(/\/+$/,'') + '/' + location.search`（在 /play 上补回 `/` 产生 404）。 */
  function navUrl(base) {
    try {
      var u = new URL(String(base || ''), location.href);
      var cur = new URLSearchParams(location.search);
      cur.forEach(function (v, k) { u.searchParams.set(k, v); });
      return u.toString();
    } catch (e) { return String(base || ''); }
  }

  function overlay(html) {
    var root = document.createElement('div');
    root.setAttribute('style', [
      'position:fixed', 'z-index:2147483000', 'inset:0', 'display:grid', 'place-items:center',
      'background:rgba(6,9,8,.72)', 'font:14px/1.6 system-ui,"Noto Sans SC",sans-serif', 'color:#d8e3de'
    ].join(';'));
    var box = document.createElement('div');
    box.setAttribute('style', [
      'min-width:18rem', 'max-width:88vw', 'border:1px solid #2c3a35', 'background:#111614',
      'padding:18px 22px', 'border-radius:6px', 'box-shadow:0 12px 40px rgba(0,0,0,.5)'
    ].join(';'));
    box.innerHTML = html;
    root.appendChild(box);
    root.addEventListener('click', function (ev) { if (ev.target === root) close(); });
    function close() { try { document.body.removeChild(root); } catch (e) { /* already gone */ } }
    root.__close = close;
    document.body.appendChild(root);
    return root;
  }

  function btnStyle() {
    return 'display:block;width:100%;margin:6px 0;padding:10px 14px;background:transparent;'
      + 'border:1px solid #4ed8af;color:#4ed8af;border-radius:4px;font-size:14px;cursor:pointer;text-align:left';
  }

  function openSwitch() {
    // labels only — no URLs/domains are ever displayed
    var rows = SERVER_LIST.map(function (s, i) {
      return '<button data-i="' + i + '" style="' + btnStyle() + '">' + (s.label || '自定义线路') + '</button>';
    }).join('');
    var root = overlay('<div style="font-size:16px;color:#4ed8af;letter-spacing:1px;margin-bottom:8px">切换服务器</div>'
      + rows
      + '<button data-manual="1" style="' + btnStyle() + '">自定义线路…</button>'
      + '<button data-close="1" style="' + btnStyle() + ';border-color:#2c3a35;color:#8a9a93">取消</button>');
    root.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var close = function () { root.__close(); };
      var idx = t.getAttribute('data-i');
      if (idx !== null) {
        var s = SERVER_LIST[Number(idx)];
        if (!s.url) { close(); return; }
        location.href = navUrl(s.url);
        return;
      }
      if (t.getAttribute('data-manual') !== null) {
        var v = window.prompt('服务器地址（https:// 或 http://IP:3000）', '');
        if (!v) return;
        v = /^https?:\/\//.test(v) ? v : 'https://' + v;
        close();
        location.href = navUrl(v);
        return;
      }
      if (t.getAttribute('data-close') !== null) close();
    });
  }

  function openPath(ms) {
    var dc = !!window.__SP_DC_ACTIVE;
    var host = location.host || '';
    var kind, detail;
    if (dc) {
      kind = '打洞直连（WebRTC DataChannel）';
      detail = '数据经打洞后的点对点通道，不经过任何服务器。';
    } else if (SERVER_HOSTS[host]) {
      kind = '经服务器 · ' + SERVER_HOSTS[host];
      detail = '当前经服务器转发；换用直连（ZeroTier/IPv6/局域网）或离线服务可显著降低延迟。';
    } else {
      kind = '直连房主';
      detail = '数据直达房主设备，未经任何中转服务器。';
    }
    // v2.6.2: surface the server actually in use. The server LIST stays name-only (v2.4 rule);
    // this popup is the one place the current host is shown, per owner direction.
    // DC is exempt on purpose: the peer address is a friend's home network, not ours to show.
    var serverLine = '';
    if (!dc) {
      var cur = '';
      try {
        if (window.shell && typeof window.shell.currentServer === 'function') {
          cur = String(window.shell.currentServer() || '');
        }
      } catch (e) { /* bridge absent (plain web) */ }
      var shown = '';
      if (cur) {
        if (cur.indexOf('127.0.0.1') === 0 || cur.indexOf('http://127.0.0.1') === 0) shown = '本机离线服务';
        else {
          try { shown = new URL(cur).host || ''; } catch (e) { shown = ''; }
        }
      }
      if (!shown) shown = host; // plain web build: the page origin is the answer
      if (shown) serverLine = '<div style="margin-top:6px;opacity:.85;font-size:13px">当前服务器：<b>'
        + String(shown).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</b></div>';
    }
    var ping = Number.isFinite(ms) ? Math.round(ms) + ' ms' : '--';
    var root = overlay('<div style="font-size:16px;color:#4ed8af;letter-spacing:1px;margin-bottom:6px">连接路径</div>'
      + '<div style="margin:4px 0"><b>' + kind + '</b></div>'
      + '<div style="opacity:.75;font-size:13px">' + detail + '</div>'
      + serverLine
      + '<div style="margin-top:8px;opacity:.75;font-size:13px">当前延迟：' + ping + '</div>'
      + '<div style="margin-top:8px;opacity:.55;font-size:12px">提示：直连（ZeroTier / IPv6 / 局域网）通常 15–60ms；隧道转发约 300–900ms。</div>'
      + '<button data-close="1" style="' + btnStyle() + ';margin-top:12px;text-align:center">关闭</button>');
    root.addEventListener('click', function (ev) {
      if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-close') !== null) root.__close();
    });
  }

  function toast(msg) {
    var el = overlay('<div style="text-align:center;border:0;background:transparent">' + msg + '</div>');
    setTimeout(function () { el.__close(); }, 1800);
  }

  window.__SP_SHELL = {
    isApp: !!NATIVE,
    pickServer: function () {
      // the in-page game-styled panel (shellPanels.js) is the primary UI; the overlay below is a fallback
      if (window.__SP_SHELL.openPanel) { window.__SP_SHELL.openPanel('servers'); return; }
      openSwitch();
    },
    // v3.6: 网页回退的线路数据 —— 无 shell 时服务器面板用它渲染统一列表（点格跳转）。App 转交原生桥。
    // URL 只在本页使用、不显示；无网络请求（SERVER_LIST 是静态表 + /dl/config.json 既有加载）。
    getServers: function () {
      if (NATIVE && typeof NATIVE.getServers === 'function') { try { return NATIVE.getServers(); } catch (e) { /* fall through */ } }
      try {
        return JSON.stringify(SERVER_LIST.map(function (s, i) {
          return { id: s.url ? ('web:' + i) : 'auto', label: s.label || '自定义线路', url: s.url || '', current: !s.url };
        }));
      } catch (e) { return '[]'; }
    },
    checkUpdate: function () {
      // APK: hand the whole check/install path to the shell; plain web (or a shell too old to
      // expose it): hard refresh with a cache-buster so the newest deployed content is fetched.
      // Deliberately no fetch() here — the only network action is re-loading this page.
      if (NATIVE && NATIVE.checkUpdate) { try { NATIVE.checkUpdate(); return; } catch (e) { /* fall through */ } }
      try { toast('正在刷新到最新内容…'); } catch (e) { /* ignore */ }
      try {
        var u = new URL(location.href);
        u.searchParams.set('v', String(Date.now()));
        location.replace(u.toString());
      } catch (e) {
        try { location.reload(); } catch (e2) { /* very old engine */ }
      }
    },
    host: function () {
      if (NATIVE && NATIVE.host) { try { NATIVE.host(); return; } catch (e) { /* fall through */ } }
      toast('房主功能仅在 App 版可用');
    },
    params: function () {
      if (window.__SP_SHELL.openPanel) { window.__SP_SHELL.openPanel('params'); return; }
      if (NATIVE && NATIVE.params) { try { NATIVE.params(); return; } catch (e) { /* fall through */ } }
      toast('房主参数仅在 App 版可用');
    },
    hostStatus: function () {
      if (NATIVE && NATIVE.hostStatus) { try { return NATIVE.hostStatus(); } catch (e) { return ''; } }
      return '';
    },
    // v3.5: 本地服务（本机房主服务）——「本地服务」按钮先 startLocalService()，再每 500ms 轮询
    // localServiceReady()；就绪后按钮变「进入」，走页面里的常规 start（enterSession）。
    startLocalService: function () {
      // a future shell may expose the exact entry point; today's shell starts the host on demand
      // through setServer('local') (ensureHostAndSwitch: materialise → Node → healthz → switch).
      if (NATIVE && typeof NATIVE.startLocalService === 'function') {
        try { NATIVE.startLocalService(); return true; } catch (e) { /* fall through */ }
      }
      if (NATIVE && typeof NATIVE.setServer === 'function') {
        try { NATIVE.setServer('local'); return true; } catch (e) { /* fall through */ }
      }
      try { toast('本地服务仅在 App 版可用'); } catch (e) { /* ignore */ }
      return false;
    },
    localServiceReady: function () {
      if (NATIVE && typeof NATIVE.localServiceReady === 'function') {
        // v4.2: Java 返回字符串 "0"/"1"，旧写法 !!v 把 "0" 也当成 true（App 内恒就绪，
        // 「进入」按钮永不触发 startLocal）。字符串/布尔两种形态都要判对。
        try { var v = NATIVE.localServiceReady(); return v === true || String(v) === '1'; } catch (e) { /* fall through */ }
      }
      try {
        // served by the embedded Node (the local line) = the host is up and enterable
        if (NATIVE && typeof NATIVE.currentServerId === 'function'
          && String(NATIVE.currentServerId() || '') === 'sp-phone-host') return true;
        if (NATIVE && typeof NATIVE.getServers === 'function') {
          var arr = JSON.parse(NATIVE.getServers());
          for (var i = 0; Array.isArray(arr) && i < arr.length; i++) {
            if (arr[i] && arr[i].id === 'local' && arr[i].current) return true;
          }
        }
      } catch (e) { /* ignore */ }
      return false;
    },
    showPath: openPath
  };

  // ---- v5.4: 传输方案 + 局域网发现桥（热更） ----------------------------------------------------
  // 契约：旧 APK 没有这些 @JavascriptInterface —— 这里绝不凭空造出方法，只在原生确实提供时
  // 挂一层 try/catch 转发包装。页面据此判定：getTransport 不存在/返回 undefined → 参数面板的
  // 传输方案行置灰；lanScan 不存在 → 大厅的「局域网」小节完全不渲染（不显示任何占位）。
  var SH = (typeof window !== 'undefined' && window.shell) || null;
  function wrapNative(name, make) {
    if (!SH || !NATIVE || typeof NATIVE[name] !== 'function') return;
    try { SH[name] = make(NATIVE[name]); } catch (e) { /* 注入对象不可写：调用方直接用原生方法 */ }
  }
  wrapNative('getTransport', function (native) {
    return function () { try { return native(); } catch (e) { return undefined; } };
  });
  // 保存必须能报失败（审查发现#3）：包装吞掉异常会让面板提示「已保存」而偏好其实没落盘。
  // 原生 void 方法没有返回值，这里显式返回 true；异常返回 false 由调用方决定文案。
  wrapNative('setTransport', function (native) {
    return function (v) {
      try { native(v); return true; } catch (e) { return false; }
    };
  });
  wrapNative('lanScan', function (native) {
    return function (mode, code) {
      try { if (window.__SP_LAN) window.__SP_LAN.scanning = true; } catch (e) { /* ignore */ }
      // 审查发现#5：异常不能折成 null —— null 在页面里等于「桥不存在 → 需更新 APK」，
      // 用户会看到升级建议而不是可重试的失败。抛异常让调用方走 catch 分支。
      return native(mode, code);
    };
  });
  // v8.1: 资源缓存状态桥 —— Java ShellBridge 的 artCacheStatus()/clearArtCache() 一律返回 JSON
  // 字符串（artCacheStatus: manifestHash/cachedFiles/cachedBytes/cacheRoot/pending，pending=-1 表示
  // Java 不知道；clearArtCache: removedFiles/removedBytes/keptPacks）。桥调用本身 O(1)（Java 侧不得
  // 走文件系统遍历），异常折成空串让页面保留上一次的读数。页面永远自己 JSON.parse，绝不在这里
  // 猜结构。包装的仍是 window.shell 上的原生方法（与 getTransport 等同一套路）。
  wrapNative('artCacheStatus', function (native) {
    return function () { try { return native(); } catch (e) { return ''; } };
  });
  wrapNative('clearArtCache', function (native) {
    return function () { try { return native(); } catch (e) { return ''; } };
  });
  // v8.3（owner 口径 2026-10-09「预载进度要显示下载速度/解压速度/预载速度」）：素材包通道的状态桥。
  // 契约：Java ShellBridge.artSyncStatus() 返回 JSON 字符串（active/stage/pack/packsDone/packsTotal/
  // bytesDone/bytesTotal/dlBps/unzipBps/etaMs）。它必须 O(1)：读同步器内存里的计数，绝不遍历文件系统
  // （拦截器与预载都会调，慢一次就是卡一次）。异常折成空串，页面保留上一次读数。
  wrapNative('artSyncStatus', function (native) {
    return function () { try { return native(); } catch (e) { return ''; } };
  });

  // ---- v7.6: 服务端界面（「用该服自有客户端」）开关的适配层 ----------------------------------------
  // 契约：桥 useRemoteClient(id, on) 的 id 是**签名清单条目 id**（不是 host —— Java 侧
  // hostOfEntry(id) 自己解析 host，域名永远不下发到页面）；on=true 立刻切到该服并导航（该服页面 +
  // 资源接管），on=false 若当前就在该 host 上则就地重载回本地树、否则只写偏好。
  // 旧 APK 没有 remoteClientCurrent()/setRemoteClientDefault()：前者是「这个 APK 有原生退出口
  // （showShellMenu 的「回到本地客户端」）」的能力标记，后者让设置里的默认值交给 Java 拦截器。
  // 页面据此判定：remoteClientEscape 非真 → 只允许「关」不允许「开」，否则用户会把自己锁在服务器页里
  // （开启后页内没有外壳界面，而 origin + 偏好都会持久化，冷启动还会直连该服）。
  try {
    if (window.__SP_SHELL && NATIVE) {
      window.__SP_SHELL.remoteClientEscape = typeof NATIVE.remoteClientCurrent === 'function';
      if (typeof NATIVE.useRemoteClient === 'function') {
        window.__SP_SHELL.useRemoteClient = function (id, on) {
          try { NATIVE.useRemoteClient(String(id == null ? '' : id), !!on); return true; } catch (e) { return false; }
        };
      }
      if (typeof NATIVE.setRemoteClientDefault === 'function') {
        window.__SP_SHELL.setRemoteClientDefault = function (on) {
          try { NATIVE.setRemoteClientDefault(!!on); return true; } catch (e) { return false; }
        };
      }
    }
  } catch (e) { /* 注入对象不可写：面板退化到「仅 window.shell 原生方法」 */ }

  // ---- v8.1: 资源缓存状态桥的能力标记与转发（preload-center.js 消费）------------------------------
  // 契约：Java 的 artCacheStatus()/clearArtCache() 只在新 APK 上存在。这里只在原生确实提供时
  // 才挂 __SP_SHELL.artCacheBridge / artCacheStatus / clearArtCache —— 旧 APK（或网页）下
  // artCacheBridge 非真，页面据此退回「浏览器缓存」路径（今天的全部行为），绝不假装能读 Android
  // 缓存。artCacheBridge 只在 artCacheStatus 存在时为真：读数是这套 UI 的根，清缓存按钮同理。
  try {
    if (window.__SP_SHELL && NATIVE) {
      window.__SP_SHELL.artCacheBridge = typeof NATIVE.artCacheStatus === 'function';
      if (typeof NATIVE.artCacheStatus === 'function') {
        window.__SP_SHELL.artCacheStatus = function () {
          try { return NATIVE.artCacheStatus(); } catch (e) { return ''; }
        };
      }
      if (typeof NATIVE.clearArtCache === 'function') {
        window.__SP_SHELL.clearArtCache = function () {
          try { return NATIVE.clearArtCache(); } catch (e) { return ''; }
        };
      }
    }
  } catch (e) { /* 注入对象不可写：页面退化到浏览器缓存路径 */ }

  // ---- v8.3: 素材包通道状态桥的能力标记与转发（preload-center.js 消费）-----------------------------
  // 契约与上面 artCacheBridge 同形：只有原生真的提供 artSyncStatus() 时才挂 artSyncBridge，旧 APK
  // （或网页）下该标记非真 —— 面板据此**不渲染**解压速度行，绝不猜一个数。包通道的下载/解压速度只有
  // Java 知道（文件通道的速度由 art-prefetch 自己量，两条口径在面板上分列，不混）。
  try {
    if (window.__SP_SHELL && NATIVE) {
      window.__SP_SHELL.artSyncBridge = typeof NATIVE.artSyncStatus === 'function';
      if (typeof NATIVE.artSyncStatus === 'function') {
        window.__SP_SHELL.artSyncStatus = function () {
          try { return NATIVE.artSyncStatus(); } catch (e) { return ''; }
        };
      }
    }
  } catch (e) { /* 注入对象不可写：面板退化到「无包通道数据」 */ }

  // ---- v8.4: 预载游标的跨 origin 存储（审计 2026-10-09 附加 A）-----------------------------------
  // 页面侧把预载游标存在 localStorage 里，而它**按 origin 隔离** —— 页面的 origin 就是当前连接的
  // 服务器，所以**切服 = 换 origin = 游标不可见 = 7969 条从头再走一遍**（芯片从 0 重数、owed 列表
  // 丢失）。这里把同一份记录转发到 filesDir（与 player-data 的 spData 同一思路），跨 origin 可见。
  // 契约同上：只有原生真的提供这对方法时才挂 artWalkBridge，页面侧据此决定要不要优先用它。
  try {
    if (window.__SP_SHELL && NATIVE) {
      window.__SP_SHELL.artWalkBridge = typeof NATIVE.artWalkGet === 'function'
        && typeof NATIVE.artWalkPut === 'function';
      if (window.__SP_SHELL.artWalkBridge) {
        window.__SP_SHELL.artWalkGet = function () {
          try { return NATIVE.artWalkGet(); } catch (e) { return ''; }
        };
        window.__SP_SHELL.artWalkPut = function (text) {
          try { return NATIVE.artWalkPut(String(text == null ? '' : text)) === true; } catch (e) { return false; }
        };
      }
    }
  } catch (e) { /* 注入对象不可写：页面退化到 localStorage（功能不消失，只是切服要重走） */ }

  // ---- v8.2: 界面来源的默认值下推（**只对老 APK**；v8.4 起按能力探测，业主 2026-10-09 口径）-------
  // 背景：vc2006–vc2008 的 Java 缺省是「服务端界面」，而那时**没有首页作用域门** —— 玩家一开就落在
  // 别人的服务器页上（首页被顶掉）。Java 是编译进去的、热更改不动，但**默认值键可以从页面写**：
  // 只要页面还没被玩家的显式选择覆盖过（localStorage 里没有 sp.pref.remoteClient），就把全局默认
  // 下推成 false = 本地客户端优先。
  //
  // v8.4（业主 2026-10-09 新口径「连接服务器：仅首页页面叠加，其他 ui 按服务器正常显示」）：
  // 新 APK 有**首页作用域门**（首页恒本地），它的缺省 true 表达的已经是「首页之外按服务器」——
  // 这时**绝不能再下推 false**，否则会把口径按回本地客户端。判定用能力探测
  // `remoteClientSemantics()`（老 APK 没有这个方法 → undefined）。
  try {
    if (window.__SP_SHELL && NATIVE && typeof NATIVE.setRemoteClientDefault === 'function'
        && typeof NATIVE.remoteClientSemantics !== 'function') {
      var rcRaw = null;
      try { rcRaw = window.localStorage ? window.localStorage.getItem('sp.pref.remoteClient') : null; } catch (e2) { rcRaw = null; }
      if (rcRaw == null) {
        NATIVE.setRemoteClientDefault(false);
        try { window.__SP_SHELL.remoteClientDefaultPushed = false; } catch (e3) { /* 只读对象 */ }
      }
    } else if (window.__SP_SHELL && NATIVE && typeof NATIVE.remoteClientSemantics === 'function') {
      // 新 APK：Java 的缺省自己说了算（首页恒本地 + 首页之外按服务器）。标记一下便于面板/诊断区分。
      try { window.__SP_SHELL.remoteClientDefaultPushed = true; } catch (e4) { /* 只读对象 */ }
    }
  } catch (e) { /* 老 APK 没有这个方法：保持它的原缺省 */ }

  // 局域网扫描结果的回吐口（Java → 页面）：Java 扫描完成后调用 window.__SP_LAN.onFound(jsonString)。
  var lanCallback = null;
  var lanSeq = 0;        // 每次 lanScan 递增；结果必须带回同号才被采纳
  var lanPending = 0;    // 未回吐的扫描数：只有归零才解除「扫描中」
  var lanApi = {
    scanning: false,
    /** 注册结果回调（单槽：后注册者覆盖前者，避免面板反复开关累积陈旧闭包）。 */
    onScan: function (fn) { if (typeof fn === 'function') lanCallback = fn; },
    /**
     * 发起一次扫描并拿到本轮的序号（审查发现#4）：超时后用户重试时，上一轮迟到的结果会带着
     * 旧序号回来 —— 只有序号等于当前值才分发，否则丢弃，避免旧结果替换当前列表并清掉当前超时。
     */
    begin: function () { lanSeq += 1; lanPending += 1; return lanSeq; },
    /** 解析 JSON，把 rooms 数组（+完整对象）交给回调；解析失败静默，绝不影响页面。 */
    onFound: function (json, seq) {
      // Java 侧不传序号（它不知道本轮是谁发起的）：按「有在途扫描」处理，采纳最新一轮。
      var tag = (typeof seq === 'number') ? seq : lanSeq;
      lanPending = Math.max(0, lanPending - 1);
      if (lanPending === 0) lanApi.scanning = false;
      if (tag !== lanSeq) return; // 过期扫描：丢弃
      var data = null;
      try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { data = null; }
      if (!data || typeof data !== 'object') return;
      var rooms = Array.isArray(data.rooms) ? data.rooms : [];
      if (lanCallback) { try { lanCallback(rooms, data, tag); } catch (e) { /* 回调异常不影响桥 */ } }
    },
  };
  window.__SP_LAN = lanApi;

  // ---- v6.0: 房间页 DOM 钩子（热更） -----------------------------------------------------------
  // 只从 `/__sp/` 取（外壳自有前缀：serveShellAsset 先读 filesDir 热更树、再读 APK，**绝不走网络**），
  // 所以即使页面来自服务器、`/js/**` 将来跟服务器走，这个钩子也一定能加载、且能随热更更新。
  // 钩子本体只做一件事：把房间页「复制密钥」四个小字换成「公开到大厅」（读不到目标就什么都不做）。
  try {
    // v8.0: 外壳设置命名空间（shell-prefs.js）—— **最先**注入，保证外观/公告/大厅读设置前
    // 已经完成「保险库（player-v1 doc.prefs）↔ 本 origin localStorage」的启动合并与迁移。
    // 它只依赖 player-data.js（MainActivity 已在 shell-bridge 之前注入），无网络、无页面模块；
    // 缺它就退回各模块自己的 localStorage 兜底（旧内容树）。
    if (!window.__SP_PREFS) {
      var spPrefs = document.createElement('script');
      spPrefs.src = '/__sp/shell-prefs.js';
      spPrefs.async = false;
      document.head.appendChild(spPrefs);
    }
    // 上传方（非本地树）页面不会带我们的 lobby.js，钩子在上面就只会把「复制密钥」换成一块点不动的
    // 牌子 —— 所以缺 `__SP_LOBBY.togglePublic` 时先把我们自己的 lobby.js 补上（同一个自有前缀、
    // 同样绝不走网络）。本地树页面由 index.html 的 patch 已经加载了它，这一行自然跳过、绝不重复加载。
    // 两者都 async=false 动态注入：按插入顺序执行，钩子跑起来时 togglePublic 一定已经就位。
    if (!window.__SP_LOBBY || typeof window.__SP_LOBBY.togglePublic !== 'function') {
      var lobbyScript = document.createElement('script');
      lobbyScript.src = '/__sp/lobby.js';
      lobbyScript.async = false;
      document.head.appendChild(lobbyScript);
    }
    if (!window.__SP_ROOM_HOOK) {
      var hook = document.createElement('script');
      hook.src = '/__sp/room-hook.js';
      hook.async = false;
      document.head.appendChild(hook);
    }
    // v6.1: 首页覆盖层（同一自有前缀、同样绝不走网络）——它自己判断"首页态"、自己维护 show/hide，
    // 桥缺失 / DOM 不同都静默降级（最多是层不显示 = 上传方首页原样），这里只负责把它叫起来。
    if (!window.__SP_HOME_LAYER) {
      var home = document.createElement('script');
      home.src = '/__sp/home-layer.js';
      home.async = false;
      document.head.appendChild(home);
    }
    // v6.6: 跨服邀请码解析（shell-join.js）——原来靠 index.html 补丁从**页面 origin** 装载
    // （服务器页面会去取服务器自己的 /js/shell-join.js，不一定是我们的）；改走 /__sp/ 后永远是我们的树，
    // 且可热更。幂等标记 window.__SP_JOIN 由它自己维护。
    if (!window.__SP_JOIN) {
      var join = document.createElement('script');
      join.src = '/__sp/shell-join.js';
      join.async = false;
      document.head.appendChild(join);
    }
    // v6.7: 核心钩子（core-hooks.js）—— 把最后几条页面补丁行为搬进 extras：房间快照/战绩采集
    // （走 __SP__ 上页面自己的 store/net 实例）、返回键 __SP_BACK、昵称/干员调配的 localStorage 镜像、
    // 进房预热。缺 __SP__ 就静默不生效（它自己轮询等待）。
    if (!window.__SP_CORE_HOOKS) {
      var ch = document.createElement('script');
      ch.src = '/__sp/core-hooks.js';
      ch.async = false;
      document.head.appendChild(ch);
    }
    // v6.3: room lifecycle（幽灵房清理）——上游 main.js 自己在 boot 末尾暴露 globalThis.__SP__ =
    // {store, net, data}，所以本层可以在**同一个 net 实例**上订阅 room.closed / room.state，
    // 精确复刻被删补丁的 retireRoom 触发时机（不再靠 DOM 猜）。缺 __SP__ 就静默不生效。
    if (!window.__SP_ROOM_LC) {
      var lc = document.createElement('script');
      lc.src = '/__sp/room-lifecycle.js';
      lc.async = false;
      document.head.appendChild(lc);
    }
    // v6.4: 壳侧外观（字体缩放/左右边距）——补丁 G4 的运行时替代：注入一个 <style> 写 CSS 变量，
    // 默认值下完全不注入（严格 no-op）。数据源走 __SP_DATA（读-改-写合并）+ localStorage 兜底。
    if (!window.__SP_APPEARANCE) {
      var ap = document.createElement('script');
      ap.src = '/__sp/appearance.js';
      ap.async = false;
      document.head.appendChild(ap);
    }
    // v6.11: 屏幕修补 CSS（screen-fixes.js）—— 上游屏自己裁内容的运行时修补（本局信息 INFO CHECK 左列：
    // 实测 844x390 被页脚吃掉 55.0px、1600x900@fontScale1.5 被裁 418.3px，见该文件头）。与 appearance.js
    // 同一套路：只注入一个 <style>，只是它常驻（修的是上游的屏，不是我们的设置项）。同样只从 /__sp/ 取、
    // 幂等标记 window.__SP_SCREEN_FIXES 守卫、绝不走网络；缺这个文件就退回上游原样，不额外动任何东西。
    if (!window.__SP_SCREEN_FIXES) {
      var sfx = document.createElement('script');
      sfx.src = '/__sp/screen-fixes.js';
      sfx.async = false;
      document.head.appendChild(sfx);
    }
    // v7.0: server config view (server-config.js) -- the page-side reader for the CURRENT server's
    // declarative config (announcement / matchmaking / feature flags / feature-pack references).
    // Same own prefix, never network-exposed at this layer: the shell fetches + validates + caches it
    // in Java and hands this module a snapshot through the native bridge. Absent bridge or absent
    // config both degrade to "no config" -- the page must run exactly as before without one.
    // Loaded BEFORE notice-board.js (which consumes its announcement) and before skin-layer.js
    // (which must stay the last UI layer; the art prefetch stays the very last loader entry).
    if (!window.__SP_SERVER_CONFIG || !window.__SP_SERVER_CONFIG.__spReady) {
      var sc = document.createElement('script');
      sc.src = '/__sp/server-config.js';
      sc.async = false;
      document.head.appendChild(sc);
    }
    // v6.8: 公告板（notice-board.js）—— 内容热更叠加层：读 `/__sp/notices.json`（本地前缀，绝不走网络）
    // 或外壳内联的 window.__SP_NOTICE。守卫**必须查 API 形态**：__SP_NOTICE 也可能是外壳/内容塞进来的
    // **数据**对象（内联公告），只看「存不存在」会把数据当成已加载，本层永远不装载。
    if (!window.__SP_NOTICE || typeof window.__SP_NOTICE.open !== 'function') {
      var nb = document.createElement('script');
      nb.src = '/__sp/notice-board.js';
      nb.async = false;
      document.head.appendChild(nb);
    }
    // v6.2: local-skin mechanism layer (same own prefix, never network). It wraps window.fetch once and
    // rewrites only the /data/assets.json response body to the skin URLs; without a catalog or a player
    // selection it is a pass-through no-op. Loaded last: the hook must be in place before the game's
    // lazy manifest fetch (js/data.js readJson / js/assets.js ready). No page module is touched.
    if (!window.__SP_SKIN) {
      var skin = document.createElement('script');
      skin.src = '/__sp/skin-layer.js';
      skin.async = false;
      document.head.appendChild(skin);
    }
    // v6.9: art prefetch (art-prefetch.js) -- same own prefix, never network-exposed. When the APK
    // ships no embedded assets, this walks /data/assets.json in the background and warms the
    // filesDir/art/cache (the Java interceptor re-fetches missing /assets/** from the CDN same-origin).
    // It exposes window.__SP_ART {state,done,total,failed,start(),cancel(),onProgress()} and draws a
    // minimal corner chip with a skip button; missing fetch / offline degrades silently (no art =
    // game still runs). Guard on __SP_ART (set by the module itself) keeps it single-load.
    if (!window.__SP_ART) {
      var art = document.createElement('script');
      art.src = '/__sp/art-prefetch.js';
      art.async = false;
      document.head.appendChild(art);
    }
    // v7.1: preload center (preload-center.js) -- browser disk-cache preload for whatever origin
    // the page is on (Paper-Yuan port, owner direction 2026-10-08: a server-origin page must match
    // the server's UI/gameplay and stay fast through the browser cache). Same own prefix, never
    // network-exposed. It reads /data/assets.json, splits it into a ~35 MB core profile and a full
    // profile, and warms them into CacheStorage (fallback: force-cache fetch), reusing
    // art-prefetch.js's concurrency/backoff/stand-down policy and delegating `full` to __SP_ART
    // when present. Default: background `core` only, after an idle callback, never blocking the
    // page. Exposes window.__SP_PRELOAD {state,start,pause,resume,clear,verify,open,...}; a missing
    // manifest / offline / no CacheStorage all degrade silently. Guard keeps it single-load.
    if (!window.__SP_PRELOAD) {
      var pc = document.createElement('script');
      pc.src = '/__sp/preload-center.js';
      pc.async = false;
      document.head.appendChild(pc);
    }
  } catch (e) { /* no document (tests) */ }
})();
