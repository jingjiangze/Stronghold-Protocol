/* global window */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so window is declared here
// home-layer.js -- RETIRED (owner call, 2026-10-09): the home carries NO overlay of ours any more.
//
// WHAT THIS FILE IS NOW
//   Owner: "the home overlays are all gone -- keep only the one floating window". The re-apk home is
//   the UPSTREAM title screen plus our floating window (that window lives in a separate module and is
//   not part of this file). So this file draws nothing, writes no DOM node and touches no upstream
//   node: it only keeps the inert globals other modules already depend on (see KEPT below).
//   It is deliberately left in the tree because shell-bridge.js loads it BY NAME ('/__sp/home-layer.js')
//   and the test suite references that same name; the loader and the name contract stay untouched.
//
// WHAT WAS REMOVED HERE (this revision)
//   - the side button group (.title-side / .title-room / .title-room__cfg: settings / params /
//     config) and the CSS it injected
//   - the footer update button (.title-foot / .title-foot__meta / .title-foot__update)
//   - the visitors span appended into upstream's own .title-conn row (our only upstream-DOM write)
//   - the one-shot autostart consumption (window.shell.takeAutostart) -- owner: "no auto-enter"
//   - the helper that clicked upstream's own start button (only the autostart path called it)
//   The same controls were ALSO drawn by our vendored title screen (the extras title-screen copy that
//   overrides the upstream file at the same path, which is the normal case) -- so they were removed
//   there too, otherwise the home would still show them. The removal here alone was not enough.
//
// KEPT (external contracts only; none of them draws UI):
//   - window.__SP_HOME_LAYER        : idempotence guard shell-bridge.js checks before injecting again.
//   - window.__SP_HOME_LAYER_SWEEP  : a hook notice-board.js still calls after a notice change.
//   - window.__SP_HOME              : the show/hide/visible/suppress/sweep surface, kept as inert
//                                     stubs so any caller (Java back key, other shell modules,
//                                     debugging) keeps resolving; every call is a no-op.
//
// DISCIPLINE: ES5 only (floor Chromium 80: no arrow functions, no block-scoped declarations, no
// template literals, no optional chaining), pure ASCII source (Chinese text would be \uXXXX escapes;
// there is none here), no imports, no network, no DOM access at all.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.__SP_HOME_LAYER) return;                  // idempotence: repeated injection is a no-op
  window.__SP_HOME_LAYER = 1;

  function noop() {}                                   // show() / hide(): nothing is drawn, so nothing toggles
  function notVisible() { return false; }              // visible(): our controls never exist any more
  function readSuppress() { return false; }            // suppress(): never suppressed (there is no layer)
  function sweep() {}                                  // sweep(): kept for callers, does nothing

  var api = {
    show: noop,
    hide: noop,
    visible: notVisible,
    suppress: readSuppress,
    sweep: sweep
  };
  try { window.__SP_HOME = api; } catch (e) { /* read-only window (extreme sandbox): nothing to install */ }
  try { window.__SP_HOME_LAYER_SWEEP = sweep; } catch (e) { /* same */ }
})();
