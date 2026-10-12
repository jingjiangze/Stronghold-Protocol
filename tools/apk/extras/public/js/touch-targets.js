/* global window, document */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here
// touch-targets.js -- in-match corner controls and emote bubbles grown for real fingers (hot-update overlay).
//
// Loaded by shell-bridge.js from '/__sp/touch-targets.js' (the shell's own prefix: MainActivity.serveShellAsset
// reads the filesDir hot tree first, then the APK -- never the network), guarded by the idempotence marker
// window.__SP_TOUCH_TARGETS. It injects exactly one <style id="sp-touch-targets"> tag and nothing else.
//
// WHY (2026-10-12, audited against the Paper-Yuan 0.2.4 APK):
//   devices.css already gives every small control an invisible >=44px hit area (::before, centred) and grows
//   some controls on short touch screens. Two gaps remained, both visible in that fork's devices.css:
//
//   1. The four bottom-left buttons (chat / settings / guide / fullscreen) stay at .56rem (~22px at 1rem=40px)
//      on phones. Their hit areas are padded out to 44px, but the VISUAL target is still 22px, so players aim
//      at a small glyph and the invisible padding is what actually catches the tap -- which is also why a tap
//      near the edge lands on a neighbour.
//   2. The emote bubble (.ebubble) keeps its desktop type size on a phone, where 1rem is clamped to 40px: the
//      emote name is unreadable in motion.
//
// WHAT THIS FILE DOES, and what it deliberately does NOT:
//   * It grows the corner buttons and the bubble type INSIDE a coarse-pointer + narrow-viewport media query,
//     so a desktop browser, a tablet with a mouse, and any fine pointer are byte-for-byte unchanged.
//   * It does NOT touch --tap-min or the generic ::before hit-area rule. Those already satisfy 44px, and
//     growing them further would start overlapping neighbours -- the exact bug devices.css documents for the
//     shop cards (its invisible area covered half of the card's confirm strip).
//   * It does NOT leave .gm__corner's width behind. devices.css derives the corner's wrap width from the
//     button size (calc(3 * .56rem + .2rem)) and pairs each width with a .dpanel offset so the left-docked
//     detail card clears the corner. Growing the button without updating that pair would put the card back
//     over the buttons, so the width and the .dpanel offset are recomputed here with the SAME formula.
//
// Measure basis: on a phone 1rem is clamped to 40px (css/theme.css), so .82rem = 32.8px and .44rem = 17.6px
// -- the same button-to-icon ratio devices.css uses for its own .56rem / .28rem step.
//
// ES5, IIFE, pure ASCII. Any failure degrades silently (no tag = the upstream layout, exactly as before).
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__SP_TOUCH_TARGETS) return; // idempotent

  var STYLE_ID = 'sp-touch-targets';

  // Every rule sits inside the same "phone" condition devices.css uses for the corner, and none of them
  // escapes it: on a fine pointer or a >=768px viewport this file contributes nothing at all.
  var CSS = ''
    + '@media (max-width: 767px) and (pointer: coarse), (max-width: 767px) and (any-pointer: coarse) {'
    // The buttons grow; the icon keeps its half-the-button proportion instead of staying a 22px glyph
    // inside a 33px frame (devices.css section 3 does the same for the .56rem step).
    + '.gm__corner > .gm__gear, .gm__corner > .ewheel__btn, .gm__corner > .fsbtn {'
    + 'width: .82rem !important; height: .82rem !important; padding: 0 !important;'
    + '}'
    + '.gm__corner > .gm__gear > .icon, .gm__corner > .ewheel__btn > .icon, .gm__corner > .fsbtn > .icon {'
    + 'width: .44rem !important; height: .44rem !important;'
    + '}'
    // Recompute the corner's wrap width from the grown size (devices.css: calc(3 * <button> + .2rem)),
    // and move the left-docked detail card up by exactly the growth so it keeps clearing the corner.
    + '.gm__corner { width: max(96px, calc(3 * .82rem + .2rem)) !important; }'
    + '.dpanel:not(.dpanel--right) { bottom: calc(.44rem + max(1.51rem, 96px) * 55 / 151 + .82rem) !important; }'
    // The bubble: bigger type and a wider cap, still inside the field (its own max-width keeps it from
    // running off the edge). px floors so a very small rem never shrinks it back below legibility.
    + '.ebubble {'
    + 'font-size: max(.18rem, 15px) !important;'
    + 'padding: .09rem .20rem .09rem .26rem !important;'
    + 'max-width: 4.8rem !important;'
    + '}'
    + '.ebubble__icon { width: .78rem !important; height: .80rem !important; }'
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
  window.__SP_TOUCH_TARGETS = { version: 1, css: CSS, apply: apply };
})();
