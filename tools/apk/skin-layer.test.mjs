// skin-layer tests: vm + minimal stubs, the real shipped file is executed (no dependencies).
//
//   node --test tools/apk/skin-layer.test.mjs
//
// Covered: no catalog / no selection is a full no-op (identity resolve, manifest passed through) /
//          resolve hits, misses and is idempotent (exact + directory-prefix rules) / selection read from
//          player data (__SP_DATA.exportJSON doc.skins) / the /data/assets.json response body is rewritten
//          (chars avatar+portrait+spine front/back, other fields and other operators untouched, CDN and
//          query URL forms, other JSON files passed through) / catalog read from /__sp/skins.json via XHR /
//          broken catalog JSON and throwing player data never throw / bad rules are dropped (non-string,
//          data:, loopback + private hosts, prefix/to mismatch) / coexistence with the real shell-bridge
//          Image.src crossOrigin hook (it stays installed and untouched) / double load is idempotent /
//          the shell-bridge loader appends skin-layer.js after home-layer.js / source invariants
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
    setTimeout,
    clearTimeout,
  };
  return {
    win, sandbox, xhrs, calls,
    last: () => lastResponse,
    run: () => vm.runInNewContext(SRC, sandbox, { filename: 'skin-layer.js' }),
  };
}

/** The real shell-bridge, with just enough of a page for it to install the crossOrigin hook. */
function mkBridgeWorld(opts = {}) {
  const xhrs = [];
  const win = {};

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
    head: { appendChild() {} },
    body: { appendChild() {} },
    createElement() { return {}; },
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
  return { win, sandbox, doc, ImageStub, xhrs };
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

// ---------------------------------------------------------------- 11. shell-bridge wiring

test('shell-bridge loader: skin-layer.js is appended after home-layer.js with the same pattern', () => {
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
