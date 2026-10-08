// 快速匹配 (server/matchmaking.js): the lobby's queue entry. Pick a difficulty, join the queue, and the server forms
// an ordinary co-op room once exactly MAX_SEATS players are waiting for it — every one of them must confirm first.
// A room that forms this way is a normal room (code, invite, spectators, AI seats all behave), so this component's
// only job is the queue: show what the queue is doing and send queue.join / queue.cancel / queue.accept.
import { html, Button, Spinner, Tooltip } from './components.js';
import { MAX_SEATS } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';

/**
 * @param {{ queue: any, difficulty: string, online: boolean, busy: string|null,
 *   onJoin: (difficulty: string) => void, onCancel: () => void, onAccept: (offerId: string) => void }} props
 */
export function QuickMatch({ queue, difficulty, online, busy, onJoin, onCancel, onAccept }) {
  const state = queue && typeof queue.state === 'string' ? queue.state : 'idle';
  // matched: the room screen takes over from here (the queue has nothing left to show)
  if (state === 'matched') return null;

  if (state === 'offered') {
    const waiting = Number(queue.acceptedCount) || 0;
    return html`<div class="qm qm--offer" role="status" aria-live="polite">
      <div class="qm__head">
        <span class="qm__title">${t('凑齐了！确认进入模拟')}</span>
        <span class="qm__count num">${waiting}/${MAX_SEATS}</span>
      </div>
      <div class="qm__row">
        <${Button} variant="primary" size="lg" loading=${busy === 'queue'} disabled=${queue.accepted} onClick=${() => onAccept(queue.offerId)}>
          ${queue.accepted ? t('已确认，等待队友') : t('确认')}
        <//>
        <${Button} variant="secondary" size="lg" disabled=${busy === 'queue'} onClick=${onCancel}>${t('取消匹配')}<//>
      </div>
    </div>`;
  }

  if (state === 'queued') {
    const waiting = Number(queue.waiting) || 0;
    return html`<div class="qm qm--waiting" role="status" aria-live="polite">
      <div class="qm__head">
        <span class="qm__title"><${Spinner} size="sm" label="MATCHING" />${t('正在匹配…')}</span>
        <span class="qm__count num">${waiting}/${MAX_SEATS}</span>
      </div>
      <div class="qm__row">
        <${Button} variant="secondary" size="lg" loading=${busy === 'queue'} onClick=${onCancel}>${t('取消匹配')}<//>
      </div>
    </div>`;
  }

  return html`<div class="qm">
    <${Tooltip} block=${true} text=${online ? t('按当前难度凑满 {n} 名玩家后自动开房：不补 AI，人人都要确认', { n: MAX_SEATS }) : t('正在连接服务器…')}>
      <${Button} variant="secondary" size="xl" block=${true} icon="users" loading=${busy === 'queue'} disabled=${!online}
        onClick=${() => onJoin(difficulty)}>${t('快速匹配')}<//>
    <//>
    <div class="qm__hint">${t('和陌生人组队：凑满 {n} 人自动开一局同盟模拟（当前难度）', { n: MAX_SEATS })}</div>
  </div>`;
}
