import test from 'node:test';
import assert from 'node:assert/strict';

import { failoverChainFor, demoteHost, hostOfUrl } from './overlay/sp-assets.mjs';

const ROOTS = ['https://mirror-a.test', 'https://mirror-b.test'];

// The order the field demands: 同一路径 → 下一个已排序的源（最多一次）→ 原站.
// Never local bytes: a timeout means "this source is bad right now", not "these bytes do not exist".
test('the chain is: as asked → next ranked source → origin, same path throughout', () => {
  const url = 'https://mirror-a.test/assets/spine/op/x/x.skel?v=1';
  const chain = failoverChainFor(url, { roots: ROOTS, origin: 'https://origin.test' }, new Set());
  assert.deepEqual(chain, [
    'https://mirror-a.test/assets/spine/op/x/x.skel?v=1',
    'https://mirror-b.test/assets/spine/op/x/x.skel?v=1',
    'https://origin.test/assets/spine/op/x/x.skel?v=1',
  ]);
  // The query survives: a versioned asset must keep its token or the fallback fetches a different object.
  assert.ok(chain.every((c) => c.endsWith('?v=1')));
});

test('the CURRENT source is not repeated, and one switch is the maximum', () => {
  const url = 'https://mirror-b.test/assets/a.png';
  const chain = failoverChainFor(url, { roots: ROOTS, origin: 'https://origin.test' }, new Set());
  assert.deepEqual(chain, ['https://mirror-b.test/assets/a.png', 'https://mirror-a.test/assets/a.png', 'https://origin.test/assets/a.png']);
  assert.equal(chain.length, 3, 'at most one switch then the origin');
});

test('a demoted source is skipped as a fallback but still tried when asked for directly', () => {
  const demoted = new Set(['mirror-b.test']);
  const chain = failoverChainFor('https://mirror-a.test/assets/a.png', { roots: ROOTS, origin: 'https://origin.test' }, demoted);
  assert.ok(!chain.some((c) => c.includes('mirror-b.test')), 'a source that timed out must not be a fallback');
  assert.equal(chain[0], 'https://mirror-a.test/assets/a.png', 'the URL as asked is always first');
  // ...and if the page asks for the demoted host itself, it is still attempted once.
  const direct = failoverChainFor('https://mirror-b.test/assets/a.png', { roots: ROOTS, origin: 'https://origin.test' }, demoted);
  assert.equal(direct[0], 'https://mirror-b.test/assets/a.png');
});

test('no origin and no roots degrade to the single URL rather than throwing', () => {
  assert.deepEqual(failoverChainFor('https://a.test/x.png', {}, new Set()), ['https://a.test/x.png']);
  assert.deepEqual(failoverChainFor('not a url', { roots: ROOTS, origin: 'https://origin.test' }, new Set()), ['not a url']);
});

test('demoteHost records a host once and counts it', () => {
  const stats = {};
  const demoted = new Set();
  demoteHost('https://mirror-b.test/assets/a.png', demoted, stats);
  demoteHost('https://mirror-b.test/assets/b.png', demoted, stats);
  assert.deepEqual([...demoted], ['mirror-b.test'], 'keyed by host, so every path of that source is covered');
  assert.equal(stats.demoted, 1, 'counted once, not once per request');
  assert.equal(hostOfUrl('nonsense'), '');
  assert.equal(demoteHost('nonsense', demoted, stats), demoted, 'an unparseable URL is ignored, never fatal');
});
