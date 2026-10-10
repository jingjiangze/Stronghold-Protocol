// preloadPanel tests: the preload panel is now a Preact component (ui/preloadPanel.js), registered
// as kind 'preload' into ui/shellPanels.js' add-on registry -- the same dynamic-import + registerPanel
// pattern lobby.js uses. These cases render the REAL component against a minimal htm/h shim and assert
// the layered layout, the numbers it draws from window.__SP_PRELOAD, and the "never invent a number"
// rule (no pack bridge -> no unpack line). The data/state logic itself stays in preload-center.js and
// is covered by preload-center.test.mjs.
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
// MicroLabel / hooks from it, never from the page's js/ui/components.js.
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

/** The state shape window.__SP_PRELOAD.state() returns (preload-center.js diag()). */
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

/** Render the panel with the given state/shell, returning { vnode, text, onCloseCalls }. */
function renderPanel(comp, state, shell) {
  const prevWin = globalThis.window;
  const onCloseCalls = [];
  globalThis.window = { __SP_PRELOAD: { state: () => state }, __SP_SHELL: shell };
  try {
    const vnode = comp({ onClose: () => onCloseCalls.push(true) });
    return { vnode, text: textOf(vnode), onCloseCalls };
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
  }
}

// ---------------------------------------------------------------- cases

needsUpstream('three labelled layers render (进度与速度 / 大厅 / 设置)', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const { text } = renderPanel(comp, stateFixture(), undefined);
    assert.ok(text.includes('进度与速度'), 'layer 1 title: ' + text);
    assert.ok(text.includes('大厅'), 'layer 2 title');
    assert.ok(text.includes('设置'), 'layer 3 title');
    assert.ok(text.includes('资源预载与离线缓存中心'), 'the panel title');
    assert.ok(text.includes('完成'), 'the close action');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('draws the progress + speed lines from window.__SP_PRELOAD.state()', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const { text } = renderPanel(comp, stateFixture(), undefined);
    assert.match(text, /本地可用/, 'local-available label');
    assert.match(text, /5 \/ 20/, 'local-available count');
    assert.match(text, /回源缓存/, 'the Android cache label (store=android)');
    assert.match(text, /1\.0 MB/, 'the Android byte figure');
    assert.match(text, /待预载/, 'pending label');
    assert.match(text, /15/, 'pending count');
    assert.match(text, /下载速度：2\.0 MB\/s（平均 1\.0 MB\/s）/, 'walk byte rate');
    assert.match(text, /包通道 1\.0 MB\/s/, 'the pack channel names its own rate');
    assert.match(text, /解压速度：3\.0 MB\/s（包通道 2\/4）/, 'unpack speed + pack progress');
    assert.match(text, /预载速度：4\.0 文件\/秒（平均 3\.0 文件\/秒）/, 'files/s rate');
    assert.match(text, /预计剩余：1 分 00 秒（已用 20 秒）/, 'ETA + elapsed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('no artSyncBridge -> no unpack line and no pack-channel figure (never a fabricated number)', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    // A cache bridge only (an OLD APK): artCacheStatus exists, artSyncStatus does not.
    const shell = {
      artCacheBridge: true,
      artCacheStatus: () => JSON.stringify({ ok: true, manifestHash: 'h', cachedFiles: 0, cachedBytes: 0, cacheRoot: 'art/cache/h', pending: -1 }),
    };
    const state = stateFixture({ pack: null, bytes: 0 }); // preload-center folds the missing bridge to null
    const { text } = renderPanel(comp, state, shell);
    assert.match(text, /回源缓存/, 'the cache bridge still reports honestly');
    assert.match(text, /0\.0 MB/, 'the bridge 0 is drawn, not a fabricated rate');
    assert.match(text, /下载速度：2\.0 MB\/s/, 'the walk rate still renders');
    assert.doesNotMatch(text, /解压速度/, 'no unpack line without artSyncStatus');
    assert.doesNotMatch(text, /包通道/, 'no pack-channel figure without artSyncStatus');
    assert.doesNotMatch(text, /0 B\/s/, 'no invented zero byte rate');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('a live artSyncStatus bridge renders the unpack line (the capability gate is real)', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const shell = {
      artSyncBridge: true,
      artSyncStatus: () => JSON.stringify({
        ok: true, active: true, stage: 'unzip', pack: 'p', packsDone: 1, packsTotal: 2,
        bytesDone: 1, bytesTotal: 2, dlBps: 1048576, unzipBps: 2097152, etaMs: 30000,
      }),
    };
    const { text } = renderPanel(comp, stateFixture({ pack: null }), shell);
    assert.match(text, /解压速度：2\.0 MB\/s（包通道 1\/2）/, 'the bridge reading is drawn: ' + text);
    assert.match(text, /包通道 1\.0 MB\/s/, 'the pack download rate is drawn');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('finished state: no pending line; running state: no fabricated zero', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const done = renderPanel(comp, stateFixture({ phase: 'done', done: 20, total: 20, pending: 0, rates: { bytesKnown: false, bps: 0, avgBps: 0, filesPerSec: 0, avgFilesPerSec: 0, etaMs: 0, elapsedMs: 0 }, pack: null }), undefined);
    assert.match(done.text, /资源预载完成/, 'the finished head');
    assert.doesNotMatch(done.text, /待预载/, 'no pending line when finished');
    assert.doesNotMatch(done.text, /B\/s/, 'no byte rate without a known size');
    assert.doesNotMatch(done.text, /预计剩余/, 'no ETA when nothing is live');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('the lobby + settings entries exist and delegate (no pause/start/clear buttons)', async () => {
  const root = mkTree();
  const prevLobby = globalThis.window && globalThis.window.__SP_LOBBY;
  try {
    const comp = await loadPanel(root);
    const calls = { open: 0, toggled: null };
    globalThis.window = {
      __SP_PRELOAD: { state: () => stateFixture() },
      __SP_SHELL: { openPanel: () => {} },
      __SP_LOBBY: { open: () => { calls.open++; }, togglePublic: (code) => { calls.toggled = code; return Promise.resolve({ ok: true }); } },
      __SP__: { store: { get: () => ({ room: { code: 'ab12' } }) } },
    };
    const vnode = comp({ onClose: () => {} });
    // first three delegate to the lobby panel's open()
    for (const label of ['公开房间', '加入房间', '自动匹配']) {
      const b = buttonByText(vnode, label);
      assert.ok(b, 'button present: ' + label);
      b.props.onClick();
    }
    assert.equal(calls.open, 3, 'each of the first three opens the lobby panel');
    // the fourth is a direct action: read the current room code, call togglePublic
    const pub = buttonByText(vnode, '公开到大厅');
    assert.ok(pub, '公开到大厅 present');
    pub.props.onClick();
    assert.equal(calls.toggled, 'AB12', 'the current room code is upper-cased and handed to togglePublic');
    // removed actions must not come back
    const labels = collectButtons(vnode).map((b) => textOf(b));
    for (const gone of ['暂停', '开始预载', '清除本地缓存', '清除回源缓存']) {
      assert.ok(!labels.includes(gone), 'removed button must not return: ' + gone);
    }
  } finally {
    if (prevLobby === undefined) { try { delete globalThis.window.__SP_LOBBY; } catch (e) { /* ignore */ } }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

needsUpstream('设置 closes the preload panel first, then opens the appearance panel', async () => {
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
