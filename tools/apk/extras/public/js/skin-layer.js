// skin-layer.js -- local-skin mechanism layer (no UI). Hot-updatable: loaded by shell-bridge.js from
// '/__sp/skin-layer.js' (the shell's own prefix: serveShellAsset reads the filesDir hot tree first, then the
// APK -- it never goes to the network).
//
// What it does: lets this device render a chosen operator with a replacement art set (avatar / portrait /
// Spine model) WITHOUT touching any upstream file, any page module, or the Image.src crossOrigin guard.
//
// Interception point (evidence: docs/ASSETS.md and public/js/assets.js of the 0.1.4 client):
//   Every operator art URL the client uses is resolved from ONE manifest object, /data/assets.json:
//     * public/js/assets.js          avatarUrl / portraitUrl / spineEntry / unitPictureUrl are pure helpers
//                                    reading manifest.chars[<charId>] (avatar, avatarE2, portrait, portraitE2,
//                                    spine.front / spine.back { skel, atlas, textures[] }); the store
//                                    singleton wraps them (createAssets -> assets.avatar/portrait/spineEntry/
//                                    picture) and the Spine loader feeds entry.skel to PIXI.Assets.load.
//     * public/js/ui/assetUrls.js    chessAvatarUrl / chessPortraitUrl read the same data.get('assets') copy.
//   The manifest itself is only ever obtained with window.fetch -- data.js readJson -> doFetch and
//   assets.js ready() -> doFetch -- so wrapping window.fetch and rewriting the JSON body for
//   /data/assets.json makes both resolvers -- and any later re-resolution (assets.onChange) -- see the skin
//   URLs directly. No function override, no module ordering dependency, and the CORS Image.src patch stays
//   untouched (spine .skel/.atlas are fetched as text/binary, not via <img>, so an Image.src rewrite could
//   not skin a model anyway).
//
// Catalog (the skin mapping) is read from local sources only:
//   1) window.__SP_SKINS -- an inline object (native shell / tests); otherwise
//   2) XHR GET '/__sp/skins.json' -- on the APK that prefix is always local (MainActivity serveShellAsset ->
//      openLocal: filesDir hot tree, then the embedded webroot). Any failure (404, timeout, bad JSON) is a
//      clean global no-op.
//
// Selection (which operator wears which skin) is read in this order, first hit per operator wins:
//   1) player data (truth): window.__SP_DATA.exportJSON() -> doc.skins;
//   2) App bridge raw doc:   window.spData.get()        -> doc.skins;
//   3) injected override:    window.__SP_SKIN_SELECT    ({ charId: skinKey } or { skins: {...} });
//   4) this origin mirror:   localStorage['sp.skin.v1'] ({ v:1, skins: { charId: skinKey } }).
//   Nothing found == nothing replaced (the default).
//
// Catalog schema (v1):
//   { "v": 1,
//     "default": { "<charId>": "<skinKey>" },              // optional; used when the player selected nothing
//     "skins": { "<charId>": { "<skinKey>": {
//        "name": "display name (optional)",
//        "replace": { "<from URL or dir prefix>": "<to URL or dir prefix>" } } } } }
//   Rules are matched against the URL *path* (origin / query / hash ignored), exact first, then longest
//   prefix; a prefix rule is a key that ends with '/'. Same-origin absolute paths ('/assets/...') are the
//   expected targets; absolute http(s) targets are accepted only for non-loopback, non-private hosts.
//   Packaging rules (documented, not guessed): a replacement .skel must keep its <name>.atlas sibling in the
//   same directory with the same base name -- the pixi-spine loader derives the atlas URL from the skel URL.
//
// Failure policy: every step is guarded; any error degrades to "no skin" (identity resolve, manifest passed
// through untouched). Idempotent: a second load of this file does nothing.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (typeof window.__SP_SKIN === 'object' && window.__SP_SKIN && typeof window.__SP_SKIN.resolve === 'function') return;

  var VERSION = 1;
  var CATALOG_URL = '/__sp/skins.json';
  var CATALOG_TIMEOUT_MS = 8000;
  var MANIFEST_SUFFIX = '/data/assets.json';
  var SEL_LS_KEY = 'sp.skin.v1';
  var CHAR_URL_FIELDS = ['avatar', 'avatarE2', 'portrait', 'portraitE2'];
  var SPINE_SIDES = ['front', 'back'];

  var catalog = null;          // validated catalog (null = none / not read)
  var catalogSettled = false;  // the one-shot catalog read has finished (success or failure)
  var readyFns = [];           // onReady callbacks queued before the read settled
  var rules = [];              // active rules, longest 'from' first
  var ruleTargets = [];        // active targets (paths) -- idempotence guard
  var activeSkinOf = {};       // charId -> skinKey (effective)

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str(v) { return typeof v === 'string' && v ? v : null; }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /** URL -> pure path (origin / query / hash dropped); null unless it is http(s) or site-absolute. */
  function pathOf(u) {
    var s = str(u);
    if (!s) return null;
    var i = s.indexOf('?');
    if (i >= 0) s = s.slice(0, i);
    i = s.indexOf('#');
    if (i >= 0) s = s.slice(0, i);
    if (s.charAt(0) === '/') return s.slice(0, 2) === '//' ? null : s;
    var m = /^https?:\/\/[^\/]+(\/.*)?$/.exec(s);
    if (!m) return null;
    return m[1] || '/';
  }

  /** Is an absolute http(s) host acceptable? Rejects localhost, loopback, private and reserved ranges. */
  function hostAllowed(host) {
    var h = String(host || '').toLowerCase();
    if (!h) return false;
    if (h.charAt(0) === '[') {
      var end = h.indexOf(']');
      if (end < 0) return false;
      h = h.slice(1, end);
    } else {
      var colon = h.indexOf(':');
      if (colon >= 0) h = h.slice(0, colon);
    }
    if (!h) return false;
    if (h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '::1') return false;
    if (/\.(localhost|local|internal|home|lan)$/.test(h)) return false;
    if (h.indexOf(':') >= 0) return !/^(fc|fd|fe8|fe9|fea|feb)/.test(h); // other IPv6: allow, ULA/link-local out
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (m) {
      var o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      var k = 0;
      for (k = 0; k < 4; k++) if (o[k] > 255) return false;
      if (o[0] === 0 || o[0] === 10 || o[0] === 127) return false;
      if (o[0] === 169 && o[1] === 254) return false;
      if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
      if (o[0] === 192 && o[1] === 168) return false;
      if (o[0] === 192 && o[1] === 0 && o[2] === 0) return false;
      if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return false;
      if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return false;
      if (o[0] >= 224) return false;
      return true;
    }
    return h.indexOf('.') > 0;
  }

  /** Skin target: a site-absolute path, or an http(s) URL on a public host. Anything else is dropped. */
  function targetAllowed(u) {
    var s = str(u);
    if (!s) return false;
    if (s.charAt(0) === '/') return s.slice(0, 2) !== '//' && s.length > 1;
    var m = /^https?:\/\/([^\/]*)(\/.*)$/.exec(s);
    if (!m) return false;
    if (m[1].indexOf('@') >= 0) return false; // userinfo: refuse
    return hostAllowed(m[1]);
  }

  /** One rule is '{ from, to, prefix }'; source paths only, prefix rules map directory to directory. */
  function ruleOf(from, to) {
    if (!targetAllowed(to)) return null;
    var fp = pathOf(from);
    if (!fp || fp.length < 2) return null;
    var prefix = fp.charAt(fp.length - 1) === '/';
    if (prefix && to.charAt(to.length - 1) !== '/') return null;
    return { from: fp, to: to, prefix: prefix };
  }

  /** Player selection + optional catalog default -> effective { charId: skinKey } with at least one rule. */
  function buildActive(selection) {
    var out = { rules: [], targets: [], skins: {} };
    if (!isObj(catalog) || !isObj(catalog.skins)) return out;
    var pick = {};
    var id = null;
    for (id in selection) if (hasOwn(selection, id) && str(selection[id])) pick[id] = selection[id];
    if (isObj(catalog.default)) {
      for (id in catalog.default) if (hasOwn(catalog.default, id) && !pick[id] && str(catalog.default[id])) pick[id] = catalog.default[id];
    }
    for (id in pick) {
      if (!hasOwn(pick, id)) continue;
      var defs = catalog.skins[id];
      var key = pick[id];
      var skin = isObj(defs) ? defs[key] : null;
      var replace = isObj(skin) && isObj(skin.replace) ? skin.replace : null;
      if (!replace) continue;
      var from = null;
      var n = 0;
      for (from in replace) {
        if (!hasOwn(replace, from)) continue;
        var r = ruleOf(from, str(replace[from]));
        if (!r) continue;
        out.rules.push(r);
        out.targets.push(pathOf(r.to) || r.to);
        n++;
      }
      if (n) out.skins[id] = key;
    }
    out.rules.sort(function (a, b) {
      if (b.from.length !== a.from.length) return b.from.length - a.from.length;
      return a.from < b.from ? -1 : a.from > b.from ? 1 : 0;
    });
    return out;
  }

  /** Resolve one URL through the active rules (idempotent: a target URL is never mapped again). */
  function mapUrl(u) {
    try {
      if (typeof u !== 'string' || !u) return u;
      if (!rules.length) return u;
      var p = pathOf(u);
      if (!p) return u;
      var i = 0;
      for (i = 0; i < ruleTargets.length; i++) {
        var t = ruleTargets[i];
        if (t.charAt(t.length - 1) === '/') { if (p.indexOf(t) === 0) return u; }
        else if (p === t) return u;
      }
      for (i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (r.prefix) { if (p.indexOf(r.from) === 0) return r.to + p.slice(r.from.length); }
        else if (p === r.from) return r.to;
      }
      return u;
    } catch (e) {
      return u;
    }
  }

  function mapField(rec, key) {
    if (!isObj(rec) || typeof rec[key] !== 'string') return;
    var next = mapUrl(rec[key]);
    if (next !== rec[key]) rec[key] = next;
  }

  function mapList(rec, key) {
    if (!isObj(rec) || !Array.isArray(rec[key])) return;
    var arr = rec[key];
    for (var i = 0; i < arr.length; i++) {
      if (typeof arr[i] !== 'string') continue;
      var next = mapUrl(arr[i]);
      if (next !== arr[i]) arr[i] = next;
    }
  }

  /** Rewrite the operator records of a parsed /data/assets.json (in place; only selected operators). */
  function rewriteChars(json) {
    var chars = isObj(json) && isObj(json.chars) ? json.chars : null;
    if (!chars) return;
    for (var id in activeSkinOf) {
      if (!hasOwn(activeSkinOf, id)) continue;
      var rec = chars[id];
      if (!isObj(rec)) continue;
      for (var i = 0; i < CHAR_URL_FIELDS.length; i++) mapField(rec, CHAR_URL_FIELDS[i]);
      var sp = rec.spine;
      if (!isObj(sp)) continue;
      for (var s = 0; s < SPINE_SIDES.length; s++) {
        var side = sp[SPINE_SIDES[s]];
        if (!isObj(side)) continue;
        mapField(side, 'skel');
        mapField(side, 'atlas');
        mapList(side, 'textures');
      }
    }
  }

  /** Manifest text -> skinned text (never throws; returns the input on any failure). */
  function rewriteManifestText(text) {
    if (typeof text !== 'string' || !text || !rules.length) return text;
    var json = null;
    try { json = JSON.parse(text); } catch (e) { return text; }
    if (!isObj(json)) return text;
    try { rewriteChars(json); } catch (e) { return text; }
    try { return JSON.stringify(json); } catch (e) { return text; }
  }

  /** Does this fetch input address the game asset manifest (any origin / query)? */
  function isManifestRequest(input) {
    var u = typeof input === 'string' ? input : (isObj(input) && typeof input.url === 'string' ? input.url : null);
    var p = pathOf(u);
    if (!p) return false;
    var n = p.length - MANIFEST_SUFFIX.length;
    if (n < 0 || p.slice(n) !== MANIFEST_SUFFIX) return false;
    return n === 0 || p.charAt(n - 1) === '/';
  }

  /** A Response for the rewritten body (status preserved; last resort: a minimal Response-like object). */
  function respond(text, res) {
    var status = res && res.status ? res.status : 200;
    var statusText = res && res.statusText ? res.statusText : '';
    try {
      return new Response(text, { status: status, statusText: statusText });
    } catch (e) {
      try { return new Response(text, { status: 200 }); } catch (e2) {
        return {
          ok: true, status: 200, statusText: '',
          text: function () { return Promise.resolve(text); },
          json: function () { return Promise.resolve(JSON.parse(text)); },
        };
      }
    }
  }

  /** Wrap window.fetch once: manifest responses get the skinned body; everything else passes through. */
  function installFetch() {
    var orig = window.fetch;
    if (typeof orig !== 'function' || window.__SP_SKIN_FETCH) return;
    window.__SP_SKIN_FETCH = 1;
    var wrapped = function (input, init) {
      var p = orig.apply(this, arguments);
      try {
        if (!rules.length) return p; // nothing to replace: the original promise, untouched
        if (!isManifestRequest(input) || typeof Response !== 'function') return p;
      } catch (e) { return p; }
      return Promise.resolve(p).then(function (res) {
        try {
          if (!res || !res.ok || typeof res.text !== 'function') return res;
          return Promise.resolve(res.text()).then(function (text) {
            var body = text;
            try { body = rewriteManifestText(text); } catch (e) { body = text; }
            return respond(body, res); // the body was read: hand out a fresh Response either way
          }, function () { return res; });
        } catch (e) { return res; }
      });
    };
    try { window.fetch = wrapped; } catch (e) { /* window not writable: no interception = no skin */ }
  }

  // ---- catalog (local only) -------------------------------------------------------------------

  /** Shape check: junk in, a small usable catalog or null out. Never throws. */
  function normalizeCatalog(raw) {
    if (!isObj(raw) || !isObj(raw.skins)) return null;
    var out = { v: VERSION, default: isObj(raw.default) ? raw.default : null, skins: {} };
    var any = false;
    for (var id in raw.skins) {
      if (!hasOwn(raw.skins, id)) continue;
      var defs = raw.skins[id];
      if (!isObj(defs)) continue;
      var keep = {};
      for (var key in defs) {
        if (!hasOwn(defs, key)) continue;
        var skin = defs[key];
        if (!isObj(skin) || !isObj(skin.replace)) continue;
        var rep = {};
        var n = 0;
        for (var from in skin.replace) {
          if (!hasOwn(skin.replace, from)) continue;
          if (typeof skin.replace[from] !== 'string') continue;
          rep[from] = skin.replace[from];
          n++;
        }
        if (!n) continue;
        keep[key] = { name: str(skin.name) || key, replace: rep };
      }
      for (var k2 in keep) { if (hasOwn(keep, k2)) { out.skins[id] = keep; any = true; break; } }
    }
    return any || out.default ? out : null;
  }

  function takeSkins(value, out) {
    if (!isObj(value)) return;
    var s = isObj(value.skins) ? value.skins : value;
    for (var id in s) if (hasOwn(s, id) && !out[id] && str(s[id])) out[id] = s[id];
  }

  function parseDoc(text) {
    if (typeof text !== 'string' || !text) return null;
    try { var d = JSON.parse(text); return isObj(d) ? d : null; } catch (e) { return null; }
  }

  /** Selection from player data (truth), the App bridge, the injected override, then the origin mirror. */
  function readSelection() {
    var out = {};
    try {
      var d = window.__SP_DATA;
      if (d && typeof d.exportJSON === 'function') takeSkins(parseDoc(d.exportJSON()), out);
    } catch (e) { /* no player data: keep looking */ }
    try {
      var b = window.spData;
      if (b && typeof b.get === 'function') takeSkins(parseDoc(b.get()), out);
    } catch (e) { /* no App bridge */ }
    try { takeSkins(window.__SP_SKIN_SELECT, out); } catch (e) { /* no override */ }
    try {
      var ls = window.localStorage;
      if (ls && typeof ls.getItem === 'function') takeSkins(parseDoc(ls.getItem(SEL_LS_KEY)), out);
    } catch (e) { /* private mode / no storage */ }
    return out;
  }

  function apply() {
    try {
      var built = buildActive(readSelection());
      rules = built.rules;
      ruleTargets = built.targets;
      activeSkinOf = built.skins;
      var n = 0;
      for (var id in activeSkinOf) if (hasOwn(activeSkinOf, id)) n++;
      return n;
    } catch (e) {
      rules = [];
      ruleTargets = [];
      activeSkinOf = {};
      return 0;
    }
  }

  function settle(raw) {
    catalog = normalizeCatalog(raw);
    catalogSettled = true;
    apply();
    var fns = readyFns;
    readyFns = [];
    for (var i = 0; i < fns.length; i++) { try { fns[i](); } catch (e) { /* listener failure is not ours */ } }
  }

  function readCatalog() {
    var inline = null;
    try { inline = window.__SP_SKINS; } catch (e) { inline = null; }
    if (isObj(inline)) { settle(inline); return; }
    try {
      if (typeof XMLHttpRequest !== 'function') { settle(null); return; }
      var xhr = new XMLHttpRequest();
      var done = false;
      var finish = function (raw) { if (done) return; done = true; settle(raw); };
      xhr.open('GET', CATALOG_URL, true);
      xhr.timeout = CATALOG_TIMEOUT_MS;
      xhr.onload = function () {
        var code = 0;
        try { code = xhr.status; } catch (e) { code = 0; }
        if (code < 200 || code >= 300) { finish(null); return; }
        var raw = null;
        try { raw = JSON.parse(xhr.responseText); } catch (e) { raw = null; }
        finish(raw);
      };
      xhr.onerror = function () { finish(null); };
      xhr.ontimeout = function () { finish(null); };
      xhr.onabort = function () { finish(null); };
      xhr.send();
    } catch (e) { settle(null); }
  }

  // ---- public API -----------------------------------------------------------------------------

  function onReady(fn) {
    if (typeof fn !== 'function') return;
    if (catalogSettled) { try { fn(); } catch (e) { /* listener failure is not ours */ } return; }
    readyFns.push(fn);
  }

  var api = {
    version: VERSION,
    /** Install/replace the catalog object (same schema as /__sp/skins.json). True when it was accepted. */
    load: function (map) {
      try {
        catalog = normalizeCatalog(map);
        catalogSettled = true;
        apply();
        return !!catalog;
      } catch (e) {
        return false;
      }
    },
    /** Re-read the selection and rebuild the active rules; returns how many operators are skinned. */
    apply: apply,
    /** Drop the active skins (the catalog stays; apply() can bring them back). */
    clear: function () {
      rules = [];
      ruleTargets = [];
      activeSkinOf = {};
      return true;
    },
    /** Snapshot: { count, skins: { charId: skinKey }, catalog: bool }. */
    active: function () {
      var skins = {};
      var n = 0;
      for (var id in activeSkinOf) {
        if (!hasOwn(activeSkinOf, id)) continue;
        skins[id] = activeSkinOf[id];
        n++;
      }
      return { count: n, skins: skins, catalog: !!catalog };
    },
    /** Map one original URL to its skin URL (identity when nothing matches; stable when called twice). */
    resolve: mapUrl,
    /** Called once after the initial catalog read settled (immediately when it already has). */
    onReady: onReady,
  };

  try { window.__SP_SKIN = api; } catch (e) { /* window frozen: nothing to expose */ }
  installFetch();
  readCatalog();
})();
