// room-hook.js — 房间页 DOM 钩子（**热更**：放 extras 里，随外壳热更下发）。
//
// 为什么是 DOM 钩子而不是补丁：房间页来自**上传方**（服务器版本，或上游版本）。
// 用补丁去改 `js/screens/room.js` 必然在对方换版本时失配 —— 0.1.4 的 title.js 就是这么把链子打红的。
// 钩子只做两件事，且**只认那一个按钮**：把「复制密钥」那个小按钮换成「公开到大厅」，并读出房间码。
// 找不到目标就什么都不做（降级），因此与对方版本无关。
//
// v7.3 匹配加固（审计-上游冲突面-2026-10-08.md §3.1 D7 / R-02）：旧版**精确匹配中文文本「复制密钥」**，
// 而上游 public/i18n/*.json 把它译成 Copy Key / 코드 복사 / コードをコピー / 複製金鑰 —— 玩家切到英文
// （或韩/日/繁中）时接管**当场失效**。现在：
//   ① 结构优先：`.invite__btns` 里那个 inline SVG 的 path d == 上游 ICONS.copy 的按钮（不认文本，认图标；
//      图标 path 与语言无关，也不随文案改动）；
//   ② 文案回退：上述结构认不出时，认 5 种语言的「复制密钥」译法（zh-CN/en/ko/ja/zh-TW）；
//   ③ 都认不出 → 什么都不做（降级不变）。文本常量一律用 \uXXXX 转义，保证注入脚本是纯 ASCII。
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

  // 只认「复制密钥」那一个按钮；别的一律不碰。5 种语言的译法与上游 public/i18n/*.json 一一对应
  // （审计 V9：上游新增语言/改译文时，tools/apk/check-upstream-contract.mjs 的 i18n 检查会大声报错）。
  var SRC_LABELS = [
    '\u590d\u5236\u5bc6\u94a5',                  // zh-CN 复制密钥（上游源串）
    'Copy Key',                                   // en
    '\ucf54\ub4dc \ubcf5\uc0ac',                  // ko 코드 복사
    '\u30b3\u30fc\u30c9\u3092\u30b3\u30d4\u30fc', // ja コードをコピー
    '\u8907\u88fd\u91d1\u9470'                    // zh-TW 複製金鑰
  ];
  // 结构锚点：上游 ui/components.js 的 ICONS.copy.d（room.js 的「复制密钥」Button 带 icon="copy"）。
  // 图标 path 与语言无关，所以它是比文案更稳的判据（审计 D7 的「认结构」）。
  var COPY_ICON_D = 'M8 3h11v13h-2V5H8zM5 7h10v14H5zm2 2v10h6V9z';
  var PUB_LABEL = '\u516c\u5f00\u5230\u5927\u5385';            // 公开到大厅
  var OPEN_LABEL = '\u5df2\u516c\u5f00 \u00b7 \u8f6c\u79c1\u5bc6'; // 已公开 · 转私密
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

  /** 文案命中：trim 后精确等于 5 种语言中的某一种（上游 i18n 的译法）。 */
  function labelHit(text) {
    var s = String(text == null ? '' : text).replace(/^\s+|\s+$/g, '');
    for (var i = 0; i < SRC_LABELS.length; i++) { if (s === SRC_LABELS[i]) return true; }
    return false;
  }

  /** 结构命中：按钮里的 inline SVG 首条 path 的 d 就是上游 ICONS.copy（不认文本，认图标）。
   *  图标 path 与界面语言无关，也不随文案改动，因此比文本匹配更稳（审计 D7）。 */
  function iconHit(btn) {
    try {
      if (!btn || typeof btn.querySelector !== 'function') return false;
      var path = btn.querySelector('svg path') || btn.querySelector('path');
      if (!path || typeof path.getAttribute !== 'function') return false;
      return path.getAttribute('d') === COPY_ICON_D;
    } catch (e) { return false; }
  }

  /** 该按钮是不是「复制密钥」那一个：结构优先，多语言文案回退。 */
  function isTarget(btn) {
    return iconHit(btn) || labelHit(btn && btn.textContent);
  }

  /** 已接管的按钮是否仍属于我们：文案是某种「复制密钥」译法、或我们写上去的文案、或图标仍是 copy。 */
  function isMine(btn, text) {
    return labelHit(text) || (!!btn.__spText && text === btn.__spText) || iconHit(btn);
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
      ? '\u672c\u673a\u670d\u52a1\u7684\u623f\u95f4\u53ea\u6709\u672c\u673a\u80fd\u5f00\uff1b\u516c\u5f00\u5230\u5927\u5385\u9700\u8981\u4e00\u53f0\u516c\u7f51\u670d\u52a1\u5668'
      : (pub ? '\u5f53\u524d\u5df2\u516c\u5f00\u5230\u5927\u5385\uff0c\u70b9\u6309\u8f6c\u4e3a\u79c1\u5bc6'
             : '\u628a\u672c\u623f\u95f4\u516c\u5f00\u5230\u5927\u5385\uff0810 \u5206\u949f\u5185\u6709\u6548\uff09'));
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
    if (!L || typeof L.togglePublic !== 'function') { paint(btn, code, '\u5927\u5385\u6a21\u5757\u672a\u52a0\u8f7d'); return; }
    paint(btn, code, '\u516c\u5f00\u4e2d\u2026');
    var p;
    try { p = Promise.resolve(L.togglePublic(code)); } catch (e) { p = Promise.resolve({ ok: false, text: '\u64cd\u4f5c\u5931\u8d25' }); }
    /** 结果落地：期间房间被换掉就只按当前状态重画，不把这次的结果贴到新房间上。 */
    function settle(pub, note) {
      var now = readCode(btn) || readMark(btn);
      if (now && now !== code) { paint(btn, now); return; }
      paint(btn, now || code, note, pub);
    }
    p.then(function (r) {
      if (r && r.ok) { settle(r.isPublic); return; }
      settle(undefined, String((r && r.text) || '\u64cd\u4f5c\u5931\u8d25'));
      setTimeout(function () { settle(undefined); }, NOTE_MS);
    }).catch(function () {
      settle(undefined, '\u64cd\u4f5c\u5931\u8d25');
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
    if (!isMine(btn, text)) { release(btn); return; } // 节点被页面挪作他用（例如改成「复制链接」）：放开它
    var code = readCode(btn) || readMark(btn);
    if (!code) return;                               // 读不到合法码：保持现状，点击也什么都不做
    if (code !== readMark(btn)) { try { btn.setAttribute(MARK, code); } catch (e) { /* 刷新标记失败就沿用旧码 */ } }
    paint(btn, code);
  }

  /** 接管一个按钮：记下房间码、画成公开按钮、挂上捕获阶段监听。 */
  function adopt(btn, code) {
    try { btn.setAttribute(MARK, code); } catch (e) { return; }
    paint(btn, code);
    var h = (function (bb) { return function (ev) { onClick(bb, ev); }; })(btn);
    btn.__spH = h;
    btn.addEventListener('click', h, true);
  }

  /** 扫描并接管目标按钮：**结构（copy 图标）优先，5 种语言的文案回退**；其余一律不碰。
   *  找不到目标就什么都不做（降级不变）。 */
  function sweep(force) {
    var list;
    try { list = document.querySelectorAll('.invite__btns button'); } catch (e) { return; }
    var i, b;
    // 已接管的按钮按当前 DOM 刷新（节点会被 preact 复用）
    for (i = 0; i < list.length; i++) { if (readMark(list[i])) refresh(list[i], force); }
    // 第一遍：结构命中（不认文本，认 copy 图标）
    var adopted = 0;
    for (i = 0; i < list.length; i++) {
      b = list[i];
      if (readMark(b) || !iconHit(b)) continue;
      var code = readCode(b);
      if (!code) continue;
      adopt(b, code);
      adopted++;
    }
    if (adopted) return;                             // 结构已命中：不必再做文案回退
    // 第二遍：多语言文案回退
    for (i = 0; i < list.length; i++) {
      b = list[i];
      if (readMark(b) || !labelHit(b.textContent)) continue;
      var c2 = readCode(b);
      if (!c2) continue;
      adopt(b, c2);
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
