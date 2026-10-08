// 大厅面板「社区源」行为测试（v7.3，2026-10-08）：
//   ① 社区源一跳只有**一条**请求，且是合并形态 ?src=rainya,lunar（旧实现 rainya/lunar/rinko 各一条）；
//   ② 合并响应逐行带 src → 按 src 分桶；缺 src / 非白名单 src 的行直接丢（绝不猜来源）；
//   ③ 某源上游失败只把那个源标灰（errors），另一源的行照常进牌面；
//   ④ 整条中转失败 → 两个社区源一起标灰，房间牌不受影响；
//   ⑤ 300s 定时器驱动的仍是合并调用（每拍一条，不是三条）；
//   ⑥ 结构钉子：梨子湖（rinko）在这个文件里彻底下线（无 host / 无 source 键 / 无单源拉取）。
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
const flush = async () => { for (let i = 0; i < 6; i++) await flushHost(); };

/** 最小世界：fetch 记账、定时器记账（不自动跑）、可切换回复的房间牌/中转桩。 */
function mkWorld(opt) {
  const o = opt || {};
  const calls = [];
  const timers = [];
  const listeners = {};
  const state = {
    boardReply: o.boardReply || { ok: true, rooms: [] },
    communityReply: o.communityReply !== undefined
      ? o.communityReply
      : { ok: true, src: 'rainya,lunar', fetchedAt: 0, rooms: [] },
    communityFail: !!o.communityFail,
    communityStatus: o.communityStatus || 200,
  };
  const world = {
    console, URL, Promise, JSON, Math, String, Number, Array, Object, Boolean, isFinite,
    parseInt, parseFloat, encodeURIComponent, decodeURIComponent, Date,
  };
  world.setTimeout = (fn, ms) => { const t = { fn, ms, kind: 'timeout' }; timers.push(t); return t; };
  world.clearTimeout = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
  world.setInterval = (fn, ms) => { const t = { fn, ms, kind: 'interval' }; timers.push(t); return t; };
  world.clearInterval = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
  world.AbortSignal = { timeout: () => undefined };
  world.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  world.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  world.navigator = { userAgent: 'test' };
  world.location = { href: PAGE_ORIGIN + '/play', host: 'game.example.com', hostname: 'game.example.com', protocol: 'https:' };
  world.fetch = (url, init) => {
    const u = absUrl(url);
    calls.push({ url: u, init: init || {} });
    if (u.indexOf('/api/community') >= 0) {
      if (state.communityFail) return Promise.reject(new Error('offline'));
      return Promise.resolve({
        ok: state.communityStatus >= 200 && state.communityStatus < 300,
        status: state.communityStatus,
        json: () => Promise.resolve(state.communityReply),
      });
    }
    if (u.indexOf('/api/rooms') >= 0) {
      if ((init || {}).method === 'PATCH') return Promise.resolve(okJson({ ok: true }));
      return Promise.resolve(okJson(state.boardReply));
    }
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

const communityCalls = (calls) => calls.filter((c) => c.url.indexOf('/api/community') >= 0);
const codes = (world) => plain(world.__SP_LOBBY.rooms()).map((r) => r.code);

/** 订阅一次（= 布防轮询，首拍立刻发）并等桩落地。 */
async function pullOnce(world) {
  const unsub = world.__SP_LOBBY.subscribeRooms(() => {});
  await flush();
  return unsub;
}

const BOARD_ROW = {
  code: 'AAAA', serverId: 'weishu', server: '站长服务', status: 'waiting', leftSec: 300,
  url: 'https://weishu.jiangjiangze.icu/?room=AAAA',
};
const RAINYA_ROW = {
  code: 'KKKK', server: 'raiya', status: 'waiting', leftSec: 300,
  url: 'https://game.rainya.me/?room=KKKK', src: 'rainya',
};
const LUNAR_ROW = {
  code: 'LLLL', serverId: 'lunar', server: 'Lunar', status: 'waiting', live: true, leftSec: 300,
  url: 'https://stronghold.lunar.ag/?room=LLLL', src: 'lunar',
};

test('v7.3: 社区源一跳只有一条请求（?src=rainya,lunar），逐行按 src 分桶进牌面', async () => {
  const { world, calls } = mkWorld({
    boardReply: { ok: true, rooms: [BOARD_ROW] },
    communityReply: { ok: true, src: 'rainya,lunar', fetchedAt: 0, rooms: [RAINYA_ROW, LUNAR_ROW] },
  });
  const unsub = await pullOnce(world);

  const relay = communityCalls(calls);
  assert.equal(relay.length, 1, '社区源一跳 = 一条合并请求（旧实现是 3 条）');
  assert.equal(relay[0].url, 'https://sp-lobby.jiangjiangze.icu/api/community?src=rainya,lunar');

  assert.deepEqual(codes(world).sort(), ['AAAA', 'KKKK', 'LLLL'], '本站 + 两源的行都在牌面上');
  const sources = plain(world.__SP_LOBBY.communitySources());
  assert.deepEqual(Object.keys(sources).sort(), ['board', 'lunar', 'rainya'], 'rinko 源已从状态表移除');
  assert.equal(sources.rainya.state, 'ok');
  assert.equal(sources.lunar.state, 'ok');
  assert.deepEqual(sources.rainya.list.map((r) => r.code), ['KKKK']);
  assert.deepEqual(sources.lunar.list.map((r) => r.code), ['LLLL'], '按 src 分桶，不串源');
  assert.equal(world.__SP_LOBBY.boardInfo().loading, false);
  unsub();
});

test('v7.3: 同主机同房号去重仍本站优先（合并调用不改这条规则）', async () => {
  const { world } = mkWorld({
    boardReply: { ok: true, rooms: [BOARD_ROW] },
    communityReply: { ok: true, src: 'rainya,lunar', fetchedAt: 0, rooms: [
      { ...RAINYA_ROW, code: 'AAAA', url: 'https://weishu.jiangjiangze.icu/?room=AAAA' },
    ] },
  });
  const unsub = await pullOnce(world);
  const rows = plain(world.__SP_LOBBY.rooms()).filter((r) => r.code === 'AAAA');
  assert.equal(rows.length, 1, '同主机同房号只留一条');
  assert.equal(rows[0].serverId, 'weishu', '本站那条胜出');
  unsub();
});

test('v7.3: 缺 src / 非白名单 src 的行直接丢（绝不猜来源）', async () => {
  const { world } = mkWorld({
    communityReply: { ok: true, src: 'rainya,lunar', fetchedAt: 0, rooms: [
      { code: 'MMMM', server: 'raiya', status: 'waiting', leftSec: 300 },                    // 无 src
      { code: 'NNNN', serverId: 'rinko', server: '梨子湖', status: 'waiting', leftSec: 300, src: 'rinko' }, // 已下线源
      RAINYA_ROW,
    ] },
  });
  const unsub = await pullOnce(world);
  assert.deepEqual(codes(world), ['KKKK'], '只有归属明确的行留下');
  unsub();
});

test('v7.3: 一个上游失败只把那个源标灰，另一源的行照常', async () => {
  const { world } = mkWorld({
    communityReply: { ok: true, src: 'rainya,lunar', fetchedAt: 0, rooms: [LUNAR_ROW], errors: { rainya: 'UPSTREAM' } },
  });
  const unsub = await pullOnce(world);
  const info = plain(world.__SP_LOBBY.boardInfo());
  assert.deepEqual(info.srcNotes, ['社区房间源（raiya）暂不可达'], '只点名失败的那个源');
  assert.equal(info.loading, false, '有一个源成功就不算加载中');
  const sources = plain(world.__SP_LOBBY.communitySources());
  assert.equal(sources.rainya.state, 'error');
  assert.equal(sources.lunar.state, 'ok');
  assert.deepEqual(codes(world), ['LLLL'], 'Lunar 的行照常进牌面');
  unsub();
});

test('v7.3: 整条中转失败 → 两个社区源一起标灰，房间牌不受影响', async () => {
  const { world } = mkWorld({ boardReply: { ok: true, rooms: [BOARD_ROW] }, communityFail: true });
  const unsub = await pullOnce(world);
  const info = plain(world.__SP_LOBBY.boardInfo());
  assert.deepEqual(info.srcNotes.slice().sort(),
    ['社区房间源（Lunar）暂不可达', '社区房间源（raiya）暂不可达']);
  assert.deepEqual(codes(world), ['AAAA'], '房间牌自己那一跳不受中转影响');
  unsub();
});

test('v7.3: 中转 5xx / 载荷不符也算失败（不会把空 rooms 当成"两源都没房"）', async () => {
  for (const opt of [
    { communityStatus: 502, communityReply: { ok: false, error: 'UPSTREAM' } },
    { communityReply: { ok: true, rooms: null } },
    { communityReply: null },
  ]) {
    const { world } = mkWorld(opt);
    const unsub = await pullOnce(world);
    const sources = plain(world.__SP_LOBBY.communitySources());
    assert.equal(sources.rainya.state, 'error', JSON.stringify(opt));
    assert.equal(sources.lunar.state, 'error', JSON.stringify(opt));
    unsub();
  }
});

test('v7.3: 300s 定时器驱动的仍是合并调用（每拍一条，不是三条）', async () => {
  const { world, calls, timers } = mkWorld({
    communityReply: { ok: true, src: 'rainya,lunar', fetchedAt: 0, rooms: [RAINYA_ROW, LUNAR_ROW] },
  });
  const unsub = await pullOnce(world);
  const before = communityCalls(calls).length;
  assert.equal(before, 1, '首拍一条');

  const communityTimers = timers.filter((t) => t.kind === 'interval' && t.ms === 300000);
  assert.equal(communityTimers.length, 1, '只有一个社区定时器');
  communityTimers[0].fn();
  await flush();
  assert.equal(communityCalls(calls).length, before + 1, '第二拍仍是一条（不是三条）');
  unsub();
});

test('v7.3: 结构钉子 —— 梨子湖彻底下线，社区源只剩一条合并地址', () => {
  assert.ok(!/xn--rlr/.test(SRC), 'no rinko host left in the panel');
  assert.ok(!/'rinko'/.test(SRC) && !/"rinko"/.test(SRC), 'no rinko source key left');
  assert.ok(!SRC.includes("COMMUNITY + 'rinko'"), 'no per-source rinko pull');
  assert.ok(!SRC.includes("pullBoardSource('rainya'"), 'rainya no longer has its own request');
  assert.ok(!SRC.includes("pullBoardSource('lunar'"), 'lunar no longer has its own request');
  assert.ok(SRC.includes("var COMMUNITY_KEYS = ['rainya', 'lunar'];"), 'the two sources are declared once');
  assert.ok(SRC.includes("COMMUNITY_KEYS.join(',')"), 'the combined call is built from that list');
});
