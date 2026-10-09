// 素材 CDN (SP_ASSET_CDN, server/http/static.js): the art manifests leave with absolute CDN URLs so browsers fetch the
// art from the CDN; the file on disk, server/data.js and server/update.js are untouched, and with the variable unset
// the body is byte-for-byte the file. A value that is not an absolute http(s) URL is refused (art stays local).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createStaticHandler } from '../server/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const ASSETS = JSON.stringify({
  version: 1,
  hash: 'abc',
  chars: { char_003_kalts: { avatar: '/assets/char/avatar/char_003_kalts.png', portrait: '/assets/char/portrait/char_003_kalts.png' } },
  audio: { bgm: { lobby: { loop: '/assets/audio/bgm/x_loop.mp3' } } },
  // the CDN hosts the font tree too (Stronghold-Protocol-CDN: `assets/` + `fonts/` are both its own), so the
  // rewrite has to cover it — otherwise the browser still pulls the fonts from this host
  fonts: { css: '/fonts/fonts.css', faces: ['/fonts/bender-regular.woff2', '/fonts/novecento-wide-normal.woff2'] },
  note: 'keep-me',
});
const EMOTES = JSON.stringify({ version: 1, items: [{ id: 'a', path: '/assets/ui/emoticon/a.png' }] });
const LOCAL_ART = JSON.stringify({ version: 1, source: 'local-client', groups: { 'ui/battle': { 1: { path: '/assets/local/ui/battle/1.png' } } } });

function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cdn-'));
  fs.writeFileSync(path.join(dir, 'assets.json'), ASSETS);
  fs.writeFileSync(path.join(dir, 'emotes.json'), EMOTES);
  fs.writeFileSync(path.join(dir, 'local-assets.json'), LOCAL_ART);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ modes: {}, note: 'not an art manifest' }));
  return dir;
}

function serve(dataDir) {
  const handler = createStaticHandler({ publicDir: path.join(ROOT, 'public'), dataDir, sharedDir: path.join(ROOT, 'shared') });
  const srv = http.createServer((req, res) => {
    const [p, q] = req.url.split('?');
    handler(req, res, p, q || '');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

function get(srv, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: url, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
const json = (res) => JSON.parse(res.body.toString('utf8'));

/** Run `fn` with SP_ASSET_CDN set to `value` (or unset) and restore it after. */
async function withCdn(value, fn) {
  const prev = process.env.SP_ASSET_CDN;
  if (value === undefined) delete process.env.SP_ASSET_CDN;
  else process.env.SP_ASSET_CDN = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.SP_ASSET_CDN;
    else process.env.SP_ASSET_CDN = prev;
  }
}

test('SP_ASSET_CDN unset: the manifests are served byte for byte (no behaviour change)', async () => {
  await withCdn(undefined, async () => {
    const dir = fixtureDir();
    const srv = await serve(dir);
    for (const name of ['assets.json', 'emotes.json', 'local-assets.json']) {
      const res = await get(srv, `/data/${name}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.toString('utf8'), fs.readFileSync(path.join(dir, name), 'utf8'), `${name} untouched`);
      assert.match(res.headers['content-type'], /application\/json/);
    }
    srv.close();
  });
});

test('SP_ASSET_CDN: "/assets/…" paths leave as absolute CDN URLs, everything else is untouched', async () => {
  await withCdn('https://cdn.example.com', async () => {       // no trailing slash on purpose
    const dir = fixtureDir();
    const srv = await serve(dir);
    const res = await get(srv, '/data/assets.json');
    const body = res.body.toString('utf8');
    assert.equal(res.status, 200);
    assert.ok(!body.includes('"/assets/'), 'no same-origin art path is left');
    assert.ok(!body.includes('"/fonts/'), 'and no same-origin font path either');
    const m = json(res);
    assert.equal(m.chars.char_003_kalts.avatar, 'https://cdn.example.com/assets/char/avatar/char_003_kalts.png');
    assert.equal(m.audio.bgm.lobby.loop, 'https://cdn.example.com/assets/audio/bgm/x_loop.mp3');
    assert.equal(m.fonts.css, 'https://cdn.example.com/fonts/fonts.css', 'the font tree keeps its own name');
    assert.deepEqual(m.fonts.faces, ['https://cdn.example.com/fonts/bender-regular.woff2', 'https://cdn.example.com/fonts/novecento-wide-normal.woff2']);
    assert.equal(m.note, 'keep-me', 'non-path fields are untouched');
    assert.equal(m.hash, 'abc');
    // the other two manifests are rewritten the same way
    assert.equal(json(await get(srv, '/data/emotes.json')).items[0].path, 'https://cdn.example.com/assets/ui/emoticon/a.png');
    assert.equal(json(await get(srv, '/data/local-assets.json')).groups['ui/battle']['1'].path, 'https://cdn.example.com/assets/local/ui/battle/1.png');
    // a data file that is not an art manifest is served as before
    const cfg = await get(srv, '/data/config.json');
    assert.equal(cfg.body.toString('utf8'), fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    srv.close();
  });
});

test('SP_ASSET_CDN with a path prefix, gzip and conditional requests', async () => {
  await withCdn('https://cdn.example.com/art', async () => {
    const dir = fixtureDir();
    const srv = await serve(dir);
    const gz = await get(srv, '/data/assets.json', { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.headers.vary, 'Accept-Encoding');
    const plain = zlib.gunzipSync(gz.body).toString('utf8');
    assert.match(plain, /"https:\/\/cdn\.example\.com\/art\/assets\/char\/avatar\/char_003_kalts\.png"/);
    const etag = gz.headers.etag;
    assert.ok(etag, 'an ETag is sent');
    const again = await get(srv, '/data/assets.json', { 'accept-encoding': 'gzip', 'if-none-match': etag });
    assert.equal(again.status, 304, 'a repeat with the same ETag is a 304');
    assert.equal(again.body.length, 0);
    srv.close();
  });
});

test('SP_ASSET_CDN that is not an absolute http(s) URL is refused: the local file is served', async () => {
  for (const bad of ['ftp://cdn.example.com', 'cdn.example.com/assets', 'javascript:alert(1)', '/assets-root']) {
    await withCdn(bad, async () => {
      const dir = fixtureDir();
      const srv = await serve(dir);
      const res = await get(srv, '/data/assets.json');
      assert.equal(res.body.toString('utf8'), ASSETS, `${bad} → art stays local`);
      srv.close();
    });
  }
});

test('SP_ASSET_CDN does not invent a local-assets.json that is absent', async () => {
  await withCdn('https://cdn.example.com/', async () => {
    const dir = fixtureDir();
    fs.rmSync(path.join(dir, 'local-assets.json'));
    const srv = await serve(dir);
    const res = await get(srv, '/data/local-assets.json');
    assert.equal(res.status, 200);
    assert.deepEqual(json(res), { version: 1, source: 'none', count: 0, groups: {} }, 'the empty stand-in is unchanged');
    srv.close();
  });
});

// A rewritten manifest is still a data file of this build: with the page's tag on the URL it must be cacheable,
// or every page load pays for ~1.7 MB through this host (measured: /data/assets.json alone was 20.1 MB of the
// live host's uplink in five days, 303 requests, Cloudflare passing it through uncached).
test('an art manifest follows the same cache policy as the rest of /data/', async () => {
  await withCdn('https://cdn.example.com/', async () => {
    const dir = fixtureDir();
    const srv = await serve(dir);
    const plain = await get(srv, '/data/assets.json');
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['cache-control'], 'no-cache', 'without a tag it stays revalidatable');
    const versioned = await get(srv, '/data/assets.json?v=abc123');
    assert.equal(versioned.status, 200);
    assert.match(versioned.headers['cache-control'], /immutable/, 'with a tag the edge and the browser keep it');
    assert.deepEqual(json(versioned), json(plain), 'the same manifest either way');
    for (const name of ['local-assets.json', 'emotes.json']) {
      const v = await get(srv, `/data/${name}?v=abc123`);
      assert.match(v.headers['cache-control'], /immutable/, name);
    }
    srv.close();
  });
});

// A deployment can then ship without public/assets and public/fonts at all: index.html links /fonts/fonts.css
// directly (no manifest covers it), and a stale client manifest would ask for /assets/… again.
test('SP_ASSET_CDN: /assets/… and /fonts/… are redirected to the CDN (nothing local is required)', async () => {
  await withCdn('https://cdn.example.com', async () => {
    const dir = fixtureDir();
    const srv = await serve(dir);
    const font = await get(srv, '/fonts/fonts.css');
    assert.equal(font.status, 302, 'index.html\'s stylesheet link');
    assert.equal(font.headers.location, 'https://cdn.example.com/fonts/fonts.css');
    const woff = await get(srv, '/fonts/bender-regular.woff2');
    assert.equal(woff.headers.location, 'https://cdn.example.com/fonts/bender-regular.woff2');
    const art = await get(srv, '/assets/char/avatar/char_003_kalts.png');
    assert.equal(art.status, 302);
    assert.equal(art.headers.location, 'https://cdn.example.com/assets/char/avatar/char_003_kalts.png');
    assert.match(art.headers['cache-control'], /max-age/, 'cacheable, so the hop is paid once');
    // a path that is neither tree is untouched by this rule
    const other = await get(srv, '/js/main.js');
    assert.notEqual(other.status, 302, 'only the two art trees are redirected');
    srv.close();
  });
});

test('SP_ASSET_CDN unset: /assets/… is not redirected (the local tree is the source)', async () => {
  await withCdn(undefined, async () => {
    const dir = fixtureDir();
    const srv = await serve(dir);
    const res = await get(srv, '/assets/char/avatar/char_003_kalts.png');
    assert.notEqual(res.status, 302, 'no CDN, no redirect — a 404 at worst');
    srv.close();
  });
});
