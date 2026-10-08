// 协同经济 (DESIGN §27): the team-economy model behind the bottom bar's strip. Pure — no DOM, no store import — so
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
      const maxed = p.cost == null;
      return {
        id: p.id,
        name: PROJECT_NAMES[p.id] || p.id,
        level: Number(p.level) || 0,
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
    requestIn: reqIn ? { id: reqIn.id, from: reqIn.from, fromName: nameOf(reqIn.from), amount: Number(reqIn.amount) || 0 } : null,
    requestOut: reqOut ? { id: reqOut.id, to: reqOut.to, toName: nameOf(reqOut.to), amount: Number(reqOut.amount) || 0 } : null,
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
        kills: mine.cover.kills, total: mine.cover.total, ratePct: mine.cover.ratePct, accrued: mine.cover.accrued,
        // 兜底率分红: the debts owed to me that were taken on while the borrower trailed the median earn
        // `lagPremium` on repayment — shown so the mechanic is visible (user report 2026-10-08)
        lag: Number(mine.cover.lag) || 0, lagPremium: Math.max(1, Number(mine.cover.lagPremium) || 1),
      }
      : null,
    projects,
  };
}
