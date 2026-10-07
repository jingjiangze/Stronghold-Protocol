// sp-lobby.mjs — server-side room-board publisher (overlay API 1).
//
// WHY (业主定案 2026-10-07, B 方案): the client-side reporter (extras/public/js/lobby.js) only lives as
// long as the page does, and on its first tick it usually does not yet know what the web row holds. The
// authoritative state is the SERVER's: it knows whether the room still exists, how many seats are taken
// and whether a match is running. So ownership moves here:
//
//   房间页「公开到大厅」 → 本机服务 /sp/lobby/publish → **本服务** POST 房间牌（持有 token）
//     → 每 60s PATCH 真实人数 → 房间消失 / 取消公开 → DELETE（顺带治幽灵房，不等 600s TTL）
//
// ZERO UPSTREAM CONFLICT: this is a NEW file (tools/apk/overlay/ → server/overlay/ in the built webroot,
// riding the L1 content slim), picked up by extras/server/overlay-loader.mjs after startServer(). ctx.server
// IS the object upstream startServer() returned — it carries `lobby`, so the room state is directly
// reachable. No upstream file is edited, no patch, no APK change.
//
// ROUTES (control plane — same gate as sp-connect: loopback PEER + loopback Origin, missing Origin → 403)
//   POST /sp/lobby/publish {code, serverId, serverName?, url?, difficulty?, on:true|false}
//   GET  /sp/lobby/status  → {ok, published, code, lastError, nextInMs}   (never echoes the token)
// ALSO: forces `Access-Control-Allow-Origin: *` on GET /healthz ONLY — it is a public read-only aggregate
// (rooms/humans) that the lobby page probes for rows without room-level numbers. Every other path and
// every other header is left byte-for-byte alone.
//
// SECURITY (Mimosa acceptance — asserted in tools/apk/overlay-sp-lobby.test.mjs)
//   1. Control routes answer only loopback peers with a loopback http(s) Origin (reused from sp-connect).
//   2. The board is a CONSTANT https base; every outbound URL goes through boardUrlOf(), which refuses
//      non-https and any loopback/private/reserved host (the deny table lives in sp-connect). No
//      user-supplied URL is ever dialed, so there is no SSRF surface.
//   3. The token exists only in this process's memory, minted by the board's own POST response —
//      never written to source, examples or tests.
//   4. A throwing install() is logged and skipped by the loader, so a defect here can never block boot.
import fs from 'node:fs';
import path from 'node:path';
import { isDeniedTargetHost, isLoopback, originAllowed } from './sp-connect.mjs';

/** Overlay loader contract (server/overlay-loader.mjs). */
export const overlayApi = 1;
/** Overlay id for logs / handshake.json. */
export const id = 'sp-lobby';

export const ROUTE_PUBLISH = '/sp/lobby/publish';
export const ROUTE_STATUS = '/sp/lobby/status';
export const HEALTHZ_PATH = '/healthz';
/** The room board (same host the client uses; a constant — see SECURITY 2). */
export const DEFAULT_BOARD_URL = 'https://sp-lobby.jiangjiangze.icu';
/** Report cadence (the board TTL is 600s, so this leaves a 10x margin). */
export const PATCH_INTERVAL_MS = 60000;
/** Outbound request deadline. */
export const FETCH_TIMEOUT_MS = 8000;
/** Control-plane body cap (a tiny JSON object). */
export const BODY_LIMIT = 8 * 1024;
/** 上一次发布的存档（重启清理用；写在运行目录，内容只有房号/serverId/token）。 */
export const SAVED_STATE_FILE = 'sp-lobby-state.json';
/** Room codes the board accepts: upstream alphabet, no I/O. */
export const CODE_RE = /^[A-HJ-NP-Z]{4}$/;
/** Live statuses the board accepts (sanitizeLiveFields). */
const LIVE_STATUS = ['waiting', 'playing', 'full'];

/** Validate + join a board endpoint. Refuses non-https and any denied host (throws with a reason). */
export function boardUrlOf(base, apiPath) {
  const b = String(base || '').replace(/\/+$/, '');
  let u;
  try {
    u = new URL(b + apiPath);
  } catch (e) {
    throw new Error('board url does not parse');
  }
  if (u.protocol !== 'https:') throw new Error('board url must be https');
  if (isDeniedTargetHost(u.hostname)) throw new Error('board host is loopback/private/reserved');
  return u.toString();
}

/** Live fields for one room record (the board accepts exactly these four keys — see
 *  stronghold-lobby/src/board.js sanitizeLiveFields; `status:'playing'` is how a running match is
 *  reported, the board has no `inMatch` field).
 *  Upstream marks a running match as `room.match`; some trees/overlays expose `room.inMatch` instead
 *  (room-presence.mjs), so accept both — reporting 'waiting' for a running match is a real bug. */
export function liveFieldsOf(room) {
  const seats = room && Array.isArray(room.seats) ? room.seats : [];
  let occupied = 0;
  for (const s of seats) {
    if (!s) continue;
    // Seat entries are records with a `left` flag upstream; a bare truthy value still counts as taken.
    if (typeof s === 'object' ? !s.left : true) occupied++;
  }
  const capacity = seats.length > 0 ? seats.length : 4;
  const inMatch = !!(room && (room.match || room.inMatch));
  return {
    mode: room && room.mode === 'solo' ? 'solo' : 'coop',
    status: inMatch ? 'playing' : (occupied >= capacity ? 'full' : 'waiting'),
    occupied: occupied,
    capacity: Math.min(Math.max(capacity, 1), 16),
  };
}

/** The POST/PATCH body: identity + live fields (+ the additive fields the page form may have set). */
export function publishBodyOf({ code, serverId, serverName, url, difficulty, room }) {
  const body = { code: code, serverId: serverId };
  if (serverName) body.serverName = String(serverName).slice(0, 64);
  if (url) body.url = String(url).slice(0, 200);
  if (difficulty) body.difficulty = String(difficulty).slice(0, 32);
  return Object.assign(body, liveFieldsOf(room));
}

/** Read one room's record out of the upstream lobby (null when it is gone). */
export function readRoomFrom(lobby, code) {
  try {
    if (!lobby || !lobby.rooms || typeof lobby.rooms.get !== 'function') return null;
    const room = lobby.rooms.get(code);
    return room && typeof room === 'object' ? room : null;
  } catch (e) {
    return null;
  }
}

/** `error` from a board JSON reply, or '' (the board speaks {ok:false, error:'FORBIDDEN'|…}). */
export function boardErrorOf(json) {
  return json && json.ok !== true && typeof json.error === 'string' ? json.error : '';
}

/**
 * The publisher. Everything it touches (fetch, clock, timers, the room reader) is injectable so the
 * tests can drive a whole publish→patch→delete lifecycle with no network and no timers.
 *
 * @param {object} [options]
 * @param {string} [options.boardBase]   board origin (constant by default)
 * @param {Function} [options.fetchImpl] fetch-compatible
 * @param {Function} [options.readRoom]  (code) => room record | null   (wired to ctx.server.lobby)
 * @param {Function} [options.log]       one-line logger
 * @param {number}   [options.intervalMs]
 */
export function createPublisher(options = {}) {
  const boardBase = options.boardBase || DEFAULT_BOARD_URL;
  const doFetch = options.fetchImpl || globalThis.fetch;
  const readRoom = options.readRoom || (() => null);
  const log = typeof options.log === 'function' ? options.log : () => {};
  const intervalMs = options.intervalMs || PATCH_INTERVAL_MS;
  const setIv = options.setIntervalFn || setInterval;
  const clearIv = options.clearIntervalFn || clearInterval;
  const saveSaved = typeof options.saveSaved === 'function' ? options.saveSaved : () => {};
  const clearSaved = typeof options.clearSaved === 'function' ? options.clearSaved : () => {};

  const st = { published: false, code: '', token: '', lastError: '', lastOkAt: 0, timer: null,
    serverId: '', serverName: '', url: '', difficulty: '' };

  function stopTimer() {
    if (st.timer != null) {
      clearIv(st.timer);
      st.timer = null;
    }
  }

  function clearOwnership() {
    st.published = false;
    st.token = '';
    st.serverId = '';
    stopTimer();
    clearSaved();
  }

  async function call(apiPath, method, body, token) {
    const url = boardUrlOf(boardBase, apiPath);
    const init = { method: method, cache: 'no-store', headers: {} };
    if (body) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (token) init.headers['X-Token'] = token;
    try {
      init.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    } catch (e) { /* older runtime: no timeout */ }
    const res = await doFetch(url, init);
    let json = {};
    try {
      json = await res.json();
    } catch (e) { /* empty/non-JSON body */ }
    return json && typeof json === 'object' ? json : {};
  }

  /** Publish (or republish) the room. Returns {ok, error}. */
  async function _publish(input) {
    const code = String((input && input.code) || '').trim().toUpperCase();
    const serverId = String((input && input.serverId) || '').trim();
    if (!CODE_RE.test(code)) return { ok: false, error: 'BAD_CODE' };
    if (!serverId) return { ok: false, error: 'NO_SERVER_ID' };
    const room = readRoom(code);
    if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' };
    const body = publishBodyOf({ code: code, serverId: serverId, serverName: input.serverName,
      url: input.url, difficulty: input.difficulty, room: room });
    let json;
    try {
      json = await call('/api/rooms', 'POST', body, '');
    } catch (e) {
      st.lastError = 'network';
      return { ok: false, error: 'network' };
    }
    const err = boardErrorOf(json);
    if (err || !json.token) {
      st.lastError = err || 'NO_TOKEN';
      log(`[sp-lobby] publish ${code} refused: ${st.lastError}`);
      return { ok: false, error: st.lastError };
    }
    st.published = true;
    st.code = code;
    st.token = String(json.token);
    st.serverId = serverId;
    st.serverName = String((input && input.serverName) || '');
    st.url = String((input && input.url) || '');
    st.difficulty = String((input && input.difficulty) || '');
    st.lastError = '';
    st.lastOkAt = Date.now();
    saveSaved({ code: code, serverId: serverId, token: st.token }); // 重启后还能把这一行删掉（治幽灵房）
    stopTimer();
    st.timer = setIv(() => { serialize(() => _tick()); }, intervalMs);
    log(`[sp-lobby] published ${code} (serverId=${serverId}); patching every ${Math.round(intervalMs / 1000)}s`);
    return { ok: true };
  }

  /** One report tick: DELETE when the room is gone, otherwise PATCH the live numbers. */
  async function _tick() {
    if (!st.published) return { ok: false, error: 'skipped' };
    const room = readRoom(st.code);
    if (!room) {
      // The room is gone (closed / host moved on) — remove the row NOW instead of waiting for the TTL.
      await _remove('ROOM_GONE');
      return { ok: true, removed: true };
    }
    const body = publishBodyOf({ code: st.code, serverId: st.serverId, serverName: st.serverName,
      url: st.url, difficulty: st.difficulty, room: room });
    let json;
    try {
      json = await call('/api/rooms', 'PATCH', body, st.token);
    } catch (e) {
      st.lastError = 'network';
      return { ok: false, error: 'network' };
    }
    const err = boardErrorOf(json);
    if (err === 'FORBIDDEN' || err === 'NOT_FOUND') {
      // We are no longer the publisher (the token rotated, the row expired) — stop, do not keep hammering.
      st.lastError = err;
      clearOwnership();
      log(`[sp-lobby] ${st.code} ${err}: ownership lost, reporting stopped`);
      return { ok: false, error: err };
    }
    st.lastError = err;
    if (json.ok === true) st.lastOkAt = Date.now();
    return { ok: json.ok === true, error: err };
  }

  /** Unpublish (or clean up): DELETE the row with our token, then forget the ownership. */
  async function _remove(reason) {
    if (!st.token || !st.code) {
      clearOwnership();
      return { ok: true, skipped: true };
    }
    const code = st.code;
    const token = st.token;
    let json = {};
    try {
      json = await call('/api/rooms?code=' + encodeURIComponent(code) + '&serverId=' + encodeURIComponent(st.serverId),
        'DELETE', null, token);
    } catch (e) {
      st.lastError = 'network';
      return { ok: false, error: 'network' };
    }
    const err = boardErrorOf(json);
    if (!err || err === 'NOT_FOUND' || err === 'FORBIDDEN') {
      clearOwnership();
      log(`[sp-lobby] removed ${code} (${reason || 'manual'})`);
      return { ok: true };
    }
    st.lastError = err;
    return { ok: false, error: err };
  }

  // 串行化：publish / unpublish / tick 都会改发布状态，而「POST 还在路上时收到取消」会让
  // 取消先清掉持有权、POST 回来又把 published 置真——房间在报告已取消之后仍然公开。串成一条链，
  // 每个操作都在前一个落地之后才开始（tick 也进链：慢网络下一次心跳不会和取消抢）。
  let opChain = Promise.resolve();
  function serialize(fn) {
    const run = opChain.then(fn, fn);
    opChain = run.then(() => {}, () => {});
    return run;
  }

  /** 启动清理：上一次运行（进程重启/更新）留下的那一行，用的是我们已丢失的 token——只能尽力 DELETE，
   *  失败就交给 600s TTL。调用方（install）负责把存档读出来。 */
  async function cleanupSaved(doc) {
    const code = String((doc && doc.code) || '').toUpperCase();
    const token = String((doc && doc.token) || '');
    const serverId = String((doc && doc.serverId) || '');
    if (!CODE_RE.test(code) || !token || !serverId) return { ok: false, error: 'BAD_SAVED' };
    st.code = code;
    st.token = token;
    st.serverId = serverId;
    const r = await _remove('restart-cleanup');
    return r;
  }

  return {
    cleanupSaved: (doc) => serialize(() => cleanupSaved(doc)),
    publish: (input) => serialize(() => _publish(input)),
    tick: () => serialize(() => _tick()),
    unpublish: () => serialize(() => _remove('unpublish')),
    /** Status for the control route — never includes the token. */
    status: () => ({
      ok: true,
      published: st.published,
      code: st.published ? st.code : '',
      lastError: st.lastError,
      lastOkAt: st.lastOkAt || null,
    }),
    /** Test/diagnostic accessor for the timer object. */
    _state: st,
  };
}

/** The `/healthz` header patch: force ACAO on that path only, leave every other path untouched. */
export function patchHealthzCors(req, res) {
  let path = '';
  try {
    path = new URL(req.url || '/', 'http://localhost').pathname;
  } catch (e) {
    path = '';
  }
  if (path !== HEALTHZ_PATH) return false;
  try {
    const orig = res.setHeader.bind(res);
    res.setHeader = function (name, value) {
      if (String(name || '').toLowerCase() === 'access-control-allow-origin') return res; // ours wins
      return orig(name, value);
    };
    // writeHead(object) 的键会压过 setHeader —— 上游若用对象形式写头，我们的 * 会被顶掉，连它一起包。
    if (typeof res.writeHead === 'function') {
      const origWriteHead = res.writeHead.bind(res);
      res.writeHead = function (status, reasonOrHeaders, maybeHeaders) {
        const headers = reasonOrHeaders && typeof reasonOrHeaders === 'object' ? reasonOrHeaders : maybeHeaders;
        if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
          for (const k of Object.keys(headers)) {
            if (String(k).toLowerCase() === 'access-control-allow-origin') delete headers[k];
          }
        }
        return origWriteHead.apply(null, arguments);
      };
    }
    orig('Access-Control-Allow-Origin', '*');
    orig('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  } catch (e) { /* exotic response object: leave it alone */ }
  return true;
}

/** Read a small JSON body (capped). Resolves {} on anything unexpected. */
function readJsonBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          finish({});
          try { req.destroy(); } catch (e) { /* ignore */ }
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch (e) {
          finish({});
        }
      });
      req.on('error', () => finish({}));
    } catch (e) {
      finish({});
    }
  });
}

function sendJson(res, status, doc) {
  const text = JSON.stringify(doc);
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  } catch (e) { /* client went away */ }
}

/**
 * install(ctx) — the loader contract. Attaches the control routes in front of the stock request
 * listener(s) and forwards everything else untouched (listener-in-order, exactly like sp-connect).
 */
export async function install(ctx) {
  const log = typeof ctx?.log === 'function' ? ctx.log : (m) => console.log(m);
  const server = ctx?.server;
  const lobby = server?.lobby || null;
  // 发布状态的存档（重启后把上一次那一行删掉）：只在 Node 侧接线，浏览器/测试环境没有 fs。
  const statePath = ctx?.upstreamDir ? path.join(ctx.upstreamDir, SAVED_STATE_FILE) : '';
  const readSaved = () => {
    if (!statePath) return null;
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (e) {
      return null;
    }
  };
  const publisher = createPublisher({
    log: log,
    // ctx.boardBase / ctx.fetchImpl exist for diagnostics and tests ONLY: production always uses the
    // constant https board and the platform fetch, so no configurable URL can ever be dialed.
    boardBase: typeof ctx?.boardBase === 'string' && ctx.boardBase ? ctx.boardBase : DEFAULT_BOARD_URL,
    fetchImpl: typeof ctx?.fetchImpl === 'function' ? ctx.fetchImpl : undefined,
    readRoom: (code) => readRoomFrom(lobby, code),
    saveSaved: (doc) => {
      if (!statePath) return;
      try { fs.writeFileSync(statePath, JSON.stringify(doc) + String.fromCharCode(10)); } catch (e) { /* 只读树：交给 TTL */ }
    },
    clearSaved: () => {
      if (!statePath) return;
      try { fs.rmSync(statePath, { force: true }); } catch (e) { /* ignore */ }
    },
  });
  const saved = readSaved();
  if (saved) {
    publisher.cleanupSaved(saved).then((r) => log(`[sp-lobby] restart cleanup ${saved.code}: ${r && r.ok ? 'removed' : 'left to TTL'}`),
      () => {});
  }
  if (!server || typeof server.on !== 'function' || typeof server.removeAllListeners !== 'function') {
    log('[sp-lobby] no http server in ctx — control routes not attached (publisher returned for tests)');
    return publisher;
  }

  const prev = server.listeners('request').slice();
  for (const l of prev) server.removeListener('request', l);

  server.on('request', (req, res) => {
    let path = '';
    try {
      path = new URL(req.url || '/', 'http://localhost').pathname;
    } catch (e) {
      path = '';
    }
    if (path === ROUTE_PUBLISH || path === ROUTE_STATUS) {
      // Control plane: loopback peer AND loopback Origin — nothing else is touched before this check.
      const peerOk = isLoopback(req.socket && req.socket.remoteAddress);
      const originOk = originAllowed(req.headers && req.headers.origin);
      if (!peerOk || !originOk) {
        sendJson(res, 403, { ok: false, error: 'FORBIDDEN' });
        return;
      }
      if (path === ROUTE_STATUS) {
        sendJson(res, 200, publisher.status());
        return;
      }
      if (String(req.method || '').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'METHOD' });
        return;
      }
      readJsonBody(req).then(async (body) => {
        try {
          if (body && body.on === false) {
            const r = await publisher.unpublish();
            sendJson(res, r.ok ? 200 : 502, r.ok ? { ok: true, published: false } : { ok: false, error: r.error });
          } else {
            const r = await publisher.publish(body || {});
            sendJson(res, r.ok ? 200 : 502, r.ok
              ? { ok: true, published: true, code: String(body.code || '').toUpperCase() }
              : { ok: false, error: r.error });
          }
        } catch (e) {
          sendJson(res, 500, { ok: false, error: 'EXCEPTION' });
        }
      });
      return;
    }
    try {
      patchHealthzCors(req, res); // /healthz only (public read-only aggregate; the lobby page probes it)
    } catch (e) { /* never block the stock path over a header */ }
    for (const l of prev) {
      try {
        l.call(server, req, res);
      } catch (e) {
        log(`[sp-lobby] stock listener threw: ${e && e.message}`);
      }
    }
  });

  log(`[sp-lobby] ready: ${ROUTE_PUBLISH} (POST publish/unpublish) + ${ROUTE_STATUS} — loopback peer + Origin required; /healthz carries ACAO`);
  return publisher;
}
