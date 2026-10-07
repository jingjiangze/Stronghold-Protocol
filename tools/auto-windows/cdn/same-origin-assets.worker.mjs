// same-origin-assets -- the shape this ecosystem actually runs in production.
//
// A Cloudflare Zone route hands the four static prefixes of your game hostname(s) to this
// Worker; every other path (/, /ws, /socket.io/, /healthz) keeps going to your server
// untouched, so nothing on the client or in nginx has to change and asset URLs stay
// same-origin (no canvas tainting, no CORS surprises).
//
// Per request inside a prefix:
//   1. edge cache (Workers Cache API)          -> X-Asset-Source: edge
//   2. your private R2 bucket                  -> X-Asset-Source: r2
//   3. that request's own origin, then cache   -> X-Asset-Source: origin
// Step 3 is the one that matters on a bad day: a bucket that has not caught up with a new
// build used to answer 404 and the player saw a broken client. Now the file comes from your
// server once and every later visitor in that colo gets it from the edge.
//
// If your bucket is SHARED between servers, do not write back to it -- that is how one
// operator's build ends up overwriting another's bytes under the same key. The pull-through
// here only ever writes the colo-local edge cache.
const PREFIXES = ['/assets/', '/vendor/', '/fonts/', '/media/'];
// Workers Cache API silently refuses a body it will not store, so keep the guard explicit.
// It also refuses content types outside its allow-list; those still come from R2 on every
// hit, and only the origin pull-through path relies on cacheEverything to get edge-cached.
const MAX_EDGE_BYTES = 32 * 1024 * 1024;
const EDGE_TTL = 60 * 60 * 24 * 31;
const BROWSER_TTL = 60 * 60 * 24 * 30;

function assetKey(pathname) {
  for (const prefix of PREFIXES) {
    if (!pathname.startsWith(prefix)) continue;
    if (pathname.includes('..')) return null;
    // /media/ mirrors the server's own audio alias, extension-less URLs included. Without
    // this mapping the extension-less path is also invisible to Cloudflare's default
    // extension-based cache, so audio would reload from your uplink on every join.
    if (prefix === '/media/') {
      const rel = pathname.slice('/media/'.length);
      return 'assets/audio/' + (/\.[a-z0-9]{2,5}$/i.test(rel) ? rel : rel + '.mp3');
    }
    return pathname.slice(1);
  }
  return null;
}

function headersFor(source, extra) {
  const headers = new Headers(extra || {});
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cache-Control', `public, max-age=${BROWSER_TTL}, immutable`);
  headers.set('X-Served-By', 'same-origin-assets-worker');
  headers.set('X-Asset-Source', source);
  return headers;
}

async function fromBucket(env, key, request) {
  const object = await env.ASSETS.get(key);
  if (!object) return null;
  const headers = headersFor('r2');
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('content-length', String(object.size));
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(object.body, { status: 200, headers });
}

async function fromOrigin(request, cacheKey, cache, ctx) {
  // vary:true keeps gzip and brotli variants apart in the zone cache; the Workers Cache API
  // does not document Vary handling at all, so an encoded body is deliberately kept out of
  // cache.put rather than risk handing gzipped bytes to a client that did not ask for them.
  const upstream = await fetch(request, { cf: { cacheTtl: EDGE_TTL, cacheEverything: true, vary: true } });
  const headers = headersFor(upstream.status === 200 ? 'origin' : 'origin-skip', upstream.headers);
  headers.delete('set-cookie');
  const body = request.method === 'HEAD' ? null : upstream.body;
  const response = new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
  const encoded = (headers.get('content-encoding') || '') !== '';
  if (upstream.status === 200 && request.method === 'GET' && !encoded) {
    const length = Number(headers.get('content-length') || 0);
    if (length === 0 || length <= MAX_EDGE_BYTES) ctx.waitUntil(cache.put(cacheKey, response.clone(), { ttl: EDGE_TTL }));
  }
  return response;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return fetch(request);
    const url = new URL(request.url);
    const key = assetKey(url.pathname);
    if (!key) return fetch(request);

    const cacheKey = new Request(url.toString(), { method: 'GET', headers: request.headers });
    const cache = caches.default;
    const edge = await cache.match(cacheKey);
    if (edge) {
      const headers = headersFor('edge', edge.headers);
      return new Response(request.method === 'HEAD' ? null : edge.body, { status: edge.status, headers });
    }

    const bucket = await fromBucket(env, key, request);
    if (bucket) {
      if (request.method === 'GET') ctx.waitUntil(cache.put(cacheKey, bucket.clone(), { ttl: EDGE_TTL }));
      return bucket;
    }
    return fromOrigin(request, cacheKey, cache, ctx);
  },
};
