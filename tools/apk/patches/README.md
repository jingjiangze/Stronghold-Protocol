# 构建期补丁目录（当前：**空，且这是设计终态**）

2026-10-07 起，re-apk 线的补丁集**清零**：壳侧 UI 与行为全部搬到**可热更的叠加层**，
不再往上游文件里插锚点（`tools/apk/patches/*.json` 是构建期文本补丁，会随上游重构漂移——
0.2.0/0.2.1 上原有 35 个补丁会断 48 条锚点，就是这次清零的直接原因）。

现在这些能力分别落在：

| 原补丁组 | 现在在哪 |
| --- | --- |
| G1 标题页（服务器切换 / 本地·线上双按钮 / 大厅入口 / 检查更新 / 延迟胶囊 / 访客数） | `tools/apk/extras/public/js/home-layer.js`（首页 v7） |
| G2 房间页「公开到大厅」按钮 | `tools/apk/extras/public/js/publish-float.js`（悬浮胶囊）+ `room-hook.js`（兼容期） |
| G3 游戏大厅页 | 大厅面板（`extras/public/js/lobby.js` + `ui/shellPanels.js`） |
| G4 游戏内设置·显示（字体/边距/主题） | `tools/apk/extras/public/js/appearance.js`（运行时 CSS 变量） |
| G5 服务端端点（`/lan/*`、`/_shell/rooms`、`/healthz`、dc 桥） | `tools/apk/overlay/sp-host.mjs` + `sp-lobby.mjs` |
| G6 main.js 钩子（房间快照/战绩/昵称/干员调配/进房预热/返回键） | `tools/apk/extras/public/js/core-hooks.js`（走 `globalThis.__SP__` 与 localStorage 镜像） |
| 房间关闭清理（幽灵房） | `tools/apk/extras/public/js/room-lifecycle.js` |

**要加新能力时**：请优先走 extras / 服务端叠加层（热更、零上游冲突），
**不要再往这个目录放补丁**——`check-patches.mjs` 会把「空补丁集」当通过，
`check-apk.mjs` 也不再要求 APK 里带补丁。
