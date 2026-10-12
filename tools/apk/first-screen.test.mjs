// first-screen.test.mjs -- the FULL-SCREEN FIRST INTERFACE (js/first-screen.js) and the connect core it
// draws (js/ui/connect-core.js) + the shared credits data (js/ui/credits.js).
//
// Owner direction 2026-10-13 (branch ui/redraw-function-panel): 「第一界面改为全屏，优先为本机服务局域网
// 和加入线上（叠加层）」. The three connect entries the floating window used to hold (本地服务 / 加入局域网 /
// 加入服务器 with their 扫描 / 房间列表 / 服务器地址输入 / 连接 / 服务器列表 / 复制链接 controls) MOVED
// here: their bodies live in ui/connect-core.js and this layer is the only UI that draws them. That is
// why this file also carries the cases that used to live in preload-panel.test.mjs ("connect columns:
// 本地服务 starts the host…" and "复制链接 uses the VPN address first…") -- the assertions were kept,
// their address changed with the code.
//
// Covered:
//   · connect-core: every entry's real behaviour on a real bridge, and its honest refusal without one
//     (never a dead click), the address preference (zt > lan > v6), openPanel's close-first contract;
//   · first-screen: the layer's own stylesheet (hard corners, the six reference tokens, every selector
//     parked under .sp-first), the three entries, the in-place second steps (局域网 / 加入线上), the
//     LAN result flow through window.__SP_LAN, the 进入游戏 exit, and the horizontal 感谢名单 runner;
//   · the wiring: shell-bridge injects it from /__sp/ with its own idempotency marker, and it is a
//     LAYER -- it only covers, never replaces, the upstream title screen.
//
//   node --test tools/apk/first-screen.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extrasRead = (rel) => fs.readFileSync(path.join(here, 'extras', 'public', 'js', ...rel.split('/')), 'utf8');
const SRC = extrasRead('first-screen.js');
const CONNECT = extrasRead('ui/connect-core.js');
const CREDITS = extrasRead('ui/credits.js');
const BRIDGE = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-bridge.js'), 'utf8');
const HTM = extrasRead('vendor/htm.module.js');

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const CODE = strip(SRC);

// ---------------------------------------------------------------- vnode helpers (same shape the
// preload-panel suite uses: htm does the parsing, this h() keeps props + children so the test can walk
// the tree, and the kit stub keeps REAL state so a click + re-render behaves like preact does).
// The kit stub's hooks are cursor-based (like preact's), so every TOP-LEVEL resolve restarts the
// cursor: one walk of the tree == one render pass == the slots the component itself would read.
let RESET_HOOKS = () => {};
let RESOLVE_DEPTH = 0;
function resolve(node) {
  let n = node;
  for (let i = 0; i < 20 && n && typeof n === 'object' && typeof n.type === 'function'; i++) {
    if (RESOLVE_DEPTH === 0) RESET_HOOKS();
    RESOLVE_DEPTH += 1;
    try { n = n.type(n.props); } finally { RESOLVE_DEPTH -= 1; }
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
/** An entry button is "中文大字 + 英文 micro + 箭头": match on the Chinese label inside its text. */
function buttonContaining(node, label) {
  return collectButtons(node).find((b) => textOf(b).includes(label)) || null;
}
function findByClass(node, cls, out) {
  out = out || [];
  const n = resolve(node);
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const c of n) findByClass(c, cls, out); return out; }
  if (classesOf(n).includes(cls)) out.push(n);
  if (n.children) findByClass(n.children, cls, out);
  return out;
}

// ---------------------------------------------------------------- the fake browser
function mkEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    attrs: {},
    style: {},
    textContent: '',
    parentNode: null,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    addEventListener() {},
    removeEventListener() {},
  };
}
function mkDoc() {
  const doc = { documentElement: mkEl('html'), head: mkEl('head'), body: mkEl('body') };
  doc.createElement = (t) => mkEl(t);
  const find = (el, id) => {
    if (el.getAttribute && el.getAttribute('id') === id) return el;
    for (const c of el.children || []) { const hit = find(c, id); if (hit) return hit; }
    return null;
  };
  doc.getElementById = (id) => find(doc.documentElement, id);
  return doc;
}

const KIT_STUB = [
  "import htm from '../../vendor/htm.module.js';",
  'export function h(type, props, ...children) {',
  '  const kids = children.flat(Infinity).filter((c) => c != null && c !== false && c !== true);',
  '  const p = Object.assign({}, props || {});',
  '  if (kids.length) p.children = kids.length === 1 ? kids[0] : kids;',
  '  return { type, props: p, children: kids };',
  '}',
  'export const html = htm.bind(h);',
  'export function MicroLabel(p) { return html`<span class="micro">${p && p.children}</span>`; }',
  'export function toast(text) { (globalThis.__spTestToasts = globalThis.__spTestToasts || []).push(String(text)); }',
  // real state (the mods-panel.test.mjs idiom): the test re-renders after a click to see the update
  'const __st = []; let __i = 0;',
  'export function __resetHooks() { __i = 0; }',
  'export function useState(v) {',
  '  const i = __i++;',
  '  if (!(i in __st)) __st[i] = typeof v === "function" ? v() : v;',
  '  return [__st[i], function (n) { __st[i] = typeof n === "function" ? n(__st[i]) : n; }];',
  '}',
  'export function useEffect(fn) { if (typeof fn === "function") fn(); }',
  'export function render(vnode, container) { container.__spTree = vnode || null; return container; }',
].join('\n');
const SHELLPANELS_STUB = 'export function registerPanel() { return true; }\n';
const HOOKS_STUB = [
  "export function useState(v) { return [typeof v === 'function' ? v() : v, function () {}]; }",
  'export function useEffect() {}',
].join('\n');

function mkTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'firstscreen-'));
  const w = (rel, text) => {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  w('package.json', JSON.stringify({ type: 'module' }));
  w('public/js/first-screen.js', SRC);
  w('public/js/ui/credits.js', CREDITS);
  w('public/js/ui/connect-core.js', CONNECT);
  w('public/js/ui/overlayKit.js', KIT_STUB);
  w('public/js/ui/shellPanels.js', SHELLPANELS_STUB);
  w('public/vendor/hooks.module.js', HOOKS_STUB);
  w('public/vendor/htm.module.js', HTM);
  return root;
}

/** Load the layer in a fake browser: fresh module instance, fresh document/window, kit resolved. */
async function mountFirstScreen() {
  const root = mkTree();
  const doc = mkDoc();
  const win = { addEventListener() {}, removeEventListener() {}, __SP_LAN: { onScan(fn) { win.__lanCb = fn; }, begin() { win.lanBegins = (win.lanBegins || 0) + 1; } } };
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  globalThis.window = win;
  globalThis.document = doc;
  try {
    const mod = await import(pathToFileURL(path.join(root, 'public', 'js', 'first-screen.js')).href + '?t=' + Date.now());
    await mod.whenDepsReady();
    const { __resetHooks } = await import(pathToFileURL(path.join(root, 'public', 'js', 'ui', 'overlayKit.js')).href);
    RESET_HOOKS = __resetHooks;
    const api = {
      mod, doc, win, root, __resetHooks,
      host: () => doc.getElementById('sp-first-host'),
      open: () => { __resetHooks(); return mod.openFirstScreen(); },
      tree: () => { const h = doc.getElementById('sp-first-host'); return h ? h.__spTree : null; },
      style: () => doc.getElementById('sp-first-style'),
      close() {
        mod.closeFirstScreen();
        RESET_HOOKS = () => {};
        globalThis.window = prevWin;
        globalThis.document = prevDoc;
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
    return api;
  } catch (e) {
    RESET_HOOKS = () => {};
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

/** Run fn with a fake window (the connect core reads window.shell / window.__SP_SHELL / …). */
function withWindow(win, fn) {
  const prev = globalThis.window;
  globalThis.window = win;
  try { return fn(); } finally { if (prev === undefined) delete globalThis.window; else globalThis.window = prev; }
}

const CONNECT_PATH = pathToFileURL(path.join(here, 'extras', 'public', 'js', 'ui', 'connect-core.js')).href;
const connect = await import(CONNECT_PATH);

// ===================================================================================================
// ui/connect-core.js -- the moved bodies, driven directly
// ===================================================================================================

test('connect-core has no imports and no DOM work of its own (pure plumbing the layers inject into)', () => {
  const code = strip(CONNECT);
  assert.equal(/^\s*import\s/m.test(code), false, 'no imports: the layers hand it everything');
  assert.equal((code.match(/document\.body\.appendChild/g) || []).length, 1,
    'the only DOM touch is the clipboard fallback (the App bridge path is preferred)');
  assert.ok(code.includes('sh.copyText(s)'), 'the App clipboard bridge comes first');
  for (const fn of ['startLocal', 'scanLan', 'joinLan', 'joinCustom', 'copyRoomLink', 'lanIpLine',
    'hintPreload', 'openPanel', 'localBase', 'localRoomUrl', 'currentRoomCode', 'onLanScan', 'lanNote',
    'lanRoomKey', 'lanRoomLabel', 'lanSupported']) {
    assert.ok(code.includes('export function ' + fn), 'missing export: ' + fn);
  }
});

test('本机服务 starts the host on demand, closes the layer, then hints the preload window', () => {
  const calls = { local: 0, setServer: [], closed: 0, hinted: 0 };
  withWindow({
    shell: { startLocalService: () => { calls.local++; }, setServer: (v) => calls.setServer.push(v) },
    __SP_PRELOAD: { open: () => { calls.hinted++; } },
  }, () => {
    const ok = connect.startLocal({ onClose: () => { calls.closed++; } });
    assert.equal(ok, true, 'the entry reports that it acted');
    assert.equal(calls.local, 1, 'shell.startLocalService is the call (the ONLY thing that starts Node)');
    assert.deepEqual(calls.setServer, [], 'no second switch when the exact entry point exists');
    assert.equal(calls.closed, 1, 'the layer closes first (the switch reloads the page)');
    assert.equal(calls.hinted, 1, 'and the preload window is hinted afterwards');
  });
  // the old shell (no startLocalService) falls back to setServer('local')
  withWindow({ shell: { setServer: (v) => calls.setServer.push(v) } }, () => {
    assert.equal(connect.startLocal({}), true);
    assert.deepEqual(calls.setServer, ['local'], 'setServer("local") is the documented fallback');
  });
  // a plain web page: it says so instead of doing nothing
  const said = [];
  withWindow({}, () => {
    assert.equal(connect.startLocal({ say: (m) => said.push(m) }), false);
  });
  assert.deepEqual(said, ['当前页面不支持本地服务'], 'no bridge -> an honest line, never a dead click');
});

test('加入线上 applies the custom address (https:// prepended, trailing slash folded) and never dials empty', () => {
  const calls = { setServer: [], closed: 0, said: [], hinted: 0 };
  const ctx = { say: (m) => calls.said.push(m), onClose: () => { calls.closed++; }, toast: () => {} };
  withWindow({ shell: { setServer: (v) => calls.setServer.push(v) }, __SP_PRELOAD: { open: () => { calls.hinted++; } } }, () => {
    assert.equal(connect.joinCustom('', ctx), false, 'an empty address never dials');
    assert.deepEqual(calls.setServer, [], 'nothing was called');
    assert.deepEqual(calls.said, ['请输入服务器地址'], 'and the reason is shown');
    assert.equal(connect.joinCustom('  example.com/  ', ctx), true);
    assert.deepEqual(calls.setServer, ['custom:https://example.com'], 'bare host -> https://, slash folded');
    assert.equal(connect.joinCustom('http://10.0.0.4:3000', ctx), true);
    assert.deepEqual(calls.setServer[1], 'custom:http://10.0.0.4:3000', 'an explicit scheme is kept');
    assert.equal(calls.closed, 2, 'each successful connect closes the layer');
    assert.equal(calls.hinted, 2, 'and hints the preload window (the 2026-10-12 owner rule)');
  });
  // the web build (no shell at all) says why instead of pretending to connect
  withWindow({}, () => {
    assert.equal(connect.joinCustom('example.com', { say: (m) => calls.said.push(m) }), false);
  });
  assert.deepEqual(calls.said.slice(-1), ['当前版本不支持自定义服务器'], 'the web build says why');
});

test('局域网 scans once per click and reports what really came back', () => {
  const out = { states: [], said: [], begins: 0 };
  const ctx = { state: 'idle', say: (m) => out.said.push(m), onState: (st, rooms, note) => out.states.push([st, rooms, note]) };
  const win = {
    shell: { lanScan: () => '1' },
    __SP_LAN: { begin: () => { out.begins++; } },
  };
  withWindow(win, () => {
    assert.equal(connect.scanLan(ctx), true);
    assert.deepEqual(out.states, [['scanning', [], '']], 'the caller is told a scan is in flight');
    assert.equal(out.begins, 1, 'the bridge sequence marker is bumped once');
  });
  // a scan already in flight is not restarted
  out.states.length = 0;
  withWindow(win, () => {
    assert.equal(connect.scanLan({ state: 'scanning', onState: (st) => out.states.push([st]) }), false);
  });
  assert.deepEqual(out.states, [], 'no second scan while one is running');
  // the bridge throws -> the caller is told to retry (not "update the APK")
  const win2 = { shell: { lanScan: () => { throw new Error('boom'); } } };
  const states2 = [];
  withWindow(win2, () => {
    assert.equal(connect.scanLan({ state: 'idle', onState: (st, rooms, note) => states2.push([st, rooms, note]) }), false);
  });
  assert.deepEqual(states2, [['idle', [], '扫描失败，请稍后重试']], 'an exception is a retryable failure');
  // an old APK whose bridge returns null
  const said2 = [];
  withWindow({ shell: { lanScan: () => null } }, () => {
    assert.equal(connect.scanLan({ state: 'idle', say: (m) => said2.push(m) }), false);
  });
  assert.deepEqual(said2, ['需更新 APK 后生效'], 'null means the bridge is too old -- say so');
  // no bridge at all
  const said3 = [];
  withWindow({}, () => {
    assert.equal(connect.scanLan({ state: 'idle', say: (m) => said3.push(m) }), false);
  });
  assert.deepEqual(said3, ['当前版本不支持局域网扫描'], 'and without the bridge, nothing pretends to scan');
});

test('局域网 join targets the scanned room and reports an unreachable one', () => {
  const calls = { joined: [], closed: 0, hinted: 0, said: [] };
  const ctx = { say: (m) => calls.said.push(m), onClose: () => { calls.closed++; } };
  withWindow({
    shell: { joinOnOrigin: (id, code) => { calls.joined.push([id, code]); return true; } },
    __SP_PRELOAD: { open: () => { calls.hinted++; } },
  }, () => {
    assert.equal(connect.joinLan(null, ctx), false, 'no room -> nothing happens');
    assert.equal(connect.joinLan({ ip: '192.168.0.7', port: 3000, code: 'ab12' }, ctx), true);
  });
  assert.deepEqual(calls.joined, [['lan:192.168.0.7:3000', 'AB12']],
    'the origin id is lan:<ip>:<port> and the room code is upper-cased');
  assert.equal(calls.closed, 1, 'entering a room closes the layer');
  assert.equal(calls.hinted, 1, 'and hints the preload window');
  // the bridge refuses: the player is told, the layer stays
  withWindow({ shell: { joinOnOrigin: () => false } }, () => {
    assert.equal(connect.joinLan({ ip: '10.0.0.9', port: 3000, code: 'zzzz' }, ctx), false);
  });
  assert.deepEqual(calls.said, ['加入失败：目标房间不可达'], 'a refusal is reported, not swallowed');
  assert.equal(calls.closed, 1, 'a failed join does not close the layer');
  // no bridge
  const said = [];
  withWindow({}, () => {
    assert.equal(connect.joinLan({ ip: '10.0.0.9', port: 3000, code: 'zzzz' }, { say: (m) => said.push(m) }), false);
  });
  assert.deepEqual(said, ['当前版本不支持局域网加入']);
});

test('复制链接 uses the VPN address first, then the LAN address, and never copies a dead link', () => {
  const copied = [];
  const win = {
    __SP__: { store: { get: () => ({ room: { code: 'ab12' } }) } },
    shell: {
      hostAddresses: () => JSON.stringify({ zt: 'http://10.244.0.5:3000', lan: 'http://192.168.0.7:3000' }),
      copyText: (t) => { copied.push(t); },
    },
  };
  withWindow(win, () => {
    assert.equal(connect.copyRoomLink({ say: () => {} }), true);
  });
  assert.deepEqual(copied, ['http://10.244.0.5:3000/?room=AB12'],
    'the copied link prefers the VPN address and carries the upper-cased room code');

  copied.length = 0;
  win.shell.hostAddresses = () => JSON.stringify({ lan: 'http://192.168.0.7:3000/' });
  withWindow(win, () => { connect.copyRoomLink({ say: () => {} }); });
  assert.deepEqual(copied, ['http://192.168.0.7:3000/?room=AB12'], 'the trailing slash is folded away');

  copied.length = 0;
  delete win.shell.hostAddresses;
  const said = [];
  withWindow(win, () => { assert.equal(connect.copyRoomLink({ say: (m) => said.push(m) }), false); });
  assert.deepEqual(copied, [], 'no address -> nothing is copied');
  assert.match(said[0], /尚未取得本机地址/, 'and the player is told why');

  // no room open -> no link to copy
  const said2 = [];
  withWindow({ __SP__: { store: { get: () => ({ room: { code: '' } }) } }, shell: win.shell }, () => {
    assert.equal(connect.copyRoomLink({ say: (m) => said2.push(m) }), false);
  });
  assert.equal(said2.length, 1, 'without a 4-char room code there is nothing to share');
});

test('lanIpLine prefers the virtual LAN, then the LAN, then IPv6, and says so when there is none', () => {
  const line = (addr) => withWindow({ shell: { hostAddresses: () => JSON.stringify(addr) } }, () => connect.lanIpLine());
  assert.match(line({ zt: 'http://10.244.0.5:3000', lan: 'http://192.168.0.7:3000' }),
    /^本机虚拟局域网 IP：http:\/\/10\.244\.0\.5:3000/, 'the VPN address wins (the same one 复制链接 uses)');
  assert.match(line({ lan: 'http://192.168.0.7:3000' }), /^本机局域网 IP：http:\/\/192\.168\.0\.7:3000/);
  assert.match(line({ v6: 'http://[2001:db8::1]:3000' }), /^本机 IPv6 地址：/);
  assert.match(line({}), /^未取到本机地址/);
  assert.equal(withWindow({}, () => connect.lanIpLine()), '本机地址需 App 版提供',
    'without the bridge it says the reading needs the App build');
});

test('hintPreload only hints: the preload panel is opened, nothing is started behind the player\'s back', () => {
  const calls = { open: 0, panels: [] };
  withWindow({ __SP_PRELOAD: { open: () => { calls.open++; } } }, () => {
    assert.equal(connect.hintPreload(), true);
  });
  assert.equal(calls.open, 1, 'the preload window is opened (its own module decides what to do)');
  withWindow({ __SP_SHELL: { openPanel: (k) => calls.panels.push(k) } }, () => {
    assert.equal(connect.hintPreload(), true);
  });
  assert.deepEqual(calls.panels, ['preload'], 'without the center, the panel host opens kind preload');
  assert.equal(withWindow({}, () => connect.hintPreload()), false, 'no center and no host -> no false promise');
});

test('openPanel closes the caller layer first, then opens the kind (single implementation)', () => {
  const calls = [];
  withWindow({ __SP_SHELL: { openPanel: (k) => calls.push('open:' + k) } }, () => {
    assert.equal(connect.openPanel('servers', () => calls.push('close')), true);
  });
  assert.deepEqual(calls, ['close', 'open:servers'], 'the layer closes BEFORE the next panel opens');
  assert.equal(withWindow({}, () => connect.openPanel('servers')), false, 'no host -> false, never a throw');
});

test('onLanScan / lanNote read the bridge result honestly', () => {
  const seen = [];
  const win = { __SP_LAN: { onScan: (fn) => { win.cb = fn; } } };
  withWindow(win, () => {
    assert.equal(connect.onLanScan((rooms, data) => seen.push([rooms, data])), true);
  });
  win.cb([{ code: 'AB12' }], { ok: true });
  assert.deepEqual(seen, [[[{ code: 'AB12' }], { ok: true }]], 'the callback is the one we registered');
  assert.equal(withWindow({}, () => connect.onLanScan(() => {})), false, 'no bridge -> false');
  assert.equal(connect.lanNote({ ok: true }), '', 'a good scan draws no note line');
  assert.equal(connect.lanNote({ ok: false }), '扫描失败，请稍后重试');
  assert.match(connect.lanNote({ unreachable: true }), /扫描没打通/);
  assert.equal(connect.lanNote(null), '', 'never invents a note');
  assert.equal(connect.lanRoomKey({ ip: '1.2.3.4', port: 3000, code: 'AB12' }, 0), 'lan:1.2.3.4:3000#AB12');
  assert.equal(connect.lanRoomLabel({ code: 'AB12', name: '小房间' }), 'AB12 · 小房间');
  assert.equal(connect.lanRoomLabel({ code: 'AB12' }), 'AB12');
});

// ===================================================================================================
// ui/credits.js -- one source for both runners
// ===================================================================================================

test('credits.js is the single source: real names, the thanks-page prefix, no sketch wording', async () => {
  const credits = await import(pathToFileURL(path.join(here, 'extras', 'public', 'js', 'ui', 'credits.js')).href);
  assert.equal(credits.CREDITS_PREFIX, 'bilibili_', 'the thanks page prefix is carried over');
  const list = credits.creditList();
  assert.equal(list.length, 8, 'a lead label + the seven real names');
  assert.equal(list[0].lead, true, 'the first entry labels the strip');
  for (const n of ['纸鸢安好', '水沫沐沐', 'jingjiangze', '剑光卤煮-斩尽牛杂', '不知名信箱', '雨千代Chiyo', '伊佐那邪_']) {
    assert.ok(list.some((it) => it.label === n), 'a real name is missing: ' + n);
  }
  assert.deepEqual(list.slice(1).map((it) => it.role), ['项目发起人', 'Mod管理器作者', '', '', '', '', ''],
    'the role notes ride along (small line under the big name)');
  // 前缀口径与 stronghold-thanks/js/thanks.js 的 displayName 一致：名单里没有前缀就补上并单独拆出
  // （mint 小字），已经带前缀的名字原样显示（不再二次加）。
  const withPrefix = credits.creditUnit({ name: '张三' });
  assert.equal(withPrefix.pre, 'bilibili_', 'the prefix is split out (mint span)');
  assert.equal(withPrefix.label, '张三', 'and the name itself stays clean');
  const already = credits.creditUnit({ name: 'bilibili_李四' });
  assert.equal(already.pre, '', 'a name that already carries the prefix is not doubled');
  assert.equal(already.label, 'bilibili_李四');
  assert.equal(credits.creditUnit({ name: '王五', prefix: '' }).pre, '', 'an explicit empty prefix is honoured');
  assert.deepEqual(credits.CREDIT_COPIES, [0, 1, 2, 3], 'four identical copies -> a seamless -25% loop');
  assert.doesNotMatch(CREDITS, /Contributors|测试人员|社区支持者/, 'no placeholder wording is data');
});

// ===================================================================================================
// the layer
// ===================================================================================================

test('static: the layer ships its own sheet, every selector parked under .sp-first', () => {
  assert.ok(CODE.includes("const STYLE_ID = 'sp-first-style'"), 'the sheet has its own id');
  assert.ok(CODE.includes('export function injectFirstScreenStyles'), 'the injector is exported');
  assert.ok(CODE.includes('document.getElementById(STYLE_ID)'), 'injection is idempotent by id');
  const m = SRC.match(/function firstStyleCss\(\) \{\n  return \[([\s\S]*?)\n  \]\.join\(''\);/);
  assert.ok(m, 'firstStyleCss() 必须是一行一条的数组字面量（可静态提取）');
  const body = m[1].split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const css = (body.match(/'((?:[^'\\]|\\.)*)'/g) || []).map((s) => s.slice(1, -1)).join('');
  assert.ok(css.length > 0, 'the sheet is not empty');
  const selectors = [];
  for (const s of css.matchAll(/([^{}]+)\{/g)) {
    const sel = s[1].trim();
    if (!sel || sel.startsWith('@')) continue;
    selectors.push(sel);
  }
  assert.ok(selectors.length > 0, 'selectors are parseable');
  for (const sel of selectors) {
    for (const part of sel.split(',')) {
      const s = part.trim();
      if (!s || s.startsWith('from') || s.startsWith('to')) continue;
      assert.ok(s.startsWith('.sp-first'), 'every selector must start with .sp-first: ' + s);
    }
  }
  // 硬直角 + 参考站的六个 token + 薄荷顶线/括角/扫描线（业主：硬直角/括角、薄荷强调）
  // 硬直角：唯一允许的 radius 是状态点的 border-radius:50%（参考站 .status-dot 同款）；
  // 面板/按钮/行一律不许有圆角。
  const radii = (css.match(/border-radius\s*:\s*([^;}]+)/g) || []).map((x) => x.split(':')[1].trim());
  assert.ok(radii.every((v) => v === '50%'),
    'hard corners: only the status dot may be round, got ' + JSON.stringify(radii));
  for (const gone of ['#67d9b5', '#3d7463', '#45685d', '#1e2823', '#889894', '#2f8f76', '#1d2825', '#8c9c96', '#6c7a74']) {
    assert.ok(!CODE.toLowerCase().includes(gone), 'a homebrew hex came back: ' + gone);
  }
  for (const hex of ['#4ed8af', '#3e4b45', '#f2f2f2', '#c3cbc7', '#8a948f', '#5d6863']) {
    assert.ok(css.includes(hex), 'the reference token value is missing: ' + hex);
  }
  assert.ok(css.includes('repeating-linear-gradient(0deg,rgba(255,255,255,.016) 0 1px,transparent 1px 3px)'),
    'the reference scanline texture is carried over');
  assert.ok(/\.sp-first__card::before\{[^}]*height:2px[^}]*linear-gradient\(90deg/.test(css.replace(/\n/g, '')),
    'the card keeps the 2px mint hairline across its top edge');
  assert.ok(css.includes('--sp-f-bk-l') && css.includes('var(--sp-f-bk-w)'), 'the L-shaped bracket corners are drawn');
  // the layer carries its OWN scale so it is right even where the game theme never loaded
  assert.ok(css.includes('--sp-f-u:var(--t,clamp(40px'), 'the unit follows the theme root, with its own clamp fallback');
  assert.ok(css.includes('overflow:hidden'), 'the page never scrolls with the layer up');
  assert.ok(css.includes('@media (max-width:720px)') && css.includes('@media (max-height:520px)'),
    'narrow + short screens get their own pass (390x844 and landscape phones must not clip)');
});

test('static: it is a LAYER -- below the panel host, closable, offline, no page module', () => {
  // 层序：panel host 2147481000 / modal 2147482000 在它上面，它自己只压页面
  assert.ok(CODE.includes('z-index:2147479000'), 'the layer sits below the panel host (2147481000)');
  assert.ok(CODE.includes("document.documentElement.appendChild(el)"),
    'the host attaches to the ROOT stacking context (no page container can trap it)');
  assert.ok(CODE.includes("el.setAttribute('class', 'sp-first-host')"), 'the host carries the scope class');
  // 出口：进入游戏 / Esc / window.__SP_FIRST
  assert.ok(CODE.includes('进入游戏'), 'the way out is drawn');
  assert.ok(CODE.includes("window.addEventListener('keydown'"), 'Esc also leaves the layer');
  assert.ok(CODE.includes('window.__SP_FIRST = {'), 'the host API is published');
  assert.ok(CODE.includes("window.__SP_FIRST_SCREEN = true"), 'and the injection marker');
  assert.ok(CODE.includes('export function openFirstScreen') && CODE.includes('export function closeFirstScreen')
    && CODE.includes('export function firstScreenVisible'), 'open/close/visible are exported');
  // 只从自带树取依赖，且只走相对 /__sp/ 通道
  const staticImports = [...SRC.matchAll(/^[ \t]*import[^;]*\bfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.deepEqual(staticImports, ['./ui/credits.js', './ui/connect-core.js'],
    'only the two same-directory siblings are static imports (no shell module, no page module)');
  assert.ok(SRC.includes("await import('./ui/overlayKit.js')"), 'the UI kit stays a dynamic import');
  assert.ok(!SRC.includes('/js/ui/components.js') && !SRC.includes('/vendor/'), 'no page-origin UI path');
  assert.equal(/fetch\(|XMLHttpRequest/.test(strip(SRC)), false, 'the layer never touches the network');
});

test('the three entries render in the owner\'s order, with 本机服务 acting in one click', async () => {
  const api = await mountFirstScreen();
  try {
    let started = 0;
    api.win.shell = { startLocalService: () => { started++; }, hostAddresses: () => '{}' };
    assert.equal(api.open(), true, 'the layer opens');
    const tree = api.tree();
    assert.ok(tree, 'a tree was rendered');
    const names = findByClass(tree, 'sp-first__entry-name').map(textOf);
    assert.deepEqual(names, ['本机服务', '局域网', '加入线上'], 'the owner\'s three entries, in order');
    assert.ok(textOf(tree).includes('LOCAL SERVICE') && textOf(tree).includes('LAN DISCOVERY') && textOf(tree).includes('ONLINE'),
      'each entry keeps its English micro label');
    // 本机服务 = one click, straight to the host (no second step), and the layer closes
    buttonContaining(tree, '本机服务').props.onClick();
    assert.equal(started, 1, '本机服务 starts the host service');
    assert.equal(api.mod.firstScreenVisible(), false, 'and the layer is gone (the switch reloads the page)');
  } finally { api.close(); }
});

test('局域网 opens in place: the hint, the address line, the scan button, then the real rooms', async () => {
  const api = await mountFirstScreen();
  try {
    const scans = [];
    api.win.shell = {
      hostAddresses: () => JSON.stringify({ zt: 'http://10.244.0.5:3000' }),
      lanScan: (mode, code) => { scans.push([mode, code]); return '1'; },
      joinOnOrigin: (id, code) => { api.win.joined = [id, code]; return true; },
    };
    api.open();
    let tree = api.tree();
    // closed by default: the offer is a one-line hint, no controls
    assert.equal(findByClass(tree, 'sp-first__rooms').length, 0, 'no room list before the entry is opened');
    buttonContaining(tree, '局域网').props.onClick();
    tree = api.open() && api.tree();
    const text1 = textOf(tree);
    assert.ok(text1.includes('同一 Wi-Fi / 虚拟局域网下已公开的房间'), 'the LAN hint moved here from the window');
    assert.ok(text1.includes('本机虚拟局域网 IP：http://10.244.0.5:3000'),
      'the address line is the same reading as 复制链接 (identical value, so the hint and the link agree)');
    assert.ok(findByClass(tree, 'sp-first__sub').length === 1, 'the second step is drawn in place');
    buttonByText(tree, '扫描').props.onClick();
    assert.deepEqual(scans, [['rooms', '']], 'the scan button calls shell.lanScan exactly like the window did');
    // the bridge answers through __SP_LAN.onScan -> the rooms are drawn as buttons
    api.win.__lanCb([{ ip: '192.168.0.7', port: 3000, code: 'AB12', name: '测试房' }], { ok: true });
    tree = api.open() && api.tree();
    assert.ok(textOf(tree).includes('发现 1 个已公开房间'), 'the count is drawn from the result');
    const room = buttonByText(tree, 'AB12 · 测试房');
    assert.ok(room, 'a room button is drawn with room code + name');
    room.props.onClick();
    assert.deepEqual(api.win.joined, ['lan:192.168.0.7:3000', 'AB12'], 'joining targets that room');
    assert.equal(api.mod.firstScreenVisible(), false, 'entering a room leaves the layer');
  } finally { api.close(); }
});

test('加入线上 opens in place: address input + 连接 + the INLINE server list + the privacy hint', async () => {
  const api = await mountFirstScreen();
  try {
    const panels = [];
    api.win.__SP_SHELL = { openPanel: (k) => panels.push(k) };
    // 内联清单的数据源：签名清单（window.shell.getServerList）优先
    api.win.shell = {
      getServerList: () => JSON.stringify({
        entries: [
          { id: 'srv-a', name: '国内线路', app: '0.2.5', current: true, rttMs: 42 },
          { id: 'srv-b', name: '国际线路', app: '0.2.5', rttMs: 180 },
          { id: 'srv-c', name: '停用线路', enabled: false },
          { id: 'local', name: '本机服务' },
          { id: 'auto', name: '自动线路' },
        ],
      }),
      setServer: () => {},
    };
    api.open();
    buttonContaining(api.tree(), '加入线上').props.onClick();
    const tree = api.open() && api.tree();
    const text = textOf(tree);
    const input = findByClass(tree, 'sp-first__input')[0];
    assert.ok(input, 'the address input moved here');
    assert.equal(input.props.placeholder, '输入服务器地址（如 example.com）', 'with the window\'s own placeholder');
    assert.equal(input.type, 'input', 'and it is a real text input');
    assert.ok(text.includes('自定义地址只在本机连接，不会同步到服务器清单站。'), 'with the same privacy hint');
    const conn = buttonByText(tree, '连接');
    assert.ok(conn, 'the 连接 button is here');
    assert.equal(conn.props.disabled, true, 'with an empty address it is disabled (never dials)');
    // 业主 2026-10-13：服务器清单**直接内联**在这里（不再有「服务器列表」按钮去开面板）
    assert.equal(buttonByText(tree, '服务器列表'), null, 'the 服务器列表 button is GONE (the list is inline now)');
    assert.deepEqual(panels, [], 'and nothing opens the shell panel any more');
    const srv = findByClass(tree, 'sp-first__srv')[0];
    assert.ok(srv, 'the inline server list block is drawn');
    const rows = findByClass(srv, 'sp-first__srv-row');
    assert.equal(rows.length, 3, 'three list rows: local/auto are filtered out, like the shell panel does');
    assert.equal(textOf(rows[0]).includes('国内线路'), true, 'row 1 = the signed list entry');
    assert.equal(textOf(rows[0]).includes('国际线路'), false);
    // 一行一个 + 可滑动：滚动只发生在内联块内部（整页仍不可滚动）
    assert.ok(/\.sp-first__srv-rows\{[^}]*max-height:[^}]*overflow-y:auto/.test(CODE),
      'the row stack is height-capped and scrolls on its own (the page does not)');
    assert.ok(/\.sp-first__srv\{[^}]*flex-direction:column/.test(CODE), 'one row per line (a column, not a grid)');
    // 点一行 = 用同一份连接本体连上它（connect-core 的 joinCustom）
    const typed = [];
    api.win.shell.setServer = (v) => typed.push(v);
    rows[1].props.onClick();
    assert.deepEqual(typed, ['custom:https://srv-b'], 'clicking a row dials it through the same body');
    // typing an address enables 连接 and dials through the same body the window used
    input.props.onInput({ currentTarget: { value: 'example.com' } });
    const tree2 = api.open() && api.tree();
    const conn2 = buttonByText(tree2, '连接');
    assert.equal(conn2.props.disabled, false, 'a typed address enables the button');
    conn2.props.onClick();
    assert.deepEqual(typed, ['custom:https://srv-b', 'custom:https://example.com'], 'the same joinCustom body is used');
  } finally { api.close(); }
});

test('进入游戏 leaves the layer (and the title screen underneath is untouched by us)', async () => {
  const api = await mountFirstScreen();
  try {
    api.open();
    const tree = api.tree();
    assert.equal(api.mod.firstScreenVisible(), true);
    const enter = findByClass(tree, 'sp-first__enter')[0];
    assert.ok(enter, 'the exit button is drawn');
    assert.ok(textOf(enter).includes('进入游戏') && textOf(enter).includes('ENTER'), 'it reads 进入游戏 / ENTER');
    enter.props.onClick();
    assert.equal(api.mod.firstScreenVisible(), false, 'clicking it closes the layer');
    assert.equal(api.tree(), null, 'and nothing of ours stays in the DOM');
    // reopen -> close by API (Esc calls the same path)
    assert.equal(api.open(), true);
    api.mod.closeFirstScreen();
    assert.equal(api.mod.firstScreenVisible(), false);
    // the layer never writes to the page's own screens: it only appends its own host
    assert.equal(api.doc.documentElement.children.filter((c) => c.getAttribute('id') === 'sp-first-host').length, 1,
      'exactly one host element, and it is ours');
  } finally { api.close(); }
});

test('the thanks list runs along the bottom, horizontally (4 identical copies, -25%)', async () => {
  const api = await mountFirstScreen();
  try {
    api.open();
    const tree = api.tree();
    const strip = findByClass(tree, 'sp-first__credits')[0];
    assert.ok(strip, 'the credits strip is drawn');
    const roll = findByClass(tree, 'sp-first__roll')[0];
    assert.equal(findByClass(tree, 'sp-first__roll-copy').length, 4,
      'four identical copies -> the -25% loop is seamless');
    // 横向：副本是行内排的，动画走 X 轴（浮窗那份走 Y 轴，两者共用同一份数据）
    const css = SRC.match(/function firstStyleCss\(\) \{\n  return \[([\s\S]*?)\n  \].join\(''\);?/);
    assert.ok(/\.sp-first__roll\{[^}]*flex-direction:row/.test(SRC), 'the track is a ROW');
    assert.ok(SRC.includes('translate3d(-25%,0,0)'), 'the runner moves on the X axis (right -> left)');
    assert.equal(SRC.includes('translate3d(0,-25%,0)'), false, 'the vertical runner is the window\'s');
    const text = textOf(roll);
    for (const n of ['纸鸢安好', '水沫沐沐', '剑光卤煮-斩尽牛杂', '雨千代Chiyo', '伊佐那邪_']) {
      assert.ok(text.includes(n), 'a real name is missing: ' + n);
    }
    assert.ok(text.includes('bilibili_'), 'the prefix renders (mint span)');
    assert.ok(text.includes('项目发起人') || text.includes('Mod管理器作者'), 'the role notes render');
    assert.ok(text.includes('感谢名单') && text.includes('THANKS LIST'), 'the strip is labelled');
    assert.ok(css, 'the sheet is extractable');
  } finally { api.close(); }
});

test('the wiring: shell-bridge injects the layer from /__sp/ before skin, and defaults to it', () => {
  assert.ok(BRIDGE.includes("'/__sp/first-screen.js'"), 'injected by name from the own prefix');
  assert.ok(BRIDGE.includes('window.__SP_FIRST_SCREEN'), 'guarded by the layer\'s own marker');
  assert.ok(/fs\.type\s*=\s*'module'/.test(BRIDGE), 'injected as a module (the file is ESM)');
  const iFirst = BRIDGE.indexOf("'/__sp/first-screen.js'");
  const iSkin = BRIDGE.indexOf("'/__sp/skin-layer.js'");
  assert.ok(iFirst > 0 && iSkin > 0 && iFirst < iSkin, 'it loads before skin (skin stays the last UI layer)');
  assert.ok(BRIDGE.slice(iSkin - 120, iSkin).includes('window.__SP_SKIN'), 'the skin guard window stays clear');
  assert.ok(BRIDGE.includes('f.open()'), 'the auto-open tries the full-screen first interface first');
  assert.ok(BRIDGE.includes("s.openPanel('preload')"), 'and falls back to the window\'s own first screen');
});
