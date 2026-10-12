/* global window, document */
// js/ui/overlayKit.js -- the shell overlay's OWN minimal UI kit (Preact + htm), served from the
// /__sp/ channel. The overlay must look and behave the SAME on the local tree page and on any
// third-party server page, so it must not borrow the page's design system (js/ui/components.js +
// the page's css/*): a server that ships a different version, or a page that ships no game UI at
// all, would otherwise leave the panels unstyled or make them vanish. This kit + the stylesheet
// injected by ui/shellPanels.js (scoped under `.sp-ui`) are the overlay's whole visual identity.
//
// The vendored preact/htm/hooks live next to the overlay at js/vendor/* (reachable as /js/vendor/*
// on the local tree and as /__sp/vendor/* on every page), so the kit never depends on the page's
// /vendor/ either. Resolution of `../vendor/*` is deliberate: from /js/ui/overlayKit.js it is
// /js/vendor/*; from /__sp/ui/overlayKit.js it is /__sp/vendor/* -> the same files.
import { h, Fragment, render } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
import { useState, useEffect, useRef, useLayoutEffect, useMemo, useCallback } from '../vendor/hooks.module.js';

export { h, Fragment, render, useState, useEffect, useRef, useLayoutEffect, useMemo, useCallback };

/** Tagged-template JSX for the overlay (its own htm instance; vnodes are plain Preact objects). */
export const html = htm.bind(h);

const cx = (...parts) => parts.flat().filter(Boolean).join(' ');

// ---- icons (the subset the overlay actually uses) ------------------------------------------------
const ICONS = {
  check: { d: 'M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z' },
  close: { d: 'M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z' },
};

/** Inline SVG icon (overlay's own; sized in em so it follows the button font). */
export function Icon({ name, size, class: cls, title }) {
  const ic = ICONS[name];
  if (!ic) return null;
  return html`<svg class=${cx('icon', cls)} viewBox="0 0 24 24" width=${size || '1em'} height=${size || '1em'}
    aria-hidden=${title ? undefined : 'true'} role=${title ? 'img' : undefined} focusable="false">
    ${title ? html`<title>${title}</title>` : null}
    <path d=${ic.d} />
  </svg>`;
}

/** Tiny uppercase techno label. */
export function MicroLabel({ children, class: cls, tone }) {
  return html`<span class=${cx('micro', tone && 'micro--' + tone, cls)}>${children}</span>`;
}

// ---- Button --------------------------------------------------------------------------------------
/** Overlay button. `variant` primary|secondary|danger|amber|ice|ghost; `size` sm|md|lg|xl. */
export function Button({
  variant = 'secondary', size = 'md', icon, iconRight, loading = false, disabled = false,
  block = false, onClick, type = 'button', title, class: cls, children, ...rest
}) {
  const isDisabled = disabled || loading;
  return html`<button type=${type} title=${title}
    class=${cx('btn', `btn--${variant}`, `btn--${size}`, block && 'btn--block', loading && 'is-loading', cls)}
    disabled=${isDisabled} aria-busy=${loading ? 'true' : undefined}
    onClick=${(e) => { if (!isDisabled && onClick) onClick(e); }} ...${rest}>
    ${icon ? html`<${Icon} name=${icon} class="btn__icon" />` : null}
    ${children != null && children !== false ? html`<span class="btn__label">${children}</span>` : null}
    ${iconRight ? html`<${Icon} name=${iconRight} class="btn__icon btn__icon--right" />` : null}
    ${loading ? html`<span class="btn__busy" aria-hidden="true"></span>` : null}
  </button>`;
}

// ---- Modal ---------------------------------------------------------------------------------------
/** Overlay modal. Props mirror the upstream Modal the panels were written against
 *  (open/title/micro/tone/onClose/actions/width/children), so panel call sites are unchanged. */
export function Modal({ open = true, title, micro, tone = 'mint', onClose, actions, width, closeOnBackdrop = true, class: cls, children }) {
  if (!open) return null;
  return html`<div class="modal" role="presentation"
      onMouseDown=${(e) => { if (closeOnBackdrop && e.target === e.currentTarget && onClose) onClose(); }}>
    <div class=${cx('modal__box', `modal__box--${tone}`, cls)} role="dialog" aria-modal="true" tabindex="-1"
         style=${width ? `width:${width}` : undefined}>
      <div class="modal__stripe" aria-hidden="true"></div>
      ${title || micro ? html`<header class="modal__head">
        ${micro ? html`<${MicroLabel}>${micro}<//>` : null}
        ${title ? html`<h2 class="modal__title">${title}</h2>` : null}
      </header>` : null}
      <div class="modal__body">${children}</div>
      ${actions ? html`<footer class="modal__actions">${actions}</footer>` : null}
    </div>
  </div>`;
}

// ---- toast ---------------------------------------------------------------------------------------
/** Lightweight self-owned toast (no page ToastHost needed). Inline styles: it must read the same
 *  on any page. Never throws without a DOM. */
export function toast(text) {
  const msg = String(text == null ? '' : text);
  try { if (typeof console !== 'undefined' && console.log) console.log('[shell] ' + msg); } catch (e) { /* ignore */ }
  try {
    if (typeof document === 'undefined' || !document.body || !msg) return;
    const el = document.createElement('div');
    el.className = 'sp-toast';
    el.setAttribute('role', 'status');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;left:50%;bottom:14%;transform:translateX(-50%);z-index:2147483000;'
      + 'padding:8px 14px;border-radius:6px;background:rgba(12,20,17,.92);color:#d8e3de;'
      + 'border:1px solid #2c3a35;font-size:13px;pointer-events:none';
    document.body.appendChild(el);
    setTimeout(() => { try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) { /* ignore */ } }, 2600);
  } catch (e) { /* no DOM (tests): console only */ }
}

// ---- shared-instance registration -----------------------------------------------------------------
// The overlay is loaded from different URLs on different pages (/js/ui/overlayKit.js on the local
// tree, /__sp/ui/overlayKit.js on a server page), so the SAME module body can be evaluated twice.
// Register the FIRST instance on window so every overlay module ends up on ONE preact copy -- hooks
// and render() must come from the same instance or a panel's setState never repaints. Loaders read
// this global AFTER their import resolves (see loadKit() in ui/shellPanels.js); a later copy never
// overwrites it.
try {
  if (typeof window !== 'undefined' && !window.__SP_UI_KIT) {
    window.__SP_UI_KIT = { html, Modal, Button, MicroLabel, Icon, toast, render, useState, useEffect, useRef, useLayoutEffect, useMemo, useCallback };
  }
} catch (e) { /* no window (tests) */ }
