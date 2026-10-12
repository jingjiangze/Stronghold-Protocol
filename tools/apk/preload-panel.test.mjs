// preloadPanel tests: the floating window's FIRST SCREEN is the function list (ui/preloadPanel.js),
// registered as kind 'preload' into ui/shellPanels.js' add-on registry -- the same dynamic-import +
// registerPanel pattern lobby.js uses. Owner direction 2026-10-11: three CONNECT entries (本地服务 /
// 加入局域网 / 加入服务器 with a custom-domain input that is NOT published to the room board), the
// function entries, then the preload block at the very bottom with a progress bar and ONE start/stop
// button. Owner direction 2026-10-12 (an SVG sketch = the visual baseline, this file is the
// implementation): the three connect entries are THREE EQUAL COLUMNS SIDE BY SIDE taking HALF the
// content height; FIVE equal function buttons in ONE row (mod 管理器 / 房间列表 / 全局设置 / 检查更新 /
// 开始预载); a right-to-left credits marquee UNDER the buttons; the preload progress bar pinned BELOW
// the marquee; no red / amber zone tinting any more; a fixed window that never scrolls.
//
// These cases render the REAL component against a minimal htm/h shim and assert that layout, the
// numbers drawn from window.__SP_PRELOAD, the delegation of every entry, the "never a dead click"
// rule, the credits data, and the hot-update single-interface wiring. The data/state logic itself
// stays in preload-center.js and is covered by preload-center.test.mjs.
//
//   node --test tools/apk/preload-panel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'preloadPanel.js'), 'utf8');
const PRELOAD_CENTER = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'preload-center.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-bridge.js'), 'utf8');
// The overlay ships its OWN vendor htm (js/vendor/htm.module.js -- the same file the kit imports on
// /__sp/ pages), so the render cases always run against the real parser: no build step needed.
const HTM = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'vendor', 'htm.module.js'), 'utf8');
const needsUpstream = (name, fn) => test(name, fn);

// A tiny h() that keeps props + children so the test can walk the vnode tree (find buttons, read
// onClick). htm does the parsing; this is the same shape Preact's h() hands a component.
// The overlay's OWN UI kit (ui/overlayKit.js) stub -- the panel resolves html / Modal / Button /
// MicroLabel / toast / hooks from it, never from the page's js/ui/components.js.
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
  'export function useState(v) { return [typeof v === \'function\' ? v() : v, function () {}]; }',
  'export function useEffect() {}',
].join('\n');
const HOOKS_STUB = [
  "export function useState(v) { return [typeof v === 'function' ? v() : v, function () {}]; }",
  'export function useEffect() {}',
].join('\n');
// The panel registers itself through registerPanel(kind, component); capture it in a global.
const SHELLPANELS_STUB = [
  'export function registerPanel(kind, component) {',
  '  (globalThis.__spTestPanels = globalThis.__spTestPanels || {})[kind] = component;',
  '}',
].join('\n');

function mkTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preloadpanel-'));
  const w = (rel, text) => {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  w('package.json', JSON.stringify({ type: 'module' }));
  w('public/js/ui/preloadPanel.js', SRC);
  w('public/js/ui/shellPanels.js', SHELLPANELS_STUB);
  w('public/js/ui/overlayKit.js', KIT_STUB);
  w('public/vendor/hooks.module.js', HOOKS_STUB);
  w('public/vendor/htm.module.js', HTM);
  return root;
}

/** Import the real preloadPanel.js, wait for its deps, and return the registered component. */
async function loadPanel(root) {
  delete globalThis.__spTestPanels;
  const entry = path.join(root, 'public', 'js', 'ui', 'preloadPanel.js');
  const mod = await import(pathToFileURL(entry).href);
  await mod.whenDepsReady();
  const comp = globalThis.__spTestPanels && globalThis.__spTestPanels.preload;
  assert.equal(typeof comp, 'function', "the module registered kind 'preload'");
  return comp;
}

// ---------------------------------------------------------------- vnode helpers

/** Resolve component-function vnodes (Modal / Button / MicroLabel) to their plain output, the way
 *  Preact would, so text/button walks see the real tree. */
function resolve(node) {
  let n = node;
  for (let i = 0; i < 20 && n && typeof n === 'object' && typeof n.type === 'function'; i++) {
    n = n.type(n.props);
  }
  return n;
}

function textOf(node) {
  const n = resolve(node);
  if (n == null || n === false || n === true) return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  if (n && n.type) return textOf(n.children);
  return '';
}

/** Class tokens of a vnode (the templates use both literals and dynamic class=${…} strings). */
function classesOf(n) {
  const c = n && n.props && n.props.class;
  return typeof c === 'string' ? c.split(/\s+/).filter(Boolean) : [];
}

function collectButtons(node, out) {
  out = out || [];
  const n = resolve(node);
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const c of n) collectButtons(c, out); return out; }
  if (n.type === 'button') out.push(n);
  if (n.children) collectButtons(n.children, out);
  return out;
}

function buttonByText(node, label) {
  return collectButtons(node).find((b) => textOf(b) === label) || null;
}

/** Nodes carrying a class token (used to address the panel's own blocks: __zones / __zone / __menu /
 *  __credits / __bar …). Class-addressed lookups keep their meaning across the re-layout. */
function findByClass(node, cls, out) {
  out = out || [];
  const n = resolve(node);
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const c of n) findByClass(c, cls, out); return out; }
  if (classesOf(n).includes(cls)) out.push(n);
  if (n.children) findByClass(n.children, cls, out);
  return out;
}

/** Buttons of ONE connect column, addressed by its Chinese title (本地服务 / 加入局域网 / 加入服务器). */
function zoneByTitle(node, title) {
  return findByClass(node, 'sp-preload__zone').find((z) => {
    const t = findByClass(z, 'sp-preload__zone-title')[0];
    return t ? textOf(t) === title : false;
  }) || null;
}

function zoneButtons(node, title) {
  const z = zoneByTitle(node, title);
  return z ? collectButtons(z) : [];
}

/** Nodes whose inline style contains `needle` (used to pin the bar fill's width). */
function findStyled(node, needle, out) {
  out = out || [];
  const n = resolve(node);
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const c of n) findStyled(c, needle, out); return out; }
  const st = n.props && typeof n.props.style === 'string' ? n.props.style : '';
  if (st.includes(needle)) out.push(n);
  if (n.children) findStyled(n.children, needle, out);
  return out;
}

/** The state shape window.__SP_PRELOAD.state() returns (preload-center.js diag()). The rates/pack
 *  block stays in the fixture on purpose: the data must keep existing (other readers), while the
 *  panel must never draw it (owner 2026-10-10: 去掉缓存载入参数). */
function stateFixture(over) {
  return Object.assign({
    phase: 'running', profile: 'full', done: 5, total: 20, failed: 0, pending: 15,
    localFiles: 0, bytes: 1048576, store: 'android', paused: 0, resumed: false, delegated: true,
    cached: { core: false, full: false },
    rates: { bps: 2097152, avgBps: 1048576, filesPerSec: 4, avgFilesPerSec: 3, etaMs: 60000, elapsedMs: 20000, bytesKnown: true },
    pack: {
      active: true, stage: 'unzip', pack: 'audio.voice.3', packsDone: 2, packsTotal: 4,
      bytesDone: 1048576, bytesTotal: 4194304, dlBps: 1048576, unzipBps: 3145728, etaMs: 120000,
    },
  }, over || {});
}

const SPEED_TEXT = /下载速度|解压速度|预载速度|预计剩余|包通道/;

/** Render the panel with the given state/shell, returning { vnode, text, toasts, onCloseCalls }. */
function renderPanel(comp, state, shell) {
  const prevWin = globalThis.window;
  const onCloseCalls = [];
  delete globalThis.__spTestToasts;
  globalThis.window = { __SP_PRELOAD: { state: () => state }, __SP_SHELL: shell };
  try {
    const vnode = comp({ onClose: () => onCloseCalls.push(true) });
    return { vnode, text: textOf(vnode), toasts: globalThis.__spTestToasts, onCloseCalls };
  } finally {
    delete globalThis.__spTestToasts;
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
  }
}

// ---------------------------------------------------------------- cases

needsUpstream('the owner 2026-10-12 shape renders: 3 connect columns + 5 buttons + credits + bar', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const { vnode, text } = renderPanel(comp, stateFixture(), undefined);
    // 三个竖框：三列并排，标题 = 业主 SVG 的中文标题 + 英文副题
    assert.equal(findByClass(vnode, 'sp-preload__zones').length, 1, 'one zone group (the 3 columns)');
    assert.equal(findByClass(vnode, 'sp-preload__zone').length, 3, 'exactly three connect columns');
    for (const t of ['本地服务', '加入局域网', '加入服务器']) {
      assert.ok(zoneByTitle(vnode, t), 'a connect column is missing: ' + t);
    }
    for (const m of ['LOCAL SERVICE', 'LAN DISCOVERY', 'SERVER CONNECT']) {
      assert.ok(text.includes(m), 'the column subtitle is missing: ' + m);
    }
    assert.ok(text.includes('完成'), 'the close action');
    // 旧结构（红/黄两区 + 分层标题）不许回来
    assert.ok(!text.includes('进入游戏'), 'the old red-zone head 进入游戏 is gone');
    assert.ok(!text.includes('FUNCTIONS'), 'the old yellow-zone head is gone');
    assert.ok(!text.includes('快捷入口'), 'the old 快捷入口 layer is gone');
    assert.ok(!text.includes('资源预载与离线缓存中心'), 'the old preload-center title is gone');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('five function buttons sit in ONE row (mod 管理器 / 房间列表 / 全局设置 / 检查更新 / 开始预载)', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const { vnode } = renderPanel(comp, stateFixture({ phase: 'idle', done: 0, total: 0, pending: 0, pack: null }), undefined);
    const rows = findByClass(vnode, 'sp-preload__menu');
    assert.equal(rows.length, 1, 'the five entries live in ONE menu row');
    assert.deepEqual(collectButtons(rows[0]).map(textOf),
      ['mod 管理器', '房间列表', '全局设置', '检查更新', '开始预载'],
      'five entries, one row, the owner\'s order');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('draws the value lines from window.__SP_PRELOAD.state() and never a load-rate/ETA line', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    // the fixture carries live rates + a live pack channel: none of it may reach the display.
    const { vnode, text } = renderPanel(comp, stateFixture(), undefined);
    assert.match(text, /正在后台预载/, 'the running head');
    assert.match(text, /本地可用/, 'local-available label');
    assert.match(text, /5 \/ 20/, 'local-available count');
    assert.match(text, /回源缓存/, 'the Android cache label (store=android)');
    assert.match(text, /1\.0 MB/, 'the Android byte figure');
    assert.match(text, /待预载/, 'pending label');
    assert.match(text, /15/, 'pending count');
    assert.doesNotMatch(text, SPEED_TEXT, 'no download/unpack/preload speed, no ETA, no pack channel');
    assert.doesNotMatch(text, /文件\/秒|B\/s|MB\/s/, 'no rate unit anywhere');
    // the progress bar must stay INSIDE the panel: the 25% (5/20) fill + its track, horizontal
    assert.match(text, /25%/, 'the percentage read-out');
    const fill = findByClass(vnode, 'sp-preload__bar-fill');
    assert.equal(fill.length, 1, 'exactly one progress fill');
    assert.ok(String(fill[0].props.style).includes('width:25%'), 'the fill is 25% wide: ' + fill[0].props.style);
    assert.equal(findByClass(vnode, 'sp-preload__bar').length, 1, 'exactly one progress track');
    assert.ok(findStyled(vnode, 'width:25%').length >= 1, 'the width rides an inline style (animatable)');
    assert.match(text, /RESOURCE PRELOAD/, 'the bar keeps its label');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('the order is 三框 -> 五按钮 -> 感谢名单 -> 预载进度条 (owner 2026-10-12)', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const { vnode } = renderPanel(comp, stateFixture(), undefined);
    const body = findByClass(vnode, 'sp-preload')[0];
    assert.ok(body, 'the panel root renders');
    // the four blocks are siblings in ONE flex column: assert their DOM order
    const kids = (body.children || []).filter((c) => c && c.props && typeof c.props.class === 'string');
    const order = kids.map((c) => classesOf(c).join(' '));
    const idx = (cls) => order.findIndex((c) => c.includes(cls));
    assert.ok(idx('sp-preload__zones') >= 0, 'the three columns render');
    assert.ok(idx('sp-preload__zones') < idx('sp-preload__menu'), 'the columns come before the buttons');
    assert.ok(idx('sp-preload__menu') < idx('sp-preload__credits'), 'the buttons come before the credits');
    assert.ok(idx('sp-preload__credits') < idx('sp-preload__preload'), 'the credits sit ABOVE the preload bar');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('credits: the marquee draws the REAL thanks list (no invented names, no sketch placeholders)', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const { vnode } = renderPanel(comp, stateFixture(), undefined);
    const roll = findByClass(vnode, 'sp-preload__roll')[0];
    assert.ok(roll, 'the credits track renders');
    assert.equal(findByClass(vnode, 'sp-preload__roll-copy').length, 4,
      'four identical copies -> the -25% loop is seamless');
    const text = textOf(roll);
    // 真源：线上 KV GET /api/thanks (v2) 与 C:\DDDD\Agent Work\stronghold-thanks\data\thanks.json
    for (const n of ['纸鸢安好', '水沫沐沐', 'jingjiangze', '剑光卤煮-斩尽牛杂', '不知名信箱', '雨千代Chiyo', '伊佐那邪_']) {
      assert.ok(text.includes(n), 'a real name is missing: ' + n);
    }
    assert.ok(text.includes('bilibili_'), 'the thanks page prefix renders (mint span)');
    assert.ok(text.includes('项目发起人') && text.includes('Mod管理器作者'), 'the small role notes render');
    assert.ok(text.includes('感谢名单') && text.includes('THANKS LIST'), 'the strip is labelled');
    assert.equal(findByClass(vnode, 'sp-preload__credit-name--lead').length, 4, 'one lead label per copy');
    // 业主示例里的占位文案（Contributors / 测试人员 / 社区支持者）不得被当成真名单发出去
    assert.doesNotMatch(text, /Contributors|测试人员|社区支持者/, 'the sketch placeholder wording is not data');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('a live artSyncStatus bridge changes nothing on the panel (data stays, display does not)', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const calls = { sync: 0, cache: 0 };
    const shell = {
      artCacheBridge: true,
      artCacheStatus: () => {
        calls.cache++;
        return JSON.stringify({ ok: true, manifestHash: 'h', cachedFiles: 3, cachedBytes: 3145728, cacheRoot: 'art/cache/h', pending: -1 });
      },
      artSyncBridge: true,
      artSyncStatus: () => {
        calls.sync++;
        return JSON.stringify({ ok: true, active: true, stage: 'unzip', pack: 'p', packsDone: 1, packsTotal: 2, dlBps: 1048576, unzipBps: 2097152, etaMs: 30000 });
      },
    };
    const { text } = renderPanel(comp, stateFixture({ pack: null }), shell);
    assert.match(text, /回源缓存/, 'the cache bridge reading is still drawn');
    assert.match(text, /3\.0 MB/, 'the bridge byte figure is drawn');
    assert.doesNotMatch(text, SPEED_TEXT, 'the pack channel is never drawn again');
    assert.equal(calls.sync, 0, 'the panel no longer polls artSyncStatus (its numbers stay in preload-center state())');
    assert.ok(calls.cache >= 1, 'the cache bridge is still read for the byte line');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('idle state: the preload has NOT started and the 5th button says 开始预载', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const idle = renderPanel(comp, stateFixture({ phase: 'idle', done: 0, total: 0, pending: 0, pack: null }), undefined);
    assert.match(idle.text, /尚未开始预载/, 'the idle head (owner 2026-10-11: no global preload by default)');
    assert.match(idle.text, /开始预载/, 'the preload entry reads 开始预载 when idle');
    assert.doesNotMatch(idle.text, /停止预载/, 'no stop wording when nothing runs');
    assert.doesNotMatch(idle.text, /待预载/, 'no pending line when idle');

    const done = renderPanel(comp, stateFixture({ phase: 'done', done: 20, total: 20, pending: 0, pack: null }), undefined);
    assert.match(done.text, /资源预载完成/, 'the finished head');
    assert.doesNotMatch(done.text, SPEED_TEXT, 'no speed/ETA line when finished');
    const fill = findByClass(done.vnode, 'sp-preload__bar-fill')[0];
    assert.ok(String(fill.props.style).includes('width:100%'), 'the finished bar is 100%: ' + fill.props.style);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('the five entries each delegate (mod 管理器 / 房间列表 / 全局设置 / 检查更新 / 开始预载)', async () => {
  const root = mkTree();
  const prevWin = globalThis.window;
  try {
    const comp = await loadPanel(root);
    const calls = { panels: [], updated: 0 };
    globalThis.window = {
      __SP_PRELOAD: { state: () => stateFixture() },
      __SP_SHELL: { openPanel: (kind) => calls.panels.push(kind) },
      shell: { checkUpdateQuiet: () => { calls.updated++; } },
    };
    const vnode = comp({ onClose: () => {} });
    // 业主 2026-10-12：五格同排；「外观设置」+「联机偏好」合并成「全局设置」；
    // 「服务器列表」不在这一排，它在「加入服务器」那一格里。
    const FUNC_LABELS = ['mod 管理器', '房间列表', '全局设置', '检查更新'];
    const allLabels = collectButtons(vnode).map(textOf);
    const gridLabels = allLabels.filter((t) => FUNC_LABELS.includes(t));
    assert.deepEqual(gridLabels, FUNC_LABELS, 'the function row, in the owner\'s order');

    buttonByText(vnode, '服务器列表').props.onClick();
    buttonByText(vnode, 'mod 管理器').props.onClick();
    buttonByText(vnode, '房间列表').props.onClick();
    buttonByText(vnode, '全局设置').props.onClick();
    assert.deepEqual(calls.panels, ['servers', 'mods', 'rooms', 'settings'],
      '服务器列表(服务器列) / mod 管理器 / 房间列表(rooms-only) / 全局设置 each open their own panel');

    // 检查更新 goes through the page's own hot-update panel (kind 'update'), NOT the native dialog.
    // The update panel starts the quiet check itself on mount (see update-panel.test.mjs), so this
    // entry only has to route there.
    buttonByText(vnode, '检查更新').props.onClick();
    assert.equal(calls.updated, 0, 'this panel does not dial the native check itself (the update panel does)');
    assert.deepEqual(calls.panels.slice(4), ['update'], '检查更新 opens the update panel');
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

needsUpstream('connect columns: 本地服务 starts the host, 加入服务器 applies the custom domain, 局域网 scans', async () => {
  const root = mkTree();
  const prevWin = globalThis.window;
  try {
    const comp = await loadPanel(root);
    const calls = { local: 0, setServer: [], lan: 0, closed: 0 };
    globalThis.window = {
      __SP_PRELOAD: { state: () => stateFixture() },
      shell: {
        startLocalService: () => { calls.local++; },
        setServer: (t) => { calls.setServer.push(t); },
        lanScan: () => { calls.lan++; return '1'; },
      },
    };
    const vnode = comp({ onClose: () => { calls.closed++; } });
    assert.deepEqual(zoneButtons(vnode, '本地服务').map(textOf), ['进入本地服务'],
      'the local column holds the enter button (no room yet -> no copy link)');
    buttonByText(vnode, '进入本地服务').props.onClick();
    assert.equal(calls.local, 1, '进入本地服务 starts the host service on demand');
    assert.equal(calls.closed, 1, 'and closes the panel (the switch reloads the page)');

    assert.deepEqual(zoneButtons(vnode, '加入局域网').map(textOf), ['扫描'], 'the LAN column holds the scan button');
    buttonByText(vnode, '扫描').props.onClick();
    assert.equal(calls.lan, 1, '扫描 calls shell.lanScan once');

    assert.ok(zoneByTitle(vnode, '加入服务器'), 'the custom-domain column exists');
    // the input starts empty -> 连接 is disabled and setServer is not called
    const conn = buttonByText(vnode, '连接');
    assert.ok(conn, 'the server column holds the 连接 button');
    conn.props.onClick();
    assert.deepEqual(calls.setServer, [], 'an empty address never dials');
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

needsUpstream('复制链接 uses the VPN address first, then the LAN address (owner 2026-10-11)', async () => {
  const root = mkTree();
  const prevWin = globalThis.window;
  try {
    const comp = await loadPanel(root);
    const copied = [];
    const win = {
      __SP_PRELOAD: { state: () => stateFixture() },
      __SP__: { store: { get: () => ({ room: { code: 'ab12' } }) } },
      shell: {
        hostAddresses: () => JSON.stringify({ zt: 'http://10.244.0.5:3000', lan: 'http://192.168.0.7:3000' }),
        copyText: (t) => { copied.push(t); },
      },
    };
    globalThis.window = win;
    let vnode = comp({ onClose: () => {} });
    assert.deepEqual(zoneButtons(vnode, '本地服务').map(textOf), ['进入本地服务', '复制链接'],
      'with a room open, the column also holds 复制链接');
    buttonByText(vnode, '复制链接').props.onClick();
    assert.deepEqual(copied, ['http://10.244.0.5:3000/?room=AB12'],
      'the copied link prefers the VPN address and carries the room code');

    // no VPN address -> the LAN one is used
    copied.length = 0;
    win.shell.hostAddresses = () => JSON.stringify({ lan: 'http://192.168.0.7:3000/' });
    vnode = comp({ onClose: () => {} });
    buttonByText(vnode, '复制链接').props.onClick();
    assert.deepEqual(copied, ['http://192.168.0.7:3000/?room=AB12'], 'the trailing slash is folded away');

    // no address table at all (old shell): the button must not copy a dead link
    copied.length = 0;
    delete win.shell.hostAddresses;
    vnode = comp({ onClose: () => {} });
    buttonByText(vnode, '复制链接').props.onClick();
    assert.deepEqual(copied, [], 'no address -> nothing is copied');
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

needsUpstream('the preload entry is ONE toggle: 停止预载 while running, 开始预载 when idle', async () => {
  const root = mkTree();
  const prevWin = globalThis.window;
  try {
    const comp = await loadPanel(root);
    const calls = { start: 0, cancel: 0 };
    globalThis.window = {
      __SP_PRELOAD: { state: () => stateFixture({ phase: 'running' }), start: () => { calls.start++; }, cancel: () => { calls.cancel++; } },
    };
    let vnode = comp({ onClose: () => {} });
    const stop = buttonByText(vnode, '停止预载');
    assert.ok(stop, 'running -> the preload entry reads 停止预载');
    stop.props.onClick();
    assert.equal(calls.cancel, 1, 'it stops the walk through the center API');
    assert.equal(calls.start, 0);
    // 运行时那一格是「实心 mint」态（业主：不加红/黄底色，强调只走 mint）
    assert.ok(classesOf(stop).includes('is-on'), 'the running entry is marked is-on');

    globalThis.window.__SP_PRELOAD = { state: () => stateFixture({ phase: 'idle' }), start: () => { calls.start++; }, cancel: () => { calls.cancel++; } };
    vnode = comp({ onClose: () => {} });
    const go = buttonByText(vnode, '开始预载');
    assert.ok(go, 'idle -> the preload entry reads 开始预载');
    assert.ok(!classesOf(go).includes('is-on'), 'idle -> no is-on');
    go.props.onClick();
    assert.equal(calls.start, 1, 'it starts the walk through the center API');
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

needsUpstream('every entry is never a dead click: a missing bridge reports instead of doing nothing', async () => {
  const root = mkTree();
  const prevWin = globalThis.window;
  try {
    const comp = await loadPanel(root);
    // a plain web page: no native shell at all
    globalThis.window = { __SP_PRELOAD: { state: () => stateFixture() } };
    const vnode = comp({ onClose: () => {} });
    delete globalThis.__spTestToasts;
    buttonByText(vnode, '进入本地服务').props.onClick();
    buttonByText(vnode, '检查更新').props.onClick();
    assert.ok(globalThis.__spTestToasts.length >= 1, 'the missing capabilities report visibly');
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- static contracts

test('static: preloadPanel registers kind preload and exports the component + whenDepsReady', () => {
  assert.ok(SRC.includes("registerPanel('preload'"), "must call registerPanel('preload', …)");
  assert.ok(SRC.includes('export function PreloadPanel'), 'PreloadPanel must be exported');
  assert.ok(SRC.includes('export function whenDepsReady'), 'whenDepsReady must be exported (tests await it)');
  assert.ok(SRC.includes("window.__SP_PRELOAD_PANEL = true"), 'must set the idempotency marker shell-bridge checks');
  assert.ok(!/^\s*import\s+[^;\n]*\bfrom\s+['"]/m.test(SRC), 'no static import: the shell modules are dynamic imports');
  assert.ok(SRC.includes("'../../js/ui/shellPanels.js'"), 'registers through the local shellPanels module');
  assert.ok(SRC.includes("'./shellPanels.js'"), 'and through the /__sp/ sibling (server pages)');
});

test('static: the owner 2026-10-12 layout (3 columns at 50% height, 5-in-a-row, credits, bar)', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  // ① 三个竖框：三列并排 + 整组占内容区 50% 高度（业主口径）
  assert.ok(code.includes('repeat(3,minmax(0,1fr))'), 'the three connect columns are ONE 3-column grid');
  assert.ok(code.includes('flex:0 0 50%'), 'the column group takes half the content height');
  for (const [t, m] of [['本地服务', 'LOCAL SERVICE'], ['加入局域网', 'LAN DISCOVERY'], ['加入服务器', 'SERVER CONNECT']]) {
    assert.ok(code.includes(`zoneHead('${t}', '${m}')`), 'a column is missing its head: ' + t);
  }
  for (const label of ['进入本地服务', '加入局域网', '加入服务器', '复制链接', '扫描', '连接', '服务器列表']) {
    assert.ok(code.includes(label), 'a connect entry is missing: ' + label);
  }
  // ② 五格同排 + 同宽（业主：横向排列、同宽、不做大卡片、保持现有按钮风格）
  assert.ok(code.includes('repeat(5,minmax(0,1fr))'), 'the five entries sit in ONE row (5 equal columns)');
  for (const label of ['mod 管理器', '房间列表', '全局设置', '检查更新']) {
    assert.ok(code.includes("'" + label + "'"), 'a function entry is missing: ' + label);
  }
  assert.ok(code.includes("'开始预载'") && code.includes("'停止预载'"), 'the 5th cell is the preload toggle');
  assert.ok(/class="set-apply"/.test(code), 'the row keeps the existing .set-apply button style');
  assert.ok(!code.includes("'外观设置'"), '外观设置 is folded into 全局设置');
  assert.ok(!code.includes("'联机偏好'"), '联机偏好 is folded into 全局设置');
  assert.ok(!code.includes("'服务器列表'"), '服务器列表 is NOT a row entry (it lives in the 加入服务器 column)');
  // ③ 红/黄底色的整片着色必须消失（业主：不加红/绿区域底色）
  for (const gone of ['ZONE_RED', 'ZONE_YELLOW', 'rgba(224,108,90', 'rgba(232,184,74']) {
    assert.ok(!code.includes(gone), 'the old zone tinting came back: ' + gone);
  }
  // ④ 感谢名单跑马灯：从右向左（translateX(-25%) 的 4 份副本）+ 真名单 + 大字/小字
  assert.ok(code.includes('sp-preload__credits'), 'the credits strip exists');
  assert.ok(code.includes('@keyframes sp-preload-marquee'), 'the marquee has its own keyframes');
  assert.ok(code.includes('translate3d(-25%,0,0)'), 'the marquee scrolls right-to-left, seamlessly');
  assert.ok(code.includes('animation:sp-preload-marquee'), 'the track animates');
  assert.ok(code.includes('CREDIT_COPIES'), 'the track is built from identical copies (seamless loop)');
  for (const n of ['纸鸢安好', '水沫沐沐', '剑光卤煮-斩尽牛杂', '雨千代Chiyo']) {
    assert.ok(code.includes(n), 'the real thanks list is missing: ' + n);
  }
  assert.ok(code.includes("CREDITS_PREFIX = 'bilibili_'"), 'the thanks page prefix is carried over');
  assert.ok(code.includes('sp-preload__credit-name') && code.includes('sp-preload__credit-role'),
    '大字 = 名字 / 小字 = 角色备注 (the web page\'s two-line credit idiom)');
  // ⑤ 预载进度条：横向、带百分比、固定在按钮区下方（顺序在感谢名单之后）
  assert.ok(code.includes('sp-preload__bar-fill'), 'the progress bar fill is drawn');
  assert.ok(code.includes("'width:' + pct + '%'"), 'the bar is horizontal (width = percentage)');
  assert.ok(code.includes('sp-preload__state-pct'), 'the percentage read-out');
  assert.ok(code.includes('RESOURCE PRELOAD'), 'the bar keeps its label');
  assert.ok(code.indexOf('sp-preload__zones') < code.indexOf('sp-preload__menu')
    && code.indexOf('sp-preload__menu') < code.indexOf('sp-preload__credits')
    && code.indexOf('sp-preload__credits') < code.indexOf('sp-preload__preload'),
    'the source order is 三框 -> 五按钮 -> 感谢名单 -> 预载进度条');
  // ⑥ 固定窗口 + 不可滚动（业主：固定窗口尺寸，页面不可滚动）
  assert.ok(code.includes('height:calc(88vh - 2.3rem)'), 'the content area has a FIXED height');
  assert.ok(code.includes('overflow:hidden'), 'the panel never scrolls');
  // ⑦ 本机 IP 提示行（业主：进入慢或加载出错时显示当前局域网 IP，优先虚拟局域网）
  assert.ok(code.includes('function lanIpLine()'), 'the local-address line helper');
  assert.ok(code.includes('虚拟局域网 IP'), 'and it prefers the virtual-LAN address');
  assert.ok(code.includes('function hintPreload()'), 'the preload hint helper (进入线路后提示预载)');
  // ⑧ 预载数据行保留（与 mods-panel.test.mjs 的契约同名：stateRow + infoRow('本地可用')）
  assert.ok(code.includes('stateRow'), 'the bar row helper stays named stateRow (shared contract)');
  assert.ok(code.includes("infoRow('本地可用'"), 'line 2 keeps 本地可用');
  assert.equal(code.includes('progressRow'), false, 'the old separate progress row must be gone');
  assert.equal(code.includes("infoRow('状态'"), false, '状态 moved into the bar row');
  assert.equal(code.includes("infoRow('回源缓存'"), false, '回源缓存 folded into line 2');
  assert.equal(code.includes("infoRow('待预载'"), false, '待预载 folded into line 2');
  // the old chip-era entries must not come back
  for (const gone of ['公开大厅', '提交房间', '打开 mod 管理器', '公开房间', '加入房间', '自动匹配', '公开到大厅']) {
    assert.ok(!code.includes('>' + gone + '</button>'), 'removed button came back: ' + gone);
  }
  for (const gone of ['下载速度', '解压速度', '预载速度', '预计剩余']) {
    assert.ok(!code.includes(gone), 'the load-rate line came back: ' + gone);
  }
  // the panel takes 80% of the screen and is hot-updatable (it ships in the overlay slim)
  assert.ok(/width="min\(80vw,34rem\)"/.test(code), 'the panel width rides the Modal width prop (owner: 占全屏80%)');
  // 检查更新 goes through the page-side hot-update panel first (the single interface)
  assert.ok(code.includes("openPanel('update'"), '检查更新 opens the page-side update panel');
  assert.ok(code.includes('checkUpdateQuiet'), 'and starts the quiet native check');
  // the preload logic is untouched: the same window.__SP_PRELOAD API is read/written
  assert.ok(code.includes('window.__SP_PRELOAD'), 'the preload API is still the panel\'s data source');
  assert.ok(code.includes('p.start') && code.includes('p.cancel'), 'the toggle still calls start()/cancel()');
  assert.ok(code.includes('p.state') || code.includes('readState'), 'state() is still read');
});

test('static: this panel ships its own scoped stylesheet (idempotent, .sp-preload-only)', () => {
  assert.ok(SRC.includes("const PANEL_STYLE_ID = 'sp-preload-panel-style'"), 'the sheet has its own id');
  assert.ok(SRC.includes('export function injectPreloadPanelStyles'), 'the injector is exported');
  assert.ok(SRC.includes('document.getElementById(PANEL_STYLE_ID)'), 'injection is idempotent by id');
  assert.ok(SRC.includes('function panelStyleCss()'), 'the CSS lives in one extractable function');
  // 每条选择器都必须以本面板的根类 .sp-preload 开头（比 .sp-ui 更窄，不污染页面与其它面板）
  const m = SRC.match(/function panelStyleCss\(\) \{\n  return \[([\s\S]*?)\n  \]\.join\(''\);/);
  assert.ok(m, 'panelStyleCss() 必须是一行一条的数组字面量（可静态提取）');
  const body = m[1].split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'); // drop the rule comments
  const css = (body.match(/'((?:[^'\\]|\\.)*)'/g) || []).map((s) => s.slice(1, -1)).join('');
  assert.ok(css.length > 0, 'the sheet is not empty');
  const selectors = [];
  for (const s of css.matchAll(/([^{}]+)\{/g)) {
    const sel = s[1].trim();
    if (!sel || sel.startsWith('@')) continue; // media / keyframes prelude lines
    selectors.push(sel);
  }
  assert.ok(selectors.length > 0, 'selectors are parseable');
  for (const sel of selectors) {
    for (const part of sel.split(',')) {
      const s = part.trim();
      if (!s || s.startsWith('from') || s.startsWith('to')) continue; // keyframe steps
      assert.ok(s.startsWith('.sp-preload'), '每条选择器都必须以 .sp-preload 开头：' + s);
    }
  }
});

test('static: shell-bridge injects the panel module with an idempotent guard', () => {
  assert.ok(BRIDGE.includes("'/__sp/ui/preloadPanel.js'"), 'the module is injected from the /__sp/ channel');
  assert.ok(BRIDGE.includes('window.__SP_PRELOAD_PANEL'), 'the injection is guarded by the module marker');
  assert.ok(/pp\.type\s*=\s*'module'/.test(BRIDGE), 'injected as a module (the file is ESM)');
});

test('static: the function list opens by default once per origin (owner 2026-10-11)', () => {
  assert.ok(BRIDGE.includes("s.openPanel('preload')"), 'the bridge opens the function list');
  assert.ok(BRIDGE.includes('sp.menu.opened'), 'the once-per-session marker key');
  assert.ok(BRIDGE.includes('menuAutoOpened') && BRIDGE.includes('markMenuAutoOpened'),
    'the marker is read and written through guarded helpers');
  // a match screen must not be covered by the auto-opened panel
  assert.ok(/\.screen\.brief/.test(BRIDGE) && /\.screen\.draft/.test(BRIDGE),
    'the auto-open stands down on the game\'s own screen marks');
});

test('static: preload-center open()/close() drive the shell panel host and build no DOM', () => {
  assert.ok(/s\.openPanel\('preload'\)/.test(PRELOAD_CENTER), "open() calls openPanel('preload')");
  assert.ok(/s\.openPanel\(null\)/.test(PRELOAD_CENTER), 'close() calls openPanel(null)');
  assert.ok(!PRELOAD_CENTER.includes('document.body.appendChild'), 'the hand-written modal DOM is gone');
  assert.ok(!PRELOAD_CENTER.includes('function updateUI'), 'the DOM repaint is gone');
});
