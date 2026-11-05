// training/key.mjs — 布阵学习库的「玩法 + 难度」键规则（纯函数，无 I/O）。
//
// 与服务器仓 server/lineupLibrary.js 的 libraryKey()/splitLibraryKey() 逐字同构：两侧必须用同一套命名，
// 否则本地内核按 key 去找库文件时会与服务器写出的文件对不上。
//
// 布局：<库目录>/lineups_<modeId>__<DIFFICULTY>.jsonl
//   · 双下划线分隔：modeId 自身含单下划线（mode_single_hard），单下划线分不开模式与难度；
//   · 难度统一大写（TRAINING / FUNNY / NORMAL / HARD / ABYSS，见 data/config.json 的 modes[*].difficulty）；
//   · 不同玩法互不影响，同一玩法下不同难度也互不影响 —— 每个库文件只装一种组合。

/**
 * 库键（文件主干）：`<modeId>__<DIFFICULTY>`。难度缺省时退化为 modeId（老的单文件/每模式布局）。
 * @param {string} [modeId] @param {string} [difficulty]
 * @returns {string}
 */
export function libraryKey(modeId, difficulty) {
  const mode = modeId || '';
  const diff = String(difficulty || '').trim().toUpperCase();
  return diff ? `${mode}__${diff}` : mode;
}

/**
 * 把库键拆回 { modeId, difficulty }；不是「mode__DIFF」形状时 difficulty 为 null（老布局）。
 * @param {string} key
 * @returns {{ modeId: string, difficulty: string | null }}
 */
export function splitLibraryKey(key) {
  const m = /^([A-Za-z0-9_]+?)__([A-Z][A-Z0-9_]*)$/.exec(String(key || ''));
  return m ? { modeId: m[1], difficulty: m[2] } : { modeId: String(key || ''), difficulty: null };
}

/** 库文件名（不含目录）。 @param {string} modeId @param {string} difficulty @returns {string} */
export function libraryFile(modeId, difficulty) {
  return `lineups_${libraryKey(modeId, difficulty)}.jsonl`;
}
