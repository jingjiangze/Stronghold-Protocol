package icu.jiangjiangze.stronghold;

/**
 * R2 namespace of this product line (the re-apk line, 2026-10-07).
 *
 * <p>The apk line and the re-apk line are independent installs that share one R2 bucket
 * ({@code stronghold-assets}). Every pointer is therefore namespaced with {@code -re}: the content
 * manifest, the in-app APK pointer, the browser asset tree and the signed server list. Without the
 * suffix a re-apk publish would rewrite the apk line's pointers — and, worse, a re-apk device would
 * be offered the apk line's content slims, which are built from a different tree (different
 * patches/extras), or an APK signed with a key it cannot install over.
 *
 * <p>The apk branch keeps the un-suffixed names in its own copy of this file. The two must never be
 * "harmonised": the suffix is the whole point.
 */
final class Line {

    private Line() {
    }

    /** Suffix applied to every shared pointer name ({@code apk/latest-re.json}, …). */
    static final String SUFFIX = "-re";
    /** R2 public host (the CN-friendly CDN front for the bucket). */
    static final String CDN = "https://weishucdn.jiangjiangze.icu";
    /**
     * Asset tree prefix as it appears inside the manifests. The re line ships WebP, the apk line
     * PNG, so the two trees are separate directories. The device rewrites this prefix back to the
     * local {@code /assets/} path when it serves the embedded tree.
     */
    static final String ASSETS_CDN_PREFIX = CDN + "/assets" + SUFFIX + "/";
    /** Signed server list (Ed25519) — the re line publishes its own, the shared copy is a fallback. */
    static final String SERVERS_URL = CDN + "/site/servers" + SUFFIX + ".json";
    /** Subtract-only advisor snapshot (unsigned by design; can never add or enable a server). */
    static final String VERIFIED_URL = CDN + "/site/verified" + SUFFIX + ".json";
    /** Production content pointer, owned by the line's release controller. */
    static final String MANIFEST_URL = CDN + "/site/manifest" + SUFFIX + ".json";
    /** In-app APK pointer (versionCode/versionName authority for this line). */
    static final String APK_LATEST_URL = CDN + "/apk/latest" + SUFFIX + ".json";
    /** File-name prefix of this line's APK objects: {@code apk/re-stronghold-v0.1.4.apk}. */
    static final String APK_NAME_PREFIX = "re-";
}
