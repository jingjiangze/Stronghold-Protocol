// Pure rules for the standalone "阵地足球" prototype.
// Official ball values are transcribed from the public PRTS rules table.
// Impulse and movement are normalized to this browser game's tile scale.

export const BALL_PROFILES = Object.freeze({
  standard: Object.freeze({
    id: 'standard', label: '标准足球', weight: 1, color: 0xf4f6f4,
    attack: 12000, friction: 0.7, restitution: 0.75,
    pushThreshold: 2300, pushForce: 450, scoreMultiplier: 1,
  }),
  light: Object.freeze({
    id: 'light', label: '轻型足球', weight: 0, color: 0xa4edff,
    attack: 2500, friction: 1.7, restitution: 0.3,
    pushThreshold: 500, pushForce: 395, scoreMultiplier: 1,
  }),
  heavy: Object.freeze({
    id: 'heavy', label: '重型足球', weight: 2, color: 0xc4c9d0,
    attack: 12000, friction: 0.19, restitution: 1,
    pushThreshold: 3500, pushForce: 260, scoreMultiplier: 1,
  }),
  explosive: Object.freeze({
    id: 'explosive', label: '高能源石球', weight: 1, color: 0xffb55e,
    attack: 20000, friction: 0.65, restitution: 0.3,
    pushThreshold: 3000, pushForce: 390, scoreMultiplier: 1,
    explodeAfterMin: 2, explodeAfterMax: 5,
    explosionDamage: 1500, explosionRadius: 1.5, explosionStun: 3,
  }),
  triple: Object.freeze({
    id: 'triple', label: '至纯源石球', weight: 2, color: 0xe2b2ff,
    attack: 20000, friction: 0.48, restitution: 0.5,
    pushThreshold: 4500, pushForce: 310, scoreMultiplier: 3,
  }),
  bouncy: Object.freeze({
    id: 'bouncy', label: '无垠回荡球', weight: 0, color: 0xffed85,
    attack: 8000, friction: 0.12, restitution: 1,
    pushThreshold: 4500, pushForce: 400, scoreMultiplier: 1,
  }),
  leaking: Object.freeze({
    id: 'leaking', label: '漏气甲虫球', color: 0xffc0ca, weight: 1,
    attack: 10000, friction: 0.19, restitution: 1,
    pushThreshold: 7100, pushForce: 260, scoreMultiplier: 1,
    thresholdBehavior: 'leak', thresholdStep: 2200, maxThresholdStacks: 3,
    minPushThreshold: 500, initialSize: 1, sizeStep: -0.15, minSize: 0.55,
  }),
  inflating: Object.freeze({
    id: 'inflating', label: '膨胀甲虫球', color: 0xffa56a, weight: 1,
    attack: 10000, friction: 1.8, restitution: 0.3,
    pushThreshold: 10, pushForce: 400, scoreMultiplier: 1,
    thresholdBehavior: 'inflate', thresholdStep: 250, maxThresholdStacks: 25,
    initialSize: 0.28, sizeStep: 0.028, maxSize: 1,
  }),
  arctic: Object.freeze({
    id: 'arctic', label: '北境意志球', color: 0xa9dfff, weight: 1,
    attack: 10000, friction: 0.5, restitution: 0.9,
    pushThreshold: 3800, pushForce: 275, scoreMultiplier: 1, trail: 'ice',
  }),
  slime: Object.freeze({
    id: 'slime', label: '底海滑动球', color: 0x9bca8e, weight: 1,
    attack: 10000, friction: 0.3, restitution: 1,
    pushThreshold: 1500, pushForce: 260, scoreMultiplier: 1, trail: 'slime',
  }),
});

export const BALL_BLOCK_REQUIREMENT = 3;

export function canBlockBall(unit, ball) {
  if (!unit || !ball) return false;
  const profile = getBallProfile(ball.type);
  const blockCount = Number.isFinite(unit.blockCount) ? unit.blockCount : 0;
  const occupied = Number.isFinite(unit.occupiedBlockCount) ? unit.occupiedBlockCount : 0;
  const keeperBonus = unit.isGoalkeeper || unit.role === 'goalkeeper' ? BALL_BLOCK_REQUIREMENT : 0;
  return blockCount + keeperBonus - occupied >= BALL_BLOCK_REQUIREMENT
    && (profile.weight ?? 1) >= 0;
}

export function canDisplaceBall(ball, forceLevel) {
  const profile = getBallProfile(ball?.type);
  return Number.isFinite(forceLevel) && forceLevel > 0 && forceLevel >= (profile.weight ?? 1);
}

export function getBallProfile(type = 'standard') {
  return BALL_PROFILES[type] || BALL_PROFILES.standard;
}

export function getPushThreshold(ball) {
  const profile = getBallProfile(ball.type);
  if (profile.thresholdBehavior === 'leak') {
    return Math.max(profile.minPushThreshold, profile.pushThreshold - ball.thresholdStacks * profile.thresholdStep);
  }
  if (profile.thresholdBehavior === 'inflate') {
    return profile.pushThreshold + ball.thresholdStacks * profile.thresholdStep;
  }
  return profile.pushThreshold;
}

export function createBallState(type = 'standard', x = 0, y = 0, options = {}) {
  const profile = getBallProfile(type);
  const explodeAfter = profile.explodeAfterMin
    ? Math.max(profile.explodeAfterMin, Math.min(
      profile.explodeAfterMax,
      Number.isInteger(options.explodeAfter)
        ? options.explodeAfter
        : profile.explodeAfterMin + Math.floor(Math.random() * (profile.explodeAfterMax - profile.explodeAfterMin + 1)),
    ))
    : null;
  return {
    type: profile.id,
    x, y, vx: 0, vy: 0,
    damage: 0,
    lastHitBy: null,
    kickCount: 0,
    thresholdStacks: 0,
    sizeScale: profile.initialSize ?? 1,
    explodeAfter,
    barrierContact: null,
  };
}

/**
 * Official direction rule: extend the line from the operator's center through the ball.
 * Hitting the ball from its own tile forces a rightward push.
 */
export function calculatePushDirection(operator, ball) {
  const sameCell = Number.isFinite(operator.cellX)
    && Number.isFinite(operator.cellY)
    && operator.cellX === Math.floor(ball.x)
    && operator.cellY === Math.floor(ball.y);

  if (sameCell) return { x: 1, y: 0, distance: 0, sameCell: true };

  const dx = ball.x - operator.x;
  const dy = ball.y - operator.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-9) return { x: 1, y: 0, distance: 0, sameCell: false };
  return { x: dx / distance, y: dy / distance, distance, sameCell: false };
}

/** Accumulate attack damage; the ball only moves when the profile threshold is met. */
export function applyOperatorHit(ball, operator, damage = operator.attackDamage) {
  const profile = getBallProfile(ball.type);
  const threshold = getPushThreshold(ball);
  const amount = Number.isFinite(damage) && damage > 0 ? damage : 0;
  if (!amount) return { pushed: false, damage: ball.damage, threshold };

  const direction = calculatePushDirection(operator, ball);
  ball.damage += amount;
  ball.lastHitBy = operator.id ?? null;

  if (ball.damage < threshold) {
    return { pushed: false, damage: ball.damage, threshold, direction };
  }

  let dx = direction.x;
  let dy = direction.y;
  const speed = Math.hypot(ball.vx, ball.vy);
  if (!direction.sameCell && direction.distance > 1 && speed > 0.02) {
    const oldX = ball.vx / speed;
    const oldY = ball.vy / speed;
    const mixedX = oldX * 0.8 + dx * 0.2;
    const mixedY = oldY * 0.8 + dy * 0.2;
    const mixedLength = Math.hypot(mixedX, mixedY);
    if (mixedLength > 1e-9) {
      dx = mixedX / mixedLength;
      dy = mixedY / mixedLength;
    }
  }

  // PRTS force values use engine-specific physics units. Calibrate only the scale here.
  const impulse = profile.pushForce * 0.012;
  ball.vx += dx * impulse;
  ball.vy += dy * impulse;
  ball.damage = 0;
  ball.kickCount += 1;
  if (profile.thresholdBehavior && ball.thresholdStacks < profile.maxThresholdStacks) {
    ball.thresholdStacks += 1;
    if (profile.thresholdBehavior === 'leak') {
      ball.sizeScale = Math.max(profile.minSize, ball.sizeScale + profile.sizeStep);
    } else {
      ball.sizeScale = Math.min(profile.maxSize, ball.sizeScale + profile.sizeStep);
    }
  }

  return {
    pushed: true,
    damage: 0,
    threshold,
    direction: { ...direction, x: dx, y: dy },
    impulse,
    kickCount: ball.kickCount,
    explode: profile.id === 'explosive' && ball.kickCount >= ball.explodeAfter,
  };
}

/**
 * Model direct displacement from an operator skill. This path bypasses attack-damage
 * threshold checks, but obeys the football's official weight class.
 */
export function applySkillDisplacement(ball, operator, forceLevel, direction = null) {
  if (!canDisplaceBall(ball, forceLevel)) {
    return { displaced: false, requiredWeight: getBallProfile(ball.type).weight ?? 1 };
  }
  let dx, dy;
  if (direction && Number.isFinite(direction.x) && Number.isFinite(direction.y)) {
    dx = direction.x; dy = direction.y;
  } else {
    const push = calculatePushDirection(operator, ball);
    dx = push.x; dy = push.y;
  }
  const length = Math.hypot(dx, dy) || 1;
  dx /= length; dy /= length;
  const profile = getBallProfile(ball.type);
  const impulse = profile.pushForce * 0.012 * (1 + Math.max(0, forceLevel - (profile.weight ?? 1)) * 0.25);
  ball.vx += dx * impulse; ball.vy += dy * impulse;
  ball.damage = 0;
  ball.lastHitBy = operator?.id ?? ball.lastHitBy ?? null;
  ball.kickCount += 1;
  return { displaced: true, impulse, direction: { x: dx, y: dy }, kickCount: ball.kickCount };
}

/** Advance normalized 2D ball motion using the selected official friction profile. */
export function advanceBallMotion(ball, dt, terrainFriction = 1) {
  if (!Number.isFinite(dt) || dt <= 0) return ball;
  const profile = getBallProfile(ball.type);
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  const frictionMultiplier = Number.isFinite(terrainFriction) && terrainFriction > 0 ? terrainFriction : 1;
  const decay = Math.exp(-profile.friction * frictionMultiplier * 0.6 * dt);
  ball.vx *= decay;
  ball.vy *= decay;
  if (Math.hypot(ball.vx, ball.vy) < 0.02) {
    ball.vx = 0;
    ball.vy = 0;
  }
  return ball;
}
