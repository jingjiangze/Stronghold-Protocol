// test/box-verify.test.js — tools/box/verify-service.mjs, the no-SSH check of a running deployment.
//
// WHY: the box updates itself from our rolling release and blue/green flips on its own, so "did the change land?"
// is answered against a URL, never by logging into the box. That makes this script the acceptance gate for a
// deploy — and the integration case below runs it against a real server started in this process, so the contract
// it asserts (module graph and /data versioned, /vendor/ untouched, immutable policy) is pinned by the code that
// actually serves it.
// Run: node --test test/box-verify.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyService } from '../tools/box/verify-service.mjs';
import { startServer } from '../server/index.js';

const TAG = 'abc123';

/** A fake server: `plan` maps a path (without the query) to a body + headers. */
function fakeFetch(plan, tag = TAG) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    const u = new URL(url);
    if (u.pathname === '/healthz') {
      const build = plan['/healthz'] && plan['/healthz'].build !== undefined ? plan['/healthz'].build : tag;
      return Response.json({ ok: true, app: '0.2.2', build, uptimeSec: 5, sockets: 1 });
    }
    const entry = plan[u.pathname + u.search];
    if (!entry) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-cache' } });
    return new Response(entry.body === undefined ? 'x' : entry.body, {
      status: entry.status || 200,
      headers: { 'content-type': entry.type || 'text/javascript', ...(entry.headers || {}) },
    });
  };
  fetchFn.calls = calls;
  return fetchFn;
}

/** Everything a healthy deployment looks like, as raw bytes (so each test can break exactly one thing). */
const IMMUTABLE = { headers: { 'cache-control': 'public, max-age=31536000, immutable' } };
const GOOD = {
  '/': { type: 'text/html', body: `<link href="/css/theme.css?v=${TAG}"><script src="/js/main.js?v=${TAG}"></script>` + `<link href="/i18n/en.json?v=${TAG}"><link href="/vendor/preact.module.js">`, headers: { 'cache-control': 'no-cache' } },
  '/js/main.js': { body: `import { h } from './ui/components.js?v=${TAG}';\nimport p from '../vendor/preact.module.js';\n`, headers: { 'cache-control': 'no-cache' } },
  '/sim/spec.js': { body: `import { b } from './Battle.js?v=${TAG}';\n` },
  '/shared/constants.js': { body: `import { t } from './i18n.js?v=${TAG}';\n` },
  [`/js/main.js?v=${TAG}`]: IMMUTABLE,
  [`/sim/spec.js?v=${TAG}`]: IMMUTABLE,
  [`/data/chess.json?v=${TAG}`]: IMMUTABLE,
  [`/data/assets.json?v=${TAG}`]: IMMUTABLE,
  '/data/assets.json': { headers: { 'cache-control': 'no-cache' } },
};

const failed = (report) => report.results.filter((r) => !r.ok).map((r) => r.name);

test('a healthy deployment passes every check', async () => {
  const report = await verifyService({ base: 'https://box.example', fetchFn: fakeFetch(GOOD) });
  assert.deepEqual(failed(report), [], 'nothing should fail');
  assert.equal(report.ok, true);
  assert.equal(report.tag, TAG);
});

test('an unstamped module import fails the graph check', async () => {
  const plan = { ...GOOD, '/js/main.js': { body: "import { h } from './ui/components.js';\n" } };
  const report = await verifyService({ base: 'https://box.example', fetchFn: fakeFetch(plan) });
  assert.equal(report.ok, false);
  assert.ok(failed(report).some((n) => n.startsWith('/js/main.js') && n.includes('own imports')), failed(report).join(' | '));
});

test('a stamped /vendor/ reference fails: two URLs for one module are two instances', async () => {
  const plan = { ...GOOD, '/js/main.js': { body: `import p from '../vendor/preact.module.js?v=${TAG}';\n` } };
  const report = await verifyService({ base: 'https://box.example', fetchFn: fakeFetch(plan) });
  assert.equal(report.ok, false);
  assert.ok(failed(report).some((n) => n.includes('vendor imports stay unversioned')), failed(report).join(' | '));
});

test('a stale index.html (old tag on its references) fails', async () => {
  const plan = { ...GOOD, '/': { type: 'text/html', body: '<script src="/js/main.js?v=old999"></script>', headers: { 'cache-control': 'no-cache' } } };
  const report = await verifyService({ base: 'https://box.example', fetchFn: fakeFetch(plan) });
  assert.equal(report.ok, false);
  assert.ok(failed(report).some((n) => n.includes('own reference')), failed(report).join(' | '));
});

test('a versioned URL that is not immutable fails (the deploy would cost uplink forever)', async () => {
  const plan = {
    ...GOOD,
    ['/data/chess.json?v=' + TAG]: { headers: { 'cache-control': 'no-cache' } },
  };
  const report = await verifyService({ base: 'https://box.example', fetchFn: fakeFetch(plan) });
  assert.equal(report.ok, false);
  assert.ok(failed(report).some((n) => n.includes('chess.json') && n.includes('immutable')), failed(report).join(' | '));
});

test('--expect: the box has to actually be on the build that was asked for', async () => {
  const onOther = fakeFetch({ ...GOOD, '/healthz': { build: 'ffffffffffff' } });
  const stale = await verifyService({ base: 'https://box.example', fetchFn: onOther, expect: TAG });
  assert.equal(stale.ok, false);
  assert.ok(failed(stale).some((n) => n.includes(`on build ${TAG}`)), failed(stale).join(' | '));

  const onTag = await verifyService({ base: 'https://box.example', fetchFn: fakeFetch(GOOD), expect: TAG });
  assert.deepEqual(failed(onTag), []);
});

// ---- the real thing: a server started here must satisfy the same contract ------------------------------

test('a server started in this process satisfies the contract end to end', async (t) => {
  const srv = await startServer({ port: 0, quiet: true });
  t.after(() => srv.close());
  const report = await verifyService({ base: `http://127.0.0.1:${srv.port}`, fetchFn: fetch });
  const problems = report.results.filter((r) => !r.ok).map((r) => `${r.name} (${r.detail})`);
  assert.deepEqual(problems, [], 'the served runtime must pass every check');
  assert.match(report.tag, /^[0-9a-f]{6,}$/, 'a hex build tag');
});
