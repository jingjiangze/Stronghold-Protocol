// test/ws-compression.test.js — the opt-in transport compression (server/wsCompression.js).
// What matters: off by default, the bounds are the measured ones, only the repetitive battle traffic is asked to
// compress, and a real server that is started with it on really offers the extension.
// Run: node --test test/ws-compression.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { sendRaw, isDroppable } from '../server/net.js';
import { isCompressibleType, resolveWsCompression, parseExtraCompressibleTypes, compressibleTypes, BASE_COMPRESSIBLE_TYPES, DEFAULT_EXTRA_COMPRESSIBLE_TYPES } from '../server/wsCompression.js';
import { Lobby } from '../server/lobby.js';
import { TestClient } from './helpers/wsClient.js';

test('off by default, `on` is the shipped set, `safe` is the fallback, anything else is refused', () => {
  assert.equal(resolveWsCompression(), false);
  assert.equal(resolveWsCompression('off'), false);
  const on = resolveWsCompression('on');
  assert.deepEqual(on, {
    // 64, not the 512 this shipped with: ws treats `threshold` as a hard off switch — below it the frame goes out
    // with rsv1 clear, i.e. not deflated at all — and step ④ shrank the hot m.public frame under 512, so 61% of
    // those frames had stopped being compressed. See server/wsCompression.js for the measurement.
    threshold: 64,
    clientNoContextTakeover: true,
    concurrencyLimit: 8,
    zlibDeflateOptions: { level: 6, memLevel: 5 },
    // NOTE the two options that are deliberately ABSENT: `serverNoContextTakeover` and `serverMaxWindowBits`.
    // Leaving them out is both the better compression (context takeover; zlib's 15-bit default window) and the
    // safer negotiation — a literal `false`/number would make ws REJECT any client that offers
    // `server_no_context_takeover` / a smaller `server_max_window_bits`, and a rejected offer aborts the handshake
    // with HTTP 400 rather than degrading. Asserted by name so a future edit cannot quietly re-pin them.
  });
  assert.ok(!('serverNoContextTakeover' in on), 'context takeover must stay undeclared (negotiated), not pinned');
  assert.ok(!('serverMaxWindowBits' in on), 'the window must stay undeclared (zlib default 15), not pinned');
  assert.ok(Object.isFrozen(on), 'the option set is shared, so it must not be mutable');

  // `safe` is the one-word operational fallback: context takeover off, window still negotiated.
  const safe = resolveWsCompression('safe');
  assert.equal(safe.serverNoContextTakeover, true, 'the fallback turns context takeover off');
  assert.ok(!('serverMaxWindowBits' in safe), 'the fallback must not pin a window either — that is what 400s an offer');
  assert.equal(safe.threshold, 64, 'the threshold fix is not part of the fallback');

  for (const bad of ['ON', 'true', '1', 'yes', '', 'OFF']) {
    assert.throws(() => resolveWsCompression(bad), /SP_WS_COMPRESSION must be off, on or safe/, bad);
  }
});

test('only the repetitive battle traffic is compressed', () => {
  // m.public / m.private / m.result are the match state broadcast (m.public measured at 98% of a seat's bytes), sent
  // by broadcastRoom or a replay — the largest streams on the wire, so they must be in the whitelist too.
  for (const t of ['b.snap', 'b.ev', 'm.field', 'm.public', 'm.private', 'm.result']) assert.equal(isCompressibleType(t), true, t);
  // credentials, handshake, control and request/response traffic stay uncompressed: they are small or secret
  for (const t of ['hello', 'welcome', 'ok', 'error', 'ping', 'pong', 'room.state', 'm.ticker', 'm.toast', 'g.econ.request', undefined, null]) {
    assert.equal(isCompressibleType(t), false, String(t));
  }
  // b.snap is the one droppable type; compressing it does not change that
  assert.equal(isDroppable({ t: 'b.snap' }), true);
  assert.equal(isCompressibleType('b.snap'), true);
});

test('a broadcast carries the same compress flag a unicast does (m.public is broadcast, not unicast)', () => {
  // Regression: broadcastRoom used to call sendRaw without `compress`, so m.public — 98% of a seat's bytes — was
  // never compressed no matter what the whitelist said. Build the smallest real Lobby and watch the socket.
  const sent = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (data, opts) => sent.push({ data, opts }) };
  const session = { playerId: 'p_0', connected: true, roomCode: 'R', ws };
  const registry = { byId: (id) => (id === 'p_0' ? session : null) };
  const lobby = new Lobby({ registry });
  const room = { code: 'R', disposed: false, seats: [{ playerId: 'p_0', isBot: false, left: false }], spectators: [] };

  lobby.broadcastRoom(room, { t: 'm.public', phase: 'PREP' });
  assert.equal(sent.length, 1, 'the seat received the broadcast');
  assert.equal(sent[0].opts.compress, true, 'm.public is compressed on the broadcast path');

  lobby.broadcastRoom(room, { t: 'room.state', code: 'R' });
  assert.equal(sent[1].opts.compress, false, 'a non-whitelisted broadcast stays uncompressed');

  lobby.broadcastRoom(room, { t: 'b.snap', fieldId: 'n:p_0' });
  assert.equal(sent[2].opts.compress, true, 'b.snap keeps its compress flag');
});

test('sendRaw passes the per-frame compress flag through, and defaults it to false', () => {
  const calls = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (data, opts) => calls.push({ data, opts }) };
  assert.equal(sendRaw(ws, '{"t":"b.snap"}'), true);
  assert.equal(sendRaw(ws, '{"t":"b.snap"}', { compress: true }), true);
  assert.equal(sendRaw(ws, '{"t":"hello"}', { compress: false }), true);
  assert.deepEqual(calls.map((c) => c.opts.compress), [false, true, false]);
});

test('a server started with compression on negotiates it, and traffic still round-trips', async (t) => {
  const srv = await startServer({ port: 0, quiet: true, wsCompression: 'on' });
  t.after(() => srv.close());
  const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { wsOptions: { perMessageDeflate: true } });
  t.after(() => client.terminate().catch(() => {}));
  assert.match(String(client.ws.extensions), /permessage-deflate/, 'the extension is negotiated');
  const welcome = await client.hello('压缩测试');
  assert.equal(welcome.t, 'welcome', JSON.stringify(welcome));
});

test('without the option the server does not offer the extension (the default stays off)', async (t) => {
  const srv = await startServer({ port: 0, quiet: true });
  t.after(() => srv.close());
  const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { wsOptions: { perMessageDeflate: true } });
  t.after(() => client.terminate().catch(() => {}));
  assert.equal(String(client.ws.extensions || '').includes('permessage-deflate'), false);
  const welcome = await client.hello('无压缩');
  assert.equal(welcome.t, 'welcome');
});

test('`on` never rejects an offer: an unacceptable one aborts the handshake with 400, so it must not happen', async (t) => {
  // This is the regression the shipped config exists to avoid. ws's `acceptAsServer` REJECTS an offer when the
  // server pins `serverNoContextTakeover: false` and the client asks for `server_no_context_takeover`, or when the
  // server's window is larger than the one the client offered — and websocket-server.js turns a rejected offer into
  // `abortHandshake(... 400 ...)`, i.e. the client cannot connect AT ALL. Declaring neither option means "negotiate",
  // so every one of these clients still gets a working connection. Run each against a real server, on both modes.
  const { WebSocket } = await import('ws');
  for (const mode of ['on', 'safe']) {
    const srv = await startServer({ port: 0, quiet: true, wsCompression: mode });
    t.after(() => srv.close());
    const offers = [
      ['browser: client_max_window_bits', { threshold: 0 }],
      ['asks server_no_context_takeover', { threshold: 0, serverNoContextTakeover: true }],
      ['asks server_max_window_bits=12', { threshold: 0, serverMaxWindowBits: 12 }],
      ['asks for less than 15', { threshold: 0, serverMaxWindowBits: 9 }],
      ['asks for both', { threshold: 0, serverNoContextTakeover: true, serverMaxWindowBits: 12 }],
    ];
    for (const [label, perMessageDeflate] of offers) {
      const c = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { perMessageDeflate });
      const outcome = await new Promise((resolve) => {
        c.on('open', () => resolve('open'));
        c.on('unexpected-response', (_req, res) => resolve(`HTTP ${res.statusCode}`));
        c.on('error', (e) => resolve(`error: ${e.message}`));
      });
      assert.equal(outcome, 'open', `${mode} / ${label} -> ${outcome}`);
      try { c.terminate(); } catch { /* already gone */ }
    }
  }
});

test('the extra-type switch: unset takes the default, `none` is the one-word rollback', () => {
  // unset -> the shipped default (b.start rides here, not in the base set)
  assert.deepEqual(parseExtraCompressibleTypes(undefined), DEFAULT_EXTRA_COMPRESSIBLE_TYPES);
  assert.deepEqual([...DEFAULT_EXTRA_COMPRESSIBLE_TYPES], ['b.start']);
  // the rollback. `none` rather than an empty string on purpose: in a Windows .cmd a bare `set X=` UNSETS the
  // variable, so "empty" cannot be expressed there and would silently mean "take the default" — the opposite
  // of what an operator typing it means.
  assert.deepEqual(parseExtraCompressibleTypes('none'), []);
  assert.deepEqual(parseExtraCompressibleTypes('NONE'), []);
  assert.deepEqual(parseExtraCompressibleTypes(''), []);
  // a list works too, and is normalised
  assert.deepEqual([...parseExtraCompressibleTypes('b.start, m.ticker ,b.start')], ['b.start', 'm.ticker']);

  // the BASE set never moves with the switch — that is what makes the rollback a rollback and not a reset
  assert.deepEqual([...BASE_COMPRESSIBLE_TYPES], ['b.snap', 'b.ev', 'm.field', 'm.public', 'm.private', 'm.result']);
});

test('b.start is compressed by default now, and the resolved list is observable', () => {
  // The whole point of the change: b.start carries the battle spec and was 69% of the uplink uncompressed.
  assert.equal(isCompressibleType('b.start'), true, 'the default extra list must be live in this process');
  const list = compressibleTypes();
  assert.ok(list.includes('b.start'));
  for (const t of BASE_COMPRESSIBLE_TYPES) assert.ok(list.includes(t), t);
  // ...and it is still NOT droppable: a dropped frame never enters the deflate context, so the only type that
  // may be dropped must stay the one whose loss is already tolerated.
  assert.equal(isDroppable({ t: 'b.snap' }), true);
  assert.equal(isDroppable({ t: 'b.start' }), false);
});
