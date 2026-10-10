/* webgl-caveat-fix.js -- stop the "major performance caveat" flag from deleting the 3D board.
 *
 * WHY (field report 2026-10-10): the board AND every operator model disappeared on a device, with no
 * console error to act on. Root cause: upstream `public/js/render/board3d/load.js` asks for its WebGL2
 * context with `{ failIfMajorPerformanceCaveat: true }` -- and that is its ONLY probe. The flag answers
 * a QUALITY question ("is this GPU software-rendered / blocklisted, so the 3D board would be slow?")
 * but it was being used as the AVAILABILITY answer, so a caveated GPU got `null` and the whole 3D board
 * was switched off. The operators are drawn by that board (render/board3d/load.js loadBoardPack), which
 * is why losing the board loses the models too -- silently, because the caller just falls back.
 *
 * WHAT THIS DOES: drops that one attribute from `getContext('webgl2', {...})` before upstream sees it.
 * Nothing else is touched -- not webgl1, not other attributes, not any other canvas API. A slow GPU is
 * a quality problem; a missing board is a broken game, and this makes the choice fall on the side that
 * keeps the game playable.
 *
 * WHY AN OVERLAY AND NOT A ONE-LINE EDIT in load.js: `tools/apk/patches/README.md` is explicit -- the
 * patch set is deliberately empty because text patches into upstream files drift (35 of them broke 48
 * anchors across 0.2.0/0.2.1). Runtime fixes live here, ride the same hot-updatable tree as every other
 * overlay, and can be removed without touching upstream.
 *
 * Idempotent (window.__SP_WEBGL_CAVEAT), never throws, and a missing/broken patch degrades to exactly
 * upstream behaviour. Loaded from /__sp/ only: the shell's own prefix, never the network.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof HTMLCanvasElement === 'undefined') return;
  if (window.__SP_WEBGL_CAVEAT) return;

  var proto = HTMLCanvasElement.prototype;
  var original = proto.getContext;
  if (typeof original !== 'function') return;

  function patched(type, attrs) {
    // Only the exact case that hurts: WebGL2 (three r163+ needs it) plus that one attribute.
    if (type === 'webgl2' && attrs && typeof attrs === 'object' && attrs.failIfMajorPerformanceCaveat) {
      var clean = {};
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k) && k !== 'failIfMajorPerformanceCaveat') clean[k] = attrs[k];
      }
      return original.call(this, type, clean);
    }
    return original.call(this, type, attrs);
  }

  try {
    proto.getContext = patched;
    // Marker for the page/diagnosis: this build drops the caveat flag on purpose.
    window.__SP_WEBGL_CAVEAT = { patched: true, reason: 'a caveated GPU must not lose the 3D board (and with it every operator model)' };
  } catch (e) {
    // A frozen prototype means we could not install the fix; upstream behaviour stands, which is
    // exactly what would have happened without this file.
  }
})();
