// mods-panel.test.mjs — mod 管理器（业主 2026-10-11）：
//   · server/overlay/sp-mods.mjs —— 目录代理 / 下载安装 / 启用标记 / 出网白名单 / zip-slip 防护
//   · extras/public/js/ui/modsPanel.js —— 悬浮窗样式的面板，注册成 kind 'mods'
//   · 悬浮窗（preloadPanel.js）里那个单独按钮 + 资源预载压到两行
//
// 全部用例不碰网络、不碰真盘（overlay 的 fetch 与目录都是注入的），渲染用例在没有上游 vendor 时
// 自行 skip（CI 在 build-webroot 之前跑这套，见 preload-panel.test.mjs 的同款约定）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildZip } from './make-art-packs.mjs';
import * as mods from './overlay/sp-mods.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PANEL_SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'modsPanel.js'), 'utf8');
const PRELOAD_SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'preloadPanel.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-bridge.js'), 'utf8');

const UPSTREAM_VENDOR = path.join(here, '..', '..', 'public', 'vendor', 'htm.module.js');
const HTM = fs.existsSync(UPSTREAM_VENDOR) ? fs.readFileSync(UPSTREAM_VENDOR, 'utf8') : '';
const needsUpstream = (name, fn) => test(name, (t) =>
  (HTM ? fn(t) : t.skip('upstream public/ not built yet (run build-webroot)')));

// ---- helpers -------------------------------------------------------------------------------------
function tmpWorkshop() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spmods-'));
}

function packZip(files, over) {
  const pack = Object.assign({ id: 'demo', name: 'Demo pack', api: '>=1 <2', layer: 'A' }, over || {});
  const entries = [{ name: 'pack.json', data: Buffer.from(JSON.stringify(pack)) }];
  for (const [name, text] of Object.entries(files || {})) entries.push({ name: name, data: Buffer.from(text) });
  return buildZip(entries);
}

/** A fetch stub that serves the catalogue and one pack zip, and counts every dial. */
function fetchStub(opts) {
  const o = opts || {};
  const dialed = [];
  const impl = async (url) => {
    dialed.push(String(url));
    if (String(url).indexOf('/api/mods') >= 0) {
      return { ok: true, status: 200, arrayBuffer: async () => (o.catalogBytes || Buffer.from(JSON.stringify({
        mods: [{ id: 'demo', name: 'Demo pack', size: 1234, uploadedAt: '2026-10-11T00:00:00Z', note: 'hi', download: '/mods/demo.zip' }],
        flagged: [],
      }))) };
    }
    if (String(url).indexOf('/mods/demo.zip') >= 0) {
      return { ok: true, status: 200, arrayBuffer: async () => (o.packBytes || packZip({ 'content/bonds.json': '{"a":1}' })) };
    }
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  impl.dialed = dialed;
  return impl;
}

// ---- overlay: the site allow-list (Mimosa) --------------------------------------------------------
test('overlay: only the configured site may be dialed — other hosts / loopback / private / bad schemes are refused', () => {
  assert.equal(mods.assertFetchable(mods.MODS_SITE_ORIGIN + '/mods/demo.zip').ok, true, 'the site itself is allowed');
  assert.equal(mods.assertFetchable('http://evil.example.com/x.zip').reason, 'HOST_NOT_ALLOWED');
  assert.equal(mods.assertFetchable('http://127.0.0.1:25570/x.zip').reason, 'HOST_DENIED');
  assert.equal(mods.assertFetchable('http://192.168.1.9:25570/x.zip').reason, 'HOST_DENIED');
  assert.equal(mods.assertFetchable('http://10.0.0.1/x.zip').reason, 'HOST_DENIED');
  assert.equal(mods.assertFetchable('file:///etc/passwd').reason, 'BAD_SCHEME');
  assert.equal(mods.assertFetchable('http://user:pw@47.103.14.217:25570/x.zip').reason, 'BAD_URL');
  assert.equal(mods.assertFetchable('not a url').reason, 'BAD_URL');
});

test('overlay: a catalogue entry pointing off-site is kept but marked not-downloadable', () => {
  const off = mods.normalizeEntry({ id: 'x', name: 'X', download: 'http://evil.example.com/x.zip' }, false);
  assert.equal(off.downloadAllowed, false, 'off-site download must not be dialable');
  const on = mods.normalizeEntry({ id: 'y', name: 'Y', download: '/mods/y.zip' }, false);
  assert.equal(on.downloadAllowed, true);
  assert.equal(on.download, mods.MODS_SITE_ORIGIN + '/mods/y.zip', 'a relative download is absolutised against the site');
  // unknown fields are dropped (catalogue content is data, never instructions)
  const extra = mods.normalizeEntry({ id: 'z', name: 'Z', download: '/mods/z.zip', evil: 'do something' }, false);
  assert.equal('evil' in extra, false);
});

// ---- overlay: zip safety --------------------------------------------------------------------------
test('overlay: the zip reader refuses traversal, absolute paths, backslashes and drive letters', () => {
  assert.equal(mods.isSafeEntryName('pack.json'), true);
  assert.equal(mods.isSafeEntryName('content/bonds.json'), true);
  assert.equal(mods.isSafeEntryName('../escape.txt'), false);
  assert.equal(mods.isSafeEntryName('a/../../x'), false);
  assert.equal(mods.isSafeEntryName('/etc/passwd'), false);
  assert.equal(mods.isSafeEntryName('a' + String.fromCharCode(92) + 'b'), false);
  assert.equal(mods.isSafeEntryName('C:/x'), false);
});

test('overlay: a pack zip with a traversal entry is refused whole — nothing lands on disk', () => {
  const zip = buildZip([{ name: 'aaaaaaaa', data: Buffer.from('x') }]);
  const bad = Buffer.from(zip);
  const same = '../../x'; // exactly 8 bytes, same as 'aaaaaaaa'
  bad.write(same, 30);
  const cd = bad.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bad.write(same, cd + 46);
  const dir = tmpWorkshop();
  try {
    const ex = mods.extractPackZip(bad, dir);
    assert.equal(ex.ok, false);
    assert.equal(ex.reason, 'UNSAFE_ENTRY');
    assert.equal(fs.readdirSync(dir).length, 0, 'the refused pack must leave nothing behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay: a good pack zip round-trips (nested dirs, store method)', () => {
  const dir = tmpWorkshop();
  try {
    const ex = mods.extractPackZip(packZip({ 'content/bonds.json': '{"a":1}' }), dir);
    assert.equal(ex.ok, true, JSON.stringify(ex));
    assert.equal(ex.entries, 2);
    assert.equal(fs.readFileSync(path.join(dir, 'content', 'bonds.json'), 'utf8'), '{"a":1}');
    const v = mods.validatePack(JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8')), 'demo');
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.pack.layer, 'A');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- overlay: pack.json / api range ---------------------------------------------------------------
test('overlay: pack.json must match the directory name and the api range must admit the current generation', () => {
  assert.equal(mods.validatePack({ id: 'a', api: '>=1 <2' }, 'a').ok, true);
  assert.equal(mods.validatePack({ id: 'a', api: '1.x' }, 'a').ok, true);
  assert.equal(mods.validatePack({ id: 'a' }, 'a').ok, true, 'an absent api is the engine\'s "legal range" case');
  assert.equal(mods.validatePack({ id: 'a', api: '>=2 <3' }, 'a').reason, 'API_MISMATCH');
  assert.equal(mods.validatePack({ id: 'a' }, 'b').reason, 'ID_MISMATCH');
  assert.equal(mods.validatePack(null, 'a').reason, 'BAD_PACK_JSON');
  assert.equal(mods.apiAllows('>=1 <2', 1), true);
  assert.equal(mods.apiAllows('>=1 <2', 2), false);
  assert.equal(mods.apiAllows('<2', 1), true);
  assert.equal(mods.apiAllows('2.x', 1), false);
});

// ---- overlay: the A-layer surface gate (路径 A) ----------------------------------------------------
test('overlay: a pack that carries a CODE entry is refused by name, and the field is reported', () => {
  for (const field of mods.CODE_ENTRY_FIELDS) {
    const bad = { id: 'a' };
    bad[field] = field === 'routes' ? ['/x'] : {};
    const v = mods.validatePack(bad, 'a');
    assert.equal(v.ok, false, field + ' must be refused');
    assert.equal(v.reason, 'MOD_CODE_ENTRY_UNSUPPORTED', field + ' gets the code-entry reason');
    assert.deepEqual(v.fields, [field], 'the offending field is named');
  }
  // a data-layer pack stays accepted
  assert.equal(mods.validatePack({ id: 'a', content: ['bonds.json'], notices: {} }, 'a').ok, true);
});

test('overlay: an UNKNOWN field is refused by name (closed allowlist — nothing unfamiliar reaches the device)', () => {
  const v = mods.validatePack({ id: 'a', someFutureThing: 1 }, 'a');
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'MOD_UNSUPPORTED_FIELD');
  assert.deepEqual(v.fields, ['someFutureThing']);
  // metadata + the accepted data fields are all in the allowlist
  for (const f of mods.KNOWN_FIELDS) {
    const pr = { id: 'a' };
    pr[f] = f === 'id' ? 'a' : (f === 'api' ? '>=1 <2' : 'x');
    assert.notEqual(mods.validatePack(pr, 'a').reason, 'MOD_UNSUPPORTED_FIELD', f + ' must be a known field');
  }
});

test('overlay: install refuses a code-carrying pack and leaves nothing on disk', async () => {
  const dir = tmpWorkshop();
  try {
    const c = mods.createController({
      workshopDir: dir,
      fetchImpl: fetchStub({ packBytes: packZip({ 'kits/x.js': 'export default 1;' }, { server: { modules: [] } }) }),
      log: () => {},
    });
    c.setFeature(true);
    const r = await c.install('demo');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'MOD_CODE_ENTRY_UNSUPPORTED');
    assert.deepEqual(r.fields, ['server']);
    assert.equal(fs.existsSync(path.join(dir, 'demo')), false, 'a refused pack must not stay on disk');
    assert.equal(c.installed().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay: the module carries a version (filename stability + version self-check)', () => {
  assert.equal(typeof mods.version, 'number', 'a hot-updated overlay must be able to name its version');
  assert.ok(mods.version >= 1);
});

// ---- overlay: the feature gate + the whole install path -------------------------------------------
test('overlay: the manager is OFF by default — install/state/uninstall refuse until it is switched on', async () => {
  const dir = tmpWorkshop();
  try {
    const c = mods.createController({ workshopDir: dir, fetchImpl: fetchStub(), log: () => {} });
    assert.equal(c.feature(), false, 'default OFF');
    assert.equal((await c.install('demo')).error, 'FEATURE_OFF');
    assert.equal(c.setEnabled('demo', true).error, 'FEATURE_OFF');
    assert.equal(c.uninstall('demo').error, 'FEATURE_OFF');
    assert.equal(c.setFeature(true).ok, true);
    assert.equal(c.feature(), true, 'the switch persists to disk');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay: install downloads, validates, lands the pack and leaves it DISABLED', async () => {
  const dir = tmpWorkshop();
  try {
    const f = fetchStub();
    const c = mods.createController({ workshopDir: dir, fetchImpl: f, log: () => {} });
    c.setFeature(true);
    const r = await c.install('demo');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fs.existsSync(path.join(dir, 'demo', 'pack.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'demo', 'content', 'bonds.json')), true);
    const inst = c.installed();
    assert.equal(inst.length, 1);
    assert.equal(inst[0].id, 'demo');
    assert.equal(inst[0].enabled, false, 'a freshly installed pack is NOT enabled');
    assert.equal(c.setEnabled('demo', true).ok, true);
    assert.equal(c.installed()[0].enabled, true);
    assert.equal(c.uninstall('demo').ok, true);
    assert.equal(c.installed().length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'demo')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay: an api-mismatched pack is refused and its directory is cleaned up', async () => {
  const dir = tmpWorkshop();
  try {
    const c = mods.createController({ workshopDir: dir, fetchImpl: fetchStub({ packBytes: packZip({}, { api: '>=2 <3' }) }), log: () => {} });
    c.setFeature(true);
    const r = await c.install('demo');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'API_MISMATCH');
    assert.equal(fs.existsSync(path.join(dir, 'demo')), false, 'a refused pack must not stay on disk');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay: the catalogue is fetched from the site once per TTL and merged with the installed set', async () => {
  const dir = tmpWorkshop();
  try {
    const f = fetchStub();
    let clock = 1000;
    const c = mods.createController({ workshopDir: dir, fetchImpl: f, log: () => {}, now: () => clock });
    c.setFeature(true);
    const a = await c.catalog(false);
    assert.equal(a.errors.length, 0, JSON.stringify(a.errors));
    assert.equal(a.mods.length, 1);
    assert.equal(a.mods[0].installed, false);
    const dialsAfterFirst = f.dialed.length;
    await c.catalog(false);
    assert.equal(f.dialed.length, dialsAfterFirst, 'the second read inside the TTL does not re-dial');
    clock += mods.CATALOG_TTL_MS + 1;
    await c.catalog(false);
    assert.equal(f.dialed.length, dialsAfterFirst + 1, 'past the TTL it re-dials');
    await c.install('demo');
    const b = await c.catalog(true);
    assert.equal(b.mods[0].installed, true, 'the catalogue marks what is already installed');
    assert.equal(b.mods[0].enabled, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay: workshopDirOf resolves the SIBLING of webroot (never inside it)', () => {
  const p = mods.workshopDirOf(path.join('files', 'webroot', 'server'));
  assert.equal(p, path.join('files', 'workshop'));
  assert.equal(mods.workshopDirOf(''), '');
});

// ---- the panel: static contract -------------------------------------------------------------------
test('panel: registers kind mods, carries the idempotence marker, and talks only to the local overlay', () => {
  assert.ok(PANEL_SRC.includes("registerPanel('mods'"), "must call registerPanel('mods', …)");
  assert.ok(PANEL_SRC.includes('window.__SP_MODS_PANEL = true'), 'the idempotency marker shell-bridge checks');
  for (const p of ['/sp/mods/catalog', '/sp/mods/installed', '/sp/mods/install', '/sp/mods/state', '/sp/mods/uninstall', '/sp/mods/feature']) {
    assert.ok(PANEL_SRC.includes("'" + p + "'"), 'the panel must call the local route ' + p);
  }
  assert.equal(/fetch\(\s*['"]http/i.test(PANEL_SRC), false,
    'the panel must never dial the mod site directly (that API has no CORS headers)');
  assert.ok(PANEL_SRC.includes('overlayKit.js'), 'the panel uses the overlay\'s own kit (same style as 悬浮窗)');
  // the rejection vocabulary is shown verbatim-ish: a new code must not be swallowed
  for (const code of ['FEATURE_OFF', 'HOST_NOT_ALLOWED', 'UNSAFE_ENTRY', 'API_MISMATCH', 'TOO_LARGE']) {
    assert.ok(PANEL_SRC.includes(code + ':'), 'the panel must explain ' + code);
  }
  assert.ok(PANEL_SRC.includes('default == null') || PANEL_SRC.includes('REASONS[c] || c'),
    'an unknown code falls through to the raw code instead of a generic message');
});

test('bridge: the panel module is injected from the /__sp/ channel behind its own marker', () => {
  assert.ok(BRIDGE.includes("'/__sp/ui/modsPanel.js'"), 'injected from the own prefix');
  assert.ok(BRIDGE.includes('window.__SP_MODS_PANEL'), 'guarded by the module marker');
  assert.ok(/mp\.type\s*=\s*'module'/.test(BRIDGE), 'injected as a module (the file is ESM)');
});

// ---- the floating window: two lines + the dedicated mod button -------------------------------------
test('floating window: 资源预载 is two lines and the mod manager has its own dedicated button', () => {
  const code = PRELOAD_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(code.includes('stateRow'), 'line 1 = 状态 + progress bar');
  assert.ok(code.includes("infoRow('本地可用'"), 'line 2 keeps 本地可用');
  assert.equal(code.includes('progressRow'), false, 'the old separate progress row must be gone');
  assert.equal(code.includes("infoRow('状态'"), false, '状态 is folded into line 1');
  assert.equal(code.includes("infoRow('回源缓存'"), false, '回源缓存 is folded into line 2');
  assert.equal(code.includes("infoRow('浏览器缓存'"), false, '浏览器缓存 is folded into line 2');
  assert.equal(code.includes("infoRow('待预载'"), false, '待预载 is folded into line 2');
  assert.ok(code.includes('>打开 mod 管理器</button>'), 'the dedicated mod button exists');
  assert.ok(code.includes("openPanel('mods')"), 'and it opens the mods panel');
  // the four owner buttons are untouched
  for (const label of ['公开大厅', '提交房间', '外观设置', '检查更新']) {
    assert.ok(code.includes('>' + label + '</button>'), 'owner button missing: ' + label);
  }
});

// ---- the panel: rendered (needs the upstream vendor tree) ------------------------------------------
// The kit stub keeps REAL state: the panel loads its catalogue asynchronously on mount, so the test
// has to render, let the fetch settle, reset the hook cursor and render again -- exactly what Preact
// does on a state update. useEffect runs its callback once (mount).
const KIT_STUB = [
  "import htm from '../../vendor/htm.module.js';",
  'export function h(type, props, ...children) {',
  '  const kids = children.flat(Infinity).filter((c) => c != null && c !== false && c !== true);',
  '  const p = Object.assign({}, props || {});',
  '  if (kids.length) p.children = kids.length === 1 ? kids[0] : kids;',
  '  return { type, props: p, children: kids };',
  '}',
  'export const html = htm.bind(h);',
  'export function Modal(p) { return html`<div class="modal"><h2 class="modal__title">${p && p.title}</h2>${p && p.children}${p && p.actions}</div>`; }',
  'export function Button(p) { return html`<button type="button" class="btn" onClick=${p && p.onClick}>${p && p.children}</button>`; }',
  'export function MicroLabel(p) { return html`<span class="micro">${p && p.children}</span>`; }',
  'export function toast(text) { (globalThis.__spTestToasts = globalThis.__spTestToasts || []).push(String(text)); }',
  'const __st = []; let __i = 0;',
  'export function __resetHooks() { __i = 0; }',
  'export function useState(v) {',
  '  const i = __i++;',
  '  if (!(i in __st)) __st[i] = typeof v === "function" ? v() : v;',
  '  return [__st[i], function (n) { __st[i] = typeof n === "function" ? n(__st[i]) : n; }];',
  '}',
  'export function useEffect(fn) { if (typeof fn === "function") fn(); }',
].join('\n');
const HOOKS_STUB = [
  "export function useState(v) { return [typeof v === 'function' ? v() : v, function () {}]; }",
  'export function useEffect() {}',
].join('\n');
const SHELLPANELS_STUB = [
  'export function registerPanel(kind, component) {',
  '  (globalThis.__spTestPanels = globalThis.__spTestPanels || {})[kind] = component;',
  '}',
].join('\n');

function mkTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modspanel-'));
  const w = (rel, text) => {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  w('package.json', JSON.stringify({ type: 'module' }));
  w('public/js/ui/modsPanel.js', PANEL_SRC);
  w('public/js/ui/shellPanels.js', SHELLPANELS_STUB);
  w('public/js/ui/overlayKit.js', KIT_STUB);
  w('public/vendor/hooks.module.js', HOOKS_STUB);
  w('public/vendor/htm.module.js', HTM);
  return root;
}

function textOf(node) {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && node.type) return textOf(node.children);
  return '';
}

function collectButtons(node, out) {
  out = out || [];
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const c of node) collectButtons(c, out); return out; }
  if (node.type === 'button') out.push(node);
  if (node.children) collectButtons(node.children, out);
  return out;
}

function buttonByText(node, label) {
  return collectButtons(node).find((b) => textOf(b) === label) || null;
}

needsUpstream('panel (rendered): shows the manager + catalogue layers and delegates each action to the local route', async () => {
  const root = mkTree();
  const prevWin = globalThis.window;
  const calls = [];
  try {
    delete globalThis.__spTestPanels;
    const mod = await import(pathToFileURL(path.join(root, 'public', 'js', 'ui', 'modsPanel.js')).href);
    await mod.whenDepsReady();
    const comp = globalThis.__spTestPanels && globalThis.__spTestPanels.mods;
    assert.equal(typeof comp, 'function', "the module registered kind 'mods'");

    const catalogue = {
      ok: true,
      site: mods.MODS_SITE_ORIGIN,
      feature: true,
      errors: [],
      mods: [
        { id: 'demo', name: 'Demo pack', size: 1048576, uploadedAt: '2026-10-11T00:00:00Z', note: 'note text', installed: false, enabled: false, flagged: false, downloadAllowed: true },
        { id: 'inst', name: 'Installed pack', size: 2048, uploadedAt: '2026-10-10T00:00:00Z', note: '', installed: true, enabled: true, flagged: false, downloadAllowed: true },
      ],
    };
    const installed = { ok: true, dir: '/files/workshop', mods: [{ id: 'inst' }], feature: true };
    globalThis.window = { __SP_MODS_PANEL: true };
    globalThis.fetch = (url, init) => {
      calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body });
      if (String(url).indexOf('/sp/mods/catalog') >= 0) return Promise.resolve({ json: () => Promise.resolve(catalogue) });
      if (String(url).indexOf('/sp/mods/installed') >= 0) return Promise.resolve({ json: () => Promise.resolve(installed) });
      return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
    };

    const vnode = comp({ onClose: () => {} });
    // let the mount-time refresh settle, then re-render the way a state update would
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const kit = await import(pathToFileURL(path.join(root, 'public', 'js', 'ui', 'overlayKit.js')).href);
    kit.__resetHooks();
    const view = comp({ onClose: () => {} });

    assert.ok(textOf(view).includes('mod 管理器'), 'the manager layer is drawn');
    assert.ok(textOf(view).includes('可下载的 mod'), 'the catalogue layer is drawn');
    assert.ok(textOf(view).includes('Demo pack'), 'a catalogue entry is drawn');
    assert.ok(buttonByText(view, '安装'), 'an un-installed entry offers 安装');
    assert.ok(buttonByText(view, '停用'), 'an enabled entry offers 停用');
    assert.ok(buttonByText(view, '卸载'), 'an installed entry offers 卸载');

    buttonByText(view, '安装').props.onClick();
    await new Promise((r) => setTimeout(r, 0));
    // NOTE: match the PATH exactly -- '/sp/mods/installed' also *starts with* '/sp/mods/install'.
    const pathOf = (u) => new URL(u, 'http://localhost').pathname;
    const inst = calls.filter((c) => pathOf(c.url) === '/sp/mods/install')[0];
    assert.ok(inst, '安装 posts to the local install route');
    assert.equal(JSON.parse(inst.body).id, 'demo');

    buttonByText(view, '停用').props.onClick();
    await new Promise((r) => setTimeout(r, 0));
    const st = calls.filter((c) => pathOf(c.url) === '/sp/mods/state')[0];
    assert.ok(st, '启用/停用 posts to the local state route');
    assert.equal(JSON.parse(st.body).enabled, false, '停用 flips the flag off');

    buttonByText(view, '卸载').props.onClick();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(calls.some((c) => pathOf(c.url) === '/sp/mods/uninstall'), '卸载 posts to the local uninstall route');
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
