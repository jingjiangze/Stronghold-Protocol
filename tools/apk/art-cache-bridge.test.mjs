// shell-bridge.js: the art-cache-status capability layer (2026-10-08 preload status fix).
//
//   node --test tools/apk/art-cache-bridge.test.mjs
//
// Contract under test:
//   · a NEW APK (ShellBridge.artCacheStatus / clearArtCache present) -> shell-bridge sets
//     __SP_SHELL.artCacheBridge = true and forwards both calls, returning the raw JSON string;
//   · an OLD APK / the plain web (no such native methods) -> artCacheBridge is falsy and no
//     artCacheStatus method is invented, so preload-center falls back to CacheStorage;
//   · the wrappers never throw (a bridge exception is folded to '').
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-bridge.js'), 'utf8');

/** Run the shipped shell-bridge.js in a vm with a stub window.shell. */
function mkWorld(shell) {
  const win = {};
  if (shell) win.shell = shell;
  const sandbox = { window: win, console, Promise, setTimeout, clearTimeout, URL, URLSearchParams };
  return { win, run: () => vm.runInNewContext(SRC, sandbox, { filename: 'shell-bridge.js' }) };
}

const STATUS = JSON.stringify({ ok: true, manifestHash: 'h1', cachedFiles: 12, cachedBytes: 4096, cacheRoot: 'art/cache/h1', pending: -1 });
const CLEAR = JSON.stringify({ ok: true, removedFiles: 12, removedBytes: 4096, keptPacks: true });

test('new APK: exposes the capability flag and forwards both bridge calls verbatim', () => {
  const calls = [];
  const w = mkWorld({
    pickServer() {},
    artCacheStatus() { calls.push('status'); return STATUS; },
    clearArtCache() { calls.push('clear'); return CLEAR; },
  });
  w.run();
  assert.equal(w.win.__SP_SHELL.artCacheBridge, true, 'the capability flag is set');
  assert.equal(typeof w.win.__SP_SHELL.artCacheStatus, 'function');
  assert.equal(typeof w.win.__SP_SHELL.clearArtCache, 'function');
  assert.equal(w.win.__SP_SHELL.artCacheStatus(), STATUS, 'the raw JSON string is returned');
  assert.equal(w.win.__SP_SHELL.clearArtCache(), CLEAR);
  assert.deepEqual(calls, ['status', 'clear']);
  // window.shell itself is wrapped too (the wrapNative pattern the file already uses)
  assert.equal(w.win.shell.artCacheStatus(), STATUS);
  assert.equal(w.win.shell.clearArtCache(), CLEAR);
});

test('old APK (no native methods): the flag stays false and nothing is invented', () => {
  const w = mkWorld({ pickServer() {} });
  w.run();
  assert.ok(!w.win.__SP_SHELL.artCacheBridge, 'no capability without the native method');
  assert.equal(w.win.__SP_SHELL.artCacheStatus, undefined, 'no artCacheStatus method is faked');
  assert.equal(w.win.__SP_SHELL.clearArtCache, undefined, 'no clearArtCache method is faked');
  assert.equal(typeof w.win.shell.artCacheStatus, 'undefined');
});

test('plain web (no window.shell): degrades silently, flag false', () => {
  const w = mkWorld(null);
  w.run();
  assert.equal(w.win.__SP_SHELL.isApp, false);
  assert.ok(!w.win.__SP_SHELL.artCacheBridge);
  assert.equal(w.win.__SP_SHELL.artCacheStatus, undefined);
});

test('a throwing bridge is folded to an empty string, never propagated', () => {
  const w = mkWorld({
    pickServer() {},
    artCacheStatus() { throw new Error('boom'); },
    clearArtCache() { throw new Error('boom'); },
  });
  w.run();
  assert.equal(w.win.__SP_SHELL.artCacheBridge, true);
  assert.equal(w.win.__SP_SHELL.artCacheStatus(), '');
  assert.equal(w.win.__SP_SHELL.clearArtCache(), '');
});

test('source invariants: the wrapNative/__SP_SHELL pattern is used for the new bridge', () => {
  assert.match(SRC, /wrapNative\('artCacheStatus'/);
  assert.match(SRC, /wrapNative\('clearArtCache'/);
  assert.match(SRC, /__SP_SHELL\.artCacheBridge = typeof NATIVE\.artCacheStatus === 'function'/);
  assert.match(SRC, /__SP_SHELL\.artCacheStatus = function/);
  assert.match(SRC, /__SP_SHELL\.clearArtCache = function/);
});
