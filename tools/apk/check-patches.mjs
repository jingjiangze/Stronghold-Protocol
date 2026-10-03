// check-patches.mjs — SEQUENTIAL SIMULATION of build-webroot's applyPatches(): replays
// every patch entry in the same order on an in-memory copy of the target tree, so
// "chain anchors" (a find that targets an earlier patch's replace output) verify exactly
// the way the real build applies them. Per-entry applicability mirrors the engine:
// minApp/maxApp (tree APP_VERSION), optional, shrink (first-line anchor), already-applied.
//
//   node tools/apk/check-patches.mjs [upstreamTree]
//
// Patch DEFINITIONS always come from the repo shipping this script; argv is the tree
// under test — an extracted upstream zip (public/ layout) or a built webroot (flat).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ownRepo = path.resolve(here, '..', '..');
const patchesDir = path.join(ownRepo, 'tools', 'apk', 'patches');
const repo = path.resolve(process.argv[2] || ownRepo);

/** Resolve a patch target across both layouts (upstream zip keeps files under public/). */
const layouts = (rel) => [path.join(repo, rel), path.join(repo, 'public', rel)];

function appVersionOf() {
  for (const base of [repo, path.join(repo, 'public')]) {
    try {
      const t = fs.readFileSync(path.join(base, 'shared', 'constants.js'), 'utf-8');
      const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(t) || /APP_VERSION\s*=\s*"([^"]+)"/.exec(t);
      if (m) return m[1];
    } catch { /* try next layout */ }
  }
  return null;
}

function cmpVer(a, b) {
  if (a == null) return 0;
  const A = String(a).split('.'), B = String(b).split('.');
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? '0', y = B[i] ?? '0';
    const nx = Number(x), ny = Number(y);
    const c = (Number.isFinite(nx) && Number.isFinite(ny)) ? Math.sign(nx - ny) : (x < y ? -1 : x > y ? 1 : 0);
    if (c) return c;
  }
  return 0;
}

if (!fs.existsSync(patchesDir)) { console.error(`no patches dir at ${patchesDir}`); process.exit(1); }
const files = fs.readdirSync(patchesDir).filter((n) => n.endsWith('.json')).sort();
if (!files.length) { console.error('no patch files'); process.exit(1); }

const app = appVersionOf();
console.log(`tree app version: ${app ?? 'unknown (conditions treat as matching)'}`);

// in-memory working set: resolvedPath → text (null = unresolved/missing)
const mem = new Map();
const resolveTarget = (rel) => {
  if (mem.has(rel)) return mem.get(rel);
  const hit = layouts(rel).find((t) => fs.existsSync(t)) || null;
  mem.set(rel, hit ? fs.readFileSync(hit, 'utf-8') : null);
  return mem.get(rel);
};

let ok = 0, skipped = 0, failed = 0;
for (const pf of files) {
  const spec = JSON.parse(fs.readFileSync(path.join(patchesDir, pf), 'utf-8'));
  for (const p of spec.patches || []) {
    const tag = `${pf} → ${p.file}`;
    if (p.minApp && cmpVer(app, p.minApp) < 0) { skipped++; console.log(`skip (app ${app} < minApp ${p.minApp}): ${tag}`); continue; }
    if (p.maxApp && cmpVer(app, p.maxApp) > 0) { skipped++; console.log(`skip (app ${app} > maxApp ${p.maxApp}): ${tag}`); continue; }
    const text = resolveTarget(p.file);
    if (text == null) { failed++; console.error(`ANCHOR FAIL (${pf}): target missing: ${p.file} (also public/${p.file})`); continue; }
    const writeBack = (newText) => mem.set(p.file, newText);
    if (text.includes(p.find)) { ok++; console.log(`ok: ${tag}`); writeBack(text.split(p.find).join(p.replace)); continue; }
    if (p.replace && text.includes(p.replace)) { skipped++; console.log(`already applied: ${tag}`); continue; }
    if (p.shrink) {
      const first = p.find.split('\n').find((l) => l.trim() !== '');
      if (first != null && text.includes(first)) {
        ok++; console.log(`ok (shrink-first-line): ${tag}`);
        const lines = text.split('\n');
        const at = lines.findIndex((l) => l.includes(first));
        lines.splice(at, 1, p.replace);
        writeBack(lines.join('\n'));
        continue;
      }
    }
    if (p.optional) { skipped++; console.log(`optional anchor absent: ${tag}`); continue; }
    failed++; console.error(`ANCHOR FAIL (${pf}): ${p.file} lacks ${JSON.stringify(String(p.find).slice(0, 90))}`);
  }
}
console.log(`\nanchors: ${ok} ok, ${skipped} skipped, ${failed} failed (${files.length} patch files; app=${app ?? '?'}; sequential simulation)`);
process.exit(failed ? 1 : 0);
