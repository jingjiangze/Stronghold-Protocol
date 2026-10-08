// server/match/match/revival.js — 救援 (促融共竞 / DESIGN §28).
//
// LP 归零不再当场淘汰：结算期开一个窗口，本回合在联防里替你挡过怪、且自己那场打得干净（无计漏）的存活队友，
// 可以花 REVIVAL_COST 点目标生命值把你救回 1 点（捐者至少留 1 点，所以门槛是 minDonorLp）。窗口只在结算期、
// 且队伍还没输（teamLp 仍为 null）时开放；窗口一关就真正淘汰，并把原因记在玩家身上供 UI 说明。
//
// 规则随模式开启（GameData.revival ← mode.revival.enabled），不是房间选项：促融共竞自带，别的模式没有。
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ERR, REVIVAL_COST, REVIVAL_MIN_DONOR_LP, REVIVAL_UNAVAILABLE_REASONS } from '../../../shared/constants.js';
import { msg } from '../../../shared/i18n.js';
import { FLOW_TICKER_PRIORITY, OK, fail } from './common.js';

export class MatchRevival {
  /** Called from the Match constructor once the seed and GameData exist (like econInit). */
  revivalInit() {
    this.revivalRule = this.gd.revival;                    // { cost, minDonorLp } or null
    this.revivalEnabled = !!this.revivalRule;
    this.revivalCost = this.revivalRule ? this.revivalRule.cost : REVIVAL_COST;
    this.revivalMinDonorLp = this.revivalRule ? this.revivalRule.minDonorLp : REVIVAL_MIN_DONOR_LP;
    /** @type {{ round: number, windowOpen: boolean, eligible: Set<string> } | null} */
    this.revival = null;
  }

  /**
   * Who may donate this round: they were a helper in this round's 联防 field, their own normal battle was clean (no
   * counted leaks, not synthetic), and they are still here. A helper who leaked themselves has no standing to spend
   * LP on someone else — that is the point of the rule.
   */
  revivalEligibleHelpers(plan, uniteResult) {
    const eligible = new Set();
    if (!this.revivalEnabled) return eligible;
    if (!plan || plan !== this.unitePlan || !uniteResult || uniteResult.synthetic) return eligible;
    if (!['cleared', 'timeout'].includes(uniteResult.reason)) return eligible;
    const field = this.fields.find((f) => f.kind === 'unite');
    if (!field) return eligible;
    for (const ps of plan.helpers) {
      const normal = this.lastResults.get(ps.playerId);
      if (this.players.get(ps.playerId) !== ps || !field.players.includes(ps.playerId)
        || !uniteResult.perPlayer?.[ps.playerId] || !normal || normal.synthetic || normal.perfect === false
        || (normal.leaked || []).some((l) => l && l.counted !== false)) continue;
      eligible.add(ps.playerId);
    }
    return eligible;
  }

  /** Opened for the round a death was deferred in, and only while the settle phase (and the match) is still going. */
  revivalWindowOpen() {
    const state = this.revival;
    return !!(this.revivalEnabled && !this.ended && !this.disposed && this.phase === PHASE.SETTLE
      && this.teamLp == null && state && state.windowOpen && state.round === this.round);
  }

  revivalDonorEligible(ps) {
    return !!(ps && !ps.isBot && !ps.left && ps.alive && Number.isFinite(ps.lp) && ps.lp >= this.revivalMinDonorLp
      && this.revival?.round === this.round && this.revival.eligible.has(ps.playerId));
  }

  /** A downed player still in the window: LP spent, not yet eliminated, and not rescued before. */
  revivalTargetEligible(ps) {
    return !!(ps && !ps.isBot && !ps.left && !ps.alive && ps.pendingDeath && !ps.revived);
  }

  /** Why this downed player cannot be rescued right now (one of REVIVAL_UNAVAILABLE_REASONS). */
  revivalDeathReason(ps) {
    if (ps.left) return 'left';
    if (ps.revived) return 'already-used';
    if (!this.revivalEnabled) return 'disabled';
    if (this.teamLp != null || this.ended || this.disposed) return 'match-ended';
    const helpers = this.order.filter((p) => this.players.get(p.playerId) === p && !p.isBot && !p.left && p.alive
      && this.revival?.round === this.round && this.revival.eligible.has(p.playerId));
    if (!helpers.length) return 'no-helper';
    return helpers.every((p) => Number.isFinite(p.lp) && p.lp < this.revivalMinDonorLp) ? 'donor-lp' : 'window-closed';
  }

  /**
   * LP ran out while 救援 is on: hold the player at 0 instead of eliminating them, and open the window. The settle
   * loop calls this; `afterSettle` finalises whatever is still pending.
   */
  revivalDefer(ps) {
    ps.revivalUnavailableReason = null;
    ps.lp = 0;
    ps.alive = false;
    ps.pendingDeath = true;
    ps.dirty();
    this.toast(ps, 'warn', '你的目标生命值耗尽，等待救援');
    if (!this.revival) this.revival = { round: this.round, windowOpen: true, eligible: new Set() };
    this.revival.round = this.round;
    this.revival.windowOpen = true;
  }

  /** Eliminate a held player for real (window closed, match over, or they left) — same path as a normal elimination. */
  revivalFinalize(ps, { notify = true, reason = null } = {}) {
    if (ps.alive || !ps.pendingDeath) return false;
    const why = reason || this.revivalDeathReason(ps);
    if (ps.revivalUnavailableReason == null) {
      ps.revivalUnavailableReason = REVIVAL_UNAVAILABLE_REASONS.includes(why) ? why : 'window-closed';
    }
    ps.lp = 0;
    ps.pendingDeath = false;
    this.eliminatePlayer(ps, { notify });
    return true;
  }

  /** The window is over: everyone still pending is eliminated, with the reason recorded for the UI. */
  revivalFinalizeAll({ notify = true, reason = null } = {}) {
    if (this.revival) this.revival.windowOpen = false;
    const why = reason || (this.ended || this.disposed ? 'match-ended'
      : this.teamLp != null ? 'match-ended' : 'window-expired');
    let n = 0;
    for (const ps of this.order) if (ps.pendingDeath) n += this.revivalFinalize(ps, { notify, reason: why }) ? 1 : 0;
    if (n) this.markPublic();
    return n;
  }

  /** C2S `g.revive { playerId, round }` — a helper spends LP to bring a downed teammate back with 1 LP. */
  revive(ps, message) {
    if (!this.revivalEnabled) return fail(ERR.WRONG_PHASE, 'revival-disabled');
    if (!this.revivalWindowOpen()) return fail(ERR.WRONG_PHASE, 'revival-window-closed');
    if (!Number.isInteger(message.round) || message.round !== this.round) return fail(ERR.WRONG_PHASE, 'stale-round');
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (!this.revivalDonorEligible(ps)) {
      return fail(ERR.BAD_TARGET, Number.isFinite(ps.lp) && ps.lp < this.revivalMinDonorLp ? 'revival-lp-insufficient' : 'revival-not-helper');
    }
    const target = this.players.get(message.playerId);
    if (target && !target.alive && !target.pendingDeath && !target.left && !target.revived) return fail(ERR.BAD_TARGET, 'revival-target-finalized');
    if (target === ps || !this.revivalTargetEligible(target)) return fail(ERR.BAD_TARGET, 'revival-target-ineligible');
    // Claim the rescue before anything else updates: a duplicate request from another helper cannot spend twice.
    target.revived = true;
    target.alive = true;
    target.pendingDeath = false;
    target.revivalUnavailableReason = null;
    target.lp = 1;
    ps.lp -= this.revivalCost; // >= minDonorLp before payment, so the donor always keeps at least 1 LP
    ps.stats.lpLost += this.revivalCost;
    target.dirty();
    ps.dirty();
    this.markPublic();
    this.toast(target, 'ok', msg('{name} 把你救了回来', { name: ps.name }));
    this.tickerText(msg('{name} 救援了 {target}', { name: ps.name, target: target.name }), FLOW_TICKER_PRIORITY);
    return OK;
  }

  /** The 救援 block of the public view, or null while the mode has no 救援 or nothing is pending. */
  revivalView() {
    if (!this.revivalEnabled) return null;
    const state = this.revival;
    const targets = this.order.filter((ps) => ps.pendingDeath).map((ps) => ({ playerId: ps.playerId, name: ps.name }));
    if (!state && !targets.length) return null;
    return {
      open: this.revivalWindowOpen(),
      round: state ? state.round : this.round,
      cost: this.revivalCost,
      minDonorLp: this.revivalMinDonorLp,
      donors: state ? [...state.eligible] : [],
      targets,
    };
  }
}
