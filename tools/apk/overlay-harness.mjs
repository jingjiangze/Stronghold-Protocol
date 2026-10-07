// tools/apk/overlay-harness.mjs — materialise the RUNTIME layout the shell uses on device, so the overlay
// modules can be imported and exercised by tests without copying the whole tree.
//
// On device the webroot holds the upstream tree (server/, shared/, data/, public/) and the shell extras are
// materialised INTO it (assets/shell/extras/** → webroot/**), which is why server/combat/*.mjs and
// server/overlay/*.mjs can use plain relative imports of upstream modules. Reproduce exactly that:
//
//   <tmp>/server/<upstream entries>   (junctions for directories, copies for files)
//   <tmp>/server/combat, /overlay     (copied from android/.../shell/extras/server/)
//   <tmp>/{shared,data,public}        (junctions)
//
// Nothing here writes into the repository: junctions point at the repo read-only and the extras copies are
// throwaway. Call materialize() once per test file and import through url(root, rel).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTRAS = path.join(REPO, 'android', 'app', 'src', 'main', 'assets', 'shell', 'extras', 'server');
const SHARED_DIRS = ['shared', 'data', 'public'];

/** @returns {string} the temporary webroot */
export function materialize() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-overlay-'));
  // The webroot is served by the shell with the repo's own package.json ("type": "module"); without it Node
  // would read the copied upstream .js files as CommonJS.
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sp-overlay-harness', private: true, type: 'module' }, null, 2));
  fs.mkdirSync(path.join(root, 'server'));
  for (const entry of fs.readdirSync(path.join(REPO, 'server'))) {
    const src = path.join(REPO, 'server', entry);
    const dst = path.join(root, 'server', entry);
    if (fs.statSync(src).isDirectory()) fs.symlinkSync(src, dst, 'junction');
    else fs.copyFileSync(src, dst);
  }
  for (const dir of SHARED_DIRS) {
    const src = path.join(REPO, dir);
    if (fs.existsSync(src)) fs.symlinkSync(src, path.join(root, dir), 'junction');
  }
  for (const entry of fs.readdirSync(EXTRAS)) {
    const src = path.join(EXTRAS, entry);
    const dst = path.join(root, 'server', entry);
    if (fs.existsSync(dst)) continue; // never shadow an upstream entry
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
    else fs.copyFileSync(src, dst);
  }
  return root;
}

/** Import a module from the materialised tree (e.g. url(root, 'server/combat/pool.mjs')). */
export const url = (root, rel) => pathToFileURL(path.join(root, rel)).href;

/** Remove a materialised tree. */
export function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}
