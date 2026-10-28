// mods-archived.test.mjs — the legacy mod chain must stay retired (2026-10-27 业主「全做」)。
//
// WHY: the old chain (overlay/sp-mods.mjs + ui/modsLoader.js + ui/modPanels.js + the archived
// ui/modsPanel.js) was a SECOND mod system beside /mod: a different source (47.103.14.217), a
// different install root (<files>/workshop vs <webroot>/plugins), seven un-keyed write routes, and
// ~92 KB shipped for zero callers. The device was verified empty (`/sp/mods/loader` → packs:[]) and
// the whole chain was retired. These guards pin the retirement so nothing quietly revives it:
//   · shell-bridge must not inject any of the three client files again;
//   · the overlay directory must not carry sp-mods.mjs again;
//   · the surviving manager surface stays /mod (sp-modmgr).
// Reviving the chain requires an explicit owner decision + this file's deletion — not a drive-by edit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const BRIDGE_SOURCES = [
  path.join(repo, 'tools', 'apk', 'extras', 'public', 'js', 'shell-bridge.js'),
  path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'shell', 'extras', 'public', 'js', 'shell-bridge.js'),
];
const OVERLAY_DIR = path.join(repo, 'tools', 'apk', 'overlay');

test('shell-bridge (both copies) no longer references the retired mod chain', () => {
  for (const p of BRIDGE_SOURCES) {
    // 只查**代码**：文件里的历史注释（「旧链已退役」的说明）合法地提到这些名字。
    const code = fs.readFileSync(p, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const gone of ['modsLoader.js', 'modPanels.js', 'modsPanel.js', '__SP_MODS_LOADER_READY', '__SP_MOD_PANELS_READY']) {
      assert.ok(!code.includes(gone), `${path.relative(repo, p)} still references the retired chain in CODE: ${gone}`);
    }
  }
});

test('the overlay directory carries no sp-mods module', () => {
  const files = fs.readdirSync(OVERLAY_DIR).filter((n) => n.endsWith('.mjs'));
  assert.ok(!files.includes('sp-mods.mjs'), 'sp-mods.mjs must stay retired');
  assert.ok(files.includes('sp-modmgr.mjs'), 'the surviving manager surface must stay /mod (sp-modmgr)');
});

test('the retired client files are gone from extras (source and shipped mirror)', () => {
  const gone = [
    'tools/apk/extras/public/js/ui/modsLoader.js',
    'tools/apk/extras/public/js/ui/modPanels.js',
    'tools/apk/extras/public/js/ui/modsPanel.js',
    'android/app/src/main/assets/shell/extras/public/js/ui/modsLoader.js',
    'android/app/src/main/assets/shell/extras/public/js/ui/modPanels.js',
    'android/app/src/main/assets/shell/extras/public/js/ui/modsPanel.js',
  ];
  for (const rel of gone) {
    assert.equal(fs.existsSync(path.join(repo, rel)), false, rel + ' must stay deleted');
  }
});
