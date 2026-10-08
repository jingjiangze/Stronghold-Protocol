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
// preact stub: h() for the htm fallback, plus a render() that flattens the stub vnodes into a text
// node inside the container -- enough to prove the panel host really paints a panel after openPanel().
const PREACT_STUB = [
  "export function h() { return { __h: true }; }",
  'function flat(v) {',
  "  if (v === null || v === undefined || v === false || v === true) return '';",
  "  if (typeof v === 'string' || typeof v === 'number') return String(v);",
  "  if (Array.isArray(v)) { var s = ''; for (var i = 0; i < v.length; i++) s += flat(v[i]); return s; }",
  "  if (typeof v === 'function') {",
  "    if (!v.prototype) return ''; // 箭头 = 事件处理器/close，绝不调用（调用会触发副作用）",
  "    try { return flat(v({})); } catch (e) { return ''; } // 需要 props 的子组件：字面量仍在 strings 里",
  "  }",
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

const API = ['openShellPanel', 'useShellPanel', 'QuickModes', 'registerPanel', 'ShellPanelHost', 'mountShellPanelHost', 'whenDepsReady', 'depsReport', 'depsReady'];

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
  // v6.9 面板宿主自挂载（审计 §A P0）：宿主不再依赖上游补丁
  assert.ok(SRC.includes('export async function mountShellPanelHost'), '必须导出 mountShellPanelHost');
  assert.ok(SRC.includes('data-sp-panel-host'), '宿主容器必须打 data-sp-panel-host 标记（幂等）');
  assert.ok(SRC.includes('__SP_SHELL.depsReport'), 'depsReport 必须暴露到 __SP_SHELL（诊断）');
  assert.ok(SRC.includes('__SP_SHELL.whenDepsReady'), 'whenDepsReady 必须暴露到 __SP_SHELL（诊断）');
});

test('lobby.js 在注册面板前 await shellPanels 的依赖，并回填 __SP_HOOKS', () => {
  assert.ok(LOBBY.includes('whenDepsReady'), 'lobby.js 必须等 shellPanels 依赖落地再注册');
  assert.ok(/registerPanel\('lobby'/.test(LOBBY), '注册点仍在');
  assert.ok(LOBBY.includes('__SP_HOOKS'), 'lobby.js 要把已导入的 hooks 回填给 shellPanels');
  assert.ok(LOBBY.includes('mountShellPanelHost'), 'lobby.js 必须在依赖就绪后自挂载面板宿主');
});

// 业主口径（2026-10-08）：大厅 = lobby.js 的「大厅」页，openShellPanel('lobby') 必须落在它上面
// （标题页主按钮 / 延迟胶囊由外部调它）。路由优先级：注册表 → 内置 kind；'lobby' 永远不许变成
// 内置面板，否则本页被抢路由，而且没有任何编译期报错（症状只是点按钮没反应）。
test('openShellPanel(\'lobby\') 路由到 lobby.js 注册的面板（注册表优先于内置 kind）', () => {
  const get = SRC.indexOf('panelRegistry.get(kind)');
  const builtin = SRC.indexOf("if (kind === 'servers')");
  assert.ok(get > 0, 'ShellPanelHost 必须查注册表（panelRegistry.get(kind)）');
  assert.ok(builtin > get, '注册表查询必须先于内置面板分支（否则注册的 lobby 会被内置抢走）');
  assert.ok(!/if \(kind === 'lobby'\)/.test(SRC), "'lobby' 不许是内置 kind（本页由 lobby.js 注册）");
  assert.ok(LOBBY.includes("window.__SP_SHELL.openPanel('lobby')"), 'window.__SP_LOBBY.open() 必须开 lobby 面板');
});

// ---------------------------------------------------------------------------------------------------
// P0 回归门禁（审计 2026-10-08 §A）：宿主挂载 + 面板真的渲染出来。
// 过去 openShellPanel 只改状态，宿主组件靠构建期补丁挂进上游 js/main.js，补丁清零后没人渲染 →
// 四个面板点不开。这里断言：mountShellPanelHost(container) 后 openPanel('servers') 容器里真的出现
// 面板 DOM（含标题文案），且重复挂载幂等。
// ---------------------------------------------------------------------------------------------------

/** 极简 DOM/window 桩：够 mountShellPanelHost + 事件派发跑通。 */
function mkDomEnv() {
  const created = [];
  const mkNode = (tag) => ({
    tagName: String(tag).toUpperCase(), _attrs: {}, _kids: [], style: {},
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n); },
    appendChild(c) { this._kids.push(c); c.parentNode = this; return c; },
  });
  const win = {
    _ls: {},
    addEventListener(t, fn) { (this._ls[t] = this._ls[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = this._ls[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    dispatchEvent(ev) { const a = (this._ls[ev.type] || []).slice(); for (const f of a) f(ev); return true; },
  };
  const document = {
    body: mkNode('body'),
    createElement(tag) { const el = mkNode(tag); created.push(el); return el; },
    querySelector(sel) {
      if (sel === '[data-sp-panel-host]') return created.find((e) => e.getAttribute('data-sp-panel-host') !== null) || null;
      return null;
    },
  };
  return { win, document, created, mkNode };
}

test('P0 回归：mountShellPanelHost 后 openPanel(\'servers\') 容器里真的渲染出面板（含标题文案）', async () => {
  const root = mkTree({ components: true, toasts: true, store: true, hooks: true, preact: true });
  const env = mkDomEnv();
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  const prevCE = globalThis.CustomEvent;
  globalThis.window = env.win;
  globalThis.document = env.document;
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  try {
    const m = await load(root);
    const container = env.mkNode('div');
    const host = await m.mountShellPanelHost(container);
    assert.ok(host, '宿主容器必须建起来');
    assert.equal(host.getAttribute('data-sp-panel-host') !== null, true, '容器必须打 data-sp-panel-host');
    assert.equal(container._kids.indexOf(host) >= 0, true, '宿主必须挂进传入的 parent');
    m.openShellPanel('servers');
    assert.ok(String(host.__spPanelText || '').includes('服务器'),
      'openPanel(\'servers\') 后容器里必须出现服务器面板（标题文案）：' + host.__spPanelText);
    const host2 = await m.mountShellPanelHost(container);
    assert.equal(host2, host, '重复挂载必须幂等（同一个容器）');
    assert.equal(env.created.filter((e) => e.getAttribute('data-sp-panel-host') !== null).length, 1,
      '只许有一个宿主容器');
    m.openShellPanel('appearance');
    assert.ok(String(host.__spPanelText || '').includes('设置'),
      'appearance 面板必须渲染出「设置」标题：' + host.__spPanelText);
    m.openShellPanel(null);
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
    if (prevCE === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = prevCE;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------
// v6.10 外观（owner 口径）：参数面板去掉外观分区；设置面板 = 5 挡字体（小杯→EW）+ 边距 0–40px 滑动条。
// 这些是面板内容契约，按源码断言（面板渲染走真 components 时，挡位文案在 SegRow 的 options 里，
// 测试垫片不渲染子组件 props，所以源码就是可断言的契约面）。
// ---------------------------------------------------------------------------------------------------

/** SRC 里某个顶层 function 的正文（从 'function Name(' 到下一个顶层 'function '）。 */
function fnBody(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `没找到 function ${name}`);
  const end = SRC.indexOf('\nfunction ', start + 1);
  return SRC.slice(start, end === -1 ? SRC.length : end);
}

test('v6.10 参数面板(ParamsPanel)不再出现外观分区（字体挡位/边距行都已搬走）', () => {
  const body = fnBody('ParamsPanel');
  assert.ok(!body.includes('外观'), '参数面板不得再出现「外观」分区');
  assert.ok(!body.includes('AppearanceRows'), '参数面板不得再挂载外观行组件');
  assert.ok(!body.includes('FONT_SCALE') && !body.includes('SliderRow'), '参数面板不得引用外观控件');
  assert.ok(!body.includes('readAppearance') && !body.includes('setAppearance'), '参数面板不得再读写外观');
  // 面板自己的行原样保留（端口 / 监听地址 / 战斗模拟 / 结果校验 / 信任代理 / 传输方案）
  for (const keep of ['端口', '监听地址', '战斗模拟', '结果校验', '信任代理', '传输方案']) {
    assert.ok(body.includes(keep), `参数面板必须保留「${keep}」行`);
  }
});

test('v6.10 设置面板：字体 5 挡 小杯/中杯/大杯/超大杯/EW（由小到大，沿用 5 个倍率）', () => {
  const m = SRC.match(/const FONT_SCALE = (\[.*?\]);/);
  assert.ok(m, 'FONT_SCALE 常量必须还在');
  const tiers = JSON.parse(m[1].replace(/'/g, '"'));
  assert.equal(tiers.length, 5, '必须恰好 5 挡');
  assert.deepEqual(tiers.map((t) => t[1]), ['小杯', '中杯', '大杯', '超大杯', 'EW']);
  assert.deepEqual(tiers.map((t) => Number(t[0])), [0.85, 1, 1.15, 1.3, 1.5], '倍率沿用 appearance.js 的 5 档');
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(Number(tiers[i][0]) > Number(tiers[i - 1][0]), '挡位必须按倍率由小到大排列');
  }
  assert.ok(fnBody('AppearancePanel').includes('FONT_SCALE'), '设置面板必须渲染字体挡位行');
});

test('v6.10 设置面板：边距是 0–40px 滑动条（min/max/step + px 读数），不再是预设挡位', () => {
  assert.match(SRC, /const PAD_MIN = 0, PAD_MAX = 40, PAD_STEP = 2;/);
  const panel = fnBody('AppearancePanel');
  assert.ok(panel.includes('<${SliderRow}') && panel.includes('label="左右边距"'), '设置面板的边距行必须是滑动条');
  assert.ok(!panel.includes('SIDE_PAD'), '边距不该再有预设挡位常量');
  assert.match(panel, /min=\$\{PAD_MIN\} max=\$\{PAD_MAX\} step=\$\{PAD_STEP\}/, '滑动条必须绑定 PAD_MIN/PAD_MAX/PAD_STEP');
  assert.ok(panel.includes('unit="px"'), '读数单位必须是 px');
  const slider = fnBody('SliderRow');
  assert.ok(slider.includes('type="range"'), 'SliderRow 必须是真 range 输入');
  assert.ok(slider.includes("'--pct:'"), '沿用上游 .set-range 的 --pct 渐变');
  assert.ok(slider.includes('set-row__val'), '右侧必须有实时读数');
  assert.ok(slider.includes('Math.max(min, Math.min(max'), '渲染值必须钳制进 [min,max]');
  assert.ok(slider.includes('onInput'), '拖动即生效（onInput，不是 onChange 松手才写）');
});

test('v6.10 持久层同口径：appearance.js sidePad 钳制 [0,40]，滑动条端点与其一致', () => {
  const A = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'appearance.js'), 'utf8');
  assert.match(A, /PAD_MIN = 0, PAD_MAX = 40/);
  assert.match(A, /clampNum\(v, PAD_MIN, PAD_MAX\)/);
  const m = SRC.match(/const PAD_MIN = (\d+), PAD_MAX = (\d+), PAD_STEP = (\d+);/);
  assert.ok(m, 'PAD_* 常量必须还在');
  assert.equal(Number(m[1]), 0, '滑动条最小 0');
  assert.equal(Number(m[2]), 40, '滑动条最大 40');
  assert.equal(Number(m[3]), 2, '步长 2');
});
