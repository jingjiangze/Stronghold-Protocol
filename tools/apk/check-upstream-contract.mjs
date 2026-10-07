#!/usr/bin/env node
// check-upstream-contract.mjs — GATE-R1 (审计-上游冲突面-2026-10-08.md §8.4).
//
// The shell ships ZERO build-time patches (tools/apk/patches/ is empty by design) and re-apk adds
// paths only, so git merges upstream cleanly and check-patches.mjs has nothing to verify. That made
// the only upstream gate a tautology: an upstream release can land green while the RUNTIME contract
// our extras/overlays depend on is gone. This script asserts that contract against an upstream tree
// and fails LOUDLY (non-zero exit) naming both the broken contract and the shell file that breaks.
//
//   node tools/apk/check-upstream-contract.mjs [upstreamTree]
//
// upstreamTree defaults to $SP_UPSTREAM_TREE, then to the local Windows extraction cache, then to
// this repo (a fork of upstream, so its public/ + server/ are the same files). CI passes the tree
// explicitly. Layouts accepted: an extracted upstream zip (files under public/) or a built webroot
// (flat) — every path is resolved across both.
//
// Contract list mirrors 审计 §3–§6 (the runtime coupling surface):
//   §3.1  DOM selectors/text anchors            (8 anchors)
//   §3.2  upstream module imports               (exports we import)
//   §3.3  the __SP__ global channel
//   §4    startServer() return shape + Lobby API
//   §3.4  i18n label set for the room invite button
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/** Local Windows extraction cache build-webroot.mjs/make-bundle.mjs populate. */
export const DEFAULT_TREE = 'C:/Users/16891/android-build/dl-cache/upstream-extracted/Stronghold-Protocol';

/** The invite-button labels room-hook.js accepts (kept in sync with that file's SRC_LABELS). */
export const ROOM_LABELS = [
  '\u590d\u5236\u5bc6\u94a5',                   // zh-CN 复制密钥 (the upstream source string)
  'Copy Key',                                    // en
  '\ucf54\ub4dc \ubcf5\uc0ac',                   // ko 코드 복사
  '\u30b3\u30fc\u30c9\u3092\u30b3\u30d4\u30fc',  // ja コードをコピー
  '\u8907\u88fd\u91d1\u9470',                    // zh-TW 複製金鑰
];
const I18N_KEY = '\u590d\u5236\u5bc6\u94a5';     // 复制密钥

/** room-hook.js matches the invite button structurally by this icon path (audit D7 / R-02). */
export const COPY_ICON_D = 'M8 3h11v13h-2V5H8zM5 7h10v14H5zm2 2v10h6V9z';

/** Shell files that break when the matching contract breaks (printed with every failure). */
const B = {
  shellPanels: 'tools/apk/extras/public/js/ui/shellPanels.js',
  lobby: 'tools/apk/extras/public/js/lobby.js',
  coreHooks: 'tools/apk/extras/public/js/core-hooks.js',
  homeLayer: 'tools/apk/extras/public/js/home-layer.js',
  roomHook: 'tools/apk/extras/public/js/room-hook.js',
  publishFloat: 'tools/apk/extras/public/js/publish-float.js',
  roomLifecycle: 'tools/apk/extras/public/js/room-lifecycle.js',
  overlays: 'tools/apk/overlay/sp-lobby.mjs + sp-host.mjs + sp-connect.mjs',
  roomDiscovery: 'tools/apk/extras/server/room-discovery.mjs',
};

/** Resolve a tree-relative path across both layouts (upstream zip keeps files under public/). */
function resolveIn(tree, rel) {
  for (const base of [tree, path.join(tree, 'public')]) {
    const p = path.join(base, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readIf(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

/** ESM export presence: named declarations and `export { a, b as c }` (the vendor bundle is minified). */
function hasExport(src, name) {
  if (new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b`).test(src)) return true;
  const m = /export\s*\{([^}]*)\}/g;
  let hit;
  while ((hit = m.exec(src))) {
    // "h as useEffect" and bare "toast" both count; word-boundary on the exported name.
    if (new RegExp(`(?:^|[,{\\s])(?:[\\w$]+\\s+as\\s+)?${name}\\s*(?:,|}|$)`).test(hit[1])) return true;
  }
  return false;
}

/** Concatenated text of every .js under the given tree-relative dirs plus index.html (DOM anchors). */
function collectCode(tree, dirs) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(?:js|mjs|html)$/.test(e.name)) {
        const t = readIf(p);
        if (t != null) out.push(t);
      }
    }
  };
  for (const rel of dirs) {
    const dir = resolveIn(tree, rel);
    if (dir && fs.statSync(dir).isDirectory()) walk(dir);
  }
  const idx = resolveIn(tree, 'index.html');
  if (idx) { const t = readIf(idx); if (t != null) out.push(t); }
  return out.join('\n');
}

// ---- the contract --------------------------------------------------------------------------------

/** Module exports our extras import at runtime (audit §3.2 V6). */
const MODULE_EXPORTS = [
  { rel: 'js/ui/components.js', names: ['html', 'Modal', 'Button', 'MicroLabel', 'closeAllDialogs', 'confirmDialog'],
    breaks: [B.shellPanels, B.lobby, B.coreHooks], why: '壳侧四个面板（服务器/参数/配置/战绩）与返回键弹层' },
  { rel: 'js/ui/toasts.js', names: ['toast'], breaks: [B.shellPanels], why: '面板内的操作提示' },
  { rel: 'js/store.js', names: ['store', 'selectRoute', 'emptyMatch'], breaks: [B.shellPanels, B.lobby],
    why: '面板的「对局中禁切服」判断与路由态' },
  { rel: 'js/ui/gameComponents.js', names: ['GAME_FILES'], breaks: [B.coreHooks], why: '游戏数据预热（首屏速度）' },
];

/** DOM class/text anchors the injected page scripts match (audit §3.1 V7). */
const DOM_ANCHORS = [
  { id: 'title-screen', re: /title-screen/, breaks: [B.homeLayer], why: '首页叠加层永不显示（R-01）' },
  { id: 'title-main', re: /title-main/, breaks: [B.homeLayer], why: '首页叠加层永不显示（R-01）' },
  { id: 'title-cn', re: /title-cn/, breaks: [B.homeLayer], why: '首页叠加层永不显示（R-01）' },
  { id: 'title-login', re: /title-login/, breaks: [B.homeLayer], why: '首页叠加层永不显示（R-01）' },
  { id: 'app-root', re: /app-root/, breaks: [B.homeLayer], why: '首页叠加层挂载点退化为 body（层级语义变化）' },
  { id: '.modal', re: /class="modal"|['"]modal['"]/, breaks: [B.coreHooks], why: '返回键不再先关弹层' },
  { id: 'invite__code', re: /invite__code/, breaks: [B.roomHook, B.publishFloat], why: '房间码读不到（接管失效）' },
  { id: 'invite__btns', re: /invite__btns/, breaks: [B.roomHook], why: '邀请框按钮扫不到（R-02）' },
];

/** startServer() must keep returning this shape (audit §4 V8 / R-06). */
const SERVER_RETURN_KEYS = ['port', 'host', 'url', 'server', 'wss', 'lobby', 'network', 'registry', 'packs', 'close'];
/** Lobby members the overlays call (audit §4 S3/S4/R-07). */
const LOBBY_MEMBERS = [
  { id: 'rooms = new Map()', re: /rooms\s*=\s*new\s+Map\s*\(/, why: '房间列表与发布状态全空' },
  { id: 'getRoom(', re: /getRoom\s*\(/, why: '房间码查询失效' },
  { id: 'broadcastState', re: /broadcastState/, why: 'presence 上报退回 30s 心跳' },
  { id: 'freeSeat(', re: /freeSeat\s*\(/, why: 'LAN 列表空位判定失效' },
  { id: 'activeHumans(', re: /activeHumans\s*\(/, why: 'LAN 列表人数判定失效' },
];

/** Extract the top-level keys of the last `return { ... }` object literal in a source file. */
function returnObjectKeys(src) {
  const at = src.lastIndexOf('return {');
  if (at < 0) return null;
  let i = src.indexOf('{', at), depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(start + 1, i);
  // depth-aware split on commas so nested calls/objects never confuse the key list, and the LAST
  // key (no trailing comma) is still picked up.
  const parts = [];
  let nesting = 0, cur = '';
  for (const ch of body) {
    if (ch === '{' || ch === '(' || ch === '[') nesting++;
    else if (ch === '}' || ch === ')' || ch === ']') nesting--;
    if (ch === ',' && nesting === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  const keys = new Set();
  for (const seg of parts) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(seg);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/**
 * Run the whole contract against `tree`. Never throws.
 * @returns {Promise<{ok:boolean, tree:string, failures:Array<{id:string,detail:string,breaks:string[],why:string}>, notes:string[]}>}
 */
export async function checkContract(tree, opts = {}) {
  const log = opts.log || (() => {});
  const failures = [];
  const notes = [];
  const fail = (id, detail, breaks, why) => failures.push({ id, detail, breaks: breaks || [], why: why || '' });

  const looksUpstream = !!resolveIn(tree, 'index.html') || !!resolveIn(tree, 'server/index.js');
  if (!looksUpstream) {
    fail('tree', `not an upstream tree: neither index.html nor server/index.js under ${tree}`, [], '');
    return { ok: false, tree, failures, notes };
  }

  // §3.2 module exports -------------------------------------------------------------------------
  for (const spec of MODULE_EXPORTS) {
    const p = resolveIn(tree, spec.rel);
    if (!p) { fail(`export:${spec.rel}`, `module missing: ${spec.rel}`, spec.breaks, spec.why); continue; }
    const src = readIf(p) || '';
    const missing = spec.names.filter((n) => !hasExport(src, n));
    if (missing.length) fail(`export:${spec.rel}`, `${spec.rel} no longer exports: ${missing.join(', ')}`, spec.breaks, spec.why);
    else log(`ok: ${spec.rel} exports ${spec.names.join(', ')}`);
  }

  // vendor/hooks.module.js is gitignored upstream and generated by tools/vendor.mjs at build time,
  // so a source zip legitimately lacks it. Accept either the built file or the generator mapping.
  {
    const built = resolveIn(tree, 'vendor/hooks.module.js');
    if (built) {
      const src = readIf(built) || '';
      const missing = ['useState', 'useEffect'].filter((n) => !hasExport(src, n));
      if (missing.length) fail('export:vendor/hooks.module.js', `hooks bundle lacks: ${missing.join(', ')}`, [B.shellPanels, B.lobby], '壳侧面板的 useState/useEffect');
      else log('ok: vendor/hooks.module.js exports useState, useEffect');
    } else {
      const gen = resolveIn(tree, 'tools/vendor.mjs');
      const src = gen ? (readIf(gen) || '') : '';
      if (!gen || !/hooks\.module\.js/.test(src)) {
        fail('export:vendor/hooks.module.js', 'no built vendor/hooks.module.js and tools/vendor.mjs does not generate it', [B.shellPanels, B.lobby], '壳侧面板的 useState/useEffect');
      } else {
        notes.push('vendor/hooks.module.js absent (source tree) but tools/vendor.mjs still generates it — ok');
        log('ok: tools/vendor.mjs still generates vendor/hooks.module.js');
      }
    }
  }

  // §3.3 the __SP__ global channel --------------------------------------------------------------
  {
    const p = resolveIn(tree, 'js/main.js');
    const src = p ? (readIf(p) || '') : '';
    if (!p || !/globalThis\.__SP__\s*=/.test(src)) {
      fail('global:__SP__', 'public/js/main.js no longer assigns globalThis.__SP__', [B.coreHooks, B.roomLifecycle, B.publishFloat], '战绩/幽灵房/悬浮胶囊的主通道');
    } else {
      log('ok: main.js exposes globalThis.__SP__');
    }
  }

  // §3.1 DOM anchors ----------------------------------------------------------------------------
  const domText = collectCode(tree, ['js']);
  if (!domText) {
    fail('dom', 'no public/js sources found', [B.homeLayer, B.roomHook, B.coreHooks], '');
  } else {
    for (const a of DOM_ANCHORS) {
      if (a.re.test(domText)) log(`ok: DOM anchor ${a.id}`);
      else fail(`dom:${a.id}`, `anchor ${a.id} not found in public/js or index.html`, a.breaks, a.why);
    }
  }

  // The invite button is matched structurally by the copy icon's path (room-hook.js COPY_ICON_D).
  // A drifted icon is NOT fatal — the 5-language text fallback still matches — so this is a note.
  {
    const comp = resolveIn(tree, 'js/ui/components.js');
    const src = comp ? (readIf(comp) || '') : '';
    const m = /copy:\s*\{\s*d:\s*'([^']+)'/.exec(src);
    if (m && m[1] !== COPY_ICON_D) {
      notes.push(`copy icon path drifted (components.js "${m[1]}" vs room-hook.js "${COPY_ICON_D}") — `
        + 'room-hook.js falls back to the 5-language text match; update COPY_ICON_D to restore structural matching');
    }
  }

  // §4 startServer() return shape + Lobby API ---------------------------------------------------
  {
    const p = resolveIn(tree, 'server/index.js');
    const src = p ? (readIf(p) || '') : '';
    if (!p) {
      fail('server:startServer', 'server/index.js missing', [B.overlays], '三条服务端叠加层全部只挂日志不挂路由（R-06）');
    } else {
      const keys = returnObjectKeys(src);
      if (!keys) {
        fail('server:startServer', 'could not locate the startServer() return object in server/index.js', [B.overlays], 'R-06');
      } else {
        const missing = SERVER_RETURN_KEYS.filter((k) => !keys.has(k));
        if (missing.length) fail('server:startServer', `startServer() no longer returns: ${missing.join(', ')}`, [B.overlays], 'resolveHttpServer/lobby 拿不到 → 叠加层静默失效（R-06）');
        else log(`ok: startServer() returns {${SERVER_RETURN_KEYS.join(', ')}}`);
      }
    }
  }
  {
    const p = resolveIn(tree, 'server/lobby.js');
    const src = p ? (readIf(p) || '') : '';
    if (!p) {
      fail('server:lobby', 'server/lobby.js missing', [B.overlays, B.roomDiscovery], 'LAN 列表 / 大厅发布 / 房间发现（R-07）');
    } else {
      const missing = LOBBY_MEMBERS.filter((m) => !m.re.test(src));
      if (missing.length) {
        fail('server:lobby', `Lobby no longer exposes: ${missing.map((m) => m.id).join(', ')}`,
          [B.overlays, B.roomDiscovery], missing.map((m) => m.why).join('；'));
      } else log('ok: Lobby exposes rooms/getRoom/broadcastState/freeSeat/activeHumans');
    }
  }

  // §3.4 i18n label set for the room invite button (audit V9 / R-02) -----------------------------
  {
    const dir = resolveIn(tree, 'i18n');
    let files = [];
    try { files = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { /* none */ }
    if (!files.length) {
      notes.push('no public/i18n/*.json found — the invite-button label set was not cross-checked');
    } else {
      const missing = [];
      for (const f of files) {
        let doc;
        try { doc = JSON.parse(readIf(path.join(dir, f)) || '{}'); } catch { continue; }
        const v = doc[I18N_KEY];
        if (typeof v === 'string' && !ROOM_LABELS.includes(v)) missing.push(`${f}: "${v}"`);
      }
      if (missing.length) {
        fail('i18n:room-label', `room-hook.js label set does not cover: ${missing.join('; ')}`,
          [B.roomHook], '该语言下「公开到大厅」接管不触发（R-02）');
      } else if (files.length < 4) {
        notes.push(`only ${files.length} i18n file(s) present — label coverage is partial`);
      } else {
        log(`ok: room-hook label set covers ${files.length} i18n files`);
      }
    }
  }

  return { ok: failures.length === 0, tree, failures, notes };
}

/**
 * Optional live boot of the upstream server (audit V8). Only meaningful on a tree with node_modules
 * installed (a built webroot); a source zip has none, so this is a no-op there.
 */
async function runtimeServerCheck(tree, log) {
  const entry = resolveIn(tree, 'server/index.js');
  const hasModules = !!resolveIn(tree, 'node_modules');
  if (!entry || !hasModules) {
    log(`runtime startServer(): skipped (no node_modules under ${tree})`);
    return { status: 'skip' };
  }
  let mod;
  try {
    mod = await import(pathToFileURL(entry).href);
  } catch (e) {
    // A missing dependency is a skip, not a contract break; a shape error below is a failure.
    if (/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(String(e && e.message))) {
      log(`runtime startServer(): skipped (${e.message.split('\n')[0]})`);
      return { status: 'skip' };
    }
    return { status: 'fail', detail: `import failed: ${e.message}` };
  }
  let srv;
  try {
    srv = await mod.startServer({ port: 0, host: '127.0.0.1', quiet: true });
  } catch (e) {
    return { status: 'fail', detail: `startServer() threw: ${e.message}` };
  }
  try {
    const bad = [];
    if (typeof srv.server?.on !== 'function') bad.push('srv.server.on is not a function');
    if (typeof srv.close !== 'function') bad.push('srv.close is not a function');
    if (!(srv.lobby?.rooms instanceof Map)) bad.push('srv.lobby.rooms is not a Map');
    if (typeof srv.lobby?.getRoom !== 'function') bad.push('srv.lobby.getRoom is not a function');
    if (typeof srv.lobby?.broadcastState !== 'function') bad.push('srv.lobby.broadcastState is not a function');
    if (bad.length) return { status: 'fail', detail: bad.join('; ') };
    log('runtime startServer(): shape ok (server.on, lobby.rooms Map, getRoom, broadcastState)');
    return { status: 'ok' };
  } finally {
    try { await srv.close(); } catch { /* best effort */ }
  }
}

function resolveTreeArg(argv) {
  const arg = argv.find((a, i) => i >= 2 && !a.startsWith('--'));
  if (arg) return path.resolve(arg);
  const env = (process.env.SP_UPSTREAM_TREE || '').trim();
  if (env) return path.resolve(env);
  if (fs.existsSync(path.join(DEFAULT_TREE, 'server', 'index.js'))) return path.resolve(DEFAULT_TREE);
  // fall back to a single subdir under the extraction cache, then to this repo (a fork of upstream)
  const cache = path.resolve(REPO, '..', 'dl-cache', 'upstream-extracted');
  try {
    const sub = fs.readdirSync(cache).filter((n) => fs.statSync(path.join(cache, n)).isDirectory());
    if (sub.length === 1) return path.join(cache, sub[0]);
  } catch { /* no cache */ }
  return REPO;
}

async function main() {
  const tree = resolveTreeArg(process.argv);
  const runtime = process.argv.includes('--runtime') || process.env.SP_CONTRACT_RUNTIME === '1';
  console.log(`runtime contract check against: ${tree}`);
  const res = await checkContract(tree);
  for (const n of res.notes) console.log(`note: ${n}`);

  let runtimeFailed = null;
  if (runtime) {
    const r = await runtimeServerCheck(tree, (m) => console.log(m));
    if (r.status === 'fail') runtimeFailed = r.detail;
  }

  if (res.failures.length || runtimeFailed) {
    console.error('');
    for (const f of res.failures) {
      console.error(`CONTRACT FAIL: ${f.id} — ${f.detail}`);
      if (f.why) console.error(`  后果: ${f.why}`);
      if (f.breaks && f.breaks.length) console.error(`  会坏掉: ${f.breaks.join('  ')}`);
    }
    if (runtimeFailed) {
      console.error(`CONTRACT FAIL: server:startServer (runtime) — ${runtimeFailed}`);
      console.error(`  后果: 三条服务端叠加层全部只挂日志不挂路由（R-06）`);
      console.error(`  会坏掉: ${B.overlays}`);
    }
    console.error('');
    console.error(`runtime contract: ${res.failures.length + (runtimeFailed ? 1 : 0)} broken`);
    process.exit(1);
  }
  console.log('runtime contract: all checks passed');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
