// 协同经济 (DESIGN §25): the team-economy model behind the bottom bar's strip. Pure — no DOM, no store import — so
// test/ui can verify it and the ShopBar component stays a thin view. The server advertises the rule set with
// m.public.econ; while that key is absent the model is null and the bar renders nothing (the capability probe).

const PROJECT_NAMES = Object.freeze({ procure: '联合采购', storehouse: '应急仓储', logistics: '后勤调度' });

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
    reserve,
    transferLeft: Number(econ.transferLeft) || 0,
    requestLeft: Number(mine.requestLeft) || 0,
    maxAmount: Number.isFinite(cap) && cap > 0 ? Math.min(5, Math.floor(cap)) : 5,
    keep: Number(mine.keep) || 0,
    requestIn: reqIn ? { id: reqIn.id, from: reqIn.from, fromName: nameOf(reqIn.from), amount: Number(reqIn.amount) || 0 } : null,
    requestOut: reqOut ? { id: reqOut.id, to: reqOut.to, toName: nameOf(reqOut.to), amount: Number(reqOut.amount) || 0 } : null,
    partners: players.filter((p) => p && p.alive && p.playerId !== (priv && priv.playerId)).map((p) => ({ id: p.playerId, name: p.name })),
    projects,
  };
}
