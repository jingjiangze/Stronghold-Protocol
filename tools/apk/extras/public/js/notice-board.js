/* global window, XMLHttpRequest */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here
// notice-board.js -- in-app bulletin board (an extras-only overlay: hot-updatable, zero upstream conflict).
//
// Loaded by shell-bridge.js from '/__sp/notice-board.js' (the shell's own prefix: MainActivity
// serveShellAsset maps '/__sp/<name>' to the local tree (its js/ subtree) -- filesDir hot tree first,
// then the APK; it never goes to the network). No page module is imported, no upstream file is touched.
//
// Data source (content hot-update), first hit wins:
//   1) window.__SP_NOTICE -- an inline object/array (native shell / tests). It is only treated as DATA
//      while it is not already this module's API (i.e. it has no open() function); afterwards the API
//      takes that same global name.
//   2) XHR GET '/__sp/notices.json' -- local prefix only, never the network. Any failure (404, timeout,
//      bad JSON, no XHR) is a clean global no-op.
//   3) XHR GET '/dl/config.json' (cache-busted) -- the SAME-ORIGIN server config that the shell's own
//      ShellConfig bootstrap reads, so a one-file edit on the server reaches every client without a
//      content release. Only its announce field is used: a non-empty string becomes ONE synthetic
//      notice ("server notice"; optional announceTitle / announceDate / announceLevel) placed BEFORE
//      the local items, and its text/version participate in the revision so a changed announcement is
//      unread again. Missing field, 404, bad JSON, timeout or any failure = the legacy behaviour,
//      byte for byte. This is the only request outside the shell prefix, it is same-origin only, it
//      runs only when source 1 did not supply inline data (an inline board is authoritative).
//
// Server-announce precedence (both paths kept, highest wins; the local board is ALWAYS composed in):
//   (a) window.__SP_SERVER_CONFIG -- the scheme's in-memory snapshot the shell already fetched,
//       validated and cached in Java. Wins outright and performs NO request (works offline).
//   (b) GET '/dl/config.json' (same-origin, cache-busted) -- the documented legacy fallback from
//       the pre-scheme line; reached only when (a) carries no announcement.
//   (c) the local board ('/__sp/notices.json' / inline __SP_NOTICE) is never replaced -- its items
//       are always merged in after the server announcement, and its revision drives the unread dot.
//   The synthesized server item is pinned first; a change in either path's text/version flips it
//   back to unread. See tools/apk/server-content-contract.md section 5 for the operator statement.
//
// Data contract (v1):
//   { "v": 1, "revision": "<any string>", "items": [ { "id": "...", "title": "...", "date": "...",
//     "paragraphs": ["..."], "level": "info" | "warn" } ] }
//   A bare array [ { title, date, paragraphs } ] is accepted too; when revision is missing it is derived
//   from a content hash ('nh1:<len>:<hash>'), so a content change still flips the unread state.
//
// Read state: the current revision string is stored in localStorage['sp.notice.seen']. It is NOT stored in
// player data: player-data.js sanitizeDoc()/sanitizeSettingsBlob() are fixed whitelists and the public
// window.__SP_DATA surface has no generic key/value setter, so an arbitrary field cannot survive a
// save/merge cycle (see the delivery note for the full rationale). All storage access is try/caught and
// silently degrades to "not remembered this session".
//
// API: window.__SP_NOTICE = { open, close, toggle, visible, unread, isUnread, hasData, reload, mount, version }.
//   mount(parent) creates the unread badge + the panel inside the host's container (so the host needs one
//   line and knows nothing about the internals); with no data it creates no DOM at all. After every load
//   and after "got it", the host's own sweep hook (window.__SP_HOME_LAYER_SWEEP) is called once so its
//   entry dot follows the unread state.
//
// Discipline: ES5 (var/function/IIFE), pure ASCII source (Chinese labels are \u escapes), idempotent
// (window.__SP_NOTICE API guard), no imports, no network beyond the local notices XHR and the
// same-origin config read, every failure silent.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  // Idempotence: this module's API is already installed.
  if (window.__SP_NOTICE && typeof window.__SP_NOTICE.open === 'function') return;

  var VERSION = 1;
  var DATA_URL = '/__sp/notices.json';
  var SERVER_CFG_URL = '/dl/config.json'; // same-origin; the shell's remote-editable config
  var TIMEOUT_MS = 8000;
  var MAX_ANNOUNCE = 4000;   // clamp the server announce text (characters)
  var MAX_ANNOUNCE_LINES = 40; // ... and its lines
  var SEEN_KEY = 'sp.notice.seen';
  var STYLE_ID = 'sp-notice-style';

  // UI labels, kept as ASCII escapes so the whole source stays pure ASCII.
  var T = {
    micro: 'BULLETIN BOARD',
    title: '\u516c\u544a',              // gong gao (notice)
    server: '\u670d\u52a1\u5668\u516c\u544a', // fu wu qi gong gao (server notice)
    ack: '\u77e5\u9053\u4e86',          // zhi dao le (got it)
    close: '\u5173\u95ed',              // guan bi (close)
    unread: '\u6709\u65b0\u516c\u544a', // you xin gong gao (new notice)
    times: '\u00d7'
  };

  var CSS = [
    '.sp-notice{position:relative;display:inline-block}',
    '.sp-notice__badge{position:relative;display:inline-flex;align-items:center;justify-content:center;',
    'min-width:40px;min-height:40px;padding:0;margin:0;border:0;background:transparent;cursor:pointer;',
    'color:var(--mint-500,#4ed8af)}',
    '.sp-notice__badge[hidden]{display:none}',
    '.sp-notice__dot{width:10px;height:10px;border-radius:50%;background:var(--red,#e73118);',
    'box-shadow:0 0 0 2px rgba(12,15,14,.9)}',
    '.sp-notice__overlay{position:fixed;top:0;right:0;bottom:0;left:0;z-index:var(--z-modal,80);',
    'display:flex;align-items:center;justify-content:center;background:rgba(4,6,5,.72)}',
    '.sp-notice__overlay[hidden]{display:none}',
    '.sp-notice__panel{width:92vw;max-width:640px;max-height:82vh;display:flex;flex-direction:column;',
    'background:var(--bg-1,#141816);color:var(--text-hi,#f2f2f2);border:1px solid var(--line,#2f3a35);',
    'border-left:3px solid var(--mint-500,#4ed8af);border-radius:2px;box-shadow:0 12px 40px rgba(0,0,0,.55)}',
    '.sp-notice__head{display:flex;align-items:flex-start;gap:12px;padding:14px 16px 10px;',
    'border-bottom:1px solid var(--line,#2f3a35)}',
    '.sp-notice__micro{font-family:var(--font-display,inherit);font-size:11px;letter-spacing:.3em;',
    'color:var(--mint-500,#4ed8af);opacity:.85}',
    '.sp-notice__title{margin:2px 0 0;font-family:var(--font-display,inherit);font-size:20px;',
    'font-weight:700;letter-spacing:.08em}',
    '.sp-notice__close{margin-left:auto;min-width:40px;min-height:40px;border:1px solid var(--line-2,#3e4b45);',
    'background:transparent;color:var(--text-md,#c3cbc7);font-size:18px;line-height:1;cursor:pointer;',
    'border-radius:2px}',
    '.sp-notice__close:hover{border-color:var(--mint-500,#4ed8af);color:var(--mint-500,#4ed8af)}',
    '.sp-notice__scroll{overflow:auto;-webkit-overflow-scrolling:touch;padding:6px 16px 12px}',
    '.sp-notice__item{padding:12px 0;border-bottom:1px solid var(--line,#2f3a35)}',
    '.sp-notice__item:last-child{border-bottom:0}',
    '.sp-notice__item[data-level="warn"]{border-left:3px solid var(--amber,#f6a329);padding-left:10px}',
    '.sp-notice__row{display:flex;align-items:baseline;gap:10px}',
    '.sp-notice__itemtitle{margin:0;font-size:16px;font-weight:700;letter-spacing:.04em}',
    '.sp-notice__date{margin-left:auto;font-family:var(--font-num,inherit);font-size:12px;',
    'color:var(--text-lo,#8a948f)}',
    '.sp-notice__p{margin:6px 0 0;font-size:14px;line-height:1.6;color:var(--text-md,#c3cbc7);',
    'white-space:pre-wrap}',
    '.sp-notice__foot{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px 14px;',
    'border-top:1px solid var(--line,#2f3a35)}',
    '.sp-notice__ack{min-height:40px;min-width:96px;padding:0 18px;border:1px solid var(--mint-500,#4ed8af);',
    'background:transparent;color:var(--mint-500,#4ed8af);font-size:14px;letter-spacing:.14em;',
    'cursor:pointer;border-radius:2px}',
    '.sp-notice__ack:hover{background:var(--mint-a10,rgba(78,216,175,.10))}',
  ].join('');

  // ---- state ---------------------------------------------------------------
  var data = null;         // composed { revision, items:[...] } or null
  var localDone = false;   // the local bulletin read has settled
  var localData = null;    // normalised local data (inline or /__sp/notices.json) or null
  var srvDone = false;     // the server config read has settled
  var srvData = null;      // normalised server announce or null
  var inlineMode = false;  // source 1 supplied the data: no XHR at all (an inline board is the whole board)
  var root = null;         // the mounted root element (created lazily)
  var hostParent = null;   // the container the host handed to mount()
  var badge = null;
  var overlay = null;
  var listEl = null;
  var styleEl = null;
  var openFlag = false;
  var escHandler = null;

  // ---- small helpers -------------------------------------------------------
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str(v) { return typeof v === 'string' ? v : ''; }
  /** Clamp a string to n characters (ES5-safe; announce text can be arbitrarily long). */
  function clip(s, n) { return s.length > n ? s.substring(0, n) : s; }
  /** A config scalar rendered as text: strings kept, finite numbers stringified, anything else ''. */
  function cfgText(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && isFinite(v)) return String(v);
    return '';
  }
  function doc() { try { return window.document || null; } catch (e) { return null; } }
  function mk(tag) {
    var d = doc();
    if (!d || typeof d.createElement !== 'function') return null;
    try { return d.createElement(tag); } catch (e) { return null; }
  }
  function setText(el, s) { if (!el) return; try { el.textContent = s; } catch (e) { /* silent */ } }
  function setAttr(el, n, v) { if (!el || typeof el.setAttribute !== 'function') return; try { el.setAttribute(n, String(v)); } catch (e) { /* silent */ } }
  function append(parent, child) { if (!parent || !child || typeof parent.appendChild !== 'function') return child; try { parent.appendChild(child); } catch (e) { /* silent */ } return child; }
  function on(el, type, fn) { if (!el || typeof el.addEventListener !== 'function') return; try { el.addEventListener(type, fn, false); } catch (e) { /* silent */ } }

  // ---- normalisation -------------------------------------------------------

  /** Is this value inline DATA (rather than this module's API object)? */
  function isData(v) {
    if (Array.isArray(v)) return true;
    return isObj(v) && Array.isArray(v.items) && typeof v.open !== 'function';
  }

  function normItem(raw, i) {
    if (!isObj(raw)) return null;
    var title = str(raw.title);
    if (!title) return null;
    var paras = [];
    if (Array.isArray(raw.paragraphs)) {
      for (var j = 0; j < raw.paragraphs.length; j++) {
        if (typeof raw.paragraphs[j] === 'string') paras.push(raw.paragraphs[j]);
      }
    }
    return {
      id: str(raw.id) || ('n' + i),
      title: title,
      date: str(raw.date),
      paragraphs: paras,
      level: raw.level === 'warn' ? 'warn' : 'info',
    };
  }

  function normItems(arr) {
    var out = [];
    if (!Array.isArray(arr)) return out;
    for (var i = 0; i < arr.length; i++) {
      var it = normItem(arr[i], i);
      if (it) out.push(it);
    }
    return out;
  }

  /** Stable content fingerprint (djb2 variant; no crypto, no network). */
  function hashItems(items) {
    var s = '';
    try { s = JSON.stringify(items); } catch (e) { s = String(items.length); }
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
    return 'nh1:' + s.length.toString(16) + ':' + h.toString(16);
  }

  /** Raw -> { revision, items } or null (never throws). No valid item == no data. */
  function normalize(raw) {
    try {
      var items;
      var rev;
      if (Array.isArray(raw)) {
        items = normItems(raw);
        rev = hashItems(items);
      } else if (isObj(raw)) {
        items = normItems(raw.items);
        rev = str(raw.revision) || hashItems(items);
      } else {
        return null;
      }
      if (!items.length) return null;
      return { revision: rev, items: items };
    } catch (e) { return null; }
  }

  // ---- server announce (source 3) + composition ----------------------------

  /** config.json announce -> { revision, items } carrying exactly one item, or null (no announce).
   *  Only the documented announce fields are read; every string is clamped. */
  function serverAnnounce(cfg) {
    if (!isObj(cfg)) return null;
    var text = clip(str(cfg.announce), MAX_ANNOUNCE);
    if (!text) return null;
    var lines = text.split(/\r?\n/);
    var paras = [];
    for (var i = 0; i < lines.length && paras.length < MAX_ANNOUNCE_LINES; i++) {
      var line = lines[i].replace(/^\s+|\s+$/g, '');
      if (line) paras.push(clip(line, 1000));
    }
    if (!paras.length) return null;
    var item = {
      id: 'server-announce',
      title: clip(str(cfg.announceTitle), 120) || T.server,
      date: clip(str(cfg.announceDate), 40),
      paragraphs: paras,
      level: cfg.announceLevel === 'warn' ? 'warn' : 'info',
    };
    return {
      revision: 'srv:' + clip(cfgText(cfg.configVersion), 40) + ':'
        + hashItems([item.title, item.date, item.level].concat(paras)),
      items: [item],
    };
  }

  /** Rebuild the visible board from every settled source: the server announce first, then the local
   *  items. With no server data the revision is exactly the local revision (legacy semantics). */
  function compose() {
    if (inlineMode) return; // source 1 owns the board
    if (!localDone && !srvDone) return;
    var items = [];
    var rev = '';
    var i;
    if (srvData) {
      for (i = 0; i < srvData.items.length; i++) items.push(srvData.items[i]);
      rev += srvData.revision;
    }
    if (localData) {
      for (i = 0; i < localData.items.length; i++) items.push(localData.items[i]);
      rev += (rev ? '|' : '') + localData.revision;
    }
    if (!items.length) {
      // A still-pending source may yet add content; never blank a board that already shows something.
      if ((!localDone || !srvDone) && data) return;
      setData(null);
      return;
    }
    setData({ revision: rev || hashItems(items), items: items });
  }

  // ---- read state (localStorage; player data cannot carry it) --------------
  var memSeen = null; // in-session fallback when storage is unavailable (private mode / quota)
  function getSeen() {
    try {
      var ls = window.localStorage;
      if (ls && typeof ls.getItem === 'function') {
        var v = ls.getItem(SEEN_KEY);
        if (typeof v === 'string' && v) return v;
      }
    } catch (e) { /* fall through to the in-session value */ }
    return memSeen;
  }
  function setSeen(rev) {
    if (typeof rev !== 'string' || !rev) return false;
    memSeen = rev;
    try {
      var ls = window.localStorage;
      if (!ls || typeof ls.setItem !== 'function') return false;
      ls.setItem(SEEN_KEY, rev);
      return true;
    } catch (e) { return false; }
  }
  function isUnread() { return !!(data && data.revision && data.revision !== getSeen()); }
  function markSeen() { if (data && data.revision) setSeen(data.revision); }

  // ---- DOM -----------------------------------------------------------------
  function ensureStyle() {
    if (styleEl) return;
    var d = doc();
    if (!d) return;
    var head = d.head || d.documentElement;
    if (!head || typeof head.appendChild !== 'function') return;
    if (typeof d.getElementById === 'function') {
      var found = null;
      try { found = d.getElementById(STYLE_ID); } catch (e) { found = null; }
      if (found) { styleEl = found; return; }
    }
    var st = mk('style');
    if (!st) return;
    setAttr(st, 'id', STYLE_ID);
    setText(st, CSS);
    append(head, st);
    styleEl = st;
  }

  function ensureRoot() {
    if (root) return root;
    var d = doc();
    if (!d || typeof d.createElement !== 'function') return null;
    ensureStyle();
    var r = mk('div');
    r.className = 'sp-notice';
    var b = mk('button');
    if (b) {
      b.className = 'sp-notice__badge';
      setAttr(b, 'type', 'button');
      setAttr(b, 'aria-label', T.unread);
      b.hidden = true;
      var dot = mk('span');
      if (dot) { dot.className = 'sp-notice__dot'; append(b, dot); }
      on(b, 'click', function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); open(); });
      append(r, b);
    }
    var ov = mk('div');
    ov.className = 'sp-notice__overlay';
    setAttr(ov, 'role', 'dialog');
    setAttr(ov, 'aria-modal', 'true');
    ov.hidden = true;
    var panel = mk('div');
    panel.className = 'sp-notice__panel';
    var head = mk('div');
    head.className = 'sp-notice__head';
    var titleWrap = mk('div');
    var micro = mk('div');
    micro.className = 'sp-notice__micro';
    setText(micro, T.micro);
    var h = mk('h2');
    h.className = 'sp-notice__title';
    setText(h, T.title);
    append(titleWrap, micro);
    append(titleWrap, h);
    append(head, titleWrap);
    var x = mk('button');
    x.className = 'sp-notice__close';
    setAttr(x, 'type', 'button');
    setAttr(x, 'aria-label', T.close);
    setText(x, T.times);
    on(x, 'click', function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); close(); });
    append(head, x);
    var scroll = mk('div');
    scroll.className = 'sp-notice__scroll';
    setAttr(scroll, 'tabindex', '0');
    var foot = mk('div');
    foot.className = 'sp-notice__foot';
    var ack = mk('button');
    ack.className = 'sp-notice__ack';
    setAttr(ack, 'type', 'button');
    setText(ack, T.ack);
    on(ack, 'click', function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); acknowledge(); });
    append(foot, ack);
    append(panel, head);
    append(panel, scroll);
    append(panel, foot);
    append(ov, panel);
    append(r, ov);
    root = r;
    badge = b;
    overlay = ov;
    listEl = scroll;
    return r;
  }

  function mountInto(parent) {
    if (!root) return;
    var p = parent || hostParent;
    if (!p || typeof p.appendChild !== 'function') return;
    if (root.parentNode === p) return;
    if (root.parentNode && typeof root.parentNode.removeChild === 'function') {
      try { root.parentNode.removeChild(root); } catch (e) { /* silent */ }
    }
    append(p, root);
  }

  function clearList() {
    if (!listEl) return;
    try {
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    } catch (e) {
      try { if (listEl._kids) listEl._kids.length = 0; } catch (e2) { /* silent */ }
    }
  }

  function renderList() {
    if (!listEl || !data) return;
    clearList();
    for (var i = 0; i < data.items.length; i++) {
      var it = data.items[i];
      var art = mk('article');
      art.className = 'sp-notice__item';
      setAttr(art, 'data-level', it.level);
      var row = mk('div');
      row.className = 'sp-notice__row';
      var t = mk('h3');
      t.className = 'sp-notice__itemtitle';
      setText(t, it.title);
      append(row, t);
      if (it.date) {
        var dt = mk('span');
        dt.className = 'sp-notice__date';
        setText(dt, it.date);
        append(row, dt);
      }
      append(art, row);
      for (var j = 0; j < it.paragraphs.length; j++) {
        var p = mk('p');
        p.className = 'sp-notice__p';
        setText(p, it.paragraphs[j]);
        append(art, p);
      }
      append(listEl, art);
    }
  }

  function renderBadge() { if (badge) badge.hidden = !isUnread(); }

  function render() {
    if (!root) return;
    renderBadge();
    if (!data && openFlag) { close(); return; }
    if (openFlag) renderList();
  }

  // ---- key handling --------------------------------------------------------
  function onKey(ev) {
    var k = ev && (ev.key || ev.keyCode);
    if (k === 'Escape' || k === 'Esc' || k === 27) close();
  }
  function addEsc() {
    var d = doc();
    if (!d || typeof d.addEventListener !== 'function' || escHandler) return;
    escHandler = onKey;
    try { d.addEventListener('keydown', escHandler, false); } catch (e) { escHandler = null; }
  }
  function removeEsc() {
    var d = doc();
    if (!d || typeof d.removeEventListener !== 'function' || !escHandler) return;
    try { d.removeEventListener('keydown', escHandler, false); } catch (e) { /* silent */ }
    escHandler = null;
  }

  // ---- data loading --------------------------------------------------------
  /** Install the composed board (or the no-data no-op); every path is silent and idempotent. */
  function setData(next) {
    data = next;
    if (!data) {
      if (openFlag) close();
      if (root) renderBadge();
      notifyHost();
      return false;
    }
    if (!root && hostParent) { ensureRoot(); mountInto(hostParent); }
    render();
    notifyHost();
    return true;
  }

  /** Source 1 (inline): authoritative for this load; no XHR is fired at all. */
  function applyRaw(raw) {
    inlineMode = true;
    localDone = true;
    localData = normalize(raw);
    return setData(localData);
  }

  /** Tell the host (home-layer) that the unread state may have changed: it repaints its entry dot
   *  through its own published sweep hook. No host = silence; never throws, never re-enters. */
  function notifyHost() {
    try {
      if (typeof window.__SP_HOME_LAYER_SWEEP === 'function') window.__SP_HOME_LAYER_SWEEP();
    } catch (e) { /* silent */ }
  }

  /** One XHR GET; onDone(raw|null) fires exactly once. Never throws; a missing XHR is a clean null. */
  function fetchJson(url, onDone) {
    try {
      if (typeof XMLHttpRequest !== 'function') { onDone(null); return false; }
      var xhr = new XMLHttpRequest();
      var done = false;
      var finish = function (raw) { if (done) return; done = true; onDone(raw); };
      xhr.open('GET', url, true);
      xhr.timeout = TIMEOUT_MS;
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
      return true;
    } catch (e) { onDone(null); return false; }
  }

  /** Source 2: the local bulletin (shell prefix; never the network under the APK interceptor). */
  function fetchLocal() {
    return fetchJson(DATA_URL, function (raw) {
      localDone = true;
      localData = normalize(raw);
      compose();
    });
  }

  /** Source 3a: the CURRENT server's declarative config (server-config.js), when the shell provided
   *  one. Preferred server-announcement path: the shell already fetched/validated/cached that document,
   *  so this is a pure in-memory read -- no request, no cache-buster, and it still works offline from
   *  the shell's last-good copy. Absent module / absent announcement -> null (falls through to 3b). */
  function fromServerConfig() {
    try {
      var sc = window.__SP_SERVER_CONFIG;
      if (!sc || typeof sc.announce !== 'function') return null;
      var a = sc.announce();
      if (!a) return null;
      return {
        announce: str(a.body),
        announceTitle: str(a.title),
        announceLevel: a.level,
        configVersion: 'sc' + (typeof sc.version === 'function' ? sc.version() : 0),
      };
    } catch (e) {
      return null;
    }
  }

  /** Source 3: the same-origin server config; only its announce field is consumed. Cache-busted so a CDN
   *  copy cannot pin an old announcement; the path stays '/dl/config.json'. */
  function fetchServer() {
    // 3a first: the shell's validated server config describes the SAME declaration, already parsed and
    // cached in Java, and it survives offline. Only when it carries no announcement do we fall back to
    // reading the legacy file ourselves (that path stays byte-for-byte as it was).
    var viaShell = fromServerConfig();
    if (viaShell) {
      srvDone = true;
      srvData = serverAnnounce(viaShell);
      compose();
      return;
    }
    var url = SERVER_CFG_URL;
    try { url += (url.indexOf('?') < 0 ? '?' : '&') + 'v=' + Date.now(); } catch (e) { /* bare path */ }
    return fetchJson(url, function (cfg) {
      srvDone = true;
      srvData = serverAnnounce(cfg);
      compose();
    });
  }

  function readSource() {
    try { if (isData(window.__SP_NOTICE)) return { sync: true, raw: window.__SP_NOTICE }; } catch (e) { /* silent */ }
    return { sync: false, raw: null };
  }

  function reinstall() { try { window.__SP_NOTICE = api; } catch (e) { /* window frozen */ } }

  // ---- public API ----------------------------------------------------------
  function open() {
    if (!data) return false;
    if (!root) ensureRoot();
    if (!root) return false;
    if (!root.parentNode) {
      var p = hostParent;
      if (!p) { var d = doc(); p = d ? d.body : null; }
      if (p) mountInto(p);
    }
    openFlag = true;
    if (overlay) overlay.hidden = false;
    renderList();
    addEsc();
    markSeen();
    renderBadge();
    return true;
  }

  function close() {
    openFlag = false;
    if (overlay) overlay.hidden = true;
    removeEsc();
    return true;
  }

  function toggle() { return visible() ? close() : open(); }

  function visible() { return !!(overlay && overlay.hidden !== true); }

  /** Does the board have anything to show? The host (home-layer) enables its entry only when true. */
  function hasData() { return !!data; }

  function acknowledge() { markSeen(); renderBadge(); notifyHost(); return close(); }

  function mount(parent) {
    var p = parent;
    if (!p || typeof p.appendChild !== 'function') {
      var d = doc();
      p = d ? d.body : null;
    }
    if (!p || typeof p.appendChild !== 'function') return false;
    hostParent = p;
    if (data) {
      if (!root) ensureRoot();
      if (!root) return false;
      mountInto(p);
      render();
    }
    return true;
  }

  function reload() {
    var src = readSource();
    if (src.sync) {
      var ok = applyRaw(src.raw);
      reinstall();
      return ok;
    }
    inlineMode = false; // a removed inline board must not freeze the XHR sources
    localDone = false;
    srvDone = false;
    var dispatched = fetchLocal();
    fetchServer();
    return dispatched ? true : !!data;
  }

  var api = {
    version: VERSION,
    open: open,
    close: close,
    toggle: toggle,
    visible: visible,
    unread: isUnread,
    isUnread: isUnread,
    hasData: hasData,
    reload: reload,
    mount: mount,
  };

  // Initial read, then install the API (the API guard above makes a second injection a no-op).
  var initial = readSource();
  if (initial.sync) applyRaw(initial.raw);
  else { fetchLocal(); fetchServer(); }
  reinstall();
})();
