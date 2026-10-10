// server/match/match/snapRate.js — Match methods: the adaptive battle-snapshot rate (DESIGN §4, §8.2).
//
// The policy is a pure module (server/match/snapRate.js); this is the wiring — who is on the fast rate right
// now, and whether a given watcher takes the fast one.
//
// The rate is per *connection*, because a link is per connection: one jittery watcher must not double the uplink
// of a field whose other watchers are on quiet links. Each watcher carries its own elapsed-tick counter, so the
// field can serve both cadences at once (server/match/fields.js _emit): a watcher on the fast rate takes a frame
// every SNAPSHOT_EVERY_FAST ticks, a slow watcher every SNAPSHOT_EVERY — 20 Hz and 15 Hz at 2× — and the two do
// not need to nest. Events drained on a skipped tick are held for that watcher and delivered with its next
// snapshot, so a skipped frame never drops a state-carrying `b.ev`.
//
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { SNAPSHOT_EVERY, SNAPSHOT_EVERY_FAST, TICK } from '../../sim/constants.js';
import { GAME_SPEED } from '../fields.js';
import { snapRatesCompatible } from '../snapRate.js';

/**
 * How often the policy re-reads the link samples. Well under the policy's own dwell (5 s), so a rate change is
 * never delayed by this, and far slower than the tick loop, so it costs nothing.
 */
export const SNAP_RATE_REFRESH_MS = 1000;

/** The wire rate an interval of `every` ticks works out to at the match's speed (GAME_SPEED / TICK = 60 ticks/s). */
const rateLabel = (every) => `${Math.round(GAME_SPEED / TICK / every)} Hz`;

export class MatchSnapRate {
  /**
   * Re-read every watched connection's link samples and settle its snapshot rate. Throttled to
   * SNAP_RATE_REFRESH_MS of match time. A match with no link source (tests, a host that passes none) keeps the
   * slow rate everywhere and never enters here.
   */
  refreshSnapRates() {
    if (!this.linkOf) return;
    const now = this.sched.now();
    if (now - this._snapRateAt < SNAP_RATE_REFRESH_MS) return;
    this._snapRateAt = now;
    for (const playerId of this.watchers.keys()) {
      let link = null;
      try { link = this.linkOf(playerId); } catch (e) { this.reportError('linkOf', e); }
      this.snapRate.update(playerId, link, now);
      if (this.snapRate.changed(playerId)) {
        const jitter = this.snapRate.jitterOf(playerId);
        // the label is derived from the interval, never a literal: it cannot drift from the constants again
        const rate = this.snapRate.rateFor(playerId);
        this.log.info(`[snap] ${this.roomCode} ${playerId} → ${rateLabel(rate)}` +
          (jitter == null ? '' : ` (jitter ${Math.round(jitter)} ms)`));
      }
    }
    this.snapRate.prune(new Set(this.watchers.keys()));
  }

  /**
   * The finest snapshot interval (ticks) this field needs right now: the fast one as soon as any of its watchers is
   * on the fast rate, else the slow one. Observability only — the wire path asks `snapIsFast(pid)` per watcher
   * (fields.js _emit): each watcher counts its own ticks, so the field serves both cadences at once and no field-wide
   * grid exists any more. `SP_SNAP_RATE` pins it — 'slow' never escalates, 'fast' always does.
   * @param {string} fieldId
   * @returns {number}
   */
  snapEveryFor(fieldId) {
    if (this.snapRateMode === 'slow') return SNAPSHOT_EVERY;
    if (this.snapRateMode === 'fast') return SNAPSHOT_EVERY_FAST;
    if (!snapRatesCompatible()) return SNAPSHOT_EVERY;
    for (const playerId of this.watchersOf(fieldId)) if (this.snapRate.isFast(playerId)) return SNAPSHOT_EVERY_FAST;
    return SNAPSHOT_EVERY;
  }

  /** Whether this watcher is on the fast rate right now (it then takes every emitted frame). @param {string} playerId */
  snapIsFast(playerId) {
    if (this.snapRateMode === 'fast') return true;
    if (this.snapRateMode === 'slow' || !snapRatesCompatible()) return false;
    return this.snapRate.isFast(playerId);
  }

  /** Connections on the fast rate (observability: /healthz, the match log). */
  snapFastCount() {
    if (this.snapRateMode === 'fast') return this.watchers.size;
    if (this.snapRateMode === 'slow' || !snapRatesCompatible()) return 0;
    return this.snapRate.fastCount();
  }
}
