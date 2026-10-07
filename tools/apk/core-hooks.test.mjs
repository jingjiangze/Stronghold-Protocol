// core-hooks behavior tests: node:test + vm + minimal page stubs, real logic, no deps.
//
// Covers: missing __SP__ stays silent / wiring on __SP__ (immediate and via poll) with exactly one
// registration per channel / idempotency (a second injection never stacks) / recordRoom incl. the
// page's own seat-check profile (unseated, spectator, not-entered, empty seats) / recordResult with
// the v3.4+v4.10 ctx (roomCode, mode, meId) / the v3.0 room-sighting edge (new room object only) /
// per-item kill switches / __SP_BACK branches (overlay, title, in-match confirm, room+lobby,
// degraded fallbacks) / silent failure on throwing page objects / partial-subscribe unwind /
// static contract (ES5 + ASCII + no error handlers of its own) / __SP__ anchor survival on the
// 0.1.4 and 0.2.0 trees (missing trees are skipped and reported).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'core-hooks.js'), 'utf8');

const flush = () => new Promise((r) => setImmediate(r));

/** Minimal page: net (insertion-order listeners like the real net._emit), store, __SP_DATA stub. */
function mkPage(opts = {}) {
  const listeners = new Map();
  const net = {
    requests: [],
    on(type, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
      const arr = listeners.get(type);
      return () => {
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    emit(type, msg) {
      for (const fn of (listeners.get(type) || []).slice()) fn(msg);
    },
    count(type) { return (listeners.get(type) || []).length; },
    request(name, payload) {
      this.requests.push({ name, payload });
      return Promise.resolve({});
    },
  };
  const subs = new Set();
  function notify(s, prev) {
    for (const fn of [...subs]) fn(s, prev);
  }
  const store = {
    _s: {
      me: { playerId: opts.me === undefined ? 'P1' : opts.me },
      session: opts.session || { entered: false },
      room: opts.room || null,
      match: opts.match || { public: null },
    },
    get() { return this._s; },
    set(p) {
      const prev = this._s;
      const next = typeof p === 'function' ? p(prev) : p;
      this._s = Object.assign({}, prev, next);
      notify(this._s, prev);
    },
    patch(key, value) {
      const prev = this._s;
      const cur = prev[key];
      const next = Object.assign({}, cur && typeof cur === 'object' ? cur : {}, value);
      this._s = Object.assign({}, prev, { [key]: next });
      notify(this._s, prev);
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    count() { return subs.size; },
  };
  const recorded = { rooms: [], results: [], observed: [], profile: null, loadout: null };
  const data = {
    recordRoom(r) { recorded.rooms.push(r); },
    recordResult(r, ctx) { recorded.results.push({ r, ctx }); },
    recordProfile(name) { recorded.profile = { name }; },
    recordLoadout(entries) { recorded.loadout = entries; },
  };
  return { net, store, data, recorded, subs };
}

/** Evaluate the extra; polling is manual (setInterval is captured, never auto-fires). */
function run(page, { sp = true, off = null, importer = null, doc = null, confirm = null, shell = null, seed = null } = {}) {
  const intervals = [];
  const win = {};
  if (page) {
    if (sp) win.__SP__ = { store: page.store, net: page.net, data: {}, version: 1 };
    win.__SP_DATA = page.data;
  }
  if (off) win.__SP_CORE_HOOKS_OFF = off;
  if (importer) win.__SP_CORE_HOOKS_IMPORT = importer;
  if (shell) win.__SP_SHELL = shell;
  if (confirm) win.confirm = confirm;
  const kv = new Map(Object.entries(seed || {}));
  const localStorage = {
    getItem: (k) => (kv.has(k) ? kv.get(k) : null),
    setItem: (k, v) => { kv.set(k, String(v)); },
    removeItem: (k) => { kv.delete(k); },
  };
  win.localStorage = localStorage;
  if (page) page.localStorage = localStorage;
  const sandbox = {
    window: win,
    document: doc === null ? { querySelector: () => null } : doc,
    setInterval: (fn, ms) => { intervals.push({ fn, ms, cleared: false }); return intervals.length; },
    clearInterval: (id) => { if (intervals[id - 1]) intervals[id - 1].cleared = true; },
  };
  vm.runInNewContext(SRC, sandbox, { filename: 'core-hooks.js' });
  return { win, intervals };
}

/** A components.js stub: records calls, confirm resolves through the returned controller. */
function mkUi() {
  const state = { closed: 0, confirmOpts: [], resolveConfirm: null };
  const mod = {
    closeAllDialogs() { state.closed += 1; },
    confirmDialog(opts) {
      state.confirmOpts.push(opts);
      return new Promise((res) => { state.resolveConfirm = res; });
    },
  };
  return { state, importer: () => Promise.resolve(mod) };
}

// ---- boot / wiring ------------------------------------------------------------------------------

/** vm 里的对象原型与宿主不同：比较前统一成宿主对象（同 lobby-own-report.test.mjs 的做法）。 */
const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

test('missing __SP__: silent no-op, keeps polling, installs nothing', () => {
  const { win, intervals } = run(null);
  assert.equal(win.__SP_CORE_HOOKS.version, 1, 'marker must exist for idempotency');
  assert.equal(win.__SP_CORE_HOOKS.debug().wired, false);
  assert.equal(win.__SP_CORE_HOOKS.debug().polling, true);
  assert.equal(win.__SP_BACK, undefined, 'no __SP_BACK without the page instances');
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 150);
});

test('wires immediately when __SP__ is present: one registration per channel, poll stops', () => {
  const page = mkPage();
  const { win, intervals } = run(page);
  assert.equal(win.__SP_CORE_HOOKS.debug().wired, true);
  assert.equal(page.net.count('room.state'), 1);
  assert.equal(page.net.count('m.result'), 1);
  assert.equal(page.store.count(), 1);
  assert.equal(typeof win.__SP_BACK, 'function');
  assert.equal(intervals[0].cleared, true, 'poll stops once wired');
});

test('idempotent: a second evaluation in the same window is a no-op', () => {
  const page = mkPage();
  const { win } = run(page);
  assert.equal(page.net.count('room.state'), 1);
  vm.runInNewContext(SRC, { window: win, document: { querySelector: () => null } }, { filename: 'core-hooks.js' });
  assert.equal(page.net.count('room.state'), 1, 'no second subscription');
  assert.equal(page.net.count('m.result'), 1);
  assert.equal(page.store.count(), 1);
});

test('late __SP__: the poll wires the module, then events flow', () => {
  const page = mkPage();
  const { win, intervals } = run(page, { sp: false });
  assert.equal(win.__SP_CORE_HOOKS.debug().wired, false);
  win.__SP__ = { store: page.store, net: page.net, data: {}, version: 1 };
  win.__SP_CORE_HOOKS.tick();
  assert.equal(win.__SP_CORE_HOOKS.debug().wired, true);
  assert.equal(intervals[0].cleared, true);
  page.net.emit('room.state', { t: 'room.state', code: 'LATE1', seats: [{ playerId: 'P1' }] });
  assert.equal(page.recorded.rooms.length, 1);
});

test('poll gives up after 400 failed tries (interval cleared), silently', () => {
  const { win, intervals } = run(null);
  for (let i = 0; i < 401; i++) win.__SP_CORE_HOOKS.tick();
  assert.equal(win.__SP_CORE_HOOKS.debug().polling, false);
  assert.equal(intervals[0].cleared, true);
  assert.equal(win.__SP_CORE_HOOKS.debug().wired, false);
});

// ---- hook 1: room.state -> recordRoom (settings-v3.4) --------------------------------------------

test('room.state feeds __SP_DATA.recordRoom with the transport fields stripped', () => {
  const page = mkPage();
  run(page);
  page.net.emit('room.state', { t: 'room.state', rid: 12, code: 'MWHT', mode: 'coop', seats: [{ playerId: 'P1' }] });
  assert.equal(page.recorded.rooms.length, 1);
  assert.deepEqual(plain(page.recorded.rooms[0]), { code: 'MWHT', mode: 'coop', seats: [{ playerId: 'P1' }] });
});

test('room.state that unseats us is NOT recorded (the patch sat behind the page seat check)', () => {
  const page = mkPage();
  run(page);
  page.net.emit('room.state', { t: 'room.state', code: 'KICK', seats: [{ playerId: 'P2' }] });
  assert.deepEqual(plain(page.recorded.rooms), []);
});

test('spectator / not-entered / empty seats: all recorded like the page predicate', () => {
  const page = mkPage();
  run(page);
  page.net.emit('room.state', { t: 'room.state', code: 'SPEC1', seats: [{ playerId: 'P2' }], spectators: [{ playerId: 'P1' }] });
  assert.equal(page.recorded.rooms.length, 1, 'spectating is not an unseat moment');
  page.net.emit('room.state', { t: 'room.state', code: 'EMPTY', seats: [] });
  assert.equal(page.recorded.rooms.length, 2, 'empty seats pass the seats.length guard');
  page.store._s.me = { playerId: null };
  page.net.emit('room.state', { t: 'room.state', code: 'NOID', seats: [{ playerId: 'P2' }] });
  assert.equal(page.recorded.rooms.length, 3, 'myId null is never an unseat moment');
});

// ---- hooks 2+3: m.result -> recordResult (settings-v3.4 + v4.10) ---------------------------------

test('m.result feeds __SP_DATA.recordResult with roomCode/mode/meId', () => {
  const page = mkPage();
  page.store._s.room = { code: 'MWHT', mode: 'coop' };
  run(page);
  const msg = { t: 'm.result', rid: 9, victory: true, durationMs: 1234, players: [{ playerId: 'P1' }] };
  page.net.emit('m.result', msg);
  assert.equal(page.recorded.results.length, 1);
  assert.deepEqual(plain(page.recorded.results[0].r), { victory: true, durationMs: 1234, players: [{ playerId: 'P1' }] });
  assert.equal(page.recorded.results[0].ctx.roomCode, 'MWHT');
  assert.equal(page.recorded.results[0].ctx.mode, 'coop');
  assert.equal(page.recorded.results[0].ctx.meId, 'P1');
});

test('m.result mode falls back to match.public.mode/modeId when there is no room', () => {
  const page = mkPage({ match: { public: { modeId: 'HARD' } } });
  run(page);
  page.net.emit('m.result', { t: 'm.result', victory: false });
  assert.equal(page.recorded.results[0].ctx.mode, 'HARD');
  assert.equal(page.recorded.results[0].ctx.roomCode, undefined);
  page.store._s.match = { public: { mode: 'FUNNY', modeId: 'HARD' } };
  page.net.emit('m.result', { t: 'm.result', victory: false });
  assert.equal(page.recorded.results[1].ctx.mode, 'FUNNY', 'mode wins over modeId');
});

// ---- hook 4: room sighting -> __SP_OBSERVE_ROOM (settings-v3.0) ----------------------------------

test('observe: a new room object is reported once; a re-notified same object is not', () => {
  const page = mkPage();
  const { win } = run(page);
  win.__SP_OBSERVE_ROOM = (room) => page.recorded.observed.push(room.code);
  page.store.set({ room: { code: 'ABCD' } });
  assert.deepEqual(plain(page.recorded.observed), ['ABCD']);
  page.store.set({ clock: { offset: 1 } }); // unrelated key: same room object -> no new sighting
  assert.deepEqual(plain(page.recorded.observed), ['ABCD'], 'edge, not level');
  page.store.set({ room: { code: 'ABCD' } }); // a fresh room.state object
  assert.deepEqual(plain(page.recorded.observed), ['ABCD', 'ABCD']);
});

test('observe: no room / no code / missing global are all silent', () => {
  const page = mkPage();
  const { win } = run(page);
  win.__SP_OBSERVE_ROOM = (room) => page.recorded.observed.push(room.code);
  page.store.set({ room: { mode: 'coop' } });
  page.store.set({ room: null });
  delete win.__SP_OBSERVE_ROOM;
  page.store.set({ room: { code: 'GONE' } });
  assert.deepEqual(plain(page.recorded.observed), []);
});

// ---- kill switches -------------------------------------------------------------------------------

test('kill switches: each hook can be disabled live', () => {
  const page = mkPage();
  const { win } = run(page, { off: { recordRoom: true, recordResult: true, observeRoom: true, back: true } });
  win.__SP_OBSERVE_ROOM = (room) => page.recorded.observed.push(room.code);
  page.store._s.room = { code: 'MWHT', mode: 'coop' };
  page.net.emit('room.state', { t: 'room.state', code: 'MWHT', seats: [{ playerId: 'P1' }] });
  page.net.emit('m.result', { t: 'm.result', victory: true });
  page.store.set({ room: { code: 'MWHT' } });
  assert.deepEqual(plain(page.recorded.rooms), []);
  assert.deepEqual(plain(page.recorded.results), []);
  assert.deepEqual(plain(page.recorded.observed), []);
  assert.equal(win.__SP_BACK(), false, 'back hook disabled -> hand the key to the system');
  delete win.__SP_CORE_HOOKS_OFF;
  page.net.emit('m.result', { t: 'm.result', victory: true });
  assert.equal(page.recorded.results.length, 1, 're-enabled without re-injection');
});

// ---- hook 5: __SP_BACK (settings-v5.4) -----------------------------------------------------------

test('__SP_BACK: an overlay is closed first (closeAllDialogs + shell openPanel(null))', async () => {
  const page = mkPage();
  const ui = mkUi();
  const panels = [];
  const { win } = run(page, {
    importer: ui.importer,
    doc: { querySelector: (sel) => (sel === '.modal' ? { nodeType: 1 } : null) },
    shell: { openPanel: (name) => panels.push(name) },
  });
  await flush(); // let the warmed components.js land
  assert.equal(win.__SP_BACK(), true, 'the page consumed the back key');
  assert.equal(ui.state.closed, 1);
  assert.deepEqual(plain(panels), [null]);
  assert.deepEqual(plain(page.net.requests), [], 'closing an overlay never leaves the room');
});

test('__SP_BACK: title screen hands the key to the system', () => {
  const page = mkPage({ session: { entered: false } });
  const { win } = run(page);
  assert.equal(win.__SP_BACK(), false);
  assert.deepEqual(plain(page.net.requests), []);
});

test('__SP_BACK: in a match asks for confirmation; OK leaves for home, the key is consumed either way', async () => {
  const page = mkPage({ session: { entered: true }, match: { public: { phase: 'BATTLE' } } });
  const ui = mkUi();
  const { win } = run(page, { importer: ui.importer });
  await flush();
  assert.equal(win.__SP_BACK(), true, 'consumed before the answer arrives');
  assert.equal(ui.state.confirmOpts.length, 1);
  assert.equal(ui.state.confirmOpts[0].title, '退出对局');
  assert.deepEqual(plain(page.net.requests), [], 'not left yet');
  ui.state.resolveConfirm(true);
  await flush();
  assert.deepEqual(plain(page.net.requests), [{ name: 'room.leave', payload: {} }]);
  assert.equal(page.store.get().room, null);
  assert.equal(page.store.get().match.public, null);
  assert.equal(page.store.get().session.entered, false);
});

test('__SP_BACK: cancel in a match changes nothing', async () => {
  const page = mkPage({ session: { entered: true }, match: { public: { phase: 'BATTLE' } } });
  const ui = mkUi();
  const { win } = run(page, { importer: ui.importer });
  await flush();
  win.__SP_BACK();
  ui.state.resolveConfirm(false);
  await flush();
  assert.deepEqual(plain(page.net.requests), []);
  assert.equal(page.store.get().session.entered, true);
});

test('__SP_BACK: room / lobby leaves the alliance and goes home', () => {
  const page = mkPage({ session: { entered: true }, room: { code: 'MWHT', mode: 'coop' } });
  const { win } = run(page);
  assert.equal(win.__SP_BACK(), true);
  assert.deepEqual(plain(page.net.requests), [{ name: 'room.leave', payload: {} }]);
  assert.equal(page.store.get().room, null);
  assert.equal(page.store.get().session.entered, false);
});

test('__SP_BACK: a throwing page (store / net.request) degrades to false, never throws', () => {
  const page = mkPage({ session: { entered: true }, room: { code: 'MWHT' } });
  const { win } = run(page);
  page.store.get = () => { throw new Error('boom'); };
  assert.equal(win.__SP_BACK(), false);
  page.store.get = () => ({ session: { entered: true }, room: { code: 'MWHT' } });
  page.net.request = () => { throw new Error('offline'); };
  assert.equal(win.__SP_BACK(), true, 'a dead socket still clears the local state');
  // get 上面被换成了常量桩；要验「本地状态被清掉」必须让 get 重新反映内部状态（原断言恒真，是测试 bug）。
  page.store.get = () => page.store._s;
  assert.equal(page.store.get().session.entered, false);
  assert.equal(page.store.get().room, null, 'room must be cleared too');
});

test('__SP_BACK: without __SP__ it stays uninstalled (the shell falls back to goBack)', () => {
  const { win } = run(null);
  assert.equal(win.__SP_BACK, undefined);
});

test('__SP_BACK: a native confirm is the fallback when components.js is unavailable', () => {
  const page = mkPage({ session: { entered: true }, match: { public: { phase: 'BATTLE' } } });
  const asked = [];
  const { win } = run(page, { confirm: (text) => { asked.push(text); return true; } });
  assert.equal(win.__SP_BACK(), true);
  assert.equal(asked.length, 1);
  assert.deepEqual(plain(page.net.requests), [{ name: 'room.leave', payload: {} }], 'accepted -> home');
});

// ---- failure tolerance ---------------------------------------------------------------------------

test('throwing __SP_DATA hooks are swallowed (the page never notices)', () => {
  const page = mkPage();
  run(page);
  page.data.recordRoom = () => { throw new Error('boom'); };
  page.data.recordResult = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => {
    page.net.emit('room.state', { t: 'room.state', code: 'X1', seats: [{ playerId: 'P1' }] });
    page.net.emit('m.result', { t: 'm.result', victory: true });
  });
});

test('a throwing __SP_OBSERVE_ROOM is swallowed', () => {
  const page = mkPage();
  const { win } = run(page);
  win.__SP_OBSERVE_ROOM = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => page.store.set({ room: { code: 'X1' } }));
});

test('partial subscribe failure unwinds everything; a retry wires exactly once', () => {
  const page = mkPage();
  const origOn = page.net.on.bind(page.net);
  let broken = true;
  page.net.on = (type, fn) => {
    if (broken && type === 'm.result') throw new Error('net hiccup');
    return origOn(type, fn);
  };
  const { win } = run(page);
  assert.equal(win.__SP_CORE_HOOKS.debug().wired, false);
  assert.equal(page.net.count('room.state'), 0, 'the first registration must be undone');
  assert.equal(page.store.count(), 0);
  assert.equal(win.__SP_BACK, undefined, 'no half-armed back hook');
  broken = false;
  win.__SP_CORE_HOOKS.tick();
  assert.equal(win.__SP_CORE_HOOKS.debug().wired, true);
  assert.equal(page.net.count('room.state'), 1, 'no duplicate after retry');
  assert.equal(page.net.count('m.result'), 1);
  assert.equal(page.store.count(), 1);
  assert.equal(typeof win.__SP_BACK, 'function');
});

// ---- static contract -----------------------------------------------------------------------------

test('static contract: ES5 syntax only, ASCII only, idempotency marker present', () => {
  const code = stripComments(SRC);
  assert.ok(!code.includes('=>'), 'no arrow functions');
  assert.ok(!/\b(let|const)\b/.test(code), 'no let/const');
  assert.ok(!code.includes('`'), 'no template literals');
  assert.ok(!/\bclass\b/.test(code), 'no classes');
  assert.ok(code.includes('window.__SP_CORE_HOOKS'), 'idempotency marker present');
  assert.ok(code.includes('window.__SP_CORE_HOOKS_OFF'), 'kill switches present');
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7F]/.test(SRC), 'ASCII only');
});

test('static contract: installs no error handlers and no network surface of its own', () => {
  const code = stripComments(SRC);
  assert.ok(!code.includes('addEventListener'), 'global error handlers belong to the page, not us');
  assert.ok(!/\bonerror\b/.test(code), 'no window.onerror takeover');
  assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\b/.test(code), 'no network of its own');
  assert.ok(code.includes("inst.net.request('room.leave'"), 'leaving goes through the page net instance');
});

// ---- __SP__ anchor survival on the real trees ----------------------------------------------------

/** Resolve a tree root (or a main.js file) to its main.js path; null when absent. */
function resolveMainJs(p) {
  try {
    if (fs.statSync(p).isFile()) return p;
  } catch { return null; }
  for (const candidate of [path.join(p, 'public', 'js', 'main.js'), path.join(p, 'js', 'main.js')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const TREES = (process.env.SP_CORE_HOOKS_TREES ||
  [
    path.resolve(here, '..', '..'), // this repo tree = 0.1.4 upstream (unpatched)
    'C:/Users/16891/android-build/up014-proxy', // 0.1.4 mirror
    'C:/Users/16891/android-build/_tmp-020/Stronghold-Protocol', // 0.2.0 unpack
  ].join(';'))
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

test('anchor survival: every available tree still exposes __SP__ at the end of boot()', (t) => {
  let checked = 0;
  for (const tree of TREES) {
    const mainJs = resolveMainJs(tree);
    if (!mainJs) {
      t.diagnostic(`skipped (tree not present): ${tree}`);
      continue;
    }
    const src = fs.readFileSync(mainJs, 'utf8');
    assert.ok(src.includes('globalThis.__SP__ = { store, net'), `${mainJs}: __SP__ exposure missing`);
    assert.ok(src.includes("net.on('m.result'"), `${mainJs}: m.result registration missing`);
    assert.ok(src.includes('installGlobalErrorHandlers()'), `${mainJs}: error handlers missing`);
    assert.ok(src.includes('if (s.session.entered && !prev.session.entered) schedulePendingJoin();'),
      `${mainJs}: the session.entered edge is upstream (no extras hook needed)`);
    checked += 1;
  }
  if (!checked) t.diagnostic('no tree was present: anchor survival unverified on this machine');
  assert.ok(checked >= 1, 'at least the repo tree must be present');
});

/** Strip comments so static checks see code only. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

// ---- hooks 6+7: localStorage mirrors (settings-v3.4 的 net.js / loadoutSync 两条) ------------------

test('storage mirror: the stored name feeds recordProfile on wire (net.js loadName)', () => {
  const page = mkPage();
  const { win } = run(page, { seed: { 'sp.name': 'Doctor' } });
  assert.deepEqual(plain(page.recorded.profile), { name: 'Doctor' });
  assert.equal(typeof win.__SP_BACK, 'function');
});

test('storage mirror: a later setItem re-captures the name (net.js saveName)', () => {
  const page = mkPage();
  run(page, { seed: {} });
  page.localStorage.setItem('sp.name', 'Amiya');
  assert.deepEqual(plain(page.recorded.profile), { name: 'Amiya' });
});

test('storage mirror: the stored loadout feeds recordLoadout, and writes re-capture it', () => {
  const page = mkPage();
  run(page, { seed: { 'sp.pref.loadout': JSON.stringify({ v: 1, entries: { c1: { skill: 2 } } }) } });
  assert.deepEqual(plain(page.recorded.loadout), { c1: { skill: 2 } });
  page.localStorage.setItem('sp.pref.loadout', JSON.stringify({ v: 1, entries: { c2: { skill: 1 } } }));
  assert.deepEqual(plain(page.recorded.loadout), { c2: { skill: 1 } });
});

test('storage mirror: a broken blob / empty storage never throws and never records junk', () => {
  const page = mkPage();
  run(page, { seed: { 'sp.pref.loadout': '{not json' } });
  assert.deepEqual(plain(page.recorded.loadout), null);
  page.localStorage.setItem('sp.name', '');
  assert.deepEqual(plain(page.recorded.profile), null);
});

test('storage mirror: kill switches work live', () => {
  const page = mkPage();
  const { win } = run(page, { seed: { 'sp.name': 'Doctor' } });
  win.__SP_CORE_HOOKS_OFF = { recordProfile: true };
  page.localStorage.setItem('sp.name', 'Later');
  assert.deepEqual(plain(page.recorded.profile), { name: 'Doctor' });
});
