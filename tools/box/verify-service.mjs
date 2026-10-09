// tools/box/verify-service.mjs -- check a RUNNING deployment over HTTP: no SSH, no box access, nothing written.
//
// The box updates itself (it pulls our rolling release and blue/green flips by itself, tools/box/sp_update_zip.ps1),
// so the question after merging is never "copy the files" but "did the new build reach the box, and does what it
// serves still hold the contract". This answers both against a URL, and it is the same set of checks a person would
// otherwise type by hand:
//
//   * /healthz reports the build tag, and (with --expect/--wait) it is the one that was asked for;
//   * index.html references its own /css//js//i18n/ files with `?v=<tag>` and leaves /vendor/ alone;
//   * module bodies import each other with `?v=<tag>` and never stamp /vendor/ (two URLs = two instances);
//   * a versioned URL is `immutable`, an unversioned one is not (so a deploy still reaches an open page);
//   * /data (including the art manifests) is versioned the same way.
//
//   node tools/box/verify-service.mjs                                  # against the live host
//   node tools/box/verify-service.mjs --base=http://127.0.0.1:3000     # against a local server
//   node tools/box/verify-service.mjs --expect=<buildTag>              # the box must already be on this build
//   node tools/box/verify-service.mjs --wait=600 --expect=<buildTag>   # ... or wait up to 10 min for it
//
// Exit code 0 = every check passed, 1 = at least one failed (each line says which).

import { moduleRefs, resolvesToVendor } from '../../server/http/moduleVersion.js';

export const DEFAULT_BASE = 'https://weishu.jiangjiangze.icu';

/** index.html: its own asset references must be stamped, the third-party ones must not. */
const OWN_REF = /"(\/(?:css|js|i18n)\/[^"]*)"/g;
const VENDOR_REF = /"(\/vendor\/[^"]*)"/g;

const versionOf = (url) => {
  const m = /[?&]v=([^&]*)/.exec(url);
  return m ? m[1] : null;
};

/**
 * One deployment check.
 * @param {{ base?: string, expect?: string|null, waitMs?: number, fetchFn?: typeof fetch, log?: (s: string) => void }} [opts]
 * @returns {Promise<{ ok: boolean, tag: string|null, waited: number, results: { name: string, ok: boolean, detail: string }[] }>}
 */
export async function verifyService(opts = {}) {
  const base = (opts.base || DEFAULT_BASE).replace(/\/+$/, '');
  const doFetch = opts.fetchFn || ((...a) => globalThis.fetch(...a));
  const log = opts.log || (() => {});
  const waitMs = Number(opts.waitMs || 0);
  const results = [];
  const add = (name, ok, detail = '') => { results.push({ name, ok, detail }); return ok; };

  const get = async (path, init) => {
    const res = await doFetch(base + path, init);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  };
  const cc = (headers) => String(headers.get('cache-control') || '');

  // ---- 1. the build the box is on (optionally waiting for the one we expect) --------------------------
  let health = null;
  const deadline = Date.now() + waitMs;
  let waited = 0;
  for (;;) {
    try {
      const res = await doFetch(base + '/healthz?cb=' + Date.now());
      health = await res.json();
    } catch (e) {
      health = null;
      log(`healthz unreachable: ${e && e.message}`);
    }
    if (!health && Date.now() >= deadline) break;
    if (!opts.expect || (health && health.build === opts.expect)) break;
    if (Date.now() >= deadline) break;
    waited += 5000;
    log(`waiting for build ${opts.expect} (now ${health ? health.build : 'unreachable'}) ...`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  const tag = health && health.build ? health.build : null;
  add('/healthz answers', !!health, health ? `app=${health.app} uptime=${health.uptimeSec}s sockets=${health.sockets}` : 'no answer');
  add('/healthz reports a build tag', !!tag, String(tag));
  if (opts.expect) add(`the box is on build ${opts.expect}`, tag === opts.expect, tag === opts.expect ? '' : `serving ${tag || 'unknown'}`);
  if (!tag) return { ok: results.every((r) => r.ok), tag, waited, results };

  // ---- 2. index.html: own references stamped, vendor untouched ----------------------------------------
  const page = await get('/');
  const own = [...page.text.matchAll(OWN_REF)].map((m) => m[1]);
  const vendor = [...page.text.matchAll(VENDOR_REF)].map((m) => m[1]);
  add('index.html lists its own references', own.length >= 3, `${own.length} own, ${vendor.length} vendor`);
  const stale = own.filter((u) => versionOf(u) !== tag);
  add('every own reference carries the live tag', stale.length === 0, stale.slice(0, 3).join(' '));
  const vendorStamped = vendor.filter((u) => versionOf(u) !== null);
  add('vendor references are never stamped', vendorStamped.length === 0, vendorStamped.slice(0, 3).join(' '));
  add('index.html itself stays revalidatable', /no-cache/.test(cc(page.headers)) && !/immutable/.test(cc(page.headers)), cc(page.headers));

  // ---- 3. module bodies: first-party stamped, vendor untouched ----------------------------------------
  for (const path of ['/js/main.js', '/sim/spec.js', '/shared/constants.js']) {
    const mod = await get(path);
    if (mod.status !== 200) { add(`${path} is served`, false, `HTTP ${mod.status}`); continue; }
    const refs = moduleRefs(mod.text);
    const first = refs.filter((r) => !resolvesToVendor(r.spec, path));
    const third = refs.filter((r) => resolvesToVendor(r.spec, path));
    const missing = first.filter((r) => versionOf(r.spec) !== tag);
    add(`${path}: its own imports carry the tag`, first.length > 0 && missing.length === 0,
      `${first.length} own, ${missing.length} unstamped${missing.length ? ': ' + missing.slice(0, 3).map((r) => r.spec).join(' ') : ''}`);
    const stampedVendor = third.filter((r) => versionOf(r.spec) !== null);
    add(`${path}: vendor imports stay unversioned`, stampedVendor.length === 0, stampedVendor.map((r) => r.spec).join(' '));
  }

  // ---- 4. cache policy: versioned immutable, unversioned NOT immutable ---------------------------------
  // The unversioned side is asserted as "not immutable", not "no-cache": a Cloudflare zone rule is allowed to
  // raise the origin's `no-cache` (this deployment's does -- `max-age=14400` on /js and /css). What has to hold is
  // only that a bare URL is never held for a year, so a deploy still reaches a page someone has open.
  const policy = [
    [`/js/main.js?v=${tag}`, 'immutable'],
    [`/sim/spec.js?v=${tag}`, 'immutable'],
    [`/data/chess.json?v=${tag}`, 'immutable'],
    [`/data/assets.json?v=${tag}`, 'immutable'],
    ['/js/main.js', '!immutable'],
    ['/data/assets.json', '!immutable'],
  ];
  for (const [path, want] of policy) {
    const res = await doFetch(base + path, { method: 'HEAD' });
    const got = cc(res.headers);
    const ok = want === '!immutable' ? !/immutable/.test(got) : new RegExp(want).test(got);
    add(`${path} -> ${want}`, ok, got || '(no cache-control)');
  }

  return { ok: results.every((r) => r.ok), tag, waited, results };
}

// ---- CLI ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { base: DEFAULT_BASE, expect: null, waitMs: 0, json: false };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    if (m[1] === 'base') out.base = m[2];
    else if (m[1] === 'expect') out.expect = m[2];
    else if (m[1] === 'wait') out.waitMs = Number(m[2] || 0) * 1000;
    else if (m[1] === 'json') out.json = true;
  }
  return out;
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isEntry) {
  const args = parseArgs(process.argv.slice(2));
  const report = await verifyService({ ...args, log: (s) => process.stderr.write(`[verify] ${s}\n`) });
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 1) + '\n');
  } else {
    for (const r of report.results) process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}\n`);
    process.stdout.write(`build ${report.tag || '?'} — ${report.ok ? 'all checks passed' : 'FAILURES ABOVE'}\n`);
  }
  process.exit(report.ok ? 0 : 1);
}
