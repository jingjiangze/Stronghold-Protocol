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
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_JSON = 64 * 1024;
/**
 * The online mod catalogue, or '' when none is configured. Override with SP_WORKSHOP_URL
 * ('0' / 'off' switches it off).
 *
 * Default = the CF mainline `mod.jiangjiangze.icu` (owner 2026-10-21: 「最新的 Mod 源和 Mod 管理器
 * 换成这个」). Measured 2026-10-26 (audit): `/mods.json` → 200 application/json, ACAO:*, **76 entries**,
 * generatedAt 2026-10-21T14:09:41Z — and **no `counts` field any more** (the UI falls back to counting
 * entries itself). Categories are now `functional` / `documentation` (+ the older words when present);
 * the dropdown lists both vocabularies. There is no static version endpoint (`/version.json` is the
 * SPA fallback), so the workshop has nothing to self-version against.
 * The CF site ignores Range requests (a 0-511 probe returns 200 + the full Content-Length instead
 * of 206), which costs nothing here: `workshopFetch` downloads each pack whole through upstream
 * `install.js fetchHttps`, which never issues a Range.
 *
 * WHY https ONLY: the download goes through upstream `install.js fetchHttps`, which refuses
 * anything that is not a public **https** URL (isCatalogUrl) — that refusal is the SSRF gate,
 * and it must not be weakened.
 */
export const DEFAULT_WORKSHOP_URL = 'https://mod.jiangjiangze.icu';
/** The catalogue document on that site (the UI-facing one, not the repo's authoritative index). */
export const WORKSHOP_INDEX_PATH = '/mods.json';
/** raw.githubusercontent prefix, for entries that only carry a repo-relative `path`. */
export const RAW_BASE = 'https://raw.githubusercontent.com/jingjiangze/Stronghold-Protocol-Forge-Mods/master/';
/** Where the MOD manager itself is handed out (服务端 + /mod 页面 + CLI，不含游戏素材).
 *  This is for a PC/server deployment: the APK already carries the manager as this very overlay. */
export const MANAGER_PAGE_URL = 'https://mod.jiangjiangze.icu/manager';
// 2026-10-27 真机实测：目录（65 KB，CF 边缘）在移动网络/跨境线路上要 **5–15 秒**才回，
// 旧的 8 秒预算会让「载入工坊目录」在这类网络上一律 TIMEOUT（点开像坏了）。给 25 秒 + 一次重试。
const WORKSHOP_TIMEOUT_MS = 25000;
const WORKSHOP_FETCH_MS = 60000;

/** 工坊包的下载主机白名单（2026-10-27 审计 P0：目录未签名时，download 字段不可信 ——
 *  空 allowDownloadHosts 会让**任意公网 https:443** 通过 install.js 的门，等于把目录的完整性
 *  问题放大成「任意主机 → 服务端插件执行」。默认只认 raw.githubusercontent.com（实测 76/76
 *  条目都在这个 host 上）；要放行别的镜像用 SP_WORKSHOP_HOSTS=host1,host2 显式追加。 */
const WORKSHOP_HOSTS = (() => {
  const extra = String((typeof process !== 'undefined' && process.env && process.env.SP_WORKSHOP_HOSTS) || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return new Set(['raw.githubusercontent.com', ...extra]);
})();
/** 目录签名的信任锚表：keyId → 32 字节 raw Ed25519 公钥 hex。keyId 来自目录文档自身，**认不出
 *  的 keyId 一律判 bad**（不能退回默认公钥 —— 那就等于谁都能换把钥匙再自称签过）。
 *   · sp-2026-10          —— App 热更新那把（tools/apk/shell/pubkey.bin），历史上目录若用它签也认；
 *   · sp-workshop-2026-10 —— 专用工坊密钥（2026-10-29 起站点用它签）。私钥只在 mod 仓库的
 *     Actions secret 里，不与热更新私钥共用：那把能改写每台设备的客户端包，不该进接受第三方 PR 的仓库。 */
export const WORKSHOP_KEYS = new Map([
  ['sp-2026-10', '0978bc661be0dda0daca18892d72a666a50df525046a77c24a5336ddb46defbf'],
  ['sp-workshop-2026-10', 'c3ffeb789e210c883a72df011e6ce2d477961635739b76359d51f6c1f84a2741'],
]);
/** 没带 keyId 的旧目录按哪把验（站点 2026-10-29 之前的产物都没这个字段）。 */
const WORKSHOP_KEY_ID = 'sp-2026-10';
/** 目录文档的签名策略（2026-10-29 起**默认 fail-closed**）：有 sig 就必须验过；没有 sig 直接拒。
 *  站点那边 build-mods-json.yml 已经在签（keyId sp-workshop-2026-10，实测线上可选验证 signed），
 *  所以「没签名」已经只可能是被换掉了 —— 这时放行就等于前功尽弃。
 *  真要临时放行未签名目录（调试镜像），显式 SP_WORKSHOP_REQUIRE_SIG=0。 */
const WORKSHOP_REQUIRE_SIG = (() => {
  const v = String((typeof process !== 'undefined' && process.env && process.env.SP_WORKSHOP_REQUIRE_SIG) || '')
    .trim().toLowerCase();
  if (v === '0' || v === 'off' || v === 'false') return false;
  return true;
})();


export const id = 'sp-modmgr';
/** 旧名保留（曾有调用点用 OVERLAY_ID）：同一个值，别变成第二份真相。 */
export const OVERLAY_ID = id;
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
/* 2026-10-20 业主「Mod 界面优化一下，放大一下」：基准从 14px 提到 17px，正文字号全部放大，
   按钮/输入触摸下限 44px（手机可点），表格从 12px 提到 15px，结果区与进度区放大可滚动高度。 */
:root{color-scheme:dark;--sp-m-size:17px;--sp-m-mint:#4ed8af;--sp-m-line:#3e4b45;--sp-m-hi:#f2f2f2;--sp-m-lo:#8a948f}
body{margin:0;padding:clamp(16px,3vw,32px) clamp(12px,3vw,28px) 72px;background:#0C0F0E;color:#c3cbc7;
  font:var(--sp-m-size)/1.6 system-ui,"Segoe UI","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:min(960px,100%);margin:0 auto}
h1{font-size:clamp(22px,4.6vw,30px);margin:0 0 6px;color:var(--sp-m-hi);font-weight:800}
p.sub{margin:0 0 22px;color:var(--sp-m-lo);font-size:clamp(14px,2.6vw,16px)}
section{border:1px solid var(--sp-m-line);background:rgba(18,24,22,.72);padding:clamp(14px,2.4vw,22px);margin:0 0 18px}
h2{font-size:clamp(14px,2.5vw,16px);margin:0 0 12px;color:var(--sp-m-mint);letter-spacing:.08em;text-transform:uppercase}
label{display:block;margin:0 0 10px;color:var(--sp-m-lo);font-size:clamp(13px,2.3vw,15px)}input,button{font:inherit}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid var(--sp-m-line);
  background:#0a0d0c;color:var(--sp-m-hi);font-size:clamp(15px,2.8vw,17px);min-height:44px}
input[type=text]:focus,input[type=password]:focus{border-color:var(--sp-m-mint);outline:none}
input[type=file]{width:100%;color:#c3cbc7;padding:8px 0;font-size:clamp(14px,2.5vw,16px)}
button{padding:12px 18px;min-height:44px;border:1px solid #2a9e7f;background:#121816;color:var(--sp-m-mint);
  cursor:pointer;font-size:clamp(15px,2.7vw,17px)}
button:disabled{opacity:.45;cursor:not-allowed}button.alt{border-color:var(--sp-m-line);color:#c3cbc7}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
pre{white-space:pre-wrap;word-break:break-word;background:#0a0d0c;border:1px solid var(--sp-m-line);
  padding:14px;max-height:52vh;overflow:auto;font-size:clamp(13px,2.4vw,15px);line-height:1.7}
table{width:100%;border-collapse:collapse;font-size:clamp(14px,2.6vw,16px)}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #2a352f}
th{color:var(--sp-m-lo);font-weight:500}code{background:#0a0d0c;padding:2px 6px;font-size:.95em}
.ok{color:var(--sp-m-mint)}.bad{color:#e06c5a}.dim{color:var(--sp-m-lo)}
a.back{display:inline-block;margin-bottom:18px;color:var(--sp-m-mint);text-decoration:none;
  border:1px solid #2a9e7f;padding:10px 16px;min-height:44px;box-sizing:border-box;font-size:clamp(15px,2.7vw,17px)}
/* 已安装表格：手机上横向可滚，行高跟着触摸下限 */
table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}
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
<section><h2>工坊 · Workshop</h2>
<label>线上工坊目录里的包，点「装」即抓回来导入（走同一条 importForge / install 链，不新增第二条）。
 <span class="dim" id="ws-state"></span></label>
<div class="row"><button class="alt" id="ws-load">载入工坊目录</button>
<select id="ws-kind" style="min-height:44px;padding:10px 12px;background:#0a0d0c;color:#f2f2f2;border:1px solid #3e4b45;font:inherit">
  <option value="">全部类别</option><option value="functional">功能</option><option value="gameplay">玩法</option>
  <option value="expansion">扩展</option><option value="utility">工具</option><option value="assets">素材</option>
  <option value="documentation">文档</option>
</select>
<input id="ws-q" type="text" placeholder="按名字筛选" style="flex:1 1 220px"></div>
<div id="ws-list" style="margin-top:12px;display:grid;gap:8px"></div>
<p class="dim">标记「有风险」的包是目录自己 flagged 的（内含可执行文件或官方素材），装之前请自行判断。</p></section>
<section><h2>已安装 · Installed</h2>
<div class="row" style="margin-bottom:8px"><button class="alt" id="reload">刷新</button>
<span class="dim" id="meta"></span></div>
<table><thead><tr><th>id</th><th>名称</th><th>版本</th><th>类别</th><th>状态</th><th>房间默认</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table>
<p class="dim">「房间默认」= 新建房间开局带上的插件（plugins/config.json 的 default）。改完对**新房间**生效。</p>
<p class="dim">「卸载」= 把插件目录移到 <code>plugins/_removed/</code>（不删，可手工搬回来）；标记「必需」的插件不能卸。</p>
<div class="row" style="margin-top:8px"><button class="alt" id="mgr">获取 MOD 管理器</button>
<span class="dim">给 PC / 自建服务器用（服务端 + /mod 页面 + CLI，不含游戏素材）；手机上用不着 —— 本页就是它。</span></div></section>
<section><h2>结果 · Result</h2><pre id="out" class="dim">（还没有操作）</pre></section>
</main><script>
(()=>{const $=(id)=>document.getElementById(id);const out=$('out');
const show=(v)=>{out.textContent=typeof v==='string'?v:JSON.stringify(v,null,2)};
const key=()=>$('key').value.trim();
$('key').value=localStorage.getItem('sp-mod-key')||'';
// MOD 管理器下载（业主 2026-10-21：源与管理器都换成 mod.jiangjiangze.icu）。开新标签而不是
// location.href —— 直接跳会丢掉本页，用户得重开面板才能回来。noopener/noreferrer 防反向控制与
// referrer 泄露（这里 referrer 会是 http://127.0.0.1:<port>，没必要送给别人）。
$('mgr').onclick=()=>{try{window.open('https://mod.jiangjiangze.icu/manager','_blank','noopener,noreferrer')}catch(e){location.href='https://mod.jiangjiangze.icu/manager'}};
$('saveKey').onclick=()=>{localStorage.setItem('sp-mod-key',key());show('已记住钥匙')};
const busy=(b)=>{for(const id of ['upload','fetch','reload'])$(id).disabled=b};
// 插件的 id / 名称 / 版本来自**包里的清单**，作者可以写任何字符串；这段拼的是 innerHTML，
// 不转义就是把别人的清单当 HTML 执行（2026-10-20）。工坊列表同理（名字来自远端目录）。
const esc=(v)=>String(v==null?'':v).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function wsSyncInstalled(){try{const j=await(await fetch('/mod/status.json',{cache:'no-store'})).json();
  wsState.installed={};for(const p of (j.plugins||[]))wsState.installed[p.id]=true;if(wsState.loaded)wsDraw()}catch(e){}}
async function status(){const r=await fetch('/mod/status.json',{cache:'no-store'});const j=await r.json();
$('meta').textContent=(j.plugins||[]).length+' 个插件 · 收件目录 '+j.inbox;
$('rows').innerHTML=(j.plugins||[]).map((p)=>{const st=p.status==='loaded'?'<span class="ok">loaded</span>':p.status==='disabled'?'<span class="bad">disabled</span>':'<span class="dim">'+esc(p.status||'skipped')+'</span>';
const t=p.required?'<span class="dim">必需</span>':'<button class="alt" data-toggle="'+esc(p.id)+'" data-on="'+(p.enabled?'0':'1')+'">'+(p.enabled?'停用':'启用')+'</button>';
// 卸载：同一条委托链（data-remove），必需插件不给这颗按钮（服务端也会拒）
const rm=p.required?'<span class="dim">—</span>':'<button class="alt" data-remove="'+esc(p.id)+'">卸载</button>';
return '<tr><td><code>'+esc(p.id)+'</code></td><td>'+esc(p.name)+'</td><td>'+esc(p.version)+'</td><td>'+esc(p.class||'')+'</td><td>'+st+'</td><td>'+t+'</td><td>'+rm+'</td></tr>'}).join('')||'<tr><td colspan="7" class="dim">（没有插件）</td></tr>';
return j}
$('reload').onclick=async()=>{try{const j=await status();show({installed:(j.plugins||[]).length,inbox:j.inbox})}catch(e){show(String(e))}};
$('rows').onclick=async(e)=>{
  const b=e.target.closest('[data-toggle]');
  if(b){if(!key())return show('先填钥匙');
    b.disabled=true;try{const r=await fetch('/mod/enable',{method:'POST',headers:{'X-SP-Mod':key(),'Content-Type':'application/json'},body:JSON.stringify({id:b.dataset.toggle,on:b.dataset.on==='1'})});show(await r.json());await status()}catch(err){show(String(err))}finally{b.disabled=false}return}
  // 卸载：二次确认（这是会动插件目录的操作，误点一次代价不小）
  const d=e.target.closest('[data-remove]');
  if(d){if(!key())return show('先填钥匙');
    const id=d.dataset.remove;
    if(!confirm('卸载插件 '+id+'？\n\n它的目录会被移到 plugins/_removed/（不删除，可手工搬回），并从「房间默认」里摘掉。'))return;
    d.disabled=true;
    try{const r=await fetch('/mod/uninstall',{method:'POST',headers:{'X-SP-Mod':key(),'Content-Type':'application/json'},body:JSON.stringify({id:id})});
      const j=await r.json();show(j);await status();
      if(j&&j.ok===false&&j.error==='PLUGIN_IN_USE')show('该插件正在被房间 '+j.detail+' 使用，先退出那个房间再卸');
    }catch(err){show(String(err))}finally{d.disabled=false}return}
};
$('upload').onclick=async()=>{const f=$('file').files[0];if(!f)return show('先选一个 zip');if(!key())return show('先填钥匙');
busy(true);try{const r=await fetch('/mod/upload'+($('force').checked?'?force=1':''),{method:'POST',headers:{'X-SP-Mod':key(),'Content-Type':'application/zip'},body:f});show(await r.json());await status()}catch(e){show(String(e))}finally{busy(false)}};
$('fetch').onclick=async()=>{const url=$('url').value.trim();if(!url)return show('先填 URL');if(!key())return show('先填钥匙');
busy(true);try{const body={url};const sha=$('sha').value.trim();if(sha)body.sha256=sha;if($('force').checked)body.force=true;
const r=await fetch('/mod/fetch',{method:'POST',headers:{'X-SP-Mod':key(),'Content-Type':'application/json'},body:JSON.stringify(body)});show(await r.json());await status()}catch(e){show(String(e))}finally{busy(false)}};
// ---- 工坊（workshop）--------------------------------------------------------------------------
// 线上工坊目录是**另一台主机**，浏览器直连会被混合内容/CORS 挡住（而且本机服务是 http 页）。
// 所以列表与下载都经本服务的 /mod/workshop* 代理：只读、只认公开 https、失败如实说。
const wsState={mods:[],loaded:false,err:''};
const wsBase=()=>{try{return localStorage.getItem('sp-mod-workshop')||''}catch(e){return ''}};
async function wsLoad(){
  const box=$('ws-list');box.innerHTML='<span class="dim">正在载入…</span>';$('ws-state').textContent='';
  try{
    const r=await fetch('/mod/workshop.json',{cache:'no-store'});
    const j=await r.json();
    if(!j||j.ok===false){wsState.err=(j&&j.error)||'WORKSHOP';$('ws-state').textContent='载入失败：'+wsState.err;box.innerHTML='';return}
    wsState.mods=j.mods||[];wsState.loaded=true;wsState.err='';
    $('ws-state').textContent=(j.counts?('共 '+((j.counts.functional||0)+(j.counts.documentation||0))+' 个包'):(wsState.mods.length+' 个包'))
      + (j.base?(' · 源 '+j.base):'');
    wsDraw();
  }catch(e){wsState.err=String(e);$('ws-state').textContent='载入失败：'+wsState.err;box.innerHTML=''}
}
function wsRows(){
  const kind=$('ws-kind').value||'';const q=($('ws-q').value||'').trim().toLowerCase();
  return wsState.mods.filter((m)=>{
    if(kind&&String(m.kind||'')!==kind)return false;
    if(q&&String(m.name||m.id||'').toLowerCase().indexOf(q)<0)return false;
    return true;
  }).slice(0,60);
}
function wsDraw(){
  const box=$('ws-list');const rows=wsRows();
  if(!rows.length){box.innerHTML='<span class="dim">没有匹配的包</span>';return}
  box.innerHTML=rows.map((m)=>{
    // 名字/版本来自**远端目录**，和插件清单一样不可信 —— 一律转义（esc 定义在 status() 上方）。
    const id=esc(m.id||'');const name=esc(m.name||m.id||'');
    const meta=esc([m.version,m.kind,typeof m.size==='number'?(m.size>1048576?(m.size/1048576).toFixed(1)+' MB':Math.round(m.size/1024)+' KB'):''].filter(Boolean).join(' · '));
    // 两个独立标记，别混：有风险 = 含可执行文件/官方素材；兼容包 = 别人改写后能装的那种
    const bad=(m.suspected||m.flagged)?' <span class="bad">有风险</span>':'';
    const compat=m.compat?' <span class="dim">兼容改写版</span>':'';
    const installed=(wsState.installed||{})[m.id];
    return '<div class="row" style="justify-content:space-between;border:1px solid #2a352f;padding:10px 12px">'
      +'<span style="min-width:0;flex:1 1 auto"><b>'+name+'</b>'+bad+compat+'<br><span class="dim">'+meta+'</span></span>'
      +'<button class="'+(installed?'alt':'')+'" data-ws="'+id+'" '+(installed?'disabled':'')+'>'+(installed?'已装':'装')+'</button></div>';
  }).join('');
}
$('ws-load').onclick=wsRefresh;
$('ws-kind').onchange=wsDraw;
$('ws-q').oninput=wsDraw;
// 载入后如果服务端没配源（SP_WORKSHOP_URL），如实说出来 —— 不静默失败（2026-10-20）。
async function wsRefresh(){
  const base=wsBase();
  if(!base){
    // 页面自己不知道源配没配：问服务端一次（GET，只读）
    try{const j=await (await fetch('/mod/workshop.json',{cache:'no-store'})).json();
      if(j&&j.ok===false){wsState.err=String(j.error||'WORKSHOP');
        $('ws-state').textContent = (j.error==='WORKSHOP_OFF')
          ? '服务端没有配置工坊源（SP_WORKSHOP_URL）；抓取只走公开 https，这是放行的前提。'
          : ('载入失败：'+wsState.err+(j.detail ? (' · '+j.detail) : ''));
        return}
      wsState.mods=j.mods||[];wsState.loaded=true;$('ws-state').textContent=(j.mods||[]).length+' 个包';wsDraw();wsSyncInstalled();
    }catch(e){$('ws-state').textContent='载入失败：'+String(e)}
    return;
  }
  wsLoad();
}
$('ws-list').onclick=async(e)=>{
  const b=e.target.closest('[data-ws]');if(!b)return;
  if(!key())return show('先填钥匙（工坊安装是一次写入）');
  const id=b.dataset.ws;const m=(wsState.mods||[]).find((x)=>String(x.id)===id);
  b.disabled=true;busy(true);
  try{
    // 下载地址由目录条目给（download 字段）；服务端仍会过上游 fetchHttps 的 https/非私网门
    const r=await fetch('/mod/workshop-install',{method:'POST',headers:{'X-SP-Mod':key(),'Content-Type':'application/json'},
      body:JSON.stringify({id:id,url:(m&&m.download)||'',sha256:(m&&m.sha256)||'',force:$('force').checked})});
    show(await r.json());await status();
    wsState.installed=Object.assign({},wsState.installed);wsState.installed[id]=true;wsDraw();
  }catch(err){show(String(err))}finally{b.disabled=false;busy(false)}
};
wsRefresh();
status().catch((e)=>{$('rows').innerHTML='<tr><td colspan="6" class="bad">'+String(e)+'</td></tr>'});
})();
</script></body></html>`;

// ---- 目录信任（2026-10-27 审计 P0；2026-10-29 源站签名 + fail-closed）---------------------
// 目录是裸 JSON、sha256 与 download 同源 ⇒ 站点/DNS 被控时可把一次正常点击变成「装任意主机
// 的包」。这里给两层锚：① 目录签名（站点侧 build-mods-json.yml 已用它签，客户端默认要求必须
// 验过）；② 下载主机白名单（默认只有 raw.githubusercontent.com）。
/** tools/apk/canonical.mjs 的等价实现：键递归排序、无空白、去掉 sig —— 签名工具用的就是它。 */
export function canonicalize(value) {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in payload');
    if (!Number.isInteger(value)) throw new Error('non-integer number in payload');
    return String(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  throw new Error('unsupported value type in payload: ' + t);
}
/** @returns {'signed'|'unsigned'|'bad'} */
export function verifyCatalogue(doc) {
  const sig = doc && typeof doc.sig === 'string' ? doc.sig.trim() : '';
  if (!sig) return 'unsigned';
  const keyId = (doc && typeof doc.keyId === 'string' ? doc.keyId.trim() : '') || WORKSHOP_KEY_ID;
  const pubHex = WORKSHOP_KEYS.get(keyId);
  if (!pubHex) {
    // 未知 keyId ≠ 用默认公钥再验一遍：那是「换把钥匙再自称签过」，必须拒。
    console.warn('[modmgr] catalogue signed by an unknown keyId: ' + keyId);
    return 'bad';
  }
  try {
    const { sig: _drop, ...rest } = doc;
    const payload = Buffer.from(canonicalize(rest), 'utf8');
    // raw 32B Ed25519 → SPKI DER（0x302a300506032b6570032100 前缀），Node 的 OpenSSL 认这个包装。
    const der = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(pubHex, 'hex'),
    ]);
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    const ok = cryptoVerify(null, payload, key, Buffer.from(sig, 'base64'));
    return ok ? 'signed' : 'bad';
  } catch (e) {
    console.warn('[modmgr] catalogue signature check failed: ' + String(e && e.message || e));
    return 'bad';
  }
}
/** 工坊包只从白名单主机下载（目录的 download 字段不可信）。 */
export function assertWorkshopHost(url) {
  let host = '';
  let proto = '';
  try {
    const u = new URL(String(url || ''));
    host = String(u.hostname || '').toLowerCase();
    proto = String(u.protocol || '');
  } catch { host = ''; }
  if (!host) {
    const e = new Error('the catalogue entry carries no readable download URL');
    e.code = 'URL';
    throw e;
  }
  // 纵深防御：上游 fetchHttps 也会拒非 https，但目录驱动的一次写入不该依赖下游再兜一次。
  if (proto !== 'https:') {
    const e = new Error('download URL must be https: ' + proto);
    e.code = 'URL';
    throw e;
  }
  if (!WORKSHOP_HOSTS.has(host)) {
    const e = new Error('download host not trusted: ' + host);
    e.code = 'HOST';
    throw e;
  }
}


/**
 * 取工坊目录，**一次重试**（2026-10-27 真机实测：目录在慢网/跨境线路上 5–15 s 才回，
 * 只给 8 s 会让「载入工坊目录」在手机上恒 TIMEOUT）。只有超时/HTTP 错才重试，
 * 签名之类的内容问题不重试（重试也还是坏的）。
 */
async function fetchWorkshopIndex(base) {
  const url = base + WORKSHOP_INDEX_PATH;
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(WORKSHOP_TIMEOUT_MS) });
      if (!r.ok) {
        const e = new Error('HTTP ' + r.status);
        e.code = 'HTTP';
        throw e;
      }
      return r;
    } catch (e) {
      last = e;
      const retriable = !!(e && (e.name === 'TimeoutError' || e.name === 'AbortError' || e.code === 'HTTP'));
      if (!retriable || attempt === 1) throw e;
    }
  }
  throw last;
}

export function install(ctx) {
  const ctxServer = ctx && ctx.server;
  const upstreamDir = ctx && ctx.upstreamDir;
  // ctx.server is the OBJECT startServer() returned; the http.Server is its `.server` (same
  // resolution sp-mods uses — the object itself has no .listeners()).
  const server = (ctxServer && ctxServer.server && typeof ctxServer.server.on === 'function')
    ? ctxServer.server
    : (ctxServer && typeof ctxServer.on === 'function' ? ctxServer : null);
  if (!server || !upstreamDir) throw new Error('sp-modmgr: needs an http server + upstreamDir');
  const webroot = path.dirname(upstreamDir);
  const pluginsDir = path.join(webroot, 'plugins');
  const dataDir = path.join(webroot, 'data');
  const log = typeof ctx.log === 'function' ? { info: ctx.log, warn: ctx.log, error: ctx.log } : (ctx.log || console);
  // startServer() returns BOTH registries: `.registry` is the session registry (network), `.packs` the
  // plugin registry (server/index.js:219 → createPluginRegistry). Only the latter has plugins().
  const registry = (ctxServer && (ctxServer.packs || ctxServer.registry)) || null;
  // 卸载前的「有没有房间在用」判据要读 lobby.rooms；拿不到就跳过该检查（不因此拒绝卸载）。
  const lobby = (ctxServer && ctxServer.lobby) || null;
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

  /** 门禁拒绝时的页面（2026-10-20）。`why` 是给日志的，但**来源地址**是玩家能自己核对的东西 ——
   *  给出来，玩家一眼能看出「我是从公网地址打开它的」，而不是对着空白页发呆。 */
  function modGatePage(gate) {
    const peer = String((gate && gate.peer) || '').slice(0, 64);
    const host = String((gate && gate.host) || '').slice(0, 96);
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>MOD 管理器 · 不可用</title></head>'
      + '<body style="margin:0;padding:24px;background:#0C0F0E;color:#c3cbc7;font:14px/1.6 system-ui,sans-serif">'
      + '<main style="max-width:40rem;margin:0 auto">'
      + '<h1 style="font-size:18px;color:#f2f2f2">MOD 管理器不可用</h1>'
      + '<p>它和插件工作台是同一道门：<b>只在这台机器或同一个局域网里可用</b>。现在的请求不是从那里来的。</p>'
      + '<ul style="color:#8a948f">'
      + '<li>来访地址：<code>' + esc(peer || '(读不到)') + '</code></li>'
      + '<li>请求的 Host：<code>' + esc(host || '(读不到)') + '</code></li>'
      + '</ul>'
      + '<p>在同一个 Wi-Fi / 虚拟局域网里，用本机服务给出的那个地址打开就行。'
      + '本机服务没启动时这个页面根本没有人应答 —— 先到主界面点「启动本机服务」。</p>'
      + '<p><a href="/" style="color:#4ed8af">← 回游戏</a></p>'
      + '</main></body></html>';
  }

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

  // ---- 工坊（workshop）代理 --------------------------------------------------------------------
  // 线上工坊目录在另一台主机上：页面直连会被混合内容/CORS 挡住（本机服务是 http 页），所以列表与
  // 下载都走本服务。地址可通过环境变量覆盖（SP_WORKSHOP_URL），默认线上那份；`0`/`off` 即关闭。
  const workshopBase = () => {
    const v = String(process.env.SP_WORKSHOP_URL || '').trim();
    if (!v) return DEFAULT_WORKSHOP_URL;
    if (['0', 'off', 'false'].includes(v.toLowerCase())) return '';
    return v.replace(/\/+$/, '');
  };

  /** 目录索引（只读 GET）。失败如实回 { ok:false, error }，绝不假装有列表。 */
  async function workshopIndex() {
    const base = workshopBase();
    if (!base) return { ok: false, error: 'WORKSHOP_OFF' };
    try {
      const r = await fetchWorkshopIndex(base);
      const j = await r.json();
      // 站点有两份索引，字段名不同（2026-10-20 实测）：
      //   · modsite/mods.json（页面用的那版）：{id,name,version,category,note,sizeBytes,sha256,download}
      //     download 是**绝对 URL**（raw.githubusercontent）—— 这份更贴 UI，也是我们默认接的。
      //   · 仓内 mods/index.json（权威索引）：{...,category,sizeBytes,sha256,path,assets,engineLoad}
      //     没有 download 直链，要自己拼 raw + path。
      // 两份都认：优先 download，其次 path 拼 raw 前缀（RAW_BASE）。
      const list = Array.isArray(j && j.mods) ? j.mods : (Array.isArray(j && j.entries) ? j.entries : []);
      const mods = list.map((m) => {
        const id = String((m && m.id) || '');
        const assets = (m && m.assets && typeof m.assets === 'object') ? m.assets : null;
        const size = Number.isFinite(m && m.sizeBytes) ? Number(m.sizeBytes)
          : (Number.isFinite(m && m.size) ? Number(m.size) : null);
        const download = String((m && m.download) || '')
          || (m && m.path ? RAW_BASE + String(m.path) : '');
        // 「有风险」= 目录自己标的（含可执行文件 / 官方素材），或带了素材
        const suspected = !!(m && m.suspected) || (assets ? assets.assetFree === false : false)
          || (Array.isArray(m && m.notes) && m.notes.length > 0);
        return {
          id: id,
          name: String((m && m.name) || id),
          version: String((m && m.version) || ''),
          kind: String((m && (m.category || m.kind)) || ''),
          size: size,
          sha256: String((m && m.sha256) || ''),
          download: download,
          suspected: suspected,
          // 兼容改写版（站点自己标的 isCompat）：与「有风险」是两回事，页面上分开显示 ——
          // 兼容包是别人改写后能装的，风险包是「含可执行文件/官方素材」。
          compat: !!(m && m.isCompat),
          addedAt: String((m && m.addedAt) || ''),
          author: String((m && m.author) || ''),
          note: String((m && (m.note || (Array.isArray(m.notes) ? m.notes[0] : ''))) || '').slice(0, 200),
        };
      }).filter((m) => m.id);
      // 目录信任（2026-10-29）：签了就必须验过；**没签直接拒**（站点已在签，"没签名"只可能是
      // 被换掉了）。调试镜像要放行未签名目录就显式 SP_WORKSHOP_REQUIRE_SIG=0。
      const trust = verifyCatalogue(j);
      if (trust === 'bad') return { ok: false, error: 'SIG', detail: 'the catalogue signature does not verify' };
      if (trust === 'unsigned' && WORKSHOP_REQUIRE_SIG) {
        return { ok: false, error: 'UNSIGNED', detail: 'the catalogue is not signed (set SP_WORKSHOP_REQUIRE_SIG=0 to allow it)' };
      }
      return {
        ok: true, base: base, mods: mods, counts: (j && j.counts) || null,
        signed: trust === 'signed', keyId: String((j && j.keyId) || '') || null,
      };
    } catch (e) {
      const code = e && e.name === 'TimeoutError' ? 'TIMEOUT' : (e && e.code) || 'NETWORK';
      log.warn?.('[modmgr] workshop index failed: ' + String(e && e.message || e));
      return { ok: false, error: String(code), detail: String(e && e.message || e).slice(0, 200) };
    }
  }

  /**
   * 下载一个工坊包。只认公开 https（与 install.js 同一口径，且**必须**过 fetchHttps 的 SSRF 门 ——
   * download 字段来自远端目录，不可信）。返回 zip 字节。
   * @param {string} url 目录里给的绝对 URL
   * @param {string} [sha256] 给了就校验
   */
  async function workshopFetch(url, sha256) {
    const base = workshopBase();
    if (!base) {
      const e = new Error('the workshop is switched off');
      e.code = 'WORKSHOP_OFF';
      throw e;
    }
    const target = String(url || '').trim();
    if (!target) {
      const e = new Error('the catalogue entry carries no download URL');
      e.code = 'URL';
      throw e;
    }
    // 走上游 install.js 的 fetchHttps：私网地址、非 https、超限一律拒（不自己再造一遍校验）。
    // 它的失败码（DOWNLOAD / URL / SIZE …）原样往上抛，由调用点转成响应 —— 不加一层无用的重抛。
    const buf = await installMod.fetchHttps(target, {
      maxBytes: limits.PLUGIN_LIMITS.pluginBytes, timeoutMs: WORKSHOP_FETCH_MS, kind: 'zip',
      allowDownloadHosts: installMod.readDownloadAllow(pluginsDir), pluginsDir,
    });
    if (sha256) {
      const got = createHash('sha256').update(buf).digest('hex');
      if (got !== sha256) {
        const e = new Error('sha256 mismatch: got ' + got);
        e.code = 'SHA256';
        throw e;
      }
    }
    return buf;
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
    // 2026-10-20「mod 管理器界面未生效」—— 这行原来是**只回一句纯文本 404**，页面上什么也看不见
    // （玩家点开就是一个空白页，连「为什么打不开」都没有）。门禁本身必须留（/mod 与 /studio 同一道
    // 门：本机或局域网），但拒绝时要说清楚是从哪个地址来的、为什么被拒。
    const raw = gateMod.studioAllowed(req);
    if (!raw || !raw.ok) {
      // 上游的 why 是给日志的（绝不回给客户端）；这里补上玩家能自己核对的两项：来访地址与 Host。
      text(res, 404, modGatePage({
        peer: req && req.socket ? String(req.socket.remoteAddress || '') : '',
        host: req && req.headers ? String(req.headers.host || '') : '',
      }), 'text/html');
      if (raw && raw.why) log.warn?.('[modmgr] refused: ' + String(raw.why));
      return true;
    }
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const { key } = keyMod.loadStudioKey(pluginsDir, { log });
    const keyOk = (req2) => {
      const h = req2.headers['x-sp-mod'] || req2.headers['x-sp-studio'];
      let q = null;
      try { q = new URLSearchParams(String(req2.url || '').split('?')[1] || '').get('key'); } catch { q = null; }
      return keyMod.sameKey(String(h || q || ''), key);
    };

    // ---- 工坊（workshop）：经本服务代理，页面自己连不到那台主机 -------------------------------
    // 列表只读；安装是一次写入，要钥匙 + 同源，且**复用 importArchive**（同一条装载链）。
    if (pathname === '/mod/workshop.json') {
      if (method !== 'GET') { text(res, 405, 'method not allowed'); return true; }
      const r = await workshopIndex();
      json(res, r.ok === false ? 502 : 200, r);
      return true;
    }
    if (pathname === '/mod/workshop-install') {
      if (method !== 'POST') { text(res, 405, 'method not allowed'); return true; }
      if (!changeAllowed(req)) { json(res, 403, { ok: false, error: 'CROSS_SITE' }); return true; }
      if (!keyOk(req)) { json(res, 403, { ok: false, error: 'KEY' }); return true; }
      let body;
      try { body = await readBody(req, MAX_JSON); } catch (e) { json(res, 413, { ok: false, error: 'SIZE' }); return true; }
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { json(res, 400, { ok: false, error: 'JSON' }); return true; }
      const id = typeof parsed?.id === 'string' ? parsed.id.trim() : '';
      // 目录条目给的绝对 URL（站点 mods.json 的 `download` 字段；仓内索引则用 path 拼 raw）。
      // 收 URL 而不是自己按 id 拼：站点的载荷路径是 mods/<id>/<ver>/mod.zip，猜不出来。
      const url = typeof parsed?.url === 'string' ? parsed.url.trim() : '';
      const sha256 = typeof parsed?.sha256 === 'string' ? parsed.sha256.trim().toLowerCase() : '';
      if (!id) { json(res, 400, { ok: false, error: 'ARGS', detail: 'needs { id }' }); return true; }
      // 2026-10-27（审计 P0）：目录驱动的一次写入**必须**带 sha256 —— 目录没签名时，摘要是唯一
      // 能与「目录被改」区分的锚；缺失即拒，不再像旧版那样「给了才校验」。
      if (!sha256) { json(res, 400, { ok: false, error: 'SHA256_REQUIRED', detail: 'the catalogue entry carries no sha256' }); return true; }
      if (!/^[0-9a-f]{64}$/.test(sha256)) { json(res, 400, { ok: false, error: 'SHA256' }); return true; }
      let buf;
      try {
        // 主机白名单：目录的 download 字段不可信，只认 raw.githubusercontent.com（可 SP_WORKSHOP_HOSTS 追加）。
        assertWorkshopHost(url);
        buf = await workshopFetch(url, sha256);
      } catch (e) {
        json(res, 400, { ok: false, error: e && e.code && /^[A-Z_]+$/.test(e.code) ? e.code : 'DOWNLOAD', detail: String(e && e.message || e).slice(0, 300) });
        return true;
      }
      const r = await importArchive(buf, parsed.force === true);
      try { registry?.rescan?.(); } catch { /* ignore */ }
      json(res, r.ok ? 200 : 400, r);
      return true;
    }

    if (pathname === '/mod' || pathname === '/mod/') {
      if (method !== 'GET') { text(res, 405, 'method not allowed'); return true; }
      text(res, 200, PAGE, 'text/html');
      return true;
    }
    if (pathname === '/mod/status.json') {
      if (method !== 'GET') { text(res, 405, 'method not allowed'); return true; }
      const inboxDir = path.join(webroot, 'mod-inbox');
      // inbox 计数**只是计数**：本 overlay 没有 Forge 版 inbox.js 那个 watcher（250ms/settle-2-tick
      // 拖 zip 即装），所以丢进去的 zip 不会被自动导入 —— 别让页面显示一个「会自己装」的数字。
      // 要装就用本页的上传/抓取/工坊三条路。
      let inboxCount = null;
      try { inboxCount = fs.readdirSync(inboxDir).filter((n) => n.endsWith('.zip')).length; } catch { inboxCount = null; }
      json(res, 200, { ok: true, inbox: inboxDir, inboxAuto: false, ...statusRows(), inboxCount });
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
    if (pathname === '/mod/uninstall') {
      if (method !== 'POST') { text(res, 405, 'method not allowed'); return true; }
      if (!changeAllowed(req)) { json(res, 403, { ok: false, error: 'CROSS_SITE' }); return true; }
      if (!keyOk(req)) { json(res, 403, { ok: false, error: 'KEY' }); return true; }
      let body;
      try { body = await readBody(req, MAX_JSON); } catch (e) { json(res, 413, { ok: false, error: 'SIZE' }); return true; }
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { json(res, 400, { ok: false, error: 'JSON' }); return true; }
      const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
      if (!id) { json(res, 400, { ok: false, error: 'ARGS', detail: 'needs { id }' }); return true; }
      // 形态 + 防穿越：id 只认这些字符，且解析后必须仍指向 plugins/<id> 本体
      if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith('.')) {
        json(res, 400, { ok: false, error: 'PLUGIN_BAD_ID', detail: id });
        return true;
      }
      const dir = path.join(pluginsDir, id);
      if (path.dirname(dir) !== pluginsDir) { json(res, 400, { ok: false, error: 'PLUGIN_BAD_ID', detail: id }); return true; }
      // required 不可卸（与 /mod/enable 的 PLUGIN_BLOCKED 同一口径：那是房间开局的底线）
      const file = path.join(pluginsDir, 'config.json');
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { cfg = {}; }
      const required = new Set(Array.isArray(cfg.required) ? cfg.required : []);
      if (required.has(id)) { json(res, 400, { ok: false, error: 'PLUGIN_BLOCKED', detail: id }); return true; }
      // 有房间正在用就不能卸：上游 lobby.setPlugins 在 match 进行中直接拒绝换集，我们这边更严一点
      const busy = (() => {
        try {
          const rooms = lobby && typeof lobby.rooms === 'object' && lobby.rooms instanceof Map ? lobby.rooms : null;
          if (!rooms) return '';
          for (const room of rooms.values()) {
            if (!room || typeof room !== 'object') continue;
            const list = Array.isArray(room.plugins) ? room.plugins : [];
            if (list.some((p) => p && p.id === id)) return room.code ? String(room.code) : 'in-use';
          }
        } catch (e) { /* 读不到房间表：不因此拒绝卸载 */ }
        return '';
      })();
      if (busy) { json(res, 409, { ok: false, error: 'PLUGIN_IN_USE', detail: busy }); return true; }
      let dest = '';
      try {
        if (typeof installMod.movePluginAside === 'function') {
          // 上游原语：把 plugins/<id> **改名**到 plugins/_removed/<id>-<stamp>/，不删任何东西
          // （install.js:593）。改名是可回滚的，删除不是 —— 这正是我们不自己 rmSync 的原因。
          dest = installMod.movePluginAside(pluginsDir, id, '_removed');
        } else {
          // 老树没有该导出：退化成等价的改名（同样的 _removed 前缀，registry 永不读 _ 开头目录）
          const root = path.join(pluginsDir, '_removed');
          fs.mkdirSync(root, { recursive: true });
          const base = id + '-' + new Date().toISOString().replace(/[:.]/g, '-');
          let target = path.join(root, base);
          for (let n = 2; fs.existsSync(target); n++) target = path.join(root, base + '-' + n);
          fs.renameSync(dir, target);
          dest = target;
        }
      } catch (e) {
        const code = e && e.code ? String(e.code) : 'REMOVE';
        json(res, 400, { ok: false, error: /^PLUGIN_[A-Z_]+$/.test(code) ? code : 'REMOVE', detail: String(e && e.message || e).slice(0, 200) });
        return true;
      }
      // 顺手从 default 里摘掉：否则新房间会拿着一个不存在的 id 去 setPlugins
      const current = Array.isArray(cfg.default) ? cfg.default : [];
      if (current.includes(id)) {
        const next = current.filter((x) => x !== id);
        const tmp = file + '.' + process.pid + '.tmp';
        try {
          fs.writeFileSync(tmp, JSON.stringify({ ...cfg, default: next }, null, 2) + '\n');
          fs.renameSync(tmp, file);
        } catch (e) { /* 配置没写成不影响卸载本身 */ }
      }
      try { registry?.rescan?.(); } catch { /* ignore */ }
      log.info?.(`[modmgr] uninstalled ${id} → ${path.relative(pluginsDir, dest)}`);
      json(res, 200, { ok: true, id: id, movedTo: path.relative(pluginsDir, dest), note: '已移到 plugins/_removed/（可手工恢复）' });
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
