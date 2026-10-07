// shared/names.js — 昵称的**唯一策略源**（客户端 public/js 与服务器 server/ 都 import 这一个模块）。
//
// 多线程 / 多进程就绪（用户 2026-10-07：以后会做成多线程的）：
//   * 纯函数 + 模块级**只读**数据（编译出的正则/集合在模块加载时按同一份词表确定性构建），
//     没有缓存、没有 I/O、不用 Date/random —— 任何 worker 线程 / 进程 / 浏览器上下文得到**完全一致**的判定；
//   * 词表是数据（shared/names-words.js），引擎不含词 —— 换词表不动逻辑，也不需要各线程同步状态；
//   * 长度口径只有一份：按**码点**截断（旧客户端按 UTF-16 截断，12 个 emoji 的名字两端会得到不同结果）。
//
// 两道闸：sanitizeName（展示用清洗，服务器 hello 一直用的就是这套语义）与 moderateName（清洗 + 审核）。
// 审核是**过滤器**不是保证：词表覆盖不到的变体要靠 names-words.js 补条目（引擎不做模糊匹配，避免误伤）。
//
// 发布形态：本文件是**真源**；`tools/apk/sync-names.mjs` 会把它与 names-words.js 原样复制到
// `tools/apk/extras/public/shared/`（extras/public/* 镜像 webroot 根 —— 新文件只有这条路能进 webroot），
// `test/names.test.js` 断言两份逐字节一致，防止只改一边。

import { NAME_MAX_LEN } from './constants.js';
import { BLOCKED_EN, BLOCKED_ZH } from './names-words.js';

/** 控制字符 / 隐形字符 / BOM（与旧 server/net.js sanitizeName 的字符类一致）。 */
const CONTROL_INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
/** 组合记号（\p{M}）：F 的审核漏了这一类（"fͯuck" 能过），这里先剥掉再匹配。 */
const COMBINING = /\p{M}+/gu;
/** 单个字母之间夹的分隔符（f.u.c.k / f-u-c-k / f_u_c_k）—— 只在这些符号之间连写，**不动空格**。 */
const INNER_SEPARATOR = /(?<=[a-z])[._\-*·•+=~^]+(?=[a-z])/g;
/** 单字母被空格隔开（f u c k）—— 检查用变体里连起来。 */
const SPACED_LETTERS = /(?<=^|\s)(?:[a-z]\s)+[a-z](?=\s|$)/g;

/** 同形字（西里尔 / 希腊 / 其它常见）→ 拉丁：挡住「аsshole」这类混写绕过。 */
const CONFUSABLES = new Map(Object.entries({
  'а': 'a', 'б': 'b', 'в': 'b', 'г': 'r', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'x', 'з': '3', 'и': 'u',
  'й': 'u', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'h', 'о': 'o', 'п': 'n', 'р': 'p', 'с': 'c', 'т': 't',
  'у': 'y', 'ф': 'f', 'х': 'x', 'ц': 'c', 'ч': '4', 'ш': 'w', 'щ': 'w', 'ъ': 'b', 'ы': 'b', 'ь': 'b',
  'э': 'e', 'ю': 'o', 'я': 'r', 'і': 'i', 'ї': 'i', 'є': 'e', 'ґ': 'g', 'ј': 'j', 'ѕ': 's', 'ѵ': 'v',
  'α': 'a', 'β': 'b', 'γ': 'y', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'n', 'θ': 'o', 'ι': 'i', 'κ': 'k',
  'λ': 'l', 'μ': 'u', 'ν': 'v', 'ξ': 'x', 'ο': 'o', 'π': 'n', 'ρ': 'p', 'σ': 'o', 'ς': 's', 'τ': 't',
  'υ': 'u', 'φ': 'f', 'χ': 'x', 'ψ': 'y', 'ω': 'w', 'ɑ': 'a', 'ɡ': 'g', 'ⅰ': 'i', 'ⅼ': 'l', 'ł': 'l',
  'ø': 'o', 'đ': 'd', 'ç': 'c', 'ñ': 'n',
}));

/** 数字 / 符号的常见字母替写（leet）。 */
const LEET = new Map(Object.entries({
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'l', '+': 't', '€': 'e', '£': 'l', '¥': 'y', '§': 's',
}));

/** 逐字符扫描去掉落单代理项（Safari < 16.4 不支持这种 lookbehind 正则，会整页报错）。 */
function stripLoneSurrogates(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { out += str[i] + str[i + 1]; i++; }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += str[i];
  }
  return out;
}

/**
 * 展示用清洗（与服务器 hello 一直使用的语义一致）：NFC → 去落单代理项/控制/隐形字符 → 塌空白 →
 * 按**码点**截断到 NAME_MAX_LEN。没有可打印字符时返回 ''。
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw;
  try { s = s.normalize('NFC'); } catch { /* 保留原样 */ }
  s = stripLoneSurrogates(s).replace(CONTROL_INVISIBLE, '').replace(/\s+/g, ' ').replace(/ {2,}/g, ' ').trim();
  s = [...s].slice(0, NAME_MAX_LEN).join('').trim();   // 码点口径：emoji 算 1
  return s;
}

/**
 * 审核用的归一化变体（**不用于展示**）。三种形式各自保留词边界，供词表匹配：
 *   rawish    同形字已映射、数字保留   —— 词表里带数字的条目（fu1ck）
 *   leet      数字/符号 → 字母         —— 常见替写（f4ck → fack …）
 *   digitless 去掉数字                 —— f4ck → fck（配合短词条目）
 * @param {string} text 已清洗过的名字
 * @returns {{ rawish: string, leet: string, digitless: string }}
 */
export function nameVariants(text) {
  let s = String(text ?? '');
  try { s = s.normalize('NFKC'); } catch { /* 保留原样 */ }   // 全角 ＦｕＣｋ → FuCk
  s = stripLoneSurrogates(s).toLowerCase().replace(CONTROL_INVISIBLE, '').replace(COMBINING, '');
  let mapped = '';
  for (const ch of s) mapped += CONFUSABLES.get(ch) ?? ch;
  const rawish = mapped.replace(INNER_SEPARATOR, '').replace(SPACED_LETTERS, (m) => m.replace(/\s+/g, ''));
  let leet = '';
  for (const ch of rawish) leet += LEET.get(ch) ?? ch;
  // digitless 要从 rawish（未做 leet 映射）出发：f4ck → fck、fu1ck → fuck；
  // 若从 leet 出发，4 已经变成 a，就永远得不到 "fck" 这个变体。
  return { rawish, leet, digitless: rawish.replace(/[0-9]/g, '') };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 词表 → 编译产物（模块加载时**确定性**构建一次；不随请求变化，线程间各自构建同一份）。
 *   words：单条目（无空格）→ 词边界正则；phrases：多词条目 → 空格归一后的边界正则；cjk：子串集合。
 */
function compile(list) {
  const words = [];
  const phrases = [];
  for (const raw of list) {
    const w = String(raw || '').trim().toLowerCase();
    if (!w) continue;
    if (/\s/.test(w)) phrases.push(w.replace(/\s+/g, ' '));
    else words.push(w);
  }
  // 注意：交替式必须整体包进非捕获组 —— 否则 (?:^|…)w1|w2|…|wN(?:…|$) 只有首尾两个词受边界约束，
  // 中间的全部退化成子串匹配（"ass" 会命中 "grass"）。
  const boundary = (body) => new RegExp('(?:^|[^a-z0-9])(?:' + body + ')(?:[^a-z0-9]|$)', 'i');
  return {
    words: boundary(words.map(escapeRe).join('|')),
    phrases: phrases.length
      ? boundary(phrases.map((p) => escapeRe(p).replace(/\\ /g, '\\s+')).join('|'))
      : null,
  };
}

/** 编译产物：英文按词边界，中文按子串（中文没有词边界可依）。 */
const EN = compile(BLOCKED_EN);
const ZH = Object.freeze(BLOCKED_ZH.map((w) => String(w).trim()).filter(Boolean));

/** 审核不通过的原因 → 给用户看的中文（客户端内联提示用；服务器侧另走 ERR_TEXT.NAME_REJECTED）。 */
export const NAME_REJECT_TEXT = Object.freeze({
  empty: '昵称不能为空（或只含不可见字符）',
  blocked: '昵称含违规词，换一个吧',
});

/**
 * 审核一个昵称：清洗 + 词表匹配。
 * @param {unknown} raw
 * @returns {{ ok: true, name: string } | { ok: false, reason: 'empty' | 'blocked' }}
 */
export function moderateName(raw) {
  const name = sanitizeName(raw);
  if (!name) return { ok: false, reason: 'empty' };
  const v = nameVariants(name);
  for (const form of [v.rawish, v.leet, v.digitless]) {
    if (EN.words.test(form)) return { ok: false, reason: 'blocked' };
    if (EN.phrases && EN.phrases.test(form.replace(INNER_SEPARATOR, ' '))) return { ok: false, reason: 'blocked' };
  }
  for (const w of ZH) if (v.rawish.includes(w) || v.leet.includes(w)) return { ok: false, reason: 'blocked' };
  return { ok: true, name };
}

/** 便捷判定（客户端按钮置灰用）。 @param {unknown} raw @returns {boolean} */
export const isValidName = (raw) => moderateName(raw).ok;
