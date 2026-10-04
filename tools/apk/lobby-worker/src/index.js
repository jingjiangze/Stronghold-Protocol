// src/index.js — sp-lobby-board thin Cloudflare adapter: Module Worker + ONE Durable Object.
//
// ZERO EGRESS: this file never fetches a remote URL. Its only I/O is (a) the incoming request and
// (b) `env.BOARD` — the singleton Durable Object stub (`idFromName('board')`) that owns the board
// state. All board logic (validation / limits / TTL / tokens) lives in the dependency-free
// ./board.js pure core, which is exactly what `node --test` exercises.
//
// ROUTES
//   OPTIONS *              CORS preflight (204)
//   GET  /api/rooms        rainya-shaped board: { ok, now, ttlSec:600, rooms:[...] }
//   POST /api/rooms        JSON { code, serverId, serverName, note?, url? } -> 201 { ok, added, token }
//   DELETE /api/rooms?code=&serverId=      header X-Token: <token>          -> 200 { ok, removed }
//   GET  /api/health       { ok:true, now } — stateless liveness probe for deploy self-check
// Every response carries `cache-control: no-store` and the CORS headers below.
// Error codes -> HTTP status: BAD_JSON/BAD_CODE/BAD_SERVER/BAD_URL 400, FORBIDDEN 403,
// NOT_FOUND 404, METHOD_NOT_ALLOWED 405, RATE_LIMITED/DEBOUNCED/LIMIT_REACHED 429, INTERNAL 500.

import { createBoard } from './board.js';

/** The single DO instance name — one board for every caller (singleton semantics). */
const BOARD_OBJECT_NAME = 'board';
/** Max accepted JSON body size for POST (bytes of the raw request text). */
const BODY_MAX = 8 * 1024;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'Content-Type,X-Token',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Attach the CORS + no-store headers every response must carry (incl. error responses). */
function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}

function statusFor(error) {
  switch (error) {
    case 'BAD_JSON':
    case 'BAD_CODE':
    case 'BAD_SERVER':
    case 'BAD_URL':
      return 400;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'METHOD_NOT_ALLOWED':
      return 405;
    case 'RATE_LIMITED':
    case 'DEBOUNCED':
    case 'LIMIT_REACHED':
      return 429;
    default:
      return 500;
  }
}

async function readJsonBody(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false };
  }
  if (text.length > BODY_MAX) return { ok: false };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * The Durable Object class: a thin shell holding board state in DO storage (single instance).
 * `state.storage` is the Durable Object storage API (KV-style get/put/delete/list) — NOT the
 * Workers KV product — and the DO input gate serializes requests, so read-modify-write is safe.
 */
export class Board {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    const storage = state.storage;
    this.core = createBoard({
      state: {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        delete: (key) => storage.delete(key),
        list: () => storage.list(),
      },
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = (request.method || 'GET').toUpperCase();
    try {
      if (url.pathname === '/api/rooms' && method === 'GET') {
        return json(await this.core.list());
      }
      if (url.pathname === '/api/rooms' && method === 'POST') {
        const body = await readJsonBody(request);
        if (!body.ok) return json({ ok: false, error: 'BAD_JSON' }, 400);
        const ip = request.headers.get('x-client-ip') || '';
        const result = await this.core.add({ ...body.value, ip }); // header IP wins over any body field
        return json(result, result.ok ? 201 : statusFor(result.error));
      }
      if (url.pathname === '/api/rooms' && method === 'DELETE') {
        const result = await this.core.remove({
          code: url.searchParams.get('code') || '',
          serverId: url.searchParams.get('serverId') || '',
          token: request.headers.get('x-token') || '',
        });
        return json(result, result.ok ? 200 : statusFor(result.error));
      }
      return json({ ok: false, error: 'NOT_FOUND' }, 404);
    } catch (error) {
      return json({ ok: false, error: 'INTERNAL', message: String((error && error.message) || error) }, 500);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = (request.method || 'GET').toUpperCase();
    try {
      if (method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));

      if (url.pathname === '/api/health') {
        if (method !== 'GET') return withCors(json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405));
        return withCors(json({ ok: true, now: Date.now() })); // stateless — no DO hop
      }

      if (url.pathname !== '/api/rooms') {
        return withCors(json({ ok: false, error: 'NOT_FOUND' }, 404));
      }
      if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
        return withCors(json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405));
      }

      // Forward to the singleton DO; the DO returns the final payload, we add the shared headers.
      const headers = new Headers();
      headers.set('x-client-ip', request.headers.get('CF-Connecting-IP') || '');
      const token = request.headers.get('X-Token');
      if (token) headers.set('x-token', token);
      let body;
      if (method === 'POST') {
        headers.set('content-type', 'application/json');
        body = await request.text();
      }
      const stub = env.BOARD.get(env.BOARD.idFromName(BOARD_OBJECT_NAME));
      const internal = new Request(`https://board.internal${url.pathname}${url.search}`, { method, headers, body });
      return withCors(await stub.fetch(internal));
    } catch (error) {
      return withCors(json({ ok: false, error: 'INTERNAL', message: String((error && error.message) || error) }, 500));
    }
  },
};
