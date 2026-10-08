// appearance 的行为测试：vm + 最小 DOM 桩，真跑一遍外观切换逻辑（不引入任何依赖）。
//
// 覆盖：set 后 <style id="sp-appearance"> 内容含正确变量与使用规则 / 默认值不注入（严格 no-op）/
//       持久化读取（__SP_DATA 优先、跨"会话"回放）/ reset 撤销注入并写回默认 /
//       持久化失败仍会话内生效 / 幂等（不叠 style 标签）/ 合并写入不覆盖音频等其它设置 /
//       越界钳制 / 源码纯 ASCII。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'appearance.js'), 'utf8');

/** vm 里造出来的对象带着另一个 realm 的原型，deepStrictEqual 会因原型不同而失败：先取纯字段。 */
const plain = (o) => ({ fontScale: o.fontScale, sidePad: o.sidePad });

function mkEl(tag, parent) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    textContent: '', parentNode: parent || null,
    _attrs: {}, _kids: [],
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    removeAttribute(n) { delete this._attrs[n]; },
    appendChild(c) {
      if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c);
      c.parentNode = this; this._kids.push(c); return c;
    },
    removeChild(c) { const i = this._kids.indexOf(c); if (i >= 0) this._kids.splice(i, 1); c.parentNode = null; return c; },
  };
  return el;
}

function findById(id, root) {
  if (!root) return null;
  if (root.getAttribute && root.getAttribute('id') === id) return root;
  for (const k of (root._kids || [])) { const r = findById(id, k); if (r) return r; }
  return null;
}

function mkLS(opts = {}) {
  const m = new Map();
  return {
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (opts.throwOnSet) throw new Error('quota'); m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    _map: m,
  };
}

/** player-data v1 的最小桩：recordSettings 与真实 sanitizeSettingsBlob 一样"整份快照 + 默认填充"。 */
function mkData(initial, opts = {}) {
  const doc = initial || { v: 1, deviceId: 'dev', settings: null };
  return {
    _doc: doc,
    exportJSON() { return JSON.stringify(doc); },
    recordSettings(s) {
      if (opts.throwOnRecord) throw new Error('boom');
      const cur = doc.settings || {};
      const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
      doc.settings = {
        bgm: num(s.bgm, cur.bgm === undefined ? 0.6 : cur.bgm),
        sfx: num(s.sfx, cur.sfx === undefined ? 0.8 : cur.sfx),
        muted: typeof s.muted === 'boolean' ? s.muted : !!cur.muted,
        damageNumbers: typeof s.damageNumbers === 'boolean' ? s.damageNumbers : cur.damageNumbers !== false,
        quality: typeof s.quality === 'string' ? s.quality : (cur.quality || 'high'),
        fontScale: num(s.fontScale, 1),
        sidePad: num(s.sidePad, 0),
        ts: Date.now(),
      };
    },
  };
}

function mkWorld() {
  const htmlEl = mkEl('html');
  const head = mkEl('head');
  const body = mkEl('body');
  htmlEl.appendChild(head);
  htmlEl.appendChild(body);
  const clock = { t: 1e12 };
  const document = {
    readyState: 'complete', documentElement: htmlEl, head, body,
    createElement(tag) { return mkEl(tag); },
    getElementById(id) { return findById(id, htmlEl); },
  };
  return {
    document, htmlEl, head, body, clock,
    style: () => findById('sp-appearance', htmlEl),
  };
}

function run(world, opts = {}) {
  const win = {
    localStorage: opts.ls || mkLS(),
    addEventListener() {},
  };
  if (opts.data !== undefined) win.__SP_DATA = opts.data;
  if (opts.prefs !== undefined) win.__SP_PREFS = opts.prefs;
  const sandbox = {
    window: win, document: world.document,
    Date: { now: () => world.clock.t },
    Promise, console,
  };
  vm.runInNewContext(SRC, sandbox, { filename: 'appearance.js' });
  return win;
}

test('set 后 style 内容含正确变量与使用规则（同一套 --sp-font-scale/--sp-side-pad）', () => {
  const w = mkWorld();
  const win = run(w, { data: mkData() });
  const st = win.__SP_APPEARANCE;
  const out = st.set({ fontScale: 1.15, sidePad: 16 });
  assert.deepEqual(plain(out), { fontScale: 1.15, sidePad: 16 });
  const css = w.style().textContent;
  assert.ok(css.indexOf('--sp-font-scale:1.15') >= 0, '必须写入字体缩放变量：' + css);
  assert.ok(css.indexOf('--sp-side-pad:16px') >= 0, '必须写入边距变量：' + css);
  assert.ok(css.indexOf('var(--sp-font-scale,1)') >= 0, '根字号必须乘上同一变量');
  assert.ok(css.indexOf('--sa-l:var(--sp-side-pad,0px)') >= 0, '左边距必须用同一变量');
  assert.ok(css.indexOf('--sa-r:calc(env(safe-area-inset-right,0px) + var(--sp-side-pad,0px))') >= 0, '右边距必须叠加右安全区');
  assert.equal(w.style().getAttribute('id'), 'sp-appearance');
});

test('默认值不注入：全新安装时是严格 no-op（不生成 style 标签）', () => {
  const w = mkWorld();
  const win = run(w, { data: mkData() });
  assert.equal(w.style(), null, '默认值不许注入样式');
  assert.deepEqual(plain(win.__SP_APPEARANCE.get()), { fontScale: 1, sidePad: 0 });
});

test('持久化读取：写入 __SP_DATA 后，新"会话"启动即恢复', () => {
  const ls = mkLS();
  const data = mkData();
  const w1 = mkWorld();
  const win1 = run(w1, { data, ls });
  win1.__SP_APPEARANCE.set({ fontScale: 1.25, sidePad: 8 });
  // 第二个 window（模拟刷新/换 origin）复用同一份 __SP_DATA 与 localStorage
  const w2 = mkWorld();
  const win2 = run(w2, { data, ls });
  assert.deepEqual(plain(win2.__SP_APPEARANCE.get()), { fontScale: 1.25, sidePad: 8 });
  assert.ok(w2.style(), '恢复的非默认值必须立刻注入');
  assert.ok(w2.style().textContent.indexOf('--sp-font-scale:1.25') >= 0);
  assert.ok(w2.style().textContent.indexOf('--sp-side-pad:8px') >= 0);
});

test('__SP_DATA 缺失时退化到 localStorage 持久化', () => {
  const ls = mkLS();
  const w1 = mkWorld();
  const win1 = run(w1, { ls });
  win1.__SP_APPEARANCE.set({ fontScale: 1.05, sidePad: 0 });
  const w2 = mkWorld();
  const win2 = run(w2, { ls });
  assert.deepEqual(plain(win2.__SP_APPEARANCE.get()), { fontScale: 1.05, sidePad: 0 });
});

test('reset：撤掉注入、状态回默认、并把默认写回持久层', () => {
  const data = mkData();
  const w = mkWorld();
  const win = run(w, { data });
  win.__SP_APPEARANCE.set({ fontScale: 1.15, sidePad: 24 });
  assert.ok(w.style());
  const out = win.__SP_APPEARANCE.reset();
  assert.deepEqual(plain(out), { fontScale: 1, sidePad: 0 });
  assert.equal(w.style(), null, 'reset 必须移除 style 标签');
  assert.equal(data._doc.settings.fontScale, 1, 'reset 必须把默认写回 __SP_DATA');
  assert.equal(data._doc.settings.sidePad, 0);
});

test('持久化失败仍会话内生效（localStorage 与 __SP_DATA 都抛错）', () => {
  const w = mkWorld();
  const win = run(w, { data: mkData(null, { throwOnRecord: true }), ls: mkLS({ throwOnSet: true }) });
  assert.doesNotThrow(() => win.__SP_APPEARANCE.set({ fontScale: 1.2, sidePad: 12 }));
  assert.deepEqual(plain(win.__SP_APPEARANCE.get()), { fontScale: 1.2, sidePad: 12 });
  assert.ok(w.style(), '持久化失败也必须注入样式');
  assert.ok(w.style().textContent.indexOf('--sp-font-scale:1.2') >= 0);
});

test('幂等：连续 set 不叠 style 标签', () => {
  const w = mkWorld();
  const win = run(w, { data: mkData() });
  win.__SP_APPEARANCE.set({ fontScale: 1.05 });
  win.__SP_APPEARANCE.set({ fontScale: 1.15 });
  win.__SP_APPEARANCE.set({ sidePad: 8 });
  assert.equal(w.head._kids.filter((e) => e.getAttribute('id') === 'sp-appearance').length, 1);
  const css = w.style().textContent;
  assert.ok(css.indexOf('--sp-font-scale:1.15') >= 0, '最后一次设置必须生效');
  assert.ok(css.indexOf('--sp-side-pad:8px') >= 0);
});

test('合并写入不覆盖音频等其它设置（recordSettings 是整份快照）', () => {
  const data = mkData({ v: 1, settings: { bgm: 0.5, sfx: 0.7, muted: true, damageNumbers: false, quality: 'low', fontScale: 1, sidePad: 0, ts: 1 } });
  const w = mkWorld();
  const win = run(w, { data });
  win.__SP_APPEARANCE.set({ fontScale: 1.05 });
  assert.equal(data._doc.settings.bgm, 0.5, 'bgm 不许被默认值冲掉');
  assert.equal(data._doc.settings.sfx, 0.7);
  assert.equal(data._doc.settings.muted, true);
  assert.equal(data._doc.settings.damageNumbers, false);
  assert.equal(data._doc.settings.quality, 'low');
  assert.equal(data._doc.settings.fontScale, 1.05);
});

test('越界钳制：fontScale ∈ [0.85,1.5]、sidePad ∈ [0,40]', () => {
  const w = mkWorld();
  const win = run(w, { data: mkData() });
  assert.deepEqual(plain(win.__SP_APPEARANCE.set({ fontScale: 99, sidePad: 999 })), { fontScale: 1.5, sidePad: 40 });
  assert.deepEqual(plain(win.__SP_APPEARANCE.set({ fontScale: 0.1, sidePad: -5 })), { fontScale: 0.85, sidePad: 0 });
  // 非数字字段忽略
  assert.deepEqual(plain(win.__SP_APPEARANCE.set({ fontScale: 'x' })), { fontScale: 0.85, sidePad: 0 });
});

test('get() 返回副本，外部改动不影响内部状态', () => {
  const w = mkWorld();
  const win = run(w, { data: mkData() });
  win.__SP_APPEARANCE.set({ fontScale: 1.05 });
  const g = win.__SP_APPEARANCE.get();
  g.fontScale = 9;
  assert.equal(win.__SP_APPEARANCE.get().fontScale, 1.05);
});

test('v8.0: __SP_PREFS 存在时优先走统一命名空间（load 读它 / set 写它）', () => {
  const w = mkWorld();
  const prefs = {
    _v: { fontScale: 1.25, sidePad: 8 },
    get(k) { return k === 'appearance' ? this._v : null; },
    set(k, v) { if (k === 'appearance') this._v = v; return true; },
  };
  const win = run(w, { prefs });
  // load(): the namespace value is applied immediately (before the first paint of the game UI).
  assert.deepEqual(plain(win.__SP_APPEARANCE.get()), { fontScale: 1.25, sidePad: 8 });
  assert.ok(w.style(), '非默认值必须立刻注入样式');
  assert.ok(w.style().textContent.indexOf('--sp-font-scale:1.25') >= 0);
  // set(): writes through the namespace (not the legacy doc.settings path).
  win.__SP_APPEARANCE.set({ fontScale: 0.85 });
  assert.deepEqual(plain(prefs._v), { fontScale: 0.85, sidePad: 8 });
});

test('源码不变量：纯 ASCII、ES5、带幂等标记', () => {
  assert.ok(!/[^\x00-\x7F]/.test(SRC), '脚本必须纯 ASCII');
  assert.ok(!/=>/.test(SRC), '不许用箭头函数');
  assert.ok(!/\bconst\b/.test(SRC) && !/\blet\b/.test(SRC), '不许用 const/let');
  assert.ok(SRC.indexOf('`') < 0, '不许用模板字符串');
  assert.ok(SRC.indexOf('__SP_APPEARANCE') >= 0);
});
