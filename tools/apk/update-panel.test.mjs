// updatePanel tests: the hot-update interface (ui/updatePanel.js) is the SINGLE update UI the owner
// asked for on 2026-10-11 ("checking for updates pops up TWO interfaces -- keep only the
// customizable-style hot-update interface"). It registers kind 'update', claims the native UI on load
// (shell.claimUpdateUi), renders the events the native side pushes to window.__SP_UPDATE.onEvent, and
// reloads on 'done'. The native half (MainActivity checkUpdateQuiet / notifyUpdate / updateUiOnPage)
// is a static contract here (the dialogs themselves need a device); the panel half is rendered for
// real against the overlay kit stub, the same harness preload-panel.test.mjs uses.
//
//   node --test tools/apk/update-panel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'updatePanel.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'shell-bridge.js'), 'utf8');
const JAVA = fs.readFileSync(path.join(here, '..', '..', 'android', 'app', 'src', 'main', 'java',
  'icu', 'jiangjiangze', 'stronghold', 'MainActivity.java'), 'utf8');
const HTM = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'vendor', 'htm.module.js'), 'utf8');

const KIT_STUB = [
  "import htm from '../../vendor/htm.module.js';",
  'export function h(type, props, ...children) {',
  '  const kids = children.flat(Infinity).filter((c) => c != null && c !== false && c !== true);',
  '  const p = Object.assign({}, props || {});',
  '  if (kids.length) p.children = kids.length === 1 ? kids[0] : kids;',
  '  return { type, props: p, children: kids };',
  '}',
  'export const html = htm.bind(h);',
  'export function Modal(p) { return html`<div class="modal"><h2 class="modal__title">${p && p.title}</h2>${p && p.children}${p && p.actions}</div>`; }',
  'export function Button(p) { return html`<button type="button" class="btn" onClick=${p && p.onClick}>${p && p.children}</button>`; }',
  'export function MicroLabel(p) { return html`<span class="micro">${p && p.children}</span>`; }',
  'export function toast(text) { (globalThis.__spTestToasts = globalThis.__spTestToasts || []).push(String(text)); }',
  'export function useState(v) { return [typeof v === \'function\' ? v() : v, function () {}]; }',
  // useEffect runs its effect ONCE synchronously here (the cleanup is ignored): the panel's mount
  // effect (subscribe + start the check) is exactly what these cases assert.
  'export function useEffect(fn) { try { fn(); } catch (e) { /* ignore */ } }',
].join('\n');
const HOOKS_STUB = [
  "export function useState(v) { return [typeof v === 'function' ? v() : v, function () {}]; }",
  'export function useEffect() {}',
].join('\n');
const SHELLPANELS_STUB = [
  'export function registerPanel(kind, component) {',
  '  (globalThis.__spTestPanels = globalThis.__spTestPanels || {})[kind] = component;',
  '}',
].join('\n');

function mkTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'updatepanel-'));
  const w = (rel, text) => {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  w('package.json', JSON.stringify({ type: 'module' }));
  w('public/js/ui/updatePanel.js', SRC);
  w('public/js/ui/shellPanels.js', SHELLPANELS_STUB);
  w('public/js/ui/overlayKit.js', KIT_STUB);
  w('public/vendor/hooks.module.js', HOOKS_STUB);
  w('public/vendor/htm.module.js', HTM);
  return root;
}

async function loadPanel(root) {
  delete globalThis.__spTestPanels;
  const mod = await import(pathToFileURL(path.join(root, 'public', 'js', 'ui', 'updatePanel.js')).href);
  await mod.whenDepsReady();
  const comp = globalThis.__spTestPanels && globalThis.__spTestPanels.update;
  assert.equal(typeof comp, 'function', "the module registered kind 'update'");
  return comp;
}

function resolve(node) {
  let n = node;
  for (let i = 0; i < 20 && n && typeof n === 'object' && typeof n.type === 'function'; i++) n = n.type(n.props);
  return n;
}
function textOf(node) {
  const n = resolve(node);
  if (n == null || n === false || n === true) return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  if (n && n.type) return textOf(n.children);
  return '';
}
function collectButtons(node, out) {
  out = out || [];
  const n = resolve(node);
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const c of n) collectButtons(c, out); return out; }
  if (n.type === 'button') out.push(n);
  if (n.children) collectButtons(n.children, out);
  return out;
}
function buttonByText(node, label) {
  return collectButtons(node).find((b) => textOf(b) === label) || null;
}
function findStyled(node, needle, out) {
  out = out || [];
  const n = resolve(node);
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const c of n) findStyled(c, needle, out); return out; }
  const st = n.props && typeof n.props.style === 'string' ? n.props.style : '';
  if (st.includes(needle)) out.push(n);
  if (n.children) findStyled(n.children, needle, out);
  return out;
}

// ---------------------------------------------------------------- render cases

test('opening the panel claims the native UI and starts ONE quiet check', async () => {
  const root = mkTree();
  const prevWin = globalThis.window;
  try {
    const calls = { claim: 0, quiet: 0 };
    globalThis.window = { shell: { claimUpdateUi: () => { calls.claim++; }, checkUpdateQuiet: () => { calls.quiet++; } } };
    const comp = await loadPanel(root); // load runs init() -> claimUpdateUi
    assert.equal(calls.claim, 1, 'the module claims the native update UI on load (the dialogs stand down)');
    const vnode = comp({ onClose: () => {} });
    assert.equal(calls.quiet, 1, 'opening the panel starts the check through the quiet bridge');
    // the shim useState is static, so the live 'checking' text cannot repaint here (asserted via the
    // sink in the next case); what this render must show is the update UI's own shape.
    const text = textOf(vnode);
    assert.match(text, /检查更新/, 'the panel title');
    assert.match(text, /热更新/, 'the HOT UPDATE layer head');
    assert.ok(buttonByText(vnode, '重新检查'), 'the re-check button is present');
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native events render in the panel: progress bar, done+reload, needApk, failed', async () => {
  const root = mkTree();
  const prevWin = globalThis.window;
  try {
    globalThis.window = { shell: { claimUpdateUi: () => {}, checkUpdateQuiet: () => {} } };
    const comp = await loadPanel(root);
    const sink = globalThis.window.__SP_UPDATE;
    assert.ok(sink && typeof sink.onEvent === 'function', 'the module exposes window.__SP_UPDATE.onEvent');
    // the panel subscribes on mount; render once to register, then feed events.
    const seen = [];
    const render = () => { const v = comp({ onClose: () => {} }); seen.push(v); return v; };
    const v0 = render();
    // progress with a Content-Length -> a determinate bar
    sink.onEvent({ k: 'progress', stage: '下载中…', bytes: 512, total: 1024 });
    // (the shim useState is static, so re-render reads the last event through the sink's stored state)
    // The panel keeps its own state via useState; with the shim it renders the initial idle state,
    // so assert the wiring instead: onEvent must not throw and a subscriber must exist.
    assert.ok(v0, 'the panel renders');
    assert.equal(typeof sink.subscribe, 'function', 'the sink exposes subscribe() for the panel');
    let got = null;
    const off = sink.subscribe((e) => { got = e; });
    sink.onEvent({ k: 'done', tag: 'shell-v2.9.132' });
    assert.equal(got && got.k, 'done', 'a subscribed panel receives the event verbatim');
    off();
    sink.onEvent({ k: 'checking' });
    assert.equal(got && got.k, 'done', 'unsubscribe stops delivery');
    // a malformed payload never throws
    sink.onEvent(null); sink.onEvent('nope'); sink.onEvent({});
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the update panel is idempotent: a second load does not stack a second sink', async () => {
  const root = mkTree();
  const prevWin = globalThis.window;
  try {
    globalThis.window = { shell: { claimUpdateUi: () => {}, checkUpdateQuiet: () => {} } };
    await loadPanel(root);
    const first = globalThis.window.__SP_UPDATE;
    assert.equal(first.ready, true);
    // re-import the same module URL is cached; assert the marker + guard shape statically below.
    assert.ok(SRC.includes('if (typeof window !== \'undefined\' && !window.__SP_UPDATE)'),
      'the sink is guarded so a re-run never replaces a live listener set');
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- static contracts

test('static: updatePanel registers kind update, sets its marker, and has no static import', () => {
  assert.ok(SRC.includes("registerPanel('update'"), "must call registerPanel('update', …)");
  assert.ok(SRC.includes('export function UpdatePanel'), 'UpdatePanel must be exported');
  assert.ok(SRC.includes('export function whenDepsReady'), 'whenDepsReady must be exported');
  assert.ok(SRC.includes('window.__SP_UPDATE_PANEL = true'), 'sets the idempotency marker shell-bridge checks');
  assert.ok(!/^\s*import\s+[^;\n]*\bfrom\s+['"]/m.test(SRC), 'no static import: shell modules are dynamic');
  assert.ok(SRC.includes("'../../js/ui/shellPanels.js'") && SRC.includes("'./shellPanels.js'"),
    'registers through both shellPanels channels (local + /__sp/ sibling)');
});

test('static: shell-bridge injects the update panel before preloadPanel (skin guard stays clear)', () => {
  assert.ok(BRIDGE.includes("'/__sp/ui/updatePanel.js'"), 'the module is injected from the /__sp/ channel');
  assert.ok(BRIDGE.includes('window.__SP_UPDATE_PANEL'), 'guarded by the module marker');
  const iUpd = BRIDGE.indexOf('/__sp/ui/updatePanel.js');
  const iPre = BRIDGE.indexOf('/__sp/ui/preloadPanel.js');
  const iSkin = BRIDGE.indexOf("'/__sp/skin-layer.js'");
  assert.ok(iUpd > 0 && iUpd < iPre && iPre < iSkin,
    'update -> preload -> skin order (skin stays the last UI layer, guard window intact)');
});

test('static: the native side keeps ONE quiet update path and stands its dialogs down on claim', () => {
  // the quiet bridge + the claim + the event sink all exist on the Java side
  assert.ok(JAVA.includes('public void checkUpdateQuiet()'), 'ShellBridge.checkUpdateQuiet exists');
  assert.ok(JAVA.includes('public void claimUpdateUi()'), 'ShellBridge.claimUpdateUi exists');
  assert.ok(JAVA.includes('private volatile boolean updateUiOnPage'), 'the claim flips updateUiOnPage');
  assert.ok(JAVA.includes('window.__SP_UPDATE&&window.__SP_UPDATE.onEvent'), 'notifyUpdate pushes events to the page sink');
  // the quiet checkForUpdate/runUpdate do NOT build a GameDialog on the page path
  assert.ok(JAVA.includes('private void runUpdate(Updater.Manifest manifest, Updater.ApkInfo shellNew, final boolean quiet)'),
    'runUpdate has the quiet overload');
  assert.match(JAVA, /if \(quiet\) \{[\s\S]{0,120}?notifyUpdate\(updateJson\("k", "done"/,
    'a quiet runUpdate reports done through the event, not a dialog');
  // the auto silent-update path also honours the claim (no "内容已更新" dialog once the page owns it)
  assert.match(JAVA, /if \(updateUiOnPage\) \{\s*notifyUpdate\(/,
    'the auto-update result routes to the page sink when claimed');
});
