# 阵地足球：官方规则补全与素材闭环执行计划

> 状态说明遵循仓库约定：BASELINE = 当前已存在；IMPLEMENTED = 代码已落地但未验收；PASS = 验收已通过；PENDING = 尚未完成。不能把计划目标标记为已实现。

> 文档更新日期：2026-10-14。本文件状态以该日快照为准（分支 `feat/football-battle`、PR #2）。

## 1. 审计范围与当前结论

目标仓库：`jingjiangze/cujong-football-standalone`  
当前工作分支：`feat/football-battle`  
当前 PR：[#2 Single-player football with AI teammates, plus official rule alignment](https://github.com/jingjiangze/cujong-football-standalone/pull/2)（`feat/football-battle` → `main`）  
上一轮 PR：[#1 修正阵地足球：基建式移动与促融共竞规则](https://github.com/jingjiangze/cujong-football-standalone/pull/1)（分支 `fix/official-football-rules-base-movement`）

已审计文件：`main.js`、`index.html`、`serve.py`、`lib/football-rules.mjs`、`lib/football/match-engine.mjs`、`lib/football/ai-teammates.mjs`、`server/room-server.py`、`tools/test-football-rules.mjs`、`tools/test-match-engine.mjs`、`tools/test-ai-teammates.mjs`、`tools/test_room_server.py`、`.gitignore` 和 `.github/workflows/verify-football.yml`。

主要架构问题（原问题 → 现状，按 2026-10-14 快照更新）：

1. **原问题**：`main.js` 同时承担渲染、输入、AI、道具、球物理和状态更新，缺少独立的可测试比赛状态机。  
   **现状**：已落地纯函数比赛状态机 `lib/football/match-engine.mjs`（每个操作 `(state, ownerId, …) → { state, ok, reason }`，确定性 LCG 随机）；`lib/operators.mjs` 保留。早期平行重复的纯函数层 `lib/match-state.mjs` 已于本次死代码清理中删除（与 `match-engine.mjs` 平行重复且模型冲突）。→ **IMPLEMENTED（代码已落地）**。
2. **原问题**：每边固定 3 名角色，没有部署费用、部署槽、待部署池、撤退/再部署计时、技力、技能冷却和阵容选择。  
   **现状**：`match-engine.mjs` 实现部署/撤退/再部署、费用增长与上限、技力与技能冷却、待部署池与部署上限（`deployLimit`）、守门位例外（`keeperCell`）；选人页可选阵容相关配置。→ **IMPLEMENTED（代码已落地）**。
3. **原问题**：没有第二名真实玩家的房间、同步协议或断线恢复；两边均由本地 AI 驱动。  
   **现状**：新增 `server/room-server.py`（默认 `127.0.0.1:8765`，房主权威、命令白名单、房主掉线暂存命令、client token 重连恢复、房间 TTL 900s）；选人页「连接模式」含本机双人 / 创建 / 加入联机房间。→ **IMPLEMENTED（代码已落地）**。
4. **原问题**：技能没有可触发的能力模型，“技能位移带球”没有执行路径。  
   **现状**：`activateSkill` 实现 SP 扣减、冷却/持续状态；位移技能（`push`/`pull`/`dash`/`shift`）在合法位移时直接带球，并校验位移力 ≥ 球重量（`ball-too-heavy-for-shift`）。→ **IMPLEMENTED（代码已落地）**。
5. **原问题**：六种比赛风格只实现部分简化效果；六个携带物/道具没有完整机制。  
   **现状**：`MATCH_STYLES`（6 种，含正负面增减益）与 `CARRIED_ITEMS`（6 种，含部署费用/范围/目标/持续时间/状态效果）已数据驱动并接入实战；携带物按真实部署事件触发。凡 `durationIsCalibration: true` 者（护具分发员屏障、猛兽能量饮料、喷射汽水机、迷幻反射镜）为校准值，非官方精确值。→ **IMPLEMENTED（代码已落地）**。
6. **原问题**：敌方 AI 是“最近球员追球”的单一逻辑，不具备不同球队策略或战术状态机。  
   **现状**：`OPPONENT_TEAMS` 定义 4 支对手球队（标准/战术/爱球会/球德联）与三种敌方角色（kicker/goalkeeper/hitman），`enemyCombatTick` 按球队 tactic 与角色分支实现守门/击人/射门等策略；爱球会多一名接应击球手 striker。→ **IMPLEMENTED（代码已落地）**。
7. **原问题**：官方资源 `.gitignore` 排除应保留；但缺素材时无足够原创默认角色精灵/贴图，场地贴图走可选本地 HEAD 检查。  
   **现状**：`assets/public/` + `assets/fallback/` 提供原创可再分发回退素材（球场、球图标、风格/携带物图标、职业占位精灵、HUD 缺失回退），`manifest.json` 与 `tools/check-assets.py` 校验；`assets/ui`/`assets/chibi`/`assets/local` 仍被忽略。→ **IMPLEMENTED（部分：回退素材与校验已落地；官方本机提取仍需用户自备客户端）**。
8. **原问题**：CI 只检查语法和足球规则单测，不检查部署/费用/技力/技能/道具/联机协议、场景资源或浏览器集成。  
   **现状**：`.github/workflows/verify-football.yml` 已增加引擎语法检查、4 个测试文件（足球规则/引擎/AI 队友/房间中继）、回退素材校验、Python 工具语法校验，并触发于 push 到 `main`/`fix/**`/`feat/**` 及 `main` 的 pull_request。具体某次 run 是否通过以 GitHub Actions 页面为准。→ **IMPLEMENTED（CI 配置已落地；是否 PASS 取决于每次 run 结果，本快照不宣称某次具体通过）**。

## 2. 官方行为基线

主要参考：
- PRTS《促融共竞》项目规则书：<https://prts.wiki/w/促融共竞>
- PRTS《促融共竞》#1 规则和敌人列表：<https://prts.wiki/w/促融共竞/01>
- PRTS《促融共竞》#2 规则、风格与携带物：<https://prts.wiki/w/促融共竞/02>
- PRTS《罗德岛促融共竞》足球球种表：<https://prts.wiki/w/罗德岛促融共竞>

需要区分历史规则集，不能把不同赛季的加成混为一谈：
- 旧版规则：球员再部署费用不递增、再部署时间减半、技能需求降低 20%、自然技力回复加倍。
- 后续阵地足球规则：球员再部署费用不递增、移除再部署时间减半效果、技能需求降低 20%（特级赛例外）、自然技力回复加倍。
- 场景数据中的 300 秒比赛、移动倍率、初始费用与费用增速应保留为配置，而不是散落在逻辑中。
- 推球分为阈值累积伤害与位移技能两条路径；方向来自干员中心和球的延长线；同格攻击尝试向右，远距离干员对方向的影响权重为五分之一。
- 足球的共通阻挡规则、重量等级、十种足球参数与特殊效果必须以数据定义并有单测。
- 六种风格有明确正负面效果，并分别对应一个携带物。道具需实际改变比赛状态，不能只有点击/提示。
- 进球后全场干员撤退进入再部署状态；守门员挡球后球进入己方待部署区，5 秒内可重新开球。
- 多人模式最多两名真实玩家共同参赛，双方各自控制己方球队；单人训练才使用 AI 填补对手/伙伴。

## 3. 执行分阶段方案

### 阶段 A：建立显式状态/规则层
状态：IMPLEMENTED = 纯函数比赛状态机 `lib/football/match-engine.mjs` 已落地；`lib/operators.mjs` 保留（早期平行重复的 `lib/match-state.mjs` 已于本次清理删除）；PASS = 由 `.github/workflows/verify-football.yml` 执行 `tools/test-match-engine.mjs`(11)，具体通过与否以 CI run 为准。  
实施：
- 新建 `lib/match-state.mjs`、`lib/deployment.mjs`、`lib/operators.mjs`，保持函数式、数据驱动，不把状态藏到类实例。（注：上述三文件中，`lib/match-state.mjs` 已于本次死代码清理中删除——它与 `match-engine.mjs` 平行重复且模型冲突；经 `git log --all -- lib/deployment.mjs` 查证该文件从未进入仓库历史；`lib/operators.mjs` 保留。）
- 明确定义 Match/Team/Operator/Ball/Barrier/Item/Skill/Network 的状态结构和可序列化 schema。
- 用纯函数处理状态转换：deploy、retreat、redeploy、tickCost、tickSp、activateSkill、skillMoveBall、spawnItem、useItem、goal、resetAfterShot。
- 修正推球方向权重与阈值变化、球体碰撞、守门位/普通阻挡位的规则边界。
验收：纯 Node 单测覆盖边界费用、冷却、阈值、技能状态、球碰撞、重新开球、终场判定；随机种子注入后同输入产生同输出。

### 阶段 B：阵容、部署费用、部署槽、撤退/再部署、技力
状态：IMPLEMENTED（代码已落地，验收由 CI 测试覆盖；具体 PASS 取决于每次 run）。`match-engine.mjs` 的 `deployOperator`/`withdrawOperator`/`tickCostsAndRedeploy`/技力与技能冷却/`keeperCell` 守门位例外/`deployLimit` 部署上限均已实现。  
实施：
- 赛前选择球队阵容与替补；比赛中存在待部署列表、上场角色、部署槽占用、守门位例外。
- 费用自然增长、达到上限后停止；部署消耗取角色数据；撤退返还按规则处理；再部署计时及费用增量由 ruleset 控制。
- 每名角色维护技能 SP、SP 上限、自然回复速率、技能需求；按选定规则集应用 20% 需求折减与 2 倍自然回复。
- 允许远程角色放在阵地足球格上；守门员部署位不占常规部署槽，并获得足球阻挡需要的额外阻挡数。
验收：部署费用不能为负、部署槽不能超限、再部署角色不能提前部署、守门位不占普通槽、不同 ruleset 下费用/再部署/SP 数值断言一致。

### 阶段 C：技能与位移带球
状态：IMPLEMENTED（代码已落地，验收由 CI 测试覆盖）。`activateSkill` 实现 SP 扣减、冷却/持续状态，位移技能（`push`/`pull`/`dash`/`shift`）在合法位移时直接带球并校验位移力 ≥ 球重量（`ball-too-heavy-for-shift`），未声明技能不能凭空推球。  
实施：
- 建立可配置技能描述：SP 需求、持续时间、攻击/治疗/阻挡/状态效果、位移距离、位移方向与对不同重量足球的位移强度。
- 技能发动流程统一扣 SP、进入冷却/持续状态；位移技能可在合法位移时直接带球，不再要求球伤害累积达标。
- 仅在可配置能力声明允许位移时触发，未声明技能不能凭空推球。
验收：至少覆盖攻击、控制、位移带球、SP 不足、持续时间终止、重量等级影响及守门阻挡场景。

### 阶段 D：六种比赛风格与六类携带物
状态：IMPLEMENTED（代码已落地，验收由 CI 测试覆盖）。`MATCH_STYLES`（基础/驻场/游走/攻坚/支援/控制，含正负面增减益）与 `CARRIED_ITEMS`（6 种，含部署费用/范围/目标/持续时间/状态效果）已数据驱动并接入实战；携带物按真实部署事件触发。凡 `durationIsCalibration: true` 者（护具分发员屏障、猛兽能量饮料、喷射汽水机、迷幻反射镜）为校准值，非官方精确值。  
实施：
- 严格实现基础、驻场、游走、攻坚、支援、控制的正负面效果；版本差异保存在规则配置。
- 各风格携带物拥有部署费用、范围/目标、触发条件、持续时间、次数/冷却与真实效果。
- 处理短暂攻速/攻击增益、屏障、范围伤害与再部署清零、攻速/防御变化、随机技力补给、异常状态增幅等效果。
验收：风格正负面成对测试；携带物仅影响合法范围/目标；持续时间结束后属性还原，不累积永久污染。

### 阶段 E：对手球队与 AI 战术
状态：IMPLEMENTED（代码已落地，验收由 CI 测试覆盖）。`OPPONENT_TEAMS` 定义 4 支对手球队与三种敌方角色（kicker/goalkeeper/hitman），`enemyCombatTick` 按球队 tactic 与角色分支实现守门/击人/射门等策略；爱球会多一名接应击球手 striker。  
实施：
- 将 AI 状态机拆为守门、争球、控球、推进、射门、回防、拦截、攻击球员、拆屏障与复位等明确行为。
- 建立球队策略配置（进攻优先、防守反击、强力射门、守门密集、球员压制、屏障拆除等），在赛前从策略池确定对手。
- 对球员与足球使用同一伤害/阻挡/击退规则；足球可被剩余阻挡数足够的角色拦停，守门员是独立角色。
验收：固定随机种子下可重放；AI 不全员无脑聚球；射门、挡球、拆障、换人等行为有覆盖测试。

### 阶段 F：双人实时协作、房间与恢复
状态：IMPLEMENTED（代码已落地，验收由 `tools/test_room_server.py`(5) 与 CI 覆盖；具体 PASS 取决于每次 run）。`server/room-server.py`（默认 `127.0.0.1:8765`，房主权威、命令白名单、`pending_commands` 暂存上限 100、client token 重连恢复、`ROOM_TTL_SECONDS=900`、消息大小上限）已实现；选人页「连接模式」含本机双人 / 创建 / 加入联机房间。  
实施：
- 给本地 `serve.py` 增加单服务进程内的 WebSocket 房间中继，默认仅本机/局域网使用；不引入数据库、Redis、容器或独立后台管理页。
- 创建房间/加入房间、房主权威模拟、对端输入命令、状态快照、断线提示、短暂重连、比赛结果同步。
- 通过消息类型白名单、房间码校验、尺寸上限和发送频率限制避免任意消息修改核心状态。
- 单人训练可关闭网络并使用 AI；多人房间时双方各自控制自己的部署/技能/战术指令。
验收：本机双浏览器集成测试能创建/加入房间、部署双方角色、同步技能与比分；离线/断线时能恢复或明确结束，不发生双主机状态分叉。

### 阶段 G：可再分发素材与本机官方素材构建链
状态：部分 IMPLEMENTED（原创回退素材与校验已落地；本机官方素材提取仍需用户自备客户端）。`assets/public/` + `assets/fallback/` 提供原创可再分发回退素材，`manifest.json` 与 `tools/check-assets.py` 校验；`assets/ui`/`assets/chibi`/`assets/local` 仍被 `.gitignore` 排除。`loadAssets`/启动诊断逻辑的事实以源码为准，未在本快照逐项复核，标记为 PENDING 的项见下方矩阵。  
实施：
- 公开仓库加入原创、可再分发的 SVG 球场纹理、球型图标、球门/障碍图标、六个风格和携带物图标，以及一组原创角色精灵。
- 缺少本机客户端资源时自动回退到原创角色/素材，不能只显示空场或日志报错。
- 保留官方客户端本机提取工具，但把产物继续排除出 Git；补充校验与资源清单（名称、尺寸、来源、缺失项），让用户能复现自己本地的官方素材。
- 场景加载直接根据 manifest 加载，避免逐帧/每次请求 HEAD 检查。
验收：不具备明日方舟客户端的干净克隆仍能完整启动、显示双方角色/足球/球门/障碍/HUD/风格/道具；本地已提取资源能覆盖原创回退；仓库扫描不含被排除的官方美术/音频。

### 阶段 H：端到端验收与文档
状态：部分 IMPLEMENTED（文档与 CI 配置已落地；完整浏览器 E2E/Playwright 在本快照未实证）。CI 由 `.github/workflows/verify-football.yml` 执行纯函数单测（足球规则/引擎/AI 队友/房间中继）、引擎语法检查、回退素材校验、Python 工具语法校验；README 已说明「已验收的规则」「近似模拟」「官方版权素材本地导入方式」与联机本机/局域网启动方法。Playwright 等浏览器端到端测试在事实表中未列出、未实证 → **仍 PENDING**。  
实施：
- Node 单测覆盖状态机；Python 单测覆盖房间/协议；Playwright 或等价浏览器测试覆盖启动、部署、技能、足球入门、进球、重开球和多人联机。
- CI 使用最小依赖，测试失败时不可合并；测试分为 BASELINE / IMPLEMENTED / PASS / PENDING 报告。
- README 明确“已验收的规则”“近似模拟”“官方版权素材的本地导入方式”和双人本机/局域网启动方法。
验收：从干净 Git clone 开始安装依赖、启动服务器、打开两名客户端、完成 5 分钟内至少一次部署/技能/进球/重新开球流程。

## 4. 资源边界

- 公开仓库只提交原创 SVG/代码和可合法再分发的开源资产。
- 由用户本机客户端提取的官方角色骨骼、图像、音效仍写到被 Git 忽略的 `assets/ui` / `assets/chibi`。
- 不把不存在于公开仓库中的官方素材描述成“已补齐”；官方素材存在时才标记为本地覆盖成功，原创回退素材则始终可运行。

## 5. 当前状态矩阵（审计快照）

| 能力 | 当前状态 | 目标验收 |
|---|---|---|
| 部署式控制（点干员→点格；Tab/按钮/点场上干员切换） | IMPLEMENTED（代码已落地；原「摇杆与键盘连续移动」已改写为部署式控制） | PASS：设备输入集成测试（未实证，PENDING） |
| 十种球的基础参数/部分效果 | IMPLEMENTED（规则集中 `lib/football-rules.mjs`，单测覆盖） | PASS：全部特殊球单测与比赛集成（由 CI 执行，单次结果以 run 为准） |
| 伤害阈值推动 | IMPLEMENTED（引擎 `ballPushFromUnit`） | PASS：官方权重规则单测（由 CI 执行，单次结果以 run 为准） |
| 部署/撤退/再部署/费用 | IMPLEMENTED（引擎 `deployOperator`/`withdrawOperator`/`tickCostsAndRedeploy`） | PASS：状态机与 UI 集成（由 CI 执行，单次结果以 run 为准） |
| 技力/SP 与技能发动 | IMPLEMENTED（引擎 `activateSkill`/SP 自然回复/技能冷却） | PASS：边界单测与实战流程（由 CI 执行，单次结果以 run 为准） |
| 技能位移带球 | IMPLEMENTED（位移技能类型 + 球重量校验） | PASS：按球重量与能力类型测试（由 CI 执行，单次结果以 run 为准） |
| 六种比赛风格全部效果 | IMPLEMENTED（`MATCH_STYLES` 数据驱动，含正负面；携带物按真实事件触发） | PASS：正负面/状态回滚测试（由 CI 执行，单次结果以 run 为准） |
| 六种携带物 | IMPLEMENTED（`CARRIED_ITEMS` 数据驱动；标注校准值者为近似） | PASS：部署范围/时长/效果测试（由 CI 执行，单次结果以 run 为准） |
| 多人协作联网 | IMPLEMENTED（`server/room-server.py` + 选人页连接模式） | PASS：双客户端房间/同步测试（由 `tools/test_room_server.py` 覆盖，单次结果以 run 为准） |
| 多球队战术 AI | IMPLEMENTED（`OPPONENT_TEAMS` + `enemyCombatTick` 按 tactic/角色分支） | PASS：固定种子回放覆盖（由 CI 执行，单次结果以 run 为准） |
| 原创默认场景/角色素材 | IMPLEMENTED（`assets/public/` + `assets/fallback/` 回退素材 + `manifest.json`） | PASS：无本机客户端的干净克隆（回退素材已可运行；本机官方素材提取仍依赖用户客户端 → 部分） |
| 本机官方素材覆盖加载 | IMPLEMENTED（部分：`tools/extract-assets.py` + 加载逻辑；产物仍 git 忽略） | PASS：资源清单与加载集成测试（`tools/check-assets.py` 已接入 CI） |
| 浏览器端到端与 CI | IMPLEMENTED（CI 配置已落地：语法检查/4 个测试文件/素材校验/Python 语法校验） | PASS：完整 E2E 作战流程（Playwright 未在事实表实证 → 仍 PENDING） |

## 6. 执行纪律

- 先提交本计划，再按 A → B → C → D → E → F → G → H 的依赖顺序实现；每一阶段单独提交、跑测试、报告 SHA。
- 失败时修根因，不能只绕过测试或把目标态标记为 PASS。
- 保留当前可运行入口 `python serve.py`；不把原型直接重写成复杂类体系。
