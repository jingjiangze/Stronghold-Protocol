#!/usr/bin/env node
// tools/apk/release-re.mjs — the re-apk line's content release, in ONE local command.
//
//   node tools/apk/release-re.mjs [--tag shell-v2.9.100] [--upstream-tag v0.1.4]
//                                [--dry-run] [--skip-tests] [--cdn] [--no-upload]
//                                [--art] [--art-version <N>]
//
// WHY LOCAL: the signed manifest pins the slim's sha256, and the slim is NOT byte-reproducible in
// CI (Info-ZIP vs bsdtar) — that is why the apk line's slim is published from this machine too.
// The re-apk line therefore needs no new repository and no second release controller: this script
// is the controller, it runs here, and every R2 key it writes carries the line's -re namespace
// (see tools/apk/line.mjs).
//
// WHAT IT DOES (in order; every step aborts the release on failure):
//   1. gates    — the tool test suite (skip with --skip-tests)
//   2. overlay  — bump tools/apk/shell-ui-version.txt to max(current, live+1) so devices actually
//                 accept the new overlay (the device gate is strictly-greater)
//   3. webroot  — build-webroot: upstream release zip + extras + patches + WebP transcode
//                 (it also fills ../dl-cache/upstream-extracted, which make-bundle needs)
//   4. slim     — make-bundle --slim-only (RAW slim: upstream tree + shell-ui/ snapshot)
//   4.4 verify  — GATE T5: verify-slim replays the slim offline in device order (entry mapping +
//                 extras overlay + patch replay + staging completeness) BEFORE anything is signed.
//                 (The old line ran T5 in publish-test.yml on the apk-test branch; that controller
//                 is stopped, so the release controller owns the gate now — 2026-10-08 audit.)
//   4.5 art     — WITH --art ONLY: make-art-packs --buckets (the FULL /assets/** reference set →
//                 a few size-capped packs) + its art-packs.json. Without the flag this step does
//                 not run and every other step keeps its exact old behavior (the art channel only
//                 exists once the signed manifest carries art.packs). Once the channel IS live
//                 (live manifest has art.version > 0), omitting --art is refused — it would sign
//                 the channel away.
//   5. sign     — gen-manifest: signs the manifest, writes the baked baseline
//                 tools/apk/shell/manifest.json (line-aware URLs from line.mjs); with --art it
//                 also writes art.{version,format,mirrors,packs} (all covered by the same sig)
//   6. publish  — publish-manifest: re-signs servers.json, uploads site/servers-re.json +
//                 site/manifest-re.json to R2 via rclone, re-checks live
//   7. slim R2  — uploads content-slim-<tag>.zip next to the apk line's (same bucket dir, unique
//                 name: the device's R2_BUNDLE_BASE candidates are apk/content-slim-<buildTag>.zip)
//   7.7 art R2  — WITH --art ONLY: publish-art uploads assets-re/packs/<id>-<N>.zip +
//                 assets-re/art-index.json (Cache-Control immutable)
//
// PREREQUISITES (all on this machine, none in CI):
//   · ~/.sp-sign/ed25519.key         the content signing key (private; never leaves this disk)
//   · ../dl-cache/rclone-r2.conf     R2 credentials for rclone (env SP_RCLONE / SP_RCLONE_CFG override)
//   · the release zip of the upstream tag (build-webroot downloads/caches it under ../dl-cache)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS_DIR, LEGACY_MANIFEST_KEY, MANIFEST_KEY, MANIFEST_URL, r2, CDN } from './line.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const dist = path.resolve(repo, '..', 'dl-cache', 'dist');
const RCLONE = process.env.SP_RCLONE || 'C:/Users/16891/AppData/Local/rclone/rclone.exe';
const RCLONE_CFG = process.env.SP_RCLONE_CFG || path.resolve(repo, '..', 'dl-cache', 'rclone-r2.conf');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}
const has = (name) => process.argv.includes(name);
const DRY = has('--dry-run');
const NO_UPLOAD = has('--no-upload');

/** max(candidate, live+1) — the device accepts an overlay only when its version beats the installed one. */
export function overlayBump(candidate, live) {
  const c = Number.parseInt(String(candidate ?? '0'), 10) || 0;
  const l = Number.parseInt(String(live ?? '0'), 10) || 0;
  return Math.max(c, l + 1);
}

/** The R2 key the slim goes to (matches the device's R2_BUNDLE_BASE candidates). */
export const slimKeyOf = (tag) => `apk/content-slim-${tag}.zip`;

/** 过渡期水位线来源：统一键与别名键可能不同步，取 overlay 更高的那一份（纯函数，可测）。
 *  返回 {doc, key}，全都不可用时 {doc:null, key:''}。只读新键会把 overlay 签得比设备已装的低，
 *  设备按「严格大于」直接拒绝——发布看起来成功、设备一动不动。 */
export function pickLiveWatermark(entries) {
  let best = null;
  let bestKey = '';
  let bestV = -1;
  for (const e of entries || []) {
    if (!e || !e.doc) continue;
    const v = Number((e.doc.shellOverlay && e.doc.shellOverlay.version) || 0);
    if (v > bestV) { best = e.doc; bestKey = e.key; bestV = v; }
  }
  return { doc: best, key: bestKey };
}

/** The re-apk line's versionCode floor (0.2.1 -> 2001). Content signed for this line must never be
 *  offered to the older apk line's builds — their shell has none of the re-line wiring. */
export const MIN_APK = 2001;

/**
 * max(candidate, live+1), floored at 1 — the device accepts an art pack batch only when
 * art.version STRICTLY beats the version recorded under filesDir/art (防降级/幂等). 0 is the
 * "channel absent" value, so a first release never signs version 0.
 */
export function artVersionBump(candidate, live) {
  const c = Number.parseInt(String(candidate ?? '0'), 10) || 0;
  const l = Number.parseInt(String(live ?? '0'), 10) || 0;
  return Math.max(Math.max(c, 1), l + 1);
}

/** upstreamTag recorded in the signed manifest: lineage.json is the source of truth. */
export function lineageUpstreamTag(file) {
  try {
    return JSON.parse(fs.readFileSync(file || path.join(repo, 'lineage.json'), 'utf8')).upstreamTag || null;
  } catch {
    return null;
  }
}

function run(step, cmd, argv, opts = {}) {
  console.log(`\n== ${step} ==\n$ ${cmd} ${argv.join(' ')}`);
  if (DRY) return '';
  return execFileSync(cmd, argv, { stdio: ['ignore', 'inherit', 'inherit'], env: process.env, ...opts });
}

/** gh CLI wrapper: allowFail returns null (used to probe "does the release exist"). */
function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

function node(step, args, opts) {
  return run(step, process.execPath, args, opts);
}

/** 拉一次线上清单（overlay 与 art 两条水位线共用），取不到返回 null 并留一条警告。
 *
 *  过渡期（2026-10-09）：统一命名空间后本脚本读 site/manifest.json，但**别名 site/manifest-re.json
 *  才是设备现在真正在读的那个**——两个键在切换后的头几次发布里必然不同步（谁先写谁高）。水位线
 *  必须取**两者中更高的那个**：只读新键会把 overlay 签成比设备已装的还低（严格大于才接受），
 *  发布看起来成功、设备却一动不动。等别名退役后这段自然退化成"只读新键"。
 */
async function liveManifestDoc() {
  const keys = [MANIFEST_KEY, LEGACY_MANIFEST_KEY];
  const entries = [];
  for (const key of keys) {
    try {
      const res = await fetch(`${CDN}/${key}?cb=${Date.now()}`, {
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { console.warn(`live ${key}: HTTP ${res.status}`); continue; }
      const doc = await res.json();
      console.log(`live ${key}: buildTag ${doc && doc.buildTag} overlay ${Number((doc && doc.shellOverlay && doc.shellOverlay.version) || 0)}`);
      entries.push({ key, doc });
    } catch (e) {
      console.warn(`live ${key} unreachable (${e.message})`);
    }
  }
  const { doc, key } = pickLiveWatermark(entries);
  if (!doc) {
    console.warn('no live manifest reachable — treating the watermarks as 0');
    return null;
  }
  console.log(`live watermark source: ${key}`);
  return doc;
}

async function main() {
  // 0) tag
  let tag = arg('--tag');
  if (!tag) {
    tag = execFileSync(process.execPath, [path.join(here, 'next-content-tag.mjs')], { encoding: 'utf8' }).trim();
    console.log(`computed content tag: ${tag} (override with --tag)`);
  }
  if (!/^shell-v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`bad content tag: ${tag}`);
  const upstreamTag = arg('--upstream-tag');

  // 1) overlay watermark
  const versionFile = path.join(here, 'shell-ui-version.txt');
  const cur = (fs.readFileSync(versionFile, 'utf8').match(/\d+/) || ['0'])[0];
  const liveDoc = await liveManifestDoc();
  const live = (liveDoc && liveDoc.shellOverlay && Number(liveDoc.shellOverlay.version)) || 0;
  const next = overlayBump(cur, live);
  console.log(`overlay watermark: current ${cur}, live ${live} -> ${next}`);
  if (!DRY && String(next) !== String(cur)) fs.writeFileSync(versionFile, `${next}\n`);

  // 1.5) art watermark — only when the art channel is enabled (--art)
  const artEnabled = has('--art');
  const liveArtVersion = (liveDoc && liveDoc.art && Number(liveDoc.art.version)) || 0;
  let artVersion = 0;
  if (artEnabled) {
    artVersion = artVersionBump(arg('--art-version'), liveArtVersion);
    console.log(`art watermark: candidate ${arg('--art-version') || '(none)'}, live ${liveArtVersion} -> ${artVersion}`);
  } else if (liveArtVersion > 0 && !has('--no-art')) {
    // FAIL-CLOSED (2026-10-08): the live manifest already carries art.version/packs, but a release
    // WITHOUT --packs would sign `art: {base}` and thereby switch the pack channel OFF on every
    // device that already has it (ArtStore then reads artVersion 0 and stops serving packs). That
    // is a silent downgrade, so refuse and name the two ways forward.
    throw new Error(
      `live manifest has art.version=${liveArtVersion} (the pack channel is LIVE), but this run has no --art.\n` +
      `  · keep/advance the channel:  re-run with --art\n` +
      `  · drop it on purpose:        re-run with --no-art (devices fall back to CDN/embedded art)`);
  }

  // 2) gates
  if (!has('--skip-tests')) {
    const tests = fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs'));
    node(`gates — ${tests.length} tool test files`, ['--test', ...tests.map((f) => path.join(here, f))]);
  }

  // 3) webroot (needs the upstream release zip; SP_UPSTREAM_TAG pins it)
  const env = { ...process.env };
  if (upstreamTag) env.SP_UPSTREAM_TAG = upstreamTag;
  run('webroot — upstream + extras + patches + WebP', process.execPath, [path.join(here, 'build-webroot.mjs')], { env });

  // 4) slim (RAW: upstream tree + shell-ui/ snapshot)
  node('slim — make-bundle --slim-only', [path.join(here, 'make-bundle.mjs'), '--slim-only', '--tag', tag]);
  const slim = path.join(dist, `content-slim-${tag}.zip`);
  if (!DRY && !fs.existsSync(slim)) throw new Error(`slim not produced: ${slim}`);

  // 4.4) GATE T5 — verify the slim OFFLINE the way the device consumes it (entry mapping +
  //      extras overlay + full patch replay + staging-tree completeness). The old line ran this
  //      inside publish-test.yml (an apk-test-branch workflow); that controller is stopped, so the
  //      re line's release controller is the only place left where a malformed slim can be caught
  //      BEFORE it is signed and published (2026-10-08 audit: T5 was dormant on this line).
  if (!DRY) {
    node('verify — GATE T5 (verify-slim, offline device-order replay)', [path.join(here, 'verify-slim.mjs'), '--slim', slim]);
  }

  // 4.5) art packs (--art only): the FULL manifest reference set → a few size-capped bucketed zips
  //      (--buckets; 方案-静态资源热更新 §5 layer② / 设计-按需下载 §2), deterministic + art-packs.json.
  //      The completeness gate inside make-art-packs refuses to emit unless every /assets/** ref in
  //      data/assets.json (+ local-assets.json) is on disk and lands in exactly one pack.
  //      Additive by construction: without --art nothing runs and the signed manifest keeps its
  //      old {base} art shape (the device then never sees the pack channel).
  const artPacksFile = path.join(dist, 'art-packs.json');
  if (artEnabled) {
    node('art — make-art-packs (--buckets: full ref set → size-capped packs)', [path.join(here, 'make-art-packs.mjs'),
      '--art-version', String(artVersion), '--buckets', '--out', artPacksFile]);

    // 4.6) content-addressed watermark (owner's rule, 2026-10-08): the pack's sha256 rides the signed
    //      manifest, so a release whose packs are byte-identical to the live ones must NOT bump
    //      art.version — the device gate is strictly-greater, so a bump makes every upgraded device
    //      re-download the whole pack (~7.5 MB) for nothing. Build once with the candidate, compare
    //      the shas, and if nothing changed keep the live version (urls embed the version, so the
    //      zip is re-emitted under the final name — the bytes are identical either way).
    const packsNow = JSON.parse(fs.readFileSync(artPacksFile, 'utf8'));
    const livePacks = (liveDoc && liveDoc.art && Array.isArray(liveDoc.art.packs)) ? liveDoc.art.packs : [];
    // Same pack SET and same bytes => keep the live version. A changed set (a bucket added/removed/
    // sharded differently) must bump, or the device never syncs and keeps serving a stale layout.
    const unchanged = packsNow.length > 0 && packsNow.length === livePacks.length && packsNow.every((p) => {
      const l = livePacks.find((x) => x && x.id === p.id);
      return l && l.sha256 === p.sha256;
    });
    if (unchanged && liveArtVersion > 0 && String(artVersion) !== String(liveArtVersion)) {
      console.log(`art packs unchanged (same set + sha256 as the live manifest) -> art.version stays ${liveArtVersion}; devices will not re-download`);
      artVersion = liveArtVersion;
      node('art — make-art-packs (unchanged bytes; re-emit under the live version)', [path.join(here, 'make-art-packs.mjs'),
        '--art-version', String(artVersion), '--buckets', '--out', artPacksFile]);
    }
  }

  // 5) sign + baked baseline
  //    upstreamTag/minApk are recorded INSIDE the signed document, so they must be right here: the
  //    lineage file names the upstream release this content tree matches, and minApk is the re-apk
  //    line's versionCode floor (0.2.1 -> 2001) — without it a build from the older apk line would
  //    be offered re-line content whose shell wiring it does not have.
  const upTag = upstreamTag || lineageUpstreamTag() || 'v0.1.0';
  const signArgs = [path.join(here, 'gen-manifest.mjs'), '--tag', tag, '--slim', slim,
    '--upstream', upTag, '--min-apk', String(MIN_APK)];
  if (artEnabled) signArgs.push('--packs', artPacksFile, '--art-version', String(artVersion), '--art-format', '1');
  node('sign — gen-manifest', signArgs);

  // 5.5) fail-closed guard: the signed manifest MUST carry shellOverlay when the tree says the
  //      overlay channel is on. Release 109 signed WITHOUT it (one failed shell-ui/version.txt
  //      extraction inside gen-manifest returned a silent null) → devices never accepted overlay
  //      35 and the whole content update stopped reaching them while every gate stayed green.
  //      Cheap to check, catastrophic to miss.
  if (!DRY) {
    const want = Number((fs.readFileSync(path.join(here, 'shell-ui-version.txt'), 'utf8').match(/\d+/) || [0])[0]);
    const signed = JSON.parse(fs.readFileSync(path.join(here, 'shell', 'manifest.json'), 'utf8'));
    const got = signed.shellOverlay ? Number(signed.shellOverlay.version) : 0;
    if (want > 0 && got !== want) {
      throw new Error(`signed manifest shellOverlay=${got || '(absent)'} but shell-ui-version.txt=${want}`
        + ' — the overlay update would never reach devices; refusing to publish');
    }
    console.log(`signed shellOverlay v${got} matches shell-ui-version.txt (${want})`);
  }

  // 6) publish the signed documents (site/servers-re.json + site/manifest-re.json)
  if (NO_UPLOAD) {
    console.log('\n--no-upload: skipping the R2 uploads (manifest + baseline are written locally)');
  } else {
    node('publish — servers + manifest', [path.join(here, 'publish-manifest.mjs')]);

    // 7) slim -> R2 (same bucket dir as the apk line shares, unique name via the tag)
    run('slim -> R2', RCLONE, ['--config', RCLONE_CFG, 'copyto', slim, r2(slimKeyOf(tag)),
      '--header-upload', 'Cache-Control: public, max-age=31536000, immutable',
      '--s3-upload-cutoff', '64M', '--s3-chunk-size', '64M', '--transfers', '8',
      '--retries', '5', '--low-level-retries', '20', '--ignore-times', '--stats-one-line', '--stats', '30s']);
    // 7.5) GitHub release carrying the slim: the signed manifest's slim.url points at this asset
    //      (the mirror chain's first entries resolve through the release URL), so it must exist.
    //      **--prerelease is load-bearing**: GitHub's `/releases/latest` (and the "Latest" badge on
    //      the releases page, and the download site's browser-direct fallback) resolves to the newest
    //      non-prerelease release. A content release carries NO APK, so without this flag every
    //      content release takes the Latest marker and the APK release looks "not published"
    //      (2026-10-08: /releases/latest pointed at shell-v2.9.108 instead of shell-v0.2.1).
    //      Prerelease changes nothing for devices (they read site/manifest-re.json) and the asset
    //      URL keeps working; it only keeps "latest" = the client release.
    if (!has('--no-release')) {
      const REPO = process.env.SP_REPO || 'jingjiangze/Stronghold-Protocol';
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      if (gh(['release', 'view', tag, '--repo', REPO], { allowFail: true }) === null) {
        run('release - create + attach the slim', 'gh', ['release', 'create', tag, '--repo', REPO,
          '--target', head, '--title', 'content ' + tag, '--prerelease',
          '--notes', 'content release ' + tag + ' (slim asset; the production pointer site/manifest.json is written by this script)', slim]);
      } else {
        run('release - refresh the slim asset', 'gh', ['release', 'upload', tag, '--repo', REPO, '--clobber', slim]);
        // an existing release created before this rule still carries the Latest marker
        gh(['release', 'edit', tag, '--repo', REPO, '--prerelease'], { allowFail: true });
      }
      console.log('release ' + tag + ' carries ' + path.basename(slim));
    }

    // 7.7) art packs -> R2 assets-re/packs/ + assets-re/art-index.json (--art only). The signed
    //      manifest's art.packs[].urls[] point here, so this must run in the same batch as step 5.
    if (artEnabled) {
      node('art -> R2 (packs + art-index)', [path.join(here, 'publish-art.mjs'),
        '--packs', artPacksFile, '--art-version', String(artVersion)]);
    }

    console.log(`\nDONE — content ${tag} published for the re-apk line:`);
    console.log(`  manifest : ${MANIFEST_URL}`);
    console.log(`  slim     : ${CDN}/${slimKeyOf(tag)}`);
    if (artEnabled) console.log(`  art      : ${CDN}/${ASSETS_DIR}/packs/ (v${artVersion}; ${ASSETS_DIR}/art-index.json)`);
    console.log(`  assets   : ${CDN}/${ASSETS_DIR}/ (mirrored by CI apk-re.yml; use --cdn for a local mirror)`);
  }

  if (has('--cdn')) {
    node('cdn — make-cdn', [path.join(here, 'make-cdn.mjs')]);
    run('cdn -> R2', RCLONE, ['--config', RCLONE_CFG, 'copy',
      path.resolve(repo, '..', 'dl-cache', 'pages-cdn', 'assets'), `r2:stronghold-assets/${ASSETS_DIR}`,
      '--transfers', '32', '--checkers', '32', '--stats-one-line', '--stats', '30s']);
  }
}

// 只有直接运行才执行：被 import（测试/别的工具）时必须只是导出纯函数，绝不能顺手发布一遍。
const isEntry = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntry) {
  main().then(() => {
    if (DRY) console.log('\n(dry run — nothing was written or uploaded)');
  }).catch((e) => {
    console.error(`release-re FAILED: ${e && e.message}`);
    process.exit(1);
  });
}
