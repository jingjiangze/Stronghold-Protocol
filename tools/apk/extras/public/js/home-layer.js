/* global window, document, MutationObserver */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here
// home-layer.js -- title-screen controls layer (v10.0). Hot-update overlay.
//
// WHAT THIS IS
//   The re-apk home is the UPSTREAM title screen plus OUR controls on top -- this file is only the
//   controls. It never covers the page: the upstream title screen keeps rendering and stays fully
//   interactive; we mount one pointer-events:none overlay and only our own controls take taps.
//   It ports the look and copy of the old line (tag shell-v2.9.31, tools/apk/patches/settings-v2.2 ..
//   v5.6) into the extras layer, which is the re line's whole design (zero build-time patches):
//     - side button group (.title-side / .title-room / .title-room__cfg): settings / params /
//       config / records, in that order                                      [v2.2, v2.3, v3.0, v3.5, v10.0]
//     - footer meta (.title-foot): the update button (carries .title-foot__update,
//       the mint-outline form) -- NO version label of ours any more        [v3.3, v3.5, v10.0]
//   v10.0 (owner's words, 2026-10-08 2nd round): the top-right area belongs to UPSTREAM. Our own
//   connection capsule is GONE (upstream 0.2.1 already renders the status row -- dot + text + ping +
//   guide + gear + fullscreen -- inside the login panel), the lobby side entry is GONE (mirroring the
//   vendored copy: the login panel's own local/lobby duo is the entry, and this layer deliberately
//   does NOT draw that duo -- upstream's own start button stays untouched here), the footer keeps
//   UPSTREAM's version line (v${APP_VERSION} / WEB SIMULATION: we no longer hide it and no longer
//   draw our own "SP HOME" label), and the visitor count (v5.2) is appended as one small span INTO
//   upstream's own .title-conn row instead of into a capsule of ours.
//   Class names stay title-*; the patch CSS is carried verbatim but SCOPED under #sp-home-layer,
//   because upstream 0.2.1 now ships .title-conn / .title-foot itself -- an unscoped rule would
//   restyle the upstream controls.
//
// WHAT THE UPSTREAM 0.2.1 TITLE SCREEN ALREADY HAS (so we do NOT duplicate the whole screen):
//   the callsign field + start button (.title-login .btn--primary), the .title-conn status row
//   (status dot + text + PingPill + the guide button + a .title-settings gear + fullscreen) and the
//   .title-foot copyright/version line. Those came from the same v2.2 patch family and were merged
//   upstream, so our layer adds only the missing controls (side group / foot update button).
//
// BEHAVIOUR (existing bridges only; this layer invents no protocol and makes ZERO network requests):
//   - panels:        window.__SP_SHELL.openPanel(kind), kind in servers|params|config|records|appearance
//                    (there is NO built-in 'lobby' kind -- never call openPanel('lobby'))
//   - update:        window.__SP_SHELL.checkUpdate()
//   - settings:      our own appearance panel (openPanel('appearance')); no upstream gear click
//   - visitors:      window.__SP_LOBBY.visitorsCached() / fetchVisitors(false) (5 min, as v5.2);
//                    the fetch belongs to lobby.js -- this layer only asks it and paints the span
//   - enter state:   read-only from the page's own store (globalThis.__SP__ = { store, net, data })
//   - autostart:     on the title screen we consume the one-shot window.shell.takeAutostart() the v3.6
//                    patch used to consume inside title.js (that build patch is gone on the re line),
//                    so the server panel's setAutostart() really auto-enters instead of leaving a stale flag.
//
// UPSTREAM DOM DISCIPLINE (v10.0: masking is GONE)
//   The v8/v9 dedup masking (display:none on the upstream .title-conn row / gear / version line) is
//   REMOVED: now that our capsule and our version label are gone there is nothing to deduplicate, and
//   hiding one child of upstream's flex rows would re-flow its siblings -- upstream positions must not
//   move (owner's rule). The ONLY upstream DOM write left is appending one visitors span to the end of
//   the upstream .title-conn row (sanctioned by the owner: "append it ... without moving anything"),
//   and it is removed again the moment our controls stop showing. No node is removed, no selector is
//   renamed, no attribute of an upstream node is touched.
//
// VENDORED FULL TITLE SCREEN (mutually exclusive with this layer):
//   tools/apk/extras ships OUR copy of the title screen module (extras/public, screens/title.js) with
//   the old 2.9.31 build patches baked in -- extras overrides the upstream file at the same relative
//   path, in the APK tree and in the filesDir hot tree alike. When that copy is on the page it sets
//   window.__SP_TITLE_VENDORED, and wanted() below returns false: this layer builds nothing and touches
//   no upstream node, so the controls are never drawn twice. Unset flag (no vendored copy) = unchanged.
//
// STATE MACHINE (window.__SP_HOME API signatures unchanged):
//   window.__SP_HOME = { show(), hide(), visible(), suppress(on), sweep() }
//   - shown = OUR intent. The layer really shows when shown && !suppressed() && homePresent().
//   - visible() means "our controls are mounted and shown" (there is no full-screen cover).
//   - leaving the title screen (title DOM unmounts) hides the controls at once; coming back shows them.
//   - suppress(true) = yield (hide, stop auto-showing, drop the visitor span); suppress(false) = release.
//
// IDEMPOTENCE / DEFENCE: window.__SP_HOME_LAYER guard (first injection wins); MutationObserver merged
// (60ms window); a 1s sweep poll is the fallback when MutationObserver cannot run; every DOM write is
// compare-before-write; bridge reads are throttled; any DOM/bridge failure degrades silently to
// "controls not shown". ES5 only (floor Chromium 80): no arrow functions, no block-scoped
// declarations, no template literals, no optional chaining. ASCII-only source (Chinese strings are
// \uXXXX escapes) so the hot-update pipeline never worries about encodings.
(function () {
  'use strict';
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (window.__SP_HOME_LAYER) return;                  // idempotence: repeated injection is a no-op
  window.__SP_HOME_LAYER = 1;

  var LAYER_ID = 'sp-home-layer';
  var STYLE_ID = LAYER_ID + '-style';
  var LAYER_VERSION = 'v10.0';
  var SUPPRESS_ATTR = 'data-sp-home-suppress';
  var SWEEP_MS = 60;                                   // observer merge window: one DOM storm, one scan
  var FALLBACK_MS = 1000;                              // observer-less engines: sweep poll cadence
  var VISITORS_MS = 300000;                            // v5.2: visitors refresh cadence (5 minutes)
  var AUTOSTART_DELAY_MS = 400;                        // v3.6: wait for the field/socket, then enter
  var TITLE_MARKS = ['.title-screen', '.title-main', '.title-login'];
  var UPSTREAM_START = '.title-login .btn--primary';   // upstream's start button (enter action)
  var UPSTREAM_CONN = '.title-conn';                   // upstream's status row: the visitors span lives in it
  var Z_ROOT = 'var(--z-conn,60)';                     // > --z-screen(1), < --z-modal(80)
  // Vendored full title screen (extras/public, screens/title.js). That copy already renders every
  // control this layer adds, so when it is loaded the layer stands down COMPLETELY (no overlay, no
  // upstream DOM write) instead of drawing the same controls twice. Reversible both ways: an APK
  // without the vendored copy leaves the flag unset and this layer behaves exactly as before.
  var VENDOR_FLAG = '__SP_TITLE_VENDORED';
  var VISITOR_SPAN_STYLE = 'margin-left:.06rem;opacity:.66;font-size:.9em';

  // User-facing strings (single place; \uXXXX so the source stays pure ASCII).
  var ZH = {
    home: '\u672c\u5730\u9996\u9875',
    params: '\u53c2\u6570', config: '\u914d\u7f6e', records: '\u6218\u7ee9',
    update: '\u68c0\u67e5\u66f4\u65b0', updateTitle: '\u68c0\u67e5\u5185\u5bb9\u66f4\u65b0', settings: '\u8bbe\u7f6e',
    visitors: '\u5927\u5385', people: ' \u4eba', visitorDot: '\u00b7 ',
    whyPanel: '\u9762\u677f\u672a\u52a0\u8f7d\uff08\u7f3a\u5c11 openPanel \u6865\uff09',
    whyUpdate: '\u68c0\u67e5\u66f4\u65b0\u9700\u8981 App \u7248\uff08\u7f3a\u5c11\u5347\u7ea7\u6865\uff09',
    unusable: '\u4e0d\u53ef\u7528\uff1a'
  };

  var shown = true;            // our intent; single source of truth
  var root = null;             // the overlay node (pointer-events:none)
  var btns = {};               // act -> button (room group + the footer update)
  var roomEl = null;           // .title-room (side button group)
  var footEl = null;
  var visitorsEl = null;       // our one appended span (inside upstream's .title-conn)
  var fallbackTimer = 0;
  var queued = 0;              // merged observer window: one scan per storm
  var armed = false;
  var storeBound = false;
  var visitorsAt = 0;          // visitors pull throttle

  function nowMs() { return new Date().getTime(); }

  function docEl() { return document.documentElement || null; }

  function bodyEl() { return document.body || null; }

  /** Safe one-element lookup (stub DOMs / old engines may not have querySelector). */
  function qs(sel) {
    try {
      if (typeof document.querySelector !== 'function') return null;
      return document.querySelector(sel);
    } catch (e) { return null; }
  }

  /** The user/Java said "I want the plain upstream home": the mark on html OR body wins. */
  function suppressed() {
    try {
      var d = docEl();
      var b = bodyEl();
      if (d && d.hasAttribute && d.hasAttribute(SUPPRESS_ATTR)) return true;
      if (b && b.hasAttribute && b.hasAttribute(SUPPRESS_ATTR)) return true;
    } catch (e) { /* unreadable mark: treat as not suppressed */ }
    return false;
  }

  /** Title screen present? One level of querySelector marks, first hit wins (no heuristics). */
  function homePresent() {
    for (var i = 0; i < TITLE_MARKS.length; i++) {
      if (qs(TITLE_MARKS[i])) return true;
    }
    return false;
  }

  /** Should the controls show right now: intent + title state + not suppressed + not superseded.
   *  When the page loads OUR vendored full title screen (window.__SP_TITLE_VENDORED, set by
   *  extras/public, screens/title.js) that copy renders these controls itself, so this layer
   *  yields entirely: no overlay is built and no upstream node is touched. */
  function wanted() { return shown && !suppressed() && homePresent() && !vendoredTitle(); }

  /** True when the vendored title screen is the one on the page (mutually exclusive with this layer). */
  function vendoredTitle() {
    try { return !!window[VENDOR_FLAG]; } catch (e) { return false; }
  }

  // ---- bridge readers (all read-only) ------------------------------------------------------------

  function canPanels() {
    try { return !!(window.__SP_SHELL && typeof window.__SP_SHELL.openPanel === 'function'); } catch (e) { return false; }
  }

  function canUpdate() {
    try { return !!(window.__SP_SHELL && typeof window.__SP_SHELL.checkUpdate === 'function'); } catch (e) { return false; }
  }

  // ---- visitors (read-only; the request itself belongs to lobby.js) -------------------------------

  /** Connection state from the page's own store (globalThis.__SP__ = { store, net, data }). */
  function connStatus() {
    try {
      var sp = window.__SP__;
      var s = sp && sp.store;
      if (s && typeof s.get === 'function') {
        var c = s.get().connection || {};
        return String(c.status || '');
      }
    } catch (e) { /* no store: visitors stay hidden */ }
    return '';
  }

  function onlineNow() {
    var s = connStatus();
    return s === 'online' || s === 'connected';
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
   *  cannot spam it; the promise only triggers a repaint. */
  function pullVisitors() {
    var t = nowMs();
    if (visitorsAt && (t - visitorsAt) < VISITORS_MS) return;
    visitorsAt = t;
    try {
      var api = window.__SP_LOBBY;
      if (api && typeof api.fetchVisitors === 'function') {
        var p = api.fetchVisitors(false);
        if (p && typeof p.then === 'function') p.then(function () { paintVisitors(); }, function () { /* silent */ });
      }
    } catch (e) { /* silent */ }
  }

  // ---- overlay DOM -------------------------------------------------------------------------------

  /** One-shot style block. The patch CSS is carried verbatim, but every selector is scoped under
   *  #sp-home-layer because upstream 0.2.1 already ships .title-conn / .title-foot of its own. */
  function injectStyle() {
    try {
      if (!document.head || typeof document.createElement !== 'function') return;
      if (typeof document.getElementById === 'function' && document.getElementById(STYLE_ID)) return;
      var st = document.createElement('style');
      st.setAttribute('id', STYLE_ID);
      st.textContent = [
        '#' + LAYER_ID + '{position:fixed;top:0;right:0;bottom:0;left:0;inset:0;z-index:' + Z_ROOT + ';',
        'pointer-events:none;overflow:hidden;color:var(--text-hi,#f2f2f2);',
        '-webkit-user-select:none;user-select:none}',
        '#' + LAYER_ID + '[data-sp-home="off"]{display:none}',
        '#' + LAYER_ID + ' *{box-sizing:border-box}',
        '#' + LAYER_ID + ' button{font:inherit;touch-action:manipulation;-webkit-tap-highlight-color:transparent}',
        // v2.2/v10.0: side column (top-right). top: 1.05rem -> 1.35rem -> 1.7rem: upstream 0.2.1 added
        // the LangToggle to .title-corner--tr, and the block's real bottom is ~1.51rem at every sim
        // viewport (measured), so 1.35rem overlapped it by ~.15rem. Our column is BELOW the corner
        // block; the corner block itself is never touched.
        '#' + LAYER_ID + ' .title-side{position:absolute;z-index:3;top:1.7rem;right:.44rem;display:flex;',
        'flex-direction:column;align-items:flex-end;gap:.12rem;pointer-events:auto}',
        // v3.5: side button group (settings/params/config/records -- v10.0 dropped the lobby entry).
        // The standalone .title-gear of v2.2/v2.3 is gone: v3.5 folded settings into .title-room__cfg.
        '#' + LAYER_ID + ' .title-room{display:flex;flex-direction:column;gap:.08rem;align-items:flex-end}',
        '#' + LAYER_ID + ' .title-room__cfg{border:1px solid #2c3a35;background:rgba(12,15,14,.55);',
        'color:var(--text-hi,#d8e3de);padding:.08rem .14rem;font-size:.13rem;border-radius:.05rem;cursor:pointer}',
        '#' + LAYER_ID + ' .title-room__cfg:hover{border-color:var(--mint-700,#4ed8af);color:var(--mint-700,#4ed8af)}',
        '#' + LAYER_ID + ' .title-room__cfg:disabled{opacity:.4;cursor:default}',
        '#' + LAYER_ID + ' .title-room__cfg:disabled:hover{border-color:#2c3a35;color:var(--text-hi,#d8e3de)}',
        // v3.5: update button = mint outline + bright text (verbatim; wins over .title-room__cfg)
        '#' + LAYER_ID + ' .title-foot__update{background:rgba(78,216,175,.08);border:1px solid rgba(78,216,175,.55);',
        'border-radius:.04rem;padding:.03rem .12rem;font-family:var(--font-display,inherit);font-size:.11rem;',
        'line-height:1.4;letter-spacing:.16em;color:var(--mint-400,#4ed8af);cursor:pointer;',
        'transition:border-color var(--t-fast,150ms) var(--ease-out,ease),background-color var(--t-fast,150ms),',
        'color var(--t-fast,150ms)}',
        '#' + LAYER_ID + ' .title-foot__update:hover{border-color:var(--mint-400,#4ed8af);',
        'background:rgba(78,216,175,.16);color:#eafff7}',
        '#' + LAYER_ID + ' .title-foot__update:active{background:rgba(78,216,175,.26);transform:translateY(1px)}',
        // v3.3/v3.5/v10.0: footer meta (the update button only -- upstream's own version line stays
        // visible just below it, so we anchor ours directly above the upstream footer).
        '#' + LAYER_ID + ' .title-foot{position:absolute;z-index:3;right:.44rem;bottom:.62rem;display:flex;',
        'justify-content:flex-end;align-items:center;gap:.14rem;font-size:.13rem;color:var(--text-dim,#5d6863);',
        'pointer-events:auto}',
        '#' + LAYER_ID + ' .title-foot__meta{display:inline-flex;align-items:center;gap:.14rem}',
        // short landscape phones: tighter column, never above the upstream corner block
        '@media (max-height:600px) and (pointer:coarse){',
        '#' + LAYER_ID + ' .title-side{gap:.06rem}',
        '#' + LAYER_ID + ' .title-foot{bottom:.5rem}',
        '}',
        '@media (max-width:600px){',
        '#' + LAYER_ID + ' .title-side{right:.18rem}',
        '#' + LAYER_ID + ' .title-foot{right:.18rem}',
        '}'
      ].join('');
      document.head.appendChild(st);
    } catch (e) { /* injection failed: inline geometry on the root keeps the layer usable */ }
  }

  /** Pointer events inside the overlay must not reach the page's document-level handlers. */
  function stopEvent(ev) {
    try { if (ev && ev.stopPropagation) ev.stopPropagation(); } catch (e) { /* silent */ }
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

  function build() {
    if (root) return root;
    var el = null;
    try { el = document.createElement('div'); } catch (e) { return null; }   // no node = no controls
    root = el;
    el.setAttribute('id', LAYER_ID);
    el.setAttribute('data-sp-home', 'on');
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', ZH.home);
    el.setAttribute('style', [
      'position:fixed', 'top:0', 'right:0', 'bottom:0', 'left:0', 'inset:0',
      'z-index:' + Z_ROOT, 'overflow:hidden', 'pointer-events:none',
      'color:var(--text-hi,#f2f2f2)', '-webkit-user-select:none', 'user-select:none'
    ].join(';'));

    // ---- side column: settings / params / config / records ----
    // (v10.0: local / online / fullscreen / lobby removed; the lobby entry lives in the vendored
    //  copy's login duo, and this layer deliberately does not draw it -- upstream 0.2.1 renders its
    //  own start button here and that stays untouched.)
    var side = document.createElement('aside');
    side.className = 'title-side';
    roomEl = document.createElement('div');
    roomEl.className = 'title-room';
    var order = ['settings', 'params', 'config', 'records'];
    var labels = {
      settings: ZH.settings, params: ZH.params, config: ZH.config, records: ZH.records
    };
    for (var i = 0; i < order.length; i++) {
      var act = order[i];
      btns[act] = mkBtn(act, labels[act], 'title-room__cfg');
      roomEl.appendChild(btns[act]);
    }
    side.appendChild(roomEl);

    // ---- footer meta (v3.3/v3.5: the update button; v10.0: upstream keeps the version line) ----
    footEl = document.createElement('footer');
    footEl.className = 'title-foot';
    footEl.setAttribute('data-sp-home-foot', '');
    var meta = document.createElement('div');
    meta.className = 'title-foot__meta';
    btns.update = mkBtn('update', ZH.update, 'title-foot__update');
    btns.update.setAttribute('title', ZH.updateTitle);
    meta.appendChild(btns.update);
    footEl.appendChild(meta);

    el.appendChild(side);
    el.appendChild(footEl);
    el.addEventListener('click', stopEvent, false);
    return el;
  }

  /** Mount point: inside .app-root when there is one (page panels keep their own stacking), else
   *  body. The z-index comes from the root's inline style in both cases. */
  function ensureParent() {
    var target = null;
    try { target = qs('.app-root'); } catch (e) { target = null; }
    if (!target) target = bodyEl() || docEl();
    if (!target || !target.appendChild) return false;
    if (root.parentNode !== target) {
      try { target.appendChild(root); } catch (e) { return false; }
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

  function setDisabled(btn, dis, reason) {
    if (!btn) return;
    try { if (btn.disabled !== dis) btn.disabled = dis; } catch (e) { /* attr fallback */ }
    try {
      if (dis) {
        if (btn.getAttribute('disabled') === null) btn.setAttribute('disabled', '');
        if (reason && btn.getAttribute('title') !== reason) btn.setAttribute('title', reason);
        if (reason && btn.getAttribute('data-sp-home-why') !== reason) btn.setAttribute('data-sp-home-why', reason);
      } else {
        btn.removeAttribute('disabled');
        btn.removeAttribute('title');
        btn.removeAttribute('data-sp-home-why');
      }
    } catch (e) { /* silent */ }
  }

  /** Button state: compare before write; bridges appear late (module scripts), so recomputed each scan. */
  function setBtn(act, label, enabled, reason) {
    var b = btns[act];
    if (!b) return;
    if (b.textContent !== label) b.textContent = label;
    var dis = !enabled;
    setDisabled(b, dis, dis ? (reason || ZH.unusable) : '');
  }

  // ---- the visitors span (the ONLY write into upstream DOM: one appended span, removable) ---------

  /** Is this node inside OUR overlay? (Never append to ourselves if a selector falls through.) */
  function isOurs(el) {
    try {
      var n = el;
      while (n) { if (n === root) return true; n = n.parentNode; }
    } catch (e) { /* unreadable chain: assume not ours */ }
    return false;
  }

  /** Upstream's own status row (not our node, not something inside our overlay). */
  function upstreamConnRow() {
    var el = qs(UPSTREAM_CONN);
    if (!el || isOurs(el)) return null;
    return el;
  }

  /** Append our visitors span to the END of upstream's status row (in flow: it is a flex child, so
   *  the row's own children are never reordered or hidden). Idempotent, compare-before-write. */
  function ensureVisitors() {
    if (!visitorsEl) {
      try { visitorsEl = document.createElement('span'); } catch (e) { return false; }
      visitorsEl.setAttribute('data-sp-home-visitors', '');
      visitorsEl.setAttribute('style', VISITOR_SPAN_STYLE);
      visitorsEl.textContent = ZH.visitorDot + ZH.visitors + ' --';
      visitorsEl.style.display = 'none';
    }
    var row = upstreamConnRow();
    if (!row || !row.appendChild) return false;
    if (visitorsEl.parentNode !== row) {
      try { row.appendChild(visitorsEl); } catch (e) { return false; }
    }
    return true;
  }

  /** Take the visitors span back out of the upstream row (hide / suppress / vendored copy). */
  function detachVisitors() {
    if (!visitorsEl) return;
    try {
      if (visitorsEl.parentNode && visitorsEl.parentNode.removeChild) visitorsEl.parentNode.removeChild(visitorsEl);
    } catch (e) { /* silent */ }
  }

  // ---- paint (all writes compare-before-write) ----------------------------------------------------

  /** v5.2: the visitor count sits on the status row and only shows while the connection is online. */
  function paintVisitors() {
    if (!visitorsEl) return;
    var n = visitorsNow();
    var show = onlineNow() && typeof n === 'number' && isFinite(n);
    if (show) setTxt(visitorsEl, ZH.visitorDot + ZH.visitors + ' ' + n + ZH.people);
    try { visitorsEl.style.display = show ? '' : 'none'; } catch (e) { /* silent */ }
  }

  function paint() {
    try {
      if (!root) return;
      var pa = canPanels(), up = canUpdate();
      setBtn('settings', ZH.settings, pa, pa ? '' : ZH.whyPanel);
      setBtn('params', ZH.params, pa, pa ? '' : ZH.whyPanel);
      setBtn('config', ZH.config, pa, pa ? '' : ZH.whyPanel);
      setBtn('records', ZH.records, pa, pa ? '' : ZH.whyPanel);
      setBtn('update', ZH.update, up, up ? '' : ZH.whyUpdate);
      // v3.3 keeps a permanent title on the update button; setDisabled clears title when it enables.
      if (btns.update) setAttr(btns.update, 'title', up ? ZH.updateTitle : ZH.whyUpdate);
      ensureVisitors();
      paintVisitors();
      pullVisitors();
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
      if (w && root) { paint(); } else { detachVisitors(); }
    } catch (e) { /* silent degradation: worst case = controls not shown (upstream home intact) */ }
  }

  /** Fallback probe + repaint: hidden but the title screen reappeared -> show(); otherwise repaint. */
  function sweep() {
    try {
      if (!shown && !suppressed() && homePresent()) shown = true;   // user did not ask for upstream
      subscribeStore();                                            // __SP__ may appear after arm()
      sync();
    } catch (e) { /* silent: if this fails, do nothing */ }
  }

  function show() { shown = true; sync(); }

  function hide() { shown = false; sync(); }

  /** Are our controls mounted and shown right now? (There is no full-screen cover any more.) */
  function visible() {
    try { return !!(root && root.__spOn === true); } catch (e) { return false; }
  }

  /** Read/write suppress: true = yield and stop auto-showing; false = release. No argument = read.
   *  Only html/body attributes are honored so Java or other shell modules can flip it directly. */
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

  /** "Check update": the bridge owns everything (native dialog, or a cache-busting reload on web). */
  function clickUpdate() {
    try {
      var api = window.__SP_SHELL;
      if (api && typeof api.checkUpdate === 'function') { api.checkUpdate(); return true; }
    } catch (e) { /* silent */ }
    return false;
  }

  /** Settings (v9.0): open OUR OWN appearance panel -- font size + side padding only. We no longer
   *  re-use the upstream .title-settings gear (language / audio / quality have no entry point here). */
  function clickSettings() {
    return openPanel('appearance');
  }

  /** Panels: the layer never hides for panels (they are .modal, z-index above us). */
  function openPanel(kind) {
    try {
      var api = window.__SP_SHELL;
      if (api && typeof api.openPanel === 'function') { api.openPanel(kind); return true; }
    } catch (e) { /* silent */ }
    return false;
  }

  /** Click the upstream start button (the page's own enter action). Skips a disabled field. */
  function clickUpstreamStart() {
    try {
      var b = qs(UPSTREAM_START);
      if (!b || typeof b.click !== 'function') return false;
      if (b.disabled === true) return false;
      if (b.getAttribute && b.getAttribute('disabled') !== null) return false;
      b.click();
      return true;
    } catch (e) { return false; }
  }

  /** Consume the one-shot autostart flag (v3.6 semantics, ported from the removed title.js patch):
   *  after a line switch reload, auto-enter once the callsign field is filled. */
  function consumeAutostart() {
    var flag = false;
    try {
      var sh = window.shell;
      flag = !!(sh && typeof sh.takeAutostart === 'function' && String(sh.takeAutostart()) === '1');
    } catch (e) { flag = false; }
    if (!flag) return;
    try {
      setTimeout(function () {
        try { if (homePresent()) clickUpstreamStart(); } catch (e) { /* manual fallback */ }
      }, AUTOSTART_DELAY_MS);
    } catch (e) { /* no timers: manual fallback */ }
  }

  function onAct(act, ev) {
    try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* silent */ }
    try {
      if (act === 'settings') { clickSettings(); return; }  // v9.0: our own appearance panel
      if (act === 'update') { clickUpdate(); return; }
      openPanel(act);                                    // params | config | records
    } catch (e) { /* silent: a broken tap does nothing (the upstream home is untouched) */ }
  }

  // ---- observers (merged callbacks, one scan per 60ms window) --------------------------------------

  function schedule() {
    if (queued) return;
    queued = 1;
    try { setTimeout(function () { queued = 0; sweep(); }, SWEEP_MS); } catch (e) { queued = 0; }
  }

  /** Subscribe to the page's own store once (connection status -> visitors visibility). Absent until
   *  main.js boots. */
  function subscribeStore() {
    if (storeBound) return;
    try {
      var sp = window.__SP__;
      var s = sp && sp.store;
      if (s && typeof s.subscribe === 'function') {
        storeBound = true;
        s.subscribe(onStore);
      }
    } catch (e) { /* no store: the visitor span keeps its last painted value */ }
  }

  function onStore() {
    try { if (shown && homePresent()) schedule(); } catch (e) { /* silent */ }
  }

  /** Sweep poll for engines without MutationObserver (and if the observer constructor throws). */
  function startFallback() {
    if (fallbackTimer) return;
    try {
      fallbackTimer = setInterval(function () { try { sweep(); } catch (e) { /* silent */ } }, FALLBACK_MS);
    } catch (e) { fallbackTimer = 0; }
  }

  function arm() {
    if (armed) return;
    armed = true;
    injectStyle();
    sweep();
    var observed = false;
    try {
      var mo = new MutationObserver(schedule);
      mo.observe(docEl() || document, { childList: true, subtree: true, characterData: true });
      observed = true;
    } catch (e) { observed = false; }
    if (!observed) startFallback();
    try {
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('online', onStore, false);
        window.addEventListener('offline', onStore, false);
      }
    } catch (e) { /* old engine: the visitor span keeps its last painted value */ }
    subscribeStore();
    consumeAutostart();
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
