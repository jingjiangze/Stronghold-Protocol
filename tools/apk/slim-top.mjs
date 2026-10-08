// slim-top.mjs — the single source of truth for the L1 (slim) top-level set.
//
// WHY THIS EXISTS (审计-上游冲突面-2026-10-08.md §6.2 / R-04):
// the on-device hot update replaces the WHOLE webroot tree with the slim bundle (Updater.java: the
// staging dir is renamed over the live tree). So any top-level entry the slim omits is permanently
// lost on the device after one hot update. A hand-maintained whitelist silently dropped upstream's
// `i18n/` (translations 404 after a hot update) and would drop any future top-level dir
// (`wasm/`, `workers/`, `packs/` …) with no gate noticing.
//
// The set is therefore DERIVED from the tree: everything at the top level except the two content
// exclusions and the build artifacts. build-webroot (stamp + slim-manifest), make-bundle (the zip)
// and verify-slim (the mapping) all use this module, so the three copies can never drift again.
//
// The device-side mirror is android/.../SlimPaths.java — since 2026-10-08 it is a DENY-list too:
// it carries the same three arrays (SLIM_EXCLUDE_DIRS / SLIM_EXCLUDE_FILES / ROOT_ANCHORS) and the
// same wrapper rule (one folder peeled only when the peeled path is root-shaped), so a new upstream
// top-level dir rides both sides and can no longer be dropped by the whole-tree hot update swap.
// verify-slim.mjs parses those arrays and warns loudly when they drift from this module's exports.
import fs from 'node:fs';
import path from 'node:path';

/** Content never carried by the slim: dev tooling and the L2 art tree (CDN / APK-local only). */
export const SLIM_EXCLUDE_DIRS = ['dev', 'assets'];

/** Build artifacts the slim must never carry (they are produced per build, and a self-referential
 *  stamp.txt would make the content stamp change on every run). */
export const SLIM_EXCLUDE_FILES = ['stamp.txt', 'slim-manifest.txt'];

/** Paths that only ever exist at the ROOT of a slim tree — used to tell a wrapper folder from a
 *  genuine (possibly new) top-level directory without a whitelist. */
export const ROOT_ANCHORS = ['index.html', 'js/', 'server/', 'shared/', 'data/', 'css/', 'vendor/', 'fonts/', 'data.js', 'package.json'];

/** True when a slim-relative path is excluded from the L1 set (public/ folding applied by caller). */
export function isSlimExcluded(rel) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!p) return true;
  const top = p.split('/')[0];
  if (SLIM_EXCLUDE_DIRS.includes(top)) return true;
  if (p.indexOf('/') < 0 && SLIM_EXCLUDE_FILES.includes(p)) return true;
  return false;
}

/** Top-level entries of `dir` that belong to the L1 slim, sorted. */
export function deriveSlimTop(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = names.filter((n) => !isSlimExcluded(n));
  out.sort();
  return out;
}

/** Top-level entries of an upstream `public/` dir that ride the slim (audit R-04 assertion). */
export function slimTopOfPublic(publicDir) {
  return deriveSlimTop(publicDir);
}

/** Excluded top-level entries present under `dir` (diagnostics). */
export function excludedTop(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => isSlimExcluded(n)).sort();
}

/** Top-level entries in `tops` that a device-side allow-list `accepted` would DROP during extraction
 *  (审计 R-04). Legacy instrumentation: the device side is a deny-list now (SlimPaths.java, kept in
 *  parity by verify-slim.mjs), so the gate no longer calls this — it stays exported (and tested) so
 *  any future allow-list proposal can be measured against it. */
export function deviceDroppedTop(tops, accepted) {
  const list = Array.isArray(accepted) ? accepted : [];
  return tops.filter((t) => !list.some((a) => t === a || t.startsWith(`${a}/`)));
}

/** Resolve a top-level name to its absolute path under `dir` (helper for callers/tests). */
export function slimEntryPath(dir, name) {
  return path.join(dir, name);
}
