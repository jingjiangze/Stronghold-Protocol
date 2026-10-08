// test/boot-priority.test.js — SP_PRIORITY (server/http/boot.js applyPriority): an optional scheduling boost for a
// host that runs the game next to other services. Unset is the default and does nothing; a bad value is refused with a
// warning rather than crashing the boot; a value the OS refuses (negative nice without privileges) is logged and
// ignored, because a server that may not be raised must still start.
// Run: node --test test/boot-priority.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { applyPriority } from '../server/http/boot.js';

const collector = () => {
  const lines = { info: [], warn: [] };
  return { lines, log: { info: (...a) => lines.info.push(a.join(' ')), warn: (...a) => lines.warn.push(a.join(' ')) } };
};

test('unset or blank: nothing happens, not even a log line', () => {
  for (const env of [{}, { SP_PRIORITY: '' }]) {
    const { lines, log } = collector();
    assert.equal(applyPriority(log, env), null);
    assert.deepEqual(lines, { info: [], warn: [] });
  }
});

test('a value outside -20..19, or not an integer, is refused with a warning (the boot continues)', () => {
  for (const bad of ['-21', '20', 'high', '1.5', 'NaN']) {
    const { lines, log } = collector();
    assert.equal(applyPriority(log, { SP_PRIORITY: bad }), null, bad);
    assert.equal(lines.warn.length, 1, `${bad} warns`);
    assert.match(lines.warn[0], /SP_PRIORITY must be an integer -20\.\.19/);
  }
});

test('a valid value is applied to this process and reported, and the original priority is restored', () => {
  const original = os.getPriority(process.pid);
  const { lines, log } = collector();
  try {
    const applied = applyPriority(log, { SP_PRIORITY: '0' });
    // 0 is always allowed (no privileges needed), so this branch runs everywhere
    assert.equal(applied, os.getPriority(process.pid));
    assert.equal(applied, 0);
    assert.equal(lines.warn.length, 0, 'no warning for a value the OS accepts');
    assert.equal(lines.info.length, 1);
    assert.match(lines.info[0], /process priority \d+ → 0 \(SP_PRIORITY=0\)/);
  } finally {
    os.setPriority(process.pid, original);
  }
});

test('a value the OS refuses is logged and ignored rather than thrown', () => {
  const original = os.getPriority(process.pid);
  const { lines, log } = collector();
  try {
    // -20 needs privileges on Linux/macOS; on Windows the negative range maps to a priority class and is allowed
    const applied = applyPriority(log, { SP_PRIORITY: '-20' });
    if (applied === null) {
      assert.equal(lines.warn.length, 1, 'refused: warned');
      assert.match(lines.warn[0], /could not set process priority to -20/);
    } else {
      assert.equal(applied, os.getPriority(process.pid), 'applied: reported');
      assert.equal(lines.warn.length, 0);
    }
  } finally {
    os.setPriority(process.pid, original);
  }
});
