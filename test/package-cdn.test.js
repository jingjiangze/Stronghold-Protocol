// test/package-cdn.test.js — tools/package-cdn.mjs, the one-click no-art server package.
// What matters: the ship set carries the art *manifests* but never a byte of art, the generated start scripts point
// at the CDN, and a build really lays out that package. No network, no npm install, no git (the file list is injected
// through the SP_PACKAGE_CDN_LIST seam, so the build runs in-process on a throwaway directory).
// Run: node --test test/package-cdn.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CDN, main, normalizeCdn, packageFiles, startHere, startScripts } from '../tools/package-cdn.mjs';
import { selectTracked, trackedFiles } from '../tools/package.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = [];
const scratch = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP.push(dir);
  return dir;
};
test.after(() => { for (const d of TMP) fs.rmSync(d, { recursive: true, force: true }); });

/** Build in-process with an explicit file list (no git, no npm). Returns what the run printed. */
async function build(files, { dir, out, cdn = 'https://cdn.example.com/', extra = [] } = {}) {
  const list = path.join(dir, 'files.json');
  fs.writeFileSync(list, JSON.stringify(files));
  const before = process.env.SP_PACKAGE_CDN_LIST;
  process.env.SP_PACKAGE_CDN_LIST = list;
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const code = await main(['--root', dir, '--out', out, '--cdn', cdn, '--no-install', '--force', '--keep-stage', ...extra]);
    return { code, out: lines.join('\n') };
  } finally {
    console.log = log;
    if (before === undefined) delete process.env.SP_PACKAGE_CDN_LIST;
    else process.env.SP_PACKAGE_CDN_LIST = before;
  }
}

test('the CDN base is normalized like the server does it (absolute http(s), one trailing slash)', () => {
  assert.equal(normalizeCdn('https://cdn.example.com'), 'https://cdn.example.com/');
  assert.equal(normalizeCdn('https://cdn.example.com/art'), 'https://cdn.example.com/art/');
  assert.equal(normalizeCdn(' http://127.0.0.1:8080/x/ '), 'http://127.0.0.1:8080/x/');
  assert.equal(normalizeCdn('https://cdn.example.com/?a=1#b'), 'https://cdn.example.com/');
  assert.equal(normalizeCdn(DEFAULT_CDN), DEFAULT_CDN, 'the built-in default is already normalized');
  for (const bad of ['', '  ', 'cdn.example.com', '/assets/', 'javascript:alert(1)', 'file:///x']) {
    assert.throws(() => normalizeCdn(bad), /--cdn|not an absolute|must be http/, bad);
  }
});

test('the generated start scripts run the server with SP_ASSET_CDN, and let the environment override it', () => {
  const { cmd, sh } = startScripts('https://cdn.example.com/');
  assert.match(cmd, /^@echo off/);
  assert.match(cmd, /node server\\index\.js/, 'the Windows script runs the server');
  assert.match(cmd, /if not defined SP_ASSET_CDN set SP_ASSET_CDN=https:\/\/cdn\.example\.com\//, 'default, overridable');
  assert.match(cmd, /if not defined PORT set PORT=3000/);
  assert.match(cmd, /where node >nul/, 'a missing Node.js is explained, not a stack trace');
  assert.ok(!/[\u4e00-\u9fff]/.test(cmd), 'ASCII only: a .cmd is read in the console codepage');
  assert.match(sh, /^#!\/bin\/sh/);
  assert.match(sh, /exec node server\/index\.js/);
  assert.match(sh, /\$\{SP_ASSET_CDN:=https:\/\/cdn\.example\.com\/\}/);
  assert.ok(!cmd.includes('\r'), 'the caller writes the CRLF, the string stays LF');
});

test('START-HERE.txt names the version and the CDN it was built against', () => {
  const txt = startHere('9.9.9', 'https://cdn.example.com/');
  assert.match(txt, /version 9\.9\.9/);
  assert.match(txt, /https:\/\/cdn\.example\.com\//);
  assert.match(txt, /start-server\.cmd/);
  assert.match(txt, /SP_ASSET_CDN/);
});

test('the ship set of this repository: the manifests in, not one byte of art', () => {
  const { files } = packageFiles(ROOT);
  assert.equal(files.filter((f) => f.startsWith('public/assets/')).length, 0);
  assert.equal(files.filter((f) => f.startsWith('public/fonts/')).length, 0);
  assert.ok(files.includes('data/assets.json'), 'the manifest is what the server rewrites to CDN URLs');
  assert.ok(files.includes('server/http/static.js'), 'the SP_ASSET_CDN implementation ships');
  assert.ok(files.includes('package.json') && files.includes('server/index.js'));
  assert.equal(files.filter((f) => f.startsWith('test/')).length, 0, 'tests never ship');
  assert.ok(!files.includes('start-server.cmd'), 'the start scripts are generated, not tracked');
});

test('the box updater travels with the CDN package -- and never with a player package', () => {
  // The box updates itself from this release, then copies tools/box/* into its update directory (self-refresh), so
  // the script that runs there is the one that shipped. A player has no use for it.
  const { files } = packageFiles(ROOT);
  for (const f of ['tools/box/sp_update_zip.ps1', 'tools/box/sp_update_zip.cmd', 'tools/box/verify-service.mjs']) {
    assert.ok(files.includes(f), `the CDN package ships ${f}`);
  }
  const player = selectTracked(trackedFiles(ROOT)).keep;
  assert.ok(!player.some((f) => f.startsWith('tools/box/')), 'the player package does not');
});

/** A throwaway source tree: the two files the packager insists on, plus art that must never reach the zip. */
function fakeTree({ withArt = true } = {}) {
  const dir = scratch('sp-cdn-src-');
  const put = (rel, body = `// ${rel}\n`) => {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  put('package.json', JSON.stringify({ name: 'sp-test', version: '9.9.9', main: 'server/index.js', scripts: { start: 'node server/index.js' } }));
  put('server/index.js', "import './http/static.js';\n");
  put('server/http/static.js', 'export const createStaticHandler = () => {};\n');
  put('public/index.html', '<!doctype html>\n<link rel="stylesheet" href="/fonts/fonts.css">\n');
  put('public/js/main.js', 'export const boot = 1;\n');
  put('data/chess.json', '{}\n');
  put('data/assets.json', JSON.stringify({ chars: { a: { avatar: '/assets/char/a.png' } }, fonts: { css: '/fonts/fonts.css' } }));
  put('data/local-assets.json', JSON.stringify({ version: 1, groups: { g: { x: { path: '/assets/local/g/x.webp' } } } }));
  if (withArt) {
    put('public/assets/char/a.png', 'png');
    put('public/fonts/fonts.css', '@font-face{}\n');
  }
  return dir;
}

const TRACKED = ['package.json', 'server/index.js', 'server/http/static.js', 'public/index.html', 'public/js/main.js',
  'data/chess.json', 'data/assets.json'];
const TRACKED_WITH_ART = [...TRACKED, 'public/assets/char/a.png', 'public/fonts/fonts.css'];

test('art is left out of the ship set even if it were tracked (the build also asserts this before writing)', () => {
  const dir = fakeTree();
  const list = path.join(dir, 'files.json');
  fs.writeFileSync(list, JSON.stringify(TRACKED_WITH_ART));
  const before = process.env.SP_PACKAGE_CDN_LIST;
  process.env.SP_PACKAGE_CDN_LIST = list;
  try {
    const { files } = packageFiles(dir);
    assert.equal(files.filter((f) => f.startsWith('public/assets/')).length, 0);
    assert.equal(files.filter((f) => f.startsWith('public/fonts/')).length, 0);
    assert.ok(files.includes('data/assets.json'), 'the manifest still ships');
  } finally {
    if (before === undefined) delete process.env.SP_PACKAGE_CDN_LIST;
    else process.env.SP_PACKAGE_CDN_LIST = before;
  }
});

test('a build lays out the package: start scripts, both manifests, no art, no node_modules without --install', async () => {
  const dir = fakeTree({ withArt: false });
  const out = scratch('sp-cdn-out-');
  const { code, out: printed } = await build(TRACKED, { dir, out });
  assert.equal(code, 0);
  assert.match(printed, /--no-install: node_modules and public\/vendor are NOT in this build/);

  const stage = path.join(out, '.stage', 'Stronghold-Protocol');
  const rel = (p) => fs.readdirSync(p, { recursive: true }).map((s) => String(s).split(path.sep).join('/'));
  const names = rel(stage);
  for (const need of ['start-server.cmd', 'start-server.sh', 'START-HERE.txt', 'data/assets.json', 'data/local-assets.json',
    'server/http/static.js', 'public/index.html']) {
    assert.ok(names.includes(need), `${need} is in the package`);
  }
  assert.equal(names.filter((n) => /^public\/(assets|fonts)\//.test(n)).length, 0, 'no art');
  assert.equal(names.filter((n) => n.startsWith('node_modules/')).length, 0, '--no-install');
  assert.equal(fs.existsSync(path.join(stage, 'data/local-assets.json')), true, 'the local-client manifest is added back');
  assert.match(fs.readFileSync(path.join(stage, 'start-server.cmd'), 'utf8'), /\r\n/, 'the .cmd is written with CRLF');
  assert.ok(fs.statSync(path.join(out, 'Stronghold-Protocol-v9.9.9-cdn.zip')).size > 0, 'the zip is named after the version');
});

test('--out inside the packaged tree is refused', async () => {
  const dir = fakeTree({ withArt: false });
  await assert.rejects(() => build(TRACKED, { dir, out: path.join(dir, 'release') }), /--out must be outside the repository/);
});
