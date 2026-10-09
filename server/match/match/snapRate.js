// server/match/match/snapRate.js — Match methods: the adaptive battle-snapshot rate (DESIGN §4, §8.2).
//
// The policy is a pure module (server/match/snapRate.js); this is the wiring — who is on the fast rate right
// now, and what interval a field should therefore emit at.
//
// The rate is per *connection*, because a link is per connection: one jittery watcher must not double the uplink
// of a field whose other watchers are on quiet links. A field emits at the fast interval as soon as any of its
// watchers needs it, and each watcher takes only the frames of its own cadence (server/match/fields.js _emit).
// Events drained on a skipped frame are held for that watcher and delivered with its next snapshot, so a
// skipped frame never drops a state-carrying `b.ev`.
//
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { SNAPSHOT_EVERY, SNAPSHOT_EVERY_FAST } from '../../sim/constants.js';
import { snapRatesCompatible } from '../snapRate.js';

/**
 * How often the policy re-reads the link samples. Well under the policy's own dwell (5 s), so a rate change is
 * never delayed by this, and far slower than the tick loop, so it costs nothing.
 */
export const SNAP_RATE_REFRESH_MS = 1000;

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
        const rate = this.snapRate.rateFor(playerId);
        this.log.info(`[snap] ${this.roomCode} ${playerId} → ${rate === SNAPSHOT_EVERY_FAST ? '20 Hz' : '10 Hz'}` +
          (jitter == null ? '' : ` (jitter ${Math.round(jitter)} ms)`));
      }
    }
    this.snapRate.prune(new Set(this.watchers.keys()));
  }

  /**
   * The snapshot interval (ticks) this field should emit at: the fast one as soon as any of its watchers is on
   * the fast rate. `SP_SNAP_RATE` pins it — 'slow' never escalates, 'fast' always does.
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
