// preview.mjs — local preview harness for the in-page shell panels (dev tool, never shipped).
//
//   node tools/apk/preview.mjs [--port 8757]
//
// Serves the BUILT webroot (android/app/src/main/assets/webroot) as a plain static site and
// injects a stub of the Android bridges (window.shell / window.spData / window.__SP_JOIN) so the
// panels can be opened in a desktop browser for visual checks and client-side error repro.
//
// Safety: this tool serves local files and stubs only — it performs NO outbound requests and the
// mock list is built from the repo's signed servers.json. Query params:
//   ?panel=servers|params|config|records|lobby   auto-open that panel shortly after boot
//   ?cb=1                                        append a cache-buster to the stub (freshen)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', 'android', 'app', 'src', 'main', 'assets', 'webroot');
const argPort = process.argv.indexOf('--port');
const PORT = argPort > 0 ? Number(process.argv[argPort + 1]) : 8757;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wasm': 'application/wasm', '.skel': 'application/octet-stream',
  '.atlas': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

/** Mock panel entries built from the repo's signed list (no network). */
function mockEntries() {
  let doc = { servers: [] };
  try {
    doc = JSON.parse(fs.readFileSync(path.join(here, 'shell', 'servers.json'), 'utf-8'));
  } catch { /* empty list is fine for the preview */ }
  const apps = ['0.1.0', '0.1.1', '0.1.2'];
  return (doc.servers || []).map((s, i) => ({
    id: s.id, name: s.name, note: s.note || '', enabled: s.enabled !== false,
    compatible: true, appMismatch: i % 4 === 3, roomScoped: i % 5 === 4, remoteClient: false,
    reachable: i % 7 !== 6, rttMs: (i % 7 === 6) ? -1 : 28 + ((i * 37) % 260),
    humans: (i % 7 === 6) ? -1 : (i * 7) % 24, rooms: (i % 7 === 6) ? -1 : (i * 3) % 6,
    matches: (i * 2) % 5, uptimeSec: 3600 * (i + 1), protocol: 1, app: apps[i % apps.length],
    tier: s.tier || 0, weight: s.weight || 100, current: i === 3,
  }));
}

function stubScript() {
  return `<script>/* preview stub — Android bridges (dev only) */
(function(){
  /* error collector: read with evaluate(() => window.__PREVIEW_ERRORS) */
  window.__PREVIEW_ERRORS = [];
  window.addEventListener('error', function(e){
    var err = e && e.error;
    window.__PREVIEW_ERRORS.push('error: ' + String((e && (e.message || (err && err.message))) || e)
      // 注意：这一段会被塞进 HTML 的 script 里，换行转义必须写成双反斜杠 —— 模板字符串会把单反斜杠
      // 直接变成真换行，落在字符串字面量中间就是语法错误，整个桩脚本一行都不会执行
      // （症状：window.shell undefined、?panel= 不自动开面板、错误收集器也一起失效）。
      + (err && err.stack ? ' @@ ' + String(err.stack).split('\\n').slice(0, 7).join(' | ') : ''));
  });
  window.addEventListener('unhandledrejection', function(e){
    var r = e && e.reason;
    window.__PREVIEW_ERRORS.push('rejection: ' + String((r && r.message) || r || e)
      + (r && r.stack ? ' @@ ' + String(r.stack).split('\\n').slice(0, 7).join(' | ') : ''));
  });
  var _ce = console.error.bind(console);
  console.error = function(){
    try {
      window.__PREVIEW_ERRORS.push('console.error: ' + Array.prototype.map.call(arguments, function(a){
        return (a && a.stack) ? String(a.stack).split('\\n').slice(0, 8).join(' | ') : String(a);
      }).join(' ## '));
    } catch (e) {}
    _ce.apply(null, arguments);
  };
  var LIST = ${JSON.stringify(mockEntries())};
  window.shell = {
    isApp: true,
    getServers: function(){ return JSON.stringify([
      {id:'auto', label:'自动线路', note:'测速选最优', current:false},
      {id:'local', label:'离线服务', note:'单机自开房推荐', current:false},
      {id:'custom', label:'自定义线路', note:'', current:false}
    ]); },
    getServerList: function(){ return JSON.stringify({ source:'远端清单', loading:false, updated:'2026-10-04T05:43:08Z', entries: LIST }); },
    refreshServerList: function(){ console.log('[preview] refreshServerList'); },
    currentServerId: function(){ return 'weishu'; },
    setServer: function(id){ console.log('[preview] setServer', id); },
    useRemoteClient: function(id, on){ console.log('[preview] useRemoteClient', id, on); },
    hostStatus: function(){ return '房主服务：未启动'; },
    host: function(){}, join: function(){}, params: function(){}, retry: function(){}, onlineMode: function(){},
    copyText: function(s){ console.log('[preview] copyText', String(s).slice(0, 60)); },
    readClipboard: function(){ return ''; },
    setAutostart: function(){ console.log('[preview] setAutostart'); },
    takeAutostart: function(){ return '0'; },
    checkUpdate: function(){ console.log('[preview] checkUpdate'); },
    startLocalService: function(){}, localServiceReady: function(){ return '0'; },
    logJsError: function(m){ console.warn('[preview][jsError]', m); },
    setMatchRunning: function(){}, restartHost: function(){}, restartApp: function(){},
    getParams: function(){ return JSON.stringify({ port:3000, hostBind:'::', spCombat:'client', spVerify:'off', trustProxy:'auto' }); },
    setParamsJson: function(){}, clearConsent: function(){},
    // v5.6.1：新桥的预览桩。缺了它们，大厅的「局域网」小节在预览里按设计**不渲染**，
    // 新 UI 就没法在这里做视觉检查了。lanScan 异步回吐一份假结果，走与真机同一条 __SP_LAN 通道。
    getTransport: function(){ return 'auto'; },
    setTransport: function(){ return true; },
    joinOnOrigin: function(id, code){ console.log('[preview] joinOnOrigin', id, code); return true; },
    lanScan: function(mode, code){
      console.log('[preview] lanScan', mode, code);
      setTimeout(function(){
        try {
          window.__SP_LAN && window.__SP_LAN.onFound(JSON.stringify({
            ok: true, hosts: 2, probed: 254, answered: 2, errors: 252, unreachable: false,
            rooms: [
              { code:'QRST', name:'预览房主', mode:'coop', difficulty:'NORMAL', seats:4, humans:2, inMatch:false, ip:'192.168.1.23', port:3000, url:'http://192.168.1.23:3000' },
              { code:'WXYZ', name:'另一台手机', mode:'coop', difficulty:'HARD', seats:4, humans:4, inMatch:true, ip:'192.168.1.31', port:3000, url:'http://192.168.1.31:3000' }
            ],
          }));
        } catch (e) { /* preview stub */ }
      }, 350);
      return JSON.stringify({ ok:true, started:true });
    },
  };
  window.spData = {
    get: function(){ return '{"v":1,"deviceId":"preview01","profile":{"name":"预览玩家","ts":1791100000000},"loadouts":{"amiya":{"skill":2,"module":"none"}},"battles":[{"id":"1791099000000-weishu-ABCD-coop","ts":1791099000000,"serverId":"weishu","roomCode":"ABCD","mode":"coop","result":"win","duration":742000}],"rooms":{"ABCD":{"serverId":"weishu","firstSeen":1791098000000,"lastSeen":1791099000000,"count":3}},"servers":{"weishu":{"name":"站长服务","firstSeen":1791000000000,"lastSeen":1791099000000,"battles":1}}}'; },
    put: function(){ }, exportJson: function(){ return window.spData.get(); }, importJson: function(){ return true; },
  };
  window.__SP_JOIN = { resolveCode: function(){ return Promise.resolve({ kind:'none', note:'预览模式：探测为桩' }); } };
  window.__SP_DIRS = [];
  window.addEventListener('load', function(){
    setTimeout(function(){
      try {
        var p = new URLSearchParams(location.search).get('panel');
        if (p && window.__SP_SHELL && window.__SP_SHELL.openPanel) window.__SP_SHELL.openPanel(p);
      } catch (e) { /* ignore */ }
    }, 900);
  });
})();</script>`;
}

/** Isolation probe (served at /__probe.mjs when ?probe=1): renders candidate templates one by one
 *  and records which one throws, with the first stack frames. */
const PROBE_MODULE = `
import { html, Button } from '/js/ui/components.js';
const res = [];
const probe = (label, fn) => {
  try { fn(); res.push(label + ': ok'); }
  catch (e) { res.push(label + ': THROW ' + String((e && e.message) || e) + (e && e.stack ? ' @@ ' + String(e.stack).split('\\n').slice(1, 5).join(' | ') : '')); }
};
const localState = 'idle', valid = true, start = () => {}, startLocal = () => {}, localLabel = '本地服务';
probe('plain', () => html\`<div>plain</div>\`);
probe('btn', () => html\`<\${Button} variant="primary" size="xl" block=\${true} iconRight="chevrons" disabled=\${!valid}
  onClick=\${() => openShellPanel('servers')}>线上服务<//>\`);
probe('duo', () => html\`<div class="title-duo">
          <\${Button} variant="secondary" size="xl" block=\${true} class="title-local"
            iconRight=\${localState === 'ready' ? 'chevrons' : undefined}
            loading=\${localState === 'starting'}
            disabled=\${!valid || localState === 'starting'}
            onClick=\${() => { if (localState === 'ready') start(); else startLocal(); }}>\${localLabel}<//>
          <\${Button} variant="primary" size="xl" block=\${true} iconRight="chevrons" disabled=\${!valid}
            onClick=\${() => openShellPanel('servers')}>线上服务<//>
        </div>\`);
window.__PREVIEW_PROBE = res;
`;

http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/__probe.mjs') {
    res.writeHead(200, { 'content-type': MIME['.mjs'], 'cache-control': 'no-store' });
    res.end(PROBE_MODULE); return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
  }
  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  if (rel === '/index.html') {
    const probeTag = (req.url || '').includes('probe=1') ? '<script type="module" src="/__probe.mjs"></script>' : '';
    const playerDataTag = '<script src="/js/player-data.js"></script>';
    const html = body.toString('utf-8').replace('</body>', stubScript() + playerDataTag + probeTag + '</body>');
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    res.end(html); return;
  }
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:${PORT}/  (webroot ${root})`);
  console.log(`panels: ?panel=servers | ?panel=params | ?panel=config | ?panel=records | ?panel=lobby`);
});
