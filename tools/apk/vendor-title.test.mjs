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
//   3) **差异可枚举**：副本里**缺失的上游原文行**必须恰好是那几条「被 ops 改写 / 被口径删除的锚点」
//      （2026-10-09 R1–R5 撤除后为 6 条），CSS 侧一行
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
 * 上游 tag/commit: v0.2.2 / 62eb113419123d9a3a63606107bbf85230c5dd2f
 */
const BASELINE = {
  js: { sha256: '6813626a511d093e798145183ae0f2d511f256172b7ee1846c23fbfeced45924', bytes: 14186 },
  css: { sha256: 'ce1e6236ad3d6f323db3957badbc578ea1ba36d5e8515304f12beec569be4f37', bytes: 11089 },
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
    assert.match(src, /v0\.2\.2/, `${name} 文件头缺少 upstream tag v0.2.2`);
    assert.match(src, /62eb1134/, `${name} 文件头缺少 upstream commit`);
    assert.match(src, /shell-v2\.9\.31/, `${name} 文件头缺少补丁来源 tag shell-v2.9.31`);
    assert.match(src, /vendor-title\.test\.mjs/, `${name} 文件头缺少同步方法（指向本测试）`);
  }
});

// ---- 3) 产物断言：2026-10-09 后仍保留的东西都在（其余控件已按业主口径撤除）----------------------
test('title.js 副本带着 2026-10-09 后仍保留的产物（其余控件已按业主口径撤除）', () => {
  const src = read(VENDOR_JS);
  const code = bodyLines(src).join('\n'); // 只看正文：文件头会提到被撤除的名字
  const keep = [
    // R3：duo 撤除后，登录面板入口恢复成上游自己的「开始」主按钮
    ["<${Button} variant=\"primary\" size=\"xl\" block=${true} iconRight=\"chevrons\" disabled=${!valid} onClick=${start}>${t('开始')}<//>", '上游「开始」主按钮'],
    // Button 仍要用（开始按钮），components.js 的 import 整行与上游逐字节相同
    ["import { html, Button, Icon, MicroLabel, TextField, PingPill } from '../ui/components.js';", 'Button import'],
    // v3.5 op2（保留部分）：代号预填 readProfileName（非 UI 行为）
    ['function readProfileName()', 'v3.5 readProfileName'],
    // v3.5 op3：代号预填
    ['|| readProfileName() ||', 'v3.5 op3 代号预填'],
    // v5.6：观战邀请
    ['const pendingSpectate = useStore((s) => s.ui.pendingSpectate === true);', 'v5.6 op0 pendingSpectate'],
    ["t('收到观战邀请')", 'v5.6 op1 观战文案'],
    // 与 home-layer 互斥：本副本的身份标记（home-layer 现已是空壳，标记保留）
    ["window.__SP_TITLE_VENDORED = 'shell-v2.9.31';", 'vendored 标记'],
    // 上游原生：输入框回车仍走 start()
    ['onEnter=${start}', '输入框回车进入'],
  ];
  for (const [needle, what] of keep) {
    assert.ok(src.includes(needle), `title.js 副本缺少 ${what}：${JSON.stringify(needle)}`);
  }
  // 2026-10-09 业主口径 R1–R5：只为我们渲染控件的东西必须整块消失（查正文，文件头会提到它们）
  const removed = [
    ['import { useEffect', 'v3.5 op0 useEffect（不再有任何 effect）'],
    ['<div class="title-side">', 'R1 侧栏 .title-side'],
    ['title-room__cfg', 'R1 侧栏按钮 .title-room__cfg'],
    ['<div class="title-duo">', 'R3 登录 duo'],
    ['class="title-local"', 'R3 duo 左「本地」'],
    ['title-conn__sw', 'R4 状态行包裹'],
    ['title-foot__update', 'R2 页脚检查更新'],
    ['title-foot__meta', 'R2 页脚 meta 包裹'],
    ['data-sp-title-btn', 'R1–R3 我们自己的控件属性'],
    ['takeAutostart', 'R5 一次性 autostart'],
    ['visitorsCached', 'R4 访客数读取'],
    ['fetchVisitors', 'R4 访客数请求'],
    ['openShellPanel', 'R1–R4 面板桥调用'],
    ['localServiceReady', '本地服务状态机'],
    ['LOCAL_POLL_MS', '本地服务轮询常量'],
    ['localState', '本地服务状态'],
    ['pendingEnter', '一键进入标志'],
    ['startLocal', '本地服务启动'],
    ['localLabel', 'duo 文案'],
  ];
  for (const [needle, what] of removed) {
    assert.equal(code.includes(needle), false, `已撤除的东西仍在正文里：${what}（${JSON.stringify(needle)}）`);
  }
});

// ---- 3b) 用户口径覆盖（2026-10-08 第二轮追加）----------------------------------------------------
test('口径 O6（2026-10-09 覆盖）：首页侧栏控件已全部撤除', () => {
  const body = bodyLines(read(VENDOR_JS)).join('\n');
  assert.ok(!body.includes('<div class="title-side">'), '侧栏 .title-side 必须已删');
  assert.ok(!body.includes('title-room__cfg'), '侧栏按钮 .title-room__cfg 必须已删');
  assert.ok(!body.includes('title-room'), '侧栏按钮组 .title-room 必须已删');
  assert.ok(!body.includes('data-sp-title-btn'), '我们自己的控件属性必须全部消失');
  // 口径 O5 仍然有效：设置面板 kind = appearance 由 shellPanels 提供（入口在悬浮窗/其它模块，不在标题屏）
  const panels = read(path.join(here, 'extras', 'public', 'js', 'ui', 'shellPanels.js'));
  assert.match(
    panels,
    /if \(kind === 'appearance'\) return html`<\$\{AppearancePanel\} onClose=\$\{close\} \/>`;/,
    'ShellPanelHost 的 appearance 分支必须保留（设置入口搬走后仍要能开）',
  );
});

test('口径 O2（2026-10-09 覆盖）：登录 duo 已撤除，入口恢复成上游「开始」主按钮', () => {
  const body = bodyLines(read(VENDOR_JS)).join('\n');
  assert.ok(!body.includes('<div class="title-duo">'), '登录 duo 必须已删');
  assert.ok(!body.includes('title-local'), 'duo 左「本地」必须已删');
  assert.ok(!body.includes('title-conn__sw'), '状态行的 .title-conn__sw 包裹必须已删（点按开大厅入口没了）');
  assert.ok(!/data-sp-title-btn/.test(body), '我们自己的控件属性不许再出现');
  // 上游自己的「开始」主按钮回来了，且是登录面板里唯一的进入按钮
  assert.ok(
    body.includes("<${Button} variant=\"primary\" size=\"xl\" block=${true} iconRight=\"chevrons\" disabled=${!valid} onClick=${start}>${t('开始')}<//>"),
    '上游「开始」主按钮必须恢复（唯一入口）',
  );
  assert.ok(body.includes('onEnter=${start}'), '输入框回车仍走 start()（上游第二入口）');
});

test('口径 O7（2026-10-09 覆盖）：我们自己的控件属性 data-sp-title-btn 已全部消失', () => {
  const body = bodyLines(read(VENDOR_JS)).join('\n');
  const acts = [...body.matchAll(/data-sp-title-btn="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(acts, [], `data-sp-title-btn 必须一个都不剩（实际：${JSON.stringify(acts)}）`);
  // 外部模拟脚本改按上游自己的控件定位：登录面板主按钮 = 上游「开始」
  assert.ok(body.includes('<div class="title-login">'), '上游登录面板容器保留');
});

test('口径 O1/O3：全屏 / 玩法说明删净（含 import，不留 unused）', () => {
  const body = bodyLines(read(VENDOR_JS)).join('\n');
  const gone = [
    ['FullscreenButton', '口径 O1：上游全屏按钮必须删掉（含 import）'],
    ['title-fs', '口径 O1：.title-fs 渲染处必须删掉'],
    ['GuideButton', '口径 O3：玩法说明按钮（GuideButton）必须删掉（含 import）'],
    ['title-guide', '口径 O3：.title-guide 渲染处必须删掉'],
    ['${null}', 'v4.2 op3 的 ${null} 占位已不需要（口径 O3 直接删渲染处）'],
  ];
  for (const [needle, why] of gone) {
    assert.ok(!body.includes(needle), `${why}（正文里仍有 ${JSON.stringify(needle)}）`);
  }
  // 不留 unused import：GuideButton / FullscreenButton 都不该在 import 里
  assert.ok(!/^\s*import[^;]*\bGuideButton\b/m.test(body), 'guide.js 的 GuideButton 已不再使用，import 里不许留');
  assert.ok(!/^\s*import[^;]*\bFullscreenButton\b/m.test(body), 'device.js 的 FullscreenButton 已不再使用，import 里不许留');
  // detectFeatures 仍要用（触屏不自动聚焦），device.js 的 import 必须只剩它
  assert.ok(
    body.includes("import { detectFeatures } from '../ui/device.js';"),
    'device.js 的 import 必须只剩 detectFeatures',
  );
  // 口径 O9：v4.5 op0 的「无操作 / 吞冒泡 / cursor:default」整块已被点按开大厅取代
  assert.ok(!body.includes('onClickCapture=${(e) => e.stopPropagation()}'), 'v4.5 op0 的吞冒泡必须删掉（口径 O9）');
  assert.ok(!body.includes('style="cursor:default"'), 'v4.5 op0 的 cursor:default 必须删掉（口径 O9）');
});

test('口径 O5：设置面板 kind = appearance，且 shellPanels.js 真的提供它（否则按钮点了没反应）', () => {
  const panels = read(path.join(here, 'extras', 'public', 'js', 'ui', 'shellPanels.js'));
  assert.match(
    panels,
    /if \(kind === 'appearance'\) return html`<\$\{AppearancePanel\} onClose=\$\{close\} \/>`;/,
    'ShellPanelHost 没有 appearance 分支 —— 设置按钮会静默什么都不开',
  );
  assert.match(panels, /function AppearancePanel\(\{ onClose \}\)/, 'AppearancePanel 组件缺失');
  // 这个面板**只**放我们独有的项：字体挡位 / 边距滑动条，不混房主参数/传输方案。
  // v6.10: 字体 = FONT_SCALE 的 SegRow（小杯/中杯/大杯/超大杯/EW）；边距 = 0–40px 的 SliderRow
  // （PAD_MIN/PAD_MAX/PAD_STEP）。不再有 SIDE_PAD 预设行，也不再复用 AppearanceRows（参数面板已去掉外观）。
  const panel = /function AppearancePanel\(\{ onClose \}\)[\s\S]*?\n}/.exec(panels);
  assert.ok(panel, '取不到 AppearancePanel 主体');
  const panelBody = panel[0];
  const rendersRows = panelBody.includes('FONT_SCALE') && panelBody.includes('SliderRow');
  assert.ok(rendersRows, 'AppearancePanel 必须渲染字体挡位行（FONT_SCALE）+ 边距滑动条行（SliderRow）');
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
  // 输入框回车仍能进入（上游行为，也是唯一剩下的键盘入口）
  assert.ok(src.includes('onEnter=${start}'), '输入框回车必须仍走 start()');
  // 2026-10-09：duo 与页脚 meta 已撤除，登录面板里只剩上游自己的控件
  const login = /<div class="title-login">([\s\S]*?)<\/div>\s*<\/main>/.exec(src);
  assert.ok(login, '找不到 .title-login 区块');
  assert.ok(login[1].includes('onEnter=${start}'), '输入框回车仍走 start()（上游行为）');
  assert.ok(
    login[1].includes("<${Button} variant=\"primary\" size=\"xl\" block=${true} iconRight=\"chevrons\" disabled=${!valid} onClick=${start}>${t('开始')}<//>"),
    '登录面板入口 = 上游「开始」主按钮',
  );
  assert.ok(login[1].includes('<div class="title-conn">'), '状态行必须仍在 .title-login 里（上游位置不动）');
  assert.ok(!login[1].includes('title-duo') && !login[1].includes('data-sp-title-btn'),
    '登录面板里不许再有我们自己的控件');
  // 页脚版本号恢复成上游原样（不再是我们的 .title-foot__meta 包裹）
  assert.ok(src.includes('<${MicroLabel}>v${APP_VERSION} · WEB SIMULATION<//>'), '页脚版本号必须保留（上游原样）');
  assert.ok(!bodyLines(src).join('\n').includes('title-foot__meta'), '页脚 meta 包裹（我们的）必须已删');
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
  // 口径 O2/O6：登录面板双按钮的规则必须搬回来（CSS 与 JS 的控件表一一对应）；只看正文，文件头会提到它
  const cssBody = bodyLines(css).join('\n');
  assert.ok(cssBody.includes('.title-duo'), '口径 O2/O6：.title-duo 规则必须搬回（JS 有 duo，CSS 就得有）');
  assert.ok(cssBody.includes('.title-login .title-duo > .btn { flex: 1 1 0;'), 'duo 等宽半排规则（v3.6 op2）');
  assert.ok(cssBody.includes('.title-login .btn--xl.title-local { letter-spacing: 0;'), '.title-local 半宽收紧（v3.5 op8）');
});

test('口径 O8：.title-side 的 top 必须让开上游右上角块（实测底边 ≈1.51rem），且不许回退到 1.35rem', () => {
  const css = read(VENDOR_CSS);
  const rule = /\.title-side \{([^}]*)\}/.exec(css);
  assert.ok(rule, '找不到 .title-side 规则');
  const top = /top:\s*([\d.]+)rem/.exec(rule[1]);
  assert.ok(top, '.title-side 规则里必须有 top: <n>rem');
  const topRem = Number(top[1]);
  // 依据（三视口实测，见交付报告）：上游 .title-corner--tr（LangToggle .3rem + margin .1rem + 两行
  // MicroLabel, line-height 1.7 + top .38rem）盒底边 ≈1.51rem（desktop rem=75px：y=29..112px；
  // phone rem=40px：y=15..61px）—— 1.35rem 压住角块 ~.15rem。top 必须 ≥ 1.6rem 才留得住间隙。
  assert.ok(
    topRem >= 1.6,
    `口径 O8：.title-side 的 top 必须 ≥ 1.6rem（现在 ${topRem}rem）—— 否则会压到上游右上角块`,
  );
  assert.equal(topRem, 1.7, '口径 O8 取 1.7rem（角块底边 1.51rem + ≈.19rem 间隙）');
  // 语言切换确实在上游的右上角块里（这个前提变了就要重新取值）
  const upstream = read(UPSTREAM_JS);
  // 0.2.2 起上游把语言菜单包进 .title-corner__tools（同一行里多了「统计」按钮），
  // 所以锚点距离从 ~120 字符涨到 ~230 —— 窗口放到 400 字符，检查的仍是「LangToggle 还在角块内」。
  // 角块高度不变（统计按钮与 LangToggle 同一 flex 行，且 .title-corner__tools .title-lang 的
  // margin-bottom 归零），所以 O8 的 1.51rem 底边依据仍然成立。
  assert.match(upstream, /title-corner--tr[\s\S]{0,400}<\\?\$\{LangToggle\} class="title-lang"/,
    '上游 .title-corner--tr 里没有 LangToggle 了 —— O8 的取值依据要重新评估');
  assert.ok(css.includes('.title-lang {'), '上游 .title-lang 规则必须还在（它是被让开的那一项）');
});

// ---- 3b) 语言选项与上游对齐（业主 2026-10-08「进入服务器后右上角上游的语言选项'变了'」）--------
test('语言选项与上游对齐：LangToggle 调用与 .title-lang 规则逐字同上游；副本不得自加语言样式', () => {
  const vjs = read(VENDOR_JS), ujs = read(UPSTREAM_JS);
  const vcss = read(VENDOR_CSS), ucss = read(UPSTREAM_CSS);
  // 结构（DOM）逐字相同：副本没有改写语言控件的渲染
  for (const needle of ["import { LangToggle, useLang } from '../ui/lang.js';", '<${LangToggle} class="title-lang" />']) {
    assert.ok(ujs.includes(needle), `上游 title.js 缺语言控件锚点：${needle}`);
    assert.ok(vjs.includes(needle), `副本缺语言控件锚点：${needle}`);
  }
  // 语言菜单的上游 CSS 规则逐字保留（副本一行没改；对齐靠数据，不靠 CSS 覆盖）
  const RULES = [
    '.title-lang { display: inline-flex; margin-bottom: .1rem; }',
    '.title-lang button { min-width: .74rem; height: .3rem; font-size: .14rem; cursor: pointer; }',
    '.lang-select select { height: .38rem; min-width: 1.6rem; padding: 0 .12rem; background: #0a0d0c; border: 0; color: var(--text-hi); font-size: .16rem; cursor: pointer; }',
    '.title-lang.lang-select select { height: .3rem; font-size: .14rem; }',
    // 0.2.2 上游新增：右上角把语言菜单与「统计」按钮排在一行（原样套，见副本文件头）
    '.title-corner__tools .title-lang { margin-bottom: 0; }',
  ];
  for (const rule of RULES) {
    assert.ok(ucss.includes(rule), `上游 .title-lang 规则变了，副本要跟着对齐：${rule}`);
    assert.ok(vcss.includes(rule), `副本必须逐字保留上游 .title-lang 规则：${rule}`);
  }
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const cssBody = bodyLines(vcss).join('\n');
  const langRules = [...cssBody.matchAll(/^[^\n{}]*(?:\.title-lang|\.lang-select)[^\n{}]*\{[^}]*\}/gm)].map((m) => norm(m[0]));
  assert.deepEqual(langRules.slice().sort(), RULES.map(norm).sort(),
    '副本只许有上游那 4 条语言规则（自加样式会让首页与服务器页的控件长得不一样）');
});

test('语言选项对齐的杠杆在数据：extras 铺 packs/index.json（首页与服务器页列同一份语言）', () => {
  // 形态由 public/js/ui/lang.js langMenuModel 按「菜单里有几种语言」决定（> SEGMENTED_MAX 才是一个
  // <select> 列表）。列表来自 /packs/index.json：服务器页由服务器实时列出；APK 首页的本地树里没有
  // packs/**（build-webroot 只搬 public/data/shared/server），原先 loadLangIndex() 404 → 只剩中文。
  // 所以 extras 必须把上游那张 index 铺到 webroot 根；逐字节的门在 tools/apk/pack-index.test.mjs。
  const idxPath = path.join(here, 'extras', 'public', 'packs', 'index.json');
  assert.ok(fs.existsSync(idxPath), 'extras 缺 packs/index.json —— 首页语言菜单又会退回「只有中文」');
  const idx = JSON.parse(read(idxPath));
  const langs = (idx.packs || []).filter((p) => p.type === 'lang').map((p) => p.id).sort();
  const i18n = fs.readdirSync(path.join(repo, 'public', 'i18n'))
    .filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort();
  assert.deepEqual(langs, i18n, 'extras 的 index 必须列出 public/i18n/ 的每种语言（首页/服务器页同一份列表）');
  // 根因仍在（上游装配不搬 packs/）：这条断言是给将来改 build-webroot 的人看的 —— 一旦上游搬了
  // packs/，pack-index.test.mjs 的逐字节门仍保证 extras 那份与现算结果一致。
  assert.ok(!/name === 'packs'|'packs'\)/.test(read(path.join(here, 'build-webroot.mjs'))),
    'build-webroot 开始搬 packs/ 了 —— 请复核 extras 的 packs/index.json 是否还需要（以及是否会被它覆盖）');
});

// ---- 4) 差异可枚举 ----------------------------------------------------------------------------
test('差异可枚举：副本里缺失的上游原文行 = 恰好那 6 行被改写/删除的锚点（CSS 一行不缺）', () => {
  const jsMissing = missingUpstreamLines(read(UPSTREAM_JS), read(VENDOR_JS));
  const cssMissing = missingUpstreamLines(read(UPSTREAM_CSS), read(VENDOR_CSS));

  assert.equal(cssMissing.length, 0, `CSS 副本只能纯追加，却丢了上游行：\n${cssMissing.join('\n')}`);

  // 每一行都对应一条「锚点变了 / 被 ops 改写 / 被口径删除」的判定；
  // 多一行就说明有人手改副本时删了上游逻辑。
  // 2026-10-09：R1–R5 撤除后，上游的「开始」主按钮与 hooks import 都回到原文，不再是缺失行。
  const REWRITTEN = [
    // 被 ops 改写（锚点文本变了）
    /^  const \[name, setName\] = useState\(\(\) => store\.get\(\)\.me\.name \|\| identity\.loadName\(\) \|\| ''\);$/, // v3.5 op3 → +readProfileName()
    /^          <span>\$\{t\('收到同盟邀请'\)\}<\/span><b class="num">\$\{pendingJoin\}<\/b><span class="t-lo">\$\{t\('· 输入代号后将自动加入'\)\}<\/span>$/, // v5.6 op1 → 观战分支
    // 被口径删除（整行删掉，不是改写）
    /^import \{ GuideButton \} from '\.\.\/ui\/guide\.js';$/, // O3：GuideButton 整行删（连 import）
    /^import \{ FullscreenButton, detectFeatures \} from '\.\.\/ui\/device\.js';$/, // O1：FullscreenButton 从 import 去掉
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

test('与 home-layer 互斥：副本仍置 __SP_TITLE_VENDORED 标记（home-layer 现已是空壳）', () => {
  // 2026-10-09 业主口径：home-layer.js 已退成空壳（首页不再有我们的叠加层），所以这个标记不再被
  // 用来「让位」；保留它是因为它是本副本的身份标记，外部/测试仍按名字引用。空壳本身由
  // home-layer.test.mjs 的移除守卫覆盖（那里断言叠加层控件与 DOM 机制一个不剩）。
  const layer = read(path.join(here, 'extras', 'public', 'js', 'home-layer.js'));
  assert.ok(layer.includes('RETIRED (owner call, 2026-10-09)'), 'home-layer 必须已记录业主口径');
  assert.ok(!layer.includes('VENDOR_FLAG'), 'home-layer 不再需要 vendored 让位逻辑');
  const vendor = read(VENDOR_JS);
  assert.ok(vendor.includes("window.__SP_TITLE_VENDORED = 'shell-v2.9.31';"), '副本未置 __SP_TITLE_VENDORED 标记');
  assert.ok(vendor.includes("if (typeof window !== 'undefined')"), '标记必须在 typeof window 守卫内（Node 下 import 不炸）');
});
