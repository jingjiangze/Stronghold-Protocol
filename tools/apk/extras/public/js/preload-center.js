/* global window, document, caches */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here (localStorage/sessionStorage/AbortController/fetch/Response/setTimeout are built-in globals there and must not be re-declared)
/* preload-center.js -- browser disk-cache preload center (Paper-Yuan port, 2026-10-08).
 *
 * WHY (owner direction 2026-10-08, corrected): the third-party server's UI/gameplay must match
 * the client immediately. The way Paper-Yuan does it is to load the PAGE and its resources from
 * the SERVER origin and let the BROWSER DISK CACHE carry the speed (his "asset preload and offline cache center"
 * warms 4255 files / 428.5 MB into the browser cache; a ~35 MB core profile and a ~280 MB full
 * profile). Our shell can already render a server-origin page (the per-host "use the server's own
 * client" toggle, MainActivity.remoteClientFor -> shell.useRemoteClient). This module is the
 * missing half: a page-side preload center that warms the browser cache for whatever origin the
 * page is on, so a server-origin page is never slowed by the network.
 *
 * WHAT THIS DOES: read the CURRENT origin's /data/assets.json (same-origin -- server or local),
 * enumerate every /assets/** and /fonts/** reference, split it into two profiles:
 *   core  UI, operator avatars, emotes, profession/skill/module icons, lobby bgm, common sfx,
 *         fonts (calibrated against data/assets.json: ~2.9k of 7.98k paths, ~35 MB class)
 *   full  the whole set: adds operator portraits, every Spine model and the battle voices/bgm
 *         (~8.0k paths, ~280 MB class)
 * and fetch it in the background into the browser disk cache:
 *   - CacheStorage (caches.open) is the explicit store when available -- it is what the panel's
 *     verify and clear actions act on, and it survives a reload regardless of the server's
 *     Cache-Control; a match() hit is counted as cached with no network at all;
 *   - a plain fetch(path, {cache:'force-cache'}) is the fallback (and also what populates the
 *     WebView HTTP cache the page's own <img>/<audio> then hit).
 *
 * THE PAGE ALWAYS WINS: this is a guest on a phone's link. It reuses art-prefetch.js's policy
 * verbatim -- CONCURRENCY 2 (the shell reserves 4 CDN slots for the page), GAP_MS pacing,
 * exponential backoff (500/1000 ms, cap 8 s, a 4xx is permanent), the X-SP-Prefetch header (the
 * shell serves the page's own fetches first), and a full stand-down while a match / briefing
 * screen is on the page or the document is hidden. It also YIELDS to art-prefetch.js: when that
 * module is present it already walks the FULL set in the background, so this center's `full`
 * action delegates to it (same policy, same per-manifest-hash persistence) instead of running a
 * second walker, and the default auto-start is skipped (art already covers it). `core` is this
 * center's own fast subset -- it finishes in a fraction of the full walk so the game is usable
 * almost immediately.
 *
 * DEFAULT (2026-10-08, owner): ONE background walker, the FULL set, no popup. art-prefetch.js is
 * that walker -- it self-starts the full walk at load and it is the only module whose fetches warm a
 * store the game actually reads (on the APK: filesDir/art/cache via the WebView interceptor; on the
 * web: the HTTP disk cache). This center therefore never auto-starts its own engine while art is
 * present (`if (artApi()) return` below), and every start()/pause()/resume() it exposes drives art's
 * walker instead of running a second one. Its own engine survives only as the fallback for a page
 * without art-prefetch (auto-starts the FULL profile then) and for tests
 * (`window.__SP_PRELOAD_OWN_ENGINE = 1` forces it, `window.__SP_PRELOAD_NO_AUTO = 1` disables the
 * fallback auto-start); a skip pressed in this session (sessionStorage) is honoured until the
 * session ends. There is NO pill and NO auto-opened panel: the only always-visible progress display
 * is art-prefetch's bottom-right chip, whose label opens this panel on demand.
 *
 * WHY CacheStorage IS NOT THE PRIMARY STORE (audit 2026-10-08): nothing outside this file reads
 * `stronghold-preload-v1` -- there is no service worker and no fetch/XHR hook anywhere in the shell,
 * and the Java interceptor that serves /assets/** cannot see a browser CacheStorage. So the bytes
 * this engine writes are only useful to this engine's own verify/clear; the walk that matters is
 * art-prefetch's, and a second engine over the same paths would only re-request the same files.
 *
 * PERSISTENCE: progress is kept per manifest hash AND per profile in localStorage
 * (`sp.preload.v1` = { <hash>: { core:{...}, full:{...} } }, `sp.preload.last` = newest hash), so
 * a reload continues from the stored count instead of restarting; a changed manifest hash with a
 * different fingerprint invalidates the record. The stored list is capped (MAX_FAILED).
 *
 * API (window.__SP_PRELOAD):
 *   state()                  diagnostic object (phase, profile, done, total, failed, bytes,
 *                            cached:{core,full}, resumed, paused, delegated, saved)
 *   profiles()               [{id:'core',total,bytes?},{id:'full',total}] once the manifest landed
 *   start(profile)           begin/resume 'core'|'full' (default 'core'); idempotent while busy
 *   pause() / resume()       stop dispatching / continue
 *   clear()                  drop the CacheStorage bucket + every stored record (async)
 *   verify(profile)          re-check CacheStorage for the profile's paths; -> Promise<report>
 *   open() / close()         show / hide the panel (the pill calls open())
 *   onProgress(cb)           cb(snapshot) now and on every change
 *   hide() / show()          the corner pill (kept out of the way of the title footer)
 *
 * UI: a minimal bottom-left pill plus a modal, built with its own DOM and inline styles only (no
 * dependency on any stylesheet); it never blocks the page (the pill is small, the modal is
 * opt-in). Missing fetch / offline / no CacheStorage all degrade silently -- the game still runs.
 *
 * Contract: ES5, pure ASCII, no third-party dependency, idempotent (loading it twice is a no-op).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__SP_PRELOAD) return;

  // ---- policy (mirrors art-prefetch.js so the two walkers behave identically) ----------------
  var CONCURRENCY = 2;          // upper bound on fetches in flight (the shell keeps 4 page slots)
  var MIN_WINDOW = 1;           // backpressure floor
  var RECOVER_STREAK = 8;       // consecutive successes before the window grows back by one
  var GAP_MS = 120;             // minimum spacing between dispatches (do not arrive as a burst)
  var PAGE_POLL_MS = 400;       // how often the page-busy probe may re-run
  // A match / briefing / result screen means the page is asking for art RIGHT NOW: stand down.
  var MATCH_MARKS = '.screen.brief, .screen.gm, .screen.gload, .screen.result, .screen.draft';
  // Marks a fetch as background work; the shell then lets it hold at most 2 CDN slots.
  var PREFETCH_HEADER = 'X-SP-Prefetch';
  var MANIFEST = '/data/assets.json';
  var CACHE_NAME = 'stronghold-preload-v1';
  var LS_KEY = 'sp.preload.v1';
  var LS_LAST_KEY = 'sp.preload.last';
  var SS_SKIP_KEY = 'sp.preload.skip.v1';
  var MAX_ATTEMPTS = 3;         // first try + 2 retries, per asset
  var RETRY_BASE_MS = 500;
  var RETRY_MAX_MS = 8000;
  var MANIFEST_ATTEMPTS = 3;
  var MAX_FAILED = 1000;        // capped failed key list kept per record
  var MAX_RECORDS = 3;          // how many manifest-hash records to keep in localStorage
  var SAVE_EVERY = 16;          // persist every N settlements (plus finish/cancel/pagehide)
  var FETCH_TIMEOUT_MS = 15000; // soft per-request ceiling (only when AbortController exists)
  var CORE = 'core';
  var FULL = 'full';
  // The core subset, by path prefix (everything else -> full). Calibrated against the shipped
  // data/assets.json (7976 referenced paths): ui/ ~600, char/avatar/ 402, token/avatar/ 50,
  // enemy/icon/ 252, item/ 59, band/ 40, bond/ 23, prof/ 93, skill/ 522, module/ 130,
  // audio/sfx/ 686, audio/bgm/ 19, fonts/ 3  ->  ~2.9k paths. The rest (portraits 402,
  // spine 2015, voice 2674) is the full profile.
  var CORE_MARKS = [
    '/assets/ui/', '/assets/char/avatar/', '/assets/token/avatar/', '/assets/enemy/icon/',
    '/assets/item/', '/assets/band/', '/assets/bond/', '/assets/prof/', '/assets/skill/',
    '/assets/module/', '/assets/audio/sfx/', '/assets/audio/bgm/', '/fonts/',
  ];

  // ---- UI strings (pure ASCII: the Chinese is written as \u escapes) -------------------------
  var T_PILL_IDLE = '\u26A1 \u8D44\u6E90\u9884\u8F7D';
  var T_TITLE = '\u8D44\u6E90\u9884\u8F7D\u4E0E\u79BB\u7EBF\u7F13\u5B58\u4E2D\u5FC3';
  var T_DESC = '\u5C06\u5F53\u524D\u670D\u52A1\u5668\u7684\u7D20\u6750\u9884\u8F7D\u81F3\u6D4F\u89C8\u5668\u78C1\u76D8\u7F13\u5B58\uFF1B\u9884\u8F7D\u540E\u5C40\u5185\u52A0\u8F7D\u76F4\u63A5\u547D\u4E2D\u672C\u5730\u7F13\u5B58\uFF0C\u514D\u9664\u5F31\u7F51\u5361\u987F\u3002\u9884\u8F7D\u9ED8\u8BA4\u540E\u53F0\u8FDB\u884C\uFF0C\u7EDD\u4E0D\u963B\u585E\u9875\u9762\uFF1B\u8FDB\u5EA6\u89C1\u53F3\u4E0B\u89D2\u89D2\u6807\uFF0C\u6B64\u9762\u677F\u4EC5\u7528\u4E8E\u624B\u52A8\u63A7\u5236\u3002';
  var T_CORE_T = '\u26A1 \u57FA\u7840\u6838\u5FC3\u5305';
  var T_CORE_D = '\u754C\u9762 UI\u3001\u5E72\u5458\u5934\u50CF\u3001\u8868\u60C5\u3001\u804C\u4E1A\u4E0E\u6280\u80FD\u56FE\u6807\u3001\u5927\u5385\u4E0E\u5E38\u7528\u97F3\u6548\u3002';
  var T_FULL_T = '\u{1F31F} \u5B8C\u6574\u79BB\u7EBF\u5305';
  var T_FULL_D = '\u5728\u57FA\u7840\u5305\u4E4B\u4E0A\uFF0C\u8FFD\u52A0\u5E72\u5458\u7ACB\u7ED8\u3001Spine \u9AA8\u9ABC\u6A21\u578B\u3001\u6218\u6597\u8BED\u97F3\u4E0E\u5168\u90E8\u80CC\u666F\u97F3\u4E50\u3002';
  var T_SIZE_C = '~35 MB (\u63A8\u8350)';
  var T_SIZE_F = '~280 MB (\u5168\u91CF)';
  var T_BADGE = '\u2713 \u5DF2\u7F13\u5B58';
  var T_START = '\u5F00\u59CB\u9884\u8F7D';
  var T_RECHECK = '\u91CD\u65B0\u6821\u9A8C/\u4E0B\u8F7D';
  var T_PAUSE = '\u6682\u505C';
  var T_RESUME = '\u7EE7\u7EED';
  var T_CLEAR = '\u6E05\u9664\u672C\u5730\u7F13\u5B58';
  var T_CLOSE = '\u5B8C\u6210';
  var T_ST_SCAN = '\u{1F50D} \u6B63\u5728\u89E3\u6790\u8D44\u6E90\u4F9D\u8D56\u6E05\u5355\u2026';
  var T_ST_RUN = '\u26A1 \u6B63\u5728\u540E\u53F0\u9884\u8F7D\u2026';
  var T_ST_PAUSE = '\u23F8 \u9884\u8F7D\u5DF2\u6682\u505C';
  var T_ST_DONE = '\u{1F389} \u8D44\u6E90\u9884\u8F7D\u6821\u9A8C\u5B8C\u6210\uFF01';
  var T_CUR = '\u6B63\u5728\u5904\u7406: ';
  var T_BYTES = '\u5DF2\u7F13\u5B58: ';
  var T_ERR_LIST = '\u672A\u80FD\u89E3\u6790\u5230\u8D44\u6E90\u6E05\u5355\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u8FDE\u63A5';
  var T_FILES = ' \u6587\u4EF6';
  var T_MB = ' MB';

  // ---- state ---------------------------------------------------------------------------------
  var phase = 'idle';           // idle | scanning | running | paused | done | failed
  var profile = CORE;
  var done = 0, total = 0, doneBytes = 0;
  var failedCount = 0, failedTotal = 0, failedKeys = [], failedSet = {};
  var queue = [], retries = [], queued = {};
  var active = 0, limit = CONCURRENCY;
  var started = false, cancelled = false, resumed = false, delegated = false;
  var callbacks = [];
  var attempts = 0, settlements = 0, okStreak = 0;
  var penaltyUntil = 0, nextDispatchAt = 0;
  var wakeTimer = null, pauseTimer = null, manifestTimer = null;
  var paused = 0, busyAt = -1e15, busy = 0;
  var manifestPending = false, manifestTries = 0;
  var hash = '', fp = '';
  var cursor = 0;
  var settledFlags = null;
  var lists = { core: [], full: [] };
  var listReady = false;
  var currentFile = '';
  var savePaused = false;
  var cachedProfiles = { core: false, full: false };
  var cacheObj = null, cacheSupported = false, cacheOpening = false;
  var artUnsub = null;

  // ---- small helpers -------------------------------------------------------------------------
  function now() {
    return typeof Date !== 'undefined' && Date.now ? Date.now() : new Date().getTime();
  }

  function clampInt(v, lo, hi) {
    var n = typeof v === 'number' && isFinite(v) ? Math.floor(v) : lo;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function store() {
    try { return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null; }
    catch (e) { return null; }
  }

  function sess() {
    try { return (typeof sessionStorage !== 'undefined' && sessionStorage) ? sessionStorage : null; }
    catch (e) { return null; }
  }

  function readAll() {
    var ls = store();
    if (!ls || savePaused) return null;
    try {
      var raw = ls.getItem(LS_KEY);
      var doc = raw ? JSON.parse(raw) : null;
      return doc && typeof doc === 'object' ? doc : null;
    } catch (e) { return null; }
  }

  function writeAll(doc) {
    var ls = store();
    if (!ls || savePaused) return false;
    try { ls.setItem(LS_KEY, JSON.stringify(doc)); return true; }
    catch (e) { savePaused = true; return false; }
  }

  function ns() { return hash || 'nohash'; }

  /** Fingerprint of the enumerated list (FNV-1a): a different asset set -> a different value. */
  function fingerprint(list) {
    var h = 0x811c9dc5;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      for (var j = 0; j < s.length; j++) {
        h = h ^ s.charCodeAt(j);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      }
      h = h ^ 0x2f;
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  /** True while the walk must stand down: a match screen is up, or the document is hidden. */
  function pageBusy() {
    var t = now();
    if (t - busyAt < PAGE_POLL_MS) return busy;
    busyAt = t;
    busy = 0;
    try {
      if (typeof document === 'undefined') return busy;
      if (document.visibilityState === 'hidden') busy = 1;
      else if (typeof document.querySelector === 'function' && document.querySelector(MATCH_MARKS)) busy = 1;
    } catch (e) { /* a probe failure must never stop the walk */ }
    return busy;
  }

  function backoffMs(attempt) {
    var ms = RETRY_BASE_MS;
    for (var i = 1; i < attempt; i++) ms = ms * 2;
    return ms > RETRY_MAX_MS ? RETRY_MAX_MS : ms;
  }

  function classify(res) {
    if (res && res.ok) return 'ok';
    var code = res && typeof res.status === 'number' ? res.status : 0;
    if (code === 408 || code === 425 || code === 429 || code >= 500) return 'retry';
    if (code >= 400) return 'dead'; // 401/403/404/410: a retry would fetch the same answer
    return 'retry';                 // opaque response (status 0): treat as transient
  }

  /** Paper-Yuan's extractUrls equivalent: every /assets/** and /fonts/** reference, deduped. */
  function toLocal(v) {
    if (typeof v !== 'string') return null;
    var i = v.indexOf('/assets/');
    if (i >= 0) return v.substring(i);
    var j = v.indexOf('/assets-re/');
    if (j >= 0) return '/assets/' + v.substring(j + 11);
    var k = v.indexOf('/fonts/');
    if (k >= 0) return v.substring(k);
    return null;
  }

  function collect(node, out, seen) {
    if (node == null) return;
    if (typeof node === 'string') {
      var p = toLocal(node);
      if (p && !seen[p]) { seen[p] = 1; out.push(p); }
      return;
    }
    if (typeof node !== 'object') return;
    if (Object.prototype.toString.call(node) === '[object Array]') {
      for (var i = 0; i < node.length; i++) collect(node[i], out, seen);
      return;
    }
    for (var k in node) { if (Object.prototype.hasOwnProperty.call(node, k)) collect(node[k], out, seen); }
  }

  function isCore(p) {
    for (var i = 0; i < CORE_MARKS.length; i++) { if (p.indexOf(CORE_MARKS[i]) === 0) return true; }
    return false;
  }

  function buildLists(doc) {
    var all = [], seen = {};
    try { collect(doc, all, seen); } catch (e) { all = []; }
    var core = [];
    for (var i = 0; i < all.length; i++) { if (isCore(all[i])) core.push(all[i]); }
    if (!core.length) core = all.slice(0); // unknown manifest shape -> core degrades to the full set
    lists = { core: core, full: all };
    hash = doc && typeof doc.hash === 'string' ? doc.hash : '';
    fp = fingerprint(all);
    listReady = true;
  }

  // ---- persistence ---------------------------------------------------------------------------
  function save() {
    var ls = store();
    if (!ls || savePaused || !listReady) return;
    var doc = readAll() || {};
    var rec = doc[ns()] && typeof doc[ns()] === 'object' ? doc[ns()] : {};
    rec[profile] = {
      hash: hash, fp: fp, total: total, done: done, cursor: cursor,
      bytes: doneBytes, failed: failedKeys.slice(0, MAX_FAILED), failedTotal: failedTotal, t: now(),
    };
    doc[ns()] = rec;
    var keys = [];
    for (var k in doc) { if (Object.prototype.hasOwnProperty.call(doc, k)) keys.push(k); }
    if (keys.length > MAX_RECORDS) {
      keys.sort(function (a, b) {
        var ta = doc[a] && doc[a].core ? doc[a].core.t : (doc[a] && doc[a].full ? doc[a].full.t : 0);
        var tb = doc[b] && doc[b].core ? doc[b].core.t : (doc[b] && doc[b].full ? doc[b].full.t : 0);
        return (tb || 0) - (ta || 0);
      });
      for (var i = MAX_RECORDS; i < keys.length; i++) delete doc[keys[i]];
    }
    if (writeAll(doc)) { try { ls.setItem(LS_LAST_KEY, ns()); } catch (e) { /* ignore */ } }
  }

  function recordFor(namespace, prof) {
    var doc = readAll();
    if (!doc || !namespace) return null;
    var rec = doc[namespace];
    if (!rec || typeof rec !== 'object') return null;
    var r = rec[prof];
    return r && typeof r === 'object' ? r : null;
  }

  /** The stored record for the manifest at hand -- only when it describes the SAME asset set. */
  function matchingRecord() {
    var rec = recordFor(ns(), profile);
    if (rec && rec.fp === fp && rec.total === lists[profile].length) return rec;
    return null;
  }

  function markProfileDone() {
    cachedProfiles[profile] = true;
    var ls = store();
    if (ls) { try { ls.setItem(LS_KEY + '.' + profile, '1'); } catch (e) { /* ignore */ } }
  }

  function loadCachedProfiles() {
    var ls = store();
    if (!ls) return;
    for (var i = 0; i < 2; i++) {
      var p = i === 0 ? CORE : FULL;
      try { if (ls.getItem(LS_KEY + '.' + p) === '1') cachedProfiles[p] = true; } catch (e) { /* ignore */ }
    }
  }

  function skippedThisSession() {
    var ss = sess();
    if (!ss) return false;
    try { return ss.getItem(SS_SKIP_KEY) === '1'; } catch (e) { return false; }
  }

  function rememberSkip() {
    var ss = sess();
    if (!ss) return;
    try { ss.setItem(SS_SKIP_KEY, '1'); } catch (e) { /* ignore */ }
  }

  // ---- browser cache (CacheStorage when present; force-cache fetch always) --------------------
  function openCache() {
    if (cacheObj || cacheOpening) return;
    if (typeof caches === 'undefined' || !caches || typeof caches.open !== 'function') return;
    cacheSupported = true;
    cacheOpening = true;
    try {
      caches.open(CACHE_NAME).then(function (c) { cacheObj = c; cacheOpening = false; }, function () { cacheOpening = false; });
    } catch (e) { cacheOpening = false; }
  }

  /** CacheStorage hit for one path (async). Resolves true when a cached response exists. */
  function cacheHas(path) {
    if (!cacheObj) return Promise.resolve(false);
    try {
      return cacheObj.match(path).then(function (r) { return !!r; }, function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  /** Store a response (no body buffering: put streams the body straight to disk). The caller has
   *  already read the size off the headers, so consuming `res` here is safe and leaks nothing. */
  function cachePut(path, res) {
    if (!cacheObj) return Promise.resolve(false);
    try {
      return cacheObj.put(path, res).then(function () { return true; }, function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  function sizeOf(res) {
    try {
      var cl = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
      var n = cl ? parseInt(cl, 10) : 0;
      return isFinite(n) && n > 0 ? n : 0;
    } catch (e) { return 0; }
  }

  // ---- progress plumbing ---------------------------------------------------------------------
  function snapshot() {
    return {
      phase: phase, profile: profile, done: done, total: total, failed: failedCount,
      bytes: doneBytes, paused: paused, resumed: resumed, delegated: delegated,
      cached: { core: !!cachedProfiles.core, full: !!cachedProfiles.full },
    };
  }

  function diag() {
    return {
      phase: phase, profile: profile, done: done, total: total, failed: failedCount,
      bytes: doneBytes, pending: queue.length + active + retries.length, inflight: active,
      window: limit, attempts: attempts, paused: paused, gapMs: GAP_MS,
      resumed: resumed, delegated: delegated, hash: hash, fp: fp, cursor: cursor,
      cacheSupported: cacheSupported, cacheOpen: !!cacheObj,
      cached: { core: !!cachedProfiles.core, full: !!cachedProfiles.full },
      failedKeys: failedKeys.length, saved: !savePaused && !!store(),
    };
  }

  function emit() {
    var snap = snapshot();
    for (var i = 0; i < callbacks.length; i++) {
      try { callbacks[i](snap); } catch (e) { /* a bad callback must not break the pump */ }
    }
    updateUI();
  }

  function onProgress(cb) {
    if (typeof cb !== 'function') return;
    callbacks.push(cb);
    try { cb(snapshot()); } catch (e) { /* ignore */ }
  }

  // ---- manifest ------------------------------------------------------------------------------
  function loadManifest(cb) {
    manifestPending = true;
    var pr = null;
    try { pr = fetch(MANIFEST, { cache: 'force-cache' }); } catch (e) { pr = null; }
    if (!pr || typeof pr.then !== 'function') { manifestPending = false; cb(false); return; }
    pr.then(function (r) {
      if (!r || !r.ok) throw new Error('manifest unavailable');
      return r.json();
    }).then(function (doc) {
      manifestPending = false;
      try { buildLists(doc); } catch (e) { listReady = false; }
      cb(!!(listReady && lists[profile] && lists[profile].length));
    }, function () {
      manifestPending = false;
      manifestTries++;
      if (manifestTries < MANIFEST_ATTEMPTS && !cancelled) {
        var d = backoffMs(manifestTries);
        if (manifestTimer) { try { clearTimeout(manifestTimer); } catch (e) { /* ignore */ } }
        manifestTimer = setTimeout(function () {
          manifestTimer = null;
          if (cancelled) return;
          loadManifest(cb);
        }, d);
        return;
      }
      cb(false);
    });
  }

  // ---- the run -------------------------------------------------------------------------------
  function seedRun() {
    var list = lists[profile];
    queue = []; retries = []; queued = {}; active = 0; limit = CONCURRENCY;
    done = 0; doneBytes = 0; failedCount = 0; failedKeys = []; failedSet = {}; failedTotal = 0;
    cursor = 0; resumed = false; currentFile = '';
    settledFlags = [];
    for (var i0 = 0; i0 < list.length; i0++) settledFlags[i0] = 0;
    var rec = matchingRecord();
    if (rec) {
      done = clampInt(rec.done, 0, list.length);
      cursor = clampInt(rec.cursor, 0, list.length);
      doneBytes = clampInt(rec.bytes, 0, 1 << 30);
      var keys = Object.prototype.toString.call(rec.failed) === '[object Array]' ? rec.failed : [];
      var seen = {};
      for (var k = 0; k < keys.length && failedKeys.length < MAX_FAILED; k++) {
        var p = keys[k];
        if (typeof p !== 'string' || !p || seen[p]) continue;
        seen[p] = 1; failedKeys.push(p); failedSet[p] = 1;
      }
      failedTotal = Math.max(clampInt(rec.failedTotal, 0, list.length), failedKeys.length);
      resumed = done > 0 || cursor > 0 || failedKeys.length > 0;
      // entries before the cursor were already settled in an earlier session: mark them so the
      // contiguous prefix cannot be pulled back by a late settle
      for (var s = 0; s < cursor; s++) settledFlags[s] = 1;
    }
    failedCount = failedTotal;
    for (var f = 0; f < failedKeys.length; f++) enqueue(failedKeys[f], -1, true);
    for (var j = cursor; j < list.length; j++) enqueue(list[j], j, false);
  }

  function enqueue(path, idx, carried) {
    if (!path || queued[path]) return;
    queued[path] = 1;
    queue.push({ path: path, idx: idx, attempt: 0, at: 0, carried: !!carried });
  }

  /** Marks an index settled and advances the contiguous prefix: everything before the cursor is
   *  resolved (fetched or finally failed), so a reload skips it instead of re-requesting it. */
  function markSettled(idx) {
    if (idx < 0 || !settledFlags) return;
    if (settledFlags[idx]) return;
    settledFlags[idx] = 1;
    if (idx === cursor) {
      while (cursor < settledFlags.length && settledFlags[cursor]) cursor++;
    }
  }

  function settleOk(item, bytes) {
    if (done < total) done++;
    if (bytes > 0) doneBytes += bytes;
    if (failedSet[item.path]) {
      failedSet[item.path] = 0;
      for (var i = 0; i < failedKeys.length; i++) { if (failedKeys[i] === item.path) { failedKeys.splice(i, 1); break; } }
      if (failedTotal > 0) failedTotal--;
      failedCount = failedTotal;
    }
    markSettled(item.idx);
    okStreak++;
    if (okStreak >= RECOVER_STREAK) { okStreak = 0; if (limit < CONCURRENCY) limit++; }
  }

  function settleFail(item) {
    if (!failedSet[item.path]) {
      failedSet[item.path] = 1;
      if (failedKeys.length < MAX_FAILED) failedKeys.push(item.path);
      failedTotal++;
    }
    failedCount = failedTotal;
    markSettled(item.idx);
  }

  function settle(item, result, bytes) {
    active--;
    if (phase === 'running' || phase === 'paused') {
      if (result === 'ok') settleOk(item, bytes || 0);
      else if (result === 'retry' && item.attempt + 1 < MAX_ATTEMPTS) {
        item.attempt++;
        item.at = now() + backoffMs(item.attempt);
        retries.push(item);
        if (item.at > penaltyUntil) penaltyUntil = item.at;
        if (limit > MIN_WINDOW) limit--;
        okStreak = 0;
      } else settleFail(item);
      settlements++;
      if (settlements % SAVE_EVERY === 0) save();
      emit();
      wake();
    }
    pump();
  }

  function bypassCache(item) {
    return item.carried || item.attempt > 0;
  }

  function fetchOne(item) {
    active++;
    attempts++;
    var settledOnce = false;
    var timer = null;
    function once(result, bytes) {
      if (settledOnce) return;
      settledOnce = true;
      if (timer) { try { clearTimeout(timer); } catch (e) { /* ignore */ } timer = null; }
      settle(item, result, bytes);
    }
    // CacheStorage first: a match() hit is a real cached copy -> no network at all.
    cacheHas(item.path).then(function (hit) {
      if (hit) { once('ok', 0); return; }
      networkFetch(item, once, timer);
    }, function () { networkFetch(item, once, timer); });
  }

  function networkFetch(item, once, _timer) {
    var timer = null;
    var settled = false;
    function done(result, bytes) {
      if (settled) return;
      settled = true;
      if (timer) { try { clearTimeout(timer); } catch (e) { /* ignore */ } timer = null; }
      once(result, bytes);
    }
    try {
      var init = { cache: bypassCache(item) ? 'no-store' : 'force-cache' };
      var headers = {};
      headers[PREFETCH_HEADER] = '1';
      init.headers = headers;
      if (typeof AbortController === 'function') {
        var ctl = new AbortController();
        init.signal = ctl.signal;
        timer = setTimeout(function () { try { ctl.abort(); } catch (e) { /* ignore */ } }, FETCH_TIMEOUT_MS);
      }
      var pr = fetch(item.path, init);
      if (!pr || typeof pr.then !== 'function') { done('retry', 0); return; }
      pr.then(function (r) {
        var verdict = classify(r);
        if (verdict !== 'ok') {
          if (r && r.body && typeof r.body.cancel === 'function') { try { r.body.cancel(); } catch (e) { /* ignore */ } }
          done(verdict, 0);
          return;
        }
        var bytes = sizeOf(r);
        if (cacheObj) {
          // put() streams the body to disk (no JS buffering); the size was read off the headers.
          cachePut(item.path, r).then(function () { done('ok', bytes); }, function () { done('ok', bytes); });
        } else {
          // No CacheStorage: the force-cache fetch already warmed the WebView HTTP cache; release
          // the stream we will not read (a plain fetch there has no caller to consume it).
          if (r && r.body && typeof r.body.cancel === 'function') { try { r.body.cancel(); } catch (e) { /* ignore */ } }
          done('ok', bytes);
        }
      }, function () { done('retry', 0); });
    } catch (e) { done('retry', 0); }
  }

  function soonest() {
    var t = penaltyUntil > now() ? penaltyUntil : Infinity;
    for (var i = 0; i < retries.length; i++) { if (retries[i].at < t) t = retries[i].at; }
    return t;
  }

  function dueRetries() {
    if (!retries.length) return;
    var t = now();
    var keep = [];
    for (var i = 0; i < retries.length; i++) { if (retries[i].at <= t) queue.push(retries[i]); else keep.push(retries[i]); }
    retries = keep;
  }

  function wake() {
    if (wakeTimer || cancelled || phase !== 'running') return;
    var at = soonest();
    if (at === Infinity) return;
    var delay = at - now();
    if (delay < 1) delay = 1;
    wakeTimer = setTimeout(function () {
      wakeTimer = null;
      if (cancelled || phase !== 'running') return;
      dueRetries();
      pump();
    }, delay);
  }

  function scheduleCheck(at) {
    if (pauseTimer || cancelled || phase !== 'running') return;
    var delay = at - now();
    if (delay < 1) delay = 1;
    pauseTimer = setTimeout(function () {
      pauseTimer = null;
      if (cancelled || phase !== 'running') return;
      pump();
    }, delay);
  }

  var pumping = false, dirty = false;
  function pump() {
    if (cancelled || (phase !== 'running' && phase !== 'paused')) return;
    if (phase === 'paused') return;
    if (pumping) { dirty = true; return; }
    pumping = true;
    dirty = true;
    try {
      while (dirty) {
        dirty = false;
        dueRetries();
        if (pageBusy()) {
          if (!paused) { paused = 1; emit(); }
          scheduleCheck(now() + PAGE_POLL_MS);
          break;
        }
        if (paused) { paused = 0; emit(); }
        if (now() < penaltyUntil) { wake(); break; }
        if (now() < nextDispatchAt) { scheduleCheck(nextDispatchAt); break; }
        nextDispatchAt = now() + GAP_MS;
        while (active < limit && queue.length) {
          fetchOne(queue.shift());
          if (now() < nextDispatchAt) break;
        }
        if (queue.length && active < limit) scheduleCheck(nextDispatchAt);
        if (active === 0 && queue.length === 0 && retries.length === 0 && !manifestPending) {
          finish();
          break;
        }
      }
    } finally {
      pumping = false;
    }
  }

  function finish() {
    if (phase !== 'running') return;
    phase = 'done';
    paused = 0;
    if (pauseTimer) { try { clearTimeout(pauseTimer); } catch (e) { /* ignore */ } pauseTimer = null; }
    if (failedCount === 0) markProfileDone();
    save();
    emit();
  }

  function failRun() {
    if (cancelled) return;
    phase = 'failed';
    paused = 0;
    save();
    emit();
  }

  // ---- art-prefetch integration (reuse its full-set walker when present) ---------------------
  function artApi() {
    try {
      var a = window.__SP_ART;
      return (a && typeof a.start === 'function') ? a : null;
    } catch (e) { return null; }
  }

  function mirrorArt() {
    var a = artApi();
    if (!a) return;
    try {
      var s = typeof a.state === 'function' ? a.state() : null;
      if (!s) return;
      total = s.total || 0;
      done = s.done || 0;
      failedCount = s.failed || 0;
      var ph = s.state || s.phase;
      phase = ph === 'running' ? 'running' : ph === 'done' ? 'done' : ph === 'failed' ? 'failed' : phase;
      if (phase === 'done') markProfileDone();
      emit();
    } catch (e) { /* ignore */ }
  }

  /** Hand the walk to art-prefetch.js: it is the single engine (see the header). Its FULL walk is a
   *  superset of this center's CORE subset, so both profiles delegate to it -- a second engine over
   *  the overlapping paths would only re-request the same files into a CacheStorage nothing reads. */
  function delegateArt() {
    var a = artApi();
    if (!a) return false;
    delegated = true;
    phase = 'running';
    profile = FULL;
    emit();
    try {
      if (typeof a.onProgress === 'function' && !artUnsub) {
        a.onProgress(function () { mirrorArt(); });
      }
      a.start();
    } catch (e) { /* ignore */ }
    return true;
  }

  // ---- public engine actions -----------------------------------------------------------------
  function start(prof) {
    if (phase === 'running' || phase === 'scanning') return;
    profile = (prof === FULL) ? FULL : CORE;
    cancelled = false; paused = 0; busyAt = -1e15; busy = 0;
    failedCount = 0; failedKeys = []; failedSet = {}; failedTotal = 0;
    queue = []; retries = []; queued = {}; active = 0; limit = CONCURRENCY;
    done = 0; doneBytes = 0; total = 0; cursor = 0;
    attempts = 0; settlements = 0; okStreak = 0; penaltyUntil = 0; nextDispatchAt = 0;
    manifestTries = 0; resumed = false; delegated = false;
    if (pauseTimer) { try { clearTimeout(pauseTimer); } catch (e) { /* ignore */ } pauseTimer = null; }
    if (wakeTimer) { try { clearTimeout(wakeTimer); } catch (e) { /* ignore */ } wakeTimer = null; }
    if (manifestTimer) { try { clearTimeout(manifestTimer); } catch (e) { /* ignore */ } manifestTimer = null; }
    started = true;

    // Single-walker rule (2026-10-08): when art-prefetch.js is present EVERY start() delegates to
    // it, CORE included. Only a page without art-prefetch (or an explicit
    // `window.__SP_PRELOAD_OWN_ENGINE = 1`) runs this center's own engine.
    if (!window.__SP_PRELOAD_OWN_ENGINE && delegateArt()) return;

    phase = 'scanning';
    emit();
    if (typeof fetch !== 'function') { phase = 'failed'; emit(); return; }
    openCache();
    var begin = function (ok) {
      if (cancelled) return;
      if (!ok) { failRun(); return; }
      total = lists[profile].length;
      seedRun();
      phase = 'running';
      emit();
      pump();
    };
    if (listReady) { begin(true); return; }
    loadManifest(begin);
  }

  // Pause/resume only exist on this center's own engine. art-prefetch.js (the single walker when it
  // is present) has no pause -- it stands down by itself during matches -- so the panel hides the
  // pause button while delegated instead of pretending to pause someone else's walk.
  function pause() {
    if (phase === 'running') { phase = 'paused'; emit(); }
  }

  function resume() {
    if (phase === 'paused') { phase = 'running'; emit(); pump(); }
  }

  function cancel() {
    cancelled = true;
    queue = []; retries = []; manifestPending = false; paused = 0;
    if (wakeTimer) { try { clearTimeout(wakeTimer); } catch (e) { /* ignore */ } wakeTimer = null; }
    if (pauseTimer) { try { clearTimeout(pauseTimer); } catch (e) { /* ignore */ } pauseTimer = null; }
    if (manifestTimer) { try { clearTimeout(manifestTimer); } catch (e) { /* ignore */ } manifestTimer = null; }
    if (phase === 'running' || phase === 'idle' || phase === 'scanning') phase = 'idle';
    rememberSkip();
    save();
    // Delegated: the walker is art-prefetch, so a cancel has to reach it (its own chip does the same).
    if (delegated) { var a = artApi(); if (a && typeof a.cancel === 'function') { try { a.cancel(); } catch (e) { /* ignore */ } } }
    emit();
  }

  function clearCache() {
    cancelled = true;
    queue = []; retries = [];
    phase = 'idle'; done = 0; total = 0; doneBytes = 0; failedCount = 0; failedTotal = 0;
    failedKeys = []; failedSet = {}; cursor = 0;
    cachedProfiles = { core: false, full: false };
    var ls = store();
    if (ls) {
      try {
        ls.removeItem(LS_KEY);
        ls.removeItem(LS_LAST_KEY);
        ls.removeItem(LS_KEY + '.' + CORE);
        ls.removeItem(LS_KEY + '.' + FULL);
      } catch (e) { /* ignore */ }
    }
    var pr = Promise.resolve(true);
    try {
      if (typeof caches !== 'undefined' && caches && typeof caches.delete === 'function') pr = caches.delete(CACHE_NAME);
    } catch (e) { /* ignore */ }
    cacheObj = null;
    emit();
    return Promise.resolve(pr).then(function () { emit(); return true; }, function () { emit(); return false; });
  }

  /** Re-check the CacheStorage bucket against the profile's path list (the panel's verify). */
  function verify(prof) {
    profile = (prof === FULL) ? FULL : CORE;
    if (!listReady) {
      return new Promise(function (resolve) {
        loadManifest(function (ok) {
          if (!ok) { resolve({ ok: false, total: 0, present: 0, missing: 0 }); return; }
          verifyRun(resolve);
        });
      });
    }
    return new Promise(function (resolve) { verifyRun(resolve); });
  }

  function verifyRun(resolve) {
    openCache();
    var list = lists[profile];
    if (!cacheObj) {
      var present = done >= list.length && list.length > 0 ? list.length : done;
      resolve({ ok: false, total: list.length, present: present, missing: Math.max(0, list.length - present), reason: 'no-cache-storage' });
      return;
    }
    var found = 0, missing = 0, i = 0;
    var next = function () {
      if (i >= list.length) {
        done = found; total = list.length;
        if (found >= list.length && list.length > 0) markProfileDone();
        emit();
        resolve({ ok: true, total: list.length, present: found, missing: missing });
        return;
      }
      var p = list[i];
      i++;
      cacheHas(p).then(function (hit) { if (hit) found++; else missing++; next(); });
    };
    next();
  }

  // ---- UI (own DOM, inline styles, no stylesheet dependency) ---------------------------------
  // 2026-10-08 (owner): no pill, no auto-opened panel. The bottom-left pill looked like a status
  // chip but was a button that opened this panel -- the owner hit it by accident mid-game and read
  // the modal as a popup. The only always-visible preload UI is art-prefetch's bottom-right chip;
  // its label calls open() (api.open below). Everything in this section is opt-in.
  var ui = null, uiText = null, uiFill = null, modal = null;
  var selectedProfile = FULL; // owner's default is the full set; the cards still allow 'core'

  function el(tag, style, text) {
    var e = document.createElement(tag);
    if (style) { for (var k in style) { if (Object.prototype.hasOwnProperty.call(style, k)) e.style[k] = style[k]; } }
    if (text != null) e.textContent = text;
    return e;
  }

  function open() {
    if (typeof document === 'undefined' || !document.body) return;
    if (modal) { close(); return; }
    try {
      modal = el('div', {
        position: 'fixed', inset: '0', zIndex: '2147483100', display: 'flex',
        alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)',
      });
      var box = el('div', {
        width: 'min(560px, 92vw)', maxHeight: '86vh', overflow: 'auto',
        background: '#121816', color: '#d8e3de', border: '1px solid #2c3a35',
        borderRadius: '10px', padding: '18px 18px 14px',
        font: '13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif',
      });
      box.appendChild(el('div', { fontSize: '16px', fontWeight: '700', marginBottom: '4px' }, T_TITLE));
      box.appendChild(el('div', { opacity: '0.75', marginBottom: '12px' }, T_DESC));

      var cards = el('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' });
      cards.appendChild(card(CORE, T_CORE_T, T_SIZE_C, T_CORE_D));
      cards.appendChild(card(FULL, T_FULL_T, T_SIZE_F, T_FULL_D));
      box.appendChild(cards);

      ui = el('div', { marginBottom: '12px' });
      uiText = el('div', { opacity: '0.85', marginBottom: '6px' });
      var bar = el('div', { height: '4px', background: 'rgba(255,255,255,0.12)', borderRadius: '2px', overflow: 'hidden' });
      uiFill = el('div', { height: '4px', width: '0%', background: '#4ED8AF' });
      bar.appendChild(uiFill);
      ui.appendChild(uiText);
      ui.appendChild(bar);
      box.appendChild(ui);

      var actions = el('div', { display: 'flex', gap: '8px', justifyContent: 'space-between', flexWrap: 'wrap' });
      var left = el('div', { display: 'flex', gap: '8px' });
      left.appendChild(btn(T_CLEAR, false, function () { clearCache(); }));
      left.appendChild(btn(T_RECHECK, false, function () { verify(selectedProfile).then(function () { updateUI(); }); }));
      var right = el('div', { display: 'flex', gap: '8px' });
      // No pause while delegated: the walker is art-prefetch and it has no pause (it stands down
      // during matches on its own). The start button is enough -- it starts or continues that walk.
      if (!delegated) {
        right.appendChild(btn(phase === 'paused' ? T_RESUME : T_PAUSE, false, function () {
          if (phase === 'running') pause(); else if (phase === 'paused') resume(); else start(selectedProfile);
        }));
      }
      right.appendChild(btn(T_START, true, function () { start(selectedProfile); }));
      right.appendChild(btn(T_CLOSE, false, function () { close(); }));
      actions.appendChild(left);
      actions.appendChild(right);
      box.appendChild(actions);

      modal.appendChild(box);
      modal.onclick = function (ev) { if (ev.target === modal) close(); };
      document.body.appendChild(modal);
      updateUI();
    } catch (e) { modal = null; }
  }

  function card(id, title, size, detail) {
    var c = el('div', {
      border: '1px solid ' + (selectedProfile === id ? '#4ED8AF' : '#2c3a35'),
      borderRadius: '8px', padding: '10px', cursor: 'pointer', background: 'rgba(255,255,255,0.02)',
    });
    var head = el('div', { display: 'flex', justifyContent: 'space-between', marginBottom: '4px' });
    head.appendChild(el('b', null, title));
    head.appendChild(el('span', { opacity: '0.6' }, size));
    c.appendChild(head);
    c.appendChild(el('div', { opacity: '0.7' }, detail));
    if (cachedProfiles[id]) c.appendChild(el('div', { color: '#4ED8AF', marginTop: '4px' }, T_BADGE));
    c.onclick = function () { selectedProfile = id; close(); open(); };
    return c;
  }

  function btn(text, primary, fn) {
    var b = el('button', {
      padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', font: 'inherit',
      border: '1px solid ' + (primary ? '#4ED8AF' : '#2c3a35'),
      background: primary ? '#4ED8AF' : 'transparent', color: primary ? '#0b1512' : '#d8e3de',
    }, text);
    b.onclick = fn;
    return b;
  }

  function close() {
    if (modal && modal.parentNode) { try { modal.parentNode.removeChild(modal); } catch (e) { /* ignore */ } }
    modal = null; ui = null; uiText = null; uiFill = null;
  }

  function updateUI() {
    if (!uiText || !uiFill) return;
    try {
      var pct = total > 0 ? Math.floor(done * 100 / total) : 0;
      var st = phase === 'scanning' ? T_ST_SCAN
        : phase === 'running' ? T_ST_RUN
        : phase === 'paused' ? T_ST_PAUSE
        : phase === 'done' ? T_ST_DONE : T_ST_IDLE_FALLBACK;
      var line = st + '  ' + done + ' / ' + total + T_FILES + ' (' + pct + '%)';
      uiText.textContent = line + '  ' + T_BYTES + (doneBytes / 1048576).toFixed(1) + T_MB;
      uiFill.style.width = pct + '%';
    } catch (e) { /* ignore */ }
  }
  var T_ST_IDLE_FALLBACK = T_PILL_IDLE;

  // ---- export --------------------------------------------------------------------------------
  var api = {};
  function expose(name, get) {
    try { Object.defineProperty(api, name, { get: get, enumerable: true }); }
    catch (e) { try { api[name] = get(); } catch (e2) { /* ignore */ } }
  }
  expose('phase', function () { return phase; });
  expose('done', function () { return done; });
  expose('total', function () { return total; });
  expose('failedCount', function () { return failedCount; });
  api.state = function () { return diag(); };
  api.snapshot = function () { return diag(); };
  api.profiles = function () {
    return [
      { id: CORE, total: lists.core.length, cached: !!cachedProfiles.core },
      { id: FULL, total: lists.full.length, cached: !!cachedProfiles.full },
    ];
  };
  api.failed = function () { return failedKeys.slice(0); };
  api.start = start;
  api.pause = pause;
  api.resume = resume;
  api.cancel = cancel;
  api.clear = clearCache;
  api.verify = verify;
  api.onProgress = onProgress;
  api.open = open;
  api.close = close;
  api._cacheName = CACHE_NAME;
  window.__SP_PRELOAD = api;

  loadCachedProfiles();

  // Persist when the page really leaves (a killed WebView never runs this; SAVE_EVERY covers it).
  try {
    if (typeof window.addEventListener === 'function') {
      var flush = function () { try { save(); } catch (e) { /* ignore */ } };
      window.addEventListener('pagehide', flush, false);
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', flush, false);
      }
    }
  } catch (e) { /* no DOM: tests */ }

  // Fallback auto-start, once, after an idle callback -- never blocking the page and never during a
  // match. Only reachable on a page WITHOUT art-prefetch.js (the single walker that self-starts the
  // full set at load); it then walks the FULL profile, which is the owner's default. Disabled by
  // window.__SP_PRELOAD_NO_AUTO (tests) or by a skip pressed this session.
  function autoStart() {
    try {
      if (window.__SP_PRELOAD_NO_AUTO) return;
      if (artApi()) return;              // art-prefetch is the single walker: it covers the whole set
      if (skippedThisSession()) return;
      start(FULL);
    } catch (e) { /* silent */ }
  }
  try {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(autoStart, { timeout: 4000 });
    else if (typeof setTimeout === 'function') setTimeout(autoStart, 1500);
  } catch (e) { /* silent */ }
})();
