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
 * is a guest on a phone's link: it starts at CONCURRENCY 2 and may grow to MAX_WINDOW (4) while the
 * link stays healthy (audit 2026-10-09 phase 5), paces its dispatches by GAP_MS, marks every fetch
 * with the X-SP-Prefetch header (the shell then lets it hold at most that many CDN slots, and only
 * while the page is idle) and STANDS DOWN ENTIRELY while a match / briefing screen is on the page
 * (MATCH_MARKS) or the document is hidden -- the page's own load of that screen must never wait
 * behind a background walk.
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
 * A CHANGED MANIFEST HASH DOES NOT CARRY (audit 2026-10-09 phase 1): the manifest hash is a
 * byte-sensitive CONTENT hash (tools/apk/transcode-assets.mjs hashReferencedBytes), so a hash change
 * means some bytes changed -- but the device cannot tell WHICH file moved. Carrying done/cursor/walk
 * over would declare every settled path still good, and the one file that changed would never be
 * fetched again. A hash change therefore re-walks from the top; the shell verifies each cached file
 * against data/asset-digests.json (adopting the previous namespace only when that table exists and
 * matches the hash) and re-fetches just the mismatches, so the re-walk stays cheap without trusting
 * stale bytes. The owed paths travel in `failed`; if MORE than the cap is owed the cursor is pulled
 * back to the first spilled failure and that tail is re-walked next session, so an owed path can
 * never be forgotten. A re-walked success is a cache hit (the interceptor answers it from filesDir,
 * no network). A run killed mid-flight loses at most the in-flight window: the cursor only advances
 * over entries that actually settled.
 *
 * CACHE: every fetch uses {cache:'no-store'} (audit 2026-10-09 phase 4, D5). The shell answers every
 * /assets/** from filesDir, so bypassing the WebView's HTTP cache costs one local read and no
 * network -- and it is the only way a hot-updated asset is actually picked up. With force-cache the
 * WebView replays its own copy; historically that also replayed the cached 404 of a failed attempt
 * (the 2026-10-08 sim: a reload re-walked the tail, replayed 5553 cached 404s and made zero progress
 * until the retry bypassed the cache).
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
 *                            window.__SP_ART_NO_AUTO is set)
 *   cancel()                 stop immediately; in-flight requests finish, no new ones start, no
 *                            error; the control stays on the page (owner rule 2026-10-09)
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
 * UI (owner rule 2026-10-09: the chip shrinks to a PERSISTENT arrow on skip, and is the only home
 * overlay left): a single fixed bottom-right floating chip, built with its own DOM and inline styles
 * only (no dependency on any stylesheet). Its "skip" button no longer stops the walk and no longer
 * removes the control -- it SHRINKS the chip to a bare left arrow (\u25C0 plus a tiny percent). That
 * arrow is PERSISTENT: a finished / cancelled / failed walk leaves it in place, and the collapsed
 * form is remembered for the session (sessionStorage) so a reload paints the arrow again. It is
 * hidden only while a match / briefing screen is up or the document is hidden -- the same MATCH_MARKS
 * / pageBusy() probe the walk stands down on -- and comes back once the page is free again. Clicking
 * the arrow expands the full chip; clicking the full chip's label still opens the preload panel on
 * demand. The label carries the live speed (owner ask 2026-10-09): "art 5415/10643 / 1.2 MB/s /
 * 4m12s" (files/s and no ETA-limit when the responses carry no Content-Length), repainted on a
 * 500 ms heartbeat (requestAnimationFrame; a hidden page and a sandbox without rAF cost nothing) so
 * a rate never freezes at its last settlement.
 *
 * Contract: ES5, pure ASCII, no third-party dependency, idempotent (loading it twice is a no-op).
 */
(function () {
  if (window.__SP_ART) return;

  var CONCURRENCY = 2;          // INITIAL window; grows to MAX_WINDOW while the link is healthy
  var MAX_WINDOW = 4;           // idle-expansion ceiling == the shell's prefetch slot allowance
                                // (MainActivity.ART_PREFETCH_MAX_PARALLEL); raising one without the
                                // other just makes the extra fetches wait 300 ms and fail
  var MIN_WINDOW = 1;           // backpressure floor
  var RECOVER_STREAK = 8;       // consecutive successes before the window grows back by one
  var GAP_MS = 120;             // minimum spacing between dispatches (do not arrive as a burst)
  var PAGE_POLL_MS = 400;       // how often the page-busy probe may re-run (see pageBusy)
  var PACK_POLL_MS = 3000;      // how often the art-PACK-channel probe may re-run (see packBusyNow)
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
  var SS_MIN_KEY = 'sp.art.min.v1'; // '1' once the chip was collapsed to the arrow in this session
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
  // Owner rule 2026-10-10: the collapsed chip is a bare, draggable arrow. Its geometry and its
  // remembered position live here (localStorage key + the box kept inside the viewport).
  var ARROW_POS_KEY = 'sp.art.arrow.pos'; // localStorage: {x, y} top-left of the dragged arrow
  var ARROW_MARGIN = 6;         // px kept between the arrow and every viewport edge
  var ARROW_SLOP = 6;           // px of movement before a press counts as a drag, not a tap
  var ARROW_SIZE = 22;          // nominal arrow box used to keep it inside the viewport
  var ARROW_DEFAULT_RIGHT = 10; // first-paint offset from the right edge (the old chip's corner)
  var ARROW_DEFAULT_BOTTOM = 54;// first-paint offset from the bottom (clears the title footer)
  var ARROW_FONT = '16px';      // small + light: the arrow must not cover the game UI
  var ARROW_COLOR = 'rgba(255,255,255,0.55)'; // low-distraction translucent light

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
  var packBusyAt = -1e15;       // last pack-channel probe time (throttled)
  var packBusy = 0;             // last probe result (the shell's art-PACK channel is installing)
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

  /**
   * The shell's cross-origin record store (audit 2026-10-09, addition A), or null when the host has
   * none (a plain web origin, or an APK older than the bridge). localStorage is scoped PER ORIGIN,
   * and the page's origin IS the connected game server -- so switching servers used to hide the
   * record and re-walk all ~7969 entries from zero. The shell keeps the same JSON under filesDir
   * (like player-data's spData), so the walk survives a server switch.
   */
  function shellStore() {
    try {
      var s = window.__SP_SHELL;
      if (s && s.artWalkBridge === true
          && typeof s.artWalkGet === 'function' && typeof s.artWalkPut === 'function') return s;
    } catch (e) { /* no shell: fall back to localStorage */ }
    return null;
  }

  /** Reserved document keys (the last-namespace pointer). Manifest hashes are 12 hex chars, so an
   *  '@' prefix can never collide with one. */
  var LS_LAST_IN_DOC = '@last';

  function isReservedKey(k) {
    return typeof k === 'string' && k.charAt(0) === '@';
  }

  function readAll() {
    var sh = shellStore();
    if (sh) {
      try {
        var sraw = sh.artWalkGet();
        var sdoc = sraw ? JSON.parse(sraw) : null;
        if (sdoc && typeof sdoc === 'object') return sdoc;
      } catch (e) { /* fall through to localStorage */ }
    }
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
    var text;
    try { text = JSON.stringify(doc); } catch (e) { return false; }
    var ok = false;
    var sh = shellStore();
    if (sh) {
      try { ok = sh.artWalkPut(text) === true; } catch (e) { ok = false; }
    }
    var ls = store();
    if (ls && !savePaused) {
      try { ls.setItem(LS_KEY, text); ok = true; } catch (e) { savePaused = true; } // quota: stop trying
    }
    return ok;
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

  /**
   * True while the shell's art-PACK channel is installing (ShellBridge.artSyncStatus().active).
   *
   * Owner 2026-10-09: the packs are the fast lane -- 23 size-capped zips, multi-connection download
   * plus local unpack, versus 10643 small requests. So the file walk STANDS DOWN while a pack
   * install is in flight (the packs land, then the walk finds their entries locally and skips them).
   * Probed at most every PACK_POLL_MS: it is a synchronous bridge call, not a free read. A missing
   * bridge, a malformed reply or any throw is simply "not busy" -- the walk must never stall because
   * of a diagnostic channel.
   */
  function packBusyNow() {
    var t = now();
    if (t - packBusyAt < PACK_POLL_MS) return packBusy;
    packBusyAt = t;
    packBusy = 0;
    try {
      var s = window.__SP_SHELL;
      if (s && s.artSyncBridge === true && typeof s.artSyncStatus === 'function') {
        var raw = s.artSyncStatus();
        var o = raw ? JSON.parse(raw) : null;
        if (o && o.ok !== false && o.active === true) packBusy = 1;
      }
    } catch (e) { /* no bridge / bad json: not busy */ }
    return packBusy;
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
      paused: paused, minimized: collapsed, gapMs: GAP_MS, carriedHash: carriedHash,
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
    var sh = shellStore();
    var ls = store();
    if (!sh && (!ls || savePaused)) return; // no usable store at all
    var doc = readAll() || {};
    doc[ns()] = {
      hash: hash, fp: fp, total: total, done: done, idle: total - walk,
      cursor: writeCursor(), walk: walk,
      failed: failedKeys.slice(0, MAX_FAILED), failedTotal: failedTotal,
      t: now(),
    };
    // The last-namespace pointer rides the document itself, so it is cross-origin too (the
    // localStorage mirror below is only for hosts without the shell bridge).
    doc[LS_LAST_IN_DOC] = ns();
    // Keep the newest few namespaces only: a hot update changes the manifest hash and an unbounded
    // map would slowly eat the origin quota. Reserved keys are never trimmed.
    var keys = [];
    for (var k in doc) {
      if (Object.prototype.hasOwnProperty.call(doc, k) && !isReservedKey(k)) keys.push(k);
    }
    if (keys.length > MAX_RECORDS) {
      keys.sort(function (a, b) { return ((doc[b] && doc[b].t) || 0) - ((doc[a] && doc[a].t) || 0); });
      for (var i = MAX_RECORDS; i < keys.length; i++) delete doc[keys[i]];
    }
    if (writeAll(doc) && ls) {
      try { ls.setItem(LS_LAST_KEY, ns()); } catch (e) { /* ignore */ }
    }
  }

  function recordFor(namespace) {
    var doc = readAll();
    if (!doc || !namespace) return null;
    var rec = doc[namespace];
    return rec && typeof rec === 'object' ? rec : null;
  }

  /**
   * The stored record for the manifest at hand. It is trusted ONLY when the namespace matches too
   * (same `hash`) AND it describes the SAME asset set (fingerprint + total).
   *
   * Audit 2026-10-09 phase 1: the old code carried the previous record over whenever the hash
   * changed but the path list stayed identical (keeping done/cursor/walk and dropping the owed
   * list). The manifest hash is a byte-sensitive CONTENT hash (tools/apk/transcode-assets.mjs
   * hashReferencedBytes), so a hash change means some bytes changed -- and the device cannot tell
   * WHICH file moved. Carrying the cursor declares every settled path still good, so the one file
   * that changed would never be fetched again. Now nothing carries: a hash change re-walks, and the
   * shell verifies each cached file against data/asset-digests.json (re-fetching only the
   * mismatches), so the re-walk stays cheap without trusting stale bytes.
   */
  function matchingRecord() {
    var rec = recordFor(ns());
    if (rec && rec.hash === hash && rec.fp === fp && rec.total === total) return rec;
    return null;
  }

  /** The most recent record, whatever its hash: used for the very first paint of a reload (the
   *  manifest has not been read yet, so the hash cannot be known). Re-validated once it lands.
   *  The pointer is read from the document (cross-origin via the shell bridge) and only then from
   *  localStorage, so a server switch still shows the carried numbers on the first frame. */
  function preload() {
    var doc = readAll();
    if (!doc) return null;
    var last = '';
    try {
      last = typeof doc[LS_LAST_IN_DOC] === 'string' ? doc[LS_LAST_IN_DOC] : '';
    } catch (e) { last = ''; }
    if (!last) {
      var ls = store();
      if (ls && !savePaused) {
        try { last = ls.getItem(LS_LAST_KEY) || ''; } catch (e) { last = ''; }
      }
    }
    if (!last) return null;
    var rec = doc[last];
    return rec && typeof rec === 'object' ? rec : null;
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

  /** Owner rule 2026-10-09: "skip" only shrinks the chip, so what is remembered for the session is
   *  the COLLAPSED form -- a reload paints the arrow again (and still auto-starts the walk). */
  function collapsedThisSession() {
    var ss = sess();
    if (!ss) return false;
    try { return ss.getItem(SS_MIN_KEY) === '1'; } catch (e) { return false; }
  }

  function rememberCollapsed() {
    var ss = sess();
    if (!ss) return;
    try { ss.setItem(SS_MIN_KEY, '1'); } catch (e) { /* ignore */ }
  }

  function forgetCollapsed() {
    var ss = sess();
    if (!ss) return;
    try { ss.removeItem(SS_MIN_KEY); } catch (e) { /* ignore */ }
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
      // Audit 2026-10-09 phase 5: a healthy link may grow the window past the initial 2 (up to the
      // shell's allowance). Failures still narrow it in settle(), and a match screen still pauses
      // the walk outright, so the page keeps its priority.
      if (limit < MAX_WINDOW) limit++;
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

  /**
   * True when the shell answered with its placeholder marker (ArtCdn.PLACEHOLDER_HEADER). The
   * placeholder is deliberately a 200 (an <img> must not cascade broken-image errors), so this
   * header is the ONLY way to tell "the real bytes" from "a transparent 1x1 stand-in".
   */
  function placeholderMark(res) {
    try {
      if (!res || !res.headers || typeof res.headers.get !== 'function') return false;
      var v = res.headers.get('x-sp-art-placeholder');
      return !!v && v !== '0';
    } catch (e) { return false; }
  }

  /**
   * ONE table, two languages: this must stay value-for-value identical to the native
   * ArtCdn.isTransientStatus / ArtCdn.isPermanentMiss (audit 2026-10-09 D3). 408/425/429/5xx and
   * an unparseable status are TRANSIENT (retry); only 404/410 is a definitive miss. Any other 4xx is
   * dead FOR THIS SESSION (no hammering) -- but that is not a claim of permanence: the shell only
   * remembers 404/410. If the two layers disagreed, the page would keep retrying while the shell
   * answered "this does not exist" for ten minutes, and the missing art would be swallowed.
   */
  function classify(res) {
    if (res && res.ok) {
      // A marked 200 is the shell's placeholder, not the asset (audit 2026-10-09 D2). Counting it as
      // a settlement would report a missing asset as preloaded AND drop it from the owed list.
      return placeholderMark(res) ? 'retry' : 'ok';
    }
    var code = res && typeof res.status === 'number' ? res.status : 0;
    if (code === 0 || code === 408 || code === 425 || code === 429 || code >= 500) return 'retry';
    if (code === 404 || code === 410) return 'dead'; // a definitive miss (the shell remembers these)
    if (code >= 400) return 'dead';                  // 401/403/...: back off, do not re-ask this session
    return 'retry';
  }

  /**
   * A 429's Retry-After (delta-seconds or an HTTP-date) in ms, clamped to [1 s, 60 s]; 0 when absent
   * or unparseable. A rate-limited CDN is telling us exactly how long to wait -- ignoring it and
   * hammering with our own 0.5/1/2 s ladder is what turns a throttle into a wall of failures. The
   * 60 s ceiling keeps a hostile or mistaken header from pinning the whole preload down.
   */
  function retryAfterMs(res) {
    try {
      if (!res || !res.headers || typeof res.headers.get !== 'function') return 0;
      var v = res.headers.get('retry-after');
      if (!v) return 0;
      var s = String(v).replace(/^\s+|\s+$/g, '');
      var secs = 0;
      if (/^[0-9]+$/.test(s)) {
        secs = parseInt(s, 10);
      } else {
        var t = Date.parse(s);
        if (isNaN(t)) return 0;
        secs = Math.round((t - now()) / 1000);
      }
      if (!(secs > 0)) return 0;
      var ms = secs * 1000;
      if (ms < 1000) ms = 1000;
      if (ms > 60000) ms = 60000;
      return ms;
    } catch (e) { return 0; }
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
      // Audit 2026-10-09 phase 4 (D5): ALWAYS no-store. The shell answers every /assets/** from
      // filesDir itself (local tree -> pack -> fetched cache), so bypassing the WebView's HTTP cache
      // costs one local read and no network -- while "force-cache" would make the WebView replay a
      // pre-hot-update copy for the whole max-age window.
      var init = { cache: 'no-store' };
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
        // A throttle's own Retry-After wins over our backoff ladder (see retryAfterMs).
        if (verdict === 'retry' && r && r.status === 429) {
          var wait = retryAfterMs(r);
          if (wait > 0 && now() + wait > penaltyUntil) penaltyUntil = now() + wait;
        }
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
        // (a) the page owns the screen -> no dispatch at all, not even a cached look-up (H3).
        //     The art-PACK channel is the fast lane (owner 2026-10-09): while it is installing the
        //     walk yields to it too, so the two never split the phone's link.
        if (pageBusy() || packBusyNow()) {
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
    emit(); // the control STAYS (owner rule 2026-10-09): no hideSoon/removeUI any more
  }

  function failAll() {
    if (cancelled || state !== 'running') return;
    state = 'failed';
    paused = 0;
    if (pauseTimer) { try { clearTimeout(pauseTimer); } catch (e) { /* ignore */ } pauseTimer = null; }
    save();
    emit(); // the control STAYS (owner rule 2026-10-09): the arrow is the only home overlay
  }

  function loadManifest() {
    manifestPending = true;
    // Audit 2026-10-09 phase 4 (D5): no-store, not force-cache. The manifest is hot-updatable, so a
    // forced cache hit would walk the PREVIOUS asset list (and the previous hash) after an update.
    var pr = fetch(MANIFEST, { cache: 'no-store' });
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
    save();
    emit(); // the control stays mounted (owner rule 2026-10-09): cancel() no longer removes it
  }

  function onProgress(cb) {
    if (typeof cb !== 'function') return;
    callbacks.push(cb);
    try { cb(snapshot()); } catch (e) { /* ignore */ }
  }

  // ---- minimal corner UI (own DOM, inline styles, no stylesheet dependency) --

  var ui = null, uiText = null, uiFill = null, uiSkip = null, uiBar = null;
  var collapsed = 0; // 0 = the full chip, 1 = the bare left arrow (owner rule 2026-10-09)
  var arrowPos = null;          // {x, y} top-left of the arrow; null = the default corner
  var arrowPosRead = 0;         // 1 once localStorage was consulted this load
  var dragActive = 0;           // 1 while the arrow is pressed
  var dragMoved = 0;            // 1 once the press passed ARROW_SLOP (a drag, not a tap)
  var dragStartX = 0, dragStartY = 0;   // pointer position at press
  var dragOriginX = 0, dragOriginY = 0; // arrow top-left at press
  var suppressClick = 0;        // 1 after a drag so the following click does not expand

  // ---- the collapsed arrow: geometry, drag, remembered position (owner rule 2026-10-10) ----

  /** Viewport width, 0 when there is no layout to measure (a sandbox, or before first layout): a
   *  missing innerWidth must never throw, it only means "nothing to clamp against yet". */
  function viewW() {
    try {
      if (typeof window !== 'undefined' && typeof window.innerWidth === 'number'
          && isFinite(window.innerWidth) && window.innerWidth > 0) return window.innerWidth;
    } catch (e) { /* no window: skip */ }
    return 0;
  }

  function viewH() {
    try {
      if (typeof window !== 'undefined' && typeof window.innerHeight === 'number'
          && isFinite(window.innerHeight) && window.innerHeight > 0) return window.innerHeight;
    } catch (e) { /* no window: skip */ }
    return 0;
  }

  /** Keeps the arrow box inside the viewport with ARROW_MARGIN to spare on every side. With no
   *  measurable viewport the coordinates pass through unchanged (never a blind clamp). */
  function clampArrow(x, y) {
    var w = viewW();
    var h = viewH();
    if (w > 0) {
      var maxX = w - ARROW_SIZE - ARROW_MARGIN;
      if (maxX < ARROW_MARGIN) maxX = ARROW_MARGIN;
      if (x < ARROW_MARGIN) x = ARROW_MARGIN;
      else if (x > maxX) x = maxX;
    }
    if (h > 0) {
      var maxY = h - ARROW_SIZE - ARROW_MARGIN;
      if (maxY < ARROW_MARGIN) maxY = ARROW_MARGIN;
      if (y < ARROW_MARGIN) y = ARROW_MARGIN;
      else if (y > maxY) y = maxY;
    }
    return { x: x, y: y };
  }

  /** The remembered arrow position, or null for anything unusable (absent, not JSON, not a pair of
   *  finite numbers). A null / corrupt value means the DEFAULT corner -- never an error. */
  function readArrowPos() {
    var ls = store();
    if (!ls) return null;
    try {
      var raw = ls.getItem(ARROW_POS_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return null;
      var x = o.x, y = o.y;
      if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return null;
      return { x: x, y: y };
    } catch (e) {
      return null;
    }
  }

  function writeArrowPos(x, y) {
    var ls = store();
    if (!ls) return;
    try { ls.setItem(ARROW_POS_KEY, JSON.stringify({ x: x, y: y })); } catch (e) { /* quota: ignore */ }
  }

  /** Places the collapsed arrow: the remembered spot, else the default corner, clamped to the
   *  viewport. With no viewport to measure the CSS corner (right/bottom) is left alone. */
  function placeArrow() {
    if (!ui) return;
    var w = viewW(), h = viewH();
    var pos = arrowPos;
    if (!pos && w > 0 && h > 0) {
      pos = { x: w - ARROW_SIZE - ARROW_DEFAULT_RIGHT, y: h - ARROW_SIZE - ARROW_DEFAULT_BOTTOM };
    }
    if (!pos) return;
    pos = clampArrow(pos.x, pos.y);
    arrowPos = pos;
    var s = ui.style;
    s.left = pos.x + 'px';
    s.top = pos.y + 'px';
    s.right = '';
    s.bottom = '';
  }

  /** Restores the expanded chip's CSS corner (the arrow's dragged left/top are cleared). */
  function placeChip() {
    if (!ui) return;
    var s = ui.style;
    s.left = '';
    s.top = '';
    s.right = '10px';
    s.bottom = '3.4rem';
  }

  /** The expanded chip chrome: the dark progress box (unchanged from the pre-2026-10-10 look). */
  function chipChrome() {
    if (!ui) return;
    var s = ui.style;
    s.background = 'rgba(12,15,14,0.82)';
    s.color = '#8A9A93';
    s.font = '11px/1.4 -apple-system,Segoe UI,Roboto,sans-serif';
    s.padding = '6px 8px';
    s.borderRadius = '6px';
    s.maxWidth = '46vw';
    s.boxShadow = '0 1px 4px rgba(0,0,0,0.4)';
    if (uiText) { uiText.style.fontSize = ''; uiText.style.lineHeight = ''; uiText.style.touchAction = ''; }
  }

  /** The collapsed arrow chrome: a bare, small, light glyph -- NO chip box at all. touch-action:none
   *  makes it a clean drag handle (the page never scrolls under the finger); it is set on the arrow
   *  element alone, so no other gesture on the page is affected. */
  function arrowChrome() {
    if (!ui) return;
    var s = ui.style;
    s.background = '';
    s.border = '';
    s.borderRadius = '';
    s.boxShadow = '';
    s.padding = '';
    s.maxWidth = '';
    s.color = ARROW_COLOR;
    s.font = ARROW_FONT + '/1 -apple-system,Segoe UI,Roboto,sans-serif';
    if (uiText) {
      uiText.style.fontSize = ARROW_FONT;
      uiText.style.lineHeight = '1';
      uiText.style.touchAction = 'none';
    }
    placeArrow();
  }

  /** Press start (collapsed only). Remembers where the finger and the arrow were, so every move is
   *  an offset from the press and the arrow follows exactly under the finger. */
  function dragBegin(px, py) {
    if (!collapsed) return;
    suppressClick = 0; // a fresh gesture: the previous drag's click guard is spent
    dragActive = 1;
    dragMoved = 0;
    dragStartX = px;
    dragStartY = py;
    var o = arrowPos || { x: 0, y: 0 };
    dragOriginX = o.x;
    dragOriginY = o.y;
  }

  /** Move: returns 1 once the press has become a drag (movement past ARROW_SLOP), 0 while it is
   *  still a possible tap. A drag moves + clamps the arrow and remembers the spot. */
  function dragUpdate(px, py) {
    if (!dragActive) return 0;
    var dx = px - dragStartX;
    var dy = py - dragStartY;
    if (!dragMoved) {
      if (dx * dx + dy * dy < ARROW_SLOP * ARROW_SLOP) return 0;
      dragMoved = 1;
    }
    var c = clampArrow(dragOriginX + dx, dragOriginY + dy);
    arrowPos = c;
    if (ui) {
      var s = ui.style;
      s.left = c.x + 'px';
      s.top = c.y + 'px';
      s.right = '';
      s.bottom = '';
    }
    return 1;
  }

  /** Release: a real drag persists the position and arms the click guard; a tap does neither (its
   *  click still reaches onclick and expands). */
  function dragFinish() {
    if (!dragActive) return;
    var moved = dragMoved;
    dragActive = 0;
    dragMoved = 0;
    if (moved) {
      suppressClick = 1;
      if (arrowPos) writeArrowPos(arrowPos.x, arrowPos.y);
    }
  }

  // A live rate needs its own repaint cadence: settlements arrive in bursts, and a stall would leave
  // a stale number on screen. The heartbeat rides the page's animation frame (available in the
  // WebView; absent on a plain sandbox/old WebView, where paints then happen on settle only) and is
  // throttled to UI_TICK_MS, so the cost is one no-op check per frame. It now runs for as long as the
  // control is mounted (the chip never removes itself any more), which is also how the arrow notices
  // a match screen going away while no walk is on.
  function startTick() {
    if (uiTick || !ui) return;
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;
    try { uiTick = window.requestAnimationFrame(paintTick); } catch (e) { uiTick = 0; }
  }

  function paintTick(stamp) {
    uiTick = 0;
    if (!ui) return; // the control is gone (it normally never is): the chain ends here
    var t = typeof stamp === 'number' ? stamp : now();
    if (t - uiLastPaint >= UI_TICK_MS) { uiLastPaint = t; updateUI(); }
    startTick();
  }

  /** Owner rule 2026-10-09: "skip" SHRINKS the chip to the bare arrow; it never stops the walk. */
  function collapseUI() {
    collapsed = 1;
    rememberCollapsed();
    updateUI();
  }

  function expandUI() {
    collapsed = 0;
    forgetCollapsed();
    updateUI();
  }

  function showUI() {
    if (typeof document === 'undefined' || !document.body || ui) return;
    try {
      ui = document.createElement('div');
      ui.setAttribute('data-sp-art', '1');
      var s = ui.style;
      // The container only positions the control and stays pointer-events:none: it must never eat a
      // tap meant for the page (the title screen's update button sits in this corner). The chip /
      // arrow CHROME (background, border, padding, font) is applied per form in chipChrome/arrowChrome.
      s.position = 'fixed'; s.right = '10px'; s.bottom = '3.4rem'; s.zIndex = '2147483647';
      s.pointerEvents = 'none';

      // The collapsed form is remembered for the session: a reload paints the arrow, not the chip.
      collapsed = collapsedThisSession() ? 1 : 0;
      // Read the remembered arrow position once (null / corrupt -> the default corner, never a throw).
      if (!arrowPosRead) { arrowPos = readArrowPos(); arrowPosRead = 1; }

      uiText = document.createElement('span');
      uiText.textContent = 'art 0/0';
      // 2026-10-08 (owner): this chip IS the preload UI -- the only always-visible progress display.
      // Its label opens the preload panel on demand (profiles / verify / clear); in the collapsed
      // form the SAME element is the arrow and expands the chip instead. Read lazily: this module
      // loads before preload-center.js, so window.__SP_PRELOAD does not exist yet here. Only this
      // element is clickable -- the chip itself stays pointer-events:none so it never blocks a
      // control underneath (it sits just above the title screen's update-check button).
      uiText.style.pointerEvents = 'auto';
      uiText.style.cursor = 'pointer';
      uiText.onclick = function () {
        if (collapsed) {
          // Owner rule 2026-10-10: a DRAG must not expand. dragFinish() arms suppressClick when the
          // press moved past the threshold; this click (the one a drag always ends with) is swallowed.
          if (suppressClick) { suppressClick = 0; return; }
          expandUI();
          return;
        }
        try {
          var pc = window.__SP_PRELOAD;
          if (pc && typeof pc.open === 'function') pc.open();
        } catch (e) { /* panel is optional */ }
      };

      // ---- the collapsed arrow is a draggable floating window (owner rule 2026-10-10) ----
      // Pointer events are primary; the touch handlers are the old-WebView fallback. Both are attached
      // on purpose (a touch device that fires both is harmless: each handler is idempotent), and a
      // press NEVER expands -- only a tap (no movement past ARROW_SLOP) does, through the click above.
      // preventDefault fires only once a drag is under way and only on the arrow's own move event, so
      // the page's other gestures (scroll, pinch) are untouched.
      uiText.onpointerdown = function (e) {
        if (!collapsed || !e) return;
        if (typeof e.button === 'number' && e.button !== 0) return; // left / primary only
        dragBegin(e.clientX, e.clientY);
        try {
          if (e.pointerId != null && typeof uiText.setPointerCapture === 'function') {
            uiText.setPointerCapture(e.pointerId); // keep the moves even if the finger leaves the arrow
          }
        } catch (er) { /* capture is best effort */ }
      };
      uiText.onpointermove = function (e) {
        if (!dragActive || !e) return;
        if (dragUpdate(e.clientX, e.clientY) && typeof e.preventDefault === 'function') e.preventDefault();
      };
      uiText.onpointerup = function () { dragFinish(); };
      uiText.onpointercancel = function () { dragFinish(); };
      uiText.ontouchstart = function (e) {
        if (!collapsed || !e || !e.touches || !e.touches.length) return;
        dragBegin(e.touches[0].clientX, e.touches[0].clientY);
      };
      uiText.ontouchmove = function (e) {
        if (!dragActive || !e || !e.touches || !e.touches.length) return;
        if (dragUpdate(e.touches[0].clientX, e.touches[0].clientY) && typeof e.preventDefault === 'function') e.preventDefault();
      };
      uiText.ontouchend = function () { dragFinish(); };
      uiText.ontouchcancel = function () { dragFinish(); };

      uiSkip = document.createElement('button');
      uiSkip.textContent = 'skip';
      var ss = uiSkip.style;
      ss.marginLeft = '8px'; ss.font = 'inherit'; ss.color = '#4ED8AF';
      ss.background = 'transparent'; ss.border = '1px solid #2f5a4d';
      ss.borderRadius = '4px'; ss.padding = '1px 6px'; ss.cursor = 'pointer';
      ss.pointerEvents = 'auto'; // the chip is none; only skip needs to be clickable
      uiSkip.onclick = function () { collapseUI(); }; // owner 2026-10-09: shrink, do not stop

      uiBar = document.createElement('div');
      var bs = uiBar.style;
      bs.height = '3px'; bs.marginTop = '4px'; bs.background = 'rgba(255,255,255,0.12)';
      bs.borderRadius = '2px'; bs.overflow = 'hidden';
      uiFill = document.createElement('div');
      var fs = uiFill.style;
      fs.height = '3px'; fs.width = '0%'; fs.background = '#4ED8AF';
      uiBar.appendChild(uiFill);

      ui.appendChild(uiText);
      ui.appendChild(uiSkip);
      ui.appendChild(uiBar);
      document.body.appendChild(ui);
      updateUI();
      startTick(); // the rate keeps moving even between settlements
    } catch (e) { ui = null; uiText = null; uiFill = null; uiSkip = null; uiBar = null; }
  }

  function updateUI() {
    if (!ui || !uiText || !uiFill) return;
    try {
      if (collapsed) {
        // Owner rule 2026-10-10: the collapsed form is the ARROW ALONE -- no percent text, no chip
        // background / border / radius / shadow / padding (arrowChrome strips them). The count still
        // rides the tooltip, so the progress stays one press away without a number on screen.
        uiText.textContent = '\u25C0';
        uiText.title = 'art ' + done + '/' + total + ' \u00B7 \u70B9\u51FB\u5C55\u5F00';
        arrowChrome();
        if (uiSkip) uiSkip.style.display = 'none';
        if (uiBar) uiBar.style.display = 'none';
      } else {
        chipChrome();
        placeChip();
        uiText.textContent = 'art ' + done + '/' + total + rateText()
          + (failedCount ? ' (' + failedCount + ' failed)' : '')
          + (paused ? ' (paused)' : ''); // standing down for a match screen: visible, not silent
        uiText.title = '\u9884\u8F7D\u8FDB\u5EA6 \u00B7 \u70B9\u51FB\u7BA1\u7406';
        if (uiSkip) uiSkip.style.display = '';
        if (uiBar) uiBar.style.display = '';
        uiFill.style.width = (total ? Math.floor(done * 100 / total) : 0) + '%';
      }
      // Owner rule 2026-10-09: the arrow is global EXCEPT in a match / briefing screen or a hidden
      // document -- the same MATCH_MARKS / pageBusy() probe the walk itself stands down on. The walk
      // is NOT stopped here; that stand-down stays pageBusy()/packBusyNow()'s job in pump().
      ui.style.display = pageBusy() === 1 ? 'none' : '';
    } catch (e) { /* ignore */ }
    startTick(); // a paint (re)arms the heartbeat
  }

  // Persist when the page really leaves (a killed WebView never runs this -- the SAVE_EVERY
  // throttle and the cursor's settle-only advance are what cover that case).
  try {
    if (typeof window.addEventListener === 'function') {
      var flush = function () { try { save(); } catch (e) { /* ignore */ } };
      window.addEventListener('pagehide', flush, false);
      // A resized window may leave the dragged arrow outside the visible area: re-clamp on the spot.
      window.addEventListener('resize', function () { if (collapsed) updateUI(); }, false);
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        // Repaint on a visibility flip too: the arrow hides/shows with the page (owner rule 2026-10-09)
        document.addEventListener('visibilitychange', function () { flush(); updateUI(); }, false);
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
  // tests) that want manual control set window.__SP_ART_NO_AUTO = 1 before loading this file. A
  // collapse pressed earlier in this session does NOT suppress this: "skip" only shrinks the chip,
  // it never stops the walk (owner rule 2026-10-09).
  try {
    if (!window.__SP_ART_NO_AUTO && typeof setTimeout === 'function') {
      setTimeout(function () {
        try { start(); } catch (e) { /* silent */ }
      }, 0);
    }
  } catch (e) { /* silent */ }
})();
