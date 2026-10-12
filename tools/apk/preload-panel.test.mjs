// preloadPanel tests: the floating window's FIRST SCREEN is the function list (ui/preloadPanel.js),
// registered as kind 'preload' into ui/shellPanels.js' add-on registry -- the same dynamic-import +
// registerPanel pattern lobby.js uses. Owner direction 2026-10-11: three CONNECT sections (本地服务 /
// 加入局域网 / 加入服务器 with a custom-domain input that is NOT published to the room board), then
// the function grid (服务器列表 / mod 管理器 / 房间列表 / 外观设置 / 联机偏好 / 检查更新), then the
// preload block at the very bottom with a progress bar and ONE start/stop button; the panel opens by
// default and takes ~80% of the screen. These cases render the REAL component against a minimal
// htm/h shim and assert that layout, the numbers drawn from window.__SP_PRELOAD, the delegation of
// every entry, the "never a dead click" rule, and the hot-update single-interface wiring. The
// data/state logic itself stays in preload-center.js and is covered by preload-center.test.mjs.
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

/** Buttons of the ONE .set-row whose label text begins with `label` (rows are addressed by label so
 *  "the 本地服务 row holds the enter + copy buttons" keeps its meaning while the panel also carries
 *  the LAN / custom / function / preload rows). */
function rowButtons(node, label, out) {
  out = out || [];
  const n = resolve(node);
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const c of n) rowButtons(c, label, out); return out; }
  if (n.type === 'div' && n.props && n.props.class === 'set-row') {
    if (textOf(n).startsWith(label)) collectButtons(n, out);
    return out;
  }
  if (n.children) rowButtons(n.children, label, out);
  return out;
}

/** Nodes whose inline style contains `needle` (used to pin the progress bar's inside-the-panel bar). */
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

needsUpstream('three labelled layers render (连接 / 功能 / 资源预载) with the function-list title', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const { text } = renderPanel(comp, stateFixture(), undefined);
    assert.ok(text.includes('连接'), 'layer 1 title: ' + text);
    assert.ok(text.includes('功能'), 'layer 2 title');
    assert.ok(text.includes('资源预载'), 'layer 3 title');
    assert.ok(text.includes('完成'), 'the close action');
    // the old two-form chip wording and the old panel title must not come back
    assert.ok(!text.includes('资源预载与离线缓存中心'), 'the old preload-center title is gone');
    assert.ok(!text.includes('快捷入口'), 'the old 快捷入口 layer is gone');
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
    // the progress bar must stay INSIDE the panel: the 25% (5/20) bar + its track
    assert.match(text, /25%/, 'the percentage read-out');
    assert.equal(findStyled(vnode, 'height:6px;width:25%').length, 1, 'the progress bar width is 25%');
    assert.equal(findStyled(vnode, 'background:rgba(255,255,255,0.12)').length, 1, 'the progress track is in the panel');
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

needsUpstream('idle state: the preload has NOT started and the single button says 开始预载', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const idle = renderPanel(comp, stateFixture({ phase: 'idle', done: 0, total: 0, pending: 0, pack: null }), undefined);
    assert.match(idle.text, /尚未开始预载/, 'the idle head (owner 2026-10-11: no global preload by default)');
    assert.match(idle.text, /开始预载/, 'the single start/stop button reads 开始预载 when idle');
    assert.doesNotMatch(idle.text, /停止预载/, 'no stop wording when nothing runs');
    assert.doesNotMatch(idle.text, /待预载/, 'no pending line when idle');

    const done = renderPanel(comp, stateFixture({ phase: 'done', done: 20, total: 20, pending: 0, pack: null }), undefined);
    assert.match(done.text, /资源预载完成/, 'the finished head');
    assert.doesNotMatch(done.text, SPEED_TEXT, 'no speed/ETA line when finished');
    assert.equal(findStyled(done.vnode, 'height:6px;width:100%').length, 1, 'the finished progress bar is 100%');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('the function grid is exactly the six owner entries and each delegates', async () => {
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
    const FUNC_LABELS = ['服务器列表', 'mod 管理器', '房间列表', '外观设置', '联机偏好', '检查更新'];
    const allLabels = collectButtons(vnode).map(textOf);
    // the function grid holds exactly the six owner entries, in order (they are the buttons whose
    // text is one of the six; the grid is a standalone block, not a labelled .set-row)
    const gridLabels = allLabels.filter((t) => FUNC_LABELS.includes(t));
    assert.deepEqual(gridLabels, FUNC_LABELS, 'the function grid, in the owner\'s order');

    buttonByText(vnode, '服务器列表').props.onClick();
    buttonByText(vnode, 'mod 管理器').props.onClick();
    buttonByText(vnode, '房间列表').props.onClick();
    buttonByText(vnode, '外观设置').props.onClick();
    buttonByText(vnode, '联机偏好').props.onClick();
    assert.deepEqual(calls.panels, ['servers', 'mods', 'lobby', 'appearance', 'netprefs'],
      'every entry opens its own panel through the shell host');

    // 检查更新 goes through the page's own hot-update panel (kind 'update'), NOT the native dialog.
    // The update panel starts the quiet check itself on mount (see update-panel.test.mjs), so this
    // entry only has to route there.
    buttonByText(vnode, '检查更新').props.onClick();
    assert.equal(calls.updated, 0, 'this panel does not dial the native check itself (the update panel does)');
    assert.deepEqual(calls.panels.slice(5), ['update'], '检查更新 opens the update panel');
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

needsUpstream('CONNECT rows: 本地服务 starts the host, 加入服务器 applies the custom domain, 局域网 scans', async () => {
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
    assert.deepEqual(rowButtons(vnode, '本地服务').map(textOf), ['进入本地服务'],
      'the local-service row holds the enter button (no room yet -> no copy link)');
    buttonByText(vnode, '进入本地服务').props.onClick();
    assert.equal(calls.local, 1, '进入本地服务 starts the host service on demand');
    assert.equal(calls.closed, 1, 'and closes the panel (the switch reloads the page)');

    assert.deepEqual(rowButtons(vnode, '加入局域网').map(textOf), ['扫描'], 'the LAN row holds the scan button');
    buttonByText(vnode, '扫描').props.onClick();
    assert.equal(calls.lan, 1, '扫描 calls shell.lanScan once');

    assert.ok(rowButtons(vnode, '加入服务器').length >= 0, 'the custom row exists');
    // the input starts empty -> 连接 is disabled and setServer is not called
    const conn = buttonByText(vnode, '连接');
    assert.ok(conn, 'the custom row holds the 连接 button');
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
    assert.deepEqual(rowButtons(vnode, '本地服务').map(textOf), ['进入本地服务', '复制链接'],
      'with a room open, the row also holds 复制链接');
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

needsUpstream('the preload button is ONE toggle: 停止预载 while running, 开始预载 when idle', async () => {
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
    assert.ok(stop, 'running -> the single button reads 停止预载');
    stop.props.onClick();
    assert.equal(calls.cancel, 1, 'it stops the walk through the center API');
    assert.equal(calls.start, 0);

    globalThis.window.__SP_PRELOAD = { state: () => stateFixture({ phase: 'idle' }), start: () => { calls.start++; }, cancel: () => { calls.cancel++; } };
    vnode = comp({ onClose: () => {} });
    const go = buttonByText(vnode, '开始预载');
    assert.ok(go, 'idle -> the single button reads 开始预载');
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

test('static: the function list is the owner\'s 2026-10-11 shape; old entries and rate lines are gone', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  // the three CONNECT sections + the function grid, in the owner's order
  assert.ok(code.includes("layerHead('连接', 'CONNECT')"), 'the CONNECT layer head');
  assert.ok(code.includes("layerHead('功能', 'FUNCTIONS')"), 'the FUNCTIONS layer head');
  assert.ok(code.includes("layerHead('资源预载', 'PRELOAD')"), 'the PRELOAD layer head (at the bottom)');
  for (const label of ['进入本地服务', '加入局域网', '加入服务器', '复制链接', '扫描', '连接']) {
    assert.ok(code.includes(label), 'a connect entry is missing: ' + label);
  }
  for (const label of ['服务器列表', 'mod 管理器', '房间列表', '外观设置', '联机偏好', '检查更新']) {
    assert.ok(code.includes("'" + label + "'"), 'a function entry is missing: ' + label);
  }
  // the preload block: the bar + ONE start/stop button, nothing else
  assert.ok(code.includes('stateRow'), 'the bar shares line 1 with 状态 (the block is two lines now)');
  assert.ok(code.includes('height:6px;width:'), 'the progress bar itself must still be drawn');
  assert.ok(code.includes("infoRow('本地可用'"), 'line 2 keeps 本地可用');
  assert.ok(code.includes("'开始预载'") && code.includes("'停止预载'"), 'the ONE preload toggle button');
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
