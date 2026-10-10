// overlay-split.test.mjs — the "叠加 UI 与服务器拆分" gate (owner direction 2026-10-10:
// 「将叠加 ui 和服务器做拆分」). The overlay (floating window / panels / lobby) must carry its OWN
// styles and its OWN scripts: it must look and behave the same on the local tree page and on ANY
// third-party server page. Three assertions:
//
//   (a) the overlay's UI modules import NO UI path from the page origin (store.js / net.js are the
//       only page-origin imports allowed -- they are the game's own modules, the overlay's hooks must
//       attach to THAT page's game instance);
//   (b) every class the overlay's templates use has a rule in the overlay's OWN stylesheet
//       (scoped under .sp-ui, injected from extras), so nothing depends on the page's css/*;
//   (c) that stylesheet is injected on EVERY page the overlay loads on, idempotently, and the panel
//       host carries the .sp-ui scope class.
//
//   node --test tools/apk/overlay-split.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXTRAS = path.join(here, 'extras', 'public', 'js');
const read = (rel) => fs.readFileSync(path.join(EXTRAS, ...rel.split('/')), 'utf8');

const SHELLPANELS = read('ui/shellPanels.js');
const PRELOADPANEL = read('ui/preloadPanel.js');
const LOBBY = read('lobby.js');
const KIT = read('ui/overlayKit.js');

/** Strip // line comments and block comments so prose about removed paths cannot trip the gate. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------------------------------
// (a) no page-origin UI imports in the overlay UI modules
// ---------------------------------------------------------------------------------------------------
test('(a) 叠加 UI 模块不从页面 origin import UI 路径（store.js / net.js 白名单）', () => {
  const banned = [
    'js/ui/components.js',
    'js/ui/gameComponents.js',
    'js/ui/toasts.js',
    'js/ui/assetUrls.js',
    '/vendor/hooks.module.js',
    '/vendor/htm.module.js',
    '/vendor/preact.module.js',
  ];
  for (const [name, src] of [['ui/shellPanels.js', SHELLPANELS], ['ui/preloadPanel.js', PRELOADPANEL], ['lobby.js', LOBBY]]) {
    const code = stripComments(src);
    for (const b of banned) {
      assert.ok(!code.includes(b), `${name} 不许从页面 origin 取 UI：${b}`);
    }
  }
  // 页面 origin 允许的只有游戏自己的模块
  assert.ok(LOBBY.includes("import('/js/store.js')"), 'lobby 的 store 仍走页面 origin');
  assert.ok(LOBBY.includes("import('/js/net.js')"), 'lobby 的 net 仍走页面 origin');
  assert.ok(SHELLPANELS.includes("import('/js/store.js')"), 'shellPanels 的 store 优先走页面 origin');
});

test('(a) UI 一律来自自带套件 ui/overlayKit.js（/__sp/ 通道），套件与 vendored preact 随 extras 交付', () => {
  // 套件文件 + 它依赖的 vendored 库都在 extras 里（因此 /js/ui/overlayKit.js 与
  // /__sp/ui/overlayKit.js 两条路径都能取到同一份）
  for (const rel of ['ui/overlayKit.js', 'vendor/preact.module.js', 'vendor/htm.module.js', 'vendor/hooks.module.js']) {
    assert.ok(fs.existsSync(path.join(EXTRAS, ...rel.split('/'))), `extras 必须自带 ${rel}`);
  }
  // 套件从相对 ../vendor/* 取 preact/htm/hooks：/js/ui/ -> /js/vendor/，/__sp/ui/ -> /__sp/vendor/
  assert.ok(KIT.includes("from '../vendor/preact.module.js'"), '套件必须从 ../vendor/ 取 preact');
  assert.ok(KIT.includes("from '../vendor/htm.module.js'"), '套件必须从 ../vendor/ 取 htm');
  assert.ok(KIT.includes("from '../vendor/hooks.module.js'"), '套件必须从 ../vendor/ 取 hooks');
  // 套件把自身注册成共享单例（hooks 与 render 必须同一份 preact）
  assert.ok(KIT.includes('window.__SP_UI_KIT'), '套件必须注册 window.__SP_UI_KIT 共享单例');
  // 三个 UI 模块都从套件取 UI
  assert.ok(SHELLPANELS.includes("const KIT_SPEC = './overlayKit.js'"), 'shellPanels 从套件取 UI');
  assert.ok(PRELOADPANEL.includes("import('./overlayKit.js')"), 'preloadPanel 从套件取 UI');
  assert.ok(LOBBY.includes("import('./ui/overlayKit.js')"), 'lobby 从套件取 UI');
});

// ---------------------------------------------------------------------------------------------------
// (b) the overlay's own stylesheet covers every class its templates use
// ---------------------------------------------------------------------------------------------------
/** Extract the CSS text of overlayStyleCss() (one rule per array line, static-extractable). */
function overlayCss() {
  const m = SHELLPANELS.match(/function overlayStyleCss\(\) \{\n  return \[([\s\S]*?)\n  \]\.join\(''\);/);
  assert.ok(m, 'overlayStyleCss() 必须是一行一条的数组字面量（可静态提取）');
  return (m[1].match(/'((?:[^'\\]|\\.)*)'/g) || []).map((s) => s.slice(1, -1)).join('');
}

// Every class the overlay actually styles: the kit's markup (Modal/Button/MicroLabel) plus the
// classes the panel templates use. Keep in sync with ui/overlayKit.js + the three template files.
const INVENTORY = [
  'modal', 'modal__box', 'modal__stripe', 'modal__head', 'modal__title', 'modal__body', 'modal__actions',
  'micro', 'num', 'icon',
  'btn', 'btn__icon', 'btn__label', 'btn--primary', 'btn--secondary', 'btn--danger', 'btn--amber', 'btn--ice', 'btn--ghost',
  'btn--sm', 'btn--lg', 'btn--xl',
  'set-list', 'set-row', 'set-row__label', 'set-row__val', 'set-input', 'set-seg', 'set-range', 'set-apply',
  'set-toggle', 'set-hint', 'set-hint--tight',
];

test('(b) 自带的样式表为清单里每一个类都写了规则', () => {
  const css = overlayCss();
  assert.ok(css.length > 0, 'overlayStyleCss() 不能为空');
  for (const cls of INVENTORY) {
    // a rule whose selector names .<cls> (e.g. `.sp-ui .set-row{` or `.sp-ui .set-seg button{`)
    const re = new RegExp('\\.' + cls.replace(/[-]/g, '\\-') + '(?![\\w-])');
    assert.ok(re.test(css), `自带样式表必须定义 .${cls}`);
  }
});

test('(b) 模板里出现的每一个上游类名都在清单内（不许用未定义的类）', () => {
  const upstreamPrefix = /^(modal|btn|set-|micro|num$|status-dot|brackets|icon$)/;
  const used = new Set();
  for (const src of [SHELLPANELS, PRELOADPANEL, LOBBY]) {
    const code = stripComments(src);
    for (const m of code.matchAll(/class="([^"]*)"/g)) m[1].split(/\s+/).forEach((c) => used.add(c));
    // dynamic base strings: class=${'btn btn--' + ...}, class=${'sp-srv-cell' + ...}
    for (const m of code.matchAll(/class=\$\{'([^']*)'/g)) m[1].split(/\s+/).forEach((c) => used.add(c));
  }
  // state modifiers are applied dynamically; they are not standalone classes to define
  const MODIFIERS = new Set(['is-on', 'is-cur', 'is-off', 'is-active', 'is-loading']);
  const inv = new Set(INVENTORY);
  const missing = [];
  for (const c of used) {
    if (!c || c.startsWith('sp-')) continue;         // our own sp-* namespaces are defined separately
    if (c.endsWith('-')) continue;                    // a concatenation fragment like 'btn--'
    if (!upstreamPrefix.test(c)) continue;            // not an upstream design-system class
    if (MODIFIERS.has(c)) continue;
    if (!inv.has(c)) missing.push(c);
  }
  assert.deepEqual(missing, [], '这些上游类被模板用到但没有写进清单/样式：' + missing.join(', '));
});

test('(b) 样式表全部限定在 .sp-ui 之内（不污染页面）', () => {
  const css = overlayCss();
  const selectors = [];
  for (const m of css.matchAll(/([^{}]+)\{/g)) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@')) continue; // media prelude
    selectors.push(sel);
  }
  assert.ok(selectors.length > 0, '必须能解析出选择器');
  for (const sel of selectors) {
    for (const part of sel.split(',')) {
      const s = part.trim();
      if (!s) continue;
      assert.ok(s.startsWith('.sp-ui'), '每条选择器都必须以 .sp-ui 开头（不污染页面）：' + s);
    }
  }
});

// ---------------------------------------------------------------------------------------------------
// (c) the stylesheet is injected on every page, idempotently, and the host carries the scope class
// ---------------------------------------------------------------------------------------------------
test('(c) 自带样式表随叠加层注入每一个页面（幂等）', () => {
  assert.ok(SHELLPANELS.includes("const UI_STYLE_ID = 'sp-ui-style'"), '样式表 id 必须是 sp-ui-style');
  assert.ok(SHELLPANELS.includes('export function injectOverlayStyles'), 'injectOverlayStyles 必须导出');
  assert.ok(SHELLPANELS.includes('document.getElementById(UI_STYLE_ID)'), '注入必须按 id 幂等');
  assert.ok(SHELLPANELS.includes('head.appendChild(el)'), '必须真的把 <style> 挂进 head');
  // 模块加载时注入一次（shellPanels 在每个页面都会被 shell-bridge / lobby 装载）
  assert.ok(/^try \{ injectOverlayStyles\(\); \} catch \(e\) \{ \/\* silent: mount retries \*\/ \}$/m.test(SHELLPANELS),
    '模块加载时必须注入一次（幂等）');
  // 宿主挂载时再注入一次（head 未就绪时的兜底）
  assert.ok(SHELLPANELS.includes('try { injectOverlayStyles(); } catch (e) { /* silent */ } // the overlay'),
    'mountShellPanelHost 里必须再注入一次');
  // shell-bridge 在每个页面（含服务器页）都注入 shellPanels.js -> 样式表随之到位
  const BRIDGE = read('shell-bridge.js');
  assert.ok(BRIDGE.includes("'/__sp/ui/shellPanels.js'"), 'shell-bridge 必须注入 shellPanels.js（样式随它到每个页面）');
});

test('(c) 面板宿主带 .sp-ui 作用域类（规则只在宿主内匹配）', () => {
  assert.ok(SHELLPANELS.includes("host.setAttribute('class', 'sp-ui')"), '宿主必须带 sp-ui 类');
  assert.ok(SHELLPANELS.includes('data-sp-panel-host'), '宿主标记 data-sp-panel-host 仍在');
});

test('(c) 无 DOM 时注入是安全 no-op（测试/老壳不炸）', () => {
  // static shape check: the injector guards on typeof document before touching it
  const body = SHELLPANELS.slice(SHELLPANELS.indexOf('export function injectOverlayStyles'));
  const fn = body.slice(0, body.indexOf('\n}') + 2);
  assert.ok(fn.includes("typeof document === 'undefined'"), '无 document 时必须静默返回');
  assert.ok(fn.includes('catch (e) { return false; }'), '任何异常都必须吞掉并返回 false');
});
