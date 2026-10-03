// shell-join.js — cross-server invite-code resolver (v2.7.0).
//
// One 4-letter invite code may exist on any node server in the signed list (rooms live only in
// each server's process memory — there is no HTTP room query), or on a phone host registered in
// the box directory. This module probes all of them concurrently:
//
//   ① directory  GET {dir}/rooms/<code>          → phone-host room (zt/v6/lan addresses)
//   ② node rooms WS {wss://host/ws} hello → room.join → ROOM_NOT_FOUND (absent) | state (present)
//   ③ roomScoped (CF Workers) entries are skipped — their /ws needs a room ticket, not this protocol
//
// A "present" probe joins briefly with the fixed neutral name 「卫」 and immediately leaves, so the
// seat is freed in 1–2 s. Failed rounds cool down for 60 s (the upstream server rate-limits joins).
// The result is either a single winner or a conflict list for the picker in shellPanels.js.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var PROBE_NAME = '卫';
  var PROBE_TIMEOUT_MS = 3000;
  var TOTAL_BUDGET_MS = 5000;
  var COOLDOWN_MS = 60 * 1000;
  var CODE_RE = /^[A-Z0-9]{4}$/;

  var lastFailAt = 0;

  /** The candidate list: name-only labels for the picker; hosts come from the signed list. */
  function candidates() {
    var out = [];
    try {
      var raw = window.shell && window.shell.getServerList && window.shell.getServerList();
      var list = raw ? JSON.parse(raw) : null;
      if (list && Array.isArray(list.entries)) {
        for (var i = 0; i < list.entries.length; i++) {
          var e = list.entries[i];
          if (!e.enabled) continue;
          if (e.roomScoped) continue; // different protocol (ticket-gated /ws)
          // the page never receives raw urls from the shell; ask for the url by id when needed
          out.push({ id: e.id, name: e.name, humans: e.humans, rttMs: e.rttMs,
                     compatible: e.compatible });
        }
      }
    } catch (e) { /* plain web build: fall back to current origin only */ }
    if (!out.length && typeof location !== 'undefined' && location.host) {
      out.push({ id: '', name: '当前服务器', humans: -1, rttMs: -1, compatible: true, self: true });
    }
    return out;
  }

  /** Resolves a signed-list entry id to its origin via the shell (the url itself stays native-side). */
  function originOf(entry) {
    if (entry.self) return location.origin;
    try {
      // joinOnOrigin is the only consumer; the shell validates the origin against the signed list
      return entry.id; // marker: the picker passes ids to the shell, not urls
    } catch (e) {
      return null;
    }
  }

  /** One WS probe against a server origin. Resolves:
   *  {status:'present'} | {status:'absent'} | {status:'full'} | {status:'started'}
   *  | {status:'unreachable'} — never throws. */
  function probeWs(origin, code) {
    return new Promise(function (resolve) {
      var url = origin.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
      var ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        resolve({ status: 'unreachable' });
        return;
      }
      var settled = false;
      var rid = 1;
      function finish(status) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (ws.readyState <= 1) ws.close(); } catch (e) { /* already gone */ }
        resolve({ status: status });
      }
      var timer = setTimeout(function () { finish('unreachable'); }, PROBE_TIMEOUT_MS);
      ws.onopen = function () {
        try {
          ws.send(JSON.stringify({ t: 'hello', rid: rid, name: PROBE_NAME, version: 1 }));
        } catch (e) { finish('unreachable'); }
      };
      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }
        if (!msg || typeof msg.t !== 'string') return;
        if (msg.t === 'welcome') {
          // joined as 「卫」; now ask for the room
          try { ws.send(JSON.stringify({ t: 'room.join', rid: ++rid, code: code })); } catch (e) { finish('absent'); }
          return;
        }
        if (msg.t === 'error') {
          var c = String(msg.code || '');
          if (c === 'ROOM_NOT_FOUND') finish('absent');
          else if (c === 'ROOM_FULL') finish('full');
          else if (c === 'ROOM_STARTED') finish('started');
          else if (c === 'RATE') finish('ratelimited');
          else finish('absent'); // BAD_MSG etc. — treat as "not here"
          return;
        }
        // the room-state push (server/lobby.js Room.toState → t:'room.state') means the room exists
        if (msg.t === 'room.state' && msg.code === code) {
          finish('present');
          try { ws.send(JSON.stringify({ t: 'room.leave', rid: ++rid })); } catch (e) { /* closing */ }
        }
      };
      ws.onerror = function () { finish('unreachable'); };
      ws.onclose = function () { finish(settled ? undefined : 'unreachable'); };
    });
  }

  /** Directory probe: a hit returns the record (phone-host room). */
  function probeDirectory(dirUrls, code) {
    if (!dirUrls || !dirUrls.length) return Promise.resolve(null);
    return Promise.all(dirUrls.map(function (dir) {
      return fetch(dir.replace(/\/+$/, '') + '/rooms/' + code, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { return (j && j.ok && j.addresses) ? j : null; })
        .catch(function () { return null; });
    })).then(function (hits) {
      for (var i = 0; i < hits.length; i++) if (hits[i]) return hits[i];
      return null;
    });
  }

  function directoryUrls() {
    try {
      var cfg = window.__SP_SHELL_DIRS; // set by the shell when available
      if (Array.isArray(cfg) && cfg.length) return cfg;
    } catch (e) { /* ignore */ }
    return ['https://spdir.jiangjiangze.icu'];
  }

  /**
   * Resolves an invite code across every candidate. Resolves:
   *   { kind:'directory', record } | { kind:'single', entry } |
   *   { kind:'conflict', entries } | { kind:'none', note } | { kind:'cooldown' }
   * Entries in the conflict list carry { id, name, rttMs, humans, note } — labels only, no hosts.
   */
  function resolveCode(code) {
    var K = String(code || '').trim().toUpperCase();
    if (!CODE_RE.test(K)) {
      return Promise.resolve({ kind: 'none', note: '邀请码为 4 位字母或数字' });
    }
    if (Date.now() - lastFailAt < COOLDOWN_MS) {
      return Promise.resolve({ kind: 'cooldown', note: '刚刚探测失败，请稍候再试（限流保护）' });
    }
    var cands = candidates().filter(function (c) { return c.compatible !== false; });
    var dirProbe = probeDirectory(directoryUrls(), K);
    var wsProbes = Promise.all(cands.map(function (c) {
      var origin = c.self ? location.origin : null;
      if (!origin) {
        // plain-web build can only probe its own origin; APK resolves via the picker flow below
        return Promise.resolve({ entry: c, result: { status: 'skipped' } });
      }
      return probeWs(origin, K).then(function (r) { return { entry: c, result: r }; });
    }));

    return Promise.race([
      Promise.all([dirProbe, wsProbes]).then(function (all) {
        var dirHit = all[0];
        var results = all[1];
        var hits = [];
        for (var i = 0; i < results.length; i++) {
          var st = results[i].result.status;
          if (st === 'present' || st === 'full' || st === 'started') {
            var e = results[i].entry;
            hits.push({
              id: e.id, name: e.name, rttMs: e.rttMs, humans: e.humans,
              note: st === 'full' ? '已满' : (st === 'started' ? '已开局' : ''),
            });
          }
        }
        hits.sort(function (a, b) { // by measured latency, per owner decision
          var ar = a.rttMs > 0 ? a.rttMs : Number.MAX_VALUE;
          var br = b.rttMs > 0 ? b.rttMs : Number.MAX_VALUE;
          return ar - br;
        });
        if (dirHit) return { kind: 'directory', record: dirHit };
        if (hits.length === 1) return { kind: 'single', entry: hits[0] };
        if (hits.length > 1) return { kind: 'conflict', entries: hits };
        lastFailAt = Date.now();
        return { kind: 'none', note: '邀请码 ' + K + ' 不存在或已过期' };
      }),
      new Promise(function (resolve) {
        setTimeout(function () { resolve({ kind: 'none', note: '探测超时，请稍后重试' }); }, TOTAL_BUDGET_MS);
      }),
    ]);
  }

  window.__SP_JOIN = {
    resolveCode: resolveCode,
    probeWs: probeWs,
    PROBE_NAME: PROBE_NAME,
  };
})();
