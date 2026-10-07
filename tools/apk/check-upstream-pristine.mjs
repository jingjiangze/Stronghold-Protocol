// tools/apk/check-upstream-pristine.mjs — the zero-conflict gate.
//
// The fork's rule: upstream game code (server/, public/, shared/, data/, test/, docs/, tools/*.mjs …) is
// NEVER edited in-tree. Everything of ours lives in paths upstream does not own (tools/, android/,
// .github/, docs/APK.md, lineage.json) or in NEW files that upstream never had.
//
// Why it matters: `git merge upstream/master` only conflicts on files BOTH sides changed. Editing an upstream
// file re-introduces exactly that conflict; adding a new file (server/overlay/*, android/**, tools/**) cannot
// conflict at all. The shell's server overlay (android/.../extras/server/overlay/*.mjs) is the sanctioned way
// to change server behaviour without touching upstream.
//
//   MODIFIED / DELETED / RENAMED upstream files → FAIL (unless the path is on the control-plane allowlist)
//   ADDED files (upstream never had them)       → allowed, reported for review
//
// Usage: node tools/apk/check-upstream-pristine.mjs [upstream-ref]   (default: upstream/master)
import { execFileSync } from 'node:child_process';

const REF = process.argv[2] || 'upstream/master';

/** Paths the fork owns outright. Anything here may be modified; everything else upstream owns. */
const CONTROL_PLANE = [
  /^tools\//,
  /^android\//,
  /^\.github\//,
  /^scripts\//,
  /^docs\/APK\.md$/,
  /^lineage\.json$/,
  /^AUDIT-MIRROR\.json$/,
  /^SYNC-CONFLICTS\.md$/,
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

let base;
let exact = false;
try {
  // When the ref is already contained in HEAD (the sync case: we just merged it) the diff against it is
  // exactly "what our side adds on top of upstream" — no upstream commits leak in.
  execFileSync('git', ['merge-base', '--is-ancestor', REF, 'HEAD'], { stdio: 'ignore' });
  base = git(['rev-parse', REF]);
  exact = true;
} catch {
  // Upstream has moved ahead of us: fall back to the common ancestor and say so, because the diff then also
  // carries upstream's own new commits (their modifications would look like ours).
  try {
    base = git(['merge-base', REF, 'HEAD']);
  } catch (e) {
    console.error(`[pristine] cannot resolve ${REF}: ${e.message}`);
    process.exit(2);
  }
  console.warn(`[pristine] ${REF} is not contained in HEAD — comparing against the merge base instead;`);
  console.warn('[pristine] upstream commits newer than that base appear here as their own changes.');
}

// Three-dot: the diff the merge WOULD bring, i.e. what our side changed relative to the common ancestor.
const rows = git(['diff', '--name-status', `${base}`, 'HEAD']).split('\n').filter(Boolean);
const owned = [];
const added = [];
const violations = [];

for (const row of rows) {
  const [status, ...paths] = row.split('\t');
  const kind = status[0]; // A(dded) M(odified) D(eleted) R(enamed) C(opied) T(ype)
  if (kind === 'A') { added.push(paths[0]); continue; }
  for (const p of paths) {
    if (CONTROL_PLANE.some((re) => re.test(p))) owned.push(`${kind} ${p}`);
    else violations.push(`${kind} ${p}`);
  }
}

console.log(`[pristine] base ${base.slice(0, 8)} (${REF}${exact ? ', contained in HEAD' : ', merge base'}), control-plane ${owned.length}, added ${added.length}`);
if (added.length) {
  console.log('[pristine] new files (cannot conflict with upstream):');
  for (const p of added.slice(0, 40)) console.log(`  + ${p}`);
  if (added.length > 40) console.log(`  … ${added.length - 40} more`);
}

if (violations.length) {
  console.error('\n[pristine] FAIL — upstream-owned files were changed:');
  for (const v of violations) console.error(`  ! ${v}`);
  console.error('\nMove the change into the shell overlay (android/app/src/main/assets/shell/extras/server/overlay/)');
  console.error('or into new files; keep upstream server/, public/, shared/, data/, test/ byte-identical.');
  process.exit(1);
}
console.log('[pristine] OK — no upstream-owned file changed');
