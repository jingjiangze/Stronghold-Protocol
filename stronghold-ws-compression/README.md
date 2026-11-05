# stronghold-ws-compression

卫戍协议（Stronghold Protocol）的 **WebSocket 链路层**：传输压缩 + 帧瘦身 + 快照节奏 + 会话归属路由，
外加一个**只读状态接口**。零依赖的压缩模块可以单独用；其余分层以 `integration/` 叠加层的形式随包提供。

从 `jingjiangze/stronghold-master-play` 抽出，已在其线上盒子跑过（`build a697834a6599`）。

---

## 一、人均带宽（实测）

**整局逐字节实测**（真实服务器进程、真实 socket、AI 托管打满一局、字节校验通过）：

| 流 | 应用层 | 在线速率 | 说明 |
|---|---|---|---|
| `b.start` | 43,504 B | **72.5 B/s** | 战斗规格，**未压缩**（不在白名单） |
| `m.private` | 278,496 B | ~23 B/s | 逐人视图，压缩后 |
| `m.public` | 28,573 B | ~3 B/s | 公开状态，delta + 压缩后 |
| 其余控制帧 | 3,828 B | 6.4 B/s | welcome / room.state / ticker / b.end |
| **合计** | 354,401 B / 600 s | **≈105 B/s/席** | |

两次独立测量吻合：600 s 整局 **104.6 B/s**，400 s 窗口 **111.3 B/s**。
线上真实链路（樱花隧道）热流实测 **9.57×**（应用层 34,315 B → 在线 3,585 B）。

**10 Mbps（1,250,000 B/s）→ 约 11,000–12,000 并发**，留 20% 余量约 **9,000**。

### 60 分钟口径

| 口径 | 每人 | 10 Mbps 容纳 |
|---|---|---|
| 稳态（客户端已缓存，纯 WS） | 105 B/s | **≈11,900**（留20% ≈9,500） |
| 60 分钟会话 + 冷启动客户端（5.4 MB/新玩家摊薄） | 105 + 1,573 = 1,678 B/s | **≈745** |
| 60 分钟会话，仅 1% 是新玩家 | 105 + 16 = 121 B/s | ≈10,300 |

> 冷启动那笔账是**每新玩家 5.4 MB**（`js` 2.5 MB + `vendor` 2.9 MB，盒子自己发；
> Cloudflare 实测 `cf-cache-status: MISS`，不吃 CF 缓存）。`immutable` 只让**浏览器**缓存一年。
> 所以**并发上限不是瓶颈，新玩家占比才是** —— 详见 `docs/PULL-VS-PUSH.md` §4。

---

## 二、四层，各自独立可关

| 层 | 做什么 | 收益（实测） | 关掉的办法 |
|---|---|---|---|
| **A 传输压缩** | permessage-deflate，跨帧复用字典 | 热流 **9.57×** | `WS_COMPRESSION=off` / `safe` |
| **B 帧瘦身 ③④** | 羁绊按收件人裁剪 + 逐收件人 delta | `m.public` 5.96× raw / 2.91× deflate | 客户端不声明 `hello.pub*` |
| **C 快照节奏** | 球员 20 Hz / 观战 5 Hz；无变化不发帧 | 观战者 −75% 帧 | `SNAPSHOT_EVERY_FAST === SNAPSHOT_EVERY` |
| **D 会话路由** | 重连回到拥有该会话的槽 | 翻槽不断线 | 不设 `SP_ROUTE_DIRECTORY`/`SP_ROUTE_SECRET` |

**A 与 B/C 吃的是同一份跨帧冗余，收益不可相乘**（B 让帧变小，A 让重复变免费）。

---

## 三、只读接口

两条路，**只 GET / HEAD**，其余动词 `405 Allow: GET, HEAD`：

| 路径 | 内容 | Cache-Control |
|---|---|---|
| `/ws-compression/status` | 生效档位、**实际会到线上的选项**（含两个「不声明」项）、可压类型、连接数 | `no-store` |
| `/ws-compression/stats` | 发帧/跳过/字节/被终止的 socket | `no-store` |

约定**逐条抄自** Forge 工坊包的 `routes` 字段（`docs/WORKSHOP.md` §1.9.2）：精确匹配、无重写、
无目录列表、只服务 JSON、`cache` 三选。理由很简单——**同一个想法有两套规则，就是两个会错的地方**。

设计上**没有**任何能改档位的路由：一个能被说服去写东西的只读接口不是只读接口。改档位 = 换启动值重启。

---

## 四、用

```js
import { WebSocketServer } from 'ws';
import { resolveWsCompression, createCompressFilter, describeWsCompression } from 'stronghold-ws-compression';
import { createSender, TransportStats } from 'stronghold-ws-compression/plumbing';
import { createReadonlyRouter } from 'stronghold-ws-compression/readonly';

const mode = process.env.WS_COMPRESSION ?? 'off';
const isCompressible = createCompressFilter();      // 或传你自己的类型集
const stats = new TransportStats();

new WebSocketServer({ port: 3000, perMessageDeflate: resolveWsCompression(mode) });

// 发帧：`compress` 由白名单决定，两个背压护栏在这里
const sender = createSender(socket, { isCompressible, stats });
sender.send(encoded, 'm.public');

// 只读状态（挂在你的 HTTP 路由链最前面）
const readonly = createReadonlyRouter({
  mode, stats, compressibleTypes: ['m.public', 'm.private'],
  describe: describeWsCompression, sockets: () => wss.clients.size,
});
```

三条**必须**遵守的约束（都在 `src/` 的注释里逐条写了原因）：

1. **不要**显式声明 `serverNoContextTakeover: false` 或 `serverMaxWindowBits`。
   `ws` 会把不可接受的协商变成 **HTTP 400 —— 客户端完全连不上**，不是降级。
2. **跳过一帧要在 `ws.send` 之前跳**。上下文保持下，进了 deflate 上下文却没送达的帧会让客户端解压错位，
   之后**整条连接**的帧全坏。`sendFrame` 已按此实现。
3. `threshold` 是**硬开关**：低于它的帧整帧不压。

---

## 五、测试

```bash
npm i ws        # 唯一 peer 依赖
npm test        # 25 项
```

覆盖：档位表、白名单、**协商安全（5 种客户端 offer × 2 档，出 400 即失败）**、只读路由约定。

---

## 六、目录

```
src/wsCompression.mjs      档位 + 选项集 + 白名单（零依赖，可单独用）
src/plumbing.mjs           sendFrame + 连接级统计
src/readonlyRoutes.mjs     只读 HTTP 接口
test/                      25 项
integration/               ③④ / 快照节奏 / 会话路由（与游戏代码耦合，作叠加层）
docs/FORGE-COMPAT.md       与 Forge 工坊包 / mod 管理器的边界
docs/PULL-VS-PUSH.md       拉模式审计（只审计，未实施）
```

`integration/` 是**叠加层**不是完整服务端：覆盖到一份 master-play 检出上，宿主提供
`server/data.js`、`shared/*` 等本来就存在的文件。
