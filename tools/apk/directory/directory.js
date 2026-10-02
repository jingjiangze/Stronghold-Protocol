// directory.js — room directory / signaling for the Stronghold shell (个人非盈利项目).
// 房主 APK 把 {房号 → 本机 ZeroTier/IPv6/局域网 地址} 注册到这里并每 60s 心跳；
// 玩家 APK / 网页只凭 4 位房号查询。同时充当 WebRTC 打洞的信令中继（offer/answer）。
// 无外部依赖；只监听 127.0.0.1，公网访问走 Cloudflare 隧道。
import http from 'node:http';

const PORT = Number(process.env.PORT || 8793);
const HOST = process.env.HOST || '127.0.0.1';
const ROOM_TTL = 2 * 60 * 60 * 1000;      // rooms live 2h, refreshed by host heartbeats
const SIGNAL_TTL = 120 * 1000;            // SDP entries live 2 minutes
const CODE_RE = /^[A-Z]{4}$/;

/** code → { zt, v6, lan, name, mode, ts } */
const rooms = new Map();
/** code → { offer, answer, ts } */
const signals = new Map();
/** ip → { minute, count } rate limiter for POSTs */
const hits = new Map();

function sweep() {
  const now = Date.now();
  for (const [k, v] of rooms) if (now - v.ts > ROOM_TTL) rooms.delete(k);
  for (const [k, v] of signals) if (now - v.ts > SIGNAL_TTL) signals.delete(k);
  for (const [k, v] of hits) if (v.minute !== Math.floor(now / 60000)) hits.delete(k);
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

    json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    json(res, 400, { ok: false, error: String(e.message || e).slice(0, 120) });
  }
});

server.listen(PORT, HOST, () => console.log(`directory on http://${HOST}:${PORT}`));
