# sp-lobby-board — 联机大厅「房间牌」后端

单例 Cloudflare Worker + 一个 Durable Object（`idFromName('board')`），为大厅页提供房间牌：

- 契约**照抄 rainya**（`https://game.rainya.me/api/rooms`）：`{ ok, now, ttlSec: 600, rooms: [...] }`，CORS `*`；
- 字段只做**加法扩展**（`serverId` / `serverName`），客户端 `lobby.js` 的 rainya 兼容解析不变；
- **出站只有一处**：房间牌路由零出站（`src/board.js` 纯核心 url 校验是纯语法校验，绝不回连用户提交的地址——测试给 `globalThis.fetch` 打桩，board 用例跑完计数必须为 0）；`GET /api/community` 是**唯一的社区源中转**，上游是代码内冻结的三个 https 常量（rainya 门户 / Lunar / 梨子湖），客户端只提交 `src` 白名单键、永远提交不了 URL，且发请求前仍按 deny 表校验 scheme+host（见 `relayCommunity()`）。

```
tools/apk/lobby-worker/
├── src/board.js            # 纯核心：校验 / 限流 / TTL / token（零依赖，node --test 直测）
├── src/index.js            # Worker 路由 + Durable Object 类 Board（薄适配层）
├── wrangler.toml           # name / DO 绑定 / migrations（部署命令见文件注释）
├── lobby-board.test.mjs    # node --test（内存适配器直测核心 + 适配层往返）
├── lobby-relay.test.mjs    # node --test（社区源中转：白名单/映射/超时/缓存头，脚本化上游）
└── README.md               # 本文件
```

## HTTP 契约

所有响应带 `access-control-allow-origin: *`、`access-control-allow-methods: GET,POST,DELETE,OPTIONS`、`access-control-allow-headers: Content-Type,X-Token`、`cache-control: no-store`。

| 方法 | 路径 | 请求 | 成功 | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/api/rooms` | — | `200 {ok,now,ttlSec,rooms[]}` | `now` 为 epoch 毫秒；只含未过期条目，最新在前 |
| POST | `/api/rooms` | JSON `{code, serverId, serverName, note?, url?}` | `201 {ok:true, added, token}` | `token` = 128bit hex（32 字符），请客户端保存 |
| DELETE | `/api/rooms?code=&serverId=` | 头 `X-Token: <token>` | `200 {ok:true, removed:{code,serverId}}` | 仅凭 token+serverId 匹配才可销毁 |
| GET | `/api/community?src=rainya\|lunar\|rinko` | — | `200 {ok,src,fetchedAt,rooms[]}` | **社区源中转**（三家上游都不发 CORS 头）。`src` 只认这三个白名单值、不接受任何多余参数；200 带 `public, max-age=10, s-maxage=10`，错误一律 `no-store`（防 CF 负缓存） |
| OPTIONS | `*` | — | `204` | CORS 预检 |
| GET | `/api/health` | — | `200 {ok:true, now}` | 无状态上线自检 |

房间条目（`rooms[i]` / `added`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `code` | string | 大写 `^[A-HJ-NP-Z]{4}$`（归一后强校验，无 I/O） |
| `server` | string | rainya 兼容别名 = `serverName` |
| `serverId` | string | 提交方服务器 id（加法扩展，≤64 字） |
| `serverName` | string | 服务器展示名（≤64 字） |
| `note` | string | 备注，剔除控制字符、trim、截断 ≤40 个码点（emoji 安全） |
| `ageSec` / `leftSec` | number | 已存在秒数 / 剩余秒数（TTL 600s） |
| `url` | string? | **仅当提交时通过校验才带**；规范化为 `URL.href`，不合法则**拒绝整个提交** |

错误响应统一 `{ok:false, error, message?}`。错误码 → 状态码：

| error | HTTP | 触发 |
| --- | --- | --- |
| `BAD_JSON` | 400 | body 非 JSON 对象或超 8KB |
| `BAD_CODE` | 400 | code 缺失/不符合 `^[A-HJ-NP-Z]{4}$` |
| `BAD_SERVER` | 400 | serverId / serverName 缺失、纯控制字符或超长 |
| `BAD_URL` | 400 | url 非字符串 / 非 http(s) / 带 userinfo / >512 字符 / host 命中拒绝表 |
| `FORBIDDEN` | 403 | token 或 serverId 与条目不匹配 |
| `NOT_FOUND` | 404 | code 不存在或已过期 |
| `METHOD_NOT_ALLOWED` | 405 | 非 GET/POST/DELETE |
| `RATE_LIMITED` | 429 | 同 IP 60s 滑动窗口内已成功提交 10 次 |
| `DEBOUNCED` | 429 | 同 code 距上次成功提交 <30s |
| `LIMIT_REACHED` | 429 | 同 IP 未过期条目已达 5 条 |
| `INTERNAL` | 500 | 未预期异常 |

## 限流与校验参数

| 参数 | 值 | 位置 |
| --- | --- | --- |
| TTL | 600s（过期条目 list 不出现且被清理） | `src/board.js` `TTL_SEC` |
| 同 IP 提交频率 | 10 次 / 60s（滑动窗口，只计成功提交） | `IP_RATE_MAX` / `IP_RATE_WINDOW_MS` |
| 同 code 防抖 | 30s（30s 后重提会**替换**旧条目并轮换 token） | `CODE_DEBOUNCE_MS` |
| 同 IP 未过期条目 | ≤5 | `IP_ROOMS_MAX` |
| code | 大写后 `^[A-HJ-NP-Z]{4}$` | `CODE_RE` |
| note | 控制字符剔除、trim、≤40 码点 | `NOTE_MAX` |
| serverId / serverName | 必填、控制字符剔除、≤64 码点 | `SERVER_ID_MAX` / `SERVER_NAME_MAX` |
| url | 可选；http/https、≤512 字符、无 userinfo、port≠0、host 必须为公网地址 | `URL_MAX` |

url 的 host 拒绝表与 `tools/apk/overlay/sp-connect.mjs`（shell 出站守卫）**同一张表**（在该文件内逐条复制，避免 Worker 打包引入 `node:*` 依赖）：环回 / 私有 / link-local / CGNAT / 保留 / 组播 / 文档地址 / `localhost` / `*.localhost` / `*.local` / `*.internal` / IPv6 ULA、link-local、`::ffff:` 映射与 NAT64 等。WHATWG URL 解析在前，八进制（`0177.0.0.1`）、十六进制（`0x7f000001`）、短写（`127.1`）、十进制整数（`2130706433`）都已规范化为点分四段后再查表。

## 存储

- 仅用 **Durable Object storage**（`state.storage.get/put/delete/list`），不用 Workers KV；单例经 `idFromName('board')`。DO 输入门自带串行化，读-改-写无需额外锁。
- 键：`room:<CODE>`（条目，含 `token`/`ip`/`createdAt`，对外输出永不带出）与 `rate:<ip>`（近期成功提交时间戳），过期/陈旧键在读取路径顺手清理。
- 规模上限：单 IP ≤5 条、TTL 600s，DO storage 体量很小。

## 测试与自检

```bash
node --check tools/apk/lobby-worker/src/board.js
node --check tools/apk/lobby-worker/src/index.js
node --test tools/apk/lobby-worker/lobby-board.test.mjs
```

测试用内存适配器直测核心，并断言**全局 fetch 调用数为 0**（房间牌路由零出站；社区源中转走 lobby-relay.test.mjs 单独验证，仅允许三个常量上游）。覆盖：契约形状与 rainya 兼容字段、TTL/leftSec/过期清理、限流三条（IP 频次 / code 防抖 / IP 条目上限）、token 销毁（成功 / 错误 token / 不存在）、note 清洗与长度、url 校验（含 `127.0.0.1`、`10.0.0.1`、`[::1]`、`0x7f000001`、userinfo、超长 → 拒绝且不落盘）、适配层 CORS/状态码/DO 往返。

## 部署

```bash
cd tools/apk/lobby-worker
export CLOUDFLARE_API_TOKEN=...     # 凭据只从环境变量读取，禁止写入仓库
export CLOUDFLARE_ACCOUNT_ID=...    # 或先 npx wrangler login
npx wrangler deploy
```

首次部署得到 `https://sp-lobby-board.<subdomain>.workers.dev`（workers_dev 默认开启）。上线自检：

```bash
curl -s https://sp-lobby-board.<subdomain>.workers.dev/api/health   # => {"ok":true,"now":...}
```

自定义域可后配（`wrangler.toml` 注释里有 `[routes]` / `custom_domain` 建议）。DO migration 用 `new_sqlite_classes = ["Board"]`（SQLite 后端，免费版可用）；若账号/版本不支持则改 `new_classes`（KV 后端，付费版），代码不变。

## 客户端接入点

- 大厅页 `tools/apk/extras/public/js/lobby.js` 顶部常量 `var BOARD = '';` —— 部署后填入 `'https://sp-lobby-board.<subdomain>.workers.dev'`（不带尾斜杠）。
- `BOARD` 非空时其 host 自动加入该页 `ALLOWED_HOSTS`，页面以 `GET <BOARD>/api/rooms` 每 15s 拉取（仅面板打开且页面可见时），解析逻辑与 rainya 源共用（`{ok,now,ttlSec,rooms}` / 条目 `{code,server,note,ageSec,leftSec,url}`）。
- 注意客户端 `sanitizeRoom` 只把 **https** 且非私有 host 的 url 渲染为可加入链接；http 房间会展示但无跳转（服务端仍接受 http 提交，见上表）。
- 提交/销毁 UI 尚未上线（页面第 4 区当前禁用）；将来用 POST + DELETE（`X-Token`）即可，无需再改本服务。

## 假设与不确定点

- **DO 存储 API**：按 `state.storage.get/put/delete/list`（KV 风格，`list()` 返回 `Map<key, value>`，值为结构化克隆）实现；SQLite 后端的 DO 提供同一套 API。若目标运行时对 `list()` 有分页上限（默认整套返回），当前规模（单 IP ≤5、TTL 600s）不会触顶。
- `now` 使用 DO 所在机器的 `Date.now()`；未做客户端时钟校验，`ageSec`/`leftSec` 以服务端为准（rainya 同样如此）。
- 同 IP 计数以 `CF-Connecting-IP` 头为准（Worker 注入，客户端不可伪造）；头缺失时归入 `unknown` 桶。
- 30s 防抖到期后的重提**替换**旧条目并令旧 token 失效（避免同一 code 出现两条）；不同 serverId 也不能抢注，需等 30s。
- 本目录不参与 APK/webroot 构建：只有 `tools/apk/lobby-worker/**` 新增文件，未触碰其它路径。
