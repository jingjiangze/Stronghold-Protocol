// line.mjs / R2 命名空间的守卫测试。
//
// 2026-10-08 统一：旧 apk 线退役，两条线并成一条，**所有共享路径不带 re 后缀**。
// 这里把三处钉在一起——JS 侧 line.mjs、Java 侧 Line.java、workflow 的写入目标——任何一处
// 又冒出 `-re` 都会红。同时钉住"旧线发布链已退役"：apk.yml / promote.yml 不许再写
// apk/latest.json、site/manifest.json 这些统一后的键，否则两个写入者会互相覆盖。
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

test('line.mjs: 命名空间统一为不带 re', () => {
  assert.equal(L.SUFFIX, '');
  assert.equal(L.CDN, 'https://weishucdn.jiangjiangze.icu');
  assert.equal(L.ASSETS_DIR, 'assets');
  assert.equal(L.ASSETS_BASE, 'https://weishucdn.jiangjiangze.icu/assets/');
  assert.equal(L.SERVERS_KEY, 'site/servers.json');
  assert.equal(L.VERIFIED_KEY, 'site/verified.json');
  assert.equal(L.MANIFEST_KEY, 'site/manifest.json');
  assert.equal(L.MANIFEST_URL, 'https://weishucdn.jiangjiangze.icu/site/manifest.json');
  assert.equal(L.APK_NAME_PREFIX, '');
  assert.equal(L.APK_KEY_PREFIX, 'apk/');
  assert.equal(L.APK_LATEST_KEY, 'apk/latest.json');
  assert.equal(L.r2(L.APK_LATEST_KEY), 'r2:stronghold-assets/apk/latest.json');
  assert.equal(L.TEST_MANIFEST_KEY, 'site/manifest-test.json');
});

test('apk-re.yml: 主写统一命名空间，过渡期只多写两个 -re 别名', () => {
  const yml = read('.github/workflows/apk-re.yml');
  // 主目标（统一、不带 re 后缀）：新 APK（Line.java SUFFIX=''）读的就是这些
  assert.ok(yml.includes('r2:stronghold-assets/apk/stronghold-v${VERSION_NAME}-vc${VC}.apk'),
    'APK 对象用统一名 + vc 后缀（每版一个对象：同名 + immutable 会让复下载拿到旧字节）');
  assert.ok(yml.includes('r2:stronghold-assets/apk/latest.json'), 'APK 指针用 apk/latest.json');
  // 服务器清单**不由发布链写**：单一写入者是下载站的发布路径（玩家提交/维护者发布）
  assert.ok(!yml.includes('r2:stronghold-assets/site/servers.json'), '发布链不许写 site/servers.json（会覆盖玩家提交的清单）');
  assert.ok(/copy \.\.\/dl-cache\/pages-cdn\/assets r2:stronghold-assets\/assets\b/.test(yml), '素材树镜像到 assets');
  // 过渡期唯一允许的两个 -re 目标（2026-10-09，见 line.mjs 的 LEGACY_* 注释）：
  //   ① apk/latest-re.json —— 已装 APK 的更新指针：不写它们就永远收不到新版本（产品级回归）；
  //   ② apk/re-stronghold-v<号>.apk —— 下载站按这个命名约定拼首方 CDN 链接并核字节数。
  // 除这两个之外再冒出 -re 目标就要红（守卫的目的是"改名不留残渣"，不是"永远不许有别名"）。
  assert.ok(yml.includes('r2:stronghold-assets/apk/latest-re.json'), '过渡别名：APK 指针要写 apk/latest-re.json');
  assert.ok(yml.includes('r2:stronghold-assets/apk/re-stronghold-v${VERSION_NAME}.apk'),
    '过渡别名：下载站约定名 apk/re-stronghold-v<号>.apk 要写');
  const legacyTargets = [...yml.matchAll(/r2:stronghold-assets\/[^\s"']+/g)].map((m) => m[0])
    .filter((t) => t.includes('-re') || /\/re-/.test(t))
    .sort();
  assert.deepEqual(legacyTargets, [
    'r2:stronghold-assets/apk/latest-re.json',
    'r2:stronghold-assets/apk/re-stronghold-v${VERSION_NAME}.apk',
  ], '过渡别名必须恰好这两个：多了是漏改，少了老设备会静默停更');
  // 上游锚点门禁必须在这个 workflow 里（构建期补丁才是本线真正的上游冲突面）
  assert.ok(yml.includes('check-patches.mjs'), 'apk-re.yml 必须先跑锚点门禁再构建');
});

test('过渡别名：常量 + 发布脚本 + 设备端识别三处对齐（老设备不停更）', () => {
  // line.mjs 的常量是别名集的唯一真源
  assert.equal(L.LEGACY_SUFFIX, '-re');
  assert.equal(L.LEGACY_ASSETS_DIR, 'assets-re');
  assert.equal(L.LEGACY_SERVERS_KEY, 'site/servers-re.json');
  assert.equal(L.LEGACY_MANIFEST_KEY, 'site/manifest-re.json');
  assert.equal(L.LEGACY_APK_LATEST_KEY, 'apk/latest-re.json');
  assert.equal(L.legacyAliasEnabled(), true, '默认开启；SP_LEGACY_ALIAS=0 才关');
  // 两个发布脚本必须真的把别名写出去（只声明常量不写 = 老设备照旧停更）
  const manifest = read('tools/apk/publish-manifest.mjs');
  assert.ok(manifest.includes('r2(LEGACY_SERVERS_KEY)'), 'publish-manifest 要写 servers 别名');
  assert.ok(manifest.includes('r2(LEGACY_MANIFEST_KEY)'), 'publish-manifest 要写 manifest 别名');
  const latest = read('tools/apk/publish-apk-latest.mjs');
  assert.ok(latest.includes('r2(LEGACY_APK_LATEST_KEY)'), 'publish-apk-latest 要写 APK 指针别名');
  // 设备端要认过渡期的 /assets-re/ 前缀，否则内置清单里的素材会静默漏项（门禁少算而不是报错）
  const artCdn = read('android/app/src/main/java/icu/jiangjiangze/stronghold/ArtCdn.java');
  assert.ok(artCdn.includes('Line.LEGACY_ASSETS_DIR'), 'ArtCdn.assetPathOf 要认 assets-re');
  const lineJava = read('android/app/src/main/java/icu/jiangjiangze/stronghold/Line.java');
  assert.ok(lineJava.includes('LEGACY_ASSETS_DIR = "assets-re"'), 'Line.java 的过渡常量要与 line.mjs 一致');
  const packs = read('tools/apk/make-art-packs.mjs');
  assert.ok(packs.includes('LEGACY_ASSETS_DIR'), '素材打包器也要认 assets-re（老 webroot 的清单带着它）');
});

test('Java Line.java 与 line.mjs 的值必须一致（不许单方面改）', () => {
  const j = read('android/app/src/main/java/icu/jiangjiangze/stronghold/Line.java');
  assert.ok(j.includes('SUFFIX = ""'), 'Line.SUFFIX 必须是空串');
  assert.ok(j.includes('CDN = "https://weishucdn.jiangjiangze.icu"'));
  assert.ok(j.includes('ASSETS_DIR = "assets" + SUFFIX'), 'asset 目录要由 SUFFIX 派生');
  assert.ok(j.includes('CDN + "/" + ASSETS_DIR + "/"'), 'asset 前缀要由 ASSETS_DIR 派生');
  assert.ok(j.includes('CDN + "/site/servers" + SUFFIX + ".json"'));
  assert.ok(j.includes('CDN + "/site/manifest" + SUFFIX + ".json"'));
  assert.ok(j.includes('CDN + "/apk/latest" + SUFFIX + ".json"'));
  assert.ok(j.includes('APK_NAME_PREFIX = ""'), 'APK 文件名不再带 re-');
  assert.ok(!j.includes('"-re"'), 'Line.java 里不许再出现 -re');
});

test('旧线发布链已退役：不再写统一后的键（否则两个写入者互相覆盖）', () => {
  for (const wf of ['.github/workflows/apk.yml', '.github/workflows/promote.yml']) {
    const yml = read(wf);
    assert.ok(!yml.includes('r2:stronghold-assets/apk/latest.json'), `${wf} 仍在写 apk/latest.json`);
    assert.ok(!yml.includes('r2:stronghold-assets/site/manifest.json'), `${wf} 仍在写 site/manifest.json`);
    // 退役方式：不再有任何自动触发（push / schedule / workflow_run），只留手动 dispatch
    assert.ok(yml.includes('workflow_dispatch:'), `${wf} 应保留手动 dispatch`);
    for (const auto of ['push:', 'schedule:', 'workflow_run:']) {
      assert.ok(!new RegExp('^  ' + auto, 'm').test(yml), `${wf} 不应再有 ${auto} 自动触发`);
    }
  }
});

test('客户端从 Line 取地址，不写字面量', () => {
  const up = read('android/app/src/main/java/icu/jiangjiangze/stronghold/Updater.java');
  assert.ok(up.includes('Line.MANIFEST_URL'), '清单地址必须来自 Line');
  assert.ok(up.includes('Line.APK_LATEST_URL'), 'APK 指针必须来自 Line');
  assert.ok(up.includes('readBuiltinManifest'), '内置基线读取必须走线别判定');

  const sl = read('android/app/src/main/java/icu/jiangjiangze/stronghold/ServerList.java');
  assert.ok(sl.includes('Line.SERVERS_URL'), '服务器清单要用 Line.SERVERS_URL');
  assert.ok(sl.includes('Line.VERIFIED_URL'), 'advisor 快照要用 Line.VERIFIED_URL');

  const ma = read('android/app/src/main/java/icu/jiangjiangze/stronghold/MainActivity.java');
  assert.ok(ma.includes('Line.ASSETS_CDN_PREFIX'), '本地树回落重写要用 Line 的 asset 前缀');
});

test('工具层不得写死命名空间（值一律从 line.mjs 取）', () => {
  const files = ['gen-manifest.mjs', 'next-content-tag.mjs', 'publish-apk-latest.mjs',
    'publish-manifest.mjs', 'check-apk.mjs', 'build-webroot.mjs', 'transform-assets.mjs'];
  for (const f of files) {
    const src = codeOnly(read(path.join('tools', 'apk', f)));
    assert.ok(src.includes("from './line.mjs'"), `${f} 必须从 line.mjs 取命名空间`);
    assert.ok(!/"https:\/\/weishucdn\.jiangjiangze\.icu\/assets(-re)?\/"/.test(src), `${f} 仍写着资源根字面量`);
    assert.ok(!/"https:\/\/[^"]*site\/manifest(-re)?\.json"/.test(src), `${f} 仍写着清单指针字面量`);
    assert.ok(!/"https:\/\/[^"]*apk\/latest(-re)?\.json"/.test(src), `${f} 仍写着 APK 指针字面量`);
  }
});

test('转码：两种资源前缀的 .png 引用都要改写（过渡期遗留清单仍可能带 /assets-re/）', async () => {
  const { rewriteManifestRefs } = await import('./transcode-assets.mjs');
  const map = new Map([['a/one.png', 'a/one.webp']]);
  const src = '{"x":"/assets/a/one.png","y":"/assets-re/a/one.png","z":"/assets/a/two.png"}';
  const { text, count } = rewriteManifestRefs(src, map);
  assert.equal(count, 2, '/assets/ 与 /assets-re/ 两种写法都要命中');
  assert.equal(text, '{"x":"/assets/a/one.webp","y":"/assets-re/a/one.webp","z":"/assets/a/two.png"}');
  assert.ok(text.includes('/assets-re/a/one.webp'), '前缀形态要原样保留');
});

test('check-apk 断言的是本线 servers.url', () => {
  const src = codeOnly(read(path.join('tools', 'apk', 'check-apk.mjs')));
  assert.ok(src.includes('SERVERS_URL'), 'servers.url 断言必须用 line.mjs 的值');
});
