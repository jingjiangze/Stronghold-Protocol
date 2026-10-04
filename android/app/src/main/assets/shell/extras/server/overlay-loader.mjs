// overlay-loader.mjs — the shell's SERVER overlay loading point (v2.8.0).
//
// WHY: everything the shell ships today (extras, patches) is baked into the APK, so a new
// server-side capability always cost a full APK rebuild. Overlays are NEW FILES under
// server/overlay/ that ride the L1 content slim instead: the on-device hot update extracts
// server/overlay/**, and this loader picks them up on the next host start — no APK needed
// (device shell >= v2.8.0 carries the loading point).
//
// CONTRACT — server/overlay/*.mjs, applied in filename order:
//   export const overlayApi = 1;            // REQUIRED; a mismatch is skipped, never fatal
//   export const id = 'sp-xxx';             // optional name for logs / handshake
//   export async function install(ctx) {}   // optional; called once, after startServer()
// ctx = { api, id, server, port, host, url, upstreamDir, log }
//   server      — the object returned by the upstream startServer() (lobby, close(), …)
//   upstreamDir — directory of the running server/index.js
//
// ISOLATION: a missing directory, a broken module, a throwing install() — logged and skipped.
// The host must never fail to boot because of an overlay. The result is written into
// handshake.json by android-main.mjs ({ overlays: [...] }).
//
// RULES: overlays are strictly ADDITIVE (new files with their own routes/hooks). Editing
// upstream files stays in patches/; a capability must not be implemented in both places.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Bump only on a breaking contract change; the loader refuses anything else. */
export const OVERLAY_API = 1;

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'overlay');

/**
 * Loads every server/overlay/*.mjs next to this loader.
 * @param {object} ctx context handed to each install() (server, port, host, url, upstreamDir, log)
 * @returns {Promise<{loaded: string[], skipped: {name: string, reason: string}[]}>}
 */
export async function loadOverlays(ctx) {
  const input = ctx || {};
  const log = typeof input.log === 'function' ? input.log : (m) => console.log(m);
  const base = { ...input, api: OVERLAY_API, log };
  const loaded = [];
  const skipped = [];

  let names;
  try {
    names = fs.readdirSync(DIR).filter((n) => n.endsWith('.mjs')).sort();
  } catch {
    return { loaded, skipped }; // no overlay directory shipped: nothing to do
  }

  for (const name of names) {
    try {
      const mod = await import(pathToFileURL(path.join(DIR, name)).href);
      if (mod.overlayApi !== OVERLAY_API) {
        skipped.push({ name, reason: `overlayApi ${String(mod.overlayApi)} != ${OVERLAY_API}` });
        log(`[overlay] skip ${name}: overlayApi ${String(mod.overlayApi)} != ${OVERLAY_API}`);
        continue;
      }
      const id = typeof mod.id === 'string' && mod.id ? mod.id : name.replace(/\.mjs$/, '');
      if (typeof mod.install === 'function') await mod.install({ ...base, id });
      loaded.push(id);
      log(`[overlay] loaded ${id} (${name})`);
    } catch (e) {
      const reason = String((e && e.message) || e);
      skipped.push({ name, reason });
      log(`[overlay] ${name} failed: ${reason}`);
    }
  }
  return { loaded, skipped };
}
