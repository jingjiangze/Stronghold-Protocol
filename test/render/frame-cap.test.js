// test/render/frame-cap.test.js — the render loop's frame-rate cap. The battle sim ticks 60 times per real second, so
// rendering faster only repeats the same state; the cap is what keeps a 120/144 Hz display from costing CPU/GPU for
// nothing. A static check: the renderer needs a real canvas, so the wiring is asserted on the source.
// Run: node --test test/render/frame-cap.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RENDER_MAX_FPS } from '../../public/js/render/app/host.js';

test('the frame-rate cap is 60 fps', () => {
  assert.equal(RENDER_MAX_FPS, 60);
  assert.equal(Number.isInteger(RENDER_MAX_FPS), true, 'Pixi wants a plain number (0 = uncapped)');
});

test('the renderer applies it to the Pixi ticker, from that constant', async () => {
  const src = await readFile(new URL('../../public/js/render/app.js', import.meta.url), 'utf8');
  assert.match(src, /app\.ticker\.maxFPS = RENDER_MAX_FPS/, 'the ticker is capped, not left at Pixi’s uncapped default');
  assert.match(src, /RENDER_MAX_FPS, releaseGl \}/, 'and the constant is imported from the render host');
});
