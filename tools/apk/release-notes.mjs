#!/usr/bin/env node
/* ==========================================================================================
   tools/apk/release-notes.mjs — 生成 Release 说明。

   为什么需要它：apk-re 的 release 步骤原先写死了两句话（版本号 + 构建号），玩家在 Release
   页面看不到「这一版改了什么」。本脚本按固定优先级取说明，让每版都有内容可读。

   取法（顺序即优先级）：
     ① docs/RELEASES.md 里有 `## shell-v<版本>-vc<versionCode>` 这一节 → 直接用它的正文。
        （人工写的最准：玩家视角变化、修复现象、升级注意）
     ② 没有 → 从 <上一个 release tag>..HEAD 的提交历史生成，按 conventional commit 前缀分组。
     ③ 都没有 → 只有版本号一行，并打 ::warning:: 让 CI 日志显眼。

   用法：
     node tools/apk/release-notes.mjs --version 0.3.3 --vc 2066
     node tools/apk/release-notes.mjs --version 0.3.3 --vc 2066 --prev-tag shell-v0.3.3-vc2065
     node tools/apk/release-notes.mjs --version 0.3.3 --vc 2066 --out notes.md
     node tools/apk/release-notes.mjs --version 0.3.3 --vc 2066 --json      # 给 CI 读

   退出码：0 = 生成了（哪怕只有兜底）；1 = 参数错。
   ========================================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const has = (n) => argv.includes(`--${n}`);

const version = opt('version');
const vc = opt('vc');
const prevTag = opt('prev-tag');
const outPath = opt('out');

if (!version || !vc) {
  console.error('release-notes: --version <x.y.z> and --vc <n> are required');
  process.exit(1);
}

const tag = `shell-v${version}-vc${vc}`;

/* ---- ① docs/RELEASES.md 的对应小节 ---------------------------------------------------- */
function fromReleasesDoc() {
  const file = path.join(repo, 'docs', 'RELEASES.md');
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n');

  // 找 `## shell-v...` 标题（只认二级标题，避免误匹配代码块里的示例）
  // 标题形如 `## shell-v0.3.3-vc2065 — 2026-11-03`：tag 后面允许任意后缀（日期、备注），
  // 但**必须**紧跟在 `## ` 之后，避免误匹配正文里提到 tag 的句子。
  const headRe = new RegExp(`^##\\s+${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`);
  // 一次遍历：维护 ``` 围栏状态，只在**围栏外**接受标题匹配。
  // （2026-11-04 修：原来是 findIndex 取第一个匹配，而 §2 的骨架示例在代码块里、
  //   排位比真实记录更靠前，于是「跳过代码块」直接 return null，永远找不到真小节。）
  let inFence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^```/.test(t)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (headRe.test(t)) { start = i; break; }
  }
  if (start < 0) return null;

  // 取到下一个同级或更高级标题为止
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i])) { end = i; break; }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body || null;
}

/* ---- ② 从提交历史生成 ------------------------------------------------------------------ */
const GROUPS = [
  ['feat', '新功能'],
  ['fix', '修复'],
  ['perf', '性能'],
  ['refactor', '重构'],
  ['docs', '文档'],
  ['chore', '构建与杂项'],
];
const ORDER = [...GROUPS.map(([t]) => t), 'other'];
const LABEL = Object.fromEntries([...GROUPS, ['other', '其他改动']]);

/** 解析 `type(scope)!: subject`；解析不出来归 other。 */
function parseSubject(line) {
  const m = /^([a-z]+)(?:\([^)]*\))?(!)?:\s+(.*)$/.exec(line.trim());
  if (!m) return { type: 'other', bang: false, subject: line.trim() };
  const type = GROUPS.some(([t]) => t === m[1]) ? m[1] : 'other';
  return { type, bang: !!m[2], subject: m[3] };
}

function commitRange() {
  // 有 --prev-tag 就用它..HEAD；没有就用上一个 tag（按 versionCode 排序取最大）
  if (prevTag) return `${prevTag}..HEAD`;
  try {
    const tags = execFileSync('git', ['tag', '--list', 'shell-v*'], { cwd: repo, encoding: 'utf-8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
    if (!tags.length) return null;
    // 按 versionCode 数值排序，取最大的那个（排除当前 tag）
    const vcOf = (t) => Number((/-vc(\d+)$/.exec(t) || [])[1] || -1);
    const prev = tags.filter((t) => t !== tag).sort((a, b) => vcOf(b) - vcOf(a))[0];
    return prev ? `${prev}..HEAD` : null;
  } catch { return null; }
}

function fromGit() {
  const range = commitRange();
  if (!range) return null;
  let raw = '';
  try {
    raw = execFileSync('git', ['log', '--no-merges', '--format=%s', range], { cwd: repo, encoding: 'utf-8' });
  } catch { return null; }
  const subjects = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!subjects.length) return null;

  // 去掉本仓「记账类」噪音：纯 docs/chore 的自动提交仍然保留，但把 release-notes 自身排除
  const grouped = new Map();
  for (const s of subjects) {
    if (/^release: shell-v/.test(s)) continue;
    const { type, bang, subject } = parseSubject(s);
    if (!grouped.has(type)) grouped.set(type, []);
    grouped.get(type).push(bang ? `${subject} ⚠️ 破坏性` : subject);
  }
  if (!grouped.size) return null;

  const out = [];
  for (const t of ORDER) {
    const items = grouped.get(t);
    if (!items || !items.length) continue;
    out.push(`### ${LABEL[t]}`, '');
    for (const it of items) out.push(`- ${it}`);
    out.push('');
  }
  return out.join('\n').trim() || null;
}

/* ---- 组装 ------------------------------------------------------------------------------ */
const manual = fromReleasesDoc();
const auto = manual ? null : fromGit();

const parts = [];
parts.push(`**版本**：${version}（versionCode ${vc}）`);

if (manual) {
  parts.push('', manual);
  parts.push('', '> 本版说明由 `docs/RELEASES.md` 提供。');
} else if (auto) {
  parts.push('', '> 本版没有在 `docs/RELEASES.md` 里写说明，以下按提交历史自动生成。');
  parts.push('', auto);
  console.error('::warning::docs/RELEASES.md 里没有 ' + tag + ' 这一节 —— Release 说明退回按提交历史生成');
} else {
  parts.push('', '本版没有可展示的更新说明。');
  console.error('::warning::' + tag + ' 既没有 RELEASES.md 小节，也没有可用的提交历史 —— Release 说明只有版本号');
}

const body = parts.join('\n').trim() + '\n';

if (has('json')) {
  process.stdout.write(JSON.stringify({ tag, version, vc, source: manual ? 'releases-md' : auto ? 'git' : 'fallback', body }));
} else if (outPath) {
  fs.writeFileSync(outPath, body);
  console.log(`release-notes: ${tag} -> ${outPath} (source=${manual ? 'docs/RELEASES.md' : auto ? 'git log' : 'fallback'})`);
} else {
  process.stdout.write(body);
}
