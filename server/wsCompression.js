// server/wsCompression.js — opt-in WebSocket compression (SP_WS_COMPRESSION=off|on|safe, default off).
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
// ============================================================================================
// Why this config declares LESS than it used to (2026-10-11)
// ============================================================================================
// `on` deliberately does NOT set `serverNoContextTakeover` and does NOT set `serverMaxWindowBits`. Both omissions
// are load-bearing, and they point the same way — leaving them out is BOTH the better compression AND the safer
// negotiation:
//
// 1. CONTEXT TAKEOVER. With no context takeover every frame is deflated from scratch, so content that repeats
//    across frames pays its compressed size again in every frame. The hot frames are almost entirely repetition:
//    measured over one seat's whole match with the real library (byte-exact round trip), `m.private` goes 4.07x ->
//    43.55x and the delta-mode `m.public` 2.69x -> 12.68x; on a stream interleaved at the real per-type rates
//    (so the window is shared the way it is in production) the whole flow is 3.76x -> 26.59x. It is also FASTER
//    (52 ms vs 84 ms for that flow): less data to deflate and to push.
//    NOTE: `ws` already defaults to context takeover — this project had explicitly turned it OFF. Setting the
//    option to `false` would be wrong, not just redundant: in ws's negotiation a literal `false` means "REQUIRE
//    context takeover" and silently rejects any client that asks for `server_no_context_takeover`
//    (lib/permessage-deflate.js `acceptAsServer`), and a rejected offer aborts the handshake with HTTP 400
//    (lib/websocket-server.js). Omitting it means "negotiate", so such a client still gets a working connection.
//
// 2. THE WINDOW. Left unset, ws deflates with `zlib.Z_DEFAULT_WINDOWBITS` (15) — see `_compress`. That is the
//    window the measurement above used. Declaring a number is what risks the 400: `acceptAsServer` rejects the
//    offer when the server's window exceeds the one the CLIENT offered, so a pinned 15 would refuse to connect to
//    any client that asks for less. Unset, a client that asks for 12 is honoured (degraded, still connects).
//
// A rejected offer is not a degraded connection, it is NO connection, which is why `safe` exists as a fallback:
// it drops context takeover (the only part of the new shape that carries risk) while still leaving the window
// negotiated, for the case where the new shape misbehaves on a box. It is a one-word change: the box's slot script
// reads `D:\stronghold\update\ws-mode.txt` (see tools/box/sp_update_zip.ps1), which survives every deploy — unlike
// a hand-edited `set` line, which the updater rewrites on each one.
//
// ⚠️ The window pin this module used to carry (`serverMaxWindowBits: 12`) was a latent instance of the same
// hazard: it made ws reject any client offering a smaller `server_max_window_bits` (a 9, say) with HTTP 400.
// Browsers never offer one, so it never bit — the negotiation test in test/ws-compression.test.js now covers it.
//
// Still bounded: `clientNoContextTakeover` keeps the inbound (client → server) direction from growing, and
// `concurrencyLimit` caps concurrent deflates. The server's own deflate context is bounded by the window (32 KB).
//
// Why 64 and not the 512 this shipped with: `ws` treats `threshold` as a hard off switch, not a hint — below it the
// frame goes out with rsv1 clear, i.e. not deflated at all (lib/sender.js: `rsv1 = byteLength >= _threshold`).
// Step ④ (the per-recipient delta) shrank the hot `m.public` frame to a median well under 512 B, so 61% of those
// frames stopped being compressed the moment the delta landed: ④'s 5.96x raw win reached the wire as 2.51x instead
// of 2.91x. Measured with the real library over one seat's whole match — threshold 512 -> 36,835 B, threshold 64 ->
// 31,855 B (-13.5% on the stream, no frame skipped), and deflating the frames that used to be skipped costs 143 ms
// of CPU for an entire match (0.1%). 64 rather than 0 because the very smallest frames do grow: the 34 frames under
// 64 B are 68 B cheaper left uncompressed.
const SHARED = Object.freeze({
  threshold: 64,
  clientNoContextTakeover: true,
  concurrencyLimit: 8,
  zlibDeflateOptions: Object.freeze({ level: 6, memLevel: 5 }),
});

/** The shipped set: `SHARED` plus context takeover and zlib's default window, both left undeclared on purpose. */
const OPTIONS = SHARED;

/** The one-step fallback: context takeover off (the only part of the new shape that carries risk), window still
 *  negotiated — pinning a window is what makes ws reject an offer, so the fallback must not reintroduce that. */
const SAFE_OPTIONS = Object.freeze({ ...SHARED, serverNoContextTakeover: true });

/** Every mode this module accepts. `on` is the shipped default; `safe` is the operational fallback. */
const MODES = Object.freeze({ off: false, on: OPTIONS, safe: SAFE_OPTIONS });

/**
 * The `perMessageDeflate` value for a mode string.
 *
 * `off` (the default) → `false`. `on` → the shipped set (context takeover, default window). `safe` → the previous
 * bounded shape, the one-word fallback. Anything else is refused rather than silently defaulted: a typo in
 * `SP_WS_COMPRESSION` must not quietly change what goes on the wire.
 * @param {string} [mode]
 * @returns {false | object}
 */
export function resolveWsCompression(mode = 'off') {
  if (Object.prototype.hasOwnProperty.call(MODES, mode)) return MODES[mode];
  throw new TypeError('SP_WS_COMPRESSION must be off, on or safe');
}

/** Message types worth compressing: the repetitive, high-volume traffic. `m.public` is the match's public
 *  state broadcast — the largest single stream a seat receives — and `m.private` is the per-player view
 *  (shop / hand / board), sent only when it changed. Both are highly repetitive ACROSS frames, which is what
 *  context takeover (above) is for. */
export const BASE_COMPRESSIBLE_TYPES = Object.freeze([
  'b.snap', 'b.ev', 'm.field', 'm.public', 'm.private', 'm.result',
]);

/**
 * Types compressed ON TOP of the base set, and the reason this is a separate, env-driven list rather than six
 * more `||` in the predicate: **the base set and the mode have different risk profiles, and a whitelist edit
 * used to have no way back.** The mode is reversible in one word (`SP_WS_COMPRESSION=safe`) while the whitelist
 * was code — reverting it meant a revert-plus-redeploy, i.e. up to an hour on the box.
 *
 * `b.start` is the first entry, and the clearest argument for the switch existing: it carries the battle spec
 * the client replays (~4.2 KB, sent once per field per player) and it is NOT droppable, so a bad interaction
 * with context takeover has no fast way out otherwise. Measured on a real interleaved stream it compresses
 * ~13x, but `SP_WS_COMPRESS_EXTRA=none` must be able to take it back without a deploy.
 *
 * ⚠️ A type that carries a LARGE payload and is NOT listed is the expensive kind of mistake: it pays full
 * price in every frame and is invisible in a smoke test. `b.start` sat outside the base set until it was
 * measured at 72.5 B/s — 69% of the whole uplink. Re-measure the per-type table whenever a new frame type
 * joins the protocol; the read-only route reports the resolved list so this is checkable in production.
 */
export const DEFAULT_EXTRA_COMPRESSIBLE_TYPES = Object.freeze(['b.start']);

/**
 * Parse `SP_WS_COMPRESS_EXTRA`.
 *
 * `undefined` (unset) takes the default; the literal `none` — or an empty value — selects NO extras, which is
 * the one-word rollback. Anything else is a comma-separated type list. The word rather than an empty string is
 * deliberate: in a Windows `.cmd` a bare `set X=` UNSETS the variable, so "empty" cannot be expressed there and
 * would silently fall back to the default — the exact opposite of what an operator typing it means.
 * @param {string | undefined | null} spec
 * @returns {readonly string[]}
 */
export function parseExtraCompressibleTypes(spec) {
  if (spec === undefined || spec === null) return DEFAULT_EXTRA_COMPRESSIBLE_TYPES;
  const s = String(spec).trim().toLowerCase();
  if (s === '' || s === 'none') return [];
  return Object.freeze([...new Set(s.split(',').map((t) => t.trim()).filter(Boolean))]);
}

/** The set the running process actually compresses with, from `SP_WS_COMPRESS_EXTRA`. */
function resolvedCompressibleTypes(env = process.env) {
  return new Set([...BASE_COMPRESSIBLE_TYPES, ...parseExtraCompressibleTypes(env.SP_WS_COMPRESS_EXTRA)]);
}

const COMPRESSIBLE = resolvedCompressibleTypes();

/** True for the message types this process compresses. Base set ∪ `SP_WS_COMPRESS_EXTRA`. */
export function isCompressibleType(type) {
  return COMPRESSIBLE.has(type);
}

/** The resolved list, for logs and the read-only route (so "what is actually compressed" is observable). */
export function compressibleTypes() {
  return [...COMPRESSIBLE];
}
