#!/usr/bin/env node
// content-pr-merge.mjs — [content] PR 的审计窗口等待与 squash 合并（content-PR 实时审计流程，2026-10-05 定版）。
//
//   node tools/apk/content-pr-merge.mjs --pr 12 [--window 600] [--require-approve] [--no-merge] [--merge-on-review]
//   node tools/apk/content-pr-merge.mjs --branch content/<name> ...
//
// 语义：
//   · 窗口内轮询（20s）：任一 reviewer 的【最新】review 为 CHANGES_REQUESTED，或 PR 出现
//     --block-labels 标签 → 立即停止（PR 不动，exit 2）；窗口结束后、合并前再做一次终局复核，无盲区；
//   · 轮次语义：只把「晚于当前 head 提交时间」的 review 当作有效审查——改完重推后必须等新一轮
//     审查，不会被上一轮的陈旧 review 骗过合并（阻断判定仍按每个 reviewer 的最新状态）；
//   · --merge-on-review：首个有效审查出现且无阻断即提前合并；默认等满窗口（给其他 agent 时间）；
//   · --require-approve：窗口内必须出现有效 APPROVED 才合并，否则 exit 3（严格模式）；
//   · 所有必需 API 读取：瞬时失败重试，仍失败即 fail-closed（绝不把请求失败当空状态）；
//   · 窗口结束、无阻断 → 复核 mergeable 后 squash 合并；head 分支删除失败仅告警（合并结果不受影响）。
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

// 必需读取：瞬时失败（网络/5xx/429）重试，仍失败即 fail-closed —— 绝不把失败当空状态。
async function must(p, init, label) {
  let last = '';
  for (let i = 0; i < 3; i++) {
    try {
      const res = await api(p, init);
      if (res.ok) return res;
      last = `HTTP ${res.status} ${(await res.text()).slice(0, 160)}`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      last = String((e && e.message) || e);
    }
    await sleep(2000);
  }
  console.error(`FAIL (${label}): ${last} — aborting (fail-closed)`);
  process.exit(1);
}

let pr;
if (prArg) {
  pr = await (await must(`pulls/${prArg}`, undefined, `pull ${prArg}`)).json();
} else {
  const list = await (await must(`pulls?head=${OWNER}:${branchArg}&state=open`, undefined, 'pull list')).json();
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

async function snapshot() {
  const st = await (await must(`pulls/${prn}`, undefined, 'pull state')).json();
  const reviews = await (await must(`pulls/${prn}/reviews?per_page=100`, undefined, 'reviews')).json();
  const labels = (await (await must(`issues/${prn}/labels`, undefined, 'labels')).json()).map((l) => l.name);
  const headSha = st.head && st.head.sha;
  const commit = headSha ? await (await must(`commits/${headSha}`, undefined, 'head commit')).json() : null;
  const headDate = commit ? commit.commit.committer.date || commit.commit.author.date : '';
  // 每个 reviewer 只取最新一条 review（GitHub 的合并判定同样如此；旧 CHANGES_REQUESTED 不敌新 REVIEW）
  const byUser = new Map();
  for (const r of reviews) {
    if (r.user.login === author) continue;
    const prev = byUser.get(r.user.login);
    if (!prev || String(r.submitted_at) > String(prev.submitted_at)) byUser.set(r.user.login, r);
  }
  const latest = [...byUser.values()];
  const fresh = latest.filter((r) => !headDate || String(r.submitted_at) >= headDate);
  return { st, labels, latest, fresh };
}

function exitIfBlocked(snap) {
  const changes = snap.latest.filter((r) => r.state === 'CHANGES_REQUESTED');
  if (changes.length) {
    console.error(`BLOCKED: CHANGES_REQUESTED on PR #${prn}:`);
    for (const r of changes) console.error(`  - ${r.user.login}: ${r.html_url}`);
    console.error('PR left open; fix the findings, push again, then re-run this script.');
    process.exit(2);
  }
  const hit = snap.labels.filter((l) => blockLabels.includes(l));
  if (hit.length) {
    console.error(`BLOCKED: label ${hit.join(', ')} on PR #${prn} — PR left open`);
    process.exit(2);
  }
}

let sawFresh = false;
let sawApprove = false;
function noteFresh(snap) {
  const s = snap.fresh.filter((r) => r.user.login === 'sourcery-ai[bot]');
  if (s.length && !sawFresh) {
    sawFresh = true;
    const last = s[0];
    console.log(`audit review in: ${last.html_url} (state=${last.state}, fresh for the current head)`);
  }
  if (snap.fresh.some((r) => r.state === 'APPROVED')) sawApprove = true;
}

for (let t = 0; t < windowSec; t += 20) {
  const snap = await snapshot();
  if (snap.st.state !== 'open') {
    console.log(`PR #${prn} is now ${snap.st.state}${snap.st.merged ? ' (merged)' : ''} — nothing to do`);
    process.exit(snap.st.merged ? 0 : 1);
  }
  exitIfBlocked(snap);
  noteFresh(snap);
  if (mergeOnReview && sawFresh && (!requireApprove || sawApprove)) break;
  if (t > 0 && t % 100 === 0) console.log(`… waiting (${t}s/${windowSec}s)`);
  await sleep(20000);
}

// 终局复核：窗口最后一次检查与合并之间不得留盲区（评审发现 #1）。
const fin = await snapshot();
if (fin.st.state !== 'open') {
  console.log(`PR #${prn} is now ${fin.st.state}${fin.st.merged ? ' (merged)' : ''} — nothing to do`);
  process.exit(fin.st.merged ? 0 : 1);
}
exitIfBlocked(fin);
noteFresh(fin);

if (requireApprove && !sawApprove) {
  console.error(`no fresh APPROVED review within ${windowSec}s (require-approve) — PR #${prn} left open`);
  process.exit(3);
}
if (!sawFresh) {
  console.warn('no fresh audit review seen in the window — check the Sourcery PR-review toggle (see the A1 report)');
}
if (noMerge) {
  console.log(`--no-merge: window passed with no blocking; PR #${prn} would be squash-merged`);
  process.exit(0);
}
if (fin.st.mergeable === false) {
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
// 分支清理：重试一次；仍失败仅告警——合并已成功，退出码反映合并结果（评审发现 #5）。
let del = await api(`git/refs/heads/${head}`, { method: 'DELETE' });
if (!del.ok) {
  await sleep(2000);
  del = await api(`git/refs/heads/${head}`, { method: 'DELETE' });
}
console.log(del.ok ? `branch deleted: ${head}` : `WARN: branch ${head} not deleted (${del.status}) — run: git push origin --delete ${head}`);
console.log(`next: gh workflow run sync-upstream.yml --repo ${OWNER}/${NAME} --ref master -f force=true`);
process.exit(0);
