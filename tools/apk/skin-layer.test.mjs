// skin-layer tests: vm + minimal stubs, the real shipped file is executed (no dependencies).
//
//   node --test tools/apk/skin-layer.test.mjs
//
// Covered: no catalog / no selection is a full no-op (identity resolve, manifest passed through) /
//          resolve hits, misses and is idempotent (exact + directory-prefix rules) / selection read from
//          player data (__SP_DATA.exportJSON doc.skins) / the /data/assets.json response body is rewritten
//          (chars avatar+portrait+spine front/back, other fields and other operators untouched, CDN and
//          query URL forms, other JSON files passed through) / catalog read from /__sp/skins.json via XHR /
//          a manifest fetch that arrives before the catalog read waits for it, bounded, and then gets the
//          skin (and is passed through untouched once the bound expires) / a catalog read that finishes
//          after load()/clear() is stale and never overwrites the newer API state / broken catalog JSON
//          and throwing player data never throw / bad rules are dropped (non-string, data:, loopback +
//          private hosts in every browser-normalised spelling: decimal/octal/hex IPv4 parts, percent
//          escapes, IPv4-mapped IPv6, ULA and link-local) / the selection priority is exercised with
//          conflicting keys in one world (player data > spData > __SP_SKIN_SELECT > localStorage) /
//          clear()/apply()/load()/onReady / coexistence with the real shell-bridge Image.src crossOrigin
//          hook (it stays installed and untouched) / double load is idempotent / the shell-bridge loader
//          really appends the skin-layer.js element it created, after home-layer.js / source invariants
//          (ES5, no page module paths, no network call beyond the /__sp/ catalog XHR).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'skin-layer.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-bridge.js'), 'utf8');

const AMIYA = 'char_002_amiya';
const SKADI = 'char_1012_skadi2';

// ---------------------------------------------------------------- fixtures

const MANIFEST = {
  version: 1,
  stats: { files: 3 },
  chars: {
    [AMIYA]: {
      avatar: '/assets/char/avatar/char_002_amiya.png',
      avatarE2: '/assets/char/avatar/char_002_amiya_2.png',
      portrait: '/assets/char/portrait/char_002_amiya_1.png',
      portraitE2: '/assets/char/portrait/char_002_amiya_2.png',
      spine: {
        front: {
          skel: '/assets/spine/op/char_002_amiya/front/char_002_amiya.skel',
          atlas: '/assets/spine/op/char_002_amiya/front/char_002_amiya.atlas',
          textures: ['/assets/spine/op/char_002_amiya/front/char_002_amiya.png'],
          pma: false,
          anims: { idle: 'Idle' },
          bounds: { x: 1 },
        },
        back: {
          skel: '/assets/spine/op/char_002_amiya/back/char_002_amiya.skel',
          atlas: '/assets/spine/op/char_002_amiya/back/char_002_amiya.atlas',
          textures: ['/assets/spine/op/char_002_amiya/back/char_002_amiya.png'],
          anims: { idle: 'Idle' },
        },
      },
    },
    [SKADI]: {
      avatar: '/assets/char/avatar/char_1012_skadi2.png',
      spine: {
        front: {
          skel: '/assets/spine/op/char_1012_skadi2/front/char_1012_skadi2.skel',
          atlas: '/assets/spine/op/char_1012_skadi2/front/char_1012_skadi2.atlas',
          textures: ['/assets/spine/op/char_1012_skadi2/front/char_1012_skadi2.png'],
        },
      },
    },
  },
  ui: { 'battle/sprite_shadow': '/assets/ui/battle/sprite_shadow.png' },
};

const CATALOG = {
  v: 1,
  skins: {
    [AMIYA]: {
      witch: {
        name: 'Witch',
        replace: {
          '/assets/char/avatar/char_002_amiya.png': '/assets/skins/amiya/witch/avatar.png',
          '/assets/char/portrait/char_002_amiya_1.png': '/assets/skins/amiya/witch/portrait_1.png',
          '/assets/spine/op/char_002_amiya/front/': '/assets/skins/amiya/witch/front/',
          '/assets/spine/op/char_002_amiya/back/': '/assets/skins/amiya/witch/back/',
        },
      },
    },
  },
};

const SKIN_AVATAR = '/assets/skins/amiya/witch/avatar.png';
const SKIN_PORTRAIT = '/assets/skins/amiya/witch/portrait_1.png';
const SKIN_SKEL = '/assets/skins/amiya/witch/front/char_002_amiya.skel';
const SELECT_AMIYA = { v: 1, skins: { [AMIYA]: 'witch' } };

// Four skins for one operator, each with a distinct avatar target: priority tests need values that
// a reversed order would visibly get wrong. Every world sets the same operator in several channels.
const PRIORITY_PATHS = {
  data: '/assets/skins/amiya/priority/data.png',
  bridge: '/assets/skins/amiya/priority/bridge.png',
  inject: '/assets/skins/amiya/priority/inject.png',
  mirror: '/assets/skins/amiya/priority/mirror.png',
};
const PRIORITY_CATALOG = {
  v: 1,
  skins: {
    [AMIYA]: {
      data: { replace: { [MANIFEST.chars[AMIYA].avatar]: PRIORITY_PATHS.data } },
      bridge: { replace: { [MANIFEST.chars[AMIYA].avatar]: PRIORITY_PATHS.bridge } },
      inject: { replace: { [MANIFEST.chars[AMIYA].avatar]: PRIORITY_PATHS.inject } },
      mirror: { replace: { [MANIFEST.chars[AMIYA].avatar]: PRIORITY_PATHS.mirror } },
    },
  },
};

/** One world carrying only the given selection channels, each with a conflicting key. */
function priorityWorld(channels) {
  const opts = { skins: PRIORITY_CATALOG };
  if (channels.data) opts.data = { skins: { [AMIYA]: channels.data } };
  if (channels.spData) opts.spData = { skins: { [AMIYA]: channels.spData } };
  if (channels.select) opts.select = { [AMIYA]: channels.select };
  if (channels.mirror) {
    opts.localStorage = {
      getItem: (k) => (k === 'sp.skin.v1' ? JSON.stringify({ v: 1, skins: { [AMIYA]: channels.mirror } }) : null),
    };
  }
  const w = mkWorld(opts);
  w.run();
  return w;
}

// ---------------------------------------------------------------- stubs

function FakeResponse(body, init) {
  const status = init && init.status ? init.status : 200;
  if (status === 204 || status === 205 || status === 304) throw new TypeError('null body status');
  this._body = String(body == null ? '' : body);
  this.status = status;
  this.statusText = (init && init.statusText) || '';
  this.ok = status >= 200 && status < 300;
}
FakeResponse.prototype.text = function () { return Promise.resolve(this._body); };
FakeResponse.prototype.json = function () { return Promise.resolve(JSON.parse(this._body)); };
FakeResponse.prototype.clone = function () { return new FakeResponse(this._body, { status: this.status }); };

function mkWorld(opts = {}) {
  const xhrs = [];
  const calls = [];
  const timers = [];
  let lastResponse = null;
  const win = {};

  function XHRStub() {
    this.url = null; this.method = null; this.sent = false;
    this.status = 0; this.responseText = ''; this.timeout = 0;
    xhrs.push(this);
  }
  XHRStub.prototype.open = function (m, u) { this.method = m; this.url = u; };
  XHRStub.prototype.send = function () { this.sent = true; };
  XHRStub.prototype.respond = function (status, text) { this.status = status; this.responseText = text; if (this.onload) this.onload(); };
  XHRStub.prototype.fail = function (kind) { if (kind === 'timeout') { if (this.ontimeout) this.ontimeout(); } else if (this.onerror) this.onerror(); };

  // Deterministic timers: the layer only uses setTimeout for its bounded catalog wait, so tests
  // inspect the requested delay and fire it by hand instead of sleeping.
  const setTimeoutStub = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; };
  const clearTimeoutStub = (t) => { if (t && typeof t === 'object') t.cleared = true; };

  const files = opts.files || {};
  const fetchImpl = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    calls.push({ url, init });
    const key = url.split('?')[0].replace(/^https?:\/\/[^/]+/, ''); // look fixtures up by path
    if (!Object.prototype.hasOwnProperty.call(files, key)) {
      lastResponse = new FakeResponse('', { status: 404, statusText: 'Not Found' });
      return Promise.resolve(lastResponse);
    }
    const entry = files[key];
    lastResponse = new FakeResponse(typeof entry === 'string' ? entry : JSON.stringify(entry), { status: 200, statusText: 'OK' });
    return Promise.resolve(lastResponse);
  };
  win.fetch = fetchImpl;

  if (opts.skins !== undefined) win.__SP_SKINS = opts.skins;
  if (opts.select !== undefined) win.__SP_SKIN_SELECT = opts.select;
  if (opts.data !== undefined) {
    win.__SP_DATA = { exportJSON: () => JSON.stringify(opts.data) };
  }
  if (opts.dataThrows) {
    win.__SP_DATA = { exportJSON: () => { throw new Error('player data unavailable'); } };
  }
  if (opts.spData !== undefined) win.spData = { get: () => JSON.stringify(opts.spData) };
  if (opts.localStorage !== undefined) win.localStorage = opts.localStorage;

  const sandbox = {
    window: win,
    XMLHttpRequest: XHRStub,
    Response: FakeResponse,
    fetch: fetchImpl,
    Promise,
    console,
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeoutStub,
  };
  return {
    win, sandbox, xhrs, calls, timers,
    last: () => lastResponse,
    run: () => vm.runInNewContext(SRC, sandbox, { filename: 'skin-layer.js' }),
    /** Fire every timer that was not cleared, in creation order. */
    fireTimers: () => { timers.slice().forEach((t) => { if (!t.cleared) t.fn(); }); },
  };
}

/** The real shell-bridge, with just enough of a page for it to install the crossOrigin hook. */
function mkBridgeWorld(opts = {}) {
  const xhrs = [];
  const win = {};
  const created = [];
  const appended = [];

  function XHRStub() {
    this.url = null; this.sent = false;
    xhrs.push(this);
  }
  XHRStub.prototype.open = function (m, u) { this.url = u; };
  XHRStub.prototype.send = function () { this.sent = true; };
  XHRStub.prototype.respond = function (status, text) { this.status = status; this.responseText = text; if (this.onload) this.onload(); };

  class ImageStub { constructor() { this._src = ''; this.crossOrigin = null; } }
  Object.defineProperty(ImageStub.prototype, 'src', {
    configurable: true,
    get() { return this._src; },
    set(v) { this._src = String(v); },
  });

  if (opts.skins !== undefined) win.__SP_SKINS = opts.skins;
  if (opts.data !== undefined) win.__SP_DATA = { exportJSON: () => JSON.stringify(opts.data) };

  const doc = {
    head: { appendChild(el) { appended.push(el); } },
    body: { appendChild() {} },
    createElement(tag) { const el = { tagName: String(tag).toUpperCase(), src: '', async: false }; created.push(el); return el; },
    addEventListener() {},
    getElementById() { return null; },
    readyState: 'complete',
  };
  const sandbox = {
    window: win,
    document: doc,
    HTMLImageElement: ImageStub,
    XMLHttpRequest: XHRStub,
    Response: FakeResponse,
    fetch: () => Promise.resolve(new FakeResponse('', { status: 404 })),
    Promise,
    console,
    setTimeout,
    clearTimeout,
    navigator: { userAgent: 'test' },
    location: { href: 'https://example.test/play', search: '', host: 'example.test' },
    URL,
    URLSearchParams,
  };
  return { win, sandbox, doc, created, appended, ImageStub, xhrs };
}

// ---------------------------------------------------------------- 1. no catalog / no selection: no-op

test('no catalog and no selection: full no-op (identity resolve, manifest passed through)', async () => {
  const w = mkWorld({ files: { '/data/assets.json': MANIFEST } });
  w.run();
  const skin = w.win.__SP_SKIN;
  assert.equal(typeof skin, 'object', 'the layer must expose __SP_SKIN even with no catalog');
  assert.equal(skin.version, 1);
  assert.equal(skin.active().count, 0);
  const avatar = MANIFEST.chars[AMIYA].avatar;
  assert.equal(skin.resolve(avatar), avatar, 'without a catalog resolve is the identity');
  assert.equal(w.xhrs.length, 1, 'exactly one catalog read attempt');
  assert.equal(w.xhrs[0].url, '/__sp/skins.json');
  assert.equal(w.xhrs[0].method, 'GET');
  assert.equal(w.calls.length, 0, 'the catalog must not be read with fetch');

  // The catalog 404s: still nothing happens.
  w.xhrs[0].respond(404, '');
  assert.equal(skin.active().count, 0);
  assert.equal(skin.resolve(avatar), avatar);

  // The manifest is handed out untouched (same response object: no body consumption).
  const res = await w.win.fetch('/data/assets.json');
  assert.equal(res, w.last(), 'a manifest fetch must pass through as the very same response');
  assert.equal(await res.text(), JSON.stringify(MANIFEST));
});

// ---------------------------------------------------------------- 2. resolve: hits, misses, idempotence

test('resolve: exact + directory-prefix hits, misses, and idempotence', () => {
  const w = mkWorld({ skins: CATALOG, data: SELECT_AMIYA });
  w.run();
  const skin = w.win.__SP_SKIN;
  assert.equal(skin.active().count, 1);
  assert.equal(skin.active().skins[AMIYA], 'witch');

  assert.equal(skin.resolve(MANIFEST.chars[AMIYA].avatar), SKIN_AVATAR);
  assert.equal(skin.resolve(MANIFEST.chars[AMIYA].portrait), SKIN_PORTRAIT);
  assert.equal(skin.resolve(MANIFEST.chars[AMIYA].spine.front.skel), SKIN_SKEL);
  assert.equal(
    skin.resolve(MANIFEST.chars[AMIYA].spine.back.textures[0]),
    '/assets/skins/amiya/witch/back/char_002_amiya.png',
  );
  assert.equal(skin.resolve(MANIFEST.chars[SKADI].avatar), MANIFEST.chars[SKADI].avatar, 'unselected operator is a miss');
  assert.equal(skin.resolve('/assets/ui/battle/sprite_shadow.png'), '/assets/ui/battle/sprite_shadow.png', 'unrelated URL is a miss');
  assert.equal(skin.resolve(SKIN_AVATAR), SKIN_AVATAR, 'a target URL is never mapped again');
  assert.equal(skin.resolve(SKIN_SKEL), SKIN_SKEL, 'a target directory is never mapped again');
  assert.equal(skin.resolve(MANIFEST.chars[AMIYA].avatar), SKIN_AVATAR, 'repeated resolve is stable');
  assert.equal(skin.resolve(''), '');
  assert.equal(skin.resolve(null), null);
  assert.equal(skin.resolve(123), 123);
});

// ---------------------------------------------------------------- 3. manifest response rewrite

test('manifest response: selected operator art is rewritten, everything else survives', async () => {
  const w = mkWorld({
    skins: CATALOG,
    data: SELECT_AMIYA,
    files: { '/data/assets.json': MANIFEST, '/data/local-assets.json': { groups: {} } },
  });
  w.run();

  const res = await w.win.fetch('/data/assets.json');
  assert.notEqual(res, w.last(), 'a rewritten manifest must be a fresh response');
  const m = await res.json();
  const a = m.chars[AMIYA];
  assert.equal(a.avatar, SKIN_AVATAR);
  assert.equal(a.portrait, SKIN_PORTRAIT);
  assert.equal(a.avatarE2, '/assets/char/avatar/char_002_amiya_2.png', 'a field without a rule stays as it was');
  assert.equal(a.spine.front.skel, SKIN_SKEL);
  assert.equal(a.spine.front.atlas, '/assets/skins/amiya/witch/front/char_002_amiya.atlas');
  assert.equal(a.spine.front.textures[0], '/assets/skins/amiya/witch/front/char_002_amiya.png');
  assert.equal(a.spine.front.pma, false, 'spine metadata (pma/anims/bounds) must be preserved');
  assert.deepEqual(a.spine.front.anims, { idle: 'Idle' });
  assert.deepEqual(a.spine.front.bounds, { x: 1 });
  assert.equal(m.chars[SKADI].avatar, MANIFEST.chars[SKADI].avatar, 'other operators stay untouched');
  assert.equal(m.ui['battle/sprite_shadow'], MANIFEST.ui['battle/sprite_shadow'], 'other manifest groups stay untouched');
  assert.deepEqual(m.stats, MANIFEST.stats);

  // The same manifest is recognised in its CDN-absolute and query-string forms.
  const res2 = await w.win.fetch('https://weishucdn.jiangjiangze.icu/data/assets.json?v=2');
  assert.equal((await res2.json()).chars[AMIYA].avatar, SKIN_AVATAR);
  const res3 = await w.win.fetch({ url: 'https://weishucdn.jiangjiangze.icu/data/assets.json' });
  assert.equal((await res3.json()).chars[AMIYA].avatar, SKIN_AVATAR);

  // Other JSON files are handed out untouched.
  const res4 = await w.win.fetch('/data/local-assets.json');
  assert.equal(res4, w.last(), 'non-manifest requests must pass through untouched');
  const res5 = await w.win.fetch('/data/chess.json');
  assert.equal(res5, w.last());
});

// ---------------------------------------------------------------- 4. coexistence with the Image.src hook

test('coexists with the shell-bridge Image.src crossOrigin hook (it stays installed and untouched)', () => {
  const b = mkBridgeWorld({ skins: CATALOG, data: SELECT_AMIYA });
  vm.runInNewContext(BRIDGE, b.sandbox, { filename: 'shell-bridge.js' });
  const before = Object.getOwnPropertyDescriptor(b.ImageStub.prototype, 'src');
  assert.equal(typeof before.set, 'function', 'the CORS hook must be installed before the skin layer loads');
  assert.equal(b.win.__SP_CORS_HOOK, 1);

  // The skin layer runs in the very same world (same HTMLImageElement prototype).
  vm.runInNewContext(SRC, b.sandbox, { filename: 'skin-layer.js' });
  const after = Object.getOwnPropertyDescriptor(b.ImageStub.prototype, 'src');
  assert.equal(after.set, before.set, 'the skin layer must not override the CORS setter');
  assert.equal(after.get, before.get, 'the getter must be untouched too');
  assert.equal(b.win.__SP_CORS_HOOK, 1, 'the hook marker must stay');
  assert.equal(b.win.__SP_SKIN.active().count, 1, 'the catalog must have been adopted in this world');

  const img = new b.ImageStub();
  img.crossOrigin = null;
  img.src = MANIFEST.chars[AMIYA].avatar;
  assert.equal(img.crossOrigin, 'anonymous', 'the CORS hook must still run');
  assert.equal(img.src, MANIFEST.chars[AMIYA].avatar, 'by design the layer never rewrites an <img> URL');
});

// ---------------------------------------------------------------- 5. broken input never throws

test('broken catalog JSON, broken shapes and throwing player data degrade to no-op', () => {
  // garbage body from /__sp/skins.json
  const w1 = mkWorld({ data: SELECT_AMIYA });
  w1.run();
  let ready = 0;
  w1.win.__SP_SKIN.onReady(() => { ready++; });
  assert.doesNotThrow(() => w1.xhrs[0].respond(200, '{ this is not json'));
  assert.equal(w1.win.__SP_SKIN.active().count, 0);
  assert.equal(ready, 1, 'onReady must fire after the read settled');

  // a non-object inline catalog falls through to the XHR, and a timeout is silent
  const w2 = mkWorld({ skins: 'nope', data: SELECT_AMIYA });
  w2.run();
  assert.equal(w2.xhrs.length, 1);
  assert.doesNotThrow(() => w2.xhrs[0].fail('timeout'));
  assert.equal(w2.win.__SP_SKIN.active().count, 0);

  // structurally broken catalog
  const w3 = mkWorld({ skins: { v: 1, skins: { [AMIYA]: { witch: { replace: null } } } }, data: SELECT_AMIYA });
  w3.run();
  assert.equal(w3.win.__SP_SKIN.active().count, 0);
  assert.equal(w3.win.__SP_SKIN.load({ skins: 'nope' }), false, 'load() reports a rejected catalog');

  // throwing player data + throwing storage must not break anything
  const w4 = mkWorld({
    skins: CATALOG,
    dataThrows: true,
    localStorage: { getItem: () => { throw new Error('private mode'); }, setItem: () => {} },
    select: { [AMIYA]: 'witch' },
  });
  assert.doesNotThrow(() => w4.run());
  assert.equal(w4.win.__SP_SKIN.active().count, 1, 'the injected selection still applies');

  // no window.__SP_DATA at all
  const w5 = mkWorld({ skins: CATALOG });
  w5.run();
  assert.equal(w5.win.__SP_SKIN.active().count, 0, 'no selection = no skin (the default)');
});

// ---------------------------------------------------------------- 6. rule validation

test('invalid rules are dropped: non-strings, data: URLs, loopback/private hosts, prefix mismatch', () => {
  const catalog = {
    v: 1,
    skins: {
      [AMIYA]: {
        bad: {
          replace: {
            'data:image/png;base64,AAAA': '/assets/skins/x.png',
            '/assets/a.png': 'http://127.0.0.1:8080/x.png',
            '/assets/b.png': 'http://192.168.1.5/x.png',
            '/assets/c.png': 'http://10.0.0.1/x.png',
            '/assets/d.png': 42,
            '/assets/e/': '/assets/skins/e',
            '/assets/f.png': 'http://localhost/x.png',
            '/assets/g.png': '//evil.example/x.png',
            '/assets/h.png': 'https://cdn.example.com/skins/h.png',
            'https://weishucdn.jiangjiangze.icu/assets/i.png': '/assets/skins/i.png',
          },
        },
      },
      [SKADI]: { bad2: { replace: { '/assets/g.png': 'data:text/plain,x' } } },
    },
  };
  const w = mkWorld({ skins: catalog, select: { [AMIYA]: 'bad', [SKADI]: 'bad2' } });
  w.run();
  const skin = w.win.__SP_SKIN;
  assert.equal(skin.active().count, 1, 'only the operator with at least one valid rule is active');
  assert.equal(skin.resolve('/assets/a.png'), '/assets/a.png');
  assert.equal(skin.resolve('/assets/b.png'), '/assets/b.png');
  assert.equal(skin.resolve('/assets/c.png'), '/assets/c.png');
  assert.equal(skin.resolve('/assets/d.png'), '/assets/d.png');
  assert.equal(skin.resolve('/assets/e/x.png'), '/assets/e/x.png', 'a directory prefix must map to a directory');
  assert.equal(skin.resolve('/assets/f.png'), '/assets/f.png');
  assert.equal(skin.resolve('/assets/g.png'), '/assets/g.png');
  assert.equal(skin.resolve('/assets/h.png'), 'https://cdn.example.com/skins/h.png', 'a public absolute target is allowed');
  assert.equal(skin.resolve('/assets/i.png'), '/assets/skins/i.png', 'an origin-prefixed source key still matches by path');
});

// ---------------------------------------------------------------- 6b. host forms a browser normalises

test('host validation: browser-normalised loopback/private spellings are all refused', () => {
  // Every key here resolves, in a real browser, to a local address: the URL parser folds 1..4 DNS
  // parts (decimal, octal, hex), percent-escapes, and IPv4-mapped IPv6 down to a single IPv4 value.
  const localHosts = [
    'http://127.1/x.png',
    'http://127.0.0.1/x.png',
    'http://0177.0.0.1/x.png',
    'http://0x7f.1/x.png',
    'http://0x7f000001/x.png',
    'http://2130706433/x.png',
    'http://%31%32%37.0.0.1/x.png',
    'http://0.0.0.0/x.png',
    'http://0/x.png',
    'http://10.0.0.1/x.png',
    'http://012.0.0.1/x.png',
    'http://172.16.0.1/x.png',
    'http://192.0.0.1/x.png',
    'http://192.168.1.5/x.png',
    'http://198.18.0.1/x.png',
    'http://100.64.0.1/x.png',
    'http://169.254.1.1/x.png',
    'http://255.255.255.255/x.png',
    'http://[::1]/x.png',
    'http://[::]/x.png',
    'http://[::ffff:127.0.0.1]/x.png',
    'http://[::ffff:7f00:1]/x.png',
    'http://[0:0:0:0:0:0:0:1]/x.png',
    'http://[fe80::1]/x.png',
    'http://[fc00::1]/x.png',
    'http://[fd12:3456::1]/x.png',
  ];
  for (const target of localHosts) {
    const w = mkWorld({ skins: { v: 1, skins: { [AMIYA]: { s: { replace: { '/assets/a.png': target } } } } }, select: { [AMIYA]: 's' } });
    w.run();
    assert.equal(w.win.__SP_SKIN.active().count, 0, `must refuse ${target}`);
    assert.equal(w.win.__SP_SKIN.resolve('/assets/a.png'), '/assets/a.png', `must refuse ${target}`);
  }

  // The same parser must keep real public hosts usable (a regression here breaks the feature).
  const publicHosts = [
    ['http://8.8.8.8/x.png', 'http://8.8.8.8/x.png'],
    ['https://cdn.example.com/skins/h.png', 'https://cdn.example.com/skins/h.png'],
    ['https://cdn42.example.com/skins/h.png', 'https://cdn42.example.com/skins/h.png'],
    ['https://[2001:4860:4860::8888]/skins/h.png', 'https://[2001:4860:4860::8888]/skins/h.png'],
    ['https://[2606:4700::1111]/skins/h.png', 'https://[2606:4700::1111]/skins/h.png'],
  ];
  for (const [target, expected] of publicHosts) {
    const w = mkWorld({ skins: { v: 1, skins: { [AMIYA]: { s: { replace: { '/assets/a.png': target } } } } }, select: { [AMIYA]: 's' } });
    w.run();
    assert.equal(w.win.__SP_SKIN.resolve('/assets/a.png'), expected, `must allow ${target}`);
  }

  // A host whose numeric tail is not valid IPv4 is not a URL a browser would load at all.
  for (const target of ['http://999.1.1.1/x.png', 'http://example.123/x.png', 'http://08/x.png', 'http://1.2.3.4.5/x.png']) {
    const w = mkWorld({ skins: { v: 1, skins: { [AMIYA]: { s: { replace: { '/assets/a.png': target } } } } }, select: { [AMIYA]: 's' } });
    w.run();
    assert.equal(w.win.__SP_SKIN.active().count, 0, `must refuse the malformed host in ${target}`);
  }
});

// ---------------------------------------------------------------- 7. catalog from /__sp/skins.json

test('catalog is read from /__sp/skins.json (XHR) and drives the same rewrite', async () => {
  const w = mkWorld({ data: SELECT_AMIYA, files: { '/data/assets.json': MANIFEST } });
  w.run();
  const skin = w.win.__SP_SKIN;
  assert.equal(w.xhrs.length, 1);
  assert.equal(w.xhrs[0].url, '/__sp/skins.json', 'the catalog must come from the shell prefix');
  assert.equal(skin.active().count, 0, 'nothing is active before the catalog arrives');

  w.xhrs[0].respond(200, JSON.stringify(CATALOG));
  assert.equal(skin.active().count, 1);
  const res = await w.win.fetch('/data/assets.json');
  assert.equal((await res.json()).chars[AMIYA].avatar, SKIN_AVATAR);
});

// ---------------------------------------------------------------- 8. selection channels

test('selection channels: player data first, then spData, injection and the localStorage mirror', () => {
  const viaData = mkWorld({ skins: CATALOG, data: SELECT_AMIYA });
  viaData.run();
  assert.equal(viaData.win.__SP_SKIN.active().skins[AMIYA], 'witch');

  const viaBridge = mkWorld({ skins: CATALOG, spData: SELECT_AMIYA });
  viaBridge.run();
  assert.equal(viaBridge.win.__SP_SKIN.active().skins[AMIYA], 'witch');

  const viaInjection = mkWorld({ skins: CATALOG, select: SELECT_AMIYA });
  viaInjection.run();
  assert.equal(viaInjection.win.__SP_SKIN.active().skins[AMIYA], 'witch');

  const store = { getItem: (k) => (k === 'sp.skin.v1' ? JSON.stringify(SELECT_AMIYA) : null) };
  const viaMirror = mkWorld({ skins: CATALOG, localStorage: store });
  viaMirror.run();
  assert.equal(viaMirror.win.__SP_SKIN.active().skins[AMIYA], 'witch');

  // the catalog-level default only fills operators the player did not choose
  const withDefault = mkWorld({ skins: { v: 1, default: { [AMIYA]: 'witch' }, skins: CATALOG.skins } });
  withDefault.run();
  assert.equal(withDefault.win.__SP_SKIN.active().skins[AMIYA], 'witch');
  const overriding = mkWorld({ skins: { v: 1, default: { [AMIYA]: 'missing' }, skins: CATALOG.skins }, select: SELECT_AMIYA });
  overriding.run();
  assert.equal(overriding.win.__SP_SKIN.active().skins[AMIYA], 'witch', 'the player choice wins over the default');
});

// ---------------------------------------------------------------- 8b. selection priority, conflicting keys

test('selection priority: conflicting channels in one world resolve to the highest-priority skin', () => {
  assert.equal(new Set(Object.values(PRIORITY_PATHS)).size, 4, 'the four priority targets must be distinguishable');

  // Each pair of adjacent channels must be decided by the documented order
  // player data > spData > __SP_SKIN_SELECT > localStorage.
  const cases = [
    [{ data: 'data', spData: 'bridge' }, 'data'],
    [{ data: 'data', select: 'inject' }, 'data'],
    [{ data: 'data', mirror: 'mirror' }, 'data'],
    [{ spData: 'bridge', select: 'inject' }, 'bridge'],
    [{ spData: 'bridge', mirror: 'mirror' }, 'bridge'],
    [{ select: 'inject', mirror: 'mirror' }, 'inject'],
    [{ data: 'data', spData: 'bridge', select: 'inject', mirror: 'mirror' }, 'data'],
    // ... and two triples, so a "first writer wins" implementation cannot slip through either.
    [{ data: 'data', spData: 'bridge', select: 'inject' }, 'data'],
    [{ spData: 'bridge', select: 'inject', mirror: 'mirror' }, 'bridge'],
  ];
  for (const [channels, winner] of cases) {
    const w = priorityWorld(channels);
    const label = `channels=${JSON.stringify(channels)}`;
    assert.equal(w.win.__SP_SKIN.active().skins[AMIYA], winner, `${label}: active key`);
    assert.equal(w.win.__SP_SKIN.active().count, 1, `${label}: exactly one operator is skinned`);
    assert.equal(w.win.__SP_SKIN.resolve(MANIFEST.chars[AMIYA].avatar), PRIORITY_PATHS[winner], `${label}: resolved URL`);
  }
});

// ---------------------------------------------------------------- 9. clear / apply / load / onReady

test('clear() drops the skins, apply() brings them back, load() replaces the catalog', async () => {
  const w = mkWorld({ skins: CATALOG, data: SELECT_AMIYA, files: { '/data/assets.json': MANIFEST } });
  w.run();
  const skin = w.win.__SP_SKIN;
  const avatar = MANIFEST.chars[AMIYA].avatar;
  assert.equal(skin.clear(), true);
  assert.equal(skin.active().count, 0);
  assert.equal(skin.resolve(avatar), avatar);
  const res = await w.win.fetch('/data/assets.json');
  assert.equal((await res.json()).chars[AMIYA].avatar, avatar, 'with no active skin the manifest is untouched');

  assert.equal(skin.apply(), 1, 'apply() re-reads the selection');
  assert.equal(skin.resolve(avatar), SKIN_AVATAR);

  assert.equal(skin.load({ skins: {} }), false);
  assert.equal(skin.active().catalog, false, 'a rejected catalog clears the old one');
  assert.equal(skin.resolve(avatar), avatar);

  let ready = 0;
  skin.onReady(() => { ready++; });
  assert.equal(ready, 1, 'onReady fires immediately once the read settled');
  skin.onReady(42);
  skin.load(null);
  assert.equal(skin.active().count, 0, 'load(null) must not throw and must leave nothing active');
});

// ---------------------------------------------------------------- 10. double load is idempotent

test('loading the layer twice changes nothing (one API object, one fetch wrapper, one catalog read)', () => {
  const w = mkWorld({ skins: CATALOG, data: SELECT_AMIYA });
  w.run();
  const firstFetch = w.win.fetch;
  const firstApi = w.win.__SP_SKIN;
  w.run();
  assert.equal(w.win.__SP_SKIN, firstApi, 'the second load must keep the same API object');
  assert.equal(w.win.fetch, firstFetch, 'the second load must not wrap fetch again');
  assert.equal(w.xhrs.length, 0, 'an inline catalog needs no XHR at all');

  const w2 = mkWorld({ data: SELECT_AMIYA, files: { '/data/assets.json': MANIFEST } });
  w2.run();
  w2.run();
  assert.equal(w2.xhrs.length, 1, 'only the first load reads the catalog');
});

// ---------------------------------------------------------------- 10b. manifest fetch before the catalog

test('a manifest fetch that beats the catalog read waits (bounded) and is then rewritten', async () => {
  const w = mkWorld({ data: SELECT_AMIYA, files: { '/data/assets.json': MANIFEST } });
  w.run();
  const skin = w.win.__SP_SKIN;
  let delivered = null;
  const pending = w.win.fetch('/data/assets.json').then((res) => { delivered = res; return res; });
  await new Promise((resolve) => setTimeout(resolve, 0)); // drain microtasks
  assert.equal(delivered, null, 'the early manifest must not be delivered before the catalog read settled');
  assert.equal(w.timers.length, 1, 'the wait must be one bounded timer, not an unbounded hold');
  assert.ok(w.timers[0].ms > 0 && w.timers[0].ms <= 1500, `wait bound must stay <= 1500ms, got ${w.timers[0].ms}`);

  // A non-manifest request is never parked behind the catalog read.
  const other = await w.win.fetch('/data/chess.json');
  assert.equal(other, w.last(), 'non-manifest requests pass through immediately');

  w.xhrs[0].respond(200, JSON.stringify(CATALOG));
  const res = await pending;
  assert.notEqual(res, w.last(), 'once the catalog landed the early manifest is rewritten');
  assert.equal((await res.json()).chars[AMIYA].avatar, SKIN_AVATAR);
  assert.equal(w.timers[0].cleared, true, 'settling must release the wait instead of leaving the timer armed');
  assert.equal(skin.active().count, 1);
});

test('a manifest fetch whose catalog never arrives is passed through when the bound expires', async () => {
  const w = mkWorld({ data: SELECT_AMIYA, files: { '/data/assets.json': MANIFEST } });
  w.run();
  let delivered = null;
  const pending = w.win.fetch('/data/assets.json').then((res) => { delivered = res; return res; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(delivered, null);
  assert.equal(w.timers.length, 1);

  w.fireTimers(); // the bound expires with the catalog read still in flight
  const res = await pending;
  assert.equal(res, w.last(), 'after the bound the response is handed through untouched');
  assert.equal(await res.text(), JSON.stringify(MANIFEST));
  assert.equal(w.win.__SP_SKIN.active().count, 0);

  // The slow catalog still activates normally for every later manifest read.
  w.xhrs[0].respond(200, JSON.stringify(CATALOG));
  const res2 = await w.win.fetch('/data/assets.json');
  assert.equal((await res2.json()).chars[AMIYA].avatar, SKIN_AVATAR);
});

// ---------------------------------------------------------------- 10c. stale catalog reads

test('a catalog read that finishes after load()/clear() is stale and never overwrites the API state', () => {
  // load() while the initial read is in flight: the read result must lose
  const w1 = mkWorld({ data: SELECT_AMIYA });
  w1.run();
  assert.equal(w1.win.__SP_SKIN.load(CATALOG), true);
  assert.equal(w1.win.__SP_SKIN.active().skins[AMIYA], 'witch');
  w1.xhrs[0].respond(200, JSON.stringify({ v: 1, skins: {} }));
  assert.equal(w1.win.__SP_SKIN.active().skins[AMIYA], 'witch', 'the late read must not replace load()');
  assert.equal(w1.win.__SP_SKIN.active().catalog, true);

  // ... and a rejected load() must not be undone by the late read either
  const w3 = mkWorld({ data: SELECT_AMIYA });
  w3.run();
  assert.equal(w3.win.__SP_SKIN.load({ v: 1, skins: {} }), false);
  w3.xhrs[0].respond(200, JSON.stringify(CATALOG));
  assert.equal(w3.win.__SP_SKIN.active().count, 0, 'a stale read must not undo load(null)');

  // clear() must survive the late read, and the read must still report itself settled
  const w2 = mkWorld({ data: SELECT_AMIYA });
  w2.run();
  let ready = 0;
  w2.win.__SP_SKIN.onReady(() => { ready++; });
  w2.win.__SP_SKIN.clear();
  w2.xhrs[0].respond(200, JSON.stringify(CATALOG));
  assert.equal(w2.win.__SP_SKIN.active().count, 0, 'the late read must not resurrect a cleared state');
  assert.equal(w2.win.__SP_SKIN.active().catalog, false);
  assert.equal(w2.win.__SP_SKIN.resolve(MANIFEST.chars[AMIYA].avatar), MANIFEST.chars[AMIYA].avatar);
  assert.equal(ready, 1, 'onReady fires once the read actually finished');

  // A stale read must not even re-run apply(): that could undo clear() through the loaded catalog.
  const w4 = mkWorld({ data: SELECT_AMIYA });
  w4.run();
  w4.win.__SP_SKIN.load(CATALOG);
  w4.win.__SP_SKIN.clear();
  w4.xhrs[0].respond(200, JSON.stringify(CATALOG));
  assert.equal(w4.win.__SP_SKIN.active().count, 0, 'the stale read must not re-apply a cleared selection');
  assert.equal(w4.win.__SP_SKIN.apply(), 1, 'only an explicit apply() brings the loaded catalog back');
});

// ---------------------------------------------------------------- 11. shell-bridge wiring

test('shell-bridge loader really appends the created skin-layer script (recorded DOM)', () => {
  // Source-level shape: own prefix, order, insertion-order flag, idempotence marker.
  const iLobby = BRIDGE.indexOf("'/__sp/lobby.js'");
  assert.ok(iLobby > 0, 'the loader block must exist');
  const block = BRIDGE.slice(iLobby - 300);
  const iHook = block.indexOf("'/__sp/room-hook.js'");
  const iHome = block.indexOf("'/__sp/home-layer.js'");
  const iSkin = block.indexOf("'/__sp/skin-layer.js'");
  assert.ok(iHook > 0 && iHome > iHook, 'lobby -> room-hook -> home-layer order is untouched');
  assert.ok(iSkin > iHome, 'skin-layer.js must be loaded after home-layer.js');
  const seg = block.slice(iSkin, iSkin + 240);
  assert.ok(seg.includes('async = false'), 'the skin script must keep the insertion order');
  assert.ok(block.slice(iSkin - 120, iSkin).includes('window.__SP_SKIN'), 'the idempotence marker must guard the load');
  assert.ok(!/src = ['"][^'"]*\/js\/skin-layer\.js['"]/.test(block), 'never load it from the page-owned /js/ path');
  // v6.3: 房间生命周期层也在同一段装载里（它同样只从 /__sp/ 取，且由幂等标记守卫）。
  const iLc = block.indexOf("'/__sp/room-lifecycle.js'");
  assert.ok(iLc > iHome && iLc < iSkin, 'room-lifecycle 在 home-layer 之后、skin-layer 之前');
  assert.ok(block.slice(iLc - 140, iLc).includes('window.__SP_ROOM_LC'), 'room-lifecycle 也要幂等标记守卫');
  assert.ok(!/src = ['"][^'"]*\/js\/room-lifecycle\.js['"]/.test(block), 'room-lifecycle 也只许从 /__sp/ 取');

  // v6.8: 公告板也在同一段装载里，同样 /__sp/ + API 形态守卫（__SP_NOTICE 也可能是内联数据）。
  const iNb = block.indexOf("'/__sp/notice-board.js'");
  assert.ok(iNb > iHome && iNb < iSkin, 'notice-board 在 home-layer 之后、skin-layer 之前');
  assert.ok(block.slice(iNb - 160, iNb).includes("typeof window.__SP_NOTICE.open !== 'function'"),
    'notice-board 的守卫必须查 API 形态（数据对象不能当成已加载）');
  assert.ok(!/src = ['"][^'"]*\/js\/notice-board\.js['"]/.test(block), 'notice-board 也只许从 /__sp/ 取');

  // v8.0: 外壳设置命名空间（shell-prefs.js）最先装载 —— 外观/公告/大厅读设置前必须已完成
  // 「保险库 ↔ 本 origin localStorage」的启动合并。它只依赖 player-data.js（MainActivity 先注入）。
  const iPrefs = BRIDGE.indexOf("'/__sp/shell-prefs.js'");
  const iApp = BRIDGE.indexOf("'/__sp/appearance.js'");
  assert.ok(iPrefs > 0 && iPrefs < iLobby, 'shell-prefs.js 必须最先装载（在 lobby.js 之前）');
  assert.ok(iPrefs < iApp, 'shell-prefs.js 必须早于 appearance.js（外观读它取持久值）');
  assert.ok(BRIDGE.slice(iPrefs - 120, iPrefs).includes('window.__SP_PREFS'), 'shell-prefs 也要幂等标记守卫');
  assert.ok(!/src = ['"][^'"]*\/js\/shell-prefs\.js['"]/.test(BRIDGE), 'shell-prefs 也只许从 /__sp/ 取');

  // ... and the loader is really executed: the recording DOM must show the created element appended.
  const b = mkBridgeWorld({ skins: CATALOG, data: SELECT_AMIYA });
  vm.runInNewContext(BRIDGE, b.sandbox, { filename: 'shell-bridge.js' });
  assert.deepEqual(b.appended.map((el) => el.src), [
    '/__sp/shell-prefs.js', '/__sp/lobby.js', '/__sp/room-hook.js', '/__sp/home-layer.js',
    '/__sp/shell-join.js', '/__sp/core-hooks.js', '/__sp/room-lifecycle.js', '/__sp/appearance.js',
    '/__sp/screen-fixes.js', '/__sp/server-config.js',
    '/__sp/notice-board.js', '/__sp/skin-layer.js', '/__sp/art-prefetch.js',
    '/__sp/preload-center.js', '/__sp/ui/shellPanels.js',
  ], 'the loader must append our scripts in order, the panel module last '
    + '(2026-10-09: it defines __SP_SHELL.openPanel, which the overlay buttons need on server pages)');
  assert.equal(b.created.length, b.appended.length, 'every element the loader created was appended');
  b.appended.forEach((el, i) => assert.equal(el, b.created[i], 'the appended element is the one just created'));
  // v6.9 appends art-prefetch.js, v7.1 the preload center and 2026-10-09 the shellPanels module after skin
  const skin = b.appended[b.appended.length - 4];
  assert.equal(skin.tagName, 'SCRIPT');
  assert.equal(skin.async, false, 'async = false must reach the appended element');
  // Reverse assertion: the src only ever lives on a created element, and only an appended element
  // is reachable by the page -- deleting the appendChild call leaves this test red.
  assert.equal(skin.src, '/__sp/skin-layer.js');
  assert.ok(b.created.indexOf(skin) >= 0, 'the appended object must be a script the loader created');

  // v6.9: art-prefetch.js (no-embedded-assets background prefetch) is the LAST loader entry: same
  // /__sp/ prefix, async=false, guarded by its own idempotence marker window.__SP_ART.
  const iArt = block.indexOf("'/__sp/art-prefetch.js'");
  assert.ok(iArt > iSkin, 'art-prefetch.js must be loaded after skin-layer.js');
  assert.ok(block.slice(iArt - 140, iArt).includes('window.__SP_ART'),
    'art-prefetch must be guarded by its idempotence marker');
  assert.ok(!/src = ['"][^'"]*\/js\/art-prefetch\.js['"]/.test(block), 'never load it from the page-owned /js/ path');
  const art = b.appended[b.appended.length - 3]; // 2026-10-09: the shellPanels module and the preload center follow it
  assert.equal(art.tagName, 'SCRIPT');
  assert.equal(art.src, '/__sp/art-prefetch.js');
  assert.equal(art.async, false, 'art-prefetch must keep the insertion order');

  // v7.1: preload-center.js (browser disk-cache preload center) is the LAST loader entry: same
  // /__sp/ prefix, async=false, guarded by its own idempotence marker window.__SP_PRELOAD.
  const iPre = block.indexOf("'/__sp/preload-center.js'");
  assert.ok(iPre > iArt, 'preload-center.js must be loaded after art-prefetch.js');
  assert.ok(block.slice(iPre - 140, iPre).includes('window.__SP_PRELOAD'),
    'the preload center must be guarded by its idempotence marker');
  assert.ok(!/src = ['"][^'"]*\/js\/preload-center\.js['"]/.test(block), 'never load it from the page-owned /js/ path');
  const pre = b.appended[b.appended.length - 2]; // the shellPanels module is appended after it (2026-10-09)
  assert.equal(pre.tagName, 'SCRIPT');
  assert.equal(pre.src, '/__sp/preload-center.js');
  assert.equal(pre.async, false, 'the preload center must keep the insertion order');

  // The guard is real: once the layer is loaded, a second bridge run appends no second copy.
  vm.runInNewContext(SRC, b.sandbox, { filename: 'skin-layer.js' });
  assert.equal(typeof b.win.__SP_SKIN, 'object', 'the appended script is what installs the API');
  const before = b.appended.filter((el) => el.src === '/__sp/skin-layer.js').length;
  vm.runInNewContext(BRIDGE, b.sandbox, { filename: 'shell-bridge.js' });
  const after = b.appended.filter((el) => el.src === '/__sp/skin-layer.js').length;
  assert.equal(after, before, 'the idempotence marker must stop a second skin-layer.js append');
});

// ---------------------------------------------------------------- 12. source invariants

test('source invariants: ES5, no page modules, no network call beyond the /__sp/ catalog', () => {
  assert.ok(!SRC.includes('=>'), 'ES5 only: no arrow functions');
  assert.ok(!SRC.includes('`'), 'ES5 only: no template strings');
  assert.ok(!/\b(let|const|class)\b/.test(SRC), 'ES5 only: no let/const/class');
  assert.ok(!/\bimport\b|\bexport\b/.test(SRC), 'never import/export a page module');
  assert.ok(!/['"]\/js\//.test(SRC), 'never address the page-owned /js/ path');
  assert.ok(!/\bfetch\s*\(/.test(SRC), 'the layer must not call fetch itself (only wrap window.fetch)');
  assert.ok(SRC.includes("var CATALOG_URL = '/__sp/skins.json'"), 'the one request target is the shell prefix');
  assert.ok(SRC.includes('XMLHttpRequest'), 'the catalog is read with XHR');
  for (const needle of ['http://127.0.0.1', 'http://localhost', 'http://10.0.0.1', 'http://192.168.']) {
    assert.ok(!SRC.includes(needle), `no hard-coded private address: ${needle}`);
  }
});
