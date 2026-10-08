/* global window */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here
// room-lifecycle.js -- shell extra: ghost-room cleanup on room lifecycle moments, without
// patching the page's main.js. Replaces the two v5.3 main.js patch entries
// (tools/apk/patches/settings-v5.3.json) so the patch list can reach zero at 0.2.0.
//
// What it does (and the only thing the patch added -- backToLobby() and the seat-check state
// reset are the page's own code and keep running with no patch):
//   1. when the page receives `room.closed`  -> retire the lobby card we published for that room;
//   2. when a `room.state` arrives in which we are no longer seated (kicked / left elsewhere,
//      and not spectating)             -> retire the card of the room we were showing.
//
// Channel (audit 2026-10-07): the page exposes its module instances at the end of boot()
// (0.1.4 public/js/main.js:354, 0.2.0-dev master main.js:369 -- unchanged since 0.1.3):
//     globalThis.__SP__ = { store, net, data, version: 1 };
// We subscribe on that SAME net instance, so the triggers are the exact protocol events, not
// DOM guesses. Registration order puts our handlers after the page's own (net._emit walks its
// listener Set in insertion order), so by the time ours run the page has already cleared
// store.room -- which is why we track the showing room code ourselves instead of reading it
// (the patch read store.get().room.code before backToLobby(); same effective value).
//
// Safety contract:
//   - no network of its own: retirement goes through window.__SP_LOBBY.retireRoom, which is
//     token-gated (only deletes cards WE published) and TTL-backed (10 min) on failure;
//   - fails silent everywhere: missing __SP__, missing lobby module, throwing store/handlers --
//     the page must never notice this file exists;
//   - idempotent via the window.__SP_ROOM_LC marker (first evaluation wins and keeps polling);
//   - ES5 only (var / function / IIFE), ASCII only, no DOM writes, no history/location edits.
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__SP_ROOM_LC) return; // idempotent

  var POLL_MS = 150;
  var POLL_MAX_TRIES = 400; // ~60s: boot ends ~1.5s after load; give up long after any start
  var tries = 0;
  var timer = null;
  var wired = false;
  // The room the page is currently showing (mirror of what the patch retired:
  // store.get().room.code). Null = not showing a room.
  var lastCode = null;

  function sp() {
    try { return window.__SP__ || null; } catch (e) { return null; }
  }

  /** Token-gated, failure-tolerant retirement (see lobby.js retireRoom). Never throws. */
  function retire(code) {
    if (!code) return;
    try {
      var lobby = window.__SP_LOBBY;
      if (lobby && typeof lobby.retireRoom === 'function') {
        try { lobby.retireRoom(code); } catch (e) { /* never surface */ }
      }
      // lobby module absent: retire silently skipped -- the 10 min TTL on the board is the
      // designed fallback, same as when this whole file fails to load.
    } catch (e) { /* never surface */ }
  }

  // Same predicate as the page's spectator check (store.js isSpectating, 0.1.4:113):
  // myId != null && Array.isArray(room.spectators) && spectators.some(s => s && s.playerId === myId)
  function isSpectating(room, myId) {
    if (myId == null || !room || !Array.isArray(room.spectators)) return false;
    for (var i = 0; i < room.spectators.length; i++) {
      var s = room.spectators[i];
      if (s && s.playerId === myId) return true;
    }
    return false;
  }

  // Mirrors the page's onRoomState seat check (0.1.4 main.js:171, 0.2.0-dev master:178 -- the
  // predicate is byte-identical in both):
  //   myId != null && seats.length && !seats.some(s => s && s.playerId === myId) && !isSpectating(...)
  // Replicating the predicate ourselves (instead of watching store.room transitions) keeps the
  // false-positive profile identical to the patch: e.g. a restore-grace drop (server kept the
  // room but never re-pushed it) fires NO room.state, so we do not retire a room that may
  // still be alive -- exactly like the patch.
  function onRoomState(msg) {
    try {
      var inst = sp();
      if (!inst || !inst.store || typeof inst.store.get !== 'function') return;
      var st = inst.store.get();
      var myId = st && st.me ? st.me.playerId : null;
      var room = (msg && typeof msg === 'object') ? msg : {};
      var seats = Array.isArray(room.seats) ? room.seats : [];
      var seated = false;
      for (var i = 0; i < seats.length; i++) {
        if (seats[i] && seats[i].playerId === myId) { seated = true; break; }
      }
      if (myId != null && seats.length && !seated && !isSpectating(room, myId)) {
        // The page's own handler ran first and already cleared store.room; retire the room
        // we were showing (token gate makes this a no-op for rooms we did not publish).
        retire(lastCode);
        lastCode = null;
        return;
      }
      // Still seated / spectating / not entered: remember the code the page will show.
      if (typeof room.code === 'string' && room.code) lastCode = room.code;
    } catch (e) { /* never surface */ }
  }

  function onRoomClosed() {
    try {
      retire(lastCode);
    } catch (e) { /* never surface */ }
    lastCode = null;
  }

  /** Wire onto the page's real instances once __SP__ exists. Returns true when wired. */
  function attach() {
    if (wired) return true;
    var inst = sp();
    if (!inst || !inst.net || typeof inst.net.on !== 'function' ||
        !inst.store || typeof inst.store.get !== 'function') return false;
    // Seed with the room the page already shows (late loader: a room.state may have fired
    // before us; the patch would have retired store.get().room.code, so mirror it).
    try {
      var st = inst.store.get();
      if (st && st.room && typeof st.room.code === 'string' && st.room.code) lastCode = st.room.code;
    } catch (e) { /* keep null */ }
    var offClosed = null;
    var offState = null;
    try {
      offClosed = inst.net.on('room.closed', onRoomClosed);
      offState = inst.net.on('room.state', onRoomState);
      wired = true;
    } catch (e) {
      // Partial subscribe (first on() succeeded, second threw): undo the first so a retry
      // cannot end up with both registered twice. net.on returns an unsubscribe function.
      try { if (typeof offClosed === 'function') offClosed(); } catch (e2) { /* ignore */ }
      try { if (typeof offState === 'function') offState(); } catch (e3) { /* ignore */ }
      offClosed = offState = null;
      wired = false; // stay alive; the poll keeps trying (a partially broken net may recover)
    }
    return wired;
  }

  function tick() {
    if (wired) return;
    if (attach()) { stopPolling(); return; }
    tries += 1;
    if (tries >= POLL_MAX_TRIES) stopPolling(); // silent give-up: TTL fallback covers cleanup
  }

  function stopPolling() {
    if (timer !== null && typeof clearInterval === 'function') {
      try { clearInterval(timer); } catch (e) { /* ignore */ }
    }
    timer = null;
  }

  function start() {
    if (timer !== null) return;
    if (typeof setInterval !== 'function') return;
    timer = setInterval(tick, POLL_MS);
    tick(); // file may be evaluated after boot: __SP__ can already be there
  }

  // Diagnostics + test surface. debug() is read-only; tick()/attach() are for tests.
  window.__SP_ROOM_LC = {
    version: 1,
    debug: function () { return { wired: wired, lastCode: lastCode, tries: tries, polling: timer !== null }; },
    attach: attach,
    tick: tick,
  };

  start();
})();
