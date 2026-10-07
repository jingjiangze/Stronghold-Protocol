#!/usr/bin/env node
// tools/apk/publish-manifest.mjs — one command for the whole signed-document pipeline.
//
//   node tools/apk/publish-manifest.mjs [--skip-servers] [--skip-manifest] [--dry-run]
//
// tools/apk/shell/ is the SINGLE hand-edited source. Everything else is generated:
//   1. re-sign servers.json (always: the list changes more often than the manifest)
//   2. verify both documents against the pinned pubkey
//   3. upload to R2 (site/servers-re.json, site/manifest-re.json) via rclone
//   4. re-check the LIVE endpoints with the pure-Java verifier (App-pinned key)
// Any step failing exits non-zero — a half-published state is worse than none.
//
// This is the re-apk line's copy: it writes ONLY the -re keys (see line.mjs) and it deliberately
// does NOT touch the download-site repo — that site is the apk line's distribution channel and
// resolves its own links.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_KEY, MANIFEST_URL, SERVERS_KEY, SERVERS_URL, r2 } from './line.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const shellDir = path.join(here, 'shell');
const RCLONE = process.env.SP_RCLONE || 'C:/Users/16891/AppData/Local/rclone/rclone.exe';
const RCLONE_CFG = path.resolve(repo, '..', 'dl-cache', 'rclone-r2.conf');
const PUBKEY = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, '.sp-sign', 'ed25519.pub')
  : path.join(os.homedir(), '.sp-sign', 'ed25519.pub');

const DRY = process.argv.includes('--dry-run');
const SKIP = (name) => process.argv.includes(`--skip-${name}`);

function sh(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`.slice(0, 160));
  if (DRY) return '';
  return execFileSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    ...opts,
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function fetchLive(url) {
  const res = await fetch(`${url}?cb=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function javaVerify(file) {
  // reuse the verifier compiled under android-build/edtest (TestVerifyFile)
  const java = 'C:/Users/16891/android-build/jdk-extracted/jdk-17.0.20.1+1/bin/java.exe';
  const cp = 'C:/Users/16891/android-build/edtest/out;C:/Users/16891/android-build/edtest/lib/json.jar';
  const out = execFileSync(java,
    ['-Dfile.encoding=UTF-8', '-cp', cp, 'icu.jiangjiangze.stronghold.TestVerifyFile', file, PUBKEY],
    { encoding: 'utf8', timeout: 60000 });
  return out.includes('VERIFY:true');
}

async function main() {
  const servers = path.join(shellDir, 'servers.json');
  const manifest = path.join(shellDir, 'manifest.json');

  // 1) re-sign the list, 2) verify both
  if (!SKIP('servers')) {
    sh('node', [path.join(here, 'sign.mjs'), 'sign', servers]);
  }
  sh('node', [path.join(here, 'sign.mjs'), 'verify', servers]);
  if (!fs.existsSync(manifest)) throw new Error('manifest.json missing — run make-bundle + gen-manifest first');
  sh('node', [path.join(here, 'sign.mjs'), 'verify', manifest]);
  console.log('signatures verify against the pinned key');

  // 3) R2 — only this line's namespaced keys (see line.mjs)
  if (!SKIP('servers')) sh(RCLONE, ['--config', RCLONE_CFG, 'copyto', servers, r2(SERVERS_KEY)]);
  sh(RCLONE, ['--config', RCLONE_CFG, 'copyto', manifest, r2(MANIFEST_KEY)]);
  console.log(`uploaded to R2 ${SERVERS_KEY} / ${MANIFEST_KEY}`);

  // 4) The download-site repo is the apk line's channel and mirrors its own pointers; this line
  //    does not copy into it (rule of 2026-10-04: the site resolves the latest links itself).

  // 5) live re-check (signatures + freshness) against the two public endpoints
  const checks = [];
  if (!SKIP('servers')) {
    const live = await fetchLive(SERVERS_URL);
    if (live.sig !== JSON.parse(fs.readFileSync(servers, 'utf8')).sig) {
      throw new Error(`R2 ${SERVERS_KEY} is not the copy we just uploaded (CDN cache?)`);
    }
    checks.push(`R2 ${SERVERS_KEY} = freshly signed copy`);
  }
  {
    const live = await fetchLive(MANIFEST_URL);
    const local = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (live.buildTag !== local.buildTag) throw new Error(`R2 manifest stale: ${live.buildTag}`);
    checks.push(`R2 ${MANIFEST_KEY} = ${local.buildTag}`);
  }
  for (const f of [servers, manifest]) {
    if (!(await javaVerify(f))) throw new Error(`Java verifier rejected ${path.basename(f)}`);
    checks.push(`Java verify ${path.basename(f)} OK`);
  }

  console.log('\nDONE:');
  for (const c of checks) console.log('  ✓ ' + c);
  if (DRY) console.log('  (dry run — nothing was written)');
}

main().catch((e) => {
  console.error(`publish-manifest FAILED: ${e.message}`);
  process.exit(1);
});
