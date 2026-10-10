#!/usr/bin/env node
// tools/apk/check-apk.mjs — post-build gate (ported idea from Fuhua-code's check-apk, simplified for the
// Gradle pipeline): signature verifies, every ABI carries the full Termux runtime set, and the embedded
// webroot has its critical files. Fails the build on any problem.
//
//   node tools/apk/check-apk.mjs [--apk <path>] [--bt <build-tools dir>]
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalBytes } from './canonical.mjs';
import { verify as edVerify } from './ed25519.mjs';
import { ASSETS_BASE, SERVERS_URL } from './line.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const APK = arg('--apk') || path.join(repo, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const BT = arg('--bt') || process.env.SP_BUILD_TOOLS || findBuildTools();

const ABIS = ['arm64-v8a', 'x86_64'];
const RUNTIME = ['libnode.so', 'libc++_shared.so', 'libcares.so', 'libcrypto.so', 'libicudata.so',
  'libicui18n.so', 'libicuuc.so', 'libsqlite3.so', 'libssl.so', 'libz.so'];
const CRITICAL_ASSETS = ['assets/webroot/index.html', 'assets/webroot/data/assets.json', 'assets/webroot/server/index.js'];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

function findBuildTools() {
  const root = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || 'C:/Users/16891/android-build/sdk';
  const dir = path.join(root, 'build-tools');
  if (!fs.existsSync(dir)) return '';
  const versions = fs.readdirSync(dir).sort();
  return versions.length ? path.join(dir, versions[versions.length - 1]) : '';
}

function fail(msg) {
  console.error(`check-apk: ${msg}`);
  process.exit(1);
}

// 1) signature
if (!BT) fail('build-tools not found (pass --bt or set ANDROID_HOME)');
const apksigner = path.join(BT, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
execFileSync(apksigner, ['verify', '--print-certs', APK], {
  stdio: 'pipe',
  env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME },
  shell: process.platform === 'win32', // Node 18+ on Windows refuses to spawn .bat without a shell
});
console.log('check-apk: signature verifies');

// 2) entries
const listing = listEntries(APK);
for (const abi of ABIS) {
  const missing = RUNTIME.filter((lib) => !listing.has(`lib/${abi}/${lib}`));
  if (missing.length) fail(`${abi}: missing runtime files: ${missing.join(', ')}`);
  console.log(`check-apk: ${abi}: full runtime present (${RUNTIME.length} files)`);
}
for (const a of CRITICAL_ASSETS) {
  if (!listing.has(a)) fail(`missing embedded asset: ${a}`);
}
console.log('check-apk: critical webroot assets present');

// 3) shell wiring: the DataChannel config must reach the page, otherwise the join-by-code P2P
// fallback is silently dead in the shell (see 审计方案-三端.md B1). The zero-patch line has no
// index.html anchor any more — the shell injects window.__SP_DC_INPUT inline into every HTML
// response (MainActivity dcInjectScript), so the reader is checked here and the injector in §8
// (where the shell Java source is already loaded).
const webroot = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot');
const dcBridge = fs.readFileSync(path.join(webroot, 'js', 'dc-bridge.js'), 'utf-8');
if (!dcBridge.includes('__SP_DC_INPUT')) fail('dc-bridge.js does not read __SP_DC_INPUT (DC fallback would be dead)');
console.log('check-apk: shell DC wiring consistent');

// 3b) 内嵌素材标记必须与**这个 APK 里的实际字节**一致（审计 2026-10-09 §1.2）。
//     写反的两个方向代价都很大：
//       · 标记说「内嵌」但包里没有 → runArtSync 跳过 pack 安装 → 无素材版永远缺图（且静默）；
//       · 标记说「无素材」但包里有 → 内嵌版把 379 MiB 的 art pack 再下一份（重复存储复发）。
//     所以这里用 APK 条目清单（唯一权威）反推，并校验门禁两头都接好了。
const apkHasAssets = [...listing].some((e) => e.startsWith('assets/webroot/assets/'));
const gradle = fs.readFileSync(path.join(repo, 'android', 'app', 'build.gradle'), 'utf-8');
const mainJava = fs.readFileSync(path.join(repo, 'android', 'app', 'src', 'main', 'java',
  'icu', 'jiangjiangze', 'stronghold', 'MainActivity.java'), 'utf-8');
if (!/buildConfigField\s+'boolean',\s+'EMBEDDED_ASSETS'/.test(gradle)) {
  fail('build.gradle 缺少 EMBEDDED_ASSETS buildConfigField（内嵌素材门禁的构建期事实来源）');
}
if (!/private boolean embeddedAssets\(\)/.test(mainJava)) {
  fail('MainActivity 缺少 embeddedAssets() 运行期复核（只信 BuildConfig 会在 --reuse 构建上判错）');
}
if (!/if \(embeddedAssets\(\)\)[\s\S]{0,500}?skipped: assets embedded/.test(mainJava)) {
  fail('runArtSync() 缺少内嵌门禁（内嵌版会白下载 379 MiB 的 art pack）');
}
console.log(`check-apk: embedded-assets gate wired (this APK ${apkHasAssets ? 'embeds' : 'does NOT embed'} assets/**)`);

// 4) slim-package assertions (v2.5): stamp reaches the APK (aapt drops dotfiles — the old ".stamp"
// never shipped, which is why every launch re-materialised), and the heavy client/test dependencies
// must stay out of node_modules (the host runtime needs {ws, werift} only — 131 MB → ~30 MB).
if (!fs.existsSync(path.join(webroot, 'stamp.txt'))) fail('build artifact lacks stamp.txt (run build-webroot)');
if (![...listing].some((e) => e === 'assets/webroot/stamp.txt')) {
  fail('assets/webroot/stamp.txt missing from the APK (aapt dotfile/stamp regression: cold-start skip would be dead)');
}
console.log('check-apk: slim stamp present in APK');
// mediabunny is intentionally allowed: it is a werift runtime dependency (media handling), not
// client/test tooling — the slim tree lands at ~26 MB with it.
for (const heavy of ['pixi.js', 'three', '@pixi-spine', 'puppeteer-core', 'chromium-bidi']) {
  const prefix = `assets/webroot/node_modules/${heavy}/`;
  if ([...listing].some((e) => e.startsWith(prefix))) {
    fail(`heavy dependency present in the slim tree: node_modules/${heavy} (host runtime needs only ws, werift)`);
  }
}
console.log('check-apk: node_modules trimmed to host runtime deps');

// 5) manifests must carry the CDN base — the shell interceptor resolves these URLs against the
// embedded tree (APK clients stay local) while browsers fetch them from R2/weishucdn.
const assetsManifest = readEntry(APK, 'assets/webroot/data/assets.json');
if (!assetsManifest.includes(ASSETS_BASE)) {
  fail(`data/assets.json is not prefixed with this line's CDN base (${ASSETS_BASE}) — build-webroot transform missing or pointing at the other line's tree`);
}
console.log('check-apk: manifests point at the CDN base');

// 6) signed shell assets. The pinned public key, the signed server list and the manifest
// baseline must ship inside the APK and must actually verify — a broken signature silently
// disables the entire server-list / hot-update trust chain on device.
const shellDir = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'shell');
const pubPath = path.join(shellDir, 'pubkey.bin');
if (!fs.existsSync(pubPath)) fail('assets/shell/pubkey.bin missing (signed lists could never verify)');
const pub = fs.readFileSync(pubPath);
if (pub.length !== 32) fail(`shell/pubkey.bin must be a raw 32-byte Ed25519 key (got ${pub.length})`);
for (const a of ['assets/shell/pubkey.bin', 'assets/shell/servers.json', 'assets/shell/manifest.json']) {
  if (!listing.has(a)) fail(`missing embedded asset: ${a}`);
}
function verifyDoc(doc) {
  return typeof doc?.sig === 'string'
    && edVerify(canonicalBytes(doc), Buffer.from(doc.sig, 'base64'), pub);
}
const serversDoc = JSON.parse(fs.readFileSync(path.join(shellDir, 'servers.json'), 'utf8'));
if (!verifyDoc(serversDoc)) fail('assets/shell/servers.json fails Ed25519 verification against pubkey.bin');
if (!Array.isArray(serversDoc.servers) || !serversDoc.servers.length) fail('embedded server list is empty');
const manifestDoc = JSON.parse(fs.readFileSync(path.join(shellDir, 'manifest.json'), 'utf8'));
if (!verifyDoc(manifestDoc)) fail('assets/shell/manifest.json fails Ed25519 verification against pubkey.bin');
if (!manifestDoc.buildTag) fail('embedded manifest has no buildTag');
// the manifest's servers pointer must be THIS line's signed endpoint — an http(s) JSON URL on one
// of our own hosts, never the other line's copy and never a site's HTML page. The expected value
// comes from line.mjs, so a baseline regenerated by gen-manifest (which writes Line.SERVERS_URL)
// passes instead of failing the build.
if (manifestDoc.servers?.url !== SERVERS_URL) {
  fail(`manifest.servers.url must be ${SERVERS_URL} (got ${manifestDoc.servers?.url})`);
}
console.log('check-apk: signed shell assets verify');

// 7) the on-device hot updater replays extras + patches from assets — without them an update
// would drop the bridge scripts and the DC wiring (the regression the plan calls out).
if (!listing.has('assets/shell/extras/public/js/shell-bridge.js')) {
  fail('assets/shell/extras/public/js/shell-bridge.js missing (hot update would drop the bridge)');
}
// 7a) the /__sp/ chain: shell-bridge loads every overlay from /__sp/<name>, which MainActivity
// serveShellAsset resolves through openLocal("/js/<name>") — i.e. filesDir/webroot first (hot tree)
// then assets/webroot (APK baseline). Both halves must be present or the home overlay silently
// never loads: the webroot copy is what the loader fetches, the extras copy is what a hot update
// replays. (2026-10-08: the apk line's older serveShellAsset looked under assets/shell/js/, which
// build-webroot never produces — a dead chain.)
for (const rel of ['js/shell-bridge.js', 'js/home-layer.js', 'js/notice-board.js', 'js/notices.json', 'js/art-prefetch.js', 'js/server-config.js', 'js/preload-center.js']) {
  if (!listing.has(`assets/webroot/${rel}`)) {
    fail(`assets/webroot/${rel} missing (the /__sp/ loader would 404 it — check build-webroot's extras copy)`);
  }
}
// The loader must actually reference the server-config view: the file shipping without a loader entry
// (or the entry surviving a deleted file) is the exact silent-half-failure this chain is prone to.
{
  const bridgePath = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot', 'js', 'shell-bridge.js');
  const bridgeSrc = fs.existsSync(bridgePath) ? fs.readFileSync(bridgePath, 'utf-8') : '';
  if (!bridgeSrc.includes("'/__sp/server-config.js'")) {
    fail("shell-bridge.js does not load '/__sp/server-config.js' (the page would never see the server config)");
  }
  if (!bridgeSrc.includes("'/__sp/preload-center.js'")) {
    fail("shell-bridge.js does not load '/__sp/preload-center.js' (the browser-cache preload center would never load)");
  }
}
const mainActivitySrc = fs.readFileSync(
  path.join(repo, 'android', 'app', 'src', 'main', 'java', 'icu', 'jiangjiangze', 'stronghold', 'MainActivity.java'),
  'utf-8',
);
if (!/serveShellAsset[\s\S]{0,600}?openLocal\(/.test(mainActivitySrc)) {
  fail('serveShellAsset no longer resolves through openLocal() — the hot tree would be ignored (/__sp/ chain broken)');
}
console.log('check-apk: /__sp/ overlay chain wired (webroot copy + openLocal hot-tree fallback)');

// 7b) 字体来源（业主口径 2026-10-09「字体：本地服务走本地，走服务器上走服务器，CDN 仅作为本地下载源」）：
// 本地自托管字体表必须**真的在包里**（extras → webroot），否则 MainActivity 的字体分支取不到表 →
// 静默回空表 → 本地页面掉回系统字体、Oxanium/Rajdhani 永远不生效（一种没人会报的失败）。
// 这里同时钉住 Java 侧的接线形状：门在、常量在（改名字/绕过门 → 红）。
{
  const fontCss = 'assets/webroot/fonts/webfonts-local.css';
  if (!listing.has(fontCss)) {
    fail(`${fontCss} missing (local font table absent — font-host requests would answer empty CSS)`);
  }
  const ours = [...listing].filter(
    (e) => e.startsWith('assets/webroot/fonts/') && /\/[a-z]+-(400|500|600|700)-(latin|latin-ext)\.woff2$/.test(e)
      && /(oxanium|rajdhani)/.test(e),
  );
  if (ours.length < 14) {
    fail(`assets/webroot/fonts: only ${ours.length} Oxanium/Rajdhani woff2 files (need >= 14) — the extras copy dropped them`);
  }
  if (!/RemoteClientPolicy\.fontFromLocalTable\(pageServedFromLocalTree\)/.test(mainActivitySrc)) {
    fail('the font host branch no longer goes through RemoteClientPolicy.fontFromLocalTable (font-source policy lost)');
  }
  if (!/LOCAL_FONT_CSS\s*=\s*"\/fonts\/webfonts-local\.css"/.test(mainActivitySrc)) {
    fail('LOCAL_FONT_CSS constant missing/changed — the interceptor would look for the wrong table');
  }
  console.log(`check-apk: local font table wired (webfonts-local.css + ${ours.length} woff2, policy gate present)`);
}

// 7d) 素材热更（P0）：ArtStore.java 必须存在，且 openLocal 的命中序真的经过 ArtStore.open —
// 少任何一半，pack 装得下却永远服务不到页面（静默失效，比崩溃更难发现）。
const artStoreSrc = path.join(repo, 'android', 'app', 'src', 'main', 'java',
  'icu', 'jiangjiangze', 'stronghold', 'ArtStore.java');
if (!fs.existsSync(artStoreSrc)) {
  fail('ArtStore.java missing (art packs could never be installed or served)');
}
if (!/openLocal\(String path\)[\s\S]{0,900}?ArtStore\.open\(/.test(mainActivitySrc)) {
  fail('openLocal does not resolve through ArtStore.open — packs would install but never be served');
}
console.log('check-apk: art store wired (ArtStore.java present + openLocal falls through it)');

// 7e) 服务器配置（ServerConfig）：协议端点必须直连、服务器素材必须同源、配置类必须都在。
// 这三条各自的失败模式都是**静默**的：端点被本地树顶掉 = 假成功；服务器素材不走同源 = 跨域污染
// canvas；配置类缺失 = 通道永不生效却没有任何报错。
const cfgDir = path.join(repo, 'android', 'app', 'src', 'main', 'java', 'icu', 'jiangjiangze', 'stronghold');
for (const cls of ['ServerConfig.java', 'ServerConfigStore.java', 'ServerConfigHub.java',
  'ShellConfigStore.java', 'ResourceResolver.java']) {
  if (!fs.existsSync(path.join(cfgDir, cls))) fail(`${cls} missing (the server-config channel could not work)`);
}
if (!/ResourceResolver\.isProtocolPath\(rawPath\)\) return null;/.test(mainActivitySrc)) {
  fail('the interceptor no longer short-circuits /api|/ws|/healthz — a local file could shadow a protocol endpoint');
}
if (!/sameOriginAs\(u, origin\)/.test(mainActivitySrc)) {
  fail('the server-asset fallback lost its same-origin check — it could fetch a host other than the current server');
}
if (!/ServerConfigHub\.ensureFresh\(origin\)/.test(mainActivitySrc)) {
  fail('nothing refreshes the server config on navigation (the panel would show a stale/absent snapshot)');
}
console.log('check-apk: server config wired (classes present + protocol endpoints direct + same-origin asset fallback)');

const patchCount = [...listing].filter((e) => e.startsWith('assets/shell/patches/') && e.endsWith('.json')).length;
// 2026-10-07：补丁清零是合法终态（壳侧 UI 全部走 extras/叠加层）。0 个补丁不再判红——但要打印出来，
// 让人一眼看到「这个包没有构建期补丁」；>0 时保持原样（说明还在过渡期）。
if (patchCount === 0) console.log('check-apk: no build-time patches (patch set empty by design — shell UI is in extras/overlays)');
else console.log(`check-apk: hot-update overlay present (${patchCount} patches)`);

// 7b) the overlay loading point (v2.8.0): the loader must ship in the APK (webroot + assets/shell)
// and the Android entry must call it — otherwise slim-delivered overlays would never start.
if (!listing.has('assets/webroot/server/overlay-loader.mjs')) {
  fail('assets/webroot/server/overlay-loader.mjs missing (overlay loading point not built)');
}
if (!listing.has('assets/shell/extras/server/overlay-loader.mjs')) {
  fail('assets/shell/extras/server/overlay-loader.mjs missing (hot update would drop the overlay loader)');
}
const androidMainPath = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot', 'server', 'android-main.mjs');
if (!fs.existsSync(androidMainPath) || !fs.readFileSync(androidMainPath, 'utf-8').includes('loadOverlays')) {
  fail('android-main.mjs does not call loadOverlays (slim-delivered overlays would never start)');
}
console.log('check-apk: overlay loading point wired (loader shipped + android-main hook)');

// 7c) content-pack shell overlay baseline (v2.8.x): Updater reads this integer to decide whether a
// slim-carried shell-ui/ snapshot (extras+patches, signed via the manifest's slim.sha256) is newer
// than the APK's own overlay. Absent on device = 0 (old behavior), so this gate keeps a silent
// baseline regression from shipping without disabling the channel.
if (!listing.has('assets/shell/shell-ui-version.txt')) {
  fail('assets/shell/shell-ui-version.txt missing (slim-overlay baseline could never be read)');
}
if (!/^\d+\s*$/.test(readEntry(APK, 'assets/shell/shell-ui-version.txt'))) {
  fail('assets/shell/shell-ui-version.txt is not a non-negative integer');
}
console.log('check-apk: shell-ui baseline version present');

// 8) P0-2 injection + the pure-Java verifier must be in the source; the third-party consent gate
// must be GONE (v2.7.7: local misses go straight to the current server, no disclaimer dialog)
const shellSrc = path.join(repo, 'android', 'app', 'src', 'main', 'java', 'icu', 'jiangjiangze', 'stronghold');
const mainActivity = fs.readFileSync(path.join(shellSrc, 'MainActivity.java'), 'utf-8');
if (!mainActivity.includes('injectShellHtml')) fail('MainActivity lacks the P0-2 HTML injection');
// DC wiring injector (see §3): the zero-patch line has no index.html anchor, so the shell must be
// the one that publishes window.__SP_DC_INPUT — and the loader must still ship dc-bridge.js.
if (!mainActivity.includes('__SP_DC_INPUT')) fail('MainActivity does not inject __SP_DC_INPUT (DC fallback would be dead)');
if (!mainActivity.includes("'dc-bridge.js'")) fail('shell loader no longer ships dc-bridge.js (DC fallback would be dead)');
if (mainActivity.includes('requestConsent')) fail('MainActivity still contains the third-party consent gate (removed in v2.7.7)');
if (!fs.existsSync(path.join(shellSrc, 'Ed25519.java'))) fail('Ed25519.java missing (signed lists could not verify on API 26)');
if (!fs.existsSync(path.join(shellSrc, 'ServerList.java'))) fail('ServerList.java missing');
console.log('check-apk: P0-2 injection + Ed25519 verifier present; consent gate removed (v2.7.7)');

// 8a) HTML5 全屏接线（2026-10-08）：页面（title 屏 .title-fs / 对局 HUD，见 public/js/ui/device.js）
// 的全屏按钮走 document.documentElement.requestFullscreen()；WebView 只在 WebChromeClient 覆写了
// onShowCustomView/onHideCustomView 时才把请求当「支持全屏」并递出自定义 View。裸 new WebChromeClient()
// 会让按钮静默变 no-op（页面上看不到失败），所以接线钉在源码上，而不是等用户发现点不动。
if (!mainActivity.includes('onShowCustomView')) {
  fail('MainActivity lacks onShowCustomView (page fullscreen would be a silent no-op)');
}
if (!mainActivity.includes('onHideCustomView')) {
  fail('MainActivity lacks onHideCustomView (a native fullscreen view could never be hidden)');
}
if (!mainActivity.includes('setWebChromeClient(new ShellChromeClient())')) {
  fail('MainActivity installs a bare WebChromeClient (fullscreen overrides would never reach the WebView)');
}
console.log('check-apk: HTML5 fullscreen wiring present (onShowCustomView/onHideCustomView reached the WebView)');

// 8b) 服务端界面（「用该服自有客户端」）**默认开** —— APK 轴（业主口径 2026-10-08；口径于
// **2026-10-10 正式反转**：「第三方服务器的自有客户端不能被遮蔽（包含首页）」「所有服务器都能取缓存」）。
// 缺任何一件，默认「服务端界面」都会变成单向门或让热更被回滚：远程客户端路径跳过 SHELL_INJECT，
// 服务器页面里没有外壳界面（面板/设置都点不到），而 origin + 偏好都会持久化 → 冷启动再次直连该服。
//   (a) remoteClientFor 的缺省值 + 两道硬门必须来自纯决策表（本机服务/局域网永远走内嵌树）；
//   (b) 原生退出口（showShellMenu 的「回到本地客户端」）必须在 —— 逐服显式「本地客户端」是唯一
//       的「我就是要本地树」途径；
//   (c) 页面探测的两个桥方法（remoteClientCurrent / setRemoteClientDefault）必须在；
//   (d) ServerList.isPublicHttpUrl 仍是宿主准入的**同一张表**（HostPolicy）。
const rcPolicySrc = path.join(shellSrc, 'RemoteClientPolicy.java');
if (!fs.existsSync(rcPolicySrc)) {
  fail('RemoteClientPolicy.java missing (the remote-client default/guards could not be decided)');
}
const rcPolicy = fs.readFileSync(rcPolicySrc, 'utf-8');
if (!rcPolicy.includes('PREF_DEFAULT = "remote-client-default"')) {
  fail('RemoteClientPolicy lacks the remote-client-default pref key (the page-set default could never reach the interceptor)');
}
// 默认必须是**服务端界面**（业主口径 **2026-10-10**：「第三方服务器的自有客户端不能被遮蔽（包含首页）」
// 「所有服务器都能取缓存」）。注意：2026-10-09 的「连接服务器：仅首页页面叠加，其他 ui 按服务器正常
// 显示」**已被业主正式反转** —— 当时首页被首页作用域门永久留给本地树（= 遮蔽了该服首页），现在
// scopeAllows 对站内**所有路径**放行（含 /、""、/index.html、/index.htm），逐服显式「本地客户端」
// 仍是唯一逃生阀。所以这里钉的是**新口径**（断言见下）；旧口径的断言已删除。
if (!/defaultGlobal\(\)\s*\{[\s\S]{0,400}?return true;/.test(rcPolicy)) {
  fail('RemoteClientPolicy.defaultGlobal() no longer returns true (「服务端自有客户端优先」would stop being the default)');
}
{
  // scopeAllows 的新语义：remoteClientOn=false → 不放行（本地树）；host 空 / 非公网 → 不放行；
  // 其余**一律放行**（路径不参与判定）。isSubPagePath 不许再出现在放行判定里（那正是旧口径的门）。
  const scope = rcPolicy.slice(rcPolicy.indexOf('public static boolean scopeAllows'));
  const body = scope.slice(0, scope.indexOf('\n    }'));
  if (!/if \(!remoteClientOn\) return false;/.test(body)) {
    fail('scopeAllows no longer short-circuits when the per-host pref is OFF (the escape hatch would be gone)');
  }
  if (!/HostPolicy\.isPublicHost\(host\)/.test(body)) {
    fail('scopeAllows lost the public-host guard (loopback/LAN hosts must never be passed through)');
  }
  if (!/return true;/.test(body) || /isSubPagePath\(path\)/.test(body)) {
    fail('scopeAllows still gates on the path (the 2026-10-09 home-scope gate must stay REMOVED: home is not shadowed any more)');
  }
}
// 首页判定仍是纯路径事实（诊断/未来按路径规则用）——语义不许漂移，但**不再是放行门**。
if (!/\/index\.html"\.equals\(path\)/.test(rcPolicy)) {
  fail('isHomePath no longer treats /index.html as home (the pure path fact would drift)');
}
// P1 失败兜底：**5xx** → 本地树 index.html；3xx 必须交回 WebView 自己跟（硬约束）。连接层失败
// （超时/DNS/拒绝）**不回退本地树** —— Java 取不到 ≠ 服务器取不到（CF 前的服务器在模拟器上对 Java
// 一律超时、Chromium 却能取回），回退会遮蔽一个可用的第三方自有客户端；那条路径交回 WebView 原生
// 加载，真失败时由既有 onReceivedError → ensureHostAndSwitch(true) 兜到本地服务。
if (!/public static boolean localTreeFallbackOnMainFrameFetch\(int statusCode, boolean ioFailure\)/.test(rcPolicy)) {
  fail('RemoteClientPolicy lost localTreeFallbackOnMainFrameFetch (a 5xx page would be shown as the server error page)');
}
{
  const fb = rcPolicy.slice(rcPolicy.indexOf('public static boolean localTreeFallbackOnMainFrameFetch'));
  const body = fb.slice(0, fb.indexOf('\n    }'));
  if (!/statusCode >= 300 && statusCode < 400\) return false;/.test(body)) {
    fail('the 3xx branch of the main-frame fallback changed (WebView must keep following redirects itself)');
  }
  if (!/statusCode >= 500\) return true;/.test(body)) {
    fail('5xx no longer falls back to the local tree');
  }
  if (!/if \(ioFailure\) return false;/.test(body)) {
    fail('a Java-side connect failure now falls back to the local tree (that shadows a REACHABLE third-party client; see the policy comment)');
  }
}
if (!/localTreeFallbackOnMainFrameFetch\(/.test(mainActivity)) {
  fail('MainActivity does not use localTreeFallbackOnMainFrameFetch (the fail-closed fallback is not wired)');
}
if (!/javaFetchFailed/.test(mainActivity)) {
  fail('MainActivity lost the javaFetchFailed verdict (a Java-side fetch failure would be indistinguishable from a 5xx)');
}
if (!/MainFrameFetch/.test(mainActivity)) {
  fail('MainActivity lost the MainFrameFetch verdict (3xx-vs-5xx ambiguity would come back)');
}
if (!fs.existsSync(path.join(shellSrc, 'HostPolicy.java'))) {
  fail('HostPolicy.java missing (loopback/private hosts could be treated as remote-client hosts)');
}
if (!mainActivity.includes('RemoteClientPolicy.resolve(')) {
  fail('MainActivity.remoteClientFor does not go through RemoteClientPolicy.resolve (guards/default bypassed)');
}
if (!mainActivity.includes('RemoteClientPolicy.healthy(')) {
  fail('onPageFinished does not use RemoteClientPolicy.healthy (a remote default would roll the hot update back)');
}
if (!mainActivity.includes('回到本地客户端')) {
  fail('the native escape「回到本地客户端」is gone (a remote-client page would be a one-way door)');
}
if (!mainActivity.includes('public String remoteClientCurrent()')) {
  fail('the remoteClientCurrent() bridge read-back is gone (the page cannot detect the native escape hatch)');
}
if (!mainActivity.includes('public void setRemoteClientDefault(boolean on)')) {
  fail('the setRemoteClientDefault() bridge setter is gone (the in-page default could not reach the interceptor)');
}
{
  const serverListSrc = fs.readFileSync(path.join(shellSrc, 'ServerList.java'), 'utf-8');
  if (!/isPublicHttpUrl\(String url\)[\s\S]{0,700}?HostPolicy\.isPublicHost\(u\.getHost\(\)\)/.test(serverListSrc)) {
    fail('ServerList.isPublicHttpUrl no longer delegates to HostPolicy (the host admission gate drifted)');
  }
}
console.log('check-apk: remote-client default + escape hatch + bridge read-back wired');

// 8b-2) P2（2026-10-10「所有服务器都能取缓存」）：第三方服页面上的 /assets/** 必须走**读穿缓存**
// —— 命中即本地同源返回，未命中同源取回并落盘到**那台服自己的 setKey** 命名空间；拿不到 setKey
// （清单 404/超时/非我方格式）就退回放行，**绝不回占位图**（占位是给我们自己的客户端用的）。
// 协议端点（/api/**、/ws、/healthz）与点开头路径段一律不碰。
if (!/ResourceResolver\.isProtocolPath\(rawPath\)\) return null;/.test(mainActivity)) {
  fail('the protocol-endpoint exclusion is gone (a local file could shadow /api/**、/ws、/healthz)');
}
if (!/openServerPageAsset\(/.test(mainActivity)) {
  fail('MainActivity lost openServerPageAsset (server pages could not read through the art cache)');
}
if (!/private InputStream openServerPageAsset\(String host, String requestPath, String assetKey, boolean prefetch\)/.test(mainActivity)) {
  fail('openServerPageAsset lost its per-origin shape (the cache slot must be the SERVER\'s own setKey)');
}
if (!/serverPageSetKey\(host\)/.test(mainActivity) || !/SERVER_ART_MANIFEST_PATH = "\/data\/assets\.json"/.test(mainActivity)) {
  fail('the per-origin setKey is not read from <origin>/data/assets.json (P2 would have no namespace)');
}
if (!/ArtCdn\.referencedAssetRels\(text\)\.isEmpty\(\)\) return null;/.test(mainActivity)) {
  fail('a manifest with no /assets/** reference is no longer rejected (non-our-format manifests would share one namespace)');
}
if (!/ArtCdn\.cacheRelPath\(setKey, assetKey\)/.test(mainActivity)) {
  fail('the P2 cache slot is not ArtCdn.cacheRelPath(<server setKey>, <canonical asset key>)');
}
if (!/ArtCdn\.assetKeyOf\(rawPath\)/.test(mainActivity)) {
  fail('the P2 asset-key canonicalisation (assetKeyOf) is gone');
}
if (!/ResourceResolver\.sameOriginUrl\(origin, requestPath\)/.test(mainActivity)) {
  fail('P2 no longer builds its fetch URL from the current origin (same-origin iron rule broken)');
}
if (!/sameOriginAs\(u, origin\)/.test(mainActivity)) {
  fail('fetchServerSetKey no longer re-checks same-origin before requesting the manifest');
}
{
  // The P2 branch must never answer a third-party page with our placeholder.
  const start = mainActivity.indexOf('private InputStream openServerPageAsset(');
  const end = mainActivity.indexOf('private InputStream openAssetFromServer(', start);
  const p2 = start >= 0 ? mainActivity.slice(start, end > start ? end : start + 6000) : '';
  if (!p2) fail('the openServerPageAsset body could not be read back');
  if (/artPlaceholder/.test(p2)) {
    fail('P2 returns artPlaceholder for a third-party page (the placeholder is for OUR client only)');
  }
}
console.log('check-apk: P2 server-page asset read-through cache wired (per-origin setKey, fail-open, no placeholder)');

// 8c) 素材缓存实况（feat/art-cache-status）：页面必须能问到「磁盘上到底缓存了多少素材」——它此前
// 只能看 art-prefetch.js 的 done（把「本地已有」和「已从 CDN 取回」混在一起），而真正的缓存是
// ArtCdn 写在 filesDir/art/cache/<manifest hash>/ 下的。两个桥方法缺一不可；且 clearArtCache 只能
// 清 art/cache/**（绝不能碰 art/packs/** 的已验签内容 —— 那会把用户花流量装好的素材包一起删掉）；
// 既有的 artStatus() 是另一条公开 API，不许被这次改动破坏。
if (!/public String artCacheStatus\(\)/.test(mainActivity)) {
  fail('the artCacheStatus() bridge read-back is gone (the page cannot ask the shell how much art is cached)');
}
if (!/public String clearArtCache\(\)/.test(mainActivity)) {
  fail('the clearArtCache() bridge action is gone (a stale fetched cache could never be dropped)');
}
if (!/public String artStatus\(\)/.test(mainActivity)) {
  fail('artStatus() disappeared (the existing pack-status bridge API must not break)');
}
if (!fs.existsSync(path.join(shellSrc, 'ArtCacheStats.java'))) {
  fail('ArtCacheStats.java missing (the O(1) cache counters could not be kept)');
}
{
  const start = mainActivity.indexOf('public String clearArtCache()');
  let body = '';
  if (start >= 0) {
    const end = mainActivity.indexOf('@JavascriptInterface', start + 1);
    body = mainActivity.slice(start, end > start ? end : start + 1500);
  }
  if (!body.includes('ArtCdn.CACHE_DIR')) {
    fail('clearArtCache does not target ArtCdn.CACHE_DIR (it must clear art/cache only, never art/packs)');
  }
  if (/\bpacks\b/.test(body)) {
    fail('clearArtCache mentions packs (it must never touch the signed art/packs tree)');
  }
}
console.log('check-apk: art cache status/clear bridge wired (cache-only clear + artStatus preserved)');

// 8d) 素材包通道的实时速度（业主 2026-10-09「预载进度要显示下载/解压速度」）：包通道那一半只能由
// shell 提供 —— 页面 preload-center.js 读 ShellBridge.artSyncStatus()（能力标记 __SP_SHELL.artSyncBridge
// 由 shell-bridge.js 按原生方法是否存在设置）。顺带钉住两件容易悄悄退化的事：
//   · 装包入口必须是 Updater.downloadArt（单连接续传 / 多连接分段的选择点）—— 退回 downloadOne 就等于
//     把「多线程下载」这个交付物丢了，而且不会有任何编译错误提醒；
//   · 承载它的两个纯 JVM 类（O(1) 读数的 ArtSyncStats、分段策略 ArtRange）必须在壳源集里。
if (!/public String artSyncStatus\(\)/.test(mainActivity)) {
  fail('the artSyncStatus() bridge read-back is gone (the panel could not show the pack download/unpack speeds)');
}
if (!/Updater\.downloadArt\(/.test(mainActivity)) {
  fail('the pack fetcher no longer goes through Updater.downloadArt (segmented multi-connection download lost)');
}
for (const newShellFile of ['ArtSyncStats.java', 'ArtRange.java']) {
  if (!fs.existsSync(path.join(shellSrc, newShellFile))) {
    fail(`${newShellFile} missing (the pack-channel speeds / segment policy could not be kept)`);
  }
}
console.log('check-apk: pack-channel speed bridge + segmented download wired');

// 8e) 错误分类（审计 2026-10-09 §2 D3）：只有 404/410 可以进 10 分钟的「永久缺失」记忆。
// 旧实现是 `code >= 400 && code < 500` —— 408/425/429 也是 4xx，于是 CDN 限流被记成「这个素材不存在」，
// 页面整整 10 分钟只能拿到占位图，而占位图又被预载当成成功（D2）。这条断言把回归挡住。
if (!/ArtCdn\.isPermanentMiss\(/.test(mainActivity)) {
  fail('rememberArtMiss no longer goes through ArtCdn.isPermanentMiss (a transient 4xx could be cached as a permanent miss)');
}
if (/code\s*>=\s*400\s*&&\s*code\s*<\s*500\)\s*rememberArtMiss/.test(mainActivity)) {
  fail('rememberArtMiss is back on the blanket 4xx test (408/425/429 would be remembered as missing for 10 min)');
}
console.log('check-apk: permanent-miss classification narrowed to 404/410');

// 8f) 占位响应必须带内部标记（审计 2026-10-09 §2 D2）：占位故意是 200（页面不因缺图连环报错），
// 所以没有标记时预载无法区分「真素材」与「1×1 透明占位」—— 缺图会被计成预载成功，并从 owed 列表里
// 消失（再也不会补）。标记头是这两者之间唯一的信号，必须在 ArtCdn 里定义并被 MainActivity 用上。
{
  const artCdnSrc = fs.readFileSync(path.join(shellSrc, 'ArtCdn.java'), 'utf-8');
  if (!/PLACEHOLDER_HEADER\s*=\s*"X-SP-Art-Placeholder"/.test(artCdnSrc)) {
    fail('ArtCdn lost the X-SP-Art-Placeholder marker (the prefetch could not tell a placeholder from a real asset)');
  }
  if (!/headers\.put\(PLACEHOLDER_HEADER/.test(artCdnSrc)) {
    fail('placeholderHeaders() no longer carries the marker (a placeholder would count as a preloaded asset)');
  }
  if (!/Cache-Control", "no-store/.test(artCdnSrc)) {
    fail('the placeholder lost Cache-Control: no-store (a cached placeholder outlives the fetch that succeeds)');
  }
  if (!/ArtCdn\.placeholderHeaders\(\)/.test(mainActivity)) {
    fail('artPlaceholder() no longer uses ArtCdn.placeholderHeaders() (the marker/no-store contract drifted)');
  }
}
console.log('check-apk: placeholder response carries the internal marker + no-store');

// 8g) 分段下载的默认并发（业主 2026-10-09：「多线程默认为 16；如无这些线程则取最高」）。
// 实测：主源 weishucdn 支持 Range（206 + Content-Range），备用源 dl. 对 Range 回 200（不支持）→
// 后者走 RangeUnsupported 退回线性。旧值 4 条 + 12 MiB/段，使 16–36 MiB 的包只拿到 2 条连接。
{
  const artRangeSrc = fs.readFileSync(path.join(shellSrc, 'ArtRange.java'), 'utf-8');
  if (!/MAX_CONNS\s*=\s*16\s*;/.test(artRangeSrc)) {
    fail('ArtRange.MAX_CONNS is not 16 (the owner asked for 16 connections by default)');
  }
  if (!/SEGMENT_BYTES\s*=\s*4L\s*\*\s*1024\s*\*\s*1024\s*;/.test(artRangeSrc)) {
    fail('ArtRange.SEGMENT_BYTES drifted from 4 MiB (a 64 MiB pack must fill all 16 connections)');
  }
  if (!/connsFor\(long size, int threads\)/.test(artRangeSrc)) {
    fail('ArtRange.connsFor(size, threads) is gone (the thread cap is "如无这些线程则取最高")');
  }
  if (!/availableThreads\(\)/.test(mainActivity) && !fs.readFileSync(path.join(shellSrc, 'Updater.java'), 'utf-8').includes('availableThreads()')) {
    fail('the segmented download no longer asks the device for its thread count');
  }
}
console.log('check-apk: segmented download defaults to 16 connections, capped by device threads');

// 8h) 逐文件证据闸（审计 2026-10-09 阶段 1 方案 1；2026-10-10 方向 C 扩证据来源）。
// 清单 hash 是字节敏感的：hash 变了就等于内容变了，而设备无法知道是哪个文件变了。旧实现无条件把旧
// 命名空间改名复用 → 那张唯一改过的图永远不更新。现在：**没有逐文件证据就不采纳**，有证据才逐文件
// 裁决（{@code MERGE_OK} 才 move，其余留在原处不删），且继承来的字节在使用时还要再校验一次。
// 2026-10-10 起证据有两个来源（业主口径 abc 的 C）：① 我方随包发的 data/asset-digests.json；
// ② 源命名空间自己的 sidecar（我们自己取回时记下的 sha256）—— 第三方服因此从第二次交互起可继承。
// 这条门禁必须钉住「无证据 ⇒ 不采纳」这条底线，而不是钉死某一个证据来源。
{
  const artCdnSrc = fs.readFileSync(path.join(shellSrc, 'ArtCdn.java'), 'utf-8');
  if (!/DIGEST_PATH\s*=\s*"\/data\/asset-digests\.json"/.test(artCdnSrc)) {
    fail('ArtCdn.DIGEST_PATH is gone (the per-file digest table is the phase-1 correctness lever)');
  }
  if (!/digestsUsableFor\(/.test(artCdnSrc)) {
    fail('ArtCdn.digestsUsableFor is gone (a table from another hash must not be used)');
  }
  if (!/pickEvidence\(/.test(artCdnSrc) || !/MERGE_NO_EVIDENCE/.test(artCdnSrc) || !/mergeVerdict\(/.test(artCdnSrc)) {
    fail('the per-file evidence verdict is gone (ArtCdn.pickEvidence/mergeVerdict/MERGE_NO_EVIDENCE) — '
      + 'adoption would no longer be gated on evidence and stale bytes would be reused');
  }
  if (!/SIDECAR_NAME\s*=\s*"\.sp-digests\.json"/.test(artCdnSrc)) {
    fail('the per-namespace digest sidecar is gone (a third-party server could never supply evidence)');
  }
  if (!/mergeVerified\(/.test(mainActivity) || !/MERGE_OK/.test(mainActivity)) {
    fail('namespace adoption no longer moves files per-file on MERGE_OK (stale bytes would be reused)');
  }
  if (!/recordArtSidecar\(/.test(mainActivity)) {
    fail('fetched bytes no longer record their sha256 into the sidecar (direction C evidence is lost)');
  }
  if (!/verifyAdoptedCached\(/.test(mainActivity)) {
    fail('adopted (inherited) cache bytes are no longer verified against the digest');
  }
  const transcodeSrc = fs.readFileSync(path.join(repo, 'tools', 'apk', 'transcode-assets.mjs'), 'utf-8');
  if (!/export function writeAssetDigests\(/.test(transcodeSrc)) {
    fail('writeAssetDigests is gone (the build no longer emits data/asset-digests.json)');
  }
  // 方向 A：缓存键 = 引用集合身份。三方（Java / 构建 / 页面）必须都能算出同一个键，否则命名空间会
  // 再次分裂、跨服共享失效。这里钉住三处实现都在。
  const prefetchSrc = fs.readFileSync(path.join(repo, 'tools', 'apk', 'extras', 'public', 'js', 'art-prefetch.js'), 'utf-8');
  if (!/setKeyForRels\(/.test(artCdnSrc)) {
    fail('ArtCdn.setKeyForRels is gone (the cache key is not a set identity any more)');
  }
  if (!/export function setKeyForRels\(/.test(transcodeSrc)) {
    fail('transcode-assets.mjs lost setKeyForRels — the build and the device would key namespaces differently');
  }
  if (!/function setKeyOf\(/.test(prefetchSrc)) {
    fail('art-prefetch.js lost setKeyOf — the page and the shell would key namespaces differently');
  }
}
console.log('check-apk: per-file evidence gates namespace adoption (table or sidecar) + inherited bytes verified');

// 8i) 浏览器缓存（审计 2026-10-09 阶段 4 / D5）：本地响应全部由本进程拦截器作答（不过网络），所以
// 「重新验证」几乎免费；反过来给可热更素材发 max-age=86400，就等于热更最多 24 小时不生效。预载侧同理：
// force-cache 会让 WebView 直接复用旧字节（清单也是），必须一律 no-store。
{
  // 只认「真的返回了 max-age」——注释里解释「不再给 max-age=86400」是文档，不是行为（首版断言
  // 把自家注释也当成违规，把 CI 打红了一次）。
  if (/return\s+"max-age/.test(mainActivity)) {
    fail('a local response is cached with max-age again (a hot update would not show for up to a day)');
  }
  if (!/private static String cacheControlFor\(String mime\)[\s\S]{0,400}?return "no-cache";/.test(mainActivity)) {
    fail('cacheControlFor no longer forces revalidation (hot-updatable bytes could be cached)');
  }
  for (const f of ['art-prefetch.js', 'preload-center.js']) {
    const src = fs.readFileSync(path.join(repo, 'tools', 'apk', 'extras', 'public', 'js', f), 'utf-8');
    if (/cache:\s*'force-cache'/.test(src)) {
      fail(`${f} uses force-cache again (the WebView would replay pre-hot-update bytes)`);
    }
  }
}
console.log('check-apk: local responses revalidate; the prefetch never uses the WebView HTTP cache');

// 8j) 自适应并发（审计 2026-10-09 阶段 5）：页面窗口的上限必须**等于** shell 的预取槽位数 —— 两者
// 不同步时，多出来的那几条只会等 300 ms 后失败重试（纯浪费）；而总并发必须**大于**预取上限，页面才
// 永远留得住自己的槽（「页面优先」这条不变量）。
{
  const walkSrc = fs.readFileSync(path.join(repo, 'tools', 'apk', 'extras', 'public', 'js', 'art-prefetch.js'), 'utf-8');
  const mw = /MAX_WINDOW\s*=\s*(\d+)/.exec(walkSrc);
  const ps = /ART_PREFETCH_MAX_PARALLEL\s*=\s*(\d+)/.exec(mainActivity);
  const ft = /ART_FETCH_MAX_PARALLEL\s*=\s*(\d+)/.exec(mainActivity);
  if (!mw || !ps || !ft) {
    fail('the adaptive-window / CDN-slot constants are gone (the page-first pairing cannot be checked)');
  } else {
    if (Number(mw[1]) !== Number(ps[1])) {
      fail(`art-prefetch MAX_WINDOW (${mw[1]}) != ART_PREFETCH_MAX_PARALLEL (${ps[1]}): the extra fetches would just time out`);
    }
    if (Number(ft[1]) <= Number(ps[1])) {
      fail(`ART_FETCH_MAX_PARALLEL (${ft[1]}) must exceed the prefetch allowance (${ps[1]}) so the page always keeps slots`);
    }
  }
}
console.log('check-apk: adaptive window matches the shell prefetch allowance (page keeps slots)');

// 8k) 预载游标的跨 origin 存储（审计 2026-10-09 附加 A）。localStorage 按 origin 隔离，而页面的 origin
// 就是当前连接的服务器 —— 切服就看不到游标，7969 条从头再走一遍。桥必须**成对**存在：只挂一个会让
// 页面以为可以跨 origin 存，实际写不进去。
{
  if (!/public String artWalkGet\(\)/.test(mainActivity)) {
    fail('artWalkGet() is gone (the walk record could not survive a server switch)');
  }
  if (!/public boolean artWalkPut\(String json\)/.test(mainActivity)) {
    fail('artWalkPut(String) is gone (the walk record could not be persisted cross-origin)');
  }
  const bridgeSrc = fs.readFileSync(path.join(repo, 'tools', 'apk', 'extras', 'public', 'js', 'shell-bridge.js'), 'utf-8');
  if (!/artWalkBridge\s*=/.test(bridgeSrc)) {
    fail('shell-bridge no longer publishes the artWalk capability flag');
  }
  const walkSrc = fs.readFileSync(path.join(repo, 'tools', 'apk', 'extras', 'public', 'js', 'art-prefetch.js'), 'utf-8');
  if (!/function shellStore\(\)/.test(walkSrc)) {
    fail('art-prefetch no longer reads the cross-origin record store');
  }
}
console.log('check-apk: the walk record survives a server switch (shell-side store wired)');

// 8l) 老默认值迁移（审计 2026-10-09：「进到服务器里面后依旧未读取到独有客户端 ui」的根因）。
// vc2006–vc2008 的内容侧把 remote-client-default=false 写进 SharedPreferences 且跨升级存活，
// 它会永远压过新默认值 → 本地客户端接管一切（连 /play 都不给服务器）。迁移必须在启动时跑，
// 且本版写入要带来源标记，否则下次升级又分不清「玩家选的」与「老版自动写的」。
{
  const policySrc = fs.readFileSync(path.join(shellSrc, 'RemoteClientPolicy.java'), 'utf-8');
  if (!/shouldDropLegacyDefault\(/.test(policySrc)) {
    fail('RemoteClientPolicy.shouldDropLegacyDefault is gone (a legacy false would pin the local client forever)');
  }
  if (!/PREF_DEFAULT_SRC\s*=\s*"remote-client-default-src"/.test(policySrc)) {
    fail('the default-value source marker key is gone (the next upgrade could not tell player vs legacy)');
  }
  if (!/shouldDropLegacyDefault\(/.test(mainActivity)) {
    fail('the startup migration is gone (upgraded devices would keep the local client)');
  }
  if (!/PREF_DEFAULT_SRC/.test(mainActivity)) {
    fail('setRemoteClientDefault no longer stamps the source marker');
  }
}
console.log('check-apk: legacy interface-source default is migrated at startup');

// 8m) 叠加层三个按钮在**服务器页面**上必须可用（业主 2026-10-09：「首页的叠加层（三个按钮）失效了，
// 点不了」，标为重要）。按钮的启用条件是 canPanels() = window.__SP_SHELL.openPanel 存在，而它由
// ui/shellPanels.js 定义；该文件此前只被 lobby.js 用**本地路径** import，服务器页面上会去服务器取（404）。
// 修法两头都要在：shell-bridge 用 /__sp/ 通道以 module 注入它，且 /__sp/ 服务端必须允许安全子路径。
{
  const bridgeSrc = fs.readFileSync(path.join(repo, 'tools', 'apk', 'extras', 'public', 'js', 'shell-bridge.js'), 'utf-8');
  if (!/__sp\/ui\/shellPanels\.js/.test(bridgeSrc)) {
    fail('shell-bridge no longer injects ui/shellPanels.js (the overlay buttons would be dead on server pages)');
  }
  if (!/typeof window\.__SP_SHELL\.openPanel === 'function'/.test(bridgeSrc)) {
    fail('the openPanel guard is gone (the module would be injected twice on a local page)');
  }
  if (!/ArtCdn\.isSafeRel\(name\)/.test(mainActivity)) {
    fail('serveShellAsset no longer accepts safe subpaths (/__sp/ui/… is unreachable, so openPanel never loads)');
  }
  // 只匹配**代码形态**（旧语句 `name.isEmpty() || name.indexOf('/') >= 0 …`）。第一版用宽松的
  // `/name\.indexOf\('\/'\)\s*>=\s*0/`，结果把**解释这条修复的注释**也匹配了，把 CI 打红一次 ——
  // 门禁绝不能扫自己的说明文字。
  if (/name\.isEmpty\(\)\s*\|\|\s*name\.indexOf\('\/'\)/.test(mainActivity)) {
    fail('serveShellAsset is back to flat-only (ui/shellPanels.js unreachable on any page)');
  }
}
console.log('check-apk: the overlay buttons can reach openPanel on a server page');

// 9) server-list freshness + advisor verdict (审计 §2). Three independent checks:
//   (a) manifest.servers.sha256 must describe the servers.json that ACTUALLY ships in assets —
//       gen-manifest used to hash tools/apk/shell/servers.json while build-webroot baked a
//       different copy, so the signed sha silently described a file the APK never contained;
//   (b) the baked list must not be stale (its ISO `updated` stamp within SERVERS_FRESH_DAYS);
//   (c) the baked list must not carry an advisor-invalidated entry (status invalid/pending). The
//       signed servers.json has no status field today, so this is skipped-with-a-note until the
//       publisher starts baking the verdict in.
const SERVERS_FRESH_DAYS = 7; // freshness ceiling for the baked baseline (ISO `updated` stamp)
const sha256Buf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const bakedServersBytes = fs.readFileSync(path.join(shellDir, 'servers.json'));
const bakedSha = sha256Buf(bakedServersBytes);
// (a) is a WARNING, not a gate: the CI build re-fetches the live list, so the baked bytes change
// every time the publisher updates servers.json while the committed manifest keeps the hash of the
// build that signed it. As an error this turned CI red on every list update (run 37200402900) and
// skipped the release/R2 steps behind it. The drift it was meant to catch — gen-manifest hashing a
// different file than build-webroot bakes — is now prevented inside gen-manifest itself, which
// prints `servers hash source:` and prefers the baked copy.
if (manifestDoc.servers?.sha256 !== bakedSha) {
  console.warn(
    `check-apk: manifest.servers.sha256 (${manifestDoc.servers?.sha256}) != sha256(assets/shell/servers.json) (${bakedSha})`
      + ' — expected after a live list update; re-run gen-manifest before publishing.',
  );
} else {
  console.log('check-apk: manifest.servers.sha256 matches the baked servers.json');
}
const serversUpdatedMs = Date.parse(serversDoc.updated || '');
if (Number.isFinite(serversUpdatedMs)) {
  const ageDays = (Date.now() - serversUpdatedMs) / 86400000;
  if (ageDays > SERVERS_FRESH_DAYS) {
    fail(`embedded servers.json is stale: updated ${serversDoc.updated} (${ageDays.toFixed(1)} days > ${SERVERS_FRESH_DAYS})`);
  }
  console.log(`check-apk: embedded servers.json is fresh (${ageDays.toFixed(1)} days ≤ ${SERVERS_FRESH_DAYS})`);
} else {
  console.warn(`check-apk: servers.json has no parseable updated stamp (${JSON.stringify(serversDoc.updated)}) — freshness skipped`);
}
const annotated = (serversDoc.servers || []).filter((s) => typeof s?.status === 'string' && s.status !== '');
if (!annotated.length) {
  console.warn('check-apk: embedded servers.json carries no per-entry status — invalid/pending gate skipped');
} else {
  const bad = annotated.filter((s) => s.status === 'invalid' || s.status === 'pending');
  if (bad.length) {
    fail(`embedded servers.json contains unavailable entries: ${bad.map((s) => `${s.id}=${s.status}`).join(', ')}`);
  }
  console.log(`check-apk: embedded servers.json has no invalid/pending entries (${annotated.length} annotated)`);
}

const size = fs.statSync(APK).size;
console.log(`check-apk: OK — ${(size / 1024 / 1024).toFixed(0)} MB @ ${APK}`);
/** Reads one entry out of the APK (bsdtar on Windows, unzip on POSIX). */
function readEntry(apk, entry) {
  if (process.platform === 'win32') {
    return execFileSync('C:/Windows/System32/tar.exe', ['-xOf', apk, entry], {
      encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
    });
  }
  return execFileSync('unzip', ['-p', apk, entry], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

function listEntries(apk) {
  const out = process.platform === 'win32'
    ? execFileSync('C:/Windows/System32/tar.exe', ['-tf', apk], { encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024 })
    : execFileSync('unzip', ['-l', apk], { encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024 });
  const set = new Set();
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (process.platform === 'win32') set.add(t);
    else {
      const m = /^\s*\d+\s+\S+\s+\S+\s+(.+)$/.exec(line);
      if (m && m[1] !== 'Name') set.add(m[1].trim());
    }
  }
  return set;
}
