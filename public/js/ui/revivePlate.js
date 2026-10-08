// 救援 plate (DESIGN §28, 促融共竞): the settle window's control. A teammate whose LP ran out is held at 0 until the
// settle phase ends; whoever helped in this round's 联防 and came through their own battle clean may spend LP to bring
// them back with 1. The server owns every rule (who may donate, the round, the cost) — this only shows the window and
// sends `g.revive`, and it renders nothing at all when the mode has no 救援 or nobody is waiting.
import { html } from './components.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/**
 * @param {{ revival: any, myId: string, onRevive: (playerId: string) => void }} props
 */
export function RevivePlate({ revival, myId, onRevive }) {
  if (!revival || !revival.open || !Array.isArray(revival.targets) || !revival.targets.length) return null;
  const donors = Array.isArray(revival.donors) ? revival.donors : [];
  const donor = donors.includes(myId);
  const downed = revival.targets.some((tg) => tg.playerId === myId);
  return html`<div class="revive" role="status" aria-live="polite">
    <div class="revive__head">
      <span class="revive__title">${t('救援')}</span>
      <span class="revive__cost">${t('花费 {cost} 点生命值', { cost: revival.cost })}</span>
    </div>
    <ul class="revive__list">
      ${revival.targets.map((tg) => html`<li key=${tg.playerId} class="revive__row">
        <span class="revive__name">${tg.name}</span>
        ${donor
          ? html`<button type="button" class=${cx('revive__btn', 'is-live')}
              title=${t('把 {name} 救回来：他带着 1 点生命值回到战场', { name: tg.name })}
              onClick=${() => onRevive(tg.playerId)}>${t('救援')}</button>`
          : html`<span class="revive__wait">${t('等待救援')}</span>`}
      </li>`)}
    </ul>
    ${donor ? null : html`<div class="revive__note">${downed
      ? t('你的目标生命值耗尽，等待队友救援')
      : t('本回合你不能救援：需要在联防里替队友挡过怪、自己那场没有漏怪，且生命值不少于 {min}', { min: revival.minDonorLp })}</div>`}
  </div>`;
}
