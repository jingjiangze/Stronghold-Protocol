// room-hook 的行为测试：vm + 最小 DOM 桩，真跑一遍钩子逻辑（不引入任何依赖）。
//
// 覆盖：只接管「复制密钥」那一个按钮 / 房间码从 DOM 读（且是 DOM 里那一个，不是默认值）/
//       点击走 __SP_LOBBY.togglePublic(code) 并**拦掉页面自己的复制行为** / 成功与失败的文案与回落 /
//       读不到码就不动 / preact 复用同一节点换房间时刷新标记与码 / 状态在别处变了会重画 /
//       节点被挪作他用就放开 / 观察器注册与合并扫描后的幂等 / 壳加载器只从 /__sp/ 取且先补大厅模块。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'room-hook.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-bridge.js'), 'utf8');

/** 一帧（宏任务）用的等待：等 Promise 链落地。 */
const flush = () => new Promise((res) => setTimeout(res, 0));
/** 等观察器合并窗口过去（room-hook.js 的 SWEEP_MS 是 60ms）。 */
const settleSweep = () => new Promise((res) => setTimeout(res, 150));

/** 真事件的样子：带传播控制（审阅意见#4 —— 只调自身监听器是测不出「有没有拦掉原行为」的）。 */
function mkEvent() {
  return {
    _stopped: false, _immediate: false, _prevented: false,
    stopPropagation() { this._stopped = true; },
    stopImmediatePropagation() { this._immediate = true; this._stopped = true; },
    preventDefault() { this._prevented = true; },
  };
}

function mkEl(text, parent) {
  const el = {
    textContent: text === undefined ? '' : text,
    _attrs: {}, _listeners: [], _copyCalls: 0,
    parentNode: parent || null,
    getAttribute(n) { return this._attrs[n] === undefined ? null : this._attrs[n]; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    removeAttribute(n) { delete this._attrs[n]; },
    addEventListener(type, fn, capture) { this._listeners.push({ type, fn, capture: !!capture }); },
    removeEventListener(type, fn, capture) {
      const i = this._listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture);
      if (i >= 0) this._listeners.splice(i, 1);
    },
    /** 捕获（祖先→目标）→ 目标 → 冒泡（目标→祖先），尊重 stopPropagation / stopImmediatePropagation。 */
    dispatch(type, ev) {
      const e = ev || mkEvent();
      const chain = [];
      for (let p = this.parentNode; p; p = p.parentNode) chain.push(p);
      const fire = (l) => { l.fn(e); return e._immediate; };
      for (let i = chain.length - 1; i >= 0 && !e._stopped; i--) {
        for (const l of chain[i]._listeners) if (l.type === type && l.capture && fire(l)) return e;
      }
      if (!e._stopped) for (const l of this._listeners) if (l.type === type && l.capture && fire(l)) return e;
      if (!e._stopped) for (const l of this._listeners) if (l.type === type && !l.capture && fire(l)) return e;
      if (!e._stopped) for (const p of chain) for (const l of p._listeners) if (l.type === type && !l.capture && fire(l)) return e;
      return e;
    },
    click(ev) { return this.dispatch('click', ev); },
    /** 钩子绑的捕获监听（页面自己的处理器是冒泡的，两者分开数）。 */
    hooks() { return this._listeners.filter((l) => l.type === 'click' && l.capture).length; },
  };
  return el;
}

/** 造一个房间页片段：邀请框（密钥按钮 + 链接按钮）+ 逐字拆开的房间码。
 *  按钮上和容器上各挂一个「页面自己的复制处理器」：钩子必须全部拦掉，否则就是复制和公开一起跑。 */
function mkDom(code, buttons = ['复制密钥', '复制链接']) {
  const codeEl = mkEl(code);
  const box = mkEl('');
  box.querySelector = (sel) => (sel === '.invite__code' ? codeEl : null);
  const btns = mkEl('', box);
  box.addEventListener('click', () => { box._copyCalls += 1; });          // 容器级（preact 根）处理器
  const wire = (e) => {
    e.closest = (sel) => (sel === '.invite' ? box : null);
    e.addEventListener('click', () => { e._copyCalls += 1; });            // 按钮自身的处理器
    return e;
  };
  const els = buttons.map((t) => wire(mkEl(t, btns)));
  const observers = [];
  let scans = 0;
  class MO { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} }
  const document = {
    readyState: 'complete',
    documentElement: {},
    head: { appendChild() {} },
    addEventListener() {},
    querySelectorAll: (sel) => { scans += 1; return sel === '.invite__btns button' ? els : []; },
    createElement: () => mkEl(''),
  };
  return {
    document, els, codeEl, observers, box,
    scans: () => scans,
    /** 页面后续 patch 出来的新按钮。 */
    addButton: (t) => { const e = wire(mkEl(t, btns)); els.push(e); return e; },
    fire: () => observers.forEach((o) => o.fn()),
  };
}

function run({ code = 'MWHT', buttons, lobby }) {
  const dom = mkDom(code, buttons);
  const win = { __SP_LOBBY: lobby || null };
  const sandbox = { window: win, document: dom.document, MutationObserver: class { constructor(fn) { dom.observers.push({ fn }); } observe() {} }, Promise, setTimeout, console };
  Object.assign(sandbox.window, { document: dom.document });
  vm.runInNewContext(SRC, sandbox, { filename: 'room-hook.js' });
  return { ...dom, win: sandbox.window };
}

test('只接管「复制密钥」：另一个按钮原样不动', () => {
  const r = run({ lobby: { isPublic: () => false, togglePublic: () => Promise.resolve({ ok: true, isPublic: true }) } });
  assert.equal(r.els[0].textContent, '公开到大厅', '密钥按钮应被换成公开到大厅');
  assert.equal(r.els[0].getAttribute('data-sp-lobby-pub'), 'MWHT', '接管标记里应记下房间码');
  assert.equal(r.els[1].textContent, '复制链接', '复制链接必须原样保留');
  assert.equal(r.els[1].hooks(), 0, '别的按钮一个监听都不许挂');
});

test('房间码从 DOM 读（拆字/空格都能认）', async () => {
  const calls = [];
  const r = run({ code: ' K X Q P ', lobby: { isPublic: () => false, togglePublic: (c) => { calls.push(c); return Promise.resolve({ ok: true, isPublic: true }); } } });
  assert.equal(r.els[0].getAttribute('data-sp-lobby-pub'), 'KXQP', '标记里必须是 DOM 里那一个码（写死默认值的实现过不了）');
  r.els[0].click();
  await flush();
  assert.deepEqual(calls, ['KXQP'], '点击必须把 DOM 里读到的那个码交给大厅');
});

test('读不到合法房间码就什么都不做', () => {
  const r = run({ code: '', lobby: { togglePublic: () => Promise.resolve({ ok: true }) } });
  assert.equal(r.els[0].textContent, '复制密钥', '没有码时必须保持原样');
  assert.equal(r.els[0].getAttribute('data-sp-lobby-pub'), null);
  assert.equal(r.els[0].hooks(), 0, '没有码就不许挂监听');
});

test('点击走 togglePublic(code)，成功后文案变「已公开 · 转私密」', async () => {
  const calls = [];
  const r = run({ lobby: { isPublic: () => false, togglePublic: (c) => { calls.push(c); return Promise.resolve({ ok: true, isPublic: true }); } } });
  r.els[0].click();
  assert.equal(r.els[0].textContent, '公开中…', '点击后应立刻显示进行中');
  await flush();
  assert.deepEqual(calls, ['MWHT']);
  assert.equal(r.els[0].textContent, '已公开 · 转私密');
  // 审阅意见#4：原来的「复制密钥」必须被拦掉 —— 按钮自己的处理器和容器上的都不能跑。
  assert.equal(r.els[0]._copyCalls, 0, '按钮自己的复制处理器必须被拦掉');
  assert.equal(r.box._copyCalls, 0, '容器（preact 根）上的复制处理器也必须被拦掉');
  // 对照组：没被接管的按钮点下去，页面的原行为照常发生（证明上面的断言不是空跑）。
  r.els[1].click();
  assert.equal(r.els[1]._copyCalls, 1, '未被接管的按钮必须保留原行为');
});

test('失败时显示原因，随后回落到正确文案', async () => {
  const r = run({ lobby: { isPublic: () => false, togglePublic: () => Promise.resolve({ ok: false, text: '大厅模块未加载，暂不能公开' }) } });
  r.els[0].click();
  await flush();
  assert.equal(r.els[0].textContent, '大厅模块未加载，暂不能公开');
  await new Promise((res) => setTimeout(res, 3100));
  assert.equal(r.els[0].textContent, '公开到大厅', '3 秒后应回到可点状态');
});

test('已是公开态时初始文案就是「已公开 · 转私密」', () => {
  const r = run({ lobby: { isPublic: () => true, togglePublic: () => Promise.resolve({ ok: true }) } });
  assert.equal(r.els[0].textContent, '已公开 · 转私密');
});

test('观察器：后续变化扫到新按钮；重复扫描不重复接管', async () => {
  const r = run({ lobby: { isPublic: () => false, togglePublic: () => Promise.resolve({ ok: true }) } });
  assert.equal(r.observers.length, 1, '必须注册 MutationObserver（否则下面的 fire 是空跑）');
  const late = r.addButton('复制密钥');   // 房间页 patch 出来的按钮，首次扫描时还不存在
  assert.equal(late.getAttribute('data-sp-lobby-pub'), null);
  r.fire();
  await settleSweep();
  assert.equal(late.textContent, '公开到大厅', '观察器触发后新按钮必须被接管');
  assert.equal(late.getAttribute('data-sp-lobby-pub'), 'MWHT');
  const before = r.els[0].textContent;
  r.fire(); r.fire(); r.fire();           // 模拟 MutationObserver 反复触发
  await settleSweep();
  assert.equal(r.els[0].textContent, before, '反复扫描不许把文案清掉');
  assert.equal(r.els[0].hooks(), 1, '只能绑一个捕获监听');
  assert.equal(late.hooks(), 1, '新按钮也只能绑一个捕获监听');
  assert.equal(r.els[0]._listeners.filter((l) => l.type === 'click' && !l.capture).length, 1, '页面自己的处理器不许被动过');
});

test('preact 复用同一按钮渲染下一个房间：刷新标记与文案，点击用新码', async () => {
  const calls = [];
  const r = run({ lobby: { isPublic: () => false, togglePublic: (c) => { calls.push(c); return Promise.resolve({ ok: true, isPublic: false }); } } });
  assert.equal(r.els[0].getAttribute('data-sp-lobby-pub'), 'MWHT');
  r.els[0].textContent = '复制密钥';       // 页面 re-render：同一个节点，文案被写回
  r.codeEl.textContent = ' Q K T R ';      // 邀请框换成下一个房间的码
  r.fire();
  await settleSweep();
  assert.equal(r.els[0].textContent, '公开到大厅', '文案必须按当前 DOM 重画回来');
  assert.equal(r.els[0].getAttribute('data-sp-lobby-pub'), 'QKTR', '标记必须跟着当前房间码走');
  r.els[0].click();
  await flush();
  assert.deepEqual(calls, ['QKTR'], '点击必须发布当前房间，而不是上一个');
  // 观察器还没来得及跑（还压在合并窗口里）：点击同样要现读 DOM，绝不能发布上一个房间。
  r.codeEl.textContent = 'W N B K';
  r.els[0].click();
  await flush();
  assert.deepEqual(calls, ['QKTR', 'WNBK'], '点击必须现读 DOM，不靠上一次扫描留下的标记');
});

test('公开状态在别处变了：扫描按当前状态重画', async () => {
  let pub = false;
  const r = run({ lobby: { isPublic: () => pub, togglePublic: () => Promise.resolve({ ok: true }) } });
  assert.equal(r.els[0].textContent, '公开到大厅');
  pub = true;                              // 例如在大厅面板里公开了这个房间
  r.fire();
  await settleSweep();
  assert.equal(r.els[0].textContent, '已公开 · 转私密');
  pub = false;
  r.win.__SP_ROOM_HOOK_SWEEP();            // 调试入口：强制重扫
  assert.equal(r.els[0].textContent, '公开到大厅');
});

test('节点被页面挪作他用（改成「复制链接」）→ 立刻放开，不再拦点击', async () => {
  const calls = [];
  const r = run({ lobby: { isPublic: () => false, togglePublic: (c) => { calls.push(c); return Promise.resolve({ ok: true }); } } });
  assert.equal(r.els[0].textContent, '公开到大厅');
  r.els[0].textContent = '复制链接';        // 页面把这个节点复用成了别的按钮
  r.fire();
  await settleSweep();
  assert.equal(r.els[0].getAttribute('data-sp-lobby-pub'), null, '标记必须摘掉');
  assert.equal(r.els[0].textContent, '复制链接', '不许再改页面的文案');
  assert.equal(r.els[0].hooks(), 0, '监听必须摘掉');
  r.els[0].click();
  assert.deepEqual(calls, [], '绝不能替别的按钮发布房间');
  assert.equal(r.els[0]._copyCalls, 1, '点击要回到页面自己的行为');
});

test('观察器回调合并：一阵 DOM 风暴只换来一次扫描', async () => {
  const r = run({ lobby: { isPublic: () => false, togglePublic: () => Promise.resolve({ ok: true }) } });
  const before = r.scans();
  for (let i = 0; i < 20; i++) r.fire();
  await settleSweep();
  assert.equal(r.scans() - before, 1, '20 次变更只能触发 1 次扫描');
  const late = r.addButton('复制密钥');
  r.fire();
  await settleSweep();
  assert.equal(late.textContent, '公开到大厅', '合并之后仍要能接管新按钮');
});

test('没有 __SP_LOBBY 时点击给出提示而不是抛错', async () => {
  const r = run({ lobby: null });
  assert.doesNotThrow(() => r.els[0].click());
  assert.equal(r.els[0].textContent, '大厅模块未加载');
});

test('壳加载器：缺大厅模块时先补 /__sp/lobby.js，再挂 /__sp/room-hook.js', () => {
  const at = BRIDGE.indexOf('v6.0: 房间页 DOM 钩子');
  assert.ok(at > 0, 'shell-bridge.js 里必须有这个加载器段落');
  const block = BRIDGE.slice(at);
  const iLobby = block.indexOf("'/__sp/lobby.js'");
  const iHook = block.indexOf("'/__sp/room-hook.js'");
  assert.ok(iLobby > 0, '上传方页面没有大厅模块时必须从外壳自有前缀补 lobby.js');
  assert.ok(iHook > iLobby, '大厅模块必须先于钩子注入');
  assert.ok(block.includes("typeof window.__SP_LOBBY.togglePublic !== 'function'"), '已经有大厅模块就不许重复加载');
  assert.ok(!/src = ['"][^'"]*\/js\/(lobby|room-hook)\.js['"]/.test(block), '绝不能从页面的 /js/ 取（上传方版本不可信）');
});
