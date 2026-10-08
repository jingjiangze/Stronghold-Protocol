/* global window, document */
// server-config.js -- the page-side view of the CURRENT server's declarative config.
//
// The server publishes /.well-known/stronghold-client.json (or /stronghold-client.json on a stock
// upstream server, which 404s dot-segment paths). The shell fetches, validates and caches it in
// Java (ServerConfigHub) and hands the snapshot to this module through the native bridge. This file
// NEVER fetches the config itself and NEVER evaluates anything from it: it is a read-only view plus
// a change notification.
//
// Why a bridge instead of a plain fetch: the config carries server-controlled values (announcement
// text, feature flags, matchmaking params). One parse/validate path in Java means one place to
// audit -- a second parser in JS would be a second place to get the rules wrong.
//
// API (window.__SP_SERVER_CONFIG):
//   get()            -> the raw snapshot object (never null; {} when no config)
//   version()        -> integer version, 0 when none
//   announce()       -> {title, body, level} or null
//   matchmaking()    -> {enabled, endpoint, modes, partySize, queueTimeoutSec} or null
//   feature(id)      -> {id, enabled, mode, startAt, endAt} or null  (unknown id -> null)
//   enabled(id)      -> boolean (absent/disabled/outside its window -> false)
//   packs()          -> [{id, version}] trusted feature-pack references
//   serverId()       -> string
//   refresh()        -> request an async refresh (returns false when unsupported/offline)
//   onChange(fn)     -> subscribe; fn(config) on every version change
//
// Everything degrades to "no config": an absent bridge, a null snapshot or a malformed field must
// never break the page -- the server config is an enhancement, not a dependency.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.__SP_SERVER_CONFIG && window.__SP_SERVER_CONFIG.__spReady) return;

  var NATIVE = (window.shell && typeof window.shell.serverConfig === 'function') ? window.shell : null;
  var listeners = [];
  var lastVersion = -1;
  var cache = null;

  // Parses the bridge payload. Any failure -> {} ("no config"), never throws: a broken config must
  // not be able to stop the page from loading. Arrays and primitives are not configs either -- a
  // JSON document that is not an object would make every accessor below return a bogus value.
  function parse(text) {
    if (!text || typeof text !== 'string') return {};
    try {
      var o = JSON.parse(text);
      return (o && Object.prototype.toString.call(o) === '[object Object]') ? o : {};
    } catch (e) {
      return {};
    }
  }

  function load() {
    var text = null;
    if (NATIVE) {
      try {
        text = NATIVE.serverConfig();
      } catch (e) {
        text = null; // a broken/throwing bridge is exactly "no config"
      }
    }
    cache = parse(text);
    return cache;
  }

  function snapshot() {
    if (cache === null) load();
    return cache;
  }

  function num(v) {
    var n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  }

  // Array check that works in an old WebView and across realms (the bridge payload is a plain JSON
  // value, but a hostile/incorrect one may be a string or an object -- those must never be sliced).
  function isArr(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  function announce() {
    var a = snapshot().announce;
    if (!a || typeof a !== 'object') return null;
    var title = typeof a.title === 'string' ? a.title : '';
    var body = typeof a.body === 'string' ? a.body : '';
    if (!title && !body) return null;
    return { title: title, body: body, level: typeof a.level === 'string' ? a.level : 'info' };
  }

  function matchmaking() {
    var m = snapshot().matchmaking;
    if (!m || typeof m !== 'object') return null;
    return {
      enabled: !!m.enabled,
      endpoint: typeof m.endpoint === 'string' ? m.endpoint : '/api/match',
      modes: isArr(m.modes) ? m.modes.slice() : [],
      partySize: num(m.partySize) || 4,
      queueTimeoutSec: num(m.queueTimeoutSec) || 60
    };
  }

  // Unknown feature id -> null. The caller decides what to do; we never invent a default-on feature.
  function feature(id) {
    if (!id) return null;
    var list = snapshot().features;
    if (!isArr(list)) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  function enabled(id) {
    var f = feature(id);
    if (!f || !f.enabled) return false;
    var now = nowMs();
    if (f.startAt && now < f.startAt) return false;
    if (f.endAt && now > f.endAt) return false;
    return true;
  }

  // Date.now() where available (it is, on every WebView this ships to), with a fallback so an
  // ancient engine still gets a correct clock instead of throwing.
  function nowMs() {
    return (Date.now) ? Date.now() : new Date().getTime();
  }

  function packs() {
    var p = snapshot().featurePacks;
    return isArr(p) ? p.slice() : [];
  }

  function version() {
    return num(snapshot().version);
  }

  function serverId() {
    var s = snapshot().serverId;
    return typeof s === 'string' ? s : '';
  }

  function refresh() {
    if (!NATIVE || typeof window.shell.serverConfigRefresh !== 'function') return false;
    try {
      window.shell.serverConfigRefresh();
      return true;
    } catch (e) {
      return false;
    }
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function notify() {
    var v = version();
    if (v === lastVersion) return;
    lastVersion = v;
    var cfg = snapshot();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](cfg); } catch (e) { /* one bad listener must not stop the rest */ }
    }
  }

  var api = {
    __spReady: true,
    get: snapshot,
    version: version,
    serverId: serverId,
    announce: announce,
    matchmaking: matchmaking,
    feature: feature,
    enabled: enabled,
    packs: packs,
    refresh: refresh,
    onChange: onChange,
    // Re-reads the bridge. Called by the shell when it learns the config changed; also safe to call
    // any time (cheap: one bridge call, no network).
    reload: function () { load(); notify(); return snapshot(); }
  };

  window.__SP_SERVER_CONFIG = api;
  load();
  lastVersion = version();

  // The shell pushes __SP_SERVER_CONFIG_CHANGED after a successful refresh; polling is only a
  // fallback for the plain-web build where the bridge is absent.
  try {
    window.addEventListener('__SP_SERVER_CONFIG_CHANGED', function () { api.reload(); });
  } catch (e) { /* no window listener support: reload() stays available to callers */ }
})();
