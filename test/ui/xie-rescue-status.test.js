// 促融共竞 救援窗口 (DESIGN §29) 的名单表现：被扣住的座位是 `alive:false + pendingDeath:true`，必须显示「等待救援」
// 而不是「已淘汰」；窗口关闭后服务端撤掉 `pendingDeath` 并记下 `revivalReason`，这一行才变回 dead 并把原因挂在提示里。
// 纯逻辑/纯组件，无 DOM。Run: node --test test/ui/xie-rescue-status.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_META, revivalReasonText } from '../../public/js/ui/gameLogic.js';
import { PlayerAvatar } from '../../public/js/ui/gameComponents.js';

/** 找到 class 匹配 `re` 的 vnode。 */
const byClass = (node, re) => {
  if (node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) { const hit = byClass(n, re); if (hit) return hit; }
    return null;
  }
  if (typeof node.props?.class === 'string' && re.test(node.props.class)) return node;
  return node.props ? byClass(node.props.children, re) : null;
};

test('STATUS_META carries the 等待救援 state (the roster must not read 已淘汰 while the window is open)', () => {
  assert.ok(STATUS_META.waiting, 'the waiting entry exists');
  assert.equal(STATUS_META.waiting.text, '等待救援');
  assert.equal(STATUS_META.waiting.tone, 'gold');
  assert.equal(STATUS_META.dead.text, '已淘汰', 'the elimination entry is untouched');
});

test('revivalReasonText maps every server reason (REVIVAL_UNAVAILABLE_REASONS) and nothing else', () => {
  const want = {
    left: '已离开',
    'already-used': '已经用过救援',
    disabled: '这个模式没有救援',
    'match-ended': '对局已结束',
    'no-voter': '没有其他队友可以同意',
    pool: '共享池不够支付',
    'window-closed': '救援窗口已关闭',
    'window-expired': '没有人同意救援',
  };
  for (const [k, v] of Object.entries(want)) assert.equal(revivalReasonText(k), v, k);
  assert.equal(revivalReasonText(null), null, 'no reason');
  assert.equal(revivalReasonText(undefined), null);
  assert.equal(revivalReasonText('no-helper'), null, 'the old reason name is gone');
  assert.equal(revivalReasonText('donor-lp'), null, 'and so is the donor-LP one');
});

test('PlayerAvatar: a held seat shows the hourglass, a real elimination keeps the ✕', () => {
  const held = PlayerAvatar({ player: { playerId: 'p_1', name: '乙', alive: false, pendingDeath: true } });
  assert.match(String(held.props.class), /is-waiting/, 'the waiting modifier');
  assert.doesNotMatch(String(held.props.class), /is-dead/, 'and NOT the dead one');
  const wait = byClass(held, /pavatar__wait/);
  assert.ok(wait, 'the waiting badge renders');
  assert.equal(wait.props['aria-label'], '等待救援');
  assert.equal(byClass(held, /pavatar__x/), null, 'no ✕ overlay');

  const gone = PlayerAvatar({ player: { playerId: 'p_2', name: '丙', alive: false } });
  assert.match(String(gone.props.class), /is-dead/, 'a plain elimination stays dead');
  assert.doesNotMatch(String(gone.props.class), /is-waiting/);
  assert.ok(byClass(gone, /pavatar__x/), 'with the ✕ overlay');
  assert.equal(byClass(gone, /pavatar__wait/), null, 'and no hourglass');

  // a live seat gets neither
  const live = PlayerAvatar({ player: { playerId: 'p_0', name: '甲', alive: true } });
  assert.doesNotMatch(String(live.props.class), /is-(dead|waiting)/);
});
