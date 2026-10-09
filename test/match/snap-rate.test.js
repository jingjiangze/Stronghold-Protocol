// server/match/snapRate.js — the adaptive battle-snapshot rate: the policy, the SP_SNAP_RATE modes, and the
// field/match wiring (a jittery connection escalates its field to 20 Hz; a quiet one stays at 10 Hz).
//
// The policy is a pure module fed link samples, so most of this is a plain table of inputs and expected rates.
// The wiring is covered through the real harness: a match with a linkOf() that reports a jittery link must emit
// twice as often as one that does not, and a watcher that skips frames must still receive every event.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SnapRate, parseSnapRate, rttJitter, snapRatesCompatible,
  SNAP_SLOW, SNAP_FAST, SNAP_ESCALATE_MS, SNAP_CALM_MS, SNAP_DWELL_MS, SNAP_CONGESTED_BYTES,
} from '../../server/match/snapRate.js';
import { SNAPSHOT_EVERY, SNAPSHOT_EVERY_FAST } from '../../server/sim/constants.js';
import { FakeBattle } from './fakeBattle.js';
import { makeMatch } from './harness.js';

const jitter = (n, j) => Array.from({ length: n }, (_, i) => (i % 2 ? j : 0));   // mean |Δ| = j

describe('the two rates coexist and compose', () => {
  test('the fast rate is a whole number of slow ones, and the constants are 20 Hz / 10 Hz at 2x', () => {
    assert.equal(SNAP_SLOW, SNAPSHOT_EVERY);
    assert.equal(SNAP_FAST, SNAPSHOT_EVERY_FAST);
    assert.equal(SNAP_SLOW, 6, '10 Hz at 60 ticks per real second');
    assert.equal(SNAP_FAST, 3, '20 Hz at 60 ticks per real second');
    assert.ok(snapRatesCompatible(), 'a slow tick must also be a fast tick, or a slow watcher would miss frames');
  });

  test('SP_SNAP_RATE: auto is the default and the only thing that is not pinned', () => {
    assert.equal(parseSnapRate(undefined), 'auto');
    assert.equal(parseSnapRate(''), 'auto');
    assert.equal(parseSnapRate('AUTO'), 'auto');
    assert.equal(parseSnapRate('slow'), 'slow');
    assert.equal(parseSnapRate('10'), 'slow');
    assert.equal(parseSnapRate('fast'), 'fast');
    assert.equal(parseSnapRate('20'), 'fast');
    assert.equal(parseSnapRate('nonsense'), 'auto', 'an unknown value must not pin a rate');
  });
});

describe('rttJitter', () => {
  test('is the mean absolute successive difference, and null until there are enough samples', () => {
    assert.equal(rttJitter([]), null);
    assert.equal(rttJitter([40]), null);
    assert.equal(rttJitter([40, 90]), null, 'two samples are not enough to mean anything');
    assert.equal(rttJitter([40, 90, 40]), (50 + 50) / 2);
    assert.equal(rttJitter([100, 100, 100, 100]), 0, 'a perfectly steady link has no jitter');
  });

  test('a constant RTT is calm however large it is: latency is not jitter', () => {
    assert.equal(rttJitter([500, 500, 500, 500, 500]), 0);
    assert.equal(rttJitter([5, 5, 5, 5, 5]), 0);
  });

  test('junk samples are skipped rather than poisoning the reading', () => {
    assert.equal(rttJitter([100, NaN, 100, 100]), 0, 'a pair with junk in it is dropped, the rest still counts');
    assert.equal(rttJitter([100, Infinity, 100]), null, 'with every pair dropped there is nothing to measure');
  });
});

describe('SnapRate policy', () => {
  const t0 = 1_000_000;

  test('a connection with no samples, or too few, keeps the slow rate', () => {
    const p = new SnapRate();
    assert.equal(p.update('a', null, t0), SNAP_SLOW);
    assert.equal(p.update('a', { rtts: [], buffered: 0 }, t0), SNAP_SLOW);
    assert.equal(p.update('a', { rtts: [10, 10], buffered: 0 }, t0), SNAP_SLOW);
    assert.equal(p.rateFor('a'), SNAP_SLOW);
  });

  test('jitter at or above the escalate threshold moves to the fast rate on the first real evidence', () => {
    const p = new SnapRate();
    // The dwell holds a rate against *changing back*, not against the first honest reading: a connection whose
    // link is jittery when the battle starts must not have to wait a dwell before its frames get smoother.
    assert.equal(p.update('a', { rtts: jitter(8, SNAP_ESCALATE_MS), buffered: 0 }, t0), SNAP_FAST);
    assert.equal(p.isFast('a'), true);
  });

  test('the dwell holds a rate: a switch cannot happen twice in a row', () => {
    const p = new SnapRate();
    assert.equal(p.update('a', { rtts: jitter(8, 200), buffered: 0 }, t0), SNAP_FAST);
    // a calm reading right afterwards must not flip it back before the dwell has elapsed
    assert.equal(p.update('a', { rtts: jitter(8, 0), buffered: 0 }, t0 + 1), SNAP_FAST);
    assert.equal(p.update('a', { rtts: jitter(8, 0), buffered: 0 }, t0 + SNAP_DWELL_MS - 1), SNAP_FAST);
    assert.equal(p.update('a', { rtts: jitter(8, 0), buffered: 0 }, t0 + SNAP_DWELL_MS), SNAP_SLOW);
  });

  test('the middle of the range changes nothing: hysteresis, not a threshold', () => {
    const p = new SnapRate();
    p.update('a', { rtts: jitter(8, 200), buffered: 0 }, t0);
    assert.equal(p.rateFor('a'), SNAP_FAST);
    const middle = (SNAP_CALM_MS + SNAP_ESCALATE_MS) / 2;
    for (let i = 0; i < 10; i++) p.update('a', { rtts: jitter(8, middle), buffered: 0 }, t0 + 100 + i * SNAP_DWELL_MS);
    assert.equal(p.rateFor('a'), SNAP_FAST, 'between the two thresholds the rate must hold, not oscillate');
  });

  test('a congested socket drops to the slow rate at once — it is bad right now, no dwell', () => {
    const p = new SnapRate();
    assert.equal(p.update('a', { rtts: jitter(8, 200), buffered: 0 }, t0), SNAP_FAST);
    assert.equal(p.update('a', { rtts: jitter(8, 200), buffered: SNAP_CONGESTED_BYTES }, t0 + 1), SNAP_SLOW);
    assert.equal(p.changed('a'), true);
  });

  test('a jittery link with a deep queue stays slow: adding frames would deepen the backlog', () => {
    const p = new SnapRate();
    for (let i = 0; i < 5; i++) {
      p.update('a', { rtts: jitter(8, 500), buffered: SNAP_CONGESTED_BYTES + 1 }, t0 + i * SNAP_DWELL_MS);
    }
    assert.equal(p.rateFor('a'), SNAP_SLOW);
  });

  test('connections are independent: one jittery link does not move another', () => {
    const p = new SnapRate();
    p.update('a', { rtts: jitter(8, 200), buffered: 0 }, t0);
    p.update('b', { rtts: jitter(8, 0), buffered: 0 }, t0);
    p.update('a', { rtts: jitter(8, 200), buffered: 0 }, t0 + SNAP_DWELL_MS + 1);
    p.update('b', { rtts: jitter(8, 0), buffered: 0 }, t0 + SNAP_DWELL_MS + 1);
    assert.equal(p.rateFor('a'), SNAP_FAST);
    assert.equal(p.rateFor('b'), SNAP_SLOW);
    assert.equal(p.fastCount(), 1);
  });

  test('prune forgets departed watchers so a long match cannot grow the map', () => {
    const p = new SnapRate();
    p.update('a', { rtts: jitter(8, 0), buffered: 0 }, t0);
    p.update('b', { rtts: jitter(8, 0), buffered: 0 }, t0);
    p.prune(new Set(['a']));
    assert.equal(p.states.has('a'), true);
    assert.equal(p.states.has('b'), false);
  });

  test('changed() reports only the update that moved the rate', () => {
    const p = new SnapRate();
    assert.equal(p.changed('a'), false, 'nothing has happened yet');
    p.update('a', { rtts: jitter(8, 200), buffered: 0 }, t0);
    assert.equal(p.changed('a'), true, 'the escalation');
    p.update('a', { rtts: jitter(8, 200), buffered: 0 }, t0 + 1);
    assert.equal(p.changed('a'), false, 'the same rate again');
  });
});

describe('the wiring: a jittery watcher makes its field emit at 20 Hz', () => {
  /** A running match in server-run combat whose linkOf reports one player's link. */
  const started = (linkOf, opts = {}) => {
    // `duration` is GAME seconds and the match runs at 2x, so a real-second measurement needs a long battle.
    const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 41, fake: true, instant: false, script: () => ({ duration: 3600 }), ...opts });
    h.m.linkOf = linkOf;
    return h.start();
  };
  /** Count b.snap frames delivered to one player over one real second, once the rates have settled. */
  const perSecond = (h, pid) => {
    h.sched.advance(1000);                     // let the policy read the links and settle
    const before = h.allTo(pid, 'b.snap').length;
    h.sched.advance(1000);
    return h.allTo(pid, 'b.snap').length - before;
  };
  const toCombat = (h) => {
    h.toPrep(1);
    h.autoHumans();
    h.run(() => h.m.phase === 'COMBAT');
    return h;
  };

  test('without a link source the match is plain 10 Hz (the shipped default)', () => {
    const snaps = perSecond(toCombat(started(null)), 'p_0');
    assert.ok(snaps >= 8 && snaps <= 12, `10 Hz: got ${snaps} snapshots in a real second`);
  });

  test('a jittery link escalates that field to 20 Hz while a quiet one stays at 10 Hz', () => {
    const jittery = jitter(8, 300);
    const h = toCombat(started((pid) => ({ rtts: pid === 'p_0' ? jittery : jitter(8, 0), buffered: 0 })));
    const snaps0 = perSecond(h, 'p_0');
    const snaps1 = perSecond(h, 'p_1');
    assert.ok(snaps0 >= 17 && snaps0 <= 23, `the jittery watcher's field is 20 Hz: got ${snaps0}`);
    assert.ok(snaps1 >= 8 && snaps1 <= 12, `the quiet watcher's field is still 10 Hz: got ${snaps1}`);
  });

  test('a slow watcher skipping frames still receives every event batch', () => {
    const jittery = jitter(8, 300);
    const h = toCombat(started((pid) => ({ rtts: pid === 'p_0' ? jittery : jitter(8, 0), buffered: 0 })));
    h.sched.advance(1000);   // settle: p_0's field is fast
    // A teammate watching p_0's field is on the slow rate, so it skips the fast-only frames. Whatever events
    // those frames drained must still reach it with its next snapshot.
    assert.equal(h.m.handle('p_1', { t: 'g.watch', fieldId: 'n:p_0' }).ok, true);
    const from = { p0: h.allTo('p_0', 'b.ev').length, p1: h.allTo('p_1', 'b.ev').length };
    h.sched.advance(1000);
    // End the field: the final frame goes to every watcher regardless of cadence, so at this point the slow
    // watcher must hold everything the fast one saw (a running battle would still leave it one interval behind).
    FakeBattle.instances.find((b) => b.fieldId === 'n:p_0').forceEnd('forced');
    h.sched.advance(300);
    const toP0 = h.allTo('p_0', 'b.ev').slice(from.p0).filter((m) => m.fieldId === 'n:p_0');
    const toP1 = h.allTo('p_1', 'b.ev').slice(from.p1).filter((m) => m.fieldId === 'n:p_0');
    assert.ok(toP0.length > 0, 'the fast watcher received events');
    assert.ok(toP1.length > 0, 'the slow watcher received events too');
    const seen = (msgs) => new Set(msgs.flatMap((m) => m.ev.map((e) => JSON.stringify(e))));
    const fast = seen(toP0);
    const slow = seen(toP1);
    for (const e of fast) assert.ok(slow.has(e), `the slow watcher missed an event: ${e}`);
  });

  test("SP_SNAP_RATE='slow' pins 10 Hz even on a jittery link; 'fast' pins 20 Hz", () => {
    const jittery = jitter(8, 300);
    for (const [mode, lo, hi] of [['slow', 8, 12], ['fast', 17, 23]]) {
      const h = toCombat(started((pid) => ({ rtts: pid === 'p_0' ? jittery : jitter(8, 0), buffered: 0 }), { snapRate: mode }));
      const snaps = perSecond(h, 'p_0');
      assert.ok(snaps >= lo && snaps <= hi, `${mode}: got ${snaps} snapshots per real second`);
    }
  });

  test('a congested socket is held at 10 Hz even while its RTT jitters', () => {
    const h = toCombat(started(() => ({ rtts: jitter(8, 300), buffered: 1 << 20 })));
    const snaps = perSecond(h, 'p_0');
    assert.ok(snaps >= 8 && snaps <= 12, `a socket that is already queueing must not be given more frames: got ${snaps}`);
  });
});

