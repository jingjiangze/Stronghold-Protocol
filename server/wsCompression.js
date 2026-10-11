// server/wsCompression.js — bounded, opt-in WebSocket compression (SP_WS_COMPRESSION=on|off, default off).
//
// Why opt-in: permessage-deflate trades CPU and a little latency for bandwidth, and the two only pay off on a link
// that is actually narrow. Battle frames (snapshots, events, field/damage pushes) are repetitive and dominate the
// byte count, so they are the only types compressed; everything else — credentials, hello/welcome, control and
// request/response traffic — stays uncompressed, which also keeps small frames from growing.
//
// Direction: this whitelist governs the SERVER's outbound frames only (send → sendRaw passes `compress`, ws.send
// applies it). The client's own outbound frames are not filtered here — `clientNoContextTakeover` is an extension
// negotiation parameter (it bounds the client's deflate context), NOT a per-message switch, and the size
// threshold is likewise the server's. So the accurate statement is "the server compresses these types on the way
// out", not "these types are compressed in both directions".
//
// The bounds matter as much as the ratio: no context takeover on either side (so a long-lived socket cannot grow
// unbounded state), a 12-bit window, a 64-byte threshold, 8 concurrent deflates and level 6 with memLevel 5 —
// the settings this project measured on a live server, not zlib's defaults. (12 rather than 9: the small window was
// tuned for the ~250-byte battle frames, but `m.public` is ~4.6 KB and a 512-byte window cannot reach its repeated
// bond/status blocks — measured 3.36x at 9 vs 4.94x at 12, and it is now 98% of the bytes a seat receives.)
//
// Why 64 and not the 512 this shipped with: `ws` treats `threshold` as a hard off switch, not a hint — below it the
// frame goes out with rsv1 clear, i.e. not deflated at all (lib/sender.js: `rsv1 = byteLength >= _threshold`).
// Step ④ (the per-recipient delta) shrank the hot `m.public` frame to a median well under 512 B, so 61% of those
// frames stopped being compressed the moment the delta landed: ④'s 5.96x raw win reached the wire as 2.51x instead
// of 2.91x. Measured with the real library over one seat's whole match — threshold 512 -> 36,835 B, threshold 64 ->
// 31,855 B (-13.5% on the stream, no frame skipped), and deflating the frames that used to be skipped costs 143 ms
// of CPU for an entire match (0.1%). 64 rather than 0 because the very smallest frames do grow: the 34 frames under
// 64 B are 68 B cheaper left uncompressed.
const OPTIONS = Object.freeze({
  threshold: 64,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  serverMaxWindowBits: 12,
  concurrencyLimit: 8,
  zlibDeflateOptions: Object.freeze({ level: 6, memLevel: 5 }),
});

/** The `perMessageDeflate` value for a mode string: `false`, or the bounded option set. */
export function resolveWsCompression(mode = 'off') {
  if (mode === 'off') return false;
  if (mode === 'on') return OPTIONS;
  throw new TypeError('SP_WS_COMPRESSION must be on or off');
}

/** Message types worth compressing: the repetitive, high-volume traffic. `m.public` is the match's public
 *  state broadcast — by measurement 98% of everything a seat receives, and its JSON is highly repetitive
 *  (bond lists, the fields' progress, the per-player status block), so it compresses ~4x. `m.private` is the
 *  per-player view (shop / hand / board), sent only when it changed. */
export function isCompressibleType(type) {
  return type === 'b.snap' || type === 'b.ev' || type === 'm.field'
    || type === 'm.public' || type === 'm.private' || type === 'm.result';
}
