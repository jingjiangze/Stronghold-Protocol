// overlay-sp-assets.test.mjs — tests for tools/apk/overlay/sp-assets.mjs (the /assets/** policy overlay).
//
//   node --test tools/apk/overlay-sp-assets.test.mjs
//
// No external network: every fetch is an injected fake, every directory is a temp tree. The suite
// pins the decision order, namespace adoption (old dir reused, no refetch), "never verify a hit",
// write-time streaming verify, LRU prune, page-over-prefetch priority, URL rejection (localhost /
// private / reserved / non-http, and "a refused target is never contacted"), and flag-off inertness.
// The CDN base / allow-list are pinned against tools/apk/line.mjs so the runtime literal cannot drift
// from the line's namespace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  overlayApi,
  id,
  install,
  createController,
  createPool,
  resolveFlag,
  safeHash,
  isValidNamespace,
  namespaceOf,
  pruneRank,
  pickAdoptable,
  isSafeRel,
  assetPathOf,
  cacheRelPath,
  cdnUrlFor,
  normalizeHost,
  parseIpv4,
  isBlockedIpv4,
  isBlockedIpv6,
  isBlockedLiteral,
  isAllowedHost,
  normalizeIp,
  isLocalIp,
  isPrefetchRequest,
  parseAssetRequest,
  mimeFor,
  placeholderHeaders,
  createManifestHashReader,
  DEFAULT_CDN_BASE,
  ALLOWED_HOSTS,
  FALLBACK_HASH,
  STATUS_PATH,
  PREFETCH_PREFIX,
} from './overlay/sp-assets.mjs';
import { CDN, ASSETS_BASE } from './line.mjs';

const TMP = [];

function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-assets-'));
  TMP.push(d);
  return d;
}

test.after(() => {
  for (const d of TMP) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

/** A fetch fake whose body is a real async iterable, counting how many times it was iterated. */
function fakeFetch(bytes, opts = {}) {
  const calls = [];
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
  const state = { iterated: 0 };
  const impl = (url, init) => {
    calls.push({ url, init });
    if (opts.throwNetwork) return Promise.reject(new Error('network down'));
    if (opts.redirect) return Promise.resolve({ status: 302, headers: { get: () => null }, body: null });
    const status = opts.status ?? 200;
    if (status < 200 || status >= 300) return Promise.resolve({ status, headers: { get: () => null }, body: null });
    const chunks = opts.chunks || [body];
    async function* gen() {
      state.iterated += 1;
      for (const c of chunks) yield Buffer.isBuffer(c) ? c : Buffer.from(c);
    }
    return Promise.resolve({
      status,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(body.length) : null) },
      body: gen(),
    });
  };
  impl.calls = calls;
  impl.state = state;
  return impl;
}

/** A controller over a temp webroot/art tree. */
function mkController(overrides = {}) {
  const root = overrides.root || mkTmp();
  const webrootDir = overrides.webrootDir || path.join(root, 'webroot');
  const artRoot = overrides.artRoot || path.join(root, 'art');
  fs.mkdirSync(webrootDir, { recursive: true });
  fs.mkdirSync(artRoot, { recursive: true });
  return createController({
    webrootDir,
    artRoot,
    manifestHash: overrides.manifestHash ?? 'hashA',
    log: () => {},
    ...overrides,
  });
}

/** A fetch fake keyed by file name (the last path segment): known → 200 bytes, else 404. */
function fakeFetchMap(files, opts = {}) {
  const calls = [];
  const impl = (url) => {
    calls.push(url);
    const name = new URL(url).pathname.split('/').pop();
    if (Object.prototype.hasOwnProperty.call(files, name)) {
      const bytes = Buffer.from(files[name]);
      async function* gen() { yield bytes; }
      return Promise.resolve({
        status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(bytes.length) : null) },
        body: gen(),
      });
    }
    return Promise.resolve({ status: opts.missingStatus ?? 404, headers: { get: () => null }, body: null });
  };
  impl.calls = calls;
  return impl;
}

/** Fake req/res for the controller's synchronous dispatch (no socket). */
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}); return this; },
    end(b) { this.body = b; },
    destroy() {},
  };
  return res;
}

// ---------------------------------------------------------------- contract + line pinning

test('overlay contract: overlayApi 1 and id sp-assets', () => {
  assert.equal(overlayApi, 1);
  assert.equal(id, 'sp-assets');
});

test('CDN base + allow-list mirror tools/apk/line.mjs (the line namespace)', () => {
  assert.equal(DEFAULT_CDN_BASE, ASSETS_BASE);
  assert.ok(ALLOWED_HOSTS.includes(new URL(CDN).host));
});

// ---------------------------------------------------------------- pure helpers

test('safeHash / isValidNamespace / namespaceOf / pruneRank', () => {
  assert.equal(safeHash('abc123'), 'abc123');
  assert.equal(safeHash(''), FALLBACK_HASH);
  assert.equal(safeHash(null), FALLBACK_HASH);
  assert.equal(safeHash('a/b'), FALLBACK_HASH);
  assert.equal(safeHash('x'.repeat(65)), FALLBACK_HASH);
  assert.equal(isValidNamespace('abc'), true);
  assert.equal(isValidNamespace('..'), false);
  assert.equal(namespaceOf('abc/assets/x.png'), 'abc');
  assert.equal(namespaceOf('/abc/assets/x.png'), 'abc');
  assert.equal(namespaceOf('abc'), null);
  assert.equal(pruneRank('cur/assets/x', 'cur'), 1);
  assert.equal(pruneRank('old/assets/x', 'cur'), 0);
  assert.equal(pruneRank('junk', 'cur'), 0);
});

test('pickAdoptable picks the newest valid non-current namespace', () => {
  assert.equal(pickAdoptable('new', ['old', 'older']), 'old');
  assert.equal(pickAdoptable('new', ['new', 'old']), 'old');
  assert.equal(pickAdoptable('new', ['..', 'new']), null);
  assert.equal(pickAdoptable('new', []), null);
});

test('isSafeRel rejects traversal and empty segments', () => {
  assert.equal(isSafeRel('a/b.png'), true);
  assert.equal(isSafeRel('a/../b'), false);
  assert.equal(isSafeRel('/a'), false);
  assert.equal(isSafeRel('a/'), false);
  assert.equal(isSafeRel('a//b'), false);
});

test('assetPathOf maps both CDN and local forms to /assets/<rel>', () => {
  assert.equal(assetPathOf('/assets/x.png'), '/assets/x.png');
  assert.equal(assetPathOf(`${CDN}/assets-re/x.png`), '/assets/x.png');
  assert.equal(assetPathOf('https://jingjiangze.github.io/Stronghold-Protocol/assets/x.png'), '/assets/x.png');
  assert.equal(assetPathOf('/data/x.json'), null);
});

test('cacheRelPath is namespaced and rejects traversal', () => {
  assert.equal(cacheRelPath('h1', '/assets/a/b.png'), 'h1/assets/a/b.png');
  assert.equal(cacheRelPath('h1', '/assets/../x'), null);
  assert.equal(cacheRelPath('h1', '/data/x'), null);
  assert.equal(cacheRelPath('../h', '/assets/x'), `${FALLBACK_HASH}/assets/x`);
});

test('cdnUrlFor builds from the base and refuses non-asset paths', () => {
  assert.equal(cdnUrlFor('/assets/x.png', 'https://h/assets-re/'), 'https://h/assets-re/x.png');
  assert.equal(cdnUrlFor('/assets/x.png', 'https://h/assets-re'), 'https://h/assets-re/x.png');
  assert.equal(cdnUrlFor('/data/x', 'https://h/'), null);
});

test('IPv4 parsing covers dotted / octal / hex / single-integer forms', () => {
  assert.equal(parseIpv4('127.0.0.1'), 0x7f000001);
  assert.equal(parseIpv4('2130706433'), 0x7f000001);
  assert.equal(parseIpv4('0x7f000001'), 0x7f000001);
  assert.equal(parseIpv4('0177.0.0.1'), 0x7f000001);
  assert.equal(parseIpv4('10.0.0.5'), 0x0a000005);
  assert.equal(parseIpv4('not.an.ip'), null);
  assert.equal(parseIpv4('999.1.1.1'), null);
});

test('blocked literals: loopback / private / reserved / documentation / IPv6', () => {
  for (const h of ['127.0.0.1', '127.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1',
    '100.64.0.1', '0.0.0.0', '198.51.100.7', '203.0.113.9', '224.0.0.1', '255.255.255.255',
    'localhost', 'x.localhost', '::1', '::', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1', '[::1]']) {
    assert.equal(isBlockedLiteral(h), true, `${h} should be blocked`);
  }
  assert.equal(isBlockedLiteral('weishucdn.jiangjiangze.icu'), false);
  assert.equal(isBlockedLiteral('example.com'), false);
});

test('isBlockedIpv4 / isBlockedIpv6 direct', () => {
  assert.equal(isBlockedIpv4(parseIpv4('192.168.0.1')), true);
  assert.equal(isBlockedIpv4(parseIpv4('8.8.8.8')), false);
  assert.equal(isBlockedIpv6('fe80::1'), true);
  assert.equal(isBlockedIpv6('2001:4860:4860::8888'), false);
});

test('isAllowedHost: only our hosts, never a blocked literal', () => {
  assert.equal(isAllowedHost('weishucdn.jiangjiangze.icu'), true);
  assert.equal(isAllowedHost('WEISHUCDN.JIANGJIANGZE.ICU.'), true);
  assert.equal(isAllowedHost('example.com'), false);
  assert.equal(isAllowedHost('127.0.0.1'), false);
  assert.equal(isAllowedHost('weishucdn.jiangjiangze.icu', ['example.com']), false);
});

test('normalizeHost / normalizeIp / isLocalIp', () => {
  assert.equal(normalizeHost('[::1]'), '::1');
  assert.equal(normalizeHost('EXAMPLE.com.'), 'example.com');
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp('127.0.0.1:5555'), '127.0.0.1');
  assert.equal(isLocalIp('127.0.0.1'), true);
  assert.equal(isLocalIp('192.168.1.9'), true);
  assert.equal(isLocalIp('8.8.8.8'), false);
  assert.equal(isLocalIp('::1'), true);
});

test('prefetch marking: header, query and the /__sp/pf prefix', () => {
  assert.equal(isPrefetchRequest({ 'x-sp-prefetch': '1' }), true);
  assert.equal(isPrefetchRequest({ 'X-SP-Prefetch': '0' }), false);
  assert.equal(isPrefetchRequest({}, 'sp_prefetch=1'), true);
  assert.equal(isPrefetchRequest({}, 'sp_prefetch=0'), false);
  const viaPrefix = parseAssetRequest(`${PREFETCH_PREFIX}x.png`, '', {});
  assert.deepEqual(viaPrefix, { assetPath: '/assets/x.png', rel: 'x.png', prefetch: true });
  assert.equal(parseAssetRequest('/assets/x.png', '', { 'x-sp-prefetch': 'yes' }).prefetch, true);
  assert.equal(parseAssetRequest('/assets/../x', '', {}), null);
  assert.equal(parseAssetRequest('/data/x', '', {}), null);
});

test('mimeFor + placeholder headers', () => {
  assert.equal(mimeFor('/assets/a/b.webp'), 'image/webp');
  assert.equal(mimeFor('/assets/a/b.unknown'), 'application/octet-stream');
  assert.equal(placeholderHeaders()['Cache-Control'], 'no-store');
  assert.equal(placeholderHeaders()['Access-Control-Allow-Origin'], '*');
});

test('createManifestHashReader reads the top-level hash and falls back to v0', () => {
  const dir = mkTmp();
  const f = path.join(dir, 'assets.json');
  const read = createManifestHashReader(f);
  assert.equal(read(), FALLBACK_HASH); // missing
  write(f, JSON.stringify({ version: 1, hash: 'b699458e3e10' }));
  assert.equal(read(), 'b699458e3e10');
  write(f, JSON.stringify({ version: 2, hash: 'a/b' }));
  assert.equal(read(), FALLBACK_HASH); // unsafe value collapses
});

// ---------------------------------------------------------------- flag

test('resolveFlag defaults OFF and honours env + config file', () => {
  assert.equal(resolveFlag({ env: {} }).enabled, false);
  assert.equal(resolveFlag({ env: {} }).source, 'default');
  assert.equal(resolveFlag({ env: { SP_ASSETS_OVERLAY: '1' } }).enabled, true);
  assert.equal(resolveFlag({ env: { SP_ASSETS_OVERLAY: 'true' } }).enabled, true);
  assert.equal(resolveFlag({ env: { SP_ASSETS_OVERLAY: 'on' } }).enabled, true);
  assert.equal(resolveFlag({ env: { SP_ASSETS_OVERLAY: '0' } }).enabled, false);
  assert.equal(resolveFlag({ env: { SP_ASSETS_OVERLAY: 'no' } }).enabled, false);

  const dir = mkTmp();
  const cfg = write(path.join(dir, 'sp-assets.json'), JSON.stringify({ enabled: true }));
  const on = resolveFlag({ env: { SP_ASSETS_CONFIG: cfg } });
  assert.equal(on.enabled, true);
  assert.equal(on.source, 'config');

  // env wins over the config file
  assert.equal(resolveFlag({ env: { SP_ASSETS_CONFIG: cfg, SP_ASSETS_OVERLAY: '0' } }).enabled, false);

  // a webroot/data/sp-assets.json is found via upstreamDir
  const webroot = path.join(mkTmp(), 'webroot');
  write(path.join(webroot, 'data', 'sp-assets.json'), JSON.stringify({ enabled: true }));
  const viaWebroot = resolveFlag({ env: {}, upstreamDir: path.join(webroot, 'server') });
  assert.equal(viaWebroot.enabled, true);
});

// ---------------------------------------------------------------- decision order

test('decision order: local tree wins over everything', async () => {
  const root = mkTmp();
  const webrootDir = path.join(root, 'webroot');
  const artRoot = path.join(root, 'art');
  write(path.join(webrootDir, 'assets', 'x.png'), 'LOCAL');
  write(path.join(artRoot, 'packs', 'aaa', 'assets', 'x.png'), 'PACK');
  write(path.join(artRoot, 'cache', 'hashA', 'assets', 'x.png'), 'CACHE');
  const c = mkController({ root, webrootDir, artRoot, fetchImpl: fakeFetch('CDN') });
  const out = await c.resolve('/assets/x.png', false);
  assert.equal(out.layer, 'local');
  assert.equal(fs.readFileSync(out.file, 'utf8'), 'LOCAL');
});

test('decision order: packs beat embedded/cache/CDN', async () => {
  const root = mkTmp();
  const webrootDir = path.join(root, 'webroot');
  const artRoot = path.join(root, 'art');
  const embedded = path.join(root, 'apk');
  write(path.join(artRoot, 'packs', 'aaa', 'assets', 'x.png'), 'PACK');
  write(path.join(embedded, 'assets', 'x.png'), 'EMBEDDED');
  write(path.join(artRoot, 'cache', 'hashA', 'assets', 'x.png'), 'CACHE');
  const fetchImpl = fakeFetch('CDN');
  const c = mkController({ root, webrootDir, artRoot, embeddedRoots: [embedded], fetchImpl });
  const out = await c.resolve('/assets/x.png', false);
  assert.equal(out.layer, 'pack');
  assert.equal(fetchImpl.calls.length, 0);
});

test('decision order: embedded beats cache/CDN; pack ids are scanned ascending', async () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  const embedded = path.join(root, 'apk');
  write(path.join(artRoot, 'packs', 'zzz', 'assets', 'x.png'), 'PACK-Z');
  write(path.join(artRoot, 'packs', 'aaa', 'assets', 'x.png'), 'PACK-A');
  write(path.join(embedded, 'assets', 'y.png'), 'EMBEDDED');
  write(path.join(artRoot, 'cache', 'hashA', 'assets', 'y.png'), 'CACHE');
  const c = mkController({ root, artRoot, embeddedRoots: [embedded], fetchImpl: fakeFetch('CDN') });
  assert.equal((await c.resolve('/assets/x.png', false)).layer, 'pack');
  assert.equal(fs.readFileSync(path.join(artRoot, 'packs', 'aaa', 'assets', 'x.png'), 'utf8'), 'PACK-A');
  assert.equal((await c.resolve('/assets/y.png', false)).layer, 'embedded');
});

test('decision order: cache hit is served without any fetch and without verification', async () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  write(path.join(artRoot, 'cache', 'hashA', 'assets', 'x.png'), 'CACHE');
  const fetchImpl = fakeFetch('CDN');
  let verifyCalls = 0;
  const c = mkController({
    root, artRoot, fetchImpl,
    expectedHashFor: () => { verifyCalls += 1; return 'deadbeef'; },
  });
  const out = await c.resolve('/assets/x.png', false);
  assert.equal(out.layer, 'cache');
  assert.equal(fs.readFileSync(out.file, 'utf8'), 'CACHE');
  assert.equal(fetchImpl.calls.length, 0, 'a cache hit must never touch the network');
  assert.equal(verifyCalls, 0, 'a cache hit must never be verified');
  assert.equal(c.status().verify.checked, 0);
});

test('decision order: miss → gated CDN fetch writes the cache, then serves it', async () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  const bytes = Buffer.from('CDN-BYTES');
  const fetchImpl = fakeFetch(bytes);
  const c = mkController({ root, artRoot, fetchImpl });
  const out = await c.resolve('/assets/x.png', false);
  assert.equal(out.layer, 'cdn');
  assert.equal(out.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(fetchImpl.state.iterated, 1, 'the body is streamed exactly once (no second read)');
  const cached = path.join(artRoot, 'cache', 'hashA', 'assets', 'x.png');
  assert.equal(fs.readFileSync(cached, 'utf8'), 'CDN-BYTES');
  assert.equal(fs.existsSync(cached + '.part'), false);
  assert.equal(fetchImpl.calls[0].url, `${DEFAULT_CDN_BASE}x.png`);
  // second request is a cache hit
  const again = await c.resolve('/assets/x.png', false);
  assert.equal(again.layer, 'cache');
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(c.status().hits, { local: 0, pack: 0, embedded: 0, cache: 1, cdn: 1, placeholder: 0 });
});

test('decision order: without a cache dir a CDN target cannot be cached → no layer', async () => {
  const root = mkTmp();
  const fetchImpl = fakeFetch('x');
  const c = createController({ webrootDir: path.join(root, 'webroot'), manifestHash: 'h', log: () => {}, fetchImpl });
  const out = await c.resolve('/assets/nope.png', false);
  assert.equal(out.layer, null);
  assert.equal(out.reason, 'no-cache-dir');
  assert.equal(fetchImpl.calls.length, 0);
});

// ---------------------------------------------------------------- namespace adoption

test('namespace adoption: old namespace is renamed onto the new one, no refetch', async () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  write(path.join(artRoot, 'cache', 'oldhash', 'assets', 'x.png'), 'OLD-BYTES');
  const fetchImpl = fakeFetch('CDN');
  const c = mkController({ root, artRoot, manifestHash: 'newhash', fetchImpl });
  const out = await c.resolve('/assets/x.png', false);
  assert.equal(out.layer, 'cache', 'the adopted bytes must be a cache hit');
  assert.equal(fs.readFileSync(out.file, 'utf8'), 'OLD-BYTES');
  assert.equal(fetchImpl.calls.length, 0, 'adoption must not refetch anything');
  assert.equal(fs.existsSync(path.join(artRoot, 'cache', 'oldhash')), false, 'old dir is gone (renamed)');
  assert.equal(fs.existsSync(path.join(artRoot, 'cache', 'newhash', 'assets', 'x.png')), true);
  assert.deepEqual(c.status().adopted, [{ from: 'oldhash', to: 'newhash' }]);
});

test('namespace adoption: an EMPTY new-namespace dir is a leftover and is replaced', async () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  write(path.join(artRoot, 'cache', 'oldhash', 'assets', 'x.png'), 'OLD-BYTES');
  fs.mkdirSync(path.join(artRoot, 'cache', 'newhash'), { recursive: true });
  const fetchImpl = fakeFetch('CDN');
  const c = mkController({ root, artRoot, manifestHash: 'newhash', fetchImpl });
  const out = await c.resolve('/assets/x.png', false);
  assert.equal(out.layer, 'cache');
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(fs.existsSync(path.join(artRoot, 'cache', 'newhash', 'assets', 'x.png')), true);
});

test('namespace adoption: a POPULATED new namespace is never merged into', async () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  write(path.join(artRoot, 'cache', 'oldhash', 'assets', 'x.png'), 'OLD');
  write(path.join(artRoot, 'cache', 'newhash', 'assets', 'y.png'), 'NEW');
  const c = mkController({ root, artRoot, manifestHash: 'newhash', fetchImpl: fakeFetch('CDN') });
  const out = await c.resolve('/assets/y.png', false);
  assert.equal(out.layer, 'cache');
  assert.equal(fs.existsSync(path.join(artRoot, 'cache', 'oldhash')), true, 'no adoption when the new ns is populated');
  assert.equal(c.status().adopted.length, 0);
});

test('namespace adoption happens once per hash per controller', async () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  write(path.join(artRoot, 'cache', 'oldhash', 'assets', 'x.png'), 'OLD');
  const c = mkController({ root, artRoot, manifestHash: 'newhash', fetchImpl: fakeFetch('CDN') });
  c.cacheNamespace();
  c.cacheNamespace();
  assert.equal(c.status().adopted.length, 1);
});

// ---------------------------------------------------------------- write-time verify

test('write-time verify: correct expected sha256 accepts the bytes', async () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  const bytes = Buffer.from('VERIFY-ME');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const c = mkController({ root, artRoot, fetchImpl: fakeFetch(bytes), expectedHashFor: () => sha });
  const out = await c.resolve('/assets/x.png', false);
  assert.equal(out.layer, 'cdn');
  assert.equal(c.status().verify.checked, 1);
  assert.equal(c.status().verify.failed, 0);
  assert.equal(fs.readFileSync(path.join(artRoot, 'cache', 'hashA', 'assets', 'x.png'), 'utf8'), 'VERIFY-ME');
});

test('write-time verify: a mismatched expected sha256 rejects and leaves no file', async () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  const c = mkController({ root, artRoot, fetchImpl: fakeFetch('TAMPERED'), expectedHashFor: () => 'ab'.repeat(32) });
  const out = await c.resolve('/assets/x.png', false);
  assert.equal(out.layer, null);
  assert.equal(out.reason, 'sha256');
  assert.equal(c.status().verify.failed, 1);
  const cached = path.join(artRoot, 'cache', 'hashA', 'assets', 'x.png');
  assert.equal(fs.existsSync(cached), false);
  assert.equal(fs.existsSync(cached + '.part'), false);
});

test('streamed hash is computed from the fetched chunks (multi-chunk)', async () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  const chunks = [Buffer.from('abc'), Buffer.from('defgh')];
  const sha = crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
  const c = mkController({ root, artRoot, fetchImpl: fakeFetch(null, { chunks }) });
  const out = await c.resolve('/assets/x.png', false);
  assert.equal(out.sha256, sha);
  assert.equal(out.bytes, 8);
});

// ---------------------------------------------------------------- LRU prune

test('LRU prune: foreign namespaces are evicted before the active one', () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  const cacheDir = path.join(artRoot, 'cache');
  write(path.join(cacheDir, 'oldhash', 'assets', 'big.bin'), Buffer.alloc(400, 1));
  write(path.join(cacheDir, 'curhash', 'assets', 'small.bin'), Buffer.alloc(100, 2));
  const c = mkController({ root, artRoot, manifestHash: 'curhash', maxCacheBytes: 150, fetchImpl: fakeFetch('x') });
  const res = c.pruneCache('curhash');
  assert.equal(res.removed, 1);
  assert.equal(fs.existsSync(path.join(cacheDir, 'oldhash', 'assets', 'big.bin')), false, 'foreign evicted first');
  assert.equal(fs.existsSync(path.join(cacheDir, 'curhash', 'assets', 'small.bin')), true);
});

test('LRU prune: within the active namespace the oldest file goes first', () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  const cacheDir = path.join(artRoot, 'cache');
  const oldF = write(path.join(cacheDir, 'curhash', 'assets', 'old.bin'), Buffer.alloc(100, 1));
  const newF = write(path.join(cacheDir, 'curhash', 'assets', 'new.bin'), Buffer.alloc(100, 2));
  const t0 = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(oldF, t0, t0);
  const c = mkController({ root, artRoot, manifestHash: 'curhash', maxCacheBytes: 150, fetchImpl: fakeFetch('x') });
  c.pruneCache('curhash');
  assert.equal(fs.existsSync(oldF), false);
  assert.equal(fs.existsSync(newF), true);
});

test('prune is a no-op under the cap', () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  write(path.join(artRoot, 'cache', 'curhash', 'assets', 'a.bin'), Buffer.alloc(10, 1));
  const c = mkController({ root, artRoot, manifestHash: 'curhash', maxCacheBytes: 1024, fetchImpl: fakeFetch('x') });
  assert.deepEqual(c.pruneCache('curhash'), { removed: 0, bytes: 0 });
});

// ---------------------------------------------------------------- pool priority

test('pool: a waiting page request is served before a waiting prefetch', async () => {
  const pool = createPool({ max: 1, maxPrefetch: 1 });
  const order = [];
  assert.equal(await pool.acquire(true, 0), true); // the single slot is held by a prefetch

  const page = pool.acquire(false, 5000).then((ok) => { order.push('page:' + ok); return ok; });
  const pf2 = pool.acquire(true, 5000).then((ok) => { order.push('pf:' + ok); return ok; });
  await new Promise((r) => setImmediate(r));
  pool.release(true); // free the slot: the page must win even though the prefetch queued first

  assert.equal(await page, true);
  assert.equal(order[0], 'page:true');
  pool.release(false);
  assert.equal(await pf2, true);
  assert.equal(order[1], 'pf:true');
});

test('pool: a prefetch yields (times out) rather than queueing forever', async () => {
  const pool = createPool({ max: 1, maxPrefetch: 1 });
  assert.equal(await pool.acquire(true, 0), true);
  const t0 = Date.now();
  assert.equal(await pool.acquire(true, 40), false);
  assert.ok(Date.now() - t0 >= 30);
  assert.equal(pool.stats().yielded, 1);
  pool.release(true);
});

test('pool: page requests never take more than max slots', async () => {
  const pool = createPool({ max: 2, maxPrefetch: 1 });
  assert.equal(await pool.acquire(false, 0), true);
  assert.equal(await pool.acquire(false, 0), true);
  assert.equal(await pool.acquire(false, 20), false);
  pool.release(false);
  pool.release(false);
  assert.equal(pool.stats().active, 0);
});

// ---------------------------------------------------------------- URL rejection

test('URL rules: blocked/foreign/non-http targets are refused and NEVER contacted', async () => {
  const cases = [
    ['http://127.0.0.1:8080/assets-re/', 'blocked-address'],
    ['http://localhost/assets-re/', 'blocked-address'],
    ['http://10.0.0.5/assets-re/', 'blocked-address'],
    ['http://192.168.1.1/assets-re/', 'blocked-address'],
    ['http://169.254.1.1/assets-re/', 'blocked-address'],
    ['http://2130706433/assets-re/', 'blocked-address'],
    ['http://0x7f000001/assets-re/', 'blocked-address'],
    ['http://[::1]/assets-re/', 'blocked-address'],
    ['ftp://weishucdn.jiangjiangze.icu/assets-re/', 'scheme'],
    ['https://example.com/assets-re/', 'host-not-allowed'],
  ];
  for (const [base, reason] of cases) {
    const root = mkTmp();
    const artRoot = path.join(root, 'art');
    const fetchImpl = fakeFetch('SHOULD-NOT-HAPPEN');
    const c = mkController({ root, artRoot, cdnBase: base, fetchImpl });
    const out = await c.resolve('/assets/x.png', false);
    assert.equal(out.layer, null, base);
    assert.equal(out.reason, reason, base);
    assert.equal(fetchImpl.calls.length, 0, `refused target must never be contacted: ${base}`);
  }
});

test('URL rules: an allow-listed mirror host IS fetched', async () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  const fetchImpl = fakeFetch('MIRROR');
  const c = mkController({ root, artRoot, cdnBase: 'https://dl.jiangjiangze.icu/assets-re/', fetchImpl });
  const out = await c.resolve('/assets/x.png', false);
  assert.equal(out.layer, 'cdn');
  assert.equal(fetchImpl.calls.length, 1);
});

test('URL rules: a redirect (3xx) is not followed', async () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  const fetchImpl = fakeFetch(null, { redirect: true });
  const c = mkController({ root, artRoot, fetchImpl });
  const out = await c.resolve('/assets/x.png', false);
  assert.equal(out.layer, null);
  assert.equal(out.reason, 'redirect');
  assert.equal(fetchImpl.calls[0].init.redirect, 'manual');
});

test('URL rules: a network failure and a 404 are misses; a 4xx is remembered', async () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  const net = mkController({ root, artRoot, fetchImpl: fakeFetch(null, { throwNetwork: true }) });
  assert.equal((await net.resolve('/assets/a.png', false)).reason, 'network');

  const notFound = fakeFetch(null, { status: 404 });
  const c = mkController({ root, artRoot, fetchImpl: notFound });
  assert.equal((await c.resolve('/assets/b.png', false)).reason, 'http-404');
  assert.equal((await c.resolve('/assets/b.png', false)).reason, 'remembered-miss');
  assert.equal(notFound.calls.length, 1, 'the remembered 4xx is not re-asked');
});

test('URL rules: an oversized body is refused', async () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  const c = mkController({ root, artRoot, maxBytes: 4, fetchImpl: fakeFetch('TOO-LONG') });
  const out = await c.resolve('/assets/x.png', false);
  assert.equal(out.layer, null);
  assert.equal(out.reason, 'too-big');
  assert.equal(fs.existsSync(path.join(artRoot, 'cache', 'hashA', 'assets', 'x.png')), false);
});

// ---------------------------------------------------------------- prefetch accounting

test('dispatch counts prefetch requests separately from page requests', async () => {
  const root = mkTmp();
  const artRoot = path.join(root, 'art');
  write(path.join(artRoot, 'cache', 'hashA', 'assets', 'p.png'), 'CACHE');
  const c = mkController({ root, artRoot, fetchImpl: fakeFetch('CDN') });
  const pageReq = { url: '/assets/p.png', method: 'HEAD', headers: {}, socket: {} };
  const pfReq = { url: '/assets/p.png', method: 'HEAD', headers: { 'x-sp-prefetch': '1' }, socket: {} };
  c.handleRequest(pageReq, fakeRes());
  c.handleRequest(pfReq, fakeRes());
  await new Promise((r) => setImmediate(r));
  const s = c.status();
  assert.equal(s.requests, 2);
  assert.equal(s.prefetchRequests, 1);
});

// ---------------------------------------------------------------- HTTP integration

/** Start an http server, let the controller attach, and run `fn(port)`. */
async function withAttachedController(controller, fn) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end('upstream-404'); });
  controller.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    controller.detach();
    await new Promise((resolve) => server.close(resolve));
  }
}

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('HTTP: serves /assets/** with the decision order and the status surface', async () => {
  const root = mkTmp();
  const webrootDir = path.join(root, 'webroot');
  const artRoot = path.join(root, 'art');
  write(path.join(webrootDir, 'assets', 'local.png'), 'LOCAL');
  write(path.join(artRoot, 'packs', 'aaa', 'assets', 'pack.png'), 'PACK');
  write(path.join(artRoot, 'cache', 'hashA', 'assets', 'cached.png'), 'CACHE');
  const fetchImpl = fakeFetchMap({ 'new.png': 'CDN' });
  const c = mkController({ root, webrootDir, artRoot, fetchImpl });
  await withAttachedController(c, async (port) => {
    const local = await get(port, '/assets/local.png');
    assert.equal(local.status, 200);
    assert.equal(local.body.toString(), 'LOCAL');
    assert.equal(local.headers['content-type'], 'image/png');

    const pack = await get(port, '/assets/pack.png');
    assert.equal(pack.body.toString(), 'PACK');

    const cached = await get(port, '/assets/cached.png');
    assert.equal(cached.body.toString(), 'CACHE');

    const fetched = await get(port, '/assets/new.png');
    assert.equal(fetched.body.toString(), 'CDN');
    assert.equal(fetchImpl.calls.length, 1, 'only the missing asset is fetched');

    const status = await get(port, STATUS_PATH);
    assert.equal(status.status, 200);
    const doc = JSON.parse(status.body.toString());
    assert.equal(doc.ok, true);
    assert.equal(doc.enabled, true);
    assert.equal(doc.namespace, 'hashA');
    assert.equal(doc.hits.local, 1);
    assert.equal(doc.hits.pack, 1);
    assert.equal(doc.hits.cache, 1);
    assert.equal(doc.hits.cdn, 1);

    // a genuine miss → placeholder (no-store, 1×1 PNG)
    const missing = await get(port, '/assets/missing.png');
    assert.equal(missing.status, 200);
    assert.equal(missing.headers['cache-control'], 'no-store');
    assert.equal(missing.headers['access-control-allow-origin'], '*');
    assert.equal(missing.headers['content-type'], 'image/png');
    assert.ok(missing.body.length > 0);
  });
});

test('HTTP: non-asset paths are forwarded to the upstream handler unchanged', async () => {
  const root = mkTmp();
  const c = mkController({ root, fetchImpl: fakeFetch('CDN') });
  await withAttachedController(c, async (port) => {
    const res = await get(port, '/healthz');
    assert.equal(res.status, 404);
    assert.equal(res.body.toString(), 'upstream-404');
    const data = await get(port, '/data/assets.json');
    assert.equal(data.body.toString(), 'upstream-404');
  });
});

test('HTTP: the status surface is loopback-only', () => {
  const root = mkTmp();
  const c = mkController({ root, fetchImpl: fakeFetch('CDN') });
  const res = fakeRes();
  const req = { url: STATUS_PATH, method: 'GET', headers: {}, socket: { remoteAddress: '8.8.8.8' } };
  assert.equal(c.handleRequest(req, res), true);
  assert.equal(res.statusCode, 403);
  const local = fakeRes();
  const localReq = { url: STATUS_PATH, method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(c.handleRequest(localReq, local), true);
  assert.equal(local.statusCode, 200);
});

// ---------------------------------------------------------------- flag-off inertness

test('flag off: install() attaches nothing and behavior is byte-identical', async () => {
  const root = mkTmp();
  const webroot = path.join(root, 'webroot');
  write(path.join(webroot, 'server', 'index.js'), '// marker');
  write(path.join(webroot, 'assets', 'x.png'), 'LOCAL-TREE');

  const upstream = (req, res) => { res.writeHead(200); res.end('UPSTREAM'); };
  const server = http.createServer(upstream);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const before = server.listenerCount('request');
    const controller = await install({
      server,
      upstreamDir: path.join(webroot, 'server'),
      env: {},
      log: () => {},
    });
    assert.equal(controller.enabled, false, 'default must be OFF');
    assert.equal(server.listenerCount('request'), before, 'install() must not attach when disabled');

    const res = await get(port, '/assets/x.png');
    assert.equal(res.body.toString(), 'UPSTREAM', 'the upstream handler still answers /assets/**');
    assert.deepEqual(controller.status().hits, { local: 0, pack: 0, embedded: 0, cache: 0, cdn: 0, placeholder: 0 });
    assert.equal(controller.handleRequest({ url: '/assets/x.png', method: 'GET', headers: {}, socket: {} }, fakeRes()), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('flag on: install() attaches and serves the local tree', async () => {
  const root = mkTmp();
  const webroot = path.join(root, 'webroot');
  write(path.join(webroot, 'server', 'index.js'), '// marker');
  write(path.join(webroot, 'assets', 'x.png'), 'LOCAL-TREE');
  write(path.join(root, 'art', 'cache', 'hashA', 'assets', 'y.png'), 'CACHE');

  const server = http.createServer((req, res) => { res.writeHead(404); res.end('upstream'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const controller = await install({
      server,
      upstreamDir: path.join(webroot, 'server'),
      env: { SP_ASSETS_OVERLAY: '1' },
      log: () => {},
    });
    assert.equal(controller.enabled, true);
    const res = await get(port, '/assets/x.png');
    assert.equal(res.body.toString(), 'LOCAL-TREE');
    const status = await get(port, STATUS_PATH);
    assert.equal(JSON.parse(status.body.toString()).hits.local, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('install() reads the flag from <webroot>/data/sp-assets.json', async () => {
  const root = mkTmp();
  const webroot = path.join(root, 'webroot');
  write(path.join(webroot, 'server', 'index.js'), '// marker');
  write(path.join(webroot, 'data', 'sp-assets.json'), JSON.stringify({ enabled: true }));
  // server: null → install() returns the controller without attaching (nothing to boot here)
  const controller = await install({ server: null, upstreamDir: path.join(webroot, 'server'), env: {}, log: () => {} });
  assert.equal(controller.enabled, true);
  assert.equal(controller.status().enabled, true);
});
