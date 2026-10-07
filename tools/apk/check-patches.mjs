// check-patches.mjs — SEQUENTIAL SIMULATION of build-webroot's applyPatches(): replays
// every patch entry in the same order on an in-memory copy of the target tree, so
// "chain anchors" (a find that targets an earlier patch's replace output) verify exactly
// the way the real build applies them. Per-entry applicability mirrors the engine:
// minApp/maxApp (tree APP_VERSION), optional, shrink (first-line anchor), already-applied.
//
// It then runs a PARSE GATE over everything this run replayed (plus the shell extras that
// build-webroot merges into the client): each module must parse as ESM (`node --check` on a
// .mjs temp copy — no flags). Anchors only prove the find text existed; they are blind to a
// replace that produces a DUPLICATE declaration. 2026-10-06: upstream #183 shipped the
// title-screen SettingsModal import/state, and two v2.2 insert entries would have duplicated
// them — every anchor green, yet the client would die at load with "Identifier 'SettingsModal'
// has already been declared". This gate is that class of bug's permanent guard.
//
//   node tools/apk/check-patches.mjs [upstreamTree]
//
// Patch DEFINITIONS always come from the repo shipping this script; argv is the tree
// under test — an extracted upstream zip (public/ layout) or a built webroot (flat).
//
// 2026-10-08 (审计 §6.1 / §8.4): an EMPTY patch set is a legitimate end state, but it must not turn
// this gate into a tautology. The parse gate now runs unconditionally (GATE-R3) and the RUNTIME
// contract gate (check-upstream-contract.mjs, GATE-R1) runs on every invocation — so an upstream
// release that silently breaks the shell's runtime coupling still turns this red.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkContract } from './check-upstream-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ownRepo = path.resolve(here, '..', '..');
const patchesDir = path.join(ownRepo, 'tools', 'apk', 'patches');
const repo = path.resolve(process.argv[2] || ownRepo);

/** Resolve a patch target across both layouts (upstream zip keeps files under public/). */
const layouts = (rel) => [path.join(repo, rel), path.join(repo, 'public', rel)];

function appVersionOf() {
  for (const base of [repo, path.join(repo, 'public')]) {
    try {
      const t = fs.readFileSync(path.join(base, 'shared', 'constants.js'), 'utf-8');
      const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(t) || /APP_VERSION\s*=\s*"([^"]+)"/.exec(t);
      if (m) return m[1];
    } catch { /* try next layout */ }
  }
  return null;
}

function cmpVer(a, b) {
  if (a == null) return 0;
  const A = String(a).split('.'), B = String(b).split('.');
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? '0', y = B[i] ?? '0';
    const nx = Number(x), ny = Number(y);
    const c = (Number.isFinite(nx) && Number.isFinite(ny)) ? Math.sign(nx - ny) : (x < y ? -1 : x > y ? 1 : 0);
    if (c) return c;
  }
  return 0;
}

// 补丁清零是**合法终态**：壳侧 UI 全部搬到 extras/叠加层（可热更、零上游冲突）。空补丁集不再
// 直接 exit 0 —— 那样会让这个门禁恒真（审计 §6.1）。下面照样跑 parse gate + 运行时契约门禁。
let files = [];
if (!fs.existsSync(patchesDir)) {
  console.log('no patches dir — the patch set is empty by design (shell UI lives in extras/overlays)');
} else {
  files = fs.readdirSync(patchesDir).filter((n) => n.endsWith('.json')).sort();
  if (!files.length) {
    console.log('no patch files — the patch set is empty by design (shell UI lives in extras/overlays)');
  }
}

const app = appVersionOf();
console.log(`tree app version: ${app ?? 'unknown (conditions treat as matching)'}`);

// in-memory working set: resolvedPath → text (null = unresolved/missing).
// CRLF → LF on read: a Windows checkout (core.autocrlf) must match the LF anchors exactly
// like CI does — otherwise every multi-line anchor "fails" on Windows while CI is green
// (the 2026-10-04 "本地 11 锚点红 / CI 45 ok" divergence).
const readNorm = (p) => fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');
const mem = new Map();
const resolveTarget = (rel) => {
  if (mem.has(rel)) return mem.get(rel);
  const hit = layouts(rel).find((t) => fs.existsSync(t)) || null;
  mem.set(rel, hit ? readNorm(hit) : null);
  return mem.get(rel);
};

let ok = 0, skipped = 0, failed = 0;
for (const pf of files) {
  const spec = JSON.parse(fs.readFileSync(path.join(patchesDir, pf), 'utf-8'));
  for (const p of spec.patches || []) {
    const tag = `${pf} → ${p.file}`;
    if (p.minApp && cmpVer(app, p.minApp) < 0) { skipped++; console.log(`skip (app ${app} < minApp ${p.minApp}): ${tag}`); continue; }
    if (p.maxApp && cmpVer(app, p.maxApp) > 0) { skipped++; console.log(`skip (app ${app} > maxApp ${p.maxApp}): ${tag}`); continue; }
    const text = resolveTarget(p.file);
    if (text == null) { failed++; console.error(`ANCHOR FAIL (${pf}): target missing: ${p.file} (also public/${p.file})`); continue; }
    const writeBack = (newText) => mem.set(p.file, newText);
    if (text.includes(p.find)) { ok++; console.log(`ok: ${tag}`); writeBack(text.split(p.find).join(p.replace)); continue; }
    if (p.replace && text.includes(p.replace)) { skipped++; console.log(`already applied: ${tag}`); continue; }
    if (p.shrink) {
      const first = p.find.split('\n').find((l) => l.trim() !== '');
      if (first != null && text.includes(first)) {
        ok++; console.log(`ok (shrink-first-line): ${tag}`);
        const lines = text.split('\n');
        const at = lines.findIndex((l) => l.includes(first));
        lines.splice(at, 1, p.replace);
        writeBack(lines.join('\n'));
        continue;
      }
    }
    if (p.optional) { skipped++; console.log(`optional anchor absent: ${tag}`); continue; }
    failed++; console.error(`ANCHOR FAIL (${pf}): ${p.file} lacks ${JSON.stringify(String(p.find).slice(0, 90))}`);
  }
}

// ---- parse gate: the replayed modules must still parse (see the header note) ---------------------
let parseFailed = 0;
{
  const os = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const replayed = [...mem.entries()].filter(([f, text]) => /\.m?js$/.test(f) && text != null);
  const extrasDir = path.join(ownRepo, 'tools', 'apk', 'extras');
  const extras = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) extras.push(p);
    }
  };
  walk(extrasDir);
  const targets = [
    ...replayed.map(([f, text]) => [f, text]),
    ...extras.map((p) => [`extras/${path.relative(extrasDir, p).split(path.sep).join('/')}`, readNorm(p)]),
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-patches-'));
  try {
    for (const [label, src] of targets) {
      const out = path.join(tmp, `${label.replace(/[\\/]/g, '__')}.mjs`);
      fs.writeFileSync(out, src);
      try {
        execFileSync(process.execPath, ['--check', out], { stdio: 'pipe' });
      } catch (e) {
        parseFailed++;
        const detail = `${e.stderr || ''}${e.stdout || ''}`.split('\n').find((l) => l.includes('SyntaxError'))
          || String(e.message).split('\n')[0];
        console.error(`PARSE FAIL (${label}): ${detail.trim()}`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`parse gate: ${targets.length} modules parsed as ESM, ${parseFailed} failed (${replayed.length} replayed, ${extras.length} extras)`);
}

// ---- runtime contract gate (GATE-R1): runs even with an empty patch set ---------------------------
// This is the check that gives "上游 0.2.2 会不会把运行时搞坏" an automatic answer. It asserts the
// DOM anchors / module exports / startServer() shape / i18n label set the shell overlay depends on.
let contractFailed = 0;
{
  console.log('');
  const res = await checkContract(repo, { log: (m) => console.log(`  ${m}`) });
  for (const n of res.notes) console.log(`  note: ${n}`);
  for (const f of res.failures) {
    contractFailed++;
    console.error(`CONTRACT FAIL: ${f.id} — ${f.detail}`);
    if (f.why) console.error(`  后果: ${f.why}`);
    if (f.breaks && f.breaks.length) console.error(`  会坏掉: ${f.breaks.join('  ')}`);
  }
  console.log(`runtime contract: ${res.failures.length} broken`);
}

console.log(`\nanchors: ${ok} ok, ${skipped} skipped, ${failed} failed (${files.length} patch files; app=${app ?? '?'}; sequential simulation)`);
console.log(`gates: anchors=${failed} parse=${parseFailed} runtime-contract=${contractFailed}`);
process.exit(failed || parseFailed || contractFailed ? 1 : 0);
