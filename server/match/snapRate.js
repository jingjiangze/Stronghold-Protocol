// server/match/snapRate.js — the adaptive battle-snapshot rate (DESIGN §4, §8.2).
//
// Every watched field streams `b.snap` to each of its watchers every SNAPSHOT_EVERY ticks (4 = 15 Hz at 2×); a
// connection whose own link is jittery enough to need it gets SNAPSHOT_EVERY_FAST (3 = 20 Hz) instead. On a quiet
// link the base rate costs nothing extra — the client interpolates between snapshots. On a jittery one the lower
// rate costs smoothness:
//
//   the client's interpolation buffer trails the newest snapshot by `delay` = 100 ms (public/js/render/interp.js),
//   which at 10 Hz was exactly one snapshot interval — zero slack, every bit of arrival jitter ran the render clock
//   past the newest snapshot, and past `maxExtrapolate` (120 ms) the view froze. The base rate is 15 Hz for that
//   reason: 100 ms covers 1.5 intervals there (2.0 at 20 Hz), so it absorbs ~33 ms of arrival jitter where 10 Hz
//   absorbed none, and the fast rate stays the fallback for worse links.
//
// Measured at the 10/20 Hz pair with the real buffer fed jittered arrival times (probe-interp-jitter.mjs, four
// committed perf specs):
//
//     jitter   10 Hz extrapolated frames   20 Hz extrapolated frames
//     30 ms                 0.1%                      0.0%
//     50 ms                 1.5%                      0.2%
//     75 ms                 4.2%                      0.6%
//    150 ms                11.2%                      3.6%
//
// The 15 Hz base sits between those two columns (its 100 ms buffer covers 1.5 intervals, so its extrapolation rates
// sit between theirs). SNAP_ESCALATE_MS = 50 is therefore conservative for the base that ships: escalation happens
// before it is strictly needed. Recalibrating the threshold against a 15 Hz measurement is an open item (the probe
// is not in the tree) — do not replace this table with an estimate.
//
// Note what is NOT the signal: how far units move between snapshots. That measured p99 0.15–0.44 tiles on the
// same four specs — far under the client's 2.5-tile teleport threshold, and the only large step (4.472 tiles)
// is a skill teleport that measures identically at 20 Hz. Lowering the rate did not make anything jump.
//
// So the rate follows the *link*, per connection: SNAPSHOT_EVERY_FAST while the server's own ws ping/pong
// round trips say the link is jittery enough to need it, SNAPSHOT_EVERY otherwise. The samples come from
// server/net.js (the server pings; the client's WebSocket implementation answers with no client change), so
// this needs no protocol change and works for older clients. Jitter here is the mean absolute successive
// difference of the RTT samples — the same statistic the live deployment shows at ~56 ms on a mobile link.
//
// Two brakes keep it honest: a connection whose socket is already queueing (bufferedAmount) is never
// escalated — more frames would deepen the queue, not help — and a switch must survive `dwellMs` so the two
// rates cannot flap. Mode is SP_SNAP_RATE=auto (default) | slow | fast; see server/match/match/snapRate.js.
//
// A pure module: no sockets, no timers. `update()` is fed samples and returns a rate; the caller owns the clock.

import { SNAPSHOT_EVERY, SNAPSHOT_EVERY_FAST } from '../sim/constants.js';

/** The two snapshot intervals, as tick counts (4 = 15 Hz, 3 = 20 Hz at 2× real time). */
export const SNAP_SLOW = SNAPSHOT_EVERY;
export const SNAP_FAST = SNAPSHOT_EVERY_FAST;

/**
 * Escalate at the jitter where 20 Hz starts to pay: measured at the 10 Hz base, 10 Hz extrapolated 1.5% of frames
 * at 50 ms against 20 Hz's 0.2%. Below `calmMs` both rates measured 0.0%, so a calm link drops back. The base is
 * 15 Hz now, so the threshold is conservative (see the header; recalibration is an open item).
 */
export const SNAP_ESCALATE_MS = 50;
export const SNAP_CALM_MS = 20;
/** RTT samples kept per connection (server/net.js ring). Three are enough to measure jitter; the rest smooth it. */
export const SNAP_MIN_SAMPLES = 3;
/** How long a rate must hold before the other one may replace it (both directions), so the rates cannot flap. */
export const SNAP_DWELL_MS = 5000;
/**
 * A socket with this much queued is not keeping up: escalating would add frames to a backlog that is already 32 KiB
 * deep, so the policy drops to the slow rate and stays there until the queue drains.
 */
export const SNAP_CONGESTED_BYTES = 32 * 1024;

/**
 * The mean absolute successive difference of a series of numbers (ms here): the metric an arrival-jitter
 * buffer actually feels, and the one this project measured end to end. `null` until there are enough samples
 * to mean anything.
 * @param {readonly number[]} samples oldest → newest
 * @returns {number | null}
 */
export function rttJitter(samples) {
  if (!Array.isArray(samples) || samples.length < SNAP_MIN_SAMPLES) return null;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    sum += Math.abs(b - a);
    n++;
  }
  return n ? sum / n : null;
}

/** `SP_SNAP_RATE` → 'auto' | 'slow' | 'fast'. Anything unrecognised (and unset) means auto. @param {unknown} v */
export function parseSnapRate(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'slow' || s === '10') return 'slow';
  if (s === 'fast' || s === '20') return 'fast';
  return 'auto';
}

/**
 * Sanity check of the two intervals: both are positive integers and SNAP_SLOW >= SNAP_FAST, i.e. "fast" is at least
 * as dense as "slow". Divisibility is no longer required — each watcher counts the ticks since its own last frame
 * (server/match/fields.js _emit), so a slow watcher on a field that also carries a fast one keeps its own cadence
 * whatever the two intervals are (4 and 3 ticks do not nest, and no longer need to). A configuration that fails
 * this check has no usable fast rate, so the policy pins everyone to the slow one.
 */
export const snapRatesCompatible = () =>
  Number.isInteger(SNAP_FAST) && Number.isInteger(SNAP_SLOW) && SNAP_FAST > 0 && SNAP_SLOW >= SNAP_FAST;

/**
 * Per-connection snapshot-rate policy. One instance per match; `update()` per watcher on a throttle,
 * `rateFor()`/`isFast()` whenever a frame is about to go out.
 */
export class SnapRate {
  /**
   * @param {{ escalateMs?: number, calmMs?: number, dwellMs?: number, congestedBytes?: number }} [opts]
   *   calmMs defaults to the same fraction of escalateMs as the measured pair below (20 / 50), so moving the
   *   threshold keeps the hysteresis band proportional instead of accidentally narrowing it to nothing.
   */
  constructor({ escalateMs = SNAP_ESCALATE_MS, calmMs = null, dwellMs = SNAP_DWELL_MS, congestedBytes = SNAP_CONGESTED_BYTES } = {}) {
    this.escalateMs = escalateMs;
    this.calmMs = calmMs ?? escalateMs * (SNAP_CALM_MS / SNAP_ESCALATE_MS);
    this.dwellMs = dwellMs;
    this.congestedBytes = congestedBytes;
    /** @type {Map<string, { rate: typeof SNAP_SLOW | typeof SNAP_FAST, changedAt: number, jitter: number | null, changed: boolean }>} */
    this.states = new Map();
  }

  /** @param {string} playerId */
  _state(playerId) {
    let st = this.states.get(playerId);
    if (!st) {
      st = { rate: SNAP_SLOW, changedAt: -Infinity, jitter: null, changed: false };
      this.states.set(playerId, st);
    }
    return st;
  }

  /**
   * Feed one connection's link samples and settle on its rate. A connection with no samples, or with too few,
   * keeps whatever it has (the initial rate is the slow one: the bandwidth-saving default).
   * @param {string} playerId
   * @param {{ rtts?: readonly number[], buffered?: number } | null} stats server/net.js linkQualityOf()
   * @param {number} now ms (a monotone-ish clock; only differences matter)
   * @returns {typeof SNAP_SLOW | typeof SNAP_FAST} the rate now in force
   */
  update(playerId, stats, now) {
    const st = this._state(playerId);
    st.changed = false;
    if (!stats) return st.rate;

    const buffered = Number(stats.buffered) || 0;
    if (buffered >= this.congestedBytes) {
      // The socket is already queueing: the frames are not arriving on time and adding more would deepen the
      // backlog. Drop to the slow rate and do not wait out the dwell — a congested link is bad right now.
      st.jitter = null;
      if (st.rate !== SNAP_SLOW) {
        st.rate = SNAP_SLOW;
        st.changedAt = now;
        st.changed = true;
      }
      return st.rate;
    }

    const jitter = rttJitter(stats.rtts);
    st.jitter = jitter;
    if (jitter == null) return st.rate;

    const want = jitter >= this.escalateMs ? SNAP_FAST : jitter <= this.calmMs ? SNAP_SLOW : null;
    if (want == null || want === st.rate) return st.rate;
    if (now - st.changedAt < this.dwellMs) return st.rate;
    st.rate = want;
    st.changedAt = now;
    st.changed = true;
    return st.rate;
  }

  /** @param {string} playerId @returns {typeof SNAP_SLOW | typeof SNAP_FAST} */
  rateFor(playerId) {
    if (!snapRatesCompatible()) return SNAP_SLOW;
    return this.states.get(playerId)?.rate ?? SNAP_SLOW;
  }

  /** @param {string} playerId */
  isFast(playerId) {
    return this.rateFor(playerId) === SNAP_FAST;
  }

  /** Whether the last `update()` for this connection changed its rate (the caller logs it). @param {string} playerId */
  changed(playerId) {
    return this.states.get(playerId)?.changed === true;
  }

  /** The last measured jitter in ms, for the log line / /healthz (`null` before any sample). @param {string} playerId */
  jitterOf(playerId) {
    return this.states.get(playerId)?.jitter ?? null;
  }

  /** Connections currently on the fast rate (observability). */
  fastCount() {
    let n = 0;
    for (const st of this.states.values()) if (st.rate === SNAP_FAST) n++;
    return n;
  }

  /** Forget connections that left (a long match would otherwise accumulate one entry per departed watcher). */
  prune(keep) {
    for (const playerId of [...this.states.keys()]) if (!keep.has(playerId)) this.states.delete(playerId);
  }
}
