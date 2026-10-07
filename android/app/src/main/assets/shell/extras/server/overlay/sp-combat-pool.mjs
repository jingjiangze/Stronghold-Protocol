// sp-combat-pool.mjs — shell overlay: run the SERVER-RUN combat phases (normal / 联防 / 领袖) on a fixed
// worker-thread pool instead of the main thread, so a long streamed battle cannot stall the event loop that
// also broadcasts `b.ev` to everyone (the pool lives in ../combat/, shipped beside this loader).
//
// WHY AN OVERLAY: upstream `server/**` stays byte-identical to sganggs/Stronghold-Protocol, so every upstream
// sync is a plain `git merge` with zero conflicts. The pool is added as NEW files (server/combat/**) plus this
// loading point (server/overlay/**); both ship with the shell extras and are materialised into the webroot.
// The methods that must pick a different runner are wrapped HERE, at runtime, on Match.prototype.
//
// OPT-IN: nothing happens unless SP_COMBAT_WORKERS is a positive integer. Unset → the upstream inline runner
// is used untouched (and client-side combat, the default, never uses the pool at all).
//
// DRIFT GUARD: the wrapped methods are copies of upstream bodies. SHAPE pins the upstream lines they depend
// on, so an upstream change to those methods fails loudly (overlay skipped + logged) instead of silently
// running a stale copy. Re-sync the copy when upstream moves; never edit upstream files directly.

export const overlayApi = 1;
export const id = 'sp-combat-pool';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE, GEO } from '../../shared/constants.js';
import { msg } from '../../shared/i18n.js';
import { deriveSeed } from '../sim/rng.js';
import { buildBattleSpec, uniteLeft } from '../sim/spec.js';
import { FieldRunner, timelineAt, uniteBillBounds } from '../match/fields.js';
import { uniteSurvivors } from '../match/unite.js';
import { buildBossWave, bountySpawns } from '../match/waves.js';
import { pairPlayers, bossPoolHp, SharedBossPool, BOSS_HIT_STEPS } from '../match/finalAssault.js';
import { FLOW_TICKER_PRIORITY, DELAYS } from '../match/match/common.js';
import { Match } from '../match/Match.js';
import { CombatWorkerPool } from '../combat/pool.mjs';
import { WorkerFieldRunner, RemoteBattle } from '../combat/runner.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM = path.resolve(DIR, '..'); // the running server/ directory

/** The exact upstream fragments each wrapped method relies on. Missing text = upstream moved: refuse to patch. */
const SHAPE = {
  'match/match/combat.js': [
    'this.fields = alive.map((ps) => ({ fieldId: `n:${ps.playerId}`',
    'this.runner = new FieldRunner(this, this.fields, { onDone: (runner) => this.combatDone(runner) });',
  ],
  'match/match/unitePhase.js': [
    'const battle = this.newBattle(this._uniteOpts(plan, limit));',
    'try { live = uniteLeft(f.battle); } catch { live = null; }',
    'if (!f || !f.battle || runner.ticks % 30 !== 0) return;',
  ],
  'match/match/bossRounds.js': [
    'if (this.clientCombat) { this._startFinalClient(hidden); return; }',
    'this.runner = new FieldRunner(this, this.fields, {',
    'this._applyOvertime(runner.time);',
  ],
};

function assertUpstreamShape(log) {
  const stale = [];
  for (const [rel, needles] of Object.entries(SHAPE)) {
    let text = '';
    try { text = fs.readFileSync(path.join(UPSTREAM, rel), 'utf8'); } catch { stale.push(`${rel} (unreadable)`); continue; }
    for (const needle of needles) if (!text.includes(needle)) stale.push(`${rel}: missing ${JSON.stringify(needle.slice(0, 44))}…`);
  }
  if (stale.length) throw new Error(`upstream combat methods moved, overlay copy is stale: ${stale.join('; ')}`);
  log(`[combat-pool] upstream shape ok (${Object.keys(SHAPE).length} files)`);
}

function parseWorkers(value) {
  if (value == null || value === '') return 0;
  const s = String(value).trim();
  if (!/^(0|[1-9]\d*)$/.test(s) || Number(s) > 32) throw new RangeError('SP_COMBAT_WORKERS must be an integer from 0 to 32');
  return Number(s);
}

let POOL = null;
/** The wrapped methods read the pool from here: no Match option, no constructor change, no lobby plumbing. */
const poolOf = () => POOL;

function patchMatch(log) {
  const proto = Match.prototype;

  proto._remoteField = function _remoteField(opts, players) {
    const spec = buildBattleSpec({ ...opts, content: this.battleContent,
      boss: this.bossPool ? { poolHp: this.bossPool.hp, poolMax: this.bossPool.maxHp } : null });
    return { remote: true, fieldId: spec.fieldId, kind: spec.kind, players, spec, battle: new RemoteBattle(spec), live: true };
  };

  proto.sendEncoded = function sendEncoded(playerId, type, data) {
    if (this.disposed || !['m.field', 'b.snap', 'b.ev', 'b.damage', 'm.damage'].includes(type) || typeof data !== 'string') return false;
    const ps = this.players.get(playerId) || this.spectators.get(playerId);
    if (!ps || ps.isBot || ps.left) return false;
    try {
      if (typeof this.opts.sendEncoded === 'function') return !!this.opts.sendEncoded(playerId, type, data);
      return this.sendTo(playerId, JSON.parse(data)); // capture-only fixtures / embedding without an encoded transport
    } catch (e) { this.reportError('send encoded', e); return false; }
  };

  // ---- upstream match/match/combat.js startCombat() — only the field construction and the runner differ ----
  proto.startCombat = function startCombat() {
    if (this.clientCombat) { this._startCombatClient(); return; }
    if (poolOf()) this.combatPool = poolOf(); // the runner reads its pool off the match
    this.phase = PHASE.COMBAT;
    const alive = this.alivePlayers();
    this.lastResults = new Map();
    this.fields = alive.map((ps) => poolOf() ? this._remoteField(this._normalOpts(ps), [ps.playerId])
      : { fieldId: `n:${ps.playerId}`, kind: 'normal', players: [ps.playerId], battle: this._normalBattle(ps), live: true });
    const limit = this.wave ? this.wave.timeLimit : 60;
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    const Runner = poolOf() ? WorkerFieldRunner : FieldRunner;
    this.runner = new Runner(this, this.fields, { onDone: (runner) => this.combatDone(runner) });
    this._defaultWatch();
    this.markPublic();
    this.runner.start();
  };

  // ---- upstream match/match/unitePhase.js startUnite() ----
  proto.startUnite = function startUnite(plan) {
    if (this.clientCombat) { this._startUniteClient(plan); return; }
    if (poolOf()) this.combatPool = poolOf();
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.wave ? this.wave.timeLimit : 60;
    const opts = this._uniteOpts(plan, limit);
    const players = plan.helpers.map((p) => p.playerId);
    this.fields = [poolOf() ? this._remoteField(opts, players)
      : { fieldId: 'u', kind: 'unite', players, battle: this.newBattle(opts), live: true }];
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._defaultWatch();
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: plan.helpers.map((p) => p.name) }), FLOW_TICKER_PRIORITY);
    this._uniteLeftKey = null;
    const Runner = poolOf() ? WorkerFieldRunner : FieldRunner;
    this.runner = new Runner(this, this.fields, {
      onTick: (runner) => this._uniteTick(runner),
      onDone: (runner) => {
        if (this.phase !== PHASE.UNITE) return;
        const res = runner.resultOf(this.fields[0]);
        this._collectSimErrors(this.fields[0], res);
        this.fields[0].live = false;
        this.deadline = 0;
        this.markPublic();
        this.later(this.scaled(DELAYS.COMBAT_END), () => this.settle(plan, res));
      },
    });
    this._defaultWatch();
    this.markPublic();
    this.runner.start();
  };

  // ---- upstream match/match/unitePhase.js _uniteLeft() — only the live-sample branch differs ----
  proto._uniteLeft = function _uniteLeft(ps) {
    const plan = this.unitePlan;
    if (this.phase !== PHASE.UNITE || !plan || !ps || !plan.leakers.includes(ps)) return null;
    const pid = ps.playerId;
    const f = this.fields.find((x) => x && x.kind === 'unite') || null;
    let res = null;
    if (f && f.cc) res = f.done ? f.result : null;
    else if (f && f.battle && f.battle.finished) { try { res = f.battle.result(); } catch { res = null; } }
    if (res && res.synthetic) {
      const own = this.lastResults.get(pid);
      return own && Array.isArray(own.leaked) ? own.leaked.filter((l) => l && l.counted !== false).length : 0;
    }
    if (res) return uniteSurvivors(plan, res).get(pid) || 0;
    const sent = plan.leaked.filter((l) => l.sourcePlayerId === pid).length;
    let live = null;
    if (f && f.cc) {
      if (f.mode === 'server' && f.timeline) {
        const sample = timelineAt(f.timeline, this._fieldElapsed(f));
        live = sample && sample[3] && typeof sample[3] === 'object' ? sample[3] : null;
      } else live = f.progress && f.progress.left && typeof f.progress.left === 'object' ? f.progress.left : null;
    } else if (f?.remote) live = f.battle.left;
    else if (f && f.battle) {
      try { live = uniteLeft(f.battle); } catch { live = null; }
    }
    if (!this._uniteBounds || this._uniteBounds.plan !== plan) this._uniteBounds = { plan, bounds: uniteBillBounds(plan.leaked, this.gd) };
    const bound = this._uniteBounds.bounds.get(pid) ?? sent;
    const standing = live ? Math.min(bound, Math.max(0, Math.trunc(Number(live[pid]) || 0))) : sent;
    return standing + (plan.notReentered.get(pid) || 0);
  };

  // ---- upstream match/match/unitePhase.js _uniteTick() ----
  proto._uniteTick = function _uniteTick(runner) {
    const f = runner && runner.fields ? runner.fields[0] : null;
    if (!f || !f.battle || (runner.remote ? !runner.secondTick : runner.ticks % 30 !== 0)) return;
    let key = '';
    try { key = JSON.stringify(f.remote ? f.battle.left : uniteLeft(f.battle)); } catch { key = ''; }
    if (key === this._uniteLeftKey) return;
    this._uniteLeftKey = key;
    this.markPublic();
  };

  // ---- upstream match/match/bossRounds.js startFinalAssault() ----
  proto.startFinalAssault = function startFinalAssault(hidden) {
    if (poolOf()) this.combatPool = poolOf();
    const alive = this.alivePlayers();
    if (!alive.length) { this.finish({ victory: false, reason: 'eliminated' }); return; }
    this.phase = hidden ? PHASE.HIDDEN_CORE : PHASE.FINAL_ASSAULT;
    this.lastResults = new Map();
    if (!hidden) {
      this.teamLp = alive.reduce((s, p) => s + Math.max(0, p.lp), 0);
      for (const ps of alive) ps.lpAtFinal = Math.max(0, ps.lp);
    }
    const bossId = hidden ? this.hiddenBossId : this.bossId;
    const hitSteps = new Map();
    const pool = new SharedBossPool(bossPoolHp(this.gd, bossId, alive.length), {
      onHit: (pid, dmg) => {
        const ps = this.players.get(pid);
        if (!ps) return;
        ps.stats.bossDamage += dmg;
        const share = (pool.byPlayer.get(pid) || 0) / pool.maxHp;
        const done = hitSteps.get(pid) || 0;
        let reached = done;
        BOSS_HIT_STEPS.forEach((s, i) => { if (share >= s) reached = Math.max(reached, i + 1); });
        if (reached > done) {
          hitSteps.set(pid, reached);
          this.tickerFor('BOSS_HIT', [ps.name], { playerId: pid, param: String(BOSS_HIT_STEPS[reached - 1]) });
        }
      },
    });
    this.bossPool = pool;
    const groups = pairPlayers(alive);
    const reuse = this.bossWaves && this.bossWaves.length === groups.length && this.bossWaves.every((w, i) => w.players.join() === groups[i].map((p) => p.playerId).join());
    this.fields = groups.map((g, i) => {
      const solo = this.isSolo || g.length === 1;
      const wave = reuse ? this.bossWaves[i].wave : buildBossWave(this.gd, this.rngWaves, this.factions, this.round, { bossId, solo });
      const spawns = wave.spawns.map((s) => ({ ...s, mods: s.mods ? { ...s.mods } : undefined }));
      g.forEach((ps, j) => {
        for (const b of bountySpawns(this.gd, this.round, wave, ps.bounties, ps.playerId, { solo: this.isSolo, side: j === 0 ? 'L' : 'R' })) spawns.push(b);
      });
      const inputs = g.map((ps, j) => {
        const input = ps.battleInput({ side: j === 0 ? 'L' : 'R', colOffset: j === 0 ? 0 : 8 });
        input.lpForBoss = this.teamLp;
        const ev = { input, kind: hidden ? 'hidden' : 'boss', round: this.round, spawns, routes: wave.routes, side: g.length > 1 ? (j === 0 ? 'L' : 'R') : null };
        this.dispatch(ps, 'onBattleStart', ev);
        return ev.input && typeof ev.input === 'object' ? ev.input : input;
      });
      const fieldId = `b${i + 1}`;
      const bopts = {
        seed: deriveSeed(this.seed, `${fieldId}:${this.round}`),
        kind: hidden ? 'hidden' : 'boss',
        modeId: this.modeId,
        round: this.round,
        stageId: this.stageId,
        rect: { ...GEO.BOSS_RECT },
        timeLimit: Infinity,
        players: inputs,
        spawns: this._sanitizeSpawns(spawns),
        routes: wave.routes,
        sharedBoss: this.bossPool,
        flags: { layerGainsEnabled: false, ...this.gd.dp, enemyScale: this.gd.enemyScale(this.round) },
        fieldId,
        enemyOverrides: wave.overrides,
        waveId: wave.templateId,
        bossId,
      };
      if (this.clientCombat) return { fieldId, kind: hidden ? 'hidden' : 'boss', players: g.map((p) => p.playerId), opts: bopts, battle: null, live: true };
      if (poolOf()) return this._remoteField(bopts, g.map((p) => p.playerId));
      const battle = this.newBattle(bopts);
      try {
        battle.on('enemyLeak', (ctx) => this._bossLeak(ctx && ctx.enemy), { priority: -1000, owner: 'match' });
        battle.on('lpLoss', (ctx) => this._teamLpLoss(ctx && ctx.amount), { priority: -1000, owner: 'match' });
      } catch (e) { this.reportError('boss leak hook', e); }
      return { fieldId, kind: hidden ? 'hidden' : 'boss', players: g.map((p) => p.playerId), battle, live: true };
    });
    this.overtimeApplied = 0;
    const onClock = (realS) => this.sched.now() + Math.round(((realS * this.gd.combatTimeScale) / this.gameSpeed) * 1000);
    const levelTime = this.gd.bossLevelTime(this.round);
    this.deadline = this.sched.instant || !levelTime ? 0 : onClock(levelTime);
    this.overtimeAt = this.sched.instant ? 0 : onClock(this.gd.bossOvertimeAfterReal);
    if (this.clientCombat) { this._startFinalClient(hidden); return; }
    const Runner = poolOf() ? WorkerFieldRunner : FieldRunner;
    this.runner = new Runner(this, this.fields, {
      onTick: (runner) => this._bossTick(runner),
      onDone: (runner) => this._finalDone(runner, hidden),
      boss: { maxHp: pool.maxHp, hp: pool.hp, teamLp: this.teamLp, overtimeApplied: 0,
        combatTimeScale: this.gd.combatTimeScale, bossOvertimeAfterReal: this.gd.bossOvertimeAfterReal,
        bossOvertimeDrainReal: this.gd.bossOvertimeDrainReal },
    });
    this._defaultWatch();
    this.markPublic();
    this.runner.start();
  };

  // ---- upstream match/match/bossRounds.js _bossTick() ----
  proto._bossTick = function _bossTick(runner) {
    if (runner.remote) {
      // The worker already applied overtime and terminal ordering; only publish the accepted mirror here.
      if (runner.publicTick) this.markPublic();
      if (runner.secondTick) this.flush();
      return;
    }
    this._applyOvertime(runner.time);
    if (this.teamLp <= 0 && this.bossPool.hp > 0) runner.forceAll('forced');
    if (this.fields.some((f) => f.cc)) { this._broadcastPool(false); this._bossPublic(); }
    else if (runner.ticks % 6 === 0) this.markPublic();
    if (runner.ticks % 30 === 0) this.flush();
  };

  log('[combat-pool] Match methods wrapped (startCombat/startUnite/_uniteLeft/_uniteTick/startFinalAssault/_bossTick)');
}

export async function install(ctx) {
  const log = typeof ctx.log === 'function' ? ctx.log : (m) => console.log(m);
  const size = parseWorkers(process.env.SP_COMBAT_WORKERS);
  if (!size) { log('[combat-pool] SP_COMBAT_WORKERS unset — inline runner kept'); return; }
  assertUpstreamShape(log);
  const { getData } = await import('../data.js');
  const quiet = (m) => log(String(m));
  const pool = new CombatWorkerPool({ size, data: getData(), log: { error: quiet, warn: quiet, info: quiet } });
  await pool.start();
  POOL = pool;
  patchMatch(log);
  const close = ctx.server.close.bind(ctx.server);
  ctx.server.close = async () => { try { await close(); } finally { await pool.close(); POOL = null; } };
  log(`[combat-pool] worker pool ready (${size} workers; server-run phases only)`);
}
