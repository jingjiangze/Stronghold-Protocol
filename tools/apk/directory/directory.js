// directory.js — room directory / signaling for the Stronghold shell (个人非盈利项目).
// 房主 APK 把 {房号 → 本机 ZeroTier/IPv6/局域网 地址} 注册到这里并每 60s 心跳；
// 玩家 APK / 网页只凭 4 位房号查询。同时充当 WebRTC 打洞的信令中继（offer/answer）。
// 无外部依赖；只监听 127.0.0.1，公网访问走 Cloudflare 隧道。
//
// Room Presence plane (v2.7.2, 发现 ≠ 寻址): Node 服务器把「本机有可加入的房间」登记为
// {code → serverId}。目录只存 serverId——绝无 URL / 玩家 / IP / 房间状态；注册需
// SERVER_TOKEN（env，未配置则 presence 整体关闭），查询限速独立于手机房主端点。
import http from 'node:http';

const PORT = Number(process.env.PORT || 8793);
const HOST = process.env.HOST || '127.0.0.1';
const ROOM_TTL = 2 * 60 * 60 * 1000;      // rooms live 2h, refreshed by host heartbeats
const SIGNAL_TTL = 120 * 1000;            // SDP entries live 2 minutes
const CODE_RE = /^[A-HJ-NP-Z]{4}$/;       // upstream alphabet: no I/O (lobby.js CODE_ALPHABET)
const SERVER_TOKEN = String(process.env.SERVER_TOKEN || '');
const PRESENCE_TTL = 90 * 1000;           // presence entries expire without a 30s heartbeat
const PRESENCE_MAX = 512;                 // safety cap: entries across all servers
const PRESENCE_GET_RATE = 20;             // resolve queries per IP per minute (small code space)

/** code → { serverId, ts } — "this code has a joinable lobby room on serverId" */
const presence = new Map();
/** code → { serverId, lastSeen, observers:Set<ipKey> } — client-witnessed rooms (L0 layer) */
const observed = new Map();
/** code → { serverId, ts } for phone hosts (unchanged) */
const rooms = new Map();
/** code → { offer, answer, ts } */
const signals = new Map();
/** ip → { minute, count } rate limiter for POSTs */
const hits = new Map();
/** ip → { minute, count } rate limiter for presence GETs */
const gets = new Map();
const OBSERVE_TTL = 120 * 1000;           // client observations are short-lived (30s renewals)
const OBSERVE_REPLAY_MS = 10 * 60 * 1000; // report timestamps older than this are dropped

function sweep() {
  const now = Date.now();
  for (const [k, v] of rooms) if (now - v.ts > ROOM_TTL) rooms.delete(k);
  for (const [k, v] of signals) if (now - v.ts > SIGNAL_TTL) signals.delete(k);
  for (const [k, v] of presence) if (now - v.ts > PRESENCE_TTL) presence.delete(k);
  for (const [k, v] of observed) if (now - v.lastSeen > OBSERVE_TTL) observed.delete(k);
  for (const [k, v] of hits) if (v.minute !== Math.floor(now / 60000)) hits.delete(k);
  for (const [k, v] of gets) if (v.minute !== Math.floor(now / 60000)) gets.delete(k);
}
setInterval(sweep, 30 * 1000).unref();

function rateLimited(ip) {
  const minute = Math.floor(Date.now() / 60000);
  let e = hits.get(ip);
  if (!e || e.minute !== minute) {
    e = { minute, count: 0 };
    hits.set(ip, e);
  }
  return ++e.count > 30;
}

function getLimited(ip) {
  const minute = Math.floor(Date.now() / 60000);
  let e = gets.get(ip);
  if (!e || e.minute !== minute) {
    e = { minute, count: 0 };
    gets.set(ip, e);
  }
  return ++e.count > PRESENCE_GET_RATE;
}

function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    // GET /rooms/<code> — player lookup
    if (req.method === 'GET' && parts[0] === 'rooms' && parts[1] && !parts[2]) {
      const code = parts[1].toUpperCase();
      const rec = rooms.get(code);
      if (!rec || Date.now() - rec.ts > ROOM_TTL) {
        json(res, 404, { ok: false, error: 'room not found' });
        return;
      }
      json(res, 200, {
        ok: true,
        code,
        name: rec.name,
        mode: rec.mode,
        addresses: { zt: rec.zt || '', v6: rec.v6 || '', lan: rec.lan || '' },
        ageMs: Date.now() - rec.ts,
      });
      return;
    }

    if (req.method === 'POST') {
      const ip = req.socket.remoteAddress || '';
      if (rateLimited(ip)) { json(res, 429, { ok: false, error: 'rate limited' }); return; }

      // POST /rooms — host registers/refreshes a room
      if (parts[0] === 'rooms' && !parts[1]) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const code = String(body.code || '').toUpperCase();
        if (!CODE_RE.test(code)) { json(res, 400, { ok: false, error: 'bad code' }); return; }
        rooms.set(code, {
          zt: String(body.zt || '').slice(0, 120),
          v6: String(body.v6 || '').slice(0, 120),
          lan: String(body.lan || '').slice(0, 120),
          name: String(body.name || '').slice(0, 24),
          mode: String(body.mode || '').slice(0, 12),
          ts: Date.now(),
        });
        json(res, 200, { ok: true, code, ttlMs: ROOM_TTL });
        return;
      }

      // POST /rooms/<code>/heartbeat — keepalive
      if (parts[0] === 'rooms' && parts[1] && parts[2] === 'heartbeat') {
        const rec = rooms.get(parts[1].toUpperCase());
        if (rec) rec.ts = Date.now();
        json(res, 200, { ok: !!rec });
        return;
      }

      // POST /signal/<code> — WebRTC signaling relay {from:'client',offer} / {from:'host',answer}
      if (parts[0] === 'signal' && parts[1]) {
        const code = parts[1].toUpperCase();
        const body = JSON.parse((await readBody(req)) || '{}');
        const sdp = String(body.offer || body.answer || '').slice(0, 16384);
        if (!sdp) { json(res, 400, { ok: false, error: 'missing sdp' }); return; }
        const cur = signals.get(code) || {};
        if (body.from === 'client') signals.set(code, { offer: sdp, answer: cur.answer || '', ts: Date.now() });
        else signals.set(code, { offer: cur.offer || '', answer: sdp, ts: Date.now() });
        json(res, 200, { ok: true });
        return;
      }
    }

    // GET /signal/<code> — poll for the other side's SDP
    if (req.method === 'GET' && parts[0] === 'signal' && parts[1]) {
      const sig = signals.get(parts[1].toUpperCase()) || {};
      json(res, 200, { ok: true, offer: sig.offer || '', answer: sig.answer || '' });
      return;
    }

    // ---- Room Presence plane (discovery only: code → serverId; the target server decides joinability)
    // GET /presence/<code> — which servers (by id) currently advertise a joinable room with this
    // code. Merges BOTH discovery layers: server self-report (presence) + client witnesses
    // (observed). A code may legitimately exist on several servers.
    if (req.method === 'GET' && parts[0] === 'presence' && parts[1] && !parts[2]) {
      const ip = req.socket.remoteAddress || '';
      if (getLimited(ip)) { json(res, 429, { ok: false, error: 'rate limited' }); return; }
      const code = parts[1].toUpperCase();
      if (!CODE_RE.test(code)) { json(res, 400, { ok: false, error: 'bad code' }); return; }
      const now = Date.now();
      const servers = [];
      const p = presence.get(code);
      if (p && now - p.ts <= PRESENCE_TTL) {
        servers.push({ serverId: p.serverId, observedAt: p.ts, source: 'server' });
      }
      const o = observed.get(code);
      if (o && now - o.lastSeen <= OBSERVE_TTL) {
        servers.push({ serverId: o.serverId, observedAt: o.lastSeen, observers: o.observers.size, source: 'client' });
      }
      if (!servers.length) { json(res, 404, { ok: false, error: 'not found' }); return; }
      servers.sort((a, b) => b.observedAt - a.observedAt); // freshest first
      json(res, 200, { ok: true, code, servers });
      return;
    }

    if (req.method === 'POST') {
      const ip = req.socket.remoteAddress || '';
      // server announce/renew/remove share the POST rate limit (30/min is plenty for 30s heartbeats)
      if (rateLimited(ip)) { json(res, 429, { ok: false, error: 'rate limited' }); return; }

      // POST /presence/<code> — a server registers/renews {code, serverId}; needs SERVER_TOKEN
      if (parts[0] === 'presence' && parts[1] && !parts[2]) {
        if (!SERVER_TOKEN) { json(res, 503, { ok: false, error: 'presence disabled' }); return; }
        if ((req.headers['x-server-token'] || '') !== SERVER_TOKEN) {
          json(res, 403, { ok: false, error: 'unauthorized' });
          return;
        }
        const body = JSON.parse((await readBody(req)) || '{}');
        const code = String(body.code || '').toUpperCase();
        const serverId = String(body.serverId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
        if (!CODE_RE.test(code) || !serverId) { json(res, 400, { ok: false, error: 'bad code or serverId' }); return; }
        if (presence.size >= PRESENCE_MAX && !presence.has(code)) {
          json(res, 503, { ok: false, error: 'presence full' });
          return;
        }
        presence.set(code, { serverId, ts: Date.now() });
        json(res, 200, { ok: true, ttlMs: PRESENCE_TTL });
        return;
      }

      // POST /presence/<code>/remove — room gone (started / disposed / shutdown); needs SERVER_TOKEN
      if (parts[0] === 'presence' && parts[1] && parts[2] === 'remove') {
        if (!SERVER_TOKEN) { json(res, 503, { ok: false, error: 'presence disabled' }); return; }
        if ((req.headers['x-server-token'] || '') !== SERVER_TOKEN) {
          json(res, 403, { ok: false, error: 'unauthorized' });
          return;
        }
        presence.delete(parts[1].toUpperCase());
        json(res, 200, { ok: true });
        return;
      }

      // POST /observe — client room witness (L0 discovery): "I am in a joinable room CODE on
      // serverId X". No token: clients cannot hold one. Guards are structural — the id must be a
      // known server shape, replay-stamped, one entry per (code, client ip), short TTL — and the
      // target server's room.join stays the final authority, so a false report never joins a
      // wrong room; it just wastes a lookup.
      if (parts[0] === 'observe' && !parts[1]) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const code = String(body.code || '').toUpperCase();
        const serverId = String(body.serverId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
        const t = Number(body.t) || 0;
        const joinable = body.joinable !== false;
        if (!CODE_RE.test(code) || !serverId) { json(res, 400, { ok: false, error: 'bad code or serverId' }); return; }
        if (Math.abs(Date.now() - t) > OBSERVE_REPLAY_MS) { json(res, 400, { ok: false, error: 'stale report' }); return; }
        if (observed.size >= PRESENCE_MAX && !observed.has(code)) {
          json(res, 503, { ok: false, error: 'observe full' });
          return;
        }
        if (!joinable) {
          const cur = observed.get(code);
          if (cur && cur.serverId === serverId) observed.delete(code); // this observer says it's gone
          json(res, 200, { ok: true });
          return;
        }
        const prev = observed.get(code);
        const observers = prev && prev.serverId === serverId ? prev.observers : new Set();
        observers.add(ip); // one observer = one vote, per IP per code
        observed.set(code, { serverId, lastSeen: Date.now(), observers });
        json(res, 200, { ok: true, ttlMs: OBSERVE_TTL });
        return;
      }
    }

    json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    json(res, 400, { ok: false, error: String(e.message || e).slice(0, 120) });
  }
});

server.listen(PORT, HOST, () => console.log(`directory on http://${HOST}:${PORT}`));
