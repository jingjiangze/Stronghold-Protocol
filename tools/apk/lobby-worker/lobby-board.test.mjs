// lobby-board.test.mjs — node --test for the sp-lobby-board pure core (src/board.js) plus a thin
// adapter pass over src/index.js (Worker routing / CORS / DO dispatch with an in-memory storage).
//
// ZERO-EGRESS ASSERTION: globalThis.fetch is stubbed at load time; any outbound call increments the
// counter and throws. The final test and the `after` hook both require the counter to be 0.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBoard,
  CODE_RE,
  IP_RATE_MAX,
  IP_ROOMS_MAX,
  NOTE_MAX,
  TTL_SEC,
} from './src/board.js';
import worker, { Board } from './src/index.js';

// --------------------------------------------------------------------------------------------------
// harness
// --------------------------------------------------------------------------------------------------

let fetchCalls = 0;
globalThis.fetch = (...args) => {
  fetchCalls += 1;
  throw new Error(`outbound fetch attempted (must never happen): ${String(args[0])}`);
};
after(() => {
  assert.equal(fetchCalls, 0, `board core/adapter made ${fetchCalls} outbound fetch call(s)`);
});

const T0 = 1_751_000_000_000;
const IP_A = '203.0.113.9';
const IP_B = '203.0.113.10';

/** In-memory state adapter; structured-clones like Durable Object storage does. */
function memoryState() {
  const store = new Map();
  const clone = (value) => structuredClone(value);
  return {
    _store: store,
    async get(key) { return store.has(key) ? clone(store.get(key)) : undefined; },
    async put(key, value) { store.set(key, clone(value)); },
    async delete(key) { store.delete(key); },
    async list() {
      const out = new Map();
      for (const [key, value] of store) out.set(key, clone(value));
      return out;
    },
  };
}

function makeBoard(t0 = T0) {
  const state = memoryState();
  let clock = t0;
  const board = createBoard({ state, now: () => clock });
  return { state, board, set: (t) => { clock = t; } };
}

const addInput = (over = {}) => ({
  code: 'ABCD',
  serverId: 'srv-a',
  serverName: 'raiya服',
  note: 'hello',
  ip: IP_A,
  ...over,
});

const rmInput = (over = {}) => ({ code: 'ABCD', serverId: 'srv-a', token: '', ...over });

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // same as CODE_RE: no I, no O
const codeFor = (n) => ALPHABET[Math.floor(n / 26) % 26] + ALPHABET[n % 26] + 'ZZ';

const roomKeys = (state) => [...state._store.keys()].filter((key) => key.startsWith('room:'));

// --------------------------------------------------------------------------------------------------
// contract shape
// --------------------------------------------------------------------------------------------------

test('contract: rainya-compatible listing plus additive serverId/serverName', async () => {
  const { board } = makeBoard();
  const added = await board.add(addInput({ url: 'https://game.example.com:8443/?x=1' }), T0);
  assert.equal(added.ok, true);
  assert.match(added.token, /^[0-9a-f]{32}$/); // 128-bit hex
  assert.deepEqual(added.added, {
    code: 'ABCD',
    server: 'raiya服',
    serverId: 'srv-a',
    serverName: 'raiya服',
    note: 'hello',
    ageSec: 0,
    leftSec: TTL_SEC,
    url: 'https://game.example.com:8443/?x=1',
  });

  const out = await board.list(T0);
  assert.equal(out.ok, true);
  assert.equal(out.now, T0);
  assert.equal(out.ttlSec, 600);
  assert.equal(out.rooms.length, 1);
  const [room] = out.rooms;
  for (const key of ['code', 'server', 'note', 'ageSec', 'leftSec']) {
    assert.ok(key in room, `rainya field ${key} must be present`);
  }
  assert.equal(room.server, room.serverName); // rainya alias
  assert.equal('token' in room, false, 'token must never leak into listings');
  assert.equal('ip' in room, false, 'ip must never leak into listings');
  assert.equal('createdAt' in room, false, 'createdAt is internal');
});

test('contract: empty board and url-less rooms', async () => {
  const { board } = makeBoard();
  const empty = await board.list(T0);
  assert.deepEqual(empty, { ok: true, now: T0, ttlSec: 600, rooms: [] });

  const r1 = await board.add(addInput({ note: '' }), T0);
  assert.equal(r1.ok, true);
  assert.equal('url' in r1.added, false);
  const r2 = await board.add(addInput({ code: 'ABCE', url: '   ' }), T0 + 1000);
  assert.equal(r2.ok, true, 'blank url counts as absent');
  assert.equal('url' in r2.added, false);
});

// --------------------------------------------------------------------------------------------------
// TTL
// --------------------------------------------------------------------------------------------------

test('TTL: leftSec counts down, expired entries vanish and are pruned from state', async () => {
  const { board, state } = makeBoard();
  await board.add(addInput(), T0);

  const at1s = await board.list(T0 + 1_000);
  assert.equal(at1s.rooms[0].ageSec, 1);
  assert.equal(at1s.rooms[0].leftSec, 599);

  const at599s = await board.list(T0 + 599_000);
  assert.equal(at599s.rooms[0].ageSec, 599);
  assert.equal(at599s.rooms[0].leftSec, 1);

  const at600s = await board.list(T0 + 600_000);
  assert.deepEqual(at600s.rooms, []);
  assert.equal(await state.get('room:ABCD'), undefined, 'expired entry must be deleted');
  assert.deepEqual(roomKeys(state), []);

  const again = await board.add(addInput({ code: 'ABCE' }), T0 + 600_000);
  assert.equal(again.ok, true, 'expiry also lifts the code debounce');
});

// --------------------------------------------------------------------------------------------------
// field validation
// --------------------------------------------------------------------------------------------------

test('code: normalised to upper-case, strict [A-HJ-NP-Z]{4} enforced with nothing written', async () => {
  const { board } = makeBoard();
  const ok = await board.add(addInput({ code: ' abcd ' }), T0);
  assert.equal(ok.ok, true);
  assert.equal(ok.added.code, 'ABCD');

  for (const bad of ['ABCDE', 'ABC', 'AB1D', 'ABID', 'ABOD', 'ABC-', '', null, 42, {}]) {
    const fresh = makeBoard();
    const res = await fresh.board.add(addInput({ code: bad }), T0);
    assert.equal(res.ok, false, `code ${JSON.stringify(bad)} must be rejected`);
    assert.equal(res.error, 'BAD_CODE');
    assert.deepEqual(roomKeys(fresh.state), [], 'rejected submissions write nothing');
  }
  assert.equal(CODE_RE.test('ABID'), false);
});

test('serverId/serverName: required, control-char cleaned, length-capped', async () => {
  for (const bad of [
    { serverId: '' },
    { serverName: '' },
    { serverId: undefined },
    { serverName: undefined },
    { serverId: '\u0000\u0000' },
    { serverId: 'x'.repeat(65) },
    { serverName: 'x'.repeat(65) },
  ]) {
    const fresh = makeBoard();
    const res = await fresh.board.add(addInput(bad), T0);
    assert.equal(res.ok, false, `${JSON.stringify(bad)} must be rejected`);
    assert.equal(res.error, 'BAD_SERVER');
    assert.deepEqual(roomKeys(fresh.state), []);
  }
  const { board } = makeBoard();
  const ok = await board.add(addInput({ serverId: 'srv\u0007-b', serverName: ' raiya 服 ' }), T0);
  assert.equal(ok.ok, true);
  assert.equal(ok.added.serverId, 'srv-b');
  assert.equal(ok.added.serverName, 'raiya 服');
});

test('note: control chars stripped, trimmed, truncated to 40 code points', async () => {
  const { board } = makeBoard();
  const long = 'a\u0000b\u0007c\n\t' + 'x'.repeat(100);
  const res = await board.add(addInput({ note: long }), T0);
  assert.equal(res.ok, true);
  assert.equal(res.added.note, 'abc' + 'x'.repeat(NOTE_MAX - 3));
  assert.equal(Array.from(res.added.note).length, NOTE_MAX);

  const fresh = makeBoard();
  const emoji = await fresh.board.add(addInput({ note: '😀'.repeat(41) }), T0);
  assert.equal(emoji.ok, true);
  assert.equal(Array.from(emoji.added.note).length, 40, 'truncation is surrogate-pair safe');
  assert.equal(emoji.added.note, '😀'.repeat(40));
});

// --------------------------------------------------------------------------------------------------
// url validation (syntax only — never dialled)
// --------------------------------------------------------------------------------------------------

test('url: public http(s) accepted; loopback/private/userinfo/oversize reject the whole submit', async () => {
  for (const url of ['https://game.example.com/', 'http://game.example.com:8080/a?b=1', 'https://example.com']) {
    const fresh = makeBoard();
    const res = await fresh.board.add(addInput({ url }), T0);
    assert.equal(res.ok, true, `${url} should be accepted`);
    assert.equal(typeof res.added.url, 'string');
  }

  const bad = [
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://[::1]/',
    'http://0x7f000001/', // hex IPv4
    'http://0177.0.0.1/', // octal IPv4
    'http://127.1/', // short-form IPv4
    'http://2130706433/', // decimal integer IPv4
    'http://localhost/',
    'http://localhost./',
    'http://foo.localhost/',
    'http://x.local/',
    'http://x.internal/',
    'http://192.168.1.1/',
    'http://172.16.5.5/',
    'http://172.31.255.255/',
    'http://169.254.1.1/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::2]/',
    'http://user:pw@game.example.com/',
    'http://user@game.example.com/',
    'ftp://game.example.com/',
    'javascript:alert(1)',
    'not a url',
    'https://',
    'https://' + 'a'.repeat(600) + '.example.com/',
  ];
  for (const url of bad) {
    const fresh = makeBoard();
    const res = await fresh.board.add(addInput({ url }), T0);
    assert.equal(res.ok, false, `${url} must be rejected`);
    assert.equal(res.error, 'BAD_URL', `${url} must fail with BAD_URL`);
    const out = await fresh.board.list(T0);
    assert.deepEqual(out.rooms, [], `nothing may be written for ${url}`);
  }

  const base = 'https://game.example.com/';
  const maxUrl = base + 'a'.repeat(512 - base.length);
  assert.equal(maxUrl.length, 512);
  const atCap = makeBoard();
  assert.equal((await atCap.board.add(addInput({ url: maxUrl }), T0)).ok, true, '512 chars is allowed');
  const overCap = makeBoard();
  const over = await overCap.board.add(addInput({ url: maxUrl + 'a' }), T0);
  assert.equal(over.ok, false);
  assert.equal(over.error, 'BAD_URL');
  assert.deepEqual(overCap.state._store.size, 0, 'a bad url never writes any state');

  const nonString = makeBoard();
  const ns = await nonString.board.add(addInput({ url: 42 }), T0);
  assert.equal(ns.ok, false);
  assert.equal(ns.error, 'BAD_URL');
});

// --------------------------------------------------------------------------------------------------
// rate limits
// --------------------------------------------------------------------------------------------------

test(`rate limit: ${IP_RATE_MAX} submissions per IP per sliding minute`, async () => {
  const { board } = makeBoard();
  for (let i = 0; i < IP_RATE_MAX; i += 1) {
    const at = T0 + i * 1_000;
    const added = await board.add(addInput({ code: codeFor(i) }), at);
    assert.equal(added.ok, true, `add #${i + 1} should pass`);
    const removed = await board.remove({ code: codeFor(i), serverId: 'srv-a', token: added.token }, at);
    assert.equal(removed.ok, true); // removal keeps the IP count low: this test isolates the rate rule
  }
  const blocked = await board.add(addInput({ code: codeFor(IP_RATE_MAX) }), T0 + 10_000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'RATE_LIMITED');

  // window slides: once the oldest submission leaves the 60 s window a slot frees up
  const freed = await board.add(addInput({ code: codeFor(IP_RATE_MAX) }), T0 + 61_000);
  assert.equal(freed.ok, true, JSON.stringify(freed));
});

test('code debounce: same code within 30 s refused; after that it replaces (token rotates)', async () => {
  const { board } = makeBoard();
  const first = await board.add(addInput(), T0);
  assert.equal(first.ok, true);

  const dupe = await board.add(addInput({ serverId: 'srv-b', serverName: 'second' }), T0 + 29_000);
  assert.equal(dupe.ok, false);
  assert.equal(dupe.error, 'DEBOUNCED');

  const replaced = await board.add(addInput({ serverId: 'srv-b', serverName: 'second' }), T0 + 30_000);
  assert.equal(replaced.ok, true);
  assert.notEqual(replaced.token, first.token);
  const rooms = await board.list(T0 + 30_000);
  assert.equal(rooms.rooms.length, 1, 'no duplicate codes');
  assert.equal(rooms.rooms[0].serverId, 'srv-b');

  const stale = await board.remove({ code: 'ABCD', serverId: 'srv-a', token: first.token }, T0 + 30_000);
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'FORBIDDEN');
  const live = await board.remove({ code: 'ABCD', serverId: 'srv-b', token: replaced.token }, T0 + 31_000);
  assert.equal(live.ok, true);
});

test(`per-IP cap: at most ${IP_ROOMS_MAX} live rooms, the 6th is LIMIT_REACHED`, async () => {
  const { board } = makeBoard();
  for (let i = 0; i < IP_ROOMS_MAX; i += 1) {
    const res = await board.add(addInput({ code: codeFor(i), ip: IP_B }), T0 + i * 1_000);
    assert.equal(res.ok, true, `room #${i + 1} should pass`);
  }
  const sixth = await board.add(addInput({ code: codeFor(IP_ROOMS_MAX), ip: IP_B }), T0 + 5_000);
  assert.equal(sixth.ok, false);
  assert.equal(sixth.error, 'LIMIT_REACHED');

  const otherIp = await board.add(addInput({ code: codeFor(IP_ROOMS_MAX), ip: '203.0.113.11' }), T0 + 5_000);
  assert.equal(otherIp.ok, true, 'the cap is per IP');

  // entries expire after TTL, freeing the slot again
  const afterExpiry = await board.add(addInput({ code: codeFor(IP_ROOMS_MAX + 1), ip: IP_B }), T0 + 600_000);
  assert.equal(afterExpiry.ok, true);
});

// --------------------------------------------------------------------------------------------------
// removal / token
// --------------------------------------------------------------------------------------------------

test('remove: correct token+serverId only; FORBIDDEN on mismatch; NOT_FOUND when absent/expired', async () => {
  const { board, state } = makeBoard();
  const added = await board.add(addInput(), T0);

  const wrongToken = await board.remove(rmInput({ token: 'f'.repeat(32) }), T0);
  assert.equal(wrongToken.ok, false);
  assert.equal(wrongToken.error, 'FORBIDDEN');
  const noToken = await board.remove(rmInput({ token: '' }), T0);
  assert.equal(noToken.ok, false);
  assert.equal(noToken.error, 'FORBIDDEN');
  const wrongServer = await board.remove(rmInput({ serverId: 'srv-b', token: added.token }), T0);
  assert.equal(wrongServer.ok, false);
  assert.equal(wrongServer.error, 'FORBIDDEN');
  assert.equal((await board.list(T0)).rooms.length, 1, 'failed removals change nothing');

  const unknown = await board.remove(rmInput({ code: 'ZZZZ', token: added.token }), T0);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'NOT_FOUND');

  const ok = await board.remove(rmInput({ token: added.token }), T0 + 1_000);
  assert.deepEqual(ok, { ok: true, removed: { code: 'ABCD', serverId: 'srv-a' } });
  assert.equal(state._store.has('room:ABCD'), false);
  assert.deepEqual((await board.list(T0 + 1_000)).rooms, []);
  const twice = await board.remove(rmInput({ token: added.token }), T0 + 1_000);
  assert.equal(twice.ok, false);
  assert.equal(twice.error, 'NOT_FOUND');

  const expired = makeBoard();
  const exp = await expired.board.add(addInput(), T0);
  const late = await expired.board.remove(rmInput({ token: exp.token }), T0 + 600_000);
  assert.equal(late.ok, false);
  assert.equal(late.error, 'NOT_FOUND');
  assert.deepEqual(roomKeys(expired.state), []);
});

// --------------------------------------------------------------------------------------------------
// adapter (src/index.js): routing, CORS, status mapping, DO dispatch
// --------------------------------------------------------------------------------------------------

function fakeEnv() {
  const storage = memoryState();
  const instance = new Board({ storage }, {});
  return {
    storage,
    env: { BOARD: { idFromName: (name) => `id:${name}`, get: () => ({ fetch: (req) => instance.fetch(req) }) } },
  };
}

async function callWorker(env, path, { method = 'GET', body, token, ip, rawBody } = {}) {
  const headers = new Headers();
  if (ip) headers.set('CF-Connecting-IP', ip);
  if (token) headers.set('X-Token', token);
  if (body !== undefined || rawBody !== undefined) headers.set('content-type', 'application/json');
  const req = new Request(`https://board.example.test${path}`, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await worker.fetch(req, env);
  const text = await res.text();
  return { res, status: res.status, body: text ? JSON.parse(text) : null };
}

test('adapter: /api/health and CORS headers on every response', async () => {
  const health = await callWorker({}, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(typeof health.body.now, 'number');
  for (const [name, value] of [
    ['access-control-allow-origin', '*'],
    ['cache-control', 'no-store'],
  ]) {
    assert.equal(health.res.headers.get(name), value, `health must carry ${name}`);
  }

  const preflight = await callWorker({}, '/api/rooms', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.res.headers.get('access-control-allow-origin'), '*');
  assert.equal(preflight.res.headers.get('access-control-allow-methods'), 'GET,POST,DELETE,OPTIONS');
  assert.equal(preflight.res.headers.get('access-control-allow-headers'), 'Content-Type,X-Token');
  assert.equal(preflight.res.headers.get('cache-control'), 'no-store');

  const missing = await callWorker({}, '/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.res.headers.get('access-control-allow-origin'), '*');

  const method = await callWorker({}, '/api/rooms', { method: 'PUT' });
  assert.equal(method.status, 405);
  assert.equal(method.body.error, 'METHOD_NOT_ALLOWED');
});

test('adapter: POST/GET/DELETE round-trip through the Durable Object + status mapping', async () => {
  const { env, storage } = fakeEnv();

  const created = await callWorker(env, '/api/rooms', {
    method: 'POST',
    ip: '203.0.113.50',
    body: { code: 'wxyz', serverId: 's1', serverName: 'raiya服', note: 'join us', url: 'https://game.example.com/' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.ok, true);
  assert.match(created.body.token, /^[0-9a-f]{32}$/);
  assert.equal(created.body.added.code, 'WXYZ');

  const listed = await callWorker(env, '/api/rooms');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.ttlSec, 600);
  assert.equal(listed.body.rooms.length, 1);
  assert.equal(listed.body.rooms[0].server, 'raiya服');

  const badToken = await callWorker(env, '/api/rooms?code=WXYZ&serverId=s1', { method: 'DELETE', token: 'bad' });
  assert.equal(badToken.status, 403);
  assert.equal(badToken.body.error, 'FORBIDDEN');

  const missingRoom = await callWorker(env, '/api/rooms?code=ZZZZ&serverId=s1', { method: 'DELETE', token: 'x' });
  assert.equal(missingRoom.status, 404);
  assert.equal(missingRoom.body.error, 'NOT_FOUND');

  const deleted = await callWorker(env, '/api/rooms?code=WXYZ&serverId=s1', { method: 'DELETE', token: created.body.token });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { ok: true, removed: { code: 'WXYZ', serverId: 's1' } });
  assert.deepEqual(roomKeys(storage), []);

  const badJson = await callWorker(env, '/api/rooms', { method: 'POST', rawBody: '{not json' });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error, 'BAD_JSON');

  const badUrl = await callWorker(env, '/api/rooms', {
    method: 'POST',
    ip: '203.0.113.50',
    body: { code: 'WXYZ', serverId: 's1', serverName: 'x', url: 'http://127.0.0.1/' },
  });
  assert.equal(badUrl.status, 400);
  assert.equal(badUrl.body.error, 'BAD_URL');

  // per-IP cap maps to 429 through the adapter
  for (let i = 0; i < IP_ROOMS_MAX; i += 1) {
    const res = await callWorker(env, '/api/rooms', {
      method: 'POST',
      ip: '203.0.113.60',
      body: { code: codeFor(i), serverId: 's1', serverName: 'x' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  const capped = await callWorker(env, '/api/rooms', {
    method: 'POST',
    ip: '203.0.113.60',
    body: { code: codeFor(IP_ROOMS_MAX), serverId: 's1', serverName: 'x' },
  });
  assert.equal(capped.status, 429);
  assert.equal(capped.body.error, 'LIMIT_REACHED');
});

// --------------------------------------------------------------------------------------------------
// zero-egress (also enforced by the `after` hook above)
// --------------------------------------------------------------------------------------------------

test('zero egress: no fetch happened across the whole suite', () => {
  assert.equal(fetchCalls, 0);
});
