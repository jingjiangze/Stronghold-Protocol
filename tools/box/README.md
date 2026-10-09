# tools/box — 盒子的更新与验收（都在脚本里，不靠 SSH 手抄）

盒子跑的是**无素材版**（`public/assets`、`public/fonts` 不落地，素材全走 weishucdn，见
`update/NOTE-no-art.md`）。它**自己**盯着我们的滚动 Release 并蓝绿切换；这个目录是那套逻辑的
**权威副本**——脚本随每个发布包一起发出去，部署成功后会把 `update/` 里的同名文件覆盖成新版本
（自更新），所以**永远不要手改盒子上的那份**。

```
合并到 master-play
      │  CI 出 -cdn.zip + deploy/latest.json（同时挂 GitHub Release server-cdn-latest 与 CDN）
      ▼
盒子 SpUpdateZip（每小时，SYSTEM）→ sp_update_zip.ps1
      │  比对 latest.json 的 stamp 与 update/deployed.json  →  相同就什么都不做
      ▼
空闲槽目录解包 → 起空闲槽（必须回答出**不同的 build**）→ 契约自检 → 切 nginx → 记录 → 老槽排空
      │  任何一步失败：nginx 不动，进程留在现场，日志写 logs/update-zip.log
      ▼
验收：node tools/box/verify-service.mjs --expect=<新 buildTag>（不用连盒子）
```

## 文件

| 文件 | 作用 |
|---|---|
| `sp_update_zip.ps1` | 更新器本体：拉包（CDN 优先，GitHub 兜底）→ sha256 → 解包 → 蓝绿 → **契约自检** → 切 nginx → 自更新。`-Check` 只比对不动作（有新包时退出码 2）、`-DryRun` 解包+自检但不启动不切换、`-Force` 忽略 stamp 重部署 |
| `sp_update_zip.cmd` | 计划任务入口（`SpUpdateZip`，每小时，SYSTEM）。**必须 SYSTEM**：nginx 以服务运行，交互会话打不开它的 `Global\ngx_reload_<pid>` 事件 |
| `verify-service.mjs` | 对**正在服务**的部署做验收（HTTP，无 SSH）：`/healthz` 的 build、index.html 自有引用带 `?v=<tag>`、模块体自有 import 带 tag 且 vendor 不带、带版本的 URL 是 immutable 而不带版本的**不是**、`/data`（含素材清单）同样 |
| `README.md` | 本文件 |

## 常用命令

```bash
# 合并之后：等盒子自己跟上（最多 10 分钟），并在跟上的那一刻验收
node tools/box/verify-service.mjs --expect=<新 buildTag> --wait=600

# 日常验收线上（无参数 = 线上域）
node tools/box/verify-service.mjs

# 对着本机起的服务器验收（开发时）
node tools/box/verify-service.mjs --base=http://127.0.0.1:3000
```

在盒子上（本地会话，非 SSH 手抄）：

```powershell
# 有新包吗？什么都不改，退出码 2 = 该部署了
powershell -File D:\stronghold\update\sp_update_zip.ps1 -Check

# 只解包 + 契约自检，不启动、不切 nginx
powershell -File D:\stronghold\update\sp_update_zip.ps1 -DryRun
```

## 契约（部署必须满足，否则更新器不切 nginx）

版本化静态图是**上行**的主要措施（见 `docs/上行带宽最大化压缩.md` 第九节），所以更新器把它的三条不变量
当成发布门禁，任何一条不满足就**保持现役槽不动**并把原因写进日志：

1. 模块图与 `/data` 的 URL 必须带 `?v=<buildTag>`，且带版本的响应是 `immutable`；
2. 不带版本的 URL **不能**是 `immutable`（否则部署触达不到已打开的页面）；
3. `/vendor/` 的引用**一律不带** `?v=`——同一模块两个 URL 就是两个实例（两份 preact，页面会死在启动）。

同一条契约由 `verify-service.mjs` 在公网侧再验一遍，并由 `test/box-verify.test.js` 在本机起真实服务器跑通。

## 回滚

* **单文件级**：被覆盖的文件旁边留 `.bak-p116` / `.bak-<日期>`；更新器自更新时也留 `sp_update_zip.ps1.bak-<日期>`。
* **整树级**：旧槽的目录**不删**，只是排空（`ensure_server2.ps1` 在空局后回收）。要回退就把
  `nginx/conf/sp_current.conf` 的 upstream 写回旧端口并 `nginx -s reload`，再更新 `active_slot.json`。
* **记录**：`update/deployed.json` 记 version / stamp / sha256 / build / slot / deployedAt；
  `update/active_slot.json` 记现役槽与端口。验收看 `/healthz` 的 `build` 对不对得上。

## 已知边界

* `PAUSE_AUTOUPDATE` 挡的是 **`sp_update2.ps1`（跟上游 master 的那条）**，不是本脚本：它会用上游代码覆盖
  这套 fork 并重写槽脚本、丢掉 `SP_ASSET_CDN`。本脚本跟的是**我们自己的** Release，不要给它加这个挡片。
* 槽的本地探测一律 `curl --noproxy *`：`Invoke-WebRequest http://127.0.0.1:...` 会走系统代理并假报 DOWN。
* 从 SSH 会话里手动 `Start-Process` 起的槽进程会随会话结束而死；要重启槽请走任务，或接受守护在 ~1 分钟内的恢复。
  详细坑见 memory `stronghold-slot-ops-traps`。
