# wei 部署与自动更新链（workers-deploy 分支专属）

`wei.jiangjiangze.icu` = **node 协议兼容网关**（worker/lobby-gateway.js，详见 `审计-APK接入wei-兼容网关.md`）：APK 服务器清单加条目后可直接建房游玩（本地资源+本地设置），网页玩家走上游 main.js 客户端。

- Worker：`stronghold-wei-compat`（Cloudflare 账号见 wrangler.wei-compat.jsonc），域名 custom_domain 绑定。
- 上游：BBleae/Stronghold-Protocol master（他手动跟 sganggs 上游；本仓库不再直接跟 sganggs）。
- 水位：`wei-lineage.json`（已合入的 BBleae SHA）。

## 自动链（.github/workflows/deploy-wei.yml）

schedule 每 6 小时 + 本分支 push 触发：检 BBleae SHA → merge → 门禁（npm ci + worker 全套含网关 e2e）→ `SP_NODE_CLIENT=1` 构建 → `tools/rewrite-cdn-assets.mjs`（assets.json 切 CDN）→ `tools/sync-r2-assets.mjs`（美术同步 R2，顺带治愈与主站镜像的键位漂移）→ `wrangler deploy` → 线上 healthz/CDN 形状验收 → 推进水位并回推分支。门禁失败=红色 run、分支不动。

## 一次性设置（当前缺 CLOUDFLARE_API_TOKEN → deploy 步骤自动跳过）

1. [Cloudflare 控制台 → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) 创建 Token：
   模板 **Edit Cloudflare Workers**（含 Workers Scripts:Edit + Workers States:Write + Zone:Read），作用域=当前账号；建议设有效期并在到期前轮换。
2. 本 fork → Settings → Secrets and variables → Actions → 新增：
   - `CLOUDFLARE_API_TOKEN` = 上面的 Token
   - `CLOUDFLARE_ACCOUNT_ID` = `8641802a2d46497f1cc4e7a4cba365d2`
3. （已就位可复用：`R2_ACCESS_KEY`/`R2_SECRET_KEY` 供素材同步。）

配好后手动 Run workflow 一次即可验证全链；之后无人值守。

## 人工兜底（与 CI 等效）

```powershell
npm ci
$env:SP_NODE_CLIENT='1'; npm run build:worker
node tools/rewrite-cdn-assets.mjs dist/client
node tools/sync-r2-assets.mjs dist/client   # 需 R2_ACCESS_KEY/R2_SECRET_KEY
npx wrangler deploy --config wrangler.wei-compat.jsonc
# 验收: https://wei.jiangjiangze.icu/healthz 应为 {ok,version:1,app:"x.y.z"} 且无 runtime 字段
```

回滚：`stronghold-wei`（Workers 原生 rooms 版）仍在账号中，域名改绑即回房间制（代价=APK 只能走对方网页）。
