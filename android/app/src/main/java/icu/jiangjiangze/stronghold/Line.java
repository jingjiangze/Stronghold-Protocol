package icu.jiangjiangze.stronghold;

/**
 * R2 namespace of this product line.
 *
 * <p>2026-10-08 统一：旧 apk 线退役，两条线并成一条，R2 路径**不带 re 后缀**。合并前两条独立安装
 * 共用一个桶（{@code stronghold-assets}），所以每个共享指针都加了 {@code -re} 后缀，免得一条线的
 * 发布改写另一条的指针（会给对方设备推一个签名不同、装不上的 APK，或一份来自另一棵树的
 * 内容 slim）。旧线退役后后缀去掉，{@code -re} 的对象是过渡期遗留，由 R2 清理任务回收。
 *
 * <p>取值必须与 tools/apk/line.mjs 逐字一致（tools/apk/line.test.mjs 会同时读两处并比对）。
 */
final class Line {

    private Line() {
    }

    /** Suffix applied to every shared pointer name — 合并后为空串，保留常量以便将来再分线。 */
    static final String SUFFIX = "";
    /** R2 public host (the CN-friendly CDN front for the bucket). */
    static final String CDN = "https://weishucdn.jiangjiangze.icu";
    /** Directory (and URL segment) the browser asset tree lives under. */
    static final String ASSETS_DIR = "assets" + SUFFIX;
    /**
     * Asset tree prefix as it appears inside the manifests. The device rewrites this prefix back to
     * the local {@code /assets/} path when it serves the embedded tree.
     */
    static final String ASSETS_CDN_PREFIX = CDN + "/" + ASSETS_DIR + "/";
    /**
     * GitHub-hosted pointers (2026-10-17): the signed server list and the hot-update manifest live on a
     * DEDICATED release tag that is re-uploaded on every publish — the URL never changes, and nothing
     * depends on R2 any more (the owner removed the R2 copies).
     */
    static final String POINTER_BASE =
            "https://github.com/jingjiangze/Stronghold-Protocol/releases/download/manifest";
    /** Signed server list (Ed25519). */
    static final String SERVERS_URL = POINTER_BASE + "/servers.json";
    /** Subtract-only advisor snapshot (unsigned by design; can never add or enable a server). */
    static final String VERIFIED_URL = CDN + "/site/verified" + SUFFIX + ".json";
    /** Production content pointer, owned by the line's release controller. */
    static final String MANIFEST_URL = POINTER_BASE + "/manifest.json";
    /** In-app APK pointer (versionCode/versionName authority for this line). */
    static final String APK_LATEST_URL = CDN + "/apk/latest" + SUFFIX + ".json";
    /** File-name prefix of this line's APK objects: {@code apk/stronghold-v0.2.1.apk}. */
    static final String APK_NAME_PREFIX = "";

    /**
     * 社区服务器清单的 API 根（2026-10-17 业主口径：玩家上传 → **直接进清单**，不设审核队列；有效性
     * 由玩家探测后回报，同一 id 至少 3 个不同客户端一致才算「已验证」）。
     *
     * <p>顺序 = 主源优先，前一个源连不上/没这个路由才用下一个：
     * <ol>
     *   <li>下载站（Cloudflare Pages Functions + D1，最终归属）；</li>
     *   <li>同名 Pages 分支预览 —— 生产还没部署这份 Functions 时的过渡源（`/api/community/list`
     *       在生产上会落到 SPA 外壳、返回 HTML，解析必然失败，所以顺序不能反）。</li>
     * </ol>
     *
     * <p>这份清单**未签名**，所以只做「追加」：{@code ServerList} 把它排在签名条目之后，id/主机与
     * 签名条目撞车的一律丢弃（签名清单永远优先），并且永远不会改写/启用/取消隐藏签名条目。
     */
    static final String[] COMMUNITY_BASES = {
            "https://dl.jiangjiangze.icu/api/community",
            "https://community.stronghold-download.pages.dev/api/community",
    };

    /**
     * 过渡期遗留的素材前缀（{@code assets-re}）。2026-10-09 统一命名空间之前发布的 APK 内置清单里
     * 全是 {@code /assets-re/…}，仓库里已构建的 webroot 也还带着它；{@code ArtCdn.assetPathOf} 必须
     * 继续认它，否则「本地已可提供」的清单会静默漏项（覆盖门禁少算而不是报错）。等新 APK 全面铺开、
     * 内置清单都换成新前缀后删掉。
     */
    static final String LEGACY_ASSETS_DIR = "assets-re";
}
