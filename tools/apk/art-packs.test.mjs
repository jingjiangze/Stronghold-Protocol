// art-packs.test.mjs — 素材 pack（P0 素材热更）构建链的单测。
//
//   node --test tools/apk/art-packs.test.mjs
//
// 覆盖：
//   · make-art-packs：同输入两次打包字节相同（sha256 一致）；art-packs.json 的 sha256 == 实际文件哈希；
//     成员资格（只收 assets/ui/**，zips 里没有 js/ server/ index.html，且入口越界/非 assets 直接报错）；
//   · urls[]：只写 Updater.ALLOWED_HOSTS 里真实存在的 host（fail-closed），主源（CDN/R2）排第一；
//   · gen-manifest --packs：art 块形状（§7.3：base/version/format/mirrors/packs）、签名可验、非法输入报错；
//   · gen-manifest 无 --packs：art 保持旧形状 {base}，且输出与旧版逐字节一致（同输入两次相同）；
//   · publish-art 的纯函数：索引条目形状。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ASSETS_BASE } from './line.mjs';
import {
  buildPack, buildZip, packUrls, updaterAllowedHosts, PACK_ID_RE,
  assetPathOf, collectRefs, bucketOf, bucketize, buildBuckets, BUCKET_RULES, DEFAULT_MAX_PACK_BYTES,
} from './make-art-packs.mjs';
import { indexEntry } from './publish-art.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const NODE = process.execPath;

/** An ephemeral signing key so the suite never depends on the machine's real ~/.sp-sign.
 *  CI runners have none — the first CI run died with ENOENT /home/runner/.sp-sign/ed25519.key, so
 *  gen-manifest (and therefore the test) failed before the old "skip when no key" branch ran. The
 *  same seed derives the pubkey every signature assertion below verifies with. Test-only. */
let SIGN = null;
function signDir() {
  if (!SIGN) {
    const dir = tmpdir('signkey');
    const seed = Buffer.alloc(32, 7);
    fs.writeFileSync(path.join(dir, 'ed25519.key'), seed.toString('hex'));
    SIGN = { dir, seed };
  }
  return SIGN;
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `art-${tag}-`));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Root-level helper: a webroot with the P0 pack content plus code trees that must never be packed. */
function makeWebroot(dir) {
  const files = {
    'assets/ui/a.webp': Buffer.from('AAAA'),
    'assets/ui/sub/b.webp': Buffer.from('BBBBBB'),
    'assets/ui/deep/x/y.webp': Buffer.from('CC'),
    'js/main.js': Buffer.from('code'),
    'server/index.js': Buffer.from('code'),
    'index.html': Buffer.from('<html>'),
    'assets/audio/bgm.mp3': Buffer.from('MP3'),
  };
  for (const [rel, data] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  }
  return dir;
}

function runPacks(webroot, outDir, extra = []) {
  const out = path.join(outDir, 'art-packs.json');
  execFileSync(NODE, [path.join(here, 'make-art-packs.mjs'), '--webroot', webroot,
    '--art-version', '3', '--out', out, '--packs-dir', outDir, ...extra], { stdio: 'pipe' });
  return { out, dir: outDir, records: JSON.parse(fs.readFileSync(out, 'utf8')) };
}

/** Minimal central-directory reader for the deterministic zips this repo writes. */
function zipEntryNames(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, 'EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50, 'central directory signature');
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

// ---------------------------------------------------------------------------
// make-art-packs
// ---------------------------------------------------------------------------

test('pack：同输入两次打包字节确定（sha256 相同），记录 sha256 == 实际文件哈希', () => {
  const root = tmpdir('det');
  const webroot = makeWebroot(path.join(root, 'webroot'));
  const a = runPacks(webroot, path.join(root, 'a'));
  const b = runPacks(webroot, path.join(root, 'b'));
  assert.equal(a.records.length, 1);
  assert.equal(a.records[0].id, 'core.ui');
  const zipA = path.join(a.dir, 'core.ui-3.zip');
  const zipB = path.join(b.dir, 'core.ui-3.zip');
  assert.equal(sha256(zipA), sha256(zipB), '两次打包必须字节一致');
  assert.equal(a.records[0].sha256, sha256(zipA), '清单记录的 sha256 必须描述真正落盘的 zip');
  assert.equal(a.records[0].size, fs.statSync(zipA).size, 'size 必须是 zip 字节数');
  assert.equal(a.records[0].files, 3, 'files = 条目数');
  assert.equal(a.records[0].bytes, 12, 'bytes = 解包后总字节');
  assert.deepEqual(JSON.parse(fs.readFileSync(a.out, 'utf8')), JSON.parse(fs.readFileSync(b.out, 'utf8')),
    'art-packs.json 也必须逐字节确定');
  fs.rmSync(root, { recursive: true, force: true });
});

test('成员资格：只收 assets/ui/**，zip 里没有 js/ server/ index.html，也没有 ../ 穿越', () => {
  const root = tmpdir('members');
  const webroot = makeWebroot(path.join(root, 'webroot'));
  const { dir, records } = runPacks(webroot, root);
  const names = zipEntryNames(fs.readFileSync(path.join(dir, 'core.ui-3.zip')));
  assert.deepEqual(names, ['assets/ui/a.webp', 'assets/ui/deep/x/y.webp', 'assets/ui/sub/b.webp']);
  for (const n of names) {
    assert.ok(n.startsWith('assets/ui/'), `${n} 必须在 assets/ui/ 下`);
    assert.ok(!n.startsWith('/') && !n.split('/').includes('..'), `${n} 不允许绝对路径/穿越`);
  }
  for (const banned of ['js/', 'server/', 'index.html', '__sp/', 'shell-ui/']) {
    assert.ok(!names.some((n) => n === banned || n.startsWith(banned)), `zip 不得包含 ${banned}`);
  }
  assert.equal(records[0].optional, false);
  assert.equal(records[0].warm, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('构建期内容策略：relpath 越界或不在 assets/ 下的包直接报错', () => {
  const root = tmpdir('reject');
  const webroot = makeWebroot(path.join(root, 'webroot'));
  const allowed = updaterAllowedHosts();
  assert.throws(() => buildPack({ webroot, id: 'core.ui', rel: '../webroot/assets/ui', artVersion: 3, allowedHosts: allowed }),
    /unsafe pack relpath/);
  assert.throws(() => buildPack({ webroot, id: 'core.ui', rel: 'js', artVersion: 3, allowedHosts: allowed }),
    /outside assets\/|no files/);
  assert.throws(() => buildPack({ webroot, id: 'Bad/Id', rel: 'assets/ui', artVersion: 3, allowedHosts: allowed }),
    /bad pack id/);
  // 直接在内存里造一条越界条目：zip 写入器自身也必须拒绝
  assert.throws(() => buildZip([{ name: '../escape.webp', data: Buffer.from('x') }]), /unsafe zip entry name/);
  assert.throws(() => buildZip([{ name: '/abs.webp', data: Buffer.from('x') }]), /unsafe zip entry name/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('urls：主源（CDN/R2）第一；host 不在 Updater.ALLOWED_HOSTS 里就一个 URL 都不写（fail-closed）', () => {
  const allowed = updaterAllowedHosts();
  assert.ok(allowed.includes('weishucdn.jiangjiangze.icu'), 'CDN host 必须在白名单里');
  assert.ok(allowed.includes('dl.jiangjiangze.icu'), '盒侧 host 必须在白名单里');
  const urls = packUrls('core.ui', 3, allowed);
  assert.equal(urls[0], `${ASSETS_BASE}packs/core.ui-3.zip`, '主源必须排第一');
  assert.equal(urls[1], 'https://dl.jiangjiangze.icu/assets-re/packs/core.ui-3.zip');
  assert.deepEqual(packUrls('core.ui', 3, []), [], '白名单为空 = 不写任何 URL');
  assert.deepEqual(updaterAllowedHosts(path.join(repo, 'tools', 'apk', 'no-such-file.java')), [],
    '读不到 Updater.java 必须返回空表（fail-closed）');
  assert.ok(PACK_ID_RE.test('core.ui') && PACK_ID_RE.test('char:char_427_vigil') && PACK_ID_RE.test('audio.bgm'));
  assert.ok(!PACK_ID_RE.test('a/b') && !PACK_ID_RE.test('../x') && !PACK_ID_RE.test(''));
});

// ---------------------------------------------------------------------------
// gen-manifest --packs
// ---------------------------------------------------------------------------

/** A sandbox copy of the signing toolchain: the real gen-manifest + its imports + the real
 *  ALLOWED_HOSTS source. Pointing `repo` at the sandbox also sandboxes gen-manifest's writes
 *  (embedded baseline / publish copy), so a test run never touches the working tree. */
function sandboxRepoTools() {
  const root = tmpdir('sandbox');
  const tools = path.join(root, 'repo', 'tools', 'apk');
  fs.mkdirSync(path.join(tools, 'shell'), { recursive: true });
  for (const f of ['gen-manifest.mjs', 'canonical.mjs', 'ed25519.mjs', 'line.mjs', 'make-art-packs.mjs']) {
    fs.copyFileSync(path.join(here, f), path.join(tools, f));
  }
  fs.copyFileSync(path.join(here, 'shell', 'servers.json'), path.join(tools, 'shell', 'servers.json'));
  const javaDir = path.join(root, 'repo', 'android', 'app', 'src', 'main', 'java', 'icu', 'jiangjiangze', 'stronghold');
  fs.mkdirSync(javaDir, { recursive: true });
  fs.copyFileSync(path.join(repo, 'android', 'app', 'src', 'main', 'java', 'icu', 'jiangjiangze', 'stronghold', 'Updater.java'),
    path.join(javaDir, 'Updater.java'));
  const slim = path.join(root, 'slim.zip');
  fs.writeFileSync(slim, Buffer.from('PK fake slim'));
  return { root, tools, slim };
}

function runGenManifest(sandbox, args) {
  const out = path.join(sandbox.root, `manifest-${Math.random().toString(16).slice(2)}.json`);
  execFileSync(NODE, [path.join(sandbox.tools, 'gen-manifest.mjs'), '--tag', 'shell-v2.9.102',
    '--slim', sandbox.slim, '--out', out, ...args],
    { stdio: 'pipe', env: { ...process.env, SP_SIGN_DIR: signDir().dir } });
  return { out, doc: JSON.parse(fs.readFileSync(out, 'utf8')) };
}

test('gen-manifest --packs：art 块形状 = §7.3（base/version/format/mirrors/packs），签名可验', async () => {
  const root = tmpdir('sign');
  const webroot = makeWebroot(path.join(root, 'webroot'));
  const { out } = runPacks(webroot, path.join(root, 'packs'));
  const sandbox = sandboxRepoTools();
  const { doc } = runGenManifest(sandbox, ['--packs', out, '--art-version', '3',
    '--art-mirrors', 'r2=https://weishucdn.jiangjiangze.icu/assets-re/,box=https://dl.jiangjiangze.icu/assets-re/']);

  assert.deepEqual(Object.keys(doc.art), ['base', 'version', 'format', 'mirrors', 'packs'], 'art 块字段顺序/集合固定');
  assert.equal(doc.art.base, ASSETS_BASE);
  assert.equal(doc.art.version, 3);
  assert.equal(doc.art.format, 1);
  assert.deepEqual(doc.art.mirrors, [
    { id: 'r2', base: 'https://weishucdn.jiangjiangze.icu/assets-re/' },
    { id: 'box', base: 'https://dl.jiangjiangze.icu/assets-re/' },
  ]);
  assert.equal(doc.art.packs.length, 1);
  const p = doc.art.packs[0];
  assert.deepEqual(Object.keys(p),
    ['id', 'sha256', 'size', 'files', 'bytes', 'urls', 'requires', 'optional', 'warm', 'prefixes']);
  assert.equal(p.id, 'core.ui');
  assert.deepEqual(p.requires, [], 'requires defaults to [] (topological order is a future feature)');
  assert.deepEqual(p.prefixes, ['assets/ui/'], 'prefixes makes the pack self-describing (informational)');
  assert.match(p.sha256, /^[0-9a-f]{64}$/);
  assert.ok(p.urls[0].startsWith(ASSETS_BASE), '主源排第一');
  assert.ok(p.urls.every((u) => u.startsWith('https://')));
  // 老壳/既有字段不动
  for (const k of ['buildTag', 'upstreamTag', 'minApk', 'slim', 'servers', 'mirrors', 'keyId']) {
    assert.ok(k in doc, `既有字段 ${k} 必须保留`);
  }

  const keyFile = path.join(signDir().dir, 'ed25519.key');
  // 用同一把（临时）私钥派生公钥验证（等价于设备端用内嵌 pubkey 验签）。gen-manifest 就是用
  // signDir() 里的 seed 签的，所以这里**没有"无密钥就跳过"的分支**：签名这一环在 CI 上必须真验。
  const { canonicalBytes } = await import(pathToFileURL(path.join(sandbox.tools, 'canonical.mjs')).href);
  const { verify, privateKeyFromSeed, rawPublicOf } = await import(pathToFileURL(path.join(sandbox.tools, 'ed25519.mjs')).href);
  const seed = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  assert.equal(seed.length, 32, '私钥必须是 32 字节种子');
  assert.ok(verify(canonicalBytes(doc), Buffer.from(doc.sig, 'base64'), rawPublicOf(privateKeyFromSeed(seed))),
    '整份签名文档（含 art.packs[].sha256）必须通过 Ed25519 验签');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sandbox.root, { recursive: true, force: true });
});

test('gen-manifest 无 --packs：art 保持旧形状 {base}，输出与旧版一致（不新增任何字段）', () => {
  const sandbox = sandboxRepoTools();
  const a = runGenManifest(sandbox, []);
  const b = runGenManifest(sandbox, []);
  assert.deepEqual(a.doc.art, { base: ASSETS_BASE }, '无 --packs 时 art 只能是 {base}');
  assert.ok(!a.doc.art.packs && !a.doc.art.version && !a.doc.art.format && !a.doc.art.mirrors);
  assert.equal(fs.readFileSync(a.out, 'utf8'), fs.readFileSync(b.out, 'utf8'), '同输入两次输出必须逐字节一致');
  fs.rmSync(sandbox.root, { recursive: true, force: true });
});

test('gen-manifest --packs：非法输入必须报错（sha 形态 / id / url / format）', () => {
  const root = tmpdir('bad');
  const webroot = makeWebroot(path.join(root, 'webroot'));
  const { out, records } = runPacks(webroot, path.join(root, 'packs'));
  const sandbox = sandboxRepoTools();
  const cases = [
    ['sha256 不是 64 位小写 hex', { ...records[0], sha256: 'ABC' }],
    ['id 非法', { ...records[0], id: 'Bad/Id' }],
    ['url 不是 https', { ...records[0], urls: ['http://weishucdn.jiangjiangze.icu/assets-re/packs/x.zip'] }],
    ['url host 不在白名单', { ...records[0], urls: ['https://evil.example.com/assets-re/packs/x.zip'] }],
    ['urls 为空', { ...records[0], urls: [] }],
  ];
  for (const [what, rec] of cases) {
    const bad = path.join(root, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify([rec]));
    assert.throws(() => runGenManifest(sandbox, ['--packs', bad, '--art-version', '3']),
      (e) => e.status !== 0, `必须拒绝：${what}`);
  }
  assert.throws(() => runGenManifest(sandbox, ['--packs', out, '--art-version', '3', '--art-format', '2']),
    (e) => e.status !== 0, 'format != 1 必须拒绝（未知布局不签名）');
  assert.throws(() => runGenManifest(sandbox, ['--packs', out]),
    (e) => e.status !== 0, '缺 --art-version 必须拒绝');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sandbox.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// publish-art pure parts
// ---------------------------------------------------------------------------

test('publish-art：art-index 条目形状 {id,sha256,size,version}', () => {
  const entry = indexEntry({ id: 'core.ui', sha256: 'a'.repeat(64), size: 256 }, 3);
  assert.deepEqual(entry, { id: 'core.ui', sha256: 'a'.repeat(64), size: 256, version: 3 });
  assert.deepEqual(Object.keys(entry), ['id', 'sha256', 'size', 'version']);
});

// ---------------------------------------------------------------------------
// 构建期闸门（check-apk 的第 7d 条）与设备端接线
// ---------------------------------------------------------------------------

test('check-apk 7d：ArtStore.java 必须在，且 openLocal 必须经过 ArtStore.open', () => {
  const gate = fs.readFileSync(path.join(here, 'check-apk.mjs'), 'utf8');
  assert.ok(gate.includes('ArtStore.java missing'), 'check-apk 必须断言 ArtStore.java 存在');
  assert.ok(gate.includes('ArtStore\\.open\\('), 'check-apk 必须断言 openLocal 经过 ArtStore.open');
  const ma = fs.readFileSync(path.join(repo, 'android/app/src/main/java/icu/jiangjiangze/stronghold/MainActivity.java'), 'utf8');
  assert.ok(/openLocal\(String path\)[\s\S]{0,900}?ArtStore\.open\(/.test(ma),
    'openLocal 的命中序必须是 webroot → ArtStore.open → APK assets');
  assert.ok(ma.includes('manifestArtVersion'), '缺少 art 水位字段：缺失占位与 artSync 不会生效');
  assert.ok(/if \(manifestArtVersion > 0\)\s*\{[\s\S]{0,200}?return artPlaceholder\(localAsset\)/.test(ma),
    'CDN 素材缺失必须走占位（artVersion > 0 时）');
  assert.ok(ma.includes('maybeArtSyncAfterUpdate'), '热更成功后要顺带触发素材同步');
  assert.ok(ma.includes('public String syncArt()') && ma.includes('public String artStatus()'),
    'ShellBridge 必须有 syncArt()/artStatus()');
  // 素材层绝不进 webroot 的清理/回滚名单（方案 §10-8/9）
  const up = fs.readFileSync(path.join(repo, 'android/app/src/main/java/icu/jiangjiangze/stronghold/Updater.java'), 'utf8');
  const release = up.slice(up.indexOf('for (String name : new String[] {'));
  assert.ok(!/"art"/.test(release.slice(0, 300)), 'releaseUpdateResources 名单里不允许出现 art/art-dl');
});

// ---------------------------------------------------------------------------
// multi-pack bucketing (--buckets): the doc's categories, size-capped shards
// ---------------------------------------------------------------------------

/** A webroot whose data/assets.json (+ local-assets.json) reference the given asset keys. */
function makeBucketWebroot(dir, manifests) {
  for (const [name, refs] of Object.entries(manifests)) {
    const doc = { version: 1, hash: 'fixture', files: {} };
    refs.forEach((key, i) => {
      const rel = key.startsWith('assets/') ? key.slice('assets/'.length) : key;
      // the built manifests carry CDN-rewritten URLs: alternate the two forms to exercise both
      doc.files['k' + i] = i % 2 === 0
        ? `https://weishucdn.jiangjiangze.icu/assets-re/${rel}`
        : `/assets/${rel}`;
      const abs = path.join(dir, key);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.alloc(64, 7));
    });
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(doc));
  }
  return dir;
}

function runPacksBuckets(webroot, outDir, extra = []) {
  const out = path.join(outDir, 'art-packs.json');
  execFileSync(NODE, [path.join(here, 'make-art-packs.mjs'), '--webroot', webroot,
    '--art-version', '4', '--buckets', '--out', out, '--packs-dir', outDir, ...extra], { stdio: 'pipe' });
  return { out, dir: outDir, records: JSON.parse(fs.readFileSync(out, 'utf8')) };
}

test('assetPathOf：/assets/ 与 CDN 的 /assets-re/ 两种形态都归一到 assets/…，其余一律 null', () => {
  assert.equal(assetPathOf('/assets/ui/a.webp'), 'assets/ui/a.webp');
  assert.equal(assetPathOf('https://weishucdn.jiangjiangze.icu/assets-re/ui/a.webp'), 'assets/ui/a.webp');
  assert.equal(assetPathOf('assets/spine/op/x/x.skel'), 'assets/spine/op/x/x.skel');
  assert.equal(assetPathOf('/fonts/fonts.css'), null);
  assert.equal(assetPathOf('/assets/../secret'), null, '穿越被拒');
  assert.equal(assetPathOf('/assets/'), null);
  assert.equal(assetPathOf(null), null);
});

test('bucketize：引用集被分到分桶表的大包，每个引用恰好一次（无孤儿、无重复）', () => {
  const refs = [
    'assets/ui/a.webp', 'assets/ui/guide/g1.webp', 'assets/local/map/m1.png',
    'assets/audio/bgm/b1.mp3', 'assets/audio/voice/cn/char_1/v1.mp3',
    'assets/spine/op/char_1/a.skel', 'assets/spine/op/char_2/b.skel',
    'assets/char/portrait/c1.webp', 'assets/enemy/icon/e1.png', 'assets/skill/s1.png',
  ];
  const { packs, unassigned } = bucketize(refs, () => 1024, { maxBytes: 64 * 1024 * 1024 });
  assert.deepEqual(unassigned, []);
  const byId = new Map(packs.map((p) => [p.id, p]));
  assert.deepEqual([...byId.keys()].sort(), [
    'audio.bgm', 'audio.voice', 'char.all', 'core.chrome', 'core.enemyicon', 'core.guide', 'core.spine.op', 'core.ui', 'local.map',
  ]);
  assert.equal(byId.get('core.guide').optional, true, '教学图是可选包（方案 §2.3）');
  assert.equal(byId.get('audio.voice').optional, true, '语音是可选包');
  assert.deepEqual(byId.get('core.ui').prefixes, ['assets/ui/']);
  // every ref exactly once
  const seen = new Set();
  for (const p of packs) for (const r of p.refs) { assert.ok(!seen.has(r), 'duplicate: ' + r); seen.add(r); }
  assert.equal(seen.size, refs.length);
  // an unknown tree still lands in the assets/ fallback (never unassigned)
  assert.equal(bucketOf('assets/whatever/z.bin').id, 'misc');
  assert.ok(BUCKET_RULES[BUCKET_RULES.length - 1].prefix === 'assets/', 'the fallback rule is last');
});

test('bucketize：超过上限的桶按实体目录确定性分卷（<id>.1/<id>.2…），每个分卷 ≤ 上限', () => {
  const refs = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 3; j++) refs.push(`assets/spine/op/char_${i}/f${j}.skel`);
  const maxBytes = 8 * 1024; // 10 entities × 3 KiB → must shard; a whole entity (3 KiB) stays together
  const { packs } = bucketize(refs, () => 1024, { maxBytes });
  const ids = packs.map((p) => p.id).sort();
  assert.deepEqual(ids, ['core.spine.op.1', 'core.spine.op.2', 'core.spine.op.3', 'core.spine.op.4', 'core.spine.op.5']);
  for (const p of packs) {
    assert.ok(p.bytes <= maxBytes, `${p.id}: ${p.bytes} > ${maxBytes}`);
    // entity-aligned: every ref of one operator sits in ONE shard
    const ops = new Set(p.refs.map((r) => r.split('/')[3]));
    for (const op of ops) {
      const total = packs.reduce((n, q) => n + q.refs.filter((r) => r.split('/')[3] === op).length, 0);
      assert.equal(total, 3, `operator ${op} must not straddle shards`);
    }
  }
});

test('完整性闸门（真实引用集）：repo 的 data/assets.json 7969 条全部被分到恰好一个包', () => {
  const raw = fs.readFileSync(path.join(repo, 'data', 'assets.json'), 'utf8');
  const refs = new Set();
  const re = /"([^"]*\/assets(?:-re)?\/[^"]*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) { const a = assetPathOf(m[1]); if (a) refs.add(a); }
  assert.equal(refs.size, 7969, '线上发布集的规模（art-prefetch 同口径）');
  const { packs, unassigned } = bucketize(refs, () => 4096, { maxBytes: DEFAULT_MAX_PACK_BYTES });
  assert.deepEqual(unassigned, [], '没有引用落到分桶表之外');
  const seen = new Set();
  for (const p of packs) for (const r of p.refs) { assert.ok(!seen.has(r), 'dup ' + r); seen.add(r); }
  assert.equal(seen.size, 7969, `coverage ${seen.size}/7969`);
  // the doc's categories are represented
  for (const [key, id] of [
    ['assets/ui/x.webp', 'core.ui'], ['assets/char/x/p.webp', 'char.all'],
    ['assets/spine/op/x/y.skel', 'core.spine.op'], ['assets/audio/voice/cn/c/v.mp3', 'audio.voice'],
    ['assets/local/map/m.png', 'local.map'], ['assets/enemy/icon/e.png', 'core.enemyicon'],
  ]) assert.equal(bucketOf(key).id, id, `${key} -> ${id}`);
});

test('--buckets：真实 webroot 的完整引用集（含 local-assets.json）全部覆盖，字节确定', () => {
  const webroot = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot');
  if (!fs.existsSync(path.join(webroot, 'data', 'assets.json'))) return; // not built here (CI): covered above
  // A `--no-assets` build keeps the manifests but drops the art tree: the 9567 refs cannot be on
  // disk, so the coverage assertion is meaningless here. The real gate is the packer itself
  // (make-art-packs hard-fails on a missing ref) — skip instead of failing on a valid build shape.
  if (!fs.existsSync(path.join(webroot, 'assets'))) return;
  const root = tmpdir('real');
  const a = runPacksBuckets(webroot, path.join(root, 'a'));
  const b = runPacksBuckets(webroot, path.join(root, 'b'));
  const covered = a.records.reduce((n, r) => n + r.files, 0);
  const { refs } = collectRefs(webroot);
  assert.ok(refs.size >= 7969, `the real ref set is at least the 7969 published refs (got ${refs.size})`);
  assert.equal(covered, refs.size, `coverage ${covered}/${refs.size}`);
  assert.ok(a.records.length >= 4 && a.records.length <= 40, `a few big packs, not hundreds (got ${a.records.length})`);
  for (const r of a.records) {
    assert.ok(r.size <= DEFAULT_MAX_PACK_BYTES + 1024 * 1024, `${r.id}: ${r.size} over the cap`);
    assert.match(r.id, PACK_ID_RE);
  }
  // byte-determinism across two runs: identical json and identical zips
  assert.deepEqual(a.records, b.records, 'same input -> identical art-packs.json');
  for (const r of a.records) {
    const fa = path.join(a.dir, `${r.id}-4.zip`);
    const fb = path.join(b.dir, `${r.id}-4.zip`);
    assert.equal(sha256(fa), sha256(fb), `${r.id}: identical bytes`);
    assert.equal(r.sha256, sha256(fa), `${r.id}: recorded sha256 describes the file`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('--buckets：清单里引用但盘上没有的文件 → 构建期硬失败（宁可不发也不发半包）', () => {
  const root = tmpdir('missing');
  const webroot = makeBucketWebroot(path.join(root, 'webroot'), {
    'data/assets.json': ['assets/ui/a.webp', 'assets/ui/ghost.webp'],
  });
  fs.rmSync(path.join(webroot, 'assets', 'ui', 'ghost.webp')); // referenced but absent
  assert.throws(() => runPacksBuckets(webroot, path.join(root, 'out')), (e) => e.status !== 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('gen-manifest --packs：多包清单（--buckets 产物）形状正确且整份签名可验', async () => {
  const root = tmpdir('multi');
  const webroot = makeBucketWebroot(path.join(root, 'webroot'), {
    'data/assets.json': ['assets/ui/a.webp', 'assets/audio/bgm/b.mp3', 'assets/char/portrait/c.webp'],
    'data/local-assets.json': ['assets/local/map/m.png'],
  });
  const { out, records } = runPacksBuckets(webroot, path.join(root, 'packs'));
  assert.ok(records.length >= 4, 'one pack per bucket');
  const sandbox = sandboxRepoTools();
  const { doc } = runGenManifest(sandbox, ['--packs', out, '--art-version', '4']);
  assert.equal(doc.art.packs.length, records.length);
  for (const p of doc.art.packs) {
    assert.deepEqual(Object.keys(p),
      ['id', 'sha256', 'size', 'files', 'bytes', 'urls', 'requires', 'optional', 'warm', 'prefixes']);
    assert.ok(p.prefixes.every((x) => /^assets\//.test(x)), `${p.id}: prefixes are assets/…`);
  }
  const { canonicalBytes } = await import(pathToFileURL(path.join(sandbox.tools, 'canonical.mjs')).href);
  const { verify, privateKeyFromSeed, rawPublicOf } = await import(pathToFileURL(path.join(sandbox.tools, 'ed25519.mjs')).href);
  const seed = Buffer.from(fs.readFileSync(path.join(signDir().dir, 'ed25519.key'), 'utf8').trim(), 'hex');
  assert.ok(verify(canonicalBytes(doc), Buffer.from(doc.sig, 'base64'), rawPublicOf(privateKeyFromSeed(seed))),
    'the whole multi-pack manifest verifies');
  // a `requires` cycle / unknown target is refused
  const bad = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(bad.length >= 2, 'the fixture produced at least two packs');
  bad[0].requires = [bad[1].id];
  bad[1].requires = [bad[0].id];
  fs.writeFileSync(path.join(root, 'cyc.json'), JSON.stringify(bad));
  assert.throws(() => runGenManifest(sandbox, ['--packs', path.join(root, 'cyc.json'), '--art-version', '4']),
    (e) => e.status !== 0, 'a requires cycle must be refused');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sandbox.root, { recursive: true, force: true });
});

test('设备侧顺序：packs 在逐文件 CDN 回源之前；预取跳过已装 pack 覆盖的路径', () => {
  const ma = fs.readFileSync(path.join(repo, 'android/app/src/main/java/icu/jiangjiangze/stronghold/MainActivity.java'), 'utf8');
  const openLocal = ma.slice(ma.indexOf('private InputStream openLocal(String path)'));
  const body = openLocal.slice(0, openLocal.indexOf('\n    }'));
  const iWebroot = body.indexOf('HostService.contentRoot(this)');
  const iPacks = body.indexOf('ArtStore.open(');
  const iApk = body.indexOf('getAssets().open(');
  assert.ok(iWebroot >= 0 && iPacks > iWebroot && iApk > iPacks,
    'openLocal 命中序必须是 webroot → ArtStore.open(packs) → APK');
  // the prefetch's coverage input enumerates installed packs, so a covered path is never re-requested
  const list = ma.slice(ma.indexOf('private String localArtList()'));
  assert.ok(/ArtStore\.packsDir\(ArtStore\.rootOf\(getFilesDir\(\)\)\)\.listFiles\(\)/.test(list),
    'localArtList 必须枚举已装 pack 目录');
  assert.ok(list.includes('collectLocalArt'), 'and walk them into the coverage list');
  const prefetch = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'art-prefetch.js'), 'utf8');
  assert.ok(prefetch.includes('/__sp/local-assets.txt'), 'art-prefetch.js 消费该清单');
  assert.ok(/localSet && localSet\[path\]/.test(prefetch), '命中清单的条目只计数、不请求');
  // and ArtStore itself serves packs before any CDN cache is consulted
  const art = fs.readFileSync(path.join(repo, 'android/app/src/main/java/icu/jiangjiangze/stronghold/ArtStore.java'), 'utf8');
  assert.ok(/MB\/s/.test(art), 'ArtStore 记录 pack 下载吞吐（MB/s），业主可见');
});
