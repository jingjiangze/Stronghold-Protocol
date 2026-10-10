// preloadPanel tests: the preload panel is now a Preact component (ui/preloadPanel.js), registered
// as kind 'preload' into ui/shellPanels.js' add-on registry -- the same dynamic-import + registerPanel
// pattern lobby.js uses. These cases render the REAL component against a minimal htm/h shim and assert
// the layered layout, the numbers it draws from window.__SP_PRELOAD, the owner's 2026-10-10 contract
// (first-level buttons are exactly 公开大厅 / 提交房间 / 外观设置 / 检查更新; the load-rate lines are
// gone -- numbers only, progress bar inside the panel) and the "never a dead click" rule (检查更新
// falls back to the shell-bridge wrapper and, with neither entry present, still gives visible
// feedback). The data/state logic itself stays in preload-center.js and is covered by
// preload-center.test.mjs.
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
// CI runs this suite BEFORE build-webroot, so the upstream tree (repo-root public/) may not exist
// yet. The render cases below need its vendor/htm.module.js; without it they skip instead of dying
// at import time (same convention as art-packs.test.mjs:421). The static cases still run.
const UPSTREAM_VENDOR = path.join(here, '..', '..', 'public', 'vendor', 'htm.module.js');
const HTM = fs.existsSync(UPSTREAM_VENDOR) ? fs.readFileSync(UPSTREAM_VENDOR, 'utf8') : '';
const needsUpstream = (name, fn) => test(name, (t) =>
  (HTM ? fn(t) : t.skip('upstream public/ not built yet (run build-webroot)')));

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

/** The buttons the real page sees with `document.querySelectorAll('.set-row button')`: every button
 *  inside a .set-row container, in tree order (modal-footer buttons are NOT in a .set-row). */
function collectRowButtons(node, out) {
  out = out || [];
  const n = resolve(node);
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const c of n) collectRowButtons(c, out); return out; }
  if (n.type === 'div' && n.props && n.props.class === 'set-row') { collectButtons(n, out); return out; }
  if (n.children) collectRowButtons(n.children, out);
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

needsUpstream('two labelled layers render (预载进度 / 快捷入口) and the old speed layer is gone', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const { text } = renderPanel(comp, stateFixture(), undefined);
    assert.ok(text.includes('预载进度'), 'layer 1 title: ' + text);
    assert.ok(text.includes('快捷入口'), 'layer 2 title');
    assert.ok(text.includes('资源预载与离线缓存中心'), 'the panel title');
    assert.ok(text.includes('完成'), 'the close action');
    assert.ok(!text.includes('进度与速度'), 'the speed layer title is gone (owner 2026-10-10)');
    assert.ok(!text.includes('房间入口'), 'the old lobby-entry row is gone');
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
    assert.equal(findStyled(vnode, 'width:25%').length, 1, 'the progress bar width is 25%');
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

needsUpstream('finished state: no pending line; no rate line in any state; the bar reads 100%', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const done = renderPanel(comp, stateFixture({ phase: 'done', done: 20, total: 20, pending: 0, pack: null }), undefined);
    assert.match(done.text, /资源预载完成/, 'the finished head');
    assert.doesNotMatch(done.text, /待预载/, 'no pending line when finished');
    assert.doesNotMatch(done.text, SPEED_TEXT, 'no speed/ETA line when finished');
    assert.doesNotMatch(done.text, /B\/s/, 'no byte rate anywhere');
    assert.equal(findStyled(done.vnode, 'width:100%').length, 1, 'the finished progress bar is 100%');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('the first-level buttons are exactly the four owner labels and each delegates', async () => {
  const root = mkTree();
  const prevWin = globalThis.window;
  try {
    const comp = await loadPanel(root);
    const calls = { open: 0, toggled: null, updated: 0, panels: [] };
    globalThis.window = {
      __SP_PRELOAD: { state: () => stateFixture() },
      __SP_SHELL: { openPanel: (kind) => calls.panels.push(kind) },
      __SP_LOBBY: {
        open: () => { calls.open++; },
        togglePublic: (code) => { calls.toggled = code; return Promise.resolve({ ok: true }); },
      },
      __SP__: { store: { get: () => ({ room: { code: 'ab12' } }) } },
      shell: { checkUpdate: () => { calls.updated++; } },
    };
    const vnode = comp({ onClose: () => {} });
    assert.deepEqual(collectRowButtons(vnode).map(textOf),
      ['公开大厅', '提交房间', '外观设置', '检查更新'], '一级按钮清单（顺序即展示顺序）');

    buttonByText(vnode, '公开大厅').props.onClick();
    assert.equal(calls.open, 1, '公开大厅 opens the lobby panel');
    buttonByText(vnode, '提交房间').props.onClick();
    assert.equal(calls.toggled, 'AB12', '提交房间 hands the upper-cased current room code to togglePublic');
    assert.deepEqual(calls.panels, [], '提交房间 does not open another panel');
    buttonByText(vnode, '外观设置').props.onClick();
    assert.deepEqual(calls.panels, ['appearance'], '外观设置 opens the appearance panel');
    buttonByText(vnode, '检查更新').props.onClick();
    assert.equal(calls.updated, 1, '检查更新 calls window.shell.checkUpdate()');

    // removed duplicates and long-gone control buttons must not come back
    const labels = collectButtons(vnode).map(textOf);
    for (const gone of ['公开房间', '加入房间', '自动匹配', '公开到大厅', '暂停', '开始预载', '清除本地缓存', '清除回源缓存']) {
      assert.ok(!labels.includes(gone), 'removed button must not return: ' + gone);
    }
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

needsUpstream('外观设置 closes the preload panel first, then opens the appearance panel', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const opened = [];
    const closed = [];
    const prevWin = globalThis.window;
    globalThis.window = {
      __SP_PRELOAD: { state: () => stateFixture() },
      __SP_SHELL: { openPanel: (kind) => opened.push(kind) },
    };
    try {
      const vnode = comp({ onClose: () => closed.push(true) });
      const b = buttonByText(vnode, '外观设置');
      assert.ok(b, '外观设置 button present');
      b.props.onClick();
    } finally { if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin; }
    assert.deepEqual(closed, [true], 'the preload panel closed itself first (z-index)');
    assert.deepEqual(opened, ['appearance'], 'then the appearance panel opened');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('检查更新 prefers window.shell.checkUpdate, falls back to the shell bridge, and is never a dead click', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const prevWin = globalThis.window;
    const calls = { native: 0, wrapper: 0 };
    const click = () => {
      const vnode = comp({ onClose: () => {} });
      const b = buttonByText(vnode, '检查更新');
      assert.ok(b, '检查更新 button present');
      b.props.onClick();
    };
    try {
      // 1) an APK shell with the native entry: window.shell.checkUpdate() wins
      delete globalThis.__spTestToasts;
      globalThis.window = {
        __SP_PRELOAD: { state: () => stateFixture() },
        shell: { checkUpdate: () => { calls.native++; } },
        __SP_SHELL: { checkUpdate: () => { calls.wrapper++; } },
      };
      click();
      assert.equal(calls.native, 1, 'the native shell update entry is used first');
      assert.equal(calls.wrapper, 0, 'the wrapper is not called on top of the native entry');
      assert.deepEqual(globalThis.__spTestToasts, ['已发起检查更新'], 'visible feedback: self-owned toast');

      // 2) an APK too old for the native method / the plain web: shell-bridge's wrapper
      delete globalThis.__spTestToasts;
      globalThis.window = {
        __SP_PRELOAD: { state: () => stateFixture() },
        shell: {},
        __SP_SHELL: { checkUpdate: () => { calls.wrapper++; } },
      };
      click();
      assert.equal(calls.wrapper, 1, 'the shell bridge wrapper is the fallback entry');
      assert.equal(calls.native, 1, 'the native entry is not re-called');
      assert.deepEqual(globalThis.__spTestToasts, ['已发起检查更新'], 'the wrapper path still reports visibly');

      // 3) neither entry: silent degrade (no throw) but still a visible answer
      delete globalThis.__spTestToasts;
      globalThis.window = { __SP_PRELOAD: { state: () => stateFixture() } };
      click();
      assert.deepEqual(globalThis.__spTestToasts, ['当前页面不支持检查更新'], 'no dead click even without any entry');
    } finally { if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin; }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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

test('static: the first-level buttons are exactly the four owner labels; rate lines and duplicates are gone', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  for (const label of ['公开大厅', '提交房间', '外观设置', '检查更新']) {
    assert.ok(code.includes('>' + label + '</button>'), 'first-level button missing: ' + label);
  }
  for (const gone of ['公开房间', '加入房间', '自动匹配', '公开到大厅']) {
    assert.ok(!code.includes('>' + gone + '</button>'), 'removed button came back: ' + gone);
  }
  for (const gone of ['下载速度', '解压速度', '预载速度', '预计剩余']) {
    assert.ok(!code.includes(gone), 'the load-rate line came back: ' + gone);
  }
  assert.ok(code.includes('window.shell') && code.includes('checkUpdate'),
    '检查更新 must call the shell update entry (window.shell.checkUpdate)');
  assert.ok(code.includes('progressRow'), 'the progress bar must stay inside the panel');
});

test('static: shell-bridge injects the panel module with an idempotent guard', () => {
  assert.ok(BRIDGE.includes("'/__sp/ui/preloadPanel.js'"), 'the module is injected from the /__sp/ channel');
  assert.ok(BRIDGE.includes('window.__SP_PRELOAD_PANEL'), 'the injection is guarded by the module marker');
  assert.ok(/pp\.type\s*=\s*'module'/.test(BRIDGE), 'injected as a module (the file is ESM)');
});

test('static: preload-center open()/close() drive the shell panel host and build no DOM', () => {
  assert.ok(/s\.openPanel\('preload'\)/.test(PRELOAD_CENTER), "open() calls openPanel('preload')");
  assert.ok(/s\.openPanel\(null\)/.test(PRELOAD_CENTER), 'close() calls openPanel(null)');
  assert.ok(!PRELOAD_CENTER.includes('document.body.appendChild'), 'the hand-written modal DOM is gone');
  assert.ok(!PRELOAD_CENTER.includes('function updateUI'), 'the DOM repaint is gone');
});
