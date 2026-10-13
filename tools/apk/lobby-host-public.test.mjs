// lobby.js「房主持有房间时的默认公开」（owner 2026-10-11）的行为测试：vm + 最小 DOM/网络桩，
// 真跑模块里的 hostRoomTick（经 __injectStore 挂上 store.subscribe 驱动）。
//
// 口径（两条，逐字）：
//   · 「本机服务下开房间（强制公开…）」——本机服务（回环页 / currentServerId=sp-phone-host）上
//     房主建房：POST /lan/publish {on:true}，与偏好无关；
//   · 「联机偏好（里面开个选项，默认公开房间（包含服务器））」——服务器页面上房主建房：偏好开
//     才 POST /api/rooms 公开到大厅；偏好缺省关 = 2026-10-09 的「不自动公开」；
//   · 「去掉全局同盟模拟中的公开到大厅」——同盟模拟房（matchCodes）永不走这条看表（由
//     doPendingCreate 自己处理，这里不重复）；
//   · 安全边界：访客（hostId ≠ 我的 playerId）不动；已公开（本地 token）不动 —— togglePublic 是
//     开关，重复调用会取消公开；每个房号只自动处理一次（hostSeen 幂等）。
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
const flush = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

/**
 * 一个最小世界（与 lobby-own-report.test.mjs 同一套路）：fetch 记账、定时器记账。
 * opt.local = true 时页面主机名换成 127.0.0.1（本机服务判据 isPrivateHost 命中）。
 * opt.prefs = __SP_PREFS 桩（lobby.public 走它）。
 */
function mkWorld(opt) {
  const o = opt || {};
  const calls = [];
  const kv = new Map();
  const timers = [];
  const fetchStub = (url, init) => {
    const u = String(url);
    calls.push({ url: u, init: init || {} });
    if (u.indexOf('/lan/publish') >= 0) return Promise.resolve(okJson({ ok: true, on: true }));
    // 本机没有 B 通道端点（老内容包 / 直连）→ 回落 A：直接 POST 房间牌（本测试断言的就是这条）。
    if (u.indexOf('/sp/lobby/publish') >= 0) return Promise.resolve({ status: 404, ok: false, json: () => Promise.resolve({}) });
    if (u.indexOf('/sp/lobby/status') >= 0) return Promise.resolve(okJson({ ok: true, published: false }));
    if (u.indexOf('/api/rooms') >= 0 && (init || {}).method === 'POST') return Promise.resolve(okJson({ ok: true, token: 'tok-new' }));
    if (u.indexOf('/api/rooms') >= 0) return Promise.resolve(okJson({ ok: true, rooms: [] }));
    return Promise.resolve(okJson({ ok: true }));
  };
  const host = o.local ? '127.0.0.1' : 'game.example.com';
  const world = {
    console, URL, Promise, JSON, Math, String, Number, Array, Object, Boolean, isFinite,
    parseInt, parseFloat, encodeURIComponent, decodeURIComponent, Date,
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
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
    location: { href: 'https://' + host + '/play', host: host, hostname: host, protocol: 'https:', origin: 'https://' + host },
  };
  if (o.prefs) world.__SP_PREFS = o.prefs;
  if (o.shell) world.shell = o.shell;
  world.window = world;
  world.document = {
    hidden: false,
    addEventListener: () => {}, removeEventListener: () => {},
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    head: { appendChild: () => {} }, body: { appendChild: () => {} },
  };
  vm.createContext(world);
  vm.runInContext(SRC, world, { filename: 'lobby.js' });
  return { world, calls, kv };
}

/** 注入一个可控 store：get() 读当前状态，subscribe 记下回调让测试手动触发一拍。 */
function injectStore(world, state) {
  const subs = [];
  world.__SP_LOBBY.__injectStore({
    get: () => state,
    subscribe: (fn) => { subs.push(fn); return () => {}; },
  });
  return { poke: () => { for (const fn of subs) fn(state, state); } };
}

const prefsStub = (publicOn) => ({
  get: (k) => (k === 'lobby.public' && publicOn ? true : null),
  set: () => true,
});

const boardPosts = (calls) => calls.filter((c) => c.url.indexOf('/api/rooms') >= 0 && c.init.method === 'POST');
const lanPosts = (calls) => calls.filter((c) => c.url.indexOf('/lan/publish') >= 0);

test('服务器页面 + 偏好开：房主建房公开到大厅（POST /api/rooms）', async () => {
  const { world, calls } = mkWorld({ prefs: prefsStub(true) });
  const state = { me: { playerId: 7 }, room: { code: 'ABCD', hostId: 7, seats: [1, 0, 0, 0] } };
  injectStore(world, state).poke();
  await flush();
  const posts = boardPosts(calls);
  assert.equal(posts.length, 1, '恰好一次公开：' + JSON.stringify(posts.map((p) => p.url)));
  const body = JSON.parse(posts[0].init.body);
  assert.equal(body.code, 'ABCD');
});

test('服务器页面 + 偏好关（缺省）：不自动公开（2026-10-09 行为保留）', async () => {
  const { world, calls } = mkWorld({ prefs: prefsStub(false) });
  const state = { me: { playerId: 7 }, room: { code: 'ABCD', hostId: 7, seats: [1, 0, 0, 0] } };
  injectStore(world, state).poke();
  await flush();
  assert.equal(boardPosts(calls).length, 0, '偏好关：房间牌不发');
  assert.equal(lanPosts(calls).length, 0, '偏好关：也不碰局域网');
});

test('本机服务：房主建房强制公开到局域网（POST /lan/publish on:true），与偏好无关', async () => {
  const { world, calls } = mkWorld({ local: true, prefs: prefsStub(false) });
  const state = { me: { playerId: 7 }, room: { code: 'ABCD', hostId: 7, seats: [1, 0, 0, 0] } };
  injectStore(world, state).poke();
  await flush();
  const lan = lanPosts(calls);
  assert.equal(lan.length, 1, '本机服务建房公开到局域网一次');
  const body = JSON.parse(lan[0].init.body);
  assert.equal(body.code, 'ABCD');
  assert.equal(body.on, true);
  assert.equal(boardPosts(calls).length, 0, '本机服务永远不碰公共房间牌');
});

test('访客（hostId ≠ 我的 playerId）：看表什么都不做', async () => {
  const { world, calls } = mkWorld({ prefs: prefsStub(true) });
  const state = { me: { playerId: 9 }, room: { code: 'ABCD', hostId: 7, seats: [1, 0, 0, 0] } };
  injectStore(world, state).poke();
  await flush();
  assert.equal(boardPosts(calls).length, 0, '访客不替房主公开');
  assert.equal(lanPosts(calls).length, 0);
});

test('已公开（本地 token 在）：不再调开关（重复 togglePublic 会取消公开）', async () => {
  const { world, calls, kv } = mkWorld({ prefs: prefsStub(true) });
  kv.set(TOKENS_KEY, JSON.stringify({ ABCD: 'tok-1' }));
  const state = { me: { playerId: 7 }, room: { code: 'ABCD', hostId: 7, seats: [1, 0, 0, 0] } };
  injectStore(world, state).poke();
  await flush();
  assert.equal(boardPosts(calls).length, 0, '已经公开的房不再被“公开”一次（那会取消它）');
});

test('幂等：同一房号多次状态变化只自动处理一次；换房号再来一次', async () => {
  const { world, calls } = mkWorld({ prefs: prefsStub(true) });
  const state = { me: { playerId: 7 }, room: { code: 'ABCD', hostId: 7, seats: [1, 0, 0, 0] } };
  const h = injectStore(world, state);
  h.poke(); h.poke(); h.poke();
  await flush();
  assert.equal(boardPosts(calls).length, 1, '三个拍子一次公开');
  state.room = { code: 'EFGH', hostId: 7, seats: [1, 0, 0, 0] };
  h.poke();
  await flush();
  assert.equal(boardPosts(calls).length, 2, '新房间号照常处理');
});

test('同盟模拟房（matchCodes）：看表不处理（公开到大厅已被业主去掉）', async () => {
  const { world, calls } = mkWorld({ prefs: prefsStub(true) });
  world.__SP_LOBBY.__markMatchRoom('ABCD');
  const state = { me: { playerId: 7 }, room: { code: 'ABCD', hostId: 7, seats: [1, 0, 0, 0] } };
  injectStore(world, state).poke();
  await flush();
  assert.equal(boardPosts(calls).length, 0, '模拟房不走默认公开到大厅');
  assert.equal(lanPosts(calls).length, 0, '模拟房也不走这里（本机服务由 doPendingCreate 处理）');
});

test('没有房间 / 房号未就绪：不发车、不抛', async () => {
  const { world, calls } = mkWorld({ prefs: prefsStub(true) });
  const state = { me: { playerId: 7 }, room: null };
  const h = injectStore(world, state);
  h.poke();
  state.room = { code: '', hostId: 7 };
  h.poke();
  await flush();
  assert.equal(boardPosts(calls).length, 0);
});

// ---- 业主 2026-10-13：主页「匹配」= 自动加入互通服务器 → 创房间 → **公开** -----------------------
// 落点在 doPendingCreate：待办带 public 时**不**记进 matchCodes（记了看表就跳过它、永不公开），
// 而是建房拿到房号后直接公开。未带 public 的旧待办（大厅「同盟匹配」面板写的）行为一字不变。

test('匹配待办带 public：建房后公开到大厅（不进 matchCodes，看表不会跳过它）', () => {
  // 源码级：public 分支必须在 matchCodes[code] = 1 **之前**返回，否则待办房会被打上模拟房标记
  const iPub = SRC.indexOf('if (pending && pending.public)');
  const iMark = SRC.indexOf('matchCodes[code] = 1;');
  assert.ok(iPub > 0, 'doPendingCreate 里有 public 分支');
  assert.ok(iPub < iMark, 'public 分支先于 matchCodes 标记（待办房不能被标记成模拟房）');
  assert.ok(/togglePublic\(code\)/.test(SRC.slice(iPub, iMark)), 'public 分支真的调公开');
  assert.ok(!/matchCodes\[code\] = 1/.test(SRC.slice(iPub, iMark)), 'public 分支内不得写 matchCodes');
});

test('待办跨 origin：先读 shell-prefs（localStorage 按 origin 隔离，切服后读不到）', () => {
  // 写入顺序（ui/connect-core.js writeMatchPending）与读取顺序（lobby.js readPendingAny）必须对应
  const iRead = SRC.indexOf('function readPendingAny()');
  const body = SRC.slice(iRead, iRead + 900);
  assert.ok(body.indexOf("__SP_PREFS.get('match.pending')") < body.indexOf('peekMatchPending'),
    '读取顺序：shell-prefs 优先于 player-data');
  assert.ok(body.indexOf('peekMatchPending') < body.indexOf("localStorage.getItem('sp.match.pending')"),
    'player-data 优先于 localStorage 兜底');
  const CONNECT = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'connect-core.js'), 'utf8');
  const iWrite = CONNECT.indexOf('export function writeMatchPending');
  const wbody = CONNECT.slice(iWrite, iWrite + 900);
  assert.ok(wbody.indexOf("__SP_PREFS.set('match.pending'") < wbody.indexOf('recordMatchPending'),
    '写入顺序：shell-prefs 优先于 player-data');
  // cancel 必须三处全清，否则残留待办会在下次进服误触发
  const iCancel = SRC.indexOf('function cancel()');
  assert.ok(SRC.slice(iCancel, iCancel + 300).includes('clearPendingAny()'), 'cancel 复用 clearPendingAny（三处全清）');
});

test('两条都公开（业主 2026-10-13）：大厅「同盟匹配」的待办也带 public: true', () => {
  // 主页「匹配」（ui/connect-core.js writeMatchPending）与大厅「同盟匹配」（lobby.js MatchSection.start）
  // 必须同口径 —— 业主原话「两条都公开」。三处载体（shell-prefs / player-data / localStorage）都要带。
  const i = SRC.indexOf("var pending = { difficulty: diff === 'auto' ? '' : diff");
  assert.ok(i > 0, 'MatchSection.start 里能找到待办构造');
  const block = SRC.slice(i, i + 900);
  assert.ok(!/public: false/.test(block), '大厅匹配的待办不得再写 public: false');
  assert.equal((block.match(/public: true/g) || []).length, 3,
    '三处载体（prefs / player-data / localStorage）都写 public: true');
  assert.ok(!/房间不会自动公开到大厅/.test(SRC), '界面提示不得再说「不会自动公开」（与行为相反）');
  assert.ok(/房间会公开到大厅/.test(SRC), '提示写明房间会公开到大厅');
});
