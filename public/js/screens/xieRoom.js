// 协同共竞 — the borrowing mode's own room-creation page (DESIGN §28). The title screen's 协同共竞 button lands here
// instead of the 选择模拟协议 lobby (user decision 2026-10-08): only the look is shared with that screen (the same
// topbar / section / difficulty cards / create box), the content is the mode's own — pick a difficulty and create the
// room; the second seat is filled with an AI teammate right away, the mode being a two-player table for now. A friend
// joins an existing co-op room right here with its 同盟密钥 (user decision 2026-10-08: 添加邀请码加入) — the lobby's
// own join box, down to the shared normalisation/code helpers, so both doors behave identically.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, ROOM_CODE_LEN } from '../../../shared/constants.js';
import { html, Button, MicroLabel, Panel, TextField, PingPill, AvatarFrame, Spinner, doctorNo } from '../ui/components.js';
import { toast, toastError } from '../ui/toasts.js';
import { GuideButton } from '../ui/guide.js';
import { LoadoutButton } from './loadout.js';
import { net } from '../net.js';
import { store, useStore, shallowEqual, loadPref, savePref } from '../store.js';
import { useData } from '../data.js';
import { CODE_RE, DifficultyCard, codeArg, normalizeCode, recentRooms } from './lobby.js';
import { QuickMatch } from '../ui/quickMatch.js';
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
  const [code, setCode] = useState('');
  const [recent] = useState(recentRooms);
  const alive = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => () => { alive.current = false; }, []);

  const online = conn.status === 'online';
  const codeOk = CODE_RE.test(code);
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

  // join a co-op room a friend already made, by its 同盟密钥 — the lobby's own path (normalizeCode/codeArg/CODE_RE and
  // the same room.join request), so a pasted invite link and a typed code behave exactly as they do on that screen
  const join = async (c = code) => {
    const k = codeArg(c, code);
    if (!k) { toast(t('同盟密钥为 {ROOM_CODE_LEN} 位字母或数字', { ROOM_CODE_LEN }), 'warn'); return; }
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy('join');
    try {
      await net.request('room.join', { code: k });
    } catch (e) {
      if (alive.current) toastError(e);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  // 快速匹配 (server/matchmaking.js): the SAME queue the 选择模拟协议 lobby uses — no second difficulty picker here,
  // it follows the difficulty selected on this page (user decision 2026-10-09: 建房页面选的什么难度就什么难度匹配).
  // The lobby's own run() shape, so a request in flight disables both doors the same way.
  const queue = useStore((s) => s.lobby?.queue, shallowEqual);
  const runQueue = async (fn) => {
    if (inFlight.current) return;
    if (!online) { toast(t('尚未连接到服务器，请稍候'), 'warn'); return; }
    inFlight.current = true;
    setBusy('queue');
    try { await fn(); } catch (e) { if (alive.current) toastError(e); } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };
  const quickMatch = () => runQueue(() => net.request('queue.join', { difficulty }));
  const cancelQueue = () => runQueue(() => net.request('queue.cancel', {}));
  const acceptQueue = (offerId) => runQueue(() => net.request('queue.accept', { offerId }));

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
      <section class="lobby-left">
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

      <section class="lobby-right">
        <div class="section-label"><span class="section-label__idx num">02</span>${t('快速匹配')}<${MicroLabel}>QUICK MATCH<//></div>
        <${QuickMatch} queue=${queue} difficulty=${difficulty} online=${online} busy=${busy}
          onJoin=${quickMatch} onCancel=${cancelQueue} onAccept=${acceptQueue} />

        <div class="section-label"><span class="section-label__idx num">03</span>${t('加入同盟')}<${MicroLabel}>JOIN WITH ALLIANCE KEY<//></div>
        <${Panel} class="join-panel" tone="amber">
          <div class="join-row">
            <${TextField} size="code" icon="key" value=${code} placeholder=${t('输入同盟密钥 / 粘贴邀请链接')}
              transform=${normalizeCode} onInput=${(v) => setCode(normalizeCode(v))} onEnter=${() => join()} />
            <${Button} variant="amber" size="lg" icon="users" loading=${busy === 'join'} disabled=${!codeOk || !online} onClick=${() => join()}>${t('加入同盟')}<//>
          </div>
          <div class="join-foot">
            ${recent.length ? html`<span class="t-lo">${t('最近的同盟')}</span>
              ${recent.map((c) => html`<button key=${c} type="button" class="code-chip num" title=${t('填入密钥（不会直接加入）')}
                onClick=${() => setCode(c)}>${c}</button>`)}`
              : html`<span class="t-dim">${t('向同伴索取 {ROOM_CODE_LEN} 位同盟密钥，或直接打开邀请链接', { ROOM_CODE_LEN })}</span>`}
          </div>
        <//>
      </section>
    </div>
  </div>`;
}
