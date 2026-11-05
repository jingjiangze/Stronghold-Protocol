import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMatchState, deployOperator, activateSkill, tickMatch, voteReady,
} from '../lib/football/match-engine.mjs';
import { getBallProfile } from '../lib/football-rules.mjs';
import {
  decideAiTeammateCommands, pickNextControllableUnit, AI_ROSTER_SLOTS, AI_TEAMMATE_NAMES,
} from '../lib/football/ai-teammates.mjs';

const roster = [
  { id:'test-vanguard', name:'测试先锋', profession:'vanguard', cost:10, attack:300, hp:1200,
    defense:150, blockCount:2, range:2, attackInterval:1, redeploySeconds:20, initialSp:20, maxSp:30,
    skills:[{id:'push-weak',name:'弱推',spCost:5,initialSp:0,cooldownSeconds:10,effect:{type:'push',forceLevel:1}}] },
  { id:'test-guard', name:'测试近卫', profession:'guard', cost:15, attack:500, hp:1800,
    defense:250, blockCount:3, range:1, attackInterval:1.2, redeploySeconds:25, initialSp:10, maxSp:30,
    skills:[{id:'push-heavy',name:'重推',spCost:5,initialSp:0,cooldownSeconds:10,effect:{type:'push',forceLevel:2}}] },
  { id:'test-keeper', name:'测试守门', profession:'defender', cost:12, attack:200, hp:2000,
    defense:400, blockCount:3, range:1, attackInterval:1.5, redeploySeconds:20, initialSp:0, maxSp:30,
    skills:[{id:'guard',name:'驻守',spCost:5,initialSp:0,cooldownSeconds:10,effect:{type:'attack-buff',duration:1}}] },
];

const applyCommands = (state, ownerId, commands) => commands.reduce((acc, command) => {
  switch (command.action) {
    case 'deploy': return deployOperator(acc, ownerId, command.payload.operatorId, command.payload.x, command.payload.y).state;
    case 'skill': return activateSkill(acc, command.payload.unitId, command.payload.skillIndex ?? 0).state;
    case 'ready': return voteReady(acc, ownerId, command.payload.ready !== false);
    default: return acc;
  }
}, state);

test('single-player AI exposes two teammate slots and two names', () => {
  assert.equal(AI_ROSTER_SLOTS, 2);
  assert.equal(AI_TEAMMATE_NAMES.length, 2);
});

test('AI teammate readies up during deployment and deploys a keeper on the goal column first', () => {
  const state = createMatchState({ operators: roster, seed: 23 });
  const commands = decideAiTeammateCommands(state, 1, getBallProfile(state.ball.type));
  assert.ok(commands.some(command => command.action === 'ready' && command.payload.ready === true));
  const deploy = commands.find(command => command.action === 'deploy');
  assert.ok(deploy, 'AI 应在部署阶段派出第一名干员');
  // 守门位在引擎内由 keeperCell 判定（x===1），AI 首个落点必须落在 x=1
  assert.equal(deploy.payload.x, 1);
  const next = applyCommands(state, 1, commands);
  assert.equal(next.readyVotes[1], true);
  assert.equal(next.fieldUnits.length, 1);
  assert.equal(next.fieldUnits[0].role, 'goalkeeper');
});

test('AI deploy cells stay inside the playable field and never collide with an occupied cell', () => {
  let state = createMatchState({ operators: roster, seed: 23 });
  const profile = getBallProfile(state.ball.type);
  for (let round = 0; round < 6; round++) {
    const commands = decideAiTeammateCommands(state, 1, profile);
    for (const command of commands) {
      if (command.action !== 'deploy') continue;
      const { x, y } = command.payload;
      assert.ok(x >= 1 && x <= 11 && y >= 1 && y <= 7, `落点越界: ${x},${y}`);
      assert.equal(state.fieldUnits.some(unit => Math.floor(unit.x) === x && Math.floor(unit.y) === y), false, `落点与已有单位重叠: ${x},${y}`);
    }
    state = applyCommands(state, 1, commands);
  }
  // 至多一个守门 + deployLimit 个场上单位
  const keepers = state.fieldUnits.filter(unit => unit.ownerId === 1 && unit.role === 'goalkeeper');
  assert.equal(keepers.length <= 1, true);
  // 费用不足时引擎会拒绝部署，但 AI 仍可发出指令（下单是决策，拒绝是引擎的职责）
  const broke = { ...state, players: state.players.map(p => p.id === 1 ? { ...p, cost: 0 } : p) };
  const brokeCommands = decideAiTeammateCommands(broke, 1, profile).filter(c => c.action === 'deploy');
  for (const command of brokeCommands) {
    const result = deployOperator(broke, 1, command.payload.operatorId, command.payload.x, command.payload.y);
    assert.equal(result.ok, false, '费用为 0 时引擎必须拒绝部署');
  }
});

test('AI never wastes SP on a displacement skill the ball weight rejects', () => {
  let state = createMatchState({ operators: roster, ballType: 'heavy', seed: 23 });
  const profile = getBallProfile(state.ball.type);
  assert.equal(profile.weight >= 2, true);
  // 手动给 AI 侧摆一个只会弱推的单位，sp 拉满
  state = deployOperator(state, 1, 'test-vanguard', 5, 4).state;
  const unitId = state.fieldUnits.find(unit => unit.ownerId === 1).id;
  state = { ...state, fieldUnits: state.fieldUnits.map(unit => unit.id === unitId ? { ...unit, sp: 30, skillCooldown: 0 } : unit) };
  const commands = decideAiTeammateCommands(state, 1, profile);
  const weakSkill = commands.find(command => command.action === 'skill' && command.payload.skillIndex === 0);
  assert.equal(weakSkill, undefined, '力度不足的位移技能不应被 AI 释放');
});

test('AI decisions are deterministic for the same state', () => {
  const state = createMatchState({ operators: roster, seed: 99 });
  const profile = getBallProfile(state.ball.type);
  const first = decideAiTeammateCommands(state, 1, profile);
  const second = decideAiTeammateCommands(state, 1, profile);
  assert.deepEqual(first, second);
});

test('switching control cycles through the player own living units', () => {
  let state = createMatchState({ operators: roster, seed: 23 });
  state = deployOperator(state, 0, 'test-vanguard', 3, 3).state;
  state = deployOperator(state, 0, 'test-guard', 4, 3).state;
  const [first, second] = state.fieldUnits.map(unit => unit.id);
  assert.equal(pickNextControllableUnit(state, null), first);
  assert.equal(pickNextControllableUnit(state, first), second);
  assert.equal(pickNextControllableUnit(state, second), first);
  const noUnit = createMatchState({ operators: roster, seed: 23 });
  assert.equal(pickNextControllableUnit(noUnit, null), null);
});

test('AI stays idle once the match is finished', () => {
  let state = createMatchState({ operators: roster, seed: 23 });
  state = { ...state, gameOver: true, phase: 'finished' };
  assert.deepEqual(decideAiTeammateCommands(state, 1, getBallProfile('standard')), []);
});

test('AI makes progress on its own: it fills the field over repeated decision rounds', () => {
  let state = createMatchState({ operators: roster, seed: 23 });
  const profile = getBallProfile(state.ball.type);
  // 部署阶段费用不增长（初始 30 只够 2 人：10+15+12=37>30），先开战让费用随时间恢复。
  // costIncreaseSeconds=0.85 ⇒ 每秒才涨 1 点；一轮推 1s（20×0.05，引擎单 tick 上限 0.1s 内累计），
  // 需约 15 轮才能把第三人（cost 12）的费用攒出来。
  state = voteReady(state, 0, true);
  state = voteReady(state, 1, true);
  assert.equal(state.phase, 'battle');
  let guard = 0;
  while (state.fieldUnits.filter(unit => unit.ownerId === 1).length < 3 && guard++ < 40) {
    for (let step = 0; step < 20; step++) state = tickMatch(state, .05);
    state = applyCommands(state, 1, decideAiTeammateCommands(state, 1, profile));
  }
  const owned = state.fieldUnits.filter(unit => unit.ownerId === 1);
  assert.ok(owned.length >= 3, `AI 应自行铺满至少 3 名场上干员，实际 ${owned.length}`);
  assert.equal(owned.some(unit => unit.role === 'goalkeeper'), true);
  assert.equal(owned.every(unit => unit.ownerId === 1 && unit.team === 0), true);
});

test('allied units close the distance to a stationary ball instead of standing still', () => {
  let state = createMatchState({ operators: roster, ballType: 'standard', seed: 23 });
  // 落点取 x=3：x=1 会被 keeperCell 判成守门位，x=2 / x=10 是 startBattle 播撒的屏障列。
  // 球静止在 (6.5,4.5)，敌方全部在 x>=9.4 的右侧，0.5 秒内球不会被任何单位碰到。
  state = deployOperator(state, 1, 'test-vanguard', 3, 3).state;
  const unit = state.fieldUnits.find(item => item.ownerId === 1);
  assert.equal(unit.role, 'field');
  const startX = unit.x;
  const startDist = Math.hypot(unit.x - state.ball.x, unit.y - state.ball.y);
  assert.ok(startDist > unit.range, `测试前提：单位初始应在射程之外，实际 ${startDist.toFixed(2)}`);
  state = voteReady(state, 0, true);
  state = voteReady(state, 1, true);
  assert.equal(state.phase, 'battle');
  for (let step = 0; step < 10; step++) state = tickMatch(state, .05);
  const moved = state.fieldUnits.find(item => item.id === unit.id);
  assert.ok(moved.x > startX + .2, `单位应向右朝球推进，实际 x=${moved.x.toFixed(2)}（起点 ${startX}）`);
  const endDist = Math.hypot(moved.x - state.ball.x, moved.y - state.ball.y);
  assert.ok(endDist < startDist - .2, `与球的距离应明显缩短：${startDist.toFixed(2)} → ${endDist.toFixed(2)}`);
});

test('allied goalkeeper holds the goal column and never chases the ball', () => {
  let state = createMatchState({ operators: roster, ballType: 'standard', seed: 23 });
  state = deployOperator(state, 1, 'test-keeper', 1, 3).state;
  const keeper = state.fieldUnits.find(item => item.ownerId === 1);
  assert.equal(keeper.role, 'goalkeeper');
  const startDist = Math.hypot(keeper.x - state.ball.x, keeper.y - state.ball.y);
  assert.ok(startDist > keeper.range, `测试前提：守门员初始应在射程之外，实际 ${startDist.toFixed(2)}`);
  state = voteReady(state, 0, true);
  state = voteReady(state, 1, true);
  assert.equal(state.phase, 'battle');
  for (let step = 0; step < 10; step++) state = tickMatch(state, .05);
  const after = state.fieldUnits.find(item => item.id === keeper.id);
  assert.equal(after.x, keeper.x, '守门员不应离开球门列');
  assert.equal(after.y, keeper.y, '守门员不应纵向追球');
});

test('a full single-player match keeps both sides in sync after ticking', () => {
  let state = createMatchState({ operators: roster, seed: 23 });
  const profile = getBallProfile(state.ball.type);
  state = applyCommands(state, 0, decideAiTeammateCommands(state, 0, profile));
  state = applyCommands(state, 1, decideAiTeammateCommands(state, 1, profile));
  state = voteReady(state, 0, true);
  state = voteReady(state, 1, true);
  assert.equal(state.phase, 'battle');
  const before = state.timeRemaining;
  state = tickMatch(state, .05);
  assert.ok(state.timeRemaining < before);
  assert.ok(state.elapsed > 0);
});
