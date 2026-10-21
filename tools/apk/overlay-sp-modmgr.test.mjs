// overlay-sp-modmgr.test.mjs — /mod，本机 MOD 管理器（2026-10-19 业主：「内置的浏览器和 forge 改为
// MOD 管理器」；2026-10-20：界面放大 + 工坊接入 + 门禁拒绝不再是一句纯文本）。
//
//   node --test tools/apk/overlay-sp-modmgr.test.mjs
//
// 不联网、不装包：只读源码与页面字符串，以及用注入的 ctx 驱动 install()。联网的那一层
// （plugins/install.js 的 fetchHttps）由上游自己的测试守着，这里只钉住**我们新增的接缝**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_WORKSHOP_URL, WORKSHOP_INDEX_PATH, RAW_BASE, MANAGER_PAGE_URL } from './overlay/sp-modmgr.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));   // tools/apk
const repo = path.resolve(here, '..', '..');
const MODMGR = path.join(here, 'overlay', 'sp-modmgr.mjs');
const SRC = fs.readFileSync(MODMGR, 'utf8');

/** The inline page script (everything between the <script> tags of the PAGE constant). */
function pageScript() {
  const a = SRC.indexOf('</main><script>');
  const b = SRC.indexOf('</script></body>');
  assert.ok(a > 0 && b > a, 'the page carries an inline script');
  return SRC.slice(a + '</main><script>'.length, b);
}
function pageMarkup() {
  const a = SRC.indexOf('<a class="back"');
  const b = SRC.indexOf('</main><script>');
  assert.ok(a > 0 && b > a, 'the page carries its markup');
  return SRC.slice(a, b);
}

// ---------------------------------------------------------------- 2026-10-20：界面放大

test('界面放大（业主 2026-10-20「Mod 界面优化一下，放大一下」）：基准 17px + 触摸下限 44px', () => {
  assert.ok(SRC.includes('--sp-m-size:17px'), 'the base size went up from 14px');
  assert.ok(SRC.includes('min-height:44px'), 'buttons and inputs meet the touch minimum');
  // 旧版固定的小字号不应残留
  for (const small of ['font-size:12px', 'font-size:13px', 'font:14px/1.55']) {
    assert.ok(!SRC.includes(small), 'a fixed small size came back: ' + small);
  }
  // 表格与结果区跟着放大（表格原来是 12px，结果区固定 360px 高）
  assert.ok(/table\{[^}]*clamp\(14px/.test(SRC), 'the installed table scales up');
  assert.ok(SRC.includes('max-height:52vh'), 'the result box grew (was a fixed 360px)');
  // 手机上表格横向可滚，不被挤成一团
  assert.ok(SRC.includes('overflow-x:auto'), 'the table scrolls sideways on a phone');
  // 标题也是相对的（不是写死 20px）
  assert.ok(/h1\{[^}]*clamp\(22px/.test(SRC), 'the title scales');
});

// ---------------------------------------------------------------- 2026-10-20：门禁拒绝要说人话

test('门禁拒绝不再是「一行纯文本」—— 给出来访地址与 Host，玩家自己能核对', () => {
  assert.ok(SRC.includes('function modGatePage'), 'a real page answers a refused request');
  // 上游的 why 只进日志，绝不回客户端（那是内部判据）
  assert.ok(!/modGatePage\(gate\)[\s\S]{0,200}gate\.why/.test(SRC), 'the refusal reason stays in the log');
  // 来访地址与 Host 是**服务端**填进页面的（页面自己看不到 socket）— 断言看模块源码。
  assert.ok(SRC.includes('req.socket.remoteAddress'), 'the server hands the peer address to the page');
  assert.ok(SRC.includes('req.headers.host'), 'and the Host that was asked for');
  const gateFn = SRC.slice(SRC.indexOf('function modGatePage'), SRC.indexOf('function statusRows'));
  assert.ok(!gateFn.includes('.why'), 'modGatePage never echoes the refusal reason (that stays in the log)');
  // 拒绝仍然是 404（与 /studio 同口径：不暴露存在性）
  assert.ok(/text\(res, 404, modGatePage\(/.test(SRC), 'a refusal is still a 404');
  assert.ok(SRC.includes('先到主界面点「启动本机服务」'), 'it names the one thing the player can do');
});

// ---------------------------------------------------------------- 2026-10-20：工坊

test('工坊：走本服务代理（页面连不到那台主机），且只认公开 https', () => {
  // 页面绝不直连工坊主机 —— 混合内容/CORS，而且本机服务是 http 页
  assert.ok(pageScript().includes("fetch('/mod/workshop.json'"), 'the page goes through OUR proxy');
  assert.ok(!/fetch\(\s*['"]https?:\/\/[^'"]*\/api\/mods/.test(SRC), 'the page must not dial the catalogue itself');
  // 下载走上游 install.js 的 fetchHttps（私网/非 https 一律拒）—— 不自己再造一遍校验
  assert.ok(SRC.includes('installMod.fetchHttps'), 'the download reuses upstream fetchHttps (the SSRF gate)');
  // 上游的 URL 闸门只被引用，不重写（重写 = 自己开一个 SSRF 口子）
  const fetchImpl = SRC.slice(SRC.indexOf('async function workshopFetch'), SRC.indexOf('const changeAllowed'));
  assert.ok(fetchImpl.includes('installMod.fetchHttps'), 'the download is upstream fetchHttps');
  assert.ok(!/function\s+isCatalogUrl/.test(SRC), 'we do not redefine the upstream URL gate');
  // 两个端点：只读列表 + 需要钥匙的安装
  assert.ok(SRC.includes("pathname === '/mod/workshop.json'"), 'the read-only index route');
  assert.ok(SRC.includes("pathname === '/mod/workshop-install'"), 'the install route');
  const wsInstall = SRC.slice(
    SRC.indexOf("if (pathname === '/mod/workshop-install')"),
    SRC.indexOf("if (pathname === '/mod' || pathname === '/mod/')"));
  assert.ok(wsInstall.includes('changeAllowed(req)'), 'the install is same-origin only');
  assert.ok(wsInstall.includes('keyOk(req)'), 'the install needs the owner key');
  assert.ok(wsInstall.includes('importArchive('), 'the install reuses the ONE loading chain');
});

// 2026-10-20：默认源从「空」改成**线上 mod 站**（审计实测：GH Pages 200 + ACAO:* + 支持 Range，
// 且它 sert 的 mods.json 每条都带绝对 download URL）。原来的「空默认」是因为当时只找到一个 http
// 目录，而下载必须过上游 fetchHttps 的 https 闸门 —— 现在有 https 站了，就不再让业主手配。
test('工坊默认源 = 线上 mod 站（https + 带 download 直链的那份）', () => {
  // 业主 2026-10-21：「最新的 Mod 源和 Mod 管理器换成这个」。实测该站 /mods.json 44 条、
  // generatedAt 2026-10-21，比它替换掉的 GH Pages 镜像（30 条）更新更全。
  assert.equal(DEFAULT_WORKSHOP_URL, 'https://mod.jiangjiangze.icu', 'the CF mainline, per the owner 2026-10-21');
  assert.equal(MANAGER_PAGE_URL, 'https://mod.jiangjiangze.icu/manager', 'the manager download page lives there too');
  assert.equal(WORKSHOP_INDEX_PATH, '/mods.json', 'the UI-facing catalogue (not the repo\'s authoritative index)');
  assert.equal(RAW_BASE.startsWith('https://'), true, 'the raw fallback is https too');
  assert.ok(SRC.includes('SP_WORKSHOP_URL'), 'the owner can still override by environment');
  assert.ok(SRC.includes('WORKSHOP_OFF'), 'and switching it off is still honoured');
  assert.ok(SRC.includes("error: 'WORKSHOP_OFF'"), 'the index says it is switched off');
  // 只认 https 这条不能松：它同时也是 SSRF 门（守门的是上游 fetchHttps，见下两条）
  assert.ok(SRC.includes('installMod.fetchHttps(target,'), 'the download still goes through upstream fetchHttps');
  assert.ok(!/^\s*fetch\(target/m.test(SRC), 'a raw fetch of the catalogue URL must never appear');
});

test('工坊字段映射对真实站点（category/sizeBytes/download/assets），不是猜的字段名', () => {
  // 站点两份索引字段名不同：页面版 {category,sizeBytes,download}、仓内版 {category,sizeBytes,path,assets}
  // 早先的实现读 kind/size/suspected —— 全都不存在，会把整列显示成空，下载还去拼一个不存在的
  // /api/file/<id>（站点载荷其实是 mods/<id>/<ver>/mod.zip）。
  assert.ok(/m\.category \|\| m\.kind/.test(SRC), 'category first, kind as the legacy alias');
  assert.ok(/m\.sizeBytes/.test(SRC), 'sizeBytes first, size as the legacy alias');
  assert.ok(/m\.download/.test(SRC), 'the absolute download URL is read from the entry');
  assert.ok(/RAW_BASE \+ String\(m\.path\)/.test(SRC), 'or rebuilt from the repo-relative path');
  assert.ok(/assets\.assetFree === false/.test(SRC), '"有风险" comes from the entry\'s own asset flag');
  // install 接口收 URL（服务端不再按 id 猜路径）
  assert.ok(/const url = typeof parsed\?\.url === 'string'/.test(SRC), 'workshop-install takes the entry URL');
  assert.ok(!/base \+ '\/api\/file\/'/.test(SRC), 'the invented /api/file/<id> path is gone');
});

test('卸载：改名到 _removed（不删）、required 拒卸、有房间在用拒卸', () => {
  assert.ok(SRC.includes("pathname === '/mod/uninstall'"), 'the uninstall route exists');
  assert.ok(SRC.includes("movePluginAside(pluginsDir, id, '_removed')"),
    'it reuses the upstream primitive (rename, never rmSync)');
  assert.ok(!/rmSync\(dir|rmSync\(dest/.test(SRC), 'a hard delete of the plugin folder must not appear');
  assert.ok(SRC.includes('PLUGIN_IN_USE'), 'a room using the plugin blocks the uninstall');
  assert.ok(SRC.includes('PLUGIN_BLOCKED'), 'a required plugin blocks the uninstall');
  assert.ok(/\/\^\[A-Za-z0-9\._-\]\+\$\/\.test\(id\)/.test(SRC), 'the id is shape-checked');
  assert.ok(SRC.includes("path.dirname(dir) !== pluginsDir"), 'and traversal-checked');
  assert.ok(SRC.includes('PLUGIN_BAD_ID'), 'both failures answer with a code');
  // 顺手把 id 从 default 摘掉，否则新房间会拿着不存在的 id 去 setPlugins
  assert.ok(/current\.filter\(\(x\) => x !== id\)/.test(SRC), 'the plugin is dropped from the room default');
});

test('overlay 契约：导出 id（overlay-loader 读的就是它）', () => {
  // 早先这里是 OVERLAY_ID，overlay-loader.mjs 读 mod.id ⇒ 拿不到，handshake 里退化成文件名。
  // 不影响功能，但与其余五个 overlay 的约定不一致。
  assert.ok(/export const id = 'sp-modmgr';/.test(SRC), 'the loader-visible id export');
  assert.ok(/export const OVERLAY_ID = id;/.test(SRC), 'the old name stays as an alias, not a second truth');
  assert.ok(SRC.includes('inboxAuto: false'), 'inbox is counted, NOT auto-imported (no watcher here)');
  // 2026-10-21：入口指向站上的管理器下载页，且必须新标签 + noopener（直接跳会丢掉本页）
  assert.ok(SRC.includes("window.open('https://mod.jiangjiangze.icu/manager','_blank','noopener,noreferrer')"),
    'the manager link opens in a new tab with noopener/noreferrer');
  assert.ok(SRC.includes('给 PC / 自建服务器用'), 'and the copy says WHO it is for (the APK already has one)');
  // 兼容改写版与「有风险」分开标注，不混为一谈
  assert.ok(/compat: !!\(m && m\.isCompat\)/.test(SRC), 'isCompat is carried through as its own flag');
  assert.ok(SRC.includes('兼容改写版'), 'and rendered as its own badge');
});

// ---------------------------------------------------------------- 既有契约（不得回归）

test('/mod 的两条装载链与三道门（钥匙 / 同源 / 网络位置）', () => {
  assert.ok(SRC.includes('forgeMod.importForge'), 'a Forge pack goes through upstream forgeImport');
  assert.ok(SRC.includes('installMod.installPluginBytes'), 'a plugin zip goes through upstream installPluginBytes');
  assert.ok(SRC.includes("detail: 'zip 里既没有 pack.json 也没有 plugin.json'"), 'anything else is refused');
  assert.ok(SRC.includes('gateMod.studioAllowed'), 'the studio network gate (this machine or the LAN)');
  assert.ok(SRC.includes('keyMod.loadStudioKey'), 'the owner key');
  assert.ok(SRC.includes('const changeAllowed'), 'same-origin on writes');
});

test('插件列表取 packs（插件注册表），不是会话注册表 —— 否则列表恒空', () => {
  assert.ok(SRC.includes('ctxServer.packs || ctxServer.registry'), 'the plugin registry comes first');
  assert.ok(!SRC.includes('const registry = ctx.server.registry || null;'), 'the old session-registry bug is gone');
});

test('页面自包含：无外链脚本/样式，且 escapeless 写法不再往表格里塞未转义的 id', () => {
  assert.ok(!/<script[^>]+src=/.test(SRC), 'no external script');
  assert.ok(!/<link[^>]+href=/.test(SRC), 'no external stylesheet');
  assert.ok(/const esc\s*=/.test(pageScript()), 'the page keeps an esc() helper');
  // 拼进 innerHTML 的值必须先过 esc()：插件清单（p.*）与远端目录（m.*）都不可信
  for (const raw of ['+p.id+', '+p.name+', '+p.version+', '+p.class+', '+p.status+', '+m.id+', '+m.name+', '+m.version+']) {
    assert.ok(!pageScript().includes(raw), 'an unescaped field went into innerHTML: ' + raw);
  }
  // 而 esc() 的结果可以直接拼（name/meta 是本地已转义的副本）
  assert.ok(pageScript().includes('esc(p.name)'), 'the installed table escapes the plugin name');
  assert.ok(pageScript().includes('esc(m.name'), 'the workshop list escapes the remote name');
  assert.ok(/const name\s*=\s*esc\(/.test(pageScript()), 'the row name is an escaped copy');
});
