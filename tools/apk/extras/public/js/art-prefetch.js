/* global window, document */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here
/* art-prefetch.js -- background art prefetch for the "no embedded assets" build (P0, 2026-10-08).
 *
 * WHY: the APK no longer embeds the ~410 MB assets tree (build-webroot --no-assets). Every
 * /assets/** the page asks for is resolved by MainActivity: local tree (filesDir) -> APK -> on a
 * miss, re-fetch from the CDN base, cache under filesDir/art/cache/<manifest hash>/ and serve SAME-ORIGIN (a
 * cross-origin image would taint the canvas -- see the hot-update design doc section 6.3).
 *
 * WHAT THIS DOES: read /data/assets.json (same-origin), walk it in manifest order, and fetch every
 * asset path in the background with a small concurrency window. On a cache hit the Java interceptor
 * answers instantly (no network), so "already cached" entries are nearly free; misses warm the
 * cache for the next screen. Failures are silent: a missing image never blocks or breaks the game.
 *
 * API (window.__SP_ART):
 *   state            idle | running | done | cancelled | failed
 *   done, total, failed   numbers (live)
 *   start()          begin (idempotent; auto-started once after load unless __SP_ART_NO_AUTO)
 *   cancel()         stop immediately; in-flight requests finish, no new ones start, no error
 *   onProgress(cb)   cb({state,done,total,failed}) now and on every change
 *
 * UI: a minimal fixed bottom-right corner progress chip with a "skip" button, built with its own DOM
 * and inline styles only (no dependency on any stylesheet). It removes itself when finished.
 * The Java loading screen is intentionally NOT wired: it is already hidden by onPageFinished before
 * this module can run, so a self-owned corner chip is the honest, conflict-free placement.
 *
 * Contract: ES5, pure ASCII, no third-party dependency, idempotent (loading it twice is a no-op).
 */
(function () {
  if (window.__SP_ART) return;

  var CONCURRENCY = 5;
  var MANIFEST = '/data/assets.json';

  var state = 'idle';
  var done = 0;
  var total = 0;
  var failed = 0;
  var queue = [];
  var active = 0;
  var started = false;
  var cancelled = false;
  var callbacks = [];

  // ---- progress plumbing ----------------------------------------------------

  function snapshot() {
    return { state: state, done: done, total: total, failed: failed };
  }

  // Mirror the live values onto the api object as plain fields too, so even engines without
  // Object.defineProperty getters can read them (assignment to a getter-only prop fails silently).
  function sync() {
    try { api.state = state; api.done = done; api.total = total; api.failed = failed; } catch (e) { /* getter-only */ }
  }

  function emit() {
    sync();
    var snap = snapshot();
    for (var i = 0; i < callbacks.length; i++) {
      try { callbacks[i](snap); } catch (e) { /* a bad callback must not break the pump */ }
    }
    updateUI();
  }

  // ---- manifest -> ordered list of same-origin asset paths ------------------

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

  // ---- prefetch engine ------------------------------------------------------

  function settle(ok) {
    active--;
    if (state === 'running') {
      if (ok) done++; else failed++;
      emit();
    }
    pump();
  }

  function fetchOne(p) {
    active++;
    var settled = false;
    function once(ok) { if (!settled) { settled = true; settle(ok); } }
    try {
      var pr = fetch(p, { cache: 'force-cache' });
      if (!pr || typeof pr.then !== 'function') { once(false); return; }
      pr.then(function (r) {
        var ok = !!(r && r.ok);
        // Do not buffer the body in JS: the interceptor already wrote the full file to the cache
        // before responding, so the response existing is enough. Release the stream we will not read.
        if (r && r.body && typeof r.body.cancel === 'function') { try { r.body.cancel(); } catch (e) { /* ignore */ } }
        once(ok);
      }, function () { once(false); });
    } catch (e) {
      once(false);
    }
  }

  function pump() {
    if (cancelled || state !== 'running') return;
    while (active < CONCURRENCY && queue.length) fetchOne(queue.shift());
    if (active === 0 && queue.length === 0) finish();
  }

  function finish() {
    if (state !== 'running') return;
    state = 'done';
    emit();
    hideSoon(1200);
  }

  function failAll() {
    if (cancelled || state !== 'running') return;
    state = 'failed';
    emit();
    hideSoon(1500);
  }

  function start() {
    if (started) return; // idempotent
    started = true;
    if (typeof fetch !== 'function') { state = 'failed'; emit(); return; }
    state = 'running';
    cancelled = false;
    done = 0; failed = 0; total = 0;
    emit();
    showUI();
    try {
      var pr = fetch(MANIFEST, { cache: 'force-cache' });
      if (!pr || typeof pr.then !== 'function') { failAll(); return; }
      pr.then(function (r) {
        if (!r || !r.ok) throw new Error('manifest unavailable');
        return r.json();
      }).then(function (doc) {
        if (cancelled || state !== 'running') return;
        var out = [], seen = {};
        try { collect(doc, out, seen); } catch (e) { /* malformed manifest -> nothing to fetch */ }
        queue = out;
        total = out.length;
        emit();
        if (!total) { finish(); return; }
        pump();
      }, function () { failAll(); });
    } catch (e) {
      failAll();
    }
  }

  function cancel() {
    cancelled = true;
    queue = [];
    if (state === 'running' || state === 'idle') state = 'cancelled';
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

  function showUI() {
    if (typeof document === 'undefined' || !document.body || ui) return;
    try {
      ui = document.createElement('div');
      ui.setAttribute('data-sp-art', '1');
      var s = ui.style;
      // bottom 3.4rem（不是 10px）：标题屏页脚（版权行 / 版本号 / 检查更新）就在右下角，
      // 10px 的 chip 会正好压住「检查更新」；容器本身 pointer-events:none（只有 skip 可点），
      // 所以即使在任何页面重合也不会吃掉点击（2026-10-08 集成模拟实测："update 按钮点不到"）。
      s.position = 'fixed'; s.right = '10px'; s.bottom = '3.4rem'; s.zIndex = '2147483647';
      s.pointerEvents = 'none';
      s.background = 'rgba(12,15,14,0.82)'; s.color = '#8A9A93';
      s.font = '11px/1.4 -apple-system,Segoe UI,Roboto,sans-serif';
      s.padding = '6px 8px'; s.borderRadius = '6px'; s.maxWidth = '46vw';
      s.boxShadow = '0 1px 4px rgba(0,0,0,0.4)';

      uiText = document.createElement('span');
      uiText.textContent = 'art 0/0';

      var skip = document.createElement('button');
      skip.textContent = 'skip';
      var ss = skip.style;
      ss.marginLeft = '8px'; ss.font = 'inherit'; ss.color = '#4ED8AF';
      ss.background = 'transparent'; ss.border = '1px solid #2f5a4d';
      ss.borderRadius = '4px'; ss.padding = '1px 6px'; ss.cursor = 'pointer';
      ss.pointerEvents = 'auto'; // 容器是 none，只有 skip 需要真的可点
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
    } catch (e) { ui = null; uiText = null; uiFill = null; }
  }

  function updateUI() {
    if (!ui || !uiText || !uiFill) return;
    try {
      uiText.textContent = 'art ' + done + '/' + total + (failed ? ' (' + failed + ' failed)' : '');
      uiFill.style.width = (total ? Math.floor(done * 100 / total) : 0) + '%';
    } catch (e) { /* ignore */ }
  }

  function hideSoon(ms) {
    if (!ui) return;
    try { if (uiTimer) clearTimeout(uiTimer); uiTimer = setTimeout(removeUI, ms); } catch (e) { /* ignore */ }
  }

  function removeUI() {
    if (uiTimer) { try { clearTimeout(uiTimer); } catch (e) { /* ignore */ } uiTimer = null; }
    if (ui && ui.parentNode) { try { ui.parentNode.removeChild(ui); } catch (e) { /* ignore */ } }
    ui = null; uiText = null; uiFill = null;
  }

  // ---- export ---------------------------------------------------------------

  var api = {};
  function expose(name, get) {
    try { Object.defineProperty(api, name, { get: get, enumerable: true }); }
    catch (e) { try { api[name] = get(); } catch (e2) { /* ignore */ } }
  }
  expose('state', function () { return state; });
  expose('done', function () { return done; });
  expose('total', function () { return total; });
  expose('failed', function () { return failed; });
  api.start = start;
  api.cancel = cancel;
  api.onProgress = onProgress;
  window.__SP_ART = api;

  // Auto-start once, just after load, so the first frame is not competing with prefetch. Hosts (and
  // tests) that want manual control set window.__SP_ART_NO_AUTO = 1 before loading this file.
  try {
    if (!window.__SP_ART_NO_AUTO && typeof setTimeout === 'function') {
      setTimeout(function () { try { start(); } catch (e) { /* silent */ } }, 0);
    }
  } catch (e) { /* silent */ }
})();
