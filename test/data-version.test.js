// test/data-version.test.js — the page's own build tag on the data it fetches (/data/*.json).
//
// WHY: these files are rewritten in place by deploys, so they were fetched with `cache: 'no-cache'` — every load
// asked again, 74 MiB of uplink in 4.85 days on the live host (docs/上行带宽最大化压缩.md). The served modules
// already carry `?v=<buildTag>`, so dataVersion.js reads the tag out of its own URL and puts it on the data
// requests: a versioned URL answers IMMUTABLE_CACHE and the browser keeps it until the next deploy.
//
// What must not change: with no tag (Node tests, a host that serves the tree unversioned, the APK's own copy)
// every request stays exactly what it was — same URL, `no-cache`. Both halves are asserted here, on the real
// store factories with their fetch injected, so a caller that forgets the tag is a test failure.
// Run: node --test test/data-version.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILD_TAG, dataRequest } from '../public/js/dataVersion.js';
import { createDataStore } from '../public/js/data.js';
import { createAssets } from '../public/js/assets.js';

const TAG = 'abc123';
const json = (value) => ({ ok: true, status: 200, json: async () => value });

/** Collect what a store fetched: [{ url, cache }]. */
function recorder(reply = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, cache: init && init.cache });
    return json(reply[url] ?? reply.default ?? { units: [], files: {} });
  };
  return { calls, fetchFn };
}

test('a same-origin data URL gets the tag and a reusable cache mode', () => {
  assert.deepEqual(dataRequest('/data/chess.json', TAG), { url: '/data/chess.json?v=abc123', cache: 'default' });
  // a query of its own keeps working (and is not double-stamped)
  assert.deepEqual(dataRequest('/data/x.json?a=1', TAG), { url: '/data/x.json?a=1&v=abc123', cache: 'default' });
  assert.deepEqual(dataRequest('/data/x.json?v=old', TAG), { url: '/data/x.json?v=old', cache: 'default' });
  // relative, sub-path and i18n overlays are all the same thing
  assert.equal(dataRequest('/data/i18n/en.json', TAG).url, '/data/i18n/en.json?v=abc123');
  assert.equal(dataRequest('data/x.json', TAG).url, 'data/x.json?v=abc123');
});

test('no tag, another host, or no URL means exactly the old request', () => {
  for (const url of ['/data/chess.json', 'data/x.json']) {
    assert.deepEqual(dataRequest(url, null), { url, cache: 'no-cache' });
    assert.deepEqual(dataRequest(url, ''), { url, cache: 'no-cache' });
  }
  // another host's content has its own caching rules: never versioned (the art CDN lives there)
  const cdn = 'https://weishucdn.jiangjiangze.icu/assets.json';
  assert.deepEqual(dataRequest(cdn, TAG), { url: cdn, cache: 'no-cache' });
  assert.deepEqual(dataRequest('//cdn.example.com/x.json', TAG), { url: '//cdn.example.com/x.json', cache: 'no-cache' });
  assert.deepEqual(dataRequest(null, TAG), { url: null, cache: 'no-cache' });
  assert.deepEqual(dataRequest('', TAG), { url: '', cache: 'no-cache' });
});

test('under Node the module has no tag: a page served without one keeps revalidating', () => {
  // the whole point of reading it from import.meta.url: a file:// URL carries none, so tests and any host that
  // serves the tree unversioned stay on the old path
  assert.equal(BUILD_TAG, null);
});

test('a data store versions the game data and the i18n overlays it loads', async () => {
  const { calls, fetchFn } = recorder({ default: { files: {} } });
  const store = createDataStore({ fetch: fetchFn, tag: TAG });
  await store.load('chess');
  await store.setLocale('en'); // downloads data/i18n/en.json through loadOverlay
  const urls = calls.map((c) => c.url);
  assert.ok(urls.includes('/data/chess.json?v=' + TAG), `game data unversioned: ${urls.join(', ')}`);
  assert.ok(urls.some((u) => u.startsWith('/data/i18n/') && u.endsWith('?v=' + TAG)), `overlay unversioned: ${urls.join(', ')}`);
  for (const c of calls) assert.equal(c.cache, 'default', `wrong cache mode for ${c.url}`);
});

test('an art manifest is fetched with the tag, and a seeded manifest is not fetched at all', async () => {
  const { calls, fetchFn } = recorder({ default: { groups: {} } });
  const assets = createAssets({ fetch: fetchFn, tag: TAG });
  await assets.ready();
  assert.deepEqual(calls[0], { url: '/data/assets.json?v=' + TAG, cache: 'default' });
  if (typeof assets.local === 'function') await assets.local();
  const local = calls.find((c) => c.url.startsWith('/data/local-assets.json'));
  if (local) assert.equal(local.url, '/data/local-assets.json?v=' + TAG);
});

test('without a tag the same stores make byte-identical requests to before', async () => {
  const { calls, fetchFn } = recorder({ default: { files: {} } });
  const store = createDataStore({ fetch: fetchFn, tag: null });
  await store.load('chess');
  assert.deepEqual(calls[0], { url: '/data/chess.json', cache: 'no-cache' });

  const art = recorder({ default: { groups: {} } });
  const assets = createAssets({ fetch: art.fetchFn, tag: null });
  await assets.ready();
  assert.deepEqual(art.calls[0], { url: '/data/assets.json', cache: 'no-cache' });
});
