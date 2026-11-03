/* global window */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so window is declared here
// crash-report.js -- 页面侧的崩溃/致命错误捕获，交给原生桥上报（只在 APK 内生效）。
//
// 为什么在页面侧抓：WebView 里的 JS 崩溃（未捕获异常 / 未处理的 Promise 拒绝）只发生在页面进程，
// Java 侧拿不到堆栈；页面是最早知道「哪里炸了」的地方，而且此刻页面通常还活着，可以立刻把消息
// 交给原生。本文件不碰网络、不碰磁盘、不读任何玩家数据——window.shell.reportWebViewCrash(message,
// stack)（MainActivity 注入的桥）负责落盘/加密/上报。
//
// 为什么只报致命：设置面板里的「已记录的错误」是给玩家看的东西，噪音一多就没人看。资源加载失败
// （CDN 抖动 / 离线）、被 AbortError 打断的请求、localStorage 配额报错都不是崩溃，每次都上报只会
// 把真正的崩溃冲掉。所以这里只留「代码炸了」这一类，并做同 message 去重。
//
// 为什么 ES5 + 全程 try/catch：这段代码和崩溃现场跑在同一个（可能很旧的）WebView 里，它自己绝不能
// 成为新的崩溃源——上报器抛错就静默放弃：崩溃信息丢了，也不能把页面再炸一次。
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  // 只在 APK 内生效：判据与 shell-bridge.js 的 NATIVE 一致（window.shell 由 MainActivity 注入）。
  // 没有 reportWebViewCrash 的老壳直接不装监听器，等于本文件不存在。
  var bridge = window.shell;
  if (!bridge || typeof bridge.reportWebViewCrash !== 'function') return;
  if (window.__SP_CRASH_REPORT) return;

  var MSG_MAX = 300;
  var STACK_MAX = 2000;
  var SEEN_MAX = 50;

  // 老 WebView 不保证有 Set：用普通对象当去重表 + FIFO 队列做上限（语义与「Set + 丢最旧」等价）。
  var seen = {};
  var seenOrder = [];

  // 明确不算崩溃的噪音（小写子串匹配，只用于**兜底**——真正的判据是下面 isFatal 的类型/名字判断）。
  // 验收 §Q6：原先只靠这张文本黑名单，方向是错的（漏 WebGL 丢上下文/跨源 Script error，
  // 误报 Failed to fetch）。现在改成「先看错误类型与名字，再看文本」。
  var NOISE = ['failed to load resource', 'networkerror', 'failed to fetch', 'load failed',
    'quota', 'signal is aborted'];
  // Promise 拒绝里「正常的取消」：按 reason.name 判，不按 message 文本判（§Q6 指出 AbortError
  // 的名字在 name 上，原来读 message 所以过滤不掉）。
  var BENIGN_NAMES = { AbortError: 1, NotAllowedError: 1 };
  // 致命错误的类型白名单：这些**不看文本、不看栈**，一律上报。
  // WebGLError 是 onContextLost 自己造的名字（GPU 上下文丢失不会有 stack），必须在这里，
  // 否则 isFatal 的「无栈即噪音」分支会把它挡掉（第二轮验收 §8 实测 reported=[]）。
  var FATAL_NAMES = { RangeError: 1, InternalError: 1, WebGLError: 1 };

  function cut(s, max) {
    s = String(s === null || s === undefined ? '' : s);
    return s.length > max ? s.slice(0, max) : s;
  }

  function isNoise(message) {
    var low = String(message || '').toLowerCase();
    for (var i = 0; i < NOISE.length; i++) {
      if (low.indexOf(NOISE[i]) >= 0) return true;
    }
    return false;
  }

  /**
   * 是否致命。判据顺序：① 显式致命类型/名字 → 报；② 良性名字 → 不报；③ 有栈才算「真异常」；
   * ④ 最后用文本黑名单兜底削掉网络类噪音。
   * 跨源脚本错误的 message 会退化成 "Script error."（无 error 对象无栈）——这种**要报**，
   * 因为它意味着某个脚本崩了但我们看不到细节，正是需要人看的信号。
   */
  function isFatal(name, message, stack) {
    var nm = String(name || '');
    if (FATAL_NAMES[nm]) return true;
    if (BENIGN_NAMES[nm]) return false;
    var msg = String(message || '');
    // 跨源脚本：message 恰为 'Script error.' 且无栈 → 仍上报（去掉 @file:line 后缀再比）
    if (/^script error\.?/i.test(msg)) return true;
    if (!stack && isNoise(msg)) return false;
    if (!stack) return false;                 // 无栈 + 非致命类型 = 资源类噪音
    return !isNoise(msg);
  }

  /** 同一 message 只报一次；超过上限丢最旧的，避免长跑页面把内存耗在去重表上。 */
  function remember(message) {
    if (seen[message]) return false;
    seen[message] = 1;
    seenOrder.push(message);
    if (seenOrder.length > SEEN_MAX) {
      var old = seenOrder.shift();
      try { delete seen[old]; } catch (e) { /* 不可删就留着，最多是多挡一条 */ }
    }
    return true;
  }

  function where(file, line, col) {
    if (!file) return '';
    var tail = file + (line ? ':' + line + (col ? ':' + col : '') : '');
    return ' @ ' + tail;
  }

  function report(name, message, stack) {
    try {
      var msg = cut(message, MSG_MAX);
      if (!msg) return;
      if (!isFatal(name, msg, cut(stack, STACK_MAX))) return;
      if (!remember(msg)) return;
      bridge.reportWebViewCrash(msg, cut(stack, STACK_MAX));
    } catch (e) { /* 上报失败静默：崩溃信息丢了也不能影响页面 */ }
  }

  /** 未捕获异常。裸 error 事件（无 error 对象、也无栈，典型是资源 404）按噪音处理，不报。 */
  function onError(ev) {
    try {
      if (!ev) return;
      var err = ev.error;
      var stack = err && err.stack ? err.stack : '';
      var name = err && err.name ? err.name : '';
      var message = ev.message || (err && err.message) || '';
      // 跨源脚本错误：无 error 对象、message 为 'Script error.'、无栈——仍然要报（§Q6）。
      report(name, String(message) + where(ev.filename, ev.lineno, ev.colno), stack);
    } catch (e) { /* 监听器自身绝不抛 */ }
  }

  /** 未处理的 Promise 拒绝：reason 可能是 Error、字符串或任意对象。 */
  function onRejection(ev) {
    try {
      if (!ev) return;
      var reason = ev.reason;
      var name = '';
      var message = '';
      var stack = '';
      if (reason && typeof reason === 'object') {
        name = reason.name || '';
        message = reason.message || '';
        stack = reason.stack || '';
        if (!message && !stack) {
          try { message = String(reason); } catch (e2) { message = 'unhandledrejection'; }
        }
      } else {
        message = reason === null || reason === undefined ? 'unhandledrejection' : String(reason);
      }
      if (!message && !stack) return;
      report(name, message || 'unhandledrejection', stack);
    } catch (e) { /* 同上 */ }
  }

  /**
   * WebGL 上下文丢失：这不是 window.onerror 事件，原来完全收不到（§Q6 指出
   * scene.js:131 的 _onLost 只是 e.preventDefault() + this.lost = true，静默吞掉）。
   * 这里在捕获阶段挂一个全局监听，把它当作致命错误上报。
   */
  function onContextLost(ev) {
    try {
      var t = ev && ev.target;
      var tag = t && t.tagName ? String(t.tagName).toLowerCase() : 'canvas';
      report('WebGLError', 'webglcontextlost on <' + tag + '>（GPU 上下文丢失，渲染会黑屏）', '');
    } catch (e) { /* 同上 */ }
  }

  try {
    window.addEventListener('error', onError, false);
    window.addEventListener('unhandledrejection', onRejection, false);
    // webglcontextlost 不冒泡，必须用捕获阶段挂到 window 上才能收到所有 canvas 的。
    window.addEventListener('webglcontextlost', onContextLost, true);
    // 幂等标记：本文件被重复注入时不再装第二套监听器。
    window.__SP_CRASH_REPORT = { installed: true };
  } catch (e) { /* 没有 addEventListener 的老引擎：什么都不装，等价于本文件不存在 */ }
})();
