// server/wsCompression.js — bounded, opt-in WebSocket compression (SP_WS_COMPRESSION=on|off, default off).
//
// Why opt-in: permessage-deflate trades CPU and a little latency for bandwidth, and the two only pay off on a link
// that is actually narrow. Battle frames (snapshots, events, field/damage pushes) are repetitive and dominate the
// byte count, so they are the only types compressed; everything else — credentials, hello/welcome, control and
// request/response traffic — stays uncompressed, which also keeps small frames from growing.
//
// The bounds matter as much as the ratio: no context takeover on either side (so a long-lived socket cannot grow
// unbounded state), a 12-bit window, a 512-byte threshold, 8 concurrent deflates and level 6 with memLevel 5 —
// the settings this project measured on a live server, not zlib's defaults.
const OPTIONS = Object.freeze({
  threshold: 512,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  serverMaxWindowBits: 9,
  concurrencyLimit: 8,
  zlibDeflateOptions: Object.freeze({ level: 6, memLevel: 5 }),
});

/** The `perMessageDeflate` value for a mode string: `false`, or the bounded option set. */
export function resolveWsCompression(mode = 'off') {
  if (mode === 'off') return false;
  if (mode === 'on') return OPTIONS;
  throw new TypeError('SP_WS_COMPRESSION must be on or off');
}

/** Message types worth compressing: the repetitive, high-volume battle traffic. */
export function isCompressibleType(type) {
  return type === 'b.snap' || type === 'b.ev' || type === 'm.field';
}
