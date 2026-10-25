// module-exports.test.mjs — every named import inside the shell's extras must exist.
//
//   node --test tools/apk/module-exports.test.mjs
//
// WHY (2026-10-17 现场「游戏脚本加载失败」):
// the UI package's `screens/settle.js` imports { friendsStore, requestFriend, Glyph, THUMB, ADD_FRIEND }
// from `ui/friends.js`, and `ui/achievements.js` imports { useCurrentAccount, openAccountPanel } from
// `ui/accounts.js`. The shell shipped OLDER, smaller compat shims for both files, so the browser failed
// the whole module graph at link time with
//     SyntaxError: The requested module '../ui/friends.js' does not provide an export named 'ADD_FRIEND'
// and the only visible symptom was boot.js's "游戏脚本加载失败". Nothing in the build noticed, because
// a missing *export* is not a syntax error and the files exist.
//
// This gate links the extras against each other (and against the repo's public/js) the same way the
// browser does: every named import must be exported by its target.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const ROOTS = [path.join(repo, 'tools', 'apk', 'extras', 'public'), path.join(repo, 'public')];

function walk(dir, out = []) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of names) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const cache = new Map();
function exportsOf(file) {
  if (cache.has(file)) return cache.get(file);
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { cache.set(file, null); return null; }
  const clean = stripComments(src);
  const names = new Set();
  let star = false;
  for (const m of clean.matchAll(/\bexport\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of clean.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(seg);
      names.add(as ? as[1] : seg.split(/\s+/)[0]);
    }
  }
  if (/\bexport\s+default\b/.test(clean)) names.add('default');
  if (/\bexport\s*\*\s*from\b/.test(clean)) star = true;
  const out = { names, star, clean };
  cache.set(file, out);
  return out;
}

/** Resolve a relative specifier the way the browser does (clamped at the webroot). */
function resolveFrom(file, spec) {
  for (const root of ROOTS) {
    const relToRoot = path.relative(root, file);
    if (relToRoot.startsWith('..')) continue;
    const rel = path.posix.normalize('/' + relToRoot.replace(/\\/g, '/') + '/' + spec);
    const target = path.join(root, rel);
    if (fs.existsSync(target)) return target;
  }
  return null;
}

test('extras: every named import resolves to an existing export', () => {
  // BOTH roots: an extras file's own imports, and — the direction that broke the page on 2026-10-19 — an
  // UPSTREAM file importing a name the override dropped (main.js imports joinKnown from the overridden
  // screens/lobby.js). resolveFrom() tries extras first, so each import is checked against the file the
  // browser actually loads.
  const files = [...walk(ROOTS[0]), ...walk(ROOTS[1])];
  const inExtras = (p) => !path.relative(ROOTS[0], p).startsWith('..');
  // 2026-10-25（上游 0.3.3 同步）：一个 **被 extras 同名遮蔽** 的上游文件永远不会被加载
  // （copyExtras 在装配期整体覆盖），它的 import 语句不参与模块链接。之前不跳过它们，
  // 会把「上游 room.js 想 import 某个名字、而遮蔽它的 extras 版是另一套实现」误报成断裂。
  const shadowed = (p) => !inExtras(p) && fs.existsSync(path.join(ROOTS[0], path.relative(ROOTS[1], p)));
  const broken = [];
  let checked = 0;
  for (const f of files) {
    if (shadowed(f)) continue; // 这个上游文件被 extras 顶掉了，永不加载
    const mod = exportsOf(f);
    if (!mod) continue;
    for (const m of mod.clean.matchAll(/\bimport\s*(?:\*\s*as\s*[\w$]+\s*|\{([^}]*)\}\s*)?from\s*['"]([^'"]+)['"]/g)) {
      const [, braces, spec] = m;
      if (!spec.startsWith('.')) continue;
      const target = resolveFrom(f, spec);
      if (!target) continue; // target lives outside both roots — not this gate's business
      // A file of the repo's own public/ tree is only in scope when the override REPLACES its target;
      // the repo tree drifts from the deployed upstream at unrelated paths (two such pairs today), and
      // those are not module-link failures on the device.
      if (!inExtras(f) && !inExtras(target)) continue;
      if (!braces) continue;
      const tmod = exportsOf(target);
      if (!tmod || tmod.star) continue;
      for (const part of braces.split(',')) {
        const seg = part.trim();
        if (!seg) continue;
        const name = seg.split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        checked++;
        if (!tmod.names.has(name)) {
          broken.push(`${path.relative(repo, f).replace(/\\/g, '/')} imports { ${name} } from '${spec}' — not exported`);
        }
      }
    }
  }
  assert.ok(checked > 50, `expected to check many imports, only saw ${checked}`);
  assert.deepEqual(broken, [],
    'these imports fail at module-link time in the browser (the page shows "游戏脚本加载失败"):\n  '
    + broken.join('\n  '));
});

// The two shims the UI package's screens import from, named explicitly: these are the exact exports
// whose absence produced "游戏脚本加载失败" on vc2038 (settle.js / achievements.js failed to link).
test('compat shims export what the UI package imports', () => {
  const need = {
    'tools/apk/extras/public/js/ui/friends.js': ['friendsStore', 'requestFriend', 'Glyph', 'THUMB', 'ADD_FRIEND'],
    'tools/apk/extras/public/js/ui/accounts.js': ['useCurrentAccount', 'openAccountPanel'],
  };
  for (const [rel, names] of Object.entries(need)) {
    const mod = exportsOf(path.join(repo, rel));
    assert.ok(mod, `${rel} is missing`);
    const missing = names.filter((n) => !mod.names.has(n));
    assert.deepEqual(missing, [], `${rel} must export ${names.join(', ')} (missing: ${missing.join(', ')})`);
  }
});
