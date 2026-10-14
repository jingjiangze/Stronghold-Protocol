// 协同经济 (DESIGN §28): the team-economy model behind the bottom bar's strip. Pure — no DOM, no store import — so
// test/ui can verify it and the ShopBar component stays a thin view. The server advertises the rule set with
// m.public.econ; while that key is absent the model is null and the bar renders nothing (the capability probe).
import { N_ } from '../../../shared/i18n.js';

const PROJECT_NAMES = Object.freeze({ procure: N_('联合采购'), storehouse: N_('应急仓储'), logistics: N_('后勤调度') });

/**
 * @param {{ priv?: any, pub?: any }} o the store's match slices (m.private / m.public)
 * @returns {null | {
 *   reserve: number, transferLeft: number, requestLeft: number, maxAmount: number, keep: number,
 *   requestIn: { id: string, from: string, fromName: string, amount: number } | null,
 *   requestOut: { id: string, to: string, toName: string, amount: number } | null,
 *   partners: { id: string, name: string }[],
 *   projects: { id: string, name: string, level: number, cost: number|null, maxed: boolean, affordable: boolean }[],
 *   relief: { eligible: boolean, amount: number, threshold: number, left: number, teamLeft: number } | null,
 * }} null while the rule set is off
 */
export function econBarModel({ priv, pub } = {}) {
  const econ = pub && pub.econ;
  if (!econ || typeof econ !== 'object') return null;
  const mine = priv && priv.econ && typeof priv.econ === 'object' ? priv.econ : {};
  const players = Array.isArray(pub.players) ? pub.players : [];
  const nameOf = (pid) => (players.find((p) => p && p.playerId === pid) || {}).name || '';
  const reqIn = mine.requestIn && typeof mine.requestIn === 'object' ? mine.requestIn : null;
  const reqOut = mine.requestOut && typeof mine.requestOut === 'object' ? mine.requestOut : null;
  const reserve = Number(econ.reserve) || 0;
  const projects = (Array.isArray(econ.projects) ? econ.projects : [])
    .filter((p) => p && typeof p.id === 'string')
    .map((p) => {
      const maxed = p.maxed === true || p.cost == null;
      return {
        id: p.id,
        name: PROJECT_NAMES[p.id] || p.id,
        level: Number(p.level) || 0,
        max: Number(p.max) || 0,
        cost: maxed ? null : Number(p.cost),
        maxed,
        affordable: !maxed && reserve >= Number(p.cost),
      };
    });
  const cap = Number(mine.maxPerRequest);
  return {
    borrowOnly: econ.borrowOnly === true,
    // the player's own fee count, shown on the borrow control (the 促融共竞-style 费用 readout)
    funds: Number(priv && priv.funds) || 0,
    reserve,
    transferLeft: Number(econ.transferLeft) || 0,
    requestLeft: Number(mine.requestLeft) || 0,
    maxAmount: Number.isFinite(cap) && cap > 0 ? Math.min(5, Math.floor(cap)) : 5,
    keep: Number(mine.keep) || 0,
    // `phrase` 是广播借钱时服务端挂上的那句「喊话」；两个方向都要透传，否则牌子里的引号永远不出现
    requestIn: reqIn ? { id: reqIn.id, from: reqIn.from, fromName: nameOf(reqIn.from), amount: Number(reqIn.amount) || 0, phrase: String(reqIn.phrase || '') } : null,
    requestOut: reqOut ? { id: reqOut.id, to: reqOut.to, toName: nameOf(reqOut.to), amount: Number(reqOut.amount) || 0, phrase: String(reqOut.phrase || '') } : null,
    // only teammates who could answer: alive, and not ready — a ready human is locked out of the request UI, so the
    // server refuses the ask and offering them would burn the asker's once-per-round budget (被借 e2e, 2026-10-07).
    // A bot is always ready (it readies itself) but answers on the spot, so it stays on the list.
    // Plus the ones who already refused this round (mine.refused, server econDeniedBy): asking them again is refused
    // outright, so they drop out of the picker (user report 2026-10-08: 第二次借钱提示「已完成该操作」).
    partners: (() => {
      const refused = new Set(Array.isArray(mine.refused) ? mine.refused : []);
      return players.filter((p) => p && p.alive && p.playerId !== (priv && priv.playerId) && !refused.has(p.playerId) && (p.isBot || !p.ready))
        .map((p) => ({ id: p.playerId, name: p.name }));
    })(),
    // 方案 B: what this player owes at the next income and what teammates owe them (server econDebtSummary)
    owe: mine.owe && mine.owe.total > 0 ? { total: mine.owe.total, next: mine.owe.next } : null,
    due: mine.due && mine.due.total > 0 ? { total: mine.due.total, next: mine.due.next } : null,
    // 兜底利息 (PvE): how much of the match's enemies this player has held for teammates, and the rate it buys
    cover: mine.cover && mine.cover.total > 0
      ? {
        kills: mine.cover.kills, total: mine.cover.total, ratePct: mine.cover.ratePct,
        // 兜底分红 (user decision 2026-10-09): the pool pays whole funds only — `pending` is this player's slice of the
        // fraction still waiting for the next repayment, `earned`/`lastBonus` what the split has already paid it
        pending: Number(mine.cover.pending) || 0,
        earned: Number(mine.cover.earned) || 0,
        lastBonus: Number(mine.cover.lastBonus) || 0,
        // 兜底率分红: the debts owed to me that were taken on while the borrower trailed the median earn
        // `lagPremium` on repayment — shown so the mechanic is visible (user report 2026-10-08)
        lag: Number(mine.cover.lag) || 0, lagPremium: Math.max(1, Number(mine.cover.lagPremium) || 1),
      }
      : null,
    projects,
    // 后勤项目升级提案（业主 2026-10-12：点击 = 发起提案，其余队友表态；全票同意才从共享池扣款升级）。
    // `vote` = 轮到我表态的那一条（还没表态时由服务端下发），`canPropose` = 当前没有别的提案在表决。
    vote: (() => {
      const v = mine.vote && typeof mine.vote === 'object' ? mine.vote : null;
      if (!v || typeof v.id !== 'string') return null;
      return {
        id: v.id,
        project: v.project,
        name: PROJECT_NAMES[v.project] || v.project,
        level: Number(v.level) || 0,
        cost: Number(v.cost) || 0,
        byName: nameOf(v.by),
        agree: (Array.isArray(v.agree) ? v.agree : []).map(nameOf),
        need: (Array.isArray(v.need) ? v.need : []).map(nameOf),
      };
    })(),
    canPropose: mine.canPropose !== false,
    // 救济 (DESIGN §28, user decision 2026-10-09): the weakest teammate may draw one fund out of the reserve. The
    // server decides who may take (m.private.econ.relief.eligible) — the strip only renders the button on that flag, and
    // `teamLeft` is the public per-round allowance, shown so the pot's limit is visible.
    relief: (() => {
      const r = mine.relief && typeof mine.relief === 'object' ? mine.relief : null;
      const pub = econ.relief && typeof econ.relief === 'object' ? econ.relief : null;
      if (!r || !pub) return null;
      return {
        eligible: r.eligible === true,
        amount: Number(r.amount) || 1,
        threshold: Number(r.threshold) || 0,
        left: Math.max(0, Number(r.left) || 0),
        teamLeft: Math.max(0, Number(pub.left) || 0),
      };
    })(),
  };
}
