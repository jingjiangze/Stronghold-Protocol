// home-layer v9.0 的行为测试：vm + 最小 DOM 桩，真跑一遍控件层逻辑（不引入任何依赖）。
//
// v9.0 = 首页控件精简（用户逐字口径）：去掉 全屏 / 本地服务(进入) / 进入线上 三个按钮；「服务器」
// 只改文案为「大厅」（act 仍是 servers，仍 openPanel('servers')）；「设置」不再转调上游 .title-settings，
// 改为 openPanel('appearance')（我们自己的外观面板）。侧栏 = 设置/参数/配置/战绩/大厅。
// 上游 .title-conn 整行仍始终遮蔽（不再以"我们能否提供全屏"为条件）。
//
// 覆盖：默认显示与非遮挡 / 首页态识别与 suppress / 离开首页态自动收起 / 观察器合并 /
//       侧栏恰好 设置·参数·配置·战绩·大厅（顺序）/ 设置走 openPanel('appearance') /
//       大厅 act=servers 走 openPanel('servers') / 参数·配置·战绩走 openPanel(kind) / 检查更新走 checkUpdate /
//       没有 fullscreen/local/online 按钮 / 桥缺失降级 / __SP_HOME 三件套与 sweep 钩子 /
//       连接胶囊四档 / 访客数 / 按钮文案与类名 / 检查更新薄荷描边类 / .app-root 兜底 / 锚点缺失降级 /
//       壳加载器只从 /__sp/ 取 / 源码不变量（ES5、纯 ASCII、无网络）/ CSS 逐字搬 / 轮询兜底 /
//       上游去重遮蔽（始终藏整行，可逆）。
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
 * 一次"页面"：html/head/body/.app-root + 可开合的标题屏锚点 + 上游设置齿轮/开始按钮 + 手动计时器。
 * 手动计时器（不落真实事件循环）让"60ms 合并窗口 / 500ms 轮询 / 1s 兜底轮询"在测试里完全确定。
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

  // 上游 0.2.1 自带、与我们重复的节点（遮蔽步骤的目标 + 必须保留的邻居）
  const upConn = mkEl('div', appRoot); upConn.className = 'title-conn';
  const upDot = mkEl('span', upConn); upDot.className = 'status-dot is-on';
  const upTxt = mkEl('span', upConn); upTxt.textContent = '已连接服务器';
  const upPing = mkEl('span', upConn); upPing.className = 'ping ping--low';
  const upGuide = mkEl('button', upConn); upGuide.className = 'guide-btn title-guide';
  const upFs = mkEl('button', upConn); upFs.className = 'fsbtn tapx title-fs';
  const settingsNode = mkEl('button', upConn); settingsNode.className = 'title-settings fsbtn tapx';
  const upFoot = mkEl('footer', appRoot); upFoot.className = 'title-foot';
  const upCopy = mkEl('span', upFoot); upCopy.textContent = 'copyright';
  const upVer = mkEl('span', upFoot); upVer.className = 'micro micro--hi';

  let titlePresent = opts.title !== false;
  let dupesPresent = opts.upstream !== false;       // 上游重复节点是否存在（false = 类名被改的降级场景）
  let fsPresent = opts.fs !== false && dupesPresent;
  let settingsPresent = opts.settings !== false && dupesPresent;
  let startPresent = opts.start !== false;

  // 原生全屏桩（镜像 public/js/ui/device.js 的 fullscreen 助手用到的 API）
  const fsCalls = { enter: 0, exit: 0 };
  htmlEl.requestFullscreen = () => { fsCalls.enter += 1; return Promise.resolve(); };

  const document = {
    readyState: 'complete',
    documentElement: htmlEl,
    head,
    body,
    fullscreenEnabled: !!opts.fsEnabled,
    fullscreenElement: null,
    exitFullscreen() { fsCalls.exit += 1; this.fullscreenElement = null; return Promise.resolve(); },
    createElement(tag) { const el = mkEl(tag); created.push(el); return el; },
    addEventListener() {},
    removeEventListener() {},
    getElementById(id) { return created.find((e) => e.getAttribute('id') === id) || null; },
    querySelector(sel) {
      queries += 1;
      if (sel === '.app-root') return opts.appRoot === false ? null : appRoot;
      if (opts.selfMatch) {
        // 模拟"上游重复节点缺失时选择器落到本层自己的节点"：isOurs 保护必须挡住
        const l = layerNode();
        if (sel === '.title-conn') return findIn(l, (e) => e.getAttribute('data-sp-home-conn') !== null);
        if (sel === '.title-foot .micro') return null;
      }
      if (sel === '.title-conn') return dupesPresent ? upConn : null;
      if (sel === '.title-foot .micro') return dupesPresent ? upVer : null;
      if (sel === UPSTREAM_FS) return fsPresent ? upFs : null;
      if (sel === UPSTREAM_SETTINGS) return settingsPresent ? settingsNode : null;
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
    document, htmlEl, head, body, appRoot, observers, created, settingsNode, startNode,
    up: { conn: upConn, dot: upDot, txt: upTxt, ping: upPing, guide: upGuide, fs: upFs,
      settings: settingsNode, foot: upFoot, copy: upCopy, ver: upVer },
    fsCalls,
    setTitle(present) { titlePresent = !!present; },
    setSettings(present) { settingsPresent = !!present; },
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
    conn: () => findIn(layerNode(), (e) => e.getAttribute('data-sp-home-conn') !== null),
    connText: () => findIn(layerNode(), (e) => e.getAttribute('data-sp-home-conn-text') !== null),
    connDot: () => findIn(layerNode(), (e) => hasClass(e, 'status-dot')),
    ping: () => findIn(layerNode(), (e) => e.getAttribute('data-sp-home-ping') !== null),
    pingVal: () => findIn(layerNode(), (e) => hasClass(e, 'ping__value')),
    visitors: () => findIn(layerNode(), (e) => e.getAttribute('data-sp-home-visitors') !== null),
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

test('「大厅」按钮：act 仍是 servers，文案是「大厅」，走 __SP_SHELL.openPanel(\'servers\')，不隐藏层', () => {
  const w = mkWorld();
  const panels = [];
  const win = run(w, { spShell: { openPanel: (k) => panels.push(k) } });
  const b = w.btn('servers');
  assert.equal(b.getAttribute('data-sp-home-btn'), 'servers', 'act 值必须保留 servers（外部模拟按属性点击）');
  assert.equal(b.textContent, '大厅', '文案必须是「大厅」');
  assert.equal(b.disabled, false, '有桥就该可用');
  b.click();
  assert.deepEqual(panels, ['servers'], 'kind 必须原样传给面板');
  assert.equal(win.__SP_HOME.visible(), true, '开面板不许把层藏起来（面板 z-index 更高）');
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

test('按钮精简：没有 local / online / fullscreen 按钮（act 属性彻底移除）', () => {
  const w = mkWorld();
  run(w, { shell: fullShell([]), spShell: { openPanel() {}, checkUpdate() {} } });
  for (const act of ['local', 'online', 'fullscreen']) {
    assert.equal(w.btn(act), null, act + ' 按钮必须彻底不存在（外部模拟按 data-sp-home-btn 点击）');
  }
  assert.ok(w.conn(), '我们自己的连接胶囊仍在（那是我们自己的节点）');
});

test('桥缺失：不抛错、按钮禁用并给出原因、点击什么都不做', () => {
  const w = mkWorld();
  let win = null;
  assert.doesNotThrow(() => { win = run(w); });
  assert.equal(win.__SP_HOME.visible(), true, '桥缺失不影响层本身的显示');
  for (const act of ['settings', 'params', 'config', 'records', 'servers', 'update']) {
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

test('连接胶囊：读 __SP__.store 的 connection，文案与 ping 正确', () => {
  const make = (status, ping) => {
    const w = mkWorld();
    const win = run(w, { win: { __SP__: { store: { get: () => ({ connection: { status, ping } }) } } } });
    return { w, win };
  };
  const online = make('online', 50);
  assert.equal(online.w.connText().textContent, '已连接服务器');
  assert.equal(online.w.connDot().className, 'status-dot is-on');
  assert.equal(online.w.ping().style.display, '', 'online 时显示 ping');
  assert.equal(online.w.pingVal().textContent, '50', 'ping 数值 50');
  assert.equal(make('reconnecting').w.connText().textContent, '连接中断，正在重连');
  assert.equal(make('connecting').w.connText().textContent, '正在连接服务器');
  assert.equal(make('idle').w.connText().textContent, '准备连接');
  const none = mkWorld();
  run(none);
  assert.equal(none.connText().textContent, '未连接', '没有 __SP__ 时降级为「未连接」');
  assert.equal(none.conn().getAttribute('data-sp-home-conn-state'), 'unknown');
  assert.equal(none.conn().getAttribute('role'), 'status', '状态区可被读屏播报');
});

test('访客数：在线时渲染在连接行（v5.2「· 大厅 N 人」），离线 / 无缓存不显示', () => {
  const mk = (win) => { const w = mkWorld(); run(w, { win }); return w; };
  const onlineStore = { store: { get: () => ({ connection: { status: 'online', ping: 40 } }) } };
  const w1 = mk({ __SP__: onlineStore, __SP_LOBBY: { visitorsCached: () => 42 } });
  const vis = w1.visitors();
  assert.ok(vis, '访客数节点必须存在');
  assert.equal(vis.parentNode, w1.conn(), '访客数必须在连接行（v5.2 状态行），不在页脚');
  assert.equal(vis.style.display, '', '在线时必须显示');
  assert.equal(vis.textContent, '· 大厅 42 人', '文案对齐 v5.2：' + vis.textContent);
  const w2 = mk({ __SP__: { store: { get: () => ({ connection: { status: 'idle' } }) } }, __SP_LOBBY: { visitorsCached: () => 42 } });
  assert.equal(w2.visitors().style.display, 'none', '非在线时不显示访客数');
  const w3 = mk({ __SP__: onlineStore, __SP_LOBBY: { visitorsCached: () => null } });
  assert.equal(w3.visitors().style.display, 'none', '无缓存时不显示');
  const w4 = mk({ __SP__: onlineStore });
  assert.equal(w4.visitors().style.display, 'none', '没有 lobby 模块时不显示（不抛错）');
});

test('侧边按钮组：恰好 设置/参数/配置/战绩/大厅（顺序固定）', () => {
  const w = mkWorld();
  run(w, { shell: fullShell([]), spShell: { openPanel() {}, checkUpdate() {} } });
  const order = ['settings', 'params', 'config', 'records', 'servers'];
  const labels = { settings: '设置', params: '参数', config: '配置', records: '战绩', servers: '大厅' };
  const roomBtns = (w.room()._kids || []).filter((e) => e.tagName === 'BUTTON');
  assert.deepEqual(roomBtns.map((b) => b.getAttribute('data-sp-home-btn')), order,
    '.title-room 顺序必须是 设置/参数/配置/战绩/大厅');
  for (const act of order) {
    const b = w.btn(act);
    assert.ok(b, act + ' 必须存在');
    assert.equal(b.textContent, labels[act], act + ' 文案必须是「' + labels[act] + '」');
    assert.equal(b.disabled, false, act + ' 桥齐时必须可用');
    assert.ok(hasClass(b, 'title-room__cfg'), act + ' 必须是 .title-room__cfg：' + b.className);
  }
  assert.equal(roomBtns.some((b) => b.getAttribute('data-sp-home-btn') === 'update'), false,
    '检查更新不许在侧栏（它属于页脚）');
  assert.ok(w.version(), '页脚版本号节点必须存在');
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
  const kids = meta._kids || [];
  assert.ok(kids.indexOf(b) >= 0, '检查更新必须在 .title-foot__meta 里');
  assert.ok(kids.indexOf(w.version()) >= 0, '版本号也在这行');
  assert.ok(kids.indexOf(w.version()) < kids.indexOf(b), '顺序：版本在前、检查更新在后（对齐 v3.3）');
  const css = w.styleText();
  assert.ok(css.indexOf('.title-foot__update{background:rgba(78,216,175,.08)') >= 0, 'v3.5 薄荷描边规则必须搬入');
  assert.ok(css.indexOf('.title-foot__update:hover{border-color:var(--mint-400,#4ed8af)') >= 0, 'hover 规则也要搬');
});

test('拿不到 .app-root：退到 body 挂载，层照常显示', () => {
  const w = mkWorld({ appRoot: false });
  const win = run(w, { shell: fullShell([]) });
  const layer = w.layer();
  assert.equal(layer.length, 1);
  assert.equal(layer[0].parentNode, w.body, '没有 .app-root 就挂 body');
  assert.ok(layer[0].getAttribute('style').indexOf('z-index:var(--z-conn') >= 0, 'z-index 走变量');
  assert.equal(win.__SP_HOME.visible(), true, '层本身照常显示');
  assert.equal(w.btn('servers').disabled, true, '没有 openPanel 桥 → 面板按钮禁用');
});

test('上游锚点缺失：找不到 .title-screen 时层不显示且不抛错（降级而非消失）', () => {
  const w = mkWorld({ title: false, settings: false, start: false });
  let win = null;
  assert.doesNotThrow(() => { win = run(w, { shell: fullShell([]) }); });
  assert.equal(win.__SP_HOME.visible(), false, '没有首页锚点 = 不显示（宁可少显示）');
  assert.equal(w.layer().length, 0, '不建层');
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
    '#sp-home-layer .title-room{', '#sp-home-layer .title-room__cfg{', '#sp-home-layer .title-conn{',
    '#sp-home-layer .title-conn .ping{', '#sp-home-layer .title-conn .status-dot{',
    '#sp-home-layer .title-foot{', '#sp-home-layer .title-foot__meta{', '#sp-home-layer .title-foot__update{']) {
    assert.ok(css.indexOf(sel) >= 0, '缺 scoped 规则：' + sel);
  }
  assert.ok(css.indexOf('.title-gear') < 0, '独立的 .title-gear 规则必须删掉（v3.5 已并入 .title-room__cfg）');
  // 逐字搬的关键声明（含补丁里的字面颜色 / 圆角 / 间距）
  assert.ok(css.indexOf('border:1px solid #2c3a35') >= 0, 'v2.2 按钮描边逐字搬');
  assert.ok(css.indexOf('background:rgba(12,15,14,.55)') >= 0, 'v2.2 按钮底色逐字搬');
  assert.ok(css.indexOf('border-radius:99px') >= 0, 'PingPill 胶囊圆角逐字搬');
  assert.ok(css.indexOf('top:1.35rem;right:.44rem') >= 0, '侧栏定位（为上游更高的右上角块下移）');
  // 上游主题变量的用法必须保留（都带 fallback）
  for (const v of ['--mint-400', '--mint-700', '--mint-glow', '--line', '--text-hi',
    '--text-lo', '--text-dim', '--amber', '--red-premium', '--font-num', '--font-display', '--z-conn']) {
    assert.ok(css.indexOf('var(' + v) >= 0, '必须用到上游主题变量 ' + v);
  }
  // 引用到的主题变量必须在页面 theme.css 里真的有定义（防止自造 token）
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  assert.ok(used.size > 0, '必须真的用到主题变量');
  for (const name of used) {
    if (name === '--pc') continue;                       // .ping 自己的局部变量
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

// ---------------------------------------------------------------- v8.0 上游去重遮蔽

test('去重遮蔽：命中时藏上游整条 .title-conn 行 + 设置齿轮 + 版本行，保留版权 / 开始', () => {
  const w = mkWorld();
  const panels = [];
  const win = run(w, { shell: fullShell([]), spShell: { openPanel: (k) => panels.push(k) } });
  const MASK = 'data-sp-home-mask';
  // 整条上游连接行（点 / 文案 / 胶囊 / 玩法说明 / 设置 / 全屏都在里面）被藏
  assert.equal(w.up.conn.getAttribute(MASK), '1', '上游 .title-conn 整行必须被标记隐藏');
  assert.equal(w.up.conn.style.display, 'none', '上游 .title-conn 整行必须 display:none');
  assert.equal(w.up.guide.parentNode, w.up.conn, '玩法说明确实在这条被藏的行里（随行一起隐藏）');
  assert.equal(w.up.fs.parentNode, w.up.conn, '全屏确实在这条被藏的行里');
  // 齿轮与版本行单独也标记（.title-conn 改名时的兜底）
  assert.equal(w.up.settings.getAttribute(MASK), '1', '设置齿轮必须被标记隐藏');
  assert.equal(w.up.settings.style.display, 'none', '设置齿轮必须 display:none');
  assert.equal(w.up.ver.getAttribute(MASK), '1', '版本元信息行必须被标记隐藏');
  assert.equal(w.up.ver.style.display, 'none', '版本元信息行必须 display:none');
  // 保留：版权行、开始按钮
  for (const [name, el] of [['版权行', w.up.copy], ['开始按钮', w.startNode]]) {
    assert.equal(el.getAttribute(MASK), null, name + ' 不许被标记隐藏');
    assert.notEqual(el.style.display, 'none', name + ' 必须保持可见');
  }
  // 我们自己的同名节点（.title-conn / .status-dot / .ping）绝不能被藏
  assert.equal(w.conn().getAttribute(MASK), null, '我们自己的连接行不许被藏');
  assert.equal(w.connDot().getAttribute(MASK), null, '我们自己的状态点不许被藏');
  assert.equal(w.ping().getAttribute(MASK), null, '我们自己的胶囊不许被藏');
  assert.equal(win.__SP_HOME.visible(), true, '遮蔽不影响本层显示');
  // v9.0: 我们的「设置」不再转调上游齿轮（改为 openPanel('appearance')）—— 即使齿轮被藏，
  // 我们的设置按钮仍打开我们自己的面板，且绝不触发上游 .title-settings 的 click。
  let settingsClicks = 0;
  w.up.settings.addEventListener('click', () => { settingsClicks += 1; });
  w.gear().click();
  assert.deepEqual(panels, ['appearance'], '设置入口必须打开我们自己的 appearance 面板');
  assert.equal(settingsClicks, 0, '不再转调上游 .title-settings');
});

test('去重遮蔽：选择器全不命中零副作用；选择器落到本层节点也不误藏', () => {
  // (a) 上游重复节点都不存在（类名被改的降级场景）：什么都不藏、不抛错，层照常
  const w = mkWorld({ upstream: false });
  let win = null;
  assert.doesNotThrow(() => { win = run(w, { shell: fullShell([]) }); });
  assert.equal(win.__SP_HOME.visible(), true, '层照常显示');
  for (const el of [w.up.conn, w.up.dot, w.up.ping, w.up.settings, w.up.ver]) {
    assert.equal(el.getAttribute('data-sp-home-mask'), null, '不存在时不许被标记');
    assert.equal(el.style.display, '', '不存在时 display 不许被改');
  }
  // (b) 选择器落到本层自己的节点（模拟上游缺失时 querySelector 命中我们）：isOurs 必须挡住
  const w2 = mkWorld({ selfMatch: true });
  run(w2, { shell: fullShell([]) });
  assert.equal(w2.conn().getAttribute('data-sp-home-mask'), null, '我们自己的连接行绝不能被藏');
  assert.equal(w2.conn().style.display, '', '我们自己的连接行 display 不许被改');
  assert.equal(w2.connDot().getAttribute('data-sp-home-mask'), null, '我们自己的状态点绝不能被藏');
  assert.equal(w2.ping().getAttribute('data-sp-home-mask'), null, '我们自己的胶囊绝不能被藏');
  assert.equal(w2.up.conn.getAttribute('data-sp-home-mask'), null, '本用例里上游节点也不该被动');
});

test('去重遮蔽：开关关闭时上游原样（零副作用）', () => {
  const w = mkWorld();
  const win = run(w, { shell: fullShell([]), win: { __SP_HOME_MASK_UPSTREAM: 0 } });
  assert.equal(win.__SP_HOME.visible(), true, '关遮蔽不影响本层显示');
  for (const el of [w.up.conn, w.up.settings, w.up.ver, w.up.guide, w.up.fs]) {
    assert.equal(el.getAttribute('data-sp-home-mask'), null, '关掉后不许有标记');
    assert.equal(el.style.display, '', '关掉后上游原样');
  }
});

test('去重遮蔽：可逆（默认开 → 关掉恢复上游原样 → 再开重新藏）', () => {
  const w = mkWorld();
  const win = run(w, { shell: fullShell([]) });
  assert.equal(w.up.conn.getAttribute('data-sp-home-mask'), '1', '默认开 → 藏整行');
  assert.equal(w.up.conn.style.display, 'none');
  win.__SP_HOME_MASK_UPSTREAM = 0;
  win.__SP_HOME.sweep();
  assert.equal(w.up.conn.getAttribute('data-sp-home-mask'), null, '关掉 → 标记移除');
  assert.equal(w.up.conn.style.display, '', '关掉 → display 还原');
  assert.equal(w.up.settings.getAttribute('data-sp-home-mask'), null, '齿轮也还原');
  assert.equal(w.up.ver.getAttribute('data-sp-home-mask'), null, '版本行也还原');
  win.__SP_HOME_MASK_UPSTREAM = 1;
  win.__SP_HOME.sweep();
  assert.equal(w.up.conn.getAttribute('data-sp-home-mask'), '1', '再开 → 重新藏');
  assert.equal(w.up.conn.style.display, 'none');
  assert.equal(w.up.settings.getAttribute('data-sp-home-mask'), '1', '齿轮重新藏');
});

test('去掉全屏/本地服务/进入线上后：.title-conn 整行仍始终被遮蔽，不再依赖 canFullscreen', () => {
  // (a) 有原生全屏能力、上游全屏按钮也在：整行照样藏
  const w1 = mkWorld({ fsEnabled: true });
  run(w1, { shell: fullShell([]), spShell: { openPanel() {} } });
  assert.equal(w1.up.conn.getAttribute('data-sp-home-mask'), '1', '整条上游连接行必须被藏');
  assert.equal(w1.up.conn.style.display, 'none');
  assert.equal(w1.up.fs.getAttribute('data-sp-home-mask'), null, '上游全屏按钮不单独标记（随整行隐藏）');
  assert.equal(w1.btn('fullscreen'), null, '我们不再有全屏按钮');
  // (b) 完全没有全屏能力：整行也必须藏（不再以 canFullscreen 为条件）
  const w2 = mkWorld({ fs: false, fsEnabled: false });
  run(w2, { shell: fullShell([]), spShell: { openPanel() {} } });
  assert.equal(w2.up.conn.getAttribute('data-sp-home-mask'), '1', '无全屏能力时整行仍必须被藏');
  assert.equal(w2.up.conn.style.display, 'none');
  assert.equal(w2.btn('fullscreen'), null, '没有全屏按钮');
  assert.equal(w2.btn('local'), null, '没有本地服务按钮');
  assert.equal(w2.btn('online'), null, '没有进入线上按钮');
});

