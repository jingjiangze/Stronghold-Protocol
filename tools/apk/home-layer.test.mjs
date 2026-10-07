// home-layer 的行为测试：vm + 最小 DOM 桩，真跑一遍覆盖层逻辑（不引入任何依赖）。
//
// 覆盖：默认显示（全屏 position:fixed、挂进 .app-root、吃掉指针事件）/「进入线上」先隐藏再按序调
//       setServer('auto') → setAutostart() / 桥缺失时不抛错且按钮禁用并给出原因 / __SP_HOME
//       show/hide/visible 三件套 / 本地服务轮询与「进入」文案（含 Java 的 "0"/"1" 字符串形态）/
//       面板按钮不隐藏层且走 openPanel(kind) / 幂等（跑两次只有一个层、观察器与监听不重复）/
//       兜底探测（隐藏着但标题屏出现 → show；suppress 标记 → 不 show、可解除）/
//       离开首页态自动收起、回来自动盖上 / 观察器合并窗口 / 壳加载器只从 /__sp/ 取 /
//       源码不变量（无页面模块、无网络、无新语法）。
// v7 新增：七个导航项（含检查更新）文案 / 检查更新走 __SP_SHELL.checkUpdate / 访客数区块
//       （__SP_LOBBY.visitorsCached，无缓存显示 --）/ 传输区块只读分段 + 「打开参数面板」走桥 /
//       服务器网格点格的进入时序与状态机不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'home-layer.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-bridge.js'), 'utf8');

/** 真事件的样子：带传播控制（"吃掉指针事件"的断言要能看出有没有拦住冒泡）。 */
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
    style: {},
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
  };
  return el;
}

/**
 * 一次"页面"：html/head/body/.app-root + 可开合的标题屏特征（首页态）+ 手动计时器 + 观察器记录。
 * 手动计时器（不落真实事件循环）让"60ms 合并窗口 / 500ms 轮询"在测试里完全确定，进程也不会被挂住。
 */
function mkWorld(opts = {}) {
  const observers = [];
  const created = [];
  const timers = [];
  const markers = new Set();
  let tid = 0;
  let queries = 0;
  let marks = 0;                                   // 只数"首页态特征"的那些查询

  const htmlEl = mkEl('html');
  const head = mkEl('head');
  const body = mkEl('body');
  const appRoot = mkEl('div', body);
  body.appendChild(appRoot);
  const titleNode = mkEl('div', appRoot);          // 上传方标题屏（只在标记开启时"存在"）

  function setTitle(present) {
    if (present) markers.add('.title-screen');
    else markers.delete('.title-screen');
  }
  if (opts.title !== false) setTitle(true);

  const document = {
    readyState: 'complete',
    documentElement: htmlEl,
    head,
    body,
    createElement(tag) { const el = mkEl(tag); created.push(el); return el; },
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) {
      queries += 1;
      if (sel === '.app-root') return opts.appRoot === false || !appRoot.parentNode ? null : appRoot;
      marks += 1;
      return markers.has(sel) ? titleNode : null;
    },
  };

  function setTimeoutStub(fn, ms) {
    const t = { id: ++tid, fn, ms: ms || 0, done: false, cleared: false };
    timers.push(t);
    return t.id;
  }
  function clearTimeoutStub(id) {
    const t = timers.find((x) => x.id === id);
    if (t) t.cleared = true;
  }
  /** 跑若干轮"已到期"的定时器：轮询自身会补下一次，所以给定轮数上限。 */
  function flushTimers(rounds = 4) {
    for (let r = 0; r < rounds; r++) {
      for (const t of timers) {
        if (!t.done && !t.cleared) { t.done = true; t.fn(); }
      }
    }
  }

  return {
    document, htmlEl, head, body, appRoot, observers, created,
    setTitle,
    fireObserver() { observers.forEach((o) => o.fn()); },
    flushTimers, setTimeout: setTimeoutStub, clearTimeout: clearTimeoutStub,
    queries: () => queries,
    marks: () => marks,
    /** 覆盖层节点（按 id 找；桩不做 CSS 选择器） */
    layer: () => created.filter((e) => e.getAttribute('id') === 'sp-home-layer'),
    /** 层里的按钮（按 data-sp-home-btn 找） */
    btn: (act) => created.find((e) => e.getAttribute('data-sp-home-btn') === act) || null,
    hint: () => created.find((e) => e.getAttribute('data-sp-home-hint') !== null) || null,
    /** v7 布局的节点探针 */
    srv: () => created.find((e) => e.getAttribute('data-sp-home-srv') !== null) || null,
    grid: () => created.find((e) => e.getAttribute('data-sp-home-grid') !== null) || null,
    board: () => created.find((e) => e.getAttribute('data-sp-home-board') !== null) || null,
    cell: (id) => created.find((e) => e.getAttribute('data-sp-home-cell') === id) || null,
    transportBox: () => created.find((e) => e.getAttribute('data-sp-home-transport') !== null) || null,
    transportHint: () => created.find((e) => e.getAttribute('data-sp-home-transport-hint') !== null) || null,
    seg: (id) => created.find((e) => e.getAttribute('data-sp-home-seg') === id) || null,
    edit: () => created.find((e) => e.getAttribute('data-sp-home-edit') !== null) || null,
    visitors: () => created.find((e) => e.getAttribute('data-sp-home-visitors') !== null) || null,
    version: () => created.find((e) => e.getAttribute('data-sp-home-version') !== null) || null,
  };
}

/** 跑一遍脚本。传同一个 win 可以跑第二遍 —— 幂等测试要的就是"同一个 window 重复注入"。 */
function run(world, opts = {}) {
  const win = opts.win || {};
  if (opts.shell) win.shell = opts.shell;
  if (opts.spShell) win.__SP_SHELL = opts.spShell;
  const sandbox = {
    window: win,
    document: world.document,
    MutationObserver: class { constructor(fn) { world.observers.push({ fn }); } observe() {} },
    setTimeout: world.setTimeout,
    clearTimeout: world.clearTimeout,
    console,
  };
  win.document = world.document;
  vm.runInNewContext(SRC, sandbox, { filename: 'home-layer.js' });
  return win;
}

/** 两个"进入游戏"的进入目标都齐的桥（多数用例的基线）。 */
function fullShell(calls) {
  return {
    setServer(u) { calls.push({ name: 'setServer', url: u }); },
    setAutostart() { calls.push({ name: 'setAutostart' }); },
  };
}

test('默认显示：层挂进 .app-root、全屏 position:fixed、吃掉指针事件', () => {
  const w = mkWorld();
  const win = run(w);
  const layer = w.layer();
  assert.equal(layer.length, 1, '必须只有一个覆盖层');
  const style = layer[0].getAttribute('style');
  assert.ok(style.indexOf('position:fixed') >= 0, '必须是 fixed 覆盖层：' + style);
  assert.ok(style.indexOf('inset:0') >= 0 && style.indexOf('top:0') >= 0
    && style.indexOf('right:0') >= 0 && style.indexOf('bottom:0') >= 0 && style.indexOf('left:0') >= 0,
    'inset:0 与四边 longhand 兜底都要有：' + style);
  assert.ok(style.indexOf('z-index:70') >= 0, '挂 .app-root 时用 70：盖住首页(--z-screen=1)、低于面板(--z-modal=80)');
  assert.ok(style.indexOf('pointer-events:auto') >= 0, '必须吃掉指针事件');
  assert.equal(layer[0].parentNode, w.appRoot, '必须挂在 .app-root 里（页面自己的面板才能弹在层上面）');
  assert.equal(layer[0].style.display, '', '默认就是显示的');
  assert.equal(win.__SP_HOME.visible(), true, '默认 visible() 为真');
});

test('「进入线上」：先 hide()，再按序 setServer(\'auto\') → setAutostart()', () => {
  const w = mkWorld();
  const calls = [];
  const holder = {};
  const shell = {
    setServer(u) { calls.push({ name: 'setServer', url: u, visible: holder.win.__SP_HOME.visible() }); },
    setAutostart() { calls.push({ name: 'setAutostart', visible: holder.win.__SP_HOME.visible() }); },
  };
  holder.win = run(w, { shell });
  assert.equal(holder.win.__SP_HOME.visible(), true);
  w.btn('online').click();
  assert.deepEqual(calls.map((c) => c.name), ['setServer', 'setAutostart'], '两个桥都必须按序调到');
  assert.equal(calls[0].url, 'auto', '自动线路');
  assert.equal(calls[0].visible, false, 'hide() 必须先于 setServer 生效');
  assert.equal(calls[1].visible, false, 'setAutostart 时层同样是收起的');
  assert.equal(holder.win.__SP_HOME.visible(), false, '点「进入游戏」后层必须让开');
});

test('本地服务：先隐藏、起服务并轮询，就绪后按钮变「进入」', () => {
  const w = mkWorld();
  let ready = false;
  const started = [];
  const spShell = {
    startLocalService() { started.push(1); return true; },
    localServiceReady() { return ready; },
  };
  const win = run(w, { spShell });
  const b = w.btn('local');
  assert.equal(b.textContent, '本地服务', '未就绪时是「本地服务」');
  b.click();
  assert.equal(started.length, 1, '点击必须调 startLocalService');
  assert.equal(win.__SP_HOME.visible(), false, '进游戏前必须先让开');
  assert.equal(b.textContent, '启动中…', '轮询期间显示启动中');
  ready = true;
  w.flushTimers();
  assert.equal(b.textContent, '进入', '就绪后按钮变「进入」');
  assert.equal(b.disabled, false);
});

test('window.shell.localServiceReady 的 "1"/"0" 字符串都判对（v4.2 教训：!!"0" 会假就绪）', () => {
  const w1 = mkWorld();
  run(w1, { shell: { startLocalService() {}, localServiceReady: () => '1' } });
  assert.equal(w1.btn('local').textContent, '进入', '"1" = 就绪');
  const w0 = mkWorld();
  run(w0, { shell: { startLocalService() {}, localServiceReady: () => '0' } });
  assert.equal(w0.btn('local').textContent, '本地服务', '"0" 绝不能判成就绪');
});

test('桥缺失：不抛错、按钮禁用并给出原因、点击什么都不做', () => {
  const w = mkWorld();
  let win = null;
  assert.doesNotThrow(() => { win = run(w); });
  assert.equal(win.__SP_HOME.visible(), true, '桥缺失不影响层本身的显示');
  for (const act of ['local', 'online', 'lobby', 'params', 'config', 'records', 'update']) {
    const b = w.btn(act);
    assert.ok(b, act + ' 按钮必须存在');
    assert.equal(b.disabled, true, act + ' 必须被禁用');
    const reason = b.getAttribute('data-sp-home-why');
    assert.ok(reason && reason.length > 0, act + ' 必须给出禁用原因');
    assert.equal(b.getAttribute('title'), reason, '原因也要挂在 title 上');
    assert.doesNotThrow(() => b.click(), act + ' 点击不许抛错');
  }
  assert.ok(/不可用/.test(w.hint().textContent), '提示行必须写出原因：' + w.hint().textContent);
});

test('__SP_HOME 三件套：show()/hide()/visible() 语义正确（Java 返回键的入口）', () => {
  const w = mkWorld();
  const win = run(w);
  const api = win.__SP_HOME;
  assert.equal(typeof api.show, 'function', 'Java 侧返回键要能调 show()');
  assert.equal(typeof api.hide, 'function');
  assert.equal(api.visible(), true);
  api.hide();
  assert.equal(api.visible(), false);
  assert.equal(w.layer()[0].style.display, 'none', '隐藏时 display:none');
  assert.equal(w.layer()[0].getAttribute('data-sp-home'), 'off');
  api.show();
  assert.equal(api.visible(), true);
  assert.equal(w.layer()[0].style.display, '', '显示时恢复');
  assert.equal(typeof win.__SP_HOME_LAYER_SWEEP, 'function', '强制重扫入口（调试 / 其它外壳模块）');
});

test('面板按钮：层不隐藏，四个入口都走 __SP_SHELL.openPanel(kind)', () => {
  const w = mkWorld();
  const panels = [];
  const win = run(w, { spShell: { openPanel: (k) => panels.push(k) } });
  const pairs = [['lobby', 'lobby'], ['params', 'params'], ['config', 'config'], ['records', 'records']];
  for (const [act, kind] of pairs) {
    assert.equal(w.btn(act).disabled, false, act + ' 有桥就该可用');
    w.btn(act).click();
  }
  assert.deepEqual(panels, ['lobby', 'params', 'config', 'records'], 'kind 必须原样传给面板');
  assert.equal(win.__SP_HOME.visible(), true, '开面板不许把层藏起来（面板 z-index 更高，在层上面）');
});

test('幂等：脚本跑两次只有一个覆盖层、观察器与监听都不重复', () => {
  const w = mkWorld();
  const win = {};
  const calls = [];
  const shell = fullShell(calls);
  run(w, { win, shell });
  const createdFirst = w.created.length;
  run(w, { win, shell });                          // 同一个 window 再注入一次
  assert.equal(win.__SP_HOME_LAYER, 1, '守卫标记');
  assert.equal(w.layer().length, 1, '重复注入只许有一个层');
  assert.equal(w.observers.length, 1, '观察器只注册一次');
  assert.equal(w.created.length, createdFirst, '第二次注入不许再建任何节点');
  w.btn('online').click();
  assert.equal(calls.length, 2, '监听不许翻倍（翻倍会调 4 次）');
});

test('兜底探测：隐藏着但标题屏出现 → show()；suppress 标记 → 不 show（可解除）', () => {
  const w = mkWorld({ title: false });             // 起始不在首页（例如对局里重载）
  const win = run(w, { shell: fullShell([]) });
  assert.equal(win.__SP_HOME.visible(), false, '没有标题屏特征 = 不当首页 = 不显示（宁可少盖）');
  win.__SP_HOME.hide();
  w.setTitle(true);                                // 上传方标题屏出现（回首页 / 页面重载）
  w.fireObserver();
  w.flushTimers();
  assert.equal(win.__SP_HOME.visible(), true, '隐藏着但首页态出现 → 兜底 show()');
  // suppress = 用户"我想看对方首页"
  win.__SP_HOME.hide();
  assert.equal(win.__SP_HOME.suppress(), false, '不加参数 = 读当前值');
  win.__SP_HOME.suppress(true);
  assert.equal(w.htmlEl.getAttribute('data-sp-home-suppress'), '1', '标记写在 html 上');
  assert.equal(win.__SP_HOME.visible(), false, 'suppress 时立刻让开');
  w.fireObserver();
  w.flushTimers();
  assert.equal(win.__SP_HOME.visible(), false, 'suppress 期间兜底探测必须失效（不与用户意图打架）');
  win.__SP_HOME.suppress(false);
  assert.equal(win.__SP_HOME.visible(), true, '解除 suppress → 首页态还在 → 自动盖上');
});

test('离开首页态自动收起、回来自动盖上（意图不变，绝不盖住玩法界面）', () => {
  const w = mkWorld();
  const win = run(w, { shell: fullShell([]) });
  assert.equal(win.__SP_HOME.visible(), true);
  w.setTitle(false);                               // 例如 autostart 自动进入对局：标题屏卸载
  w.fireObserver();
  w.flushTimers();
  assert.equal(win.__SP_HOME.visible(), false, '标题屏一卸载就收起');
  w.setTitle(true);                                // 返回键回首页
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
  assert.equal(w.marks() - before, 1, '20 次变更只能触发 1 次扫描（且首页态探测命中第一个特征即返回）');
  assert.equal(win.__SP_HOME.visible(), true);
});

test('拿不到 .app-root：退到 body 挂载并用大 z-index（面板桥一般也不在，按钮自动禁用）', () => {
  const w = mkWorld({ appRoot: false });
  const win = run(w, { shell: fullShell([]) });
  const layer = w.layer();
  assert.equal(layer.length, 1);
  assert.equal(layer[0].parentNode, w.body, '没有 .app-root 就挂 body');
  assert.equal(layer[0].style.zIndex, '2147482000', '挂 body 才用大 z-index');
  assert.equal(win.__SP_HOME.visible(), true, '层本身照常显示');
  assert.equal(w.btn('lobby').disabled, true, '没有 openPanel 桥 → 面板按钮禁用');
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

test('v7 布局：七个导航项都存在且文案正确', () => {
  const w = mkWorld();
  const win = run(w, { shell: fullShell([]), spShell: { openPanel() {}, checkUpdate() {} } });
  const want = {
    local: '本地服务', online: '进入线上', lobby: '大厅', params: '参数',
    config: '配置', records: '战绩', update: '检查更新',
  };
  for (const act of Object.keys(want)) {
    const b = w.btn(act);
    assert.ok(b, act + ' 导航项必须存在');
    assert.equal(b.textContent, want[act], act + ' 文案必须是「' + want[act] + '」');
    assert.equal(b.disabled, false, act + ' 桥齐时必须可用');
  }
  assert.ok(w.srv(), 'hero 当前服务器大字节点必须存在');
  assert.ok(w.srv().textContent.length > 0, 'hero 大字必须有内容');
  assert.ok(w.grid(), '服务器切换网格必须存在');
  assert.ok(w.board(), '线路延迟榜必须存在');
  assert.ok(w.version(), '右下角版本号必须存在');
  assert.ok(w.version().textContent.indexOf('v7') >= 0, '版本号要带层版本标记：' + w.version().textContent);
});

test('检查更新：走 __SP_SHELL.checkUpdate 桥，且不隐藏层', () => {
  const w = mkWorld();
  const calls = [];
  const win = run(w, { spShell: { openPanel() {}, checkUpdate() { calls.push(1); } } });
  assert.equal(win.__SP_HOME.visible(), true);
  w.btn('update').click();
  assert.equal(calls.length, 1, '必须调 __SP_SHELL.checkUpdate 桥');
  assert.equal(win.__SP_HOME.visible(), true, '检查更新不隐藏层（刷新 / 升级由桥接管）');
});

test('访客数：渲染 __SP_LOBBY.visitorsCached 的值；无缓存显示 --', () => {
  const w1 = mkWorld();
  run(w1, { win: { __SP_LOBBY: { visitorsCached: () => 42 } } });
  assert.ok(w1.visitors(), '访客数节点必须存在');
  assert.ok(w1.visitors().textContent.indexOf('访客') >= 0, '要带「访客」标签：' + w1.visitors().textContent);
  assert.ok(w1.visitors().textContent.indexOf('42') >= 0, '要显示缓存值 42：' + w1.visitors().textContent);
  const w2 = mkWorld();
  run(w2, { win: { __SP_LOBBY: { visitorsCached: () => null } } });
  assert.ok(w2.visitors().textContent.indexOf('--') >= 0, '无缓存时显示 --：' + w2.visitors().textContent);
  const w3 = mkWorld();
  assert.doesNotThrow(() => run(w3), '没有 __SP_LOBBY 也不许抛错');
  assert.ok(w3.visitors().textContent.indexOf('--') >= 0, '没有 lobby 模块时也显示 --');
});

test('传输区块：只读分段展示当前档，「打开参数面板」走 openPanel 桥', () => {
  const w = mkWorld();
  const panels = [];
  const shell = fullShell([]);
  shell.getTransport = () => 'lan';
  shell.setTransport = () => true;
  run(w, { shell, spShell: { openPanel: (k) => panels.push(k) } });
  assert.ok(w.transportBox(), '传输分段容器必须存在');
  assert.equal(w.seg('lan').getAttribute('aria-checked'), 'true', '当前档 lan 必须高亮');
  assert.equal(w.seg('auto').getAttribute('aria-checked'), 'false', '其它档不亮');
  assert.equal(w.seg('lan').disabled, true, '分段在本层是只读展示（编辑归参数面板）');
  w.edit().click();
  assert.deepEqual(panels, ['params'], '「打开参数面板」必须走 __SP_SHELL.openPanel(\'params\')');
  assert.equal(w.seg('lan').getAttribute('aria-checked'), 'true', '开面板不许影响层（面板 z-index 更高）');
  // 旧壳（无 getTransport/setTransport 成对桥）：按不支持处理 —— auto 高亮 + 需更新提示可见
  const w2 = mkWorld();
  run(w2, { shell: fullShell([]) });
  assert.equal(w2.seg('auto').getAttribute('aria-checked'), 'true', '不支持时回落到 auto');
  assert.equal(w2.transportHint().style.display, '', '旧壳要显示「需更新 APK 后生效」');
});

test('服务器网格：点「自动线路」格 = 先隐藏再 setServer(\'auto\')→setAutostart()（状态机不变）', () => {
  const w = mkWorld();
  const calls = [];
  const holder = {};
  const shell = {
    setServer(u) { calls.push({ name: 'setServer', url: u, visible: holder.win.__SP_HOME.visible() }); },
    setAutostart() { calls.push({ name: 'setAutostart', visible: holder.win.__SP_HOME.visible() }); },
  };
  holder.win = run(w, { shell });
  const cell = w.cell('auto');
  assert.ok(cell, '自动线路格必须存在');
  cell.click();
  assert.deepEqual(calls.map((c) => c.name), ['setServer', 'setAutostart'], '与「进入线上」同一时序');
  assert.equal(calls[0].url, 'auto');
  assert.equal(calls[0].visible, false, '点格后同样先让开');
  assert.equal(holder.win.__SP_HOME.visible(), false, '点格后层必须收起');
  holder.win.__SP_HOME.show();
  assert.equal(holder.win.__SP_HOME.visible(), true, 'show() 恢复显示（状态机不变）');
});

test('源码不变量：无页面模块、无网络、无新语法、无凭据字面量', () => {
  assert.ok(!/import\s*\(/.test(SRC), '不许动态 import');
  assert.ok(!/\bfrom\s+['"]/.test(SRC), '不许静态 import');
  assert.ok(SRC.indexOf('/js/ui/') < 0 && SRC.indexOf('/vendor/') < 0 && SRC.indexOf('/js/') < 0,
    '不许出现页面的模块路径');
  assert.ok(!/https?:\/\//.test(SRC), '不许出现 URL 字面量（本增量零网络请求）');
  assert.ok(!/fetch\s*\(|XMLHttpRequest|WebSocket|EventSource/.test(SRC), '不许出现任何网络请求入口');
  assert.ok(SRC.indexOf('?.') < 0, '不许可选链');
  assert.ok(SRC.indexOf('??') < 0, '不许空值合并');
  assert.ok(SRC.indexOf('replaceAll') < 0, '不许 replaceAll');
  assert.ok(SRC.indexOf('password') < 0 && SRC.indexOf('token') < 0 && SRC.indexOf('secret') < 0,
    '不许出现凭据字面量');
  assert.ok(SRC.indexOf('window.shell') >= 0 || SRC.indexOf('__SP_SHELL') >= 0, '只走外壳桥（上面几条的对照组）');
});
