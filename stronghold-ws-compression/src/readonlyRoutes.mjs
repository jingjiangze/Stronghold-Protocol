// readonlyRoutes.mjs — the read-only HTTP surface, so a tool can read the transport state WITHOUT
// holding a WebSocket session.
//
// Why this exists: the only way to see "is compression actually on, and is it working" used to be to
// open a socket and measure bytes. Anything that is not a game client — a status page, a lobby, a mod
// manager — then had to hold a session it does not need. A read-only route costs one HTTP request and
// no session.
//
// The conventions are copied deliberately from Stronghold Protocol Forge's workshop `routes` field
// (`docs/WORKSHOP.md` §1.9.2), because a second, different set of rules for the same idea is a second
// thing to get wrong:
//
//   * GET and HEAD only — every other verb is 405 with `Allow: GET, HEAD`
//   * EXACT path match. No rewriting, no prefix matching, no directory listing. Traversal is not a
//     boundary that has to be checked; there is simply no target to traverse to.
//   * JSON only. Never JS or HTML — that is the code-execution surface, this is the data surface.
//   * `cache` is one of `no-cache` (default) / `no-store` / `public`.
//
// Nothing here mutates: there is no route that changes the mode, because a read-only interface that
// can be talked into a write is not read-only. Changing the mode is a restart with a different value.

/** The route table. Each `body` is a thunk so a snapshot is taken per request, not at load. */
export const READONLY_ROUTES = Object.freeze([
  Object.freeze({
    path: '/ws-compression/status',
    cache: 'no-store',
    describe: 'the active mode, the option set that will reach the wire, and the compressible types',
  }),
  Object.freeze({
    path: '/ws-compression/stats',
    cache: 'no-store',
    describe: 'transport counters since start: frames sent/skipped, bytes, sockets terminated',
  }),
]);

/** `Cache-Control` for a declared `cache` value — the same three-way mapping as the Forge routes. */
export function cacheControlFor(cache = 'no-cache') {
  if (cache === 'no-store') return 'no-store';
  if (cache === 'public') return 'public, max-age=86400';
  if (cache === 'no-cache') return 'no-cache';
  throw new TypeError(`cache must be no-cache, no-store or public (got ${JSON.stringify(cache)})`);
}

/**
 * Build the request handler.
 *
 * @param {{
 *   mode: string,
 *   sockets?: () => number,
 *   stats?: { toJSON: () => object } | null,
 *   compressibleTypes?: Iterable<string>,
 *   describe?: (mode: string) => object,
 *   startedAt?: number,
 * }} deps everything is injected, so this module never imports the server or the game
 * @returns {(req: { method?: string, url?: string }) => { status: number, headers: Record<string,string>, body: string } | null}
 *   `null` means "not mine" — the caller falls through to its own routing, which is how a declared
 *   path can be looked up before the core static mount without this module knowing that mount exists.
 */
export function createReadonlyRouter({
  mode,
  sockets = () => 0,
  stats = null,
  compressibleTypes = [],
  describe,
  startedAt = Date.now(),
} = {}) {
  const table = new Map(READONLY_ROUTES.map((r) => [r.path, r]));
  const describeMode = describe ?? (() => ({ mode }));

  return function handle(req) {
    const method = String(req?.method ?? 'GET').toUpperCase();
    const path = String(req?.url ?? '').split('?')[0];
    const route = table.get(path);
    if (!route) return null; // not mine: let the caller route it

    if (method !== 'GET' && method !== 'HEAD') {
      return { status: 405, headers: { allow: 'GET, HEAD' }, body: '' };
    }

    const body = JSON.stringify(route.path === '/ws-compression/status'
      ? {
        ...describeMode(mode),
        compressibleTypes: [...compressibleTypes],
        sockets: sockets(),
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      }
      : {
        stats: stats ? stats.toJSON() : null,
        sockets: sockets(),
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      }, null, 2);

    return {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': cacheControlFor(route.cache),
      },
      body: method === 'HEAD' ? '' : body,
    };
  };
}
