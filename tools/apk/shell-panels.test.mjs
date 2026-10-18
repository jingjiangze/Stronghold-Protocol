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
const CONNECT = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'connect-core.js'), 'utf8');
const FIRST = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'first-screen.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'preloadPanel.js'), 'utf8');
const JOIN = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-join.js'), 'utf8');
const ROOMHOOK = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'room-hook.js'), 'utf8');

// The overlay's own UI kit (ui/overlayKit.js) stub. shellPanels resolves its UI (html / Modal /
// Button / MicroLabel / hooks / toast) from this -- NOT from the page's js/ui/components.js. The
// real kit is self-contained (it imports its vendored preact/htm/hooks), so the stub needs none.
const KIT_STUB = [
  "export const html = (strings, ...vals) => ({ __stub: 'vnode', strings: Array.from(strings), vals });",
  'export function Modal(p) { return html`<div class="modal">${(p && p.title) || ""}</div>`; }',
  'export function Button() { return html`<button></button>`; }',
  'export function MicroLabel() { return html`<span></span>`; }',
  "export function useState(v) { return [typeof v === 'function' ? v() : v, function () {}]; }",
  'export function useEffect() {}',
  'export function toast() {}',
  // render: flatten stub vnodes into a text node inside the container -- enough to prove the panel
  // host really paints a panel after openPanel().
  'function flat(v) {',
  "  if (v === null || v === undefined || v === false || v === true) return '';",
  "  if (typeof v === 'string' || typeof v === 'number') return String(v);",
  "  if (Array.isArray(v)) { var s = ''; for (var i = 0; i < v.length; i++) s += flat(v[i]); return s; }",
  "  if (typeof v === 'function') {",
  "    if (!v.prototype) return ''; // 箭头 = 事件处理器/close，绝不调用（调用会触发副作用）",
  "    try { return flat(v({})); } catch (e) { return ''; } // 需要 props 的子组件：字面量仍在 strings 里",
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
const HOOKS_STUB = [
  "export function useState(v) { return [typeof v === 'function' ? v() : v, function () {}]; }",
  'export function useEffect() {}',
].join('\n');
const STORE_STUB = 'export const store = { get: function () { return {}; } };';
const HTM_STUB = 'export default function htm(bind) { return function () { return { __htm: true }; }; }';
// preact stub: h() for the html fallback (used only when the kit is absent); render() is the kit's.
const PREACT_STUB = [
  "export function h() { return { __h: true }; }",
  'export function render() { return null; }',
].join('\n');
const KIT_THROWS = "throw new Error('overlayKit.js missing');";

/**
 * Build a module tree containing the REAL shellPanels.js plus the requested stubs.
 * opts keys: kit | kitThrows | store | htm | preact
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
  if (opts.kit) w('public/js/ui/overlayKit.js', KIT_STUB);
  if (opts.kitThrows) w('public/js/ui/overlayKit.js', KIT_THROWS);
  if (opts.store) w('public/js/store.js', STORE_STUB);
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

test('自带 UI 套件 + 页面 store 都在 → components/hooks/toasts 来自 kit，store 来自页面，API 齐全', async () => {
  const root = mkTree({ kit: true, store: true });
  try {
    const m = await load(root);
    assert.deepEqual(m.depsReport(), { hooks: 'kit', components: 'kit', toasts: 'kit', store: 'upstream' });
    for (const n of API) assert.ok(n in m, `missing export ${n}`);
    assert.equal(typeof m.QuickModes, 'function');
    assert.equal(typeof m.ShellPanelHost, 'function');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('UI 套件与 store 全部缺失 → 模块仍然加载（这正是旧静态 import 会整块消失的场景）', async () => {
  const root = mkTree({});
  try {
    const m = await load(root);
    assert.deepEqual(m.depsReport(), { hooks: 'shim', components: 'shim', toasts: 'shim', store: 'shim' });
    for (const n of API) assert.ok(n in m, `missing export ${n}`);
    assert.doesNotThrow(() => m.QuickModes({ onClose() {} }));
    assert.doesNotThrow(() => m.registerPanel('x', function X() { return null; }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('UI 套件缺失 → components 退到最后手段 shim（不再回退页面 vendor/），store 仍 upstream', async () => {
  const root = mkTree({ store: true, htm: true, preact: true });
  try {
    const m = await load(root);
    const r = m.depsReport();
    assert.equal(r.components, 'shim', '没有套件时只许用本地垫片，绝不回退页面 UI');
    assert.equal(r.hooks, 'shim');
    assert.equal(r.toasts, 'shim');
    assert.equal(r.store, 'upstream');
    assert.doesNotThrow(() => m.ShellPanelHost());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('UI 套件缺失 → components 退到最后手段 shim，模块仍加载', async () => {
  const root = mkTree({ store: true });
  try {
    const m = await load(root);
    assert.equal(m.depsReport().components, 'shim');
    assert.equal(m.depsReport().hooks, 'shim');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('UI 套件存在但 import 时抛错 → 被吞掉并降级，不拖垮整块', async () => {
  const root = mkTree({ kitThrows: true, store: true, htm: true, preact: true });
  try {
    const m = await load(root);
    assert.equal(m.depsReport().components, 'shim');
    assert.equal(m.depsReport().store, 'upstream');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('store.js 改名 → 回退到 globalThis.__SP__.store（上游同一单例）', async () => {
  const prev = globalThis.__SP__;
  globalThis.__SP__ = { store: { get: () => ({ room: {} }) } };
  const root = mkTree({ kit: true });
  try {
    const m = await load(root);
    assert.equal(m.depsReport().store, 'fallback');
    assert.equal(m.depsReport().components, 'kit');
  } finally {
    if (prev === undefined) delete globalThis.__SP__; else globalThis.__SP__ = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('store.js 改名且没有 __SP__ → store 退到 shim，面板仍可用', async () => {
  const root = mkTree({ kit: true });
  try {
    const m = await load(root);
    assert.equal(m.depsReport().store, 'shim');
    assert.doesNotThrow(() => m.ShellPanelHost());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('UI 套件缺失 → hooks 回退到 globalThis.__SP_HOOKS（lobby.js 回填的那一份）', async () => {
  const prev = globalThis.__SP_HOOKS;
  globalThis.__SP_HOOKS = { useState: (v) => [v, () => {}], useEffect: () => {} };
  const root = mkTree({ store: true });
  try {
    const m = await load(root);
    assert.equal(m.depsReport().hooks, 'fallback');
    assert.equal(m.depsReport().components, 'shim');
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

test('static contract: 不再有静态 import；UI 只走自带套件，store 走页面 origin', () => {
  assert.ok(!/^\s*import\s+[^;\n]*\bfrom\s+['"]/m.test(SRC), '不许再有静态 import ... from');
  // 自带 UI 套件（动态 import，/__sp/ 通道）
  assert.ok(SRC.includes("const KIT_SPEC = './overlayKit.js'"), '套件规格必须指向 ./overlayKit.js');
  assert.ok(SRC.includes('import(KIT_SPEC)'), 'UI 必须动态 import 自带套件（KIT_SPEC）');
  // store：页面 origin 优先，相对路径兜底（游戏自己的模块，必须读那一页的实例）
  assert.ok(SRC.includes("import('/js/store.js')"), 'store 必须优先 import 页面 origin 的 /js/store.js');
  assert.ok(SRC.includes("import('../store.js')"), 'store 兜底 import 相对 ../store.js');
  // 页面 origin 的 UI 路径一律不许出现（拆分门禁）
  for (const banned of ["'/js/ui/components.js'", "'../../js/ui/components.js'", "'./components.js'",
    "'./toasts.js'", "'../../vendor/hooks.module.js'", "'../../vendor/htm.module.js'", "'../../vendor/preact.module.js'"]) {
    assert.ok(!SRC.includes(banned), `不许再从页面 origin 取 UI：${banned}`);
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

// ---------------------------------------------------------------------------------------------------
// v7.5 回归门禁（业主 2026-10-08）：服务器行 = 2.9.31 行式（名称 · v版本 · 延迟色点，两列网格）。
// 根因：`.sp-srv-*` 样式原本是构建期补丁（patches/settings-v3.6.json -> css/screens/game.css），
// 补丁清零（ee1f9b80）后没有搬进叠加层 —— 行退化成 block（挤成一列、卡片贴身），延迟点是个空
// inline span（width/height 对 inline 不生效）→ 宽度 0，业主截图「挤在一起、没有延迟」。
// 这里把修复钉死：样式必须由 extras 注入；尺寸一律 rem（只有色点/当前点有 4px 可见性下限，
// 下限只在小到 .11rem 会消失时才生效，绝不会破坏 1.5x）；色点无条件渲染 + 未知恒灰。
// ---------------------------------------------------------------------------------------------------

/** 取 shellPanels.js 里 srvStyleCss() 的 CSS 文本（一行一条的数组字面量）。 */
function srvCss() {
  const m = SRC.match(/function srvStyleCss\(\) \{\n  return \[([\s\S]*?)\n  \]\.join\(''\);/);
  assert.ok(m, 'srvStyleCss() 必须是一行一条的数组字面量（可静态提取）');
  return (m[1].match(/'((?:[^'\\]|\\.)*)'/g) || []).map((s) => s.slice(1, -1)).join('');
}

/** 取 shellPanels.js 里 panelLayoutCss() 的 CSS 文本（同一套一行一条的可静态提取约定）。 */
function panelCss() {
  const m = SRC.match(/function panelLayoutCss\(\) \{\n  return \[([\s\S]*?)\n  \]\.join\(''\);/);
  assert.ok(m, 'panelLayoutCss() 必须是一行一条的数组字面量（可静态提取）');
  return (m[1].match(/'((?:[^'\\]|\\.)*)'/g) || []).map((s) => s.slice(1, -1)).join('');
}

test('v7.5 .sp-srv-* 样式从 extras 注入（补丁清零后必须能热更到位）', () => {
  assert.ok(SRC.includes("const SRV_STYLE_ID = 'sp-srv-style'"), '样式表 id 必须是 sp-srv-style');
  assert.ok(SRC.includes('export function injectSrvStyles'), 'injectSrvStyles 必须导出（诊断/复用）');
  assert.ok(SRC.includes('head.appendChild(el)'), '必须真的把 <style> 挂进 head');
  // 注入点：模块加载时 + 宿主挂载时（两条路都保证「先有样式再渲染」）
  assert.ok(/^try \{ injectSrvStyles\(\); \} catch \(e\) \{ \/\* silent: mount retries \*\/ \}$/m.test(SRC),
    '模块加载时必须注入一次（幂等）');
  assert.ok(/try \{ injectSrvStyles\(\); \} catch \(e\) \{ \/\* silent \*\/ \} \/\/ rows must be styled/.test(SRC),
    'mountShellPanelHost 里必须再注入一次（head 未就绪时的兜底）');
  // 不许再依赖构建期补丁目录（它就是被清零的那条路）—— 只看代码，注释里的历史说明不算
  const codeOnly = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/patches\//.test(codeOnly), '代码不许引用已清零的补丁目录');
});

test('v7.5 行式 = 2.9.31：两列等宽网格 + 名称截断 + 窄屏单列', () => {
  const css = srvCss();
  assert.ok(css.includes('.sp-srv-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))'),
    '两列等宽网格（minmax(0,1fr) 防长名撑爆）');
  assert.ok(css.includes('@media (max-width:600px){.sp-srv-grid{grid-template-columns:1fr}}'), '窄屏回退单列');
  assert.ok(/\.sp-srv-name\{[^}]*text-overflow:ellipsis/.test(css), '名称必须省略号截断（不换行）');
  assert.ok(/\.sp-srv-name\{[^}]*white-space:nowrap/.test(css), '名称不许换行');
  assert.ok(/\.sp-srv-main\{[^}]*display:flex/.test(css), '行内必须是 flex（名称/版本/色点一行排开）');
  assert.ok(/\.sp-srv-cell\{[^}]*overflow:hidden/.test(css), '卡片必须裁剪（窄格不溢出）');
  assert.ok(/\.sp-srv-cell\{[^}]*height:\.56rem/.test(css), '卡片行高 .56rem（2.9.31 原值，随 rem 缩放）');
  assert.ok(/\.sp-srv-cell\.is-cur\{[^}]*border-color:var\(--mint-500/.test(css), '当前行 = 薄荷描边');
});

test('v7.5 缩放安全：尺寸全 rem，px 只允许色点的 4px 可见性下限', () => {
  const css = srvCss();
  // 先剥掉三处「非尺寸」px：窄屏媒体查询的视口宽度（600px）、1px 内描边（box-shadow）与 1px 发丝边
  const layout = css
    .replace(/@media \(max-width:600px\)\{[^}]*\}\}?/g, '')
    .replace(/box-shadow:[^;}]*/g, '')
    .replace(/border:1px solid [^;}]*/g, 'border:HAIRLINE');
  assert.ok(layout.includes('border:HAIRLINE'), '卡片必须有 1px 发丝边（与 2.9.31 同款，px 固定不影响缩放）');
  // 剩下的 px 字面量必须恰好是 4px（且只出现在 min-width/min-height 上）
  const px = Array.from(layout.matchAll(/(\d+(?:\.\d+)?)px/g)).map((m) => m[1]);
  assert.deepEqual(px, ['4', '4', '4', '4'], 'CSS 里只许有色点/当前点的 4px 下限，其余尺寸一律 rem');
  assert.ok(css.includes('width:.11rem;height:.11rem;min-width:4px;min-height:4px'), '延迟点：.11rem 圆点 + 4px 下限');
  assert.ok(css.includes('width:.08rem;height:.08rem;min-width:4px;min-height:4px'), '当前点：.08rem + 4px 下限');
  // 不许任何固定 px 宽/高/间距/字号（会在大字挡 1.5x 下破坏布局）
  assert.ok(!/(?:^|[;{])(?:width|height|gap|padding|font-size|border-radius):[^;}]*\dpx/.test(layout),
    '不许有固定 px 的宽高/间距/字号');
});

test('v7.5 色点无条件渲染 + 未知恒灰（点必须在，不能缺席）', () => {
  // 渲染侧：色点 span 不在条件里，且带 display:inline-block + 尺寸 + 颜色（样式表万一丢了也看得见）
  const dot = /<span class="sp-srv-rtt" style=\$\{'([^']*)' \+ dot\.color\} title=\$\{dot\.title\}><\/span>/;
  const m = SRC.match(dot);
  assert.ok(m, 'serverCell 必须无条件渲染 sp-srv-rtt（class + style + title 一次性断言）');
  for (const part of ['flex:0 0 auto', 'display:inline-block', 'width:.11rem', 'height:.11rem', 'min-width:4px', 'min-height:4px', 'border-radius:50%', 'background:']) {
    assert.ok(m[1].includes(part), `色点行内样式缺 ${part}`);
  }
  // 取色侧：rttDot 的未知/停用/探测中分支都是灰点（不是缺席）
  const body = SRC.slice(SRC.indexOf('function rttDot('), SRC.indexOf('function inMatch('));
  assert.ok(body.includes("if (enabled === false) return { color: '#8a9a93', title: '已停用' };"), '停用 → 灰点「已停用」');
  assert.ok(body.includes("return { color: '#8a9a93', title: '延迟未知' };"), 'rtt 未知 → 灰点「延迟未知」');
  // 大厅页那一份（lobby.js 的 card()）也必须同款
  const LDOT = LOBBY.match(/<span class="sp-srv-rtt" style=\$\{'([^']*)' \+ dot\.color\} title=\$\{dot\.title\}><\/span>/);
  assert.ok(LDOT, 'lobby.js card() 必须无条件渲染同款色点');
  assert.ok(LDOT[1].includes('display:inline-block') && LDOT[1].includes('min-width:4px'), '大厅色点同样要内联兜底');
  const lb = LOBBY.slice(LOBBY.indexOf('function rttDot('), LOBBY.indexOf('function fmtRtt('));
  assert.ok(lb.includes("return { color: '#8a9a93', title: '延迟未知' };"), '大厅 rttDot 未知 → 灰点');
});

test('v7.5 无 DOM 时注入是安全 no-op（测试/老壳不炸）', async () => {
  const root = mkTree({ kit: true, store: true });
  try {
    const m = await load(root);
    assert.equal(typeof m.injectSrvStyles, 'function');
    assert.doesNotThrow(() => m.injectSrvStyles(), '没有 document 时注入必须静默返回');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------
// v7.6 自适应布局（业主 2026-10-08：「字体小是大厅界面过窄导致字体被左右压缩」）。
// 根因（tools/pwshot/panel-layout-measure.mjs 实测，390x844 / deviceScaleFactor 1）：
//   我们的面板把 Modal 的 width 硬写成内联 10.4rem，盖掉了上游 `.modal__box{width:min(6.4rem,94vw)}`
//   的视口上限。root font = 40px（theme.css 的地板）→ 10.4rem = 416px > 390px 视口 → 盒子左移出屏
//   13px、右溢出 38px，文字左右被屏幕切掉；`.set-row` 的 label 列固定 3.3rem（132px，占面板 1/3）
//   又把值列挤到 ~246px。实测 letter-spacing 全 normal、transform 全 none —— 没有 scaleX/负字距，
//   是 nowrap+溢出被裁，不是字形被压。修复：宽度/收缩/滚动改由 [data-sp-panel-host] 作用域的样式表
//   （#sp-panel-layout）负责；上游自己的 Modal 不在宿主内，一格不受影响。
// ---------------------------------------------------------------------------------------------------

test('v7.6 自适应宽度：样式表在 extras 注入，内联固定宽度全部移除', () => {
  assert.ok(SRC.includes("const PANEL_STYLE_ID = 'sp-panel-layout'"), '样式表 id 必须是 sp-panel-layout');
  assert.ok(SRC.includes('export function injectPanelLayoutStyles'), 'injectPanelLayoutStyles 必须导出（诊断/复用）');
  assert.ok(/^try \{ injectPanelLayoutStyles\(\); \} catch \(e\) \{ \/\* silent: mount retries \*\/ \}$/m.test(SRC),
    '模块加载时必须注入一次（幂等）');
  assert.ok(SRC.includes('try { injectPanelLayoutStyles(); } catch (e) { /* silent */ } // adaptive width/scroll'),
    'mountShellPanelHost 里必须再注入一次（head 未就绪时的兜底）');
  // 八个面板（shellPanels.js 七个 + lobby.js 一个）都不许再带内联固定宽度（它就是盖掉视口上限的那一条）
  assert.ok(!SRC.includes('width="10.4rem"'), 'shellPanels.js 面板不许再带内联固定宽度');
  assert.ok(!LOBBY.includes('width="10.4rem"'), 'lobby.js 大厅面板不许再带内联固定宽度');
});

test('v7.6 宽度规则：作用域限定 + 桌面 10.4rem + 窄屏近满宽', () => {
  const css = panelCss();
  assert.ok(css.includes('[data-sp-panel-host] .modal__box{width:min(10.4rem,calc(100vw - 1.5rem));max-width:calc(100vw - 1.5rem);}'),
    '基础宽度 = min(10.4rem, 100vw - 边距) + max-width 上限（桌面仍 10.4rem，任何视口不超屏）');
  assert.ok(css.includes('@media (max-width:720px){'), '必须有窄屏/竖屏断点');
  assert.ok(css.includes('[data-sp-panel-host] .modal__box{width:calc(100vw - 16px);max-width:calc(100vw - 16px);}'),
    '窄屏：近满宽 + 8px 边距');
  // 每条选择器都必须限定在面板宿主内（上游 Modal 不受影响）—— 删掉所有带作用域前缀的选择器后，
  // 不许再残留任何裸类选择器。
  const stripped = css.replace(/\[data-sp-panel-host\] [^,{]*/g, '');
  assert.ok(!/\.modal__box|\.modal__body|\.modal__head|\.modal__actions|\.set-row|\.set-hint|\.set-input|\.set-range|\.set-seg|\.set-toggle/.test(stripped),
    '每条规则都必须限定在 [data-sp-panel-host] 内（不许裸 .modal__box / .set-row …）');
});

test('v7.6 不压缩字形 + 保留滚动', () => {
  const css = panelCss();
  // 值列/label 列可收缩：否则 1fr/auto 的 min-content 会把文字压扁或撑破网格
  assert.ok(css.includes('[data-sp-panel-host] .set-row{grid-template-columns:minmax(0,3.3rem) minmax(0,1fr) auto;}'),
    '值列与 label 列必须可收缩（minmax(0,…)）');
  assert.ok(css.includes('overflow-wrap:anywhere'), '长 token 必须断行而不是撑破网格');
  assert.ok(!/scaleX|letter-spacing\s*:\s*-|text-overflow:\s*clip/.test(css),
    '不许 scaleX / 负字距 / clip —— 字形必须保持宽高比');
  // 保留滚动：body 是唯一滚动区，页脚是它的 flex 兄弟（不随滚动消失）
  assert.ok(/\[data-sp-panel-host\] \.modal__body\{[^}]*overflow-y:auto/.test(css), 'body 必须 overflow-y:auto');
  assert.ok(/\[data-sp-panel-host\] \.modal__body\{[^}]*overscroll-behavior:contain/.test(css), 'body 必须 overscroll-behavior:contain');
  assert.ok(/\[data-sp-panel-host\] \.modal__body\{[^}]*min-height:0/.test(css), 'body 必须 min-height:0（flex 子项才能收缩成滚动区）');
});

test('v7.6 无 DOM 时布局注入是安全 no-op（测试/老壳不炸）', async () => {
  const root = mkTree({ kit: true, store: true });
  try {
    const m = await load(root);
    assert.equal(typeof m.injectPanelLayoutStyles, 'function');
    assert.doesNotThrow(() => m.injectPanelLayoutStyles(), '没有 document 时注入必须静默返回');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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

/** 极简 DOM/window 桩：够 mountShellPanelHost + 事件派发跑通。
 *  2026-10-11：桩里补上 documentElement 与页面自己的 `.app-root`（业主报的服务器页面各有其一）——
 *  宿主该挂哪儿由这两条断言钉住（见下面两个 P0 用例）。 */
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
  const documentElement = mkNode('html');
  const appRoot = mkNode('div'); // 页面自己的内容容器（服务器页面给它上了 isolation:isolate）
  const document = {
    documentElement,
    appRoot,
    body: mkNode('body'),
    createElement(tag) { const el = mkNode(tag); created.push(el); return el; },
    querySelector(sel) {
      if (sel === '[data-sp-panel-host]') return created.find((e) => e.getAttribute('data-sp-panel-host') !== null) || null;
      if (sel === '.app-root') return appRoot;
      return null;
    },
  };
  return { win, document, documentElement, appRoot, created, mkNode };
}

/** 把桩装进 globalThis，返回还原函数（三个 P0 用例的公共前后置）。 */
function useDomEnv(env) {
  const prev = { win: globalThis.window, doc: globalThis.document, ce: globalThis.CustomEvent };
  globalThis.window = env.win;
  globalThis.document = env.document;
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  return () => {
    if (prev.win === undefined) delete globalThis.window; else globalThis.window = prev.win;
    if (prev.doc === undefined) delete globalThis.document; else globalThis.document = prev.doc;
    if (prev.ce === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = prev.ce;
  };
}

test('P0 回归：mountShellPanelHost 后 openPanel(\'servers\') 容器里真的渲染出面板（含标题文案）', async () => {
  const root = mkTree({ kit: true, store: true, preact: true });
  const env = mkDomEnv();
  const restore = useDomEnv(env);
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
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------
// 业主 2026-10-11（服务器页面 http://103.205.253.194:27527/ 把悬浮窗挤掉）：宿主必须挂在**最外层**。
//
// 根因（tools/pwshot/_fixprobe.mjs 实测）：那个页面给内容容器 `.app-root` 上了
// `position:fixed; isolation:isolate` —— isolation 单独一条就创建**堆叠上下文**，而 z-index 只在
// 自己所在的那个上下文里比较、永远出不去。宿主挂在 `.app-root` 里时，整块面板（含 z-index
// 2147481000）就停在该容器的层级（auto）上，页面画在容器**外面**的任何东西都能盖住它：竖屏下它的
// 全屏 `.rotate-hint`（z-index 100，BODY 的子节点）就是这样盖掉整个面板的。把宿主搬到
// documentElement（根堆叠上下文）后 panelOnTop 由 false 变 true。同一理由见 art-prefetch.js
// 的 uiParent()：悬浮胶囊本来就挂在 documentElement 上，所以它从没被挤掉过。
// ---------------------------------------------------------------------------------------------------

test('P0 回归：默认挂载点是最外层 documentElement，不是页面自己的 .app-root', async () => {
  const root = mkTree({ kit: true, store: true, preact: true });
  const env = mkDomEnv();
  const restore = useDomEnv(env);
  try {
    const m = await load(root);
    const host = await m.mountShellPanelHost(); // 不传 parent：宿主自己选地方（lobby.js 就是这么调的）
    assert.ok(host, '宿主容器必须建起来');
    assert.equal(host.parentNode, env.documentElement, '默认必须挂在 documentElement 上（根堆叠上下文）');
    assert.equal(env.appRoot._kids.indexOf(host), -1,
      '绝不许挂进页面自己的 .app-root —— 它可能是隔离的堆叠上下文，面板会被页面盖住');
    m.openShellPanel('servers');
    assert.ok(String(host.__spPanelText || '').includes('服务器'), '挂到最外层后面板仍然要画出来');
    m.openShellPanel(null);
  } finally {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('宿主掉出文档后再次 mount：挂回最外层的是**同一个**节点（面板不断线）', async () => {
  const root = mkTree({ kit: true, store: true, preact: true });
  const env = mkDomEnv();
  const restore = useDomEnv(env);
  try {
    const m = await load(root);
    const host = await m.mountShellPanelHost();
    assert.equal(host.parentNode, env.documentElement, '先挂上');
    // 模拟页面把树换掉（热重载 / documentElement.innerHTML = ...）：节点掉出文档
    env.documentElement._kids.length = 0;
    host.parentNode = null;
    const again = await m.mountShellPanelHost();
    assert.equal(again, host, '必须是同一个节点（不重建 —— 重建会画出第二套面板/丢状态）');
    assert.equal(host.parentNode, env.documentElement, '掉出文档后必须挂回最外层');
    assert.equal(env.created.filter((e) => e.getAttribute('data-sp-panel-host') !== null).length, 1,
      '全流程只许有一个宿主容器');
  } finally {
    restore();
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

/** ParamsPanel 正文：边界取到下一个 function 的**开头**（不取 '\nfunction '，那会把紧跟其后
 *  的「全局设置」分区注释算进来）。再剥掉行注释 —— 注释里出现「外观」两个字
 *  与「参数面板有没有挂载外观行」是两回事，不能混为一谈。 */
function paramsBody() {
  const start = SRC.indexOf('function ParamsPanel(');
  assert.ok(start >= 0, '没找到 function ParamsPanel');
  const end = SRC.indexOf('function SettingsPanel(', start);
  assert.ok(end > start, 'ParamsPanel 与 SettingsPanel 的相对位置变了');
  return SRC.slice(start, end)
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

test('v6.10 参数面板(ParamsPanel)不再出现外观分区（字体挡位/边距行都已搬走）', () => {
  const body = paramsBody();
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

// ---------------------------------------------------------------------------------------------------
// 2026-10-08（业主口径）：服务端声明的配置必须在界面上看得见 —— rainya 那边有「同盟匹配」这类功能，
// 我方界面连一行声明都没有 = 「未显示服务器配置」。服务器面板加一行 serverConfigLine()。
// ---------------------------------------------------------------------------------------------------

test('服务器面板渲染 serverConfigLine()：读到 __SP_SERVER_CONFIG 就显示版本/公告/功能/匹配；读不到明确写「未声明」', () => {
  assert.ok(SRC.includes('${serverConfigLine()}'), '服务器面板必须渲染 serverConfigLine()');
  const body = fnBody('serverConfigLine');
  assert.ok(body.includes('window.__SP_SERVER_CONFIG'), '必须从 __SP_SERVER_CONFIG 读（Java 校验后的只读快照）');
  assert.ok(body.includes('未声明'), '没有配置时必须明确写「未声明」，并给出该放的文件名');
  assert.ok(body.includes('/stronghold-client.json'), '未声明时提示服务端该放的文件名');
  assert.ok(body.includes('announce') && body.includes('matchmaking') && body.includes('features'),
    '公告/匹配参数/功能三项都要显示');
  assert.ok(/v\$\{v\}|`v\$\{v\}`/.test(body) || body.includes('v${v}'), '必须显示配置版本号');
  // 任何异常都退化成「未声明」，不许把面板渲染弄挂
  assert.ok(/try \{/.test(body) && /catch/.test(body), '必须有 try/catch 兜底');
});

// ---------------------------------------------------------------------------------------------------
// 2026-10-10（业主：「审计目前窗口目录，做到不互相冲突」「优先悬浮窗最上层」）：叠加层的**层序表**。
// 此前每个窗口各带一个字面 z-index（chip 2147483647 / 面板 Modal 2147482000 / toast 2147483000），
// 没有数字的窗口（面板宿主、公告板）只能吃 DOM 插入顺序 —— 这就是「窗口互相冲突」。现在 SP_LAYERS
// 一套常量 + #sp-layer-style 一张表把每个窗口放上同一把尺子：公告板 < 面板宿主 < 面板 Modal < toast <
// chip（悬浮窗恒最上）。页面自己的 --z-modal:80（theme.css，游戏 UI 在读）**绝不被接管** —— 公告板
// 由我们自己的类 `.sp-notice__overlay`（html 前缀保证特异性）钉到表上。art-prefetch.test.mjs 另有一道
// 门禁断言 chip 的字面量与 SP_LAYERS.chip 相等。
// ---------------------------------------------------------------------------------------------------

/** Extract the CSS text of layerScaleCss() (one rule per array line, static-extractable). */
function layerCss() {
  const m = SRC.match(/function layerScaleCss\(\) \{\n  return \[([\s\S]*?)\n  \]\.join\(''\);/);
  assert.ok(m, 'layerScaleCss() 必须是一行一条的数组字面量（可静态提取）');
  return (m[1].match(/'((?:[^'\\]|\\.)*)'/g) || []).map((s) => s.slice(1, -1)).join('');
}

/** SP_LAYERS 解析结果（从源码静态提取，不 import）。 */
function layers() {
  const m = SRC.match(/export const SP_LAYERS = \{ first: (\d+), notice: (\d+), host: (\d+), modal: (\d+), toast: (\d+), chip: (\d+) \};/);
  assert.ok(m, 'SP_LAYERS 必须是可静态提取的一行常量表');
  const [first, notice, host, modal, toast, chip] = m.slice(1, 7).map(Number);
  return { first, notice, host, modal, toast, chip };
}

test('层序表：first < notice < host < modal < toast < chip（悬浮窗恒最上，且是 int32 上限）', () => {
  const L = layers();
  assert.equal(L.first, 2147479000, 'first = 全屏首页层（2026-10-18 入表；first-screen 自带同值字面量，钉子见下）');
  assert.ok(L.first < L.notice, '首页层必须低于公告板/面板宿主：在首页上打开的面板要盖住首页');
  assert.ok(L.notice > 100, '公告板必须高于页面常规内容（页面 --z-rotate:100 是它的顶）');
  assert.ok(L.host > L.notice, '面板房源层必须高于公告板：' + L.host + ' > ' + L.notice);
  assert.ok(L.modal > L.host, '宿主内的 Modal 层必须高于宿主层（宿主内再排序）');
  assert.ok(L.toast > L.host, 'toast 在面板之上');
  assert.ok(L.toast < L.chip, 'toast 在 chip 之下');
  assert.equal(L.chip, 2147483647, 'chip = int32 上限：页面写什么数字都赢不了它');
});

test('层序表随叠加层注入每个页面（模块加载 + 宿主挂载，幂等且无 DOM 安全）', () => {
  const css = layerCss();
  const L = layers();
  assert.ok(SRC.includes("const LAYER_STYLE_ID = 'sp-layer-style'"), '样式表 id 必须是 sp-layer-style');
  assert.ok(SRC.includes('export function injectLayerStyles'), 'injectLayerStyles 必须导出（诊断/复用）');
  assert.ok(SRC.includes('document.getElementById(LAYER_STYLE_ID)'), '注入必须按 id 幂等');
  assert.ok(/^try \{ injectLayerStyles\(\); \} catch \(e\) \{ \/\* silent: mount retries \*\/ \}$/m.test(SRC),
    '模块加载时必须注入一次');
  assert.ok(SRC.includes('try { injectLayerStyles(); } catch (e) { /* silent */ } // the layer scale'),
    'mountShellPanelHost 里必须再注入一次（head 未就绪时的兜底）');
  // 表本身：五个 --sp-z-* 变量 + 宿主规则 + 面板 Modal 步进，数字与 SP_LAYERS 逐一相等
  assert.ok(css.includes(`:root{--sp-z-notice:${L.notice};--sp-z-host:${L.host};--sp-z-modal:${L.modal};--sp-z-toast:${L.toast};--sp-z-chip:${L.chip}}`),
    '表中五个层号必须与 SP_LAYERS 完全一致');
  assert.ok(css.includes(`[data-sp-panel-host]{position:relative;z-index:var(--sp-z-host,${L.host})}`),
    '面板宿主必须带 position:relative + z-index（静止 div 的 z-index 不生效）');
  assert.ok(SRC.includes(`.sp-ui .modal{position:fixed;inset:0;z-index:var(--sp-z-modal,${L.modal})`),
    '面板 Modal 必须用表里的 modal 步进（带字面量兜底）');
  // 兜底值 = 旧字面量：表没注入时退回 2026-10-10 之前的行为，绝不更糟
  assert.equal(L.modal, 2147482000, 'modal 兜底值 = 旧的面板 Modal 字面量（无表即旧行为）');
  assert.equal(L.toast, 2147483000, 'toast 兜底值 = 旧的 toast 字面量');
});

test('公告板入表但不接管页面变量：--z-modal 仍是页面的 80，只命中我们自己的类', () => {
  const css = layerCss();
  const L = layers();
  assert.ok(css.includes(`html .sp-notice__overlay{z-index:var(--sp-z-notice,${L.notice})}`),
    '公告板由自有类 + html 前缀钉到 notice 层');
  assert.ok(!/--z-modal:/.test(css), '绝不在 :root 重新定义 --z-modal（会一并抬高整页游戏 UI）');
  const NB = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'notice-board.js'), 'utf8');
  assert.ok(NB.includes('z-index:var(--z-modal,80)'), '公告板自己的声明仍读页面变量（我们只是用更高特异性覆盖）');
});

test('固定点位（我们不改的文件）与层序表一致：toast 2147483000、面板 Modal 2147482000', () => {
  const L = layers();
  const KIT = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'overlayKit.js'), 'utf8');
  assert.ok(KIT.includes(`z-index:${L.toast}`), 'overlayKit 的 toast 与表一致（它在表外，必须一直是 toast 层）');
  const BRIDGE = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-bridge.js'), 'utf8');
  assert.ok(BRIDGE.includes(`'z-index:${L.toast}'`), 'shell-bridge 的遮罩与表一致');
  const PP = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'preloadPanel.js'), 'utf8');
  assert.ok(PP.includes(`z-index:${L.modal}`) || PP.includes('z-index:var(--sp-z-modal'),
    'preloadPanel 的垫片 Modal 落在 modal 步进（字面量或变量均可）');
});

test('层序注入无 DOM 时是安全 no-op（测试/老壳不炸）', async () => {
  const root = mkTree({ kit: true, store: true });
  try {
    const m = await load(root);
    assert.equal(typeof m.injectLayerStyles, 'function');
    assert.doesNotThrow(() => m.injectLayerStyles(), '没有 document 时注入必须静默返回');
    assert.deepEqual(Object.keys(m.SP_LAYERS).sort(), ['chip', 'first', 'host', 'modal', 'notice', 'toast'],
      'SP_LAYERS 必须导出（诊断/复用；2026-10-18 起含 first 全屏首页层）');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------
// 社区服务器（2026-10-17 业主口径）：清单最后一项「上传服务器」= 域名 + 备注（备注不填默认社区服并由
// 服务端代号命名）；玩家上传的行标「社区」；探测结果由 Java 侧回传（众包判定有效性）。
//
// 这里只钉**页面这一半**：行必须真的画出来（不是只写了代码）、上传必须走原生桥（WebView 里跨域
// POST 的预检过不去）、结果必须走事件回来。Java 那一半在 community-servers.test.mjs。
// ---------------------------------------------------------------------------------------------------

test('服务器面板渲染出「上传服务器」行（域名 + 备注 + 上传按钮）', async () => {
  const root = mkTree({ kit: true, store: true });
  try {
    const m = await load(root);
    m.openShellPanel('servers');
    const host = m.ShellPanelHost();
    // 用同一套 flatten 把 vnode 摊成文本（kit 的 render 只在 mount 时用，这里直接摊）
    const text = (function flat(v) {
      if (v === null || v === undefined || v === false || v === true) return '';
      if (typeof v === 'string' || typeof v === 'number') return String(v);
      if (Array.isArray(v)) return v.map(flat).join('');
      if (typeof v === 'function') {
        // 函数式组件（有 prototype）= 真的把它渲染出来；箭头函数是事件处理器/close，绝不调用。
        if (!v.prototype) return '';
        try { return flat(v({ onClose() {} })); } catch (e) { return ''; }
      }
      if (v && v.__stub === 'vnode') {
        let out = '';
        for (let i = 0; i < v.strings.length; i++) { out += v.strings[i]; if (i < v.vals.length) out += flat(v.vals[i]); }
        return out;
      }
      return '';
    })(host);
    assert.ok(text.includes('上传服务器'), '清单最后一项必须是「上传服务器」');
    assert.ok(text.includes('备注'), '上传必须带备注输入（备注不填 = 社区服 + 代号命名）');
    assert.ok(text.includes('上传'), '上传按钮文案');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('上传走原生桥 + 结果走事件回来（WebView 里跨域 POST 的预检过不去）', () => {
  // 桥调用：只认 window.shell.uploadCommunityServer（Java 侧后台线程 + HTTPS）
  assert.ok(SRC.includes('window.shell.uploadCommunityServer'), '必须调原生 uploadCommunityServer');
  assert.ok(SRC.includes("setUpState('sending')"), '上传中要有可见状态');
  // 结果通道：Java → __SP_SHELL.onCommunityUpload → sp-community-upload 事件 → 面板监听
  assert.ok(SRC.includes('__SP_SHELL.onCommunityUpload'), '结果入口必须挂在 __SP_SHELL（Java 侧调它）');
  assert.ok(SRC.includes("new CustomEvent('sp-community-upload'"), '结果必须以事件派发');
  assert.ok(SRC.includes("addEventListener('sp-community-upload'"), '面板必须监听该事件');
  assert.ok(SRC.includes("removeEventListener('sp-community-upload'"), '卸载时必须摘掉监听（防重挂）');
  // 社区行要能认出来
  assert.ok(SRC.includes('e.community ?'), 'serverCell 必须给社区行打标记');
  assert.ok(SRC.includes('玩家上传（未签名'), '社区行的 title 要说清它未签名');
});

test('社区清单不会被「探过没版本号就不列」的规则误伤（它本来就是探出来的）', () => {
  // 这条规则是业主 2026-10-17 定的：probed 但没 app 的条目不上清单。社区条目同样适用 ——
  // 上传了就探，探通且有版本才显示，所以过滤条件里**不许**为 community 开例外。
  const rowFilter = SRC.match(/\.filter\(\(e\) => !\(e\.probed === true && !e\.app\)\)/);
  assert.ok(rowFilter, '服务器面板必须保留「探过没版本号就不列」的过滤');
  assert.ok(!/community[^\n]*probed === true/.test(SRC), '不许给社区条目开旁路（探不通就是不该列）');
});

// ---------------------------------------------------------------------------------------------------
// 双实例缺陷（2026-10-17 本机仿真实测）：页面上同时存在两个 shellPanels 模块实例 ——
//   lobby.js      → import('/js/ui/shellPanels.js')   （本地树）
//   shell-bridge  → /__sp/ui/shellPanels.js           （拦截器映射到同一份文件，但 URL 不同）
// ESM 缓存按 URL 分家，于是面板状态/监听者/注册表/宿主句柄各有一份：绑监听的是 A，最后写
// window.__SP_SHELL.openPanel 的是 B ⇒ 齿轮点下去 currentPanel() 已经是 'servers'，宿主容器却
// kids=0、屏幕空白（实测数据）。修法 = 这几样放 window 单例 + 只让一个实例负责渲染。
// ---------------------------------------------------------------------------------------------------

test('面板状态 / 注册表 / 宿主句柄走窗口单例（两个模块实例共享一份）', () => {
  assert.ok(SRC.includes('window.__SP_PANEL_STATE'), '必须有窗口级单例键');
  assert.ok(/const SHARED = \(function \(\)/.test(SRC), 'SHARED 必须是模块求值时建立的单例');
  assert.ok(/if \(!window\.__SP_PANEL_STATE\) \{/.test(SRC), '单例必须「没有才建」（后到的实例沿用前一个）');
  assert.ok(SRC.includes('const panelRegistry = SHARED.registry;'), '面板注册表必须共享（lobby 注册、齿轮打开）');
  assert.ok(/SHARED\.listeners\.add\(fn\)/.test(SRC) && /for \(const fn of SHARED\.listeners\) fn\(kind\)/.test(SRC),
    '监听者必须共享，否则一个实例 setPanel 另一个实例收不到');
  assert.ok(/SHARED\.panelState = kind;/.test(SRC) && /return SHARED\.panelState;/.test(SRC),
    '面板状态必须共享（currentPanel 与 ShellPanelHost 读同一份）');
  assert.ok(/SHARED\.hostNode = host;/.test(SRC) && /hostObserver = SHARED\.hostObserver;/.test(SRC),
    '宿主句柄与 MutationObserver 必须共享（只许有一个容器、一个观察者）');
  // 渲染所有权：第二个实例不许再往同一个容器里开第二个 preact root
  assert.ok(/if \(SHARED\.owner && SHARED\.owner !== INSTANCE\) return host;/.test(SRC),
    '必须只有一个实例负责渲染（否则后渲染的那个用自己那份状态把面板擦掉）');
  assert.ok(/SHARED\.owner = INSTANCE;/.test(SRC), '所有权要落回单例');
  // 共享对象不许再出现模块级同名变量（会被两个实例各写一份，正是这个 bug 的形态）
  assert.ok(!/^let panelState = null;$/m.test(SRC), 'panelState 不许再是模块级变量');
  assert.ok(!/^const listeners = new Set\(\);$/m.test(SRC), 'listeners 不许再是模块级变量');
  assert.ok(!/^const panelRegistry = new Map\(\);$/m.test(SRC), 'panelRegistry 不许再是模块级变量');
});


// ---- 常量双写钉子（UI 审计 UI-2 R2 / 2026-10-18）--------------------------------------------------
// 这些值在多个叠加层里各有一份字面量（叠加层跨 origin 必须自带样式/常量，不共享模块 —— 见
// shellPanels 的 v7.4 动态 import 加固与 overlayKit 的自带纪律）。合并是不对的，**漂移也是不对的**：
// 这里把每一对拷贝钉住，改一处不改另一处就在这里红。

test('常量钉子: SP_LAYERS.first 与 first-screen 的孤儿 z-index 是同一个数', () => {
  assert.match(SRC, /SP_LAYERS = \{ first: 2147479000,/,
    'SP_LAYERS 必须登记 first 层（曾经是无主的 2147479000 字面量）');
  assert.match(FIRST, /\.sp-first-host\{position:relative;z-index:2147479000\}/,
    'first-screen 的层 z-index 必须仍是 2147479000（与 SP_LAYERS.first 同源同值）');
  assert.ok(FIRST.includes('2147479000'), 'boot 兜底层也用同一个数');
});

test('常量钉子: 延迟三色档 250/900 与三色 hex 在 rttDot / serverLevel / 两份 CSS 里一致', () => {
  // 逻辑双写：shellPanels.rttDot（面板）与 connect-core.serverLevel（首页/面板共用口径）
  assert.match(SRC, /if \(ms < 250\) return \{ color: '#4ed8af'/, 'rttDot 的良好档 250ms/绿');
  assert.match(SRC, /if \(ms < 900\) return \{ color: '#e0b64a'/, 'rttDot 的一般档 900ms/黄');
  assert.match(CONNECT, /if \(ms < 250\) return 'ok';/, 'serverLevel 的良好档 250ms');
  assert.match(CONNECT, /if \(ms < 900\) return 'warn';/, 'serverLevel 的一般档 900ms');
  // 颜色双写：同三个 hex 也必须出现在 first-screen 与 preloadPanel 的清单点样式里
  for (const hex of ['#4ed8af', '#e0b64a', '#e06c5a']) {
    assert.ok(FIRST.includes(hex), 'first-screen 缺延迟色 ' + hex);
    assert.ok(PRELOAD.includes(hex), 'preloadPanel 缺延迟色 ' + hex);
  }
});

test('常量钉子: 房间码两套口径并存是有意的（严格字母表 vs 宽松校验），不许悄悄变成第三套', () => {
  // 严格口径（上游字母表，无 I/O）：输入归一化/加入链接用 —— lobby 与 shell-join
  assert.match(LOBBY, /\[A-HJ-NP-Z\]\{4\}/, 'lobby 的严格字母表丢了');
  assert.match(JOIN, /\[A-HJ-NP-Z\]\{4\}/, 'shell-join 的严格字母表丢了');
  // 宽松口径（展示校验：store 里的 room.code 只验形状）—— connect-core 与 room-hook
  assert.match(CONNECT, /\[A-Z0-9\]\{4\}/, 'connect-core 的宽松校验丢了');
  assert.match(ROOMHOOK, /\[A-Z0-9\]\{4\}/, 'room-hook 的宽松校验丢了');
});
