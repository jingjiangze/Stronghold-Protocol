// title-side-purge.test.mjs — 回潮门：首页右侧的旧侧栏按钮组（设置/参数/配置）彻底删除后不许复活。
//
// 背景（业主口径 2026-10-10）：「怎么还有这个页面，彻底删掉」—— 指标题屏右侧的旧侧栏按钮组
//   （`.title-side` / `.title-gear` / `.title-room` / `.title-room__btn` / `.title-room__cfg` /
//    `.title-room__hint`）。事实：JS 侧早已不再生成这组按钮（见 js/screens/title.js 的 R1），
//   但 tools/apk/extras/public/css/screens/title.css 里还留着这批**自加**的死 CSS；本任务已删净。
//
// 这个门守两件事：
//   1) extras 的 JS 里不得出现 `.title-side` / `.title-room` / `.title-gear` 的 **DOM 生成**；
//   2) 副本 title.css 里不得再出现这些**选择器**。
//
// 注释豁免的选择（二选一里选「豁免注释」）：副本文件头（js/screens/title.js、home-layer.js、
//   title.css）**有意**保留「加了又删」的沿革记录——那是业主口径的审计线索，要求连注释也不留会
//   抹掉这段历史。所以本门先剥掉注释再扫正文（与 home-layer.test.mjs 的 codeOnly 同一套做法），
//   正文（真实代码）里一旦复活立即变红。下面的 positive control 断言「原文的注释里确实提到过这些
//   名字」，确保豁免不是空转（否则删了 header 描述本门仍会误报通过）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXTRAS_PUBLIC = path.join(here, 'extras', 'public');
const VENDOR_CSS = path.join(EXTRAS_PUBLIC, 'css', 'screens', 'title.css');
const VENDOR_JS = path.join(EXTRAS_PUBLIC, 'js', 'screens', 'title.js');

/** 这组名字：DOM 生成与选择器都不许再出现。 */
const TOKENS = ['title-side', 'title-room', 'title-gear'];

const read = (p) => fs.readFileSync(p, 'utf8');

/** 剥掉 JS 注释（块注释 + 行注释），只留正文。 */
function stripJsComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
/** 剥掉 CSS 注释（块注释），只留正文。 */
function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** extras/public/js 下的全部 .js（递归）。 */
function jsFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) out.push(...jsFiles(p));
    else if (name.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('extras 的 JS 里没有侧栏按钮组的 DOM 生成（注释豁免）', () => {
  const dir = path.join(EXTRAS_PUBLIC, 'js');
  const files = jsFiles(dir);
  assert.ok(files.length > 0, 'extras/public/js 下没扫到任何 .js —— 路径变了？');
  for (const file of files) {
    const code = stripJsComments(read(file));
    for (const token of TOKENS) {
      assert.equal(
        code.includes(token), false,
        `${path.relative(here, file)} 的正文里出现了 ${JSON.stringify(token)}：`
        + ' 旧侧栏按钮组不许在 JS 里复活（只允许出现在注释的沿革记录里）',
      );
    }
  }
});

test('title.css 里没有侧栏按钮组的选择器（注释豁免）', () => {
  const code = stripCssComments(read(VENDOR_CSS));
  for (const token of TOKENS) {
    assert.equal(
      code.includes('.' + token), false,
      `title.css 正文里仍有 .${token} 选择器 —— 死 CSS 必须删净`,
    );
  }
});

test('positive control：原文注释里确实提到过这些名字（豁免不是空转）', () => {
  // 若有人把文件头的沿革记录也删了，本门的「剥注释」就失去意义；这里钉住「注释里有」这一前提。
  assert.ok(read(VENDOR_CSS).includes('.title-side'), 'title.css 文件头应保留删除沿革（提到 .title-side）');
  assert.ok(read(VENDOR_JS).includes('title-side'), 'js/screens/title.js 文件头应保留 R1 沿革（提到 .title-side）');
});

test('title.css 文件头记录了这次删除（可追溯 + 指向本门）', () => {
  const css = read(VENDOR_CSS);
  assert.ok(css.includes('2026-10-10'), 'title.css 文件头必须记录 2026-10-10 的删除口径');
  assert.ok(css.includes('title-side-purge.test.mjs'), 'title.css 文件头必须指向本回潮门');
  assert.ok(css.includes('业主口径删除'), 'title.css 文件头必须有「业主口径删除」一节');
});
