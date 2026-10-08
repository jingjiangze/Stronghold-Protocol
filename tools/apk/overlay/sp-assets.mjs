// sp-assets.mjs — the /assets/** proxy / cache / verification POLICY as a server overlay (overlay API 1).
//
// WHY (owner diktat 2026-10-08): the asset proxy/cache/verification policy lives in Java today
// (ArtCdn.java + MainActivity's WebView interceptor: openAssetFromCdn / openAssetFromServer /
// downloadArtToCache / adoptArtCacheNamespace / pruneArtCache / acquireArtSlot). That means every
// change to it — a namespace rule, a slot priority, a placeholder — costs a full APK rebuild. This
// file moves the policy to the layer that is ALREADY hot-updatable: a new file under
// server/overlay/ that rides the L1 content slim and is loaded by extras/server/overlay-loader.mjs
// after startServer(). No upstream file and NO Java file is edited by this change.
//
// SHADOW MODE (this is the whole point of P1): the overlay ships DEFAULT OFF. When off, install()
// attaches nothing and the Java interceptor stays the live path — user-visible behaviour is
// byte-identical. When on (env or config file, see FLAG), the LOCAL Node origin answers
// /assets/** with the decision order below, and the status surface lets a device A/B the two
// implementations before the Java policy is ever deleted.
//
// DECISION ORDER (the contract; mirrors the Java chain 1:1 so a diff is a real difference)
//   1. local tree      <webroot>/assets/<rel>            (filesDir/webroot, hot-updatable content)
//   2. signed packs    <artRoot>/packs/<id>/assets/<rel> (ArtStore-installed, sha256-covered)
//   3. APK-embedded    extra roots (on device the APK tree IS materialised into layer 1)
//   4. Node cache      <artRoot>/cache/<manifest hash>/assets/<rel>
//   5. gated CDN fetch <cdnBase><rel> → written to layer 4, then served from it
//   6. placeholder     only when the bytes are GENUINELY missing (1×1 PNG for image/*, empty otherwise)
// Every hit layer is counted in status(). A HIT IS NEVER VERIFIED — embedded/local/cache bytes go
// out as-is (cheap ETag = size+mtime, not a content hash); sha256 happens ONLY at write time, and
// STREAMS (hash while the download is written, never a second read of the file).
//
// CACHE NAMESPACE + ADOPTION (the fix for "热补丁后强制全量重校验"): the namespace is the manifest
// hash (data/assets.json top-level `hash`, sanitised). That hash is re-emitted from the referenced
// bytes on every content release, so it changes while the referenced paths/bytes stay identical. A
// changed hash therefore RENAMES the previous namespace directory onto the new one (same inode,
// same relative paths) instead of re-downloading; only when there is no predecessor do the bytes
// get orphaned. Pruning is LRU with a size cap, and FOREIGN namespaces are evicted before the
// active one so the cap can never delete the art the page is using.
//
// FLAG (default OFF — see resolveFlag): env SP_ASSETS_OVERLAY=1|true|on|yes (0|false|off = off), else
// a JSON file { "enabled": true, … } at, in order: $SP_ASSETS_CONFIG, <overlayDir>/sp-assets.json,
// <webroot>/data/sp-assets.json. Env wins. The file is read by THIS module (not the loader) on
// purpose: overlay-loader.mjs is baked into the APK, so a flag read there could not be flipped by a
// content hot-update.
//
// URL RULES (hard, asserted in tools/apk/overlay-sp-assets.test.mjs): only http/https; the request
// host must be in the allow-list (the line's CDN host + the mirrors); localhost / loopback / private
// / reserved / documentation / multicast / IPv6 ULA+link-local are rejected BEFORE any request; a
// refused target is NEVER contacted; no redirects are followed (a 3xx fails); body ceiling + timeouts.
//
// PREFETCH PRIORITY: art-prefetch.js already marks its background fetches with the X-SP-Prefetch
// header; this overlay also accepts ?sp_prefetch=1 and a separate path prefix /__sp/pf/assets/**.
// A prefetch takes a prefetch slot and then a fetch slot with a SHORT patience, while a page request
// waits longer — so a cold-cache prefetch can never starve a live screen into a placeholder. When a
// slot frees, a WAITING PAGE REQUEST IS SERVED BEFORE ANY WAITING PREFETCH.
//
// STATUS: GET /__sp/assets/status.json (loopback/private peers only) — per-layer hit counts, cache
// namespace, in-flight, failed/blocked, adoption + prune records, pool state. This is the shadow
// A/B surface (compare its counters with __SP_ART.state() / the Java diag log on a device).
//
// EXPORTS: overlayApi/id/install (loader contract) plus the pure helpers, the pool, the flag reader
// and a controller factory used by the tests. A throwing install() is logged and skipped by the
// loader, so a defect here can never block the host boot.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

/** Overlay loader contract (server/overlay-loader.mjs). */
export const overlayApi = 1;
/** Overlay id for logs / handshake.json. */
export const id = 'sp-assets';

/** Same-origin asset prefix the page asks for. */
export const ASSET_PREFIX = '/assets/';
/** Alternate prefix that marks a request as background prefetch (documented hint #3). */
export const PREFETCH_PREFIX = '/__sp/pf/assets/';
/** Status surface for the page / diag. */
export const STATUS_PATH = '/__sp/assets/status.json';
/** Request header art-prefetch.js already sends. */
export const PREFETCH_HEADER = 'x-sp-prefetch';
/** Query flag marking a prefetch request. */
export const PREFETCH_QUERY = 'sp_prefetch';

/** Flag env var + config-file env var. */
export const FLAG_ENV = 'SP_ASSETS_OVERLAY';
export const CONFIG_ENV = 'SP_ASSETS_CONFIG';
/** Config file names tried when the env flag is unset. */
export const CONFIG_NAME = 'sp-assets.json';

/** Namespace used when the manifest carries no usable hash (never fail the cache over a missing field). */
export const FALLBACK_HASH = 'v0';
/** Art root sub-directories (the layout ArtStore.java already owns). */
export const PACKS_SUBDIR = 'packs';
export const CACHE_SUBDIR = 'cache';

/**
 * CDN base for /assets/** (mirror of the line's {@code Line.ASSETS_CDN_PREFIX} = CDN + '/assets-re/').
 * Kept as a literal here because the overlay is a runtime file on the device and cannot import
 * tools/apk/line.mjs; the test pins it against tools/apk/line.mjs so the two can never drift.
 */
export const DEFAULT_CDN_BASE = 'https://weishucdn.jiangjiangze.icu/assets-re/';
/**
 * Hosts allowed to serve art (mirror of ArtCdn.java's ALLOWED_HOSTS: the line CDN host, the Pages
 * mirror and the box mirror). Anything else — including every literal address — is refused.
 */
export const ALLOWED_HOSTS = Object.freeze([
  'weishucdn.jiangjiangze.icu',
  'jingjiangze.github.io',
  'dl.jiangjiangze.icu',
]);

/** Defaults, mirroring the Java constants (MainActivity ART_* / ArtCdn). */
export const DEFAULTS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,        // per-response ceiling (ART_FETCH_MAX_BYTES)
  timeoutMs: 20 * 1000,              // overall fetch deadline (connect 6 s + read 20 s)
  maxParallel: 4,                    // page fetch slots (ART_FETCH_MAX_PARALLEL)
  maxPrefetchParallel: 2,            // prefetch slots (ART_PREFETCH_MAX_PARALLEL)
  pageWaitMs: 12 * 1000,             // page patience for a slot (ART_PAGE_SLOT_WAIT_MS)
  prefetchWaitMs: 300,               // prefetch patience (ART_PREFETCH_SLOT_WAIT_MS)
  maxCacheBytes: 512 * 1024 * 1024,  // filesDir/art/cache soft cap (ART_CACHE_MAX_BYTES)
  pruneEvery: 32,                    // prune once every N writes (maybePruneArtCache)
  missTtlMs: 10 * 60 * 1000,         // remember a definitive 4xx (ART_MISS_TTL_MS)
  maxCacheEntries: 4096,             // bound on the remembered-miss map
});

/** 1×1 transparent PNG (the image placeholder; the Java ART_PLACEHOLDER_PNG equivalent). */
export const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const msg = (e) => (e && e.message ? String(e.message) : String(e));

// ---------------------------------------------------------------------------------------------------
// Pure path / hash helpers — faithful ports of ArtCdn.java so the two implementations cannot drift
// ---------------------------------------------------------------------------------------------------

/** Sanitise a manifest hash into one safe path segment (ArtCdn.safeHash). */
export function safeHash(hash) {
  if (typeof hash !== 'string') return FALLBACK_HASH;
  const h = hash.trim();
  if (h === '' || h.length > 64) return FALLBACK_HASH;
  return /^[A-Za-z0-9_-]+$/.test(h) ? h : FALLBACK_HASH;
}

/** True when `name` is a usable art/cache namespace segment (ArtCdn.isValidNamespace). */
export function isValidNamespace(name) {
  return typeof name === 'string' && name !== '' && safeHash(name) === name;
}

/** The namespace segment of a path relative to art/cache (`<ns>/assets/…`), or null (ArtCdn.namespaceOf). */
export function namespaceOf(relFromCache) {
  if (typeof relFromCache !== 'string' || relFromCache === '') return null;
  let rel = relFromCache.replace(/\\/g, '/');
  while (rel.startsWith('/')) rel = rel.slice(1);
  const i = rel.indexOf('/');
  if (i <= 0) return null;
  const ns = rel.slice(0, i);
  return isValidNamespace(ns) ? ns : null;
}

/** Pruning priority: 0 (evict first) for a foreign namespace, 1 for the active one (ArtCdn.pruneRank). */
export function pruneRank(relFromCache, currentHash) {
  const ns = namespaceOf(relFromCache);
  return ns !== null && ns === safeHash(currentHash) ? 1 : 0;
}

/** The predecessor namespace to adopt, names newest-first (ArtCdn.pickAdoptable). */
export function pickAdoptable(currentHash, namesNewestFirst) {
  if (!Array.isArray(namesNewestFirst) || namesNewestFirst.length === 0) return null;
  const current = safeHash(currentHash);
  for (const name of namesNewestFirst) {
    if (!isValidNamespace(name)) continue;
    if (name === current) continue;
    return name;
  }
  return null;
}

/** A relative path with no empty/'.'/'..' segment and no leading/trailing slash (ArtCdn.isSafeRel). */
export function isSafeRel(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.startsWith('/') || rel.endsWith('/')) return false;
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/**
 * Any manifest string that names an asset → the same-origin path the page asks for (ArtCdn.assetPathOf):
 * `/assets/<rel>` stays, `<anything>/assets-re/<rel>` (the CDN form the build bakes in) → `/assets/<rel>`.
 */
export function assetPathOf(value) {
  if (typeof value !== 'string') return null;
  const i = value.indexOf(ASSET_PREFIX);
  if (i >= 0) {
    const p = value.slice(i);
    return isSafeRel(p.slice(ASSET_PREFIX.length)) ? p : null;
  }
  const marker = '/assets-re/';
  const j = value.indexOf(marker);
  if (j >= 0) {
    const rel = value.slice(j + marker.length);
    return isSafeRel(rel) ? ASSET_PREFIX + rel : null;
  }
  return null;
}

/** `/assets/<rel>` → `<ns>/assets/<rel>` relative to the cache dir, or null (ArtCdn.cacheRelPath). */
export function cacheRelPath(manifestHash, assetPath) {
  if (typeof assetPath !== 'string' || !assetPath.startsWith(ASSET_PREFIX)) return null;
  const rel = assetPath.slice(1); // "assets/<rel>"
  if (!isSafeRel(rel)) return null;
  return safeHash(manifestHash) + '/' + rel;
}

/** `/assets/<rel>` → the CDN URL, or null (ArtCdn.cdnUrlFor + an explicit base). */
export function cdnUrlFor(assetPath, base = DEFAULT_CDN_BASE) {
  if (typeof assetPath !== 'string' || !assetPath.startsWith(ASSET_PREFIX)) return null;
  const rel = assetPath.slice(ASSET_PREFIX.length);
  if (!isSafeRel(rel)) return null;
  const b = base.endsWith('/') ? base : base + '/';
  return b + rel;
}

// ---------------------------------------------------------------------------------------------------
// Host / address classification (ArtCdn.isBlockedLiteral + sp-host.normalizeIp/isLocalIp semantics)
// ---------------------------------------------------------------------------------------------------

/** Normalize a host: lower-case, strip [] and trailing dots. */
export function normalizeHost(host) {
  if (typeof host !== 'string') return '';
  let h = host.trim().toLowerCase();
  while (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('[') && h.endsWith(']') && h.length > 2) h = h.slice(1, -1);
  return h;
}

/** One IPv4 part in dotted/octal/hex/decimal form; null when it is not a valid literal part. */
function ipv4Part(p) {
  if (/^0[xX][0-9a-fA-F]+$/.test(p)) return parseInt(p.slice(2), 16);
  if (/^0[0-7]+$/.test(p)) return parseInt(p.slice(1), 8);
  if (/^[0-9]+$/.test(p)) return parseInt(p, 10);
  return null;
}

/** Parse an IPv4 literal in dotted/octal/hex/single-integer form; null when it is not one (ArtCdn.parseIpv4). */
export function parseIpv4(host) {
  if (typeof host !== 'string' || host === '') return null;
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  let value = 0;
  for (let i = 0; i < parts.length; i++) {
    const n = ipv4Part(parts[i]);
    if (n === null || n < 0) return null;
    if (i < parts.length - 1) {
      if (n > 0xff) return null;
      value = value * 256 + n;
    } else {
      const remaining = 4 - i;
      const max = remaining >= 4 ? 0xffffffff : 2 ** (8 * remaining) - 1;
      if (n > max) return null;
      value = value * 2 ** (8 * remaining) + n;
    }
  }
  return value >>> 0;
}

/** Loopback / private / link-local / CGNAT / documentation / multicast / reserved → true (ArtCdn.isBlockedIpv4). */
export function isBlockedIpv4(ip) {
  const a = (ip >>> 24) & 0xff;
  const b = (ip >>> 16) & 0xff;
  const c = (ip >>> 8) & 0xff;
  if (a === 0) return true;                                    // 0.0.0.0/8 "this network"
  if (a === 10) return true;                                   // 10/8 private
  if (a === 127) return true;                                  // 127/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true;           // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true;                     // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true;            // 172.16/12 private
  if (a === 192 && b === 168) return true;                     // 192.168/16 private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24, 192.0.2/24
  if (a === 192 && b === 88 && c === 99) return true;          // 192.88.99/24 (6to4 relay)
  if (a === 198 && (b === 18 || b === 19)) return true;        // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true;         // 198.51.100/24 doc
  if (a === 203 && b === 0 && c === 113) return true;          // 203.0.113/24 doc
  if (a >= 224) return true;                                   // 224/4 multicast + 240/4 reserved
  return false;
}

function hextet(x) {
  if (typeof x !== 'string' || x === '' || x.length > 4) return -1;
  return /^[0-9a-f]+$/.test(x) ? parseInt(x, 16) : -1;
}

/** IPv6 loopback / ULA / link-local / multicast / IPv4-mapped → true (ArtCdn.isBlockedIpv6). */
export function isBlockedIpv6(host) {
  let s = String(host);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  s = s.toLowerCase();
  if (s === '::' || s === '::1' || s === '0:0:0:0:0:0:0:0' || s === '0:0:0:0:0:0:0:1') return true;
  if (s.includes('.') && (s.includes(':ffff:') || s.startsWith('::'))) return true;
  const first = s.startsWith('::') ? '0' : s.split(':')[0];
  const g = hextet(first);
  if (g < 0) return true;                        // unparseable → fail closed
  if ((g & 0xffc0) === 0xfe80) return true;      // fe80::/10 link-local
  if ((g & 0xfe00) === 0xfc00) return true;      // fc00::/7 ULA
  if ((g & 0xff00) === 0xff00) return true;      // ff00::/8 multicast
  if (g === 0x2001) {
    const parts = s.split(':');
    if (parts.length > 1 && parts[1] === 'db8') return true; // 2001:db8::/32 documentation
  }
  return false;
}

/** True when the host is a literal address / name that must never be fetched (ArtCdn.isBlockedLiteral). */
export function isBlockedLiteral(host) {
  const h = normalizeHost(host);
  if (h === '') return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.includes(':')) return isBlockedIpv6(h);
  const ip = parseIpv4(h);
  return ip !== null && isBlockedIpv4(ip);
}

/** True only for our configured CDN/mirror hosts, never for a blocked literal (ArtCdn.isAllowedHost). */
export function isAllowedHost(host, allowed = ALLOWED_HOSTS) {
  const h = normalizeHost(host);
  if (h === '') return false;
  if (isBlockedLiteral(h)) return false;
  const set = allowed instanceof Set ? allowed : new Set(allowed || []);
  return set.has(h);
}

// ---------------------------------------------------------------------------------------------------
// Peer classification for the status surface (read-only; loopback/private peers only)
// ---------------------------------------------------------------------------------------------------

/** Strip brackets/port/zone and unmap ::ffff:a.b.c.d (sp-host.normalizeIp). '' when not an IP. */
export function normalizeIp(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  const withPort = /^\[([^\]]+)\](?::\d+)?$/.exec(s) || /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
  if (withPort) s = withPort[1];
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) s = mapped[1];
  return isIP(s) ? s : '';
}

/** Loopback / private / link-local / CGNAT / unspecified (sp-host.isLocalIp semantics). */
export function isLocalIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 0;
  }
  if (isIP(ip) === 6) {
    if (ip === '::1' || ip === '::') return true;
    const g = hextet(ip.split(':')[0]);
    if (g < 0) return false;
    return (g & 0xfe00) === 0xfc00 || (g & 0xffc0) === 0xfe80;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------
// Request parsing + prefetch marking
// ---------------------------------------------------------------------------------------------------

/** True when a request is a background prefetch (header, ?sp_prefetch, or the /__sp/pf prefix). */
export function isPrefetchRequest(headers, query) {
  if (headers && typeof headers === 'object') {
    const keys = typeof headers.keys === 'function' ? Array.from(headers.keys()) : Object.keys(headers);
    for (const k of keys) {
      if (typeof k !== 'string' || k.toLowerCase() !== PREFETCH_HEADER) continue;
      const v = typeof headers.get === 'function' ? headers.get(k) : headers[k];
      if (v == null) continue;
      const s = String(v).trim().toLowerCase();
      return s !== '' && s !== '0' && s !== 'false';
    }
  }
  const q = typeof query === 'string' ? new URLSearchParams(query) : (query || null);
  if (q) {
    const v = q.get(PREFETCH_QUERY);
    if (v != null) {
      const s = String(v).trim().toLowerCase();
      return s === '' || (s !== '0' && s !== 'false');
    }
  }
  return false;
}

/**
 * A /assets/** request → { assetPath, rel, prefetch }, or null when the path is not an asset request
 * (or is not a safe relative path — upstream answers that 403/404 itself).
 */
export function parseAssetRequest(rawPath, query, headers) {
  if (typeof rawPath !== 'string') return null;
  let assetPath = null;
  let prefetch = false;
  if (rawPath.startsWith(PREFETCH_PREFIX)) {
    assetPath = ASSET_PREFIX + rawPath.slice(PREFETCH_PREFIX.length);
    prefetch = true;
  } else if (rawPath.startsWith(ASSET_PREFIX)) {
    assetPath = rawPath;
  }
  if (assetPath === null) return null;
  const rel = assetPath.slice(ASSET_PREFIX.length);
  if (!isSafeRel(rel)) return null;
  if (isPrefetchRequest(headers, query)) prefetch = true;
  return { assetPath, rel, prefetch };
}

/** Placeholder response headers (ArtCdn.placeholderHeaders): no-store is load-bearing (H4). */
export function placeholderHeaders() {
  return { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
}

/** Minimal MIME map (the Java mimeFor table). */
const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain',
  '.atlas': 'text/plain', '.csv': 'text/csv', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.webm': 'video/webm', '.mp4': 'video/mp4', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.otf': 'font/otf', '.ttf': 'font/ttf', '.skel': 'application/octet-stream',
  '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
};

/** Content-Type for a path (Java mimeFor). */
export function mimeFor(p) {
  const lower = String(p).toLowerCase();
  const dot = lower.lastIndexOf('.');
  return MIME[dot >= 0 ? lower.slice(dot) : ''] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------------------------------
// Slot pool with page-over-prefetch priority
// ---------------------------------------------------------------------------------------------------

/**
 * A small priority semaphore. `acquire(prefetch, waitMs)` resolves true when a slot was granted (the
 * caller MUST then `release(prefetch)`), false when the patience ran out. When a slot frees, a
 * waiting PAGE request is always granted before any waiting prefetch.
 * @param {{max?: number, maxPrefetch?: number, setTimer?: Function, clearTimer?: Function}} [opts]
 */
export function createPool(opts = {}) {
  const max = Math.max(1, opts.max ?? DEFAULTS.maxParallel);
  const maxPrefetch = Math.max(0, opts.maxPrefetch ?? DEFAULTS.maxPrefetchParallel);
  const setTimer = opts.setTimer || setTimeout;
  const clearTimer = opts.clearTimer || clearTimeout;
  let active = 0;
  let activePrefetch = 0;
  const waiters = [];
  const stats = { granted: 0, grantedPrefetch: 0, yielded: 0 };

  const canGrant = (prefetch) => (prefetch ? active < max && activePrefetch < maxPrefetch : active < max);

  function take() {
    if (active >= max) return;
    let idx = waiters.findIndex((w) => !w.prefetch);
    if (idx < 0) {
      if (activePrefetch >= maxPrefetch) return;
      idx = waiters.findIndex((w) => w.prefetch);
    }
    if (idx < 0) return;
    const w = waiters.splice(idx, 1)[0];
    if (w.timer) clearTimer(w.timer);
    active += 1;
    if (w.prefetch) { activePrefetch += 1; stats.grantedPrefetch += 1; } else { stats.granted += 1; }
    w.resolve(true);
  }

  function acquire(prefetch, waitMs) {
    if (canGrant(prefetch)) {
      active += 1;
      if (prefetch) { activePrefetch += 1; stats.grantedPrefetch += 1; } else { stats.granted += 1; }
      return Promise.resolve(true);
    }
    if (!(waitMs > 0)) {
      stats.yielded += 1;
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const w = { prefetch: !!prefetch, resolve, timer: null };
      w.timer = setTimer(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        stats.yielded += 1;
        resolve(false);
      }, waitMs);
      w.timer.unref?.();
      waiters.push(w);
    });
  }

  function release(prefetch) {
    if (active > 0) active -= 1;
    if (prefetch && activePrefetch > 0) activePrefetch -= 1;
    take();
  }

  return {
    acquire,
    release,
    stats: () => ({
      active,
      activePrefetch,
      max,
      maxPrefetch,
      waiting: waiters.filter((w) => !w.prefetch).length,
      waitingPrefetch: waiters.filter((w) => w.prefetch).length,
      ...stats,
    }),
  };
}

// ---------------------------------------------------------------------------------------------------
// Flag resolution (env wins; then a JSON config file; default OFF)
// ---------------------------------------------------------------------------------------------------

/**
 * Resolve the overlay flag. Env `SP_ASSETS_OVERLAY` wins (truthy = on, anything else = off), else the
 * first readable JSON config with `{ "enabled": true }` among: $SP_ASSETS_CONFIG, <overlayDir>/sp-assets.json,
 * <webroot>/data/sp-assets.json. Nothing found → off.
 * @returns {{enabled: boolean, source: string, path?: string, config?: object, error?: string}}
 */
export function resolveFlag({ env = process.env, overlayDir, upstreamDir } = {}) {
  const raw = env[FLAG_ENV];
  if (raw != null && String(raw).trim() !== '') {
    return { enabled: TRUTHY.has(String(raw).trim().toLowerCase()), source: `env:${FLAG_ENV}`, raw: String(raw) };
  }
  const candidates = [];
  if (env[CONFIG_ENV]) candidates.push(env[CONFIG_ENV]);
  if (overlayDir) candidates.push(path.join(overlayDir, CONFIG_NAME));
  if (upstreamDir) candidates.push(path.join(path.dirname(upstreamDir), 'data', CONFIG_NAME));
  for (const p of candidates) {
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      return { enabled: false, source: 'config-error', path: p, error: msg(e) };
    }
    try {
      const cfg = JSON.parse(text);
      return { enabled: !!(cfg && cfg.enabled === true), source: 'config', path: p, config: cfg };
    } catch (e) {
      return { enabled: false, source: 'config-error', path: p, error: msg(e) };
    }
  }
  return { enabled: false, source: 'default' };
}

// ---------------------------------------------------------------------------------------------------
// Small IO helpers
// ---------------------------------------------------------------------------------------------------

function statFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function statDir(p) {
  try {
    const st = fs.statSync(p);
    return st.isDirectory() ? st : null;
  } catch {
    return null;
  }
}

function mkdirp(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists / best effort */ }
}

function rmQuiet(p) {
  try { fs.rmSync(p, { force: true, recursive: true }); } catch { /* best effort */ }
}

/** Read the top-level `hash` of a manifest file, cached by mtime (cheap: no re-parse per request). */
export function createManifestHashReader(file) {
  let lastMtime = -1;
  let lastHash = FALLBACK_HASH;
  return function read() {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs !== lastMtime) {
        lastMtime = st.mtimeMs;
        const text = fs.readFileSync(file, 'utf8');
        const m = /"hash"\s*:\s*"([^"]*)"/.exec(text);
        lastHash = m ? safeHash(m[1]) : FALLBACK_HASH;
      }
    } catch {
      lastMtime = -1;
      lastHash = FALLBACK_HASH;
    }
    return lastHash;
  };
}

/** Iterate a fetch Response body as Buffers (async-iterable, WHATWG reader, or arrayBuffer). */
async function* bodyChunks(res) {
  const body = res && res.body;
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    return;
  }
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield Buffer.isBuffer(value) ? value : Buffer.from(value);
      }
    } finally {
      try { reader.releaseLock?.(); } catch { /* ignore */ }
    }
    return;
  }
  if (res && typeof res.arrayBuffer === 'function') yield Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------------------------------

function splitUrl(url) {
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
  } catch {
    try { res.destroy?.(); } catch { /* client went away */ }
  }
}

function sendText(req, res, status, text) {
  const body = Buffer.from(text);
  try {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(req && req.method === 'HEAD' ? undefined : body);
  } catch {
    try { res.destroy?.(); } catch { /* ignore */ }
  }
}

function resolveHttpServer(srv) {
  if (srv && typeof srv.on === 'function' && typeof srv.removeAllListeners === 'function') return srv;
  const inner = srv && typeof srv === 'object' ? srv.server : null;
  if (inner && typeof inner.on === 'function' && typeof inner.removeAllListeners === 'function') return inner;
  return null;
}

/**
 * Build one sp-assets controller. All seams are injectable so the tests stay JVM-free and offline.
 * @param {object} [options]
 */
export function createController(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const enabled = options.enabled !== false;

  const webrootDir = typeof options.webrootDir === 'string' && options.webrootDir ? options.webrootDir : null;
  const localRoots = Array.isArray(options.localRoots) && options.localRoots.length
    ? options.localRoots.slice()
    : (webrootDir ? [webrootDir, path.join(webrootDir, 'public')] : []);
  const embeddedRoots = Array.isArray(options.embeddedRoots) ? options.embeddedRoots.slice() : [];
  const artRoot = typeof options.artRoot === 'string' && options.artRoot ? options.artRoot : null;
  const cacheDir = typeof options.cacheDir === 'string' && options.cacheDir
    ? options.cacheDir
    : (artRoot ? path.join(artRoot, CACHE_SUBDIR) : null);
  const packsDir = artRoot ? path.join(artRoot, PACKS_SUBDIR) : null;

  const cdnBase = typeof options.cdnBase === 'string' && options.cdnBase ? options.cdnBase : DEFAULT_CDN_BASE;
  const allowedHosts = options.allowHosts ? new Set(options.allowHosts) : new Set(ALLOWED_HOSTS);

  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULTS.maxBytes;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULTS.timeoutMs;
  const maxCacheBytes = Number.isFinite(options.maxCacheBytes) ? options.maxCacheBytes : DEFAULTS.maxCacheBytes;
  const pruneEvery = Number.isFinite(options.pruneEvery) && options.pruneEvery > 0 ? options.pruneEvery : DEFAULTS.pruneEvery;
  const missTtlMs = Number.isFinite(options.missTtlMs) ? options.missTtlMs : DEFAULTS.missTtlMs;
  const placeholder = options.placeholder !== false;
  const followRedirects = options.followRedirects === true;
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const expectedHashFor = typeof options.expectedHashFor === 'function' ? options.expectedHashFor : () => null;
  const peerIsLocal = typeof options.peerIsLocal === 'function'
    ? options.peerIsLocal
    : (req) => isLocalIp(normalizeIp(req && req.socket && req.socket.remoteAddress));

  const manifestHashFn = typeof options.manifestHash === 'function'
    ? options.manifestHash
    : (typeof options.manifestHash === 'string'
      ? () => options.manifestHash
      : createManifestHashReader(options.manifestPath || (webrootDir ? path.join(webrootDir, 'data', 'assets.json') : '')));

  const pool = createPool({
    max: options.maxParallel,
    maxPrefetch: options.maxPrefetchParallel,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
  });
  const pageWaitMs = Number.isFinite(options.pageWaitMs) ? options.pageWaitMs : DEFAULTS.pageWaitMs;
  const prefetchWaitMs = Number.isFinite(options.prefetchWaitMs) ? options.prefetchWaitMs : DEFAULTS.prefetchWaitMs;

  const hits = { local: 0, pack: 0, embedded: 0, cache: 0, cdn: 0, placeholder: 0 };
  const stats = { requests: 0, misses: 0, failed: 0, blocked: 0, poolRejected: 0, prefetchRequests: 0 };
  const verify = { checked: 0, failed: 0 };
  const adopted = [];
  const pruned = { count: 0, bytes: 0 };
  let writes = 0;
  let adoptedFor = null;
  const lastAccess = new Map();
  const lastHash = new Map();
  const missUntil = new Map();
  const inflight = new Map();

  const touch = (p) => { lastAccess.set(p, now()); };

  function rememberMiss(dest) {
    if (missUntil.size > DEFAULTS.maxCacheEntries) missUntil.clear();
    missUntil.set(dest, now() + missTtlMs);
  }

  function missRemembered(dest) {
    const until = missUntil.get(dest);
    if (until == null) return false;
    if (until < now()) { missUntil.delete(dest); return false; }
    return true;
  }

  /** The active cache namespace, adopting the predecessor once per hash per process. */
  function cacheNamespace() {
    let hash = FALLBACK_HASH;
    try {
      hash = safeHash(manifestHashFn());
    } catch { /* fall through with v0 */ }
    if (hash !== adoptedFor) adopt(hash);
    return hash;
  }

  /** Rename the most recently used predecessor namespace onto `current` (once per hash per process). */
  function adopt(current) {
    adoptedFor = current; // one attempt per hash per process, success or not
    if (!cacheDir) return;
    try {
      const to = path.join(cacheDir, current);
      const toStat = statDir(to);
      if (toStat) {
        let entries = null;
        try { entries = fs.readdirSync(to); } catch { entries = null; }
        if (entries && entries.length > 0) return; // populated under this hash: never merge
        rmQuiet(to);                               // empty leftover of a failed fetch: drop it
      }
      const from = pickPredecessor(current);
      if (!from) return;
      fs.renameSync(from, to);
      adopted.push({ from: path.basename(from), to: current });
      log(`[sp-assets] adopted cache namespace ${path.basename(from)} -> ${current}`);
    } catch (e) {
      log(`[sp-assets] namespace adoption failed: ${msg(e)}`);
    }
  }

  /** Newest non-empty namespace directory that is not `current` (null when there is none to adopt). */
  function pickPredecessor(current) {
    let kids;
    try { kids = fs.readdirSync(cacheDir, { withFileTypes: true }); } catch { return null; }
    const dirs = [];
    for (const k of kids) {
      if (!k.isDirectory() || k.name === current || !isValidNamespace(k.name)) continue;
      const full = path.join(cacheDir, k.name);
      let entries;
      try { entries = fs.readdirSync(full); } catch { entries = null; }
      if (!entries || entries.length === 0) continue;
      const st = statDir(full);
      dirs.push({ name: k.name, full, mtimeMs: st ? st.mtimeMs : 0 });
    }
    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const pick = pickAdoptable(current, dirs.map((d) => d.name));
    if (pick === null) return null;
    const hit = dirs.find((d) => d.name === pick);
    return hit ? hit.full : null;
  }

  /** LRU prune under maxCacheBytes: foreign namespaces first, then the least recently used. */
  function pruneCache(namespace) {
    if (!cacheDir) return { removed: 0, bytes: 0 };
    const files = [];
    let total = 0;
    const walk = (dir) => {
      let kids;
      try { kids = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const k of kids) {
        const full = path.join(dir, k.name);
        if (k.isDirectory()) { walk(full); continue; }
        const st = statFile(full);
        if (!st) continue;
        files.push({ full, size: st.size, mtimeMs: st.mtimeMs });
        total += st.size;
      }
    };
    walk(cacheDir);
    if (total <= maxCacheBytes) return { removed: 0, bytes: 0 };
    const ns = namespace === undefined ? cacheNamespace() : namespace;
    const relOf = (p) => path.relative(cacheDir, p).split(path.sep).join('/');
    files.sort((a, b) => {
      const ra = pruneRank(relOf(a.full), ns);
      const rb = pruneRank(relOf(b.full), ns);
      if (ra !== rb) return ra - rb; // 0 (foreign/orphan) evicted before 1 (active)
      const la = lastAccess.has(a.full) ? lastAccess.get(a.full) : a.mtimeMs;
      const lb = lastAccess.has(b.full) ? lastAccess.get(b.full) : b.mtimeMs;
      return la - lb;
    });
    let removed = 0;
    let bytes = 0;
    for (const f of files) {
      if (total <= maxCacheBytes) break;
      try {
        fs.unlinkSync(f.full);
        total -= f.size;
        removed += 1;
        bytes += f.size;
        lastAccess.delete(f.full);
      } catch { /* locked / already gone */ }
    }
    if (removed > 0) {
      pruned.count += removed;
      pruned.bytes += bytes;
      log(`[sp-assets] pruned ${removed} cache file(s), ${bytes} bytes`);
    }
    return { removed, bytes };
  }

  // ------------------------------------------------------------------ layer lookup

  /** First existing file for `/assets/<rel>` under one of `roots`. */
  function findInRoots(roots, assetPath) {
    const rel = assetPath.slice(1); // "assets/<rel>"
    for (const root of roots) {
      if (typeof root !== 'string' || root === '') continue;
      const st = statFile(path.join(root, rel));
      if (st) return path.join(root, rel);
    }
    return null;
  }

  /** First existing file for `/assets/<rel>` under packs/<id>/ (id ascending, .tmp skipped). */
  function findInPacks(assetPath) {
    if (!packsDir) return null;
    let kids;
    try { kids = fs.readdirSync(packsDir, { withFileTypes: true }); } catch { return null; }
    const ids = kids
      .filter((k) => k.isDirectory() && !k.name.endsWith('.tmp') && isValidNamespace(k.name))
      .map((k) => k.name)
      .sort();
    const rel = assetPath.slice(1);
    for (const id of ids) {
      const full = path.join(packsDir, id, rel);
      if (statFile(full)) return full;
    }
    return null;
  }

  // ------------------------------------------------------------------ gated CDN fetch

  /** URL rules: http/https only, allow-listed host, never a blocked literal. */
  function checkUrl(url) {
    let u;
    try { u = new URL(url); } catch { return { ok: false, reason: 'bad-url' }; }
    const scheme = u.protocol.toLowerCase();
    if (scheme !== 'http:' && scheme !== 'https:') return { ok: false, reason: 'scheme' };
    const host = normalizeHost(u.hostname);
    if (host === '') return { ok: false, reason: 'no-host' };
    if (isBlockedLiteral(host)) return { ok: false, reason: 'blocked-address' };
    if (!isAllowedHost(host, allowedHosts)) return { ok: false, reason: 'host-not-allowed' };
    return { ok: true, host };
  }

  async function downloadToCache(url, dest, prefetch, assetPath) {
    const existing = inflight.get(dest);
    if (existing) {
      await existing.catch(() => {});
      const st = statFile(dest);
      return st ? { ok: true, sha256: lastHash.get(dest) || null, bytes: st.size, joined: true } : { ok: false, reason: 'inflight-failed' };
    }
    const p = doDownload(url, dest, prefetch, assetPath);
    inflight.set(dest, p);
    try {
      return await p;
    } finally {
      inflight.delete(dest);
    }
  }

  async function doDownload(url, dest, prefetch, assetPath) {
    const got = await pool.acquire(prefetch, prefetch ? prefetchWaitMs : pageWaitMs);
    if (!got) {
      stats.poolRejected += 1;
      return { ok: false, reason: 'pool' };
    }
    try {
      if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no-fetch' };
      const part = dest + '.part';
      mkdirp(path.dirname(dest));
      rmQuiet(part);
      const ctrl = new AbortController();
      const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs);
      timer.unref?.();
      let res;
      try {
        res = await fetchImpl(url, { redirect: followRedirects ? 'follow' : 'manual', signal: ctrl.signal, headers: { Accept: '*/*' } });
      } catch {
        return { ok: false, reason: 'network' };
      } finally {
        clearTimeout(timer);
      }
      const status = Number(res && res.status) || 0;
      if (status >= 300 && status < 400) return { ok: false, reason: 'redirect' };
      if (status < 200 || status >= 300) {
        if (status >= 400 && status < 500) rememberMiss(dest);
        return { ok: false, reason: `http-${status}` };
      }
      let declared = NaN;
      try { declared = Number(res.headers.get('content-length')); } catch { declared = NaN; }
      if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too-big' };

      const hash = crypto.createHash('sha256');
      let fd;
      try {
        fd = fs.openSync(part, 'w');
      } catch {
        return { ok: false, reason: 'open' };
      }
      let total = 0;
      let tooBig = false;
      let streamFailed = false;
      try {
        for await (const chunk of bodyChunks(res)) {
          total += chunk.length;
          if (total > maxBytes) { tooBig = true; break; }
          hash.update(chunk);      // STREAMED: hash while writing, one pass, no second read
          fs.writeSync(fd, chunk);
        }
      } catch {
        streamFailed = true;
      }
      try { fs.closeSync(fd); } catch { /* ignore */ }
      if (streamFailed) {
        rmQuiet(part);
        return { ok: false, reason: 'stream' };
      }
      if (tooBig || total <= 0) {
        rmQuiet(part);
        return { ok: false, reason: tooBig ? 'too-big' : 'empty' };
      }
      const sha256 = hash.digest('hex'); // STREAMED: one pass, no second read of the file
      const expected = expectedHashFor(assetPath);
      if (expected) {
        verify.checked += 1;
        if (String(expected).trim().toLowerCase() !== sha256) {
          verify.failed += 1;
          rmQuiet(part);
          return { ok: false, reason: 'sha256' };
        }
      }
      try {
        fs.renameSync(part, dest);
      } catch {
        rmQuiet(dest);
        try { fs.renameSync(part, dest); } catch { rmQuiet(part); return { ok: false, reason: 'rename' }; }
      }
      lastHash.set(dest, sha256);
      writes += 1;
      if (writes % pruneEvery === 0) pruneCache(cacheNamespace());
      return { ok: true, sha256, bytes: total };
    } finally {
      pool.release(prefetch);
    }
  }

  // ------------------------------------------------------------------ resolve

  /**
   * The decision order. Returns { layer, file, sha256?, bytes? } or { layer: null, reason } on a
   * genuine miss. Never verifies a hit.
   */
  async function resolve(assetPath, prefetch) {
    const local = findInRoots(localRoots, assetPath);
    if (local) { hits.local += 1; return { layer: 'local', file: local }; }

    const pack = findInPacks(assetPath);
    if (pack) { hits.pack += 1; return { layer: 'pack', file: pack }; }

    const embedded = findInRoots(embeddedRoots, assetPath);
    if (embedded) { hits.embedded += 1; return { layer: 'embedded', file: embedded }; }

    let cached = null;
    if (cacheDir) {
      const rel = cacheRelPath(cacheNamespace(), assetPath);
      if (rel) cached = path.join(cacheDir, rel);
      if (cached && statFile(cached)) {
        hits.cache += 1;
        touch(cached);
        return { layer: 'cache', file: cached };
      }
    }

    const url = cdnUrlFor(assetPath, cdnBase);
    if (url && cached) {
      const verdict = checkUrl(url);
      if (!verdict.ok) {
        stats.blocked += 1;
        log(`[sp-assets] refused CDN target (${verdict.reason}): ${assetPath}`);
        return { layer: null, reason: verdict.reason };
      }
      if (cached && missRemembered(cached)) return { layer: null, reason: 'remembered-miss' };
      const dl = await downloadToCache(url, cached, prefetch, assetPath);
      if (dl.ok) {
        hits.cdn += 1;
        return { layer: 'cdn', file: cached, sha256: dl.sha256, bytes: dl.bytes };
      }
      stats.failed += 1;
      log(`[sp-assets] fetch failed (${dl.reason}): ${assetPath}`);
      return { layer: null, reason: dl.reason };
    }
    return { layer: null, reason: url ? 'no-cache-dir' : 'no-url' };
  }

  // ------------------------------------------------------------------ serving

  function serveFile(req, res, file, st) {
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`; // cheap: size+mtime, not a hash
    const inm = req.headers && req.headers['if-none-match'];
    if (typeof inm === 'string' && inm.split(',').some((v) => v.trim() === etag)) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeFor(file),
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Content-Length': String(st.size),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file);
    stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
    stream.pipe(res);
  }

  function servePlaceholder(req, res, assetPath) {
    hits.placeholder += 1;
    const mime = mimeFor(assetPath);
    const headers = placeholderHeaders();
    if (mime.startsWith('image/')) {
      try {
        res.writeHead(200, { 'Content-Type': 'image/png', ...headers, 'Content-Length': String(PLACEHOLDER_PNG.length) });
        res.end(req.method === 'HEAD' ? undefined : PLACEHOLDER_PNG);
      } catch { /* ignore */ }
      return;
    }
    try {
      res.writeHead(200, { 'Content-Type': mime, ...headers, 'Content-Length': '0' });
      res.end();
    } catch { /* ignore */ }
  }

  async function serveAsset(req, res, parsed) {
    let outcome;
    try {
      outcome = await resolve(parsed.assetPath, parsed.prefetch);
    } catch (e) {
      log(`[sp-assets] resolve failed: ${msg(e)}`);
      outcome = { layer: null, reason: 'error' };
    }
    const st = outcome.file ? statFile(outcome.file) : null;
    if (st) { serveFile(req, res, outcome.file, st); return; }
    stats.misses += 1;
    if (placeholder) servePlaceholder(req, res, parsed.assetPath);
    else sendText(req, res, 404, 'Not found');
  }

  // ------------------------------------------------------------------ status

  function status() {
    let bytes = 0;
    let files = 0;
    if (cacheDir) {
      const walk = (dir) => {
        let kids;
        try { kids = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const k of kids) {
          const full = path.join(dir, k.name);
          if (k.isDirectory()) { walk(full); continue; }
          const st = statFile(full);
          if (st) { bytes += st.size; files += 1; }
        }
      };
      walk(cacheDir);
    }
    let ns = FALLBACK_HASH;
    try { ns = safeHash(manifestHashFn()); } catch { /* v0 */ }
    return {
      ok: true,
      id,
      enabled,
      namespace: ns,
      cache: { dir: cacheDir, bytes, files, maxBytes: maxCacheBytes },
      layers: ['local', 'pack', 'embedded', 'cache', 'cdn', 'placeholder'],
      hits: { ...hits },
      misses: stats.misses,
      failed: stats.failed,
      blocked: stats.blocked,
      poolRejected: stats.poolRejected,
      requests: stats.requests,
      prefetchRequests: stats.prefetchRequests,
      inflight: inflight.size,
      writes,
      verify: { ...verify },
      adopted: adopted.slice(-16),
      pruned: { ...pruned },
      pool: pool.stats(),
      missRemembered: missUntil.size,
      cdnBase,
      allowedHosts: Array.from(allowedHosts),
    };
  }

  // ------------------------------------------------------------------ request dispatch

  function handleRequest(req, res) {
    if (!enabled) return false;
    const parts = splitUrl((req && req.url) || '/');
    if (!parts) return false;
    const method = String((req && req.method) || '').toUpperCase();

    if (parts.rawPath === STATUS_PATH) {
      if (method !== 'GET' && method !== 'HEAD') return false;
      if (!peerIsLocal(req)) { sendJson(req, res, 403, { ok: false, error: 'forbidden' }); return true; }
      sendJson(req, res, 200, status());
      return true;
    }

    const parsed = parseAssetRequest(parts.rawPath, parts.query, req && req.headers);
    if (!parsed) return false;
    if (method !== 'GET' && method !== 'HEAD') return false; // upstream answers 405
    stats.requests += 1;
    if (parsed.prefetch) stats.prefetchRequests += 1;
    serveAsset(req, res, parsed).catch((e) => {
      log(`[sp-assets] serve failed: ${msg(e)}`);
      try { res.destroy(); } catch { /* ignore */ }
    });
    return true;
  }

  // --- listener wrapping (same discipline as sp-host: detach originals, run ours first) ---

  let attachedServer = null;
  let requestListeners = [];
  let onRequestWrapper = null;

  function attach(server) {
    if (!enabled) return;
    detach();
    requestListeners = (typeof server.rawListeners === 'function' ? server.rawListeners('request') : server.listeners('request')).slice();
    server.removeAllListeners('request');
    onRequestWrapper = (req, res) => {
      let handled;
      try {
        handled = handleRequest(req, res);
      } catch (e) {
        log(`[sp-assets] request handler failed: ${msg(e)}`);
        handled = false;
      }
      if (handled) return;
      for (const listener of requestListeners) {
        try { listener.call(server, req, res); } catch (e) { log(`[sp-assets] upstream listener failed: ${msg(e)}`); }
      }
    };
    server.on('request', onRequestWrapper);
    attachedServer = server;
  }

  function detach() {
    if (!attachedServer) return;
    const s = attachedServer;
    attachedServer = null;
    try {
      s.removeListener('request', onRequestWrapper);
      for (const listener of requestListeners) s.on('request', listener);
    } catch (e) {
      log(`[sp-assets] detach failed: ${msg(e)}`);
    }
    requestListeners = [];
    onRequestWrapper = null;
  }

  return {
    enabled,
    attach,
    detach,
    close: () => detach(),
    handleRequest,
    resolve,
    status,
    cacheNamespace,
    pruneCache,
    adopt,
    /** Test/diagnostic seams. */
    internals: () => ({ hits, stats, verify, adopted, pruned, pool, inflight, lastHash }),
  };
}

// ---------------------------------------------------------------------------------------------------
// Overlay entry point
// ---------------------------------------------------------------------------------------------------

/**
 * Overlay entry (called by server/overlay-loader.mjs after startServer()). Reads the flag itself (so
 * a content hot-update can flip it) and attaches NOTHING when disabled.
 * @param {{server?: object, port?: number, host?: string, upstreamDir?: string, log?: Function, env?: object}} ctx
 */
export async function install(ctx) {
  const log = typeof ctx?.log === 'function' ? ctx.log : (m) => console.log(m);
  const env = (ctx && ctx.env) || process.env;
  const overlayDir = path.dirname(fileURLToPath(import.meta.url));
  const upstreamDir = typeof ctx?.upstreamDir === 'string' ? ctx.upstreamDir : undefined;
  const flag = resolveFlag({ env, overlayDir, upstreamDir });

  const webrootDir = typeof env.SP_ASSETS_WEBROOT === 'string' && env.SP_ASSETS_WEBROOT
    ? env.SP_ASSETS_WEBROOT
    : (upstreamDir ? path.dirname(upstreamDir) : (env.HOME || process.cwd()));
  const artRoot = typeof env.SP_ASSETS_ART_ROOT === 'string' && env.SP_ASSETS_ART_ROOT
    ? env.SP_ASSETS_ART_ROOT
    : path.join(path.dirname(webrootDir), 'art');

  const controller = createController({ log, env, enabled: flag.enabled, webrootDir, artRoot });

  if (!flag.enabled) {
    log(`[sp-assets] disabled (${flag.source}${flag.path ? ' ' + flag.path : ''}) — /assets/** stays on the Java interceptor`);
    return controller;
  }

  const httpServer = resolveHttpServer(ctx?.server);
  if (!httpServer) {
    log('[sp-assets] no http server in ctx — routes not attached (controller returned for tests)');
    return controller;
  }
  controller.attach(httpServer);
  log(`[sp-assets] enabled (${flag.source}) — /assets/** = local → packs → embedded → cache → gated CDN → placeholder; status ${STATUS_PATH}`);
  return controller;
}
