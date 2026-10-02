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

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const staging = path.resolve(repo, '..', 'dl-cache', 'upstream-extracted');
const dist = path.resolve(repo, '..', 'dl-cache', 'dist');

async function main() {
  const [root] = fs.readdirSync(staging).filter((n) => fs.statSync(path.join(staging, n)).isDirectory());
  if (!root) throw new Error(`nothing extracted under ${staging}`);
  const tag = await latestTag();
  fs.mkdirSync(dist, { recursive: true });
  const out = path.join(dist, `content-bundle-${tag}.zip`);
  fs.rmSync(out, { force: true });
  if (process.platform === 'win32') {
    execFileSync('C:/Windows/System32/tar.exe', ['-a', '-c', '-f', out, '-C', staging, root]);
  } else {
    execFileSync('zip', ['-qr', out, root], { cwd: staging });
  }
  console.log(`content bundle: ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(0)} MB, tag ${tag})`);
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
