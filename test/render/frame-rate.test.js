// render/frameRate.js — the display's frame interval, the render loop's cap, and the frame-spacing histogram.
//
// The cap is the interesting one: it is expressed as "one frame every k refreshes", because a plain numeric cap
// makes the spacing of the frames Pixi draws uneven whenever the display's refresh is not a multiple of it (the
// numbers behind that are in the module header and in docs; the assertions here pin the rule, not the table).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  refreshFromDeltas, effectiveMaxFps, frameHistogram, histogramText, MAX_FPS_CEILING,
} from '../../public/js/render/frameRate.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
/** The display interval of a refresh rate, as the browser would measure it. */
const intervalOf = (hz) => 1000 / hz;

describe('refreshFromDeltas', () => {
  test('is the floor of the deltas, not the mean: a loaded thread can only make a delta longer', () => {
    // a 60 Hz display whose frames are occasionally late by a whole interval
    assert.ok(near(refreshFromDeltas([16.6, 16.7, 16.6, 33.3, 16.7]), 16.6, 0.05));
    // a 144 Hz display, mostly on time
    assert.ok(near(refreshFromDeltas([6.94, 6.95, 6.94, 13.89, 6.94]), 6.94, 0.05));
  });

  test('p10, not the minimum, so one spuriously short delta cannot halve the answer', () => {
    const deltas = [...Array(20).fill(16.667), 0.5];
    assert.ok(near(refreshFromDeltas(deltas), 16.667, 0.05), 'a single 0.5 ms double-callback is ignored');
  });

  test('junk is dropped, and an empty or all-junk run has no answer', () => {
    assert.equal(refreshFromDeltas([]), null);
    assert.equal(refreshFromDeltas(null), null);
    assert.equal(refreshFromDeltas([0, NaN, -3, 5000]), null);
    assert.ok(near(refreshFromDeltas([0, NaN, 16.6, 16.7, 16.6, 16.6]), 16.6, 0.05));
  });
});

describe('effectiveMaxFps: the cap is a whole division of the refresh', () => {
  test('never exceeds the ceiling', () => {
    for (const hz of [30, 60, 75, 90, 120, 144, 165, 240, 360]) {
      const fps = effectiveMaxFps(intervalOf(hz));
      assert.ok(fps <= MAX_FPS_CEILING + 1e-9, `${hz} Hz → ${fps} must stay under ${MAX_FPS_CEILING}`);
    }
  });

  test('the rendered interval is always a whole number of display intervals (even spacing)', () => {
    for (const hz of [60, 75, 90, 120, 144, 165, 240]) {
      const refreshMs = intervalOf(hz);
      const interval = 1000 / effectiveMaxFps(refreshMs);
      const k = interval / refreshMs;
      assert.ok(Math.abs(k - Math.round(k)) < 1e-6, `${hz} Hz: interval ${interval} ms is ${k} refreshes, not a whole number`);
    }
  });

  test('a refresh at or under the ceiling is used whole; above it, the cap steps to every 2nd refresh', () => {
    assert.ok(near(effectiveMaxFps(intervalOf(60)), 60));
    assert.ok(near(effectiveMaxFps(intervalOf(90)), 90));
    assert.ok(near(effectiveMaxFps(intervalOf(120)), 120));
    // 144 and 165 are the cases a plain 120 cap gets wrong: 1000/120 is 1.73 and 1.98 refreshes — not whole
    assert.ok(near(effectiveMaxFps(intervalOf(144)), 72), '144 Hz → 72 (every 2nd refresh), not a juddering 120');
    assert.ok(near(effectiveMaxFps(intervalOf(165)), 82.5), '165 Hz → 82.5 (every 2nd refresh)');
    assert.ok(near(effectiveMaxFps(intervalOf(240)), 120), '240 Hz → 120 (every 2nd refresh)');
  });

  test('without a measurement the ceiling is used — still even on any display that divides it', () => {
    assert.equal(effectiveMaxFps(null), MAX_FPS_CEILING);
    assert.equal(effectiveMaxFps(undefined), MAX_FPS_CEILING);
    assert.equal(effectiveMaxFps(0), MAX_FPS_CEILING);
    assert.equal(effectiveMaxFps(NaN), MAX_FPS_CEILING);
  });
});

describe('frameHistogram: judder vs a low frame rate', () => {
  const at = (hz) => intervalOf(hz);

  test('an uncapped 144 Hz loop renders every refresh — one bucket', () => {
    const deltas = Array(100).fill(at(144));
    const h = frameHistogram(deltas, at(144));
    assert.deepEqual(h.buckets, [{ refreshes: 1, count: 100, pct: 100 }]);
    assert.equal(h.modal, 1);
    assert.equal(h.even, true);
  });

  test('a 60 fps cap on a 144 Hz panel is the 3:2 beat — two buckets, flagged uneven', () => {
    // 13.889 ms (2 refreshes) and 20.833 ms (3 refreshes), which is what Pixi's maxFPS=60 produces there
    const deltas = [...Array(57).fill(13.889), ...Array(43).fill(20.833)];
    const h = frameHistogram(deltas, at(144));
    assert.deepEqual(h.buckets.map((b) => b.refreshes), [2, 3]);
    assert.equal(h.modalPct, 57);
    assert.equal(h.even, false);
    assert.equal(histogramText(h), '2×57% / 3×43%', 'the text is bare buckets; the caller labels even/uneven');
  });

  test('a steady 60 on a 60 Hz panel reads as one bucket even though the rate is lower', () => {
    const h = frameHistogram(Array(100).fill(at(60)), at(60));
    assert.deepEqual(h.buckets, [{ refreshes: 1, count: 100, pct: 100 }]);
    assert.equal(h.even, true);
  });

  test('the 1% stretched frame a plain 60 cap leaves on a 60 Hz panel is visible as a second bucket', () => {
    const deltas = [...Array(99).fill(at(60)), at(60) * 2];
    const h = frameHistogram(deltas, at(60));
    assert.deepEqual(h.buckets, [{ refreshes: 1, count: 99, pct: 99 }, { refreshes: 2, count: 1, pct: 1 }]);
    assert.equal(h.modalPct, 99);
  });

  test('without a display interval there is nothing to compare against', () => {
    assert.deepEqual(frameHistogram([16, 16, 16], null).buckets, []);
    assert.equal(frameHistogram([16, 16, 16], null).even, null);
    assert.deepEqual(frameHistogram([], at(60)).buckets, []);
    assert.equal(histogramText(null), 'n/a');
  });
});
