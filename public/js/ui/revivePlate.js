// 救援 plate (促融共竞, DESIGN §29): the settle window's control. A teammate whose LP ran out is held at 0 until the
// settle phase ends; the rest of the living team must ALL agree — the bot seats agree on their own after a short
// "thought" pause — and the fee is taken out of the shared pool, per voter (5 / 10 / 15… per rescue). The server owns
// every rule (who may vote, the cost, the pool, the round) — this only shows the window and tally, and sends
// `g.revive`; it renders nothing at all when the mode has no 救援 or nobody is waiting.
import { html } from './components.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/**
 * @param {{ revival: any, myId: string, onRevive: (playerId: string) => void }} props
 */
export function RevivePlate({ revival, myId, onRevive }) {
  if (!revival || !revival.open || !Array.isArray(revival.targets) || !revival.targets.length) return null;
  const downed = revival.targets.some((tg) => tg.playerId === myId);
  const cost = Number(revival.costPer) || 0;
  const pool = Number(revival.pool) || 0;
  return html`<div class="revive" role="status" aria-live="polite">
    <div class="revive__head">
      <span class="revive__title">${t('救援')}</span>
      <span class="revive__cost">${t('全体同意 · 每人从共享池支付 {cost}（池中 {pool}）', { cost, pool })}</span>
    </div>
    <ul class="revive__list">
      ${revival.targets.map((tg) => {
        const need = Array.isArray(tg.need) ? tg.need : [];
        const agreed = Array.isArray(tg.agreed) ? tg.agreed : [];
        const iAmVoter = need.includes(myId);
        const iAgreed = agreed.includes(myId);
        const left = need.filter((id) => !agreed.includes(id)).length;
        return html`<li key=${tg.playerId} class="revive__row">
          <span class="revive__name">${tg.name}</span>
          <span class="revive__progress">${t('同意 {n}/{total}', { n: agreed.length, total: need.length })}</span>
          ${iAmVoter && !iAgreed
            ? html`<button type="button" class=${cx('revive__btn', 'is-live')}
                title=${t('同意从共享池出钱把 {name} 救回来（还差 {left} 人）', { name: tg.name, left })}
                onClick=${() => onRevive(tg.playerId)}>${t('同意救援')}</button>`
            : html`<span class="revive__wait">${iAgreed ? t('已同意，等待其他人') : t('等待队友同意')}</span>`}
        </li>`;
      })}
    </ul>
    <div class="revive__note">${downed
      ? t('你的目标生命值耗尽，等待全体队友同意救援')
      : t('救援需要其余全体存活队友同意，费用从共享池按人头扣除（第 2 次起更贵）')}</div>
  </div>`;
}
