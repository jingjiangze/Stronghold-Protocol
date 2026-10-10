// test/session-directory.test.js — the ownership directory + routing credential (server/sessionDirectory.js).
// What matters: a token is only ever addressed by its hash, a credential is signed/expiring/generation-bound and
// cannot name a port, and the ROUTING lease is kept apart from the session's RECOVERY window so a reaper cannot
// treat "no sockets" as "nothing owed".
// Run: node --test test/session-directory.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionDirectory, tokenHash, verifyCredential, newInstanceId } from '../server/sessionDirectory.js';

const SECRET = 'test-route-secret';
const mk = (over = {}) => {
  let t = 1_000_000;
  const dir = new SessionDirectory({
    instanceId: 'inst-A', slot: 'A', secret: SECRET, now: () => t, leaseMs: 60_000, ...over,
  });
  return { dir, advance: (ms) => { t += ms; }, at: () => t };
};

test('a token is addressed by its hash, never stored raw', () => {
  const { dir } = mk();
  const token = 'super-secret-reconnect-token';
  const h = tokenHash(token);
  assert.equal(h.length, 32);
  assert.equal(tokenHash(token), h, 'stable');
  assert.notEqual(h, token);
  assert.ok(!h.includes(token));
  const { sid } = dir.register(token, { roomCode: 'ABCD' });
  assert.equal(sid, h);
  assert.equal(dir.resolve(token).entry.roomCode, 'ABCD');
});

test('register/resolve: the owner sees itself, alive within the lease', () => {
  const { dir, advance } = mk();
  dir.register('t1');
  let r = dir.resolve('t1');
  assert.equal(r.found, true);
  assert.equal(r.mine, true);
  assert.equal(r.alive, true);
  advance(30_000);
  assert.equal(dir.resolve('t1').alive, true, 'still inside the lease');
  advance(40_000);
  assert.equal(dir.resolve('t1').alive, false, 'lease lapsed (owner may be gone)');
});

test('the lease and the recovery window are separate: a lapsed lease is not a forgotten session', () => {
  const { dir, advance } = mk();
  dir.register('t2', { recoverUntil: 1_000_000 + 24 * 60 * 60 * 1000 }); // a 24 h solo session
  advance(10 * 60_000);
  const r = dir.resolve('t2', { sweep: false });
  assert.equal(r.alive, false, 'no fresh lease');
  assert.equal(dir.obligations().recoverable, 1, 'but the slot still owes this player');
  assert.ok(dir.busySlots().get('A') === 1);
  // only when BOTH are over does it count as gone
  advance(24 * 60 * 60 * 1000);
  assert.equal(dir.sweep(), 1);
  assert.equal(dir.obligations().total, 0);
});

test('a credential is signed: a tampered payload is refused', () => {
  const { dir } = mk();
  const { credential } = dir.register('t3');
  assert.equal(verifyCredential(credential, SECRET, dir.now()).ok, true);
  const sig = credential.split('.')[2];
  const forged = `v1.${Buffer.from(JSON.stringify({ s: 'x', i: 'inst-B', k: 'B', g: 1, e: 9e15 })).toString('base64url')}.${sig}`;
  assert.equal(verifyCredential(forged, SECRET).reason, 'bad-signature');
  assert.equal(verifyCredential(credential, 'another-secret').reason, 'bad-signature');
  assert.equal(verifyCredential(credential.split('.').slice(0, 2).join('.'), SECRET).reason, 'malformed');
});

test('a credential carries no port and no token', () => {
  const { dir } = mk();
  const token = 'token-abc';
  const { credential } = dir.register(token);
  const payload = JSON.parse(Buffer.from(credential.split('.')[1], 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(payload).sort(), ['e', 'g', 'i', 'k', 's']);
  assert.ok(!/:\d{2,5}\b/.test(credential), 'no host:port in the credential');
  assert.ok(!credential.includes(token));
});

test('expiry and generation: a stale credential is reported as such, not silently accepted', () => {
  const { dir, advance } = mk({ credentialMs: 5_000 });
  const { credential } = dir.register('t4');
  advance(6_000);
  assert.equal(verifyCredential(credential, SECRET, dir.now()).reason, 'expired');
  const fresh = mk({ credentialMs: 60_000 });
  const reg = fresh.dir.register('t4');
  fresh.dir.release('t4'); // bump generation
  const v = fresh.dir.resolveCredential(reg.credential);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'unknown-session', 'released sessions are gone, not resurrected by a credential');
});

test('a credential whose session moved on is stale, not a new session', () => {
  const { dir } = mk();
  dir.register('t5');
  const cred = dir.credentialFor({ sid: tokenHash('t5'), instanceId: 'inst-A', slot: 'A', generation: 0, leaseUntil: 0, recoverUntil: 0 });
  // A credential issued with generation 0 is a "look it up" hint and stays valid…
  assert.equal(dir.resolveCredential(cred).ok, true);
  const cred2 = dir.credentialFor({ sid: tokenHash('t5'), instanceId: 'inst-A', slot: 'A', generation: dir.generation + 5, leaseUntil: 0, recoverUntil: 0 });
  // …while one naming a generation the directory no longer has is stale.
  assert.equal(dir.resolveCredential(cred2).reason, 'stale-generation');
});

test('release drops ownership and bumps the generation (so old credentials cannot return)', () => {
  const { dir } = mk();
  dir.register('t6');
  const g0 = dir.generation;
  assert.equal(dir.release('t6'), true);
  assert.equal(dir.generation, g0 + 1);
  assert.equal(dir.resolve('t6').found, false);
  assert.equal(dir.release('t6'), false, 'idempotent');
});

test('renew only ever refreshes the owning process', () => {
  const { dir } = mk();
  const other = new SessionDirectory({ instanceId: 'inst-B', slot: 'B', secret: SECRET, now: dir.now });
  other.register('t7');
  assert.equal(dir.renew('t7'), false, 'not ours to renew');
  assert.equal(other.renew('t7'), true);
});

test('two slots sharing one file see each other (the whole point)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'spdir-')), 'sessions.json');
  let t = 1_000_000;
  const now = () => t;
  const a = new SessionDirectory({ instanceId: 'inst-A', slot: 'A', secret: SECRET, file, now });
  const b = new SessionDirectory({ instanceId: 'inst-B', slot: 'B', secret: SECRET, file, now });
  const { credential } = a.register('t8', { roomCode: 'ROOM' });
  // B (the new active slot) can route it back to A without knowing the token.
  const v = b.resolveCredential(credential);
  assert.equal(v.ok, true);
  assert.equal(v.entry.instanceId, 'inst-A');
  assert.equal(v.entry.slot, 'A');
  assert.equal(v.mine, false);
  // and the directory on disk holds no raw token
  const raw = readFileSync(file, 'utf8');
  assert.ok(existsSync(file));
  assert.ok(!raw.includes('t8'), 'the raw token is not on disk');
  assert.ok(raw.includes(tokenHash('t8')), 'only its hash');
  t += 1000;
});

test('an unreadable directory fails towards "unknown", never towards "all mine"', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'spdir-')), 'broken.json');
  writeFileSync(file, '{not json');
  const dir = new SessionDirectory({ instanceId: 'inst-A', slot: 'A', secret: SECRET, file });
  assert.equal(dir.entries.size, 0);
  assert.equal(dir.resolve('anything').found, false);
});

test('newInstanceId is unique and prefixed', () => {
  const a = newInstanceId(), b = newInstanceId();
  assert.notEqual(a, b);
  assert.match(a, /^sp-[0-9a-f]{12}$/);
});
