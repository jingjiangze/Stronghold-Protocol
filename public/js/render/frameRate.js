// render/frameRate.js — the display's frame interval and the render loop's frame-rate cap (pure logic, no DOM).
//
// Why this exists: a numeric cap on the render loop is NOT "draw less" — Pixi skips whole frames, and its test has
// an `| 0` truncation, so a cap that is not a whole multiple of the display's refresh interval makes the *spacing*
// of the frames it does draw uneven. Simulated against Pixi 7.4's own algorithm (set maxFPS → _minElapsedMS =
// 1000/maxFPS; update() → skip while (t - lastFrame | 0) < _minElapsedMS):
//
//   refresh   60 fps cap                           uncapped
//   60 Hz     16.667 × 99% / 33.333 × 1%           16.667 × 100%
//   120 Hz    16.667 × 98% / 25.000 × 2%           8.333 × 100%
//   144 Hz    13.889 × 57% / 20.833 × 43%          6.944 × 100%   ← the 60 cap gives a 3:2 beat
//   165 Hz    18.182 × 83% / 12.121 × 17%          6.061 × 100%
//   240 Hz    16.667 × 96% / 20.833 × 4%           4.167 × 100%
//
// So the cap is expressed as "draw one frame every k refreshes" (k ≥ 1), never as an absolute rate: any k gives
// even spacing, an arbitrary rate does not. MAX_FPS_CEILING bounds k from below (k = ceil(refresh / ceiling)), so
// the rendered rate never exceeds the ceiling while the spacing stays even.

/**
 * The rendered frame rate is never above this. It is a ceiling on *k*, not a rate: on a 144 Hz panel this yields
 * 72 (every 2nd refresh), not a juddering 120. See effectiveMaxFps.
 */
export const MAX_FPS_CEILING = 120;

/** A frame delta outside this range is not a display interval: too small is a double callback, too large a stall. */
const MIN_DELTA_MS = 1;
const MAX_DELTA_MS = 100;

/** `v` rounded to `d` decimals. */
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * The display's frame interval (ms) from a run of animation-frame deltas.
 *
 * The interval is the *floor* of the observed deltas — the browser fires the callback once per refresh, and a
 * loaded main thread can only ever make a delta longer (a multiple of the interval), never shorter. So a low
 * percentile is the estimate, not the mean. p10 rather than the minimum so one spuriously short delta (a
 * double callback) cannot halve the answer.
 *
 * @param {readonly number[]} deltas frame deltas in ms
 * @returns {number | null} the interval in ms, or null when there is nothing usable
 */
export function refreshFromDeltas(deltas) {
  if (!Array.isArray(deltas) || !deltas.length) return null;
  const ok = deltas.filter((d) => Number.isFinite(d) && d >= MIN_DELTA_MS && d <= MAX_DELTA_MS);
  if (!ok.length) return null;
  ok.sort((a, b) => a - b);
  return round(ok[Math.min(ok.length - 1, Math.floor(ok.length * 0.1))]);
}

/**
 * The cap to hand Pixi's `ticker.maxFPS`, as "one frame every k refreshes": the largest rate that is at most
 * `ceiling` and an integer division of the refresh. Falls back to the plain ceiling when the refresh is unknown
 * (the cap is then only a bound, and a display whose rate divides the ceiling is still paced evenly).
 *
 * @param {number | null | undefined} refreshMs the display interval from refreshFromDeltas
 * @param {number} [ceiling] MAX_FPS_CEILING
 * @returns {number} a rate for `maxFPS` (never 0: 0 would mean uncapped, which ignores the ceiling)
 */
export function effectiveMaxFps(refreshMs, ceiling = MAX_FPS_CEILING) {
  const hz = 1000 / Number(refreshMs);
  if (!Number.isFinite(hz) || hz <= 0) return ceiling;
  const k = Math.max(1, Math.ceil(hz / ceiling));
  // full precision, so 1000/rate lands exactly on k display intervals
  return hz / k;
}

/**
 * How the *rendered* frames were spaced, bucketed by "how many refreshes this frame occupied". This is the figure
 * that separates judder from a low frame rate: a steady 60 fps on a 144 Hz panel and a 3:2 beat at the same
 * average both report ~60 fps, and only the histogram tells them apart.
 *
 * @param {readonly number[]} deltas rendered frame deltas in ms
 * @param {number | null} refreshMs the display interval (refreshFromDeltas); without it there is nothing to compare to
 * @returns {{ buckets: { refreshes: number, count: number, pct: number }[], modal: number | null, modalPct: number | null, even: boolean | null }}
 */
export function frameHistogram(deltas, refreshMs) {
  const empty = { buckets: [], modal: null, modalPct: null, even: null };
  if (!Number.isFinite(Number(refreshMs)) || Number(refreshMs) <= 0) return empty;
  const ok = (Array.isArray(deltas) ? deltas : []).filter((d) => Number.isFinite(d) && d >= MIN_DELTA_MS && d <= 4000);
  if (!ok.length) return empty;
  const counts = new Map();
  for (const d of ok) {
    const k = Math.max(1, Math.round(d / refreshMs));
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const buckets = [...counts.entries()]
    .map(([refreshes, count]) => ({ refreshes, count, pct: round((count / ok.length) * 100, 1) }))
    .sort((a, b) => a.refreshes - b.refreshes);
  const top = buckets.reduce((a, b) => (b.count > a.count ? b : a));
  return { buckets, modal: top.refreshes, modalPct: top.pct, even: top.pct >= 98 };
}

/** A one-line reading of a histogram, for a report or a log: `每 2 个刷新一帧 ×100%` / `2:3 不匀`. */
export function histogramText(h) {
  if (!h || !h.buckets.length) return '（无法判断：没测到显示器间隔）';
  const parts = h.buckets.map((b) => `${b.refreshes}×${b.pct}%`);
  return `${parts.join(' / ')}${h.even ? '（均匀）' : '（不匀 = 抖）'}`;
}
