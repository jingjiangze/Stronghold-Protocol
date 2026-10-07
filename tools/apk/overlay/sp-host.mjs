// sp-host.mjs - server-side HOST endpoints as an overlay (overlay API 1).
//
// WHY (owner decision 2026-10-07: the server/index.js patch entries go to ZERO): the shell endpoints
// that used to be spliced into upstream server/index.js by tools/apk/patches/settings-v2.1.json
// (#9 /_shell/rooms, #10 dc bridge), settings-v3.0.json (#1 /room-probe) and settings-v5.5.json
// (all 5 edits: LAN discovery) move here. This file is ADDITIVE - a new file under server/overlay/
// that rides the L1 content slim and is loaded by extras/server/overlay-loader.mjs after
// startServer(). No upstream file is edited. settings-v2.9.json (#1 room-presence) is deliberately
// NOT ported: on the shell the upstream main() never runs (extras/server/android-main.mjs bypasses
// the isMain() gate), so that patch was dead code on-device, and android-main already starts
// presence (room-discovery.mjs startPresence) - starting it here again would double-report.
//
// ROUTES (served by the wrapped request dispatcher; everything else is forwarded unchanged)
//   GET  /lan/rooms               LAN room listing - only rooms the host explicitly published via
//                                 /lan/publish (review finding #1: unconditional listing would let
//                                 any device on the same Wi-Fi join without an invitation)
//   GET  /lan/room?code=CODE      single-room existence/joinability answer (the invite-code path)
//   GET|HEAD|POST /lan/publish    publish toggle (loopback peer only) + read-only status branch
//   GET  /_shell/rooms            room online status for the panel / dc bridge (v2.1 #9 shape)
//   GET  /room-probe/<code>       L1 probe {ok,exists,joinable} via extras/server/room-discovery.mjs
//   GET /healthz                  NOT claimed here: still answered by upstream untouched (its CORS
//                                 ACAO comes from sp-lobby.mjs patchHealthzCors when co-installed)
// plus a fixed-port discovery listener (LAN_DISCOVERY_PORT = 32123) serving ONLY the two read-only
// LAN routes - no static files, no /healthz, no WS, and deliberately no /lan/publish (the discovery
// surface must not be able to change state).
//
// CONTRACT with the Android client (android/app/src/main/java/icu/jiangjiangze/stronghold/LanScan.java,
// which is NEWER than the v5.5 patch - PR #23 vs #19): LanScan.probe() reads ok / port / rooms[] from
// the response body and per-room code/name/mode/difficulty/seats/humans/inMatch (ip/port/url are added
// client-side). The old patch answered /lan/room?code= with a FLAT body ({ok,port,...view}) which the
// current client would drop (it only collects from the rooms array) - this overlay therefore answers
// BOTH routes with the same envelope {ok:true, port, rooms:[view]}. See the delivery doc for the
// field-by-field table.
//
// SECURITY (asserted in tools/apk/overlay-sp-host.test.mjs)
//   1. /lan/rooms and /lan/room answer ONLY loopback/private socket peers (mirror of upstream net.js
//      isLocalIp/normalizeIp: X-Forwarded-For / CF-Connecting-IP are never consulted, so a public
//      request cannot masquerade as a LAN peer). A public peer and an unknown code share ONE identical
//      404 body - the response never reveals whether a code exists.
//   2. /lan/publish answers ONLY loopback peers (the host's own page); neighbors can neither publish
//      someone else's room nor read the publish state. No Origin check, exactly like the patch (a
//      loopback peer is already out of reach for browser pages on other hosts).
//   3. /_shell/rooms and /room-probe/<code> keep the patch's original semantics: unauthenticated,
//      read-only, no seat details (same exposure class as the upstream /healthz aggregate).
//   4. This overlay dials NOTHING: the only dynamic imports are local module FILES from upstreamDir
//      (room-discovery.mjs / webrtc-bridge.mjs), never URLs. The dc bridge's outbound traffic is the
//      operator-set SP_DIR_URL, unchanged from the patch. No credential literals anywhere.
//   5. EADDRINUSE on 32123 is swallowed (another holder keeps the port - on patched builds the
//      patch's own discoveryServer binds first, see TRANSITION below): the host must never fail to
//      boot. The listener is unref()ed so it never holds the process open.
//
// TRANSITION (patches still applied + this overlay shipped by content): the patched startServer()
// binds 32123 BEFORE overlays load, so this overlay's discovery bind fails with EADDRINUSE and is
// marked "foreign". While foreign, /lan/publish is FORWARDED to the (still-patched) upstream so the
// patch's own lanPublic set keeps feeding its 32123 listener - LAN discovery keeps working on old
// APKs. Once the patches are removed the bind succeeds and this overlay owns the whole surface.
// Install order is by filename: sp-connect -> sp-host -> sp-lobby (sp-lobby's wrapper stays in front
// of ours; forwarding preserves the chain and /healthz CORS).
//
// EXPORTS: overlayApi/id/install (loader contract) plus pure helpers, the room view and a controller
// factory used by the tests. A throwing install() is logged and skipped by the loader.

import http from 'node:http';
import path from 'node:path';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { isLoopback } from './sp-connect.mjs';

/** Overlay loader contract (server/overlay-loader.mjs). */
export const overlayApi = 1;
/** Overlay id for logs / handshake.json. */
export const id = 'sp-host';

/** Fixed discovery port shared with android .../LanScan.java DISCOVERY_PORT. */
export const LAN_DISCOVERY_PORT = 32123;
/** LAN routes. */
export const ROUTE_LAN_ROOMS = '/lan/rooms';
export const ROUTE_LAN_ROOM = '/lan/room';
export const ROUTE_LAN_PUBLISH = '/lan/publish';
/** Shell panel / dc-bridge data source (v2.1 #9). */
export const ROUTE_SHELL_ROOMS = '/_shell/rooms';
/** L1 probe prefix (v3.0 #1). */
export const ROUTE_PROBE_PREFIX = '/room-probe/';

/** Room code gate for /lan/room and /lan/publish (patch verbatim). */
export const CODE_RE = /^[A-Z0-9]{4}$/;

/** POST body cap for /lan/publish (patch verbatim: 4 KB). */
const BODY_LIMIT = 4096;
/** POST body read deadline (patch verbatim: 3 s, then the socket is destroyed). */
const BODY_TIMEOUT_MS = 3000;
/** Bounded wait for the 32123 bind outcome inside install() (never block the host boot). */
const BIND_WAIT_MS = 1000;

const msg = (e) => (e && e.message ? String(e.message) : String(e));

// ---------------------------------------------------------------------------------------------------
// IP helpers - a faithful local mirror of upstream server/net.js normalizeIp (L361) / isLocalIp
// (L398). The overlay must not depend on upstream line numbers (that is exactly what patches get
// wrong), so the semantics are copied here and pinned by tests. IPv4-mapped IPv6, zones, [v6]:port
// and v4:port forms are normalized before classification.
// ---------------------------------------------------------------------------------------------------

/** Expand an IPv6 address into 8 numeric groups (null when malformed). @param {string} ip */
function ipv6Groups(ip) {
  let s = ip;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array(Math.max(0, fill)).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** Normalize a peer address: strip brackets/port/zone, unmap ::ffff:a.b.c.d. '' when not an IP. */
export function normalizeIp(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  const withPort = /^\[([^\]]+)\](?::\d+)?$/.exec(s) || /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
  if (withPort) s = withPort[1];
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) s = mapped[1];
  if (isIP(s) === 6) {
    const g = ipv6Groups(s);
    if (g && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) s = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return isIP(s) ? s : '';
}

/** Loopback/private/link-local/CGNAT/unspecified check (net.js isLocalIp, verbatim semantics). */
export function isLocalIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 0;
  }
  if (isIP(ip) === 6) {
    const g = ipv6Groups(ip);
    if (!g) return false;
    if (g.every((x, i) => (i < 7 ? x === 0 : x <= 1))) return true; // ::1 and ::
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------
// Small HTTP helpers (splitUrl is the upstream verbatim shape; sendJson mirrors the upstream
// HEAD-suppression and adds nosniff because the stock server-level header never runs for
// overlay-answered requests).
// ---------------------------------------------------------------------------------------------------

/** Split an absolute request URL into raw path + query (upstream server/index.js splitUrl). */
export function splitUrl(url) {
  let u = url || '/';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try { const parsed = new URL(u); u = parsed.pathname + parsed.search; } catch { return null; }
  }
  const q = u.indexOf('?');
  const hashless = (s) => { const h = s.indexOf('#'); return h >= 0 ? s.slice(0, h) : s; };
  return q >= 0 ? { rawPath: hashless(u.slice(0, q)), query: hashless(u.slice(q + 1)) } : { rawPath: hashless(u), query: '' };
}

function sendJson(req, res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(req && req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    try { res.destroy?.(); } catch { /* client went away */ }
  }
}

/** Minimal JSON body read for /lan/publish POST (patch verbatim: 4 KB cap, 3 s deadline, then cut). */
function readJsonBody(req, cb) {
  let body = '';
  let done = false;
  const finish = (v) => { if (done) return; done = true; cb(v); };
  const bail = () => { finish(null); try { req.destroy(); } catch { /* ignore */ } };
  try { req.setTimeout(BODY_TIMEOUT_MS, bail); } catch { /* exotic request object */ }
  req.on('data', (c) => { body += c; if (body.length > BODY_LIMIT) bail(); });
  req.on('end', () => { try { finish(JSON.parse(body || '{}')); } catch { finish(null); } });
  req.on('error', () => finish(null));
}

// ---------------------------------------------------------------------------------------------------
// Room view - the exact field set LanScan.java and the panel consume. Data source is ctx.server.lobby
// (upstream Lobby: rooms Map, getRoom(), Room { code, mode, difficulty, seats, match, activeHumans() }).
// ---------------------------------------------------------------------------------------------------

/**
 * One room as the LAN contract wants it. `name` is the first active (seated, non-bot, non-left)
 * human's name or falls back to the code (patch verbatim). `inMatch` reads the upstream `match`
 * field and tolerates an `inMatch` alias the way sp-lobby's liveFieldsOf does.
 * @param {object | null | undefined} room
 */
export function roomViewOf(room) {
  const r = room && typeof room === 'object' ? room : {};
  const seats = Array.isArray(r.seats) ? r.seats : [];
  let humans = 0;
  if (typeof r.activeHumans === 'function') {
    try {
      const h = r.activeHumans();
      humans = Array.isArray(h) ? h.length : 0;
    } catch { humans = 0; }
  } else {
    for (const s of seats) if (s && typeof s === 'object' && !s.isBot && !s.left) humans++;
  }
  let firstHuman = null;
  for (const s of seats) {
    if (s && typeof s === 'object' && !s.isBot && !s.left) { firstHuman = s; break; }
  }
  return {
    code: typeof r.code === 'string' ? r.code : String(r.code ?? ''),
    name: (firstHuman && typeof firstHuman.name === 'string' && firstHuman.name) || r.code || '',
    mode: r.mode,
    difficulty: r.difficulty,
    seats: seats.length,
    humans,
    inMatch: !!(r.match || r.inMatch),
  };
}

/** Read one room out of the lobby (Lobby.getRoom when present, else the rooms Map). Null when gone. */
function readRoomFrom(lobby, code) {
  try {
    if (lobby && typeof lobby.getRoom === 'function') {
      const r = lobby.getRoom(code);
      return r && typeof r === 'object' ? r : null;
    }
    if (lobby && lobby.rooms && typeof lobby.rooms.get === 'function') {
      const r = lobby.rooms.get(String(code).toUpperCase());
      return r && typeof r === 'object' ? r : null;
    }
  } catch (e) { /* fall through */ }
  return null;
}

/** Resolve the http.Server to wrap: ctx.server itself, or the startServer() result's .server. */
function resolveHttpServer(srv) {
  if (srv && typeof srv.on === 'function' && typeof srv.removeAllListeners === 'function') return srv;
  const inner = srv && typeof srv === 'object' ? srv.server : null;
  if (inner && typeof inner.on === 'function' && typeof inner.removeAllListeners === 'function') return inner;
  return null;
}

/** APP_VERSION / PROTOCOL_VERSION from <upstreamDir>/../shared/constants.js (null when unresolvable). */
async function resolveVersions(upstreamDir) {
  if (!upstreamDir || typeof upstreamDir !== 'string') return null;
  try {
    const m = await import(pathToFileURL(path.join(upstreamDir, '..', 'shared', 'constants.js')).href);
    const app = typeof m.APP_VERSION === 'string' ? m.APP_VERSION : null;
    const protocol = typeof m.PROTOCOL_VERSION === 'number' ? m.PROTOCOL_VERSION : null;
    return app == null && protocol == null ? null : { app, protocol };
  } catch (e) {
    return null;
  }
}

function defaultImportFrom(upstreamDir, file) {
  return () => {
    if (!upstreamDir || typeof upstreamDir !== 'string') {
      return Promise.reject(new Error(`no upstreamDir - cannot load ${file}`));
    }
    return import(pathToFileURL(path.join(upstreamDir, file)).href);
  };
}

// ---------------------------------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------------------------------

/**
 * Build one sp-host controller. All seams are injectable for tests (lobby, env, the two dynamic
 * importers, port/host/versions); install() uses the defaults wired to ctx.
 * @param {object} [options]
 * @param {object} [options.lobby]         upstream Lobby (rooms Map / getRoom)
 * @param {number} [options.port]          the game port (LanScan contract: answered as `port`)
 * @param {string} [options.host]          bind host for the discovery listener (ctx.host)
 * @param {string} [options.upstreamDir]   directory of the running server/index.js
 * @param {{app: string|null, protocol: number|null}|null} [options.versions]
 * @param {(m: string) => void} [options.log]
 * @param {object} [options.env]           env source for the dc bridge gate (default process.env)
 * @param {() => Promise<any>} [options.importProbe]   room-discovery.mjs loader (default: upstreamDir)
 * @param {() => Promise<any>} [options.importBridge]  webrtc-bridge.mjs loader (default: upstreamDir)
 * @param {number} [options.discoveryPort] override for tests (default LAN_DISCOVERY_PORT)
 */
export function createController(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const lobby = options.lobby || null;
  const port = Number.isInteger(options.port) && options.port > 0 ? options.port : 0;
  const host = typeof options.host === 'string' && options.host ? options.host : null;
  const upstreamDir = typeof options.upstreamDir === 'string' ? options.upstreamDir : undefined;
  const versions = options.versions && typeof options.versions === 'object' ? options.versions : null;
  const env = options.env || process.env;
  const importProbe = typeof options.importProbe === 'function'
    ? options.importProbe
    : defaultImportFrom(upstreamDir, 'room-discovery.mjs');
  const importBridge = typeof options.importBridge === 'function'
    ? options.importBridge
    : defaultImportFrom(upstreamDir, 'webrtc-bridge.mjs');
  const discoveryPort = Number.isInteger(options.discoveryPort) && options.discoveryPort > 0
    ? options.discoveryPort
    : LAN_DISCOVERY_PORT;

  // Published room codes (the host's own page toggles them via /lan/publish). Default empty -
  // review finding #1: listing every room would let any device on the same Wi-Fi join uninvited.
  const lanPublic = new Set();

  // 'idle' -> 'starting' -> 'mine' | 'foreign' | 'failed'; 'closed' after closeDiscovery().
  let discoveryState = 'idle';
  let discoveryServer = null;
  let discoveryWait = null;

  const isLanPeer = (req) => isLocalIp(normalizeIp(req && req.socket && req.socket.remoteAddress));
  // The patch checks normalizeIp(peer) in {127.0.0.1, ::1}; sp-connect's isLoopback is the same set
  // for socket peers (127/8, ::1, ::ffff:127/8) and is already the control-plane convention.
  const isLoopbackPeer = (req) => isLoopback(req && req.socket && req.socket.remoteAddress);

  const lanNotFound = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    sendJson(req, res, 404, { ok: false, error: 'not found' });
  };

  /** Only rooms the host published; gone/solo codes self-heal out of the set (patch verbatim). */
  const lanRooms = () => {
    const out = [];
    for (const code of Array.from(lanPublic)) {
      const r = readRoomFrom(lobby, code);
      if (!r || r.mode !== 'coop') { lanPublic.delete(code); continue; }
      out.push(roomViewOf(r));
    }
    return out;
  };

  /**
   * Serve the LAN routes - true when the request was handled (patch handleLanRoute, ported).
   * @returns {boolean}
   */
  function handleLanRoute(req, res, parts) {
    if (parts.rawPath === ROUTE_LAN_PUBLISH) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!isLoopbackPeer(req)) { lanNotFound(req, res); return true; }
      const method = String((req && req.method) || '').toUpperCase();
      // Read-only status branch (patch v5.6.1): the panel shows the REAL toggle state.
      if (method === 'GET' || method === 'HEAD') {
        const qcode = String(new URLSearchParams(parts.query).get('code') || '').toUpperCase();
        if (!CODE_RE.test(qcode)) { lanNotFound(req, res); return true; }
        sendJson(req, res, 200, { ok: true, code: qcode, on: lanPublic.has(qcode) });
        return true;
      }
      if (method !== 'POST') { lanNotFound(req, res); return true; }
      readJsonBody(req, (body) => {
        const code = String((body && body.code) || '').toUpperCase();
        if (!CODE_RE.test(code) || !readRoomFrom(lobby, code)) { lanNotFound(req, res); return; }
        if (body && body.on) lanPublic.add(code); else lanPublic.delete(code);
        sendJson(req, res, 200, { ok: true, code, on: lanPublic.has(code) });
      });
      return true;
    }
    if (parts.rawPath !== ROUTE_LAN_ROOMS && parts.rawPath !== ROUTE_LAN_ROOM) return false;
    res.setHeader('Access-Control-Allow-Origin', '*');
    const method = String((req && req.method) || '').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendJson(req, res, 405, { ok: false, error: 'method not allowed' });
      return true;
    }
    if (!isLanPeer(req)) { lanNotFound(req, res); return true; }
    if (parts.rawPath === ROUTE_LAN_ROOMS) {
      const payload = { ok: true, port, rooms: lanRooms() };
      if (versions && versions.app != null) payload.app = versions.app;
      if (versions && versions.protocol != null) payload.protocol = versions.protocol;
      sendJson(req, res, 200, payload);
      return true;
    }
    const code = String(new URLSearchParams(parts.query).get('code') || '').toUpperCase();
    if (!CODE_RE.test(code)) { lanNotFound(req, res); return true; }
    const room = readRoomFrom(lobby, code);
    // Same envelope as /lan/rooms - LanScan.java only collects hits from the rooms array (the old
    // patch's flat body would be dropped by the current client).
    if (!room) { lanNotFound(req, res); return true; }
    sendJson(req, res, 200, { ok: true, port, rooms: [roomViewOf(room)] });
    return true;
  }

  /** /_shell/rooms (v2.1 #9): read-only room status for the panel / dc bridge. */
  function handleShellRooms(req, res) {
    const rooms = [];
    try {
      if (lobby && lobby.rooms && typeof lobby.rooms.values === 'function') {
        for (const r of lobby.rooms.values()) {
          rooms.push({ code: r.code, mode: r.mode, difficulty: r.difficulty, inMatch: !!(r.match || r.inMatch) });
        }
      }
    } catch (e) { /* answer what we could read */ }
    sendJson(req, res, 200, { ok: true, rooms });
  }

  /** /room-probe/<code> (v3.0 #1): L1 probe served by extras room-discovery.mjs handleProbe. */
  function handleProbeRoute(req, res, parts) {
    const code = parts.rawPath.slice(ROUTE_PROBE_PREFIX.length);
    Promise.resolve()
      .then(() => importProbe())
      .then((m) => {
        if (m && typeof m.handleProbe === 'function') {
          m.handleProbe(req, res, lobby, code, sendJson);
          return;
        }
        sendJson(req, res, 500, { ok: false, error: 'probe failed' });
      })
      .catch(() => sendJson(req, res, 500, { ok: false, error: 'probe failed' }));
  }

  /**
   * The wrapped dispatcher: true when this overlay consumed the request, false to forward to the
   * captured listeners (stock, sp-connect, sp-lobby - whoever was attached before us).
   * @returns {boolean}
   */
  function handleRequest(req, res) {
    const parts = splitUrl((req && req.url) || '/');
    if (!parts) return false; // upstream answers its own 400
    if (parts.rawPath === ROUTE_LAN_PUBLISH) {
      // TRANSITION: while the patch's own 32123 listener holds the port, feed ITS lanPublic set by
      // forwarding the publish route to the (still-patched) upstream.
      if (discoveryState === 'foreign') return false;
      return handleLanRoute(req, res, parts);
    }
    if (parts.rawPath === ROUTE_LAN_ROOMS || parts.rawPath === ROUTE_LAN_ROOM) {
      return handleLanRoute(req, res, parts);
    }
    if (parts.rawPath === ROUTE_SHELL_ROOMS) {
      const method = String((req && req.method) || '').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') return false; // upstream's global 405 gate answers
      handleShellRooms(req, res);
      return true;
    }
    if (parts.rawPath.startsWith(ROUTE_PROBE_PREFIX)) {
      const method = String((req && req.method) || '').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') return false; // upstream's global 405 gate answers
      handleProbeRoute(req, res, parts);
      return true;
    }
    return false;
  }

  /**
   * Start (once) the fixed-port discovery listener: read-only LAN routes only, EADDRINUSE swallowed
   * into the 'foreign' state (the patch's own listener binds first while patches exist), unref()ed.
   * @returns {Promise<'mine'|'foreign'|'failed'|'closed'>}
   */
  function startDiscovery() {
    if (discoveryWait) return discoveryWait;
    discoveryWait = new Promise((resolve) => {
      if (discoveryState === 'closed') { resolve('closed'); return; }
      discoveryState = 'starting';
      const srv = http.createServer((req, res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const parts = splitUrl(req.url || '/');
        if (parts && (parts.rawPath === ROUTE_LAN_ROOMS || parts.rawPath === ROUTE_LAN_ROOM)
          && handleLanRoute(req, res, parts)) return;
        lanNotFound(req, res);
      });
      let settled = false;
      const settle = (state) => { if (!settled) { settled = true; discoveryState = state; resolve(state); } };
      srv.on('error', (e) => {
        if (e && e.code === 'EADDRINUSE') {
          log(`[sp-host] discovery port ${discoveryPort} busy - discovery stays with its current holder (publish is forwarded)`);
          settle('foreign');
          return;
        }
        log(`[sp-host] discovery server error: ${msg(e)}`);
        settle('failed');
      });
      srv.listen(discoveryPort, host || undefined, () => {
        if (discoveryState === 'closed') { try { srv.close(() => {}); } catch { /* ignore */ } return; }
        discoveryServer = srv;
        settle('mine');
        log(`[sp-host] discovery listening on :${discoveryPort} (read-only /lan/rooms + /lan/room)`);
      });
      srv.unref();
    });
    return discoveryWait;
  }

  /** Close the discovery listener (main server 'close' / controller.close()). Resolves when closed. */
  function closeDiscovery() {
    if (discoveryState === 'closed') return Promise.resolve();
    discoveryState = 'closed';
    const srv = discoveryServer;
    discoveryServer = null;
    if (!srv) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        srv.close(() => resolve());
        // keep-alive sockets must not hold the port: same discipline as upstream srv.close()
        srv.closeIdleConnections?.();
        const t = setTimeout(() => { srv.closeAllConnections?.(); }, 200);
        t.unref?.();
      } catch (e) { resolve(); }
    });
  }

  /**
   * dc bridge (v2.1 #10, ported): SP_DC-gated dynamic import of upstreamDir/webrtc-bridge.mjs.
   * The patch anchored inside upstream main() (never runs under the shell) and referenced
   * `actualPort`, which is out of scope there - here the port comes from ctx. Fire-and-forget with
   * a logged failure, exactly like the patch's .catch. The bridge has no stop API (2 s polling
   * interval, process lifetime), same as the patch.
   * @returns {boolean} true when the gate passed and the import was started
   */
  function maybeStartDcBridge() {
    // Gate verbatim: SP_DC absent or anything but '0' counts as enabled (patch semantics).
    if (!(String(env.SP_DC || '') !== '0' && env.SP_DIR_URL)) return false;
    Promise.resolve()
      .then(() => importBridge())
      .then((m) => {
        if (m && typeof m.startBridge === 'function') {
          m.startBridge({ port });
          log('[sp-host] dc bridge started (SP_DIR_URL set, SP_DC != 0)');
          return;
        }
        log('[sp-host] dc-bridge module has no startBridge export');
      })
      .catch((e) => log(`[sp-host] dc-bridge init failed: ${msg(e)}`));
    return true;
  }

  // --- listener wrapping (detach originals, run our dispatcher first - sp-connect pattern) ---

  let attachedServer = null;
  let requestListeners = [];
  let onRequestWrapper = null;
  let onCloseWrapper = null;

  const snapshot = (server) => (typeof server.rawListeners === 'function'
    ? server.rawListeners('request')
    : server.listeners('request')).slice();
  const callAll = (listeners, args) => {
    for (const listener of listeners) {
      try {
        listener.apply(attachedServer, args);
      } catch (e) {
        log(`[sp-host] upstream listener failed: ${msg(e)}`);
      }
    }
  };

  /** Wrap the server's 'request' listeners; forward everything we do not answer. */
  function attach(server) {
    detach();
    requestListeners = snapshot(server);
    server.removeAllListeners('request');
    onRequestWrapper = (req, res) => {
      let handled = false;
      try {
        handled = handleRequest(req, res);
      } catch (e) {
        log(`[sp-host] request handler failed: ${msg(e)}`);
        handled = false;
      }
      if (handled) return;
      callAll(requestListeners, [req, res]);
    };
    onCloseWrapper = () => { closeDiscovery(); };
    server.on('request', onRequestWrapper);
    // The patch closes its discoveryServer next to wss.close() inside the startServer() close();
    // the http.Server 'close' event fires at the same point of that sequence.
    server.on('close', onCloseWrapper);
    attachedServer = server;
  }

  /** Undo attach(): restore the captured listeners in order (test / re-install utility). */
  function detach() {
    if (!attachedServer) return;
    const s = attachedServer;
    attachedServer = null;
    try {
      s.removeListener('request', onRequestWrapper);
      if (onCloseWrapper) s.removeListener('close', onCloseWrapper);
      for (const listener of requestListeners) s.on('request', listener);
    } catch (e) {
      log(`[sp-host] detach failed: ${msg(e)}`);
    }
    requestListeners = [];
    onRequestWrapper = null;
    onCloseWrapper = null;
  }

  /** Detach + close the discovery listener. Resolves when the port is released. */
  async function close() {
    detach();
    await closeDiscovery();
  }

  return {
    attach,
    detach,
    close,
    handleRequest,
    handleLanRoute,
    startDiscovery,
    closeDiscovery,
    maybeStartDcBridge,
    /** Test/diagnostic accessor. */
    status: () => ({
      discovery: discoveryState,
      discoveryPort,
      published: Array.from(lanPublic),
      port,
    }),
  };
}

/**
 * Overlay entry point (called by server/overlay-loader.mjs after startServer()).
 * Accepts BOTH ctx shapes: the upstream startServer() result object ({ server, lobby, port, ... })
 * that android-main.mjs passes, and a bare http.Server with .lobby (the test convention).
 * @param {{server?: object, port?: number, host?: string, url?: string, upstreamDir?: string,
 *          log?: (m: string) => void}} ctx
 */
export async function install(ctx) {
  const log = typeof ctx?.log === 'function' ? ctx.log : (m) => console.log(m);
  const httpServer = resolveHttpServer(ctx?.server);
  const lobby = (ctx?.server && ctx.server.lobby) || null;
  const upstreamDir = typeof ctx?.upstreamDir === 'string' ? ctx.upstreamDir : undefined;
  let port = Number(ctx?.port);
  if (!Number.isInteger(port) || port <= 0) {
    try {
      const a = httpServer ? httpServer.address() : null;
      port = a && typeof a === 'object' ? a.port : 0;
    } catch { port = 0; }
  }
  const versions = await resolveVersions(upstreamDir);
  const controller = createController({ log, lobby, port, host: ctx?.host, upstreamDir, versions });
  if (!httpServer) {
    log('[sp-host] no http server in ctx - routes not attached (controller returned for tests)');
    return controller;
  }
  controller.attach(httpServer);
  let bind;
  try {
    bind = await Promise.race([
      controller.startDiscovery(),
      new Promise((resolve) => { const t = setTimeout(() => resolve('timeout'), BIND_WAIT_MS); t.unref?.(); }),
    ]);
  } catch (e) {
    bind = `error: ${msg(e)}`; // the loader contract: a defect here must never block the host boot
  }
  const bridge = controller.maybeStartDcBridge();
  log(`[sp-host] ready: /lan/rooms + /lan/room?code= (LAN peers) + /lan/publish (loopback) + /_shell/rooms + /room-probe/<code>; discovery: ${bind}; dc bridge: ${bridge ? 'gated on' : 'off'}`);
  return controller;
}
