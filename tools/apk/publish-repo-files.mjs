#!/usr/bin/env node
// publish-repo-files.mjs — PUT working-tree files onto the fork's apk branch via the GitHub
// Contents API. The fork's history is API-driven by design (no local commit/push), so this is
// the safe path for batch file updates.
//
//   node tools/apk/publish-repo-files.mjs <path...|path=source...> [--message "..."]
//
// Every file is normalised to LF before upload: .gitattributes declares `* text=auto` with
// eol=lf for js/mjs/json/md, but earlier ad-hoc API publishes pushed CRLF blobs verbatim —
// normalising here stops that drift instead of adding to it.
//
// Auth: GH_TOKEN or GITHUB_TOKEN must be set (never written to disk).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const OWNER = 'jingjiangze';
const NAME = 'Stronghold-Protocol';
const BRANCH = 'apk';

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GH_TOKEN (or GITHUB_TOKEN) is required');
  process.exit(1);
}

const args = process.argv.slice(2);
const msgAt = args.indexOf('--message');
const message = msgAt >= 0 ? args[msgAt + 1] : 'shell: batch publish';
const entries = args
  .filter((a, i) => !a.startsWith('--') && i !== msgAt + 1)
  .map((a) => {
    const eq = a.indexOf('=');
    // path=source lets one target take its content from another file (e.g. an upstream blob
    // extracted with `git show <rev>:<path> > tmp`), instead of rewriting the working tree.
    return eq < 0 ? { target: a, source: a } : { target: a.slice(0, eq), source: a.slice(eq + 1) };
  });
if (!entries.length) {
  console.error('usage: node tools/apk/publish-repo-files.mjs <path...> [--message "..."]');
  process.exit(1);
}

const api = (p, init) =>
  fetch(`https://api.github.com/repos/${OWNER}/${NAME}/${p}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'stronghold-publish',
    },
  });

let failed = 0;
for (const { target, source } of entries) {
  const abs = path.isAbsolute(source) ? source : path.join(repo, source);
  if (!fs.existsSync(abs)) {
    console.error(`skip (no such file): ${source}`);
    failed++;
    continue;
  }
  const text = fs.readFileSync(abs, 'utf-8').replace(/\r\n/g, '\n');
  const content = Buffer.from(text, 'utf-8').toString('base64');

  const cur = await api(`contents/${target}?ref=${BRANCH}`);
  let sha;
  if (cur.status === 200) sha = (await cur.json()).sha;
  else if (cur.status !== 404) {
    console.error(`FAIL (lookup ${cur.status}): ${target}`);
    failed++;
    continue;
  }

  const put = await api(`contents/${target}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content, sha, branch: BRANCH }),
  });
  if (put.ok) {
    const j = await put.json();
    console.log(`ok: ${target} → ${j.commit.sha.slice(0, 8)}`);
  } else {
    console.error(`FAIL (${put.status}): ${target}: ${(await put.text()).slice(0, 200)}`);
    failed++;
  }
}
console.log(`\npublished ${entries.length - failed}/${entries.length} files (branch ${BRANCH}, LF-normalised)`);
process.exit(failed ? 1 : 0);
