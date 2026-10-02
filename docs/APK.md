# 卫戍协议 Android 壳（apk 分支）

非官方 Android 壳，把浏览器客户端装进手机：横屏全屏、资源全内嵌（首屏秒开）、
**内嵌游戏服务器（房主模式：手机开房，朋友 ZeroTier / IPv6 / 局域网直连）**、
以及跟随上游仓库的内容热更新。

上游是 server-authoritative 架构（DESIGN §1），因此"联机"始终有一台权威服务器；
本壳把这台服务器装进房主的手机（nodejs-mobile libnode，Node 18.20.4，已实测完整
跑通握手与建房），替代" everyone 连远程盒子"的旧模型。战斗本身在各自浏览器端
60tps 模拟（DESIGN §14），房主带宽压力只有 KB 级 WS 消息。

## 壳层行为

| 能力 | 说明 |
|---|---|
| 横屏全屏 | `sensorLandscape`（可 180° 双向）+ 沉浸式 sticky + 防息屏 |
| 资源内嵌 | webroot 全量打包进 APK：首屏秒开、进战斗零加载 |
| 请求拦截 | 同 origin 静态请求 → filesDir/webroot → APK assets → 放行网络；`/ws` 永远走网络 |
| Google Fonts | 拦截置空（内嵌字体已有，原外链在国内是渲染阻塞） |
| 版本护栏 | 启动对比所连服务器 `/healthz` 的 `app` 与 `EMBEDDED_APP_VERSION` |
| 内容热更新 | 顶部热区菜单 → 检查更新：拉**上游官方 Release** 整合包 → 本地解包子集 → filesDir 免重装生效 |
| 房主模式 | 内嵌 Node 服务器，前台服务保活；自动列出 ZeroTier/IPv6/局域网地址 |
| 断线页 | 重试 / 房主模式 / 在线模式 / 切换服务器 |
| 渲染崩溃 | 自动重建 WebView |

**壳菜单**：点击屏幕最顶边 12dp 隐形热区 → 房主模式 / 检查更新 / 切换服务器。

## 三种联机通道（朋友怎么连）

1. **ZeroTier / Tailscale 直连（推荐）**：房主与朋友装组网 App 进同一网络，朋友在
   断线页「切换服务器」填 `http://<房主组网IP>:3000`。国内城际 RTT 15–60ms。
2. **IPv6 直连（朋友零安装）**：房主网络有全局 IPv6 时，服务器 `HOST=::` 双栈监听，
   朋友直连 `http://[v6地址]:3000`。注意前缀漂移，每次开局重新分享地址。
3. **Cloudflare 隧道（兜底）**：连默认域名 `https://stronghold.jiangjiangze.icu`
   （远程盒子的常驻服务器），或房主自跑 `cloudflared tunnel --url http://localhost:3000`。

房主自身的 WebView 连 `http://127.0.0.1:3000`（本机内置服务器），无需切地址。
玩家身份（名字/令牌）按 origin 隔离，切换服务器后需重新输入名字。

## 构建

本地（Windows，本机已装工具链时）：

```powershell
powershell -File scripts/build-apk.ps1
```

CI（推送到 apk 分支或手动 dispatch 即自动构建）：

- `tools/apk/fetch-libnode.mjs`：下载 nodejs-mobile v18.20.4 Android 包，
  放置 `app/src/main/jniLibs/arm64-v8a/libnode.so` 与 `node-include/`（均 gitignore）
- `tools/apk/build-webroot.mjs`：下载**上游** Release 整合包，裁剪出
  `public/(−dev) + data + shared + server + node_modules + package.json`，
  生成 `assets/webroot`（gitignore），并生成 `/data.js` shim
- `gradle assembleRelease`：签名用 `STRONGHOLD_KEYSTORE_B64` secret（base64 的
  keystore），产物挂 Release tag

> 素材合规：热更新与内嵌内容都来自**上游官方 Release**（作者自己的分发渠道），
> 本仓库 Release 只发布壳 APK（GPL 代码），不重发素材包。

## 已知限制

- libnode 为 4KB 内存页编译：Android 15+ 的 16KB 页设备可能无法加载（在装机的
  Android 8–14 设备上无影响）。
- Node 18 已过上游 EOL（内嵌场景无公网暴露面，风险可控）。
- 房主进程即房间：杀掉 App 全房解散（游戏状态只在服务器内存，DESIGN §6.7）。
- 换服务器地址 = 换 origin，玩家名字需要重输（身份按 origin 存储于 localStorage）。
