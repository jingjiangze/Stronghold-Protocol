/* global window */ // 浏览器全局：extras 源码在 tools 树里（ESLint node 预设覆盖），window 在此声明
// js/ui/modsLoader.js — mod 装载器的**客户端侧**（v1，业主 2026-10-11）。
//
// 它做什么（页面加载时跑一次，不抛、幂等）：
//   ① 读本机 `/sp/mods/loader`：哪些包启用了、各自带什么（A 层内容种类 / 主题变量 / 代码入口 / 面板数）；
//   ② 把启用包的**主题变量**（client.theme.vars）注入成一张 <style>（`:root{…}`），这是声明式的东西，
//      注入即可生效，不需要任何上游接缝；
//   ③ 把结果挂到 window.__SP_MODS_LOADER，并派发 `sp-mods-loaded` 事件 —— 面板据此显示「本局生效了
//      什么」，也据此提示「热重载 / 重开 APK」。
//
// 为什么不注入 client.panels（本版明确不做，别把它当已实现）：
//   面板包（如 net-panel）声明的是 Forge 的**面板槽契约**（`slot: "screen.game.aside"` + `module` +
//   `styles`），模块本身按 Forge 的 ctx API 写（`ctx.net.status()` 之类）。我们这条线上游树里**没有**
//   那些槽宿主，也没有那份 ctx —— 硬注入只会得到「模块加载了、什么都不显示」。要真支持得先把 Forge 的
//   面板槽/包装组件两条接缝搬过来（见 docs/MOD-SURFACE.md 与 MOD-SURFACE 的九槽表），那是独立一轮。
//   同理 server / kits / routes 三个代码入口本版只装不跑。面板把这些如实标成「含代码 · 本版只装不跑」。
//
// 只在**本机页面**上跑：服务器页面上的 /sp/mods/* 是那台服务器的（我们的控制面也只答环回来源），
// 与其发一轮注定 403 的请求，不如什么都不做。
(function () {
  var win = (typeof window !== 'undefined' && window) ? window
    : (typeof globalThis === 'undefined' ? null : globalThis);
  if (!win || win.__SP_MODS_LOADER_READY) return;
  var doc = win.document;
  if (!doc || typeof doc.createElement !== 'function') return;
  var loc = win.location || {};
  var host = String(loc.hostname || '').toLowerCase();
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') return; // 非本机页面：什么都不做
  win.__SP_MODS_LOADER_READY = true;

  var THEME_STYLE_ID = 'sp-mods-theme';

  /** 客户端认得的 `/sp/mods/loader` 响应世代；必须与 tools/apk/overlay/sp-mods.mjs 的 LOADER_API 一致。 */
  var LOADER_API = 1;

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /** 主题变量 → 一张 :root 表。键必须是 `--` 开头的 CSS 自定义属性（别的一律忽略，防注入别的选择器）。 */
  function themeCss(vars) {
    if (!isPlainObject(vars)) return '';
    var out = '';
    var keys = Object.keys(vars);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf('--') !== 0) continue;
      var v = vars[k];
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      var s = String(v);
      // 值里不许出现 `}`/`;` 之外的注入面：只允许常见的颜色/长度/字体栈字符。
      if (!/^[#a-zA-Z0-9 .,%()'"_-]+$/.test(s)) continue;
      out += k + ':' + s + ';';
    }
    return out ? ':root{' + out + '}' : '';
  }

  function applyThemes(packs) {
    var css = '';
    for (var i = 0; i < packs.length; i++) {
      var t = packs[i] && packs[i].theme;
      if (t && isPlainObject(t.vars)) css += themeCss(t.vars);
    }
    var head = doc.head || doc.documentElement;
    if (!head) return '';
    var el = null;
    try { if (typeof doc.getElementById === 'function') el = doc.getElementById(THEME_STYLE_ID); } catch (e) { el = null; }
    if (!css) {
      if (el && el.parentNode) { try { el.parentNode.removeChild(el); } catch (e) { /* ignore */ } }
      return '';
    }
    if (!el) {
      try {
        el = doc.createElement('style');
        el.setAttribute('id', THEME_STYLE_ID);
        head.appendChild(el);
      } catch (e) { return ''; }
    }
    try { el.textContent = css; } catch (e) { /* ignore */ }
    return css;
  }

  function run() {
    var url = '/sp/mods/loader';
    var pr = null;
    try { pr = win.fetch(url, { cache: 'no-store' }); } catch (e) { pr = null; }
    if (!pr || typeof pr.then !== 'function') return;
    pr.then(function (r) {
      if (!r || r.ok !== true) return null;
      return r.json();
    }).then(function (doc2) {
      if (!doc2 || typeof doc2 !== 'object') return;
      // 版本握手（2026-10-12）：热更只覆盖同名文件、删不掉旧文件 ⇒ 两端可能短暂错配
      // （Updater 也可能在版本不一致时退回 APK 内嵌的旧覆盖层）。
      // 只在**服务端比我们新**时退回「未生效」——它发的字段我们可能读不懂。
      // 缺 loaderApi（= 旧版服务端）照旧处理：v1 只加字段，旧响应里我们要读的那几个形状没变，
      // 拒掉只会白白把本来能生效的包显示成未生效。
      if (typeof doc2.loaderApi === 'number' && doc2.loaderApi > LOADER_API) return;
      var packs = Array.isArray(doc2.packs) ? doc2.packs : [];
      var css = applyThemes(packs);
      var report = {
        at: new Date().toISOString(),
        loaderApi: doc2.loaderApi,
        overlayApi: typeof doc2.overlayApi === 'number' ? doc2.overlayApi : null,
        fileVersion: typeof doc2.fileVersion === 'number' ? doc2.fileVersion : null,
        slots: Array.isArray(doc2.slots) ? doc2.slots : [],
        feature: doc2.feature === true,
        packs: packs,
        dataKinds: Array.isArray(doc2.dataKinds) ? doc2.dataKinds : [],
        themeApplied: css !== '',
      };
      win.__SP_MODS_LOADER = report;
      try {
        if (typeof win.dispatchEvent === 'function' && typeof win.CustomEvent === 'function') {
          win.dispatchEvent(new win.CustomEvent('sp-mods-loaded', { detail: report }));
        }
      } catch (e) { /* old browser */ }
    }, function () { /* 离线/老 APK：静默，面板会自己显示「未生效」 */ });
  }

  run();
})();
