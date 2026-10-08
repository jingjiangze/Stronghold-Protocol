// slim-top tests (审计 §6.2 / R-04): the L1 slim set must be DERIVED from the tree, so an upstream
// top-level directory added later still rides the slim. A fixed whitelist silently dropped it, and
// the hot update swaps the WHOLE tree, so it was lost on the device for good.
//
// Covers: deriveSlimTop excludes only dev/assets (+ build artifacts) / a brand-new top-level dir
// enters the slim / the real upstream tree's i18n (the live gap) is included and assets is not /
// make-bundle's assembly rules + the derivation agree / the three JS consumers import the shared
// module and carry no hard-coded whitelist / the device-side SlimPaths.java deny-list arrays are in
// parity with this module's exports (and verify-slim.mjs probes that parity).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveSlimTop, isSlimExcluded, SLIM_EXCLUDE_DIRS, SLIM_EXCLUDE_FILES, ROOT_ANCHORS, deviceDroppedTop } from './slim-top.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const UPSTREAM = 'C:/Users/16891/android-build/dl-cache/upstream-extracted/Stronghold-Protocol';

const w = (root, rel, text = 'x') => {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

test('deriveSlimTop keeps every top-level entry except the content exclusions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slimtop-'));
  try {
    for (const d of ['index.html', 'js', 'css', 'vendor', 'fonts', 'i18n', 'wasm', 'workers', 'data', 'shared', 'server', 'sim', 'node_modules', 'data.js', 'package.json']) {
      w(root, d === 'index.html' || d === 'data.js' || d === 'package.json' ? d : `${d}/keep.txt`);
    }
    w(root, 'assets/art.png');
    w(root, 'dev/tool.js');
    w(root, 'stamp.txt');
    w(root, 'slim-manifest.txt');
    const tops = deriveSlimTop(root);
    assert.ok(tops.includes('wasm'), 'a new top-level dir (wasm/) must ride the slim');
    assert.ok(tops.includes('workers'), 'a new top-level dir (workers/) must ride the slim');
    assert.ok(tops.includes('i18n'), 'i18n/ must ride the slim (the live gap: translations 404 after a hot update)');
    for (const d of SLIM_EXCLUDE_DIRS) assert.ok(!tops.includes(d), `${d}/ must never ride the slim`);
    for (const f of SLIM_EXCLUDE_FILES) assert.ok(!tops.includes(f), `${f} is a build artifact and must not ride the slim`);
    assert.deepEqual(tops, [...tops].sort(), 'the list is sorted (stable manifest)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('isSlimExcluded: exclusions apply at the top level only, and empty paths are rejected', () => {
  assert.equal(isSlimExcluded('assets'), true);
  assert.equal(isSlimExcluded('assets/a/b.png'), true);
  assert.equal(isSlimExcluded('dev'), true);
  assert.equal(isSlimExcluded('dev/x.js'), true);
  assert.equal(isSlimExcluded('stamp.txt'), true);
  assert.equal(isSlimExcluded('slim-manifest.txt'), true);
  assert.equal(isSlimExcluded(''), true);
  assert.equal(isSlimExcluded('js/main.js'), false);
  assert.equal(isSlimExcluded('i18n/en.json'), false);
  assert.equal(isSlimExcluded('wasm/pkg.js'), false);
  // a nested assets/ is NOT the L2 tree (only the top-level one is excluded)
  assert.equal(isSlimExcluded('js/assets/keep.js'), false);
  assert.equal(isSlimExcluded('assets.txt'), false);
});

test('make-bundle assembly rules + derivation: a new upstream top-level dir reaches the slim', () => {
  // Mirror make-bundle.mjs: public/* minus dev+assets → root, plus data/shared/server/sim/
  // package.json/data.js/node_modules. Then the slim set is derived from THAT tree.
  const up = fs.mkdtempSync(path.join(os.tmpdir(), 'slimtop-up-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slimtop-tmp-'));
  try {
    w(up, 'public/index.html', '<html></html>');
    w(up, 'public/js/main.js');
    w(up, 'public/css/theme.css');
    w(up, 'public/i18n/en.json', '{}');
    w(up, 'public/wasm/pkg.js', 'new!');
    w(up, 'public/assets/art.png');
    w(up, 'public/dev/serve.js');
    w(up, 'data/assets.json', '{}');
    w(up, 'shared/constants.js');
    w(up, 'server/index.js');
    w(up, 'server/sim/simdata.js');
    w(up, 'package.json', '{}');

    for (const name of fs.readdirSync(path.join(up, 'public'))) {
      if (name === 'dev' || name === 'assets') continue;
      fs.cpSync(path.join(up, 'public', name), path.join(tmp, name), { recursive: true });
    }
    for (const d of ['data', 'shared', 'server']) fs.cpSync(path.join(up, d), path.join(tmp, d), { recursive: true });
    fs.copyFileSync(path.join(up, 'package.json'), path.join(tmp, 'package.json'));
    fs.cpSync(path.join(up, 'server', 'sim'), path.join(tmp, 'sim'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'data.js'), '// stand-in\n');
    fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });

    const tops = deriveSlimTop(tmp);
    assert.ok(tops.includes('wasm'), 'the NEW upstream top-level dir must be in the slim set');
    assert.ok(tops.includes('i18n'));
    assert.ok(!tops.includes('assets'), 'L2 art stays out of the slim');
    assert.ok(!tops.includes('dev'), 'dev tooling stays out of the slim');
    for (const must of ['index.html', 'data.js', 'js', 'css', 'data', 'shared', 'server', 'sim', 'package.json', 'node_modules']) {
      assert.ok(tops.includes(must), `${must} must be in the slim set`);
    }
  } finally {
    fs.rmSync(up, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the three JS slim consumers import slim-top.mjs and carry no hard-coded whitelist', () => {
  for (const f of ['build-webroot.mjs', 'make-bundle.mjs', 'verify-slim.mjs']) {
    const src = fs.readFileSync(path.join(here, f), 'utf8');
    assert.ok(src.includes("from './slim-top.mjs'"), `${f} must use the shared slim-top module`);
    assert.ok(!/const\s+SLIM_TOP\s*=\s*\[/.test(src), `${f} must not keep a hard-coded SLIM_TOP whitelist`);
    assert.ok(!src.includes("'vendor', 'fonts', 'shared', 'sim'"), `${f} must not keep the old inline list`);
  }
});

test('build-webroot derives the slim set at both use sites (fresh build and --reuse)', () => {
  const src = fs.readFileSync(path.join(here, 'build-webroot.mjs'), 'utf8');
  const calls = src.match(/deriveSlimTop\(outDir\)/g) || [];
  assert.ok(calls.length >= 2, 'both the fresh-build and the --reuse stamp paths must derive the set');
  assert.ok(/contentStamp\(outDir,\s*slimTop\)/.test(src), 'the content stamp must cover the derived set');
  assert.ok(/slimTop\.join\('\\n'\)/.test(src), 'slim-manifest.txt must be written from the derived set');
});

test('make-bundle derives the slim set from the assembled staging tree', () => {
  const src = fs.readFileSync(path.join(here, 'make-bundle.mjs'), 'utf8');
  assert.ok(/deriveSlimTop\(tmp\)/.test(src), 'the zip top-level set must be derived from tmp');
  assert.ok(!/SLIM_TOP\.filter/.test(src), 'the old whitelist filter must be gone');
});

test('the real upstream tree includes i18n and excludes assets (the live R-04 gap)', (t) => {
  const pub = path.join(UPSTREAM, 'public');
  if (!fs.existsSync(pub)) return t.skip(`no extraction at ${UPSTREAM}`);
  const tops = deriveSlimTop(pub);
  assert.ok(tops.includes('i18n'), 'upstream public/i18n/ must be in the slim set');
  assert.ok(!tops.includes('assets'), 'public/assets/ (L2 art) must stay out of the slim');
  for (const must of ['index.html', 'js', 'css', 'vendor', 'fonts']) {
    assert.ok(tops.includes(must), `${must} must be in the slim set`);
  }
});

/** The device-side deny-list mirror: SlimPaths.java must carry exactly this module's arrays. */
const SLIM_PATHS_JAVA = path.join(repo, 'android', 'app', 'src', 'main', 'java', 'icu', 'jiangjiangze', 'stronghold', 'SlimPaths.java');

/** Same literal parser as verify-slim.mjs's parity probe (kept in lockstep deliberately). */
function javaStringArray(src, name) {
  const m = new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\}`).exec(src);
  return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : null;
}

test('SlimPaths.java deny-list arrays are in exact parity with slim-top.mjs exports', () => {
  const src = fs.readFileSync(SLIM_PATHS_JAVA, 'utf8');
  assert.ok(!/SLIM_TOP\s*=\s*\{/.test(src),
    'the static SLIM_TOP allow-list must be gone: it silently dropped any top-level dir it did not name (R-04)');
  assert.deepEqual(javaStringArray(src, 'SLIM_EXCLUDE_DIRS'), SLIM_EXCLUDE_DIRS,
    'SlimPaths.SLIM_EXCLUDE_DIRS must equal slim-top.mjs SLIM_EXCLUDE_DIRS');
  assert.deepEqual(javaStringArray(src, 'SLIM_EXCLUDE_FILES'), SLIM_EXCLUDE_FILES,
    'SlimPaths.SLIM_EXCLUDE_FILES must equal slim-top.mjs SLIM_EXCLUDE_FILES');
  assert.deepEqual(javaStringArray(src, 'ROOT_ANCHORS'), ROOT_ANCHORS,
    'SlimPaths.ROOT_ANCHORS must equal slim-top.mjs ROOT_ANCHORS');
  // The traversal guard is device-side hardening the JS gate relies on (entries never escape).
  assert.ok(/"\.\."/.test(src) && /"\."/.test(src), 'SlimPaths must keep the explicit "." / ".." guard');
});

test('SlimPaths.resolve() keeps a novel top-level dir and rejects only the exclusions (source contract)', () => {
  const src = fs.readFileSync(SLIM_PATHS_JAVA, 'utf8');
  // Deny-list shape: the fall-through return must be the folded path, not a whitelist miss.
  assert.ok(/return folded;\s*\/\/ deny-list/.test(src),
    'resolve() must fall through to the folded path (deny-list), never drop an unknown top-level dir');
  assert.ok(!/for\s*\(String\s+top\s*:\s*SLIM_TOP\)/.test(src), 'no allow-list loop may survive');
});

test('verify-slim probes SlimPaths.java array parity with slim-top.mjs (not the old SLIM_TOP gap)', () => {
  const src = fs.readFileSync(path.join(here, 'verify-slim.mjs'), 'utf8');
  assert.ok(/javaStringArray\(/.test(src), 'the probe must parse Java string arrays');
  for (const name of ['SLIM_EXCLUDE_DIRS', 'SLIM_EXCLUDE_FILES', 'ROOT_ANCHORS']) {
    assert.ok(src.includes(name), `the probe must compare SlimPaths.${name}`);
  }
  assert.ok(/drifted from tools\/apk\/slim-top\.mjs/.test(src), 'array drift must be named loudly');
  assert.ok(!src.includes('SlimPaths.SLIM_TOP drops slim top-level entries'),
    'the old allow-list warning path must be gone (SlimPaths is a deny-list now)');
  assert.ok(!src.includes('deviceDroppedTop'), 'the probe must not use the allow-list drift detector');
  assert.ok(/parityProbe\(\)/.test(src), 'the probe takes no top-level list anymore');
  // The Java arrays the probe reads must be declared public/static and parseable (the exact
  // values are pinned by the parity test above).
  const slimPaths = fs.readFileSync(SLIM_PATHS_JAVA, 'utf8');
  for (const name of ['SLIM_EXCLUDE_DIRS', 'SLIM_EXCLUDE_FILES', 'ROOT_ANCHORS']) {
    assert.ok(slimPaths.includes(`String[] ${name} = {`), `SlimPaths.java must declare ${name} as a public static final String[]`);
    assert.ok(javaStringArray(slimPaths, name)?.length > 0, `SlimPaths.${name} must stay parseable by the probe`);
  }
});

test('ROOT_ANCHORS stays a small structural set (wrapper detection, not a whitelist)', () => {
  assert.ok(ROOT_ANCHORS.includes('index.html'));
  assert.ok(ROOT_ANCHORS.includes('js/'));
  assert.ok(ROOT_ANCHORS.length <= 12, 'root anchors must stay structural, not become a top-level whitelist');
});

test('deviceDroppedTop (legacy allow-list detector) still finds exactly what such a list would lose', () => {
  // The device side is a deny-list now, so this helper is not used by the gate anymore; it stays
  // exported (and tested) so any future allow-list proposal can be measured against it.
  const accepted = ['index.html', 'data.js', 'js', 'css', 'vendor', 'fonts', 'shared', 'sim', 'data', 'server', 'package.json', 'node_modules'];
  const derived = ['css', 'data', 'data.js', 'fonts', 'i18n', 'index.html', 'js', 'node_modules', 'package.json', 'server', 'shared', 'sim', 'vendor', 'wasm'];
  assert.deepEqual(deviceDroppedTop(derived, accepted), ['i18n', 'wasm']);
  assert.deepEqual(deviceDroppedTop(accepted, accepted), [], 'the old set has no drift against itself');
  assert.deepEqual(deviceDroppedTop(['js', 'wasm'], ['js']), ['wasm'], 'an accepted top-level name covers its subtree');
  assert.deepEqual(deviceDroppedTop(['wasm'], []), ['wasm'], 'an empty allow-list drops everything');
});
