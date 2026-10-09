// fonts.test.mjs — 字体来源门禁（业主口径 2026-10-09）：
//   「字体：本地服务走本地，走服务器上走服务器，CDN 仅作为本地下载源」。
//
// 这份测试守三件事：
//   1. 本地字体表真实存在、**只引用同源 /fonts/**（运行时不出现任何第三方 host）；
//   2. 表里写到的文件都真的在 extras 里（不允许死链 —— 死链会静默掉回系统字体，没人发现）；
//   3. Java 侧的接线形状：字体主机分支必须经 RemoteClientPolicy.fontFromLocalTable 判定，
//      本地表路径必须是 /fonts/webfonts-local.css（改了常量名或绕过门 → 这里红）。
//
// 纯静态检查（不起 WebView、不联网）：Extras 目录 + MainActivity.java 文本。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const fontsDir = path.join(repo, 'tools', 'apk', 'extras', 'public', 'fonts');
const cssPath = path.join(fontsDir, 'webfonts-local.css');
const javaPath = path.join(repo, 'android', 'app', 'src', 'main', 'java', 'icu',
  'jiangjiangze', 'stronghold', 'MainActivity.java');
const policyPath = path.join(repo, 'android', 'app', 'src', 'main', 'java', 'icu',
  'jiangjiangze', 'stronghold', 'RemoteClientPolicy.java');

const read = (p) => fs.readFileSync(p, 'utf-8');
const norm = (p) => read(p).replace(/\r\n/g, '\n');

test('本地字体表存在且为纯 ASCII（extras 纪律：中文只能走 \\u 转义；CSS 注释也不放非 ASCII）', () => {
  assert.ok(fs.existsSync(cssPath), `缺少本地字体表：${cssPath}`);
  const bytes = fs.readFileSync(cssPath);
  for (const b of bytes) {
    assert.ok(b < 0x80, `webfonts-local.css 含非 ASCII 字节 0x${b.toString(16)}（extras 纪律）`);
  }
});

test('字体表只引用同源 /fonts/**（运行时不出现任何第三方 host —— CDN 仅作为下载源）', () => {
  const css = norm(cssPath);
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/['"]/g, '').trim());
  assert.ok(urls.length >= 14, `字体表里 url() 太少（${urls.length}）—— 表被截断了？`);
  for (const u of urls) {
    assert.ok(u.startsWith('/fonts/'), `字体表引用了非同源地址：${u}`);
    assert.ok(!/^[a-z]+:\/\//i.test(u), `字体表引用了绝对 URL（含第三方 host）：${u}`);
    assert.ok(!u.includes('//'), `字体表引用了协议相对地址：${u}`);
  }
  // 反向断言：表里不许出现任何字体 CDN 主机名（注释里说明原因可以，但不能出现在引用里）。
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(urls.join('\n')),
    '字体表的 url() 里出现了 Google 字体主机');
});

test('字体表写到的每个文件都真实存在（死链会静默掉回系统字体）', () => {
  const css = norm(cssPath);
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/['"]/g, '').trim());
  for (const u of urls) {
    const f = path.join(fontsDir, u.replace('/fonts/', ''));
    assert.ok(fs.existsSync(f), `字体表引用的文件不存在：${f}`);
  }
});

test('字体文件是真正的 woff2（magic wOF2）且 Oxanium/Rajdhani 各权重齐全', () => {
  const css = norm(cssPath);
  const families = [...css.matchAll(/font-family:'([^']+)'/g)].map((m) => m[1]);
  const uniq = [...new Set(families)].sort();
  assert.deepEqual(uniq, ['Oxanium', 'Rajdhani'],
    `只应自托管 Oxanium/Rajdhani（Noto Sans SC 走系统兜底）—— 实得 ${uniq.join(', ')}`);
  // 上游 index.html 请求的权重：Oxanium 400/500/600/700、Rajdhani 500/600/700。
  for (const w of ['Oxanium:400', 'Oxanium:500', 'Oxanium:600', 'Oxanium:700',
    'Rajdhani:500', 'Rajdhani:600', 'Rajdhani:700']) {
    const [fam, weight] = w.split(':');
    assert.ok(new RegExp(`font-family:'${fam}';font-style:normal;font-weight:${weight}(?=;)`, 'i').test(css)
      || new RegExp(`font-family: '${fam}';[\\s\\S]{0,80}font-weight: ${weight};`, 'i').test(css),
      `字体表缺少 ${fam} ${weight}`);
  }
  const files = fs.readdirSync(fontsDir).filter((n) => n.endsWith('.woff2'));
  assert.ok(files.length >= 14, `woff2 文件太少：${files.length}`);
  for (const n of files) {
    const head = fs.readFileSync(path.join(fontsDir, n)).subarray(0, 4).toString('latin1');
    assert.equal(head, 'wOF2', `${n} 不是 woff2（magic=${head}）`);
  }
});

test('Java 接线：字体主机分支必须走 fontFromLocalTable 门，本地表路径必须是 /fonts/webfonts-local.css', () => {
  const java = norm(javaPath);
  // 常量：本地表路径（不要写死在别处）
  assert.match(java, /LOCAL_FONT_CSS\s*=\s*"\/fonts\/webfonts-local\.css"/,
    'MainActivity 必须有 LOCAL_FONT_CSS = "/fonts/webfonts-local.css"');
  // 门：CSS 主机分支必须先问策略，且用的是 pageServedFromLocalTree（页面来源）
  const cssBranch = java.slice(java.indexOf('FONT_CSS_HOST.equals(host)'));
  assert.ok(cssBranch.length > 0, '字体 CSS 主机分支不见了');
  assert.match(cssBranch.slice(0, 1200),
    /RemoteClientPolicy\.fontFromLocalTable\(pageServedFromLocalTree\)/,
    '字体 CSS 主机分支必须经 RemoteClientPolicy.fontFromLocalTable(pageServedFromLocalTree)');
  assert.match(cssBranch.slice(0, 1200), /openLocal\(LOCAL_FONT_CSS\)/,
    '字体 CSS 主机分支必须从本地树取表（openLocal(LOCAL_FONT_CSS)）');
  // 兜底仍在：本地表取不到 → 空表
  assert.match(cssBranch.slice(0, 1600), /return emptyCss\(\);/,
    '字体分支必须保留 emptyCss() 兜底（本地表取不到时）');
  // 第三方 CDN 接受（业主 2026-10-09 追加口径）：**服务器页面**上的字体请求放行，不再替对方决定。
  assert.match(cssBranch.slice(0, 400), /if \(!RemoteClientPolicy\.fontFromLocalTable\(pageServedFromLocalTree\)\) return null;/,
    '服务器页面的字体请求必须放行（第三方 CDN 接受）—— 门为假时直接 return null');
  // 两个字体主机必须走同一条分支（否则 gstatic 会漏过「放行」那条口径）
  assert.match(java, /if \(FONT_CSS_HOST\.equals\(host\) \|\| FONT_FILE_HOST\.equals\(host\)\)/,
    'fonts.googleapis.com 与 fonts.gstatic.com 必须走同一条字体分支');
});

test('别名：该 host 上的 /fonts/** 必须映射回本地树（CSS 相对地址按样式表 URL 解析，漏了这条字体静默失效）', () => {
  // 这是本方案最容易静默坏掉的一环：表是从 fonts.googleapis.com 的 URL 上回来的，浏览器会把表里的
  // `url('/fonts/x.woff2')` 解析成 https://fonts.googleapis.com/fonts/x.woff2 —— 必须在该分支里就地映射回
  // 本地树的同路径，否则字体 404（回空表）→ 静默掉回系统字体，没有任何报错。
  const java = norm(javaPath);
  const branch = java.slice(java.indexOf('FONT_CSS_HOST.equals(host)'));
  const head = branch.slice(0, 1600);
  assert.match(head, /url\.getPath\(\)/, '别名分支必须读请求路径（url.getPath()）');
  assert.match(head, /startsWith\("\/fonts\/"\)/, '别名分支必须判定 /fonts/ 前缀');
  assert.match(head, /openLocal\(fontPath\)/, '别名分支必须从本地树取同路径（openLocal(fontPath)）');
  // 别名必须在「回表」之前：反过来的话请求 /fonts/*.woff2 会拿到 text/css，字体照样不生效。
  const aliasAt = head.indexOf('openLocal(fontPath)');
  const tableAt = head.indexOf('openLocal(LOCAL_FONT_CSS)');
  assert.ok(aliasAt >= 0 && tableAt >= 0 && aliasAt < tableAt,
    '别名判定必须排在「回本地表」之前（否则 woff2 请求会被回成 CSS 文本）');
  // 别名只在「页面来自本地树」时生效（服务器页面不得吃我们的字体）
  assert.match(head, /fontFromLocalTable\(pageServedFromLocalTree\)[\s\S]{0,900}?openLocal\(fontPath\)/,
    '别名必须被 fontFromLocalTable 门包住');
  // 响应 MIME 必须按路径推断（woff2 → font/woff2），不能写死 text/css
  assert.match(head, /mimeFor\(fontPath\)/, '别名响应必须用 mimeFor(fontPath) 推断字体 MIME');
});

test('策略门两个方向都可分辨（防退化为常量）', () => {
  const policy = norm(policyPath);
  assert.match(policy, /public static boolean fontFromLocalTable\(boolean pageFromLocalTree\)/,
    'RemoteClientPolicy 必须有 fontFromLocalTable(boolean)');
  assert.match(policy, /CDN 仅作为本地下载源/, '策略注释必须写明口径来源');
});

test('上游文件未被改动：index.html 里仍是 Google CSS 引用（本方案不改上游，靠拦截器接管）', () => {
  // 这条是「零上游冲突」的守卫：我们的做法是运行时接管，不是编辑上游 index.html。
  // 一旦有人为了"干净"去改上游文件的 <link>，这里必须红 —— 那会破坏 upstream 跟随。
  const idx = 'public/index.html';
  const p = path.join(repo, idx);
  assert.ok(fs.existsSync(p), `缺少 ${idx}`);
  const html = norm(p);
  assert.match(html, /fonts\.googleapis\.com/, '上游 index.html 的 Google 字体 <link> 不应被我们改动');
  assert.match(html, /\/fonts\/fonts\.css/, '上游 index.html 仍应引用本地 Bender/Novecento 表');
});
