// test/names.test.js — 名字策略（shared/names.js）的唯一真源 + 判定矩阵 + 多线程就绪性。
//
// 为什么单独一套：这份策略是**客户端与服务器共用**的（public/js 与 server/ 都 import 它），
// 将来服务器做多线程/多进程时每个实例读同一份文件、跑同一个纯函数 —— 这里把这些性质钉住：
//   * 单一真源：v5.7 补丁必须让服务器与客户端都 import 这一份实现（且不再自带第二份）；
//   * 发布形态：extras 里的副本必须与真源**逐字节一致**（新文件只有 extras 这条路能进 webroot）；
//   * 纯函数：无缓存/无 I/O —— 判定只取决于输入（换调用顺序结果不变）；
//   * 词表是数据：词表模块只导出冻结数组，引擎里不含任何词。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizeName, moderateName, isValidName, nameVariants, NAME_REJECT_TEXT } from '../shared/names.js';
import { BLOCKED_EN, BLOCKED_ZH } from '../shared/names-words.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LF = String.fromCharCode(10);
const patch = () => JSON.parse(readFileSync(path.join(ROOT, 'tools/apk/patches/settings-v5.7.json'), 'utf8'));
const hunksFor = (file) => patch().patches.filter((h) => h.file === file);
const textOf = (hs, key) => hs.map((h) => h[key]).join(LF);

test('names: sanitize 语义（控制/隐形字符、落单代理项、空白、按码点截断）', () => {
  assert.equal(sanitizeName('  凯尔希  '), '凯尔希');
  assert.equal(sanitizeName('a\u0000b\u200bc\u202ed'), 'abcd');   // 控制 + 零宽 + bidi
  assert.equal(sanitizeName('a   b'), 'a b');
  assert.equal(sanitizeName('x'.repeat(30)).length, 12);
  // 码点口径：12 个 emoji 是 12 个字符（旧客户端按 UTF-16 截断会只剩 6 个）
  const emoji = '😀'.repeat(12);
  assert.equal(sanitizeName(emoji), emoji);
  assert.equal(sanitizeName('😀'.repeat(20)), '😀'.repeat(12));
  assert.equal(sanitizeName(null), '');
  assert.equal(sanitizeName(42), '');
  assert.equal(sanitizeName('\u200b\u200b'), '');
});

test('names: 词表命中（含审计点名的绕过手法）', () => {
  const blocked = [
    'fuck', 'asshole', 'ass',
    'аsshole',        // 西里尔 а（同形字）
    'ＦｕＣｋ',        // 全角（NFKC）
    'f.u.c.k',        // 分隔符夹字母
    'cl ass',         // 空格隔开
    'f4ck',           // leet + 去数字
    'fu1ck',          // 词表变体
    'fͯuck',           // 组合记号（F 漏了 \p{M}）
    '傻逼', '笨蛋', '死全家',
  ];
  for (const raw of blocked) {
    const r = moderateName(raw);
    assert.equal(r.ok, false, `${raw} 应被拦下`);
    assert.equal(r.reason, 'blocked', `${raw} 的原因是 blocked`);
  }
});

test('names: 不误伤（词边界生效）', () => {
  const allowed = ['grass', 'class', 'bass', 'pass', 'assassin', 'badassery', '正常名字', '小明', 'Ace', 'Nova', 'Doctor', 'Kelsey'];
  for (const raw of allowed) {
    const r = moderateName(raw);
    assert.equal(r.ok, true, `${raw} 不该被拦下（原因 ${r.reason || '-'}）`);
    assert.equal(r.name, sanitizeName(raw), 'ok 时返回清洗后的展示名');
  }
  assert.equal(isValidName('   '), false);
  assert.equal(isValidName('Doctor'), true);
  assert.equal(NAME_REJECT_TEXT.blocked.length > 0, true);
});

test('names: 单一真源 —— 补丁把服务器与客户端都指向同一实现，且 extras 副本与真源逐字节一致', () => {
  // 服务器：删掉本地 sanitizeName、import shared/names.js、hello 走 moderateName、被拦回 NAME_REJECTED
  const net = hunksFor('server/net.js');
  const netFind = textOf(net, 'find');
  const netRepl = textOf(net, 'replace');
  assert.match(netFind, /export function sanitizeName/, '本地那份实现必须被替换掉');
  assert.match(netRepl, /import \{ sanitizeName, moderateName \} from '\.\.\/shared\/names\.js'/);
  assert.match(netRepl, /moderateName\(msg\.name\)/, 'hello 要走审核');
  assert.match(netRepl, /ERR\.NAME_REJECTED/, '被拦要回 NAME_REJECTED');
  // 错误码与中文文案也走补丁（shared/constants.js）
  const con = hunksFor('shared/constants.js');
  assert.match(textOf(con, 'replace'), /NAME_REJECTED: 'NAME_REJECTED'/);
  assert.match(textOf(con, 'replace'), /昵称含违规词/);
  // 客户端：import 同一份实现，且替换文本里不得再出现第二份实现
  const title = hunksFor('js/screens/title.js');
  const titleRepl = textOf(title, 'replace');
  assert.match(titleRepl, /from '\.\.\/\.\.\/\.\.\/shared\/names\.js'/, '客户端要 import 共享实现');
  assert.match(titleRepl, /moderateName\(rawName\)/, '客户端进会话前也要审核');
  assert.ok(!/export function sanitizeName/.test(titleRepl), '替换文本不得再定义第二份实现');
  // 发布形态：extras 副本（进 webroot 的那份）必须与真源逐字节一致
  for (const name of ['names.js', 'names-words.js']) {
    const a = readFileSync(path.join(ROOT, 'shared', name));
    const b = readFileSync(path.join(ROOT, 'tools/apk/extras/public/shared', name));
    assert.ok(a.equals(b), `shared/${name} 与 extras 副本不一致（跑 node tools/apk/sync-names.mjs）`);
  }
});

test('names: 多线程就绪 —— 纯函数、无状态、词表是数据', () => {
  // 判定只取决于输入：换顺序/重复调用结果一致（没有跨调用的缓存或计数器）
  const seq1 = ['fuck', 'Doctor', 'аsshole', '小明', 'f4ck'].map((n) => JSON.stringify(moderateName(n)));
  const seq2 = ['小明', 'f4ck', 'fuck', 'Doctor', 'аsshole'].map((n) => JSON.stringify(moderateName(n)));
  assert.deepEqual(seq1.slice().sort(), seq2.slice().sort(), '判定与调用顺序无关');
  assert.equal(JSON.stringify(moderateName('Doctor')), seq1[1], '重复调用结果一致');
  // 输入不被改动
  const raw = '  ＦｕＣｋ  ';
  moderateName(raw);
  assert.equal(raw, '  ＦｕＣｋ  ');
  // 变体函数也是纯的
  assert.deepEqual(nameVariants('f.u.c.k'), nameVariants('f.u.c.k'));
  // 词表是冻结数据（引擎不含词）
  assert.ok(Object.isFrozen(BLOCKED_EN) && Object.isFrozen(BLOCKED_ZH));
  assert.ok(BLOCKED_EN.length > 100 && BLOCKED_ZH.length > 10);
  assert.ok(BLOCKED_EN.every((w) => typeof w === 'string' && w.trim() === w));
});
