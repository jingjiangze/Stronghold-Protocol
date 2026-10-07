// tools/apk/sync-names.mjs — 把名字策略的真源同步到 extras（发布形态）。
//
// 为什么需要这一步：webroot 是从**上游 zip** 组装出来的（build-webroot.mjs），仓库树里的
// `shared/**` 不会进 webroot；新文件唯一能进 webroot 的通道是 `tools/apk/extras/public/**`
// （extras/public/* 镜像 webroot 根）。所以 `shared/names.js` + `shared/names-words.js` 是**真源**，
// 这个脚本把它们**逐字节**复制到 `tools/apk/extras/public/shared/`。
//
// `test/names.test.js` 断言两份逐字节一致 —— 只改一边会被 CI 抓住。
//
// usage: node tools/apk/sync-names.mjs [--check]
//   --check 只校验、不写（CI/本地核对用；不一致时退出码 1）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const FILES = ['names.js', 'names-words.js'];
const srcDir = path.join(repo, 'shared');
const dstDir = path.join(here, 'extras', 'public', 'shared');
const check = process.argv.includes('--check');

let bad = 0;
for (const name of FILES) {
  const src = path.join(srcDir, name);
  const dst = path.join(dstDir, name);
  if (!fs.existsSync(src)) { console.error(`missing source: shared/${name}`); bad++; continue; }
  const a = fs.readFileSync(src);
  const b = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
  if (b && a.equals(b)) { console.log(`ok: shared/${name} == extras/public/shared/${name}`); continue; }
  if (check) { console.error(`OUT OF SYNC: shared/${name} 与 extras 副本不一致（跑 node tools/apk/sync-names.mjs）`); bad++; continue; }
  fs.mkdirSync(dstDir, { recursive: true });
  fs.writeFileSync(dst, a);
  console.log(`synced: shared/${name} → tools/apk/extras/public/shared/${name} (${a.length} B)`);
}
process.exit(bad ? 1 : 0);
