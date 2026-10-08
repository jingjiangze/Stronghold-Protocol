// tools/package-cdn.mjs — build the one-click, no-art server package:
//
//   npm run package:cdn        → Stronghold-Protocol-v<version>-cdn.zip
//
// What it is: the same server as tools/package.mjs ships, minus every byte of game art. The three art manifests
// (data/assets.json, data/local-assets.json, data/emotes.json) travel with it, and the package starts with
// SP_ASSET_CDN pointed at a CDN that mirrors the upstream art tree, so:
//
//   * public/assets/** and public/fonts/** are NOT in the zip (~310 MB of the full package), and
//   * the art is fetched by each player's browser straight from the CDN edge (server/http/static.js).
//
// A player unzips it and double-clicks start-server.cmd (Windows) or runs ./start-server.sh. node_modules and
// public/vendor are produced by `npm ci --omit=dev` in the stage, exactly as the full package does, so there is
// no install step on the receiving side.
//
//   node tools/package-cdn.mjs [--cdn <base url>] [--out <dir>] [--no-install] [--dry-run [--list]] [--force] [--keep-stage] [--root <dir>]
//
// --out defaults to <tmp>/stronghold-protocol-cdn-release and must be outside the repository (same rule as package.mjs).
// --no-install is a test build: no node_modules, no public/vendor.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FOLDER, selectTracked, trackedFiles, zipFolder } from './package.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The CDN that mirrors the upstream art tree (see the Stronghold-Protocol-CDN project). */
export const DEFAULT_CDN = 'https://weishucdn.jiangjiangze.icu/';
/** The per-machine local-client manifest: git-ignored, but the no-art package needs it or the 3D board is off. */
const LOCAL_ART = 'data/local-assets.json';

const USAGE = 'usage: node tools/package-cdn.mjs [--cdn <base url>] [--out <dir>] [--no-install] [--dry-run [--list]] [--force] [--keep-stage] [--root <dir>]';

const MB = (n) => `${(n / 1048576).toFixed(1)} MB`;
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Normalize the CDN base the way server/http/static.js does (absolute http(s), one trailing slash). */
export function normalizeCdn(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('--cdn needs a base URL');
  let u;
  try { u = new URL(value); } catch { throw new Error(`--cdn is not an absolute URL: ${value}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`--cdn must be http(s): ${value}`);
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  u.search = '';
  u.hash = '';
  return u.href;
}

/** The two files a player actually touches, written into the package root. */
export function startScripts(cdn) {
  const cmd = `@echo off
rem Stronghold Protocol -- one-click start (art served from the CDN, nothing to download or extract).
rem Needs Node.js 22 or newer on PATH: https://nodejs.org/
setlocal
cd /d "%~dp0"
if not exist "node_modules\\" (
  echo node_modules is missing from this package -- re-extract the zip.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install Node.js 22+ from https://nodejs.org/ and run this again.
  pause
  exit /b 1
)
if not defined HOST set HOST=0.0.0.0
if not defined PORT set PORT=3000
if not defined SP_ASSET_CDN set SP_ASSET_CDN=${cdn}
set SP_NO_BROWSER=1
echo.
echo   Stronghold Protocol starting on http://localhost:%PORT%/
echo   Art is loaded from %SP_ASSET_CDN%
echo   Press Ctrl+C to stop.
echo.
node server\\index.js
pause
`;
  const sh = `#!/bin/sh
# Stronghold Protocol -- one-click start (art served from the CDN, nothing to download or extract).
# Needs Node.js 22 or newer on PATH: https://nodejs.org/
set -e
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "node_modules is missing from this package -- re-extract the zip." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found on PATH. Install Node.js 22+ from https://nodejs.org/ and run this again." >&2
  exit 1
fi
: "\${HOST:=0.0.0.0}"
: "\${PORT:=3000}"
: "\${SP_ASSET_CDN:=${cdn}}"
export HOST PORT SP_ASSET_CDN
export SP_NO_BROWSER=1
echo
echo "  Stronghold Protocol starting on http://localhost:\$PORT/"
echo "  Art is loaded from \$SP_ASSET_CDN"
echo "  Press Ctrl+C to stop."
echo
exec node server/index.js
`;
  return { cmd, sh };
}

/** START-HERE.txt: what this zip is and the two things a player may want to change. */
export function startHere(version, cdn) {
  return `Stronghold Protocol \u2014 \u4e00\u952e\u542f\u52a8\u670d\u52a1\u5668\u5305\uff08\u65e0\u7d20\u6750\uff0c\u7d20\u6750\u8d70 CDN\uff09
version ${version}  \u00b7  CDN ${cdn}

\u600e\u4e48\u7528
  Windows        \u53cc\u51fb  start-server.cmd
  Linux / macOS  \u5728\u8fd9\u4e2a\u76ee\u5f55\u91cc\u8fd0\u884c  ./start-server.sh
  \u7136\u540e\u6d4f\u89c8\u5668\u6253\u5f00 http://localhost:3000/

\u8fd9\u662f\u4ec0\u4e48
  \u300a\u660e\u65e5\u65b9\u821f\u300b\u201c\u536b\u620d\u534f\u8bae\uff1a\u76df\u7ea6\u201d\u7684\u975e\u5b98\u65b9\u540c\u4eba\u590d\u523b\u670d\u52a1\u7aef\u3002\u5b9d\u5b9d\u91cc**\u4e0d\u542b\u7f8e\u672f\u7d20\u6750**\uff1a
  \u7f8e\u672f\u4e0e\u5b57\u4f53\u7531 CDN \u627f\u62c5\uff0c\u670d\u52a1\u5668\u53ea\u53d1\u4ee3\u7801\u4e0e\u6570\u636e\uff08\u7ea6 40 MB\uff0c\u5b8c\u6574\u5305\u8981 350 MB\uff09\u3002
  \u73a9\u5bb6\u7684\u6d4f\u89c8\u5668\u4f1a\u76f4\u63a5\u4ece CDN \u53d6\u7d20\u6750\uff0c\u6240\u4ee5\u4f60\u7684\u4e0a\u884c\u5e26\u5bbd\u51e0\u4e4e\u4e0d\u88ab\u7f8e\u672f\u5360\u7528\u3002

\u9700\u8981\u4ec0\u4e48
  Node.js 22 \u6216\u66f4\u65b0\uff08https://nodejs.org/\uff09\u3002node_modules \u5df2\u6253\u5305\u5728\u91cc\u9762\uff0c\u4e0d\u9700\u8981 npm install\u3002

\u53ef\u4ee5\u6539\u7684\u4e24\u4e2a\u5730\u65b9
  \u7aef\u53e3          \u8bbe\u73af\u5883\u53d8\u91cf PORT\uff08\u9ed8\u8ba4 3000\uff09
  \u7d20\u6750 CDN      \u8bbe\u73af\u5883\u53d8\u91cf SP_ASSET_CDN\uff08\u9ed8\u8ba4 ${cdn}\uff09
                  \u60f3\u6539\u6210\u81ea\u5df1\u7684\u955c\u50cf\uff1a\u76ee\u5f55\u7ed3\u6784\u4e0e\u4e0a\u6e38\u5b8c\u6574\u5305\u7684 public/ \u4e00\u81f4\uff0c
                  \u5373 <\u57fa\u5740>/assets/... \u4e0e <\u57fa\u5740>/fonts/...\u3002\u4e0d\u8bbe\u5c31\u56de\u5230\u672c\u5730\u7d20\u6750\uff08\u4f46\u672c\u5305\u6ca1\u5e26\uff09\u3002

\u6ce8\u610f
  \u7d20\u6750\u7248\u6743\u5f52\u4e0a\u6d77\u9e70\u89d2\u7f51\u7edc / Yostar\uff0c\u4e0d\u9002\u7528\u672c\u9879\u76ee\u7684 GPL \u8bb8\u53ef\u8bc1\uff1b\u8bf7\u52ff\u5355\u72ec\u518d\u5206\u53d1\u3002
  \u8be6\u89c1\u5305\u5185 README.md / NOTICE.md\u3002
`;
}

/** Every file that goes into the package (relative, posix), before npm ci fills node_modules and public/vendor. */
export function packageFiles(root, { log = () => {} } = {}) {
  // SP_PACKAGE_CDN_LIST=<file.json> replaces the tracked list with an explicit one: the tests build a package from
  // a throwaway directory that is not a git checkout. Same idea as package.mjs's SP_PACKAGE_SCAN_* seams.
  const seam = String(process.env.SP_PACKAGE_CDN_LIST || '').trim();
  let candidates;
  if (seam) {
    const parsed = JSON.parse(fs.readFileSync(seam, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${seam} must hold a JSON array of paths`);
    candidates = parsed;
  } else {
    candidates = trackedFiles(root);
  }
  const { keep, drop } = selectTracked(candidates);
  const files = [...keep];
  if (exists(path.join(root, LOCAL_ART))) files.push(LOCAL_ART);
  else log(`warn: ${LOCAL_ART} is not on this machine \u2014 the package will run without the local-client art (2D board)`);
  return { files: files.sort(), dropped: drop.length };
}

/** Copy `files` from `root` into `<stage>/<FOLDER>/`. */
async function copyInto(root, stage, files) {
  const dest = path.join(stage, FOLDER);
  for (const rel of files) {
    const to = path.join(dest, ...rel.split('/'));
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(path.join(root, ...rel.split('/')), to);
  }
  return dest;
}

/** `npm ci --omit=dev` in the stage: production node_modules plus public/vendor (the postinstall writes it). */
function install(dest) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dest, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.error || r.status !== 0) throw new Error('npm ci failed in the stage (use --no-install for a test build)');
}

/** Measure a tree: total bytes and file count. */
function measure(dir) {
  let bytes = 0;
  let count = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { bytes += fs.statSync(p).size; count += 1; }
    }
  };
  walk(dir);
  return { bytes, count };
}

export async function main(argv) {
  const o = { cdn: DEFAULT_CDN, out: '', install: true, dryRun: false, list: false, force: false, keepStage: false, root: REPO, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cdn') o.cdn = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--no-install') o.install = false;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--list') o.list = true;
    else if (a === '--force') o.force = true;
    else if (a === '--keep-stage') o.keepStage = true;
    else if (a === '--root') o.root = path.resolve(argv[++i]);
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  if (o.help) { console.log(USAGE); return 0; }

  const root = path.resolve(o.root);
  const cdn = normalizeCdn(o.cdn);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.0.0';
  const out = path.resolve(o.out || path.join(os.tmpdir(), 'stronghold-protocol-cdn-release'));
  if (out === root || out.startsWith(`${root}${path.sep}`)) throw new Error(`--out must be outside the repository: ${out}`);

  const { files, dropped } = packageFiles(root);
  const scripts = startScripts(cdn);
  console.log(`package:cdn \u00b7 version ${version} \u00b7 cdn ${cdn}`);
  console.log(`  files: ${files.length} tracked (+${LOCAL_ART} when present, +3 generated) \u00b7 ${dropped} tracked left out`);
  console.log(`  out:   ${out}`);
  if (o.list) for (const f of files) console.log(`    ${f}`);

  // The two trees that must NOT be here: the whole point of this package.
  const art = files.filter((f) => f.startsWith('public/assets/') || f.startsWith('public/fonts/'));
  if (art.length) throw new Error(`refusing to build: ${art.length} art files are in the ship set (${art.slice(0, 3).join(', ')})`);
  for (const need of ['data/assets.json', 'server/http/static.js']) {
    if (!files.includes(need)) throw new Error(`refusing to build: ${need} is not in the ship set`);
  }

  if (o.dryRun) {
    const bytes = files.reduce((n, f) => n + fs.statSync(path.join(root, ...f.split('/'))).size, 0);
    console.log(`  dry run: ${files.length} files, ${MB(bytes)} before npm ci`);
    return 0;
  }

  await fsp.rm(out, { recursive: true, force: true });
  await fsp.mkdir(out, { recursive: true });
  const stage = path.join(out, '.stage');
  const dest = await copyInto(root, stage, files);
  await fsp.writeFile(path.join(dest, 'start-server.cmd'), scripts.cmd.replace(/\n/g, '\r\n'), 'utf8');
  await fsp.writeFile(path.join(dest, 'start-server.sh'), scripts.sh, 'utf8');
  await fsp.writeFile(path.join(dest, 'START-HERE.txt'), startHere(version, cdn), 'utf8');
  if (o.install) install(dest);
  else console.log('  --no-install: node_modules and public/vendor are NOT in this build');

  const zip = path.join(out, `${FOLDER}-v${version}-cdn.zip`);
  if (exists(zip)) { if (!o.force) throw new Error(`${zip} exists (use --force)`); await fsp.rm(zip); }
  zipFolder(stage, zip);
  const m = measure(dest);
  console.log(`  package: ${m.count} files, ${MB(m.bytes)} on disk`);
  console.log(`  zip:     ${zip} (${MB(fs.statSync(zip).size)})`);
  if (!o.keepStage) await fsp.rm(stage, { recursive: true, force: true });
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(await main(process.argv.slice(2))); } catch (e) { console.error(`package-cdn: ${e.message}`); process.exit(1); }
}
