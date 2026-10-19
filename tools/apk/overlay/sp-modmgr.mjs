// sp-modmgr.mjs — /mod, the local MOD manager (2026-10-19 业主：「本机内置的浏览器和 forge 改为
// MOD 管理器」). Ported from the MOD 管理器 session's server/mods/{index,page,import}.js so the shell
// has ONE manager surface again: GET /mod (page), GET /mod/status.json, POST /mod/upload,
// POST /mod/fetch, POST /mod/enable.
//
// There is exactly one loading chain: a Forge pack (pack.json) goes through upstream's own
// importForge (which converts it into plugin folders), a plugin zip (plugin.json) through
// installPluginBytes. Enabling/disabling writes plugins/config.json (the room's opening set);
// the policy file is re-read by mtime, so NEW rooms pick it up and open rooms keep their set.
//
// Who may use it (same gate as the studio): this machine or the local network, a local Host; a
// write additionally needs the owner's key (plugins/.studio-key) in X-SP-Mod (or X-SP-Studio /
// ?key=). Reads need no key. Everything is opt-in: an import installs; a room still has to
// switch it on.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_JSON = 64 * 1024;

export const OVERLAY_ID = 'sp-modmgr';
export const overlayApi = 1;

function json(res, code, body) {
  try {
    const text = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  } catch { /* client went away */ }
}

function text(res, code, body, type) {
  try {
    res.writeHead(code, { 'content-type': (type || 'text/plain') + '; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  } catch { /* client went away */ }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > limit) {
      const e = new Error('body larger than ' + Math.round(limit / 1048576) + ' MB'); e.code = 'SIZE';
      req.resume(); reject(e); return;
    }
    const chunks = []; let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { const e = new Error('body larger than ' + Math.round(limit / 1048576) + ' MB'); e.code = 'SIZE'; chunks.length = 0; req.resume(); reject(e); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>MOD 管理器 · Mods</title>
<style>
:root{color-scheme:dark}body{margin:0;padding:24px 16px 64px;background:#0C0F0E;color:#c3cbc7;font:14px/1.55 system-ui,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto}h1{font-size:20px;margin:0 0 2px;color:#f2f2f2}p.sub{margin:0 0 18px;color:#8a948f}
section{border:1px solid #3e4b45;background:rgba(18,24,22,.72);padding:14px 16px;margin:0 0 14px}
h2{font-size:13px;margin:0 0 10px;color:#4ed8af;letter-spacing:.08em;text-transform:uppercase}
label{display:block;margin:0 0 8px;color:#8a948f;font-size:12px}input,button{font:inherit}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #3e4b45;background:#0a0d0c;color:#f2f2f2}
input[type=file]{width:100%;color:#c3cbc7;padding:4px 0}
button{padding:8px 14px;border:1px solid #2a9e7f;background:#121816;color:#4ed8af;cursor:pointer}
button:disabled{opacity:.45;cursor:not-allowed}button.alt{border-color:#3e4b45;color:#c3cbc7}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
pre{white-space:pre-wrap;word-break:break-word;background:#0a0d0c;border:1px solid #3e4b45;padding:10px;max-height:360px;overflow:auto;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #2a352f}
th{color:#8a948f;font-weight:500}code{background:#0a0d0c;padding:1px 5px}
.ok{color:#4ed8af}.bad{color:#e06c5a}.dim{color:#8a948f}
a.back{display:inline-block;margin-bottom:14px;color:#4ed8af;text-decoration:none;border:1px solid #2a9e7f;padding:6px 12px}
</style></head><body><main>
<a class="back" href="/">← 回游戏 · Back</a>
<h1>MOD 管理器 · Mods</h1>
<p class="sub">只在本机或局域网可用。导入只**安装**，不会自动在任何房间启用 —— 房间仍需自己选中。</p>
<section><h2>钥匙 · Key</h2>
<label>写入需要业主钥匙（plugins/.studio-key），只存在本浏览器；读列表不需要。</label>
<div class="row"><input id="key" type="password" placeholder="X-SP-Mod key" autocomplete="off">
<button class="alt" id="saveKey">记住</button></div></section>
<section><h2>上传 · Upload</h2>
<label>Forge 包（pack.json）或插件包（plugin.json）的 zip。</label>
<div class="row"><input id="file" type="file" accept=".zip,application/zip">
<label style="margin:0"><input id="force" type="checkbox"> 覆盖</label>
<button id="upload">上传并导入</button></div></section>
<section><h2>从站抓取 · Fetch</h2>
<label>仅接受公开 https 地址；sha256 可选（给则校验）。</label>
<label>URL<input id="url" type="text" placeholder="https://example.com/pack.zip"></label>
<label>sha256（可选）<input id="sha" type="text" placeholder="64 hex"></label>
<div class="row"><button id="fetch">抓取并导入</button></div></section>
<section><h2>已安装 · Installed</h2>
<div class="row" style="margin-bottom:8px"><button class="alt" id="reload">刷新</button>
<span class="dim" id="meta"></span></div>
<table><thead><tr><th>id</th><th>名称</th><th>版本</th><th>类别</th><th>状态</th><th>房间默认</th></tr></thead><tbody id="rows"></tbody></table>
<p class="dim">「房间默认」= 新建房间开局带上的插件（plugins/config.json 的 default）。改完对**新房间**生效。</p></section>
<section><h2>结果 · Result</h2><pre id="out" class="dim">（还没有操作）</pre></section>
</main><script>
(()=>{const $=(id)=>document.getElementById(id);const out=$('out');
const show=(v)=>{out.textContent=typeof v==='string'?v:JSON.stringify(v,null,2)};
const key=()=>$('key').value.trim();
$('key').value=localStorage.getItem('sp-mod-key')||'';
$('saveKey').onclick=()=>{localStorage.setItem('sp-mod-key',key());show('已记住钥匙')};
const busy=(b)=>{for(const id of ['upload','fetch','reload'])$(id).disabled=b};
async function status(){const r=await fetch('/mod/status.json',{cache:'no-store'});const j=await r.json();
$('meta').textContent=(j.plugins||[]).length+' 个插件 · 收件目录 '+j.inbox;
$('rows').innerHTML=(j.plugins||[]).map((p)=>{const st=p.status==='loaded'?'<span class="ok">loaded</span>':p.status==='disabled'?'<span class="bad">disabled</span>':'<span class="dim">'+(p.status||'skipped')+'</span>';
const t=p.required?'<span class="dim">必需</span>':'<button class="alt" data-toggle="'+p.id+'" data-on="'+(p.enabled?'0':'1')+'">'+(p.enabled?'停用':'启用')+'</button>';
return '<tr><td><code>'+p.id+'</code></td><td>'+p.name+'</td><td>'+p.version+'</td><td>'+(p.class||'')+'</td><td>'+st+'</td><td>'+t+'</td></tr>'}).join('')||'<tr><td colspan="6" class="dim">（没有插件）</td></tr>';
return j}
$('reload').onclick=async()=>{try{const j=await status();show({installed:(j.plugins||[]).length,inbox:j.inbox})}catch(e){show(String(e))}};
$('rows').onclick=async(e)=>{const b=e.target.closest('[data-toggle]');if(!b)return;if(!key())return show('先填钥匙');
b.disabled=true;try{const r=await fetch('/mod/enable',{method:'POST',headers:{'X-SP-Mod':key(),'Content-Type':'application/json'},body:JSON.stringify({id:b.dataset.toggle,on:b.dataset.on==='1'})});show(await r.json());await status()}catch(err){show(String(err))}finally{b.disabled=false}};
$('upload').onclick=async()=>{const f=$('file').files[0];if(!f)return show('先选一个 zip');if(!key())return show('先填钥匙');
busy(true);try{const r=await fetch('/mod/upload'+($('force').checked?'?force=1':''),{method:'POST',headers:{'X-SP-Mod':key(),'Content-Type':'application/zip'},body:f});show(await r.json());await status()}catch(e){show(String(e))}finally{busy(false)}};
$('fetch').onclick=async()=>{const url=$('url').value.trim();if(!url)return show('先填 URL');if(!key())return show('先填钥匙');
busy(true);try{const body={url};const sha=$('sha').value.trim();if(sha)body.sha256=sha;if($('force').checked)body.force=true;
const r=await fetch('/mod/fetch',{method:'POST',headers:{'X-SP-Mod':key(),'Content-Type':'application/json'},body:JSON.stringify(body)});show(await r.json());await status()}catch(e){show(String(e))}finally{busy(false)}};
status().catch((e)=>{$('rows').innerHTML='<tr><td colspan="6" class="bad">'+String(e)+'</td></tr>'});
})();
</script></body></html>`;

export function install(ctx) {
  const server = ctx && ctx.server;
  const upstreamDir = ctx && ctx.upstreamDir;
  if (!server || !upstreamDir) throw new Error('sp-modmgr: needs server + upstreamDir');
  const webroot = path.dirname(upstreamDir);
  const pluginsDir = path.join(webroot, 'plugins');
  const dataDir = path.join(webroot, 'data');
  const log = ctx.log || console;
  const registry = ctx.server.registry || null;
  const up = (rel) => pathToFileURL(path.join(upstreamDir, rel)).href;

  // Upstream modules are the ONE loading chain (upstream 0.3.1 has all of them).
  let gateMod = null, keyMod = null, installMod = null, forgeMod = null, limits = null;
  const ready = (async () => {
    gateMod = await import(up('studio/gate.js'));
    keyMod = await import(up('studio/key.js'));
    installMod = await import(up('plugins/install.js'));
    forgeMod = await import(up('plugins/forgeImport.js'));
    limits = await import(up('../shared/plugins/manifest.js'));
  })().catch((e) => { log.warn?.('[modmgr] upstream modules unavailable: ' + (e && e.message || e)); });

  function statusRows() {
    let list = [];
    try { list = registry ? registry.plugins() : []; } catch { list = []; }
    let policy = {};
    try { policy = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'config.json'), 'utf8')) || {}; } catch { policy = {}; }
    const enabled = new Set(Array.isArray(policy.default) ? policy.default : []);
    const required = new Set(Array.isArray(policy.required) ? policy.required : []);
    const rows = list.filter((p) => p && p.id && !String(p.id).startsWith('_')).map((p) => ({
      id: p.id,
      name: (p.manifest && p.manifest.name) || p.name || p.id,
      version: (p.manifest && p.manifest.version) || p.version || '',
      class: p.class || (p.manifest && p.manifest.class) || '',
      status: p.status || '',
      enabled: enabled.has(p.id),
      required: required.has(p.id),
    })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { plugins: rows, default: [...enabled], required: [...required] };
  }

  async function importArchive(buffer, force) {
    const files = await forgeMod.readUntrustedZip(buffer);
    if (files.has('pack.json')) {
      const r = await forgeMod.importForge({ zip: buffer }, {
        root: webroot, pluginsDir, dataDir, force: !!force,
        vanilla: registry && typeof registry.vanillaAssets === 'function' ? registry.vanillaAssets() : null,
      });
      return { kind: 'pack', ...r };
    }
    if (files.has('plugin.json')) {
      try {
        const r = installMod.installPluginBytes(buffer, { pluginsDir, force: !!force });
        return { kind: 'plugin', ok: true, wrote: true, ...r };
      } catch (e) {
        const code = (installMod.InstallError && e instanceof installMod.InstallError) ? e.code : 'PLUGIN_INSTALL_ZIP';
        return { kind: 'plugin', ok: false, wrote: false, error: code, detail: String(e && e.message || e).slice(0, 300) };
      }
    }
    return { kind: 'unknown', ok: false, wrote: false, error: 'PLUGIN_INSTALL_ZIP', detail: 'zip 里既没有 pack.json 也没有 plugin.json' };
  }

  const changeAllowed = (req) => {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try { return new URL(String(origin)).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { return false; }
  };

  async function handle(req, res, pathname) {
    await ready;
    if (!gateMod || !keyMod) { json(res, 503, { ok: false, error: 'MODULES' }); return true; }
    if (!gateMod.studioAllowed(req).ok) { text(res, 404, '未找到该页面 · Not found'); return true; }
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const { key } = keyMod.loadStudioKey(pluginsDir, { log });
    const keyOk = (req2) => {
      const h = req2.headers['x-sp-mod'] || req2.headers['x-sp-studio'];
      let q = null;
      try { q = new URLSearchParams(String(req2.url || '').split('?')[1] || '').get('key'); } catch { q = null; }
      return keyMod.sameKey(String(h || q || ''), key);
    };

    if (pathname === '/mod' || pathname === '/mod/') {
      if (method !== 'GET') { text(res, 405, 'method not allowed'); return true; }
      text(res, 200, PAGE, 'text/html');
      return true;
    }
    if (pathname === '/mod/status.json') {
      if (method !== 'GET') { text(res, 405, 'method not allowed'); return true; }
      const inboxDir = path.join(webroot, 'mod-inbox');
      let inboxCount = null;
      try { inboxCount = fs.readdirSync(inboxDir).filter((n) => n.endsWith('.zip')).length; } catch { inboxCount = null; }
      json(res, 200, { ok: true, inbox: inboxDir, ...statusRows(), inboxCount });
      return true;
    }
    if (pathname === '/mod/upload') {
      if (method !== 'POST') { text(res, 405, 'method not allowed'); return true; }
      if (!changeAllowed(req)) { json(res, 403, { ok: false, error: 'CROSS_SITE' }); return true; }
      if (!keyOk(req)) { json(res, 403, { ok: false, error: 'KEY' }); return true; }
      let body;
      try { body = await readBody(req, limits.PLUGIN_LIMITS.pluginBytes); } catch (e) { json(res, e.code === 'SIZE' ? 413 : 400, { ok: false, error: 'SIZE', detail: String(e.message || e) }); return true; }
      const force = (() => { try { return new URLSearchParams(String(req.url || '').split('?')[1] || '').get('force') === '1'; } catch { return false; } })();
      const r = await importArchive(body, force);
      try { registry?.rescan?.(); } catch { /* ignore */ }
      json(res, r.ok ? 200 : 400, r);
      return true;
    }
    if (pathname === '/mod/fetch') {
      if (method !== 'POST') { text(res, 405, 'method not allowed'); return true; }
      if (!changeAllowed(req)) { json(res, 403, { ok: false, error: 'CROSS_SITE' }); return true; }
      if (!keyOk(req)) { json(res, 403, { ok: false, error: 'KEY' }); return true; }
      let body;
      try { body = await readBody(req, MAX_JSON); } catch (e) { json(res, 413, { ok: false, error: 'SIZE' }); return true; }
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { json(res, 400, { ok: false, error: 'JSON' }); return true; }
      const url = typeof parsed.url === 'string' ? parsed.url.trim() : '';
      const sha256 = typeof parsed.sha256 === 'string' ? parsed.sha256.trim().toLowerCase() : '';
      if (!url) { json(res, 400, { ok: false, error: 'URL' }); return true; }
      if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) { json(res, 400, { ok: false, error: 'SHA256' }); return true; }
      let buf;
      try {
        buf = await installMod.fetchHttps(url, { maxBytes: limits.PLUGIN_LIMITS.pluginBytes, timeoutMs: 60000, kind: 'zip', allowDownloadHosts: installMod.readDownloadAllow(pluginsDir), pluginsDir });
      } catch (e) { json(res, 400, { ok: false, error: e && e.code || 'DOWNLOAD', detail: String(e && e.message || e).slice(0, 300) }); return true; }
      if (sha256) {
        const got = createHash('sha256').update(buf).digest('hex');
        if (got !== sha256) { json(res, 400, { ok: false, error: 'SHA256', detail: 'got ' + got }); return true; }
      }
      const r = await importArchive(buf, parsed.force === true);
      try { registry?.rescan?.(); } catch { /* ignore */ }
      json(res, r.ok ? 200 : 400, r);
      return true;
    }
    if (pathname === '/mod/enable') {
      if (method !== 'POST') { text(res, 405, 'method not allowed'); return true; }
      if (!changeAllowed(req)) { json(res, 403, { ok: false, error: 'CROSS_SITE' }); return true; }
      if (!keyOk(req)) { json(res, 403, { ok: false, error: 'KEY' }); return true; }
      let body;
      try { body = await readBody(req, MAX_JSON); } catch (e) { json(res, 413, { ok: false, error: 'SIZE' }); return true; }
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { json(res, 400, { ok: false, error: 'JSON' }); return true; }
      const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
      const on = parsed.on;
      if (!id || typeof on !== 'boolean') { json(res, 400, { ok: false, error: 'ARGS' }); return true; }
      let known = [];
      try { known = (registry ? registry.plugins() : []).map((p) => p && p.id).filter(Boolean); } catch { known = []; }
      if (!known.includes(id)) { json(res, 404, { ok: false, error: 'PLUGIN_UNKNOWN', detail: id }); return true; }
      const file = path.join(pluginsDir, 'config.json');
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { cfg = {}; }
      const required = new Set(Array.isArray(cfg.required) ? cfg.required : []);
      if (!on && required.has(id)) { json(res, 400, { ok: false, error: 'PLUGIN_BLOCKED', detail: id }); return true; }
      const current = Array.isArray(cfg.default) ? cfg.default : [];
      const next = on ? [...new Set([...current, id])] : current.filter((x) => x !== id);
      const saved = { ...cfg, default: next };
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(saved, null, 2) + '\n');
      fs.renameSync(tmp, file);
      json(res, 200, { ok: true, default: next, required: [...required] });
      return true;
    }
    return false;
  }

  const prev = server.listeners('request').slice();
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let pathname = '';
    try { pathname = new URL(String(req.url || '/'), 'http://localhost').pathname; } catch { pathname = ''; }
    if (pathname !== '/mod' && pathname !== '/mod/' && !pathname.startsWith('/mod/')) {
      for (const l of prev) l.call(server, req, res);
      return;
    }
    handle(req, res, pathname).then((handled) => {
      if (!handled) for (const l of prev) l.call(server, req, res);
    }).catch((e) => {
      log.warn?.('[modmgr] ' + (e && e.message || e));
      try { json(res, 500, { ok: false, error: 'INTERNAL' }); } catch { /* sent */ }
    });
  });

  log.info?.('[modmgr] /mod ready (plugins=' + pluginsDir + ')');
  return { id: OVERLAY_ID, url: '/mod' };
}
