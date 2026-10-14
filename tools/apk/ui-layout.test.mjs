// ui-layout.test.mjs -- js/ui-layout.js (the UI-layout engine) + its wiring.
//
// 业主 2026-10-14：「内置一个样式大小位置预览图：读玩家手机分辨率 → 空画布 → 把 UI 以简化图形画上去 →
// 可缩放可拖动地图形化改 UI 大小与位置」。审计结论 = 部分可行（DOM HUD 可，canvas/WebGL 战场不可），
// 本文件钉的是审计点名的那些**硬约束**——它们每一条都是「改错了不会报错、只会静默失效」的那类：
//
//   · 只覆盖 7 个容器，**绝不**碰 `.gm__hud` 与 `--sa-*`（那是 appearance.js 的 sidePad 地盘，
//     覆盖父容器会让两个功能互相抵消）；
//   · 只出 CSS（`<style id="sp-ui-layout">`），**不写上游 DOM 内联样式**（HUD 是 Preact 渲染的，
//     六个状态类自己会翻，写进 style="" 会被下一次 render 冲掉）；
//   · 存 rem 不存 px（上游 508 处 rem + 19 处 max(rem,px) 地板值，根字号随 fontScale 与视口变）；
//   · `.ticker` 自带 `transform: translateX(-50%)`，我们的位移必须**接在它后面**而不是替掉它；
//   · 只有「真的改过」的选择器才出规则 —— 没开过编辑器的玩家必须是严格 no-op。
//
//   node --test tools/apk/ui-layout.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
const SRC = read('tools/apk/extras/public/js/ui-layout.js');
const PANEL = read('tools/apk/extras/public/js/ui/layoutPanel.js');
const BRIDGE = read('tools/apk/extras/public/js/shell-bridge.js');
const PREFS = read('tools/apk/extras/public/js/shell-prefs.js');
const CONTRACT = read('tools/apk/check-upstream-contract.mjs');
const SHELL_PANELS = read('tools/apk/extras/public/js/ui/shellPanels.js');

const EDITABLE = ['.gtop', '.gm__bonds', '.team', '.gm__effects', '.gm__corner', '.shopbar', '.ticker'];

/** A minimal DOM good enough for the engine: one style tag, one rect per selector, a root font size.
 *  `rects` lets a test place the boxes; a selector missing from it resolves to null (not on screen). */
function mkWorld(opt) {
  const o = opt || {};
  const prefs = new Map();
  const styleTags = [];
  const rootPx = o.rootPx || 40;
  const rects = o.rects || {};
  const world = {
    console, JSON, Math, Object, Array, Number, String, Boolean, isFinite, parseFloat, parseInt, Date,
    document: null,
    localStorage: {
      getItem: (k) => (prefs.has('ls:' + k) ? prefs.get('ls:' + k) : null),
      setItem: (k, v) => prefs.set('ls:' + k, String(v)),
      removeItem: (k) => prefs.delete('ls:' + k),
    },
    getComputedStyle: () => ({ fontSize: rootPx + 'px' }),
    innerWidth: o.w || 1280,
    innerHeight: o.h || 720,
    devicePixelRatio: o.dpr || 2,
    addEventListener() {}, removeEventListener() {},
  };
  world.__SP_PREFS = {
    get: (k) => (prefs.has('pref:' + k) ? JSON.parse(JSON.stringify(prefs.get('pref:' + k))) : null),
    set: (k, v) => { prefs.set('pref:' + k, JSON.parse(JSON.stringify(v))); return true; },
    remove: (k) => prefs.delete('pref:' + k),
  };
  const els = {};
  const el = (sel) => {
    if (!els[sel]) {
      els[sel] = {
        _sel: sel,
        style: {},                       // 运行时断言用：上游元素的内联样式必须一直为空
        setAttribute() {}, getAttribute: () => null,
        getBoundingClientRect: () => (rects[sel] ? Object.assign({ right: 0, bottom: 0 }, rects[sel]) : null),
      };
    }
    return els[sel];
  };
  const doc = {
    documentElement: {},
    head: { appendChild: (n) => { styleTags.push(n); } },
    body: { appendChild: (n) => { styleTags.push(n); } },
    createElement: () => ({ _text: '', setAttribute(k, v) { this['_' + k] = v; }, get textContent() { return this._text; }, set textContent(v) { this._text = v; } }),
    getElementById: (id) => styleTags.find((t) => t._id === id) || null,
    querySelector: (sel) => (rects[sel] !== undefined ? el(sel) : null),
  };
  world.document = doc;
  world.window = world;
  vm.createContext(world);
  vm.runInContext(SRC, world, { filename: 'ui-layout.js' });
  return { world, prefs, styleTags, els };
}

/** Re-realm a value out of the vm context: deepStrictEqual also compares prototypes, and an object
 *  built inside vm.createContext has that realm's Object.prototype (so a direct compare always fails). */
const plain = (x) => JSON.parse(JSON.stringify(x));

const RECTS = {
  '.gtop': { left: 0, top: 0, width: 1280, height: 80 },
  '.gm__bonds': { left: 62, top: 54, width: 208, height: 40 },
  '.team': { left: 9, top: 94, width: 200, height: 300 },
  '.gm__effects': { left: 1100, top: 96, width: 160, height: 120 },
  '.gm__corner': { left: 10, top: 660, width: 240, height: 50 },
  '.shopbar': { left: 1150, top: 600, width: 120, height: 110 },
  '.ticker': { left: 500, top: 40, width: 304, height: 12 },
  '.gm__field': { left: 0, top: 0, width: 1280, height: 720 },
};

// ===================================================================================================
// the engine
// ===================================================================================================

test('引擎：七个容器是唯一可编辑项，战场只读（审计：canvas 不可布局）', () => {
  const { world } = mkWorld({ rects: RECTS });
  const api = world.__SP_UI_LAYOUT;
  assert.ok(api && api.available, '引擎装上了');
  assert.deepEqual(plain(api.EDITABLE.map((e) => e.sel)), EDITABLE, '恰好这七个，顺序即编辑器顺序');
  assert.deepEqual(plain(api.READONLY.map((e) => e.sel)), ['.gm__field'], '战场只读占位');
  // 硬约束：`.gm__hud` 绝不能出现在任何一张表里（它的 inset 吃 --sa-l/--sa-r，归 appearance.js）
  const all = plain(api.EDITABLE.concat(api.READONLY).map((e) => e.sel));
  assert.equal(all.includes('.gm__hud'), false, '绝不接管 .gm__hud（否则与 sidePad 互相抵消）');
});

test('引擎：没改过任何东西时是严格 no-op（空 <style>，规则一条都不出）', () => {
  const { world, styleTags } = mkWorld({ rects: RECTS });
  assert.equal(world.__SP_UI_LAYOUT._cssFor(world.__SP_UI_LAYOUT.get()), '', '空状态 -> 空 CSS');
  assert.equal(styleTags.length, 1, '但那张 <style> 存在（编辑器据此判断层在不在）');
  assert.equal(styleTags[0]._id, 'sp-ui-layout');
  assert.equal(styleTags[0].textContent, '');
});

test('引擎：位移只出 transform，且 .ticker 的 -50% 居中被接住而不是替掉', () => {
  const { world } = mkWorld({ rects: RECTS });
  const api = world.__SP_UI_LAYOUT;
  api.set('.gtop', { dx: 1.5, dy: -0.25 });
  let css = api._cssFor(api.get());
  assert.equal(css, '.gtop{transform:translate(1.5rem,-0.25rem) !important}', '只出改过的那个选择器');
  api.set('.ticker', { dx: 2 });
  css = api._cssFor(api.get());
  assert.ok(/\.ticker\{transform:translateX\(-50%\) translate\(2rem,0rem\) !important\}/.test(css),
    '.ticker 自带 translateX(-50%)：我们的位移必须接在它后面（否则居中被打掉）');
});

test('引擎：CSS 绝不出现 .gm__hud 或 --sa-*（与 appearance.js 的边界）', () => {
  const { world } = mkWorld({ rects: RECTS });
  const api = world.__SP_UI_LAYOUT;
  api.set('.gtop', { dx: 1 });
  api.set('.gm__corner', { w: 6, h: 2 });
  api.set('.team', { dy: 3 });
  const css = api._cssFor(api.get());
  assert.equal(/\.gm__hud/.test(css), false, '不得出现 .gm__hud');
  assert.equal(/--sa-/.test(css), false, '不得出现 --sa-* 变量');
  assert.equal(/safe-area/.test(css), false, '不得碰安全区');
  // 源码级：整个引擎也不该写这两个东西
  assert.equal(/\.gm__hud\s*\{/.test(SRC), false, '源码里没有 .gm__hud 的规则');
});

test('引擎：改尺寸出 width/height（rem），清除单项回上游', () => {
  const { world } = mkWorld({ rects: RECTS });
  const api = world.__SP_UI_LAYOUT;
  api.set('.shopbar', { w: 3, h: 2.5 });
  assert.equal(api._cssFor(api.get()), '.shopbar{width:3rem !important;height:2.5rem !important}');
  api.set('.shopbar', { w: null, h: null });
  assert.equal(api._cssFor(api.get()), '', '清掉之后一条规则都不剩');
  assert.deepEqual(plain(api.get().items), {}, '条目也从状态里消失');
});

test('引擎：未知选择器与非数值一律丢弃（vault 里手改也注入不了任意 CSS）', () => {
  const api = mkWorld({ rects: RECTS }).world.__SP_UI_LAYOUT;
  assert.equal(api.set('body', { dx: 1 }), false, '不在白名单里的选择器直接拒绝');
  assert.equal(api.set('.gtop', { dx: 'evil' }), true, '调用本身不抛');
  assert.deepEqual(plain(api.get().items), {}, '非数值不被采纳');
  const n = api._normalize({ items: { '.gtop': { dx: 1, evil: 9 }, 'body': { dx: 5 }, '.team': { dx: 'x' } } });
  assert.deepEqual(plain(Object.keys(n.items)), ['.gtop'], '只留白名单内、且至少有一个有效数值的项');
  assert.deepEqual(plain(n.items['.gtop']), { dx: 1 }, '未知键不进状态');
});

test('引擎：rem 存储 —— 量出来的 px 除以根字号（换字号/换设备不跑偏）', () => {
  const { world } = mkWorld({ rects: RECTS, rootPx: 40 });
  const m = world.__SP_UI_LAYOUT.measure();
  assert.equal(m.vp.rootPx, 40);
  assert.equal(m.vp.w, 1280);
  assert.equal(m.vp.dpr, 2);
  const gtop = m.items.find((i) => i.sel === '.gtop');
  assert.equal(gtop.box.h, 2, '80px / 40px = 2rem');
  const bonds = m.items.find((i) => i.sel === '.gm__bonds');
  assert.equal(bonds.box.x, 62 / 40, 'left 62px -> 1.55rem');
  // 换根字号：同一个 DOM 量出来是另一个 rem 值（所以存 px 会立刻过期）
  const big = mkWorld({ rects: RECTS, rootPx: 60 }).world.__SP_UI_LAYOUT.measure();
  assert.equal(big.items.find((i) => i.sel === '.gtop').box.h, 80 / 60, '根字号变了，rem 值随之变');
});

test('引擎：容器不在当前界面时 box=null（编辑器如实说，不画在 0,0）', () => {
  const { world } = mkWorld({ rects: { '.gtop': RECTS['.gtop'] } });
  const m = world.__SP_UI_LAYOUT.measure();
  assert.ok(m.items.find((i) => i.sel === '.gtop').box, '在的容器有盒子');
  assert.equal(m.items.find((i) => i.sel === '.team').box, null, '不在的容器 box=null');
});

test('引擎：持久化走 shell-prefs（跨 origin），读回同一份', () => {
  const { world, prefs } = mkWorld({ rects: RECTS });
  const api = world.__SP_UI_LAYOUT;
  api.set('.team', { dx: 2, dy: 1 });
  assert.ok(prefs.has('pref:ui.layout'), '写进了 shell-prefs 命名空间（不是只写 localStorage）');
  assert.deepEqual(plain(prefs.get('pref:ui.layout').items['.team']), { dx: 2, dy: 1 });
  // 换一个 origin（新引擎实例、localStorage 空）仍读得回同一份 —— 这正是走 prefs 的意义
  const second = mkWorld({ rects: RECTS });
  second.world.__SP_PREFS = world.__SP_PREFS; // 同一份 vault
  vm.runInContext(SRC.replace('if (window.__SP_UI_LAYOUT) return;', ''), second.world, { filename: 'ui-layout-2.js' });
  assert.deepEqual(plain(second.world.__SP_UI_LAYOUT.get().items['.team']), { dx: 2, dy: 1 }, '换 origin 后布局还在');
});

test('引擎：reset 清状态 + 清存储 + 清样式', () => {
  const { world, prefs, styleTags } = mkWorld({ rects: RECTS });
  const api = world.__SP_UI_LAYOUT;
  api.set('.gtop', { dx: 3 });
  api.reset();
  assert.deepEqual(plain(api.get().items), {});
  assert.equal(prefs.has('pref:ui.layout'), false, '存储也清了');
  assert.equal(styleTags[0].textContent, '', '样式表回到空');
});

// ===================================================================================================
// the wiring (each one is a silent-failure guard)
// ===================================================================================================

test('接线：shell-bridge 从 /__sp/ 注入引擎与编辑器，各自带幂等标记', () => {
  assert.ok(BRIDGE.includes("'/__sp/ui-layout.js'"), '引擎按名注入');
  assert.ok(BRIDGE.includes('window.__SP_UI_LAYOUT'), '引擎的幂等标记守卫');
  assert.ok(BRIDGE.includes("'/__sp/ui/layoutPanel.js'"), '编辑器按名注入');
  assert.ok(BRIDGE.includes('window.__SP_LAYOUT_PANEL'), '编辑器的幂等标记守卫');
  // 编辑器是 ESM（与 modsPanel.js 同一套），引擎是经典脚本
  const i = BRIDGE.indexOf("'/__sp/ui/layoutPanel.js'");
  assert.ok(/lp\.type\s*=\s*'module'/.test(BRIDGE.slice(i - 200, i + 200)), '编辑器按 module 注入');
  const j = BRIDGE.indexOf("'/__sp/ui-layout.js'");
  assert.ok(!/type\s*=\s*'module'/.test(BRIDGE.slice(j - 200, j + 200)), '引擎是经典脚本（IIFE）');
});

test('接线：shell-prefs 注册 ui.layout（跨 origin 真源）', () => {
  assert.ok(/\{ key: 'ui\.layout', ls: 'sp\.ui\.layout' \}/.test(PREFS), 'REGISTRY 里有 ui.layout');
});

test('接线：入口在外观面板（打开 kind uilayout），编辑器自注册到面板宿主', () => {
  assert.ok(/openShellPanel\('uilayout'\)/.test(SHELL_PANELS), '外观面板里有打开布局编辑器的按钮');
  assert.ok(/registerPanel\('uilayout', LayoutPanel\)/.test(PANEL), '编辑器把自己注册成 uilayout 面板');
  assert.ok(/window\.__SP_LAYOUT_PANEL = true/.test(PANEL), '幂等标记');
});

test('接线：七个容器 + 战场进了上游锚点门禁（上游改名 -> CI 红，而不是编辑器静默少一格）', () => {
  for (const id of ['hud:gtop', 'hud:gm__bonds', 'hud:team', 'hud:gm__effects', 'hud:gm__corner', 'hud:shopbar', 'hud:ticker', 'hud:gm__field']) {
    assert.ok(CONTRACT.includes(id), 'DOM_ANCHORS 缺 ' + id);
  }
  assert.ok(/uiLayout: 'tools\/apk\/extras\/public\/js\/ui-layout\.js/.test(CONTRACT), '锚点指向 ui-layout 这一束');
});

test('编辑器：画布 + 拖拽 + 只读战场提示（业主口径的形态）', () => {
  assert.ok(/<canvas/.test(PANEL), '是一张画布');
  assert.ok(/getContext\('2d'\)/.test(PANEL), '2D 绘制');
  assert.ok(/onPointerDown=/.test(PANEL) && /onPointerMove=/.test(PANEL), '可拖动');
  assert.ok(/HANDLE/.test(PANEL), '有右下角缩放手柄');
  assert.ok(/战场（canvas，不可布局）/.test(SRC), '战场只读的说明在引擎的 READONLY 表里');
  assert.ok(/setLineDash/.test(PANEL), '只读项画成虚线（与可编辑项区分）');
  assert.ok(/touch-action:none/.test(PANEL), '触屏上拖动不被浏览器手势抢走');
});

test('红线②（运行时）：改布局只写自己的 <style>，上游元素的内联样式一个字节都不碰', () => {
  const { world, styleTags, els } = mkWorld({ rects: RECTS });
  const api = world.__SP_UI_LAYOUT;
  // 先量一次，让 querySelector 走过所有容器（元素对象才会被建出来）
  api.measure();
  api.set('.gtop', { dx: 1.5, dy: -0.25 });
  api.set('.team', { w: 4, h: 6 });
  api.set('.gm__corner', { dx: 1 });
  for (const sel of EDITABLE) {
    const el = els[sel];
    if (!el) continue;
    assert.deepEqual(Object.keys(el.style), [], sel + ' 不得被写上任何内联样式（上游是 Preact 渲染的，写进去会被下一次 render 冲掉）');
  }
  const css = styleTags[0].textContent;
  assert.ok(/\.gtop\{/.test(css) && /\.team\{/.test(css), '规则只出现在我们自己的 <style id="sp-ui-layout"> 里');
  // 源码级：引擎里不得有写上游元素 style 的路径
  assert.equal(/\.style\./.test(SRC), false, '引擎源码里不得出现 el.style.* 的写入');
  assert.equal(/cssText/.test(SRC), false, '引擎源码里不得出现 cssText');
});
