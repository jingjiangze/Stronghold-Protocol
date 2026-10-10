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
//   · the control's UI (owner 2026-10-10): the collapsed form is the bare word "skip" -- no chip
//     box, no number on screen -- and BOTH forms are draggable through ONE state machine over ONE
//     remembered anchor (the same localStorage key): a drag moves and persists, a tap expands /
//     opens the preload panel, and the chip's own skip button keeps only collapsing (the drag
//     surface is the label element alone);
//   · the module is idempotent and the source stays ES5 + pure ASCII.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { setKeyForRels } from './transcode-assets.mjs';

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
 * opts.statusSet    Map path -> { status, headers }: any other status (429 / 500 / …). The error
 *                   classification must agree with the native ArtCdn.isTransientStatus table.
 * opts.sizes        Map path -> bytes: the response then carries a Content-Length (the byte rate's
 *                   only honest source). Without it the responses have no headers at all, which is
 *                   exactly the "count-only" case the display must degrade to.
 */
function mkFetch(opts = {}) {
  const calls = [];
  const pending = [];
  let inflight = 0;
  let maxInflight = 0;
  const failSet = opts.failSet || new Set();
  const deadSet = opts.deadSet || new Set();
  const statusSet = opts.statusSet || null;
  const sizes = opts.sizes || null;
  const LOCAL = '/__sp/local-assets.txt';

  function headersFor(url) {
    const n = sizes && typeof sizes.get === 'function' ? sizes.get(url) : 0;
    if (!n) return null;
    return { get: (k) => (k === 'content-length' ? String(n) : null) };
  }

  function finishEntry(entry) {
    if (entry.done) return;
    entry.done = true;
    inflight--;
    const i = pending.indexOf(entry);
    if (i >= 0) pending.splice(i, 1);
    const headers = headersFor(entry.url);
    const override = statusSet && typeof statusSet.get === 'function' ? statusSet.get(entry.url) : null;
    if (failSet.has(entry.url)) entry.reject(new Error('boom'));
    else if (override) entry.resolve({ ok: override.ok === true, status: override.status, body: null, headers: override.headers || headers });
    else if (deadSet.has(entry.url)) entry.resolve({ ok: false, status: 404, body: null, headers });
    else entry.resolve({ ok: true, status: 200, body: null, headers });
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
  if (opts.shell) win.__SP_SHELL = opts.shell; // the shell bridge (artWalkGet/Put, addition A)
  // window.addEventListener: the module registers pagehide / resize handlers behind a typeof guard.
  // Captured so a test can drive the resize re-clamp (the control must stay inside the viewport).
  const listeners = {};
  win.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  if (opts.viewport) { win.innerWidth = opts.viewport.w; win.innerHeight = opts.viewport.h; }
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
    win, doc, sched, net, sandbox, listeners,
    run: () => vm.runInNewContext(SRC, sandbox, { filename: 'art-prefetch.js' }),
    chip: () => (doc.body.children[0] ? doc.body.children[0].children[0].textContent : null),
    fireEvent: (type, ev) => { (listeners[type] || []).forEach((fn) => fn(ev)); },
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

test('set identity key: the page computes the same key as the build (algorithm consistency)', async () => {
  const w = mkWorld({ noAuto: true });
  w.run();
  w.win.__SP_ART.start();
  await drain(w);
  const rels = EXPECTED.map((p) => p.substring('/assets/'.length));
  const want = setKeyForRels(rels);
  assert.match(want, /^[0-9a-f]{12}$/);
  assert.equal(w.win.__SP_ART.state().setKey, want,
    'art-prefetch.js setKey == transcode-assets.mjs setKeyForRels for the same rel set');
  // ...and the recipe the shell (ArtCdn.setKeyForRels) re-implements, verbatim:
  assert.equal(want, crypto.createHash('sha1').update(JSON.stringify(rels.slice().sort())).digest('hex').slice(0, 12));
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

// Owner rule 2026-10-09: "skip" no longer cancels -- it SHRINKS the chip to a bare collapsed label
// that stays on the page (the only home overlay left). The walk keeps running behind it, the label
// survives finish, and the collapsed form is remembered for the session (a reload paints it again --
// and still auto-starts, because a shrink is not a stop). Owner rule 2026-10-10: that wording is the
// word "skip" (the left-arrow glyph is gone).
test('skip shrinks the chip to a persistent bare "skip" label instead of removing it', async () => {
  const sessionStorage = mkStorage();
  const w = mkWorld({ noAuto: true, sessionStorage, manual: true });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  const ui = w.doc.body.children[0];
  assert.ok(ui, 'the floating chip is mounted');
  const label = ui.children[0];
  const skip = ui.children[1];
  assert.equal(skip.textContent, 'skip');
  assert.match(label.textContent, /^art \d+\/\d+/, 'the full chip shows the count: ' + label.textContent);

  skip.onclick(); // the owner's skip: shrink, never stop
  assert.equal(w.doc.body.children[0], ui, 'the control is STILL on the page (not removed)');
  assert.equal(label.textContent, 'skip', 'it collapsed to the word "skip": ' + label.textContent);
  assert.equal(skip.style.display, 'none', 'the skip button is gone in the collapsed form');
  assert.equal(w.win.__SP_ART.state().minimized, 1, 'the collapsed form is reported');
  assert.equal(w.win.__SP_ART.phase, 'running', 'skip no longer cancels the walk');

  // the walk keeps working behind the collapsed label, and the label survives the finish
  await drain(w);
  assert.equal(w.win.__SP_ART.phase, 'done');
  assert.equal(w.doc.body.children[0], ui, 'the collapsed label stays after the walk finishes');
  assert.equal(w.doc.body.children[0].children[0].textContent, 'skip', 'still the word "skip"');

  // the collapsed form is remembered for the session: a reload paints it and still walks
  const again = mkWorld({ sessionStorage });
  again.run();
  again.sched.fire(); // the deferred auto-start
  await flush();
  assert.equal(again.doc.body.children[0].children[0].textContent, 'skip',
    'the reload paints the collapsed label, not the chip');
  assert.notEqual(again.win.__SP_ART.phase, 'idle', 'a shrink never suppresses the auto-start');
  await drain(again);
  assert.equal(again.win.__SP_ART.phase, 'done');
});

// Owner rule 2026-10-10: the collapsed form is a BARE label -- no chip background / border / radius /
// shadow / padding, and no percent (no digit at all) on screen -- and (second round) its wording is
// the word "skip" instead of the left-arrow glyph. It stays small and light so it never covers the
// game UI. Expanding restores the dark chip chrome unchanged.
test('the collapsed label is the bare word "skip": no chip background, no number, small and light', async () => {
  const w = mkWorld({ noAuto: true, manual: true, viewport: { w: 400, h: 800 } });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  const ui = w.doc.body.children[0];
  const label = ui.children[0];
  ui.children[1].onclick(); // the skip button: shrink to the bare label
  assert.equal(ui.style.background, '', 'no chip background when collapsed');
  assert.equal(ui.style.border, '', 'no chip border');
  assert.equal(ui.style.borderRadius, '', 'no rounded chip box');
  assert.equal(ui.style.boxShadow, '', 'no chip shadow');
  assert.equal(ui.style.padding, '', 'no chip padding');
  assert.equal(label.textContent, 'skip', 'the wording alone');
  assert.match(label.textContent, /^skip$/, 'exactly "skip" -- nothing else on screen');
  assert.doesNotMatch(label.textContent, /[0-9]/, 'no percentage / digit on the collapsed label');
  assert.equal(label.style.fontSize, '16px', 'small and light');
  assert.equal(label.style.touchAction, 'none', 'the label is a clean drag handle');
  // expanding restores the chip chrome (the expanded look is unchanged)
  label.onclick();
  assert.equal(w.win.__SP_ART.state().minimized, 0, 'the tap expanded the chip');
  assert.notEqual(ui.style.background, '', 'the chip background is back when expanded');
  w.win.__SP_ART.cancel();
});

// Owner rule 2026-10-10: the collapsed label is draggable anywhere (pointerdown -> move -> up). A
// press that moves past the slop is a DRAG (never expands, even for the click it ends with); a tap
// (no movement) expands. The position is clamped inside the viewport, including after a resize.
test('dragging the collapsed label moves it, never expands, and keeps it inside the viewport', async () => {
  const w = mkWorld({ noAuto: true, manual: true, viewport: { w: 400, h: 800 } });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  const ui = w.doc.body.children[0];
  const arrow = ui.children[0];
  ui.children[1].onclick(); // collapse to the bare label
  // the default corner: right 10 / bottom 54, nominal box 22
  assert.equal(ui.style.left, (400 - 22 - 10) + 'px', 'default x');
  assert.equal(ui.style.top, (800 - 22 - 54) + 'px', 'default y');

  // pointerdown -> move -> up: a drag (moves the label, must NOT expand)
  arrow.onpointerdown({ clientX: 350, clientY: 700, button: 0, pointerId: 1, preventDefault() {} });
  arrow.onpointermove({ clientX: 150, clientY: 300, preventDefault() {} });
  arrow.onpointerup({ clientX: 150, clientY: 300 });
  assert.equal(w.win.__SP_ART.state().minimized, 1, 'a drag never expands');
  assert.equal(ui.style.left, '168px', 'moved by the drag delta (x)');
  assert.equal(ui.style.top, '324px', 'moved by the drag delta (y)');
  arrow.onclick(); // the synthetic click a drag ends with must be swallowed
  assert.equal(w.win.__SP_ART.state().minimized, 1, 'the click that ends a drag does not expand');

  // a drag past the edges is clamped inside the viewport (nominal box 22, margin 6)
  arrow.onpointerdown({ clientX: 168, clientY: 324, button: 0, pointerId: 2, preventDefault() {} });
  arrow.onpointermove({ clientX: 99999, clientY: 99999, preventDefault() {} });
  arrow.onpointerup({ clientX: 99999, clientY: 99999 });
  assert.equal(ui.style.left, (400 - 22 - 6) + 'px', 'clamped to the right edge');
  assert.equal(ui.style.top, (800 - 22 - 6) + 'px', 'clamped to the bottom edge');

  // a resize re-clamps the label into the new (smaller) viewport
  w.win.innerWidth = 200; w.win.innerHeight = 200;
  w.fireEvent('resize');
  assert.equal(ui.style.left, (200 - 22 - 6) + 'px', 'a resize re-clamps x');
  assert.equal(ui.style.top, (200 - 22 - 6) + 'px', 'a resize re-clamps y');
  // ...and growing back returns it to the REMEMBERED anchor (372/772), because a transient clamp no
  // longer overwrites that anchor: it now means "where the user put it" for BOTH forms, and the chip
  // must not inherit an artefact of a shrunken window.
  w.win.innerWidth = 400; w.win.innerHeight = 800;
  w.fireEvent('resize');
  assert.equal(ui.style.left, (400 - 22 - 6) + 'px', 'growing back returns to the remembered spot');
  assert.equal(ui.style.top, (800 - 22 - 6) + 'px');

  // a drag to the top-left corner is clamped there too
  arrow.onpointerdown({ clientX: 172, clientY: 172, button: 0, pointerId: 3, preventDefault() {} });
  arrow.onpointermove({ clientX: -99999, clientY: -99999, preventDefault() {} });
  arrow.onpointerup({ clientX: -99999, clientY: -99999 });
  assert.equal(ui.style.left, '6px', 'clamped to the left edge');
  assert.equal(ui.style.top, '6px', 'clamped to the top edge');

  // a TAP (no movement) still expands
  arrow.onpointerdown({ clientX: 6, clientY: 6, button: 0, pointerId: 4, preventDefault() {} });
  arrow.onpointerup({ clientX: 6, clientY: 6 });
  arrow.onclick();
  assert.equal(w.win.__SP_ART.state().minimized, 0, 'a tap (no movement) expands the chip');
  w.win.__SP_ART.cancel();
});

// Owner rule 2026-10-10: the dragged position is remembered in localStorage (sp.art.arrow.pos) and
// read back on the next load. A null / corrupt / non-numeric value is the DEFAULT corner -- never an
// error (the control must always paint).
test('the control position is remembered in localStorage and a bad value never throws', async () => {
  const localStorage = mkStorage();
  const vp = { w: 400, h: 800 };
  const w = mkWorld({ noAuto: true, manual: true, viewport: vp, localStorage });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  let ui = w.doc.body.children[0];
  let arrow = ui.children[0];
  ui.children[1].onclick();
  arrow.onpointerdown({ clientX: 350, clientY: 700, button: 0, pointerId: 1, preventDefault() {} });
  arrow.onpointermove({ clientX: 150, clientY: 300, preventDefault() {} });
  arrow.onpointerup({ clientX: 150, clientY: 300 });
  assert.deepEqual(JSON.parse(localStorage.map.get('sp.art.arrow.pos')), { x: 168, y: 324 },
    'the dragged spot is persisted');
  w.win.__SP_ART.cancel();

  // a reload reads it back (fresh session: collapse again to the bare label)
  const two = mkWorld({ noAuto: true, manual: true, viewport: vp, localStorage });
  two.run();
  two.win.__SP_ART.start();
  await flush();
  ui = two.doc.body.children[0];
  ui.children[1].onclick();
  assert.equal(ui.style.left, '168px', 'the remembered x is restored');
  assert.equal(ui.style.top, '324px', 'the remembered y is restored');
  two.win.__SP_ART.cancel();

  // a corrupt value (not JSON) falls back to the default corner, without throwing
  const bad = mkStorage();
  bad.setItem('sp.art.arrow.pos', '{not json');
  const three = mkWorld({ noAuto: true, manual: true, viewport: vp, localStorage: bad });
  three.run();
  assert.doesNotThrow(() => three.win.__SP_ART.start());
  await flush();
  three.doc.body.children[0].children[1].onclick();
  assert.equal(three.doc.body.children[0].style.left, (400 - 22 - 10) + 'px', 'corrupt value -> default x');
  assert.equal(three.doc.body.children[0].style.top, (800 - 22 - 54) + 'px', 'corrupt value -> default y');

  // an object with non-numeric coords is ignored too
  bad.setItem('sp.art.arrow.pos', JSON.stringify({ x: 'nope', y: null }));
  const four = mkWorld({ noAuto: true, manual: true, viewport: vp, localStorage: bad });
  four.run();
  four.win.__SP_ART.start();
  await flush();
  four.doc.body.children[0].children[1].onclick();
  assert.equal(four.doc.body.children[0].style.left, (400 - 22 - 10) + 'px', 'non-numeric coords -> default');
  three.win.__SP_ART.cancel();
  four.win.__SP_ART.cancel();
});

// Owner rule 2026-10-10 (second round: "资源加载时也可以拖动"): the EXPANDED chip is draggable while
// the resources load. It runs through the SAME state machine as the collapsed label -- same slop,
// same clamp, same storage key -- so a drag moves it and persists the spot, while a tap (no movement)
// still opens the preload panel and a drag never does (the click a drag ends with is swallowed).
test('the expanded chip drags like the collapsed label (and a drag never opens the panel)', async () => {
  const localStorage = mkStorage();
  const w = mkWorld({ noAuto: true, manual: true, viewport: { w: 400, h: 800 }, localStorage });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  assert.equal(w.win.__SP_ART.phase, 'running', 'the drag happens WHILE the resources load');
  const ui = w.doc.body.children[0];
  const label = ui.children[0];
  assert.match(label.textContent, /^art \d+\/\d+/, 'the expanded chip is on screen');
  const opened = [];
  w.win.__SP_PRELOAD = { open() { opened.push(1); } };

  // pointerdown -> move -> up: a drag (moves the chip, must NOT open the panel)
  label.onpointerdown({ clientX: 350, clientY: 700, button: 0, pointerId: 1, preventDefault() {} });
  label.onpointermove({ clientX: 150, clientY: 300, preventDefault() {} });
  label.onpointerup({ clientX: 150, clientY: 300 });
  assert.equal(w.win.__SP_ART.state().minimized, 0, 'a drag never collapses the chip');
  assert.equal(ui.style.left, '168px', 'the chip moved by the drag delta (x)');
  assert.equal(ui.style.top, '324px', 'the chip moved by the drag delta (y)');
  assert.deepEqual(opened, [], 'a drag never opens the preload panel');
  label.onclick(); // the synthetic click a drag ends with
  assert.deepEqual(opened, [], 'the click a drag ends with is swallowed too');
  assert.deepEqual(JSON.parse(localStorage.map.get('sp.art.arrow.pos')), { x: 168, y: 324 },
    'the chip persists through the same storage key');

  // a drag past the edges is clamped inside the viewport, exactly like the collapsed label
  label.onpointerdown({ clientX: 168, clientY: 324, button: 0, pointerId: 2, preventDefault() {} });
  label.onpointermove({ clientX: 99999, clientY: 99999, preventDefault() {} });
  label.onpointerup({ clientX: 99999, clientY: 99999 });
  assert.equal(ui.style.left, (400 - 22 - 6) + 'px', 'clamped to the right edge');
  assert.equal(ui.style.top, (800 - 22 - 6) + 'px', 'clamped to the bottom edge');
  assert.deepEqual(JSON.parse(localStorage.map.get('sp.art.arrow.pos')),
    { x: 400 - 22 - 6, y: 800 - 22 - 6 }, 'the clamped spot is what is persisted');

  // a TAP (no movement) still opens the preload panel, and a tap never moves the chip
  label.onpointerdown({ clientX: 372, clientY: 772, button: 0, pointerId: 3, preventDefault() {} });
  label.onpointerup({ clientX: 372, clientY: 772 });
  label.onclick();
  assert.deepEqual(opened, [1], 'a tap opens the preload panel');
  assert.equal(w.win.__SP_ART.state().minimized, 0, 'a tap does not collapse the chip');
  assert.equal(ui.style.left, (400 - 22 - 6) + 'px', 'a tap does not move the chip');
  w.win.__SP_ART.cancel();
});

// Owner rule 2026-10-10: the chip and the collapsed label share ONE position -- the same remembered
// anchor and the same storage key -- so collapsing / expanding never jumps back to the default
// corner, and it survives a reload. The chip's own "skip" button is NOT part of the drag surface:
// its click only collapses, even immediately after a drag on the label.
test('the chip and the collapsed label share one position; skip keeps only collapsing', async () => {
  const localStorage = mkStorage();
  const vp = { w: 400, h: 800 };
  const w = mkWorld({ noAuto: true, manual: true, viewport: vp, localStorage });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  const ui = w.doc.body.children[0];
  const label = ui.children[0];
  const skip = ui.children[1];
  const opened = [];
  w.win.__SP_PRELOAD = { open() { opened.push(1); } };

  // drag the EXPANDED chip to (168, 324)
  label.onpointerdown({ clientX: 350, clientY: 700, button: 0, pointerId: 1, preventDefault() {} });
  label.onpointermove({ clientX: 150, clientY: 300, preventDefault() {} });
  label.onpointerup({ clientX: 150, clientY: 300 });
  label.onclick(); // spend the drag's click guard

  // the skip button is outside the drag surface: its click still only collapses
  skip.onclick();
  assert.equal(w.win.__SP_ART.state().minimized, 1, 'skip collapsed the chip');
  assert.equal(label.textContent, 'skip', 'the collapsed wording is the word "skip"');
  assert.equal(ui.style.left, '168px', 'the collapsed label stayed at the dragged spot (x)');
  assert.equal(ui.style.top, '324px', 'the collapsed label stayed at the dragged spot (y)');
  assert.deepEqual(opened, [], 'skip never opens the panel');
  assert.equal(skip.style.display, 'none', 'the button is hidden while collapsed');

  // expanding again places the chip at the SAME anchor (no jump back to the CSS corner)
  label.onpointerdown({ clientX: 168, clientY: 324, button: 0, pointerId: 2, preventDefault() {} });
  label.onpointerup({ clientX: 168, clientY: 324 });
  label.onclick();
  assert.equal(w.win.__SP_ART.state().minimized, 0, 'the tap expanded the chip');
  assert.equal(ui.style.left, '168px', 'the chip is back at the shared spot (x)');
  assert.equal(ui.style.top, '324px', 'the chip is back at the shared spot (y)');
  assert.equal(ui.style.right, '', 'the CSS corner is not restored');
  w.win.__SP_ART.cancel();

  // a reload reads the SAME remembered anchor for both forms
  const two = mkWorld({ noAuto: true, manual: true, viewport: vp, localStorage });
  two.run();
  two.win.__SP_ART.start();
  await flush();
  const ui2 = two.doc.body.children[0];
  assert.equal(ui2.style.left, '168px', 'the reloaded chip resumes the spot (x)');
  assert.equal(ui2.style.top, '324px', 'the reloaded chip resumes the spot (y)');
  ui2.children[1].onclick(); // collapse via skip
  assert.equal(ui2.children[0].textContent, 'skip', 'the collapsed wording survives the reload');
  assert.equal(ui2.style.left, '168px', 'the collapsed label resumes the same spot');
  assert.equal(ui2.style.top, '324px');
  two.win.__SP_ART.cancel();
});

// Owner rule 2026-10-09: the control is global EXCEPT in a match / briefing screen or a hidden
// document (the same MATCH_MARKS / pageBusy() probe the walk stands down on). The walk itself is NOT
// stopped by this -- that stand-down stays pageBusy()/packBusyNow()'s job in pump().
test('the control hides in combat (match screen / hidden document) and returns after', async () => {
  const many = { hash: 'combat', g: {} };
  for (let i = 0; i < 12; i++) many.g['k' + i] = '/assets/ui/cb' + i + '.png';

  // a match screen is up before the run: the control mounts already hidden (but is NOT removed)
  const w = mkWorld({ noAuto: true, manifest: many, manual: true });
  w.run();
  w.doc.matchScreens = 1;
  w.win.__SP_ART.start();
  await flush();
  const ui = w.doc.body.children[0];
  assert.ok(ui, 'the control is still mounted while hidden');
  assert.equal(ui.style.display, 'none', 'the arrow is hidden during a match');
  assert.equal(w.win.__SP_ART.state().paused, 1, 'and the walk stands down (unchanged)');
  // the match ends: the next poll restores the arrow
  w.doc.matchScreens = 0;
  w.sched.fire();
  await flush();
  assert.notEqual(ui.style.display, 'none', 'the arrow is back after the match');
  assert.equal(w.win.__SP_ART.state().paused, 0);
  w.win.__SP_ART.cancel();

  // a hidden document hides it too (nothing on screen to warm), and it returns when visible again
  const h = mkWorld({ noAuto: true, manifest: many, manual: true });
  h.run();
  h.doc.visibilityState = 'hidden';
  h.win.__SP_ART.start();
  await flush();
  const hui = h.doc.body.children[0];
  assert.equal(hui.style.display, 'none', 'a hidden document hides the arrow');
  h.doc.visibilityState = 'visible';
  h.sched.fire();
  await flush();
  assert.notEqual(hui.style.display, 'none', 'and it returns when the page is visible again');
  h.win.__SP_ART.cancel();
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

test('every attempt bypasses the HTTP cache (no-store), first look-ups included', async () => {
  const failSet = new Set(['/assets/ui/b.png']);
  const w = mkWorld({ noAuto: true, failSet });
  w.run();
  w.win.__SP_ART.start();
  await drain(w);
  const modes = (p) => w.net.calls.filter((c) => c.url === p).map((c) => c.init.cache);
  assert.deepEqual(modes('/assets/ui/a.png'), ['no-store'],
    'a first look-up does not replay the WebView cache either (a hot-updated asset must win)');
  assert.deepEqual(modes('/assets/ui/b.png'), ['no-store', 'no-store', 'no-store'],
    'both retries must reach the shell instead of replaying the cached failure');

  // a path owed by the stored record is treated the same way
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
  assert.deepEqual(carriedModes, ['no-store'], 'an owed path does not replay its cached 404');
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
  const rec = JSON.parse(localStorage.map.get('sp.art.v1'))[w.win.__SP_ART.state().setKey];
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

test('enumerates the FULL real manifest (10643 entries, every asset type)', async () => {
  const raw = fs.readFileSync(path.join(here, '..', '..', 'data', 'assets.json'), 'utf8');
  const doc = JSON.parse(raw);
  const w = mkWorld({ noAuto: true, manifest: doc });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  const st = w.win.__SP_ART.state();
  assert.equal(st.total, 10643, 'the full published set, not a subset');
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
  assert.equal(refs.size, 10643, 'no ref in the manifest text is missed');
  const exts = new Map();
  for (const p of refs) {
    const e = p.split('.').pop().toLowerCase();
    exts.set(e, (exts.get(e) || 0) + 1);
  }
  for (const e of ['png', 'skel', 'atlas', 'mp3']) {
    assert.ok(exts.get(e) > 0, 'the manifest carries ' + e + ' refs (not only images)');
  }
  const fetched = new Set(w.net.assetCalls());
  assert.equal(fetched.size, 10643, 'every one of the 10643 refs is fetched');
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

// The panel needs three numbers from this walker: localFiles (settled entries the device served
// itself), done and pending (= total - done). A local hit must never be re-requested and a real
// fetch must never inflate localFiles.
test('exposes localFiles and pending: N of M covered, zero requests for the covered entries', async () => {
  const manifest = { hash: 'local2', g: {} };
  const paths = [];
  for (let i = 0; i < 6; i++) { paths.push('/assets/ui/n' + i + '.png'); manifest.g['k' + i] = paths[i]; }
  const localList = paths.slice(0, 4).map((p) => p.substring(1)).join('\n') + '\n';
  const w = mkWorld({ noAuto: true, manifest, localList, manual: true });
  w.run();
  w.win.__SP_ART.start();
  await flush(); // the manifest + coverage list land and the walk seeds
  let st = w.win.__SP_ART.state();
  assert.equal(st.total, 6);
  assert.equal(st.localFiles, 4, 'the covered entries are counted as local hits');
  assert.equal(st.done, 4, 'a local hit counts as progress');
  assert.equal(st.pending, 2, 'pending = total - done');
  const early = new Set(w.net.assetCalls());
  for (const p of paths.slice(0, 4)) assert.ok(!early.has(p), 'a covered entry is never requested: ' + p);

  // onProgress carries the same fields (the panel mirrors this snapshot)
  const seen = [];
  w.win.__SP_ART.onProgress((s) => seen.push(s));
  assert.equal(seen[seen.length - 1].localFiles, 4);
  assert.equal(seen[seen.length - 1].pending, 2);

  await drain(w);
  st = w.win.__SP_ART.state();
  assert.equal(st.done, 6, 'the two uncovered entries were fetched');
  assert.equal(st.pending, 0, 'nothing is pending once every entry is settled');
  assert.equal(st.localFiles, 4, 'a real fetch does not inflate the local-hit count');
  assert.deepEqual(w.net.assetCalls().sort(), [paths[4], paths[5]].sort(),
    'only the two the device cannot serve were requested');
});

// ---------------------------------------------------------------- set identity (owner 2026-10-10 A)

// The resume namespace is the SET of referenced rel paths (direction A), not the manifest's byte
// hash. Two manifests with the SAME rel set share one record even when their `hash` differs (a
// republish, or two servers on the same upstream version) -- that is what makes a server switch
// resume instead of re-walking. A CHANGED set (different setKey) still re-walks from the top. The
// shell catches same-path byte changes separately (per-file digests on use).
test('the resume namespace is the SET identity: a hash change with the SAME set resumes (direction A)', async () => {
  const localStorage = mkStorage();
  const paths = [];
  const before = { hash: 'b699458e3e10', g: {} };
  for (let i = 0; i < 12; i++) { paths.push('/assets/ui/c' + i + '.png'); before.g['k' + i] = paths[i]; }
  const failSet = new Set([paths[4]]);

  // ---- session 1: 11 settled, one owed
  const one = mkWorld({ noAuto: true, manifest: before, failSet, localStorage });
  one.run();
  one.win.__SP_ART.start();
  await drain(one);
  assert.equal(one.win.__SP_ART.phase, 'done');
  assert.equal(one.win.__SP_ART.done, 11);
  assert.equal(one.win.__SP_ART.failedCount, 1);
  const setKey = one.win.__SP_ART.state().setKey;
  assert.match(setKey, /^[0-9a-f]{12}$/, 'the set key is 12 hex chars');

  // ---- session 2 after a content release: a new byte hash, the SAME path list. Direction A: the
  //      set key is unchanged, so the record carries -- only the owed path is retried.
  const after = { hash: '7ae1d03466cb', g: {} };
  for (let i = 0; i < 12; i++) after.g['k' + i] = paths[i];
  const two = mkWorld({ noAuto: true, manifest: after, failSet, localStorage });
  two.run();
  two.win.__SP_ART.start();
  await drain(two);
  assert.deepEqual(Array.from(new Set(two.net.assetCalls())), [paths[4]],
    'a same-set hash change resumes: only the owed path is retried');
  assert.equal(two.win.__SP_ART.state().setKey, setKey, 'the set key is stable across the hash change');
  assert.equal(two.win.__SP_ART.state().hash, '7ae1d03466cb', 'the byte hash is still tracked (diagnostics)');
  assert.equal(two.win.__SP_ART.done, 11, 'the same set settles to the same count');
  assert.deepEqual(Array.from(two.win.__SP_ART.failed()), [paths[4]],
    'the owed path is still owed -- never silently dropped');
  assert.equal(two.win.__SP_ART.phase, 'done');
  assert.ok(JSON.parse(localStorage.map.get('sp.art.v1'))[setKey],
    'the record is stored under the SET key, so the next reload of it can resume');
  assert.equal(JSON.parse(localStorage.map.get('sp.art.v1'))[setKey].setKey, setKey,
    'the record names its set key');

  // ---- an UNCHANGED manifest still resumes (the cheap path is not lost)
  const again = mkWorld({ noAuto: true, manifest: after, failSet, localStorage });
  again.run();
  again.win.__SP_ART.start();
  await drain(again);
  assert.deepEqual(Array.from(new Set(again.net.assetCalls())), [paths[4]],
    'a reload under the SAME set resumes: only the owed path is retried');

  // ---- a DIFFERENT set must never carry
  const changed = { hash: 'ffee00112233', g: { z: '/assets/ui/zed.png' } };
  const three = mkWorld({ noAuto: true, manifest: changed, failSet, localStorage });
  three.run();
  three.win.__SP_ART.start();
  await drain(three);
  assert.deepEqual(three.net.assetCalls(), ['/assets/ui/zed.png'], 'a changed set starts over');
  assert.notEqual(three.win.__SP_ART.state().setKey, setKey, 'a changed set has a different key');
  assert.equal(three.win.__SP_ART.done, 1);
  assert.equal(three.win.__SP_ART.phase, 'done');
});

// ---------------------------------------------------------------- rates (owner ask 2026-10-09)

// The chip must carry the preload SPEED, not just the count. Bytes come off the Content-Length of
// the ok settlements only (an error body is not "downloaded art"), files/s and the ETA come off the
// settlement count -- and a response without a size must degrade to files/s rather than a fake rate.
const SPEED_MANIFEST = () => {
  const doc = { g: {} };
  const sizes = new Map();
  for (let i = 0; i < 20; i++) {
    const p = '/assets/ui/sp' + i + '.png';
    doc.g['k' + i] = p;
    sizes.set(p, 524288); // 512 KiB each
  }
  return { doc, sizes };
};

/** One settle + one pacing gap per round, so the virtual clock actually advances (~120 ms a round). */
async function stepWalk(w, rounds, perRound = 1) {
  for (let i = 0; i < rounds; i++) {
    w.net.flush(perRound);
    await flush();
    w.sched.fire();
    await flush();
  }
}

test('rates: the chip shows the speed + ETA while the walk is on', async () => {
  const { doc, sizes } = SPEED_MANIFEST();
  const w = mkWorld({ noAuto: true, manifest: doc, manual: true, sizes });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  await stepWalk(w, 10); // ten settled, ten owed, ~1.2 s of virtual walk
  const chip = w.chip();
  assert.ok(chip, 'the chip is up while the walk runs');
  assert.match(chip, /^art 10\/20/, 'the count stays on the chip: ' + chip);
  assert.match(chip, /\d+(\.\d+)? (MB|KB|B)\/s/, 'the chip carries the byte rate: ' + chip);
  assert.match(chip, /(\d+m\d+s|\d+s)$/, 'and the ETA while work is owed: ' + chip);
  const st = w.win.__SP_ART.state();
  assert.equal(st.bytes, 10 * 524288, 'bytes = the Content-Length sum of the ok settlements');
  assert.equal(st.bytesKnown, true);
  assert.ok(st.elapsedMs > 500, 'the rates need a measured walk');
  assert.ok(st.filesPerSec > 0, 'files/s is measured over the trailing window');
  assert.ok(st.etaMs > 0, 'an owed tail has an ETA');
  // the same numbers ride the progress callback (the panel mirrors them)
  const seen = [];
  w.win.__SP_ART.onProgress((s) => seen.push(s));
  assert.equal(seen[0].bytes, st.bytes, 'the snapshot carries the same byte count');
  assert.equal(seen[0].bytesKnown, true);
  assert.ok(typeof seen[0].bps === 'number' && typeof seen[0].etaMs === 'number');
  w.win.__SP_ART.cancel();
});

test('rates: without a Content-Length the chip falls back to files/s (never a byte rate)', async () => {
  const { doc } = SPEED_MANIFEST();
  const w = mkWorld({ noAuto: true, manifest: doc, manual: true }); // no sizes -> no headers at all
  w.run();
  w.win.__SP_ART.start();
  await flush();
  await stepWalk(w, 10);
  const chip = w.chip();
  assert.match(chip, /^art 10\/20/, chip);
  assert.match(chip, /\d+(\.\d+)? f\/s/, 'the fallback unit is files/s: ' + chip);
  assert.doesNotMatch(chip, /(MB|KB|B)\/s/, 'no byte rate is invented: ' + chip);
  const st = w.win.__SP_ART.state();
  assert.equal(st.bytesKnown, false, 'no response carried a size');
  assert.equal(st.bytes, 0);
  w.win.__SP_ART.cancel();
});

test('rates: a 404 body is never counted as downloaded bytes', async () => {
  const doc = { a: '/assets/ui/ok.png', b: '/assets/ui/gone.png' };
  const sizes = new Map([['/assets/ui/ok.png', 1000], ['/assets/ui/gone.png', 9999]]);
  const w = mkWorld({ noAuto: true, manifest: doc, sizes, deadSet: new Set(['/assets/ui/gone.png']) });
  w.run();
  w.win.__SP_ART.start();
  await drain(w);
  const st = w.win.__SP_ART.state();
  assert.equal(st.done, 1, 'only the ok entry settles as done (a 404 settles as permanent)');
  assert.equal(st.failed, 1);
  assert.equal(st.bytes, 1000, 'only the ok response fed the byte count');
  assert.equal(st.bytesKnown, true);
});

test('rates: a resumed session reports no speed for work it did not do', async () => {
  const storage = mkStorage();
  const one = mkWorld({ noAuto: true, localStorage: storage });
  one.run();
  one.win.__SP_ART.start();
  await drain(one);
  const total = one.win.__SP_ART.total;
  const two = mkWorld({ noAuto: true, localStorage: storage });
  two.run();
  two.win.__SP_ART.start();
  await drain(two);
  const st = two.win.__SP_ART.state();
  assert.equal(st.done, total, 'the resumed walk carries the count');
  assert.equal(st.resumed, true);
  assert.equal(st.bytes, 0, 'nothing was downloaded this session');
  assert.equal(st.filesPerSec, 0, 'no rate is invented for carried progress');
  assert.equal(st.bps, 0);
  assert.equal(st.avgFilesPerSec, 0, 'the carried count is not averaged into this session');
});

// ---------------------------------------------------------------- adaptive window (audit 2026-10-09 phase 5)

// A healthy link may grow the window past the initial 2, up to MAX_WINDOW -- which must stay equal to
// the shell's prefetch slot allowance (raising one without the other just makes the extra fetches
// wait 300 ms and fail). Failures still narrow it, and a match screen still pauses the walk outright.
test('the window grows past the initial 2 while the link is healthy, and stays within MAX_WINDOW', async () => {
  const many = { hash: 'grow', g: {} };
  for (let i = 0; i < 40; i++) many.g['k' + i] = '/assets/ui/g' + i + '.png';
  const w = mkWorld({ noAuto: true, manifest: many, manual: true });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  for (let i = 0; i < 400 && w.win.__SP_ART.phase === 'running'; i++) {
    w.net.flush(1); // one success at a time, so the success streak can actually build up
    w.sched.fire(); // let the pacing gate lapse
    await flush();
  }
  assert.ok(w.net.maxInflight > 2, 'the window grew past the initial 2 (maxInflight=' + w.net.maxInflight + ')');
  assert.ok(w.net.maxInflight <= 4, 'and stayed within MAX_WINDOW (maxInflight=' + w.net.maxInflight + ')');
  assert.equal(w.win.__SP_ART.state().window, 4, 'the window settled at MAX_WINDOW on a healthy link');
  assert.equal(w.win.__SP_ART.done, 40, 'and the walk still finished');
  assert.equal(w.win.__SP_ART.failedCount, 0);
});

// ---------------------------------------------------------------- error classification (D3)

// Audit 2026-10-09 §2 D3: the page and the shell must classify a status the same way. Only 404/410
// is a definitive miss (the shell remembers it for ten minutes); 408/425/429/5xx are TRANSIENT. A
// throttle answered with a hard "missing" for ten minutes is how one 429 turns into blank art.
test('a 429 is transient and its Retry-After drives the backpressure (not the 0.5 s ladder)', async () => {
  const p = '/assets/ui/throttled.png';
  const statusSet = new Map([[p, { status: 429, headers: { get: (k) => (k === 'retry-after' ? '30' : null) } }]]);
  const w = mkWorld({ noAuto: true, manifest: { hash: 'throttle', g: { a: p } }, statusSet });
  w.run();
  const backoffs = [];
  w.win.__SP_ART.onProgress(() => { backoffs.push(w.win.__SP_ART.state().backoffMs); });
  w.win.__SP_ART.start();
  await drain(w);
  assert.equal(w.net.assetCalls().length, 3, 'a transient 429 is retried up to MAX_ATTEMPTS');
  assert.deepEqual(Array.from(w.win.__SP_ART.failed()), [p], 'it stays owed — a failed fetch is never counted as done');
  assert.equal(w.win.__SP_ART.done, 0, 'nothing was settled as a success');
  assert.ok(backoffs.some((b) => b >= 29000),
    'Retry-After: 30 sets a ~30 s penalty (got ' + JSON.stringify(backoffs) + ')');
});

test('a 404 is a definitive miss: fetched exactly once, never retried', async () => {
  const p = '/assets/ui/gone.png';
  const w = mkWorld({ noAuto: true, manifest: { hash: 'gone', g: { g: p } }, deadSet: new Set([p]) });
  w.run();
  w.win.__SP_ART.start();
  await drain(w);
  assert.equal(w.net.assetCalls().length, 1, 'a 404 is not retried in this session');
  assert.deepEqual(Array.from(w.win.__SP_ART.failed()), [p], 'the path stays owed for the next session');
  assert.equal(w.win.__SP_ART.done, 0);
});

// ---------------------------------------------------------------- placeholder status (D2)

// Audit 2026-10-09 §2 D2: the shell answers a genuinely unavailable asset with a 200 + a transparent
// 1x1 PNG (so an <img> never cascades broken-image errors) and marks it X-SP-Art-Placeholder. Without
// honouring that marker the walk counts the stand-in as a preloaded asset AND drops the path from the
// owed list -- the missing art is then never fetched again.
test('a marked placeholder 200 is not a settlement: retried, then left owed', async () => {
  const p = '/assets/ui/missing.png';
  const ph = { get: (k) => (k === 'x-sp-art-placeholder' ? '1' : null) };
  const statusSet = new Map([[p, { ok: true, status: 200, headers: ph }]]);
  const w = mkWorld({ noAuto: true, manifest: { hash: 'ph', g: { m: p } }, statusSet });
  w.run();
  w.win.__SP_ART.start();
  await drain(w);
  assert.equal(w.win.__SP_ART.done, 0, 'a placeholder is never counted as a preloaded asset');
  assert.deepEqual(Array.from(w.win.__SP_ART.failed()), [p], 'the path stays owed for the next session');
  assert.ok(w.net.assetCalls().length >= 2, 'the placeholder is transient: it is retried, not accepted');
});

// ---------------------------------------------------------------- browser cache (audit 2026-10-09 phase 4)

// The shell answers every /assets/** from filesDir itself, so bypassing the WebView's HTTP cache costs
// one local read and no network. With force-cache the WebView would replay a pre-hot-update copy for
// the whole max-age window -- "改了不生效" (D5). The manifest is hot-updatable too, so it must not be
// answered from a forced cache hit either (that would walk the PREVIOUS asset list).
test('every prefetch fetch bypasses the WebView HTTP cache (no-store), the manifest included', async () => {
  const w = mkWorld({ noAuto: true });
  w.run();
  w.win.__SP_ART.start();
  await drain(w);
  assert.ok(w.net.calls.length >= 3, 'the run made calls (manifest + local list + assets)');
  const forced = w.net.calls.filter((c) => !c.init || c.init.cache !== 'no-store').map((c) => c.url);
  assert.deepEqual(forced, [], 'no fetch may use the WebView HTTP cache');
});

// ---------------------------------------------------------------- pack-first (C, 2026-10-09)

// The art-pack channel is the fast lane (23 size-capped zips, multi-connection download + local
// unpack, versus 10643 small requests), so the file walk yields to it and resumes when it finishes.
test('the walk stands down while the art-pack channel is installing, then resumes', async () => {
  let active = true;
  const shell = {
    artSyncBridge: true,
    artSyncStatus() { return JSON.stringify({ ok: true, active: active, stage: 'download' }); },
  };
  const w = mkWorld({ noAuto: true, manifest: { hash: 'pk', g: { a: '/assets/ui/p0.png' } }, shell });
  w.run();
  w.win.__SP_ART.start();
  await flush();
  await flush();
  assert.equal(w.win.__SP_ART.state().paused, 1, 'the walk pauses while the pack channel is active');
  assert.deepEqual(w.net.assetCalls(), [], 'and dispatches nothing while it waits');

  active = false; // the pack install finished
  for (let i = 0; i < 60 && w.win.__SP_ART.phase === 'running'; i++) {
    w.sched.fire();
    await flush();
  }
  assert.equal(w.win.__SP_ART.phase, 'done', 'it resumes once the pack channel is done');
  assert.deepEqual(w.net.assetCalls(), ['/assets/ui/p0.png'], 'and then does its job');
  assert.equal(w.win.__SP_ART.state().paused, 0, 'the pause is released');
});

// ---------------------------------------------------------------- cross-origin record (addition A)

// localStorage is scoped PER ORIGIN and the page's origin IS the connected game server, so a server
// switch used to hide the walk record and re-walk all ~7969 entries from zero (the chip restarted at
// 0). With the shell bridge the same record lives under filesDir (like player-data's spData), so the
// walk survives the switch. Without the bridge the old behaviour stands -- the feature degrades, it
// does not disappear.
test('a server switch (a NEW origin) still resumes: the record rides the shell store', async () => {
  const mem = { text: '' };
  const shell = {
    artWalkBridge: true,
    artWalkGet() { return mem.text; },
    artWalkPut(t) { mem.text = t; return true; },
  };
  const paths = [];
  const manifest = { hash: 'switch', g: {} };
  for (let i = 0; i < 8; i++) { paths.push('/assets/ui/s' + i + '.png'); manifest.g['k' + i] = paths[i]; }
  const failSet = new Set([paths[2]]);

  // ---- session 1 on server A
  const a = mkWorld({ noAuto: true, manifest, failSet, shell, localStorage: mkStorage() });
  a.run();
  a.win.__SP_ART.start();
  await drain(a);
  assert.equal(a.win.__SP_ART.done, 7);
  assert.ok(mem.text.indexOf('"switch"') >= 0, 'the record was written through the shell bridge');

  // ---- session 2 on server B: a DIFFERENT (empty) localStorage, because the origin changed
  const b = mkWorld({ noAuto: true, manifest, failSet, shell, localStorage: mkStorage() });
  b.run();
  b.win.__SP_ART.start();
  assert.equal(b.chip(), 'art 7/8 (1 failed)', 'the first paint resumes from the cross-origin record');
  await drain(b);
  assert.deepEqual(Array.from(new Set(b.net.assetCalls())), [paths[2]],
    'only the owed path is retried -- the walk did NOT restart from zero');

  // ---- without the bridge a new origin still re-walks (which is exactly why the bridge matters)
  const c = mkWorld({ noAuto: true, manifest, failSet, localStorage: mkStorage() });
  c.run();
  c.win.__SP_ART.start();
  await drain(c);
  assert.equal(new Set(c.net.assetCalls()).size, paths.length,
    'without the shell bridge a new origin re-walks everything');
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
