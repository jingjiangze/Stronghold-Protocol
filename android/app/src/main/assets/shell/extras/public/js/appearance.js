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
// Persistence prefers window.__SP_DATA (player-data v1), which survives across origins. Its
// recordSettings() is a FULL-snapshot writer: sanitizeSettingsBlob() fills bgm/sfx/muted/quality with
// defaults, so writing a bare {fontScale, sidePad} would clobber the player's audio settings in the
// mirror. There is no getter, so we read the current blob via exportJSON() and merge before writing.
// A localStorage copy (sp.appearance) is kept as a fallback and as a tie-breaker by timestamp, for the
// case where __SP_DATA is absent (older shell / not loaded yet) or its write silently failed.
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
    var a = writeData(snap);
    var b = writeLS(snap);
    return a || b;
  }

  // ---- apply --------------------------------------------------------------------------------------

  /** CSS reproducing the deleted patch lane, using the same variables.
   *  html font-size: the v4.7 floor (20px) with the --sp-font-scale multiplier; svh line second so it
   *  wins where supported, exactly like css/theme.css.
   *  --sa-l / --sa-r: the final patched values (left reserves only the pad; right adds the right
   *  safe-area inset on top of the pad). */
  function cssFor(v) {
    return ':root{--sp-font-scale:' + v.fontScale + ';--sp-side-pad:' + v.sidePad + 'px;}'
      + 'html{'
      + 'font-size:clamp(20px,min(calc(100vw / 19.2),calc(100vh / 10.8)) * var(--sp-font-scale,1),240px);'
      + 'font-size:clamp(20px,min(calc(100vw / 19.2),calc(100svh / 10.8)) * var(--sp-font-scale,1),240px);'
      + '}'
      + ':root{'
      + '--sa-l:var(--sp-side-pad,0px);'
      + '--sa-r:calc(env(safe-area-inset-right,0px) + var(--sp-side-pad,0px));'
      + '}';
  }

  function styleEl() {
    try { return document.getElementById ? document.getElementById(STYLE_ID) : null; } catch (e) { return null; }
  }

  /** Inject/refresh the single style tag; at shell defaults the tag is removed entirely so the
   *  overlay is a strict no-op when the player has not changed anything. */
  function apply() {
    try {
      var st = styleEl();
      if (current.fontScale === DEFAULT_FONT && current.sidePad === DEFAULT_PAD) {
        if (st && st.parentNode) st.parentNode.removeChild(st);
        return true;
      }
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
