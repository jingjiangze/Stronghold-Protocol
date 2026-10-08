// team economy (协同经济 V1, docs/DESIGN §25): the rule-set gate, transfer requests, the team reserve and the
// logistics projects. Everything here is gated by config.economy.team.enabled — off by default, never in solo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE } from '../../shared/constants.js';
import { DATA, makeMatch, checkInvariants } from './harness.js';
import { GameData } from '../../server/match/gamedata.js';
import { buildNormalWave, buildBossWave } from '../../server/match/waves.js';
import { createRng } from '../../server/sim/rng.js';
import { botEconMaybeRequest, botEconKeyMoment } from '../../server/match/bot.js';

/** The rule set exactly as the design fixes it (spec §3.2; the shipped starting values). */
const TEAM = {
  transfer: { maxPerRequest: 5, requestsPerRound: 1, teamCapPerRound: 8, ttlSec: 30 },
  reserve: { convertPerPlayerMax: 2, perfectReward: 1, perfectRewardCapPerRound: 2 },
  projects: {
    procure: { costs: [4, 8, 12] },
    storehouse: { costs: [4, 8, 12] },
    logistics: { costs: [4, 8, 12], teamCapBonus: [4, 8, 12], extraRequestsAtL3: 1 },
  },
};
const TEAM_DATA = { ...DATA, config: { ...DATA.config, economy: { ...DATA.config.economy, team: { enabled: true, ...TEAM } } } };
const teamMatch = (o = {}) => makeMatch({ mode: 'coop', humans: 2, seed: 21, data: TEAM_DATA, ...o });

/** Open a request and return the registered object (asserts the reply and the registration). */
const openRequest = (h, from, to, amount = 4) => {
  assert.deepEqual(h.m.handle(from, { t: 'g.econ.request', to, amount }), { ok: true });
  const req = [...h.m.econRequests.values()].find((r) => r.from === from && r.to === to);
  assert.ok(req, 'request registered');
  return req;
};

test('the team economy is off by default and never exists in solo', () => {  const off = makeMatch({ mode: 'coop', humans: 2, seed: 1 }).start();
  off.toPrep(1);
  assert.equal(off.m.teamEcon, null);
  assert.deepEqual(off.m.handle('p_0', { t: 'g.econ.request', to: 'p_1', amount: 2 }), { error: ERR.WRONG_PHASE, detail: 'team economy disabled' });
  assert.equal(off.m.publicView().econ, undefined);
  assert.equal(off.ps('p_0').privateView().econ, undefined);
  off.m.dispose();

  const solo = makeMatch({ mode: 'solo', seed: 2, data: TEAM_DATA }).start();
  solo.toPrep(1);
  assert.equal(solo.m.teamEcon, null, 'solo is never a team economy');
  assert.deepEqual(solo.m.handle('p_0', { t: 'g.econ.request', to: 'p_0', amount: 1 }), { error: ERR.WRONG_PHASE, detail: 'team economy disabled' });
  solo.m.dispose();
});

test('approving moves the funds from the approver to the requester and the request is consumed once', () => {
  const h = teamMatch().start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  const b = h.ps('p_1');
  a.funds = 3;
  b.funds = 9;
  const req = openRequest(h, 'p_0', 'p_1', 4);
  const inB = h.lastTo('p_1', 'm.private');
  assert.equal(inB.econ.requestIn.id, req.id);
  assert.equal(inB.econ.requestIn.from, 'p_0');
  assert.equal(inB.econ.requestIn.amount, 4);
  assert.equal(inB.econ.maxPerRequest, 5, 'the client sizes its amount picker from this');
  assert.equal(h.lastTo('p_0', 'm.private').econ.requestOut.to, 'p_1');
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: true }), { ok: true });
  assert.equal(a.funds, 7);
  assert.equal(b.funds, 5);
  assert.equal(m.econRequests.size, 0);
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: true }), { error: ERR.BAD_TARGET });
  checkInvariants(m);
  m.dispose();
});

test('denying closes the request and leaves every fund where it was', () => {
  const h = teamMatch().start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  const b = h.ps('p_1');
  a.funds = 1;
  b.funds = 6;
  const req = openRequest(h, 'p_0', 'p_1', 3);
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: false }), { ok: true });
  assert.equal(a.funds, 1);
  assert.equal(b.funds, 6);
  assert.equal(m.econRequests.size, 0);
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: false }), { error: ERR.BAD_TARGET });
  m.dispose();
});

test('caps: the per-request maximum, one request per player per round, the team total', () => {
  const h = teamMatch({ humans: 3, seed: 22 }).start();
  h.toPrep(1);
  const m = h.m;
  const [a, b, c] = ['p_0', 'p_1', 'p_2'].map((id) => h.ps(id));
  a.funds = 0;
  b.funds = 20;
  c.funds = 20;
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.request', to: 'p_1', amount: 6 }), { error: ERR.BAD_TARGET, detail: 'amount' });
  const req = openRequest(h, 'p_0', 'p_1', 5);
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.request', to: 'p_2', amount: 1 }), { error: ERR.ALREADY });
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: true }), { ok: true });
  assert.equal(a.funds, 5);
  assert.equal(b.funds, 15);
  // 5 already moved this round: a second transfer is capped at 3 (the team cap 8)
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.request', to: 'p_2', amount: 4 }), { error: ERR.BAD_TARGET, detail: 'team cap' });
  const req2 = openRequest(h, 'p_1', 'p_2', 3);
  assert.deepEqual(m.handle('p_2', { t: 'g.econ.respond', id: req2.id, approve: true }), { ok: true });
  assert.equal(b.funds, 18);
  assert.equal(c.funds, 17);
  assert.deepEqual(m.handle('p_2', { t: 'g.econ.request', to: 'p_0', amount: 1 }), { error: ERR.BAD_TARGET, detail: 'team cap' });
  checkInvariants(m);
  m.dispose();
});

test('a request expires with its TTL and cannot be answered afterwards', () => {
  const h = teamMatch().start();
  h.toPrep(1);
  const m = h.m;
  const req = openRequest(h, 'p_0', 'p_1', 2);
  h.sched.advance(TEAM.transfer.ttlSec * 1000 + 1);
  assert.equal(m.econRequests.size, 0, 'expired');
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: true }), { error: ERR.BAD_TARGET });
  m.dispose();
});

test('ready locks the requester out; a ready teammate cannot approve until it un-readies', () => {
  const h = teamMatch().start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  const b = h.ps('p_1');
  a.funds = 0;
  b.funds = 9;
  m.handle('p_0', { t: 'g.ready', ready: true });
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.request', to: 'p_1', amount: 2 }), { error: ERR.WRONG_PHASE, detail: 'ready' });
  m.handle('p_0', { t: 'g.ready', ready: false });
  const req = openRequest(h, 'p_0', 'p_1', 2);
  m.handle('p_1', { t: 'g.ready', ready: true });
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: true }), { error: ERR.WRONG_PHASE, detail: 'ready' });
  m.handle('p_1', { t: 'g.ready', ready: false });
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: true }), { ok: true });
  assert.equal(a.funds, 2);
  m.dispose();
});

test('asking a READY teammate is refused and does not burn the once-per-round budget (被借 e2e, 2026-10-07)', () => {
  const h = teamMatch().start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  const b = h.ps('p_1');
  a.funds = 0;
  b.funds = 9;
  m.handle('p_1', { t: 'g.ready', ready: true });
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.request', to: 'p_1', amount: 1 }), { error: ERR.WRONG_PHASE, detail: 'target ready' });
  assert.equal(m.econRound.byPlayer.get('p_0') || 0, 0, 'the budget is untouched');
  assert.equal(m.econRequests.size, 0, 'and nothing is left in flight');
  m.handle('p_1', { t: 'g.ready', ready: false });
  const req = openRequest(h, 'p_0', 'p_1', 1);
  assert.ok(req.id, 'the same round still allows the ask once the teammate is back');
  m.dispose();
});

test('the prep end closes every request and an old id never answers in the next round', () => {
  const h = teamMatch().start();
  h.toPrep(1);
  const m = h.m;
  const req = openRequest(h, 'p_0', 'p_1', 2);
  h.drive(() => m.phase === PHASE.PREP && m.round === 2);
  assert.equal(m.econRequests.size, 0, 'the prep end closed it');
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: true }), { error: ERR.BAD_TARGET });
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: false }), { error: ERR.BAD_TARGET });
  checkInvariants(m);
  m.dispose();
});

test('leaving the match closes the requests of that player', () => {
  const h = teamMatch().start();
  h.toPrep(1);
  const m = h.m;
  const b = h.ps('p_1');
  b.funds = 9;
  const req = openRequest(h, 'p_0', 'p_1', 2);
  m.onLeave('p_1');
  assert.equal(m.econRequests.size, 0);
  assert.equal(b.funds, 0, 'the departed player keeps nothing (eliminate)');
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: true }), { error: ERR.NOT_IN_ROOM });
  m.dispose();
});

test('cancel withdraws the own request, keeps the budget spent and refuses other players', () => {
  const h = teamMatch().start();
  h.toPrep(1);
  const m = h.m;
  const req = openRequest(h, 'p_0', 'p_1', 2);
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.cancel', id: req.id }), { error: ERR.BAD_TARGET }, 'only the requester cancels');
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.cancel', id: req.id }), { ok: true });
  assert.equal(m.econRequests.size, 0);
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.cancel', id: req.id }), { error: ERR.BAD_TARGET });
  assert.equal(m.econPrivateFor(h.ps('p_0')).requestLeft, 0, 'the round budget stays spent');
  m.dispose();
});

test('a player with a pending request on either side is busy (ERR.ALREADY)', () => {
  const h = teamMatch({ humans: 3, seed: 24 }).start();
  h.toPrep(1);
  const m = h.m;
  openRequest(h, 'p_0', 'p_1', 1);
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.request', to: 'p_2', amount: 1 }), { error: ERR.ALREADY }, 'p_1 has an incoming request');
  assert.deepEqual(m.handle('p_2', { t: 'g.econ.request', to: 'p_0', amount: 1 }), { error: ERR.ALREADY }, 'p_0 has an outgoing request');
  checkInvariants(m);
  m.dispose();
});

test('leftover funds convert into the team reserve at the prep end (≤ 2 per player)', () => {
  const h = teamMatch().start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  const b = h.ps('p_1');
  a.funds = 7;
  b.funds = 1;
  h.drive(() => m.phase === PHASE.PREP && m.round === 2);
  assert.equal(m.teamReserve, 3, 'min(7,2) + min(1,2)');
  assert.equal(m.publicView().econ.reserve, 3);
  assert.equal(a.funds, 5, 'leftover cleared, R2 income only');
  assert.equal(b.funds, 5);
  checkInvariants(m);
  m.dispose();
});

test('a 坎诺特 band keeps its leftovers and never converts', () => {
  const h = teamMatch().start();
  h.toPrep(1, { band: 'band_cannot' });
  const m = h.m;
  // one strategy per match: exactly one of the two seats holds band_cannot
  const keen = [h.ps('p_0'), h.ps('p_1')].find((p) => p.bandId === 'band_cannot');
  assert.ok(keen, 'one seat drafted band_cannot');
  const other = keen === h.ps('p_0') ? h.ps('p_1') : h.ps('p_0');
  other.funds = 0;
  keen.funds = 3;
  h.drive(() => m.phase === PHASE.PREP && m.round === 2, { band: 'band_cannot' });
  assert.equal(m.teamReserve, 0);
  assert.equal(keen.funds, 3 + 5, 'kept 3 + R2 income');
  assert.equal(other.funds, 5, 'the other seat had nothing to convert');
  m.dispose();
});

test('应急仓储 keeps leftovers up to its level and the rest converts', () => {
  const h = teamMatch().start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  m.teamReserve = 4;
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.project', project: 'storehouse' }), { ok: true });
  a.funds = 5;
  h.ps('p_1').funds = 0;
  h.drive(() => m.phase === PHASE.PREP && m.round === 2);
  assert.equal(m.teamReserve, 2, 'min(5 − keep 1, cap 2)');
  assert.equal(a.funds, 6, 'kept 1 + R2 income 5');
  checkInvariants(m);
  m.dispose();
});

test('projects: purchase, costs, the level cap and 联合采购 free refreshes', () => {
  const h = teamMatch().start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.project', project: 'nope' }), { error: ERR.BAD_TARGET, detail: 'project' });
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.project', project: 'procure' }), { error: ERR.NO_FUNDS, detail: 'reserve' });
  m.handle('p_0', { t: 'g.ready', ready: true });
  m.teamReserve = 4;
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.project', project: 'procure' }), { error: ERR.WRONG_PHASE, detail: 'ready' });
  m.handle('p_0', { t: 'g.ready', ready: false });
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.project', project: 'procure' }), { ok: true });
  assert.equal(m.teamReserve, 0, 'costs 4');
  m.teamReserve = 8;
  m.handle('p_0', { t: 'g.econ.project', project: 'procure' });
  m.teamReserve = 12;
  m.handle('p_0', { t: 'g.econ.project', project: 'procure' });
  assert.equal(m.teamProjects.procure, 3);
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.project', project: 'procure' }), { error: ERR.MAX_LEVEL });
  const view = m.publicView().econ.projects.find((p) => p.id === 'procure');
  assert.equal(view.level, 3);
  assert.equal(view.cost, null, 'maxed');
  // 联合采购: the round start grants at least the level's free refreshes, and never stacks
  a.shop.freeRefreshes = 0;
  h.drive(() => m.phase === PHASE.PREP && m.round === 2);
  assert.equal(a.shop.freeRefreshes, 3);
  a.shop.freeRefreshes = 5;
  a.startRound(3);
  assert.equal(a.shop.freeRefreshes, 5, 'at least this many');
  checkInvariants(m);
  m.dispose();
});

test('后勤调度 raises the round transfer cap and (L3) the request budget', () => {
  const h = teamMatch({ humans: 3, seed: 23 }).start();
  h.toPrep(1);
  const m = h.m;
  m.teamReserve = 4;
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.project', project: 'logistics' }), { ok: true });
  const b = h.ps('p_1');
  const c = h.ps('p_2');
  b.funds = 30;
  c.funds = 30;
  const r1 = openRequest(h, 'p_0', 'p_1', 5);
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: r1.id, approve: true }), { ok: true });
  const r2 = openRequest(h, 'p_1', 'p_2', 5);
  assert.deepEqual(m.handle('p_2', { t: 'g.econ.respond', id: r2.id, approve: true }), { ok: true });
  assert.equal(m.econRound.spent, 10, 'the cap is 8 + 4 now');
  assert.deepEqual(m.handle('p_2', { t: 'g.econ.request', to: 'p_0', amount: 3 }), { error: ERR.BAD_TARGET, detail: 'team cap' });
  m.teamProjects.logistics = 3;
  assert.equal(m.econRequestsPerRound(), 2);
  checkInvariants(m);
  m.dispose();
});

test('a perfect battle feeds the reserve, capped per round', () => {
  const h = teamMatch({ fake: true }).start();
  h.toPrep(1);
  const m = h.m;
  h.ps('p_0').funds = 0;
  h.ps('p_1').funds = 0;
  h.drive(() => m.phase === PHASE.PREP && m.round === 2);
  assert.equal(m.teamReserve, 2, 'two perfect battles, cap 2');
  checkInvariants(m);
  m.dispose();
});

test('a leaked battle pays nothing into the reserve', () => {
  const leakAll = (b) => ({ leaks: Object.fromEntries(b.players.map((pid) => [pid, 2])) });
  const h = teamMatch({ fake: true, script: leakAll }).start();
  h.toPrep(1);
  const m = h.m;
  h.ps('p_0').funds = 0;
  h.ps('p_1').funds = 0;
  h.drive(() => m.phase === PHASE.PREP && m.round === 2);
  assert.equal(m.teamReserve, 0, 'no reward for failure');
  m.dispose();
});

test('a bot teammate answers a request when it can spare the funds', () => {
  const h = teamMatch({ humans: 1, bots: 1, seed: 30 }).start();
  h.toPrep(1);
  const m = h.m;
  const human = h.ps('p_0');
  const bot = h.ps('ai_0');
  bot.funds = 10;
  openRequest(h, 'p_0', 'ai_0', 3);
  h.sched.advance(1);
  assert.equal(m.econRequests.size, 0, 'the bot answered');
  assert.equal(human.funds, 7, 'R1 income 4 + 3');
  assert.equal(bot.funds, 7);
  checkInvariants(m);
  m.dispose();
});

test('a bot refuses when the transfer would eat its reserve', () => {
  const h = teamMatch({ humans: 1, bots: 1, seed: 31 }).start();
  h.toPrep(1);
  const m = h.m;
  const human = h.ps('p_0');
  const bot = h.ps('ai_0');
  bot.funds = 1;
  openRequest(h, 'p_0', 'ai_0', 3);
  h.sched.advance(1);
  assert.equal(m.econRequests.size, 0, 'the bot answered');
  assert.equal(human.funds, 4, 'nothing moved');
  assert.equal(bot.funds, 1);
  m.dispose();
});

test('a broke bot asks a teammate for funds', () => {
  const h = teamMatch({ humans: 1, bots: 1, seed: 32 }).start();
  h.toPrep(1);
  const m = h.m;
  const bot = h.ps('ai_0');
  bot.funds = 0;
  bot.ready = false; // re-open its prep routine (as the round start does)
  m.scheduleBotPrep(bot, 0);
  h.run(() => m.econRequests.size > 0 || h.ended != null, { maxSteps: 2e5 });
  assert.equal(m.econRequests.size, 1, 'the bot asked');
  const req = [...m.econRequests.values()][0];
  assert.equal(req.from, 'ai_0');
  assert.equal(req.to, 'p_0', 'the first alive teammate');
  assert.ok(req.amount >= 1 && req.amount <= 5);
  checkInvariants(m);
  m.dispose();
});

test('协同共竞 (mode_xie_*): the borrowing rule set is on and borrow-only', () => {
  const gd = new GameData(DATA, 'mode_xie_normal');
  assert.ok(gd.teamEconomy, 'the mode itself enables the rule set');
  assert.equal(gd.teamEconomy.borrowOnly, true, 'borrow-only: no conversion, no perfect rewards, no projects');
  const xie = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 41, data: DATA, modeId: 'mode_xie_normal' }).start();
  xie.toPrep(1);
  const m = xie.m;
  assert.ok(m.teamEcon && m.teamEcon.borrowOnly, 'the match runs the borrow-only rule set');
  xie.ps('p_0').funds = 0;
  xie.ps('p_1').funds = 9;
  // 协同共竞 borrows ONE fund at a time (the mode's per-request cap)
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.request', to: 'p_1', amount: 2 }), { error: ERR.BAD_TARGET, detail: 'amount' });
  const req = openRequest(xie, 'p_0', 'p_1', 1);
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: true }), { ok: true });
  assert.equal(xie.ps('p_0').funds, 1, '借钱 works, one fund at a time');
  assert.equal(xie.ps('p_1').funds, 8);
  const view = m.publicView().econ;
  assert.equal(view.borrowOnly, true);
  assert.deepEqual(view.projects, [], 'no projects advertised');
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.project', project: 'procure' }), { error: ERR.WRONG_PHASE, detail: 'projects disabled' });
  assert.equal(new GameData(DATA, 'mode_multi_normal').teamEconomy, null, 'the plain multi mode stays untouched');
  m.dispose();
});

// ---------------------------------------------------------------------------------------------------
// 方案 B (user decision 2026-10-07): a loan is repaid out of the borrower's next income, with interest —
// funds still clear every round, so the debt rides on income; a borrower who dies first voids it and the
// survivors dice out the income that player would have earned (deathDividend).
// ---------------------------------------------------------------------------------------------------

/** The borrow-only numbers the 协同共竞 modes ship with, plus the balance knobs. */
const BAL = {
  borrowOnly: true,
  transfer: { maxPerRequest: 1, requestsPerRound: 1, teamCapPerRound: 8, ttlSec: 30, repayInterest: 1 },
  deathDividend: { enabled: true, dice: 6 },
};
const BAL_DATA = { ...DATA, config: { ...DATA.config, economy: { ...DATA.config.economy, team: { enabled: true, ...BAL } } } };
const balMatch = (o = {}) => makeMatch({ mode: 'coop', humans: 2, seed: 21, data: BAL_DATA, ...o });

/** Exactly what the 协同共竞 modes ship (data/config.json): principal only + the two PvE rewards + 借款意愿. */
const SHIP = {
  borrowOnly: true,
  transfer: { maxPerRequest: 1, requestsPerRound: 12, teamCapPerRound: 8, ttlSec: 30, repayInterest: 0 },
  deathDividend: { enabled: true, dice: 6 },
  coverInterest: { enabled: true, capPct: 100, lagPremium: 2 },
  botLend: { enabled: true, basePct: 10, weakPct: 20, solventPct: 10, coverPct: 10, maxPct: 50, tightFactorPct: 50, delayMsMin: 600, delayMsMax: 2200 },
  botAsk: { enabled: true, basePct: 8, keyPct: 60, maxPct: 50, keyMaxPct: 80 },
};
const SHIP_DATA = { ...DATA, config: { ...DATA.config, economy: { ...DATA.config.economy, team: { enabled: true, ...SHIP } } } };
const shipMatch = (o = {}) => makeMatch({ mode: 'coop', humans: 2, seed: 21, data: SHIP_DATA, ...o });

test('方案 B: the borrower repays the loan with interest out of the next income', () => {
  const h = balMatch().start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  const b = h.ps('p_1');
  a.funds = 0;
  b.funds = 9;
  const req = openRequest(h, 'p_0', 'p_1', 1);
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: true }), { ok: true });
  assert.equal(a.funds, 1, 'the loan arrived');
  assert.equal(b.funds, 8);
  // `lag` is the 兜底率分红 snapshot: false here, since neither board is behind the median (both are empty)
  assert.deepEqual(m.econDebts.get('p_0'), [{ to: 'p_1', amount: 2, round: 1, lag: false }], '1 + 1 interest');
  const next = m.gd.income(2);
  assert.deepEqual(m.econPrivateFor(a).owe, { total: 2, next }, 'the borrower sees what is due');
  assert.deepEqual(m.econPrivateFor(b).due, { total: 2, next }, 'and the lender what is owed');
  h.toPrep(2);
  assert.equal(a.funds, next - 2, 'paid out of the income, not out of a carried balance');
  assert.equal(b.funds, next + 2);
  assert.equal(m.econDebts.size, 0, 'settled exactly once');
  assert.equal(m.econPrivateFor(a).owe, null);
  checkInvariants(m);
  m.dispose();
});

test('阵亡分红: a fallen teammate\'s would-be next income goes to the survivors (one survivor takes it all)', () => {
  const h = balMatch().start();
  h.toPrep(1);
  const m = h.m;
  const victim = h.ps('p_1');
  const survivor = h.ps('p_0');
  survivor.funds = 0;                     // funds clear at the prep end anyway: measure the dividend alone
  const pool = m.gd.income(2) + victim.pendingFunds;
  victim.lp = 0;
  assert.ok(h.drive(() => !victim.alive), 'the victim is out');
  assert.equal(survivor.funds, pool, `the survivor received the whole pool (${pool})`);
  checkInvariants(m);
  m.dispose();
});

test('阵亡分红: with more than one survivor the dice split the pool exactly, never above it', () => {
  const h = balMatch({ humans: 3 }).start();
  h.toPrep(1);
  const m = h.m;
  const victim = h.ps('p_2');
  const survivors = [h.ps('p_0'), h.ps('p_1')];
  for (const p of survivors) p.funds = 0;
  const pool = m.gd.income(2) + victim.pendingFunds;
  victim.lp = 0;
  assert.ok(h.drive(() => !victim.alive), 'the victim is out');
  const gained = survivors.map((p) => p.funds);
  assert.equal(gained.reduce((n, g) => n + g, 0), pool, 'the pool is spent exactly');
  assert.ok(gained.every((g) => g >= 0 && g <= pool), 'no share above the pool');
  checkInvariants(m);
  m.dispose();
});

test('a debt dies with the borrower: it is void, and the lender only gets the dividend', () => {
  const h = balMatch().start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  const b = h.ps('p_1');
  a.funds = 0;
  b.funds = 9;
  const req = openRequest(h, 'p_0', 'p_1', 1);
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: true }), { ok: true });
  assert.equal(m.econDebts.size, 1);
  const pool = m.gd.income(2) + a.pendingFunds;
  b.funds = 0;                            // as above: the prep end clears it, so this measures the dividend
  a.lp = 0;
  assert.ok(h.drive(() => !a.alive), 'the borrower is out');
  assert.equal(m.econDebts.size, 0, 'the debt is void');
  assert.equal(b.funds, pool, 'the lender was not repaid out of thin air — the survivor dividend is all it got');
  checkInvariants(m);
  m.dispose();
});

test('兜底利息: the rate is 兜底 kills over the match\'s planned enemies, capped, and pays whole funds only', () => {
  const h = shipMatch().start();
  h.toPrep(1);
  const m = h.m;
  assert.ok(m.econCoverTotal > 0, 'the match planned an enemy total');
  assert.equal(m.econCoverRate('p_0'), 0, 'nothing covered yet');
  // the first nine rounds cannot even spawn the whole match: the rate cannot reach 100% that early
  const total = m.econCoverTotal;
  assert.ok(total >= 200, `planned total ${total}`);
  m.econCoverTally({ perPlayer: { p_0: { killed: Math.floor(total / 4) } } }, ['p_0']);
  assert.ok([24, 25].includes(m.econCoverRate('p_0')), `a quarter covered ≈ 25% (${m.econCoverRate('p_0')}%)`);
  m.econCoverTally({ perPlayer: { p_0: { killed: total } } }, ['p_0']);
  assert.equal(m.econCoverRate('p_0'), 100, 'capped at 100%');
  assert.equal(m.econCoverPayout('p_0', 1), 1, 'a 1-fund loan at 100% pays 1 interest — whole funds only');
  assert.equal(m.econCoverPayout('p_0', 0), 0);
  checkInvariants(m);
  m.dispose();
});

test('兜底利息: interest accrues fractionally across loans and is only ever paid in whole funds', () => {
  const h = shipMatch().start();
  h.toPrep(1);
  const m = h.m;
  const total = m.econCoverTotal;
  m.econCoverTally({ perPlayer: { p_0: { killed: Math.floor(total / 3) } } }, ['p_0']);   // 33%
  assert.equal(m.econCoverRate('p_0'), 33);
  assert.equal(m.econCoverPayout('p_0', 1), 0, '33% of one fund is not a whole fund yet');
  assert.equal(m.econCoverPayout('p_0', 1), 0, 'still not');
  assert.equal(m.econCoverPayout('p_0', 1), 0);
  assert.equal(m.econCoverPayout('p_0', 1), 1, 'the fourth loan crosses one whole fund (1.32)');
  assert.equal(m.econCoverPayout('p_0', 1), 0, 'and the remainder carries on');
  checkInvariants(m);
  m.dispose();
});

test('兜底利息: a qualified lender is paid the principal plus the earned interest, an unqualified one the principal', () => {
  const h = shipMatch().start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  const b = h.ps('p_1');
  a.funds = 0;
  b.funds = 9;
  const req = openRequest(h, 'p_0', 'p_1', 1);
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: true }), { ok: true });
  assert.deepEqual(m.econDebts.get('p_0'), [{ to: 'p_1', amount: 1, round: 1, lag: false }], 'the principal only (repayInterest 0)');
  m.econCoverTally({ perPlayer: { p_1: { killed: m.econCoverTotal } } }, ['p_1']);   // fully covered
  h.toPrep(2);
  const next = m.gd.income(2);
  assert.equal(b.funds, next + 1 + 1, 'income + principal + the 兜底 interest');
  assert.equal(a.funds, next - 1, 'the borrower paid the principal');
  checkInvariants(m);
  m.dispose();
});

test('兜底利息: off by default (a plain team-economy match pays no interest)', () => {
  const h = teamMatch().start();
  h.toPrep(1);
  const m = h.m;
  assert.equal(m.econCoverRate('p_0'), 0);
  assert.equal(m.econPrivateFor(h.ps('p_0')).cover, null, 'not even advertised');
  m.dispose();
});

test('the first nine rounds cannot fill the 兜底 rate (calibration guard)', () => {
  // The rate is 兜底 kills / the match's planned enemies, and a 兜底 kill needs the enemy to exist first: rounds 1–9
  // spawn well under the whole match, so a 100% rate is impossible before round 10 by construction (calibrated
  // 2026-10-07: 125 of 240 = 52.1% in 标准, hence the 60% guard below). A change to the wave tables trips this.
  const gd = new GameData(DATA, 'mode_xie_normal');
  assert.ok(gd.lastRound >= 14, 'the co-op modes run 14 rounds');
  const rng = createRng(7);
  const per = [];
  for (let r = 1; r <= gd.lastRound; r++) {
    const boss = r === gd.bossRound || r === gd.hiddenRound;
    const wave = boss
      ? buildBossWave(gd, rng, ['rhodes'], r, { bossId: gd.bossRound === r ? 'b' : 'h', solo: false })
      : buildNormalWave(gd, rng, ['rhodes'], r);
    per.push((wave.spawns || []).reduce((n, s) => n + (Number(s.count) || 1), 0));
  }
  const total = per.reduce((n, c) => n + c, 0);
  const first9 = per.slice(0, 9).reduce((n, c) => n + c, 0);
  assert.ok(total > 0, 'the mode spawns enemies');
  assert.ok(first9 / total < 0.6, `rounds 1–9 spawn ${first9}/${total} = ${(100 * first9 / total).toFixed(1)}% < 60%`);
});

test('借款预算 = min(配置, 他下回合的收入)，所以债务永远还得起 (user decision 2026-10-08)', () => {
  const h = shipMatch().start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  const b = h.ps('p_1');
  const next = m.gd.income(2);
  assert.equal(m.econRequestsPerRound(a), next, `round 1 budget = income(2) = ${next}`);
  assert.equal(m.econPrivateFor(a).requestLeft, next, 'advertised to the client');
  a.funds = 0;
  b.funds = next + 2;
  // spend the whole budget on the one teammate (2P): every loan is 1 fund, the debt lands on the next income
  for (let i = 0; i < next; i++) {
    const req = openRequest(h, 'p_0', 'p_1', 1);
    assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: true }), { ok: true });
  }
  assert.equal(a.funds, next, 'borrowed up to the next income');
  assert.equal(m.econPrivateFor(a).requestLeft, 0, 'and not one more');
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.request', to: 'p_1', amount: 1 }), { error: ERR.ALREADY });
  assert.equal(m.econPrivateFor(a).owe.total, next, 'the debt equals exactly the next income');
  assert.ok(m.econPrivateFor(a).owe.total <= next, 'so it is always repayable — nothing to forgive');
  b.funds = 0;                            // funds clear at the prep end anyway: measure the repayment against income
  h.toPrep(2);
  assert.equal(a.funds, 0, 'the whole income went to the debt');
  assert.equal(b.funds, next + next, 'income + every principal back');
  assert.equal(m.econDebts.size, 0);
  checkInvariants(m);
  m.dispose();
});

test('借款预算被配置上限压住时以配置为准（后勤调度 L3 的额外次数也受同一封顶）', () => {
  const h = balMatch().start();           // requestsPerRound 1, no logistics
  h.toPrep(1);
  const m = h.m;
  assert.equal(m.econRequestsPerRound(h.ps('p_0')), 1, 'the configured 1 binds below the income');
  assert.equal(m.econPrivateFor(h.ps('p_0')).requestLeft, 1);
  m.dispose();
});

test('both knobs are off by default: no debt, no dividend (every other mode keeps its behaviour)', () => {
  const h = teamMatch().start();          // the shipped TEAM config: repayInterest 0, no deathDividend
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  const b = h.ps('p_1');
  a.funds = 0;
  b.funds = 9;
  const req = openRequest(h, 'p_0', 'p_1', 2);
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: true }), { ok: true });
  assert.equal(m.econDebts.size, 0, 'a plain transfer leaves no debt');
  b.funds = 0;
  a.lp = 0;
  assert.ok(h.drive(() => !a.alive), 'the borrower is out');
  assert.equal(b.funds, 0, 'no dividend while the rule is off');
  m.dispose();
});

// ---------------------------------------------------------------------------------------------------
// 借款意愿 + 兜底率分红 (user decision 2026-10-08): the bot lender answers on a seeded roll instead of the flat
// rule — basePct plus the borrower's under-development, their repayment safety and the lender's own 兜底 rate,
// capped at maxPct — and a loan taken on while the borrower trailed the team's median earns the lagPremium.
// ---------------------------------------------------------------------------------------------------

/** Force a board size without playing a real placement (deployCount counts chess pieces on ps.board). */
const setUnits = (ps, n) => Object.defineProperty(ps, 'deployCount', { value: n, configurable: true });

test('借款意愿: base + 落后 + 还款安全 + 兜底率, capped at maxPct (the shipped numbers)', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 7, data: SHIP_DATA }).start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');    // the borrower in the checks below
  const b = h.ps('p_1');
  const ai = h.ps('ai_0');  // the lender (its own 兜底 rate scales coverPct)
  assert.ok(m.teamEcon.botLend && m.teamEcon.botLend.enabled, 'the shipped modes turn 借款意愿 on');
  // three equal boards, equal LP: nobody is behind, everyone looks solvent
  for (const ps of [a, b, ai]) { setUnits(ps, 4); ps.lp = 20; }
  assert.equal(m.econBotLendChance(ai, 'p_0'), 20, 'base 10 + solvent 10');
  // half the median board = fully behind (and still solvent)
  setUnits(a, 2);
  assert.equal(m.econBotLendChance(ai, 'p_0'), 40, '10 + 20 落后 + 10 安全');
  // LP below the team's median: not "safe to repay" any more
  a.lp = 5;
  assert.equal(m.econBotLendChance(ai, 'p_0'), 30, '10 + 20, no solvent bonus');
  // a wiped board is fully behind AND not solvent
  setUnits(a, 0);
  a.lp = 20;
  assert.equal(m.econBotLendChance(ai, 'p_0'), 30, '10 + 20, no solvent bonus');
  // the lender's own 兜底 rate: 50% covered adds half of coverPct, 100% adds all of it
  setUnits(a, 2);
  m.econCoverTally({ perPlayer: { ai_0: { killed: Math.ceil(m.econCoverTotal / 2) } } }, ['ai_0']);
  assert.equal(m.econCoverRate('ai_0'), 50);
  assert.equal(m.econBotLendChance(ai, 'p_0'), 45, '10 + 20 + 10 + 5');
  m.econCoverTally({ perPlayer: { ai_0: { killed: m.econCoverTotal * 2 } } }, ['ai_0']);
  assert.equal(m.econCoverRate('ai_0'), 100);
  assert.equal(m.econBotLendChance(ai, 'p_0'), 50, 'at the cap');
  // nobody has units yet: no one is "behind", nobody looks solvent — but the lender's own 100% 兜底 rate still counts
  for (const ps of [a, b, ai]) setUnits(ps, 0);
  assert.equal(m.econBotLendChance(ai, 'p_0'), 20, 'empty boards: the base + the fully-covered lender');
  checkInvariants(m);
  m.dispose();

  // a lower cap binds (the knob is what the user set, not the sum of the parts)
  const capped = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 7, data: { ...SHIP_DATA, config: { ...SHIP_DATA.config, economy: { ...SHIP_DATA.config.economy, team: { enabled: true, ...SHIP, botLend: { ...SHIP.botLend, maxPct: 15 } } } } } }).start();
  capped.toPrep(1);
  const cm = capped.m;
  for (const ps of [capped.ps('p_0'), capped.ps('p_1'), capped.ps('ai_0')]) { setUnits(ps, 4); ps.lp = 20; }
  setUnits(capped.ps('p_0'), 0);
  assert.equal(cm.econBotLendChance(capped.ps('ai_0'), 'p_0'), 15, 'everything above maxPct falls back to it');
  cm.dispose();
});

/** The shipped rule set with the roll pinned to one extreme (basePct 0 = always refuse, 100 = always approve). */
const rollData = (basePct, extra = {}) => ({
  ...DATA,
  config: {
    ...DATA.config,
    economy: {
      ...DATA.config.economy,
      team: { enabled: true, ...SHIP, botLend: { ...SHIP.botLend, basePct, weakPct: 0, solventPct: 0, coverPct: 0, maxPct: 100, delayMsMin: 0, delayMsMax: 0, ...extra } },
    },
  },
});

test('借款意愿: the bot answers after its thought delay, never instantly, and the roll decides', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 5, data: rollData(100, { delayMsMin: 600, delayMsMax: 2200 }) }).start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  const ai = h.ps('ai_0');
  a.funds = 0;
  ai.funds = 6;
  // an idle bot seat: a bot keeps shopping on its own clock (a refresh repopulates any shop we blank), so park it
  // ready instead — a bot lender may answer a request while ready (only humans are locked out by it)
  ai.ready = true;
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.request', to: 'ai_0', amount: 1 }), { ok: true }, 'the 0-fund seat can ask the bot');
  const req = [...m.econRequests.values()][0];
  assert.ok(req && req.decideAt >= 600, `the bot waits before answering (${req && req.decideAt} ms)`);
  // its ordinary prep slice must not answer early either (botEconRespond honours decideAt)
  h.sched.advance(300);
  assert.equal(m.econRequests.size, 1, 'still thinking after 300 ms');
  assert.equal(a.funds, 0, 'no funds moved yet');
  const aiBefore = ai.funds;
  h.sched.advance(2000);
  assert.equal(m.econRequests.size, 0, 'answered after the delay');
  assert.equal(a.funds, 1, 'basePct 100 approves');
  assert.equal(ai.funds, aiBefore - 1, 'the lender paid the fund');
  checkInvariants(m);
  m.dispose();

  const no = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 5, data: rollData(0) }).start();
  no.toPrep(1);
  const nm = no.m;
  const na = no.ps('p_0');
  const nai = no.ps('ai_0');
  na.funds = 0;
  nai.funds = 6;
  nai.ready = true;
  assert.deepEqual(nm.handle('p_0', { t: 'g.econ.request', to: 'ai_0', amount: 1 }), { ok: true });
  assert.equal(nm.econBotLendChance(nai, 'p_0'), 0, 'basePct 0: nothing to roll');
  no.sched.advance(3000);
  assert.equal(nm.econRequests.size, 0, 'answered');
  assert.equal(na.funds, 0, 'basePct 0 refuses');
  assert.equal(nai.funds, 6, 'the lender keeps its funds');
  nm.dispose();
});

test('借款意愿: off (the default) keeps the flat 0.1.x rule — no roll, instant answer', () => {
  const data = { ...DATA, config: { ...DATA.config, economy: { ...DATA.config.economy, team: { enabled: true, ...SHIP, botLend: { ...SHIP.botLend, enabled: false } } } } };
  // two bot seats: the second one has not refused anything, so the asker still has someone to turn to
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 2, seed: 5, data }).start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  const ai = h.ps('ai_0');
  const ai2 = h.ps('ai_1');
  ai.ready = true;  // an idle bot seat (see above): no own shopping while we watch the answer
  ai2.ready = true;
  a.funds = 0;
  ai.funds = 2; // funds − amount = 1 < reserve + 2 → refuse
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.request', to: 'ai_0', amount: 1 }), { ok: true });
  h.sched.advance(1);
  assert.equal(m.econRequests.size, 0, 'answered on the spot (later(0))');
  assert.equal(a.funds, 0, 'the flat rule refuses at 2 funds');
  assert.equal(m.econBotLendChance(ai, 'p_0'), 0, 'and reports no chance at all');
  a.funds = 0;
  ai2.funds = 4; // 4 − 1 ≥ 0 + 2 → approve
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.request', to: 'ai_1', amount: 1 }), { ok: true });
  h.sched.advance(1);
  assert.equal(m.econRequests.size, 0);
  assert.equal(a.funds, 1, 'the flat rule approves at 4 funds');
  m.dispose();
});

test('兜底率分红: a debt taken on behind the team earns the lagPremium, capped at 100% of the principal', () => {
  const h = shipMatch().start();
  h.toPrep(1);
  const m = h.m;
  const total = m.econCoverTotal;
  m.econCoverTally({ perPlayer: { p_0: { killed: Math.ceil(total / 2) } } }, ['p_0']); // the lender: 50% covered
  assert.equal(m.econCoverRate('p_0'), 50);
  // the premium only applies to a lagging debt and never pays more than double
  assert.equal(m.econCoverPayout('p_0', 1, 1), 0, 'a plain 1-fund loan at 50% accrues 0.5 — not a whole fund yet');
  m.econCoverAccrual.set('p_0', 0);
  assert.equal(m.econCoverPayout('p_0', 1, 2), 1, 'the same loan with the ×2 premium pays a whole fund at once');
  m.econCoverAccrual.set('p_0', 0);
  m.econCoverTally({ perPlayer: { p_0: { killed: total } } }, ['p_0']);
  assert.equal(m.econCoverRate('p_0'), 100);
  assert.equal(m.econCoverPayout('p_0', 1, 2), 1, 'capped at the principal: 借 1 永远不会收回 2');
  assert.equal(m.econCoverPayout('p_0', 1, 4), 1, 'even a larger premium obeys the cap');
  checkInvariants(m);
  m.dispose();
});

test('兜底率分红: the snapshot is taken when the loan is made (behind the median then = lag), and rides the settlement', () => {
  const h = shipMatch().start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');    // the behind borrower
  const b = h.ps('p_1');    // the lender
  // p_1 lends to the behind p_0: 2 units against a median of 4 → behind
  setUnits(a, 2);
  setUnits(b, 4);
  a.funds = 0;
  b.funds = 9;
  const req = openRequest(h, 'p_0', 'p_1', 1);
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: true }), { ok: true });
  const debt = m.econDebts.get('p_0') && m.econDebts.get('p_0')[0];
  assert.ok(debt && debt.lag === true, 'the debt remembers the borrower was behind');
  // the borrower develops afterwards: the snapshot must not change
  setUnits(a, 4);
  assert.equal(debt.lag, true, 'lag is a snapshot, not a live test');
  m.econCoverTally({ perPlayer: { p_1: { killed: Math.ceil(m.econCoverTotal / 2) } } }, ['p_1']); // 50% covered
  const income2 = m.gd.income(2);
  assert.ok(h.drive(() => m.phase === PHASE.PREP && m.round === 2), 'reached round 2');
  assert.equal(b.funds, income2 + 2, 'income + principal + one whole fund of premium interest (0.5 × 2)');
  assert.equal(a.funds, income2 - 1, 'the borrower paid the principal out of the new income');
  assert.equal(m.econDebts.size, 0, 'the ledger is clean');
  checkInvariants(m);
  m.dispose();
});

// ---------------------------------------------------------------------------------------------------
// 被拒后可换人再借 + 每回合重置 (user report 2026-10-08: "第二回合后借钱只能借一次，被拒绝后无法继续借，
// 被一个人拒后本回合还可以再向其他人借"). The budget and the team total were never re-armed, so they ran for the
// whole match instead of one round — that is what made round 2 look like it had one ask left.
// ---------------------------------------------------------------------------------------------------

test('the ask budget and the team transfer total are per round (user report 2026-10-08)', () => {
  const h = shipMatch().start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  const b = h.ps('p_1');
  a.funds = 0;
  b.funds = 40;
  // the round's budget is min(requestsPerRound 12, the income the loans are repaid from) — 5 at round 1
  const budget = m.econRequestsPerRound(a);
  assert.equal(budget, 5, 'income(2) = 5 caps the 12 in the config');
  for (let i = 0; i < budget; i++) {
    assert.deepEqual(m.handle('p_0', { t: 'g.econ.request', to: 'p_1', amount: 1 }), { ok: true }, `ask ${i + 1}`);
    const req = [...m.econRequests.values()][0];
    assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: true }), { ok: true });
  }
  assert.equal(m.econRound.spent, budget, 'the round 1 total is spent');
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.request', to: 'p_1', amount: 1 }), { error: ERR.ALREADY }, 'the budget is gone');
  h.drive(() => m.phase === PHASE.PREP && m.round === 2);
  assert.equal(m.econRound.spent, 0, 'round 2 starts with a fresh team total');
  assert.equal(m.econRound.byPlayer.get('p_0') || 0, 0, 'and a fresh ask budget');
  assert.equal(m.econPrivateFor(a).requestLeft, m.econRequestsPerRound(a), 'the whole budget is back');
  a.funds = 0;
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.request', to: 'p_1', amount: 1 }), { ok: true }, 'round 2 can borrow again');
  checkInvariants(m);
  m.dispose();
});

test('被拒后本回合还可以再向其他人借 (user decision 2026-10-08)', () => {
  const h = makeMatch({ mode: 'coop', humans: 3, seed: 44, data: SHIP_DATA }).start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  const b = h.ps('p_1');
  const c = h.ps('p_2');
  a.funds = 0;
  b.funds = 9;
  c.funds = 9;
  const budget = m.econRequestsPerRound(a);
  const req = openRequest(h, 'p_0', 'p_1', 1);
  assert.deepEqual(m.handle('p_1', { t: 'g.econ.respond', id: req.id, approve: false }), { ok: true });
  // the refusal gives the budget back…
  assert.equal(m.econPrivateFor(a).requestLeft, budget, 'a refusal does not spend the ask');
  // …but the same teammate is out of the running for this round
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.request', to: 'p_1', amount: 1 }), { error: ERR.ALREADY, detail: 'already refused' });
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.request', to: 'p_2', amount: 1 }), { ok: true }, 'another teammate is still fair game');
  assert.equal(m.econPrivateFor(a).requestLeft, budget - 1, 'and that one did spend it');
  h.drive(() => m.phase === PHASE.PREP && m.round === 2);
  assert.equal(m.econDeniedBy.size, 0, 'the round start forgets every refusal');
  checkInvariants(m);
  m.dispose();
});

test('a request that times out also gives the budget back (nobody ever said yes)', () => {
  const h = makeMatch({ mode: 'coop', humans: 3, seed: 45, data: SHIP_DATA }).start();
  h.toPrep(1);
  const m = h.m;
  const a = h.ps('p_0');
  a.funds = 0;
  h.ps('p_1').funds = 9;
  const budget = m.econRequestsPerRound(a);
  const req = openRequest(h, 'p_0', 'p_1', 1);
  assert.equal(m.econPrivateFor(a).requestLeft, budget - 1);
  h.sched.advance(31_000);                       // past the 30 s TTL
  assert.equal(m.econRequests.size, 0, 'expired');
  assert.equal(m.econPrivateFor(a).requestLeft, budget, 'the budget came back');
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.request', to: 'p_1', amount: 1 }), { error: ERR.ALREADY, detail: 'already refused' });
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.request', to: 'p_2', amount: 1 }), { ok: true });
  checkInvariants(m);
  m.dispose();
});

// ---------------------------------------------------------------------------------------------------
// AI 主动借钱 (user decision 2026-10-08): a bot teammate asks on a seeded roll — an ordinary ask stays under
// maxPct (50), a 关键节点 (a 调度中心 level-up it cannot fund, or an elite chess it cannot buy) may reach
// keyMaxPct (80). "达不到没事，49也可以" — the cap is a ceiling, not a promise.
// ---------------------------------------------------------------------------------------------------

/** The shipped rule set with the ask roll pinned to one extreme, and no bot thought delay. */
const askData = (basePct, extra = {}) => ({
  ...DATA,
  config: {
    ...DATA.config,
    economy: {
      ...DATA.config.economy,
      team: { enabled: true, ...SHIP, botLend: { ...SHIP.botLend, delayMsMin: 0, delayMsMax: 0 }, botAsk: { enabled: true, basePct, keyPct: 0, maxPct: 50, keyMaxPct: 80, ...extra } },
    },
  },
});

test('AI 主动借钱: 平时 ≤50，关键节点 ≤80，且都以配置为准 (user decision 2026-10-08)', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 11, data: askData(0) }).start();
  h.toPrep(1);
  const m = h.m;
  const ai = h.ps('ai_0');
  assert.ok(m.teamEcon.botAsk && m.teamEcon.botAsk.enabled, 'the shipped modes turn 主动借钱 on');
  // an ordinary prep with money in hand and no key moment: basePct 0 never asks, basePct 100 always does
  assert.equal(botEconKeyMoment(m, ai), 0, 'no key moment to report yet');
  assert.equal(botEconMaybeRequest(m, ai), false, 'basePct 0: never asks');
  assert.equal(m.econRequests.size, 0);

  const always = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 11, data: askData(100) }).start();
  always.toPrep(1);
  const am = always.m;
  const aai = always.ps('ai_0');
  assert.equal(botEconMaybeRequest(am, aai), true, 'basePct 100: asks');
  const req = [...am.econRequests.values()][0];
  assert.ok(req && req.from === 'ai_0', 'the bot is the asker');
  assert.ok(req.amount >= 1);
  always.m.dispose();

  // the cap is a ceiling: an ordinary ask stops at maxPct, a 关键节点 at keyMaxPct
  assert.equal(m.teamEcon.botAsk.maxPct, 50, 'ordinary asks never exceed 50');
  assert.equal(m.teamEcon.botAsk.keyMaxPct, 80, 'a 关键节点 may reach 80');
  assert.equal(Math.min(m.teamEcon.botAsk.keyMaxPct, m.teamEcon.botAsk.basePct + m.teamEcon.botAsk.keyPct) <= 80, true);
  checkInvariants(m);
  m.dispose();
});

test('AI 主动借钱: a 关键节点 is a level-up or an elite chess it cannot fund', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 13, data: askData(0) }).start();
  h.toPrep(1);
  const m = h.m;
  const ai = h.ps('ai_0');
  const gd = m.gd;
  // a level-up the bot wants but cannot pay for: the gap is what it is short of (round 7: the level curve wants it)
  m.round = 7;
  ai.shop.level = 2;
  ai.shop.upgradePrice = 6;
  ai.funds = 2;
  assert.equal(botEconKeyMoment(m, ai), 4, 'four funds short of the level');
  ai.funds = 9;
  assert.equal(botEconKeyMoment(m, ai), 0, 'it can pay for it now — not a moment any more');
  // an elite chess in the shop it cannot buy is a moment too
  ai.shop.level = gd.maxShopLevel;               // no level-up left to want
  const elite = [...Object.keys(DATA.chess)].find((id) => gd.isGolden(id));
  assert.ok(elite, 'the data has elite chess');
  ai.shop.slots = [{ id: elite, kind: 'chess', basePrice: 5, sold: false }];
  ai.funds = 1;
  assert.equal(botEconKeyMoment(m, ai), 4, 'an elite chess it cannot afford');
  ai.funds = 9;
  assert.equal(botEconKeyMoment(m, ai), 0, 'affordable: nothing to borrow for');
  m.dispose();
});

test('AI 主动借钱: a refused bot turns to another teammate in the same round', () => {
  const h = makeMatch({ mode: 'coop', humans: 3, bots: 1, seed: 17, data: askData(100) }).start();
  h.toPrep(1);
  const m = h.m;
  const ai = h.ps('ai_0');
  assert.equal(botEconMaybeRequest(m, ai), true, 'the bot asks the first teammate');
  const req = [...m.econRequests.values()][0];
  assert.equal(req.to, 'p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.econ.respond', id: req.id, approve: false }), { ok: true });
  h.sched.advance(1500);                          // the bot's own clock (300–800 ms after the refusal)
  const next = [...m.econRequests.values()][0];
  assert.ok(next, 'it asked again');
  assert.equal(next.from, 'ai_0');
  assert.notEqual(next.to, 'p_0', 'and not the one who refused');
  checkInvariants(m);
  m.dispose();
});
