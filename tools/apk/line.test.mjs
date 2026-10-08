// line.mjs / re- 命名空间的守卫测试。
//
// 两条产品线共用一个 R2 bucket（stronghold-assets）：apk/latest.json 是旧线设备的 APK 更新指针，
// site/manifest.json 是旧线的内容指针（devices of BOTH lines read them）。本线任何一次发布写错一个
// 键，就会改掉对方客户端的指针。这里把三处钉在一起——JS 侧 line.mjs、Java 侧 Line.java、workflow
// 的写入目标——任何一处被改回共享名都会红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './line.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
/** Full-line // comments carry the reasoning (and the old key names) — assert against code only. */
const codeOnly = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('line.mjs: 命名空间取值', () => {
  assert.equal(L.SUFFIX, '-re');
  assert.equal(L.CDN, 'https://weishucdn.jiangjiangze.icu');
  assert.equal(L.ASSETS_DIR, 'assets-re');
  assert.equal(L.ASSETS_BASE, 'https://weishucdn.jiangjiangze.icu/assets-re/');
  assert.equal(L.SERVERS_KEY, 'site/servers-re.json');
  assert.equal(L.VERIFIED_KEY, 'site/verified-re.json');
  assert.equal(L.MANIFEST_KEY, 'site/manifest-re.json');
  assert.equal(L.MANIFEST_URL, 'https://weishucdn.jiangjiangze.icu/site/manifest-re.json');
  assert.equal(L.APK_NAME_PREFIX, 're-');
  assert.equal(L.APK_KEY_PREFIX, 'apk/re-');
  assert.equal(L.APK_LATEST_KEY, 'apk/latest-re.json');
  assert.equal(L.r2(L.APK_LATEST_KEY), 'r2:stronghold-assets/apk/latest-re.json');
  assert.equal(L.TEST_MANIFEST_KEY, 'site/manifest-test-re.json');
});

test('apk-re.yml: 只写本线的键，旧线的四个指针一个都不碰', () => {
  const yml = read('.github/workflows/apk-re.yml');
  assert.ok(yml.includes('r2:stronghold-assets/apk/re-stronghold-v${VERSION_NAME}-vc${VC}.apk'),
    'APK 对象要带 re- 前缀与 vc 后缀（每版一个对象：同名 + immutable 会让复下载拿到旧字节）');
  assert.ok(yml.includes('r2:stronghold-assets/apk/latest-re.json'), 'APK 指针要用 latest-re.json');
  assert.ok(yml.includes('r2:stronghold-assets/site/servers-re.json'), '服务器清单要用 servers-re.json');
  assert.ok(/copy \.\.\/dl-cache\/pages-cdn\/assets r2:stronghold-assets\/assets-re\b/.test(yml), '素材树要镜像到 assets-re');
  // 旧线的写入目标：出现即红（注释里提到旧键名不算——这里只看 r2: 形式）
  assert.ok(!yml.includes('r2:stronghold-assets/apk/latest.json'), '不许写旧线的 apk/latest.json');
  assert.ok(!yml.includes('r2:stronghold-assets/site/servers.json'), '不许写旧线的 site/servers.json');
  assert.ok(!yml.includes('r2:stronghold-assets/apk/stronghold-v'), '不许写旧线的 APK 对象名');
  assert.ok(!/r2:stronghold-assets\/assets\s/.test(yml), '不许写旧线的 assets 树');
  // 上游锚点门禁必须在这个 workflow 里（构建期补丁才是本线真正的上游冲突面）
  assert.ok(yml.includes('check-patches.mjs'), 'apk-re.yml 必须先跑锚点门禁再构建');
});

test('Java Line.java 与 line.mjs 的值必须一致（不许单方面改）', () => {
  const j = read('android/app/src/main/java/icu/jiangjiangze/stronghold/Line.java');
  assert.ok(j.includes('SUFFIX = "-re"'), 'Line.SUFFIX 必须是 -re');
  assert.ok(j.includes('CDN = "https://weishucdn.jiangjiangze.icu"'));
  assert.ok(j.includes('ASSETS_DIR = "assets" + SUFFIX'), 'asset 目录要由 SUFFIX 派生');
  assert.ok(j.includes('CDN + "/" + ASSETS_DIR + "/"'), 'asset 前缀要由 ASSETS_DIR 派生');
  assert.ok(j.includes('CDN + "/site/servers" + SUFFIX + ".json"'));
  assert.ok(j.includes('CDN + "/site/manifest" + SUFFIX + ".json"'));
  assert.ok(j.includes('CDN + "/apk/latest" + SUFFIX + ".json"'));
  assert.ok(j.includes('APK_NAME_PREFIX = "re-"'));
});

test('客户端不再读写旧线的清单 / APK 指针', () => {
  const up = read('android/app/src/main/java/icu/jiangjiangze/stronghold/Updater.java');
  assert.ok(up.includes('Line.MANIFEST_URL'), '清单地址必须来自 Line');
  assert.ok(up.includes('Line.APK_LATEST_URL'), 'APK 指针必须来自 Line');
  assert.ok(!up.includes('"https://weishucdn.jiangjiangze.icu/site/manifest.json"'), '不许读旧线内容指针');
  assert.ok(!up.includes('"https://dl.jiangjiangze.icu/data/manifest.json"'), '不许读旧线 Pages 镜像');
  assert.ok(!up.includes('"https://www.weishucdn.jiangjiangze.icu/apk/latest.json"'), '不许读旧线 APK 指针');
  // 内置基线必须过线别判定：旧线那份描述的是另一条线的 slim，离线回落不能跟着走
  assert.ok(up.includes('readBuiltinManifest'), '内置基线读取必须走线别判定');
  assert.ok(!up.includes('parseVerified(readAsset(ctx, BUILTIN_MANIFEST), pub)'), '内置基线不许绕过判定');

  const sl = read('android/app/src/main/java/icu/jiangjiangze/stronghold/ServerList.java');
  assert.ok(sl.includes('Line.SERVERS_URL'), '服务器清单要用 Line.SERVERS_URL');
  assert.ok(sl.includes('Line.VERIFIED_URL'), 'advisor 快照要用 Line.VERIFIED_URL');

  const ma = read('android/app/src/main/java/icu/jiangjiangze/stronghold/MainActivity.java');
  assert.ok(ma.includes('Line.ASSETS_CDN_PREFIX'), '本地树回落重写要用 Line 的 asset 前缀');
});

test('工具层不得保留旧线的指针字面量（值一律从 line.mjs 取）', () => {
  const files = ['gen-manifest.mjs', 'next-content-tag.mjs', 'publish-apk-latest.mjs',
    'publish-manifest.mjs', 'check-apk.mjs', 'build-webroot.mjs', 'transform-assets.mjs'];
  for (const f of files) {
    const src = codeOnly(read(path.join('tools', 'apk', f)));
    assert.ok(src.includes("from './line.mjs'"), `${f} 必须从 line.mjs 取命名空间`);
    assert.ok(!src.includes('"https://weishucdn.jiangjiangze.icu/assets/"'), `${f} 仍写着旧线的资源根`);
    assert.ok(!/"https:\/\/[^"]*site\/manifest\.json"/.test(src), `${f} 仍写着旧线清单指针`);
    assert.ok(!/"https:\/\/[^"]*apk\/latest\.json"/.test(src), `${f} 仍写着旧线 APK 指针`);
  }
});

// ---- 审查（PR #42 的 Sourcery 意见）后的回归钉子：五条都必须在代码里留痕，别再退回去 ----

test('转码：两种资源前缀的 .png 引用都要改写（否则删了 PNG、清单还指着旧名 → 404）', async () => {
  const { rewriteManifestRefs } = await import('./transcode-assets.mjs');
  const map = new Map([['a/one.png', 'a/one.webp']]);
  const src = '{"x":"/assets/a/one.png","y":"/assets-re/a/one.png","z":"/assets/a/two.png"}';
  const { text, count } = rewriteManifestRefs(src, map);
  assert.equal(count, 2, '/assets/ 与 /assets-re/ 两种写法都要命中');
  assert.equal(text, '{"x":"/assets/a/one.webp","y":"/assets-re/a/one.webp","z":"/assets/a/two.png"}');
  assert.ok(text.includes('/assets-re/a/one.webp'), '前缀形态要原样保留');
});

test('转码：清单↔磁盘门禁认两种前缀（否则 re 线的门禁会空转成 0 项通过）', async () => {
  const { manifestRefs } = await import('./transcode-assets.mjs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-gate-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'assets.json'), '{"a":"/assets/x.png","b":"/assets-re/y.png"}');
  const refs = manifestRefs(dir, ['assets.json']).map((r) => r.rel).sort();
  assert.deepEqual(refs, ['x.png', 'y.png']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('check-apk 断言的是本线 servers.url（旧的 dl 地址会把首次内容发布憋死在检查里）', () => {
  const src = codeOnly(read(path.join('tools', 'apk', 'check-apk.mjs')));
  assert.ok(src.includes('SERVERS_URL'), 'servers.url 断言必须用 line.mjs 的值');
  assert.ok(!src.includes('dl\\.jiangjiangze\\.icu\\/data\\/servers\\.json'), '不能再断言旧线 dl 地址');
});

test('advisor 只认本线快照（共享那份会把 re 线自己的服务器隐藏掉）', () => {
  const sl = codeOnly(read('android/app/src/main/java/icu/jiangjiangze/stronghold/ServerList.java'));
  assert.ok(sl.includes('Line.VERIFIED_URL'));
  assert.ok(!sl.includes('"https://weishucdn.jiangjiangze.icu/site/verified.json"'), '不再回退共享 advisor');
});

test('Updater：清单必须属于本线，且全新安装没有基线时要接受第一份本线清单', () => {
  const up = read('android/app/src/main/java/icu/jiangjiangze/stronghold/Updater.java');
  assert.ok(up.includes('belongsToLine(m)'), '候选清单必须过线别判定');
  assert.ok(up.includes('belongsToLine(Manifest m)'), '线别判定要存在');
  assert.ok(up.includes('if (baseline == null) return true;'), '全新安装（无基线）不能永远不更新');
});

test('MainActivity：CDN 素材请求把本线命名空间的路径映射回本地 assets/', () => {
  const ma = read('android/app/src/main/java/icu/jiangjiangze/stronghold/MainActivity.java');
  assert.ok(ma.includes('rawPath.startsWith("/" + Line.ASSETS_DIR + "/")'), '要认 /assets-re/ 前缀');
  assert.ok(ma.includes('"/assets/" + rawPath.substring(Line.ASSETS_DIR.length() + 2)'), '要映射到本地 assets/');
});
