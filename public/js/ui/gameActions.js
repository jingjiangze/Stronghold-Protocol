// In-match intents (`g.*`, DESIGN §8.2) with uniform error handling: every request goes through
// `act()`, which plays a UI sound on success, shows the ERR_TEXT toast on failure and never throws.
// The UI never mutates state optimistically — it waits for the next m.private / m.public push.
// `net.request` is looked up at call time so the dev mock harness can stub it.

import { net } from '../net.js';
import { toast, toastError } from './toasts.js';
import { t } from '../../../shared/i18n.js';
import { audio } from '../audio.js';

const SUCCESS_SFX = {
  'g.buy': 'buy', 'g.sell': 'sell', 'g.refresh': 'refresh', 'g.freeze': 'freeze', 'g.levelUp': 'levelup',
  'g.move': 'drop', 'g.equip': 'equip', 'g.art': 'artPlace', 'g.reward': 'pick', 'g.choice': 'pick',
  'g.band': 'confirm', 'g.bandSkip': 'back', 'g.infoReady': 'ready', 'g.emote': 'emote', 'g.destroy': 'back',
};

let inflight = 0;
const busyListeners = new Set();
const emitBusy = () => { for (const fn of [...busyListeners]) { try { fn(inflight); } catch { /* ignore */ } } };

/** Subscribe to the number of in-flight intents (for subtle busy indicators). */
export function onBusy(fn) { busyListeners.add(fn); return () => busyListeners.delete(fn); }

/**
 * The 借钱 refusals a player can hit that the generic ERR_TEXT ('已完成该操作') does not explain (user report
 * 2026-10-08: the second ask said 已完成该操作): the server names the reason in `detail` and the toast says it.
 */
const ECON_DETAIL_TEXT = {
  pending: () => t('已有一条待答复的借钱请求：等它结束再发起下一次'),
  budget: () => t('本回合的借钱次数已用完'),
  'no target': () => t('没有可借的队友了：他们本回合都拒绝过你，或已经准备就绪'),
  'team cap': () => t('本回合全队可调拨的额度已用完'),
  amount: () => t('金额超出上限'),
};

/**
 * The 救援 refusals (DESIGN §28, 促融共竞): 业主 2026-10-12 改成「其余全体队友同意 + 共享池扣款」，所以原因表也跟着
 * 换成了投票/池子那几条；服务端在 `detail` 里报名字，toast 按它说话，而不是笼统的「已完成该操作」。
 */
const REVIVE_DETAIL_TEXT = {
  'revival-disabled': () => t('这个模式没有救援'),
  'revival-window-closed': () => t('救援窗口已经关闭'),
  'stale-round': () => t('回合已经变了：救援只能在当前结算期内发起'),
  'revival-target-ineligible': () => t('他不需要救援，或已经被救回来了'),
  'revival-not-voter': () => t('你不在这次救援的名单里'),
  'revival-already-consented': () => t('你已经同意过这次救援了'),
  'revival-pool-insufficient': () => t('共享池不够支付这次救援'),
};

/** 后勤项目升级提案的表态被拒时的说明（业主 2026-10-12：点击 = 发起提案，全队同意才升级）。 */
const PROJECT_DETAIL_TEXT = {
  'vote in progress': () => t('已经有一条升级提案在表决中'),
  'no vote': () => t('现在没有待表决的升级提案'),
  'not a voter': () => t('你不在这次表决的名单里'),
  voted: () => t('你已经表态过了'),
  stale: () => t('提案已经过期：项目等级或资金变了'),
  reserve: () => t('共享池不够支付这次升级'),
};

/** 救济被拒时的说明（服务端 `econRelief` 的 detail；原来这一串只能落到通用的 ERR_TEXT）。 */
const RELIEF_DETAIL_TEXT = {
  'relief disabled': () => t('这个模式没有救济'),
  'relief budget': () => t('你本回合领取救济的次数已用完'),
  'not the weakest': () => t('只有生命值最低、且不高于阈值的队友能领救济'),
  'team relief cap': () => t('全队本回合的救济额度已用完'),
  reserve: () => t('共享池是空的，没有可以领的资金'),
};

/**
 * Send an intent. Resolves true on `ok`, false on error (already toasted).
 * @param {string} t
 * @param {object} [fields]
 * @param {{ sfx?: string|false, quiet?: boolean, detailText?: Record<string, () => string> }} [opts]
 *   detailText: a per-`err.detail` message, used instead of the generic ERR_TEXT when it has one
 * @returns {Promise<boolean>}
 */
export async function act(t, fields = {}, opts = {}) {
  inflight += 1;
  emitBusy();
  try {
    await net.request(t, fields);
    const s = opts.sfx === undefined ? SUCCESS_SFX[t] : opts.sfx;
    if (s) audio.sfx(s);
    return true;
  } catch (err) {
    if (!opts.quiet) {
      const specific = opts.detailText && err && typeof err.detail === 'string' ? opts.detailText[err.detail] : null;
      if (specific) toast(specific(), 'warn');
      else toastError(err);
      audio.sfx('error', { volume: 0.6 });
    }
    return false;
  } finally {
    inflight = Math.max(0, inflight - 1);
    emitBusy();
  }
}

export const actions = {
  infoReady: () => act('g.infoReady'),
  band: (bandId) => act('g.band', { bandId }),
  bandSkip: () => act('g.bandSkip'),
  buy: (slot) => act('g.buy', { slot }),
  refresh: () => act('g.refresh'),
  freeze: () => act('g.freeze'),
  levelUp: () => act('g.levelUp'),
  sell: (uid) => act('g.sell', { uid }),
  // `dir` (UP|RIGHT|DOWN|LEFT): the direction chosen with the deploy wheel (research 09 §6.1 — g.move / g.art carry it;
  // the server defaults to RIGHT when absent)
  move: (uid, to, dir) => act('g.move', dir ? { uid, to, dir } : { uid, to }),
  // `replaceUid`: the equipped item the replace dialog picked (ui/equipReplace.js) — it is destroyed; absent ⇒ none needed
  equip: (itemUid, targetUid, replaceUid) => act('g.equip', Number.isInteger(replaceUid) ? { itemUid, targetUid, replaceUid } : { itemUid, targetUid }),
  art: (itemUid, row, col, dir) => act('g.art', dir ? { itemUid, row, col, dir } : { itemUid, row, col }),
  destroy: (uid) => act('g.destroy', { uid }),
  reward: (idx) => act('g.reward', { idx }),
  choice: (idx, choiceId) => act('g.choice', choiceId === undefined ? { idx } : { idx, choiceId }),
  ready: (ready) => act('g.ready', { ready }, { sfx: ready ? 'ready' : 'back' }),
  emote: (id) => act('g.emote', { id }, { quiet: true }),
  // `playerId`: the player tapped in the team panel (a shared field shows two) — what an eliminated viewer follows
  watch: (fieldId, playerId = null) => act('g.watch', typeof playerId === 'string' && playerId ? { fieldId, playerId } : { fieldId }, { sfx: 'tab' }),
  autoplay: (on) => act('g.autoplay', { on }),
  // solo battles only (ui/matchStatus.js pauseAvailable): m.public.paused follows
  pause: (on) => act('g.pause', { on: !!on }, { sfx: on ? 'click' : 'confirm' }),
  // 协同经济 (DESIGN §27): the server refuses these unless it advertised m.public.econ — the shop bar only renders the
  // strip then, so they are never sent blind
  // `to = null` ⇒ 广播（问遍其余队友）；给了 id ⇒ v1 的指定队友（借还牌的队友选择器）。
  econRequest: (to, amount) => act('g.econ.request', to == null ? { amount } : { to, amount }, { sfx: 'click', detailText: ECON_DETAIL_TEXT }),
  econRespond: (id, approve) => act('g.econ.respond', { id, approve }, { sfx: approve ? 'confirm' : 'back', detailText: ECON_DETAIL_TEXT }),
  // 后勤项目：点击 = 发起提案（不再直接扣款）；随后 `g.econ.vote` 表态，全票同意才升级（业主 2026-10-12）。
  econProject: (project) => act('g.econ.project', { project }, { sfx: 'confirm', detailText: PROJECT_DETAIL_TEXT }),
  econVote: (id, approve) => act('g.econ.vote', { id, approve }, { sfx: approve ? 'confirm' : 'back', detailText: PROJECT_DETAIL_TEXT }),
  // 救援 (DESIGN §28, 促融共竞): the settle window's rescue — 其余全体存活队友同意后从共享池扣款；服务端拥有全部规则
  // （谁能救、花多少、哪一回合），这里只报目标与本次点击所属的回合。
  revive: (playerId, round) => act('g.revive', { playerId, round }, { sfx: 'confirm', detailText: REVIVE_DETAIL_TEXT }),
  // 救济 (DESIGN §27): take one fund out of the team reserve. No arguments — the server decides who may take, and it
  // refuses anyone but the (tied) weakest teammate at or below the threshold.
  econRelief: () => act('g.econ.relief', {}, { sfx: 'confirm', detailText: RELIEF_DETAIL_TEXT }),
  // room-level intent (NOT g.*): the host frees a spectator seat while the match runs — the server takes room.removeSpectator at
  // any time (server/lobby.js removeSpectator), the game screen had no entry for it (ui/hud.js SpectatorPill; GitHub #120)
  removeSpectator: (playerId) => act('room.removeSpectator', { playerId }, { sfx: 'back' }),
};
