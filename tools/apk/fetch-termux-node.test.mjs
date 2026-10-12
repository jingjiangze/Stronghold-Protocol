// fetch-termux-node unit tests: the supply-chain pin and the archive integrity chain (file:line targets
// are the pure helpers in tools/apk/fetch-termux-node.mjs). No network, no side effects on jniLibs.
//
//   node --test tools/apk/fetch-termux-node.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARCHIVE_PIN,
  archiveSource,
  debMemberPath,
  stagedLibNames,
  findManifestRoot,
  verifyManifest,
} from './fetch-termux-node.mjs';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function tmpTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-fetch-runtime-'));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('ARCHIVE_PIN: locks the audited Fuhua r1 bytes (sha256 is the trust anchor, not the URL)', () => {
  assert.match(ARCHIVE_PIN.url, /^https:\/\/github\.com\/Fuhua-code\/Stronghold-Protocol\/releases\/download\/android-runtime-node24\.18\.0-r1\/stronghold-runtime-node24\.18\.0-r1\.tar\.gz$/);
  assert.equal(ARCHIVE_PIN.sha256, '5bab822a770b2609394bd107412b539a3c013c7f0ad8e320e8f5ce77ae7bab76');
  assert.match(ARCHIVE_PIN.sha256, /^[0-9a-f]{64}$/);
});

test('archiveSource: defaults to the pin, supports one-line override, off switch only for exact "off"', () => {
  assert.deepEqual(archiveSource({}), { url: ARCHIVE_PIN.url, sha256: ARCHIVE_PIN.sha256 });
  // empty strings must behave like "unset" so an empty workflow input cannot blank the pin
  assert.deepEqual(archiveSource({ SP_TERMUX_RUNTIME_ARCHIVE_URL: '', SP_TERMUX_RUNTIME_ARCHIVE_SHA256: '' }),
    { url: ARCHIVE_PIN.url, sha256: ARCHIVE_PIN.sha256 });
  for (const v of ['off', 'OFF', ' off ']) {
    assert.equal(archiveSource({ SP_TERMUX_RUNTIME_ARCHIVE: v }), null, `SP_TERMUX_RUNTIME_ARCHIVE=${v}`);
  }
  for (const v of ['', 'on', '0', 'false']) {
    assert.notEqual(archiveSource({ SP_TERMUX_RUNTIME_ARCHIVE: v }), null, `SP_TERMUX_RUNTIME_ARCHIVE=${v}`);
  }
  const custom = archiveSource({
    SP_TERMUX_RUNTIME_ARCHIVE_URL: 'https://example.invalid/runtime.tar.gz',
    SP_TERMUX_RUNTIME_ARCHIVE_SHA256: 'A'.repeat(64),
  });
  assert.deepEqual(custom, { url: 'https://example.invalid/runtime.tar.gz', sha256: 'a'.repeat(64) });
  assert.throws(() => archiveSource({ SP_TERMUX_RUNTIME_ARCHIVE_SHA256: 'nope' }), /64 hex chars/);
  assert.throws(() => archiveSource({ SP_TERMUX_RUNTIME_ARCHIVE_SHA256: 'a'.repeat(63) }), /64 hex chars/);
});

test('debMemberPath: archive layout contract termux/<arch>/<pkg>.deb for all 7 packages, both ABIs', () => {
  for (const arch of ['aarch64', 'x86_64']) {
    for (const pkg of ['nodejs-lts', 'libc++', 'openssl', 'libicu', 'c-ares', 'libsqlite', 'zlib']) {
      assert.equal(debMemberPath(pkg, arch), `termux/${arch}/${pkg}.deb`);
    }
  }
});

test('stagedLibNames: the staged jniLibs set is exactly the 10 .so check-apk.mjs requires', () => {
  // Keep in lockstep with tools/apk/check-apk.mjs RUNTIME and android/app/src/main/jniLibs/<abi>/.
  assert.deepEqual(stagedLibNames(), [
    'libc++_shared.so', 'libcares.so', 'libcrypto.so', 'libicudata.so', 'libicui18n.so',
    'libicuuc.so', 'libnode.so', 'libsqlite3.so', 'libssl.so', 'libz.so',
  ]);
});

test('findManifestRoot: finds input-manifest.json at the root or one level down', () => {
  const t = tmpTree();
  try {
    assert.equal(findManifestRoot(t.dir), null);
    fs.writeFileSync(path.join(t.dir, 'input-manifest.json'), '{}');
    assert.equal(findManifestRoot(t.dir), t.dir);
    fs.rmSync(path.join(t.dir, 'input-manifest.json'));
    fs.mkdirSync(path.join(t.dir, 'stronghold-runtime-node24.18.0-r1'));
    fs.writeFileSync(path.join(t.dir, 'stronghold-runtime-node24.18.0-r1', 'input-manifest.json'), '{}');
    assert.equal(findManifestRoot(t.dir), path.join(t.dir, 'stronghold-runtime-node24.18.0-r1'));
  } finally {
    t.done();
  }
});

test('verifyManifest: verifies path+size+sha256 for every entry and returns checked/bytes', () => {
  const t = tmpTree();
  try {
    const a = Buffer.from('hello runtime\n');
    const b = crypto.randomBytes(1500);
    fs.mkdirSync(path.join(t.dir, 'termux', 'aarch64'), { recursive: true });
    fs.mkdirSync(path.join(t.dir, 'licenses', 'zlib'), { recursive: true });
    fs.writeFileSync(path.join(t.dir, 'input-manifest.json'), 'x');
    fs.writeFileSync(path.join(t.dir, 'termux', 'aarch64', 'zlib.deb'), a);
    fs.writeFileSync(path.join(t.dir, 'licenses', 'zlib', 'copyright'), b);
    const manifest = {
      schema: 1,
      kind: 'runtime',
      version: 'node24.18.0-r1',
      files: [
        { path: 'termux/aarch64/zlib.deb', bytes: a.length, sha256: sha256(a) },
        { path: 'licenses/zlib/copyright', bytes: b.length, sha256: sha256(b) },
      ],
      totalBytes: a.length + b.length,
    };
    assert.deepEqual(verifyManifest(t.dir, manifest), { checked: 2, bytes: a.length + b.length });
  } finally {
    t.done();
  }
});

test('verifyManifest: ANY mismatch throws a hard failure naming the file (never silently use bad bytes)', () => {
  const t = tmpTree();
  try {
    const body = Buffer.from('pinned bytes\n');
    const file = path.join(t.dir, 'termux', 'aarch64', 'libsqlite.deb');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    const entry = { path: 'termux/aarch64/libsqlite.deb', bytes: body.length, sha256: sha256(body) };
    const manifest = { schema: 1, files: [entry], totalBytes: body.length };
    assert.deepEqual(verifyManifest(t.dir, manifest), { checked: 1, bytes: body.length });

    // tampered content (same length, different bytes) -> sha256 mismatch
    fs.writeFileSync(file, Buffer.from('PINNED bytes\n'));
    assert.throws(() => verifyManifest(t.dir, manifest),
      (e) => e.fatal === true && /libsqlite\.deb sha256/.test(e.message));
    fs.writeFileSync(file, body);

    // truncated member -> byte size mismatch
    assert.throws(() => verifyManifest(t.dir, { schema: 1, files: [{ ...entry, bytes: body.length + 1 }] }),
      /is \d+ bytes, manifest pins/);

    // missing member
    assert.throws(() => verifyManifest(t.dir, { schema: 1, files: [{ ...entry, path: 'termux/aarch64/absent.deb' }] }),
      /missing termux\/aarch64\/absent\.deb/);

    // path traversal / absolute / backslash paths are rejected before touching the filesystem
    for (const bad of ['../evil', 'a/../b', '/etc/passwd', 'C:/x', 'a\\b']) {
      assert.throws(() => verifyManifest(t.dir, { schema: 1, files: [{ ...entry, path: bad }] }),
        /unsafe path/, `path ${bad}`);
    }

    // malformed entry / wrong schema / wrong total
    assert.throws(() => verifyManifest(t.dir, { schema: 1, files: [{ ...entry, sha256: 'xyz' }] }), /malformed entry/);
    assert.throws(() => verifyManifest(t.dir, { schema: 2, files: [entry] }), /unsupported shape/);
    assert.throws(() => verifyManifest(t.dir, { schema: 1, files: [] }), /unsupported shape/);
    assert.throws(() => verifyManifest(t.dir, { schema: 1, files: [entry], totalBytes: 1 }), /totalBytes/);
  } finally {
    t.done();
  }
});
