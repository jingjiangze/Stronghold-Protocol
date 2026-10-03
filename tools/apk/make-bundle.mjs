#!/usr/bin/env node
// Zips the extracted upstream tree into content-bundle-<tag>.zip for the fork's own
// release — the self-hosted mirror the APK updater tries after the upstream URL and
// before gh-proxy. The archive keeps the upstream layout (single wrapper folder), so
// the updater's path mapper treats it identically to the official zip.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UPSTREAM_API = 'https://api.github.com/repos/sganggs/Stronghold-Protocol/releases/latest';

/** The slim (L1) set the on-device hot update downloads — mirrors build-webroot's SLIM_TOP. */
const SLIM_TOP = ['index.html', 'data.js', 'js', 'css', 'vendor', 'fonts', 'shared', 'sim', 'data',
  'server', 'package.json', 'node_modules'];

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const staging = path.resolve(repo, '..', 'dl-cache', 'upstream-extracted');
const dist = path.resolve(repo, '..', 'dl-cache', 'dist');
const webroot = path.resolve(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot');

async function main() {
  const slimOnly = process.argv.includes('--slim-only');
  const tag = argvValue('--tag') || await latestTag();
  fs.mkdirSync(dist, { recursive: true });

  if (!slimOnly) {
    const [root] = fs.readdirSync(staging).filter((n) => fs.statSync(path.join(staging, n)).isDirectory());
    if (!root) throw new Error(`nothing extracted under ${staging}`);
    const upstreamTag = await latestTag();
    const out = path.join(dist, `content-bundle-${upstreamTag}.zip`);
    fs.rmSync(out, { force: true });
    if (process.platform === 'win32') {
      execFileSync('C:/Windows/System32/tar.exe', ['-a', '-c', '-f', out, '-C', staging, root]);
    } else {
      execFileSync('zip', ['-qr', out, root], { cwd: staging });
    }
    console.log(`content bundle: ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(0)} MB, upstream ${upstreamTag})`);
  }

  // slim (L1) bundle: built from the assembled webroot, the only thing a hot update downloads
  if (!fs.existsSync(webroot)) throw new Error(`webroot not built: ${webroot} (run build-webroot.mjs first)`);
  const tops = SLIM_TOP.filter((t) => fs.existsSync(path.join(webroot, t)));
  if (!tops.length) throw new Error('no slim paths found in the webroot');
  const slimOut = path.join(dist, `content-slim-${tag}.zip`);
  fs.rmSync(slimOut, { force: true });
  if (process.platform === 'win32') {
    execFileSync('C:/Windows/System32/tar.exe', ['-a', '-c', '-f', slimOut, '-C', webroot, ...tops]);
  } else {
    execFileSync('zip', ['-qr', slimOut, ...tops], { cwd: webroot });
  }
  console.log(`slim bundle: ${slimOut} (${(fs.statSync(slimOut).size / 1024 / 1024).toFixed(1)} MB, buildTag ${tag})`);
}

function argvValue(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

async function latestTag() {
  const res = await fetch(UPSTREAM_API, { headers: { 'User-Agent': 'stronghold-shell' } });
  if (!res.ok) throw new Error(`upstream API HTTP ${res.status}`);
  return (await res.json()).tag_name;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
