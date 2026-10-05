#!/usr/bin/env node
// publish-repo-files.mjs — PUT working-tree files onto the fork via the GitHub Contents API.
// The fork's history is API-driven by design (no local commit/push), so this is the safe path
// for batch file updates.
//
//   node tools/apk/publish-repo-files.mjs <path...|path=source...> [--message "..."]
//
// content-PR flow (real-time audit, 2026-10-05 定版):
//   node tools/apk/publish-repo-files.mjs <path...> --batch <name> --pr [--pr-title "..."] [--pr-body-file f]
//     --batch <name>   → 目标分支 content/<name>（从 --base 建，默认 apk）
//     --branch <name>  → 任意目标分支（缺省 apk —— 不带新 flag 时行为与旧版完全一致）
//     --pr             → 推完后开/更新审计 PR（title 前缀 [content]，body 为固定模板或 --pr-body-file）
//     --base <name>    → PR 的 base 分支（默认 apk）
//   之后用 content-pr-merge.mjs 等审计窗口并 squash 合并；发布权仍在 promote（本工具不发布）。
//
// Every file is normalised to LF before upload: .gitattributes declares `* text=auto` with
// eol=lf for js/mjs/json/md, but earlier ad-hoc API publishes pushed CRLF blobs verbatim —
// normalising here stops that drift instead of adding to it.
//
// Auth: GH_TOKEN or GITHUB_TOKEN must be set (never written to disk).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const OWNER = 'jingjiangze';
const NAME = 'Stronghold-Protocol';

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GH_TOKEN (or GITHUB_TOKEN) is required');
  process.exit(1);
}

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--message', '--branch', '--batch', '--base', '--pr-title', '--pr-body-file']);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const message = opt('--message', 'shell: batch publish');
const base = opt('--base', 'apk');
const batch = opt('--batch', null);
const targetBranch = opt('--branch', null) || (batch ? `content/${batch}` : base);
const wantPr = args.includes('--pr');

const entries = args
  .filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (i > 0 && VALUE_FLAGS.has(args[i - 1])) return false;
    return true;
  })
  .map((a) => {
    const eq = a.indexOf('=');
    // path=source lets one target take its content from another file (e.g. an upstream blob
    // extracted with `git show <rev>:<path> > tmp`), instead of rewriting the working tree.
    return eq < 0 ? { target: a, source: a } : { target: a.slice(0, eq), source: a.slice(eq + 1) };
  });
if (!entries.length) {
  console.error('usage: node tools/apk/publish-repo-files.mjs <path...> [--message "..."]');
  console.error('       node tools/apk/publish-repo-files.mjs <path...> --batch <name> --pr   # 审计 PR 流程');
  process.exit(1);
}
if (wantPr && targetBranch === base) {
  console.error('--pr requires a target branch other than the base — pass --batch <name> or --branch <name>');
  process.exit(1);
}

const api = (p, init) =>
  fetch(`https://api.github.com/repos/${OWNER}/${NAME}/${p}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'stronghold-publish',
    },
  });

async function ensureBranch(name, from) {
  const cur = await api(`git/ref/heads/${name}`);
  if (cur.status === 200) return;
  if (cur.status !== 404) {
    console.error(`FAIL (branch lookup ${cur.status}): ${name}`);
    process.exit(1);
  }
  const fromRef = await api(`git/ref/heads/${from}`);
  if (!fromRef.ok) {
    console.error(`FAIL (base branch ${from} not found)`);
    process.exit(1);
  }
  const sha = (await fromRef.json()).object.sha;
  const created = await api('git/refs', {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${name}`, sha }),
  });
  if (!created.ok) {
    console.error(`FAIL (branch create ${created.status}): ${(await created.text()).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`branch created: ${name} (from ${from}@${sha.slice(0, 8)})`);
}

await ensureBranch(targetBranch, base);

let failed = 0;
for (const { target, source } of entries) {
  const abs = path.isAbsolute(source) ? source : path.join(repo, source);
  if (!fs.existsSync(abs)) {
    console.error(`skip (no such file): ${source}`);
    failed++;
    continue;
  }
  const text = fs.readFileSync(abs, 'utf-8').replace(/\r\n/g, '\n');
  const content = Buffer.from(text, 'utf-8').toString('base64');

  const cur = await api(`contents/${target}?ref=${targetBranch}`);
  let sha;
  if (cur.status === 200) sha = (await cur.json()).sha;
  else if (cur.status !== 404) {
    console.error(`FAIL (lookup ${cur.status}): ${target}`);
    failed++;
    continue;
  }

  const put = await api(`contents/${target}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content, sha, branch: targetBranch }),
  });
  if (put.ok) {
    const j = await put.json();
    console.log(`ok: ${target} → ${j.commit.sha.slice(0, 8)}`);
  } else {
    console.error(`FAIL (${put.status}): ${target}: ${(await put.text()).slice(0, 200)}`);
    failed++;
  }
}
console.log(`\npublished ${entries.length - failed}/${entries.length} files (branch ${targetBranch}, LF-normalised)`);

if (wantPr && failed === 0) {
  const bodyFile = opt('--pr-body-file', null);
  const body = bodyFile
    ? fs.readFileSync(bodyFile, 'utf-8')
    : [
        `## 改动\n${message}\n`,
        `## 触及文件\n${entries.map((e) => `- \`${e.target}\``).join('\n')}\n`,
        '## 验证证据\n- 双树锚点：\n- 模板门禁：\n- 单测：\n- 线上实测：\n',
        '## 风险与回滚\n- \n',
        '<!-- 审计门：任何 CHANGES_REQUESTED 或 do-not-merge 标签会阻断自动合并；窗口内无阻断则 squash 合并 -->',
      ].join('\n');
  const rawTitle = opt('--pr-title', null) || message;
  // 标题策略：审计流水线约定 [content] 前缀（评审发现 #4：显式 --pr-title 也不能绕过）。
  const title = rawTitle.startsWith('[content]') ? rawTitle : `[content] ${rawTitle}`;
  const open = await api(`pulls?head=${OWNER}:${targetBranch}&base=${base}&state=open`);
  const list = open.ok ? await open.json() : [];
  let prn;
  if (list.length) {
    prn = list[0].number;
    const updated = await api(`pulls/${prn}`, { method: 'PATCH', body: JSON.stringify({ title, body }) });
    if (!updated.ok) {
      // 评审发现 #3：PATCH 失败必须响亮退出，不能假报 "PR updated"。
      console.error(`FAIL (PR update ${updated.status}): ${(await updated.text()).slice(0, 300)}`);
      process.exit(1);
    }
    console.log(`PR updated: #${prn} (${title})`);
  } else {
    const created = await api('pulls', {
      method: 'POST',
      body: JSON.stringify({ title, head: targetBranch, base, body }),
    });
    if (!created.ok) {
      console.error(`FAIL (PR create ${created.status}): ${(await created.text()).slice(0, 300)}`);
      process.exit(1);
    }
    prn = (await created.json()).number;
    console.log(`PR created: #${prn} (${title})`);
  }
  console.log(`audit PR: https://github.com/${OWNER}/${NAME}/pull/${prn}`);
  console.log(`next: node tools/apk/content-pr-merge.mjs --pr ${prn}   # 等审计窗口 → squash 合并`);
}

process.exit(failed ? 1 : 0);
