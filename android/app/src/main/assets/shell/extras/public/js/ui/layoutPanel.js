/* global window */
// ui/layoutPanel.js -- the UI-layout editor: ONE empty canvas at the device's own resolution, with the
// game's HUD boxes drawn on it as simplified figures you can drag (move) and pull by the corner (resize).
//
// WHAT IT EDITS: exactly the seven containers js/ui-layout.js owns (that file is the single writer of the
// <style id="sp-ui-layout"> tag and of the persisted `ui.layout` pref -- this panel never writes CSS or
// storage itself). The battlefield is drawn as a read-only placeholder: it is a PIXI/three.js canvas, so
// there is no box to move (audit 2026-10-14).
//
// WHY A CANVAS AND NOT DOM BOXES: the ask is a scaled-down preview of the player's own screen
// ("读玩家手机分辨率，一个空画布，上面读 ui 的位置，将 ui 以简化图形再在一个内置的空画布显示"). Drawing
// into one <canvas> keeps the preview independent of the modal's own layout -- the preview cannot be
// distorted by the panel it lives in, which is exactly what a layout tool must not allow.
//
// UNITS: everything the panel stores is rem (ui-layout.js divides by the live root font size), so the
// same layout survives a fontScale change and a different screen. The canvas works in CSS px and divides
// by that same root size on the way in.
//
// Contract: ESM + htm, no page module, no network, degrades to shims (never throws) when the kit is
// absent, idempotent (window.__SP_LAYOUT_PANEL guard).

let html;
let Modal;
let Button;
let MicroLabel;
let useState;
let useEffect;
let useRef;

// ---- shims (last resort; only used when the real kit cannot be loaded) --------------------------
function shimHtml(strings) {
  const parts = [];
  for (let i = 0; i < strings.length; i++) {
    parts.push(strings[i]);
    if (i + 1 < arguments.length) parts.push(arguments[i + 1]);
  }
  return { __spDegraded: true, parts };
}
function shimUseState(v) { return [typeof v === 'function' ? v() : v, function () {}]; }
function shimUseEffect() {}
function shimUseRef(v) { return { current: v }; }
function shimModal(p) {
  const q = p || {};
  return html`<div class="modal" role="presentation"
    style="position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147482000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)">
    <div class="modal__body" style="max-width:92vw;max-height:86vh;overflow:auto;padding:12px;background:#0f1815;border:1px solid #2c3a35">
      ${q.children}
    </div>
  </div>`;
}
function shimButton(p) {
  const q = p || {};
  return html`<button type="button" class="btn" disabled=${!!q.disabled} onClick=${q.onClick}>${q.children}</button>`;
}
function shimMicroLabel(p) { return html`<span class="micro">${(p || {}).children}</span>`; }

function installShims() {
  html = shimHtml;
  useState = shimUseState;
  useEffect = shimUseEffect;
  useRef = shimUseRef;
  Modal = shimModal;
  Button = shimButton;
  MicroLabel = shimMicroLabel;
}
installShims();

/** Resolve the shared overlay UI kit (ui/overlayKit.js). globalThis.window rather than a bare `window`:
 *  this file is linted against the node globals table (tools/** is nodeFiles) where a bare window is a
 *  no-undef error; in a browser globalThis === window, and in the node tests it is what the harness sets. */
async function loadDeps() {
  let kit = null;
  try { kit = await import('./overlayKit.js'); } catch (e) { /* keep the shims */ }
  const win = typeof globalThis.window === 'undefined' ? null : globalThis.window;
  const g = (win && win.__SP_UI_KIT) ? win.__SP_UI_KIT : null;
  if (g) kit = g;
  if (kit && typeof kit.html === 'function' && typeof kit.Modal === 'function'
      && typeof kit.Button === 'function' && typeof kit.MicroLabel === 'function') {
    html = kit.html;
    Modal = kit.Modal;
    Button = kit.Button;
    MicroLabel = kit.MicroLabel;
    if (typeof kit.useState === 'function') useState = kit.useState;
    if (typeof kit.useEffect === 'function') useEffect = kit.useEffect;
    if (typeof kit.useRef === 'function') useRef = kit.useRef;
  }
}

/** The engine (js/ui-layout.js), or null on an old hot-update tree that does not carry it yet. */
function engine() {
  const win = typeof globalThis.window === 'undefined' ? null : globalThis.window;
  return (win && win.__SP_UI_LAYOUT) ? win.__SP_UI_LAYOUT : null;
}

// ---- drawing -------------------------------------------------------------------------------------
const PAD = 10;              // canvas padding around the viewport box (css px)
const HANDLE = 14;           // resize handle size (css px, on the DISPLAYED canvas)
const COL = {
  bg: '#0a0d0c', grid: 'rgba(120,140,130,.16)', edge: '#3e4b45',
  box: 'rgba(78,216,175,.16)', boxEdge: '#4ed8af', sel: 'rgba(78,216,175,.34)',
  ro: 'rgba(140,150,145,.10)', roEdge: '#5d6863',
  text: '#c3cbc7', dim: '#8a948f', hi: '#f2f2f2'
};

/** Lay the viewport into the available box: returns the display scale (css px -> displayed px). */
function fitScale(vp, availW, availH) {
  const w = Math.max(1, vp.w), h = Math.max(1, vp.h);
  const sw = (availW - PAD * 2) / w, sh = (availH - PAD * 2) / h;
  const s = Math.min(sw, sh);
  return s > 0 && isFinite(s) ? s : 1;
}

/** Draw one frame. `drag` is the in-flight gesture ({ sel, mode, base, dx, dy }) or null: while dragging
 *  the moved box is drawn from the gesture math (immediate feedback), everything else from the live DOM. */
function paint(ctx, meas, cssW, cssH, scale, sel, drag) {
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, cssW, cssH);
  const vp = meas.vp;
  const ox = PAD + (cssW - PAD * 2 - vp.w * scale) / 2;
  const oy = PAD + (cssH - PAD * 2 - vp.h * scale) / 2;
  // the device screen itself
  ctx.fillStyle = 'rgba(255,255,255,.02)';
  ctx.fillRect(ox, oy, vp.w * scale, vp.h * scale);
  ctx.strokeStyle = COL.edge;
  ctx.lineWidth = 1;
  ctx.strokeRect(ox + 0.5, oy + 0.5, vp.w * scale, vp.h * scale);
  // grid every 10 rem -- the only "scale" reference the player needs
  const root = vp.rootPx > 0 ? vp.rootPx : 0;
  if (root > 0) {
    ctx.strokeStyle = COL.grid;
    for (let gx = 10; gx * root * scale < vp.w * scale; gx += 10) {
      const x = ox + gx * root * scale;
      ctx.beginPath(); ctx.moveTo(x, oy); ctx.lineTo(x, oy + vp.h * scale); ctx.stroke();
    }
    for (let gy = 10; gy * root * scale < vp.h * scale; gy += 10) {
      const y = oy + gy * root * scale;
      ctx.beginPath(); ctx.moveTo(ox, y); ctx.lineTo(ox + vp.w * scale, y); ctx.stroke();
    }
  }
  ctx.font = '11px sans-serif';
  ctx.textBaseline = 'top';
  for (const it of meas.items) {
    if (!it.box) continue;
    let x = ox + it.box.x * root * scale;
    let y = oy + it.box.y * root * scale;
    let w = it.box.w * root * scale;
    let h = it.box.h * root * scale;
    if (drag && drag.sel === it.sel) {
      if (drag.mode === 'move') { x += drag.dx * root * scale; y += drag.dy * root * scale; }
      else { w = Math.max(4, w + drag.dx * root * scale); h = Math.max(4, h + drag.dy * root * scale); }
    }
    const on = it.sel === sel;
    ctx.fillStyle = it.editable ? (on ? COL.sel : COL.box) : COL.ro;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = it.editable ? (on ? COL.hi : COL.boxEdge) : COL.roEdge;
    if (!it.editable) { try { ctx.setLineDash([4, 3]); } catch (e) { /* old ctx */ } }
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
    if (!it.editable) { try { ctx.setLineDash([]); } catch (e) { /* ignore */ } }
    ctx.fillStyle = it.editable ? COL.text : COL.dim;
    const label = it.label;
    ctx.fillText(label, x + 3, y + 2);
    if (on && it.editable) {
      ctx.fillStyle = COL.hi;
      ctx.fillRect(x + w - HANDLE, y + h - HANDLE, HANDLE, HANDLE);
      ctx.strokeStyle = COL.bg;
      ctx.strokeRect(x + w - HANDLE + 0.5, y + h - HANDLE + 0.5, HANDLE - 1, HANDLE - 1);
    }
  }
  return { ox, oy };
}

/** Which item (and which gesture) is under this point? Handles win over bodies, bodies over nothing. */
function hitTest(meas, ox, oy, root, scale, px, py, sel) {
  const items = meas.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it.editable || !it.box) continue;
    const x = ox + it.box.x * root * scale, y = oy + it.box.y * root * scale;
    const w = it.box.w * root * scale, h = it.box.h * root * scale;
    if (it.sel === sel && px >= x + w - HANDLE && px <= x + w && py >= y + h - HANDLE && py <= y + h) {
      return { it, mode: 'resize' };
    }
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it.editable || !it.box) continue;
    const x = ox + it.box.x * root * scale, y = oy + it.box.y * root * scale;
    const w = it.box.w * root * scale, h = it.box.h * root * scale;
    if (px >= x && px <= x + w && py >= y && py <= y + h) return { it, mode: 'move' };
  }
  return null;
}

// ---- the panel -----------------------------------------------------------------------------------
/** props.onClose: close the panel (the shell host passes it). */
export function LayoutPanel(props) {
  const onClose = props && props.onClose;
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const stateRef = useRef(null);
  const tickState = useState(0);
  const bump = tickState[1];
  const selState = useState('');
  const sel = selState[0];
  const setSel = selState[1];
  const noteState = useState('');
  const note = noteState[0];
  const setNote = noteState[1];

  const eng = engine();

  /** Re-measure the live DOM and redraw. Called on a slow tick while the panel is open (the HUD moves
   *  on its own: mode classes, prep/battle, a scout) and right after every edit. */
  function redraw() {
    const cv = canvasRef.current;
    const eng2 = engine();
    if (!cv || !eng2 || typeof cv.getContext !== 'function') return;
    const meas = eng2.measure();
    const wrap = wrapRef.current;
    const availW = (wrap && wrap.clientWidth) || 520;
    const availH = (wrap && wrap.clientHeight) || 300;
    const scale = fitScale(meas.vp, availW, availH);
    const cssW = Math.max(120, Math.round(availW));
    const cssH = Math.max(120, Math.round(availH));
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = meas.vp.dpr > 0 ? meas.vp.dpr : 1;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.width = cssW + 'px';
    cv.style.height = cssH + 'px';
    try { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); } catch (e) { /* old ctx: draw at 1x */ }
    const geo = paint(ctx, meas, cssW, cssH, scale, sel, stateRef.current && stateRef.current.drag);
    stateRef.current = Object.assign({}, stateRef.current, { meas, scale, geo, cssW, cssH });
  }

  // Keep the preview honest: the HUD is not static (gm--<mode> / is-pen / is-collapsed flip on their
  // own), so a slow tick re-measures while the panel is open. Closed = zero timers (the audit's
  // "打开时高频重测，关闭即停").
  useEffect(function () {
    redraw();
    let t = null;
    try { t = setInterval(function () { if (!(stateRef.current && stateRef.current.drag)) redraw(); }, 500); } catch (e) { t = null; }
    function onResize() { redraw(); }
    try { globalThis.window.addEventListener('resize', onResize); } catch (e) { /* no window */ }
    return function () {
      try { if (t !== null) clearInterval(t); } catch (e) { /* ignore */ }
      try { globalThis.window.removeEventListener('resize', onResize); } catch (e) { /* ignore */ }
    };
  });

  // Redraw when the selection changes (the handle follows the selected box).
  useEffect(function () { redraw(); }, [sel]);

  function localPoint(ev) {
    const cv = canvasRef.current;
    if (!cv || typeof cv.getBoundingClientRect !== 'function') return null;
    const r = cv.getBoundingClientRect();
    return { x: (ev.clientX || 0) - r.left, y: (ev.clientY || 0) - r.top };
  }

  function onDown(ev) {
    const st = stateRef.current;
    const eng2 = engine();
    if (!st || !st.meas || !eng2) return;
    const p = localPoint(ev);
    if (!p) return;
    const root = st.meas.vp.rootPx > 0 ? st.meas.vp.rootPx : 1;
    const hit = hitTest(st.meas, st.geo.ox, st.geo.oy, root, st.scale, p.x, p.y, sel);
    if (!hit) { setSel(''); return; }
    setSel(hit.it.sel);
    const stored = hit.it.stored || {};
    stateRef.current = Object.assign({}, st, {
      drag: {
        sel: hit.it.sel, mode: hit.mode, startX: p.x, startY: p.y,
        dx: 0, dy: 0,
        baseDx: typeof stored.dx === 'number' ? stored.dx : 0,
        baseDy: typeof stored.dy === 'number' ? stored.dy : 0,
        baseW: hit.it.box ? hit.it.box.w : 0,
        baseH: hit.it.box ? hit.it.box.h : 0
      }
    });
    try { if (ev.preventDefault) ev.preventDefault(); } catch (e) { /* ignore */ }
  }

  function onMove(ev) {
    const st = stateRef.current;
    const eng2 = engine();
    if (!st || !st.drag || !eng2) return;
    const p = localPoint(ev);
    if (!p) return;
    const root = st.meas.vp.rootPx > 0 ? st.meas.vp.rootPx : 1;
    // displayed px -> viewport px -> rem (the unit the engine stores)
    const dxRem = (p.x - st.drag.startX) / st.scale / root;
    const dyRem = (p.y - st.drag.startY) / st.scale / root;
    const d = st.drag;
    if (d.mode === 'move') {
      d.dx = dxRem; d.dy = dyRem;
      eng2.set(d.sel, { dx: round2(d.baseDx + dxRem), dy: round2(d.baseDy + dyRem) });
    } else {
      d.dx = dxRem; d.dy = dyRem;
      eng2.set(d.sel, { w: round2(Math.max(1, d.baseW + dxRem)), h: round2(Math.max(0.5, d.baseH + dyRem)) });
    }
    redraw();
    try { if (ev.preventDefault) ev.preventDefault(); } catch (e) { /* ignore */ }
  }

  function onUp() {
    const st = stateRef.current;
    if (!st || !st.drag) return;
    stateRef.current = Object.assign({}, st, { drag: null });
    redraw();
    bump(function (n) { return n + 1; });
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  function doReset() {
    const eng2 = engine();
    if (!eng2) return;
    eng2.reset();
    setSel('');
    setNote('已恢复上游默认布局');
    redraw();
    bump(function (n) { return n + 1; });
  }

  function clearOne(selKey) {
    const eng2 = engine();
    if (!eng2) return;
    eng2.set(selKey, { dx: null, dy: null, w: null, h: null });
    setNote('已清除 ' + selKey);
    redraw();
    bump(function (n) { return n + 1; });
  }

  if (!eng) {
    return html`<${Modal} open=${true} onClose=${onClose} title="布局" micro="LAYOUT"
      actions=${html`<${Button} variant="primary" onClick=${onClose}>完成<//>`}>
      <div class="set-list">
        <p class="set-hint set-hint--tight">布局模块还没加载（旧热更树）。请热重载页面或重开 App 后再试。</p>
      </div>
    <//>`;
  }

  const meas = stateRef.current && stateRef.current.meas;
  const stored = eng.get();
  const touched = Object.keys(stored.items || {});

  return html`<${Modal} open=${true} onClose=${onClose} title="布局" micro="LAYOUT"
    width="min(96vw,52rem)"
    actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>完成<//>`}>
    <div class="set-list">
      <p class="set-hint set-hint--tight">
        画布就是你这台设备的屏幕（<b>${meas ? Math.round(meas.vp.w) + '×' + Math.round(meas.vp.h) : '—'}</b>，
        DPR ${meas ? meas.vp.dpr : '—'}）。拖动方块移动，拖右下角小方块改大小；虚线框是战场（canvas 绘制，
        只能整块，不能布局）。所有值按 rem 存，换字号/换设备都不跑偏。
      </p>
      <div ref=${wrapRef} style="position:relative;width:100%;height:min(52vh,420px);min-height:200px;border:1px solid #3e4b45;background:#0a0d0c">
        <canvas ref=${canvasRef} style="display:block;width:100%;height:100%;touch-action:none;cursor:crosshair"
          onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp}></canvas>
      </div>
      ${sel ? html`<div class="set-row">
        <span class="set-row__label">已选<${MicroLabel}>SELECTED<//></span>
        <div style="grid-column:2 / 4;min-width:0;display:flex;flex-wrap:wrap;gap:.08rem;align-items:center">
          <span style="opacity:.85">${sel}</span>
          <button type="button" class="set-apply" onClick=${function () { clearOne(sel); }}>清除这一项</button>
        </div>
      </div>` : null}
      <div class="set-row">
        <span class="set-row__label">已改<${MicroLabel}>CHANGED<//></span>
        <div style="grid-column:2 / 4;min-width:0;display:flex;flex-wrap:wrap;gap:.08rem;align-items:center">
          <span style="opacity:.85">${touched.length ? touched.join('、') : '（还没有改动）'}</span>
          <button type="button" class="set-apply" onClick=${doReset}>全部恢复默认</button>
        </div>
      </div>
      ${note ? html`<p class="set-hint set-hint--tight">${note}</p>` : null}
      <p class="set-hint set-hint--tight" style="opacity:.75">
        改了立刻生效（本页就能看到）。布局跟着你走：换服务器、换字号、换设备都保留。
      </p>
    </div>
  <//>`;
}

/** Register with the shell's panel host (ui/shellPanels.js). Same shape lobby.js / modsPanel.js use. */
export async function registerSelf() {
  try {
    const mod = await import('./shellPanels.js');
    if (mod && typeof mod.registerPanel === 'function') { mod.registerPanel('uilayout', LayoutPanel); return true; }
  } catch (e) { /* no panel host yet */ }
  return false;
}

async function run() {
  if (typeof globalThis.window === 'undefined') return;
  if (globalThis.window.__SP_LAYOUT_PANEL) return;
  globalThis.window.__SP_LAYOUT_PANEL = true;
  await loadDeps();
  try { await registerSelf(); } catch (e) { /* the host may land later; the kind still resolves via the registry */ }
}

/** Readiness for tests and probes: resolves once the real UI kit has replaced the shims, so a harness
 *  can render <LayoutPanel/> without racing the dynamic import (rendering against the shims produces a
 *  degraded vnode that preact cannot mount). The panel itself never waits on it. */
const ready = run();
export { ready };
