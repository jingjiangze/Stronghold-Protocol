// test/match/revival.test.js — 救援 (促融共竞, DESIGN §29): LP 归零不再当场淘汰，结算期开一个窗口；**其余全体存活队友
// 各自表态同意**，全票到齐后从共享池按人头扣款（每人 = costPer + step × 已复活次数），把目标带 1 点 LP 救回来。
// 规则随模式开启（不是房间选项），别的模式没有。
// Run: node --test test/match/revival.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE, REVIVAL_COST_PER, REVIVAL_COST_STEP } from '../../shared/constants.js';
import { makeMatch, checkInvariants, DATA } from './harness.js';
import { GameData } from '../../server/match/gamedata.js';

const xie = (o = {}) => makeMatch({ mode: 'coop', humans: 2, seed: 7, modeId: 'mode_xie_normal', ...o });
const plain = (o = {}) => makeMatch({ mode: 'coop', humans: 2, seed: 7, modeId: 'mode_multi_normal', ...o });

test('救援 is part of 促融共竞 only: on for mode_xie_*, off for every other mode and for solo', () => {
  const on = xie().start();
  assert.equal(on.m.revivalEnabled, true);
  assert.equal(on.m.revivalCostPer, REVIVAL_COST_PER);
  assert.equal(on.m.revivalStep, REVIVAL_COST_STEP);
  assert.equal(on.m.reviveCount, 0);
  on.m.dispose();

  const off = plain().start();
  assert.equal(off.m.revivalEnabled, false, 'a plain co-op mode has no 救援');
  assert.equal(off.m.publicView().revival, undefined, 'and no revival block in the public view');
  off.m.dispose();

  const solo = makeMatch({ mode: 'solo', humans: 1, seed: 7 }).start();
  assert.equal(solo.m.revivalEnabled, false, 'never in solo');
  solo.m.dispose();
  assert.equal(new GameData(DATA, 'mode_single_normal').revival, null, 'a single mode never resolves 救援');
  assert.deepEqual(new GameData(DATA, 'mode_xie_normal').revival, { costPer: REVIVAL_COST_PER, step: REVIVAL_COST_STEP });
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

test('the voters are every OTHER living seat (bots included); a target with no other seat has none', () => {
  const h = makeMatch({ mode: 'coop', humans: 3, seed: 7, modeId: 'mode_xie_normal' }).start();
  const m = h.m;
  const [a, b] = [h.ps('p_0'), h.ps('p_2')];
  assert.deepEqual(m.revivalVoters(b).map((p) => p.playerId), ['p_0', 'p_1'], 'everyone but the target');
  assert.deepEqual(m.revivalVoters(a).map((p) => p.playerId), ['p_1', 'p_2']);
  // a seat that left is no longer a voter
  h.ps('p_1').left = true;
  assert.deepEqual(m.revivalVoters(a).map((p) => p.playerId), ['p_2'], 'a departed seat drops out');
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
  assert.deepEqual(view.targets, [{ playerId: 'p_1', name: 'P1', need: ['p_0'], agreed: [] }]);
  assert.equal(view.costPer, REVIVAL_COST_PER, 'per voter, from the shared pool');
  assert.equal(view.revives, 0);
  assert.equal(view.pool, m.teamReserve);
  checkInvariants(m);
  m.dispose();
});

test('the rescue only lands when every other living seat has agreed, and it pays from the shared pool', () => {
  const h = makeMatch({ mode: 'coop', humans: 3, seed: 7, modeId: 'mode_xie_normal' }).start();
  h.toPrep(1);
  const m = h.m;
  const victim = h.ps('p_2');
  victim.lp = 0;
  assert.ok(h.drive(() => !victim.alive));
  m.revival.windowOpen = true;
  m.teamReserve = 50;

  // the first agreement only records itself: the window needs BOTH of the other seats
  assert.deepEqual(m.handle('p_0', { t: 'g.revive', playerId: 'p_2', round: m.round }), { ok: true });
  assert.equal(victim.alive, false, 'not rescued on a single vote');
  assert.equal(m.teamReserve, 50, 'nothing paid yet');
  assert.deepEqual(m.publicView().revival.targets[0].agreed, ['p_0']);
  assert.deepEqual(m.handle('p_0', { t: 'g.revive', playerId: 'p_2', round: m.round }), { error: ERR.ALREADY, detail: 'revival-already-consented' });

  // the last agreement settles it: costPer × voters out of the pool, the target back with 1 LP
  assert.deepEqual(m.handle('p_1', { t: 'g.revive', playerId: 'p_2', round: m.round }), { ok: true });
  assert.equal(victim.alive, true, 'rescued');
  assert.equal(victim.pendingDeath, false);
  assert.equal(victim.revived, true, 'the rescue is spent');
  assert.equal(victim.lp, 1);
  assert.equal(m.teamReserve, 50 - REVIVAL_COST_PER * 2, 'per voter, from the shared pool');
  assert.equal(m.reviveCount, 1);
  assert.equal(m.publicView().revival.targets.length, 0, 'nobody is waiting any more');
  checkInvariants(m);
  m.dispose();
});

test('the second rescue of the match costs more (costPer + step × 已复活次数)', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 7, modeId: 'mode_xie_normal' }).start();
  h.toPrep(1);
  const m = h.m;
  m.reviveCount = 1;
  assert.equal(m.revivalCostFor(), REVIVAL_COST_PER + REVIVAL_COST_STEP, 'the second rescue is dearer');
  m.dispose();
});

test('a rescue is refused with a reason the client can show', () => {
  const h = makeMatch({ mode: 'coop', humans: 3, seed: 7, modeId: 'mode_xie_normal' }).start();
  h.toPrep(1);
  const m = h.m;
  const victim = h.ps('p_2');
  victim.lp = 0;
  assert.ok(h.drive(() => !victim.alive));
  m.revival.windowOpen = true;
  m.teamReserve = 50;
  const round = m.round;

  // 旧窗口排队的那一下：round 对不上
  assert.deepEqual(m.handle('p_0', { t: 'g.revive', playerId: 'p_2', round: round + 1 }), { error: ERR.WRONG_PHASE, detail: 'stale-round' });
  // 目标没有等待救援
  assert.deepEqual(m.handle('p_0', { t: 'g.revive', playerId: 'p_0', round }), { error: ERR.BAD_TARGET, detail: 'revival-target-ineligible' });
  // 池子不够（3 人同意时每人 5，共 15）
  m.teamReserve = 3;
  assert.deepEqual(m.handle('p_0', { t: 'g.revive', playerId: 'p_2', round }), { ok: true }, 'the first vote records but does not pay');
  assert.deepEqual(m.handle('p_1', { t: 'g.revive', playerId: 'p_2', round }), { error: ERR.NO_FUNDS, detail: 'revival-pool-insufficient' });
  assert.equal(victim.alive, false, 'no funds, no rescue');
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
  m.teamReserve = 50;                       // 池子够付：原因是「有人能救，但谁都没表态」
  assert.ok(h.drive(() => victim.eliminatedRound != null || h.ended != null), 'the settle window ends');
  assert.equal(victim.pendingDeath, false);
  assert.equal(victim.alive, false);
  assert.ok(victim.eliminatedRound != null, 'eliminated when the window closed');
  assert.equal(victim.revivalUnavailableReason, 'window-closed', 'and the reason is recorded for the UI');
  assert.equal(victim.board.size, 0, 'the real elimination clears the board');
  checkInvariants(m);
  m.dispose();
});

test('共享池付不起满票 ⇒ 记的原因是 pool，而不是笼统的 window-closed', () => {
  const h = makeMatch({ mode: 'coop', humans: 3, seed: 7, modeId: 'mode_xie_normal' }).start();
  h.toPrep(1);
  const m = h.m;
  const victim = h.ps('p_2');
  victim.lp = 0;
  assert.ok(h.drive(() => !victim.alive));
  m.teamReserve = 0;                        // 3 人局、每人 5、共 15：池子空着，救不回来
  assert.ok(h.drive(() => victim.eliminatedRound != null || h.ended != null));
  assert.equal(victim.revivalUnavailableReason, 'pool', 'the reason names the pool, not the window');
  checkInvariants(m);
  m.dispose();
});

test('同意票只算还在名单里的人（同意的队友离场后，那一票不再计入「同意 n/总数」）', () => {
  const h = makeMatch({ mode: 'coop', humans: 3, seed: 7, modeId: 'mode_xie_normal' }).start();
  h.toPrep(1);
  const m = h.m;
  const victim = h.ps('p_2');
  victim.lp = 0;
  assert.ok(h.drive(() => !victim.alive));
  m.revival.windowOpen = true;
  m.teamReserve = 50;
  assert.deepEqual(m.handle('p_0', { t: 'g.revive', playerId: 'p_2', round: m.round }), { ok: true });
  assert.deepEqual(m.publicView().revival.targets[0].agreed, ['p_0'], 'the vote is counted while they are here');
  h.ps('p_0').left = true;                  // 投票人离场
  const row = m.publicView().revival.targets[0];
  assert.deepEqual(row.need, ['p_1'], 'the roster shrinks to the seats still here');
  assert.deepEqual(row.agreed, [], 'and so does the tally — never 同意 2/1');
  checkInvariants(m);
  m.dispose();
});

test('the downed player is told to wait for the whole team, and the room sees who is waiting', () => {
  const h = xie().start();
  h.toPrep(1);
  const m = h.m;
  const victim = h.ps('p_1');
  victim.lp = 0;
  assert.ok(h.drive(() => !victim.alive));
  const toasts = h.allTo('p_1', 'm.toast').map((t) => t.text);
  assert.ok(toasts.some((t) => t.includes('等待救援') && t.includes('全体队友同意')), `the downed player sees the wait (${JSON.stringify(toasts)})`);
  const row = m.publicView().players.find((p) => p.playerId === 'p_1');
  assert.equal(row.pendingDeath, true);
  assert.equal(row.alive, false);
  m.dispose();
});
