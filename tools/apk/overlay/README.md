# tools/apk/overlay — 服务端覆盖层（v2.8.0 起）

这个目录里的 `*.mjs` 会被两条链路自动带上（单一真源）：

| 链路 | 工具 | 落点 |
|---|---|---|
| 本机/APK 构建 | `tools/apk/build-webroot.mjs`（`copyOverlays()`） | `webroot/server/overlay/` → 进 APK |
| 热更新内容包 | `tools/apk/make-bundle.mjs`（RAW slim 组装处） | slim 内 `server/overlay/` |

设备上 `server/overlay-loader.mjs`（随 APK/热更新树）在 host 启动后按文件名序加载它们；
加载结果写进 `handshake.json` 的 `overlays` 字段。**目录缺失/模块损坏/install 抛错 = 记日志跳过，永不阻断启动。**

## 契约

```js
// server/overlay/sp-xxx.mjs
export const overlayApi = 1;             // 必需；不匹配会被跳过（不报错）
export const id = 'sp-xxx';              // 可选；日志 / handshake 里的名字
export async function install(ctx) {}    // 可选；startServer() 之后调用一次
// ctx = { api, id, server, port, host, url, upstreamDir, log }
//   server      = 上游 startServer() 的返回对象（lobby、close() 等）
//   upstreamDir = 正在运行的 server/index.js 所在目录
```

## 规则

1. **只做加法**：新增文件 + 自己的路由/钩子；改上游文件一律走 `patches/`，同一能力不要双写。
2. **安全验收按 Mimosa 约束写死在实现里**：任何服务端出网（http/https 之外一律拒）发请求前校验 host，
   拒绝 localhost / 环回 / 私有 / 保留地址；控制类路由仅限环回对端并校验 Origin；
   "被拒绝的目标根本不会被访问"直接写成断言。
3. **热更新路径**：overlay 是新文件（不经 extras/patches），随 slim 下发 → 设备 hot update 解包后
   下次启动 host 即生效，**不需要重装 APK**（前提：设备壳 ≥ v2.8.0，即带加载点的版本）。
4. 只认 `*.mjs`；README 等文档不会被打进 slim。
