import {
  getBallProfile, getPushThreshold, createBallState, applyOperatorHit,
  applySkillDisplacement, advanceBallMotion, canBlockBall,
} from '../football-rules.mjs';

export const MATCH_RULESETS = Object.freeze({
  classic: Object.freeze({
    id:'classic', label:'促融共竞 #1 规则',
    redeployTimeMultiplier:0.5,
    eliteSkillCostMultiplier:0.8,
  }),
  updated: Object.freeze({
    id:'updated', label:'后续阵地足球规则',
    redeployTimeMultiplier:1,
    eliteSkillCostMultiplier:1,
  }),
});

export const MATCH_STAGES = Object.freeze({
  training: { id:'training', label:'训练场', levelId:'IG-TR-2', durationSeconds:300, initialCost:30, costCap:99, costIncreaseSeconds:0.85, spRegenMultiplier:2, skillCostMultiplier:0.8, stampsEnabled:false },
  beginner: { id:'beginner', label:'初级赛', levelId:'IG-FT-1', durationSeconds:300, initialCost:30, costCap:99, costIncreaseSeconds:0.85, spRegenMultiplier:2, skillCostMultiplier:0.8, stampsEnabled:true, stampMargins:[1,2,4] },
  advanced: { id:'advanced', label:'高级赛', levelId:'IG-FT-2', durationSeconds:300, initialCost:30, costCap:99, costIncreaseSeconds:0.85, spRegenMultiplier:2, skillCostMultiplier:0.8, stampsEnabled:true, stampMargins:[1,2,4] },
  elite: { id:'elite', label:'特级赛', levelId:'IG-S-4', durationSeconds:300, initialCost:30, costCap:99, costIncreaseSeconds:0.85, spRegenMultiplier:2, skillCostMultiplier:1, stampsEnabled:true, stampMargins:[1,2,4] },
});

export const MATCH_STYLES = Object.freeze({
  basic: { id:'basic', label:'基础', attackMultiplier:1.1, redeployMultiplier:1, initialSpBonus:0, deployLimitDelta:0, attackSpeedBonus:0, spRefundChance:0, damageTakenMultiplier:1, healingMultiplier:1, rangeSpPerSecond:0, statusDurationMultiplier:1, uncontrolledTargetDamageMultiplier:1, itemId:'cheer-squad' },
  anchoring: { id:'anchoring', label:'驻场', attackGrowthMax:1.6, hpGrowthMax:1.6, growthDurationSeconds:120, redeployMultiplier:1.15, initialSpBonus:0, deployLimitDelta:0, attackSpeedBonus:0, spRefundChance:0, damageTakenMultiplier:1, healingMultiplier:1, rangeSpPerSecond:0, statusDurationMultiplier:1, uncontrolledTargetDamageMultiplier:1, itemId:'armor-distributor' },
  roaming: { id:'roaming', label:'游走', attackMultiplier:1, redeployMultiplier:0.8, initialSpBonus:10, deployLimitDelta:-1, attackSpeedBonus:0, spRefundChance:0, damageTakenMultiplier:1, healingMultiplier:1, rangeSpPerSecond:0, statusDurationMultiplier:1, uncontrolledTargetDamageMultiplier:1, itemId:'firework-box' },
  offensive: { id:'offensive', label:'攻坚', attackMultiplier:1, redeployMultiplier:1, initialSpBonus:0, deployLimitDelta:0, attackSpeedBonus:20, spRefundChance:0.1, spRefundAmount:1, damageTakenMultiplier:1.2, healingMultiplier:1, rangeSpPerSecond:0, statusDurationMultiplier:1, uncontrolledTargetDamageMultiplier:1, itemId:'energy-drink' },
  supportive: { id:'supportive', label:'支援', attackMultiplier:0.9, redeployMultiplier:1, initialSpBonus:0, deployLimitDelta:0, attackSpeedBonus:0, spRefundChance:0, damageTakenMultiplier:1, healingMultiplier:1.4, rangeSpPerSecond:1, rangeSpNonStacking:true, statusDurationMultiplier:1, uncontrolledTargetDamageMultiplier:1, itemId:'soda-machine' },
  disabling: { id:'disabling', label:'控制', attackMultiplier:1, redeployMultiplier:1, initialSpBonus:0, deployLimitDelta:0, attackSpeedBonus:0, spRefundChance:0, damageTakenMultiplier:1, healingMultiplier:1, rangeSpPerSecond:0, statusDurationMultiplier:2.5, uncontrolledTargetDamageMultiplier:0.85, itemId:'illusion-mirror' },
});

export const CARRIED_ITEMS = Object.freeze({
  'cheer-squad': { id:'cheer-squad', label:'赛场啦啦队', cost:5, redeploySeconds:60, effect:'temporary-attack-boost', scope:'both-teams', attackMultiplier:1.2, durationSeconds:10 },
  'armor-distributor': { id:'armor-distributor', label:'护具分发员', cost:5, redeploySeconds:60, effect:'grant-barrier', scope:'both-teams', barrier:6000, durationSeconds:10, durationIsCalibration:true },
  'firework-box': { id:'firework-box', label:'混乱烟花箱', cost:5, redeploySeconds:60, effect:'burst-and-reset-redeploy', damage:3000 },
  'energy-drink': { id:'energy-drink', label:'猛兽能量饮料', cost:5, redeploySeconds:60, effect:'temporary-attack-speed-zero-resist', scope:'both-teams', attackSpeedBonus:1000, durationSeconds:10, durationIsCalibration:true },
  'soda-machine': { id:'soda-machine', label:'喷射汽水机', cost:5, redeploySeconds:60, effect:'random-sp-supply', scope:'both-teams', spAmount:3, periodSeconds:3, durationSeconds:15, durationIsCalibration:true },
  'illusion-mirror': { id:'illusion-mirror', label:'迷幻反射镜', cost:5, redeploySeconds:60, effect:'periodic-control-and-controlled-damage-boost', controlledDamageMultiplier:1.4, controlPeriodSeconds:10, controlDurationSeconds:5, durationSeconds:30, durationIsCalibration:true },
});

export const OPPONENT_TEAMS = Object.freeze({
  standard: { id:'standard', label:'标准队', tactic:'nearest-ball-then-direct-shot', shootPower:1, shootInterval:1.0, hitmanAttack:1, hitmanSpeed:1 },
  tactical: { id:'tactical', label:'战术队', tactic:'fast-shot-at-open-goal', shootPower:1.3, shootInterval:0.65, hitmanAttack:1, hitmanSpeed:1 },
  loveBall: { id:'loveBall', label:'爱球会', tactic:'approach-and-set-up-shot', shootPower:0.9, shootInterval:1.15, hitmanAttack:1, hitmanSpeed:1 },
  fairPlay: { id:'fairPlay', label:'球德联', tactic:'high-power-shot-and-pressure', shootPower:1.35, shootInterval:0.85, hitmanAttack:1.3, hitmanSpeed:1.2 },
});

export const FIELD = Object.freeze({
  cols:13, rows:9, minX:1, maxX:11, minY:1, maxY:7,
  leftGoalX:0.75, rightGoalX:12.25, goalYMin:1.0, goalYMax:8.0,
  ballStart:{x:6.5,y:4.5},
});

const DEFAULT_ENEMIES = [
  { id:'enemy-kicker', name:'对方击球手', profession:'guard', role:'kicker', attack:600, hp:3000, defense:250, attackInterval:1, blockCount:2, range:1, moveSpeed:1.2 },
  { id:'enemy-keeper', name:'对方守门员', profession:'defender', role:'goalkeeper', attack:400, hp:4500, defense:600, attackInterval:1.2, blockCount:0, range:1, moveSpeed:0.9 },
  { id:'enemy-hitman', name:'对方击人手', profession:'guard', role:'hitman', attack:500, hp:3600, defense:300, attackInterval:0.9, blockCount:2, range:1, moveSpeed:1.0 },
];

const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
const clone = value => structuredClone(value);
const dist = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
const unitKey = (ownerId,operatorId) => ownerId + ':' + operatorId;
const stageFor = state => MATCH_STAGES[state.stageId] || MATCH_STAGES.beginner;
const rulesetFor = state => MATCH_RULESETS[state.rulesetId] || MATCH_RULESETS.updated;
const styleFor = state => MATCH_STYLES[state.styleId] || MATCH_STYLES.basic;
const itemFor = state => CARRIED_ITEMS[styleFor(state).itemId];
function random(state) {
  state.rng = (Math.imul(state.rng,1664525)+1013904223)>>>0;
  return state.rng/4294967296;
}
function emit(state,type,payload={}) {
  state.events.push({ seq:state.eventSeq++, time:state.elapsed, type, ...payload });
  if(state.events.length>160)state.events.shift();
}
function playerOf(state,id) { return state.players.find(player=>player.id===id); }
function unitOf(state,id) { return state.fieldUnits.find(unit=>unit.id===id)||state.enemyUnits.find(unit=>unit.id===id); }
function keeperCell(x,y,ownerId) { return x===1&&y>=1&&y<=7; }
function barrierAt(state,x,y) { return state.barriers.some(barrier=>Math.floor(barrier.x)===x&&Math.floor(barrier.y)===y); }
function makeUnit(def,ownerId,team,x,y,role='field') {
  const hp=def.hp??1400;
  return {
    id:unitKey(ownerId,def.id), operatorId:def.id, ownerId, team, name:def.name||def.id,
    profession:def.profession||'guard', rarity:def.rarity??3, x,y, role,
    hp,maxHp:hp,atk:def.attack??300,defense:def.defense??0,resistance:def.resistance??0,
    cost:def.cost??12,blockCount:def.blockCount??1,occupiedBlockCount:0,range:def.range??2,
    attackInterval:def.attackInterval??1.5,attackCooldown:0,sp:def.initialSp??0,maxSp:def.maxSp??30,
    redeploySeconds:def.redeploySeconds??70,stunSeconds:0,respawnSeconds:0,barrier:0,
    skills:clone(def.skills||[]),definition:clone(def),activeSkill:null,skillCooldown:0,lastSkill:null,
    alive:true,moveSpeed:def.moveSpeed??1,ballHitCooldown:0,deployedAt:0,isGoalkeeper:role==='goalkeeper',
  };
}
function spawnEnemies(state) {
  const tactic=OPPONENT_TEAMS[state.opponentTeamId]||OPPONENT_TEAMS.standard;
  state.enemyUnits=[
    makeUnit({...DEFAULT_ENEMIES[0],attack:DEFAULT_ENEMIES[0].attack*tactic.shootPower,attackInterval:tactic.shootInterval},'ai',1,9.4,3.2,'kicker'),
    makeUnit(DEFAULT_ENEMIES[1],'ai',1,11,4.5,'goalkeeper'),
    makeUnit({...DEFAULT_ENEMIES[2],attack:DEFAULT_ENEMIES[2].attack*tactic.hitmanAttack,attackInterval:DEFAULT_ENEMIES[2].attackInterval/tactic.hitmanSpeed},'ai',1,9.4,5.7,'hitman'),
  ];
  if(state.opponentTeamId==='loveBall'){
    state.enemyUnits.push(makeUnit({...DEFAULT_ENEMIES[0],id:'enemy-striker',name:'爱球会接应击球手',attack:DEFAULT_ENEMIES[0].attack*.9,attackInterval:1.1},'ai',1,7.8,4.5,'striker'));
  }
}
export function createMatchState({stageId='beginner',styleId='basic',ballType='standard',rulesetId='updated',operators=[],seed=2463534242,roomId=null}={}) {
  const stage=MATCH_STAGES[stageId]||MATCH_STAGES.beginner;
  const style=MATCH_STYLES[styleId]?MATCH_STYLES[styleId]:MATCH_STYLES.basic;
  const roster=clone(operators||[]);
  const state={
    version:1,phase:'deployment',stageId:stage.id,styleId:style.id,rulesetId:MATCH_RULESETS[rulesetId]?rulesetId:'updated',opponentTeamId:Object.keys(OPPONENT_TEAMS)[seed%4],
    rng:seed>>>0,elapsed:0,timeRemaining:stage.durationSeconds,costClock:0,
    score:{ally:0,enemy:0},stamps:0,roomId,players:[
      {id:0,name:'玩家 1',cost:stage.initialCost,bench:clone(roster),deployLimit:Math.max(1,12+style.deployLimitDelta),connected:true,itemCooldownRemaining:0,costRequestCooldown:0},
      {id:1,name:'玩家 2',cost:stage.initialCost,bench:clone(roster),deployLimit:Math.max(1,12+style.deployLimitDelta),connected:true,itemCooldownRemaining:0,costRequestCooldown:0},
    ],
    fieldUnits:[],enemyUnits:[],deployedItems:[],redeployRemaining:{},barriers:[],ball:createBallState(ballType,FIELD.ballStart.x,FIELD.ballStart.y),
    ballInBench:false,restart:{ownerId:null,remaining:0},activeEffects:[],selectedOperator:{0:null,1:null},
    pauseVotes:{0:false,1:false},speedVotes:{0:false,1:false},readyVotes:{0:false,1:false},paused:false,speed:1,
    pendingCostRequest:null,events:[],eventSeq:1,gameOver:false,
  };
  spawnEnemies(state);
  return state;
}
function effectiveSkillCost(state,skill) {
  const stage=stageFor(state);
  const ruleset=rulesetFor(state);
  const multiplier=state.stageId==='elite'
    ? ruleset.eliteSkillCostMultiplier
    : stage.skillCostMultiplier;
  return Math.max(1,Math.ceil((skill.spCost??skill.costSP??20)*multiplier));
}
function damageUnit(state,unit,amount,cause='combat',source=null) {
  if(!unit||!unit.alive)return;
  let damage=Math.max(0,Number(amount)||0);
  const style=styleFor(state);
  if(unit.team===0)damage*=style.damageTakenMultiplier;
  if(unit.team===1&&source?.team===0&&unit.stunSeconds<=0)damage*=style.uncontrolledTargetDamageMultiplier;
  const mirrorBoost=state.activeEffects.some(effect=>effect.effect==='periodic-control-and-controlled-damage-boost'&&effect.remaining>0)
    ? (state.activeEffects.find(effect=>effect.effect==='periodic-control-and-controlled-damage-boost'&&effect.remaining>0)?.controlledDamageMultiplier ?? 1)
    : 1;
  if(unit.team===1&&source?.team===0&&unit.stunSeconds>0)damage*=mirrorBoost;
  const drink=state.activeEffects.some(effect=>effect.effect==='temporary-attack-speed-zero-resist'&&effect.remaining>0);
  const defense=drink?0:(unit.defense||0);
  if(cause!=='football-impact'&&cause!=='explosive-ball')damage=Math.max(damage*0.05,damage-defense);
  const absorbed=Math.min(unit.barrier||0,damage);
  unit.barrier-=absorbed;
  unit.hp-=Math.max(0,Math.round(damage-absorbed));
  if(unit.hp<=0){
    unit.hp=0;unit.alive=false;unit.respawnSeconds=15;unit.stunSeconds=0;
    emit(state,'UNIT_DOWN',{unitId:unit.id,cause,respawnSeconds:unit.respawnSeconds});
  }
}
function seedBarriers(state) {
  const barriers=[];
  for(const x of [2,10]){
    const rows=new Set();
    while(rows.size<3)rows.add(2+Math.floor(random(state)*5));
    for(const y of rows)barriers.push({id:'barrier-'+x+'-'+y,x:x+.5,y:y+.5,hp:24000,maxHp:24000});
  }
  state.barriers=barriers;
}
function applyItemEffect(state,ownerId) {
  const item=itemFor(state),player=playerOf(state,ownerId);
  if(!item||!player||player.itemCooldownRemaining>0)return {ok:false,reason:'item-cooldown'};
  const remaining=item.effect==='burst-and-reset-redeploy'?0:(item.durationSeconds??10);
  const effect={...clone(item),id:'item-'+state.elapsed+'-'+ownerId,ownerId,remaining,
    pulseClock:item.periodSeconds??3,nextPulse:item.controlPeriodSeconds??10,grantedBarrier:{}};
  if(item.effect==='grant-barrier'){
    for(const unit of [...state.fieldUnits,...state.enemyUnits]){
      const previous=unit.barrier||0;unit.barrier=Math.max(previous,item.barrier);
      effect.grantedBarrier[unit.id]=Math.max(0,unit.barrier-previous);
    }
  }
  if(item.effect==='burst-and-reset-redeploy'){
    for(const enemy of state.enemyUnits)damageUnit(state,enemy,item.damage,'carry-item');
    for(const key of Object.keys(state.redeployRemaining))state.redeployRemaining[key]=0;
  }
  if(remaining>0)state.activeEffects.push(effect);
  player.itemCooldownRemaining=item.redeploySeconds??60;
  emit(state,'CARRY_ITEM_TRIGGERED',{ownerId,itemId:item.id});
  return {ok:true,itemId:item.id};
}
export function deployCarriedItem(state,ownerId,x,y) {
  const next=clone(state),player=playerOf(next,ownerId),item=itemFor(next);
  if(!player||!item)return {state:next,ok:false,reason:'no-carried-item'};
  if(!['deployment','battle'].includes(next.phase)||next.gameOver)return {state:next,ok:false,reason:'match-not-deployable'};
  if(!Number.isInteger(x)||!Number.isInteger(y)||x<1||x>11||y<1||y>7)return {state:next,ok:false,reason:'invalid-field-cell'};
  if(player.itemCooldownRemaining>0)return {state:next,ok:false,reason:'item-cooldown'};
  if(player.cost<(item.cost??5))return {state:next,ok:false,reason:'insufficient-cost'};
  if(barrierAt(next,x,y)||next.fieldUnits.some(unit=>Math.floor(unit.x)===x&&Math.floor(unit.y)===y)
    ||next.deployedItems.some(unit=>Math.floor(unit.x)===x&&Math.floor(unit.y)===y)){
    return {state:next,ok:false,reason:'occupied-cell'};
  }
  player.cost-=item.cost??5;
  const duration=item.effect==='burst-and-reset-redeploy'?0:(item.durationSeconds??10);
  next.deployedItems.push({id:'item-unit-'+ownerId+'-'+next.elapsed+'-'+next.eventSeq,ownerId,itemId:item.id,name:item.label,
    x:x+.5,y:y+.5,hp:100,maxHp:100,remaining:duration});
  const result=applyItemEffect(next,ownerId);
  if(!result.ok)return {state:clone(state),...result};
  emit(next,'CARRIED_ITEM_DEPLOYED',{ownerId,itemId:item.id,x,y,cost:player.cost});
  return {state:next,ok:true,itemId:item.id};
}
export function deployOperator(state,ownerId,operatorId,x,y) {
  const next=clone(state),player=playerOf(next,ownerId),def=player?.bench.find(item=>item.id===operatorId);
  if(!player||!def)return {state:next,ok:false,reason:'operator-not-in-bench'};
  if(!['deployment','battle'].includes(next.phase)||next.gameOver)return {state:next,ok:false,reason:'match-not-deployable'};
  if(!Number.isInteger(x)||!Number.isInteger(y)||x<1||x>11||y<1||y>7)return {state:next,ok:false,reason:'invalid-field-cell'};
  const id=unitKey(ownerId,operatorId);
  if(next.fieldUnits.some(unit=>unit.id===id))return {state:next,ok:false,reason:'already-deployed'};
  if((next.redeployRemaining[id]||0)>0)return {state:next,ok:false,reason:'redeploy-cooldown'};
  if(player.cost<(def.cost??12))return {state:next,ok:false,reason:'insufficient-cost'};
  const keeper=keeperCell(x,y,ownerId);
  const deployed=next.fieldUnits.filter(unit=>unit.ownerId===ownerId&&unit.role!=='goalkeeper');
  if(!keeper&&deployed.length>=player.deployLimit)return {state:next,ok:false,reason:'deploy-limit'};
  if(barrierAt(next,x,y)||next.fieldUnits.some(unit=>Math.floor(unit.x)===x&&Math.floor(unit.y)===y))return {state:next,ok:false,reason:'occupied-cell'};
  player.cost-=(def.cost??12);player.bench=player.bench.filter(item=>item.id!==operatorId);
  const unit=makeUnit(def,ownerId,0,x+.5,y+.5,keeper?'goalkeeper':'field');
  unit.sp=clamp((def.initialSp??0)+styleFor(next).initialSpBonus,0,unit.maxSp);
  unit.deployedAt=next.elapsed;
  next.fieldUnits.push(unit);next.selectedOperator[ownerId]=unit.id;
  emit(next,'OPERATOR_DEPLOYED',{ownerId,operatorId,x,y,role:unit.role,cost:player.cost});
  return {state:next,ok:true,unitId:unit.id};
}
export function withdrawOperator(state,unitId) {
  const next=clone(state),index=next.fieldUnits.findIndex(unit=>unit.id===unitId);
  if(index<0)return {state:next,ok:false,reason:'unit-not-deployed'};
  const unit=next.fieldUnits[index],player=playerOf(next,unit.ownerId);
  next.fieldUnits.splice(index,1);
  if(player&&!player.bench.some(item=>item.id===unit.operatorId))player.bench.push(clone(unit.definition));
  const delay=unit.redeploySeconds*rulesetFor(next).redeployTimeMultiplier*styleFor(next).redeployMultiplier;
  next.redeployRemaining[unit.id]=delay;
  emit(next,'OPERATOR_WITHDRAWN',{ownerId:unit.ownerId,operatorId:unit.operatorId,redeploy:delay});
  return {state:next,ok:true};
}
export function activateSkill(state,unitId,skillIndex=0) {
  const next=clone(state),unit=next.fieldUnits.find(item=>item.id===unitId);
  if(!unit||!unit.alive)return {state:next,ok:false,reason:'unit-not-active'};
  const skill=unit.skills[skillIndex];
  if(!skill)return {state:next,ok:false,reason:'skill-not-found'};
  const cost=effectiveSkillCost(next,skill);
  if(unit.sp<cost)return {state:next,ok:false,reason:'insufficient-sp'};
  if(unit.skillCooldown>0)return {state:next,ok:false,reason:'skill-cooldown'};
  const effect=skill.effect||{type:'attack-buff',attackMultiplier:1.25,duration:skill.duration??8};
  const force=effect.forceLevel??skill.forceLevel??1;
  if(['push','pull','dash','shift'].includes(effect.type)&&force<(getBallProfile(next.ball.type).weight??1)){
    return {state:next,ok:false,reason:'ball-too-heavy-for-shift'};
  }
  unit.sp-=cost;unit.skillCooldown=skill.cooldownSeconds??skill.duration??10;
  const radius=effect.range??unit.range;
  if(['push','pull','dash','shift'].includes(effect.type)){
    let dx=next.ball.x-unit.x,dy=next.ball.y-unit.y;
    if(effect.type==='pull'){dx=-dx;dy=-dy;}
    const result=applySkillDisplacement(next.ball,unit,force,{x:dx,y:dy});
    if(!result.displaced)return {state:clone(state),ok:false,reason:'ball-too-heavy-for-shift'};
    emit(next,'SKILL_DISPLACED_BALL',{unitId,ballType:next.ball.type,forceLevel:force});
  } else if(effect.type==='damage'||effect.type==='stun'){
    for(const target of next.enemyUnits){
      if(!target.alive||dist(unit,target)>radius)continue;
      if(effect.type==='damage')damageUnit(next,target,effect.damage??unit.atk,'operator-skill',unit);
      else target.stunSeconds=Math.max(target.stunSeconds,(effect.duration??2)*styleFor(next).statusDurationMultiplier);
    }
  } else if(effect.type==='heal'){
    for(const target of next.fieldUnits)if(target.alive&&dist(unit,target)<=radius)target.hp=clamp(target.hp+(effect.amount??unit.atk)*styleFor(next).healingMultiplier,0,target.maxHp);
  } else {
    unit.activeSkill={...clone(effect),remaining:effect.duration??skill.duration??8};
  }
  unit.lastSkill=skill.id??String(skillIndex);emit(next,'SKILL_ACTIVATED',{unitId,skillId:unit.lastSkill,spCost:cost});
  return {state:next,ok:true};
}
export function activateCarriedItem(state,ownerId) {
  const next=clone(state),result=applyItemEffect(next,ownerId);
  return {state:next,...result};
}
export function requestCost(state,ownerId) {
  const next=clone(state),player=playerOf(next,ownerId);
  if(!player)return {state:next,ok:false,reason:'player-not-found'};
  if((player.costRequestCooldown||0)>0)return {state:next,ok:false,reason:'cost-request-cooldown'};
  if(next.pendingCostRequest)return {state:next,ok:false,reason:'cost-request-pending'};
  if(player.cost>=stageFor(next).costCap)return {state:next,ok:false,reason:'cost-at-cap'};
  player.costRequestCooldown=15;
  next.pendingCostRequest={requesterId:ownerId,responderId:ownerId===0?1:0,amount:15,remaining:15};
  emit(next,'COST_REQUESTED',{requesterId:ownerId,responderId:next.pendingCostRequest.responderId,amount:15});
  return {state:next,ok:true};
}
export function respondCostRequest(state,ownerId,accept) {
  const next=clone(state),request=next.pendingCostRequest;
  if(!request)return {state:next,ok:false,reason:'no-cost-request'};
  if(request.responderId!==ownerId)return {state:next,ok:false,reason:'not-cost-request-recipient'};
  const requester=playerOf(next,request.requesterId),donor=playerOf(next,ownerId);
  if(!requester||!donor)return {state:next,ok:false,reason:'player-not-found'};
  let transferred=0;
  if(accept){
    const cap=stageFor(next).costCap;
    transferred=Math.min(request.amount,donor.cost,Math.max(0,cap-requester.cost));
    donor.cost-=transferred;requester.cost+=transferred;
  }
  next.pendingCostRequest=null;
  emit(next,accept?'COST_REQUEST_ACCEPTED':'COST_REQUEST_DECLINED',{requesterId:request.requesterId,responderId:ownerId,amount:transferred});
  return {state:next,ok:true,transferred};
}
export function restartBall(state,ownerId,x,y) {
  const next=clone(state);
  if(!next.ballInBench||next.restart.ownerId!==ownerId||next.restart.remaining<=0)return {state:next,ok:false,reason:'restart-not-available'};
  next.ballInBench=false;next.restart={ownerId:null,remaining:0};
  next.ball.x=clamp(x,1,11);next.ball.y=clamp(y,1,7);next.ball.vx=0;next.ball.vy=0;next.ball.damage=0;
  emit(next,'BALL_RESTARTED',{ownerId,x:next.ball.x,y:next.ball.y});
  return {state:next,ok:true};
}
export function voteReady(state,ownerId,ready=true) {
  const next=clone(state);next.readyVotes[ownerId]=Boolean(ready);
  emit(next,'READY_VOTE',{ownerId,ready:next.readyVotes[ownerId]});
  if(next.readyVotes[0]&&next.readyVotes[1])return startBattle(next);
  return next;
}
export function startBattle(state) {
  const next=clone(state);
  if(next.phase!=='deployment'||next.gameOver)return next;
  next.phase='battle';seedBarriers(next);emit(next,'BATTLE_STARTED',{duration:next.timeRemaining});
  return next;
}
function saveBall(state,ownerId) {
  state.ballInBench=true;state.restart={ownerId,remaining:5};
  state.ball.vx=0;state.ball.vy=0;state.ball.damage=0;
  emit(state,'GOALKEEPER_SAVE',{ownerId,restartSeconds:5});
}
function retreatAllPlayers(state) {
  for(const unit of [...state.fieldUnits]){
    const player=playerOf(state,unit.ownerId);
    if(player&&!player.bench.some(def=>def.id===unit.operatorId))player.bench.push(clone(unit.definition));
    state.redeployRemaining[unit.id]=unit.redeploySeconds*rulesetFor(state).redeployTimeMultiplier*styleFor(state).redeployMultiplier;
    emit(state,'OPERATOR_WITHDRAWN',{ownerId:unit.ownerId,operatorId:unit.operatorId,reason:'goal',redeploy:state.redeployRemaining[unit.id]});
  }
  state.fieldUnits=[];
}
function scoreGoal(state,side) {
  const points=getBallProfile(state.ball.type).scoreMultiplier||1;
  if(side>0)state.score.ally+=points;else state.score.enemy+=points;
  emit(state,'GOAL',{side,points,score:clone(state.score)});
  retreatAllPlayers(state);
  state.ballInBench=false;state.restart={ownerId:null,remaining:0};
  state.ball=createBallState(state.ball.type,FIELD.ballStart.x,FIELD.ballStart.y);
  seedBarriers(state);
  for(const unit of state.enemyUnits){unit.x=unit.role==='goalkeeper'?11:9.4;unit.y=unit.role==='goalkeeper'?4.5:(unit.role==='kicker'?3.2:5.7);unit.stunSeconds=0;unit.attackCooldown=0;unit.alive=true;unit.hp=unit.maxHp;}
}
export function getStampCount(state) {
  const margin=state.score.ally-state.score.enemy;
  return margin>=4?3:margin>=2?2:margin>=1?1:0;
}
function finishMatch(state) {
  state.phase='finished';state.gameOver=true;
  state.stamps=stageFor(state).stampsEnabled?getStampCount(state):0;
  emit(state,'MATCH_FINISHED',{score:clone(state.score),stamps:state.stamps});
}
function applyStylePassives(state,dt) {
  const style=styleFor(state);
  for(const unit of state.fieldUnits){
    if(!unit.alive)continue;
    const progress=clamp((state.elapsed-unit.deployedAt)/(style.growthDurationSeconds??120),0,1);
    const growth=style.id==='anchoring'?1+((style.attackGrowthMax??1)-1)*progress:1;
    unit.currentAttack=unit.atk*growth;
    unit.maxHp=unit.definition.hp*(style.id==='anchoring'?1+((style.hpGrowthMax??1)-1)*progress:1);
    unit.hp=Math.min(unit.hp,unit.maxHp);
    unit.sp=clamp(unit.sp+dt*stageFor(state).spRegenMultiplier,0,unit.maxSp);
    if(style.rangeSpPerSecond>0){
      const supported=state.fieldUnits.some(other=>other.id!==unit.id&&other.alive&&dist(unit,other)<=other.range);
      if(supported)unit.sp=clamp(unit.sp+style.rangeSpPerSecond*dt,0,unit.maxSp);
    }
    unit.attackCooldown=Math.max(0,unit.attackCooldown-dt);
    unit.skillCooldown=Math.max(0,unit.skillCooldown-dt);
    unit.stunSeconds=Math.max(0,unit.stunSeconds-dt);
    unit.ballHitCooldown=Math.max(0,unit.ballHitCooldown-dt);
    if(unit.activeSkill){unit.activeSkill.remaining-=dt;if(unit.activeSkill.remaining<=0)unit.activeSkill=null;}
  }
}
function processEffects(state,dt) {
  for(const effect of state.activeEffects){
    if(effect.effect==='random-sp-supply'){
      effect.pulseClock-=dt;
      if(effect.pulseClock<=0){
        effect.pulseClock=effect.periodSeconds??3;
        const units=[...state.fieldUnits,...state.enemyUnits].filter(unit=>unit.alive);
        if(units.length){const target=units[Math.floor(random(state)*units.length)];target.sp=clamp(target.sp+(effect.spAmount??3),0,target.maxSp);emit(state,'CARRY_ITEM_SP',{unitId:target.id,amount:effect.spAmount??3});}
      }
    } else if(effect.effect==='periodic-control-and-controlled-damage-boost'){
      effect.nextPulse-=dt;
      if(effect.nextPulse<=0){
        effect.nextPulse=effect.controlPeriodSeconds??10;
        for(const enemy of state.enemyUnits)if(enemy.alive&&state.fieldUnits.some(unit=>unit.alive&&dist(unit,enemy)<=unit.range))enemy.stunSeconds=Math.max(enemy.stunSeconds,(effect.controlDurationSeconds??5)*styleFor(state).statusDurationMultiplier);
        emit(state,'CARRY_ITEM_CONTROL_PULSE',{ownerId:effect.ownerId});
      }
    }
    effect.remaining-=dt;
    if(effect.remaining<=0&&effect.effect==='grant-barrier'&&effect.grantedBarrier){
      for(const [unitId,amount] of Object.entries(effect.grantedBarrier)){
        const unit=unitOf(state,unitId);if(unit)unit.barrier=Math.max(0,(unit.barrier||0)-amount);
      }
    }
  }
  state.activeEffects=state.activeEffects.filter(effect=>effect.remaining>0);
  for(const player of state.players)player.itemCooldownRemaining=Math.max(0,player.itemCooldownRemaining-dt);
  for(const item of state.deployedItems)item.remaining=Math.max(0,item.remaining-dt);
  state.deployedItems=state.deployedItems.filter(item=>item.remaining>0);
}
function ballPushFromUnit(state,unit,damage) {
  const sideStyleMultiplier=unit.team===0?styleFor(state).attackMultiplier:1;
  const boosted=damage*(unit.activeSkill?.attackMultiplier??1)*sideStyleMultiplier*
    (state.activeEffects.some(effect=>effect.effect==='temporary-attack-boost'&&effect.remaining>0)?1.2:1);
  const hit=applyOperatorHit(state.ball,{id:unit.id,x:unit.x,y:unit.y,cellX:Math.floor(unit.x),cellY:Math.floor(unit.y),attackDamage:boosted});
  if(hit.pushed)emit(state,'BALL_PUSHED',{unitId:unit.id,ballType:state.ball.type,threshold:hit.threshold,direction:hit.direction});
  if(hit.explode){
    const profile=getBallProfile(state.ball.type);
    for(const target of [...state.fieldUnits,...state.enemyUnits]){
      if(target.alive&&dist(target,state.ball)<=profile.explosionRadius){
        damageUnit(state,target,profile.explosionDamage,'explosive-ball',unit);
        target.stunSeconds=Math.max(target.stunSeconds,profile.explosionStun*styleFor(state).statusDurationMultiplier);
      }
    }
    emit(state,'BALL_EXPLODED',{ballType:profile.id});
    state.ball=createBallState(state.ball.type,state.ball.x,state.ball.y);
  }
}
/**
 * 把一个单位朝目标点推进一帧，并把位置夹在球场内区。
 * 与 `enemyCombatTick` 的追击算术同构（每帧按归一化方向走 moveSpeed*dt），
 * 区别是敌方未做边界夹取——那会让 kicker 被球带出球门线外；己方一律夹回内区。
 * 纯算术，不消费随机数，因此不影响 LCG 确定性。
 */
function moveUnitToward(unit,tx,ty,dt) {
  const dx=tx-unit.x,dy=ty-unit.y,d=Math.hypot(dx,dy);
  if(!d)return;
  unit.x=clamp(unit.x+dx/d*unit.moveSpeed*dt,FIELD.minX,FIELD.maxX);
  unit.y=clamp(unit.y+dy/d*unit.moveSpeed*dt,FIELD.minY,FIELD.maxY);
}
function alliedCombatTick(state,unit,dt) {
  if(!unit.alive||unit.stunSeconds>0)return;
  const style=styleFor(state),itemSpeedBonus=state.activeEffects.some(effect=>effect.effect==='temporary-attack-speed-zero-resist'&&effect.remaining>0)?(itemFor(state)?.attackSpeedBonus??80):0,unitSpeedBonus=style.attackSpeedBonus+itemSpeedBonus;
  const ball=state.ball;
  // 守门员驻守球门列，不参与追球（否则挡球判定与 5 秒重开节奏都会漂移）。
  // 非守门员在球不在攻击范围内时朝球推进，进入范围后由下面的攻击分支接管。
  if(unit.role!=='goalkeeper'&&dist(unit,ball)>unit.range){
    moveUnitToward(unit,ball.x,ball.y,dt);
  }
  const target=state.enemyUnits.filter(enemy=>enemy.alive&&dist(unit,enemy)<=unit.range).sort((a,b)=>dist(unit,a)-dist(unit,b))[0];
  if(dist(unit,ball)<=unit.range&&unit.attackCooldown<=0){
    ballPushFromUnit(state,unit,unit.currentAttack??unit.atk);
    unit.attackCooldown=Math.max(.1,unit.attackInterval*100/(100+unitSpeedBonus));
  } else if(target&&unit.attackCooldown<=0){
    const carryBoost=state.activeEffects.some(effect=>effect.effect==='temporary-attack-boost'&&effect.remaining>0)?1.2:1;
    const damage=(unit.currentAttack??unit.atk)*style.attackMultiplier*carryBoost;
    damageUnit(state,target,damage,'operator-attack',unit);
    if(style.spRefundChance>0&&random(state)<style.spRefundChance)unit.sp=clamp(unit.sp+(style.spRefundAmount??1),0,unit.maxSp);
    unit.attackCooldown=Math.max(.1,unit.attackInterval*100/(100+unitSpeedBonus));
  }
}
function enemyCombatTick(state,unit,dt) {
  if(!unit.alive||unit.stunSeconds>0)return;
  const team=OPPONENT_TEAMS[state.opponentTeamId]||OPPONENT_TEAMS.standard;
  unit.attackCooldown=Math.max(0,unit.attackCooldown-dt);
  if(unit.role==='goalkeeper'){
    if(team.id==='fairPlay'&&unit.hp<unit.maxHp/2)return;
    const towardGoal=state.ball.x<unit.x&&state.ball.vx>0;
    if(towardGoal&&dist(unit,state.ball)<2&&unit.attackCooldown<=0){
      const clearY=team.tactic==='fast-shot-at-open-goal'?(state.ball.y<4.5?6.4:2.6):4.5;
      state.ball.vx=-Math.abs(state.ball.vx)-team.shootPower;
      state.ball.vy=(clearY-state.ball.y)*.4;
      unit.attackCooldown=1;
      emit(state,'ENEMY_KEEPER_CLEAR',{team:team.id});
    }
    return;
  }
  if(unit.role==='hitman'){
    const allies=state.fieldUnits.filter(candidate=>candidate.alive);
    let target;
    if(team.id==='loveBall'){
      target=allies.sort((a,b)=>dist(a,state.ball)-dist(b,state.ball))[0];
    }else if(team.id==='tactical'){
      target=allies.sort((a,b)=>dist(a,state.ball)-dist(b,state.ball))[0];
    }else{
      target=allies.sort((a,b)=>dist(unit,a)-dist(unit,b))[0];
    }
    if(target){
      if(dist(unit,target)>unit.range){
        const d=dist(unit,target)||1;unit.x+=(target.x-unit.x)/d*unit.moveSpeed*dt;unit.y+=(target.y-unit.y)/d*unit.moveSpeed*dt;
      }else if(unit.attackCooldown<=0){
        damageUnit(state,target,unit.atk,'enemy-hitman',unit);unit.attackCooldown=unit.attackInterval;
      }
    }
    return;
  }
  if(team.id==='loveBall'&&unit.role==='kicker'){
    if(!unit.hasBall&&dist(unit,state.ball)<=.65){
      unit.hasBall=true;state.ballInPossession=unit.id;
      emit(state,'ENEMY_BALL_POSSESSION',{team:team.id,unitId:unit.id});
    }
    if(unit.hasBall){
      unit.x=Math.max(2.2,unit.x-unit.moveSpeed*1.2*dt);
      unit.y+=(4.5-unit.y)*Math.min(1,dt*.8);
      state.ball.x=unit.x-.42;state.ball.y=unit.y;state.ball.vx=0;state.ball.vy=0;
      const receiver=state.enemyUnits.find(candidate=>candidate.role==='striker');
      const shouldPass=receiver&&unit.x<8.6;
      const shouldShoot=unit.x<3.2;
      if((shouldPass||shouldShoot)&&unit.attackCooldown<=0){
        const target=shouldPass?receiver:{x:.8,y:4.5};
        const tx=typeof target.x==='number'?target.x:target.x;
        const ty=typeof target.y==='number'?target.y:target.y;
        const dx=tx-state.ball.x,dy=ty-state.ball.y,d=Math.hypot(dx,dy)||1;
        const hitter={id:unit.id,x:state.ball.x-dx/d*.5,y:state.ball.y-dy/d*.5,cellX:-99,cellY:-99};
        const before=state.ball.kickCount;
        const hit=applyOperatorHit(state.ball,{...hitter,attackDamage:unit.atk*team.shootPower});
        unit.attackCooldown=team.shootInterval;
        if(hit.pushed){
          unit.hasBall=false;state.ballInPossession=null;
          emit(state,shouldPass?'ENEMY_PASS':'ENEMY_SHOT',{team:team.id,target:shouldPass?'striker':'goal'});
        }
      }
      return;
    }
  }
  if(dist(unit,state.ball)>1.1){
    const dx=state.ball.x-unit.x,dy=state.ball.y-unit.y,d=Math.hypot(dx,dy)||1;
    unit.x+=dx/d*unit.moveSpeed*dt;unit.y+=dy/d*unit.moveSpeed*dt;
  }else if(unit.attackCooldown<=0){
    const keeperY=4.5;
    const goalY=team.tactic==='fast-shot-at-open-goal'?(state.ball.y<4.5?6.15:2.85):team.tactic==='high-power-shot-and-pressure'?(state.ball.y<4.5?5.8:3.2):keeperY;
    const goal={x:.8,y:goalY},dx=goal.x-state.ball.x,dy=goal.y-state.ball.y,d=Math.hypot(dx,dy)||1;
    const beforeKick=state.ball.kickCount;
    ballPushFromUnit(state,unit,unit.atk*team.shootPower);
    if(state.ball.kickCount>beforeKick)emit(state,'ENEMY_SHOT',{team:team.id,tactic:team.tactic,aimY:goalY});
    unit.attackCooldown=team.shootInterval;
  }
}
function ballAndFieldTick(state,dt) {
  if(state.ballInBench){
    state.restart.remaining=Math.max(0,state.restart.remaining-dt);
    if(state.restart.remaining<=0){
      const owner=state.restart.ownerId;state.ballInBench=false;state.restart={ownerId:null,remaining:0};
      state.ball.x=owner==='ai'?11.5:1.5;state.ball.y=4.5;state.ball.vx=0;state.ball.vy=0;
      emit(state,'BALL_AUTO_RESTART',{ownerId:owner});
    }
    return;
  }
  const r=getBallProfile(state.ball.type),key=Math.floor(state.ball.y)+':'+Math.floor(state.ball.x);
  const friction=state.iceCells?.[key]?0.4:state.slimeCells?.[key]?1.8:1;
  advanceBallMotion(state.ball,dt,friction);
  if(r.trail==='ice')state.iceCells[key]=true;
  if(r.trail==='slime')state.slimeCells[key]=true;
  const ballRadius=.26*(state.ball.sizeScale||1);
  if(state.ball.y<1+ballRadius){state.ball.y=1+ballRadius;state.ball.vy=Math.abs(state.ball.vy)*r.restitution;}
  if(state.ball.y>8-ballRadius){state.ball.y=8-ballRadius;state.ball.vy=-Math.abs(state.ball.vy)*r.restitution;}
  for(const barrier of [...state.barriers]){
    if(Math.abs(barrier.x-state.ball.x)<.43+ballRadius&&Math.abs(barrier.y-state.ball.y)<.43+ballRadius){
      barrier.hp-=r.attack;state.ball.vx=-state.ball.vx*r.restitution;state.ball.vy=-state.ball.vy*r.restitution;
      if(barrier.hp<=0){state.barriers=state.barriers.filter(item=>item.id!==barrier.id);emit(state,'BARRIER_DESTROYED',{barrierId:barrier.id});}
    }
  }
  for(const unit of [...state.fieldUnits,...state.enemyUnits]){
    if(!unit.alive)continue;
    const abandonKeeper=unit.team===1&&unit.role==='goalkeeper'&&state.opponentTeamId==='fairPlay'&&unit.hp<unit.maxHp/2;
    if(unit.role==='goalkeeper'&&!abandonKeeper&&dist(unit,state.ball)<.6&&((unit.team===0&&state.ball.vx<0)||(unit.team===1&&state.ball.vx>0))){saveBall(state,unit.ownerId);return;}
    if(dist(unit,state.ball)<ballRadius+.2){
      if(!abandonKeeper&&canBlockBall(unit,state.ball)){unit.occupiedBlockCount=0;saveBall(state,unit.ownerId);return;}
      if(Math.hypot(state.ball.vx,state.ball.vy)>.35&&unit.ballHitCooldown<=0){
        damageUnit(state,unit,r.attack,'football-impact',null);unit.ballHitCooldown=.7;
      }
    }
  }
  if(state.ball.x<=FIELD.leftGoalX&&state.ball.y>=FIELD.goalYMin&&state.ball.y<=FIELD.goalYMax)scoreGoal(state,-1);
  else if(state.ball.x>=FIELD.rightGoalX&&state.ball.y>=FIELD.goalYMin&&state.ball.y<=FIELD.goalYMax)scoreGoal(state,1);
}
function tickCostsAndRedeploy(state,dt) {
  const stage=stageFor(state);
  state.costClock+=dt;
  while(state.costClock>=stage.costIncreaseSeconds){
    state.costClock-=stage.costIncreaseSeconds;
    for(const player of state.players)player.cost=clamp(player.cost+1,0,stage.costCap);
  }
  for(const [key,value] of Object.entries(state.redeployRemaining))state.redeployRemaining[key]=Math.max(0,value-dt);
  for(const player of state.players)player.costRequestCooldown=Math.max(0,(player.costRequestCooldown||0)-dt);
  if(state.pendingCostRequest){
    state.pendingCostRequest.remaining=Math.max(0,state.pendingCostRequest.remaining-dt);
    if(state.pendingCostRequest.remaining===0){
      emit(state,'COST_REQUEST_EXPIRED',{requesterId:state.pendingCostRequest.requesterId});
      state.pendingCostRequest=null;
    }
  }
}
export function tickMatch(state,deltaSeconds) {
  const next=clone(state);
  if(next.phase!=='battle'||next.gameOver||next.paused)return next;
  const dt=clamp(deltaSeconds*(next.speed||1),0,.1);
  next.elapsed+=dt;next.timeRemaining=Math.max(0,next.timeRemaining-dt);
  tickCostsAndRedeploy(next,dt);
  applyStylePassives(next,dt);
  for(const unit of next.fieldUnits)alliedCombatTick(next,unit,dt);
  for(const unit of next.enemyUnits)enemyCombatTick(next,unit,dt);
  ballAndFieldTick(next,dt);processEffects(next,dt);
  if(next.timeRemaining<=0)finishMatch(next);
  return next;
}
export function withdrawAllAfterShot(state) {
  const next=clone(state);retreatAllPlayers(next);return next;
}
export function chooseOpponentTeam(state,teamId) {
  if(!OPPONENT_TEAMS[teamId])return state;
  const next=clone(state);next.opponentTeamId=teamId;spawnEnemies(next);return next;
}
export function votePause(state,ownerId,paused=true) {
  const next=clone(state);next.pauseVotes[ownerId]=paused;
  next.paused=next.pauseVotes[0]&&next.pauseVotes[1];
  emit(next,'PAUSE_VOTE',{ownerId,paused,active:next.paused});return next;
}
export function voteSpeed(state,ownerId,fast=true) {
  const next=clone(state);next.speedVotes[ownerId]=fast;
  next.speed=next.speedVotes[0]&&next.speedVotes[1]?2:1;
  emit(next,'SPEED_VOTE',{ownerId,fast,speed:next.speed});return next;
}
export function applyCarriedItem(state,ownerId) {
  const next=clone(state),result=applyItemEffect(next,ownerId);
  return {...result,state:next};
}
export function computeMatchSummary(state) {
  return {stage:stageFor(state).label,score:clone(state.score),goalMargin:state.score.ally-state.score.enemy,
    stamps:stageFor(state).stampsEnabled?getStampCount(state):0,opponentTeam:OPPONENT_TEAMS[state.opponentTeamId].label,
    duration:stageFor(state).durationSeconds-state.timeRemaining};
}


