// vendor-title-sync behavior tests: the helper is a READ-ONLY companion to vendor-title.test.mjs —
// it must report "no drift" on the real repo, detect a mutated upstream baseline inside a fixture,
// print the anchor-survival table + NEXT STEPS, and never write a byte anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspect, parseBaseline, anchorSurvival } from './vendor-title-sync.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const CLI = path.join(here, 'vendor-title-sync.mjs');

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const w = (root, rel, text) => {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

const UP_JS = [
  "import { useMemo, useState } from '../../vendor/hooks.module.js';",
  "import { FullscreenButton, detectFeatures } from '../ui/device.js';",
  "export function TitleScreen() { return null; }",
  '',
].join('\n');
const UP_CSS = ['.title-conn .ping { height: .26rem; }', '.title-foot { margin: 0; }', ''].join('\n');

/** A fixture "repo": upstream files + extras copies + a vendor-title.test.mjs carrying the baseline. */
function mkFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-sync-'));
  w(root, 'public/js/screens/title.js', UP_JS);
  w(root, 'public/css/screens/title.css', UP_CSS);
  w(root, 'tools/apk/extras/public/js/screens/title.js', `/* copy */\n${UP_JS}`);
  w(root, 'tools/apk/extras/public/css/screens/title.css', `/* copy */\n${UP_CSS}`);
  refreshBaseline(root);
  return root;
}
function refreshBaseline(root) {
  const jsPath = path.join(root, 'public/js/screens/title.js');
  const cssPath = path.join(root, 'public/css/screens/title.css');
  const js = fs.statSync(jsPath);
  const css = fs.statSync(cssPath);
  w(root, 'tools/apk/vendor-title.test.mjs', [
    '// synthetic fixture',
    'const BASELINE = {',
    `  js: { sha256: '${sha256(jsPath)}', bytes: ${js.size} },`,
    `  css: { sha256: '${sha256(cssPath)}', bytes: ${css.size} },`,
    '};',
    '',
  ].join('\n'));
}

test('parseBaseline reads the js/css constants out of vendor-title.test.mjs', () => {
  const src = fs.readFileSync(path.join(here, 'vendor-title.test.mjs'), 'utf8');
  const b = parseBaseline(src);
  // 0.2.2 基线（2026-10-09 同步：上游给右上角加了「统计」按钮，见 vendor-title 副本文件头）
  assert.equal(b.js.sha256, '6813626a511d093e798145183ae0f2d511f256172b7ee1846c23fbfeced45924');
  assert.equal(b.js.bytes, 14186);
  assert.equal(b.css.sha256, 'ce1e6236ad3d6f323db3957badbc578ea1ba36d5e8515304f12beec569be4f37');
  assert.equal(b.css.bytes, 11089);
  assert.equal(parseBaseline('const BASELINE = {};').js, null, 'a changed format must not silently pass');
});

test('the real repo reports no drift and the CLI exits 0', () => {
  const res = inspect(repo);
  assert.equal(res.ok, true, JSON.stringify(res.drift));
  const run = spawnSync(process.execPath, [CLI, '--repo', repo], { encoding: 'utf-8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /上游基线未漂移/);
});

test('a mutated upstream baseline is detected in a fixture: exit 1, anchor table, NEXT STEPS, read-only', () => {
  const root = mkFixture();
  try {
    // no drift first
    assert.equal(inspect(root).ok, true);
    // upstream title.js changes: the FullscreenButton import line is gone (an O1 anchor)
    fs.writeFileSync(path.join(root, 'public/js/screens/title.js'), UP_JS.replace(
      "import { FullscreenButton, detectFeatures } from '../ui/device.js';",
      "import { detectFeatures } from '../ui/device.js';",
    ));
    const res = inspect(root);
    assert.equal(res.ok, false);
    assert.deepEqual(res.drift.map((d) => d.file), ['js'], 'only the js file drifted');

    const before = sha256(path.join(root, 'public/js/screens/title.js'));
    const run = spawnSync(process.execPath, [CLI, '--repo', root], { encoding: 'utf-8' });
    assert.equal(run.status, 1, 'drift must exit non-zero so it is scriptable');
    assert.match(run.stderr, /上游标题屏已漂移/);
    assert.match(run.stderr, /\[没了\] JS O1 FullscreenButton import/, 'the dead anchor must be named');
    assert.match(run.stderr, /\[在 \] JS v3.5 op0 hooks import/, 'anchors that still match stay visible');
    assert.match(run.stderr, /NEXT STEPS/);
    assert.match(run.stderr, /刷新 tools\/apk\/vendor-title\.test\.mjs 的 BASELINE/);
    assert.equal(sha256(path.join(root, 'public/js/screens/title.js')), before, 'the helper must not write');
  } finally { rm(root); }
});

test('the CSS side is checked too (a changed upstream stylesheet is drift even when JS is intact)', () => {
  const root = mkFixture();
  try {
    fs.appendFileSync(path.join(root, 'public/css/screens/title.css'), '.title-side { top: 1.7rem; }\n');
    const res = inspect(root);
    assert.equal(res.ok, false);
    assert.deepEqual(res.drift.map((d) => d.file), ['css']);
  } finally { rm(root); }
});

test('anchorSurvival maps each rewritten anchor to alive/dead', () => {
  const surv = anchorSurvival(UP_JS, UP_CSS);
  const byId = Object.fromEntries(surv.js.map((a) => [a.id, a.alive]));
  assert.equal(byId['v3.5 op0 hooks import'], true);
  assert.equal(byId['O1 FullscreenButton import'], true);
  assert.equal(byId['O2 开始 主按钮'], false, 'the 开始 button line is absent from the fixture');
  const cssById = Object.fromEntries(surv.css.map((a) => [a.id, a.alive]));
  assert.equal(cssById['.title-conn .ping'], true, 'a present CSS anchor rule is alive');
  assert.equal(cssById['.title-lang {'], false, 'an absent CSS anchor rule is dead (the fixture lacks it)');
});

test('a missing upstream file is an environment error (exit 2), not a silent pass', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-empty-'));
  try {
    const run = spawnSync(process.execPath, [CLI, '--repo', root], { encoding: 'utf-8' });
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /ENV FAIL/);
  } finally { rm(root); }
});
