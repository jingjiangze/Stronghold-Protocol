// home-layer.js -- title-screen home overlay, v7 "Arknights official site" relayout.
// HOT-UPDATE: shell-bridge.js (v6.1 block) loads it via '/__sp/home-layer.js' -- the shell's own
// prefix (serveShellAsset reads the filesDir hot tree first, then the APK; it NEVER touches the
// network).
//
// WHAT THIS LAYER IS
//   re-apk architecture: the home screen is OUR local overlay drawn on top of the upstream title
//   screen; every other screen follows the upstream. So this layer:
//   - never imports page modules (page scripts belong to the upstream) -- DOM/CSS + bridges only;
//   - must be hot-updatable -- only fetched from the shell-owned '/__sp/' prefix (see above);
//   - v7 layout follows the Arknights official-site language: dark base (#0c0f0e family), large
//     slanted/cut-corner panels, mint accents (#4ed8af family), bold display type. Fonts: reuses the
//     page's own --font-display / --font-num variables (no font is embedded or linked here); falls
//     back to the system stack. The layer root carries its own rem baseline (same clamp formula as
//     the page theme), so the layout survives even on pages without our theme CSS.
//
// DATA SOURCES (all existing bridges/functions; this layer performs ZERO network requests):
//   - server list + line latencies: window.shell.getServerList() (signed list, probed by the shell),
//     refreshed via the shell push: window.__SP_SHELL.onServers() -> 'sp-servers' DOM event.
//     Plain-web fallback: window.__SP_SHELL.getServers() static labels (no measurements).
//   - current transport scheme: window.shell.getTransport() (get+set pair required, mirroring
//     shellPanels.js readTransport). Display-only here; editing opens the params panel.
//   - visitors: window.__SP_LOBBY.visitorsCached() / fetchVisitors() (lobby owns cache + request).
//   - check update: window.__SP_SHELL.checkUpdate() (shell-bridge.js).
//   - local service state machine: window.__SP_SHELL.startLocalService/localServiceReady with the
//     window.shell native fallbacks (unchanged from v6).
//
// STATE MACHINE (unchanged from v6; window.__SP_HOME API signatures untouched):
//   window.__SP_HOME = { show(), hide(), visible(), suppress(), sweep() }
//   - shown/hidden is OUR intent, the single source of truth; every "enter game" action hides the
//     layer BEFORE touching a bridge. Java back key / other shell modules call show()/hide() too.
//   - "home present" = an upstream title-screen mark exists (TITLE_MARKS, one querySelector). The
//     layer really shows only when (intent=show && home present && not suppressed); when shown it
//     covers the upstream home and eats pointer events. Leaving the home state (title screen
//     unmounted, e.g. autostart entering a match) retracts the layer instantly; coming back covers
//     again. Detection failure = layer not shown = status quo (deliberately "rather cover less").
//   - Fallback probe: hidden but home state reappears (page reload, switch landing home, Java did
//     not tell us) -> show(). The data-sp-home-suppress mark (html or body) switches that off and
//     makes the layer yield immediately -- it is the user's "I want to see the upstream home".
//
// LAYERING (z-index): inside .app-root the layer takes 70 -- above --z-screen(1), below
// --z-modal(80), so the page's own panels (shell panels / settings, all .modal) still open ABOVE
// the layer; that is what keeps lobby/params/config/records usable. Without .app-root it mounts on
// body with a huge z-index (panel bridges are usually missing there too, so no conflict).
//
// IDEMPOTENCE / DEFENSE: window.__SP_HOME_LAYER guard (first injection wins); MutationObserver
// callbacks merged (60ms window, like room-hook); every DOM write is compare-before-write (no
// self-excitation); bridge reads are throttled (they are synchronous JNI); any DOM/bridge failure
// degrades silently -- worst case is "layer not shown", the status quo. ES5 only (floor Chromium
// 80): no optional chaining, no nullish coalescing, no arrow functions, no page module paths.
// This source file is ASCII-only; user-facing Chinese strings are \uXXXX escapes (same rule as
// skin-layer.js) so the hot-update pipeline never worries about encodings.
(function () {
  'use strict';
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (window.__SP_HOME_LAYER) return;                  // idempotence: repeated injection is a no-op
  window.__SP_HOME_LAYER = 1;

  var LAYER_ID = 'sp-home-layer';
  var STYLE_ID = LAYER_ID + '-style';
  var LAYER_VERSION = 'v7.1';
  var SUPPRESS_ATTR = 'data-sp-home-suppress';
  var SWEEP_MS = 60;                                   // observer merge window: one DOM storm, one scan
  var POLL_MS = 500;                                   // local-service readiness poll (as before)
  var POLL_MAX_MS = 120000;                            // poll ceiling: timeout returns to not-ready
  var READY_CACHE_MS = 400;                            // readiness throttle: the bridge is sync JNI
  var LINES_CACHE_MS = 400;                            // getServerList is sync JNI: throttle re-reads
  var TRANSPORT_CACHE_MS = 1000;                       // getTransport ditto
  var VISITORS_FETCH_MS = 60000;                       // fetchVisitors kick cadence (lobby owns the TTL)
  var GRID_MAX = 12;                                   // safety cap for the switch grid
  var BOARD_MAX = 8;                                   // safety cap for the latency board
  var Z_APP = 70;                                      // layer root inside .app-root: > --z-screen(1), < --z-modal(80).
                                                       // This single literal is deliberate (v7.1 item 7): the layer
                                                       // root sits between the page's --z-conn(60) and --z-modal(80);
                                                       // every other z-index in this layer goes through a --z-* var.
  // Layer root when there is no .app-root: take the page's own top layer var, with a huge fallback that
  // still sits below shell-bridge popups (2147483000). Token form keeps the source free of bare numbers.
  var Z_BODY = 'var(--z-rotate,2147482000)';
  var TITLE_MARKS = ['.title-screen', '.title-main', '.title-cn', '.title-login'];
  // Transport tiers (mirrors shellPanels.js TRANSPORT): "auto" degrades lan -> zt -> v6 -> dc.
  var TRANSPORT = [['auto', '\u81ea\u52a8'], ['lan', '\u4f18\u5148\u5c40\u57df\u7f51'], ['zt', '\u4f18\u5148\u865a\u62df\u7f51'], ['v6', '\u4f18\u5148 IPv6'], ['dc', '\u4f18\u5148\u6253\u6d1e']];
  // Capability classes (v7.1 item 4): the layer root carries sp-coarse / sp-short / sp-tall / sp-narrow
  // and every list is watched for "change", so a capability switch (mouse <-> touch, rotation) applies
  // with no reload. Layout breakpoints stay media-query based (they need height/aspect, which a class
  // cannot express); capability-driven styling (hit areas, foot insets) keys off these classes instead.
  var FEATS = [
    ['sp-coarse', '(pointer:coarse)'],
    ['sp-short', '(max-height:600px)'],
    ['sp-narrow', '(max-width:960px)']
  ];
  // Height breakpoints (v7.1 item 2). Two tiers, both keyed on HEIGHT: a phone in landscape is short
  // but can be very wide, so a width rule alone misses it. 600px = short landscape touch (also raises
  // the most-used controls to 44px); 460px = very short landscape (hard compression).
  var MQ_SHORT_TOUCH = '(max-height:600px) and (pointer:coarse)';
  var MQ_VERY_SHORT = '(max-height:460px)';
  // Minimum hit-target size on coarse pointers (v7.1 item 1). The ::after block is invisible and
  // absolutely positioned, so the painted control keeps its size; only the tappable area grows.
  var TAP_MIN = 44;
  // Board / grid / visitors failure labels (v7.1 item 5). A failure must never be a silent blank.
  var STATE_FAIL = {
    board: '\u7ebf\u8def\u52a0\u8f7d\u5931\u8d25',
    grid: '\u670d\u52a1\u5668\u5217\u8868\u52a0\u8f7d\u5931\u8d25',
    visitors: '\u8bbf\u5ba2\u6570\u83b7\u53d6\u5931\u8d25'
  };
  // Single connection banner tiers (v7.1 item 6): connecting / ok / reconnecting / offline.
  var CONN_TXT = {
    connecting: '\u8fde\u63a5\u4e2d\u2026',
    ok: '\u5df2\u8fde\u63a5',
    reconnecting: '\u4e2d\u65ad\u91cd\u8fde\u4e2d',
    offline: '\u65e0\u7f51\u7edc'
  };
  var CONN_DOT = { connecting: '#e0b64a', ok: '#4ed8af', reconnecting: '#e0b64a', offline: '#e06c5a' };

  // User-facing strings (kept in one place; escaped to \uXXXX at the end of the pipeline).
  var ZH = {
    home: '\u672c\u5730\u9996\u9875',
    brand: '\u536b\u620d\u534f\u8bae\uff1a\u76df\u7ea6',
    sub: '\u9996\u9875\u7531\u672c\u5730\u5916\u58f3\u627f\u62c5\uff1b\u5176\u4f59\u754c\u9762\u4e0e\u73a9\u6cd5\u8ddf\u968f\u5f53\u524d\u670d\u52a1\u5668\u3002',
    local: '\u672c\u5730\u670d\u52a1', starting: '\u542f\u52a8\u4e2d\u2026', enter: '\u8fdb\u5165',
    online: '\u8fdb\u5165\u7ebf\u4e0a', lobby: '\u5927\u5385', params: '\u53c2\u6570', config: '\u914d\u7f6e', records: '\u6218\u7ee9',
    update: '\u68c0\u67e5\u66f4\u65b0',
    notice: '\u516c\u544a',
    whyLocal: '\u672c\u5730\u670d\u52a1\u9700\u8981 App \u7248\uff08\u7f3a\u5c11\u672c\u5730\u670d\u52a1\u6865\uff09',
    whyOnline: '\u8fdb\u5165\u7ebf\u4e0a\u9700\u8981 App \u7248\uff08\u7f3a\u5c11\u5207\u670d / \u81ea\u52a8\u8fdb\u5165\u6865\uff09',
    whyPanel: '\u9762\u677f\u672a\u52a0\u8f7d\uff08\u7f3a\u5c11 openPanel \u6865\uff09',
    whyUpdate: '\u68c0\u67e5\u66f4\u65b0\u9700\u8981 App \u7248\uff08\u7f3a\u5c11\u5347\u7ea7\u6865\uff09',
    whyNotice: '\u6682\u65e0\u516c\u544a',
    startFail: '\u672c\u5730\u670d\u52a1\u542f\u52a8\u5931\u8d25\uff08\u7f3a\u5c11\u542f\u52a8\u6865\uff09',
    startTimeout: '\u672c\u5730\u670d\u52a1\u542f\u52a8\u8d85\u65f6\uff0c\u53ef\u91cd\u8bd5',
    unusable: '\u4e0d\u53ef\u7528\uff1a', sep: '\uff1b',
    autoLine: '\u81ea\u52a8\u7ebf\u8def', localSrv: '\u672c\u673a\u670d\u52a1', customLine: '\u81ea\u5b9a\u4e49\u7ebf\u8def',
    ok: '\u53ef\u7528', off: '\u5df2\u505c\u7528',
    good: '\u5ef6\u8fdf\u826f\u597d', mid: '\u5ef6\u8fdf\u4e00\u822c', bad: '\u5ef6\u8fdf\u8f83\u5dee',
    unknown: '\u5ef6\u8fdf\u672a\u77e5', unreachable: '\u65e0\u6cd5\u8fde\u63a5',
    visitors: '\u8bbf\u5ba2',
    transport: '\u4f20\u8f93\u65b9\u6848',
    needApk: '\u9700\u66f4\u65b0 APK \u540e\u751f\u6548',
    editParams: '\u6253\u5f00\u53c2\u6570\u9762\u677f',
    noLines: '\u6682\u65e0\u7ebf\u8def\u6570\u636e', loading: '\u6e05\u5355\u52a0\u8f7d\u4e2d\u2026',
    fail: '\u5931\u8d25', retry: '\u91cd\u8bd5',
    noteLocal: '\u5355\u673a\u5f00\u623f', noteAuto: '\u5ef6\u8fdf\u6700\u4f18'
  };

  var shown = true;            // our intent; single source of truth. Default: cover the home.
  var root = null;             // overlay node
  var inAppRoot = null;        // root lives in .app-root? (null = never mounted; decides z semantics)
  var btns = {};               // act -> nav button
  var why = {};                // act -> disabled reason (title / hint line)
  var hintEl = null;
  var localStarting = false;   // local service starting (polling)
  var localSince = 0;
  var localNote = '';          // transient local-service note (timeout / failed to start)
  var pollTimer = 0;
  var queued = 0;              // merged observer window: one scan per storm
  var armed = false;
  var readyCache = null;       // readiness cache (null = never asked)
  var readyAt = 0;
  // v7 nodes / caches
  var srvEl = null;            // hero current-server big text
  var capEl = null;            // latency capsule
  var capDotEl = null;
  var capTxtEl = null;
  var visitorsEl = null;       // visitors capsule
  var visRetryBtn = null;      // visitors "retry" button (sibling of the capsule; shown only on failure)
  var visitorsState = 'empty'; // 'loading' | 'ok' | 'empty' | 'failed' (item 5)
  var gridEl = null;           // server switch grid
  var gridStateEl = null;      // server-list state line (item 5)
  var boardEl = null;          // line latency board
  var connEl = null;           // the ONE connection banner (item 6)
  var connTxtEl = null;
  var connDotEl = null;
  var connSig = '';
  var segWrap = null;          // transport segmented display
  var segBtns = [];
  var trHintEl = null;         // "needs newer APK" hint
  var editBtn = null;          // "open params panel"
  var verEl = null;            // bottom-right version
  var gridSig = '';
  var boardSig = '';
  var transportSig = '';
  var linesCache = null;
  var linesAt = 0;
  var transportCache = null;
  var transportAt = 0;
  var visitorsAt = 0;
  var kidReg = [];             // appended children registry -> stub-safe clearing (no firstChild)
  var featOn = { 'sp-coarse': false, 'sp-short': false, 'sp-tall': false, 'sp-narrow': false };
  var featBound = false;       // matchMedia was available -> sp-tall/sp-short pair is meaningful

  /** Read one media list, tolerating engines without matchMedia (then the classes simply stay off and
   *  the CSS media queries still do the layout work). */
  function mqlOf(q) {
    try {
      if (typeof window.matchMedia === 'function') return window.matchMedia(q);
    } catch (e) { /* no matchMedia: classes unavailable */ }
    return null;
  }

  /** Attach the capability classes to the layer root (item 4). Class-driven so a capability change
   *  takes effect on the spot; compare-before-write to avoid observer self-excitation. */
  function applyFeatures() {
    if (!root) return;
    var cls = 'sp-home';
    for (var i = 0; i < FEATS.length; i++) {
      var n = FEATS[i][0];
      if (featOn[n]) cls += ' ' + n;
    }
    if (featBound && featOn['sp-tall']) cls += ' sp-tall';
    try { if (root.className !== cls) root.className = cls; } catch (e) { /* silent */ }
  }

  /** Bind every capability list once and keep them live through "change" (both the modern
   *  addEventListener form and the legacy addListener form). */
  function bindFeatures() {
    for (var i = 0; i < FEATS.length; i++) {
      (function (name, q) {
        var m = mqlOf(q);
        if (!m) return;
        featBound = true;
        featOn[name] = !!m.matches;
        var onChange = function () {
          featOn[name] = !!m.matches;
          if (name === 'sp-short') featOn['sp-tall'] = !featOn['sp-short'];
          applyFeatures();
        };
        try {
          if (typeof m.addEventListener === 'function') m.addEventListener('change', onChange);
          else if (typeof m.addListener === 'function') m.addListener(onChange);
        } catch (e) { /* listener registration failed: the initial value still applies */ }
      })(FEATS[i][0], FEATS[i][1]);
    }
    if (featBound) featOn['sp-tall'] = !featOn['sp-short'];
    applyFeatures();
  }

  function nowMs() { return new Date().getTime(); }

  function docEl() { return document.documentElement || null; }

  function bodyEl() { return document.body || null; }

  /** The user/Java said "I want to see the upstream home": the mark on html OR body wins. */
  function suppressed() {
    try {
      var d = docEl();
      var b = bodyEl();
      if (d && d.hasAttribute && d.hasAttribute(SUPPRESS_ATTR)) return true;
      if (b && b.hasAttribute && b.hasAttribute(SUPPRESS_ATTR)) return true;
    } catch (e) { /* unreadable mark: treat as not suppressed (rather cover) */ }
    return false;
  }

  /** Home state? One level of querySelector marks, first hit wins (no heuristics). */
  function homePresent() {
    if (typeof document.querySelector !== 'function') return false;
    for (var i = 0; i < TITLE_MARKS.length; i++) {
      var el = null;
      try { el = document.querySelector(TITLE_MARKS[i]); } catch (e) { el = null; }
      if (el) return true;
    }
    return false;
  }

  /** Should the layer really show right now: intent + home state + not suppressed. */
  function wanted() { return shown && !suppressed() && homePresent(); }

  /** Local service readiness: shell wrapper first (normalizes Java's "0"/"1"), then native.
   *  Java returns strings -- "0" must never count as ready (v4.2 lesson: !!v is always true). */
  function readReady() {
    try {
      var api = window.__SP_SHELL;
      if (api && typeof api.localServiceReady === 'function') return api.localServiceReady() === true;
    } catch (e) { /* fall to native bridge */ }
    try {
      var sh = window.shell;
      if (sh && typeof sh.localServiceReady === 'function') {
        var v = sh.localServiceReady();
        return v === true || String(v) === '1';
      }
    } catch (e) { /* no bridge = not ready */ }
    return false;
  }

  /** Throttled readiness read (paint runs on every scan; the poll uses readReady for fresh values). */
  function ready() {
    var t = nowMs();
    if (readyCache !== null && (t - readyAt) < READY_CACHE_MS) return readyCache;
    readyAt = t;
    readyCache = readReady();
    return readyCache;
  }

  /** Start the local service: __SP_SHELL wrapper first, then native startLocalService, finally
   *  setServer('local') (old-shell semantics). */
  function startLocalService() {
    try {
      var api = window.__SP_SHELL;
      if (api && typeof api.startLocalService === 'function') return api.startLocalService() !== false;
    } catch (e) { /* try native */ }
    try {
      var sh = window.shell;
      if (sh && typeof sh.startLocalService === 'function') { sh.startLocalService(); return true; }
      if (sh && typeof sh.setServer === 'function') { sh.setServer('local'); return true; }
    } catch (e) { /* bridge broken: reported as unavailable below */ }
    return false;
  }

  function canLocal() {
    try {
      var api = window.__SP_SHELL;
      if (api && typeof api.startLocalService === 'function') return true;
      var sh = window.shell;
      if (sh && (typeof sh.startLocalService === 'function' || typeof sh.setServer === 'function')) return true;
    } catch (e) { /* unavailable */ }
    return false;
  }

  /** Arm autostart: switching lines / starting the service reloads the page; after the reload the
   *  upstream title page consumes the autostart and start()s once (the existing enter path). */
  function armAutostart() {
    try {
      if (window.shell && typeof window.shell.setAutostart === 'function') window.shell.setAutostart();
    } catch (e) { /* old shell: landing back on the covered home, the user taps again */ }
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

  /** v7: "check update" is available whenever the bridge exists (the bridge itself owns the
   *  web fallback: a cache-busting reload). */
  function canUpdate() {
    try { return !!(window.__SP_SHELL && typeof window.__SP_SHELL.checkUpdate === 'function'); } catch (e) { return false; }
  }

  /** v7.2: the bulletin board is a separate overlay (notice-board.js). It is "there" only once its
   *  API object is installed — the same global may also carry inline DATA, which is not an API.
   *  Enabled only when the board actually has notices; the dot marks the unread ones. */
  function noticeApi() {
    try {
      var n = window.__SP_NOTICE;
      return (n && typeof n.open === 'function') ? n : null;
    } catch (e) { return null; }
  }

  function canNotice() {
    var n = noticeApi();
    if (!n) return false;
    try { return typeof n.hasData === 'function' ? !!n.hasData() : true; } catch (e) { return false; }
  }

  function noticeUnread() {
    var n = noticeApi();
    try { return !!(n && typeof n.unread === 'function' && n.unread()); } catch (e) { return false; }
  }

  // ---- v7 data readers (bridges only; zero network from this layer) -----------------------------

  /** Server list for the hero / grid / board. App: signed list from the shell (probed there);
   *  web: static labels from __SP_SHELL.getServers() (no measurements). Never throws. */
  function readLinesRaw() {
    var out = { loading: false, entries: [], curLocal: false, curAuto: false, native: false, failed: false };
    try {
      var sh = window.shell;
      if (sh && typeof sh.getServerList === 'function') {
        out.native = true;
        var o = JSON.parse(sh.getServerList() || '{}');
        out.loading = !!(o && o.loading);
        var es = (o && Array.isArray(o.entries)) ? o.entries : [];
        for (var i = 0; i < es.length; i++) {
          var e = es[i];
          if (!e || !e.id) continue;
          if (String(e.id) === 'local') { out.curLocal = !!e.current; continue; }
          if (String(e.id) === 'auto') { out.curAuto = !!e.current; continue; }
          if (e.roomScoped) continue;                      // room-hosted servers stay hidden (as upstream)
          out.entries.push({
            id: String(e.id), name: String(e.name || e.id), note: String(e.note || ''),
            app: String(e.app || ''), rttMs: Number(e.rttMs), enabled: e.enabled !== false,
            current: !!e.current, reachable: e.reachable
          });
        }
        // current flags from the plain server table too (it knows "local"/"auto" state)
        try {
          if (typeof sh.getServers === 'function') {
            var arr = JSON.parse(sh.getServers() || '[]');
            for (var k = 0; k < arr.length; k++) {
              if (arr[k] && arr[k].id === 'local' && arr[k].current) out.curLocal = true;
              if (arr[k] && arr[k].id === 'auto' && arr[k].current) out.curAuto = true;
            }
          }
        } catch (e) { /* keep flags from the list */ }
        return out;
      }
    } catch (e) { out.entries = []; out.failed = true; }   // list read blew up: report, never a blank
    // plain web fallback: static lines (labels only)
    try {
      var api = window.__SP_SHELL;
      var r = (api && typeof api.getServers === 'function') ? api.getServers() : null;
      var list = (typeof r === 'string') ? JSON.parse(r) : r;
      if (Array.isArray(list)) {
        out.failed = false;
        for (var j = 0; j < list.length; j++) {
          var s = list[j];
          if (!s || s.id === 'local' || s.id === 'auto') continue;
          out.entries.push({
            id: String(s.id || ('line' + j)), name: String(s.label || ZH.customLine), note: '',
            app: '', rttMs: -1, enabled: true, current: !!s.current, reachable: undefined
          });
        }
      }
    } catch (e) { out.entries = []; out.failed = true; }
    out.curAuto = true;                                    // on the web the current page IS the auto line
    return out;
  }

  function getLines() {
    var t = nowMs();
    if (linesCache && (t - linesAt) < LINES_CACHE_MS) return linesCache;
    linesAt = t;
    linesCache = readLinesRaw();
    return linesCache;
  }

  /** Transport scheme: get+set must exist as a pair (shellPanels.js readTransport semantics);
   *  old APKs -> { supported:false, value:'auto' }. Never throws. */
  function readTransport() {
    try {
      var sh = window.shell;
      if (sh && typeof sh.getTransport === 'function' && typeof sh.setTransport === 'function') {
        var v = sh.getTransport();
        if (typeof v === 'string' && v) return { supported: true, value: v };
      }
    } catch (e) { /* old shell / broken bridge: treat as unsupported */ }
    return { supported: false, value: 'auto' };
  }

  function getTransport() {
    var t = nowMs();
    if (transportCache && (t - transportAt) < TRANSPORT_CACHE_MS) return transportCache;
    transportAt = t;
    transportCache = readTransport();
    return transportCache;
  }

  function visitorsNow() {
    try {
      var api = window.__SP_LOBBY;
      if (api && typeof api.visitorsCached === 'function') {
        var n = api.visitorsCached();
        if (typeof n === 'number' && isFinite(n)) return n;
      }
    } catch (e) { /* no lobby module: show -- */ }
    return null;
  }

  /** Kick the lobby visitor loader (it owns cache + TTL + request). Throttled here so a DOM storm
   *  cannot spam it; the promise only triggers a repaint. force = the user pressed "retry" (item 5). */
  function pullVisitors(force) {
    var t = nowMs();
    if (!force && visitorsAt && (t - visitorsAt) < VISITORS_FETCH_MS) return;
    visitorsAt = t;
    try {
      var api = window.__SP_LOBBY;
      if (api && typeof api.fetchVisitors === 'function') {
        if (visitorsNow() === null) { visitorsState = 'loading'; paintVisitors(); }
        var p = api.fetchVisitors(!!force);
        if (p && typeof p.then === 'function') {
          p.then(function () {
            visitorsState = (visitorsNow() === null) ? 'empty' : 'ok';
            paintVisitors();
          }, function () {
            visitorsState = 'failed';                  // never a silent blank: the capsule says so
            paintVisitors();
          });
        }
      }
    } catch (e) { /* silent */ }
  }

  /** Offline probe (item 6): a property read, never a request. */
  function netOffline() {
    try {
      var n = window.navigator;
      if (n && typeof n.onLine === 'boolean') return !n.onLine;
    } catch (e) { /* no navigator: unknown = treat as online */ }
    return false;
  }

  function hasBridge() {
    try { return !!(window.shell || window.__SP_SHELL); } catch (e) { return false; }
  }

  /** The single connection tier (item 6): offline > connecting > reconnecting > ok. */
  function connStateOf(L) {
    if (netOffline()) return 'offline';
    if (!hasBridge()) return 'connecting';
    if (localStarting) return 'connecting';
    if (L && L.loading) return 'connecting';
    var cur = currentLineInfo(L || { entries: [] });
    if (cur && (cur.enabled === false || cur.reachable === false)) return 'reconnecting';
    return 'ok';
  }

  /** Retry action for the three-state areas (item 5). Lines: drop the cache and re-ask the shell.
   *  Visitors: drop the throttle and force the lobby loader. */
  function onRetry(kind, ev) {
    try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* silent */ }
    if (kind === 'board' || kind === 'grid' || kind === 'lines') {
      linesCache = null;
      linesAt = 0;
      try {
        var sh = window.shell;
        if (sh && typeof sh.refreshServerList === 'function') sh.refreshServerList();
      } catch (e) { /* no bridge: the next scan just re-reads the static list */ }
      paint();
      return true;
    }
    if (kind === 'visitors') {
      visitorsAt = 0;
      visitorsState = 'loading';
      paintVisitors();
      pullVisitors(true);
      paint();
      return true;
    }
    return false;
  }

  // ---- small formatters (dot thresholds mirror lobby.js rttDot) ----------------------------------

  function rttDotOf(ms, enabled, reachable) {
    if (enabled === false) return { color: '#8a9a93', title: ZH.off };
    if (!isFinite(ms) || ms <= 0) {
      if (reachable === false) return { color: '#e06c5a', title: ZH.unreachable };
      return { color: '#8a9a93', title: ZH.unknown };
    }
    // thresholds calibrated like lobby.js v5.3: direct ~60ms, CF front 1-3s
    if (ms < 250) return { color: '#4ed8af', title: ZH.good };
    if (ms < 900) return { color: '#e0b64a', title: ZH.mid };
    return { color: '#e06c5a', title: ZH.bad };
  }

  function quickDot(row) {
    if (row && row.id === 'local') {
      return row.enabled === false ? { color: '#8a9a93', title: ZH.off } : { color: '#4ed8af', title: ZH.ok };
    }
    if (row && row.id === 'auto') return { color: '#4ed8af', title: ZH.ok };
    return rttDotOf(row ? row.rttMs : -1, row ? row.enabled : true, row ? row.reachable : undefined);
  }

  function fmtRtt(ms) { return isFinite(ms) && ms > 0 ? Math.round(ms) + 'ms' : '--'; }

  function fmtApp(app) {
    var s = String(app || '');
    if (!s) return '';
    return /^\d/.test(s) ? 'v' + s : s;
  }

  // ---- overlay DOM -------------------------------------------------------------------------------

  /** One-shot style block: only this layer's classes. Colors/fonts reuse page variables with
   *  equal-value fallbacks. Slanted panels + cut corners + mint accents (official-site language). */
  function injectStyle() {
    try {
      if (!document.head || typeof document.createElement !== 'function') return;
      if (document.getElementById && document.getElementById(STYLE_ID)) return;
      var st = document.createElement('style');
      st.setAttribute('id', STYLE_ID);
      st.textContent = [
        '#' + LAYER_ID + '[data-sp-home="off"]{display:none}',
        '#' + LAYER_ID + ' *{box-sizing:border-box}',
        '#' + LAYER_ID + ' button{font:inherit;touch-action:manipulation;-webkit-tap-highlight-color:transparent}',
        // v7.1 item 3: the frame keeps its own inset AND clears the notch / home indicator. The
        // constant() line is the iOS 11.0-11.1 spelling, the env() line the current one; a browser
        // that does not know either just drops the line and keeps the plain padding above.
        '.sp-home__frame{position:absolute;top:0;right:0;bottom:0;left:0;display:flex;gap:.3rem;padding:.34rem;overflow:hidden;',
        'padding-top:calc(.34rem + constant(safe-area-inset-top));padding-top:calc(.34rem + env(safe-area-inset-top,0px));',
        'padding-right:calc(.34rem + constant(safe-area-inset-right));padding-right:calc(.34rem + env(safe-area-inset-right,0px));',
        'padding-bottom:calc(.34rem + constant(safe-area-inset-bottom));padding-bottom:calc(.34rem + env(safe-area-inset-bottom,0px));',
        'padding-left:calc(.34rem + constant(safe-area-inset-left));padding-left:calc(.34rem + env(safe-area-inset-left,0px))}',
        '.sp-home__deco{position:absolute;top:-12%;right:-5%;width:36%;height:124%;transform:skewX(-14deg);',
        'background:linear-gradient(90deg,rgba(78,216,175,.06),rgba(78,216,175,.01));pointer-events:none}',
        '.sp-home__deco--b{top:auto;bottom:-14%;right:auto;left:20%;width:14%;background:rgba(78,216,175,.05)}',
        '.sp-home__nav{position:relative;display:flex;flex-direction:column;width:2.35rem;min-width:2.35rem}',
        '.sp-home__brand{padding:.1rem .06rem .18rem 0}',
        '.sp-home__micro{font-family:var(--font-display,inherit);font-size:.13rem;letter-spacing:.3em;',
        'color:var(--mint-700,#2a9e7f);text-transform:uppercase}',
        '.sp-home__title{margin:.08rem 0 0;font-family:var(--font-display,inherit);font-weight:700;font-size:.42rem;',
        'letter-spacing:.12em;line-height:1.1;color:var(--text-hi,#f2f2f2)}',
        '.sp-home__sub{margin:.1rem 0 0;font-size:.13rem;line-height:1.5;color:var(--text-lo,#8a948f)}',
        '.sp-home__navbtns{display:flex;flex-direction:column;gap:.04rem;margin-top:.12rem}',
        '.sp-home__navbtn{display:flex;align-items:center;width:100%;min-height:max(.42rem,40px);padding:.06rem .16rem;',
        'background:transparent;border:0;border-left:.03rem solid rgba(78,216,175,.25);color:var(--text-md,#c7cfc9);',
        'font-size:.17rem;letter-spacing:.22em;text-align:left;cursor:pointer}',
        '.sp-home__navbtn:enabled:hover{border-left-color:var(--mint-400,#4ed8af);color:var(--text-hi,#f2f2f2);',
        'background:linear-gradient(90deg,rgba(78,216,175,.1),rgba(78,216,175,0))}',
        '.sp-home__navbtn:disabled{opacity:.38;cursor:default}',
        // v7.2: unread marker on the bulletin-board entry. ::before (not ::after) because the coarse
        // pointer hit area below owns ::after; order:2 pushes the dot past the label inside the flex row.
        '.sp-home__navbtn[data-sp-unread="1"]::before{content:"";order:2;margin-left:auto;',
        'width:.09rem;height:.09rem;min-width:8px;min-height:8px;border-radius:50%;background:var(--red,#e73118)}',
        '.sp-home__navfoot{margin-top:auto;padding-top:.2rem;font-size:.12rem;letter-spacing:.3em;',
        'color:var(--text-lo,#8a948f);opacity:.7}',
        '.sp-home__main{position:relative;flex:1 1 0;min-width:0;display:flex;gap:.3rem}',
        '.sp-home__panel{position:relative;border:1px solid var(--line-2,#3e4b45);min-width:0;padding:.28rem .3rem;',
        'background:linear-gradient(160deg,rgba(22,27,25,.96),rgba(10,13,12,.96));box-shadow:0 .12rem .4rem rgba(0,0,0,.45)}',
        '.sp-home__panel--hero{flex:1.5 1 0;clip-path:polygon(0 0,100% 0,100% calc(100% - .26rem),calc(100% - .26rem) 100%,0 100%)}',
        '.sp-home__panel--side{flex:1 1 0;clip-path:polygon(0 0,100% 0,100% 100%,.26rem 100%,0 calc(100% - .26rem))}',
        '.sp-home__srv{margin:.06rem 0 .12rem;font-family:var(--font-display,inherit);font-weight:700;font-size:.44rem;',
        'letter-spacing:.1em;color:var(--text-hi,#f2f2f2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.sp-home__meta{display:flex;flex-wrap:wrap;gap:.1rem;align-items:center;margin:0 0 .18rem}',
        '.sp-home__capsule{display:inline-flex;align-items:center;gap:.08rem;min-height:max(.28rem,28px);',
        'padding:.03rem .14rem;border:1px solid var(--line-2,#3e4b45);background:rgba(255,255,255,.03);',
        'font-size:.14rem;color:var(--text-md,#c7cfc9)}',
        '.sp-home__dot{width:.11rem;height:.11rem;border-radius:50%;flex:0 0 auto}',
        '.sp-home__microrow{margin:0 0 .08rem}',
        '.sp-home__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.1rem}',
        '.sp-home__cell{min-width:0}',
        '.sp-home__cellbtn{display:flex;align-items:center;gap:.1rem;width:100%;min-height:max(.4rem,40px);',
        'padding:.05rem .12rem;background:rgba(255,255,255,.03);border:1px solid var(--line-2,#3e4b45);',
        'color:var(--text-md,#c7cfc9);font-size:.15rem;text-align:left;cursor:pointer}',
        '.sp-home__cellbtn:enabled:hover{border-color:var(--mint-400,#4ed8af);color:var(--text-hi,#f2f2f2)}',
        '.sp-home__cellbtn:disabled{opacity:.4;cursor:default}',
        '.sp-home__cell--cur .sp-home__cellbtn{border-color:var(--mint-400,#4ed8af);color:var(--text-hi,#f2f2f2);',
        'background:rgba(78,216,175,.08)}',
        '.sp-home__cell--off .sp-home__cellbtn{opacity:.4}',
        '.sp-home__cellname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.sp-home__seg{display:flex;flex-wrap:wrap;gap:.06rem;margin:0 0 .08rem}',
        '.sp-home__segbtn{min-height:max(.36rem,36px);padding:.03rem .12rem;background:transparent;',
        'border:1px solid var(--line-2,#3e4b45);color:var(--text-lo,#8a948f);font-size:.13rem;letter-spacing:.08em;cursor:default}',
        '.sp-home__segbtn[aria-checked="true"]{border-color:var(--mint-400,#4ed8af);color:var(--mint-400,#4ed8af);',
        'background:rgba(78,216,175,.08)}',
        '.sp-home__hint2{margin:.06rem 0 0;font-size:.13rem;color:#e0b64a;opacity:.9}',
        '.sp-home__editbtn{margin-top:.1rem;min-height:max(.4rem,40px);padding:.04rem .16rem;background:transparent;',
        'border:1px solid var(--mint-700,#2a9e7f);color:var(--mint-400,#4ed8af);font-size:.14rem;letter-spacing:.14em;cursor:pointer}',
        '.sp-home__editbtn:disabled{opacity:.4;cursor:default}',
        '.sp-home__board{margin-top:.06rem}',
        '.sp-home__line{display:flex;align-items:center;gap:.12rem;min-height:max(.36rem,36px);',
        'border-bottom:1px solid rgba(62,75,69,.45);font-size:.15rem;color:var(--text-md,#c7cfc9)}',
        '.sp-home__line--off{opacity:.45}',
        '.sp-home__lineempty{padding:.1rem 0;font-size:.13rem;color:var(--text-lo,#8a948f)}',
        '.sp-home__linett{flex:0 0 auto;font-size:.12rem;letter-spacing:.06em;color:var(--text-lo,#8a948f)}',
        // v7.1 item 6: the bottom bar holds the ONE connection banner (left) and the version + hint
        // (right). v7.1 item 3: its own inset also clears the home indicator / rounded corner.
        '.sp-home__foot{position:absolute;left:.34rem;right:.34rem;bottom:.24rem;display:flex;',
        'align-items:flex-end;justify-content:space-between;gap:.2rem;pointer-events:none;',
        'bottom:calc(.24rem + constant(safe-area-inset-bottom));bottom:calc(.24rem + env(safe-area-inset-bottom,0px));',
        'right:calc(.34rem + constant(safe-area-inset-right));right:calc(.34rem + env(safe-area-inset-right,0px))}',
        '.sp-home__footcol{display:flex;flex-direction:column;align-items:flex-end;gap:.02rem;min-width:0}',
        // the connection banner; its stacking value comes from the page's own --z-* var (v7.1 item 7)
        '.sp-home__conn{display:inline-flex;align-items:center;gap:.1rem;min-height:max(.3rem,30px);padding:.04rem .16rem;',
        'border:1px solid var(--line-2,#3e4b45);background:rgba(12,15,14,.92);z-index:var(--z-conn,60);',
        'font-size:.14rem;color:var(--text-md,#c7cfc9)}',
        '.sp-home__conn--connecting,.sp-home__conn--reconnecting{border-color:rgba(224,182,74,.55);color:#e0b64a}',
        '.sp-home__conn--ok{border-color:rgba(78,216,175,.5)}',
        '.sp-home__conn--offline{border-color:rgba(224,108,90,.6);color:#e06c5a}',
        '.sp-home__ver{font-family:var(--font-display,inherit);font-size:.13rem;letter-spacing:.24em;',
        'color:var(--text-lo,#8a948f)}',
        '.sp-home__hint{margin:.06rem 0 0;min-height:1em;font-size:.13rem;color:var(--text-lo,#8a948f);opacity:.9;',
        'text-align:right}',
        // v7.1 item 5: loading / empty / failed rows for the board and the server list, plus the
        // retry affordance. A failure paints this row; it never leaves a silent blank.
        '.sp-home__state{display:flex;align-items:center;gap:.12rem;padding:.1rem 0;font-size:.13rem;color:var(--text-lo,#8a948f)}',
        '.sp-home__state--error{color:#e06c5a}',
        '.sp-home__statetxt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.sp-home__retry{flex:0 0 auto;min-height:max(.3rem,32px);padding:.02rem .12rem;background:transparent;',
        'border:1px solid var(--mint-700,#2a9e7f);color:var(--mint-400,#4ed8af);font-size:.13rem;letter-spacing:.1em;cursor:pointer}',
        '.sp-home__retry:disabled{opacity:.4;cursor:default}',
        '.sp-home__viswrap{display:inline-flex;align-items:center;gap:.06rem}',
        // v7.1 item 1: on coarse pointers the small controls get an invisible hit area of at least
        // TAP_MIN px. The ::after block is transparent and absolutely positioned, so the painted
        // control keeps its size -- only the tappable region grows.
        '.sp-home.sp-coarse .sp-home__navbtn,.sp-home.sp-coarse .sp-home__cellbtn,.sp-home.sp-coarse .sp-home__segbtn,',
        '.sp-home.sp-coarse .sp-home__editbtn,.sp-home.sp-coarse .sp-home__retry{position:relative}',
        '.sp-home.sp-coarse .sp-home__navbtn::after,.sp-home.sp-coarse .sp-home__cellbtn::after,',
        '.sp-home.sp-coarse .sp-home__segbtn::after,.sp-home.sp-coarse .sp-home__editbtn::after,',
        '.sp-home.sp-coarse .sp-home__retry::after{content:"";position:absolute;left:50%;top:50%;',
        'width:100%;min-width:' + TAP_MIN + 'px;height:' + TAP_MIN + 'px;transform:translate(-50%,-50%)}',
        // keep the enlarged hit areas from overlapping their neighbours on coarse pointers
        '.sp-home.sp-coarse .sp-home__navbtns,.sp-home.sp-coarse .sp-home__seg,.sp-home.sp-coarse .sp-home__grid{gap:.16rem}',
        // v7.1 item 4: the narrow inset is expressed as a class rule too, so a matchMedia-only
        // capability flip repaints the foot without waiting for a media-query re-evaluation.
        '.sp-home.sp-narrow .sp-home__foot{left:.18rem;right:.18rem;bottom:.1rem}',
        // narrow / portrait degradation: nav goes horizontal on top, columns stack
        '@media (max-width:960px),(max-aspect-ratio:12/10){',
        '.sp-home__frame{flex-direction:column;gap:.16rem;padding:.18rem;overflow-y:auto}',
        '.sp-home__deco{display:none}',
        '.sp-home__nav{flex-direction:row;flex-wrap:wrap;width:auto;min-width:0;align-items:center;gap:.06rem}',
        '.sp-home__brand{flex:1 1 100%;padding:.02rem 0}',
        '.sp-home__title{font-size:.3rem}',
        '.sp-home__sub,.sp-home__navfoot{display:none}',
        '.sp-home__navbtns{flex-direction:row;flex-wrap:wrap;margin-top:0;flex:1 1 auto}',
        '.sp-home__navbtn{width:auto;min-width:max(.9rem,90px);border-left:0;border-bottom:.03rem solid rgba(78,216,175,.25);',
        'padding:.06rem .12rem}',
        '.sp-home__navbtn:enabled:hover{border-bottom-color:var(--mint-400,#4ed8af)}',
        '.sp-home__main{flex-direction:column}',
        '.sp-home__panel--hero,.sp-home__panel--side{clip-path:none}',
        '.sp-home__srv{font-size:.34rem}',
        '.sp-home__foot{left:.18rem;right:.18rem;bottom:.1rem}',
        '}',
        // v7.1 item 2, tier 1 -- SHORT LANDSCAPE TOUCH: height <= 600px AND a coarse pointer. This is
        // the "phone held sideways" band: the width can be large (so the width rule above never fires)
        // while the height is small. Tighten the vertical rhythm and raise the most-used controls to
        // the 44px tap floor.
        '@media ' + MQ_SHORT_TOUCH + '{',
        '.sp-home__frame{gap:.2rem;padding:.2rem}',
        '.sp-home__panel{padding:.2rem .22rem}',
        '.sp-home__title{font-size:.34rem}',
        '.sp-home__sub{display:none}',
        '.sp-home__srv{font-size:.36rem}',
        '.sp-home__navbtn,.sp-home__cellbtn{min-height:max(.4rem,' + TAP_MIN + 'px)}',
        '}',
        // v7.1 item 2, tier 2 -- VERY SHORT LANDSCAPE: height <= 460px, the shortest band a phone in
        // landscape (or a small tablet split view) presents. Compression is aggressive: columns stack,
        // decorative slant is dropped and secondary copy is hidden, so the controls stay reachable.
        '@media ' + MQ_VERY_SHORT + '{',
        '.sp-home__frame{flex-direction:column;gap:.12rem;padding:.14rem;overflow-y:auto}',
        '.sp-home__deco{display:none}',
        '.sp-home__nav{flex-direction:row;flex-wrap:wrap;width:auto;min-width:0;align-items:center;gap:.06rem}',
        '.sp-home__brand{flex:1 1 100%;padding:.02rem 0}',
        '.sp-home__title{font-size:.28rem}',
        '.sp-home__sub,.sp-home__navfoot{display:none}',
        '.sp-home__navbtns{flex-direction:row;flex-wrap:wrap;margin-top:0;flex:1 1 auto}',
        '.sp-home__navbtn{width:auto;min-width:max(.9rem,90px);border-left:0;border-bottom:.03rem solid rgba(78,216,175,.25);',
        'padding:.06rem .12rem}',
        '.sp-home__main{flex-direction:column}',
        '.sp-home__panel--hero,.sp-home__panel--side{clip-path:none}',
        '.sp-home__srv{font-size:.3rem}',
        '.sp-home__foot{left:.14rem;right:.14rem;bottom:.08rem}',
        '}'
      ].join('');
      document.head.appendChild(st);
    } catch (e) { /* injection failed: inline geometry on the root keeps the layer usable */ }
  }

  /** Pointer events inside the layer must not reach the page's document-level handlers. */
  function stopEvent(ev) {
    try { if (ev && ev.stopPropagation) ev.stopPropagation(); } catch (e) { /* silent */ }
  }

  /** Append + remember (stub-safe clearing without firstChild). */
  function appendKid(el, kid) {
    try { el.appendChild(kid); } catch (e) { return kid; }
    kidReg.push({ el: el, kid: kid });
    return kid;
  }

  function clearEl(el) {
    for (var i = kidReg.length - 1; i >= 0; i--) {
      if (kidReg[i].el === el) {
        try { el.removeChild(kidReg[i].kid); } catch (e) { /* already gone */ }
        kidReg.splice(i, 1);
      }
    }
  }

  function setTxt(el, s) {
    if (!el || el.textContent === s) return;
    try { el.textContent = s; } catch (e) { /* silent */ }
  }

  function setAttr(el, n, v) {
    if (!el) return;
    try { if (el.getAttribute(n) !== v) el.setAttribute(n, v); } catch (e) { /* silent */ }
  }

  function mkBtn(act, label, cls) {
    var b = document.createElement('button');
    b.setAttribute('type', 'button');
    b.setAttribute('data-sp-home-btn', act);
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', function (ev) { onAct(act, ev); }, false);
    return b;
  }

  /** Retry button for the three-state areas (v7.1 item 5). data-sp-home-retry names the area.
   *  Visibility is the caller's business (state rows show it at once; the visitors capsule toggles). */
  function mkRetry(kind) {
    var b = document.createElement('button');
    b.setAttribute('type', 'button');
    b.setAttribute('data-sp-home-retry', kind);
    b.className = 'sp-home__retry';
    b.textContent = ZH.retry;
    b.addEventListener('click', function (ev) { onRetry(kind, ev); }, false);
    return b;
  }

  /** One state row: loading (no action), empty or failed (both offer retry). */
  function mkStateRow(kind, st, text) {
    var row = document.createElement('div');
    row.className = 'sp-home__state' + (st === 'error' ? ' sp-home__state--error' : '');
    row.setAttribute('data-sp-home-state', kind);
    row.setAttribute('data-sp-home-state-kind', st);
    var t = document.createElement('span');
    t.className = 'sp-home__statetxt';
    t.textContent = text;
    row.appendChild(t);
    if (st !== 'loading') row.appendChild(mkRetry(kind));
    return row;
  }

  function mkCell(row) {
    var wrap = document.createElement('div');
    wrap.className = 'sp-home__cell' + (row.current ? ' sp-home__cell--cur' : '')
      + (row.enabled ? '' : ' sp-home__cell--off');
    var b = document.createElement('button');
    b.setAttribute('type', 'button');
    b.setAttribute('data-sp-home-cell', row.id);
    b.className = 'sp-home__cellbtn';
    if (row.note) b.setAttribute('title', row.note);
    var name = document.createElement('span');
    name.className = 'sp-home__cellname';
    name.textContent = row.name;
    var dot = document.createElement('span');
    dot.className = 'sp-home__dot';
    try { dot.style.background = row.dot.color; } catch (e) { /* silent */ }
    setAttr(dot, 'title', row.dot.title);
    b.appendChild(name);
    b.appendChild(dot);
    b.addEventListener('click', function (ev) { pickLine(row.id, ev); }, false);
    wrap.appendChild(b);
    return wrap;
  }

  function build() {
    if (root) return root;
    var el = null;
    try { el = document.createElement('div'); } catch (e) { return null; }   // no node = no layer (status quo)
    root = el;
    el.setAttribute('id', LAYER_ID);
    el.setAttribute('data-sp-home', 'on');
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', ZH.home);
    el.className = 'sp-home';
    // fullscreen geometry inline (no stylesheet dependency); the rem baseline mirrors the page
    // theme formula so sizes hold even when the upstream page has no CSS of ours.
    el.setAttribute('style', [
      'position:fixed', 'top:0', 'right:0', 'bottom:0', 'left:0', 'inset:0',
      'z-index:' + Z_APP,
      'overflow:hidden',
      'background:var(--bg-0,#0c0f0e)', 'color:var(--text-hi,#f2f2f2)',
      'font-size:clamp(40px,min(calc(100vw / 19.2),calc(100vh / 10.8)),240px)',
      'pointer-events:auto', 'touch-action:manipulation', '-webkit-user-select:none', 'user-select:none'
    ].join(';'));

    var deco = document.createElement('div');
    deco.className = 'sp-home__deco';
    deco.setAttribute('aria-hidden', 'true');
    var decoB = document.createElement('div');
    decoB.className = 'sp-home__deco sp-home__deco--b';
    decoB.setAttribute('aria-hidden', 'true');

    var frame = document.createElement('div');
    frame.className = 'sp-home__frame';

    // ---- left vertical nav (official-site style) ----
    var nav = document.createElement('aside');
    nav.className = 'sp-home__nav';
    var brand = document.createElement('div');
    brand.className = 'sp-home__brand';
    var micro = document.createElement('div');
    micro.className = 'sp-home__micro';
    micro.textContent = 'STRONGHOLD PROTOCOL';
    var title = document.createElement('h1');
    title.className = 'sp-home__title';
    title.textContent = ZH.brand;
    var sub = document.createElement('p');
    sub.className = 'sp-home__sub';
    sub.textContent = ZH.sub;
    brand.appendChild(micro);
    brand.appendChild(title);
    brand.appendChild(sub);

    var navBtns = document.createElement('div');
    navBtns.className = 'sp-home__navbtns';
    btns.local = mkBtn('local', ZH.local, 'sp-home__navbtn');
    btns.online = mkBtn('online', ZH.online, 'sp-home__navbtn');
    btns.lobby = mkBtn('lobby', ZH.lobby, 'sp-home__navbtn');
    btns.params = mkBtn('params', ZH.params, 'sp-home__navbtn');
    btns.config = mkBtn('config', ZH.config, 'sp-home__navbtn');
    btns.records = mkBtn('records', ZH.records, 'sp-home__navbtn');
    btns.update = mkBtn('update', ZH.update, 'sp-home__navbtn');
    // v7.2: 公告入口。板子本体是独立叠加层（notice-board.js，读 /__sp/notices.json，可热更），
    // 这里只负责一个按钮 + 未读小红点；板子没装载（无数据/无 XHR）时按钮自动禁用。
    btns.notice = mkBtn('notice', ZH.notice, 'sp-home__navbtn');
    navBtns.appendChild(btns.local);
    navBtns.appendChild(btns.online);
    navBtns.appendChild(btns.lobby);
    navBtns.appendChild(btns.params);
    navBtns.appendChild(btns.config);
    navBtns.appendChild(btns.records);
    navBtns.appendChild(btns.update);
    navBtns.appendChild(btns.notice);

    var navFoot = document.createElement('div');
    navFoot.className = 'sp-home__navfoot';
    navFoot.textContent = 'HOME LAYER ' + LAYER_VERSION;

    nav.appendChild(brand);
    nav.appendChild(navBtns);
    nav.appendChild(navFoot);

    // ---- main columns ----
    var main = document.createElement('main');
    main.className = 'sp-home__main';

    var hero = document.createElement('section');
    hero.className = 'sp-home__panel sp-home__panel--hero';
    var heroMicro = document.createElement('div');
    heroMicro.className = 'sp-home__micro';
    heroMicro.textContent = 'CURRENT SERVER';
    srvEl = document.createElement('div');
    srvEl.className = 'sp-home__srv';
    srvEl.setAttribute('data-sp-home-srv', '');
    srvEl.textContent = ZH.autoLine;
    var meta = document.createElement('div');
    meta.className = 'sp-home__meta';
    capEl = document.createElement('span');
    capEl.className = 'sp-home__capsule';
    capEl.setAttribute('data-sp-home-rtt', '');
    capDotEl = document.createElement('span');
    capDotEl.className = 'sp-home__dot';
    capTxtEl = document.createElement('span');
    capTxtEl.textContent = ZH.unknown;
    capEl.appendChild(capDotEl);
    capEl.appendChild(capTxtEl);
    visitorsEl = document.createElement('span');
    visitorsEl.className = 'sp-home__capsule';
    visitorsEl.setAttribute('data-sp-home-visitors', '');
    visitorsEl.textContent = ZH.visitors + ' --';
    // v7.1 item 5: the retry button is a SIBLING of the text-only capsule, so setting textContent on
    // the capsule (the fast path) can never wipe a child button.
    var visWrap = document.createElement('span');
    visWrap.className = 'sp-home__viswrap';
    visRetryBtn = mkRetry('visitors');
    try { visRetryBtn.style.display = 'none'; } catch (e) { /* silent */ }   // shown only on failure
    visWrap.appendChild(visitorsEl);
    visWrap.appendChild(visRetryBtn);
    meta.appendChild(capEl);
    meta.appendChild(visWrap);
    var gridMicro = document.createElement('div');
    gridMicro.className = 'sp-home__micro sp-home__microrow';
    gridMicro.textContent = 'SWITCH SERVER';
    gridEl = document.createElement('div');
    gridEl.className = 'sp-home__grid';
    gridEl.setAttribute('data-sp-home-grid', '');
    gridStateEl = document.createElement('div');
    gridStateEl.className = 'sp-home__gridstate';
    gridStateEl.setAttribute('data-sp-home-gridstate', '');
    hero.appendChild(heroMicro);
    hero.appendChild(srvEl);
    hero.appendChild(meta);
    hero.appendChild(gridMicro);
    hero.appendChild(gridEl);
    hero.appendChild(gridStateEl);

    var side = document.createElement('section');
    side.className = 'sp-home__panel sp-home__panel--side';
    var trMicro = document.createElement('div');
    trMicro.className = 'sp-home__micro sp-home__microrow';
    trMicro.textContent = 'TRANSPORT';
    segWrap = document.createElement('div');
    segWrap.className = 'sp-home__seg';
    segWrap.setAttribute('data-sp-home-transport', '');
    segWrap.setAttribute('role', 'radiogroup');
    segWrap.setAttribute('aria-label', ZH.transport);
    segBtns = [];
    for (var i = 0; i < TRANSPORT.length; i++) {
      var sb = document.createElement('button');
      sb.setAttribute('type', 'button');
      sb.setAttribute('role', 'radio');
      sb.setAttribute('data-sp-home-seg', TRANSPORT[i][0]);
      sb.className = 'sp-home__segbtn';
      sb.__spSeg = TRANSPORT[i][0];
      sb.textContent = TRANSPORT[i][1];
      sb.disabled = true;                                // display-only; editing lives in the params panel
      try { sb.setAttribute('disabled', ''); } catch (e) { /* property already set */ }
      segBtns.push(sb);
      segWrap.appendChild(sb);
    }
    trHintEl = document.createElement('p');
    trHintEl.className = 'sp-home__hint2';
    trHintEl.setAttribute('data-sp-home-transport-hint', '');
    trHintEl.textContent = ZH.needApk;
    try { trHintEl.style.display = 'none'; } catch (e) { /* silent */ }
    editBtn = document.createElement('button');
    editBtn.setAttribute('type', 'button');
    editBtn.setAttribute('data-sp-home-edit', '');
    editBtn.className = 'sp-home__editbtn';
    editBtn.textContent = ZH.editParams;
    editBtn.addEventListener('click', function (ev) { onEditTransport(ev); }, false);
    var boardMicro = document.createElement('div');
    boardMicro.className = 'sp-home__micro sp-home__microrow';
    boardMicro.textContent = 'LATENCY';
    boardEl = document.createElement('div');
    boardEl.className = 'sp-home__board';
    boardEl.setAttribute('data-sp-home-board', '');
    side.appendChild(trMicro);
    side.appendChild(segWrap);
    side.appendChild(trHintEl);
    side.appendChild(editBtn);
    side.appendChild(boardMicro);
    side.appendChild(boardEl);

    main.appendChild(hero);
    main.appendChild(side);
    frame.appendChild(nav);
    frame.appendChild(main);

    var foot = document.createElement('footer');
    foot.className = 'sp-home__foot';
    // v7.1 item 6: the layer's ONLY connection banner (left of the version/hint column)
    connEl = document.createElement('div');
    connEl.className = 'sp-home__conn';
    connEl.setAttribute('data-sp-home-conn', '');
    connEl.setAttribute('role', 'status');
    connEl.setAttribute('aria-live', 'polite');
    connDotEl = document.createElement('span');
    connDotEl.className = 'sp-home__dot';
    connTxtEl = document.createElement('span');
    connTxtEl.setAttribute('data-sp-home-conn-text', '');
    connTxtEl.textContent = CONN_TXT.connecting;
    connEl.appendChild(connDotEl);
    connEl.appendChild(connTxtEl);
    var footCol = document.createElement('div');
    footCol.className = 'sp-home__footcol';
    verEl = document.createElement('div');
    verEl.className = 'sp-home__ver';
    verEl.setAttribute('data-sp-home-version', '');
    verEl.textContent = 'SP HOME ' + LAYER_VERSION;
    hintEl = document.createElement('p');
    hintEl.className = 'sp-home__hint';
    hintEl.setAttribute('data-sp-home-hint', '');
    footCol.appendChild(verEl);
    footCol.appendChild(hintEl);
    foot.appendChild(connEl);
    foot.appendChild(footCol);

    el.appendChild(deco);
    el.appendChild(decoB);
    el.appendChild(frame);
    el.appendChild(foot);
    el.addEventListener('click', stopEvent, false);
    applyFeatures();
    return el;
  }

  /** Mount point + layering: inside .app-root (page panels sit above us) preferred; otherwise
   *  body with a huge z-index. */
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
      try { root.style.zIndex = String(inRoot ? Z_APP : Z_BODY); } catch (e) { /* inline fallback stays */ }
    }
    return true;
  }

  function setDisplay(on) {
    if (!root) return;
    if (root.__spOn === on) return;                      // compare before write: no self-excitation
    root.__spOn = on;
    try { root.style.display = on ? '' : 'none'; } catch (e) { /* style unavailable: attr + CSS */ }
    try { root.setAttribute('data-sp-home', on ? 'on' : 'off'); } catch (e) { /* silent */ }
  }

  /** Readiness / bridge state -> nav buttons: compare before write; bridges appear late
   *  (module scripts), so this is recomputed on every scan. */
  function setBtn(act, label, enabled, reason) {
    var b = btns[act];
    if (!b) return;
    if (b.textContent !== label) b.textContent = label;
    var dis = !enabled;
    why[act] = dis ? (reason || 'unavailable') : '';
    if (b.disabled !== dis) { try { b.disabled = dis; } catch (e) { /* attr fallback */ } }
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
    } catch (e) { /* attr failures do not affect click logic */ }
  }

  function setDisabled(btn, dis, reason) {
    if (!btn) return;
    try { if (btn.disabled !== dis) btn.disabled = dis; } catch (e) { /* attr fallback */ }
    try {
      if (dis) {
        if (btn.getAttribute('disabled') === null) btn.setAttribute('disabled', '');
        if (reason && btn.getAttribute('title') !== reason) btn.setAttribute('title', reason);
      } else {
        btn.removeAttribute('disabled');
        btn.removeAttribute('title');
      }
    } catch (e) { /* silent */ }
  }

  function hintText() {
    var out = [];
    for (var act in btns) {
      if (!Object.prototype.hasOwnProperty.call(btns, act)) continue;
      if (btns[act] && btns[act].disabled && why[act] && out.indexOf(why[act]) < 0) out.push(why[act]);
    }
    if (out.length) return ZH.unusable + out.join(ZH.sep);
    if (localNote) return localNote;
    return '';
  }

  // ---- v7 paint (all writes compare-before-write) -------------------------------------------------

  function currentLineInfo(L) {
    var rows = L.entries;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].current) return rows[i];
    }
    if (L.curLocal) return { id: 'local', name: ZH.localSrv, note: '', app: '', rttMs: -1, enabled: true, current: true, reachable: undefined };
    return { id: 'auto', name: ZH.autoLine, note: '', app: '', rttMs: -1, enabled: true, current: true, reachable: undefined };
  }

  function paintHero(L) {
    var cur = currentLineInfo(L);
    if (srvEl) setTxt(srvEl, cur.name || ZH.autoLine);
    var dot = quickDot(cur);
    if (capDotEl) { try { capDotEl.style.background = dot.color; } catch (e) { /* silent */ } }
    var ms = isFinite(cur.rttMs) && cur.rttMs > 0;
    if (capTxtEl) setTxt(capTxtEl, ms ? dot.title + ' \u00b7 ' + fmtRtt(cur.rttMs) : dot.title);
    setAttr(capEl, 'title', dot.title);
    var app = String((cur && cur.app) || '');
    if (verEl) setTxt(verEl, 'SP HOME ' + LAYER_VERSION + (app ? ' / LINE ' + fmtApp(app) : ''));
  }

  function gridRows(L) {
    var cells = [];
    cells.push({
      id: 'local', name: ZH.localSrv, note: ZH.noteLocal,
      enabled: canLocal(), current: L.curLocal, dot: quickDot({ id: 'local', enabled: canLocal() })
    });
    cells.push({
      id: 'auto', name: ZH.autoLine, note: ZH.noteAuto,
      enabled: canOnline(), current: L.curAuto, dot: quickDot({ id: 'auto' })
    });
    var entries = L.entries;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e) continue;
      cells.push({
        id: e.id, name: e.name, note: e.note,
        enabled: e.enabled !== false && canOnline(), current: !!e.current,
        dot: rttDotOf(e.rttMs, e.enabled, e.reachable)
      });
    }
    return cells;
  }

  /** Server-list state (v7.1 item 5): loading / error / empty / ok. "Empty" means the shell listed
   *  no switchable line beyond the two built-ins (local + auto always render as cells). */
  function gridStateOf(L) {
    if (L.loading) return 'loading';
    if (L.failed) return 'error';
    if (!L.entries || !L.entries.length) return 'empty';
    return 'ok';
  }

  function renderGrid(L) {
    if (!gridEl) return;
    var cells = gridRows(L);
    var st = gridStateOf(L);
    var sig = st + ';';
    for (var i = 0; i < cells.length && i < GRID_MAX; i++) {
      var c = cells[i];
      sig += c.id + '|' + c.name + '|' + (c.current ? 1 : 0) + '|' + (c.enabled ? 1 : 0)
        + '|' + c.dot.color + '|' + c.dot.title + ';';
    }
    if (sig === gridSig) return;
    gridSig = sig;
    clearEl(gridEl);
    for (var j = 0; j < cells.length && j < GRID_MAX; j++) appendKid(gridEl, mkCell(cells[j]));
    if (gridStateEl) {
      clearEl(gridStateEl);
      if (st !== 'ok') {
        var gtxt = st === 'loading' ? ZH.loading : (st === 'error' ? STATE_FAIL.grid : ZH.noLines);
        appendKid(gridStateEl, mkStateRow('grid', st, gtxt));
      }
    }
  }

  function boardRows(L) {
    var rows = L.entries.slice(0);
    rows.sort(function (a, b) {
      var x = (a && isFinite(a.rttMs) && a.rttMs > 0) ? a.rttMs : Infinity;
      var y = (b && isFinite(b.rttMs) && b.rttMs > 0) ? b.rttMs : Infinity;
      return x - y;
    });
    return rows;
  }

  function renderBoard(L) {
    if (!boardEl) return;
    var rows = boardRows(L);
    var st = L.loading ? 'loading' : (L.failed ? 'error' : (rows.length ? 'ok' : 'empty'));
    var sig = st + ';';
    for (var i = 0; i < rows.length && i < BOARD_MAX; i++) {
      var r = rows[i];
      var d = rttDotOf(r.rttMs, r.enabled, r.reachable);
      sig += r.id + '|' + r.name + '|' + d.color + '|' + fmtRtt(r.rttMs) + ';';
    }
    if (sig === boardSig) return;
    boardSig = sig;
    clearEl(boardEl);
    if (st !== 'ok') {
      var btxt = st === 'loading' ? ZH.loading : (st === 'error' ? STATE_FAIL.board : ZH.noLines);
      appendKid(boardEl, mkStateRow('board', st, btxt));
      return;
    }
    for (var j = 0; j < rows.length && j < BOARD_MAX; j++) {
      var row = rows[j];
      var dot = rttDotOf(row.rttMs, row.enabled, row.reachable);
      var line = document.createElement('div');
      line.className = 'sp-home__line' + (row.enabled === false ? ' sp-home__line--off' : '');
      var nm = document.createElement('span');
      nm.className = 'sp-home__cellname';
      nm.textContent = row.name;
      var dt = document.createElement('span');
      dt.className = 'sp-home__dot';
      try { dt.style.background = dot.color; } catch (e) { /* silent */ }
      var tt = document.createElement('span');
      tt.className = 'sp-home__linett';
      tt.textContent = fmtRtt(row.rttMs);
      line.appendChild(nm);
      line.appendChild(dt);
      line.appendChild(tt);
      setAttr(line, 'title', dot.title);
      appendKid(boardEl, line);
    }
  }

  function paintTransport() {
    if (!segWrap) return;
    var tr = getTransport();
    var sig = (tr.supported ? '1' : '0') + ':' + tr.value + ':' + (canPanels() ? '1' : '0');
    if (sig === transportSig) return;
    transportSig = sig;
    for (var i = 0; i < segBtns.length; i++) {
      setAttr(segBtns[i], 'aria-checked', segBtns[i].__spSeg === tr.value ? 'true' : 'false');
    }
    if (trHintEl) { try { trHintEl.style.display = tr.supported ? 'none' : ''; } catch (e) { /* silent */ } }
    setDisabled(editBtn, !canPanels(), ZH.whyPanel);
  }

  /** Visitors capsule with its three states (v7.1 item 5). Never a silent blank: loading shows an
   *  ellipsis, a failure says so and reveals the retry button. */
  function paintVisitors() {
    if (!visitorsEl) return;
    var n = visitorsNow();
    var st = visitorsState;
    if (st !== 'loading' && st !== 'failed') st = (n === null) ? 'empty' : 'ok';
    var txt = ZH.visitors + ' ';
    if (st === 'loading') txt += '\u2026';
    else if (st === 'failed') txt += ZH.fail;
    else if (n === null) txt += '--';
    else txt += String(n);
    setTxt(visitorsEl, txt);
    setAttr(visitorsEl, 'data-sp-home-visitors-state', st);
    if (st === 'failed') setAttr(visitorsEl, 'title', STATE_FAIL.visitors);
    if (visRetryBtn) { try { visRetryBtn.style.display = (st === 'failed') ? '' : 'none'; } catch (e) { /* silent */ } }
  }

  /** The single connection banner (v7.1 item 6). One element, four tiers, compare-before-write. */
  function paintConn(L) {
    if (!connEl) return;
    var st = connStateOf(L);
    if (st === connSig) return;
    connSig = st;
    try { connEl.className = 'sp-home__conn sp-home__conn--' + st; } catch (e) { /* silent */ }
    setAttr(connEl, 'data-sp-home-conn-state', st);
    setTxt(connTxtEl, CONN_TXT[st] || CONN_TXT.connecting);
    if (connDotEl) { try { connDotEl.style.background = CONN_DOT[st] || CONN_DOT.connecting; } catch (e) { /* silent */ } }
  }

  function paint() {
    try {
      if (!root) return;
      var rdy = ready();
      if (rdy) { localStarting = false; localNote = ''; }
      var localLabel = localStarting ? ZH.starting : (rdy ? ZH.enter : ZH.local);
      var hi = canLocal(), on = canOnline(), pa = canPanels(), up = canUpdate();
      setBtn('local', hi ? localLabel : ZH.local, hi, hi ? '' : ZH.whyLocal);
      setBtn('online', ZH.online, on, on ? '' : ZH.whyOnline);
      setBtn('lobby', ZH.lobby, pa, pa ? '' : ZH.whyPanel);
      setBtn('params', ZH.params, pa, pa ? '' : ZH.whyPanel);
      setBtn('config', ZH.config, pa, pa ? '' : ZH.whyPanel);
      setBtn('records', ZH.records, pa, pa ? '' : ZH.whyPanel);
      setBtn('update', ZH.update, up, up ? '' : ZH.whyUpdate);
      var nt = canNotice();
      setBtn('notice', ZH.notice, nt, nt ? '' : ZH.whyNotice);
      setAttr(btns.notice, 'data-sp-unread', noticeUnread() ? '1' : '0');
      var L = getLines();
      applyFeatures();
      paintHero(L);
      renderGrid(L);
      renderBoard(L);
      paintTransport();
      paintVisitors();
      pullVisitors();
      paintConn(L);
      var text = hintText();
      if (hintEl && hintEl.textContent !== text) hintEl.textContent = text;
    } catch (e) { /* silent: paint failures never touch the state machine */ }
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
    } catch (e) { /* silent degradation: worst case = layer not shown (status quo) */ }
  }

  /** Fallback probe + repaint: hidden but home state reappeared -> show(); otherwise repaint only. */
  function sweep() {
    try {
      if (!shown && !suppressed() && homePresent()) shown = true;   // user did not ask for upstream home
      sync();
    } catch (e) { /* silent: if this fails, do nothing */ }
  }

  function show() { shown = true; sync(); }

  function hide() { shown = false; sync(); }

  /** Is the layer really covering the screen right now (intent + home state + not suppressed)? */
  function visible() {
    try { return !!(root && root.__spOn === true); } catch (e) { return false; }
  }

  /** Read/write suppress: true = yield and stop auto-covering; false = release (cover again when
   *  the home state returns). No argument = read. Only html/body attributes are honored so Java or
   *  other shell modules can flip it directly. */
  function suppressApi(on) {
    var v = (typeof on === 'undefined') ? suppressed() : !!on;
    if (typeof on !== 'undefined') {
      try {
        var d = docEl();
        if (d) {
          if (v) { d.setAttribute(SUPPRESS_ATTR, '1'); shown = false; }   // yield at once
          else d.removeAttribute(SUPPRESS_ATTR);
        }
      } catch (e) { /* silent */ }
      sweep();
    }
    return v;
  }

  // ---- actions ------------------------------------------------------------------------------------

  /** "Local service": not ready -> start + poll; ready -> enter. Both hide() BEFORE the bridge
   *  call and arm autostart (starting/switching reloads the page; the title page auto-enters). */
  function clickLocal() {
    hide();
    armAutostart();
    var started = startLocalService();
    if (!started) { localNote = ZH.startFail; paint(); return; }
    if (!readReady()) startPoll();
    paint();
  }

  /** "Enter online": auto line + auto enter. hide() first, then setServer('auto') -> setAutostart(). */
  function clickOnline() {
    hide();
    try {
      var sh = window.shell || null;
      if (sh && typeof sh.setServer === 'function') sh.setServer('auto');
    } catch (e) { /* bridge broken: availability recomputed on next scan */ }
    armAutostart();
  }

  /** v7: "check update" -- the bridge owns everything (native dialog, or a cache-busting reload
   *  on the plain web). The layer stays as-is; a reload rebuilds it from scratch anyway. */
  function clickUpdate() {
    try {
      var api = window.__SP_SHELL;
      if (api && typeof api.checkUpdate === 'function') { api.checkUpdate(); return true; }
    } catch (e) { /* silent */ }
    return false;
  }

  /** v7.2: open/close the bulletin board. The board mounts itself (into <body> when it has no host),
   *  so this layer owns nothing but the button; the unread dot is repainted by the next paint(). */
  function clickNotice() {
    var n = noticeApi();
    if (!n) return false;
    var ok = false;
    try { ok = !!n.toggle(); } catch (e) { ok = false; }
    try { paint(); } catch (e) { /* silent */ }
    return ok;
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
        if (nowMs() - localSince > POLL_MAX_MS) { localStarting = false; localNote = ZH.startTimeout; paint(); return; }
        pollTimer = setTimeout(tick, POLL_MS);
      } catch (e) { pollTimer = 0; }
    };
    try { pollTimer = setTimeout(tick, POLL_MS); } catch (e) { pollTimer = 0; localStarting = false; }
  }

  /** Panel buttons: the layer does NOT hide (inside .app-root, 70 < the panel's 80, panels open on
   *  top). Fallback case (mounted on body with the huge z-index): yield first; the fallback probe
   *  covers again once the panel closes. */
  function openPanel(kind) {
    var api = null;
    try { api = window.__SP_SHELL || null; } catch (e) { api = null; }
    if (!api || typeof api.openPanel !== 'function') return false;
    if (!inAppRoot) hide();
    try { api.openPanel(kind); return true; } catch (e) { if (!inAppRoot) show(); return false; }
  }

  /** Grid cell: local -> the local-service state machine; auto -> the online path; any other
   *  listed line -> hide, setServer(id), autostart (same sequence as the upstream switch). */
  function pickLine(id, ev) {
    try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* silent */ }
    try {
      if (id === 'local') { clickLocal(); return; }
      if (id === 'auto') { clickOnline(); return; }
      hide();
      try {
        var sh = window.shell || null;
        if (sh && typeof sh.setServer === 'function') sh.setServer(id);
      } catch (e) { /* bridge broken: availability recomputed on next scan */ }
      armAutostart();
    } catch (e) { /* silent */ }
  }

  /** Transport "open params panel": the segment display is read-only; editing belongs to the
   *  params panel (single writer for the transport value). */
  function onEditTransport(ev) {
    try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* silent */ }
    try { openPanel('params'); } catch (e) { /* silent */ }
  }

  function onAct(act, ev) {
    try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* silent */ }
    try {
      if (act === 'local') { clickLocal(); return; }
      if (act === 'online') { clickOnline(); return; }
      if (act === 'update') { clickUpdate(); return; }
      if (act === 'notice') { clickNotice(); return; }
      openPanel(act);                                   // 'lobby' | 'params' | 'config' | 'records'
    } catch (e) { /* silent: a broken tap does nothing (the upstream home is covered anyway) */ }
  }

  // ---- observers (like room-hook: merged callbacks, one scan per 60ms window) ----------------------

  function schedule() {
    if (queued) return;
    queued = 1;
    try { setTimeout(function () { queued = 0; sweep(); }, SWEEP_MS); } catch (e) { queued = 0; }
  }

  /** The shell pushes a freshly verified + probed list through __SP_SHELL.onServers() ->
   *  'sp-servers'. Invalidate caches; the next merged scan repaints hero/grid/board. */
  function onServers() {
    linesCache = null;
    transportCache = null;
    schedule();
  }

  /** online/offline flips the banner tier at once (v7.1 item 6). No request is made here. */
  function onNetChange() {
    try { paint(); } catch (e) { /* silent */ }
  }

  function arm() {
    if (armed) return;
    armed = true;
    injectStyle();
    bindFeatures();                                    // capability classes before the first build
    sweep();
    try {
      var mo = new MutationObserver(schedule);
      mo.observe(docEl() || document, { childList: true, subtree: true, characterData: true });
    } catch (e) { /* old engine: first scan + bridge-time syncs only */ }
    try {
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('sp-servers', onServers, false);
        window.addEventListener('online', onNetChange, false);
        window.addEventListener('offline', onNetChange, false);
      }
    } catch (e) { /* old engine: the shell push is just missed, list read on paint */ }
    try {
      // one-shot: ask the shell for a fresh verified list (the answer lands on 'sp-servers')
      var sh = window.shell;
      if (sh && typeof sh.refreshServerList === 'function') sh.refreshServerList();
    } catch (e) { /* bridge missing: static/last-known list is fine */ }
  }

  // ---- exports (Java back key / other shell modules / debugging) -----------------------------------

  var api = {
    show: show,
    hide: hide,
    visible: visible,
    suppress: suppressApi,
    sweep: sweep
  };
  try { window.__SP_HOME = api; } catch (e) { /* read-only window (extreme sandbox): layer still works */ }
  try { window.__SP_HOME_LAYER_SWEEP = sweep; } catch (e) { /* same */ }

  if (document.readyState === 'loading') {
    try { document.addEventListener('DOMContentLoaded', arm, false); } catch (e) { arm(); }
  } else {
    arm();
  }
})();
