// overlay-sp-lobby.test.mjs — tests for tools/apk/overlay/sp-lobby.mjs (B: 服务端持有房间牌发布权).
//
//   node --test tools/apk/overlay-sp-lobby.test.mjs
//
// 不联网：所有出网请求都走注入的 fetch；控制面用真 http 服务器（127.0.0.1）+ 真 fetch 打进去，
// 房间状态用假 lobby（Map）。断言对照模块头部的四条安全不变量。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  resolveHttpServer,
  overlayApi,
  id,
  install,
  createPublisher,
  boardUrlOf,
  liveFieldsOf,
  publishBodyOf,
  readRoomFrom,
  boardErrorOf,
  patchHealthzCors,
  ROUTE_PUBLISH,
  ROUTE_STATUS,
  CODE_RE,
  PATCH_INTERVAL_MS,
} from './overlay/sp-lobby.mjs';

/** 假 lobby：rooms 是 Map，room 记录照上游形状（seats / match / mode）。 */
function mkLobby(rooms) {
  return { rooms: new Map((rooms || []).map((r) => [r.code, r])) };
}
const roomOf = (code, seats, extra) => Object.assign({ code: code, seats: seats, mode: 'coop' }, extra || {});
const seat = (filled) => (filled ? { left: false, isBot: false } : null);

/** 记账用的 fetch 桩：按 (method, path) 回预设 JSON，并记录每次调用。 */
function mkFetch(replies) {
  const calls = [];
  const impl = (url, init) => {
    const u = new URL(String(url));
    const rec = { url: String(url), path: u.pathname, method: (init && init.method) || 'GET',
      headers: (init && init.headers) || {}, body: init && init.body ? JSON.parse(init.body) : null };
    calls.push(rec);
    const key = rec.method + ' ' + rec.path;
    const r = (replies && replies[key]) || replies && replies['*'] || { ok: true };
    return Promise.resolve({ json: () => Promise.resolve(r) });
  };
  return { impl: impl, calls: calls };
}

/** 手动定时器：不自动跑，测试自己 fire。 */
function mkTimers() {
  const list = [];
  return {
    list: list,
    setIntervalFn: (fn, ms) => { const t = { fn: fn, ms: ms }; list.push(t); return t; },
    clearIntervalFn: (t) => { const i = list.indexOf(t); if (i >= 0) list.splice(i, 1); },
  };
}

// ---------------------------------------------------------------- 纯函数

test('boardUrlOf：只允许 https 且拒绝回环/私有/保留主机（拨号前就拦）', () => {
  assert.equal(boardUrlOf('https://sp-lobby.jiangjiangze.icu', '/api/rooms'),
    'https://sp-lobby.jiangjiangze.icu/api/rooms');
  assert.throws(() => boardUrlOf('http://sp-lobby.jiangjiangze.icu', '/api/rooms'), /https/);
  for (const bad of ['https://127.0.0.1', 'https://localhost', 'https://10.0.0.5', 'https://192.168.1.7',
    'https://169.254.1.1', 'https://[::1]', 'https://127.1', 'https://0177.0.0.1']) {
    assert.throws(() => boardUrlOf(bad, '/api/rooms'), /loopback\/private\/reserved|https/, bad);
  }
});

test('liveFieldsOf：席位/对局/模式 → 直播四字段（board 只认这四个键）', () => {
  assert.deepEqual(liveFieldsOf(roomOf('ABCD', [seat(1), seat(0), null, null])),
    { mode: 'coop', status: 'waiting', occupied: 1, capacity: 4 });
  assert.deepEqual(liveFieldsOf(roomOf('ABCD', [seat(1), seat(1), seat(1), seat(1)])),
    { mode: 'coop', status: 'full', occupied: 4, capacity: 4 });
  assert.deepEqual(liveFieldsOf(roomOf('ABCD', [seat(1), seat(1)], { inMatch: true, match: {}, mode: 'solo' })),
    { mode: 'solo', status: 'playing', occupied: 2, capacity: 2 });
  assert.deepEqual(liveFieldsOf(null), { mode: 'coop', status: 'waiting', occupied: 0, capacity: 4 });
});

test('publishBodyOf：首发即带全（身份 + 直播字段 + 页面表单的加法字段）', () => {
  const b = publishBodyOf({ code: 'ABCD', serverId: 'box.example.com', serverName: '盒子',
    url: 'https://box.example.com/', difficulty: 'NORMAL', room: roomOf('ABCD', [seat(1), null, null, null]) });
  assert.deepEqual(b, { code: 'ABCD', serverId: 'box.example.com', serverName: '盒子',
    url: 'https://box.example.com/', difficulty: 'NORMAL', mode: 'coop', status: 'waiting',
    occupied: 1, capacity: 4 });
});

test('readRoomFrom / boardErrorOf：房间取不到返回 null；错误码只在 ok!==true 时读', () => {
  const lobby = mkLobby([roomOf('ABCD', [seat(1)])]);
  assert.ok(readRoomFrom(lobby, 'ABCD'));
  assert.equal(readRoomFrom(lobby, 'ZZZZ'), null);
  assert.equal(readRoomFrom(null, 'ABCD'), null);
  assert.equal(boardErrorOf({ ok: true }), '');
  assert.equal(boardErrorOf({ ok: false, error: 'FORBIDDEN' }), 'FORBIDDEN');
});

// ---------------------------------------------------------------- 发布生命周期

test('publish→tick→房间消失：POST 带全字段、60s PATCH 用同一 token、房间没了立刻 DELETE', async () => {
  const lobby = mkLobby([roomOf('ABCD', [seat(1), null, null, null])]);
  const f = mkFetch({ 'POST /api/rooms': { ok: true, token: 'tok-1' }, 'PATCH /api/rooms': { ok: true },
    'DELETE /api/rooms': { ok: true } });
  const t = mkTimers();
  const p = createPublisher({ fetchImpl: f.impl, readRoom: (c) => readRoomFrom(lobby, c),
    setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn });

  const r = await p.publish({ code: 'abcd', serverId: 'box.example.com' });
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].method, 'POST');
  assert.deepEqual(f.calls[0].body, { code: 'ABCD', serverId: 'box.example.com', mode: 'coop',
    status: 'waiting', occupied: 1, capacity: 4 });
  assert.equal(t.list.length, 1, '发布后应起一个周期表');
  assert.equal(t.list[0].ms, PATCH_INTERVAL_MS);

  lobby.rooms.get('ABCD').seats[1] = seat(1); // 第二个人进来
  const r2 = await p.tick();
  assert.equal(r2.ok, true);
  const patch = f.calls.filter((c) => c.method === 'PATCH');
  assert.equal(patch.length, 1);
  assert.equal(patch[0].headers['X-Token'], 'tok-1', 'PATCH 必须带服务端持有的 token');
  assert.equal(patch[0].body.occupied, 2);
  assert.ok(!('note' in patch[0].body), '服务端不知道网页备注时不许带 note');

  lobby.rooms.delete('ABCD'); // 房间关了
  const r3 = await p.tick();
  assert.equal(r3.removed, true);
  assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 1, '房间没了要立刻 DELETE（治幽灵房）');
  assert.equal(p.status().published, false);
  assert.equal(t.list.length, 0, 'DELETE 之后停表');
});

test('FORBIDDEN / NOT_FOUND：清掉持有权并停表（不再每 60s 白打）', async () => {
  for (const code of ['FORBIDDEN', 'NOT_FOUND']) {
    const lobby = mkLobby([roomOf('ABCD', [seat(1)])]);
    const f = mkFetch({ 'POST /api/rooms': { ok: true, token: 'tok-1' }, 'PATCH /api/rooms': { ok: false, error: code } });
    const t = mkTimers();
    const p = createPublisher({ fetchImpl: f.impl, readRoom: (c) => readRoomFrom(lobby, c),
      setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn });
    await p.publish({ code: 'ABCD', serverId: 'srv' });
    const r = await p.tick();
    assert.equal(r.ok, false);
    assert.equal(r.error, code);
    assert.equal(p.status().published, false, `${code} 之后不再持有发布权`);
    assert.equal(t.list.length, 0, `${code} 之后停表`);
    const before = f.calls.length;
    const again = await p.tick();
    assert.equal(again.error, 'skipped');
    assert.equal(f.calls.length, before, '停手之后一拍都不许再发');
  }
});

test('publish 的入参护栏：房号非法 / 没有 serverId / 房间不存在 → 不发请求', async () => {
  const lobby = mkLobby([]);
  const f = mkFetch({ '*': { ok: true, token: 'x' } });
  const p = createPublisher({ fetchImpl: f.impl, readRoom: (c) => readRoomFrom(lobby, c) });
  assert.equal((await p.publish({ code: 'IIII', serverId: 'srv' })).error, 'BAD_CODE');
  assert.equal((await p.publish({ code: 'ABCD', serverId: '' })).error, 'NO_SERVER_ID');
  assert.equal((await p.publish({ code: 'ABCD', serverId: 'srv' })).error, 'ROOM_NOT_FOUND');
  assert.equal(f.calls.length, 0, '护栏拦下的请求绝不出网');
  assert.equal(CODE_RE.test('ABCD'), true);
});

test('unpublish：带 token DELETE，随后状态归零', async () => {
  const lobby = mkLobby([roomOf('ABCD', [seat(1)])]);
  const f = mkFetch({ 'POST /api/rooms': { ok: true, token: 'tok-9' }, 'DELETE /api/rooms': { ok: true } });
  const t = mkTimers();
  const p = createPublisher({ fetchImpl: f.impl, readRoom: (c) => readRoomFrom(lobby, c),
    setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn });
  await p.publish({ code: 'ABCD', serverId: 'srv' });
  const r = await p.unpublish();
  assert.equal(r.ok, true);
  const del = f.calls.filter((c) => c.method === 'DELETE');
  assert.equal(del.length, 1);
  assert.equal(del[0].headers['X-Token'], 'tok-9');
  assert.equal(p.status().published, false);
  assert.equal(t.list.length, 0);
});

// ---------------------------------------------------------------- 控制面与 /healthz

/** 真 http 服务器 + 假 lobby 记录，装上 overlay 后打进去。**注入假 fetch，测试绝不出网**。 */
async function mkInstalled(replies) {
  const lobby = mkLobby([roomOf('ABCD', [seat(1), null, null, null])]);
  const seen = [];
  const f = mkFetch(replies || { 'POST /api/rooms': { ok: true, token: 'tok-live' }, 'PATCH /api/rooms': { ok: true },
    'DELETE /api/rooms': { ok: true } });
  const stock = (req, res) => {
    seen.push(req.url);
    if (String(req.url).split('?')[0] === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: 1, humans: 2, uptime: 1 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('stock');
  };
  const server = http.createServer(stock);
  server.lobby = lobby;
  install({ server: server, log: () => {}, fetchImpl: f.impl });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return { server: server, base: base, lobby: lobby, seen: seen, calls: f.calls,
    close: () => new Promise((r) => server.close(r)) };
}

test('控制面：缺 Origin / 非回环 → 403；带回环 Origin 才应答', async () => {
  const w = await mkInstalled();
  try {
    const noOrigin = await fetch(w.base + ROUTE_STATUS);
    assert.equal(noOrigin.status, 403, '缺 Origin 必须 403');
    const withOrigin = await fetch(w.base + ROUTE_STATUS, { headers: { origin: w.base } });
    assert.equal(withOrigin.status, 200);
    const st = await withOrigin.json();
    assert.equal(st.ok, true);
    assert.equal(st.published, false);
    assert.ok(!('token' in st), '状态里绝不许回显 token');
    // 非控制路由照旧落到 stock 监听器
    const other = await fetch(w.base + '/whatever');
    assert.equal(await other.text(), 'stock');
  } finally {
    await w.close();
  }
});

test('发布路由：POST 走真服务端发布（注入假 fetch，绝不出网）', async () => {
  const w = await mkInstalled();
  try {
    const r = await fetch(w.base + ROUTE_PUBLISH, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: w.base },
      body: JSON.stringify({ code: 'ABCD', serverId: 'box.example.com' }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, published: true, code: 'ABCD' });
    assert.equal(w.calls[0].method, 'POST', '服务端自己去 POST 房间牌');
    assert.deepEqual(w.calls[0].body, { code: 'ABCD', serverId: 'box.example.com', mode: 'coop',
      status: 'waiting', occupied: 1, capacity: 4 }, '首发即带全直播字段');
    const st = await (await fetch(w.base + ROUTE_STATUS, { headers: { origin: w.base } })).json();
    assert.equal(st.published, true);
    assert.equal(st.code, 'ABCD');
    assert.ok(!('token' in st), '状态里绝不许回显 token');

    // 取消公开 → DELETE（带服务端 token）→ 状态归零
    const off = await fetch(w.base + ROUTE_PUBLISH, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: w.base },
      body: JSON.stringify({ on: false }),
    });
    assert.equal(off.status, 200);
    assert.equal((await off.json()).published, false);
    const del = w.calls.filter((c) => c.method === 'DELETE');
    assert.equal(del.length, 1);
    assert.equal(del[0].headers['X-Token'], 'tok-live', 'DELETE 也必须带服务端 token');
  } finally {
    await w.close();
  }
});

test('发布路由：出网失败 → 502（可识别的失败，不是 500/崩溃）', async () => {
  const w = await mkInstalled({ 'POST /api/rooms': { ok: false, error: 'RATE_LIMITED' } });
  try {
    const r = await fetch(w.base + ROUTE_PUBLISH, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: w.base },
      body: JSON.stringify({ code: 'ABCD', serverId: 'box.example.com' }),
    });
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { ok: false, error: 'RATE_LIMITED' });
  } finally {
    await w.close();
  }
});

test('GET 打发布路由 → 405（只认 POST）', async () => {
  const w = await mkInstalled();
  try {
    const r = await fetch(w.base + ROUTE_PUBLISH, { headers: { origin: w.base } });
    assert.equal(r.status, 405);
  } finally {
    await w.close();
  }
});

test('/healthz 带 ACAO，其它路径一个字节都不动', async () => {
  const w = await mkInstalled();
  try {
    const hz = await fetch(w.base + '/healthz');
    assert.equal(hz.status, 200);
    assert.equal(hz.headers.get('access-control-allow-origin'), '*', '/healthz 必须带 ACAO');
    assert.deepEqual(await hz.json(), { ok: true, rooms: 1, humans: 2, uptime: 1 }, '正文必须原样');
    const other = await fetch(w.base + '/api/rooms');
    assert.equal(other.headers.get('access-control-allow-origin'), null, '其它路径不许带 CORS 头');
  } finally {
    await w.close();
  }
});

test('patchHealthzCors：只认 /healthz，且不让上游覆盖我们的 ACAO', () => {
  const headers = {};
  const res = { setHeader: (n, v) => { headers[String(n).toLowerCase()] = v; }, writeHead: () => {} };
  assert.equal(patchHealthzCors({ url: '/api/rooms' }, res), false);
  assert.deepEqual(headers, {}, '非 /healthz 不许改头');
  assert.equal(patchHealthzCors({ url: '/healthz?x=1' }, res), true);
  assert.equal(headers['access-control-allow-origin'], '*');
  res.setHeader('Access-Control-Allow-Origin', 'https://evil.example'); // 上游/其它层想覆盖
  assert.equal(headers['access-control-allow-origin'], '*', '我们的 * 不被覆盖');
});

test('overlay 契约：api/id 正确，install 在没有 server 时也不抛（只返回 publisher）', async () => {
  assert.equal(overlayApi, 1);
  assert.equal(id, 'sp-lobby');
  const p = await install({ log: () => {} });
  assert.equal(typeof p.publish, 'function');
  assert.equal(p.status().published, false);
});

// ---- Sourcery #46 的修复回归 ---------------------------------------------------------------------

test('座位口径：已离开(left)的人不占座；inMatch 也要认（不只 match）', () => {
  assert.deepEqual(liveFieldsOf({ code: 'ABCD', mode: 'coop', seats: [{ left: true }, { left: false }, null, null] }),
    { mode: 'coop', status: 'waiting', occupied: 1, capacity: 4 }, 'left=true 不算占用');
  assert.equal(liveFieldsOf({ code: 'ABCD', seats: [], inMatch: true }).status, 'playing', '只有 inMatch 也要显示对局中');
  assert.equal(liveFieldsOf({ code: 'ABCD', seats: [], match: {} }).status, 'playing');
});

test('串行化：POST 还在路上时取消 → 最终不许留下「已公开」', async () => {
  const lobby = mkLobby([roomOf('ABCD', [seat(1)])]);
  let releasePost;
  const gate = new Promise((r) => { releasePost = r; });
  const calls = [];
  const impl = (url, init) => {
    calls.push({ path: new URL(String(url)).pathname, method: init && init.method, token: (init && init.headers && init.headers['X-Token']) || '' });
    if ((init && init.method) === 'POST') {
      return gate.then(() => ({ json: () => Promise.resolve({ ok: true, token: 'tok-slow' }) }));
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  };
  const t = mkTimers();
  const p = createPublisher({ fetchImpl: impl, readRoom: (c) => readRoomFrom(lobby, c),
    setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn });
  const pub = p.publish({ code: 'ABCD', serverId: 'srv' });
  const off = p.unpublish();          // 立刻取消（POST 还没回来）
  releasePost();
  const [rp, ro] = await Promise.all([pub, off]);
  assert.equal(rp.ok, true, '发布本身可以成功');
  assert.equal(ro.ok, true, '取消也必须成功');
  assert.equal(p.status().published, false, '取消之后绝不许仍是「已公开」');
  assert.equal(t.list.length, 0, '取消之后不许还留着周期表');
  const del = calls.filter((c) => c.method === 'DELETE');
  assert.equal(del.length, 1, '取消要真的把那一行删掉');
  assert.equal(del[0].token, 'tok-slow', 'DELETE 必须用发布拿到的那个 token');
});

test('重启清理：上一次运行留下的行用存档 token 删掉', async () => {
  const f = mkFetch({ 'DELETE /api/rooms': { ok: true } });
  const p = createPublisher({ fetchImpl: f.impl, readRoom: () => null });
  const r = await p.cleanupSaved({ code: 'ABCD', serverId: 'srv', token: 'tok-old' });
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].method, 'DELETE');
  assert.equal(f.calls[0].headers['X-Token'], 'tok-old');
  assert.equal(p.status().published, false);
  const bad = await p.cleanupSaved({ code: 'nope' });
  assert.equal(bad.ok, false, '存档不完整就不许乱删');
});

test('patchHealthzCors：writeHead(object) 也压不掉我们的 ACAO', () => {
  const headers = {};
  const res = {
    setHeader: (n, v) => { headers[String(n).toLowerCase()] = v; },
    writeHead: (status, obj) => { if (obj) for (const k of Object.keys(obj)) headers[String(k).toLowerCase()] = obj[k]; },
  };
  patchHealthzCors({ url: '/healthz' }, res);
  res.writeHead(200, { 'content-type': 'application/json', 'Access-Control-Allow-Origin': 'https://evil.example' });
  assert.equal(headers['access-control-allow-origin'], '*', '对象形式的 writeHead 也不许覆盖');
  assert.equal(headers['content-type'], 'application/json', '其它头原样保留');
});

// ---- 真机形状回归（2026-10-07 实锤的挂载 bug）------------------------------------------------------

test('install 认 startServer() 的返回对象形状（.server 才是 http.Server）——控制路由必须真的挂上', async () => {
  const lobby = mkLobby([roomOf('ABCD', [seat(1)])]);
  const stock = (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('stock'); };
  const httpServer = http.createServer(stock);
  // 上游 startServer() 的真实返回形状：http.Server 在 .server 上，lobby 在同级
  const returned = { port: 0, host: '127.0.0.1', url: 'http://127.0.0.1:0', server: httpServer, wss: {}, lobby: lobby, close() {} };
  assert.equal(resolveHttpServer({ server: returned }), httpServer, 'resolveHttpServer 要能穿透一层');
  install({ server: returned, log: () => {} });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  try {
    const noOrigin = await fetch(base + ROUTE_STATUS);
    assert.equal(noOrigin.status, 403, '门禁照旧（缺 Origin）');
    const ok = await fetch(base + ROUTE_STATUS, { headers: { origin: base } });
    assert.equal(ok.status, 200, '挂载必须生效（旧实现在设备上会静默跳过）');
    assert.equal((await ok.json()).ok, true);
    const hz = await fetch(base + '/healthz');
    assert.equal(hz.headers.get('access-control-allow-origin'), '*', '/healthz 的 ACAO 也要在真机形状下生效');
  } finally {
    await new Promise((r) => httpServer.close(r));
  }
});
