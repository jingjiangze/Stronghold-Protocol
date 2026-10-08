// server/matchmaking.js — 快速匹配 (quick match): a lobby-owned queue that fills one co-op room with exactly
// MAX_SEATS humans for a difficulty.
//
// The semantics are borrowed from the Stardust fork's matchmaking (its own 464-line subsystem is built for a cluster
// of game hosts; this is the subset our single-process lobby needs, written against our lobby instead of copied):
//
//   * a queue entry is a PARTY (a list of sessions) and is never split. Every party is one solo player today —
//     our rooms have no group concept — but the shape is here so a party UI would not rewrite the queue.
//   * a room forms only at EXACTLY MAX_SEATS waiting for that difficulty. No AI fill: a matchmade room is all humans.
//   * forming is an OFFER that every member must accept within acceptMs. An offer that times out, or loses a member,
//     returns the OTHERS to the queue with their original join time and sequence — a player who accepted is never
//     punished for someone else's silence (the Stardust fork's own fix for the same trap).
//   * admission caps use 0 = unlimited (maxEntries, maxPerAddr); waitMs and acceptMs stay bounded.
//   * the queue reports what it is doing — waiting, oldestWaitSec, requeued — instead of a bare count, so a host can
//     see a queue that nobody ever leaves.
//
// The allocation itself is synchronous (create a room, seat everyone, tell them the code), so the Stardust fork's
// async prepare/commit/abort fences have nothing to guard here; `allocate` returning an error simply breaks the offer.
import { ERR, MAX_SEATS, DIFFICULTIES } from '../shared/constants.js';

export const MATCHMAKING_DEFAULTS = Object.freeze({ maxEntries: 0, maxPerAddr: 0, waitMs: 600_000, acceptMs: 30_000 });

const OK = Object.freeze({ ok: true });
const fail = (error, detail) => ({ error, detail });
const id = () => `q:${(Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 16)}`;

export class Matchmaking {
  /**
   * @param {{
   *   now?: () => number,
   *   send: (session: object, msg: object) => void,
   *   allocate: (sessions: object[], difficulty: string) => { code: string } | { error: string, detail?: string },
   *   available?: (session: object) => boolean,
   *   options?: { maxEntries?: number, maxPerAddr?: number, waitMs?: number, acceptMs?: number },
   *   timers?: { setTimeout: Function, clearTimeout: Function },
   * }} deps
   */
  constructor({ now = Date.now, send, allocate, available = () => true, options = {}, timers = { setTimeout, clearTimeout } }) {
    if (typeof allocate !== 'function') throw new TypeError('matchmaking needs an allocate function');
    this.now = now;
    this.send = send;
    this.allocate = allocate;
    this.available = available;
    this.timers = timers;
    this.opts = { ...MATCHMAKING_DEFAULTS, ...options };
    const limits = { maxEntries: 20_000, maxPerAddr: 20_000, waitMs: 3_600_000, acceptMs: 120_000 };
    for (const [key, max] of Object.entries(limits)) {
      const min = key === 'maxEntries' || key === 'maxPerAddr' ? 0 : 1;
      const v = this.opts[key];
      if (!Number.isSafeInteger(v) || v < min || v > max) throw new TypeError(`invalid matchmaking ${key}`);
    }
    /** @type {Map<string, { id: string, party: object[], difficulty: string, sequence: number, joinedAt: number, expiresAt: number, offerId: string|null, accepted: boolean, requeues: number }>} */
    this.entries = new Map(); // playerId -> entry
    /** @type {Map<string, { id: string, difficulty: string, entries: object[], deadline: number }>} */
    this.offers = new Map();
    this.sequence = 0;
    this.requeues = 0;
    this.timer = null;
    this.closed = false;
  }

  get size() { return this.entries.size; }
  has(playerId) { return this.entries.has(playerId); }

  /** How many are waiting for one difficulty (the pools never mix). */
  waiting(difficulty = null) {
    let n = 0;
    for (const e of this.entries.values()) if (difficulty == null || e.difficulty === difficulty) n += e.party.length;
    return n;
  }

  /** The queue's observable state: what it is doing, not just how big it is. */
  stats() {
    const byDifficulty = {};
    let oldest = null;
    for (const e of this.entries.values()) {
      byDifficulty[e.difficulty] = (byDifficulty[e.difficulty] || 0) + e.party.length;
      if (oldest == null || e.joinedAt < oldest) oldest = e.joinedAt;
    }
    return {
      waiting: this.entries.size,
      byDifficulty,
      offers: this.offers.size,
      requeued: this.requeues,
      oldestWaitSec: oldest == null ? 0 : Math.max(0, Math.round((this.now() - oldest) / 1000)),
    };
  }

  /** The `queue.state` a client renders: idle, queued (with the position) or offered (waiting for the accept). */
  state(session) {
    const e = this.entries.get(session.playerId);
    if (!e) return { t: 'queue.state', state: 'idle', required: MAX_SEATS };
    const offer = e.offerId ? this.offers.get(e.offerId) : null;
    return {
      t: 'queue.state',
      state: offer ? 'offered' : 'queued',
      difficulty: e.difficulty,
      required: MAX_SEATS,
      waiting: this.waiting(e.difficulty),
      joinedAt: e.joinedAt,
      deadline: offer ? offer.deadline : e.expiresAt,
      ...(offer ? { offerId: offer.id, accepted: e.accepted, acceptedCount: offer.entries.filter((x) => x.accepted).length } : {}),
      ...(e.requeues ? { requeues: e.requeues } : {}),
    };
  }

  /** queue.join { difficulty }: enqueue this player as a party of one. */
  join(session, { difficulty }) {
    this.refresh();
    if (this.closed) return fail(ERR.WRONG_PHASE, 'matchmaking is closed');
    if (!DIFFICULTIES.includes(difficulty)) return fail(ERR.BAD_MSG, 'invalid matchmaking request');
    const previous = this.entries.get(session.playerId);
    if (previous) {
      if (previous.difficulty !== difficulty) return fail(ERR.QUEUED, 'cancel before changing difficulty');
      this.send(session, this.state(session));
      return OK;
    }
    if (session.roomCode) return fail(ERR.ALREADY, 'leave your room first');
    if (!this.available(session)) return fail(ERR.WRONG_PHASE, 'unavailable');
    this.sweep();
    if (this.opts.maxEntries > 0 && this.entries.size + 1 > this.opts.maxEntries) return fail(ERR.RATE, 'matchmaking queue is full');
    if (this.opts.maxPerAddr > 0 && session.limitKey) {
      let n = 0;
      for (const e of this.entries.values()) if (e.party[0].limitKey === session.limitKey) n++;
      if (n + 1 > this.opts.maxPerAddr) return fail(ERR.RATE, 'too many queued players from your network');
    }
    const now = this.now();
    const entry = {
      id: id(), party: [session], difficulty, sequence: ++this.sequence,
      joinedAt: now, expiresAt: now + this.opts.waitMs, offerId: null, accepted: false, requeues: 0,
    };
    this.entries.set(session.playerId, entry);
    this.send(session, this.state(session));
    this.pump();
    this.arm();
    return OK;
  }

  /** queue.cancel: leave the queue (also the way out of an offer that has not been accepted). */
  cancel(session) {
    const e = this.entries.get(session.playerId);
    if (!e) { this.send(session, this.state(session)); return OK; }
    this.drop(session.playerId, 'cancelled');
    this.pump();
    this.arm();
    return OK;
  }

  /** queue.accept { offerId }: confirm the room. The offer forms when every member has accepted. */
  accept(session, { offerId }) {
    this.refresh();
    if (this.closed) return fail(ERR.WRONG_PHASE, 'matchmaking is closed');
    const e = this.entries.get(session.playerId);
    const offer = e && e.offerId ? this.offers.get(e.offerId) : null;
    if (!e || !offer || offer.id !== offerId) return fail(ERR.BAD_TARGET, 'stale matchmaking offer');
    if (!this.available(session)) { this.drop(session.playerId, 'unavailable'); return fail(ERR.WRONG_PHASE, 'unavailable'); }
    if (e.accepted) { this.send(session, this.state(session)); return OK; }
    e.accepted = true;
    for (const member of offer.entries) this.send(member.party[0], this.state(member.party[0]));
    if (!offer.entries.every((x) => x.accepted)) return OK;
    return this.commit(offer);
  }

  /** Everyone accepted: create the room, seat them, and send each one the code. */
  commit(offer) {
    let result;
    try { result = this.allocate(offer.entries.map((e) => e.party[0]), offer.difficulty); }
    catch { result = fail(ERR.INTERNAL, 'could not allocate a match'); }
    if (!result || result.error || typeof result.code !== 'string') {
      this.breakOffer(offer, 'allocation_failed');
      this.arm();
      return result && result.error ? result : fail(ERR.INTERNAL, 'could not allocate a match');
    }
    this.offers.delete(offer.id);
    for (const e of offer.entries) this.entries.delete(e.party[0].playerId);
    for (const e of offer.entries) {
      const session = e.party[0];
      this.send(session, { t: 'queue.state', state: 'matched', code: result.code, difficulty: offer.difficulty, required: MAX_SEATS });
    }
    this.pump();
    this.arm();
    return OK;
  }

  /**
   * Break an offer. Whoever CONFIRMED did their part and keeps their place in the queue — same joinedAt, same
   * sequence, so the FIFO order and the "how long have I waited" number survive; only the wait window is refreshed,
   * because the attempt they were waiting on is gone. Whoever did not confirm loses the slot (idle, `unconfirmed`),
   * and a player who vanished or entered a room is dropped. That is the point: a silent teammate must not cost the
   * others their place.
   */
  breakOffer(offer, reason = 'offer_expired') {
    if (!offer || this.offers.get(offer.id) !== offer) return;
    this.offers.delete(offer.id);
    for (const e of offer.entries) {
      const session = e.party[0];
      const confirmed = e.accepted;
      e.offerId = null;
      e.accepted = false;
      if (this.entries.get(session.playerId) !== e) continue;
      if (!this.available(session)) { this.drop(session.playerId, 'unavailable'); continue; }
      if (!confirmed) {
        this.entries.delete(session.playerId);
        this.send(session, { t: 'queue.state', state: 'idle', required: MAX_SEATS, reason: 'unconfirmed' });
        continue;
      }
      e.requeues++;
      this.requeues++;
      e.expiresAt = this.now() + this.opts.waitMs;
      this.send(session, { ...this.state(session), requeued: true, reason });
    }
  }

  /** Remove a player (cancel, disconnect, gone) — the whole party goes with them. */
  drop(playerId, reason = 'cancelled') {
    const e = this.entries.get(playerId);
    if (!e) return;
    if (e.offerId) this.breakOffer(this.offers.get(e.offerId), reason);
    this.entries.delete(playerId);
    const session = e.party[0];
    if (reason !== 'unavailable') this.send(session, { t: 'queue.state', state: 'idle', required: MAX_SEATS, reason });
  }

  /** One timer scans the queue; every incoming operation also enforces its own deadline (refresh). */
  sweep() {
    const now = this.now();
    for (const [pid, e] of [...this.entries]) {
      if (e.expiresAt <= now) this.drop(pid, 'expired');
      else if (!this.available(e.party[0])) this.drop(pid, 'unavailable');
    }
    for (const offer of [...this.offers.values()]) {
      if (offer.deadline <= now) this.breakOffer(offer, 'confirmation_timeout');
      else if (offer.entries.some((e) => !this.available(e.party[0]))) this.breakOffer(offer, 'unavailable');
    }
    this.pump();
    this.arm();
  }

  /** The offer of a member that went away expires at once rather than waiting for the deadline. */
  refresh() {
    for (const offer of [...this.offers.values()]) {
      if (offer.deadline <= this.now() || offer.entries.some((e) => !this.available(e.party[0]))) {
        this.breakOffer(offer, offer.deadline <= this.now() ? 'confirmation_timeout' : 'unavailable');
      }
    }
  }

  /** Form offers for every pool that now has exactly enough players. */
  pump() {
    if (this.closed) return;
    const pools = new Map();
    for (const e of this.entries.values()) {
      if (e.offerId) continue;
      if (!pools.has(e.difficulty)) pools.set(e.difficulty, []);
      pools.get(e.difficulty).push(e);
    }
    for (const [difficulty, pool] of pools) {
      if (pool.length !== MAX_SEATS) continue; // exact-full: no partial room, no AI fill
      pool.sort((a, b) => a.sequence - b.sequence);
      const offer = { id: id(), difficulty, entries: pool, deadline: Math.min(this.now() + this.opts.acceptMs, ...pool.map((e) => e.expiresAt)) };
      this.offers.set(offer.id, offer);
      for (const e of pool) { e.offerId = offer.id; e.accepted = false; }
      for (const e of pool) this.send(e.party[0], this.state(e.party[0]));
    }
  }

  arm() {
    if (this.timer != null) { this.timers.clearTimeout(this.timer); this.timer = null; }
    if (this.closed || !this.entries.size) return;
    let at = Infinity;
    for (const e of this.entries.values()) at = Math.min(at, e.expiresAt);
    for (const offer of this.offers.values()) at = Math.min(at, offer.deadline);
    this.timer = this.timers.setTimeout(() => { this.timer = null; this.sweep(); }, Math.max(1, at - this.now()));
    this.timer?.unref?.();
  }

  clear(reason) {
    if (this.timer != null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.offers.clear();
    for (const e of entries) this.send(e.party[0], { t: 'queue.state', state: 'idle', required: MAX_SEATS, reason });
  }

  close() { this.closed = true; this.clear('shutdown'); }
}
