// shellPanels 依赖加固测试（审计 §3.2 M1–M4 / R-03）：四条上游模块原来是**静态 ESM import**，
// 上游一改名，整个模块加载失败 → 服务器/参数/配置/战绩四个面板整块静默消失。
// 现在改成动态 import + 逐模块垫片：单个模块缺失只降级它自己，模块始终能加载。
//
// 真执行风格：把真的 shellPanels.js 拷进一棵临时模块树（缺哪个模块就不建哪个），
// 用真的 import() 加载，断言 depsReport() 与「不抛错」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'shellPanels.js'), 'utf8');
const LOBBY = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'lobby.js'), 'utf8');

const COMPONENTS_STUB = [
  "export const html = (strings, ...vals) => ({ __stub: 'vnode', strings, vals });",
  'export function Modal() { return html`<div class="modal"></div>`; }',
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
const PREACT_STUB = 'export function h() { return { __h: true }; }';
const COMPONENTS_THROWS = "throw new Error('components.js moved upstream');";

/**
 * Build a module tree containing the REAL shellPanels.js plus the requested stubs.
 * opts keys: components | toasts | store | hooks | htm | preact | componentsThrows
 */
function mkTree(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpanels-'));
  const w = (rel, text) => {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  w('package.json', JSON.stringify({ type: 'module' }));
  w('public/js/ui/shellPanels.js', SRC);
  if (opts.components) w('public/js/ui/components.js', COMPONENTS_STUB);
  if (opts.componentsThrows) w('public/js/ui/components.js', COMPONENTS_THROWS);
  if (opts.toasts) w('public/js/ui/toasts.js', TOASTS_STUB);
  if (opts.store) w('public/js/store.js', STORE_STUB);
  if (opts.hooks) w('public/vendor/hooks.module.js', HOOKS_STUB);
  if (opts.htm) w('public/vendor/htm.module.js', HTM_STUB);
  if (opts.preact) w('public/vendor/preact.module.js', PREACT_STUB);
  return root;
}

async function load(root) {
  const entry = path.join(root, 'public', 'js', 'ui', 'shellPanels.js');
  const mod = await import(pathToFileURL(entry).href);
  await mod.whenDepsReady();
  return mod;
}

const API = ['openShellPanel', 'useShellPanel', 'QuickModes', 'registerPanel', 'ShellPanelHost', 'whenDepsReady', 'depsReport', 'depsReady'];

test('四条上游依赖都在 → 每条来源都是 upstream，API 齐全', async () => {
  const root = mkTree({ components: true, toasts: true, store: true, hooks: true });
  try {
    const m = await load(root);
    assert.deepEqual(m.depsReport(), { hooks: 'upstream', components: 'upstream', toasts: 'upstream', store: 'upstream' });
    for (const n of API) assert.ok(n in m, `missing export ${n}`);
    assert.equal(typeof m.QuickModes, 'function');
    assert.equal(typeof m.ShellPanelHost, 'function');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('四条依赖全部缺失 → 模块仍然加载（这正是旧静态 import 会整块消失的场景）', async () => {
  const root = mkTree({});
  try {
    const m = await load(root);
    assert.deepEqual(m.depsReport(), { hooks: 'shim', components: 'shim', toasts: 'shim', store: 'shim' });
    for (const n of API) assert.ok(n in m, `missing export ${n}`);
    assert.doesNotThrow(() => m.QuickModes({ onClose() {} }));
    assert.doesNotThrow(() => m.registerPanel('x', function X() { return null; }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('components.js 缺失 → 只有 components 降级（htm+preact 在时用 fallback），其余仍是 upstream', async () => {
  const root = mkTree({ toasts: true, store: true, hooks: true, htm: true, preact: true });
  try {
    const m = await load(root);
    const r = m.depsReport();
    assert.equal(r.components, 'fallback', '有 vendor/htm + vendor/preact 时应现绑 html');
    assert.equal(r.hooks, 'upstream');
    assert.equal(r.toasts, 'upstream');
    assert.equal(r.store, 'upstream');
    assert.doesNotThrow(() => m.ShellPanelHost());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('components.js 缺失且 htm/preact 也缺失 → components 退到最后手段 shim，模块仍加载', async () => {
  const root = mkTree({ toasts: true, store: true, hooks: true });
  try {
    const m = await load(root);
    assert.equal(m.depsReport().components, 'shim');
    assert.equal(m.depsReport().hooks, 'upstream');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('components.js 存在但 import 时抛错 → 被吞掉并降级，不拖垮整块', async () => {
  const root = mkTree({ componentsThrows: true, toasts: true, store: true, hooks: true, htm: true, preact: true });
  try {
    const m = await load(root);
    assert.equal(m.depsReport().components, 'fallback');
    assert.equal(m.depsReport().toasts, 'upstream');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('toasts.js 改名 → 只有 toasts 降级', async () => {
  const root = mkTree({ components: true, store: true, hooks: true });
  try {
    const m = await load(root);
    assert.equal(m.depsReport().toasts, 'shim');
    assert.equal(m.depsReport().components, 'upstream');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('store.js 改名 → 回退到 globalThis.__SP__.store（上游同一单例）', async () => {
  const prev = globalThis.__SP__;
  globalThis.__SP__ = { store: { get: () => ({ room: {} }) } };
  const root = mkTree({ components: true, toasts: true, hooks: true });
  try {
    const m = await load(root);
    assert.equal(m.depsReport().store, 'fallback');
    assert.equal(m.depsReport().hooks, 'upstream');
  } finally {
    if (prev === undefined) delete globalThis.__SP__; else globalThis.__SP__ = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('store.js 改名且没有 __SP__ → store 退到 shim，面板仍可用', async () => {
  const root = mkTree({ components: true, toasts: true, hooks: true });
  try {
    const m = await load(root);
    assert.equal(m.depsReport().store, 'shim');
    assert.doesNotThrow(() => m.ShellPanelHost());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('hooks.module.js 改名 → 回退到 globalThis.__SP_HOOKS（lobby.js 回填的那一份）', async () => {
  const prev = globalThis.__SP_HOOKS;
  globalThis.__SP_HOOKS = { useState: (v) => [v, () => {}], useEffect: () => {} };
  const root = mkTree({ components: true, toasts: true, store: true });
  try {
    const m = await load(root);
    assert.equal(m.depsReport().hooks, 'fallback');
    assert.equal(m.depsReport().components, 'upstream');
  } finally {
    if (prev === undefined) delete globalThis.__SP_HOOKS; else globalThis.__SP_HOOKS = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('全部缺失时 ShellPanelHost 仍能渲染一个降级面板（不抛、不是整块消失）', async () => {
  const root = mkTree({});
  try {
    const m = await load(root);
    m.openShellPanel('servers');
    let out;
    assert.doesNotThrow(() => { out = m.ShellPanelHost(); });
    assert.ok(out && typeof out === 'object', '降级渲染必须返回一个可渲染的东西，而不是抛错');
    assert.doesNotThrow(() => m.openShellPanel(null));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('static contract: 不再有静态 import，四条依赖都走动态 import()', () => {
  assert.ok(!/^\s*import\s+[^;\n]*\bfrom\s+['"]/m.test(SRC), '不许再有静态 import ... from');
  for (const spec of ["'../../vendor/hooks.module.js'", "'./components.js'", "'./toasts.js'", "'../store.js'"]) {
    assert.ok(SRC.includes(`import(${spec})`), `必须动态 import(${spec})`);
  }
  assert.ok(SRC.includes('export const depsReady'), 'depsReady 必须导出');
  assert.ok(SRC.includes('export function whenDepsReady'), 'whenDepsReady 必须导出');
  assert.ok(SRC.includes('export function depsReport'), 'depsReport 必须导出');
  assert.ok(SRC.includes('__SP_HOOKS'), 'hooks 回退通道要读 __SP_HOOKS');
  assert.ok(SRC.includes('__SP__'), 'store 回退通道要读 __SP__');
});

test('lobby.js 在注册面板前 await shellPanels 的依赖，并回填 __SP_HOOKS', () => {
  assert.ok(LOBBY.includes('whenDepsReady'), 'lobby.js 必须等 shellPanels 依赖落地再注册');
  assert.ok(/registerPanel\('lobby'/.test(LOBBY), '注册点仍在');
  assert.ok(LOBBY.includes('__SP_HOOKS'), 'lobby.js 要把已导入的 hooks 回填给 shellPanels');
});
