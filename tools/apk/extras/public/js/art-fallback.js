/* global window, document, location */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here (URL/console are already known there)
// art-fallback.js — 服务器页素材的**最后手段**（业主 2026-10-16「资源校验有些问题，部分服务器无法适配，
// 看看能不能自适应」）。无 UI、无网络、幂等。
//
// 什么时候需要它
//   本机树渲染的页面：素材由本机那份回答（filesDir 热更树 → ArtStore 包 → APK 内嵌 → 缓存 → 本线 CDN），
//   永远拿得到，与这个模块无关。
//   服务器页：/assets/** 一律由**那台服**回答（Java 拦截器的「规则②」，服务器页一律放行）—— 那是对的，
//   服务器的字节日永远该赢。但有的服没有素材树（或某条被删/改过），于是图就出不来。
//
// 它做什么（严格自适应，绝不抢服务器的答案）
//   * 只在**服务器页**（window.__SP_PAGE_LOCAL 为 0，外壳 Java 按页面来源内联）动作；
//   * 只在该元素**已经真的失败之后**（DOM error 事件 事件）才换一次；
//   * 换的目标是同一条相对路径的**本机副本** /__sp/art/<rel>（Java 侧映射到本机 assets/<rel>，
//     取不到就 404 → 页面保持坏图，不会掩盖服务器的问题）；
//   * 每个元素只换一次（data-sp-artfb 标记），失败不再重试，避免抖动；
//   * **跨源 URL 不碰**（CDN 那份由 Java 的 ArtCdn 负责），只处理同源 /assets/**。
//
// 已知边界（如实记录，别当成全覆盖）：DOM error 事件 事件只覆盖 <img>/<audio>/<video> 这类**元素**资源。
//   Spine 的 .skel/.atlas/.png 由 PIXI/fetch 加载，失败是 promise 拒绝而不是元素事件 —— 那一路由
//   window.__SP_ART_FALLBACK_URL(url) 暴露同一个映射，供页面自己的加载器按需取用。
(function () {
  if (window.__SP_ART_FALLBACK) return;
  window.__SP_ART_FALLBACK = 1;

  var PREFIX = '/__sp/art/';
  var ATTR = 'data-sp-artfb';
  var MARK = '/assets/';

  function isServerPage() { return window.__SP_PAGE_LOCAL === '0'; }

  /** /assets/<rel>（可带 ~<hash> 段）→ 同源时返回该路径，否则 null。 */
  function assetPath(url) {
    if (!url) return null;
    try {
      var u = new URL(url, location.href);
      if (u.origin !== location.origin) return null;       // 跨源（CDN）：不是这一层的事
      var i = u.pathname.indexOf(MARK);
      if (i < 0) return null;
      return u.pathname.slice(i);
    } catch (e) { return null; }
  }

  /** 给页面自己的加载器用的映射：原 URL → 本机副本 URL（不是同源 /assets/ 时返回 null）。 */
  window.__SP_ART_FALLBACK_URL = function (url) {
    if (!isServerPage()) return null;
    var p = assetPath(url);
    return p ? PREFIX + p.slice(MARK.length) : null;
  };

  function retry(el) {
    if (!isServerPage() || !el || !el.getAttribute || el.getAttribute(ATTR)) return;
    var p = assetPath(el.getAttribute('src'));
    if (!p) return;
    el.setAttribute(ATTR, '1');                       // 只换一次，失败就停（不再重试第二次）
    var alt = PREFIX + p.slice(MARK.length);
    try { el.setAttribute('src', alt); } catch (e) { return; }
    try { console.log('[sp] art fallback:', p, '->', alt); } catch (e) { /* 无 console 也不报错 */ }
  }

  document.addEventListener('error', function (ev) {
    var t = ev && ev.target;
    if (!t || !t.tagName) return;
    var tag = t.tagName;
    if (tag === 'IMG' || tag === 'AUDIO' || tag === 'VIDEO' || tag === 'SOURCE') retry(t);
  }, true);   // capture：资源错误不冒泡，必须捕获阶段才收得到
})();
