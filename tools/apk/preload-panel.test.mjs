// preloadPanel tests: the floating window's screen (ui/preloadPanel.js), registered as kind 'preload'
// into ui/shellPanels.js' add-on registry -- the same dynamic-import + registerPanel pattern lobby.js
// uses.
//
// Owner direction 2026-10-13 (branch ui/redraw-function-panel) -- THIS revision:
//   · the window LOST its whole connect block: 「本地服务 / 加入局域网 / 加入服务器」 and every control
//     inside them (进入本地服务 / 房号 / 复制链接 / 扫描 + 房间列表 / 服务器地址输入 + 连接 +
//     服务器列表 / 本机虚拟局域网 IP / 自定义地址只在本机连接…) -- owner: 「里面的悬浮窗界面去掉
//     「本地服务 / 加入局域网 / 加入服务器」和里面的（…）」. The bodies were MOVED to
//     ui/connect-core.js and the entries now live on the full-screen first interface
//     (js/first-screen.js) -- those behaviours are covered by tools/apk/first-screen.test.mjs, and the
//     cases below assert they are GONE from this window (no zone grid, no connect control, no string).
//   · 「房间列表」 is gone from the menu row: FIVE entries -> FOUR (mod 管理器 / 全局设置 / 检查更新 /
//     开始预载).
//   · what is left is THREE bands of equal height (owner: 「不可滚动、三处 height 相等（无滚动条）」):
//     FUNCTIONS / 感谢名单 / RESOURCE PRELOAD, hard corners, mint accents, the reference tokens.
//   · the thanks list data moved to ui/credits.js (ONE source for this runner and the first
//     interface's horizontal one) -- the "real names, no invention" cases below still pin the data.
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
const CREDITS_SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'credits.js'), 'utf8');
const CONNECT_SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'connect-core.js'), 'utf8');
const FIRSTSCREEN_SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'first-screen.js'), 'utf8');
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
  // the panel's two static siblings (same directory, same delivery unit): the credits data + the
  // connect core. Copied verbatim so the render cases run against the REAL data (real names).
  w('public/js/ui/credits.js', CREDITS_SRC);
  w('public/js/ui/connect-core.js', CONNECT_SRC);
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

/** The panel's THREE bands (data-band="menu" | "credits" | "preload"), addressed by their own marker.
 *  They are `flex:1 1 0` siblings, so their heights are equal by construction (owner 2026-10-13:
 *  「三处 height 相等（无滚动条）」) -- the shot driver measures that on the live DOM. */
function band(node, name) {
  return findByClass(node, 'sp-preload__band').find((b) => (b.props && b.props['data-band']) === name) || null;
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
  return renderPanelWith(comp, state, { __SP_SHELL: shell });
}

/** Same, with extra window fields (2026-10-20: a fake `window.shell` drives the LOCAL/REMOTE split). */
function renderPanelWith(comp, state, extra) {
  const prevWin = globalThis.window;
  const onCloseCalls = [];
  delete globalThis.__spTestToasts;
  globalThis.window = Object.assign({ __SP_PRELOAD: { state: () => state } }, extra || {});
  try {
    const vnode = comp({ onClose: () => onCloseCalls.push(true) });
    return { vnode, text: textOf(vnode), toasts: globalThis.__spTestToasts, onCloseCalls };
  } finally {
    delete globalThis.__spTestToasts;
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
  }
}

/** A fake App bridge that says "this is the device's own Node service". */
function localShell() {
  return { localServiceReady: () => '1', currentServerId: () => 'sp-phone-host',
    hostAddresses: () => '{"zt":"http://10.9.8.7:3000","lan":"http://192.168.1.9:3000"}',
    copyText: () => {}, joinOnOrigin: () => true };
}

// ---------------------------------------------------------------- cases

needsUpstream('the owner 2026-10-13 shape renders: 4 entries + credits + preload bar, NO connect block', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const { vnode, text } = renderPanel(comp, stateFixture(), undefined);
    // 三个等高的带（业主：「三处 height 相等」）：FUNCTIONS / 房间 / RESOURCE PRELOAD
    // （感谢名单已按业主要求搬到全屏第一界面，这一带换成内联的房间列表。）
    assert.equal(findByClass(vnode, 'sp-preload__band').length, 4, 'exactly four bands (menu / rooms / list / preload)');
    for (const name of ['menu', 'rooms', 'preload']) {
      assert.ok(band(vnode, name), 'a band is missing: ' + name);
    }
    // 三条连接入口整块消失（业主 2026-10-13）——没有任何竖框、没有连接控件
    assert.equal(findByClass(vnode, 'sp-preload__zones').length, 0, 'the three connect columns are GONE');
    assert.equal(findByClass(vnode, 'sp-preload__zone').length, 0, 'no connect column at all');
    assert.equal(findByClass(vnode, 'sp-preload__zone-title').length, 0, 'no column titles');
    // 业主 2026-10-15：面板里那两列服务器网格已删（清单只在第一界面）—— 但三颗等宽按钮仍在。
    assert.equal(findByClass(vnode, 'sp-preload__srv-rows').length, 0,
      '面板里不再有服务器清单容器（那份清单搬到第一界面了）');
    const _btnRow = findByClass(vnode, 'sp-preload__btns')[0];
    assert.ok(_btnRow, '三个按钮同一行');
    assert.deepEqual(findByClass(_btnRow, 'sp-preload__scan').map(textOf), ['匹配', '加入服务器', '加入房间'],
      '三个按钮等宽、同一行，加入房间最右');
    assert.equal(findByClass(vnode, 'sp-preload__input').length, 0, 'the server-address input is GONE from the window');
    // 注：「扫描」这轮**回到**面板（业主：房间直接列在叠加界面里），所以不在此列 ——
    // 但它只是房间带里的一个按钮，行为本体委托 ui/connect-core.js（见「委托而非自建」那条例）。
    for (const gone of ['本地服务', '加入局域网', 'LOCAL SERVICE', 'LAN DISCOVERY', 'SERVER CONNECT',
    // 2026-10-14 业主口径反转：面板要两列服务器清单 + 「加入服务器」按钮（现在是**要求有的**）。
      '进入本地服务', '连接', '服务器列表', '复制链接', '输入服务器地址', '同一 Wi-Fi',
      '自定义地址只在本机连接', '本机虚拟局域网 IP', 'AB12']) {
      assert.ok(!text.includes(gone), 'a removed connect control is still drawn: ' + gone);
    }
    // 业主 2026-10-13：右下角「完成」主按钮同样不在（它在上一轮已去掉）
    assert.equal(buttonByText(vnode, '完成'), null, 'the 完成 primary action is gone');
    assert.equal(findByClass(vnode, 'btn').length, 0, 'no footer action button is rendered at all');
    // 旧结构（红/黄两区 + 分层标题）不许回来；FUNCTIONS 只是第 1 带的 micro 标签
    assert.ok(!text.includes('进入游戏'), 'the old red-zone head 进入游戏 is gone');
    assert.ok(text.includes('FUNCTIONS'), 'band 1 carries its own micro label');
    assert.ok(!text.includes('快捷入口'), 'the old 快捷入口 layer is gone');
    assert.ok(!text.includes('资源预载与离线缓存中心'), 'the old preload-center title is gone');
    assert.ok(!/rgba\(224,108,90|rgba\(232,184,74/.test(SRC), 'no red/amber zone tinting');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('four function buttons sit in ONE row (本地: MOD 管理器 / 远程: 插件工作室)', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const state = stateFixture({ phase: 'idle', done: 0, total: 0, pending: 0, pack: null });
    // 远程（没有 window.shell ⇒ isLocalService() 为假）：/mod 由本机 Node 服务应答，在远程服务器上
    // 这一格会把玩家导航到没人监听的 127.0.0.1 ⇒ 换成当前 origin 的插件工作室。
    {
      const { vnode } = renderPanel(comp, state, undefined);
      const rows = findByClass(vnode, 'sp-preload__menu');
      assert.equal(rows.length, 1, 'the four entries live in ONE menu row');
      assert.deepEqual(collectButtons(rows[0]).map(textOf),
        ['插件工作室', '全局设置', '检查更新', '返回首页'],
        'remote: the first cell is the SERVER\'s own studio (a /mod link here is a dead end)');
      assert.ok(!textOf(vnode).includes('房间列表'), 'the 房间列表 entry is gone from the window');
    }
    // 本地：第一格必须是 /mod（业主 2026-10-19「本机内置的浏览器和 forge 改为 MOD 管理器」）
    {
      const { vnode } = renderPanelWith(comp, state, { shell: localShell() });
      assert.deepEqual(collectButtons(findByClass(vnode, 'sp-preload__menu')[0]).map(textOf),
        ['MOD 管理器', '全局设置', '检查更新', '返回首页'], 'local: the first cell is /mod');
    }
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

needsUpstream('the order is 四格功能 -> 感谢名单 -> 预载进度条 (owner 2026-10-13: three equal bands)', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const { vnode } = renderPanel(comp, stateFixture(), undefined);
    const body = findByClass(vnode, 'sp-preload')[0];
    assert.ok(body, 'the panel root renders');
    // the three bands are siblings in ONE flex column: assert their DOM order (and that each band
    // carries its own block, so the order cannot be satisfied by empty markers)
    const kids = (body.children || []).filter((c) => c && c.props && typeof c.props.class === 'string');
    const order = kids.map((c) => classesOf(c).join(' '));
    // 四块：顶部通栏按钮 + 两列网格（网格里是 rooms/list/preload 三块）。
    assert.equal(kids.length, 2, 'the panel draws the menu band + the two-column grid');
    assert.equal(findByClass(vnode, 'sp-preload__grid').length, 1, 'and the grid wraps the other three blocks');
    assert.ok(order.some((c) => c.includes('sp-preload__band')) && order.some((c) => c.includes('sp-preload__grid')), 'one band (menu) + the grid');
    // 四块里的 rooms/list/preload 现在嵌在网格里，所以按标记全量取，而不是只看直接子元素。
    const names = findByClass(vnode, 'sp-preload__band').map((c) => c.props['data-band']);
    assert.deepEqual(names, ['menu', 'rooms', 'list', 'preload'], 'the band order is 功能 -> 匹配 -> 房间列表 -> 预载');
    assert.ok(band(vnode, 'menu') && findByClass(band(vnode, 'menu'), 'sp-preload__menu').length === 1,
      'band 1 holds the function row');
    // 业主 2026-10-15：面板里的两列服务器网格已删（那份清单只在第一界面）⇒ band 2 只剩三颗等宽按钮。
    assert.ok(band(vnode, 'rooms') && findByClass(band(vnode, 'rooms'), 'sp-preload__btns').length === 1,
      'band 2 holds the three equal-width buttons');
    assert.equal(findByClass(band(vnode, 'rooms'), 'sp-preload__srv-rows').length, 0,
      'and no server grid any more (it lives on the first interface)');
    assert.ok(band(vnode, 'preload') && findByClass(band(vnode, 'preload'), 'sp-preload__preload').length === 1,
      'band 3 holds the preload block');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('感谢名单已从浮窗移除，改为内联的房间列表（业主 2026-10-13）', async () => {
  const root = mkTree();
  try {
    const comp = await loadPanel(root);
    const { vnode } = renderPanel(comp, stateFixture(), undefined);
    assert.equal(findByClass(vnode, 'sp-preload__roll').length, 0, 'the credits marquee is GONE from the window');
    assert.equal(findByClass(vnode, 'sp-preload__credits').length, 0, 'no credits band at all');
    const roomBand = band(vnode, 'rooms');
    assert.ok(roomBand, 'the rooms band took its place');
    const text = textOf(roomBand);
    // 业主 2026-10-15：「右边需要是房间列表」⇒ 这一带画的是**大厅房间牌**（window.__SP_LOBBY.rooms()），
    // 不再是局域网房间（面板早就不扫了，那一列永远是空的）。加入走 lobby.js 的 joinRoom 同一实现。
    // 房间带 = data-band="list"（"rooms" 那一带是左侧 MATCH 按钮带）。
    const listBand = band(vnode, 'list');
    assert.ok(listBand, 'the ROOMS band is there');
    assert.equal(findByClass(listBand, 'sp-preload__rooms-rows').length, 1, 'the board list container is there');
    assert.ok(!text.includes('扫描'), '面板不再自己扫（扫描按钮与功能都已删）');
    // 名单**不在**本面板（业主：去掉感谢名单；真源搬去 first-screen.js 画）
    for (const n of ['纸鸢安好', '水沫沐沐', 'jingjiangze', '剑光卤煮-斩尽牛杂', '不知名信箱', '雨千代Chiyo', '伊佐那邪_']) {
      assert.ok(!text.includes(n), 'a thanks-list name is still drawn in the window: ' + n);
    }
    for (const w of ['bilibili_', '项目发起人', 'Mod管理器作者', '感谢名单', 'THANKS LIST']) {
      assert.ok(!text.includes(w), 'the credits strip is still drawn in the window: ' + w);
    }
    assert.equal(findByClass(vnode, 'sp-preload__credit-name--lead').length, 0, 'no credits nodes at all');
    assert.equal(findByClass(vnode, 'sp-preload__roll').length, 0, 'and no marquee track');
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
    assert.match(idle.text, /返回首页/, 'the 4th cell is 返回首页 (业主 2026-10-15)');
    // 「尚未开始预载」这句状态文案里天然含「开始预载」四个字，所以这里按**按钮标签**判，不按正文。
    const idleMenu = findByClass(idle.vnode, 'sp-preload__menu')[0];
    const idleLabels = collectButtons(idleMenu).map(textOf);
    assert.ok(!idleLabels.includes('开始预载') && !idleLabels.includes('停止预载'),
      '面板不再有预载开关（进入线路即自动开跑）');
    assert.doesNotMatch(idle.text, /待预载/, 'no pending line when idle');

    const done = renderPanel(comp, stateFixture({ phase: 'done', done: 20, total: 20, pending: 0, pack: null }), undefined);
    assert.match(done.text, /资源预载完成/, 'the finished head');
    assert.doesNotMatch(done.text, SPEED_TEXT, 'no speed/ETA line when finished');
    const fill = findByClass(done.vnode, 'sp-preload__bar-fill')[0];
    assert.ok(String(fill.props.style).includes('width:100%'), 'the finished bar is 100%: ' + fill.props.style);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

needsUpstream('the four entries each delegate (mod 管理器 / 全局设置 / 检查更新 / 返回首页)', async () => {
  const root = mkTree();
  const prevWin = globalThis.window;
  try {
    const comp = await loadPanel(root);
    const calls = { panels: [], updated: 0, nav: [] };
    // 2026-10-20：这里的 window.shell 必须**表明自己是本机服务**，否则面板走远程分支（首格是
    // 「插件工作室」）—— 而这条用例钉的正是本机那一格。
    globalThis.window = {
      __SP_PRELOAD: { state: () => stateFixture({ phase: 'idle', done: 0, total: 0, pending: 0 }), start: () => {}, cancel: () => {} },
      __SP_SHELL: { openPanel: (kind) => calls.panels.push(kind) },
      location: { get href() { return ''; }, set href(v) { calls.nav.push(v); } },
      shell: Object.assign({ checkUpdateQuiet: () => { calls.updated++; } }, localShell()),
    };
    const vnode = comp({ onClose: () => {} });
    // 业主 2026-10-13：四格同排（房间列表去掉）；「服务器列表」也不在窗内（它跟着「加入线上」搬去了
    // 全屏第一界面 —— 见 first-screen.test.mjs）。
    const FUNC_LABELS = ['MOD 管理器', '全局设置', '检查更新'];
    const row = findByClass(vnode, 'sp-preload__menu')[0];
    const rowLabels = collectButtons(row).map(textOf);
    assert.deepEqual(rowLabels, FUNC_LABELS.concat(['返回首页']), 'the function row, in the owner\'s order');

    // 2026-10-19 业主：「forge 改为 MOD 管理器」—— 第一格直接导航到本机 /mod 管理页（不开旧 mod 面板）。
    buttonByText(vnode, 'MOD 管理器').props.onClick();
    buttonByText(vnode, '全局设置').props.onClick();
    assert.deepEqual(calls.nav, ['/mod'], 'MOD 管理器 opens the /mod manager page');
    assert.deepEqual(calls.panels, ['settings'],
      'only 全局设置 opens a shell panel (MOD 管理器 is a page, 房间列表 is gone)');

    // 检查更新 goes through the page's own hot-update panel (kind 'update'), NOT the native dialog.
    // The update panel starts the quiet check itself on mount (see update-panel.test.mjs), so this
    // entry only has to route there.
    buttonByText(vnode, '检查更新').props.onClick();
    assert.equal(calls.updated, 0, 'this panel does not dial the native check itself (the update panel does)');
    assert.deepEqual(calls.panels.slice(1), ['update'], '检查更新 opens the update panel');
    // 每条出路都先关本窗口（openPanel(kind, onClose) 的第一个动作）——接线没变
    assert.ok(globalThis.window.__SP_SHELL.openPanel, 'the panel host is the delegate');
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

needsUpstream('the connect block is GONE from the window and its bodies live in ui/connect-core.js', async () => {
  const root = mkTree();
  const prevWin = globalThis.window;
  try {
    const comp = await loadPanel(root);
    // 一个真桥在场也没用：窗内不再有任何连接控件可点（旧版这里是 startLocal/scanLan/joinCustom）
    const calls = { local: 0, setServer: [], lan: 0, joined: [] };
    globalThis.window = {
      __SP_PRELOAD: { state: () => stateFixture() },
      __SP__: { store: { get: () => ({ room: { code: 'ab12' } }) } },
      __SP_LAN: { begin: () => {}, onScan: () => {} },
      shell: {
        startLocalService: () => { calls.local++; },
        setServer: (t) => { calls.setServer.push(t); },
        lanScan: () => { calls.lan++; return '1'; },
        joinOnOrigin: (id, code) => { calls.joined.push([id, code]); return true; },
        hostAddresses: () => JSON.stringify({ zt: 'http://10.244.0.5:3000' }),
        copyText: () => {},
      },
    };
    const vnode = comp({ onClose: () => {} });
    const labels = collectButtons(vnode).map(textOf);
    // 「房间列表」按钮已删（业主），改成内联列出——所以按钮里不该再有它。
    // 「扫描」按业主这轮要求**回到**面板（房间带里），所以不再列入禁列表。
    for (const gone of ['进入本地服务', '复制链接', '连接', '服务器列表', '房间列表']) {
      assert.ok(!labels.includes(gone), 'the window no longer offers: ' + gone);
    }
    assert.equal(calls.local + calls.setServer.length + calls.lan + calls.joined.length, 0,
      'nothing the window can click touches the connect bridge');
    // 行为本体在 connect-core.js（同一份实现，只有全屏第一界面在画它）——出处锚点
    for (const fn of ['export function startLocal', 'export function scanLan', 'export function joinLan',
      'export function joinCustom', 'export function copyRoomLink', 'export function lanIpLine',
      'export function autoPreload', 'export function openPanel']) {
      assert.ok(CONNECT_SRC.includes(fn), 'connect-core.js is missing: ' + fn);
    }
    assert.ok(!SRC.includes('function startLocal') && !SRC.includes('function joinCustom')
      && !SRC.includes('function joinLan') && !SRC.includes('function lanIpLine')
      && !SRC.includes('function hintPreload') && !SRC.includes('function autoPreload')
      && !SRC.includes('function openPanel'),
      'the window must not keep a second copy of the connect bodies');
    assert.ok(FIRSTSCREEN_SRC.includes("from './ui/connect-core.js'"), 'the first interface draws them');
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- moved cases (2026-10-13)
// The two cases that used to live here -- "connect columns: 本地服务 starts the host, 加入服务器
// applies the custom domain, 局域网 scans" and "复制链接 uses the VPN address first, then the LAN
// address" -- moved to tools/apk/first-screen.test.mjs TOGETHER WITH THE CODE THEY PIN: the bodies are
// now ui/connect-core.js and the only UI that draws them is js/first-screen.js. The assertions
// themselves were kept (startLocal -> startLocalService + close + 预载提示; scanLan -> shell.lanScan;
// joinCustom -> setServer('custom:…') and never on an empty address; joinLan -> joinOnOrigin('lan:ip:port');
// copyRoomLink -> zt before lan, trailing slash folded, nothing copied without an address), so no
// meaningful assertion was dropped in the move -- only its address changed.

needsUpstream('the 4th cell is 返回首页: it closes the window and re-opens the full-screen first interface', async () => {
  const root = mkTree();
  const prevWin = globalThis.window;
  try {
    const comp = await loadPanel(root);
    const calls = { home: 0, closed: 0, started: 0 };
    globalThis.window = {
      __SP_PRELOAD: { state: () => stateFixture({ phase: 'running' }), start: () => { calls.started++; } },
      __SP_FIRST: { open: () => { calls.home++; return true; } },
    };
    const vnode = comp({ onClose: () => { calls.closed++; } });
    const home = buttonByText(vnode, '返回首页');
    assert.ok(home, 'the 4th cell reads 返回首页');
    assert.ok(!classesOf(home).includes('is-on'), 'no is-on state any more (there is nothing to toggle)');
    home.props.onClick();
    assert.equal(calls.closed, 1, 'it closes THIS window first (the first screen paints below the panel host)');
    assert.equal(calls.home, 1, 'and opens the full-screen first interface');
    assert.equal(calls.started, 0, '预载不再由面板启动（进入线路时 connect-core.autoPreload 已开跑）');

    // 旧树（没有全屏首页层）：如实说一句，绝不死点击
    globalThis.window = { __SP_PRELOAD: { state: () => stateFixture({ phase: 'idle' }) } };
    const vnode2 = comp({ onClose: () => {} });
    buttonByText(vnode2, '返回首页').props.onClick();
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
    buttonByText(vnode, '检查更新').props.onClick();
    assert.ok(globalThis.__spTestToasts.length >= 1, 'the missing capability reports visibly');
    // 三条连接入口的「不白点」判据随代码搬到了 first-screen.test.mjs（窗内已经没有任何连接控件）
    assert.equal(buttonByText(vnode, '进入本地服务'), null, 'the connect entries are not in the window any more');
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
  // Static imports are limited to the dependency-free SIBLINGS in this same directory (the same
  // delivery unit, /__sp/ui/). 感谢名单搬到全屏第一界面后 credits.js 不再被本面板引用，只剩
  // connect-core.js（扫描/加入的同一份实现）。Every shell module -- the kit, shellPanels, the
  // page's own js/** -- stays a dynamic import, so a page without them still renders.
  // 2026-10-14: the import list wraps onto a second line now -- match across it.
  const staticImports = [...SRC.matchAll(/import[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(staticImports, ['./connect-core.js'],
    'only the connect core is a static import (the credits data moved to the first interface)');
  assert.ok(SRC.includes("await import('./overlayKit.js')"), 'the UI kit stays a dynamic import');
  assert.ok(SRC.includes("'../../js/ui/shellPanels.js'"), 'registers through the local shellPanels module');
  assert.ok(SRC.includes("'./shellPanels.js'"), 'and through the /__sp/ sibling (server pages)');
});

test('static: the owner 2026-10-13 shape (three equal bands, 4-in-a-row, no connect block, hard corners)', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  // ① 三条连接入口整块不在源码里（业主：去掉「本地服务 / 加入局域网 / 加入服务器」和里面的（…））
  assert.ok(!code.includes('sp-preload__zones') && !code.includes('sp-preload__zone'),
    'the connect-column block is gone from the source');
  assert.ok(!code.includes('zoneHead'), 'the column-head helper is gone');
  for (const gone of ['进入本地服务', '加入局域网', 'LOCAL SERVICE', 'LAN DISCOVERY', 'SERVER CONNECT',
    '复制链接', '服务器列表', '输入服务器地址', '同一 Wi-Fi', '自定义地址只在本机连接', '本机虚拟局域网 IP',
    'lanIpLine', 'hintPreload', 'copyLink', 'joinCustom', 'startLocal']) {
    assert.ok(!code.includes(gone), 'a moved/removed connect control came back: ' + gone);
  }
  // 扫描与**加入**局域网这轮回到面板（业主：房间直接列在叠加界面里），但必须**只委托**：
  // 面板不许再定义一份自己的实现 —— 定义式（export function / function 开头）一律不许出现。
  for (const own of ['scanLan', 'joinLan', 'isLocalService', 'onLanScan']) {
    assert.ok(!new RegExp('(export\\s+)?function\\s+' + own + '\\b').test(code),
      'the window must not define its own ' + own + ' -- delegate to connect-core.js');
  }
  assert.ok(code.includes("from './connect-core.js'"), 'it delegates to the shared connect core');
  assert.ok(!code.includes("'AB12'"), 'the room-code sample is gone');
  // ② 各带（业主 2026-10-13 第九轮改口径：面板「太空了」⇒ **按内容收紧**，不再三等分死高；
  //    面板高度 auto，由 .modal__body 的 max-height 兜底）。
  //    2026-10-20：本地 / 远程两套 —— 远程 rooms+list，本地 data-band="local"（互斥分支）。
  assert.equal((code.match(/class="sp-preload__band" data-band=/g) || []).length, 5,
    'five band markers: menu + local (本地联机) + rooms + list + preload');
  assert.ok(/\.sp-preload__band\{[^}]*flex:0 0 auto/.test(code),
    'the bands size to their content (no dead space)');
  assert.ok(/\.sp-preload\{[^}]*height:auto/.test(code), 'and the panel hugs its content');
  for (const b of ['"menu"', '"local"', '"rooms"', '"list"', '"preload"']) {
    assert.ok(code.includes('data-band=' + b), 'a band marker is missing: ' + b);
  }
  // ③ 四格同排 + 同宽（业主：去掉房间列表 -> 五格变四格）
  assert.ok(code.includes('repeat(4,minmax(0,1fr))'), 'the four entries sit in ONE row (4 equal columns)');
  for (const label of ['MOD 管理器', '全局设置', '检查更新']) {
    assert.ok(code.includes("'" + label + "'"), 'a function entry is missing: ' + label);
  }
  // 业主 2026-10-15：第 4 格从「开始预载」改成「返回首页」（预载改由进入线路自动开跑）。
  assert.ok(code.includes('>返回首页</button>'), 'the 4th cell is 返回首页');
  assert.ok(!code.includes("'开始预载'") && !code.includes("'停止预载'"), 'the preload toggle is gone');
  assert.ok(!code.includes("'房间列表'"), '房间列表 is gone (owner 2026-10-13)');
  assert.ok(!code.includes("'服务器列表'"), '服务器列表 is not in the window (it moved with 加入线上)');
  assert.ok(!code.includes("'外观设置'"), '外观设置 is folded into 全局设置');
  assert.ok(!code.includes("'联机偏好'"), '联机偏好 is folded into 全局设置');
  assert.ok(/class="set-apply"/.test(code), 'the row keeps the existing .set-apply button style');
  // ④ 硬直角 + 薄荷强调 + 参考站的六个 token（业主：「硬直角/括角、薄荷强调」；9 个自造色不许再出现）
  const sheet = code.match(/function panelStyleCss\(\) \{\n  return \[([\s\S]*?)\n  \]\.join\(''\);/);
  assert.ok(sheet, 'panelStyleCss() must stay a statically extractable array');
  const css = (sheet[1].replace(/^\s*\/\/.*$/gm, '').match(/'((?:[^'\\]|\\.)*)'/g) || []).map((s) => s.slice(1, -1)).join('');
    // 2026-10-14: 圆形指示点（延迟点）用 border-radius:50% —— 那是「一个点」，不是圆角。
    // 硬直角的口径是「不许把方框切圆」，所以先把 50% 那几处抠掉再查。
    const cssHard = css.replace(/border-radius\s*:\s*50%/g, '');
    assert.equal(/border-radius\s*:/.test(cssHard), false, 'hard corners: no border-radius anywhere in the panel sheet');
    // 2026-10-14: 圆形指示点（延迟点）用的是 border-radius:50% —— 那是「一个点」，不是圆角。
    // 硬直角的口径是「不许把方框切圆」，所以先把 50% 的那几处抠掉再查。
  for (const gone of ['#67d9b5', '#3d7463', '#45685d', '#1e2823', '#889894', '#2f8f76', '#1d2825', '#8c9c96', '#6c7a74']) {
    assert.ok(!code.toLowerCase().includes(gone), 'a homebrew hex came back: ' + gone);
  }
  // --sp-text-hi 曾由感谢名单的名字节点使用；名单搬到第一界面后它自然离开本面板，
  // 所以这里断言**当前实际在用**的三个 token（值仍是参考站那六个之一）。
  assert.ok(css.includes('var(--sp-mint)') && css.includes('var(--sp-line2)') && css.includes('var(--sp-text-lo)'),
    'the colours ride the kit tokens (whose values are the reference six)');
  // ⑤ 感谢名单已搬到全屏第一界面：本面板不再有数据、轨道与 keyframes（业主 2026-10-13 第二轮）
  assert.ok(!code.includes('creditList()'), 'the credits data is gone from the window');
  assert.ok(!code.includes('@keyframes sp-preload-marquee'), 'the marquee keyframes are gone');
  assert.ok(!code.includes('sp-preload__credits'), 'the credits band is gone from the source');
  assert.equal(code.includes('translate3d(-25%,0,0)'), false, 'the horizontal marquee belongs to the first screen');
  assert.equal(code.includes('animation:sp-preload-marquee'), false, 'no marquee animation left in the window');
  assert.equal(code.includes('CREDIT_COPIES'), false, 'no credits copies left in the window');
  for (const cls of ['sp-preload__roll-copy', 'sp-preload__credit-name', 'sp-preload__credit-role']) {
    assert.equal(code.includes(cls), false, 'a credits class is still in the source: ' + cls);
  }
  // 数据在兄弟模块里（同一份，两处渲染共用）：真名单 + 前缀 + 不做占位文案
  for (const n of ['纸鸢安好', '水沫沐沐', '剑光卤煮-斩尽牛杂', '雨千代Chiyo']) {
    assert.ok(CREDITS_SRC.includes(n), 'the real thanks list is missing: ' + n);
  }
  assert.ok(CREDITS_SRC.includes("CREDITS_PREFIX = 'bilibili_'"), 'the thanks page prefix is carried over');
  assert.doesNotMatch(CREDITS_SRC, /Contributors|测试人员|社区支持者/, 'no sketch placeholder wording');
  // ⑥ 预载进度条：横向、带百分比、在第三带里
  assert.ok(code.includes('sp-preload__bar-fill'), 'the progress bar fill is drawn');
  assert.ok(code.includes("'width:' + pct + '%'"), 'the bar is horizontal (width = percentage)');
  assert.ok(code.includes('sp-preload__state-pct'), 'the percentage read-out');
  assert.ok(code.includes('RESOURCE PRELOAD'), 'the bar keeps its label');
  // 顺序：菜单（通栏）→ 网格（rooms / list / preload）
  assert.ok(code.indexOf('data-band="menu">') < code.indexOf('data-band="rooms">')
    && code.indexOf('data-band="rooms">') < code.indexOf('data-band="list">')
    && code.indexOf('data-band="list">') < code.indexOf('data-band="preload">'),
    'the source order is 功能 -> 匹配 -> 房间列表 -> 预载');
  // ⑦ 不可滚动（业主：页面不可滚动）。**高度按内容收**（2026-10-13 第九轮：面板太空了），
  //    由 .modal__body 的 max-height 兜底，不再写死 88vh。
  assert.ok(code.includes('height:auto'), 'the content area sizes to its content');
  assert.ok(code.includes('overflow:hidden'), 'the panel never scrolls');
  // ⑧ 预载数据行保留（与 mods-panel.test.mjs 的契约同名：stateRow + infoRow('本地可用')）
  assert.ok(code.includes('stateRow'), 'the bar row helper stays named stateRow (shared contract)');
  assert.ok(code.includes("infoRow('本地可用'"), 'line 2 keeps 本地可用');
  assert.equal(code.includes('progressRow'), false, 'the old separate progress row must be gone');
  assert.equal(code.includes("infoRow('状态'"), false, '状态 moved into the bar row');
  assert.equal(code.includes("infoRow('回源缓存'"), false, '回源缓存 folded into line 2');
  assert.equal(code.includes("infoRow('待预载'"), false, '待预载 folded into line 2');
  // the old chip-era entries must not come back
  // 注：'加入房间' 是 2026-10-13 业主点名要的按钮（四块布局），已从禁列表移除。
  for (const gone of ['公开大厅', '提交房间', '打开 mod 管理器', '公开房间', '自动匹配', '公开到大厅']) {
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
  // 预载：面板**只读**不写（业主 2026-10-15：开跑交给 connect-core.autoPreload）
  assert.ok(code.includes('window.__SP_PRELOAD'), 'the preload API is still the panel\'s data source');
  assert.ok(!code.includes('p.start') && !code.includes('p.cancel'),
    'the panel no longer starts or cancels the walk (nothing to toggle)');
  assert.ok(code.includes('p.state') || code.includes('readState'), 'state() is still read');
});

test('static: the owner 2026-10-13 exit rules -- no 完成 footer, every close path stays', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  // ① 去掉右下角「完成」主按钮：模板不再给 Modal 传 actions，源码里也不再有这颗按钮
  assert.equal(code.includes('>完成<//>'), false, 'the 完成 footer action is gone');
  assert.equal(code.includes('actions='), false, 'the Modal gets no footer actions any more');
  // ② 浮窗仍必须能关 —— 去掉的只是那颗按钮，不是出口：
  //    Modal 自带点遮罩关闭（overlayKit.js 走的就是这里传进去的 onClose），
  //    以及每条出路先关本面板（openPanel(kind, onClose) 现在住在 ui/connect-core.js）。
  assert.ok(code.includes('onClose=${onClose}'), 'the Modal still receives onClose (backdrop click closes the window)');
  assert.ok(code.includes("openPanel(kind, onClose)"), 'the menu row still closes THIS panel before opening the next');
  assert.ok(CONNECT_SRC.includes("if (typeof onClose === 'function') onClose()"),
    'connect-core.openPanel still closes the caller layer first (single implementation)');
  // ③ 剩下的入口绑定原样（UI 微调不得动到事件）
  for (const fn of ['openPanel', 'checkUpdate', 'backHome', 'joinBoardRoom']) {
    assert.ok(code.includes(fn), 'a bound entry is missing: ' + fn);
  }
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

test('static: shell-bridge injects the full-screen first interface before skin, guarded and offline', () => {
  assert.ok(BRIDGE.includes("'/__sp/first-screen.js'"), 'the layer is injected from the /__sp/ channel');
  assert.ok(BRIDGE.includes('window.__SP_FIRST_SCREEN'), 'the injection is guarded by the module marker');
  assert.ok(/fs\.type\s*=\s*'module'/.test(BRIDGE), 'injected as a module (the file is ESM)');
  // 位置契约：它是 UI 层，必须排在 skin（最后一个 UI 层）之前；skin 的 120 字符幂等窗口不许被夹住
  const iFirst = BRIDGE.indexOf("'/__sp/first-screen.js'");
  const iSkin = BRIDGE.indexOf("'/__sp/skin-layer.js'");
  assert.ok(iFirst > 0 && iSkin > 0 && iFirst < iSkin, 'the layer loads before the skin layer');
  assert.ok(BRIDGE.slice(iSkin - 120, iSkin).includes('window.__SP_SKIN'), 'the skin guard window stays clear');
  // 前缀纪律：只从 /__sp/ 取（绝不用页面 origin 的 /js/）
  assert.ok(!/src = ['"][^'"]*\/js\/first-screen\.js['"]/.test(BRIDGE), 'only the /__sp/ channel is used');
});

test('static: the first interface opens by default once per origin, the window is the fallback', () => {
  assert.ok(BRIDGE.includes('f.open()'), 'the bridge opens the full-screen first interface');
  assert.ok(BRIDGE.includes("s.openPanel('preload')"), 'and falls back to the window\'s own first screen');
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
