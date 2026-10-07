// notice-board tests: vm + a minimal DOM stub, the real shipped file is executed (no dependencies).
//
//   node --test tools/apk/notice-board.test.mjs
//
// Covered: no data is a full no-op (no DOM, mount/open inert, unread false) / bare-array compatibility
//          (content-hash revision) / the object contract renders title/date/paragraphs/level / a new
//          revision turns unread again / read state persists through localStorage (and survives a
//          broken player data), with an in-session fallback when storage is unavailable / both Esc and
//          "got it" close the panel / repeated injection is idempotent (one root, no stacked DOM) /
//          broken JSON, a non-2xx body and an XHR failure never throw / source invariants (pure ASCII,
//          ES5, no imports, the only request target is the shell prefix).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'notice-board.js'), 'utf8');

const OBJ = {
  v: 1,
  revision: 'r-1',
  items: [
    { id: 'a', title: 'Title A', date: '2026-10-07', paragraphs: ['p1', 'p2'], level: 'warn' },
    { id: 'b', title: 'Title B', paragraphs: ['q1'] },
  ],
};
const BARE = [{ title: 'Bare', date: '2026-01-01', paragraphs: ['x'] }];

// ---------------------------------------------------------------- stubs

function mkEvent(extra) {
  return Object.assign({
    _stopped: false, _prevented: false,
    stopPropagation() { this._stopped = true; },
    preventDefault() { this._prevented = true; },
  }, extra || {});
}

function mkEl(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    textContent: '',
    hidden: false,
    style: {},
    _attrs: {}, _listeners: [], _kids: [],
    parentNode: null,
    get firstChild() { return this._kids.length ? this._kids[0] : null; },
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n); },
    removeAttribute(n) { delete this._attrs[n]; },
    appendChild(c) {
      if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c);
      c.parentNode = this;
      this._kids.push(c);
      return c;
    },
    removeChild(c) {
      const i = this._kids.indexOf(c);
      if (i >= 0) this._kids.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    addEventListener(t, fn, cap) { this._listeners.push({ type: t, fn, capture: !!cap }); },
    removeEventListener(t, fn, cap) {
      const i = this._listeners.findIndex((l) => l.type === t && l.fn === fn && l.capture === !!cap);
      if (i >= 0) this._listeners.splice(i, 1);
    },
    dispatch(type, ev) {
      const e = ev || mkEvent();
      if (!e._stopped) for (const l of this._listeners) if (l.type === type && !l.capture) { l.fn(e); if (e._stopped) break; }
      for (let p = this.parentNode; p && !e._stopped; p = p.parentNode) {
        for (const l of p._listeners) if (l.type === type && !l.capture) { l.fn(e); if (e._stopped) break; }
      }
      return e;
    },
    click(ev) { return this.dispatch('click', ev); },
  };
}

/** A Map-backed localStorage stub (shared between worlds to model persistence). */
function mkLS() {
  const m = new Map();
  return {
    getItem(k) { return m.has(String(k)) ? m.get(String(k)) : null; },
    setItem(k, v) { m.set(String(k), String(v)); },
    removeItem(k) { m.delete(String(k)); },
    _map: m,
  };
}

function mkWorld(opts = {}) {
  const created = [];
  const xhrs = [];
  const docListeners = [];
  const win = {};
  const htmlEl = mkEl('html');
  const head = mkEl('head');
  const body = mkEl('body');
  htmlEl.appendChild(head);
  htmlEl.appendChild(body);

  const walk = (n, want) => {
    if (!n) return null;
    if (n._attrs && n._attrs.id === want) return n;
    for (const k of (n._kids || [])) { const r = walk(k, want); if (r) return r; }
    return null;
  };
  const document = {
    readyState: 'complete',
    documentElement: htmlEl,
    head,
    body,
    createElement(tag) { const el = mkEl(tag); created.push(el); return el; },
    getElementById(id) { const want = String(id); return walk(head, want) || walk(body, want) || null; },
    addEventListener(t, fn, cap) { docListeners.push({ type: t, fn, capture: !!cap }); },
    removeEventListener(t, fn, cap) {
      const i = docListeners.findIndex((l) => l.type === t && l.fn === fn && l.capture === !!cap);
      if (i >= 0) docListeners.splice(i, 1);
    },
    dispatch(type, ev) {
      const e = ev || mkEvent();
      for (const l of docListeners) if (l.type === type && !l.capture) { l.fn(e); if (e._stopped) break; }
      return e;
    },
  };
  win.document = document;

  function XHRStub() {
    this.url = null; this.method = null; this.sent = false; this.status = 0; this.responseText = ''; this.timeout = 0;
    xhrs.push(this);
  }
  XHRStub.prototype.open = function (m, u) { this.method = m; this.url = u; };
  XHRStub.prototype.send = function () { this.sent = true; };
  XHRStub.prototype.respond = function (status, text) { this.status = status; this.responseText = text; if (this.onload) this.onload(); };
  XHRStub.prototype.fail = function (kind) {
    if (kind === 'timeout') { if (this.ontimeout) this.ontimeout(); } else if (this.onerror) this.onerror();
  };

  if (opts.inline !== undefined) win.__SP_NOTICE = opts.inline;
  if (opts.localStorage !== undefined) win.localStorage = opts.localStorage;
  if (opts.data !== undefined) win.__SP_DATA = opts.data;
  if (opts.dataThrows) {
    win.__SP_DATA = {
      exportJSON() { throw new Error('player data unavailable'); },
      importJSON() { throw new Error('player data unavailable'); },
    };
  }

  const sandbox = { window: win, document, XMLHttpRequest: XHRStub, console };
  return {
    win, sandbox, created, xhrs, head, body, document, docListeners,
    run: () => vm.runInNewContext(SRC, sandbox, { filename: 'notice-board.js' }),
    key: (key, extra) => document.dispatch('keydown', mkEvent(Object.assign({ key }, extra || {}))),
  };
}

function findByClass(node, cls) {
  if (!node) return null;
  if (node.className === cls) return node;
  for (const k of (node._kids || [])) { const r = findByClass(k, cls); if (r) return r; }
  return null;
}
function findAllByClass(node, cls, out = []) {
  if (!node) return out;
  if (node.className === cls) out.push(node);
  for (const k of (node._kids || [])) findAllByClass(k, cls, out);
  return out;
}

// ---------------------------------------------------------------- 1. no data: full no-op

test('no data: full no-op (no DOM, mount/open inert, unread false)', () => {
  const w = mkWorld();
  w.run();
  const api = w.win.__SP_NOTICE;
  assert.equal(typeof api, 'object', 'the API must be exposed even with no data');
  assert.equal(api.version, 1);
  assert.equal(api.unread(), false);
  assert.equal(api.isUnread(), false);
  assert.equal(api.visible(), false);
  assert.equal(w.xhrs.length, 1, 'exactly one data read attempt');
  assert.equal(w.xhrs[0].url, '/__sp/notices.json', 'the only request target is the shell prefix');
  assert.equal(w.xhrs[0].method, 'GET');
  assert.equal(w.created.length, 0, 'no element is created before any data exists');

  w.xhrs[0].respond(404, '');
  assert.equal(api.unread(), false);
  const host = mkEl('div');
  assert.equal(api.mount(host), true);
  assert.equal(host._kids.length, 0, 'mount creates no DOM without data');
  assert.equal(api.open(), false, 'open without data is inert');
  assert.equal(host._kids.length, 0, 'still nothing rendered');
  assert.equal(api.close(), true);
  assert.equal(api.toggle(), false, 'toggle without data cannot open');
});

// ---------------------------------------------------------------- 2. bare array compatibility

test('bare array: accepted, revision derived from a content hash', () => {
  const ls = mkLS();
  const w = mkWorld({ inline: BARE, localStorage: ls });
  w.run();
  const api = w.win.__SP_NOTICE;
  assert.equal(w.xhrs.length, 0, 'inline data must not hit XHR');
  assert.equal(api.unread(), true);
  const host = mkEl('div');
  api.mount(host);
  const badge = findByClass(host, 'sp-notice__badge');
  assert.ok(badge, 'the unread badge exists');
  assert.equal(badge.hidden, false, 'badge shown while unread');
  api.open();
  const seen = ls.getItem('sp.notice.seen');
  assert.match(seen, /^nh1:/, 'a bare array gets a content-hash revision');
  assert.equal(api.unread(), false);

  // Same content -> same hash -> still read after a reload.
  api.reload();
  assert.equal(api.unread(), false, 'unchanged content stays read');
});

// ---------------------------------------------------------------- 3. object contract renders

test('object contract: title / date / paragraphs / level are rendered', () => {
  const w = mkWorld({ inline: OBJ });
  w.run();
  const api = w.win.__SP_NOTICE;
  const host = mkEl('div');
  api.mount(host);
  assert.equal(api.open(), true);
  assert.equal(api.visible(), true);

  const items = findAllByClass(host, 'sp-notice__item');
  assert.equal(items.length, 2, 'one article per item');
  assert.equal(items[0]._attrs['data-level'], 'warn', 'level=warn is carried through');
  assert.equal(items[1]._attrs['data-level'], 'info', 'missing level defaults to info');
  assert.equal(findByClass(items[0], 'sp-notice__itemtitle').textContent, 'Title A');
  assert.equal(findByClass(items[0], 'sp-notice__date').textContent, '2026-10-07');
  assert.equal(findAllByClass(items[0], 'sp-notice__p').length, 2, 'both paragraphs render');
  assert.equal(findAllByClass(items[1], 'sp-notice__p').length, 1);
  // Overlay is above the page panels: it uses the --z-modal token.
  const overlay = findByClass(host, 'sp-notice__overlay');
  assert.equal(overlay.hidden, false);
});

// ---------------------------------------------------------------- 4. revision change -> unread again

test('a new revision turns unread again after it was read', () => {
  const w = mkWorld({ inline: OBJ });
  w.run();
  const api = w.win.__SP_NOTICE;
  const host = mkEl('div');
  api.mount(host);
  assert.equal(api.unread(), true);
  api.open();
  assert.equal(api.unread(), false, 'opening the panel marks it read');

  w.win.__SP_NOTICE = { v: 1, revision: 'r-2', items: [{ title: 'New', paragraphs: ['n'] }] };
  assert.equal(api.reload(), true);
  assert.equal(w.win.__SP_NOTICE, api, 'reload restores the API over the inline data');
  assert.equal(api.unread(), true, 'a different revision is unread again');
  const badge = findByClass(host, 'sp-notice__badge');
  assert.equal(badge.hidden, false, 'the badge returns');

  // Opening shows the new content.
  api.open();
  assert.equal(findByClass(host, 'sp-notice__itemtitle').textContent, 'New');
});

// ---------------------------------------------------------------- 5. read persistence

test('read state persists through localStorage, and a broken player data does not matter', () => {
  const ls = mkLS();
  const w1 = mkWorld({ inline: OBJ, localStorage: ls, dataThrows: true });
  w1.run();
  const a1 = w1.win.__SP_NOTICE;
  a1.open();
  assert.equal(ls.getItem('sp.notice.seen'), 'r-1', 'the revision is written to localStorage');
  assert.equal(a1.unread(), false);

  // A second load sharing the same storage starts already read (player data is broken and unused).
  const w2 = mkWorld({ inline: OBJ, localStorage: ls, dataThrows: true });
  w2.run();
  assert.equal(w2.win.__SP_NOTICE.unread(), false, 'read state survives a reload via localStorage');

  // Without storage the state still clears for this session (in-session fallback), but does not persist.
  const w3 = mkWorld({ inline: OBJ });
  w3.run();
  w3.win.__SP_NOTICE.open();
  assert.equal(w3.win.__SP_NOTICE.unread(), false, 'open still marks read in-session');
  const w4 = mkWorld({ inline: OBJ });
  w4.run();
  assert.equal(w4.win.__SP_NOTICE.unread(), true, 'a fresh session without storage starts unread');
});

// ---------------------------------------------------------------- 6. Esc and "got it" close

test('Esc and the "got it" button both close the panel', () => {
  const w = mkWorld({ inline: OBJ, localStorage: mkLS() });
  w.run();
  const api = w.win.__SP_NOTICE;
  const host = mkEl('div');
  api.mount(host);

  api.open();
  assert.equal(api.visible(), true);
  assert.equal(w.docListeners.length, 1, 'an Esc listener is attached while open');
  w.key('Escape');
  assert.equal(api.visible(), false, 'Esc closes');
  assert.equal(w.docListeners.length, 0, 'the Esc listener is removed on close');
  assert.equal(w.win.__SP_NOTICE.unread(), false);

  // The Esc listener is removed once closed: a further Esc is harmless.
  w.key('Escape');
  assert.equal(api.visible(), false);

  api.open();
  const ack = findByClass(host, 'sp-notice__ack');
  assert.ok(ack, 'the acknowledgement button exists');
  ack.click();
  assert.equal(api.visible(), false, '"got it" closes');
  assert.equal(api.unread(), false);

  // The close (x) button also closes.
  api.open();
  findByClass(host, 'sp-notice__close').click();
  assert.equal(api.visible(), false);
});

// ---------------------------------------------------------------- 7. host integration

test('hasData: true only when the board really has notices', () => {
  const a = mkWorld({ localStorage: mkLS() });
  a.run();
  assert.equal(a.win.__SP_NOTICE.hasData(), false, 'no source at all -> false');
  a.xhrs[0].respond(200, '[]');
  assert.equal(a.win.__SP_NOTICE.hasData(), false, 'an empty list is still nothing to show');

  const b = mkWorld({ inline: OBJ, localStorage: mkLS() });
  b.run();
  assert.equal(b.win.__SP_NOTICE.hasData(), true, 'inline data -> true');

  const c = mkWorld({ localStorage: mkLS() });
  c.run();
  assert.equal(c.win.__SP_NOTICE.hasData(), false, 'before the XHR lands there is nothing');
  c.xhrs[0].respond(200, JSON.stringify(BARE));
  assert.equal(c.win.__SP_NOTICE.hasData(), true, 'after a 2xx load -> true');
});

test('the host sweep hook fires on load and on "got it"; a broken host never breaks the board', () => {
  const w = mkWorld({ localStorage: mkLS() });
  let calls = 0;
  w.win.__SP_HOME_LAYER_SWEEP = () => { calls += 1; };
  w.run();
  assert.equal(calls, 0, 'nothing is announced before any data arrives');
  w.xhrs[0].respond(200, JSON.stringify(OBJ));
  assert.equal(calls, 1, 'a completed load announces once');

  const host = mkEl('div');
  w.win.__SP_NOTICE.mount(host);
  w.win.__SP_NOTICE.open();
  findByClass(host, 'sp-notice__ack').click();
  assert.equal(calls, 2, '"got it" announces the read-state change');

  w.win.__SP_HOME_LAYER_SWEEP = () => { throw new Error('host broken'); };
  w.win.__SP_NOTICE.reload();
  assert.doesNotThrow(() => w.xhrs[1].respond(200, JSON.stringify(OBJ)),
    'a throwing host hook is swallowed by the board');
});

// ---------------------------------------------------------------- 8. idempotence
test('repeated injection is idempotent: one root, no stacked DOM', () => {
  const w = mkWorld({ inline: OBJ });
  w.run();
  const api = w.win.__SP_NOTICE;
  const host = mkEl('div');
  api.mount(host);
  api.open();
  const before = host._kids.length;
  const rootsBefore = findAllByClass(host, 'sp-notice').length;
  assert.equal(rootsBefore, 1);

  w.run(); // second injection of the same script
  assert.equal(w.win.__SP_NOTICE, api, 'the API object is not replaced');
  assert.equal(host._kids.length, before, 'no duplicate DOM is appended');
  assert.equal(findAllByClass(host, 'sp-notice').length, 1, 'still exactly one root');

  // Re-mounting on the same host is also stable.
  api.mount(host);
  assert.equal(findAllByClass(host, 'sp-notice').length, 1);
});

// ---------------------------------------------------------------- 8. broken input never throws

test('broken JSON, non-2xx and an XHR failure never throw', () => {
  const w = mkWorld();
  w.run();
  const api = w.win.__SP_NOTICE;
  assert.doesNotThrow(() => w.xhrs[0].respond(200, '{ not json'));
  assert.equal(api.unread(), false);
  assert.equal(api.open(), false);

  const w2 = mkWorld();
  w2.run();
  assert.doesNotThrow(() => w2.xhrs[0].respond(500, 'boom'));
  assert.equal(w2.win.__SP_NOTICE.unread(), false);

  const w3 = mkWorld();
  w3.run();
  assert.doesNotThrow(() => w3.xhrs[0].fail());
  assert.equal(w3.win.__SP_NOTICE.unread(), false);

  // Valid JSON but no usable item is also a no-op.
  const w4 = mkWorld();
  w4.run();
  assert.doesNotThrow(() => w4.xhrs[0].respond(200, JSON.stringify({ v: 1, items: [] })));
  assert.equal(w4.win.__SP_NOTICE.open(), false);
  assert.equal(w4.created.length, 0);
});

// ---------------------------------------------------------------- 9. source invariants

test('the shipped /js/notices.json is valid data for this contract', () => {
  const file = path.join(here, 'extras', 'public', 'js', 'notices.json');
  assert.ok(fs.existsSync(file), 'the shell ships an initial bulletin (extras/public/js/notices.json)');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(String(raw.revision || '').length > 0, 'the shipped bulletin must carry an explicit revision');
  const w = mkWorld({ inline: raw, localStorage: mkLS() });
  w.run();
  assert.equal(w.win.__SP_NOTICE.hasData(), true, 'the shipped bulletin must normalise to at least one item');
  assert.equal(w.win.__SP_NOTICE.unread(), true, 'a fresh install has it unread (that is what the dot means)');
});

test('source invariants: pure ASCII, ES5, no imports, only the shell-prefix XHR', () => {
  assert.ok(!/[^\x00-\x7f]/.test(SRC), 'the source must be pure ASCII');
  assert.ok(!SRC.includes('=>'), 'ES5 only: no arrow functions');
  assert.ok(!SRC.includes('`'), 'ES5 only: no template strings');
  assert.ok(!/\b(let|const|class)\b/.test(SRC), 'ES5 only: no let/const/class');
  assert.ok(!/\bimport\b|\bexport\b/.test(SRC), 'never import/export a page module');
  assert.ok(!/['"]\/js\//.test(SRC), 'never address the page-owned js path');
  assert.ok(!/\bfetch\s*\(/.test(SRC), 'no fetch call');
  assert.ok(SRC.includes("var DATA_URL = '/__sp/notices.json'"), 'the one request target is the shell prefix');
  assert.ok(SRC.includes('XMLHttpRequest'), 'the data file is read with XHR');
  assert.ok(SRC.includes("'sp.notice.seen'"), 'the read state key is the documented localStorage key');
  assert.ok(SRC.includes('var(--z-modal,80)'), 'the panel uses the --z-modal token');
  for (const needle of ['http://127.0.0.1', 'http://localhost', 'http://10.0.0.1', 'http://192.168.']) {
    assert.ok(!SRC.includes(needle), `no hard-coded private address: ${needle}`);
  }
});
