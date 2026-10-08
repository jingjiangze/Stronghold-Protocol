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

test('apk-re.yml: 写统一后的键，且不再出现任何 -re 目标', () => {
  const yml = read('.github/workflows/apk-re.yml');
  assert.ok(yml.includes('r2:stronghold-assets/apk/stronghold-v${VERSION_NAME}.apk'), 'APK 对象不带前缀');
  assert.ok(yml.includes('r2:stronghold-assets/apk/latest.json'), 'APK 指针用 apk/latest.json');
  assert.ok(yml.includes('r2:stronghold-assets/site/servers.json'), '服务器清单用 site/servers.json');
  assert.ok(/copy \.\.\/dl-cache\/pages-cdn\/assets r2:stronghold-assets\/assets\b/.test(yml), '素材树镜像到 assets');
  // 过渡期遗留的 -re 目标：注释里提到不算（只看 r2: 形式）
  assert.ok(!/r2:stronghold-assets\/[^\s"']*-re[/.]/.test(yml), '不许再写 -re 目标');
  assert.ok(!yml.includes('r2:stronghold-assets/apk/re-stronghold-v'), 'APK 对象名不再带 re-');
  // 上游锚点门禁必须在这个 workflow 里（构建期补丁才是本线真正的上游冲突面）
  assert.ok(yml.includes('check-patches.mjs'), 'apk-re.yml 必须先跑锚点门禁再构建');
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
