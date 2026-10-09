// preload-center tests: the real shipped extras file is executed in a vm with a stub DOM + fetch.
//
//   node --test tools/apk/preload-center.test.mjs
//
// Contract under test (browser disk-cache preload center, Paper-Yuan port 2026-10-08):
//   · /data/assets.json is enumerated into two profiles: `core` (UI / avatars / icons / lobby bgm
//     / sfx / fonts) and `full` (the whole set, adding portraits, every Spine model, voices);
//   · the walk reuses art-prefetch.js's policy: concurrency capped at 2, GAP_MS pacing, every
//     fetch marked X-SP-Prefetch, and a full stand-down while a match screen is up / the document
//     is hidden -- the page always wins;
//   · progress is PERSISTED per manifest hash + profile: a reload resumes from the stored cursor
//     instead of re-fetching the settled entries;
//   · the default auto-start is `core` only, and is SKIPPED when art-prefetch.js is present (it
//     already walks the full set) or window.__SP_PRELOAD_NO_AUTO is set;
//   · CacheStorage (caches) is used when present: a match() hit is counted with no network, and
//     verify() / clear() act on the bucket;
//   · the module is idempotent and the source stays ES5 + pure ASCII.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'preload-center.js'), 'utf8');

const MANIFEST = {
  version: 1,
  hash: 'ph1',
  ui: { a: '/assets/ui/a.png', b: '/assets/ui/b.png' },
  chars: {
    c: {
      avatar: '/assets/char/avatar/c.png',
      portrait: '/assets/char/portrait/c_1.png',
      spine: { front: { skel: '/assets/spine/op/c/front/c.skel', atlas: '/assets/spine/op/c/front/c.atlas', textures: ['/assets/spine/op/c/front/c.png'] } },
    },
  },
  tokens: { t: { avatar: '/assets/token/avatar/t.png', spine: { skel: '/assets/spine/token/t/t.skel' } } },
  enemies: { e: { icon: '/assets/enemy/icon/e.png', spine: { skel: '/assets/spine/enemy/e/e.skel' } } },
  items: { i: '/assets/item/i.png' },
  audio: { bgm: { lobby: '/assets/audio/bgm/lobby.mp3' }, sfx: { s: '/assets/audio/sfx/s.mp3' }, voice: { v: '/assets/audio/voice/v.mp3' } },
  fonts: { css: '/fonts/fonts.css' },
  dup: '/assets/ui/a.png',                                              // duplicate -> deduped
  cdn: 'https://cdn.example.com/assets-re/ui/fromcdn.png',              // CDN form -> same-origin
  other: '/js/main.js',                                                 // not an asset -> ignored
};
const CORE_EXPECTED = [
  '/assets/ui/a.png', '/assets/ui/b.png', '/assets/ui/fromcdn.png',
  '/assets/char/avatar/c.png', '/assets/token/avatar/t.png', '/assets/enemy/icon/e.png',
  '/assets/item/i.png', '/assets/audio/bgm/lobby.mp3', '/assets/audio/sfx/s.mp3', '/fonts/fonts.css',
];
const FULL_EXPECTED = CORE_EXPECTED.concat([
  '/assets/char/portrait/c_1.png',
  '/assets/spine/op/c/front/c.skel', '/assets/spine/op/c/front/c.atlas', '/assets/spine/op/c/front/c.png',
  '/assets/spine/token/t/t.skel', '/assets/spine/enemy/e/e.skel', '/assets/audio/voice/v.mp3',
]);

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
  const doc = {
    body, createElement: mkEl, visibilityState: 'visible', matchScreens: 0,
    querySelector() { return doc.matchScreens > 0 ? { sel: 1 } : null; },
  };
  return doc;
}

function mkSched() {
  let clock = 1000000;
  const timers = [];
  const delays = [];
  return {
    delays,
    now() { return clock; },
    setTimeout(fn, ms) { timers.push({ at: clock + (ms || 0), fn, alive: true }); delays.push(ms || 0); return timers.length; },
    clearTimeout(id) { const t = timers[id - 1]; if (t) t.alive = false; },
    fire() {
      for (let guard = 0; guard < 5000; guard++) {
        const live = timers.filter((t) => t.alive);
        if (!live.length) return;
        live.sort((a, b) => a.at - b.at);
        const t = live[0];
        if (t.at > clock) clock = t.at;
        t.alive = false;
        t.fn();
      }
    },
    count() { return timers.filter((t) => t.alive).length; },
  };
}

function mkStorage() {
  const map = new Map();
  return {
    map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

function mkCaches(opts = {}) {
  const stores = new Map();
  const stats = { matchCalls: 0, puts: 0 };
  const perFile = opts.bytesPerFile === undefined ? 1024 : opts.bytesPerFile;
  return {
    deleted: [],
    stats,
    open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return Promise.resolve({
        match: (url) => { stats.matchCalls++; return Promise.resolve(store.has(url) ? { url, headers: { get: () => String(perFile) } } : null); },
        put: (url, res) => { stats.puts++; store.set(url, res); return Promise.resolve(); },
        keys: () => Promise.resolve(Array.from(store.keys())),
      });
    },
    delete(name) { this.deleted.push(name); stores.delete(name); return Promise.resolve(true); },
    seed(name, urls) { if (!stores.has(name)) stores.set(name, new Map()); for (const u of urls) stores.get(name).set(u, { url: u }); },
  };
}

/** Stub of the shell-bridge art-cache capability (window.__SP_SHELL as shell-bridge.js exposes it).
 *  opts.cachedFiles / opts.cachedBytes / opts.pending: the JSON ShellBridge.artCacheStatus() returns;
 *  opts.status: a function returning the status object (to vary it between polls). */
function mkBridge(opts = {}) {
  const calls = { status: 0, clear: 0, sync: 0 };
  const base = {
    ok: true,
    manifestHash: opts.manifestHash === undefined ? 'bh1' : opts.manifestHash,
    cachedFiles: opts.cachedFiles === undefined ? 0 : opts.cachedFiles,
    cachedBytes: opts.cachedBytes === undefined ? 0 : opts.cachedBytes,
    cacheRoot: opts.cacheRoot === undefined ? 'art/cache/bh1' : opts.cacheRoot,
    pending: opts.pending === undefined ? -1 : opts.pending,
  };
  const shell = {
    artCacheBridge: true,
    artCacheStatus() {
      calls.status++;
      return JSON.stringify(typeof opts.status === 'function' ? opts.status() : base);
    },
    clearArtCache() {
      calls.clear++;
      return JSON.stringify(opts.clearResult || { ok: true, removedFiles: 3, removedBytes: 4096, keptPacks: true });
    },
  };
  // The pack channel's status bridge (2026-10-09): only a NEW APK has it, and only then may the
  // panel render the download/unpack speed lines. opts.sync = the pack status object (or a function).
  if (opts.sync) {
    shell.artSyncBridge = true;
    shell.artSyncStatus = function () {
      calls.sync++;
      return JSON.stringify(typeof opts.sync === 'function' ? opts.sync() : opts.sync);
    };
  }
  return { shell, calls, base };
}

/** Concatenated text of a stub element tree (the modal + its lines). */
function treeText(el) {
  if (!el) return '';
  let s = el.textContent || '';
  for (const c of el.children || []) s += '\n' + treeText(c);
  return s;
}

/** opts.manifest  manifest document (default MANIFEST)
 *  opts.manual    asset fetches resolve only via net.flush()
 *  opts.failSet   asset paths whose fetch rejects (transient)
 *  opts.deadSet   asset paths answered with 404 (permanent) */
function mkFetch(opts = {}) {
  const calls = [];
  const pending = [];
  let inflight = 0;
  let maxInflight = 0;
  const failSet = opts.failSet || new Set();
  const deadSet = opts.deadSet || new Set();

  function finishEntry(entry) {
    if (entry.done) return;
    entry.done = true;
    inflight--;
    const i = pending.indexOf(entry);
    if (i >= 0) pending.splice(i, 1);
    if (failSet.has(entry.url)) entry.reject(new Error('boom'));
    else if (deadSet.has(entry.url)) entry.resolve({ ok: false, status: 404, headers: { get: () => null }, body: null });
    else entry.resolve({ ok: true, status: 200, headers: { get: (h) => (String(h).toLowerCase() === 'content-length' ? '1024' : null) }, body: null });
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
    get maxInflight() { return maxInflight; },
  };
}

function mkWorld(opts = {}) {
  const win = {};
  if (opts.noAuto) win.__SP_PRELOAD_NO_AUTO = 1;
  if (opts.bridge) win.__SP_SHELL = opts.bridge;
  if (opts.art) {
    win.__SP_ART = {
      started: 0,
      start() { win.__SP_ART.started++; },
      onProgress(cb) { win.__SP_ART._cb = cb; },
      state() { return opts.artState || { state: 'running', done: 3, total: 9, failed: 0 }; },
    };
  }
  const doc = mkDoc();
  const sched = mkSched();
  const net = mkFetch(opts);
  const sandbox = {
    window: win, document: doc, fetch: net.fetch, Promise,
    setTimeout: sched.setTimeout.bind(sched), clearTimeout: sched.clearTimeout.bind(sched), console,
    Date: { now: () => sched.now() },
    localStorage: opts.localStorage || mkStorage(),
    sessionStorage: opts.sessionStorage || mkStorage(),
  };
  if (opts.caches) sandbox.caches = opts.caches;
  return { win, doc, sched, net, sandbox, run: () => vm.runInNewContext(SRC, sandbox, { filename: 'preload-center.js' }) };
}

const flush = () => new Promise((r) => setImmediate(r));

async function drain(w, max = 800) {
  for (let i = 0; i < max; i++) {
    await flush();
    const api = w.win.__SP_PRELOAD;
    if (['done', 'failed'].includes(api.phase) && !w.sched.count()) return;
    if (!w.sched.count() && !w.net.pending.length) return;
    w.net.flush();
    w.sched.fire();
  }
}

// ---------------------------------------------------------------- cases

test('exposes the API, is idempotent, and stays ES5 + pure ASCII', () => {
  const w = mkWorld({ noAuto: true });
  w.run();
  const api = w.win.__SP_PRELOAD;
  assert.ok(api, '__SP_PRELOAD is exported');
  for (const k of ['state', 'profiles', 'start', 'pause', 'resume', 'clear', 'verify', 'open', 'close', 'onProgress']) {
    assert.equal(typeof api[k], 'function', 'API.' + k + ' is a function');
  }
  assert.equal(api.phase, 'idle');
  // idempotent: a second evaluation must not replace the instance
  const before = w.win.__SP_PRELOAD;
  w.run();
  assert.equal(w.win.__SP_PRELOAD, before, 'second load is a no-op');
  // ES5 + ASCII (checked against the code with comments stripped: comments are documentation)
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(!/=>/.test(code), 'no arrow functions');
  assert.ok(!/`/.test(code), 'no template literals');
  assert.ok(!/(^|[^\w.])(let|const)\s/.test(code), 'no let/const');
  assert.ok(!/[^\x00-\x7F]/.test(SRC), 'pure ASCII');
});

test('enumerates the manifest into core (subset) and full (superset) profiles', async () => {
  const w = mkWorld({ noAuto: true });
  w.run();
  w.win.__SP_PRELOAD.start('core');
  await flush(); // the manifest lands
  const p = w.win.__SP_PRELOAD.profiles();
  assert.deepEqual(Array.from(p.map((x) => x.id)), ['core', 'full']);
  assert.equal(p[0].total, CORE_EXPECTED.length);
  assert.equal(p[1].total, FULL_EXPECTED.length);
  assert.ok(p[0].total < p[1].total, 'core is a strict subset of full');
  w.win.__SP_PRELOAD.cancel();
});

test('start("core") walks only the core subset and completes', async () => {
  const w = mkWorld({ noAuto: true });
  w.run();
  w.win.__SP_PRELOAD.start('core');
  await flush();
  assert.equal(w.win.__SP_PRELOAD.total, CORE_EXPECTED.length);
  await drain(w);
  assert.deepEqual(w.net.assetCalls().slice().sort(), CORE_EXPECTED.slice().sort());
  assert.equal(w.win.__SP_PRELOAD.done, CORE_EXPECTED.length);
  assert.equal(w.win.__SP_PRELOAD.phase, 'done');
  assert.equal(w.win.__SP_PRELOAD.failedCount, 0);
});

test('start("full") walks the whole set', async () => {
  const w = mkWorld({ noAuto: true });
  w.run();
  w.win.__SP_PRELOAD.start('full');
  await drain(w);
  assert.deepEqual(w.net.assetCalls().slice().sort(), FULL_EXPECTED.slice().sort());
  assert.equal(w.win.__SP_PRELOAD.done, FULL_EXPECTED.length);
});

test('every asset fetch is marked X-SP-Prefetch and never touches a non-same-origin host', async () => {
  const w = mkWorld({ noAuto: true });
  w.run();
  w.win.__SP_PRELOAD.start('full');
  await drain(w);
  for (const c of w.net.calls.filter((x) => x.url.startsWith('/assets/') || x.url.startsWith('/fonts/'))) {
    assert.equal(c.init.headers['X-SP-Prefetch'], '1', 'marked: ' + c.url);
    assert.ok(c.url.startsWith('/'), 'same-origin path: ' + c.url);
  }
});

test('caps concurrency at 2 and paces the dispatches (never a burst at the page)', async () => {
  const many = { g: {} };
  for (let i = 0; i < 20; i++) many.g['k' + i] = '/assets/ui/x' + i + '.png';
  const w = mkWorld({ noAuto: true, manifest: many, manual: true });
  w.run();
  w.win.__SP_PRELOAD.start('core');
  await flush();
  assert.equal(w.net.pending.length, 1, 'the pacing gate releases one dispatch per gap');
  w.sched.fire();
  await flush();
  assert.equal(w.net.pending.length, 2, 'the window is full at 2');
  assert.equal(w.net.maxInflight, 2);
  w.sched.fire();
  await flush();
  assert.equal(w.net.pending.length, 2, 'the window, not the queue length, bounds concurrency');
  for (let i = 0; i < 600 && w.win.__SP_PRELOAD.phase !== 'done'; i++) { w.net.flush(100); w.sched.fire(); await flush(); }
  assert.equal(w.win.__SP_PRELOAD.phase, 'done');
  assert.equal(w.win.__SP_PRELOAD.done, 20);
});

test('stands down while a match screen is up and resumes when it goes away', async () => {
  const many = { g: {} };
  for (let i = 0; i < 12; i++) many.g['k' + i] = '/assets/ui/m' + i + '.png';
  const w = mkWorld({ noAuto: true, manifest: many, manual: true });
  w.run();
  w.doc.matchScreens = 1;
  w.win.__SP_PRELOAD.start('core');
  await flush();
  assert.equal(w.net.pending.length, 0, 'not one request while the page owns the screen');
  assert.equal(w.win.__SP_PRELOAD.state().paused, 1);
  w.sched.fire();
  await flush();
  assert.equal(w.net.pending.length, 0, 'still standing down after the poll');
  w.doc.matchScreens = 0;
  w.sched.fire();
  await flush();
  assert.ok(w.net.pending.length >= 1, 'the walk resumed');
  assert.equal(w.win.__SP_PRELOAD.state().paused, 0);
  for (let i = 0; i < 200 && w.win.__SP_PRELOAD.phase !== 'done'; i++) { w.net.flush(100); w.sched.fire(); await flush(); }
  assert.equal(w.win.__SP_PRELOAD.phase, 'done');
  assert.equal(w.win.__SP_PRELOAD.done, 12);
});

test('persists progress per manifest hash + profile and resumes without re-fetching', async () => {
  const storage = mkStorage();
  const a = mkWorld({ noAuto: true, localStorage: storage });
  a.run();
  a.win.__SP_PRELOAD.start('core');
  await drain(a);
  assert.equal(a.win.__SP_PRELOAD.done, CORE_EXPECTED.length);
  assert.ok(storage.getItem('sp.preload.v1'), 'a record was written');

  // "reload": a fresh sandbox sharing the same storage must continue, not restart
  const b = mkWorld({ noAuto: true, localStorage: storage });
  b.run();
  b.win.__SP_PRELOAD.start('core');
  await flush();
  await drain(b);
  assert.equal(b.win.__SP_PRELOAD.state().resumed, true, 'resumed from the stored record');
  assert.deepEqual(b.net.assetCalls(), [], 'no settled entry is re-fetched');
  assert.equal(b.win.__SP_PRELOAD.done, CORE_EXPECTED.length);
});

test('uses CacheStorage when present: a hit is counted with no network', async () => {
  const caches = mkCaches();
  caches.seed('stronghold-preload-v1', ['/assets/ui/a.png', '/assets/ui/b.png']);
  const w = mkWorld({ noAuto: true, caches });
  w.run();
  w.win.__SP_PRELOAD.start('core');
  await drain(w);
  assert.equal(w.win.__SP_PRELOAD.done, CORE_EXPECTED.length);
  assert.ok(!w.net.assetCalls().includes('/assets/ui/a.png'), 'a CacheStorage hit is not re-fetched');
  assert.ok(w.win.__SP_PRELOAD.state().cacheOpen, 'the bucket is open');
});

test('verify() reports present/missing against the bucket; clear() drops it', async () => {
  const caches = mkCaches();
  const w = mkWorld({ noAuto: true, caches });
  w.run();
  w.win.__SP_PRELOAD.start('core');
  await drain(w);
  const report = await w.win.__SP_PRELOAD.verify('core');
  assert.equal(report.ok, true);
  assert.equal(report.total, CORE_EXPECTED.length);
  assert.equal(report.present, CORE_EXPECTED.length, 'everything the walk stored verifies');
  assert.equal(report.missing, 0);

  await w.win.__SP_PRELOAD.clear();
  assert.ok(caches.deleted.includes('stronghold-preload-v1'), 'the bucket was deleted');
  assert.equal(w.win.__SP_PRELOAD.state().cached.core, false);
  const after = await w.win.__SP_PRELOAD.verify('core');
  assert.equal(after.present, 0, 'nothing is cached after a clear');
});

test('fallback auto-start walks the FULL set (no art-prefetch present), and stands down when it is', async () => {
  // (a) no __SP_ART -> this center is the only engine, so it auto-starts the FULL profile (owner's
  // default is the complete set; it used to start CORE, which left the heavy art to nobody).
  const a = mkWorld({});
  a.run();
  a.sched.fire(); // the idle callback (a 1500 ms timer) fires
  await flush();
  assert.equal(a.win.__SP_PRELOAD.phase !== 'idle', true, 'the background full preload auto-started');
  await drain(a);
  assert.equal(a.win.__SP_PRELOAD.done, FULL_EXPECTED.length);
  assert.deepEqual(a.net.assetCalls().slice().sort(), FULL_EXPECTED.slice().sort());

  // (b) __SP_ART present -> the center stands down (art-prefetch is the single walker and it
  // self-starts the full walk at load; a second engine would re-request the same files).
  const b = mkWorld({ art: true });
  b.run();
  b.sched.fire();
  await flush();
  assert.equal(b.win.__SP_PRELOAD.phase, 'idle', 'no auto walk when art-prefetch is present');
  assert.equal(b.net.assetCalls().length, 0);
});

test('no pill, no auto-opened panel: the preload UI only appears when asked for', async () => {
  const w = mkWorld({ art: true });
  w.run();
  w.sched.fire();
  await flush();
  assert.equal(w.doc.body.children.length, 0, 'nothing is mounted on load (no pill, no modal)');
  assert.equal(typeof w.win.__SP_PRELOAD.show, 'undefined', 'the old pill handle is gone');
  assert.equal(typeof w.win.__SP_PRELOAD.hide, 'undefined');
  assert.equal(typeof w.win.__SP_PRELOAD.open, 'function', 'the panel is still reachable on demand');
  w.win.__SP_PRELOAD.open();
  assert.equal(w.doc.body.children.length, 1, 'the panel mounts only when open() is called');
  w.win.__SP_PRELOAD.close();
  assert.equal(w.doc.body.children.length, 0);
});

test('core also delegates to art-prefetch.js when it is present (one walker, no second engine)', async () => {
  const w = mkWorld({ noAuto: true, art: true });
  w.run();
  w.win.__SP_PRELOAD.start('core');
  await flush();
  assert.equal(w.win.__SP_ART.started, 1, 'the existing full-set walker was reused');
  assert.equal(w.win.__SP_PRELOAD.state().delegated, true);
  assert.equal(w.net.assetCalls().length, 0, 'no second walker was started');
});

test('full delegates to art-prefetch.js when it is present', async () => {
  const w = mkWorld({ noAuto: true, art: true });
  w.run();
  w.win.__SP_PRELOAD.start('full');
  await flush();
  assert.equal(w.win.__SP_ART.started, 1, 'the existing full-set walker was reused');
  assert.equal(w.win.__SP_PRELOAD.state().delegated, true);
  assert.equal(w.net.assetCalls().length, 0, 'no second walker was started');
});

test('a failed manifest surfaces as a failed run without throwing', async () => {
  const w = mkWorld({ noAuto: true, manifestFail: true });
  w.run();
  w.win.__SP_PRELOAD.start('core');
  for (let i = 0; i < 20; i++) { await flush(); w.sched.fire(); }
  assert.equal(w.win.__SP_PRELOAD.phase, 'failed');
  assert.equal(w.net.assetCalls().length, 0);
});

// ------------------------------------------------- Android art-cache bridge (2026-10-08 field report)
// The real on-disk cache is Android's (filesDir/art/cache/<hash>/), read through ShellBridge's
// artCacheStatus()/clearArtCache(). These cases pin the panel's three numbers and that verify()/
// clear() act on the Android store when the bridge is present and only fall back to CacheStorage
// (the old, wrong store) when it is not.

test('delegated mode reports the Android cachedBytes instead of a hardcoded 0', async () => {
  const b = mkBridge({ cachedBytes: 100 * 1048576, cachedFiles: 7969 });
  const w = mkWorld({ noAuto: true, art: true, bridge: b.shell });
  w.run();
  w.win.__SP_PRELOAD.start('full');
  await flush();
  const st = w.win.__SP_PRELOAD.state();
  assert.equal(st.delegated, true);
  assert.equal(st.store, 'android', 'the numbers describe the Android cache');
  assert.ok(b.calls.status >= 1, 'the bridge was polled on start');
  assert.equal(st.bytes, 100 * 1048576, 'the Android number is shown, not a hardcoded 0');
  w.win.__SP_PRELOAD.open();
  await flush();
  const txt = treeText(w.doc.body.children[0]);
  assert.match(txt, /\u56DE\u6E90\u7F13\u5B58\uFF1A100\.0 MB/, 'the panel shows 回源缓存：100.0 MB');
  assert.doesNotMatch(txt, /\u6D4F\u89C8\u5668\u7F13\u5B58\uFF1A/, 'never the web label when the bridge is live');
});

test('reports 0 bytes honestly when the bridge itself says 0', async () => {
  const b = mkBridge({ cachedBytes: 0, cachedFiles: 0 });
  const w = mkWorld({ noAuto: true, art: true, bridge: b.shell });
  w.run();
  w.win.__SP_PRELOAD.start('full');
  await flush();
  w.win.__SP_PRELOAD.open();
  await flush();
  assert.equal(w.win.__SP_PRELOAD.state().bytes, 0);
  assert.match(treeText(w.doc.body.children[0]), /\u56DE\u6E90\u7F13\u5B58\uFF1A0\.0 MB/, '回源缓存：0.0 MB');
});

test('the panel renders the owner block while preloading (three self-explanatory numbers)', async () => {
  const b = mkBridge({ cachedBytes: 0, cachedFiles: 0 });
  const artState = { state: 'running', done: 5415, total: 7969, failed: 0, localFiles: 5415 };
  const w = mkWorld({ noAuto: true, art: true, bridge: b.shell, artState });
  w.run();
  w.win.__SP_PRELOAD.start('full');
  await flush();
  w.win.__SP_PRELOAD.open();
  await flush();
  const txt = treeText(w.doc.body.children[0]);
  assert.match(txt, /\u6B63\u5728\u540E\u53F0\u9884\u8F7D\u2026/, '正在后台预载…');
  assert.match(txt, /\u672C\u5730\u53EF\u7528\uFF1A5415 \/ 7969/, '本地可用：5415 / 7969');
  assert.match(txt, /\u56DE\u6E90\u7F13\u5B58\uFF1A0\.0 MB/, '回源缓存：0.0 MB');
  assert.match(txt, /\u5F85\u9884\u8F7D\uFF1A2554/, '待预载：2554');
  const st = w.win.__SP_PRELOAD.state();
  assert.deepEqual(
    { done: st.done, total: st.total, pending: st.pending, localFiles: st.localFiles },
    { done: 5415, total: 7969, pending: 2554, localFiles: 5415 }
  );
});

test('the panel renders the owner block when finished (no pending line)', async () => {
  const b = mkBridge({ cachedBytes: 374131916, cachedFiles: 7969 });
  const artState = { state: 'done', done: 7969, total: 7969, failed: 0, localFiles: 5415 };
  const w = mkWorld({ noAuto: true, art: true, bridge: b.shell, artState });
  w.run();
  w.win.__SP_PRELOAD.start('full');
  await flush();
  w.win.__SP_PRELOAD.open();
  await flush();
  const txt = treeText(w.doc.body.children[0]);
  assert.match(txt, /\u8D44\u6E90\u9884\u8F7D\u5B8C\u6210/, '资源预载完成');
  assert.match(txt, /\u672C\u5730\u53EF\u7528\uFF1A7969 \/ 7969/, '本地可用：7969 / 7969');
  assert.match(txt, /\u56DE\u6E90\u7F13\u5B58\uFF1A356\.8 MB/, '回源缓存：356.8 MB');
  assert.doesNotMatch(txt, /\u5F85\u9884\u8F7D\uFF1A/, 'no pending line when finished');
});

// ---------------------------------------------------------------- speeds (owner ask 2026-10-09)

// The owner's ask: the preload progress must show its speeds -- download, unpack and preload speed.
// Two channels, never mixed: the walk's numbers are mirrored from art-prefetch, the pack channel's
// (download + UNPACK) only exist on an APK whose shell exposes ShellBridge.artSyncStatus().
test('speeds: the panel shows download / unpack / preload speeds + the ETA', async () => {
  const b = mkBridge({
    cachedBytes: 1048576,
    sync: {
      ok: true, active: true, stage: 'unzip', pack: 'audio.voice.3',
      packsDone: 2, packsTotal: 4, bytesDone: 1048576, bytesTotal: 4194304,
      dlBps: 1048576, unzipBps: 3145728, etaMs: 120000,
    },
  });
  const artState = {
    state: 'running', done: 5, total: 20, failed: 0, localFiles: 0,
    bytes: 5242880, bytesKnown: true, bps: 2097152, avgBps: 1048576,
    filesPerSec: 4, avgFilesPerSec: 3, etaMs: 60000, elapsedMs: 20000,
  };
  const w = mkWorld({ noAuto: true, art: true, bridge: b.shell, artState });
  w.run();
  w.win.__SP_PRELOAD.start('full');
  await flush();
  w.win.__SP_PRELOAD.open();
  await flush();
  const txt = treeText(w.doc.body.children[0]);
  assert.match(txt, /\u4E0B\u8F7D\u901F\u5EA6\uFF1A2\.0 MB\/s\uFF08\u5E73\u5747 1\.0 MB\/s\uFF09/, '下载速度：' + txt);
  assert.match(txt, /\u5305\u901A\u9053 1\.0 MB\/s/, 'the pack channel reads its own rate: ' + txt);
  assert.match(txt, /\u89E3\u538B\u901F\u5EA6\uFF1A3\.0 MB\/s\uFF08\u5305\u901A\u9053 2\/4\uFF09/, '解压速度：' + txt);
  assert.match(txt, /\u9884\u8F7D\u901F\u5EA6\uFF1A4\.0 \u6587\u4EF6\/\u79D2\uFF08\u5E73\u5747 3\.0 \u6587\u4EF6\/\u79D2\uFF09/, '预载速度：' + txt);
  assert.match(txt, /\u9884\u8BA1\u5269\u4F59\uFF1A1 \u5206 00 \u79D2\uFF08\u5DF2\u7528 20 \u79D2\uFF09/, '预计剩余：' + txt);
  assert.ok(b.calls.sync >= 1, 'the pack bridge was polled');
  const st = w.win.__SP_PRELOAD.state();
  assert.equal(st.rates.bps, 2097152, 'the walk rate is mirrored, never recomputed');
  assert.equal(st.rates.bytesKnown, true);
  assert.equal(st.pack.unzipBps, 3145728);
  assert.equal(st.pack.packsDone, 2);
  w.win.__SP_PRELOAD.close();
});

test('speeds: no pack bridge -> no unpack line, the walk rate still renders', async () => {
  const b = mkBridge({}); // an APK with the cache bridge only (no artSyncStatus)
  const artState = {
    state: 'running', done: 5, total: 20, failed: 0,
    bytes: 5242880, bytesKnown: true, bps: 2097152, avgBps: 1048576,
    filesPerSec: 4, avgFilesPerSec: 0, etaMs: 60000, elapsedMs: 20000,
  };
  const w = mkWorld({ noAuto: true, art: true, bridge: b.shell, artState });
  w.run();
  w.win.__SP_PRELOAD.start('full');
  await flush();
  w.win.__SP_PRELOAD.open();
  await flush();
  const txt = treeText(w.doc.body.children[0]);
  assert.match(txt, /\u4E0B\u8F7D\u901F\u5EA6\uFF1A2\.0 MB\/s/, 'the walk rate renders: ' + txt);
  assert.doesNotMatch(txt, /\u89E3\u538B\u901F\u5EA6/, 'no unpack line without the pack bridge');
  assert.doesNotMatch(txt, /\u5305\u901A\u9053/, 'no pack-channel figure without the pack bridge');
  assert.equal(w.win.__SP_PRELOAD.state().pack, null, 'pack is null, never a guessed object');
  w.win.__SP_PRELOAD.close();
});

test('speeds: an unknown size hides the byte rate instead of showing a zero', async () => {
  const b = mkBridge({});
  const artState = {
    state: 'running', done: 5, total: 20, failed: 0,
    bytes: 0, bytesKnown: false, bps: 0, avgBps: 0,
    filesPerSec: 4, avgFilesPerSec: 0, etaMs: 60000, elapsedMs: 20000,
  };
  const w = mkWorld({ noAuto: true, art: true, bridge: b.shell, artState });
  w.run();
  w.win.__SP_PRELOAD.start('full');
  await flush();
  w.win.__SP_PRELOAD.open();
  await flush();
  const txt = treeText(w.doc.body.children[0]);
  assert.doesNotMatch(txt, /B\/s/, 'no byte rate is drawn from thin air: ' + txt);
  assert.match(txt, /\u9884\u8F7D\u901F\u5EA6\uFF1A4\.0 \u6587\u4EF6\/\u79D2/, 'files/s is the honest fallback');
  assert.equal(w.win.__SP_PRELOAD.state().rates.bytesKnown, false);
  w.win.__SP_PRELOAD.close();
});

test('speeds: the pack line stays hidden on the plain web (no bridge at all)', async () => {
  const artState = {
    state: 'running', done: 5, total: 20, failed: 0,
    bytes: 5242880, bytesKnown: true, bps: 2097152, avgBps: 0,
    filesPerSec: 4, avgFilesPerSec: 0, etaMs: 60000, elapsedMs: 20000,
  };
  const w = mkWorld({ noAuto: true, art: true, artState });
  w.run();
  w.win.__SP_PRELOAD.start('full');
  await flush();
  w.win.__SP_PRELOAD.open();
  await flush();
  const txt = treeText(w.doc.body.children[0]);
  assert.match(txt, /\u4E0B\u8F7D\u901F\u5EA6\uFF1A2\.0 MB\/s/, 'the walk rate still renders: ' + txt);
  assert.doesNotMatch(txt, /\u5305\u901A\u9053/, 'no pack channel on the web');
  assert.equal(w.win.__SP_PRELOAD.state().pack, null);
  w.win.__SP_PRELOAD.close();
});

test('the bridge is polled at most once per second and forced once on open', async () => {
  const b = mkBridge({ cachedBytes: 7 });
  const w = mkWorld({ noAuto: true, art: true, bridge: b.shell });
  w.run();
  w.win.__SP_PRELOAD.start('full');
  await flush();
  const afterStart = b.calls.status;
  assert.equal(afterStart, 1, 'exactly one poll on start (the virtual clock never advanced)');
  for (let i = 0; i < 5; i++) w.win.__SP_PRELOAD.state(); // repeated reads inside the window
  assert.equal(b.calls.status, afterStart, 'reads inside the window do not re-poll');
  w.win.__SP_PRELOAD.open(); // opening forces one poll
  assert.equal(b.calls.status, afterStart + 1, 'open() forces a single refresh');
});

test('verify() uses the Android bridge (one O(1) call, no per-file sweep) when present', async () => {
  const caches = mkCaches();
  const b = mkBridge({ cachedFiles: 4, cachedBytes: 2048, manifestHash: 'bh1' });
  const w = mkWorld({ noAuto: true, art: true, bridge: b.shell, caches });
  w.run();
  w.win.__SP_PRELOAD.start('full');
  await flush();
  const before = b.calls.status;
  const report = await w.win.__SP_PRELOAD.verify('full');
  assert.equal(report.store, 'android', 'the report names the store it verified');
  assert.equal(report.ok, true);
  assert.equal(report.present, 4);
  assert.equal(report.missing, FULL_EXPECTED.length - 4);
  assert.equal(report.manifestHash, 'bh1');
  assert.equal(report.cacheRoot, 'art/cache/bh1');
  assert.ok(b.calls.status > before, 'the bridge was called');
  assert.equal(caches.stats.matchCalls, 0, 'no per-file CacheStorage hash/size sweep');
  assert.equal(w.net.assetCalls().length, 0, 'verify starts no walker');
});

test('verify() falls back to CacheStorage when there is no bridge', async () => {
  const caches = mkCaches();
  const w = mkWorld({ noAuto: true, caches }); // no bridge, no art: the own engine runs
  w.run();
  w.win.__SP_PRELOAD.start('core');
  await drain(w);
  const report = await w.win.__SP_PRELOAD.verify('core');
  assert.equal(report.store, 'cachestorage');
  assert.equal(report.present, CORE_EXPECTED.length);
  assert.ok(caches.stats.matchCalls >= CORE_EXPECTED.length, 'the bucket is scanned path by path');
});

test('clear() calls clearArtCache() and never touches CacheStorage or the packs store', async () => {
  const caches = mkCaches();
  const b = mkBridge({ cachedBytes: 5000, cachedFiles: 3 });
  const w = mkWorld({ noAuto: true, art: true, bridge: b.shell, caches });
  w.run();
  w.win.__SP_PRELOAD.start('full');
  await flush();
  const rep = await w.win.__SP_PRELOAD.clear();
  assert.equal(b.calls.clear, 1, 'the Android clear was called exactly once');
  assert.equal(rep.ok, true);
  assert.equal(rep.store, 'android');
  assert.equal(rep.keptPacks, true, 'the signed packs are reported untouched');
  assert.deepEqual(caches.deleted, [], 'the page never deletes its own bucket when the bridge exists');
  assert.equal(w.win.__SP_PRELOAD.state().bytes, 0, 'the numbers refresh to 0 immediately');
  assert.equal(w.net.assetCalls().length, 0, 'no second walker was started');
});

test('clear() falls back to deleting the CacheStorage bucket on the web', async () => {
  const caches = mkCaches();
  const w = mkWorld({ noAuto: true, caches });
  w.run();
  w.win.__SP_PRELOAD.start('core');
  await drain(w);
  const rep = await w.win.__SP_PRELOAD.clear();
  assert.equal(rep.store, 'cachestorage');
  assert.ok(caches.deleted.includes('stronghold-preload-v1'), 'the web bucket was deleted');
});

test('no-bridge web fallback labels the byte figure 浏览器缓存, never 回源缓存', async () => {
  const caches = mkCaches({ bytesPerFile: 1048576 });
  const w = mkWorld({ noAuto: true, caches });
  w.run();
  w.win.__SP_PRELOAD.start('core');
  await drain(w);
  w.win.__SP_PRELOAD.open();
  await flush(); await flush();
  const st = w.win.__SP_PRELOAD.state();
  assert.equal(st.store, 'cachestorage');
  assert.equal(st.bytes, CORE_EXPECTED.length * 1048576, 'the real CacheStorage bytes are shown');
  const txt = treeText(w.doc.body.children[0]);
  assert.match(txt, /\u6D4F\u89C8\u5668\u7F13\u5B58\uFF1A10\.0 MB/, '浏览器缓存：10.0 MB');
  assert.doesNotMatch(txt, /\u56DE\u6E90\u7F13\u5B58\uFF1A/, 'never dressed up as the Android number');
});

test('the new bridge paths never start a second walker (PR #110 invariant)', async () => {
  const b = mkBridge({ cachedBytes: 1234, cachedFiles: 2 });
  const w = mkWorld({ noAuto: true, art: true, bridge: b.shell, caches: mkCaches() });
  w.run();
  w.win.__SP_PRELOAD.start('full');
  await flush();
  assert.equal(w.win.__SP_ART.started, 1, 'the single walker was started exactly once');
  w.win.__SP_PRELOAD.open();
  await flush();
  await w.win.__SP_PRELOAD.verify('full');
  await w.win.__SP_PRELOAD.clear();
  assert.equal(w.win.__SP_ART.started, 1, 'open/verify/clear never start a walker');
  assert.equal(w.net.assetCalls().length, 0, 'no asset fetch from the panel actions');
});

test('opening the panel while art is present is delegated: no pause button, nothing started', async () => {
  const w = mkWorld({ noAuto: true, art: true, bridge: mkBridge({}).shell });
  w.run();
  w.win.__SP_PRELOAD.open(); // the chip's on-demand path, before any start()
  await flush();
  assert.equal(w.win.__SP_PRELOAD.state().delegated, true, 'art present means the panel is delegated');
  assert.equal(w.win.__SP_ART.started, 0, 'opening the panel starts no walker');
  const texts = [];
  (function walk(el) {
    for (const c of el.children || []) { if (c.tagName === 'button') texts.push(c.textContent); walk(c); }
  })(w.doc.body.children[0]);
  assert.ok(!texts.includes('\u6682\u505C'), 'no pause button while delegated (art has no pause)');
  // Owner 2026-10-09: the preload parameters are gone -- no start / recheck / clear buttons either.
  assert.ok(!texts.includes('\u5F00\u59CB\u9884\u8F7D'), 'no start button (the parameters are gone)');
  assert.ok(!texts.includes('\u6E05\u9664\u672C\u5730\u7F13\u5B58') && !texts.includes('\u6E05\u9664\u56DE\u6E90\u7F13\u5B58'),
    'no clear-cache button (the parameters are gone)');
  assert.ok(texts.includes('\u5B8C\u6210'), 'the close button stays');
  const all = treeText(w.doc.body.children[0]);
  assert.match(all, /\u5927\u5385/, 'the lobby section stays');
  assert.match(all, /\u5916\u89C2\u8BBE\u7F6E/, 'the settings entry stays');
});
