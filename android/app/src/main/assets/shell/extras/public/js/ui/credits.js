/* global window */
// js/ui/credits.js -- 感谢名单（the thanks list）as DATA, with the two display helpers the two
// drawing sites share. ONE source, two runners:
//   · js/ui/preloadPanel.js  the floating window's runner  (vertical  : translateY, 4 stacked copies)
//   · js/first-screen.js     the full-screen first interface (horizontal: translateX, 4 inline copies)
//
// PROVENANCE (2026-10-13, branch ui/redraw-function-panel): the const block below was MOVED verbatim
// out of js/ui/preloadPanel.js (its lines 261-310 in the 2026-10-13 revision) when the owner asked
// for the thanks list to also run along the bottom of the new full-screen first interface. Keeping
// one copy is the point: the list is real data (no invented names) and the two runners must never
// drift apart.
//
// 真源（2026-10-12 核对，按 owner 口径「用真实名单，不编造」）：
// 真源（业主口径「用真实名单，不编造」）：
//   线上  GET https://ganxiemingdan.jiangjiangze.icu/data/thanks.json
//          → v=2, updated 2026-10-19, prefix bilibili_, **13 条**（站点页面渲染用的就是这一份）。
//   ⚠ 2026-10-20 实测：早先内嵌副本与 fetch 地址用的 `/api/thanks` 现在返回的是 **HTML 壳**
//     （站点改成 SPA 路由），不是 JSON ⇒ 那条静默拉取一直在 catch 里失败，APK 跑的一直是
//     2026-10-11 的 7 条旧名单。本条把内嵌快照换成线上那一版，并把 fetch 地址改到 /data/thanks.json。
//   仓库副本 C:\DDDD\Agent Work\stronghold-thanks\data\thanks.json（v=1 内置兜底，6 条）。
// 这里内嵌线上那一版（条数更全、更新更近），并按网页同一套排版口径渲染：
//   大字 = 名字（前缀 bilibili_ 用 mint 小字，见 stronghold-thanks/js/thanks.js displayName/buildUnits），
//   小字 = 角色备注（见 stronghold-thanks/css/thanks.css .thanks-item__name / .thanks-item__role）。
// 为什么内嵌 + 拉取双轨：叠加层面板不联网（服务器页上跨域、也怕拖慢首屏），名单随叠加层一起热更新
// —— 改名单 = 改这里 + 重新分发 extras。联网成功则**静默替换**成线上那份（10 分钟 TTL），
// 失败就继续用内嵌兜底，不提示、不报错（业主 2026-10-13 口径：要静默自动跟上）。

export const CREDITS_PREFIX = 'bilibili_';

/** 内嵌兜底 = 线上 2026-10-19 那一版的快照（v=2 / 13 条）。名单变更时同步刷新这里。 */
export const CREDITS_NAMES = [
  { name: 'Ausevay', role: '一切的起点' },
  { name: '纸鸢安好', role: '安卓端适配的神' },
  { name: '水沫沐沐', role: 'MOD管理器作者' },
  { name: 'jingjiangze', role: '兼容MOD管理器' },
  { name: '剑光卤煮-斩尽牛杂', role: '新开一期卫' },
  { name: '不知名信箱', role: '开发者功能扩展' },
  { name: '雨千代Chiyo', role: '原版UI' },
  { name: '伊佐那邪_', role: '多功能优化Mod' },
  { name: 'Sakanine', role: '' },
  { name: '万い（千万言语）', role: '百人服家宽暴力开' },
  { name: 'Daisy_delis', role: '安卓端优化+创意工坊' },
  { name: '喵33是cjb', role: '吃白饭' },
  { name: 'Vhrqis', role: '' },
];

/** 一条名单的显示名与拆出的前缀（与 stronghold-thanks/js/thanks.js 的 displayName 同口径）。 */
export function creditUnit(item) {
  const name = String((item && item.name) || '').trim();
  const role = String((item && item.role) || '').trim();
  const p = (item && Object.prototype.hasOwnProperty.call(item, 'prefix')) ? String(item.prefix == null ? '' : item.prefix) : CREDITS_PREFIX;
  const full = (p && name.indexOf(p) !== 0) ? p + name : name;
  const pre = (p && name.indexOf(p) !== 0) ? p : '';
  return { label: pre ? full.slice(pre.length) : full, pre: pre, role: role, lead: false };
}

/** 跑马灯里的全部条目：先「感谢名单 / THANKS LIST」标题条，再逐条真实名单。 */
export function creditList() {
  const out = [{ label: '感谢名单', pre: '', role: 'THANKS LIST', lead: true }];
  for (let i = 0; i < CREDITS_NAMES.length; i++) out.push(creditUnit(CREDITS_NAMES[i]));
  return out;
}

/** 四份完全相同的副本（横向）：轨道宽度 = 4C，动画走 -25% 正好是一份 C —— 首尾无缝。
 *  （一份 C 至少要能盖住容器宽度的 1/3，四份足够覆盖宽屏与窄屏两种极端。
 *  纵向跑法用同一组副本常量，见 first-screen.js / preloadPanel.js 各自的轨道。） */
export const CREDIT_COPIES = [0, 1, 2, 3];

/** 线上真源（业主 2026-10-13：名单已更新，要**静默自动**跟上，不弹热更新提示）。
 *  审计（2026-10-20）：地址必须是 `/data/thanks.json` —— `/api/thanks` 现在返回 HTML 壳（SPA 路由）。
 *  该路径实测带 `Access-Control-Allow-Origin: *`，所以叠加层可以直接 fetch，不需要走 shell 桥。
 *  双保险：r.json() 若拿到 HTML 会抛，被 catch 吃掉 ⇒ 继续用内嵌兜底，绝不提示、不报错。 */
export const CREDITS_URL = 'https://ganxiemingdan.jiangjiangze.icu/data/thanks.json';
const CREDITS_TTL_MS = 10 * 60 * 1000;   // 10 分钟内不重复拉
let _fetched = { at: 0, list: null };

/** 静默拉取线上名单；返回与 creditList() 同形状的数组，拿不到就 null。绝不抛、绝不提示。 */
export function fetchCredits(force) {
  const now = Date.now();
  if (!force && _fetched.list && now - _fetched.at < CREDITS_TTL_MS) return Promise.resolve(_fetched.list);
  try {
    if (typeof fetch !== 'function') return Promise.resolve(null);
  } catch (e) { return Promise.resolve(null); }
  return fetch(CREDITS_URL, { cache: 'no-store' })
    .then(function (r) { return r && r.ok ? r.json() : null; })
    .then(function (doc) {
      const names = doc && Array.isArray(doc.names) ? doc.names : null;
      if (!names || !names.length) return null;
      const prefix = typeof doc.prefix === 'string' ? doc.prefix : CREDITS_PREFIX;
      const list = names.filter(function (n) { return n && typeof n.name === 'string' && n.name; })
        .map(function (n) { return { label: n.name, role: typeof n.role === 'string' ? n.role : '', pre: prefix, lead: !!prefix } });
      if (!list.length) return null;
      _fetched = { at: now, list: list };
      return list;
    })
    .catch(function () { return null; });   // 静默：网络/CORS/解析失败都只是继续用兜底
}

