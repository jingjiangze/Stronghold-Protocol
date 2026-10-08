// art-prefetch tests: the real shipped extras file is executed in a vm with a stub DOM + fetch.
//
//   node --test tools/apk/art-prefetch.test.mjs
//
// Contract under test (no-embedded-assets prefetch): the manifest is walked in order and deduped;
// every /assets/** (and CDN-prefixed equivalent) becomes a same-origin fetch; concurrency is capped;
// cancel() stops immediately without error; failures degrade silently (state done, failed counted);
// onProgress fires now + on change; the module is idempotent; and the source stays ES5 + pure ASCII.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'art-prefetch.js'), 'utf8');

const MANIFEST = {
  ui: { a: '/assets/ui/a.png', b: '/assets/ui/b.png' },
  chars: { c: { avatar: '/assets/char/c.png', portrait: '/assets/char/c_1.png' } },
  dup: '/assets/ui/a.png', // duplicate -> deduped
  cdn: 'https://weishucdn.jiangjiangze.icu/assets-re/ui/fromcdn.png', // CDN form -> /assets/ui/fromcdn.png
  other: '/fonts/fonts.css', // not an asset -> ignored
};
const EXPECTED = [
  '/assets/ui/a.png',
  '/assets/ui/b.png',
  '/assets/char/c.png',
  '/assets/char/c_1.png',
  '/assets/ui/fromcdn.png',
];

// ---------------------------------------------------------------- fixtures

function mkEl(tag) {
  const el = {
    tagName: tag, style: {}, children: [], textContent: '', parentNode: null, onclick: null,
    setAttribute() {},
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; },
  };
  return el;
}

function mkDoc() {
  const body = mkEl('body');
  return { body, createElement: mkEl };
}

function mkSched() {
  const timers = [];
  return {
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout(id) { if (id) timers[id - 1] = null; },
    fire() { const t = timers.splice(0, timers.length); for (const fn of t) if (fn) fn(); },
    count() { return timers.filter(Boolean).length; },
  };
}

/**
 * opts.manifest     manifest document (default MANIFEST)
 * opts.manifestFail reject the manifest fetch (offline first launch)
 * opts.manual       asset fetches resolve only via ctl.flush()
 * opts.failSet      Set of asset paths whose fetch rejects
 */
function mkFetch(opts = {}) {
  const calls = [];
  const pending = [];
  let inflight = 0;
  let maxInflight = 0;
  const failSet = opts.failSet || new Set();

  function finishEntry(entry) {
    if (entry.done) return;
    entry.done = true;
    inflight--;
    const i = pending.indexOf(entry);
    if (i >= 0) pending.splice(i, 1);
    if (failSet.has(entry.url)) entry.reject(new Error('boom'));
    else entry.resolve({ ok: true, status: 200, body: null });
  }

  const fetch = (url, init) => {
    calls.push({ url, init });
    if (url === '/data/assets.json') {
      if (opts.manifestFail) return Promise.reject(new Error('offline'));
      const doc = opts.manifest === undefined ? MANIFEST : opts.manifest;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(doc) });
    }
    return new Promise((resolve, reject) => {
      inflight++;
      if (inflight > maxInflight) maxInflight = inflight;
      const entry = { url, resolve, reject, done: false };
      pending.push(entry);
      if (!opts.manual) Promise.resolve().then(() => finishEntry(entry));
    });
  };

  return {
    fetch, calls, pending,
    flush(n = pending.length) { for (let i = 0; i < n && pending.length; i++) finishEntry(pending[0]); },
    assetCalls() { return calls.filter((c) => c.url !== '/data/assets.json').map((c) => c.url); },
    manifestCalls() { return calls.filter((c) => c.url === '/data/assets.json').length; },
    get maxInflight() { return maxInflight; },
  };
}

function mkWorld(opts = {}) {
  const win = {};
  if (opts.noAuto) win.__SP_ART_NO_AUTO = 1;
  const doc = mkDoc();
  const sched = mkSched();
  const net = mkFetch(opts);
  const sandbox = {
    window: win, document: doc, fetch: net.fetch, Promise,
    setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout, console,
  };
  return {
    win, doc, sched, net, sandbox,
    run: () => vm.runInNewContext(SRC, sandbox, { filename: 'art-prefetch.js' }),
  };
}

const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------- cases

test('walks the manifest in order, dedupes, and normalises CDN paths to same-origin', async () => {
  const w = mkWorld({ noAuto: true });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  assert.deepEqual(w.net.assetCalls(), EXPECTED);
  assert.equal(w.win.__SP_ART.total, EXPECTED.length);
  assert.equal(w.win.__SP_ART.done, EXPECTED.length);
  assert.equal(w.win.__SP_ART.failed, 0);
  assert.equal(w.win.__SP_ART.state, 'done');
});

test('caps concurrency (never more than 5 asset fetches in flight)', async () => {
  const many = { g: {} };
  for (let i = 0; i < 20; i++) many.g['k' + i] = '/assets/ui/x' + i + '.png';
  const w = mkWorld({ noAuto: true, manifest: many, manual: true });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  assert.equal(w.net.pending.length, 5, 'exactly the concurrency window is open');
  assert.equal(w.net.maxInflight, 5);
  // draining one opens exactly one more, never a burst
  w.net.flush(1);
  await flush();
  assert.equal(w.net.pending.length, 5);
  assert.equal(w.net.maxInflight, 5);
  for (let i = 0; i < 30 && w.win.__SP_ART.state !== 'done'; i++) { w.net.flush(100); await flush(); }
  assert.equal(w.win.__SP_ART.state, 'done');
  assert.equal(w.win.__SP_ART.done, 20);
});

test('cancel() stops immediately, keeps state cancelled, and starts no new fetches', async () => {
  const many = { g: {} };
  for (let i = 0; i < 20; i++) many.g['k' + i] = '/assets/ui/y' + i + '.png';
  const w = mkWorld({ noAuto: true, manifest: many, manual: true });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  const callsBefore = w.net.calls.length;
  w.win.__SP_ART.cancel();
  assert.equal(w.win.__SP_ART.state, 'cancelled');
  // drain everything that was in flight: no new fetch may be issued
  w.net.flush(100);
  await flush();
  assert.equal(w.net.calls.length, callsBefore, 'cancel must not open new requests');
  assert.equal(w.win.__SP_ART.state, 'cancelled', 'a late settle must not flip the state');
  assert.equal(w.win.__SP_ART.done, 0, 'cancelled runs do not count progress');
});

test('failures degrade silently: done with a failed count, never a throw', async () => {
  const w = mkWorld({ noAuto: true, failSet: new Set(['/assets/ui/b.png', '/assets/char/c_1.png']) });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  assert.equal(w.win.__SP_ART.state, 'done');
  assert.equal(w.win.__SP_ART.failed, 2);
  assert.equal(w.win.__SP_ART.done, EXPECTED.length - 2);
});

test('an unreachable manifest ends in failed without throwing', async () => {
  const w = mkWorld({ noAuto: true, manifestFail: true });
  w.run();
  assert.doesNotThrow(() => w.win.__SP_ART.start());
  await flush();
  assert.equal(w.win.__SP_ART.state, 'failed');
  assert.equal(w.win.__SP_ART.total, 0);
});

test('onProgress fires immediately and on every change, ending at done', async () => {
  const w = mkWorld({ noAuto: true, failSet: new Set(['/assets/ui/a.png']) });
  w.run();
  const seen = [];
  w.win.__SP_ART.onProgress((s) => seen.push(s.state + ':' + s.done + '/' + s.total + ':' + s.failed));
  assert.equal(seen.length, 1, 'the current snapshot is delivered on subscribe');
  assert.equal(seen[0], 'idle:0/0:0');
  w.win.__SP_ART.start();
  await flush();
  assert.ok(seen.length >= 3, 'progress is reported as it advances');
  assert.equal(seen[seen.length - 1], 'done:4/5:1');
});

test('idempotent: re-running the source or calling start() twice does nothing extra', async () => {
  const w = mkWorld({ noAuto: true });
  w.run();
  const first = w.win.__SP_ART;
  w.run(); // second load must be a no-op (guard on window.__SP_ART)
  assert.equal(w.win.__SP_ART, first);
  w.win.__SP_ART.start();
  w.win.__SP_ART.start();
  await flush();
  assert.equal(w.net.manifestCalls(), 1);
  assert.deepEqual(w.net.assetCalls(), EXPECTED);
});

test('auto-starts once after load unless __SP_ART_NO_AUTO is set', async () => {
  const w = mkWorld();
  w.run();
  assert.equal(w.win.__SP_ART.state, 'idle', 'nothing runs synchronously at load');
  assert.equal(w.sched.count(), 1, 'exactly one deferred auto-start is scheduled');
  w.sched.fire();
  await flush();
  assert.equal(w.win.__SP_ART.state, 'done');
});

// ---------------------------------------------------------------- source invariants

test('source invariants: ES5, pure ASCII, no module system / third-party dependency', () => {
  assert.equal(/=>|\bconst\b|\blet\b|\bclass\b/.test(SRC), false, 'must stay ES5 (old WebView)');
  assert.equal(/\bimport\s|\brequire\s*\(/.test(SRC), false, 'no module system');
  assert.equal(/[^\x00-\x7F]/.test(SRC), false, 'must be pure ASCII');
  assert.equal(/\bfetch\s*\(/.test(SRC), true, 'uses fetch');
});
