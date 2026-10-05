// overlay-loader.test.mjs — unit tests for the shell's server overlay loading point (v2.8.0).
//
//   node --test tools/apk/overlay-loader.test.mjs
//
// The loader resolves its overlay directory RELATIVE TO ITSELF, so each test copies the real
// shipped file (extras/server/overlay-loader.mjs) into a temp `server/` dir and drops fixture
// overlays next to it — the production file is what gets exercised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, 'extras', 'server', 'overlay-loader.mjs');

/** Temp `server/` with the real loader + fixture overlays. */
function fixtureTree(overlays = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-overlay-'));
  const server = path.join(root, 'server');
  fs.mkdirSync(path.join(server, 'overlay'), { recursive: true });
  fs.copyFileSync(SRC, path.join(server, 'overlay-loader.mjs'));
  for (const [name, body] of Object.entries(overlays)) {
    fs.writeFileSync(path.join(server, 'overlay', name), body);
  }
  return { root, server };
}

const importLoader = (server) => import(pathToFileURL(path.join(server, 'overlay-loader.mjs')).href);

test('loads good overlays in filename order with the documented ctx', async () => {
  const { root, server } = fixtureTree({
    '02-second.mjs': "export const overlayApi=1;export const id='two';export function install(ctx){globalThis.__sp_ov.push(['two',ctx.api,ctx.port,ctx.id]);}",
    '01-first.mjs': "export const overlayApi=1;export function install(ctx){globalThis.__sp_ov.push([ctx.id,ctx.api,ctx.port,ctx.server.tag]);}",
  });
  globalThis.__sp_ov = [];
  const { loadOverlays, OVERLAY_API } = await importLoader(server);
  assert.equal(OVERLAY_API, 1);
  const res = await loadOverlays({ server: { tag: 'srv' }, port: 4242, log: () => {} });
  assert.deepEqual(res.loaded, ['01-first', 'two']); // module without id falls back to its filename
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(globalThis.__sp_ov, [['01-first', 1, 4242, 'srv'], ['two', 1, 4242, 'two']]);
  delete globalThis.__sp_ov;
  fs.rmSync(root, { recursive: true, force: true });
});

test('isolates broken modules, api mismatches and throwing installs — never throws', async () => {
  const { root, server } = fixtureTree({
    'a-broken.mjs': 'this is not javascript(((',
    'b-oldapi.mjs': "export const overlayApi=0;export const id='old';export function install(){throw new Error('must not run');}",
    'c-throwing.mjs': "export const overlayApi=1;export const id='boom';export function install(){throw new Error('install failed');}",
    'd-good.mjs': "export const overlayApi=1;export const id='ok';",
    'notes.txt': 'ignored — only .mjs is loaded',
  });
  const { loadOverlays } = await importLoader(server);
  const logs = [];
  const res = await loadOverlays({ server: {}, port: 1, log: (m) => logs.push(String(m)) });
  assert.deepEqual(res.loaded, ['ok']);
  assert.deepEqual(res.skipped.map((s) => s.name), ['a-broken.mjs', 'b-oldapi.mjs', 'c-throwing.mjs']);
  assert.match(res.skipped[1].reason, /overlayApi 0/);
  assert.match(res.skipped[2].reason, /install failed/);
  assert.ok(logs.some((l) => l.includes('[overlay] load') && l.includes('ok')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('missing overlay directory is a clean no-op (and default log never throws)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-overlay-'));
  const server = path.join(root, 'server');
  fs.mkdirSync(server, { recursive: true });
  fs.copyFileSync(SRC, path.join(server, 'overlay-loader.mjs'));
  const { loadOverlays } = await importLoader(server);
  const res = await loadOverlays({ server: {}, port: 1 }); // no log provided
  assert.deepEqual(res, { loaded: [], skipped: [] });
  fs.rmSync(root, { recursive: true, force: true });
});

test('source wiring: the android entry calls the loader and the loader ships in extras', () => {
  assert.ok(fs.existsSync(path.join(here, 'extras', 'server', 'overlay-loader.mjs')), 'extras/server/overlay-loader.mjs missing');
  const entry = fs.readFileSync(path.join(here, 'extras', 'server', 'android-main.mjs'), 'utf-8');
  assert.ok(entry.includes("from './overlay-loader.mjs'"), 'android-main.mjs must import the loader');
  assert.ok(entry.includes('loadOverlays('), 'android-main.mjs must call loadOverlays');
  assert.ok(entry.includes('overlays: overlays.loaded'), 'handshake must report the loaded overlays');
});

test('the built webroot carries the loader when present', async (t) => {
  const repo = path.resolve(here, '..', '..');
  const wroot = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot');
  const loader = path.join(wroot, 'server', 'overlay-loader.mjs');
  const entry = path.join(wroot, 'server', 'android-main.mjs');
  if (!fs.existsSync(path.join(wroot, 'index.html')) || !fs.existsSync(entry)) return t.skip('webroot not built');
  if (!fs.existsSync(loader)) {
    // a stale tree from before v2.8.0 — check-apk is the real gate against the APK listing
    return t.skip('webroot predates the overlay loading point (rerun build-webroot)');
  }
  assert.ok(fs.readFileSync(entry, 'utf-8').includes('loadOverlays'), 'built android-main.mjs must call loadOverlays');
});
