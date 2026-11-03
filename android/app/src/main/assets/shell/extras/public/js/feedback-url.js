/* global window, document, MutationObserver */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here
// feedback-url.js -- 把游戏内「问题反馈」里显示的 issue 地址改指本 fork 的仓库（运行时替换，不改上游）。
//
// 为什么不直接改上游：js/ui/settings.js 里导出一个地址常量
//   ISSUES_URL = 'https://github.com/sganggs/Stronghold-Protocol/issues'
// 它被渲染成设置弹窗里的 <span class="set-diag__url">（显示时去掉 https:// 前缀）。
// 但 webroot 是 build-webroot.mjs 的构建产物（extras/public/* 在 copyExtras 阶段覆盖上去），
// 直接改上游文件下一次构建就被冲掉；线上 patch 集又是刻意清零的（文本锚点会跟上游版本漂移）。
// 所以改在这一层：只碰运行时 DOM，上游文件一个字节都不动，且随 extras 一起热更。
//
// 为什么用 MutationObserver：设置弹窗是打开时才渲染的（Preact 组件），本脚本可能在它出现之前就
// 跑完，所以不能只做一次性替换；也不能高频轮询——观察 + 60ms 合并调度 + 「值已正确就跳过」，
// 弹窗不开时等于零成本，弹窗内重复渲染也只会各改一次。
//
// 幂等：window.__SP_FEEDBACK_URL 守卫重复执行；目标元素不存在就静默返回；整体 try/catch，绝不抛。
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__SP_FEEDBACK_URL) return;

  // 上游写法：显示时去掉 'https://' 前缀（见 settings.js 的 replace），这里保持同样的显示风格。
  // 旧地址 github.com/sganggs/Stronghold-Protocol/issues：href 用小写子串做快速筛，替换用 /gi 正则。
  var OLD_LOW = 'github.com/sganggs/stronghold-protocol/issues';
  var NEW = 'github.com/jingjiangze/Stronghold-Protocol/issues';
  var OLD_RE = /github\.com\/sganggs\/Stronghold-Protocol\/issues/gi;

  var scheduled = false;
  var started = false;

  /** 改显示文本：只改已有 text node 的值，不替换节点 —— Preact 手里还握着这个节点的引用，
   *  换节点会让它下一次 diff 出错（弹窗里任何一次重渲染都可能踩到）。 */
  function fixText(el) {
    if (!el) return;
    var node = el.firstChild;
    if (node && node.nodeType === 3) {
      if (node.nodeValue !== NEW) node.nodeValue = NEW;
      return;
    }
    // 没有 text node（理论上不会有）：整体写入，值相同就跳过，避免自己触发自己。
    if (el.textContent !== NEW) el.textContent = NEW;
  }

  /** 指向旧仓库的链接一并改掉（保留 scheme 与后面的 query/fragment）。 */
  function fixHref(a) {
    var href = a && a.getAttribute ? a.getAttribute('href') : null;
    if (!href || href.toLowerCase().indexOf(OLD_LOW) < 0) return;
    var next = href.replace(OLD_RE, NEW);
    if (next !== href) a.setAttribute('href', next);
  }

  function sweep() {
    var i;
    try {
      var urls = document.querySelectorAll('.set-diag__url');
      for (i = 0; i < urls.length; i++) fixText(urls[i]);
      // 属性子串选择器：只在真有这条链接时才枚举，避免每批 DOM 变动扫全页的 <a>。
      var links = document.querySelectorAll('a[href*="Stronghold-Protocol"]');
      for (i = 0; i < links.length; i++) fixHref(links[i]);
    } catch (e) { /* 选择器/属性不可用：地址保持上游原样，不影响游戏 */ }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      try { sweep(); } catch (e) { /* 单次扫描失败不排下一轮，等下一次 DOM 变动 */ }
    }, 60);
  }

  function start() {
    if (started) return;
    started = true;
    try {
      var root = document.body || document.documentElement;
      if (!root) return;
      var mo = new MutationObserver(schedule);
      mo.observe(root, { childList: true, subtree: true, characterData: true });
    } catch (e) { /* 老引擎没有 MutationObserver：退化成下面这一次性替换 */ }
    schedule();
  }

  try {
    window.__SP_FEEDBACK_URL = { url: 'https://' + NEW, installed: true };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, false);
  } catch (e) { /* 任何异常都不影响页面 */ }
})();
