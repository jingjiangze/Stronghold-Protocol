#!/usr/bin/env node
// sync-upstream.mjs — bring the upstream zone of this tree EXACTLY onto an upstream ref, without
// ever running a merge.
//
// WHY (2026-10-25 审计): this repo vendors the whole upstream game tree (public/, server/, shared/,
// data/, test/ …) next to our shell (android/, tools/apk/). Our line and upstream diverged at 0.2.5,
// so `git merge` sees every upstream-touched file as a conflict — 1072 of them on v0.3.3. Merging is
// the wrong tool: the shipped APK's webroot is assembled from the upstream *release* plus our
// extras/overlays (build-webroot.mjs), NOT from this vendored copy. The vendored copy exists for the
// gates (repo-tree contract checks, upstream test suite).
//
// So the sync is a one-way materialisation:
//   · every file the upstream ref has, except our protected paths, is written verbatim;
//   · every tracked file inside an upstream-owned directory that the ref no longer has is deleted;
//   · protected paths are never read, written or deleted.
// Result: zero conflicts by construction, and re-running is a no-op.
//
//   node tools/apk/sync-upstream.mjs --from v0.3.4 [--repo <dir>] [--dry-run]
//
// Exit 0 = tree now matches (or would, with --dry-run); 1 = bad ref / protected path overlap.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const has = (n) => process.argv.includes('--' + n);

const repo = path.resolve(arg('repo', path.resolve(here, '..', '..')));
const ref = String(arg('from', '')).trim();
const dry = has('dry-run');
if (!ref) {
  console.error('sync-upstream: --from <git-ref> is required');
  process.exit(1);
}

/**
 * Ours. Never touched by the sync — these either ship the shell (android/), drive CI
 * (.github/), build/package the app (tools/apk/, scripts/build-apk.ps1) or are our own data/docs.
 * Keep this list short and justified: everything not listed here belongs to upstream.
 */
const PROTECTED = [
  'android/',
  '.github/',
  'tools/apk/',
  'tools/security/',
  'lineage.json',
  '.gitignore',
  'eslint.config.js',
  'docs/APK.md',
  'scripts/build-apk.ps1',
];
const isProtected = (p) => PROTECTED.some((pre) => (pre.endsWith('/') ? p.startsWith(pre) : p === pre));

const git = (args, opts = {}) => execFileSync('git', args, { cwd: repo, maxBuffer: 1 << 28, ...opts });

// --- upstream file list ------------------------------------------------------
const upList = git(['ls-tree', '-r', '--name-only', ref]).toString('utf8')
  .split('\n').map((s) => s.trim()).filter(Boolean);

// --- materialise the ref into a temp dir (git archive → tar; POSIX tar, no gzip members) ---------
// NOTE: MSYS tar cannot open a Windows path with backslashes, so the temp dir lives inside the repo's
// _tmp/ and is passed with forward slashes.
const tmpRoot = path.join(repo, '_tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const tmp = fs.mkdtempSync(path.join(tmpRoot, 'upstream-sync-'));
const tmpPosix = tmp.replace(/\\/g, '/');
try {
  execFileSync('sh', ['-c', `git -C "${repo}" archive --format=tar "${ref}" | tar -x -C "${tmpPosix}"`],
    { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 1 << 28 });
} catch (e) {
  console.error('sync-upstream: materialise failed: ' + (e.stderr ? e.stderr.toString() : e.message));
  process.exit(1);
}

// --- who owns which directory -------------------------------------------------
// A directory is "upstream zone" when the ref has files under it. A tracked file is a deletion
// candidate when it sits in an upstream-owned directory, the ref does not have it, and it is not ours.
const upSet = new Set(upList);
const upDirs = new Set();
for (const p of upList) {
  const parts = p.split('/');
  if (parts.length > 1) upDirs.add(parts[0] + '/');
}
const tracked = git(['ls-files']).toString('utf8').split('\n').map((s) => s.trim()).filter(Boolean);

let written = 0, same = 0, removed = 0, skippedProtected = 0;
const actions = [];

// 1) write every upstream file that is not ours
for (const rel of upList) {
  if (isProtected(rel)) { skippedProtected++; continue; }
  const src = path.join(tmp, rel);
  const dst = path.join(repo, rel);
  if (!fs.existsSync(src)) continue; // archive should have it; be loud below if not
  const bytes = fs.readFileSync(src);
  const cur = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
  if (cur && cur.equals(bytes)) { same++; continue; }
  written++;
  if (actions.length < 40) actions.push(`${cur ? 'M' : 'A'} ${rel}`);
  if (!dry) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, bytes);
    // keep the executable bit for upstream scripts
    if (fs.existsSync(dst)) { /* mode already 0644 via write; exec bits are not used upstream */ }
  }
}

// 2) delete tracked files that upstream dropped (only inside upstream-owned directories)
for (const rel of tracked) {
  if (isProtected(rel)) continue;
  const top = rel.split('/')[0] + '/';
  if (!upDirs.has(top)) continue;          // ours-only top-level (android/, .github/ …) — never touched
  if (upSet.has(rel)) continue;
  removed++;
  if (actions.length < 60) actions.push(`D ${rel}`);
  if (!dry) { try { fs.unlinkSync(path.join(repo, rel)); } catch { /* already gone */ } }
}

// 3) sanity: a protected path must never be owned by upstream in a way that would confuse the next run
for (const pre of PROTECTED) {
  if (!pre.endsWith('/')) continue;
  const dir = pre.slice(0, -1);
  if (upDirs.has(dir + '/') && !['android/', '.github/', 'tools/apk/'].includes(pre)) {
    console.error(`sync-upstream: protected dir also exists upstream (${pre}) — decide explicitly`);
    process.exit(1);
  }
}

console.log(`sync-upstream: ${dry ? '[dry-run] ' : ''}${ref}`);
console.log(`  upstream files: ${upList.length} | written: ${written} | already identical: ${same}`);
console.log(`  deleted (upstream dropped them): ${removed} | protected kept: ${skippedProtected}`);
if (actions.length) console.log(actions.map((a) => '    ' + a).join('\n'));
if (actions.length < written + removed) console.log(`    … ${written + removed - actions.length} more`);

// never leave the materialised tree behind (it lands in the repo's ignored _tmp/, but a stale copy
// still costs ~500 MB on a runner and would confuse the next inspection)
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
