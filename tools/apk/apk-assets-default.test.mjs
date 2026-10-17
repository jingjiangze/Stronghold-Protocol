// apk-assets-default.test.mjs — the APK must EMBED its art by default.
//
//   node --test tools/apk/apk-assets-default.test.mjs
//
// WHY (2026-10-17 现场故障「装了之后加载很慢」):
// `.github/workflows/apk-re.yml` declared `workflow_dispatch.inputs.no_assets` with
// `default: true`. A bare `gh workflow run apk-re.yml -f ref=...` therefore shipped an APK with
// ZERO `assets/webroot/assets/**` entries (measured on shell-v0.3.0-vc2037: 0 entries, 196.7 MiB,
// every art request falling through to the R2 CDN). The owner's instruction is the opposite:
// embed the art, and do not depend on R2.
//
// The defaults are the whole failure: nothing in the build logs says "you are shipping a CDN-only
// package", so the mistake is invisible until the APK is on a phone. This gate pins the three
// places that decide it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

const WORKFLOW = read('.github/workflows/apk-re.yml');
const RELEASE_RE = read('tools/apk/release-re.mjs');

test('apk-re.yml: no_assets defaults to FALSE (assets embedded)', () => {
  const block = /no_assets:\s*\n(?:.*\n)*?\s*default:\s*(\w+)/.exec(WORKFLOW);
  assert.ok(block, 'no_assets input not found in apk-re.yml');
  assert.equal(block[1], 'false',
    'no_assets must default to false — true ships an APK with zero assets/webroot/assets/** '
    + '(that is exactly the vc2037 "loads very slowly" regression)');
});

test('apk-re.yml: the R2 asset-mirror job is opt-in (default off)', () => {
  const block = /mirror_assets:\s*\n(?:.*\n)*?\s*default:\s*(\w+)/.exec(WORKFLOW);
  assert.ok(block, 'mirror_assets input not found in apk-re.yml');
  assert.equal(block[1], 'false', 'the R2 mirror must not run unless asked for');
  assert.ok(/^  assets:\s*\n(?:.*\n)*?    if: \$\{\{ inputs\.mirror_assets \}\}/m.test(WORKFLOW),
    'the assets job must be gated on inputs.mirror_assets');
});

test('apk-re.yml: SP_NO_ASSETS is only set from the input', () => {
  assert.ok(/SP_NO_ASSETS: \$\{\{ inputs\.no_assets && '1' \|\| '' \}\}/.test(WORKFLOW),
    'SP_NO_ASSETS must come from the input, not a hard-coded value');
});

test('release-re.mjs: embedded assets are the default (--no-embedded-assets opts out)', () => {
  assert.ok(/if \(has\('--no-embedded-assets'\)\) env\.SP_NO_ASSETS = '1';\s*\n\s*else delete env\.SP_NO_ASSETS;/.test(RELEASE_RE),
    'release-re must embed by default; only --no-embedded-assets may strip the art');
  assert.ok(!/if \(!has\('--embedded-assets'\)\) env\.SP_NO_ASSETS = '1';/.test(RELEASE_RE),
    'the old opt-in default (strip unless --embedded-assets) must be gone');
});
