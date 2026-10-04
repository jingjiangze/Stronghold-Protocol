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
          return desc.set.call(this, value);
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
        try { return !!NATIVE.localServiceReady(); } catch (e) { /* fall through */ }
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
})();
