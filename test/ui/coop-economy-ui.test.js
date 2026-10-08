// 协同经济 (DESIGN §27/§28): the team-economy model and the two components that render it — the borrow plate that the
// co-op mode uses (public/js/ui/borrowPlate.js, mounted by the match screen in the HUD) and the reserve/project strip
// that stays in the shop bar. Pure components, so test/ui runs them without a DOM. The rule set is advertised by
// m.public.econ; absent ⇒ nothing renders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { econBarModel } from '../../public/js/ui/econBar.js';
import { EconStrip } from '../../public/js/ui/shopBar.js';
import { BorrowPlate } from '../../public/js/ui/borrowPlate.js';

const pub = {
  players: [
    { playerId: 'p_0', name: '甲', alive: true },
    { playerId: 'p_1', name: '乙', alive: true },
    { playerId: 'p_2', name: '丙', alive: false },
  ],
  econ: {
    reserve: 5,
    transferLeft: 6,
    projects: [
      { id: 'procure', level: 1, cost: 8 },
      { id: 'storehouse', level: 0, cost: 4 },
      { id: 'logistics', level: 3, cost: null },
    ],
  },
};
const priv = {
  playerId: 'p_0',
  econ: { requestOut: null, requestIn: { id: 'req:3', from: 'p_1', amount: 4, deadline: 0 }, requestLeft: 0, keep: 1, maxPerRequest: 5 },
};
/** The same player with no pending request on either side (the ask UI shows). */
const privIdle = {
  playerId: 'p_0',
  funds: 7,
  econ: { requestOut: null, requestIn: null, requestLeft: 1, keep: 1, maxPerRequest: 5 },
};

test('the model is null while m.public.econ is absent (the feature probe)', () => {
  assert.equal(econBarModel({ priv, pub: { players: pub.players } }), null);
  assert.equal(econBarModel({ priv: {}, pub: {} }), null);
  assert.equal(econBarModel({}), null);
});

test('the model resolves names, partners, amounts and project affordances', () => {
  const m = econBarModel({ priv, pub });
  assert.equal(m.reserve, 5);
  assert.equal(m.transferLeft, 6);
  assert.equal(m.requestIn.fromName, '乙');
  assert.equal(m.requestIn.amount, 4);
  assert.equal(m.requestOut, null);
  assert.equal(m.requestLeft, 0);
  assert.equal(m.maxAmount, 5);
  assert.equal(m.keep, 1);
  assert.deepEqual(m.partners.map((p) => p.id), ['p_1'], 'alive teammates only');
  const procure = m.projects.find((p) => p.id === 'procure');
  assert.equal(procure.name, '联合采购');
  assert.equal(procure.level, 1);
  assert.equal(procure.cost, 8);
  assert.equal(procure.affordable, false, 'cost 8 > reserve 5');
  const storehouse = m.projects.find((p) => p.id === 'storehouse');
  assert.equal(storehouse.affordable, true);
  const logistics = m.projects.find((p) => p.id === 'logistics');
  assert.equal(logistics.maxed, true);
  assert.equal(logistics.affordable, false, 'a maxed project cannot be bought');
});

test('an outgoing request keeps its target and defaults a missing amount cap to 5', () => {
  const m = econBarModel({
    priv: { playerId: 'p_0', econ: { requestOut: { id: 'req:9', to: 'p_1', amount: 3, deadline: 0 }, requestIn: null, requestLeft: 1 } },
    pub,
  });
  assert.equal(m.requestOut.toName, '乙');
  assert.equal(m.requestOut.amount, 3);
  assert.equal(m.requestIn, null);
  assert.equal(m.maxAmount, 5);
});

/** Every text node of a vnode tree (both components are plain — htm compiles their templates when they run). */
function textOf(node, out = []) {
  if (node == null || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out; }
  if (node.props) textOf(node.props.children, out);
  return out;
}
/** The vnode whose class matches `re`, wherever it sits in the tree. */
function findByClass(node, re) {
  if (node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) { const hit = findByClass(n, re); if (hit) return hit; }
    return null;
  }
  if (typeof node.props?.class === 'string' && re.test(node.props.class)) return node;
  return node.props ? findByClass(node.props.children, re) : null;
}
const plateText = (m, extra = {}) => textOf(BorrowPlate({ econ: m, editable: true, askOpen: false, askAmount: 4, setAskOpen() {}, setAskAmount() {}, ...extra })).join(' ');
const stripText = (m, extra = {}) => textOf(EconStrip({ econ: m, editable: true, ...extra })).join(' ');

test('the shop-bar strip keeps the team economy: the reserve and the three projects', () => {
  const text = stripText(econBarModel({ priv: privIdle, pub }));
  assert.match(text, /协同资金/);
  assert.match(text, /联合采购/);
  assert.match(text, /应急仓储/);
  assert.match(text, /后勤调度/);
  assert.match(text, /MAX/);
  assert.ok(!/本回合可调拨|借钱/.test(text), 'the borrow control is not in the shop bar');
});

test('a borrow-only mode renders no shop-bar strip at all (its control is the HUD plate)', () => {
  const m = { ...econBarModel({ priv: privIdle, pub }), borrowOnly: true };
  assert.equal(EconStrip({ econ: m, editable: true }), null);
});

test('the borrow plate is the control: the count, the 借钱 caption and the click affordances', () => {
  const m = econBarModel({ priv: privIdle, pub });
  const node = BorrowPlate({ econ: m, editable: true, askOpen: false, askAmount: 4, setAskOpen() {}, setAskAmount() {} });
  const text = textOf(node).join(' ');
  assert.match(text, /本回合可调拨\s*6/);
  assert.match(text, /7/, 'the count is on the plate');
  assert.match(text, /借钱/, 'the caption says what the plate does');
  const plate = findByClass(node, /(^|\s)borrow__plate(\s|$)/);
  assert.ok(plate, 'the plate is a button');
  assert.equal(plate.props.disabled, false, 'clickable while the mode is editable and a borrow is left');
  assert.match(plate.props['aria-label'], /目前费用\s*7/, 'the plate carries the current funds as its accessible name');
  assert.match(plate.props.title, /向队友借/, 'and says what clicking it does');
});

test('the plate is disabled when the round is spent, the player is locked or nobody is left to ask', () => {
  const spent = { ...econBarModel({ priv: { ...privIdle, econ: { ...privIdle.econ, requestLeft: 0 } }, pub }) };
  assert.equal(findByClass(BorrowPlate({ econ: spent, editable: true, askOpen: false, askAmount: 1, setAskOpen() {}, setAskAmount() {} }), /borrow__plate/).props.disabled, true);
  const locked = econBarModel({ priv: privIdle, pub });
  assert.equal(findByClass(BorrowPlate({ econ: locked, editable: false, askOpen: false, askAmount: 1, setAskOpen() {}, setAskAmount() {} }), /borrow__plate/).props.disabled, true);
  const alone = { ...locked, partners: [] };
  assert.equal(findByClass(BorrowPlate({ econ: alone, editable: true, askOpen: false, askAmount: 1, setAskOpen() {}, setAskAmount() {} }), /borrow__plate/).props.disabled, true);
});

test('an incoming request shows the asker with 同意/拒绝; an outgoing one is a readout with no cancel', () => {
  const text = plateText(econBarModel({ priv, pub }));
  assert.match(text, /乙/);
  assert.match(text, /请求\s*4/);
  assert.match(text, /同意/);
  assert.match(text, /拒绝/);
  const out = econBarModel({ priv: { playerId: 'p_0', econ: { requestOut: { id: 'req:9', to: 'p_1', amount: 3, deadline: 0 }, requestIn: null, requestLeft: 1 } }, pub });
  const t2 = plateText(out);
  assert.match(t2, /已向/);
  assert.ok(!t2.includes('撤回'), 'a pending request cannot be withdrawn (user decision 2026-10-08)');
});

test('the ask picker offers the amount chips and the alive teammates once opened', () => {
  const text = plateText(econBarModel({ priv: privIdle, pub }), { askOpen: true, askAmount: 3 });
  for (const n of ['1', '2', '3', '4', '5']) assert.ok(text.includes(n), `amount chip ${n}`);
  assert.match(text, /借\s*3\s*←\s*乙/);
  assert.ok(!text.includes('丙'), 'an eliminated teammate is never a target');
});

test('the picker stacks the teammates: one row per partner (user decision 2026-10-08)', () => {
  const four = {
    econ: pub.econ,
    players: ['甲', '乙', '丙', '丁'].map((name, i) => ({ playerId: `p_${i}`, name, alive: true })),
  };
  const borrowOnly = { playerId: 'p_0', funds: 7, econ: { ...privIdle.econ, maxPerRequest: 1 } };
  const node = BorrowPlate({ econ: econBarModel({ priv: borrowOnly, pub: four }), editable: true, askOpen: true, askAmount: 1, setAskOpen() {}, setAskAmount() {} });
  const names = findByClass(node, /borrow__names/);
  assert.ok(names, 'the teammates live in one column group');
  const kids = (Array.isArray(names.props.children) ? names.props.children : [names.props.children]).flat(Infinity).filter(Boolean);
  assert.equal(kids.length, 3, 'one node per partner: three teammates ⇒ three rows');
  assert.ok(!findByClass(node, /borrow__pickrow/), 'borrow-only (one fund per request) needs no amount row');
  const amounts = BorrowPlate({ econ: econBarModel({ priv: privIdle, pub }), editable: true, askOpen: true, askAmount: 1, setAskOpen() {}, setAskAmount() {} });
  assert.ok(findByClass(amounts, /borrow__pickrow/), 'a mode with amounts keeps them on a row of their own above the names');
});

test('a ready teammate is not offered either — they could not answer (被借 e2e, 2026-10-07)', () => {
  const readyPub = { ...pub, players: pub.players.map((p) => (p.playerId === 'p_1' ? { ...p, ready: true } : p)) };
  const m = econBarModel({ priv: privIdle, pub: readyPub });
  assert.deepEqual(m.partners, [], 'nobody left to ask');
  const plate = findByClass(BorrowPlate({ econ: m, editable: true, askOpen: false, askAmount: 1, setAskOpen() {}, setAskAmount() {} }), /borrow__plate/);
  assert.equal(plate.props.disabled, true, 'so the plate is disabled rather than burning the round budget');
  assert.ok(!plateText(m, { askOpen: true, askAmount: 1 }).includes('乙'), 'and no chip for them');
});
