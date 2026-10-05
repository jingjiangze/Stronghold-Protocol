// js/ui/shellPanels.js — in-page shell panels styled exactly like the game's own settings modal
// (Modal frame + .set-list/.set-row/.set-seg — same components the QUALITY row uses).
// Panels: 服务器 (line switching), 参数 (host-server parameters, App only), 配置 (player-data
// summary + export/import) and 战绩 (local battle log). The host (ShellPanelHost) is mounted on
// the app root (main.js, v3.5) so the latency pill opens the server panel on every screen.
// Domains are never shown: lines are identified by name only.
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button, MicroLabel } from './components.js';
import { store } from '../store.js';

/** v4.0: 构造跳转 URL —— 保留目标 origin/pathname，合并当前页查询（room 可覆盖），`#` 始终最后。
 *  统一替代旧的 `url.replace(/\/+$/,'') + '/' + location.search`（在 /play 上补回 `/` 产生 404）。 */
function navUrl(base, room) {
  const u = new URL(String(base || ''), location.href);
  new URLSearchParams(location.search).forEach((v, k) => u.searchParams.set(k, v));
  if (room != null) u.searchParams.set('room', String(room));
  return u.toString();
}

/** v4.1: 延迟色点 —— 不再显示数值，返回 { color, title }。
 *  已停用灰 / 不可达红 / 未知灰 / <150ms 绿 / <400ms 黄 / 其余红（title 不写 ms）。 */
function rttDot(ms, enabled, reachable) {
  if (enabled === false) return { color: '#8a9a93', title: '已停用' };
  if (!Number.isFinite(ms) || ms <= 0) {
    if (reachable === false) return { color: '#e06c5a', title: '无法连接' };
    return { color: '#8a9a93', title: '延迟未知' };
  }
  if (ms < 150) return { color: '#4ed8af', title: '延迟良好' };
  if (ms < 400) return { color: '#e0b64a', title: '延迟一般' };
  return { color: '#e06c5a', title: '延迟较差' };
}

/** True while a match is running — the shell bans server switching from start to finish. */
function inMatch() {
  try {
    return !!(store.get().room && store.get().room.inMatch);
  } catch (e) {
    return false;
  }
}

/** Panel store: 'servers' | 'params' | 'join' | 'config' | 'records' | null, broadcast on a
 *  window event so the shell can drive it too. */
let panelState = null;
const listeners = new Set();

function setPanel(kind) {
  panelState = kind;
  for (const fn of listeners) fn(kind);
  try { window.dispatchEvent(new CustomEvent('sp-panel', { detail: kind })); } catch (e) { /* old browser */ }
}

export function openShellPanel(kind) {
  setPanel(kind);
}

export function useShellPanel() {
  const [kind, set] = useState(panelState);
  useEffect(() => {
    const fn = (k) => set(k);
    listeners.add(fn);
    const onEvt = (e) => set(e.detail || null);
    window.addEventListener('sp-panel', onEvt);
    return () => { listeners.delete(fn); window.removeEventListener('sp-panel', onEvt); };
  }, []);
  return [kind, () => setPanel(null)];
}

// ---------------------------------------------------------------------------------------------------
// Server switching (name-only list; URLs stay inside the shell)
// ---------------------------------------------------------------------------------------------------

function fmtRtt(ms) {
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) + 'ms' : '--';
}

/** 版本(app)：0.1.2 → v0.1.2；已带前缀就原样显示。 */
function fmtApp(app) {
  const s = String(app || '');
  if (!s) return '';
  return /^\d/.test(s) ? 'v' + s : s;
}

/** 清单更新时间（Java 侧新增 updated 字段后才显示；秒/毫秒/ISO 字符串都接受）。 */
function fmtUpdated(v) {
  if (v == null || v === '') return '';
  let d;
  if (typeof v === 'number' && Number.isFinite(v)) d = new Date(v < 1e12 ? v * 1000 : v);
  else d = new Date(v);
  if (!Number.isFinite(d.getTime())) return '';
  try { return d.toLocaleString('zh-CN', { hour12: false }); } catch (e) { return ''; }
}

// ---------------------------------------------------------------------------------------------------
// 玩家数据 v1（配置 / 战绩 面板的只读来源；导出/导入按钮）
// App：Java 桥 window.spData.get()（真源 filesDir/player-v1.json）；网页：window.__SP_DATA
// （player-data.js，IndexedDB/localStorage）。所有访问 try/catch 静默，面板永不打断游戏。
// ---------------------------------------------------------------------------------------------------

function readPlayerDoc() {
  const parse = (raw) => {
    try {
      const d = raw ? JSON.parse(raw) : null;
      return d && typeof d === 'object' ? d : null;
    } catch (e) { return null; }
  };
  try {
    if (window.spData && typeof window.spData.get === 'function') {
      const d = parse(window.spData.get());
      if (d) return d;
    }
  } catch (e) { /* no shell bridge */ }
  try {
    if (window.__SP_DATA && typeof window.__SP_DATA.exportJSON === 'function') {
      const d = parse(window.__SP_DATA.exportJSON());
      if (d) return d;
    }
  } catch (e) { /* no player-data module */ }
  return null;
}

/** The doc as text for the export button (same source order as readPlayerDoc). */
function exportPlayerJson() {
  try {
    if (window.__SP_DATA && typeof window.__SP_DATA.exportJSON === 'function') {
      const t = String(window.__SP_DATA.exportJSON() || '');
      if (t) return t;
    }
  } catch (e) { /* ignore */ }
  try {
    if (window.spData && typeof window.spData.get === 'function') return String(window.spData.get() || '');
  } catch (e) { /* ignore */ }
  return '';
}

/** 复制：App 剪贴板桥 window.shell.copyText → navigator.clipboard → textarea 选中兜底。 */
function copyText(text) {
  const s = String(text == null ? '' : text);
  if (!s) return Promise.resolve(false);
  try {
    if (window.shell && typeof window.shell.copyText === 'function') {
      window.shell.copyText(s);
      return Promise.resolve(true);
    }
  } catch (e) { /* fall through to the browser API */ }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(s).then(() => true, () => fallbackCopy(s));
    }
  } catch (e) { /* fall through */ }
  return Promise.resolve(fallbackCopy(s));
}

function fallbackCopy(s) {
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ta.setSelectionRange(0, ta.value.length); } catch (e) { /* ignore */ }
    const ok = document.execCommand ? document.execCommand('copy') : false;
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) { return false; }
}

function readServerList() {
  try {
    if (window.shell && window.shell.getServerList) {
      const o = JSON.parse(window.shell.getServerList());
      if (o && Array.isArray(o.entries)) return o;
    }
  } catch (e) { /* ignore */ }
  return { source: '', entries: [] };
}

/** 网页（无 shell）回退行：__SP_SHELL.getServers()（shell-bridge.js 的静态线路表）→ 面板行；
 *  拿不到就只留「自动线路」（= 当前网页）。 */
function webRows() {
  let arr = [];
  try {
    if (window.__SP_SHELL && typeof window.__SP_SHELL.getServers === 'function') {
      const r = window.__SP_SHELL.getServers();
      const parsed = typeof r === 'string' ? JSON.parse(r) : r;
      if (Array.isArray(parsed) && parsed.length) arr = parsed;
    }
  } catch (e) { arr = []; }
  if (!arr.length) arr = [{ id: 'auto', label: '自动线路', url: '', current: true }];
  return arr.map((s, i) => ({
    key: 'web:' + (s.id || i),
    id: s.id || 'auto',
    name: s.label || '自动线路',
    note: '', app: '', rttMs: -1, enabled: true,
    current: !!s.current,
    url: typeof s.url === 'string' ? s.url : '',
  }));
}

/** v4.5: 一次性布防（v3.6 契约）—— 服务器面板与大厅 QuickModes 共用。
 *  切服/重载后由标题页 takeAutostart() 取用一次，随即自动进入。 */
function armAutostart() {
  try { if (window.shell && typeof window.shell.setAutostart === 'function') window.shell.setAutostart(); } catch (e) { /* ignore */ }
}

/** v4.5: 统一切服 / 跳转（服务器面板 pick 与 QuickModes 共用，避免两处复制逻辑）。
 *  row: { id, enabled, url }；opts: { onClose, onNote, locked }。
 *  返回 true 表示已处理（已切换 / 已跳转 / 自动线路无需动作）。 */
function switchTo(row, opts) {
  const o = opts || {};
  const close = typeof o.onClose === 'function' ? o.onClose : function () {};
  const note = typeof o.onNote === 'function' ? o.onNote : function () {};
  if (o.locked) { note('对局进行中，无法切换服务器。结束后再切换。'); return false; }
  const native = typeof window !== 'undefined' && window.shell && typeof window.shell.setServer === 'function';
  if (!native) {
    const url = String(row.url || '');
    if (!url) {
      if (row.id === 'auto') { close(); return true; } // 自动 = 当前 origin，无需跳转
      note('无法获取该线路地址，请用下方自定义服务器手动切换');
      return false;
    }
    try { location.href = navUrl(url); return true; } catch (e) { note('无法跳转，请手动切换服务器'); return false; }
  }
  if (row.enabled === false) return false; // 已停用：禁止加入（v3.3 起版本差异不再拦截）
  try { window.shell.setServer(row.id); } catch (e) { /* ignore */ } // auto/local 走原语义
  armAutostart(); // 选中即进入：面板关闭 → 切服重载 → 标题页自动 start()
  close();
  return true;
}

/** v4.5: 单行格（服务器面板与 QuickModes 共用）—— 名称 · v版本 · 延迟色点；
 *  「当前」= 小圆点 + 薄荷描边。截断/不换行/两列网格都在 CSS（.sp-srv-*），行内只留延迟色点。 */
function serverCell(e, onPick) {
  // v4.9: 行可自带固定点（本机服务/自动线路没有 RTT 概念 → 恒绿点「可用」）；停用行仍走灰点。
  const dot = e.enabled === false
    ? rttDot(e.rttMs, false, e.reachable)
    : (e.dot ? { color: e.dot, title: e.dotTitle || '' } : rttDot(e.rttMs, e.enabled, e.reachable));
  return html`<div key=${e.key} class=${'sp-srv-cell' + (e.current ? ' is-cur' : '') + (!e.enabled ? ' is-off' : '')}>
    <button type="button" class="sp-srv-main" title=${(e.note ? e.note + ' · ' : '') + e.name}
      disabled=${!e.enabled}
      onClick=${() => onPick(e)}>
      ${e.current ? html`<span class="sp-srv-cur"></span>` : null}
      <span class="sp-srv-name">${e.name}</span>
      ${e.app ? html`<span class="sp-srv-ver">${fmtApp(e.app)}</span>` : null}
      <span class="sp-srv-rtt" style=${'flex:0 0 auto;width:.11rem;height:.11rem;border-radius:50%;background:' + dot.color} title=${dot.title}></span>
    </button>
  </div>`;
}

/** v4.5: 顶部快捷入口（本机服务 / 自动线路）—— 服务器面板与大厅面板共用同一组件与同一套切换行为。
 *  props: onClose（关闭面板）、onNote（可选，就地提示）、locked（对局中只读）。
 *  内部读取本机服务版本 / 当前态；无 hooks，便于测试直接调用取 vnode。
 *  网页（无 shell）时「本机服务」置灰（App 专属），「自动线路」= 当前页。 */
export function QuickModes(props) {
  const onClose = props && props.onClose;
  const onNote = props && props.onNote;
  const locked = !!(props && props.locked);
  const native = typeof window !== 'undefined' && window.shell && typeof window.shell.setServer === 'function';
  const list = readServerList();
  let localCurrent = false;
  try {
    const arr = JSON.parse(window.shell.getServers());
    const l = Array.isArray(arr) ? arr.find((x) => x && x.id === 'local') : null;
    localCurrent = !!(l && l.current);
  } catch (e) { /* 旧壳 / 网页：无当前态 */ }
  const pick = (e) => switchTo(e, { onClose: onClose, onNote: onNote, locked: locked });
  // v4.9: 本机服务 / 自动线路没有 RTT 概念（不是远端房间），固定绿点表示「可用」。
  const rows = [
    { key: 'local', id: 'local', name: '本机服务', note: '单机开房', app: native ? (list.localApp || '') : '', rttMs: -1, enabled: native, current: native && localCurrent, dot: '#4ed8af', dotTitle: '可用' },
    { key: 'auto', id: 'auto', name: '自动线路', note: '延迟最优', app: '', rttMs: -1, enabled: true, current: !native, dot: '#4ed8af', dotTitle: '可用' },
  ];
  return rows.map((e) => serverCell(e, pick));
}

function ServerPanel({ onClose }) {
  const native = typeof window !== 'undefined' && window.shell && typeof window.shell.setServer === 'function';
  const [list, setList] = useState(readServerList);
  // v4.5: 本机服务版本 / 当前态由 QuickModes 组件内部读取（顶部两格与大厅共用）。
  const [custom, setCustom] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  const [note, setNote] = useState('');

  // the shell pushes a fresh (verified, probed) list after refreshServerList()
  useEffect(() => {
    const onServers = (e) => { try { setList(JSON.parse(e.detail)); } catch (err) { /* ignore */ } };
    window.addEventListener('sp-servers', onServers);
    if (native && window.shell.refreshServerList) {
      try { window.shell.refreshServerList(); } catch (e) { /* ignore */ }
    }
    return () => window.removeEventListener('sp-servers', onServers);
  }, []);

  const locked = inMatch(); // 战斗中禁切：面板只读（owner 决定：inMatch 即禁）

  function blocked() { return locked; } // v4.5: 连接路径弹窗已移除，只保留对局禁切判断

  // v4.5: 切换行为已抽到模块级 switchTo（QuickModes 共用），这里只做面板侧接线。
  function pick(row) { switchTo(row, { onClose: onClose, onNote: setNote, locked: locked }); }

  function applyCustom() {
    if (blocked()) return;
    let v = String(custom || '').trim();
    if (!v) return;
    if (!/^https?:\/\//.test(v)) v = 'https://' + v;
    v = v.replace(/\/+$/, '');
    if (native) {
      try { window.shell.setServer('custom:' + v); } catch (e) { /* ignore */ }
      armAutostart();
      onClose();
      return;
    }
    location.href = navUrl(v);
  }

  const entries = list.entries || [];
  // 清单更新时间：Java 侧可能新增顶层 updated 或条目内 updated（有就显示，无则静默）
  const updatedRaw = list.updated != null
    ? list.updated
    : (entries.find((e) => e && e.updated != null) || {}).updated;
  const updatedText = fmtUpdated(updatedRaw);
  // 统一列表（v3.6）：清单服务器同列；自定义输入行殿后。
  // v4.5: 本机服务 / 自动线路 改由顶部 QuickModes 渲染（与大厅面板同一组件），此处只列清单条目。
  // 房间制（CF Workers）服务器不展示：Java getServerList 已过滤，这里再滤一次旧 payload。
  // 仅隐藏展示：邀请码路径（shell.joinOnOrigin）对房间制服务器的底层能力不变。
  const rows = (native ? entries.map((e) => ({ ...e, key: e.id })) : webRows())
    .filter((e) => e && !e.roomScoped && e.id !== 'local' && e.id !== 'auto');

  /** 单行格：名称 · v版本 · 延迟色点；「当前」= 小圆点 + 薄荷描边。
   *  v4.5: 渲染与点击行为都抽到模块级 serverCell / QuickModes，这里不再复制。 */

  return html`<${Modal} open=${true} onClose=${onClose} title="服务器" micro="SERVER" width="10.4rem"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      ${locked ? html`<p class="set-hint" style="margin:0 0 6px;border:1px solid #e0b64a;border-radius:4px;padding:8px 10px;color:#e0b64a">
        对局进行中，无法切换服务器。结束后再切换。
      </p>` : null}
      <div class="set-row">
        <span class="set-row__label">服务器清单<${MicroLabel}>LIST<//></span>
        <div style="grid-column:2 / 4;min-width:0">
          <div class="sp-srv-grid"><${QuickModes} onClose=${onClose} onNote=${setNote} locked=${locked} />${rows.map((e) => serverCell(e, pick))}</div>
          ${!rows.length ? html`<p class="set-hint set-hint--tight">${list.loading ? '正在获取清单…' : '暂无可用服务器'}</p>` : null}
          ${updatedText ? html`<p class="set-hint set-hint--tight">清单更新于 ${updatedText}</p>` : null}
          ${native && window.shell.refreshServerList
            ? html`<button type="button" class="set-apply" onClick=${() => { try { window.shell.refreshServerList(); } catch (e) { /* ignore */ } }}>刷新清单</button>`
            : null}
        </div>
      </div>
      <div class="set-row">
        <span class="set-row__label">自定义服务器<${MicroLabel}>CUSTOM<//></span>
        <input class="set-input" type="text" value=${custom} placeholder="输入地址"
          onFocus=${() => setCustomOpen(true)}
          onInput=${(e) => setCustom(e.currentTarget.value)} />
        <button type="button" class="set-apply" disabled=${!customOpen || custom === ''} onClick=${applyCustom}>应用</button>
      </div>
      ${note ? html`<p class="set-hint set-hint--tight">${note}</p>` : null}
      <p class="set-hint">
        点格子即切换到该服务器并自动进入。「本机服务」= 单机开房（按需启动）；「自动线路」= 按实测延迟选最优。
        清单为签名清单，验签失败会自动回退内置；延迟由本机实测，未探测显示 --。
      </p>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------------
// 跨服邀请码（v2.7.0）：输入 4 位码 → shell-join.js 并发探针（目录 + 各 node 服 WS 试探）→
// 单一命中直接加入；多服命中弹本选择器（按本机延迟排序，域名不出现在界面）。
// ---------------------------------------------------------------------------------------------------

const FONT_SEG = [['0.85', '较小'], ['0.95', '标准'], ['1.05', '较大'], ['1.15', '特大']];
const PAD_SEG = [['0', '无'], ['8', '小'], ['16', '中'], ['24', '大']];

function JoinPanel({ onClose }) {
  const native = typeof window !== 'undefined' && window.shell && typeof window.shell.joinOnOrigin === 'function';
  const [code, setCode] = useState('');
  const [state, setState] = useState('idle'); // idle | probing | pick | none | cooldown
  const [entries, setEntries] = useState([]);
  const [note, setNote] = useState('');

  const normalized = String(code || '').toUpperCase().replace(/[^A-HJ-NP-Z]/g, '').slice(0, 4);
  const locked = inMatch(); // 跨服加入同样会切服：对局中一并禁止（与服务器面板一致）

  function pick(entry) {
    if (locked) { setState('none'); setNote('对局进行中，无法跨服加入。结束后再试。'); return; }
    if (native) {
      try { window.shell.joinOnOrigin(entry.id, normalized); } catch (e) { /* ignore */ }
      onClose();
      return;
    }
    // plain web build: navigate with the deep link (same-origin probe hit)
    try { location.href = navUrl(location.href, normalized); } catch (e) { /* ignore */ }
  }

  function go() {
    if (normalized.length !== 4) return;
    if (!window.__SP_JOIN) { setNote('探测模块未加载（较旧版本）'); setState('none'); return; }
    setState('probing');
    setNote('正在跨服查找 ' + normalized + ' …');
    window.__SP_JOIN.resolveCode(normalized).then((r) => {
      if (r.kind === 'directory') {
        // phone-host room: hand the code to the existing room-code join flow
        if (native && window.shell.join) { try { window.shell.join(); } catch (e) { /* ignore */ } }
        setState('none');
        setNote('这是手机房主的房间：请在弹出的房号框直接输入 ' + normalized);
      } else if (r.kind === 'single') {
        pick(r.entry);
      } else if (r.kind === 'conflict') {
        setEntries(r.entries);
        setState('pick');
      } else {
        setState(r.kind === 'cooldown' ? 'cooldown' : 'none');
        setNote(r.note || '未找到该房间');
      }
    }).catch(() => { setState('none'); setNote('查找失败，请稍后重试'); });
  }

  return html`<${Modal} open=${true} onClose=${onClose} title="邀请码加入" micro="INVITE" width="10.4rem"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      <div class="set-row">
        <span class="set-row__label">邀请码<${MicroLabel}>CODE<//></span>
        <input class="set-input" type="text" value=${code} placeholder="4 位字母或数字"
          maxLength="4" style="text-transform:uppercase;letter-spacing:.08em"
          onInput=${(e) => setCode(e.currentTarget.value)} />
        <button type="button" class="set-apply" disabled=${normalized.length !== 4 || state === 'probing'}
          onClick=${go}>${state === 'probing' ? '查找中…' : '查找'}</button>
      </div>
      ${state === 'pick' ? html`
        <div class="set-row">
          <span class="set-row__label">选择服务器<${MicroLabel}>PICK<//></span>
          <div>${entries.map((e) => html`<button key=${e.id} type="button"
            style=${'display:block;width:100%;margin:4px 0;padding:8px 10px;background:transparent;'
              + 'border:1px solid #2c3a35;color:#d8e3de;border-radius:4px;font-size:13px;cursor:pointer;text-align:left'}
            onClick=${() => pick(e)}>
            ${e.name} · ${fmtRtt(e.rttMs)}${e.note ? ' · ' + e.note : ''}
          </button>`)}</div>
        </div>` : null}
      ${note ? html`<p class="set-hint set-hint--tight">${note}</p>` : null}
      <p class="set-hint">
        同一邀请码可能存在于多台服务器；查找会并发试探清单内全部服务器（约 3 秒），
        多处命中时按本机延迟排序供选择。手机房主的房间仍走房号直连。
      </p>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------------
// Host-server parameters (App only) — segmented controls in the game's own style, hot-switched
// ---------------------------------------------------------------------------------------------------

const HOST_BIND = [['::', '全部网卡'], ['127.0.0.1', '仅本机']];
const COMBAT = [['client', '各自模拟'], ['server', '房主统一']];
const VERIFY = [['off', '不校验'], ['sample', '抽查'], ['all', '全量']];
const PROXY = [['auto', 'auto'], ['1', '信任'], ['0', '不信任']];

function readParams() {
  try {
    if (window.shell && window.shell.getParams) return JSON.parse(window.shell.getParams());
  } catch (e) { /* fall through to defaults */ }
  return { port: 3000, hostBind: '::', spCombat: 'client', spVerify: 'off', trustProxy: 'auto' };
}

function SegRow({ label, micro, options, value, onChange, note }) {
  return html`<div class="set-row">
    <span class="set-row__label">${label}<${MicroLabel}>${micro}<//></span>
    <div class="set-seg" role="radiogroup">
      ${options.map(([id, text]) => html`<button key=${id} type="button" role="radio"
        aria-checked=${value === id ? 'true' : 'false'} class=${value === id ? 'is-on' : ''}
        onClick=${() => onChange(id)}>${text}</button>`)}
    </div>
    ${note ? html`<p class="set-hint set-hint--tight">${note}</p>` : null}
  </div>`;
}

function ParamsPanel({ onClose }) {
  const native = typeof window !== 'undefined' && window.shell && typeof window.shell.setParamsJson === 'function';
  const [p, setP] = useState(readParams);
  const upd = (k, v) => setP((old) => ({ ...old, [k]: v }));

  if (!native) {
    return html`<${Modal} open=${true} onClose=${onClose} title="参数（仅本地服务）" micro="PARAMS" width="10.4rem"
      actions=${html`<${Button} variant="primary" onClick=${onClose}>完成<//>`}>
      <div class="set-list"><p class="set-hint">房主参数仅在 App 版可用，且只作用于本机房主服务。</p></div>
    <//>`;
  }

  function save() {
    try {
      window.shell.setParamsJson(JSON.stringify(p));
      if (window.shell.restartHost) window.shell.restartHost();
    } catch (e) { /* ignore */ }
    onClose();
  }

  return html`<${Modal} open=${true} onClose=${onClose} title="参数（仅本地服务）" micro="PARAMS" width="10.4rem"
    actions=${html`<${Button} variant="secondary" onClick=${() => setP(readParams())}>恢复默认<//>
      <${Button} variant="primary" icon="check" onClick=${save}>保存并重启房主服务<//>`}>
    <div class="set-list">
      <p class="set-hint set-hint--tight">（仅本地服务）以下参数只作用于本机开启的房主服务，不影响线上线路。</p>
      <div class="set-row">
        <span class="set-row__label">端口<${MicroLabel}>PORT<//></span>
        <input class="set-input" type="number" min="1024" max="65535" value=${p.port}
          onInput=${(e) => upd('port', Number(e.currentTarget.value) || 3000)} />
      </div>
      <${SegRow} label="监听地址" micro="HOST" options=${HOST_BIND} value=${p.hostBind}
        onChange=${(v) => upd('hostBind', v)} note="全部网卡 = 朋友可直连（推荐）；仅本机 = 单机练习" />
      <${SegRow} label="战斗模拟" micro="COMBAT" options=${COMBAT} value=${p.spCombat}
        onChange=${(v) => upd('spCombat', v)} note="各自模拟省电（推荐）；房主统一模拟耗电高，仅设备强时选" />
      <${SegRow} label="结果校验" micro="VERIFY" options=${VERIFY} value=${p.spVerify}
        onChange=${(v) => upd('spVerify', v)} note="全量校验最耗性能；抽查为折中" />
      <${SegRow} label="信任代理" micro="TRUST PROXY" options=${PROXY} value=${p.trustProxy}
        onChange=${(v) => upd('trustProxy', v)} note="直连场景保持 auto 即可" />
      <p class="set-hint">保存后自动热切换（仅重启内嵌房主服务，约 2 秒），无需重启应用。</p>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------------
// 配置 (player data): summary of the local doc + export/import (v3.5)
// ---------------------------------------------------------------------------------------------------

function ConfigPanel({ onClose }) {
  const [doc, setDoc] = useState(readPlayerDoc);
  const [note, setNote] = useState('');
  const profile = (doc && doc.profile) || {};
  const count = (map) => (doc && map && typeof map === 'object' ? Object.keys(map).length : 0);
  const loadouts = count(doc && doc.loadouts);
  const servers = count(doc && doc.servers);
  const rooms = count(doc && doc.rooms);
  const battles = doc && Array.isArray(doc.battles) ? doc.battles.length : 0;
  const dev = doc && typeof doc.deviceId === 'string' ? doc.deviceId.slice(0, 8) : '';

  function copy() {
    const text = exportPlayerJson();
    if (!text) { setNote('暂无玩家数据可导出'); return; }
    copyText(text).then((ok) => setNote(ok ? '已复制导出 JSON，可粘贴保存或分享' : '复制失败：请改用系统导出方式'));
  }

  function importFromClipboard() {
    let text = null;
    try {
      if (window.shell && typeof window.shell.readClipboard === 'function') text = String(window.shell.readClipboard() || '');
    } catch (e) { text = null; }
    if (text == null) { setNote('剪贴板读取不可用（需 App 支持）'); return; }
    if (!text.trim()) { setNote('剪贴板为空'); return; }
    let ok = false;
    try {
      if (window.__SP_DATA && typeof window.__SP_DATA.importJSON === 'function') ok = !!window.__SP_DATA.importJSON(text);
      // old App trees without player-data.js: the Java bridge owns the same merge
      else if (window.spData && typeof window.spData.importJson === 'function') ok = !!window.spData.importJson(text);
    } catch (e) { ok = false; }
    if (ok) { setDoc(readPlayerDoc()); setNote('导入成功：数据已合并到本机'); }
    else setNote('导入失败：剪贴板内容不是有效的玩家数据');
  }

  return html`<${Modal} open=${true} onClose=${onClose} title="配置" micro="PLAYER DATA" width="10.4rem"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      <div class="set-row">
        <span class="set-row__label">代号<${MicroLabel}>CALLSIGN<//></span>
        <p class="set-hint set-hint--tight" style="grid-column:2 / 4;margin:0">${profile.name || '—'}</p>
      </div>
      <div class="set-row">
        <span class="set-row__label">数据摘要<${MicroLabel}>SUMMARY<//></span>
        <p class="set-hint set-hint--tight" style="grid-column:2 / 4;margin:0">
          干员配置 ${loadouts} 条 · 服务器 ${servers} 个 · 房间 ${rooms} 个 · 战绩 ${battles} 条
        </p>
      </div>
      <div class="set-row">
        <span class="set-row__label">设备标识<${MicroLabel}>DEVICE<//></span>
        <p class="set-hint set-hint--tight" style="grid-column:2 / 4;margin:0">${dev ? dev + '…' : '—'}</p>
      </div>
      <div class="set-row">
        <span class="set-row__label">导出备份<${MicroLabel}>EXPORT<//></span>
        <button type="button" class="set-apply" onClick=${copy}>复制导出 JSON</button>
      </div>
      <div class="set-row">
        <span class="set-row__label">恢复导入<${MicroLabel}>IMPORT<//></span>
        <button type="button" class="set-apply" onClick=${importFromClipboard}>从剪贴板导入</button>
      </div>
      ${note ? html`<p class="set-hint set-hint--tight">${note}</p>` : null}
      <p class="set-hint">
        玩家数据仅保存在本机（App 为应用私有目录，网页为浏览器存储），与当前线路无关；
        导出文本可在其他设备或线路导入合并，导入只补新、不改写较新的本机记录。
      </p>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------------
// 战绩 (local battle log, v4.10): summary + filters + newest-first rows + per-battle detail.
// Data = the local player-v1 document; aggregation via __SP_DATA.battleStats (the same 口径 as
// the Workers-based servers, so numbers are comparable). All local — no account, no network.
// ---------------------------------------------------------------------------------------------------

const DIFF_LABELS = { FUNNY: '标准', NORMAL: '险境', HARD: '绝境', ABYSS: '终极' };
const DIFF_ORDER = ['FUNNY', 'NORMAL', 'HARD', 'ABYSS'];
const STAT_LABELS = [
  ['dmgDealt', '造成伤害'], ['kills', '击倒敌人'], ['bossDamage', '领袖伤害'], ['healing', '治疗量'],
  ['merges', '晋升次数'], ['itemsEquipped', '配发装备'], ['gold', '消耗资金'], ['perfectRounds', '完美作战'],
  ['refreshes', '刷新次数'], ['leaks', '未击倒'], ['lpLost', '损失生命'], ['activatedLayers', '盟约层数'],
  ['buys', '购买次数'], ['sells', '出售次数'], ['fundsGained', '获得资金'],
];

function fmtDuration(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function resultLabel(r) {
  return r === 'win' ? '胜利' : r === 'lose' ? '失败' : '—';
}

function resultColor(r) {
  return r === 'win' ? '#4ed8af' : r === 'lose' ? '#e06c5a' : '#8a9a93';
}

function diffLabel(d) {
  const k = String(d || '').toUpperCase();
  return DIFF_LABELS[k] || (d ? String(d) : '—');
}

function modeLabel(m) {
  return m === 'coop' ? '同盟' : m === 'solo' ? '独立' : (m || '—');
}

function statusOf(b) {
  if (b && b.status === 'left') return { text: '提前离开', color: '#e0b64a' };
  if (b && b.status === 'interrupted') return { text: '对局中断', color: '#8a9a93' };
  return { text: resultLabel(b && b.result), color: resultColor(b && b.result) };
}

function fmtPct(v) {
  return Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '—';
}

function fmtTs(ms) {
  const d = new Date(Number(ms) || 0);
  if (!Number.isFinite(d.getTime()) || !d.getTime()) return '—';
  return (d.getMonth() + 1) + '/' + d.getDate() + ' '
    + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

function RecordsPanel({ onClose }) {
  const doc = readPlayerDoc();
  const all = doc && Array.isArray(doc.battles) ? doc.battles.slice() : [];
  all.sort((a, b) => (Number(b && b.ts) || 0) - (Number(a && a.ts) || 0)); // 新 → 旧
  const [mode, setMode] = useState('');
  const [diff, setDiff] = useState('');
  const [openId, setOpenId] = useState('');
  const servers = (doc && doc.servers) || {};
  const serverName = (id) => (id && servers[id] && servers[id].name) || id || '未知服务器';
  const rows = all.filter((b) => (!mode || b.mode === mode)
    && (!diff || String(b.difficulty || '').toUpperCase() === diff)).slice(0, 50);
  let stats = null;
  try {
    if (window.__SP_DATA && typeof window.__SP_DATA.battleStats === 'function') {
      stats = window.__SP_DATA.battleStats(all, { mode: mode, difficulty: diff });
    }
  } catch (e) { stats = null; }
  const rowStyle = 'display:flex;align-items:baseline;gap:10px;padding:6px 2px 5px;'
    + 'border-bottom:1px solid #1e2823;font-size:12px';
  const cell = 'font-variant-numeric:tabular-nums';

  return html`<${Modal} open=${true} onClose=${onClose} title="战绩" micro="RECORDS" width="10.4rem"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      ${stats && stats.total
        ? html`<div class="set-row">
            <span class="set-row__label">统计<${MicroLabel}>STATS<//></span>
            <div style="grid-column:2 / 4;min-width:0;display:flex;flex-direction:column;gap:6px">
              <div style=${rowStyle}>
                <span style="opacity:.75">总场次 <b style=${cell + ';color:#e8e6df'}>${stats.total}</b></span>
                <span style="opacity:.75">胜率 <b style=${cell + ';color:#4ed8af'}>${fmtPct(stats.winRate)}</b></span>
                <span style="opacity:.75">最高回合 <b style=${cell + ';color:#e8e6df'}>${stats.highestRound || '—'}</b></span>
                <span style="opacity:.75">通关 <b style=${cell + ';color:#e8e6df'}>${stats.hidden}</b></span>
                <span style="margin-left:auto;opacity:.55">离开 ${stats.left} · 中断 ${stats.interrupted}</span>
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:4px 14px;opacity:.75;font-size:12px">
                ${STAT_LABELS.map(([k, label]) => (stats.totals[k]
                  ? html`<span key=${k}>${label} <b style=${cell}>${stats.totals[k]}</b></span>` : null))}
              </div>
              ${stats.operators.length
                ? html`<div style="font-size:12px;opacity:.75">常用干员：${stats.operators.slice(0, 6).map((op) => op.id + '×' + op.matches).join(' · ')}</div>`
                : null}
            </div>
          </div>`
        : null}
      <${SegRow} label="模式" micro="MODE" value=${mode}
        options=${[['', '全部'], ['solo', '独立'], ['coop', '同盟']]} onChange=${setMode} />
      <${SegRow} label="难度" micro="DIFF" value=${diff}
        options=${[['', '全部']].concat(DIFF_ORDER.map((d) => [d, DIFF_LABELS[d]]))} onChange=${setDiff} />
      <div class="set-row">
        <span class="set-row__label">记录<${MicroLabel}>MATCHES<//></span>
        <div style="grid-column:2 / 4;min-width:0">
          ${rows.length
            ? html`<div>${rows.map((b, i) => {
                const st = statusOf(b);
                const key = b.id || String(i);
                const open = openId === key;
                return html`<div key=${key}>
                  <div style=${rowStyle + ';cursor:pointer'} onClick=${() => setOpenId(open ? '' : key)}>
                    <b style=${'min-width:3.4em;color:' + st.color}>${st.text}</b>
                    <span style="opacity:.8">${diffLabel(b.difficulty)}</span>
                    <span style=${'opacity:.8;' + cell}>${b.round ? 'R' + b.round : ''}</span>
                    <span style=${'opacity:.8;' + cell}>${fmtDuration(b.duration)}</span>
                    <span style="opacity:.65">${modeLabel(b.mode)}</span>
                    <span style=${'opacity:.55;' + cell}>${fmtTs(b.ts)}</span>
                    <span style="margin-left:auto;opacity:.55;max-width:32%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                      title=${serverName(b.serverId)}>${serverName(b.serverId)}</span>
                  </div>
                  ${open
                    ? html`<div style="padding:6px 2px 8px 12px;border-bottom:1px solid #1e2823;font-size:12px;opacity:.85">
                        ${b.title ? html`<div style="margin-bottom:4px">评语：${b.title}</div>` : null}
                        ${b.operators && b.operators.length
                          ? html`<div style="margin-bottom:4px">干员：${b.operators.join(' · ')}</div>` : null}
                        ${b.stats
                          ? html`<div style="display:flex;flex-wrap:wrap;gap:4px 14px">
                              ${STAT_LABELS.map(([k, label]) => (typeof b.stats[k] === 'number'
                                ? html`<span key=${k}>${label} <b style=${cell}>${b.stats[k]}</b></span>` : null))}
                            </div>`
                          : html`<div style="opacity:.6">该场次无明细（旧记录）</div>`}
                      </div>`
                    : null}
                </div>`;
              })}</div>`
            : html`<p class="set-hint set-hint--tight">${all.length ? '当前筛选下暂无记录' : '暂无战绩'}</p>`}
          <p class="set-hint set-hint--tight">按结算时间倒序，最多显示最近 50 条（筛选后）。点一行展开明细；统计口径与服务器端一致。</p>
        </div>
      </div>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------------
// Panel registry (v2.9): extra panels register themselves instead of editing this file
// (lobby.js calls registerPanel('lobby', LobbyPanel) after its dynamic import).
const panelRegistry = new Map();

export function registerPanel(kind, component) {
  if (typeof kind === 'string' && kind && typeof component === 'function') panelRegistry.set(kind, component);
}

export function ShellPanelHost() {
  const [kind, close] = useShellPanel();
  const custom = kind ? panelRegistry.get(kind) : null;
  if (custom) return html`<${custom} onClose=${close} />`;
  if (kind === 'servers') return html`<${ServerPanel} onClose=${close} />`;
  if (kind === 'params') return html`<${ParamsPanel} onClose=${close} />`;
  if (kind === 'join') return html`<${JoinPanel} onClose=${close} />`;
  if (kind === 'config') return html`<${ConfigPanel} onClose=${close} />`;
  if (kind === 'records') return html`<${RecordsPanel} onClose=${close} />`;
  return null;
}

// Shell menu / notification can open panels without touching the Preact tree.
try {
  window.__SP_SHELL = window.__SP_SHELL || {};
  window.__SP_SHELL.openPanel = openShellPanel;
  // the shell pushes a freshly verified + probed list here (see MainActivity.pushServerList)
  window.__SP_SHELL.onServers = (json) => {
    try {
      window.dispatchEvent(new CustomEvent('sp-servers', { detail: json }));
    } catch (e) { /* old browser */ }
  };
} catch (e) { /* no window (tests) */ }
