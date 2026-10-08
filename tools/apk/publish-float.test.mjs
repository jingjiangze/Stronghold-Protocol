// publish-float removal guard (2026-10-08): the floating "publish to lobby" capsule was removed at
// the owner's request. The layer is gone, so this file no longer exercises button behaviour — it
// asserts the removal is COMPLETE, so a stray re-introduction (file or loader block) goes red.
//
// Why a guard instead of deleting the file: the capsule only ever existed because of two places —
// the shipped extras/public/js/publish-float.js and the shell-bridge.js /__sp/ loader block. If
// either comes back alone (file without loader, loader without file, or a stale __SP_PUBFLOAT
// guard), the shell would ship a dead reference. This test is the tripwire for that.
//
// The independent room-page entry ("公开到大厅" via room-hook.js, backed by __SP_LOBBY) is NOT
// affected and is still covered by room-hook.test.mjs / lobby-own-report.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jsDir = path.join(here, 'extras', 'public', 'js');
const BRIDGE = fs.readFileSync(path.join(jsDir, 'shell-bridge.js'), 'utf8');

test('publish-float.js does not exist (the floating capsule was removed)', () => {
  assert.equal(fs.existsSync(path.join(jsDir, 'publish-float.js')), false,
    'the floating publish capsule file must not be shipped');
});

test('shell-bridge.js no longer loads the publish-float layer or its marker', () => {
  assert.equal(BRIDGE.includes('publish-float'), false,
    'no /__sp/publish-float.js reference may remain in the loader');
  assert.equal(BRIDGE.includes('__SP_PUBFLOAT'), false,
    'no __SP_PUBFLOAT marker guard may remain');
  assert.equal(/\/__sp\/[^'"]*publish/i.test(BRIDGE), false,
    'no /__sp/ script src may mention the removed layer');
});

test('the remaining /__sp/ loader list is intact and skin-layer.js stays the last UI layer', () => {
  // Read the loader srcs straight from the bridge so a future edit that drops a *different* layer,
  // reorders skin-layer.js off the tail, or re-adds publish-float is caught here.
  const srcs = [...BRIDGE.matchAll(/src\s*=\s*'(\/__sp\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(srcs.length >= 8, `expected the full overlay set, got ${srcs.length}: ${srcs.join(', ')}`);
  // v6.9 (no-embedded-assets): art-prefetch.js is deliberately appended AFTER skin-layer.js, so the
  // background prefetch never contends with the UI layers; skin stays the last UI layer. v7.1 adds
  // the browser-cache preload center after it (a second background walker, same policy).
  assert.equal(srcs[srcs.length - 1], '/__sp/preload-center.js', 'preload-center.js is the last loader entry');
  assert.equal(srcs[srcs.length - 2], '/__sp/art-prefetch.js', 'art-prefetch.js stays ahead of the preload center');
  assert.equal(srcs[srcs.length - 3], '/__sp/skin-layer.js', 'skin-layer.js must stay the last UI layer');
  assert.ok(!srcs.includes('/__sp/publish-float.js'), 'publish-float.js must not be in the loader list');
});
