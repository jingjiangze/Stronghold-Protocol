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
import { buildPack, buildZip, packUrls, updaterAllowedHosts, PACK_ID_RE } from './make-art-packs.mjs';
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
  assert.equal(urls[1], 'https://dl.jiangjiangze.icu/assets/packs/core.ui-3.zip');
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
  assert.deepEqual(Object.keys(p), ['id', 'sha256', 'size', 'files', 'bytes', 'urls', 'optional', 'warm']);
  assert.equal(p.id, 'core.ui');
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
