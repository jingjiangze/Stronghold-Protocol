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

/** A fetch stub that serves the catalogue and pack zips, and counts every dial.
 *  The bytes it serves live on the returned function (f.catalogBytes / f.packBytes) and are
 *  re-assignable, so one case can make the site "publish a newer build" half-way through. */
function fetchStub(opts) {
  const o = opts || {};
  const dialed = [];
  const impl = async (url) => {
    const u = String(url);
    dialed.push(u);
    if (u.indexOf('/api/mods') >= 0) {
      return { ok: true, status: 200, arrayBuffer: async () => (impl.catalogBytes || Buffer.from(JSON.stringify({
        mods: [{ id: 'demo', name: 'Demo pack', size: 1234, uploadedAt: '2026-10-11T00:00:00Z', note: 'hi', download: '/mods/demo.zip' }],
        flagged: [],
      }))) };
    }
    if (u.indexOf('/mods/') >= 0 && u.slice(-4) === '.zip') {
      return { ok: true, status: 200, arrayBuffer: async () => (impl.packBytes || packZip({ 'content/bonds.json': '{"a":1}' })) };
    }
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  impl.dialed = dialed;
  impl.catalogBytes = o.catalogBytes;
  impl.packBytes = o.packBytes;
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
  // 2026-10-15：content 的名字现在是**闭集点名拒**（对齐 Forge 0.18.6 的 CONTENT_UNKNOWN_FILE），
  // 所以这里用一个真实表名（'x' 会被拦下，见下面那条新用例）。
  assert.equal(mods.validatePack({ id: 'a', layer: 'c', content: ['bonds'] }, 'a').pack.layer, 'C', 'a declared layer wins');
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

// ---- 对齐上游 Forge 0.18.6（业主 2026-10-15：「更新最新的模组管理器」）----------------------------
// 取证树 `_tmp/mgr0186`（= XiaMo233M/Stronghold-Protocol-Forge main，APP_VERSION 0.18.6）：
//   · shared/workshop.js:134-169  PACK_FIELDS            → 36 键
//   · shared/workshop.js:51-53    WORKSHOP_CONTENT_FILES → 15 张（第 15 张 = §28.51 的 variants）
//   · shared/constants.js:30      MOD_API_VERSION        → 1（未抬世代）
//   · shared/workshop.js:172      PACK_TARGETS           → ['forge', 'stardust']
test('overlay: pack.json 闭集对齐 Forge 0.18.6（36 键 / 15 张内容表 / 4 个新拒绝码）', () => {
  const FORGE_36 = ['id', 'name', 'version', 'author', 'license', 'description', 'gameVersion', 'game',
    'api', 'layer', 'combat', 'content', 'overrides', 'voices', 'voiceLangs', 'bondIcons', 'itemIcons',
    'art', 'skins', 'support', 'operators', 'i18n', 'forms', 'fx', 'notices', 'playtest', 'enabled',
    'variants', 'behaviour', 'assets', 'client', 'server', 'routes', 'target', 'dependencies', 'conflicts'];
  assert.equal(FORGE_36.length, 36, '（自检）逐字抄下来的就是 36 键');
  for (const f of FORGE_36) assert.ok(mods.KNOWN_FIELDS.includes(f), '缺 Forge 0.18.6 的键: ' + f);
  // 闭集的纪律：**允许比引擎宽**（kits / media 是老包遗留），**绝不允许比引擎窄**（窄会把新包挡在门外）。
  assert.equal(mods.KNOWN_FIELDS.filter((f) => FORGE_36.indexOf(f) < 0).sort().join(','), 'kits,media',
    '多出来的只能是这两个旧键；多任何别的都说明闭集漂了');
  assert.equal(mods.WORKSHOP_CONTENT_FILES.length, 15, '内容表 15 张');
  assert.equal(mods.WORKSHOP_CONTENT_FILES[14], 'variants', '第 15 张是 §28.51 的口径数据通道');
  assert.deepEqual(Array.from(mods.PACK_TARGETS), ['forge', 'stardust'], 'target 闭枚举');
  assert.equal(mods.MOD_API_VERSION, 1, '世代仍是 1（Forge 0.18.6 未抬）');

  // 四条**下载前**的点名拒（引擎在装载期也会拒，这里提前到下载之前）
  assert.equal(mods.validatePack({ id: 'a', content: 'chess' }, 'a').reason, 'CONTENT_NOT_ARRAY');
  assert.equal(mods.validatePack({ id: 'a', content: ['not_a_table'] }, 'a').reason, 'CONTENT_UNKNOWN_FILE');
  assert.equal(mods.validatePack({ id: 'a', target: 'nope' }, 'a').reason, 'BAD_TARGET');
  assert.equal(mods.validatePack({ id: 'a', dependencies: 'x' }, 'a').reason, 'BAD_MOD_REFS');
  assert.equal(mods.validatePack({ id: 'a', dependencies: [{ id: 'b', nope: 1 }] }, 'a').reason, 'BAD_MOD_REFS');
  assert.equal(mods.validatePack({ id: 'a', conflicts: [{ range: '1' }] }, 'a').reason, 'BAD_MOD_REFS');

  // 一个用上新声明的现代包必须整包通过，且新声明如实回报
  const v = mods.validatePack({
    id: 'a', api: '>=1 <2', content: ['chess', 'variants'], target: 'stardust',
    enabled: false, dependencies: [{ id: 'b', range: '^1.0.0' }], conflicts: [{ id: 'c' }],
    variants: [{ axis: 'deploy' }], behaviour: [{ switch: 'unequip' }],
  }, 'a');
  assert.equal(v.ok, true, '现代包必须装得上: ' + JSON.stringify(v));
  assert.equal(v.pack.target, 'stardust');
  assert.equal(v.pack.declaredEnabled, false, 'enabled:false 是**引擎侧**声明，如实回报（不去动我们自己的开关）');
  assert.equal(v.pack.dependencies, 1);
  assert.equal(v.pack.conflicts, 1);
  assert.equal(v.pack.variants, 1);
  assert.equal(v.pack.behaviour, 1);

  // api 区间：补上 Forge 的 ^ / ~ / * / || 四种写法（此前不可解析 → 一律放行，等于没判）
  assert.equal(mods.apiAllows('^1.0.0', 1), true);
  assert.equal(mods.apiAllows('^2.0.0', 1), false, '^2 排除了世代 1');
  assert.equal(mods.apiAllows('~1.0', 1), true);
  assert.equal(mods.apiAllows('*', 1), true);
  assert.equal(mods.apiAllows('1 || 2', 1), true);
  assert.equal(mods.apiAllows('>=1 <2', 1), true);
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

// ---- overlay: 「站点有新版」与同 id 多条（业主 2026-10-12：热更新最新 mod + 删旧版文件）------------
/** A catalogue with a controllable uploadedAt, so "is the site newer" can be driven from the test. */
function catalogBytesAt(uploadedAt, extra) {
  return Buffer.from(JSON.stringify({
    mods: [Object.assign({
      id: 'demo', name: 'Demo pack', size: 1234, uploadedAt: uploadedAt,
      note: 'hi', download: '/mods/demo.zip', packId: 'demo',
    }, extra || {})],
    flagged: [],
  }));
}

test('overlay: an entry whose uploadedAt is NEWER than the installed record is flagged updateAvailable', async () => {
  const dir = tmpWorkshop();
  try {
    const f = fetchStub({ catalogBytes: catalogBytesAt('2026-10-11T00:00:00Z') });
    const c = mods.createController({ workshopDir: dir, fetchImpl: f, log: () => {} });
    c.setFeature(true);
    await c.install('demo');                       // installedAt = the real wall clock
    const older = await c.catalog(true);
    assert.equal(older.mods[0].installed, true);
    assert.equal(older.mods[0].updateAvailable, false, 'the site entry is older than the install → no update');
    // 站点条目换成「刚刚上传」⇒ 比 installedAt 新 ⇒ 有新版
    f.catalogBytes = catalogBytesAt(new Date(Date.now() + 60000).toISOString());
    const newer = await c.catalog(true);
    assert.equal(newer.mods[0].installed, true);
    assert.equal(newer.mods[0].updateAvailable, true, 'a newer site entry is reported as an available update');
    assert.equal(typeof newer.mods[0].installedAt, 'string');
    assert.ok(newer.mods[0].installedAt.length > 0, 'and the installed instant travels to the panel');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay: an unparsable uploadedAt falls back to a SIZE mismatch, and to false when neither says anything', async () => {
  const dir = tmpWorkshop();
  try {
    const c = mods.createController({ workshopDir: dir, fetchImpl: fetchStub(), log: () => {} });
    c.setFeature(true);
    await c.install('demo');
    // 时间不可解析 + 大小相同 ⇒ 没有可说的 ⇒ 不猜
    const same = await c.catalog(true);
    assert.equal(same.mods[0].updateAvailable, false, 'same size, unparsable time → no claim');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay: with no parseable uploadedAt at all, a zip-size change alone is reported as an update', async () => {
  const dir = tmpWorkshop();
  try {
    // 站点条目给不出时间（uploadedAt 缺失）：唯一可用的信号是 zip 字节数变了 —— 同 id 换了内容。
    const bytesFor = (size) => Buffer.from(JSON.stringify({
      mods: [{ id: 'demo', name: 'Demo pack', size: size, note: 'hi', download: '/mods/demo.zip' }],
      flagged: [],
    }));
    const f = fetchStub({ catalogBytes: bytesFor(999) });
    const c = mods.createController({ workshopDir: dir, fetchImpl: f, log: () => {} });
    c.setFeature(true);
    await c.install('demo');
    const a = await c.catalog(true);
    assert.equal(a.mods[0].installed, true);
    assert.equal(a.mods[0].updateAvailable, true, 'zip size differs → there is a newer build');
    // 大小一致时闭嘴（没有第二条依据可猜）：装机时记下的 zip 字节数就是真值
    const zipBytes = c.installed()[0].zipBytes;
    assert.ok(zipBytes > 0, 'the install recorded the zip size');
    f.catalogBytes = bytesFor(zipBytes);
    const b = await c.catalog(true);
    assert.equal(b.mods[0].updateAvailable, false, 'same zip size again → still no claim');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay: the size fallback compares ZIP bytes to zip bytes — never the unpacked directory', async () => {
  const dir = tmpWorkshop();
  try {
    const f = fetchStub();  // 目录给 size:1234，而 zip 的实际字节数与此无关
    const c = mods.createController({ workshopDir: dir, fetchImpl: f, log: () => {} });
    c.setFeature(true);
    await c.install('demo');
    const installed = c.installed()[0];
    assert.ok(installed.bytes > 0, 'the unpacked directory has a size');
    assert.ok(installed.zipBytes > 0, 'and the install records the zip size too');
    assert.notEqual(installed.bytes, installed.zipBytes, 'they are different quantities');
    // 把 uploadedAt 拿掉，只留 size：若拿目录大小去比，这里会恒报 true（旧实现的 bug）
    f.catalogBytes = Buffer.from(JSON.stringify({
      mods: [{ id: 'demo', name: 'Demo pack', size: installed.zipBytes, note: 'hi', download: '/mods/demo.zip' }],
      flagged: [],
    }));
    const a = await c.catalog(true);
    assert.equal(a.mods[0].updateAvailable, false, 'matching zip size → no update, even though the dir size differs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay: two site entries sharing a pack id are both flagged with their sibling count', async () => {
  const dir = tmpWorkshop();
  try {
    // duel-assets 的真实形态：同 packId 两条，站侧「改名重投，请以本条为准」。
    // 两条的 pack.json id 都是 duel-assets，而站点条目 id 是哈希（aaa / bbb）——所以装完其中一条后，
    // 两条都不该显示成「已装」（已装的是 duel-assets 这个包，不是任何一条站点条目）。
    // 两条站点条目都指向 duel-assets：zip 的 pack.json id 也必须是它（真实站点就是这样）
    const f = fetchStub({
      catalogBytes: Buffer.from(JSON.stringify({
        mods: [
          { id: 'aaa', name: '旧命名版本', size: 100, uploadedAt: '2026-10-12T02:45:00Z', download: '/mods/a.zip', packId: 'duel-assets' },
          { id: 'bbb', name: '请以本条为准', size: 100, uploadedAt: '2026-10-12T02:46:00Z', download: '/mods/b.zip', packId: 'duel-assets' },
        ],
        flagged: [],
      })),
      packBytes: packZip({ 'content/duel.json': '{"a":1}' }, { id: 'duel-assets', name: '争锋对局素材' }),
    });
    // 站点条目 id 是哈希、zip 的 pack.json id 是 duel-assets —— 下载地址必须是站点上的那个
    const c = mods.createController({ workshopDir: dir, fetchImpl: f, log: () => {} });
    c.setFeature(true);
    const a = await c.catalog(true);
    assert.equal(a.mods.length, 2);
    for (const m of a.mods) {
      assert.equal(m.sameIdCount, 1, 'each entry sees exactly one sibling: ' + m.id);
      assert.deepEqual(m.sameIdNames, [m.id === 'aaa' ? '请以本条为准' : '旧命名版本'], 'and its name');
      assert.equal(m.packId, 'duel-assets', 'the site-declared pack id is passed through untouched');
    }
    // 装 aaa：zip 的 pack.json id 是 duel-assets，站点条目 id 是 aaa —— 目录名是 duel-assets
    const inst = await c.install('aaa');
    assert.equal(inst.ok, true, JSON.stringify(inst));
    assert.equal(inst.id, 'duel-assets', 'the directory is the pack.json id');
    const b = await c.catalog(true);
    // 已装判据是 source.json 记的**站点条目 id**（aaa）⇒ 装过的那一条显示「已装」，另一条不显示。
    // 这不是「duel-assets 已装」：两条站点条目是**不同的发布**，装机记录只指向我们真正装的那一条。
    assert.equal(b.mods[0].installed, true, 'the entry we installed reports installed (via source.json.siteId)');
    assert.equal(b.mods[1].installed, false, 'the other entry of the same pack id does NOT — it is a different publish');
    assert.equal(c.installed().length, 1);
    assert.equal(c.installed()[0].id, 'duel-assets', 'the directory is the pack.json id');
    assert.equal(c.installed()[0].siteId, 'aaa', 'and source.json remembers which site entry produced it');
    // 同 id 标注是**站点侧**的事实，与「装没装、装的是哪条」无关
    assert.equal(b.mods[0].sameIdCount, 1, 'the sibling note survives the install');
    assert.equal(b.mods[1].sameIdCount, 1);
    // 已装目录的 id 单独一个字段：不与站点声明的 packId 混为一谈
    assert.equal(b.mods[0].packId, 'duel-assets');
    assert.equal(b.mods[0].installedId, 'duel-assets', 'the installed directory id travels under its own name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay: a failed overwrite install keeps the PREVIOUS version intact (no ghost, no loss)', async () => {
  const dir = tmpWorkshop();
  const realRename = fs.renameSync;
  try {
    const f = fetchStub();
    const c = mods.createController({ workshopDir: dir, fetchImpl: f, log: () => {} });
    c.setFeature(true);
    await c.install('demo');
    assert.equal(c.installed()[0].enabled, true);
    assert.equal(fs.existsSync(path.join(dir, 'demo', 'content', 'bonds.json')), true);
    // 让第二次 install 的原子搬入失败（rename 抛）。ESM 的 `import fs from 'node:fs'` 与本行拿到的
    // 是同一个模块对象，所以改这里就能改到 install() 眼里那个 fs —— 不需要给 sp-mods 加测试专用钩子。
    let armed = false;
    fs.renameSync = (a, b) => { if (armed) throw Object.assign(new Error('planted failure'), { code: 'EPERM' }); return realRename(a, b); };
    armed = true;
    const r = await c.install('demo');
    fs.renameSync = realRename;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'WRITE_FAILED', 'the failure is named, not swallowed');
    // 关键：旧版本必须**完整还在**——不是只剩一个 source.json 的空壳目录
    const after = c.installed();
    assert.equal(after.length, 1, 'the pack is still listed');
    assert.equal(after[0].enabled, true, 'and its enable flag survived');
    assert.equal(fs.existsSync(path.join(dir, 'demo', 'pack.json')), true, 'pack.json is back');
    assert.equal(fs.existsSync(path.join(dir, 'demo', 'content', 'bonds.json')), true, 'and so are its files');
    assert.equal(fs.readdirSync(dir).indexOf('.old-demo'), -1, 'the backup is cleaned up on success and renamed back on failure');
    // 装第三遍（不再拦 rename）：恢复正常，且这次是新 source.json
    const again = await c.install('demo');
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(c.installed().length, 1, 'still exactly one copy');
    assert.equal(fs.readdirSync(dir).indexOf('.old-demo'), -1, 'and no leftover backup directory');
  } finally {
    fs.renameSync = realRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay: a failed overwrite install on a pack that was NOT installed before leaves nothing behind', async () => {
  const dir = tmpWorkshop();
  const realRename = fs.renameSync;
  try {
    const f = fetchStub();
    const c = mods.createController({ workshopDir: dir, fetchImpl: f, log: () => {} });
    c.setFeature(true);
    // 第一次装就失败（没有旧版本可回退）
    fs.renameSync = (a, b) => { throw Object.assign(new Error('planted failure'), { code: 'EPERM' }); };
    const r = await c.install('demo');
    fs.renameSync = realRename;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'WRITE_FAILED');
    assert.equal(c.installed().length, 0, 'nothing is registered');
    // 只剩 feature.json（本用例自己开的开关）；没有 stage、没有 .old- 备份、没有半装目录
    const left = fs.readdirSync(dir).filter((n) => n !== 'feature.json');
    assert.deepEqual(left, [], 'no pack directory is left behind — not even a stage or a backup');
  } finally {
    fs.renameSync = realRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay: an overwrite install REMOVES files the new zip no longer carries (no stale leftovers)', async () => {
  const dir = tmpWorkshop();
  try {
    const f = fetchStub();
    const c = mods.createController({ workshopDir: dir, fetchImpl: f, log: () => {} });
    c.setFeature(true);
    await c.install('demo');
    assert.equal(fs.existsSync(path.join(dir, 'demo', 'content', 'bonds.json')), true);
    // 同一个 pack id 的新版 zip：少了 content/bonds.json，多了 content/items.json
    f.packBytes = packZip({ 'content/items.json': '{"x":1}' });
    const r = await c.install('demo');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fs.existsSync(path.join(dir, 'demo', 'content', 'bonds.json')), false,
      'a file the new version dropped is GONE — the whole directory is replaced, not merged into');
    assert.equal(fs.existsSync(path.join(dir, 'demo', 'content', 'items.json')), true, 'and the new file is there');
    const inst = c.installed()[0];
    assert.equal(inst.enabled, true, 'a re-installed pack stays enabled');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('panel: the catalogue row shows 更新 (not 启用/停用) when the site has a newer build', () => {
  // 静态形状断言：面板源码必须按 updateAvailable 分支，且徽章/提示文案都在。
  // （modRow 本身要 htm 渲染，在 overlay:render 那组用例里跑；这里只锁住形状不漂移。）
  assert.ok(PANEL_SRC.includes('m.updateAvailable'), 'the panel reads the catalogue\'s updateAvailable flag');
  assert.ok(PANEL_SRC.includes("busy ? '更新中…' : '更新'"), 'and the button says 更新 while busy');
  assert.ok(PANEL_SRC.includes('站点有新版'), 'and the meta line says the site has a newer build');
  assert.ok(PANEL_SRC.includes('m.sameIdCount'), 'and the sibling-of-the-same-pack-id badge is wired');
  assert.ok(PANEL_SRC.includes('同 id'), 'and the badge names the pack id');
  assert.ok(PANEL_SRC.includes('旧版本的文件不会残留'), 'and the footer states that old files do not linger');
  assert.ok(PANEL_SRC.includes('已更新'), 'and a successful update is reported as 已更新, not 已安装');
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

// ---- the floating window: the mod entry is one of the function-grid entries (owner 2026-10-11) -----
// The panel became the floating window's FIRST SCREEN (the function list): the old dedicated
// "打开 mod 管理器" button and the four inline first-level buttons are gone -- the mod manager is one
// of the six grid labels, and every grid entry routes through openPanel(kind).
test('floating window: the mod manager is one of the six function-grid entries and opens kind mods', () => {
  const code = PRELOAD_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(code.includes('stateRow'), 'the preload block still has the 状态 + progress bar row');
  assert.ok(code.includes("infoRow('本地可用'"), 'the preload block keeps 本地可用');
  assert.equal(code.includes('progressRow'), false, 'the old separate progress row must be gone');
  // the mod manager is a label in the FUNCS grid, and the grid routes each label through
  // openPanel(kind) -- 'mods' is one of the six entries.
  assert.ok(/\[\s*'mod 管理器',\s*'mods'\s*\]/.test(code), 'the function grid holds [mod 管理器 -> mods]');
  assert.ok(code.includes('openPanel(kind'), 'the grid delegates through openPanel(kind, onClose)');
  // the old dedicated-button + four-inline-buttons shape is gone (it was the 2026-10-10 contract)
  assert.equal(code.includes('>打开 mod 管理器</button>'), false, 'the dedicated mod button became a grid entry');
  for (const gone of ['公开大厅', '提交房间']) {
    assert.ok(!code.includes('>' + gone + '</button>'), 'the old first-level button came back: ' + gone);
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
    // 业主口径 2026-10-11：装完要**在界面里**明说怎么生效，并给一个就地重载按钮。
    // 2026-10-12 收口：三条车道的热更边界不同，提示按层分级，不再一律喊「重开 APK」。
    await new Promise((r) => setTimeout(r, 0));
    kit.__resetHooks();
    const view2 = comp({ onClose: () => {} }); // re-render the way a state update would (same as above)
    const afterInstall = textOf(view2);
    assert.ok(afterInstall.indexOf('需要重载') >= 0, 'the reload row appears after an install: ' + afterInstall.slice(0, 200));
    assert.ok(afterInstall.indexOf('下一轮热更新即生效') >= 0,
      'a pure data pack (A) promises the next hot update, not an APK reinstall: ' + afterInstall.slice(0, 200));
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

// ---- 热更友好性（2026-10-12，业主口径「做成热更新好更新的形式」）------------------------------------
// 两条接缝都随 slim 热更树下发（build-webroot/make-bundle → server/overlay/，
// Updater.applyExtras → webroot/）。热更只覆盖同名文件、删不掉旧文件 ⇒ 两端会短暂错配，
// 所以装载器响应必须自带契约版本，让客户端能自己判断「这份响应我读不读得懂」。
test('loader manifest carries the contract versions + the slot table, so a hot-updated pair can detect a mismatch', async () => {
  const { LOADER_API, PANEL_SLOT_NAMES, overlayApi, version } = await import(pathToFileURL(path.join(here, 'overlay', 'sp-mods.mjs')).href);
  assert.equal(typeof LOADER_API, 'number', 'the loader response generation is exported');
  assert.ok(Array.isArray(PANEL_SLOT_NAMES) && PANEL_SLOT_NAMES.length === 9,
    'the nine Forge slots are published as data, not hardcoded in the manager: ' + JSON.stringify(PANEL_SLOT_NAMES));
  assert.ok(PANEL_SLOT_NAMES.includes('screen.game.aside'), 'aside slot present');
  assert.ok(PANEL_SLOT_NAMES.includes('screen.game.shopCard'), 'the repeatable slot is named too (we refuse to mount it)');
  // The client pins the same number; a drift between the two is what the handshake catches.
  const clientSrc = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'modsLoader.js'), 'utf8');
  assert.match(clientSrc, /var LOADER_API = \d+;/, 'the client pins a LOADER_API to compare against');
  const clientPinned = Number(/var LOADER_API = (\d+);/.exec(clientSrc)[1]);
  assert.equal(clientPinned, LOADER_API, 'client and server agree on the current generation');
  // And the slot table the client receives must match the anchors it can actually mount.
  const panelsSrc = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'modPanels.js'), 'utf8');
  for (const slot of PANEL_SLOT_NAMES) {
    assert.ok(panelsSrc.indexOf("'" + slot + "'") >= 0, 'every published slot has an anchor table entry: ' + slot);
  }
  assert.equal(typeof overlayApi, 'number');
  assert.equal(typeof version, 'number', 'the module version rides the response as fileVersion');
});

test('loader (client): refuses a response from a NEWER loader, but still trusts a legacy one', async () => {
  // Newer server, older page: the page must not guess at fields it does not know.
  const future = runModsLoader({
    doc: { loaderApi: 99, feature: true, packs: [{ id: 't', layer: 'C', theme: { vars: { '--a': '#fff' } } }], dataKinds: [] },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(future.style(), null, 'a newer loader generation is refused, not half-applied');
  assert.equal(future.win.__SP_MODS_LOADER, undefined, 'and no report is published');

  // Legacy server (no loaderApi at all): v1 only ADDED fields, so dropping it would
  // needlessly show working packs as inactive.
  const legacy = runModsLoader({
    doc: { feature: true, packs: [{ id: 't', layer: 'C', theme: { vars: { '--a': '#fff' } } }], dataKinds: [] },
  });
  await new Promise((r) => setImmediate(r));
  assert.ok(legacy.style(), 'a legacy response (no loaderApi) is still honoured');
  assert.equal(legacy.win.__SP_MODS_LOADER.themeApplied, true);
  assert.equal(legacy.win.__SP_MODS_LOADER.loaderApi, undefined, 'and it reports no generation');
});

// ---- 业主 2026-10-13：分类按站点来（可更新样式）+ 一行两个 + 放大 + 长名左右滚动 ---------------

test('overlay: normalizeEntry 透出站点的分类字段（packKind / funcKind / funcKindTitle）', () => {
  const e = mods.normalizeEntry({
    id: 'x', name: 'n', download: '/api/file/x',
    packKind: 'functional', funcKind: 'gameplay', funcKindTitle: '游戏玩法',
  }, false);
  assert.equal(e.packKind, 'functional');
  assert.equal(e.funcKind, 'gameplay');
  assert.equal(e.funcKindTitle, '游戏玩法');
  // 站点没给就空串（面板据此不画分类标签，绝不本地编一个）
  const bare = mods.normalizeEntry({ id: 'y', download: '/api/file/y' }, false);
  assert.equal(bare.funcKind, '');
  assert.equal(bare.funcKindTitle, '');
});

test('overlay: catalog 按站点给 funcs/funcKindTitles 生成分类清单（站点加分类自动出现）', async () => {
  const dir = tmpWorkshop();
  try {
    const body = Buffer.from(JSON.stringify({
      // 站点声明 3 个分类，但只有 2 个有条目 —— 空分类不出现（噪音）
      funcs: ['gameplay', 'utility', 'expansion'],
      funcKindTitles: { gameplay: '游戏玩法', utility: '实用工具', expansion: '拓展包' },
      mods: [
        { id: 'a', name: 'A', download: '/api/file/a', funcKind: 'gameplay', funcKindTitle: '游戏玩法' },
        { id: 'b', name: 'B', download: '/api/file/b', funcKind: 'gameplay', funcKindTitle: '游戏玩法' },
        { id: 'c', name: 'C', download: '/api/file/c', funcKind: 'utility', funcKindTitle: '实用工具' },
      ],
    }));
    const f = fetchStub({ catalogBytes: body });
    const c = mods.createController({ workshopDir: dir, fetchImpl: f, log: () => {} });
    c.setFeature(true);
    const r = await c.catalog(false);
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.deepEqual(r.funcs, [
      { kind: 'gameplay', title: '游戏玩法', count: 2 },
      { kind: 'utility', title: '实用工具', count: 1 },
    ], '只保留有条目的分类，顺序跟站点声明序，带条数');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay: 站点没给 funcs 时，分类从条目里推（标签退回 key，不本地编中文）', async () => {
  const dir = tmpWorkshop();
  try {
    const body = Buffer.from(JSON.stringify({
      mods: [
        { id: 'a', name: 'A', download: '/api/file/a', funcKind: 'assets' },
        { id: 'b', name: 'B', download: '/api/file/b', funcKind: 'assets' },
        { id: 'c', name: 'C', download: '/api/file/c', funcKind: 'documentation' },
      ],
    }));
    const f = fetchStub({ catalogBytes: body });
    const c = mods.createController({ workshopDir: dir, fetchImpl: f, log: () => {} });
    c.setFeature(true);
    const r = await c.catalog(false);
    assert.deepEqual(r.funcs.map((x) => x.kind).sort(), ['assets', 'documentation'], '从条目推分类');
    assert.equal(r.funcs.find((x) => x.kind === 'assets').title, 'assets', '没有中文标签就退回 key');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('panel: 一行两个 mod（两列网格）+ 放大面板 + 长名左右滚动（超 70% 才滚）', () => {
  // 两列网格
  assert.ok(/\.sp-mods-grid\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(PANEL_SRC),
    '两列网格');
  assert.ok(/@media \(max-width:720px\)\{\.sp-mods-grid\{grid-template-columns:minmax\(0,1fr\)\}\}/.test(PANEL_SRC),
    '窄屏回落单列（否则卡片被压得读不了）');
  // 放大：给 Modal 传 width（原来不传，走 kit 的 min(10.4rem,…)）
  assert.ok(PANEL_SRC.includes('width="min(94vw,44rem)"'), '面板尺寸放大（显式 width）');
  // 长名左右滚动：超 70% 才加 is-scroll，位移 = 溢出量
  assert.ok(/text > box \* 0\.7/.test(PANEL_SRC), '阈值是卡片可用宽的 70%');
  assert.ok(/classList\.add\('is-scroll'\)/.test(PANEL_SRC), '超了才加 is-scroll');
  assert.ok(/-\(text - box\)/.test(PANEL_SRC), '滚动位移 = 溢出量（不是固定值）');
  assert.ok(/@keyframes sp-mod-name\{from\{transform:translateX\(0\)\}to\{transform:translateX\(var\(--sp-mod-shift/.test(PANEL_SRC),
    '左右来回滚（alternate）');
  // 分类筛选：全部 + 站点分类，标签用站点给的中文
  assert.ok(/setFuncPick\(''\)/.test(PANEL_SRC), '「全部」按钮清筛选');
  assert.ok(/f\.title/.test(PANEL_SRC), '分类按钮用站点给的标题');
  // 分类标签落在卡片上（funcKindTitle 优先）
  assert.ok(/m\.funcKindTitle \|\| m\.funcKind/.test(PANEL_SRC), '卡片标签用站点的中文，退回 key');
});

// ---- 包身份：Forge 的 canonicalJson / manifestDigest（业主 2026-10-14：「mod 管理器版本用 Forge 这个」）----
// 金标准值由 Forge 自己的代码算出（Stronghold-Protocol-Forge@b4089f7 的 shared/modIdentity.js：
// `node --input-type=module -e "import {canonicalJson,modManifestDigest} from './shared/modIdentity.js'; ..."`）。
// 这些断言的作用：证明我们这侧的实现**就是 Forge 的算法**，而不是"看起来像"。

test('canonicalJson 与 Forge 逐字同算法（键排序 / 丢 undefined / 数组保序 / 基元直出）', () => {
  const goldens = [
    [{ b: 1, a: 2 }, '{"a":2,"b":1}'],
    [{ z: [{ y: 1, x: 2 }], a: null }, '{"a":null,"z":[{"x":2,"y":1}]}'],
    [{ a: 1, b: undefined }, '{"a":1}'],
    [[null, true, 1.5, 'x'], '[null,true,1.5,"x"]'],
  ];
  for (const [input, want] of goldens) {
    assert.equal(mods.canonicalJson(input), want, 'canonicalJson(' + JSON.stringify(input) + ')');
  }
});

test('manifestDigestOf 与 Forge 逐字同算法（按路径排序 / sha256 over canonical 对）', () => {
  // 金标准（Forge 代码实测）：
  const SORTED = 'eb08ff28c70a99b6e51470877de7f998ce028c3cf3604a6e20fa7bdaaf3fbf62';
  const CHANGED = '97e273d1afb146e10fb66e8ce6457e6cc91e7ae1e6992cde5639200dbd9bf894';
  const DROPS = '67da3de65de4cf16147e04466d69e46842d3cda044ce89cb58267b7a7b8c5569';
  assert.equal(mods.manifestDigestOf([{ path: 'b.js', hash: '22' }, { path: 'a.js', hash: '11' }]), SORTED);
  assert.equal(mods.manifestDigestOf([{ path: 'a.js', hash: '11' }, { path: 'b.js', hash: '22' }]), SORTED,
    '输入顺序不影响（先排序再哈希）');
  assert.equal(mods.manifestDigestOf([{ path: 'a.js', hash: '11' }, { path: 'b.js', hash: '33' }]), CHANGED,
    '换一个字节就换摘要');
  assert.equal(mods.manifestDigestOf([{ path: 'a.js', hash: '11' }, { path: 5, hash: '11' }, null]), DROPS,
    '坏条目被丢弃（与 Forge 的 filter 一致）');
});

test('packContentDigest：同一份内容不同落盘顺序 -> 同摘要；改内容 -> 换摘要；dot 文件不参与', () => {
  const mk = (dir, files) => {
    for (const [rel, text] of Object.entries(files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    }
  };
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-digest-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-digest-b-'));
  const c = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-digest-c-'));
  try {
    // a：先写 pack.json 再写内容；b：顺序相反 + 多一个 dot 文件（不该参与身份）
    mk(a, { 'pack.json': '{"id":"x"}', 'content/bonds.json': '{"a":1}', 'kits/k.js': 'x' });
    mk(b, { 'kits/k.js': 'x', 'content/bonds.json': '{"a":1}', 'pack.json': '{"id":"x"}', '.DS_Store': 'junk' });
    mk(c, { 'pack.json': '{"id":"x"}', 'content/bonds.json': '{"a":2}', 'kits/k.js': 'x' });
    const da = mods.packContentDigest(a);
    const db = mods.packContentDigest(b);
    const dc = mods.packContentDigest(c);
    assert.match(da.digest, /^[0-9a-f]{64}$/, '是 sha256 hex');
    assert.equal(da.digest, db.digest, '同一份内容、不同落盘顺序/多一个 dot 文件 -> 同摘要（这正是 zip sha256 做不到的）');
    assert.equal(da.files, db.files, '参与身份的文件数一致');
    assert.notEqual(da.digest, dc.digest, '改一个字节 -> 换摘要');
  } finally {
    for (const d of [a, b, c]) fs.rmSync(d, { recursive: true, force: true });
  }
});
