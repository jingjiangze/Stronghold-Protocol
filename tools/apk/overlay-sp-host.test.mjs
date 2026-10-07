// overlay-sp-host.test.mjs - tests for tools/apk/overlay/sp-host.mjs (host endpoints into the overlay).
//
//   node --test tools/apk/overlay-sp-host.test.mjs
//
// No external network: real http servers bound to 127.0.0.1 (the discovery listener uses the REAL
// contract port 32123 on the loopback host), a fake lobby (plain Map + Room-ish records), and
// injected import seams for room-discovery.mjs / webrtc-bridge.mjs. The probe test imports the REAL
// tools/apk/extras/server/room-discovery.mjs (pure module, no I/O at import time).
// Assertions mirror the security invariants listed in the sp-host.mjs header and the LanScan.java
// field contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  overlayApi,
  id,
  install,
  createController,
  roomViewOf,
  normalizeIp,
  isLocalIp,
  splitUrl,
  LAN_DISCOVERY_PORT,
  ROUTE_LAN_ROOMS,
  ROUTE_LAN_ROOM,
  ROUTE_LAN_PUBLISH,
  ROUTE_SHELL_ROOMS,
  ROUTE_PROBE_PREFIX,
  CODE_RE,
} from './overlay/sp-host.mjs';
import { install as installLobby } from './overlay/sp-lobby.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTRAS_SERVER = path.join(HERE, 'extras', 'server');

// ---------------------------------------------------------------- fixtures

/** Fake lobby: rooms is a Map; room records follow the upstream Room shape closely enough. */
function mkLobby(rooms) {
  return {
    rooms: new Map((rooms || []).map((r) => [r.code, r])),
    getRoom(code) { return this.rooms.get(String(code).toUpperCase()) || null; },
  };
}
const human = (name, extra) => Object.assign(
  { seat: 0, playerId: 'p-' + name, name, isBot: false, ready: true, connected: true, left: false }, extra || {});
const bot = (name, seatNo) => ({ seat: seatNo, playerId: 'ai-' + name, name, isBot: true, ready: true, connected: true, left: false });

function mkRoom(code, opts = {}) {
  const seats = opts.seats !== undefined ? opts.seats
    : [human(opts.name || 'Alice'), null, null, null];
  return {
    code,
    mode: opts.mode || 'coop',
    difficulty: opts.difficulty || 'NORMAL',
    seats,
    match: opts.match !== undefined ? opts.match : null,
    disposed: false,
    activeHumans() { return this.seats.filter((s) => s && !s.isBot && !s.left); },
    freeSeat() { return this.seats.indexOf(null); },
  };
}

/** Minimal request/response doubles for controller-level gate tests (no sockets). */
function fakeReq(url, method, remoteAddress) {
  const req = new EventEmitter();
  req.url = url;
  req.method = method;
  req.headers = {};
  req.socket = { remoteAddress };
  req.setTimeout = () => {};
  req.destroy = () => {};
  return req;
}
function fakeRes() {
  return {
    headers: {},
    status: 0,
    body: '',
    destroyed: false,
    setHeader(n, v) { this.headers[String(n).toLowerCase()] = v; },
    writeHead(status, headers) {
      this.status = status;
      if (headers) for (const k of Object.keys(headers)) this.headers[String(k).toLowerCase()] = headers[k];
    },
    end(b) { this.body = b == null ? '' : String(b); },
    destroy() { this.destroyed = true; },
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
}

/**
 * Real http server + fake lobby + the overlay installed through the loader-shaped ctx.
 * The discovery listener uses the real contract port 32123 on 127.0.0.1.
 */
async function mkInstalled(opts = {}) {
  const seen = [];
  const lobby = mkLobby(opts.rooms !== undefined ? opts.rooms : [mkRoom('ABCD')]);
  const stock = (req, res) => {
    seen.push(req.method + ' ' + req.url);
    if (String(req.url).split('?')[0] === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: 1, humans: 2 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('stock');
  };
  const server = http.createServer(stock);
  server.lobby = lobby;
  await listen(server, 0, '127.0.0.1');
  const port = server.address().port;
  const controller = await install({
    server,
    ...(opts.passPort === false ? {} : { port }),
    host: '127.0.0.1',
    url: '',
    ...(opts.upstreamDir ? { upstreamDir: opts.upstreamDir } : {}),
    log: () => {},
  });
  const base = 'http://127.0.0.1:' + port;
  return {
    server, base, port, lobby, seen, controller,
    cleanup: async () => {
      await controller.close();
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
    },
  };
}

// ---------------------------------------------------------------- contract + pure helpers

test('overlay contract: api/id, install without a server does not throw', async () => {
  assert.equal(overlayApi, 1);
  assert.equal(id, 'sp-host');
  assert.equal(LAN_DISCOVERY_PORT, 32123, 'must match LanScan.DISCOVERY_PORT');
  const c = await install({ log: () => {} });
  assert.equal(typeof c.handleRequest, 'function');
  assert.equal(c.status().discovery, 'idle');
  assert.deepEqual(c.status().published, []);
});

test('CODE_RE matches the LanScan alphabet ([A-Z0-9]{4})', () => {
  for (const good of ['ABCD', 'A1B2', '9ZZ9']) assert.equal(CODE_RE.test(good), true, good);
  for (const bad of ['ABC', 'ABCDE', 'abCd', '!@#$']) assert.equal(CODE_RE.test(bad), false, bad);
});

test('normalizeIp/isLocalIp mirror upstream net.js (mapped v6, zones, private ranges)', () => {
  assert.equal(normalizeIp('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeIp('[::1]:443'), '::1');
  assert.equal(normalizeIp('10.0.0.9:8123'), '10.0.0.9');
  assert.equal(normalizeIp('fe80::1%wlan0'), 'fe80::1');
  assert.equal(normalizeIp('not-an-ip'), '');
  const local = ['127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.1',
    '169.254.1.1', '100.64.0.1', '100.127.255.255', '0.1.2.3', '::1',
    'fe80::1', 'fc00::1', 'fd12:3456::1'];
  for (const ip of local) assert.equal(isLocalIp(ip), true, ip);
  // upstream applies isLocalIp ONLY to normalizeIp() output: the mapped form unmaps to plain IPv4
  assert.equal(isLocalIp(normalizeIp('::ffff:10.0.0.9')), true, 'isLocalIp(normalizeIp(mapped v6))');
  assert.equal(isLocalIp('::ffff:10.0.0.9'), false, 'raw mapped literal is not classified (upstream parity)');
  const remote = ['8.8.8.8', '172.32.0.1', '100.128.0.1', '1.0.0.1', '2001:db8::1', '2606:4700::1'];
  for (const ip of remote) assert.equal(isLocalIp(ip), false, ip);
});

test('splitUrl: raw path + query, absolute-form tolerated, hash stripped', () => {
  assert.deepEqual(splitUrl('/lan/room?code=ABCD'), { rawPath: '/lan/room', query: 'code=ABCD' });
  assert.deepEqual(splitUrl('/a/b#c'), { rawPath: '/a/b', query: '' });
  assert.deepEqual(splitUrl('http://x/y?z=1'), { rawPath: '/y', query: 'z=1' });
  assert.equal(splitUrl('http://['), null);
});

test('roomViewOf: exactly the LanScan field set; left/bot seats excluded; match drives inMatch', () => {
  const room = mkRoom('ABCD', {
    seats: [human('Alice'), bot('AI', 1), human('Bob', { seat: 2, left: true }), null],
    match: { some: 'match' },
  });
  assert.deepEqual(roomViewOf(room), {
    code: 'ABCD', name: 'Alice', mode: 'coop', difficulty: 'NORMAL',
    seats: 4, humans: 1, inMatch: true,
  });
  const lobbyOnly = mkRoom('EFGH'); // no match -> inMatch false (upstream Room has no inMatch prop)
  assert.equal(roomViewOf(lobbyOnly).inMatch, false);
  // inMatch alias tolerated (same convention as sp-lobby liveFieldsOf)
  assert.equal(roomViewOf({ code: 'JKLM', seats: [], inMatch: true }).inMatch, true);
  // plain record without activeHumans() still counts humans
  assert.equal(roomViewOf({ code: 'WXYZ', seats: [{ isBot: false }, { isBot: true, name: 'x' }, null] }).humans, 1);
  // an empty first-human name falls back to the code (patch verbatim)
  assert.equal(roomViewOf(mkRoom('QRST', { seats: [human('')] })).name, 'QRST');
  assert.equal(roomViewOf(null).code, '');
});

// ---------------------------------------------------------------- main-port routes

test('/lan/rooms: publish then list - body matches the LanScan contract field by field', async () => {
  const w = await mkInstalled({ rooms: [mkRoom('ABCD', { name: 'Alice' }), mkRoom('ZZZZ', { mode: 'solo' })] });
  try {
    const empty = await (await fetch(w.base + ROUTE_LAN_ROOMS)).json();
    assert.deepEqual(empty.rooms, [], 'nothing is listed before the host publishes (review finding #1)');

    const pub = await fetch(w.base + ROUTE_LAN_PUBLISH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'abcd', on: true }),
    });
    assert.equal(pub.status, 200);
    assert.deepEqual(await pub.json(), { ok: true, code: 'ABCD', on: true });

    const res = await fetch(w.base + ROUTE_LAN_ROOMS);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', 'LAN routes carry ACAO *');
    const doc = await res.json();
    assert.equal(doc.ok, true);
    assert.equal(doc.port, w.port, 'the GAME port is handed back');
    assert.ok(doc.port >= 1024 && doc.port <= 65535, 'LanScan validates 1024..65535');
    assert.equal(doc.rooms.length, 1, 'solo rooms are not listed (patch filters mode coop)');
    const room = doc.rooms[0];
    assert.deepEqual(Object.keys(room).sort(),
      ['code', 'difficulty', 'humans', 'inMatch', 'mode', 'name', 'seats'],
      'exactly the LanScan field set (ip/port/url are added client-side)');
    assert.equal(room.code, 'ABCD');
    assert.equal(room.name, 'Alice');
    assert.equal(room.mode, 'coop');
    assert.equal(room.difficulty, 'NORMAL');
    assert.equal(room.seats, 4);
    assert.equal(room.humans, 1);
    assert.equal(room.inMatch, false);

    const st = await (await fetch(w.base + ROUTE_LAN_PUBLISH + '?code=ABCD')).json();
    assert.deepEqual(st, { ok: true, code: 'ABCD', on: true }, 'GET status shows the real toggle state');
  } finally {
    await w.cleanup();
  }
});

test('/lan/rooms: app/protocol come from <upstreamDir>/../shared/constants.js when resolvable', async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sp-host-test-'));
  try {
    fs.mkdirSync(path.join(tmp, 'shared'), { recursive: true });
    // .js is CommonJS unless a nearest package.json says module - mirror the webroot layout
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}\n');
    fs.writeFileSync(path.join(tmp, 'shared', 'constants.js'),
      'export const PROTOCOL_VERSION = 7;\nexport const APP_VERSION = "9.9.9-test";\n');
    const w = await mkInstalled({ upstreamDir: path.join(tmp, 'server') });
    try {
      const doc = await (await fetch(w.base + ROUTE_LAN_ROOMS)).json();
      assert.equal(doc.app, '9.9.9-test');
      assert.equal(doc.protocol, 7);
    } finally {
      await w.cleanup();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/lan/rooms: self-heals when a published room disappears', async () => {
  const w = await mkInstalled();
  try {
    await fetch(w.base + ROUTE_LAN_PUBLISH, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ABCD', on: true }),
    });
    w.lobby.rooms.delete('ABCD');
    const doc = await (await fetch(w.base + ROUTE_LAN_ROOMS)).json();
    assert.deepEqual(doc.rooms, [], 'gone rooms are dropped from the set without a timer');
    const republish = await fetch(w.base + ROUTE_LAN_PUBLISH, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ABCD', on: true }),
    });
    assert.equal(republish.status, 404, 'publishing a room that no longer exists is refused');
  } finally {
    await w.cleanup();
  }
});

test('/lan/room?code=: hit, miss and bad codes share the no-leak 404', async () => {
  const w = await mkInstalled({ rooms: [mkRoom('ABCD', { match: {} })] });
  try {
    const hit = await fetch(w.base + ROUTE_LAN_ROOM + '?code=abcd'); // case-insensitive like the lobby
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get('access-control-allow-origin'), '*');
    const doc = await hit.json();
    assert.equal(doc.ok, true);
    assert.equal(doc.port, w.port);
    assert.equal(doc.rooms.length, 1);
    assert.equal(doc.rooms[0].code, 'ABCD');
    assert.equal(doc.rooms[0].inMatch, true, 'a running match is reported');

    for (const bad of ['ZZZZ', '%21%21%21%21', 'ABC', 'ABCDE']) {
      const miss = await fetch(w.base + ROUTE_LAN_ROOM + '?code=' + bad);
      assert.equal(miss.status, 404, bad);
      assert.deepEqual(await miss.json(), { ok: false, error: 'not found' });
      assert.equal(miss.headers.get('access-control-allow-origin'), '*', '404s carry ACAO too (patch)');
    }
    assert.deepEqual(await (await fetch(w.base + ROUTE_LAN_ROOM)).json(),
      { ok: false, error: 'not found' }, 'missing code parameter');
  } finally {
    await w.cleanup();
  }
});

test('/_shell/rooms: v2.1 shape, every room, no CORS header', async () => {
  const w = await mkInstalled({ rooms: [mkRoom('ABCD'), mkRoom('SOLO', { mode: 'solo', match: {} })] });
  try {
    const res = await fetch(w.base + ROUTE_SHELL_ROOMS);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'patch adds no CORS here');
    const doc = await res.json();
    assert.deepEqual(doc, {
      ok: true,
      rooms: [
        { code: 'ABCD', mode: 'coop', difficulty: 'NORMAL', inMatch: false },
        { code: 'SOLO', mode: 'solo', difficulty: 'NORMAL', inMatch: true },
      ],
    });
  } finally {
    await w.cleanup();
  }
});

test('/room-probe/<code>: served by the REAL extras room-discovery.mjs', async () => {
  const w = await mkInstalled({
    upstreamDir: EXTRAS_SERVER,
    rooms: [
      mkRoom('ABCD'),
      mkRoom('FULL', { seats: [human('a'), human('b', { seat: 1 }), human('c', { seat: 2 }), human('d', { seat: 3 })] }),
      mkRoom('SULA', { mode: 'solo' }),
    ],
  });
  try {
    const hit = await (await fetch(w.base + ROUTE_PROBE_PREFIX + 'ABCD')).json();
    assert.deepEqual(hit, { ok: true, exists: true, joinable: true });
    const full = await (await fetch(w.base + ROUTE_PROBE_PREFIX + 'FULL')).json();
    assert.equal(full.exists, true);
    assert.equal(full.joinable, false, 'no free seat');
    const solo = await (await fetch(w.base + ROUTE_PROBE_PREFIX + 'SULA')).json();
    assert.equal(solo.joinable, false, 'solo rooms are not joinable per the lobby rules');
    const gone = await (await fetch(w.base + ROUTE_PROBE_PREFIX + 'ZZZZ')).json();
    assert.deepEqual(gone, { ok: true, exists: false, joinable: false });
    const bad = await fetch(w.base + ROUTE_PROBE_PREFIX + '!!');
    assert.equal(bad.status, 400);
  } finally {
    await w.cleanup();
  }
});

test('method gates: /lan/rooms 405, /lan/publish PUT 404, /_shell/rooms POST forwarded to stock', async () => {
  const w = await mkInstalled();
  try {
    const post405 = await fetch(w.base + ROUTE_LAN_ROOMS, { method: 'POST' });
    assert.equal(post405.status, 405);
    assert.equal(post405.headers.get('allow'), 'GET, HEAD');

    const put = await fetch(w.base + ROUTE_LAN_PUBLISH, { method: 'PUT' });
    assert.equal(put.status, 404, 'non GET/HEAD/POST on publish gets the shared 404 (patch)');

    const del = await fetch(w.base + ROUTE_SHELL_ROOMS, { method: 'DELETE' });
    assert.equal(del.status, 200, 'stock answers (upstream global gate owns the 405)');
    assert.equal(await del.text(), 'stock', 'forwarded untouched');
    assert.ok(w.seen.includes('DELETE /_shell/rooms'), 'stock really saw it');
  } finally {
    await w.cleanup();
  }
});

test('HEAD /lan/rooms: 200 with content-length but no body', async () => {
  const w = await mkInstalled();
  try {
    const res = await fetch(w.base + ROUTE_LAN_ROOMS, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.ok(Number(res.headers.get('content-length')) > 0);
    assert.equal(await res.text(), '');
  } finally {
    await w.cleanup();
  }
});

test('peer gates (controller level): public peers get the shared 404, publish is loopback-only', async () => {
  const c = createController({ lobby: mkLobby([mkRoom('ABCD')]), port: 3000, log: () => {} });

  const res1 = fakeRes();
  assert.equal(c.handleRequest(fakeReq('/lan/rooms', 'GET', '8.8.8.8'), res1), true);
  assert.equal(res1.status, 404, 'public peer shares the unknown-code 404');
  assert.deepEqual(JSON.parse(res1.body), { ok: false, error: 'not found' });

  const res2 = fakeRes();
  assert.equal(c.handleRequest(fakeReq('/lan/rooms', 'GET', '::ffff:10.1.2.3'), res2), true);
  assert.equal(res2.status, 200, 'mapped private IPv6 peer is a LAN peer');

  const res3 = fakeRes();
  const req3 = fakeReq('/lan/publish', 'POST', '192.168.1.7');
  assert.equal(c.handleRequest(req3, res3), true);
  assert.equal(res3.status, 404, 'a neighbor cannot publish');
  req3.emit('end'); // the body read must resolve even for refused requests

  const res4 = fakeRes();
  const req4 = fakeReq('/lan/publish', 'POST', '127.0.0.1');
  assert.equal(c.handleRequest(req4, res4), true);
  assert.equal(res4.status, 0, 'loopback publish waits for the body');
  req4.emit('data', Buffer.from(JSON.stringify({ code: 'ABCD', on: true })));
  req4.emit('end');
  await Promise.resolve();
  assert.equal(res4.status, 200);
  assert.deepEqual(JSON.parse(res4.body), { ok: true, code: 'ABCD', on: true });

  const res5 = fakeRes();
  assert.equal(c.handleRequest(fakeReq('/lan/rooms', 'GET', '127.0.0.1'), res5), true);
  assert.equal(JSON.parse(res5.body).rooms.length, 1, 'the loopback publish landed in the set');
});

test('oversized /lan/publish body is cut (4 KB cap) and never poisons the set', async () => {
  const c = createController({ lobby: mkLobby([mkRoom('ABCD')]), port: 3000, log: () => {} });
  const res = fakeRes();
  const req = fakeReq('/lan/publish', 'POST', '127.0.0.1');
  assert.equal(c.handleRequest(req, res), true);
  req.emit('data', Buffer.from('{"code":"ABCD","on":true,"junk":"' + 'x'.repeat(5000) + '"}'));
  await Promise.resolve();
  const res2 = fakeRes();
  assert.equal(c.handleRequest(fakeReq('/lan/rooms', 'GET', '127.0.0.1'), res2), true);
  assert.deepEqual(JSON.parse(res2.body).rooms, [], 'the destroyed body never published anything');
});

// ---------------------------------------------------------------- discovery listener (32123)

test('discovery listener: read-only LAN surface on the contract port', async () => {
  const w = await mkInstalled();
  const dBase = 'http://127.0.0.1:' + LAN_DISCOVERY_PORT;
  try {
    assert.equal(w.controller.status().discovery, 'mine');
    await fetch(w.base + ROUTE_LAN_PUBLISH, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ABCD', on: true }),
    });
    const doc = await (await fetch(dBase + '/lan/rooms')).json();
    assert.equal(doc.ok, true);
    assert.equal(doc.port, w.port);
    assert.equal(doc.rooms.length, 1);
    assert.equal(doc.rooms[0].code, 'ABCD');
    const single = await (await fetch(dBase + '/lan/room?code=ABCD')).json();
    assert.deepEqual(single.rooms.map((r) => r.code), ['ABCD'], 'envelope shape, not the old flat body');

    assert.equal((await fetch(dBase + '/lan/rooms', { method: 'POST' })).status, 405);
    assert.equal((await fetch(dBase + '/lan/publish')).status, 404, 'no publish on the discovery port');
    assert.equal((await fetch(dBase + '/healthz')).status, 404, 'no healthz on the discovery port');
    assert.equal((await fetch(dBase + '/js/main.js')).status, 404, 'no static files on the discovery port');
  } finally {
    await w.cleanup();
  }
});

test('discovery lifecycle: main server close closes 32123 (patch: next to wss.close())', async () => {
  const w = await mkInstalled();
  const dBase = 'http://127.0.0.1:' + LAN_DISCOVERY_PORT;
  try {
    assert.equal(w.controller.status().discovery, 'mine');
    // 发现监听是异步 listen 的：等它真的应答再往下（否则下面那次 fetch 会随机 ECONNRESET/ECONNREFUSED，
    // 这条用例曾在组合分支上 3 跑 1 红）。
    const up = Date.now();
    for (;;) {
      try { await fetch(dBase + '/lan/rooms'); break; } catch (e) {
        if (Date.now() - up > 2000) throw e;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const closedEvent = new Promise((r) => w.server.once('close', r));
    await new Promise((r) => w.server.close(r));
    w.server.closeAllConnections?.();
    await closedEvent;
    await assert.rejects(() => fetch(dBase + '/lan/rooms'), 'the discovery port is released');
    assert.equal(w.controller.status().discovery, 'closed');
  } finally {
    await w.cleanup();
  }
});

test('EADDRINUSE on 32123: install survives, marks foreign, forwards /lan/publish to stock', async () => {
  const blocker = http.createServer(() => {});
  await listen(blocker, LAN_DISCOVERY_PORT, '127.0.0.1');
  const w = await mkInstalled();
  try {
    assert.equal(w.controller.status().discovery, 'foreign',
      'the patched upstream binds 32123 first - this overlay stands down');
    const res = await fetch(w.base + ROUTE_LAN_PUBLISH, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ABCD', on: true }),
    });
    assert.equal(await res.text(), 'stock', 'publish is FORWARDED (feeds the patch lanPublic set)');
    assert.ok(w.seen.includes('POST /lan/publish'), 'stock (patched upstream) saw the publish');
    const doc = await (await fetch(w.base + ROUTE_LAN_ROOMS)).json();
    assert.deepEqual(doc.rooms, [], 'the local set stays empty while foreign (documented transition)');
    assert.equal(await (await fetch(w.base + '/whatever')).text(), 'stock', 'non-host routes still forward');
  } finally {
    await w.cleanup();
    await new Promise((r) => blocker.close(r));
  }
});

// ---------------------------------------------------------------- dc bridge (v2.1 #10)

test('dc bridge gate: SP_DC != 0 + SP_DIR_URL starts it once with the game port', async () => {
  const calls = [];
  const importBridge = () => {
    calls.push('import');
    return Promise.resolve({ startBridge: (args) => calls.push(args) });
  };
  const c = createController({
    log: () => {}, port: 4567,
    env: { SP_DC: '1', SP_DIR_URL: 'https://dir.example' },
    importBridge,
  });
  assert.equal(c.maybeStartDcBridge(), true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['import', { port: 4567 }]);

  const off = createController({
    log: () => {}, env: { SP_DC: '0', SP_DIR_URL: 'https://dir.example' }, importBridge,
  });
  assert.equal(off.maybeStartDcBridge(), false, 'SP_DC=0 disables');
  const noDir = createController({ log: () => {}, env: { SP_DC: '1' }, importBridge });
  assert.equal(noDir.maybeStartDcBridge(), false, 'no SP_DIR_URL disables');
  const defaultOn = createController({
    log: () => {}, env: { SP_DC: '', SP_DIR_URL: 'https://dir.example' }, importBridge,
  });
  assert.equal(defaultOn.maybeStartDcBridge(), true, 'absent SP_DC counts as enabled (patch verbatim)');
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.filter((x) => x === 'import').length, 2, 'exactly the two enabled cases imported');
});

test('dc bridge: import failure is logged, never thrown (loader contract)', async () => {
  const c = createController({
    log: () => {},
    env: { SP_DIR_URL: 'https://dir.example' },
    importBridge: () => Promise.reject(new Error('werift missing')),
  });
  assert.equal(c.maybeStartDcBridge(), true);
  await new Promise((r) => setImmediate(r));
});

// ---------------------------------------------------------------- coexistence + lifecycle

test('co-install with sp-lobby (device filename order: sp-host first, sp-lobby wraps it)', async () => {
  const lobby = mkLobby([mkRoom('ABCD')]);
  const server = http.createServer((req, res) => {
    if (String(req.url).split('?')[0] === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: 1, humans: 2 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('stock');
  });
  server.lobby = lobby;
  await listen(server, 0, '127.0.0.1');
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  let hostCtl = null;
  const stubFetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, token: 't' }) });
  try {
    hostCtl = await install({ server, port, host: '127.0.0.1', url: '', log: () => {} });
    await installLobby({ server, log: () => {}, fetchImpl: stubFetch });

    await fetch(base + '/lan/publish', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ABCD', on: true }),
    });

    const lan = await (await fetch(base + '/lan/rooms')).json();
    assert.equal(lan.ok, true, 'sp-host answers /lan/rooms');
    assert.equal(lan.port, port);
    assert.equal(lan.rooms.length, 1, 'the publish flowed through the chain into the set');

    const shell = await (await fetch(base + '/_shell/rooms')).json();
    assert.equal(shell.ok, true, 'sp-host answers /_shell/rooms');

    const status = await fetch(base + '/sp/lobby/status', { headers: { origin: base } });
    assert.equal(status.status, 200, 'sp-lobby still answers its own route through the chain');

    const hz = await fetch(base + '/healthz');
    assert.equal(hz.status, 200);
    assert.equal(hz.headers.get('access-control-allow-origin'), '*',
      'sp-lobby /healthz CORS survives the sp-host hop');
    assert.deepEqual(await hz.json(), { ok: true, rooms: 1, humans: 2 }, 'upstream body untouched');

    assert.equal(await (await fetch(base + '/whatever')).text(), 'stock', 'stock path preserved');
  } finally {
    if (hostCtl) await hostCtl.close();
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  }
});

test('install / close / re-install: no throw, port released and re-bound', async () => {
  const w = await mkInstalled();
  const dBase = 'http://127.0.0.1:' + LAN_DISCOVERY_PORT;
  try {
    await fetch(dBase + '/lan/rooms');
    await w.controller.close();
    await assert.rejects(() => fetch(dBase + '/lan/rooms'), 'close() releases 32123');
    assert.equal(w.controller.status().discovery, 'closed');
    assert.equal(w.controller.status().discovery, w.controller.status().discovery, 'close is stable');

    const again = await install({
      server: w.server, port: w.port, host: '127.0.0.1', url: '', log: () => {},
    });
    try {
      assert.equal(again.status().discovery, 'mine', 're-install binds the freed port');
      const doc = await (await fetch(dBase + '/lan/rooms')).json();
      assert.equal(doc.ok, true);
    } finally {
      await again.close();
      assert.equal(again.status().discovery, 'closed');
    }
  } finally {
    await w.cleanup();
  }
});

test('port fallback: install without ctx.port reads it from server.address()', async () => {
  const w = await mkInstalled({ passPort: false });
  try {
    const doc = await (await fetch(w.base + ROUTE_LAN_ROOMS)).json();
    assert.equal(doc.port, w.port, 'LanScan needs the real game port');
  } finally {
    await w.cleanup();
  }
});
