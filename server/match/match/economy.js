// server/match/match/economy.js — Match methods: the co-op team economy (DESIGN §27) and the 协同共竞 borrow layer
// (§28) — the team reserve and its conversion, the 全员无伤 perfect reward, the logistics projects a mode ships, the
// 救济 draw on the reserve, the transfer requests (TTL, caps, the ready lock), the debt ledger the requests leave behind
// (方案 B: repaid out of the next income), the PvE 兜底 interest (holding teammates' leaked enemies) and the death
// dividend.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).
//
// Everything here is gated by `this.teamEcon` (GameData.teamEconomy, null unless the mode or config.economy.team turns
// the rule set on and the match is not solo), so the whole layer is inert — and every protocol addition optional —
// while it is off. State lives on the Match: `econRequests`, `econRound`, `econDebts`, `econCover*`, `teamReserve`,
// `teamProjects` (personal funds stay on PlayerState).

import { PHASE, ERR } from '../../../shared/constants.js';
import { OK, fail } from './common.js';
import { createRng, deriveSeed } from '../../sim/rng.js';
import { buildNormalWave, buildBossWave } from '../waves.js';
import { botEconRespond, botEconMaybeRequest } from '../bot.js';
import { msg } from '../../../shared/i18n.js';

/** 后勤项目 level-up toasts, one msgid per project so the name travels with it (the client has its own labels). */
const PROJECT_UP = {
  procure: (lv) => msg('联合采购 已升至 Lv{lv}', { lv }),
  storehouse: (lv) => msg('应急仓储 已升至 Lv{lv}', { lv }),
  logistics: (lv) => msg('后勤调度 已升至 Lv{lv}', { lv }),
};

export class MatchEconomy {
  /** The econ state (called from the Match constructor once the seed and GameData exist). */
  econInit() {
    this.teamEcon = this.gd.teamEconomy;
    this.teamReserve = 0;
    /** @type {Map<string, { id: string, from: string, to: string, amount: number, round: number, deadline: number, timer: any }>} */
    this.econRequests = new Map();
    this.econRound = { round: 0, spent: 0, byPlayer: new Map(), perfectGranted: 0 };
    /** The ids this player has already been refused by this round (被拒后可换人再借, user decision 2026-10-08). */
    this.econDeniedBy = new Map();
    /**
     * 方案 B: what each borrower owes, paid out of the income of the next round — Map<borrowerId, { to, amount, round }[]>.
     * Funds still clear every round; only the debt rides on income. A borrower who is eliminated before paying voids
     * it, and the survivors dice out what they would have earned (deathDividend).
     */
    this.econDebts = new Map();
    /**
     * 兜底利息 (PvE): holding teammates' leaked enemies earns interest on a repaid loan. `econCover` counts the kills a
     * 联防 helper made, `econCoverTotal` is the match's planned enemy total, and the rate is
     * `min(capPct, floor(100 × kills / total))` percent of the repaid principal — a rate the first nine rounds cannot
     * fill, because they can only spawn ~50% of the match's enemies at all (calibrated 2026-10-07: 125 of 251 in 标准).
     * Interest accrues fractionally per lender and is paid in whole funds only.
     */
    this.econCover = new Map();
    this.econCoverAccrual = new Map();
    this.econCoverTotal = 0;
    /**
     * The levels of the projects this mode ships (GameData.teamEconomy.projects): 协同共竞 lists 应急仓储 and 后勤调度
     * only, so 联合采购 has no entry here and `econBuyProject` cannot sell it (user decision 2026-10-09).
     */
    this.teamProjects = {};
    /**
     * 救济 (DESIGN §27, user decision 2026-10-09): how much the team has taken out of the reserve this round, and how
     * many times each player has taken. Both are re-armed by `econNewRound` — they are per round, like every other
     * economy counter.
     */
    this.econReliefSpent = 0;
    this.econReliefByPlayer = new Map();
    if (!this.teamEcon) return;
    for (const id of Object.keys(this.teamEcon.projects)) this.teamProjects[id] = 0;
    this.rngEcon = createRng(deriveSeed(this.seed, 'econ'));
    if (this.teamEcon.coverInterest.enabled) this.econCoverTotal = this._econCoverTotal();
  }

  // ---- gates and caps ------------------------------------------------------------------------------

  /** The econ gate: alive and in PREP; humans also obey the ready lock, a bot seat answers any time (it has no UI). */
  econGate(ps) {
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!ps.isBot && ps.ready) return fail(ERR.WRONG_PHASE, 'ready');
    return null;
  }

  /**
   * The per-player request budget of this round (后勤调度 L3 raises it), capped by **what the borrower will earn next
   * round** (user decision 2026-10-08): every loan is repaid out of that income, so a budget above it could not be
   * repaid — the debt is solvent by construction, and `econSettleDebts` never has to forgive.
   */
  econRequestsPerRound(ps = null) {
    if (!this.teamEcon) return 0;
    const extra = this.teamProjects.logistics >= 3 ? this.teamEcon.projects.logistics.extraRequestsAtL3 || 0 : 0;
    const base = this.teamEcon.transfer.requestsPerRound + extra;
    if (!ps) return base;
    return Math.max(0, Math.min(base, Math.trunc(this.gd.income(this.round + 1))));
  }

  /**
   * The round start re-arms the per-round counters: how many asks each player may still open, how much the team may
   * still move, and who has already said no (被拒后可换人再借, user decision 2026-10-08).
   */
  econNewRound() {
    if (!this.teamEcon) return;
    this.econRound.round = this.round;
    this.econRound.spent = 0;
    this.econRound.perfectGranted = 0;
    this.econRound.byPlayer.clear();
    this.econDeniedBy.clear();
    // 救济 is per round like everything else here: the team allowance and every player's count re-arm together
    this.econReliefSpent = 0;
    this.econReliefByPlayer.clear();
  }

  /** Funds the team may still move this round (the base cap + 后勤调度). */
  teamTransferCap() {
    if (!this.teamEcon) return 0;
    const lv = this.teamProjects.logistics;
    const bonus = lv > 0 ? this.teamEcon.projects.logistics.teamCapBonus[lv - 1] || 0 : 0;
    return this.teamEcon.transfer.teamCapPerRound + bonus;
  }

  /** Leftover funds a player keeps at the prep end (应急仓储). 坎诺特 bands keep everything and skip this reading. */
  teamKeepFor(ps) {
    void ps;
    return this.teamEcon ? this.teamProjects.storehouse : 0;
  }

  /** Free refreshes the round start grants (联合采购) — 0 when the mode does not ship that project. */
  teamFreeRefreshes() {
    return this.teamEcon ? (this.teamProjects.procure || 0) : 0;
  }

  // ---- views ---------------------------------------------------------------------------------------

  /** m.public.econ — the key exists only while the rule set is on (the client's capability probe). */
  econPublicView() {
    if (!this.teamEcon) return null;
    // 协同共竞: the borrow-only variant advertises no reserve, no projects and no relief — the client renders the asks
    if (this.teamEcon.borrowOnly) {
      return { borrowOnly: true, reserve: 0, transferLeft: Math.max(0, this.teamTransferCap() - this.econRound.spent), projects: [], relief: null };
    }
    const relief = this.teamEcon.relief;
    return {
      reserve: this.teamReserve,
      transferLeft: Math.max(0, this.teamTransferCap() - this.econRound.spent),
      // exactly the projects this mode ships, in the order its config names them
      projects: Object.keys(this.teamProjects).map((id) => {
        const level = this.teamProjects[id];
        const costs = this.teamEcon.projects[id].costs;
        return { id, level, cost: level < costs.length ? costs[level] : null };
      }),
      // 救济: the reserve the weakest player may draw on — `threshold`/`amount` are public, eligibility is private
      relief: relief.enabled
        ? { amount: relief.amount, threshold: relief.lpThreshold, left: Math.max(0, relief.teamPerRound - this.econReliefSpent) }
        : null,
    };
  }

  /** m.private.econ for one player (null while the rule set is off). */
  econPrivateFor(ps) {
    if (!this.teamEcon) return null;
    let out = null;
    let inn = null;
    for (const req of this.econRequests.values()) {
      if (req.from === ps.playerId) out = req;
      else if (req.to === ps.playerId) inn = req;
    }
    const brief = (req, key) => (req ? { id: req.id, [key]: req[key], amount: req.amount, deadline: req.deadline } : null);
    return {
      requestOut: brief(out, 'to'),
      requestIn: brief(inn, 'from'),
      requestLeft: Math.max(0, this.econRequestsPerRound(ps) - (this.econRound.byPlayer.get(ps.playerId) || 0)),
      // the teammates who refused this player this round (被拒后可换人再借): the client drops them from the picker, so
      // the 已拒绝 refusal never has to be shown as an error (user report 2026-10-08)
      refused: [...(this.econDeniedBy.get(ps.playerId) || [])],
      keep: this.teamKeepFor(ps),
      maxPerRequest: this.teamEcon.transfer.maxPerRequest,
      // 方案 B: what this player must pay back at the next income, and what teammates owe them
      owe: this.econDebtSummary(ps.playerId, 'from'),
      due: this.econDebtSummary(ps.playerId, 'to'),
      // 兜底利息: the coverage that buys interest on a repaid loan (null while the rule is off)
      cover: this.teamEcon.coverInterest.enabled
        ? {
          kills: this.econCover.get(ps.playerId) || 0,
          total: this.econCoverTotal,
          ratePct: this.econCoverRate(ps.playerId),
          capPct: this.teamEcon.coverInterest.capPct,
          accrued: Math.round((this.econCoverAccrual.get(ps.playerId) || 0) * 100) / 100,
          // 兜底率分红: outstanding debts owed to me that were taken on while the borrower trailed the team's median —
          // those earn `lagPremium` on repayment (the client shows it, user report 2026-10-08: 兜底率没有变化)
          lag: this.econDebtsOwedTo(ps.playerId, { lagOnly: true }).total,
          lagPremium: this.teamEcon.coverInterest.lagPremium,
        }
        : null,
      // 救济 (DESIGN §27): whether this player may draw on the reserve right now (the weakest, hurt enough, not spent
      // out) and how much of the round's allowance is left. The server is the authority; the client only renders it.
      relief: this.teamEcon.relief.enabled
        ? {
          eligible: this.econReliefEligible(ps),
          amount: this.teamEcon.relief.amount,
          threshold: this.teamEcon.relief.lpThreshold,
          left: Math.max(0, this.teamEcon.relief.perPlayerPerRound - (this.econReliefByPlayer.get(ps.playerId) || 0)),
        }
        : null,
    };
  }

  /** What teammates owe one player (`econDebtSummary` with the option of counting only the 兜底率分红 debts). */
  econDebtsOwedTo(playerId, { lagOnly = false } = {}) {
    let total = 0;
    for (const list of this.econDebts.values()) {
      for (const d of list) if (d.to === playerId && (!lagOnly || d.lag)) total += d.amount;
    }
    return { total };
  }

  /** `{ total, next }` for one side of the debt ledger (`from`: what I owe, `to`: what I am owed), null when clean. */
  econDebtSummary(playerId, side) {
    let total = 0;
    for (const [borrower, list] of this.econDebts) {
      for (const d of list) {
        if (side === 'from' ? borrower === playerId : d.to === playerId) total += d.amount;
      }
    }
    if (total <= 0) return null;
    return { total, next: Math.max(0, Math.trunc(this.gd.income(this.round + 1))) };
  }

  // ---- willingness (DESIGN §27) -------------------------------------------------------------------

  /** Median board size and LP of the alive team — the "behind the team" yardstick (upper median on an even count). */
  _econMedians() {
    const alive = [...this.players.values()].filter((p) => p.alive && !p.left);
    const pick = (vals) => {
      const s = vals.sort((a, b) => a - b);
      return s.length ? s[Math.floor(s.length / 2)] : 0;
    };
    return { units: pick(alive.map((p) => Math.max(0, Math.trunc(p.deployCount) || 0))), lp: pick(alive.map((p) => Number(p.lp) || 0)) };
  }

  /**
   * How far behind the team's median board a player is: 0 (at or above it, or nobody has units yet) .. 1 (half the
   * median or less — an empty board is 1). Used twice: the bot's willingness roll and the 兜底率分红 snapshot on a
   * debt (`lag` is simply "> 0", i.e. strictly below the team's median).
   */
  econBorrowerBehind(playerId) {
    const ps = this.players.get(playerId);
    if (!ps) return 0;
    const { units } = this._econMedians();
    if (units <= 0) return 0;
    return Math.max(0, Math.min(1, (2 * (units - Math.max(0, Math.trunc(ps.deployCount) || 0))) / units));
  }

  /**
   * 借款意愿 (DESIGN §27, user decision 2026-10-08): the percent chance a bot lender approves a request —
   * `basePct + weakPct · weak + solventPct · solvent + coverPct · cover`, capped at `maxPct` (50).
   *   weak    the borrower's board trails the team's median (the under-developed teammate this mode carries);
   *   solvent the borrower looks able to repay what the income ledger will charge (units on the board and LP at or
   *           above the median — the debt itself is always affordable, so death is the only way to default);
   *   cover   the lender's own 兜底 rate: the teammate who holds the leaks is the one who pays it forward.
   * Pure — the roll (`rngEcon.int(100) < p`) belongs to the caller.
   */
  econBotLendChance(lender, borrowerId) {
    const bl = this.teamEcon && this.teamEcon.botLend;
    if (!bl || !bl.enabled) return 0;
    const borrower = this.players.get(borrowerId);
    if (!borrower) return 0;
    const { lp } = this._econMedians();
    const mine = Math.max(0, Math.trunc(borrower.deployCount) || 0);
    const weak = this.econBorrowerBehind(borrowerId);
    const solvent = mine > 0 && (Number(borrower.lp) || 0) >= lp ? 1 : 0;
    const cover = this.econCoverRate(lender.playerId) / 100;
    const p = bl.basePct + Math.round(bl.weakPct * weak) + Math.round(bl.solventPct * solvent) + Math.round(bl.coverPct * cover);
    return Math.max(0, Math.min(bl.maxPct, p));
  }

  // ---- intents -------------------------------------------------------------------------------------

  /** g.econ.request (DESIGN §27): ask one teammate for funds — PREP only, and neither player may be ready. */
  econRequest(ps, to, amount) {
    if (!this.teamEcon) return fail(ERR.WRONG_PHASE, 'team economy disabled');
    const g = this.econGate(ps);
    if (g) return g;
    const target = typeof to === 'string' ? this.players.get(to) : null;
    if (!target || target === ps || !target.alive || target.left) return fail(ERR.BAD_TARGET, 'target');
    // neither player may be ready (the header rule): a ready teammate cannot act on the request, so asking them would
    // only burn the asker's budget (found by the 被借 e2e, 2026-10-07)
    if (!target.isBot && target.ready) return fail(ERR.WRONG_PHASE, 'target ready');
    if (!Number.isInteger(amount) || amount < 1 || amount > this.teamEcon.transfer.maxPerRequest) return fail(ERR.BAD_TARGET, 'amount');
    // being refused does not spend the round's budget: the asker may turn to another teammate in the same round
    // (user decision 2026-10-08). The refund happens when the refusal lands (econRespond) — a refusal on someone
    // else's clock (a bot's thought delay, or the TTL) returns the budget then, not at the moment of asking.
    const denied = this.econDeniedBy.get(ps.playerId);
    if (denied && denied.has(target.playerId)) return fail(ERR.ALREADY, 'already refused');
    if ((this.econRound.byPlayer.get(ps.playerId) || 0) >= this.econRequestsPerRound(ps)) return fail(ERR.ALREADY, 'budget');
    // one in-flight request per player, either role (a private view carries at most one of each)
    for (const req of this.econRequests.values()) {
      // one in-flight request per player, either role: the client says which of the two is waiting (detail 'pending')
      if (req.from === ps.playerId || req.to === ps.playerId || req.from === target.playerId || req.to === target.playerId) return fail(ERR.ALREADY, 'pending');
    }
    if (this.econRound.spent + amount > this.teamTransferCap()) return fail(ERR.BAD_TARGET, 'team cap');
    const ttl = this.teamEcon.transfer.ttlSec * 1000;
    const req = { id: `req:${this.nextUid()}`, from: ps.playerId, to: target.playerId, amount, round: this.round, deadline: this.sched.now() + ttl, timer: null };
    req.timer = this.later(ttl, () => { if (this.econRequests.get(req.id) === req) this.econCloseRequest(req, 'expired'); });
    this.econRequests.set(req.id, req);
    this.econRound.byPlayer.set(ps.playerId, (this.econRound.byPlayer.get(ps.playerId) || 0) + 1);
    // a bot teammate answers on its own clock: with 借款意愿 on, a random "thought about it" pause (the shipped
    // 0.6–2.2 s) instead of the old instant reply. `decideAt` also holds off the bot's ordinary prep slices
    // (botEconRespond checks it), and the get() guard drops the answer if the request is gone by then
    if (target.isBot) {
      const bl = this.teamEcon.botLend;
      const delay = bl && bl.enabled && bl.delayMsMax > 0 ? bl.delayMsMin + this.rngEcon.int(bl.delayMsMax - bl.delayMsMin + 1) : 0;
      if (delay > 0) req.decideAt = this.sched.now() + delay;
      this.later(delay, () => { if (this.econRequests.get(req.id) === req) botEconRespond(this, target, req.id); });
    }
    this.markPrivate(ps);
    this.markPrivate(target);
    this.markPublic();
    return OK;
  }

  /** g.econ.respond: approve (move the funds) or deny one incoming request — consumed exactly once, by id. */
  econRespond(ps, id, approve) {
    if (!this.teamEcon) return fail(ERR.WRONG_PHASE, 'team economy disabled');
    const req = typeof id === 'string' ? this.econRequests.get(id) : null;
    if (!req || req.to !== ps.playerId || req.round !== this.round) return fail(ERR.BAD_TARGET);
    const g = this.econGate(ps);
    if (g) return g;
    const sender = this.players.get(req.from);
    if (!sender || !sender.alive || sender.left) {
      this.econCloseRequest(req, 'gone');
      return fail(ERR.BAD_TARGET, 'target');
    }
    if (!approve) {
      this._econRefundAsk(req);
      this.econCloseRequest(req, 'denied');
      this.toast(sender, 'warn', msg('{name} 拒绝了你的支援请求', { name: ps.name }));
      // 被拒后本回合还可以再向其他人借 (user decision 2026-10-08): a bot asker turns to another teammate on its own
      // clock. The budget came back, and the one who said no is out of the running, so this terminates.
      if (sender.isBot && sender.alive && !sender.left) {
        const delay = 300 + this.rngEcon.int(500);
        this.later(delay, () => { if (this.phase === PHASE.PREP && sender.alive && !sender.left) botEconMaybeRequest(this, sender, { retry: true }); });
      }
      return OK;
    }
    if (this.econRound.spent + req.amount > this.teamTransferCap()) return fail(ERR.BAD_TARGET, 'team cap');
    if (ps.funds < req.amount) return fail(ERR.NO_FUNDS);
    ps.funds -= req.amount;
    sender.addFunds(req.amount, { reason: 'transfer' });
    this.econRound.spent += req.amount;
    // 方案 B + 兜底利息: the loan is paid back out of the borrower's next income — the principal, plus whatever
    // `transfer.repayInterest` charges; the PvE 兜底 interest rides on the same settlement. A mode with either rule on
    // keeps the ledger. `lag` is the 兜底率分红 snapshot: the borrower's board trailed the team's median when the loan
    // was made, so this debt earns the premium on repayment (the risk premium for carrying the under-developed).
    const interest = this.teamEcon.transfer.repayInterest;
    if (interest > 0 || this.teamEcon.coverInterest.enabled) {
      const list = this.econDebts.get(sender.playerId) || [];
      list.push({ to: ps.playerId, amount: req.amount + interest, round: this.round, lag: this.econBorrowerBehind(sender.playerId) > 0 });
      this.econDebts.set(sender.playerId, list);
    }
    this.econCloseRequest(req, 'settled');
    if (interest > 0) {
      this.toast(ps, 'info', msg('已向 {name} 提供 {amount} 资金（下回合归还 {total}）', { name: sender.name, amount: req.amount, total: req.amount + interest }));
      this.toast(sender, 'info', msg('{name} 提供了 {amount} 资金（下回合归还 {total}）', { name: ps.name, amount: req.amount, total: req.amount + interest }));
    } else {
      this.toast(ps, 'info', msg('已向 {name} 提供 {amount} 资金（下回合归还）', { name: sender.name, amount: req.amount }));
      this.toast(sender, 'info', msg('{name} 提供了 {amount} 资金（下回合归还）', { name: ps.name, amount: req.amount }));
    }
    ps.dirty();
    sender.dirty();
    return OK;
  }

  /** g.econ.project: buy one level of a logistics project out of the team reserve. */
  econBuyProject(ps, project) {
    if (!this.teamEcon) return fail(ERR.WRONG_PHASE, 'team economy disabled');
    if (this.teamEcon.borrowOnly) return fail(ERR.WRONG_PHASE, 'projects disabled');
    const g = this.econGate(ps);
    if (g) return g;
    if (!Object.hasOwn(this.teamProjects, project)) return fail(ERR.BAD_TARGET, 'project');
    const def = this.teamEcon.projects[project];
    const level = this.teamProjects[project];
    if (level >= def.costs.length) return fail(ERR.MAX_LEVEL);
    const cost = def.costs[level];
    if (this.teamReserve < cost) return fail(ERR.NO_FUNDS, 'reserve');
    this.teamReserve -= cost;
    this.teamProjects[project] = level + 1;
    this.markPublic();
    this.toast(ps, 'info', msg(PROJECT_UP[project], { lv: level + 1 }));
    return OK;
  }

  /**
   * 救济 (DESIGN §27, user decision 2026-10-09): whether this player may draw on the team reserve right now — alive,
   * in PREP, not ready, at or below `relief.lpThreshold` and (tied for) the team's lowest LP, with its own round
   * allowance left. A healthy team has nobody eligible: this is a lifeline for the player about to be eliminated, not
   * an income. Shared by the private view and the intent, so what the client shows and what the server accepts agree.
   * @param {any} ps
   * @returns {boolean}
   */
  econReliefEligible(ps) {
    const rl = this.teamEcon && this.teamEcon.relief;
    if (!rl || !rl.enabled || !ps || !ps.alive || ps.left) return false;
    if (this.phase !== PHASE.PREP || (!ps.isBot && ps.ready)) return false;
    if ((this.econReliefByPlayer.get(ps.playerId) || 0) >= rl.perPlayerPerRound) return false;
    const lp = Number(ps.lp) || 0;
    if (lp > rl.lpThreshold) return false;
    // the weakest: nobody alive sits strictly below this player (a tie lets both take)
    for (const p of this.players.values()) {
      if (!p.alive || p.left || p === ps) continue;
      if ((Number(p.lp) || 0) < lp) return false;
    }
    return true;
  }

  /**
   * g.econ.relief (DESIGN §27, user decision 2026-10-09): the weakest player takes funds straight out of the team
   * reserve — itself, not on anyone's behalf (「血最少的人自己选择取还是不取」), `relief.amount` at a time (「每次取1」).
   * Caps: `relief.perPlayerPerRound` per player and `relief.teamPerRound` for the team, both re-armed every round. It
   * is a grant, not a loan: nothing is owed back (the debt ledger belongs to the borrow protocol).
   */
  econRelief(ps) {
    const rl = this.teamEcon && this.teamEcon.relief;
    if (!rl || !rl.enabled) return fail(ERR.WRONG_PHASE, 'relief disabled');
    const g = this.econGate(ps);
    if (g) return g;
    if ((this.econReliefByPlayer.get(ps.playerId) || 0) >= rl.perPlayerPerRound) return fail(ERR.ALREADY, 'relief budget');
    if (!this.econReliefEligible(ps)) return fail(ERR.BAD_TARGET, 'not the weakest');
    if (this.econReliefSpent + rl.amount > rl.teamPerRound) return fail(ERR.ALREADY, 'team relief cap');
    if (this.teamReserve < rl.amount) return fail(ERR.NO_FUNDS, 'reserve');
    this.teamReserve -= rl.amount;
    this.econReliefSpent += rl.amount;
    this.econReliefByPlayer.set(ps.playerId, (this.econReliefByPlayer.get(ps.playerId) || 0) + 1);
    ps.addFunds(rl.amount, { reason: 'relief' });
    ps.dirty();
    this.toast(ps, 'info', msg('从协同资金领取了 {n} 资金', { n: rl.amount }));
    this.markPublic();
    this.markPrivate(ps);
    return OK;
  }

  // ---- closing -------------------------------------------------------------------------------------

  /**
   * A refusal that never reached the asker — its TTL ran out — also gives the budget back, the same way an explicit
   * 拒绝 does: the asker did not get the funds, so it may still turn to another teammate this round.
   */
  _econRefundAsk(req) {
    const used = this.econRound.byPlayer.get(req.from) || 0;
    if (used > 0) this.econRound.byPlayer.set(req.from, used - 1);
    let denied = this.econDeniedBy.get(req.from);
    if (!denied) this.econDeniedBy.set(req.from, (denied = new Set()));
    denied.add(req.to);
  }

  /** Close one request (its TTL, a deny/approve, the prep end, a leave, an elimination) — idempotent by identity. */
  econCloseRequest(req, reason) {
    if (!req) return;
    this.cancel(req.timer);
    req.timer = null;
    if (this.econRequests.get(req.id) !== req) return;
    this.econRequests.delete(req.id);
    const from = this.players.get(req.from);
    const to = this.players.get(req.to);
    if (from) this.markPrivate(from);
    if (to) this.markPrivate(to);
    if (reason === 'expired') {
      // nobody ever said yes: the budget comes back and the asker may still try another teammate this round
      this._econRefundAsk(req);
      if (from && from.alive && !from.isBot) this.toast(from, 'warn', '支援请求已超时');
    } else if (reason === 'prep-end' && from && from.alive && !from.isBot) {
      this.toast(from, 'warn', '休整期结束，支援请求已取消');
    }
  }

  /** Every pending request of one player (a leave, an elimination). */
  econCloseAllFor(playerId, reason) {
    for (const req of [...this.econRequests.values()]) if (req.from === playerId || req.to === playerId) this.econCloseRequest(req, reason);
  }

  /** The outgoing requests of one player (it readied up). */
  econCloseAllFrom(playerId, reason) {
    for (const req of [...this.econRequests.values()]) if (req.from === playerId) this.econCloseRequest(req, reason);
  }

  /** Every pending request (the prep end). */
  econCloseAll(reason) {
    for (const req of [...this.econRequests.values()]) this.econCloseRequest(req, reason);
  }

  // ---- prep end, debts and the two PvE rewards -----------------------------------------------------

  /** Prep end: leftover funds convert into the team reserve, capped (design §27). 坎诺特 bands keep everything. */
  econConvertLeftover(ps) {
    if (!this.teamEcon || this.teamEcon.borrowOnly) return;
    if (this.gd.leftoverKeptBands.includes(ps.bandId)) return;
    const conv = Math.min(Math.max(0, ps.funds - this.teamKeepFor(ps)), this.teamEcon.reserve.convertPerPlayerMax);
    if (conv <= 0) return;
    ps.funds -= conv;
    this.teamReserve += conv;
    ps.dirty();
    this.markPublic();
  }

  /**
   * 全员无伤 pays into the team reserve, capped per round (DESIGN §27, user decision 2026-10-09). settle.js calls this
   * once per settlement, and only when every alive player was charged nothing that round; it grants `perfectReward`
   * funds at a time, at most `perfectRewardCapPerRound` per round.
   */
  econPerfectReward() {
    if (!this.teamEcon || this.teamEcon.borrowOnly) return;
    const left = this.teamEcon.reserve.perfectRewardCapPerRound - this.econRound.perfectGranted;
    if (left <= 0) return;
    const n = Math.min(this.teamEcon.reserve.perfectReward, left);
    if (n <= 0) return;
    this.teamReserve += n;
    this.econRound.perfectGranted += n;
    this.markPublic();
  }

  /**
   * 方案 B (user decision 2026-10-07): every borrower pays what it owes out of the income it was just granted
   * (`PlayerState.startRound`), so the debt never touches the round-clearing funds rule. The round's budget is capped
   * by that very income, so a debt is always payable; whatever still cannot be paid is forgiven rather than rolled over.
   */
  econSettleDebts(alive) {
    if (!this.teamEcon || !this.econDebts.size) return;
    for (const ps of alive) {
      const list = this.econDebts.get(ps.playerId);
      if (!list || !list.length) continue;
      this.econDebts.delete(ps.playerId);
      let paid = 0;
      let due = 0;
      for (const d of list) {
        due += d.amount;
        const creditor = this.players.get(d.to);
        const pay = Math.max(0, Math.min(d.amount, ps.funds - paid));
        if (pay <= 0) continue;
        paid += pay;
        // a creditor who is gone takes nothing: the funds are not created anywhere else either
        if (creditor && creditor.alive && !creditor.left) {
          const lag = d.lag ? this.teamEcon.coverInterest.lagPremium : 1;
          const bonus = this.econCoverPayout(creditor.playerId, pay, lag);
          creditor.addFunds(pay + bonus, { reason: 'repay' });
          creditor.dirty();
          const rate = this.econCoverRate(creditor.playerId);
          this.toast(creditor, 'info', bonus > 0
            ? msg('{name} 归还了 {pay} 资金 · 兜底利息 +{bonus}（覆盖率 {rate}%）', { name: ps.name, pay, bonus, rate })
            : msg('{name} 归还了 {pay} 资金', { name: ps.name, pay }));
        }
      }
      if (paid <= 0) continue;
      ps.funds -= paid;
      ps.dirty();
      this.toast(ps, 'warn', due > paid
        ? msg('归还借款 {paid} 资金（差额已免除）', { paid })
        : msg('归还借款 {paid} 资金', { paid }));
    }
  }

  /** The match's planned enemy total (every round's wave, boss rounds included), built on a scratch rng. */
  _econCoverTotal() {
    const rng = createRng(deriveSeed(this.seed, 'econ-plan'));
    const last = Math.max(1, Number(this.gd.lastRound) || 1);
    let n = 0;
    for (let r = 1; r <= last; r++) {
      const boss = r === this.gd.bossRound || r === this.gd.hiddenRound;
      const wave = boss
        ? buildBossWave(this.gd, rng, this.factions, r, {
          bossId: r === this.gd.hiddenRound && r !== this.gd.bossRound ? this.hiddenBossId : this.bossId,
          solo: this.isSolo,
        })
        : buildNormalWave(this.gd, rng, this.factions, r);
      for (const s of wave.spawns || []) n += Math.max(1, Number(s.count) || 1);
    }
    return n;
  }

  /**
   * 兜底利息: how many of a teammate's leaked enemies this player's board held (the kills a 联防 field attributed to
   * it — the field's players are the helpers), and the integer percent that buys on a repaid loan.
   */
  econCoverTally(res, helpers) {
    if (!this.teamEcon || !this.teamEcon.coverInterest.enabled) return;
    for (const pid of helpers) {
      const k = Number(res && res.perPlayer && res.perPlayer[pid] && res.perPlayer[pid].killed) || 0;
      if (k > 0) {
        this.econCover.set(pid, (this.econCover.get(pid) || 0) + Math.trunc(k));
        // the rate lives in m.private.econ.cover — without this the chip only refreshed at the next event that
        // dirtied the seat (user report 2026-10-08: 兜底率没有变化)
        const ps = this.players.get(pid);
        if (ps) this.markPrivate(ps);
      }
    }
  }

  /** `min(capPct, floor(100 × 兜底 kills / the match's enemy total))` — an integer percent, 0 when the rule is off. */
  econCoverRate(playerId) {
    const ci = this.teamEcon && this.teamEcon.coverInterest;
    if (!ci || !ci.enabled || this.econCoverTotal <= 0) return 0;
    const kills = this.econCover.get(playerId) || 0;
    return Math.max(0, Math.min(ci.capPct, Math.floor((100 * kills) / this.econCoverTotal)));
  }

  /**
   * The PvE interest of one repaid principal: `principal × rate / 100`, accrued fractionally per lender and paid in
   * whole funds (the remainder stays for the next loan, so coins are always integers).
   */
  /**
   * The lender's PvE payout on a repaid principal: rate% of it, times `mult` (the 兜底率分红 premium for a debt that
   * was taken on while the borrower trailed the team), credited fractionally per lender and paid in whole funds. The
   * credit of one loan is capped at its principal, so no loan can ever pay back more than double — with the first
   * nine rounds' ≤48% rate (times the premium) "one fund returns two" stays impossible early (user decision 2026-10-07).
   */
  econCoverPayout(lenderId, principal, mult = 1) {
    const rate = this.econCoverRate(lenderId);
    if (rate <= 0 || principal <= 0) return 0;
    const credit = Math.min(principal, (principal * rate * Math.max(1, mult)) / 100);
    const accrued = (this.econCoverAccrual.get(lenderId) || 0) + credit;
    const pay = Math.floor(accrued);
    this.econCoverAccrual.set(lenderId, accrued - pay);
    return Math.max(0, Math.trunc(pay));
  }

  /**
   * A teammate is out. Its outstanding debts are void (the lender gets a warning), and — when the mode turns the rule
   * on (`teamEconomy.deathDividend`) — the income it would have earned next round is diced out to the survivors: every
   * survivor rolls 1..dice, the shares follow the rolls, the remainder goes to the highest roll and the total never
   * exceeds that income (user decision 2026-10-07).
   */
  econOnEliminated(ps, round) {
    if (!this.teamEcon) return;
    const owed = this.econDebts.get(ps.playerId);
    if (owed && owed.length) {
      this.econDebts.delete(ps.playerId);
      for (const d of owed) {
        const creditor = this.players.get(d.to);
        if (creditor && creditor.alive && !creditor.left) this.toast(creditor, 'warn', msg('{name} 已阵亡：{amount} 借款无法归还', { name: ps.name, amount: d.amount }));
      }
    }
    const dd = this.teamEcon.deathDividend;
    if (!dd || !dd.enabled) return;
    const pool = Math.max(0, Math.trunc(this.gd.income(round + 1)) + Math.max(0, Math.trunc(ps.pendingFunds) || 0));
    const survivors = [...this.players.values()].filter((p) => p !== ps && p.alive && !p.left);
    if (pool <= 0 || !survivors.length) return;
    const rolls = survivors.map(() => this.rngEcon.int(dd.dice) + 1);
    const totalRoll = rolls.reduce((n, r) => n + r, 0) || 1;
    const shares = survivors.map((p, i) => ({ p, roll: rolls[i], share: Math.floor((pool * rolls[i]) / totalRoll) }));
    const given = shares.reduce((n, s) => n + s.share, 0);
    if (pool - given > 0) {
      let best = 0;
      for (let i = 1; i < shares.length; i++) if (shares[i].roll > shares[best].roll) best = i;
      shares[best].share += pool - given;
    }
    for (const s of shares) {
      if (s.share <= 0) continue;
      s.p.addFunds(s.share, { reason: 'dividend' });
      s.p.dirty();
      this.toast(s.p, 'info', msg('{name} 已阵亡：随机分得 {share} 资金（骰 {roll}）', { name: ps.name, share: s.share, roll: s.roll }));
    }
    this.tickerText(msg('{name}博士的资金由队友随机继承', { name: ps.name }), 0);
  }
}
