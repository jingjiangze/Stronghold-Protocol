# 一键开服（Docker）：自动更新 + 切流不打断

给只想 `docker compose up` 的人。**不含游戏素材**（属第三方版权，需你自己在服上按上游流程获取），
**不含任何云凭据**。静态加速见 `../../docs/静态加速与镜像.md`。

## 快速开始
```bash
git clone -b master https://github.com/sganggs/Stronghold-Protocol.git sp
cp -r sp/tools/auto-docker/docker ./sp-docker && cd sp-docker
docker compose build blue                      # 只打代码，素材不在镜像里
docker compose run --rm make-assets            # 按上游流程取素材到共享卷（可选，视你的素材政策）
docker compose up -d blue front                # 起服务：front 在 :8080
```
浏览器打开 `http://<服务器>:8080/healthz` 应回 `{"ok":true,...}`。

## 换版（这是本套件的核心）
```bash
./update.sh                    # 拉上游 → 判闸门 → 起另一侧 → 自证 → 改一行 upstream.conf → reload → 排空旧侧
```
行为与 Windows 版完全一致的四个闸门：
1. **只有 `server / shared / data / package*.json` 变化才重启**：客户端、shell、文档提交不会打断服务器；
2. **绝不倒退**：版本变小、或目标提交是现网提交的祖先 → 拒绝；
3. **`PROTOCOL_VERSION` 变化不自动上**：写 `ALERT_PROTOCOL_CHANGE.json` + `PAUSE_AUTOUPDATE` 等人决定（蓝绿救不了跨协议号，老客户端会被服务端按版本不匹配拒绝）；
4. **新构建必须自己健康检查通过**才允许接玩家；翻转后 4 秒内复验，不合格自动翻回。

## 为什么"不影响现有玩家"
`blue` 与 `green` 两个服务同时存在，**前端 nginx 用 `nginx/upstream.conf` 里的一行决定新连接进哪侧**。
翻转 = 改那一行 + `nginx -s reload`：reload 只让旧 worker **带着已建立的连接跑到它们自己结束**，
所以正在对局/挂大厅的人不会被换版切断。之后旧侧在 `sockets==0`（连续 60 秒）时才停，
最长等 `DRAIN_TTL_MIN`（默认 45 分钟）。

**做不到、也不假装能做到的**：
- 排空窗口里社区会分成两半（旧人留在旧侧，新人进新侧，互相看不见房间）；45 分钟是上限。
- 旧侧上"挂着未打完、可续跑的单人局"在停止时会丢（房间/对局状态在内存里，没有落盘）。
  要彻底消掉这两条，需要"每局锁定规则版本 + 快照恢复"那套模型，不在这个一键包范围内。
- 上游若把 `PROTOCOL_VERSION` 改了，本包会**停在旧版并通知你**，而不是把玩家踢掉。

## 哨兵文件（放在本目录）
`FORCE` 强制执行一次｜`STAGE_ONLY` 只预发不切流（演练用，零玩家影响）｜`PAUSE_AUTOUPDATE` 完全停用自动更新。

## 定时
```cron
*/10 * * * * cd /srv/sp-docker && ./update.sh >> logs/update.log 2>&1
```
（`PAUSE_AUTOUPDATE` 或已有 `.lock` 时它会自己退出，不会叠加。）
