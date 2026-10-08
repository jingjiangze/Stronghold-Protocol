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
    /** Signed server list (Ed25519). */
    static final String SERVERS_URL = CDN + "/site/servers" + SUFFIX + ".json";
    /** Subtract-only advisor snapshot (unsigned by design; can never add or enable a server). */
    static final String VERIFIED_URL = CDN + "/site/verified" + SUFFIX + ".json";
    /** Production content pointer, owned by the line's release controller. */
    static final String MANIFEST_URL = CDN + "/site/manifest" + SUFFIX + ".json";
    /** In-app APK pointer (versionCode/versionName authority for this line). */
    static final String APK_LATEST_URL = CDN + "/apk/latest" + SUFFIX + ".json";
    /** File-name prefix of this line's APK objects: {@code apk/stronghold-v0.2.1.apk}. */
    static final String APK_NAME_PREFIX = "";

    /**
     * 过渡期遗留的素材前缀（{@code assets-re}）。2026-10-09 统一命名空间之前发布的 APK 内置清单里
     * 全是 {@code /assets-re/…}，仓库里已构建的 webroot 也还带着它；{@code ArtCdn.assetPathOf} 必须
     * 继续认它，否则「本地已可提供」的清单会静默漏项（覆盖门禁少算而不是报错）。等新 APK 全面铺开、
     * 内置清单都换成新前缀后删掉。
     */
    static final String LEGACY_ASSETS_DIR = "assets-re";
}
