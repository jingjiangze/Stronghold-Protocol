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
// through untouched). A /data/assets.json fetch that lands before the catalog read settled is held for at
// most CATALOG_WAIT_MS and then delivered untouched; no other request is ever delayed. A catalog read that
// finishes after load()/clear() was called is stale and is dropped (generation guard). Idempotent: a second
// load of this file does nothing.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (typeof window.__SP_SKIN === 'object' && window.__SP_SKIN && typeof window.__SP_SKIN.resolve === 'function') return;

  var VERSION = 1;
  var CATALOG_URL = '/__sp/skins.json';
  var CATALOG_TIMEOUT_MS = 8000;
  var CATALOG_WAIT_MS = 1500;  // upper bound for a manifest request that arrives before the catalog
  var MANIFEST_SUFFIX = '/data/assets.json';
  var SEL_LS_KEY = 'sp.skin.v1';
  var CHAR_URL_FIELDS = ['avatar', 'avatarE2', 'portrait', 'portraitE2'];
  var SPINE_SIDES = ['front', 'back'];

  var catalog = null;          // validated catalog (null = none / not read)
  var catalogSettled = false;  // the one-shot catalog read has finished (success or failure)
  var catalogGen = 0;          // bumped by load()/clear(): a read from an older generation is stale
  var catalogWaits = [];       // manifest requests parked on the catalog read (bounded)
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

  // ---- host validation (string parsing only, never DNS) ---------------------------------------
  // A rule target may be a site-absolute path or an http(s) URL on a public host. "Public" cannot
  // be proven without DNS, so the opposite direction is enforced: every host spelling that a
  // browser normalises into a loopback / private / reserved literal is refused outright --
  // 1..4 part IPv4 in decimal, 0-octal or 0x-hex, and IPv6 literals including ::, ::1 and
  // ::ffff:<v4> (also in the ::ffff:7f00:1 spelling), ULA and link-local.

  /** %XX -> byte (the URL parser percent-decodes a host before it parses it). */
  function percentDecode(s) {
    var out = '';
    var i = 0;
    while (i < s.length) {
      if (s.charAt(i) === '%' && i + 3 <= s.length) {
        var hex = s.slice(i + 1, i + 3);
        if (/^[0-9a-f]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 3; continue; }
      }
      out += s.charAt(i);
      i += 1;
    }
    return out;
  }

  /** 0..15 for one lowercase hex digit, -1 otherwise. */
  function digitOf(ch) {
    var c = ch.charCodeAt(0);
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 97 && c <= 102) return c - 87;
    return -1;
  }

  /** One IPv4 part (decimal, 0-octal, 0x-hex); -1 when it is not a number. */
  function ipv4Part(s) {
    if (!s) return -1;
    var radix = 10;
    if (s.length >= 2 && s.charAt(0) === '0' && (s.charAt(1) === 'x' || s.charAt(1) === 'X')) { radix = 16; s = s.slice(2); }
    else if (s.length >= 2 && s.charAt(0) === '0') { radix = 8; s = s.slice(1); }
    if (!s) return 0;
    var v = 0;
    for (var i = 0; i < s.length; i++) {
      var d = digitOf(s.charAt(i));
      if (d < 0 || d >= radix) return -1;
      v = v * radix + d;
      if (v > 4294967295) return -1;
    }
    return v;
  }

  /** Browser-equivalent IPv4 parse of a whole host: 1..4 parts, one trailing dot allowed. -1 = not IPv4. */
  function ipv4Value(h) {
    var parts = h.split('.');
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    if (!parts.length || parts.length > 4) return -1;
    var nums = [];
    var i = 0;
    for (i = 0; i < parts.length; i++) {
      var v = ipv4Part(parts[i]);
      if (v < 0) return -1;
      if (i < parts.length - 1 && v > 255) return -1;
      nums.push(v);
    }
    var last = nums[nums.length - 1];
    var limit = 1;
    for (i = 0; i < 5 - parts.length; i++) limit *= 256;
    if (last >= limit) return -1;
    var value = last;
    for (i = 0; i < nums.length - 1; i++) value += nums[i] * Math.pow(256, 3 - i);
    return value;
  }

  /** The IPv4 ranges the layer always refuses: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12,
   *  192.0.0/24, 192.168/16, 198.18/15 and everything at or above 224. */
  function ipv4Reserved(v) {
    var a = (v >>> 24) & 255;
    var b = (v >>> 16) & 255;
    var c = (v >>> 8) & 255;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 0 && c === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }

  /** A name that only ever means "this machine" (localhost and the usual private suffixes). */
  function localName(h) {
    if (!h) return true;
    return h === 'localhost' || /\.(localhost|local|internal|home|lan)$/.test(h);
  }

  /** Browser-equivalent "ends in a number": the last dot part must parse as an IPv4 number. */
  function endsInNumber(h) {
    var parts = h.split('.');
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    var last = parts.length ? parts[parts.length - 1] : '';
    if (!last) return false;
    if (/^[0-9]+$/.test(last)) return true;
    return ipv4Part(last) >= 0;
  }

  /** 16-bit group of an IPv6 literal ("ffff"); -1 when it is not one. */
  function ipv6Group(s) {
    if (!s || s.length > 4) return -1;
    var v = 0;
    for (var i = 0; i < s.length; i++) {
      var d = digitOf(s.charAt(i));
      if (d < 0 || d >= 16) return -1;
      v = v * 16 + d;
    }
    return v;
  }

  /** IPv4 tail of an IPv6 literal: exactly four dotted decimal parts, no leading zeros. */
  function ipv4Tail(s) {
    var parts = s.split('.');
    if (parts.length !== 4) return -1;
    var v = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || p.length > 3 || (p.length > 1 && p.charAt(0) === '0')) return -1;
      for (var j = 0; j < p.length; j++) {
        var c = p.charCodeAt(j);
        if (c < 48 || c > 57) return -1;
      }
      var n = Number(p);
      if (n > 255) return -1;
      v = v * 256 + n;
    }
    return v;
  }

  /** One side of a '::' split -> 16-bit groups; an IPv4 tail is only allowed at the very end. */
  function ipv6Fill(part, lastChunk, out) {
    if (!part) return true;
    var groups = part.split(':');
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (!g) return false;
      if (g.indexOf('.') >= 0) {
        if (!lastChunk || i !== groups.length - 1) return false;
        var v4 = ipv4Tail(g);
        if (v4 < 0) return false;
        out.push((v4 >>> 16) & 65535, v4 & 65535);
      } else {
        var n = ipv6Group(g);
        if (n < 0) return false;
        out.push(n);
      }
    }
    return true;
  }

  /** Browser-equivalent IPv6 parse -> eight 16-bit groups, or null. */
  function ipv6Value(s) {
    if (!s) return null;
    var cut = s.indexOf('::');
    if (cut >= 0 && s.indexOf('::', cut + 2) >= 0) return null;
    var head = [];
    var tail = [];
    if (cut < 0) {
      if (!ipv6Fill(s, true, head) || head.length !== 8) return null;
      return head;
    }
    if (!ipv6Fill(s.slice(0, cut), false, head)) return null;
    if (!ipv6Fill(s.slice(cut + 2), true, tail)) return null;
    if (head.length + tail.length >= 8) return null;
    var out = head.slice();
    while (out.length < 8 - tail.length) out.push(0);
    for (var i = 0; i < tail.length; i++) out.push(tail[i]);
    return out;
  }

  /** IPv6 host: unspecified / loopback / v4-compatible / v4-mapped are judged by the embedded IPv4. */
  function ipv6Allowed(s) {
    var g = ipv6Value(s);
    if (!g) return false;
    var i = 0;
    var zero = true;
    for (i = 0; i < 8; i++) if (g[i] !== 0) { zero = false; break; }
    if (zero) return false;
    var low = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
    var mapped = 0;
    var has4 = false;
    if (low && (g[5] === 0 || g[5] === 65535)) { mapped = (g[6] << 16) | g[7]; has4 = true; } // ::<v4> and ::ffff:<v4>
    else if (g[0] === 100 && g[1] === 65435 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) { mapped = (g[6] << 16) | g[7]; has4 = true; } // 64:ff9b::/96
    if (has4) return !ipv4Reserved(mapped);
    if ((g[0] & 65024) === 64512) return false; // fc00::/7 unique-local
    if ((g[0] & 65472) === 65152) return false; // fe80::/10 link-local
    if ((g[0] & 65472) === 65216) return false; // fec0::/10 site-local
    if ((g[0] & 65280) === 65280) return false; // ff00::/8 multicast
    return true;
  }

  /** Is an absolute http(s) host acceptable? Rejects localhost, loopback, private and reserved
   *  hosts exactly as a browser normalises them (pure string parsing, no DNS). */
  function hostAllowed(host) {
    var h = String(host || '').toLowerCase();
    if (!h) return false;
    h = percentDecode(h);
    if (!h) return false;
    if (/[^\x21-\x7e]/.test(h)) return false; // controls, space or non-ASCII: not a host we can reason about
    var bracketed = h.charAt(0) === '[';
    if (bracketed) {
      var end = h.indexOf(']');
      if (end < 0) return false;
      var rest = h.slice(end + 1);
      if (rest !== '' && !/^:[0-9]*$/.test(rest)) return false;
      h = h.slice(1, end);
    } else {
      var colon = h.indexOf(':');
      if (colon >= 0) {
        if (!/^[0-9]*$/.test(h.slice(colon + 1))) return false;
        h = h.slice(0, colon);
      }
    }
    if (!h) return false;
    if (h.indexOf('%') >= 0) return false;             // an escape the URL parser would refuse
    if (/[#\/\?@\[\\\]<>^|"]/.test(h)) return false;   // forbidden host code points
    if (bracketed) return ipv6Allowed(h);
    if (h.length > 1 && h.charAt(h.length - 1) === '.') h = h.slice(0, -1); // trailing root dot
    if (localName(h)) return false;
    if (endsInNumber(h)) {
      var v = ipv4Value(h);
      return v >= 0 && !ipv4Reserved(v); // a numeric tail that is not IPv4 is not a usable host
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

  /** Consume a manifest response and hand out a fresh Response with the skinned body. */
  function rewriteResponse(p) {
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
  }

  /** Wait for the catalog read, but never longer than CATALOG_WAIT_MS. Null when nothing to wait for. */
  function waitCatalog() {
    if (catalogSettled || typeof Promise !== 'function') return null;
    return new Promise(function (resolve) {
      var fired = false;
      var timer = null;
      var fire = function () {
        if (fired) return;
        fired = true;
        if (timer !== null) { try { clearTimeout(timer); } catch (e) { /* nothing to clear */ } }
        resolve();
      };
      catalogWaits.push(fire);
      try { timer = setTimeout(fire, CATALOG_WAIT_MS); } catch (e) { /* no timers: settle() still releases */ }
    });
  }

  /** Release every manifest request parked on the catalog read. */
  function releaseWaits() {
    var fns = catalogWaits;
    catalogWaits = [];
    for (var i = 0; i < fns.length; i++) { try { fns[i](); } catch (e) { /* waiter failure is not ours */ } }
  }

  /** Wrap window.fetch once: manifest responses get the skinned body; everything else passes through.
   *  A manifest request that arrives before the catalog read settled is held for a bounded moment
   *  (the read usually lands far sooner) so an early /data/assets.json is not handed out unskinned. */
  function installFetch() {
    var orig = window.fetch;
    if (typeof orig !== 'function' || window.__SP_SKIN_FETCH) return;
    window.__SP_SKIN_FETCH = 1;
    var wrapped = function (input, init) {
      var p = orig.apply(this, arguments);
      var manifest = false;
      try { manifest = typeof Response === 'function' && isManifestRequest(input); } catch (e) { manifest = false; }
      if (!manifest) return p;                                  // never delay anything else
      if (catalogSettled) return rules.length ? rewriteResponse(p) : p;
      var wait = waitCatalog();
      if (!wait) return rules.length ? rewriteResponse(p) : p;  // no Promises: today's behaviour
      return wait.then(function () { return rules.length ? rewriteResponse(p) : p; });
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

  function fireReady() {
    var fns = readyFns;
    readyFns = [];
    for (var i = 0; i < fns.length; i++) { try { fns[i](); } catch (e) { /* listener failure is not ours */ } }
  }

  /** Adopt a catalog read result. A result whose generation is stale (load()/clear() ran after the
   *  read started) is dropped: the caller's most recent API call always wins over the slow XHR. */
  function settle(raw, gen) {
    if (gen !== catalogGen) {
      catalogSettled = true;
      releaseWaits();
      fireReady();
      return;
    }
    catalog = normalizeCatalog(raw);
    catalogSettled = true;
    apply();
    releaseWaits();
    fireReady();
  }

  function readCatalog() {
    var gen = catalogGen; // the generation this read belongs to: load()/clear() may overtake it
    var inline = null;
    try { inline = window.__SP_SKINS; } catch (e) { inline = null; }
    if (isObj(inline)) { settle(inline, gen); return; }
    try {
      if (typeof XMLHttpRequest !== 'function') { settle(null, gen); return; }
      var xhr = new XMLHttpRequest();
      var done = false;
      var finish = function (raw) { if (done) return; done = true; settle(raw, gen); };
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
    } catch (e) { settle(null, gen); }
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
        catalogGen += 1; // an in-flight catalog read from before this call is stale from now on
        catalog = normalizeCatalog(map);
        catalogSettled = true;
        apply();
        releaseWaits();
        return !!catalog;
      } catch (e) {
        return false;
      }
    },
    /** Re-read the selection and rebuild the active rules; returns how many operators are skinned. */
    apply: apply,
    /** Drop the active skins (the catalog stays; apply() can bring them back). */
    clear: function () {
      catalogGen += 1; // a late catalog read must not resurrect what was just cleared
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
