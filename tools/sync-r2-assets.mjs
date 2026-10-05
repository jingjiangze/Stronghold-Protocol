// Sync the built client's art to the shared R2 bucket (stronghold-assets, published as
// weishucdn): list what the resource-manifest references, HEAD-compare against what is stored,
// PUT the missing/oversized ones. Same key layout the main site's CI mirror uses, so both
// deployments share one art CDN; a divergent re-copy here heals the known overwrite of the
// handful of files whose lineage differs between the two content axes (audit §8) — the main
// site re-overwrites them on its next mirror; this job re-heals. Idempotent; skips same-size.
//
// Env: R2_ACCESS_KEY, R2_SECRET_KEY (the ~/.cf_r2_creds pair, or the repo secrets of the same
// names). Usage: node tools/sync-r2-assets.mjs [dist/client]
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';

const BUCKET = 'stronghold-assets';
const HOST = `${process.env.R2_ENDPOINT || 'https://8641802a2d46497f1cc4e7a4cba365d2.r2.cloudflarestorage.com'}`.replace(/^https:\/\//, '');
const AK = process.env.R2_ACCESS_KEY;
const SK = process.env.R2_SECRET_KEY;
if (!AK || !SK) { console.error('sync-r2-assets: R2_ACCESS_KEY/R2_SECRET_KEY not set'); process.exit(2); }

const REGION = 'auto', SERVICE = 's3';
const hmac = (key, msg) => createHmac('sha256', typeof key === 'string' ? Buffer.from(key) : key).update(msg).digest();
// S3 canonicalization: everything but unreserved (A-Za-z0-9-._~) and '/' is percent-encoded
// (encodeURIComponent would leave !*'() alone — the SigV4 spec does not).
const qencode = (s) => s.split('').map((c) => /[A-Za-z0-9\-._~]/.test(c) ? c : [...Buffer.from(c, 'utf8')].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('')).join('');

function sign(method, canonicalUri, query, payload, headers) {
  const now = new Date();
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const ds = amz.slice(0, 8);
  const ph = createHash('sha256').update(payload).digest('hex');
  const all = { host: HOST, 'x-amz-content-sha256': ph, 'x-amz-date': amz, ...headers };
  const names = Object.keys(all).sort();
  const ch = names.map((k) => `${k}:${all[k]}\n`).join('');
  const cr = [method, canonicalUri, query, ch, names.join(';'), ph].join('\n');
  const scope = `${ds}/${REGION}/${SERVICE}/aws4_request`;
  let k = hmac('AWS4' + SK, ds);
  for (const part of [REGION, SERVICE, 'aws4_request']) k = hmac(k, part);
  const sts = ['AWS4-HMAC-SHA256', amz, scope, createHash('sha256').update(cr).digest('hex')].join('\n');
  const sig = hmac(k, sts).toString('hex');
  return { ...all, Authorization: `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}` };
}

function request(method, key, opts = {}) {
  const uri = `/${BUCKET}/${key.split('/').map(qencode).join('/')}`;
  const { query = '', headers = {}, body = Buffer.alloc(0) } = opts;
  const once = () => new Promise((resolve, reject) => {
    const req = https.request({ host: HOST, path: uri + (query ? '?' + query : ''), method, headers: sign(method, uri, query, body, headers), timeout: 120_000 },
      (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body.length) req.write(body);
    req.end();
  });
  // A transient local-hop drop (socket hang up) retries the whole request: HEAD is a probe,
  // and an idempotent PUT of the same bytes is safe to repeat.
  return once().catch(async (error) => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      try { return await once(); } catch (retry) { error = retry; }
    }
    throw error;
  });
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', atlas: 'text/plain', skel: 'application/octet-stream', json: 'application/json', css: 'text/css' };

const dist = path.resolve(process.argv[2] || 'dist/client');
const manifest = JSON.parse(await fs.readFile(path.join(dist, 'resource-manifest.json'), 'utf8'));
const art = manifest.files.filter((f) => f.url.startsWith('/assets/'));
let checked = 0, uploaded = 0, failed = 0;
const queue = [...art];
async function worker() {
  while (queue.length) {
    const file = queue.shift();
    const key = decodeURIComponent(file.url.slice(1));
    const local = path.join(dist, ...key.split('/'));
    try {
      const head = await request('HEAD', key);
      if (head.status === 200 && Number(head.headers['content-length']) === file.size) { checked++; continue; }
      // A different size (or absent): re-upload from this build's tree, which matches this build's manifest.
      const body = await fs.readFile(local);
      if (createHash('sha256').update(body).digest('hex') !== file.sha256) throw new Error('local file does not match the manifest hash');
      const res = await request('PUT', key, {
        body,
        headers: { 'content-type': MIME[key.split('.').pop()?.toLowerCase()] || 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' },
      });
      if (res.status >= 300) throw new Error(`PUT ${res.status}`);
      uploaded++;
    } catch (error) {
      failed++;
      console.error('FAIL', key, error.message);
    }
    checked++;
    if (checked % 1000 === 0) console.log(`sync-r2-assets: ${checked}/${art.length} checked, ${uploaded} uploaded, ${failed} failed`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
console.log(`sync-r2-assets done: ${checked} checked, ${uploaded} uploaded, ${failed} failed (of ${art.length} referenced)`);
if (failed) process.exit(1);
