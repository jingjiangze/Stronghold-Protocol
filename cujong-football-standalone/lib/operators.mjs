// Data-only roster for the standalone football runtime.
// Gameplay values are an openly documented prototype balance profile, not official operator stats.
export const OPERATOR_CATALOG = Object.freeze({
  vanguard: Object.freeze({
    id: 'vanguard', name: '先锋', archetype: 'vanguard', icon: 'vanguard',
    deployCost: 10, redeploySeconds: 35, hp: 1200, attack: 190, defense: 70,
    attackInterval: 1.05, range: 1.2, block: 2, slotCost: 1, keeper: false,
    skill: Object.freeze({ id: 'dash-kick', name: '突进带球', spCost: 15, initialSp: 5, initialSpLegacy: 7, spRegen: 1, type: 'displace-ball', range: 2.4, force: 1.0, maxBallWeight: 1, cooldown: 6 }),
  }),
  guard: Object.freeze({
    id: 'guard', name: '近卫', archetype: 'guard', icon: 'guard',
    deployCost: 13, redeploySeconds: 45, hp: 1650, attack: 310, defense: 110,
    attackInterval: 1.25, range: 1.25, block: 2, slotCost: 1, keeper: false,
    skill: Object.freeze({ id: 'cleave', name: '强击', spCost: 18, initialSp: 6, initialSpLegacy: 8, spRegen: 1, type: 'burst', multiplier: 2.8, range: 1.6, duration: 0, cooldown: 8 }),
  }),
  sniper: Object.freeze({
    id: 'sniper', name: '狙击', archetype: 'sniper', icon: 'sniper',
    deployCost: 14, redeploySeconds: 45, hp: 920, attack: 255, defense: 45,
    attackInterval: 1.0, range: 3.4, block: 1, slotCost: 1, keeper: false,
    skill: Object.freeze({ id: 'line-shot', name: '直线射击', spCost: 20, initialSp: 8, initialSpLegacy: 10, spRegen: 1, type: 'burst', multiplier: 2.4, range: 5, duration: 0, cooldown: 10 }),
  }),
  defender: Object.freeze({
    id: 'defender', name: '重装', archetype: 'defender', icon: 'defender',
    deployCost: 18, redeploySeconds: 60, hp: 2600, attack: 155, defense: 220,
    attackInterval: 1.45, range: 1.15, block: 3, slotCost: 1, keeper: false,
    skill: Object.freeze({ id: 'brace', name: '固守', spCost: 18, initialSp: 8, initialSpLegacy: 10, spRegen: 1, type: 'guard', defenseMultiplier: 2, duration: 8, cooldown: 12 }),
  }),
  medic: Object.freeze({
    id: 'medic', name: '医疗', archetype: 'medic', icon: 'medic',
    deployCost: 16, redeploySeconds: 60, hp: 1020, attack: 90, defense: 40,
    attackInterval: 1.35, range: 3.2, block: 1, slotCost: 1, keeper: false,
    skill: Object.freeze({ id: 'field-medic', name: '紧急救治', spCost: 22, initialSp: 10, initialSpLegacy: 12, spRegen: 1, type: 'heal', amount: 650, range: 3.5, duration: 0, cooldown: 12 }),
  }),
  pusher: Object.freeze({
    id: 'pusher', name: '推击特种', archetype: 'pusher', icon: 'pusher',
    deployCost: 13, redeploySeconds: 45, hp: 1350, attack: 175, defense: 90,
    attackInterval: 1.1, range: 1.4, block: 2, slotCost: 1, keeper: false,
    skill: Object.freeze({ id: 'heavy-push', name: '强制位移', spCost: 16, initialSp: 6, initialSpLegacy: 8, spRegen: 1, type: 'displace-ball', range: 2.1, force: 1.25, maxBallWeight: 2, cooldown: 8 }),
  }),
  caster: Object.freeze({
    id: 'caster', name: '术师', archetype: 'caster', icon: 'caster',
    deployCost: 17, redeploySeconds: 60, hp: 880, attack: 350, defense: 35,
    attackInterval: 1.55, range: 3.1, block: 1, slotCost: 1, keeper: false,
    skill: Object.freeze({ id: 'arc-burst', name: '源能冲击', spCost: 24, initialSp: 10, initialSpLegacy: 12, spRegen: 1, type: 'burst', multiplier: 2.1, range: 3.4, duration: 0, cooldown: 12 }),
  }),
  supporter: Object.freeze({
    id: 'supporter', name: '辅助', archetype: 'supporter', icon: 'supporter',
    deployCost: 15, redeploySeconds: 55, hp: 1050, attack: 155, defense: 50,
    attackInterval: 1.2, range: 3, block: 1, slotCost: 1, keeper: false,
    skill: Object.freeze({ id: 'tempo-field', name: '节奏场', spCost: 20, initialSp: 8, initialSpLegacy: 10, spRegen: 1, type: 'team-sp', amount: 4, range: 3, duration: 0, cooldown: 14 }),
  }),
  specialist: Object.freeze({
    id: 'specialist', name: '快速复位', archetype: 'specialist', icon: 'specialist',
    deployCost: 12, redeploySeconds: 25, hp: 1180, attack: 210, defense: 80,
    attackInterval: 1.0, range: 1.2, block: 1, slotCost: 1, keeper: false,
    skill: Object.freeze({ id: 'quick-redeploy', name: '快速再部署', spCost: 15, initialSp: 5, initialSpLegacy: 7, spRegen: 1, type: 'reduce-redeploy', amount: 12, range: 0, duration: 0, cooldown: 16 }),
  }),
  keeper: Object.freeze({
    id: 'keeper', name: '守门员', archetype: 'defender', icon: 'keeper',
    deployCost: 16, redeploySeconds: 50, hp: 2300, attack: 120, defense: 210,
    attackInterval: 1.5, range: 1.1, block: 3, slotCost: 0, keeper: true,
    skill: Object.freeze({ id: 'keeper-clear', name: '门前解围', spCost: 14, initialSp: 5, initialSpLegacy: 7, spRegen: 1, type: 'displace-ball', range: 2.2, force: 1.15, maxBallWeight: 2, cooldown: 8 }),
  }),
  duelist: Object.freeze({
    id: 'duelist', name: '决斗者', archetype: 'duelist', icon: 'duelist',
    deployCost: 15, redeploySeconds: 50, hp: 1450, attack: 390, defense: 90,
    attackInterval: 1.45, range: 1.25, block: 1, slotCost: 1, keeper: false,
    skill: Object.freeze({ id: 'finisher', name: '终结击', spCost: 20, initialSp: 8, initialSpLegacy: 10, spRegen: 1, type: 'burst', multiplier: 3.2, range: 1.4, duration: 0, cooldown: 14 }),
  }),
  frost: Object.freeze({
    id: 'frost', name: '寒控者', archetype: 'control', icon: 'frost',
    deployCost: 15, redeploySeconds: 55, hp: 980, attack: 185, defense: 45,
    attackInterval: 1.25, range: 3.2, block: 1, slotCost: 1, keeper: false,
    skill: Object.freeze({ id: 'cold-control', name: '冻结脉冲', spCost: 22, initialSp: 8, initialSpLegacy: 10, spRegen: 1, type: 'stun', duration: 3.5, range: 3.2, cooldown: 12 }),
  }),
  demolition: Object.freeze({
    id: 'demolition', name: '拆障手', archetype: 'specialist', icon: 'demolition',
    deployCost: 14, redeploySeconds: 50, hp: 1300, attack: 260, defense: 85,
    attackInterval: 1.15, range: 1.3, block: 2, slotCost: 1, keeper: false,
    skill: Object.freeze({ id: 'barrier-break', name: '破障冲击', spCost: 18, initialSp: 7, initialSpLegacy: 9, spRegen: 1, type: 'barrier-damage', amount: 16000, range: 2.5, duration: 0, cooldown: 10 }),
  }),
});

export const DEFAULT_LINEUP = Object.freeze([
  'vanguard', 'guard', 'sniper', 'defender', 'medic', 'pusher', 'caster', 'supporter', 'specialist', 'keeper',
]);

export function getOperator(id) {
  return OPERATOR_CATALOG[id] || null;
}
