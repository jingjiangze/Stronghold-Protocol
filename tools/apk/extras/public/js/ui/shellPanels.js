// js/ui/shellPanels.js — in-page shell panels styled exactly like the game's own settings modal
// (Modal frame + .set-list/.set-row/.set-seg — same components the QUALITY row uses).
// Two panels: 服务器 (line switching) and 参数 (host-server parameters, App only).
// Domains are never shown: lines are identified by name only.
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button, MicroLabel } from './components.js';

/** Panel store: 'servers' | 'params' | null, broadcast on a window event so the shell can drive it too. */
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

/** Web (no shell) line list: names only — clicking navigates, the URL never appears in the UI. */
const WEB_LINES = [
  { id: 'cn', label: '国内线路' },
  { id: 'intl1', label: '国际线路 1' },
  { id: 'intl2', label: '国际线路 2' },
];
const WEB_URLS = {
  cn: 'https://map.u712507.nyat.app:38916',
  intl1: 'https://stronghold.jiangjiangze.icu',
  intl2: 'https://stronghold2.jiangjiangze.icu',
};

function ServerPanel({ onClose }) {
  const native = typeof window !== 'undefined' && window.shell && typeof window.shell.setServer === 'function';
  const [lines, setLines] = useState(() => {
    if (native) {
      try {
        const arr = JSON.parse(window.shell.getServers());
        return Array.isArray(arr) ? arr : [];
      } catch (e) { return []; }
    }
    return WEB_LINES;
  });
  const [custom, setCustom] = useState('');
  const [customOpen, setCustomOpen] = useState(false);

  function pick(line) {
    if (line.id === 'custom') { setCustomOpen(true); return; }
    if (native) {
      try { window.shell.setServer(line.id); } catch (e) { /* ignore */ }
      onClose();
      return;
    }
    const url = WEB_URLS[line.id];
    if (!url) { onClose(); return; }
    location.href = url.replace(/\/+$/, '') + '/' + (location.search || '');
  }

  function applyCustom() {
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

  return html`<${Modal} open=${true} onClose=${onClose} title="服务器" micro="SERVER" width="10.4rem"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      <div class="set-row">
        <span class="set-row__label">线路选择<${MicroLabel}>LINE<//></span>
        <div class="set-seg" role="radiogroup">
          ${lines.map((l) => html`<button key=${l.id} type="button" role="radio"
            aria-checked=${l.current ? 'true' : 'false'}
            class=${l.current ? 'is-on' : ''}
            title=${l.note || ''}
            onClick=${() => pick(l)}>${l.label}${l.note ? html`<i class="set-seg__note">${l.note}</i>` : null}</button>`)}
        </div>
      </div>
      <div class="set-row">
        <span class="set-row__label">自定义服务器<${MicroLabel}>CUSTOM<//></span>
        <input class="set-input" type="text" value=${custom} placeholder="输入地址"
          onFocus=${() => setCustomOpen(true)}
          onInput=${(e) => setCustom(e.currentTarget.value)} />
        <button type="button" class="set-apply" disabled=${!customOpen || custom === ''} onClick=${applyCustom}>应用</button>
      </div>
      <p class="set-hint">
        本地内置 = 本机自己的房（单机推荐，独立模拟请选它）；自动线路 = 启动时按实测延迟选最优；
        加入他人房间请在断线页或顶部菜单使用「输房号加入」，会自动切到对应线路。
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
    return html`<${Modal} open=${true} onClose=${onClose} title="参数" micro="PARAMS" width="10.4rem"
      actions=${html`<${Button} variant="primary" onClick=${onClose}>完成<//>`}>
      <div class="set-list"><p class="set-hint">房主参数仅在 App 版可用。</p></div>
    <//>`;
  }

  function save() {
    try {
      window.shell.setParamsJson(JSON.stringify(p));
      if (window.shell.restartHost) window.shell.restartHost();
    } catch (e) { /* ignore */ }
    onClose();
  }

  return html`<${Modal} open=${true} onClose=${onClose} title="参数" micro="PARAMS" width="10.4rem"
    actions=${html`<${Button} variant="secondary" onClick=${() => setP(readParams())}>恢复默认<//>
      <${Button} variant="primary" icon="check" onClick=${save}>保存并重启房主服务<//>`}>
    <div class="set-list">
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

export function ShellPanelHost() {
  const [kind, close] = useShellPanel();
  if (kind === 'servers') return html`<${ServerPanel} onClose=${close} />`;
  if (kind === 'params') return html`<${ParamsPanel} onClose=${close} />`;
  return null;
}

// Shell menu / notification can open panels without touching the Preact tree.
try {
  window.__SP_SHELL = window.__SP_SHELL || {};
  window.__SP_SHELL.openPanel = openShellPanel;
} catch (e) { /* no window (tests) */ }
