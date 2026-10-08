// art-prefetch tests: the real shipped extras file is executed in a vm with a stub DOM + fetch.
//
//   node --test tools/apk/art-prefetch.test.mjs
//
// Contract under test (no-embedded-assets prefetch, resumable):
//   · the FULL manifest is walked in order and deduped -- every /assets/** (and CDN-prefixed
//     equivalent), incl. .webp/.skel/.atlas/.mp3, not just PNGs (checked against the real
//     data/assets.json as well as against an independent scan of its text);
//   · concurrency is capped, cancel() stops immediately without error, failures degrade silently;
//   · progress is PERSISTED per manifest hash: a reload continues from the stored count (the chip's
//     first paint is the stored X) and skips the entries already settled -- it does not restart;
//   · every failed path stays owed: it is carried into the next session and re-tried first, the
//     stored list is capped, the retry ladder is bounded (3 attempts, 500/1000 ms backoff, a 4xx is
//     not retried, backpressure narrows the window), and a changed manifest (fingerprint mismatch)
//     does not resume into entries that were never fetched;
//   · the module is idempotent and the source stays ES5 + pure ASCII.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'art-prefetch.js'), 'utf8');

const MANIFEST = {
  version: 1,
  hash: 'testhash1',
  ui: { a: '/assets/ui/a.png', b: '/assets/ui/b.png', w: '/assets/ui/w.webp' },
  chars: { c: { avatar: '/assets/char/c.png', portrait: '/assets/char/c_1.png' } },
  spine: { s: { skel: '/assets/spine/s/s.skel', atlas: '/assets/spine/s/s.atlas', page: '/assets/spine/s/s.png' } },
  voice: '/assets/audio/voice/cn/char_010_chen/cn_027.mp3',
  dup: '/assets/ui/a.png', // duplicate -> deduped
  cdn: 'https://weishucdn.jiangjiangze.icu/assets-re/ui/fromcdn.png', // CDN form -> /assets/ui/fromcdn.png
  other: '/fonts/fonts.css', // not an asset -> ignored
};
const EXPECTED = [
  '/assets/ui/a.png',
  '/assets/ui/b.png',
  '/assets/ui/w.webp',
  '/assets/char/c.png',
  '/assets/char/c_1.png',
  '/assets/spine/s/s.skel',
  '/assets/spine/s/s.atlas',
  '/assets/spine/s/s.png',
  '/assets/audio/voice/cn/char_010_chen/cn_027.mp3',
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
  const doc = {
    body, createElement: mkEl, visibilityState: 'visible', matchScreens: 0,
    // The module probes the game's own screen roots ('.screen.brief, .screen.gm, ...') to know a
    // match is on screen. The stub answers for ANY selector, so what is tested here is the
    // behaviour; the selector list itself is asserted against the source in the pause test.
    querySelector(sel) { return doc.matchScreens > 0 ? { sel } : null; },
  };
  return doc;
}

/** Timer stub with a VIRTUAL clock: fire() runs the due timers in order and advances the clock to
 *  each one's deadline, so the module's backoff ladder can be exercised (and asserted) exactly.
 *  Delays are captured for the ladder assertions; ids are stable (slots are never renumbered). */
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

/** Minimal localStorage/sessionStorage: the same object survives a "reload" (a new vm sandbox). */
function mkStorage() {
  const map = new Map();
  return {
    map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

/**
 * opts.manifest     manifest document (default MANIFEST)
 * opts.localList    body of the shell's local-coverage list (default: 404 -> no filtering)
 * opts.manifestFail reject the manifest fetch (offline first launch)
 * opts.manual       asset fetches resolve only via ctl.flush()
 * opts.failSet      Set of asset paths whose fetch rejects (transient: socket/timeout)
 * opts.deadSet      Set of asset paths answered with 404 (permanent)
 */
function mkFetch(opts = {}) {
  const calls = [];
  const pending = [];
  let inflight = 0;
  let maxInflight = 0;
  const failSet = opts.failSet || new Set();
  const deadSet = opts.deadSet || new Set();
  const LOCAL = '/__sp/local-assets.txt';

  function finishEntry(entry) {
    if (entry.done) return;
    entry.done = true;
    inflight--;
    const i = pending.indexOf(entry);
    if (i >= 0) pending.splice(i, 1);
    if (failSet.has(entry.url)) entry.reject(new Error('boom'));
    else if (deadSet.has(entry.url)) entry.resolve({ ok: false, status: 404, body: null });
    else entry.resolve({ ok: true, status: 200, body: null });
  }

  const fetch = (url, init) => {
    calls.push({ url, init });
    if (url === '/data/assets.json') {
      if (opts.manifestFail) return Promise.reject(new Error('offline'));
      const doc = opts.manifest === undefined ? MANIFEST : opts.manifest;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(doc) });
    }
    if (url === LOCAL) {
      if (!opts.localList) return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(opts.localList) });
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
    assetCalls() { return calls.filter((c) => c.url !== '/data/assets.json' && c.url !== LOCAL).map((c) => c.url); },
    manifestCalls() { return calls.filter((c) => c.url === '/data/assets.json').length; },
    localListCalls() { return calls.filter((c) => c.url === LOCAL).length; },
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
    setTimeout: sched.setTimeout.bind(sched), clearTimeout: sched.clearTimeout.bind(sched), console,
    Date: { now: () => sched.now() }, // the module reads Date.now for its backoff ladder
    localStorage: opts.localStorage || mkStorage(),
    sessionStorage: opts.sessionStorage || mkStorage(),
  };
  return {
    win, doc, sched, net, sandbox,
    run: () => vm.runInNewContext(SRC, sandbox, { filename: 'art-prefetch.js' }),
    chip: () => (doc.body.children[0] ? doc.body.children[0].children[0].textContent : null),
  };
}

const flush = () => new Promise((r) => setImmediate(r));

/** Runs a world to its end: drains pending fetches and fires the retry / wake / pacing timers.
 *  The dispatches are PACED (GAP_MS), so a walk only advances as the virtual clock does. */
async function drain(w, max = 600) {
  for (let i = 0; i < max; i++) {
    await flush();
    if (['done', 'cancelled', 'failed'].includes(w.win.__SP_ART.phase) && !w.sched.count()) return;
    if (!w.sched.count() && !w.net.pending.length) return;
    w.net.flush();
    w.sched.fire();
  }
}

/** Delay rungs >= 200 ms (rounded): the retry/backoff ladder. The dispatch pacing gap (GAP_MS,
 *  120 ms) is deliberately excluded -- it is not part of the ladder. */
const rungs = (w) => w.sched.delays.filter((d) => d >= 200 && d < 1100).map((d) => Math.round(d / 100) * 100).sort((a, b) => a - b);

// ---------------------------------------------------------------- cases

test('walks the manifest in order, dedupes, and normalises CDN paths to same-origin', async () => {
  const w = mkWorld({ noAuto: true });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  assert.equal(w.win.__SP_ART.total, EXPECTED.length, 'the manifest is parsed before the walk');
  await drain(w);
  assert.deepEqual(w.net.assetCalls(), EXPECTED);
  assert.equal(w.win.__SP_ART.done, EXPECTED.length);
  assert.equal(w.win.__SP_ART.failedCount, 0);
  assert.equal(w.win.__SP_ART.phase, 'done');
});

test('caps concurrency at 2 and paces the dispatches (never a burst at the page)', async () => {
  const many = { g: {} };
  for (let i = 0; i < 20; i++) many.g['k' + i] = '/assets/ui/x' + i + '.png';
  const w = mkWorld({ noAuto: true, manifest: many, manual: true });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  assert.equal(w.net.pending.length, 1, 'the pacing gate releases one dispatch per gap');
  assert.ok(w.win.__SP_ART.state().gapMs > 0, 'an inter-dispatch gap is configured');
  w.sched.fire(); // let the gap lapse
  await flush();
  assert.equal(w.net.pending.length, 2, 'the window is full at 2 -- far below the shell\'s 4 page slots');
  assert.equal(w.net.maxInflight, 2);
  w.sched.fire(); // a further gap must not open a third
  await flush();
  assert.equal(w.net.pending.length, 2, 'the window, not the queue length, bounds the concurrency');
  assert.equal(w.net.maxInflight, 2);
  // draining one opens exactly one more (after the gap), never a burst
  w.net.flush(1);
  await flush();
  assert.equal(w.net.pending.length, 1);
  w.sched.fire();
  await flush();
  assert.equal(w.net.pending.length, 2);
  assert.equal(w.net.maxInflight, 2);
  for (let i = 0; i < 600 && w.win.__SP_ART.phase !== 'done'; i++) { w.net.flush(100); w.sched.fire(); await flush(); }
  assert.equal(w.win.__SP_ART.phase, 'done');
  assert.equal(w.win.__SP_ART.done, 20);
});

test('every fetch is marked X-SP-Prefetch so the shell can serve the page first', async () => {
  const w = mkWorld({ noAuto: true });
  w.run();
  w.win.__SP_ART.start();
  await drain(w);
  const asset = w.net.calls.filter((c) => c.url.startsWith('/assets/'));
  assert.ok(asset.length > 0, 'the walk did fetch asset paths');
  for (const c of asset) {
    assert.equal(c.init.headers && c.init.headers['X-SP-Prefetch'], '1', 'marked: ' + c.url);
  }
  assert.equal(w.win.__SP_ART.phase, 'done');
});

test('the walk stands down while a match / briefing screen is on the page', async () => {
  const many = { g: {} };
  for (let i = 0; i < 12; i++) many.g['k' + i] = '/assets/ui/m' + i + '.png';
  const w = mkWorld({ noAuto: true, manifest: many, manual: true });
  w.run();
  w.doc.matchScreens = 1; // a match screen is up before the run even starts
  w.win.__SP_ART.start();
  await flush();
  assert.equal(w.net.pending.length, 0, 'not one request while the page owns the screen');
  assert.equal(w.win.__SP_ART.state().paused, 1, 'the stand-down is reported');
  w.sched.fire();
  await flush();
  assert.equal(w.net.pending.length, 0, 'still standing down after the poll');
  // the match screen goes away: the walk resumes on the next poll
  w.doc.matchScreens = 0;
  w.sched.fire();
  await flush();
  assert.ok(w.net.pending.length >= 1, 'the walk resumed');
  assert.equal(w.win.__SP_ART.state().paused, 0);
  for (let i = 0; i < 200 && w.win.__SP_ART.phase !== 'done'; i++) { w.net.flush(100); w.sched.fire(); await flush(); }
  assert.equal(w.win.__SP_ART.phase, 'done');
  assert.equal(w.win.__SP_ART.done, 12);

  // the document being hidden is the same stand-down (nothing on screen to warm)
  const h = mkWorld({ noAuto: true, manifest: many, manual: true });
  h.run();
  h.doc.visibilityState = 'hidden';
  h.win.__SP_ART.start();
  await flush();
  assert.equal(h.net.pending.length, 0, 'a hidden document is not walked');
  assert.equal(h.win.__SP_ART.state().paused, 1);
  h.doc.visibilityState = 'visible';
  h.sched.fire();
  await flush();
  assert.ok(h.net.pending.length >= 1, 'and it resumes when the page is back');
  h.win.__SP_ART.cancel();
});

test('cancel() stops immediately, keeps phase cancelled, and starts no new fetches', async () => {
  const many = { g: {} };
  for (let i = 0; i < 20; i++) many.g['k' + i] = '/assets/ui/y' + i + '.png';
  const w = mkWorld({ noAuto: true, manifest: many, manual: true });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  const callsBefore = w.net.calls.length;
  w.win.__SP_ART.cancel();
  assert.equal(w.win.__SP_ART.phase, 'cancelled');
  // drain everything that was in flight: no new fetch may be issued
  w.net.flush(100);
  await flush();
  assert.equal(w.net.calls.length, callsBefore, 'cancel must not open new requests');
  assert.equal(w.win.__SP_ART.phase, 'cancelled', 'a late settle must not flip the phase');
  assert.equal(w.win.__SP_ART.done, 0, 'cancelled runs do not count progress');
});

test('a skip is remembered for the session: the next load does not auto-start', async () => {
  const sessionStorage = mkStorage();
  const first = mkWorld({ noAuto: true, sessionStorage, manual: true });
  first.run();
  first.win.__SP_ART.start();
  await flush();
  first.win.__SP_ART.cancel();
  assert.equal(first.win.__SP_ART.phase, 'cancelled');
  // same session (the storage survives), fresh load, auto-start on: the module must stay idle
  const second = mkWorld({ sessionStorage });
  second.run();
  second.sched.fire();
  await flush();
  assert.equal(second.win.__SP_ART.phase, 'idle');
  assert.equal(second.net.manifestCalls(), 0, 'a skipped session is not restarted');
  // a manual start() is still honored (on-device diagnosis)
  second.win.__SP_ART.start();
  await drain(second);
  assert.equal(second.win.__SP_ART.phase, 'done');
});

test('failures degrade silently: done with a failed count, retried with backoff', async () => {
  const failSet = new Set(['/assets/ui/b.png', '/assets/char/c_1.png']);
  const w = mkWorld({ noAuto: true, failSet });
  w.run();
  w.win.__SP_ART.start();
  await drain(w);
  assert.equal(w.win.__SP_ART.phase, 'done');
  assert.equal(w.win.__SP_ART.failedCount, 2);
  assert.equal(w.win.__SP_ART.done, EXPECTED.length - 2);
  assert.deepEqual(Array.from(w.win.__SP_ART.failed()).sort(), [...failSet].sort(), 'failed() names the paths');
  assert.equal(w.win.__SP_ART.state().attempts, EXPECTED.length + 4, '3 attempts per transient failure');
  const ladder = rungs(w);
  assert.deepEqual([...new Set(ladder)], [500, 1000], 'the ladder is 0.5 s then 1 s, never more');
  assert.ok(Math.max(...ladder) <= 1000, 'the ladder stays bounded');
  assert.ok(w.win.__SP_ART.state().window < 2, 'backpressure narrowed the window to the floor');
});

test('a retry and a carried failure bypass the HTTP cache; a first look-up uses force-cache', async () => {
  const failSet = new Set(['/assets/ui/b.png']);
  const w = mkWorld({ noAuto: true, failSet });
  w.run();
  w.win.__SP_ART.start();
  await drain(w);
  const modes = (p) => w.net.calls.filter((c) => c.url === p).map((c) => c.init.cache);
  assert.deepEqual(modes('/assets/ui/a.png'), ['force-cache'], 'a first look-up reuses the cache');
  assert.deepEqual(modes('/assets/ui/b.png'), ['force-cache', 'no-store', 'no-store'],
    'both retries must reach the network instead of replaying the cached failure');

  // a path carried over from the stored record is treated the same way on its first attempt
  const localStorage = mkStorage();
  const manifest = { hash: 'carry', g: { a: '/assets/ui/a.png' } };
  const one = mkWorld({ noAuto: true, manifest, deadSet: new Set(['/assets/ui/a.png']), localStorage });
  one.run();
  one.win.__SP_ART.start();
  await drain(one);
  assert.equal(one.win.__SP_ART.failedCount, 1);
  const two = mkWorld({ noAuto: true, manifest, localStorage });
  two.run();
  two.win.__SP_ART.start();
  await drain(two);
  const carriedModes = two.net.calls.filter((c) => c.url === '/assets/ui/a.png').map((c) => c.init.cache);
  assert.deepEqual(carriedModes, ['no-store'], 'a carried failure does not replay its cached 404');
});

test('a 4xx is permanent: no retry, the path stays owed', async () => {
  const w = mkWorld({ noAuto: true, deadSet: new Set(['/assets/ui/a.png']) });
  w.run();
  w.win.__SP_ART.start();
  await drain(w);
  assert.equal(w.win.__SP_ART.phase, 'done');
  assert.equal(w.win.__SP_ART.failedCount, 1);
  assert.deepEqual(Array.from(w.win.__SP_ART.failed()), ['/assets/ui/a.png']);
  assert.equal(w.win.__SP_ART.state().attempts, EXPECTED.length, 'one attempt per path');
  assert.deepEqual(rungs(w), [], 'a 404 does not back off');
});

test('the failed key list is capped, the overflow is re-walked, and a reload never re-counts it', async () => {
  const localStorage = mkStorage();
  const many = { hash: 'cap', g: {} };
  const deadSet = new Set();
  const owed = [];
  for (let i = 0; i < 1200; i++) {
    const p = '/assets/ui/f' + i + '.png';
    many.g['k' + i] = p;
    owed.push(p);
    deadSet.add(p);
  }
  const w = mkWorld({ noAuto: true, manifest: many, deadSet, localStorage });
  w.run();
  w.win.__SP_ART.start();
  await drain(w, 2500);
  assert.equal(w.win.__SP_ART.phase, 'done');
  assert.equal(w.win.__SP_ART.failedCount, 1200);
  assert.equal(w.win.__SP_ART.failed().length, 1000, 'the stored/returned key list is capped');
  assert.equal(w.win.__SP_ART.state().failed, 1200, 'the diagnostic count is not capped');
  assert.equal(w.win.__SP_ART.state().walkCursor, 1200, 'the walk reached the end');
  assert.equal(w.win.__SP_ART.state().cursor, 1000, 'the cursor spills back to the first overflow failure');
  const rec = JSON.parse(localStorage.map.get('sp.art.v1'))['cap'];
  assert.deepEqual(
    { done: rec.done, failedTotal: rec.failedTotal, idle: rec.idle, total: rec.total, cursor: rec.cursor, walk: rec.walk, keys: rec.failed.length },
    { done: 0, failedTotal: 1200, idle: 0, total: 1200, cursor: 1000, walk: 1200, keys: 1000 },
    'the record stores done / failed / idle counts, the walk watermark and the capped key list');

  // the next session re-walks every spilled entry (nothing is dropped) and does not re-count it
  const two = mkWorld({ noAuto: true, manifest: many, deadSet, localStorage });
  two.run();
  two.win.__SP_ART.start();
  assert.equal(two.win.__SP_ART.failedCount, 1200, 'the resumed count starts at the stored one');
  await drain(two, 2500);
  const refetched = new Set(two.net.assetCalls());
  assert.equal(refetched.size, 1200, 'no owed entry is dropped: the whole spill region is re-walked');
  for (const p of owed) assert.ok(refetched.has(p), 're-walked: ' + p);
  assert.equal(two.win.__SP_ART.failedCount, 1200, 'a re-walked failure is counted once, not once per reload');
});

test('an unreachable manifest ends in failed without throwing (after bounded retries)', async () => {
  const w = mkWorld({ noAuto: true, manifestFail: true });
  w.run();
  assert.doesNotThrow(() => w.win.__SP_ART.start());
  await drain(w);
  assert.equal(w.win.__SP_ART.phase, 'failed');
  assert.equal(w.win.__SP_ART.total, 0);
  assert.equal(w.net.manifestCalls(), 3, 'three attempts, then give up');
});

test('onProgress fires immediately and on every change, ending at done', async () => {
  const w = mkWorld({ noAuto: true, deadSet: new Set(['/assets/ui/a.png']) });
  w.run();
  const seen = [];
  w.win.__SP_ART.onProgress((s) => seen.push(s.state + ':' + s.done + '/' + s.total + ':' + s.failed));
  assert.equal(seen.length, 1, 'the current snapshot is delivered on subscribe');
  assert.equal(seen[0], 'idle:0/0:0');
  w.win.__SP_ART.start();
  await drain(w);
  assert.ok(seen.length >= 3, 'progress is reported as it advances');
  assert.equal(seen[seen.length - 1], 'done:' + (EXPECTED.length - 1) + '/' + EXPECTED.length + ':1');
});

test('idempotent: re-running the source or calling start() twice does nothing extra', async () => {
  const w = mkWorld({ noAuto: true });
  w.run();
  const first = w.win.__SP_ART;
  w.run(); // second load must be a no-op (guard on window.__SP_ART)
  assert.equal(w.win.__SP_ART, first);
  w.win.__SP_ART.start();
  w.win.__SP_ART.start();
  await drain(w);
  assert.equal(w.net.manifestCalls(), 1);
  assert.deepEqual(w.net.assetCalls(), EXPECTED);
});

test('auto-starts once after load unless __SP_ART_NO_AUTO is set', async () => {
  const w = mkWorld();
  w.run();
  assert.equal(w.win.__SP_ART.phase, 'idle', 'nothing runs synchronously at load');
  assert.equal(w.sched.count(), 1, 'exactly one deferred auto-start is scheduled');
  w.sched.fire();
  await drain(w);
  assert.equal(w.win.__SP_ART.phase, 'done');
});

// ---------------------------------------------------------------- resume

test('a reload resumes from the stored progress instead of restarting', async () => {
  const localStorage = mkStorage();
  const manifest = { hash: 'hashA', g: {} };
  const paths = [];
  for (let i = 0; i < 12; i++) { paths.push('/assets/ui/r' + i + '.png'); manifest.g['k' + i] = paths[i]; }
  const failSet = new Set([paths[3], paths[7]]);

  // ---- session 1: a partial run (2 transient failures survive it)
  const one = mkWorld({ noAuto: true, manifest, failSet, localStorage });
  one.run();
  one.win.__SP_ART.start();
  await drain(one);
  assert.equal(one.win.__SP_ART.phase, 'done');
  assert.equal(one.win.__SP_ART.failedCount, 2);
  const done1 = one.win.__SP_ART.done;
  assert.equal(done1, 10, 'ten settled, two owed');
  assert.equal(one.win.__SP_ART.state().cursor, 12, 'every entry settled (ok or terminally failed)');
  assert.ok(localStorage.map.has('sp.art.v1'), 'progress was persisted');

  // ---- session 2: reload. The chip paints the stored X and only the owed paths are fetched.
  const two = mkWorld({ noAuto: true, manifest, localStorage });
  two.run();
  two.win.__SP_ART.start();
  assert.equal(two.chip(), 'art ' + done1 + '/12 (2 failed)', 'the first paint continues from the record');
  const st = two.win.__SP_ART.state();
  assert.equal(st.resumed, true);
  assert.equal(st.done, done1);
  assert.equal(st.total, 12);
  assert.equal(st.failed, 2);
  await drain(two);
  assert.deepEqual(two.net.assetCalls().sort(), [paths[3], paths[7]].sort(),
    'only the owed paths are re-fetched -- nothing already settled');
  assert.equal(two.win.__SP_ART.failedCount, 0, 'a retry that succeeds clears the owed entry');
  assert.equal(two.win.__SP_ART.failed().length, 0);
  assert.equal(two.win.__SP_ART.done, 12, 'the owed two now count as done');
  assert.equal(two.win.__SP_ART.phase, 'done');

  // ---- session 3: nothing left to do -> zero asset fetches, still the stored numbers
  const three = mkWorld({ noAuto: true, manifest, localStorage });
  three.run();
  three.win.__SP_ART.start();
  assert.equal(three.chip(), 'art 12/12');
  await flush();
  assert.deepEqual(three.net.assetCalls(), [], 'a finished manifest fetches nothing');
  assert.equal(three.win.__SP_ART.phase, 'done');
});

test('a partial run resumes mid-list (the settled prefix is skipped, not the successes counted)', async () => {
  const localStorage = mkStorage();
  const manifest = { hash: 'hashB', g: {} };
  for (let i = 0; i < 100; i++) manifest.g['k' + i] = '/assets/ui/p' + i + '.png';

  const one = mkWorld({ noAuto: true, manifest, manual: true, localStorage });
  one.run();
  one.win.__SP_ART.start();
  await flush();
  assert.equal(one.net.pending.length, 1, 'the pacing gate opens the window one dispatch at a time');
  one.sched.fire();
  await flush();
  assert.equal(one.net.pending.length, 2, 'the window is open (2)');
  one.net.flush(2);
  await flush();
  const done1 = one.win.__SP_ART.done;
  assert.equal(done1, 2, 'the first two settled');
  assert.equal(one.win.__SP_ART.state().cursor, done1, 'no failures: the prefix equals the successes');
  one.win.__SP_ART.cancel(); // killed mid-run

  const two = mkWorld({ noAuto: true, manifest, localStorage });
  two.run();
  two.win.__SP_ART.start();
  assert.equal(two.chip(), 'art ' + done1 + '/100', 'the reload continues from the stored count');
  await drain(two);
  assert.equal(two.net.assetCalls().length, 100 - done1, 'exactly the unattempted tail is fetched');
  assert.equal(two.win.__SP_ART.done, 100);
  assert.equal(two.win.__SP_ART.phase, 'done');
});

test('a changed manifest does not resume into the wrong entries', async () => {
  const localStorage = mkStorage();
  const before = { hash: 'hashC', g: {} };
  for (let i = 0; i < 8; i++) before.g['k' + i] = '/assets/ui/q' + i + '.png';
  const one = mkWorld({ noAuto: true, manifest: before, localStorage });
  one.run();
  one.win.__SP_ART.start();
  await drain(one);
  assert.equal(one.win.__SP_ART.phase, 'done');

  // same hash, different asset set (a skin rewrite / a republished manifest): the fingerprint has
  // to invalidate the record instead of skipping entries that were never fetched.
  const after = { hash: 'hashC', g: { z: '/assets/ui/zed.png' } };
  const two = mkWorld({ noAuto: true, manifest: after, localStorage });
  two.run();
  two.win.__SP_ART.start();
  await drain(two);
  assert.deepEqual(two.net.assetCalls(), ['/assets/ui/zed.png'], 'the changed set is fetched in full');
  assert.equal(two.win.__SP_ART.done, 1);
  assert.equal(two.win.__SP_ART.state().resumed, false);
});

// ---------------------------------------------------------------- real manifest coverage

test('enumerates the FULL real manifest (7969 entries, every asset type)', async () => {
  const raw = fs.readFileSync(path.join(here, '..', '..', 'data', 'assets.json'), 'utf8');
  const doc = JSON.parse(raw);
  const w = mkWorld({ noAuto: true, manifest: doc });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  const st = w.win.__SP_ART.state();
  assert.equal(st.total, 7969, 'the full published set, not a subset');
  await drain(w, 30000);
  // Independent scan of the raw text: every string literal naming an asset, normalised the same way.
  const refs = new Set();
  const re = /"([^"]*\/assets(?:-re)?\/[^"]*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const v = m[1];
    const i = v.indexOf('/assets/');
    const j = v.indexOf('/assets-re/');
    refs.add(i >= 0 ? v.substring(i) : '/assets/' + v.substring(j + 11));
  }
  assert.equal(refs.size, 7969, 'no ref in the manifest text is missed');
  const exts = new Map();
  for (const p of refs) {
    const e = p.split('.').pop().toLowerCase();
    exts.set(e, (exts.get(e) || 0) + 1);
  }
  for (const e of ['png', 'skel', 'atlas', 'mp3']) {
    assert.ok(exts.get(e) > 0, 'the manifest carries ' + e + ' refs (not only images)');
  }
  const fetched = new Set(w.net.assetCalls());
  assert.equal(fetched.size, 7969, 'every one of the 7969 refs is fetched');
  for (const p of refs) assert.ok(fetched.has(p), 'fetched: ' + p);
});

// ---------------------------------------------------------------- local coverage (owner rule)

test('entries the device already serves locally are counted, never requested', async () => {
  const manifest = { hash: 'local1', g: {} };
  const paths = [];
  for (let i = 0; i < 6; i++) { paths.push('/assets/ui/l' + i + '.png'); manifest.g['k' + i] = paths[i]; }
  // the shell lists 4 of the 6 as already on the device (embedded tree / installed art pack)
  const localList = paths.slice(0, 4).map((p) => p.substring(1)).join('\n') + '\n';
  const w = mkWorld({ noAuto: true, manifest, localList });
  w.run();
  w.win.__SP_ART.start();
  await drain(w);
  assert.equal(w.net.localListCalls(), 1, 'the coverage list is fetched once per run');
  assert.deepEqual(w.net.assetCalls(), [paths[4], paths[5]],
    'only the two the device cannot serve are requested');
  assert.equal(w.win.__SP_ART.done, 6, 'a skipped entry still counts as progress');
  assert.equal(w.win.__SP_ART.state().localList, 4);
  assert.equal(w.win.__SP_ART.state().localSkipped, 4);
  assert.equal(w.win.__SP_ART.phase, 'done');

  // no list (an older APK answers 404): the walk behaves exactly as it did before
  const bare = mkWorld({ noAuto: true, manifest });
  bare.run();
  bare.win.__SP_ART.start();
  await drain(bare);
  assert.equal(bare.net.assetCalls().length, 6, 'no list -> everything is walked');
  assert.equal(bare.win.__SP_ART.state().localList, 0);
  assert.equal(bare.win.__SP_ART.phase, 'done');
});

// ---------------------------------------------------------------- hash change (H1)

test('a hash change with the SAME asset set carries the walk over (no restart, owed list dropped)', async () => {
  const localStorage = mkStorage();
  const paths = [];
  const before = { hash: 'b699458e3e10', g: {} };
  for (let i = 0; i < 12; i++) { paths.push('/assets/ui/c' + i + '.png'); before.g['k' + i] = paths[i]; }
  const failSet = new Set([paths[4]]);

  // ---- session 1 under the old namespace: 11 settled, one owed
  const one = mkWorld({ noAuto: true, manifest: before, failSet, localStorage });
  one.run();
  one.win.__SP_ART.start();
  await drain(one);
  assert.equal(one.win.__SP_ART.phase, 'done');
  assert.equal(one.win.__SP_ART.done, 11);
  assert.equal(one.win.__SP_ART.failedCount, 1);
  const old = JSON.parse(localStorage.map.get('sp.art.v1'))['b699458e3e10'];
  assert.ok(old && old.walk === 12, 'the old namespace holds the walk watermark');

  // ---- session 2 after a content release: the build re-emitted the top-level hash over the SAME
  //      referenced bytes (measured on the live manifests), so the enumerated list is identical and
  //      the shell renamed the old cache namespace onto the new one. The walk must continue instead
  //      of restarting at 0 -- that restart was the 2026-10-08 report ("art 970/7969" mid-walk).
  const after = { hash: '7ae1d03466cb', g: {} };
  for (let i = 0; i < 12; i++) after.g['k' + i] = paths[i];
  const two = mkWorld({ noAuto: true, manifest: after, failSet, localStorage });
  two.run();
  two.win.__SP_ART.start();
  assert.equal(two.chip(), 'art 11/12 (1 failed)', 'the first paint continues from the record');
  await drain(two);
  assert.deepEqual(two.net.assetCalls(), [],
    'nothing is re-walked: the adopted namespace answers every settled path from cache');
  assert.equal(two.win.__SP_ART.state().carriedHash, 'b699458e3e10', 'the carry names its source hash');
  assert.equal(two.win.__SP_ART.done, 11);
  assert.equal(two.win.__SP_ART.failedCount, 0, 'the owed list is dropped when the hash changes');
  assert.equal(two.win.__SP_ART.phase, 'done');
  assert.ok(JSON.parse(localStorage.map.get('sp.art.v1'))['7ae1d03466cb'],
    'the carried progress is re-persisted under the new hash');

  // ---- a hash change with a DIFFERENT set must never carry (the record is not trusted)
  const changed = { hash: 'ffee00112233', g: { z: '/assets/ui/zed.png' } };
  const three = mkWorld({ noAuto: true, manifest: changed, failSet, localStorage });
  three.run();
  three.win.__SP_ART.start();
  await drain(three);
  assert.deepEqual(three.net.assetCalls(), ['/assets/ui/zed.png'], 'a changed set starts over');
  assert.equal(three.win.__SP_ART.state().carriedHash, '');
  assert.equal(three.win.__SP_ART.done, 1);
  assert.equal(three.win.__SP_ART.phase, 'done');
});

// ---------------------------------------------------------------- source invariants

// 2026-10-08 (owner): the chip IS the preload UI -- no pill, no auto-opened panel. Its label is the
// on-demand entry to the preload panel; the module must look window.__SP_PRELOAD up at CLICK time
// (preload-center.js loads after this one) and stay silent when it is absent.
test('the chip label opens the preload panel on demand (and is a no-op without it)', async () => {
  const w = mkWorld({ noAuto: true });
  w.run();
  w.win.__SP_ART.start(); // the chip is mounted when a walk starts (noAuto suppresses that)
  await flush();
  const label = w.doc.body.children[0].children[0];
  assert.equal(label.style.pointerEvents, 'auto', 'only the label is clickable (the chip stays none)');
  assert.equal(typeof label.onclick, 'function');
  // (a) no preload-center on the page: the click must not throw
  label.onclick();
  // (b) preload-center present: the click opens it
  const opened = [];
  w.win.__SP_PRELOAD = { open() { opened.push(1); } };
  label.onclick();
  assert.deepEqual(opened, [1], 'the label opened the preload panel');
  // (c) the skip button still only skips (it must not open anything)
  const skip = w.doc.body.children[0].children[1];
  assert.equal(skip.textContent, 'skip');
});

test('source invariants: ES5, pure ASCII, no module system / third-party dependency', () => {
  assert.equal(/=>|\bconst\b|\blet\b|\bclass\b/.test(SRC), false, 'must stay ES5 (old WebView)');
  assert.equal(/\bimport\s|\brequire\s*\(/.test(SRC), false, 'no module system');
  assert.equal(/[^\x00-\x7F]/.test(SRC), false, 'must be pure ASCII');
  assert.equal(/\bfetch\s*\(/.test(SRC), true, 'uses fetch');
  assert.equal(SRC.startsWith('/* global '), true, 'the global declaration stays on line 1');
  assert.equal(/sp\.art\.v1/.test(SRC), true, 'persists under a versioned localStorage key');
  assert.equal(/localStorage/.test(SRC) && /sessionStorage/.test(SRC), true, 'both storages are used');
  // the H3 levers are all present in the shipped source (a future edit must not quietly drop one)
  assert.equal(/X-SP-Prefetch/.test(SRC), true, 'the shell marks prefetch fetches');
  assert.equal(/\/__sp\/local-assets\.txt/.test(SRC), true, 'the local coverage list is consumed');
  assert.equal(/\.screen\.brief/.test(SRC) && /\.screen\.gm/.test(SRC), true, 'match screens are probed');
  assert.ok(/var CONCURRENCY = 2;/.test(SRC), 'the prefetch takes at most 2 of the shell\'s slots');
  assert.equal(/var GAP_MS = \d+;/.test(SRC), true, 'dispatches are paced');
  assert.ok(/paused: paused/.test(SRC), 'the stand-down is visible on-device');
});
