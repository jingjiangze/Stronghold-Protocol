// lobby.js — 「大厅」in-page panel (v3.7 P1), loaded as a CLASSIC script from index.html right after
// player-data.js (see tools/apk/patches/settings-v3.7.json), so it fetches the Preact UI kit and the
// panel registry with dynamic import(). registerPanel('lobby', LobbyPanel) installs this panel into
// shellPanels.js' add-on registry; the built-in panels are untouched. window.__SP_LOBBY = { open }
// is installed immediately (debugging / future shell entry points).
//
// v4.3: joinRoom() is now a MODULE-LEVEL function exposed as window.__SP_LOBBY.joinRoom so the game
// lobby screen's PublicRooms list (settings-v4.0.json) joins exactly like this panel: map the room
// host to a signed-list id → shell.joinOnOrigin(id, code) (App) / safeNavUrl (web). A successful
// native join also arms the one-shot autostart (title screen takeAutostart) so the reloaded page
// enters the room automatically — same as pickStation. This file also probes community-station /
// custom-server latency on the web with a no-cors fetch (5-minute in-memory cache), so the server
// cards' rttMs/reachable dots are filled without a native bridge.
//
// Sections:
//   1) 服务器卡 — App: the signed list (shell.getServerList(): name / humans / latency / app version;
//      URLs never leave the shell); plain web: __SP_SHELL.getServers() static lines (labels + urls).
//      The two community stations behind this lobby's room sources (raiya / misyra) are always
//      rendered; when the signed list does not carry one yet the card is marked 「未在签名清单」 and
//      cannot switch natively. Click = setServer(id) + setAutostart() (App) / navigate (web).
//   2) 邀请码 — reuses window.__SP_JOIN.resolveCode (shell-join.js); a single hit joins at once,
//      multiple hits render the latency-sorted picker (the same structure JoinPanel uses).
//   3) 房间列表 — cross-server aggregation of two READ-ONLY sources:
//        ① GET https://game.rainya.me/api/rooms — public aggregator (CORS *), returns
//           { ok, now, ttlSec, rooms: [{ code, server, note, ageSec, leftSec, url }] }
//        ② GET <BOARD>/api/rooms — our own room board; BOARD is '' until deployed, so today this
//           source is skipped and the panel says 「房间牌待上线」.
//      leftSec counts down locally (1s repaint); each source is re-pulled every 15s, and ONLY while
//      this panel is mounted AND document is visible — visibilitychange parks/resumes the timers
//      (the same energy discipline as room-observer.js). One unreachable source never blocks the
//      other. Join: App — map the room url host to a signed-list entry id (a host field when the
//      shell exposes one, else the known raiya/misyra aliases) → shell.joinOnOrigin(id, code); no
//      match → an inline hint. Web — location.href = url. Both paths validate the URL first.
//   4) 加入自定义服务器 — one action does BOTH: switch to the typed line (custom:<url>; https only)
//      AND submit it to the site queue. The two are independent — a failed/queued submit never undoes
//      the join; the result is shown in place as 「已加入；同步结果：…」.
//   5) 提交房间 / 销毁 — POST/DELETE the self-hosted room board (BOARD). The token of a submitted room
//      is kept in localStorage['sp.lobby.tokens'] (code→token) so its own row gets a 销毁 button.
//
// Security: fetches go only to the https hosts pinned in ALLOWED_HOSTS (game.rainya.me + the BOARD
// host); URLs are parsed before any fetch or navigation (http(s) only, no loopback/private hosts)
// and never come from user input.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  // ---- v7.0 口径①：单调时钟 ---------------------------------------------------------------------
  // 所有「测耗时 / 判超时 / 算节流窗口」一律走 monoNow()（performance.now 优先），避免墙钟被系统
  // 改时间 / NTP 跳变污染：挂起后回前台、或用户手改系统时间，墙钟会算出巨大的假延迟 / 假过期。
  // 需要「绝对时间戳」的地方（跨页面持久化的匹配待办 ts、访客缓存 at）走 wallNow() —— 它是全文件
  // **唯一**的墙钟↔单调换算点（epoch 只在启动时取一次）。此外全文件不再出现裸 Date.now()。
  function monoNow() {
    try {
      return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
        ? performance.now() : Date.now();
    } catch (e) { return Date.now(); }
  }
  var WALL_EPOCH = Date.now() - monoNow(); // 唯一换算：墙钟 = 单调 + epoch
  function wallNow() { return WALL_EPOCH + monoNow(); }

  // ---- v7.0 口径②：仅可见页才探测 ---------------------------------------------------------------
  // 「探测」= 本模块**主动发起**的网络请求（rtt 采样 / 房间牌轮询 / 社区源 / 自己房间上报 /
  // 服务端发布自检 / 访客取数）。页面隐藏时一个都不发；隐藏期间挂起的探测在回到前台时立刻补发一次。
  function pageVisible() {
    return !(typeof document !== 'undefined' && document.hidden);
  }
  var pendingProbes = [];
  /** 隐藏页把探测挂起（回前台补发）；可见页立即执行。fn 自身异常不影响其它探测。 */
  function runProbe(fn) {
    if (typeof fn !== 'function') return;
    if (!pageVisible()) { pendingProbes.push(fn); return; }
    try { fn(); } catch (e) { /* 单个探测异常不扩散 */ }
  }
  /** 回到前台时把挂起的探测补发一次（幂等：队列取空即止）。 */
  function drainProbes() {
    if (!pendingProbes.length || !pageVisible()) return;
    var jobs = pendingProbes; pendingProbes = [];
    for (var i = 0; i < jobs.length; i++) { try { jobs[i](); } catch (e) { /* ignore */ } }
  }

  // v5.2 配额纪律（免费额度 10 万请求/天）：房间牌 60s；社区源 300s（三源各一条）。
  // 面板打开 1 小时 = 60 + 12 = 72 请求（旧 15s 节奏是 960）——省 13 倍。
  var BOARD_REFRESH_MS = 60000;
  var COMMUNITY_REFRESH_MS = 300000;
  var FETCH_TIMEOUT_MS = 8000;
  var ROOM_CODE_RE = /^[A-HJ-NP-Z]{4}$/; // upstream alphabet (no I/O), matches shell-join.js
  // 房间牌（自建聚合）：自定义域为国内主路（workers.dev 在国内常不可达）；workers.dev 仍在线作兜底
  var BOARD = 'https://sp-lobby.jiangjiangze.icu';
  // v4.9: 社区房间源（rainya 门户 / lunar / rinko）全部经自建 Worker 中转 —— 三家上游都不发 CORS
  // 头（OPTIONS 403/405），页面直连必被浏览器拦；中转只认 src 白名单，上游是服务端常量。
  var COMMUNITY = BOARD ? BOARD.replace(/\/+$/, '') + '/api/community?src=' : '';

  // The two community stations behind the room sources — always rendered as cards; absent from the
  // signed list (yet) → shown as 「未在签名清单」 and only web-navigable.
  var KNOWN_STATIONS = [
    { host: 'game.rainya.me', name: 'raiya服', aliases: ['raiya', 'rainya'], url: 'https://game.rainya.me/' },
    { host: 'game.misyra.com', name: 'misyra服', aliases: ['misyra'], url: 'https://game.misyra.com/' },
  ];

  // Fetch allow-list: the pinned BOARD host only (all community room fetches go through its relay;
  // the upstream hostnames never appear in a page fetch).
  var ALLOWED_HOSTS = (function () {
    var m = {};
    if (BOARD) {
      try {
        var u = new URL(BOARD);
        if (u.protocol === 'https:') m[u.hostname.toLowerCase()] = true;
      } catch (e) { /* a malformed BOARD constant simply keeps its source disabled */ }
    }
    return m;
  })();

  window.__SP_LOBBY = {
    open: function () {
      try { window.__SP_SHELL && window.__SP_SHELL.openPanel && window.__SP_SHELL.openPanel('lobby'); } catch (e) { /* no bridge */ }
    },
    /**
     * v5.6: 把本机房间「公开到局域网」（审查发现#1 —— /lan/rooms 不再无条件列出房号）。
     * 只对本机服务有意义：POST 打到当前同源的本地 Node，server 侧只接受回环来源，
     * 同网段邻居无法替别人把房间公开出去。返回 { ok, on }。
     */
    toggleLanPublic: function (code, on) {
      var c = String(code || '').toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(c)) return Promise.resolve({ ok: false, on: false });
      try {
        return fetch('/lan/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: c, on: !!on }),
        }).then(function (r) {
          return r.json().catch(function () { return null; });
        }).then(function (j) {
          return { ok: !!(j && j.ok), on: !!(j && j.on) };
        }).catch(function () { return { ok: false, on: false }; });
      } catch (e) {
        return Promise.resolve({ ok: false, on: false });
      }
    },
    /** v5.6.1: 读本机房间当前的局域网公开状态（回环专用只读端点）。读不到按未公开处理。 */
    lanPublicState: function (code) {
      var c = String(code || '').toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(c)) return Promise.resolve({ ok: false, on: false });
      try {
        return fetch('/lan/publish?code=' + encodeURIComponent(c), { method: 'GET' })
          .then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (j) { return { ok: !!(j && j.ok), on: !!(j && j.on) }; })
          .catch(function () { return { ok: false, on: false }; });
      } catch (e) {
        return Promise.resolve({ ok: false, on: false });
      }
    },
  };

  // ---- small formatters (same looks as shellPanels.js) ------------------------------------------

  // v4.1: 延迟色点 —— 不再显示数值，返回 { color, title }。
  // 已停用灰 / 不可达红 / 未知灰 / <150ms 绿 / <400ms 黄 / 其余红（title 不写 ms）。
  function rttDot(ms, enabled, reachable, pending) {
    if (enabled === false) return { color: '#8a9a93', title: '已停用' };
    // v5.3.1（审查发现#1）：pending 必须先于一切取色 —— 探测进行中连「缓存了上一轮正数 rtt」
    // 的条目也一律灰「探测中」，否则刷新时旧色与新探测混排（陈旧绿点假象）。
    if (pending) return { color: '#8a9a93', title: '探测中' };
    if (!isFinite(ms) || ms <= 0) {
      // v5.3: 探测进行中（整条探测管线 loading）→ 灰「探测中」；此前与"无法连接"同为红色，
      // 面板一打开就是满屏红（用户报「测速异常」的根因之一）。
      if (reachable === false) {
        return pending ? { color: '#8a9a93', title: '探测中' } : { color: '#e06c5a', title: '无法连接' };
      }
      return { color: '#8a9a93', title: '延迟未知' };
    }
    // v5.3 阈值按生态实测校准：国内直连 ~60ms、CF 前置 1–3s（旧 150/400 会把整个 CF 生态全标红）
    if (ms < 250) return { color: '#4ed8af', title: '延迟良好' };
    if (ms < 900) return { color: '#e0b64a', title: '延迟一般' };
    return { color: '#e06c5a', title: '延迟较差' };
  }

  function fmtRtt(ms) { return isFinite(ms) && ms > 0 ? Math.round(ms) + 'ms' : '--'; }

  function fmtApp(app) {
    var s = String(app || '');
    if (!s) return '';
    return /^\d/.test(s) ? 'v' + s : s;
  }

  function fmtLeft(sec) {
    var s = Math.max(0, Math.floor(sec));
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ---- URL guards (http(s) only, no loopback/private before any fetch or navigation) -------------

  function isPrivateHost(host) {
    var h = String(host || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
    if (!h || h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === 'local') return true;
    if (/\.local$/.test(h)) return true;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
    var m = /^172\.(\d{1,3})\./.exec(h);
    return !!(m && Number(m[1]) >= 16 && Number(m[1]) <= 31);
  }

  /** Parse a navigation target (server line / room deep link): http(s) + public host only. */
  function safeNavUrl(raw) {
    try {
      var u = new URL(String(raw || ''));
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
      if (isPrivateHost(u.hostname)) return '';
      return u.toString();
    } catch (e) { return ''; }
  }

  /** Parse a custom-server URL: http(s) + a host only. LAN/private hosts are allowed on purpose —
   *  this is the user's OWN line, unlike the public room sources guarded above. */
  function parseHttpUrl(raw) {
    try {
      var u = new URL(String(raw || ''));
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      if (!u.hostname) return null;
      return u;
    } catch (e) { return null; }
  }

  /** v4.0: 在 base 上增删 room 查询参数 —— 保留 origin 与 pathname、其余查询原样，`#` 始终最后。
   *  统一替代 `location.origin + '/?room='`（丢路径）与 `url.replace(/\/+$/,'') + '/' + search`
   *  （在 /play 上补回 `/` 产生 404）。base 可传 location.href（当前页）或 origin+pathname。 */
  function withRoom(base, code) {
    try {
      var u = new URL(String(base || ''), location.href);
      if (code == null) u.searchParams.delete('room');
      else u.searchParams.set('room', String(code));
      return u.toString();
    } catch (e) { return ''; }
  }

  // ---- room-board tokens (localStorage; code → token) --------------------------------------------
  // A submitted room's token lets its own row show 销毁 (DELETE with X-Token). localStorage can throw
  // (private mode / disabled) — every access is guarded and simply degrades to "not mine".
  var TOKENS_KEY = 'sp.lobby.tokens';

  function readTokens() {
    try {
      var o = JSON.parse(localStorage.getItem(TOKENS_KEY) || '{}');
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch (e) { return {}; }
  }

  function writeTokens(o) {
    try { localStorage.setItem(TOKENS_KEY, JSON.stringify(o || {})); } catch (e) { /* private mode */ }
  }

  function saveToken(code, token) {
    var o = readTokens();
    o[code] = String(token);
    writeTokens(o);
  }

  function dropToken(code) {
    var o = readTokens();
    if (Object.prototype.hasOwnProperty.call(o, code)) { delete o[code]; writeTokens(o); }
  }

  // ---- v3.9: 「公开到大厅」bridge for the room screen (js/screens/room.js InviteBox) ---------------
  // A room counts as public ON THIS DEVICE iff its token sits in localStorage['sp.lobby.tokens']
  // (the same store the 提交房间 form writes). togglePublic() POSTs to / DELETE from the room board
  // and flips the token accordingly; the room screen renders the returned { ok, isPublic, text }.

  /** 内部线路 id（v5.1）：这些「服务器」只有本机能到，永不进公共房间牌。
   *  sp-phone-host = 手机本机服务（壳的 currentServerId() 对 127.0.0.1 返回它）；
   *  local / auto 是面板自身的虚拟行 id，历史上有被兜底命名的风险。 */
  var INTERNAL_SERVER_IDS = { 'sp-phone-host': 1, local: 1, auto: 1 };

  /** v5.1: 当前是否在本机服务上（127.0.0.1 手机自开服）——公开到大厅必须被拒绝（只有本机能进）。 */
  function isLocalService() {
    try {
      var s = String((window.shell && window.shell.currentServerId && window.shell.currentServerId()) || '').toLowerCase();
      if (s === 'sp-phone-host' || s === 'local') return true;
      var h = String(location.hostname || '').replace(/^\[/, '').replace(/\]$/, '');
      return isPrivateHost(h);
    } catch (e) { return false; }
  }

  /**
   * 页面是否由**本机回环**提供（而不是「某个私网地址」）。
   * 审查发现：局域网访客打开的是房主的私网地址，hostname 也是私网，isLocalService() 会把访客的页面
   * 也判成「本机」——于是给出「公开到局域网」开关，而 /lan/publish 只接受回环来源，访客点了必然失败。
   * 只有本机服务（App 内走 127.0.0.1）才算。
   */
  function isOwnHostPage() {
    try {
      var h = String(location.hostname || '').replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
      return h === '127.0.0.1' || h === '::1' || h === 'localhost';
    } catch (e) { return false; }
  }

  /** Current server id for board rows: native bridge first, location.host fallback.
   *  v4.7: 兜底命中环回/私网（本机页直接打开）时返回 ''——私网地址不得进公共清单，由调用方拦截。
   *  v5.1: 本机服务（currentServerId() = 'sp-phone-host'）等内部 id 同样返回 ''——上传只会产生
   *        一条全服可见、谁也进不去的幽灵房（127.0.0.1 的 URL 早已被拒，但无 url 的提交会漏）。 */
  function boardServerId() {
    try {
      if (window.shell && typeof window.shell.currentServerId === 'function') {
        var s = String(window.shell.currentServerId() || '').trim();
        if (s) return INTERNAL_SERVER_IDS[s.toLowerCase()] ? '' : s;
      }
    } catch (e) { /* ignore */ }
    try {
      var host = String(location.host || '');
      // isPrivateHost 收的是不带端口的主机名（IPv6 方括号由它自己剥）；host:port 先剥端口
      if (!host || isPrivateHost(host.replace(/:\d+$/, ''))) return '';
      return host;
    } catch (e) { return ''; }
  }

  /** Deep link for the board, ONLY when this page is a public https origin (the board rejects
   *  private hosts, so we omit the field rather than let the whole submit fail). */
  function publicRoomUrl(code) {
    try {
      var origin = String(location.origin || '');
      if (origin.indexOf('https://') !== 0) return '';
      if (isPrivateHost(new URL(origin).hostname)) return '';
      return withRoom(origin + String(location.pathname || '/'), code);
    } catch (e) { return ''; }
  }

  /** True when this device already published the room —— 客户端自己 POST 过（本地 token），
   *  或**服务端**在替我们发布（B：token 在服务端，客户端只有这份状态缓存）。 */
  function isPublic(code) {
    var c = String(code || '').trim().toUpperCase();
    if (!ROOM_CODE_RE.test(c)) return false;
    if (spPub.on && spPub.code === c) return true;
    var o = readTokens();
    return Object.prototype.hasOwnProperty.call(o, c);
  }

  // ---- v6.4: 服务端发布（B） ---------------------------------------------------------------------
  // 房间页「公开到大厅」优先让**本机服务**去发布：它持有 token、知道房间还在不在、每 60s 用真实
  // 人数 PATCH、房间没了立刻 DELETE。客户端只留一份状态缓存（token 不在我们手里）。
  // 拿不到服务端端点（老内容包 / 浏览器直连别人家的服）就回落到原来的直连 POST（A 的路径）。
  var spPub = { on: false, code: '', err: '', tried: 0, missAt: 0, seq: 0, applied: 0 };
  var SP_PUB_FALLBACK_MS = 5 * 60 * 1000; // 端点不存在 → 5 分钟内不再试（等热更带上叠加层就会恢复）

  function spPubAvailable() {
    if (!spPub.missAt) return true;
    return monoNow() - spPub.missAt > SP_PUB_FALLBACK_MS; // v7.0: 节流窗口用单调时钟
  }

  /** 打本机服务的发布端点（同源相对路径；3s 超时）。返回 {ok, published, error} 或 null（不可达）。 */
  function spPubCall(action, payload) {
    if (!spPubAvailable()) return Promise.resolve(null);
    var init = { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}) };
    try { init.signal = AbortSignal.timeout(3000); } catch (e) { /* 老引擎：无超时 */ }
    var run;
    try { run = fetch('/sp/lobby/publish', init); } catch (e) { return Promise.resolve(null); }
    return run.then(function (r) {
      // 404/405 = 这个内容包没有叠加层；403 = 控制面只认回环（远程页面/浏览器直连）——两者都表示
      // 「这里用不了服务端发布」→ 回落直连路径，而不是把用户卡死。
      if (r.status === 404 || r.status === 405 || r.status === 403) { spPub.missAt = monoNow(); spPub.tried++; return null; }
      return r.json().catch(function () { return {}; }).then(function (j) {
        spPub.tried++;
        var ok = !!(j && j.ok);
        if (ok) { spPub.on = action === 'publish'; spPub.code = ok ? String((payload && payload.code) || spPub.code || '').toUpperCase() : ''; spPub.err = ''; }
        else spPub.err = String((j && j.error) || ('HTTP ' + r.status));
        return { ok: ok, published: spPub.on, error: spPub.err };
      });
    }, function () {
      // 结果**未知**（超时/连接断）：绝不许回退直连——服务端可能已经 POST 成功，两条路径会各持
      // 一个 token 把同一房号公开两遍。先核对服务端状态，再如实报告。
      return spPubRefresh().then(function () {
        return spPub.on ? { ok: true, published: true, error: '' } : { ok: false, error: 'timeout' };
      });
    });
  }

  /** 服务端发布状态自检（同源、极轻；加载时与每拍都打，403/404 后 5 分钟不再试）。
   *  v7.0: 隐藏页不发（属于「探测」）；回到前台由 visibilitychange 的 ownWatchArm→ownTick 补一次。 */
  function spPubRefresh() {
    if (!pageVisible()) return Promise.resolve();
    if (!spPubAvailable()) return Promise.resolve();
    var run;
    var seq = ++spPub.seq;
    try { run = fetch('/sp/lobby/status', { cache: 'no-store' }); } catch (e) { return Promise.resolve(); }
    return run.then(function (r) {
      if (r.status === 404 || r.status === 405 || r.status === 403) { spPub.missAt = monoNow(); return; }
      if (!r.ok) return; // 状态路由自己出错 → 不动缓存（活跃的发布项绝不许被隐藏）
      return r.json().then(function (j) {
        if (!j || typeof j.published !== 'boolean') return;   // 形状不对 = 不可信，不动缓存
        if (seq < spPub.applied) return;                      // 更新的结果已经落地过 → 这份太旧
        spPub.applied = seq;
        spPub.on = j.published;
        spPub.code = spPub.on ? String(j.code || '') : '';
        spPub.err = String(j.lastError || '');
      }, function () {});
    }, function () {});
  }

  // ---- v4.7: serverName 友好名（域名不上传）-----------------------------------------------------
  // 展示列（房间牌的 server）历史上直接吃 serverId，而 serverId 兜底是 location.host →
  // 原始 host:port（如 127.0.0.1:3000 / nyat 隧道域名）进了公共清单并撑破面板。
  // 修法：默认上传不带域名 —— serverName 只有能解析成友好名（签名清单 / KNOWN_STATIONS）才给，
  // 否则留空字符串；serverId 保持原值（它是销毁/去重的键，不受影响）。

  /** v4.8: 兜底线路的体面名 —— frp 隧道/官方备用域不在签名清单也不在 KNOWN_STATIONS，
   *  v4.7 的「解析不了留空」会撞上房间牌 Worker 的 serverName 非空校验（BAD_SERVER，
   *  国内线路公开必失败，实测 2026-10-05）。键为纯主机名（不带端口）。 */
  var FALLBACK_HOSTS = {
    'map.u712507.nyat.app': '国内线路',
    'stronghold.jiangjiangze.icu': '官方线路 1',
    'stronghold2.jiangjiangze.icu': '官方线路 2',
    'weishu2.jiangjiangze.icu': '官方备用',
  };

  /** serverId → 展示用友好名：签名清单条目名优先，其次 KNOWN_STATIONS 命中名；解析不了返回 ''。 */
  function friendlyServerName(id) {
    var s = String(id || '').trim();
    if (!s) return '';
    var rows = readListRows(); // 签名清单（App）或网页静态线路（含 KNOWN_STATIONS 兜底卡之外的名字）
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].id || '') === s && rows[i].name) return String(rows[i].name);
    }
    // 反向查 KNOWN_STATIONS：id 本身 / 其 host / 别名命中 → 站点名
    for (var k = 0; k < KNOWN_STATIONS.length; k++) {
      var st = KNOWN_STATIONS[k];
      if (s === st.name || s.toLowerCase() === st.host || st.aliases.indexOf(s.toLowerCase()) >= 0) {
        return st.name;
      }
    }
    // id 若形如 host:port，用主机部分再查一次（_tunnel 域名也可能直接作为 id 上传过）
    var bare = s.replace(/:\d+$/, '');
    if (bare && bare !== s) return friendlyServerName(bare);
    // v4.8: 兜底线路名表命中 → 体面名；未知公网线路给通用兜底名（Worker 要求非空，名字宁短勿空）
    var host = hostOfAuthority(s).toLowerCase();
    if (FALLBACK_HOSTS[host]) return FALLBACK_HOSTS[host];
    return '自定义线路';
  }

  /** 剥掉 IPv6 方括号 + 端口后的纯主机名（isPrivateHost 的输入契约）。 */
  function hostOfAuthority(auth) {
    var h = String(auth || '').trim();
    if (!h) return '';
    if (h.charAt(0) === '[') { // [v6]:port
      var end = h.indexOf(']');
      return end > 0 ? h.slice(1, end) : h.slice(1);
    }
    return h.replace(/:\d+$/, '');
  }

  /** Flip a room between private (POST → store token) and public (DELETE with X-Token → drop token).
   *  Always resolves { ok, isPublic, text }; on failure isPublic stays at its current value.
   *  v4.7: 对局中禁止公开；serverId 兜底为空（私网/环回）时明确提示；serverName 只上友好名。 */
  function togglePublic(code) {
    if (inMatch()) {
      return Promise.resolve({ ok: false, isPublic: isPublic(code), text: '对战中无法公开' });
    }
    var c = String(code || '').trim().toUpperCase();
    if (!ROOM_CODE_RE.test(c)) {
      return Promise.resolve({ ok: false, isPublic: false, text: '邀请码无效' });
    }
    if (!BOARD) {
      return Promise.resolve({ ok: false, isPublic: isPublic(c), text: '房间牌未上线' });
    }
    var endpoint = BOARD.replace(/\/+$/, '') + '/api/rooms';
    var serverId = boardServerId();

    if (!isPublic(c)) { // 私密 → 公开：POST 房间牌并存 token
      if (!serverId) { // v4.7: 环回/私网页兜底被清空 —— 不提交，明确提示
        // v5.1: 本机服务给专属文案（只有本机能进，公开了别人也进不来）
        return Promise.resolve({ ok: false, isPublic: false,
          text: isLocalService() ? '本机服务的房间只有本机能进，不能公开到大厅' : '无法确定当前服务器，暂不能公开' });
      }
      var body = { code: c, serverId: serverId, serverName: friendlyServerName(serverId) };
      var url = publicRoomUrl(c);
      if (url) body.url = url;
      // v5.1: 带上房间难度（board 的加法字段）——「自动/按难度匹配」靠它筛选
      // v6.3: 首发即带全直播字段（mode/status/occupied/capacity）。旧实现首发不带，网页上那一行
      //       会先以「0 人」的空壳出现，直到第一拍 PATCH（这就是「一开始没有」的根因）。
      try {
        var rs = currentRoom();
        if (rs && typeof rs.difficulty === 'string' && rs.difficulty) body.difficulty = rs.difficulty;
        var live = liveFieldsFor(rs);
        body.mode = live.mode; body.status = live.status;
        body.occupied = live.occupied; body.capacity = live.capacity;
      } catch (e) { /* 无 store：不带难度与直播字段，仍可公开 */ }
      // 直连路径（A）：拿不到本机服务端点时用（老内容包 / 浏览器直连别人家的服）。
      function directPost() {
        var post;
        try {
          post = fetch(endpoint, {
            method: 'POST', cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
        } catch (e) { return Promise.resolve({ ok: false, isPublic: false, text: '网络不可用，请稍后重试' }); }
        return post.then(function (r) {
          return r.json().then(function (j) { return { status: r.status, j: j }; });
        }).then(function (res) {
          var j = res.j || {};
          if (j && j.ok === true && j.token) {
            saveToken(c, String(j.token));
            ownWatchArm(); // v6.3: 立刻把上报看表拉起来（含一次即时 tick）
            return { ok: true, isPublic: true, text: '已公开到大厅（10 分钟）' };
          }
          return { ok: false, isPublic: false, text: String((j && j.error) || ('HTTP ' + res.status)) };
        }).catch(function () {
          return { ok: false, isPublic: false, text: '网络不可用，请稍后重试' };
        });
      }
      // v6.4: 先请**本机服务**发布（B）——它持 token、知道房间还在不在、每 60s PATCH 真实人数、
      // 房间没了立刻 DELETE。端点应答了却被拒 → 如实转达（不重复提交）；端点不存在 → 回落直连。
      return spPubCall('publish', body).then(function (sp) {
        if (sp && sp.ok) return { ok: true, isPublic: true, text: '已公开到大厅（服务端维护）' };
        if (sp) return { ok: false, isPublic: false, text: sp.error || '公开失败' };
        return directPost();
      });
    }

    // 公开 → 私密：服务端持有发布权时请服务端撤，否则 DELETE 带本地 X-Token
    if (spPub.on && spPub.code === c) {
      return spPubCall('unpublish', { on: false }).then(function (sp) {
        if (sp && sp.ok) return { ok: true, isPublic: false, text: '已取消公开' };
        if (sp) return { ok: false, isPublic: true, text: sp.error || '取消失败' };
        return { ok: false, isPublic: true, text: '本机服务不可用，请稍后重试' };
      });
    }
    var token = readTokens()[c];    var q = '?code=' + encodeURIComponent(c) + '&serverId=' + encodeURIComponent(serverId);
    var del;
    try {
      del = fetch(endpoint + q, { method: 'DELETE', cache: 'no-store', headers: { 'X-Token': token } });
    } catch (e) { return Promise.resolve({ ok: false, isPublic: true, text: '网络不可用，请稍后重试' }); }
    return del.then(function (r) {
      return r.json().then(function (j) { return { status: r.status, j: j }; });
    }).then(function (res) {
      var j = res.j || {};
      if (j && j.ok === true) {
        dropToken(c);
        return { ok: true, isPublic: false, text: '已转为私密' };
      }
      return { ok: false, isPublic: true, text: String((j && j.error) || ('HTTP ' + res.status)) };
    }).catch(function () {
      return { ok: false, isPublic: true, text: '网络不可用，请稍后重试' };
    });
  }

  /** GET a pinned room source; cb(state, list) with state ∈ 'ok' | 'error' | 'bad'. Never throws. */
  function fetchSource(url, cb, extra) {
    var u;
    try { u = new URL(String(url || '')); } catch (e) { cb('bad', []); return; }
    if (u.protocol !== 'https:' || isPrivateHost(u.hostname) || !ALLOWED_HOSTS[u.hostname.toLowerCase()]) {
      cb('bad', []);
      return;
    }
    var opts = { cache: 'no-store' };
    if (extra && extra.headers) opts.headers = extra.headers; // v5.2: 房间牌轮询带 X-Device（访客搭车计数）
    try { opts.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS); } catch (e) { /* older engine: no timeout */ }
    var run;
    try { run = fetch(u.toString(), opts); } catch (e) { cb('error', []); return; }
    run.then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (j) {
      var rooms = j && Array.isArray(j.rooms) ? j.rooms : [];
      var out = [];
      for (var i = 0; i < rooms.length; i++) {
        var room = sanitizeRoom(rooms[i]);
        if (room) out.push(room);
      }
      cb('ok', out, j); // v5.2.1: 第三参 = 原始响应（board 源据此读 visitors）
    }).catch(function () { cb('error', []); });
  }

  // ---- 跨服同盟匹配（v4.12）---------------------------------------------------------------------
  // 队列在自建 Worker 的独立 DO（/api/match，与房间牌隔离）：同难度凑 4 人成队 → 队内公开服成员
  // 当房主（公开服优先）→ 房主把建好的房间挂回队列 → 客人自动 joinOnOrigin 进场。只匹配真人，
  // 不加 AI；不要求同 app 版本（2026-10-05 决策）。全部走 extras → 纯热更。
  var MATCH_DIFFS = [['auto', '自动'], ['FUNNY', '标准'], ['NORMAL', '险境'], ['HARD', '绝境'], ['ABYSS', '终极']];
  /** 当前会话的匹配句柄 { id, token, role, difficulty }（模块级：面板重开不丢队列）。 */
  var matchHold = null;
  var matchJoinedCode = '';

  /** 场地类型：本机服务 → local；能对上签名清单的当前服务器 → public；其余（自动/自定义/网页）→ custom。 */
  function matchVenue() {
    try {
      if (window.shell && typeof window.shell.currentServerId === 'function') {
        var id = String(window.shell.currentServerId() || '');
        if (id === 'sp-phone-host' || id === 'local') return { kind: 'local', serverId: '' };
        if (id) return { kind: 'public', serverId: id };
      }
    } catch (e) { /* web / old shell */ }
    return { kind: 'custom', serverId: '' };
  }

  /** JSON call to the pinned BOARD host (房间牌/队列共用；同样的 host 守卫 + X-Token 头)。 */
  function boardJson(path, opts) {
    var o = opts || {};
    var url;
    try { url = new URL(BOARD.replace(/\/+$/, '') + path); } catch (e) { return Promise.reject(new Error('bad board url')); }
    if (url.protocol !== 'https:' || isPrivateHost(url.hostname) || !ALLOWED_HOSTS[url.hostname.toLowerCase()]) {
      return Promise.reject(new Error('host not allowed'));
    }
    var init = { method: o.method || 'GET', cache: 'no-store', headers: {} };
    if (o.body) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(o.body); }
    if (o.token) init.headers['X-Token'] = o.token;
    if (o.device) init.headers['X-Device'] = o.device; // v5.2: 访客搭车计数
    try { init.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS); } catch (e) { /* older engine: no timeout */ }
    return fetch(url.toString(), init).then(function (r) {
      return r.json().catch(function () { return {}; });
    });
  }

  /** Shaped room row: { code, server, serverId, note, leftSec, url, host, status, occupied,
   *  capacity, humans, mode, difficulty, difficultyName, live } (url/host '' when unusable). */
  function sanitizeRoom(raw) {
    if (!raw || typeof raw !== 'object') return null;
    // v4.9: roomId→code 适配（lunar/rinko 用 roomId；中转已归一，这里做防御性兜底）。
    var code = String(raw.code || raw.roomId || '').toUpperCase();
    if (!ROOM_CODE_RE.test(code)) return null;
    var url = typeof raw.url === 'string' ? raw.url : '';
    var host = '';
    if (url) {
      try {
        var u = new URL(url);
        if (u.protocol === 'https:' && !isPrivateHost(u.hostname)) {
          host = u.hostname.toLowerCase();
          url = u.toString();
        } else { url = ''; }
      } catch (e) { url = ''; }
    }
    var left = Number(raw.leftSec);
    var occupied = Number(raw.occupied);
    var capacity = Number(raw.capacity);
    var humans = Number(raw.humans);
    var status = typeof raw.status === 'string' ? raw.status.toLowerCase() : '';
    if (status !== 'waiting' && status !== 'full' && status !== 'playing' && status !== 'closed') status = '';
    return {
      code: code,
      server: typeof raw.server === 'string' ? raw.server : '',
      serverId: typeof raw.serverId === 'string' ? raw.serverId.slice(0, 64) : '',
      note: typeof raw.note === 'string' ? raw.note.slice(0, 80) : '',
      leftSec: isFinite(left) && left > 0 ? left : 0,
      url: url,
      host: host,
      // v4.9 字段适配（rainya 门户富字段 / lunar-rinko 经中转归一）：
      status: status,                                             // '' = 未知（房间牌行）
      occupied: Number.isInteger(occupied) && occupied >= 0 ? occupied : -1,
      capacity: Number.isInteger(capacity) && capacity > 0 ? capacity : -1,
      humans: Number.isInteger(humans) && humans >= 0 ? humans : -1,
      mode: raw.mode === 'coop' || raw.mode === 'solo' ? raw.mode : '',
      difficulty: typeof raw.difficulty === 'string' ? raw.difficulty.slice(0, 12) : '',
      difficultyName: typeof raw.difficultyName === 'string' ? raw.difficultyName.slice(0, 16) : '',
      live: raw.live === true,                                    // 实时大厅源：无 TTL，不显示倒计时
    };
  }

  // ---- 共享房间牌数据（模块级单例，v4.0） -------------------------------------------------------
  // 大厅面板与游戏大厅页（js/screens/lobby.js 的「公开房间」区块）共用同一份 merged 房间列表与
  // 15s 轮询；不再各自实现一套抓取。轮询仅在「有订阅者且页面可见」时布防（沿用 room-observer 的
  // 省电纪律）。rooms() 按抓取时刻现算剩余秒数，调用方自行 1s 重绘即可，不新增高频请求。
  var boardStore = {
    sources: {
      rainya: { state: 'idle', at: 0, list: [] },
      lunar: { state: COMMUNITY ? 'idle' : 'unavailable', at: 0, list: [] },
      rinko: { state: COMMUNITY ? 'idle' : 'unavailable', at: 0, list: [] },
      board: { state: BOARD ? 'idle' : 'unavailable', at: 0, list: [] },
    },
    subs: [],
    timer: null,
    version: 0,
  };

  /** merged 房间行：自建房间牌优先，其次社区源（rainya → lunar → rinko）；最快过期在前。 */
  function boardMerged() {
    var seen = {};
    var merged = [];
    var order = ['board', 'rainya', 'lunar', 'rinko'];
    var nowMs = monoNow(); // v7.0: 与 src.at 同为单调时钟，剩余秒数不被墙钟跳变污染
    for (var oi = 0; oi < order.length; oi++) {
      var src = boardStore.sources[order[oi]];
      for (var ri = 0; ri < src.list.length; ri++) {
        var r = src.list[ri];
        // v4.9: 去重键 = 主机 + 房号（不同服务器的同号房间是不同房间；旧实现只按 code 会误吞）。
        var key = (r.host || r.serverId || r.server || '?') + '#' + r.code;
        if (seen[key]) continue;
        seen[key] = 1;
        merged.push({
          code: r.code, server: r.server, serverId: r.serverId, note: r.note, url: r.url, host: r.host,
          status: r.status, occupied: r.occupied, capacity: r.capacity, humans: r.humans,
          mode: r.mode, difficulty: r.difficulty, difficultyName: r.difficultyName, live: r.live,
          left: r.leftSec - (nowMs - src.at) / 1000,
        });
      }
    }
    merged.sort(function (a, b) {
      // waiting 且可加入的排前面；其余按剩余时间升序（live 行无 TTL，视为常驻排后）。
      var aw = a.status === 'waiting' ? 0 : (a.live ? 2 : 1);
      var bw = b.status === 'waiting' ? 0 : (b.live ? 2 : 1);
      if (aw !== bw) return aw - bw;
      return (b.left || 0) - (a.left || 0);
    });
    if (merged.length > 60) merged = merged.slice(0, 60);
    return merged;
  }

  /** 列表状态（loading / 各源错误提示），面板与大厅页共用。 */
  function boardInfo() {
    var s = boardStore.sources;
    var srcNotes = [];
    if (!BOARD) srcNotes.push('房间牌待上线（自建聚合未部署）');
    if (COMMUNITY) {
      if (s.rainya.state === 'error') srcNotes.push('社区房间源（raiya）暂不可达');
      if (s.lunar.state === 'error') srcNotes.push('社区房间源（Lunar）暂不可达');
      if (s.rinko.state === 'error') srcNotes.push('社区房间源（梨子湖）暂不可达');
    } else {
      srcNotes.push('社区房间源需房间牌中转（未配置）');
    }
    if (BOARD && s.board.state === 'error') srcNotes.push('房间牌暂不可达');
    return {
      loading: s.rainya.state === 'loading' || s.lunar.state === 'loading'
        || s.rinko.state === 'loading' || s.board.state === 'loading',
      srcNotes: srcNotes,
    };
  }

  function boardNotify() {
    boardStore.version++;
    for (var i = 0; i < boardStore.subs.length; i++) {
      try { boardStore.subs[i](); } catch (e) { /* 订阅者自身异常不影响轮询 */ }
    }
  }

  function pullBoardSource(key, url, extra) {
    fetchSource(url, function (state, list, resp) {
      // v4.9: 复制全部键再替换一个 —— 旧实现重建对象时只列了 rainya/board，新增源会被整批丢弃。
      var next = {};
      var cur = boardStore.sources;
      for (var k in cur) if (Object.prototype.hasOwnProperty.call(cur, k)) next[k] = cur[k];
      next[key] = { state: state, at: monoNow(), list: list || [] }; // v7.0: 抓取时刻用单调时钟
      boardStore.sources = next;
      // v5.2.1 修复：visitors 在响应对象上，不在房间数组上（此前这个判断恒假 → 轮询永远不更新访客数）
      if (key === 'board' && resp && typeof resp.visitors === 'number') boardStore.visitors = resp.visitors;
      boardNotify();
    }, extra);
  }

  /** v5.2：本机设备号（跨域随机、无 PII）——随房间牌轮询上报，作为大厅访客键。 */
  function deviceKey() {
    var doc = null;
    try {
      if (window.spData && typeof window.spData.get === 'function') doc = JSON.parse(window.spData.get() || 'null');
      else if (window.__SP_DATA && typeof window.__SP_DATA.exportJSON === 'function') doc = JSON.parse(window.__SP_DATA.exportJSON() || 'null');
    } catch (e) { doc = null; }
    if (!doc) {
      try { doc = JSON.parse(localStorage.getItem('sp.player.v1') || 'null'); } catch (e) { doc = null; }
    }
    return doc && doc.deviceId ? String(doc.deviceId) : '';
  }

  /** 房间牌（60s 心跳；带 X-Device 搭车计访客）。 */
  function boardPull() {
    if (!pageVisible()) return; // v7.0: 仅可见页才探测
    if (!BOARD) return;
    var dev = deviceKey();
    pullBoardSource('board', BOARD.replace(/\/+$/, '') + '/api/rooms', dev ? { headers: { 'X-Device': dev } } : undefined);
    ownWatchArm(); // v6.3: 自己房间的上报由独立看表驱动，这里只确保它起来了
  }

  /** 社区源（300s；三源各自请求）。 */
  function communityPull() {
    if (!pageVisible()) return; // v7.0: 仅可见页才探测
    pullBoardSource('rainya', COMMUNITY ? COMMUNITY + 'rainya' : '');
    if (COMMUNITY) {
      pullBoardSource('lunar', COMMUNITY + 'lunar');
      pullBoardSource('rinko', COMMUNITY + 'rinko');
    }
  }

  /** v6.3：房态直播字段（首发 POST、60s 上报、面板刷新共用同一份推导——两处口径不许漂）。 */
  function liveFieldsFor(room) {
    var seats = room && Array.isArray(room.seats) ? room.seats.length : 0;
    var occupied = 0;
    if (room && Array.isArray(room.seats)) {
      for (var k = 0; k < room.seats.length; k++) {
        var seat = room.seats[k];
        if (!seat) continue;
        // 上游的座位条目是带 left 的对象；裸真值（老页面形态）也算占用。已离开的人不许占座。
        if (typeof seat === 'object' ? !seat.left : true) occupied++;
      }
    }
    return {
      mode: room && room.mode === 'solo' ? 'solo' : 'coop',
      status: room && room.inMatch ? 'playing' : (seats > 0 && occupied >= seats ? 'full' : 'waiting'),
      occupied: occupied,
      capacity: seats > 0 ? seats : 4,
    };
  }

  function currentRoom() {
    try { return storeRef && typeof storeRef.get === 'function' ? storeRef.get().room : null; } catch (e) { return null; }
  }

  /** 房间牌上「我这一行」（面板没开时可能是 null——那就只带确定知道的字段）。
   *  跨服同房号只认 serverId 命中的那一行，否则才退回第一条同码（避免拿别人家的备注/人数）。 */
  function ownRow(code) {
    var rows = boardMerged();
    var mine = boardServerId();
    var fallback = null;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || String(row.code || '').toUpperCase() !== code) continue;
      if (mine && row.serverId && String(row.serverId) === mine) return row;
      if (!fallback) fallback = row;
    }
    return fallback;
  }

  // ---- v6.3：自己房间的独立上报 -------------------------------------------------------------------
  // v5.2 的上报挂在房间牌心跳里（boardPull → boardSyncOwnRoom），只有面板/大厅页开着才跑：
  // 房主一关面板，网页上那一行就停在旧数字、直到 600s TTL 过期。现在拆成**独立看表**：
  // 条件 = 有房间牌 + 本机持有该房号 token + 在房里 + 前台，满足就每 60s PATCH 一次。
  // 服务端若自己持有了 token（B 方案），客户端这份 token 会是空的 → 这里自然不上报，
  // 两条发布路径天然互斥（「谁 POST，谁就是唯一发布者」）。
  // 4xx 语义：FORBIDDEN / NOT_FOUND = 我们已经不是发布者（token 被轮换 / 牌子已过期/被删）——
  // 清掉本地 token 并停表，不再每 60s 白打（旧实现把 4xx 当成功吞掉，会一直打到天荒地老）。
  var OWN_REPORT_MS = 60000;
  var own = { timer: null, code: '', lastError: '' };

  function ownState() {
    var room = currentRoom();
    var code = room && room.code ? String(room.code).toUpperCase() : '';
    var token = code ? readTokens()[code] : '';
    var visible = pageVisible(); // v7.0: 前台门禁
    return { ok: !!(BOARD && code && token && visible), code: code, room: room, token: token || '' };
  }

  /** 一拍上报（幂等；不满足条件就什么都不发）。返回 {ok, error}（error 空 = 成功）。 */
  function ownTick() {
    if (!pageVisible()) return Promise.resolve({ ok: false, error: 'skipped' }); // v7.0: 隐藏页零请求（含自检）
    spPubRefresh(); // v6.5: 每拍核对一次服务端发布状态（页面刷新后 spPub 是空的，也要能发现）
    var st;
    try { st = ownState(); } catch (e) { return Promise.resolve({ ok: false, error: 'exception' }); }
    if (!st.ok) return Promise.resolve({ ok: false, error: 'skipped' });
    var row = ownRow(st.code);
    var serverId = (row && row.serverId) || boardServerId();
    if (!serverId) return Promise.resolve({ ok: false, error: 'no-server-id' });
    var live = liveFieldsFor(st.room);
    var body = { code: st.code, serverId: serverId, mode: live.mode, status: live.status,
      occupied: live.occupied, capacity: live.capacity };
    // note 只在「知道网页那一行现在写的是什么」时才带。带一个我们并不知道的空串会把别人写的备注
    // 清掉（PATCH 现在「带上就覆盖」；大厅仓库正把缺省键改成「不动」，那时这里的省略就是安全的）。
    if (row && typeof row.note === 'string') body.note = row.note;
    own.code = st.code;
    return boardJson('/api/rooms', { method: 'PATCH', token: st.token, body: body }).then(function (j) {
      own.lastError = String((j && j.error) || '');
      if (own.lastError === 'FORBIDDEN' || own.lastError === 'NOT_FOUND') {
        dropToken(st.code); // 不再是发布者（token 被轮换 / 牌子过期）：清本地凭据，后续每拍自然跳过
      }
      return { ok: !!(j && j.ok), error: own.lastError };
    }, function () { own.lastError = 'network'; return { ok: false, error: 'network' }; });
  }

  /** 起看表（只在可见时；不可见时毫秒都不排 —— 「后台零请求」的既有纪律）。 */
  function ownWatchArm() {
    if (own.timer != null) return;
    if (!pageVisible()) return; // v7.0: 仅可见页才探测
    own.timer = setInterval(ownTick, OWN_REPORT_MS);
    ownTick(); // 立刻判一次：进房/刚公开不必等一整拍
  }

  function ownWatchDisarm() {
    if (own.timer != null) { clearInterval(own.timer); own.timer = null; }
  }

  function boardArm() {
    if (boardStore.timer != null || !boardStore.subs.length) return;
    if (!pageVisible()) return; // v7.0: 仅可见页才探测
    boardPull();
    communityPull();
    boardStore.timer = setInterval(boardPull, BOARD_REFRESH_MS);
    boardStore.timer2 = setInterval(communityPull, COMMUNITY_REFRESH_MS);
  }

  function boardDisarm() {
    if (boardStore.timer != null) { clearInterval(boardStore.timer); boardStore.timer = null; }
    if (boardStore.timer2 != null) { clearInterval(boardStore.timer2); boardStore.timer2 = null; }
  }

  /** 订阅房间牌更新（面板 / 大厅页共用）。返回取消订阅函数；无订阅者时自动停轮询。 */
  function subscribeRooms(fn) {
    if (typeof fn !== 'function') return function () {};
    boardStore.subs.push(fn);
    boardArm();
    return function () {
      var i = boardStore.subs.indexOf(fn);
      if (i >= 0) boardStore.subs.splice(i, 1);
      if (!boardStore.subs.length) boardDisarm();
    };
  }

  function roomsSnapshot() { return boardMerged(); }

  try {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { boardDisarm(); ownWatchDisarm(); }
      else { boardArm(); ownWatchArm(); drainProbes(); } // v7.0: 回前台立刻补一次（含挂起的探测）
    });
  } catch (e) { /* 非浏览器环境（测试）无 document */ }

  // v6.3：上报看表与面板无关，加载即起（不可见时 ownWatchArm 自己不发车）。
  ownWatchArm();
  spPubRefresh(); // v6.5: 启动时就把「服务端是否在替我们发布」问一次（刷新页面不丢状态）

  // ---- server cards (App: signed list; web: __SP_SHELL.getServers) --------------------------------

  /** Raw list rows, without the always-present community stations. */
  /** v5.3: 最近一次 getServerList() 的 loading（整条管线：拉取+验签+逐服探测；false ⟹ 探测已出终局）。 */
  var listLoading = false;
  /** v5.3.1: 最近一次快照的来源标签（「远端清单」= 本轮远端拉取+验签+探测全成功）。 */
  var listSource = '';

  function readListRows() {
    var rows = [];
    // App: signed list — names / measurements only (URLs stay inside the shell). While the list is
    // still loading the App contributes no rows (never mix in the web-only static lines).
    if (window.shell && typeof window.shell.getServerList === 'function') {
      try {
        var o = JSON.parse(window.shell.getServerList() || '{}');
        listLoading = !!(o && o.loading);
        listSource = String((o && o.source) || '');
        if (o && Array.isArray(o.entries)) {
          for (var i = 0; i < o.entries.length; i++) {
            var e = o.entries[i];
            if (!e || !e.id) continue;
            rows.push({
              id: String(e.id), name: String(e.name || e.id), note: String(e.note || ''),
              app: String(e.app || ''), rttMs: Number(e.rttMs), humans: Number(e.humans),
              reachable: e.reachable, probed: e.probed === true,
              enabled: e.enabled !== false, current: !!e.current, roomScoped: !!e.roomScoped,
              url: typeof e.url === 'string' ? e.url : '', host: String(e.host || '').toLowerCase(),
              missing: false,
            });
          }
        }
      } catch (e) { rows = []; }
      return rows;
    }
    // plain web fallback: __SP_SHELL.getServers() static lines (labels + urls; no measurements)
    try {
      var r = window.__SP_SHELL && typeof window.__SP_SHELL.getServers === 'function'
        ? window.__SP_SHELL.getServers() : null;
      var arr = typeof r === 'string' ? JSON.parse(r) : r;
      if (Array.isArray(arr)) {
        for (var j = 0; j < arr.length; j++) {
          var s = arr[j];
          if (!s) continue;
          rows.push({
            id: String(s.id || ('line' + j)), name: String(s.label || '自定义线路'), note: '',
            app: '', rttMs: -1, humans: -1, enabled: true, current: !!s.current,
            url: typeof s.url === 'string' ? s.url : '', host: '', missing: false,
          });
        }
      }
    } catch (e) { rows = []; }
    return rows;
  }

  function stationMatches(row, station) {
    var id = String(row.id || '').toLowerCase();
    var name = String(row.name || '').toLowerCase();
    var host = String(row.host || '').toLowerCase();
    if (host && host === station.host) return true;
    if (row.url) {
      try { if (new URL(row.url).hostname.toLowerCase() === station.host) return true; } catch (e) { /* ignore */ }
    }
    for (var i = 0; i < station.aliases.length; i++) {
      var al = station.aliases[i];
      if (id === al || id.indexOf(al) >= 0 || name.indexOf(al) >= 0) return true;
    }
    return false;
  }

  /** Cards = list rows + the two community stations (marked 「未在签名清单」 when the App list lacks them).
   *  Room-scoped (CF Workers) entries are hidden from the cards; the raw rows keep them so
   *  findServerIdForHost can still route room-board joins through joinOnOrigin. */
  function readStationRows() {
    var rows = readListRows().filter(function (r) { return r && !r.roomScoped; });
    var native = !!(window.shell && typeof window.shell.setServer === 'function');
    for (var i = 0; i < KNOWN_STATIONS.length; i++) {
      var st = KNOWN_STATIONS[i];
      var hit = false;
      for (var j = 0; j < rows.length && !hit; j++) hit = stationMatches(rows[j], st);
      if (hit) continue;
      rows.push({
        id: '', name: st.name, note: '', app: '', rttMs: -1, humans: -1,
        enabled: !native, current: false, url: st.url, host: st.host, missing: native,
      });
    }
    // v4.3: 把网页侧探测缓存填进缺延迟的行（社区站 / 自定义线路），彩点随 rttMs/reachable 渲染。
    for (var k = 0; k < rows.length; k++) applyProbe(rows[k]);
    return rows;
  }

  /** Room url host → signed-list entry id (used by joinRoom on the App). '' = not in the list. */
  function findServerIdForHost(host) {
    if (!host) return '';
    var h = String(host).toLowerCase();
    var rows = readListRows();
    var i;
    for (i = 0; i < rows.length; i++) {
      var e = rows[i];
      if (!e.id) continue;
      if (e.host && e.host === h) return e.id;
      if (e.url) {
        try { if (new URL(e.url).hostname.toLowerCase() === h) return e.id; } catch (err) { /* ignore */ }
      }
    }
    for (i = 0; i < KNOWN_STATIONS.length; i++) {
      var st = KNOWN_STATIONS[i];
      if (st.host !== h) continue;
      for (var j = 0; j < rows.length; j++) {
        var id = String(rows[j].id || '').toLowerCase();
        var name = String(rows[j].name || '').toLowerCase();
        for (var a = 0; a < st.aliases.length; a++) {
          var al = st.aliases[a];
          if (id === al || id.indexOf(al) >= 0 || name.indexOf(al) >= 0) return rows[j].id;
        }
      }
    }
    return '';
  }

  // ---- v4.3: 加入房间（模块级；大厅面板与游戏大厅页 PublicRooms 共用同一实现） --------------------
  // 原 joinRoom 是 LobbyPanel 内的局部函数，游戏大厅页 js/screens/lobby.js 的 PublicRooms 拿不到，
  // 只能退化为 join(room.code)（仅邀请码搜索，不会跳到房间所在服务器）。这里提升为模块级并挂到
  // window.__SP_LOBBY.joinRoom，让两处走完全一致的「跳服 + 加入」。store 在下方动态 import 后赋给
  // storeRef，故 inMatch / sessionEntered 可在模块级读取会话状态。
  var storeRef = null;

  /** 是否处于对局中（store 未就绪时保守返回 false）。 */
  function inMatch() {
    try { return !!(storeRef && storeRef.get().room && storeRef.get().room.inMatch); } catch (e) { return false; }
  }

  /** 本 tab 是否已进入当前会话（store.session.entered）。拿不到 store 时返回 false（保守：会布防）。 */
  function sessionEntered() {
    try { return !!(storeRef && storeRef.get().session && storeRef.get().session.entered); } catch (e) { return false; }
  }

  /** v4.3: joinOnOrigin 成功后布防「自动进入」（标题页 takeAutostart 消费一次）。
   *  alreadyEntered = 本 tab 已进入该会话 且 目标 id 就是当前服务器：此时重载会跳过标题页
   *  （sessionStorage 按 origin 保留），takeAutostart 永不消费、布防反而会残留到下次，故跳过。
   *  拿不到会话状态 / currentServerId 时保守布防（与 pickStation 的 setAutostart 一致）。 */
  function armAutostart(id) {
    var alreadyEntered = sessionEntered();
    if (alreadyEntered && id) {
      try {
        alreadyEntered = !!(window.shell && typeof window.shell.currentServerId === 'function'
          && String(window.shell.currentServerId() || '') === String(id));
      } catch (e) { alreadyEntered = false; }
    } else {
      alreadyEntered = false;
    }
    if (alreadyEntered) return;
    try { if (window.shell && typeof window.shell.setAutostart === 'function') window.shell.setAutostart(); } catch (e) { /* 旧壳：手动进入 */ }
  }

  /** v4.3: 加入房间（原 LobbyPanel.joinRoom 提升为模块级，逻辑不变）。返回 { ok, note }：
   *  ok=true 表示已发起加入（native 已切服 / web 已跳转）；note 为失败原因（成功为 ''）。 */
  function joinRoom(room) {
    if (!room || typeof room !== 'object') return { ok: false, note: '房间信息无效' };
    if (inMatch()) return { ok: false, note: '对局进行中，无法跨服加入。结束后再试。' };
    // v4.9: 状态门控 —— waiting 可加入；full/playing/closed 明确拒绝（UNKNOWN/'' 保持旧行为放行）。
    var st = String(room.status || '');
    if (st === 'playing') return { ok: false, note: '该房间对局进行中，暂不可加入。' };
    if (st === 'full') return { ok: false, note: '该房间已满。' };
    if (st === 'closed') return { ok: false, note: '该房间已关闭。' };
    // 房间 10 分钟内有效；过期行会落到目标服务器的「房间不存在」页 —— 本地拒绝并提示刷新。
    if (!room.live && !(Number(room.left) > 0)) return { ok: false, note: '该房间已过期（房间 10 分钟内有效），列表每 15 秒自动刷新，请稍候。' };
    var native = !!(window.shell && typeof window.shell.setServer === 'function');
    if (native) {
      var id = findServerIdForHost(room.host);
      // v4.3: 房间牌行可能只有 serverId（url 缺失 → host 为空）。serverId 提交时取
      // shell.currentServerId()，本身就是签名清单 id，故作为 host 查不到时的回退。
      if (!id && room.serverId) id = String(room.serverId);
      if (id) {
        var ok = true;
        try { ok = window.shell.joinOnOrigin(id, room.code) !== false; } catch (e) { ok = false; }
        if (ok) { armAutostart(id); return { ok: true, note: '' }; } // v4.3: 加入后自动进入
      }
      // v4.9: 未在签名清单（或原生跳转失败）→ 有 https 房间链接时走既有 custom: 通道：
      // loadBase 会把目标 host 设为 originHost，主帧仍由本地树渲染，?room= 由本地客户端
      // pendingJoin 自动加入，/ws 走网络到目标服务器（与「加入自定义服务器」同一条桥）。
      var cu = safeNavUrl(room.url);
      if (cu && cu.indexOf('https://') === 0) {
        try {
          window.shell.setServer('custom:' + withRoom(cu, room.code));
          armAutostart('');
          return { ok: true, note: '' };
        } catch (e) { /* fall through to the note below */ }
      }
      return { ok: false, note: id ? '加入失败：目标服务器当前不可用' : '该站未在签名清单（暂不能原生跳转）' };
    }
    var u = safeNavUrl(room.url);
    if (!u) return { ok: false, note: '该房间链接不可用' };
    try { location.href = u; } catch (e) { return { ok: false, note: '无法跳转，请稍后重试' }; }
    return { ok: true, note: '' };
  }

  // ---- v4.3: 网页侧延迟探测（社区站卡 / 自定义服务器；no-cors 计时，5 分钟内存缓存） --------------
  // dl.jiangjiangze.icu/servers 的做法：fetch(url, {mode:'no-cors'}) —— opaque 响应，任何 HTTP 状态
  // 都算一次成功计时，只有网络 / TLS 失败才算失败。warmup 1 次 + 2~3 次采样取中位数；失败保持 -1
  // （面板按 rttMs/reachable 渲染灰点「延迟未知」）。仅在大厅面板打开时探测一次，绝不常驻高频请求。
  var PROBE_TTL_MS = 300000;   // 5 分钟内存缓存
  var PROBE_TIMEOUT_MS = 4000; // 单次 no-cors 计时的兜底超时
  var probeCache = {};         // origin(lower) → { at, rttMs, reachable }

  // v7.0: 原来的局部 nowMs() 已并入模块级 monoNow()（同一口径，避免两套单调时钟漂移）。

  /** 单次 no-cors 计时：resolve 毫秒数（含任意 HTTP 状态），网络 / TLS 失败或超时 resolve -1。绝不抛。 */
  function timedProbe(url) {
    return new Promise(function (resolve) {
      var t0 = monoNow();
      var done = false;
      var timer = null;
      function finish(v) { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(v); }
      timer = setTimeout(function () { finish(-1); }, PROBE_TIMEOUT_MS);
      var run;
      try { run = fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' }); }
      catch (e) { finish(-1); return; }
      run.then(function () { finish(monoNow() - t0); }, function () { finish(-1); });
    });
  }

  /** 一个端点：warmup 1 次 + 3 次采样，取成功样本中位数；warmup 失败即视为不可达（-1）。 */
  function probeEndpoint(url) {
    return timedProbe(url).then(function (warm) {
      if (!(warm >= 0)) return -1;
      var jobs = [];
      for (var i = 0; i < 3; i++) jobs.push(timedProbe(url));
      return Promise.all(jobs).then(function (arr) {
        var ok = [];
        for (var j = 0; j < arr.length; j++) if (arr[j] >= 0) ok.push(arr[j]);
        if (!ok.length) return -1;
        ok.sort(function (a, b) { return a - b; });
        return Math.round(ok[Math.floor(ok.length / 2)]);
      });
    });
  }

  /** origin + probe 计时；probe 缺省 /healthz，失败再试根 /。始终 resolve 毫秒数或 -1，绝不抛。 */
  function probeOrigin(origin, probe) {
    var base = String(origin || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) return Promise.resolve(-1);
    var path = String(probe || '/healthz');
    return probeEndpoint(base + path).then(function (r) {
      return r >= 0 ? r : probeEndpoint(base + '/');
    });
  }

  function cacheProbe(origin, rttMs) {
    var k = String(origin || '').toLowerCase();
    if (!k) return;
    probeCache[k] = { at: monoNow(), rttMs: rttMs, reachable: rttMs >= 0 }; // v7.0: 缓存 TTL 用单调时钟
  }

  /** 缓存查询：命中且未过期返回 { rttMs, reachable }，否则 null。 */
  function probeLookup(origin) {
    var e = probeCache[String(origin || '').toLowerCase()];
    if (!e || monoNow() - e.at > PROBE_TTL_MS) return null; // v7.0: 与写入同为单调时钟
    return e;
  }

  /** 行的探测 origin：优先 host（社区站），否则从 url 取。拿不到返回 ''。 */
  function rowOrigin(row) {
    if (!row) return '';
    if (row.host) return 'https://' + String(row.host).toLowerCase();
    try {
      var u = new URL(String(row.url || ''));
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
      return u.origin;
    } catch (e) { return ''; }
  }

  /** 把缓存中的探测结果填进行（rttMs/reachable）；已有真实值（>0）或无缓存则不动。 */
  function applyProbe(row) {
    if (!row || Number(row.rttMs) > 0) return row;
    var origin = rowOrigin(row);
    var hit = origin ? probeLookup(origin) : null;
    if (hit) { row.rttMs = hit.rttMs; row.reachable = hit.reachable; }
    return row;
  }

  // ---- panel UI (dynamically imported so this file can stay a classic script) ---------------------

  Promise.all([
    // v7.4（审计 §3.2 M1–M4 / R-03）：shellPanels.js 自己用动态 import + 垫片解析上游依赖，先等它
    // 落地再注册/渲染面板，保证首帧就用真组件；任一依赖缺失只降级对应面板，不再整块静默消失。
    import('/js/ui/shellPanels.js').then(function (m) {
      var ready = typeof m.whenDepsReady === 'function' ? m.whenDepsReady() : null;
      return Promise.resolve(ready).then(function () { return m; });
    }),
    import('/js/ui/components.js'),
    import('/vendor/hooks.module.js'),
    import('/js/store.js'),
  ]).then(function (mods) {
    var registerPanel = mods[0].registerPanel;
    var QuickModes = mods[0].QuickModes; // v4.5: 服务器面板顶部两格（本机服务 / 自动线路），大厅复用
    var html = mods[1].html;
    var Modal = mods[1].Modal;
    var Button = mods[1].Button;
    var MicroLabel = mods[1].MicroLabel;
    var useState = mods[2].useState;
    var useEffect = mods[2].useEffect;
    var store = mods[3].store;
    // 回填 hooks 给 shellPanels.js 的依赖回退通道（审计 M1）：万一它自己的相对路径导入失败，
    // 还能拿到同一份 hooks，而不是退化成静态垫片。
    try { window.__SP_HOOKS = { useState: useState, useEffect: useEffect }; } catch (e) { /* no window */ }
    storeRef = store; // v4.3: 供模块级 inMatch / sessionEntered / joinRoom 读取会话状态
    injectLobbyStyles(); // v5.2: marquee 样式（一次性）

    // ---- v5.1 匹配落地钩子 -----------------------------------------------------------------------
    // 面板写下 pendingMatch 后（面板当场或切服重载后的任意页面加载）在这里消费：等游戏就绪
    // （已进入 + online + 拿到 playerId + 还没进任何房）→ net.request('room.create') coop →
    // 房间码出现即公开到大厅。全部在 extras，无游戏侧 patch；失败/超时都会清掉待办并提示。
    var pendingRunning = false;
    var pendingTimer = null;

    /** 轻提示（不依赖游戏 UI；4.2s 自动消失）。 */
    function spToast(text) {
      try {
        var el = document.createElement('div');
        el.textContent = String(text || '');
        el.style.cssText = 'position:fixed;left:50%;bottom:1.2rem;transform:translateX(-50%);z-index:99999;'
          + 'background:rgba(12,20,17,.92);color:#d8e3de;border:1px solid #2c3a35;border-radius:6px;'
          + 'padding:8px 14px;font-size:12px;pointer-events:none;max-width:80vw;text-align:center';
        document.body.appendChild(el);
        setTimeout(function () { try { el.remove(); } catch (e) { /* gone */ } }, 4200);
      } catch (e) { /* 无 DOM：静默 */ }
    }

    /** 'room' = 已有房（用户抢先）；'ready' = 可建房；'' = 还没就绪。 */
    function pendingReady() {
      try {
        var st = store.get();
        if (st.room) return 'room';
        var online = !!(st.connection && st.connection.status === 'online');
        var hasMe = !!(st.me && st.me.playerId != null);
        var entered = !!(st.session && st.session.entered);
        return (entered && hasMe && online) ? 'ready' : '';
      } catch (e) { return ''; }
    }

    function readPendingAny() {
      try {
        if (window.__SP_DATA && typeof window.__SP_DATA.peekMatchPending === 'function') {
          var v = window.__SP_DATA.peekMatchPending();
          if (v) return v;
        }
      } catch (e) { /* fall through */ }
      try {
        var raw = localStorage.getItem('sp.match.pending');
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }

    function clearPendingAny() {
      try {
        if (window.__SP_DATA && typeof window.__SP_DATA.clearMatchPending === 'function') window.__SP_DATA.clearMatchPending();
      } catch (e) { /* ignore */ }
      try { localStorage.removeItem('sp.match.pending'); } catch (e) { /* ignore */ }
    }

    /** 游戏「最近使用难度」（per-origin pref；跨服落地读不到就回落标准）。 */
    function lastUsedDifficulty() {
      try {
        var v = JSON.parse(localStorage.getItem('sp.pref.lobby.difficulty') || 'null');
        return ['FUNNY', 'NORMAL', 'HARD', 'ABYSS'].indexOf(v) >= 0 ? v : '';
      } catch (e) { return ''; }
    }

    /** 建房 → 等房号 → 公开到大厅。 */
    function doPendingCreate(pending) {
      var want = String((pending && pending.difficulty) || '').toUpperCase();
      var diff = ['FUNNY', 'NORMAL', 'HARD', 'ABYSS'].indexOf(want) >= 0 ? want : (lastUsedDifficulty() || 'FUNNY');
      import('/js/net.js').then(function (mod) {
        var net = (mod && mod.net) || (globalThis.__SP__ && globalThis.__SP__.net);
        if (!net || typeof net.request !== 'function') throw new Error('net unavailable');
        return net.request('room.create', { mode: 'coop', difficulty: diff });
      }).then(function () {
        var tries = 0;
        var t = setInterval(function () {
          tries++;
          var code = '';
          try { var r = store.get().room; code = r && r.code ? String(r.code).toUpperCase() : ''; } catch (e) { /* ignore */ }
          if (ROOM_CODE_RE.test(code)) {
            clearInterval(t);
            pendingRunning = false;
            var pr = null;
            try { pr = window.__SP_LOBBY && window.__SP_LOBBY.togglePublic(code); } catch (e) { pr = null; }
            if (pr && typeof pr.then === 'function') {
              pr.then(function (res) {
                spToast(res && res.ok ? '房间已创建并公开到大厅'
                  : ('房间已创建；公开未成功：' + String((res && res.text) || '可在大厅页手动公开')));
              }, function () { spToast('房间已创建；公开未成功，可在大厅页手动公开'); });
            } else {
              spToast('房间已创建；公开未成功，可在大厅页手动公开');
            }
            return;
          }
          if (tries > 12) { // ≈6s
            clearInterval(t);
            pendingRunning = false;
            spToast('房间已创建，但未及时拿到房号；可在大厅页手动公开');
          }
        }, 500);
      }).catch(function () {
        pendingRunning = false;
        spToast('自动创建房间失败，请手动创建（已切到所选服务器）');
      });
    }

    /** 落地入口：面板直接调（已在本服）或页面每次加载自动调（切服重载后）。 */
    function startPendingMatch(fromBoot) {
      if (pendingRunning) return;
      var pending = readPendingAny();
      if (!pending || !pending.ts) return;
      if (wallNow() - Number(pending.ts || 0) > 10 * 60 * 1000) { // 陈旧待办：清掉防冷启动误触发
        // v7.0: pending.ts 是**跨页面持久化**的绝对时间戳（写它的可能是上一次页面加载），故这里必须用
        // 墙钟口径 —— 走唯一的 wallNow()（= 单调 + 启动 epoch），而不是单调原点（每次加载会重置）。
        clearPendingAny();
        if (!fromBoot) spToast('上次的匹配待办已过期');
        return;
      }
      pendingRunning = true;
      var tries = 0;
      pendingTimer = setInterval(function () {
        tries++;
        var state = pendingReady();
        if (state === 'room') {
          clearInterval(pendingTimer);
          pendingRunning = false;
          clearPendingAny();
          spToast('你已在其他房间，本次匹配已取消');
          return;
        }
        if (state === 'ready') {
          clearInterval(pendingTimer);
          clearPendingAny(); // 先消费再建房：防重入，也防下次冷启动重放
          doPendingCreate(pending);
          return;
        }
        if (tries > 40) { // ≈30s
          clearInterval(pendingTimer);
          pendingRunning = false;
          clearPendingAny();
          spToast('等待服务器就绪超时，未自动建房');
        }
      }, 750);
    }

    // 每次页面加载都尝试消费一次（没有待办时立即返回；切服重载后即靠这里续上）
    try { setTimeout(function () { startPendingMatch(true); }, 1200); } catch (e) { /* ignore */ }

    /** v5.2：marquee 样式只注一次（纯 CSS、无测量、无定时器；reduced-motion 时回退静态）。 */
    function injectLobbyStyles() {
      try {
        if (document.getElementById('sp-lobby-v52-style')) return;
        var el = document.createElement('style');
        el.id = 'sp-lobby-v52-style';
        el.textContent = '.sp-mq{display:inline-block;overflow:hidden;white-space:nowrap;position:relative;min-width:0}'
          + '.sp-mq__run{display:inline-flex;animation:sp-mq-move var(--sp-mq-dur,9s) linear infinite;will-change:transform}'
          + '.sp-mq__run>span{padding-right:2em}'
          + '@keyframes sp-mq-move{from{transform:translateX(0)}to{transform:translateX(-50%)}}'
          + '@media (prefers-reduced-motion: reduce){.sp-mq__run{animation:none}}';
        (document.head || document.documentElement).appendChild(el);
      } catch (e) { /* 无 head：跳过（静态省略号仍可用） */ }
    }

    /** v5.2：单行文本格 —— 超过 limit 个字符时双份文本 + CSS 平移实现无缝左滚；短文本走省略号。
     *  时长按字符数估算（不测量 DOM）：3 字/秒，夹在 6–16s。 */
    function mqCell(text, opts) {
      var s = String(text == null ? '' : text);
      var o = opts || {};
      var base = 'flex:1;min-width:0;opacity:.55;';
      if (!s) return html`<span style=${base}></span>`;
      if (Array.from(s).length <= (o.limit || 14)) {
        return html`<span title=${s} style=${base + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'}>${s}</span>`;
      }
      var dur = Math.max(6, Math.min(16, Math.round(Array.from(s).length / 3)));
      return html`<span class="sp-mq" title=${s} style=${base}>
        <span class="sp-mq__run" style=${'--sp-mq-dur:' + dur + 's'}><span>${s}</span><span aria-hidden="true">${s}</span></span>
      </span>`;
    }

    /** v5.1 跨服匹配（找房优先 → 无房则第一人建房）：
     *  ① 房间里已有可加入的公开房（难度=自动则不限，否则同难度）→ 直接 joinRoom（复用跨服通道）；
     *  ② 没有 → 自动挑一台公开服务器（排除本机服务 / 房间制 / 无版本号，按版本 desc→RTT asc）
     *     → 写跨重载待办（sp.match.pending）→ setServer 切过去；落地钩子自动建房并公开到大厅。
     *  只匹配真人、不加 AI；本机服务永不做场地。 */
    function MatchSection() {
      var native = !!(window.shell && typeof window.shell.setServer === 'function');
      var [diff, setDiff] = useState('auto');
      var [view, setView] = useState('idle'); // idle|searching|joining|switching|error
      var [text, setText] = useState('');

      /** 难度标签（含 auto）。 */
      function diffLabel(d) {
        for (var i = 0; i < MATCH_DIFFS.length; i++) if (MATCH_DIFFS[i][0] === d) return MATCH_DIFFS[i][1];
        return d || '';
      }

      /** 语义化版本比较（"0.1.10" > "0.1.9"；缺失位按 0）。 */
      function cmpApp(a, b) {
        var pa = String(a || '').split('.'), pb = String(b || '').split('.');
        for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
          var va = parseInt(pa[i] || '0', 10) || 0, vb = parseInt(pb[i] || '0', 10) || 0;
          if (va !== vb) return va < vb ? -1 : 1;
        }
        return 0;
      }

      /** 找可加入的公开房：难度过滤（auto=不限）→ 人数多者优先 → 余量少者 → 新建在前。 */
      function findRoom() {
        var rows = [];
        try { rows = boardMerged(); } catch (e) { rows = []; }
        var hits = [];
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          if (!r || !ROOM_CODE_RE.test(String(r.code || ''))) continue;
          if (!roomJoinable(r)) continue;
          if (diff !== 'auto' && String(r.difficulty || '').toUpperCase() !== diff) continue;
          hits.push(r);
        }
        hits.sort(function (a, b) {
          var ao = Number(a.occupied) > 0 ? Number(a.occupied) : -1;
          var bo = Number(b.occupied) > 0 ? Number(b.occupied) : -1;
          if (ao !== bo) return bo - ao;                     // 人多 → 更快开局
          var al = Number(a.left) > 0 ? Number(a.left) : 1e9;
          var bl = Number(b.left) > 0 ? Number(b.left) : 1e9;
          return al - bl;                                    // 余量少（更早过期）→ 先照顾
        });
        return hits[0] || null;
      }

      /** 选场地：签名清单里 enabled、非房间制、有版本号、非本机服务 → 版本 desc → RTT asc。 */
      function pickVenue() {
        try {
          var o = JSON.parse((window.shell && window.shell.getServerList && window.shell.getServerList()) || '{}');
          var list = o && Array.isArray(o.entries) ? o.entries : [];
          var cand = [];
          for (var i = 0; i < list.length; i++) {
            var e = list[i];
            if (!e || !e.id) continue;
            if (e.enabled === false || e.roomScoped) continue;
            if (INTERNAL_SERVER_IDS[String(e.id).toLowerCase()]) continue;   // 永不含本机服务
            if (!e.app) continue;                                            // 无版本号不选
            if (e.probed === true && e.reachable === false) continue;        // 探测过且不可达
            cand.push(e);
          }
          cand.sort(function (a, b) {
            var c = cmpApp(b.app, a.app);
            if (c) return c;
            var ar = Number(a.rttMs) > 0 ? Number(a.rttMs) : 1e9;
            var br = Number(b.rttMs) > 0 ? Number(b.rttMs) : 1e9;
            return ar - br;
          });
          return cand[0] || null;
        } catch (e) { return null; }
      }

      function start() {
        if (inMatch()) { setView('error'); setText('对局中无法匹配，结束后再试'); return; }
        if (!BOARD) { setView('error'); setText('房间牌未配置'); return; }
        setView('searching');
        setText('正在查找可加入的房间…');
        boardPull(); // 手动刷新一次房间牌（社区源 + 自建），再评估
        setTimeout(function () {
          var room = findRoom();
          if (room) {
            setView('joining');
            setText('加入房间 ' + room.code + '（' + (room.server || '未知服务器') + '）…');
            var res = joinRoom(room);
            if (res && res.ok === false) { setView('error'); setText(String(res.note || '加入失败，请稍后重试')); }
            else { setView('idle'); setText(''); }
            return;
          }
          var venue = pickVenue();
          if (!venue) {
            setView('error');
            setText('没有可用的公开服务器（本机服务不能作为匹配场地），请先连接一台服务器');
            return;
          }
          // 第一人：写待办 → 切服 → 落地钩子自动建房并公开到大厅。
          // 待办走 player-data 的 pendingMatch（随玩家数据跨 origin）—— localStorage 按 origin 隔离，
          // 切服重载后就读不到了，不能当载体（子代理调研结论）。
          var pending = { difficulty: diff === 'auto' ? '' : diff, venueId: venue.id };
          var stored = false;
          try {
            stored = !!(window.__SP_DATA && typeof window.__SP_DATA.recordMatchPending === 'function'
              && window.__SP_DATA.recordMatchPending(pending));
          } catch (e) { stored = false; }
          if (!stored) {
            try {
              localStorage.setItem('sp.match.pending',
                JSON.stringify({ difficulty: pending.difficulty, venueId: venue.id, ts: wallNow() })); // v7.0: 持久化绝对时间戳 → 墙钟口径
            } catch (e) { /* 无存储 */ }
          }
          setView('switching');
          setText('你将是房主：已选「' + venue.name + '」并正在创建房间…');
          var alreadyHere = false;
          try {
            alreadyHere = String((window.shell && window.shell.currentServerId && window.shell.currentServerId()) || '') === venue.id;
          } catch (e) { alreadyHere = false; }
          if (alreadyHere) { startPendingMatch(false); return; } // 已在本服：不重载，直接建房
          try { window.shell.setServer(venue.id); } catch (e) { /* 老壳 */ }
          armAutostart('');
        }, 450);
      }

      function cancel() {
        setView('idle'); setText('');
        // 待办可能在 player-data（跨 origin 通道）也可能在 localStorage 兜底里，两处都清
        try { localStorage.removeItem('sp.match.pending'); } catch (e) { /* ignore */ }
        try {
          if (window.__SP_DATA && typeof window.__SP_DATA.clearMatchPending === 'function') window.__SP_DATA.clearMatchPending();
        } catch (e) { /* ignore */ }
      }

      var busy = view === 'searching' || view === 'joining' || view === 'switching';
      return html`<div class="set-row">
        <span class="set-row__label">同盟匹配<${MicroLabel}>MATCH<//></span>
        <div style="grid-column:2 / 4;min-width:0;display:flex;flex-direction:column;gap:6px">
          <div class="set-seg" role="radiogroup">
            ${MATCH_DIFFS.map(function (d) {
              return html`<button key=${d[0]} type="button" role="radio" aria-checked=${diff === d[0] ? 'true' : 'false'}
                class=${diff === d[0] ? 'is-on' : ''} disabled=${busy}
                onClick=${function () { setDiff(d[0]); }}>${d[1]}</button>`;
            })}
          </div>
          ${busy
            ? html`<button type="button" class="set-apply" style="border-color:#e06c5a;color:#e06c5a"
                onClick=${cancel}>取消匹配</button>`
            : html`<button type="button" class="set-apply" disabled=${!native}
                onClick=${start}>开始匹配（跨服 · 自动找房）</button>`}
          ${text ? html`<p class="set-hint set-hint--tight">${text}</p>` : null}
          <p class="set-hint set-hint--tight">
            优先加入别人公开到大厅的房间（难度「自动」= 不限）；没有房间时你会成为房主：自动选一台公开服务器（不含本机服务）并创建同盟房，随后自动公开给其他人加入。
          </p>
        </div>
      </div>`;
    }
    function LobbyPanel(props) {
      var onClose = props.onClose;
      var native = !!(window.shell && typeof window.shell.setServer === 'function');

      var [stations, setStations] = useState(readStationRows);
      var [code, setCode] = useState('');
      var [invite, setInvite] = useState({ state: 'idle', entries: [], note: '' });
      var [note, setNote] = useState('');
      var [, setTick] = useState(0); // 每秒重绘一次：本地 leftSec 倒计时（共享房间牌更新也走这里）

      // 加入自定义服务器（v3.8）: 一个按钮同时「立即加入」（切服）与「同步提交站点」；提交失败/入队
      // 不影响加入。无桥（网页 / 旧壳）时降级到站点入口。字段：地址(必填) / 名称(空则取域名) / 探针 / 备注。
      var [sName, setSName] = useState('');
      var [sUrl, setSUrl] = useState('');
      var [sProbe, setSProbe] = useState('/healthz');
      var [sNote, setSNote] = useState('');
      var [joinState, setJoinState] = useState({ state: 'idle', text: '', joined: false });
      // v3.9: 「加入自定义服务器」默认折叠（收起时只留一行 label + 展开按钮）。
      var [customOpen, setCustomOpen] = useState(false);
      // v4.3: 自定义服务器延迟（null=未探测 / -1=不可达），防抖探测后显示。
      var [customRtt, setCustomRtt] = useState(null);

      // 提交房间（v3.8 P2）: POST/DELETE 自建房间牌；token 存 localStorage['sp.lobby.tokens']。
      var [roomAct, setRoomAct] = useState({ state: 'idle', text: '' }); // 房间行操作（销毁/备注）的就地提示
      var [noteEdit, setNoteEdit] = useState(null); // { code, value } —— 备注编辑中的行
      var [roomFilter, setRoomFilter] = useState('all'); // v5.2: all | waiting（可加入）

      // the shell pushes a fresh verified list after refreshServerList() somewhere else
      useEffect(function () {
        var onServers = function () { setStations(readStationRows()); };
        window.addEventListener('sp-servers', onServers);
        return function () { window.removeEventListener('sp-servers', onServers); };
      }, []);

      // v4.3: 面板打开时对社区站卡做一次 no-cors 计时（5 分钟内存缓存），结果经 readStationRows →
      // applyProbe 填进 rttMs（彩点自动更新）。仅本面板挂载期间执行，不是高频轮询；失败保持 -1 灰点。
      useEffect(function () {
        var cancelled = false;
        var rows = readStationRows();
        var seen = {};
        var targets = [];
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          if (!row || row.id || !row.host) continue; // 只探社区站卡（id 为空、带 host）
          if (Number(row.rttMs) > 0) continue;       // 已有真实延迟（壳实测）不重复探
          var origin = rowOrigin(row);
          if (!origin || seen[origin] || probeLookup(origin)) continue;
          seen[origin] = 1;
          targets.push(origin);
        }
        if (!targets.length) return function () {};
        function fire() {
          if (cancelled) return;
          var pending = targets.length;
          for (var t = 0; t < targets.length; t++) {
            (function (origin) {
              probeOrigin(origin, '/healthz').then(function (rtt) {
                cacheProbe(origin, rtt);
                if (--pending <= 0 && !cancelled) setStations(readStationRows());
              });
            })(targets[t]);
          }
        }
        runProbe(fire); // v7.0: 隐藏页挂起，回到前台补发一次
        return function () { cancelled = true; };
      }, []);

      // v4.3: 自定义服务器延迟 —— 地址有效(https)时防抖 700ms 探测一次并缓存；结果就地显示。
      useEffect(function () {
        if (!customOpen) return undefined;
        var u = parseHttpUrl(String(sUrl || '').trim());
        if (!u || u.protocol !== 'https:') { setCustomRtt(null); return undefined; }
        var origin = u.origin;
        var hit = probeLookup(origin);
        if (hit) { setCustomRtt(hit.rttMs); return undefined; }
        var cancelled = false;
        var timer = setTimeout(function () {
          function fire() {
            if (cancelled) return;
            probeOrigin(origin, String(sProbe || '').trim() || '/healthz').then(function (rtt) {
              cacheProbe(origin, rtt);
              if (!cancelled) setCustomRtt(rtt);
            });
          }
          runProbe(fire); // v7.0: 隐藏页挂起，回到前台补发一次
        }, 700);
        return function () { cancelled = true; clearTimeout(timer); };
      }, [customOpen, sUrl, sProbe]);

      // 共享房间牌（v4.0）：面板只订阅模块级 boardStore 的更新并 1s 重绘倒计时；轮询由
      // subscribeRooms 统一布防/撤防（有订阅者且页面可见时 15s 一次），面板关闭即自动停。
      useEffect(function () {
        var unsub = subscribeRooms(function () { setTick(function (n) { return n + 1; }); });
        var tickTimer = setInterval(function () { setTick(function (n) { return n + 1; }); }, 1000);
        return function () { unsub(); clearInterval(tickTimer); };
      }, []);

      var normalized = String(code || '').toUpperCase().replace(/[^A-HJ-NP-Z]/g, '').slice(0, 4);

      function pickStation(row) {
        if (inMatch()) { setNote('对局进行中，无法切换服务器。结束后再切换。'); return; }
        if (native) {
          if (row.missing) { setNote('「' + row.name + '」未在签名清单（暂不能原生跳转）'); return; }
          if (!row.id || row.enabled === false) { setNote('该线路当前不可用'); return; }
          var ok = true;
          try { window.shell.setServer(row.id); } catch (e) { ok = false; }
          if (!ok) { setNote('切换失败，请稍后重试'); return; }
          try { if (typeof window.shell.setAutostart === 'function') window.shell.setAutostart(); } catch (e) { /* 旧壳：手动进入 */ }
          onClose();
          return;
        }
        if (!row.url) {
          if (!row.id || row.id === 'auto') { onClose(); return; } // 自动 = 当前 origin
          setNote('该线路暂无可跳转地址');
          return;
        }
        var u = safeNavUrl(row.url);
        if (!u) { setNote('该线路地址不可用'); return; }
        try { location.href = u; } catch (e) { setNote('无法跳转，请稍后重试'); }
      }

      function pickInvite(entry) {
        if (inMatch()) { setInvite({ state: 'note', entries: [], note: '对局进行中，无法跨服加入。结束后再试。' }); return; }
        if (native && entry && entry.id) {
          var ok = true;
          try { ok = window.shell.joinOnOrigin(entry.id, normalized) !== false; } catch (e) { ok = false; }
          if (!ok) { setInvite({ state: 'note', entries: [], note: '加入失败：目标服务器当前不可用' }); return; }
          armAutostart(entry.id); // v4.3: 加入后自动进入（与 pickStation 一致）
          onClose();
          return;
        }
        try { var link = withRoom(location.href, normalized); if (link) location.href = link; } catch (e) { /* ignore */ }
      }

      function probeInvite() {
        if (normalized.length !== 4) return;
        if (inMatch()) { setInvite({ state: 'note', entries: [], note: '对局进行中，无法跨服加入。结束后再试。' }); return; }
        if (!window.__SP_JOIN || typeof window.__SP_JOIN.resolveCode !== 'function') {
          setInvite({ state: 'note', entries: [], note: '探测模块未加载（较旧版本）' });
          return;
        }
        setInvite({ state: 'probing', entries: [], note: '正在跨服查找 ' + normalized + ' …' });
        window.__SP_JOIN.resolveCode(normalized).then(function (r) {
          if (r && r.kind === 'single') { pickInvite(r.entry); return; }
          if (r && r.kind === 'conflict') { setInvite({ state: 'pick', entries: r.entries || [], note: '' }); return; }
          if (r && r.kind === 'directory') {
            if (native && window.shell.join) { try { window.shell.join(); } catch (e) { /* ignore */ } }
            setInvite({ state: 'note', entries: [], note: '这是手机房主的房间：请在房号框直接输入 ' + normalized });
            return;
          }
          setInvite({ state: 'note', entries: [], note: (r && r.note) || '未找到该房间' });
        }).catch(function () {
          setInvite({ state: 'note', entries: [], note: '查找失败，请稍后重试' });
        });
      }

      // v4.3: 加入实现已提升为模块级 window.__SP_LOBBY.joinRoom（游戏大厅页 PublicRooms 共用）；
      // 面板这里只把结果映射为就地提示 / 关面板（成功即关）。
      function joinRoom(room) {
        var r = window.__SP_LOBBY.joinRoom(room);
        if (r && r.ok) { onClose(); return; }
        if (r && r.note) setNote(r.note);
      }

      // 加入自定义服务器（v3.8）：一次点击 = ① 立即加入（切服）② 同步提交站点。二者互不阻塞：
      // 提交失败 / 排队绝不撤销已完成的加入；结果就地显示为「已加入；同步结果：…」。
      // 服务端才是唯一校验方（不做 /healthz 预检）。
      function joinCustomServer() {
        if (joinState.state === 'sending') return;
        var raw = String(sUrl || '').trim();
        var u = parseHttpUrl(raw);
        if (!u) { setJoinState({ state: 'error', joined: false, text: '请填写有效的 http(s) 地址' }); return; }
        var host = u.hostname;
        var isHttps = u.protocol === 'https:';
        var name = String(sName || '').trim() || host;      // 名称空 → 域名兜底
        var probe = String(sProbe || '').trim() || '/healthz';
        var note = String(sNote || '').trim();
        var native = !!(window.shell && typeof window.shell.setServer === 'function');

        // ① 立即加入（custom: 只接受 https；非 https 明确提示且不切换）
        var joined = false;
        var hold = '';
        if (!isHttps) {
          hold = 'custom: 仅接受 https，非 https 地址不会切换';
        } else if (inMatch()) {
          hold = '对局进行中，无法切换服务器';
        } else if (native) {
          try { window.shell.setServer('custom:' + raw); joined = true; } catch (e) { joined = false; }
          if (joined) {
            try { if (typeof window.shell.setAutostart === 'function') window.shell.setAutostart(); } catch (e) { /* 旧壳：手动进入 */ }
          }
        } else {
          joined = true; // 网页：稍后 location.href 跳转
        }

        // ② 同步到清单（提交站点）
        var prefix = joined ? '已加入；' : (hold ? hold + '；' : '未切换；');
        // v4.7: 提交半段守卫 —— 加入 LAN 服务器仍允许（parseHttpUrl 故意放行私网，用户自己的线路），
        // 但「提交到公共清单」必须拒绝私网/环回；对局中也禁止提交。跳过时只影响同步结果文案。
        var blockSubmit = '';
        if (isPrivateHost(host)) {
          blockSubmit = '127.0.0.1 / 内网地址不能提交到公共清单';
        } else if (inMatch()) {
          blockSubmit = '对战中无法提交服务器';
        }
        if (blockSubmit) {
          setJoinState({ state: 'error', joined: joined, text: prefix + '同步结果：' + blockSubmit });
          finishJoin(joined);
          return;
        }
        var payload = { servers: [{ name: name, url: raw, probe: probe, note: note }] };
        setJoinState({ state: 'sending', joined: joined, text: prefix + '同步中…' });
        // 桥调用同步阻塞（最长 6s）：先让「同步中…」渲染一帧，再进入阻塞调用。
        setTimeout(function () {
          if (!(window.shell && typeof window.shell.submitServer === 'function')) {
            setJoinState({ state: 'degraded', joined: joined, text: prefix + '同步结果：当前版本不支持应用内提交，请在 dl.jiangjiangze.icu/servers 提交' });
            finishJoin(joined);
            return;
          }
          var raw2;
          try {
            raw2 = window.shell.submitServer(JSON.stringify(payload));
          } catch (e) {
            setJoinState({ state: 'error', joined: joined, text: prefix + '同步结果：网络不可用，请稍后重试' });
            finishJoin(joined);
            return;
          }
          var parsed = null;
          try { parsed = JSON.parse(String(raw2 == null ? '' : raw2)); } catch (e2) { parsed = null; }
          if (parsed && parsed.ok === true) {
            var hint = String(parsed.hint || '已提交');
            var q = Number(parsed.queuePosition) || 0;
            setJoinState({ state: 'ok', joined: joined, text: prefix + '同步结果：' + hint + (q > 0 ? ' · 队列第 ' + q + ' 位' : '') });
          } else if (parsed && parsed.ok === false) {
            setJoinState({ state: 'error', joined: joined, text: prefix + '同步结果：' + String(parsed.error || '提交失败') });
          } else {
            var rawText = String(raw2 == null ? '' : raw2).slice(0, 200);
            setJoinState({ state: 'error', joined: joined, text: prefix + '同步结果：' + (rawText || '网络不可用，请稍后重试') });
          }
          finishJoin(joined);
        }, 50);
      }

      // 加入后的收尾：native 关面板 / 网页跳转；留一点时间让「同步结果」显示出来。
      function finishJoin(joined) {
        if (!joined) return;
        var native = !!(window.shell && typeof window.shell.setServer === 'function');
        setTimeout(function () {
          if (native) {
            try { onClose(); } catch (e) { /* ignore */ }
            return;
          }
          var u = parseHttpUrl(String(sUrl || '').trim());
          if (u) { try { location.href = u.toString(); } catch (e) { /* ignore */ } }
        }, 1200);
      }

      // ---- 提交房间 / 销毁（v3.8 P2；BOARD 直连 fetch，CORS *，不走 submitServer 桥）-----------------

      function currentRoomCode() {
        try {
          var r = store.get().room;
          return r && r.code ? String(r.code).toUpperCase() : '';
        } catch (e) { return ''; }
      }

      function currentServerId() {
        try {
          if (window.shell && typeof window.shell.currentServerId === 'function') {
            var s = String(window.shell.currentServerId() || '').trim();
            if (s) return s;
          }
        } catch (e) { /* ignore */ }
        try {
          var host = String(location.host || '');
          // v4.7: 环回/私网兜底（本机页直开）返回 ''——发布路径有空值拦截（v5.1 起本机服务专属文案）
          if (!host || isPrivateHost(hostOfAuthority(host))) return '';
          return host;
        } catch (e) { return ''; }
      }

      /** Deep link for the board, ONLY when this page is a public https origin (the board rejects
       *  private hosts, so we omit the field rather than let the whole submit fail). */
      function publicRoomUrl(code) {
        try {
          var origin = String(location.origin || '');
          if (origin.indexOf('https://') !== 0) return '';
          if (isPrivateHost(new URL(origin).hostname)) return '';
          return withRoom(origin + String(location.pathname || '/'), code);
        } catch (e) { return ''; }
      }

      function boardEndpoint(path) { return BOARD.replace(/\/+$/, '') + path; }

      /** v5.1: 编辑自己房间的备注（Worker PATCH /api/rooms，token+serverId 校验，只改 note）。 */
      function saveNote(room) {
        var token = readTokens()[room.code];
        var value = noteEdit && noteEdit.code === room.code ? String(noteEdit.value || '').trim().slice(0, 40) : '';
        if (!token) { setNoteEdit(null); return; }
        var serverId = String(room.serverId || boardServerId() || '');
        if (!serverId) { setRoomAct({ state: 'error', text: '无法确定该房间的服务器' }); return; }
        setRoomAct({ state: 'sending', text: '保存备注…' });
        var run;
        try {
          run = fetch(boardEndpoint('/api/rooms'), {
            method: 'PATCH', cache: 'no-store',
            headers: { 'content-type': 'application/json', 'X-Token': token },
            body: JSON.stringify({ code: room.code, serverId: serverId, note: value }),
          });
        } catch (e) { setRoomAct({ state: 'error', text: '网络不可用，请稍后重试' }); return; }
        run.then(function (r) {
          return r.json().then(function (j) { return { status: r.status, j: j }; });
        }).then(function (res) {
          var j = res.j || {};
          if (j && j.ok === true) {
            setNoteEdit(null);
            setRoomAct({ state: 'ok', text: '备注已更新' });
            boardPull();
            return;
          }
          setRoomAct({ state: 'error', text: String((j && j.message) || (j && j.error) || ('HTTP ' + res.status)) });
        }).catch(function () { setRoomAct({ state: 'error', text: '网络不可用，请稍后重试' }); });
      }

      function destroyRoom(room) {
        var token = readTokens()[room.code];
        if (!token) return;
        var serverId = String(room.serverId || currentServerId() || '');
        if (!serverId) { setRoomAct({ state: 'error', text: '无法确定该房间的服务器' }); return; }
        var q = '?code=' + encodeURIComponent(room.code) + '&serverId=' + encodeURIComponent(serverId);
        var run;
        try {
          run = fetch(boardEndpoint('/api/rooms' + q), {
            method: 'DELETE', cache: 'no-store', headers: { 'X-Token': token },
          });
        } catch (e) { setRoomAct({ state: 'error', text: '网络不可用，请稍后重试' }); return; }
        run.then(function (r) {
          return r.json().then(function (j) { return { status: r.status, j: j }; });
        }).then(function (res) {
          var j = res.j || {};
          if (j && j.ok === true) {
            dropToken(room.code);
            setRoomAct({ state: 'ok', text: '已销毁' });
            boardPull();
            return;
          }
          if (j && j.error === 'NOT_FOUND') { // 已过期/已被清理：顺手丢掉本地 token
            dropToken(room.code);
            setRoomAct({ state: 'ok', text: '该房间已过期或不存在' });
            boardPull();
            return;
          }
          setRoomAct({ state: 'error', text: String((j && j.error) || ('HTTP ' + res.status)) });
        }).catch(function () { setRoomAct({ state: 'error', text: '网络不可用，请稍后重试' }); });
      }

      // merged room rows: 共享 boardStore（自建房间牌优先，其次社区聚合；最快过期在前）
      var merged = boardMerged();
      var info = boardInfo();
      var tokens = readTokens(); // 自己的房间（本机 token）→ 行内显示「销毁」
      var srcNotes = info.srcNotes;
      var loading = info.loading;
      // v5.2: 页头统计 + 筛选（rainya 式：全部 / 可加入）
      var waitingCount = merged.filter(function (r) { return roomJoinable(r); }).length;
      var shown = roomFilter === 'waiting'
        ? merged.filter(function (r) { return roomJoinable(r); })
        : merged;
      var emptyText = loading ? '正在获取房间列表…'
        : (merged.length ? '当前筛选下暂无房间' : '暂无公开房间');
      var roomRowStyle = 'display:flex;align-items:center;gap:8px;padding:6px 2px 5px;'
        + 'border-bottom:1px solid #1e2823;font-size:12px';

      // ---- v4.9: 房间行的状态/席位/难度（rainya 门户富字段 + 中转归一的 live 行共用） ----------
      /** 不可加入的原因文案；'' = 可加入。 */
      function roomStateLabel(r) {
        var st = String(r.status || '');
        if (st === 'full') return '已满';
        if (st === 'playing') return '对局中';
        if (st === 'closed') return '已关闭';
        if (!r.live && !(Number(r.left) > 0)) return '已过期';
        return '';
      }
      function roomJoinable(r) {
        var st = String(r.status || '');
        if (st === 'full' || st === 'playing' || st === 'closed') return false;
        if (r.live) return true;          // 实时大厅行无 TTL
        return Number(r.left) > 0;
      }
      /** 席位点：● 已占 / ○ 空位（仅 capacity 有效时渲染），标题写明数字。 */
      function roomSeatDots(r) {
        var cap = Number(r.capacity);
        if (!(cap > 0) || cap > 8) return null;
        var occ = Number(r.occupied) >= 0 ? Number(r.occupied) : (Number(r.humans) >= 0 ? Number(r.humans) : 0);
        if (occ > cap) occ = cap;
        var s = '';
        for (var i = 0; i < cap; i++) s += i < occ ? '●' : '○';
        return { text: s, title: '席位 ' + occ + '/' + cap };
      }
      /** 难度短名：优先中文 difficultyName，其次枚举映射。 */
      function roomDiff(r) {
        if (r.difficultyName) return r.difficultyName;
        var d = String(r.difficulty || '').toUpperCase();
        if (d === 'FUNNY') return '标准';
        if (d === 'NORMAL') return '险境';
        if (d === 'HARD') return '绝境';
        if (d === 'ABYSS') return '终极';
        return '';
      }

      function card(row) {
        var dim = row.missing || row.enabled === false;
        var dot = rttDot(row.rttMs, row.enabled, row.reachable, listLoading);
        return html`<div key=${row.id || row.name} class=${'sp-srv-cell' + (row.current ? ' is-cur' : '') + (dim ? ' is-off' : '')}>
          <button type="button" class="sp-srv-main" title=${(row.note ? row.note + ' · ' : '') + row.name}
            onClick=${function () { pickStation(row); }}>
            ${row.current ? html`<span class="sp-srv-cur"></span>` : null}
            <span class="sp-srv-name">${row.name}${row.missing ? ' · 未在签名清单' : ''}</span>
            ${row.app ? html`<span class="sp-srv-ver">${fmtApp(row.app)}</span>` : null}
            <span class="sp-srv-rtt" style=${'flex:0 0 auto;width:.11rem;height:.11rem;border-radius:50%;background:' + dot.color} title=${dot.title}></span>
          </button>
        </div>`;
      }

      /** v5.3: 网格行 = 已签名 + （探测完成且有版本号，或探测尚未出终局）。
       *  v5.3.1（审查发现#2）：「探测本轮真的成功」只认 Java 的 source 标签 —— 远端拉取+验签+探测
       *  全成功才置「远端清单」（缓存/旧缓存/内置都不是本轮的证明，刷新失败时旧快照仍会回
       *  loading=false，用缓存 app 当证明会在离线时把全表误藏）。 */
      function stationCards() {
        var base = stations.filter(function (r) { return !r.missing; });
        var freshRemote = listSource === '远端清单';
        var anyVersioned = false;
        for (var i = 0; i < base.length; i++) if (base[i].app) { anyVersioned = true; break; }
        var settled = !listLoading && freshRemote && anyVersioned;
        return settled ? base.filter(function (r) { return !!r.app; }) : base;
      }

      return html`<${Modal} open=${true} onClose=${onClose} title="大厅" micro="LOBBY" width="10.4rem"
        actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
        <div class="set-list">
          ${typeof QuickModes === 'function' ? html`<div class="set-row">
            <span class="set-row__label">快捷模式<${MicroLabel}>QUICK<//></span>
            <div style="grid-column:2 / 4;min-width:0">
              <div class="sp-srv-grid"><${QuickModes} onClose=${onClose} onNote=${setNote} locked=${inMatch()} /></div>
            </div>
          </div>` : null}
          ${note ? html`<p class="set-hint set-hint--tight">${note}</p>` : null}

          <div class="set-row">
            <span class="set-row__label">服务器<${MicroLabel}>SERVERS<//></span>
            <div style="grid-column:2 / 4;min-width:0">
              ${/* v4.9: 未在签名清单的站点不再显示（但仍在后台可用 —— 房间照常列出，加入走 custom: 兑底通道）。
                    v5.3: 不返回版本号的服务器隐藏 —— 改为纯 JS 判定（不再依赖 APK 侧 probed 标志，热更即可生效）：
                    ① 整条探测管线结束（!listLoading）② 至少一台拿到了版本号（证明探测真的跑过，离线/失败时
                    不误伤全表）→ 此时 !app 的行隐藏。「自动线路」「本机服务」在顶部固定两格，天然例外。 */''}
              <div class="sp-srv-grid">${stationCards().map(card)}</div>
              <p class="set-hint set-hint--tight">
                点一张卡 = 切换到该服务器并自动进入${native ? '' : '（网页版 = 跳转到该线路）'}。
              </p>
            </div>
          </div>

          <${MatchSection} />

          <div class="set-row">
            <span class="set-row__label">加入自定义服务器<${MicroLabel}>CUSTOM SERVER<//></span>
            ${customOpen ? html`<div style="grid-column:2 / 4;min-width:0;display:flex;flex-direction:column;gap:6px">
              <input class="set-input" type="url" value=${sUrl} placeholder="https://your-server.example（必填）"
                onInput=${function (e) { setSUrl(e.currentTarget.value); }} />
              <input class="set-input" type="text" value=${sName} maxLength="60"
                placeholder="名称（可选，留空则自动取该地址的域名）"
                onInput=${function (e) { setSName(e.currentTarget.value); }} />
              <input class="set-input" type="text" value=${sProbe} placeholder="探针路径（默认 /healthz）"
                onInput=${function (e) { setSProbe(e.currentTarget.value); }} />
              <input class="set-input" type="text" value=${sNote} maxLength="120" placeholder="备注（可选）"
                onInput=${function (e) { setSNote(e.currentTarget.value); }} />
              <button type="button" class="set-apply" disabled=${joinState.state === 'sending'}
                onClick=${joinCustomServer}>${joinState.state === 'sending' ? '加入中…' : '加入自定义服务器'}</button>
              <button type="button" class="set-apply" onClick=${function () { setCustomOpen(false); }}>收起</button>
            </div>` : html`<button type="button" class="set-apply"
              onClick=${function () { setCustomOpen(true); }}>加入自定义服务器</button>`}
          </div>
          ${customOpen && joinState.state !== 'idle' ? html`<p class="set-hint set-hint--tight">${joinState.text}</p>` : null}
          ${customOpen && customRtt != null ? html`<p class="set-hint set-hint--tight">自定义服务器延迟：${customRtt >= 0 ? fmtRtt(customRtt) : '无法连接'}</p>` : null}
          ${customOpen ? html`<p class="set-hint set-hint--tight">
            点按即「加入」并同时同步到清单：加入 = 立即切换为该地址（custom: 仅接受 https，非 https 会明确提示且不切换）；同步 = 提交站点，由服务端实测校验、维护者审核后进入签名清单。提交失败或排队不影响加入。
          </p>` : null}


          <div class="set-row">
            <span class="set-row__label">邀请码<${MicroLabel}>INVITE<//></span>
            <input class="set-input" type="text" value=${code} placeholder="4 位字母" maxLength="4"
              style="text-transform:uppercase;letter-spacing:.08em"
              onInput=${function (e) { setCode(e.currentTarget.value); }} />
            <button type="button" class="set-apply" disabled=${normalized.length !== 4 || invite.state === 'probing'}
              onClick=${probeInvite}>${invite.state === 'probing' ? '查找中…' : '查找'}</button>
          </div>
          ${invite.state === 'pick' ? html`<div class="set-row">
            <span class="set-row__label">选择服务器<${MicroLabel}>PICK<//></span>
            <div>${invite.entries.map(function (e) {
              return html`<button key=${e.id} type="button"
                style=${'display:block;width:100%;margin:4px 0;padding:8px 10px;background:transparent;'
                  + 'border:1px solid #2c3a35;color:#d8e3de;border-radius:4px;font-size:13px;cursor:pointer;text-align:left'}
                onClick=${function () { pickInvite(e); }}>
                ${e.name} · ${fmtRtt(e.rttMs)}${e.note ? ' · ' + e.note : ''}
              </button>`;
            })}</div>
          </div>` : null}
          ${invite.note ? html`<p class="set-hint set-hint--tight">${invite.note}</p>` : null}

          <div class="set-row">
            <span class="set-row__label">房间列表<${MicroLabel}>ROOMS<//></span>
            <div style="grid-column:2 / 4;min-width:0">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
                <span style="opacity:.7">共 ${merged.length} 个 · 可加入 ${waitingCount}</span>
                <span style="margin-left:auto;display:inline-flex;gap:4px">
                  <button type="button" class="set-apply" style=${roomFilter === 'all' ? '' : 'opacity:.55'}
                    onClick=${function () { setRoomFilter('all'); }}>全部</button>
                  <button type="button" class="set-apply" style=${roomFilter === 'waiting' ? '' : 'opacity:.55'}
                    onClick=${function () { setRoomFilter('waiting'); }}>可加入</button>
                </span>
              </div>
              ${shown.length ? html`<div>${shown.map(function (r) {
                var state = roomStateLabel(r);
                var can = roomJoinable(r);
                var seats = roomSeatDots(r);
                var diff = roomDiff(r);
                return html`<div key=${(r.host || r.serverId || '?') + '#' + r.code}>
                  <div style=${roomRowStyle + (can ? '' : ';opacity:.6')}>
                  <b style="min-width:2.6em;letter-spacing:.04em;color:#4ed8af">${r.code}</b>
                  ${seats ? html`<span class="num" title=${seats.title} style="color:#8a9a93;white-space:nowrap;letter-spacing:.02em">${seats.text}</span>` : null}
                  ${diff ? html`<span style="opacity:.6;white-space:nowrap">${diff}</span>` : null}
                  ${mqCell([r.note, r.server].filter(Boolean).join(' · ') || '—', { limit: 14 })}
                  <span style=${'white-space:nowrap;font-variant-numeric:tabular-nums;color:' + ((r.live || Number(r.left) > 60) ? '#8a9a93' : '#e06c5a')}>${state || (r.live ? '在线' : '剩 ' + fmtLeft(r.left))}</span>
                  ${can
                    ? html`<button type="button" class="set-apply" onClick=${function () { joinRoom(r); }}>加入</button>`
                    : html`<button type="button" class="set-apply" disabled=${true} style="opacity:.45;cursor:not-allowed">${state || '不可加入'}</button>`}
                  ${tokens[r.code] ? html`<button type="button" class="set-apply" style="border-color:#4ed8af;color:#4ed8af"
                    onClick=${function () { setNoteEdit({ code: r.code, value: String(r.note || '') }); }}>备注</button>` : null}
                  ${tokens[r.code] ? html`<button type="button" class="set-apply" style="border-color:#e06c5a;color:#e06c5a" onClick=${function () { destroyRoom(r); }}>销毁</button>` : null}
                  </div>
                  ${noteEdit && noteEdit.code === r.code ? html`<div style="display:flex;gap:6px;align-items:center;padding:4px 0 6px 12px;border-bottom:1px solid #1e2823">
                    <input class="set-input" type="text" maxLength="40" value=${noteEdit.value}
                      placeholder="备注（≤40 字，所有人可见）"
                      onInput=${function (e) { setNoteEdit({ code: r.code, value: e.currentTarget.value }); }} />
                    <button type="button" class="set-apply" disabled=${roomAct.state === 'sending'}
                      onClick=${function () { saveNote(r); }}>保存</button>
                    <button type="button" class="set-apply" onClick=${function () { setNoteEdit(null); }}>取消</button>
                  </div>` : null}
                </div>`;
              })}</div>` : html`<p class="set-hint set-hint--tight">${emptyText}</p>`}
              ${srcNotes.map(function (t, i) { return html`<p key=${'sn' + i} class="set-hint set-hint--tight">${t}</p>`; })}
              <p class="set-hint set-hint--tight">
                每 15 秒刷新；仅面板打开且页面可见时轮询。房间信息来自各站公开接口，加入仍以目标服务器为准。
              </p>
              ${roomAct.state !== 'idle' && roomAct.text ? html`<p class="set-hint set-hint--tight">${roomAct.text}</p>` : null}
            </div>
          </div>

          ${window.shell && typeof window.shell.lanScan === 'function' ? html`<${LanSection} onClose=${onClose} />` : null}

          <p class="set-hint">非官方同人作品 · 房间信息来自各站公开接口（只读）；不代登录、不代转发。加入失败（房满 / 已开始）由目标服务器照常提示。</p>
        </div>
      <//>`;
    }

    // ---- v5.4: 局域网发现小节（仅新 APK 提供 window.shell.lanScan 时渲染） -----------------------
    // 绝不自动扫描、不轮询：只有用户点「扫描局域网」才发起一次，结果由 Java 经 __SP_LAN.onFound
    // 异步回吐。旧 APK 无 lanScan → 整个小节不渲染（不显示任何占位）。
    var lanTimer = null;
    var lanSeq = 0; // 当前这一轮扫描的序号（审查发现#4：迟到结果按序号丢弃）

    /** 席位点：● 已占 / ○ 空位（局域网行给的是 seats 总数 + humans 已占，与 roomSeatDots 同口径）。 */
    function lanSeatDots(r) {
      var cap = Number(r.seats);
      if (!(cap > 0) || cap > 8) return null;
      var occ = Number(r.humans) >= 0 ? Number(r.humans) : 0;
      if (occ > cap) occ = cap;
      var s = '';
      for (var i = 0; i < cap; i++) s += i < occ ? '●' : '○';
      return { text: s, title: '席位 ' + occ + '/' + cap };
    }
    /** 难度短名：与房间列表同一映射。 */
    function lanDiff(r) {
      var d = String((r && r.difficulty) || '').toUpperCase();
      if (d === 'FUNNY') return '标准';
      if (d === 'NORMAL') return '险境';
      if (d === 'HARD') return '绝境';
      if (d === 'ABYSS') return '终极';
      return d || '';
    }

    function LanSection(props) {
      var onClose = props.onClose;
      var [lan, setLan] = useState({ state: 'idle', rooms: [], note: '' }); // idle | scanning | done

      useEffect(function () {
        if (!window.__SP_LAN || typeof window.__SP_LAN.onScan !== 'function') return undefined;
        // 审查发现#4：只采纳当前这一轮的结果（__SP_LAN.begin 给的序号），上一轮迟到的回吐直接丢弃，
        // 否则旧结果会替换当前列表、并清掉当前这一轮的超时兜底。
        window.__SP_LAN.onScan(function (rooms, data, seq) {
          if (seq !== undefined && seq !== lanSeq) return;
          if (lanTimer) { clearTimeout(lanTimer); lanTimer = null; }
          // 审查发现（PR#23）：扫描失败与「真的没有房间」必须分开报 —— Java 侧现在回吐
          // probed/answered/errors/unreachable，空列表 + unreachable 就是扫描没打通，
          // 不能显示成「局域网内没有发现房间」误导用户。
          var note = '';
          if (data && data.ok === false) note = '扫描失败，请稍后重试';
          else if (data && data.unreachable === true) note = '扫描没打通：可能不在同一网段，或路由器隔离了设备';
          setLan({
            state: 'done',
            rooms: Array.isArray(rooms) ? rooms : [],
            note: note,
          });
        });
        return function () { if (lanTimer) { clearTimeout(lanTimer); lanTimer = null; } };
      }, []);

      // 本机房间的「公开到局域网」开关（审计：原在房间页 topbar，那里高度固定 1.36rem，
      // 第二个按钮把顶部 UI 顶歪了；局域网的全部入口收进本面板这一处）。
      // known=false 表示「还没读到真实状态」——不能显示成「未公开」（审查发现：读失败被当成私有）。
      var [lanPub, setLanPub] = useState({ on: false, known: false, busy: false });
      var lanPubSeq = 0; // 每次读/写递增；过期读取直接丢弃，避免旧读覆盖刚切换的状态
      var localRoom = null;
      try {
        // 审查发现：局域网访客打开的是**房主**的私网地址，hostname 也是私网，isLocalService() 会误判成
        // 「本机」并给出开关 —— 但 /lan/publish 只接受回环来源，访客点了必然失败。只有页面本身由
        // 本机回环提供时才认定是「本机房间」。
        localRoom = (isOwnHostPage() && storeRef && typeof storeRef.get === 'function') ? storeRef.get().room : null;
      } catch (e) { localRoom = null; }
      var localCode = localRoom && localRoom.code ? String(localRoom.code) : null;
      /** 读一次真实状态（回环专用只读端点）——真源在房主 Node 进程里，只靠 useState 猜会显示错。 */
      function readMine(token) {
        if (!localCode || !window.__SP_LOBBY || typeof window.__SP_LOBBY.lanPublicState !== 'function') return;
        Promise.resolve(window.__SP_LOBBY.lanPublicState(localCode)).then(function (r) {
          if (token !== lanPubSeq) return; // 已被更新的读/写取代
          if (r && r.ok) setLanPub({ on: !!r.on, known: true, busy: false });
          // 读不到：保持 known=false（不谎报「未公开」）
        }).catch(function () { /* 同上：保持未知 */ });
      }
      useEffect(function () {
        lanPubSeq += 1;
        readMine(lanPubSeq);
        return undefined;
      }, [localCode]);
      function toggleMine() {
        if (!localCode || lanPub.busy) return;
        if (!window.__SP_LOBBY || typeof window.__SP_LOBBY.toggleLanPublic !== 'function') return;
        lanPubSeq += 1;
        var token = lanPubSeq;
        var was = lanPub.on;
        setLanPub({ on: was, known: lanPub.known, busy: true });
        Promise.resolve(window.__SP_LOBBY.toggleLanPublic(localCode, !was)).then(function (r) {
          if (token !== lanPubSeq) return;
          if (r && r.ok) { setLanPub({ on: !!r.on, known: true, busy: false }); return; }
          // 审查发现：失败可能是「服务器已提交但响应丢了」——不能假定写入没发生，回读真实状态。
          setLanPub({ on: was, known: false, busy: false });
          setLan(function (o) { return { state: o.state, rooms: o.rooms, note: '局域网公开失败，已回读状态' }; });
          readMine(token);
        }).catch(function () {
          if (token !== lanPubSeq) return;
          setLanPub({ on: was, known: false, busy: false });
          setLan(function (o) { return { state: o.state, rooms: o.rooms, note: '局域网公开失败，已回读状态' }; });
          readMine(token);
        });
      }

      function scan() {
        if (lan.state === 'scanning') return;
        if (!window.shell || typeof window.shell.lanScan !== 'function') return;
        // 审查发现#5：「桥不存在」和「桥抛异常」要分开 —— 前者才是「需更新 APK」，
        // 后者是可重试的扫描失败，不能把运行时异常诊断成版本过旧。
        var res = null;
        try { res = window.shell.lanScan('rooms', ''); } catch (e) {
          setLan({ state: 'idle', rooms: [], note: '扫描失败，请稍后重试' });
          return;
        }
        if (res == null) { setLan({ state: 'idle', rooms: [], note: '需更新 APK 后生效' }); return; }
        if (window.__SP_LAN && typeof window.__SP_LAN.begin === 'function') lanSeq = window.__SP_LAN.begin();
        setLan({ state: 'scanning', rooms: [], note: '' });
        if (lanTimer) clearTimeout(lanTimer);
        // 兜底：Java 侧异常没回吐时不至于永远卡在「扫描中…」（只此一次超时，不是轮询）
        lanTimer = setTimeout(function () {
          lanTimer = null;
          setLan(function (old) {
            return old.state === 'scanning' ? { state: 'idle', rooms: [], note: '扫描超时，请重试' } : old;
          });
        }, 15000);
      }

      function join(r) {
        if (!r) return;
        // 审查发现#2：与其它大厅加入路径一致 —— 对局进行中切服会直接丢掉当前对局，必须先拦。
        if (inMatch()) {
          setLan(function (old) { return { state: old.state, rooms: old.rooms, note: '对局进行中，无法跨服加入。结束后再试。' }; });
          return;
        }
        // Java 侧按 lan:<ip>:<port> 解析出 http://ip:port 的 entry（契约 v5.4）。
        var id = 'lan:' + String(r.ip || '') + ':' + (Number(r.port) || 0);
        var code = String(r.code || '').toUpperCase();
        var ok = true;
        try { ok = window.shell.joinOnOrigin(id, code) !== false; } catch (e) { ok = false; }
        if (ok) {
          // 审查发现#6：与其它加入路径一致地布防自动进入。Java 的 joinOnOrigin 对 lan: 分支
          // 已经 armAutostart 过，这里再布一次是幂等的（同一 prefs 标志），只做兜底。
          try { armAutostart(code); } catch (e) { /* 旧壳：手动进入 */ }
          onClose();
          return;
        }
        setLan(function (old) { return { state: old.state, rooms: old.rooms, note: '加入失败：目标房间不可达' }; });
      }

      // 行样式与「房间列表」逐字一致（roomRowStyle 是 LobbyPanel 内的局部量，LanSection 是独立组件，
      // 拿不到它 —— 直接引用会 ReferenceError 把整个面板打成「界面发生错误」，预览台已复现）。
      var rowStyle = 'display:flex;align-items:center;gap:8px;padding:6px 2px 5px;'
        + 'border-bottom:1px solid #1e2823;font-size:12px';
      return html`<div class="set-row">
        <span class="set-row__label">局域网<${MicroLabel}>LAN<//></span>
        <div style="grid-column:2 / 4;min-width:0">
          ${localCode ? html`<div style=${rowStyle}>
            <b style="min-width:2.6em;letter-spacing:.04em;color:#4ed8af">${localCode}</b>
            <span style="opacity:.75;white-space:nowrap">本机房间</span>
            <button type="button" class="set-apply" style="margin-left:auto" disabled=${lanPub.busy}
              title="公开后，同一 Wi-Fi 下的玩家能在「大厅 → 局域网」里看到并加入；不公开则只有知道房号的人能进"
              onClick=${toggleMine}>${lanPub.busy ? '处理中…'
                : (lanPub.known ? (lanPub.on ? '已公开 · 转私密' : '公开到局域网') : '公开到局域网（状态未知）')}</button>
          </div>
          ${localCode && !lanPub.known ? html`<p class="set-hint set-hint--tight">未读到本机公开状态；点按即公开。</p>` : null}` : null}
          <div style="display:flex;align-items:center;gap:6px;margin:4px 0">
            <span style="opacity:.7">${lan.state === 'done' ? '发现 ' + lan.rooms.length + ' 个已公开房间' : '同一 Wi-Fi 下已公开的房间'}</span>
            <button type="button" class="set-apply" style="margin-left:auto" disabled=${lan.state === 'scanning'}
              onClick=${scan}>${lan.state === 'scanning' ? '扫描中…' : '扫描'}</button>
          </div>
          ${lan.rooms.length ? html`<div>${lan.rooms.map(function (r, i) {
            var seats = lanSeatDots(r);
            var diff = lanDiff(r);
            var key = 'lan:' + String(r.ip || '') + ':' + (Number(r.port) || 0) + '#' + (r.code || i);
            return html`<div key=${key} style=${rowStyle + (r.inMatch ? ';opacity:.6' : '')}>
              <b style="min-width:2.6em;letter-spacing:.04em;color:#4ed8af">${r.code}</b>
              ${seats ? html`<span class="num" title=${seats.title} style="color:#8a9a93;white-space:nowrap;letter-spacing:.02em">${seats.text}</span>` : null}
              ${diff ? html`<span style="opacity:.6;white-space:nowrap">${diff}</span>` : null}
              <span style="opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.name || '—'}</span>
              ${r.inMatch
                ? html`<button type="button" class="set-apply" disabled=${true} style="margin-left:auto;opacity:.45;cursor:not-allowed">对局中</button>`
                : html`<button type="button" class="set-apply" style="margin-left:auto" onClick=${function () { join(r); }}>加入</button>`}
            </div>`;
          })}</div>` : (lan.state === 'done' && !lan.note
            ? html`<p class="set-hint set-hint--tight">同一 Wi-Fi 下没有发现已公开的房间</p>`
            : null)}
          ${lan.note ? html`<p class="set-hint set-hint--tight">${lan.note}</p>` : null}
        </div>
      </div>`;
    }

    if (typeof registerPanel === 'function') registerPanel('lobby', LobbyPanel);
    // v7.5（审计 §A P0）：面板宿主自挂载。过去靠构建期补丁把 <ShellPanelHost /> 挂进上游 js/main.js，
    // 补丁清零后没人渲染面板（点按钮只改状态、什么都不显示）。依赖就绪后在这里自挂载：四个内置面板
    // + 大厅面板在零补丁构建上重新可用。异步、失败静默（面板不可用绝不能影响游戏）。
    if (typeof mods[0].mountShellPanelHost === 'function') {
      try { mods[0].mountShellPanelHost(); } catch (e) { /* 面板不可用不能影响游戏 */ }
    }
  }).catch(function () { /* the panel just stays unavailable; the game is unaffected */ });

  // v3.9: room-screen 「公开到大厅」bridge (settings-v3.9.json → js/screens/room.js InviteBox).
  // Added after the panel registry so the early window.__SP_LOBBY.open stub stays intact.
  window.__SP_LOBBY.isPublic = isPublic;
  window.__SP_LOBBY.togglePublic = togglePublic;
  window.__SP_LOBBY.localService = isLocalService; // v5.1: 房间页「公开到大厅」按钮据此置灰
  /** v5.3.2 幽灵房清理：房主侧得知「这个房已经不存在」（解散/被踢/离开/正常结束）时调用 ——
   *  自己发布的房（token 在）就 DELETE 房间牌并 dropToken；网络失败不重试（TTL 10 分钟兜底）。 */
  function retireRoom(code) {
    try {
      var c = String(code || '').trim().toUpperCase();
      var token = readTokens()[c];
      if (!token) return Promise.resolve(false); // 不是我发布的房（或已清）
      var serverId = boardServerId();
      var q = '?code=' + encodeURIComponent(c) + (serverId ? '&serverId=' + encodeURIComponent(serverId) : '');
      var run;
      try {
        run = fetch(BOARD.replace(/\/+$/, '') + '/api/rooms' + q, {
          method: 'DELETE', cache: 'no-store', headers: { 'X-Token': token },
        });
      } catch (e) { return Promise.resolve(false); }
      return run.then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.ok) { dropToken(c); return true; }
        if (j && (j.error === 'NOT_FOUND')) { dropToken(c); return true; } // 牌上已没了：本地也清
        return false;
      }).catch(function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }
  window.__SP_LOBBY.retireRoom = retireRoom;

  // v4.0: 房间牌数据访问接口（大厅面板与游戏大厅页共用同一份 boardStore）。
  //   rooms()            → [{ code, server, serverId, note, url, host, left }]（left 为现算剩余秒）
  //   subscribeRooms(fn) → 订阅更新（首次订阅才开始 15s 轮询；取消后无订阅者即停）
  //   roomsVersion()     → 单调递增版本号（供轮询判断是否变化）
  window.__SP_LOBBY.rooms = roomsSnapshot;
  /** v5.2：最近一次房间牌轮询带回的大厅访客数（null = 尚无数据）。 */
  window.__SP_LOBBY.visitors = function () {
    return typeof boardStore.visitors === 'number' ? boardStore.visitors : null;
  };
  /** v5.2：首页用的访客取数（缓存 5 分钟；sessionStorage 兜底，跨页立即可读）。 */
  var VISITORS_TTL_MS = 5 * 60 * 1000;
  var visitorsLastAt = 0;
  function visitorsCached() {
    try {
      var raw = JSON.parse(sessionStorage.getItem('sp.lobby.visitors') || 'null');
      if (raw && typeof raw.n === 'number') {
        if (typeof raw.at === 'number' && raw.at > visitorsLastAt) visitorsLastAt = raw.at;
        return raw.n;
      }
    } catch (e) { /* 无缓存 */ }
    return null;
  }
  function fetchVisitors(force) {
    var cached = visitorsCached();
    if (!pageVisible()) return Promise.resolve(cached); // v7.0: 隐藏页不发（属探测）——只用缓存
    // v7.0: at 会写进 sessionStorage、跨页面加载仍要能比较，故用墙钟口径 wallNow()。
    var now = wallNow();
    if (!force && cached != null && now - visitorsLastAt < VISITORS_TTL_MS) return Promise.resolve(cached);
    if (!BOARD) return Promise.resolve(cached);
    visitorsLastAt = now;
    var dev = deviceKey();
    return boardJson('/api/rooms', dev ? { device: dev } : {}).then(function (j) {
      var n = j && typeof j.visitors === 'number' ? j.visitors : null;
      if (n != null) {
        try { sessionStorage.setItem('sp.lobby.visitors', JSON.stringify({ n: n, at: now })); } catch (e) { /* ignore */ }
        return n;
      }
      return cached;
    }, function () { return cached; });
  }
  window.__SP_LOBBY.visitorsCached = visitorsCached;
  window.__SP_LOBBY.fetchVisitors = fetchVisitors;
  window.__SP_LOBBY.subscribeRooms = subscribeRooms;
  window.__SP_LOBBY.roomsVersion = function () { return boardStore.version; };

  // v4.3: 加入房间（模块级）—— 游戏大厅页 PublicRooms 与大厅面板共用同一实现。
  window.__SP_LOBBY.joinRoom = joinRoom;

  // v6.3：自己房间上报的诊断与测试入口（浏览器里由看表自动驱动，不需要手动调）。
  //   ownReportTick()  → 立刻打一拍 PATCH（不满足条件就返回 skipped，不发请求）
  //   ownReportState() → { ok, code, token, room }（判定三条件：牌 + token + 在房 + 前台）
  //   liveFieldsFor()  → 房态直播字段的纯推导（首发 POST 与 PATCH 共用）
  //   __injectStore()  → 只给测试/诊断注入 store（浏览器里由页面模块的 import 链注入）
  window.__SP_LOBBY.ownReportTick = ownTick;
  window.__SP_LOBBY.ownReportState = ownState;
  window.__SP_LOBBY.liveFieldsFor = liveFieldsFor;
  window.__SP_LOBBY.__injectStore = function (s) { storeRef = s || null; ownWatchArm(); };
  /** v7.0：可见性门禁的测试/诊断入口 —— 注册一个「探测」：隐藏页挂起、回前台补发一次。 */
  window.__SP_LOBBY.__probeWhenVisible = runProbe;
  /** v6.4：服务端发布（B）的状态缓存（诊断/测试用）。 */
  window.__SP_LOBBY.spPubState = function () {
    return { on: spPub.on, code: spPub.code, err: spPub.err, missAt: spPub.missAt, tried: spPub.tried };
  };
})();
