// test/readonlyRoutes.test.mjs — the read-only surface follows the Forge `routes` conventions exactly.
// These assertions exist because two different sets of rules for the same idea is two things to get wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadonlyRouter, cacheControlFor, READONLY_ROUTES } from '../src/readonlyRoutes.mjs';
import { TransportStats } from '../src/plumbing.mjs';
import { describeWsCompression, STRONGHOLD_COMPRESSIBLE_TYPES } from '../src/wsCompression.mjs';

function makeRouter(overrides = {}) {
  return createReadonlyRouter({
    mode: 'on',
    sockets: () => 3,
    stats: new TransportStats(),
    compressibleTypes: STRONGHOLD_COMPRESSIBLE_TYPES,
    describe: describeWsCompression,
    ...overrides,
  });
}

test('the declared paths answer GET and HEAD', () => {
  const handle = makeRouter();
  for (const route of READONLY_ROUTES) {
    const get = handle({ method: 'GET', url: route.path });
    assert.equal(get.status, 200, route.path);
    assert.equal(get.headers['content-type'], 'application/json; charset=utf-8');
    assert.doesNotThrow(() => JSON.parse(get.body), `${route.path} body is JSON`);

    const head = handle({ method: 'HEAD', url: route.path });
    assert.equal(head.status, 200);
    assert.equal(head.body, '', 'HEAD carries no body');
    assert.equal(head.headers['content-type'], get.headers['content-type'], 'HEAD carries the same headers');
  }
});

test('every other verb is 405 with Allow: GET, HEAD', () => {
  const handle = makeRouter();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = handle({ method, url: '/ws-compression/status' });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, 'GET, HEAD', method);
  }
});

test('an undeclared path is not mine — the caller routes it, nothing is invented', () => {
  const handle = makeRouter();
  assert.equal(handle({ method: 'GET', url: '/' }), null);
  assert.equal(handle({ method: 'GET', url: '/index.html' }), null);
  // EXACT match only: no prefix matching, no trailing-slash fuzz
  assert.equal(handle({ method: 'GET', url: '/ws-compression/status/' }), null);
  assert.equal(handle({ method: 'GET', url: '/ws-compression' }), null);
  // ...and a query string is stripped before matching, not treated as part of the path
  assert.equal(handle({ method: 'GET', url: '/ws-compression/status?x=1' }).status, 200);
});

test('there is no traversal surface: a path that resolves outside the table is simply not mine', () => {
  const handle = makeRouter();
  for (const p of ['/ws-compression/../etc/passwd', '/../ws-compression/status', '/ws-compression/status/../status']) {
    const r = handle({ method: 'GET', url: p });
    assert.ok(r === null || r.status === 404 || r.status === 200, `${p} must not 500`);
    if (r && r.status === 200) assert.equal(p, '/ws-compression/status', 'only the literal path may ever 200');
  }
});

test('cacheControlFor maps exactly the three declared values', () => {
  assert.equal(cacheControlFor('no-cache'), 'no-cache');
  assert.equal(cacheControlFor('no-store'), 'no-store');
  assert.equal(cacheControlFor('public'), 'public, max-age=86400');
  assert.equal(cacheControlFor(), 'no-cache', 'the default');
  assert.throws(() => cacheControlFor('max-age=5'), /cache must be/);
});

test('the status route reports the undeclared options, not just the mode name', () => {
  const handle = makeRouter();
  const body = JSON.parse(handle({ method: 'GET', url: '/ws-compression/status' }).body);
  assert.equal(body.enabled, true);
  assert.equal(body.contextTakeover, 'on (negotiated)');
  assert.match(body.windowBits, /15/);
  assert.equal(body.sockets, 3);
  assert.ok(Array.isArray(body.compressibleTypes) && body.compressibleTypes.length > 0);
});

test('the stats route reports counters, and nothing in this module can mutate the mode', () => {
  const stats = new TransportStats();
  stats.countSent(100, true);
  stats.countSent(50, false);
  stats.countSkipped();
  const handle = makeRouter({ stats });
  const body = JSON.parse(handle({ method: 'GET', url: '/ws-compression/stats' }).body);
  assert.equal(body.stats.framesSent, 2);
  assert.equal(body.stats.bytesSent, 150);
  assert.equal(body.stats.bytesCompressed, 100);
  assert.equal(body.stats.framesSkipped, 1);

  // A read-only interface that can be talked into a write is not read-only.
  for (const route of READONLY_ROUTES) {
    assert.equal(handle({ method: 'POST', url: route.path }).status, 405, route.path);
  }
});
