import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BALL_PROFILES, createBallState, calculatePushDirection, getPushThreshold,
  applyOperatorHit, applySkillDisplacement, canBlockBall, canDisplaceBall, advanceBallMotion,
} from '../lib/football-rules.mjs';

test('all official ball profiles retain their published values', () => {
  assert.deepEqual(
    ['standard', 'light', 'heavy', 'explosive', 'triple', 'bouncy', 'leaking', 'inflating', 'arctic', 'slime']
      .map(type => BALL_PROFILES[type].pushThreshold),
    [2300, 500, 3500, 3000, 4500, 4500, 7100, 10, 3800, 1500],
  );
  assert.equal(BALL_PROFILES.standard.attack, 12000);
  assert.equal(BALL_PROFILES.light.friction, 1.7);
  assert.equal(BALL_PROFILES.heavy.restitution, 1);
  assert.equal(BALL_PROFILES.triple.scoreMultiplier, 3);
  assert.equal(BALL_PROFILES.explosive.explosionDamage, 1500);
  assert.equal(BALL_PROFILES.explosive.weight, 1);
  assert.equal(BALL_PROFILES.triple.weight, 2);
  assert.equal(BALL_PROFILES.bouncy.weight, 0);
});

test('ball accumulates damage and does not move before threshold', () => {
  const ball = createBallState('standard', 4.5, 3.5);
  const actor = { id: 'operator', x: 3.5, y: 3.5, cellX: 3, cellY: 3, attackDamage: 1200 };
  assert.equal(applyOperatorHit(ball, actor).pushed, false);
  assert.equal(ball.damage, 1200);
  assert.equal(ball.vx, 0);
  assert.equal(applyOperatorHit(ball, actor).pushed, true);
  assert.equal(ball.damage, 0);
  assert.ok(ball.vx > 0);
  assert.equal(ball.kickCount, 1);
});

test('same-cell hit forces rightward direction', () => {
  const ball = createBallState('light', 4.25, 3.75);
  const direction = calculatePushDirection({
    x: 4.1, y: 3.6, cellX: 4, cellY: 3,
  }, ball);
  assert.deepEqual(
    { x: direction.x, y: direction.y, sameCell: direction.sameCell },
    { x: 1, y: 0, sameCell: true },
  );
});

test('heavy ball requires more damage than standard ball', () => {
  const ball = createBallState('heavy', 5.5, 3.5);
  const actor = { id: 'heavy-test', x: 4.5, y: 3.5, cellX: 4, cellY: 3 };
  assert.equal(applyOperatorHit(ball, actor, 1200).pushed, false);
  assert.equal(applyOperatorHit(ball, actor, 1200).pushed, false);
  assert.equal(applyOperatorHit(ball, actor, 1200).pushed, true);
});

test('explosive ball receives the official 2–5 push count before detonation', () => {
  const ball = createBallState('explosive', 4.5, 3.5, { explodeAfter: 2 });
  const actor = { id: 'operator', x: 3.5, y: 3.5, cellX: 3, cellY: 3 };
  assert.equal(ball.explodeAfter, 2);
  assert.equal(applyOperatorHit(ball, actor, 3000).explode, false);
  assert.equal(applyOperatorHit(ball, actor, 3000).explode, true);
});

test('ball motion applies friction and stops very small velocities', () => {
  const ball = createBallState('standard', 1, 1);
  ball.vx = 1;
  advanceBallMotion(ball, 1);
  assert.ok(ball.x > 1);
  assert.ok(ball.vx > 0 && ball.vx < 1);
  ball.vx = 0.001;
  ball.vy = 0.001;
  advanceBallMotion(ball, 0.1);
  assert.equal(ball.vx, 0);
  assert.equal(ball.vy, 0);
});

test('bug balls change their next push threshold and physical size', () => {
  const leaking = createBallState('leaking', 1, 1);
  assert.equal(getPushThreshold(leaking), 7100);
  for (let i = 0; i < 4; i++) applyOperatorHit(leaking, { x: 0, y: 1, cellX: 0, cellY: 1 }, 10000);
  assert.equal(getPushThreshold(leaking), 500);
  assert.ok(leaking.sizeScale < 1);

  const inflating = createBallState('inflating', 1, 1);
  assert.equal(getPushThreshold(inflating), 10);
  applyOperatorHit(inflating, { x: 0, y: 1, cellX: 0, cellY: 1 }, 10);
  assert.equal(getPushThreshold(inflating), 260);
  assert.ok(inflating.sizeScale > 0.28);
});

test('ice and slime terrain apply different friction multipliers', () => {
  const icy = createBallState('arctic', 1, 1), sticky = createBallState('slime', 1, 1);
  icy.vx = sticky.vx = 1;
  advanceBallMotion(icy, 1, 0.4);
  advanceBallMotion(sticky, 1, 1.8);
  assert.ok(icy.vx > sticky.vx);
});

test('football blocks only when at least three block slots remain', () => {
  const ball = createBallState('standard');
  assert.equal(canBlockBall({ blockCount: 2, occupiedBlockCount: 0 }, ball), false);
  assert.equal(canBlockBall({ blockCount: 3, occupiedBlockCount: 0 }, ball), true);
  assert.equal(canBlockBall({ blockCount: 4, occupiedBlockCount: 2 }, ball), false);
  assert.equal(canBlockBall({ role: 'goalkeeper', blockCount: 0, occupiedBlockCount: 0 }, ball), true);
});

test('direct skill displacement obeys football weight rather than attack threshold', () => {
  const heavy = createBallState('heavy', 2.5, 2.5);
  const blocked = applySkillDisplacement(heavy, { id: 'shift', x: 1.5, y: 2.5 }, 1);
  assert.equal(blocked.displaced, false);
  assert.equal(heavy.vx, 0);

  const moved = applySkillDisplacement(heavy, { id: 'shift', x: 1.5, y: 2.5 }, 2);
  assert.equal(moved.displaced, true);
  assert.ok(heavy.vx > 0);
  assert.equal(heavy.damage, 0);
});
