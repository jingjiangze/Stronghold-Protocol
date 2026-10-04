#!/usr/bin/env node
// tools/apk/verify-slim.mjs — GATE T5（《上游同步结构-修订版》§3）: 对 content-slim 做离线验证，
// 按设备端热更新的真实顺序在临时目录里完整模拟一遍：
//
//   1. 解包 slim，把每个条目映射进 L1 staging 树（Updater.slimEntry 的目标契约：
//      仅当所有条目共享同一个 wrapper 目录时才剥掉它；扁平归档一一对应）；
//   2. 叠加外壳自有覆盖层 assets/shell/extras/{public,server}（对应 Updater.applyExtras()）；
//   3. 重放 assets/shell/patches/*.json 的每一条补丁，采用完整引擎语义
//      （minApp / maxApp / optional / shrink / 已应用幂等 / CRLF→LF）——与
//      tools/apk/build-webroot.mjs::applyPatches() 和 check-patches.mjs 完全一致；
//   4. 断言最终 staging 树完整（index.html、server/index.js、shared/constants.js、package.json…）。
//
// 设备端必须实现同样的条目映射与补丁语义（修订版 Commit 01/02）。在它们落地前，
// 本脚本会探测仓库里的 Updater.java 并输出 ::warning:: 兼容性提示——提示不参与退出码，
// 它只负责让运维知道“这个工件现在设备端还消费不了”。
//
//   node tools/apk/verify-slim.mjs --slim <zip> [--shell android/app/src/main/assets/shell]
//        [--repo <checkout root>] [--keep] [--json <file>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

const repo = path.resolve(arg('--repo') || path.join(here, '..', '..'));
const slim = arg('--slim');
const shellDir = path.resolve(arg('--shell') || path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'shell'));
const keep = process.argv.includes('--keep');
const jsonOut = arg('--json');
if (!slim || !fs.existsSync(slim)) {
  console.error('usage: node tools/apk/verify-slim.mjs --slim <zip> [--shell <dir>] [--json <file>]');
  process.exit(2);
}
if (!fs.existsSync(shellDir)) {
  console.error(`shell assets dir not found: ${shellDir}`);
  process.exit(2);
}

/** Same L1 whitelist as Updater.SLIM_TOP / build-webroot's slim set. */
const SLIM_TOP = ['index.html', 'data.js', 'js', 'css', 'vendor', 'fonts', 'shared', 'sim', 'data',
  'server', 'package.json', 'node_modules'];
const inTop = (p) => SLIM_TOP.some((t) => p === t || p.startsWith(`${t}/`));

const failures = [];
const warnings = [];
const stats = { entries: 0, mapped: 0, wrapper: null, extraFiles: 0, patched: 0, patchSkipped: 0 };
const fail = (msg) => { failures.push(msg); console.error(`FAIL  ${msg}`); };
const warn = (msg) => { warnings.push(msg); console.log(`::warning::${msg}`); console.log(`WARN  ${msg}`); };

// ---------------------------------------------------------------------------------------------------
// zip helpers (tar on Windows like make-bundle, unzip on Linux CI)
// ---------------------------------------------------------------------------------------------------

function zipNames(zip) {
  const out = process.platform === 'win32'
    ? execFileSync('C:/Windows/System32/tar.exe', ['-tf', zip], { encoding: 'utf8' })
    : execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function extractZip(zip, dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') execFileSync('C:/Windows/System32/tar.exe', ['-xf', zip, '-C', dir]);
  else execFileSync('unzip', ['-q', '-o', zip, '-d', dir]);
}

function walkFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}

function copyInto(fromFile, toRoot, rel) {
  const dst = path.join(toRoot, ...rel.split('/'));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(fromFile, dst);
}

// ---------------------------------------------------------------------------------------------------
// 1. entry mapping (the TARGET Updater.slimEntry contract)
// ---------------------------------------------------------------------------------------------------

function planEntries(names) {
  const files = names
    .map((n) => n.replace(/\\/g, '/'))
    .filter((n) => n && !n.endsWith('/'))
    .map((n) => n.replace(/^\/+/, ''));
  stats.entries = files.length;
  // wrapper = a single shared first segment whose removal makes EVERY path a valid slim path
  // (and the archive itself is not already flat). A flat archive (what make-bundle produces)
  // has several first segments → no strip.
  let wrapper = null;
  const firsts = new Set(files.map((n) => n.split('/')[0]));
  if (firsts.size === 1) {
    const mapped = files.map((n) => n.split('/').slice(1).join('/'));
    if (mapped.every((p) => p && inTop(p)) && !files.every((p) => inTop(p))) wrapper = [...firsts][0];
  }
  stats.wrapper = wrapper;
  const plan = [];
  for (const n of files) {
    let p = n;
    if (wrapper && p.startsWith(`${wrapper}/`)) p = p.slice(wrapper.length + 1);
    if (p.startsWith('public/')) {
      const sub = p.slice('public/'.length);
      if (sub === 'dev' || sub.startsWith('dev/')) continue;       // dev-only tooling never ships
      if (sub === 'assets' || sub.startsWith('assets/')) continue; // L2 art: CDN only
      p = sub;
    }
    if (!inTop(p)) continue;
    plan.push({ from: n, to: p });
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------------
// 3. patch replay — mirrors build-webroot.mjs::applyPatches() semantics exactly
// ---------------------------------------------------------------------------------------------------

function appVersionOf(outDir) {
  try {
    const t = fs.readFileSync(path.join(outDir, 'shared', 'constants.js'), 'utf-8');
    const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(t) || /APP_VERSION\s*=\s*"([^"]+)"/.exec(t);
    return m ? m[1] : null;
  } catch { return null; }
}

function cmpVer(a, b) {
  if (a == null) return 0; // unknown → treat as matching any range
  const A = String(a).split('.'), B = String(b).split('.');
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? '0', y = B[i] ?? '0';
    const nx = Number(x), ny = Number(y);
    const c = (Number.isFinite(nx) && Number.isFinite(ny)) ? Math.sign(nx - ny) : (x < y ? -1 : x > y ? 1 : 0);
    if (c) return c;
  }
  return 0;
}

function replayPatches(staging) {
  const patchesDir = path.join(shellDir, 'patches');
  const app = appVersionOf(staging);
  console.log(`staging app version: ${app ?? 'unknown (conditions treat as matching)'}`);
  for (const pf of fs.readdirSync(patchesDir).filter((n) => n.endsWith('.json')).sort()) {
    const spec = JSON.parse(fs.readFileSync(path.join(patchesDir, pf), 'utf-8'));
    for (const p of spec.patches || []) {
      const tag = `${pf} → ${p.file}`;
      if (p.minApp && cmpVer(app, p.minApp) < 0) { stats.patchSkipped++; continue; }
      if (p.maxApp && cmpVer(app, p.maxApp) > 0) { stats.patchSkipped++; continue; }
      const target = path.join(staging, ...String(p.file).split('/'));
      if (!fs.existsSync(target)) { fail(`patch target missing: ${tag}`); continue; }
      // CRLF → LF: a Windows checkout / zip must match the LF anchors, and the staged tree stays LF
      const text = fs.readFileSync(target, 'utf-8').replace(/\r\n/g, '\n');
      if (text.includes(p.find)) {
        fs.writeFileSync(target, text.split(p.find).join(p.replace));
        stats.patched++;
        continue;
      }
      if (p.replace && text.includes(p.replace)) { stats.patchSkipped++; continue; } // already applied
      if (p.shrink) {
        const first = p.find.split('\n').find((l) => l.trim() !== '');
        if (first != null && text.includes(first)) {
          const lines = text.split('\n');
          const at = lines.findIndex((l) => l.includes(first));
          lines.splice(at, 1, text.includes(p.replace) ? lines[at] : p.replace);
          fs.writeFileSync(target, lines.join('\n'));
          stats.patched++;
          continue;
        }
      }
      if (p.optional) { stats.patchSkipped++; continue; }
      fail(`anchor not found: ${tag} ${JSON.stringify(String(p.find).slice(0, 80))}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// device-side parity probe (advisory — the artifact gate never fails on it)
// ---------------------------------------------------------------------------------------------------

function parityProbe() {
  const updater = path.join(repo, 'android', 'app', 'src', 'main', 'java', 'icu', 'jiangjiangze', 'stronghold', 'Updater.java');
  if (!fs.existsSync(updater)) return;
  const src = fs.readFileSync(updater, 'utf-8');
  if (/if\s*\(slash > 0\)\s*p = p\.substring\(slash \+ 1\)/.test(src)) {
    warn('device-side Updater.slimEntry() still strips the first path segment unconditionally — '
      + 'a flat slim (what make-bundle produces) will not map on devices until Commit 01 lands');
  }
  const apply = src.split('applyPatches')[1] || '';
  if (apply && !/optional/.test(apply)) {
    warn('device-side Updater.applyPatches() does not implement optional/minApp/maxApp (Commit 02) — '
      + 'patches whose anchors drifted or already applied will abort the update on devices');
  }
}

// ---------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-verify-slim-'));
try {
  const extracted = path.join(tmp, 'extracted');
  const staging = path.join(tmp, 'staging');
  fs.mkdirSync(staging, { recursive: true });

  console.log(`slim: ${slim}`);
  const plan = planEntries(zipNames(slim));
  console.log(`entries: ${stats.entries}, mapped into L1: ${plan.length}${stats.wrapper ? ` (wrapper "${stats.wrapper}" stripped)` : ' (flat archive)'}`);
  if (!plan.length) fail('no L1 entries mapped — wrong archive layout?');

  extractZip(slim, extracted);
  for (const e of plan) {
    const abs = path.join(extracted, ...e.from.split('/'));
    if (!fs.existsSync(abs)) continue; // directory-ish entries skipped above
    copyInto(abs, staging, e.to);
    stats.mapped++;
  }

  // 2. shell extras overlay (Updater.applyExtras)
  const sides = [
    { from: path.join(shellDir, 'extras', 'public'), to: staging },
    { from: path.join(shellDir, 'extras', 'server'), to: path.join(staging, 'server') },
  ];
  for (const side of sides) {
    if (!fs.existsSync(side.from)) continue;
    for (const f of walkFiles(side.from)) {
      const rel = path.relative(side.from, f).split(path.sep).join('/');
      copyInto(f, side.to, rel);
      stats.extraFiles++;
    }
  }
  console.log(`extras overlaid: ${stats.extraFiles} files`);

  // 3. patches
  replayPatches(staging);
  console.log(`patches: ${stats.patched} applied, ${stats.patchSkipped} skipped`);

  // 4. completeness
  const required = ['index.html', 'server/index.js', 'shared/constants.js', 'package.json', 'js', 'css', 'data'];
  for (const r of required) {
    if (!fs.existsSync(path.join(staging, ...r.split('/')))) fail(`staging missing ${r}`);
  }
  const fileCount = walkFiles(staging).length;
  console.log(`staging tree: ${fileCount} files`);

  parityProbe();
} finally {
  const report = { ok: failures.length === 0, slim: path.basename(slim), ...stats, failures, warnings };
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log(`kept: ${tmp}`);
}

if (failures.length) {
  console.error(`\nT5 FAILED: ${failures.length} problem(s):\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\nT5 OK: slim maps to a complete staging tree (${stats.mapped} mapped, ${stats.extraFiles} extras, ${stats.patched} patches applied)`
  + (warnings.length ? ` — ${warnings.length} device-parity warning(s), see above` : ''));
