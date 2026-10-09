// test/module-version.test.js — the served module graph carries the build tag on its own import specifiers.
//
// WHY: `index.html` names one module (`/js/main.js`) and the version stamping of index-version.test.js stops
// there. The ~190 modules it leads to import each other by bare relative specifier, so files.js cacheControlFor
// can only answer `no-cache` for them: the live host sent 135 MiB of /js + /sim + /shared uplink in 4.85 days,
// 99.5% of it on URLs without a `?v=`. Stamping each specifier lands them on the IMMUTABLE_CACHE branch.
//
// What matters here, and why the acorn check exists: this is a regex over JavaScript, so it must be provably
// exact. For every module in the served trees the test compares the rewrite sites against a real parse — the
// two must name the same specifiers, and anything else the regex matched must lie inside a comment (rewriting a
// comment is harmless; a string literal that merely looks like an import would be a silent corruption, and that
// is a failure). It then re-parses the rewritten source, so a bad edit cannot ship as valid-looking output.
// Run: node --test test/module-version.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleRefs, versionModuleJs } from '../server/http/moduleVersion.js';
import { servesVersionedModule } from '../server/http/files.js';
import { startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The trees the browser imports as modules (the same set http/buildTag.js watches). */
const TREES = ['public/js', 'public/dev', 'server/sim', 'shared'];
const TAG = 'abc123';

// ---- helpers -------------------------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Needs the dev dependencies (acorn, which eslint brings) — same contract as tools/i18n.mjs. */
let acornMod = null;
async function acorn() {
  if (acornMod) return acornMod;
  try { acornMod = await import('acorn'); } catch {
    throw new Error('test/module-version.test.js needs the dev dependencies (npm install): acorn comes with eslint');
  }
  return acornMod;
}

/** Is this the kind of specifier the rewrite owns? (relative or root-absolute, a served module) */
const inScope = (spec) => (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) && spec.endsWith('.js');

/**
 * A real parse of `src`: the offset of every import specifier, whether it is in scope, and every comment range.
 * @returns {Promise<{ specs: { index: number, spec: string }[], comments: [number, number][] }>}
 */
async function parseRefs(src, file) {
  const { parse } = await acorn();
  const comments = [];
  let ast;
  try {
    ast = parse(src, {
      ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true,
      onComment: (block, text, start, end) => comments.push([start, end]),
    });
  } catch (e) {
    throw new Error(`${file}: cannot parse (${e.message})`, { cause: e });
  }
  const specs = [];
  const add = (node) => {
    if (!node) return;
    if (node.type === 'Literal' && typeof node.value === 'string') specs.push({ index: node.start + 1, spec: node.value });
    else if (node.type === 'TemplateLiteral') specs.push({ index: node.start, spec: src.slice(node.start, node.end) });
  };
  const walkNode = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walkNode(n); return; }
    if (typeof node.type !== 'string') return;
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') add(node.source);
    else if (node.type === 'ImportExpression') add(node.source);
    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
      const v = node[key];
      if (v && typeof v === 'object') walkNode(v);
    }
  };
  walkNode(ast);
  specs.sort((a, b) => a.index - b.index);
  return { specs, comments };
}

/** URL of a tree file as the browser asks for it (the mounts of server/http/static.js). */
function urlOf(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (rel.startsWith('public/')) return '/' + rel.slice('public/'.length);
  if (rel.startsWith('server/sim/')) return '/sim/' + rel.slice('server/sim/'.length);
  return '/' + rel; // shared/… is served at its own path
}

/** Served URL → file on disk (mirrors static.js). */
function fileOfUrl(urlPath) {
  const clean = decodeURIComponent(urlPath.split(/[?#]/)[0]);
  if (clean.startsWith('/shared/')) return path.join(ROOT, clean);
  if (clean.startsWith('/data/')) return path.join(ROOT, clean);
  if (clean.startsWith('/sim/')) return path.join(ROOT, 'server', clean);
  return path.join(ROOT, 'public', clean);
}

// ---- the rewrite itself -------------------------------------------------------------------------------

test('the rewrite stamps the three import forms and leaves everything else alone', () => {
  const src = [
    "import { a } from './x.js';",
    "export * from '../y.js';",
    "export { b } from './nested/z.js';",
    "import './side-effect.js';",
    "const m = await import('./lazy.js');",
    "import { c } from '/js/abs.js';",
    "import sim from '/sim/spec.js';",
    "import preact from 'preact';",
    "import fs from 'node:fs';",
    "import css from './style.css';",
    "import data from './data.json';",
    "import already from './v.js?v=old';",
  ].join('\n');
  const out = versionModuleJs(src, TAG);
  assert.ok(out.includes(`from './x.js?v=${TAG}'`));
  assert.ok(out.includes(`from '../y.js?v=${TAG}'`));
  assert.ok(out.includes(`from './nested/z.js?v=${TAG}'`));
  assert.ok(out.includes(`import './side-effect.js?v=${TAG}'`));
  assert.ok(out.includes(`import('./lazy.js?v=${TAG}')`));
  assert.ok(out.includes(`from '/js/abs.js?v=${TAG}'`));
  assert.ok(out.includes(`from '/sim/spec.js?v=${TAG}'`));
  assert.ok(out.includes("from 'preact'"));
  assert.ok(out.includes("from 'node:fs'"));
  assert.ok(out.includes("from './style.css'"));
  assert.ok(out.includes("from './data.json'"));
  assert.ok(out.includes("from './v.js?v=old'"), 'a query of its own is never touched');
  assert.equal(out.split(`?v=${TAG}`).length - 1, 7, 'exactly the seven in-scope specifiers');
});

test('stamping is idempotent, deterministic and a missing tag is a no-op', () => {
  const src = "import './a.js';\nimport './b.js';\n";
  const once = versionModuleJs(src, TAG);
  assert.equal(versionModuleJs(once, TAG), once, 'never double-stamp');
  assert.equal(versionModuleJs(src, TAG), once, 'same input + same tag → same bytes (the ETag depends on it)');
  assert.notEqual(versionModuleJs(src, 'other'), once, 'a new build stamps a new tag');
  assert.equal(versionModuleJs(src, ''), src);
  assert.equal(versionModuleJs(src, null), src);
  assert.equal(versionModuleJs(src, undefined), src);
});

test('only the served module trees are rewritten', () => {
  assert.equal(servesVersionedModule('.js', 'public', ['js', 'main.js']), true);
  assert.equal(servesVersionedModule('.js', 'public', ['js', 'ui', 'gameLogic', 'x.js']), true);
  assert.equal(servesVersionedModule('.js', 'public', ['dev', 'game-mock.js']), true);
  assert.equal(servesVersionedModule('.js', 'sim', ['spec.js']), true);
  assert.equal(servesVersionedModule('.js', 'sim', ['battle', 'combat.js']), true);
  assert.equal(servesVersionedModule('.js', 'shared', ['constants.js']), true);
  // vendor: third-party bytes served immutable from R2 (the asset worker) — a tag would only cost CPU
  assert.equal(servesVersionedModule('.js', 'public', ['vendor', 'pixi.min.js']), false);
  // not modules
  assert.equal(servesVersionedModule('.css', 'public', ['css', 'theme.css']), false);
  assert.equal(servesVersionedModule('.json', 'public', ['i18n', 'en.json']), false);
  assert.equal(servesVersionedModule('.js', 'data', ['units.js']), false);
  assert.equal(servesVersionedModule('.js', 'packs', ['x', 'y.js']), false);
  assert.equal(servesVersionedModule('.js', 'public', ['index.html']), false);
});

// ---- the gate: a real parse must agree with the regex, on every served module --------------------------

test('every module the browser loads is rewritten exactly where a parser says the specifiers are', async () => {
  const files = [];
  for (const tree of TREES) walk(path.join(ROOT, tree), files);
  assert.ok(files.length >= 150, `expected the served module trees, got ${files.length} files`);

  const misses = [];
  const extras = [];
  const inComments = [];
  const broken = [];
  let inScopeCount = 0;

  for (const file of files) {
    const label = path.relative(ROOT, file).split(path.sep).join('/');
    const src = readFileSync(file, 'utf8');
    const { specs, comments } = await parseRefs(src, label);
    const sites = moduleRefs(src);
    const byIndex = new Map(specs.map((s) => [s.index, s.spec]));
    const siteIndex = new Map(sites.map((s) => [s.index, s.spec]));

    // (1) no miss: every in-scope specifier a parser found is a rewrite site
    for (const s of specs) {
      if (!inScope(s.spec)) continue;
      inScopeCount++;
      if (!siteIndex.has(s.index)) misses.push(`${label}: missed ${s.spec}`);
    }
    // (2) no silent extra: everything else the regex matched is a real specifier or inside a comment
    for (const s of sites) {
      if (byIndex.get(s.index) === s.spec) continue;
      const line = src.slice(0, s.index).split('\n').length;
      if (comments.some(([a, b]) => s.index >= a && s.index < b)) { inComments.push(`${label}:${line}`); continue; }
      extras.push(`${label}:${line} ${JSON.stringify(s.spec)}`);
    }

    // (3) the rewritten source parses and names the same specifiers, each of them versioned
    const out = versionModuleJs(src, TAG);
    const after = await parseRefs(out, `${label} (rewritten)`);
    assert.equal(after.specs.length, specs.length, `${label}: a specifier disappeared`);
    for (let i = 0; i < specs.length; i++) {
      const was = specs[i].spec;
      const now = after.specs[i].spec;
      if (inScope(was)) {
        assert.equal(now, `${was}?v=${TAG}`, `${label}: wrong stamp on ${was}`);
        // the stamped URL still names the same file (a query never changes what is served); `/data.js` is the
        // generated browser stand-in of server/data.js (static.js DATA_SHIM_JS), so it has no file of its own
        const urlPath = new URL(was, 'http://x' + urlOf(file)).pathname;
        const target = fileOfUrl(urlPath);
        if (urlPath !== '/data.js' && !existsSync(target)) broken.push(`${label}: ${was} → missing ${path.relative(ROOT, target)}`);
      } else {
        assert.equal(now, was, `${label}: untouched specifier changed`);
      }
    }
  }

  assert.deepEqual(misses, [], 'a specifier a parser found was not stamped');
  assert.deepEqual(extras, [], 'the regex matched something that is neither an import nor a comment');
  assert.deepEqual(broken, [], 'a stamped specifier no longer resolves to a file');
  assert.ok(inScopeCount >= 500, `expected the whole graph's specifiers, got ${inScopeCount}`);
  // comment-internal matches are rewritten too (a JSDoc `import('./x.js')`): harmless, and counted here so a
  // jump in their number is visible in the test output rather than a mystery.
  console.log(`[module-version] ${files.length} modules, ${inScopeCount} specifiers, ${inComments.length} inside comments`);
});

// ---- served: the graph reaches the browser stamped, and the policy follows ----------------------------

test('a served module carries the live tag on its own imports and stays revalidatable without one', async (t) => {
  const srv = await startServer({ port: 0, quiet: true });
  t.after(() => srv.close());
  const tag = (await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json()).build;
  assert.ok(tag, 'the server reports a build tag');

  const res = await fetch(`http://127.0.0.1:${srv.port}/js/main.js`);
  assert.equal(res.status, 200);
  const body = await res.text();
  const specs = [...body.matchAll(/\bfrom\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(specs.length >= 5, `expected main.js to import several modules, got ${specs.length}`);
  for (const spec of specs) assert.ok(spec.endsWith(`?v=${tag}`), `unversioned import in the served body: ${spec}`);
  // the file on disk is untouched: only the response is rewritten
  const disk = readFileSync(path.join(ROOT, 'public', 'js', 'main.js'), 'utf8');
  assert.ok(!disk.includes(`?v=${tag}`), 'the served rewrite never reaches the file on disk');
  // no query → still revalidated (the browser must ask again for a new tag); with `?v=` → immutable
  assert.match(res.headers.get('cache-control') || '', /no-cache/);
  const ver = await fetch(`http://127.0.0.1:${srv.port}/js/main.js?v=${tag}`);
  assert.match(ver.headers.get('cache-control') || '', /immutable/);
});

test('the sim and shared mounts are stamped too, vendor is not', async (t) => {
  const srv = await startServer({ port: 0, quiet: true });
  t.after(() => srv.close());
  const tag = (await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json()).build;

  const sim = await (await fetch(`http://127.0.0.1:${srv.port}/sim/content/support/index.js`)).text();
  assert.ok(sim.includes(`?v=${tag}`), 'a /sim/ module imports its data through the shim, stamped');

  const shared = await (await fetch(`http://127.0.0.1:${srv.port}/shared/constants.js`)).text();
  assert.ok(shared.includes(`from './i18n.js?v=${tag}'`), 'the /shared/ mount is stamped as well');

  const vendor = await (await fetch(`http://127.0.0.1:${srv.port}/vendor/hooks.module.js`)).text();
  assert.ok(vendor.includes("from\"./preact.module.js\""), 'vendor bytes are served as published (R2 immutable)');
  assert.ok(!vendor.includes('?v='), 'vendor is never rewritten');
});
