# training/ — 布阵学习库的键规则（玩法 + 难度分开）

本地内核不自己写学习库（写库在服务器仓的 `server/lineupLibrary.js`），但**读**库文件、按
模式/难度取候选时要与服务器同一套命名。这里只导出那条命名规则，避免两边各写一份字符串拼接。

## 布局

```
<库目录>/lineups_<modeId>__<DIFFICULTY>.jsonl
例：lineups_mode_single_hard__HARD.jsonl
    lineups_mode_single_hard__NORMAL.jsonl      ← 同一玩法、不同难度，两个文件
    lineups_mode_multi_hard__HARD.jsonl         ← 不同玩法，也是两个文件
```

- 分隔符是**双下划线**：`modeId` 自身含单下划线（`mode_single_hard`），单下划线分不开；
  难度是大写字母，两侧字符集（`[A-Za-z0-9_]`）里都不会自然出现 `__`，解析唯一。
- 难度取值与 `data/config.json` 的 `modes[*].difficulty` 一致：
  `TRAINING` / `FUNNY` / `NORMAL` / `HARD` / `ABYSS`。
- 每个文件只装一种「玩法 + 难度」组合：不同玩法互不影响，同玩法不同难度也互不影响。

## 一行记录（JSONL）

```json
{"t":"lineup","at":"2026-10-18T00:00:00Z","modeId":"mode_single_hard","stageId":"act1_m01",
 "difficulty":"HARD","round":3,"sig":"<cells 的规范签名>",
 "cells":[{"id":"char_a","golden":false,"row":9,"col":3,"dir":"UP"}]}
```

`sig` 是 `cells` 排序拼接后的签名，用于去重；`cells` 里的坐标是**玩家自己的棋盘坐标**（boss 只镜像
战场，不镜像棋盘），所以可以直接回放。

## 与服务器的对应关系

| 服务器侧 | 这里的对应 |
|---|---|
| `server/lineupLibrary.libraryKey(modeId, difficulty)` | `training/key.mjs` 的 `libraryKey()`（逐字同构） |
| 目录布局 `lineups_<modeId>__<DIFF>.jsonl` | 同左 |
| 上传键 `packs/lineup-library/<modeId>__<DIFF>-<YYYY-MM-DD>.jsonl` | 只读消费时按日期取最新一份（CDN 侧另维护稳定别名） |
| 老布局 `lineups_<modeId>.jsonl` | 仍可读；服务器侧用 `node tools/migrate-lineups.mjs <库目录> --apply` 拆分 |

## 最小用法

```js
import { libraryFile, splitLibraryKey } from './key.mjs';

const file = libraryFile('mode_single_hard', 'HARD');   // lineups_mode_single_hard__HARD.jsonl
const { modeId, difficulty } = splitLibraryKey('mode_single_hard__HARD');
```
