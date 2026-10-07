// tools/apk/combat-pool-overlay.test.mjs — the shell combat-worker overlay (server/overlay/sp-combat-pool.mjs)
// and the pool it installs (server/combat/**).
//
// The point of these tests is the ZERO-UPSTREAM-DIFF contract: upstream server/** is untouched, the pool is
// additive, and the wrapper refuses to run when an upstream method it copies has moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { materialize, url, cleanup } from './overlay-harness.mjs';

const root = materialize();
const QUIET = { error() {}, warn() {}, info() {} };
const load = (rel) => import(url(root, rel));

const { CombatWorkerPool } = await load('server/combat/pool.mjs');
const { CombatEngine } = await load('server/combat/engine.mjs');
const { RemoteBattle, WorkerFieldRunner } = await load('server/combat/runner.mjs');
const { getData } = await load('server/data.js');
const { buildBattleSpec } = await load('server/sim/spec.js');
const { GEO } = await load('shared/constants.js');
const { Match } = await load('server/match/Match.js');

function spec(i = 0) {
  return buildBattleSpec({
    fieldId: `n:p${i}`, battleId: `overlay:${i}`, kind: 'normal', seed: 9181 + i,
    modeId: 'mode_multi_normal', round: 2, stageId: 'act1autochess_m01',
    rect: { ...GEO.NORMAL_RECT }, timeLimit: 4, content: 'full',
    players: [{
      playerId: `p${i}`, seat: i, side: 'L', colOffset: 0, bandId: 'band_bldsk',
      units: [
        { uid: 1, kind: 'chess', chessId: 'chess_char_3_01_b', row: 9, col: 8, dir: 'RIGHT' },
        { uid: 2, kind: 'chess', chessId: 'chess_char_4_22_b', row: 10, col: 8, dir: 'RIGHT' },
      ], bonds: {}, playerEffects: [],
    }],
    flags: { dpInit: 99, dpMax: 99, startOpCooldown: 0, layerGainsEnabled: true },
    routes: [{ motion: 'WALK', start: [9, 10], end: [9, 2], checkpoints: [] }],
    spawns: [{ time: 0, enemyKey: 'enemy_1007_slime', routeIndex: 0, count: 2, interval: 1, sourcePlayerId: 'leaker' }],
  });
}

test('the pool advances a real battle inside a worker', async (t) => {
  const pool = new CombatWorkerPool({ size: 1, data: getData(), log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  assert.equal(pool.stats().ready, 1);
  const session = pool.create({ specs: [spec()], wireFrames: true, coalesceFrames: true, damageBoard: false });
  const first = await session.ready;
  assert.equal(first.ticks, 0);
  const out = await session.request('advance', { ticks: 32, snapshotFields: ['n:p0'] });
  assert.ok(out.ticks > 0, 'the worker advanced the field');
  assert.ok(out.fields[0].time > 0, 'field clock moved');
  assert.ok(Array.isArray(out.frames) && out.frames.length > 0, 'frames cross the wire');
  await session.close();
  assert.equal(pool.stats().sessions, 0);
});

test('the engine drives the phase and reports a result when forced', async (t) => {
  const engine = new CombatEngine({ specs: [spec()], wireFrames: true, coalesceFrames: true, damageBoard: false },
    { data: getData(), log: QUIET });
  t.after(() => engine.dispose());
  engine.advance(32, { snapshotFields: ['n:p0'] });
  const out = engine.forceAll('forced');
  assert.equal(out.fields[0].live, false);
  assert.ok(out.fields[0].result?.perPlayer?.p0, 'a per-player result is reported');
});

test('the overlay wraps Match.prototype only when SP_COMBAT_WORKERS is set', async (t) => {
  const overlay = await load('server/overlay/sp-combat-pool.mjs');
  assert.equal(overlay.overlayApi, 1);
  const pristine = { startCombat: Match.prototype.startCombat, startUnite: Match.prototype.startUnite };

  const previous = process.env.SP_COMBAT_WORKERS;
  process.env.SP_COMBAT_WORKERS = '';
  await overlay.install({ server: { close: async () => {} }, log: () => {} });
  assert.equal(Match.prototype.startCombat, pristine.startCombat, 'unset → upstream methods untouched');

  process.env.SP_COMBAT_WORKERS = '1';
  const server = { closed: 0, close: async () => { server.closed++; } };
  await overlay.install({ server, log: () => {} });
  t.after(async () => {
    if (previous === undefined) delete process.env.SP_COMBAT_WORKERS; else process.env.SP_COMBAT_WORKERS = previous;
    await server.close();
  });
  assert.notEqual(Match.prototype.startCombat, pristine.startCombat, 'set → wrapped');
  assert.equal(typeof Match.prototype._remoteField, 'function');
  assert.equal(typeof Match.prototype.sendEncoded, 'function');
  await server.close();
  assert.equal(server.closed, 1, 'the wrapped close still runs the upstream close');
});

test('a wrapped match builds a remote field and runs it through the pool', async (t) => {
  const previous = process.env.SP_COMBAT_WORKERS;
  process.env.SP_COMBAT_WORKERS = '1';
  const overlay = await load('server/overlay/sp-combat-pool.mjs');
  const server = { close: async () => {} };
  await overlay.install({ server, log: () => {} });
  t.after(async () => {
    if (previous === undefined) delete process.env.SP_COMBAT_WORKERS; else process.env.SP_COMBAT_WORKERS = previous;
    await server.close();
  });

  const data = getData();
  const match = Object.create(Match.prototype);
  Object.assign(match, {
    clientCombat: false, gameSpeed: 2, battleContent: 'full', battlePrefix: 'ovl', round: 2,
    modeId: 'mode_multi_normal', stageId: 'act1autochess_m01', isSolo: true, hiddenBossId: null,
    paused: false, disposed: false, ended: false, phase: 'COMBAT', tickers: [], _uniteBounds: null,
    data, gd: (await load('server/match/gamedata.js')).GameData ? null : null,
    players: new Map(), spectators: new Map(), watchers: new Map(),
    sched: { now: () => Date.now(), instant: false, virtual: false, setInterval: () => 0, clearInterval: () => {} },
  });
  match.gd = new (await load('server/match/gamedata.js')).GameData(data);
  const ps = {
    playerId: 'p0', name: 'p0', seat: 0, alive: true, left: false, ready: true, isBot: false,
    bandId: 'band_bldsk', bounties: [], stats: {}, lp: 3, dirty() {},
    battleInput: ({ side }) => ({ playerId: 'p0', side, colOffset: 0, bandId: 'band_bldsk', units: [], bonds: {}, playerEffects: [] }),
  };
  match.players.set('p0', ps);
  match.wave = { timeLimit: 60 };
  match.alivePlayers = () => [ps];
  match._normalOpts = () => ({ ...spec(), players: [ps.battleInput({ side: 'L' })] });
  match._defaultWatch = () => {};
  match.markPublic = () => {};
  match.watchersOf = () => [];
  match.reportError = (label, e) => { throw new Error(`${label}: ${e.message}`); };
  match.sendTo = () => true;
  match.guard = (fn) => fn();
  match.sendEncoded = Match.prototype.sendEncoded;
  match._remoteField = Match.prototype._remoteField;

  Match.prototype.startCombat.call(match);
  assert.equal(match.fields.length, 1);
  assert.equal(match.fields[0].remote, true, 'the field is worker-owned');
  assert.ok(match.fields[0].spec, 'the field carries its spec for the pool');
  assert.ok(match.runner instanceof WorkerFieldRunner, 'a WorkerFieldRunner drives it');
  assert.ok(match.fields[0].battle instanceof RemoteBattle);
  match.runner.stop();
  cleanup(root);
});
