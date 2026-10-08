/* global window, document */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here
// screen-fixes.js -- runtime CSS for upstream screens that clip their own content (hot-update overlay).
//
// Loaded by shell-bridge.js from '/__sp/screen-fixes.js' (the shell's own prefix: MainActivity.serveShellAsset
// reads the filesDir hot tree first, then the APK -- never the network), guarded by the idempotence marker
// window.__SP_SCREEN_FIXES. It injects exactly one <style id="sp-screen-fixes"> tag and nothing else.
// Unlike appearance.js the tag is ALWAYS there: the screen it repairs is upstream's, not a shell setting.
//
// Fix 1 -- the INFO CHECK briefing (/js/screens/briefing.js + /css/screens/briefing.css)
//   .brief__left (enemy leader -> battlefield -> SPECIAL ENEMIES) is a flex column with min-height:0 but no
//   overflow, while .screen{overflow:hidden} (css/theme.css) clips whatever does not fit -- the tail of the
//   SPECIAL ENEMIES list was unreachable, with no scrolling. The right column (.brief__right) already
//   scrolls; the left one did not. Measured on the real client (local room, Chrome, deviceScaleFactor 1,
//   harness tools/pwshot/b2-flow.mjs; y of the last .brief-faction bottom vs .brief__foot top, px):
//     phone landscape 844x390, fontScale 1.0, upstream tree with its public/fonts: the tail ended 55.0 px
//       under the footer (foot top 337.2) and 2.2 px below the viewport bottom; after this rule: 59 px of
//       scroll, the tail ends at 333.2 == the column's own bottom (fully reachable).
//     same viewport without the optional font tree: 15.1 px under the footer / 37.7 px below the viewport.
//     1600x900, fontScale 1.5 (appearance.js --sp-font-scale): 418.3 px clipped (345.0-420.3 px over runs
//       -- the boss and its ability list are drawn per match); after: 431 px of scroll (= max), tail at
//       722.3 against the column's 722.5.
//     1600x900 / 1280x720, fontScale 1.0: fits (-66.8 / -51.6 px) -- the bug needs a short viewport or a
//       font scale > 1, which is exactly what the owner hit; there maxScroll stays 0 (layout unchanged).
//   The rule below gives the left column the same treatment as its right neighbour: it scrolls instead of
//   clipping. padding-right mirrors .brief__right, so the scrollbar never sits on the card border.
//
// ES5, IIFE, pure ASCII. Any failure degrades silently (no tag = the upstream screen, exactly as before).
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__SP_SCREEN_FIXES) return; // idempotent

  var STYLE_ID = 'sp-screen-fixes';

  // Scoped to that one screen's own chain (never a bare .brief__left rule): the left column scrolls.
  var CSS = '.screen.brief > .brief__main > .brief__left{'
    + 'overflow-y:auto;'
    + 'padding-right:.06rem;'
    + 'overscroll-behavior:contain;'
    + '}';

  function apply() {
    try {
      if (!document.getElementById || document.getElementById(STYLE_ID)) return true;
      var st = document.createElement('style');
      st.setAttribute('id', STYLE_ID);
      st.textContent = CSS;
      (document.head || document.documentElement || document.body).appendChild(st);
      return true;
    } catch (e) { return false; }
  }

  apply();
  window.__SP_SCREEN_FIXES = { version: 1, css: CSS, apply: apply };
})();
