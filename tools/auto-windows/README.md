# Windows 自动更新部署件（蓝绿双槽）

给在 Windows 上跑 **卫戍协议 / Stronghold Protocol** 服务端的人用：一条命令装好
「后台无窗口 + 每 10 分钟跟上游 + 换版不打断在线玩家」的部署形态。

这个目录（`tools/auto-windows/`）里只有运维脚本与配置模板。**不含游戏素材，不含任何密钥。**

---

## 一、文件

| 文件 | 作用 |
|---|---|
| `config.example.json` | 唯一需要你改的东西：仓库、端口、目录、任务名、轮询间隔、排空 TTL |
| `install.ps1` | 一次性安装：建目录、下 nginx、渲染配置、clone 服务端、注册 5 个计划任务、首跑自检 |
| `sp_update.ps1` | 更新器：判上游 → 预发到空闲槽 → 自证健康 → 改一行 nginx → reload → 排空老槽 |
| `ensure_server.ps1` | 槽感知看护：只拉起「nginx 当前指向的那个槽」；空闲槽**仅在彻底没人时**收掉 |
| `nginx_keep.ps1` / `nginx.conf.template` | nginx 前置与看门狗；`sp_current.conf` 是唯一切流开关 |
| `nginx-perf.ps1` | Windows 专项吞吐补丁（`sendfile` 在 Windows nginx 上没实现 + 小文件 open 缓存）+ 自带回环计时对比 |
| `register-guards.ps1` + `task_guard.ps1` | 给隧道/frpc/房间目录加 5 分钟看护（**这条是被一次真实故障逼出来的**，见第五节）。判活只看「计划任务是否还在 Running / 端口是否还在听 / 进程是否存在」，数进程数量和解析 token 都会误判 |
| `doctor.ps1` | 18 项 PASS/FAIL 自检，任一 FAIL 退出码非 0 |
| `assets-manifest.mjs` | 只产出内容寻址清单（path/size/sha256/…），**不上传任何素材字节** |

## 二、安装

```powershell
# 需要 Node >= 22、Git for Windows；管理员 PowerShell
cd tools/auto-windows
copy config.example.json D:\stronghold\update\config.json
notepad D:\stronghold\update\config.json      # 改 hostname / 目录 / 端口
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File doctor.ps1
```

装完你会得到：槽 A（`3002`）+ 槽 B（`3001`）+ nginx（`8080`，另在 `3000` 上留一个**兼容口**），
以及 `SpNginxInstance / SpNginx / SpServerGuard / SpAutoUpdate / SpDoctor` 五个任务，全部
SYSTEM + 无窗口 + `IgnoreNew`。日志在 `<baseDir>\logs\`。

## 三、换版时"影响玩家"的边界（不写清的话就是骗人）

**已经做到**
- 翻转动作本身不断连接：`nginx -s reload` 期间旧 worker 带着既有连接跑到它们自己结束，
  实测手工持有的一条 WebSocket 全程 `Open`，老槽上的 3–4 条玩家连接也一条没掉。
- 新构建必须先自证：先在空闲端口起进程、`/healthz` 通过，才允许切流；切流后 4 秒内复验，
  不通过就**当场翻回**，不需要人工回滚。
- 只有服务端相关文件变了才重启（默认只看 `server shared data package.json package-lock.json`），
  客户端/shell 的提交不会打断服务器。
- 永不倒退：版本号变小、或目标提交是现网提交的祖先 → 直接拒绝。
- **协议号（`PROTOCOL_VERSION`）变化时拒绝自动上线**并写 `ALERT_PROTOCOL_CHANGE.json` +
  `PAUSE_AUTOUPDATE`。蓝绿救不了跨协议号（服务端会按 `version mismatch` 拒掉老客户端），
  所以这里选择"停在旧版 + 通知你"，代价是你要亲自决定是否连客户端一起升。

**做不到（这套架构的天花板）**
- 排空窗口内社区被切成两半：老玩家留在老槽，新加入的进新槽，两边互相看不见房间。
  默认 `drainTtlMinutes=45` 就是"最长分裂时长"，实测挂机/常驻局多时**22 分钟都排不空**，
  所以这个值几乎总是靠 TTL 兜底。想快就调小，想稳就调大，没有免费的选项。
- 老槽退役时，它上面"挂着未打完、可续跑的单人局"会丢（状态全内存，重连窗 24h）。
- 无法"先关门再翻闸"： Lobby 的上限是代码里的常量、没有环境变量开关，所以只能翻闸后等自然清空。

## 四、素材与许可（重要）

- 上游是 GPL-3.0，本目录脚本随其发布请保留上游 LICENSE / NOTICE 出处。
- `public/assets`、`public/fonts`、`data/local-assets.json` 是**第三方游戏版权素材**，上游
  `.gitignore` 明确 "NEVER committed"。本件**不包含素材，也不会把素材推到任何公开桶/镜像**；
  每个服各自用 `npm run assets` / `tools/fetch-assets.mjs` 本地获取。
- 想要"加速首屏"的正道只有两条，都不涉及分发素材：
  1) 让边缘缓存真正生效（自己域名的 Cache Rule / 边缘 TTL），
  2) 把**程序包**（APK、服务端压缩包）放镜像 —— 那是你自己的作品。
  `assets-manifest.mjs` 就是为第 2 条准备的可校验清单。

## 五、两条真实教训（都写进了脚本行为里）

1. **连接器必须有看护**。一次线上不可用（Cloudflare 报 1033）的根因是 cloudflared 收到
   `signal terminated` 后退出，而启动它的计划任务只有开机触发 —— 几小时没人把它拉回来。
   `register-guards.ps1` 就是补这个；同一台机上如果别人的看护会批量重启 cloudflared，
   **不要把自己的可用性寄托在别人的隧道上**。
2. **配置文件里写路径要用正斜杠**。`"dir": "D:\stronghold\..."` 里的 `\s` 不是合法 JSON 转义，
   会让更新器"启动第一件事就崩"，而且现场看起来像"没在更新"。本件生成的 JSON 一律正斜杠。

## 六、演练与紧急开关

| 放一个这个文件到 `<updateDir>` | 效果 |
|---|---|
| `FORCE` | 忽略"已是最新/无服务端改动"，强制走完整换版 |
| `STAGE_ONLY` | 只预发到空闲槽并自证，**不切流**（升级前想验证就用它，零玩家影响） |
| `PAUSE_AUTOUPDATE` | 自动更新完全停摆（更新器自己撞到协议号变化时也会建这个） |
| `.lock` | 存在且 <90 分钟 = 有更新在跑，看护会避让 |
