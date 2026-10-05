#!/usr/bin/env node
// content-pr-merge.mjs — [content] PR 的审计窗口等待与 squash 合并（content-PR 实时审计流程，2026-10-05 定版）。
//
//   node tools/apk/content-pr-merge.mjs --pr 12 [--window 600] [--require-approve] [--no-merge] [--merge-on-review]
//   node tools/apk/content-pr-merge.mjs --branch content/<name> ...
//
// 语义：
//   · 窗口内轮询（20s 间隔）：任一 reviewer 的 CHANGES_REQUESTED，或 --block-labels 中的标签
//     → 立即停止（PR 不动，exit 2）；
//   · --merge-on-review：首个 Sourcery 审查出现且无阻断即提前合并（默认等满窗口，给其他 agent 时间）；
//   · --require-approve：窗口内必须出现 APPROVED 才合并，否则 exit 3（严格模式）；
//   · 窗口结束、无阻断 → 检查 mergeable 后 squash 合并并删除 head 分支；
//   · mergeable=false → exit 4（把本地分支 rebase 到最新 apk 重新推，再重跑本脚本）。
// 安全护栏：只处理 base=apk 且 head 以 content/ 开头的 PR —— 绝不误碰 promote/其他 PR。
//
// 退出码：0=合并(或 --no-merge 干跑) / 1=错误 / 2=被阻断 / 3=严格模式未获批准 / 4=冲突需 rebase
//
// Auth: GH_TOKEN or GITHUB_TOKEN（与 publish-repo-files.mjs 同一把）。
import process from 'node:process';

const OWNER = 'jingjiangze';
const NAME = 'Stronghold-Protocol';
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GH_TOKEN (or GITHUB_TOKEN) is required');
  process.exit(1);
}

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const prArg = opt('--pr', null);
const branchArg = opt('--branch', null);
const windowSec = Math.max(20, Number(opt('--window', '600')) || 600);
const requireApprove = args.includes('--require-approve');
const mergeOnReview = args.includes('--merge-on-review');
const noMerge = args.includes('--no-merge');
const blockLabels = opt('--block-labels', 'do-not-merge,audit-hold')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (!prArg && !branchArg) {
  console.error('usage: node tools/apk/content-pr-merge.mjs --pr <n> [--window 600] [--require-approve] [--no-merge]');
  console.error('       node tools/apk/content-pr-merge.mjs --branch content/<name> ...');
  process.exit(1);
}

const api = (p, init) =>
  fetch(`https://api.github.com/repos/${OWNER}/${NAME}/${p}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'stronghold-content-pr',
    },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pr;
if (prArg) {
  const res = await api(`pulls/${prArg}`);
  if (!res.ok) {
    console.error(`FAIL (pull ${prArg}: ${res.status})`);
    process.exit(1);
  }
  pr = await res.json();
} else {
  const res = await api(`pulls?head=${OWNER}:${branchArg}&state=open`);
  const list = res.ok ? await res.json() : [];
  if (!list.length) {
    console.error(`no open PR for ${branchArg}`);
    process.exit(1);
  }
  pr = list[0];
}
const prn = pr.number;
const head = pr.head.ref;
const author = pr.user.login;
if (pr.base.ref !== 'apk' || !head.startsWith('content/')) {
  console.error(`refusing: PR #${prn} is ${head} → ${pr.base.ref} (only content/* → apk goes through this gate)`);
  process.exit(1);
}
console.log(
  `PR #${prn} [${head} → apk] by ${author} · window ${windowSec}s` +
    `${requireApprove ? ' · require-approve' : ''}${mergeOnReview ? ' · merge-on-review' : ''}`,
);

let sawReview = false;
let sawApprove = false;
for (let t = 0; t < windowSec; t += 20) {
  const st = await api(`pulls/${prn}`);
  if (st.ok) {
    const s = await st.json();
    if (s.state !== 'open') {
      console.log(`PR #${prn} is now ${s.state}${s.merged ? ' (merged)' : ''} — nothing to do`);
      process.exit(s.merged ? 0 : 1);
    }
  }
  const revRes = await api(`pulls/${prn}/reviews?per_page=100`);
  const reviews = revRes.ok ? await revRes.json() : [];
  const others = reviews.filter((r) => r.user.login !== author);
  const changes = others.filter((r) => r.state === 'CHANGES_REQUESTED');
  if (changes.length) {
    console.error(`BLOCKED: CHANGES_REQUESTED on PR #${prn}:`);
    for (const r of changes) console.error(`  - ${r.user.login}: ${r.html_url}`);
    console.error('PR left open; fix the findings, push again, then re-run this script.');
    process.exit(2);
  }
  if (others.some((r) => r.state === 'APPROVED')) sawApprove = true;
  const sourcery = others.filter((r) => r.user.login === 'sourcery-ai[bot]');
  if (sourcery.length && !sawReview) {
    sawReview = true;
    const last = sourcery[sourcery.length - 1];
    console.log(`audit review in: ${last.html_url} (state=${last.state})`);
  }
  const labRes = await api(`issues/${prn}/labels`);
  const labels = (labRes.ok ? await labRes.json() : []).map((l) => l.name);
  const hit = labels.filter((l) => blockLabels.includes(l));
  if (hit.length) {
    console.error(`BLOCKED: label ${hit.join(', ')} on PR #${prn} — PR left open`);
    process.exit(2);
  }
  if (mergeOnReview && sawReview && (!requireApprove || sawApprove)) break;
  if (t > 0 && t % 100 === 0) console.log(`… waiting (${t}s/${windowSec}s)`);
  await sleep(20000);
}

if (requireApprove && !sawApprove) {
  console.error(`no APPROVED review within ${windowSec}s (require-approve) — PR #${prn} left open`);
  process.exit(3);
}
if (!sawReview) {
  console.warn('no audit review seen in the window — check the Sourcery PR-review toggle (see the A1 report)');
}
if (noMerge) {
  console.log(`--no-merge: window passed with no blocking; PR #${prn} would be squash-merged`);
  process.exit(0);
}
const fin = await api(`pulls/${prn}`);
const finJson = fin.ok ? await fin.json() : {};
if (finJson.mergeable === false) {
  console.error(`PR #${prn} is not mergeable (conflicts with ${pr.base.ref}) — rebase the branch on the latest apk, push again, re-run`);
  process.exit(4);
}
const merged = await api(`pulls/${prn}/merge`, {
  method: 'PUT',
  body: JSON.stringify({ merge_method: 'squash', commit_title: `${pr.title} (#${prn})` }),
});
if (!merged.ok) {
  console.error(`FAIL (merge ${merged.status}): ${(await merged.text()).slice(0, 300)}`);
  process.exit(1);
}
const j = await merged.json();
console.log(`merged (squash): ${j.sha.slice(0, 8)} — ${pr.title}`);
const del = await api(`git/refs/heads/${head}`, { method: 'DELETE' });
console.log(del.ok ? `branch deleted: ${head}` : `note: branch ${head} not deleted (${del.status})`);
console.log(`next: gh workflow run sync-upstream.yml --repo ${OWNER}/${NAME} --ref master -f force=true`);
process.exit(0);
