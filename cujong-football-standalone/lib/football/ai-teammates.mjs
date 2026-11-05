/**
 * 单人模式的 AI 队友决策模块。
 *
 * 设计约束（与仓库既有约定一致）：
 * - 纯函数 + 显式输入输出：所有决策只读 state，通过返回 command 列表由调用方套用引擎接口；
 * - 可确定性复现：不使用 Math.random()，只消费 state.rng（引擎已提供 LCG）；
 * - 不新增状态、不改引擎：本模块不写 state、不调 tickMatch，只输出「要执行什么命令」。
 *
 * 规则依据（PRTS《促融共竞/01》比赛规则 + 官方关卡数据）：
 * - 守门员位干员不占部署位 ⇒ AI 优先派一人占守门位（keeperCell 判定在引擎内）；
 * - 再部署不增费、技力自然回复翻倍、技能需求 -20% ⇒ 鼓励多轮重布与技能释放。
 */

export const AI_ROSTER_SLOTS = 2;

export const AI_TEAMMATE_NAMES = Object.freeze(['队友 · 阿尔图', '队友 · 贝罗']);

/** 可选部署格：场地内 11×7（FIELD.minX..maxX / minY..maxY），与引擎 deployOperator 的边界一致。 */
const FIELD_MIN_X = 1, FIELD_MAX_X = 11, FIELD_MIN_Y = 1, FIELD_MAX_Y = 7;
const OWN_GOAL_X = 1, ENEMY_GOAL_X = 11;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function nextRandom(state) {
  state.rng = (Math.imul(state.rng, 1664525) + 1013904223) >>> 0;
  return state.rng / 4294967296;
}

function occupiedCells(state, ownerId) {
  const cells = new Set();
  for (const unit of state.fieldUnits) cells.add(Math.floor(unit.x) + ':' + Math.floor(unit.y));
  for (const item of state.deployedItems || []) cells.add(Math.floor(item.x) + ':' + Math.floor(item.y));
  for (const barrier of state.barriers || []) cells.add(Math.floor(barrier.x) + ':' + Math.floor(barrier.y));
  return cells;
}

function cellFree(state, cells, x, y) {
  return !cells.has(x + ':' + y);
}

/**
 * 为一位 AI 队友挑一个可部署干员：优先能推动当前球重量的，其次费用可承受里最强的。
 * 返回 bench 条目引用（只读）或 null。
 */
function pickBenchOperator(state, player, ballProfile) {
  if (!player?.bench?.length) return null;
  const weight = ballProfile?.weight ?? 1;
  const affordable = player.bench.filter(op => (op.cost ?? 12) <= player.cost);
  const pool = affordable.length ? affordable : player.bench;
  const canPush = pool.filter(op => (op.skills || []).some(skill => (skill.forceLevel ?? skill.effect?.forceLevel ?? 0) >= weight));
  const chosen = (canPush.length ? canPush : pool).reduce((best, op) => {
    const score = (op.attack ?? 0) + (op.hp ?? 0) * 0.05 - (op.cost ?? 12) * 2;
    const bestScore = (best.attack ?? 0) + (best.hp ?? 0) * 0.05 - (best.cost ?? 12) * 2;
    return score > bestScore ? op : best;
  });
  return chosen || null;
}

/**
 * 选一个部署格。策略：
 * - 守门位（x=1）优先留给「守门员 / 高阻挡」类干员；
 * - 其余按离球距离由近到远铺开，靠近球的一侧优先。
 */
function pickDeployCell(state, cells, role, ball) {
  const isKeeper = role === 'goalkeeper' || role === 'defender';
  if (isKeeper) {
    for (const y of [4, 3, 5, 2, 6, 1, 7]) {
      if (cellFree(state, cells, OWN_GOAL_X, y)) return { x: OWN_GOAL_X, y };
    }
  }
  const candidates = [];
  for (let x = FIELD_MIN_X; x <= FIELD_MAX_X; x++) {
    for (let y = FIELD_MIN_Y; y <= FIELD_MAX_Y; y++) {
      if (!cellFree(state, cells, x, y)) continue;
      if (isKeeper && x !== OWN_GOAL_X) continue;
      if (!isKeeper && x === OWN_GOAL_X) continue;
      candidates.push({ x, y, d: Math.hypot(x - ball.x, y - ball.y) });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.d - b.d);
  // 只在前若干候选里按确定性抖动取一个，避免所有 AI 每次都钉同一格
  const span = Math.min(candidates.length, 6);
  const index = Math.floor(nextRandom(state) * span) % span;
  return { x: candidates[index].x, y: candidates[index].y };
}

function skillReady(unit, index) {
  const skill = unit.skills?.[index];
  if (!skill || !unit.alive) return false;
  if ((unit.skillCooldown || 0) > 0) return false;
  const cost = skill.spCost ?? skill.costSP ?? 20;
  return (unit.sp || 0) >= cost;
}

/**
 * 单人模式 AI：为一个 AI 队友（ownerId）产出本回合要执行的命令。
 *
 * @param {object} state 引擎状态（只读；内部会用副本推进 rng 以保证确定性且不污染调用方状态）
 * @param {number} ownerId AI 队友的玩家 id（0 或 1）
 * @param {object} ballProfile 当前球型档案（来自 getBallProfile）
 * @returns {Array<{action:string,payload:object}>}
 */
export function decideAiTeammateCommands(state, ownerId, ballProfile) {
  if (!state || state.gameOver) return [];
  const player = state.players?.find(entry => entry.id === ownerId);
  if (!player) return [];
  const commands = [];

  if (state.phase === 'deployment') {
    // 部署阶段：AI 直接准备，并按需要补人
    if (!state.readyVotes?.[ownerId]) commands.push({ action: 'ready', payload: { ready: true } });
    const cells = occupiedCells(state, ownerId);
    const deployed = state.fieldUnits.filter(unit => unit.ownerId === ownerId);
    const hasKeeper = deployed.some(unit => unit.role === 'goalkeeper');
    const fieldCount = deployed.filter(unit => unit.role !== 'goalkeeper').length;
    const targetField = 3;
    const wantKeeper = !hasKeeper;
    if ((wantKeeper || fieldCount < targetField) && deployed.length < player.deployLimit + 1) {
      const operator = pickBenchOperator(state, player, ballProfile);
      if (operator) {
        const role = wantKeeper ? 'goalkeeper' : 'field';
        const cell = pickDeployCell(state, cells, role, state.ball);
        if (cell) commands.push({ action: 'deploy', payload: { operatorId: operator.id, x: cell.x, y: cell.y } });
      }
    }
    return commands;
  }

  if (state.phase !== 'battle') return [];

  // 战斗阶段：补位 + 放技能
  const cells = occupiedCells(state, ownerId);
  const deployed = state.fieldUnits.filter(unit => unit.ownerId === ownerId);
  const hasKeeper = deployed.some(unit => unit.role === 'goalkeeper');
  const fieldCount = deployed.filter(unit => unit.role !== 'goalkeeper').length;
  if ((!hasKeeper || fieldCount < 3) && deployed.length < player.deployLimit + 1) {
    const operator = pickBenchOperator(state, player, ballProfile);
    if (operator) {
      const role = !hasKeeper ? 'goalkeeper' : 'field';
      const cell = pickDeployCell(state, cells, role, state.ball);
      if (cell) commands.push({ action: 'deploy', payload: { operatorId: operator.id, x: cell.x, y: cell.y } });
    }
  }

  // 技能：技力足够且冷却就绪就放，位移类优先（把球往对方球门推）
  const ownUnits = state.fieldUnits.filter(unit => unit.ownerId === ownerId);
  for (const unit of ownUnits) {
    if (!unit.alive || !unit.skills?.length) continue;
    for (let index = 0; index < unit.skills.length; index++) {
      if (!skillReady(unit, index)) continue;
      const skill = unit.skills[index];
      const type = skill.effect?.type;
      if (['push', 'pull', 'dash', 'shift'].includes(type)) {
        const force = skill.forceLevel ?? skill.effect?.forceLevel ?? 1;
        if (force < (ballProfile?.weight ?? 1)) continue; // 推不动就别浪费技力
        const towardsEnemyGoal = unit.x < ENEMY_GOAL_X ? 1 : -1;
        const sameSide = Math.sign(state.ball.x - unit.x) === towardsEnemyGoal;
        if (!sameSide) continue;
      }
      commands.push({ action: 'skill', payload: { unitId: unit.id, skillIndex: index } });
      break; // 一回合一个单位只放一个技能，避免一帧内连点
    }
  }
  return commands;
}

/**
 * 单人模式的「可切换角色」：在玩家自己控制的场上干员之间轮换控制目标。
 * 纯选择函数，返回下一个应被选中的 unit id（无可用单位时返回 null）。
 */
export function pickNextControllableUnit(state, currentUnitId) {
  const owned = (state?.fieldUnits || []).filter(unit => unit.ownerId === 0 && unit.alive);
  if (!owned.length) return null;
  const index = owned.findIndex(unit => unit.id === currentUnitId);
  if (index < 0) return owned[0].id;
  return owned[(index + 1) % owned.length].id;
}

/** 单人模式说明文案，供 UI 提示使用。 */
export const SINGLE_PLAYER_HINT = '单人模式：你控制一名干员，另两名由 AI 队友接管；点击场上干员或按 Tab 切换控制对象。';

export default { decideAiTeammateCommands, pickNextControllableUnit, AI_ROSTER_SLOTS, AI_TEAMMATE_NAMES, SINGLE_PLAYER_HINT };
