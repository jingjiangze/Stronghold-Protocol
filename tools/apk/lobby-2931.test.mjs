// 「大厅」页面口径测试（业主 2026-10-08）：大厅面板 = **2.9.31 版**——
// 服务器卡 →（顶部两格：本机服务 / 自动线路，与服务器面板共用 QuickModes）→ 邀请码 → 房间列表，
// 外加 2.9.31 同款的 同盟匹配 / 加入自定义服务器 / 局域网 小节，顺序、文案、卡片布局逐字锁定。
// 真源：`git show shell-v2.9.31:tools/apk/extras/public/js/lobby.js`（面板体与 2.9.31 逐行同构，
// 只差 v6/v7 的管道：单调时钟、可见性门禁、服务端发布、自挂载宿主）。
//
// 为什么是源码结构断言而不是渲染断言：渲染证明在像素台（tools/pwshot 的 ?panel=lobby 预览核查，
// 见提交说明的 sim 输出）；这里锁的是**口径**——将来 v8/v9 谁改了顺序、漏了卡片、把标签写错，
// 这个测试先红，而不是等业主在真机上发现「大厅不是我说的那版」。
//
// 同时钉住两条硬接口：
//   ① registerPanel('lobby', LobbyPanel) 链完整（openShellPanel('lobby') 必须落在本页）；
//   ② 本页仍是经典脚本（首行 /* global */ + 无顶层 import/export），面板宿主在依赖就绪后自挂载。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOBBY = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'lobby.js'), 'utf8');
const PANELS = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'shellPanels.js'), 'utf8');

/** LobbyPanel 的渲染块（`return html\`<${Modal} …` 到结尾的 `<//>\`;`）——章节顺序只在这一段里看。 */
function lobbyRender() {
  const start = LOBBY.indexOf('return html`<${Modal} open=${true} onClose=${onClose} title="大厅"');
  assert.ok(start > 0, 'LobbyPanel 必须仍以 <${Modal} … title="大厅" 开头渲染');
  const end = LOBBY.indexOf('<//>`;', start);
  assert.ok(end > start, '找不到 LobbyPanel 渲染块的结尾');
  return LOBBY.slice(start, end);
}

/** 2.9.31 的章节顺序（渲染块里的有序锚点）。 */
const SECTIONS = [
  '快捷模式<${MicroLabel}>QUICK<//>',
  '服务器<${MicroLabel}>SERVERS<//>',
  '<${MatchSection} />',
  '加入自定义服务器<${MicroLabel}>CUSTOM SERVER<//>',
  '邀请码<${MicroLabel}>INVITE<//>',
  '房间列表<${MicroLabel}>ROOMS<//>',
  '<${LanSection} onClose=${onClose} />',
];

test('章节顺序 = 2.9.31（快捷模式 → 服务器 → 同盟匹配 → 自定义服务器 → 邀请码 → 房间列表 → 局域网）', () => {
  const body = lobbyRender();
  let at = -1;
  for (const anchor of SECTIONS) {
    const i = body.indexOf(anchor);
    assert.ok(i > 0, `章节锚点缺失：${JSON.stringify(anchor)}`);
    assert.ok(i > at, `章节顺序被改：${JSON.stringify(anchor)} 出现在上一节之前`);
    at = i;
  }
  // 每节都是同一套 .set-row + .set-row__label + MicroLabel 结构（视觉一致性的最小保证）
  for (const label of SECTIONS.slice(0, 2).concat(SECTIONS.slice(3, 6))) {
    assert.ok(body.includes('<span class="set-row__label">' + label), `${label} 必须落在 .set-row__label 上`);
  }
  // 子组件自己的标签（MatchSection / LanSection 是兄弟组件，标签在自己的渲染里）
  assert.ok(LOBBY.includes('<span class="set-row__label">同盟匹配<${MicroLabel}>MATCH<//></span>'), '同盟匹配 MATCH 标签');
  assert.ok(LOBBY.includes('<span class="set-row__label">局域网<${MicroLabel}>LAN<//></span>'), '局域网 LAN 标签');
  // 邀请码冲突时的选服行（2.9.31 同款，条件渲染）
  assert.ok(LOBBY.includes('<span class="set-row__label">选择服务器<${MicroLabel}>PICK<//></span>'), '选择服务器 PICK 行');
});

test('模态框与页脚文案 = 2.9.31', () => {
  const body = lobbyRender();
  assert.ok(body.includes('title="大厅" micro="LOBBY" width="10.4rem"'), '模态框标题/微观标签/宽度');
  assert.ok(body.includes('onClick=${onClose}>完成<//>'), '右下角「完成」按钮');
  assert.ok(body.includes('非官方同人作品 · 房间信息来自各站公开接口（只读）；不代登录、不代转发。加入失败（房满 / 已开始）由目标服务器照常提示。'),
    '页脚免责声明必须逐字保留');
});

test('卡片布局：顶部两格 = 本机服务 / 自动线路（与服务器面板共用 QuickModes）', () => {
  const body = lobbyRender();
  assert.ok(body.includes('<span class="set-row__label">快捷模式<${MicroLabel}>QUICK<//></span>'), '顶部那一节是「快捷模式 QUICK」');
  assert.ok(body.includes('<div class="sp-srv-grid"><${QuickModes} onClose=${onClose} onNote=${setNote} locked=${inMatch()} /></div>'),
    '顶部两格必须复用服务器面板的 QuickModes（同一组件 = 同一套切服行为）');
  // 共用：服务器面板里也是同一组件、同一 props
  assert.ok(PANELS.includes('export function QuickModes'), 'QuickModes 必须由 shellPanels.js 导出');
  assert.ok(PANELS.includes('<div class="sp-srv-grid"><${QuickModes} onClose=${onClose} onNote=${setNote} locked=${locked} />'),
    '服务器面板也必须用同一 QuickModes（口径：两处一格不差）');
  // 两格的身份固定：本机服务 / 自动线路（顺序也固定）
  const rows = /const rows = \[([\s\S]*?)\n  \];/.exec(PANELS);
  assert.ok(rows, 'QuickModes 必须显式列两格');
  const local = rows[1].indexOf("{ key: 'local', id: 'local', name: '本机服务'");
  const auto = rows[1].indexOf("{ key: 'auto', id: 'auto', name: '自动线路'");
  assert.ok(local >= 0 && auto > local, '两格必须是（且顺序为）本机服务 → 自动线路');
});

test('服务器卡小节：签名清单网格 + 2.9.31 提示语', () => {
  const body = lobbyRender();
  assert.ok(body.includes('<div class="sp-srv-grid">${stationCards().map(card)}</div>'), '服务器卡 = 两列网格（stationCards）');
  assert.ok(body.includes("点一张卡 = 切换到该服务器并自动进入${native ? '' : '（网页版 = 跳转到该线路）'}。"), '服务器卡提示语');
  assert.ok(LOBBY.includes('function card(row)'), '每张卡 = card(row)');
  assert.ok(LOBBY.includes("class=${'sp-srv-cell'"), '卡片类名 sp-srv-cell（与服务器面板同一套 CSS）');
  assert.ok(LOBBY.includes('<span class="sp-srv-name">'), '卡里是 名称 · 版本 · 延迟色点 三件套');
});

// 业主第二轮（2026-10-08）：服务器列表「挤在一起 + 没有延迟」的回归门禁。根因是 `.sp-srv-*` 样式
// 随构建期补丁清零被删（补丁 settings-v3.6.json -> css/screens/game.css），没有搬进叠加层：行退化成
// block（一列贴在一起），延迟点是个空 inline span（width 对 inline 不生效）→ 宽 0，看不见。
// 这里钉两条：① 这份样式表必须在 extras 里（可热更），且是 2.9.31 的两列网格；② 色点必须每次都渲染
// （无条件，且自带尺寸兜底），未知/探测中/停用一律灰点 —— 允许「灰点」，不允许「没有点」。
test('服务器列表回归（v7.5）：.sp-srv-* 样式表必须在 extras 里（补丁清零后不许再丢）', () => {
  const files = [];
  for (const f of fs.readdirSync(path.join(here, 'extras', 'public', 'js'), { withFileTypes: true })) {
    if (!f.isFile() || !/\.js$/.test(f.name)) continue;
    files.push({ name: f.name, text: fs.readFileSync(path.join(here, 'extras', 'public', 'js', f.name), 'utf8') });
  }
  const dir = path.join(here, 'extras', 'public', 'js', 'ui');
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!f.isFile() || !/\.js$/.test(f.name)) continue;
    files.push({ name: 'ui/' + f.name, text: fs.readFileSync(path.join(dir, f.name), 'utf8') });
  }
  const owner = files.find((f) => f.text.includes("'.sp-srv-grid{display:grid"));
  assert.ok(owner, '服务器行样式（.sp-srv-grid 两列网格）必须由 extras 某个脚本注入 —— 补丁零清后它就是唯一出处');
  assert.ok(owner.text.includes('grid-template-columns:repeat(2,minmax(0,1fr))'), '两列等宽（2.9.31 行式）');
  assert.ok(owner.text.includes('@media (max-width:600px){.sp-srv-grid{grid-template-columns:1fr}}'), '窄屏单列');
  // 注入必须幂等 + 有 id（重复进入页面不许叠样式表）
  assert.ok(owner.text.includes("'sp-srv-style'") && owner.text.includes('getElementById'), '样式表要带 id 且按 id 幂等');
  // 大厅卡片本身：三件套齐全 + 色点无条件渲染且带尺寸兜底（没有样式表时也看得见）
  assert.ok(LOBBY.includes('<span class="sp-srv-name">'), '名称');
  assert.ok(LOBBY.includes('<span class="sp-srv-ver">'), 'v版本');
  const dot = LOBBY.match(/<span class="sp-srv-rtt" style=\$\{'([^']*)' \+ dot\.color\} title=\$\{dot\.title\}><\/span>/);
  assert.ok(dot, '延迟色点必须无条件渲染（不放在条件分支里）');
  for (const part of ['display:inline-block', 'width:.11rem', 'height:.11rem', 'min-width:4px', 'min-height:4px', 'border-radius:50%', 'background:']) {
    assert.ok(dot[1].includes(part), `色点行内样式缺 ${part}（静态兜底）`);
  }
  // 未知/探测中/停用：灰点（不是缺席）
  assert.ok(LOBBY.includes("return { color: '#8a9a93', title: '延迟未知' };"), 'rtt 未知 → 灰点');
  assert.ok(LOBBY.includes("return { color: '#8a9a93', title: '探测中' };"), '探测中 → 灰点');
});

test('邀请码小节 = window.__SP_JOIN.resolveCode + 4 位字母输入', () => {
  const body = lobbyRender();
  assert.ok(body.includes('placeholder="4 位字母" maxLength="4"'), '邀请码输入框（4 位字母）');
  assert.ok(body.includes("invite.state === 'probing' ? '查找中…' : '查找'"), '「查找」按钮文案');
  assert.ok(LOBBY.includes('window.__SP_JOIN.resolveCode(normalized)'), '探测走 shell-join.js 的 resolveCode（跨服单跳/多跳选择器）');
  assert.ok(LOBBY.includes('<span class="set-row__label">选择服务器<${MicroLabel}>PICK<//></span>'), '多命中时渲染选服列表');
});

test('房间列表小节：统计 + 全部/可加入 + 每行 房号/席位/难度/剩余/加入', () => {
  const body = lobbyRender();
  assert.ok(body.includes('<span style="opacity:.7">共 ${merged.length} 个 · 可加入 ${waitingCount}</span>'), '统计行');
  assert.ok(body.includes("setRoomFilter('all')"), '「全部」筛选');
  assert.ok(body.includes("setRoomFilter('waiting')"), '「可加入」筛选');
  assert.ok(LOBBY.includes("var roomRowStyle = 'display:flex;align-items:center;gap:8px;padding:6px 2px 5px;'"), '行样式（2.9.31 逐字）');
  assert.ok(LOBBY.includes('${tokens[r.code] ? html`<button type="button" class="set-apply" style="border-color:#4ed8af;color:#4ed8af"'),
    '自己的房（本机 token）→ 行内「备注」');
  assert.ok(LOBBY.includes('onClick=${function () { destroyRoom(r); }}>销毁</button>'), '自己的房 → 行内「销毁」');
  assert.ok(LOBBY.includes('${r.code}'), '行首是房号');
});

test('硬接口：openShellPanel(\'lobby\') 落在本页（注册表优先于内置面板）', () => {
  assert.ok(/registerPanel\('lobby', LobbyPanel\)/.test(LOBBY), "registerPanel('lobby', LobbyPanel) 链必须完整");
  // 页面侧的入口断言：__SP_LOBBY.open() = openPanel('lobby')（标题页/延迟胶囊将来直接调它）
  assert.ok(LOBBY.includes("window.__SP_SHELL.openPanel('lobby')"), 'window.__SP_LOBBY.open 必须打开 lobby 面板');
  // 宿主先查注册表，再走内置 kind → 同名 'lobby' 永远命中本页；且 'lobby' 不是内置 kind
  const get = PANELS.indexOf('panelRegistry.get(kind)');
  const builtin = PANELS.indexOf("if (kind === 'servers')");
  assert.ok(get > 0 && builtin > get, '注册表查询必须先于内置面板分支');
  assert.ok(!/if \(kind === 'lobby'\)/.test(PANELS), "'lobby' 不许变成内置面板（否则与本页抢路由）");
});

test('仍是经典脚本 + 面板宿主自挂载（re 线零补丁）', () => {
  const first = LOBBY.split('\n')[0];
  assert.ok(/^\/\* global [^*]*\*\/ /.test(first), '首行必须是 ESLint 用的 /* global */ 头（面板脚本按经典脚本检查）');
  assert.ok(first.includes('window') && first.includes('document'), '/* global */ 头要声明浏览器全局');
  for (const line of LOBBY.split('\n')) {
    assert.ok(!/^\s*(?:import\s|export\s)/.test(line), '经典脚本不许出现顶层 import/export：' + line.slice(0, 60));
  }
  assert.ok(LOBBY.includes('whenDepsReady'), '注册前必须等 shellPanels 依赖落地（whenDepsReady）');
  assert.ok(LOBBY.includes('mountShellPanelHost'), '依赖就绪后必须自挂载面板宿主');
});
