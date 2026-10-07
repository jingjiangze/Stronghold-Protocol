// room-lifecycle behavior tests: node:test + vm + minimal page stubs, real logic, no deps.
//
// Covers: wiring on __SP__ (immediate and via poll) / room.closed retires the showing room /
// unseated room.state retires exactly like the page's own seat check / false positives stay
// silent (spectator, empty seats, not entered, nothing tracked) / ordering fidelity (the page's
// handler runs first and clears store.room -- the tracked code still retires) / silent failure
// (throwing retireRoom, throwing store, partial subscribe unwind) / idempotency / poll give-up /
// static contract (ES5, no network surface) / anchor survival on real trees (0.1.4 always;
// extra trees via SP_ROOM_LC_TREES for 0.2.0-dev verification).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'room-lifecycle.js'), 'utf8');

/** A room.state message the way the server sends it (seats/spectators entries may be null). */
function roomState(code, seatIds, specIds) {
  const msg = {
    t: 'room.state',
    code,
    seats: (seatIds || []).map((id) => (id ? { playerId: id } : null)),
  };
  if (specIds) msg.spectators = specIds.map((id) => ({ playerId: id }));
  return msg;
}

/** Minimal page: net (insertion-order listeners like the real net._emit), store, lobby. */
function mkPage({ me = 'P1', room = null } = {}) {
  const listeners = new Map();
  const net = {
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
  };
  const store = {
    _s: { me: { playerId: me }, room },
    get() { return this._s; },
    set(p) { Object.assign(this._s, p); },
  };
  const retired = [];
  const lobby = { retireRoom: (code) => { retired.push(code); return Promise.resolve(true); } };
  return { net, store, lobby, retired, listeners };
}

/** Evaluate the extra; polling is manual (setInterval is captured, never auto-fires). */
function run(page, { sp = true } = {}) {
  const intervals = [];
  const win = {};
  if (sp && page) win.__SP__ = { store: page.store, net: page.net };
  if (page) win.__SP_LOBBY = page.lobby;
  const sandbox = {
    window: win,
    setInterval: (fn, ms) => { intervals.push({ fn, ms, cleared: false }); return intervals.length; },
    clearInterval: (id) => { if (intervals[id - 1]) intervals[id - 1].cleared = true; },
  };
  vm.runInNewContext(SRC, sandbox, { filename: 'room-lifecycle.js' });
  return { win, intervals };
}

test('wires immediately when __SP__ is present; exports the marker and stops polling', () => {
  const page = mkPage();
  const { win, intervals } = run(page);
  assert.equal(win.__SP_ROOM_LC.version, 1, 'marker object must be exported');
  assert.equal(win.__SP_ROOM_LC.debug().wired, true, 'must subscribe right away when __SP__ exists');
  assert.equal(intervals.length, 1, 'one poll timer installed');
  assert.equal(intervals[0].ms, 150);
  assert.equal(intervals[0].cleared, true, 'poll stops once wired');
  assert.equal(page.net.count('room.closed'), 1);
  assert.equal(page.net.count('room.state'), 1);
});

test('room.closed retires the room we were showing', () => {
  const page = mkPage();
  run(page);
  page.net.emit('room.state', roomState('MWHT', ['P1']));
  page.net.emit('room.closed', { t: 'room.closed', reason: 'kicked' });
  assert.deepEqual(page.retired, ['MWHT']);
});

test('unseated room.state retires the showing room; a later room.closed does not double-retire', () => {
  const page = mkPage();
  run(page);
  page.net.emit('room.state', roomState('ABCD', ['P1', 'P2']));
  assert.deepEqual(page.retired, [], 'being seated retires nothing');
  page.net.emit('room.state', roomState('ABCD', ['P2'])); // kicked: our seat is gone
  assert.deepEqual(page.retired, ['ABCD']);
  page.net.emit('room.closed', { t: 'room.closed', reason: 'empty' });
  assert.deepEqual(page.retired, ['ABCD'], 'code is cleared after the unseat retire');
});

test('spectator: no unseat retire, room stays tracked (closed spectator room still retires)', () => {
  const page = mkPage();
  const { win } = run(page);
  page.net.emit('room.state', roomState('SPEC1', ['P2'], ['P1']));
  assert.deepEqual(page.retired, [], 'watching from a spectator seat is not an unseat moment');
  assert.equal(win.__SP_ROOM_LC.debug().lastCode, 'SPEC1', 'spectated room is tracked');
  page.net.emit('room.closed', { t: 'room.closed', reason: 'ended' });
  assert.deepEqual(page.retired, ['SPEC1']);
});

test('missing spectators field: treated as not spectating (Array.isArray guard)', () => {
  const page = mkPage();
  run(page);
  page.net.emit('room.state', roomState('NOF1', ['P1']));
  page.net.emit('room.state', roomState('NOF1', ['P2'])); // no spectators field at all
  assert.deepEqual(page.retired, ['NOF1'], 'unseated without a spectators array still retires');
});

test('empty seats: not an unseat moment (upstream seats.length guard), room still tracked', () => {
  const page = mkPage();
  const { win } = run(page);
  page.net.emit('room.state', roomState('E1', []));
  assert.deepEqual(page.retired, []);
  assert.equal(win.__SP_ROOM_LC.debug().lastCode, 'E1');
});

test('not entered (myId null): no unseat moment even without a seat of our own', () => {
  const page = mkPage({ me: null });
  run(page);
  page.net.emit('room.state', roomState('X1', ['P2']));
  assert.deepEqual(page.retired, []);
});

test('room.closed with nothing tracked retires nothing', () => {
  const page = mkPage();
  run(page);
  page.net.emit('room.closed', { t: 'room.closed', reason: 'shutdown' });
  assert.deepEqual(page.retired, []);
});

test('ordering fidelity: page handler runs first and clears store.room; tracked code still retires', () => {
  const page = mkPage();
  // The page registered its room.closed handler during boot, long before extras run: it
  // clears store.room before our handler sees the event (net walks listeners in order).
  page.net.on('room.closed', () => page.store.set({ room: null }));
  run(page);
  page.net.emit('room.state', roomState('KEEP1', ['P1']));
  page.store.set({ room: { code: 'KEEP1' } }); // page shows the room (what the patch retired)
  page.net.emit('room.closed', { t: 'room.closed', reason: 'kicked' });
  assert.deepEqual(page.retired, ['KEEP1'], 'retire must not depend on store.room still being set');
  assert.equal(page.store.get().room, null, 'the page handler really did clear the room first');
});

test('late __SP__: poll wires the module, then events flow', () => {
  const page = mkPage();
  const { win } = run(page, { sp: false });
  assert.equal(win.__SP_ROOM_LC.debug().wired, false, 'no __SP__ yet: not wired');
  assert.equal(win.__SP_ROOM_LC.debug().polling, true, 'poll is running');
  win.__SP__ = { store: page.store, net: page.net };
  win.__SP_ROOM_LC.tick();
  assert.equal(win.__SP_ROOM_LC.debug().wired, true);
  page.net.emit('room.state', roomState('LATE1', ['P1']));
  page.net.emit('room.closed', { t: 'room.closed', reason: 'empty' });
  assert.deepEqual(page.retired, ['LATE1']);
});

test('late attach seeds the tracked code from the room the page already shows', () => {
  const page = mkPage({ room: { code: 'SEED1' } }); // a room.state fired before extras loaded
  const { win } = run(page, { sp: false });
  win.__SP__ = { store: page.store, net: page.net };
  win.__SP_ROOM_LC.tick();
  page.net.emit('room.closed', { t: 'room.closed', reason: 'expired' });
  assert.deepEqual(page.retired, ['SEED1'], 'the pre-wire showing room is what gets retired');
});

test('poll gives up after 400 failed tries (interval cleared), silently', () => {
  const page = mkPage();
  const { win, intervals } = run(page, { sp: false });
  for (let i = 0; i < 401; i++) win.__SP_ROOM_LC.tick();
  assert.equal(win.__SP_ROOM_LC.debug().polling, false, 'polling stopped');
  assert.equal(intervals[0].cleared, true, 'the interval was cleared');
  assert.equal(win.__SP_ROOM_LC.debug().wired, false);
  assert.deepEqual(page.retired, []);
});

test('throwing retireRoom is swallowed (page never notices)', () => {
  const page = mkPage();
  page.lobby.retireRoom = () => { throw new Error('boom'); };
  const { win } = run(page);
  assert.doesNotThrow(() => {
    page.net.emit('room.state', roomState('BOOM1', ['P1']));
    page.net.emit('room.closed', { t: 'room.closed', reason: 'kicked' });
  });
  assert.equal(win.__SP_ROOM_LC.debug().wired, true, 'module stays alive');
});

test('throwing store.get is swallowed', () => {
  const page = mkPage();
  const { win } = run(page);
  page.store.get = () => { throw new Error('no store'); };
  assert.doesNotThrow(() => {
    page.net.emit('room.state', roomState('S1', ['P1']));
    page.net.emit('room.closed', { t: 'room.closed', reason: 'kicked' });
  });
  assert.equal(win.__SP_ROOM_LC.debug().wired, true);
});

test('missing __SP_LOBBY at fire time: silent skip, no crash', () => {
  const page = mkPage();
  const { win } = run(page);
  delete win.__SP_LOBBY;
  assert.doesNotThrow(() => {
    page.net.emit('room.state', roomState('LOBBY1', ['P1']));
    page.net.emit('room.closed', { t: 'room.closed', reason: 'kicked' });
  });
  assert.deepEqual(page.retired, []);
});

test('partial subscribe failure unwinds the first registration; retry wires cleanly once', () => {
  const page = mkPage();
  const origOn = page.net.on.bind(page.net);
  let broken = true;
  page.net.on = (type, fn) => {
    if (broken && type === 'room.state') throw new Error('net hiccup');
    return origOn(type, fn);
  };
  const { win } = run(page);
  assert.equal(win.__SP_ROOM_LC.debug().wired, false);
  assert.equal(page.net.count('room.closed'), 0, 'the room.closed listener must be undone');
  broken = false;
  win.__SP_ROOM_LC.tick();
  assert.equal(win.__SP_ROOM_LC.debug().wired, true);
  assert.equal(page.net.count('room.closed'), 1, 'no duplicate after retry');
  assert.equal(page.net.count('room.state'), 1, 'no duplicate after retry');
});

test('idempotent: a second evaluation in the same window is a no-op', () => {
  const page = mkPage();
  const { win } = run(page);
  assert.equal(page.net.count('room.closed'), 1);
  // Same window again (double injection / re-evaluated bundle): marker must win.
  const sandbox2 = {
    window: win,
    setInterval: () => 99,
    clearInterval: () => {},
  };
  vm.runInNewContext(SRC, sandbox2, { filename: 'room-lifecycle.js' });
  assert.equal(page.net.count('room.closed'), 1, 'no second subscription');
  assert.equal(page.net.count('room.state'), 1);
  page.net.emit('room.state', roomState('ID1', ['P1']));
  page.net.emit('room.closed', { t: 'room.closed', reason: 'kicked' });
  assert.deepEqual(page.retired, ['ID1'], 'retire fires exactly once per moment');
});

test('static contract: ES5 syntax only', () => {
  const code = stripComments(SRC);
  assert.ok(!code.includes('=>'), 'no arrow functions');
  assert.ok(!/\b(let|const)\b/.test(code), 'no let/const');
  assert.ok(!code.includes('`'), 'no template literals');
  assert.ok(!/\bclass\b/.test(code), 'no classes');
});

test('static contract: no network / navigation surface of its own', () => {
  const code = stripComments(SRC);
  assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|EventSource|location|history|document)\b/.test(code),
    'cleanup goes through __SP_LOBBY.retireRoom; the module itself must stay passive');
  assert.ok(code.includes('window.__SP_ROOM_LC'), 'idempotency marker present');
  assert.ok(code.includes("window.__SP_LOBBY"), 'retirement goes through the lobby module');
});

test('anchor survival: this repo tree (0.1.4) exposes __SP__ on globalThis', () => {
  const mainJs = fs.readFileSync(path.resolve(here, '..', '..', 'public', 'js', 'main.js'), 'utf8');
  assert.ok(mainJs.includes('globalThis.__SP__ = { store, net'), '0.1.4 main.js must expose __SP__');
  assert.ok(mainJs.includes("net.on('room.closed'"), '0.1.4 main.js registers room.closed on net');
});

test('anchor survival: extra trees via SP_ROOM_LC_TREES (0.2.0-dev verification)', () => {
  const raw = process.env.SP_ROOM_LC_TREES || '';
  const trees = raw.split(';').map((s) => s.trim()).filter(Boolean);
  if (!trees.length) return; // default CI run: nothing extra to verify
  for (const tree of trees) {
    const mainJs = resolveMainJs(tree);
    if (!mainJs) continue; // path not present on this machine: skip silently
    const src = fs.readFileSync(mainJs, 'utf8');
    assert.ok(src.includes('globalThis.__SP__ = { store, net'), `${mainJs}: __SP__ exposure missing`);
    assert.ok(src.includes("net.on('room.closed'"), `${mainJs}: room.closed registration missing`);
  }
});

/** Strip comments so static checks see code only (the file has no regex/string surprises). */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

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
