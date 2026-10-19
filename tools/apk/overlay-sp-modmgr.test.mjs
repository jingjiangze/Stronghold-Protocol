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

import { DEFAULT_WORKSHOP_URL } from './overlay/sp-modmgr.mjs';

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

test('工坊：默认没有源 —— 抓取只走公开 https，http 目录不能被当默认值', () => {
  assert.equal(DEFAULT_WORKSHOP_URL, '', 'no http default: fetchHttps would refuse it, and weakening that is the SSRF gate');
  assert.ok(SRC.includes('SP_WORKSHOP_URL'), 'the owner configures it by environment');
  assert.ok(SRC.includes('WORKSHOP_OFF'), 'and the page says so instead of failing silently');
  assert.ok(pageScript().includes('没有配置工坊源'), 'the page names the reason in the owner\'s language');
  // 未配源时如实回，绝不假装有列表
  assert.ok(SRC.includes("error: 'WORKSHOP_OFF'"), 'the index says it is switched off');
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
