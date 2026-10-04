// sp-connect.mjs — shell server overlay: the /ws connection EXIT + pre-join probe (overlay API 1).
//
// WHY (audit checklist A+B, 2026-10-04): the Android shell wants remote play without editing any
// upstream file. This overlay is purely ADDITIVE — it exists as a new file under server/overlay/
// and rides the L1 content slim (device shell >= v2.8.0 carries the loading point). It wraps the
// 'request' / 'upgrade' listeners of the server object returned by the upstream startServer():
// the originals are detached, our dispatcher runs first, and everything that is not ours is
// forwarded to them unchanged.
//
// ROUTES
//   POST /sp/connect {target}     arm the egress: every client upgrading /ws on this local server
//                                 is bridged (message-level, via the ws package) to that target
//   POST /sp/connect {off:true}   disarm → /ws behaves exactly like stock (full passthrough)
//   GET  /sp/connect              status {ok,on,targetPresent,mode,targetHost?} — HOST SUMMARY ONLY,
//                                 the full target URL (it may carry a query token) is never echoed
//   GET  /sp/probe?url=<http(s)>  pre-join classification {ok,kind:'game'|'auth'|'other',status,finalHost,hops}
//                                 manual redirects, at most 6 followed, every hop re-validated
//
// SECURITY INVARIANTS (Mimosa acceptance — implemented here and asserted in
// tools/apk/overlay-sp-connect.test.mjs):
//   1. The control plane (both routes) only answers requests whose PEER is loopback
//      (req.socket.remoteAddress in 127/8, ::1, ::ffff:127/8) AND whose Origin header is a
//      loopback http(s) origin. Missing Origin or any other origin → 403. Nothing else is
//      touched before this check.
//   2. /sp/connect targets must parse as ws:// or wss:// (http/https and every other scheme is
//      refused), must not carry userinfo, must not exceed MAX_WS_TARGET_LEN, port 0 is refused,
//      and the resolved hostname must not be loopback / private / link-local / reserved /
//      documentation / multicast / IPv6 ULA / IPv6 link-local / "localhost" / ".local" / ".internal".
//      The WHATWG URL parser runs first, so octal / hex / short-form IPv4 literals are already
//      canonicalised to dotted-quad before the deny table sees them.
//   3. Validation is COMPLETE before any dial/request: a refused target is never contacted
//      (the tests assert a dial/fetch counter of 0). /sp/probe re-validates EVERY redirect hop.
//   4. A configured target that fails to connect closes the client socket (502 before the
//      handshake, 1011 after it) and logs — never a silent black screen.
//   5. With no target armed, request/upgrade forwarding is listener-in-order, so behavior is
//      byte-for-byte stock (including 404s for other upgrade paths).
//   The file is loaded by server/overlay-loader.mjs after startServer(); a throwing install()
//   is logged and skipped, so a defect here can never block the host boot.
//
// WS LIBRARY LOADING: the proxy needs the `ws` package that the running upstream server already
// uses. It is resolved lazily (first dial/accept, never at install) from the running server dir:
//   1. createRequire(path.join(upstreamDir, 'index.js'))('ws')  — exactly node's own resolution;
//   2. fallback: dynamic import of <upstreamDir>/node_modules/ws/index.js, then of the parent
//      dir's node_modules/ws/index.js (covers a moved/hoisted server tree).
// If neither works the upgrade is answered with 502 and logged; the host keeps running.
// dialWsTarget resolves to { client, open } BEFORE the target's open event so the bridge can
// attach its message handler first — an early greeting from the target is never dropped.
//
// EXPORTS: overlayApi/id/install (loader contract) plus the pure validators and a controller
// factory used by the tests and by any future in-process panel bridge.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** Overlay loader contract (server/overlay-loader.mjs). */
export const overlayApi = 1;
/** Overlay id for logs / handshake.json. */
export const id = 'sp-connect';

/** Control routes. */
export const ROUTE_CONNECT = '/sp/connect';
export const ROUTE_PROBE = '/sp/probe';

/** Target length cap for both control routes. */
export const MAX_WS_TARGET_LEN = 2048;
/** Redirect hops followed by /sp/probe (the 7th redirect is refused, not followed). */
export const PROBE_MAX_REDIRECT_HOPS = 6;
/** Overall /sp/probe deadline. */
export const PROBE_TIMEOUT_MS = 6000;
/** Body read cap for the 64 KB probe body sniff. */
export const PROBE_BODY_LIMIT = 64 * 1024;

const MAX_CONTROL_BODY = 4096;
const WS_MAX_PAYLOAD = 64 * 1024; // mirrors upstream server/index.js WS_MAX_PAYLOAD
const DIAL_TIMEOUT_MS = 10_000;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const AUTH_RE = /(?:login|log[-_]?in|sign[-_]?in|auth|passport|sso|oauth|verify|account|登录|验证)/i;
const GAME_MARKERS = ['shared/constants.js'];

const msg = (e) => (e && e.message ? String(e.message) : String(e));

// ---------------------------------------------------------------------------------------------------
// Pure helpers: IP parsing / host deny table (shared by /sp/connect and /sp/probe)
// ---------------------------------------------------------------------------------------------------

/** @returns {number[] | null} [a,b,c,d] for a strict dotted quad, else null. */
function parseIPv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

/** @returns {number[] | null} eight 16-bit groups for an IPv6 literal (brackets optional), else null. */
function parseIPv6(text) {
  let s = String(text).trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s || !/^[0-9a-f:.]+$/.test(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (chunk) => {
    if (!chunk) return [];
    const out = [];
    for (const piece of chunk.split(':')) {
      if (piece.includes('.')) {
        const v4 = parseIPv4(piece);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
        out.push(parseInt(piece, 16));
      }
    }
    return out;
  };
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (head === null || tail === null) return null;
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null; // '::' must compress at least one group
    groups = [...head, ...new Array(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  return groups.length === 8 ? groups : null;
}

/** Deny table for IPv4 (peer-agnostic): loopback, private, link-local, CGNAT, reserved, multicast. */
function isDeniedV4(a, b, c) {
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + broadcast
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 relay anycast (deprecated)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  return false;
}

/** Deny table for IPv6 (mapped/compatible/NAT64 literals are checked against the IPv4 table). */
function isDeniedV6(g) {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return true; // ::1
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::/96 (unspecified / compat / IPv4-compatible)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isDeniedV4(g6 >> 8, g6 & 0xff, g7 >> 8); // ::ffff:a.b.c.d
  }
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0) {
    return isDeniedV4(g6 >> 8, g6 & 0xff, g7 >> 8); // 64:ff9b::/96 NAT64
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  return false;
}

/** Strip brackets / trailing root dots; lowercase. */
function normalizeHostname(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  while (s.endsWith('.')) s = s.slice(0, -1);
  return s;
}

/** @returns {string | null} a human reason when the hostname must never be dialed, else null. */
export function targetHostDenyReason(hostname) {
  const h = normalizeHostname(hostname);
  if (!h) return 'empty host';
  const v4 = parseIPv4(h);
  if (v4) return isDeniedV4(v4[0], v4[1], v4[2]) ? 'IPv4 target is loopback/private/reserved' : null;
  if (h.includes(':')) {
    const groups = parseIPv6(h);
    if (!groups) return 'invalid IPv6 literal';
    return isDeniedV6(groups) ? 'IPv6 target is loopback/private/reserved' : null;
  }
  if (h === 'localhost' || h === 'ip6-localhost' || h === 'ip6-loopback') return 'localhost is not a remote target';
  if (h.endsWith('.localhost')) return '*.localhost is not a remote target';
  if (h.endsWith('.local')) return '.local is not a remote target';
  if (h.endsWith('.internal')) return '.internal is not a remote target';
  return null;
}

/** @returns {boolean} true when the hostname is in the deny table. */
export function isDeniedTargetHost(hostname) {
  return targetHostDenyReason(hostname) !== null;
}

/** @returns {boolean} IPv4-mapped/plain loopback in groups form. */
function isLoopbackV6(g) {
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return (g[6] >> 8) === 127; // ::ffff:127.0.0.0/104
  }
  return false;
}

/**
 * Peer check for the control plane: is this socket address a loopback peer?
 * Accepts 127/8, ::1, ::ffff:127/8 (Node's IPv4-mapped form) and the literal 'localhost'
 * (never emitted by sockets, kept for direct-handler tests).
 * @param {unknown} addr
 * @returns {boolean}
 */
export function isLoopback(addr) {
  if (typeof addr !== 'string' || !addr.trim()) return false;
  let s = addr.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  const v4 = parseIPv4(s);
  if (v4) return v4[0] === 127;
  if (s.includes(':')) {
    const groups = parseIPv6(s);
    return groups ? isLoopbackV6(groups) : false;
  }
  return s.toLowerCase() === 'localhost';
}

/**
 * Origin check for the control plane: only http(s) pages served from a loopback origin may
 * drive it. A missing Origin (undefined/null/'') is refused.
 * @param {unknown} originHeader
 * @returns {boolean}
 */
export function originAllowed(originHeader) {
  if (typeof originHeader !== 'string') return false;
  const raw = originHeader.trim();
  if (!raw || raw.length > 512 || raw.toLowerCase() === 'null') return false;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const h = normalizeHostname(u.hostname);
  if (h === 'localhost') return true;
  const v4 = parseIPv4(h);
  if (v4) return v4[0] === 127;
  if (h.includes(':')) {
    const groups = parseIPv6(h);
    return groups ? isLoopbackV6(groups) : false;
  }
  return false;
}

/**
 * Validate and canonicalise a /sp/connect target.
 * @param {unknown} value
 * @returns {{ok: true, url: URL, host: string} | {ok: false, reason: string}}
 */
export function normalizeWsTarget(value) {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, reason: 'target must be a non-empty string' };
  const raw = value.trim();
  if (raw.length > MAX_WS_TARGET_LEN) return { ok: false, reason: `target too long (max ${MAX_WS_TARGET_LEN})` };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'target is not a valid absolute URL' };
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return { ok: false, reason: 'target must be ws:// or wss:// (http/https and other schemes are refused)' };
  }
  if (url.username || url.password) return { ok: false, reason: 'target must not contain userinfo' };
  if (url.hash) return { ok: false, reason: 'target must not contain a fragment' };
  if (!url.hostname) return { ok: false, reason: 'target has no host' };
  if (url.port === '0') return { ok: false, reason: 'target port 0 is not allowed' };
  const deny = targetHostDenyReason(url.hostname);
  if (deny) return { ok: false, reason: `target refused: ${deny}` };
  if (!url.pathname || url.pathname === '/') url.pathname = '/ws'; // game servers serve /ws
  return { ok: true, url, host: url.host };
}

/**
 * Validate and canonicalise a /sp/probe url (http/https only).
 * @param {unknown} value
 * @returns {{ok: true, url: URL, host: string} | {ok: false, reason: string}}
 */
export function normalizeProbeTarget(value) {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, reason: 'url must be a non-empty string' };
  const raw = value.trim();
  if (raw.length > MAX_WS_TARGET_LEN) return { ok: false, reason: `url too long (max ${MAX_WS_TARGET_LEN})` };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'url is not a valid absolute URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'url must be http:// or https:// (this route probes web pages)' };
  }
  if (url.username || url.password) return { ok: false, reason: 'url must not contain userinfo' };
  if (!url.hostname) return { ok: false, reason: 'url has no host' };
  if (url.port === '0') return { ok: false, reason: 'url port 0 is not allowed' };
  const deny = targetHostDenyReason(url.hostname);
  if (deny) return { ok: false, reason: `url refused: ${deny}` };
  return { ok: true, url, host: url.host };
}

// ---------------------------------------------------------------------------------------------------
// ws package loading (lazy; see the header note)
// ---------------------------------------------------------------------------------------------------

const wsModuleCache = new Map();

/**
 * Load the `ws` package as the running upstream server would see it.
 * 1. createRequire from the server dir (node's own resolution); 2. dynamic import of
 * <dir>/node_modules/ws/index.js; 3. same one level up. Throws when nothing loads.
 * @param {string | undefined} upstreamDir directory of the running server/index.js
 */
export async function loadWsModule(upstreamDir) {
  const key = String(upstreamDir || '');
  if (wsModuleCache.has(key)) return wsModuleCache.get(key);
  let firstError = null;
  if (upstreamDir && typeof upstreamDir === 'string') {
    try {
      const require = createRequire(path.join(upstreamDir, 'index.js'));
      const mod = require('ws');
      if (mod && typeof mod.WebSocket === 'function') {
        wsModuleCache.set(key, mod);
        return mod;
      }
      firstError = new Error("require('ws') did not expose WebSocket");
    } catch (e) {
      firstError = e;
    }
  }
  const bases = upstreamDir && typeof upstreamDir === 'string' ? [upstreamDir, path.dirname(upstreamDir)] : [];
  for (const base of bases) {
    const file = path.join(base, 'node_modules', 'ws', 'index.js');
    if (!fs.existsSync(file)) continue;
    try {
      const mod = await import(pathToFileURL(file).href);
      const candidate = mod && typeof mod.WebSocket === 'function' ? mod : mod && mod.default && typeof mod.default.WebSocket === 'function' ? mod.default : null;
      if (candidate) {
        wsModuleCache.set(key, candidate);
        return candidate;
      }
    } catch (e) {
      if (!firstError) firstError = e;
    }
  }
  throw new Error(`cannot load the 'ws' package from ${upstreamDir || '(no server dir)'}${firstError ? `: ${msg(firstError)}` : ''}`);
}

/**
 * Default dialer: start a ws/wss connection to a validated target URL.
 * Resolves as soon as the client exists with `{ client, open }` — the caller attaches its
 * message handler first, then awaits `open` (which rejects on handshake error / early close /
 * timeout) so an early target greeting is never dropped.
 * @param {string | undefined} upstreamDir
 * @param {URL} url
 * @returns {Promise<{client: any, open: Promise<void>}>}
 */
export async function dialWsTarget(upstreamDir, url) {
  const ws = await loadWsModule(upstreamDir);
  const client = new ws.WebSocket(url.href, {
    perMessageDeflate: false,
    maxPayload: WS_MAX_PAYLOAD,
    handshakeTimeout: DIAL_TIMEOUT_MS,
  });
  const open = new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      try {
        client.off('open', onOpen);
        client.off('error', onError);
        client.off('close', onClose);
      } catch { /* ignore */ }
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const onClose = (code, reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`target closed before open (code ${code ?? '?'}${reason ? ` ${String(reason)}` : ''})`));
    };
    client.on('open', onOpen);
    client.on('error', onError);
    client.on('close', onClose);
  });
  open.catch(() => {}); // the caller may legitimately await only after wiring the bridge
  return { client, open };
}

/** Default client accepter: complete the inbound ws handshake with the same ws package. */
async function acceptUpgradedClient(upstreamDir, req, socket, head) {
  const ws = await loadWsModule(upstreamDir);
  return new Promise((resolve, reject) => {
    let wss;
    try {
      wss = new ws.WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false });
    } catch (e) {
      reject(e);
      return;
    }
    try {
      wss.handleUpgrade(req, socket, head, (client) => resolve(client));
    } catch (e) {
      reject(e);
    }
  });
}

// ---------------------------------------------------------------------------------------------------
// Bridge + wire helpers
// ---------------------------------------------------------------------------------------------------

function sanitizeCloseCode(code) {
  if (!Number.isInteger(code)) return 1000;
  if (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code;
  if (code >= 3000 && code <= 4999) return code;
  return 1000;
}

function truncateReason(reason) {
  const s = typeof reason === 'string' ? reason : Buffer.isBuffer(reason) ? reason.toString('utf8') : '';
  let cut = s;
  while (Buffer.byteLength(cut) > 123) cut = cut.slice(0, -1);
  return cut;
}

/** Close best-effort: an open socket gets a close frame, anything else is terminated. */
function hardClose(wsLike, code, reason) {
  if (!wsLike) return;
  try {
    if (typeof wsLike.terminate === 'function' && wsLike.readyState !== 1) {
      wsLike.terminate();
      return;
    }
    if (typeof wsLike.close === 'function') {
      wsLike.close(sanitizeCloseCode(code), truncateReason(reason));
      return;
    }
    wsLike.terminate?.();
  } catch { /* best effort */ }
}

function rejectUpgrade(socket, status, text) {
  if (!socket || socket.destroyed) return;
  const response = `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
  try {
    if (typeof socket.end === 'function' && socket.writable !== false) socket.end(response);
    else socket.destroy?.();
  } catch {
    try { socket.destroy?.(); } catch { /* ignore */ }
  }
}

function pathOf(reqUrl) {
  try {
    return new URL(String(reqUrl || '/'), 'http://sp.local').pathname;
  } catch {
    return null;
  }
}

function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  };
  try {
    res.writeHead(status, headers);
    res.end(body);
  } catch {
    try { res.destroy?.(); } catch { /* ignore */ }
  }
}

function readJsonBody(req, limit = MAX_CONTROL_BODY) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, status: 413, reason: 'request body too large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') });
      } catch {
        finish({ ok: false, status: 400, reason: 'request body must be JSON' });
      }
    });
    req.on('error', () => finish({ ok: false, status: 400, reason: 'request body read failed' }));
  });
}

/** Read at most `limit` bytes of a fetch Response body; never throws. */
async function readCappedResponse(res, limit) {
  if (!res || !res.body || typeof res.body.getReader !== 'function') return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      const room = limit - size;
      chunks.push(buf.length > room ? buf.subarray(0, room) : buf);
      size += Math.min(buf.length, room);
    }
  } catch { /* partial body is fine */ } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function bodyLooksLikeGame(text) {
  if (!text) return false;
  if (GAME_MARKERS.some((marker) => text.includes(marker))) return true;
  const title = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(text);
  return Boolean(title && /卫戍协议|stronghold/i.test(title[1]));
}

/** True when a hop's URL looks like a login/verification page. */
function isAuthLikeUrl(href) {
  return AUTH_RE.test(String(href));
}

// ---------------------------------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------------------------------

/**
 * Build one controller instance. All I/O seams are injectable for tests; the overlay install()
 * uses the defaults, which are wired to the ws package and to global fetch.
 * @param {object} [options]
 * @param {(m: string) => void} [options.log]
 * @param {string} [options.upstreamDir]
 * @param {(url: URL) => any} [options.dial]            dial seam (default: dialWsTarget)
 * @param {(req, socket, head) => any} [options.acceptClient]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.probeTimeoutMs]
 */
export function createController(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const upstreamDir = options.upstreamDir;
  const probeTimeoutMs = Number.isFinite(options.probeTimeoutMs) && options.probeTimeoutMs > 0
    ? options.probeTimeoutMs
    : PROBE_TIMEOUT_MS;
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const dial = typeof options.dial === 'function'
    ? options.dial
    : (url) => dialWsTarget(upstreamDir, url);
  const acceptClient = typeof options.acceptClient === 'function'
    ? options.acceptClient
    : (req, socket, head) => acceptUpgradedClient(upstreamDir, req, socket, head);

  let target = null; // URL when armed, null when stock

  const state = () => ({
    on: Boolean(target),
    targetPresent: Boolean(target),
    mode: target ? 'proxy' : 'idle',
    targetHost: target ? target.host : null,
  });
  const statusPayload = () => {
    const s = state();
    const payload = { ok: true, on: s.on, targetPresent: s.targetPresent, mode: s.mode };
    if (s.targetPresent) payload.targetHost = s.targetHost; // host summary only — never the full URL
    return payload;
  };
  const clearTarget = () => { target = null; };

  /** Programmatic arm (same validation as the route). null clears. */
  function setTarget(value) {
    if (value == null) {
      clearTarget();
      return statusPayload();
    }
    const norm = normalizeWsTarget(String(value));
    if (!norm.ok) return { ok: false, reason: norm.reason };
    target = norm.url;
    log(`[sp-connect] egress armed → ${norm.url.host}`); // host only: the URL may carry a token
    return statusPayload();
  }

  function controlDenial(req) {
    const peer = req && req.socket ? req.socket.remoteAddress : null;
    if (!isLoopback(peer)) {
      return { status: 403, payload: { ok: false, error: 'forbidden: the control plane is loopback-only' } };
    }
    const origin = req && req.headers ? req.headers.origin : undefined;
    if (!originAllowed(origin)) {
      return { status: 403, payload: { ok: false, error: 'forbidden: missing or non-local Origin' } };
    }
    return null;
  }

  async function handleConnect(req, res, method) {
    if (method === 'GET') {
      sendJson(res, 200, statusPayload());
      return;
    }
    const declared = Number(req.headers && req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_CONTROL_BODY) {
      sendJson(res, 413, { ok: false, error: 'request body too large' });
      return;
    }
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status || 400, { ok: false, error: body.reason });
      return;
    }
    const value = body.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      sendJson(res, 400, { ok: false, error: 'request body must be a JSON object: {"target":"ws://…"} or {"off":true}' });
      return;
    }
    if (value.off === true) {
      clearTarget();
      log('[sp-connect] egress disarmed');
      sendJson(res, 200, statusPayload());
      return;
    }
    const norm = normalizeWsTarget(value.target);
    if (!norm.ok) {
      sendJson(res, 400, { ok: false, error: norm.reason });
      return;
    }
    target = norm.url;
    log(`[sp-connect] egress armed → ${norm.url.host}`);
    sendJson(res, 200, statusPayload());
  }

  async function runProbe(initial) {
    let current = initial;
    let status = null;
    let finalHost = current.host;
    let hops = 0;
    let sawAuthRedirect = false;
    let lastRes = null;
    const deadline = Date.now() + probeTimeoutMs;
    for (;;) {
      const check = normalizeProbeTarget(current.href); // re-validated on EVERY hop
      if (!check.ok) return { kind: 'other', status, finalHost: current.host, hops, reason: `blocked: ${check.reason}` };
      current = check.url;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: 'other', status, finalHost, hops, reason: 'timeout' };
      let res;
      try {
        res = await fetchImpl(current.href, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(remaining),
          headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
        });
      } catch (e) {
        const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
        return { kind: 'other', status, finalHost, hops, reason: aborted ? 'timeout' : `fetch failed: ${msg(e)}` };
      }
      lastRes = res;
      status = res.status;
      finalHost = current.host;
      const location = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
      if (REDIRECT_STATUS.has(status) && location) {
        let next = null;
        try {
          next = new URL(location, current);
        } catch {
          return { kind: 'other', status, finalHost, hops, reason: 'invalid redirect location' };
        }
        if (isAuthLikeUrl(next.href)) sawAuthRedirect = true;
        hops += 1;
        if (hops > PROBE_MAX_REDIRECT_HOPS) {
          return { kind: 'other', status, finalHost, hops, reason: `too many redirects (>${PROBE_MAX_REDIRECT_HOPS})` };
        }
        current = next;
        continue;
      }
      break;
    }
    let text = '';
    try {
      text = await readCappedResponse(lastRes, PROBE_BODY_LIMIT);
    } catch { /* classification falls back to the status code */ }
    if (status === 401 || status === 403) return { kind: 'auth', status, finalHost, hops };
    if (bodyLooksLikeGame(text)) return { kind: 'game', status, finalHost, hops };
    if (sawAuthRedirect) return { kind: 'auth', status, finalHost, hops };
    return { kind: 'other', status, finalHost, hops };
  }

  async function handleProbe(req, res) {
    let parsed;
    try {
      parsed = new URL(String(req.url || '/'), 'http://sp.local');
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid request url' });
      return;
    }
    const norm = normalizeProbeTarget(parsed.searchParams.get('url'));
    if (!norm.ok) {
      sendJson(res, 400, { ok: false, error: norm.reason });
      return;
    }
    if (typeof fetchImpl !== 'function') {
      sendJson(res, 200, { ok: true, kind: 'other', status: null, finalHost: norm.url.host, hops: 0, reason: 'fetch unavailable' });
      return;
    }
    const result = await runProbe(norm.url);
    sendJson(res, 200, { ok: true, ...result });
  }

  /** @returns {Promise<boolean>} true when the route was handled (or answered) by this overlay. */
  async function handleRequest(req, res) {
    const pathname = pathOf(req && req.url);
    if (pathname !== ROUTE_CONNECT && pathname !== ROUTE_PROBE) return false;
    const denial = controlDenial(req);
    if (denial) {
      sendJson(res, denial.status, denial.payload);
      return true;
    }
    const method = String((req && req.method) || '').toUpperCase();
    if (pathname === ROUTE_CONNECT) {
      if (method !== 'GET' && method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' }, { Allow: 'GET, POST' });
        return true;
      }
      await handleConnect(req, res, method);
      return true;
    }
    if (method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' }, { Allow: 'GET' });
      return true;
    }
    await handleProbe(req, res);
    return true;
  }

  async function proxyUpgrade(req, socket, head) {
    socket.on?.('error', () => {});
    const armed = target; // snapshot: a re-arm/disarm only affects later upgrades
    const summary = armed.host;
    let dialResult;
    try {
      dialResult = await dial(armed);
    } catch (e) {
      log(`[sp-connect] egress dial ${summary} failed: ${msg(e)}`);
      rejectUpgrade(socket, 502, 'Bad Gateway');
      return;
    }
    const upstream = dialResult && dialResult.client ? dialResult.client : dialResult;
    const opened = dialResult && dialResult.open ? dialResult.open : null;

    let client = null;
    let done = false;
    let upstreamGone = null;
    const pending = [];
    let pendingBytes = 0;
    const PENDING_MAX_BYTES = 1024 * 1024; // target speech before the client handshake finishes
    const closeOther = (wsLike, code, reason) => {
      if (wsLike) hardClose(wsLike, code, reason);
    };
    const fail = (why) => {
      if (done) return;
      done = true;
      log(`[sp-connect] ${why} — closing both sides`);
      closeOther(client, 1011, 'bridge error');
      closeOther(upstream, 1011, 'bridge error');
    };
    // Attach the target's message handler BEFORE open so an early greeting queues up instead of
    // being lost; it is flushed as soon as the client side exists.
    upstream.on('message', (data, isBinary) => {
      if (done) return;
      if (!client) {
        pendingBytes += data && data.length ? data.length : 0;
        if (pendingBytes > PENDING_MAX_BYTES) {
          fail('target sent too much data before the client handshake completed');
          return;
        }
        pending.push([data, isBinary]);
        return;
      }
      if (client.readyState !== 1) return;
      try {
        client.send(data, { binary: Boolean(isBinary) });
      } catch (e) {
        fail(`client send failed: ${msg(e)}`);
      }
    });
    if (opened) {
      try {
        await opened;
      } catch (e) {
        log(`[sp-connect] egress dial ${summary} failed: ${msg(e)}`);
        try { upstream.terminate?.(); } catch { /* ignore */ }
        rejectUpgrade(socket, 502, 'Bad Gateway');
        return;
      }
    }
    upstream.on('close', (code, reason) => {
      if (done) return;
      done = true;
      if (client) {
        closeOther(client, code, reason);
      } else {
        upstreamGone = { code, reason };
      }
      log(`[sp-connect] /ws bridge closed (code ${code ?? '?'}) → ${summary}`);
    });
    upstream.on('error', (e) => fail(`target socket error: ${msg(e)}`));

    try {
      client = await acceptClient(req, socket, head);
    } catch (e) {
      log(`[sp-connect] client upgrade failed: ${msg(e)}`);
      hardClose(upstream, 1011, 'client handshake failed');
      try { socket.destroy?.(); } catch { /* ignore */ }
      return;
    }
    client.on('message', (data, isBinary) => {
      if (done || upstream.readyState !== 1) return;
      try {
        upstream.send(data, { binary: Boolean(isBinary) });
      } catch (e) {
        fail(`target send failed: ${msg(e)}`);
      }
    });
    client.on('close', (code, reason) => {
      if (done) return;
      done = true;
      closeOther(upstream, code, reason);
      log(`[sp-connect] /ws bridge closed (code ${code ?? '?'}) → ${summary}`);
    });
    client.on('error', (e) => fail(`client socket error: ${msg(e)}`));
    if (done) {
      // the target vanished while the client handshake was in flight
      closeOther(client, upstreamGone?.code ?? 1011, upstreamGone?.reason ?? 'target closed during setup');
      return;
    }
    log(`[sp-connect] bridging /ws ↔ ${summary} (message pipe)`);
    for (const [data, isBinary] of pending.splice(0)) {
      if (done || client.readyState !== 1) break;
      try {
        client.send(data, { binary: Boolean(isBinary) });
      } catch (e) {
        fail(`client send failed: ${msg(e)}`);
        break;
      }
    }
  }

  /** @returns {boolean} true when this overlay consumed the upgrade. */
  function handleUpgrade(req, socket, head) {
    if (!target) return false; // stock passthrough
    if (pathOf(req && req.url) !== '/ws') return false;
    const method = String((req && req.method) || 'GET').toUpperCase();
    if (method !== 'GET') {
      rejectUpgrade(socket, 405, 'Method Not Allowed');
      return true;
    }
    proxyUpgrade(req, socket, head).catch((e) => {
      log(`[sp-connect] proxy error: ${msg(e)}`);
      rejectUpgrade(socket, 502, 'Bad Gateway');
    });
    return true;
  }

  // --- listener wrapping (detach originals, run our dispatcher first) ---

  let attachedServer = null;
  let requestListeners = [];
  let upgradeListeners = [];
  let onRequestWrapper = null;
  let onUpgradeWrapper = null;

  const snapshot = (server, event) => (typeof server.rawListeners === 'function' ? server.rawListeners(event) : server.listeners(event)).slice();
  const callAll = (listeners, args) => {
    for (const listener of listeners) {
      try {
        listener.apply(attachedServer, args);
      } catch (e) {
        log(`[sp-connect] upstream listener failed: ${msg(e)}`);
      }
    }
  };

  /**
   * Wrap the server's 'request'/'upgrade' listeners. Upstream files are untouched: the original
   * listeners are captured and invoked in order for everything we do not answer ourselves.
   */
  function attach(server) {
    detach();
    requestListeners = snapshot(server, 'request');
    upgradeListeners = snapshot(server, 'upgrade');
    server.removeAllListeners('request');
    server.removeAllListeners('upgrade');
    onRequestWrapper = (req, res) => {
      handleRequest(req, res)
        .then((handled) => {
          if (!handled) callAll(requestListeners, [req, res]);
        })
        .catch((e) => {
          log(`[sp-connect] request handler failed: ${msg(e)}`);
          try {
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
            else res.destroy?.();
          } catch { /* ignore */ }
        });
    };
    onUpgradeWrapper = (req, socket, head) => {
      let handled = false;
      try {
        handled = handleUpgrade(req, socket, head);
      } catch (e) {
        log(`[sp-connect] upgrade handler failed: ${msg(e)}`);
        handled = false;
      }
      if (!handled) callAll(upgradeListeners, [req, socket, head]);
    };
    server.on('request', onRequestWrapper);
    server.on('upgrade', onUpgradeWrapper);
    attachedServer = server;
  }

  function detach() {
    if (!attachedServer) return;
    attachedServer.removeListener('request', onRequestWrapper);
    attachedServer.removeListener('upgrade', onUpgradeWrapper);
    for (const listener of requestListeners) attachedServer.on('request', listener);
    for (const listener of upgradeListeners) attachedServer.on('upgrade', listener);
    attachedServer = null;
    requestListeners = [];
    upgradeListeners = [];
  }

  return { attach, detach, handleRequest, handleUpgrade, setTarget, clearTarget, state, status: statusPayload };
}

/**
 * Overlay entry point (called by server/overlay-loader.mjs after startServer()).
 * @param {{server?: import('node:http').Server, log?: (m: string) => void, upstreamDir?: string}} ctx
 */
export async function install(ctx) {
  const log = typeof ctx?.log === 'function' ? ctx.log : (m) => console.log(m);
  const controller = createController({ log, upstreamDir: ctx?.upstreamDir });
  const server = ctx?.server;
  if (server && typeof server.on === 'function' && typeof server.removeAllListeners === 'function') {
    controller.attach(server);
    log(`[sp-connect] ready: ${ROUTE_CONNECT} (POST arm / POST off / GET status) + ${ROUTE_PROBE} — loopback peer + Origin required; /ws egress when armed`);
  } else {
    log('[sp-connect] no http server in ctx — control routes not attached (controller returned for tests)');
  }
  return controller;
}
