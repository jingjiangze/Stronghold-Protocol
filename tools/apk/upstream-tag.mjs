#!/usr/bin/env node
// upstream-tag.mjs — the ONE place the build line reads "which upstream tag are we on".
//
// WHY (2026-10-25 自动化审计): the tag used to live as a literal fallback inside
// .github/workflows/{apk-re,hotupdate}.yml (`inputs.upstream_tag || 'v0.3.3'`). An automated
// upstream-roll cannot rewrite those files: a GITHUB_TOKEN push that touches .github/workflows
// is refused ("refusing to allow a GitHub App to create or update workflow"), which is exactly
// the failure mode sync-re-upstream.yml's R-08 step works around. Moving the pin to lineage.json
// (a plain data file) lets the roll bump it and push with the normal token.
//
//   node tools/apk/upstream-tag.mjs              # prints lineage.json's upstreamTag
//   node tools/apk/upstream-tag.mjs ""           # same (empty override = use lineage)
//   node tools/apk/upstream-tag.mjs v0.3.4       # prints v0.3.4 (explicit override wins)
//
// Exit 1 when neither an override nor a well-formed lineage tag exists — the build must never
// silently fall back to a hard-coded number that has drifted from the tree it is building.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const override = (process.argv[2] || '').trim();
if (override) {
  if (!/^v?\d+\.\d+\.\d+$/.test(override)) {
    console.error(`upstream-tag: "${override}" is not a vX.Y.Z tag`);
    process.exit(1);
  }
  console.log(override.startsWith('v') ? override : 'v' + override);
  process.exit(0);
}

let tag = '';
try {
  const lin = JSON.parse(fs.readFileSync(path.join(repo, 'lineage.json'), 'utf8'));
  tag = String(lin.upstreamTag || '').trim();
} catch (e) {
  console.error(`upstream-tag: cannot read lineage.json (${e.message})`);
  process.exit(1);
}
if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error(`upstream-tag: lineage.json upstreamTag is not vX.Y.Z (got "${tag}")`);
  process.exit(1);
}
console.log(tag);
