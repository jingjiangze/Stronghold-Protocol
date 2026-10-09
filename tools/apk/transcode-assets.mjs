#!/usr/bin/env node
// tools/apk/transcode-assets.mjs — a build-pipeline step: standalone PNGs under webroot/assets/**
// are transcoded to WebP in place and the asset manifests are rewritten to match, so the APK
// (assets/ is embedded wholesale) and the CDN product (make-cdn copies webroot/assets) shrink
// together. Runs on EVERY build because data/assets.json + data/local-assets.json are
// upstream-generated: a conversion done once would drift the next time upstream ships a zip.
//
//   node tools/apk/transcode-assets.mjs [--webroot <dir>] [--no-webp] [--check]
//                                       [--encoder cwebp|pillow|magick|ffmpeg|sharp]
//                                       [--quality 90] [--method 4] [--workers N]
//
// Rules (see the audit that spawned this step):
//   · spine atlas pages are skipped: they are paired with <base>.skel / <base>.atlas and the
//     client derives the page name from the skel path (js/assets.js spinePages():
//     `skel.replace(/\.skel$/, '.png')`), so renaming one breaks the lookup. Only "standalone"
//     PNGs (no .skel/.atlas sibling) are converted. A PNG that already has a .webp sibling is
//     left alone too (upstream shipped that pair; the .webp is already the manifest target).
//   · manifests: every `/assets/<rel>.png` (or this line's `/assets-re/<rel>.png`) string in
//     data/assets.json + data/local-assets.json (this module shares MANIFEST_FILES with
//     transform-assets.mjs) is rewritten to `.webp` for the files actually converted;
//     data/emotes.json is an inert generated reference but its refs are kept in sync too
//     (OPTIONAL_REF_FILES). BOTH prefixes resolve to the same on-disk `assets/` directory.
//   · determinism: fixed encoder parameters, no metadata/timestamps copied (pixels are
//     re-created through convert(), which drops info/EXIF/ICC). Same input → same bytes, so
//     manifest hashes are stable across runs (a re-run converts 0 files and rewrites 0 bytes).
//   · fallback: if the encoded WebP is not smaller than the PNG, the PNG is kept and the
//     manifest keeps pointing at it.
//   · gate: after transcoding, every local asset reference in the two manifests must exist on
//     disk; a missing file fails the build loudly (non-zero exit).
//   · --no-webp / SP_NO_WEBP=1 disables transcoding entirely (the gate still runs).
//   · encoders are probed at runtime and pluggable; when none is available the step exits with
//     a message naming what to install instead of silently shipping PNGs.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { MANIFEST_FILES } from './transform-assets.mjs';
import { ASSETS_DIR } from './line.mjs';

/** Spine pages: a PNG with any of these siblings keeps its name (the client derives it). */
export const SPINE_SIBLINGS = ['.skel', '.atlas'];
/** Manifests that are guaranteed to exist in a built webroot (shared with transform-assets). */
export const REQUIRED_MANIFESTS = MANIFEST_FILES;
/** Extra generated reference that also carries `/assets/...png` strings — rewritten when present. */
export const OPTIONAL_REF_FILES = ['emotes.json'];

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 过渡期遗留的目录名：2026-10-08 统一前本线用 `/assets-re/`，而仓库里**已提交**的内置清单
 * （tools/apk/shell/manifest.json）仍带着它 —— 要到下次发布由 gen-manifest 重生成才会变成
 * `/assets/`。几种形态都指向同一个磁盘目录 `assets/`，漏掉任一形态都会让"清单↔磁盘"门禁
 * 静默漏项（转码删了 PNG、清单还指着旧名 → 404）。`-re` 对象被清理任务回收干净后可删掉这条。
 */
const LEGACY_ASSET_DIRS = ['assets-re'];

/**
 * Matches an asset reference in a manifest and captures its directory prefix. Two forms occur: the
 * upstream `/assets/` (before transform-assets runs) and this line's baked directory (what
 * build-webroot bakes — now `/assets/`, formerly `/assets-re/`). They name the same embedded
 * directory — a manifest that mixes them must still have its `.png` refs rewritten, or the converted
 * PNG gets deleted while the manifest keeps pointing at the old name (404).
 */
export const assetRefRe = (assetDir = ASSETS_DIR) => {
  const dirs = [...new Set([assetDir, 'assets', ...LEGACY_ASSET_DIRS])];
  return new RegExp(`(/(?:${dirs.map(escRe).join('|')})/)([^"\\\\]+)"`, 'g');
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
export const DEFAULT_WEBROOT = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot');

/** Encode parameters. quality 90 keeps the look; method 4 is the Pillow/libwebp effort knob.
 *  (method 6 measures ~46x slower than 4 on this toolchain for a ~3% size gain — see the report
 *  in tools/apk/transcode-assets.test.mjs header. Override with SP_WEBP_METHOD=6 if wanted.) */
export const DEFAULT_QUALITY = 90;
export const DEFAULT_METHOD = 4;

// ---------------------------------------------------------------- filesystem helpers

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const toPosix = (p) => p.split(path.sep).join('/');

function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e; // cross-device staging dir: copy + unlink
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

// ---------------------------------------------------------------- PNG classification

/**
 * Splits every PNG under `assetsDir` into three buckets (rel paths, '/' separated):
 *   standalone  — no .skel/.atlas/.webp sibling → the conversion candidates
 *   spine       — paired with <base>.skel or <base>.atlas → never renamed
 *   alreadyWebp — a <base>.webp sibling already exists (upstream shipped the pair) → left alone
 */
export function classifyPngs(assetsDir) {
  const out = { standalone: [], spine: [], alreadyWebp: [] };
  for (const p of walk(assetsDir)) {
    if (!p.toLowerCase().endsWith('.png')) continue;
    const dir = path.dirname(p);
    const base = path.basename(p, path.extname(p));
    const has = (ext) => fs.existsSync(path.join(dir, base + ext));
    const rel = toPosix(path.relative(assetsDir, p));
    if (SPINE_SIBLINGS.some(has)) out.spine.push(rel);
    else if (has('.webp')) out.alreadyWebp.push(rel);
    else out.standalone.push(rel);
  }
  return out;
}

/** PNG → WebP rel-path map for a converted set. */
export const webpRel = (rel) => rel.replace(/\.png$/i, '.webp');

// ---------------------------------------------------------------- manifest sync

/**
 * Rewrites every `<assets-dir>/<rel>.png` string (JSON value, i.e. followed by `"`) whose rel path
 * is in `relMap` to the mapped `.webp` path, keeping the reference's own directory prefix; returns
 * the text and the number of references changed. Pure text op so upstream formatting/ordering
 * survives byte-for-byte when nothing matches.
 */
export function rewriteManifestRefs(text, relMap, assetDir = ASSETS_DIR) {
  let count = 0;
  const rewritten = text.replace(assetRefRe(assetDir), (m, prefix, rel) => {
    const to = relMap.get(rel);
    if (!to) return m;
    count++;
    return `${prefix}${to}"`;
  });
  return { text: rewritten, count };
}

/**
 * Applies rewriteManifestRefs to the manifest files in `dir` (required: assets.json,
 * local-assets.json; optional: emotes.json). Files are written only when their text changed —
 * a no-op run leaves bytes (and thus sha256) untouched. Returns per-file ref counts.
 */
export function syncManifests(dir, relMap, { files = REQUIRED_MANIFESTS, optional = OPTIONAL_REF_FILES } = {}) {
  const counts = {};
  for (const [f, required] of [...files.map((n) => [n, true]), ...optional.map((n) => [n, false])]) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) {
      if (required) throw new Error(`asset manifest missing: ${p}`);
      continue;
    }
    const text = fs.readFileSync(p, 'utf-8');
    const { text: next, count } = rewriteManifestRefs(text, relMap);
    if (next !== text) fs.writeFileSync(p, next);
    counts[f] = count;
  }
  return counts;
}

// ---------------------------------------------------------------- manifest ↔ disk gate

/**
 * Collects the rel paths of every `/assets/...` reference in the given manifest files
 * (CDN-absolute `https://…/assets/x.png` and local `/assets/x.png` both match; the URL is
 * terminated by the closing JSON quote).
 */
export function manifestRefs(webrootDir, files, assetDir = ASSETS_DIR) {
  const dataDir = path.join(webrootDir, 'data');
  const re = assetRefRe(assetDir);
  const refs = []; // { file, rel }
  for (const f of files) {
    const p = path.join(dataDir, f);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf-8');
    for (const m of text.matchAll(re)) refs.push({ file: f, rel: m[2] });
  }
  return refs;
}

/**
 * Gate: every asset reference in the manifests must resolve under `webrootDir/assets` (both the
 * `/assets/` and the `/assets-re/` form name that one directory).
 * Returns { checked, missing: [{ file, rel }] } (deduped by rel).
 */
export function checkManifestDiskConsistency(webrootDir, { files = [...REQUIRED_MANIFESTS, ...OPTIONAL_REF_FILES], assetDir = ASSETS_DIR } = {}) {
  const seen = new Set();
  const missing = [];
  let checked = 0;
  for (const { file, rel } of manifestRefs(webrootDir, files, assetDir)) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    checked++;
    if (!fs.existsSync(path.join(webrootDir, 'assets', ...rel.split('/')))) missing.push({ file, rel });
  }
  return { checked, missing };
}

/** Same as checkManifestDiskConsistency, but throws (loud build failure) when anything is missing. */
export function assertManifestDiskConsistency(webrootDir, opts) {
  const r = checkManifestDiskConsistency(webrootDir, opts);
  if (r.missing.length) {
    const sample = r.missing.slice(0, 10).map((m) => `${m.file}: /assets/${m.rel}`).join('\n  ');
    throw new Error(`manifest/disk mismatch: ${r.missing.length}/${r.checked} manifest refs have no file on disk:\n  ${sample}`);
  }
  return r;
}

// ---------------------------------------------------------------- manifest hash (device cache key)

/**
 * Every `/assets/<rel>` reference in the manifest files of a `data/` dir, deduped and sorted.
 * Same ref grammar as manifestRefs(); works on the data dir alone (no webroot needed), because the
 * --no-assets path has no assets tree on disk.
 */
export function referencedAssetRels(dataDir, { files = [...REQUIRED_MANIFESTS, ...OPTIONAL_REF_FILES] } = {}) {
  const seen = new Set();
  for (const f of files) {
    const p = path.join(dataDir, f);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf-8');
    for (const m of text.matchAll(assetRefRe())) seen.add(m[2]);
  }
  return [...seen].sort();
}

/**
 * Byte-sensitive content hash over the referenced assets, replacing the meaning of the manifest's
 * top-level `hash` on OUR builds. Device effect: the value namespaces the fetched-art cache
 * (`MainActivity.currentArtHash` → `ArtCdn.cacheRelPath` → `filesDir/art/cache/<hash>/…`), so it is
 * the only lever that invalidates a cached file whose bytes changed at an UNCHANGED path.
 *
 * Upstream's own generator (`tools/fetch-assets.mjs` → `contentHash(body)`) hashes the manifest's
 * METADATA JSON, so replacing an image at the same path leaves it untouched (and no per-file
 * size/sha fields exist to notice) — see 审计-素材hash与编码器pin-2026-10-08.md. This recipe:
 *   sha1(JSON.stringify([[rel, sha256(bytes)], …])).slice(0, 12)
 * moves with the bytes, stays 12-hex/`safeHash`-compatible, and is computed identically by the
 * with-assets and --no-assets paths (that equality is asserted by transcode-assets.test.mjs).
 * `readBytes(rel)` supplies the FINAL bytes (post-WebP); unreadable refs are reported in `missing`.
 */
export function hashReferencedBytes({ dataDir, readBytes, files = [...REQUIRED_MANIFESTS, ...OPTIONAL_REF_FILES] } = {}) {
  if (typeof readBytes !== 'function') throw new Error('hashReferencedBytes: readBytes(rel) is required');
  const pairs = [];
  const missing = [];
  for (const rel of referencedAssetRels(dataDir, { files })) {
    const buf = readBytes(rel);
    if (buf == null) {
      missing.push(rel);
      continue;
    }
    pairs.push([rel, crypto.createHash('sha256').update(buf).digest('hex')]);
  }
  return { hash: crypto.createHash('sha1').update(JSON.stringify(pairs)).digest('hex').slice(0, 12), count: pairs.length, missing, pairs };
}

/**
 * 逐文件摘要表（审计 2026-10-09 阶段 1 方案 1）：{@code data/asset-digests.json} =
 * {@code {"version":1,"hash":"<清单 hash>","digests":{"<rel>":"<sha256 hex>"}}}。
 *
 * <p>为什么需要它：清单 hash 是字节敏感的，所以「hash 变了」必然意味着**内容变了**；但设备侧只有
 * 一个顶层 hash，无法知道**是哪个文件**变了 —— 于是壳侧要么把整个命名空间改名复用（那唯一改过的图
 * 就永远不更新），要么全量重下（357 MB）。有了逐文件摘要，壳侧就能「改名复用 + 逐个校验」，只重取
 * 变了的那几个。
 *
 * <p>两个刻意的设计点：
 * <ul>
 *   <li>键是 {@code rel}（如 {@code ui/x.webp}，**不带** {@code /assets/} 前缀）：build-webroot 的
 *       {@code transformManifestsDir} 会把 {@code data/*.json} 里形如 {@code /assets/…"} 的引用改写成
 *       CDN 前缀，带上前缀的键会在第二次构建时被改坏。</li>
 *   <li>文件里带 {@code hash}：壳侧只在它与当前清单 hash 一致时使用这份表，避免旧内容包配新清单。</li>
 * </ul>
 */
export function writeAssetDigests(dataDir, pairs, { file = 'asset-digests.json', hash = '' } = {}) {
  const map = {};
  for (const [rel, sha] of pairs) {
    if (typeof rel !== 'string' || !rel || typeof sha !== 'string' || !sha) continue;
    if (!(rel in map)) map[rel] = sha;
  }
  const sorted = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k];
  const body = JSON.stringify({ version: 1, hash, digests: sorted });
  fs.writeFileSync(path.join(dataDir, file), body + '\n');
  return Object.keys(sorted).length;
}

/**
 * Writes the re-emitted `hash` into `data/<file>` with a TEXT edit, so everything else keeps
 * upstream's formatting byte-for-byte: replaces the (first, top-level) existing value when present,
 * otherwise inserts the key right after the opening `{`. Returns true when the bytes changed.
 */
export function writeManifestHash(dataDir, hash, { file = 'assets.json' } = {}) {
  if (!/^[0-9a-f]{8,64}$/.test(String(hash))) throw new Error(`refusing to write a bogus manifest hash: ${hash}`);
  const p = path.join(dataDir, file);
  const text = fs.readFileSync(p, 'utf-8');
  const re = /"hash"\s*:\s*"[^"]{1,64}"/;
  const next = re.test(text)
    ? text.replace(re, `"hash":"${hash}"`)
    : text.replace(/^(\s*\{)/, `$1"hash":"${hash}",`);
  if (next === text) return false;
  fs.writeFileSync(p, next);
  return true;
}

// ---------------------------------------------------------------- encoders (pluggable)

function run(cmd, args, { input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    if (input) child.stdin.end(input);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ code: -1, out, err: String(e.message) }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function hasCommand(cmd, args = ['--version']) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** Concurrent per-file CLI encoder pool (`argFor(src, dst)` builds the tool's argv). */
async function cliPool(name, cmd, argFor, jobs, workers, onResult) {
  const results = new Array(jobs.length);
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const i = cursor++;
      const j = jobs[i];
      const r = await run(cmd, argFor(j.src, j.dst));
      if (r.code !== 0) results[i] = { ok: false, error: `${name} exit ${r.code}: ${(r.err || r.out).trim().split('\n').slice(-1)[0] || ''}` };
      else results[i] = { ok: true, bytes: fs.existsSync(j.dst) ? fs.statSync(j.dst).size : 0 };
      onResult(++done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, worker));
  return results;
}

/** The embedded Pillow driver: one process per chunk, JSON results on stdout, one line per file. */
const PILLOW_DRIVER = `import json, os, sys
from PIL import Image

def main():
    jobfile, quality, method = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    with open(jobfile, encoding='utf-8') as fh:
        jobs = json.load(fh)
    for i, job in enumerate(jobs):
        try:
            with Image.open(job['src']) as im:
                im.load()
                if getattr(im, 'n_frames', 1) > 1:
                    print(json.dumps({'i': i, 'skip': 'animated'}), flush=True)
                    continue
                if im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info):
                    clean = im.convert('RGBA')
                else:
                    clean = im.convert('RGB')
            os.makedirs(os.path.dirname(job['dst']), exist_ok=True)
            tmp = job['dst'] + '.part'
            # convert() re-creates the pixel data, so no EXIF/ICC/timestamp rides along;
            # fixed quality/method keep the bytes deterministic for identical input.
            clean.save(tmp, 'WEBP', quality=quality, method=method, lossless=False)
            os.replace(tmp, job['dst'])
            print(json.dumps({'i': i, 'ok': True, 'bytes': os.path.getsize(job['dst'])}), flush=True)
        except Exception as e:
            print(json.dumps({'i': i, 'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}), flush=True)

if __name__ == '__main__':
    main()
`;

async function pillowBatch(driverFile, python, jobs, { quality, method, workers }, onResult) {
  const stage = path.dirname(driverFile);
  const chunks = Math.max(1, Math.min(workers, jobs.length));
  const per = Math.ceil(jobs.length / chunks);
  const results = new Array(jobs.length);
  let done = 0;
  const runs = [];
  for (let c = 0; c < chunks; c++) {
    const slice = jobs.slice(c * per, (c + 1) * per);
    if (!slice.length) continue;
    const base = c * per;
    const jobFile = path.join(stage, `chunk-${c}.json`);
    fs.writeFileSync(jobFile, JSON.stringify(slice.map((j) => ({ src: j.src, dst: j.dst }))));
    runs.push(
      (async () => {
        const child = spawn(python.cmd, [...python.pre, driverFile, jobFile, String(quality), String(method)], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let tail = '';
        child.stderr.on('data', (d) => (tail = (tail + d).slice(-2000)));
        const rl = readline.createInterface({ input: child.stdout });
        rl.on('line', (line) => {
          let r;
          try {
            r = JSON.parse(line);
          } catch {
            return; // non-JSON noise on stdout: ignore (stderr is kept for the failure message)
          }
          results[base + r.i] = r.skip ? { ok: true, skipped: r.skip } : r;
          onResult(++done, jobs.length);
        });
        const code = await new Promise((res) => child.on('close', res));
        if (code !== 0) {
          for (let i = base; i < base + slice.length; i++) {
            if (!results[i]) results[i] = { ok: false, error: `python exit ${code}: ${tail.trim().split('\n').slice(-1)[0] || ''}` };
          }
        }
      })(),
    );
  }
  await Promise.all(runs);
  for (let c = 0; c < chunks; c++) fs.rmSync(path.join(stage, `chunk-${c}.json`), { force: true });
  for (let i = 0; i < results.length; i++) if (!results[i]) results[i] = { ok: false, error: 'encoder produced no result' };
  return results;
}

/** Candidate python interpreters (probed in order; first one importing PIL wins). */
function pythonCandidates() {
  const out = [];
  if (process.env.SP_PYTHON) out.push({ cmd: process.env.SP_PYTHON, pre: [] });
  out.push({ cmd: process.platform === 'win32' ? 'python' : 'python3', pre: [] }, { cmd: 'python3', pre: [] });
  if (process.platform === 'win32') out.push({ cmd: 'py', pre: ['-3'] });
  return out;
}

/**
 * Probes the encoders available on this machine, best first. Pillow also reports its version
 * (used in the build log). Returns encoder objects; `.name`/`.version` are informational,
 * `.encodeAll(jobs, opts, onProgress) -> results[]` is the contract transcodeAssets relies on.
 */
export async function detectEncoders() {
  const found = [];
  if (await hasCommand('cwebp', ['-version'])) {
    const v = await run('cwebp', ['-version']);
    found.push({
      name: 'cwebp',
      version: (v.out.match(/[\d.]+/) || ['?'])[0],
      // -metadata none + no -mt: deterministic single-threaded encode, no EXIF/ICC/XMP carried over
      encodeAll: (jobs, o, on) => cliPool('cwebp', 'cwebp', (s, d) => ['-quiet', '-q', String(o.quality), '-m', String(o.method), '-metadata', 'none', s, '-o', d], jobs, o.workers, on),
    });
  }
  for (const cand of pythonCandidates()) {
    const probe = await run(cand.cmd, [...cand.pre, '-c', 'import PIL, sys; sys.stdout.write(PIL.__version__ + " " + sys.version.split()[0])']);
    if (probe.code !== 0) continue;
    const [pil, py] = probe.out.trim().split(/\s+/);
    found.push({
      name: 'pillow',
      version: `Pillow ${pil} / Python ${py} (${cand.cmd})`,
      python: cand,
      encodeAll: (jobs, o, on) => pillowBatch(pillowDriverFile(), cand, jobs, o, on),
    });
    break; // first working interpreter only
  }
  if (await hasCommand('magick', ['-version'])) {
    const v = await run('magick', ['-version']);
    found.push({
      name: 'magick',
      version: (v.out.match(/[\d.]+/) || ['?'])[0],
      encodeAll: (jobs, o, on) => cliPool('magick', 'magick', (s, d) => [s, '-strip', '-quality', String(o.quality), '-define', `webp:method=${o.method}`, d], jobs, o.workers, on),
    });
  }
  if (await hasCommand('ffmpeg', ['-version'])) {
    const v = await run('ffmpeg', ['-version']);
    found.push({
      name: 'ffmpeg',
      version: (v.out.match(/[\d.]+/) || ['?'])[0],
      encodeAll: (jobs, o, on) =>
        cliPool('ffmpeg', 'ffmpeg', (s, d) => ['-y', '-v', 'error', '-i', s, '-map_metadata', '-1', '-c:v', 'libwebp', '-quality', String(o.quality), '-compression_level', String(o.method), d], jobs, o.workers, on),
    });
  }
  try {
    const sharp = await import('sharp');
    const ver = sharp.default?.versions?.vips || '?';
    found.push({
      name: 'sharp',
      version: `libvips ${ver}`,
      encodeAll: async (jobs, o, on) => {
        const results = new Array(jobs.length);
        let cursor = 0;
        let done = 0;
        const worker = async () => {
          while (cursor < jobs.length) {
            const i = cursor++;
            const j = jobs[i];
            try {
              await sharp.default(j.src).webp({ quality: o.quality, effort: o.method }).toFile(j.dst);
              results[i] = { ok: true, bytes: fs.statSync(j.dst).size };
            } catch (e) {
              results[i] = { ok: false, error: String(e.message || e) };
            }
            on(++done, jobs.length);
          }
        };
        await Promise.all(Array.from({ length: Math.min(o.workers, jobs.length) }, worker));
        return results;
      },
    });
  } catch { /* sharp not installed: fine, it is the last resort */ }
  return found;
}

let driverFileCache = null;
function pillowDriverFile() {
  if (driverFileCache) return driverFileCache;
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-webp-driver-')), 'webp_driver.py');
  fs.writeFileSync(p, PILLOW_DRIVER);
  driverFileCache = p;
  return p;
}

/** First available encoder (SP_WEBP_ENCODER / `--encoder` pins one by name). */
export async function pickEncoder({ prefer } = {}) {
  const found = await detectEncoders();
  if (!found.length) return null;
  if (prefer) {
    const hit = found.find((e) => e.name === prefer);
    if (hit) return hit;
    throw new Error(`SP_WEBP_ENCODER=${prefer} requested but not available (found: ${found.map((e) => e.name).join(', ') || 'none'})`);
  }
  return found[0];
}

// ---------------------------------------------------------------- the step itself

export function webpEnabled(argv = process.argv, env = process.env) {
  if (argv.includes('--no-webp')) return false;
  const v = String(env.SP_NO_WEBP ?? '').trim().toLowerCase();
  return !(v === '1' || v === 'true' || v === 'yes');
}

/**
 * Runs the whole step against a built webroot: classify → encode (staged outside the tree) →
 * keep/skip by size → move the winners in → rewrite manifests → delete the PNGs → gate.
 * Returns the report object; logs a human summary through `logger`.
 */
export async function transcodeAssets({
  webrootDir = DEFAULT_WEBROOT,
  enabled = webpEnabled(),
  encoder = null,
  quality = Number(process.env.SP_WEBP_QUALITY) || DEFAULT_QUALITY,
  method = Number(process.env.SP_WEBP_METHOD) || DEFAULT_METHOD,
  workers = Number(process.env.SP_WEBP_WORKERS) || Math.min(8, os.cpus().length),
  logger = console,
} = {}) {
  const t0 = Date.now();
  const assetsDir = path.join(webrootDir, 'assets');
  if (!fs.existsSync(assetsDir)) throw new Error(`assets tree missing: ${assetsDir}`);
  const log = (m) => logger.log(m);

  const cls = classifyPngs(assetsDir);
  const report = {
    webrootDir,
    enabled,
    encoder: null,
    quality,
    method,
    png: { total: cls.standalone.length + cls.spine.length + cls.alreadyWebp.length, standalone: cls.standalone.length, spineSkipped: cls.spine.length, alreadyWebp: cls.alreadyWebp.length },
    attempted: 0,
    converted: 0,
    fallback: [], // { rel, pngBytes, webpBytes }
    failed: [],
    animated: [],
    bytes: { png: 0, webp: 0 },
    manifests: {},
    gate: null,
    assetsHash: null,
    seconds: 0,
  };

  if (!enabled) {
    log('transcode: disabled (--no-webp / SP_NO_WEBP) — PNGs left as-is');
  } else if (!cls.standalone.length) {
    log('transcode: no standalone PNG to convert');
  } else {
    const enc = encoder ?? (await pickEncoder({ prefer: process.env.SP_WEBP_ENCODER }));
    if (!enc) {
      throw new Error(
        'no WebP encoder found. Install one of: cwebp (libwebp-tools), python3 + Pillow (pip install Pillow), ' +
          'ImageMagick, ffmpeg (libwebp), or `npm i sharp` — or build with --no-webp / SP_NO_WEBP=1.',
      );
    }
    report.encoder = `${enc.name} (${enc.version})`;
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-webp-'));
    const jobs = cls.standalone.map((rel, i) => ({
      i,
      rel,
      src: path.join(assetsDir, ...rel.split('/')),
      dst: path.join(stage, `${i}.webp`),
    }));
    report.attempted = jobs.length;
    const sizeOf = (p) => {
      try { return fs.statSync(p).size; } catch { return 0; }
    };
    log(`transcode: encoding ${jobs.length} PNG with ${report.encoder}, q=${quality} m=${method}, ${workers} worker(s)…`);
    let last = 0;
    const relMap = new Map();
    try {
      const results = await enc.encodeAll(jobs, { quality, method, workers }, (done, total) => {
        if (done - last >= 250 || done === total) {
          last = done;
          log(`transcode: ${done}/${total}`);
        }
      });
      for (const j of jobs) {
        const r = results[j.i];
        if (!r || !r.ok) {
          report.failed.push({ rel: j.rel, error: r?.error || 'unknown encoder error' });
          continue;
        }
        if (r.skipped) {
          report.animated.push(j.rel);
          continue;
        }
        const pngBytes = sizeOf(j.src);
        if (r.bytes > 0 && r.bytes < pngBytes) {
          moveFile(j.dst, path.join(assetsDir, ...webpRel(j.rel).split('/')));
          report.bytes.png += pngBytes;
          report.bytes.webp += r.bytes;
          report.converted++;
          relMap.set(j.rel, webpRel(j.rel));
        } else {
          report.fallback.push({ rel: j.rel, pngBytes, webpBytes: r.bytes });
          fs.rmSync(j.dst, { force: true });
        }
      }
    } finally {
      // staged .webp files that won were moved out above; anything left is fallback/failure leftovers
      fs.rmSync(stage, { recursive: true, force: true });
    }

    if (report.failed.length) {
      log(`transcode: ${report.failed.length} file(s) FAILED to encode (PNG kept):`);
      for (const f of report.failed.slice(0, 10)) log(`  ! ${f.rel}: ${f.error}`);
      if (!report.converted) throw new Error(`every encode attempt failed (${report.failed.length} files) — see the lines above; is the encoder working?`);
    }
    if (report.animated.length) log(`transcode: ${report.animated.length} animated PNG kept as PNG: ${report.animated.slice(0, 5).join(', ')}`);

    if (report.converted) {
      // manifests first, PNGs after: a crash in between leaves disk ⊇ manifest (gate-safe)
      report.manifests = syncManifests(path.join(webrootDir, 'data'), relMap);
      for (const j of jobs) if (relMap.has(j.rel)) fs.unlinkSync(j.src);
      const saved = report.bytes.png - report.bytes.webp;
      log(
        `transcode: ${report.converted} PNG → WebP, ${report.bytes.png / 1048576} MB → ${report.bytes.webp / 1048576} MB ` +
          `(saved ${saved / 1048576} MB, ${((saved / report.bytes.png) * 100).toFixed(1)}%)`,
      );
      log(`transcode: manifests rewritten: ${Object.entries(report.manifests).map(([f, n]) => `${f} ${n} refs`).join(', ') || 'none'}`);
    } else {
      log('transcode: 0 conversions — manifests untouched');
    }
    if (report.fallback.length) {
      const bytes = report.fallback.reduce((a, f) => a + f.pngBytes, 0);
      log(`transcode: ${report.fallback.length} PNG kept (WebP not smaller, ${(bytes / 1048576).toFixed(1)} MB): ${report.fallback.slice(0, 5).map((f) => f.rel).join(', ')}`);
    }
  }

  report.gate = assertManifestDiskConsistency(webrootDir, { files: [...REQUIRED_MANIFESTS, ...OPTIONAL_REF_FILES] });
  log(`transcode: gate ok — ${report.gate.checked} manifest refs all exist on disk`);
  if (enabled) {
    // Re-emit the manifest `hash` as a BYTE-sensitive content hash: it is the on-device namespace of
    // the fetched-art cache (filesDir/art/cache/<hash>/), and upstream's metadata-only value would
    // never invalidate a same-path byte change (see hashReferencedBytes / the 2026-10-08 audit).
    // Runs also for 0 conversions so this path and plan-onlyTranscode agree in every case.
    const dataDir = path.join(webrootDir, 'data');
    const r = hashReferencedBytes({
      dataDir,
      readBytes: (rel) => {
        try {
          return fs.readFileSync(path.join(assetsDir, ...rel.split('/')));
        } catch {
          return null;
        }
      },
    });
    if (r.missing.length) throw new Error(`manifest hash: ${r.missing.length} referenced file(s) missing on disk (first: ${r.missing[0]})`);
    writeManifestHash(dataDir, r.hash);
    report.assetsHash = r.hash;
    // 逐文件摘要（阶段 1 方案 1）：与 hash 同源同批产出，壳侧据此做「改名复用 + 逐个校验」。
    report.digests = writeAssetDigests(dataDir, r.pairs, { hash: r.hash });
    log(`transcode: asset digests -> data/asset-digests.json (${report.digests} files)`);
    log(`transcode: manifest hash -> ${r.hash} (${r.count} referenced files, byte-sensitive)`);
  }
  report.seconds = (Date.now() - t0) / 1000;
  log(`transcode: done in ${report.seconds.toFixed(1)}s`);
  return report;
}

// ---------------------------------------------------------------- plan-only (no embedded assets)

/**
 * Computes the SAME PNG→WebP conversion plan a full build would, but WITHOUT copying or encoding
 * anything into the webroot — it only rewrites the manifests. Used by build-webroot --no-assets:
 * the APK ships no art bytes, yet `data/assets.json` must carry the identical `.webp` references a
 * with-assets build bakes, or the (WebP) CDN tree 404s every converted file (~4000 of them).
 *
 * The decision input is the UPSTREAM source tree (`<extract>/public/assets`), which is byte-identical
 * to the `webroot/assets` a full build classifies and encodes. The keep/skip rule is the exact same
 * code path (`classifyPngs`, the same encoder, the same `webpBytes < pngBytes` fallback, the same
 * `syncManifests`), so both jobs emit a byte-identical `data/assets.json` for the same input.
 */
export async function planOnlyTranscode({
  sourceAssetsDir,
  dataDir,
  enabled = webpEnabled(),
  encoder = null,
  quality = Number(process.env.SP_WEBP_QUALITY) || DEFAULT_QUALITY,
  method = Number(process.env.SP_WEBP_METHOD) || DEFAULT_METHOD,
  workers = Number(process.env.SP_WEBP_WORKERS) || Math.min(8, os.cpus().length),
  logger = console,
} = {}) {
  const log = (m) => logger.log(m);
  if (!sourceAssetsDir || !fs.existsSync(sourceAssetsDir)) {
    throw new Error(`plan-only transcode needs the upstream source assets tree: ${sourceAssetsDir}`);
  }
  const report = { converted: 0, attempted: 0, fallback: [], failed: [], animated: [], manifests: {}, encoder: null, assetsHash: null };
  if (!enabled) {
    log('transcode (plan-only): disabled (--no-webp / SP_NO_WEBP) — manifests left as-is');
    return report;
  }
  const cls = classifyPngs(sourceAssetsDir);
  report.attempted = cls.standalone.length;
  if (!cls.standalone.length) log('transcode (plan-only): no standalone PNG to convert');
  const relMap = new Map();
  const targetDst = new Map(); // final .webp rel -> staged bytes of the same conversion plan
  let stage = null;
  try {
    if (cls.standalone.length) {
      const enc = encoder ?? (await pickEncoder({ prefer: process.env.SP_WEBP_ENCODER }));
      if (!enc) {
        throw new Error(
          'no WebP encoder found. Install one of: cwebp (libwebp-tools), python3 + Pillow (pip install Pillow), ' +
            'ImageMagick, ffmpeg (libwebp), or `npm i sharp` — or build with --no-webp / SP_NO_WEBP=1. ' +
            '(--no-assets still needs it: the manifest must match the transcoded CDN tree.)',
        );
      }
      report.encoder = `${enc.name} (${enc.version})`;
      stage = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-webp-plan-'));
      const jobs = cls.standalone.map((rel, i) => ({
        i,
        rel,
        src: path.join(sourceAssetsDir, ...rel.split('/')),
        dst: path.join(stage, `${i}.webp`),
      }));
      const sizeOf = (p) => {
        try { return fs.statSync(p).size; } catch { return 0; }
      };
      log(`transcode (plan-only): encoding ${jobs.length} PNG with ${report.encoder}, q=${quality} m=${method}, ${workers} worker(s)…`);
      const results = await enc.encodeAll(jobs, { quality, method, workers }, () => {});
      for (const j of jobs) {
        const r = results[j.i];
        if (!r || !r.ok) {
          report.failed.push({ rel: j.rel, error: r?.error || 'unknown encoder error' });
          continue;
        }
        if (r.skipped) {
          report.animated.push(j.rel);
          continue;
        }
        const pngBytes = sizeOf(j.src);
        if (r.bytes > 0 && r.bytes < pngBytes) {
          report.converted++;
          relMap.set(j.rel, webpRel(j.rel));
          targetDst.set(webpRel(j.rel), j.dst);
        } else {
          report.fallback.push({ rel: j.rel, pngBytes, webpBytes: r.bytes });
        }
      }
      if (report.failed.length && !report.converted) {
        throw new Error(`every encode attempt failed (${report.failed.length} files) — see the lines above; is the encoder working?`);
      }
    }
    if (report.converted) {
      // manifests only: no bytes are moved and nothing is deleted (the assets tree is not embedded)
      report.manifests = syncManifests(dataDir, relMap);
      log(`transcode (plan-only): ${report.converted} PNG would convert to WebP; manifests rewritten: ${Object.entries(report.manifests).map(([f, n]) => `${f} ${n} refs`).join(', ') || 'none'}`);
    } else {
      log('transcode (plan-only): 0 conversions — manifests untouched');
    }
    // Same byte-sensitive manifest hash as the full build (the device cache namespace): converted
    // refs hash the staged .webp bytes, every other ref hashes the source file — byte-identical to
    // what a full build's webroot ends up carrying. Computed before the stage is removed.
    const r = hashReferencedBytes({
      dataDir,
      readBytes: (rel) => {
        try {
          return fs.readFileSync(targetDst.get(rel) || path.join(sourceAssetsDir, ...rel.split('/')));
        } catch {
          return null;
        }
      },
    });
    if (r.missing.length) {
      throw new Error(`plan-only manifest hash: ${r.missing.length} referenced file(s) not resolvable (first: ${r.missing[0]}) — upstream tree and manifests disagree`);
    }
    writeManifestHash(dataDir, r.hash);
    report.assetsHash = r.hash;
    report.digests = writeAssetDigests(dataDir, r.pairs, { hash: r.hash });
    log(`transcode (plan-only): asset digests -> data/asset-digests.json (${report.digests} files)`);
    log(`transcode (plan-only): manifest hash -> ${r.hash} (${r.count} referenced files, byte-sensitive)`);
  } finally {
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
  }
  if (report.fallback.length) {
    log(`transcode (plan-only): ${report.fallback.length} PNG kept (WebP not smaller): ${report.fallback.slice(0, 5).map((f) => f.rel).join(', ')}`);
  }
  return report;
}

// ---------------------------------------------------------------- CLI

async function main() {
  const argv = process.argv;
  const val = (name) => {
    const i = argv.indexOf(name);
    return i > 0 ? argv[i + 1] : undefined;
  };
  const webroot = val('--webroot') || DEFAULT_WEBROOT;

  if (argv.includes('--check')) {
    const r = assertManifestDiskConsistency(webroot, { files: [...REQUIRED_MANIFESTS, ...OPTIONAL_REF_FILES] });
    console.log(`gate ok — ${r.checked} manifest refs all exist on disk (${webroot})`);
    return;
  }

  const report = await transcodeAssets({
    webrootDir: webroot,
    enabled: webpEnabled(argv),
    quality: Number(val('--quality')) || DEFAULT_QUALITY,
    method: Number(val('--method')) || DEFAULT_METHOD,
    workers: Number(val('--workers')) || undefined,
  });
  console.log('transcode-report: ' + JSON.stringify({
    png: report.png,
    converted: report.converted,
    fallback: report.fallback.length,
    failed: report.failed.length,
    animated: report.animated.length,
    bytes: report.bytes,
    manifests: report.manifests,
    gate: { checked: report.gate.checked, missing: report.gate.missing.length },
    encoder: report.encoder,
    seconds: report.seconds,
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
