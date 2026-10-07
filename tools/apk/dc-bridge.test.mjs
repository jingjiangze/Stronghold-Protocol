// dc-bridge tests: the real shipped file is executed in a vm with minimal stubs.
//
//   node --test tools/apk/dc-bridge.test.mjs
//
// Contract under test (zero-patch line): the shell publishes window.__SP_DC_INPUT inline into every
// HTML response (MainActivity dcInjectScript) because there is no index.html anchor any more, and
// dc-bridge must resolve that config LAZILY — the loader appends the script tags, so which of the two
// runs first depends on load order. Covered: a plain page is untouched / a shell page installs the
// shim even before any config exists / the config is read at first socket construction (bridged) and
// still falls through to the native WebSocket for non-/ws URLs and for a missing config / the ?dc=1
// web bootstrap installs without a shell / the legacy __SP_DC alias / ES5 + ASCII source invariants.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'dc-bridge.js'), 'utf8');

const CFG = { enabled: true, room: 'AB12', directory: 'https://dir.example', stun: ['stun:stun.example:3478'] };

// ---------------------------------------------------------------- fixtures

function mkWorld(opts = {}) {
  const native = [];
  function NativeWS(url) {
    native.push(url);
    this.url = url;
    this.isNative = true;
    this.readyState = 0;
  }
  const win = { WebSocket: NativeWS };
  if (opts.shell) win.shell = {};
  if (opts.cfg !== undefined) win.__SP_DC_INPUT = opts.cfg;

  function FakePC() {
    this.iceGatheringState = 'complete';
    this.createDataChannel = () => ({ readyState: 'connecting', send() {}, close() {} });
    // reject immediately: the signalling loop is then abandoned through the module's own catch,
    // so the test never waits on timers or fetch
    this.createOffer = () => Promise.reject(new Error('no offer in test'));
    this.setLocalDescription = () => Promise.resolve();
    this.setRemoteDescription = () => Promise.resolve();
    this.close = () => {};
  }

  const sandbox = {
    window: win,
    location: { search: opts.search || '' },
    URLSearchParams,
    RTCPeerConnection: FakePC,
    Promise,
    console,
    setTimeout,
    clearInterval,
    setInterval,
    fetch: () => Promise.reject(new Error('no network in test')),
  };
  return {
    win, native, sandbox,
    run: () => vm.runInNewContext(SRC, sandbox, { filename: 'dc-bridge.js' }),
  };
}

// ---------------------------------------------------------------- cases

test('a plain page (no shell, no config, no ?dc=1) is left completely untouched', () => {
  const w = mkWorld();
  const before = w.win.WebSocket;
  w.run();
  assert.equal(w.win.WebSocket, before, 'window.WebSocket must not be replaced');
  assert.equal(w.win.__SP_DC_ACTIVE, undefined, 'the shim must not announce itself');
});

test('a shell page installs the shim even when the config has not been published yet', () => {
  const w = mkWorld({ shell: true });
  w.run();
  assert.equal(w.win.__SP_DC_ACTIVE, true, 'the shell page must install the shim (load order is not guaranteed)');
  const sock = new w.win.WebSocket('wss://host/ws');
  assert.equal(sock.isNative, true, 'without a config a /ws socket must fall through to the native WebSocket');
});

test('the config is read at first socket construction (lazy), so injection order cannot kill it', () => {
  const w = mkWorld({ shell: true });
  w.run(); // config arrives only AFTER the shim installed
  w.win.__SP_DC_INPUT = CFG;
  const bridged = new w.win.WebSocket('wss://host/ws');
  assert.notEqual(bridged.isNative, true, 'a /ws socket with a live config must be bridged');
  assert.equal(bridged.url, 'wss://host/ws');
  assert.equal(typeof bridged.send, 'function');
  const other = new w.win.WebSocket('https://api.example/x');
  assert.equal(other.isNative, true, 'a non-WebSocket URL must keep native behavior');
});

test('the config present at load time bridges /ws but leaves other URLs native', () => {
  const w = mkWorld({ cfg: CFG });
  w.run();
  assert.equal(w.win.__SP_DC_ACTIVE, true, 'a config alone (web bootstrap) is enough to install');
  assert.notEqual(new w.win.WebSocket('wss://host/ws').isNative, true);
  assert.equal(new w.win.WebSocket('wss://host/ws?v=1').isNative, undefined,
    'a query string on the /ws path still counts as the game socket');
  assert.equal(new w.win.WebSocket('wss://host/signal').isNative, true, 'only the /ws endpoint is bridged');
});

test('the ?dc=1 web bootstrap installs without a shell', () => {
  const w = mkWorld({ search: '?dc=1&room=AB12&dir=https%3A%2F%2Fdir.example' });
  w.run();
  assert.equal(w.win.__SP_DC_ACTIVE, true, '?dc=1 must install the shim on a plain page');
  assert.notEqual(new w.win.WebSocket('wss://host/ws').isNative, true);
});

test('the legacy __SP_DC alias is still honored', () => {
  const w = mkWorld({ shell: true });
  w.run();
  w.win.__SP_DC = CFG;
  assert.notEqual(new w.win.WebSocket('wss://host/ws').isNative, true);
});

test('an incomplete config never bridges', () => {
  const w = mkWorld({ shell: true });
  w.run();
  for (const bad of [{ enabled: true, room: 'AB12' }, { enabled: false, room: 'AB12', directory: 'https://d' }, {}]) {
    w.win.__SP_DC_INPUT = bad;
    assert.equal(new w.win.WebSocket('wss://host/ws').isNative, true,
      `an incomplete config must fall through: ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------- source invariants

test('source invariants: ES5, no module system, no cross-layer dependency', () => {
  assert.equal(/=>|\bconst\b|\blet\b|\bclass\b/.test(SRC), false, 'must stay ES5 (old WebView)');
  assert.equal(/\bimport\s|\brequire\s*\(/.test(SRC), false, 'no module system');
  assert.equal(/shell-bridge|home-layer|skin-layer/.test(SRC), false, 'no cross-layer dependency');
});
