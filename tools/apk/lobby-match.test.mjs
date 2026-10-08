// 自动匹配「对局已开始」门控的行为测试（业主 2026-10-08 规则一）：
//   ① roomJoinable 把全部「已开局」信号一网打尽（status playing/full/closed、行上裸 inMatch、
//      已知席位且 0 空位、非实时行的 TTL 过期）；
//   ② sanitizeRoom 把上游 room.match / room.inMatch 归一成 status:'playing'（牌上原始行也拦得住）；
//   ③ 自动匹配候选（matchCandidatesFor）跳过这一切，只留真能进的房；
//   ④ joinRoom(auto) 的竞态复核：候选名单是上一拍快照、牌上现况已转 playing → 拒绝并带 reason；
//   ⑤ tryMatchCandidates 把「已开局」的候选跳过、继续下一个（附「对局已开始，已跳过」提示），
//      绝不一次失败就死路；全部候选都在对局中时返回可继续走房主路径的结果（hard=false）。
//   ⑥ 上游 m.public（store.match.public）= 本会话对局已开始 → 自动匹配开启前被拦。
//
// 真源：tools/apk/extras/public/js/lobby.js（vm 里真跑，不联网）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'lobby.js'), 'utf8');

const okJson = (obj) => ({ ok: true, status: 200, json: () => Promise.resolve(obj) });
const PAGE_ORIGIN = 'https://game.example.com';
const absUrl = (u) => { try { return new URL(String(u), PAGE_ORIGIN + '/').toString(); } catch (e) { return String(u); } };
const plain = (o) => JSON.parse(JSON.stringify(o));
const flushHost = () => new Promise((r) => setImmediate(r));
const flush = async () => { await flushHost(); await flushHost(); await flushHost(); await flushHost(); await flushHost(); };

/** 最小世界：fetch 记账、定时器记账（不自动跑）、可切换回复的房间牌桩。 */
function mkWorld(opt) {
  const o = opt || {};
  const calls = [];
  const timers = [];
  const listeners = {};
  const state = { boardReply: o.boardReply || { ok: true, rooms: [] } };
  const world = {
    console, URL, Promise, JSON, Math, String, Number, Array, Object, Boolean, isFinite,
    parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    Date,
    setTimeout: (fn, ms) => { const t = { fn, ms, kind: 'timeout' }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn, ms) => { const t = { fn, ms, kind: 'interval' }; timers.push(t); return t; },
    clearInterval: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    AbortSignal: { timeout: () => undefined },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { userAgent: 'test' },
    location: { href: PAGE_ORIGIN + '/play', host: 'game.example.com', hostname: 'game.example.com', protocol: 'https:' },
  };
  world.fetch = (url, init) => {
    const u = absUrl(url);
    calls.push({ url: u, init: init || {} });
    if (u.indexOf('/api/rooms') >= 0 && (init || {}).method === 'PATCH') return Promise.resolve(okJson({ ok: true }));
    if (u.indexOf('/api/rooms') >= 0) return Promise.resolve(okJson(state.boardReply));
    return Promise.resolve(okJson({ ok: true }));
  };
  world.window = world;
  world.document = {
    hidden: false,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => { const a = listeners[type] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    __fire: (type) => { (listeners[type] || []).slice().forEach((fn) => fn()); },
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
  };
  vm.createContext(world);
  vm.runInContext(SRC, world, { filename: 'lobby.js' });
  return { world, calls, timers, state };
}

/** 拉一拍房间牌（订阅 → 起轮询 → 等桩落地）。 */
async function pullBoard(world) {
  const unsub = world.__SP_LOBBY.subscribeRooms(() => {});
  await flush();
  return unsub;
}

const row = (code, extra) => Object.assign({ code, live: true, occupied: 1, capacity: 4, serverId: 'srv-1' }, extra || {});

test('roomJoinable：已开局的全部信号都拦（playing/full/closed、裸 inMatch、0 空位、过期）', () => {
  const { world } = mkWorld();
  const can = world.__SP_LOBBY.roomJoinable;
  assert.equal(can(row('AAAA', { status: 'playing' })), false, 'status=playing');
  assert.equal(can(row('AAAA', { status: 'full' })), false, 'status=full');
  assert.equal(can(row('AAAA', { status: 'closed' })), false, 'status=closed');
  assert.equal(can(row('AAAA', { inMatch: true })), false, '行上裸 inMatch 标记');
  assert.equal(can(row('AAAA', { occupied: 4, capacity: 4, status: '' })), false, '已知席位且 0 空位');
  assert.equal(can(row('AAAA', { occupied: 3, capacity: 4, status: '' })), true, '有 1 空位可加入');
  assert.equal(can(row('AAAA', { status: '', occupied: -1, capacity: -1 })), true, '席位未知不拦（-1 哨兵）');
  assert.equal(can({ code: 'AAAA', status: '', left: 0 }), false, '非实时行过期');
  assert.equal(can({ code: 'AAAA', status: '', left: 30 }), true, '非实时行未过期');
});

test('sanitizeRoom：上游 room.match / room.inMatch 归一成 playing，自动匹配据此跳过', async () => {
  const boardReply = { ok: true, rooms: [
    { code: 'AAAA', live: true, inMatch: true, occupied: 1, capacity: 4 },
    { code: 'BBBB', live: true, match: {}, occupied: 1, capacity: 4 },
    { code: 'CCCC', live: true, occupied: 1, capacity: 4 },
  ] };
  const { world } = mkWorld({ boardReply });
  const unsub = await pullBoard(world);
  const rows = world.__SP_LOBBY.rooms();
  const byCode = {}; rows.forEach((r) => { byCode[r.code] = r; });
  assert.equal(byCode.AAAA.status, 'playing', 'inMatch:true → playing');
  assert.equal(byCode.BBBB.status, 'playing', 'match 对象 → playing');
  assert.equal(byCode.CCCC.status, '', '没有标记 → 保持未知');
  const cand = plain(world.__SP_LOBBY.matchCandidatesFor('auto', rows).map((r) => r.code));
  assert.deepEqual(cand, ['CCCC'], '已开局的两行都必须被跳过');
  unsub();
});

test('matchCandidatesFor：跳过已开局/满员/关闭，难度过滤照旧，顺序=人多优先', () => {
  const { world } = mkWorld();
  const rows = [
    row('AAAA', { status: 'playing', occupied: 3 }),
    row('BBBB', { status: '', occupied: 4, capacity: 4 }),
    row('CCCC', { status: 'closed' }),
    row('DDDD', { status: 'waiting', occupied: 2, difficulty: 'HARD' }),
    row('EEEE', { status: 'waiting', occupied: 1, difficulty: 'NORMAL' }),
  ];
  assert.deepEqual(plain(world.__SP_LOBBY.matchCandidatesFor('auto', rows).map((r) => r.code)), ['DDDD', 'EEEE']);
  assert.deepEqual(plain(world.__SP_LOBBY.matchCandidatesFor('HARD', rows).map((r) => r.code)), ['DDDD']);
});

test('joinRoom(auto) 竞态复核：牌上现况转 playing → 拒绝并带 reason=playing', async () => {
  const { world, state } = mkWorld({ boardReply: { ok: true, rooms: [row('AAAA'), row('BBBB')] } });
  const L = world.__SP_LOBBY;
  const unsub = await pullBoard(world);
  const list = L.matchCandidatesFor('auto', L.rooms());
  assert.deepEqual(plain(list.map((r) => r.code)), ['AAAA', 'BBBB']);

  // 竞态：候选名单还停在上一拍（AAAA waiting），房间牌新一轮已把它标成开局。
  state.boardReply = { ok: true, rooms: [row('AAAA', { status: 'playing' }), row('BBBB')] };
  world.document.hidden = true; world.document.__fire('visibilitychange');
  world.document.hidden = false; world.document.__fire('visibilitychange');
  await flush();
  const stale = L.joinRoom(list[0], { auto: true }); // 手动路径不会走这一步（auto 才复核）
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'playing');
  assert.match(stale.note, /对局进行中/);
  unsub();
});

test('tryMatchCandidates：已开局的候选跳过、继续下一个（「对局已开始，已跳过」提示）', async () => {
  const { world, state } = mkWorld({ boardReply: { ok: true, rooms: [row('AAAA'), row('BBBB')] } });
  const L = world.__SP_LOBBY;
  const unsub = await pullBoard(world);
  const list = L.matchCandidatesFor('auto', L.rooms());
  state.boardReply = { ok: true, rooms: [row('AAAA', { status: 'playing' }), row('BBBB')] };
  world.document.hidden = true; world.document.__fire('visibilitychange');
  world.document.hidden = false; world.document.__fire('visibilitychange');
  await flush();

  // 原生壳：joinOnOrigin 成功 = 已发起跨服加入（复刻 App 内路径）。
  const joined = [];
  world.shell = {
    setAutostart: () => {},
    setServer: () => {},
    joinOnOrigin: (id, code) => { joined.push([id, code]); return true; },
    currentServerId: () => 'srv-1',
  };
  const out = L.tryMatchCandidates(list, (room) => L.joinRoom(room, { auto: true }));
  assert.equal(out.ok, true, '应继续到下一个候选并成功');
  assert.equal(out.room.code, 'BBBB');
  assert.equal(out.skipped, 1);
  assert.equal(out.hard, false);
  assert.match(out.note, /对局已开始，已跳过/, '提示必须是「对局已开始，已跳过」口径');
  assert.deepEqual(plain(joined), [['srv-1', 'BBBB']], '只尝试了真正可加入的那个房');
  unsub();
});

test('tryMatchCandidates：全部候选都在对局中 → 不死路（hard=false，提示带计数，可走房主路径）', () => {
  const { world } = mkWorld();
  const L = world.__SP_LOBBY;
  const out = L.tryMatchCandidates(
    [{ code: 'AAAA' }, { code: 'BBBB' }, { code: 'CCCC' }, { code: 'DDDD' }],
    () => ({ ok: false, reason: 'playing', note: '该房间对局进行中，暂不可加入。' }));
  assert.equal(out.ok, false);
  assert.equal(out.room, null);
  assert.equal(out.hard, false, '不是硬失败：调用方要接着走「你将是房主」');
  assert.equal(out.skipped, 3 + 1);
  assert.match(out.note, /对局已开始，已跳过 4 个房间/);
});

test('tryMatchCandidates：硬失败（服务器不可用等）保持旧行为——如实返回、不吞成跳过', () => {
  const { world } = mkWorld();
  const out = world.__SP_LOBBY.tryMatchCandidates(
    [{ code: 'AAAA' }], () => ({ ok: false, note: '加入失败：目标服务器当前不可用' }));
  assert.equal(out.hard, true);
  assert.equal(out.room.code, 'AAAA');
  assert.match(out.note, /目标服务器当前不可用/);
});

test('liveMatchRunning：上游 m.public（store.match.public）= 本会话对局已开始', () => {
  const { world } = mkWorld();
  const L = world.__SP_LOBBY;
  assert.equal(L.liveMatchRunning(), false, 'store 未就绪 → 不拦（保守）');
  L.__injectStore({ get: () => ({ room: null, match: { public: { phase: 'BATTLE' } } }) });
  assert.equal(L.liveMatchRunning(), true, 'm.public 非空 → 对局已开始');
  L.__injectStore({ get: () => ({ room: null, match: { public: null } }) });
  assert.equal(L.liveMatchRunning(), false, 'm.public 清空（__SP_BACK 的 emptyMatch）→ 可匹配');
});

test('结构钉子：start() 的守卫同时看 inMatch 与 m.public；候选走 matchCandidatesFor + auto 复核', () => {
  assert.ok(SRC.includes("if (inMatch() || liveMatchRunning()) { setView('error');"), '开启自动匹配前必须查 m.public');
  assert.ok(SRC.includes('joinRoom(room, { auto: true })'), '自动匹配的加入必须带 auto（竞态复核）');
  assert.ok(SRC.includes('tryMatchCandidates(list, function (room)'), '自动匹配必须按序尝试候选');
  assert.ok(SRC.includes("'对局已开始'") && SRC.includes("'，已跳过'"), '跳过提示文案必须保留（对局已开始，已跳过）');
});
