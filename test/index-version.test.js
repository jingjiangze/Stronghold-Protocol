// test/index-version.test.js — the served index.html, with a version query on its own asset references.
//
// WHY: those 25 references to /css/…, /js/… and /vendor/… carry no content hash, so files.js cacheControlFor()
// can only answer `no-cache` for them — a returning player revalidates every one of the 5.3 MiB of script and
// style on every visit. A version query lands on the IMMUTABLE_CACHE branch instead, so a repeat visit
// downloads nothing and the files sit in the CDN edge cache.
//
// What matters here: every reference is stamped (the importmap's JSON values included), the importmap still
// parses, the version is the served runtime's own build hash (so a deploy bumps it with no constant to
// raise), and the file on disk is never touched.
// Run: node --test test/index-version.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { versionIndexHtml } from '../server/http/static.js';
import { startServer } from '../server/index.js';

const INDEX = new URL('../public/index.html', import.meta.url);
const REF = /"(\/(?:css|js|vendor|i18n)\/[^"]*)"/g;
const TAG = 'abc123';
const versionOf = (url) => {
  const m = /[?&]v=([^&]*)/.exec(url);
  return m ? m[1] : null;
};

test('every own asset reference is stamped, including the importmap values', async () => {
  const raw = await readFile(INDEX, 'utf8');
  const before = [...raw.matchAll(REF)].map((m) => m[1]);
  assert.ok(before.length >= 25, `expected the full reference set, got ${before.length}`);

  const out = versionIndexHtml(raw, TAG);
  const after = [...out.matchAll(REF)].map((m) => m[1]);
  assert.equal(after.length, before.length, 'no reference is dropped or duplicated');
  for (const url of after) assert.equal(versionOf(url), TAG, `unversioned: ${url}`);
  // the importmap is JSON: its values must be stamped too, and the block must still parse
  assert.ok(out.includes('"preact": "/vendor/preact.module.js?v=' + TAG + '"'));
  const block = /<script type="importmap">([\s\S]*?)<\/script>/.exec(out)[1];
  assert.doesNotThrow(() => JSON.parse(block), 'the importmap stays valid JSON');
});

test('stamping is idempotent and a missing tag is a no-op', async () => {
  const raw = await readFile(INDEX, 'utf8');
  const once = versionIndexHtml(raw, TAG);
  assert.equal(versionIndexHtml(once, TAG), once, 'never double-stamp');
  assert.equal(versionIndexHtml(raw, ''), raw, 'no build tag means the document is served untouched');
  assert.equal(versionIndexHtml(raw, null), raw);
});

test('the served index carries the live build tag and stays revalidatable itself', async (t) => {
  const srv = await startServer({ port: 0, quiet: true });
  t.after(() => srv.close());
  const res = await fetch(`http://127.0.0.1:${srv.port}/`);
  assert.equal(res.status, 200);
  const body = await res.text();
  const health = await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json();
  const tag = health.build;
  assert.ok(tag, 'the server reports a build tag');
  assert.match(tag, /^[0-9a-f]+$/, 'the build tag is a hex hash');
  const stamped = [...body.matchAll(REF)].map((m) => m[1]);
  assert.ok(stamped.length >= 25);
  for (const url of stamped) assert.equal(versionOf(url), tag, `stale tag on ${url}`);
  // the entry document itself must stay revalidatable: it is what carries a new tag after a deploy
  assert.match(res.headers.get('cache-control') || '', /no-cache/);
});

test('a versioned asset request takes the immutable branch', async (t) => {
  const srv = await startServer({ port: 0, quiet: true });
  t.after(() => srv.close());
  const res = await fetch(`http://127.0.0.1:${srv.port}/css/theme.css?v=` + TAG);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /immutable/);
});
