// preflight-upstream behavior tests (审计 §8 的 V1–V10 预演脚本):
// · manifestShape parses the upstream data/assets.json (counts + stats.files);
// · a --ref run on the real repo passes end to end without touching the working tree;
// · a synthetic repo where our branch MODIFIED an upstream file makes V2/V3 fail (M>0 = 范式被破坏);
// · --tree mode skips the git rows instead of silently claiming PASS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { manifestShape } from './preflight-upstream.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const CLI = path.join(here, 'preflight-upstream.mjs');

const w = (root, rel, text) => {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

test('manifestShape reads the URL form and stats.files across both layouts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-manifest-'));
  try {
    w(root, 'public/data/assets.json', JSON.stringify({ chars: { a: { avatar: '/assets/char/a.png' } }, stats: { files: 4100 } }));
    const shape = manifestShape(root);
    assert.equal(shape.slashAssets, 1);
    assert.equal(shape.files, 4100);
    // flat layout (a built webroot) is accepted too
    const flat = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-flat-'));
    w(flat, 'data/assets.json', JSON.stringify({ stats: { files: 3900 } }));
    assert.equal(manifestShape(flat).files, 3900);
    fs.rmSync(flat, { recursive: true, force: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('manifestShape reports a missing manifest instead of guessing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-nomanifest-'));
  try {
    assert.match(manifestShape(root).error, /not found/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a --ref run on the real repo passes V1–V10 and leaves the working tree untouched', () => {
  const statusBefore = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf-8' }).stdout;
  const run = spawnSync(process.execPath, [CLI, '--repo', repo, '--ref', 'HEAD'], { encoding: 'utf-8', timeout: 300000 });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  for (const id of ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V6b']) {
    assert.match(run.stdout, new RegExp(`\\b${id}\\b`), `${id} must appear in the report`);
  }
  assert.match(run.stdout, /M=0 D=0/, 'HEAD vs HEAD must show zero M/D');
  assert.match(run.stdout, /merge 预演/);
  assert.match(run.stdout, /extras 同名覆盖/);
  assert.match(run.stdout, /result: \d+ pass, 0 fail/);
  const statusAfter = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf-8' }).stdout;
  assert.equal(statusAfter, statusBefore, 'the preflight must not touch the working tree');
});

test('a repo whose branch MODIFIED an upstream file fails V2/V3 (zero-conflict property broken)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-git-'));
  const g = (...args) => spawnSync('git', ['-C', tmp, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf-8' });
  try {
    assert.equal(g('init', '-q', '-b', 'main').status, 0);
    w(tmp, 'public/index.html', '<html></html>');
    w(tmp, 'public/js/a.js', 'v1\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'upstream v1');
    const up1 = g('rev-parse', 'HEAD').stdout.trim();
    // ours: modify an upstream-owned file (the forbidden move) + add a new path
    w(tmp, 'public/js/a.js', 'v2 (ours)\n');
    w(tmp, 'tools/ours.txt', 'x\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'ours');
    // upstream moves on (new commit on top of v1, touching the same file)
    g('checkout', '-q', up1);
    w(tmp, 'public/js/a.js', 'v1.5 upstream\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'upstream v1.5');
    const newUp = g('rev-parse', 'HEAD').stdout.trim();
    g('checkout', '-q', 'main');
    const run = spawnSync(process.execPath, [CLI, '--repo', tmp, '--ref', newUp], { encoding: 'utf-8', timeout: 120000 });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /FAIL\s+V2/);
    assert.match(run.stdout, /M=1/);
    assert.match(run.stdout, /范式被破坏/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('--tree mode skips V1–V4 explicitly (never a silent PASS)', () => {
  const run = spawnSync(process.execPath, [CLI, '--repo', repo, '--tree', repo], { encoding: 'utf-8', timeout: 300000 });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /SKIP\s+V1/);
  assert.match(run.stdout, /SKIP\s+V4/);
  assert.match(run.stdout, /--tree 模式跳过/);
  assert.match(run.stdout, /PASS\s+V6b/);
});

test('usage error (no ref/tree) exits 2 with the command line', () => {
  const run = spawnSync(process.execPath, [CLI], { encoding: 'utf-8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: node tools\/apk\/preflight-upstream\.mjs/);
});
