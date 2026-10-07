// check-upstream-contract (GATE-R1) behavior tests: build a synthetic upstream tree, run the REAL
// checker (in-process and via the CLI) and prove it fails loudly, naming both the broken contract
// and the shell file that breaks.
//
// Covers: a complete tree passes / a dropped module export fails / a dropped DOM anchor fails /
// a changed startServer() return shape fails / an i18n label the room hook does not know fails /
// vendor/hooks.module.js is accepted either built or via tools/vendor.mjs / a non-upstream path is
// rejected / the CLI exits non-zero on a broken tree / the real repo tree (an upstream 0.2.1 fork)
// and the local extraction cache both pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkContract, DEFAULT_TREE, ROOM_LABELS, COPY_ICON_D } from './check-upstream-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const CLI = path.join(here, 'check-upstream-contract.mjs');

/** A minimal but complete upstream tree — every contract satisfied, then mutated per test. */
function mkTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-contract-'));
  const w = (rel, text) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  w('index.html', '<html><body><div id="app"></div></body></html>');
  w('js/main.js', "// boot\nconst app = html`<div class=\"app-root\"></div>`;\nglobalThis.__SP__ = { store, net, data, version: 1 };\n");
  w('js/ui/components.js', [
    "export const html = htm.bind(hFresh);",
    "export function MicroLabel(p) { return null; }",
    "export function Button(p) { return null; }",
    "export function Modal({ open }) { return html`<div class=\"modal\" role=\"presentation\"></div>`; }",
    "export const confirmDialog = (o) => o;",
    "export function closeAllDialogs() {}",
  ].join('\n'));
  w('js/ui/toasts.js', "export function toast(text) {}\n");
  w('js/store.js', [
    "export const emptyMatch = () => ({});",
    "export const store = createStore(initialState);",
    "export function selectRoute(s) { return 'title'; }",
  ].join('\n'));
  w('js/ui/gameComponents.js', "export const GAME_FILES = ['config', 'assets'];\n");
  w('js/screens/title.js', "export const T = html`<div class=\"screen title-screen\"><main class=\"title-main\"><h1 class=\"title-cn\"></h1><div class=\"title-login\"></div></main></div>`;\n");
  w('js/screens/room.js', "export const R = html`<div class=\"invite\"><div class=\"invite__code\"></div><div class=\"invite__btns\"></div></div>`;\n");
  for (const [f, v] of [['en', 'Copy Key'], ['ja', '\u30b3\u30fc\u30c9\u3092\u30b3\u30d4\u30fc'], ['ko', '\ucf54\ub4dc \ubcf5\uc0ac'], ['zh-TW', '\u8907\u88fd\u91d1\u9470']]) {
    w(`i18n/${f}.json`, JSON.stringify({ '\u590d\u5236\u5bc6\u94a5': v }, null, 0));
  }
  w('server/index.js', [
    "export async function startServer(opts = {}) {",
    "  const server = {}; const wss = {}; const lobby = {}; const network = {}; const registry = {}; const packs = {};",
    "  async function close() {}",
    "  return { port: 1, host, url, server, wss, lobby, network, registry, packs, close };",
    "}",
  ].join('\n'));
  w('server/lobby.js', [
    "export class Lobby {",
    "  constructor() { this.rooms = new Map(); }",
    "  getRoom(code) { return this.rooms.get(code); }",
    "  broadcastState() {}",
    "  freeSeat() {}",
    "  activeHumans() {}",
    "}",
  ].join('\n'));
  w('tools/vendor.mjs', "export const VENDOR = [['node_modules/preact/hooks/dist/hooks.module.js', 'hooks.module.js']];\n");
  return root;
}

const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

test('a complete upstream tree passes every contract', async () => {
  const root = mkTree();
  try {
    const res = await checkContract(root);
    assert.equal(res.ok, true, JSON.stringify(res.failures, null, 2));
    assert.deepEqual(res.failures, []);
  } finally { rm(root); }
});

test('a dropped module export fails and names the shell file that breaks', async () => {
  const root = mkTree();
  try {
    // Modal is what the four shell panels render their frame with.
    fs.writeFileSync(path.join(root, 'js/ui/components.js'), "export const html = () => {};\n");
    const res = await checkContract(root);
    assert.equal(res.ok, false);
    const f = res.failures.find((x) => x.id === 'export:js/ui/components.js');
    assert.ok(f, 'components.js export check must fail');
    assert.match(f.detail, /Modal/);
    assert.ok(f.breaks.some((b) => b.endsWith('ui/shellPanels.js')), 'must name shellPanels.js');
  } finally { rm(root); }
});

test('a dropped DOM anchor fails with its consequence', async () => {
  const root = mkTree();
  try {
    // upstream reworks the title screen: the four anchors are gone
    fs.writeFileSync(path.join(root, 'js/screens/title.js'), "export const T = 1;\n");
    const res = await checkContract(root);
    assert.equal(res.ok, false);
    for (const id of ['dom:title-screen', 'dom:title-main', 'dom:title-cn', 'dom:title-login']) {
      assert.ok(res.failures.some((x) => x.id === id), `${id} must fail`);
    }
    const f = res.failures.find((x) => x.id === 'dom:title-screen');
    assert.ok(f.breaks.some((b) => b.endsWith('home-layer.js')));
    assert.match(f.why, /R-01/);
  } finally { rm(root); }
});

test('a changed startServer() return shape fails (the .close key included)', async () => {
  const root = mkTree();
  try {
    // drop `.close` and `.lobby` — the overlays resolve the http server and lobby through these
    fs.writeFileSync(path.join(root, 'server/index.js'),
      "export async function startServer() { return { port: 1, host, url, server, wss, network, registry, packs }; }\n");
    const res = await checkContract(root);
    const f = res.failures.find((x) => x.id === 'server:startServer');
    assert.ok(f, 'startServer shape must fail');
    assert.match(f.detail, /close/);
    assert.match(f.detail, /lobby/);
    assert.ok(f.breaks.some((b) => b.includes('sp-lobby.mjs')));
  } finally { rm(root); }
});

test('a Lobby member rename fails (rooms/getRoom/freeSeat/activeHumans)', async () => {
  const root = mkTree();
  try {
    fs.writeFileSync(path.join(root, 'server/lobby.js'), "export class Lobby { constructor() { this.roomMap = new Map(); } }\n");
    const res = await checkContract(root);
    const f = res.failures.find((x) => x.id === 'server:lobby');
    assert.ok(f);
    assert.match(f.detail, /getRoom/);
    assert.match(f.detail, /broadcastState/);
  } finally { rm(root); }
});

test('an i18n label the room hook does not know fails (R-02)', async () => {
  const root = mkTree();
  try {
    fs.writeFileSync(path.join(root, 'i18n/fr.json'), JSON.stringify({ '\u590d\u5236\u5bc6\u94a5': 'Copier la cl\u00e9' }));
    const res = await checkContract(root);
    const f = res.failures.find((x) => x.id === 'i18n:room-label');
    assert.ok(f, 'an unknown translation must fail the gate');
    assert.match(f.detail, /fr\.json/);
    assert.ok(f.breaks.some((b) => b.endsWith('room-hook.js')));
  } finally { rm(root); }
});

test('the known label set covers all four upstream i18n files', () => {
  assert.deepEqual(ROOM_LABELS, [
    '\u590d\u5236\u5bc6\u94a5', 'Copy Key', '\ucf54\ub4dc \ubcf5\uc0ac',
    '\u30b3\u30fc\u30c9\u3092\u30b3\u30d4\u30fc', '\u8907\u88fd\u91d1\u9470',
  ]);
});

test('a drifted copy icon path is a NOTE (the text fallback still matches), never a failure', async () => {
  const root = mkTree();
  const compPath = path.join(root, 'js/ui/components.js');
  try {
    fs.appendFileSync(compPath, "\nexport const ICONS = { copy: { d: 'M0 0h1v1H0z', eo: true } };\n");
    const res = await checkContract(root);
    assert.equal(res.ok, true, 'an icon tweak must not fail the gate');
    assert.ok(res.notes.some((n) => /copy icon path drifted/.test(n)), 'the drift must be visible');
    assert.ok(res.notes.some((n) => n.includes(COPY_ICON_D)), 'the note names the expected path');
    // the real upstream path produces no note
    fs.writeFileSync(compPath, fs.readFileSync(compPath, 'utf8').replace('M0 0h1v1H0z', COPY_ICON_D));
    const res2 = await checkContract(root);
    assert.equal(res2.ok, true);
    assert.ok(!res2.notes.some((n) => /copy icon path drifted/.test(n)));
  } finally { rm(root); }
});

test('room-hook.js hard-codes the same copy icon path the contract checker expects', () => {
  const src = fs.readFileSync(path.join(repo, 'tools/apk/extras/public/js/room-hook.js'), 'utf8');
  assert.ok(src.includes(COPY_ICON_D), 'room-hook.js COPY_ICON_D must match the checker constant');
});

test('vendor/hooks.module.js is accepted either built or generated by tools/vendor.mjs', async () => {
  const root = mkTree();
  try {
    // (a) generator present, no built file → ok (a source zip has no public/vendor/)
    let res = await checkContract(root);
    assert.equal(res.ok, true);
    assert.ok(res.notes.some((n) => /vendor\/hooks\.module\.js absent/.test(n)));
    // (b) built file present and exporting the hooks → ok
    fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(root, 'vendor/hooks.module.js'), "export{q as useCallback,h as useEffect,d as useState};\n");
    res = await checkContract(root);
    assert.equal(res.ok, true, JSON.stringify(res.failures));
    // (c) built file present but without the hooks → fail
    fs.writeFileSync(path.join(root, 'vendor/hooks.module.js'), "export{q as useCallback};\n");
    res = await checkContract(root);
    assert.equal(res.ok, false);
    assert.ok(res.failures.some((x) => x.id === 'export:vendor/hooks.module.js'));
    // (d) neither built nor generated → fail
    fs.rmSync(path.join(root, 'vendor/hooks.module.js'));
    fs.writeFileSync(path.join(root, 'tools/vendor.mjs'), "export const VENDOR = [];\n");
    res = await checkContract(root);
    assert.equal(res.ok, false);
    assert.ok(res.failures.some((x) => x.id === 'export:vendor/hooks.module.js'));
  } finally { rm(root); }
});

test('a path that is not an upstream tree is rejected, never silently passed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'not-upstream-'));
  try {
    const res = await checkContract(root);
    assert.equal(res.ok, false);
    assert.equal(res.failures[0].id, 'tree');
  } finally { rm(root); }
});

test('CLI: exit 0 on a good tree, exit 1 with a named list on a broken tree', () => {
  const good = mkTree();
  const bad = mkTree();
  try {
    fs.writeFileSync(path.join(bad, 'js/ui/toasts.js'), 'export const nothing = 1;\n');
    const okRun = spawnSync(process.execPath, [CLI, good], { encoding: 'utf-8' });
    assert.equal(okRun.status, 0, okRun.stderr);
    assert.match(okRun.stdout, /all checks passed/);
    const badRun = spawnSync(process.execPath, [CLI, bad], { encoding: 'utf-8' });
    assert.equal(badRun.status, 1);
    assert.match(badRun.stderr, /CONTRACT FAIL: export:js\/ui\/toasts\.js/);
    assert.match(badRun.stderr, /shellPanels\.js/);
  } finally { rm(good); rm(bad); }
});

test('CLI: --runtime boots the real upstream server when node_modules are present', async (t) => {
  const tree = fs.existsSync(path.join(DEFAULT_TREE, 'server', 'index.js')) ? DEFAULT_TREE : null;
  if (!tree || !fs.existsSync(path.join(tree, 'node_modules'))) {
    return t.skip('local upstream extraction (with node_modules) not present');
  }
  const res = spawnSync(process.execPath, [CLI, tree, '--runtime'], { encoding: 'utf-8', timeout: 60000 });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /runtime startServer\(\): shape ok/);
});

test('the real repo tree (an upstream 0.2.1 fork) passes the contract', async () => {
  assert.ok(fs.existsSync(path.join(repo, 'public', 'index.html')), 'repo must carry the upstream tree');
  const res = await checkContract(repo);
  assert.equal(res.ok, true, JSON.stringify(res.failures, null, 2));
});

test('the local upstream extraction cache passes the contract when present', async (t) => {
  if (!fs.existsSync(path.join(DEFAULT_TREE, 'server', 'index.js'))) {
    return t.skip(`no extraction at ${DEFAULT_TREE}`);
  }
  const res = await checkContract(DEFAULT_TREE);
  assert.equal(res.ok, true, JSON.stringify(res.failures, null, 2));
});
