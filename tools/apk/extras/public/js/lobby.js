// lobby.js — 「大厅」in-page panel (v3.7 P1), loaded as a CLASSIC script from index.html right after
// player-data.js (see tools/apk/patches/settings-v3.7.json), so it fetches the Preact UI kit and the
// panel registry with dynamic import(). registerPanel('lobby', LobbyPanel) installs this panel into
// shellPanels.js' add-on registry; the built-in panels are untouched. window.__SP_LOBBY = { open }
// is installed immediately (debugging / future shell entry points).
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
//   4) 提交区 — disabled until the room board goes live.
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
  var BOARD = 'https://sp-lobby-board.yuehuibu5561.workers.dev'; // 房间牌（自建聚合，v2.9.0 部署）；'' = 未部署

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

  function rttColor(ms) {
    if (!isFinite(ms) || ms <= 0) return '#8a9a93';
    if (ms < 150) return '#4ed8af';
    if (ms < 400) return '#e0b64a';
    return '#e06c5a';
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
      note: typeof raw.note === 'string' ? raw.note.slice(0, 80) : '',
      leftSec: isFinite(left) && left > 0 ? left : 0,
      url: url,
      host: host,
    };
  }

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

  // ---- panel UI (dynamically imported so this file can stay a classic script) ---------------------

  Promise.all([
    import('/js/ui/shellPanels.js'),
    import('/js/ui/components.js'),
    import('/vendor/hooks.module.js'),
    import('/js/store.js'),
  ]).then(function (mods) {
    var registerPanel = mods[0].registerPanel;
    var html = mods[1].html;
    var Modal = mods[1].Modal;
    var Button = mods[1].Button;
    var MicroLabel = mods[1].MicroLabel;
    var useState = mods[2].useState;
    var useEffect = mods[2].useEffect;
    var store = mods[3].store;

    function inMatch() {
      try { return !!(store.get().room && store.get().room.inMatch); } catch (e) { return false; }
    }

    function LobbyPanel(props) {
      var onClose = props.onClose;
      var native = !!(window.shell && typeof window.shell.setServer === 'function');

      var [stations, setStations] = useState(readStationRows);
      var [code, setCode] = useState('');
      var [invite, setInvite] = useState({ state: 'idle', entries: [], note: '' });
      var [sources, setSources] = useState(function () {
        return {
          rainya: { state: 'loading', at: 0, list: [] },
          board: { state: BOARD ? 'loading' : 'unavailable', at: 0, list: [] },
        };
      });
      var [note, setNote] = useState('');
      var [refreshKey, setRefreshKey] = useState(0);
      var [, setTick] = useState(0); // 每秒重绘一次：本地 leftSec 倒计时

      // the shell pushes a fresh verified list after refreshServerList() somewhere else
      useEffect(function () {
        var onServers = function () { setStations(readStationRows()); };
        window.addEventListener('sp-servers', onServers);
        return function () { window.removeEventListener('sp-servers', onServers); };
      }, []);

      // Room sources: 15s pull + 1s countdown, both parked while the document is hidden or the panel
      // closes (room-observer.js energy discipline).
      useEffect(function () {
        var alive = true;
        var pullTimer = null;
        var tickTimer = null;

        function pullSource(key, url) {
          fetchSource(url, function (state, list) {
            if (!alive) return;
            setSources(function (s) {
              var next = { rainya: s.rainya, board: s.board };
              next[key] = { state: state, at: Date.now(), list: list || [] };
              return next;
            });
          });
        }
        function pull() {
          if (document.hidden) return;
          pullSource('rainya', RAINYA_ROOMS);
          if (BOARD) pullSource('board', BOARD.replace(/\/+$/, '') + '/api/rooms');
        }
        function arm() {
          if (pullTimer == null) { pull(); pullTimer = setInterval(pull, REFRESH_MS); }
          if (tickTimer == null) {
            tickTimer = setInterval(function () { setTick(function (n) { return n + 1; }); }, 1000);
          }
        }
        function disarm() {
          if (pullTimer != null) { clearInterval(pullTimer); pullTimer = null; }
          if (tickTimer != null) { clearInterval(tickTimer); tickTimer = null; }
        }
        function onVis() { if (document.hidden) disarm(); else arm(); }
        document.addEventListener('visibilitychange', onVis);
        if (!document.hidden) arm();
        return function () {
          alive = false;
          disarm();
          document.removeEventListener('visibilitychange', onVis);
        };
      }, [refreshKey]);

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
          onClose();
          return;
        }
        try { location.href = location.origin + '/?room=' + normalized; } catch (e) { /* ignore */ }
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

      function joinRoom(room) {
        if (inMatch()) { setNote('对局进行中，无法跨服加入。结束后再试。'); return; }
        // Rooms live 10 minutes (ttlSec 600); a stale row would land on the target server's own
        // 「房间不存在」 page — refuse locally and ask for a refresh instead.
        if (!(Number(room.left) > 0)) { setNote('该房间已过期（房间 10 分钟内有效），点「立即刷新」查看最新房间。'); return; }
        if (native) {
          var id = findServerIdForHost(room.host);
          if (!id) { setNote('该站未在签名清单（暂不能原生跳转）'); return; }
          var ok = true;
          try { ok = window.shell.joinOnOrigin(id, room.code) !== false; } catch (e) { ok = false; }
          if (!ok) { setNote('加入失败：目标服务器当前不可用'); return; }
          onClose();
          return;
        }
        var u = safeNavUrl(room.url);
        if (!u) { setNote('该房间链接不可用'); return; }
        try { location.href = u; } catch (e) { setNote('无法跳转，请稍后重试'); }
      }

      // merged room rows: our board first (it is ours), then the community aggregator; soonest first
      var seen = {};
      var merged = [];
      var order = ['board', 'rainya'];
      var nowMs = Date.now();
      for (var oi = 0; oi < order.length; oi++) {
        var src = sources[order[oi]];
        for (var ri = 0; ri < src.list.length; ri++) {
          var r = src.list[ri];
          if (seen[r.code]) continue; // 同一房号跨源只展示一次（板优先）
          seen[r.code] = 1;
          merged.push({
            code: r.code, server: r.server, note: r.note, url: r.url, host: r.host,
            left: r.leftSec - (nowMs - src.at) / 1000,
          });
        }
      }
      merged.sort(function (a, b) { return a.left - b.left; });
      if (merged.length > 60) merged = merged.slice(0, 60);

      var srcNotes = [];
      if (!BOARD) srcNotes.push('房间牌待上线（自建聚合未部署）');
      if (sources.rainya.state === 'error') srcNotes.push('社区房间源暂不可达');
      if (BOARD && sources.board.state === 'error') srcNotes.push('房间牌暂不可达');
      var loading = sources.rainya.state === 'loading' || sources.board.state === 'loading';
      var emptyText = loading ? '正在获取房间列表…' : '暂无公开房间';
      var roomRowStyle = 'display:flex;align-items:center;gap:8px;padding:6px 2px 5px;'
        + 'border-bottom:1px solid #1e2823;font-size:12px';

      function card(row) {
        var dim = row.missing || row.enabled === false;
        return html`<div key=${row.id || row.name} class=${'sp-srv-cell' + (row.current ? ' is-cur' : '') + (dim ? ' is-off' : '')}>
          <button type="button" class="sp-srv-main" title=${(row.note ? row.note + ' · ' : '') + row.name}
            onClick=${function () { pickStation(row); }}>
            ${row.current ? html`<span class="sp-srv-cur"></span>` : null}
            <span class="sp-srv-name">${row.name}${row.missing ? ' · 未在签名清单' : ''}</span>
            ${row.humans >= 0 ? html`<span class="sp-srv-ver">${row.humans}人</span>` : null}
            ${row.app ? html`<span class="sp-srv-ver">${fmtApp(row.app)}</span>` : null}
            <span class="sp-srv-rtt" style=${'color:' + rttColor(row.rttMs)}>${fmtRtt(row.rttMs)}</span>
          </button>
        </div>`;
      }

      return html`<${Modal} open=${true} onClose=${onClose} title="大厅" micro="LOBBY" width="10.4rem"
        actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
        <div class="set-list">
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
                ${e.name} · ${fmtRtt(e.rttMs)}${e.humans >= 0 ? ' · ' + e.humans + ' 人' : ''}${e.note ? ' · ' + e.note : ''}
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
                  <span style="opacity:.8">${r.server || '—'}</span>
                  <span style="flex:1;min-width:0;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                    title=${r.note}>${r.note || ''}</span>
                  <span style=${'font-variant-numeric:tabular-nums;color:' + (r.left <= 60 ? '#e06c5a' : '#8a9a93')}>${r.left > 0 ? '剩 ' + fmtLeft(r.left) : '已过期'}</span>
                  ${r.left > 0
                    ? html`<button type="button" class="set-apply" onClick=${function () { joinRoom(r); }}>加入</button>`
                    : html`<button type="button" class="set-apply" disabled=${true} style="opacity:.45;cursor:not-allowed">已过期</button>`}
                </div>`;
              })}</div>` : html`<p class="set-hint set-hint--tight">${emptyText}</p>`}
              ${srcNotes.map(function (t, i) { return html`<p key=${'sn' + i} class="set-hint set-hint--tight">${t}</p>`; })}
              <p class="set-hint set-hint--tight">
                每 15 秒刷新；仅面板打开且页面可见时轮询。房间信息来自各站公开接口，加入仍以目标服务器为准。
              </p>
              <button type="button" class="set-apply" onClick=${function () { setRefreshKey(function (k) { return k + 1; }); }}>立即刷新</button>
            </div>
          </div>

          <div class="set-row">
            <span class="set-row__label">提交房间<${MicroLabel}>SUBMIT<//></span>
            <button type="button" class="set-apply" disabled=${true} title="房间牌上线后开启">提交到房间牌</button>
          </div>
          <p class="set-hint set-hint--tight">提交区随房间牌（自建聚合）上线后开启：届时可把你开好的房间挂到大堂列表。</p>

          <p class="set-hint">非官方同人作品 · 房间信息来自各站公开接口（只读）；不代登录、不代转发。加入失败（房满 / 已开始）由目标服务器照常提示。</p>
        </div>
      <//>`;
    }

    if (typeof registerPanel === 'function') registerPanel('lobby', LobbyPanel);
  }).catch(function () { /* the panel just stays unavailable; the game is unaffected */ });
})();
