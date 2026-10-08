// home-layer v10.0 的行为测试：vm + 最小 DOM 桩，真跑一遍控件层逻辑（不引入任何依赖）。
//
// v10.0（业主 2026-10-08 第二轮口径）：右上角归**上游** —— 不再自绘连接胶囊、不再遮蔽上游
// .title-conn（上游 0.2.1 自己在登录面板里画状态行：点/文案/ping/玩法说明/齿轮/全屏）；侧栏去掉
// 「大厅」= 设置/参数/配置/战绩 4 项（大厅入口在 vendored 副本的登录面板 duo 里，本层**不**画 duo，
// 上游自己的「开始」按钮原样不动）；页脚不再画我们自己的版本号（保留上游 v${APP_VERSION} ·
// WEB SIMULATION 行），「检查更新」按钮留在我们的 .title-foot / .title-foot__meta 里。
// 访客数（v5.2）改为**一个 span 追加进上游 .title-conn 行尾**（唯一的上游 DOM 写；隐藏时移除）。
//
// 覆盖：默认显示与非遮挡 / 首页态识别与 suppress / 离开首页态自动收起 / 观察器合并 /
//       侧栏恰好 设置·参数·配置·战绩（顺序）/ 设置走 openPanel('appearance') /
//       参数·配置·战绩走 openPanel(kind) / 检查更新走 checkUpdate / 没有 local/online/fullscreen/servers 按钮 /
//       vendored 标记让位（连上游 DOM 都不碰）/ 桥缺失降级 / __SP_HOME 三件套与 sweep 钩子 /
//       访客数 span（追加到上游行、离线隐藏、隐藏/让位时移除）/ 上游 DOM 零改写（不再遮蔽）/
//       按钮文案与类名 / 检查更新薄荷描边类 / .app-root 兜底 / 锚点缺失降级 /
//       壳加载器只从 /__sp/ 取 / 源码不变量（ES5、纯 ASCII、无网络）/ CSS 逐字搬 / 轮询兜底。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'home-layer.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-bridge.js'), 'utf8');
const THEME = fs.readFileSync(path.join(here, '..', '..', 'public', 'css', 'theme.css'), 'utf8');

const TITLE_MARKS = ['.title-screen', '.title-main', '.title-login'];
const UPSTREAM_SETTINGS = '.title-settings';
const UPSTREAM_FS = '.title-fs';
const UPSTREAM_START = '.title-login .btn--primary';
const UPSTREAM_CONN = '.title-conn';

/** 真事件的样子：带传播控制。 */
function mkEvent() {
  return {
    _stopped: false, _immediate: false, _prevented: false,
    stopPropagation() { this._stopped = true; },
    stopImmediatePropagation() { this._immediate = true; this._stopped = true; },
    preventDefault() { this._prevented = true; },
  };
}

function mkEl(tag, parent) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    textContent: '',
    className: '',
    style: { display: '' },
    disabled: false,
    _attrs: {}, _listeners: [], _kids: [],
    parentNode: parent || null,
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n); },
    removeAttribute(n) { delete this._attrs[n]; },
    appendChild(c) {
      if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c);
      c.parentNode = this;
      this._kids.push(c);
      return c;
    },
    removeChild(c) {
      const i = this._kids.indexOf(c);
      if (i >= 0) this._kids.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    addEventListener(type, fn, capture) { this._listeners.push({ type, fn, capture: !!capture }); },
    removeEventListener(type, fn, capture) {
      const i = this._listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture);
      if (i >= 0) this._listeners.splice(i, 1);
    },
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
  };
  return el;
}

/** 在活动子树里深度优先找节点（created[] 也含未挂载节点，探针只走活动树）。 */
function findIn(el, pred) {
  if (!el) return null;
  if (pred(el)) return el;
  for (const kid of el._kids || []) {
    const hit = findIn(kid, pred);
    if (hit) return hit;
  }
  return null;
}

function hasClass(el, cls) {
  if (!el) return false;
  return (' ' + String(el.className) + ' ').indexOf(' ' + cls + ' ') >= 0;
}

/**
 * 一次"页面"：html/head/body/.app-root + 可开合的标题屏锚点 + 上游 .title-conn 行（点/文案/ping/
 * 玩法说明/齿轮/全屏）/上游页脚/上游开始按钮 + 手动计时器。
 * 手动计时器（不落真实事件循环）让"60ms 合并窗口 / 1s 兜底轮询"在测试里完全确定。
 */
function mkWorld(opts = {}) {
  const observers = [];
  const created = [];
  const timers = [];
  let tid = 0;
  let queries = 0;
  let marks = 0;

  const htmlEl = mkEl('html');
  const head = mkEl('head');
  const body = mkEl('body');
  const appRoot = mkEl('div', body);
  body.appendChild(appRoot);
  const titleNode = mkEl('div', appRoot);          // 上游标题屏（只在锚点开启时"存在"）
  const startNode = mkEl('button', appRoot);       // 上游 .title-login .btn--primary
  const loginNode = mkEl('div', appRoot);
  loginNode.className = 'title-login';

  // 上游 0.2.1 自带的状态行（v10.0：整行保持可见、不动、不遮蔽）+ 页脚（版本行保持可见）
  const upConn = mkEl('div', loginNode); upConn.className = 'title-conn';
  const upDot = mkEl('span', upConn); upDot.className = 'status-dot is-on';
  const upTxt = mkEl('span', upConn); upTxt.textContent = '已连接服务器';
  const upPing = mkEl('span', upConn); upPing.className = 'ping ping--low';
  const upGuide = mkEl('button', upConn); upGuide.className = 'guide-btn title-guide';
  const settingsNode = mkEl('button', upConn); settingsNode.className = 'title-settings fsbtn tapx';
  const upFs = mkEl('button', upConn); upFs.className = 'fsbtn tapx title-fs';
  const upFoot = mkEl('footer', appRoot); upFoot.className = 'title-foot';
  const upCopy = mkEl('span', upFoot); upCopy.textContent = 'copyright';
  const upVer = mkEl('span', upFoot); upVer.className = 'micro micro--hi';
  upVer.textContent = 'v0.2.1 · WEB SIMULATION';

  let titlePresent = opts.title !== false;
  let dupesPresent = opts.upstream !== false;       // 上游节点是否存在（false = 类名被改的降级场景）
  let startPresent = opts.start !== false;

  const document = {
    readyState: 'complete',
    documentElement: htmlEl,
    head,
    body,
    createElement(tag) { const el = mkEl(tag); created.push(el); return el; },
    addEventListener() {},
    removeEventListener() {},
    getElementById(id) { return created.find((e) => e.getAttribute('id') === id) || null; },
    querySelector(sel) {
      queries += 1;
      if (sel === '.app-root') return opts.appRoot === false ? null : appRoot;
      if (opts.selfMatch) {
        // 模拟"上游节点缺失时选择器落到本层自己的节点"：isOurs 保护必须挡住（不许往自己层里塞）
        const l = layerNode();
        if (sel === UPSTREAM_CONN) return findIn(l, (e) => hasClass(e, 'title-foot'));
      }
      if (sel === UPSTREAM_CONN) return dupesPresent ? upConn : null;
      if (sel === UPSTREAM_FS) return dupesPresent ? upFs : null;
      if (sel === UPSTREAM_SETTINGS) return dupesPresent ? settingsNode : null;
      if (sel === UPSTREAM_START) return startPresent ? startNode : null;
      if (TITLE_MARKS.indexOf(sel) >= 0) { marks += 1; return titlePresent ? titleNode : null; }
      return null;
    },
  };

  function setTimeoutStub(fn, ms) {
    const t = { id: ++tid, fn, ms: ms || 0, done: false, cleared: false, interval: false };
    timers.push(t);
    return t.id;
  }
  function setIntervalStub(fn, ms) {
    const t = { id: ++tid, fn, ms: ms || 0, done: false, cleared: false, interval: true };
    timers.push(t);
    return t.id;
  }
  function clearTimer(id) {
    const t = timers.find((x) => x.id === id);
    if (t) t.cleared = true;
  }
  /** 跑若干轮"已到期"的定时器：轮询自身会补下一次，所以给定轮数上限。 */
  function flushTimers(rounds = 6) {
    for (let r = 0; r < rounds; r++) {
      for (const t of timers) {
        if (t.done || t.cleared) continue;
        if (t.interval) t.fn();
        else { t.done = true; t.fn(); }
      }
    }
  }

  const layerNode = () => created.find((e) => e.getAttribute('id') === 'sp-home-layer') || null;

  return {
    document, htmlEl, head, body, appRoot, observers, created, settingsNode, startNode, loginNode,
    up: { conn: upConn, dot: upDot, txt: upTxt, ping: upPing, guide: upGuide, fs: upFs,
      settings: settingsNode, foot: upFoot, copy: upCopy, ver: upVer },
    setTitle(present) { titlePresent = !!present; },
    setStart(present) { startPresent = !!present; },
    fireObserver() { observers.forEach((o) => o.fn()); },
    flushTimers,
    setTimeout: setTimeoutStub, clearTimeout: clearTimer,
    setInterval: setIntervalStub, clearInterval: clearTimer,
    hasInterval: () => timers.some((t) => t.interval && !t.cleared),
    queries: () => queries,
    marks: () => marks,
    layer: () => created.filter((e) => e.getAttribute('id') === 'sp-home-layer'),
    liveLayer: () => layerNode(),
    btn: (act) => created.find((e) => e.getAttribute('data-sp-home-btn') === act) || null,
    side: () => findIn(layerNode(), (e) => hasClass(e, 'title-side')),
    room: () => findIn(layerNode(), (e) => hasClass(e, 'title-room')),
    gear: () => created.find((e) => e.getAttribute('data-sp-home-btn') === 'settings') || null,
    foot: () => findIn(layerNode(), (e) => hasClass(e, 'title-foot')),
    // 访客数：v10 起是**上游 .title-conn 行里**的一个 span（活动树里找，避免 detached 残留误报）
    visitors: () => findIn(upConn, (e) => e.getAttribute('data-sp-home-visitors') !== null),
    version: () => findIn(layerNode(), (e) => e.getAttribute('data-sp-home-version') !== null),
    styleText: () => {
      const st = (head._kids || []).find((e) => e.getAttribute('id') === 'sp-home-layer-style');
      return st ? String(st.textContent) : null;
    },
  };
}

/** 跑一遍脚本。传同一个 win 可以跑第二遍 —— 幂等测试要的就是"同一个 window 重复注入"。 */
function run(world, opts = {}) {
  const win = opts.win || {};
  if (opts.shell !== undefined) win.shell = opts.shell;
  if (opts.spShell !== undefined) win.__SP_SHELL = opts.spShell;
  const sandbox = {
    window: win,
    document: world.document,
    setTimeout: world.setTimeout,
    clearTimeout: world.clearTimeout,
    setInterval: world.setInterval,
    clearInterval: world.clearInterval,
    console,
  };
  if (!opts.noObserver) {
    sandbox.MutationObserver = class { constructor(fn) { world.observers.push({ fn }); } observe() {} };
  }
  win.document = world.document;
  vm.runInNewContext(SRC, sandbox, { filename: 'home-layer.js' });
  return win;
}

/** 两个"进服"桥都齐的壳（多数用例的基线）。 */
function fullShell(calls) {
  return {
    setServer(id) { calls.push({ name: 'setServer', id }); },
    setAutostart() { calls.push({ name: 'setAutostart' }); },
  };
}

test('默认显示：控件挂进 .app-root、根为非遮挡 fixed 层、visible() 为真', () => {
  const w = mkWorld();
  const win = run(w);
  const layer = w.layer();
  assert.equal(layer.length, 1, '必须只有一个控件层');
  const style = layer[0].getAttribute('style');
  assert.ok(style.indexOf('position:fixed') >= 0, '必须是 fixed 层：' + style);
  assert.ok(style.indexOf('inset:0') >= 0 && style.indexOf('top:0') >= 0
    && style.indexOf('right:0') >= 0 && style.indexOf('bottom:0') >= 0 && style.indexOf('left:0') >= 0,
    'inset:0 与四边 longhand 兜底都要有：' + style);
  assert.ok(style.indexOf('z-index:var(--z-conn') >= 0, '层根 z-index 走 --z-conn：' + style);
  assert.ok(style.indexOf('pointer-events:none') >= 0, '层根不吃指针（只是叠加层，不遮罩整页）');
  assert.equal(layer[0].parentNode, w.appRoot, '必须挂在 .app-root 里（页面自己的面板才能弹在层上面）');
  assert.equal(layer[0].style.display, '', '默认就是显示的');
  assert.equal(win.__SP_HOME.visible(), true, '默认 visible() 为真');
  assert.ok(w.side(), '侧边栏 .title-side 必须存在');
  assert.ok(w.room(), '侧边按钮组 .title-room 必须存在');
  assert.ok(w.foot(), '页脚 .title-foot（检查更新）必须存在');
});

test('幂等：重复注入只有一个层、观察器不重复、点击不翻倍', () => {
  const w = mkWorld();
  const win = {};
  const panels = [];
  const spShell = { openPanel: (k) => panels.push(k) };
  run(w, { win, spShell });
  const createdFirst = w.created.length;
  run(w, { win, spShell });
  assert.equal(win.__SP_HOME_LAYER, 1, '守卫标记');
  assert.equal(w.layer().length, 1, '重复注入只许有一个层');
  assert.equal(w.observers.length, 1, '观察器只注册一次');
  assert.equal(w.created.length, createdFirst, '第二次注入不许再建任何节点');
  w.btn('params').click();
  assert.deepEqual(panels, ['params'], '监听不许翻倍（翻倍会调 2 次）');
});

test('首页态识别：无标题屏不显示；标题屏出现兜底 show；suppress 标记让开且可解除', () => {
  const w = mkWorld({ title: false });
  const win = run(w, { shell: fullShell([]) });
  assert.equal(win.__SP_HOME.visible(), false, '没有标题屏锚点 = 不当首页 = 不显示');
  assert.equal(w.layer().length, 0, '不当首页时连层都不建');
  win.__SP_HOME.hide();
  w.setTitle(true);
  w.fireObserver();
  w.flushTimers();
  assert.equal(win.__SP_HOME.visible(), true, '隐藏着但首页态出现 → 兜底 show()');
  win.__SP_HOME.hide();
  assert.equal(win.__SP_HOME.suppress(), false, '不加参数 = 读当前值');
  win.__SP_HOME.suppress(true);
  assert.equal(w.htmlEl.getAttribute('data-sp-home-suppress'), '1', '标记写在 html 上');
  assert.equal(win.__SP_HOME.visible(), false, 'suppress 时立刻让开');
  w.fireObserver();
  w.flushTimers();
  assert.equal(win.__SP_HOME.visible(), false, 'suppress 期间兜底探测必须失效');
  win.__SP_HOME.suppress(false);
  assert.equal(win.__SP_HOME.visible(), true, '解除 suppress → 首页态还在 → 自动盖上');
});

test('离开首页态自动收起、回来自动盖上（绝不盖住玩法界面）', () => {
  const w = mkWorld();
  const win = run(w, { shell: fullShell([]) });
  assert.equal(win.__SP_HOME.visible(), true);
  w.setTitle(false);
  w.fireObserver();
  w.flushTimers();
  assert.equal(win.__SP_HOME.visible(), false, '标题屏一卸载就收起');
  w.setTitle(true);
  w.fireObserver();
  w.flushTimers();
  assert.equal(win.__SP_HOME.visible(), true, '回到首页必须重新盖上');
});

test('观察器回调合并：一阵 DOM 风暴只换来一次扫描', () => {
  const w = mkWorld();
  const win = run(w, { shell: fullShell([]) });
  const before = w.marks();
  for (let i = 0; i < 20; i++) w.fireObserver();
  w.flushTimers();
  assert.equal(w.marks() - before, 1, '20 次变更只能触发 1 次扫描');
  assert.equal(win.__SP_HOME.visible(), true);
});

test('面板按钮「参数 / 配置 / 战绩」：kind 原样传给 openPanel', () => {
  const w = mkWorld();
  const panels = [];
  run(w, { spShell: { openPanel: (k) => panels.push(k) } });
  for (const kind of ['params', 'config', 'records']) {
    assert.equal(w.btn(kind).disabled, false, kind + ' 有桥就该可用');
    w.btn(kind).click();
  }
  assert.deepEqual(panels, ['params', 'config', 'records'], 'kind 必须原样传');
});

test('「检查更新」：走 __SP_SHELL.checkUpdate 桥，且不隐藏层', () => {
  const w = mkWorld();
  let n = 0;
  const win = run(w, { spShell: { openPanel() {}, checkUpdate() { n += 1; } } });
  assert.equal(win.__SP_HOME.visible(), true);
  w.btn('update').click();
  assert.equal(n, 1, '必须调 __SP_SHELL.checkUpdate 桥');
  assert.equal(win.__SP_HOME.visible(), true, '检查更新不隐藏层');
});

test('按钮精简（v10.0）：没有 local / online / fullscreen / servers / lobby 按钮', () => {
  const w = mkWorld();
  run(w, { shell: fullShell([]), spShell: { openPanel() {}, checkUpdate() {} } });
  for (const act of ['local', 'online', 'fullscreen', 'servers', 'lobby']) {
    assert.equal(w.btn(act), null, act + ' 按钮必须彻底不存在（外部模拟按 data-sp-home-btn 点击）');
  }
  assert.equal(w.side()._kids.filter((e) => e.tagName === 'BUTTON').length, 0,
    '.title-side 直接子节点里不许有按钮（按钮都在 .title-room 里）');
});

test('桥缺失：不抛错、按钮禁用并给出原因、点击什么都不做', () => {
  const w = mkWorld();
  let win = null;
  assert.doesNotThrow(() => { win = run(w); });
  assert.equal(win.__SP_HOME.visible(), true, '桥缺失不影响层本身的显示');
  for (const act of ['settings', 'params', 'config', 'records', 'update']) {
    const b = w.btn(act);
    assert.ok(b, act + ' 按钮必须存在');
    assert.equal(b.disabled, true, act + ' 必须被禁用');
    const reason = b.getAttribute('data-sp-home-why');
    assert.ok(reason && reason.length > 0, act + ' 必须给出禁用原因');
    assert.equal(b.getAttribute('title'), reason, '原因也要挂在 title 上');
    assert.doesNotThrow(() => b.click(), act + ' 点击不许抛错');
  }
  assert.equal(w.gear().disabled, true, '没有 openPanel 桥时，设置入口必须禁用');
});

test('__SP_HOME 三件套：show()/hide()/visible() 语义正确 + sweep 钩子保留', () => {
  const w = mkWorld();
  const win = run(w);
  const api = win.__SP_HOME;
  assert.equal(typeof api.show, 'function', 'Java 侧返回键要能调 show()');
  assert.equal(typeof api.hide, 'function');
  assert.equal(typeof api.suppress, 'function');
  assert.equal(typeof api.sweep, 'function');
  assert.equal(api.visible(), true);
  api.hide();
  assert.equal(api.visible(), false);
  assert.equal(w.layer()[0].style.display, 'none', '隐藏时 display:none');
  assert.equal(w.layer()[0].getAttribute('data-sp-home'), 'off');
  api.show();
  assert.equal(api.visible(), true);
  assert.equal(w.layer()[0].style.display, '', '显示时恢复');
  assert.equal(typeof win.__SP_HOME_LAYER_SWEEP, 'function', 'notice-board 要调这个钩子');
  assert.equal(win.__SP_HOME_LAYER, 1, '守卫标记必须保留');
});

test('设置入口：.title-room 首项「设置」，无独立 .title-gear，点击走 openPanel(\'appearance\')', () => {
  const w = mkWorld();
  const panels = [];
  let upstreamClicks = 0;
  w.settingsNode.addEventListener('click', () => { upstreamClicks += 1; });
  run(w, { spShell: { openPanel: (k) => panels.push(k) } });
  const g = w.gear();
  assert.ok(g, '设置入口必须存在');
  assert.ok(hasClass(g, 'title-room__cfg'), '必须是 .title-room__cfg：' + g.className);
  assert.equal(hasClass(g, 'title-gear'), false, '不许再有独立的 .title-gear');
  assert.equal(g.textContent, '设置');
  assert.equal(g.disabled, false, '有 openPanel 桥 → 可用');
  const room = w.room();
  assert.equal((room._kids || [])[0], g, '设置必须是 .title-room 的第一项');
  g.click();
  assert.deepEqual(panels, ['appearance'], '点击必须打开我们自己的设置面板（appearance）');
  assert.equal(upstreamClicks, 0, '不再转调上游 .title-settings');
  const w2 = mkWorld();
  run(w2);   // 无桥
  assert.equal(w2.gear().disabled, true, '没有 openPanel 桥 → 设置入口禁用（降级）');
  assert.equal(w2.created.some((e) => hasClass(e, 'title-gear')), false, '整个层里都不许有 .title-gear 节点');
});

test('侧边按钮组：恰好 设置/参数/配置/战绩（4 项，顺序固定；大厅已移出）', () => {
  const w = mkWorld();
  run(w, { shell: fullShell([]), spShell: { openPanel() {}, checkUpdate() {} } });
  const order = ['settings', 'params', 'config', 'records'];
  const labels = { settings: '设置', params: '参数', config: '配置', records: '战绩' };
  const roomBtns = (w.room()._kids || []).filter((e) => e.tagName === 'BUTTON');
  assert.deepEqual(roomBtns.map((b) => b.getAttribute('data-sp-home-btn')), order,
    '.title-room 顺序必须是 设置/参数/配置/战绩');
  for (const act of order) {
    const b = w.btn(act);
    assert.ok(b, act + ' 必须存在');
    assert.equal(b.textContent, labels[act], act + ' 文案必须是「' + labels[act] + '」');
    assert.equal(b.disabled, false, act + ' 桥齐时必须可用');
    assert.ok(hasClass(b, 'title-room__cfg'), act + ' 必须是 .title-room__cfg：' + b.className);
  }
  assert.equal(roomBtns.some((b) => b.getAttribute('data-sp-home-btn') === 'update'), false,
    '检查更新不许在侧栏（它属于页脚）');
  assert.equal(roomBtns.some((b) => b.textContent === '大厅'), false, 'v10.0：侧栏不许再有「大厅」');
});

test('检查更新：在页脚 .title-foot__meta 内，带 v3.5 薄荷描边类与 title 文案', () => {
  const w = mkWorld();
  run(w, { spShell: { openPanel() {}, checkUpdate() {} } });
  const b = w.btn('update');
  assert.ok(hasClass(b, 'title-foot__update'), '必须带 title-foot__update：' + b.className);
  assert.equal(b.textContent, '检查更新');
  assert.equal(b.getAttribute('title'), '检查内容更新', 'title 对齐 v3.3 补丁');
  const meta = findIn(w.liveLayer(), (e) => hasClass(e, 'title-foot__meta'));
  assert.ok(meta, '页脚 .title-foot__meta 必须存在');
  assert.ok((meta._kids || []).indexOf(b) >= 0, '检查更新必须在 .title-foot__meta 里');
  const css = w.styleText();
  assert.ok(css.indexOf('.title-foot__update{background:rgba(78,216,175,.08)') >= 0, 'v3.5 薄荷描边规则必须搬入');
  assert.ok(css.indexOf('.title-foot__update:hover{border-color:var(--mint-400,#4ed8af)') >= 0, 'hover 规则也要搬');
});

test('页脚版本号交给上游（v10.0）：我们不再画自己的版本行，也不遮蔽上游的版本行', () => {
  const w = mkWorld();
  run(w, { shell: fullShell([]), spShell: { openPanel() {}, checkUpdate() {} } });
  assert.equal(w.version(), null, '我们自己的版本号节点必须删掉（不许再出现 SP HOME vX.Y）');
  assert.ok(!SRC.includes('footVersion'), '源码里不许再有我们自己的版本常量');
  assert.ok(!/SP HOME v\d/i.test(SRC), '源码里不许再有 SP HOME vX.Y 版本标签');
  // 上游版本行：既没被隐藏，也没有我们的标记
  assert.equal(w.up.ver.style.display, '', '上游版本行必须保持显示');
  assert.equal(w.up.ver.getAttribute('data-sp-home-mask'), null, '上游版本行不许被标记');
  assert.equal(w.up.copy.style.display, '', '上游版权行必须保持显示');
  // 我们的检查更新按钮与上游页脚同处页脚区域（同一右缘、就在上游版本行上方）
  assert.ok(w.foot(), '我们自己的页脚（检查更新）必须存在');
  assert.ok(w.styleText().indexOf('.title-foot{position:absolute;z-index:3;right:.44rem;bottom:.62rem') >= 0,
    '页脚定位规则必须搬入（右缘 .44rem，与上游页脚同缘）');
});

test('v10.0：不再自绘右上角状态胶囊（连接状态/延迟交给上游 .title-conn）', () => {
  const w = mkWorld();
  run(w, { win: { __SP__: { store: { get: () => ({ connection: { status: 'online', ping: 42 } }) } } } });
  assert.equal(findIn(w.liveLayer(), (e) => e.getAttribute('data-sp-home-conn') !== null), null,
    '我们的连接胶囊节点必须不存在');
  assert.equal(findIn(w.liveLayer(), (e) => e.getAttribute('data-sp-home-ping') !== null), null,
    '我们的 PingPill 节点必须不存在');
  assert.equal(findIn(w.liveLayer(), (e) => hasClass(e, 'status-dot')), null, '状态点必须不存在');
  const css = w.styleText();
  assert.ok(css.indexOf('.title-conn{') < 0, '注入 CSS 里不许再声明我们自己的 .title-conn');
  assert.ok(css.indexOf('.status-dot') < 0 && css.indexOf('.ping') < 0, '胶囊/状态点的 CSS 必须删掉');
  // 上游状态行原样（可见、无标记、display 未改）
  assert.equal(w.up.conn.style.display, '', '上游 .title-conn 必须保持显示');
  assert.equal(w.up.conn.getAttribute('data-sp-home-mask'), null, '上游 .title-conn 不许被标记');
  assert.equal(w.up.dot.style.display, '', '上游状态点保持原样');
  assert.equal(w.up.ping.style.display, '', '上游延迟胶囊保持原样');
});

test('访客数（v5.2）：一个 span 追加到上游 .title-conn 行尾；在线显示、离线隐藏', () => {
  const onlineStore = { store: { get: () => ({ connection: { status: 'online', ping: 40 } }) } };
  const mk = (win) => { const w = mkWorld(); run(w, { win }); return w; };
  const w1 = mk({ __SP__: onlineStore, __SP_LOBBY: { visitorsCached: () => 42 } });
  const vis = w1.visitors();
  assert.ok(vis, '访客数 span 必须存在');
  assert.equal(vis.parentNode, w1.up.conn, '必须挂在上游 .title-conn 行里（v10 唯一的上游 DOM 写）');
  assert.equal(vis.parentNode._kids[vis.parentNode._kids.length - 1], vis, '必须追加在行尾（不改动上游子节点顺序）');
  assert.equal(vis.style.display, '', '在线时必须显示');
  assert.equal(vis.textContent, '· 大厅 42 人', '文案对齐 v5.2：' + vis.textContent);
  assert.equal(vis.getAttribute('style'), 'margin-left:.06rem;opacity:.66;font-size:.9em', '样式逐字搬 v5.2');
  const w2 = mk({ __SP__: { store: { get: () => ({ connection: { status: 'idle' } }) } }, __SP_LOBBY: { visitorsCached: () => 42 } });
  assert.equal(w2.visitors().style.display, 'none', '非在线时不显示');
  const w3 = mk({ __SP__: onlineStore, __SP_LOBBY: { visitorsCached: () => null } });
  assert.equal(w3.visitors().style.display, 'none', '无缓存时不显示');
  const w4 = mk({ __SP__: onlineStore });
  assert.equal(w4.visitors().style.display, 'none', '没有 lobby 模块时不显示（不抛错）');
});

test('访客数：让位 / 隐藏时把 span 从上游行里摘掉（上游 DOM 不留残留）', () => {
  const w = mkWorld();
  const win = run(w, { win: { __SP__: { store: { get: () => ({ connection: { status: 'online' } }) } }, __SP_LOBBY: { visitorsCached: () => 7 } } });
  const vis = w.visitors();
  assert.ok(vis, '先得挂上');
  assert.equal(vis.parentNode, w.up.conn);
  win.__SP_HOME.hide();
  assert.equal(vis.parentNode, null, 'hide() 必须把 span 摘下来');
  win.__SP_HOME.show();
  assert.equal(w.visitors().parentNode, w.up.conn, 'show() 必须重新挂回去（幂等，不重复建节点）');
  win.__SP_HOME.suppress(true);
  assert.equal(vis.parentNode, null, 'suppress 必须把 span 摘下来（让位 = 上游 DOM 干净）');
  win.__SP_HOME.suppress(false);
  assert.equal(w.visitors().parentNode, w.up.conn, '解除 suppress 后重新挂回');
});

test('访客数：选择器落到本层自己的节点时不误挂（isOurs 保护）', () => {
  const w = mkWorld({ selfMatch: true });
  const win = run(w, { win: { __SP__: { store: { get: () => ({ connection: { status: 'online' } }) } }, __SP_LOBBY: { visitorsCached: () => 7 } } });
  assert.equal(win.__SP_HOME.visible(), true, '层照常显示');
  const foot = findIn(w.liveLayer(), (e) => hasClass(e, 'title-foot'));
  assert.equal(findIn(foot, (e) => e.getAttribute('data-sp-home-visitors') !== null), null,
    '选择器落到我们自己的页脚时，绝不许把访客数塞进去');
  assert.equal(w.up.conn.getAttribute('data-sp-home-mask'), null, '上游行不受影响');
});

test('v10.0 上游 DOM 纪律：不再有遮蔽（无 data-sp-home-mask、无 display 改写、无 MASK 常量）', () => {
  const w = mkWorld();
  run(w, { shell: fullShell([]), spShell: { openPanel() {}, checkUpdate() {} } });
  for (const [name, el] of [['.title-conn', w.up.conn], ['齿轮', w.up.settings], ['版本行', w.up.ver],
    ['玩法说明', w.up.guide], ['全屏', w.up.fs], ['版权行', w.up.copy], ['开始按钮', w.startNode]]) {
    assert.equal(el.getAttribute('data-sp-home-mask'), null, name + ' 不许被标记隐藏');
    assert.equal(el.style.display, '', name + ' 的 display 不许被改');
  }
  assert.ok(!SRC.includes('data-sp-home-mask'), '源码里不许再有遮蔽标记');
  assert.ok(!SRC.includes('__SP_HOME_MASK_UPSTREAM'), '遮蔽开关必须整块删掉');
  assert.ok(!SRC.includes('maskUpstream'), '遮蔽实现必须整块删掉');
  // 上游「开始」按钮原样：overlay 不画 duo，也不动它
  assert.equal(w.startNode.style.display, '', '上游开始按钮必须保持显示');
});

test('vendored 让位：__SP_TITLE_VENDORED 时连上游 DOM 都不碰', () => {
  const w = mkWorld();
  const win = run(w, { win: { __SP_TITLE_VENDORED: 'shell-v2.9.31' } });
  assert.equal(win.__SP_HOME.visible(), false, 'vendored 副本在页面上 → 本层完全让位');
  assert.equal(w.layer().length, 0, '一个节点都不建');
  assert.equal(w.visitors(), null, '不许往上游 .title-conn 里塞访客数');
  for (const el of [w.up.conn, w.up.settings, w.up.ver, w.startNode]) {
    assert.equal(el.style.display, '', '上游节点必须保持原样');
    assert.equal(el.getAttribute('data-sp-home-mask'), null, '上游节点不许被标记');
  }
  assert.equal(win.__SP_HOME.visible(), false);
  assert.equal(win.__SP_HOME.suppress(), false, 'API 仍可用（Java 侧不炸）');
});

test('拿不到 .app-root：退到 body 挂载，层照常显示', () => {
  const w = mkWorld({ appRoot: false });
  const win = run(w, { shell: fullShell([]) });
  const layer = w.layer();
  assert.equal(layer.length, 1);
  assert.equal(layer[0].parentNode, w.body, '没有 .app-root 就挂 body');
  assert.ok(layer[0].getAttribute('style').indexOf('z-index:var(--z-conn') >= 0, 'z-index 走变量');
  assert.equal(win.__SP_HOME.visible(), true, '层本身照常显示');
  assert.equal(w.btn('records').disabled, true, '没有 openPanel 桥 → 面板按钮禁用');
});

test('上游锚点缺失：找不到 .title-screen 时层不显示且不抛错（降级而非消失）', () => {
  const w = mkWorld({ title: false, start: false });
  let win = null;
  assert.doesNotThrow(() => { win = run(w, { shell: fullShell([]) }); });
  assert.equal(win.__SP_HOME.visible(), false, '没有首页锚点 = 不显示（宁可少显示）');
  assert.equal(w.layer().length, 0, '不建层');
  assert.equal(w.visitors(), null, '不许往上游行里塞访客数');
  assert.equal(typeof win.__SP_HOME.sweep, 'function', 'API 仍在（外部模块可继续调）');
});

test('壳加载器：从 /__sp/home-layer.js 取，绝不用页面的脚本路径', () => {
  const at = BRIDGE.indexOf('v6.1: 首页覆盖层');
  assert.ok(at > 0, 'shell-bridge.js 里必须有这个加载器段落');
  const block = BRIDGE.slice(at);
  assert.ok(block.indexOf("'/__sp/home-layer.js'") > 0, '必须从外壳自有前缀取（filesDir 热更树 → APK，绝不走网络）');
  assert.ok(block.indexOf('window.__SP_HOME_LAYER') > 0, '已经有层就不许重复加载');
  assert.ok(!/src = ['"][^'"]*\/js\//.test(block), '绝不从页面的脚本路径取（上传方版本不可信）');
  const iHook = BRIDGE.indexOf("'/__sp/room-hook.js'");
  assert.ok(iHook > 0 && at > iHook, '首页层接在房间钩子之后注入（互不依赖，只是顺序稳定）');
});

test('源码不变量：ES5 / 纯 ASCII / 无网络 / 无页面模块 / 无凭据字面量', () => {
  assert.ok(!/import\s*\(/.test(SRC), '不许动态 import');
  assert.ok(!/\bfrom\s+['"]/.test(SRC), '不许静态 import');
  assert.ok(SRC.indexOf('/js/ui/') < 0 && SRC.indexOf('/vendor/') < 0 && SRC.indexOf('/js/') < 0,
    '不许出现页面的模块路径');
  assert.ok(!/https?:\/\//.test(SRC), '不许出现 URL 字面量（本增量零网络请求）');
  assert.ok(!/fetch\s*\(|XMLHttpRequest|WebSocket|EventSource/.test(SRC), '不许出现任何网络请求入口');
  assert.ok(SRC.indexOf('?.') < 0, '不许可选链');
  assert.ok(SRC.indexOf('??') < 0, '不许空值合并');
  assert.ok(SRC.indexOf('=>') < 0, '不许箭头函数');
  assert.ok(SRC.indexOf('`') < 0, '不许模板字符串');
  assert.ok(!/\b(let|const)\s+[A-Za-z_$]/.test(SRC), '不许 let/const 声明');
  assert.ok(!/(^|[^\w.])class\s+[A-Za-z_$]/.test(SRC), '不许 class 声明');
  assert.ok(/^[\x00-\x7F]*$/.test(SRC), '源码必须纯 ASCII（中文一律 \\uXXXX）');
  assert.ok(SRC.indexOf('replaceAll') < 0, '不许 replaceAll');
  assert.ok(SRC.indexOf('password') < 0 && SRC.indexOf('token') < 0 && SRC.indexOf('secret') < 0,
    '不许出现凭据字面量');
  assert.ok(SRC.indexOf('window.shell') >= 0 || SRC.indexOf('__SP_SHELL') >= 0, '只走外壳桥（对照组）');
});

test('注入 CSS：逐字搬的主题变量与 scoped 选择器', () => {
  const w = mkWorld();
  run(w, { shell: fullShell([]) });
  const css = w.styleText();
  assert.ok(css, '样式块必须注入');
  for (const sel of ['#sp-home-layer .title-side',
    '#sp-home-layer .title-room{', '#sp-home-layer .title-room__cfg{',
    '#sp-home-layer .title-foot{', '#sp-home-layer .title-foot__meta{', '#sp-home-layer .title-foot__update{']) {
    assert.ok(css.indexOf(sel) >= 0, '缺 scoped 规则：' + sel);
  }
  assert.ok(css.indexOf('.title-gear') < 0, '独立的 .title-gear 规则必须删掉（v3.5 已并入 .title-room__cfg）');
  assert.ok(css.indexOf('.title-conn') < 0, 'v10.0：胶囊的 .title-conn 规则必须删掉（状态行归上游）');
  // 逐字搬的关键声明（含补丁里的字面颜色 / 圆角 / 间距）
  assert.ok(css.indexOf('border:1px solid #2c3a35') >= 0, 'v2.2 按钮描边逐字搬');
  assert.ok(css.indexOf('background:rgba(12,15,14,.55)') >= 0, 'v2.2 按钮底色逐字搬');
  assert.ok(css.indexOf('top:1.7rem;right:.44rem') >= 0, '侧栏定位（为上游更高的右上角块下移；三视口实测）');
  // 短屏媒体查询不许再把侧栏顶到角块里（v10.0）
  assert.ok(css.indexOf('@media (max-height:600px) and (pointer:coarse){') >= 0, '短屏媒体查询保留');
  assert.ok(!/@media \(max-height:600px\) and \(pointer:coarse\)\{[^}]*top:1\.2rem/.test(css),
    '短屏媒体查询不许再改 .title-side 的 top（1.2rem 会压上游角块）');
  // 上游主题变量的用法必须保留（都带 fallback）；v10.0 删掉胶囊后不再用 --line/--amber/--red-premium
  for (const v of ['--mint-400', '--mint-700', '--text-hi', '--text-dim',
    '--font-display', '--z-conn', '--t-fast', '--ease-out']) {
    assert.ok(css.indexOf('var(' + v) >= 0, '必须用到上游主题变量 ' + v);
  }
  // 引用到的主题变量必须在页面 theme.css 里真的有定义（防止自造 token）
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  assert.ok(used.size > 0, '必须真的用到主题变量');
  for (const name of used) {
    assert.ok(THEME.indexOf(name + ':') >= 0, name + ' 必须在 theme.css 里定义');
  }
});

test('轮询兜底：没有 MutationObserver 时用 setInterval 驱动 sweep', () => {
  const w = mkWorld({ title: false });
  const win = run(w, { shell: fullShell([]), noObserver: true });
  assert.equal(w.observers.length, 0, '本用例故意不给观察器');
  assert.equal(w.hasInterval(), true, '没有观察器就必须起兜底轮询');
  assert.equal(win.__SP_HOME.visible(), false, '起始不在首页');
  w.setTitle(true);
  w.flushTimers();                                       // 只有 1s 兜底轮询在跑
  assert.equal(win.__SP_HOME.visible(), true, '兜底轮询必须能发现首页态并显示');
});

test('上游 0.2.1 DOM 重渲染后访客数能补挂（观察器兜底）', () => {
  const w = mkWorld();
  const win = run(w, { win: { __SP__: { store: { get: () => ({ connection: { status: 'online' } }) } }, __SP_LOBBY: { visitorsCached: () => 3 } } });
  const vis = w.visitors();
  assert.equal(vis.parentNode, w.up.conn);
  // 模拟 preact 重渲染：把上游行的子节点整批换掉（我们的 span 被冲掉）
  w.up.conn.removeChild(vis);
  assert.equal(w.visitors(), null, 'span 已被冲掉');
  w.fireObserver();
  w.flushTimers();
  assert.equal(win.__SP_HOME.visible(), true);
  assert.equal(w.visitors().parentNode, w.up.conn, '下一次扫描必须把 span 补回上游行');
});

// ---- v10.1: 一次性 autostart 的归属（大厅加入后直接进房） -------------------------------------------
// 大厅面板 joinRoom → joinOnOrigin → setAutostart()，切服重载后**标题屏**取用一次即自动 start()。
// 页面同时挂着本层与 vendored 标题副本时，一次性标志只能有一个消费者：副本自己会消费，本层必须让位。
// 修前：本层在 arm()（早于延迟求值的标题模块）就 takeAutostart() 吃掉标志，副本再也读不到，
//       且 400ms 兜底点在 vendored 的主按钮（大厅）上 —— 业主「点加入后停在标题屏、还要再点一次」。

/** 计数壳：takeAutostart 记次数并按 armed 返回 '1'/'0'。 */
function autostartShell(state, calls) {
  return {
    takeAutostart() { calls.push('take'); return state.armed ? '1' : '0'; },
    setAutostart() { calls.push('set'); },
  };
}

/** 给上游开始按钮装点击计数（mkWorld 的 startNode 是真事件桩）。 */
function countStartClicks(w) {
  const hits = [];
  w.startNode.addEventListener('click', () => { hits.push(1); });
  return hits;
}

test('autostart：vendored 标题副本在页面时，本层绝不消费一次性标志（让给副本）', () => {
  const w = mkWorld();
  const calls = [];
  const hits = countStartClicks(w);
  const win = run(w, { shell: autostartShell({ armed: true }, calls), win: { __SP_TITLE_VENDORED: 'shell-v2.9.31' } });
  assert.equal(win.__SP_HOME.visible(), false, 'vendored 副本在 → 本层让位');
  w.fireObserver();
  w.flushTimers();
  assert.deepEqual(calls, [], '本层一个桥都不许调：takeAutostart 必须留给 vendored 副本的挂载 effect');
  assert.equal(hits.length, 0, '更不许点 vendored 的主按钮（大厅）');
});

test('autostart：纯上游标题屏时本层消费一次并点上游「开始」（手动路径不受影响）', () => {
  const w = mkWorld();
  const calls = [];
  const hits = countStartClicks(w);
  run(w, { shell: autostartShell({ armed: true }, calls) });
  assert.deepEqual(calls, ['take'], 'arm/sweep 即取用一次');
  assert.equal(hits.length, 0, '400ms 未到前不点');
  w.flushTimers();
  assert.equal(hits.length, 1, '400ms 后点一次上游「开始」= 自动进入');
  assert.equal(w.startNode.disabled, false, '上游开始按钮原样可点');
});

test('autostart：一次性——后续每次扫描都不再取用、不再重复点击', () => {
  const w = mkWorld();
  const calls = [];
  const hits = countStartClicks(w);
  run(w, { shell: autostartShell({ armed: true }, calls) });
  for (let i = 0; i < 5; i++) { w.fireObserver(); w.flushTimers(1); }
  assert.equal(calls.filter((c) => c === 'take').length, 1, 'takeAutostart 全程只调一次');
  assert.equal(hits.length, 1, '只自动进入一次（不重复点）');
});

test('autostart：未布防（普通加载）绝不自动进入', () => {
  const w = mkWorld();
  const calls = [];
  const hits = countStartClicks(w);
  run(w, { shell: autostartShell({ armed: false }, calls) });
  w.fireObserver();
  w.flushTimers();
  assert.equal(calls.filter((c) => c === 'take').length, 1, '读一次即 0（不残留）');
  assert.equal(hits.length, 0, '没布防就不许替用户点「开始」');
});

test('autostart：无标题屏时先不取用，标题屏出现后按归属消费一次', () => {
  const w = mkWorld({ title: false });
  const calls = [];
  run(w, { shell: autostartShell({ armed: true }, calls), noObserver: true });
  assert.deepEqual(calls, [], '没有标题屏 → 不取用（标志留给真正会挂载的标题屏）');
  w.setTitle(true);
  w.flushTimers();
  assert.equal(calls.filter((c) => c === 'take').length, 1, '标题屏出现后取用一次');
});

test('autostart：vendored 标志晚于 arm() 出现也照样让位（延迟门，不是 arm 时快照）', () => {
  // arm() 时还没有标题屏；vendored 副本的模块求值先置标记，随后标题 DOM 才挂上。
  const w = mkWorld({ title: false });
  const calls = [];
  const hits = countStartClicks(w);
  run(w, { shell: autostartShell({ armed: true }, calls), win: { __SP_TITLE_VENDORED: 'shell-v2.9.31' }, noObserver: true });
  assert.deepEqual(calls, [], 'arm 时没有标题屏 → 不消费');
  w.setTitle(true);
  w.flushTimers();
  assert.deepEqual(calls, [], 'vendored 在页面 → 标题屏出现后也不消费（副本自己会取）');
  assert.equal(hits.length, 0, '绝不点 vendored 的主按钮');
});

