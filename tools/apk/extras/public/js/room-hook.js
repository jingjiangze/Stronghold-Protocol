// room-hook.js — 房间页 DOM 钩子（**热更**：放 extras 里，随外壳热更下发）。
//
// 为什么是 DOM 钩子而不是补丁：房间页来自**上传方**（服务器版本，或上游版本）。
// 用补丁去改 `js/screens/room.js` 必然在对方换版本时失配 —— 0.1.4 的 title.js 就是这么把链子打红的。
// 钩子只做两件事，且**只认那一个按钮**：把「复制密钥」四个小字换成「公开到大厅」，并读出房间码。
// 找不到目标就什么都不做（降级），因此与对方版本无关。
//
// 依赖：`window.__SP_LOBBY.togglePublic/isPublic/localService`（extras/lobby.js 注入）。上传方页面
// 不会带我们的 lobby.js，所以 shell-bridge.js 的加载器会在缺这个模块时先把 `/__sp/lobby.js` 补上
// （同一个外壳自有前缀，同样先 filesDir 热更树再 APK、绝不走网络）；真拿不到时这里只报「未加载」。
// 不用任何页面的模块，不读 store，不碰其它 DOM。
//
// 审计处置（PR#39 审阅意见）：
//   ① 房间页会用 preact **复用同一个按钮节点**渲染下一个房间/新状态 —— 所以每轮扫描都要按当前 DOM
//      刷新标记与文案，房间码在**点击时**现读，绝不把上一次的房间码发布出去。
//   ② 刷新时若这个节点已经被页面挪作他用（文案既不是「复制密钥」也不是我们写的），立刻放开它。
//   ③ 观察器回调合并（一次 DOM 风暴最多换来一次扫描）+ 写 DOM 前先比对，既不自激也不无谓重绘。
(function () {
  'use strict';
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (window.__SP_ROOM_HOOK) return;   // 幂等：多次注入只生效一次
  window.__SP_ROOM_HOOK = 1;

  var SRC_LABEL = '复制密钥';           // 只认这四个小字；别的一律不碰
  var PUB_LABEL = '公开到大厅';
  var OPEN_LABEL = '已公开 · 转私密';
  var MARK = 'data-sp-lobby-pub';
  var NOTE_MS = 3000;
  var SWEEP_MS = 60;                    // 观察器回调合并窗口：一次风暴只扫一次
  var CODE_RE = /^[A-Z0-9]{4}$/;

  /** 房间码就在同一个邀请框里（`.invite__code` 把码逐字拆成 span），从 DOM 读，不碰 store。 */
  function readCode(btn) {
    try {
      var box = (btn.closest && btn.closest('.invite')) || document;
      var el = box.querySelector ? box.querySelector('.invite__code') : null;
      var txt = el ? String(el.textContent || '') : '';
      var m = txt.toUpperCase().replace(/[^A-Z0-9]/g, '');
      return CODE_RE.test(m) ? m : '';
    } catch (e) { return ''; }
  }

  /** 标记里记着我们最后一次见到的合法房间码（接管凭它、点击兜底也凭它）。 */
  function readMark(btn) {
    try {
      var v = String((btn.getAttribute && btn.getAttribute(MARK)) || '');
      return CODE_RE.test(v) ? v : '';
    } catch (e) { return ''; }
  }

  function lobby() {
    try { return window.__SP_LOBBY || null; } catch (e) { return null; }
  }

  /** 只在真的变了才写 DOM：观察器盯着 characterData，无脑写会和重扫互相激发。 */
  function setText(btn, text) {
    if (btn.textContent !== text) btn.textContent = text;
  }

  function setTitle(btn, title) {
    try { if (!btn.getAttribute || btn.getAttribute('title') !== title) btn.setAttribute('title', title); } catch (e) { /* 不重要的装饰 */ }
  }

  /** 把按钮画成当前应有的样子；播报用 label 自身，不引入任何 UI 依赖。
   *  forcedPub 有值时以它为准（切换的响应才是权威状态，别再回查一次）。 */
  function paint(btn, code, note, forcedPub) {
    var L = lobby();
    var pub = false;
    if (forcedPub !== undefined) pub = !!forcedPub;
    else { try { pub = !!(L && typeof L.isPublic === 'function' && L.isPublic(code)); } catch (e) { pub = false; } }
    var text = note || (pub ? OPEN_LABEL : PUB_LABEL);
    btn.__spText = String(text);
    btn.__spBusy = note ? 1 : 0;        // 短暂提示（公开中…/失败原因）期间不要被刷新冲掉
    setText(btn, text);
    var svc = false;
    try { svc = !!(L && typeof L.localService === 'function' && L.localService()); } catch (e) { svc = false; }
    setTitle(btn, svc
      ? '本机服务的房间只有本机能开；公开到大厅需要一台公网服务器'
      : (pub ? '当前已公开到大厅，点按转为私密' : '把本房间公开到大厅（10 分钟内有效）'));
  }

  function onClick(btn, ev) {
    // 码在点击时**现读**（preact 会复用这个节点渲染下一个房间；闭包里记住的码会过期），
    // 读不到就什么都不做 —— 连原来「复制密钥」的行为都不拦，退回页面自己的语义。
    var code = readCode(btn) || readMark(btn);
    if (!code) return;
    // 捕获阶段就拦掉原来的「复制密钥」行为（preact 的处理器挂在容器上，冒泡到不了）。
    if (ev && ev.stopImmediatePropagation) ev.stopImmediatePropagation();
    if (ev && ev.preventDefault) ev.preventDefault();
    var L = lobby();
    if (!L || typeof L.togglePublic !== 'function') { paint(btn, code, '大厅模块未加载'); return; }
    paint(btn, code, '公开中…');
    var p;
    try { p = Promise.resolve(L.togglePublic(code)); } catch (e) { p = Promise.resolve({ ok: false, text: '操作失败' }); }
    /** 结果落地：期间房间被换掉就只按当前状态重画，不把这次的结果贴到新房间上。 */
    function settle(pub, note) {
      var now = readCode(btn) || readMark(btn);
      if (now && now !== code) { paint(btn, now); return; }
      paint(btn, now || code, note, pub);
    }
    p.then(function (r) {
      if (r && r.ok) { settle(r.isPublic); return; }
      settle(undefined, String((r && r.text) || '操作失败'));
      setTimeout(function () { settle(undefined); }, NOTE_MS);
    }).catch(function () {
      settle(undefined, '操作失败');
      setTimeout(function () { settle(undefined); }, NOTE_MS);
    });
  }

  /** 放弃这个节点：摘掉监听与标记，点击回到页面自己的行为（宁可不管，也不能拦错按钮）。 */
  function release(btn) {
    try {
      if (btn.__spH) {
        if (btn.removeEventListener) btn.removeEventListener('click', btn.__spH, true);
        btn.__spH = null;
      }
      if (btn.removeAttribute) { btn.removeAttribute(MARK); btn.removeAttribute('title'); }
      btn.__spText = null;
      btn.__spBusy = 0;
    } catch (e) { /* 释放失败也不能影响页面自己的行为 */ }
  }

  /** 已接管的按钮：每轮扫描都按**当前 DOM** 刷新（节点会被页面复用）。
   *  force=true 时连短暂提示一起重画（调试/外部改了状态后用）。 */
  function refresh(btn, force) {
    if (btn.__spBusy && !force) return;              // 「公开中…/失败提示」进行中：别把提示冲掉
    var text = String(btn.textContent || '').trim();
    if (!text) return;                               // 页面正在 patch（文案暂时为空）：这一轮不动
    var mine = text === SRC_LABEL || (!!btn.__spText && text === btn.__spText);
    if (!mine) { release(btn); return; }             // 节点被页面挪作他用（例如改成「复制链接」）：放开它
    var code = readCode(btn) || readMark(btn);
    if (!code) return;                               // 读不到合法码：保持现状，点击也什么都不做
    if (code !== readMark(btn)) { try { btn.setAttribute(MARK, code); } catch (e) { /* 刷新标记失败就沿用旧码 */ } }
    paint(btn, code);
  }

  /** 扫描并接管目标按钮：只认「文本完全等于『复制密钥』」的那一个，其余一律不碰。 */
  function sweep(force) {
    var list;
    try { list = document.querySelectorAll('.invite__btns button'); } catch (e) { return; }
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (readMark(b)) { refresh(b, force); continue; }
      // 只认「复制密钥」：文本不完全相等就不动（含我们自己的其它按钮、上游改版后的新按钮）
      if (String(b.textContent || '').trim() !== SRC_LABEL) continue;
      var code = readCode(b);
      if (!code) continue;
      try { b.setAttribute(MARK, code); } catch (e) { continue; }
      paint(b, code);
      var h = (function (bb) { return function (ev) { onClick(bb, ev); }; })(b);
      b.__spH = h;
      b.addEventListener('click', h, true);
    }
  }

  // 房间页会反复重渲染（preact 只 patch 变了的节点），所以：先立即扫一次，再用观察器兜住后续变化。
  // 观察面仍是整篇文档（上传方页面里房间屏挂在哪儿事先不可知，缩到子树要重新布防、反而会漏挂载点），
  // 但回调**合并**：一次 DOM 风暴最多换来 SWEEP_MS 后的一次扫描，且只观察子树/文本、不观察属性。
  var queued = 0;

  function schedule() {
    if (queued) return;
    queued = 1;
    setTimeout(function () { queued = 0; sweep(false); }, SWEEP_MS);
  }

  function arm() {
    sweep(false);
    try {
      var mo = new MutationObserver(schedule);
      mo.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true });
    } catch (e) { /* 老引擎没有 MutationObserver：只靠首次扫描 */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', arm, { once: true });
  } else {
    arm();
  }

  // 供测试与调试用：强制重扫（例如公开状态被别处改变后）
  window.__SP_ROOM_HOOK_SWEEP = function () { sweep(true); };
})();
