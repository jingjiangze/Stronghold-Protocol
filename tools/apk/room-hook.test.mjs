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

function mkEl(text, parent, iconD) {
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
  // 上游 Button 渲染 <button><svg class="icon btn__icon"><path d=…/></svg><span>文案</span></button>：
  // iconD 模拟那个 inline SVG 的 path d（结构锚点），无 iconD 的按钮 querySelector 返回 null。
  if (iconD) {
    const pathEl = { getAttribute(n) { return n === 'd' ? iconD : null; } };
    el.querySelector = (sel) => (sel === 'svg path' || sel === 'path' ? pathEl : null);
  }
  return el;
}

/** 造一个房间页片段：邀请框（密钥按钮 + 链接按钮）+ 逐字拆开的房间码。
 *  按钮上和容器上各挂一个「页面自己的复制处理器」：钩子必须全部拦掉，否则就是复制和公开一起跑。
 *  buttons 项可以是字符串（文案）或 { text, icon }（icon = inline SVG 的 path d，结构锚点）。 */
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
  const mkButton = (spec) => wire(mkEl(
    typeof spec === 'string' ? spec : (spec && spec.text) || '',
    btns,
    typeof spec === 'string' ? undefined : spec && spec.icon,
  ));
  const els = buttons.map(mkButton);
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
    addButton: (t) => { const e = mkButton(t); els.push(e); return e; },
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

// ---------------------------------------------------------------------------------------------------
// v7.3 匹配加固（审计 §3.1 D7 / R-02）：上游把「复制密钥」按语言翻译，旧版只认中文 → 英文/韩/日/繁中
// 下接管当场失效。现在结构（copy 图标 path）优先，5 种语言的文案作回退。
// ---------------------------------------------------------------------------------------------------

/** 上游 ui/components.js ICONS.copy / ICONS.link 的 path d（结构锚点）。 */
const COPY_D = 'M8 3h11v13h-2V5H8zM5 7h10v14H5zm2 2v10h6V9z';
const LINK_D = 'M9 7H6.5a5 5 0 0 0 0 10H9v-2H6.5a3 3 0 0 1 0-6H9zm6 0h2.5a5 5 0 0 1 0 10H15v-2h2.5a3 3 0 0 0 0-6H15zM8 11h8v2H8z';
const okLobby = () => ({ isPublic: () => false, togglePublic: () => Promise.resolve({ ok: true, isPublic: true }) });

test('多语言文案回退：en / ko / ja / zh-TW 的「复制密钥」译法都要被接管', () => {
  for (const label of ['复制密钥', 'Copy Key', '\ucf54\ub4dc \ubcf5\uc0ac', '\u30b3\u30fc\u30c9\u3092\u30b3\u30d4\u30fc', '\u8907\u88fd\u91d1\u9470']) {
    const r = run({ buttons: [label, '复制链接'], lobby: okLobby() });
    assert.equal(r.els[0].textContent, '公开到大厅', `「${label}」必须被接管（旧版只认中文，这里就是 R-02）`);
    assert.equal(r.els[0].getAttribute('data-sp-lobby-pub'), 'MWHT');
    assert.equal(r.els[1].textContent, '复制链接', '链接按钮必须原样不动');
  }
});

test('结构命中：文案是上游尚未收录的语言，但带 copy 图标 → 仍被接管', () => {
  const r = run({ buttons: [{ text: 'Copiar clave', icon: COPY_D }], lobby: okLobby() });
  assert.equal(r.els[0].textContent, '公开到大厅', '结构锚点命中即接管，不依赖文案');
  assert.equal(r.els[0].getAttribute('data-sp-lobby-pub'), 'MWHT');
});

test('结构优先于文案：带 link 图标的文案命中按钮不接管，带 copy 图标的那一个接管', () => {
  const r = run({ buttons: [{ text: 'Copy Key', icon: LINK_D }, { text: 'Copiar clave', icon: COPY_D }], lobby: okLobby() });
  assert.equal(r.els[0].textContent, 'Copy Key', '文案命中但结构是 link：结构优先，不接管');
  assert.equal(r.els[0].hooks(), 0);
  assert.equal(r.els[1].textContent, '公开到大厅', '带 copy 图标的那一个才接管');
  assert.equal(r.els[1].getAttribute('data-sp-lobby-pub'), 'MWHT');
});

test('只有文案命中（无任何结构命中）时仍然接管', () => {
  const r = run({ buttons: [{ text: 'Copy Key', icon: LINK_D }], lobby: okLobby() });
  assert.equal(r.els[0].textContent, '公开到大厅', '结构认不出时必须回退到文案');
});

test('link 图标按钮永远不碰', () => {
  const r = run({ buttons: [{ text: '复制链接', icon: LINK_D }], lobby: okLobby() });
  assert.equal(r.els[0].textContent, '复制链接');
  assert.equal(r.els[0].getAttribute('data-sp-lobby-pub'), null);
  assert.equal(r.els[0].hooks(), 0);
});

test('既认不出结构也认不出文案 → 什么都不做（降级不变）', () => {
  const r = run({ buttons: ['Kopiera nyckel'], lobby: okLobby() });
  assert.equal(r.els[0].textContent, 'Kopiera nyckel', '不是目标就必须保持原样');
  assert.equal(r.els[0].hooks(), 0);
  assert.equal(r.els[0].getAttribute('data-sp-lobby-pub'), null);
});

test('结构接管后页面把文案写回未知语言：图标仍是 copy → 保持接管并重画', async () => {
  const r = run({ buttons: [{ text: 'Copiar clave', icon: COPY_D }], lobby: okLobby() });
  assert.equal(r.els[0].textContent, '公开到大厅');
  r.els[0].textContent = 'Copiar clave';   // 页面 re-render：同一个节点，文案被写回原文
  r.fire();
  await settleSweep();
  assert.equal(r.els[0].textContent, '公开到大厅', '图标仍是 copy → 仍是我们的按钮，重画回来');
  assert.equal(r.els[0].getAttribute('data-sp-lobby-pub'), 'MWHT');
});

test('static contract: 代码纯 ASCII（中文一律 \\uXXXX）、ES5、5 语言标签与 copy 图标锚点都在', () => {
  // 只对代码断言（注释保留中文说明）：strip 行注释与块注释后再查非 ASCII。
  const codeOnly = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  assert.ok(!/[^\x00-\x7F]/.test(codeOnly), '代码必须纯 ASCII —— 中文/全角标点一律用 \\uXXXX');
  assert.ok(!codeOnly.includes('=>'), 'ES5 only: no arrow functions');
  assert.ok(!codeOnly.includes('`'), 'ES5 only: no template strings');
  assert.ok(!/\b(let|const|class)\b/.test(codeOnly), 'ES5 only: no let/const/class');
  assert.ok(SRC.includes('\\u590d\\u5236\\u5bc6\\u94a5'), 'zh-CN 标签（转义形式）');
  assert.ok(SRC.includes("'Copy Key'"), 'en 标签');
  assert.ok(SRC.includes('\\ucf54\\ub4dc \\ubcf5\\uc0ac'), 'ko 标签');
  assert.ok(SRC.includes('\\u30b3\\u30fc\\u30c9\\u3092\\u30b3\\u30d4\\u30fc'), 'ja 标签');
  assert.ok(SRC.includes('\\u8907\\u88fd\\u91d1\\u9470'), 'zh-TW 标签');
  assert.ok(SRC.includes(COPY_D), 'copy 图标 path 结构锚点');
  assert.ok(SRC.includes('querySelector'), '结构匹配必须真的读 DOM 的 svg path');
});
