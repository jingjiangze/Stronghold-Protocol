#!/usr/bin/env node
// Places the nodejs-mobile libnode.so + Node headers into the Android project.
// Both paths are .gitignore'd; CI and local builds run this before gradle.
//
//   node tools/apk/fetch-libnode.mjs [--zip <path|url>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'v18.20.4';
const RELEASE_URL = `https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${VERSION}/nodejs-mobile-${VERSION}-android.zip`;
const MIRROR = `https://gh-proxy.com/${RELEASE_URL}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const androidDir = path.resolve(here, '..', '..', 'android');
const jniDir = path.join(androidDir, 'app', 'src', 'main', 'jniLibs', 'arm64-v8a');
const includeDir = path.join(androidDir, 'node-include');

async function main() {
  const argZip = process.argv.indexOf('--zip');
  let zipPath = argZip > 0 ? process.argv[argZip + 1] : null;
  if (!zipPath) {
    zipPath = path.resolve(here, '..', '..', '..', 'dl-cache', `nodejs-mobile-${VERSION}-android.zip`);
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 10_000_000) {
      await download(RELEASE_URL, zipPath).catch(async (e) => {
        console.warn(`direct download failed (${e.message}), trying mirror…`);
        await download(MIRROR, zipPath);
      });
    }
  }
  console.log(`libnode zip: ${zipPath}`);

  const staging = path.resolve(here, '..', '..', '..', 'dl-cache', `nodejs-mobile-${VERSION}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const zip = path.resolve(zipPath);
  const isWin = process.platform === 'win32';
  if (isWin) {
    execFileSync('C:/Windows/System32/tar.exe', ['-xf', zip, '-C', staging]);
  } else {
    execFileSync('unzip', ['-q', zip, '-d', staging]);
  }

  fs.mkdirSync(jniDir, { recursive: true });
  fs.copyFileSync(path.join(staging, 'bin', 'arm64-v8a', 'libnode.so'), path.join(jniDir, 'libnode.so'));

  fs.rmSync(includeDir, { recursive: true, force: true });
  fs.cpSync(path.join(staging, 'include'), includeDir, { recursive: true });

  const so = fs.statSync(path.join(jniDir, 'libnode.so')).size;
  console.log(`libnode.so (arm64-v8a): ${(so / 1024 / 1024).toFixed(1)} MB → ${jniDir}`);
  console.log('headers →', includeDir);
}

async function download(url, dest) {
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`saved ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
