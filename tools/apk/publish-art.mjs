#!/usr/bin/env node
// tools/apk/publish-art.mjs — 素材 pack 的 R2 发布器（对齐 publish-manifest.mjs 的 rclone 模式）。
//
//   node tools/apk/publish-art.mjs --packs <art-packs.json> --art-version <N> [--packs-dir <dir>]
//        [--dry-run] [--out <art-index.json>]
//
// 上传（只写本线的 -re 命名空间，见 line.mjs）：
//   assets-re/packs/<id>-<N>.zip      每个 pack 一个对象，Cache-Control immutable
//   assets-re/art-index.json          人/诊断用的索引：[{id,sha256,size,version}]
//
// SAFETY: 每个本地 zip 在上传前用 sha256 与 art-packs.json 的记录核对（不符即失败退出）——签名清单
// 里写的 sha256 必须描述真正被上传的字节。凭据只走 rclone 配置（env SP_RCLONE / SP_RCLONE_CFG），
// 源码/输出里不出现任何明文凭据。--dry-run 只打印命令，不执行、不写文件。
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS_DIR, r2 } from './line.mjs';
import { packZipName, PACK_ID_RE } from './make-art-packs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const DIST = path.resolve(repo, '..', 'dl-cache', 'dist');
const RCLONE = process.env.SP_RCLONE || 'C:/Users/16891/AppData/Local/rclone/rclone.exe';
const RCLONE_CFG = process.env.SP_RCLONE_CFG || path.resolve(repo, '..', 'dl-cache', 'rclone-r2.conf');

const DRY = process.argv.includes('--dry-run');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** rclone 上传参数：与 release-re.mjs 的 slim 上传保持一致（immutable 缓存 + 大文件分片）。 */
export function uploadArgs(local, r2key) {
  return ['--config', RCLONE_CFG, 'copyto', local, r2(r2key),
    '--header-upload', 'Cache-Control: public, max-age=31536000, immutable',
    '--s3-upload-cutoff', '64M', '--s3-chunk-size', '64M', '--transfers', '8',
    '--retries', '5', '--low-level-retries', '20', '--checksum',
    '--ignore-times', '--stats-one-line', '--stats', '30s'];
}

/** 索引条目：art-index.json 的每一项（list of {id,sha256,size,version}）。 */
export function indexEntry(pack, artVersion) {
  return { id: pack.id, sha256: pack.sha256, size: pack.size, version: artVersion };
}

function run(cmd, argv) {
  console.log(`$ ${cmd} ${argv.join(' ')}`.slice(0, 240));
  if (DRY) return;
  execFileSync(cmd, argv, { stdio: ['ignore', 'inherit', 'inherit'] });
}

function main() {
  const artVersion = Number(arg('--art-version'));
  if (!Number.isInteger(artVersion) || artVersion < 1) throw new Error('--art-version <N> (positive integer) is required');
  const packsFile = arg('--packs') || path.join(DIST, 'art-packs.json');
  const packsDir = arg('--packs-dir') || path.join(DIST, 'art-packs');
  const out = arg('--out') || path.join(DIST, 'art-index.json');
  const packs = JSON.parse(fs.readFileSync(packsFile, 'utf8'));
  if (!Array.isArray(packs) || !packs.length) throw new Error(`${packsFile}: expected a non-empty pack array`);

  const uploads = [];
  for (const p of packs) {
    if (!PACK_ID_RE.test(String(p.id))) throw new Error(`bad pack id ${JSON.stringify(p.id)}`);
    const file = path.join(packsDir, packZipName(p.id, artVersion));
    if (!fs.existsSync(file)) throw new Error(`pack zip missing: ${file} (run make-art-packs.mjs first)`);
    const got = sha256(file);
    if (got !== p.sha256) throw new Error(`pack ${p.id}: sha256 mismatch — recorded ${p.sha256}, file ${got}; refusing to upload`);
    uploads.push({ file, key: `${ASSETS_DIR}/packs/${packZipName(p.id, artVersion)}` });
  }

  const index = packs.map((p) => indexEntry(p, artVersion));
  if (!DRY) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(index, null, 2) + '\n');
  }
  console.log(`${DRY ? '[dry-run] ' : ''}art-index.json: ${out} (${index.length} pack(s), artVersion ${artVersion})`);

  for (const u of uploads) run(RCLONE, uploadArgs(u.file, u.key));
  run(RCLONE, uploadArgs(out, `${ASSETS_DIR}/art-index.json`));
  console.log(`${DRY ? '[dry-run] would upload' : 'uploaded'}: ${uploads.map((u) => u.key).join(', ')} + ${ASSETS_DIR}/art-index.json`);
}

const isEntry = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntry) {
  main();
}
