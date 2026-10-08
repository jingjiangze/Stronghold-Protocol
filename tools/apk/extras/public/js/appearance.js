/* global window, document */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here
// appearance.js -- shell-side appearance switch (hot-update overlay, replaces the settings patch lane).
//
// // The upstream settings patches used to add the UI-scale (fontScale) and side-padding (sidePad) rows to the
// game's settings screen and applied them through two CSS custom properties:
//   --sp-font-scale : multiplier on the root rem scale   (css/theme.css, html { font-size: ... })
//   --sp-side-pad   : extra left/right inset             (css/devices.css, --sa-l / --sa-r)
// Those patches are being removed. This file reproduces the same look at runtime, with the SAME
// variables, by injecting a single <style id="sp-appearance"> tag -- and nothing else.
//
// API (window.__SP_APPEARANCE):
//   get()   -> { fontScale, sidePad }
//   set({ fontScale?, sidePad? })  -> applies immediately, persists, returns the new state
//   reset() -> back to shell defaults (fontScale 1, sidePad 0) and drops the injected style
//
// Persistence: v8.0 uses the unified shell-prefs namespace (window.__SP_PREFS -> player-v1 doc.prefs,
// cross-origin). shell-prefs.js runs before this file and has already merged the vault with this
// origin's cache and the legacy doc.settings blob, so a single get/set here is enough. When
// __SP_PREFS is absent (old content tree) the legacy path stands byte-for-byte: a localStorage copy
// (sp.appearance) plus the player-data settings blob (window.__SP_DATA.recordSettings, a
// FULL-snapshot writer -- read-modify-write keeps the player's audio settings intact).
//
// ES5, IIFE, idempotent (window.__SP_APPEARANCE marker). Any failure degrades silently.
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__SP_APPEARANCE) return; // idempotent

  var STYLE_ID = 'sp-appearance';
  var LS_KEY = 'sp.appearance';
  var FONT_MIN = 0.85, FONT_MAX = 1.5;
  var PAD_MIN = 0, PAD_MAX = 40;
  var DEFAULT_FONT = 1, DEFAULT_PAD = 0;

  var current = { fontScale: DEFAULT_FONT, sidePad: DEFAULT_PAD };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function normFont(v) { return isNum(v) ? clampNum(v, FONT_MIN, FONT_MAX) : null; }
  function normPad(v) { return isNum(v) ? clampNum(v, PAD_MIN, PAD_MAX) : null; }

  // ---- persistence --------------------------------------------------------------------------------

  /** The current doc.settings blob, or null when __SP_DATA is absent / unreadable. */
  function readData() {
    try {
      var D = window.__SP_DATA;
      if (!D || typeof D.exportJSON !== 'function') return null;
      var doc = JSON.parse(D.exportJSON());
      var s = doc && doc.settings;
      return s && typeof s === 'object' ? s : null;
    } catch (e) { return null; }
  }

  /** Merge fontScale/sidePad into the existing settings snapshot (never clobber other fields). */
  function writeData(snap) {
    try {
      var D = window.__SP_DATA;
      if (!D || typeof D.recordSettings !== 'function') return false;
      var base = readData() || {};
      var merged = {};
      for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) merged[k] = base[k];
      merged.fontScale = snap.fontScale;
      merged.sidePad = snap.sidePad;
      D.recordSettings(merged); // recordSettings stamps .ts itself
      return true;
    } catch (e) { return false; }
  }

  function readLS() {
    try {
      var raw = window.localStorage ? window.localStorage.getItem(LS_KEY) : null;
      if (!raw) return null;
      var o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : null;
    } catch (e) { return null; }
  }

  function writeLS(snap) {
    try {
      if (!window.localStorage) return false;
      window.localStorage.setItem(LS_KEY, JSON.stringify({
        fontScale: snap.fontScale, sidePad: snap.sidePad, ts: Date.now(),
      }));
      return true;
    } catch (e) { return false; }
  }

  function tsOf(o) { return o && isNum(o.ts) ? o.ts : -1; }

  /** Newest of the two stores wins; __SP_DATA wins ties (it is the cross-origin source of truth). */
  function load() {
    // v8.0: the unified shell-prefs namespace (cross-origin vault) when present -- shell-prefs.js has
    // already resolved the vault / this origin's cache / the legacy doc.settings blob by timestamp.
    try {
      if (window.__SP_PREFS && typeof window.__SP_PREFS.get === 'function') {
        var pv = window.__SP_PREFS.get('appearance');
        if (pv && typeof pv === 'object') {
          var u = { fontScale: DEFAULT_FONT, sidePad: DEFAULT_PAD };
          var uf = normFont(pv.fontScale), up = normPad(pv.sidePad);
          if (uf !== null) u.fontScale = uf;
          if (up !== null) u.sidePad = up;
          return u;
        }
      }
    } catch (e) { /* fall through to the legacy stores */ }
    var dataS = readData();
    var lsS = readLS();
    var dTs = tsOf(dataS), lTs = tsOf(lsS);
    var src = null;
    if (dTs >= 0 && lTs >= 0) src = lTs > dTs ? lsS : dataS;
    else if (dTs >= 0) src = dataS;
    else if (lTs >= 0) src = lsS;
    var out = { fontScale: DEFAULT_FONT, sidePad: DEFAULT_PAD };
    if (src) {
      var f = normFont(src.fontScale), p = normPad(src.sidePad);
      if (f !== null) out.fontScale = f;
      if (p !== null) out.sidePad = p;
    }
    return out;
  }

  function persist() {
    var snap = { fontScale: current.fontScale, sidePad: current.sidePad };
    // v8.0: write through the unified namespace (vault + local cache) when present.
    try {
      if (window.__SP_PREFS && typeof window.__SP_PREFS.set === 'function') {
        window.__SP_PREFS.set('appearance', snap);
        return true;
      }
    } catch (e) { /* fall through to the legacy stores */ }
    var a = writeData(snap);
    var b = writeLS(snap);
    return a || b;
  }

  // ---- apply --------------------------------------------------------------------------------------

  /** CSS reproducing the deleted patch lane, using the same variables.
   *  html font-size: **upstream's own rule** (css/theme.css:118/121 -- floor 40px, cap 240px) with every
   *  endpoint multiplied by --sp-font-scale; svh line second so it wins where supported, as upstream does.
   *
   *  v8.1: the multiplier used to sit only on the *middle* term with a flat 20px floor, which made every
   *  tier SMALLER than the untouched default. Upstream's root font is clamp(40px, min(vw/19.2, vh/10.8),
   *  240px), so on a 390px-wide portrait phone the middle term is 20.3px and upstream's floor lifts it to
   *  40px -- our 20px floor instead allowed it to fall to 20.3px. Picking the standard tier (scale 1) therefore
   *  halved every rem on such a screen (measured 20.3px vs 40px), which is the "font too small" report.
   *  Scaling all three endpoints keeps the tiers symmetric around the no-setting baseline: at scale 1 the
   *  rule computes exactly what upstream's does (so setting only the side padding cannot change the font),
   *  the standard tier is identical to having never opened the panel, and the bigger tiers grow from there
   *  on every viewport (40px floor -> 46/52/60px; the smallest tier -> 34px).
   *  --sa-l / --sa-r: the final patched values (left reserves only the pad; right adds the right
   *  safe-area inset on top of the pad). */
  function cssFor(v) {
    var s = 'var(--sp-font-scale,1)';
    // Root font rule is emitted ONLY when the scale really changed (v8.2). The default tier must stay
    // byte-identical to "never opened the panel": that is upstream's own clamp() in css/theme.css, and
    // emitting an equivalent rule of ours only invites cascade-order surprises.
    var fontRule = v.fontScale === DEFAULT_FONT ? '' : (
      'html{'
      + 'font-size:clamp(calc(40px * ' + s + '),min(calc(100vw / 19.2),calc(100vh / 10.8)) * ' + s + ',calc(240px * ' + s + '));'
      + 'font-size:clamp(calc(40px * ' + s + '),min(calc(100vw / 19.2),calc(100svh / 10.8)) * ' + s + ',calc(240px * ' + s + '));'
      + '}');
    // Safe-area rules are emitted UNCONDITIONALLY (v8.2) -- this is the left-black-bar fix. Upstream
    // devices.css sets --sa-l to env(safe-area-inset-left), which on a notched phone reserves a strip
    // down the left edge; pinning it to "only the pad the player asked for" is the shell's one and
    // only way to zero that out. The old apply() removed the whole style tag at defaults, so picking
    // the middle tier (which IS the default) handed the bar right back -- a bug you only got by using
    // the UI, never by leaving it alone.
    return ':root{--sp-font-scale:' + v.fontScale + ';--sp-side-pad:' + v.sidePad + 'px;}'
      + fontRule
      + ':root{'
      + '--sa-l:var(--sp-side-pad,0px);'
      + '--sa-r:calc(env(safe-area-inset-right,0px) + var(--sp-side-pad,0px));'
      + '}';
  }

  function styleEl() {
    try { return document.getElementById ? document.getElementById(STYLE_ID) : null; } catch (e) { return null; }
  }

  /** Inject/refresh the single style tag.
   *
   *  v8.2: injected even at defaults. The old code removed the tag when
   *  fontScale===1 && sidePad===0 (so an untouched player saw a strict no-op), but that handed --sa-l
   *  back to upstream's env(safe-area-inset-left) -- a black strip down the left edge on notched
   *  phones, appearing only AFTER the player touched the middle tier (audit 2026-10-09).
   *
   *  Now the font half still stays out of the way at defaults (the no-op font semantics are
   *  unchanged) while the safe-area half is always emitted (the left edge is always ours to pin).
   *  The two never interfere: they are two independent rules. */
  function apply() {
    try {
      var st = styleEl();
      if (!st) {
        st = document.createElement('style');
        st.setAttribute('id', STYLE_ID);
        (document.head || document.documentElement || document.body).appendChild(st);
      }
      st.textContent = cssFor(current);
      return true;
    } catch (e) { return false; }
  }

  // ---- public API ---------------------------------------------------------------------------------

  function get() { return { fontScale: current.fontScale, sidePad: current.sidePad }; }

  function set(patch) {
    patch = patch || {};
    var f = normFont(patch.fontScale), p = normPad(patch.sidePad);
    if (f !== null) current.fontScale = f;
    if (p !== null) current.sidePad = p;
    apply();     // session-effective even if persistence below fails
    persist();
    return get();
  }

  function reset() {
    current = { fontScale: DEFAULT_FONT, sidePad: DEFAULT_PAD };
    apply();     // removes the injected style
    persist();   // write defaults so the reset survives a reload
    return get();
  }

  try {
    var saved = load();
    current.fontScale = saved.fontScale;
    current.sidePad = saved.sidePad;
    apply();
    window.__SP_APPEARANCE = { get: get, set: set, reset: reset };
  } catch (e) { /* never break the page */ }
})();
