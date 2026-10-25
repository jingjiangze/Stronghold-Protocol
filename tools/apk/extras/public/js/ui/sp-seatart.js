// sp-seatart.js — **壳自有**的名片干员 helper（2026-10-25 上游 0.3.3 同步后拆出）。
//
// 上游 0.3.2 起引入 public/js/ui/seatArt.js（CARD_PREF/cardOperators/seatOperator/seatCardSkin/
// seatArtSrc 一整套），我们的旧副本顶住同名路径会静默丢掉上游实现（check-extras-overlap B5/R-14）。
// 按「上游优先覆盖」：上游那份进 webroot；我们**多出来的** seatPortrait（UI 包的名片卡实际在用）
// 搬到这里，sp- 前缀避免同名覆盖。CARD_PREF / cardOperators 仍从上游 seatArt.js 取。
import { chessPortraitUrl } from './assetUrls.js';

/** FNV-1a of a string (the portrait pick: the same operator for a player on every client). */
function hash32(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * The seat card's portrait: the operator the player picked (room.state seats[].card, or one's own pick), else one of
 * the 5★/6★ operators chosen by the player id — the same on every client (null before the data loads).
 * @param {any} seat room.state seat @param {{ pool: any[], byChar: Map<string, any>, m: any, myId: any, myCard: string }} ctx
 */
export function seatPortrait(seat, { pool, byChar, m, myId, myCard }) {
  if (!seat || seat.playerId == null) return null;
  const pick = (seat.playerId === myId && myCard) || seat.card;
  const rec = pick && byChar ? byChar.get(pick) : null;
  if (rec) return chessPortraitUrl(m, rec);
  if (!Array.isArray(pool) || !pool.length) return null;
  return chessPortraitUrl(m, pool[hash32(seat.playerId) % pool.length]);
}
