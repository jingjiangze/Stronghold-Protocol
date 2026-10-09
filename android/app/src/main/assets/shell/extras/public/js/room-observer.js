/* global window, document */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here
// room-observer.mjs — client-side room witness (v2.8.0, L0 discovery layer).
//
// A server without Presence / without /room-probe can still be DISCOVERED as long as someone
// runs the shell in its rooms: the client sees room.state pushes (server-authoritative) and
// reports "serverId X currently has a joinable room CODE" to the directory. The directory keeps
// only {code → serverId, lastSeen, observerCount} with a short TTL; the target server's own
// room.join remains the final authority, so a false observation can never join a wrong room —
// the player just gets ROOM_NOT_FOUND.
//
// Report shape: POST {DIR}/observe  {code, serverId, t}  (t = epoch ms, replay window 10 min)
//
// v2.7.6 energy pass — strictly event-driven:
//   * a report is sent when the authoritative room.state changes, never on a blind poll;
//   * the 30 s renew runs ONLY while the room is actually joinable (joinable:false rooms have
//     no directory entry to keep alive), so a match/lobby-with-no-seat costs zero timers;
//   * while the page is hidden the renew is parked entirely — timers keep waking the WebView
//     in the background — and one catch-up report goes out on return (TTL refill);
//   * leave/dispose retracts (joinable:false) immediately instead of waiting for a TTL.
//
// Identity: the report carries no player name/id — only which signed-list server the client is
// connected to and the room code already visible in room.state.

(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var RENEW_MS = 30 * 1000;
  var CODE_OK = /^[A-HJ-NP-Z]{4}$/;
  var lastReport = null; // { code, joinable }
  var timer = null;

  function dirs() {
    // the shell exposes the same directory list it uses for room-code lookup
    try {
      if (Array.isArray(window.__SP_DIRS) && window.__SP_DIRS.length) return window.__SP_DIRS;
    } catch (e) { /* ignore */ }
    return ['https://spdir.jiangjiangze.icu'];
  }

  function serverId() {
    // which signed-list entry are we actually talking to? The shell knows without exposing URLs.
    try {
      if (window.shell && typeof window.shell.currentServerId === 'function') {
        return String(window.shell.currentServerId() || '');
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  function report(code, joinable) {
    var sid = serverId();
    if (!sid || !CODE_OK.test(code)) return;
    var body = JSON.stringify({ code: code, serverId: sid, joinable: joinable !== false, t: Date.now() });
    for (var i = 0; i < dirs().length; i++) {
      try {
        fetch(dirs()[i].replace(/\/+$/, '') + '/observe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body,
          keepalive: true,
          signal: AbortSignal.timeout(6000),
        }).catch(function () { /* discovery is best-effort */ });
      } catch (e) { /* ignore */ }
    }
  }

  function stopRenew() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function armRenew() {
    if (timer) return;
    timer = setInterval(function () {
      if (!lastReport || !lastReport.joinable) { stopRenew(); return; }
      if (document.hidden) return; // parked while hidden; visibilitychange refills the TTL
      report(lastReport.code, true);
    }, RENEW_MS);
  }

  /** Called from main.js on every room.state change (see the settings-v3.0 patch). */
  window.__SP_OBSERVE_ROOM = function (roomState) {
    try {
      var code = roomState && roomState.code ? String(roomState.code).toUpperCase() : '';
      if (!CODE_OK.test(code)) { stopRenew(); lastReport = null; return; }
      var seats = roomState.seats || [];
      var humans = 0;
      for (var i = 0; i < seats.length; i++) {
        if (seats[i] && seats[i].playerId && !seats[i].isBot && seats[i].connected !== false) humans++;
      }
      var joinable = !roomState.inMatch && humans > 0 && seats.some(function (s) { return !s; });
      lastReport = { code: code, joinable: joinable };
      if (joinable) { report(code, true); armRenew(); } else { stopRenew(); report(code, false); }
    } catch (e) { /* observation must never break the game */ }
  };

  window.__SP_OBSERVE_STOP = function () {
    stopRenew();
    // retract right away — the directory entry must not outlive the room we are leaving
    if (lastReport && lastReport.joinable) report(lastReport.code, false);
    lastReport = null;
  };

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopRenew(); return; }
    if (lastReport && lastReport.joinable) { report(lastReport.code, true); armRenew(); }
  });
})();
