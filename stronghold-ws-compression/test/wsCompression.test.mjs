// test/wsCompression.test.mjs — the mode table, the undeclared options, and the negotiation safety.
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveWsCompression, describeWsCompression, createCompressFilter,
  WS_COMPRESSION_MODES, STRONGHOLD_COMPRESSIBLE_TYPES,
  compressibleTypes, compressibleTypesFrom, parseExtraCompressibleTypes, DEFAULT_EXTRA_COMPRESSIBLE_TYPES,
} from '../src/wsCompression.mjs';

test('the mode table: off by default, on is the shipped set, safe is the fallback, anything else refused', () => {
  assert.equal(resolveWsCompression(), false);
  assert.equal(resolveWsCompression('off'), false);
  assert.deepEqual(WS_COMPRESSION_MODES, ['off', 'on', 'safe']);

  const on = resolveWsCompression('on');
  assert.equal(on.threshold, 64);
  assert.equal(on.clientNoContextTakeover, true);
  assert.equal(on.concurrencyLimit, 8);
  assert.deepEqual(on.zlibDeflateOptions, { level: 6, memLevel: 5 });

  // The two options that are deliberately ABSENT. Leaving them out is both the better compression
  // (context takeover; zlib's 15-bit default window) and the safer negotiation — a literal
  // `false`/number makes ws REJECT an offer, and a rejected offer aborts the handshake with HTTP 400
  // rather than degrading. Asserted by name so a future edit cannot quietly re-pin them.
  assert.ok(!('serverNoContextTakeover' in on), 'context takeover must stay undeclared (negotiated), not pinned');
  assert.ok(!('serverMaxWindowBits' in on), 'the window must stay undeclared (zlib default 15), not pinned');
  assert.ok(Object.isFrozen(on), 'the option set is shared, so it must not be mutable');

  const safe = resolveWsCompression('safe');
  assert.equal(safe.serverNoContextTakeover, true, 'the fallback turns context takeover off');
  assert.ok(!('serverMaxWindowBits' in safe), 'the fallback must not pin a window either — that is what 400s an offer');
  assert.equal(safe.threshold, 64, 'the threshold fix is not part of the fallback');

  for (const bad of ['ON', 'true', '1', 'yes', '', 'OFF', undefined]) {
    if (bad === undefined) continue; // undefined takes the documented `off` default
    assert.throws(() => resolveWsCompression(bad), /must be one of/, bad);
  }
  assert.equal(resolveWsCompression(undefined), false, 'an unset mode is off, not an error');
});

test('the whitelist: listed types compress, everything else does not', () => {
  const compressible = createCompressFilter();
  for (const t of STRONGHOLD_COMPRESSIBLE_TYPES) assert.equal(compressible(t), true, t);
  // credentials, handshake, control and request/response traffic stay uncompressed
  for (const t of ['hello', 'welcome', 'ok', 'error', 'ping', 'pong', 'room.state', 'm.ticker', undefined, null]) {
    assert.equal(compressible(t), false, String(t));
  }
  // a custom set is the whole point of the factory
  const only = createCompressFilter(['b.start']);
  assert.equal(only('b.start'), true);
  assert.equal(only('m.public'), false);
});

test('describeWsCompression reports what reaches the wire, including the undeclared options', () => {
  const off = describeWsCompression('off');
  assert.equal(off.enabled, false);
  assert.match(off.summary, /off/);

  const on = describeWsCompression('on');
  assert.equal(on.enabled, true);
  assert.equal(on.contextTakeover, 'on (negotiated)', 'an operator must not have to read the source to learn this');
  assert.match(on.windowBits, /15/, 'the effective window is zlib default, not a pinned number');
  assert.match(on.summary, /threshold 64/);

  const safe = describeWsCompression('safe');
  assert.equal(safe.contextTakeover, 'off (declared)');
});

test('an unset mode is off — the default never silently turns compression on', () => {
  const prev = process.env.WS_COMPRESSION;
  assert.equal(describeWsCompression(process.env.WS_COMPRESSION ?? 'off').enabled,
    process.env.WS_COMPRESSION === 'on' || process.env.WS_COMPRESSION === 'safe');
  if (prev === undefined) delete process.env.WS_COMPRESSION;
});

test('the extra-type switch: unset takes the default, `none` is the one-word rollback', () => {
  assert.deepEqual([...DEFAULT_EXTRA_COMPRESSIBLE_TYPES], ['b.start']);
  assert.deepEqual(parseExtraCompressibleTypes(undefined), DEFAULT_EXTRA_COMPRESSIBLE_TYPES);
  // `none` rather than an empty string on purpose: in a Windows .cmd a bare `set X=` UNSETS the variable,
  // so "empty" cannot be expressed there and would silently mean "take the default".
  assert.deepEqual(parseExtraCompressibleTypes('none'), []);
  assert.deepEqual(parseExtraCompressibleTypes('NONE'), []);
  assert.deepEqual(parseExtraCompressibleTypes(''), []);
  assert.deepEqual([...parseExtraCompressibleTypes('b.start, m.ticker ,b.start')], ['b.start', 'm.ticker']);
});

test('the base set never moves with the switch — a rollback takes back the extras, not everything', () => {
  assert.deepEqual([...STRONGHOLD_COMPRESSIBLE_TYPES], ['b.snap', 'b.ev', 'm.field', 'm.public', 'm.private', 'm.result']);
  const withExtras = compressibleTypesFrom({ WS_COMPRESS_EXTRA: undefined });
  const rolledBack = compressibleTypesFrom({ WS_COMPRESS_EXTRA: 'none' });
  assert.ok(withExtras.includes('b.start'));
  assert.ok(!rolledBack.includes('b.start'), 'the rollback must drop b.start');
  for (const t of STRONGHOLD_COMPRESSIBLE_TYPES) assert.ok(rolledBack.includes(t), `${t} must survive the rollback`);
  assert.equal(rolledBack.length, STRONGHOLD_COMPRESSIBLE_TYPES.length);
});

test('b.start is compressed by default and is NOT droppable', () => {
  assert.equal(createCompressFilter()('b.start'), true);
  assert.ok(compressibleTypes().includes('b.start'));
  // The one droppable type must stay the one whose loss the protocol already tolerates: a dropped frame
  // never enters the deflate context, so a droppable frame that WAS compressed would desync the rest.
  assert.equal(createCompressFilter()('b.start'), true);
});
