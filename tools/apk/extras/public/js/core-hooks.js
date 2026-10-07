// core-hooks.js -- shell extra: the last page-patch behaviours, moved out of main.js.
//
// Replaces these patch entries so the patch list can reach zero at 0.2.0 (the patch to
// js/ui/loadoutSync.js is a separate page module and is NOT covered here):
//   * settings-v3.4.json  js/main.js -> __SP_DATA.recordRoom(room) on every accepted room.state
//   * settings-v3.4.json  js/main.js -> __SP_DATA.recordResult(payload(msg), {roomCode, mode}) on m.result
//   * settings-v4.10.json js/main.js -> that m.result ctx also carries meId (store.me.playerId)
//   * settings-v5.4.json  js/main.js -> window.__SP_BACK (Android back key, synchronous boolean)
//   * settings-v3.0.json  js/main.js -> feed joinable-room sightings to window.__SP_OBSERVE_ROOM
//
// Channel (audit 2026-10-07): the page exposes its module instances at the end of boot()
// (0.1.4 public/js/main.js:354, 0.2.0 public/js/main.js:369 -- unchanged since 0.1.3):
//     globalThis.__SP__ = { store, net, data, version: 1 };
// We subscribe on that SAME net/store instance, so the triggers are the exact protocol events /
// state transitions the patch used, not DOM guesses. Registration order puts our handlers after
// the page's own (net._emit walks its listener Set in insertion order), so by the time ours run
// the page has already applied the message -- which is why every value is recomputed from the
// message / store snapshot here instead of read back from the DOM.
//
// Safety contract:
//   - no network of its own: the page's net instance is used only through __SP__;
//   - fails silent everywhere: missing __SP__, throwing store/net/__SP_DATA, missing globals --
//     the page must never notice this file exists;
//   - idempotent via the window.__SP_CORE_HOOKS marker (first evaluation wins and keeps polling);
//   - per-item kill switches: window.__SP_CORE_HOOKS_OFF = { recordResult:true, ... } (live);
//   - ES5 only (var / function / IIFE), ASCII only. The single modern-syntax use is the dynamic
//     import() of /js/ui/components.js for __SP_BACK (the same pattern lobby.js already uses);
//     it is guarded and its absence only degrades __SP_BACK, never breaks the page.
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__SP_CORE_HOOKS) return; // idempotent

  var POLL_MS = 150;
  var POLL_MAX_TRIES = 400; // ~60s: boot ends ~1.5s after load; give up long after any start
  var tries = 0;
  var timer = null;
  var wired = false;

  // /js/ui/components.js refs, warmed as soon as we are wired (needed only by __SP_BACK).
  var ui = { closeAllDialogs: null, confirmDialog: null, loading: false };
  var pendingClose = false;

  function sp() {
    try { return window.__SP__ || null; } catch (e) { return null; }
  }

  function spData() {
    try { return window.__SP_DATA || null; } catch (e) { return null; }
  }

  function isOff(name) {
    try { return !!(window.__SP_CORE_HOOKS_OFF && window.__SP_CORE_HOOKS_OFF[name]); }
    catch (e) { return false; }
  }

  /** A copy of a server message without the transport fields (the page's own payload()). */
  function payload(msg) {
    var out = {};
    if (!msg || typeof msg !== 'object') return out;
    for (var k in msg) {
      if (Object.prototype.hasOwnProperty.call(msg, k) && k !== 't' && k !== 'rid') out[k] = msg[k];
    }
    return out;
  }

  function assign(target, a, b) {
    var out = target || {};
    var i, src, key;
    for (i = 1; i < arguments.length; i++) {
      src = arguments[i];
      if (!src) continue;
      for (key in src) { if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key]; }
    }
    return out;
  }

  // Same predicate as the page's spectator check (store.js isSpectating, 0.1.4:113).
  function isSpectating(room, myId) {
    if (myId == null || !room || !Array.isArray(room.spectators)) return false;
    for (var i = 0; i < room.spectators.length; i++) {
      var s = room.spectators[i];
      if (s && s.playerId === myId) return true;
    }
    return false;
  }

  // ---- hook 1: room.state -> __SP_DATA.recordRoom (settings-v3.4) --------------------------------
  // The patch sat AFTER the page's own seat check and the `store.set({ room })` that follows it, so
  // a room.state that unseats us (kicked / left elsewhere, not spectating) never reached
  // recordRoom. We replicate that predicate so the recorded profile stays identical.
  function onRoomState(msg) {
    try {
      if (isOff('recordRoom')) return;
      var inst = sp();
      if (!inst || !inst.store || typeof inst.store.get !== 'function') return;
      var d = spData();
      if (!d || typeof d.recordRoom !== 'function') return;
      var room = payload(msg);
      var st = inst.store.get();
      var myId = st && st.me ? st.me.playerId : null;
      var seats = Array.isArray(room.seats) ? room.seats : [];
      var seated = false;
      for (var i = 0; i < seats.length; i++) {
        if (seats[i] && seats[i].playerId === myId) { seated = true; break; }
      }
      if (myId != null && seats.length && !seated && !isSpectating(room, myId)) return;
      d.recordRoom(room);
    } catch (e) { /* never break the game */ }
  }

  // ---- hooks 2+3: m.result -> __SP_DATA.recordResult (settings-v3.4 + v4.10) ---------------------
  function onResult(msg) {
    try {
      if (isOff('recordResult')) return;
      var inst = sp();
      if (!inst || !inst.store || typeof inst.store.get !== 'function') return;
      var d = spData();
      if (!d || typeof d.recordResult !== 'function') return;
      var st = inst.store.get() || {};
      var room = st.room;
      var match = st.match;
      var mode = (room && room.mode) || (match && match.public && (match.public.mode || match.public.modeId));
      d.recordResult(payload(msg), {
        roomCode: (room && room.code) || undefined,
        mode: mode || undefined,
        // v4.10: which row in result.players is OURS (the records panel shows that row).
        meId: (st.me && st.me.playerId) || undefined,
      });
    } catch (e) { /* never break the game */ }
  }

  // ---- hook 4: room sighting -> __SP_OBSERVE_ROOM (settings-v3.0) --------------------------------
  // The patch subscribed to the store and reported a NEW room object only:
  //   if (s.room && s.room.code && s.room !== prev?.room) window.__SP_OBSERVE_ROOM(s.room)
  function onStoreChange(s, prev) {
    try {
      if (isOff('observeRoom')) return;
      if (!s || !s.room || !s.room.code) return;
      if (prev && s.room === prev.room) return; // same object re-notified: not a new sighting
      var fn = window.__SP_OBSERVE_ROOM;
      if (typeof fn === 'function') fn(s.room);
    } catch (e) { /* never break the game */ }
    try { if (s.room && !prev.room) warmGameData(); } catch (e) { /* silent */ }
  }

  // ---- hook 5: window.__SP_BACK (settings-v5.4) --------------------------------------------------
  function emptyMatch() {
    return { public: null, private: null, field: null, result: null, battle: null };
  }

  /** Leave the room / match and land on the title (the patch's spBackToHome). Never throws. */
  function backToHome() {
    var inst = sp();
    if (!inst || !inst.store || typeof inst.store.set !== 'function') return;
    try {
      if (inst.net && typeof inst.net.request === 'function') {
        var p = inst.net.request('room.leave', {});
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    } catch (e) { /* offline / old protocol: still clear local state */ }
    try { inst.store.set({ room: null, match: emptyMatch() }); } catch (e) { /* ignore */ }
    try {
      var s = inst.store.get() || {};
      inst.store.set({ session: assign({}, s.session, { entered: false }) });
    } catch (e) { /* ignore */ }
  }

  /** Warm /js/ui/components.js (closeAllDialogs + confirmDialog) for __SP_BACK. Idempotent. */
  function loadUi() {
    if (ui.loading || (typeof ui.closeAllDialogs === 'function' && typeof ui.confirmDialog === 'function')) return;
    ui.loading = true;
    var pr = null;
    try {
      var imp = (typeof window.__SP_CORE_HOOKS_IMPORT === 'function') ? window.__SP_CORE_HOOKS_IMPORT : null;
      pr = imp ? imp('/js/ui/components.js') : import('/js/ui/components.js');
    } catch (e) { ui.loading = false; return; }
    if (!pr || typeof pr.then !== 'function') { ui.loading = false; return; }
    pr.then(function (m) {
      ui.loading = false;
      if (m) {
        ui.closeAllDialogs = typeof m.closeAllDialogs === 'function' ? m.closeAllDialogs : null;
        ui.confirmDialog = typeof m.confirmDialog === 'function' ? m.confirmDialog : null;
      }
      if (pendingClose && typeof ui.closeAllDialogs === 'function') {
        pendingClose = false;
        try { ui.closeAllDialogs(); } catch (e) { /* ignore */ }
      }
    }).catch(function () { ui.loading = false; });
  }

  function closeDialogs() {
    if (typeof ui.closeAllDialogs === 'function') {
      try { ui.closeAllDialogs(); } catch (e) { /* ignore */ }
      return;
    }
    pendingClose = true; // closed as soon as components.js finishes loading
    loadUi();
  }

  function askExitMatch() {
    if (typeof ui.confirmDialog === 'function') {
      try {
        var pr = ui.confirmDialog({
          title: '\u9000\u51fa\u5bf9\u5c40',
          text: '\u6b63\u5728\u5bf9\u5c40\u4e2d\uff0c\u9000\u51fa\u5e76\u56de\u5230\u9996\u9875\uff1f',
          okText: '\u9000\u51fa',
          danger: true,
        });
        if (pr && typeof pr.then === 'function') {
          pr.then(function (ok) { if (ok) backToHome(); }).catch(function () {});
        }
        return;
      } catch (e) { /* fall through to the native fallback */ }
    }
    // components.js not loaded yet: a synchronous native confirm is the only fallback left.
    try {
      if (typeof window.confirm === 'function' && window.confirm('\u6b63\u5728\u5bf9\u5c40\u4e2d\uff0c\u9000\u51fa\u5e76\u56de\u5230\u9996\u9875\uff1f')) backToHome();
    } catch (e2) { /* ignore */ }
  }

  /**
   * Synchronous Android back-key hook (Java MainActivity calls window.__SP_BACK()).
   * true = the page consumed the key (do NOT go back); false = hand it to the system.
   * Any exception returns false -- never wedge the back key. Mirrors settings-v5.4.
   */
  function spBack() {
    try {
      if (isOff('back')) return false;
      var inst = sp();
      if (!inst || !inst.store || typeof inst.store.get !== 'function') return false;
      // 1) an overlay (game dialog / shell in-page panel both use .modal) closes first.
      var overlay = false;
      try {
        overlay = !!(typeof document !== 'undefined' && document.querySelector && document.querySelector('.modal'));
      } catch (e) { overlay = false; }
      if (overlay) {
        closeDialogs();
        try {
          if (window.__SP_SHELL && typeof window.__SP_SHELL.openPanel === 'function') window.__SP_SHELL.openPanel(null);
        } catch (e2) { /* ignore */ }
        return true;
      }
      var s = inst.store.get() || {};
      // 2) title screen (store.js selectRoute: route is 'title' iff session.entered is falsy).
      if (!(s.session && s.session.entered)) return false;
      // 3) in a match: confirm, then leave for home; either way the key is consumed.
      if (s.match && s.match.public && s.match.public.phase) {
        askExitMatch();
        return true;
      }
      // 4) room / lobby: leave the alliance and go home.
      backToHome();
      return true;
    } catch (e) { return false; }
  }

  // ---- hooks 6+7: localStorage mirrors (settings-v3.4 \u7684 net.js / loadoutSync \u4e24\u6761) ----------
  // \u4e0a\u6e38\u628a\u6635\u79f0\u5199\u5728 localStorage['sp.name']\uff08net.js \u7684 K_NAME\uff09\uff0c\u628a\u5e72\u5458\u8c03\u914d\u5199\u5728
  // localStorage['sp.pref.loadout']\uff08store.js loadPref \u7684 sp.pref. \u524d\u7f00 + loadoutModel.LOADOUT_PREF\uff09\u3002
  // extras \u4e0e\u9875\u9762\u540c\u6e90 \u2192 \u76f4\u63a5\u8bfb\u540c\u4e00\u4e2a\u952e + \u5305\u4e00\u5c42 setItem \u5c31\u80fd\u590d\u523b
  // \u300c\u8bfb/\u5199\u65f6\u90fd\u5582 player-data\u300d\uff0c\u4e0d\u9700\u8981\u6539\u9875\u9762\u6a21\u5757\u3001\u4e5f\u4e0d\u4f9d\u8d56 __SP__\u3002
  var LS_NAME = 'sp.name';
  var LS_LOADOUT = 'sp.pref.loadout';
  var storageWrapped = false;

  function mirrorName() {
    try {
      if (isOff('recordProfile')) return;
      var d = spData();
      if (!d || typeof d.recordProfile !== 'function') return;
      var name = window.localStorage ? window.localStorage.getItem(LS_NAME) : null;
      if (name) d.recordProfile(String(name).slice(0, 64));
    } catch (e) { /* silent */ }
  }

  function mirrorLoadout() {
    try {
      if (isOff('recordLoadout')) return;
      var d = spData();
      if (!d || typeof d.recordLoadout !== 'function') return;
      var raw = window.localStorage ? window.localStorage.getItem(LS_LOADOUT) : null;
      if (!raw) return;
      var parsed = JSON.parse(raw);
      // \u4e0a\u6e38 parseStored \u7684\u5f62\u72b6\u9009\u62e9\uff1a{ v, entries } \u6216\u88f8 map\uff1b\u9010\u6761\u6d17\u6da4\u7531 player-data \u81ea\u5df1\u505a\u3002
      var entries = (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object')
        ? parsed.entries : parsed;
      if (entries && typeof entries === 'object') d.recordLoadout(entries);
    } catch (e) { /* silent */ }
  }

  /** \u5305\u4e00\u5c42 localStorage.setItem\uff1a\u9875\u9762\u5199\u6635\u79f0/\u5e72\u5458\u8c03\u914d\u65f6\u540c\u6b65\u5582 player-data\uff08\u5bf9\u5e94\u8865\u4e01\u91cc saveName / setEntries \u7684\u4e24\u5904\uff09\u3002 */
  function wrapStorage() {
    if (storageWrapped) return;
    try {
      if (!window.localStorage || typeof window.localStorage.setItem !== 'function') return;
      var orig = window.localStorage.setItem;
      storageWrapped = true;
      window.localStorage.setItem = function (k, v) {
        var out = orig.apply(window.localStorage, arguments);
        try {
          if (k === LS_NAME) mirrorName();
          else if (k === LS_LOADOUT) mirrorLoadout();
        } catch (e) { /* never break the page's write */ }
        return out;
      };
    } catch (e) { /* private mode / frozen storage: silent */ }
  }

  function mirrorAll() {
    mirrorName();
    mirrorLoadout();
    wrapStorage();
  }

  // ---- hook 8: room warm-up (settings-v5.4 \u7684 warmGameData) ---------------------------------
  // \u4e0a\u6e38\u5728\u300c\u521a\u8fdb\u623f\u95f4\u300d\u65f6\u63d0\u524d\u628a\u5bf9\u5c40\u7528\u7684 data/*.json \u62c9\u8d77\u6765\uff08data.loadAll(GAME_FILES)\uff09\u3002
  // GAME_FILES \u5728\u9875\u9762\u6a21\u5757 ui/gameComponents.js \u91cc\uff08\u5df2\u5bfc\u51fa\uff0c\u53ef import\uff09\uff0c
  // loadAll \u6302\u5728 __SP__.data \u4e0a\uff0c\u6240\u4ee5 extras \u80fd\u7cbe\u786e\u590d\u523b\uff1b\u62c9\u4e0d\u5230\u5c31\u9759\u9ed8\u8df3\u8fc7
  // \uff08\u53ea\u662f\u9884\u70ed\uff0c\u4e0d\u5f71\u54cd\u6b63\u5e38\u52a0\u8f7d\uff09\u3002
  var warmed = false;

  function warmGameData() {
    try {
      if (isOff('warmGameData') || warmed) return;
      var inst = sp();
      if (!inst || !inst.data || typeof inst.data.loadAll !== 'function') return;
      warmed = true;
      var go = function () {
        var imp = (typeof window.__SP_CORE_HOOKS_IMPORT === 'function') ? window.__SP_CORE_HOOKS_IMPORT : null;
        var pr = null;
        try { pr = imp ? imp('/js/ui/gameComponents.js') : import('/js/ui/gameComponents.js'); }
        catch (e) { return; }
        Promise.resolve(pr).then(function (m) {
          try { if (m && m.GAME_FILES) inst.data.loadAll(m.GAME_FILES); } catch (e) { /* silent */ }
        }, function () { /* silent */ });
      };
      try {
        if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(go, { timeout: 2500 });
        else window.setTimeout(go, 600);
      } catch (e) { go(); }
    } catch (e) { /* silent */ }
  }

  /** Wire onto the page's real instances once __SP__ exists. Returns true when wired. */
  function attach() {
    if (wired) return true;
    var inst = sp();
    if (!inst || !inst.net || typeof inst.net.on !== 'function' ||
        !inst.store || typeof inst.store.get !== 'function' ||
        typeof inst.store.subscribe !== 'function') return false;
    var offState = null;
    var offResult = null;
    var offSub = null;
    try {
      offState = inst.net.on('room.state', onRoomState);
      offResult = inst.net.on('m.result', onResult);
      offSub = inst.store.subscribe(onStoreChange);
      window.__SP_BACK = spBack;
      wired = true;
      mirrorAll(); // hooks 6+7\uff1alocalStorage \u955c\u50cf\uff08\u4e0d\u4f9d\u8d56 __SP__\uff0c\u8bfb\u540c\u4e00\u4e2a\u952e\u5373\u53ef\uff09
    } catch (e) {
      // Partial subscribe (an earlier registration succeeded, a later one threw): undo everything
      // so a retry cannot end up registered twice. net.on / store.subscribe return unsubscribers.
      try { if (typeof offState === 'function') offState(); } catch (e2) { /* ignore */ }
      try { if (typeof offResult === 'function') offResult(); } catch (e3) { /* ignore */ }
      try { if (typeof offSub === 'function') offSub(); } catch (e4) { /* ignore */ }
      try { if (window.__SP_BACK === spBack) delete window.__SP_BACK; } catch (e5) { /* ignore */ }
      offState = offResult = offSub = null;
      wired = false; // stay alive; the poll keeps trying (a partially broken page may recover)
    }
    if (wired) loadUi(); // warm components.js now so __SP_BACK is fully armed by first use
    return wired;
  }

  function tick() {
    if (wired) return;
    if (attach()) { stopPolling(); return; }
    tries += 1;
    if (tries >= POLL_MAX_TRIES) stopPolling(); // silent give-up: the page just runs un-hooked
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

  // Diagnostics + test surface. debug() is read-only; the rest are for tests / the shell.
  window.__SP_CORE_HOOKS = {
    version: 1,
    debug: function () {
      return {
        wired: wired, tries: tries, polling: timer !== null,
        back: typeof window.__SP_BACK === 'function',
        ui: { closeAllDialogs: typeof ui.closeAllDialogs === 'function', confirmDialog: typeof ui.confirmDialog === 'function' },
      };
    },
    attach: attach,
    tick: tick,
    back: spBack,
  };

  start();
})();
