// shell-bridge.js — platform adapter for the shell features the patched client calls:
// title-screen server switch (点击「已连接服务器」), the host/room panel and the
// latency click-through path popup. On the APK the native JS interface ("shell",
// added by MainActivity) takes over each action; on the plain web version this file
// provides self-contained fallbacks (server-switch overlay that navigates, host
// actions disabled with a hint, path info inferred from the page origin).
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

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
        var q = location.search || '';
        location.href = s.url.replace(/\/+$/, '') + '/' + q;
        return;
      }
      if (t.getAttribute('data-manual') !== null) {
        var v = window.prompt('服务器地址（https:// 或 http://IP:3000）', '');
        if (!v) return;
        v = /^https?:\/\//.test(v) ? v : 'https://' + v;
        close();
        location.href = v.replace(/\/+$/, '') + '/' + (location.search || '');
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
    var ping = Number.isFinite(ms) ? Math.round(ms) + ' ms' : '--';
    var root = overlay('<div style="font-size:16px;color:#4ed8af;letter-spacing:1px;margin-bottom:6px">连接路径</div>'
      + '<div style="margin:4px 0"><b>' + kind + '</b></div>'
      + '<div style="opacity:.75;font-size:13px">' + detail + '</div>'
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
    showPath: openPath
  };
})();
