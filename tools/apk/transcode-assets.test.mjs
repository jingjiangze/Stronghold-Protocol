// tools/apk/transcode-assets.test.mjs — unit + integration tests for the PNG → WebP build step:
//   · classification: standalone / spine page (.skel|.atlas sibling) / already-webp
//   · manifest rewrite: only the converted `/assets/<rel>.png` refs move to .webp
//   · size fallback: a WebP that is not smaller keeps the PNG (and its manifest ref)
//   · the manifest/disk gate fails loudly on a ref with no file
//   · --no-webp / enabled:false touches nothing (but still gates)
//   · idempotency + determinism with a real encoder when one is installed (Pillow here)
//
//   node --test tools/apk/transcode-assets.test.mjs
//
// NOTE on encode parameters: the spec suggested quality=90, method=6 (Pillow). Measured on this
// machine's Pillow/libwebp build, method=6 is ~46x slower than method=4 (200 files: 112 s vs
// ~2.5 s) for a ~3% size gain (ratio 0.238 vs 0.246 of the PNG bytes). A step that runs on every
// build wins on the trade: default quality=90, method=4, overridable with SP_WEBP_METHOD.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  assertManifestDiskConsistency,
  checkManifestDiskConsistency,
  classifyPngs,
  pickEncoder,
  rewriteManifestRefs,
  transcodeAssets,
  webpEnabled,
} from './transcode-assets.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'transcode-assets.mjs');
const quiet = { log: () => {} };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// --- tiny pure-Node PNG writer (no deps; valid RGBA file Pillow/any decoder accepts) ---
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w = 64, h = 64, rgba = [200, 30, 40, 255]) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const row = y * stride + 1;
    for (let x = 0; x < w; x++) {
      const o = row + x * 4;
      raw[o] = (rgba[0] + x) & 0xff;
      raw[o + 1] = (rgba[1] + y) & 0xff;
      raw[o + 2] = rgba[2];
      raw[o + 3] = rgba[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Builds a synthetic webroot: standalone PNGs, a .skel page, an .atlas page, an already-webp
 * pair, plus the two manifests (+ the optional emotes.json reference file).
 */
function makeTree({ refs = ['a/one.png', 'a/two.png', 'spine/hero.png'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-webp-test-'));
  const put = (rel, buf) => {
    const p = path.join(root, 'assets', ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    return p;
  };
  put('a/one.png', makePng());
  put('a/two.png', makePng(96, 48, [10, 90, 200, 255]));
  put('spine/hero.png', makePng());
  put('spine/hero.skel', Buffer.from('skel-bytes'));
  put('spine2/hero.png', makePng());
  put('spine2/hero.atlas', Buffer.from('atlas-bytes'));
  put('pair/already.png', makePng());
  put('pair/already.webp', Buffer.from('RIFF....WEBP'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const ui = {};
  for (const r of refs) ui[path.basename(r, '.png')] = `https://cdn.test/assets/${r}`; // keys are names, values are URLs (real assets.json shape)
  fs.writeFileSync(path.join(dataDir, 'assets.json'),
    JSON.stringify({ version: 1, stats: { files: 3 }, ui }, null, 1));
  fs.writeFileSync(path.join(dataDir, 'local-assets.json'),
    JSON.stringify({ version: 1, groups: { a: { one: { path: `/assets/a/one.png` }, two: { path: `/assets/a/two.png` } } } }, null, 1));
  fs.writeFileSync(path.join(dataDir, 'emotes.json'),
    JSON.stringify({ version: 1, emotes: [{ id: 'x', pic: '/assets/a/two.png' }] }, null, 1));
  return root;
}

/** Fake encoder: writes `sizeFor(srcSize)` bytes per job into dst (deterministic, no external tools). */
function fakeEncoder(sizeFor = (n) => Math.max(1, n - 5)) {
  return {
    name: 'fake',
    version: 'test',
    encodeAll: async (jobs) =>
      jobs.map((j) => {
        const bytes = sizeFor(fs.statSync(j.src).size);
        fs.mkdirSync(path.dirname(j.dst), { recursive: true });
        fs.writeFileSync(j.dst, Buffer.alloc(bytes, 7));
        return { ok: true, bytes };
      }),
  };
}

const readJson = (root, f) => JSON.parse(fs.readFileSync(path.join(root, 'data', f), 'utf-8'));

test('classifyPngs: standalone vs spine pairs vs already-webp', () => {
  const root = makeTree();
  const cls = classifyPngs(path.join(root, 'assets'));
  assert.deepEqual(cls.standalone.sort(), ['a/one.png', 'a/two.png']);
  assert.deepEqual(cls.spine.sort(), ['spine/hero.png', 'spine2/hero.png']);
  assert.deepEqual(cls.alreadyWebp, ['pair/already.png']);
  assert.equal(cls.standalone.length + cls.spine.length + cls.alreadyWebp.length, 5);
});

test('rewriteManifestRefs: only exact quoted refs of converted files move to .webp', () => {
  const map = new Map([['a/one.png', 'a/one.webp']]);
  const text = '{"x":"/assets/a/one.png","y":"https://c/assets/a/one.png","z":"/assets/a/one.pngx","k":"/assets/a/one.webp"}';
  const { text: out, count } = rewriteManifestRefs(text, map);
  assert.equal(count, 2);
  assert.equal(out, '{"x":"/assets/a/one.webp","y":"https://c/assets/a/one.webp","z":"/assets/a/one.pngx","k":"/assets/a/one.webp"}');
  assert.equal(rewriteManifestRefs(text, new Map()).count, 0);
});

test('transcode: converts standalone PNGs, rewrites both manifests, leaves spine/already-webp alone', async () => {
  const root = makeTree();
  const pngBytes = fs.statSync(path.join(root, 'assets/a/one.png')).size + fs.statSync(path.join(root, 'assets/a/two.png')).size;
  const report = await transcodeAssets({ webrootDir: root, encoder: fakeEncoder(), logger: quiet });

  assert.equal(report.converted, 2);
  assert.equal(report.png.spineSkipped, 2);
  assert.equal(report.png.alreadyWebp, 1);
  assert.equal(report.fallback.length, 0);
  assert.equal(report.failed.length, 0);
  assert.equal(report.bytes.png, pngBytes);
  assert.ok(report.bytes.webp < report.bytes.png);

  // disk
  assert.ok(!fs.existsSync(path.join(root, 'assets/a/one.png')));
  assert.ok(fs.existsSync(path.join(root, 'assets/a/one.webp')));
  assert.ok(!fs.existsSync(path.join(root, 'assets/a/two.png')));
  assert.ok(fs.existsSync(path.join(root, 'assets/a/two.webp')));
  assert.ok(fs.existsSync(path.join(root, 'assets/spine/hero.png')), 'spine page kept');
  assert.ok(fs.existsSync(path.join(root, 'assets/spine2/hero.png')), 'atlas page kept');
  assert.ok(fs.existsSync(path.join(root, 'assets/pair/already.png')), 'pre-existing webp pair kept');

  // manifests
  const a = readJson(root, 'assets.json');
  assert.equal(a.ui.one, 'https://cdn.test/assets/a/one.webp');
  assert.equal(a.ui.two, 'https://cdn.test/assets/a/two.webp');
  assert.equal(a.ui.hero, 'https://cdn.test/assets/spine/hero.png', 'spine page ref stays .png');
  const l = readJson(root, 'local-assets.json');
  assert.equal(l.groups.a.one.path, '/assets/a/one.webp');
  assert.equal(l.groups.a.two.path, '/assets/a/two.webp');
  const e = readJson(root, 'emotes.json');
  assert.equal(e.emotes[0].pic, '/assets/a/two.webp');
  assert.deepEqual(report.manifests, { 'assets.json': 2, 'local-assets.json': 2, 'emotes.json': 1 });
  assert.equal(report.gate.missing.length, 0);
});

test('transcode: a WebP that is not smaller keeps the PNG and its manifest ref (fallback)', async () => {
  const root = makeTree();
  const report = await transcodeAssets({ webrootDir: root, encoder: fakeEncoder((n) => n + 10), logger: quiet });
  assert.equal(report.converted, 0);
  assert.equal(report.fallback.length, 2);
  assert.ok(report.fallback.every((f) => f.webpBytes > f.pngBytes));
  assert.ok(fs.existsSync(path.join(root, 'assets/a/one.png')));
  assert.ok(!fs.existsSync(path.join(root, 'assets/a/one.webp')));
  assert.equal(readJson(root, 'assets.json').ui.one, 'https://cdn.test/assets/a/one.png');
  assert.deepEqual(report.manifests, {});
  assert.equal(report.gate.missing.length, 0);
});

test('transcode: manifest ref with no file on disk fails the gate loudly', async () => {
  const root = makeTree({ refs: ['a/one.png', 'a/ghost.png'] });
  await assert.rejects(() => transcodeAssets({ webrootDir: root, encoder: fakeEncoder(), logger: quiet }), /manifest\/disk mismatch/);
  const r = checkManifestDiskConsistency(root);
  assert.ok(r.missing.some((m) => m.rel === 'a/ghost.png' && m.file === 'assets.json'));
  assert.throws(() => assertManifestDiskConsistency(root), /manifest\/disk mismatch/);
});

test('transcode: enabled=false touches nothing but still gates', async () => {
  const root = makeTree();
  const manifestSha = sha(path.join(root, 'data/assets.json'));
  const report = await transcodeAssets({ webrootDir: root, enabled: false, encoder: fakeEncoder(), logger: quiet });
  assert.equal(report.enabled, false);
  assert.equal(report.converted, 0);
  assert.ok(fs.existsSync(path.join(root, 'assets/a/one.png')));
  assert.equal(sha(path.join(root, 'data/assets.json')), manifestSha);
  assert.equal(report.gate.missing.length, 0);
  assert.equal(webpEnabled([], { SP_NO_WEBP: '1' }), false);
  assert.equal(webpEnabled(['--no-webp'], {}), false);
  assert.equal(webpEnabled([], {}), true);
});

test('transcode: with a real encoder — valid WebP, deterministic bytes, idempotent re-run', async (t) => {
  const enc = await pickEncoder();
  if (!enc) {
    t.skip('no WebP encoder installed (cwebp/Pillow/ImageMagick/ffmpeg/sharp)');
    return;
  }
  const root = makeTree();
  const report = await transcodeAssets({ webrootDir: root, encoder: enc, logger: quiet });
  assert.equal(report.converted, 2, `encoder ${enc.name}`);

  // valid WebP container (RIFF....WEBP)
  const webp = fs.readFileSync(path.join(root, 'assets/a/one.webp'));
  assert.equal(webp.subarray(0, 4).toString('latin1'), 'RIFF');
  assert.equal(webp.subarray(8, 12).toString('latin1'), 'WEBP');
  assert.ok(webp.length > 12);

  // determinism: encoding the same PNG again (fresh tree, fresh dst) gives identical bytes
  const root2 = makeTree();
  await transcodeAssets({ webrootDir: root2, encoder: enc, logger: quiet });
  assert.equal(sha(path.join(root, 'assets/a/one.webp')), sha(path.join(root2, 'assets/a/one.webp')));

  // idempotency: second run converts 0, manifests byte-identical
  const manifestShas = ['assets.json', 'local-assets.json', 'emotes.json'].map((f) => sha(path.join(root, 'data', f)));
  const again = await transcodeAssets({ webrootDir: root, encoder: enc, logger: quiet });
  assert.equal(again.converted, 0);
  assert.deepEqual(again.manifests, {});
  assert.deepEqual(['assets.json', 'local-assets.json', 'emotes.json'].map((f) => sha(path.join(root, 'data', f))), manifestShas);
  assert.equal(again.gate.missing.length, 0);
});

test('CLI: --no-webp runs clean on a good tree; --check exits 1 when a ref is dangling', () => {
  const root = makeTree();
  const env = { ...process.env };
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  const okRun = spawnSync(process.execPath, [CLI, '--webroot', root, '--no-webp'], { env, encoding: 'utf-8' });
  assert.equal(okRun.status, 0, okRun.stderr);
  assert.ok(okRun.stdout.includes('transcode-report:'));
  assert.ok(fs.existsSync(path.join(root, 'assets/a/one.png')), '--no-webp leaves PNGs alone');

  const broken = makeTree({ refs: ['a/one.png', 'a/ghost.png'] });
  const bad = spawnSync(process.execPath, [CLI, '--webroot', broken, '--check'], { env, encoding: 'utf-8' });
  assert.equal(bad.status, 1);
  assert.ok(bad.stderr.includes('manifest/disk mismatch'), bad.stderr);
});
