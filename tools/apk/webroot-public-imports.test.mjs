// webroot-public-imports.test.mjs — 钉住「扁平 webroot 必须带嵌套 public/js + public/studio」。
//
//   node --test tools/apk/webroot-public-imports.test.mjs
//
// WHY（2026-10-18 P0）：0.3.1 服务端运行期 import '../../public/js/render/vfx/pluginFormat.js'、
// '../../public/studio/js/gameplayModel.js' 等（fxAssets/contentData/fxRecords/operatorTraits +
// studio 全家）。build-webroot 的顶层循环把 public/* 摊平到 webroot 根（拦截器要的形状），但这两个
// 相对路径从 server/plugins 解析到 <webroot>/public/… —— 摊平的顶层拷贝顶不到它。vc2046/vc2047 的
// CI 包就是漏了这份嵌套子树，从包内 webroot 删 public/ 后实测 import('server/index.js') 抛
// ERR_MODULE_NOT_FOUND（手机表现 = 「离线服务 60 秒没起来」）。
//
// 这个测试跑在 build-webroot **之前**（FULL suite），所以它断言的是**出厂源码的拷贝清单**（与
// android-main-publicdir.test.mjs 同一套静态门禁做法）：确保那两条 cpSync 仍在、且只拷代码目录
// （不许拷整个 public/，那会把 410 MB public/assets 在包内再拷一份）。真正的「能不能 boot」由
// check-webroot-boot.mjs（build 之后的 CI 步骤）兜底。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const BW = fs.readFileSync(path.join(here, 'build-webroot.mjs'), 'utf8');

test('build-webroot 显式拷嵌套 public/js + public/studio（顶层循环摊平后仍需这两条）', () => {
  // 必须是 public/js 与 public/studio 两个具体目录的 cpSync，且落到 outDir/public/。
  assert.ok(/cpSync\(path\.join\(src, 'public', dir\), path\.join\(outDir, 'public', dir\), \{ recursive: true \}\)/.test(BW),
    '必须逐目录 cpSync public/js、public/studio → outDir/public/（顶层循环只摊平，不产生嵌套 public/）');
  assert.ok(/for \(const dir of \['js', 'studio'\]\)/.test(BW),
    '拷贝清单必须是这两项（js + studio）——它们正好覆盖上游 server 的全部 ../../public 模块引用');
});

test('绝不整拷 public/（会把 410 MB public/assets 在包内再拷一份）', () => {
  // 顶层循环之后，任何 `cpSync(path.join(src, 'public'), path.join(outDir, 'public')` 的整拷都禁止。
  assert.ok(!/cpSync\(\s*path\.join\(src, 'public'\),\s*path\.join\(outDir, 'public'\),\s*\{ recursive: true \}/.test(BW),
    '不许 cpSync 整个 public/ → outDir/public（全量构建会把 public/assets 拷进包，APK 翻倍）');
});

test('CI 里有 build 之后的 boot 门禁（check-webroot-boot），且 check-apk 钉住入口文件', () => {
  const gate = path.join(here, 'check-webroot-boot.mjs');
  assert.ok(fs.existsSync(gate), 'check-webroot-boot.mjs 必须存在（真 import 模块图 + 静态引用扫描）');
  const yml = fs.readFileSync(path.join(repo, '.github', 'workflows', 'apk-re.yml'), 'utf8');
  assert.ok(yml.includes('node tools/apk/check-webroot-boot.mjs'), 'apk-re.yml 必须在 build-webroot 后跑 boot 门禁');
  // 门禁顺序：build-webroot → check-webroot-boot → make-bundle → assembleRelease
  const iBuild = yml.indexOf('build-webroot.mjs');
  const iGate = yml.indexOf('check-webroot-boot.mjs');
  const iBundle = yml.indexOf('make-bundle.mjs');
  const iApk = yml.indexOf('assembleRelease');
  assert.ok(iBuild > 0 && iGate > iBuild && iBundle > iGate && iApk > iBundle,
    '门禁必须排在 build-webroot 之后、make-bundle/assemble 之前（缺子树就红，别把坏包打出去）');
  // check-apk 把两条引用面最大的入口钉成 CRITICAL_ASSETS（包内层面兜底）。
  const apk = fs.readFileSync(path.join(here, 'check-apk.mjs'), 'utf8');
  assert.ok(apk.includes("'assets/webroot/public/js/render/vfx/pluginFormat.js'"), 'check-apk 必须钉 pluginFormat.js');
  assert.ok(apk.includes("'assets/webroot/public/studio/js/gameplayModel.js'"), 'check-apk 必须钉 gameplayModel.js');
});
