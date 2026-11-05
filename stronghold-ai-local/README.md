# stronghold-ai-local — AI 本地运算内核

> 从服务器仓导出的**可独立运行**部分：战斗演化内核 + 试算比较器 + 数据 + 客户端适配层。
> 不含 `Match` / `PlayerState` / 大厅 / 结算 / HTTP 服务端 —— 那些依赖服务端状态，留在原仓。

## 目录

| 路径 | 内容 |
|---|---|
| `sim/` | 战斗引擎与试算比较器（原 `server/sim/` 的导出）。纯 ESM，无 Node API、无时钟、无随机 |
| `shared/` | 内核依赖的共享常量与数据模型（`constants` / `potential` / `diy` / `standIn` / `loadoutRecord` / `i18n` / `i18nPacks` / `lineupFeatures` / `scoringPolicy` / `scoringQueue`） |
| `data/` | 11 个数据文件：`chess` `enemies` `tokens` `stages` `waves` `bonds` `items` `garrisons` `bands` `effects` `backups` |
| `worker/` | 浏览器侧适配：`rehearsalWorker.js`（Worker 入口，只回候选编号）、`rehearsal.js`（协议与调度） |
| `host/` | `runner.js`（客户端运行循环示例；依赖上层 `net` / `store`，**不是**独立可跑） |
| `training/` | 布阵学习库的**键规则**（`key.mjs`，纯函数）+ 布局说明（每玩法 + 每难度一个文件，`lineups_<mode>__<DIFF>.jsonl`） |

`sim/nodeData.js` 是唯一 Node-only 的文件（`node:fs` 读数据），浏览器侧不会加载它；
保留它只是为了让 Node 侧也能用同一份内核。

## 来源与版本

导出服务器仓 `jingjiangze/stronghold-server-server-agent`，内核部分对应 `master` 分支
（当前 `1e0d9a9`：学习库改为按「玩法 + 难度」分开之后）。
`sim/rehearsal.js` 含早停改版（按 `leaks + kills` 的分数天花板提前退出）。
`training/` 是本仓新增的导出层：只放键规则与布局说明，学习库的写入仍只在服务器仓。

## 怎么跑

内核按 URL 约定组织：把 `sim/` 挂到 `/sim/`、`shared/` 挂到 `/shared/`、`data/` 挂到 `/data/`，
再提供一个 `/data.js` 替身（内核里 `content/support/index.js` 会 `import` 它）：

```js
// /data.js —— 浏览器替身，三行就够
import { getSimData } from './sim/simdata.js';
export function getData() { return getSimData() || {}; }
export function resetData() {}
```

最小用法：

```js
import { createBattleFromSpec } from '/sim/spec.js';
import { DataSource, setSimData } from '/sim/simdata.js';
import { RehearsalRun } from '/sim/rehearsal.js';

const raw = {};
for (const n of ['chess','enemies','tokens','stages','waves','bonds','items','garrisons','bands','effects','backups'])
  raw[n] = await (await fetch(`/data/${n}.json`)).json();
setSimData(raw);
const ds = new DataSource(raw, null);

const battle = createBattleFromSpec(spec, ds, { quiet: true, recordEvents: false });
const run = new RehearsalRun(battle, { /* 与服务器同一套比较参数 */ });
const score = run.score.index;
```

`worker/rehearsalWorker.js` 就是上面这段的 Worker 版：收 `{ t:'data', raw }` 一次，
之后每个 `{ t:'rehearsal', specs }` 回一个候选编号。

## 边界（为什么这些文件可以单独搬）

原仓的 `tools/check-imports.mjs` 把 `server/sim` 的禁区写死在代码里：
**不能** import `server/match*`、`server/lobby*`、`server/index.js`、HTTP 层、`public/`、Node builtin；
唯一白名单是 `server/data.js`。也就是说「这是一个可被单独搬运的封闭组件」是仓库自己声明并持续校验的。

同一份 `createBattleFromSpec` 同时被 Node（服务器与测试）和真实浏览器（headless Chrome 测试）
驱动，且断言两边选出的候选逐项相同——跨环境确定性是设计目标（固定 tick、seeded PRNG、自实现 `detmath`）。

## 试算协议（交给谁算、算完回什么）

```
服务器 → 客户端   b.rehearsal       { taskId, specs[] }   // 候选布阵，服务器自己构造
客户端 → 服务器   b.rehearsalResult { taskId, choice }    // 只回候选下标（0–7）
```

威胁模型：**客户端最多只能从服务器自己的候选里挑一个**，不能构造新布阵、不能改棋盘。
服务器对结果再做一次「这个下标是不是我发出去的候选」的校验；宿主不可靠（掉线、超时、报错、
无效编号）时整条委托回退到服务端自己算。

## 许可

见 `LICENSE`（与原项目一致）。这是非官方同人作品，仅供学习交流；素材版权归 Hypergryph / Yostar 所有。
