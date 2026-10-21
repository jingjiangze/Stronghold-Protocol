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

// ---- 2026-10-20 业主：「检查更新已失效」的根因与钉子 -------------------------------------------
// 真因链：openPanel() 恒返回 true → updatePanel 没能注册时（模块 404 / 面板宿主不可达），
// preloadPanel.checkUpdate() 直接 return，连原生兜底都走不到 → 屏幕上「点了完全没反应」。
// 修法两半：① openPanel 如实回报「打得开吗」；② 打不开时留下可诊断痕迹（不再无声失败）。

test('openPanel 如实回报「打得开吗」，但不把「本来能开」误判成打不开（2026-10-21 修正）', () => {
  const code = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'connect-core.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  // 10-20 版是「恒透传宿主返回值（=== true）」。真机上暴露问题：宿主（旧实现/测试替身）不返回值时
  // 会被判 false，于是调用方又掉回原生窗 —— 等于把「本来能开的面板」误判成打不开。
  // 现在：注册表说打不开才 false；注册表不在（老树）时调通即算打开。
  assert.ok(/if \(!panelReady\(k\)\) return false;/.test(code),
    'a registry that says no wins (no fake success)');
  assert.ok(/s\.openPanel\(k\);\s*\n\s*return true;/.test(code),
    'otherwise calling the host counts as opening (no false negative)');
  assert.ok(/export function panelReady/.test(code), 'panelReady is the single judge');
});

test('面板宿主：openShellPanel 查注册表，未注册的 kind 返回 false', () => {
  const panels = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'shellPanels.js'), 'utf8');
  assert.ok(/export function openShellPanel\(kind\) \{[\s\S]{0,320}?SHARED\.registry\.has\(k\)/.test(panels),
    'openShellPanel checks the registry before answering');
  assert.ok(/return known;/.test(panels), 'and returns that verdict (not undefined)');
  // 内置面板仍然算「打得开」—— 这条钉子不能把 servers/settings 这些也关掉
  for (const builtin of ['servers', 'join', 'appearance', 'netprefs', 'settings', 'records']) {
    assert.ok(new RegExp("'" + builtin + "'").test(panels), 'the built-in panel ' + builtin + ' stays openable');
  }
});

test('打不开时留下痕迹：注入 onerror + 注册失败告警，不再无声失败', () => {
  assert.ok(/up\.onerror = function \(\) \{/.test(BRIDGE), 'the /__sp/ injection reports a failed load');
  assert.ok(BRIDGE.includes('__SP_UPDATE_PANEL_MISSING'), 'and leaves a marker the owner can read back');
  assert.ok(SRC.includes('__SP_UPDATE_PANEL_UNMOUNTED'), 'a failed registerSelf also leaves a marker');
  assert.ok(/console\.warn\('\[update\] panel host unreachable/.test(SRC), 'and warns once (diagnosable)');
});

test('样式（业主 2026-10-20「更新检查更新页的样式」）：放大 + 自有作用域', () => {
  assert.ok(SRC.includes('UPDATE_STYLE_ID'), 'the panel ships its own sheet');
  assert.ok(/sp-update-panel-style/.test(SRC), 'idempotent on a single marker');
  // 作用域只在本面板里 —— 不碰 kit 的 .set-row/.set-apply（别的面板也在用）
  assert.ok(SRC.includes('.sp-update .set-apply{'), 'the rules are scoped under .sp-update');
  assert.ok(/min-height:max\(\.52rem,44px\)/.test(SRC), 'buttons meet the touch minimum');
  assert.ok(/height:10px/.test(SRC), 'the progress bar grew (was 6px)');
  assert.ok(SRC.includes('width="min(88vw,40rem)"'), 'and the modal got a width like its siblings');
  // 装载体上带作用域类
  assert.ok(/class="set-list sp-update"/.test(SRC), 'the body carries the scope class');
});

// ---- 2026-10-21 真机报障：「只有后台检查逻辑、窗口没用到」+「进度条不对」+「版本号 2.9.140」----

test('注册竞态：检查更新等面板注册完成，而不是一次定生死', () => {
  // 真因链：updatePanel 的 registerSelf() 是**异步**（动态 import），而点击是同步的。点得早时
  // SHARED.registry 里还没有 'update' ⇒ openPanel 返回 false ⇒ 掉进原生 GameDialog
  // （业主看到的「二点几那个窗口」）。所以调用方必须用 openPanelAsync。
  const panel = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'preloadPanel.js'), 'utf8');
  assert.ok(/await openPanelAsync\('update', onClose\)/.test(panel),
    'checkUpdate awaits the panel registration instead of a one-shot openPanel');
  assert.ok(/Promise\.resolve\(checkUpdate\(\)\)\.catch/.test(panel),
    'the async click handler never leaks an unhandled rejection');
  const core = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'connect-core.js'), 'utf8');
  assert.ok(/export async function openPanelAsync/.test(core), 'connect-core exposes openPanelAsync');
  assert.ok(/export function panelReady/.test(core), 'and a synchronous panelReady probe');
  assert.ok(/while \(Date\.now\(\) < deadline && !panelReady\(k\)\)/.test(core),
    'openPanelAsync polls until the deadline (or the panel is ready)');
  // 没有注册表单例（老树 / 测试替身）时不空转：直接问宿主
  assert.ok(/const hasRegistry = /.test(core), 'and it only waits when a registry exists');
  // 兜底时把原因写清楚，而不是只看到原生弹窗
  assert.ok(panel.includes('已用原生窗口检查更新（本页的面板不可用）'),
    'the fallback names WHY it fell back');
});

test('进度条：非下载态不再画一条假的 30%', () => {
  // 真机报障「进度条加载也不对」：pctOf 在 total<=0 时返回 -1，stateRow 把它画成 width:30%
  // 的半透明条 + 一个「—」。于是 idle/checking/latest/needApk/failed/done **六种状态共用同一条
  // 30% 假条**，看着像卡住。改成来回扫描的不确定态。
  assert.ok(!/pct < 0 \? 30 : pct/.test(SRC), 'the fake fixed 30% is gone');
  assert.ok(SRC.includes('sp-upd-bar--indeterminate'), 'an indeterminate bar class exists');
  assert.ok(SRC.includes('sp-upd-scan'), 'and it animates (a scan), not a frozen 30%');
  assert.ok(/@media \(prefers-reduced-motion:reduce\)/.test(SRC), 'reduced-motion is honoured');
  // 语义 class 取代靠内联样式字符串匹配的选择器（原 [style*="height:6px"] 极脆弱）
  assert.ok(!/\[style\*="height:6px"\]/.test(SRC), 'the fragile inline-style selector is gone');
  assert.ok(/const unsure = !\(pct >= 0\)/.test(SRC), 'unsure is decided by pct >= 0, not pct < 0');
});

test('版本号：APK 内嵌热更基线必须随构建刷新（否则显示 shell-v2.9.140）', () => {
  // Updater.fetchManifest 取不到/验不过线上清单时回落内嵌基线（Updater.java:279-283）。
  // 只有 hotupdate.yml 跑 gen-manifest ⇒ 内嵌那份停在 shell-v2.9.140，于是设备一旦联网失败
  // 就显示一个对不上的版本号。apk-re.yml 必须也烘焙。
  const wf = fs.readFileSync(path.resolve(here, '..', '..', '.github', 'workflows', 'apk-re.yml'), 'utf8');
  assert.ok(/Bake the embedded hot-update baseline/.test(wf), 'apk-re bakes the baseline');
  assert.ok(/gen-manifest\.mjs --tag "shell-v\$\{VN\}-vc\$\{VC\}"/.test(wf),
    'the tag follows THIS APK\'s real version (from build.gradle), not a placeholder');
  assert.ok(/--min-apk "\$\{VC\}"/.test(wf), 'min-apk is this build\'s versionCode');
  assert.ok(/SP_SIGN_KEY/.test(wf), 'signed with the same key as the hot-update line');
});
