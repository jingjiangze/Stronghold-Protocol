// test/match/revival.test.js — 救援 (促融共竞, DESIGN §28): LP 归零不再当场淘汰，结算期开一个窗口，本回合在联防里
// 替你挡过怪、且自己那场打得干净的队友可以花 LP 把你救回 1 点。规则随模式开启（不是房间选项），别的模式没有。
// Run: node --test test/match/revival.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE, REVIVAL_COST, REVIVAL_MIN_DONOR_LP } from '../../shared/constants.js';
import { makeMatch, checkInvariants, DATA } from './harness.js';
import { GameData } from '../../server/match/gamedata.js';

const xie = (o = {}) => makeMatch({ mode: 'coop', humans: 2, seed: 7, modeId: 'mode_xie_normal', ...o });
const plain = (o = {}) => makeMatch({ mode: 'coop', humans: 2, seed: 7, modeId: 'mode_multi_normal', ...o });

test('救援 is part of 促融共竞 only: on for mode_xie_*, off for every other mode and for solo', () => {
  const on = xie().start();
  assert.equal(on.m.revivalEnabled, true);
  assert.equal(on.m.revivalCost, REVIVAL_COST);
  assert.equal(on.m.revivalMinDonorLp, REVIVAL_MIN_DONOR_LP);
  on.m.dispose();

  const off = plain().start();
  assert.equal(off.m.revivalEnabled, false, 'a plain co-op mode has no 救援');
  assert.equal(off.m.publicView().revival, undefined, 'and no revival block in the public view');
  off.m.dispose();

  const solo = makeMatch({ mode: 'solo', humans: 1, seed: 7 }).start();
  assert.equal(solo.m.revivalEnabled, false, 'never in solo');
  solo.m.dispose();
  assert.equal(new GameData(DATA, 'mode_single_normal').revival, null, 'a single mode never resolves 救援');
  assert.deepEqual(new GameData(DATA, 'mode_xie_normal').revival, { cost: REVIVAL_COST, minDonorLp: REVIVAL_MIN_DONOR_LP });
});

test('a plain mode still eliminates on the spot (the deferral is 促融共竞 only)', () => {
  const h = plain().start();
  h.toPrep(1);
  const victim = h.ps('p_1');
  victim.lp = 0;
  assert.ok(h.drive(() => !victim.alive), 'the victim is out');
  assert.equal(victim.pendingDeath, false, 'no window: eliminated immediately');
  checkInvariants(h.m);
  h.m.dispose();
});

test('only a helper who was clean may donate: a helper who leaked, a synthetic 联防 and no 联防 all give nobody', () => {
  const h = xie().start();
  const m = h.m;
  const [a, b] = [h.ps('p_0'), h.ps('p_1')];
  const plan = { helpers: [a, b], leakers: [] };
  m.unitePlan = plan;
  m.fields = [{ kind: 'unite', players: ['p_0', 'p_1'], live: false }];
  const perPlayer = { p_0: { killed: 3 }, p_1: { killed: 1 } };
  m.lastResults = new Map([
    ['p_0', { perfect: true, leaked: [] }],
    ['p_1', { perfect: false, leaked: [{ counted: true }] }],
  ]);
  assert.deepEqual([...m.revivalEligibleHelpers(plan, { reason: 'cleared', perPlayer })], ['p_0'], 'only the clean helper');

  m.lastResults = new Map([['p_0', { perfect: true, leaked: [] }], ['p_1', { perfect: true, leaked: [] }]]);
  assert.deepEqual([...m.revivalEligibleHelpers(plan, { reason: 'cleared', perPlayer, synthetic: true })], [], 'a 联防 that never ran rescues nobody');
  assert.deepEqual([...m.revivalEligibleHelpers(plan, { reason: 'forced', perPlayer })], [], 'a forced end rescues nobody');
  assert.deepEqual([...m.revivalEligibleHelpers(null, { reason: 'cleared', perPlayer })], [], 'no 联防, nobody');
  m.dispose();
});

test('LP 归零 holds the player for the settle window instead of eliminating them', () => {
  const h = xie().start();
  h.toPrep(1);
  const m = h.m;
  const victim = h.ps('p_1');
  victim.lp = 0;
  assert.ok(h.drive(() => !victim.alive), 'held at 0');
  assert.equal(m.phase, PHASE.SETTLE);
  assert.equal(victim.pendingDeath, true, 'waiting for rescue');
  assert.equal(victim.revived, false);
  assert.equal(victim.eliminatedRound, null, 'not eliminated yet');
  const view = m.publicView().revival;
  assert.ok(view, 'the room sees the window');
  assert.deepEqual(view.targets, [{ playerId: 'p_1', name: 'P1' }]);
  assert.equal(view.cost, REVIVAL_COST);
  assert.equal(view.minDonorLp, REVIVAL_MIN_DONOR_LP);
  checkInvariants(m);
  m.dispose();
});

test('a clean helper rescues the downed teammate: the donor pays the cost, the target comes back with 1 LP', () => {
  const h = xie().start();
  h.toPrep(1);
  const m = h.m;
  const donor = h.ps('p_0');
  const victim = h.ps('p_1');
  victim.lp = 0;
  assert.ok(h.drive(() => !victim.alive));
  // the round's real 联防 may not have run in this seed: stand in the eligibility the rule would have produced
  m.revival.eligible = new Set(['p_0']);
  m.revival.windowOpen = true;
  donor.lp = REVIVAL_MIN_DONOR_LP + 4;
  const before = donor.lp;
  assert.deepEqual(m.handle('p_0', { t: 'g.revive', playerId: 'p_1', round: m.round }), { ok: true });
  assert.equal(victim.alive, true, 'rescued');
  assert.equal(victim.pendingDeath, false);
  assert.equal(victim.revived, true, 'the rescue is spent');
  assert.equal(victim.lp, 1);
  assert.equal(donor.lp, before - REVIVAL_COST);
  assert.equal(m.publicView().revival.targets.length, 0, 'nobody is waiting any more');
  checkInvariants(m);
  m.dispose();
});

test('a rescue is refused with a reason the client can show', () => {
  const h = xie().start();
  h.toPrep(1);
  const m = h.m;
  const donor = h.ps('p_0');
  const victim = h.ps('p_1');
  victim.lp = 0;
  assert.ok(h.drive(() => !victim.alive));
  m.revival.eligible = new Set(['p_0']);
  m.revival.windowOpen = true;
  const round = m.round;

  donor.lp = REVIVAL_MIN_DONOR_LP + 4;
  assert.deepEqual(m.handle('p_0', { t: 'g.revive', playerId: 'p_1', round: round + 1 }), { error: ERR.WRONG_PHASE, detail: 'stale-round' });
  assert.deepEqual(m.handle('p_0', { t: 'g.revive', playerId: 'p_1', round }), { ok: true });

  // a second rescue of the same player is refused, and so is a rescue by someone who is not an eligible helper
  donor.lp = REVIVAL_MIN_DONOR_LP + 4;
  assert.deepEqual(m.handle('p_0', { t: 'g.revive', playerId: 'p_1', round }), { error: ERR.BAD_TARGET, detail: 'revival-target-ineligible' });
  m.revival.eligible = new Set();
  victim.lp = 0;
  victim.alive = false;
  victim.pendingDeath = true;
  victim.revived = false;
  assert.deepEqual(m.handle('p_0', { t: 'g.revive', playerId: 'p_1', round }), { error: ERR.BAD_TARGET, detail: 'revival-not-helper' });
  m.revival.eligible = new Set(['p_0']);
  donor.lp = REVIVAL_MIN_DONOR_LP - 1;
  assert.deepEqual(m.handle('p_0', { t: 'g.revive', playerId: 'p_1', round }), { error: ERR.BAD_TARGET, detail: 'revival-lp-insufficient' });
  checkInvariants(m);
  m.dispose();
});

test('nobody comes: the window closes at the end of settle and the player is eliminated for real', () => {
  const h = xie().start();
  h.toPrep(1);
  const m = h.m;
  const victim = h.ps('p_1');
  victim.lp = 0;
  assert.ok(h.drive(() => !victim.alive));
  assert.equal(victim.pendingDeath, true);
  assert.equal(victim.eliminatedRound, null, 'held, not eliminated: the board and shop are still theirs');
  assert.ok(h.drive(() => victim.eliminatedRound != null || h.ended != null), 'the settle window ends');
  assert.equal(victim.pendingDeath, false);
  assert.equal(victim.alive, false);
  assert.ok(victim.eliminatedRound != null, 'eliminated when the window closed');
  assert.equal(victim.revivalUnavailableReason, 'window-expired', 'and the reason is recorded for the UI');
  assert.equal(victim.board.size, 0, 'the real elimination clears the board');
  checkInvariants(m);
  m.dispose();
});

test('the downed player is told to wait, and the room is told who is waiting', () => {
  const h = xie().start();
  h.toPrep(1);
  const m = h.m;
  const victim = h.ps('p_1');
  victim.lp = 0;
  assert.ok(h.drive(() => !victim.alive));
  const toasts = h.allTo('p_1', 'm.toast').map((t) => t.text);
  assert.ok(toasts.some((t) => t.includes('等待救援')), `the downed player sees 等待救援 (${JSON.stringify(toasts)})`);
  const row = m.publicView().players.find((p) => p.playerId === 'p_1');
  assert.equal(row.pendingDeath, true);
  assert.equal(row.alive, false);
  m.dispose();
});
