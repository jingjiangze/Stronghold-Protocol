// test/match/ws-public-compact.test.js — protocol acceptance for the compact m.public layer (PR #157). The hot
// broadcast is `publicView({ full: false })` (server/match/match/messaging.js `_maybeSendPublic`) and the per-match
// constants travel in a BASELINE (`full: true`) sent by platform.js `baselinePublic()` / `_resync()`; a client that
// declared the `pub` capability merges the hot frames into its mirror (public/js/main.js wireNet). This file drives a
// real Match (co-op, production client-side combat) through a unite round (3 humans) and through the boss pair plus
// the hidden round (2 humans), and checks:
//   1. a full publicView() carries every one of the ten constants (views.js);
//   2. publicView({ full: false }) drops exactly them, has no `full: true` marker, and still carries the hot state;
//   3. the client's exact merge over [baseline, ...hot frames] agrees with publicView() (full) taken at the same
//      match state - the constants survive and no compact frame erases anything (narrowed, see FINDING below);
//   4. while the match is in the UNITE phase a hot frame carries `v.unite` { helpers, leakers } and the merge keeps it;
//   5. in the boss round a hot frame's `fields` names the boss field (kind 'boss', or 'hidden' for the hidden round)
//      with its shared pool, and the merge keeps `bossId` / `hiddenBossId` from the baseline - the regression guard
//      for "the boss does not show": without the baseline constants the client cannot render the leader at all;
//   6. the Lobby's capability routing: a session that did not declare `hello.pub` (pubCap 0) receives the FULL
//      encoding of every m.public broadcast, a session with pubCap > 0 the compact one;
//   7. the compact frame's null-clearing rule (server/match/match/views.js COMPACT_NULL_POCKETS): after a unite round
//      reaches SETTLE the mirror holds `uniteResult`, and the LATER SETTLE that resolves no unite carries an explicit
//      `uniteResult: null`, so the merged mirror clears the ended pocket instead of popping the previous unite's
//      result box and sound (public/js/screens/game.js reads `pub?.uniteResult` at every SETTLE).
//
// Run: node --test test/match/ws-public-compact.test.js
//
// FINDING (reported with PR #157; the equivalence below is deliberate): the brief asks the merged mirror to agree with
// `publicView()` (full) over [baseline, ...hot frames]. With the client's exact merge the strict deep-equal needs ONE
// equivalence: `{ ...prev, ...next }` never removes a key, and a compact frame now clears every ended phase pocket it
// does not publish with an explicit null (views.js COMPACT_NULL_POCKETS, the prerequisite for the delta step in the
// compression doc), so the mirror holds `draft: null` / `uniteResult: null` where the fresh full view has no key at
// all. For the pocket keys an absent key in the full view is therefore equivalent to null in the mirror; the strictEST
// property that can hold is asserted (assertMirrorAgrees): every key the full view publishes is present and deep-equal,
// and NO pocket key survives as a stale non-null value. Earlier that strict form could not hold at all - a stale
// `uniteResult` survived in the mirror and a later SETTLE without a unite would pop the previous unite's result box and
// sound instead of that round's own battle result; the fix and test 7 pin the cleared form.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { DATA, makeMatch, give, legalTileFor, chessOfTier } from './harness.js';
import { createBattleFromSpec, compactResult } from '../../server/sim/spec.js';
import { Lobby, Room } from '../../server/lobby.js';

/** The ten per-match constants: fixed at match start, carried only by a baseline (server/match/match/views.js). */
const CONSTANTS = ['lastRound', 'modeId', 'difficulty', 'stageId', 'factions', 'disabledBonds', 'drawnDisabledBonds', 'bannedChess', 'bossId', 'hiddenBossId'];
/** The hot state every frame carries, baseline or not. */
const HOT = ['phase', 'round', 'deadline', 'serverNow', 'bossRound', 'hiddenRound', 'spRound', 'combatMode', 'paused', 'players', 'fields'];
/** Phase-scoped keys: a frame publishes them only in their phase, and the merge keeps them after that phase ends. */
const PHASE_POCKETS = new Set(['draft', 'sp', 'unite', 'uniteResult', 'bossHp', 'overtimeAt', 'teamLp']);
/** The pockets a compact frame must clear with an explicit null (server/match/match/views.js COMPACT_NULL_POCKETS). */
const NULLED_POCKETS = ['unite', 'uniteResult', 'draft', 'sp', 'overtimeAt', 'teamLp'];

/** public/js/main.js `payload(msg)`: a server message without its transport fields. */
function payload(msg) {
  const { t, rid, ...rest } = msg;
  return rest;
}

/** The client's exact m.public merge (public/js/main.js, net.on('m.public')) — copied so the test fails with it. */
function mergePublic(cur, msg) {
  const p = payload(msg);
  const { full: baseline, ...next } = p && typeof p === 'object' ? p : {};
  const prev = cur && cur.public;
  return { public: baseline === true || !prev ? next : { ...prev, ...next } };
}

/** publicView() without its transport/marker fields: what a mirror holds of a full frame. */
function viewOf(full) {
  const { t, full: marker, ...rest } = full;
  return rest;
}

/**
 * Every m.public frame a seat receives, in wire order: the one baseline start() sent it (the only unicast m.public;
 * no resync runs in these tests), then the hot broadcasts. The harness records unicast (h.sent) and broadcast (h.bc)
 * separately, so the baseline must be the only sent frame for the concatenation to be faithful.
 */
function publicFrames(h, playerId) {
  const baselines = h.sent.filter(([id, msg]) => id === playerId && msg.t === 'm.public');
  assert.ok(baselines.length >= 1, `${playerId} got a baseline`);
  assert.ok(baselines.every(([, msg]) => msg.full === true), 'every unicast m.public is a baseline');
  return [...baselines.map(([, msg]) => msg), ...h.bc.filter((msg) => msg.t === 'm.public')];
}

/**
 * The merge-fidelity check (see the header FINDING): the mirror must agree with the server's fresh full view on
 * every key the full view publishes (nothing erased, constants included). For the pockets the compact frame clears
 * with an explicit null (views.js COMPACT_NULL_POCKETS) an absent key in the full view is equivalent to null in the
 * mirror - the merge never removes a key - and no pocket key may survive as a stale non-null value. Returns the extra
 * keys, for the caller to report.
 */
function assertMirrorAgrees(mirror, full, frames) {
  const want = viewOf(full);
  const missing = Object.keys(want).filter((k) => !Object.hasOwn(mirror, k));
  assert.deepEqual(missing, [], 'a compact frame erased a key the full view publishes');
  // No pocket key may survive as a stale non-null value: a pocket the full view does not publish is null (the
  // cleared form the compact frames carry) or absent in the mirror; a published pocket must agree.
  for (const k of PHASE_POCKETS) {
    const published = Object.hasOwn(want, k) && want[k] != null;
    if (published) {
      assert.ok(Object.hasOwn(mirror, k), `the full view publishes ${k}; the compact stream must keep the mirror current`);
      assert.deepEqual(mirror[k], want[k], `mirror.${k} === publicView().${k}`);
    } else {
      assert.ok(!Object.hasOwn(mirror, k) || mirror[k] == null, `a stale pocket survived the merge: ${k} = ${JSON.stringify(mirror[k])}`);
    }
  }
  const extras = Object.keys(mirror).filter((k) => !Object.hasOwn(want, k));
  const pruned = { ...mirror };
  for (const k of extras) delete pruned[k];
  assert.deepEqual(pruned, want, 'the mirror deep-equals publicView() (full) once the pockets it kept on top are dropped');
  for (const k of extras) {
    assert.ok(PHASE_POCKETS.has(k), `the merge kept an unexpected key: ${k}`);
    assert.ok(frames.some((f) => Object.hasOwn(payload(f), k)), `the mirror only keeps keys the wire carried: ${k}`);
  }
  return extras;
}

/** The ten constants survived the compact stream (the point of the baseline + merge protocol). */
function assertConstantsSurvive(mirror, full) {
  for (const k of CONSTANTS) {
    assert.ok(Object.hasOwn(mirror, k), `the constants survive the compact stream: ${k}`);
    assert.deepEqual(mirror[k], full[k], `mirror.${k} === publicView().${k}`);
  }
}

/** Every hot frame on the wire is compact: none of the ten constants, never the `full: true` marker, hot state intact. */
function assertCompactFrames(h) {
  const hot = h.bc.filter((msg) => msg.t === 'm.public');
  assert.ok(hot.length >= 1, 'hot frames were broadcast');
  for (const f of hot) {
    assert.equal('full' in f, false, 'a hot frame never carries the baseline marker');
    for (const k of CONSTANTS) assert.equal(k in f, false, `a hot frame never carries the constant ${k}`);
    for (const k of HOT) assert.ok(Object.hasOwn(f, k), `the hot frame carries the hot key ${k}`);
  }
}

test('a baseline carries the ten per-match constants; the hot frame drops exactly them and keeps the hot state', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 71, fake: true }).start();
  const m = h.m;
  const full = m.publicView();
  assert.equal(full.full, true, 'publicView() defaults to the baseline');
  for (const k of CONSTANTS) assert.ok(Object.hasOwn(full, k), `the full view carries ${k}`);
  const compact = m.publicView({ full: false });
  assert.equal('full' in compact, false, 'a compact frame has no baseline marker');
  for (const k of CONSTANTS) assert.equal(k in compact, false, `the compact view drops ${k}`);
  for (const k of HOT) assert.ok(Object.hasOwn(compact, k), `the compact view still carries the hot key ${k}`);
  // on the wire: every human's first m.public is the baseline (start() -> baselinePublic), the broadcast is compact
  for (const pid of ['p_0', 'p_1']) {
    const first = h.allTo(pid, 'm.public')[0];
    assert.ok(first && first.full === true, `${pid}'s first m.public is the baseline`);
    for (const k of CONSTANTS) assert.ok(Object.hasOwn(first, k), `the baseline carries ${k}`);
  }
  assertCompactFrames(h);
  m.dispose();
});

test('a unite round: a hot frame carries helpers/leakers, the merge keeps them and the constants', () => {
  let ran = 0;
  const h = makeMatch({
    mode: 'coop', humans: 3, seed: 9111, fake: true, clientCombat: true,
    // the normal battles leak for p_0 only -> planUnite gives the two perfect players the unite field (server/match/unite.js)
    script: (b) => (b.kind === 'normal' ? { leaks: { p_0: 4 } } : {}),
    // the unite spec runs the REAL sim on the authority client, like test/match/hud-capsule-resolved.test.js
    perPlayer: Object.fromEntries(['p_0', 'p_1', 'p_2'].map((pid) => [pid, {
      tamper: (result, spec) => {
        if (spec.kind !== 'unite') return result;
        ran++;
        const b = createBattleFromSpec(spec, h.m.ds, { recordEvents: false, quiet: true });
        return compactResult(b.runToEnd(4000));
      },
    }])),
  }).start();
  const m = h.m;
  const unite = () => m.fields.find((f) => f.fieldId === 'u');
  h.drive(() => (unite() && unite().done) || h.ended != null);
  assert.equal(m.phase, PHASE.UNITE, 'the match is in the unite phase (the settle of the finished field is delayed)');
  assert.ok(ran > 0, 'the unite field ran the real sim for its authority');
  assert.deepEqual(m.unitePlan.helpers.map((p) => p.playerId), ['p_1', 'p_2']);
  assert.deepEqual(m.unitePlan.leakers.map((p) => p.playerId), ['p_0']);
  // 4. the hot frames of the UNITE phase carry the plan
  const uniteFrames = h.bc.filter((msg) => msg.t === 'm.public' && msg.phase === PHASE.UNITE);
  assert.ok(uniteFrames.length >= 1, 'a hot frame landed in the unite phase');
  for (const f of uniteFrames) assert.deepEqual(f.unite, { helpers: ['p_1', 'p_2'], leakers: ['p_0'] });
  assertCompactFrames(h);
  const phases = new Set(h.bc.filter((msg) => msg.t === 'm.public').map((msg) => msg.phase));
  for (const p of ['PREP', 'COMBAT', PHASE.UNITE]) assert.ok(phases.has(p), `a hot frame landed in ${p}`);
  // the state the mirror is compared against: a final frame of the same match state (flush does not advance the clock)
  m.flush(true);
  const last = h.bc[h.bc.length - 1];
  assert.equal(last.t, 'm.public');
  assert.equal(last.phase, PHASE.UNITE);
  assert.deepEqual(last.unite, { helpers: ['p_1', 'p_2'], leakers: ['p_0'] });
  const uniteField = last.fields.find((f) => f.fieldId === 'u');
  assert.equal(uniteField.kind, 'unite');
  assert.deepEqual(uniteField.players, ['p_1', 'p_2']);
  assert.equal(uniteField.live, false, 'the field finished (the frame keeps its capsule progress)');
  // 3. the client's exact merge over [baseline, ...hot frames]
  const frames = publicFrames(h, 'p_0');
  let mirror = null;
  for (const f of frames) mirror = mergePublic(mirror, f);
  const full = m.publicView();
  assertMirrorAgrees(mirror.public, full, frames);
  assertConstantsSurvive(mirror.public, full);
  // 4. after the merge the mirror still has the unite plan
  assert.ok(Object.hasOwn(mirror.public, 'unite'), 'the merge keeps the unite plan');
  assert.deepEqual(mirror.public.unite, full.unite);
  m.dispose();
});

test('an ended unite pocket is cleared: the later SETTLE without a unite carries uniteResult: null and the mirror drops it', () => {
  // The stale-box regression (views.js COMPACT_NULL_POCKETS): the client's merge never removes a key, so an ended
  // pocket would stay in the mirror and public/js/screens/game.js reads `pub?.uniteResult` at every SETTLE
  // (battleOverSfx / uniteResultBox) - a later SETTLE without a unite would pop the PREVIOUS unite's box and sound.
  // Drive the same 3-human unite round as above, but leak in R1 only: R2's combats are all perfect, so no unite
  // resolves and its SETTLE must clear the pocket.
  let ran = 0;
  const h = makeMatch({
    mode: 'coop', humans: 3, seed: 9111, fake: true, clientCombat: true,
    script: (b) => (b.kind === 'normal' && b.round === 1 ? { leaks: { p_0: 4 } } : {}),
    perPlayer: Object.fromEntries(['p_0', 'p_1', 'p_2'].map((pid) => [pid, {
      tamper: (result, spec) => {
        if (spec.kind !== 'unite') return result;
        ran++;
        const b = createBattleFromSpec(spec, h.m.ds, { recordEvents: false, quiet: true });
        return compactResult(b.runToEnd(4000));
      },
    }])),
  }).start();
  const m = h.m;
  const unite = () => m.fields.find((f) => f.fieldId === 'u');
  h.drive(() => (unite() && unite().done) || h.ended != null);
  assert.equal(m.phase, PHASE.UNITE, 'the match is in the unite phase');
  assert.ok(ran > 0, 'the unite field ran the real sim for its authority');
  // R1 SETTLE: the unite resolved, the compact frame carries the result and the mirror holds it
  h.drive(() => m.phase === PHASE.SETTLE || h.ended != null);
  assert.equal(m.phase, PHASE.SETTLE);
  assert.equal(m.round, 1);
  assert.ok(m.uniteResultView, 'the round-1 SETTLE view carries the unite outcome');
  m.flush(true);
  const uniteSettle = h.bc[h.bc.length - 1];
  assert.equal(uniteSettle.t, 'm.public');
  assert.equal(uniteSettle.phase, PHASE.SETTLE);
  assert.ok(uniteSettle.uniteResult && uniteSettle.uniteResult.losses.p_0 > 0, 'the compact SETTLE frame carries the unite result');
  let frames = publicFrames(h, 'p_0');
  let mirror = null;
  for (const f of frames) mirror = mergePublic(mirror, f);
  assert.deepEqual(mirror.public.uniteResult, uniteSettle.uniteResult, 'the mirror holds the round-1 unite result');
  assertMirrorAgrees(mirror.public, m.publicView(), frames);
  // continue to a LATER SETTLE that resolves no unite: no leak in R2, so no leakers and planUnite gives no field
  h.drive(() => (m.phase === PHASE.SETTLE && m.round >= 2) || h.ended != null);
  assert.ok(h.ended == null, 'the match is still running');
  assert.equal(m.phase, PHASE.SETTLE);
  assert.ok(m.round > 1, 'the later SETTLE is a later round');
  assert.equal(m.uniteResultView, null, 'no unite resolved this round');
  m.flush(true);
  const later = h.bc[h.bc.length - 1];
  assert.equal(later.t, 'm.public');
  assert.equal(later.phase, PHASE.SETTLE);
  assert.ok(Object.hasOwn(later, 'uniteResult'), 'the compact frame carries the cleared pocket as an explicit null');
  assert.equal(later.uniteResult, null);
  for (const k of NULLED_POCKETS) assert.ok(Object.hasOwn(later, k), `every compact frame carries the pocket key ${k}`);
  // 7. the client's exact merge over [baseline, ...hot frames]: the ended pocket is cleared, not kept
  frames = publicFrames(h, 'p_0');
  mirror = null;
  for (const f of frames) mirror = mergePublic(mirror, f);
  assert.ok(!Object.hasOwn(mirror.public, 'uniteResult') || mirror.public.uniteResult == null,
    `the merged mirror cleared the stale uniteResult (got ${JSON.stringify(mirror.public.uniteResult)})`);
  const full = m.publicView();
  assert.equal(Object.hasOwn(full, 'uniteResult'), false, 'the fresh full view still omits the pocket (its key set is unchanged)');
  assertMirrorAgrees(mirror.public, full, frames);
  assertConstantsSurvive(mirror.public, full);
  m.dispose();
});

test('the boss pair and the hidden round: the hot frame names the field and its pool, bossId/hiddenBossId survive the merge', () => {
  // "the boss does not show" regression guard: m.public.fields carries only { fieldId, kind, players, live, progress };
  // the field's units ride the unicast b.start spec. The client can render the boss field only if the hot frame still
  // names it (kind 'boss' / 'hidden') and the baseline's bossId / hiddenBossId survive in the mirror - otherwise the
  // leader has no id to look up. This test pins both halves on a real 2-human pair.
  const h = makeMatch({
    mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 52, fake: true, clientCombat: true,
    script: (b) => (b.kind === 'boss' || b.kind === 'hidden' ? { bossDps: 1e9 } : {}),
  }).start();
  const m = h.m;
  h.autoHumans();
  const fill = (ps) => {
    const id = chessOfTier(1).find((x) => m.pool.has(x));
    const tile = legalTileFor(m, ps, id);
    if (tile) give(m, ps, id, 'board', tile);
  };
  h.drive(() => m.phase === PHASE.PREP && m.round === 14);
  for (const ps of m.players.values()) if (ps.alive) fill(ps);
  // the hidden core's eligibility recipe (test/match/finalAssault.test.js): bond layers > 1200 at the end of the prep
  for (const ps of m.players.values()) { ps.bondCountBonus.yanShip = 3; ps.layers.yanShip = 601; ps.recompute(); }
  h.drive(() => m.phase === PHASE.FINAL_ASSAULT);
  m.flush(true);
  const bossFrame = h.bc[h.bc.length - 1];
  assert.equal(bossFrame.t, 'm.public');
  assert.equal(bossFrame.phase, PHASE.FINAL_ASSAULT);
  const bossField = bossFrame.fields.find((f) => f.kind === 'boss');
  assert.ok(bossField, 'the compact frame names the boss field');
  assert.equal(bossField.fieldId, 'b1');
  assert.deepEqual(bossField.players, ['p_0', 'p_1'], 'both players of the pair');
  assert.equal(bossField.live, true);
  assert.deepEqual(bossFrame.bossHp, { hp: Math.round(m.bossPool.hp), max: Math.round(m.bossPool.maxHp) }, 'the shared pool travels compactly');
  assert.equal(bossFrame.teamLp, Math.max(0, Math.round(m.teamLp)), 'the merged team LP travels compactly');
  assert.equal(bossFrame.bossRound, m.gd.bossRound);
  // the boss field's units, on the frame the client simulates it from
  const bossStart = h.sent.map(([, x]) => x).find((x) => x.t === 'b.start' && x.fieldId === 'b1');
  assert.ok(bossStart, 'the boss field spec reached the seat');
  assert.equal(bossStart.kind, 'boss');
  assert.equal(bossStart.spec.bossId, m.bossId);
  assert.ok(bossStart.spec.players.every((p) => p.units.length >= 1), 'the boss field carries its units');
  assert.ok(bossStart.spec.spawns.some((s) => s.tag === 'boss'), 'and the leader spawn');
  assertCompactFrames(h);
  // 3. merge fidelity at the boss round
  let frames = publicFrames(h, 'p_0');
  let mirror = null;
  for (const f of frames) mirror = mergePublic(mirror, f);
  let full = m.publicView();
  assertMirrorAgrees(mirror.public, full, frames);
  assertConstantsSurvive(mirror.public, full);
  assert.equal(mirror.public.bossId, m.bossId, 'after the merge the mirror still exposes bossId');
  assert.equal(mirror.public.hiddenBossId, m.hiddenBossId, 'and the not-yet-reached hidden round leader');
  // the hidden round: the same pairing, kind 'hidden'
  h.drive(() => m.phase === PHASE.PREP && m.round === 15);
  for (const ps of m.players.values()) if (ps.alive) fill(ps);
  h.drive(() => m.phase === PHASE.HIDDEN_CORE);
  m.flush(true);
  const hiddenFrame = h.bc[h.bc.length - 1];
  assert.equal(hiddenFrame.phase, PHASE.HIDDEN_CORE);
  const hiddenField = hiddenFrame.fields.find((f) => f.kind === 'hidden');
  assert.ok(hiddenField, 'the compact frame names the hidden field');
  assert.deepEqual(hiddenField.players, ['p_0', 'p_1']);
  assert.deepEqual(hiddenFrame.bossHp, { hp: Math.round(m.bossPool.hp), max: Math.round(m.bossPool.maxHp) }, 'one pool across both rounds');
  const hiddenStart = h.sent.map(([, x]) => x).filter((x) => x.t === 'b.start' && x.kind === 'hidden').pop();
  assert.ok(hiddenStart, 'the hidden field spec reached the seat');
  assert.equal(hiddenStart.spec.bossId, m.hiddenBossId, 'the hidden leader is the one the baseline named');
  assert.ok(hiddenStart.spec.players.every((p) => p.units.length >= 1), 'the hidden field carries its units');
  frames = publicFrames(h, 'p_0');
  mirror = null;
  for (const f of frames) mirror = mergePublic(mirror, f);
  full = m.publicView();
  assertMirrorAgrees(mirror.public, full, frames);
  assert.equal(mirror.public.hiddenBossId, m.hiddenBossId, 'the mirror still exposes hiddenBossId in the hidden round');
  m.dispose();
});

test('capability routing: a session without hello.pub gets the full encoding, pubCap > 0 the compact one', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 72, fake: true }).start();
  const match = h.m;
  // net.js `hello` sets session.pubCap = Number.isInteger(msg.pub) && msg.pub > 0 ? msg.pub : 0; sendRaw needs an
  // OPEN socket ({ readyState: 1, bufferedAmount, send }) — a recording stub stands in for the ws.
  const socket = (out) => ({ readyState: 1, bufferedAmount: 0, send: (data) => { out.push(data); } });
  const session = (playerId, pubCap, out) => ({ playerId, pubCap, connected: true, roomCode: 'TEST', ws: socket(out) });
  const frames = { p_0: [], p_1: [] };
  const sessions = new Map([['p_0', session('p_0', 0, frames.p_0)], ['p_1', session('p_1', 1, frames.p_1)]]);
  const errors = [];
  const lobby = new Lobby({
    registry: { byId: (id) => sessions.get(id) },
    now: () => 0,
    getData: () => DATA,
    log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) },
  });
  const room = new Room('TEST', 'coop', 'NORMAL', 0);
  room.seats[0] = { seat: 0, playerId: 'p_0', name: 'P0', isBot: false, ready: true, connected: true, left: false };
  room.seats[1] = { seat: 1, playerId: 'p_1', name: 'P1', isBot: false, ready: true, connected: true, left: false };
  const ctx = { live: true, ended: false, disposed: false, match, lastPublic: null, lastPublicFull: null, sharedResult: null, results: new Map() };
  const compact = match.publicView({ full: false });
  lobby.matchBroadcast(room, ctx, compact);
  assert.equal(frames.p_0.length, 1, 'the non-capable session is sent one frame');
  assert.equal(frames.p_1.length, 1, 'the capable session is sent one frame');
  const fullFallback = JSON.parse(frames.p_0[0]);
  const compactFrame = JSON.parse(frames.p_1[0]);
  for (const k of CONSTANTS) {
    assert.ok(Object.hasOwn(fullFallback, k), `the session without hello.pub gets the full encoding: ${k}`);
    assert.equal(k in compactFrame, false, `the capable session gets the compact encoding: no ${k}`);
  }
  assert.equal(fullFallback.full, true, 'the fallback is a baseline: publicView() keeps its marker, so a client that does merge resets on it');
  assert.deepEqual(fullFallback, match.publicView(), 'exactly the full view (what baselinePublic sends)');
  assert.deepEqual(compactFrame, compact, 'exactly the compact hot frame');
  for (const k of HOT) assert.ok(Object.hasOwn(compactFrame, k), `the compact frame keeps ${k}`);
  assert.equal(ctx.lastPublic, frames.p_1[0], 'the replay record holds the compact frame');
  assert.equal(ctx.lastPublicFull, frames.p_0[0], 'and the full one for a session that cannot merge');
  // the result replay a resume gets follows the same routing (lobby.replayFor)
  ctx.results.set('p_0', '{"t":"m.result","playerId":"p_0"}');
  ctx.results.set('p_1', '{"t":"m.result","playerId":"p_1"}');
  room.replay = lobby.buildReplay(room, ctx);
  assert.equal(lobby.replayFor(room, 'p_0')[0], ctx.lastPublicFull, 'a resume replay for the non-capable session is the full frame');
  assert.equal(lobby.replayFor(room, 'p_1')[0], ctx.lastPublic, 'for the capable one, the compact frame');
  // an all-capable room never pays for the full frame (matchBroadcast builds it only when a session needs it)
  const capFrames = { p_0: [], p_1: [] };
  sessions.set('p_0', session('p_0', 1, capFrames.p_0));
  sessions.set('p_1', session('p_1', 1, capFrames.p_1));
  const ctx2 = { live: true, ended: false, disposed: false, match, lastPublic: null, lastPublicFull: null, sharedResult: null, results: new Map() };
  lobby.matchBroadcast(room, ctx2, compact);
  assert.equal(ctx2.lastPublicFull, null, 'no session needs the full frame: none is built');
  for (const pid of ['p_0', 'p_1']) assert.deepEqual(JSON.parse(capFrames[pid][0]), compact, `${pid} gets the compact frame`);
  assert.deepEqual(errors, [], 'the broadcast path did not report an error');
  match.dispose();
});
