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

  var REFRESH_MS = 15000;        // room sources: 15s poll while the panel is open + visible
  var FETCH_TIMEOUT_MS = 8000;
  var ROOM_CODE_RE = /^[A-HJ-NP-Z]{4}$/; // upstream alphabet (no I/O), matches shell-join.js
  var RAINYA_ROOMS = 'https://game.rainya.me/api/rooms';
  // 房间牌（自建聚合）：自定义域为国内主路（workers.dev 在国内常不可达）；workers.dev 仍在线作兜底
  var BOARD = 'https://sp-lobby.jiangjiangze.icu';

  // The two community stations behind the room sources — always rendered as cards; absent from the
  // signed list (yet) → shown as 「未在签名清单」 and only web-navigable.
  var KNOWN_STATIONS = [
    { host: 'game.rainya.me', name: 'raiya服', aliases: ['raiya', 'rainya'], url: 'https://game.rainya.me/' },
    { host: 'game.misyra.com', name: 'misyra服', aliases: ['misyra'], url: 'https://game.misyra.com/' },
  ];

  // Fetch allow-list: the pinned constant hosts only (BOARD's host joins it when BOARD is filled in).
  var ALLOWED_HOSTS = (function () {
    var m = { 'game.rainya.me': true };
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
  };

  // ---- small formatters (same looks as shellPanels.js) ------------------------------------------

  // v4.1: 延迟色点 —— 不再显示数值，返回 { color, title }。
  // 已停用灰 / 不可达红 / 未知灰 / <150ms 绿 / <400ms 黄 / 其余红（title 不写 ms）。
  function rttDot(ms, enabled, reachable) {
    if (enabled === false) return { color: '#8a9a93', title: '已停用' };
    if (!isFinite(ms) || ms <= 0) {
      if (reachable === false) return { color: '#e06c5a', title: '无法连接' };
      return { color: '#8a9a93', title: '延迟未知' };
    }
    if (ms < 150) return { color: '#4ed8af', title: '延迟良好' };
    if (ms < 400) return { color: '#e0b64a', title: '延迟一般' };
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

  /** Current server id for board rows: native bridge first, location.host fallback.
   *  v4.7: 兜底命中环回/私网（本机页直接打开）时返回 ''——私网地址不得进公共清单，由调用方拦截。 */
  function boardServerId() {
    try {
      if (window.shell && typeof window.shell.currentServerId === 'function') {
        var s = String(window.shell.currentServerId() || '').trim();
        if (s) return s;
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

  /** True when this device already published the room (its token is stored). */
  function isPublic(code) {
    var c = String(code || '').trim().toUpperCase();
    if (!ROOM_CODE_RE.test(c)) return false;
    var o = readTokens();
    return Object.prototype.hasOwnProperty.call(o, c);
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
        return Promise.resolve({ ok: false, isPublic: false, text: '无法确定当前服务器，暂不能公开' });
      }
      var body = { code: c, serverId: serverId, serverName: friendlyServerName(serverId) };
      var url = publicRoomUrl(c);
      if (url) body.url = url;
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
          return { ok: true, isPublic: true, text: '已公开到大厅（10 分钟）' };
        }
        return { ok: false, isPublic: false, text: String((j && j.error) || ('HTTP ' + res.status)) };
      }).catch(function () {
        return { ok: false, isPublic: false, text: '网络不可用，请稍后重试' };
      });
    }

    // 公开 → 私密：DELETE 带 X-Token，成功清 token
    var token = readTokens()[c];
    var q = '?code=' + encodeURIComponent(c) + '&serverId=' + encodeURIComponent(serverId);
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
  function fetchSource(url, cb) {
    var u;
    try { u = new URL(String(url || '')); } catch (e) { cb('bad', []); return; }
    if (u.protocol !== 'https:' || isPrivateHost(u.hostname) || !ALLOWED_HOSTS[u.hostname.toLowerCase()]) {
      cb('bad', []);
      return;
    }
    var opts = { cache: 'no-store' };
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
      cb('ok', out);
    }).catch(function () { cb('error', []); });
  }

  /** Shaped room row: { code, server, note, leftSec, url, host } (url/host '' when unusable). */
  function sanitizeRoom(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var code = String(raw.code || '').toUpperCase();
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
    return {
      code: code,
      server: typeof raw.server === 'string' ? raw.server : '',
      serverId: typeof raw.serverId === 'string' ? raw.serverId.slice(0, 64) : '',
      note: typeof raw.note === 'string' ? raw.note.slice(0, 80) : '',
      leftSec: isFinite(left) && left > 0 ? left : 0,
      url: url,
      host: host,
    };
  }

  // ---- 共享房间牌数据（模块级单例，v4.0） -------------------------------------------------------
  // 大厅面板与游戏大厅页（js/screens/lobby.js 的「公开房间」区块）共用同一份 merged 房间列表与
  // 15s 轮询；不再各自实现一套抓取。轮询仅在「有订阅者且页面可见」时布防（沿用 room-observer 的
  // 省电纪律）。rooms() 按抓取时刻现算剩余秒数，调用方自行 1s 重绘即可，不新增高频请求。
  var boardStore = {
    sources: {
      rainya: { state: 'idle', at: 0, list: [] },
      board: { state: BOARD ? 'idle' : 'unavailable', at: 0, list: [] },
    },
    subs: [],
    timer: null,
    version: 0,
  };

  /** merged 房间行：自建房间牌优先，其次社区聚合；同一房号跨源只留一条；最快过期在前。 */
  function boardMerged() {
    var seen = {};
    var merged = [];
    var order = ['board', 'rainya'];
    var nowMs = Date.now();
    for (var oi = 0; oi < order.length; oi++) {
      var src = boardStore.sources[order[oi]];
      for (var ri = 0; ri < src.list.length; ri++) {
        var r = src.list[ri];
        if (seen[r.code]) continue;
        seen[r.code] = 1;
        merged.push({
          code: r.code, server: r.server, serverId: r.serverId, note: r.note, url: r.url, host: r.host,
          left: r.leftSec - (nowMs - src.at) / 1000,
        });
      }
    }
    merged.sort(function (a, b) { return a.left - b.left; });
    if (merged.length > 60) merged = merged.slice(0, 60);
    return merged;
  }

  /** 列表状态（loading / 各源错误提示），面板与大厅页共用。 */
  function boardInfo() {
    var s = boardStore.sources;
    var srcNotes = [];
    if (!BOARD) srcNotes.push('房间牌待上线（自建聚合未部署）');
    if (s.rainya.state === 'error') srcNotes.push('社区房间源暂不可达');
    if (BOARD && s.board.state === 'error') srcNotes.push('房间牌暂不可达');
    return { loading: s.rainya.state === 'loading' || s.board.state === 'loading', srcNotes: srcNotes };
  }

  function boardNotify() {
    boardStore.version++;
    for (var i = 0; i < boardStore.subs.length; i++) {
      try { boardStore.subs[i](); } catch (e) { /* 订阅者自身异常不影响轮询 */ }
    }
  }

  function pullBoardSource(key, url) {
    fetchSource(url, function (state, list) {
      var next = { rainya: boardStore.sources.rainya, board: boardStore.sources.board };
      next[key] = { state: state, at: Date.now(), list: list || [] };
      boardStore.sources = next;
      boardNotify();
    });
  }

  function boardPull() {
    if (typeof document !== 'undefined' && document.hidden) return;
    pullBoardSource('rainya', RAINYA_ROOMS);
    if (BOARD) pullBoardSource('board', BOARD.replace(/\/+$/, '') + '/api/rooms');
  }

  function boardArm() {
    if (boardStore.timer != null || !boardStore.subs.length) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    boardPull();
    boardStore.timer = setInterval(boardPull, REFRESH_MS);
  }

  function boardDisarm() {
    if (boardStore.timer != null) { clearInterval(boardStore.timer); boardStore.timer = null; }
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
      if (document.hidden) boardDisarm(); else boardArm();
    });
  } catch (e) { /* 非浏览器环境（测试）无 document */ }

  // ---- server cards (App: signed list; web: __SP_SHELL.getServers) --------------------------------

  /** Raw list rows, without the always-present community stations. */
  function readListRows() {
    var rows = [];
    // App: signed list — names / measurements only (URLs stay inside the shell). While the list is
    // still loading the App contributes no rows (never mix in the web-only static lines).
    if (window.shell && typeof window.shell.getServerList === 'function') {
      try {
        var o = JSON.parse(window.shell.getServerList() || '{}');
        if (o && Array.isArray(o.entries)) {
          for (var i = 0; i < o.entries.length; i++) {
            var e = o.entries[i];
            if (!e || !e.id) continue;
            rows.push({
              id: String(e.id), name: String(e.name || e.id), note: String(e.note || ''),
              app: String(e.app || ''), rttMs: Number(e.rttMs), humans: Number(e.humans),
              reachable: e.reachable,
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
    // 房间 10 分钟内有效；过期行会落到目标服务器的「房间不存在」页 —— 本地拒绝并提示刷新。
    if (!(Number(room.left) > 0)) return { ok: false, note: '该房间已过期（房间 10 分钟内有效），列表每 15 秒自动刷新，请稍候。' };
    var native = !!(window.shell && typeof window.shell.setServer === 'function');
    if (native) {
      var id = findServerIdForHost(room.host);
      // v4.3: 房间牌行可能只有 serverId（url 缺失 → host 为空）。serverId 提交时取
      // shell.currentServerId()，本身就是签名清单 id，故作为 host 查不到时的回退。
      if (!id && room.serverId) id = String(room.serverId);
      if (!id) return { ok: false, note: '该站未在签名清单（暂不能原生跳转）' };
      var ok = true;
      try { ok = window.shell.joinOnOrigin(id, room.code) !== false; } catch (e) { ok = false; }
      if (!ok) return { ok: false, note: '加入失败：目标服务器当前不可用' };
      armAutostart(id); // v4.3: 加入后自动进入（与 pickStation 一致）
      return { ok: true, note: '' };
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

  function nowMs() {
    try { return (window.performance && performance.now) ? performance.now() : Date.now(); } catch (e) { return Date.now(); }
  }

  /** 单次 no-cors 计时：resolve 毫秒数（含任意 HTTP 状态），网络 / TLS 失败或超时 resolve -1。绝不抛。 */
  function timedProbe(url) {
    return new Promise(function (resolve) {
      var t0 = nowMs();
      var done = false;
      var timer = null;
      function finish(v) { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(v); }
      timer = setTimeout(function () { finish(-1); }, PROBE_TIMEOUT_MS);
      var run;
      try { run = fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' }); }
      catch (e) { finish(-1); return; }
      run.then(function () { finish(nowMs() - t0); }, function () { finish(-1); });
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
    probeCache[k] = { at: Date.now(), rttMs: rttMs, reachable: rttMs >= 0 };
  }

  /** 缓存查询：命中且未过期返回 { rttMs, reachable }，否则 null。 */
  function probeLookup(origin) {
    var e = probeCache[String(origin || '').toLowerCase()];
    if (!e || Date.now() - e.at > PROBE_TTL_MS) return null;
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
    import('/js/ui/shellPanels.js'),
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
    storeRef = store; // v4.3: 供模块级 inMatch / sessionEntered / joinRoom 读取会话状态

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
      var [roomNote, setRoomNote] = useState('');
      var [submitRoomState, setSubmitRoomState] = useState({ state: 'idle', text: '' });

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
        var pending = targets.length;
        for (var t = 0; t < targets.length; t++) {
          (function (origin) {
            probeOrigin(origin, '/healthz').then(function (rtt) {
              cacheProbe(origin, rtt);
              if (--pending <= 0 && !cancelled) setStations(readStationRows());
            });
          })(targets[t]);
        }
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
          probeOrigin(origin, String(sProbe || '').trim() || '/healthz').then(function (rtt) {
            cacheProbe(origin, rtt);
            if (!cancelled) setCustomRtt(rtt);
          });
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
          // v4.7: 环回/私网兜底（本机页直开）返回 ''——submitRoom 有空值拦截「无法确定当前服务器」
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

      function submitRoom() {
        if (inMatch()) { // v4.7: 对局中禁止提交（SUBMIT 入口）
          setSubmitRoomState({ state: 'error', text: '对战中无法提交，结束后再试' });
          return;
        }
        if (submitRoomState.state === 'sending') return;
        if (!BOARD) { setSubmitRoomState({ state: 'error', text: '房间牌待上线' }); return; }
        var code = currentRoomCode();
        if (!ROOM_CODE_RE.test(code)) { setSubmitRoomState({ state: 'error', text: '当前不在房间内' }); return; }
        var serverId = currentServerId();
        if (!serverId) { setSubmitRoomState({ state: 'error', text: '无法确定当前服务器' }); return; }
        var body = {
          code: code,
          serverId: serverId,
          serverName: friendlyServerName(serverId), // v4.7: 解析不了友好名就留空，不上传原始 host:port
          note: String(roomNote || '').trim().slice(0, 40),
        };
        var url = publicRoomUrl(code);
        if (url) body.url = url;
        setSubmitRoomState({ state: 'sending', text: '提交中…' });
        var run;
        try {
          run = fetch(boardEndpoint('/api/rooms'), {
            method: 'POST', cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
        } catch (e) { setSubmitRoomState({ state: 'error', text: '网络不可用，请稍后重试' }); return; }
        run.then(function (r) {
          return r.json().then(function (j) { return { status: r.status, j: j }; });
        }).then(function (res) {
          var j = res.j || {};
          if (j && j.ok === true && j.token) {
            saveToken(code, String(j.token));
            setSubmitRoomState({ state: 'ok', text: '已提交，10 分钟内有效' });
            boardPull(); // 触发一次共享房间牌刷新
            return;
          }
          setSubmitRoomState({ state: 'error', text: String((j && j.error) || ('HTTP ' + res.status)) });
        }).catch(function () { setSubmitRoomState({ state: 'error', text: '网络不可用，请稍后重试' }); });
      }

      function destroyRoom(room) {
        var token = readTokens()[room.code];
        if (!token) return;
        var serverId = String(room.serverId || currentServerId() || '');
        if (!serverId) { setSubmitRoomState({ state: 'error', text: '无法确定该房间的服务器' }); return; }
        var q = '?code=' + encodeURIComponent(room.code) + '&serverId=' + encodeURIComponent(serverId);
        var run;
        try {
          run = fetch(boardEndpoint('/api/rooms' + q), {
            method: 'DELETE', cache: 'no-store', headers: { 'X-Token': token },
          });
        } catch (e) { setSubmitRoomState({ state: 'error', text: '网络不可用，请稍后重试' }); return; }
        run.then(function (r) {
          return r.json().then(function (j) { return { status: r.status, j: j }; });
        }).then(function (res) {
          var j = res.j || {};
          if (j && j.ok === true) {
            dropToken(room.code);
            setSubmitRoomState({ state: 'ok', text: '已销毁' });
            boardPull();
            return;
          }
          if (j && j.error === 'NOT_FOUND') { // 已过期/已被清理：顺手丢掉本地 token
            dropToken(room.code);
            setSubmitRoomState({ state: 'ok', text: '该房间已过期或不存在' });
            boardPull();
            return;
          }
          setSubmitRoomState({ state: 'error', text: String((j && j.error) || ('HTTP ' + res.status)) });
        }).catch(function () { setSubmitRoomState({ state: 'error', text: '网络不可用，请稍后重试' }); });
      }

      // merged room rows: 共享 boardStore（自建房间牌优先，其次社区聚合；最快过期在前）
      var merged = boardMerged();
      var info = boardInfo();
      var tokens = readTokens(); // 自己的房间（本机 token）→ 行内显示「销毁」
      var srcNotes = info.srcNotes;
      var loading = info.loading;
      var emptyText = loading ? '正在获取房间列表…' : '暂无公开房间';
      var roomRowStyle = 'display:flex;align-items:center;gap:8px;padding:6px 2px 5px;'
        + 'border-bottom:1px solid #1e2823;font-size:12px';

      function card(row) {
        var dim = row.missing || row.enabled === false;
        var dot = rttDot(row.rttMs, row.enabled, row.reachable);
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
              <div class="sp-srv-grid">${stations.map(card)}</div>
              <p class="set-hint set-hint--tight">
                点一张卡 = 切换到该服务器并自动进入${native ? '' : '（网页版 = 跳转到该线路）'}；未在签名清单的站点不能原生跳转。
              </p>
            </div>
          </div>

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
              ${merged.length ? html`<div>${merged.map(function (r) {
                return html`<div key=${r.code} style=${roomRowStyle}>
                  <b style="min-width:2.6em;letter-spacing:.04em;color:#4ed8af">${r.code}</b>
                  <span style="flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8"
                    title=${r.server || ''}>${r.server || '—'}</span>
                  <span style="flex:1;min-width:0;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                    title=${r.note}>${r.note || ''}</span>
                  <span style=${'font-variant-numeric:tabular-nums;color:' + (r.left <= 60 ? '#e06c5a' : '#8a9a93')}>${r.left > 0 ? '剩 ' + fmtLeft(r.left) : '已过期'}</span>
                  ${r.left > 0
                    ? html`<button type="button" class="set-apply" onClick=${function () { joinRoom(r); }}>加入</button>`
                    : html`<button type="button" class="set-apply" disabled=${true} style="opacity:.45;cursor:not-allowed">已过期</button>`}
                  ${tokens[r.code] ? html`<button type="button" class="set-apply" style="border-color:#e06c5a;color:#e06c5a" onClick=${function () { destroyRoom(r); }}>销毁</button>` : null}
                </div>`;
              })}</div>` : html`<p class="set-hint set-hint--tight">${emptyText}</p>`}
              ${srcNotes.map(function (t, i) { return html`<p key=${'sn' + i} class="set-hint set-hint--tight">${t}</p>`; })}
              <p class="set-hint set-hint--tight">
                每 15 秒刷新；仅面板打开且页面可见时轮询。房间信息来自各站公开接口，加入仍以目标服务器为准。
              </p>
            </div>
          </div>

          ${BOARD ? html`<div class="set-row">
            <span class="set-row__label">提交房间<${MicroLabel}>SUBMIT<//></span>
            <div style="grid-column:2 / 4;min-width:0;display:flex;flex-direction:column;gap:6px">
              <input class="set-input" type="text" value=${roomNote} maxLength="40" placeholder="备注（可选，≤40 字）"
                onInput=${function (e) { setRoomNote(e.currentTarget.value); }} />
              <button type="button" class="set-apply" disabled=${submitRoomState.state === 'sending' || inMatch()}
                onClick=${submitRoom}>${submitRoomState.state === 'sending' ? '提交中…' : '提交到房间牌'}</button>
            </div>
          </div>
          ${submitRoomState.state !== 'idle' ? html`<p class="set-hint set-hint--tight">${submitRoomState.text}</p>` : null}
          <p class="set-hint set-hint--tight">
            提交当前房间到你正在使用的服务器（10 分钟内有效）；房间牌只登记房号与服务器，加入仍以目标服务器为准。
          </p>` : html`<div class="set-row">
            <span class="set-row__label">提交房间<${MicroLabel}>SUBMIT<//></span>
            <button type="button" class="set-apply" disabled=${true} title="房间牌上线后开启">提交到房间牌</button>
          </div>
          <p class="set-hint set-hint--tight">提交区随房间牌（自建聚合）上线后开启：届时可把你开好的房间挂到大堂列表。</p>`}

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

          <p class="set-hint">非官方同人作品 · 房间信息来自各站公开接口（只读）；不代登录、不代转发。加入失败（房满 / 已开始）由目标服务器照常提示。</p>
        </div>
      <//>`;
    }

    if (typeof registerPanel === 'function') registerPanel('lobby', LobbyPanel);
  }).catch(function () { /* the panel just stays unavailable; the game is unaffected */ });

  // v3.9: room-screen 「公开到大厅」bridge (settings-v3.9.json → js/screens/room.js InviteBox).
  // Added after the panel registry so the early window.__SP_LOBBY.open stub stays intact.
  window.__SP_LOBBY.isPublic = isPublic;
  window.__SP_LOBBY.togglePublic = togglePublic;

  // v4.0: 房间牌数据访问接口（大厅面板与游戏大厅页共用同一份 boardStore）。
  //   rooms()            → [{ code, server, serverId, note, url, host, left }]（left 为现算剩余秒）
  //   subscribeRooms(fn) → 订阅更新（首次订阅才开始 15s 轮询；取消后无订阅者即停）
  //   roomsVersion()     → 单调递增版本号（供轮询判断是否变化）
  window.__SP_LOBBY.rooms = roomsSnapshot;
  window.__SP_LOBBY.subscribeRooms = subscribeRooms;
  window.__SP_LOBBY.roomsVersion = function () { return boardStore.version; };

  // v4.3: 加入房间（模块级）—— 游戏大厅页 PublicRooms 与大厅面板共用同一实现。
  window.__SP_LOBBY.joinRoom = joinRoom;
})();
