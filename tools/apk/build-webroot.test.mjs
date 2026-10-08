// build-webroot --no-assets unit tests: the pure helpers that decide whether the ~410 MB asset tree
// is embedded and whether the transcode step may run.
//
//   node --test tools/apk/build-webroot.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noAssetsRequested, hasAssetsTree } from './build-webroot.mjs';

test('noAssetsRequested: --no-assets flag wins', () => {
  assert.equal(noAssetsRequested(['node', 'build-webroot.mjs', '--no-assets'], {}), true);
  assert.equal(noAssetsRequested(['node', 'build-webroot.mjs'], {}), false);
  assert.equal(noAssetsRequested(['node', 'build-webroot.mjs', '--no-webp'], {}), false);
});

test('noAssetsRequested: SP_NO_ASSETS truthy values only', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', ' 1 ']) {
    assert.equal(noAssetsRequested([], { SP_NO_ASSETS: v }), true, `SP_NO_ASSETS=${v}`);
  }
  for (const v of ['', '0', 'false', 'no', 'off', undefined]) {
    assert.equal(noAssetsRequested([], { SP_NO_ASSETS: v }), false, `SP_NO_ASSETS=${String(v)}`);
  }
});

test('hasAssetsTree: true only when assets/ is a directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-bw-'));
  try {
    assert.equal(hasAssetsTree(dir), false, 'empty tree has no assets/');
    fs.mkdirSync(path.join(dir, 'assets'));
    assert.equal(hasAssetsTree(dir), true);
    fs.rmSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets'), 'not a dir');
    assert.equal(hasAssetsTree(dir), false, 'a file named assets is not a tree');
    assert.equal(hasAssetsTree(path.join(dir, 'nope')), false, 'missing dir is not a tree');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
