// 救援 (DESIGN §29, 促融共竞): the settle window's plate (public/js/ui/revivePlate.js). Pure component, so test/ui runs
// it without a DOM. The window is advertised by m.public.revival; absent or closed ⇒ nothing renders at all.
// Run: node --test test/ui/revive-ui.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RevivePlate } from '../../public/js/ui/revivePlate.js';

/** Text of a rendered tree (the plate is small: every string in it is user-visible). */
const textOf = (node) => {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  const kids = node.props && node.props.children;
  return textOf(kids);
};
const buttons = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const c of node) buttons(c, out); return out; }
  if (node.type === 'button') out.push(node);
  buttons(node.props && node.props.children, out);
  return out;
};

const window_ = (o = {}) => ({
  open: true, round: 3, cost: 10, minDonorLp: 11,
  donors: ['p_0'], targets: [{ playerId: 'p_1', name: '乙' }], ...o,
});

test('no 救援 in this mode, or no window open, or nobody waiting: nothing renders', () => {
  assert.equal(RevivePlate({ revival: undefined, myId: 'p_0', onRevive() {} }), null);
  assert.equal(RevivePlate({ revival: null, myId: 'p_0', onRevive() {} }), null);
  assert.equal(RevivePlate({ revival: window_({ open: false }), myId: 'p_0', onRevive() {} }), null, 'closed window');
  assert.equal(RevivePlate({ revival: window_({ targets: [] }), myId: 'p_0', onRevive() {} }), null, 'nobody waiting');
});

test('an eligible donor gets a 救援 button naming the target and the cost', () => {
  const plate = RevivePlate({ revival: window_(), myId: 'p_0', onRevive() {} });
  assert.ok(plate, 'renders');
  const text = textOf(plate);
  assert.match(text, /救援/);
  assert.match(text, /花费 10 点生命值/);
  assert.match(text, /乙/, 'the waiting teammate is named');
  const [btn] = buttons(plate);
  assert.ok(btn, 'a button');
  assert.equal(btn.props.disabled, undefined, 'enabled for a donor');
  assert.match(String(btn.props.title), /把 乙 救回来/);
});

test('clicking the button reports the target', () => {
  const seen = [];
  const plate = RevivePlate({ revival: window_(), myId: 'p_0', onRevive: (id) => seen.push(id) });
  buttons(plate)[0].props.onClick();
  assert.deepEqual(seen, ['p_1']);
});

test('someone who cannot donate sees why, and no button', () => {
  const plate = RevivePlate({ revival: window_({ donors: [] }), myId: 'p_0', onRevive() {} });
  assert.equal(buttons(plate).length, 0, 'no button');
  const text = textOf(plate);
  assert.match(text, /等待救援/, 'the target row says they are waiting');
  assert.match(text, /本回合你不能救援/, 'and the reason is spelled out');
  assert.match(text, /不少于 11/, 'including the LP floor');
});

test('the downed player is told they are waiting for a teammate, not how to donate', () => {
  const plate = RevivePlate({ revival: window_({ donors: [] }), myId: 'p_1', onRevive() {} });
  const text = textOf(plate);
  assert.match(text, /你的目标生命值耗尽，等待队友救援/);
  assert.ok(!/不少于 11/.test(text), 'they are not shown the donor requirements');
});

test('several teammates waiting are all listed', () => {
  const plate = RevivePlate({
    revival: window_({ donors: ['p_0'], targets: [{ playerId: 'p_1', name: '乙' }, { playerId: 'p_2', name: '丙' }] }),
    myId: 'p_0', onRevive() {},
  });
  assert.equal(buttons(plate).length, 2);
  assert.match(textOf(plate), /乙/);
  assert.match(textOf(plate), /丙/);
});
