#!/usr/bin/env node
// vendor-title-sync.mjs — 半自动同步助手（**只读**：不写任何产品文件、不改 BASELINE、不提交）。
//
// 背景（审计-上游更新零冲突-2026-10-08.md §2/§3）：extras 里的 title.js/title.css 是「上游 0.2.1 +
// 旧线 2.9.31 ops 净效果」的 vendor 副本，靠同名覆盖上线。上游一旦改动这两个文件，
// tools/apk/vendor-title.test.mjs 的「上游基线同步门」会**大声失败**——这是设计好的报警，不是 bug。
// 这个脚本是那条测试的人工配套：把「哪里变了 / 哪些 ops 的锚点还活着 / 接下来按什么顺序做」打印出来，
// 让同步从「对着 522 行测试猜」变成「照着清单逐条判定」。
//
//   node tools/apk/vendor-title-sync.mjs            # 默认 --repo <本仓库根>
//   node tools/apk/vendor-title-sync.mjs --repo <dir>
//
// 退出码：0 = 上游基线未漂移（副本无需动）；1 = 漂移，打印指引（仍然只读）；2 = 环境/解析问题。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 上游正文里「被 ops 改写 / 被口径删除」的 8 行锚点（与 vendor-title.test.mjs 的 REWRITTEN 一一对应；
 * 那份测试是权威，这里只是把它投影成「锚点存活表」）。顺序与测试一致。
 */
const REWRITTEN_ANCHORS = [
  { id: 'v3.5 op0 hooks import', re: /^import \{ useMemo, useState \} from '\.\.\/\.\.\/vendor\/hooks\.module\.js';$/m },
  { id: 'v3.5 op3 代号预填', re: /^\s*const \[name, setName\] = useState\(\(\) => store\.get\(\)\.me\.name \|\| identity\.loadName\(\) \|\| ''\);$/m },
  { id: 'v5.6 op1 邀请横幅', re: /^\s*<span>\$\{t\('收到同盟邀请'\)\}<\/span><b class="num">\$\{pendingJoin\}<\/b><span class="t-lo">\$\{t\('· 输入代号后将自动加入'\)\}<\/span>$/m },
  { id: 'O3 GuideButton import', re: /^import \{ GuideButton \} from '\.\.\/ui\/guide\.js';$/m },
  { id: 'O1 FullscreenButton import', re: /^import \{ FullscreenButton, detectFeatures \} from '\.\.\/ui\/device\.js';$/m },
  { id: 'O2 开始 主按钮', re: /^\s*<\$\{Button\} variant="primary" size="xl" block=\$\{true\} iconRight="chevrons" disabled=\$\{!valid\} onClick=\$\{start\}>\$\{t\('开始'\)\}<\/\/>$/m },
  { id: 'O3 玩法说明 render', re: /^\s*<\$\{GuideButton\} class="title-guide" label=\$\{t\('玩法说明'\)\} \/>$/m },
  { id: 'O1 全屏 render', re: /^\s*<\$\{FullscreenButton\} class="title-fs" \/>$/m },
];

/** CSS ops 追加所依赖的上游规则（title.css 侧；缺了说明上游改了锚点邻域）。 */
const CSS_ANCHOR_RULES = ['.title-conn .ping', '.title-foot {', '.title-lang {', '.title-dev {', '.title-invite {', '.title-bg__radar {'];

const read = (p) => fs.readFileSync(p, 'utf8');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const bytes = (p) => fs.statSync(p).size;
const lines = (p) => read(p).split('\n').length;

/** Parse the BASELINE constants out of vendor-title.test.mjs (the single source of truth). */
export function parseBaseline(testSrc) {
  const one = (key) => {
    const m = new RegExp(`${key}:\\s*\\{\\s*sha256:\\s*'([0-9a-f]{64})',\\s*bytes:\\s*(\\d+)`).exec(testSrc);
    return m ? { sha256: m[1], bytes: Number(m[2]) } : null;
  };
  return { js: one('js'), css: one('css') };
}

/**
 * 只读体检。@returns {{drift:Array,VERSION:string,ok:boolean}}
 */
export function inspect(repoRoot) {
  const baselineSrc = read(path.join(repoRoot, 'tools', 'apk', 'vendor-title.test.mjs'));
  const baseline = parseBaseline(baselineSrc);
  if (!baseline.js || !baseline.css) {
    throw new Error('无法从 tools/apk/vendor-title.test.mjs 解析 BASELINE（格式变了？先修这个脚本的 parseBaseline）');
  }
  const targets = {
    js: { up: path.join(repoRoot, 'public', 'js', 'screens', 'title.js'), copy: path.join(repoRoot, 'tools', 'apk', 'extras', 'public', 'js', 'screens', 'title.js') },
    css: { up: path.join(repoRoot, 'public', 'css', 'screens', 'title.css'), copy: path.join(repoRoot, 'tools', 'apk', 'extras', 'public', 'css', 'screens', 'title.css') },
  };
  for (const t of Object.values(targets)) {
    if (!fs.existsSync(t.up)) throw new Error(`上游文件不存在：${t.up}（--repo 指到仓库根了吗？）`);
    if (!fs.existsSync(t.copy)) throw new Error(`vendor 副本不存在：${t.copy}`);
  }
  const drift = [];
  for (const k of ['js', 'css']) {
    const cur = { sha256: sha256(targets[k].up), bytes: bytes(targets[k].up) };
    if (cur.sha256 !== baseline[k].sha256 || cur.bytes !== baseline[k].bytes) {
      drift.push({ file: k, baseline: baseline[k], current: cur, up: targets[k].up, copy: targets[k].copy });
    }
  }
  return { drift, baseline, targets, ok: drift.length === 0 };
}

/** 锚点存活表：旧上游行在新上游里还在不在（在 = op 大概率可原样重套）。 */
export function anchorSurvival(upstreamJs, upstreamCss) {
  const js = REWRITTEN_ANCHORS.map((a) => ({ id: a.id, alive: a.re.test(upstreamJs) }));
  const css = CSS_ANCHOR_RULES.map((r) => ({ id: r, alive: upstreamCss.includes(r) }));
  return { js, css };
}

/** git diffstat vs the recorded upstream tag — present only when the tag exists locally. */
function gitDiffstat(repoRoot, tag, rel) {
  try {
    const r = spawnSync('git', ['-C', repoRoot, 'diff', '--stat', '--no-color', tag, '--', rel],
      { encoding: 'utf-8', timeout: 30000 });
    if (r.status !== 0) return null;
    return (r.stdout || '').trim() || `(与 ${tag} 无差异？)`;
  } catch {
    return null;
  }
}

function main() {
  const argv = process.argv;
  const ri = argv.indexOf('--repo');
  const repoRoot = path.resolve(ri > 0 ? argv[ri + 1] : path.join(HERE, '..', '..'));
  console.log(`vendor-title 同步体检：${repoRoot}`);

  let res;
  try {
    res = inspect(repoRoot);
  } catch (e) {
    console.error(`ENV FAIL: ${e.message}`);
    process.exit(2);
  }
  for (const k of ['js', 'css']) {
    const up = path.join(repoRoot, 'public', k === 'js' ? 'js/screens/title.js' : 'css/screens/title.css');
    console.log(`  ${k}: 基线 ${res.baseline[k].sha256.slice(0, 12)}… (${res.baseline[k].bytes} B)`
      + `  当前 ${sha256(up).slice(0, 12)}… (${bytes(up)} B)  ${res.drift.some((d) => d.file === k) ? '← 漂移' : 'ok'}`);
  }
  if (res.ok) {
    console.log('vendor-title: 上游基线未漂移 —— 副本无需动作（vendor-title.test.mjs 应保持全绿）');
    process.exit(0);
  }

  console.error('');
  console.error('== 上游标题屏已漂移：副本不会自动跟上，请人工同步 ==');
  for (const d of res.drift) {
    const label = d.file === 'js' ? 'public/js/screens/title.js' : 'public/css/screens/title.css';
    console.error(`  ${label}: 基线 ${d.baseline.sha256} (${d.baseline.bytes} B) ≠ 当前 ${d.current.sha256} (${d.current.bytes} B)`);
    const stat = gitDiffstat(repoRoot, 'v0.2.1', label);
    if (stat) console.error(`  git diff --stat v0.2.1 -- ${label}\n${stat.split('\n').map((l) => `    ${l}`).join('\n')}`);
  }

  const upstreamJs = read(res.targets.js.up);
  const upstreamCss = read(res.targets.css.up);
  const surv = anchorSurvival(upstreamJs, upstreamCss);
  console.error('');
  console.error('== 锚点存活表（旧上游行在新上游里还在不在；不在 = 那条 op 要重做判定）==');
  for (const a of surv.js) console.error(`  [${a.alive ? '在 ' : '没了'}] JS ${a.id}`);
  for (const a of surv.css) console.error(`  [${a.alive ? '在 ' : '没了'}] CSS 锚点 ${a.id}`);
  console.error(`  上游行数变化：title.js ${lines(res.targets.js.up)} 行（副本 ${lines(res.targets.js.copy)} 行）`);
  console.error('  （权威口径见 vendor-title.test.mjs：REWRITTEN 必须恰为 8 条、CSS 只能纯追加）');

  console.error('');
  console.error('== NEXT STEPS（只读脚本，不代做任何一步）==');
  console.error('  1) 逐条重做 ops 判定：对照上面的存活表，把每条 op 归入「原样套 / 锚点改写 / 上游已原生实现 / 废弃」');
  console.error('  2) 更新 tools/apk/extras/public/js/screens/title.js 与 css/screens/title.css（正文 + 文件头 provenance/差异清单）');
  console.error('  3) 刷新 tools/apk/vendor-title.test.mjs 的 BASELINE（sha256 + bytes）与两份副本文件头里的上游 sha256');
  console.error('  4) 复跑 node --test tools/apk/vendor-title.test.mjs，再跑 node --test tools/apk/*.test.mjs');
  console.error('  重算 hash：node -e "const c=require(\'crypto\'),f=require(\'fs\');console.log(c.createHash(\'sha256\').update(f.readFileSync(\'public/js/screens/title.js\')).digest(\'hex\'))"');
  console.error('');
  console.error(`vendor-title: ${res.drift.length} 个文件漂移 —— 同步完成前 vendor-title.test.mjs 会持续红（这是设计）`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
