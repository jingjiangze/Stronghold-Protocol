# 分支与发布规则（本仓专属）

> 本文只讲**本仓（jingjiangze/Stronghold-Protocol）自己的**分支约定、发布链和门禁。
> 上游玩法/架构文档是另一套：`AGENTS.md` → `docs/ARCHITECTURE.md` / `docs/DESIGN.md` 等，那些是**上游自带、只读**，改上游内容走 `sync-re-upstream` 而不是手改。
>
> 最后核对：2026-11-03（清理分支当天）。下面每个数字都是当天的实测值，**引用前先按 §6 的命令重跑**。

---

## 1. 只有两个分支

| 分支 | 角色 | 谁能推 |
|---|---|---|
| `master` | **默认分支 + 控制面**。定时 workflow 的宿主、fork 关系锚点、README 门面 | 只由同步/运维流程推 |
| `rel2025` | **发布线（唯一）**。APK 构建、热更、上游同步都以它为源 | 经门禁的功能提交 |

除这两个之外**不开长期分支**。要改功能：开 `feat/<简短描述>`，走完 §4 的门禁后**合进 `rel2025` 并立刻删掉**。

> 2026-11-03 清理：12 → 2。删掉的 10 个分支全部先打了 `archive/<分支名>-2026-11-03` tag（提交完整保留，可随时 `git checkout archive/...` 或从 tag 重建分支）。清单见 §7。

### 为什么 `master` 不能删

1. 它是 `default_branch` —— 删了必须换默认分支，而 `apk-re.yml` / `hotupdate.yml` 的 `workflow_dispatch` **只能从默认分支的定义发起**。
2. `sync-re-upstream`、`mirror-master`、`security-gate` 的**运行记录都挂在 master 上**（它们用 master 的 workflow 定义，去操作 `rel2025`）。
3. `master` 有自己的 106 个独有提交（2026-10-03 的 sync 控制面重写等），不是 `rel2025` 的子集。

### 为什么 `master` 的 `apk-re.yml` 是个存根

`master` 上的 `apk-re.yml` 只有 37 行，跑起来直接 `exit 1` 并打印「Refuse to build from the default branch」。这是**故意的**：正式构建只允许从发布线发起。真实现（351 行）在 `rel2025` 上。

> ⚠️ 该存根的提示文案还写着 `--ref re-apk`，而 `re-apk` 已于 2026-11-03 删除。**正确值是 `--ref rel2025`**，以 §3 的命令为准。

---

## 2. 发布链（谁触发谁）

```
上游 sganggs/Stronghold-Protocol 发版
        │
        │  sync-re-upstream（cron 37 */4 * * *，每 4 小时；也可 workflow_dispatch）
        ▼
   rel2025  ←── 门禁 A–E 全绿才推；有冲突就「什么都不推」，写进 issue #164 并 exit 1
        │
        ├──► apk-re（workflow_dispatch）  → 构建 APK → 挂到 shell-v<版本>-vc<vc> release
        │      门禁：Shell 单测全量 → 上游锚点/契约/extras 覆盖 → webroot 启动 → check-apk
        │
        └──► hotupdate（workflow_dispatch） → 内容热更（slim + 签名 manifest）
```

**关键：`apk-re` 和 `hotupdate` 都是 `workflow_dispatch`，push 不会自动出包。** 这是 2026-10-05 的「单一发布者收敛」：正式产物只由发布控制器（`promote.yml` 的 `APK_REQUIRED` 路径）发起，人工 dispatch 只用于诊断/重建/紧急验证。

### 手动出包的准确命令

```bash
# 出 APK（--ref 必须是发布线，不能是 master）
gh workflow run apk-re.yml --repo jingjiangze/Stronghold-Protocol \
  --ref rel2025 -f upstream_tag=<tag> -f release_tag=<tag>

# 出内容热更
gh workflow run hotupdate.yml --repo jingjiangze/Stronghold-Protocol --ref rel2025
```

---

## 3. 版本号规则（硬门禁，不是建议）

| 字段 | 规则 | 当前值 |
|---|---|---|
| `versionName` | **必须等于上游最新 release tag**（`sganggs/Stronghold-Protocol`） | `0.3.3`（= 上游 `v0.3.3`） |
| `versionCode` | 严格递增，不回退 | `2065` |
| `lineage.json` 的 `upstreamTag` | 与 `versionName` 同一来源 | `v0.3.3` |

`apk-re` 的第 19 步会**真的比对上游 tag**，不是只查格式：

```
::error::versionName ($VN) != 上游最新 tag ($UP) —— 把 build.gradle 的 versionName 跟上去
```

> 2026-10-09 审计留下的教训：旧实现只校验 `0.*` 格式，于是上游从 v0.2.1 走到 v0.2.2 时 `versionName` 一直停在 0.2.1 也一路绿灯。
>
> **推论**：上游一发新版，`rel2025` 必须先被 `sync-re-upstream` 同步（连带 `build.gradle` 的版本号一起更新），否则 `apk-re` 会因版本不匹配而红。这是设计意图——不让 APK 落后于上游。

---

## 4. 改代码的流程

### 4.1 判断改动属于哪一层

| 你改的是 | 放哪 | 会不会被上游覆盖 |
|---|---|---|
| 上游玩法/引擎/数据 | 直接改上游路径 | 是 —— `sync-re-upstream` 会覆盖 |
| 壳侧 UI/行为/Java | `tools/apk/extras/**`、`android/app/src/main/java/**` | 否（壳自有） |
| 构建期文本补丁 | `tools/apk/patches/*.json` | 否，但**当前是空的且这是终态**（见下） |

**补丁集为空是设计终态**（2026-10-07 起）：35 个构建期补丁在上游 0.2.0/0.2.1 重构时断了 48 条锚点，于是全部搬进「可热更的 extras 叠加层」。要加新能力，**走 extras 或服务端叠加层，不要往 `patches/` 放补丁**。

### 4.2 提交前必须过的门禁

`apk-re` 会按顺序跑，任何一步红都出不了包：

| 步骤 | 命令 | 查什么 |
|---|---|---|
| Shell 单测（全量） | `node --test tools/apk/*.test.mjs` | 壳侧行为回归 |
| 上游锚点 + 契约 + 覆盖 | `check-patches.mjs` / `check-upstream-contract.mjs` / `check-extras-overlap.mjs` | 上游 DOM 锚点还在、extras 没静默遮蔽上游路径 |
| webroot 启动 + overlay | 内置 | 组装出来的 webroot 能起来、叠加层集合完整 |
| **check-apk** | `node tools/apk/check-apk.mjs` | 签名、双 ABI runtime、`/__sp/` 链、素材、**servers.json 新鲜度 ≤7 天** |

### 4.3 `servers.json` 新鲜度门禁（最容易误伤的一条）

```js
const SERVERS_FRESH_DAYS = 7;
if (ageDays > SERVERS_FRESH_DAYS) fail(`embedded servers.json is stale: updated ...`);
```

`updated` 字段超过 7 天就红。**这个字段来自线上清单，不是仓库里的**：

```
POINTER_BASE = https://github.com/jingjiangze/Stronghold-Protocol/releases/download/manifest
SERVERS_URL  = ${POINTER_BASE}/servers.json
```

`build-webroot` 按 `SERVERS_URL` → `weishucdn` → `dl.jiangjiangze.icu` 的顺序拉，**拉不到才回退到仓库快照**（且快照必须验签通过）。

**刷新方法**（清单内容不变、只刷时间戳）：

```bash
cd "C:/DDDD/Agent Work/stronghold-dl-site"
node tools/sign-servers.mjs                          # 先验签，确认本机私钥与线上匹配
node tools/sign-servers.mjs --sign --out new.json    # 重签（updated 自动刷新，内容不动）
gh release upload manifest new.json \
  --repo jingjiangze/Stronghold-Protocol --clobber    # 替换资产（文件名必须就是 servers.json）
```

> **不要只改 `updated` 不重签**：签名覆盖 `updated`，手改必然验签失败。
> 签名私钥在 `~/.sp-sign/ed25519.key`；`POINTER_BASE` 那个 release 是**按设计**用 `--clobber` 覆盖的（注释原文：`re-uploaded with --clobber on every publish`），不是绕过门禁。

---

## 5. 绝对不要做

1. **不要从 `master` dispatch `apk-re`** —— 那是存根，必红。
2. **不要手工改 `build.gradle` 的 `versionName` 去「凑」上游 tag** —— 那会造出与内容不匹配的包；先让 `sync-re-upstream` 把上游同步进来。
3. **不要往 `tools/apk/patches/` 加补丁** —— 该目录是空的且为终态。
4. **不要删 `master`** —— 见 §1。
5. **不要开长期功能分支** —— 合进 `rel2025` 后立刻删；要留档就打 `archive/<名>-<日期>` tag。
6. **不要直接改上游自带文档**（`AGENTS.md` / `CLAUDE.md` / `docs/*.md` 中非本仓新增的那些）—— 那是 D 类只读文件，`sync-re-upstream` 会覆盖你的改动。本仓新增的文档（含本文）不受此限。
7. **不要用 git push 推 workflow 文件** —— 本仓 `GITHUB_TOKEN` 没有 `workflow` 权限（R-08），改 `.github/workflows/**` 必须由人在本机推，或走带 `workflow` scope 的凭据。

---

## 6. 核对当前真值的命令

本文所有数字都会腐烂。引用前跑：

```bash
# 分支清单 + 各自 HEAD
gh api "repos/jingjiangze/Stronghold-Protocol/branches?per_page=100" \
  --jq '.[] | "\(.name) \(.commit.sha[0:8])"'

# 当前版本 vs 上游最新 tag
gh api "repos/jingjiangze/Stronghold-Protocol/contents/android/app/build.gradle?ref=rel2025" \
  --jq '.content' | base64 -d | grep -E "versionCode|versionName" | grep -v '//'
gh api repos/sganggs/Stronghold-Protocol/releases/latest --jq .tag_name

# 某分支相对发布线的独有提交（删分支前必跑）
gh api "repos/jingjiangze/Stronghold-Protocol/compare/rel2025...<branch>" \
  --jq '"ahead=\(.ahead_by) behind=\(.behind_by)"'

# 归档 tag 清单
gh api "repos/jingjiangze/Stronghold-Protocol/git/refs/tags?per_page=100" --jq '.[].ref' | grep archive/

# 同步是否在被拦下（有冲突时 issue #164 会更新）
gh api repos/jingjiangze/Stronghold-Protocol/issues/164 --jq '.title, .updated_at'
```

---

## 7. 2026-11-03 清理留档

删前一律 `ahead/behind` 实测（相对 `rel2025`），有独有提交的先打 tag。

| 已删分支 | 独有提交 | 归档 tag | 说明 |
|---|---|---|---|
| `re-apk` | 8 | `archive/re-apk-2026-11-03` | 旧发布线，2026-10-15 停更；被 rel2025 取代 |
| `feat/xie-standalone` | **81** | `archive/feat-xie-standalone-2026-11-03` | 协同共竞/团队经济（2026-10-06），已合入上游线 |
| `ui/redesign-function-panel` | 4 | `archive/ui-redesign-function-panel-2026-11-03` | 预载面板 UI 重设计 |
| `feat/crash-report-encrypted` | 1 | `archive/feat-crash-report-encrypted-2026-11-03` | 崩溃上报的旧基线版本（已在 rel2025 重做） |
| `archive/vendored-deltas-2026-10-27` | 0 | `archive/archive-vendored-deltas-2026-10-27-2026-11-03` | 纯快照 |
| `feat/apk024-adopt` | 0 | `archive/feat-apk024-adopt-2026-11-03` | 纯快照 |
| `feat/float-function-menu` | 0 | `archive/feat-float-function-menu-2026-11-03` | 纯快照 |
| `perf/ws-public-compact` | 0 | `archive/perf-ws-public-compact-2026-11-03` | 纯快照 |
| `ui/redraw-function-panel` | 0 | `archive/ui-redraw-function-panel-2026-11-03` | 纯快照 |

另有两个「无独有提交、但属于当前发布链」的分支被**合入后删除**（不是归档）：

- `feat/crash-report-on-rel2025` → fast-forward 进 `rel2025`（`10eba33f`），随后删除。
- `feat/crash-report-encrypted` 的改动是它的前身（基于已废弃的 `re-apk`），仅归档不合并。

**恢复任意归档分支**：

```bash
git fetch origin 'refs/tags/archive/<名>:refs/heads/<名>'   # 或
gh api repos/jingjiangze/Stronghold-Protocol/git/refs -X POST \
  -f ref=refs/heads/<名> -f sha=<tag 指向的 sha>
```
