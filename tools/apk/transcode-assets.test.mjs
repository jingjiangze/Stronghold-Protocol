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
  hashReferencedBytes,
  pickEncoder,
  planOnlyTranscode,
  referencedAssetRels,
  rewriteManifestRefs,
  transcodeAssets,
  webpEnabled,
  writeAssetDigests,
  writeManifestHash,
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

test('plan-only transcode: --no-assets manifests are byte-identical to a full build (fake encoder)', async () => {
  const src = makeTree(); // upstream tree: assets/** + the two manifests
  const full = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-plan-full-'));
  const plan = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-plan-only-'));
  fs.cpSync(path.join(src, 'assets'), path.join(full, 'assets'), { recursive: true });
  fs.cpSync(path.join(src, 'data'), path.join(full, 'data'), { recursive: true });
  fs.cpSync(path.join(src, 'data'), path.join(plan, 'data'), { recursive: true }); // NO assets tree

  const enc = fakeEncoder();
  const fullReport = await transcodeAssets({ webrootDir: full, encoder: enc, logger: quiet });
  const planReport = await planOnlyTranscode({
    sourceAssetsDir: path.join(src, 'assets'),
    dataDir: path.join(plan, 'data'),
    encoder: enc,
    logger: quiet,
  });

  assert.equal(fullReport.converted, 2);
  assert.equal(planReport.converted, 2);
  assert.deepEqual(planReport.manifests, fullReport.manifests, 'same per-file ref counts');
  assert.ok(fullReport.assetsHash, 'the full build re-emits a byte-sensitive manifest hash');
  assert.equal(planReport.assetsHash, fullReport.assetsHash, 'both paths emit the same byte-sensitive hash');
  for (const f of ['assets.json', 'local-assets.json', 'emotes.json']) {
    assert.equal(sha(path.join(plan, 'data', f)), sha(path.join(full, 'data', f)),
      `${f} must be byte-identical between --no-assets and the full build`);
  }
  // and the .webp/.png ref sets agree
  const refs = (p) => (fs.readFileSync(p, 'utf-8').match(/\/assets\/[^"]+\.(?:webp|png)/g) || []).sort();
  assert.deepEqual(refs(path.join(plan, 'data/assets.json')), refs(path.join(full, 'data/assets.json')));
  // plan-only must not have materialised any asset bytes
  assert.ok(!fs.existsSync(path.join(plan, 'assets')), 'plan-only copies no assets');
});

test('plan-only transcode: fallback rule matches the full build (WebP not smaller keeps .png)', async () => {
  const src = makeTree();
  const full = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-plan-full2-'));
  const plan = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-plan-only2-'));
  fs.cpSync(path.join(src, 'assets'), path.join(full, 'assets'), { recursive: true });
  fs.cpSync(path.join(src, 'data'), path.join(full, 'data'), { recursive: true });
  fs.cpSync(path.join(src, 'data'), path.join(plan, 'data'), { recursive: true });

  const big = fakeEncoder((n) => n + 10); // encoded WebP is LARGER → PNG kept
  const fullReport = await transcodeAssets({ webrootDir: full, encoder: big, logger: quiet });
  const planReport = await planOnlyTranscode({
    sourceAssetsDir: path.join(src, 'assets'),
    dataDir: path.join(plan, 'data'),
    encoder: big,
    logger: quiet,
  });
  assert.equal(fullReport.converted, 0);
  assert.equal(planReport.converted, 0);
  assert.ok(fullReport.assetsHash, 'hash is emitted even with 0 conversions');
  assert.equal(planReport.assetsHash, fullReport.assetsHash, '0-conversion paths agree on the hash too');
  for (const f of ['assets.json', 'local-assets.json', 'emotes.json']) {
    assert.equal(sha(path.join(plan, 'data', f)), sha(path.join(full, 'data', f)), `${f} identical under fallback`);
  }
});

test('plan-only transcode: with a real encoder the two paths still agree byte-for-byte', async (t) => {
  const enc = await pickEncoder();
  if (!enc) {
    t.skip('no WebP encoder installed (cwebp/Pillow/ImageMagick/ffmpeg/sharp)');
    return;
  }
  const src = makeTree();
  const full = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-plan-full3-'));
  const plan = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-plan-only3-'));
  fs.cpSync(path.join(src, 'assets'), path.join(full, 'assets'), { recursive: true });
  fs.cpSync(path.join(src, 'data'), path.join(full, 'data'), { recursive: true });
  fs.cpSync(path.join(src, 'data'), path.join(plan, 'data'), { recursive: true });

  const fullReport = await transcodeAssets({ webrootDir: full, encoder: enc, logger: quiet });
  const planReport = await planOnlyTranscode({
    sourceAssetsDir: path.join(src, 'assets'),
    dataDir: path.join(plan, 'data'),
    encoder: enc,
    logger: quiet,
  });
  assert.equal(fullReport.converted, planReport.converted, `encoder ${enc.name}`);
  assert.equal(planReport.assetsHash, fullReport.assetsHash, `byte-sensitive hash agrees with ${enc.name}`);
  for (const f of ['assets.json', 'local-assets.json', 'emotes.json']) {
    assert.equal(sha(path.join(plan, 'data', f)), sha(path.join(full, 'data', f)), `${f} identical with ${enc.name}`);
  }
});

test('manifest hash is byte-sensitive: same path, new bytes → new hash (upstream metadata-only hash would not move)', async () => {
  // 审计-素材hash与编码器pin-2026-10-08: upstream `hash` = sha1(JSON.stringify(manifest METADATA)),
  // so a republished image at the SAME path keeps it — and the device cache (namespace = this hash)
  // would serve the stale bytes forever. Our build re-emits this field as a content hash.
  const upstreamHash = (manifestPath) => {
    const { version, hash, generator, stats, ...body } = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    return crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12);
  };
  const enc = fakeEncoder();
  const build = async (pngBytes) => {
    const src = makeTree();
    fs.writeFileSync(path.join(src, 'assets', 'a', 'one.png'), pngBytes);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-hash-'));
    fs.cpSync(path.join(src, 'assets'), path.join(root, 'assets'), { recursive: true });
    fs.cpSync(path.join(src, 'data'), path.join(root, 'data'), { recursive: true });
    const report = await transcodeAssets({ webrootDir: root, encoder: enc, logger: quiet });
    const manifestPath = path.join(root, 'data', 'assets.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const refs = (fs.readFileSync(manifestPath, 'utf-8').match(/\/assets\/[^"]+/g) || []).sort();
    return { report, manifest, manifestPath, refs };
  };

  const a = await build(makePng(64, 64, [200, 30, 40, 255]));
  const b = await build(makePng(64, 64, [7, 8, 9, 255])); // SAME path, different bytes

  assert.deepEqual(a.refs, b.refs, 'the reference graph is unchanged (that is why upstream does not notice)');
  assert.equal(upstreamHash(a.manifestPath), upstreamHash(b.manifestPath),
    'DOCUMENTS THE BUG: the upstream metadata-only recipe does NOT move when bytes change');
  assert.notEqual(a.manifest.hash, b.manifest.hash,
    'our re-emitted hash MUST move when the bytes at the same path change (cache invalidation)');
  assert.equal(a.manifest.hash, a.report.assetsHash);
  assert.equal(b.manifest.hash, b.report.assetsHash);
  assert.match(a.manifest.hash, /^[0-9a-f]{12}$/, 'same 12-hex shape as upstream (ArtCdn.safeHash-compatible)');
});

test('referencedAssetRels + hashReferencedBytes + writeManifestHash: pure behaviour', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-hash-pure-'));
  fs.writeFileSync(path.join(dataDir, 'assets.json'),
    JSON.stringify({ version: 1, ui: { a: '/assets/ui/a.png', b: 'https://cdn.test/assets/ui/b.webp' } }));
  fs.writeFileSync(path.join(dataDir, 'local-assets.json'),
    JSON.stringify({ version: 1, groups: { g: { p: '/assets/ui/a.png' } } })); // dup -> deduped
  fs.writeFileSync(path.join(dataDir, 'emotes.json'), JSON.stringify({ version: 1, emotes: [{ pic: '/assets/spine/x.atlas' }] }));

  assert.deepEqual(referencedAssetRels(dataDir), ['spine/x.atlas', 'ui/a.png', 'ui/b.webp'], 'deduped + sorted');

  const h1 = hashReferencedBytes({ dataDir, readBytes: () => Buffer.from('one') });
  const h2 = hashReferencedBytes({ dataDir, readBytes: () => Buffer.from('two') });
  assert.equal(h1.count, 3);
  assert.deepEqual(h1.missing, []);
  assert.notEqual(h1.hash, h2.hash, 'hash follows the bytes');
  assert.equal(h1.hash, hashReferencedBytes({ dataDir, readBytes: () => Buffer.from('one') }).hash, 'deterministic');
  const miss = hashReferencedBytes({ dataDir, readBytes: (rel) => (rel === 'ui/a.png' ? null : Buffer.from('x')) });
  assert.deepEqual(miss.missing, ['ui/a.png'], 'unreadable refs are reported');
  assert.throws(() => hashReferencedBytes({ dataDir }), /readBytes/);

  assert.equal(writeManifestHash(dataDir, 'deadbeefcafe'), true, 'inserted when absent');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'assets.json'), 'utf-8')).hash, 'deadbeefcafe');
  assert.equal(writeManifestHash(dataDir, 'deadbeefcafe'), false, 'idempotent');
  assert.equal(writeManifestHash(dataDir, 'cafebabedead'), true, 'replaced when present');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'assets.json'), 'utf-8')).hash, 'cafebabedead');
  assert.throws(() => writeManifestHash(dataDir, '../../etc/passwd'), /bogus/, 'path-hostile values refused');
  assert.throws(() => writeManifestHash(dataDir, ''), /bogus/);
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

// --- per-file digests (audit 2026-10-09 phase 1, option 1) -------------------------------------
// The manifest hash is byte-sensitive, so "the hash changed" means "some bytes changed" -- but the
// device only has the top-level hash and cannot tell WHICH file moved. This table is what lets the
// shell rename the old cache namespace and then verify each file instead of either keeping stale
// bytes or re-downloading all 357 MB.
test('writeAssetDigests emits a rel-keyed, hash-stamped digest map', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-digests-'));
  const n = writeAssetDigests(dir, [['ui/b.webp', 'bb'], ['ui/a.webp', 'aa'], ['ui/b.webp', 'dup'], ['', 'x']], { hash: 'abc123' });
  assert.equal(n, 2, 'duplicate rels collapse and empty rels are dropped');
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'asset-digests.json'), 'utf-8'));
  assert.equal(doc.version, 1);
  assert.equal(doc.hash, 'abc123', 'the file names the manifest hash it belongs to');
  assert.deepEqual(Object.keys(doc.digests), ['ui/a.webp', 'ui/b.webp'], 'keys are sorted rels');
  assert.equal(doc.digests['ui/a.webp'], 'aa');
  assert.equal(doc.digests['ui/b.webp'], 'bb', 'the first digest for a rel wins');
  assert.ok(!Object.keys(doc.digests).some((k) => k.startsWith('/')),
    'keys carry no /assets/ prefix — transformManifestsDir rewrites that shape on the next build');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the real build emits digests whose sha256 values match the referenced bytes', () => {
  // A one-file tree through the CLI, so the emitter is exercised on the real path (not just the
  // pure function): the digest for the single referenced file must equal its sha256 on disk.
  const tree = makeTree({ refs: ['a/one.png'] });
  // NOT SP_NO_WEBP: the hash/digest emission lives inside the `enabled` branch (it must stay in step
  // with the manifest rewrite), so disabling WebP would skip the very path under test.
  const env = { ...process.env };
  const run = spawnSync(process.execPath, [CLI, '--webroot', tree], { env, encoding: 'utf-8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const doc = JSON.parse(fs.readFileSync(path.join(tree, 'data', 'asset-digests.json'), 'utf-8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(tree, 'data', 'assets.json'), 'utf-8'));
  assert.equal(doc.hash, manifest.hash, 'the digest file carries the same hash as the manifest');
  const keys = Object.keys(doc.digests);
  assert.ok(keys.length >= 1, 'at least the referenced file is listed');
  for (const rel of keys) {
    const p = path.join(tree, 'assets', ...rel.split('/'));
    if (!fs.existsSync(p)) continue; // spine/atlas siblings may be referenced but absent in the fixture
    assert.equal(doc.digests[rel], sha(p), `digest matches the bytes on disk: ${rel}`);
  }
});
