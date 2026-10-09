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
// The rewrite is deterministic (same input + same tag → same output), which the served ETag depends on.

/**
 * `from '…'`, a bare side-effect `import '…'`, and `import('…')`: prefix, quote, specifier.
 * The specifier must start with `./`, `../` or `/` and may not contain a quote or a newline.
 */
const MODULE_REF = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])((?:\.{1,2}\/|\/)[^'"\n]*)\2/g;

/** Specifiers this module rewrites: served ES modules, never stylesheets, JSON or directory URLs. */
const MODULE_EXT = /\.js$/;

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
 * @returns {string}
 */
export function versionModuleJs(raw, tag) {
  const body = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (!tag) return body;
  return body.replace(MODULE_REF, (m, prefix, quote, spec) => {
    if (!MODULE_EXT.test(spec)) return m; // not a served module: leave stylesheets, JSON and directory paths
    if (spec.includes('?')) return m; // already carries a query (a `?v=`, or a caller's own): never double-stamp
    return `${prefix}${quote}${spec}?v=${tag}${quote}`;
  });
}
