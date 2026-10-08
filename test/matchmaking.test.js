// test/matchmaking.test.js — 快速匹配 (server/matchmaking.js): the queue fills one co-op room with exactly MAX_SEATS
// humans. The rules under test: exact-full only, an offer everyone must confirm, a confirmed player is never punished
// for a silent teammate, admission caps, and a queue that reports what it is doing.
// Run: node --test test/matchmaking.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, MAX_SEATS } from '../shared/constants.js';
import { Matchmaking, MATCHMAKING_DEFAULTS } from '../server/matchmaking.js';

/** A queue on a hand-driven clock with a fake transport and a fake allocator. */
function harness({ options = {}, allocate = null } = {}) {
  let now = 1_000_000;
  const sent = [];
  const calls = [];
  const sessions = new Map();
  const session = (id) => {
    if (!sessions.has(id)) sessions.set(id, { playerId: id, name: id, connected: true, roomCode: null, pendingResult: null, limitKey: null });
    return sessions.get(id);
  };
  const q = new Matchmaking({
    now: () => now,
    send: (s, msg) => sent.push([s.playerId, msg]),
    allocate: allocate || ((sessions_, difficulty) => { calls.push({ sessions: sessions_.map((s) => s.playerId), difficulty }); return { code: 'ROOM' }; }),
    available: (s) => s.connected && !s.roomCode && !s.pendingResult,
    options,
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  const lastTo = (id) => { for (let i = sent.length - 1; i >= 0; i--) if (sent[i][0] === id) return sent[i][1]; return null; };
  return {
    q, session, calls, sent, lastTo,
    advance(ms) { now += ms; },
    /** Join `n` players for one difficulty and return their sessions. */
    joinMany(n, difficulty = 'NORMAL', prefix = 'p') {
      const out = [];
      for (let i = 0; i < n; i++) { const s = session(`${prefix}_${i}`); q.join(s, { difficulty }); out.push(s); }
      return out;
    },
  };
}

test('the defaults are the bounded ones and a bad option is refused at construction', () => {
  assert.deepEqual(MATCHMAKING_DEFAULTS, { maxEntries: 0, maxPerAddr: 0, waitMs: 600_000, acceptMs: 30_000 });
  for (const bad of [{ acceptMs: 0 }, { acceptMs: 200_000 }, { waitMs: 0 }, { maxEntries: -1 }, { maxPerAddr: 1.5 }]) {
    assert.throws(() => harness({ options: bad }), /invalid matchmaking/, JSON.stringify(bad));
  }
});

test('a room forms only at exactly MAX_SEATS waiting for the same difficulty', () => {
  const h = harness();
  h.joinMany(MAX_SEATS - 1);
  assert.equal(h.q.offers.size, 0, 'one short: no offer');
  assert.equal(h.calls.length, 0);
  h.joinMany(1, 'NORMAL', 'last');
  assert.equal(h.q.offers.size, 1, 'exactly full: one offer');
  assert.equal(h.calls.length, 0, 'nothing is created before everyone confirms');

  // a different difficulty is a different pool and never mixes in
  const h2 = harness();
  h2.joinMany(MAX_SEATS - 1, 'NORMAL', 'a');
  h2.joinMany(1, 'HARD', 'b');
  assert.equal(h2.q.offers.size, 0, 'pools never mix');
});

test('everyone confirms: the allocator runs once and each player is told the room code', () => {
  const h = harness();
  const players = h.joinMany(MAX_SEATS);
  const offerId = h.lastTo('p_0').offerId;
  assert.ok(offerId, 'the offer names itself');
  for (const s of players) assert.deepEqual(h.q.accept(s, { offerId }), { ok: true }, 'accept answers ok');
  assert.deepEqual(h.calls, [{ sessions: players.map((s) => s.playerId), difficulty: 'NORMAL' }]);
  assert.equal(h.q.size, 0, 'the queue is empty afterwards');
  for (const s of players) {
    const st = h.lastTo(s.playerId);
    assert.equal(st.t, 'queue.state');
    assert.equal(st.state, 'matched');
    assert.equal(st.code, 'ROOM');
  }
});

test('a confirmed player keeps their place when a teammate goes silent', () => {
  const h = harness();
  const players = h.joinMany(MAX_SEATS);
  const offerId = h.lastTo('p_0').offerId;
  const joinedAt = h.lastTo('p_0').joinedAt;
  h.q.accept(players[0], { offerId });
  h.q.accept(players[1], { offerId });
  h.advance(31_000);            // the accept window passes
  h.q.sweep();
  assert.equal(h.calls.length, 0, 'no room was created');
  assert.equal(h.q.size, 2, 'the two who confirmed are still queued');
  assert.equal(h.lastTo('p_0').joinedAt, joinedAt, 'and kept their original wait age');
  assert.equal(h.lastTo('p_0').requeued, true);
  assert.equal(h.lastTo('p_2').state, 'idle', 'the silent ones lost the slot');
  assert.equal(h.lastTo('p_2').reason, 'unconfirmed');
  assert.equal(h.q.stats().requeued, 2);
});

test('an allocation failure returns the confirmed players to the queue rather than dropping them', () => {
  const h = harness({ allocate: () => ({ error: ERR.INTERNAL, detail: 'no room' }) });
  const players = h.joinMany(MAX_SEATS);
  const offerId = h.lastTo('p_0').offerId;
  for (const s of players) h.q.accept(s, { offerId });
  assert.equal(h.q.size, MAX_SEATS, 'everyone is back in the queue');
  assert.equal(h.q.offers.size, 0);
  for (const s of players) assert.equal(h.lastTo(s.playerId).state, 'queued');
});

test('cancel, disconnect and entering a room all leave the queue, and the others hear about it', () => {
  const h = harness();
  const players = h.joinMany(MAX_SEATS);
  const offerId = h.lastTo('p_0').offerId;
  h.q.accept(players[0], { offerId });
  players[1].roomCode = 'ABCD';       // joined a room by code
  h.q.refresh();
  assert.equal(h.q.offers.size, 0, 'the offer broke at once, not at the deadline');
  assert.equal(h.lastTo('p_0').requeued, true, 'the one who confirmed stays');
  assert.equal(h.q.has('p_1'), false, 'the one who left is gone');
  assert.equal(h.q.has('p_0'), true);

  assert.deepEqual(h.q.cancel(players[0]), { ok: true });
  assert.equal(h.q.size, 0);
  assert.equal(h.lastTo('p_0').state, 'idle');
});

test('admission caps: maxEntries bounds the queue, maxPerAddr bounds one network', () => {
  const capped = harness({ options: { maxEntries: 2 } });
  capped.joinMany(2);
  const extra = capped.session('p_9');
  assert.deepEqual(capped.q.join(extra, { difficulty: 'NORMAL' }), { error: ERR.RATE, detail: 'matchmaking queue is full' });

  const perAddr = harness({ options: { maxPerAddr: 2 } });
  for (let i = 0; i < 2; i++) { const s = perAddr.session(`a_${i}`); s.limitKey = '1.2.3.0/24'; perAddr.q.join(s, { difficulty: 'NORMAL' }); }
  const third = perAddr.session('a_9');
  third.limitKey = '1.2.3.0/24';
  assert.deepEqual(perAddr.q.join(third, { difficulty: 'NORMAL' }), { error: ERR.RATE, detail: 'too many queued players from your network' });
  const other = perAddr.session('b_0');
  other.limitKey = '9.9.9.0/24';
  assert.deepEqual(perAddr.q.join(other, { difficulty: 'NORMAL' }), { ok: true }, 'another network is unaffected');
});

test('a queued player cannot switch difficulty, and a stale offer id is refused', () => {
  const h = harness();
  const s = h.joinMany(1)[0];
  assert.deepEqual(h.q.join(s, { difficulty: 'HARD' }), { error: ERR.QUEUED, detail: 'cancel before changing difficulty' });
  assert.deepEqual(h.q.join(s, { difficulty: 'NORMAL' }), { ok: true }, 'the same difficulty is idempotent');
  assert.deepEqual(h.q.join(h.session('z_0'), { difficulty: 'nope' }), { error: ERR.BAD_MSG, detail: 'invalid matchmaking request' });
  const four = h.joinMany(MAX_SEATS, 'HARD', 'h');
  assert.deepEqual(h.q.accept(four[0], { offerId: 'q:stale' }), { error: ERR.BAD_TARGET, detail: 'stale matchmaking offer' });
});

test('the queue reports what it is doing, not just how big it is', () => {
  const h = harness();
  h.joinMany(2, 'NORMAL', 'a');
  h.advance(4_000);
  h.joinMany(1, 'HARD', 'b');
  const stats = h.q.stats();
  assert.equal(stats.waiting, 3);
  assert.deepEqual(stats.byDifficulty, { NORMAL: 2, HARD: 1 });
  assert.equal(stats.offers, 0);
  assert.equal(stats.requeued, 0);
  assert.equal(stats.oldestWaitSec, 4, 'the oldest wait, in seconds');
});

test('the wait window expires: a player who waited too long is told and leaves', () => {
  const h = harness({ options: { waitMs: 10_000 } });
  const s = h.joinMany(1)[0];
  h.advance(10_000);
  h.q.sweep();
  assert.equal(h.q.has(s.playerId), false);
  assert.equal(h.lastTo(s.playerId).state, 'idle');
  assert.equal(h.lastTo(s.playerId).reason, 'expired');
});

test('close() empties the queue and tells everyone (a shutting-down server)', () => {
  const h = harness();
  h.joinMany(2);
  h.q.close();
  assert.equal(h.q.size, 0);
  assert.equal(h.lastTo('p_0').reason, 'shutdown');
  assert.deepEqual(h.q.join(h.session('p_9'), { difficulty: 'NORMAL' }), { error: ERR.WRONG_PHASE, detail: 'matchmaking is closed' });
});
