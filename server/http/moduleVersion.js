// server/http/moduleVersion.js — stamp the build tag onto the module graph's own import specifiers.
//
// WHY: `versionIndexHtml` (static.js) gives index.html's own references a `?v=<buildTag>`, but that document
// names exactly ONE module (`/js/main.js`); the ~190 modules the browser imports next carry bare relative
// specifiers ('./ui/x.js'), so files.js `cacheControlFor` can only answer `no-cache` for them and the whole
// graph is revalidated forever. Measured on the live host over 4.85 days: 135 MiB of uplink for /js + /sim +
// /shared, of which 99.5% arrived without any `?v=` (docs/上行带宽最大化压缩.md).
//
// Stamping every specifier with the same buildTag puts all of them on the IMMUTABLE_CACHE branch: the CDN edge
// and the browser keep each module for a year, and only a deploy (a new tag) fetches the graph again. The tag is
// the hash of the served runtime itself (http/buildTag.js), whose inputs are exactly these trees, so there is no
// constant anyone can forget to raise.
//
// WHAT IS TOUCHED — three forms, and only when the specifier is relative or root-absolute AND ends in `.js`:
//     import { a } from './x.js'      export * from '../y.js'      import('./z.js')
//     import '/sim/spec.js'           import '/data.js'            (the generated shim)
// Left alone: bare specifiers ('preact' — the import map's job), `node:` built-ins, non-module assets, and any
// specifier that already carries a query. A specifier inside a comment or a template literal is not a runtime
// reference: rewriting one is harmless (a comment), and the acorn equivalence test in
// test/module-version.test.js proves this regex never rewrites anything else — a string literal that merely
// looks like an import is a test failure, not a silent edit.
//
// `/vendor/` IS NEVER STAMPED, whichever way it is named (a relative `../vendor/x.js`, an absolute one, or a
// bare specifier the import map resolves there). Those bytes come from R2 through the asset worker, so the host
// serves them exactly as published and their own internal imports (`hooks.module.js` → `./preact.module.js`)
// reach the browser unversioned. Stamping only SOME reference to a module splits it in two: the browser keys its
// module map by full URL, and two `preact` instances mean `hooks` is bound to an instance that no component in
// the tree ever renders (found the hard way: the page booted into 启动失败 with both /vendor/preact.module.js and
// /vendor/preact.module.js?v=… in the network log). index.html leaves them unversioned for the same reason.
//
// The rewrite is deterministic (same input + same tag → same output), which the served ETag depends on.

/**
 * `from '…'`, a bare side-effect `import '…'`, and `import('…')`: prefix, quote, specifier.
 * The specifier must start with `./`, `../` or `/` and may not contain a quote or a newline.
 */
const MODULE_REF = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])((?:\.{1,2}\/|\/)[^'"\n]*)\2/g;

/** Specifiers this module rewrites: served ES modules, never stylesheets, JSON or directory URLs. */
const MODULE_EXT = /\.js$/;

/**
 * Does this specifier name a module of the served third-party tree — i.e. one whose own imports nobody stamps?
 * @param {string} spec
 * @param {string} baseUrl url of the module the specifier was found in (e.g. '/js/main.js')
 * @returns {boolean} true when the rewrite must leave it alone (an unresolvable specifier counts: leave it be)
 */
export function resolvesToVendor(spec, baseUrl) {
  try { return new URL(spec, `http://x${baseUrl}`).pathname.startsWith('/vendor/'); } catch { return true; }
}

/**
 * Every specifier in `raw` that the rewrite considers, with its offset inside the source.
 * Exported for the test that compares this against a real parser (acorn): the offsets must be exactly the
 * import specifiers a parser finds, or lie inside a comment.
 * @param {Buffer|string} raw
 * @returns {{ index: number, spec: string }[]}
 */
export function moduleRefs(raw) {
  const body = typeof raw === 'string' ? raw : raw.toString('utf8');
  const out = [];
  MODULE_REF.lastIndex = 0;
  let m;
  while ((m = MODULE_REF.exec(body))) {
    out.push({ index: m.index + m[1].length + 1, spec: m[3] });
  }
  return out;
}

/**
 * `raw` with `?v=<tag>` on every import specifier of this module graph.
 * @param {Buffer|string} raw
 * @param {string} tag build tag (http/buildTag.js); empty → the source is returned untouched
 * @param {string} [baseUrl] url of this module ('/js/main.js'): relative specifiers are resolved against it to
 *   recognise the third-party tree
 * @returns {string}
 */
export function versionModuleJs(raw, tag, baseUrl = '/') {
  const body = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (!tag) return body;
  return body.replace(MODULE_REF, (m, prefix, quote, spec) => {
    if (!MODULE_EXT.test(spec)) return m; // not a served module: leave stylesheets, JSON and directory paths
    if (spec.includes('?')) return m; // already carries a query (a `?v=`, or a caller's own): never double-stamp
    if (resolvesToVendor(spec, baseUrl)) return m; // one URL per third-party module: see the header
    return `${prefix}${quote}${spec}?v=${tag}${quote}`;
  });
}
