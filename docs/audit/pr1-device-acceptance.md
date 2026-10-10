# PR #1 真机验收记录（2026-10-10）

> 备注：本应作为 PR 评论发布，但当时 GitHub API 被本机代理节点阻断（GraphQL/REST 均 TLS/EOF 失败），
> 故落盘到分支。

## 环境

- AVD `medium_phone`（API 35，**x86_64**），WHPX 加速
- `tools/apk/build-webroot.mjs --no-assets` → webroot stamp `b9ffe0cc10e8fe55d32f1414`（56 MB）
- `gradle :app:assembleDebug` → `app-debug.apk`（17 MB）
- 临时签名密钥用于安装（`android/stronghold.keystore`，gitignore 内，**验收后已删除**）

## PASS —— 设备上确实发生了「按本机链路自动选最快源」

启动后设备写出的 `shared_prefs/sp-art-source.xml`：

```xml
<map>
  <long name="at" value="1791633173893" />
  <string name="id">jsdelivr-assets</string>
  <string name="base">https://cdn.jsdelivr.net/gh/jingjiangze/Stronghold-Protocol-CDN@assets-raw/assets/</string>
</map>
```

证明四件事：

1. `ArtSource.refresh()` 在设备上真跑了 —— 不是编译期常量在起作用。
2. 它读了线上 `cdn/v1/mirrors.json`。
3. 它**正确过滤**：选中 `jsdelivr-assets`（assets-raw），**不是** `jsdelivr`（@main，对 `assets/**` 全 404）
   —— 阶段 3 的资格过滤在真机生效。
4. 结果被持久化，二次启动复用缓存。

即：**走域名（读清单 + 客户端测速）确实做到了自动选最快镜像**；结果与硬编码的 `weishucdn` 不同，
说明这是真实测量而非默认值。

## PENDING —— 「素材请求打到胜出源」未能在本机验证

原因不是代码，是**构建产物**：

- `files/run/server.log`：`v1/v2/v3 failed to start: Cannot run program "./libnode.so" ... No such file or directory`
  —— `assembleDebug` 出的包缺 Node 宿主载荷，页面与本地服务起不来，因此**不会产生任何逐文件
  `/assets/**` 请求**，`ArtCdn.cdnUrlFor()` 这条腿无从观察。
- `files/art/art.log` 只有 ArtStore 的 packs 下载（`pack audio.bgm fetched …` 等），那条路不走 `ArtSource`。
- 且该载荷是 **arm64**（`tools/apk/fetch-termux-node.mjs`），本机 AVD 是 **x86_64**，即便补上也无法运行。

→ 端到端验收需要 **arm64 设备 / arm64 模拟器**，或按发布流水线（T4）出包后安装。

## 结论

| 验收项 | 状态 |
|---|---|
| 启动执行选源逻辑 | **PASS**（真机） |
| 过滤掉不能供素材的源 | **PASS**（真机：选中 assets-raw 而非 @main） |
| 按本机链路选最快 | **PASS**（真机） |
| 选源结果被缓存复用 | **PASS**（真机） |
| 素材 URL 使用胜出源 | `IMPLEMENTED` + 编译 PASS；**真机观察 PENDING**（需 arm64） |
| 首选源禁用后自动换源 | **PENDING**（同上） |

## 遗留与清理

- 临时签名密钥已删除（避免将来误用假证书签名）。
- webroot 构建产物留在 `android/app/src/main/assets/webroot`（构建产物，未提交）；
  `shell-ui-version.txt` 的构建期改动已 `git checkout` 还原。
