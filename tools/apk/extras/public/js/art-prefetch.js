/* global window, document, MutationObserver */ // browser globals: this overlay ships inside the tools tree (the ESLint node preset covers it), so the DOM globals are declared here (localStorage/sessionStorage/AbortController are already built-in globals there and must not be re-declared)
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
 *   onProgress(cb)           cb({state,done,total,pct,failed,pending,localFiles,resumed,bytes,
 *                            bytesKnown,bps,avgBps,filesPerSec,avgFilesPerSec,etaMs,elapsedMs}) now and on
 *                            every change; pending = total - done, localFiles = settled entries the
 *                            device served itself (local coverage), never a fetch. The rates are this
 *                            session's own (owner ask 2026-10-09): bytes off the Content-Length of the
 *                            ok settlements, files/s off the settlement count, etaMs off files/s --
 *                            bytesKnown=false means the responses carried no size, so bps is left 0
 *                            and the display must fall back to files/s instead of faking a byte rate
 *   state()                  diagnostic object (state, done, total, pct, failed, pending, localFiles,
 *                            hash, fp, resumed, window, attempts, backoffMs, paused, gapMs,
 *                            carriedHash, stored, saved, bytes, bytesKnown, bps, avgBps, filesPerSec,
 *                            avgFilesPerSec, etaMs, elapsedMs, rateWindowMs, startDone) for on-device triage
 *   failed()                 capped copy of the failed path list -- what to check against the CDN
 *   snapshot()               JSON-safe alias of state()
 *
 * UI (owner 2026-10-11: "the floating window's art N/M becomes a FUNCTION" and "tapping the floating
 * window's first screen opens the function list"): the control is ONE persistent floating BUTTON
 * whose whole wording is the word for "functions". It carries NO number and NO progress bar -- the
 * preload figures live in the floating window's first screen, the function-list panel
 * (ui/preloadPanel.js, kind 'preload'), which is what opens by default at boot. Tapping the button
 * opens that panel on demand (the module looks window.__SP_PRELOAD up at CLICK time --
 * preload-center.js loads after this one -- and falls back to __SP_SHELL.openPanel, staying silent
 * when neither exists). The old two-form machinery (the "art N/M" chip <-> the "skip" toggle, the
 * per-form chrome, the cross-form geometry pass, the session-remembered collapsed form) is GONE:
 * there is no skip, no collapse / expand and no second element.
 *
 * What stays: the control is DRAGGABLE while the resources load (pointer events primary, the touch
 * handlers as the old-WebView fallback, one drag state machine, the remembered spot in
 * localStorage sp.art.arrow.pos, clamped inside the viewport with a small slop between a drag and a
 * tap -- a drag never opens the panel); it is hidden only while a match / briefing screen is up or
 * the document is hidden (the same MATCH_MARKS / pageBusy() probe the walk stands down on) and comes
 * back once the page is free again; and it is repainted on a 500 ms heartbeat
 * (requestAnimationFrame; a hidden page and a sandbox without rAF cost nothing).
 *
 * AUTO-START (owner 2026-10-11: "resources are NOT globally preloaded by default"; "the preload
 * block sits at the very bottom [of the function list] with a progress bar and ONE button to start /
 * stop it"): the walk no longer starts itself. The first frame draws the button only; the user starts
 * the preload from the panel. window.__SP_ART_NO_AUTO keeps its old meaning (never auto-start) for
 * hosts and tests.
 *
 * LAYER (owner 2026-10-10: the floating window must be topmost; the audit found the windows were
 * ordered by DOM insertion): the chip is the TOPMOST window of the overlay. Its number comes from the
 * one scale in
 * ui/shellPanels.js (SP_LAYERS: notice < host < modal < toast < chip) and is pinned equal to
 * SP_LAYERS.chip by tools/apk/art-prefetch.test.mjs. The button is the only clickable element and it
 * is small, so being on top never eats a tap meant for the page.
 *
 * ANTI-HOT-RELOAD (owner 2026-10-10: a hot reload must not leave the window unusable): the control
 * is mounted on documentElement (preferred over body, which a SPA re-render / content hot swap
 * replaces wholesale)
 * and a drop detector re-attaches the SAME node when the page removes it -- a MutationObserver on
 * documentElement's own child list (zero idle cost: it fires only when head/body/the control itself
 * are added or removed; no rAF spinning) with a low-frequency setInterval fallback for a host without
 * MutationObserver. Re-attaching is idempotent: the node is never rebuilt, so the dragged spot and
 * the walk progress survive the drop.
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
  // PACING (owner 2026-10-11: "download speed ... is very slow"). The old rule was a fixed GAP_MS=120 between
  // dispatches -- at most ~8.3 files/s no matter how fast the responses came back, i.e. >=21 min for
  // the 10643-ref walk even when every one of them was a LOCAL cache hit (the field measured 28m40s,
  // which is this constant, not the link -- tools/apk/make-bundle.mjs:109 records that ETA).
  // The pace is now derived from what the link is actually doing: keep the window full by dispatching
  // at the rate requests settle (settleEwma / window), never faster than MIN_GAP_MS (a burst of
  // `window` immediate dispatches is exactly the concurrency we want, no more) and never slower than
  // GAP_MS (the old conservative rate, kept as the ceiling for a strained/slow link and used outright
  // while a penalty or a failure backoff is up). The page's priority is untouched: the shell still
  // serves the page's own fetches first (X-SP-Prefetch slot policy) and the walk still stands down
  // entirely on a match screen.
  var MIN_GAP_MS = 8;           // pacing floor: a dispatch may never be closer than this
  var GAP_MS = 120;             // pacing ceiling: the old fixed rate, now only the slow/stressed pace
  var EWMA_ALPHA = 0.25;        // settle-time EWMA weight (8 samples to adapt, tolerant of one spike)
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
  var UI_TICK_MS = 500;         // chip repaint while a run is on (the count must not wait for a settle)
  // 2026-10-11 (owner): the control is ONE draggable floating button, and its whole wording is the
  // word for "functions". The old first/second/third-round "collapsed chip" rules are gone with the
  // two-form design; what remains is the geometry that a single draggable box needs -- a remembered
  // top-left, a slop between drag and tap, and a clamp box.
  var ARROW_POS_KEY = 'sp.art.arrow.pos'; // localStorage: {x, y} top-left of the button
  var ARROW_MARGIN = 6;         // px kept between the control and every viewport edge
  var ARROW_SLOP = 6;           // px of movement before a press counts as a drag, not a tap
  var ARROW_SIZE = 22;          // nominal clamp box when the host cannot measure the button
  var ARROW_DEFAULT_RIGHT = 10; // first-paint offset from the right edge
  var ARROW_DEFAULT_BOTTOM = 54;// nominal first-paint offset from the bottom (clears the title
                                // footer). The live button's CSS corner is `bottom: 3.4rem`, which
                                // scales with the page's root font; this is the NOMINAL model used
                                // only where the host cannot resolve layout (a sandbox).
  // The button's own chrome: small and light so the game UI stays readable, but clearly tappable --
  // a translucent dark box (rgba(12,15,14,...)) with the mint accent #4ED8AF (roughly 10:1 contrast
  // on that box), a visible border, rounded corners and real padding.
  var ARROW_FONT = '12px';      // small + light: the control must not cover the game UI
  var ARROW_COLOR = '#4ED8AF';  // mint on the dark box: clearly visible, still low-distraction
  var ARROW_BG = 'rgba(12,15,14,0.78)'; // translucent dark: legible over any screen, never a solid block
  var ARROW_BORDER = '1px solid rgba(78,216,175,0.55)'; // the visible button outline
  var ARROW_RADIUS = '6px';
  var ARROW_PADDING = '4px 10px';
  // 2026-10-14 (owner: the floating control's look becomes a GEAR -- explicitly NOT a
  // mint/green one, and WITH an outer ring). The word "functions" is gone: the mark is an
  // inline SVG built with createElementNS (this file never parses HTML; its source stays ASCII).
  // Colours are neutral greys on purpose -- the mint accent stays reserved for state, not chrome.
  var ICON_STROKE = '#d8e3de';    // the gear: near-white grey, deliberately NOT the mint accent
  var ICON_RING = '#8a9a93';      // the outer ring: dimmer, so the pair reads as 'gear in a ring'
  var ICON_SIZE = 16;             // px; the control stays small so it never covers the game UI
  var ARROW_PADDING_ICON = '8px'; // square-ish padding: an icon needs no room for glyphs
  // Owner 2026-10-10 (the floating window must be topmost): the chip is the overlay's TOPMOST
  // window. The number is the top of ONE scale -- ui/shellPanels.js SP_LAYERS -- and a gate pins this
  // literal equal to SP_LAYERS.chip (see the layer gate in tools/apk/art-prefetch.test.mjs).
  // 2147483647 is the int32 maximum, so nothing a page can write wins a z-index tie against it.
  var UI_LAYER = 2147483647;
  // Anti-hot-reload drop detector (see the header): the MutationObserver path costs nothing while
  // idle; this cadence is only used by the fallback when the host has no MutationObserver.
  var UI_PROBE_MS = 5000;

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
  var nextDispatchAt = 0;       // pacing gate: at most one dispatch per paceMs() (was a fixed GAP_MS)
  var settleEwma = 0;           // EWMA of settled-request wall time, ms (0 = no sample yet)
  var settleSamples = 0;
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
  var hash = '';                // manifest top-level hash (diagnostics; NOT the namespace any more)
  var setKey = '';              // set-identity key of the enumerated rels (the resume namespace)
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

  /** Persistence namespace. The SET IDENTITY is the requirement (so two servers on the same asset
   *  set share one resume slot); the byte hash is only a fallback for a manifest whose rels cannot be
   *  enumerated, and a manifest without either still gets a slot so the feature never disappears. */
  function ns() {
    return setKey || hash || 'nohash';
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

  // ---- set identity key (owner 2026-10-10 direction A) ----------------------
  // The cache namespace and the resume namespace are the SET of referenced rel paths, not the
  // manifest's byte hash: two servers on the same upstream version enumerate the SAME paths, so they
  // land in the same namespace and hit -- switching servers stops re-downloading everything. The
  // recipe must match the shell (ArtCdn.setKeyForRels) and the build (transcode-assets.mjs) byte for
  // byte: sha1(JSON.stringify(sorted(unique rels))).slice(0, 12). The three implementations are
  // pinned to the same vectors by the JVM check and transcode-assets.test.mjs.

  /** UTF-8 bytes of a string (surrogate pairs -> 4-byte sequences); ASCII rels are 1 byte each. */
  function utf8Bytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length
               && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }

  function hex32(n) {
    var s = (n >>> 0).toString(16);
    while (s.length < 8) s = '0' + s;
    return s;
  }

  /** SHA-1 (40 hex chars) over a string's UTF-8 bytes; ES5, no dependencies. */
  function sha1Hex(str) {
    var bytes = utf8Bytes(str);
    var ml = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var hi = Math.floor(ml / 4294967296), lo = ml >>> 0;
    bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
               (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
    var h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    var w = new Array(80);
    for (var i = 0; i < bytes.length; i += 64) {
      for (var j = 0; j < 16; j++) {
        w[j] = (bytes[i + j * 4] << 24) | (bytes[i + j * 4 + 1] << 16)
             | (bytes[i + j * 4 + 2] << 8) | bytes[i + j * 4 + 3];
      }
      for (j = 16; j < 80; j++) {
        var x = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
        w[j] = (x << 1) | (x >>> 31);
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4;
      for (j = 0; j < 80; j++) {
        var f, k;
        if (j < 20) { f = (b & c) | ((~b) & d); k = 0x5a827999; }
        else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
        else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
        else { f = b ^ c ^ d; k = 0xca62c1d6; }
        var t = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) | 0;
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    return hex32(h0) + hex32(h1) + hex32(h2) + hex32(h3) + hex32(h4);
  }

  /** The set-identity key of the enumerated same-origin paths (`/assets/<rel>`): strip the prefix,
   *  dedupe, sort, JSON.stringify, sha1, 12 hex. '' when it cannot be computed (never throws). */
  function setKeyOf(paths) {
    try {
      var rels = [], seen = {};
      for (var i = 0; i < paths.length; i++) {
        var p = paths[i];
        if (typeof p !== 'string' || p.indexOf('/assets/') !== 0) continue;
        var r = p.substring(8); // '/assets/' is 8 chars
        if (!r || seen[r]) continue;
        seen[r] = 1;
        rels.push(r);
      }
      rels.sort();
      return sha1Hex(JSON.stringify(rels)).substring(0, 12);
    } catch (e) {
      return '';
    }
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

  // ---- rates (data API only -- owner 2026-10-10: the CHIP shows numbers only, no bar, no rates) ---
  // The rate/ETA text that used to be appended to the chip (byte-rate + duration suffixes) is
  // deliberately GONE (owner 2026-10-10: drop the cache-load parameters). metrics() itself stays: state()/
  // snapshot()/onProgress still carry bps / avgBps / filesPerSec / etaMs for the preload panel and
  // the tests. Keep the literal rate units out of this file: the shipped chip must never print one.

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

  // ---- progress plumbing ----------------------------------------------------

  function snapshot() {
    var m = metrics(); // once per emit: the frame's progress + its rates
    return {
      state: state, done: done, total: total, failed: failedCount,
      // pct: the walk percentage, derived here so the preload panel (which draws its own bar) can
      // read it straight off the API. Added 2026-10-10 alongside the window's bar removal -- it is
      // an addition, nothing was deleted: done / total stay the source of truth.
      pct: total > 0 ? clampInt(Math.floor(done * 100 / total), 0, 100) : 0,
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
      pct: total > 0 ? clampInt(Math.floor(done * 100 / total), 0, 100) : 0,
      pending: total > done ? total - done : 0,
      localFiles: localSkipped,
      inflight: active, window: limit, attempts: attempts,
      backoffMs: penaltyUntil > now() ? penaltyUntil - now() : 0,
      paused: paused, minimized: 0, gapMs: Math.round(paceMs()), carriedHash: carriedHash,
      localList: localCount, localSkipped: localSkipped,
      resumed: resumed, hash: hash, setKey: setKey, fp: fp, cursor: writeCursor(), walkCursor: cursor, walk: walk,
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
      hash: hash, setKey: setKey, fp: fp, total: total, done: done, idle: total - walk,
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
   * The stored record for the manifest at hand. It is trusted ONLY when the SET IDENTITY matches
   * (same `setKey`) AND it describes the SAME asset set (fingerprint + total).
   *
   * Audit 2026-10-09 phase 1: nothing carries across a CHANGED asset set. 2026-10-10 (direction A):
   * the namespace is the set key, not the byte hash -- so two servers running the same upstream
   * version (same rel set, same fp, same total) share one record and resume across the switch, while
   * a changed set (different setKey) re-walks from the top. The shell verifies each cached file
   * against data/asset-digests.json (or the namespace sidecar), re-fetching only the mismatches.
   */
  function matchingRecord() {
    var rec = recordFor(ns());
    if (rec && setKey && rec.setKey === setKey && rec.fp === fp && rec.total === total) return rec;
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
    // PRIORITY PASS (owner 2026-10-11: "parts of a server's material are new -- dedupe fast, preload
    // first"): the entries the device does NOT already serve are the whole point of the walk, and they
    // are exactly the ones a server adds to its manifest APPENDED AT THE END (upstream 0.2.2->0.2.4 =
    // +313 refs, 299 of them audio). Walking in document order would therefore reach the new material
    // last -- after every already-local entry has been counted -- so the player waits the whole walk
    // for the one thing that is new. Queue those first, in document order among themselves, then the
    // rest (enqueue skips what pass 1 queued, and the local entries are still counted, never requested).
    if (localSet) {
      var pass, n;
      for (pass = 0; pass < 2; pass++) {
        for (n = cursor; n < list.length; n++) {
          if (localSet[list[n]]) continue;
          if (isBulkAudio(list[n]) !== (pass === 1)) continue;
          enqueue(list[n], n);
        }
      }
    }
    for (var j = cursor; j < list.length; j++) enqueue(list[j], j);
  }

  /**
   * Bulk streaming audio (voice lines / BGM / SFX). The distinction exists ONLY for the priority pass
   * above: those are large, they are not needed to paint a screen, and the game streams them on demand
   * -- the visual half of a delta is what the player is actually waiting for. Anything not under
   * /assets/audio/ counts as visual (spine, char, avatar, portrait, skill, prof, ui, fonts...).
   */
  function isBulkAudio(path) {
    return path.indexOf('/assets/audio/') === 0;
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
    var t0 = now();               // pacer sample start (see noteSettleMs)
    var timer = null;
    function once(result) {
      if (settledOnce) return;
      settledOnce = true;
      if (result === 'ok') noteSettleMs(now() - t0);
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

  /**
   * Current dispatch spacing in ms -- the adaptive pacer (see MIN_GAP_MS / GAP_MS / EWMA_ALPHA).
   * With no measurement yet, or while a penalty / a waiting retry is up, it stays at the old
   * conservative GAP_MS; otherwise it dispatches at the rate the link settles (settleEwma/window) so
   * the window stays full instead of idling 120 ms between every file.
   */
  function paceMs() {
    if (now() < penaltyUntil) return GAP_MS;
    if (retries.length) return GAP_MS;
    if (settleSamples < 1) return GAP_MS;
    var ms = settleEwma / (limit > 0 ? limit : 1);
    if (!(ms > 0)) return GAP_MS;
    if (ms < MIN_GAP_MS) ms = MIN_GAP_MS;
    if (ms > GAP_MS) ms = GAP_MS;
    return ms;
  }

  /** Folds one settled request's wall time into the pacer's EWMA (ok settlements only: a timeout or
   *  a 5xx says nothing about how fast the good path is, and those already back the walk off). */
  function noteSettleMs(ms) {
    if (!(ms >= 0)) return;
    settleEwma = settleSamples === 0 ? ms : (settleEwma * (1 - EWMA_ALPHA) + ms * EWMA_ALPHA);
    settleSamples++;
  }

  /** Earliest moment the run may make progress again (a retry becomes due, the penalty lapses). */
  function soonest() {    var t = penaltyUntil > now() ? penaltyUntil : Infinity;
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
        // (b) pacing: the adaptive gap (see paceMs) -- fast while the link settles fast, back to the
        // conservative 120 ms whenever a failure/penalty says the link or the slot policy is strained
        if (now() < nextDispatchAt) { scheduleCheck(nextDispatchAt); break; }
        nextDispatchAt = now() + paceMs();
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
    emit(); // the control STAYS (owner rule 2026-10-09): it is the only home overlay
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
      setKey = setKeyOf(out); // the resume namespace (direction A): the SET, not the byte hash
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
    hash = ''; setKey = ''; fp = ''; cursor = 0; settledFlags = null; spillIdx = -1; walk = 0;
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

  // 2026-10-11 (owner: "the floating window's art N/M becomes a FUNCTION"; "tapping the floating
  // window's first screen opens the function list"): ONE floating button, wording = the word for
  // "functions", no digit and
  // no progress bar. Tapping it opens the floating window's FIRST SCREEN -- the function-list panel
  // (ui/preloadPanel.js, kind 'preload'), the same panel that opens by default at boot. The old
  // two-form machinery (the "art N/M" chip <-> the "skip" toggle, per-form chrome, the cross-form
  // geometry pass) is GONE; see the header.

  var ui = null;                // the floating button -- the element IS the visible control
  var uiGuard = 0;              // 1 once the drop detector is armed (idempotent)
  var uiObserver = null;        // MutationObserver handle (the zero-idle-cost path)
  var uiProbeTimer = null;      // fallback low-frequency probe (only without MutationObserver)
  var arrowPos = null;          // {x, y}: remembered top-left of the button; null = the CSS corner
  var arrowPosRead = 0;         // 1 once localStorage was consulted this load
  var dragActive = 0;           // 1 while the button is pressed
  var dragMoved = 0;            // 1 once the press passed ARROW_SLOP (a drag, not a tap)
  var dragStartX = 0, dragStartY = 0;   // pointer position at press
  var dragOriginX = 0, dragOriginY = 0; // button top-left at press
  var dragBoxW = ARROW_SIZE, dragBoxH = ARROW_SIZE; // the clamp box for this gesture
  var suppressClick = 0;        // 1 after a drag so the following click is not a tap

  /** The control's mark: a neutral gear inside an outer ring (owner 2026-10-14). Built node by node --
   *  no innerHTML, no stylesheet, and every token ASCII so the file keeps its encoding contract. */
  function makeGearIcon() {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(ICON_SIZE));
    svg.setAttribute('height', String(ICON_SIZE));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.style.display = 'block';
    // the outer ring (asked for explicitly): thin + dim, so it frames the gear instead of competing
    var ring = document.createElementNS(NS, 'circle');
    ring.setAttribute('cx', '12'); ring.setAttribute('cy', '12'); ring.setAttribute('r', '10.2');
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', ICON_RING);
    ring.setAttribute('stroke-width', '1.1');
    ring.setAttribute('opacity', '0.55');
    svg.appendChild(ring);
    // eight teeth drawn as spokes between the hub and the rim: legible at 16px, no path data to drift
    for (var i = 0; i < 8; i++) {
      var a = (Math.PI * 2 / 8) * i;
      var t = document.createElementNS(NS, 'line');
      t.setAttribute('x1', String((12 + Math.cos(a) * 5.0).toFixed(2)));
      t.setAttribute('y1', String((12 + Math.sin(a) * 5.0).toFixed(2)));
      t.setAttribute('x2', String((12 + Math.cos(a) * 8.6).toFixed(2)));
      t.setAttribute('y2', String((12 + Math.sin(a) * 8.6).toFixed(2)));
      t.setAttribute('stroke', ICON_STROKE);
      t.setAttribute('stroke-width', '1.8');
      t.setAttribute('stroke-linecap', 'round');
      svg.appendChild(t);
    }
    var hub = document.createElementNS(NS, 'circle');
    hub.setAttribute('cx', '12'); hub.setAttribute('cy', '12'); hub.setAttribute('r', '3.4');
    hub.setAttribute('fill', 'none');
    hub.setAttribute('stroke', ICON_STROKE);
    hub.setAttribute('stroke-width', '1.8');
    svg.appendChild(hub);
    return svg;
  }


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

  /** The host's own layout answer for an element, or null when there is none (a sandbox, a
   *  pre-layout host, a display:none node): only finite, positive numbers are ever reported. */
  function rectOf(el) {
    try {
      if (el && typeof el.getBoundingClientRect === 'function') {
        var r = el.getBoundingClientRect();
        if (r && isFinite(r.left) && isFinite(r.top) && isFinite(r.width) && isFinite(r.height)
            && r.width > 0 && r.height > 0) {
          return { x: r.left, y: r.top, w: r.width, h: r.height };
        }
      }
    } catch (e) { /* no layout: report nothing */ }
    return null;
  }

  /** The box the clamp must keep inside the viewport: the MEASURED button when the host lays it out,
   *  else the nominal ARROW_SIZE box -- a sandbox or a pre-layout host has no rect and must still
   *  clamp deterministically. */
  function controlBox() {
    var r = rectOf(ui);
    return r ? { w: r.w, h: r.h } : { w: ARROW_SIZE, h: ARROW_SIZE };
  }

  /** Keeps a bw x bh box inside the viewport with ARROW_MARGIN to spare on every side. With no
   *  measurable viewport the coordinates pass through unchanged (never a blind clamp). */
  function clampBox(x, y, bw, bh) {
    var w = viewW();
    var h = viewH();
    if (w > 0) {
      var maxX = w - bw - ARROW_MARGIN;
      if (maxX < ARROW_MARGIN) maxX = ARROW_MARGIN;
      if (x < ARROW_MARGIN) x = ARROW_MARGIN;
      else if (x > maxX) x = maxX;
    }
    if (h > 0) {
      var maxY = h - bh - ARROW_MARGIN;
      if (maxY < ARROW_MARGIN) maxY = ARROW_MARGIN;
      if (y < ARROW_MARGIN) y = ARROW_MARGIN;
      else if (y > maxY) y = maxY;
    }
    return { x: x, y: y };
  }

  /** The first-paint corner of the button: ARROW_DEFAULT_RIGHT / ARROW_DEFAULT_BOTTOM off the edges.
   *  null with no viewport to place against -- the CSS corner is left alone then. This is the
   *  NOMINAL model for a host without layout (a sandbox). */
  function boxCorner() {
    var w = viewW(), h = viewH();
    if (w <= 0 || h <= 0) return null;
    var b = controlBox();
    return { x: w - b.w - ARROW_DEFAULT_RIGHT, y: h - b.h - ARROW_DEFAULT_BOTTOM };
  }

  /** The remembered spot, or null for anything unusable (absent, not JSON, not a pair of finite
   *  numbers). A null / corrupt value means the CSS corner -- never an error. */
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

  /** Writes the button's inline position, clamped to the viewport for the whole box. A transient
   *  clamp does NOT overwrite the remembered spot: a resize re-clamps on screen and the control
   *  returns to the user's spot once there is room again. */
  function placeBox(x, y) {
    if (!ui) return;
    var b = controlBox();
    var pos = clampBox(x, y, b.w, b.h);
    var s = ui.style;
    s.left = pos.x + 'px';
    s.top = pos.y + 'px';
    s.right = '';
    s.bottom = '';
  }

  /** Places the button at the remembered spot; with none, the CSS corner is left alone. */
  function placeControl() {
    if (!ui || !arrowPos) return;
    placeBox(arrowPos.x, arrowPos.y);
  }

  /** Where the button sits when a press lands: the host's own layout answer when it has one (a
   *  device: exact, even before the first drag), else the remembered spot, else the nominal corner.
   *  Only ever numbers -- a host without layout must not throw, it just drags from the nominal spot. */
  function dragOrigin() {
    var r = rectOf(ui);
    if (r) return { x: r.x, y: r.y };
    if (arrowPos) return { x: arrowPos.x, y: arrowPos.y };
    return boxCorner() || { x: 0, y: 0 };
  }

  /** Press start. Remembers where the finger and the button were, so every move is an offset from
   *  the press and the control follows exactly under the finger. The clamp box is fixed for the
   *  whole gesture: it cannot change while the button is being dragged. */
  function dragBegin(px, py) {
    suppressClick = 0; // a fresh gesture: the previous drag's click guard is spent
    dragActive = 1;
    dragMoved = 0;
    dragStartX = px;
    dragStartY = py;
    var o = dragOrigin();
    var b = controlBox();
    dragOriginX = o.x;
    dragOriginY = o.y;
    dragBoxW = b.w;
    dragBoxH = b.h;
  }

  /** Move: returns 1 once the press has become a drag (movement past ARROW_SLOP), 0 while it is
   *  still a possible tap. A drag moves + clamps the button and remembers where it ended up. */
  function dragUpdate(px, py) {
    if (!dragActive) return 0;
    var dx = px - dragStartX;
    var dy = py - dragStartY;
    if (!dragMoved) {
      if (dx * dx + dy * dy < ARROW_SLOP * ARROW_SLOP) return 0;
      dragMoved = 1;
    }
    var c = clampBox(dragOriginX + dx, dragOriginY + dy, dragBoxW, dragBoxH);
    arrowPos = { x: c.x, y: c.y };
    if (ui) {
      var s = ui.style;
      s.left = c.x + 'px';
      s.top = c.y + 'px';
      s.right = '';
      s.bottom = '';
    }
    return 1;
  }

  /** Release: a real drag persists the spot and arms the click guard; a tap does neither (its click
   *  still reaches onclick -- opening the function list). */
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

  // The control wants its own repaint cadence: it must notice a match screen going away while no
  // walk is on. The heartbeat rides the page's animation frame (available in the WebView; absent on
  // a plain sandbox/old WebView, where paints then happen on state changes only) and is throttled to
  // UI_TICK_MS, so the cost is one no-op check per frame.
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

  // ---- anti-hot-reload mount (owner 2026-10-10: a hot reload must not lose the window) -----------
  // The button lives on documentElement, deliberately NOT on body: a SPA re-render or a content hot
  // swap replaces the body wholesale and would take a body-mounted control with it, forever (the
  // script did its one mount at load). documentElement survives that swap and is the outermost place
  // a script may append to. The drop detector below re-attaches the SAME node -- no state is lost.

  /** The outermost element the control may be attached to: documentElement first (a body swap cannot
   *  drop it), body as the last resort. Null when there is no usable DOM. */
  function uiParent() {
    try {
      if (typeof document === 'undefined') return null;
      if (document.documentElement
          && typeof document.documentElement.appendChild === 'function') return document.documentElement;
    } catch (e) { /* fall through to body */ }
    try {
      if (document.body && typeof document.body.appendChild === 'function') return document.body;
    } catch (e) { /* no DOM at all */ }
    return null;
  }

  /** True while the control is still in the document. isConnected when the host has it (every
   *  WebView this app runs on); otherwise the parent chain is walked up to documentElement -- a
   *  sandbox / old host must not be told "detached" forever. A probe failure reports CONNECTED: a
   *  throwing probe must never start a re-append loop. */
  function uiConnected() {
    if (!ui) return false;
    try {
      if (typeof ui.isConnected === 'boolean') return ui.isConnected;
      var p = ui.parentNode;
      if (!p) return false;
      var top = p;
      var guard = 0;
      while (top.parentNode && guard < 64) { top = top.parentNode; guard++; }
      var de = null, bd = null;
      try {
        if (typeof document !== 'undefined') { de = document.documentElement; bd = document.body; }
      } catch (e) { de = null; bd = null; }
      if (de) return top === de;
      return !!bd && top === bd;
    } catch (e) {
      return true;
    }
  }

  /** (Re)attaches the SAME node. appendChild MOVES an existing child in the real DOM, so a live node
   *  is never duplicated and every inline style it carries (position, progress) survives. */
  function attachUI() {
    if (!ui) return false;
    var p = uiParent();
    if (!p) return false;
    try { p.appendChild(ui); return true; } catch (e) { return false; }
  }

  /** The drop detector's one action: if the page removed the control (a hot reload swapping the tree,
   *  a framework pruning "foreign" nodes, documentElement.innerHTML = ...), put it back at the
   *  outermost spot and repaint -- the node itself was never destroyed, so position / progress are kept. */
  function remountUI() {
    if (!ui || uiConnected()) return;
    if (attachUI()) updateUI();
  }

  /** Arms the drop detector once. The MutationObserver observes documentElement's OWN child list,
   *  which is the zero-idle-cost path: it fires only when head / body / the control itself are added
   *  or removed -- exactly the moments the control can be dropped -- so a busy game page costs
   *  nothing (no rAF spinning, no periodic walk of the tree). A host without MutationObserver gets a
   *  low-frequency setInterval probe instead; the probe is NOT installed on the observer path. */
  function guardUI() {
    if (uiGuard || !ui) return;
    uiGuard = 1;
    try {
      if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.documentElement) {
        uiObserver = new MutationObserver(function () { remountUI(); });
        uiObserver.observe(document.documentElement, { childList: true });
        return;
      }
    } catch (e) { uiObserver = null; }
    try {
      if (typeof setInterval === 'function') uiProbeTimer = setInterval(remountUI, UI_PROBE_MS);
    } catch (e) { uiProbeTimer = null; }
  }

  /** The floating button's TOGGLE (owner 2026-10-15: one tap opens the window, the next closes it).
   *  Opening is unchanged: the window's first screen is the function list (the panel host's kind
   *  'preload', ui/preloadPanel.js). What is new is the closing half: ask the host which panel is
   *  open (__SP_SHELL.currentPanel) and close it when one is.
   *  Why ask the host instead of remembering a boolean here: a panel can also be closed by other
   *  routes (the backdrop click, an entry opening a different kind, the page calling close()), so a
   *  local flag drifts out of sync and the second tap then does nothing. The host's panelState is
   *  the single source of truth. Returns false when there is neither a panel host nor a preload
   *  center (an old tree): the click stays a no-op instead of throwing. */
  function toggleMenu() {
    try {
      var sh0 = window.__SP_SHELL;
      if (sh0 && typeof sh0.currentPanel === 'function' && sh0.currentPanel()) {
        if (typeof sh0.closePanel === 'function') { sh0.closePanel(); return true; }
      }
    } catch (e) { /* no host / old tree: fall through to the open path */ }
    try {
      var pc = window.__SP_PRELOAD;
      if (pc && typeof pc.open === 'function') { pc.open(); return true; }
    } catch (e) { /* fall through to the panel host */ }
    try {
      var sh = window.__SP_SHELL;
      if (sh && typeof sh.openPanel === 'function') { sh.openPanel('preload'); return true; }
    } catch (e) { /* no panel host: nothing to open */ }
    return false;
  }

  function showUI() {
    if (typeof document === 'undefined' || ui) return;
    if (!uiParent()) return;
    try {
      ui = document.createElement('button');
      ui.setAttribute('data-sp-art', '1');
      ui.setAttribute('type', 'button');
      var s = ui.style;
      // One box: the button IS the visible control, so the old container / label split (and the
      // cross-form inset maths) is gone. UI_LAYER = the top of the overlay scale (shellPanels
      // SP_LAYERS.chip, owner 2026-10-10, floating window topmost): the control is never covered by
      // a panel / notice / toast.
      s.position = 'fixed';
      s.right = ARROW_DEFAULT_RIGHT + 'px';
      s.bottom = '3.4rem';
      s.zIndex = String(UI_LAYER);
      s.background = ARROW_BG;
      s.border = ARROW_BORDER;
      s.borderRadius = ARROW_RADIUS;
      s.padding = ARROW_PADDING_ICON; // the mark is an icon now (was the text 'functions')
      s.color = ARROW_COLOR;
      s.fontSize = ARROW_FONT;
      s.lineHeight = '1';
      s.fontFamily = '-apple-system,Segoe UI,Roboto,sans-serif';
      s.cursor = 'pointer';
      s.touchAction = 'none'; // a clean drag handle: the page never scrolls under the finger
      s.pointerEvents = 'auto';
      ui.textContent = '';            // idempotent re-mount: clear whatever was there
      if (typeof document.createElementNS === 'function') ui.appendChild(makeGearIcon());

      // Read the remembered spot once (null / corrupt -> the default corner, no throw).
      if (!arrowPosRead) { arrowPos = readArrowPos(); arrowPosRead = 1; }

      // A DRAG must never count as a tap: dragFinish() arms suppressClick when the press moved past
      // the threshold, so the click a drag always ends with is swallowed here.
      ui.onclick = function () {
        if (suppressClick) { suppressClick = 0; return; }
        toggleMenu();
      };

      // ---- the control is a draggable floating window (owner rule 2026-10-10) ----
      // Pointer events are primary; the touch handlers are the old-WebView fallback. Both are
      // attached on purpose (a touch device that fires both is harmless: each handler is idempotent),
      // and a press NEVER taps -- only a release without movement past ARROW_SLOP does, through the
      // click above. preventDefault fires only once a drag is under way, so the page's other gestures
      // (scroll, pinch) are untouched.
      ui.onpointerdown = function (e) {
        if (!e) return;
        if (typeof e.button === 'number' && e.button !== 0) return; // left / primary only
        dragBegin(e.clientX, e.clientY);
        try {
          if (e.pointerId != null && typeof ui.setPointerCapture === 'function') {
            ui.setPointerCapture(e.pointerId); // keep the moves even if the finger leaves the button
          }
        } catch (er) { /* capture is best effort */ }
      };
      ui.onpointermove = function (e) {
        if (!dragActive || !e) return;
        if (dragUpdate(e.clientX, e.clientY) && typeof e.preventDefault === 'function') e.preventDefault();
      };
      ui.onpointerup = function () { dragFinish(); };
      ui.onpointercancel = function () { dragFinish(); };
      ui.ontouchstart = function (e) {
        if (!e || !e.touches || !e.touches.length) return;
        dragBegin(e.touches[0].clientX, e.touches[0].clientY);
      };
      ui.ontouchmove = function (e) {
        if (!dragActive || !e || !e.touches || !e.touches.length) return;
        if (dragUpdate(e.touches[0].clientX, e.touches[0].clientY) && typeof e.preventDefault === 'function') e.preventDefault();
      };
      ui.ontouchend = function () { dragFinish(); };
      ui.ontouchcancel = function () { dragFinish(); };

      // documentElement-first mount + the drop detector (owner 2026-10-10 hot-reload rule).
      if (!attachUI()) throw new Error('no mount point');
      updateUI();
      placeControl(); // the remembered spot (no-op when the control was never dragged)
      guardUI();   // re-attach the SAME node if the page drops it (hot reload / DOM swap)
      startTick(); // the control notices a match screen going away between settlements
    } catch (e) { ui = null; }
  }

  function updateUI() {
    if (!ui) return;
    try {
      // Owner 2026-10-11: the button carries NO number and NO progress bar -- the preload figures
      // live in the function-list panel (its own bar). The count still rides the tooltip, so the
      // progress stays one press away without a digit on screen.
      ui.textContent = '';            // idempotent re-mount: clear whatever was there
      if (typeof document.createElementNS === 'function') ui.appendChild(makeGearIcon());
      ui.title = '\u9884\u8F7D ' + done + '/' + total
        + ' \u00B7 \u70B9\u51FB\u6253\u5F00\u529F\u80FD\u5217\u8868';
      // Owner rule 2026-10-09: the control is global EXCEPT in a match / briefing screen or a hidden
      // document -- the same MATCH_MARKS / pageBusy() probe the walk itself stands down on. The walk
      // is NOT stopped here; that stand-down stays pageBusy()/packBusyNow()'s job in pump().
      //
      // Owner 2026-10-17: the gear must exist in a match too. It used to be display:none on the
      // match / briefing / result / draft screens, which made the panel unreachable mid-game; now it
      // stays clickable and only dims + shrinks so it does not fight the field for attention.
      var hiddenDoc = false;
      try { hiddenDoc = document.visibilityState === 'hidden'; } catch (e2) { hiddenDoc = false; }
      if (hiddenDoc) {
        ui.style.display = 'none';   // backgrounded: render nothing at all
      } else if (pageBusy() === 1) {
        ui.style.display = '';
        ui.style.opacity = '0.38';   // in a match: still clickable, just quiet
        ui.style.transform = 'scale(0.82)';
      } else {
        ui.style.display = '';
        ui.style.opacity = '';
        ui.style.transform = '';
      }
    } catch (e) { /* ignore */ }
    startTick(); // a paint (re)arms the heartbeat
  }

  // Persist when the page really leaves (a killed WebView never runs this -- the SAVE_EVERY
  // throttle and the cursor's settle-only advance are what cover that case).
  try {
    if (typeof window.addEventListener === 'function') {
      var flush = function () { try { save(); } catch (e) { /* ignore */ } };
      window.addEventListener('pagehide', flush, false);
      // A resized window may leave the dragged control outside the visible area: re-clamp on the
      // spot. The clamp is measured live, so a repaint is enough.
      window.addEventListener('resize', function () { placeControl(); updateUI(); }, false);
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        // Repaint on a visibility flip too: the control hides/shows with the page (owner rule 2026-10-09)
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

  // 2026-10-12 (found on a real device): the control used to be created ONLY inside start(), and this
  // batch turned the default walk off -- so a fresh launch drew NO floating button at all, and once
  // the one-time default panel was dismissed the function list (servers / mod manager / rooms /
  // appearance / net prefs / check-update) became unreachable. The button is the ENTRY POINT, not
  // part of the walk: mount it when the module loads. showUI() returns by itself when there is no
  // DOM yet, and guardUI()'s probe re-attaches once documentElement appears.
  try { showUI(); } catch (e) { /* no DOM: tests */ }

  // 2026-10-11 (owner: "resources are NOT globally preloaded by default"): the walk does NOT start
  // itself any more. The first frame draws the floating button only; the user starts (and stops) the
  // preload from the function-list panel's bottom block. window.__SP_ART_NO_AUTO keeps its old
  // meaning -- never auto-start -- for hosts and tests that want manual control; it is now simply
  // the same behaviour as the default, so the flag stays honoured without changing anything.
  try {
    if (!window.__SP_ART_NO_AUTO && window.__SP_ART_AUTO === true && typeof setTimeout === 'function') {
      setTimeout(function () {
        try { start(); } catch (e) { /* silent */ }
      }, 0);
    }
  } catch (e) { /* silent */ }
})();
