// publish-float 的行为测试：vm + 最小 DOM 桩，真跑一遍悬浮按钮逻辑（不引入任何依赖）。
//
// 覆盖：在房显示 / 不在房不显示（__SP__ 精确优先，DOM 仅作退化）/ 拖动阈值（小位移=点按、大位移=拖）/
//       点按走 __SP_LOBBY.togglePublic(code) / 失败短暂提示后回退 / 轮询节流且隐藏时不跑 /
//       localStorage 位置恢复与拖动后落盘 / __SP__ 缺失时退化到 DOM / 异常静默 /
//       只创建自己的节点（不碰上游 DOM）/ 源码纯 ASCII。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'publish-float.js'), 'utf8');

const flush = () => new Promise((res) => setTimeout(res, 0));

function mkEl(tag, parent) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    textContent: '', className: '', style: {},
    parentNode: parent || null,
    _attrs: {}, _listeners: [], _kids: [],
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    removeAttribute(n) { delete this._attrs[n]; },
    hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n); },
    appendChild(c) {
      if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c);
      c.parentNode = this; this._kids.push(c); return c;
    },
    removeChild(c) { const i = this._kids.indexOf(c); if (i >= 0) this._kids.splice(i, 1); c.parentNode = null; return c; },
    addEventListener(t, fn, cap) { this._listeners.push({ type: t, fn, capture: !!cap }); },
    removeEventListener(t, fn, cap) {
      const i = this._listeners.findIndex((l) => l.type === t && l.fn === fn && l.capture === !!cap);
      if (i >= 0) this._listeners.splice(i, 1);
    },
    dispatch(t, ev) { const e = ev || {}; for (const l of this._listeners) if (l.type === t) l.fn(e); return e; },
    setPointerCapture() {},
    releasePointerCapture() {},
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

/** 一帧"页面"：html/head/body + 可控时钟 + 手动定时器。 */
function mkWorld(opts = {}) {
  const created = [];
  const timers = [];
  const intervals = [];
  let tid = 0;
  const clock = { t: 1e12 };
  const htmlEl = mkEl('html');
  const head = mkEl('head');
  const body = mkEl('body');
  htmlEl.appendChild(head);
  htmlEl.appendChild(body);
  const domCode = opts.domCode === undefined ? null : (() => {
    const e = mkEl('div'); e.textContent = opts.domCode; return e;
  })();
  const document = {
    readyState: 'complete', documentElement: htmlEl, head, body, hidden: false,
    _listeners: [],
    addEventListener(t, fn) { this._listeners.push({ type: t, fn }); },
    removeEventListener(t, fn) { const i = this._listeners.findIndex((l) => l.type === t && l.fn === fn); if (i >= 0) this._listeners.splice(i, 1); },
    createElement(tag) { const e = mkEl(tag); created.push(e); return e; },
    getElementById(id) { return findById(id, htmlEl); },
    querySelector(sel) { return sel === '.invite__code' ? domCode : null; },
  };
  return {
    document, htmlEl, head, body, created, timers, intervals, clock,
    setTimeout: (fn, ms) => { const t = { id: ++tid, fn, ms: ms || 0, done: false, cleared: false }; timers.push(t); return t.id; },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; },
    setInterval: (fn, ms) => { const t = { id: ++tid, fn, ms }; intervals.push(t); return t.id; },
    clearInterval: (id) => { const t = intervals.find((x) => x.id === id); if (t) t.cleared = true; },
    flushTimers: (rounds = 3) => {
      for (let r = 0; r < rounds; r++) for (const t of timers) if (!t.done && !t.cleared) { t.done = true; t.fn(); }
    },
    btn: () => findById('sp-pubfloat', htmlEl),
    style: () => findById('sp-pubfloat-style', htmlEl),
  };
}

function run(world, opts = {}) {
  const win = {
    innerWidth: opts.innerWidth === undefined ? 800 : opts.innerWidth,
    innerHeight: opts.innerHeight === undefined ? 600 : opts.innerHeight,
    localStorage: opts.ls || mkLS(),
    PointerEvent: function PointerEvent() {},
    _listeners: [],
    addEventListener(t, fn) { this._listeners.push({ type: t, fn }); },
    removeEventListener(t, fn) { const i = this._listeners.findIndex((l) => l.type === t && l.fn === fn); if (i >= 0) this._listeners.splice(i, 1); },
    dispatch(t, ev) { for (const l of this._listeners) if (l.type === t) l.fn(ev || {}); },
  };
  if (opts.hasPointerEvent === false) delete win.PointerEvent;
  if (opts.sp !== undefined) win.__SP__ = opts.sp;
  if (opts.lobby !== undefined) win.__SP_LOBBY = opts.lobby;
  const sandbox = {
    window: win, document: world.document,
    setTimeout: world.setTimeout, clearTimeout: world.clearTimeout,
    setInterval: world.setInterval, clearInterval: world.clearInterval,
    Date: { now: () => world.clock.t },
    Promise, console,
  };
  vm.runInNewContext(SRC, sandbox, { filename: 'publish-float.js' });
  return win;
}

function spRoom(code) { return { store: { get: () => ({ room: code ? { code } : null }) } }; }

test('在房显示：__SP__.store 的房号为准，文案「公开到大厅」', () => {
  const w = mkWorld();
  const win = run(w, { sp: spRoom('MWHT'), lobby: { isPublic: () => false, togglePublic: () => Promise.resolve({ ok: true }) } });
  assert.equal(win.__SP_PUBFLOAT.visible(), true);
  assert.equal(w.btn().style.display, 'block');
  assert.equal(w.btn().textContent, '公开到大厅');
  assert.equal(win.__SP_PUBFLOAT.code(), 'MWHT');
  assert.ok(w.style(), '必须注入样式标签');
  assert.ok(w.style().textContent.indexOf('z-index:70') >= 0, 'z-index 必须高于画布/连接条、低于 --z-modal(80)');
  assert.ok(w.style().textContent.indexOf('#4ed8af') >= 0, '青绿主色');
});

test('不在房不显示；__SP__ 在而 room 为空时即使 DOM 有邀请框也不显示（精确源优先）', () => {
  const w = mkWorld({ domCode: 'MWHT' });
  const win = run(w, { sp: spRoom(''), lobby: { isPublic: () => false, togglePublic: () => Promise.resolve({ ok: true }) } });
  assert.equal(win.__SP_PUBFLOAT.visible(), false);
  assert.equal(w.btn().style.display, 'none');
});

test('已是公开态时初始文案是「已公开 · 取消」', () => {
  const w = mkWorld();
  const win = run(w, { sp: spRoom('MWHT'), lobby: { isPublic: (c) => c === 'MWHT', togglePublic: () => Promise.resolve({ ok: true }) } });
  assert.equal(w.btn().textContent, '已公开 · 取消');
  assert.equal(w.btn().getAttribute('data-sp-pub'), '1');
  assert.equal(win.__SP_PUBFLOAT.visible(), true);
});

test('点按走 __SP_LOBBY.togglePublic(code)：进行中→已公开', async () => {
  const calls = [];
  let pub = false;
  const w = mkWorld();
  const win = run(w, { sp: spRoom('MWHT'), lobby: { isPublic: () => pub, togglePublic: (c) => { calls.push(c); pub = true; return Promise.resolve({ ok: true, isPublic: true }); } } });
  win.__SP_PUBFLOAT.toggle();
  assert.equal(w.btn().textContent, '公开中…');
  await flush();
  assert.deepEqual(calls, ['MWHT']);
  assert.equal(w.btn().textContent, '已公开 · 取消', '成功后必须按 __SP_LOBBY.isPublic 重画');
  assert.equal(w.btn().getAttribute('data-sp-pub'), '1');
});

test('失败：短暂提示后回退到正确文案', async () => {
  const w = mkWorld();
  const win = run(w, { sp: spRoom('MWHT'), lobby: { isPublic: () => false, togglePublic: () => Promise.resolve({ ok: false, text: '对战中无法公开' }) } });
  win.__SP_PUBFLOAT.toggle();
  await flush();
  assert.equal(w.btn().textContent, '对战中无法公开');
  w.flushTimers();
  assert.equal(w.btn().textContent, '公开到大厅', '提示到时应回退');
});

test('__SP_LOBBY 缺失时提示「大厅模块未加载」，不抛错', async () => {
  const w = mkWorld();
  const win = run(w, { sp: spRoom('MWHT'), lobby: null });
  assert.doesNotThrow(() => win.__SP_PUBFLOAT.toggle());
  assert.equal(w.btn().textContent, '大厅模块未加载');
  w.flushTimers();
  assert.equal(w.btn().textContent, '公开到大厅');
});

test('拖动阈值：小位移算点按（不移动、触发切换）', async () => {
  const calls = [];
  const w = mkWorld();
  const win = run(w, { sp: spRoom('MWHT'), lobby: { isPublic: () => false, togglePublic: (c) => { calls.push(c); return Promise.resolve({ ok: true }); } } });
  const left0 = w.btn().style.left;
  w.btn().dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 1, preventDefault() {} });
  win.dispatch('pointermove', { clientX: 102, clientY: 101, preventDefault() {} }); // manhattan 3 < 6
  assert.equal(w.btn().style.left, left0, '阈值内不许移动');
  win.dispatch('pointerup', {});
  await flush();
  assert.deepEqual(calls, ['MWHT'], '小位移必须是点按');
  assert.equal(w.btn().style.left, left0, '点按后位置不变');
});

test('拖动阈值：大位移算拖（移动并落盘，不触发切换）', () => {
  const calls = [];
  const ls = mkLS();
  ls.setItem('sp.pubfloat.pos', JSON.stringify({ x: 100, y: 100 }));
  const w = mkWorld();
  const win = run(w, { sp: spRoom('MWHT'), ls, lobby: { isPublic: () => false, togglePublic: (c) => { calls.push(c); return Promise.resolve({ ok: true }); } } });
  const left0 = parseInt(w.btn().style.left, 10);
  assert.equal(left0, 100, '基线：位置从 localStorage 恢复');
  w.btn().dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 1, preventDefault() {} });
  win.dispatch('pointermove', { clientX: 140, clientY: 100, preventDefault() {} }); // manhattan 40 >= 6
  assert.equal(parseInt(w.btn().style.left, 10), left0 + 40, '拖后位置必须跟随');
  win.dispatch('pointerup', {});
  assert.deepEqual(calls, [], '拖动不许触发切换');
  const saved = JSON.parse(ls.getItem('sp.pubfloat.pos'));
  assert.equal(saved.x, left0 + 40, '拖动后位置必须落盘');
});

test('localStorage 位置恢复：启动时读回上次位置', () => {
  const ls = mkLS();
  ls.setItem('sp.pubfloat.pos', JSON.stringify({ x: 50, y: 60 }));
  const w = mkWorld();
  run(w, { sp: spRoom('MWHT'), ls, lobby: { isPublic: () => false, togglePublic: () => Promise.resolve({ ok: true }) } });
  assert.equal(w.btn().style.left, '50px');
  assert.equal(w.btn().style.top, '60px');
});

test('轮询节流：30s 间隔、30s 内重复触发不重复查、隐藏时不跑', () => {
  let calls = 0;
  const w = mkWorld();
  const win = run(w, { sp: spRoom('MWHT'), lobby: { isPublic: () => { calls += 1; return false; }, togglePublic: () => Promise.resolve({ ok: true }) } });
  assert.equal(w.intervals.length, 1, '必须起一个轮询定时器');
  assert.equal(w.intervals[0].ms, 30000, '轮询节流必须 ≤ 30s');
  calls = 0;
  win.__SP_PUBFLOAT.poll();                    // t = 1e12
  assert.equal(calls, 1, '第一次轮询应生效');
  w.clock.t += 1000;
  win.__SP_PUBFLOAT.poll();
  assert.equal(calls, 1, '30s 内重复触发必须被节流');
  w.clock.t += 30000;
  win.__SP_PUBFLOAT.poll();
  assert.equal(calls, 2, '超过 30s 后应再次生效');
  w.document.hidden = true;
  w.clock.t += 60000;
  win.__SP_PUBFLOAT.poll();
  assert.equal(calls, 2, '页面隐藏时不许轮询');
});

test('__SP__ 缺失时退化到 DOM（.invite__code），点按用 DOM 码', async () => {
  const calls = [];
  const w = mkWorld({ domCode: ' K X Q P ' });
  const win = run(w, { lobby: { isPublic: () => false, togglePublic: (c) => { calls.push(c); return Promise.resolve({ ok: true }); } } });
  assert.equal(win.__SP_PUBFLOAT.visible(), true);
  assert.equal(win.__SP_PUBFLOAT.code(), 'KXQP');
  win.__SP_PUBFLOAT.toggle();
  await flush();
  assert.deepEqual(calls, ['KXQP']);
});

test('异常静默：store.get 抛错 → 不显示、不抛错', () => {
  const w = mkWorld();
  const win = run(w, { sp: { store: { get() { throw new Error('boom'); } } }, lobby: { isPublic: () => false, togglePublic: () => Promise.resolve({ ok: true }) } });
  assert.equal(win.__SP_PUBFLOAT.visible(), false);
  assert.equal(w.btn().style.display, 'none');
});

test('异常静默：localStorage 写入抛错时切换仍生效（会话内）', async () => {
  let pub = false;
  const w = mkWorld();
  const win = run(w, { sp: spRoom('MWHT'), ls: mkLS({ throwOnSet: true }), lobby: { isPublic: () => pub, togglePublic: () => { pub = true; return Promise.resolve({ ok: true, isPublic: true }); } } });
  win.__SP_PUBFLOAT.toggle();
  await flush();
  assert.equal(w.btn().textContent, '已公开 · 取消', '持久化失败不能影响本次切换');
});

test('没有 PointerEvent 时退化为 click 点按', async () => {
  const calls = [];
  const w = mkWorld();
  const win = run(w, { sp: spRoom('MWHT'), hasPointerEvent: false, lobby: { isPublic: () => false, togglePublic: (c) => { calls.push(c); return Promise.resolve({ ok: true }); } } });
  w.btn().dispatch('click', {});
  await flush();
  assert.deepEqual(calls, ['MWHT']);
});

test('只创建自己的节点：head 一个 style、body 一个 button，不碰上游 DOM', () => {
  const w = mkWorld({ domCode: 'MWHT' });
  run(w, { sp: spRoom('MWHT'), lobby: { isPublic: () => false, togglePublic: () => Promise.resolve({ ok: true }) } });
  assert.equal(w.head._kids.length, 1, 'head 只许加一个 style');
  assert.equal(w.body._kids.length, 1, 'body 只许加一个按钮');
  assert.equal(w.btn().parentNode, w.body);
  assert.equal(w.style().getAttribute('id'), 'sp-pubfloat-style');
});

test('幂等：同一 window 重复注入只有一个按钮、一个样式、一个定时器', () => {
  const w = mkWorld();
  const win = run(w, { sp: spRoom('MWHT'), lobby: { isPublic: () => false, togglePublic: () => Promise.resolve({ ok: true }) } });
  const sandbox = {
    window: win, document: w.document,
    setTimeout: w.setTimeout, clearTimeout: w.clearTimeout,
    setInterval: w.setInterval, clearInterval: w.clearInterval,
    Date: { now: () => w.clock.t }, Promise, console,
  };
  vm.runInNewContext(SRC, sandbox, { filename: 'publish-float.js' });
  assert.equal(w.head._kids.filter((e) => e.getAttribute('id') === 'sp-pubfloat-style').length, 1);
  assert.equal(w.body._kids.length, 1);
  assert.equal(w.intervals.length, 1, '重复注入不许再起定时器');
});

test('源码不变量：纯 ASCII、ES5（无箭头函数/const/let/模板串）', () => {
  assert.ok(!/[^\x00-\x7F]/.test(SRC), '脚本必须纯 ASCII');
  assert.ok(!/=>/.test(SRC), '不许用箭头函数');
  assert.ok(!/\bconst\b/.test(SRC) && !/\blet\b/.test(SRC), '不许用 const/let');
  assert.ok(SRC.indexOf('`') < 0, '不许用模板字符串');
  assert.ok(SRC.indexOf('__SP_PUBFLOAT') >= 0, '必须有幂等标记');
});
