// js/ui/shellPanels.js — in-page shell panels styled exactly like the game's own settings modal
// (Modal frame + .set-list/.set-row/.set-seg — same components the QUALITY row uses).
// Panels: 服务器 (line switching), 参数 (host-server parameters, App only), 配置 (player-data
// summary + export/import) and 战绩 (local battle log). The host (ShellPanelHost) is mounted on
// the app root (main.js, v3.5) so the latency pill opens the server panel on every screen.
// Domains are never shown: lines are identified by name only.
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button, MicroLabel } from './components.js';
import { store } from '../store.js';

/** Latency colour band (same scale as the server-list page): mint / amber / red. */
function rttColor(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '#8a9a93';
  if (ms < 150) return '#4ed8af';
  if (ms < 400) return '#e0b64a';
  return '#e06c5a';
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

/** Web (no shell) line list: 自动线路 + 自定义线路 only — no 离线服务 (browsers cannot host). */
const WEB_LINES = [
  { id: 'auto', label: '自动线路', note: '当前' },
  { id: 'custom', label: '自定义线路', note: '' },
];

function fmtRtt(ms) {
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) + 'ms' : '--';
}

/** 版本(app)：0.1.2 → v0.1.2；已带前缀就原样显示。 */
function fmtApp(app) {
  const s = String(app || '');
  if (!s) return '';
  return /^\d/.test(s) ? 'v' + s : s;
}

/** 负载：人数与房间数都有就「3 人 / 12 房」，只有一项就显示一项（Java 用 -1 表示无数据）。 */
function fmtLoad(e) {
  const h = Number.isFinite(e.humans) && e.humans >= 0 ? e.humans : null;
  const r = Number.isFinite(e.rooms) && e.rooms >= 0 ? e.rooms : null;
  if (h != null && r != null) return h + ' 人 / ' + r + ' 房';
  if (h != null) return h + ' 人';
  if (r != null) return r + ' 房';
  return '';
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

function ServerPanel({ onClose }) {
  const native = typeof window !== 'undefined' && window.shell && typeof window.shell.setServer === 'function';
  const [lines, setLines] = useState(() => {
    if (native) {
      try {
        const arr = JSON.parse(window.shell.getServers());
        return Array.isArray(arr) && arr.length ? arr : [
          { id: 'auto', label: '自动线路', note: '测速选最优' },
          { id: 'local', label: '离线服务', note: '单机自开房推荐' },
          { id: 'custom', label: '自定义线路', note: '' },
        ];
      } catch (e) { return []; }
    }
    return WEB_LINES;
  });
  const [list, setList] = useState(readServerList);
  const [custom, setCustom] = useState('');
  const [customOpen, setCustomOpen] = useState(false);

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

  function blocked() {
    if (!locked) return false;
    try { window.__SP_SHELL && window.__SP_SHELL.showPath && window.__SP_SHELL.showPath(NaN); } catch (e) { /* ignore */ }
    return true;
  }

  function pick(line) {
    if (blocked()) return;
    if (line.id === 'custom') { setCustomOpen(true); return; }
    if (native) {
      try { window.shell.setServer(line.id); } catch (e) { /* ignore */ }
      onClose();
      return;
    }
    onClose();
  }

  function pickEntry(entry) {
    if (blocked()) return;
    if (!entry.enabled) return; // 已停用：禁止加入（v3.3 起版本差异不再拦截）
    if (native) {
      try { window.shell.setServer(entry.id); } catch (e) { /* ignore */ }
      onClose();
    }
  }

  /** 房间制部署（CF Workers 版）：socket 要房号+鉴权，只能用对方自己的客户端进。 */
  function useRemote(entry, on) {
    if (blocked()) return;
    if (!native || !window.shell.useRemoteClient) return;
    try { window.shell.useRemoteClient(entry.id, on); } catch (e) { /* ignore */ }
    onClose();
  }

  function applyCustom() {
    if (blocked()) return;
    let v = String(custom || '').trim();
    if (!v) return;
    if (!/^https?:\/\//.test(v)) v = 'https://' + v;
    v = v.replace(/\/+$/, '');
    if (native) {
      try { window.shell.setServer('custom:' + v); } catch (e) { /* ignore */ }
      onClose();
      return;
    }
    location.href = v + '/' + (location.search || '');
  }

  const entries = list.entries || [];
  // 清单更新时间：Java 侧可能新增顶层 updated 或条目内 updated（有就显示，无则静默）
  const updatedRaw = list.updated != null
    ? list.updated
    : (entries.find((e) => e && e.updated != null) || {}).updated;
  const updatedText = fmtUpdated(updatedRaw);
  const rowStyle = 'display:block;width:100%;margin:4px 0;padding:8px 10px;background:transparent;'
    + 'border:1px solid #2c3a35;color:#d8e3de;border-radius:4px;font-size:13px;cursor:pointer;text-align:left';
  const dim = 'opacity:.45;cursor:not-allowed';

  return html`<${Modal} open=${true} onClose=${onClose} title="服务器" micro="SERVER" width="10.4rem"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      ${locked ? html`<p class="set-hint" style="margin:0 0 6px;border:1px solid #e0b64a;border-radius:4px;padding:8px 10px;color:#e0b64a">
        对局进行中，无法切换服务器。结束后再切换。
      </p>` : null}
      <div class="set-row">
        <span class="set-row__label">线路选择<${MicroLabel}>LINE<//></span>
        <div class="set-seg" role="radiogroup">
          ${lines.map((l) => html`<button key=${l.id} type="button" role="radio"
            aria-checked=${l.current ? 'true' : 'false'}
            class=${l.current ? 'is-on' : ''}
            title=${l.note || ''}
            style=${locked ? dim : ''}
            onClick=${() => pick(l)}>${l.label}${l.note ? html`<i class="set-seg__note">${l.note}</i>` : null}</button>`)}
        </div>
      </div>
      <div class="set-row">
        <span class="set-row__label">服务器清单<${MicroLabel}>${list.source || 'LIST'}<//></span>
        ${entries.length
          ? html`<div>${entries.map((e) => html`<div key=${e.id}>
              <button type="button"
                style=${rowStyle + (!e.enabled ? ';' + dim : '')}
                title=${e.note || ''}
                onClick=${() => pickEntry(e)}>
                <span style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                  ${e.name}
                  ${e.app ? html`<span style="opacity:.72"> · ${fmtApp(e.app)}</span>` : null}
                  <span style=${';color:' + rttColor(e.rttMs) + ';margin-left:6px'}>${fmtRtt(e.rttMs)}</span>
                  ${fmtLoad(e) ? html`<span style="opacity:.75"> · ${fmtLoad(e)}</span>` : null}
                </span>
                <span style="display:block;margin-top:2px">
                  ${e.roomScoped ? html`<span style="color:#8a9a93;margin-right:8px">房间制</span>` : null}
                  ${e.appMismatch && !e.roomScoped ? html`<span style="color:#e0b64a;margin-right:8px">版本不同</span>` : null}
                  ${e.remoteClient ? html`<span style="color:#4ed8af;margin-right:8px">对方客户端</span>` : null}
                  ${native && e.current ? html`<span style="color:#4ed8af;margin-right:8px">当前</span>` : null}
                </span>
              </button>
              ${e.roomScoped
                ? html`<button type="button" style=${rowStyle + ';border-color:#4ed8af;color:#4ed8af;font-size:12px;margin-top:-2px'}
                    onClick=${() => useRemote(e, !e.remoteClient)}>
                    ${e.remoteClient ? '改回本地客户端' : '使用对方客户端进入'}
                  </button>`
                : null}
            </div>`)}</div>`
          : html`<p class="set-hint set-hint--tight">${list.loading ? '正在获取清单…' : '暂无可用服务器'}</p>`}
        ${updatedText ? html`<p class="set-hint set-hint--tight">清单更新于 ${updatedText}</p>` : null}
        ${native && window.shell.refreshServerList
          ? html`<button type="button" class="set-apply" onClick=${() => { try { window.shell.refreshServerList(); } catch (e) { /* ignore */ } }}>刷新清单</button>`
          : null}
      </div>
      <div class="set-row">
        <span class="set-row__label">自定义服务器<${MicroLabel}>CUSTOM<//></span>
        <input class="set-input" type="text" value=${custom} placeholder="输入地址"
          onFocus=${() => setCustomOpen(true)}
          onInput=${(e) => setCustom(e.currentTarget.value)} />
        <button type="button" class="set-apply" disabled=${!customOpen || custom === ''} onClick=${applyCustom}>应用</button>
      </div>
      <p class="set-hint">
        清单为签名清单，验签失败会自动回退内置；延迟由本机实测。服务器均可加入；
        「版本不同」（客户端版本差异）仅提示，不影响加入。本地未命中的内容由当前服务器直接下发。
        标「房间制」的服务器（CF Workers 版）socket 需要房号与鉴权，只能用对方自己的客户端进入 ——
        点「使用对方客户端进入」即切换。自动线路 = 启动时按实测延迟选最优；离线服务 = 本机自开房。
      </p>
      ${native
        ? html`<div class="set-row">
            <span class="set-row__label">诊断<${MicroLabel}>DIAG<//></span>
            <button type="button" class="set-apply"
              onClick=${() => { try { window.__SP_SHELL && window.__SP_SHELL.showPath && window.__SP_SHELL.showPath(NaN); } catch (e) { /* ignore */ } }}>查看连接路径</button>
          </div>`
        : null}
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
    try { location.href = location.origin + '/?room=' + normalized; } catch (e) { /* ignore */ }
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
            ${e.name} · ${fmtRtt(e.rttMs)}${e.humans >= 0 ? ' · ' + e.humans + ' 人' : ''}${e.note ? ' · ' + e.note : ''}
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
// 战绩 (local battle log): newest first, at most 50 rows (v3.5)
// ---------------------------------------------------------------------------------------------------

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

function RecordsPanel({ onClose }) {
  const doc = readPlayerDoc();
  const battles = doc && Array.isArray(doc.battles) ? doc.battles.slice() : [];
  battles.sort((a, b) => (Number(b && b.ts) || 0) - (Number(a && a.ts) || 0)); // 新 → 旧
  const rows = battles.slice(0, 50);
  const servers = (doc && doc.servers) || {};
  const serverName = (id) => (id && servers[id] && servers[id].name) || id || '未知服务器';
  const rowStyle = 'display:flex;align-items:baseline;gap:10px;padding:6px 2px 5px;'
    + 'border-bottom:1px solid #1e2823;font-size:12px';

  return html`<${Modal} open=${true} onClose=${onClose} title="战绩" micro="RECORDS" width="10.4rem"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      ${rows.length
        ? html`<div>${rows.map((b, i) => html`<div key=${b.id || i} style=${rowStyle}>
            <b style=${'min-width:2.1em;color:' + resultColor(b.result)}>${resultLabel(b.result)}</b>
            <span style="opacity:.8;font-variant-numeric:tabular-nums">${fmtDuration(b.duration)}</span>
            <span style="opacity:.65">${b.mode || '—'}</span>
            <span style="opacity:.55">${b.roomCode || '—'}</span>
            <span style="margin-left:auto;opacity:.55;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
              title=${serverName(b.serverId)}>${serverName(b.serverId)}</span>
          </div>`)}</div>`
        : html`<p class="set-hint set-hint--tight">暂无战绩</p>`}
      <p class="set-hint">按结算时间倒序，最多显示最近 50 条；记录保留在对局结算时写入本机玩家数据。</p>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------------

export function ShellPanelHost() {
  const [kind, close] = useShellPanel();
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
