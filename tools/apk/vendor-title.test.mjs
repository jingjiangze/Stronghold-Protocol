// vendor-title.test.mjs — GATE-R4 (vendor 副本：上游基线同步门 + ops 断言 + 加载机制契约).
//
// 背景：re 线首页原先是 home-layer.js 在上游标题屏上叠一层控件；本任务把「旧线 2.9.31 那份打过补丁的
// title.js/title.css」作为**我方副本**放进 extras（同名覆盖上游路径），让页面直接加载我们的副本，
// 上游仓库文件一个字节都不改。
//
// 这个门守三件事：
//   1) **上游基线同步门**：副本是从上游 0.2.1 的 title.js/title.css 逐条套 ops 得到的。上游一旦改了
//      这两个文件（本仓库 public/ 是上游 fork 的同一份文件），基线 sha256 就变，本测试**大声失败**，
//      要求人工同步副本 —— 这是「上游改了标题屏，我们的副本不会自动跟上」的唯一自动发现手段。
//      重算：node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('public/js/screens/title.js')).digest('hex'))"
//   2) **ops 断言**：副本必须带着判定为「要套」的 2.9.31 ops 的产物（.title-side / .title-room__cfg /
//      .title-foot__update / .title-duo / 本地服务状态机 / 观战横幅 …），且上游 0.2.1 的原生特征
//      （LangToggle / .title-dev / SettingsModal / .title-settings 齿轮 / .title-conn / .title-foot）
//      一个都没被破坏。
//   3) **差异可枚举**：副本里**缺失的上游原文行**必须恰好是那 5 行「被 ops 改写的锚点」，CSS 侧一行
//      都不能缺（只允许纯追加）。任何多出来的丢失都会红 —— 防止有人手改副本时顺手删了上游逻辑。
//
// 另有加载机制契约：extras/public 同名覆盖上游路径，APK 内嵌树（build-webroot）与 filesDir 热更树
// （Updater.applyExtras）两条链都拿到副本，MainActivity.openLocal 先热更树后 APK 兜底，零 Java 改动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const VENDOR_JS = path.join(here, 'extras', 'public', 'js', 'screens', 'title.js');
const VENDOR_CSS = path.join(here, 'extras', 'public', 'css', 'screens', 'title.css');
const UPSTREAM_JS = path.join(repo, 'public', 'js', 'screens', 'title.js');
const UPSTREAM_CSS = path.join(repo, 'public', 'css', 'screens', 'title.css');

const read = (p) => fs.readFileSync(p, 'utf8');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * 上游基线（本副本的派生起点）。**上游改了标题屏就把这两个常量连同副本一起更新**：
 *   1. 重跑逐条 ops 判定（哪些还能原样套 / 哪些锚点变了要改写 / 哪些上游已原生实现 / 哪些废弃）；
 *   2. 按判定更新 tools/apk/extras/public/{js,css}/screens/title.*（含文件头的来源与差异清单）；
 *   3. 刷新这里与副本文件头里的 sha256。
 * 上游 tag/commit: v0.2.1 / c2a2ef778cf728ff29b953b9842b2a39b1e9cbea
 */
const BASELINE = {
  js: { sha256: '53c72a2268e03bc043b63c30b44f840bbdd8bd9542ef754a3012a0ab66a4a9b7', bytes: 13940 },
  css: { sha256: '9f8a8e326b103304400b2ced438605ea6cecaae658ac01d87f09a8f8dae8d565', bytes: 10827 },
};

/** 丢掉文件头注释块（// 行、块注释、空行），只比较正文。
 *  副本的文件头是有意改写的「来源 / ops / 差异」说明，不算上游原文。 */
function bodyLines(text) {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === '') { i++; continue; }
    if (l.startsWith('//')) { i++; continue; }
    if (l.startsWith('/*')) {
      let j = i;
      while (j < lines.length && !lines[j].includes('*/')) j++;
      i = j + 1;
      continue;
    }
    break;
  }
  return lines.slice(i);
}

/** 上游正文里「副本中完全找不到」的非空行（改写/删除都算）。 */
function missingUpstreamLines(upstreamText, copyText) {
  const up = bodyLines(upstreamText);
  const copy = copyText;
  return up.filter((l) => l.trim() !== '' && !copy.includes(l));
}

// ---- 1) 文件存在 ------------------------------------------------------------------------------
test('vendor 副本存在（extras 同名覆盖上游路径）', () => {
  assert.ok(fs.existsSync(VENDOR_JS), 'tools/apk/extras/public/js/screens/title.js missing');
  assert.ok(fs.existsSync(VENDOR_CSS), 'tools/apk/extras/public/css/screens/title.css missing');
  assert.ok(fs.existsSync(UPSTREAM_JS) && fs.existsSync(UPSTREAM_CSS), 'upstream title.js/title.css missing');
});

// ---- 2) 上游基线同步门 ------------------------------------------------------------------------
test('上游基线同步门：public/ 的 title.js/title.css 仍是本副本的派生起点（变了就人工同步）', () => {
  const js = sha256(UPSTREAM_JS);
  const css = sha256(UPSTREAM_CSS);
  assert.equal(
    js, BASELINE.js.sha256,
    `上游 public/js/screens/title.js 变了（sha256 ${js} ≠ 基线 ${BASELINE.js.sha256}）。`
    + ' 我们的 vendor 副本不会自动跟上：请重做逐条 ops 判定、更新 '
    + 'tools/apk/extras/public/js/screens/title.js 与文件头，再刷新 BASELINE。',
  );
  assert.equal(
    css, BASELINE.css.sha256,
    `上游 public/css/screens/title.css 变了（sha256 ${css} ≠ 基线 ${BASELINE.css.sha256}）。`
    + ' 同上：人工同步 vendor 副本 + 刷新 BASELINE。',
  );
  assert.equal(fs.statSync(UPSTREAM_JS).size, BASELINE.js.bytes);
  assert.equal(fs.statSync(UPSTREAM_CSS).size, BASELINE.css.bytes);
});

test('副本文件头自证来源：记录同一个上游基线 sha256（漂移一眼可见）', () => {
  const js = read(VENDOR_JS);
  const css = read(VENDOR_CSS);
  for (const [name, src, sum] of [['title.js', js, BASELINE.js.sha256], ['title.css', css, BASELINE.css.sha256]]) {
    assert.ok(src.includes(sum), `${name} 文件头缺少上游基线 sha256 ${sum}`);
    assert.match(src, /v0\.2\.1/, `${name} 文件头缺少 upstream tag v0.2.1`);
    assert.match(src, /c2a2ef77/, `${name} 文件头缺少 upstream commit`);
    assert.match(src, /shell-v2\.9\.31/, `${name} 文件头缺少补丁来源 tag shell-v2.9.31`);
    assert.match(src, /vendor-title\.test\.mjs/, `${name} 文件头缺少同步方法（指向本测试）`);
  }
});

// ---- 3) ops 断言：2.9.31 的产物都在 ------------------------------------------------------------
test('title.js 副本带着判定为「要套」的 ops 产物（用户口径覆盖后）', () => {
  const src = read(VENDOR_JS);
  const need = [
    // v3.5 op0：useEffect 必须进 import（访客数 / autostart 都靠它）
    ["import { useEffect, useMemo, useState } from '../../vendor/hooks.module.js';", 'v3.5 op0 hooks import'],
    // v2.2 op3 + v2.3 + v3.0 + v3.5 op7：侧栏按钮组
    ['<div class="title-side">', 'v2.2 op3 .title-side'],
    ['class="title-room__cfg"', 'v2.3/v3.0/v3.5 .title-room__cfg'],
    // v2.2 op2 + v4.5 op0：状态行包进 .title-conn__sw 且无操作
    ['class="title-conn__sw"', 'v2.2 op2 .title-conn__sw'],
    ['onClickCapture=${(e) => e.stopPropagation()}', 'v4.5 op0 吞冒泡'],
    // v3.5 op2：shell 辅助（口径 O2 删掉了 LOCAL_POLL_MS / localServiceReady）
    ['function readProfileName()', 'v3.5 readProfileName'],
    ['function openShellPanel(kind)', 'v3.5 openShellPanel'],
    // v3.5 op3：代号预填
    ['|| readProfileName() ||', 'v3.5 op3 代号预填'],
    // v3.6 op1：一键进服消费端（口径 O2/O6 保留 —— 「进入」现在只走这里）
    ['window.shell.takeAutostart', 'v3.6 op1 takeAutostart'],
    ['}, 400);', 'v3.6 op1 400ms 自动进入'],
    // v5.2：访客数
    ['window.__SP_LOBBY.visitorsCached', 'v5.2 op0 visitorsCached'],
    ['window.__SP_LOBBY.fetchVisitors', 'v5.2 op0 fetchVisitors'],
    ['· 大厅 ${visitors} 人', 'v5.2 op1 访客数显示'],
    // v5.6：观战邀请
    ['const pendingSpectate = useStore((s) => s.ui.pendingSpectate === true);', 'v5.6 op0 pendingSpectate'],
    ["t('收到观战邀请')", 'v5.6 op1 观战文案'],
    // v3.3 op0：页脚 meta + 检查更新
    ['<span class="title-foot__meta">', 'v3.3 op0 .title-foot__meta'],
    ['class="title-foot__update"', 'v3.3 op0 .title-foot__update'],
    ['window.__SP_SHELL.checkUpdate', 'v3.3 op0 checkUpdate 桥'],
    // 与 home-layer 互斥
    ["window.__SP_TITLE_VENDORED = 'shell-v2.9.31';", 'vendored 标记（home-layer 让位）'],
  ];
  for (const [needle, what] of need) {
    assert.ok(src.includes(needle), `title.js 副本缺少 ${what}：${JSON.stringify(needle)}`);
  }
});

// ---- 3b) 用户口径覆盖（2026-10-08 追加）------------------------------------------------------
test('口径：侧栏最终控件表 = 设置/参数/配置/战绩/大厅（文案 + 动作逐条断言）', () => {
  const src = read(VENDOR_JS);
  const room = /<div class="title-room">([\s\S]*?)<\/div>` : null}/.exec(src);
  assert.ok(room, '找不到 .title-room 按钮组');
  const rows = [...room[1].matchAll(/<button[\s\S]*?<\/button>/g)].map((m) => ({
    act: /data-sp-title-btn="([a-z]+)"/.exec(m[0])[1],
    text: /([^<>]+)<\/button>$/.exec(m[0])[1].trim(),
  }));
  assert.deepEqual(
    rows,
    [
      { act: 'settings', text: '设置' },
      { act: 'params', text: '参数' },
      { act: 'config', text: '配置' },
      { act: 'records', text: '战绩' },
      { act: 'servers', text: '大厅' },
    ],
    '侧栏控件表与口径不符（顺序 / 文案 / data-sp-title-btn 都必须一致）',
  );
  // 口径 O5：设置开的是我们自己的外观面板，**不是**上游设置弹窗
  assert.ok(
    src.includes('data-sp-title-btn="settings" onClick=${() => openShellPanel(\'appearance\')}'),
    '口径 O5：设置必须 openShellPanel(\'appearance\')，不再 setSettingsOpen(true)',
  );
  assert.ok(!/data-sp-title-btn="settings"[^>]*setSettingsOpen/.test(src), '设置按钮不许再开上游设置弹窗');
  // 口径 O4：大厅只改文案，动作是 openPanel('servers')
  assert.ok(
    src.includes('data-sp-title-btn="servers" onClick=${() => openShellPanel(\'servers\')}>大厅'),
    '口径 O4：大厅必须 openShellPanel(\'servers\')',
  );
  // 侧栏只该有这 5 个按钮，且没有全屏
  assert.equal(room[1].split('<button').length - 1, 5, '侧栏按钮数必须是 5');
});

test('口径 O7：六个控件都带稳定属性 data-sp-title-btn（每个 act 恰好一次）', () => {
  const body = bodyLines(read(VENDOR_JS)).join('\n');
  const acts = [...body.matchAll(/data-sp-title-btn="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    acts.slice().sort(),
    ['config', 'params', 'records', 'servers', 'settings', 'update'],
    `data-sp-title-btn 必须恰好是这 6 个（各一次），实际：${JSON.stringify(acts)}`,
  );
  for (const act of ['settings', 'params', 'config', 'records', 'servers', 'update']) {
    assert.equal(acts.filter((a) => a === act).length, 1, `data-sp-title-btn="${act}" 必须恰好出现一次`);
  }
  // 页脚检查更新也带属性（口径 O7）
  assert.ok(
    /class="title-foot__update" data-sp-title-btn="update"/.test(body),
    '页脚「检查更新」必须带 data-sp-title-btn="update"',
  );
  // 侧栏按钮的属性写在 class 之后、onClick 之前（外部脚本只认属性，不认文案/类名）
  for (const act of ['settings', 'params', 'config', 'records', 'servers']) {
    assert.ok(
      new RegExp(`class="title-room__cfg" data-sp-title-btn="${act}"`).test(body),
      `侧栏 ${act} 按钮的属性位置变了：${act}`,
    );
  }
});

test('口径 O1/O2/O3/O6：全屏 / 本地服务 / 进入线上 / .title-duo 全部删净（含 import，不留 unused）', () => {
  const body = bodyLines(read(VENDOR_JS)).join('\n');
  const gone = [
    ['title-duo', '口径 O6：.title-duo 整块必须删掉'],
    ['title-local', '口径 O2：.title-local（本地服务按钮）必须删掉'],
    ['localState', '口径 O2：本地服务状态机必须删掉'],
    ['pendingEnter', '口径 O2：pendingEnter 一键进入必须删掉'],
    ['startLocal', '口径 O2：startLocal 必须删掉'],
    ['localServiceReady', '口径 O2：localServiceReady 必须删掉'],
    ['LOCAL_POLL_MS', '口径 O2：LOCAL_POLL_MS 轮询常量必须删掉'],
    ['启动中', '口径 O2：「启动中…」文案必须删掉'],
    ['FullscreenButton', '口径 O1：上游全屏按钮必须删掉（含 import）'],
    ['title-fs', '口径 O1：.title-fs 渲染处必须删掉'],
    ['GuideButton', '口径 O3：玩法说明按钮（GuideButton）必须删掉（含 import）'],
    ['title-guide', '口径 O3：.title-guide 渲染处必须删掉'],
    ['openPanel(\'lobby\')', '口径 O4：不许再开 lobby 面板（大厅 = servers 面板）'],
    ['${null}', 'v4.2 op3 的 ${null} 占位已不需要（口径 O3 直接删渲染处）'],
  ];
  for (const [needle, why] of gone) {
    assert.ok(!body.includes(needle), `${why}（正文里仍有 ${JSON.stringify(needle)}）`);
  }
  // 不留 unused import：Button / GuideButton / FullscreenButton 都不该在 import 里
  assert.ok(!/^\s*import[^;]*\bButton\b/m.test(body), 'components.js 的 Button 已不再使用，import 里不许留');
  assert.ok(!/^\s*import[^;]*\bGuideButton\b/m.test(body), 'guide.js 的 GuideButton 已不再使用，import 里不许留');
  assert.ok(!/^\s*import[^;]*\bFullscreenButton\b/m.test(body), 'device.js 的 FullscreenButton 已不再使用，import 里不许留');
  // detectFeatures 仍要用（触屏不自动聚焦），device.js 的 import 必须只剩它
  assert.ok(
    body.includes("import { detectFeatures } from '../ui/device.js';"),
    'device.js 的 import 必须只剩 detectFeatures',
  );
});

test('口径 O5：设置面板 kind = appearance，且 shellPanels.js 真的提供它（否则按钮点了没反应）', () => {
  const panels = read(path.join(here, 'extras', 'public', 'js', 'ui', 'shellPanels.js'));
  assert.match(
    panels,
    /if \(kind === 'appearance'\) return html`<\$\{AppearancePanel\} onClose=\$\{close\} \/>`;/,
    'ShellPanelHost 没有 appearance 分支 —— 设置按钮会静默什么都不开',
  );
  assert.match(panels, /function AppearancePanel\(\{ onClose \}\)/, 'AppearancePanel 组件缺失');
  // 这个面板**只**放我们独有的项：字体大小 / 左右边距，不混房主参数/传输方案。
  // 两种等价实现都接受：复用 AppearanceRows，或直接摆两行 SegRow（FONT_SCALE / SIDE_PAD）。
  const panel = /function AppearancePanel\(\{ onClose \}\)[\s\S]*?\n}/.exec(panels);
  assert.ok(panel, '取不到 AppearancePanel 主体');
  const panelBody = panel[0];
  const rendersRows = panelBody.includes('AppearanceRows')
    || (panelBody.includes('FONT_SCALE') && panelBody.includes('SIDE_PAD'));
  assert.ok(rendersRows, 'AppearancePanel 必须渲染外观两行（AppearanceRows 或 FONT_SCALE/SIDE_PAD）');
  for (const foreign of ['readParams', 'readTransport', 'TRANSPORT', 'saveTransport', 'HOST_BIND', 'COMBAT']) {
    assert.ok(!panelBody.includes(foreign), `AppearancePanel 混进了参数面板的东西：${foreign}`);
  }
  // 外观的单一写者：写 window.__SP_APPEARANCE（appearance.js）
  assert.ok(panels.includes('window.__SP_APPEARANCE'), 'appearance 的读写必须走 window.__SP_APPEARANCE');
});

test('title.js 副本没有套「净零/废弃」的 ops（ShellPanelHost 增删配对、重复声明）', () => {
  const src = read(VENDOR_JS);
  const body = bodyLines(src).join('\n'); // 只看正文：文件头会提到这些名字
  assert.ok(!body.includes('ShellPanelHost'), 'ShellPanelHost 不该出现（v2.3 op0 加、v3.5 op1/op6 删 → 净零）');
  // v2.2 op0/op1 是 find==replace 断言：上游 0.2.1 自己就有，重复插入会是 SyntaxError（check-patches 的教训）
  assert.equal(src.split("import { SettingsModal } from '../ui/settings.js';").length - 1, 1, 'SettingsModal import 只能有一次');
  assert.equal(src.split('const [settingsOpen, setSettingsOpen] = useState(false);').length - 1, 1, 'settingsOpen state 只能有一次');
  assert.equal(src.split('<${SettingsModal} open=${settingsOpen}').length - 1, 1, 'SettingsModal 只能渲染一次');
  // title-room__hint / title-room__btn 的 DOM 在 2.9.31 里已被 v3.5 op7 / v2.3 删除（CSS 规则保留但惰性）
  assert.ok(!src.includes('title-room__hint'), 'title-room__hint 不该出现在 JS（v3.5 op7 已删该行）');
  assert.ok(!src.includes('title-room__btn'), 'title-room__btn 不该出现在 JS（v2.3 已删房主/房间按钮）');
});

test('title.js 副本保住了上游 0.2.1 的原生特征（口径 O1/O3 主动删掉的两项除外）', () => {
  const src = read(VENDOR_JS);
  const keep = [
    ["import { LangToggle, useLang } from '../ui/lang.js';", 'LangToggle import'],
    ['<${LangToggle} class="title-lang" />', '语言切换'],
    ['DEV_BUILD ? html`<span class="title-dev"', 'DEV_BUILD 开发版标签'],
    ['class="title-settings fsbtn tapx"', '上游设置齿轮（.title-settings，口径 O5 明确保留）'],
    ['<${GIcon} name="gear" />', '齿轮图标'],
    ['<div class="title-conn">', '上游状态行 .title-conn'],
    ['<footer class="title-foot">', '上游页脚 .title-foot'],
    ['export function TitleScreen()', 'TitleScreen 导出'],
    ['export function enterSession(rawName)', 'enterSession 导出'],
    ['export const isValidName =', 'isValidName 导出'],
    ['export function sanitizeName(raw)', 'sanitizeName 导出'],
    ['export function stripLoneSurrogates(str)', 'stripLoneSurrogates 导出'],
    ['export function findUiAsset(assets, names)', 'findUiAsset 导出'],
    ['title-bg__radar', '雷达背景'],
    ['title-bg__target', '瞄准点'],
    ['class="emblem"', '点阵徽记'],
    ['class="title-invite"', '邀请横幅'],
    ["scriptOf(t('卫戍协议')) === 'alphabetic'", '拉丁文标题分支'],
    ['autoFocus=${!touchUi}', '触屏不自动聚焦'],
  ];
  for (const [needle, what] of keep) {
    assert.ok(src.includes(needle), `title.js 副本丢失上游原生特征：${what}（${JSON.stringify(needle)}）`);
  }
  // 口径 O5：上游设置齿轮**原样保留**，仍能打开上游设置弹窗（语言/音量/画质/伤害数字）——
  // 这是用户以后找回音量/画质的唯一入口，不能顺手删掉。
  assert.ok(
    src.includes('onClick=${() => setSettingsOpen(true)}><${GIcon} name="gear" /></button>'),
    '口径 O5：上游 .title-settings 齿轮必须保留，且仍 setSettingsOpen(true)',
  );
  assert.ok(src.includes('<${SettingsModal} open=${settingsOpen}'), '上游 SettingsModal 渲染必须保留');
  // 上游的 i18n 包裹必须还在（新文案没走 t() 是已知缺口，但原有文案不能被降级成字面量）
  assert.ok(src.includes("<span>${STATUS_TEXT[conn.status] ? t(STATUS_TEXT[conn.status]) : conn.status}</span>"), '状态文案的 t() 包裹');
  assert.ok(src.includes("${pendingSpectate ? t('收到观战邀请') : t('收到同盟邀请')}"), '邀请横幅的 t() 包裹');
  assert.ok(src.includes("toast(t('请输入博士代号'), 'warn')"), 'start() 的 t() 包裹');
  assert.ok(src.includes("${t('非官方同人复刻 · 游戏素材版权归 上海鹰角网络 / Yostar 所有')}"), '页脚版权行的 t() 包裹');
  // 输入框回车仍能进入（口径 O2/O6 删掉主按钮后，这是本页唯一的直接进入入口）
  assert.ok(src.includes('onEnter=${start}'), '口径 O2/O6：输入框回车必须仍走 start()');
});

test('title.css 副本带着 ops 产物并保住上游规则', () => {
  const css = read(VENDOR_CSS);
  for (const [needle, what] of [
    ['.title-conn__sw { display: flex', 'v2.2 op4 .title-conn__sw'],
    ['.title-side { position: absolute', 'v2.2 op4 .title-side'],
    ['.title-gear { background: none', 'v2.3 op2 无边框 .title-gear'],
    ['.title-room__btn, .title-room__cfg {', 'v2.2 op4 .title-room__cfg'],
    ['.title-room__hint {', 'v2.2 op4 .title-room__hint（惰性规则，2.9.31 字节保真）'],
    ['.title-foot__meta { display: inline-flex', 'v3.3 op1 .title-foot__meta'],
    ['.title-foot__update {', 'v3.5 op8 薄荷描边 .title-foot__update'],
  ]) {
    assert.ok(css.includes(needle), `title.css 副本缺少 ${what}：${JSON.stringify(needle)}`);
  }
  for (const [needle, what] of [
    ['.title-bg__radar {', '雷达'],
    ['.title-cn--latin {', '拉丁文标题'],
    ['.title-lang {', '语言菜单'],
    ['.title-invite {', '邀请横幅'],
    ['.title-conn .ping { height: .26rem', '状态行 ping（也是 op 的锚点）'],
    ['.title-dev {', '开发版标签'],
  ]) {
    assert.ok(css.includes(needle), `title.css 副本丢失上游规则：${what}`);
  }
  // 口径 O2/O6：首页双按钮的规则必须一起删掉（CSS 不该声明不存在的控件）；只看正文，文件头会提到它
  const cssBody = bodyLines(css).join('\n');
  assert.ok(!cssBody.includes('.title-duo'), '口径 O2/O6：.title-duo 规则必须删掉');
  assert.ok(!cssBody.includes('.title-local'), '口径 O2/O6：.title-local 规则必须删掉');
});

test('口径 O8：.title-side 的 top 必须让开上游语言切换（LangToggle），且不许回退到 1.05rem', () => {
  const css = read(VENDOR_CSS);
  const rule = /\.title-side \{([^}]*)\}/.exec(css);
  assert.ok(rule, '找不到 .title-side 规则');
  const top = /top:\s*([\d.]+)rem/.exec(rule[1]);
  assert.ok(top, '.title-side 规则里必须有 top: <n>rem');
  const topRem = Number(top[1]);
  // 依据：.title-corner--tr 的底边 ≈ .38rem(top) + .3rem(LangToggle 高) + .1rem(margin)
  // + ~.38rem(两行 MicroLabel, line-height 1.7) ≈ 1.16rem。top 必须 ≥ 1.3rem 才留得住间隙。
  assert.ok(
    topRem >= 1.3,
    `口径 O8：.title-side 的 top 必须 ≥ 1.3rem（现在 ${topRem}rem）—— 否则会压到上游 0.2.1 新增的语言切换`,
  );
  assert.equal(topRem, 1.35, '口径 O8 取 1.35rem（与 home-layer v8 一致）');
  // 语言切换确实在上游的右上角块里（这个前提变了就要重新取值）
  const upstream = read(UPSTREAM_JS);
  assert.match(upstream, /title-corner--tr[\s\S]{0,200}<\\?\$\{LangToggle\} class="title-lang"/,
    '上游 .title-corner--tr 里没有 LangToggle 了 —— O8 的取值依据要重新评估');
  assert.ok(css.includes('.title-lang {'), '上游 .title-lang 规则必须还在（它是被让开的那一项）');
});

// ---- 4) 差异可枚举 ----------------------------------------------------------------------------
test('差异可枚举：副本里缺失的上游原文行 = 恰好那 9 行被改写/删除的锚点（CSS 一行不缺）', () => {
  const jsMissing = missingUpstreamLines(read(UPSTREAM_JS), read(VENDOR_JS));
  const cssMissing = missingUpstreamLines(read(UPSTREAM_CSS), read(VENDOR_CSS));

  assert.equal(cssMissing.length, 0, `CSS 副本只能纯追加，却丢了上游行：\n${cssMissing.join('\n')}`);

  // 每一行都对应一条「锚点变了 / 被 ops 改写 / 被口径删除」的判定；
  // 多一行就说明有人手改副本时删了上游逻辑。
  const REWRITTEN = [
    // 被 ops 改写（锚点文本变了）
    /^import \{ useMemo, useState \} from '\.\.\/\.\.\/vendor\/hooks\.module\.js';$/, // v3.5 op0 → +useEffect
    /^  const \[name, setName\] = useState\(\(\) => store\.get\(\)\.me\.name \|\| identity\.loadName\(\) \|\| ''\);$/, // v3.5 op3 → +readProfileName()
    /^          <span>\$\{t\('收到同盟邀请'\)\}<\/span><b class="num">\$\{pendingJoin\}<\/b><span class="t-lo">\$\{t\('· 输入代号后将自动加入'\)\}<\/span>$/, // v5.6 op1 → 观战分支
    // 被口径删除（整行删掉，不是改写）
    /^import \{ html, Button, Icon, MicroLabel, TextField, PingPill \} from '\.\.\/ui\/components\.js';$/, // O2/O6：Button 不再用 → 从 import 去掉
    /^import \{ GuideButton \} from '\.\.\/ui\/guide\.js';$/, // O3：GuideButton 整行删（连 import）
    /^import \{ FullscreenButton, detectFeatures \} from '\.\.\/ui\/device\.js';$/, // O1：FullscreenButton 从 import 去掉
    /^        <\$\{Button\} variant="primary" size="xl" block=\$\{true\} iconRight="chevrons" disabled=\$\{!valid\} onClick=\$\{start\}>\$\{t\('开始'\)\}<\/\/>$/, // O2/O6：主按钮删除（进入走 大厅 → servers 面板 → takeAutostart）
    /^          <\$\{GuideButton\} class="title-guide" label=\$\{t\('玩法说明'\)\} \/>$/, // O3：玩法说明删除
    /^          <\$\{FullscreenButton\} class="title-fs" \/>$/, // O1：全屏删除
  ];
  assert.equal(
    jsMissing.length, REWRITTEN.length,
    `title.js 副本缺失的上游行数与「已知改写/删除锚点」不符（${jsMissing.length} vs ${REWRITTEN.length}）：\n`
    + jsMissing.map((l) => `  - ${l}`).join('\n'),
  );
  for (const line of jsMissing) {
    assert.ok(
      REWRITTEN.some((re) => re.test(line)),
      `title.js 副本丢了上游原文行，但它不是已知的改写/删除锚点（有人手改副本时删了上游逻辑？）：\n  ${line}`,
    );
  }
});

// ---- 5) 加载机制契约 --------------------------------------------------------------------------
test('加载机制：extras/public 同名覆盖上游路径（APK 内嵌树 + filesDir 热更树 + openLocal 兜底）', () => {
  const buildWebroot = read(path.join(here, 'build-webroot.mjs'));
  // 装配：extras/public/** → webroot 根（同名覆盖上游），所以 webroot/js/screens/title.js 就是副本
  assert.match(
    buildWebroot,
    /from:\s*path\.join\(extrasDir, 'public'\),\s*to:\s*outDir/,
    'build-webroot.copyExtras 不再把 extras/public 铺到 webroot 根 —— 副本将拿不到页面',
  );
  // 热更：extras 随 APK 打包（assets/shell/extras/public），Updater 每次热更都重放它
  assert.match(
    buildWebroot,
    /copyTree\(extrasDir \? path\.join\(extrasDir, 'public'\) : null, path\.join\(shellOut, 'extras', 'public'\)\)/,
    'build-webroot 不再把 extras/public 打进 assets/shell/extras/public —— 热更会丢副本',
  );

  const updater = read(path.join(repo, 'android', 'app', 'src', 'main', 'java', 'icu', 'jiangjiangze', 'stronghold', 'Updater.java'));
  assert.match(
    updater,
    /copyFileTree\(new File\(extrasDir, "public"\), staging\)/,
    'Updater.applyExtras 不再把 extras/public 覆盖到热更树根 —— filesDir 树会退回上游标题屏',
  );
  assert.match(
    updater,
    /copyAssetTree\(ctx, "shell\/extras\/public", staging\)/,
    'Updater.applyExtras 不再重放 APK 自带 extras —— 热更（未采用 slim 覆盖）时会丢副本',
  );
  assert.match(
    updater,
    /StandardCopyOption\.REPLACE_EXISTING/,
    'copyFileTree 不再 REPLACE_EXISTING —— 同路径覆盖会失败',
  );

  const mainActivity = read(path.join(repo, 'android', 'app', 'src', 'main', 'java', 'icu', 'jiangjiangze', 'stronghold', 'MainActivity.java'));
  // openLocal：先 filesDir 热更树，再 assets/webroot（APK 基线）兜底
  assert.match(
    mainActivity,
    /private InputStream openLocal\(String path\)\s*\{[\s\S]{0,600}?new File\(HostService\.contentRoot\(this\), path\)[\s\S]{0,600}?getAssets\(\)\.open\(ASSET_ROOT \+ path\)/,
    'MainActivity.openLocal 不再是「filesDir 热更树 → assets/webroot 兜底」—— 热更树会被忽略',
  );
});

test('加载机制：副本随 slim/内容包热更（js 与 css 都是 slim 顶层，且走 assets/shell 重放）', async () => {
  const { deriveSlimTop } = await import('./slim-top.mjs');
  const slim = deriveSlimTop(path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot'));
  // webroot 是构建产物，可能不存在（干净 checkout）——存在时断言 js/css 都在 slim 顶层
  if (slim.length) {
    assert.ok(slim.includes('js'), 'slim 顶层缺 js —— 热更会丢客户端代码（副本也在其中）');
    assert.ok(slim.includes('css'), 'slim 顶层缺 css —— 热更会丢样式（副本也在其中）');
  }
  // 副本路径必须是 extras/public 下的 webroot 相对路径（同名覆盖的前提）
  const extrasPublic = path.join(here, 'extras', 'public');
  assert.equal(path.relative(extrasPublic, VENDOR_JS).split(path.sep).join('/'), 'js/screens/title.js');
  assert.equal(path.relative(extrasPublic, VENDOR_CSS).split(path.sep).join('/'), 'css/screens/title.css');
});

test('与 home-layer 互斥：副本置标记，home-layer 的 wanted() 看到标记即让位', () => {
  const layer = read(path.join(here, 'extras', 'public', 'js', 'home-layer.js'));
  assert.ok(layer.includes("var VENDOR_FLAG = '__SP_TITLE_VENDORED';"), 'home-layer 未声明 VENDOR_FLAG');
  assert.match(
    layer,
    /function wanted\(\) \{ return shown && !suppressed\(\) && homePresent\(\) && !vendoredTitle\(\); \}/,
    'home-layer.wanted() 未接入 vendored 让位守卫 —— 副本与叠加层会同时渲染同一批控件',
  );
  assert.match(
    layer,
    /function vendoredTitle\(\) \{\s*try \{ return !!window\[VENDOR_FLAG\]; \} catch \(e\) \{ return false; \}\s*\}/,
    'home-layer.vendoredTitle() 守卫缺失或形状变了',
  );
  // 让位是可逆的：标记未设时行为完全不变（home-layer.test.mjs 全绿即证）
  const vendor = read(VENDOR_JS);
  assert.ok(vendor.includes("window.__SP_TITLE_VENDORED = 'shell-v2.9.31';"), '副本未置 __SP_TITLE_VENDORED 标记');
  assert.ok(vendor.includes("if (typeof window !== 'undefined')"), '标记必须在 typeof window 守卫内（Node 下 import 不炸）');
});
