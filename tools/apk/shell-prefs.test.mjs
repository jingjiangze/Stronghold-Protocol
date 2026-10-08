// shell-prefs 的行为测试：vm + 最小 localStorage / 保险库桩，真跑一遍启动合并、写穿与迁移。
//
// 覆盖：启动按 ts 取新（保险库胜平局）/ 本地更新则胜并回灌保险库 / 首次迁移（localStorage →
//       保险库）/ 缺保险库时纯 localStorage 降级（绝不抛）/ set 写穿两处 / 外观与传输的 legacy
//       迁移 / 未知键的 sp.pref.<key> 兜底 / 幂等 / 源码不变量（纯 ASCII、ES5）。
// 另含一条加载顺序断言：MainActivity 先注入 player-data.js 再 shell-bridge.js（外观才能在首帧前
// 读到保险库），以及 shell-bridge 里 shell-prefs.js 早于 appearance.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-prefs.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-bridge.js'), 'utf8');
const ACTIVITY = fs.readFileSync(path.join(here, '..', '..', 'android', 'app', 'src', 'main', 'java',
  'icu', 'jiangjiangze', 'stronghold', 'MainActivity.java'), 'utf8');

function mkLS(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    _map: m,
  };
}

/** 最小保险库桩：语义与 player-data.js 的 doc.prefs 一致（{key:{value,ts}}，深拷贝出入）。 */
function mkVault(initial = {}, opts = {}) {
  const settings = {};
  for (const k of Object.keys(initial)) settings[k] = { value: JSON.parse(JSON.stringify(initial[k].value)), ts: initial[k].ts };
  const jc = (v) => JSON.parse(JSON.stringify(v));
  return {
    _settings: settings,
    _flushed: 0,
    _doc: opts.doc || { v: 1, settings: null },
    prefsGet(k) { return Object.prototype.hasOwnProperty.call(settings, k) ? jc(settings[k].value) : undefined; },
    prefsStamp(k) { return Object.prototype.hasOwnProperty.call(settings, k) ? settings[k].ts : 0; },
    prefsSet(k, v, ts) { if (opts.throwOnSet) throw new Error('boom'); settings[k] = { value: jc(v), ts: (typeof ts === 'number' ? ts : 0) }; return true; },
    prefsRemove(k) { const had = Object.prototype.hasOwnProperty.call(settings, k); delete settings[k]; return had; },
    exportJSON() { return JSON.stringify(this._doc); },
    flush() { this._flushed += 1; },
  };
}

function run(opts = {}) {
  const clock = { t: opts.now ?? 1_700_000_000_000 };
  const win = { localStorage: opts.ls || mkLS(), addEventListener() {} };
  if (opts.vault !== null) win.__SP_DATA = opts.vault || mkVault();
  if (opts.shell) win.shell = opts.shell;
  const sandbox = { window: win, Date: { now: () => clock.t }, JSON, Object, Array, console };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'shell-prefs.js' });
  return { win, api: win.__SP_PREFS, clock };
}

const plain = (v) => (v === undefined || v === null) ? v : JSON.parse(JSON.stringify(v));
const get = (api, k) => plain(api.get(k));
const vaultVal = (v, k) => plain(v._settings[k] ? v._settings[k].value : undefined);
const vaultTs = (v, k) => (v._settings[k] ? v._settings[k].ts : 0);

// ---- boot precedence ---------------------------------------------------------------------------

test('启动：保险库有值、本地也有 → 按 ts 取新（保险库胜平局）', () => {
  const vault = mkVault({ appearance: { value: { fontScale: 1.25, sidePad: 8 }, ts: 100 } });
  const ls = mkLS({ 'sp.appearance': JSON.stringify({ fontScale: 0.85, sidePad: 0, ts: 100 }) });
  const { api } = run({ vault, ls });
  assert.deepEqual(get(api, 'appearance'), { fontScale: 1.25, sidePad: 8 }, '平局必须归保险库');
  assert.equal(JSON.parse(ls.getItem('sp.appearance')).fontScale, 1.25, '保险库值必须回填到本地缓存');
});

test('启动：本地严格更新 → 本地胜，并把本地回灌保险库（升级 ts）', () => {
  const vault = mkVault({ appearance: { value: { fontScale: 1.25, sidePad: 8 }, ts: 100 } });
  const ls = mkLS({ 'sp.appearance': JSON.stringify({ fontScale: 0.95, sidePad: 16, ts: 200 }) });
  const { api } = run({ vault, ls });
  assert.deepEqual(get(api, 'appearance'), { fontScale: 0.95, sidePad: 16 }, '更新的本地值必须胜出');
  assert.equal(vaultTs(vault, 'appearance'), 200, '本地值必须以原 ts 回灌保险库');
  assert.deepEqual(vaultVal(vault, 'appearance'), { fontScale: 0.95, sidePad: 16 });
});

test('启动：保险库有值、本地为空 → 保险库胜并回填本地缓存（换 origin 恢复）', () => {
  const vault = mkVault({ 'notice.seen': { value: 'nh1:abc', ts: 500 } });
  const ls = mkLS();
  const { api } = run({ vault, ls });
  assert.equal(get(api, 'notice.seen'), 'nh1:abc');
  assert.equal(ls.getItem('sp.notice.seen'), 'nh1:abc', '字符串原样回填（旧读取端仍可读）');
});

// ---- migration / seed --------------------------------------------------------------------------

test('首次迁移：保险库为空、localStorage 有值 → 种入保险库并保留 ts', () => {
  const vault = mkVault();
  const ls = mkLS({ 'sp.lobby.tokens': JSON.stringify({ ABCD: 'tok-1' }) });
  const { api } = run({ vault, ls });
  assert.deepEqual(get(api, 'lobby.tokens'), { ABCD: 'tok-1' });
  assert.deepEqual(vaultVal(vault, 'lobby.tokens'), { ABCD: 'tok-1' }, 'localStorage 必须被种进保险库');
});

test('迁移：绝不拿旧的本地值盖掉更新的保险库值', () => {
  const vault = mkVault({ 'lobby.tokens': { value: { NEW: 't' }, ts: 900 } });
  const ls = mkLS({ 'sp.lobby.tokens': JSON.stringify({ OLD: 't' }) }); // 无 ts → 0
  const { api } = run({ vault, ls });
  assert.deepEqual(get(api, 'lobby.tokens'), { NEW: 't' }, '无 ts 的旧本地值不得盖掉保险库');
  assert.deepEqual(vaultVal(vault, 'lobby.tokens'), { NEW: 't' });
});

test('外观 legacy 迁移：旧 doc.settings 的 fontScale/sidePad 种入命名空间', () => {
  const vault = mkVault({}, { doc: { v: 1, settings: { fontScale: 1.15, sidePad: 8, ts: 1234 } } });
  const { api } = run({ vault, ls: mkLS() });
  assert.deepEqual(get(api, 'appearance'), { fontScale: 1.15, sidePad: 8 });
  assert.deepEqual(vaultVal(vault, 'appearance'), { fontScale: 1.15, sidePad: 8 });
});

test('外观 legacy 迁移：doc.settings 为默认值时不动命名空间', () => {
  const vault = mkVault({}, { doc: { v: 1, settings: { fontScale: 1, sidePad: 0, ts: 1234 } } });
  const { api } = run({ vault, ls: mkLS() });
  assert.equal(get(api, 'appearance'), null, '默认外观没有可迁移的东西');
});

test('传输 legacy 迁移：Java 桥 getTransport() 的档位种入命名空间（ts 0）', () => {
  const vault = mkVault();
  const { api } = run({ vault, ls: mkLS(), shell: { getTransport: () => 'lan' } });
  assert.equal(get(api, 'transport'), 'lan');
  assert.equal(vaultVal(vault, 'transport'), 'lan');
});

// ---- write-through -----------------------------------------------------------------------------

test('set 写穿：同时落本地缓存（立即）与保险库（带 ts）', () => {
  const vault = mkVault();
  const ls = mkLS();
  const { api } = run({ vault, ls, now: 7777 });
  assert.equal(api.set('lobby.difficulty', 'HARD'), true);
  assert.equal(ls.getItem('sp.pref.lobby.difficulty'), 'HARD', '字符串值原样写本地');
  assert.equal(vaultVal(vault, 'lobby.difficulty'), 'HARD', '必须写进保险库');
  assert.equal(vaultTs(vault, 'lobby.difficulty'), 7777, '必须盖上当前 ts');
});

test('set 对象值：本地缓存带 ts、保险库的值不带 ts', () => {
  const vault = mkVault();
  const ls = mkLS();
  const { api } = run({ vault, ls, now: 42 });
  api.set('server', { id: 'custom', url: 'https://x.example' });
  assert.deepEqual(JSON.parse(ls.getItem('sp.pref.server')), { id: 'custom', url: 'https://x.example', ts: 42 });
  assert.deepEqual(vaultVal(vault, 'server'), { id: 'custom', url: 'https://x.example' });
});

test('remove：三处一起清（内存 / 本地 / 保险库）', () => {
  const vault = mkVault({ 'lobby.filter': { value: 'waiting', ts: 5 } });
  const ls = mkLS({ 'sp.lobby.filter': 'waiting' });
  const { api } = run({ vault, ls });
  assert.equal(api.remove('lobby.filter'), true);
  assert.equal(get(api, 'lobby.filter'), null);
  assert.equal(ls.getItem('sp.lobby.filter'), null);
  assert.equal(vaultVal(vault, 'lobby.filter'), undefined);
});

test('未知键：回退到 sp.pref.<key> 本地缓存，set 也写穿保险库', () => {
  const vault = mkVault();
  const ls = mkLS({ 'sp.pref.anything': JSON.stringify({ a: 1 }) });
  const { api } = run({ vault, ls });
  assert.deepEqual(get(api, 'anything'), { a: 1 });
  api.set('anything', { a: 2 });
  assert.deepEqual(vaultVal(vault, 'anything'), { a: 2 });
});

// ---- vault-absent fallback ---------------------------------------------------------------------

test('缺保险库（旧 APK / 未加载 player-data）：纯 localStorage 降级，绝不抛', () => {
  const ls = mkLS();
  let out;
  assert.doesNotThrow(() => { out = run({ vault: null, ls }); });
  const { api } = out;
  assert.equal(api.available, false);
  assert.equal(get(api, 'notice.seen'), null);
  assert.doesNotThrow(() => api.set('notice.seen', 'rev-9'));
  assert.equal(ls.getItem('sp.notice.seen'), 'rev-9', '仍然写本地缓存');
  assert.equal(get(api, 'notice.seen'), 'rev-9');
  assert.doesNotThrow(() => api.set('lobby.tokens', { X: 'y' }));
  assert.deepEqual(get(api, 'lobby.tokens'), { X: 'y' });
});

test('保险库 set 抛异常时静默：会话内仍生效', () => {
  const vault = mkVault({}, { throwOnSet: true });
  const ls = mkLS();
  const { api } = run({ vault, ls });
  assert.doesNotThrow(() => api.set('notice.seen', 'rev-1'));
  assert.equal(get(api, 'notice.seen'), 'rev-1');
});

test('缺保险库启动、保险库稍后出现 → 首次读写时补跑迁移（不静默丢）', () => {
  const ls = mkLS({ 'sp.notice.seen': 'rev-late' });
  const win = { localStorage: ls, addEventListener() {} };
  vm.runInNewContext(SRC, { window: win, Date: { now: () => 1000 }, JSON, Object, Array, console });
  assert.equal(win.__SP_PREFS.available, false, '启动时确实没有保险库');
  const vault = mkVault();
  win.__SP_DATA = vault; // player-data.js 之后才落地
  assert.equal(win.__SP_PREFS.get('notice.seen'), 'rev-late');
  assert.equal(vaultVal(vault, 'notice.seen'), 'rev-late', '迟到的保险库必须补种');
});

test('幂等：二次执行不覆盖既有 API', () => {
  const ls = mkLS();
  const { win } = run({ ls });
  const first = win.__SP_PREFS;
  vm.runInNewContext(SRC, { window: win, Date: { now: () => 0 }, JSON, Object, Array, console });
  assert.equal(win.__SP_PREFS, first, '已有 __SP_PREFS 就不许重装');
});

// ---- loader order (appearance applies before first paint) --------------------------------------

test('加载顺序：MainActivity 先注入 player-data.js 再 shell-bridge.js（外观才能在首帧前读到保险库）', () => {
  const iData = ACTIVITY.indexOf("'player-data.js'");
  const iBridge = ACTIVITY.indexOf("'shell-bridge.js'");
  assert.ok(iData > 0 && iBridge > iData, 'player-data.js 必须先于 shell-bridge.js 注入');
  assert.ok(ACTIVITY.slice(iData, iBridge).includes("'shell-bridge.js'") === false,
    '确认两个 indexOf 命中不同位置（顺序断言才有意义）');
});

test('加载顺序：shell-bridge 里 shell-prefs.js 早于 appearance.js / notice-board.js / lobby.js', () => {
  const iPrefs = BRIDGE.indexOf("'/__sp/shell-prefs.js'");
  const iApp = BRIDGE.indexOf("'/__sp/appearance.js'");
  const iNb = BRIDGE.indexOf("'/__sp/notice-board.js'");
  const iLobby = BRIDGE.indexOf("'/__sp/lobby.js'");
  assert.ok(iPrefs > 0, 'shell-prefs.js 必须在装载段里');
  assert.ok(iPrefs < iApp, 'shell-prefs 早于 appearance（外观读它取持久值）');
  assert.ok(iPrefs < iNb, 'shell-prefs 早于 notice-board');
  assert.ok(iPrefs < iLobby, 'shell-prefs 早于 lobby');
  assert.ok(BRIDGE.slice(iPrefs - 120, iPrefs).includes('window.__SP_PREFS'), '幂等标记守卫');
});

// ---- source invariants -------------------------------------------------------------------------

test('源码不变量：纯 ASCII、ES5、幂等标记', () => {
  assert.ok(!/[^\x00-\x7F]/.test(SRC), '脚本必须纯 ASCII');
  assert.ok(!/=>/.test(SRC), '不许用箭头函数');
  assert.ok(!/\bconst\b/.test(SRC) && !/\blet\b/.test(SRC), '不许用 const/let');
  assert.ok(SRC.indexOf('`') < 0, '不许用模板字符串');
  assert.ok(SRC.indexOf('__SP_PREFS') >= 0);
  assert.ok(!/https?:\/\//.test(SRC), '不许出现 URL 字面量（零网络）');
  assert.ok(!/fetch\s*\(|XMLHttpRequest|WebSocket/.test(SRC), '不许出现网络请求入口');
});
