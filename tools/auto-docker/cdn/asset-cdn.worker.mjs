// sp-asset-cdn -- pull-through cache for ONE server's own static payload.
//
// The operator's nginx 302-redirects /assets|/media|/vendor|/fonts|/data here. We look in the
// operator's private R2 bucket first; on a miss we fetch that one file from the server's own
// front, store it, and answer. Consequences that matter:
//   * the game server's home uplink carries at most one copy of each file, ever;
//   * nothing is published as a browsable mirror: no listing, the five prefixes only, exact
//     paths required, '..' rejected;
//   * no cloud credentials are placed on the game server.
// Version invalidation is by query token (?v=<app>): the updater rewrites the redirect URLs,
// so a new build needs no purge and no key-value store.
const ORIGIN = 'https://play.example.com';            // <- your server's own front
const PREFIXES = ['/assets/', '/media/', '/vendor/', '/fonts/', '/data/'];
const TtlSeconds = 60 * 60 * 24 * 30;

const MIME = {
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  json: 'application/json', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml',
};
const extOf = (p) => { const i = p.lastIndexOf('.'); const q = i < 0 ? '' : p.slice(i + 1).toLowerCase(); return /^[a-z0-9]{1,5}$/.test(q) ? q : ''; };
const safePath = (p) => !p.includes('..') && PREFIXES.some((pre) => p.startsWith(pre));

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'access-control-allow-methods': 'GET, HEAD', 'access-control-allow-headers': 'range', 'access-control-max-age': '86400' } });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405 });

    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    if (!safePath(path)) return new Response('forbidden', { status: 403 });

    const key = path.slice(1);
    const range = req.headers.get('range');

    // 1) private bucket
    let obj = await env.ASSETS.get(key, { onlyIf: true, rangeHeader: range || undefined });
    if (obj && (obj.status === 304 || obj.httpMetadata?.cacheControl === 'stale')) obj = null;

    if (!obj) {
      // 2) pull the single file from this server's own front
      let from;
      try {
        const h = {}; if (range) h.range = range;
        from = await fetch(ORIGIN + path, { headers: h, cf: { cacheTtl: 0 } });
      } catch { return new Response('origin unreachable', { status: 502 }); }
      if (!from.ok) return Response.redirect(ORIGIN + path + url.search, 302);   // never poison the bucket

      const md = { contentType: from.headers.get('content-type') || MIME[extOf(key)] || 'application/octet-stream',
                   cacheControl: `public, max-age=${TtlSeconds}`,
                   contentDisposition: null };
      if (range) {
        // store the whole object instead of a fragment; replay the range for this one response
        const full = await fetch(ORIGIN + path, { cf: { cacheTtl: 0 } });
        if (full.ok) {
          const buf = await full.arrayBuffer();
          await env.ASSETS.put(key, buf, { httpMetadata: md });
          return new Response(buf, { status: 206, headers: { 'content-type': md.contentType, 'content-range': full.headers.get('content-range') || `bytes 0-${buf.byteLength - 1}/${buf.byteLength}`, 'accept-ranges': 'bytes', 'cache-control': md.cacheControl, 'x-sp': 'range-pull' } });
        }
      }
      const buf = await from.arrayBuffer();
      await env.ASSETS.put(key, buf, { httpMetadata: md });
      return new Response(buf, { status: 200, headers: { 'content-type': md.contentType, 'content-length': String(buf.byteLength), 'accept-ranges': 'bytes', 'cache-control': md.cacheControl, 'access-control-allow-origin': '*', 'x-sp': 'pull' } });
    }

    // 3) bucket hit
    const body = obj.body ? obj.body : null;
    const head = {
      'content-type': obj.httpMetadata?.contentType || MIME[extOf(key)] || 'application/octet-stream',
      'cache-control': obj.httpMetadata?.cacheControl || `public, max-age=${TtlSeconds}`,
      'accept-ranges': 'bytes', 'access-control-allow-origin': '*', 'x-sp': 'r2',
    };
    if (obj.writeKind === 'http' && obj.range) head['content-range'] = obj.range;
    if (obj.size) head['content-length'] = String(obj.size);
    return new Response(req.method === 'HEAD' ? null : body, { status: range ? 206 : 200, headers: head });
  },
};
