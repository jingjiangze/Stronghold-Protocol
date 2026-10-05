// player-stats.test.mjs — unit tests for the v4.10 records/statistics layer of
// tools/apk/extras/public/js/player-data.js:
//   · recordResult enrichment (difficulty/round/status/stats/operators/title from the m.result row)
//   · sanitizeBattle whitelists (junk stats / unknown status / operator dedupe+cap)
//   · battleStats aggregation — same 口径 as the server-side canonical aggregator (BBleae
//     shared/history.js: the 12 totals keys, winRate = wins/completed, operators desc by matches).
//
//   node --test tools/apk/player-stats.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const CODE = readFileSync(path.join(here, 'extras', 'public', 'js', 'player-data.js'), 'utf8');

function load(opts = {}) {
  const clock = { t: opts.now ?? 1_700_000_000_000 };
  const window = { location: { host: opts.host ?? 'test.local', protocol: 'http:' } };
  if (opts.spData) window.spData = opts.spData;
  const sandbox = {
    window,
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
    Date: { now: () => clock.t },
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'player-data.js' });
  const api = window.__SP_DATA;
  assert.ok(api && typeof api.battleStats === 'function', 'player-data.js installs the v4.10 API');
  return { api, window, clock };
}

const read = (api) => JSON.parse(api.exportJSON());

const SUMMARY = {
  victory: true,
  reason: 'completed',
  difficulty: 'HARD',
  roundsPassed: 12,
  hiddenCleared: true,
  durationMs: 1_234_000,
  modeId: 'coop',
  players: [
    {
      playerId: 'p1', seat: 0, name: '我', isBot: false, left: false,
      lineup: [{ id: 'amiya' }, { id: 'amiya' }, { id: 'chen' }],
      stats: { dmgDealt: 1200.4, kills: 12, bossDamage: 300, gold: 55, junkField: 1, leaks: -3 },
      title: { id: 't1', text: '挥金如土' },
    },
    { playerId: 'p2', seat: 1, name: 'AI', isBot: true, left: false, lineup: [], stats: { kills: 99 } },
  ],
};

// ---- recordResult enrichment -------------------------------------------------------------------

test('recordResult: keeps the local viewer row (difficulty/round/status/stats/operators/title)', () => {
  const { api } = load();
  api.recordResult(SUMMARY, { meId: 'p1', roomCode: 'ABCD', mode: 'coop' });
  const doc = read(api);
  assert.equal(doc.battles.length, 1);
  const b = doc.battles[0];
  assert.equal(b.result, 'win');
  assert.equal(b.mode, 'coop');
  assert.equal(b.roomCode, 'ABCD');
  assert.equal(b.difficulty, 'HARD');
  assert.equal(b.round, 12);
  assert.equal(b.status, 'completed');
  assert.equal(b.hidden, true);
  assert.equal(b.duration, 1_234_000);
  assert.equal(b.title, '挥金如土');
  assert.deepEqual([...b.operators], ['amiya', 'chen'], 'operator ids dedupe, order preserved');
  assert.deepEqual({ ...b.stats }, { dmgDealt: 1200, kills: 12, bossDamage: 300, gold: 55 },
    'whitelist only: unknown junkField dropped, negative leaks dropped, dmgDealt rounded');
  assert.ok(!b.stats.kills || b.stats.kills === 12, 'the AI teammate row is never mined for stats');
});

test('recordResult: no meId still records a usable (brief) battle', () => {
  const { api } = load();
  api.recordResult(SUMMARY, { roomCode: 'ABCD', mode: 'coop' });
  const b = read(api).battles[0];
  assert.equal(b.result, 'win');
  assert.equal(b.difficulty, 'HARD');
  assert.equal(b.round, 12, 'team roundsPassed is the fallback');
  assert.equal(b.status, 'completed');
  assert.equal(b.stats, undefined);
  assert.equal(b.operators, undefined);
});

test('recordResult: a player who left is status=left, an abandoned match is interrupted', () => {
  const { api } = load();
  const left = JSON.parse(JSON.stringify(SUMMARY));
  left.players[0].left = true;
  left.players[0].roundsPassed = 5;
  api.recordResult(left, { meId: 'p1', roomCode: 'AAAA', mode: 'coop' });
  let b = read(api).battles[0];
  assert.equal(b.status, 'left');
  assert.equal(b.round, 5, 'the leaving row carries its own round');

  api.recordResult({ victory: false, reason: 'abandoned', difficulty: 'NORMAL', players: [] },
    { roomCode: 'BBBB', mode: 'solo' });
  b = read(api).battles[1];
  assert.equal(b.status, 'interrupted');
  assert.equal(b.result, 'lose');
});

// ---- sanitizeBattle on import ------------------------------------------------------------------

test('import: battle enrichment fields are sanitised (whitelist, dedupe, caps, unknown status)', () => {
  const { api } = load();
  const ops = [];
  for (let i = 0; i < 20; i++) ops.push('op' + i);
  ops.splice(3, 0, 'op1'); // duplicate
  const doc = {
    v: 1, deviceId: 'dev-x', profile: { name: '', ts: 0 }, loadouts: {}, rooms: {}, servers: {},
    settings: null,
    battles: [{
      id: 'b1', ts: 1234, serverId: 's', roomCode: 'AAAA', mode: 'coop', result: 'win',
      difficulty: 'abyss', round: 9, status: 'weird', hidden: true, title: 'X'.repeat(100),
      stats: { dmgDealt: 10, healing: 1.5, nonsense: 999, lpLost: -1 },
      operators: ops,
    }],
  };
  assert.equal(api.importJSON(JSON.stringify(doc)), true);
  const b = read(api).battles[0];
  assert.equal(b.difficulty, 'ABYSS', 'difficulty is upper-cased');
  assert.equal(b.status, undefined, 'unknown status is dropped');
  assert.equal(b.title.length, 60, 'title is capped');
  assert.deepEqual({ ...b.stats }, { dmgDealt: 10, healing: 2 }, 'whitelist + rounding, negatives/unknowns dropped');
  assert.equal(b.operators.length, 12, 'operators capped');
  assert.equal(new Set(b.operators).size, 12, 'operators deduped');
});

// ---- battleStats aggregation -------------------------------------------------------------------

const B = (patch) => ({
  id: 'b' + Math.random(), ts: 1, serverId: 's', roomCode: '', mode: 'coop', ...patch,
});

test('battleStats: canonical 12-key totals, winRate = wins/completed, left/interrupted excluded from completed', () => {
  const { api } = load();
  const list = [
    B({ result: 'win', status: 'completed', difficulty: 'HARD', round: 14, hidden: true, stats: { dmgDealt: 100, kills: 5, lpLost: 0 }, operators: ['a', 'b'] }),
    B({ result: 'lose', status: 'completed', difficulty: 'HARD', round: 9, stats: { dmgDealt: 50, itemsEquipped: 7 }, operators: ['b'] }),
    B({ result: 'lose', status: 'left', difficulty: 'NORMAL', round: 3, hidden: true, stats: { dmgDealt: 10 }, operators: ['c'] }),
    B({ result: 'lose', status: 'interrupted', difficulty: 'NORMAL', stats: {} }),
  ];
  const s = api.battleStats(list, {});
  assert.equal(s.total, 4);
  assert.equal(s.completed, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.loses, 3);
  assert.equal(s.left, 1);
  assert.equal(s.interrupted, 1);
  assert.equal(s.winRate, 0.5, '1 win / 2 completed');
  assert.equal(s.highestRound, 14);
  assert.equal(s.hidden, 1, 'hidden counts only on non-left matches');
  assert.equal(s.totals.dmgDealt, 160);
  assert.equal(s.totals.kills, 5);
  assert.equal(s.totals.lpLost, 0);
  assert.equal(s.totals.itemsEquipped, undefined, 'display-only extras never enter totals');
  assert.deepEqual(Array.from(s.operators, (o) => ({ id: o.id, matches: o.matches })), [
    { id: 'b', matches: 2 }, { id: 'a', matches: 1 }, { id: 'c', matches: 1 },
  ], 'operators desc by matches, id asc on ties');
});

test('battleStats: mode/difficulty filters; empty list → winRate null', () => {
  const { api } = load();
  const list = [
    B({ result: 'win', status: 'completed', mode: 'coop', difficulty: 'HARD' }),
    B({ result: 'win', status: 'completed', mode: 'solo', difficulty: 'FUNNY' }),
  ];
  assert.equal(api.battleStats(list, { mode: 'solo' }).total, 1);
  assert.equal(api.battleStats(list, { difficulty: 'HARD' }).total, 1);
  assert.equal(api.battleStats(list, { mode: 'coop', difficulty: 'FUNNY' }).total, 0);
  const empty = api.battleStats([], {});
  assert.equal(empty.total, 0);
  assert.equal(empty.winRate, null);
  assert.equal(empty.highestRound, 0);
  assert.deepEqual([...empty.operators], []);
});

test('battleStats: legacy battles without status count as completed', () => {
  const { api } = load();
  const s = api.battleStats([B({ result: 'win' }), B({ result: 'lose' })], {});
  assert.equal(s.completed, 2);
  assert.equal(s.winRate, 0.5);
});
