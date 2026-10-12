// touch-targets 的静态/行为测试：真跑一遍要注入的模块（vm + 最小 DOM 桩），再钉住它注入的规则本身。
//
// 覆盖：注入 <style id="sp-touch-targets">（且只有一个）/ **每条规则都在 coarse + <768px 的 media 内**
//       （桌面与鼠标端必须逐字不变）/ 只放视觉尺寸与 .dpanel 让位，绝不碰 --tap-min 与通用命中区
//       规则（放大会像商店卡片那样压到邻居）/ 四按钮与图标同比例放大 / .dpanel 偏移按同公式重算
//       / 幂等 / 无 document 静默 / shell-bridge 从 /__sp/ 装载并带幂等标记 / 源码不变量。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'touch-targets.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-bridge.js'), 'utf8');
const STYLE_ID = 'sp-touch-targets';

function mkEl(tag, parent) {
  return {
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
}

function mkWorld({ withDocument = true } = {}) {
  const head = mkEl('head');
  const doc = withDocument ? {
    head, body: mkEl('body'), documentElement: head,
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

const run = (w) => vm.runInNewContext(SRC, w.sandbox, { filename: 'touch-targets.js' });
const styleOf = (w) => w.head._kids.find((el) => el.tagName === 'STYLE') || null;

test('注入一个 <style id="sp-touch-targets">，且所有规则都在 coarse + <768px 的 media 内', () => {
  const w = mkWorld();
  run(w);
  const st = styleOf(w);
  assert.ok(st, '必须注入一个 <style>');
  assert.equal(st.getAttribute('id'), STYLE_ID);
  const css = st.textContent;

  // 整个文件只允许一个 @media 块，且它必须是「手机」条件 —— 桌面/鼠标端逐字不变是硬约束。
  const opens = css.match(/@media[^{]+\{/g) || [];
  assert.equal(opens.length, 1, `只允许一个 @media 块，实际 ${opens.length}`);
  assert.ok(/\(max-width:\s*767px\)\s*and\s*\(pointer:\s*coarse\)/.test(opens[0]), '必须是窄视口 + coarse');
  assert.ok(/\(any-pointer:\s*coarse\)/.test(opens[0]), 'any-pointer 变体也要覆盖（外接键鼠的触屏设备）');

  // media 块之外不许有任何裸规则（否则会影响桌面）
  const before = css.slice(0, css.indexOf('@media')).trim();
  assert.equal(before, '', '@media 之前不许有规则');
  assert.ok(css.trimEnd().endsWith('}'), '块必须闭合');
  assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length, '括号配平');

  assert.equal(w.win.__SP_TOUCH_TARGETS.css, css, 'API 里带着同一份 CSS（外部可校验）');
});

test('只放视觉尺寸：绝不碰 --tap-min，也绝不改通用命中区 ::before 规则', () => {
  const css = styleOf(mkWorldAfterRun()).textContent;
  assert.ok(!css.includes('--tap-min'), '命中区尺寸不许动（devices.css 的 44px 已达标）');
  assert.ok(!css.includes('::before'), '通用命中区规则不许动（放大会压到邻居，商店卡片就是前车之鉴）');
});

function mkWorldAfterRun() { const w = mkWorld(); run(w); return w; }

test('四按钮与图标同比例放大（图标保持按钮的一半，不是小图标塞大框）', () => {
  const css = styleOf(mkWorldAfterRun()).textContent;
  assert.ok(/\.gm__corner\s*>\s*\.gm__gear[^}]*width:\s*\.82rem\s*!important/.test(css), '按钮放大到 .82rem');
  assert.ok(/\.gm__corner\s*>\s*\.gm__gear\s*>\s*\.icon[^}]*width:\s*\.44rem/.test(css), '图标同步放大到 .44rem');
  // 放大后的按钮/图标比与 devices.css 原档一致（.56 / .28）
  assert.ok(css.includes('.ewheel__btn') && css.includes('.fsbtn'), '左下角四个按钮都要覆盖（含全屏）');
});

test('.dpanel 偏移按 devices.css 的同一公式重算（放大后详情卡不许压住按钮）', () => {
  const css = styleOf(mkWorldAfterRun()).textContent;
  assert.ok(/\.dpanel:not\(\.dpanel--right\)/.test(css), '左停靠详情卡要让位');
  assert.ok(/max\(1\.51rem,\s*96px\)\s*\*\s*55\s*\/\s*151/.test(css), '沿用 devices.css 的同一换算式');
  assert.ok(/\.44rem\s*\+\s*[^;]*\.82rem/.test(css), '偏移量随按钮尺寸同步抬升（原来是 .56rem）');
  // 角宽度也必须跟着按钮重算，否则换行宽度与放大后的按钮不匹配
  assert.ok(/\.gm__corner\s*\{[^}]*calc\(3\s*\*\s*\.82rem\s*\+\s*\.2rem\)/.test(css), '角宽度按 3 * 按钮 + gap 重算');
});

test('表情气泡：字号与上限都放大，且带 px 下限（rem 被夹小时不至于缩回）', () => {
  const css = styleOf(mkWorldAfterRun()).textContent;
  assert.ok(/\.ebubble\s*\{[^}]*font-size:\s*max\(\.18rem,\s*15px\)\s*!important/.test(css), '气泡字号带 15px 下限');
  assert.ok(/\.ebubble\s*\{[^}]*max-width:\s*4\.8rem\s*!important/.test(css), '气泡宽度上限同步放宽');
});

test('幂等：跑两次只有一个标签（加载器守卫的基础）', () => {
  const w = mkWorld();
  run(w); run(w);
  assert.equal(w.head._kids.filter((el) => el.tagName === 'STYLE').length, 1, '不许叠第二个 <style>');
});

test('无 document（非浏览器环境）时静默返回，不抛', () => {
  const w = mkWorld({ withDocument: false });
  assert.doesNotThrow(() => run(w));
  assert.equal(w.win.__SP_TOUCH_TARGETS, undefined, '没有 DOM 就整个早退（不建标签、不置标记）');
});

test('shell-bridge 装载：/__sp/ 前缀 + 幂等标记守卫 + 插入序，绝不用页面路径', () => {
  const at = BRIDGE.indexOf('2026-10-12（审计 Paper-Yuan 0.2.4 后取用）');
  assert.ok(at > 0, 'shell-bridge.js 里必须有 touch-targets 装载段');
  const block = BRIDGE.slice(at);
  const iSfx = BRIDGE.indexOf("'/__sp/screen-fixes.js'");
  const iTt = block.indexOf("'/__sp/touch-targets.js'");
  const iSc = BRIDGE.indexOf("'/__sp/server-config.js'");
  assert.ok(iTt > 0, '必须从外壳自有前缀取（filesDir 热更树 → APK，绝不走网络）');
  assert.ok(iSfx > 0 && iSfx < at, 'touch-targets 接在 screen-fixes 之后（同属壳侧 CSS 注入）');
  assert.ok(iSc > at, '且在 server-config 之前（不打断既有装载次序）');
  assert.ok(block.slice(iTt - 200, iTt).includes('window.__SP_TOUCH_TARGETS'), '幂等标记必须守卫装载');
  assert.ok(!/src = ['"][^'"]*\/js\/touch-targets\.js['"]/.test(block), '绝不能从页面的 /js/ 取');
});

test('源码不变量：首行 /* global */、纯 ASCII、ES5、带幂等标记', () => {
  assert.ok(SRC.startsWith('/* global window, document */'), 'extras 的首行 /* global … */ 头必须保留');
  assert.ok(!/[^\x00-\x7F]/.test(SRC), '脚本必须纯 ASCII');
  assert.ok(!/\b(const|let|=>)\b/.test(SRC), '必须 ES5（老 WebView 下限 Chromium 89 之前的机器也要能跑）');
  assert.ok(SRC.includes('window.__SP_TOUCH_TARGETS'), '必须带幂等标记');
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest/.test(SRC), '绝不能发起网络请求');
});
