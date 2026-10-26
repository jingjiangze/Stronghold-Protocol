// sync-upstream.test.mjs — the upstream roll must be a *materialisation*, never a merge.
//
// WHY (2026-10-25): our line and upstream diverged at 0.2.5 while the repo vendors the whole
// upstream tree, so `git merge` reported 1072 conflicts on v0.3.3. The roll now copies the upstream
// ref's files over the upstream zone and deletes files upstream dropped, leaving our protected
// paths (android/, .github/, tools/apk/, lineage.json …) untouched. These three properties are what
// make "next update is conflict-free" true, so they are pinned here instead of trusted.
//
//   node --test tools/apk/sync-upstream.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'sync-upstream.mjs');

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-sync-'));
  // The developer machine may sign commits *and tags* by default (this one does); a fixture must not
  // depend on a reachable signing agent.
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).toString();
  git('init', '-q');
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const del = (rel) => { try { fs.unlinkSync(path.join(dir, rel)); } catch { /* ignore */ } };
  return { dir, git, w, del };
}

test('upstream zone is materialised, our protected paths survive, dropped files go', () => {
  const r = mkRepo();
  try {
    // --- v0.0.1: the "upstream" release we sync from
    r.w('public/js/a.js', 'export const A = 1;\n');
    r.w('public/js/gone.js', 'export const GONE = 1;\n');
    r.w('server/x.js', 'export const X = 1;\n');
    r.w('android/app/build.gradle', 'versionCode 1\n');
    r.git('add', '-A'); r.git('commit', '-qm', 'upstream v0.0.1'); r.git('tag', '-m', 'fixture', 'v0.0.1');

    // --- our line: drift the vendored copy, add our own dirs, keep upstream-only files absent is not
    //     our concern here; also drop nothing yet
    r.w('public/js/a.js', 'export const A = 1; // ours\n');
    r.w('tools/apk/build.mjs', '// ours\n');
    r.w('lineage.json', '{"upstreamTag":"v0.0.1"}\n');
    r.git('add', '-A'); r.git('commit', '-qm', 'ours: local edits');

    // --- upstream moves on: a.js changes, gone.js is deleted, x.js unchanged
    r.w('public/js/a.js', 'export const A = 2;\n');
    r.del('public/js/gone.js');
    r.git('add', '-A'); r.git('commit', '-qm', 'upstream v0.0.2'); r.git('tag', '-m', 'fixture', 'v0.0.2');

    // --- back to our line (the sync must materialise v0.0.2 over it)
    r.git('reset', '-q', '--hard', 'HEAD~1');

    execFileSync(process.execPath, [SCRIPT, '--from', 'v0.0.2', '--repo', r.dir], { stdio: 'pipe' });

    // core.autocrlf is true on the developer machine, so a fixture checkout is CRLF while the bytes the
    // sync writes come from `git archive`; compare with normalised line endings.
    const norm = (rel) => fs.readFileSync(path.join(r.dir, rel), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(norm('public/js/a.js'), 'export const A = 2;\n',
      'the upstream file must be overwritten with the tag bytes (upstream wins)');
    assert.equal(fs.existsSync(path.join(r.dir, 'public/js/gone.js')), false,
      'a file upstream dropped must be gone from the upstream zone');
    assert.equal(norm('android/app/build.gradle'), 'versionCode 1\n',
      'android/ is ours — never written by the sync');
    assert.equal(fs.existsSync(path.join(r.dir, 'tools/apk/build.mjs')), true,
      'tools/apk/ is ours — never deleted by the sync');
    assert.equal(norm('lineage.json'), '{"upstreamTag":"v0.0.1"}\n',
      'lineage.json is ours — the roll bumps it itself');
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('re-running the same tag is a no-op (idempotent), and --dry-run writes nothing', () => {
  const r = mkRepo();
  try {
    r.w('public/js/a.js', 'export const A = 1;\n');
    r.w('android/app/build.gradle', 'versionCode 1\n');
    r.git('add', '-A'); r.git('commit', '-qm', 'base'); r.git('tag', '-m', 'fixture', 'v0.0.1');
    r.w('public/js/a.js', 'export const A = 1; // ours\n');
    r.git('add', '-A'); r.git('commit', '-qm', 'ours');

    // dry-run must not touch the file
    execFileSync(process.execPath, [SCRIPT, '--from', 'v0.0.1', '--repo', r.dir, '--dry-run'], { stdio: 'pipe' });
    assert.ok(fs.readFileSync(path.join(r.dir, 'public/js/a.js'), 'utf8').includes('// ours'),
      '--dry-run must not write');

    // real run, then a second run must report zero writes
    execFileSync(process.execPath, [SCRIPT, '--from', 'v0.0.1', '--repo', r.dir], { stdio: 'pipe' });
    const out = execFileSync(process.execPath, [SCRIPT, '--from', 'v0.0.1', '--repo', r.dir], { stdio: 'pipe' }).toString();
    assert.match(out, /written: 0\b/, 'a second run must be a no-op');
    assert.match(out, /deleted \(upstream dropped them\): 0\b/, 'a second run must delete nothing');
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});
