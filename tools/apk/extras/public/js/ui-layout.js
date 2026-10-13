/* global window, document */
// ui-layout.js -- the shell's own UI-LAYOUT layer: move / resize a fixed set of upstream HUD containers,
// persisted across origins, applied as ONE <style> tag.
//
// WHY A FIXED SET OF SEVEN: the battlefield, its units, Spine models, health bars and effects live inside
// PIXI / three.js canvases (public/js/render/**). They have no DOM node to measure or lay out, so an editor
// can only draw them as one read-only placeholder. The containers below ARE DOM -- absolute-positioned
// boxes in public/css/screens/game.css -- and are the things a player actually wants to move.
//
// HARD LIMITS (each one is an audit finding; do not "improve" them away):
//   * NEVER touch `.gm__hud` itself. Its inset consumes --sa-l / --sa-r, which appearance.js owns (the
//     side-pad slider). Overriding the parent makes the two features cancel each other out.
//   * NEVER write inline styles on upstream nodes. The HUD is Preact-rendered (screens/game.js) and six
//     state classes (gm--<mode>, is-pen, is-collapsed, has-sp, has-readywhy, is-dragging) flip on their
//     own; anything written into style="" is wiped by the next render.
//   * Store REM, never px. The upstream HUD is rem-based (508 rem values in game.css, 19 of them
//     max(<rem>, <px>) floors) and the root font size follows appearance.js fontScale and the viewport,
//     so a px snapshot goes stale the moment either changes.
//   * `.ticker` already carries `transform: translateX(-50%)` (its own centring). A bare translate()
//     would wipe that, so its base transform is kept and ours is appended.
//
// Values are per-selector { dx, dy, w, h } in rem; absent / null = untouched. The style tag emits only
// what actually differs from upstream, so a player who never opens the editor is a strict no-op.
//
// Contract: ES5 only (floor Chromium 80), pure ASCII, idempotent (window.__SP_UI_LAYOUT guard), no
// imports, no network. Degrades silently when there is no DOM (tests / old engines).
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.__SP_UI_LAYOUT) return;

  var STYLE_ID = 'sp-ui-layout';
  var LS_KEY = 'sp.ui.layout';
  var SCHEMA = 1;

  /** The editable containers, in the order the editor lists them. Selectors only -- no ids, no nth-child:
   *  these are the stable class names check-upstream-contract.mjs now pins (a rename there fails CI
   *  loudly instead of silently dropping a container out of the editor). */
  var EDITABLE = [
    { sel: '.gtop', label: '顶部栏 TOP' },
    { sel: '.gm__bonds', label: '羁绊条 BONDS' },
    { sel: '.team', label: '队伍 TEAM' },
    { sel: '.gm__effects', label: '效果 EFFECTS' },
    { sel: '.gm__corner', label: '角落控件 CORNER' },
    { sel: '.shopbar', label: '商店栏 SHOP' },
    { sel: '.ticker', label: '播报 TICKER' }
  ];

  /** Drawn but NOT editable: the battlefield is a canvas (PIXI + three.js), there is no box to move. */
  var READONLY = [{ sel: '.gm__field', label: '战场（canvas，不可布局）' }];

  /** Base transforms upstream already applies -- ours is appended, never substituted. */
  var BASE_TRANSFORM = { '.ticker': 'translateX(-50%)' };

  var current = { v: SCHEMA, rem: 0, items: {} };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function doc() {
    try { return typeof document === 'undefined' ? null : document; } catch (e) { return null; }
  }

  /** The live root font size in px -- every stored value is divided by this on save and multiplied on
   *  apply, which is what makes one layout survive fontScale changes and different viewports. */
  function rootPx() {
    var d = doc();
    if (!d) return 0;
    try {
      var cs = window.getComputedStyle(d.documentElement);
      var n = parseFloat(cs && cs.fontSize);
      return isNum(n) && n > 0 ? n : 0;
    } catch (e) { return 0; }
  }

  // ---- persistence (shell-prefs first: localStorage is per-origin and switching servers loses it) ----
  function readLS() {
    try {
      var raw = window.localStorage ? window.localStorage.getItem(LS_KEY) : null;
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeLS(snap) {
    try { if (window.localStorage) window.localStorage.setItem(LS_KEY, JSON.stringify(snap)); } catch (e) { /* quota / private */ }
  }

  function normalize(raw) {
    var out = { v: SCHEMA, rem: 0, items: {} };
    if (!isObj(raw)) return out;
    out.rem = isNum(raw.rem) ? raw.rem : 0;
    var items = isObj(raw.items) ? raw.items : {};
    for (var i = 0; i < EDITABLE.length; i++) {
      var sel = EDITABLE[i].sel;
      var it = items[sel];
      if (!isObj(it)) continue;
      var keep = {};
      if (isNum(it.dx)) keep.dx = it.dx;
      if (isNum(it.dy)) keep.dy = it.dy;
      if (isNum(it.w)) keep.w = it.w;
      if (isNum(it.h)) keep.h = it.h;
      // A selector we do not own must never survive a round-trip: it could only have come from a
      // hand-edited vault, and emitting it would let the vault inject arbitrary CSS selectors.
      if (keep.dx !== undefined || keep.dy !== undefined || keep.w !== undefined || keep.h !== undefined) out.items[sel] = keep;
    }
    return out;
  }

  function load() {
    var snap = null;
    try {
      if (window.__SP_PREFS && typeof window.__SP_PREFS.get === 'function') snap = window.__SP_PREFS.get('ui.layout');
    } catch (e) { snap = null; }
    if (snap === null || snap === undefined) snap = readLS();
    current = normalize(snap);
    return current;
  }

  function persist() {
    var snap = { v: SCHEMA, rem: rootPx() || current.rem || 0, items: current.items };
    var ok = false;
    try {
      if (window.__SP_PREFS && typeof window.__SP_PREFS.set === 'function') ok = !!window.__SP_PREFS.set('ui.layout', snap);
    } catch (e) { ok = false; }
    if (!ok) writeLS(snap);
    current = snap;
    return snap;
  }

  // ---- CSS -----------------------------------------------------------------------------------------
  /** One rule per touched selector. Only the keys the player actually changed are emitted, so an
   *  untouched container keeps upstream's own anchoring (which is what makes "reset" a real no-op). */
  function cssFor(snap) {
    var out = [];
    var items = (snap && snap.items) || {};
    for (var i = 0; i < EDITABLE.length; i++) {
      var sel = EDITABLE[i].sel;
      var it = items[sel];
      if (!isObj(it)) continue;
      var decl = [];
      var base = BASE_TRANSFORM[sel] || '';
      if (isNum(it.dx) || isNum(it.dy)) {
        var tr = 'translate(' + (isNum(it.dx) ? it.dx : 0) + 'rem,' + (isNum(it.dy) ? it.dy : 0) + 'rem)';
        decl.push('transform:' + (base ? base + ' ' : '') + tr + ' !important');
      }
      // Resizing writes width/height only. Which edge moves is decided by upstream's own anchoring
      // (a right-anchored box grows leftwards) -- predictable, and it never fights the layout model.
      if (isNum(it.w)) decl.push('width:' + it.w + 'rem !important');
      if (isNum(it.h)) decl.push('height:' + it.h + 'rem !important');
      if (decl.length) out.push(sel + '{' + decl.join(';') + '}');
    }
    return out.join('');
  }

  function styleEl() {
    var d = doc();
    if (!d || typeof d.getElementById !== 'function') return null;
    try { return d.getElementById(STYLE_ID); } catch (e) { return null; }
  }

  /** Inject / refresh the single style tag. Always injected (even when empty) so the tag's presence is a
   *  stable fact for the editor; empty content is the no-op. */
  function apply() {
    var d = doc();
    if (!d) return false;
    try {
      var st = styleEl();
      if (!st) {
        if (typeof d.createElement !== 'function') return false;
        st = d.createElement('style');
        st.setAttribute('id', STYLE_ID);
        var host = d.head || d.documentElement || d.body;
        if (!host || typeof host.appendChild !== 'function') return false;
        host.appendChild(st);
      }
      st.textContent = cssFor(current);
      return true;
    } catch (e) { return false; }
  }

  // ---- measuring (what the canvas draws) ------------------------------------------------------------
  /** The viewport the canvas is drawn in: CSS px + DPR, plus the root font size the rem values are
   *  relative to. Read fresh every call -- never cached (the camera/HUD move and DPR can change). */
  function viewport() {
    var d = doc();
    var w = 0, h = 0, dpr = 1;
    try { w = window.innerWidth || 0; h = window.innerHeight || 0; } catch (e) { w = 0; h = 0; }
    try { dpr = window.devicePixelRatio || 1; } catch (e) { dpr = 1; }
    if (d && d.documentElement) {
      try {
        if (!w) w = d.documentElement.clientWidth || 0;
        if (!h) h = d.documentElement.clientHeight || 0;
      } catch (e) { /* keep what we have */ }
    }
    return { w: w, h: h, dpr: dpr, rootPx: rootPx() };
  }

  /** One box in rem, relative to the viewport's top-left. null when the node is not on screen. */
  function boxOf(sel, root) {
    var d = doc();
    if (!d || typeof d.querySelector !== 'function') return null;
    var el = null;
    try { el = d.querySelector(sel); } catch (e) { el = null; }
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    var r = null;
    try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
    if (!r) return null;
    var u = root > 0 ? root : 1;
    return {
      x: r.left / u, y: r.top / u,
      w: (r.width || (r.right - r.left)) / u,
      h: (r.height || (r.bottom - r.top)) / u
    };
  }

  /** Everything the canvas needs: the viewport, plus one entry per container (editable flag included).
   *  Containers that are not in the DOM right now come back with box: null -- the editor says so instead
   *  of drawing a box at 0,0. */
  function measure() {
    var vp = viewport();
    var items = [];
    var i, b;
    for (i = 0; i < EDITABLE.length; i++) {
      b = boxOf(EDITABLE[i].sel, vp.rootPx);
      items.push({ sel: EDITABLE[i].sel, label: EDITABLE[i].label, editable: true, box: b, stored: current.items[EDITABLE[i].sel] || null });
    }
    for (i = 0; i < READONLY.length; i++) {
      b = boxOf(READONLY[i].sel, vp.rootPx);
      items.push({ sel: READONLY[i].sel, label: READONLY[i].label, editable: false, box: b, stored: null });
    }
    return { vp: vp, items: items };
  }

  // ---- public API ----------------------------------------------------------------------------------
  function get() { return { v: SCHEMA, rem: current.rem, items: JSON.parse(JSON.stringify(current.items)) }; }

  /** Set one container's values. `patch` keys are dx/dy/w/h; null clears a key (back to upstream). */
  function set(sel, patch) {
    var known = false;
    for (var i = 0; i < EDITABLE.length; i++) if (EDITABLE[i].sel === sel) known = true;
    if (!known || !isObj(patch)) return false;
    var it = current.items[sel] ? current.items[sel] : {};
    for (var k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      if (k !== 'dx' && k !== 'dy' && k !== 'w' && k !== 'h') continue;
      if (patch[k] === null) delete it[k];
      else if (isNum(patch[k])) it[k] = patch[k];
    }
    if (it.dx === undefined && it.dy === undefined && it.w === undefined && it.h === undefined) delete current.items[sel];
    else current.items[sel] = it;
    persist();
    apply();
    return true;
  }

  /** Back to upstream for every container (and drop the stored snapshot). */
  function reset() {
    current = { v: SCHEMA, rem: rootPx() || 0, items: {} };
    var ok = false;
    try {
      if (window.__SP_PREFS && typeof window.__SP_PREFS.remove === 'function') ok = !!window.__SP_PREFS.remove('ui.layout');
    } catch (e) { ok = false; }
    if (!ok) { try { if (window.localStorage) window.localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ } }
    apply();
    return true;
  }

  try {
    load();
    apply();
    window.__SP_UI_LAYOUT = {
      SCHEMA: SCHEMA,
      EDITABLE: EDITABLE,
      READONLY: READONLY,
      BASE_TRANSFORM: BASE_TRANSFORM,
      available: true,
      get: get,
      set: set,
      reset: reset,
      apply: apply,
      measure: measure,
      viewport: viewport,
      rootPx: rootPx,
      // pure helpers, exported for the tests (the file has no module system)
      _cssFor: cssFor,
      _normalize: normalize
    };
  } catch (e) { /* read-only window: nothing to install */ }
})();
