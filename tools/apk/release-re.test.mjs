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
import { overlayBump, slimKeyOf } from './release-re.mjs';

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
