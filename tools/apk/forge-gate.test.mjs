// forge-gate tests (2026-10-15, owner: 「全合并，然后这些 Forge 的内容也是仅在本机服务展示」).
//
// Forge 0.18.6 ships 22 js/ui/ modules our upstream does not have. They were copied VERBATIM into
// extras/public/js/ui/ (zero upstream name collisions, so the merge stays a pure addition), and
// extras/public/js/ui/forge-layer.js is their ONLY entry and their ONLY gate: it reads
// window.__SP_LOBBY.localService() and imports them only when the client runs its OWN local service
// (the phone-hosted server / LAN). On an online or community server it loads NOTHING and touches NO
// DOM -- it only writes window.__SP_FORGE_GATE.
//
// What this file guards, and why each guard exists:
//
//   1. The gate reads the SAME judgement the room page already uses. forge-layer's isLocalService()
//      must call __SP_LOBBY.localService, the function lobby.js:2831 exposes for the "publish to
//      lobby" grey-out. Inventing a second judgement here is how the two halves drift apart.
//   2. Online = zero side effects. Not "few": none. No import, no createElement, no style tag, no
//      fetch/XHR. The whole point of the owner's constraint is that a community server never sees
//      this layer, and a layer that merely fails quietly is not the same as one that never ran.
//   3. Lobby-not-ready is CONSERVATIVE. If lobby.js has not exposed localService yet, the answer
//      must be "not local" (skip the layer), never "local" (expose it anyway).
//   4. A throwing localService() must not escape.
//   5. LINK-TIME integrity. An ES module with a missing named import does not fail at runtime, it
//      fails when the module is linked -- the whole file then never loads, silently, because every
//      load() is deliberately non-fatal. That is exactly how extensions.js broke on its first
//      attempt (it imported ../resources/sources.js, a Forge path with no counterpart in our
//      webroot) and it was found only by a real import(). So this file does a REAL import() of
//      every extras/public/js/ui module against a merged upstream+extras root and fails on any
//      ERR_MODULE_NOT_FOUND. A vm-only test cannot see this class of bug.
//   6. The /__sp/ delivery contract: own prefix only, module type, async=false, idempotence guard.
//
//   node --test tools/apk/forge-gate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EX = path.join(here, 'extras', 'public');
const FORGE = fs.readFileSync(path.join(EX, 'js', 'ui', 'forge-layer.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(EX, 'js', 'shell-bridge.js'), 'utf8');
const UI_DIR = path.join(EX, 'js', 'ui');

// ------------------------------------------------------------------ 1. source shape

test('forge-layer.js exists and is a gated IIFE with its own idempotence marker', () => {
  assert.ok(FORGE.length > 0, 'the gate module must be shipped');
  // The marker is what shell-bridge checks BEFORE injecting, and what the module checks again at
  // its own top. Two layers of the same name, both required.
  assert.ok(/if\s*\(\s*win\.__SP_FORGE\s*\)\s*return/.test(FORGE),
    'the module must early-return on its own marker (a second injection must not re-run it)');
  assert.ok(/window\.__SP_FORGE/.test(BRIDGE),
    'shell-bridge must guard the injection on the same marker');
  assert.ok(/__SP_FORGE_GATE/.test(FORGE), 'the gate must publish a readable state for probes');
});

test('the gate reads __SP_LOBBY.localService -- the same judgement the room page uses', () => {
  // Not a re-implementation: the property lobby.js:2831 exposes.
  assert.ok(/__SP_LOBBY/.test(FORGE) && /localService/.test(FORGE),
    'the gate must ask __SP_LOBBY.localService(), not compute its own answer');
  const lobby = fs.readFileSync(path.join(EX, 'js', 'lobby.js'), 'utf8');
  assert.ok(/__SP_LOBBY\.localService\s*=/.test(lobby),
    'lobby.js must actually expose localService (otherwise the gate always reads "not local")');
  // And the room page uses that same function for its own grey-out -- one judgement, two readers.
  const hook = fs.readFileSync(path.join(EX, 'js', 'room-hook.js'), 'utf8');
  assert.ok(/localService/.test(hook),
    'room-hook.js must consult the same localService judgement (proving it is the shared one)');
});

test('shell-bridge loads the gate from /__sp/ only, as a module, in insertion order', () => {
  assert.ok(BRIDGE.includes("src = '/__sp/ui/forge-layer.js'"), 'the gate is loaded from the own prefix');
  assert.ok(!/src\s*=\s*['"][^'"]*\/js\/ui\/forge-layer\.js['"]/.test(BRIDGE),
    'never load the gate from the page-owned /js/ path');
  const iForge = BRIDGE.indexOf("'/__sp/ui/forge-layer.js'");
  const iLobby = BRIDGE.indexOf("'/__sp/lobby.js'");
  const iFirst = BRIDGE.indexOf("'/__sp/first-screen.js'");
  const iSkin = BRIDGE.indexOf("'/__sp/skin-layer.js'");
  assert.ok(iLobby > 0 && iLobby < iForge,
    'lobby.js must be injected BEFORE the gate, so localService is already exposed when it reads it');
  assert.ok(iFirst > 0 && iFirst < iForge,
    'the gate is a UI layer: it loads after first-screen.js');
  assert.ok(iSkin > iForge,
    'skin-layer.js stays the LAST UI layer, so the gate loads before it');
  // module + insertion order, read off the injected element itself. The guard sits up to 200
  // chars AHEAD of the src (the comment above it is long), so slice the whole block.
  const block = BRIDGE.slice(iForge - 220, iForge + 260);
  assert.ok(/forge\.type\s*=\s*'module'/.test(block), 'the gate must be a module (it uses import())');
  assert.ok(/forge\.async\s*=\s*false/.test(block), 'the gate must keep the insertion order');
  assert.ok(block.includes('window.__SP_FORGE'), 'the injection must be guarded by the marker');
});

// ------------------------------------------------------------------ 2. runtime behaviour

/** A recording world: captures every import the gate attempts and every element it creates. */
function mkWorld({ lobby, importImpl } = {}) {
  const imported = [];
  const created = [];
  const appended = [];
  const win = {
    console,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  };
  if (lobby !== undefined) win.__SP_LOBBY = lobby;
  win.importModule = importImpl || ((url) => { imported.push(url); return Promise.resolve({}); });
  const doc = {
    head: { appendChild: (el) => appended.push(el) },
    documentElement: {},
    createElement: (tag) => { const el = { tagName: String(tag).toUpperCase() }; created.push(el); return el; },
    getElementById: () => null,
    readyState: 'complete',
  };
  const sandbox = { window: win, document: doc, console, setTimeout: win.setTimeout, clearTimeout: win.clearTimeout };
  return { win, sandbox, doc, imported, created, appended, run: () => vm.runInNewContext(FORGE, sandbox, { filename: 'forge-layer.js' }) };
}

test('local service -> the gate opens and imports the Forge manifest', () => {
  const w = mkWorld({ lobby: { localService: () => true } });
  w.run();
  assert.equal(w.win.__SP_FORGE_GATE, 'local', 'the gate must report itself open');
  assert.ok(w.imported.length > 0, 'an open gate must import the Forge modules');
  for (const u of w.imported) {
    assert.ok(u.startsWith('/__sp/ui/'), `every import goes through the own prefix: ${u}`);
    assert.ok(fs.existsSync(path.join(UI_DIR, path.basename(u))), `imported file must exist: ${u}`);
  }
  // The fit CSS is the one thing the gate is allowed to inject, and only while open.
  assert.equal(w.created.filter((el) => el.tagName === 'STYLE').length, 1,
    'the open gate injects exactly its own <style> for --fit-*');
});

test('online / community server -> the gate stays shut: no import, no element, no style', () => {
  const w = mkWorld({ lobby: { localService: () => false } });
  w.run();
  assert.equal(w.win.__SP_FORGE_GATE, 'online', 'the gate must report itself shut');
  assert.equal(w.imported.length, 0, 'NO Forge module may be imported on an online server');
  assert.equal(w.created.length, 0, 'not even a <style>: the online branch touches no DOM at all');
  assert.equal(w.appended.length, 0, 'nothing is appended either');
});

test('lobby not ready yet -> conservative "not local" (never expose the layer to guess)', () => {
  const w = mkWorld({ lobby: undefined });
  w.run();
  assert.notEqual(w.win.__SP_FORGE_GATE, 'local',
    'a missing __SP_LOBBY must NOT open the gate');
  assert.equal(w.imported.length, 0, 'and must import nothing');
});

test('a throwing localService() is contained and still conservative', () => {
  const w = mkWorld({ lobby: { localService: () => { throw new Error('boom'); } } });
  assert.doesNotThrow(() => w.run(), 'a broken judgement must not break the shell');
  assert.notEqual(w.win.__SP_FORGE_GATE, 'local', 'an exception is not a "yes"');
  assert.equal(w.imported.length, 0, 'and must import nothing');
});

test('load() never rejects, so one broken module cannot take the shell down', () => {
  const w = mkWorld({
    lobby: { localService: () => true },
    importImpl: () => Promise.reject(new Error('link failure')),
  });
  w.run();
  // The gate itself must have survived; the rejection is per-module and swallowed.
  assert.equal(w.win.__SP_FORGE_GATE, 'local', 'a rejected import must not flip the gate shut');
});

// ------------------------------------------------------------------ 3. link-time integrity

/**
 * Build the merged root the device actually serves: upstream public/ + extras/public/js overlaid,
 * the way build-webroot.mjs copyExtras() does it (extras/public/** is copied AFTER the upstream
 * copy, so an extras file at a path upstream also has replaces it, and a path upstream lacks is a
 * pure addition). Only the js tree is materialised -- assets are 700+ MB and irrelevant here.
 *
 * The upstream baseline is read from the dl-cache when it is present (that is the tree the real
 * build copies) and falls back to the repository's own `public/` tree, which is the same upstream js
 * committed here without the shell's overlays — so a CI runner, which has no dl-cache, still gets a
 * complete merged root. The js-only overlay is applied unconditionally, because that part IS the repo.
 */
/**
 * The upstream js baseline, in preference order:
 *
 *  1. `$SP_UPSTREAM`, or the dl-cache the real build extracts (`../dl-cache/upstream-extracted/...`).
 *     This is the tree `build-webroot.mjs` actually copies, so it is the authoritative one when present.
 *  2. **The repository's own `public/` tree.** It is the upstream js committed to this repo WITHOUT
 *     the shell's overlays (verified: no extras path such as `js/ui/skin-layer.js` exists there), so
 *     it is an equivalent baseline — and it is what makes this test runnable on a CI runner, which
 *     has no dl-cache at all. Before this fallback existed the merged root was js/ui + js/resources
 *     alone, and the real import() below went red on CI with a wall of ERR_MODULE_NOT_FOUND for
 *     `js/ui/components.js`, `js/audio.js`, `vendor/preact.module.js`, `shared/i18n.js` … while the
 *     static resolution test stayed green — a lesson in why the two checks are not redundant.
 *
 * A null return means no baseline at all, and the caller degrades to extras-only (local dev).
 */
function upstreamRoot() {
  const cands = [
    process.env.SP_UPSTREAM,
    // The dl-cache sits NEXT TO the repository (build-webroot.mjs resolves it as `repo/../dl-cache/...`),
    // so from tools/apk the way up is three levels: tools/apk → tools → repo → android-build.
    path.resolve(here, '..', '..', '..', 'dl-cache', 'upstream-extracted', 'Stronghold-Protocol'),
    'C:/Users/16891/android-build/dl-cache/upstream-extracted/Stronghold-Protocol',
    path.resolve(here, '..', '..'), // the repository itself
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(path.join(c, 'public', 'js'))) return c;
  return null;
}

function buildMergedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-'));
  const pub = path.join(root, 'public');
  const cp = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, e.name);
      const d = path.join(to, e.name);
      if (e.isDirectory()) cp(s, d); else fs.copyFileSync(s, d);
    }
  };
  const up = upstreamRoot();
  if (up) {
    cp(path.join(up, 'public', 'js'), path.join(pub, 'js'));
    cp(path.join(up, 'public', 'vendor'), path.join(pub, 'vendor'));
    if (fs.existsSync(path.join(up, 'shared'))) cp(path.join(up, 'shared'), path.join(root, 'shared'));
  }
  // The whole extras js tree, not just js/ui: extensions.js imports ../resources/sources.js.
  cp(path.join(EX, 'js'), path.join(pub, 'js'));
  return { root, pub, upstream: up, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * Strip comments and string/template literals before scanning for imports.
 *
 * This matters: support-shim.js EXPLAINS in a comment that it replaces a `../../../shared/support.js`
 * import, so a naive regex reads a path that is not really imported and the test goes red on a
 * file that is fine. (The reverse failure -- a real import that looks like a comment -- is why the
 * dynamic import() test below exists: the two checks cover each other.)
 */
function stripNoise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')  // line comments (not inside a string, not a URL)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")   // single-quoted strings
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')   // double-quoted strings
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');    // template literals
}

/** Resolve every relative import of a module against a root, without executing it. */
function missingImports(file, fromDir, root) {
  const src = stripNoise(fs.readFileSync(file, 'utf8'));
  const out = [];
  const re = /import\s[^'"]*?from\s*['"](\.[^'"]+)['"]/gs;
  let m;
  while ((m = re.exec(src)) !== null) {
    const rel = m[1];
    // The module is served from <root>/public/js/**, so ../.. from js/ui lands on <root>/.
    const abs = path.resolve(fromDir, rel);
    const inRoot = path.relative(root, abs);
    if (inRoot.startsWith('..')) { out.push([rel, 'outside the served root']); continue; }
    if (!fs.existsSync(abs)) out.push([rel, 'no such file in the merged root']);
  }
  return out;
}

test('every extras/public/js/ui module links against the merged root (no ERR_MODULE_NOT_FOUND)', () => {
  const { root, pub, cleanup } = buildMergedRoot();
  try {
    const files = fs.readdirSync(UI_DIR).filter((f) => f.endsWith('.js')).sort();
    assert.ok(files.length >= 30, `expected the full overlay ui set, got ${files.length}`);
    const broken = [];
    for (const f of files) {
      // The file must exist in the MERGED root too (it is what gets served).
      const served = path.join(pub, 'js', 'ui', f);
      if (!fs.existsSync(served)) { broken.push(`${f}: not present in the merged root`); continue; }
      const miss = missingImports(served, path.dirname(served), root);
      for (const [rel, why] of miss) broken.push(`${f} -> ${rel} (${why})`);
    }
    assert.deepEqual(broken, [],
      'a module with an unresolvable import fails at LINK time, so it never loads at all -- '
      + 'and every load() here is deliberately non-fatal, so it would fail silently');
  } finally { cleanup(); }
});

test('the real import() of the gate manifest succeeds (the check the first attempt needed)', async () => {
  // Static path resolution above catches a missing FILE. This one catches the other half: a file
  // that exists but does not export the name being imported -- the exact class of bug that took
  // out supportModel.js (shared/support.js has no counterpart in our webroot) and extensions.js
  // (VOICE_LANGS is not exported by our shared/constants.js) before both were fixed.
  const { pub, cleanup } = buildMergedRoot();
  try {
    const manifest = [...FORGE.matchAll(/load\(\s*'(\/__sp\/ui\/[^']+)'\s*\)/g)].map((m) => m[1]);
    assert.ok(manifest.length >= 8, `the gate must declare a manifest, got ${manifest.length}`);
    const failed = [];
    for (const u of manifest) {
      const f = path.join(pub, 'js', 'ui', path.basename(u));
      if (!fs.existsSync(f)) { failed.push(`${u}: missing file`); continue; }
      try {
        // Imports the module and everything it pulls in. A bad named export throws HERE.
        await import(pathToFileURL(f).href);
      } catch (e) {
        failed.push(`${u}: ${(e && e.message ? e.message : String(e)).split('\n')[0]}`);
      }
    }
    assert.deepEqual(failed, [], 'every module the gate loads must actually import cleanly');
  } finally { cleanup(); }
});

test('the Forge-only modules really are pure additions (no upstream name is shadowed)', () => {
  // The authoritative check for shadowing is tools/apk/check-extras-overlap.mjs, which reads the
  // real upstream tree and fails on any undeclared collision (it runs in the suite too). This one
  // adds the merge-side half: every overlay file must REACH the merged tree, so the copy cannot
  // silently drop one. Without a cached upstream baseline the shadowing half is skipped -- going
  // red on a machine with no cache would be a false alarm.
  const { pub, upstream, cleanup } = buildMergedRoot();
  try {
    const merged = new Set(fs.readdirSync(path.join(pub, 'js', 'ui')).filter((f) => f.endsWith('.js')));
    const added = fs.readdirSync(UI_DIR).filter((f) => f.endsWith('.js'));
    assert.ok(added.length >= 30, `expected the full overlay ui set, got ${added.length}`);
    for (const f of added) assert.ok(merged.has(f), `overlay ${f} must reach the merged tree`);
    if (!upstream) return;
    const up = new Set(fs.readdirSync(path.join(upstream, 'public', 'js', 'ui'))
      .filter((f) => f.endsWith('.js')));
    for (const f of up) assert.ok(merged.has(f), `upstream ${f} must survive the overlay`);
    // The 22 Forge-only modules are the ones upstream does not have. Their count is what makes the
    // merge a pure addition rather than a partial one.
    const forgeOnly = added.filter((f) => !up.has(f));
    assert.ok(forgeOnly.length >= 20,
      `expected at least the 20 Forge-only modules (22 minus the 2 we authored), got ${forgeOnly.length}: ${forgeOnly.join(', ')}`);
    assert.ok(forgeOnly.includes('extensions.js'), 'extensions.js is Forge-only and must be shipped');
    assert.ok(forgeOnly.includes('supportModel.js'), 'supportModel.js is Forge-only and must be shipped');
  } finally { cleanup(); }
});
