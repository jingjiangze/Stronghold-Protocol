// 首页语言选项与服务器页对齐的静态钉死（业主 2026-10-08：「进入服务器后右上角上游的语言选项'变了'」）。
//
// 根因（0.2.6 时）：上游标题屏的语言菜单由 /packs/index.json 决定形态（public/js/ui/lang.js langMenuModel：
// ≤ SEGMENTED_MAX 种语言 = 一排按钮，更多 = 一个 <select> 列表）。APK 的 webroot 装配只搬
// public/data/shared/server（build-webroot.mjs），**从不搬 packs/**，所以设备首页上
// loadLangIndex() 404 → 菜单只剩内置中文（实测：DIV + 单个「中文」按钮 68.7x33.7px）；
// 服务器页由服务器实时列出 5 种语言 → LABEL.title-lang.lang-select + <select>（135.3x27px）。
//
// 修复演变（为什么现在不再铺静态副本）：上游 **0.3.0** 把 /packs/index.json 改成**服务器实时算**
// （server/packs.js + server/http/static.js 的 PACK_INDEX_FILE 路由，在静态兜底之前），本地树同样由
// 本机 Node 伺服，首页 loadLangIndex() 拿到的就是同一份实时索引 —— 0.2.6 时 extras 铺的那张静态
// packs/index.json 从此是**死代码**（服务器路由先命中，永轮不到它），2026-10-17 由
// check-extras-overlap 的 override-orphan 门抓到并删掉。
//
// 本测试钉死现在真正成立的三件事：
//   1) 实时索引（server/packs.js 现算）覆盖 public/i18n/ 的全部语言，且都是本地树路径 ——
//      首页菜单不许再漏语言（漏了就是回到「一个中文按钮」）；
//   2) app 字段与 shared/constants.js 一致；
//   3) 语言数 > lang.js 的 SEGMENTED_MAX，所以首页必然渲染成上游的列表形态（与服务器页一致）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPacks, packIndexOf } from '../../server/packs.js';
import { packDirs } from '../packs.mjs';
import { APP_VERSION } from '../../shared/constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const read = (p) => fs.readFileSync(p, 'utf8');

/** 语言包：public/i18n/<code>.json（docs/PACKS.md；zh 是内置默认语言，不在文件夹里）。 */
function i18nLangs() {
  return fs.readdirSync(path.join(repo, 'public', 'i18n'))
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .sort();
}

/** The live index body the server answers GET /packs/index.json with — the single source of truth. */
function liveIndex() {
  const { packs } = scanPacks(packDirs(repo));
  return packIndexOf(packs);
}

test('实时索引覆盖 public/i18n 的每种语言（首页菜单与服务器页列同一份语言）', () => {
  const doc = liveIndex();
  assert.equal(doc.app, APP_VERSION, 'app 字段要跟 shared/constants.js 的版本一致');
  const ids = (doc.packs || []).filter((p) => p.type === 'lang').map((p) => p.id).sort();
  assert.deepEqual(ids, i18nLangs(), 'index 的语言集合 = public/i18n/*.json');
  for (const p of doc.packs || []) {
    if (p.type !== 'lang') continue;
    assert.ok(p.files && p.files.ui && p.files.ui.startsWith('/i18n/'), `${p.id}: files.ui 必须是本地树路径`);
  }
  // 设备首页 = 本地树：不吃 CDN 前缀（本地/APK 命中），所以这里只允许根相对路径
  assert.ok(!/https?:\/\//.test(JSON.stringify(doc)), 'index 里不许出现网络 URL');
});

test('语言数 > SEGMENTED_MAX ⇒ 首页与服务器页都渲染上游的 <select> 形态（不再一个中文按钮）', () => {
  const doc = liveIndex();
  const n = (doc.packs || []).filter((p) => p.type === 'lang').length;
  const lang = read(path.join(repo, 'public', 'js', 'ui', 'lang.js'));
  const max = Number((lang.match(/export const SEGMENTED_MAX = (\d+)/) || [])[1]);
  assert.ok(Number.isInteger(max) && max > 0, 'lang.js 里的 SEGMENTED_MAX 必须能读到');
  assert.ok(n + 1 > max, `语言数（${n} 包 + 内置中文）必须 > SEGMENTED_MAX=${max}，否则首页会变成按钮形态、与服务器页不一致`);
});

test('extras 不再铺静态 packs/index.json（0.3.0 起它是服务器实时路由，静态副本是死代码）', () => {
  const dead = path.join(here, 'extras', 'public', 'packs', 'index.json');
  assert.ok(!fs.existsSync(dead),
    'extras/public/packs/index.json 又回来了 —— 0.3.0 的 server/http/static.js 在静态兜底之前就回答 '
    + '/packs/index.json（PACK_INDEX_FILE 路由），这张静态副本永远轮不到，删掉（check-extras-overlap 的 '
    + 'override-orphan 门也会因此红）');
});
