// 借钱 plate (DESIGN §25/§26): the borrow mode's one control, with a spot of its own in the HUD — right of the 整备区
// row, under the board's bottom-right corner, above the shop cards (user report 2026-10-07: 单独把 ui 换区域, and 一看就
// 知道能点的，和官方类似 — it used to be squeezed into the shop bar's 剩余可放置角色 / 冻结 / 刷新 line, where it read as
// a readout rather than a button). So it is built in the official button language: a bright amber ring, the funds glyph
// and the count, a 借钱 caption, hover lift and glow, and an idle pulse while a borrow is actually available. Clicking
// it opens the teammate picker (and the amount picker, when a mode ever allows more than one fund per request) beside
// it; a pending request replaces the plate with its own row (同意 / 拒绝, or 撤回 while it is mine).
//
// The strip that stays in the shop bar (public/js/ui/shopBar.js EconStrip) is the rest of the team economy — the
// reserve and the logistics projects — which only appear when a server turns the full rule set on.
import { html } from './components.js';
import { CoinGlyph, Img, Sprite } from './gameComponents.js';
import { actions } from './gameActions.js';
import { localAsset } from '../data.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/**
 * The mode's own 资金 icon (user report 2026-10-07: 将这个的图标改成促融共竞的钱的图标) — the official
 * `garrisonTypeIcon/icon_gold` sprite the autochess HUD uses for funds, resolved like every other official sprite:
 * the data/assets.json copy first (present on any install that ran setup), the local-client extraction second, the
 * client's own glyph as the last resort.
 */
function FundsIcon() {
  return html`<${Sprite} k="garrisonTypeIcon/icon_gold" class="borrow__coin"
    fallback=${html`<${Img} src=${localAsset('ui/common', 'icon_gold')} class="borrow__coin"
      fallback=${html`<${CoinGlyph} class="borrow__coin" />`} />`} />`;
}

/**
 * @param {{ econ:any, editable:boolean, askOpen:boolean, askAmount:number, setAskOpen:Function, setAskAmount:Function }} props
 */
export function BorrowPlate({ econ, editable, askOpen, askAmount, setAskOpen, setAskAmount }) {
  const amount = Math.min(Math.max(1, Number(askAmount) || 1), econ.maxAmount);
  const canAsk = editable && econ.requestLeft > 0 && econ.partners.length > 0;
  return html`<div class="borrow" role="group" aria-label="协同经济">
    <span class="borrow__cap">本回合可调拨 <b class="num">${econ.transferLeft}</b></span>
    ${econ.requestIn ? html`<span class="borrow__req is-in">
      <span><b>${econ.requestIn.fromName}</b> 请求 <b class="num">${econ.requestIn.amount}</b></span>
      <button type="button" class="borrow__btn is-ok" disabled=${!editable} title=${editable ? '同意并支付' : '取消就绪后才能操作'}
        onClick=${() => actions.econRespond(econ.requestIn.id, true)}>同意</button>
      <button type="button" class="borrow__btn" disabled=${!editable} onClick=${() => actions.econRespond(econ.requestIn.id, false)}>拒绝</button>
    </span>` : econ.requestOut ? html`<span class="borrow__req is-out">
      <span>已向 <b>${econ.requestOut.toName}</b> 请求 <b class="num">${econ.requestOut.amount}</b></span>
      <button type="button" class="borrow__btn" onClick=${() => actions.econCancel(econ.requestOut.id)}>撤回</button>
    </span>` : html`<span class="borrow__ask">
      <button type="button" class=${cx('borrow__plate', askOpen && 'is-open', canAsk && 'is-live')}
        disabled=${!canAsk}
        aria-label=${`目前费用 ${econ.funds}，点击借钱`}
        title=${!editable ? '休整期才能借钱' : econ.requestLeft > 0 ? `目前费用 ${econ.funds} · 点击向队友借 ${amount} 块（本回合还可发起 ${econ.requestLeft} 次）` : '本回合的借钱次数已用完'}
        onClick=${() => setAskOpen(!askOpen)}>
        <${FundsIcon} />
        <b class="num borrow__num">${econ.funds}</b>
        <span class="borrow__label">借钱</span>
      </button>
      ${askOpen ? html`<span class="borrow__pick">
        ${econ.maxAmount > 1 ? Array.from({ length: econ.maxAmount }, (_, i) => i + 1).map((n) => html`<button key=${`n${n}`} type="button"
          class=${cx('borrow__chip', n === amount && 'is-on')} onClick=${() => setAskAmount(n)}>${n}</button>`) : null}
        ${econ.partners.map((p) => html`<button key=${p.id} type="button" class="borrow__chip borrow__chip--name"
          title=${`向 ${p.name} 借 ${amount} 块`} onClick=${() => { setAskOpen(false); actions.econRequest(p.id, amount); }}>借 ${amount} ← ${p.name}</button>`)}
      </span>` : null}
    </span>`}
  </div>`;
}
