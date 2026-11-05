# 促融共竞 · 阵地足球（独立场景与玩法）

一个**独立**的网页小游戏：复刻《明日方舟》限时玩法「促融共竞」中的**阵地足球**子项目。
不是宿主游戏的 mod、也不是它的一个模式——**单独一套场景与玩法**，只借用
[`sganggs/Stronghold-Protocol`](https://github.com/sganggs/Stronghold-Protocol) 的框架件。

## 玩

```bash
python serve.py            # 默认 0.0.0.0:8100
# 浏览器打开 http://localhost:8100
```

操作模型（已在 `main.js` 实证；仓库中**没有**摇杆、没有 WASD / 方向键处理器、没有 1 / 2 / 3 键）：

1. 在选人页（页面顶部 setup 区）先选择比赛阶段、规则版本、对手球队、足球、比赛风格与连接模式。
2. 进入球场后，先在下方待部署区**点选一名干员（或携带物）**，再点击球场上**合法的部署格**完成部署（`canUseGridCell` 限定 `x` 1..11、`y` 1..7；携带物同样先选再点格，见 `main.js:760` `tryDeployAtCell`）。
3. 切换「当前控制对象」有三种方式：**点击场上己方干员**（`main.js:770`）、**按 `Tab`**（`main.js:787` 并 `preventDefault`）、或点击「切换控制角色」按钮（**`#switchUnitButton`**，`main.js:786`）。
4. 战斗中干员进入足球 / 敌方攻击范围后会**自动索敌攻击**；**只有累计伤害达到该足球的推动阈值才会推动球**，接触本身不会踢球。
5. 推球方向取干员中心到足球的延长线；同格攻击固定向右；远距离攻击对既有球运动方向的影响减弱。
6. 守门员可挡下朝己方球门飞来的足球，挡球后可在 5 秒内重新开球；阵地屏障会受球撞击并可被击破。
7. 5 分钟一局；净胜 1 / 2 / 4 球对应 1 / 2 / 3 枚嘉奖印章。

「单人 + 2 AI 队友」只是选人页「连接模式」下拉中的一项（`single`）；另有「本机双人」（`local`）与「创建 / 加入联机房间」。在 `single` 模式下，另两名己方干员由 `lib/football/ai-teammates.mjs` 驱动（只读状态、只下发命令），对面 3 名为 AI 对手。单人对战命令统一经 `dispatch(action,payload)`；非房主联机走 WebSocket（`main.js:449-450`）。**AI 的移动不依赖 `lib/grid.js`**：`lib/grid.js` 的 SPFA 流场寻路（`Grid.waypoints`）未被本仓库调用，单位移动由 `match-engine.mjs` 的 `moveUnitToward` 直接计算（详见「复用的框架件」一节）。

## 选人页可配置项

| 配置项 | 可选值（已实证于 `index.html`） |
|---|---|
| 比赛阶段 | 训练场 / 初级赛 / 高级赛 / 特级赛（4 档） |
| 规则版本 | 后续阵地足球（再部署**不减半**，默认）/ 促融共竞 #1（再部署减半）（2 套） |
| 对手球队 | 标准队 / 战术队 / 爱球会 / 球德联（4 支） |
| 足球 | 10 种（RMA70 刺球、粉红绒气球、压缩建材球、高能源石球、至纯源石球、无垠回荡球、漏气甲虫球、膨胀甲虫球、北境意志球、底海滑动球） |
| 我方比赛风格 | 基础 / 驻场 / 游走 / 攻坚 / 支援 / 控制（6 种） |
| 连接模式 | 单人 + 2 AI 队友 / 本机双人 / 创建联机房间 / 加入联机房间（4 种） |

## 官方依据

| 项目 | 来源 |
|---|---|
| 场地布局 **13 列 × 9 行**（col0 = 盟友门列 / col12 = 敌方门列 / row0,row8 = 界外；内区 11×7 = `tile_football`） | 官方促融共竞关卡布局；本仓库由 `main.js:383-391` 程序化复刻该网格（`canUseGridCell` 限定 `x` 1..11、`y` 1..7） |
| 一局 **300 秒**、初始费用 30、费用增速 0.85、`maxCost: 99` | 官方关卡配置；数值落在 `lib/football/match-engine.mjs` 的 `MATCH_STAGES` 与 `lib/football-rules.mjs` |
| 足球规则（10 种足球的推动伤害阈值、攻击/摩擦/弹性/推力、特殊球效果、守门位、阵地屏障、净胜球印章） | PRTS 促融共竞条目；参数集中在 `lib/football-rules.mjs` |
| 视觉（**非绿茵场**：灰白水泥大板 + 青色发光边线 + 左蓝右红钢桁架球门 + 深色看台） | 官方预览图 `multi_v3_01-football_preview` 像素实测 |

## 复用的框架件（来自 Stronghold-Protocol）

| 文件 | 用途 | 说明 |
|---|---|---|
| `lib/projection.js` | 官方相机模型参考件（`officialCamera` / `pickTile` / `syncThreeCamera` + 13 个官方相机预设）。**当前入口 `main.js` 未引用它**——`main.js:53-55` 自建 `PerspectiveCamera`，拾取用本地函数 `pickTile`。作为框架参考保留，不是运行期依赖。 |
| `lib/grid.js` | 被 `main.js` 借用 `Grid` 类做 13×9 场地的合法格与可通行判定（`main.js:2` import、`main.js:383-391` 建立 `sceneGrid`、`main.js:392-394` `canUseGridCell`）。文件内的 SPFA 流场寻路（`Grid.waypoints`）**未被本仓库调用**；当前单位移动由 `match-engine.mjs` 的 `moveUnitToward` 直接计算。 |
| `lib/sim-constants.js`、`lib/shared-constants.js`、`lib/detmath.js` | 上者的依赖闭包（`GEO` / `hypot` 等） | 改了两处 import 路径，并把 `N_` 就地换成恒等函数 |

玩家操作改为「点待部署区干员 → 点球合法格部署」的部署式控制；切换控制对象支持点场上干员 / `Tab` / 按钮三种方式。己方单位在战斗中的移动由引擎 `match-engine.mjs` 的 `moveUnitToward` 直接计算（球在射程外时朝球推进，守门员驻守球门列，位置夹在球场内区），**不使用** `lib/grid.js` 的流场航路点。足球规则拆成纯函数模块 `lib/football-rules.mjs`，可独立测试；镜头和 Grid 只作为框架参考，不把 Stronghold 的自动战斗循环伪装成足球玩法。

## 自建的部分（官方素材里没有）

审计确认：客户端**没有任何足球场景几何**——`battle/prefabs/effects/football.ab` 只有粒子特效，
`ui/footballcup` 只有 HUD 图标，`activity/[uc]multiv3.ab` 是纯 UI 包（0 个 Level/MapData），
`scenes/activities/` 下 act*multi 的关卡包已被赛季清理。所以：

- **球场 / 球门 / 足球 / 灯光条纹** = three.js 自建几何
- **足球贴图** = canvas 程序化生成（白底 + 黑五边形），无第三方素材依赖
- **球物理 / 推球 / 计分 / 计时 / AI 战术层** = 自写

本 PR 新增的纯函数比赛层（均在 `lib/football/`）：

- **`match-engine.mjs`**：纯函数比赛状态机。每个操作都是 `(state, ownerId, …) → { state, ok, reason }` 形式，随机走确定性的 LCG（不依赖 `Math.random()`，同种子可重放）。导出：`createMatchState` / `deployOperator` / `deployCarriedItem` / `withdrawOperator` / `activateSkill` / `activateCarriedItem` / `requestCost` / `respondCost` / `restartBall` / `voteReady` / `startBattle` / `getStampCount` / `tickMatch` / `withdrawAllAfterShot` / `chooseOpponentTeam` / `markCell` / `votePause` / `voteSpeed` / `applyCarriedItem` / `computeMatchSummary`。
- **`ai-teammates.mjs`**：单人模式 AI 队友模块。导出 `decideAiTeammateCommands(state, ownerId, ballProfile)`（纯函数，只返回命令、除推进 `state.rng` 外不改状态）、`pickNextControllableUnit(state, currentUnitId)`、`AI_ROSTER_SLOTS = 2`、`AI_TEAMMATE_NAMES = ['队友 · 阿尔图', '队友 · 贝罗']`。行为：部署阶段直接 `ready` 并优先补守门员（x=1）再补足 3 名场上单位；战斗阶段补位，且只在「技力足够、技能位移力 ≥ 球重量、单位在球朝敌门一侧」时才放位移技能。决策节流 0.5s/轮（`main.js:725` `runAiTeammates`，`aiOwnerIds = [1]`）。HUD：`#cost1` 变「AI 队友费用」、`#matchInfo` 首行显示模式、单人模式隐藏 `#playerBar`。

## 联机（双人）

`server/room-server.py` 是一个**最小 WebSocket 中继**：默认绑定 `127.0.0.1:8765`；**房主为唯一模拟权威**，浏览器房主发布状态快照、非房主只发送命令；命令走白名单 `{deploy, withdraw, skill, item, itemDeploy, requestCost, respondCost, ready, restart, mark, pause, speed}`；房主掉线时命令暂存（上限 100 条），已知 `clientToken` 重连可恢复上次快照；房间 TTL 900 秒，并有消息大小上限。它是为**本机 / 受信私有网络**使用的最小中继，**不引入数据库或容器**。

启动方式：

```bash
python server/room-server.py        # 先在本机启动中继，默认 127.0.0.1:8765
```

然后在页面「连接模式」选择「创建联机房间」或「加入联机房间」。

## 测试与 CI

仓库内的纯函数比赛层与联机中继均有单测：

| 测试文件 | 用例数 |
|---|---|
| `tools/test-football-rules.mjs` | 10 |
| `tools/test-match-engine.mjs` | 11 |
| `tools/test-ai-teammates.mjs` | 11 |
| `tools/test_room_server.py` | 5 |

CI 由 `.github/workflows/verify-football.yml` 执行，步骤包括：浏览器模块（`main.js`）语法检查、引擎（`lib/football/match-engine.mjs`）语法检查、上述 4 个测试文件、安装房间中继依赖、校验可分发回退素材（`python tools/check-assets.py`）、Python 工具语法校验（`python -m compileall -q server tools`）。

触发条件：`push` 到 `main` / `fix/**` / `feat/**`，以及对 `main` 的 `pull_request`（`opened` / `synchronized` / `reopened` / `ready_for_review`）。具体某次 run 是否通过以 GitHub Actions 页面为准，本说明不代替 CI 结果。

## 非商用声明

本项目是《明日方舟》限时玩法「促融共竞 / 阵地足球」的**同人复刻练习**，为个人学习与技术研究所做。
本项目与鹰角网络 / Yostar **无关联、未获其认可或授权**，仅用于个人学习与技术研究，**不作任何商业用途**。
官方角色、美术、音效、骨骼与关卡数据的著作权归相应权利人所有；仓库只分发**原创代码**与**原创矢量回退素材**，
官方素材需用户从自己本地客户端提取且**不入库**。

## 素材（`assets/`，**不入库**）

官方 HUD、音效、小人骨骼版权归**鹰角网络 / Yostar**，仓库不再分发。
请按 [`assets/README.md`](assets/README.md) 用 `tools/extract-assets.py` 从你自己的客户端生成。
缺素材时页面照常运行，只是相应内容不显示。

`assets/public/` 与 `assets/fallback/` 是可随仓库再分发的**原创回退素材**（含球场背景、十种球图标、六种风格/携带物图标、职业占位精灵、按钮/HUD 缺失回退）；`assets/ui/`、`assets/chibi/`、`assets/local/` 被 `.gitignore` 排除。

## 第三方

`vendor/`：pixi.js 7.4.2（MIT）、pixi-spine 4.0.6（MIT）、three.js r186（MIT）。（注：`vendor/` 下另有 `hooks.module.js` / `htm.module.js` / `preact.module.js`，但**未被 `index.html` 引用、也未入 git**，此处不纳入依赖清单。）

## 许可

代码 MIT（见 `LICENSE`）。官方素材不在 MIT 覆盖范围内。

## 规则边界与验证

- `lib/football-rules.mjs` 集中存放 10 种足球的公开参数，包含推动阈值、攻击、摩擦、弹性、推力；并实现伤害累计、爆炸触发、三倍得分、漏气/膨胀的尺寸与阈值变化，以及冰面/黏液地形摩擦。
- 选人页的足球下拉框是独立原型的规则测试入口；它把不同官方足球规则放到同一个单人练习场，不代表官方活动用一个菜单让玩家自由切换足球类型。
- 六种比赛风格与六种携带物现已由引擎数据驱动并接入实战：`lib/football/match-engine.mjs` 的 `MATCH_STYLES` / `CARRIED_ITEMS` 实现正负面增减益、部署费用、范围/目标、持续时间与状态效果；携带物按真实部署事件触发，而非仅点击/提示。
- 干员生命值、攻击间隔和屏障耐久仍按本原型尺度统一校准；足球攻击力、推动阈值、弹性/摩擦和特殊足球效果按 PRTS 公布数据建模。凡文档标注「校准值」者（见 `CARRIED_ITEMS` 中 `durationIsCalibration: true` 的护具分发员屏障、猛兽能量饮料、喷射汽水机、迷幻反射镜），均为校准/近似数值，不是官方公布精确值。
- 部署 / 费用 / 再部署 / 技力 / 技能 / 位移带球 / 多人联机中继均已实现为纯函数或最小中继，并由上述单测覆盖；不会把近似描述成官方精确实现。
- `node --test tools/test-football-rules.mjs` 可独立运行足球规则测试；其余测试文件同理。
- `tools/extract-assets.py --groups scene` 或 `tools/extract-scene-textures.py --ab "<客户端>/Arknights_Data/StreamingAssets/AB/Windows"` 会把官方场地贴图提取到本地 `assets/ui/scene/`；公开仓库只保留加载逻辑，不分发版权素材。
- Forge 的工坊包不能直接替换宿主核心场景与每帧主循环，因此本仓库继续作为独立页面；仅参考其模组 API 边界，并复用 Stronghold 的镜头 / Grid 思路。
