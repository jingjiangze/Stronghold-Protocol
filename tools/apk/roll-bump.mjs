#!/usr/bin/env node
// roll-bump.mjs — one upstream-roll's version bump, as a pure function over the tree.
//
// WHY: an automated upstream roll (`.github/workflows/sync-re-upstream.yml`) must, after a clean
// merge, move every version pin forward in lock-step:
//   · android/app/build.gradle  versionCode +1, versionName = upstream, EMBEDDED_APP_VERSION same
//   · lineage.json              upstreamTag + upstream commit
//   · tools/apk/shell-ui-version.txt  +1 (the hot-update overlay counter)
//   · lineage.json hotTag       next shell-vX.Y.Z (the content tag devices compare)
// Doing it in one script (instead of five `sed`s in YAML) makes it testable: see
// tools/apk/roll-bump.test.mjs, which runs this against a fixture tree.
//
//   node tools/apk/roll-bump.mjs --tag v0.3.4 [--sha <upstream commit>] [--repo <dir>] [--dry-run]
//
// Exit codes: 0 bumped (or would bump, --dry-run), 1 bad input / missing anchors.
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

const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const write = (rel, text) => { if (!dry) fs.writeFileSync(path.join(repo, rel), text); };

const changes = [];
function mustReplace(rel, re, to, label) {
  const before = read(rel);
  if (!re.test(before)) throw new Error(`roll-bump: anchor missing in ${rel} (${label})`);
  const after = before.replace(re, to);
  if (after === before) throw new Error(`roll-bump: ${rel} unchanged after ${label}`);
  write(rel, after);
  changes.push(`${rel}: ${label}`);
}

// 1) build.gradle — versionCode +1, versionName / EMBEDDED_APP_VERSION = upstream
{
  const gradle = read('android/app/build.gradle');
  const m = /versionCode\s+(\d+)/.exec(gradle);
  if (!m) throw new Error('roll-bump: versionCode not found in build.gradle');
  const next = Number(m[1]) + 1;
  mustReplace('android/app/build.gradle', /versionCode\s+\d+/, `versionCode ${next}`, `versionCode ${m[1]} -> ${next}`);
  mustReplace('android/app/build.gradle', /versionName\s+'[^']+'/, `versionName '${version}'`, `versionName -> ${version}`);
  mustReplace('android/app/build.gradle', /EMBEDDED_APP_VERSION',\s*'"[^"]+"'/,
    `EMBEDDED_APP_VERSION', "${version}"'`, `EMBEDDED_APP_VERSION -> ${version}`);
}

// 2) lineage.json — upstream tag (+ commit when known)
{
  const lin = JSON.parse(read('lineage.json'));
  lin.upstreamTag = tag;
  if (sha) lin.upstream = sha;
  lin.updatedAt = new Date().toISOString();
  write('lineage.json', JSON.stringify(lin, null, 2) + '\n');
  changes.push(`lineage.json: upstreamTag -> ${tag}${sha ? ', upstream -> ' + sha.slice(0, 10) : ''}`);
}

// 3) shell-ui-version.txt — the hot-update overlay counter
{
  const cur = read('tools/apk/shell-ui-version.txt').trim();
  const n = Number(cur);
  if (!Number.isFinite(n)) throw new Error(`roll-bump: shell-ui-version.txt is not a number ("${cur}")`);
  write('tools/apk/shell-ui-version.txt', String(n + 1) + '\n');
  changes.push(`tools/apk/shell-ui-version.txt: ${n} -> ${n + 1}`);
}

// 4) lineage.json hotTag — next content tag. Devices compare the FIRST d.d.d inside the tag
//    (Updater.parseTag) and prefer a higher epoch, so the counter must keep our own 3.x.y line
//    monotonic; the upstream number (0.x.y) must never be used here.
{
  const lin = JSON.parse(read('lineage.json'));
  const cur = String(lin.hotTag || '').trim();
  const m = /^shell-v(\d+)\.(\d+)\.(\d+)$/.exec(cur);
  if (!m) {
    // No counter yet: seed it above every tag shipped so far (shell-v3.9.x line).
    lin.hotTag = 'shell-v3.9.2';
  } else {
    lin.hotTag = `shell-v${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  }
  write('lineage.json', JSON.stringify(lin, null, 2) + '\n');
  changes.push(`lineage.json: hotTag ${cur || '(none)'} -> ${lin.hotTag}`);
}

console.log(`roll-bump: ${dry ? '[dry-run] ' : ''}upstream ${tag}${sha ? ' @ ' + sha.slice(0, 10) : ''}`);
for (const c of changes) console.log('  ' + c);
