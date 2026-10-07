#!/usr/bin/env node
// tools/apk/transform-assets.mjs — rewrites asset-manifest JSONs so heavy assets are fetched from a
// CDN base (weishucdn/R2) instead of the serving host. The SAME transform is applied in three places
// (single implementation here): the box deployment, the APK-embedded bundle (build-webroot), and the
// device-side hot updater (Updater.java mirrors this as plain string ops).
//   node tools/apk/transform-assets.mjs [--base https://weishucdn.jiangjiangze.icu]
// Output (CLI mode): <repo>/../dl-cache/cdn-manifests/{assets.json,local-assets.json}
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS_DIR, CDN } from './line.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const dataDir = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot', 'data');
const out = path.resolve(repo, '..', 'dl-cache', 'cdn-manifests');

export const MANIFEST_FILES = ['assets.json', 'local-assets.json'];

/** Pure text transform: "/assets/..." → "<base>/<assetDir>/..."; returns count of rewritten URLs.
 *  `assetDir` defaults to "assets" (the apk line) and is "assets-re" on this line, so the two
 *  product lines never share one browser asset tree. */
export function transformManifestText(text, base, assetDir = 'assets') {
  const b = String(base).replace(/\/+$/, '');
  const d = String(assetDir).replace(/^\/+|\/+$/g, '') || 'assets';
  let count = 0;
  const transformed = text.replace(/"\/assets\//g, () => {
    count++;
    return `"${b}/${d}/`;
  });
  return { text: transformed, count };
}

/**
 * Rewrites the manifest files in `dir` in place (returns per-file rewritten counts).
 * Used by build-webroot for the APK-embedded bundle and by the CLI for the box deployment.
 */
export function transformManifestsDir(dir, base, assetDir = 'assets') {
  const counts = {};
  for (const f of MANIFEST_FILES) {
    const src = path.join(dir, f);
    if (!fs.existsSync(src)) {
      counts[f] = -1;
      continue;
    }
    const { text, count } = transformManifestText(fs.readFileSync(src, 'utf-8'), base, assetDir);
    fs.writeFileSync(src, text);
    counts[f] = count;
  }
  return counts;
}

async function main() {
  const argBase = process.argv.indexOf('--base');
  const BASE = (argBase > 0 ? process.argv[argBase + 1] : CDN).replace(/\/+$/, '');
  const argDir = process.argv.indexOf('--asset-dir');
  const DIR = (argDir > 0 ? process.argv[argDir + 1] : ASSETS_DIR).replace(/^\/+|\/+$/g, '');

  fs.mkdirSync(out, { recursive: true });
  for (const f of MANIFEST_FILES) {
    const src = path.join(dataDir, f);
    if (!fs.existsSync(src)) {
      console.log(`skip (absent): ${f}`);
      continue;
    }
    const { text, count } = transformManifestText(fs.readFileSync(src, 'utf-8'), BASE, DIR);
    fs.writeFileSync(path.join(out, f), text);
    console.log(`${f}: rewrote ${count} asset URLs -> ${BASE}/${DIR}/`);
  }
  console.log(`cdn manifests ready: ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
