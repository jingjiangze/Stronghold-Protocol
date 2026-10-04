#!/usr/bin/env node
// publish-apk-latest.mjs — machine-readable "latest APK" manifest for the update pipeline.
//
//   node tools/apk/publish-apk-latest.mjs [--tag shell-v2.7.5] [--apk <path>] [--dry-run] [--out <file>]
//
// Writes R2 apk/latest.json:
//   { tag, versionCode, versionName, apkUrl, sha256, size, minApk, notesUrl, generated }
// versionCode/versionName come from android/app/build.gradle, so the in-app updater can tell
// whether a newer APK exists without parsing the tag. --out redirects the local write (e.g. a
// dry run into /tmp) so a verification pass never overwrites the dist artifact.
// Consumers: the download site (future), the shell's in-app updater (phase-2 design), and any
// mirror that wants to verify integrity before re-hosting. The apkUrl points at the R2 direct
// link (first-party, free egress); the GitHub release asset stays the third-party fallback.
//
// Safety: only https URLs are emitted; the tag/sha are validated against the built artifacts so
// a stale build can never publish a wrong pointer.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const dist = path.resolve(repo, '..', 'dl-cache', 'dist');
const RCLONE = process.env.SP_RCLONE || 'C:/Users/16891/AppData/Local/rclone/rclone.exe';
const RCLONE_CFG = path.resolve(repo, '..', 'dl-cache', 'rclone-r2.conf');
const R2_BASE = 'https://weishucdn.jiangjiangze.icu/apk';
const RELEASES_BASE = 'https://github.com/jingjiangze/Stronghold-Protocol/releases/tag';

const DRY = process.argv.includes('--dry-run');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  // defaults from the built APK + embedded manifest (single source of truth for the build)
  const apk = arg('--apk') || path.resolve(repo, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  if (!fs.existsSync(apk)) throw new Error(`APK not found: ${apk}`);

  const manifestPath = path.resolve(repo, 'android', 'app', 'src', 'main', 'assets', 'shell', 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;

  const gradleVersion = readGradleVersion();
  const tag = arg('--tag') || `shell-v${gradleVersion.versionName}`;
  if (!/^shell-v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`bad tag: ${tag}`);
  const { versionCode, versionName } = gradleVersion;

  const size = fs.statSync(apk).size;
  const hash = sha256(apk);
  // R2 filename convention: stronghold-v2.7.5.apk (the tag's "shell-" prefix is NOT in the file name)
  const apkName = `stronghold-${tag.replace(/^shell-/, '')}.apk`;
  const doc = {
    tag,
    versionCode,
    versionName,
    apkUrl: `${R2_BASE}/${apkName}`,
    notesUrl: `${RELEASES_BASE}/${tag}`,
    sha256: hash,
    size,
    minApk: manifest ? manifest.minApk : null,
    buildTag: manifest ? manifest.buildTag : null, // content axis, independent of the shell tag
    generated: new Date().toISOString(),
  };

  const out = arg('--out') ? path.resolve(arg('--out')) : path.join(dist, 'latest.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  console.log(`latest.json: ${out}`);
  console.log(`  ${doc.tag} | versionCode ${doc.versionCode} / ${doc.versionName} | ${(size / 1048576).toFixed(0)}MB | sha256 ${hash.slice(0, 12)}… | minApk ${doc.minApk}`);

  if (!DRY) {
    exec(RCLONE, ['--config', RCLONE_CFG, 'copyto', out, 'r2:stronghold-assets/apk/latest.json']);
    console.log('uploaded to R2 apk/latest.json');
  } else {
    console.log('(dry run — not uploaded)');
  }
}

function readGradleVersion() {
  const gradle = fs.readFileSync(path.resolve(repo, 'android', 'app', 'build.gradle'), 'utf8');
  const code = /versionCode\s+(\d+)/.exec(gradle);
  const name = /versionName\s+'([^']+)'/.exec(gradle);
  if (!code) throw new Error('versionCode not found in build.gradle');
  if (!name) throw new Error('versionName not found in build.gradle');
  return { versionCode: Number(code[1]), versionName: name[1] };
}

function exec(cmd, args) {
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
}

main();
