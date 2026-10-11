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
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

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

// ---- overlay: 层的判定（2026-10-11 起：代码包**不再拒收**，改成算出来并回报）----------------------
test('overlay: a pack carrying a CODE entry is ACCEPTED, and its layer + entry fields are reported', () => {
  // 业主口径 2026-10-11：「可一键安装（参考 mod 管理器默认加载方式，安装完默认启用）」。站点目录实测
  // 14 个包里只有 5 个是纯 A 层 —— 只收 A 层等于让一键安装对 9/14 直接失败。改成 Forge 的闭集 + 层派生。
  for (const field of mods.CODE_ENTRY_FIELDS) {
    const p = { id: 'a' };
    p[field] = field === 'routes' ? ['/x'] : {};
    const v = mods.validatePack(p, 'a');
    assert.equal(v.ok, true, field + ' must be accepted now');
    assert.ok(v.pack.code.indexOf(field) >= 0, field + ' is reported in pack.code');
  }
  assert.equal(mods.validatePack({ id: 'a', content: ['bonds'] }, 'a').pack.layer, 'A');
  assert.equal(mods.validatePack({ id: 'a', server: {} }, 'a').pack.layer, 'B');
  assert.equal(mods.validatePack({ id: 'a', client: {} }, 'a').pack.layer, 'C');
  assert.equal(mods.validatePack({ id: 'a', layer: 'c', content: ['x'] }, 'a').pack.layer, 'C', 'a declared layer wins');
  assert.equal(mods.layerOf({ id: 'a', kits: [] }), 'A', 'kits-only packs are data-shaped');
  assert.equal(mods.validatePack({ id: 'a', content: ['bonds'], notices: {} }, 'a').ok, true);
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

test('overlay: install lands a code-carrying pack under the PACK id (not the catalogue id) and enables it', async () => {
  // 站点条目 id 是哈希（如 a84e3a916517），包自己的 id 是 name-guard —— 目录必须取后者，否则
  // validatePack 的 ID_MISMATCH 会让站点上**每一个**包都装不上（原实现的真 bug）。
  const dir = tmpWorkshop();
  try {
    const c = mods.createController({
      workshopDir: dir,
      // layer: undefined —— 让层**派生**出来（packZip 的默认值会给一个显式 layer:'A'，那会盖掉派生）
      fetchImpl: fetchStub({ packBytes: packZip({ 'server/nameGuard.mjs': 'export default 1;' },
        { id: 'name-guard', layer: undefined, server: { preDispatch: { module: 'server/nameGuard.mjs' } } }) }),
      log: () => {},
    });
    const r = await c.install('demo'); // catalogue id = demo, pack.json id = name-guard
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.id, 'name-guard', 'the directory is the pack.json id');
    assert.equal(r.layer, 'B');
    assert.deepEqual(r.code, ['server']);
    assert.equal(r.enabled, true, '装上即启用');
    assert.equal(fs.existsSync(path.join(dir, 'name-guard', 'pack.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'name-guard', 'server', 'nameGuard.mjs')), true);
    assert.equal(fs.existsSync(path.join(dir, 'demo')), false, 'no directory named after the catalogue id');
    const src = JSON.parse(fs.readFileSync(path.join(dir, 'name-guard', 'source.json'), 'utf8'));
    assert.equal(src.siteId, 'demo', 'source.json records the catalogue id (that is what the panel matches on)');
    assert.equal(src.sha256.length, 64);
    assert.equal(c.installed()[0].enabled, true);
    assert.equal(c.installed()[0].siteId, 'demo');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay: the module carries a version (filename stability + version self-check)', () => {
  assert.equal(typeof mods.version, 'number', 'a hot-updated overlay must be able to name its version');
  assert.ok(mods.version >= 1);
});

// ---- overlay: the feature gate + the whole install path -------------------------------------------
test('overlay: the manager is ON by default — only an explicit {enabled:false} refuses', async () => {
  // 2026-10-11 业主口径改为「缺省开启」（与 Forge「目录在即生效」一致）；总开关只用来一键停用全部。
  const dir = tmpWorkshop();
  try {
    const c = mods.createController({ workshopDir: dir, fetchImpl: fetchStub(), log: () => {} });
    assert.equal(c.feature(), true, 'default ON');
    assert.equal((await c.install('demo')).ok, true, 'install works without touching the switch');
    assert.equal(c.setFeature(false).ok, true);
    assert.equal(c.feature(), false, 'the explicit OFF persists to disk');
    assert.equal((await c.install('demo')).error, 'FEATURE_OFF');
    assert.equal(c.setEnabled('demo', true).error, 'FEATURE_OFF');
    assert.equal(c.uninstall('demo').error, 'FEATURE_OFF');
    assert.equal(c.setFeature(true).ok, true);
    assert.equal(c.feature(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay: install downloads, validates, lands the pack and leaves it ENABLED', async () => {
  const dir = tmpWorkshop();
  try {
    const f = fetchStub();
    const c = mods.createController({ workshopDir: dir, fetchImpl: f, log: () => {} });
    const r = await c.install('demo');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fs.existsSync(path.join(dir, 'demo', 'pack.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'demo', 'content', 'bonds.json')), true);
    const inst = c.installed();
    assert.equal(inst.length, 1);
    assert.equal(inst[0].id, 'demo');
    assert.equal(inst[0].enabled, true, 'a freshly installed pack IS enabled (owner rule 2026-10-11)');
    assert.equal(c.setEnabled('demo', false).ok, true);
    assert.equal(c.installed()[0].enabled, false, 'the toggle can still disable it');
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
    assert.equal(b.mods[0].enabled, true, 'installed means enabled by default');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- overlay: 装载器（2026-10-11 新增：A 层数据合并 + 包内素材接管 + 客户端清单）--------------------
test('loader: mergeRecords is additive by default, patches only declared ids, field by field', () => {
  const base = { boss_1: { hp: 100, name: 'A' }, boss_2: { hp: 200 } };
  const add = { boss_1: { hp: 25 }, boss_2: { hp: 50 }, boss_9: { hp: 7 } };
  const m = mods.mergeRecords(base, add, ['bosses:boss_1'], 'bosses');
  assert.equal(m.records.boss_1.hp, 25, 'a declared id is patched');
  assert.equal(m.records.boss_1.name, 'A', 'patching is field-level: undeclared fields stay official');
  assert.equal(m.records.boss_2.hp, 200, 'an undeclared official id is left alone');
  assert.equal(m.records.boss_9.hp, 7, 'a new id is added');
  assert.deepEqual([m.added, m.patched, m.skipped], [1, 1, 1]);
  // a declared id for ANOTHER kind does not open this file
  assert.equal(mods.mergeRecords(base, add, ['items:boss_1'], 'bosses').records.boss_1.hp, 100);
  // the base object is never mutated
  assert.equal(base.boss_1.hp, 100);
});

test('loader: rewritePackPaths only rewrites strings that really are files inside the pack', () => {
  const inPack = (rel) => rel === 'char/avatar/a.png' || rel === 'spine/x.skel';
  const urlOf = (rel) => '/sp/mods/asset/p1/' + rel;
  const rec = {
    art: { avatar: 'char/avatar/a.png', missing: 'char/avatar/nope.png', abs: '/assets/x.png', web: 'https://x/y.png' },
    list: ['spine/x.skel', 'plain-text'],
    n: 5, b: true,
  };
  const out = mods.rewritePackPaths(rec, inPack, urlOf, 0);
  assert.equal(out.art.avatar, '/sp/mods/asset/p1/char/avatar/a.png', 'a real pack file is rewritten');
  assert.equal(out.art.missing, 'char/avatar/nope.png', 'a path that is not in the pack is left alone');
  assert.equal(out.art.abs, '/assets/x.png', 'an absolute path is not a pack-relative path');
  assert.equal(out.art.web, 'https://x/y.png', 'a URL is left alone');
  assert.equal(out.list[0], '/sp/mods/asset/p1/spine/x.skel');
  assert.equal(out.list[1], 'plain-text');
  assert.equal(out.n, 5);
  assert.equal(mods.packAssetUrl('a b', 'x/y.png'), '/sp/mods/asset/a%20b/x/y.png');
});

test('loader: /data/<kind>.json is merged from enabled packs, with pack assets rewritten', () => {
  const root = tmpWorkshop();
  const dir = path.join(root, 'workshop');
  fs.mkdirSync(path.join(root, 'webroot', 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'boss-pack', 'char'), { recursive: true });
  fs.writeFileSync(path.join(root, 'webroot', 'data', 'bosses.json'),
    JSON.stringify({ boss_1: { hp: 100, name: 'official' } }));
  fs.writeFileSync(path.join(dir, 'boss-pack', 'pack.json'), JSON.stringify({
    id: 'boss-pack', api: '>=1 <2', content: ['bosses'], overrides: ['bosses:boss_1'],
  }));
  fs.writeFileSync(path.join(dir, 'boss-pack', 'bosses.json'), JSON.stringify({ boss_1: { hp: 25 } }));
  fs.writeFileSync(path.join(dir, 'boss-pack', 'char', 'a.png'), 'x');
  try {
    const c = mods.createController({ workshopDir: dir, fetchImpl: fetchStub(), log: () => {} });
    const d = c.dataFile('bosses');
    assert.ok(d, 'an enabled pack declaring the kind makes the file loadable');
    assert.equal(d.records.boss_1.hp, 25);
    assert.equal(d.records.boss_1.name, 'official');
    assert.deepEqual(d.report, [{ id: 'boss-pack', added: 0, patched: 1, skipped: 0 }]);
    assert.equal(c.dataFile('items'), null, 'a kind no enabled pack declares falls through to upstream');
    // disabling the pack takes it back out
    c.setEnabled('boss-pack', false);
    assert.equal(c.dataFile('bosses'), null, 'a disabled pack no longer merges');
    // the whole feature switch too
    c.setEnabled('boss-pack', true);
    c.setFeature(false);
    assert.equal(c.dataFile('bosses'), null, 'the master switch turns loading off');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loader: pack assets resolve inside the pack only, and the client manifest reports what is live', () => {
  const root = tmpWorkshop();
  const dir = path.join(root, 'workshop');
  fs.mkdirSync(path.join(dir, 'theme-night'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'theme-night', 'pack.json'), JSON.stringify({
    id: 'theme-night', api: '>=1 <2', client: { theme: { vars: { '--text-hi': '#fff' } } },
  }));
  fs.writeFileSync(path.join(dir, 'theme-night', 'x.css'), 'body{}');
  try {
    const c = mods.createController({ workshopDir: dir, fetchImpl: fetchStub(), log: () => {} });
    assert.ok(c.assetFile('theme-night', 'x.css'), 'a file inside the pack resolves');
    assert.equal(c.assetFile('theme-night', '../pack.json'), null, 'traversal is refused');
    assert.equal(c.assetFile('theme-night', '../../etc/passwd'), null);
    assert.equal(c.assetFile('..', 'x'), null, 'a pack id that is not an id is refused');
    assert.equal(c.assetFile('theme-night', 'nope.css'), null);
    const man = c.loaderManifest();
    assert.equal(man.feature, true);
    assert.equal(man.packs.length, 1);
    assert.equal(man.packs[0].id, 'theme-night');
    assert.equal(man.packs[0].layer, 'C');
    assert.deepEqual(man.packs[0].theme.vars, { '--text-hi': '#fff' });
    assert.deepEqual(man.packs[0].panels, [], 'no panels declared -> empty list');
    assert.equal(man.panelCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- 装载器客户端侧（ui/modsLoader.js）：本机页面注入主题；非本机页面一个请求都不发 -----------------
const LOADER_SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'modsLoader.js'), 'utf8');

/** 跑一遍 modsLoader 的 IIFE：一个够用的 DOM + fetch 桩（记录请求、按脚本给的 doc 应答）。 */
function runModsLoader(opts) {
  const o = opts || {};
  const nodes = [];
  const head = {
    appendChild(n) { nodes.push(n); n.parentNode = this; return n; },
    removeChild(n) { const i = nodes.indexOf(n); if (i >= 0) nodes.splice(i, 1); n.parentNode = null; return n; },
  };
  const doc = {
    head: head,
    documentElement: head,
    createElement(tag) { return { tagName: String(tag).toUpperCase(), _attrs: {}, textContent: '', parentNode: null, setAttribute(k, v) { this._attrs[k] = String(v); }, getAttribute(k) { return this._attrs[k] || null; } }; },
    getElementById(id) { return nodes.filter((n) => n.getAttribute && n.getAttribute('id') === id)[0] || null; },
  };
  const calls = [];
  const events = [];
  const win = {
    document: doc,
    location: { hostname: o.host || '127.0.0.1' },
    fetch: (url) => {
      calls.push(String(url));
      if (o.fail) return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(o.doc === undefined ? { feature: true, packs: [] } : o.doc) });
    },
    dispatchEvent: (ev) => { events.push(ev); return true; },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  };
  const vm = require('node:vm');
  vm.runInNewContext(LOADER_SRC, { window: win, globalThis: win, document: doc, Promise, Date, Object, Array, String, Number, RegExp, JSON });
  return { win, doc, nodes, calls, events, style: () => nodes.filter((n) => n.getAttribute && n.getAttribute('id') === 'sp-mods-theme')[0] || null };
}

test('loader (client): injects the enabled packs\' theme vars as one :root sheet, and reports what is live', async () => {
  const w = runModsLoader({
    doc: {
      feature: true,
      packs: [
        { id: 'theme-night', layer: 'C', code: ['client'], content: [], theme: { vars: { '--text-hi': '#f4faf7', '--line': '#2d3d37', 'evil': 'red'} }, panels: [] },
        { id: 'boss-fixed-pool', layer: 'A', code: [], content: ['bosses'], theme: null, panels: [] },
      ],
      dataKinds: ['bosses'],
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.calls, ['/sp/mods/loader']);
  const st = w.style();
  assert.ok(st, 'a theme style element is created');
  assert.ok(st.textContent.indexOf('--text-hi:#f4faf7') >= 0, 'the declared var lands: ' + st.textContent);
  assert.ok(st.textContent.indexOf('--line:#2d3d37') >= 0);
  assert.ok(st.textContent.indexOf('evil') < 0, 'a key that is not a custom property is dropped');
  assert.ok(/^:root\{/.test(st.textContent), 'scoped to :root');
  assert.equal(w.win.__SP_MODS_LOADER.packs.length, 2);
  assert.equal(w.win.__SP_MODS_LOADER.themeApplied, true);
  assert.equal(w.events.length, 1, 'one sp-mods-loaded event');
  assert.equal(w.events[0].type, 'sp-mods-loaded');
});

test('loader (client): no theme → no style node; a third-party page dials nothing; offline is silent', async () => {
  const noTheme = runModsLoader({ doc: { feature: true, packs: [{ id: 'a', layer: 'A', theme: null }], dataKinds: [] } });
  await new Promise((r) => setImmediate(r));
  assert.equal(noTheme.style(), null, 'no theme vars → no injected sheet');
  assert.equal(noTheme.win.__SP_MODS_LOADER.themeApplied, false);

  const remote = runModsLoader({ host: '103.205.253.194', doc: { packs: [] } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(remote.calls, [], 'a third-party server page must not dial the local loader');

  const off = runModsLoader({ fail: true });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(off.calls, ['/sp/mods/loader']);
  assert.equal(off.win.__SP_MODS_LOADER, undefined, 'a failed load leaves no report behind');
});

// ---- 面板宿主（ui/modPanels.js）：把 client.panels[] 变成真界面（Forge 的 C 层契约）------------------
const PANELS_SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'modPanels.js'), 'utf8');
let panelsSeq = 0;

/** 一个够用的 DOM + window，用来跑面板宿主（真 ESM 加载，所以里面的 `import()` 能用）。 */
function runModPanels(opts) {
  const o = opts || {};
  const created = [];
  const anchors = o.anchors || {};
  const mk = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(), _attrs: {}, children: [], parentNode: null, textContent: '',
      setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
      get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === html; },
    };
    created.push(el);
    return el;
  };
  const html = mk('html');
  const head = mk('head');
  const body = mk('body');
  html.appendChild(head); html.appendChild(body);
  for (const sel of Object.keys(anchors)) {
    const node = mk('div');
    node._attrs['class'] = sel.replace(/^\./, '');
    anchors[sel] = node;
    body.appendChild(node);
  }
  const doc = {
    head, body, documentElement: html,
    createElement: mk,
    getElementById: (id) => created.filter((e) => e.id === id)[0] || null,
    querySelector: (sel) => {
      const m = /^\[data-sp-mod-slot="([^"]+)"\]$/.exec(sel);
      if (m) return created.filter((e) => e.getAttribute('data-sp-mod-slot') === m[1] && e.isConnected)[0] || null;
      return anchors[sel] || null;
    },
  };
  const warns = [];
  const win = {
    document: doc,
    location: { hostname: o.host || '127.0.0.1' },
    console: { log() {}, warn(m) { warns.push(String(m)); }, error(m) { warns.push(String(m)); } },
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} },
    fetch: () => {
      if (o.fail) return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(o.manifest === undefined ? { feature: true, packs: [] } : o.manifest) });
    },
  };
  return { win, doc, created, warns, mk, html, body };
}

/** 写一个真 ESM 模块文件，`mount(ctx)` 把 ctx 记到 globalThis 上（面板宿主动态 import 它）。 */
function writePanelModule(root, name, body) {
  const f = path.join(root, name);
  fs.writeFileSync(f, body);
  return pathToFileURL(f).href;
}

test('panel host: mounts a declared panel with a frozen ctx (host/net/me/log) and injects its styles', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spmodpanels-'));
  const prevWin = globalThis.window;
  try {
    const modUrl = writePanelModule(root, 'panel-ok.mjs',
      'export function mount(ctx) { globalThis.__spPanelCtx = ctx; ctx.host.textContent = "panel mounted"; }\n'
      + 'export const touched = true;\n');
    const env = runModPanels({
      anchors: { '.gm__corner': null },
      manifest: {
        feature: true,
        packs: [{
          id: 'net-panel', layer: 'C', code: ['client'], content: [], theme: null,
          panels: [{ id: 'status', slot: 'screen.game.aside', order: 60, gate: null, module: modUrl, styles: ['/sp/mods/asset/net-panel/client/status.css'] }],
        }],
        panelCount: 1,
      },
    });
    globalThis.window = env.win;
    await import(pathToFileURL(path.join(here, 'extras', 'public', 'js', 'ui', 'modPanels.js')).href + '?t=' + (++panelsSeq));
    await new Promise((r) => setTimeout(r, 30));
    const ctx = globalThis.__spPanelCtx;
    assert.ok(ctx, 'mount(ctx) was called: ' + JSON.stringify(env.warns));
    assert.equal(ctx.id, 'status');
    assert.equal(ctx.pack, 'net-panel');
    assert.equal(ctx.slot, 'screen.game.aside');
    assert.equal(ctx.order, 60);
    assert.equal(Object.isFrozen(ctx), true, 'ctx is frozen');
    assert.ok(ctx.host && ctx.host.getAttribute('data-sp-mod-slot') === 'status', 'the host carries the slot marker');
    assert.equal(ctx.host.parentNode, env.doc.body.children.filter((c) => c.getAttribute && c.getAttribute('class') === 'gm__corner')[0],
      'the host is mounted into the slot anchor (.gm__corner)');
    assert.equal(ctx.host.textContent, 'panel mounted', 'the panel really drew into the host');
    assert.equal(typeof ctx.net.status, 'function');
    assert.equal(typeof ctx.net.welcome, 'function');
    assert.equal(typeof ctx.session.setPreload, 'function');
    assert.equal(typeof ctx.log.warn, 'function');
    assert.equal(typeof ctx.me.room, 'object');
    assert.ok(env.created.some((e) => e.getAttribute && e.getAttribute('rel') === 'stylesheet'), 'the panel stylesheet is injected');
    assert.equal(env.win.__SP_MOD_PANELS.mounted, 1);
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    delete globalThis.__spPanelCtx;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('panel host: an unknown slot is NAMED and mounts nothing; a third-party page dials nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spmodpanels-'));
  const prevWin = globalThis.window;
  try {
    const modUrl = writePanelModule(root, 'panel-x.mjs', 'export function mount() { globalThis.__spPanelMounted = true; }\n');
    const env = runModPanels({
      manifest: { feature: true, packs: [{ id: 'x', panels: [{ id: 'p1', slot: 'screen.not.a.slot', order: 1, module: modUrl, styles: [] }] }] },
    });
    globalThis.window = env.win;
    await import(pathToFileURL(path.join(here, 'extras', 'public', 'js', 'ui', 'modPanels.js')).href + '?t=' + (++panelsSeq));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(globalThis.__spPanelMounted, undefined, 'nothing mounts for an unknown slot');
    assert.ok(env.warns.some((w) => w.indexOf('unknown slot') >= 0), 'the refusal is named: ' + JSON.stringify(env.warns));
    assert.equal(env.created.filter((e) => e.getAttribute && e.getAttribute('data-sp-mod-slot')).length, 0, 'no host element was created');
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    delete globalThis.__spPanelMounted;
    fs.rmSync(root, { recursive: true, force: true });
  }

  const remote = runModPanels({ host: '103.205.253.194', manifest: { feature: true, packs: [] } });
  const prev2 = globalThis.window;
  try {
    globalThis.window = remote.win;
    await import(pathToFileURL(path.join(here, 'extras', 'public', 'js', 'ui', 'modPanels.js')).href + '?t=' + (++panelsSeq));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(remote.created.filter((e) => e.getAttribute && e.getAttribute('data-sp-mod-slot')).length, 0,
      'a third-party server page creates no mod host at all');
  } finally {
    if (prev2 === undefined) delete globalThis.window; else globalThis.window = prev2;
  }
});

// ---- 服务端接缝：preDispatch（叠加层端点；上游文件一个字节不动，只在活对象的实例方法上做影子包裹）------
test('server seam: readPreDispatchDecl reads the declaration, and refuses a malformed one', () => {
  assert.equal(mods.readPreDispatchDecl({}), null);
  assert.equal(mods.readPreDispatchDecl({ server: {} }), null);
  assert.equal(mods.readPreDispatchDecl({ server: { preDispatch: { policy: 'x.json' } } }), null, 'no module -> no hook');
  const d = mods.readPreDispatchDecl({ server: { preDispatch: { module: 'server/guard.mjs', policy: 'p.json', intercepts: ['hello', 'room.create'] } } });
  assert.deepEqual(d, { module: 'server/guard.mjs', policy: 'p.json', intercepts: ['hello', 'room.create'] });
  assert.deepEqual(mods.readPreDispatchDecl({ server: { preDispatch: { module: 'm.mjs' } } }).intercepts, []);
  assert.ok(mods.SERVER_HOOK_MEMBERS.indexOf('preDispatch') >= 0);
});

test('server seam: loadPreDispatchHooks names every pack it cannot install, and loads the real contract', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spmodhooks-'));
  const w = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const notes = [];
  try {
    // ① 真契约的包：createPreDispatch(deps) -> { preDispatch(conn,msg) -> boolean } + validatePolicy
    w('good/pack.json', JSON.stringify({ id: 'good', server: { preDispatch: { module: 'server/guard.mjs', policy: 'p.json', intercepts: ['hello'] } } }));
    w('good/p.json', JSON.stringify({ words: { english: ['bad'] } }));
    w('good/server/guard.mjs', [
      'export function validatePolicy(policy) { return policy && policy.words ? undefined : "no words table"; }',
      'export function createPreDispatch(deps) {',
      '  return { preDispatch(conn, msg) {',
      '    if (!msg || msg.t !== "hello") return false;',
      '    if (String(msg.name).includes(deps.policy.words.english[0])) { deps.send(conn, { t: "error", code: "BAD_MSG" }); return true; }',
      '    return false;',
      '  } };',
      '}',
    ].join('\n'));
    // ② 声明了但模块不存在 → 点名 IMPORT_FAILED
    w('missing/pack.json', JSON.stringify({ id: 'missing', server: { preDispatch: { module: 'server/nope.mjs', intercepts: ['hello'] } } }));
    // ③ 模块存在但没有工厂 → 点名 NO_FACTORY
    w('nofactory/pack.json', JSON.stringify({ id: 'nofactory', server: { preDispatch: { module: 'server/x.mjs', intercepts: ['hello'] } } }));
    w('nofactory/server/x.mjs', 'export const nothing = 1;\n');
    // ④ validatePolicy 拒绝 → 点名 POLICY_REJECTED（加载期点名拒绝）
    w('rejected/pack.json', JSON.stringify({ id: 'rejected', server: { preDispatch: { module: 'server/y.mjs', policy: 'p.json', intercepts: ['hello'] } } }));
    w('rejected/p.json', JSON.stringify({}));
    w('rejected/server/y.mjs', 'export function validatePolicy() { return "policy rejected on purpose"; }\nexport function createPreDispatch() { return { preDispatch() { return false; } }; }\n');

    const readDoc = (id) => JSON.parse(fs.readFileSync(path.join(root, id, 'pack.json'), 'utf8'));
    const packs = ['good', 'missing', 'nofactory', 'rejected'].map((id) => ({ id: id, dir: path.join(root, id), doc: readDoc(id) }));
    const r = await mods.loadPreDispatchHooks(packs, (m) => notes.push(m));
    assert.equal(r.hooks.length, 1, 'only the real-contract pack installs: ' + JSON.stringify(r.notes));
    assert.equal(r.hooks[0].pack, 'good');
    assert.deepEqual(r.hooks[0].decl.intercepts, ['hello']);
    const reasons = {};
    for (const n of r.notes) reasons[n.pack] = n.reason;
    assert.equal(reasons.missing, 'IMPORT_FAILED');
    assert.equal(reasons.nofactory, 'NO_FACTORY');
    assert.equal(reasons.rejected, 'POLICY_REJECTED');
    assert.ok(notes.some((m) => m.indexOf('rejected') >= 0), 'the refusal is named in the log too');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server seam: attachServerHooks wraps the live instance methods, consumes on true, fails open on throw, detaches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spmodhooks-'));
  try {
    const f = path.join(root, 'h.mjs');
    fs.writeFileSync(f, [
      'export function createPreDispatch(deps) {',
      '  return { preDispatch(conn, msg) {',
      '    if (msg.t === "hello" && msg.name === "banned") { deps.send(conn, { t: "error", code: "BAD_MSG" }); return true; }',
      '    if (msg.t === "hello" && msg.name === "boom") throw new Error("hook exploded");',
      '    return false;',
      '  } };',
      '}',
    ].join('\n'));
    const mod = await import(pathToFileURL(f).href);
    const hooks = [{ pack: 'guard', decl: { intercepts: ['hello'] }, create: mod.createPreDispatch, policy: {} }];

    const calls = [];
    const sent = [];
    const srv = {
      network: {
        reply: (conn, msg) => { sent.push(msg); return true; },
        onHelloMsg(conn, msg) { calls.push('hello:' + msg.name); },
        handler: { onMessage(session, msg) { calls.push('c2s:' + msg.t); } },
      },
    };
    const before = srv.network.onHelloMsg;
    const att = mods.attachServerHooks(srv, hooks, () => {});
    assert.deepEqual(att.installed, [{ pack: 'guard', intercepts: ['hello'], installed: true }]);
    assert.notEqual(srv.network.onHelloMsg, before, 'the instance method is shadowed');

    const conn = { ws: {} };
    srv.network.onHelloMsg(conn, { t: 'hello', name: 'banned' });
    assert.equal(calls.length, 0, 'a consumed hello never reaches the engine');
    assert.equal(sent.length, 1, 'the hook could reply through deps.send');
    assert.equal(sent[0].code, 'BAD_MSG');

    srv.network.onHelloMsg(conn, { t: 'hello', name: 'fine' });
    assert.deepEqual(calls, ['hello:fine'], 'a clean hello passes through to the engine');

    srv.network.onHelloMsg(conn, { t: 'hello', name: 'boom' });
    assert.deepEqual(calls, ['hello:fine', 'hello:boom'], 'a throwing hook is NO veto (fail-open)');

    att.detach();
    assert.equal(srv.network.onHelloMsg, before, 'detach restores the original method');
    srv.network.onHelloMsg(conn, { t: 'hello', name: 'banned' });
    assert.equal(calls[calls.length - 1], 'hello:banned', 'after detach nothing is consumed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server seam: a server without the network seam is reported, never half-attached', () => {
  const att = mods.attachServerHooks({}, [{ pack: 'x', decl: { intercepts: ['hello'] }, create: () => ({ preDispatch: () => true }), policy: {} }], () => {});
  assert.deepEqual(att.installed, []);
  assert.deepEqual(att.notes, [{ reason: 'NO_NETWORK_SEAM' }]);
  assert.equal(typeof att.detach, 'function');
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
  const prevLoc = globalThis.location;
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
    globalThis.location = { hostname: '127.0.0.1' }; // 本机页面：面板的判据（见 isOwnHostPage）
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
    // 业主口径 2026-10-11：装完要**在界面里**明说「热重载页面或重新打开 APK 生效」，并给一个就地重载按钮
    await new Promise((r) => setTimeout(r, 0));
    kit.__resetHooks();
    const view2 = comp({ onClose: () => {} }); // re-render the way a state update would (same as above)
    const afterInstall = textOf(view2);
    assert.ok(afterInstall.indexOf('需要重载') >= 0, 'the reload row appears after an install: ' + afterInstall.slice(0, 200));
    assert.ok(afterInstall.indexOf('热重载页面或重新打开 APK 生效') >= 0, 'and it says what to do');
    assert.ok(buttonByText(view2, '立即重载'), 'and offers a one-tap reload');

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
    if (prevLoc === undefined) delete globalThis.location; else globalThis.location = prevLoc;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 业主 2026-10-11：「http://103.205.253.194:27527/ 这个服务器页面会挤掉我的悬浮窗入口 …… 不和服务器
// 内容冲突」。视觉那一半是宿主挂载点（见 shell-panels.test.mjs 的两个 P0 用例）；这一半是**请求**：
// 第三方服务器页面上「同源」就是那台服务器，面板的 /sp/mods/* 会打过去（那台页面还把 window.fetch
// 包了一层，会把路径改写成 /_build/<gen>/sp/mods/*，实测 404）——管理器不该拿请求去撞人家的服务器，
// 所以那种页面上一个请求都不发，只画一条说明。
needsUpstream('third-party server page: the panel dials nothing and says it is local-only', async () => {
  const root = mkTree();
  const prevWin = globalThis.window;
  const prevLoc = globalThis.location;
  const calls = [];
  try {
    delete globalThis.__spTestPanels;
    const mod = await import(pathToFileURL(path.join(root, 'public', 'js', 'ui', 'modsPanel.js')).href);
    await mod.whenDepsReady();
    const comp = globalThis.__spTestPanels && globalThis.__spTestPanels.mods;
    assert.equal(typeof comp, 'function', "the module registered kind 'mods'");

    globalThis.window = { __SP_MODS_PANEL: true };
    globalThis.location = { hostname: '103.205.253.194' }; // 业主报的那台服务器页面
    globalThis.fetch = (url) => {
      calls.push(String(url));
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, mods: [], errors: [], feature: false }) });
    };

    comp({ onClose: () => {} });
    await new Promise((r) => setTimeout(r, 0));
    const kit = await import(pathToFileURL(path.join(root, 'public', 'js', 'ui', 'overlayKit.js')).href);
    kit.__resetHooks();
    const view = comp({ onClose: () => {} });
    const text = textOf(view);

    assert.ok(text.includes('mod 管理器'), '面板本身仍然要画出来（入口不能消失）');
    assert.ok(text.includes('只在本机服务器'), '必须明说只在本机可用：' + text);
    assert.equal(calls.length, 0, '一个请求都不许发到那台服务器：' + JSON.stringify(calls));
    assert.equal(buttonByText(view, '安装'), null, '非本机页面不给安装按钮');
    assert.equal(buttonByText(view, '开启'), null, '非本机页面不给总开关');
    // 局域网访客（打开的是房主的私网地址）同样不是本机 —— 判据与 lobby.js isOwnHostPage() 一致
    globalThis.location = { hostname: '192.168.0.240' };
    kit.__resetHooks();
    comp({ onClose: () => {} });
    assert.equal(calls.length, 0, '私网访客页面也不许发请求：' + JSON.stringify(calls));
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    if (prevLoc === undefined) delete globalThis.location; else globalThis.location = prevLoc;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
