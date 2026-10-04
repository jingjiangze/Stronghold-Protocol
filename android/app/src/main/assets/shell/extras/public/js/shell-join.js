// shell-join.js — cross-server invite-code UI (v2.7.2, Discovery Plane architecture).
//
// Discovery and joining are fully separated:
//   • window.shell.resolveInvite(code)  → native: directory presence lookup + signed-list
//     validation → [{id, name, rttMs, humans}] (no URLs ever reach the page)
//   • window.shell.joinOnOrigin(id, code) → native: switch origin with ?room=CODE
//   • phone-host rooms still flow through the native room-code dialog (window.shell.join)
//
// The target server remains the final authority on joinability (ROOM_NOT_FOUND / FULL / STARTED
// surface as normal toasts from the game's own net layer). This module is UI only — no sockets,
// no scanning, no URL handling.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var CODE_RE = /^[A-HJ-NP-Z]{4}$/; // upstream alphabet (no I/O), matches native + directory

  /** Resolve an invite code. Resolves { kind, note?, entries? } for the picker in shellPanels. */
  function resolveCode(code) {
    var K = String(code || '').trim().toUpperCase();
    if (!CODE_RE.test(K)) {
      return Promise.resolve({ kind: 'none', note: '邀请码为 4 位字母（不含 I / O）' });
    }
    // v2.8.6: no client-side cooldown — every click runs a real concurrent sweep (directory + every
    // station); the directory rate-limits authoritatively. Failures keep their reason note below.
    return new Promise(function (resolve) {
      var native = window.shell && typeof window.shell.resolveInvite === 'function';
      if (!native) {
        // plain web build: only the current origin is knowable — deep-link straight into it
        resolve({ kind: 'single', entry: { id: '', name: '当前服务器', rttMs: -1, humans: -1 } });
        return;
      }
      try {
        var list = JSON.parse(window.shell.resolveInvite(K) || '[]');
        if (!Array.isArray(list) || !list.length) {
          resolve({ kind: 'none', note: '未找到邀请码 ' + K + '（可能已结束、过期或服务器暂时离线）' });
          return;
        }
        list.sort(function (a, b) { // by measured latency, per owner decision
          var ar = a.rttMs > 0 ? a.rttMs : Number.MAX_VALUE;
          var br = b.rttMs > 0 ? b.rttMs : Number.MAX_VALUE;
          return ar - br;
        });
        resolve(list.length === 1 ? { kind: 'single', entry: list[0] } : { kind: 'conflict', entries: list });
      } catch (e) {
        resolve({ kind: 'none', note: '查找失败，请稍后重试' });
      }
    });
  }

  /** v4.0: 输入是否按链接处理（http/https 开头，允许前导空白）。 */
  function looksLikeLink(raw) {
    return /^\s*https?:\/\//i.test(String(raw || ''));
  }

  /** v4.0: 链接 → 按访客把该服务器提交到清单（提取 origin+pathname，丢弃查询/锚点），
   *  走壳的 submitServer 桥（Java 侧固定端点、无 CORS）；无桥时降级为站点入口提示。
   *  始终 resolve { ok, text }，绝不抛。 */
  function submitServerLink(raw) {
    var u = null;
    try { u = new URL(String(raw || '').trim()); } catch (e) { u = null; }
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) {
      return Promise.resolve({ ok: false, text: '请输入有效的 http(s) 链接' });
    }
    var base = u.origin + u.pathname;
    if (!u.hostname || !base) return Promise.resolve({ ok: false, text: '链接地址无效' });
    if (!(window.shell && typeof window.shell.submitServer === 'function')) {
      return Promise.resolve({ ok: false, text: '当前版本不支持应用内提交，请到 dl.jiangjiangze.icu/servers 提交' });
    }
    var payload = { servers: [{ name: u.hostname, url: base, probe: '/healthz', note: '' }] };
    var out;
    try { out = window.shell.submitServer(JSON.stringify(payload)); }
    catch (e) { return Promise.resolve({ ok: false, text: '网络不可用，请稍后重试' }); }
    var j = null;
    try { j = JSON.parse(String(out == null ? '' : out)); } catch (e2) { j = null; }
    if (j && j.ok === true) {
      return Promise.resolve({ ok: true, text: '已提交，审核通过后会出现在服务器列表' });
    }
    return Promise.resolve({ ok: false, text: String((j && j.error) || '提交失败，请稍后重试') });
  }

  window.__SP_JOIN = {
    resolveCode: resolveCode,
    CODE_RE: CODE_RE,
    looksLikeLink: looksLikeLink,
    submitServerLink: submitServerLink,
  };
})();
