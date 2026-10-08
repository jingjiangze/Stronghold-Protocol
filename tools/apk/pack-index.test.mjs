// 首页语言选项与服务器页对齐的静态钉死（业主 2026-10-08：「进入服务器后右上角上游的语言选项'变了'」）。
//
// 根因：上游标题屏的语言菜单由 /packs/index.json 决定形态（public/js/ui/lang.js langMenuModel：
// ≤ SEGMENTED_MAX 种语言 = 一排按钮，更多 = 一个 <select> 列表）。APK 的 webroot 装配只搬
// public/data/shared/server（build-webroot.mjs），**从不搬 packs/**，所以设备首页上
// loadLangIndex() 404 → 菜单只剩内置中文（实测：DIV + 单个「中文」按钮 68.7x33.7px）；
// 服务器页由服务器实时列出 5 种语言 → LABEL.title-lang.lang-select + <select>（135.3x27px）。
// 修复：让 extras 链把上游那张 index.json 铺到 webroot 根（extras/public/** 同名覆盖），
// 首页与服务器页就渲染同一个控件、同一份语言列表。本测试钉死：
//   1) 文件在 extras/public/packs/index.json（extras 链 → webroot 根的 packs/index.json）
//   2) 内容 = 本 checkout 现算的 index（逐字节）—— 上游新增/改动语言包时这里会红，提示刷新副本
//   3) 覆盖 public/i18n/ 的全部语言（首页菜单不许再漏语言）
//   4) 语言数 > lang.js 的 SEGMENTED_MAX，所以首页必然渲染成上游的列表形态（与服务器页一致）
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
const EXTRA_INDEX = path.join(here, 'extras', 'public', 'packs', 'index.json');

const read = (p) => fs.readFileSync(p, 'utf8');

/** 语言包：public/i18n/<code>.json（docs/PACKS.md；zh 是内置默认语言，不在文件夹里）。 */
function i18nLangs() {
  return fs.readdirSync(path.join(repo, 'public', 'i18n'))
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .sort();
}

test('extras 带上 packs/index.json，且铺到 webroot 根（extras 链 = 同名覆盖）', () => {
  assert.ok(fs.existsSync(EXTRA_INDEX), '缺少 extras/public/packs/index.json —— 首页又会退回「只有中文」的菜单');
  // build-webroot.copyExtras 把 extras/public/** 原样铺到 webroot 根：相对路径就是我们想要的 URL
  const src = read(path.join(here, 'build-webroot.mjs'));
  assert.match(src, /from:\s*path\.join\(extrasDir, 'public'\),\s*to:\s*outDir/,
    'copyExtras 不再把 extras/public 铺到 webroot 根 —— 这个文件就落不到 /packs/index.json');
});

test('extras 的 index 与本 checkout 现算的 index 逐字节一致（上游改语言包 → 这里大声失败）', () => {
  const { packs } = scanPacks(packDirs(repo));
  const expected = `${JSON.stringify(packIndexOf(packs), null, 2)}\n`;
  assert.equal(read(EXTRA_INDEX), expected,
    'extras/public/packs/index.json 与 tools/packs.mjs 现算结果不一致：重跑 `node tools/packs.mjs index --out tools/apk/extras/public/packs/index.json` 并提交');
});

test('index 覆盖 public/i18n 的每种语言（首页菜单与服务器页列同一份语言）', () => {
  const doc = JSON.parse(read(EXTRA_INDEX));
  assert.equal(doc.app, APP_VERSION, 'app 字段要跟 shared/constants.js 的版本一致');
  const ids = (doc.packs || []).filter((p) => p.type === 'lang').map((p) => p.id).sort();
  assert.deepEqual(ids, i18nLangs(), 'index 的语言集合 = public/i18n/*.json');
  for (const p of doc.packs || []) {
    if (p.type !== 'lang') continue;
    assert.ok(p.files && p.files.ui && p.files.ui.startsWith('/i18n/'), `${p.id}: files.ui 必须是本地树路径`);
  }
  // 设备首页 = 本地树：不吃 CDN 前缀（本地/APK 命中），所以这里只允许根相对路径
  assert.ok(!/https?:\/\//.test(read(EXTRA_INDEX)), 'index 里不许出现网络 URL');
});

test('语言数 > SEGMENTED_MAX ⇒ 首页与服务器页都渲染上游的 <select> 形态（不再一个中文按钮）', () => {
  const doc = JSON.parse(read(EXTRA_INDEX));
  const n = (doc.packs || []).filter((p) => p.type === 'lang').length;
  const lang = read(path.join(repo, 'public', 'js', 'ui', 'lang.js'));
  const max = Number((lang.match(/export const SEGMENTED_MAX = (\d+)/) || [])[1]);
  assert.ok(Number.isInteger(max) && max > 0, 'lang.js 里的 SEGMENTED_MAX 必须能读到');
  assert.ok(n + 1 > max, `语言数（${n} 包 + 内置中文）必须 > SEGMENTED_MAX=${max}，否则首页会变成按钮形态、与服务器页不一致`);
});
