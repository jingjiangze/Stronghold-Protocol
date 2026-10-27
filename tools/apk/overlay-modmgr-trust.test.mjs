// overlay-modmgr-trust.test.mjs — the workshop trust anchors (2026-10-27 审计 P0).
//
// WHY: `/mods.json` is unsigned, its sha256 travels in the same document as the download URL, and
// an empty download allowlist lets ANY public https host through upstream install.js. Chained, a
// poisoned catalogue turns one normal "install" click into "fetch and execute an attacker's zip".
// The mitigation shipped in sp-modmgr.mjs has two anchors that must stay true:
//   ① the catalogue signature, when present, is actually verified (never blindly accepted);
//   ② workshop downloads only come from the trusted host set.
import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY = path.join(here, 'overlay', 'sp-modmgr.mjs');
const mod = await import(pathToFileURL(OVERLAY).href);

test('canonical form matches the signing tool (keys sorted, no whitespace, sig dropped by the verifier)', () => {
  assert.equal(mod.canonicalize({ b: 1, a: 'x' }), '{"a":"x","b":1}', 'keys are sorted recursively');
  assert.equal(mod.canonicalize({ z: { y: 2, x: [1, 'q'] } }), '{"z":{"x":[1,"q"],"y":2}}', 'nested + array order kept');
  assert.throws(() => mod.canonicalize({ n: 1.5 }), /non-integer/, 'floats are refused (same rule as tools/apk/canonical.mjs)');
});

test('an unsigned catalogue is reported as unsigned, not as signed', () => {
  assert.equal(mod.verifyCatalogue({ generatedAt: 'x', mods: [] }), 'unsigned');
  assert.equal(mod.verifyCatalogue(null), 'unsigned');
  assert.equal(mod.verifyCatalogue({ sig: '   ' }), 'unsigned', 'a blank sig counts as unsigned');
});

test('a present-but-invalid signature is REJECTED (verification really runs)', () => {
  const doc = { generatedAt: 'x', mods: [], sig: Buffer.alloc(64, 7).toString('base64') };
  assert.equal(mod.verifyCatalogue(doc), 'bad', 'garbage signature must not be accepted');
  assert.equal(mod.verifyCatalogue({ mods: [], sig: 'not-base64!!' }), 'bad', 'malformed signature is bad too');
});

test('workshop downloads only leave for the trusted hosts', () => {
  assert.doesNotThrow(() => mod.assertWorkshopHost(
    'https://raw.githubusercontent.com/jingjiangze/Stronghold-Protocol-Forge-Mods/master/mods/ai-scoring/0.3.1/mod.zip'));
  for (const bad of [
    'https://evil.example/mod.zip',
    'https://raw.githubusercontent.com.evil.example/mod.zip',
    'http://raw.githubusercontent.com/x.zip',
    'not a url',
    '',
  ]) {
    assert.throws(() => mod.assertWorkshopHost(bad), (e) => e.code === 'HOST' || e.code === 'URL', 'must refuse: ' + bad);
  }
});

test('the catalogue fetch budget survives slow networks (2026-10-27 真机实测 5–15 s)', () => {
  // 65 KB 的目录在移动/跨境线路上要 5–15 秒；8 秒预算会让「载入工坊目录」在手机上恒 TIMEOUT。
  const src = fs.readFileSync(OVERLAY, 'utf8');
  const m = /const WORKSHOP_TIMEOUT_MS = (\d+);/.exec(src);
  assert.ok(m, 'WORKSHOP_TIMEOUT_MS is gone');
  assert.ok(Number(m[1]) >= 15000, 'the workshop timeout must allow slow networks (got ' + m[1] + ' ms)');
  assert.match(src, /async function fetchWorkshopIndex/, 'the catalogue fetch must keep its retry wrapper');
});
