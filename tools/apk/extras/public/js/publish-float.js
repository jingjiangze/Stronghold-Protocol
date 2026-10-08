/* global window, document */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here
// publish-float.js -- shell-side floating "publish to lobby" button (hot-update overlay).
//
// Owner decision: the room screen already gets its upstream button re-labelled by room-hook.js, and the
// shell adds a SECOND, independent control here. This file never touches the upstream DOM: it appends
// exactly one button of its own plus one <style> tag, and nothing else. It coexists with room-hook.js.
//
// Business logic (isPublic / togglePublic / local-service semantics) lives entirely in window.__SP_LOBBY;
// this file never re-implements it and never issues a network request of its own.
//
// Room code source (preferred -> fallback):
//   1. globalThis.__SP__ = { store, net, data, version } (upstream main.js boot tail) -> store.get().room.code
//      -- exact "am I in a room / which room" state, no DOM guessing.
//   2. __SP__ absent (older content pack) -> DOM: .invite__code text (same source room-hook.js reads).
//   Either way the button is only shown when a 4-char room code is readable.
//
// ES5, IIFE, idempotent (window.__SP_PUBFLOAT marker). Every failure degrades silently to "not shown".
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__SP_PUBFLOAT) return; // idempotent: multiple injections take effect once

  var CODE_RE = /^[A-Z0-9]{4}$/;
  var POS_KEY = 'sp.pubfloat.pos';
  var DRAG_MIN = 6;          // pointer travel (Manhattan px) below this counts as a tap
  var POLL_MS = 30000;       // state re-check interval, never faster than 30 s
  var NOTE_MS = 2500;        // how long a failure note stays before reverting
  var MARGIN = 10;           // default gap from the bottom-right corner
  var DEF_W = 112, DEF_H = 40;

  var PUB_LABEL = '\u516c\u5f00\u5230\u5927\u5385';              // publish to lobby
  var OPEN_LABEL = '\u5df2\u516c\u5f00 \u00b7 \u53d6\u6d88';       // public - tap to unpublish
  var BUSY_LABEL = '\u516c\u5f00\u4e2d\u2026';                     // publishing...
  var FAIL_LABEL = '\u64cd\u4f5c\u5931\u8d25';                     // failed
  var NO_LOBBY_LABEL = '\u5927\u5385\u6a21\u5757\u672a\u52a0\u8f7d'; // lobby module not loaded

  var STYLE_ID = 'sp-pubfloat-style';
  var STYLE_CSS = '#' + 'sp-pubfloat{position:fixed;z-index:70;display:none;box-sizing:border-box;'
    + 'min-width:96px;padding:8px 12px;border:1px solid #4ed8af;border-radius:2px;'
    + 'background:rgba(12,15,14,.88);color:#4ed8af;'
    + 'font:600 13px/1.2 system-ui,-apple-system,"Noto Sans SC","Microsoft YaHei",sans-serif;'
    + 'letter-spacing:.02em;text-align:center;cursor:pointer;touch-action:none;'
    + '-webkit-user-select:none;user-select:none;box-shadow:0 2px 8px rgba(0,0,0,.45)}'
    + '#sp-pubfloat[data-sp-pub="1"]{background:#4ed8af;color:#06110d}';

  var el = null;
  var code = '';
  var visible = false;
  var pos = { x: 0, y: 0 };
  var drag = null;
  var busy = false;
  var noteActive = false;
  var noteTimer = null;
  var pollTimer = null;
  var lastPollAt = 0;

  function lobby() {
    try { return window.__SP_LOBBY || null; } catch (e) { return null; }
  }

  function spStore() {
    try {
      var sp = window.__SP__;
      if (sp && sp.store && typeof sp.store.get === 'function') return sp.store;
    } catch (e) { /* ignore */ }
    return null;
  }

  /** Room code: __SP__ store when present (authoritative), else the invite box in the DOM. */
  function readCode() {
    var store = spStore();
    if (store) {
      try {
        var st = store.get();
        var r = st && st.room;
        var c = r && r.code ? String(r.code).toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
        return CODE_RE.test(c) ? c : '';
      } catch (e) { return ''; }
    }
    try {
      var box = document.querySelector ? document.querySelector('.invite__code') : null;
      var txt = box ? String(box.textContent || '') : '';
      var m = txt.toUpperCase().replace(/[^A-Z0-9]/g, '');
      return CODE_RE.test(m) ? m : '';
    } catch (e) { return ''; }
  }

  function isPublicNow(c) {
    try {
      var L = lobby();
      return !!(L && typeof L.isPublic === 'function' && L.isPublic(c));
    } catch (e) { return false; }
  }

  function setText(t) {
    if (el && el.textContent !== t) el.textContent = t;
  }

  function paint() {
    if (!el) return;
    if (noteActive) return; // a busy/failure note owns the label until it expires
    var pub = isPublicNow(code);
    setText(pub ? OPEN_LABEL : PUB_LABEL);
    try {
      el.setAttribute('data-sp-pub', pub ? '1' : '0');
      el.setAttribute('title', pub
        ? '\u5f53\u524d\u5df2\u516c\u5f00\u5230\u5927\u5385\uff0c\u70b9\u6309\u53d6\u6d88'  // currently public: tap to unpublish
        : '\u628a\u672c\u623f\u95f4\u516c\u5f00\u5230\u5927\u5385\uff0810 \u5206\u949f\u5185\u6709\u6548\uff09'); // private: tap to publish to the lobby (10 min)
    } catch (e) { /* decoration only */ }
  }

  /** Show only when in a room with a readable code; refresh the label from the lobby state. */
  function update() {
    if (!el) return;
    code = readCode();
    visible = !!code;
    try { el.style.display = visible ? 'block' : 'none'; } catch (e) { /* ignore */ }
    if (visible) paint();
  }

  function flash(text) {
    if (!el) return;
    noteActive = true;
    setText(text);
    if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
    noteTimer = setTimeout(function () {
      noteTimer = null;
      noteActive = false;
      update();
    }, NOTE_MS);
  }

  function onTap() {
    var c = readCode();
    if (!c) { update(); return; }
    var L = lobby();
    if (!L || typeof L.togglePublic !== 'function') { flash(NO_LOBBY_LABEL); return; }
    if (busy) return;
    busy = true;
    flash(BUSY_LABEL);
    var p;
    try { p = Promise.resolve(L.togglePublic(c)); } catch (e) { p = Promise.resolve({ ok: false, text: FAIL_LABEL }); }
    var settle = function (r) {
      busy = false;
      if (r && r.ok) { noteActive = false; update(); return; }
      flash(String((r && r.text) || FAIL_LABEL));
    };
    p.then(settle, function () { settle({ ok: false, text: FAIL_LABEL }); });
  }

  // ---- position -----------------------------------------------------------------------------------

  function clampPos(x, y) {
    var w = 0, h = 0;
    try { w = window.innerWidth || 0; h = window.innerHeight || 0; } catch (e) { /* ignore */ }
    var maxX = w > DEF_W ? w - DEF_W : w;
    var maxY = h > DEF_H ? h - DEF_H : h;
    return { x: Math.max(0, Math.min(x, maxX)), y: Math.max(0, Math.min(y, maxY)) };
  }

  function applyPos() {
    if (!el) return;
    try { el.style.left = pos.x + 'px'; el.style.top = pos.y + 'px'; } catch (e) { /* ignore */ }
  }

  function loadPos() {
    var w = 0, h = 0;
    try { w = window.innerWidth || 0; h = window.innerHeight || 0; } catch (e) { /* ignore */ }
    var d = { x: (w > DEF_W ? w - DEF_W : 0) - MARGIN, y: (h > DEF_H ? h - DEF_H : 0) - MARGIN };
    try {
      var raw = window.localStorage ? window.localStorage.getItem(POS_KEY) : null;
      if (raw) {
        var o = JSON.parse(raw);
        if (o && typeof o.x === 'number' && typeof o.y === 'number' && isFinite(o.x) && isFinite(o.y)) {
          pos = clampPos(o.x, o.y);
          return;
        }
      }
    } catch (e) { /* bad blob -> default */ }
    pos = clampPos(d.x, d.y);
  }

  function savePos() {
    try {
      if (window.localStorage) window.localStorage.setItem(POS_KEY, JSON.stringify({ x: pos.x, y: pos.y }));
    } catch (e) { /* private mode / quota: silent */ }
  }

  // ---- dragging (pointer events; tap below DRAG_MIN) ----------------------------------------------

  function point(ev) {
    if (!ev) return { x: 0, y: 0 };
    if (typeof ev.clientX === 'number') return { x: ev.clientX, y: ev.clientY };
    if (typeof ev.pageX === 'number') return { x: ev.pageX, y: ev.pageY };
    if (ev.touches && ev.touches[0]) return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
    return { x: 0, y: 0 };
  }

  function addWin(type, fn) { try { window.addEventListener(type, fn, false); } catch (e) { /* ignore */ } }
  function delWin(type, fn) { try { window.removeEventListener(type, fn, false); } catch (e) { /* ignore */ } }

  function onPointerMove(ev) {
    if (!drag) return;
    var p = point(ev);
    var dx = p.x - drag.x, dy = p.y - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_MIN) return; // still within tap slop
    drag.moved = true;
    pos = clampPos(drag.l + dx, drag.t + dy);
    applyPos();
    if (ev && ev.preventDefault) ev.preventDefault();
  }

  function onPointerUp() {
    delWin('pointermove', onPointerMove);
    delWin('pointerup', onPointerUp);
    delWin('pointercancel', onPointerUp);
    if (!drag) return;
    var moved = drag.moved;
    drag = null;
    if (moved) savePos(); else onTap();
  }

  function onPointerDown(ev) {
    if (!el) return;
    var p = point(ev);
    drag = { x: p.x, y: p.y, l: pos.x, t: pos.y, moved: false };
    try { if (el.setPointerCapture && ev && ev.pointerId != null) el.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    addWin('pointermove', onPointerMove);
    addWin('pointerup', onPointerUp);
    addWin('pointercancel', onPointerUp);
    if (ev && ev.preventDefault) ev.preventDefault();
  }

  // ---- poll ---------------------------------------------------------------------------------------

  /** One throttled state re-check: never while hidden, never faster than POLL_MS. */
  function poll(force) {
    if (!force) {
      try { if (document.hidden) return; } catch (e) { /* ignore */ }
      var now = Date.now();
      if (now - lastPollAt < POLL_MS) return;
      lastPollAt = now;
    }
    update();
  }

  // ---- boot ---------------------------------------------------------------------------------------

  function ensureStyle() {
    try {
      if (document.getElementById && document.getElementById(STYLE_ID)) return;
      var st = document.createElement('style');
      st.setAttribute('id', STYLE_ID);
      st.textContent = STYLE_CSS;
      (document.head || document.documentElement || document.body).appendChild(st);
    } catch (e) { /* no style -> button still works, just unstyled */ }
  }

  function createButton() {
    var b = document.createElement('button');
    b.setAttribute('id', 'sp-pubfloat');
    b.setAttribute('type', 'button');
    b.setAttribute('data-sp-pubfloat', '1');
    b.setAttribute('aria-label', PUB_LABEL);
    b.className = 'sp-pubfloat';
    if (b.addEventListener) b.addEventListener('pointerdown', onPointerDown, false);
    if (typeof window.PointerEvent === 'undefined' && b.addEventListener) {
      b.addEventListener('click', function () { onTap(); }, false); // no pointer events: tap still works
    }
    return b;
  }

  function boot() {
    ensureStyle();
    el = createButton();
    loadPos();
    applyPos();
    try { (document.body || document.documentElement).appendChild(el); } catch (e) { el = null; }
    if (!el) return;
    update();
    try { pollTimer = setInterval(function () { poll(false); }, POLL_MS); } catch (e) { pollTimer = null; }
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) return;
        lastPollAt = 0; // return to the page: one immediate catch-up
        poll(false);
      }, false);
    } catch (e) { /* ignore */ }
    addWin('resize', function () { pos = clampPos(pos.x, pos.y); applyPos(); });

    window.__SP_PUBFLOAT = {
      refresh: update,
      poll: poll,
      toggle: onTap,
      code: function () { return code; },
      visible: function () { return visible; },
      el: el,
    };
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  } catch (e) { /* never break the page: silent no-op */ }
})();
