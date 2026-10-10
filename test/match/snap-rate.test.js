// server/match/snapRate.js — the adaptive battle-snapshot rate: the policy, the SP_SNAP_RATE modes, and the
// field/match wiring (a jittery connection takes 20 Hz frames; a quiet one stays at the 15 Hz base).
//
// The policy is a pure module fed link samples, so most of this is a plain table of inputs and expected rates.
// The wiring is covered through the real harness: a match with a linkOf() that reports a jittery link must emit
// at 20 Hz against a quiet link's 15 Hz, a slow watcher of a fast field must still receive every event, and a
// field carrying one slow and one fast watcher must serve both cadences at once (the per-watcher counters; the
// old grid model would have thinned the slow one to 5 Hz — see the last test).

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
  test('the constants are 15 Hz / 20 Hz at 2x, and the sanity check honours the non-divisible pair', () => {
    assert.equal(SNAP_SLOW, SNAPSHOT_EVERY);
    assert.equal(SNAP_FAST, SNAPSHOT_EVERY_FAST);
    assert.equal(SNAP_SLOW, 4, '15 Hz at 60 ticks per real second');
    assert.equal(SNAP_FAST, 3, '20 Hz at 60 ticks per real second');
    // 4 is not a multiple of 3: the old rule (SNAP_SLOW % SNAP_FAST === 0) would have refused the shipped pair and
    // pinned everyone to the slow rate. The per-watcher counters (fields.js _emit) make nesting unnecessary.
    assert.notEqual(SNAP_SLOW % SNAP_FAST, 0, 'the shipped pair must stay non-divisible — it is what the counters solve');
    assert.ok(snapRatesCompatible(), 'a non-divisible slow/fast pair must be honoured');
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

describe('the wiring: a jittery watcher takes 20 Hz frames, a quiet one the 15 Hz base', () => {
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

  test('without a link source the match is the plain 15 Hz base (the shipped default)', () => {
    const snaps = perSecond(toCombat(started(null)), 'p_0');
    assert.ok(snaps >= 13 && snaps <= 17, `15 Hz: got ${snaps} snapshots in a real second`);
  });

  test('a jittery link escalates that watcher to 20 Hz while a quiet one stays at 15 Hz', () => {
    const jittery = jitter(8, 300);
    const h = toCombat(started((pid) => ({ rtts: pid === 'p_0' ? jittery : jitter(8, 0), buffered: 0 })));
    const snaps0 = perSecond(h, 'p_0');
    const snaps1 = perSecond(h, 'p_1');
    assert.ok(snaps0 >= 17 && snaps0 <= 23, `the jittery watcher's field is 20 Hz: got ${snaps0}`);
    assert.ok(snaps1 >= 13 && snaps1 <= 17, `the quiet watcher's field is still 15 Hz: got ${snaps1}`);
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

  test("SP_SNAP_RATE='slow' pins 15 Hz even on a jittery link; 'fast' pins 20 Hz", () => {
    const jittery = jitter(8, 300);
    for (const [mode, lo, hi] of [['slow', 13, 17], ['fast', 17, 23]]) {
      const h = toCombat(started((pid) => ({ rtts: pid === 'p_0' ? jittery : jitter(8, 0), buffered: 0 }), { snapRate: mode }));
      const snaps = perSecond(h, 'p_0');
      assert.ok(snaps >= lo && snaps <= hi, `${mode}: got ${snaps} snapshots per real second`);
    }
  });

  test('a congested socket is held at 15 Hz even while its RTT jitters', () => {
    const h = toCombat(started(() => ({ rtts: jitter(8, 300), buffered: 1 << 20 })));
    const snaps = perSecond(h, 'p_0');
    assert.ok(snaps >= 13 && snaps <= 17, `a socket that is already queueing must not be given more frames: got ${snaps}`);
  });
});

// The redesign's regression guard. The old model emitted a field on one grid (its finest watcher's interval) and let
// slower watchers take only the grid ticks that were also multiples of their own interval (SNAP_SLOW % SNAP_FAST === 0
// was required). 15 Hz = 4 ticks and 20 Hz = 3 ticks do NOT nest: on a field carrying one slow and one fast watcher,
// the slow watcher would have received only the ticks divisible by both — every 12th tick, 5 Hz, far worse than the 15
// it should get. The per-watcher counters must serve each watcher its own cadence, and the parking path must leave
// neither short of a single `b.ev`.
describe('one field, two cadences: a slow and a fast watcher share a field without thinning each other', () => {
  test('the 联防 field with a jittery helper and a quiet helper: 20 Hz and 15 Hz, no event lost', () => {
    const jittery = jitter(8, 300);
    // p_0 leaks; p_1 and p_2 are perfect and both play the 联防 field 'u'. p_1's link is jittery (the fast rate),
    // p_2's is quiet (the 15 Hz base) — the two are players of the same field, so neither is spectate-doubled.
    const h = makeMatch({
      mode: 'coop', humans: 3, seed: 77, fake: true, instant: false,
      linkOf: (pid) => ({ rtts: pid === 'p_1' ? jittery : jitter(8, 0), buffered: 0 }),
      // the normal fields end at once (4 game s); the 联防 battle outlives the measurement
      script: (b) => (b.kind === 'unite' ? { duration: 3600 } : { duration: 4, leaks: { p_0: 2 } }),
    }).start();
    h.toPrep(1);
    assert.ok(h.drive(() => h.m.phase === 'UNITE'), 'the round must reach 联防');
    const u = h.m.fields.find((f) => f.fieldId === 'u');
    assert.ok(u && u.live, 'the 联防 field is up');
    assert.deepEqual(u.players.slice().sort(), ['p_1', 'p_2'], 'both helpers play the field');
    // baseline: the b.ev messages each helper already had before the 联防 field started
    const from = { fast: h.allTo('p_1', 'b.ev').length, slow: h.allTo('p_2', 'b.ev').length };
    // let the rate policy read the links, then count the frames each watcher receives over one real second (60 ticks)
    h.sched.advance(1000);
    const count = (pid) => {
      const before = h.allTo(pid, 'b.snap').length;
      h.sched.advance(1000);
      return h.allTo(pid, 'b.snap').length - before;
    };
    const fast = count('p_1');
    const slow = count('p_2');
    assert.ok(fast >= 17 && fast <= 23, `the jittery helper takes 20 Hz: got ${fast} frames in a real second`);
    assert.ok(slow >= 13 && slow <= 17, `the quiet helper takes 15 Hz: got ${slow} frames in a real second`);
    assert.ok(fast > slow, `the fast cadence must be strictly denser: ${fast} vs ${slow}`);
    // End the field: the final frame is due for every watcher and flushes whatever each had parked, so both must
    // then hold every event the field drained over the whole 联防.
    FakeBattle.instances.find((b) => b.fieldId === 'u').forceEnd('forced');
    h.sched.advance(300);
    const flat = (pid, n) => h.allTo(pid, 'b.ev').slice(n).filter((m) => m.fieldId === 'u').flatMap((m) => m.ev.map((e) => JSON.stringify(e))).sort();
    const fastEv = flat('p_1', from.fast);
    const slowEv = flat('p_2', from.slow);
    assert.ok(fastEv.length > 0 && slowEv.length > 0, 'both watchers received events');
    assert.deepEqual(slowEv, fastEv, 'the parking path must leave neither watcher short of a single b.ev');
    h.m.dispose();
  });
});

