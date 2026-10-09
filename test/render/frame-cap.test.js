// test/render/frame-cap.test.js — the render loop's frame-rate policy.
//
// The cap used to be the plain constant 60, and this file pinned it. It is now a *ceiling* on "one frame every k
// refreshes" (render/frameRate.js has the measurements: a plain cap makes the spacing of the frames it does draw
// uneven whenever the display refresh is not a multiple of it). The policy itself is unit-tested in
// test/render/frame-rate.test.js; what is asserted here is the wiring — that the renderer asks the policy for its
// cap instead of hard-coding a rate, that it measures the display itself (Pixi's ticker cannot see it: it skips
// the frames the cap drops), and that the adaptive load controller's thresholds are relative to the frame budget.
// A static check: the renderer needs a real canvas, so the wiring is asserted on the source.
// Run: node --test test/render/frame-cap.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RENDER_MAX_FPS } from '../../public/js/render/app/host.js';
import { MAX_FPS_CEILING } from '../../public/js/render/frameRate.js';

test('the frame-rate ceiling is 120 fps', () => {
  assert.equal(RENDER_MAX_FPS, 120);
  assert.equal(RENDER_MAX_FPS, MAX_FPS_CEILING, 'one ceiling, in one place');
  assert.equal(Number.isInteger(RENDER_MAX_FPS), true, 'Pixi wants a plain number (0 = uncapped)');
});

test('the renderer takes its cap from the policy, not from the constant directly', async () => {
  const src = await readFile(new URL('../../public/js/render/app.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ refreshFromDeltas, effectiveMaxFps \} from '\.\/frameRate\.js'/, 'the policy is imported');
  assert.match(src, /const fps = effectiveMaxFps\(refreshMs, RENDER_MAX_FPS\)/, 'the cap is a whole division of the refresh');
  assert.match(src, /app\.ticker\.maxFPS = fps/, 'and it is what the ticker gets');
  assert.doesNotMatch(src, /app\.ticker\.maxFPS = RENDER_MAX_FPS/, 'the raw ceiling must not be the cap once the display is known');
});

test('the display interval is measured by the renderer itself, and re-measured', async () => {
  const src = await readFile(new URL('../../public/js/render/app.js', import.meta.url), 'utf8');
  assert.match(src, /function measureRefresh\(/, 'its own animation-frame probe');
  assert.match(src, /refreshMs = ms; applyFrameCap\(\)/, 'the measurement feeds the cap');
  assert.match(src, /setTimeout\(again, 30_000\)/, 'a phone changes its refresh rate for power, so this is not a one-shot');
  assert.match(src, /visibilitychange/, 'and a tab coming back is worth re-measuring');
});

test('the adaptive load controller is relative to the frame budget, not to 60 Hz', async () => {
  const src = await readFile(new URL('../../public/js/render/app.js', import.meta.url), 'utf8');
  assert.match(src, /frameBudgetMs = 1000 \/ fps/, 'the budget follows the cap');
  assert.match(src, /frameMs > frameBudgetMs \* 1\.2 && busy/, 'slow is relative');
  assert.match(src, /frameMs < frameBudgetMs \* 1\.05/, 'recovered is relative');
  assert.doesNotMatch(src, /frameMs > 19\.5/, 'the 60 Hz literal must be gone');
  assert.doesNotMatch(src, /frameMs < 17\.6/, 'the 60 Hz literal must be gone');
});

test('the renderer exposes what the perf page needs to judge the spacing', async () => {
  const src = await readFile(new URL('../../public/js/render/app.js', import.meta.url), 'utf8');
  assert.match(src, /refreshMs, maxFps: app\.ticker\.maxFPS, frameBudgetMs/, 'stats() reports the policy');
  assert.match(src, /frameDeltas: frameDeltas\.slice\(\)/, 'and the raw rendered intervals the histogram is built from');
  assert.match(src, /frameDeltas\.push\(dtRaw \* 1000\)/, 'filled per rendered frame');
});
