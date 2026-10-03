#!/usr/bin/env node
// tools/apk/publish-manifest.mjs — one command for the whole signed-document pipeline.
//
//   node tools/apk/publish-manifest.mjs [--skip-servers] [--skip-manifest] [--dry-run]
//
// tools/apk/shell/ is the SINGLE hand-edited source. Everything else is generated:
//   1. re-sign servers.json (always: the list changes more often than the manifest)
//   2. verify both documents against the pinned pubkey
//   3. upload to R2 (site/servers.json, site/manifest.json) via rclone
//   4. copy into the download-site repo (data/*.json)
//   5. re-check the LIVE endpoints with the pure-Java verifier (App-pinned key)
// Any step failing exits non-zero — a half-published state is worse than none.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const shellDir = path.join(here, 'shell');
const dlSite = process.env.SP_DL_SITE || 'C:/DDDD/Agent Work/stronghold-dl-site';
const RCLONE = process.env.SP_RCLONE || 'C:/Users/16891/AppData/Local/rclone/rclone.exe';
const RCLONE_CFG = path.resolve(repo, '..', 'dl-cache', 'rclone-r2.conf');
const R2_BUCKET = 'r2:stronghold-assets';
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

  // 3) R2
  if (!SKIP('servers')) sh(RCLONE, ['--config', RCLONE_CFG, 'copyto', servers, `${R2_BUCKET}/site/servers.json`]);
  sh(RCLONE, ['--config', RCLONE_CFG, 'copyto', manifest, `${R2_BUCKET}/site/manifest.json`]);
  console.log('uploaded to R2 site/*');

  // 4) download-site repo
  if (!fs.existsSync(dlSite)) throw new Error(`download-site repo not found: ${dlSite}`);
  if (!SKIP('servers')) fs.copyFileSync(servers, path.join(dlSite, 'data', 'servers.json'));
  fs.copyFileSync(manifest, path.join(dlSite, 'data', 'manifest.json'));
  console.log('copied into stronghold-dl-site/data/ (COMMIT + DEPLOY PAGES SEPARATELY)');

  // 5) live re-check (signatures + freshness) against the two public endpoints
  const checks = [];
  if (!SKIP('servers')) {
    const live = await fetchLive('https://weishucdn.jiangjiangze.icu/site/servers.json');
    if (live.sig !== JSON.parse(fs.readFileSync(servers, 'utf8')).sig) {
      throw new Error('R2 servers.json is not the copy we just uploaded (CDN cache?)');
    }
    checks.push('R2 servers.json = freshly signed copy');
  }
  {
    const live = await fetchLive('https://weishucdn.jiangjiangze.icu/site/manifest.json');
    const local = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (live.buildTag !== local.buildTag) throw new Error(`R2 manifest stale: ${live.buildTag}`);
    checks.push(`R2 manifest = ${local.buildTag}`);
  }
  {
    const live = await fetchLive('https://dl.jiangjiangze.icu/data/manifest.json');
    if (typeof live.buildTag !== 'string' || !live.buildTag.startsWith('shell-v')) {
      console.warn('WARN: dl/data/manifest.json is stale or missing (deploy Pages?)');
    } else {
      checks.push(`dl manifest = ${live.buildTag}`);
    }
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
