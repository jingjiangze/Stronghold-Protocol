/* global window */ // browser global: overlay scripts live in the tools tree (the ESLint node preset covers it)
// shell-prefs.js -- the shell's cross-origin settings namespace (hot-updatable overlay).
//
// WHY: most shell settings used to live ONLY in per-origin localStorage, so switching servers
// (rainya / the box / a community server = a different origin) silently lost them, and a WebView
// storage wipe lost them too. The player-data v1 vault (filesDir/player-v1.json via window.spData /
// window.__SP_DATA) is origin-independent, so this module mirrors every shell pref through it:
//
//   localStorage['<ls>']  = fast path / cache for the CURRENT origin (kept, so nothing regresses)
//   player-v1 doc.prefs   = cross-origin source of truth ({v:1,settings:{key:{value,ts}}})
//
// PRECEDENCE (documented, per key):
//   1. On boot each key is resolved by (ts) among: the vault, the local cache, and (for a few keys)
//      a legacy source (doc.settings for appearance, the Java bridge for transport). The newest ts
//      wins; a tie goes to the vault. So the vault wins on boot unless this origin has an unflushed,
//      strictly newer local write.
//   2. The winner is written back to BOTH stores: a vault winner materialises into the local cache;
//      a local/legacy winner seeds/upgrades the vault (MIGRATION -- never overwrite a newer vault
//      value with an older origin value).
//   3. Any later explicit user change calls __SP_PREFS.set(), which stamps Date.now() and writes
//      through to the local cache (immediately) and the vault (debounced by player-data's 2s flush).
//      The latest explicit change in ANY origin therefore becomes the new truth.
//
// SAFETY: no vault (old APK / bridge absent / player-data not loaded) -> __SP_PREFS behaves exactly
// like localStorage today; every access is guarded and never throws. No network, no page module.
//
// API (window.__SP_PREFS): get(key) -> value|null, set(key, value[, ts]) -> bool,
//   remove(key) -> bool, stamp(key) -> number, keys() -> string[], flush() -> void,
//   available (bool: the vault is reachable).
//
// Keys covered (registry below): appearance (fontScale/sidePad), notice.seen (bulletin read state),
// lobby.tokens (own-room tokens), lobby.difficulty (last difficulty), lobby.filter (room filter),
// server (last/custom server choice), transport (join transport tier). Callers degrade to their own
// localStorage path when this module is absent.
//
// Discipline: ES5 (var/function/IIFE), pure ASCII, idempotent (window.__SP_PREFS guard).
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.__SP_PREFS && typeof window.__SP_PREFS.get === 'function') return; // idempotent

  var DEFAULT_PREFIX = 'sp.pref.'; // a registry key without an explicit ls name maps to sp.pref.<key>

  // ---- registry ------------------------------------------------------------------------------------
  // Each entry: { key: vault key, ls: localStorage cache key, legacy: optional seed source }.
  // The legacy hook returns {value, ts} or null -- it only ever wins when strictly newer than both stores.

  /** appearance legacy: fontScale/sidePad used to be mirrored into the player-data settings blob
   *  (doc.settings) by the pre-v8 appearance.js. Seed the namespace from it once, if non-default. */
  function legacyAppearance() {
    try {
      var D = window.__SP_DATA;
      if (!D || typeof D.exportJSON !== 'function') return null;
      var doc = JSON.parse(D.exportJSON());
      var s = doc && doc.settings;
      if (!s || typeof s !== 'object') return null;
      var f = (typeof s.fontScale === 'number' && isFinite(s.fontScale)) ? s.fontScale : 1;
      var p = (typeof s.sidePad === 'number' && isFinite(s.sidePad)) ? s.sidePad : 0;
      if (f === 1 && p === 0) return null; // defaults: nothing to migrate
      return { value: { fontScale: f, sidePad: p }, ts: (typeof s.ts === 'number' && isFinite(s.ts)) ? s.ts : 0 };
    } catch (e) { return null; }
  }

  /** transport legacy: on the App the tier lives in Java SharedPreferences (shell.getTransport).
   *  Seed the namespace from it once (ts 0, so any real write outranks it). */
  function legacyTransport() {
    try {
      if (window.shell && typeof window.shell.getTransport === 'function') {
        var v = window.shell.getTransport();
        if (typeof v === 'string' && v) return { value: v, ts: 0 };
      }
    } catch (e) { /* old shell / no bridge */ }
    return null;
  }

  var REGISTRY = [
    { key: 'appearance', ls: 'sp.appearance', legacy: legacyAppearance },
    { key: 'notice.seen', ls: 'sp.notice.seen' },
    { key: 'lobby.tokens', ls: 'sp.lobby.tokens' },
    // lobby.difficulty is written by the upstream game (store.js savePref) WITHOUT a ts, so we cannot
    // order it by stamp: a present local cache always wins (it may be a fresh in-game write), and is
    // then pushed into the vault so other origins pick it up on their next (empty-cache) boot.
    { key: 'lobby.difficulty', ls: 'sp.pref.lobby.difficulty', localFirst: true },
    { key: 'lobby.filter', ls: 'sp.lobby.filter' },
    { key: 'server', ls: 'sp.pref.server' },
    { key: 'transport', ls: 'sp.pref.transport', legacy: legacyTransport },
  ];

  function lsKeyOf(key) {
    for (var i = 0; i < REGISTRY.length; i++) {
      if (REGISTRY[i].key === key) return REGISTRY[i].ls;
    }
    return DEFAULT_PREFIX + key;
  }

  // ---- helpers -------------------------------------------------------------------------------------

  function now() { try { return Date.now(); } catch (e) { return 0; } }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /** The vault (player-data v1 doc.prefs), or null when the bridge / API is absent. */
  function vault() {
    try {
      var D = window.__SP_DATA;
      if (D && typeof D.prefsGet === 'function' && typeof D.prefsSet === 'function'
        && typeof D.prefsStamp === 'function' && typeof D.prefsRemove === 'function') return D;
    } catch (e) { /* no bridge */ }
    return null;
  }

  /** A copy of an object value without its ts field (the stamp lives beside the value, never inside it). */
  function stripTs(o) {
    var out = {}, k;
    for (k in o) {
      if (Object.prototype.hasOwnProperty.call(o, k) && k !== 'ts') out[k] = o[k];
    }
    return out;
  }

  function normalizeValue(value) {
    if (isObj(value)) return stripTs(value);
    return value;
  }

  // ---- localStorage cache --------------------------------------------------------------------------

  function readLocal(ls) {
    var raw = null;
    try { raw = window.localStorage ? window.localStorage.getItem(ls) : null; } catch (e) { return null; }
    if (raw == null || raw === '') return null;
    var value = raw, ts = 0;
    try {
      var p = JSON.parse(raw);
      if (isObj(p)) {
        if (typeof p.ts === 'number' && isFinite(p.ts)) ts = p.ts;
        value = stripTs(p);
      } else {
        value = p; // number / bool / null / array
      }
    } catch (e) { value = raw; } // a bare string (e.g. a notice revision) is not JSON
    return { value: value, ts: ts };
  }

  function writeLocal(ls, value, ts) {
    try {
      if (!window.localStorage) return false;
      var text;
      if (isObj(value)) {
        var o = stripTs(value);
        o.ts = ts;
        text = JSON.stringify(o);
      } else if (typeof value === 'string') {
        text = value; // keep the legacy raw-string shape (notice.seen) readable by older readers
      } else {
        text = JSON.stringify(value);
      }
      window.localStorage.setItem(ls, text);
      return true;
    } catch (e) { return false; } // private mode / quota
  }

  // ---- boot: per-key LWW + migration ---------------------------------------------------------------

  var state = {}; // key -> { value, ts } (the in-memory fast path)

  function bootOne(reg) {
    var D = vault();
    var local = readLocal(reg.ls);
    var legacy = reg.legacy ? reg.legacy() : null;
    var vVal = D ? D.prefsGet(reg.key) : undefined;
    var vTs = D ? D.prefsStamp(reg.key) : 0;
    var has = false, winner = null, winnerTs = 0, from = '';
    if (vVal !== undefined) { winner = vVal; winnerTs = vTs; from = 'vault'; has = true; }
    if (local && (reg.localFirst || !has || local.ts > winnerTs)) { winner = local.value; winnerTs = local.ts; from = 'local'; has = true; }
    if (legacy && (!has || legacy.ts > winnerTs)) { winner = legacy.value; winnerTs = legacy.ts; from = 'legacy'; has = true; }
    if (!has) return;
    state[reg.key] = { value: winner, ts: winnerTs };
    if (from !== 'vault' && D) D.prefsSet(reg.key, winner, winnerTs); // migration / local upgrade
    if (from !== 'local') writeLocal(reg.ls, winner, winnerTs);       // materialise the vault value
  }

  function boot() {
    for (var i = 0; i < REGISTRY.length; i++) {
      try { bootOne(REGISTRY[i]); } catch (e) { /* one bad key never breaks the rest */ }
    }
  }

  // The shell loader appends player-data.js / shell-bridge.js as dynamic scripts, so this module can
  // (rarely) run before window.__SP_DATA exists. Retry the vault merge lazily on the first read/write
  // after the bridge shows up -- otherwise a boot without the vault would skip migration silently.
  var bootedWithVault = false;
  function ensureVaultBoot() {
    if (bootedWithVault) return;
    if (!vault()) return;
    boot();
    bootedWithVault = true;
  }

  // ---- public API ----------------------------------------------------------------------------------

  function get(key) {
    if (typeof key !== 'string' || !key) return null;
    ensureVaultBoot();
    if (Object.prototype.hasOwnProperty.call(state, key)) return state[key].value;
    var D = vault();
    if (D) {
      try {
        var v = D.prefsGet(key);
        if (v !== undefined) return v;
      } catch (e) { /* a broken bridge falls through to the local cache */ }
    }
    var l = readLocal(lsKeyOf(key));
    return l ? l.value : null;
  }

  function set(key, value, ts) {
    if (typeof key !== 'string' || !key || key.length > 64) return false;
    ensureVaultBoot();
    var t = (typeof ts === 'number' && isFinite(ts)) ? ts : now();
    var v = normalizeValue(value);
    state[key] = { value: v, ts: t };
    writeLocal(lsKeyOf(key), v, t);            // fast path (immediate)
    var D = vault();
    if (D) {
      try { D.prefsSet(key, v, t); } catch (e) { /* a failed vault write must never break the caller */ }
    }
    return true;
  }

  function remove(key) {
    if (typeof key !== 'string' || !key) return false;
    try { delete state[key]; } catch (e) { state[key] = undefined; }
    try { if (window.localStorage) window.localStorage.removeItem(lsKeyOf(key)); } catch (e) { /* ignore */ }
    var D = vault();
    if (D) {
      try { D.prefsRemove(key); } catch (e) { /* ignore */ }
    }
    return true;
  }

  function stamp(key) {
    if (Object.prototype.hasOwnProperty.call(state, key)) return state[key].ts;
    var D = vault();
    if (D) {
      try { return D.prefsStamp(key); } catch (e) { /* fall through */ }
    }
    var l = readLocal(lsKeyOf(key));
    return l ? l.ts : 0;
  }

  function keys() {
    var out = [];
    for (var i = 0; i < REGISTRY.length; i++) out.push(REGISTRY[i].key);
    return out;
  }

  function flush() {
    try { if (window.__SP_DATA && typeof window.__SP_DATA.flush === 'function') window.__SP_DATA.flush(); } catch (e) { /* ignore */ }
  }

  try {
    boot();
    bootedWithVault = !!vault(); // when false, the first get/set after __SP_DATA lands re-runs boot()
    window.__SP_PREFS = {
      get: get,
      set: set,
      remove: remove,
      stamp: stamp,
      keys: keys,
      flush: flush,
      available: !!vault(),
      _registry: REGISTRY.map(function (r) { return { key: r.key, ls: r.ls }; }),
    };
  } catch (e) { /* never break the page */ }
})();
