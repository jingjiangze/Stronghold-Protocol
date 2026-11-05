// plumbing.mjs — the send path and the counters.
//
// The whitelist decides WHAT may be compressed; this decides what actually is, and counts it so the
// read-only routes can report the truth instead of a guess.
//
// The one rule this file exists to enforce: **every path that skips a frame skips it BEFORE `ws.send`.**
// That matters far beyond tidiness — with context takeover the compressed stream is bound to the
// connection's history, so a frame that entered the deflate context and then was NOT delivered would
// desynchronize the client's inflate context and corrupt every frame after it. Dropping before the
// send guarantees a skipped frame never touches the context.

/** Frames at or below this many queued bytes may be dropped (battle snapshots only). */
export const DEFAULT_SNAP_DROP_BYTES = 1 << 20;
/** A socket queue past this is hopeless: terminate rather than buffer. */
export const DEFAULT_HARD_BUFFER_BYTES = 16 << 20;

/** WebSocket readyState OPEN. Inlined rather than importing `ws`, which this module does not depend on. */
const WS_OPEN = 1;

/**
 * Per-connection transport counters. Cheap enough to keep on every socket, and the only honest source
 * for the read-only routes: `framesSkipped` vs `framesSent` is how a silently-broken whitelist shows up.
 */
export class TransportStats {
  constructor() {
    this.framesSent = 0;
    this.framesSkipped = 0;
    this.bytesSent = 0;
    this.bytesCompressed = 0;
    this.socketsTerminated = 0;
    this.since = Date.now();
  }

  /** @param {number} bytes @param {boolean} compressed */
  countSent(bytes, compressed) {
    this.framesSent += 1;
    this.bytesSent += bytes;
    if (compressed) this.bytesCompressed += bytes;
  }

  countSkipped() { this.framesSkipped += 1; }
  countTerminated() { this.socketsTerminated += 1; }

  /** A plain object for JSON serialisation. */
  toJSON() {
    return {
      framesSent: this.framesSent,
      framesSkipped: this.framesSkipped,
      bytesSent: this.bytesSent,
      bytesCompressed: this.bytesCompressed,
      socketsTerminated: this.socketsTerminated,
      since: new Date(this.since).toISOString(),
    };
  }
}

/**
 * Send an already-encoded frame, applying the compression decision and the two backpressure guards.
 *
 * @param {import('ws').WebSocket | null | undefined} ws
 * @param {string} data already-encoded frame
 * @param {{
 *   compress?: boolean,
 *   droppable?: boolean,
 *   stats?: TransportStats | null,
 *   snapDropBytes?: number,
 *   hardBufferBytes?: number,
 * }} [opts]
 * @returns {boolean} true when the frame was queued
 */
export function sendFrame(ws, data, {
  compress = false,
  droppable = false,
  stats = null,
  snapDropBytes = DEFAULT_SNAP_DROP_BYTES,
  hardBufferBytes = DEFAULT_HARD_BUFFER_BYTES,
} = {}) {
  if (!ws || ws.readyState !== WS_OPEN || typeof data !== 'string') return false;
  try {
    const queued = ws.bufferedAmount;
    if (queued > hardBufferBytes) {
      if (stats) stats.countTerminated();
      ws.terminate();
      return false;
    }
    // A drop here means `ws.send` is never reached, so the frame never enters the deflate context —
    // which is exactly why context takeover stays safe (see the file header).
    if (droppable && queued > snapDropBytes) {
      if (stats) stats.countSkipped();
      return false;
    }
    const wantCompress = compress === true;
    ws.send(data, { compress: wantCompress });
    if (stats) stats.countSent(Buffer.byteLength(data, 'utf8'), wantCompress);
    return true;
  } catch {
    return false;
  }
}

/**
 * A sender bound to one socket and one whitelist — the shape a broadcast loop wants.
 * @param {object} ws
 * @param {{
 *   isCompressible?: (type: unknown) => boolean,
 *   stats?: TransportStats | null,
 *   snapDropBytes?: number,
 *   hardBufferBytes?: number,
 * }} [opts]
 */
export function createSender(ws, { isCompressible = () => false, stats = null, ...limits } = {}) {
  return {
    stats: stats ?? new TransportStats(),
    /** @param {string} data @param {unknown} type @param {{droppable?: boolean}} [opts] */
    send(data, type, { droppable = false } = {}) {
      return sendFrame(ws, data, { compress: isCompressible(type), droppable, stats: this.stats, ...limits });
    },
  };
}
