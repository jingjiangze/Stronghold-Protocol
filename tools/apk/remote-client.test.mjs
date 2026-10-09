// 服务端界面开关（「用该服自有客户端」）—— 业主口径 2026-10-08：**默认服务端界面**，设置里可改回本地。
//
// 这条链是 Java 侧的既有能力（MainActivity.remoteClientFor(host) / ShellBridge.useRemoteClient(id,on)）。
// 2026-10-09（业主口径「界面来源去掉」）：页面侧 UI 已全部移除，由 Java 的 RemoteClientPolicy 决定
// （服务端界面优先、首页恒本地）。本层只保留纯决策函数（gate / plan / caps / 偏好读写 / 生效态）；
// 渲染层不再有开关，下面只钉「不再出现」。测试分三层：
//   ① 纯函数 harness（真 import 真 shellPanels.js）：gate / plan / 偏好读写 / 生效态；
//   ② 真渲染 harness（mountShellPanelHost + openPanel）：页面侧已无开关 UI，只断言「不再出现」；
//   ③ 与 Java 判定的静态一致性：id 语义（签名清单条目 id，不是 host）、pref 键、默认值、标注字段。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'shellPanels.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-bridge.js'), 'utf8');
const JAVA = fs.readFileSync(path.join(here, '..', '..', 'android', 'app', 'src', 'main', 'java',
  'icu', 'jiangjiangze', 'stronghold', 'MainActivity.java'), 'utf8');
// APK 轴的纯决策表（Android-free）：默认值 + 两道硬门 + 热更健康不变量都在这里，JVM 有测试
// （tools/apk/jvm/RemoteClientCheck.java）。热层必须与它保持同一语义，所以也读进来做静态一致性。
const RC_POLICY = fs.readFileSync(path.join(here, '..', '..', 'android', 'app', 'src', 'main', 'java',
  'icu', 'jiangjiangze', 'stronghold', 'RemoteClientPolicy.java'), 'utf8');

// ---- module-tree stubs (same shape as shell-panels.test.mjs) ---------------------------------------
const COMPONENTS_STUB = [
  "export const html = (strings, ...vals) => ({ __stub: 'vnode', strings: Array.from(strings), vals });",
  'export function Modal(p) { return html`<div class="modal">${(p && p.title) || ""}</div>`; }',
  'export function Button() { return html`<button></button>`; }',
  'export function MicroLabel() { return html`<span></span>`; }',
].join('\n');
const HOOKS_STUB = [
  "export function useState(v) { return [typeof v === 'function' ? v() : v, function () {}]; }",
  'export function useEffect() {}',
].join('\n');
const TOASTS_STUB = 'export function toast(t) {}';
const STORE_STUB = 'export const store = { get: function () { return {}; } };';
const HTM_STUB = 'export default function htm(bind) { return function () { return { __htm: true }; }; }';
const PREACT_STUB = [
  "export function h() { return { __h: true }; }",
  'function flat(v) {',
  "  if (v === null || v === undefined || v === false || v === true) return '';",
  "  if (typeof v === 'string' || typeof v === 'number') return String(v);",
  "  if (Array.isArray(v)) { var s = ''; for (var i = 0; i < v.length; i++) s += flat(v[i]); return s; }",
  "  if (typeof v === 'function') {",
  "    if (!v.prototype) return '';",
  "    try { return flat(v({})); } catch (e) { return ''; }",
  '  }',
  "  if (typeof v === 'object' && v.__stub === 'vnode') {",
  "    var out = '';",
  '    for (var j = 0; j < v.strings.length; j++) { out += v.strings[j]; if (j < v.vals.length) out += flat(v.vals[j]); }',
  '    return out;',
  '  }',
  "  return '';",
  '}',
  'export function render(vnode, container) {',
  '  var text = flat(vnode);',
  '  var kids = container._kids || (container._kids = []);',
  '  var el = null;',
  '  for (var i = 0; i < kids.length; i++) if (kids[i] && kids[i].__spPanel) { el = kids[i]; break; }',
  '  if (!el) {',
  "    el = { __spPanel: true, textContent: '', _attrs: {}, _kids: [], style: {},",
  '      getAttribute: function (n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; },',
  '      setAttribute: function (n, v) { this._attrs[n] = String(v); },',
  '      appendChild: function (c) { this._kids.push(c); c.parentNode = this; return c; } };',
  '    container.appendChild(el);',
  '  }',
  '  el.textContent = text;',
  '  container.__spPanelText = text;',
  '  return el;',
  '}',
].join('\n');

function mkTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remoteclient-'));
  const w = (rel, text) => {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  w('package.json', JSON.stringify({ type: 'module' }));
  w('public/js/ui/shellPanels.js', SRC);
  w('public/js/ui/components.js', COMPONENTS_STUB);
  w('public/js/ui/toasts.js', TOASTS_STUB);
  w('public/js/store.js', STORE_STUB);
  w('public/vendor/hooks.module.js', HOOKS_STUB);
  w('public/vendor/htm.module.js', HTM_STUB);
  w('public/vendor/preact.module.js', PREACT_STUB);
  return root;
}

/** 极简 window/document/localStorage 桩（含外壳桥）。opts.shellCaps: {useRemoteClient, current, setDefault} */
function mkEnv(opts = {}) {
  const created = [];
  const mkNode = (tag) => ({
    tagName: String(tag).toUpperCase(), _attrs: {}, _kids: [], style: {},
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n); },
    appendChild(c) { this._kids.push(c); c.parentNode = this; return c; },
  });
  const ls = { _m: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null; }, setItem(k, v) { this._m[k] = String(v); } };
  const calls = [];
  const entries = [
    { id: 'raiya', name: 'raiya服', enabled: true, signed: true, remoteClient: false, current: true, app: '0.1.2', rttMs: 40 },
    { id: 'lunar', name: 'Lunar', enabled: true, remoteClient: false, current: false, app: '', rttMs: 90 },
    { id: 'off', name: '已停用服', enabled: false, remoteClient: false, current: false, app: '', rttMs: -1 },
    { id: 'cf', name: 'CF 房间制', enabled: true, roomScoped: true, remoteClient: false, current: false, app: '', rttMs: 30 },
  ];
  const shell = {
    getServerList() { return JSON.stringify({ source: '远端清单', loading: false, updated: '', entries }); },
    refreshServerList() { /* no-op */ },
    setServer(id) { calls.push(['setServer', id]); },
    useRemoteClient(id, on) { calls.push(['useRemoteClient', id, on]); },
  };
  if (opts.current) shell.remoteClientCurrent = () => opts.current;
  // 真机上 payload 的 remoteClient 标注与 remoteClientCurrent() 同源（都是 remoteClientFor(host)），
  // 桩里保持这个一致性，否则测的是自相矛盾的输入。
  if (opts.current === '1') entries[0].remoteClient = true;
  if (opts.setDefault) shell.setRemoteClientDefault = (on) => calls.push(['setRemoteClientDefault', on]);
  const win = {
    _ls: {},
    shell,
    localStorage: ls,
    addEventListener(t, fn) { (this._ls[t] = this._ls[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = this._ls[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    dispatchEvent(ev) { const a = (this._ls[ev.type] || []).slice(); for (const f of a) f(ev); return true; },
  };
  // shell-bridge.js 的适配层：真机上是它把 __SP_SHELL.useRemoteClient / remoteClientEscape 挂上去的。
  win.__SP_SHELL = {};
  if (opts.adapter !== false) {
    win.__SP_SHELL.useRemoteClient = (id, on) => { calls.push(['useRemoteClient', id, on]); return true; };
    if (opts.current) win.__SP_SHELL.remoteClientEscape = true;
    if (opts.setDefault) win.__SP_SHELL.setRemoteClientDefault = (on) => calls.push(['setRemoteClientDefault', on]);
  }
  const document = {
    body: mkNode('body'),
    createElement(tag) { const el = mkNode(tag); created.push(el); return el; },
    querySelector(sel) {
      if (sel === '[data-sp-panel-host]') return created.find((e) => e.getAttribute('data-sp-panel-host') !== null) || null;
      return null;
    },
  };
  return { win, document, created, mkNode, calls, entries };
}

/** 载入真模块 + 装好全局桩；返回 { m, env, restore }。 */
async function loadWith(env) {
  const prev = { window: globalThis.window, document: globalThis.document, CustomEvent: globalThis.CustomEvent };
  globalThis.window = env.win;
  globalThis.document = env.document;
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  const root = mkTree();
  const m = await import(pathToFileURL(path.join(root, 'public', 'js', 'ui', 'shellPanels.js')).href);
  await m.whenDepsReady();
  const restore = () => {
    if (prev.window === undefined) delete globalThis.window; else globalThis.window = prev.window;
    if (prev.document === undefined) delete globalThis.document; else globalThis.document = prev.document;
    if (prev.CustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = prev.CustomEvent;
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { m, env, restore };
}

const CAPS_ALL = { app: true, bridge: true, escape: true, default: true };
const ROW = { id: 'raiya', name: 'raiya服', signed: true, enabled: true, remoteClient: false, current: true };

// ---------------------------------------------------------------------------------------------------
// ① 纯函数：能力门（只对能生效的服可开；不能生效的服禁用 + 原因）
// ---------------------------------------------------------------------------------------------------

test('能力门：网页版（无 shell）→ 禁用，原因写「仅在 App 内可用」', async () => {
  const env = mkEnv();
  delete env.win.shell;
  const { m, restore } = await loadWith(env);
  try {
    const g = m.remoteClientGate(ROW, m.remoteClientCaps());
    assert.equal(g.ok, false);
    assert.match(g.reason, /App/);
    assert.equal(g.onOk, false);
  } finally { restore(); }
});

test('能力门：旧 APK（有桥、没有原生退出口）→ 关可以、开不行（绝不把用户锁在服务器页里）', async () => {
  const env = mkEnv({ current: null }); // 有 useRemoteClient，但没有 remoteClientCurrent
  const { m, restore } = await loadWith(env);
  try {
    const caps = m.remoteClientCaps();
    assert.equal(caps.bridge, true);
    assert.equal(caps.escape, false);
    const g = m.remoteClientGate(ROW, caps);
    assert.equal(g.ok, true, '开关本身可用（关是退路）');
    assert.equal(g.onOk, false, '开启方向被能力门挡住');
    assert.match(g.onReason, /更新 App/);
    // 已经开着的行必须能关回来
    assert.equal(m.remoteClientPlan({ ...ROW, remoteClient: true }, caps).ok, true);
    assert.equal(m.remoteClientPlan({ ...ROW, remoteClient: true }, caps).on, false);
  } finally { restore(); }
});

test('能力门：新 APK（有原生退出口）→ 开与关都放行', async () => {
  const env = mkEnv({ current: '0', setDefault: true });
  const { m, restore } = await loadWith(env);
  try {
    const caps = m.remoteClientCaps();
    assert.deepEqual(caps, { app: true, bridge: true, escape: true, default: true });
    assert.deepEqual(m.remoteClientGate(ROW, caps), { ok: true, reason: '', onOk: true, onReason: '' });
  } finally { restore(); }
});

test('能力门：只对签名清单条目放行 —— 自定义/局域网/本机/自动/房间制/停用/对局中都是禁用+原因', async () => {
  const env = mkEnv({ current: '0' });
  const { m, restore } = await loadWith(env);
  try {
    const cases = [
      [{ ...ROW, id: 'custom' }, /没有自有客户端/],
      [{ ...ROW, id: 'local' }, /没有自有客户端/],
      [{ ...ROW, id: 'auto' }, /没有自有客户端/],
      [{ ...ROW, id: '' }, /没有自有客户端/],
      [{ ...ROW, signed: false }, /签名服务器清单/],
      [{ ...ROW, roomScoped: true }, /房间制/],
      [{ ...ROW, enabled: false }, /已停用/],
      [{ ...ROW, locked: true }, /对局进行中/],
    ];
    for (const [row, re] of cases) {
      const g = m.remoteClientGate(row, CAPS_ALL);
      assert.equal(g.ok, false, '必须禁用：' + JSON.stringify(row));
      assert.match(g.reason, re);
    }
  } finally { restore(); }
});

test('计划：取反（幂等）—— 点两次回到原状态，且不会对同值重复调桥', async () => {
  const env = mkEnv({ current: '0' });
  const { m, restore } = await loadWith(env);
  try {
    const off = { ...ROW, remoteClient: false };
    const p1 = m.remoteClientPlan(off, CAPS_ALL);
    assert.deepEqual({ ok: p1.ok, on: p1.on, id: p1.id }, { ok: true, on: true, id: 'raiya' });
    // 应用后（on=true）再点一次 → 回到 false
    const p2 = m.remoteClientPlan({ ...off, remoteClient: p1.on }, CAPS_ALL);
    assert.equal(p2.on, false);
    assert.equal(p2.on, off.remoteClient, '两次点击 = 原状态（可逆）');
    assert.equal(p2.id, 'raiya', 'id 始终是签名清单条目 id（不是 host）');
    assert.match(p2.note, /重新加载/);
  } finally { restore(); }
});

test('计划：非当前服关闭时不触发导航，只写偏好（note 说明下次进入生效）', async () => {
  const env = mkEnv({ current: '1' });
  const { m, restore } = await loadWith(env);
  try {
    const p = m.remoteClientPlan({ ...ROW, id: 'lunar', name: 'Lunar', current: false, remoteClient: true }, CAPS_ALL);
    assert.equal(p.on, false);
    assert.match(p.note, /下次进入/);
  } finally { restore(); }
});

// ---------------------------------------------------------------------------------------------------
// ② 偏好：默认关（本地客户端优先）、可逆、幂等、sp.pref.* 命名空间
// ---------------------------------------------------------------------------------------------------

test('偏好：默认 = 本地客户端（off），键名走 sp.pref.* 命名空间', async () => {
  const env = mkEnv({ current: '0' });
  const { m, restore } = await loadWith(env);
  try {
    assert.equal(m.REMOTE_CLIENT_PREF, 'remoteClient');
    // 业主 2026-10-09 紧急口径：默认必须是本地客户端——首页永远是我们自己的界面
    assert.equal(m.readRemoteClientPref(), false, '默认必须是本地客户端优先（服务端界面逐服显式开启）');
    assert.equal(env.win.localStorage.getItem('sp.pref.remoteClient'), null, '默认值不写盘（靠缺省）');
    m.writeRemoteClientPref(false);
    assert.equal(env.win.localStorage.getItem('sp.pref.remoteClient'), 'false');
    assert.equal(m.readRemoteClientPref(), false);
    m.writeRemoteClientPref(false); // 幂等
    assert.equal(m.readRemoteClientPref(), false);
    m.writeRemoteClientPref(true);
    assert.equal(m.readRemoteClientPref(), true, '显式选「服端」才切过去');
  } finally { restore(); }
});

test('偏好：写盘损坏/不可读时退回默认 off（绝不抛）', async () => {
  const env = mkEnv({ current: '0' });
  const { m, restore } = await loadWith(env);
  try {
    env.win.localStorage.setItem('sp.pref.remoteClient', '{not json');
    assert.equal(m.readRemoteClientPref(), false);
  } finally { restore(); }
});

test('偏好：新 APK 上同时把默认值交给 Java 拦截器（remoteClientFor 的缺省来源）', async () => {
  const env = mkEnv({ current: '0', setDefault: true });
  const { m, restore } = await loadWith(env);
  try {
    m.writeRemoteClientPref(false);
    assert.deepEqual(env.calls.filter((c) => c[0] === 'setRemoteClientDefault'), [['setRemoteClientDefault', false]]);
  } finally { restore(); }
});

test('偏好：旧 APK（没有 setRemoteClientDefault）只写本地偏好，绝不报错', async () => {
  const env = mkEnv({ current: null });
  const { m, restore } = await loadWith(env);
  try {
    assert.equal(m.remoteClientCaps().default, false);
    assert.doesNotThrow(() => m.writeRemoteClientPref(true));
    assert.equal(env.calls.length, 0);
  } finally { restore(); }
});

test('生效态：优先问原生（拦截器读的就是它），退化到清单里当前条目的 remoteClient 标注', async () => {
  const envOn = mkEnv({ current: '1' });
  const a = await loadWith(envOn);
  try { assert.equal(a.m.remoteClientEffective(), 'on'); } finally { a.restore(); }
  const envOff = mkEnv({ current: '0' });
  const b = await loadWith(envOff);
  try { assert.equal(b.m.remoteClientEffective(), 'off'); } finally { b.restore(); }
  // 老壳没有 remoteClientCurrent → 用清单里 current 条目的 remoteClient
  const envOld = mkEnv({ current: null });
  envOld.entries[0].remoteClient = true;
  const c = await loadWith(envOld);
  try { assert.equal(c.m.remoteClientEffective(), 'on'); } finally { c.restore(); }
});

// ---------------------------------------------------------------------------------------------------
// ③ 真渲染：服务器面板 + 设置面板里真的出现这些行（不是只在源码里）
// ---------------------------------------------------------------------------------------------------

test('渲染：服务器面板不再出现「服务端界面」小节（页面侧开关已移除，由 Java 决定）', async () => {
  const env = mkEnv({ current: '1' });
  const { m, restore } = await loadWith(env);
  try {
    const container = env.mkNode('div');
    const host = await m.mountShellPanelHost(container);
    m.openShellPanel('servers');
    const text = String(host.__spPanelText || '');
    assert.ok(!text.includes('服务端界面'), '页面侧不再有「服务端界面」小节：' + text);
    assert.ok(!text.includes('当前实际使用：'), '不再显示生效态（无切换入口）');
    assert.ok(!/data-sp-rc=/.test(SRC), '逐行开关的 data-sp-rc 已移除');
    assert.ok(!SRC.includes('callUseRemoteClient'), '页面不再有调桥的 callUseRemoteClient（由 Java 决定）');
    assert.match(text, /服务器清单/, '服务器清单本身仍渲染（面板没有整块消失）');
    m.openShellPanel(null);
  } finally { restore(); }
});

test('渲染：服务器面板仍渲染清单（页面侧开关移除后不整块消失）', async () => {
  const env = mkEnv({ current: null });
  const { m, restore } = await loadWith(env);
  try {
    const container = env.mkNode('div');
    const host = await m.mountShellPanelHost(container);
    m.openShellPanel('servers');
    const text = String(host.__spPanelText || '');
    assert.match(text, /服务器/, '服务器面板仍在');
    assert.ok(!text.includes('需更新 App'), '不再有开关的禁用文案（开关已移除）');
    m.openShellPanel(null);
  } finally { restore(); }
});

test('渲染：设置面板不再出现「界面来源」开关（业主 2026-10-09 口径：页面侧 UI 去掉）', async () => {
  const env = mkEnv({ current: '0' });
  const { m, restore } = await loadWith(env);
  try {
    const container = env.mkNode('div');
    const host = await m.mountShellPanelHost(container);
    m.openShellPanel('appearance');
    const text = String(host.__spPanelText || '');
    assert.ok(!text.includes('界面来源'), '设置面板不再有「界面来源」：' + text);
    assert.ok(!text.includes('服务端界面'), '不再有「服务端界面」选项');
    assert.ok(!SRC.includes('ServerUiRow'), 'ServerUiRow 已移除');
    assert.ok(!SRC.includes('SERVER_UI_SEG'), 'SERVER_UI_SEG 已移除');
    // 外观设置本身仍在（面板没有整块消失）
    assert.match(text, /设置/, '设置面板标题仍在');
    assert.match(text, /字体大小/, '字体大小行仍在');
    m.openShellPanel(null);
  } finally { restore(); }
});

// ---------------------------------------------------------------------------------------------------
// ④ 与 Java 判定的静态一致性（跨轴：hot 层不能与 APK 侧的语义漂移）
// ---------------------------------------------------------------------------------------------------

test('Java 一致性：id = 签名清单条目 id（findEntry），host 由 Java 自己解析，域名不下发到页面', () => {
  assert.match(JAVA, /public void useRemoteClient\(String id, boolean on\)/,
    '桥的签名必须是 useRemoteClient(String id, boolean on)');
  const body = JAVA.slice(JAVA.indexOf('public void useRemoteClient(String id, boolean on)'));
  assert.match(body.slice(0, 400), /ServerList\.Entry e = findEntry\(id\);/,
    'id 必须经 findEntry(id) 解析成清单条目（所以自定义/局域网线路没有条目 → 空操作）');
  assert.match(body.slice(0, 400), /String h = hostOf\(e\.url\);/,
    'host 由 Java 从条目 url 解析（页面永远拿不到域名）');
  assert.ok(!/o\.put\("url"/.test(JAVA.slice(JAVA.indexOf('public String getServerList()'), JAVA.indexOf('public void refreshServerList()'))),
    '面板 payload 不许下发 url');
});

test('Java 一致性：缺省 = 全局默认 remote-client-default（默认 true）；逐 host 显式值优先', () => {
  // 默认值不再内联在 remoteClientFor：缺省来源是全局默认键，逐 host 偏好「显式写过」才算数。
  assert.match(JAVA, /RemoteClientPolicy\.resolve\(\s*host,/,
    'remoteClientFor 必须经纯决策表（默认值 + 两道硬门都在 RemoteClientPolicy）');
  assert.match(JAVA, /prefs\.contains\(key\)/,
    '逐 host 偏好必须按「显式设置过」判定（否则全局默认永远接管，设置里改不动）');
  assert.match(JAVA, /prefs\.getBoolean\(RemoteClientPolicy\.PREF_DEFAULT, RemoteClientPolicy\.defaultGlobal\(\)\)/,
    '未显式设置过的 host 用全局默认');
  assert.match(RC_POLICY, /PREF_DEFAULT = "remote-client-default"/,
    '全局默认键必须是 remote-client-default（页面 setRemoteClientDefault 写的就是它）');
  assert.match(RC_POLICY, /defaultGlobal\(\)\s*\{[\s\S]{0,400}?return true;/,
    '全局默认缺省值必须是 true（业主 2026-10-09 口径：连接服务器时首页之外按服务器正常显示）');
  // 缺省 true 只有在首页作用域门存在时才安全 —— 门没了这条默认就会把首页交给服务器。
  assert.match(RC_POLICY, /isHomePath\(/, '首页判定必须存在（首页恒本地的落点）');
  assert.match(RC_POLICY, /\/index\.html"\.equals\(path\)/,
    'isHomePath 必须把 /index.html 也算首页（否则那种形式的首页导航会被交给服务器）');
  assert.match(JAVA, /item\.put\("remoteClient", host != null && remoteClientFor\(host\)\)/,
    '面板 payload 必须带 remoteClient 标注（UI 的生效态来源）');
});

test('Java 一致性：两道硬门 —— 只对已知服务器 host，且本机/局域网永远走内嵌树', () => {
  assert.match(JAVA, /isKnownServerHost\(host\)/,
    '硬门①：不是已知服务器 host 一律 false（任意第三方页面保持今天的行为）');
  assert.match(RC_POLICY, /HostPolicy\.isPublicHost\(host\)/,
    '硬门②：公网可寻址才放行（环回/私网/保留/.local/.internal 永远保留内嵌树）');
  // 与 ServerList 是同一张表：服务端界面的门不许比 URL 准入更松。
  const SERVER_LIST = fs.readFileSync(path.join(here, '..', '..', 'android', 'app', 'src', 'main',
    'java', 'icu', 'jiangjiangze', 'stronghold', 'ServerList.java'), 'utf8');
  assert.match(SERVER_LIST, /HostPolicy\.isPublicHost\(u\.getHost\(\)\)/,
    'ServerList.isPublicHttpUrl 必须与 HostPolicy 共用同一张表（否则两张表迟早漂移）');
});

test('Java 一致性：原生退出口「回到本地客户端」+ 页面探测的两个桥方法都在', () => {
  assert.match(JAVA, /回到本地客户端/,
    'showShellMenu 必须有原生退出口（远程页跳过 SHELL_INJECT，页内点不到设置）');
  assert.match(JAVA, /public String remoteClientCurrent\(\)/,
    'remoteClientCurrent() 必须在（页面据它的存在判定「有原生退出口」→ 放行开启方向）');
  assert.match(JAVA, /public void setRemoteClientDefault\(boolean on\)/,
    'setRemoteClientDefault() 必须在（设置里的默认值交给 Java 拦截器）');
  // 退出口写的是显式 false（不是 remove）：全局默认是 true，remove 会立刻又判成 true。
  assert.match(JAVA, /private void returnToLocalClient\(\)[\s\S]{0,600}?setRemoteClient\(h, false\)/,
    '退出口必须显式写 false（粘性覆盖全局默认）');
});

test('Java 一致性：热更健康确认覆盖服务端界面路径（否则下次冷启动回滚）', () => {
  assert.match(JAVA, /RemoteClientPolicy\.healthy\(pageServedFromLocalTree, remoteClientPage, mainFrameErrored\)/,
    'onPageFinished 必须用两条路径的健康判定（本地树 或 服务端界面主帧成功落地）');
  assert.match(JAVA, /mainFrameErrored = true/,
    '主帧 onReceivedError 必须置失败标记（远程页加载失败不能算健康）');
  assert.match(RC_POLICY, /return pageFromLocalTree \|\| \(remoteClientPage && !mainFrameErrored\);/,
    '健康不变量：本地树渲染 或（服务端界面主帧落地且未报错）；两者都不成立则保留回滚');
});

test('Java 一致性：服务器页面的主帧注入外壳（钩子/面板在），其资源全部放行给服务器', () => {
  // 2026-10-09 口径（业主）：「连接服务器：仅首页页面叠加，其他 ui 按服务器正常显示，静态资源走 web 缓存」。
  // ① 首页之外的**主帧导航** → 取回该服页面并注入外壳（fail-open：注入失败返回 null 交回 WebView）。
  //    作用域判定必须**带 query**（scopePath）—— `/?room=X` 是进房深链，丢了 query 会被判成首页。
  assert.match(JAVA, /if \(serverUi && knownServerHost && mainFrameHtml[\s\S]{0,400}?scopeAllows\(host,[\s\S]{0,140}?scopePath\(rawPath, url\.getQuery\(\)\)[\s\S]{0,20}?,\s*true\)\)\s*\{[\s\S]{0,300}?return fetchAndInjectMainFrame\(url\.toString\(\)\);/,
    '服务器页面的主帧必须先问作用域（带 query）、再注入外壳并返回（不是裸放行）');
  // ② 服务器页面上的其余请求 → 放行（服务器 + WebView web 缓存）。
  assert.match(JAVA, /if \(serverUi && knownServerHost && currentOrigin && !pageServedFromLocalTree && !mainFrameHtml\)\s*\{[\s\S]{0,120}?return null;/,
    '服务器页面的静态资源必须放行到服务器（走 web 缓存）');
  // ③ 标记：走进服务器页面时先把「页面来自本地树」清掉，否则那一页的资源会被本地树截胡。
  const branch = JAVA.slice(JAVA.indexOf('boolean serverUi = remoteClientFor(host);'));
  assert.match(branch.slice(0, 900), /pageServedFromLocalTree = false;/,
    '服务器页面的主帧分支必须把 pageServedFromLocalTree 置 false（页面来源决定资源来源）');
});

test('Java 一致性：不可达自动回退本地树（现有 onReceivedError 兜底）', () => {
  assert.match(JAVA, /ensureHostAndSwitch\(true\);/, '主帧加载失败必须兜底到本地服务（→ 127.0.0.1 → 本地树）');
});

test('适配层：shell-bridge.js 包装 useRemoteClient 并探测原生退出口', () => {
  assert.match(BRIDGE, /__SP_SHELL\.useRemoteClient = function/);
  assert.match(BRIDGE, /__SP_SHELL\.remoteClientEscape = typeof NATIVE\.remoteClientCurrent === 'function'/);
  assert.match(BRIDGE, /__SP_SHELL\.setRemoteClientDefault = function/);
});

test('渲染/结构：serverCell 不再渲染服务端界面开关（页面侧开关已移除）', () => {
  const start = SRC.indexOf('function serverCell(');
  const body = SRC.slice(start, SRC.indexOf('\nfunction ', start + 1));
  assert.ok(body.length > 0, 'serverCell 仍在');
  assert.ok(!body.includes('${rc}') && !body.includes('remoteClientChip'), '不再渲染开关胶囊');
  assert.ok(!body.includes('onRc'), '不再有 onRc 参数');
});

test('样式：开关胶囊样式已移除（无死 CSS）', () => {
  const start = SRC.indexOf('function srvStyleCss()');
  const css = SRC.slice(start, SRC.indexOf('.join(\'\')', start));
  assert.ok(!css.includes('.sp-srv-rc'), '页面侧开关的样式已随 UI 一并移除');
  assert.ok(css.includes('.sp-srv-name{'), '服务器行其余样式仍在');
});

// ---------------------------------------------------------------------------------------------------
// 首页守卫（业主 2026-10-09 紧急口径：「去掉开屏的自动测速选择服务器」「必须保证首页是我的 ui」）
// ---------------------------------------------------------------------------------------------------

test('首页守卫：开屏不探测线路、不自动切服（自动线路只在面板里显式点）', () => {
  const boot = JAVA.slice(JAVA.indexOf('new Thread(() -> {'), JAVA.indexOf('"shell-boot"'));
  assert.ok(!boot.includes('probeBestLine()'), '开屏线程不许调 probeBestLine（会自动跳到别人服务器）');
  assert.ok(!boot.includes('正在选择最优线路'), '开屏不许再显示「正在选择最优线路…」');
  assert.ok(boot.includes('loadBase(origin)'), '开屏只加载本地/上次线路');
  // 显式动作仍在（面板里的「自动线路」）：探测函数本身不许被删掉
  assert.ok(JAVA.includes('probeBestLine()'), '面板的自动线路仍要能探测');
  assert.ok(JAVA.includes('shell-auto-line'), '自动线路的显式入口保留');
});

test('首页守卫：老 APK 上页面把「界面来源」缺省下推成本地客户端', () => {
  const bridge = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-bridge.js'), 'utf8');
  assert.ok(bridge.includes('setRemoteClientDefault(false)'), 'shell-bridge 要把缺省下推成 false');
  assert.ok(bridge.includes("getItem('sp.pref.remoteClient')"), '只在玩家没显式选过时下推（不覆盖玩家选择）');
});

// ---------------------------------------------------------------------------------------------------
// 作用域门（业主口径 2026-10-09：「服务端界面是首页之外的内容由服务器加载，依旧是本地首页」）
// ---------------------------------------------------------------------------------------------------

test('作用域门：服务端界面放行点必须先看路径（首页恒本地）', () => {
  // 拦截器里那两个「交给服务器」的分支，都必须同时问作用域（路径级）——不能只看 host。
  assert.ok(/serverUi && knownServerHost && mainFrameHtml[\s\S]{0,400}?scopeAllows\(host,[\s\S]{0,140}?scopePath\(rawPath, url\.getQuery\(\)\)/.test(JAVA),
    '主帧放行点必须是「serverUi + 已知服 + 主帧 + scopeAllows(host, scopePath(path,query), …)」——query 必须带上（/?room= 是进房深链）');
  // 不许残留裸放行（老写法会让首页也被顶掉）
  assert.ok(!/if \(remoteClientFor\(host\)\) return null;/.test(JAVA),
    '不许再出现只看 host 的裸放行');
  // 首页判定必须来自纯决策表（isHomePath），不许在拦截器里另写一份 "/" 比较。
  assert.ok(!/rawPath\.equals\("\/"\)/.test(JAVA),
    '首页判定必须走 RemoteClientPolicy.isHomePath（单一真源），拦截器里不许另写一份');
});

test('作用域门：纯决策表有 scopeAllows / isHomePath / isSubPagePath，且首页（含 /index.html）不放行', () => {
  assert.ok(/public static boolean scopeAllows\(/.test(RC_POLICY), 'RemoteClientPolicy 必须有 scopeAllows');
  assert.ok(/public static boolean isHomePath\(/.test(RC_POLICY), 'RemoteClientPolicy 必须有 isHomePath');
  assert.ok(/public static boolean isSubPagePath\(/.test(RC_POLICY), 'RemoteClientPolicy 必须有 isSubPagePath');
  const home = RC_POLICY.slice(RC_POLICY.indexOf('public static boolean isHomePath'));
  const fn = home.slice(0, home.indexOf('}', home.indexOf('{')));
  assert.ok(fn.includes('"/".equals(path)'), '"/" 必须判为首页');
  assert.ok(fn.includes('"/index.html".equals(path)'),
    '/index.html 必须判为首页（首页文档的规范路径；漏了它那种入口下的首页会被交给服务器）');
  assert.ok(fn.includes('"/index.htm".equals(path)'), '/index.htm 同样算首页');
  // 子页面判定必须**由首页判定派生**（两处各写一份迟早会漂移）
  const sub = RC_POLICY.slice(RC_POLICY.indexOf('public static boolean isSubPagePath'));
  assert.ok(sub.slice(0, sub.indexOf('}')).includes('!isHomePath('),
    'isSubPagePath 必须是 !isHomePath(path)（单一真源）');
});

test('作用域门：JVM harness 覆盖了首页与子页面两组用例', () => {
  const jvm = fs.readFileSync(path.join(here, 'jvm', 'RemoteClientCheck.java'), 'utf8');
  assert.ok(jvm.includes('testHomeAlwaysLocal'), 'JVM 必须有首页守卫用例');
  assert.ok(jvm.includes('scopeAllows(H, "/", true)'), '必须断言站点根不放行');
  assert.ok(jvm.includes('scopeAllows(H, "/play", true)'), '必须断言 /play 放行');
});
