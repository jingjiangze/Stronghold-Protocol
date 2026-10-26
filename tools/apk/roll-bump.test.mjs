// roll-bump.test.mjs — the pin bump must be idempotent per upstream tag.
//
// WHY (2026-10-26 实测): the first dry-run of the rewritten roll failed with
//   "roll-bump: android/app/build.gradle unchanged after versionName -> 0.3.3"
// because `force` re-runs a roll whose lineage already carries the tag — and versionName was already
// the upstream number. A re-run must re-assert, never bump versionCode a second time (that would
// publish a phantom versionCode with no new content).
//
//   node --test tools/apk/roll-bump.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'roll-bump.mjs');

function mkTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-bump-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  w('android/app/build.gradle', [
    'android {',
    '    versionCode 2064',
    "    versionName '0.3.3'",
    "    buildConfigField 'String', 'EMBEDDED_APP_VERSION', '\"0.3.3\"'",
    '}',
    '',
  ].join('\n'));
  w('lineage.json', JSON.stringify({ upstreamTag: 'v0.3.3', hotTag: 'shell-v3.9.1', shellUiVersion: 25 }, null, 2) + '\n');
  w('tools/apk/shell-ui-version.txt', '98\n');
  return dir;
}
const run = (dir, tag) => execFileSync(process.execPath, [SCRIPT, '--tag', tag, '--sha', 'deadbeef', '--repo', dir], { stdio: 'pipe' }).toString();
const gradle = (dir) => fs.readFileSync(path.join(dir, 'android/app/build.gradle'), 'utf8');
const lineage = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'lineage.json'), 'utf8'));

test('a new tag bumps every pin exactly once', () => {
  const dir = mkTree();
  try {
    run(dir, 'v0.3.4');
    assert.match(gradle(dir), /versionCode 2065/, 'versionCode +1');
    assert.match(gradle(dir), /versionName '0\.3\.4'/, 'versionName follows upstream');
    assert.match(gradle(dir), /EMBEDDED_APP_VERSION', '"0\.3\.4"'/, 'EMBEDDED_APP_VERSION follows upstream');
    const lin = lineage(dir);
    assert.equal(lin.upstreamTag, 'v0.3.4');
    assert.equal(lin.upstream, 'deadbeef');
    assert.equal(lin.hotTag, 'shell-v3.9.2', 'the content tag keeps OUR 3.x.y line (devices compare it)');
    assert.equal(fs.readFileSync(path.join(dir, 'tools/apk/shell-ui-version.txt'), 'utf8').trim(), '99');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('re-running the same tag never bumps twice (force-retry path)', () => {
  const dir = mkTree();
  try {
    run(dir, 'v0.3.4');
    const vcAfterFirst = /versionCode\s+(\d+)/.exec(gradle(dir))[1];
    const hotAfterFirst = lineage(dir).hotTag;
    // second run — this is what `force=true` does after a failed publish
    const out = run(dir, 'v0.3.4');
    assert.equal(/versionCode\s+(\d+)/.exec(gradle(dir))[1], vcAfterFirst, 'versionCode must not move again');
    assert.equal(lineage(dir).hotTag, hotAfterFirst, 'hotTag must not move again');
    assert.match(out, /already on this tag/, 'the run must say it is re-asserting, not bumping');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unknown / malformed tag is refused', () => {
  const dir = mkTree();
  try {
    assert.throws(() => run(dir, 'nonsense'), /--tag must be vX\.Y\.Z/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
