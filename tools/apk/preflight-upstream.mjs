#!/usr/bin/env node
// preflight-upstream.mjs — 上游新版本落地前的**只读预演**（审计-上游更新零冲突-2026-10-08.md §8 的
// V1–V10 摘成一条命令）。它对着「上游新 ref / 新 tree」把合并层与运行时契约层全跑一遍，**不推、不合并、
// 不改任何产品文件**；需要读文件时用临时 git worktree（结束即删）。
//
//   node tools/apk/preflight-upstream.mjs --ref upstream/master
//   node tools/apk/preflight-upstream.mjs --ref v0.2.2
//   node tools/apk/preflight-upstream.mjs --tree <已解包的上游树>      # 只有 V5–V10（V1–V4 是 git 层）
//
// 覆盖：V1 tree 解析 / V2 git 层纯新增（M/D 必须 0）/ V3 内容级复核 / V4 merge 预演（merge-tree）/
// V5 闸门自证（check-patches：空补丁集也必须真跑 parse+契约）/ V6 模块契约 / V7 DOM 契约 /
// V8 服务端契约（静态；有 node_modules 时才额外 --runtime）/ V9 i18n 文案集 / V10 素材形态 /
// V6b extras 同名覆盖（我方新增：上游新增同名文件 or vendored 目标被改名）。
//
// 退出码：0 = 预演全过（可以合并）；1 = 有红（先看每行「失败含义」，别先改代码）；2 = 用法/环境错。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkContract } from './check-upstream-contract.mjs';
import { findOverlaps } from './check-extras-overlap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const C = { PASS: 'PASS ', FAIL: 'FAIL ', SKIP: 'SKIP ' };

function parseArgv(argv) {
  const out = { repo: path.resolve(path.join(HERE, '..', '..')), ref: null, tree: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--ref') out.ref = argv[++i];
    else if (argv[i] === '--tree') out.tree = path.resolve(argv[++i]);
    else if (argv[i] === '--repo') out.repo = path.resolve(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
    else if (!argv[i].startsWith('--')) out.tree = path.resolve(argv[i]);
  }
  return out;
}

const git = (repo, args, opts = {}) =>
  spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8', timeout: opts.timeout || 120000 });

/** 结果累积器。 */
function mkreport() {
  const rows = [];
  return {
    rows,
    add(id, what, status, detail) { rows.push({ id, what, status, detail }); },
    get failures() { return rows.filter((r) => r.status === 'FAIL'); },
  };
}

/** V10: count `"/assets/` occurrences + stats.files in the upstream manifest. */
export function manifestShape(tree) {
  for (const base of [tree, path.join(tree, 'public'), path.join(tree, 'data'), path.join(tree, 'public', 'data')]) {
    const p = path.join(base, 'assets.json');
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const m = JSON.parse(raw);
      return { path: p, slashAssets: (raw.match(/"\/assets\//g) || []).length, files: m?.stats?.files ?? null };
    } catch (e) {
      return { path: p, error: e.message };
    }
  }
  return { error: 'data/assets.json not found (also public/data/)' };
}

function runRefPhase(rep, repo, ref) {
  const upSha = git(repo, ['rev-parse', `${ref}^{commit}`]);
  const upTree = git(repo, ['rev-parse', `${ref}^{tree}`]);
  if (upSha.status !== 0 || upTree.status !== 0) {
    rep.add('V1', `解析 ${ref}`, 'FAIL', `git rev-parse failed: ${(upSha.stderr || upTree.stderr || '').trim()}`);
    return null;
  }
  const sha = upSha.stdout.trim();
  const tree = upTree.stdout.trim();
  rep.add('V1', `tree = ${tree.slice(0, 12)} (${ref} @ ${sha.slice(0, 8)})`, 'PASS');

  // V2/V3: re-apk may only ADD paths relative to an upstream tree — any M/D means someone edited
  // an upstream-owned file and the zero-conflict property is gone.
  const ns = git(repo, ['diff', '--name-status', tree, 'HEAD']);
  if (ns.status !== 0) {
    rep.add('V2', 'git 层纯新增（M/D 必须为 0）', 'FAIL', ns.stderr.trim() || 'git diff failed');
  } else {
    const counts = {};
    for (const line of ns.stdout.split('\n')) {
      const st = (line.split('\t')[0] || '').trim();
      if (st) counts[st[0]] = (counts[st[0]] || 0) + 1;
    }
    const m = (counts.M || 0), d = (counts.D || 0), a = (counts.A || 0);
    rep.add('V2', `A=${a} M=${m} D=${d}`, m + d === 0 ? 'PASS' : 'FAIL',
      m + d === 0 ? '只有新增路径（零冲突前提成立）' : `${m + d} 个上游文件被改/删 —— 范式被破坏，先找出是谁改的`);
    const md = git(repo, ['diff', '--name-only', tree, 'HEAD', '--diff-filter=MD']);
    const list = (md.stdout || '').trim();
    rep.add('V3', list ? `M/D 清单（${list.split('\n').length}）` : 'M/D 清单为空', list ? 'FAIL' : 'PASS', list);
  }

  // V4: merge preview (no working-tree mutation). Modern git: --write-tree; fall back to the 3-arg form.
  const mt = git(repo, ['merge-tree', '--write-tree', 'HEAD', sha]);
  if (mt.status === 0 && /^[0-9a-f]{40,}$/.test((mt.stdout || '').trim().split('\n')[0] || '')) {
    rep.add('V4', 'merge 预演（merge-tree --write-tree）', 'PASS', '无冲突块');
  } else if (/unknown option|usage: git merge-tree/i.test((mt.stderr || '') + (mt.stdout || ''))) {
    const base = git(repo, ['merge-base', 'HEAD', sha]).stdout.trim();
    const old = git(repo, ['merge-tree', base, 'HEAD', sha]);
    const conflicted = /<<<<<<<|changed in both|CONFLICT/.test(old.stdout || '');
    rep.add('V4', 'merge 预演（旧式 merge-tree）', conflicted ? 'FAIL' : 'PASS',
      conflicted ? '有冲突块 —— 人工解' : '无冲突块');
  } else {
    rep.add('V4', 'merge 预演', 'FAIL', ((mt.stderr || mt.stdout || '').trim().split('\n')[0]) || 'merge-tree failed');
  }
  return { sha, tree };
}

async function runTreePhase(rep, repo, tree, opts) {
  const node = process.execPath;
  // V5: the real gate, run against the NEW tree (its own output names anchors/parse/contract breaks).
  const cp = spawnSync(node, [path.join(HERE, 'check-patches.mjs'), tree], { encoding: 'utf-8', timeout: 300000, cwd: repo });
  const tail = (cp.stdout || '').trim().split('\n').filter((l) => /^(anchors|gates|parse gate|runtime contract)/.test(l));
  rep.add('V5', 'check-patches（空补丁集也真跑 parse + 契约）', cp.status === 0 ? 'PASS' : 'FAIL', tail.join(' | ') || (cp.stderr || '').trim().split('\n').slice(-2).join(' | '));

  // V6–V9: the contract checker, grouped by id so each audit row gets its own line.
  const res = await checkContract(tree);
  const notUpstream = res.failures.some((f) => f.id === 'tree');
  const groups = [
    ['V6', '上游模块契约（exports）', ['export:']],
    ['V7', '上游 DOM 契约（title/app-root/modal/invite）', ['dom:']],
    ['V8', '上游服务端契约（startServer 形状 + Lobby API）', ['server:', 'global:']],
    ['V9', 'i18n 文案集（房间邀请按钮）', ['i18n:']],
  ];
  for (const [id, what, pfx] of groups) {
    if (notUpstream) {
      rep.add(id, what, 'FAIL', '不是上游树 —— V1 的 tree 解析就错了');
      continue;
    }
    const bad = res.failures.filter((f) => pfx.some((p) => f.id.startsWith(p)));
    rep.add(id, what, bad.length ? 'FAIL' : 'PASS',
      bad.length ? bad.map((f) => `${f.id} — ${f.detail}`).join(' ; ')
        : (res.notes.length ? `clean (${res.notes.length} note(s) — 见 check-upstream-contract 输出)` : 'clean'));
  }
  // V8b: runtime boot only when the tree carries node_modules (built webroot).
  if (opts.runtime) {
    const rt = spawnSync(node, [path.join(HERE, 'check-upstream-contract.mjs'), tree, '--runtime'], { encoding: 'utf-8', timeout: 120000 });
    rep.add('V8b', 'startServer() 真启动', rt.status === 0 ? 'PASS' : 'FAIL', /skipped/.test(rt.stdout) ? 'skipped (no node_modules)' : '');
  } else {
    rep.add('V8b', 'startServer() 真启动（--runtime）', 'SKIP', '默认只做静态形状检查；要真启动加 --runtime（需 node_modules）');
  }

  // V10: asset-manifest shape (R-05): a renamed asset dir / URL form silently breaks offline art.
  const shape = manifestShape(tree);
  if (shape.error) rep.add('V10', '素材形态（"/assets/ 计数 + stats.files）', 'FAIL', shape.error);
  else {
    const ok = shape.slashAssets > 0 && (shape.files == null || shape.files >= 3900);
    rep.add('V10', `"/assets/ x${shape.slashAssets}, stats.files=${shape.files}`, ok ? 'PASS' : 'FAIL',
      ok ? shape.path : '计数为 0 或 files < 3900：上游改了 URL 形态/素材树（R-05/R-12，构建会静默掉素材）');
  }

  // V6b: extras same-name override chain (GATE-R5) — upstream adding a colliding path, or renaming
  // the vendored title file, would otherwise be silent.
  const ov = findOverlaps(tree, { extrasDir: opts.extrasDir, overlayDir: opts.overlayDir });
  rep.add('V6b', `extras 同名覆盖（${ov.overlaps.length} 个声明覆盖）`, ov.ok ? 'PASS' : 'FAIL',
    ov.ok ? '无未声明重叠、vendored 目标仍在上游' : ov.findings.map((f) => `${f.id}: ${f.detail}`).join(' ; '));
  return res;
}

async function main() {
  const opts = parseArgv(process.argv);
  if (opts.help || (!opts.ref && !opts.tree)) {
    console.error('usage: node tools/apk/preflight-upstream.mjs --ref <upstream-ref> | --tree <dir> [--repo <dir>] [--runtime]');
    process.exit(2);
  }
  opts.runtime = process.argv.includes('--runtime');
  const rep = mkreport();
  console.log(`== 上游预演（只读）：${opts.ref ? `ref=${opts.ref}` : `tree=${opts.tree}`} ==`);

  let tmpWorktree = null;
  try {
    if (opts.ref) {
      const r = runRefPhase(rep, opts.repo, opts.ref);
      if (r) {
        tmpWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-preflight-'));
        fs.rmSync(tmpWorktree, { recursive: true, force: true }); // worktree add wants a free path
        const add = git(opts.repo, ['worktree', 'add', '--detach', tmpWorktree, r.sha]);
        if (add.status === 0) {
          await runTreePhase(rep, opts.repo, tmpWorktree, opts);
        } else {
          rep.add('V5', 'check-patches 等树内检查', 'FAIL', `git worktree add failed: ${(add.stderr || '').trim()}`);
        }
      }
    } else {
      for (const id of ['V1', 'V2', 'V3', 'V4']) rep.add(id, '（git 层检查）', 'SKIP', '--tree 模式跳过；用 --ref 获得完整预演');
      await runTreePhase(rep, opts.repo, opts.tree, opts);
    }
  } finally {
    if (tmpWorktree) {
      git(opts.repo, ['worktree', 'remove', '--force', tmpWorktree]);
      fs.rmSync(tmpWorktree, { recursive: true, force: true });
    }
  }

  console.log('');
  for (const r of rep.rows) {
    console.log(`  ${C[r.status] || r.status} ${r.id}  ${r.what}${r.detail ? `\n        ${r.detail.replace(/\n/g, '\n        ')}` : ''}`);
  }
  const fail = rep.failures.length;
  const skip = rep.rows.filter((r) => r.status === 'SKIP').length;
  console.log('');
  console.log(`result: ${rep.rows.length - fail - skip} pass, ${fail} fail, ${skip} skip`);
  if (fail) console.log('任何 FAIL 先看每行的「失败含义」，不要先改代码（§8 的顺序：先判定，再动手）。');
  process.exit(fail ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
