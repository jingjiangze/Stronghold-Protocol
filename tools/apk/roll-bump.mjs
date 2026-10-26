#!/usr/bin/env node
// roll-bump.mjs — one upstream-roll's version bump, as a pure function over the tree.
//
// WHY: an automated upstream roll (`.github/workflows/sync-re-upstream.yml`) must, after the
// materialise step, move every version pin forward in lock-step:
//   · android/app/build.gradle  versionCode +1, versionName = upstream, EMBEDDED_APP_VERSION same
//   · lineage.json              upstreamTag + upstream commit + hotTag (the content tag devices compare)
//   · tools/apk/shell-ui-version.txt  +1 (the hot-update overlay counter)
// Doing it in one script (instead of five `sed`s in YAML) makes it testable.
//
// IDEMPOTENT (2026-10-26 fix): the workflow's `force` input re-runs a roll whose build/publish
// failed. On that second run lineage.upstreamTag already equals the tag, and versionName is already
// the upstream number — bumping again would ship a phantom versionCode. So:
//   · lineage is already on this tag → only *assert* the pins agree (never bump twice);
//   · otherwise            → bump versionCode/shell-ui/hotTag once and write the pins.
//
//   node tools/apk/roll-bump.mjs --tag v0.3.4 [--sha <upstream commit>] [--repo <dir>] [--dry-run]
//
// Exit codes: 0 bumped (or already at the target), 1 bad input / missing anchors.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes('--' + name);

const repo = path.resolve(arg('repo', path.resolve(here, '..', '..')));
const tag = String(arg('tag', '')).trim();
const sha = String(arg('sha', '')).trim();
const dry = has('dry-run');

if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error(`roll-bump: --tag must be vX.Y.Z (got "${tag}")`);
  process.exit(1);
}
const version = tag.replace(/^v/, '');

const R_GRADLE = 'android/app/build.gradle';
const R_LINEAGE = 'lineage.json';
const R_SHELLUI = 'tools/apk/shell-ui-version.txt';

const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const write = (rel, text) => { if (!dry) fs.writeFileSync(path.join(repo, rel), text); };
const changes = [];

/** Replace `re` with `to`; a no-op is only OK when `okWhen` says the file already carries the target. */
function sub(rel, re, to, label, okWhen) {
  const before = read(rel);
  if (!re.test(before)) throw new Error(`roll-bump: anchor missing in ${rel} (${label})`);
  const after = before.replace(re, to);
  if (after === before) {
    if (okWhen && okWhen.test(before)) { changes.push(`${rel}: ${label} (already)`); return; }
    throw new Error(`roll-bump: ${rel} unchanged after ${label}`);
  }
  write(rel, after);
  changes.push(`${rel}: ${label}`);
}

const lin = JSON.parse(read(R_LINEAGE));
const already = String(lin.upstreamTag || '').trim() === tag;

if (!already) {
  // --- versionCode +1 (strictly increasing; the release tag derives from it) ---
  const gradle = read(R_GRADLE);
  const m = /versionCode\s+(\d+)/.exec(gradle);
  if (!m) throw new Error('roll-bump: versionCode not found in build.gradle');
  const next = Number(m[1]) + 1;
  sub(R_GRADLE, /versionCode\s+\d+/, `versionCode ${next}`, `versionCode ${m[1]} -> ${next}`);

  // --- the hot-update overlay counter ---
  const cur = read(R_SHELLUI).trim();
  const n = Number(cur);
  if (!Number.isFinite(n)) throw new Error(`roll-bump: shell-ui-version.txt is not a number ("${cur}")`);
  write(R_SHELLUI, String(n + 1) + '\n');
  changes.push(`${R_SHELLUI}: ${n} -> ${n + 1}`);

  // --- lineage: upstream tag/commit + the next content tag ---
  // Devices compare the FIRST d.d.d inside the tag (Updater.parseTag) and prefer a higher epoch, so
  // the content counter keeps OUR shell-v3.x.y line monotonic; the upstream 0.x.y must never be used.
  const hot = String(lin.hotTag || '').trim();
  const hm = /^shell-v(\d+)\.(\d+)\.(\d+)$/.exec(hot);
  lin.hotTag = hm ? `shell-v${hm[1]}.${hm[2]}.${Number(hm[3]) + 1}` : 'shell-v3.9.2';
  lin.upstreamTag = tag;
  if (sha) lin.upstream = sha;
  lin.updatedAt = new Date().toISOString();
  write(R_LINEAGE, JSON.stringify(lin, null, 2) + '\n');
  changes.push(`${R_LINEAGE}: upstreamTag -> ${tag}${sha ? ', upstream -> ' + sha.slice(0, 10) : ''}, hotTag ${hot || '(none)'} -> ${lin.hotTag}`);
}

// --- versionName / EMBEDDED_APP_VERSION must equal the upstream number in both modes ---
sub(R_GRADLE, /versionName\s+'[^']+'/, `versionName '${version}'`, `versionName -> ${version}`,
  new RegExp(`versionName\\s+'${version.replace(/\./g, '\\.')}'`));
sub(R_GRADLE, /EMBEDDED_APP_VERSION',\s*'"[^"]+"'/, `EMBEDDED_APP_VERSION', '"${version}"'`,
  `EMBEDDED_APP_VERSION -> ${version}`,
  new RegExp(`EMBEDDED_APP_VERSION',\\s*'"${version.replace(/\./g, '\\.')}"'`));
if (already && sha) {
  lin.upstream = sha;
  lin.updatedAt = new Date().toISOString();
  write(R_LINEAGE, JSON.stringify(lin, null, 2) + '\n');
  changes.push(`${R_LINEAGE}: upstream -> ${sha.slice(0, 10)} (re-asserted)`);
}

console.log(`roll-bump: ${dry ? '[dry-run] ' : ''}upstream ${tag}${sha ? ' @ ' + sha.slice(0, 10) : ''}${already ? ' (already on this tag — no counter bump)' : ''}`);
for (const c of changes) console.log('  ' + c);
