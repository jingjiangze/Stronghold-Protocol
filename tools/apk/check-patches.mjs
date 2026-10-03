// check-patches.mjs — apply every tools/apk/patches/settings-v*.json against a checkout
// WITHOUT touching files: for each {file, find, replace} entry, verify the anchor `find`
// is present in the target (or already applied, i.e. `replace` is present). Mirrors the
// exact assertions build-webroot.mjs performs at build time, so CI here fails on the
// same upstream drift that would break the next APK build.
//
//   node tools/apk/check-patches.mjs [repoRoot]   (default: repo root of this script)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(process.argv[2] || path.resolve(here, '..', '..'));
const patchesDir = path.join(repo, 'tools', 'apk', 'patches');

if (!fs.existsSync(patchesDir)) {
  console.error(`no patches dir at ${patchesDir}`);
  process.exit(1);
}
const files = fs.readdirSync(patchesDir).filter((n) => n.endsWith('.json')).sort();
if (!files.length) { console.error('no patch files'); process.exit(1); }

let ok = 0, skipped = 0, failed = 0;
for (const pf of files) {
  const spec = JSON.parse(fs.readFileSync(path.join(patchesDir, pf), 'utf-8'));
  for (const p of spec.patches || []) {
    const target = path.join(repo, p.file);
    if (!fs.existsSync(target)) {
      console.error(`ANCHOR FAIL (${pf}): target missing: ${p.file}`);
      failed++;
      continue;
    }
    const text = fs.readFileSync(target, 'utf-8');
    if (text.includes(p.find)) { ok++; console.log(`ok: ${p.file} ← ${pf}`); continue; }
    if (p.replace && text.includes(p.replace)) { skipped++; console.log(`already applied: ${p.file} ← ${pf}`); continue; }
    console.error(`ANCHOR FAIL (${pf}): ${p.file} lacks ${JSON.stringify(String(p.find).slice(0, 90))}`);
    failed++;
  }
}
console.log(`\nanchors: ${ok} ok, ${skipped} already-applied, ${failed} failed (${files.length} patch files)`);
process.exit(failed ? 1 : 0);
