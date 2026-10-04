// src/board.js — sp-lobby-board PURE CORE: the online-lobby room board ("房间牌").
//
// ZERO EGRESS: this file never calls fetch / XMLHttpRequest / WebSocket and never dials or probes a
// submitted URL — url validation below is SYNTAX-ONLY (WHATWG URL parsing + the deny table copied
// from tools/apk/overlay/sp-connect.mjs). The test suite stubs globalThis.fetch and asserts 0 calls.
// ZERO CF DEPENDENCY: no imports at all, so `node --test` can exercise the core directly with the
// in-memory adapter while src/index.js runs the exact same code on a Durable Object.
//
// CONTRACT (rainya-compatible, additive fields only):
//   list()   -> { ok:true, now, ttlSec:600, rooms:[ { code, serverId, serverName, note,
//                ageSec, leftSec, url?, server } ] }   (server === serverName; url omitted unless
//                it passed validation on submit; `now` is epoch ms)
//   add(input, now?)   -> { ok:true, added:<entry>, token } | { ok:false, error, message? }
//   remove(input, now?) -> { ok:true, removed:{code,serverId} } | { ok:false, error, message? }
//
// STATE ADAPTER (supplied by the caller; async or sync, always awaited):
//   get(key) -> value | undefined
//   put(key, value)                  value must be structured-cloneable
//   delete(key)
//   list()   -> Map<key, value>      (any iterable of [key, value] pairs is accepted)
// Keys owned by this core:  room:<CODE>  (one entry)   rate:<ip>  (recent accepted timestamps).
// All read-modify-write happens inside one awaited request; the Durable Object input gate serializes
// requests for the singleton instance, so no advisory locking is needed.

export const TTL_SEC = 600;
export const TTL_MS = TTL_SEC * 1000;

/** Room-code alphabet, upper-case, no I/O (matches the shell/lobby client `^[A-HJ-NP-Z]{4}$`). */
export const CODE_RE = /^[A-HJ-NP-Z]{4}$/;

export const NOTE_MAX = 40; // characters (code points) after control-char stripping
export const SERVER_ID_MAX = 64;
export const SERVER_NAME_MAX = 64;
export const URL_MAX = 512;

/** Per-IP submission rate: accepted adds in a sliding 60 s window. */
export const IP_RATE_MAX = 10;
export const IP_RATE_WINDOW_MS = 60_000;
/** Same-code debounce: a live entry younger than this refuses a re-submit. */
export const CODE_DEBOUNCE_MS = 30_000;
/** Per-IP live (unexpired) entry cap. */
export const IP_ROOMS_MAX = 5;

/** Token = 128 bits, lowercase hex (32 chars). */
export const TOKEN_BYTES = 16;

const ROOM_PREFIX = 'room:';
const RATE_PREFIX = 'rate:';
const roomKey = (code) => ROOM_PREFIX + code;
const rateKey = (ip) => RATE_PREFIX + ip;

// --------------------------------------------------------------------------------------------------
// Host deny table — identical to tools/apk/overlay/sp-connect.mjs (the shell's /ws egress guard) so
// the board and the client agree on what "not a public target" means. The WHATWG URL parser runs
// first, so octal / hex / decimal / short-form IPv4 literals are already canonicalised to a strict
// dotted quad before this table sees them.
// --------------------------------------------------------------------------------------------------

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

// --------------------------------------------------------------------------------------------------
// Field validation / sanitisation (pure, no I/O)
// --------------------------------------------------------------------------------------------------

/** Upper-case + trim; @returns {string | null} the canonical code or null when invalid. */
export function normalizeCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

function stripControl(s) {
  return String(s).replace(/[\u0000-\u001f\u007f]/g, '');
}

function clipCodePoints(s, max) {
  const points = Array.from(s);
  return points.length > max ? points.slice(0, max).join('') : s;
}

/** Required server identity field: control chars stripped, trimmed, 1..max chars, else null. */
function sanitizeField(value, max) {
  if (value === undefined || value === null) return null;
  const s = stripControl(value).trim();
  if (!s) return null;
  return Array.from(s).length > max ? null : s;
}

/** Cosmetic note: control chars stripped, trimmed, truncated to NOTE_MAX code points. */
export function sanitizeNote(value) {
  if (value === undefined || value === null) return '';
  return clipCodePoints(stripControl(value).trim(), NOTE_MAX);
}

/**
 * Optional room url: http(s), <= URL_MAX chars, no userinfo, public host (deny table above).
 * @param {unknown} value
 * @returns {string | null} canonical href, or null when the value is not acceptable.
 */
export function normalizeRoomUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > URL_MAX) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null; // credentials must never ride the board
  if (!url.hostname) return null;
  if (url.port === '0') return null;
  if (isDeniedTargetHost(url.hostname)) return null;
  return url.href;
}

// --------------------------------------------------------------------------------------------------
// Entry helpers
// --------------------------------------------------------------------------------------------------

function fail(error, message) {
  return message ? { ok: false, error, message } : { ok: false, error };
}

function normalizeIp(value) {
  const s = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  return s ? s.slice(0, 64) : 'unknown';
}

const ipOf = (entry) => (typeof entry.ip === 'string' && entry.ip ? entry.ip : 'unknown');

/** Minimal forward-compatible shape check for stored entries (never touches unknown extra fields). */
function isRoomEntry(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.code === 'string'
    && CODE_RE.test(value.code)
    && typeof value.createdAt === 'number'
    && Number.isFinite(value.createdAt)
    && typeof value.token === 'string'
    && value.token.length > 0,
  );
}

function isExpired(entry, t) {
  return t - entry.createdAt >= TTL_MS;
}

/** Public entry view: rainya fields + additive serverId/serverName; token/ip/createdAt never leak. */
function toPublic(entry, t) {
  const ageSec = Math.max(0, Math.floor((t - entry.createdAt) / 1000));
  const out = {
    code: entry.code,
    server: typeof entry.serverName === 'string' ? entry.serverName : '',
    serverId: typeof entry.serverId === 'string' ? entry.serverId : '',
    serverName: typeof entry.serverName === 'string' ? entry.serverName : '',
    note: typeof entry.note === 'string' ? entry.note : '',
    ageSec,
    leftSec: Math.max(0, TTL_SEC - ageSec),
  };
  if (typeof entry.url === 'string' && entry.url) out.url = entry.url;
  return out;
}

function makeToken(random) {
  let bytes;
  if (typeof random === 'function') {
    bytes = random(TOKEN_BYTES);
  } else {
    const webcrypto = globalThis.crypto;
    if (!webcrypto || typeof webcrypto.getRandomValues !== 'function') {
      throw new Error('board: webcrypto unavailable — cannot mint a token');
    }
    bytes = new Uint8Array(TOKEN_BYTES);
    webcrypto.getRandomValues(bytes);
  }
  const arr = Array.from(bytes || []);
  if (arr.length !== TOKEN_BYTES || arr.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw new Error('board: random seam must return 16 bytes');
  }
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --------------------------------------------------------------------------------------------------
// Core factory
// --------------------------------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {{get: Function, put: Function, delete: Function, list: Function}} options.state
 * @param {(() => number) | number} [options.now]      clock seam (default Date.now)
 * @param {(n: number) => ArrayLike<number>} [options.random]  token seam (default webcrypto)
 */
export function createBoard({ state, now, random } = {}) {
  if (!state
    || typeof state.get !== 'function'
    || typeof state.put !== 'function'
    || typeof state.delete !== 'function'
    || typeof state.list !== 'function') {
    throw new TypeError('createBoard: state adapter must provide get/put/delete/list');
  }

  const clock = typeof now === 'function'
    ? () => Number(now())
    : Number.isFinite(now) ? () => Number(now) : () => Date.now();
  const at = (nowArg) => (Number.isFinite(nowArg) ? Number(nowArg) : clock());

  /** Load live entries, prune expired rooms and stale rate buckets. @returns {Promise<{rooms: object[], byCode: Map<string, object>}>} */
  async function scan(t) {
    const listed = await state.list();
    const pairs = listed instanceof Map
      ? listed.entries()
      : (listed && typeof listed[Symbol.iterator] === 'function' ? listed : []);
    const rooms = [];
    const byCode = new Map();
    for (const pair of pairs) {
      if (!pair) continue;
      const key = pair[0];
      const value = pair[1];
      if (typeof key !== 'string') continue;
      if (key.startsWith(ROOM_PREFIX)) {
        if (!isRoomEntry(value)) {
          await state.delete(key);
          continue;
        }
        if (isExpired(value, t)) {
          await state.delete(key);
          continue;
        }
        rooms.push(value);
        byCode.set(value.code, value);
      } else if (key.startsWith(RATE_PREFIX)) {
        const kept = Array.isArray(value)
          ? value.filter((ts) => Number.isFinite(ts) && t - ts >= 0 && t - ts < IP_RATE_WINDOW_MS)
          : [];
        if (kept.length === 0) await state.delete(key);
        else if (kept.length !== value.length) await state.put(key, kept);
      }
    }
    return { rooms, byCode };
  }

  /** rainya-shaped board payload; expired entries are dropped (and pruned) here. */
  async function list(nowArg) {
    const t = at(nowArg);
    const { rooms } = await scan(t);
    rooms.sort((a, b) => b.createdAt - a.createdAt || (a.code < b.code ? -1 : 1)); // newest first
    return { ok: true, now: t, ttlSec: TTL_SEC, rooms: rooms.map((entry) => toPublic(entry, t)) };
  }

  /**
   * Submit (or, after the 30 s debounce, re-submit) a room.
   * A present url that fails validation rejects the WHOLE submission (never silently dropped).
   */
  async function add(input, nowArg) {
    const t = at(nowArg);
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

    const code = normalizeCode(raw.code);
    if (!code) return fail('BAD_CODE', 'code must match ^[A-HJ-NP-Z]{4}$ (upper-cased first)');

    const serverId = sanitizeField(raw.serverId, SERVER_ID_MAX);
    const serverName = sanitizeField(raw.serverName, SERVER_NAME_MAX);
    if (!serverId || !serverName) {
      return fail('BAD_SERVER', `serverId (1..${SERVER_ID_MAX}) and serverName (1..${SERVER_NAME_MAX}) are required`);
    }

    let url = null;
    if (raw.url !== undefined && raw.url !== null) {
      if (typeof raw.url !== 'string') return fail('BAD_URL', 'url must be a string');
      if (raw.url.trim() !== '') {
        url = normalizeRoomUrl(raw.url);
        if (!url) {
          return fail('BAD_URL', `url must be http(s), <= ${URL_MAX} chars, public host, no userinfo`);
        }
      }
    }

    const note = sanitizeNote(raw.note);
    const ip = normalizeIp(raw.ip);

    const { rooms, byCode } = await scan(t);
    const existing = byCode.get(code);

    // Same-code debounce: a live entry younger than CODE_DEBOUNCE_MS refuses a re-submit. Older live
    // entries are replaced (and their token invalidated) instead of duplicated.
    if (existing && t - existing.createdAt < CODE_DEBOUNCE_MS) {
      return fail('DEBOUNCED', `code ${code} was submitted ${Math.floor((t - existing.createdAt) / 1000)}s ago; wait ${CODE_DEBOUNCE_MS / 1000}s`);
    }

    // Per-IP sliding-window rate limit (accepted adds only).
    const rk = rateKey(ip);
    const storedRate = await state.get(rk);
    const recent = (Array.isArray(storedRate) ? storedRate : [])
      .filter((ts) => Number.isFinite(ts) && t - ts >= 0 && t - ts < IP_RATE_WINDOW_MS);
    if (recent.length >= IP_RATE_MAX) {
      return fail('RATE_LIMITED', `at most ${IP_RATE_MAX} submissions per ${IP_RATE_WINDOW_MS / 1000}s per IP`);
    }

    // Per-IP live-entry cap; replacing your own entry does not grow the count.
    const liveForIp = rooms.filter((entry) => ipOf(entry) === ip).length;
    const grows = existing && ipOf(existing) === ip ? 0 : 1;
    if (liveForIp + grows > IP_ROOMS_MAX) {
      return fail('LIMIT_REACHED', `at most ${IP_ROOMS_MAX} live rooms per IP`);
    }

    const token = makeToken(random);
    const entry = { code, serverId, serverName, note, url, ip, token, createdAt: t };
    await state.put(roomKey(code), entry);
    recent.push(t);
    await state.put(rk, recent.slice(-IP_RATE_MAX));
    return { ok: true, added: toPublic(entry, t), token };
  }

  /**
   * Destroy a room. The token stored with the entry must match, as must the submitting serverId.
   * @returns {Promise<{ok:true, removed:{code,serverId}} | {ok:false, error:string, message?:string}>}
   */
  async function remove(input, nowArg) {
    const t = at(nowArg);
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

    const code = normalizeCode(raw.code);
    if (!code) return fail('BAD_CODE', 'code must match ^[A-HJ-NP-Z]{4}$ (upper-cased first)');

    const serverId = sanitizeField(raw.serverId, SERVER_ID_MAX);
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';

    const stored = await state.get(roomKey(code));
    if (!isRoomEntry(stored) || isExpired(stored, t)) {
      if (stored !== undefined && stored !== null) await state.delete(roomKey(code));
      return fail('NOT_FOUND', 'no live room for this code');
    }
    if (!token || token !== stored.token || !serverId || serverId !== stored.serverId) {
      return fail('FORBIDDEN', 'token / serverId do not match this room');
    }
    await state.delete(roomKey(code));
    return { ok: true, removed: { code, serverId: stored.serverId } };
  }

  return { list, add, remove };
}
