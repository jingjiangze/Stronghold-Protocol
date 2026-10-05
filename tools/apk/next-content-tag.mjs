#!/usr/bin/env node
// tools/apk/next-content-tag.mjs — 打印下一个内容 buildTag（把 X.Y.Z 的补丁位 +1）。
//
// buildTag 是设备端 Updater 用来做“数值比较防降级”的单调排序键；面向人的内容身份是
// manifest 里的 contentVersion（如 v0.1.1-052e9067）——修订版 Commit 04：壳版本与内容版本
// 彻底分离，buildTag 只做排序、contentVersion/upstreamSha 做识别。
//
// 当前值来源（优先级）：--current <tag> → R2 site/manifest.json（生产清单）→ 仓库内置基线
//   tools/apk/shell/manifest.json。
//
//   node tools/apk/next-content-tag.mjs [--current shell-v2.8.1]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const R2_MANIFEST = 'https://weishucdn.jiangjiangze.icu/site/manifest.json';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

async function current() {
  const explicit = arg('--current');
  if (explicit) return explicit.trim();
  try {
    const res = await fetch(`${R2_MANIFEST}?cb=${Date.now()}`, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const m = await res.json();
      if (m && typeof m.buildTag === 'string' && m.buildTag) return m.buildTag;
    }
  } catch { /* fall through to the baked baseline */ }
  const baked = path.join(here, 'shell', 'manifest.json');
  if (fs.existsSync(baked)) {
    const t = JSON.parse(fs.readFileSync(baked, 'utf8')).buildTag;
    if (t) return t;
  }
  throw new Error('cannot determine the current content buildTag (R2 unreachable and baked manifest missing)');
}

async function main() {
  const tag = await current();
  if (!/(\d+)\.(\d+)\.(\d+)/.test(tag)) throw new Error(`current buildTag "${tag}" has no X.Y.Z component`);
  const next = tag.replace(/(\d+)\.(\d+)\.(\d+)/, (_, a, b, c) => `${a}.${b}.${Number(c) + 1}`);
  process.stdout.write(`${next}\n`);
}

main().catch((e) => {
  console.error(`next-content-tag FAILED: ${e.message}`);
  process.exit(1);
});
