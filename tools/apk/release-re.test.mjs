// release-re.test.mjs — the re-apk content release's pure parts + its namespace discipline.
//
//   node --test tools/apk/release-re.test.mjs
//
// The orchestrator itself needs rclone + the signing key, so it is not run here; these cover the
// decisions it makes (overlay watermark, slim key) and guard that it never hardcodes a shared key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlayBump, slimKeyOf, artVersionBump } from './release-re.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'release-re.mjs'), 'utf8');
const codeOnly = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('overlayBump：max(候选, 线上+1) —— 设备端只认「严格大于」', () => {
  assert.equal(overlayBump(3, 2), 3, '候选更高就用候选');
  assert.equal(overlayBump(2, 2), 3, '相等必须抬到线上+1（否则设备拒绝更新）');
  assert.equal(overlayBump(1, 25), 26, '回声水位：候选落后就抬到 26');
  assert.equal(overlayBump(0, 0), 1, '全新线也要从 1 起');
  assert.equal(overlayBump('', null), 1, '拿不到值也不许是 0（0 表示通道关闭）');
  assert.equal(overlayBump(undefined, undefined), 1);
});

test('slimKeyOf：slim 的 R2 键与设备端 R2_BUNDLE_BASE 的候选一致', () => {
  assert.equal(slimKeyOf('shell-v2.9.100'), 'apk/content-slim-shell-v2.9.100.zip');
  assert.match(slimKeyOf('shell-v1.2.3'), /^apk\/content-slim-shell-v\d+\.\d+\.\d+\.zip$/);
});

test('artVersionBump：max(候选, 线上+1) 且从 1 起 —— art.version 0 = 通道关闭，永不上签名', () => {
  assert.equal(artVersionBump(3, 2), 3, '候选更高就用候选');
  assert.equal(artVersionBump(2, 2), 3, '相等必须抬到线上+1（否则设备拒绝整批 pack）');
  assert.equal(artVersionBump(1, 7), 8, '回声水位：候选落后就抬到 8');
  assert.equal(artVersionBump(0, 0), 1, '全新线也要从 1 起（0 表示没有素材通道）');
  assert.equal(artVersionBump('', null), 1, '拿不到值也不许是 0');
  assert.equal(artVersionBump(undefined, undefined), 1);
  assert.equal(artVersionBump('9', '8'), 9);
});

test('release-re：art 步骤默认不跑（无 --art 时行为与旧版逐条一致）', () => {
  const code = codeOnly(SRC);
  assert.ok(code.includes("const artEnabled = has('--art')"), '必须有 --art 开关');
  assert.ok(/if \(artEnabled\) \{\s*\n\s*node\('art — make-art-packs/.test(code), 'make-art-packs 只能在 --art 下运行');
  assert.ok(/if \(artEnabled\) signArgs\.push\('--packs'/.test(code), '--packs 只在 --art 时进签名');
  assert.ok(/if \(artEnabled\) \{\s*\n\s*node\('art -> R2/.test(code), 'pack 上传只能在 --art 下运行');
  assert.ok(code.includes('make-art-packs.mjs'), '要调用素材包构建器');
  assert.ok(code.includes('publish-art.mjs'), '要调用素材包发布器');
  assert.ok(code.includes('artVersionBump'), '水位线要过 artVersionBump');
});

test('publish-art：只写本线 -re 命名空间（键名一律从 line.mjs 派生）', () => {
  const src = codeOnly(fs.readFileSync(path.join(here, 'publish-art.mjs'), 'utf8'));
  assert.ok(src.includes("from './line.mjs'"), '必须从 line.mjs 取命名空间');
  assert.ok(src.includes('${ASSETS_DIR}/packs/'), 'pack 键要用 line.mjs 的 ASSETS_DIR 拼接');
  assert.ok(src.includes('${ASSETS_DIR}/art-index.json'), 'art-index 键要用 ASSETS_DIR 拼接');
  assert.ok(!/"assets-re/.test(src), '旧线/本线目录名不许在脚本里写死');
  assert.ok(!/r2:stronghold-assets\//.test(src), 'r2 键必须经 line.mjs 的 r2() 构造');
  assert.ok(src.includes('r2('), 'r2() 必须来自 line.mjs');
});

test('发布器只写本线的键与目录（绝不写旧线的共享指针）', () => {
  const code = codeOnly(SRC);
  assert.ok(code.includes("from './line.mjs'"), '必须从 line.mjs 取命名空间');
  assert.ok(code.includes('r2(slimKeyOf(tag))'), 'slim 上传要用 line 的 r2() 拼接');
  assert.ok(code.includes('manifest-re.json'), '结尾要打印本线的清单地址');
  assert.ok(code.includes('ASSETS_DIR'), '素材目录要用 line.mjs 的 ASSETS_DIR（不许写死 assets-re）');
  assert.ok(!/"assets-re"/.test(code), '目录名不许在脚本里写死');
  assert.ok(!/r2:stronghold-assets\/apk\/latest\.json/.test(code), '不许碰旧线的 APK 指针');
  assert.ok(!/r2:stronghold-assets\/site\/manifest\.json/.test(code), '不许碰旧线的内容指针');
  assert.ok(!/r2:stronghold-assets\/assets['"`\s]/.test(code), '不许写旧线的素材树');
});
