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
import { isSlimExcluded, ROOT_ANCHORS, SLIM_EXCLUDE_DIRS, SLIM_EXCLUDE_FILES } from './slim-top.mjs';

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

/** L1 membership is a DENY-list now (tools/apk/slim-top.mjs): the slim carries every top-level
 *  entry except the content exclusions, so a new upstream dir still rides the slim. A fixed
 *  whitelist here would silently drop such a dir while the real artifact carried it (审计 R-04). */
const inTop = (p) => !isSlimExcluded(p);

/** Does this path look like it sits at the ROOT of a slim tree (js/, server/, index.html …)? */
const isRootShape = (p) => ROOT_ANCHORS.some((a) => p === a || p.startsWith(a));

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
  // wrapper = a single shared first segment whose removal turns the archive into a ROOT-shaped slim
  // tree. Under the deny-list membership test a wrapper path is "in top" by definition, so the
  // wrapper is detected structurally: the stripped set has root shapes, the archive as-is has none.
  // A flat archive (what make-bundle produces) has several first segments → no strip.
  let wrapper = null;
  const firsts = new Set(files.map((n) => n.split('/')[0]));
  if (firsts.size === 1) {
    const mapped = files.map((n) => n.split('/').slice(1).join('/'));
    if (mapped.every((p) => p && inTop(p)) && mapped.some(isRootShape) && !files.some(isRootShape)) {
      wrapper = [...firsts][0];
    }
  }
  stats.wrapper = wrapper;
  const plan = [];
  for (const n of files) {
    let p = n;
    if (wrapper && p.startsWith(`${wrapper}/`)) p = p.slice(wrapper.length + 1);
    if (p.startsWith('public/')) p = p.slice('public/'.length);
    if (!inTop(p)) continue; // dev-only tooling and L2 art never ship
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

function replayPatches(staging, patchesDir) {
  const app = appVersionOf(staging);
  console.log(`staging app version: ${app ?? 'unknown (conditions treat as matching)'}`);
  // 补丁清零是合法终态：目录可能根本不存在（git 不跟踪空目录）。空集不是失败，打印一行就继续
  // （审计 §6.1：空补丁集不该把门禁卡死）。
  let patchFiles = [];
  try {
    patchFiles = fs.readdirSync(patchesDir).filter((n) => n.endsWith('.json')).sort();
  } catch (e) {
    console.log(`no patches dir (${patchesDir}) — the patch set is empty by design; nothing to replay`);
    return;
  }
  if (!patchFiles.length) console.log('no patch files — the patch set is empty by design; nothing to replay');
  for (const pf of patchFiles) {
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
// template parse gate (htm) — every html`…` template in the staged client, INCLUDING templates
// nested inside interpolations, must PARSE with the vendored htm.
//
// WHY: 2026-10-04 v2.8.4 field incident — `…/><//></button>` (a redundant explicit close after the
// <//> shorthand) makes htm's parser underflow ("h.push is not a function") the first time a
// "房间制" (roomScoped) server cell renders; the whole panel render dies and the list stays empty.
// Static reading cannot catch it — templates parse lazily on first render — so this gate parses.
// ---------------------------------------------------------------------------------------------------

/** Extract ALL html-ish template literals (nested ones included) from a JS source. */
function extractTemplates(src, found = []) {
  const lineOf = (pos) => src.slice(0, pos).split('\n').length;
  function skipString(j, quote) {
    let k = j + 1;
    while (k < src.length && src[k] !== quote) { if (src[k] === '\\') k++; k++; }
    return k + 1;
  }
  /** scan one template starting at `; collect it into `found` when it looks like markup. */
  function scanTemplate(start) {
    const statics = [];
    let cur = '';
    let j = start + 1;
    while (j < src.length) {
      const ch = src[j];
      if (ch === '\\') { cur += src.slice(j, j + 2); j += 2; continue; }
      if (ch === '`') { statics.push(cur); break; }
      if (ch === '$' && src[j + 1] === '{') { statics.push(cur); cur = ''; j = skipExpr(j + 2); continue; }
      cur += ch; j += 1;
    }
    if (j >= src.length) statics.push(cur);
    if (statics.some((s) => s && s.includes('<'))) found.push({ statics, line: lineOf(start) });
    return j + 1;
  }
  function skipExpr(start) {
    let depth = 1;
    let j = start;
    let prevMeaning = '(';
    while (j < src.length && depth > 0) {
      const ch = src[j];
      if (ch === '{') { depth++; prevMeaning = ch; j++; continue; }
      if (ch === '}') { depth--; prevMeaning = ch; j++; continue; }
      if (ch === '`') { j = scanTemplate(j); prevMeaning = '`'; continue; } // nested templates are REAL templates too
      if (ch === "'" || ch === '"') { j = skipString(j, ch); prevMeaning = 'x'; continue; }
      if (ch === '/' && src[j + 1] === '/') { const nl = src.indexOf('\n', j); j = nl < 0 ? src.length : nl + 1; continue; }
      if (ch === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j + 2); j = e < 0 ? src.length : e + 2; continue; }
      if (ch === '/' && /[=(,:[!&|?{};+\-*%<>~^]/.test(prevMeaning || '(')) {
        let k = j + 1;
        let inClass = false;
        while (k < src.length) {
          const c2 = src[k];
          if (c2 === '\\') { k += 2; continue; }
          if (c2 === '[') inClass = true; else if (c2 === ']') inClass = false;
          else if (c2 === '/' && !inClass) break;
          k++;
        }
        j = k + 1; prevMeaning = 'x'; continue;
      }
      if (ch.trim()) prevMeaning = ch;
      j++;
    }
    return j;
  }
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '`') { i = scanTemplate(i); continue; }
    if (ch === "'" || ch === '"') { i = skipString(i, ch); continue; }
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl + 1; continue; }
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    i++;
  }
  return found;
}

async function checkTemplates(staging) {
  const htmPath = path.join(staging, 'vendor', 'htm.module.js');
  if (!fs.existsSync(htmPath)) { warn('vendor/htm.module.js missing — template parse gate skipped'); return; }
  const b64 = Buffer.from(fs.readFileSync(htmPath, 'utf8'), 'utf8').toString('base64');
  const mod = await import(`data:text/javascript;base64,${b64}`);
  const html = mod.default.bind((...a) => a);
  const files = [];
  const walkJs = (dir) => {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (n === 'node_modules' || n === 'assets' || n === 'vendor') continue; walkJs(p); }
      else if (n.endsWith('.js')) files.push(p);
    }
  };
  const jsRoot = path.join(staging, 'js');
  if (fs.existsSync(jsRoot)) walkJs(jsRoot);
  let templates = 0;
  let bad = 0;
  for (const f of files) {
    for (const t of extractTemplates(fs.readFileSync(f, 'utf8'))) {
      templates++;
      try {
        html(t.statics, ...new Array(Math.max(0, t.statics.length - 1)).fill(undefined));
      } catch (e) {
        bad++;
        fail(`htm parse ${path.relative(staging, f).split(path.sep).join('/')}:${t.line} → ${e.message} :: ${JSON.stringify(t.statics).slice(0, 220)}`);
      }
    }
  }
  console.log(`template parse: ${templates} templates in ${files.length} files, ${bad} failing`);
}

// ---------------------------------------------------------------------------------------------------
// device-side parity probe (advisory — the artifact gate never fails on it)
// ---------------------------------------------------------------------------------------------------

/** Pull a `public static final String[] NAME = {"a", "b"};` literal out of SlimPaths.java. */
function javaStringArray(src, name) {
  const m = new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\}`).exec(src);
  return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : null;
}

function parityProbe() {
  const dir = path.join(repo, 'android', 'app', 'src', 'main', 'java', 'icu', 'jiangjiangze', 'stronghold');
  const updater = path.join(dir, 'Updater.java');
  if (!fs.existsSync(updater)) return;
  const src = fs.readFileSync(updater, 'utf-8');
  if (/if\s*\(slash > 0\)\s*p = p\.substring\(slash \+ 1\)/.test(src)) {
    warn('device-side Updater.slimEntry() still strips the first path segment unconditionally — '
      + 'a flat slim (what make-bundle produces) will not map on devices until Commit 01 lands');
  }
  // Device-side L1 policy parity (审计 R-04): SlimPaths.java is a deny-list MIRROR of
  // tools/apk/slim-top.mjs. Both sides must agree on the three arrays, or the device maps a
  // different set than this gate proves — and a revived allow-list would silently drop a new
  // upstream top-level dir for good (the hot update swaps the WHOLE tree).
  const slimPaths = path.join(dir, 'SlimPaths.java');
  if (fs.existsSync(slimPaths)) {
    const java = fs.readFileSync(slimPaths, 'utf-8');
    if (/SLIM_TOP\s*=\s*\{/.test(java)) {
      warn('device-side SlimPaths.java still carries a static SLIM_TOP allow-list — any top-level '
        + 'entry it does not name is silently DROPPED during extraction and lost for good after the '
        + 'whole-tree swap (审计 R-04); SlimPaths must stay the deny-list mirror of slim-top.mjs');
    }
    const pairs = [
      ['SLIM_EXCLUDE_DIRS', SLIM_EXCLUDE_DIRS],
      ['SLIM_EXCLUDE_FILES', SLIM_EXCLUDE_FILES],
      ['ROOT_ANCHORS', ROOT_ANCHORS],
    ];
    for (const [name, jsList] of pairs) {
      const javaList = javaStringArray(java, name);
      if (!javaList) {
        warn(`device-side SlimPaths.${name} not found — cannot prove it mirrors slim-top.mjs's `
          + `${name}; the device side must keep the deny-list arrays (审计 R-04)`);
        continue;
      }
      const missing = jsList.filter((x) => !javaList.includes(x));
      const extra = javaList.filter((x) => !jsList.includes(x));
      if (missing.length || extra.length) {
        warn(`device-side SlimPaths.${name} drifted from tools/apk/slim-top.mjs `
          + `(missing: ${missing.join(', ') || '-'}; extra: ${extra.join(', ') || '-'}) — the device `
          + 'would map a different L1 set than this gate; update SlimPaths.java and rebuild the APK '
          + 'before shipping this slim (审计 R-04)');
      }
    }
  }
  // The Commit-02 patch semantics live in PatchEngine.apply() (optional / minApp / maxApp /
  // already-applied / shrink) — Updater delegates to it. Check the engine first; only warn when
  // NEITHER the engine nor Updater's own applyPatches implements them. (The 2026-10-05 E2E
  // showed this probe warning was a false alarm: the engine implements all five gates.)
  const enginePath = path.join(dir, 'PatchEngine.java');
  const engine = fs.existsSync(enginePath) ? fs.readFileSync(enginePath, 'utf-8') : '';
  const engineOk = /optional/.test(engine) && /minApp/.test(engine) && /maxApp/.test(engine);
  const apply = src.split('applyPatches')[1] || '';
  if (!engineOk && apply && !/optional/.test(apply)) {
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

  // 2/3. overlay source — the device prefers the slim's OWN shell-ui/ snapshot (Updater: when the
  // signed manifest carries shellOverlay.version, extras+patches replay from the extracted
  // shell-ui/, NOT from the APK's assets/shell). Only a slim without the overlay falls back to
  // assets. T5 mirrors that priority exactly; a mismatch is a drift warning (advisory), because
  // the APK-baked assets mirror only matters for shells that predate the overlay channel.
  const uiDir = path.join(extracted, 'shell-ui');
  const hasOverlay = fs.existsSync(path.join(uiDir, 'patches'));
  const overlayVersion = hasOverlay ? String(fs.readFileSync(path.join(uiDir, 'version.txt'), 'utf8').trim()) : '';
  const extrasBase = hasOverlay ? path.join(uiDir, 'extras') : path.join(shellDir, 'extras');
  const patchesBase = hasOverlay ? path.join(uiDir, 'patches') : path.join(shellDir, 'patches');
  console.log(`overlay source: ${hasOverlay ? `slim shell-ui/ (v${overlayVersion})` : 'assets shell (no overlay in slim)'}`);
  if (hasOverlay && fs.existsSync(path.join(shellDir, 'patches'))) {
    const uiSet = new Set(fs.readdirSync(patchesBase).filter((n) => n.endsWith('.json')));
    const assetSet = new Set(fs.readdirSync(path.join(shellDir, 'patches')).filter((n) => n.endsWith('.json')));
    const onlyUi = [...uiSet].filter((n) => !assetSet.has(n));
    const onlyAsset = [...assetSet].filter((n) => !uiSet.has(n));
    if (onlyUi.length || onlyAsset.length) {
      warn(`assets/shell/patches mirror drifts from the slim overlay (missing in assets: ${onlyUi.join(', ') || '-'}; extra in assets: ${onlyAsset.join(', ') || '-'}) — overlay-channel devices are unaffected; only a shell predating the overlay would replay the assets copy`);
    }
  }

  // 2. shell extras overlay (Updater.applyExtras)
  const sides = [
    { from: path.join(extrasBase, 'public'), to: staging },
    { from: path.join(extrasBase, 'server'), to: path.join(staging, 'server') },
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
  replayPatches(staging, patchesBase);
  console.log(`patches: ${stats.patched} applied, ${stats.patchSkipped} skipped`);

  // 3b. template parse gate (htm) — guards the 2026-10-04 "h.push is not a function" incident
  await checkTemplates(staging);

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
