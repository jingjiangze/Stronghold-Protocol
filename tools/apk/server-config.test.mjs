// server-config tests: the real shipped extras file is executed in a vm with a stub window + bridge.
//
//   node --test tools/apk/server-config.test.mjs
//
// Contract under test (server-declared config, read side): the module never fetches anything itself
// and never evaluates config content; it exposes the snapshot through window.__SP_SERVER_CONFIG;
// every failure mode (no bridge, null snapshot, malformed JSON, unknown feature id, absent announce)
// degrades to "no config" instead of throwing; feature windows are respected; reload() is idempotent
// and fires onChange only on a real version change; and the source stays ES5 + pure ASCII.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Plain-data view of a value: the module runs in a vm realm, so its objects/arrays have
 *  different prototypes than the test realm's and deepStrictEqual would reject them on that alone. */
const plain = (v) => JSON.parse(JSON.stringify(v));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'server-config.js'), 'utf8');

/** Runs the module in a fresh vm context over a fake window; returns that window. */
function load({ bridge, payload } = {}) {
  const win = {};
  win.window = win;
  const listeners = [];
  win.addEventListener = (name, fn) => {
    if (name === '__SP_SERVER_CONFIG_CHANGED') listeners.push(fn);
  };
  win.__dispatch = () => listeners.forEach((f) => f({}));
  if (bridge) win.shell = bridge;
  if (payload !== undefined) {
    win.shell = Object.assign({}, bridge || {}, { serverConfig: () => payload });
  }
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'server-config.js' });
  return win;
}

// ---------------------------------------------------------------- fixtures

const FULL = JSON.stringify({
  schema: 1,
  serverId: 'example',
  version: 12,
  ttl: 300,
  announce: { title: '服务器公告', body: '今晚开放新模式', level: 'warn' },
  matchmaking: { enabled: true, endpoint: '/api/match', modes: ['NORMAL', 'HARD'], partySize: 4, queueTimeoutSec: 90 },
  features: [
    { id: 'newModeA', enabled: true, mode: 'config' },
    { id: 'eventB', enabled: true, mode: 'config', startAt: 1000000, endAt: 2000000 },
    { id: 'packC', enabled: true, mode: 'pack' },
  ],
  featurePacks: [{ id: 'match-v2', version: 3 }],
  client: { minShellApi: 1 },
});

// ---------------------------------------------------------------- tests

test('exposes the snapshot through window.__SP_SERVER_CONFIG', () => {
  const w = load({ payload: FULL });
  const api = w.__SP_SERVER_CONFIG;
  assert.ok(api && api.__spReady, 'API installed with its idempotence marker');
  assert.equal(api.version(), 12);
  assert.equal(api.serverId(), 'example');
  assert.equal(api.get().schema, 1);
});

test('announce: normalised, and absent/disabled -> null', () => {
  const w = load({ payload: FULL });
  assert.deepEqual(plain(w.__SP_SERVER_CONFIG.announce()),
    { title: '服务器公告', body: '今晚开放新模式', level: 'warn' });

  const none = load({ payload: JSON.stringify({ schema: 1, version: 1 }) });
  assert.equal(none.__SP_SERVER_CONFIG.announce(), null);

  const empty = load({ payload: JSON.stringify({ schema: 1, announce: { title: '', body: '' } }) });
  assert.equal(empty.__SP_SERVER_CONFIG.announce(), null);

  const noLevel = load({ payload: JSON.stringify({ schema: 1, announce: { body: 'x' } }) });
  assert.equal(noLevel.__SP_SERVER_CONFIG.announce().level, 'info', 'level defaults to info');
});

test('matchmaking: defaults and values', () => {
  const w = load({ payload: FULL });
  const m = w.__SP_SERVER_CONFIG.matchmaking();
  assert.equal(m.enabled, true);
  assert.equal(m.endpoint, '/api/match');
  assert.deepEqual(plain(m.modes), ['NORMAL', 'HARD']);
  assert.equal(m.partySize, 4);
  assert.equal(m.queueTimeoutSec, 90);

  const none = load({ payload: JSON.stringify({ schema: 1 }) });
  assert.equal(none.__SP_SERVER_CONFIG.matchmaking(), null);

  // A partially-populated block still yields usable defaults (the server may only set the switch).
  const partial = load({ payload: JSON.stringify({ schema: 1, matchmaking: { enabled: true } }) });
  const p = partial.__SP_SERVER_CONFIG.matchmaking();
  assert.equal(p.endpoint, '/api/match');
  assert.equal(p.partySize, 4);
  assert.equal(p.queueTimeoutSec, 60);
});

test('feature(): returns the entry, unknown id -> null', () => {
  const w = load({ payload: FULL });
  const api = w.__SP_SERVER_CONFIG;
  assert.equal(api.feature('newModeA').enabled, true);
  assert.equal(api.feature('packC').mode, 'pack');
  assert.equal(api.feature('totallyUnknown'), null, 'unknown feature is ignored safely');
  assert.equal(api.feature(''), null);
  assert.equal(api.feature(null), null);
});

test('enabled(): honours the flag and the activity window', () => {
  const w = load({ payload: FULL });
  const api = w.__SP_SERVER_CONFIG;
  // Patch the clock INSIDE the vm realm: the module reads its own Date, not the test realm's.
  const at = (ms) => vm.runInContext(`Date.now = function () { return ${ms}; };`, w);
  at(500000);                                   // before eventB starts
  assert.equal(api.enabled('newModeA'), true);
  assert.equal(api.enabled('eventB'), false, 'window not started');
  at(1500000);                                  // inside the window
  assert.equal(api.enabled('eventB'), true);
  at(3000000);                                  // after it ended
  assert.equal(api.enabled('eventB'), false, 'window ended');
  assert.equal(api.enabled('totallyUnknown'), false);
  // exactly on the boundaries the window is inclusive
  at(1000000);
  assert.equal(api.enabled('eventB'), true, 'start boundary inclusive');
  at(2000000);
  assert.equal(api.enabled('eventB'), true, 'end boundary inclusive');
  at(2000001);
  assert.equal(api.enabled('eventB'), false, 'one ms past the end');
});

test('packs(): trusted feature-pack references are exposed as data', () => {
  const w = load({ payload: FULL });
  assert.deepEqual(plain(w.__SP_SERVER_CONFIG.packs()), [{ id: 'match-v2', version: 3 }]);
  const none = load({ payload: JSON.stringify({ schema: 1 }) });
  assert.deepEqual(plain(none.__SP_SERVER_CONFIG.packs()), []);
});

test('no bridge -> empty config, nothing throws', () => {
  const w = load({});
  const api = w.__SP_SERVER_CONFIG;
  assert.deepEqual(plain(api.get()), {});
  assert.equal(api.version(), 0);
  assert.equal(api.serverId(), '');
  assert.equal(api.announce(), null);
  assert.equal(api.matchmaking(), null);
  assert.equal(api.feature('x'), null);
  assert.equal(api.enabled('x'), false);
  assert.deepEqual(plain(api.packs()), []);
  assert.equal(api.refresh(), false, 'refresh reports "unsupported" rather than throwing');
});

test('malformed / hostile bridge payloads degrade to "no config"', () => {
  // Anything that is not a JSON object is "no config" (never a bogus value, never a throw).
  for (const payload of ['', 'null', 'not json', '{', '[]', '[1,2]', '"str"', '42', 'true', null, undefined]) {
    const w = load({ payload });
    assert.deepEqual(plain(w.__SP_SERVER_CONFIG.get()), {}, `payload ${JSON.stringify(payload)} -> {}`);
    assert.equal(w.__SP_SERVER_CONFIG.version(), 0);
    assert.equal(w.__SP_SERVER_CONFIG.announce(), null);
    assert.equal(w.__SP_SERVER_CONFIG.matchmaking(), null);
    assert.equal(w.__SP_SERVER_CONFIG.serverId(), '');
    assert.deepEqual(plain(w.__SP_SERVER_CONFIG.packs()), []);
  }
});

test('wrong-typed fields are coerced by the accessors, never thrown', () => {
  // The read side is a VIEW, not a validator: ServerConfig.parse() in Java is the single place that
  // rejects bad configs. A well-formed object with wrong-typed fields must therefore still be safe
  // to read -- every accessor coerces or returns a neutral value.
  const w = load({ payload: JSON.stringify({ schema: 'x', version: 'abc', serverId: 7, announce: 'nope',
    matchmaking: 'nope', features: 'nope', featurePacks: 'nope' }) });
  const api = w.__SP_SERVER_CONFIG;
  assert.equal(api.version(), 0);
  assert.equal(api.serverId(), '');
  assert.equal(api.announce(), null);
  assert.equal(api.matchmaking(), null);
  assert.equal(api.feature('any'), null);
  assert.equal(api.enabled('any'), false);
  assert.deepEqual(plain(api.packs()), []);
});

test('a throwing bridge degrades to "no config" instead of breaking the page', () => {
  const w = load({});
  w.shell = { serverConfig: () => { throw new Error('bridge exploded'); } };
  vm.runInContext(SRC, w, { filename: 'server-config.js' });   // second load, fresh module state
  assert.deepEqual(plain(w.__SP_SERVER_CONFIG.get()), {});
});

test('refresh() calls the native bridge and reports success', () => {
  let called = 0;
  const w = load({ bridge: { serverConfig: () => FULL, serverConfigRefresh: () => { called++; } } });
  assert.equal(w.__SP_SERVER_CONFIG.refresh(), true);
  assert.equal(called, 1);
  const bare = load({ bridge: { serverConfig: () => FULL } });
  assert.equal(bare.__SP_SERVER_CONFIG.refresh(), false, 'absent refresh entry point -> false');
});

test('reload() re-reads and only notifies on a real version change', () => {
  let payload = JSON.stringify({ schema: 1, version: 1 });
  const bridge = { serverConfig: () => payload };
  const w = load({ bridge });
  const seen = [];
  w.__SP_SERVER_CONFIG.onChange((cfg) => seen.push(cfg.version));
  assert.deepEqual(seen, [], 'subscribing does not fire immediately');

  payload = JSON.stringify({ schema: 1, version: 1, serverId: 'x' });
  w.__SP_SERVER_CONFIG.reload();
  assert.deepEqual(seen, [], 'same version -> no notification');

  payload = JSON.stringify({ schema: 1, version: 2 });
  w.__SP_SERVER_CONFIG.reload();
  assert.deepEqual(seen, [2], 'version bump -> one notification');

  w.__SP_SERVER_CONFIG.reload();
  assert.deepEqual(seen, [2], 'no further change -> no further notification');
});

test('a throwing listener does not stop the others', () => {
  let payload = JSON.stringify({ schema: 1, version: 1 });
  const w = load({ bridge: { serverConfig: () => payload } });
  const seen = [];
  w.__SP_SERVER_CONFIG.onChange(() => { throw new Error('bad listener'); });
  w.__SP_SERVER_CONFIG.onChange(() => seen.push('ok'));
  payload = JSON.stringify({ schema: 1, version: 2 });
  w.__SP_SERVER_CONFIG.reload();
  assert.deepEqual(seen, ['ok']);
});

test('the change event triggers a reload', () => {
  let payload = JSON.stringify({ schema: 1, version: 1 });
  const w = load({ bridge: { serverConfig: () => payload } });
  const seen = [];
  w.__SP_SERVER_CONFIG.onChange((cfg) => seen.push(cfg.version));
  payload = JSON.stringify({ schema: 1, version: 7 });
  w.__dispatch();
  assert.deepEqual(seen, [7]);
});

test('module is idempotent (second load keeps the first API instance)', () => {
  const w = load({ payload: FULL });
  const first = w.__SP_SERVER_CONFIG;
  vm.runInContext(SRC, w, { filename: 'server-config.js' });
  assert.equal(w.__SP_SERVER_CONFIG, first, 'guard keeps the existing instance');
});

test('source invariants: ES5, pure ASCII, no module system, no fetch/eval', () => {
  assert.equal(/=>|\bconst\b|\blet\b|\bclass\b/.test(SRC), false, 'must stay ES5 (old WebView)');
  assert.equal(/[^\x00-\x7F]/.test(SRC), false, 'must be pure ASCII');
  assert.equal(/^\s*(import|export)\s/m.test(SRC), false, 'no ES modules');
  assert.equal(/XMLHttpRequest|fetch\(/.test(SRC), false, 'never fetches on its own');
  assert.equal(/\beval\s*\(|new Function/.test(SRC), false, 'never evaluates anything');
  assert.equal(/document\.createElement\(["']script/.test(SRC), false, 'never injects script tags');
});
