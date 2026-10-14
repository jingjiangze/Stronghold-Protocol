// 救援 (DESIGN §29, 促融共竞): the settle window's plate (public/js/ui/revivePlate.js). Pure component, so test/ui runs
// it without a DOM. The window is advertised by m.public.revival; absent or closed ⇒ nothing renders at all. 业主
// 2026-10-12: 其余全体存活队友各表态同意，费用从共享池按人头扣（每人 = costPer + step × 已复活次数）。
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
  open: true, round: 3, costPer: 5, costNext: 5, revives: 0, pool: 40,
  targets: [{ playerId: 'p_1', name: '乙', need: ['p_0', 'p_2'], agreed: [] }], ...o,
});

test('no 救援 in this mode, or no window open, or nobody waiting: nothing renders', () => {
  assert.equal(RevivePlate({ revival: undefined, myId: 'p_0', onRevive() {} }), null);
  assert.equal(RevivePlate({ revival: null, myId: 'p_0', onRevive() {} }), null);
  assert.equal(RevivePlate({ revival: window_({ open: false }), myId: 'p_0', onRevive() {} }), null, 'closed window');
  assert.equal(RevivePlate({ revival: window_({ targets: [] }), myId: 'p_0', onRevive() {} }), null, 'nobody waiting');
});

test('a voter who has not agreed yet gets a 同意救援 button naming the target, the cost and the pool', () => {
  const plate = RevivePlate({ revival: window_(), myId: 'p_0', onRevive() {} });
  assert.ok(plate, 'renders');
  const text = textOf(plate);
  assert.match(text, /救援/);
  assert.match(text, /每人从共享池支付 5/, 'the per-voter cost');
  assert.match(text, /池中 40/, 'the shared pool');
  assert.match(text, /乙/, 'the waiting teammate is named');
  assert.match(text, /同意 0\/2/, 'the tally');
  const [btn] = buttons(plate);
  assert.ok(btn, 'a button');
  assert.equal(btn.props.disabled, undefined, 'enabled for a voter');
  assert.match(String(btn.props.title), /把 乙 救回来/);
});

test('clicking the button reports the target', () => {
  const seen = [];
  const plate = RevivePlate({ revival: window_(), myId: 'p_0', onRevive: (id) => seen.push(id) });
  buttons(plate)[0].props.onClick();
  assert.deepEqual(seen, ['p_1']);
});

test('a voter who already agreed sees the wait, and no button', () => {
  const plate = RevivePlate({ revival: window_({ targets: [{ playerId: 'p_1', name: '乙', need: ['p_0', 'p_2'], agreed: ['p_0'] }] }), myId: 'p_0', onRevive() {} });
  assert.equal(buttons(plate).length, 0, 'no button');
  assert.match(textOf(plate), /已同意，等待其他人/);
  assert.match(textOf(plate), /同意 1\/2/, 'the tally moved');
});

test('someone outside the voter list sees the wait, and no button', () => {
  const plate = RevivePlate({ revival: window_({ targets: [{ playerId: 'p_1', name: '乙', need: ['p_0'], agreed: [] }] }), myId: 'p_9', onRevive() {} });
  assert.equal(buttons(plate).length, 0, 'no button');
  assert.match(textOf(plate), /等待队友同意/);
});

test('the downed player is told they are waiting for the whole team, not how to vote', () => {
  const plate = RevivePlate({ revival: window_(), myId: 'p_1', onRevive() {} });
  const text = textOf(plate);
  assert.match(text, /你的目标生命值耗尽，等待全体队友同意救援/);
  assert.ok(!/每人从共享池支付/.test(text), 'they are not shown the vote instructions');
});

test('several teammates waiting are all listed', () => {
  const plate = RevivePlate({
    revival: window_({ targets: [{ playerId: 'p_1', name: '乙', need: ['p_0', 'p_2'], agreed: [] }, { playerId: 'p_2', name: '丙', need: ['p_0', 'p_1'], agreed: [] }] }),
    myId: 'p_0', onRevive() {},
  });
  assert.equal(buttons(plate).length, 2);
  assert.match(textOf(plate), /乙/);
  assert.match(textOf(plate), /丙/);
});
