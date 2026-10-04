// overlay-sp-connect.test.mjs — tests for tools/apk/overlay/sp-connect.mjs (audit checklist A+B).
//
//   node --test tools/apk/overlay-sp-connect.test.mjs
//
// NO real internet is used: every network peer is a local fake (http server on 127.0.0.1,
// an injected dialer, an injected fetch). The two real-ws end-to-end cases use the `ws` package
// from the BUILT webroot (android/app/src/main/assets/webroot, which is gitignored) and are
// skipped automatically when that tree has not been built.
//
// What is asserted (mapped to the security invariants in the module header):
//   * control plane: loopback peer AND Origin required; anything else → 403, nothing touched;
//   * /sp/connect: ws/wss only, private/reserved/loopback targets refused, and the refused
//     target is NEVER dialed (dial counter stays 0) — also on /sp/probe (fetch counter 0);
//   * armed /ws: dial URL/host/path correct, message bridging both ways, close propagation,
//     dial failure → 502 + log (no silent black screen); disarm → stock behavior;
//   * unarmed: request and /ws upgrade pass through to the original listeners unchanged;
//   * /sp/probe: game/auth/other classification, per-hop re-validation, hop cap, timeout,
//     64 KB body cap, GET only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import {
  overlayApi,
  id,
  install,
  createController,
  loadWsModule,
  dialWsTarget,
  normalizeWsTarget,
  normalizeProbeTarget,
  isLoopback,
  originAllowed,
  isDeniedTargetHost,
} from './overlay/sp-connect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const WEBROOT_SERVER = path.join(repoRoot, 'android', 'app', 'src', 'main', 'assets', 'webroot', 'server');

const noop = () => {};
const tick = () => new Promise((r) => setImmediate(r));
const waitFor = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
};
const originFor = (port) => `http://127.0.0.1:${port}`;

/** Local stand-in for the upstream startServer() object: http routes + a tagged /ws upgrade. */
function startUpstream() {
  const seen = { upgrades: [], requests: [] };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    seen.requests.push(req.url);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('upstream-http');
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('upgrade', (req, socket, head) => {
    seen.upgrades.push({ url: req.url, headBytes: head.length });
    if (req.url !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Accept: c3AtdGVzdA==\r\n\r\nUPSTREAM-MARK',
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      seen,
      port: server.address().port,
      close: () => new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
    }));
  });
}

function httpReq(port, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body == null ? undefined : body);
  });
}

/** Raw upgrade over TCP; resolves with whatever the server wrote (headers + early bytes). */
function rawUpgrade(port, urlPath, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    let idle = null;
    const finish = () => {
      clearTimeout(idle);
      clearTimeout(deadline);
      socket.destroy();
      resolve(data);
    };
    const deadline = setTimeout(finish, timeoutMs);
    deadline.unref?.();
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write([
        `GET ${urlPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.includes('UPSTREAM-MARK')) {
        finish();
        return;
      }
      if (data.includes('\r\n\r\n')) {
        clearTimeout(idle);
        idle = setTimeout(finish, 60); // let a same-packet body or close arrive
      }
    });
    socket.on('error', (e) => {
      clearTimeout(idle);
      clearTimeout(deadline);
      reject(e);
    });
  });
}

/** Minimal ws-like object for the injected bridge seams. */
function fakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.closed = null;
  ws.terminated = false;
  ws.send = (data, opts) => ws.sent.push({ data: Buffer.from(data), opts: opts || {} });
  ws.close = (code, reason) => {
    ws.closed = { code, reason };
    ws.readyState = 3;
  };
  ws.terminate = () => {
    ws.terminated = true;
    ws.readyState = 3;
  };
  return ws;
}

function fakeSocket(remoteAddress = '127.0.0.1') {
  return {
    remoteAddress,
    destroyed: false,
    writable: true,
    written: '',
    write(d) {
      this.written += String(d);
      return true;
    },
    end(d) {
      if (d) this.written += String(d);
      this.writable = false;
      return this;
    },
    destroy() {
      this.destroyed = true;
    },
    on() {
      return this;
    },
  };
}

function resStub() {
  return {
    headersSent: false,
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.headersSent = true;
      this.statusCode = status;
      this.headers = { ...(this.headers || {}), ...(headers || {}) };
      return this;
    },
    setHeader(k, v) {
      this.headers = { ...(this.headers || {}), [k]: v };
    },
    end(data) {
      if (data != null) this.body += String(data);
    },
    destroy() {},
  };
}

// ---------------------------------------------------------------------------------------------------
// Pure validators
// ---------------------------------------------------------------------------------------------------

test('normalizeWsTarget: ws/wss accepted, path defaults to /ws, explicit path kept', () => {
  const cases = [
    ['ws://example.com', 'example.com', '/ws'],
    ['wss://example.com:8443', 'example.com:8443', '/ws'],
    ['ws://game.example.test:9000/ws', 'game.example.test:9000', '/ws'],
    ['wss://93.184.216.34/custom?x=1', '93.184.216.34', '/custom'],
    ['ws://8.8.8.8/ws', '8.8.8.8', '/ws'],
    ['ws://[2001:4860:4860::8888]/ws', '[2001:4860:4860::8888]', '/ws'],
  ];
  for (const [input, host, pathname] of cases) {
    const r = normalizeWsTarget(input);
    assert.equal(r.ok, true, `${input}: ${r.reason}`);
    assert.equal(r.url.host, host, input);
    assert.equal(r.url.pathname, pathname, input);
  }
});

test('normalizeWsTarget: scheme / userinfo / port / length / fragment rules', () => {
  const bad = [
    ['http://example.com/', /ws:\/\/ or wss:\/\//],
    ['https://example.com/', /ws:\/\/ or wss:\/\//],
    ['ftp://example.com/x', /ws:\/\/ or wss:\/\//],
    ['not a url', /not a valid absolute URL/],
    ['', /non-empty string/],
    ['   ', /non-empty string/],
    [123, /non-empty string/],
    ['ws://user:pw@example.com/ws', /userinfo/],
    ['ws://example.com:0/ws', /port 0/],
    ['ws://example.com:65536/ws', /not a valid absolute URL/],
    [`ws://${'a'.repeat(2050)}.com/ws`, /too long/],
    ['ws://example.com/ws#frag', /fragment/],
  ];
  for (const [input, re] of bad) {
    const r = normalizeWsTarget(input);
    assert.equal(r.ok, false, `should refuse: ${String(input)}`);
    assert.match(r.reason, re, String(input));
  }
});

test('normalizeWsTarget: loopback/private/reserved denied — octal/hex/short IPv4 included', () => {
  const denied = [
    'ws://127.0.0.1/ws', 'ws://127.1/', 'ws://0x7f.1/', 'ws://2130706433/', 'ws://0177.0.0.1/',
    'ws://localhost:3000', 'ws://LOCALHOST/ws', 'ws://localhost./ws', 'ws://ip6-localhost/ws',
    'ws://10.0.0.1/ws', 'ws://172.16.0.1/ws', 'ws://172.31.255.255/ws', 'ws://192.168.1.1/ws',
    'ws://100.64.0.1/ws', 'ws://100.127.255.1/ws', 'ws://169.254.10.10/ws', 'ws://0.0.0.0/ws',
    'ws://224.0.0.1/ws', 'ws://255.255.255.255/ws', 'ws://192.0.0.1/ws', 'ws://192.0.2.5/ws',
    'ws://192.88.99.1/ws', 'ws://198.18.0.1/ws', 'ws://198.19.255.1/ws', 'ws://198.51.100.7/ws',
    'ws://203.0.113.9/ws',
    'ws://foo.local/ws', 'ws://foo.internal/ws', 'ws://foo.local./ws', 'ws://foo.INTERNAL/ws',
    'ws://[::1]/ws', 'ws://[::]/ws', 'ws://[fc00::1]/ws', 'ws://[fd12:3456::1]/ws',
    'ws://[fe80::1]/ws', 'ws://[::ffff:10.0.0.1]/ws', 'ws://[::ffff:127.0.0.1]/ws',
    'ws://[64:ff9b::a00:1]/ws', 'ws://[2001:db8::1]/ws',
  ];
  for (const input of denied) {
    const r = normalizeWsTarget(input);
    assert.equal(r.ok, false, `should refuse: ${input}`);
    assert.match(r.reason, /refused|localhost/, input);
  }
  const allowed = [
    'ws://172.32.0.1/ws', 'ws://100.128.0.1/ws', 'ws://223.255.255.255/ws',
    'ws://198.20.0.1/ws', 'ws://203.0.114.1/ws', 'ws://example.com/ws',
    'ws://[2001:4860:4860::8888]/ws',
  ];
  for (const input of allowed) {
    assert.equal(normalizeWsTarget(input).ok, true, `should accept: ${input}`);
  }
});

test('normalizeProbeTarget: http/https only and the same deny table', () => {
  assert.equal(normalizeProbeTarget('http://example.com/page').ok, true);
  assert.equal(normalizeProbeTarget('https://example.com:8443/x?y=1').ok, true);
  const bad = [
    ['ws://example.com/ws', /http:\/\/ or https:\/\//],
    ['file:///etc/passwd', /http:\/\/ or https:\/\//],
    ['http://user:pw@example.com/', /userinfo/],
    ['http://example.com:0/', /port 0/],
    ['http://127.0.0.1:8080/', /refused/],
    ['http://[::1]/', /refused/],
    ['http://10.0.0.1/', /refused/],
    ['http://169.254.169.254/latest/meta-data/', /refused/],
    ['http://metadata.google.internal/computeMetadata/v1/', /refused/],
  ];
  for (const [input, re] of bad) {
    const r = normalizeProbeTarget(input);
    assert.equal(r.ok, false, `should refuse: ${input}`);
    assert.match(r.reason, re, input);
  }
});

test('isLoopback: 127/8, ::1, IPv4-mapped loopback only', () => {
  for (const addr of ['127.0.0.1', '127.1.2.3', '::1', '0:0:0:0:0:0:0:1', '[::1]', '::ffff:127.0.0.1', '::ffff:7f00:1', 'localhost']) {
    assert.equal(isLoopback(addr), true, addr);
  }
  for (const addr of ['10.0.0.1', '192.168.1.5', '0.0.0.0', '::', '::2', '::ffff:10.0.0.1', '128.0.0.1', 'fe80::1', '203.0.113.9', '', null, undefined, 42]) {
    assert.equal(isLoopback(addr), false, String(addr));
  }
});

test('originAllowed: loopback http(s) origins only, missing Origin refused', () => {
  for (const origin of ['http://localhost:3000', 'HTTP://LOCALHOST', 'http://localhost.', 'https://localhost', 'http://127.0.0.1:3000', 'http://127.1:3000', 'http://[::1]:8080', 'http://[::ffff:127.0.0.1]:8080']) {
    assert.equal(originAllowed(origin), true, origin);
  }
  for (const origin of [undefined, null, '', 'null', 'http://evil.example', 'http://localhost.evil.example', 'https://10.0.0.1', 'http://user@localhost', 'http://localtest.me', 'file:///tmp/x', 'http://[::2]']) {
    assert.equal(originAllowed(origin), false, String(origin));
  }
});

test('isDeniedTargetHost: exported deny table covers DNS suffixes too', () => {
  assert.equal(isDeniedTargetHost('foo.internal'), true);
  assert.equal(isDeniedTargetHost('foo.local.'), true);
  assert.equal(isDeniedTargetHost('localhost'), true);
  assert.equal(isDeniedTargetHost('game.example.test'), false);
});

// ---------------------------------------------------------------------------------------------------
// Route-level: control plane + passthrough
// ---------------------------------------------------------------------------------------------------

test('unarmed: requests and /ws upgrades pass through to the original listeners unchanged', async () => {
  const up = await startUpstream();
  try {
    await install({ server: up.server, port: up.port, host: '127.0.0.1', url: '', upstreamDir: path.join(here, 'not-built'), log: noop });
    // upstream http routes untouched
    let r = await httpReq(up.port, 'GET', '/plain');
    assert.equal(r.status, 200);
    assert.equal(r.text, 'upstream-http');
    // unknown /sp/* path is not ours → upstream
    r = await httpReq(up.port, 'GET', '/sp/other');
    assert.equal(r.status, 200);
    assert.equal(r.text, 'upstream-http');
    // /ws upgrade goes to the upstream upgrade listener verbatim
    const raw = await rawUpgrade(up.port, '/ws');
    assert.match(raw, /^HTTP\/1\.1 101 /);
    assert.match(raw, /UPSTREAM-MARK/);
    assert.deepEqual(up.seen.upgrades.map((u) => u.url), ['/ws']);
    // other upgrade paths still hit the upstream listener (its 404)
    const raw404 = await rawUpgrade(up.port, '/other');
    assert.match(raw404, /404/);
    assert.deepEqual(up.seen.upgrades.map((u) => u.url), ['/ws', '/other']);
  } finally {
    await up.close();
  }
});

test('control plane: loopback peer + Origin are mandatory; non-loopback never arms', async () => {
  const up = await startUpstream();
  const dials = [];
  try {
    const ctl = createController({
      log: noop,
      dial: async (u) => {
        dials.push(u.href);
        throw new Error('unreachable');
      },
    });
    ctl.attach(up.server);
    const good = { origin: originFor(up.port) };
    // missing Origin
    let r = await httpReq(up.port, 'GET', '/sp/connect');
    assert.equal(r.status, 403);
    // non-local Origin
    r = await httpReq(up.port, 'GET', '/sp/connect', { headers: { origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
    // non-loopback peer — cannot be produced over loopback TCP, so drive the handler directly
    const res = resStub();
    await ctl.handleRequest({ method: 'GET', url: '/sp/connect', headers: good, socket: { remoteAddress: '203.0.113.9' } }, res);
    assert.equal(res.statusCode, 403);
    const res2 = resStub();
    await ctl.handleRequest({ method: 'POST', url: '/sp/connect', headers: good, socket: { remoteAddress: '198.51.100.4' } }, res2);
    assert.equal(res2.statusCode, 403);
    assert.equal(ctl.state().on, false, 'non-loopback peer must not arm the egress');
    assert.equal(dials.length, 0);
    // good origin from a real loopback socket: idle status
    r = await httpReq(up.port, 'GET', '/sp/connect', { headers: good });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text);
    assert.deepEqual({ on: body.on, targetPresent: body.targetPresent, mode: body.mode }, { on: false, targetPresent: false, mode: 'idle' });
  } finally {
    await up.close();
  }
});

test('control plane: arming rules, refused targets never dial, status never echoes the full URL', async () => {
  const up = await startUpstream();
  const dials = [];
  try {
    const ctl = createController({
      log: noop,
      dial: async (u) => {
        dials.push(u.href);
        throw new Error('unreachable');
      },
    });
    ctl.attach(up.server);
    const headers = { origin: originFor(up.port), 'content-type': 'application/json' };
    const post = (body) => httpReq(up.port, 'POST', '/sp/connect', { headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

    // method gate
    let r = await httpReq(up.port, 'PUT', '/sp/connect', { headers });
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'GET, POST');
    // http target refused
    r = await post({ target: 'http://example.com/' });
    assert.equal(r.status, 400);
    assert.match(JSON.parse(r.text).error, /ws:\/\/ or wss:\/\//);
    // private target refused
    r = await post({ target: 'ws://10.1.2.3:9000/ws' });
    assert.equal(r.status, 400);
    assert.match(JSON.parse(r.text).error, /refused/);
    // loopback target refused
    r = await post({ target: 'ws://127.0.0.1:9000/ws' });
    assert.equal(r.status, 400);
    assert.equal(dials.length, 0, 'a refused target must never be dialed');
    assert.equal(ctl.state().on, false);
    // malformed JSON
    r = await post('{oops');
    assert.equal(r.status, 400);
    // oversized body (declared content-length) → 413, still no dial
    r = await post(JSON.stringify({ target: `ws://example.com/${'x'.repeat(5000)}` }));
    assert.equal(r.status, 413);
    assert.equal(dials.length, 0);

    // a good target arms the egress; the query/path token is never echoed
    r = await post({ target: 'ws://game.example.test:9443/secret-path?token=abc123' });
    assert.equal(r.status, 200);
    const armed = JSON.parse(r.text);
    assert.equal(armed.on, true);
    assert.equal(armed.targetPresent, true);
    assert.equal(armed.mode, 'proxy');
    assert.equal(armed.targetHost, 'game.example.test:9443');
    for (const secret of ['secret-path', 'token', 'abc123']) {
      assert.ok(!r.text.includes(secret), `status must not echo ${secret}`);
    }
    r = await httpReq(up.port, 'GET', '/sp/connect', { headers });
    assert.equal(JSON.parse(r.text).targetHost, 'game.example.test:9443');
    assert.ok(!r.text.includes('secret-path'));
    assert.equal(dials.length, 0, 'arming alone must not dial');

    // armed but a non-/ws upgrade is still forwarded to the upstream listener
    const rawOther = await rawUpgrade(up.port, '/other');
    assert.match(rawOther, /404/);
    assert.equal(dials.length, 0);

    // a non-GET upgrade to /ws is refused with 405 (and still does not dial)
    const socket = fakeSocket();
    const handled = ctl.handleUpgrade({ method: 'POST', url: '/ws', headers: {} }, socket, Buffer.alloc(0));
    assert.equal(handled, true);
    assert.match(socket.written, /^HTTP\/1\.1 405 /);
    assert.equal(dials.length, 0);

    // {off:true} wins over a target and disarms
    r = await post({ off: true, target: 'ws://example.com/ws' });
    assert.equal(r.status, 200);
    const off = JSON.parse(r.text);
    assert.equal(off.on, false);
    assert.equal(off.targetPresent, false);
    assert.equal(off.targetHost, undefined);
  } finally {
    await up.close();
  }
});

test('probe route: GET only, loopback+Origin gate, refused targets are never fetched', async () => {
  const up = await startUpstream();
  const fetchCalls = [];
  try {
    const ctl = createController({
      log: noop,
      fetchImpl: async (href) => {
        fetchCalls.push(href);
        throw new Error('must not be called');
      },
    });
    ctl.attach(up.server);
    const good = { origin: originFor(up.port) };
    const probe = (u) => httpReq(up.port, 'GET', `/sp/probe?url=${encodeURIComponent(u)}`, { headers: good });

    let r = await httpReq(up.port, 'POST', '/sp/probe?url=http://example.com/', { headers: good });
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'GET');
    r = await httpReq(up.port, 'GET', '/sp/probe', { headers: good });
    assert.equal(r.status, 400);
    r = await probe('ws://example.com/ws');
    assert.equal(r.status, 400);
    const refused = [
      'http://127.0.0.1:8080/',
      'http://10.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://metadata.google.internal/',
    ];
    for (const u of refused) {
      const rr = await probe(u);
      assert.equal(rr.status, 400, u);
    }
    // missing Origin → 403 even for a valid url
    r = await httpReq(up.port, 'GET', '/sp/probe?url=http://example.com/');
    assert.equal(r.status, 403);
    // non-loopback peer → 403, no fetch
    const res = resStub();
    await ctl.handleRequest({ method: 'GET', url: '/sp/probe?url=http://example.com/', headers: good, socket: { remoteAddress: '203.0.113.9' } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(fetchCalls.length, 0, 'a refused probe target must never be fetched');
  } finally {
    await up.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Probe classification
// ---------------------------------------------------------------------------------------------------

test('probe: game/auth/other classification, per-hop revalidation, hop cap, timeout, 64 KB cap', async () => {
  const up = await startUpstream();
  try {
    const gameHtml = '<html><head><title>卫戍协议：盟约 · STRONGHOLD PROTOCOL</title></head><body><script type="module" src="/js/main.js"></script></body></html>';
    const routes = {
      'game.example': () => new Response(gameHtml, { status: 200, headers: { 'content-type': 'text/html' } }),
      'game2.example': () => new Response('import { PROTOCOL_VERSION } from "/shared/constants.js";', { status: 200 }),
      'auth.example': () => new Response('please sign in', { status: 401 }),
      'forbidden.example': () => new Response('nope', { status: 403 }),
      'login.example': () => new Response('<h1>Sign in</h1>', { status: 200 }),
      'plain.example': () => new Response('hello', { status: 200 }),
      'redir.example': () => new Response(null, { status: 302, headers: { location: 'http://auth.example/login' } }),
      'private-redir.example': () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }),
      'localhost-redir.example': () => new Response(null, { status: 302, headers: { location: 'http://localhost:9000/' } }),
      'ws-redir.example': () => new Response(null, { status: 302, headers: { location: 'ws://plain.example/' } }),
      'loop.example': () => new Response(null, { status: 302, headers: { location: 'http://loop.example/next' } }),
      'slow.example': (u, opts) => new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
      'big.example': () => new Response(`${'a'.repeat(64 * 1024)}<title>卫戍协议</title>`, { status: 200 }),
      'bigmark.example': () => new Response(`<title>卫戍协议</title>${'a'.repeat(64 * 1024)}`, { status: 200 }),
    };
    const calls = [];
    const fakeFetch = async (href, opts) => {
      const u = new URL(href);
      calls.push(u.href);
      const route = routes[u.host];
      if (!route) throw new Error(`no fake route for ${u.host}`);
      return route(u, opts);
    };
    const ctl = createController({ log: noop, fetchImpl: fakeFetch, probeTimeoutMs: 300 });
    ctl.attach(up.server);
    const good = { origin: originFor(up.port) };
    const probe = async (u) => {
      const r = await httpReq(up.port, 'GET', `/sp/probe?url=${encodeURIComponent(u)}`, { headers: good });
      assert.equal(r.status, 200, r.text);
      return JSON.parse(r.text);
    };
    const delta = (before) => calls.length - before;

    let before = calls.length;
    let res = await probe('http://game.example/');
    assert.equal(res.kind, 'game', JSON.stringify(res));
    assert.equal(res.status, 200);
    assert.equal(res.finalHost, 'game.example');
    assert.equal(delta(before), 1);

    res = await probe('http://game2.example/');
    assert.equal(res.kind, 'game');

    res = await probe('http://auth.example/');
    assert.equal(res.kind, 'auth');
    assert.equal(res.status, 401);

    res = await probe('http://forbidden.example/');
    assert.equal(res.kind, 'auth');
    assert.equal(res.status, 403);

    res = await probe('http://redir.example/');
    assert.equal(res.kind, 'auth', JSON.stringify(res));
    assert.equal(res.finalHost, 'auth.example');
    assert.equal(res.hops, 1);

    res = await probe('http://plain.example/');
    assert.equal(res.kind, 'other');

    // redirect to a denied host: refused on the hop check, the second host is never contacted
    before = calls.length;
    res = await probe('http://private-redir.example/');
    assert.equal(res.kind, 'other');
    assert.match(res.reason, /blocked/);
    assert.equal(delta(before), 1, 'the private redirect target must not be fetched');

    before = calls.length;
    res = await probe('http://localhost-redir.example/');
    assert.match(res.reason, /blocked/);
    assert.equal(delta(before), 1);

    before = calls.length;
    res = await probe('http://ws-redir.example/');
    assert.match(res.reason, /blocked/);
    assert.equal(delta(before), 1);

    // hop cap: 6 redirects followed, the 7th is refused (7 requests total)
    before = calls.length;
    res = await probe('http://loop.example/');
    assert.equal(res.kind, 'other');
    assert.match(res.reason, /too many redirects/);
    assert.equal(delta(before), 7);

    // timeout (probeTimeoutMs of this controller is 300ms)
    before = calls.length;
    const t0 = Date.now();
    res = await probe('http://slow.example/');
    assert.equal(res.kind, 'other');
    assert.equal(res.reason, 'timeout');
    assert.ok(Date.now() - t0 < 2000, 'timeout must be bounded by probeTimeoutMs');
    assert.equal(delta(before), 1);

    // 64 KB cap: a marker beyond the cap does not classify as game; one inside does
    res = await probe('http://big.example/');
    assert.equal(res.kind, 'other');
    res = await probe('http://bigmark.example/');
    assert.equal(res.kind, 'game');
  } finally {
    await up.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Bridge (fake seams)
// ---------------------------------------------------------------------------------------------------

test('bridge: armed /ws dials the validated target, pipes both ways, propagates close', async () => {
  const dialed = [];
  const targetWs = fakeWs();
  const clientWs = fakeWs();
  const accepted = [];
  const ctl = createController({
    log: noop,
    dial: async (u) => {
      dialed.push(u);
      return targetWs;
    },
    acceptClient: async (req, socket, head) => {
      accepted.push({ req, head });
      return clientWs;
    },
  });
  const armed = ctl.setTarget('ws://bridge.example.test:7777');
  assert.equal(armed.on, true);

  // non-/ws path: not ours (returns false, nothing dialed)
  assert.equal(ctl.handleUpgrade({ method: 'GET', url: '/other', headers: {} }, fakeSocket(), Buffer.alloc(0)), false);
  assert.equal(dialed.length, 0);

  const socket = fakeSocket();
  const handled = ctl.handleUpgrade({ method: 'GET', url: '/ws', headers: { host: '127.0.0.1:1' } }, socket, Buffer.alloc(0));
  assert.equal(handled, true, 'armed /ws upgrade must be consumed');
  await tick();
  assert.equal(dialed.length, 1);
  assert.equal(dialed[0].href, 'ws://bridge.example.test:7777/ws', 'the default /ws path must be dialed');
  assert.equal(accepted.length, 1);

  // client → target: text stays text
  clientWs.emit('message', Buffer.from('hello'), false);
  assert.equal(targetWs.sent.length, 1);
  assert.equal(targetWs.sent[0].data.toString(), 'hello');
  assert.equal(targetWs.sent[0].opts.binary, false);

  // target → client: binary stays binary
  targetWs.emit('message', Buffer.from([1, 2, 3]), true);
  assert.equal(clientWs.sent.length, 1);
  assert.equal(clientWs.sent[0].opts.binary, true);

  // close propagation sanitises reserved codes (1006 cannot be sent on the wire)
  clientWs.emit('close', 1006, '');
  assert.deepEqual(targetWs.closed, { code: 1000, reason: '' });
});

test('bridge: target dial failure answers 502 and logs — never a silent black screen', async () => {
  const logs = [];
  const ctl = createController({
    log: (m) => logs.push(String(m)),
    dial: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const refusedArm = ctl.setTarget('ws://127.0.0.1:9000/ws');
  assert.equal(refusedArm.ok, false, 'loopback target must not arm');
  assert.equal(ctl.state().on, false);

  assert.equal(ctl.setTarget('ws://dead.example.test:1234/ws').on, true);
  const socket = fakeSocket();
  assert.equal(ctl.handleUpgrade({ method: 'GET', url: '/ws', headers: {} }, socket, Buffer.alloc(0)), true);
  await tick();
  assert.match(socket.written, /^HTTP\/1\.1 502 /, 'dial failure must answer the client');
  assert.ok(logs.some((l) => l.includes('dial') && l.includes('dead.example.test:1234')), 'dial failure must be logged');
  assert.ok(!logs.some((l) => l.includes('/ws') && l.includes('1234')), 'logs use the host summary, not the full URL');
});

// ---------------------------------------------------------------------------------------------------
// Real ws: package loading + full end-to-end (skipped when the webroot is not built)
// ---------------------------------------------------------------------------------------------------

test('loadWsModule: createRequire path and the node_modules/ws/index.js fallback', async () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-connect-ws-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-connect-ws-b-'));
  const rootC = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-connect-ws-c-'));
  const writeFakeWs = (root, main, cls) => {
    const serverDir = path.join(root, 'server');
    const wsDir = path.join(root, 'node_modules', 'ws');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'index.js'), '');
    fs.writeFileSync(path.join(wsDir, 'package.json'), JSON.stringify({ name: 'ws', main }));
    fs.writeFileSync(path.join(wsDir, 'index.js'), `module.exports = { WebSocket: class ${cls} {}, WebSocketServer: class ${cls}S {} };`);
    if (main !== 'index.js') fs.writeFileSync(path.join(wsDir, main), 'throw new Error("broken main");');
    return serverDir;
  };
  try {
    // 1) normal tree: bare require('ws') resolves
    const serverA = writeFakeWs(rootA, 'index.js', 'MarkerA');
    const modA = await loadWsModule(serverA);
    assert.equal(modA.WebSocket.name, 'MarkerA');

    // 2) broken `main` → require fails, the <dir>/node_modules/ws/index.js dynamic-import fallback works
    const serverB = writeFakeWs(rootB, 'missing.js', 'MarkerB');
    const modB = await loadWsModule(serverB);
    assert.equal(modB.WebSocket.name, 'MarkerB');

    // 3) nothing to load anywhere → a clear error, not a crash
    const serverC = path.join(rootC, 'server');
    fs.mkdirSync(serverC, { recursive: true });
    await assert.rejects(() => loadWsModule(serverC), /cannot load the 'ws' package/);
    await assert.rejects(() => loadWsModule(undefined), /cannot load the 'ws' package/);
  } finally {
    for (const root of [rootA, rootB, rootC]) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadWsModule resolves the real ws package from the built webroot', async (t) => {
  if (!fs.existsSync(path.join(WEBROOT_SERVER, 'index.js'))) return t.skip('webroot not built');
  const mod = await loadWsModule(WEBROOT_SERVER);
  assert.equal(typeof mod.WebSocket, 'function');
  assert.equal(typeof mod.WebSocketServer, 'function');
});

test('real ws end-to-end: default dial + real accept + full proxy bridge', async (t) => {
  if (!fs.existsSync(path.join(WEBROOT_SERVER, 'index.js'))) return t.skip('webroot not built');
  let ws;
  try {
    ws = await loadWsModule(WEBROOT_SERVER);
  } catch (e) {
    return t.skip(`ws package not resolvable from the webroot: ${e.message}`);
  }
  const listen = (server) => new Promise((r) => server.on('listening', r));
  const closeServer = (server) => new Promise((r) => server.close(() => r()));

  // 1) default dialWsTarget talks to a local ws server, path copied from the URL
  const targetA = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 });
  await listen(targetA);
  const seenA = { paths: [], messages: [] };
  targetA.on('connection', (sock, req) => {
    seenA.paths.push(req.url);
    sock.send('DIAL-HELLO');
    sock.on('message', (d) => seenA.messages.push(d.toString()));
  });
  let dialed = null;
  try {
    dialed = await dialWsTarget(WEBROOT_SERVER, new URL(`ws://127.0.0.1:${targetA.address().port}/ws`));
    // attach before awaiting `open` — an early greeting must not be dropped
    const helloPromise = new Promise((resolve, reject) => {
      dialed.client.once('message', (d) => resolve(d.toString()));
      dialed.client.once('error', reject);
    });
    await dialed.open;
    assert.equal(await helloPromise, 'DIAL-HELLO');
    dialed.client.send('dial-ping');
    assert.ok(await waitFor(() => seenA.messages.length === 1), 'default dial must deliver messages');
    assert.deepEqual(seenA.paths, ['/ws']);
  } finally {
    try { dialed?.client?.terminate(); } catch { /* ignore */ }
    for (const c of targetA.clients) c.terminate();
    await closeServer(targetA);
  }

  // 2) full proxy: real client ↔ default accept ↔ injected dial to a local fake target,
  //    armed through the public API with a public-looking hostname (loopback targets are
  //    refused by design, so the injected dial redirects to the local fake).
  const targetB = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 });
  await listen(targetB);
  const seenB = { paths: [], messages: [] };
  targetB.on('connection', (sock, req) => {
    seenB.paths.push(req.url);
    sock.send('TARGET-HELLO');
    sock.on('message', (d, isBinary) => {
      seenB.messages.push(d.toString());
      sock.send(`${isBinary ? 'b:' : 't:'}${d.toString()}`);
    });
  });
  const up = await startUpstream();
  let client = null;
  try {
    const ctl = createController({
      log: noop,
      upstreamDir: WEBROOT_SERVER,
      dial: () => dialWsTarget(WEBROOT_SERVER, new URL(`ws://127.0.0.1:${targetB.address().port}/ws`)),
    });
    ctl.attach(up.server);
    const armed = ctl.setTarget('ws://game.example.test:9000/ws');
    assert.equal(armed.on, true);

    client = new ws.WebSocket(`ws://127.0.0.1:${up.port}/ws`);
    const clientHello = await new Promise((resolve, reject) => {
      client.once('message', (d) => resolve(d.toString()));
      client.once('error', reject);
    });
    assert.equal(clientHello, 'TARGET-HELLO', 'default acceptClient must complete the handshake');

    const echoPromise = new Promise((resolve, reject) => {
      client.once('message', (d) => resolve(d.toString()));
      client.once('error', reject);
    });
    client.send('ping');
    assert.ok(await waitFor(() => seenB.messages.length === 1), 'client→target must be bridged');
    assert.equal(await echoPromise, 't:ping', 'target→client must be bridged');

    assert.deepEqual(seenB.paths, ['/ws'], 'the dialed path must be /ws');
    assert.equal(up.seen.upgrades.length, 0, 'armed: the local /ws upgrade never reaches the upstream listener');

    client.close();
    assert.ok(await waitFor(() => client.readyState === 3), 'client close must propagate');
  } finally {
    try { client?.terminate(); } catch { /* ignore */ }
    for (const c of targetB.clients) c.terminate();
    await closeServer(targetB);
    await up.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Overlay contract / install isolation
// ---------------------------------------------------------------------------------------------------

test('overlay contract: api/id and install never throws, even without a server', async () => {
  assert.equal(overlayApi, 1);
  assert.equal(id, 'sp-connect');
  const logs = [];
  const ctl = await install({ log: (m) => logs.push(String(m)) });
  assert.equal(typeof ctl.handleRequest, 'function');
  assert.ok(logs.some((l) => l.includes('not attached')));
  const ctl2 = await install({ server: null, log: noop });
  assert.equal(typeof ctl2.handleUpgrade, 'function');
});
