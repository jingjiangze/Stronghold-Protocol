// screen-fixes 的静态/行为测试：真跑一遍要注入的模块（vm + 最小 DOM 桩），再钉住它注入的规则本身。
//
// 覆盖：注入 <style id="sp-screen-fixes">（且只有一个）/ 规则严格限定在 .screen.brief 之下（不许出现
//       裸 .brief__left 规则）/ 左列 overflow-y:auto + 与 .brief__right 同款 padding-right /
//       源码注释里保留实测裁切数字（844x390 15.1px、1600x900@1.5 345.0/420.3px）/
//       幂等（跑两次不叠标签）/ 无 document 时静默 / shell-bridge 从 /__sp/ 装载并带幂等标记 /
//       源码不变量：首行 /* global */、纯 ASCII、ES5。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'screen-fixes.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-bridge.js'), 'utf8');
const STYLE_ID = 'sp-screen-fixes';

function mkEl(tag, parent) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    textContent: '', parentNode: parent || null,
    _attrs: {}, _kids: [],
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    appendChild(c) {
      if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c);
      c.parentNode = this; this._kids.push(c); return c;
    },
    removeChild(c) { const i = this._kids.indexOf(c); if (i >= 0) this._kids.splice(i, 1); c.parentNode = null; return c; },
  };
  return el;
}

/** 最小页面：head 可挂 style，getElementById 走真实的树查找（幂等判断才真的被测到）。 */
function mkWorld({ withDocument = true } = {}) {
  const head = mkEl('head');
  const doc = withDocument ? {
    head,
    body: mkEl('body'),
    documentElement: head,
    createElement: (t) => mkEl(t),
    getElementById(id) {
      const walk = (n) => {
        if (n.getAttribute && n.getAttribute('id') === id) return n;
        for (const k of (n._kids || [])) { const r = walk(k); if (r) return r; }
        return null;
      };
      return walk(head);
    },
    addEventListener() {},
  } : undefined;
  const win = {};
  return { win, doc, head, sandbox: { window: win, document: doc, console, setTimeout, clearTimeout } };
}

const run = (w) => vm.runInNewContext(SRC, w.sandbox, { filename: 'screen-fixes.js' });

const styleOf = (w) => w.head._kids.find((el) => el.tagName === 'STYLE') || null;

test('注入一个 <style id="sp-screen-fixes">，规则严格限定在 .screen.brief 之下', () => {
  const w = mkWorld();
  run(w);
  const st = styleOf(w);
  assert.ok(st, '必须注入一个 <style>');
  assert.equal(st.getAttribute('id'), STYLE_ID);
  const css = st.textContent;
  assert.ok(css.includes('.screen.brief > .brief__main > .brief__left{'), '左列规则必须是精确的三级链');
  assert.ok(/overflow-y:auto/.test(css), '左列要滚动而不是被裁');
  assert.ok(/padding-right:\.06rem/.test(css), 'padding-right 与 .brief__right 同款（滚动条不压卡片边）');
  // 不许放一条会影响别的屏/别的元素的裸规则
  const selectors = css.match(/[^{}]+\{/g) || [];
  assert.ok(selectors.length === 1, `只允许一条规则，实际 ${selectors.length}`);
  for (const sel of selectors) {
    assert.ok(sel.trim().startsWith('.screen.brief > .brief__main > .brief__left'), `选择器必须以 .screen.brief 开头：${sel}`);
    assert.ok(!/^\s*\.brief__(left|factions|right)/.test(sel), `不许出现裸 .brief__ 规则：${sel}`);
  }
  // 外部可读：API 里带着同一份 CSS（测试与外部脚本可校验注入内容）
  assert.equal(w.win.__SP_SCREEN_FIXES.css, css);
});

test('幂等：跑两次只有一个标签（加载器守卫的基础）', () => {
  const w = mkWorld();
  run(w);
  run(w);
  assert.equal(w.head._kids.filter((el) => el.tagName === 'STYLE').length, 1, '不许叠第二个 <style>');
});

test('无 document（非浏览器环境）时静默返回，不抛', () => {
  const w = mkWorld({ withDocument: false });
  assert.doesNotThrow(() => run(w));
  assert.equal(w.win.__SP_SCREEN_FIXES, undefined, '没有 DOM 就整个早退（不建标签、不置标记）');
});

test('源码注释里保留实测数字（回归时能对着改）', () => {
  assert.ok(SRC.includes('844x390'), '注释要写实测视口');
  assert.ok(SRC.includes('55.0') && SRC.includes('15.1'), '844x390 的两次实测裁切量（带/不带字体树）');
  assert.ok(SRC.includes('418.3') && SRC.includes('345.0'), '1600x900@fontScale1.5 的实测裁切量');
  assert.ok(SRC.includes('b2-flow.mjs'), '注释要指向测量工具');
});

test('shell-bridge 装载：/__sp/ 前缀 + 幂等标记守卫 + 插入序，绝不用页面路径', () => {
  const at = BRIDGE.indexOf('v6.11');
  assert.ok(at > 0, 'shell-bridge.js 里必须有 v6.11 装载段');
  const block = BRIDGE.slice(at);
  const iApp = BRIDGE.indexOf("'/__sp/appearance.js'");
  const iSfx = block.indexOf("'/__sp/screen-fixes.js'");
  assert.ok(iSfx > 0, '必须从外壳自有前缀取（filesDir 热更树 → APK，绝不走网络）');
  assert.ok(iApp > 0 && iApp < at, 'screen-fixes 接在 appearance 之后（同属壳侧 CSS 注入）');
  assert.ok(block.slice(iSfx - 160, iSfx).includes('window.__SP_SCREEN_FIXES'), '幂等标记必须守卫装载');
  assert.ok(!/src = ['"][^'"]*\/js\/screen-fixes\.js['"]/.test(block), '绝不能从页面的 /js/ 取');
  const iNb = BRIDGE.indexOf("'/__sp/notice-board.js'");
  assert.ok(iNb > at, '装载顺序：appearance → screen-fixes → notice-board → … → skin-layer 不动');
});

test('源码不变量：首行 /* global */、纯 ASCII、ES5、带幂等标记', () => {
  assert.ok(SRC.startsWith('/* global window, document */'), 'extras 的首行 /* global … */ 头必须保留');
  assert.ok(!/[^\x00-\x7F]/.test(SRC), '脚本必须纯 ASCII');
  assert.ok(!/=>/.test(SRC), '不许用箭头函数');
  assert.ok(!/\bconst\b/.test(SRC) && !/\blet\b/.test(SRC), '不许用 const/let');
  assert.ok(SRC.indexOf('`') < 0, '不许用模板字符串');
  assert.ok(SRC.indexOf('__SP_SCREEN_FIXES') >= 0);
});
