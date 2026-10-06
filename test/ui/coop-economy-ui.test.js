// 协同经济 (DESIGN §25): the bottom bar's team-economy model — pure, so it is testable without a DOM (test/ui runs
// on the same modules the browser loads). The rule set is advertised by m.public.econ; absent ⇒ the bar shows nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { econBarModel } from '../../public/js/ui/econBar.js';
import { EconStrip } from '../../public/js/ui/shopBar.js';

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

/** Every text node of a vnode tree (EconStrip is a plain component — htm compiles its templates when it runs). */
function textOf(node, out = []) {
  if (node == null || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out; }
  if (node.props) textOf(node.props.children, out);
  return out;
}
const stripText = (m, extra = {}) => textOf(EconStrip({ econ: m, editable: true, askOpen: false, askAmount: 4, setAskOpen() {}, setAskAmount() {}, ...extra })).join(' ');

test('the strip renders the reserve, the transfer budget and the three projects', () => {
  const text = stripText(econBarModel({ priv: privIdle, pub }));
  assert.match(text, /协同资金/);
  assert.match(text, /本回合可调拨\s*6/);
  assert.match(text, /7\s*目前费用/, 'the fee readout shows the current funds');
  assert.match(text, /借钱/);
  assert.match(text, /联合采购/);
  assert.match(text, /应急仓储/);
  assert.match(text, /后勤调度/);
  assert.match(text, /MAX/);
});

test('an incoming request shows the asker with 同意/拒绝; an outgoing one shows 撤回', () => {
  const text = stripText(econBarModel({ priv, pub }));
  assert.match(text, /乙/);
  assert.match(text, /请求\s*4/);
  assert.match(text, /同意/);
  assert.match(text, /拒绝/);
  const out = econBarModel({ priv: { playerId: 'p_0', econ: { requestOut: { id: 'req:9', to: 'p_1', amount: 3, deadline: 0 }, requestIn: null, requestLeft: 1 } }, pub });
  const t2 = stripText(out);
  assert.match(t2, /已向/);
  assert.match(t2, /撤回/);
});

test('the ask picker offers the amount chips and the alive teammates once opened', () => {
  const text = stripText(econBarModel({ priv: privIdle, pub }), { askOpen: true, askAmount: 3 });
  for (const n of ['1', '2', '3', '4', '5']) assert.ok(text.includes(n), `amount chip ${n}`);
  assert.match(text, /借\s*3\s*←\s*乙/);
  assert.ok(!text.includes('丙'), 'an eliminated teammate is never a target');
});
