// player-merge.test.mjs — unit tests for tools/apk/extras/public/js/player-data.js (v1 merge rules).
//
// The shipped script is a plain browser IIFE (not an ES module), so it is loaded into a vm context
// with a minimal browser-shaped sandbox: window (no indexedDB / localStorage unless a test supplies
// them), a controllable Date.now and no-op timers. This exercises exactly the file that ships.
//
//   node --test tools/apk/player-merge.test.mjs

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
  if (opts.storage) window.localStorage = opts.storage;
  const sandbox = {
    window,
    setTimeout: () => 0,      // throttled flush: parked, so tests never hold a live handle
    clearTimeout: () => {},
    console,
    Date: { now: () => clock.t },
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'player-data.js' });
  const api = window.__SP_DATA;
  assert.ok(api && typeof api.importJSON === 'function', 'player-data.js installs window.__SP_DATA');
  return { api, window, clock };
}

const docOf = (deviceId, patch = {}) => ({
  v: 1,
  deviceId,
  profile: { name: '', ts: 0 },
  loadouts: {},
  battles: [],
  rooms: {},
  servers: {},
  settings: null,
  ...patch,
});

const read = (api) => JSON.parse(api.exportJSON());

// ---- profile ---------------------------------------------------------------------------------

test('profile: LWW by ts — a newer import wins, an older archive cannot overwrite it', () => {
  const { api } = load();
  assert.equal(api.importJSON(JSON.stringify(docOf('dev-aaa', { profile: { name: '旧名', ts: 100 } }))), true);
  assert.equal(read(api).profile.name, '旧名');
  assert.equal(api.importJSON(JSON.stringify(docOf('dev-bbb', { profile: { name: '新名', ts: 200 } }))), true);
  assert.equal(read(api).profile.name, '新名');
  assert.equal(api.importJSON(JSON.stringify(docOf('dev-ccc', { profile: { name: '更旧', ts: 150 } }))), true);
  assert.equal(read(api).profile.name, '新名', 'an older archive must not overwrite a newer value');
  assert.equal(read(api).profile.ts, 200);
});

test('profile: equal ts falls back to the deviceId tie-break (larger id wins)', () => {
  const { api } = load();
  api.importJSON(JSON.stringify(docOf('dev-aaa', { profile: { name: 'A', ts: 100 } })));
  const localId = read(api).deviceId;
  assert.ok(localId.startsWith('dev-'), `generated deviceId looks like dev-*: ${localId}`);
  assert.equal(api.importJSON(JSON.stringify(docOf('zzz', { profile: { name: 'Z', ts: 100 } }))), true);
  assert.equal(read(api).profile.name, 'Z', 'zzz > dev-* on the tie-break');
  assert.equal(api.importJSON(JSON.stringify(docOf('aaa', { profile: { name: 'A2', ts: 100 } }))), true);
  assert.equal(read(api).profile.name, 'Z', 'aaa < dev-* on the tie-break');
});

// ---- loadouts --------------------------------------------------------------------------------

test('loadouts: key-level LWW — only the conflicting key is replaced', () => {
  const { api } = load();
  api.importJSON(JSON.stringify(docOf('dev-aaa', { loadouts: {
    c1: { skill: 's1', module: 'm1', ts: 100 },
    c2: { skill: 's2', ts: 100 },
  } })));
  api.importJSON(JSON.stringify(docOf('dev-bbb', { loadouts: { c1: { skill: 's9', ts: 200 } } })));
  const d = read(api);
  assert.deepEqual(d.loadouts.c1, { skill: 's9', ts: 200 });
  assert.deepEqual(d.loadouts.c2, { skill: 's2', ts: 100 }, 'untouched keys survive an import');
});

test('loadouts: an older archive key never overwrites the newer one', () => {
  const { api } = load();
  api.importJSON(JSON.stringify(docOf('dev-bbb', { loadouts: { c1: { skill: 'new', ts: 300 } } })));
  api.importJSON(JSON.stringify(docOf('dev-aaa', { loadouts: { c1: { skill: 'old', ts: 100 }, c9: { ts: 50 } } })));
  const d = read(api);
  assert.deepEqual(d.loadouts.c1, { skill: 'new', ts: 300 });
  assert.ok(d.loadouts.c9, 'a key the local doc never had is still merged in');
});

// ---- battles ---------------------------------------------------------------------------------

test('battles: union by id, idempotent, sorted by ts', () => {
  const { api } = load();
  const b = (id, ts) => ({ id, ts, serverId: 's1', roomCode: 'ABCD', mode: 'coop', result: 'win' });
  api.importJSON(JSON.stringify(docOf('dev-aaa', { battles: [b('b2', 200), b('b1', 100)] })));
  api.importJSON(JSON.stringify(docOf('dev-bbb', { battles: [b('b2', 200), b('b3', 300)] })));
  let d = read(api);
  assert.deepEqual(d.battles.map((x) => x.id), ['b1', 'b2', 'b3']);
  assert.deepEqual(d.battles.map((x) => x.ts), [100, 200, 300]);
  api.importJSON(JSON.stringify(docOf('dev-aaa', { battles: [b('b1', 100), b('b2', 200)] })));
  d = read(api);
  assert.equal(d.battles.length, 3, 're-importing the same archive is a no-op');
});

test('battles: junk entries are dropped by sanitising', () => {
  const { api } = load();
  api.importJSON(JSON.stringify(docOf('dev-aaa', { battles: [{ ts: 0 }, { nope: true }, 42, { id: 'ok', ts: 10 }] })));
  assert.deepEqual(read(api).battles.map((x) => x.id), ['ok']);
});

// ---- rooms / servers / pendingMatch: session state is NOT persisted (owner directive 2026-10-09) ----
//
// 旧断言「rooms/servers union with min firstSeen, max lastSeen...」已删除：业主 2026-10-09 口径把
// room / server / pendingMatch 从持久化范围里剔除，并集语义随之消失。下列两条即验收要求的
// ① 写含这些字段的文档 → 落盘/读回后不存在；② 老格式文档读进来不报错且被丢弃、设置与对局记录完整保留。

test('rooms/servers/pendingMatch: a doc carrying them is persisted WITHOUT those keys', () => {
  const { api } = load({ now: 1000 });
  api.importJSON(JSON.stringify(docOf('dev-aaa', {
    rooms: { ABCD: { serverId: 's1', firstSeen: 50, lastSeen: 100, count: 2 } },
    servers: { s1: { name: 'S1', firstSeen: 10, lastSeen: 100, battles: 1 } },
    pendingMatch: { ts: 9, difficulty: 'HARD', venueId: 'v1' },
  })));
  const d = read(api);
  assert.equal(Object.prototype.hasOwnProperty.call(d, 'rooms'), false, 'rooms is not written');
  assert.equal(Object.prototype.hasOwnProperty.call(d, 'servers'), false, 'servers is not written');
  assert.equal(Object.prototype.hasOwnProperty.call(d, 'pendingMatch'), false, 'pendingMatch is not written');
  // The serialised text must not smuggle the keys back in either (a union/merge path could re-add them).
  assert.equal(/"(rooms|servers|pendingMatch)"\s*:/.test(api.exportJSON()), false, 'the exported JSON has no such keys');
});

test('rooms/servers/pendingMatch: still absent after a write -> flush -> reload round trip', () => {
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const first = load({ storage, now: 1000 });
  first.api.importJSON(JSON.stringify(docOf('dev-aaa', {
    rooms: { ABCD: { serverId: 's1', firstSeen: 50, lastSeen: 100, count: 2 } },
    servers: { s1: { name: 'S1', firstSeen: 10, lastSeen: 100, battles: 1 } },
    pendingMatch: { ts: 9, difficulty: 'HARD', venueId: 'v1' },
  })));
  first.api.recordProfile('博士'); // make the doc non-trivial and force a durable write
  first.api.flush();
  const persisted = JSON.parse(map.get('sp.player.v1'));
  assert.equal('rooms' in persisted, false, 'the persisted mirror has no rooms');
  assert.equal('servers' in persisted, false, 'the persisted mirror has no servers');
  assert.equal('pendingMatch' in persisted, false, 'the persisted mirror has no pendingMatch');

  const second = load({ storage, now: 2000 });
  const d2 = read(second.api);
  assert.equal('rooms' in d2, false, 'rooms stay gone after reload');
  assert.equal('servers' in d2, false, 'servers stay gone after reload');
  assert.equal('pendingMatch' in d2, false, 'pendingMatch stays gone after reload');
});

test('legacy doc with rooms/servers/pendingMatch: read without error, dropped, settings+battles kept', () => {
  // An old player-v1.json (the filesDir truth) that still holds the retired session fields.
  const legacy = {
    v: 1,
    deviceId: 'dev-old',
    profile: { name: '旧档博士', ts: 42 },
    loadouts: { c1: { skill: 1, ts: 5 } },
    battles: [
      { id: 'b1', ts: 100, serverId: 's1', roomCode: 'ABCD', mode: 'coop', result: 'win', round: 5 },
      { id: 'b2', ts: 200, serverId: 's1', roomCode: 'EFGH', mode: 'coop', result: 'lose' },
    ],
    rooms: { ABCD: { serverId: 's1', firstSeen: 1, lastSeen: 2, count: 3 } },
    servers: { s1: { name: 'S1', firstSeen: 1, lastSeen: 2, battles: 2 } },
    settings: { bgm: 0.3, sfx: 0.4, muted: true, damageNumbers: false, quality: 'low', fontScale: 0.95, sidePad: 7, ts: 900 },
    pendingMatch: { ts: 9, difficulty: 'ABYSS', venueId: 'v1' },
  };
  const map = new Map([['sp.player.v1', JSON.stringify(legacy)]]);
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const { api } = load({ storage, now: 5000 }); // must not throw
  const d = read(api);
  assert.equal('rooms' in d, false, 'legacy rooms are dropped, not kept as an unknown field');
  assert.equal('servers' in d, false, 'legacy servers are dropped');
  assert.equal('pendingMatch' in d, false, 'legacy pendingMatch is dropped');
  // The parts that ARE in scope must survive intact.
  assert.deepEqual(d.profile, { name: '旧档博士', ts: 42 }, 'profile kept');
  assert.deepEqual(d.loadouts.c1, { ts: 5, skill: 1 }, 'loadouts kept');
  assert.deepEqual(d.battles.map((x) => x.id), ['b1', 'b2'], 'battles kept');
  assert.equal(d.battles[0].round, 5, 'battle detail kept');
  assert.equal(d.battles[0].serverId, 's1', 'battle.serverId kept (part of the match record)');
  assert.equal(d.settings.bgm, 0.3, 'settings kept');
  assert.equal(d.settings.ts, 900, 'settings ts kept');
  assert.equal(d.settings.sidePad, 7, 'settings sidePad kept');
  assert.equal(d.settings.quality, 'low', 'settings quality kept');
});

// ---- import validation -----------------------------------------------------------------------

test('importJSON refuses malformed input and leaves the doc untouched', () => {
  const { api } = load();
  const before = api.exportJSON();
  const bad = [
    'not json', '{oops', '', '[1,2]', '"text"', '42', null, undefined,
    JSON.stringify({ deviceId: 'x' }),
    JSON.stringify({ v: 0, deviceId: 'x' }),
    JSON.stringify({ v: 2, deviceId: 'x' }),
    JSON.stringify({ v: 1.5, deviceId: 'x' }),
    JSON.stringify({ v: '1', deviceId: 'x' }),
  ];
  for (const text of bad) assert.equal(api.importJSON(text), false, `refused: ${String(text)}`);
  assert.equal(api.exportJSON(), before, 'a refused import never mutates the doc');
});

// ---- record* hooks ---------------------------------------------------------------------------

test('recordResult: the natural id collapses exact replays; result-only fields', () => {
  const { api, clock } = load({ now: 5000 });
  api.recordResult({ victory: true, durationMs: 123456 }, { roomCode: 'ABCD', mode: 'coop', serverId: 's1' });
  api.recordResult({ victory: true, durationMs: 123456 }, { roomCode: 'ABCD', mode: 'coop', serverId: 's1' });
  let d = read(api);
  assert.equal(d.battles.length, 1, 'same (ts, serverId, roomCode, mode) collapses');
  assert.deepEqual(d.battles[0], {
    // v4.10: a settlement without a matched player row still records the (known) completed status
    id: '5000-s1-ABCD-coop', ts: 5000, serverId: 's1', roomCode: 'ABCD', mode: 'coop', result: 'win', duration: 123456,
    status: 'completed',
  });
  // 2026-10-09: the old `d.servers.s1.battles` counter assertions are gone — servers are no
  // longer persisted, so a collapsed replay has nothing to bump.
  assert.equal('servers' in d, false, 'no servers map is persisted');
  clock.t = 6000;
  api.recordResult({ victory: false }, { roomCode: 'ABCD', mode: 'coop', serverId: 's1' });
  d = read(api);
  assert.equal(d.battles.length, 2);
  assert.equal(d.battles[1].result, 'lose');
  assert.equal(d.battles[1].duration, undefined, 'a missing duration is omitted, not zeroed');
});

test('recordRoom: kept as a no-op API (rooms/servers are session state, not persisted)', () => {
  const { api, clock } = load({ now: 100 });
  assert.equal(typeof api.recordRoom, 'function', 'the API name is kept for core-hooks.js');
  assert.doesNotThrow(() => {
    api.recordRoom({ code: 'ABCD', seats: [{ playerId: 'p1' }, { playerId: 'p2' }] });
  });
  clock.t = 200;
  api.recordRoom({ code: 'ABCD' });
  const d = read(api);
  assert.equal('rooms' in d, false, 'recordRoom records nothing');
  assert.equal('servers' in d, false, 'recordRoom records nothing');
});

test('recordProfile / recordLoadout / recordServer write the modelled shapes (recordServer is a no-op)', () => {
  const { api, clock } = load({ now: 1000 });
  clock.t = 1100;
  api.recordProfile('博士');
  clock.t = 1200;
  api.recordLoadout({ c1: { skill: 'sX', module: 'mX' }, c2: { skill: '' }, bad: 7 });
  clock.t = 1300;
  api.recordServer({ id: 's7', name: '主机' }); // kept as a no-op (owner directive 2026-10-09)
  const d = read(api);
  assert.deepEqual(d.profile, { name: '博士', ts: 1100 });
  assert.deepEqual(Object.keys(d.loadouts).sort(), ['c1', 'c2']);
  assert.deepEqual(d.loadouts.c1, { ts: 1200, skill: 'sX', module: 'mX' });
  assert.deepEqual(d.loadouts.c2, { ts: 1200 });
  assert.equal('servers' in d, false, 'recordServer no longer persists a servers map');
});

test('recordLoadout: real loadoutModel shapes (numeric skill, module id, none, {}) survive a persistence round trip', () => {
  // Sample copied from the live model (public/js/ui/loadoutModel.js: the per-browser loadout is
  // `{ [baseChessId]: { skill?: number, module?: uniEquipId | 'none' } }`, written by setChoice):
  // a numeric skill index, a skill + uniEquipId module, the explicit "no module" sentinel and an empty entry.
  const entries = {
    char_002_amiya: { skill: 2 },
    char_140_whitew: { skill: 1, module: 'uniequip_002_whitew' },
    char_4042_lumen: { module: 'none' },
    char_1001_amiya2: {},
  };
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const { api } = load({ storage, now: 7000 });
  api.recordLoadout(entries);
  api.flush();
  const d = read(api);
  assert.deepEqual(d.loadouts.char_002_amiya, { ts: 7000, skill: 2 }, 'a numeric skill is kept (the old code dropped it as a non-string)');
  assert.deepEqual(d.loadouts.char_140_whitew, { ts: 7000, skill: 1, module: 'uniequip_002_whitew' });
  assert.deepEqual(d.loadouts.char_4042_lumen, { ts: 7000, module: 'none' }, "'none' is the explicit no-module sentinel and is kept");
  assert.deepEqual(d.loadouts.char_1001_amiya2, { ts: 7000 }, 'an empty entry still stores just the timestamp');

  // Reloading reads the stored text back through sanitizeDoc — the numeric skill must survive that too,
  // or the App's filesDir doc would lose every skill on the next start.
  const second = load({ storage, now: 8000 });
  const d2 = read(second.api);
  assert.deepEqual(d2.loadouts.char_002_amiya, { ts: 7000, skill: 2 }, 'the numeric skill survives a persistence reload');
  assert.deepEqual(d2.loadouts.char_140_whitew, { ts: 7000, skill: 1, module: 'uniequip_002_whitew' });
  assert.deepEqual(d2.loadouts.char_4042_lumen, { ts: 7000, module: 'none' });

  // Guard band: non-integers are dropped, out-of-range integers clamp to 99, legacy strings stay tolerated.
  const third = load({ now: 9000 });
  third.api.recordLoadout({ cHigh: { skill: 250 }, cFloat: { skill: 2.5 }, cStr: { skill: 'legacy' } });
  const d3 = read(third.api);
  assert.deepEqual(d3.loadouts.cHigh, { ts: 9000, skill: 99 });
  assert.deepEqual(d3.loadouts.cFloat, { ts: 9000 }, 'a non-integer skill is dropped');
  assert.equal(d3.loadouts.cStr.skill, 'legacy', 'legacy string skills are still tolerated');
});

// ---- v3.7 seed: per-origin loadout / callsign fill-in ------------------------------------------

test('seed: an empty origin pref is filled from the doc — toStored shape, no ts, "none" kept', () => {
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const spData = {
    get: () => JSON.stringify(docOf('dev-seed', {
      profile: { name: '博士', ts: 7 },
      loadouts: {
        char_140_whitew: { skill: 2, module: 'uniequip_002_whitew', ts: 9 },
        char_4042_lumen: { module: 'none', ts: 9 },
        char_1001_amiya2: { ts: 9 }, // no usable choice — the game's parseStored would drop it too
      },
    })),
    put: () => {},
  };
  load({ spData, storage });
  assert.equal(map.get('sp.name'), '博士', 'callsign seeded into the raw sp.name key');
  assert.deepEqual(JSON.parse(map.get('sp.pref.loadout')), {
    v: 1,
    entries: {
      char_140_whitew: { skill: 2, module: 'uniequip_002_whitew' },
      char_4042_lumen: { module: 'none' },
    },
  }, 'toStored shape (v/entries), ts dropped, "none" kept, empty entry dropped');
});

test('seed: an existing sp.pref.loadout is never overwritten; a callsign follows the newer doc', () => {
  const map = new Map([
    ['sp.pref.loadout', JSON.stringify({ v: 1, entries: { keepMe: { skill: 3 } } })],
    ['sp.name', '老代号'],
  ]);
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const spData = {
    get: () => JSON.stringify(docOf('dev-seed', {
      profile: { name: '新代号', ts: 7 },
      loadouts: { other: { skill: 1, ts: 9 } },
    })),
    put: () => {},
  };
  load({ spData, storage });
  assert.equal(map.get('sp.name'), '新代号', 'doc.profile is the truth; its ts (7) beats an untimed local mirror');
  assert.equal(map.get('sp.name.ts'), '7', 'the mirror stamp records the doc ts');
  assert.deepEqual(JSON.parse(map.get('sp.pref.loadout')).entries, { keepMe: { skill: 3 } }, 'an existing loadout wins');
});

test('seed: {v:1,entries:{}} and empty keys count as missing and are refilled', () => {
  const map = new Map([
    ['sp.pref.loadout', JSON.stringify({ v: 1, entries: {} })],
    ['sp.name', ''],
  ]);
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const spData = {
    get: () => JSON.stringify(docOf('dev-seed', {
      profile: { name: '代号', ts: 7 },
      loadouts: { c1: { skill: 5, ts: 9 } },
    })),
    put: () => {},
  };
  load({ spData, storage });
  assert.equal(map.get('sp.name'), '代号');
  assert.deepEqual(JSON.parse(map.get('sp.pref.loadout')), { v: 1, entries: { c1: { skill: 5 } } });
});

test('seed: a doc ts strictly greater than the local mirror overwrites (renamed on another origin)', () => {
  const map = new Map([
    ['sp.name', '旧代号'],
    ['sp.name.ts', '5'],
  ]);
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const spData = {
    get: () => JSON.stringify(docOf('dev-seed', { profile: { name: '改名后', ts: 7 } })),
    put: () => {},
  };
  load({ spData, storage });
  assert.equal(map.get('sp.name'), '改名后', 'a strictly newer doc ts overwrites the stale local mirror');
  assert.equal(map.get('sp.name.ts'), '7');
});

test('seed: an untimed doc (ts=0) never overwrites an existing local callsign, but still fills an empty one', () => {
  const map = new Map([['sp.name', '本地已有']]);
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const spData = {
    get: () => JSON.stringify(docOf('dev-seed', { profile: { name: '下发代号', ts: 0 } })),
    put: () => {},
  };
  load({ spData, storage });
  assert.equal(map.get('sp.name'), '本地已有', 'a doc without a ts must not clobber an existing local name (the stop-bleed case)');
  const map2 = new Map([['sp.name', '']]);
  const storage2 = {
    getItem: (k) => (map2.has(k) ? map2.get(k) : null),
    setItem: (k, v) => { map2.set(k, String(v)); },
  };
  load({ spData, storage: storage2 });
  assert.equal(map2.get('sp.name'), '下发代号', 'a missing local value is still filled in (gap-only for untimed docs)');
});

test('seed: a doc ts equal to the local mirror keeps the local callsign (strict-update semantics)', () => {
  const map = new Map([
    ['sp.name', '旧'],
    ['sp.name.ts', '7'],
  ]);
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const spData = {
    get: () => JSON.stringify(docOf('dev-seed', { profile: { name: '同刻新名', ts: 7 } })),
    put: () => {},
  };
  load({ spData, storage });
  assert.equal(map.get('sp.name'), '旧', 'doc ts == local ts is no longer a doc win — local is kept');
  assert.equal(map.get('sp.name.ts'), '7', 'the local stamp is left untouched');
});

test('seed: a locally-newer callsign (this origin renamed, doc not caught up) survives the ts guard', () => {
  const map = new Map([
    ['sp.name', '本地新名'],
    ['sp.name.ts', '100'],
  ]);
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const spData = {
    get: () => JSON.stringify(docOf('dev-seed', { profile: { name: '旧真源', ts: 50 } })),
    put: () => {},
  };
  load({ spData, storage });
  assert.equal(map.get('sp.name'), '本地新名', 'a staler doc must not clobber a locally-newer edit');
  assert.equal(map.get('sp.name.ts'), '100', 'the local stamp is left untouched');
});

test('recordProfile: writes the doc AND mirrors sp.name / sp.name.ts into this origin', () => {
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const { api, clock } = load({ storage, now: 1000 });
  clock.t = 1234;
  api.recordProfile('跨站博士');
  assert.equal(read(api).profile.name, '跨站博士');
  assert.equal(map.get('sp.name'), '跨站博士', 'this origin becomes the truth for the next origin');
  assert.equal(map.get('sp.name.ts'), '1234', 'the local mirror carries the record ts');
});

// ---- v4.6 settings blob: sanitize / merge / record / seed ---------------------------------------

// 游戏落盘的 fontScale 恒为五档之一（分段控件）；取 0.95 —— 注意上游 nearest 的严格小于让
// 显式 1 在 0.95/1.05 平局时也吸附到 0.95，故不要用 1 当默认值做 deepEqual 基线。
const rawSettings = (patch = {}) => ({ bgm: 0.5, sfx: 0.5, muted: false, damageNumbers: true, quality: 'high', fontScale: 0.95, sidePad: 10, ...patch });

test('settings: sanitize clamps volumes, snaps fontScale to a step, drops a non-object blob', () => {
  const { api } = load();
  api.importJSON(JSON.stringify(docOf('dev-aaa', {
    settings: rawSettings({
      bgm: 2.5, sfx: -1, quality: 'ultra', fontScale: 1.4, sidePad: 99, ts: 123,
      junk: 'stripped',
    }),
  })));
  assert.deepEqual(read(api).settings, {
    bgm: 1, sfx: 0, muted: false, damageNumbers: true, quality: 'high',
    fontScale: 1.25, sidePad: 40, ts: 123,
  }, 'clamped into the same guard bands as gameLogic.sanitizeSettings (unknown fields stripped)');  const { api: api2 } = load();
  api2.importJSON(JSON.stringify(docOf('dev-aaa', { settings: 'nope' })));
  assert.equal(read(api2).settings, null, 'a non-object blob is dropped entirely');
  const { api: api3 } = load();
  api3.importJSON(JSON.stringify(docOf('dev-aaa', { settings: rawSettings({ fontScale: 0.96, muted: 'yes', damageNumbers: 1, bgm: 'loud' }) })));
  assert.deepEqual(read(api3).settings, rawSettings({ fontScale: 0.95, bgm: 0.6, muted: false, damageNumbers: true, ts: 0 }),
    'in-between fontScale snaps to the nearest step; wrong-typed fields fall back to defaults');
});

test('settings: whole-blob LWW by ts — a newer import wins, an older one cannot overwrite', () => {
  const { api } = load();
  api.importJSON(JSON.stringify(docOf('dev-aaa', { settings: rawSettings({ sidePad: 20, ts: 100 }) })));
  assert.equal(read(api).settings.sidePad, 20);
  api.importJSON(JSON.stringify(docOf('dev-bbb', { settings: rawSettings({ sidePad: 30, ts: 200 }) })));
  assert.equal(read(api).settings.sidePad, 30, 'a newer blob wins as a whole');
  api.importJSON(JSON.stringify(docOf('dev-ccc', { settings: rawSettings({ sidePad: 5, ts: 150 }) })));
  assert.equal(read(api).settings.sidePad, 30, 'an older blob never overwrites a newer one');
});

test('settings: a blob without ts merges as ts=0 and loses to a timestamped one', () => {
  const { api } = load();
  api.importJSON(JSON.stringify(docOf('dev-aaa', { settings: rawSettings({ sidePad: 20, ts: 100 }) })));
  api.importJSON(JSON.stringify(docOf('dev-bbb', { settings: rawSettings({ sidePad: 30 }) })));
  assert.equal(read(api).settings.sidePad, 20, 'a missing ts counts as 0 (legacy archives never win)');
});

test('settings: equal ts falls back to the deviceId tie-break (larger id wins)', () => {
  const { api } = load();
  api.importJSON(JSON.stringify(docOf('dev-aaa', { settings: rawSettings({ sidePad: 20, ts: 100 }) })));
  api.importJSON(JSON.stringify(docOf('zzz', { settings: rawSettings({ sidePad: 30, ts: 100 }) })));
  assert.equal(read(api).settings.sidePad, 30, 'zzz > dev-* on the tie-break');
  api.importJSON(JSON.stringify(docOf('aaa', { settings: rawSettings({ sidePad: 40, ts: 100 }) })));
  assert.equal(read(api).settings.sidePad, 30, 'aaa < dev-* on the tie-break');
});

test('recordSettings: writes the clamped blob into the doc and stamps sp.pref.settings.ts', () => {
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const { api, clock } = load({ storage, now: 1000 });
  clock.t = 4321;
  api.recordSettings(rawSettings({ bgm: 9, sidePad: 100, junk: 'x' }));
  assert.deepEqual(read(api).settings, rawSettings({ bgm: 1, sidePad: 40, ts: 4321 }),
    'the doc blob carries the record ts and clamped fields');
  assert.equal(map.get('sp.pref.settings.ts'), '4321', 'the mirror stamp is written beside the upstream pref');
  assert.equal(map.has('sp.pref.settings'), false, 'the upstream pref key itself is never written by player-data.js');
  api.recordSettings('junk');
  assert.equal(map.get('sp.pref.settings.ts'), '4321', 'a junk snapshot is ignored');
});

test('seedSettings: an empty origin pref is seeded from the doc (blob without ts + mirror stamp)', () => {
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const spData = {
    get: () => JSON.stringify(docOf('dev-seed', { settings: rawSettings({ bgm: 0.3, ts: 555 }) })),
    put: () => {},
  };
  load({ spData, storage });
  const blob = JSON.parse(map.get('sp.pref.settings'));
  assert.deepEqual(blob, rawSettings({ bgm: 0.3 }), 'seeded without ts (upstream sanitizeSettings strips unknown fields)');
  assert.equal(map.get('sp.pref.settings.ts'), '555', 'the ts only lives in the mirror stamp key');
});

test('seedSettings: a strictly newer doc blob overwrites the local pref and moves the stamp', () => {
  const map = new Map([
    ['sp.pref.settings', JSON.stringify(rawSettings({ sidePad: 10 }))],
    ['sp.pref.settings.ts', '100'],
  ]);
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const spData = {
    get: () => JSON.stringify(docOf('dev-seed', { settings: rawSettings({ sidePad: 30, ts: 200 }) })),
    put: () => {},
  };
  load({ spData, storage });
  assert.equal(JSON.parse(map.get('sp.pref.settings')).sidePad, 30, 'the newer doc blob lands in this origin');
  assert.equal(map.get('sp.pref.settings.ts'), '200');
});

test('seedSettings: a locally-newer blob is kept and written back into the doc (record path)', () => {
  const map = new Map([
    ['sp.pref.settings', JSON.stringify(rawSettings({ sidePad: 30, junk: 'x' }))],
    ['sp.pref.settings.ts', '300'],
  ]);
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const spData = {
    get: () => JSON.stringify(docOf('dev-seed', { settings: rawSettings({ sidePad: 10, ts: 200 }) })),
    put: () => {},
  };
  const { api, clock } = load({ spData, storage, now: 1_700_000_000_000 });
  assert.equal(JSON.parse(map.get('sp.pref.settings')).sidePad, 30, 'the locally-newer blob is not clobbered');
  assert.equal(JSON.parse(map.get('sp.pref.settings')).junk, 'x', 'the game-owned pref key is never rewritten by the seed');
  assert.equal(map.get('sp.pref.settings.ts'), String(1_700_000_000_000), 'the stamp moves to the record ts (the write-back went through recordSettings)');
  assert.equal(read(api).settings.sidePad, 30, 'the local blob was written back into the doc (clamped)');
  assert.equal(read(api).settings.ts, 1_700_000_000_000, 'the write-back carries the record ts');
});

test('seedSettings: a null doc block leaves an existing local pref untouched', () => {
  const map = new Map([
    ['sp.pref.settings', JSON.stringify(rawSettings({ sidePad: 12 }))],
    ['sp.pref.settings.ts', '9'],
  ]);
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const spData = {
    get: () => JSON.stringify(docOf('dev-seed', {})),
    put: () => {},
  };
  load({ spData, storage });
  assert.equal(JSON.parse(map.get('sp.pref.settings')).sidePad, 12, 'no doc block → local pref survives');
  assert.equal(map.get('sp.pref.settings.ts'), '9');
});

test('seedSettings: a locally-present junk blob is never touched when the doc block has no ts', () => {
  const map = new Map([['sp.pref.settings', 'not json']]);
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const spData = {
    get: () => JSON.stringify(docOf('dev-seed', { settings: rawSettings({ ts: 0 }) })),
    put: () => {},
  };
  load({ spData, storage });
  assert.equal(map.get('sp.pref.settings'), 'not json', 'an untimed doc block (ts=0) never overwrites a present local value');
  assert.equal(map.has('sp.pref.settings.ts'), false, 'nothing is seeded over it');
});


test('seed: without a doc (fresh empty state) nothing is written', () => {
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  load({ storage });
  assert.equal(map.has('sp.pref.loadout'), false);
  assert.equal(map.has('sp.name'), false);
});

// ---- backends --------------------------------------------------------------------------------

test('bridge backend: put persists the doc and a fresh load restores it', () => {
  const store = { text: null };
  const spData = { get: () => store.text, put: (text) => { store.text = text; } };
  const first = load({ spData, host: 'app.local' });
  first.api.recordProfile('Bridge');
  first.api.flush();
  assert.ok(store.text, 'put() was called');
  assert.equal(JSON.parse(store.text).profile.name, 'Bridge');
  const second = load({ spData, host: 'app.local' });
  assert.equal(read(second.api).profile.name, 'Bridge', 'the bridge doc is the first-load truth');
});

test('localStorage fallback: a web build without IndexedDB survives a reload', () => {
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const first = load({ storage });
  first.api.recordProfile('Web');
  first.api.flush();
  assert.ok(map.has('sp.player.v1'), 'the mirror key is written');
  const second = load({ storage });
  assert.equal(read(second.api).profile.name, 'Web');
});

test('no backend at all: every call is silent (flush never throws)', () => {
  const { api } = load();
  assert.doesNotThrow(() => {
    api.recordRoom({ code: 'ZZZZ' });
    api.recordResult({ victory: true });
    api.flush();
  });
});

test('_mergeDocs keeps the local deviceId and never mutates its inputs', () => {
  const { api } = load();
  const local = docOf('dev-local', { profile: { name: 'L', ts: 10 } });
  const other = docOf('dev-other', { profile: { name: 'O', ts: 20 } });
  const snapshot = JSON.stringify(local);
  const merged = api._mergeDocs(local, other);
  assert.equal(merged.deviceId, 'dev-local');
  assert.equal(merged.profile.name, 'O');
  assert.equal(JSON.stringify(local), snapshot, 'the local input is untouched');
});

// ---- pendingMatch (v5.1; NOT persisted since the 2026-10-09 owner directive) --------------------
//
// 旧断言「record → peek → take clears / survives export-import / malformed dropped」已改写：这几个
// API 名字保留（lobby.js 会 typeof 检查并调用），但一律返回「空」—— 不再进 doc、不再跨 origin。

test('pendingMatch: APIs are kept but always return empty and never touch the doc', () => {
  const { api } = load({ now: 4200 });
  assert.equal(typeof api.recordMatchPending, 'function', 'name kept for lobby.js');
  assert.equal(typeof api.peekMatchPending, 'function');
  assert.equal(typeof api.takeMatchPending, 'function');
  assert.equal(typeof api.clearMatchPending, 'function');
  assert.equal(api.peekMatchPending(), null, 'nothing to peek');
  assert.equal(api.recordMatchPending({ difficulty: 'HARD', venueId: 'v1' }), false, 'record reports not-stored');
  assert.equal(api.peekMatchPending(), null, 'nothing is stored');
  assert.equal(api.takeMatchPending(), null, 'nothing to take');
  assert.equal(api.clearMatchPending(), true, 'clearing an absent pending is a no-op success');
  assert.equal('pendingMatch' in JSON.parse(api.exportJSON()), false, 'never lands in the doc');
});

test('pendingMatch: never carried across export/import or merge', () => {
  const { api } = load({ now: 5000 });
  api.recordMatchPending({ difficulty: 'ABYSS', venueId: 'v1' });
  const doc = JSON.parse(api.exportJSON());
  assert.equal('pendingMatch' in doc, false, 'the exported doc has no pendingMatch');

  // A legacy doc that still carries one must not smuggle it back in through merge either.
  const legacy = {
    v: 1, deviceId: 'dev-legacy', profile: { name: '', ts: 0 }, loadouts: {}, battles: [],
    rooms: {}, servers: {}, settings: null, pendingMatch: { ts: 6000, difficulty: 'ABYSS', venueId: 'v1' },
  };
  const merged = api._mergeDocs(doc, legacy);
  assert.equal('pendingMatch' in merged, false, 'merge drops the legacy pendingMatch');
  const merged2 = api._mergeDocs(legacy, doc);
  assert.equal('pendingMatch' in merged2, false, 'merge drops it regardless of side');
});

test('pendingMatch: a legacy value is ignored on import (never stored)', () => {
  const { api } = load();
  const bad = ["not-an-object", { ts: 0 }, { ts: 'x', difficulty: 'HARD' }, {}, { ts: 9, difficulty: 'HARD', venueId: 'v' }];
  for (const v of bad) {
    assert.equal(api.importJSON(JSON.stringify({
      v: 1, deviceId: 'dev-z', profile: { name: '', ts: 0 }, loadouts: {}, battles: [], rooms: {},
      servers: {}, settings: null, pendingMatch: v,
    })), true);
    assert.equal(api.peekMatchPending(), null, `ignored: ${JSON.stringify(v)}`);
    assert.equal('pendingMatch' in JSON.parse(api.exportJSON()), false, `not stored: ${JSON.stringify(v)}`);
  }
});

// ---- prefs namespace (v8.0) ------------------------------------------------------------------

test('prefs: set/get round-trips and survives export/import', () => {
  const j = (v) => JSON.parse(JSON.stringify(v)); // vm-realm objects: compare by value, not prototype
  const { api } = load({ now: 1000 });
  assert.equal(api.prefsSet('appearance', { fontScale: 1.25, sidePad: 8 }), true);
  assert.deepEqual(j(api.prefsGet('appearance')), { fontScale: 1.25, sidePad: 8 });
  assert.equal(api.prefsStamp('appearance'), 1000);
  assert.deepEqual(Array.from(api.prefsKeys()), ['appearance']);
  assert.deepEqual(j(api.prefsSnapshot()), { appearance: { fontScale: 1.25, sidePad: 8 } });

  const doc = JSON.parse(api.exportJSON());
  assert.deepEqual(doc.prefs.settings.appearance, { value: { fontScale: 1.25, sidePad: 8 }, ts: 1000 });

  const { api: other } = load();
  assert.equal(other.importJSON(JSON.stringify(doc)), true);
  assert.deepEqual(j(other.prefsGet('appearance')), { fontScale: 1.25, sidePad: 8 });
});

test('prefs: per-key LWW — a newer ts wins, an older side cannot overwrite it', () => {
  const { api } = load({ now: 100 });
  api.prefsSet('notice.seen', 'rev-old', 100);
  const older = JSON.parse(api.exportJSON());

  const { api: newer } = load({ now: 200 });
  newer.prefsSet('notice.seen', 'rev-new', 200);
  const newerDoc = JSON.parse(newer.exportJSON());

  const merged = api._mergeDocs(newerDoc, older);
  assert.equal(merged.prefs.settings['notice.seen'].value, 'rev-new', 'older cannot overwrite newer');
  const merged2 = api._mergeDocs(older, newerDoc);
  assert.equal(merged2.prefs.settings['notice.seen'].value, 'rev-new', 'newer wins regardless of side');
});

test('prefs: distinct keys merge independently (no whole-blob clobber)', () => {
  const { api } = load({ now: 10 });
  api.prefsSet('lobby.tokens', { A: 't' }, 10);
  const a = JSON.parse(api.exportJSON());
  const { api: b } = load({ now: 20 });
  b.prefsSet('lobby.filter', 'waiting', 20);
  const bd = JSON.parse(b.exportJSON());
  const merged = api._mergeDocs(a, bd);
  assert.deepEqual(JSON.parse(JSON.stringify(merged.prefs.settings['lobby.tokens'].value)), { A: 't' });
  assert.equal(merged.prefs.settings['lobby.filter'].value, 'waiting');
});

test('prefs: malformed entries are dropped; a non-object value is refused', () => {
  const { api } = load();
  assert.equal(api.prefsSet('', 'x'), false);
  assert.equal(api.prefsSet('fn', undefined), false, 'undefined is not JSON-serialisable');
  assert.equal(api.prefsSet('fn', function () {}), false, 'functions are not JSON-serialisable');
  const bad = {
    v: 1, deviceId: 'dev-z', profile: { name: '', ts: 0 }, loadouts: {}, battles: [], rooms: {},
    servers: {}, settings: null,
    prefs: { v: 1, settings: { good: { value: 'ok', ts: 5 }, noValue: { ts: 5 }, notObj: 7, '': { value: 1, ts: 1 } } },
  };
  assert.equal(api.importJSON(JSON.stringify(bad)), true);
  assert.deepEqual(Array.from(api.prefsKeys()), ['good']);
  assert.equal(api.prefsGet('good'), 'ok');
});

test('prefs: remove drops a key and reports whether it existed', () => {
  const { api } = load({ now: 1 });
  api.prefsSet('server', { id: 'custom', url: 'https://x' }, 1);
  assert.equal(api.prefsRemove('server'), true);
  assert.equal(api.prefsGet('server'), undefined);
  assert.equal(api.prefsRemove('server'), false);
  assert.equal(api.prefsStamp('server'), 0);
});
