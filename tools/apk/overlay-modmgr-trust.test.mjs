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

// 2026-10-29：站点侧开始签目录（Forge-Mods 的 build-mods-json.yml）。下面两份 fixture 是**真签**过的
// 文档（用对应私钥在本地签一次存下来，私钥不进仓库）——它们证明客户端确实按 keyId 找对公钥并验过，
// 而不是「有 sig 就放行」。
test('a genuinely signed catalogue verifies, and the signed bytes are really what is checked', () => {
  // 专用工坊密钥（sp-workshop-2026-10）：站点现在用它签
  const workshop = {
    generatedAt: 'fixture-2026-10-29',
    keyId: 'sp-workshop-2026-10',
    mods: [],
    sig: 'rfm4elU8HLv7AcGIXeJHsOAYwB7xawGztFH8S7sH40wmRN9Phiud7xkYCXJGHBtqfBG/v/6nqD6Hz9oEZgH8CA==',
  };
  assert.equal(mod.verifyCatalogue(workshop), 'signed', 'the site key must verify');

  // 改任何一个被签的字段都必须验不过（这里改 generatedAt；改 mods 同理）
  assert.equal(mod.verifyCatalogue({ ...workshop, generatedAt: 'fixture-2026-10-29 ' }), 'bad', 'tampering must be caught');
  // keyId 也在签名载荷里：换成另一把已知钥匙 ⇒ 用另一把公钥验 ⇒ 过不了
  assert.equal(mod.verifyCatalogue({ ...workshop, keyId: 'sp-2026-10' }), 'bad', 'swapping keyId must not launder a signature');

  // 热更新那把（不带 keyId 的历史写法）仍然认
  const legacy = { generatedAt: 'fixture-legacy-2026-10-29', mods: [], sig: 'l4zvSyIiaJJ1zWcY3oV23kxDPEmiJLhXSaKJ18RUFxMd3t/wPwN7P1KgwzY+hy1nmkSBUZeJ+RywAUwMwotEDw==' };
  assert.equal(mod.verifyCatalogue(legacy), 'signed', 'a document without keyId falls back to sp-2026-10');
});

test('an unknown keyId is rejected outright (never silently falls back to a pinned key)', () => {
  const doc = {
    generatedAt: 'fixture-2026-10-29',
    keyId: 'sp-attacker-2027',
    mods: [],
    sig: 'rfm4elU8HLv7AcGIXeJHsOAYwB7xawGztFH8S7sH40wmRN9Phiud7xkYCXJGHBtqfBG/v/6nqD6Hz9oEZgH8CA==',
  };
  assert.equal(mod.verifyCatalogue(doc), 'bad', 'an unrecognised signer must not be trusted');
});

test('the key registry holds exactly 32-byte raw keys', () => {
  assert.ok(mod.WORKSHOP_KEYS instanceof Map, 'WORKSHOP_KEYS must be the keyId → pubkey map');
  for (const id of ['sp-2026-10', 'sp-workshop-2026-10']) {
    assert.ok(mod.WORKSHOP_KEYS.has(id), 'missing keyId in the registry: ' + id);
    assert.match(mod.WORKSHOP_KEYS.get(id), /^[0-9a-f]{64}$/, 'pubkey must be 32 raw bytes as hex: ' + id);
  }
  assert.notEqual(mod.WORKSHOP_KEYS.get('sp-2026-10'), mod.WORKSHOP_KEYS.get('sp-workshop-2026-10'),
    'the workshop key must not be the hot-update key');
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

test('the catalogue signature is REQUIRED by default (fail-closed since 2026-10-29)', () => {
  // 站点已在签（Forge-Mods build-mods-json.yml → mods.json 的 sig/keyId）。若客户端还留着
  // 「默认放行未签名」的旧语义，攻击者只要让目录少一个 sig 就绕过整条签名链 —— 那这道锚等于没有。
  const src = fs.readFileSync(OVERLAY, 'utf8');
  assert.doesNotMatch(src, /process\.env\.SP_WORKSHOP_REQUIRE_SIG\)\s*\|\|\s*''\)\s*===\s*'1'/,
    'the old opt-in gate (default allow) must be gone');
  assert.match(src, /if \(v === '0' \|\| v === 'off' \|\| v === 'false'\) return false;\s*return true;/,
    'the default must be fail-closed, with an explicit SP_WORKSHOP_REQUIRE_SIG=0 opt-out');
});
