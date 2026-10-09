// home-layer removal guard (2026-10-09): the owner removed EVERY home overlay -- "the home overlays
// are all gone, keep only the one floating window". home-layer.js therefore draws nothing any more:
// it is an inert shell. The file stays in the tree because shell-bridge.js loads it BY NAME
// ('/__sp/home-layer.js') and this suite references that same name, so the loader and the name
// contract are untouched.
//
// This is a tripwire, not a behaviour test. It asserts the removal is COMPLETE (no control markers,
// no DOM access, no timers, no network) AND that the globals other modules still rely on survive:
//   - window.__SP_HOME_LAYER        : shell-bridge.js checks it before injecting the layer again.
//   - window.__SP_HOME_LAYER_SWEEP  : notice-board.js calls this hook after a notice change.
//   - window.__SP_HOME              : the show/hide/visible/suppress/sweep surface, now inert.
// A stray re-introduction of the old overlay (side group / footer update / visitors span / autostart)
// goes red here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'home-layer.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-bridge.js'), 'utf8');

/** Strip comments so marker checks run against CODE only (the header legitimately names what was removed). */
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** A document stand-in that THROWS on every read: the retired layer must not touch the DOM at all. */
function hostileDocument() {
  return new Proxy({}, {
    get(_t, prop) { throw new Error('the retired home layer touched document.' + String(prop)); },
  });
}

/** Timers that throw: the retired layer must not schedule anything. */
function hostileTimers() {
  return {
    setTimeout() { throw new Error('the retired layer scheduled a timeout'); },
    setInterval() { throw new Error('the retired layer scheduled an interval'); },
    clearTimeout() { throw new Error('the retired layer cleared a timeout'); },
    clearInterval() { throw new Error('the retired layer cleared an interval'); },
  };
}

/** Run the shell into a fresh window. A throwing document/timer surface proves it draws nothing. */
function run(win) {
  const sandbox = Object.assign({ window: win || {} }, hostileTimers());
  sandbox.document = hostileDocument();
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(SRC, sandbox, { filename: 'home-layer.js' });
  return sandbox.window;
}

test('the retired shell exists and documents the owner call', () => {
  assert.ok(fs.existsSync(path.join(here, 'extras', 'public', 'js', 'home-layer.js')),
    'home-layer.js must stay (shell-bridge.js loads it by name)');
  assert.ok(SRC.includes('RETIRED (owner call, 2026-10-09)'), 'the header must record the owner call');
  assert.ok(SRC.includes('keep only the one floating window'), 'the header must state the outcome');
});

test('loads without touching the DOM and without scheduling timers', () => {
  const win = {};
  assert.doesNotThrow(() => run(win), 'the shell must not touch document / timers');
  assert.equal(win.__SP_HOME_LAYER, 1, 'the loader idempotence guard must be set');
});

test('external contracts survive: __SP_HOME_LAYER / __SP_HOME_LAYER_SWEEP / __SP_HOME', () => {
  const win = run({});
  assert.equal(win.__SP_HOME_LAYER, 1, 'shell-bridge.js checks this before injecting again');
  assert.equal(typeof win.__SP_HOME_LAYER_SWEEP, 'function', 'notice-board.js calls this hook');
  const api = win.__SP_HOME;
  assert.ok(api, 'window.__SP_HOME must still resolve (Java back key / other modules / debugging)');
  for (const k of ['show', 'hide', 'visible', 'suppress', 'sweep']) {
    assert.equal(typeof api[k], 'function', '__SP_HOME.' + k + ' must stay callable');
  }
});

test('the API is inert: visible() false, suppress() false, show/hide/sweep are no-ops', () => {
  const win = run({});
  assert.equal(win.__SP_HOME.visible(), false, 'there is no layer, so nothing is ever visible');
  assert.equal(win.__SP_HOME.suppress(), false, 'nothing to suppress');
  assert.equal(win.__SP_HOME.suppress(true), false, 'suppress(on) is inert too');
  assert.doesNotThrow(() => {
    win.__SP_HOME.show(); win.__SP_HOME.hide(); win.__SP_HOME.sweep(); win.__SP_HOME_LAYER_SWEEP();
  });
  assert.equal(win.__SP_HOME.visible(), false, 'still invisible after show()');
});

test('idempotence: a second injection is a no-op (guard holds, API unchanged)', () => {
  const win = {};
  run(win);
  const api = win.__SP_HOME;
  run(win);
  assert.equal(win.__SP_HOME_LAYER, 1, 'guard stays 1');
  assert.equal(win.__SP_HOME, api, 'the API object is not rebuilt on re-injection');
});

test('no control markers or DOM machinery remain in the code', () => {
  const code = codeOnly(SRC);
  const gone = [
    ['data-sp-home-btn', 'the side-group / footer button marker'],
    ['data-sp-home-visitors', 'the visitors-span marker'],
    ['data-sp-home-version', 'the old version-label marker'],
    ['data-sp-home-mask', 'the old upstream-masking marker'],
    ['title-side', 'the side column'],
    ['title-room', 'the side button group'],
    ['title-foot__update', 'the footer update button'],
    ['title-foot__meta', 'the footer meta wrapper'],
    ['takeAutostart', 'the one-shot autostart consumer'],
    ['MutationObserver', 'the DOM observer'],
    ['querySelector', 'any DOM query'],
    ['createElement', 'any DOM node creation'],
    ['addEventListener', 'any listener'],
    ['appendChild', 'any DOM write'],
    ['openPanel', 'the shell-panel bridge call'],
    ['checkUpdate', 'the update bridge call'],
    ['visitorsCached', 'the visitors read'],
    ['fetchVisitors', 'the visitors request'],
    ['setInterval', 'any poll'],
  ];
  for (const [needle, what] of gone) {
    assert.equal(code.includes(needle), false, 'removed but still present: ' + what + ' (' + JSON.stringify(needle) + ')');
  }
});

test('source invariants: ES5 / pure ASCII / no imports / no network / no credentials', () => {
  assert.ok(!/import\s*\(/.test(SRC), 'no dynamic import');
  assert.ok(!/\bfrom\s+['"]/.test(SRC), 'no static import');
  assert.ok(SRC.indexOf('/js/') < 0 && SRC.indexOf('/vendor/') < 0 && SRC.indexOf('/js/ui/') < 0, 'no page-module paths');
  assert.ok(!/https?:\/\//.test(SRC), 'no URL literal');
  assert.ok(!/fetch\s*\(|XMLHttpRequest|WebSocket|EventSource/.test(SRC), 'no network entry point');
  assert.ok(SRC.indexOf('?.') < 0, 'no optional chaining');
  assert.ok(SRC.indexOf('??') < 0, 'no nullish coalescing');
  assert.ok(SRC.indexOf('=>') < 0, 'no arrow functions');
  assert.ok(SRC.indexOf('`') < 0, 'no template literals');
  assert.ok(!/\b(let|const)\s+[A-Za-z_$]/.test(SRC), 'no let/const declarations');
  assert.ok(!/(^|[^\w.])class\s+[A-Za-z_$]/.test(SRC), 'no class declarations');
  assert.ok(/^[\x00-\x7F]*$/.test(SRC), 'pure ASCII source');
  assert.ok(SRC.indexOf('replaceAll') < 0, 'no replaceAll');
  assert.ok(SRC.indexOf('password') < 0 && SRC.indexOf('token') < 0 && SRC.indexOf('secret') < 0,
    'no credential literals');
});

test('loader contract: shell-bridge.js still injects /__sp/home-layer.js behind its guard', () => {
  const at = BRIDGE.indexOf('v6.1: 首页覆盖层');
  assert.ok(at > 0, 'shell-bridge.js must keep the loader block');
  const block = BRIDGE.slice(at);
  assert.ok(block.indexOf("'/__sp/home-layer.js'") > 0, 'must still load from the shell prefix');
  assert.ok(block.indexOf('window.__SP_HOME_LAYER') > 0, 'must still guard on __SP_HOME_LAYER');
  assert.ok(!/src = ['"][^'"]*\/js\//.test(block), 'never from the page script path');
  const iHook = BRIDGE.indexOf("'/__sp/room-hook.js'");
  assert.ok(iHook > 0 && at > iHook, 'the home layer still follows the room hook');
});
