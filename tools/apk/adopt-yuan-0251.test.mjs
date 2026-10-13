// adopt-yuan-0251.test.mjs —— 审计 Paper-Yuan 0.2.5.1 后取用的两条通道（模式同 PR #161）。
//
//   node --test tools/apk/adopt-yuan-0251.test.mjs
//
// 取用件 1：客户端 WS 目标覆盖（他的 a04ef489：`?ws=` / localStorage `sp_ws_url`），
//   **不带**他的 net.js:109-110 `*.pages.dev` 改写（那是把玩家 hello/token 送到他自建后门的中心化劫持），
//   并加一条他 no 有的护栏：明文 `ws:` 只许私网/回环。
// 取用件 2：房主侧下发本机当前配置（`stronghold-client.json`，契约 schema 1）—— 他模型里加入方整页
//   跑房主 origin，所以「加入方按服务器逻辑加载对方配置」要求房主真的答这份文档。
//
// 全部离线：无网络、无浏览器；controller 用 req/res 替身（同 overlay-sp-host.test.mjs 的形状）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { allowedWsUrl, defaultWsUrl, isPrivateWsHost, wsOverride } from '../../public/js/net.js';
import {
  CLIENT_CONFIG_MAX_TTL,
  CLIENT_CONFIG_SCHEMA,
  ROUTE_CLIENT_CONFIG,
  ROUTE_CLIENT_CONFIG_WK,
  buildClientConfig,
  createController,
  sanitizeClientConfig,
} from './overlay/sp-host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 取用件 1：WS 目标覆盖

test('isPrivateWsHost：回环/私网/链路本地为真，公网与域名假', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.7', '172.16.0.1', '172.31.255.255',
    '100.64.0.1', '100.127.255.255', '169.254.9.9', '::1', '[::1]', 'fe80::1', 'room.local', 'x.internal']) {
    assert.equal(isPrivateWsHost(h), true, `${h} 应判私网`);
  }
  for (const h of ['172.32.0.1', '100.63.9.9', '100.128.0.1', '8.8.8.8', 'example.com', 'sp.isomer319.xyz', '', 'weishucdn.jiangjiangze.icu']) {
    assert.equal(isPrivateWsHost(h), false, `${h} 不应判私网`);
  }
});

test('私网表与 LanNet.java 同口径（#161 定的「门不许两张表漂移」）', () => {
  // 客户端明文 ws: 的许可面必须跟壳侧局域网判定同段；静态读 Java 源，防以后单边加段。
  const java = fs.readFileSync(path.join(here, '..', '..', 'android', 'app', 'src', 'main', 'java',
    'icu', 'jiangjiangze', 'stronghold', 'LanNet.java'), 'utf8');
  const band = (re, label) => assert.match(java, re, `LanNet.java 的 ${label} 段形态变了 ⇒ 同步改 isPrivateWsHost`);
  band(/n\[0\] == 10\)/, '10/8');
  band(/n\[0\] == 192 && n\[1\] == 168/, '192.168/16');
  band(/n\[0\] == 172 && n\[1\] >= 16 && n\[1\] <= 31/, '172.16/12');
  band(/n\[0\] == 100 && n\[1\] >= 64 && n\[1\] <= 127/, 'CGNAT 100.64/10');
  // LanNet 不认 169.254/16；客户端多认这一段只是「本机 ws: 便利」，不参与扫描白名单
  assert.doesNotMatch(java, /n\[0\] == 169/, 'LanNet 若新增了 169.254 段，本注释与断言都要重读');
});

test('allowedWsUrl：只接受无凭据的 ws/wss，明文限私网', () => {
  assert.equal(allowedWsUrl('wss://play.example.com/ws'), 'wss://play.example.com/ws', 'wss 公网放行');
  assert.equal(allowedWsUrl('ws://127.0.0.1:3000/ws'), 'ws://127.0.0.1:3000/ws', '明文回环放行');
  assert.equal(allowedWsUrl('ws://192.168.1.9:3000/ws?room=ABCD'), 'ws://192.168.1.9:3000/ws?room=ABCD', '明文私网带 query 放行');
  assert.equal(allowedWsUrl('ws://evil.example.com/ws'), null, '明文公网必须拒（hello/token 不外发明文）');
  assert.equal(allowedWsUrl('https://example.com/ws'), null, '不是 ws 协议');
  assert.equal(allowedWsUrl('//example.com/ws'), null, '协议相对');
  assert.equal(allowedWsUrl('/ws'), null, '相对路径（会指回本页 origin，不算覆盖）');
  assert.equal(allowedWsUrl('wss://user:pass@example.com/ws'), null, 'URL 里带凭据必须拒');
  for (const junk of [null, undefined, '', 42, {}, [], 'wss://']) assert.equal(allowedWsUrl(junk), null);
});

test('wsOverride / defaultWsUrl：?ws= 生效，且不带他的 pages.dev 劫持', () => {
  const loc = { protocol: 'https:', host: 'some-server.pages.dev', search: '?ws=wss%3A%2F%2Frelay.example%2Fws' };
  assert.equal(wsOverride(loc), 'wss://relay.example/ws', 'query 覆盖生效');
  assert.equal(defaultWsUrl(loc), 'wss://relay.example/ws');
  // 关键回归钉：没有覆盖时，*.pages.dev 必须还是同源 —— 他的 net.js:109-110 把这里改写成他的 Render
  assert.equal(defaultWsUrl({ protocol: 'https:', host: 'x.pages.dev', search: '' }), 'wss://x.pages.dev/ws');
  assert.equal(defaultWsUrl({ protocol: 'http:', host: '127.0.0.1:3000', search: '' }), 'ws://127.0.0.1:3000/ws');
  // 恶意/畸形覆盖一律回落同源，绝不抛
  assert.equal(defaultWsUrl({ protocol: 'https:', host: 'a.example', search: '?ws=ws%3A%2F%2Fpublic.example%2Fws' }), 'wss://a.example/ws');
  assert.equal(defaultWsUrl({ protocol: 'https:', host: 'a.example', search: '?ws=not%20a%20url' }), 'wss://a.example/ws');
  assert.equal(defaultWsUrl({ protocol: 'https:', host: 'a.example', search: '?ws=' }), 'wss://a.example/ws');
});

test('Net 的连接入口继续优先用显式 url（管道未被他改动破坏）', () => {
  // net.js 的 connect() 用 `this.url || defaultWsUrl()`：显式注入优先，其次才是覆盖/同源
  const src = new (class { constructor(o) { this.url = o.url || null; } pick(loc) { return this.url || defaultWsUrl(loc); } })({ url: 'wss://explicit.example/ws' });
  assert.equal(src.pick({ protocol: 'https:', host: 'a.example', search: '?ws=wss%3A%2F%2Fq.example%2Fws' }), 'wss://explicit.example/ws');
});

// ---------------------------------------------------------------- 取用件 2：房主下发配置

test('buildClientConfig：schema 1、版本单调、无公告也答得出最小文档', () => {
  let t = 1_700_000_000_000;
  const env = {};
  const a = buildClientConfig({ app: '0.2.5', protocol: 1 }, env, () => t);
  assert.equal(a.schema, CLIENT_CONFIG_SCHEMA);
  assert.equal(a.version, 1_700_000_000, '版本 = 秒级时钟（重启/改内容都只会变大，客户端的「更小即丢弃」不会冻住缓存）');
  assert.equal(a.ttl, 300);
  assert.deepEqual(a.resources, { serveAssets: false }, '默认不声称本机发素材');
  assert.deepEqual(a.client, { minShellApi: 1 });
  assert.ok(!a.announce, '没设公告就没有 announce 块');
  t += 60_000;
  assert.ok(buildClientConfig(null, env, () => t).version > a.version, '时间推进 ⇒ 版本推进');
});

test('buildClientConfig：env 显式项优先，announce 只在有正文时出块', () => {
  const doc = buildClientConfig({ app: '0.2.5.1', protocol: 1 }, {
    SP_CLIENT_CONFIG_VERSION: '9',
    SP_CLIENT_SERVER_ID: 'lan-房主机'.slice(0, 64),
    SP_CLIENT_TTL: '999999',
    SP_SERVE_ASSETS: '1',
    SP_CLIENT_ANNOUNCE: '今晚 22:00 维护',
    SP_CLIENT_ANNOUNCE_LEVEL: 'warn',
  }, () => 1);
  assert.equal(doc.version, 9);
  assert.equal(doc.ttl, CLIENT_CONFIG_MAX_TTL, 'ttl 顶到 86400 上限');
  assert.equal(doc.resources.serveAssets, true);
  assert.deepEqual(doc.announce, { enabled: true, title: '', body: '今晚 22:00 维护', level: 'warn' });
  // 空正文 ⇒ 不出块（否则公告板会把「无公告」显示成空条目）
  assert.ok(!buildClientConfig(null, { SP_CLIENT_ANNOUNCE: '   ' }, () => 1).announce);
});

test('sanitizeClientConfig：契约 §3 的「服务器不许做的事」在出网前就不可表达', () => {
  const urlish = sanitizeClientConfig({
    schema: 1, version: 3,
    announce: { enabled: true, body: 'hi', image: 'https://evil.example/a.png' },
    matchmaking: { enabled: true, endpoint: '/api/match' },
  });
  assert.ok(urlish, '正文可发');
  assert.ok(!JSON.stringify(urlish).includes('evil.example'), '任何绝对 URL 的值被整条丢弃');
  assert.equal(urlish.matchmaking.endpoint, '/api/match', '站内相对路径保留');
  assert.ok(!('matchmaking' in sanitizeClientConfig({ matchmaking: { enabled: true, endpoint: '//evil.example/x' }, version: 1 })),
    '协议相对 endpoint 整块丢掉');
  assert.equal(sanitizeClientConfig({ schema: 2, version: 1 }), null, 'schema 比客户端高 ⇒ 不发（语义可能不同）');
  assert.equal(sanitizeClientConfig(null), null);
  assert.equal(sanitizeClientConfig([]), null);
  assert.equal(sanitizeClientConfig('x'), null);
  const bumped = sanitizeClientConfig({ schema: 1, version: 1, ttl: -5 });
  assert.equal(bumped.ttl, 300, '非法 ttl 回落 300');
  const big = sanitizeClientConfig({ schema: 1, version: 1, announce: { enabled: true, body: 'x'.repeat(4001) } });
  assert.equal(big.announce.body.length, 4000, '正文截到 4000');
  const huge = sanitizeClientConfig({
    schema: 1, version: 1,
    features: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`f${i}`, { enabled: true, mode: 'config' }])),
    featurePacks: Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, version: i })),
    serverId: 's'.repeat(5000),
    announce: { enabled: true, body: 'x'.repeat(50000), title: 't'.repeat(5000) },
  });
  assert.ok(huge, '超限的字段各自被钳住，不必整份丢');
  assert.ok(Buffer.byteLength(JSON.stringify(huge), 'utf8') <= 256 * 1024, '出网正文有界（契约 §4 的 256 KB 由构造保证）');
  assert.equal(Object.keys(huge.features).length, 64);
  assert.equal(huge.featurePacks.length, 16);
  assert.equal(huge.serverId.length, 64);
  const packs = sanitizeClientConfig({
    schema: 1, version: 2,
    featurePacks: [{ id: 'match-v2', version: 3, url: 'https://evil.example/p.zip' }, { id: 'bad' }],
    features: { eventB: { enabled: true, mode: 'pack', startAt: 1, endAt: 2, junk: 'https://x.example' } },
  });
  assert.deepEqual(packs.featurePacks, [{ id: 'match-v2', version: 3 }], 'featurePacks 只留 {id,version}，url 不存在');
  assert.deepEqual(packs.features.eventB, { enabled: true, mode: 'pack', startAt: 1, endAt: 2 });
});

// ---------------------------------------------------------------- 路由行为

function fakeReq(url, method = 'GET', remoteAddress = '192.168.1.20') {
  const req = new EventEmitter();
  Object.assign(req, { url, method, headers: {}, socket: { remoteAddress } });
  return req;
}
function fakeRes() {
  return {
    headers: {}, status: 0, body: '',
    setHeader(n, v) { this.headers[String(n).toLowerCase()] = v; },
    writeHead(s, h) { this.status = s; if (h) for (const k of Object.keys(h)) this.headers[k.toLowerCase()] = h[k]; },
    end(b) { this.body = b == null ? '' : String(b); },
  };
}

test('GET /stronghold-client.json 与 /.well-known/ 同体；上游 dot-path 404 由本路由补上', () => {
  const c = createController({ versions: { app: '0.2.5', protocol: 1 }, env: {}, now: () => 1_700_000_000_000 });
  for (const path of [ROUTE_CLIENT_CONFIG, ROUTE_CLIENT_CONFIG_WK]) {
    const res = fakeRes();
    assert.equal(c.handleRequest(fakeReq(path), res), true, path);
    assert.equal(res.status, 200);
    const doc = JSON.parse(res.body);
    assert.equal(doc.schema, 1);
    assert.equal(doc.version, 1_700_000_000);
    assert.equal(res.headers['access-control-allow-origin'], '*', '壳在「本地页面 + 远端 WS」形态下要能跨源读这份公开文档');
  }
  const head = fakeRes();
  assert.equal(c.handleRequest(fakeReq(ROUTE_CLIENT_CONFIG, 'HEAD'), head), true);
  assert.equal(head.status, 200);
  assert.equal(head.body, '', 'HEAD 不发正文');
  const post = fakeRes();
  assert.equal(c.handleRequest(fakeReq(ROUTE_CLIENT_CONFIG, 'POST'), post), false, '非 GET/HEAD 交回上游的 405 门');
  assert.equal(c.handleRequest(fakeReq('/ws'), fakeRes()), false, '协议面绝不被本路由顶掉');
  assert.equal(c.handleRequest(fakeReq('/healthz'), fakeRes()), false, '/healthz 仍由上游答');
});

test('业主自己放了 public/stronghold-client.json ⇒ 本路由让位（契约 §7 的零改动路径）', () => {
  const seen = [];
  const c = createController({
    versions: { app: '0.2.5', protocol: 1 }, env: {}, now: () => 1,
    publicDir: '/webroot/public',
    fileExists: (p) => { seen.push(p); return true; },
  });
  assert.equal(c.handleRequest(fakeReq(ROUTE_CLIENT_CONFIG), fakeRes()), false, '有业主文件 ⇒ 转给上游静态');
  assert.equal(seen[0].replace(/\\/g, '/'), '/webroot/public/stronghold-client.json');
  const c2 = createController({ versions: null, env: {}, now: () => 1, publicDir: null, fileExists: () => true });
  assert.equal(c2.handleRequest(fakeReq(ROUTE_CLIENT_CONFIG), fakeRes()), true, '没有 publicDir ⇒ 合成照发');
});

test('配置文档坏了不发 ⇒ 页面行为与「这台服没发文档」逐字一致（服务器永不是启动依赖）', () => {
  const c = createController({
    versions: null,
    env: { SP_CLIENT_CONFIG_VERSION: 'not-a-number' },
    now: () => Number.NaN,
  });
  const res = fakeRes();
  const handled = c.handleRequest(fakeReq(ROUTE_CLIENT_CONFIG), res);
  assert.ok(!handled || res.status === 200, '要么不发（转上游 404），要么发得出合法文档；绝不发 NaN');
  if (handled) assert.ok(Number.isInteger(JSON.parse(res.body).version), 'version 必须是整数');
});
