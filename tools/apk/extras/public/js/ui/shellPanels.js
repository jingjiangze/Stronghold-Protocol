// js/ui/shellPanels.js — in-page shell panels styled exactly like the game's own settings modal
// (Modal frame + .set-list/.set-row/.set-seg — same components the QUALITY row uses).
// Two panels: 服务器 (list switching) and 参数 (host-server parameters, App only).
// Opened from the title screen buttons or via window.__SP_SHELL.openPanel(kind) (shell menu).
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button, Icon, MicroLabel } from './components.js';

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
// Server switching (list of preset lines — no raw URL typing as the primary path)
// ---------------------------------------------------------------------------------------------------

/** The six selectable lines; urls are checked against the current origin to mark the active one. */
const SERVER_LINES = [
  { id: 'local', label: '本地内置', url: 'http://127.0.0.1:3000', appOnly: true },
  { id: 'intl1', label: '国际线路 1', url: 'https://stronghold.jiangjiangze.icu' },
  { id: 'auto', label: '自动线路', url: '' },
  { id: 'cn', label: '国内线路', url: 'https://map.u712507.nyat.app:38916' },
  { id: 'intl2', label: '国际线路 2', url: 'https://stronghold2.jiangjiangze.icu' },
  { id: 'custom', label: '自定义服务器', url: '' },
];

function ServerPanel({ onClose }) {
  const native = typeof window !== 'undefined' && window.shell && typeof window.shell.setServer === 'function';
  const [custom, setCustom] = useState('');
  const [current, setCurrent] = useState(() => {
    try { return window.shell && window.shell.currentServer ? window.shell.currentServer() : location.origin; } catch (e) { return ''; }
  });
  const [busy, setBusy] = useState(false);

  function pick(line) {
    if (line.id === 'custom') { setCustom((v) => v || (current || '')); return; }
    setBusy(true);
    if (native) {
      try { window.shell.setServer(line.id); } catch (e) { setBusy(false); }
      return;
    }
    // web: navigate, preserving ?room=
    const q = location.search || '';
    if (!line.url) { onClose(); setBusy(false); return; }
    location.href = line.url.replace(/\/+$/, '') + '/' + q;
  }

  function applyCustom() {
    let v = String(custom || '').trim();
    if (!v) return;
    if (!/^https?:\/\//.test(v)) v = 'https://' + v;
    v = v.replace(/\/+$/, '');
    if (native) {
      try { window.shell.setServer('custom:' + v); } catch (e) { /* ignore */ }
      return;
    }
    location.href = v + '/' + (location.search || '');
  }

  const lines = SERVER_LINES.filter((l) => !l.appOnly || native);
  return html`<${Modal} open=${true} onClose=${onClose} title="服务器" micro="SERVER" width="7.4rem"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      <div class="set-row">
        <span class="set-row__label">线路选择<${MicroLabel}>LINE<//></span>
        <div class="set-seg" role="radiogroup">
          ${lines.map((l) => html`<button key=${l.id} type="button" role="radio"
            aria-checked=${l.url && current.startsWith(l.url) ? 'true' : 'false'}
            class=${l.url && current.startsWith(l.url) ? 'is-on' : ''}
            onClick=${() => pick(l)}>${l.label}</button>`)}
        </div>
      </div>
      ${custom !== '' || lines.some((l) => l.id === 'custom') ? html`<div class="set-row">
        <span class="set-row__label">自定义地址<${MicroLabel}>CUSTOM<//></span>
        <input class="set-input" type="text" value=${custom} placeholder="https://… 或 IP:端口"
          onInput=${(e) => setCustom(e.currentTarget.value)} />
        <button type="button" class="set-apply" disabled=${busy} onClick=${applyCustom}>应用</button>
      </div>` : null}
      <p class="set-hint">
        本地内置 = 本机自己的房；自动线路 = 启动时按“国内 → 国际 1 → 国际 2”探测可用者；
        加入他人房间请在断线页或顶部菜单使用「输房号加入」，会自动切到对应服务器。
      </p>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------------
// Host-server parameters (App only) — segmented controls in the game's own style
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
    return html`<${Modal} open=${true} onClose=${onClose} title="参数" micro="PARAMS" width="7.4rem"
      actions=${html`<${Button} variant="primary" onClick=${onClose}>完成<//>`}>
      <div class="set-list"><p class="set-hint">房主参数仅在 App 版可用。</p></div>
    <//>`;
  }

  function save(restart) {
    try {
      window.shell.setParamsJson(JSON.stringify(p));
      if (restart && window.shell.restartApp) window.shell.restartApp();
    } catch (e) { /* ignore */ }
    onClose();
  }

  return html`<${Modal} open=${true} onClose=${onClose} title="参数" micro="PARAMS" width="7.4rem"
    actions=${html`<${Button} variant="secondary" onClick=${() => setP(readParams())}>恢复默认<//>
      <${Button} variant="primary" icon="check" onClick=${() => save(true)}>保存并重启<//>`}>
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
      <p class="set-hint">保存后需重启应用生效（内嵌服务器进程会随应用一起重启）。</p>
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
