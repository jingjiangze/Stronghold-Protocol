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
 *   - a plain fetch(path, {cache:'no-store'}) is the fallback (audit 2026-10-09 phase 4, D5: the
 *     WebView's HTTP cache must not answer, or a hot-updated asset would replay its old bytes).
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
 * THE REAL STORE ON THE APK IS ANDROID'S (2026-10-08 field report): the on-disk cache is
 * filesDir/art/cache/<manifest-hash>/, written by ArtCdn through the WebView interceptor. The panel
 * therefore reports local-available / fetched-cache / pending: local-available = entries now on the
 * device (device-provided + already fetched), fetched-cache = the Android cachedBytes (formatted
 * MB), pending = total - done. When ShellBridge.artCacheStatus() is absent (old APK / pure web) the
 * byte figure is labelled browser-cache and comes from this module's own CacheStorage bucket
 * instead -- never dressed up as the Android number. verify()/clear() likewise act on the Android
 * cache through the bridge (clearArtCache() removes art/cache/** only, never the signed
 * art/packs/**) and only fall back to CacheStorage when there is no bridge.
 *
 * PERSISTENCE: progress is kept per manifest hash AND per profile in localStorage
 * (`sp.preload.v1` = { <hash>: { core:{...}, full:{...} } }, `sp.preload.last` = newest hash), so
 * a reload continues from the stored count instead of restarting; a changed manifest hash with a
 * different fingerprint invalidates the record. The stored list is capped (MAX_FAILED).
 *
 * API (window.__SP_PRELOAD):
 *   state()                  diagnostic object (phase, profile, done, total, failed, pending,
 *                            localFiles, bytes, store:'android'|'cachestorage', bridge:{...},
 *                            rates:{bps,avgBps,filesPerSec,avgFilesPerSec,etaMs,elapsedMs,bytesKnown},
 *                            pack:{active,stage,pack,packsDone,packsTotal,bytesDone,bytesTotal,dlBps,
 *                            unzipBps,etaMs}|null, cached:{core,full}, resumed, paused, delegated, saved)
 *                            -- `rates` is the walk's own speed (owner ask 2026-10-09: the preload
 *                            progress must show its speed), `pack` is the art-pack channel's speed as
 *                            reported by the shell bridge (download + UNPACK), null when the installed
 *                            APK does not expose ShellBridge.artSyncStatus
 *   profiles()               [{id:'core',total,bytes?},{id:'full',total}] once the manifest landed
 *   start(profile)           begin/resume 'core'|'full' (default 'core'); idempotent while busy
 *   pause() / resume()       stop dispatching / continue
 *   clear()                  APK bridge: clearArtCache() (art/cache/** only, packs untouched);
 *                            web: drop the CacheStorage bucket + every stored record (async)
 *   verify(profile)          APK bridge: one O(1) artCacheStatus() call; web: re-scan the bucket.
 *                            -> Promise<report> whose `store` names which store was verified
 *   open() / close()         open / close the Preact panel through the shell host
 *                            (window.__SP_SHELL.openPanel('preload' | null)); a missing host is a
 *                            quiet no-op. art-prefetch's chip label calls open()
 *   onProgress(cb)           cb(snapshot) now and on every change
 *
 * UI (owner 2026-10-09/10): the PANEL is a Preact component in ui/preloadPanel.js, registered as
 * kind 'preload' into ui/shellPanels.js' add-on registry -- the same look as the lobby panel, laid
 * out in three labelled layers. This module builds no DOM at all; open()/close() just drive the
 * shell's panel host (window.__SP_SHELL.openPanel), so nothing auto-mounts and the page is never
 * blocked. Missing fetch / offline / no CacheStorage all degrade silently -- the game still runs.
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

  // UI strings are gone with the panel: the Preact panel (ui/preloadPanel.js) owns all of its text.


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

  // ---- Android art-cache bridge numbers (ShellBridge.artCacheStatus / clearArtCache) ----------
  // The REAL on-device cache is filesDir/art/cache/<manifest-hash>/ (written by ArtCdn through the
  // WebView interceptor). Nothing in the game reads this module's CacheStorage bucket, so on the APK
  // the fetched-cache figure and verify()/clear() must come from the bridge, never from CacheStorage.
  // Every field degrades to a page-side number when the bridge is absent (old APK / pure web).
  var localFiles = 0;           // mirrored from art-prefetch: settled entries the device served itself
  var bridgeFiles = 0;          // cachedFiles reported by the bridge (art/cache/** file count)
  var bridgeBytes = 0;          // cachedBytes reported by the bridge (fetched-cache, bytes)
  var bridgeHash = '';          // manifest hash the Android cache namespace is keyed on
  var bridgeRoot = '';          // cacheRoot (art/cache/<hash>) -- diagnostics / verify report
  var bridgePending = -1;       // pending reported by the bridge; -1 = unknown to Java
  var bridgeAt = 0;             // last bridge poll (throttled: >= BRIDGE_MS between polls)
  var cacheBytes = 0;           // web fallback: bytes measured in this module's CacheStorage bucket
  var cacheAt = 0;              // last CacheStorage measurement (same throttle)
  var cacheMeasuring = false;   // a measurement is in flight
  var lastStore = '';           // 'android' | 'cachestorage' | '' -- which store the numbers describe
  var BRIDGE_MS = 1000;         // >= 1/s: never poll the bridge on every progress tick

  // ---- rates (owner ask 2026-10-09: the progress must show download / unpack / preload speeds) ---
  // Two channels feed the display and they are never mixed:
  //   the walk   -- art-prefetch's file channel (delegated: mirrored from its snapshot) or this
  //                 module's own engine, whose averages are computed here;
  //   the packs  -- ArtStore's pack install, whose download AND UNPACK speeds only the shell knows
  //                 (ShellBridge.artSyncStatus). Absent bridge -> the pack line is not rendered.
  var rate = { bps: 0, avgBps: 0, filesPerSec: 0, avgFilesPerSec: 0, etaMs: -1, elapsedMs: 0, bytesKnown: false };
  var runStartedAt = 0;         // own engine: when its walk began (0 = never)
  var doneAtStart = 0;          // own engine: done at that moment (a resumed count is not speed)
  var bytesAtStart = 0;         // own engine: doneBytes at that moment
  var sync = null;              // last artSyncStatus reading (the pack channel); null = no bridge/data
  var syncAt = 0;               // last artSyncStatus poll (throttled: >= BRIDGE_MS)
  var MAX_BIG = 1 << 30;        // clamp for a rate/elapsed (1 GiB/s, ~12 days): never write 1 << 40,
                                // whose shift count wraps modulo 32 and silently becomes 256

  // Speed/duration wording moved to the panel (ui/preloadPanel.js): this module only exposes the
  // raw numbers (rates / pack), never a formatted string.
  function num(v, hi) {
    var n = typeof v === 'number' && isFinite(v) ? v : 0;
    return n < 0 ? 0 : (n > hi ? hi : n);
  }

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

  /** True when the shell answered with its placeholder marker (ArtCdn.PLACEHOLDER_HEADER). The
   *  placeholder is a 200 on purpose (no broken-image cascade), so the header is the only signal. */
  function placeholderMark(res) {
    try {
      if (!res || !res.headers || typeof res.headers.get !== 'function') return false;
      var v = res.headers.get('x-sp-art-placeholder');
      return !!v && v !== '0';
    } catch (e) { return false; }
  }

  // Same table as art-prefetch.js and the native ArtCdn.isTransientStatus / isPermanentMiss
  // (audit 2026-10-09 D2/D3): a marked 200 is the PLACEHOLDER (transient, never a success).
  function classify(res) {
    if (res && res.ok) return placeholderMark(res) ? 'retry' : 'ok';
    var code = res && typeof res.status === 'number' ? res.status : 0;
    if (code === 0 || code === 408 || code === 425 || code === 429 || code >= 500) return 'retry';
    if (code === 404 || code === 410) return 'dead'; // a definitive miss (the shell remembers these)
    if (code >= 400) return 'dead';                  // 401/403/...: back off, do not re-ask this session
    return 'retry';
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

  // ---- browser cache (CacheStorage when present; no-store fetch always) ------------------------
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

  // ---- Android art-cache bridge (ShellBridge.artCacheStatus / clearArtCache) ------------------
  /** The shell-bridge capability flag. shell-bridge.js sets __SP_SHELL.artCacheBridge = true only
   *  when the installed APK really exposes ShellBridge.artCacheStatus(); on an old APK or the plain
   *  web it is absent and every consumer below degrades to the CacheStorage path (today's behaviour). */
  function shellApi() {
    try {
      var s = window.__SP_SHELL;
      if (s && s.artCacheBridge === true && typeof s.artCacheStatus === 'function') return s;
    } catch (e) { /* ignore */ }
    return null;
  }

  function parseBridge(text) {
    try {
      var o = typeof text === 'string' ? JSON.parse(text) : text;
      return o && typeof o === 'object' ? o : null;
    } catch (e) { return null; }
  }

  /** One status call, folded to '' on any bridge failure (the caller keeps its last reading). */
  function callStatus(s) {
    try { return s.artCacheStatus(); } catch (e) { return ''; }
  }

  function adoptStatus(o) {
    if (!o || o.ok === false) return false;
    bridgeFiles = clampInt(o.cachedFiles, 0, 1 << 30);
    bridgeBytes = clampInt(o.cachedBytes, 0, 1099511627776);
    bridgeHash = typeof o.manifestHash === 'string' ? o.manifestHash : '';
    bridgeRoot = typeof o.cacheRoot === 'string' ? o.cacheRoot : '';
    bridgePending = typeof o.pending === 'number' ? o.pending : -1;
    lastStore = 'android';
    return true;
  }

  /** Poll the Android numbers. Throttled to >= BRIDGE_MS (1/s) unless forced (panel opened / a run
   *  finished): never on every progress tick. The bridge call is O(1) by contract -- the Java side
   *  must not walk the filesystem -- so this is cheap even when it does run. With no bridge it
   *  measures this module's own CacheStorage bucket instead (the web-only honest byte source). */
  function refreshNative(force) {
    var s = shellApi();
    var t = now();
    if (s) {
      if (!force && t - bridgeAt < BRIDGE_MS) return;
      bridgeAt = t;
      adoptStatus(parseBridge(callStatus(s)));
      return;
    }
    // no bridge: the only honest byte source is our own bucket. The sweep is throttled (BRIDGE_MS),
    // so a state() read by the panel (or any caller) is what keeps it fresh -- there is no DOM flag
    // to gate on any more (the panel is a Preact component and reads state()).
    lastStore = (cacheSupported || cacheObj) ? 'cachestorage' : '';
    if (!force && t - cacheAt < BRIDGE_MS) return;
    cacheAt = t;
    measureCacheBytes();
  }

  /** Sum the content-length of every response in this module's bucket -- sizes only, never a
   *  per-file hash. It is the web stand-in for the Android cachedBytes; a bucket this module never
   *  wrote (delegated mode) honestly measures 0 instead of inventing a number. */
  function measureCacheBytes() {
    if (cacheMeasuring) return;
    openCache();
    if (!cacheObj) { cacheBytes = doneBytes; return; }
    cacheMeasuring = true;
    try {
      cacheObj.keys().then(function (keys) {
        var jobs = [];
        for (var i = 0; i < keys.length; i++) jobs.push(cacheObj.match(keys[i]));
        return Promise.all(jobs);
      }).then(function (ress) {
        var n = 0;
        for (var i = 0; i < ress.length; i++) n += sizeOf(ress[i]);
        cacheBytes = n;
        cacheMeasuring = false;
      }, function () { cacheMeasuring = false; });
    } catch (e) { cacheMeasuring = false; }
  }

  /** Which store the displayed numbers describe: the Android art cache, or the web fallback. */
  function storeKind() {
    return shellApi() ? 'android' : ((cacheSupported || cacheObj) ? 'cachestorage' : '');
  }

  function bytesValue() {
    return storeKind() === 'android' ? bridgeBytes : cacheBytes;
  }

  /** pending. The page's own manifest state is authoritative: it is the number that reconciles with
   *  local-available and fetched-cache. The bridge's `pending` is used only when the page has no manifest yet
   *  (total 0); -1 means Java does not know and nothing is faked. */
  function pendingValue() {
    if (total > done) return total - done;
    if (!total && bridgePending >= 0) return bridgePending;
    return 0;
  }

  // ---- pack channel (ShellBridge.artSyncStatus: art-pack download + UNPACK speeds) ---------------
  /** Capability flag, same shape as the cache bridge: __SP_SHELL.artSyncBridge is set only when the
   *  installed APK really exposes ShellBridge.artSyncStatus(), so an old APK degrades to "no line"
   *  instead of a guessed number. */
  function syncApi() {
    try {
      var s = window.__SP_SHELL;
      if (s && s.artSyncBridge === true && typeof s.artSyncStatus === 'function') return s;
    } catch (e) { /* ignore */ }
    return null;
  }

  /** Poll the pack channel. Throttled to >= BRIDGE_MS like the cache bridge; the last reading is
   *  kept when a call fails (a bridge hiccup must not blank the panel). */
  function refreshSync(force) {
    var s = syncApi();
    if (!s) { sync = null; return; }
    var t = now();
    if (!force && t - syncAt < BRIDGE_MS) return;
    syncAt = t;
    var raw = '';
    try { raw = s.artSyncStatus(); } catch (e) { raw = ''; }
    var o = parseBridge(raw);
    if (!o || o.ok === false) return;
    sync = {
      active: o.active === true,
      stage: typeof o.stage === 'string' ? o.stage : '',
      pack: typeof o.pack === 'string' ? o.pack : '',
      packsDone: clampInt(o.packsDone, 0, 1 << 20),
      packsTotal: clampInt(o.packsTotal, 0, 1 << 20),
      bytesDone: clampInt(o.bytesDone, 0, 1099511627776),
      bytesTotal: clampInt(o.bytesTotal, 0, 1099511627776),
      dlBps: num(o.dlBps, MAX_BIG),
      unzipBps: num(o.unzipBps, MAX_BIG),
      etaMs: typeof o.etaMs === 'number' && isFinite(o.etaMs) ? o.etaMs : -1,
    };
  }

  /** Own-engine rates: averages from this module's counters (the delegated case mirrors
   *  art-prefetch's windowed numbers instead -- see mirrorArt). Averages are the honest thing here:
   *  this engine keeps no sample history, and a "current" rate would have to be invented. */
  function ownRate() {
    rate = { bps: 0, avgBps: 0, filesPerSec: 0, avgFilesPerSec: 0, etaMs: -1, elapsedMs: 0, bytesKnown: false };
    if (!runStartedAt) return;
    var el = now() - runStartedAt;
    if (el <= 0) return;
    rate.elapsedMs = el;
    var secs = el / 1000;
    var dDone = done - doneAtStart;
    var dBytes = doneBytes - bytesAtStart;
    if (dBytes > 0) { rate.bytesKnown = true; rate.avgBps = dBytes / secs; rate.bps = rate.avgBps; }
    if (dDone > 0) { rate.filesPerSec = dDone / secs; rate.avgFilesPerSec = rate.filesPerSec; }
    if (total > done && rate.filesPerSec > 0) rate.etaMs = Math.round((total - done) / rate.filesPerSec * 1000);
    else if (total > 0 && done >= total) rate.etaMs = 0;
  }

  // The four speed lines the owner asked for are rendered by the panel (ui/preloadPanel.js) from
  // the raw `rate` + `sync` numbers below -- this module no longer formats them.

  // ---- progress plumbing ---------------------------------------------------------------------
  function ratesJson() {
    return {
      bps: Math.round(rate.bps), avgBps: Math.round(rate.avgBps),
      filesPerSec: rate.filesPerSec, avgFilesPerSec: rate.avgFilesPerSec,
      etaMs: rate.etaMs, elapsedMs: rate.elapsedMs, bytesKnown: rate.bytesKnown,
    };
  }

  function packJson() {
    return sync ? {
      active: sync.active, stage: sync.stage, pack: sync.pack,
      packsDone: sync.packsDone, packsTotal: sync.packsTotal,
      bytesDone: sync.bytesDone, bytesTotal: sync.bytesTotal,
      dlBps: sync.dlBps, unzipBps: sync.unzipBps, etaMs: sync.etaMs,
    } : null;
  }

  function snapshot() {
    return {
      phase: phase, profile: profile, done: done, total: total, failed: failedCount,
      pending: pendingValue(), localFiles: localFiles,
      bytes: bytesValue(), store: storeKind(), paused: paused, resumed: resumed, delegated: delegated,
      cached: { core: !!cachedProfiles.core, full: !!cachedProfiles.full },
      rates: ratesJson(), pack: packJson(),
    };
  }

  function diag() {
    refreshNative(false); // throttled: at most one bridge poll per BRIDGE_MS
    refreshSync(false);
    return {
      phase: phase, profile: profile, done: done, total: total, failed: failedCount,
      pending: pendingValue(), localFiles: localFiles,
      bytes: bytesValue(), store: storeKind(), inflight: active,
      window: limit, attempts: attempts, paused: paused, gapMs: GAP_MS,
      resumed: resumed, delegated: delegated, hash: hash, fp: fp, cursor: cursor,
      cacheSupported: cacheSupported, cacheOpen: !!cacheObj,
      bridge: {
        present: !!shellApi(), files: bridgeFiles, bytes: bridgeBytes,
        hash: bridgeHash, root: bridgeRoot, pending: bridgePending,
      },
      cached: { core: !!cachedProfiles.core, full: !!cachedProfiles.full },
      failedKeys: failedKeys.length, saved: !savePaused && !!store(),
      rates: ratesJson(), pack: packJson(),
    };
  }

  function emit() {
    refreshNative(false); // progress tick: throttled bridge/CacheStorage refresh
    refreshSync(false);   // pack-channel speeds (throttled too; a no-op without the bridge)
    if (!delegated) ownRate(); // delegated: mirrorArt owns the rate (never overwrite art's numbers)
    var snap = snapshot();
    for (var i = 0; i < callbacks.length; i++) {
      try { callbacks[i](snap); } catch (e) { /* a bad callback must not break the pump */ }
    }
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
    // Audit 2026-10-09 phase 4 (D5): no-store -- the manifest is hot-updatable; a forced cache hit
    // would verify against the previous asset list.
    try { pr = fetch(MANIFEST, { cache: 'no-store' }); } catch (e) { pr = null; }
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
    // Own-engine rate baseline: a resumed count is carried into doneAtStart, never counted as this
    // session's speed (bytes we did not fetch now must not appear in the byte rate).
    runStartedAt = now();
    doneAtStart = done;
    bytesAtStart = doneBytes;
    rate = { bps: 0, avgBps: 0, filesPerSec: 0, avgFilesPerSec: 0, etaMs: -1, elapsedMs: 0, bytesKnown: false };
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
      // Audit 2026-10-09 phase 4 (D5): always bypass the WebView's HTTP cache. The shell answers
      // every /assets/** from filesDir itself (local tree -> pack -> fetched cache), so "no-store"
      // costs one local read and no network -- while "force-cache" would let the WebView replay a
      // pre-hot-update copy for the whole max-age window.
      var init = { cache: 'no-store' };
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
          // No CacheStorage: nothing to store into (the fetch is no-store, so the WebView's HTTP
          // cache is not warmed either) -- release the stream we will not read.
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
    refreshNative(true); // a run finished: pull the final Android/CacheStorage numbers once
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
    // art-prefetch present == the single walker owns the walk (PR #110): the panel is delegated
    // whenever this runs, even if art auto-started before the panel was ever opened. Without this
    // the mirrored 'running' phase would leave delegated false and the panel would show a pause
    // button for a walker that has no pause.
    delegated = true;
    try {
      var s = typeof a.state === 'function' ? a.state() : null;
      if (!s) return;
      total = s.total || 0;
      done = s.done || 0;
      failedCount = s.failed || 0;
      // localFiles = entries the device already serves (no request); pending is derived from
      // total - done, so it never presents a local hit as a download.
      localFiles = typeof s.localFiles === 'number' ? s.localFiles : 0;
      // Owner ask 2026-10-09: the panel shows the walk's speeds and art-prefetch measures them --
      // this center only mirrors, it never recomputes (the two channels stay distinct; see speedLines).
      if (typeof s.bps === 'number') {
        rate = {
          bps: num(s.bps, MAX_BIG), avgBps: num(s.avgBps, MAX_BIG),
          filesPerSec: num(s.filesPerSec, 1 << 20), avgFilesPerSec: num(s.avgFilesPerSec, 1 << 20),
          etaMs: typeof s.etaMs === 'number' && isFinite(s.etaMs) ? s.etaMs : -1,
          elapsedMs: num(s.elapsedMs, MAX_BIG), bytesKnown: s.bytesKnown === true,
        };
      }
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
    localFiles = 0; bridgeAt = 0; cacheAt = 0;
    runStartedAt = 0; doneAtStart = 0; bytesAtStart = 0; syncAt = 0;
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

  /** Drop every page-side progress record and zero the counters (shared by both clear paths). */
  function resetProgress() {
    cancelled = true;
    queue = []; retries = [];
    phase = 'idle'; done = 0; total = 0; doneBytes = 0; failedCount = 0; failedTotal = 0;
    failedKeys = []; failedSet = {}; cursor = 0;
    localFiles = 0;
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
  }

  /** Clear. With the Android bridge: ShellBridge.clearArtCache() removes ONLY the fetched cache
   *  (art/cache/**); the signed packs (art/packs/**) are never touched, and this module does not
   *  touch its own CacheStorage bucket (nothing on the APK reads it). Web fallback: delete the
   *  CacheStorage bucket + the stored records, exactly as before. */
  function clearCache() {
    var s = shellApi();
    resetProgress();
    if (s) {
      bridgeFiles = 0; bridgeBytes = 0; bridgePending = -1; bridgeHash = ''; bridgeRoot = '';
      lastStore = 'android';
      bridgeAt = now(); // hold the zeroed numbers: the next natural poll is >= BRIDGE_MS away
      emit(); // zero the displayed numbers immediately, before the (async) bridge call returns
      var rep = { ok: false, store: 'android', removedFiles: 0, removedBytes: 0, keptPacks: true };
      try {
        var o = parseBridge(s.clearArtCache());
        if (o) {
          rep.ok = o.ok !== false;
          rep.removedFiles = clampInt(o.removedFiles, 0, 1 << 30);
          rep.removedBytes = clampInt(o.removedBytes, 0, 1099511627776);
          rep.keptPacks = o.keptPacks !== false;
        } else { rep.ok = true; }
      } catch (e) { /* bridge failure: the displayed numbers are already zeroed */ }
      emit();
      return Promise.resolve(rep);
    }
    var pr = Promise.resolve(true);
    try {
      if (typeof caches !== 'undefined' && caches && typeof caches.delete === 'function') pr = caches.delete(CACHE_NAME);
    } catch (e) { /* ignore */ }
    cacheObj = null;
    cacheBytes = 0;
    emit();
    return Promise.resolve(pr).then(
      function () { emit(); return { ok: true, store: 'cachestorage' }; },
      function () { emit(); return { ok: false, store: 'cachestorage' }; }
    );
  }

  /** Re-check the profile against the real store (the panel's verify). With the Android bridge it is
   *  one O(1) artCacheStatus() call; otherwise the CacheStorage bucket is scanned path by path. */
  function verify(prof) {
    profile = (prof === FULL) ? FULL : CORE;
    var s = shellApi();
    var store = s ? 'android' : 'cachestorage';
    var go = function (resolve) {
      if (s) { verifyNative(s, resolve); return; }
      verifyRun(resolve);
    };
    if (!listReady) {
      return new Promise(function (resolve) {
        loadManifest(function (ok) {
          if (!ok) { resolve({ ok: false, store: store, total: 0, present: 0, missing: 0 }); return; }
          go(resolve);
        });
      });
    }
    return new Promise(function (resolve) { go(resolve); });
  }

  /** Bridge verify: ONE artCacheStatus() call -- existence / size / path only. It never walks the
   *  file list and never hashes a single file (the signed packs are verified at the APK / pack
   *  level, not here). The report names the store it verified. */
  function verifyNative(s, resolve) {
    var list = lists[profile] || [];
    var n = list.length;
    var o = parseBridge(callStatus(s));
    if (!o || o.ok === false) {
      resolve({ ok: false, store: 'android', total: n, present: 0, missing: n, reason: 'bridge-error' });
      return;
    }
    adoptStatus(o);
    var present = bridgeFiles;
    if (n > 0 && present > n) present = n; // the cache may hold entries outside this profile
    var report = {
      ok: true, store: 'android', total: n, present: present, missing: Math.max(0, n - present),
      files: bridgeFiles, bytes: bridgeBytes, manifestHash: bridgeHash, cacheRoot: bridgeRoot,
    };
    if (n > 0 && present >= n) markProfileDone();
    emit();
    resolve(report);
  }

  function verifyRun(resolve) {
    openCache();
    var list = lists[profile];
    if (!cacheObj) {
      var present = done >= list.length && list.length > 0 ? list.length : done;
      resolve({ ok: false, store: 'cachestorage', total: list.length, present: present, missing: Math.max(0, list.length - present), reason: 'no-cache-storage' });
      return;
    }
    var found = 0, missing = 0, i = 0;
    var next = function () {
      if (i >= list.length) {
        done = found; total = list.length;
        if (found >= list.length && list.length > 0) markProfileDone();
        emit();
        resolve({ ok: true, store: 'cachestorage', total: list.length, present: found, missing: missing });
        return;
      }
      var p = list[i];
      i++;
      cacheHas(p).then(function (hit) { if (hit) found++; else missing++; next(); });
    };
    next();
  }

  // ---- panel (owner 2026-10-09/10: the UI is a Preact component, not hand-written DOM) ---------
  // This module builds NO DOM. open()/close() drive the shell's panel host: openPanel('preload')
  // mounts ui/preloadPanel.js (registered as kind 'preload'), openPanel(null) closes it. The panel
  // reads state() live for its numbers; open() freshens the bridge readings first so the first paint
  // is current. A page without the shell host (plain web / old APK) is a quiet no-op -- the game is
  // never affected, and nothing auto-mounts (art-prefetch's chip label is the only caller of open()).
  function open() {
    refreshNative(true); // the Android/CacheStorage numbers once, before the panel paints
    refreshSync(true);   // the pack channel's download/unpack speeds: one forced read on open
    mirrorArt();         // the art-prefetch mirror (also settles the 'delegated' flag)
    try {
      var s = window.__SP_SHELL;
      if (s && typeof s.openPanel === 'function') s.openPanel('preload');
    } catch (e) { /* no shell panel host (plain web / old APK): silent */ }
  }

  function close() {
    try {
      var s = window.__SP_SHELL;
      if (s && typeof s.openPanel === 'function') s.openPanel(null);
    } catch (e) { /* no shell panel host (plain web / old APK): silent */ }
  }

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
