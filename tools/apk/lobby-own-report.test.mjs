// lobby.js「自己房间独立上报」（v6.3）的行为测试：vm + 最小 DOM/网络桩，真跑模块里的逻辑。
//
// 覆盖：① liveFieldsFor 的口径；② 三条件门禁（牌 + token + 在房 + 前台）；
//       ③ PATCH 带全直播字段与 X-Token，且**不知道备注时绝不带 note**；④ FORBIDDEN/NOT_FOUND
//       清本地 token 并停手（不再每 60s 白打）；⑤ 首发 POST 就带全直播字段；⑥ 后台零请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'lobby.js'), 'utf8');
const TOKENS_KEY = 'sp.lobby.tokens';

const okJson = (obj) => ({ ok: true, status: 200, json: () => Promise.resolve(obj) });

/** 相对 URL → 页面同源绝对 URL（浏览器行为；vm 里 URL 不认相对路径）。 */
const PAGE_ORIGIN = 'https://game.example.com';
/** 让 vm 里已 resolve 的 promise 链跑完（vm 的 setTimeout 是桩，不自己跑）。 */
const flushHost = () => new Promise((r) => setImmediate(r));
const flush2 = async () => { await flushHost(); await flushHost(); await flushHost(); };
const absUrl = (u) => { try { return new URL(String(u), PAGE_ORIGIN + '/').toString(); } catch (e) { return String(u); } };
/** vm 上下文里的对象原型不同：比较前统一成宿主对象。 */
const plain = (o) => JSON.parse(JSON.stringify(o));

/** 一个最小世界：localStorage 真存、fetch 记账、定时器记账（不自动跑）。 */
function mkWorld(opt) {
  const o = opt || {};
  const calls = [];
  const kv = new Map();
  const timers = [];
  const listeners = {};
  const fetchStub = (url, init) => {
    const u = absUrl(url);
    calls.push({ url: u, init: init || {} });
    if (o.reply) {
      const r = o.reply(u, init || {});
      if (r) return Promise.resolve(r);
    }
    // 默认「本机没有这个端点」（老内容包 / 非本机页面）→ 404，客户端回落直连（A 的老路径）。
    if (u.indexOf('/sp/lobby/publish') >= 0) return Promise.resolve(o.spPubReply ? okJson(o.spPubReply) : { status: 404, ok: false, json: () => Promise.resolve({}) });
    if (u.indexOf('/sp/lobby/status') >= 0) return Promise.resolve(okJson(o.spStatusReply || { ok: true, published: false }));
    if (u.indexOf('/api/rooms') >= 0 && (init || {}).method === 'PATCH') return Promise.resolve(okJson(o.patchReply || { ok: true }));
    if (u.indexOf('/api/rooms') >= 0 && (init || {}).method === 'POST') return Promise.resolve(okJson(o.postReply || { ok: true, token: 'tok-new' }));
    if (u.indexOf('/api/rooms') >= 0) return Promise.resolve(okJson(o.boardReply || { ok: true, rooms: [] }));
    return Promise.resolve(okJson({ ok: true }));
  };
  const world = {
    console, URL, Promise, JSON, Math, String, Number, Array, Object, Boolean, isFinite,
    parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    // 口径①测试用：Date.now 可注入一个乱跳的墙钟（只保留 now()；lobby.js 不用 new Date）。
    Date: o.dateNow ? { now: o.dateNow } : Date,
    setTimeout: (fn, ms) => { const t = { fn, ms, kind: 'timeout' }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn, ms) => { const t = { fn, ms, kind: 'interval' }; timers.push(t); return t; },
    clearInterval: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    AbortSignal: { timeout: () => undefined },
    localStorage: {
      getItem: (k) => (kv.has(k) ? kv.get(k) : null),
      setItem: (k, v) => kv.set(k, String(v)),
      removeItem: (k) => kv.delete(k),
    },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: fetchStub,
    navigator: { userAgent: 'test' },
    location: { href: 'https://game.example.com/play', host: 'game.example.com', hostname: 'game.example.com', protocol: 'https:' },
  };
  if (o.performance) world.performance = o.performance; // 口径①测试：可控的 performance.now
  world.window = world;
  world.document = {
    hidden: !!o.hidden,
    // 记录 visibilitychange 监听器，测试里可手动 __fire 切前台。
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => { const a = listeners[type] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    __fire: (type) => { (listeners[type] || []).slice().forEach((fn) => fn()); },
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
  };
  vm.createContext(world);
  vm.runInContext(SRC, world, { filename: 'lobby.js' });
  return { world, calls, kv, timers };
}

const roomOf = (code, seats, extra) => Object.assign({ code: code, seats: seats, mode: 'coop' }, extra || {});

test('liveFieldsFor：房态直播字段的口径（空位/满员/对战中/单人）', () => {
  const { world } = mkWorld();
  const L = world.__SP_LOBBY;
  assert.deepEqual(plain(L.liveFieldsFor(roomOf('ABCD', [1, 0, 0, 0]))), { mode: 'coop', status: 'waiting', occupied: 1, capacity: 4 });
  assert.deepEqual(plain(L.liveFieldsFor(roomOf('ABCD', [1, 1, 1, 1]))), { mode: 'coop', status: 'full', occupied: 4, capacity: 4 });
  assert.deepEqual(plain(L.liveFieldsFor(roomOf('ABCD', [1, 1], { inMatch: true, mode: 'solo' }))), { mode: 'solo', status: 'playing', occupied: 2, capacity: 2 });
  assert.deepEqual(plain(L.liveFieldsFor(null)), { mode: 'coop', status: 'waiting', occupied: 0, capacity: 4 });
});

test('ownReportState：牌 + token + 在房 + 前台 四条件缺一不可', () => {
  const { world, kv } = mkWorld();
  const L = world.__SP_LOBBY;
  L.__injectStore({ get: () => ({ room: roomOf('abcd', [1, 0, 0, 0]) }) });
  assert.equal(L.ownReportState().ok, false, '没有 token 不许上报');
  kv.set(TOKENS_KEY, JSON.stringify({ ABCD: 'tok-1' }));
  const st = L.ownReportState();
  assert.equal(st.ok, true);
  assert.equal(st.code, 'ABCD', '房号要归一成大写');
  assert.equal(st.token, 'tok-1');

  const hidden = mkWorld({ hidden: true });
  hidden.kv.set(TOKENS_KEY, JSON.stringify({ ABCD: 'tok-1' }));
  hidden.world.__SP_LOBBY.__injectStore({ get: () => ({ room: roomOf('ABCD', [1]) }) });
  assert.equal(hidden.world.__SP_LOBBY.ownReportState().ok, false, '后台不许上报');
});

test('ownReportTick：PATCH 带全直播字段 + X-Token；不知道备注时**不带 note**', async () => {
  const { world, calls, kv } = mkWorld();
  const L = world.__SP_LOBBY;
  kv.set(TOKENS_KEY, JSON.stringify({ ABCD: 'tok-1' }));
  L.__injectStore({ get: () => ({ room: roomOf('abcd', [1, 1, 0, 0]) }) });

  const r = await L.ownReportTick();
  assert.equal(r.ok, true);
  const patch = calls.filter((c) => c.init.method === 'PATCH');
  assert.equal(patch.length, 1);
  assert.equal(patch[0].url, 'https://sp-lobby.jiangjiangze.icu/api/rooms');
  assert.equal(patch[0].init.headers['X-Token'], 'tok-1');
  const body = JSON.parse(patch[0].init.body);
  assert.deepEqual(body, { code: 'ABCD', serverId: 'game.example.com', mode: 'coop', status: 'waiting', occupied: 2, capacity: 4 });
  assert.ok(!('note' in body), '不知道网页那一行写的是什么时，绝不能带 note（带上空串会清掉别人的备注）');
});

test('ownReportTick：房间牌上那一行已知时，note 原样带回', async () => {
  const boardReply = { ok: true, rooms: [{ code: 'ABCD', serverId: 'srv-1', note: '我的备注', occupied: 0, capacity: 4, mode: 'coop', status: 'waiting' }] };
  const { world, calls, kv } = mkWorld({ boardReply });
  const L = world.__SP_LOBBY;
  kv.set(TOKENS_KEY, JSON.stringify({ ABCD: 'tok-1' }));
  L.__injectStore({ get: () => ({ room: roomOf('ABCD', [1, 0, 0, 0]) }) });
  L.subscribeRooms(() => {}); // 订阅 → 起房间牌轮询 → 桩里那一行进入 boardStore
  await new Promise((r) => setTimeout(r, 10));
  calls.length = 0;
  const r = await L.ownReportTick();
  assert.equal(r.ok, true);
  const body = JSON.parse(calls.filter((c) => c.init.method === 'PATCH')[0].init.body);
  assert.equal(body.note, '我的备注');
  assert.equal(body.serverId, 'srv-1', '知道 serverId 就不要用 location.host 兜底');
});

test('ownReportTick：FORBIDDEN / NOT_FOUND → 清本地 token 并停手（不再白打）', async () => {
  for (const code of ['FORBIDDEN', 'NOT_FOUND']) {
    const { world, kv, calls } = mkWorld({ patchReply: { ok: false, error: code } });
    const L = world.__SP_LOBBY;
    kv.set(TOKENS_KEY, JSON.stringify({ ABCD: 'tok-1' }));
    L.__injectStore({ get: () => ({ room: roomOf('ABCD', [1]) }) });
    const r = await L.ownReportTick();
    assert.equal(r.ok, false);
    assert.equal(r.error, code);
    assert.deepEqual(JSON.parse(kv.get(TOKENS_KEY) || '{}'), {}, `${code} 之后本地凭据必须清掉`);
    calls.length = 0;
    const again = await L.ownReportTick();
    assert.equal(again.error, 'skipped', '清掉凭据以后每拍都跳过，不再发请求');
    // 只数上报本身：每拍还会顺带核对一次服务端发布状态（同源 /sp/lobby/status，不算上报）。
    assert.equal(calls.filter((c) => c.init.method === 'PATCH').length, 0);
    assert.equal(calls.filter((c) => c.url.indexOf('/api/rooms') >= 0).length, 0);
  }
});

test('togglePublic：首发 POST 就带全直播字段（「一开始没有人数」的根因）', async () => {
  const { world, calls } = mkWorld({ postReply: { ok: true, token: 'tok-new' } });
  const L = world.__SP_LOBBY;
  L.__injectStore({ get: () => ({ room: roomOf('abcd', [1, 1, 0, 0], { difficulty: 'NORMAL' }) }) });
  const r = await L.togglePublic('abcd');
  assert.equal(r.ok, true);
  // v6.4/v6.5：发布请求一定先打本机服务（端点此时不存在 → 404），之后才直连房间牌；
  // 启动/每拍还会有 /sp/lobby/status 的自检请求，所以按形参路径筛，不认「第几个」。
  assert.equal(calls.filter((c) => c.url.indexOf('/sp/lobby/publish') >= 0).length, 1);
  const post = calls.filter((c) => c.init.method === 'POST' && c.url.indexOf('/api/rooms') >= 0);
  assert.equal(post.length, 1, '直连只许一次');
  const body = JSON.parse(post[0].init.body);
  assert.equal(body.code, 'ABCD');
  assert.equal(body.serverId, 'game.example.com');
  assert.equal(body.difficulty, 'NORMAL');
  assert.equal(body.mode, 'coop');
  assert.equal(body.status, 'waiting');
  assert.equal(body.occupied, 2);
  assert.equal(body.capacity, 4);
});

test('后台（document.hidden）时 ownWatchArm 不排表 → 零请求', () => {
  const { world, timers } = mkWorld({ hidden: true });
  world.__SP_LOBBY.__injectStore({ get: () => ({ room: roomOf('ABCD', [1]) }) });
  assert.equal(timers.filter((t) => t.kind === 'interval').length, 0);
});

test('可见时 ownWatchArm 幂等：只有一个 60s 周期表', () => {
  const { world, timers } = mkWorld();
  const L = world.__SP_LOBBY;
  L.__injectStore({ get: () => ({ room: roomOf('ABCD', [1]) }) });
  L.__injectStore({ get: () => ({ room: roomOf('ABCD', [1]) }) });
  const iv = timers.filter((t) => t.kind === 'interval');
  assert.equal(iv.length, 1, '重复注入/调用不应叠出第二个周期表');
  assert.ok(iv[0].ms >= 30000, '节奏不许比 30s 更密（免费额度纪律）');
});

// ---- v6.4：服务端发布（B）的客户端接线 -----------------------------------------------------------

test('togglePublic：优先请本机服务发布（同源 /sp/lobby/publish），成功则不再直连房间牌', async () => {
  const { world, calls } = mkWorld({ spPubReply: { ok: true, published: true } });
  const L = world.__SP_LOBBY;
  L.__injectStore({ get: () => ({ room: roomOf('abcd', [1, 0, 0, 0]) }) });
  const r = await L.togglePublic('abcd');
  assert.equal(r.ok, true);
  assert.match(r.text, /服务端维护/, '文案要反映是服务端在维护');
  const toServer = calls.filter((c) => c.url.indexOf('/sp/lobby/publish') >= 0);
  assert.equal(toServer.length, 1);
  assert.equal(toServer[0].init.method, 'POST');
  const body = JSON.parse(toServer[0].init.body);
  assert.equal(body.code, 'ABCD');
  assert.equal(body.mode, 'coop');
  assert.equal(body.status, 'waiting');
  assert.equal(calls.filter((c) => c.url.indexOf('/api/rooms') >= 0).length, 0, '服务端接管时不许再直连');
  assert.equal(L.spPubState().on, true);
  assert.equal(L.isPublic('ABCD'), true, '服务端持有发布权时按钮状态必须是「已公开」');
});

test('togglePublic：本机端点不存在（404）→ 回落直连房间牌并存本地 token', async () => {
  const { world, calls, kv } = mkWorld({ spPubReply: { ok: false, error: 'NO_ENDPOINT' }, postReply: { ok: true, token: 'tok-direct' } });
  // 端点不存在：让 /sp/lobby/publish 回 404（spPubCall 认 404/405 为「没有这个端点」）
  world.fetch = (url, init) => {
    const u = absUrl(url);
    calls.push({ url: u, init: init || {} });
    if (u.indexOf('/sp/lobby/publish') >= 0) return Promise.resolve({ status: 404, ok: false, json: () => Promise.resolve({}) });
    if (u.indexOf('/api/rooms') >= 0 && (init || {}).method === 'POST') return Promise.resolve(okJson({ ok: true, token: 'tok-direct' }));
    return Promise.resolve(okJson({ ok: true, rooms: [] }));
  };
  const L = world.__SP_LOBBY;
  L.__injectStore({ get: () => ({ room: roomOf('abcd', [1, 0, 0, 0]) }) });
  const r = await L.togglePublic('abcd');
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(kv.get(TOKENS_KEY))['ABCD'], 'tok-direct', '回落路径要把 token 存本地');
  assert.ok(calls.some((c) => c.url.indexOf('/api/rooms') >= 0 && c.init.method === 'POST'), '必须真的直连了房间牌');
  assert.equal(L.spPubState().on, false);
});

test('togglePublic：本机端点被拒（有应答）→ 如实转达，不重复直连', async () => {
  const { world, calls } = mkWorld({});
  world.fetch = (url, init) => {
    const u = absUrl(url);
    calls.push({ url: u, init: init || {} });
    if (u.indexOf('/sp/lobby/publish') >= 0) return Promise.resolve({ status: 502, ok: false, json: () => Promise.resolve({ ok: false, error: 'ROOM_NOT_FOUND' }) });
    return Promise.resolve(okJson({ ok: true, token: 'nope' }));
  };
  const L = world.__SP_LOBBY;
  L.__injectStore({ get: () => ({ room: roomOf('ABCD', [1]) }) });
  const r = await L.togglePublic('ABCD');
  assert.equal(r.ok, false);
  assert.equal(r.text, 'ROOM_NOT_FOUND');
  assert.equal(calls.filter((c) => c.url.indexOf('/api/rooms') >= 0).length, 0, '端点拒绝了就别再直连（免得双提交）');
});

test('取消公开：服务端持有发布权时打 {on:false}，状态归零', async () => {
  const { world, calls } = mkWorld({ spPubReply: { ok: true, published: true } });
  const L = world.__SP_LOBBY;
  L.__injectStore({ get: () => ({ room: roomOf('ABCD', [1]) }) });
  await L.togglePublic('ABCD');
  calls.length = 0;
  const off = await L.togglePublic('ABCD');
  assert.equal(off.ok, true);
  assert.equal(off.isPublic, false);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { on: false });
  assert.equal(calls.filter((c) => c.init.method === 'DELETE').length, 0, '不许再打房间牌 DELETE');
  assert.equal(L.spPubState().on, false);
  assert.equal(L.isPublic('ABCD'), false);
});

// ---- Sourcery #46 的修复回归（客户端侧） ---------------------------------------------------------

test('403（控制面只认回环）→ 回落直连，不把远程页面卡死', async () => {
  const { world, calls, kv } = mkWorld();
  world.fetch = (url, init) => {
    const u = absUrl(url);
    calls.push({ url: u, init: init || {} });
    if (u.indexOf('/sp/lobby/publish') >= 0) return Promise.resolve({ status: 403, ok: false, json: () => Promise.resolve({ ok: false, error: 'FORBIDDEN' }) });
    if (u.indexOf('/sp/lobby/status') >= 0) return Promise.resolve({ status: 403, ok: false, json: () => Promise.resolve({}) });
    if (u.indexOf('/api/rooms') >= 0 && (init || {}).method === 'POST') return Promise.resolve(okJson({ ok: true, token: 'tok-web' }));
    return Promise.resolve(okJson({ ok: true, rooms: [] }));
  };
  const L = world.__SP_LOBBY;
  L.__injectStore({ get: () => ({ room: roomOf('abcd', [1, 0, 0, 0]) }) });
  const r = await L.togglePublic('abcd');
  assert.equal(r.ok, true, '远程页面（box 上的浏览器）必须还能公开');
  assert.equal(JSON.parse(kv.get(TOKENS_KEY))['ABCD'], 'tok-web');
});

test('超时（结果未知）→ 不回退直连；核对服务端状态为准', async () => {
  const { world, calls } = mkWorld();
  world.fetch = (url, init) => {
    const u = absUrl(url);
    calls.push({ url: u, init: init || {} });
    if (u.indexOf('/sp/lobby/publish') >= 0) return Promise.reject(new Error('timeout'));
    if (u.indexOf('/sp/lobby/status') >= 0) return Promise.resolve(okJson({ ok: true, published: true, code: 'ABCD' }));
    return Promise.resolve(okJson({ ok: true, token: 'tok-double' }));
  };
  const L = world.__SP_LOBBY;
  L.__injectStore({ get: () => ({ room: roomOf('ABCD', [1, 0, 0, 0]) }) });
  const r = await L.togglePublic('ABCD');
  assert.equal(r.ok, true, '服务端其实已经发布成功 → 就报成功');
  assert.equal(calls.filter((c) => c.url.indexOf('/api/rooms') >= 0).length, 0, '绝不许再直连（否则同一房号两个 token）');
  assert.equal(L.isPublic('ABCD'), true);
});

test('超时且服务端没发布 → 如实报失败，也不直连', async () => {
  const { world, calls } = mkWorld();
  world.fetch = (url) => {
    const u = absUrl(url);
    calls.push({ url: u, init: {} });
    if (u.indexOf('/sp/lobby/publish') >= 0) return Promise.reject(new Error('boom'));
    if (u.indexOf('/sp/lobby/status') >= 0) return Promise.resolve(okJson({ ok: true, published: false }));
    return Promise.resolve(okJson({ ok: true, token: 'x' }));
  };
  const L = world.__SP_LOBBY;
  L.__injectStore({ get: () => ({ room: roomOf('ABCD', [1]) }) });
  const r = await L.togglePublic('ABCD');
  assert.equal(r.ok, false);
  assert.equal(r.text, 'timeout');
  assert.equal(calls.filter((c) => c.url.indexOf('/api/rooms') >= 0).length, 0);
});

test('页面刷新后：服务端持有的发布项要立刻认出来（isPublic 为真）', async () => {
  const { world, calls } = mkWorld({ spStatusReply: { ok: true, published: true, code: 'ABCD' } });
  world.fetch = (url, init) => {
    const u = absUrl(url);
    calls.push({ url: u, init: init || {} });
    if (u.indexOf('/sp/lobby/status') >= 0) return Promise.resolve(okJson({ ok: true, published: true, code: 'ABCD', lastError: '' }));
    return Promise.resolve(okJson({ ok: true, rooms: [] }));
  };
  const L = world.__SP_LOBBY;
  L.__injectStore({ get: () => ({ room: roomOf('ABCD', [1]) }) });
  await L.ownReportTick();                     // 一拍就会顺带核对状态
  await flush2();
  assert.equal(L.spPubState().on, true, '刷新后不许把服务端的发布项当私有');
  assert.equal(L.isPublic('ABCD'), true);
  // 取消走服务端路由
  calls.length = 0;
  const off = await L.togglePublic('ABCD');
  assert.equal(off.ok, true);
  assert.equal(JSON.parse(calls.find((c) => c.url.indexOf('/sp/lobby/publish') >= 0).init.body).on, false);
});

test('状态路由 5xx / 形状不对 → 不动缓存（活跃发布项不许被隐藏）', async () => {
  const { world } = mkWorld();
  world.fetch = (url) => {
    const u = absUrl(url);
    if (u.indexOf('/sp/lobby/status') >= 0) return Promise.resolve({ status: 500, ok: false, json: () => Promise.resolve({}) });
    if (u.indexOf('/sp/lobby/publish') >= 0) return Promise.resolve(okJson({ ok: true, published: true }));
    return Promise.resolve(okJson({ ok: true, rooms: [] }));
  };
  const L = world.__SP_LOBBY;
  L.__injectStore({ get: () => ({ room: roomOf('ABCD', [1]) }) });
  await L.togglePublic('ABCD');                // 服务端发布成功 → spPub.on = true
  assert.equal(L.spPubState().on, true);
  await L.ownReportTick();                     // 状态路由 500
  await flush2();
  assert.equal(L.spPubState().on, true, '状态路由出错时缓存必须保持不变');
});

// ---- v7.0：延迟测量的两条口径（单调时钟 / 仅可见页探测） -----------------------------------------

test('口径①：墙钟被回拨或跳前时，房间剩余秒数（耗时）不失真', async () => {
  // 注入可控的单调时钟 performance.now；Date.now（墙钟）随后乱跳。
  let mono = 1000;
  let wall = 1_000_000;
  const boardReply = { ok: true, rooms: [{ code: 'ABCD', serverId: 'srv-1', leftSec: 600, occupied: 0, capacity: 4, mode: 'coop', status: 'waiting' }] };
  const { world } = mkWorld({ boardReply, performance: { now: () => mono }, dateNow: () => wall });
  const L = world.__SP_LOBBY;
  const unsub = L.subscribeRooms(() => {});    // 起房间牌轮询
  await flush2(); await flush2();              // 让 board 抓取落地（src.at = monoNow() = 1000）
  const atFetch = L.rooms().find((r) => r.code === 'ABCD');
  assert.ok(atFetch, '房间牌那一行必须已进入 boardStore');
  assert.ok(Math.abs(atFetch.left - 600) < 0.001, '抓取当刻剩余应 ≈600，实测 ' + atFetch.left);

  // 抓取后过去 10 秒「单调时间」；同时墙钟被回拨 1 小时（NTP / 用户改系统时间）
  mono += 10_000;
  wall -= 3_600_000;
  let left = L.rooms().find((r) => r.code === 'ABCD').left;
  assert.ok(left > 589 && left < 591, '墙钟回拨不得污染剩余秒数（应 ≈590，实测 ' + left + '）');

  // 墙钟再跳前 1 小时：剩余秒数仍只随单调时间走
  wall += 7_200_000;
  left = L.rooms().find((r) => r.code === 'ABCD').left;
  assert.ok(left > 589 && left < 591, '墙钟跳前不得污染剩余秒数（应 ≈590，实测 ' + left + '）');
  unsub();
});

test('口径②：页面隐藏时零请求（房间牌/社区/上报/探测/自检全不发），回前台补一次', async () => {
  const { world, calls, kv } = mkWorld({ hidden: true, boardReply: { ok: true, rooms: [] } });
  const L = world.__SP_LOBBY;
  kv.set(TOKENS_KEY, JSON.stringify({ ABCD: 'tok-1' }));
  L.__injectStore({ get: () => ({ room: roomOf('ABCD', [1, 0, 0, 0]) }) }); // 满足上报条件（只差可见）

  // 隐藏时：订阅房间牌、打一拍上报、取访客数、注册一个探测 —— 全都不许发请求
  const unsub = L.subscribeRooms(() => {});
  const tick = await L.ownReportTick();
  await L.fetchVisitors(true);
  let probed = 0;
  L.__probeWhenVisible(() => { probed++; });
  await flush2();
  assert.equal(calls.length, 0, '隐藏页一个请求都不许发，实测：' + JSON.stringify(calls.map((c) => c.url)));
  assert.equal(tick.error, 'skipped', '隐藏页上报必须跳过（连服务端发布自检也不打）');
  assert.equal(probed, 0, '隐藏页探测必须挂起，不许执行');

  // 回到前台：visibilitychange → 立刻补一次（房间牌 + 社区源 + 上报 + 挂起的探测）
  world.document.hidden = false;
  world.document.__fire('visibilitychange');
  await flush2(); await flush2();
  assert.ok(calls.some((c) => c.url.indexOf('/api/rooms') >= 0), '回前台要立刻补一次房间牌');
  assert.ok(calls.some((c) => c.url.indexOf('/api/community') >= 0), '回前台要立刻补一次社区源');
  assert.ok(calls.some((c) => c.url.indexOf('/sp/lobby/status') >= 0), '回前台要补一次服务端发布自检');
  assert.equal(probed, 1, '挂起的探测要在回前台补发一次');
  unsub();
});
