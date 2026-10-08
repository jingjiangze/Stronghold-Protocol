// test/ws-compression.test.js — the opt-in transport compression (server/wsCompression.js).
// What matters: off by default, the bounds are the measured ones, only the repetitive battle traffic is asked to
// compress, and a real server that is started with it on really offers the extension.
// Run: node --test test/ws-compression.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { sendRaw, isDroppable } from '../server/net.js';
import { isCompressibleType, resolveWsCompression } from '../server/wsCompression.js';
import { TestClient } from './helpers/wsClient.js';

test('off by default, on returns the bounded option set, anything else is refused', () => {
  assert.equal(resolveWsCompression(), false);
  assert.equal(resolveWsCompression('off'), false);
  const on = resolveWsCompression('on');
  assert.deepEqual(on, {
    threshold: 512,
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
    serverMaxWindowBits: 12,
    concurrencyLimit: 8,
    zlibDeflateOptions: { level: 6, memLevel: 5 },
  });
  assert.ok(Object.isFrozen(on), 'the option set is shared, so it must not be mutable');
  for (const bad of ['ON', 'true', '1', 'yes', '']) {
    assert.throws(() => resolveWsCompression(bad), /SP_WS_COMPRESSION must be on or off/, bad);
  }
});

test('only the repetitive battle traffic is compressed', () => {
  for (const t of ['b.snap', 'b.ev', 'm.field']) assert.equal(isCompressibleType(t), true, t);
  // credentials, handshake, control and request/response traffic stay uncompressed: they are small or secret
  for (const t of ['hello', 'welcome', 'ok', 'error', 'ping', 'pong', 'room.state', 'g.econ.request', undefined, null]) {
    assert.equal(isCompressibleType(t), false, String(t));
  }
  // b.snap is the one droppable type; compressing it does not change that
  assert.equal(isDroppable({ t: 'b.snap' }), true);
  assert.equal(isCompressibleType('b.snap'), true);
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
