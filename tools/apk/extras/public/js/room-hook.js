// room-hook.js — 房间页 DOM 钩子（**热更**：放 extras 里，随外壳热更下发）。
//
// 为什么是 DOM 钩子而不是补丁：房间页来自**上传方**（服务器版本，或上游版本）。
// 用补丁去改 `js/screens/room.js` 必然在对方换版本时失配 —— 0.1.4 的 title.js 就是这么把链子打红的。
// 钩子只做两件事，且**只认那一个按钮**：把「复制密钥」四个小字换成「公开到大厅」，并读出房间码。
// 找不到目标就什么都不做（降级），因此与对方版本无关。
//
// 依赖：`window.__SP_LOBBY.togglePublic/isPublic/localService`（extras/lobby.js 注入）。
// 不用任何页面的模块，不读 store，不碰其它 DOM。
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

  /** 房间码就在同一个邀请框里（`.invite__code` 把码逐字拆成 span），从 DOM 读，不碰 store。 */
  function readCode(btn) {
    try {
      var box = (btn.closest && btn.closest('.invite')) || document;
      var el = box.querySelector ? box.querySelector('.invite__code') : null;
      var txt = el ? String(el.textContent || '') : '';
      var m = txt.toUpperCase().replace(/[^A-Z0-9]/g, '');
      return /^[A-Z0-9]{4}$/.test(m) ? m : '';
    } catch (e) { return ''; }
  }

  function lobby() {
    try { return window.__SP_LOBBY || null; } catch (e) { return null; }
  }

  /** 把按钮画成当前应有的样子；播报用 label 自身，不引入任何 UI 依赖。
   *  forcedPub 有值时以它为准（切换的响应才是权威状态，别再回查一次）。 */
  function paint(btn, code, note, forcedPub) {
    var L = lobby();
    var pub = false;
    if (forcedPub !== undefined) pub = !!forcedPub;
    else { try { pub = !!(L && typeof L.isPublic === 'function' && L.isPublic(code)); } catch (e) { pub = false; } }
    btn.textContent = note || (pub ? OPEN_LABEL : PUB_LABEL);
    var svc = false;
    try { svc = !!(L && typeof L.localService === 'function' && L.localService()); } catch (e) { svc = false; }
    btn.setAttribute('title', svc
      ? '本机服务的房间只有本机能开；公开到大厅需要一台公网服务器'
      : (pub ? '当前已公开到大厅，点按转为私密' : '把本房间公开到大厅（10 分钟内有效）'));
  }

  function onClick(btn, code, ev) {
    // 捕获阶段就拦掉原来的「复制密钥」行为（preact 的处理器挂在容器上，冒泡到不了）。
    if (ev && ev.stopImmediatePropagation) ev.stopImmediatePropagation();
    if (ev && ev.preventDefault) ev.preventDefault();
    var L = lobby();
    if (!L || typeof L.togglePublic !== 'function') { paint(btn, code, '大厅模块未加载'); return; }
    paint(btn, code, '公开中…');
    var p;
    try { p = Promise.resolve(L.togglePublic(code)); } catch (e) { p = Promise.resolve({ ok: false, text: '操作失败' }); }
    p.then(function (r) {
      if (r && r.ok) { paint(btn, code, null, r.isPublic); return; }
      paint(btn, code, String((r && r.text) || '操作失败'));
      setTimeout(function () { paint(btn, code); }, NOTE_MS);
    }).catch(function () {
      paint(btn, code, '操作失败');
      setTimeout(function () { paint(btn, code); }, NOTE_MS);
    });
  }

  /** 扫描并接管目标按钮。repaint=true 时连已接管的也重画（用于状态可能变了）。 */
  function sweep(repaint) {
    var list;
    try { list = document.querySelectorAll('.invite__btns button'); } catch (e) { return; }
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var taken = b.getAttribute && b.getAttribute(MARK);
      if (taken) {
        if (repaint) { var c0 = b.getAttribute(MARK); if (c0) paint(b, c0); }
        continue;
      }
      // 只认「复制密钥」：文本不完全相等就不动（含我们自己的其它按钮、上游改版后的新按钮）
      if (String(b.textContent || '').trim() !== SRC_LABEL) continue;
      var code = readCode(b);
      if (!code) continue;
      b.setAttribute(MARK, code);
      paint(b, code);
      b.addEventListener('click', (function (bb, cc) {
        return function (ev) { onClick(bb, cc, ev); };
      })(b, code), true);
    }
  }

  // 房间页会反复重渲染（preact 只 patch 变了的节点），所以：先立即扫一次，再用观察器兜住后续变化。
  // 只观察子树/文本，不观察属性（我们自己改的 textContent 会触发一次重扫，sweep 幂等所以安全）。
  function arm() {
    sweep(false);
    try {
      var mo = new MutationObserver(function () { sweep(false); });
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
