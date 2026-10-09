/* global window, document */ // browser globals: this overlay ships inside the tools tree (the ESLint node preset covers it), so the DOM globals are declared here (localStorage/sessionStorage/AbortController are already built-in globals there and must not be re-declared)
/* art-prefetch.js -- background art prefetch for the "no embedded assets" build (P0, 2026-10-08;
 * resumable / self-sustaining pass 2026-10-08).
 *
 * WHY: the APK no longer embeds the ~410 MB assets tree (build-webroot --no-assets). Every
 * /assets/** the page asks for is resolved by MainActivity: local tree (filesDir) -> APK -> on a
 * miss, re-fetch from the CDN base, cache under filesDir/art/cache/<manifest hash>/ and serve
 * SAME-ORIGIN (a cross-origin image would taint the canvas -- see the hot-update design doc 6.3).
 *
 * WHAT THIS DOES: read /data/assets.json (same-origin), walk it in manifest order -- the FULL set,
 * every string that names /assets/** (.webp / .png / .skel / .atlas / .mp3; 7969 entries for the
 * 7ae1d03466cb manifest) -- and fetch each path in the background with a small concurrency window.
 * On a cache hit the Java interceptor answers instantly (no network), so "already cached" entries
 * are nearly free; misses warm the cache for the next screen. Entries the device ALREADY serves
 * locally (the APK's embedded tree, an installed art pack, the hot tree -- the shell publishes that
 * coverage at LOCAL_LIST) are counted and never requested: they are immutable/verified at the APK or
 * pack level, openLocal answers them before the CDN cache is ever consulted, and asking for them was
 * a round of pointless requests competing with the page (owner rule 2026-10-08).
 *
 * THE PAGE ALWAYS WINS (H3, 2026-10-08 field report: blank icons at "art 970/7969"). The prefetch
 * is a guest on a phone's link: it runs at CONCURRENCY 2 (the shell reserves 4 slots for the page),
 * paces its dispatches by GAP_MS, marks every fetch with the X-SP-Prefetch header (the shell then
 * lets it hold at most 2 CDN slots and only when the page is idle) and STANDS DOWN ENTIRELY while a
 * match / briefing screen is on the page (MATCH_MARKS) or the document is hidden -- the page's own
 * load of that screen must never wait behind a background walk.
 *
 * SELF-SUSTAINING / RESUMABLE: a ~357 MB tree cannot be fetched in one go on a phone link, so a run
 * must survive a reload and must never lose a transient failure. Progress is persisted per manifest
 * hash (plus a fingerprint of the enumerated list) in localStorage:
 *   record = { hash, fp, total, done, idle, cursor, failed: [path, ...], failedTotal, t }
 *     done     successes so far -- what the chip shows as X; the stored X is painted immediately
 *     cursor   entries before it were attempted and resolved (fetched OK or finally failed), so a
 *              reload skips them instead of restarting
 *     walk     the raw walk watermark; when cursor < walk the previous session spilled and this one
 *              re-walks [cursor, walk), so an owed path can never be forgotten
 *     idle     entries at/after the walk watermark, never attempted -- total - walk
 *     failed   capped (1000) list of the paths still owed; re-queued FIRST on the next session
 *     fp       fingerprint of the enumerated list: a changed asset set (new hash, skin rewrite)
 *              invalidates the record instead of resuming into the wrong entries
 * A CHANGED MANIFEST HASH with the SAME list (H1: the build re-emits the hash from the same
 * referenced bytes, so a content release moves the namespace without touching a single path)
 * CARRIES the walk over: done/cursor/walk are kept -- the shell renamed the old cache namespace
 * onto the new one, so those entries are cache hits -- and only the per-file failed list is dropped.
 * The owed paths travel in `failed`; if MORE than the cap is owed the cursor is pulled back to the
 * first spilled failure and that tail is re-walked next session, so an owed path can never be
 * forgotten. A re-walked success is a cache hit (the interceptor answers it from filesDir, no
 * network). A run killed mid-flight loses at most the in-flight window: the cursor only advances
 * over entries that actually settled.
 *
 * CACHE: a first look-up uses {cache:'force-cache'} (the interceptor answers a cached asset without
 * touching the network). A RETRY -- and every path carried over from an earlier session -- uses
 * {cache:'no-store'} instead: without that the WebView replays the cached 404/error of the previous
 * attempt and the retry never reaches the CDN at all (measured in the 2026-10-08 sim: a reload
 * re-walked the tail, replayed 5553 cached 404s and made zero progress until the retry bypassed it).
 *
 * FAILURE POLICY: transient failures (rejected fetch, abort, 408/425/429/5xx) get up to 3 attempts
 * with exponential backoff (0.5 s, 1 s; cap 8 s) while the concurrency window narrows by one
 * (backpressure against the shell's 4-slot CDN semaphore and the live page's own requests); a 4xx is
 * permanent for the session. Whatever is still owed at the end stays in the record: it is pending,
 * not dropped, and never counted as done. On-device triage: __SP_ART.failed() lists the paths.
 *
 * API (window.__SP_ART):
 *   phase                    'idle' | 'running' | 'done' | 'cancelled' | 'failed' (live string)
 *   done, total, failedCount numbers (live)
 *   start()                  begin/resume (idempotent; auto-started once after load unless
 *                            window.__SP_ART_NO_AUTO is set or the user skipped in this session)
 *   cancel()                 stop immediately; in-flight requests finish, no new ones start, no error
 *   onProgress(cb)           cb({state,done,total,failed,pending,localFiles,resumed,bytes,bytesKnown,
 *                            bps,avgBps,filesPerSec,avgFilesPerSec,etaMs,elapsedMs}) now and on
 *                            every change; pending = total - done, localFiles = settled entries the
 *                            device served itself (local coverage), never a fetch. The rates are this
 *                            session's own (owner ask 2026-10-09): bytes off the Content-Length of the
 *                            ok settlements, files/s off the settlement count, etaMs off files/s --
 *                            bytesKnown=false means the responses carried no size, so bps is left 0
 *                            and the display must fall back to files/s instead of faking a byte rate
 *   state()                  diagnostic object (state, done, total, failed, pending, localFiles,
 *                            hash, fp, resumed, window, attempts, backoffMs, paused, gapMs,
 *                            carriedHash, stored, saved, bytes, bytesKnown, bps, avgBps, filesPerSec,
 *                            avgFilesPerSec, etaMs, elapsedMs, rateWindowMs, startDone) for on-device triage
 *   failed()                 capped copy of the failed path list -- what to check against the CDN
 *   snapshot()               JSON-safe alias of state()
 *
 * UI: a minimal fixed bottom-right corner progress chip with a "skip" button, built with its own DOM
 * and inline styles only (no dependency on any stylesheet). It removes itself when finished; a skip
 * press is remembered for the session (sessionStorage) so a reload does not restart the pull. The
 * label carries the live speed (owner ask 2026-10-09): "art 5415/10643 / 1.2 MB/s / 4m12s" (files/s
 * and no ETA-limit when the responses carry no Content-Length), repainted on a 500 ms heartbeat
 * (requestAnimationFrame; a hidden page and a sandbox without rAF cost nothing) while the run is on,
 * so a rate never freezes at its last settlement.
 *
 * Contract: ES5, pure ASCII, no third-party dependency, idempotent (loading it twice is a no-op).
 */
(function () {
  if (window.__SP_ART) return;

  var CONCURRENCY = 2;          // upper bound on asset fetches in flight (the shell keeps 4 page slots)
  var MIN_WINDOW = 1;           // backpressure floor
  var RECOVER_STREAK = 8;       // consecutive successes before the window grows back by one
  var GAP_MS = 120;             // minimum spacing between dispatches (do not arrive as a burst)
  var PAGE_POLL_MS = 400;       // how often the page-busy probe may re-run (see pageBusy)
  // A match / briefing / result screen means the page is asking for art RIGHT NOW: the prefetch
  // stands down entirely until it is gone (H3). These are the game's own screen roots.
  var MATCH_MARKS = '.screen.brief, .screen.gm, .screen.gload, .screen.result, .screen.draft';
  // Marks a fetch as the background prefetch; MainActivity (ArtCdn.isPrefetchRequest) then lets it
  // hold at most 2 CDN slots and only when the page is idle.
  var PREFETCH_HEADER = 'X-SP-Prefetch';
  var MANIFEST = '/data/assets.json';
  // The shell's "what can already be served locally" list: the APK's embedded tree (covered by the
  // APK signature, immutable while the app runs), the installed art packs and the hot tree. Entries
  // it names are served by openLocal long before the CDN cache is ever consulted, so prefetching
  // them warms nothing: they are counted and skipped (owner rule 2026-10-08: embedded art is not
  // hot-updatable, needs no verification -- and no round of requests either).
  var LOCAL_LIST = '/__sp/local-assets.txt';
  var LS_KEY = 'sp.art.v1';     // localStorage: { <manifest hash>: record }
  var LS_LAST_KEY = 'sp.art.last'; // the namespace of the most recent record (first-paint resume)
  var SS_SKIP_KEY = 'sp.art.skip.v1'; // '1' once the user pressed skip in this session
  var MAX_ATTEMPTS = 3;         // first try + 2 retries, per asset
  var RETRY_BASE_MS = 500;
  var RETRY_MAX_MS = 8000;
  var MANIFEST_ATTEMPTS = 3;    // the manifest itself is retried too (it gates the whole run)
  var MAX_FAILED = 1000;        // capped failed key list kept per record (~40 KB worst case)
  var MAX_RECORDS = 3;          // how many manifest-hash records to keep in localStorage
  var SAVE_EVERY = 16;          // persist every N settlements (plus finish/cancel/pagehide)
  var FETCH_TIMEOUT_MS = 15000; // soft per-request ceiling (only when AbortController exists)
  // Owner ask 2026-10-09: the preload progress must show its SPEED (download + unpack), not just a
  // count. This channel (the file walk) reports what it can honestly know: bytes off the
  // Content-Length of each settled response, settled files per second, and the ETA derived from
  // them. The pack channel's unpack speed is Java-side and arrives through ShellBridge.
  var RATE_WINDOW_MS = 15000;   // "current" rate = progress over this trailing window
  var UI_TICK_MS = 500;         // chip repaint while a run is on (a live rate must not jump at settles only)

  var state = 'idle';
  var done = 0;
  var total = 0;
  var failedCount = 0;
  var queue = [];
  var retries = [];             // items waiting out their backoff
  var queued = {};              // path -> 1, so a carried failure is never queued twice
  var active = 0;
  var limit = CONCURRENCY;      // effective window (backpressure lowers it)
  var started = false;
  var cancelled = false;
  var resumed = false;
  var callbacks = [];
  var manifestTries = 0;
  var manifestPending = false;
  var attempts = 0;             // asset request attempts this session (diagnostics)
  var settlements = 0;          // settled entries this session (save throttle)
  var okStreak = 0;
  var penaltyUntil = 0;         // backpressure gate: no new dispatch before this timestamp
  var nextDispatchAt = 0;       // pacing gate: at most one dispatch per GAP_MS
  var wakeTimer = null;
  var pauseTimer = null;        // re-check timer while the page owns the screen (pageBusy)
  var paused = 0;               // 1 while standing down for the page (diag/UI)
  var busyAt = -1e15;           // last pageBusy() probe time (throttled)
  var busy = 0;                 // last probe result
  var carriedHash = '';         // namespace a carried-over walk came from (H1, diag)
  var localSet = null;          // path -> 1: entries the device already serves without the CDN
  var localCount = 0;           // size of that list (diag)
  var localSkipped = 0;         // entries counted instead of requested this session (diag)
  var localGate = false;        // the coverage list is still being fetched (gates finish())
  var manifestTimer = null;
  var pumping = false;
  var dirty = false;
  var hash = '';                // manifest top-level hash (persistence namespace)
  var fp = '';                  // fingerprint of the enumerated list
  var cursor = 0;               // successes prefix length in manifest order
  var settledFlags = null;      // per-index settled flags, allocated once the list is known
  var failedKeys = [];          // capped list of paths still owed
  var failedTotal = 0;          // uncapped count of the paths still owed
  var failedSet = {};           // path -> 1
  var spillIdx = -1;            // first failure beyond the capped key list (-1: none)
  var walk = 0;                 // raw walk watermark (how far this session's walk got)
  var rewalkFrom = -1;          // a previous session re-walked [rewalkFrom, walkFrom) (-1: none)
  var walkFrom = 0;             // the stored walk watermark of that previous session
  var storedMeta = null;        // the record this session resumed from (diagnostics)
  var savePaused = false;       // set when localStorage is unusable
  // Rate bookkeeping (owner ask 2026-10-09: the display must carry speeds, not just a count).
  var bytesDone = 0;            // Content-Length sum over the ok settlements of THIS session
  var bytesKnown = false;       // at least one ok response carried a Content-Length (else: count-only)
  var runStartedAt = 0;         // when this session's walk began (0 = not started yet)
  var startDone = 0;            // `done` at the moment the walk began (a resumed count is not speed)
  var rateSamples = [];         // [{t, done, bytes}] over the trailing RATE_WINDOW_MS
  var uiTick = 0;               // rAF handle of the chip repaint heartbeat (0 = not armed)
  var uiLastPaint = 0;          // last heartbeat paint (the UI_TICK_MS throttle)

  // ---- small helpers --------------------------------------------------------

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
    try {
      return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null;
    } catch (e) {
      return null; // storage disabled (private mode): the run still works, it just cannot resume
    }
  }

  function sess() {
    try {
      return (typeof sessionStorage !== 'undefined' && sessionStorage) ? sessionStorage : null;
    } catch (e) {
      return null;
    }
  }

  function readAll() {
    var ls = store();
    if (!ls || savePaused) return null;
    try {
      var raw = ls.getItem(LS_KEY);
      var doc = raw ? JSON.parse(raw) : null;
      return doc && typeof doc === 'object' ? doc : null;
    } catch (e) {
      return null;
    }
  }

  function writeAll(doc) {
    var ls = store();
    if (!ls || savePaused) return false;
    try {
      ls.setItem(LS_KEY, JSON.stringify(doc));
      return true;
    } catch (e) {
      savePaused = true; // quota or a locked store: stop trying, keep the session running
      return false;
    }
  }

  /** Persistence namespace. The manifest hash is the requirement; a manifest without one still gets
   *  a resume slot so the feature never silently disappears. */
  function ns() {
    return hash || 'nohash';
  }

  /** Fingerprint of the enumerated list (FNV-1a over every path): a different asset set -> a
   *  different value -> the stored cursor is not trusted. One pass over ~700 KB of text. */
  function fingerprint(list) {
    var h = 0x811c9dc5;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      for (var j = 0; j < s.length; j++) {
        h = h ^ s.charCodeAt(j);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      }
      h = h ^ 0x2f; // '/'
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  /**
   * True while the prefetch must stand down: the page is showing a match / briefing screen (its own
   * art requests win the CDN slots; the shell enforces that too, see PREFETCH_HEADER) or the
   * document is hidden (nothing on screen to warm). An absent/throwing DOM (tests, other hosts) is
   * never "busy" -- the feature must not disappear where it cannot probe. Probed at most every
   * PAGE_POLL_MS: querySelector on a live match tree is not free.
   */
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

  // ---- rates (owner ask 2026-10-09: show the preload speed, not just the count) ----------------

  /** Content-Length of a response, 0 when absent/unreadable. The interceptor sets it on the CDN
   *  answers it caches; a response without one simply does not feed the byte rate -- bytesKnown
   *  stays false and the display falls back to files/s instead of inventing a number. */
  function lenOf(res) {
    try {
      if (!res || !res.headers || typeof res.headers.get !== 'function') return 0;
      var cl = res.headers.get('content-length');
      var n = cl ? parseInt(cl, 10) : 0;
      return isFinite(n) && n > 0 ? n : 0;
    } catch (e) { return 0; }
  }

  /** One window sample (called from emit: every state change is a data point). */
  function sample() {
    var t = now();
    rateSamples.push({ t: t, done: done, bytes: bytesDone });
    while (rateSamples.length > 1 && t - rateSamples[0].t > RATE_WINDOW_MS) rateSamples.shift();
  }

  /** The walk's own rates + ETA. bps is honest only when the responses carried sizes, so callers
   *  MUST branch on bytesKnown; filesPerSec/etaMs work either way. A resumed session's carried
   *  count is excluded (startDone): it was not fetched now, and counting it would fake a huge rate. */
  function metrics() {
    var out = {
      bytes: bytesDone, bytesKnown: bytesKnown,
      bps: 0, avgBps: 0, filesPerSec: 0, avgFilesPerSec: 0, etaMs: -1, elapsedMs: 0,
    };
    if (!runStartedAt) return out;
    var t = now();
    var el = t - runStartedAt;
    if (el <= 0) return out;
    out.elapsedMs = el;
    var secs = el / 1000;
    var sessionDone = done - startDone;
    if (sessionDone > 0) out.avgFilesPerSec = sessionDone / secs;
    if (bytesKnown && bytesDone > 0) out.avgBps = bytesDone / secs;
    var first = rateSamples.length ? rateSamples[0] : null;
    var dt = first ? (t - first.t) / 1000 : secs;
    if (dt > 0.5) {
      var dDone = done - (first ? first.done : startDone);
      var dBytes = bytesDone - (first ? first.bytes : 0);
      if (dDone > 0) out.filesPerSec = dDone / dt;
      if (bytesKnown && dBytes > 0) out.bps = dBytes / dt;
    }
    var owed = total - done;
    if (owed <= 0) { if (total > 0) out.etaMs = 0; return out; }
    var fps = out.filesPerSec > 0 ? out.filesPerSec : out.avgFilesPerSec;
    if (fps > 0) out.etaMs = Math.round(owed / fps * 1000);
    return out;
  }

  function fmtBps(bps) {
    if (!(bps > 0)) return '0 B/s';
    if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
    if (bps >= 1024) return Math.round(bps / 1024) + ' KB/s';
    return Math.round(bps) + ' B/s';
  }

  function fmtDur(ms) {
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm' + (s % 60 < 10 ? '0' : '') + (s % 60) + 's';
    return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
  }

  /** The chip's speed suffix (' / 1.2 MB/s / 4m12s'). Nothing while paused or not running -- a
   *  frozen rate on screen reads as a stall, and the paused marker already says what is up. */
  function rateText() {
    if (state !== 'running' || paused) return '';
    var m = metrics();
    var out = '';
    if (m.bps > 0) out += ' \u00B7 ' + fmtBps(m.bps);
    else if (m.filesPerSec > 0) out += ' \u00B7 ' + Math.round(m.filesPerSec) + ' f/s';
    if (m.etaMs > 0) out += ' \u00B7 ' + fmtDur(m.etaMs);
    return out;
  }

  // ---- progress plumbing ----------------------------------------------------

  function snapshot() {
    var m = metrics(); // once per emit: the frame's progress + its rates
    return {
      state: state, done: done, total: total, failed: failedCount,
      // pending = what is still NOT settled on the device (total - done): the owner-facing
      // "pending" figure. localFiles = how many of the settled entries were answered by the
      // device itself (APK tree / installed pack / hot tree) instead of being fetched -- the
      // "local-available" figure. Counted where the coverage list is consulted (enqueue), never re-walked.
      pending: total > done ? total - done : 0,
      localFiles: localSkipped,
      resumed: resumed,
      // Owner ask 2026-10-09: progress carries speeds. These are the FILE walk's own numbers
      // (this session only). The pack channel's download/unpack speeds are Java-side and travel
      // through ShellBridge.artSyncStatus -- never faked here.
      bytes: m.bytes, bytesKnown: m.bytesKnown,
      bps: Math.round(m.bps), avgBps: Math.round(m.avgBps),
      filesPerSec: m.filesPerSec, avgFilesPerSec: m.avgFilesPerSec,
      etaMs: m.etaMs, elapsedMs: m.elapsedMs,
    };
  }

  function diag() {
    // Every value is a primitive or a plain copy: safe to JSON.stringify from a device console.
    var m = metrics();
    return {
      state: state, done: done, total: total, failed: failedCount,
      pending: total > done ? total - done : 0,
      localFiles: localSkipped,
      inflight: active, window: limit, attempts: attempts,
      backoffMs: penaltyUntil > now() ? penaltyUntil - now() : 0,
      paused: paused, gapMs: GAP_MS, carriedHash: carriedHash,
      localList: localCount, localSkipped: localSkipped,
      resumed: resumed, hash: hash, fp: fp, cursor: writeCursor(), walkCursor: cursor, walk: walk,
      idle: total - walk, spill: spillIdx, rewalkFrom: rewalkFrom,
      failedKeys: failedKeys.length, manifestTries: manifestTries,
      stored: storedMeta, saved: !savePaused && !!store(),
      bytes: m.bytes, bytesKnown: m.bytesKnown,
      bps: m.bps, avgBps: m.avgBps, filesPerSec: m.filesPerSec, avgFilesPerSec: m.avgFilesPerSec,
      etaMs: m.etaMs, elapsedMs: m.elapsedMs, rateWindowMs: RATE_WINDOW_MS, startDone: startDone,
    };
  }

  function emit() {
    sample(); // every state change feeds the trailing rate window
    var snap = snapshot();
    for (var i = 0; i < callbacks.length; i++) {
      try { callbacks[i](snap); } catch (e) { /* a bad callback must not break the pump */ }
    }
    updateUI();
  }

  // ---- persisted progress ---------------------------------------------------

  /** The cursor to persist: the walk watermark, pulled back to the first spilled failure so a run
   *  with more owed paths than the key cap still re-walks every one of them next session. */
  function writeCursor() {
    return spillIdx >= 0 && spillIdx < cursor ? spillIdx : cursor;
  }

  function save() {
    var ls = store();
    if (!ls || savePaused) return;
    var doc = readAll() || {};
    doc[ns()] = {
      hash: hash, fp: fp, total: total, done: done, idle: total - walk,
      cursor: writeCursor(), walk: walk,
      failed: failedKeys.slice(0, MAX_FAILED), failedTotal: failedTotal,
      t: now(),
    };
    // Keep the newest few namespaces only: a hot update changes the manifest hash and an unbounded
    // map would slowly eat the WebView's origin quota.
    var keys = [];
    for (var k in doc) { if (Object.prototype.hasOwnProperty.call(doc, k)) keys.push(k); }
    if (keys.length > MAX_RECORDS) {
      keys.sort(function (a, b) { return ((doc[b] && doc[b].t) || 0) - ((doc[a] && doc[a].t) || 0); });
      for (var i = MAX_RECORDS; i < keys.length; i++) delete doc[keys[i]];
    }
    if (writeAll(doc)) {
      try { ls.setItem(LS_LAST_KEY, ns()); } catch (e) { /* ignore */ }
    }
  }

  function recordFor(namespace) {
    var doc = readAll();
    if (!doc || !namespace) return null;
    var rec = doc[namespace];
    return rec && typeof rec === 'object' ? rec : null;
  }

  /** The stored record for the manifest at hand -- only when it describes the SAME asset set
   *  (fingerprint + total). A changed set must never skip entries that were never fetched. */
  function matchingRecord() {
    var rec = recordFor(ns());
    if (rec && rec.fp === fp && rec.total === total) return rec;
    return carriedRecord();
  }

  /**
   * H1 carry-over (2026-10-08 field report: the chip restarted at 0/7969 and re-walked everything
   * after a content release). data/assets.json's top-level `hash` is re-emitted from the SAME
   * referenced bytes on every release (tools/apk/transcode-assets.mjs hashReferencedBytes), so a
   * content update moves the namespace while the enumerated list stays byte-identical (same
   * fingerprint, same total -- measured: 7969 paths, fp 7c35d506, both b699458e3e10 and
   * 7ae1d03466cb). The shell renames the old cache namespace onto the new one
   * (MainActivity.adoptArtCacheNamespace), so every entry the previous session settled is still a
   * cache hit: carrying done/cursor/walk keeps the chip's numbers and stops the walk from
   * re-requesting thousands of files. Only the per-file failed list is dropped -- a failure under
   * the old namespace may be stale, and re-queueing hundreds of keys would flood the retry ladder;
   * a path that really is missing is still fetched by the page's own request.
   */
  function carriedRecord() {
    var prev = preload();
    if (!prev || !prev.hash || prev.hash === hash) return null; // only a hash CHANGE carries
    if (prev.fp !== fp || prev.total !== total) return null;    // and only the same asset set
    carriedHash = prev.hash;
    return {
      hash: prev.hash, fp: prev.fp, total: prev.total, done: prev.done, idle: prev.idle,
      cursor: prev.cursor, walk: prev.walk, failed: [], failedTotal: 0, t: prev.t,
    };
  }

  /** The most recent record, whatever its hash: used for the very first paint of a reload (the
   *  manifest has not been read yet, so the hash cannot be known). Re-validated once it lands. */
  function preload() {
    var ls = store();
    if (!ls || savePaused) return null;
    try {
      var last = ls.getItem(LS_LAST_KEY);
      return last ? recordFor(last) : null;
    } catch (e) {
      return null;
    }
  }

  function adoptRecord(rec, cappedAt) {
    done = clampInt(rec.done, 0, cappedAt);
    total = cappedAt;
    failedTotal = clampInt(rec.failedTotal, 0, cappedAt);
    if (failedTotal < 0) failedTotal = 0;
    failedCount = failedTotal;
    resumed = done > 0 || failedTotal > 0;
    storedMeta = {
      done: done, total: total, cursor: clampInt(rec.cursor, 0, cappedAt),
      failedTotal: failedTotal,
    };
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

  // ---- manifest -> ordered list of same-origin asset paths ------------------

  /**
   * The shell's local-coverage list (see LOCAL_LIST). Best effort by design: an older APK answers
   * 404 and the walk then behaves exactly as it did before (no filtering). Returns a promise (or
   *  null when fetch is unavailable), always fulfilled.
   */
  function loadLocalList() {
    try {
      var init = { cache: 'no-store' };
      var headers = {};
      headers[PREFETCH_HEADER] = '1'; // marked too: it yields to the page like every prefetch fetch
      init.headers = headers;
      var pr = fetch(LOCAL_LIST, init);
      if (!pr || typeof pr.then !== 'function') return null;
      var settle = function (text) {
        if (typeof text !== 'string' || !text) return null;
        var lines = text.split('\n');
        var set = {};
        var n = 0;
        for (var i = 0; i < lines.length; i++) {
          var p = lines[i].replace(/[\r\t ]+$/, '');
          if (!p) continue;
          if (p.charAt(0) !== '/') p = '/' + p;
          if (!set[p]) { set[p] = 1; n++; }
        }
        if (!n) return null;
        localSet = set;
        localCount = n;
        return set;
      };
      return pr.then(function (r) {
        if (!r || !r.ok || typeof r.text !== 'function') return null;
        return r.text();
      }).then(settle, function () { return null; });
    } catch (e) {
      return null;
    }
  }

  // "/assets/x" -> "/assets/x"; "<cdn>/assets-re/x" -> "/assets/x"; anything else -> null.
  function toLocalPath(v) {
    if (typeof v !== 'string') return null;
    var i = v.indexOf('/assets/');
    if (i >= 0) return v.substring(i);
    var j = v.indexOf('/assets-re/');
    if (j >= 0) return '/assets/' + v.substring(j + 11);
    return null;
  }

  function collect(node, out, seen) {
    if (node == null) return;
    if (typeof node === 'string') {
      var p = toLocalPath(node);
      if (p && !seen[p]) { seen[p] = 1; out.push(p); }
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) collect(node[i], out, seen);
      return;
    }
    for (var k in node) {
      if (Object.prototype.hasOwnProperty.call(node, k)) collect(node[k], out, seen);
    }
  }

  // ---- the run: seed (resume), pump, settle ---------------------------------

  /**
   * Seeds the queue from a stored record: the owed paths first (they failed before, they are
   * re-tried before anything new), then the manifest from the stored cursor to the end. Entries
   * before the cursor were already resolved in an earlier session (fetched or finally failed), so
   * they are skipped -- that is what makes a reload continue instead of restarting.
   */
  function seed(list, rec) {
    queue = [];
    queued = {};
    settledFlags = [];
    for (var i = 0; i < list.length; i++) settledFlags[i] = 0;
    cursor = 0;
    spillIdx = -1;
    failedKeys = [];
    failedSet = {};
    failedTotal = 0;
    done = 0;
    resumed = false;
    rewalkFrom = -1;
    walkFrom = 0;
    walk = 0;
    if (rec) {
      done = clampInt(rec.done, 0, list.length);
      cursor = clampInt(rec.cursor, 0, list.length);
      walk = clampInt(rec.walk, cursor, list.length);
      if (cursor < walk) { rewalkFrom = cursor; walkFrom = walk; } // the previous run spilled
      var keys = Array.isArray(rec.failed) ? rec.failed : [];
      var seen = {};
      for (var k = 0; k < keys.length && failedKeys.length < MAX_FAILED; k++) {
        var p = keys[k];
        if (typeof p !== 'string' || !p || seen[p]) continue;
        seen[p] = 1;
        failedKeys.push(p);
        failedSet[p] = 1;
      }
      failedTotal = Math.max(clampInt(rec.failedTotal, 0, list.length), failedKeys.length);
      resumed = done > 0 || cursor > 0 || failedKeys.length > 0;
      storedMeta = {
        done: done, total: list.length, cursor: cursor, failedTotal: failedTotal,
      };
    } else {
      storedMeta = null; // a stale first-paint preload must not be reported as the resume source
    }
    // Rates start fresh at the manifest's walk. The resumed `done` is carried into startDone, never
    // into bytesDone: bytes this session did not download must not show up as its speed.
    bytesDone = 0;
    bytesKnown = false;
    startDone = done;
    rateSamples = [];
    runStartedAt = now();
    failedCount = failedTotal;
    for (var f = 0; f < failedKeys.length; f++) enqueue(failedKeys[f], -1, true);
    for (var j = cursor; j < list.length; j++) enqueue(list[j], j);
  }

  function enqueue(path, idx, carried) {
    if (!path || queued[path]) return;
    // Already on the device (embedded tree / installed pack / hot tree): openLocal answers it long
    // before the CDN cache is consulted, so there is nothing to warm -- count it and never request
    // it. A carried failure is exempt: it was asked for and failed, so it must be retried.
    if (!carried && localSet && localSet[path]) {
      if (done < total) done++;
      localSkipped++;
      markSettled(idx);
      return;
    }
    queued[path] = 1;
    queue.push({ path: path, idx: idx, attempt: 0, at: 0, carried: !!carried });
  }

  /** Marks an index settled and advances the contiguous prefix: nothing before it is still owed.
   *  A settled failure counts too -- the failed key list is what carries it into the next session. */
  function markSettled(idx) {
    if (idx > walk) walk = idx + 1;
    if (!settledFlags || settledFlags[idx]) return;
    settledFlags[idx] = 1;
    if (idx === cursor) {
      while (cursor < settledFlags.length && settledFlags[cursor]) cursor++;
    }
  }

  function settleOk(item) {
    if (done < total) done++; // a re-walked success is a cache hit, never a new entry
    if (item.idx >= 0) markSettled(item.idx);
    if (failedSet[item.path]) {
      failedSet[item.path] = 0;
      for (var i = 0; i < failedKeys.length; i++) {
        if (failedKeys[i] === item.path) { failedKeys.splice(i, 1); break; }
      }
      if (failedTotal > 0) failedTotal--;
      failedCount = failedTotal;
    }
    okStreak++;
    if (okStreak >= RECOVER_STREAK) {
      okStreak = 0;
      if (limit < CONCURRENCY) limit++;
    }
  }

  function settleFail(item) {
    if (item.idx >= 0) markSettled(item.idx);
    // A failure inside the region a previous session spilled back over is ALREADY part of the
    // stored count (its key was the part that did not fit): count it once, not once per reload.
    var recounted = rewalkFrom >= 0 && item.idx >= rewalkFrom && item.idx < walkFrom;
    if (!failedSet[item.path]) {
      failedSet[item.path] = 1;
      if (failedKeys.length < MAX_FAILED) {
        failedKeys.push(item.path);
      } else if (item.idx >= 0 && (spillIdx < 0 || item.idx < spillIdx)) {
        spillIdx = item.idx; // beyond the cap: pull the cursor back so the tail is re-walked
      }
      if (!recounted) failedTotal++;
    }
    failedCount = failedTotal;
  }

  function backoffMs(attempt) {
    var ms = RETRY_BASE_MS;
    for (var i = 1; i < attempt; i++) ms = ms * 2;
    return ms > RETRY_MAX_MS ? RETRY_MAX_MS : ms;
  }

  function settle(item, result) {
    active--;
    if (state === 'running') { // a late settle after cancel() is not progress (nor a loss)
      if (result === 'ok') {
        settleOk(item);
      } else if (result === 'retry' && item.attempt + 1 < MAX_ATTEMPTS) {
        item.attempt++;
        item.at = now() + backoffMs(item.attempt);
        retries.push(item);
        if (item.at > penaltyUntil) penaltyUntil = item.at;
        if (limit > MIN_WINDOW) limit--; // backpressure: one failure narrows the window
        okStreak = 0;
      } else {
        // Exhausted (or permanent): the path stays owed, so the next session picks it up again.
        settleFail(item);
      }
      settlements++;
      if (settlements % SAVE_EVERY === 0) save();
      emit();
      wake();
    }
    pump(); // pump() defers while it is already running (no recursion through a sync settle)
  }

  function classify(res) {
    if (res && res.ok) return 'ok';
    var code = res && typeof res.status === 'number' ? res.status : 0;
    if (code === 408 || code === 425 || code === 429 || code >= 500) return 'retry';
    if (code >= 400) return 'dead'; // 401/403/404/410: a retry would fetch the same answer
    return 'retry';                 // opaque response (status 0): treat as transient
  }

  /** True when this attempt must not be answered from the WebView's HTTP cache: a retry, a path
   *  carried over from an earlier session, or an entry inside the region a spilled run re-walks. */
  function bypassCache(item) {
    if (item.carried || item.attempt > 0) return true;
    return rewalkFrom >= 0 && item.idx >= rewalkFrom && item.idx < walkFrom;
  }

  function fetchOne(item) {
    active++;
    attempts++;
    var settledOnce = false;
    var timer = null;
    function once(result) {
      if (settledOnce) return;
      settledOnce = true;
      if (timer) { try { clearTimeout(timer); } catch (e) { /* ignore */ } timer = null; }
      settle(item, result);
    }
    try {
      // force-cache for a genuinely new look-up; no-store for a retry, a carried failure and a
      // re-walked entry -- all three were looked up before, so the cache may hold their failure
      var init = { cache: bypassCache(item) ? 'no-store' : 'force-cache' };
      var headers = {};
      headers[PREFETCH_HEADER] = '1'; // the shell serves the page's own fetches first (H3)
      init.headers = headers;
      if (typeof AbortController === 'function') {
        var ctl = new AbortController();
        init.signal = ctl.signal;
        timer = setTimeout(function () { try { ctl.abort(); } catch (e) { /* ignore */ } }, FETCH_TIMEOUT_MS);
      }
      var pr = fetch(item.path, init);
      if (!pr || typeof pr.then !== 'function') { once('retry'); return; }
      pr.then(function (r) {
        // Read the size off the headers BEFORE releasing the stream: it is what feeds the byte rate.
        // Counted on ok only -- a 5xx error page carries a Content-Length too, and counting it would
        // inflate the displayed speed.
        var verdict = classify(r);
        var len = lenOf(r);
        if (verdict === 'ok' && len > 0) { bytesDone += len; bytesKnown = true; }
        // Do not buffer the body in JS: the interceptor already wrote the full file to the cache
        // before responding, so the response existing is enough. Release the stream we will not read.
        if (r && r.body && typeof r.body.cancel === 'function') { try { r.body.cancel(); } catch (e) { /* ignore */ } }
        once(verdict);
      }, function () { once('retry'); });
    } catch (e) {
      once('retry');
    }
  }

  /** Earliest moment the run may make progress again (a retry becomes due, the penalty lapses). */
  function soonest() {
    var t = penaltyUntil > now() ? penaltyUntil : Infinity;
    for (var i = 0; i < retries.length; i++) {
      if (retries[i].at < t) t = retries[i].at;
    }
    return t;
  }

  function dueRetries() {
    if (!retries.length) return;
    var t = now();
    var keep = [];
    for (var i = 0; i < retries.length; i++) {
      if (retries[i].at <= t) queue.push(retries[i]); else keep.push(retries[i]);
    }
    retries = keep;
  }

  function wake() {
    if (wakeTimer || cancelled || state !== 'running') return;
    var at = soonest();
    if (at === Infinity) return;
    var delay = at - now();
    if (delay < 1) delay = 1;
    wakeTimer = setTimeout(function () {
      wakeTimer = null;
      if (cancelled || state !== 'running') return;
      dueRetries();
      pump();
    }, delay);
  }

  /** Schedules one pump() run at `at` (used for the stand-down poll and the pacing gate). */
  function scheduleCheck(at) {
    if (pauseTimer || cancelled || state !== 'running') return;
    var delay = at - now();
    if (delay < 1) delay = 1;
    pauseTimer = setTimeout(function () {
      pauseTimer = null;
      if (cancelled || state !== 'running') return;
      pump();
    }, delay);
  }

  function pump() {
    if (cancelled || state !== 'running') return;
    if (pumping) { dirty = true; return; } // a settle inside dispatch: the running loop picks it up
    pumping = true;
    dirty = true;
    try {
      while (dirty) {
        dirty = false;
        dueRetries();
        // (a) the page owns the screen -> no dispatch at all, not even a cached look-up (H3)
        if (pageBusy()) {
          if (!paused) { paused = 1; emit(); }
          scheduleCheck(now() + PAGE_POLL_MS);
          break;
        }
        if (paused) { paused = 0; emit(); }
        if (now() < penaltyUntil) { wake(); break; } // backpressure: wait, do not dispatch
        // (b) pacing: at most one dispatch per GAP_MS, so the shell's CDN slots stay mostly the page's
        if (now() < nextDispatchAt) { scheduleCheck(nextDispatchAt); break; }
        nextDispatchAt = now() + GAP_MS;
        while (active < limit && queue.length) {
          fetchOne(queue.shift());
          if (now() < nextDispatchAt) break; // one per pass; the pacing timer re-enters
        }
        // a partial fill leaves the window open: come back the moment the gap lapses
        if (queue.length && active < limit) scheduleCheck(nextDispatchAt);
        if (active === 0 && queue.length === 0 && retries.length === 0 && !manifestPending && !localGate) {
          finish();
          break;
        }
      }
    } finally {
      pumping = false;
    }
  }

  function finish() {
    if (state !== 'running') return;
    state = 'done';
    paused = 0;
    if (pauseTimer) { try { clearTimeout(pauseTimer); } catch (e) { /* ignore */ } pauseTimer = null; }
    save();
    emit();
    hideSoon(1200);
  }

  function failAll() {
    if (cancelled || state !== 'running') return;
    state = 'failed';
    paused = 0;
    if (pauseTimer) { try { clearTimeout(pauseTimer); } catch (e) { /* ignore */ } pauseTimer = null; }
    save();
    emit();
    hideSoon(1500);
  }

  function loadManifest() {
    manifestPending = true;
    var pr = fetch(MANIFEST, { cache: 'force-cache' });
    if (!pr || typeof pr.then !== 'function') { retryManifest(); return; }
    pr.then(function (r) {
      if (!r || !r.ok) throw new Error('manifest unavailable');
      return r.json();
    }).then(function (doc) {
      if (cancelled || state !== 'running') return;
      manifestPending = false;
      var out = [], seen = {};
      try { collect(doc, out, seen); } catch (e) { /* malformed manifest -> nothing to fetch */ }
      hash = doc && typeof doc.hash === 'string' ? doc.hash : '';
      total = out.length;
      fp = fingerprint(out);
      if (!total) { finish(); return; }
      // The local coverage list only ever REMOVES work (entries the device serves without the CDN),
      // so wait for it before seeding -- one short local request instead of thousands of pointless
      // ones. Its absence (older APK / 404) is the old behaviour, not an error.
      var begin = function () {
        if (cancelled || state !== 'running') return;
        localGate = false;
        seed(out, matchingRecord());
        emit();
        pump();
      };
      localGate = true;
      var gate = loadLocalList();
      if (gate && typeof gate.then === 'function') { gate.then(begin, begin); return; }
      begin();
    }, function () {
      if (cancelled || state !== 'running') return;
      retryManifest();
    });
  }

  /** A failed manifest is retried with the same backoff ladder (without it there is no run at
   *  all); the stored progress stays untouched, so the next attempt still resumes. */
  function retryManifest() {
    manifestTries++;
    if (manifestTries >= MANIFEST_ATTEMPTS) {
      manifestPending = false;
      failAll();
      return;
    }
    var delay = backoffMs(manifestTries);
    if (manifestTimer) { try { clearTimeout(manifestTimer); } catch (e) { /* ignore */ } }
    manifestTimer = setTimeout(function () {
      manifestTimer = null;
      if (cancelled || state !== 'running') return;
      try { loadManifest(); } catch (e) { manifestPending = false; failAll(); }
    }, delay);
  }

  function start() {
    if (started) return; // idempotent
    started = true;
    if (typeof fetch !== 'function') { state = 'failed'; emit(); return; }
    state = 'running';
    cancelled = false;
    done = 0; failedCount = 0; total = 0; failedTotal = 0;
    queue = []; retries = []; queued = {}; failedKeys = []; failedSet = {};
    limit = CONCURRENCY; penaltyUntil = 0; nextDispatchAt = 0;
    attempts = 0; settlements = 0; okStreak = 0;
    manifestTries = 0; manifestPending = false; storedMeta = null; resumed = false;
    paused = 0; busyAt = -1e15; busy = 0; carriedHash = '';
    localSet = null; localCount = 0; localSkipped = 0; localGate = false;
    bytesDone = 0; bytesKnown = false; startDone = 0; rateSamples = []; runStartedAt = 0;
    if (pauseTimer) { try { clearTimeout(pauseTimer); } catch (e) { /* ignore */ } pauseTimer = null; }
    hash = ''; fp = ''; cursor = 0; settledFlags = null; spillIdx = -1; walk = 0;
    rewalkFrom = -1; walkFrom = 0;
    // First paint of a resumed run: the last record's numbers are shown before the manifest lands
    // (the manifest then re-validates them by hash + fingerprint + total and corrects them).
    var last = preload();
    if (last && last.total > 0) adoptRecord(last, clampInt(last.total, 1, 1000000));
    emit();
    showUI();
    try {
      loadManifest();
    } catch (e) {
      manifestPending = false;
      failAll();
    }
  }

  function cancel() {
    cancelled = true;
    queue = [];
    retries = [];
    manifestPending = false;
    paused = 0;
    localGate = false;
    if (wakeTimer) { try { clearTimeout(wakeTimer); } catch (e) { /* ignore */ } wakeTimer = null; }
    if (pauseTimer) { try { clearTimeout(pauseTimer); } catch (e) { /* ignore */ } pauseTimer = null; }
    if (manifestTimer) { try { clearTimeout(manifestTimer); } catch (e) { /* ignore */ } manifestTimer = null; }
    if (state === 'running' || state === 'idle') state = 'cancelled';
    rememberSkip(); // the skip is remembered for the session: a reload does not restart the pull
    save();
    emit();
    removeUI();
  }

  function onProgress(cb) {
    if (typeof cb !== 'function') return;
    callbacks.push(cb);
    try { cb(snapshot()); } catch (e) { /* ignore */ }
  }

  // ---- minimal corner UI (own DOM, inline styles, no stylesheet dependency) --

  var ui = null, uiText = null, uiFill = null, uiTimer = null;

  // A live rate needs its own repaint cadence: settlements arrive in bursts, and a stall would leave
  // a stale number on screen. The heartbeat rides the page's animation frame (available in the
  // WebView; absent on a plain sandbox/old WebView, where paints then happen on settle only) and is
  // throttled to UI_TICK_MS, so the cost is one no-op check per frame. It dies with the run, with a
  // pause (a match screen owns the page) and with the chip; a paint re-arms it via updateUI().
  function startTick() {
    if (uiTick || !ui) return;
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;
    try { uiTick = window.requestAnimationFrame(paintTick); } catch (e) { uiTick = 0; }
  }

  function paintTick(stamp) {
    uiTick = 0;
    if (state !== 'running' || paused || !ui) return; // nothing to show: the chain ends here
    var t = typeof stamp === 'number' ? stamp : now();
    if (t - uiLastPaint >= UI_TICK_MS) { uiLastPaint = t; updateUI(); }
    startTick();
  }

  function stopTick() {
    if (uiTick && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      try { window.cancelAnimationFrame(uiTick); } catch (e) { /* ignore */ }
    }
    uiTick = 0;
  }

  function showUI() {
    if (typeof document === 'undefined' || !document.body || ui) return;
    try {
      ui = document.createElement('div');
      ui.setAttribute('data-sp-art', '1');
      var s = ui.style;
      // bottom 3.4rem, not 10px: the title screen's footer (copyright / version / check-update)
      // owns the bottom-right corner, and a 10px chip swallowed the update button's clicks
      // (2026-10-08 integrated sim: "update button not clickable"). The chip itself is
      // pointer-events:none (only the skip button takes clicks), so it can never eat a tap even
      // where it visually overlaps.
      s.position = 'fixed'; s.right = '10px'; s.bottom = '3.4rem'; s.zIndex = '2147483647';
      s.pointerEvents = 'none';
      s.background = 'rgba(12,15,14,0.82)'; s.color = '#8A9A93';
      s.font = '11px/1.4 -apple-system,Segoe UI,Roboto,sans-serif';
      s.padding = '6px 8px'; s.borderRadius = '6px'; s.maxWidth = '46vw';
      s.boxShadow = '0 1px 4px rgba(0,0,0,0.4)';

      uiText = document.createElement('span');
      uiText.textContent = 'art 0/0';
      // 2026-10-08 (owner): this chip IS the preload UI -- the only always-visible progress display.
      // Its label opens the preload panel on demand (profiles / verify / clear). Read lazily: this
      // module loads before preload-center.js, so window.__SP_PRELOAD does not exist yet here.
      // Only the label is clickable -- the chip itself stays pointer-events:none so it never blocks
      // a control underneath (it sits just above the title screen's update-check button).
      uiText.style.pointerEvents = 'auto';
      uiText.style.cursor = 'pointer';
      uiText.title = '\u9884\u8F7D\u8FDB\u5EA6 \u00B7 \u70B9\u51FB\u7BA1\u7406';
      uiText.onclick = function () {
        try {
          var pc = window.__SP_PRELOAD;
          if (pc && typeof pc.open === 'function') pc.open();
        } catch (e) { /* panel is optional */ }
      };

      var skip = document.createElement('button');
      skip.textContent = 'skip';
      var ss = skip.style;
      ss.marginLeft = '8px'; ss.font = 'inherit'; ss.color = '#4ED8AF';
      ss.background = 'transparent'; ss.border = '1px solid #2f5a4d';
      ss.borderRadius = '4px'; ss.padding = '1px 6px'; ss.cursor = 'pointer';
      ss.pointerEvents = 'auto'; // the chip is none; only skip needs to be clickable
      skip.onclick = function () { cancel(); };

      var bar = document.createElement('div');
      var bs = bar.style;
      bs.height = '3px'; bs.marginTop = '4px'; bs.background = 'rgba(255,255,255,0.12)';
      bs.borderRadius = '2px'; bs.overflow = 'hidden';
      uiFill = document.createElement('div');
      var fs = uiFill.style;
      fs.height = '3px'; fs.width = '0%'; fs.background = '#4ED8AF';
      bar.appendChild(uiFill);

      ui.appendChild(uiText);
      ui.appendChild(skip);
      ui.appendChild(bar);
      document.body.appendChild(ui);
      updateUI();
      startTick(); // the rate keeps moving even between settlements
    } catch (e) { ui = null; uiText = null; uiFill = null; }
  }

  function updateUI() {
    if (!ui || !uiText || !uiFill) return;
    try {
      uiText.textContent = 'art ' + done + '/' + total + rateText()
        + (failedCount ? ' (' + failedCount + ' failed)' : '')
        + (paused ? ' (paused)' : ''); // standing down for a match screen: visible, not silent
      uiFill.style.width = (total ? Math.floor(done * 100 / total) : 0) + '%';
    } catch (e) { /* ignore */ }
    startTick(); // a paint (re)arms the heartbeat; the paused/finished cases end it
  }

  function hideSoon(ms) {
    if (!ui) return;
    try { if (uiTimer) clearTimeout(uiTimer); uiTimer = setTimeout(removeUI, ms); } catch (e) { /* ignore */ }
  }

  function removeUI() {
    stopTick();
    if (uiTimer) { try { clearTimeout(uiTimer); } catch (e) { /* ignore */ } uiTimer = null; }
    if (ui && ui.parentNode) { try { ui.parentNode.removeChild(ui); } catch (e) { /* ignore */ } }
    ui = null; uiText = null; uiFill = null;
  }

  // Persist when the page really leaves (a killed WebView never runs this -- the SAVE_EVERY
  // throttle and the cursor's settle-only advance are what cover that case).
  try {
    if (typeof window.addEventListener === 'function') {
      var flush = function () { try { save(); } catch (e) { /* ignore */ } };
      window.addEventListener('pagehide', flush, false);
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', flush, false);
      }
    }
  } catch (e) { /* no DOM: tests */ }

  // ---- export ---------------------------------------------------------------

  var api = {};
  function expose(name, get) {
    try { Object.defineProperty(api, name, { get: get, enumerable: true }); }
    catch (e) { try { api[name] = get(); } catch (e2) { /* ignore */ } }
  }
  expose('phase', function () { return state; });
  expose('done', function () { return done; });
  expose('total', function () { return total; });
  expose('failedCount', function () { return failedCount; });
  api.state = function () { return diag(); };
  api.snapshot = function () { return diag(); };
  api.failed = function () { return failedKeys.slice(0); };
  api.start = start;
  api.cancel = cancel;
  api.onProgress = onProgress;
  window.__SP_ART = api;

  // Auto-start once, just after load, so the first frame is not competing with prefetch. Hosts (and
  // tests) that want manual control set window.__SP_ART_NO_AUTO = 1 before loading this file; a skip
  // pressed earlier in this session is honored (until the session ends).
  try {
    if (!window.__SP_ART_NO_AUTO && typeof setTimeout === 'function') {
      setTimeout(function () {
        try {
          if (!skippedThisSession()) start();
        } catch (e) { /* silent */ }
      }, 0);
    }
  } catch (e) { /* silent */ }
})();
