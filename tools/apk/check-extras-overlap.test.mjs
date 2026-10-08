// check-extras-overlap (GATE-R5) behavior tests: build synthetic upstream trees + synthetic extras
// trees, run the REAL checker and prove it fails loudly on an undeclared collision / a stale
// override declaration / an orphaned override, and passes on the declared vendored-title pair.
//
// Covers: the real repo passes (2 declared overlaps) / an undeclared extras file shadowing upstream
// fails and is named / an overlay colliding with an upstream server/overlay/ fails / a declared
// override whose extras file is gone fails / a declared override whose upstream target disappeared
// fails (R-01 一类静默回归) / the CLI exits non-zero with OVERLAP FAIL lines / the premise (copyExtras
// runs AFTER the upstream copy in build-webroot.mjs, both assemble and reuse paths).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findOverlaps, listExtras, ALLOWED_OVERRIDES } from './check-extras-overlap.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const CLI = path.join(here, 'check-extras-overlap.mjs');

const w = (root, rel, text = 'x') => {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

/** A minimal upstream tree that carries the two vendored-title paths. */
function mkUpstream() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extras-upstream-'));
  w(root, 'public/index.html');
  w(root, 'public/js/screens/title.js', 'export function TitleScreen() {}\n');
  w(root, 'public/css/screens/title.css', '.title-main {}\n');
  w(root, 'public/js/main.js', 'boot();\n');
  return root;
}

/** A synthetic extras tree: only the two declared title overrides. */
function mkExtras() {
  const extras = fs.mkdtempSync(path.join(os.tmpdir(), 'extras-shell-'));
  w(extras, 'public/js/screens/title.js', '/* vendored */\n');
  w(extras, 'public/css/screens/title.css', '/* vendored */\n');
  const overlay = fs.mkdtempSync(path.join(os.tmpdir(), 'extras-overlay-'));
  w(overlay, 'sp-host.mjs', 'export const overlayApi = 1;\n');
  return { extras, overlay };
}

test('the declared title overrides pass; nothing else overlaps', () => {
  const up = mkUpstream();
  const { extras, overlay } = mkExtras();
  try {
    const res = findOverlaps(up, { extrasDir: extras, overlayDir: overlay });
    assert.equal(res.ok, true, JSON.stringify(res.findings, null, 2));
    assert.deepEqual(res.overlaps.map((o) => o.webroot).sort(), ['css/screens/title.css', 'js/screens/title.js']);
    assert.equal(res.findings.length, 0);
  } finally { rm(up); rm(extras); rm(overlay); }
});

test('an undeclared extras file shadowing an upstream path fails and is named', () => {
  const up = mkUpstream();
  const { extras, overlay } = mkExtras();
  try {
    w(extras, 'public/js/main.js', '/* ours would silently replace upstream boot */\n');
    const res = findOverlaps(up, { extrasDir: extras, overlayDir: overlay });
    assert.equal(res.ok, false);
    const f = res.findings.find((x) => x.id === 'overlap:js/main.js');
    assert.ok(f, 'the undeclared collision must be reported');
    assert.match(f.detail, /upstream\/js\/main\.js|js\/main\.js/);
    assert.match(f.why, /B5|R-14/);
  } finally { rm(up); rm(extras); rm(overlay); }
});

test('an overlay colliding with an upstream server/overlay/ path fails', () => {
  const up = mkUpstream();
  const { extras, overlay } = mkExtras();
  try {
    w(up, 'public/server/overlay/sp-host.mjs', 'export const overlayApi = 1;\n');
    const res = findOverlaps(up, { extrasDir: extras, overlayDir: overlay });
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((x) => x.id === 'overlap:server/overlay/sp-host.mjs'),
      'upstream adding its own server/overlay/sp-host.mjs would be shadowed by ours');
  } finally { rm(up); rm(extras); rm(overlay); }
});

test('a declared override with no extras file fails (the ALLOWED_OVERRIDES table drifted)', () => {
  const up = mkUpstream();
  const { extras, overlay } = mkExtras();
  try {
    fs.rmSync(path.join(extras, 'public', 'css', 'screens', 'title.css'));
    const res = findOverlaps(up, { extrasDir: extras, overlayDir: overlay });
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((x) => x.id === 'override-missing:css/screens/title.css'));
  } finally { rm(up); rm(extras); rm(overlay); }
});

test('an orphaned override (upstream renamed the file) fails — the vendored screen would go dead', () => {
  const up = mkUpstream();
  const { extras, overlay } = mkExtras();
  try {
    fs.rmSync(path.join(up, 'public', 'js', 'screens', 'title.js'));
    const res = findOverlaps(up, { extrasDir: extras, overlayDir: overlay });
    assert.equal(res.ok, false);
    const f = res.findings.find((x) => x.id === 'override-orphan:js/screens/title.js');
    assert.ok(f, 'a renamed upstream title screen must fail the gate (R-01 一类静默回归)');
    assert.match(f.detail, /nothing imports it/);
  } finally { rm(up); rm(extras); rm(overlay); }
});

test('the extras→webroot mapping mirrors copyExtras/copyOverlays (public→root, server→server/, overlay→server/overlay/)', () => {
  const extras = fs.mkdtempSync(path.join(os.tmpdir(), 'extras-map-'));
  const overlay = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-map-'));
  try {
    w(extras, 'public/js/ui/shellPanels.js');
    w(extras, 'public/js/notices.json');
    w(extras, 'server/android-main.mjs');
    w(extras, 'server/overlay-loader.mjs');
    w(overlay, 'sp-lobby.mjs');
    const list = listExtras(extras, overlay);
    const map = Object.fromEntries(list.map((e) => [e.src, e.webroot]));
    assert.equal(map['public/js/ui/shellPanels.js'], 'js/ui/shellPanels.js');
    assert.equal(map['public/js/notices.json'], 'js/notices.json');
    assert.equal(map['server/android-main.mjs'], 'server/android-main.mjs');
    assert.equal(map['overlay/sp-lobby.mjs'], 'server/overlay/sp-lobby.mjs');
  } finally { rm(extras); rm(overlay); }
});

test('the real repo tree passes (the two vendored title overrides are declared and still upstream)', () => {
  const res = findOverlaps(repo);
  assert.equal(res.ok, true, JSON.stringify(res.findings, null, 2));
  assert.deepEqual(res.overlaps.map((o) => o.webroot).sort(), ['css/screens/title.css', 'js/screens/title.js']);
  assert.equal(res.allowed.length, ALLOWED_OVERRIDES.length);
});

test('CLI: exit 0 on the real repo, exit 1 with OVERLAP FAIL naming the file on a collision', () => {
  const okRun = spawnSync(process.execPath, [CLI, repo], { encoding: 'utf-8' });
  assert.equal(okRun.status, 0, okRun.stderr);
  assert.match(okRun.stdout, /all declared, all still upstream/);

  const up = mkUpstream();
  const { extras, overlay } = mkExtras();
  try {
    w(extras, 'public/js/main.js', '/* shadow */\n');
    const badRun = spawnSync(process.execPath,
      [CLI, '--tree', up, '--extras', extras, '--overlay', overlay], { encoding: 'utf-8' });
    assert.equal(badRun.status, 1);
    assert.match(badRun.stderr, /OVERLAP FAIL: overlap:js\/main\.js/);
    assert.match(badRun.stderr, /extras overlap: 1 problem\(s\)/);
  } finally { rm(up); rm(extras); rm(overlay); }
});

test('premise: build-webroot runs copyExtras AFTER the upstream copy (assemble + reuse paths)', () => {
  const src = fs.readFileSync(path.join(here, 'build-webroot.mjs'), 'utf8');
  const upstreamCopy = src.indexOf("for (const name of fs.readdirSync(path.join(src, 'public')))");
  // the ASSEMBLE path re-applies extras after the upstream tree lands (the reuse path at the top of
  // the file copies extras again over the already-materialised tree)
  assert.ok(upstreamCopy > 0 && src.lastIndexOf('copyExtras();') > upstreamCopy,
    'copyExtras must run after the upstream tree copy — otherwise this gate proves nothing');
  assert.ok(src.split('copyExtras();').length - 1 >= 2,
    'both the assemble path and the --reuse path must re-apply extras (the reuse path re-stamps the slim)');
});
