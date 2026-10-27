// overlay-mod-route.test.mjs — a real GET /mod must answer 200 HTML (2026-10-27 审计 P1).
//
// WHY: everything else about /mod was asserted by reading source strings. The device bug
// "点 MOD 管理器没页面" was a *missing/late* overlay, i.e. the exact failure a string test cannot
// see. This one installs the overlay onto an in-memory http server (the same way overlay-loader
// does) and asks it for the page.
//
//   node --test tools/apk/overlay-mod-route.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const OVERLAY = path.join(here, 'overlay', 'sp-modmgr.mjs');

/** The upstream modules the overlay imports live in the repo's vendored server/ tree. */
const UPSTREAM_DIR = path.join(repo, 'server');

function mkResponse() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = {};
  res.body = '';
  res.writableEnded = false;
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
  res.getHeader = (k) => res.headers[String(k).toLowerCase()];
  res.writeHead = (code, headers) => {
    res.statusCode = code;
    for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
    return res;
  };
  res.write = (chunk) => { res.body += chunk == null ? '' : String(chunk); return true; };
  res.end = (chunk) => {
    if (chunk != null) res.body += String(chunk);
    res.writableEnded = true;
    res.emit('finish');
    return res;
  };
  res.removeHeader = () => {};
  return res;
}

function mkRequest(urlPath) {
  const req = new EventEmitter();
  req.url = urlPath;
  req.method = 'GET';
  req.headers = { host: '127.0.0.1:8080' };
  req.socket = { remoteAddress: '127.0.0.1' };
  req.connection = req.socket;
  return req;
}

async function get(urlPath) {
  const mod = await import(pathToFileURL(OVERLAY).href + '?t=' + Date.now());
  const http = new EventEmitter();
  const ctx = {
    server: { server: http, packs: null, lobby: null },
    upstreamDir: UPSTREAM_DIR,
    log: () => {},
  };
  mod.install(ctx);
  assert.ok(http.listenerCount('request') >= 1, 'install() must hook the http server');

  const req = mkRequest(urlPath);
  const res = mkResponse();
  http.emit('request', req, res);
  // handle() awaits the module imports before answering
  const deadline = Date.now() + 20000;
  while (!res.writableEnded && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return res;
}

test('GET /mod answers 200 with the manager page', async () => {
  const res = await get('/mod');
  assert.equal(res.statusCode, 200, 'body: ' + res.body.slice(0, 200));
  assert.match(String(res.getHeader('content-type') || res.headers['content-type'] || ''), /text\/html/);
  assert.match(res.body, /MOD 管理器/, 'the page must be the manager, not a placeholder');
});

test('GET /mod/ (trailing slash) answers the same page', async () => {
  const res = await get('/mod/');
  assert.equal(res.statusCode, 200, 'body: ' + res.body.slice(0, 200));
  assert.match(res.body, /MOD 管理器/);
});

test('POST /mod is refused (405) — the page route is read-only', async () => {
  const mod = await import(pathToFileURL(OVERLAY).href + '?t=p' + Date.now());
  const http = new EventEmitter();
  mod.install({ server: { server: http, packs: null, lobby: null }, upstreamDir: UPSTREAM_DIR, log: () => {} });
  const req = mkRequest('/mod');
  req.method = 'POST';
  const res = mkResponse();
  http.emit('request', req, res);
  const deadline = Date.now() + 20000;
  while (!res.writableEnded && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.equal(res.statusCode, 405, 'body: ' + res.body.slice(0, 200));
});
