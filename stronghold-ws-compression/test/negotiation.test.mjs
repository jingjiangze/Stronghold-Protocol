// test/negotiation.test.mjs — the regression that matters most: a REJECTED offer is not a degraded
// connection, it is NO connection.
//
// `ws`'s `acceptAsServer` rejects an offer when the server pins `serverNoContextTakeover: false` and
// the client asks for `server_no_context_takeover`, or when the server's declared window exceeds the
// one the client offered. `websocket-server.js` turns a rejected offer into
// `abortHandshake(... 400 ...)`. So every one of these clients must still get a working connection on
// every mode this package ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { resolveWsCompression } from '../src/wsCompression.mjs';

/** A real server with the given mode, returning a connect() helper. */
async function withServer(mode, fn) {
  const perMessageDeflate = resolveWsCompression(mode);
  const srv = new WebSocketServer({ port: 0, perMessageDeflate });
  await new Promise((r) => srv.on('listening', r));
  const port = srv.address().port;
  try {
    return await fn(port);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

/** Connect with a given client offer; resolve with the outcome rather than throwing. */
function attempt(port, perMessageDeflate) {
  return new Promise((resolve) => {
    const c = new WebSocket(`ws://127.0.0.1:${port}/ws`, { perMessageDeflate });
    const timer = setTimeout(() => { try { c.terminate(); } catch { /* gone */ } resolve({ outcome: 'timeout' }); }, 8000);
    // Read the RAW response header: it is what actually went on the wire, and unlike the client's
    // internal extension map it cannot be reshaped by a library upgrade.
    let rawExt = '';
    c.on('upgrade', (res) => { rawExt = String(res.headers['sec-websocket-extensions'] ?? ''); });
    c.on('open', () => {
      clearTimeout(timer);
      // `permessage-deflate; client_no_context_takeover; server_max_window_bits=12` -> { client_no_context_takeover: true, ... }
      const parts = rawExt.split(';').map((t) => t.trim()).filter(Boolean);
      const params = {};
      for (const token of parts.slice(1)) {
        const eq = token.indexOf('=');
        if (eq === -1) params[token] = true;
        else params[token.slice(0, eq).trim()] = token.slice(eq + 1).trim().replace(/"/g, '');
      }
      try { c.close(); } catch { /* gone */ }
      resolve({ outcome: 'open', extension: rawExt, negotiated: params, hasExtension: rawExt.includes('permessage-deflate') });
    });
    c.on('unexpected-response', (_req, res) => { clearTimeout(timer); resolve({ outcome: `HTTP ${res.statusCode}` }); });
    c.on('error', (e) => { clearTimeout(timer); resolve({ outcome: `error: ${e.message}` }); });
  });
}

const OFFERS = [
  ['browser: client_max_window_bits only', { threshold: 0 }],
  ['asks server_no_context_takeover', { threshold: 0, serverNoContextTakeover: true }],
  ['asks server_max_window_bits=12', { threshold: 0, serverMaxWindowBits: 12 }],
  ['asks a window below 15', { threshold: 0, serverMaxWindowBits: 9 }],
  ['asks for both', { threshold: 0, serverNoContextTakeover: true, serverMaxWindowBits: 12 }],
];

for (const mode of ['on', 'safe']) {
  for (const [label, offer] of OFFERS) {
    test(`${mode} never rejects an offer: ${label}`, async () => {
      await withServer(mode, async (port) => {
        const r = await attempt(port, offer);
        assert.equal(r.outcome, 'open', `${mode} / ${label} -> ${r.outcome}`);
      });
    });
  }
}

test('mode `on` negotiates context takeover for a plain browser client, and never pins the window', async () => {
  await withServer('on', async (port) => {
    const r = await attempt(port, { threshold: 0 });
    assert.equal(r.outcome, 'open');
    const p = r.negotiated;
    assert.equal(r.hasExtension, true, `expected permessage-deflate, got ${JSON.stringify(r.extension)}`);
    assert.ok(!p.server_no_context_takeover,
      'the shipped mode must NOT ask the client to drop the server context — that is the whole win');
    assert.ok(!p.server_max_window_bits, 'the window must stay negotiated, not pinned');
    assert.equal(p.client_no_context_takeover, true, 'the inbound direction stays bounded');
  });
});

test('mode `safe` does declare server_no_context_takeover — that is what makes it the fallback', async () => {
  await withServer('safe', async (port) => {
    const r = await attempt(port, { threshold: 0 });
    assert.equal(r.outcome, 'open');
    assert.equal(r.hasExtension, true);
    assert.equal(r.negotiated.server_no_context_takeover, true);
  });
});

test('mode `off` offers no extension at all', async () => {
  await withServer('off', async (port) => {
    const r = await attempt(port, { threshold: 0 });
    assert.equal(r.outcome, 'open');
    assert.equal(r.hasExtension, false, `off must not offer the extension, got ${JSON.stringify(r.extension)}`);
  });
});

test('a client that refuses compression still connects on every mode', async () => {
  for (const mode of ['off', 'on', 'safe']) {
    await withServer(mode, async (port) => {
      const r = await attempt(port, false);
      assert.equal(r.outcome, 'open', `${mode} -> ${r.outcome}`);
    });
  }
});
