// room-hook 的行为测试：vm + 最小 DOM 桩，真跑一遍钩子逻辑（不引入任何依赖）。
//
// 覆盖：只接管「复制密钥」那一个按钮 / 房间码从 DOM 读 / 点击走 __SP_LOBBY.togglePublic /
//       成功与失败的文案与回落 / 读不到码就不动 / 幂等。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'room-hook.js'), 'utf8');

function mkEl(text) {
  return {
    textContent: text, _attrs: {}, _clicks: [], _listeners: [],
    getAttribute(n) { return this._attrs[n] === undefined ? null : this._attrs[n]; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    addEventListener(type, fn, capture) { this._listeners.push({ type, fn, capture }); },
    click(ev) { for (const l of this._listeners) if (l.type === 'click') l.fn(ev || { stopImmediatePropagation() {}, preventDefault() {} }); },
  };
}

/** 造一个房间页片段：邀请框（密钥按钮 + 链接按钮）+ 逐字拆开的房间码。 */
function mkDom(code, buttons = ['复制密钥', '复制链接']) {
  const codeEl = { textContent: code };
  const box = { querySelector: (sel) => (sel === '.invite__code' ? codeEl : null) };
  const els = buttons.map((t) => { const e = mkEl(t); e.closest = (sel) => (sel === '.invite' ? box : null); return e; });
  const observers = [];
  class MO { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} }
  const document = {
    readyState: 'complete',
    documentElement: {},
    head: { appendChild() {} },
    addEventListener() {},
    querySelectorAll: (sel) => (sel === '.invite__btns button' ? els : []),
    createElement: () => mkEl(''),
  };
  return { document, els, observers, fire: () => observers.forEach((o) => o.fn()) };
}

function run({ code = 'MWHT', buttons, lobby }) {
  const dom = mkDom(code, buttons);
  const win = { __SP_LOBBY: lobby || null };
  const sandbox = { window: win, document: dom.document, MutationObserver: class { constructor(fn) { dom.observers.push({ fn }); } observe() {} }, Promise, setTimeout, console };
  sandbox.window = sandbox.window || {};
  Object.assign(sandbox.window, { document: dom.document });
  vm.runInNewContext(SRC, sandbox, { filename: 'room-hook.js' });
  return { ...dom, win: sandbox.window };
}

test('只接管「复制密钥」：另一个按钮原样不动', () => {
  const r = run({ lobby: { isPublic: () => false, togglePublic: () => Promise.resolve({ ok: true, isPublic: true }) } });
  assert.equal(r.els[0].textContent, '公开到大厅', '密钥按钮应被换成公开到大厅');
  assert.equal(r.els[1].textContent, '复制链接', '复制链接必须原样保留');
  assert.equal(r.els[0].getAttribute('data-sp-lobby-pub'), 'MWHT', '接管标记里应记下房间码');
});

test('房间码从 DOM 读（拆字/空格都能认）', () => {
  const r = run({ code: ' M W H T ', lobby: { isPublic: () => false, togglePublic: () => Promise.resolve({ ok: true }) } });
  assert.equal(r.els[0].getAttribute('data-sp-lobby-pub'), 'MWHT');
});

test('读不到合法房间码就什么都不做', () => {
  const r = run({ code: '', lobby: { togglePublic: () => Promise.resolve({ ok: true }) } });
  assert.equal(r.els[0].textContent, '复制密钥', '没有码时必须保持原样');
  assert.equal(r.els[0].getAttribute('data-sp-lobby-pub'), null);
});

test('点击走 togglePublic(code)，成功后文案变「已公开 · 转私密」', async () => {
  const calls = [];
  const r = run({ lobby: { isPublic: () => false, togglePublic: (c) => { calls.push(c); return Promise.resolve({ ok: true, isPublic: true }); } } });
  r.els[0].click();
  assert.equal(r.els[0].textContent, '公开中…', '点击后应立刻显示进行中');
  await new Promise((res) => setTimeout(res, 0));
  assert.deepEqual(calls, ['MWHT']);
  assert.equal(r.els[0].textContent, '已公开 · 转私密');
});

test('失败时显示原因，随后回落到正确文案', async () => {
  const r = run({ lobby: { isPublic: () => false, togglePublic: () => Promise.resolve({ ok: false, text: '大厅模块未加载，暂不能公开' }) } });
  r.els[0].click();
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(r.els[0].textContent, '大厅模块未加载，暂不能公开');
  await new Promise((res) => setTimeout(res, 3100));
  assert.equal(r.els[0].textContent, '公开到大厅', '3 秒后应回到可点状态');
});

test('已是公开态时初始文案就是「已公开 · 转私密」', () => {
  const r = run({ lobby: { isPublic: () => true, togglePublic: () => Promise.resolve({ ok: true }) } });
  assert.equal(r.els[0].textContent, '已公开 · 转私密');
});

test('幂等：重复扫描不会重复接管（标记仍在，文案不被清掉）', () => {
  const r = run({ lobby: { isPublic: () => false, togglePublic: () => Promise.resolve({ ok: true }) } });
  const before = r.els[0].textContent;
  r.fire(); r.fire();   // 模拟 MutationObserver 反复触发
  assert.equal(r.els[0].textContent, before);
  assert.equal(r.els[0]._listeners.filter((l) => l.type === 'click').length, 1, '只能绑一个 click');
});

test('没有 __SP_LOBBY 时点击给出提示而不是抛错', async () => {
  const r = run({ lobby: null });
  assert.doesNotThrow(() => r.els[0].click());
  assert.equal(r.els[0].textContent, '大厅模块未加载');
});
