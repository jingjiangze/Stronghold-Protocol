// github-mirror -- first-party mirror for GitHub release assets, for ONE repo you control.
//
// Reuses the logic the public download site's repo (jingjiangze/stronghold-download) was
// built on, in one Worker instead of a Pages project plus CI: visitors in mainland China cannot reliably reach
// api.github.com at all (anonymous limits are per-IP and residential uplinks hit 403), and a
// bare github.com link is worse. So the Worker answers "what is the newest release" from its
// own egress with an edge cache, and hands out the bytes from your bucket.
//
// Red line, inherited from that site: only files YOU published (APK, server zip, content
// packs, patches). Game art is not yours to redistribute -- it stays in the private bucket
// that asset-cdn.worker.mjs reads. This Worker will not fetch an arbitrary URL: REPO is a
// constant, the path is whitelisted, and '..' is rejected.
const REPO = 'your-org/your-repo';                       // <- the only upstream this mirrors
const R2_HOST = 'dl.example.com';                        // <- your bucket's custom domain
const KEY_PREFIX = 'gh-mirror/';                         // bucket namespace, nothing else lives here
const SIZE_TOLERANCE = 65536;                            // bytes; a rebuild delta is normal, a different build is not
const MAX_MIRROR_BYTES = 1024 * 1024 * 1024;             // refuse to pull a monster through your origin
const LIST_TTL = 300;                                    // seconds the release list lives at the edge
const ACCELERATORS = ['https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/'];

const json = (body, status, maxAge) => new Response(JSON.stringify(body), {
  status: status || 200,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=' + (maxAge || 0) },
});
const ghApi = (p) => 'https://api.github.com/repos/' + REPO + p;
const ghAsset = (tag, file) => 'https://github.com/' + REPO + '/releases/download/' + tag + '/' + file;
const r2Key = (tag, file) => KEY_PREFIX + tag + '/' + file;
const r2Url = (tag, file) => 'https://' + R2_HOST + '/' + r2Key(tag, file).split('/').map(encodeURIComponent).join('/');
const busted = (u) => u + '?cb=' + Date.now().toString(36) + Math.random().toString(36).slice(2);

// A cache-buster is mandatory on probes: the edge happily keeps a 404 for hours when a
// request lands while the upload is still in flight, and a cached miss reads as "the mirror
// does not have this build".
async function probe(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', headers: { 'user-agent': 'sp-github-mirror' }, cf: { cacheTtl: 0 } });
    return { ok: r.ok, size: Number(r.headers.get('content-length') || 0) };
  } catch { return { ok: false, size: 0 }; }
}

async function latestRelease(env) {
  const cached = await caches.default.match(new Request('https://internal/api/latest'));
  if (cached) return cached.json();
  let rel = null;
  try {
    const r = await fetch(ghApi('/releases?per_page=100'), {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'sp-github-mirror', ...(env.GH_TOKEN ? { authorization: 'Bearer ' + env.GH_TOKEN } : {}) },
      cf: { cacheTtl: 0 },
    });
    if (r.ok) {
      const list = await r.json();
      rel = list.find((x) => !x.draft && !x.prerelease && Array.isArray(x.assets) && x.assets.length) || null;
    }
  } catch { /* fall through to the snapshot */ }
  if (rel) {
    const body = { ok: true, source: 'github', at: new Date().toISOString(), release: { tag: rel.tag_name, name: rel.name, url: rel.html_url, published: rel.published_at, assets: rel.assets.map((a) => ({ name: a.name, size: a.size, digest: a.digest, browser: a.browser_download_url })) } };
    await env.ASSETS.put(KEY_PREFIX + 'latest.json', JSON.stringify(body), { httpMetadata: { contentType: 'application/json' } });
    const out = json(body, 200, LIST_TTL);
    await caches.default.put(new Request('https://internal/api/latest'), out.clone());
    return body;
  }
  // Upstream is down or rate-limited: serve the last known answer and say so, never a
  // bundled snapshot that silently lies about being current.
  const snap = await env.ASSETS.get(KEY_PREFIX + 'latest.json');
  if (snap) { const body = await snap.json(); body._stale = true; return body; }
  return { ok: false, error: 'upstream unavailable and no snapshot yet' };
}

// Pull one asset through and store it verbatim. GitHub publishes a sha256 digest per asset,
// so the copy can be proven identical rather than merely same-named -- the failure mode this
// ecosystem actually hit was a bucket object that matched the tag but was a different build
// (521,193,612 B against a 543,630,883 B release).
async function mirrorAsset(env, tag, file, expected) {
  const url = ghAsset(tag, file);
  if (expected && expected.size > MAX_MIRROR_BYTES) return { ok: false, reason: 'too-large', size: expected.size };
  let res;
  try { res = await fetch(url, { headers: { 'user-agent': 'sp-github-mirror' }, cf: { cacheTtl: 0 } }); }
  catch { return { ok: false, reason: 'origin-unreachable' }; }
  if (!res.ok) return { ok: false, reason: 'upstream-' + res.status };
  const buf = await res.arrayBuffer();
  if (expected && Math.abs(buf.byteLength - expected.size) > SIZE_TOLERANCE) return { ok: false, reason: 'size-mismatch', got: buf.byteLength, want: expected.size };
  if (expected && expected.digest) {
    const want = String(expected.digest).replace(/^sha256-/, '');
    const got = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (got !== want) return { ok: false, reason: 'digest-mismatch', got, want };
  }
  await env.ASSETS.put(r2Key(tag, file), buf, {
    httpMetadata: { contentType: res.headers.get('content-type') || 'application/octet-stream', cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { source: url, bytes: String(buf.byteLength), mirroredAt: new Date().toISOString() },
  });
  return { ok: true, size: buf.byteLength };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.includes('..')) return new Response('forbidden', { status: 403 });

    if (url.pathname === '/api/latest') {
      const body = await latestRelease(env);
      return json(body, body.ok || body.release ? 200 : 502, body.ok ? LIST_TTL : 30);
    }

    const m = url.pathname.match(/^\/(d|mirror)\/([^/]+)\/([^/]+)$/);
    if (!m) return new Response('usage: /api/latest | /d/<tag>/<file> | /mirror/<tag>/<file>', { status: 404, headers: { 'content-type': 'text/plain' } });
    const mode = m[1];
    const tag = decodeURIComponent(m[2]);
    const file = decodeURIComponent(m[3]);
    if (!/^[\w.+-]{1,80}$/.test(tag) || !/^[\w.+-]{1,120}$/.test(file)) return new Response('bad tag or file name', { status: 400 });

    const rel = await latestRelease(env);
    const asset = rel.release && rel.release.tag === tag ? rel.release.assets.find((a) => a.name === file) : null;
    if (!asset) return new Response('unknown release or asset for ' + REPO, { status: 404 });

    const cdn = await probe(busted(r2Url(tag, file)));
    const holds = cdn.ok && Math.abs(cdn.size - asset.size) <= SIZE_TOLERANCE;

    // /mirror = fill the bucket, then answer. Keep it off the player click path: it is the
    // operator's own step (or a cron hitting this URL), because it pulls GitHub bytes
    // through your edge.
    let pulled = null;
    if (!holds && (mode === 'mirror' || url.searchParams.get('pull') === '1')) pulled = await mirrorAsset(env, tag, file, asset);

    const headers = new Headers({ 'access-control-allow-origin': '*', 'x-download-reason': holds ? 'ok' : (pulled ? pulled.reason : 'cdn-miss') });
    const redirect = (location, source) => {
      headers.set('x-download-source', source);
      headers.set('location', location);
      return new Response(null, { status: 302, headers });
    };
    if (holds || (pulled && pulled.ok)) return redirect(r2Url(tag, file), 'first-party');
    // Third-party prefix mirrors may serve stale or re-packaged bytes; that is still better
    // than a bare github.com link for a visitor who cannot reach github.com, which is the
    // whole reason this page exists. The header tells you which one you got.
    for (const acc of ACCELERATORS) {
      const host = acc.replace(/^https:\/\//, '').replace(/\/$/, '');
      if (url.searchParams.get('probe') === '1') { const p = await probe(busted(acc + ghAsset(tag, file))); if (!p.ok) continue; }
      return redirect(acc + ghAsset(tag, file), host);
    }
    return redirect(ghAsset(tag, file), 'github');
  },
};
