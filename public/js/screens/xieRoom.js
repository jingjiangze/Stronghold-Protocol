// 协同共竞 — the borrowing mode's own room-creation page (DESIGN §28). The title screen's 协同共竞 button lands here
// instead of the 选择模拟协议 lobby (user decision 2026-10-08): only the look is shared with that screen (the same
// topbar / section / difficulty cards / create box), the content is the mode's own — pick a difficulty and create the
// room; the second seat is filled with an AI teammate right away, the mode being a two-player table for now.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES } from '../../../shared/constants.js';
import { html, Button, MicroLabel, PingPill, AvatarFrame, Spinner, doctorNo } from '../ui/components.js';
import { toast, toastError } from '../ui/toasts.js';
import { GuideButton } from '../ui/guide.js';
import { LoadoutButton } from './loadout.js';
import { net } from '../net.js';
import { store, useStore, shallowEqual, loadPref, savePref } from '../store.js';
import { useData } from '../data.js';
import { DifficultyCard } from './lobby.js';
import { t } from '../../../shared/i18n.js';

export function XieRoomScreen() {
  const me = useStore((s) => s.me, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  useData('config');
  const [difficulty, setDifficulty] = useState(() => {
    const d = loadPref('lobby.difficulty', 'FUNNY');
    return DIFFICULTIES.includes(d) ? d : 'FUNNY';
  });
  const [busy, setBusy] = useState(null);
  const alive = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => () => { alive.current = false; }, []);

  const online = conn.status === 'online';
  const pickDifficulty = (d) => { setDifficulty(d); savePref('lobby.difficulty', d); };

  const back = () => {
    if (inFlight.current) return;
    store.set((s) => ({ ui: { ...s.ui, xieRoom: false } }));
  };

  const create = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy('create');
    try {
      await net.request('room.create', { mode: 'coop', difficulty, variant: 'xie' });
      // this mode is a two-player table for now: fill the second seat with an AI teammate
      await net.request('room.addBot').catch(() => {});
    } catch (e) {
      if (alive.current) toastError(e);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  return html`<div class="screen lobby-screen">
    <header class="topbar">
      <div class="topbar__left">
        <${Button} variant="ghost" size="sm" icon="chevronLeft" onClick=${back} title=${t('返回标题')}>${t('返回')}<//>
        <${PingPill} ms=${conn.ping} online=${online} />
      </div>
      <div class="topbar__center">
        <${MicroLabel} tone="mint">JOINT OPERATION<//>
        <h1 class="topbar__title">${t('协同共竞 · 创建房间')}</h1>
      </div>
      <div class="topbar__right">
        <${GuideButton} class="lobby-guide" variant="secondary" label=${t('玩法说明')} />
        <${LoadoutButton} from="lobby" size="sm" class="lobby-loadout" label=${t('干员调配')} />
        <div class="me-chip">
          <${AvatarFrame} size="sm" name=${me.name} seat=${0} self=${true} />
          <div class="me-chip__text">
            <span class="me-chip__name">${me.name || t('博士')}</span>
            <${MicroLabel}>${me.playerId != null ? `DOCTOR #${doctorNo(me.playerId)}` : 'DOCTOR'}<//>
          </div>
        </div>
      </div>
    </header>

    <div class="lobby-body screen__scroll">
      <section class="lobby-right">
        <div class="section-label"><span class="section-label__idx num">01</span>${t('模拟难度')}<${MicroLabel}>DIFFICULTY<//></div>
        <div class="diff-list">
          ${DIFFICULTIES.map((d) => html`<${DifficultyCard} key=${d} roomMode="coop" difficulty=${d} variant="xie"
            selected=${difficulty === d} onSelect=${pickDifficulty} />`)}
        </div>
        <div class="create-box">
          <p class="xie-note">${t('同盟模拟之上加入「借钱」：休整期可与队友借调资金，其余规则与原版完全一致。')}</p>
          <p class="xie-note t-lo">${t('建房后会自动补 1 名 AI 队友；本模式目前为双人。')}</p>
          <${Button} variant="primary" size="xl" block=${true} iconRight="chevrons" loading=${busy === 'create'} disabled=${!online} onClick=${create}>
            ${t('创建房间')}
          <//>
          <div class="create-box__hint">
            ${online ? html`<span>${t('创建后可邀请好友加入；借钱只在休整期可用')}</span>` : html`<${Spinner} size="sm" label="CONNECTING" />`}
          </div>
        </div>
      </section>
    </div>
  </div>`;
}
