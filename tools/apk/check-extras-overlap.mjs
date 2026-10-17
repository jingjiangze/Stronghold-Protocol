#!/usr/bin/env node
// check-extras-overlap.mjs — GATE-R5 (审计-上游更新零冲突-2026-10-08.md §3 缺口 B5/R-14).
//
// WHY: build-webroot.mjs copies extras AFTER the upstream tree (copyExtras at the end of the
// assemble step), so when an extras path collides with an upstream path OUR file wins and
// upstream's code is silently lost — no conflict, no log line, no test. Until 2026-10-08 the
// premise "extras never collide with upstream" held by luck. The vendored title screen
// (extras/public/js/screens/title.js|css) made the overlap INTENTIONAL: those two paths carry an
// explicit, allow-listed override whose baseline is pinned by vendor-title.test.mjs. So the rule
// is no longer "zero overlap" but "every overlap is declared AND still meaningful":
//
//   ① an overlap that is not in ALLOWED_OVERRIDES  → FAIL (would silently shadow upstream code);
//   ② an allow-listed override whose upstream target disappeared → FAIL (the vendored copy would
//      no longer be loaded by upstream's importer and the feature silently regresses — e.g. the
//      title screen renamed: R-01).
//
//   node tools/apk/check-extras-overlap.mjs [upstreamTree]
//
// upstreamTree defaults to $SP_UPSTREAM_TREE, then the local Windows extraction cache, then this
// repo (a fork of upstream, so its public/ + server/ are the same files). CI passes the tree
// explicitly. Layouts accepted: an extracted upstream zip (files under public/) or a built webroot
// (flat) — every path is resolved across both, like check-upstream-contract.mjs.
//
// The extras→webroot mapping mirrors build-webroot.mjs copyExtras()/copyOverlays() exactly:
//   tools/apk/extras/public/**       → <webroot>/**          (same-name override, REPLACE semantics)
//   tools/apk/extras/server/**       → <webroot>/server/**
//   tools/apk/overlay/*.mjs          → <webroot>/server/overlay/*.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_TREE } from './check-upstream-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/** Overlaps that are declared and gated elsewhere. Every entry names its gate. */
export const ALLOWED_OVERRIDES = [
  {
    webroot: 'js/screens/title.js',
    src: 'extras/public/js/screens/title.js',
    gate: 'vendor-title.test.mjs (上游基线 sha256 同步门 + ops 断言 + 差异可枚举)',
    why: 'vendored 2.9.31 title screen (口径 O2/O5/O6)',
  },
  {
    webroot: 'css/screens/title.css',
    src: 'extras/public/css/screens/title.css',
    gate: 'vendor-title.test.mjs (上游基线 sha256 同步门 + 纯追加断言)',
    why: 'vendored 2.9.31 title screen styles',
  },

  // ---- UI 包 stronghold-ui-20261014（业主 2026-10-17：「本地的 ui 是这个（仅本地服务）直接替换」）
  // 这一批是**整文件替换 / 锚点改写**的同名覆盖：包自己的 AGENTS.md §4.3 要求「上游 0.3.0 的改动
  // 搬进包的副本，而不是反过来」，所以 webroot 里跑的就是包的内容（room.js 的插件门、loadout.js
  // 的潜能系统都已折回）。上游 0.3.0 的对应文件被整份取代 = 这些路径的上游实现**不会**进包。
  // 门禁 = import 闭包检查 + 壳侧 node --test 套件（每文件 node --check + 三方合并差异可枚举）。
  {
    webroot: 'js/screens/room.js',
    src: 'extras/public/js/screens/room.js',
    gate: 'check-extras-overlap 自入口径 + node --test 套件（parse/闭包/契约）',
    why: 'UI 包 payload：房间页整换（包版为底，0.3.0 插件门折回）',
  },
  {
    webroot: 'js/screens/lobby.js',
    src: 'extras/public/js/screens/lobby.js',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 payload：大厅页整换（0.2.6→0.3.0 上游无差异，包版直接用）',
  },
  {
    webroot: 'css/screens/lobby.css',
    src: 'extras/public/css/screens/lobby.css',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 payload：大厅样式整换（上游无差异）',
  },
  {
    webroot: 'js/screens/loadout.js',
    src: 'extras/public/js/screens/loadout.js',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 payload：整备页整换（0.3.0 潜能/ cultivation 7 处已搬进）',
  },
  {
    webroot: 'css/screens/loadout.css',
    src: 'extras/public/css/screens/loadout.css',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 payload：整备样式整换（+上游 0.3.0 语音试听 2 行）',
  },
  {
    webroot: 'js/screens/game.js',
    src: 'extras/public/js/screens/game.js',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 match 锚点 + spdraft 手工裁决（barCollapsed 改名）',
  },
  {
    webroot: 'js/screens/bandDraft.js',
    src: 'extras/public/js/screens/bandDraft.js',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 match 锚点改写（matchMotion/screenFit）',
  },
  {
    webroot: 'js/ui/hud.js',
    src: 'extras/public/js/ui/hud.js',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 match 锚点改写（matchMotion/screenFit）',
  },
  {
    webroot: 'js/ui/components.js',
    src: 'extras/public/js/ui/components.js',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 match 锚点改写（matchMotion/screenFit）',
  },
  {
    webroot: 'js/ui/fieldHost.js',
    src: 'extras/public/js/ui/fieldHost.js',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 match 锚点改写（matchMotion/screenFit）',
  },
  {
    webroot: 'js/ui/loadoutModel.js',
    src: 'extras/public/js/ui/loadoutModel.js',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 match 锚点改写 + mergeSkins 片段（仓库侧同文件已补）',
  },
  {
    webroot: 'js/ui/settings.js',
    src: 'extras/public/js/ui/settings.js',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 match 锚点改写（matchMotion/screenFit）',
  },
  {
    webroot: 'js/ui/choiceOverlay.js',
    src: 'extras/public/js/ui/choiceOverlay.js',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 spdraft 锚点改写（0.3.0 已有此文件，包版整份覆盖）',
  },
  {
    webroot: 'js/ui/teamPanel.js',
    src: 'extras/public/js/ui/teamPanel.js',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 spdraft 锚点改写（0.3.0 已有此文件，包版整份覆盖）',
  },
  {
    webroot: 'js/render/app.js',
    src: 'extras/public/js/render/app.js',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 beam 锚点 + 手工裁决（保留 0.3.0 !wiring.deploy(v)）',
  },
  {
    webroot: 'js/render/units.js',
    src: 'extras/public/js/render/units.js',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 beam 锚点改写',
  },
  {
    webroot: 'js/render/fx/arrivals.js',
    src: 'extras/public/js/render/fx/arrivals.js',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 beam 锚点改写',
  },
  {
    webroot: 'js/audio.js',
    src: 'extras/public/js/audio.js',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 lobby-music 手工锚点（0.3.0 版 + lobbyMusic 两处钩子）',
  },
  {
    webroot: 'css/components.css',
    src: 'extras/public/css/components.css',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 match 锚点改写（CSS）',
  },
  {
    webroot: 'css/devices.css',
    src: 'extras/public/css/devices.css',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 screenFit 锚点改写（CSS）',
  },
  {
    webroot: 'css/screens/draft.css',
    src: 'extras/public/css/screens/draft.css',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 match 锚点改写（CSS）',
  },
  {
    webroot: 'css/screens/game.css',
    src: 'extras/public/css/screens/game.css',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 match 锚点改写（CSS）',
  },
  {
    webroot: 'css/screens/game-panels.css',
    src: 'extras/public/css/screens/game-panels.css',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 spdraft 锚点改写（CSS）',
  },
  {
    webroot: 'css/screens/result.css',
    src: 'extras/public/css/screens/result.css',
    gate: 'node --test 套件（parse/闭包/契约）',
    why: 'UI 包 match 锚点改写（结算 CSS）',
  },
  // ---- 上游 0.3.1 同步（业主 2026-10-18：「更新最新上游 0.3.1，本地 ui 依旧保持」）——
  // 这 7 个文件在 0.3.1 里变了，而我们的 extras 里仍留 0.3.0 基底的副本（UI 包 / 壳改动所系）。
  // 走「声明式同名覆盖」：webroot 里跑的是 extras 版，0.3.1 的实现被有意搁置，
  // 待 UI 包出 0.3.1 适配后再逐个撤。门禁 = node --test 套件 + 每文件 node --check。
  { webroot: 'js/screens/settle.js',      src: 'extras/public/js/screens/settle.js',
    gate: 'module-exports.test.mjs（具名导出全解析）+ node --test 套件（parse/闭包）',
    orphanOk: true, // 0.3.1 新增同名路径：extras 版有意顶住，上游实现待 UI 包适配
    why: '0.3.1 settle 改动待 UI 包适配；extras 版含加好友按钮与社区清单 id' },
  { webroot: 'js/screens/sweep.js',       src: 'extras/public/js/screens/sweep.js',
    gate: 'node --test 套件（parse/闭包）',
    orphanOk: true, // 0.3.1 新增同名路径：extras 版有意顶住，上游实现待 UI 包适配
    why: '0.3.1 sweep 改动待 UI 包适配' },
  { webroot: 'js/ui/matchPopups.js',      src: 'extras/public/js/ui/matchPopups.js',
    gate: 'node --test 套件（parse/闭包）',
    orphanOk: true, // 0.3.1 新增同名路径：extras 版有意顶住，上游实现待 UI 包适配
    why: '0.3.1 matchPopups 改动待 UI 包适配（UI 包 payload 同名覆盖）' },
  { webroot: 'js/ui/notices.js',          src: 'extras/public/js/ui/notices.js',
    gate: 'node --test 套件（parse/闭包）',
    orphanOk: true, // 0.3.1 新增同名路径：extras 版有意顶住，上游实现待 UI 包适配
    why: '0.3.1 notices 改动待 UI 包适配' },
  { webroot: 'js/ui/screenFit.js',        src: 'extras/public/js/ui/screenFit.js',
    gate: 'node --test 套件（parse/闭包）',
    orphanOk: true, // 0.3.1 新增同名路径：extras 版有意顶住，上游实现待 UI 包适配
    why: '0.3.1 screenFit 改动待 UI 包适配（UI 包 payload 同名覆盖）' },
  { webroot: 'js/ui/skinPicker.js',       src: 'extras/public/js/ui/skinPicker.js',
    gate: 'node --test 套件（parse/闭包）',
    orphanOk: true, // 0.3.1 新增同名路径：extras 版有意顶住，上游实现待 UI 包适配
    why: '0.3.1 skinPicker 改动待 UI 包适配（compat 垫片）' },
  { webroot: 'js/ui/skins.js',            src: 'extras/public/js/ui/skins.js',
    gate: 'node --test 套件（parse/闭包）',
    orphanOk: true, // 0.3.1 新增同名路径：extras 版有意顶住，上游实现待 UI 包适配
    why: '0.3.1 skins 改动待 UI 包适配（compat 垫片）' },
];

/** Every extras file mapped to its webroot-relative path (mirrors copyExtras/copyOverlays). */
export function listExtras(extrasDir, overlayDir) {
  const out = [];
  const walk = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, `${prefix}${e.name}/`);
      else out.push({ src: path.relative(extrasDir, p).split(path.sep).join('/'), webroot: prefix + e.name });
    }
  };
  walk(path.join(extrasDir, 'public'), '');
  walk(path.join(extrasDir, 'server'), 'server/');
  if (overlayDir && fs.existsSync(overlayDir)) {
    for (const n of fs.readdirSync(overlayDir)) {
      if (n.endsWith('.mjs')) out.push({ src: `overlay/${n}`, webroot: `server/overlay/${n}` });
    }
  }
  return out.sort((a, b) => (a.webroot < b.webroot ? -1 : 1));
}

/** Resolve a webroot-relative path across both upstream layouts (zip keeps files under public/). */
export function resolveUpstream(tree, rel) {
  for (const base of [tree, path.join(tree, 'public')]) {
    const p = path.join(base, ...rel.split('/'));
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Run the overlap check. Never throws.
 * @returns {{ok:boolean, tree:string, extras:number, overlaps:Array<{src:string,webroot:string,target:string|null}>, findings:Array<{id:string,detail:string,why:string}>}}
 */
export function findOverlaps(tree, opts = {}) {
  const extrasDir = opts.extrasDir || path.join(HERE, 'extras');
  const overlayDir = opts.overlayDir || path.join(HERE, 'overlay');
  const extras = listExtras(extrasDir, overlayDir);
  const findings = [];
  const overlaps = [];
  const allowedBy = new Map(ALLOWED_OVERRIDES.map((a) => [a.webroot, a]));

  for (const e of extras) {
    const target = resolveUpstream(tree, e.webroot);
    if (target) overlaps.push({ src: e.src, webroot: e.webroot, target });
  }
  for (const o of overlaps) {
    const allowed = allowedBy.get(o.webroot);
    if (!allowed) {
      findings.push({
        id: `overlap:${o.webroot}`,
        detail: `${o.src} shadows the upstream path ${o.webroot} (copyExtras runs after the upstream copy — upstream's file would be silently lost)`,
        why: '未声明的同名覆盖：上游该文件的功能静默丢失（B5/R-14）。改用 sp- 前缀/子目录命名，或把它加进 ALLOWED_OVERRIDES 并补上门禁',
      });
    }
  }
  // ② an allow-listed override must still be an override (the loader has to keep reaching it)
  for (const a of ALLOWED_OVERRIDES) {
    const present = !!resolveUpstream(tree, a.webroot);
    const extraPresent = extras.some((e) => e.webroot === a.webroot);
    if (!extraPresent) {
      findings.push({
        id: `override-missing:${a.webroot}`,
        detail: `ALLOWED_OVERRIDES declares ${a.webroot} but no extras file maps to it`,
        why: '声明与 extras 树不一致（改名/移走副本后忘了同步该表）',
      });
      continue;
    }
    if (!present && !a.orphanOk) {
      findings.push({
        id: `override-orphan:${a.webroot}`,
        detail: `${a.src} overrides ${a.webroot}, but upstream no longer ships that path — the vendored copy stays in the webroot yet nothing imports it (${a.why})`,
        why: '上游改了文件名/结构：页面会静默退回上游新版（标题屏 vendored 失效，R-01 一类）。重做 ops 判定或撤下副本',
      });
    }
  }
  const allowed = overlaps.filter((o) => allowedBy.has(o.webroot));
  return { ok: findings.length === 0, tree, extras: extras.length, overlaps, allowed, findings };
}

function resolveTreeArg(explicit) {
  if (explicit) return path.resolve(explicit);
  const env = (process.env.SP_UPSTREAM_TREE || '').trim();
  if (env) return path.resolve(env);
  // Version guard (same rationale as forge-gate.test.mjs): the extraction cache is machine-local and
  // goes stale silently. While it still held 0.2.6 on 2026-10-17, the orphan check below read it as
  // the upstream truth and flagged our own extras/public/packs/index.json as an orphan — upstream
  // 0.3.0 DOES ship that path (it is served live by server/packs.js, and the static copy is what the
  // offline title screen reads). A cache older than this repo is not the upstream truth; the repo
  // itself is a fork of upstream and always carries the pinned version.
  const appVersion = (c) => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(c, 'MANIFEST.json'), 'utf8'));
      if (m && typeof m.app === 'string' && m.app) return m.app;
    } catch (e) { /* not an extracted zip */ }
    try {
      const p = JSON.parse(fs.readFileSync(path.join(c, 'package.json'), 'utf8'));
      if (p && typeof p.version === 'string' && p.version) return p.version;
    } catch (e) { /* no package.json */ }
    return '';
  };
  const sem = (v) => String(v || '').split('.').map((n) => parseInt(n, 10) || 0);
  const repoNums = sem(appVersion(REPO));
  const isFresh = (c) => {
    const cNums = sem(appVersion(c));
    return !(cNums[0] < repoNums[0] || (cNums[0] === repoNums[0] && (cNums[1] < repoNums[1]
      || (cNums[1] === repoNums[1] && (cNums[2] || 0) < (repoNums[2] || 0)))));
  };
  if (fs.existsSync(path.join(DEFAULT_TREE, 'server', 'index.js')) && isFresh(DEFAULT_TREE)) {
    return path.resolve(DEFAULT_TREE);
  }
  const cache = path.resolve(REPO, '..', 'dl-cache', 'upstream-extracted');
  try {
    const sub = fs.readdirSync(cache).filter((n) => fs.statSync(path.join(cache, n)).isDirectory());
    if (sub.length === 1 && isFresh(path.join(cache, sub[0]))) return path.join(cache, sub[0]);
  } catch { /* no cache */ }
  return REPO;
}

function main() {
  const argv = process.argv;
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i > 0 ? argv[i + 1] : null;
  };
  // a positional tree must not be the value of --extras/--overlay/--tree
  const consumed = new Set();
  for (const name of ['--tree', '--extras', '--overlay']) {
    const i = argv.indexOf(name);
    if (i > 0) { consumed.add(i); consumed.add(i + 1); }
  }
  const posIdx = argv.findIndex((a, i) => i >= 2 && !a.startsWith('--') && !consumed.has(i));
  const tree = resolveTreeArg(flag('--tree') || (posIdx >= 0 ? argv[posIdx] : null));
  const opts = {};
  if (flag('--extras')) opts.extrasDir = path.resolve(flag('--extras'));
  if (flag('--overlay')) opts.overlayDir = path.resolve(flag('--overlay'));
  console.log(`extras overlap check against: ${tree}`);
  const res = findOverlaps(tree, opts);
  if (!res.extras) {
    console.error('EXTRAS FAIL: no extras files found — wrong --tree? (expected tools/apk/extras/{public,server})');
    process.exit(1);
  }
  for (const a of res.allowed) {
    console.log(`ok (declared override): ${a.webroot}  ← ${a.src}  [${ALLOWED_OVERRIDES.find((x) => x.webroot === a.webroot).gate}]`);
  }
  if (res.findings.length) {
    console.error('');
    for (const f of res.findings) {
      console.error(`OVERLAP FAIL: ${f.id} — ${f.detail}`);
      console.error(`  后果: ${f.why}`);
    }
    console.error('');
    console.error(`extras overlap: ${res.findings.length} problem(s) (${res.overlaps.length} overlap(s), ${res.allowed.length} declared)`);
    process.exit(1);
  }
  console.log(`extras overlap: ${res.overlaps.length} overlap(s), all declared, all still upstream (${res.extras} extras files)`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
