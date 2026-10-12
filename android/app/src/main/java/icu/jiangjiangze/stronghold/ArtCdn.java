package icu.jiangjiangze.stronghold;

import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Pure logic for the "no embedded assets" fallback (P0, 2026-10-08): when a page asks for
 * {@code /assets/**} and neither the local tree ({@code filesDir/webroot}) nor the APK carries the
 * file, {@link MainActivity} re-fetches it from the configured CDN base and caches it under
 * {@code filesDir/art/cache/} — then serves it SAME-ORIGIN (a cross-origin image taints the canvas;
 * see 方案-静态资源热更新-2026-10-08.md §6.3).
 *
 * <p>Everything here is pure (no Android, no IO) so it can be unit-tested with plain javac — see
 * {@code tools/apk/jvm/ArtCdnCheck.java}. The class owns three decisions:
 * <ul>
 *   <li>{@link #isAllowedHost(String)} — the request host must be one of OUR configured CDN/mirror
 *       hosts, and must never be localhost / loopback / private / reserved (any IPv4 notation,
 *       IPv6, ULA, link-local). This is what stops the fallback from becoming an open proxy.</li>
 *   <li>{@link #cdnUrlFor(String)} — {@code /assets/<rel>} → {@code <Line.ASSETS_CDN_PREFIX><rel>}
 *       (the CDN base is never re-typed here: it is {@link Line#ASSETS_CDN_PREFIX}).</li>
 *   <li>{@link #cacheRelPath(String, String)} — {@code /assets/<rel>} →
 *       {@code art/cache/<manifest hash>/assets/<rel>}, rejecting traversal so a crafted path can
 *       never escape the cache directory. The hash namespace is what makes a republished image at
 *       the SAME path invalidate on device.</li>
 *   <li>{@link #pickAdoptable(String, java.util.List)} / {@link #pruneRank(String, String)} — the
 *       namespace is a *release* identity, not a content identity (the hash is re-emitted over the
 *       referenced bytes on every release), so a changed hash must not orphan the bytes: the old
 *       namespace directory is adopted (renamed) onto the new one, and pruning evicts foreign
 *       namespaces first.</li>
 *   <li>{@link #isPrefetchRequest(java.util.Map)} — the background prefetch is marked (see
 *       {@link #PREFETCH_HEADER}) so the page's own requests keep CDN priority.</li>
 * </ul>
 *
 * <p>信任分级（不引入第二个信任根）：这里只决定「去哪个 host 取、落到哪个路径」。取回的字节没有
 * 逐文件哈希可验（上游 data/assets.json 只有顶层元数据 hash，没有 per-file sha256），因此这层是
 * 明确较低信任的 best-effort 缓存；签名字节只走 {@link ArtStore} 的 pack 通道。
 */
public final class ArtCdn {

    private ArtCdn() {
    }

    /**
     * Directory under {@code filesDir} that holds the re-fetched art. Deliberately INSIDE
     * {@link ArtStore}'s art root ({@code filesDir/art}) so all art lives under one directory;
     * {@code ArtStore} itself only ever enumerates {@code art/packs/}, so the SIGNED packs and this
     * fetched (unsigned, best-effort) cache never mix — and one "clear art" action can drop both.
     */
    public static final String CACHE_DIR = "art/cache";

    /**
     * Process-wide counter set for the fetched-art cache (feat/art-cache-status): the real file/byte
     * counts of {@code art/cache/<manifest hash>/}, kept O(1) so {@code ShellBridge.artCacheStatus()}
     * never walks the tree. The arithmetic/persistence/scan live in the pure, Android-free
     * {@link ArtCacheStats} (JVM-testable); this class owns the single live instance because it also
     * owns the cache layout the counters describe.
     */
    private static final ArtCacheStats CACHE_STATS = new ArtCacheStats();

    /** The live fetched-art cache counters (see {@link ArtCacheStats}). */
    public static ArtCacheStats cacheStats() {
        return CACHE_STATS;
    }

    /** Path prefix of the assets the page requests same-origin (the manifests are de-CDN'd to this). */
    public static final String ASSET_PREFIX = "/assets/";

    /**
     * Request header {@code art-prefetch.js} marks its background fetches with. The interceptor uses
     * it to keep the prefetch OUT of the page's way: a marked request only ever takes a CDN slot
     * when the page is not asking for one, so a cold-cache prefetch can never starve a live screen
     * into {@code artPlaceholder()} (the 2026-10-08 field report: blank bond icons at 970/7969).
     */
    public static final String PREFETCH_HEADER = "X-SP-Prefetch";

    /**
     * Cache namespace used when the manifest carries no usable {@code hash}. Never fail the cache
     * just because the field is missing — {@code v0} still works (it just never auto-invalidates).
     */
    public static final String FALLBACK_HASH = "v0";

    /**
     * Hosts allowed to serve art for the fallback. Derived from the line's own constants so the
     * namespace stays in one place; {@code jingjiangze.github.io} is the Pages mirror the existing
     * {@code isAssetCdnHost()} accepts, {@code dl.jiangjiangze.icu} is the box mirror the build uses.
     */
    private static final Set<String> ALLOWED_HOSTS = buildAllowedHosts();

    private static Set<String> buildAllowedHosts() {
        Set<String> s = new HashSet<>();
        s.add(hostOf(Line.CDN));
        s.add(hostOf(Line.ASSETS_CDN_PREFIX));
        s.add("jingjiangze.github.io");
        s.add("dl.jiangjiangze.icu");
        s.remove("");
        return Collections.unmodifiableSet(s);
    }

    /** Allowed hosts (diagnostics/tests only). */
    public static Set<String> allowedHosts() {
        return ALLOWED_HOSTS;
    }

    /** Host of a URL, lowercased, or "" when it cannot be parsed. */
    public static String hostOf(String url) {
        if (url == null) return "";
        try {
            String h = new java.net.URL(url).getHost();
            return h == null ? "" : h.toLowerCase(Locale.ROOT);
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * True only for our configured CDN/mirror hosts. Fail-closed: null/empty, anything private or
     * reserved, and any host not in the allowlist returns false. An attacker-controlled host can
     * therefore never be reached through the /assets fallback.
     */
    public static boolean isAllowedHost(String host) {
        if (host == null) return false;
        String h = host.trim().toLowerCase(Locale.ROOT);
        if (h.startsWith("[") && h.endsWith("]") && h.length() > 2) h = h.substring(1, h.length() - 1);
        while (h.endsWith(".")) h = h.substring(0, h.length() - 1);
        if (h.isEmpty()) return false;
        if (isBlockedLiteral(h)) return false;
        return ALLOWED_HOSTS.contains(h);
    }

    /**
     * True when the host is a literal address (or name) that must never be fetched: localhost,
     * loopback / private / reserved IPv4 in ANY notation (dotted, octal, hex, single-integer),
     * and IPv6 loopback / ULA / link-local / multicast / IPv4-mapped.
     */
    public static boolean isBlockedLiteral(String host) {
        if (host == null) return true;
        String h = host.trim().toLowerCase(Locale.ROOT);
        if (h.startsWith("[") && h.endsWith("]") && h.length() > 2) h = h.substring(1, h.length() - 1);
        while (h.endsWith(".")) h = h.substring(0, h.length() - 1);
        if (h.isEmpty()) return true;
        if (h.equals("localhost") || h.endsWith(".localhost")) return true;
        if (h.indexOf(':') >= 0) return isBlockedIpv6(h);
        Long ip = parseIpv4(h);
        return ip != null && isBlockedIpv4(ip.longValue());
    }

    /** {@code /assets/<rel>} → the CDN URL; null when the path is not a servable asset path. */
    public static String cdnUrlFor(String assetPath) {
        if (assetPath == null || !assetPath.startsWith(ASSET_PREFIX)) return null;
        String rel = assetPath.substring(ASSET_PREFIX.length());
        if (!isSafeRel(rel)) return null;
        String base = Line.ASSETS_CDN_PREFIX;
        if (!base.endsWith("/")) base = base + "/";
        return base + rel;
    }

    /**
     * Sanitises a manifest {@code hash} into one safe path segment. Empty / over-long / any
     * non-alphanumeric-dash-underscore value collapses to {@link #FALLBACK_HASH}, so a hostile or
     * malformed manifest can never escape {@code art/cache/}.
     */
    public static String safeHash(String hash) {
        if (hash == null) return FALLBACK_HASH;
        String h = hash.trim();
        if (h.isEmpty() || h.length() > 64) return FALLBACK_HASH;
        for (int i = 0; i < h.length(); i++) {
            char c = h.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '_';
            if (!ok) return FALLBACK_HASH;
        }
        return h;
    }

    /**
     * Cache root for a manifest hash: {@code art/cache/<hash>}. Namespacing by the manifest's own
     * {@code hash} is what makes "replace one image, republish" take effect on device: a changed
     * asset set changes the hash, so every lookup lands in a fresh directory (cache miss → re-fetch)
     * even though the asset PATH is unchanged.
     */
    public static String cacheRootForHash(String manifestHash) {
        return CACHE_DIR + "/" + safeHash(manifestHash);
    }

    /**
     * {@code /assets/<rel>} → {@code art/cache/<hash>/assets/<rel>}; null for anything else/unsafe.
     */
    public static String cacheRelPath(String manifestHash, String assetPath) {
        if (assetPath == null || !assetPath.startsWith(ASSET_PREFIX)) return null;
        String rel = assetPath.substring(1); // drop the leading '/': "assets/<rel>"
        if (!isSafeRel(rel)) return null;
        return cacheRootForHash(manifestHash) + "/" + rel;
    }

    /**
     * **请求路径** → 素材的规范键 {@code /assets/<rel>}（P2，业主口径 2026-10-10「所有服务器都能取
     * 缓存」）：{@code /assets/<rel>} 原样，过渡期 {@code /assets-re/<rel>} 映射到规范形式，其它路径
     * 返回 null。两种 URL 形状因此共用**一条**缓存槽（字节同一份），取回时仍用请求原路径（服务器
     * 在哪个路径上提供字节就在哪个路径取，绝不替它做别名假设）。
     *
     * <p>与 {@link #assetPathOf(String)} 的区别：那是给**清单里的值**用的（可能是完整 URL，靠
     * {@code indexOf} 找 {@code /assets/}）；这里是给**请求路径**用的 —— 只认前缀，`/foo/assets/x`
     * 这类嵌在中间的同名段绝不会被当成素材路径。空 rel、尾斜杠、{@code .}/{@code ..}/空段一律 null。
     */
    public static String assetKeyOf(String path) {
        if (path == null) return null;
        String rel;
        if (path.startsWith(ASSET_PREFIX)) {
            rel = path.substring(ASSET_PREFIX.length());
        } else if (path.startsWith("/" + Line.LEGACY_ASSETS_DIR + "/")) {
            rel = path.substring(Line.LEGACY_ASSETS_DIR.length() + 2);
        } else {
            return null;
        }
        return isSafeRel(rel) ? ASSET_PREFIX + rel : null;
    }

    /**
     * {@code /assets/<rel>} → {@code art/cache/<hash>/srv-<serverKey>-<cfgVersion>/assets/<rel>}：
     * 「服务器自己提供的素材」的缓存槽，与 CDN 槽**分开**，理由有二：
     * <ul>
     *   <li>不同服务器可能有同名但内容不同的私有素材——共用槽会互相覆盖（A 服的图出现在 B 服）；</li>
     *   <li>服务器的私有素材没有「清单 hash 变了就自动失效」这条链（它不参与构建期重算），所以把
     *       服务器配置的 {@code version} 编进槽名——服务器改素材时顺手抬 version 即可让设备失效重取。</li>
     * </ul>
     * 与 CDN 槽同属 {@code art/cache/} 之下，因此「清除素材缓存」一次能清两处。
     */
    public static String serverCacheRelPath(String manifestHash, String serverKey, int cfgVersion, String assetPath) {
        if (assetPath == null || !assetPath.startsWith(ASSET_PREFIX)) return null;
        String rel = assetPath.substring(1);
        if (!isSafeRel(rel)) return null;
        String key = safeHash(serverKey);
        return cacheRootForHash(manifestHash) + "/srv-" + key + "-" + Math.max(0, cfgVersion) + "/" + rel;
    }

    /**
     * True when {@code name} is a usable {@code art/cache/<name>} namespace segment: non-empty, at
     * most 64 chars, alphanumeric/dash/underscore only — i.e. it equals its own {@link #safeHash}.
     * Rejects {@code .}/{@code ..}/separators/absolute-ish names by construction.
     */
    public static boolean isValidNamespace(String name) {
        return name != null && !name.isEmpty() && safeHash(name).equals(name);
    }

    /**
     * The namespace segment of a path relative to {@code art/cache} ({@code <ns>/assets/…}); null
     * when the path is empty, starts with a slash or its first segment is not a valid namespace.
     */
    public static String namespaceOf(String relFromCacheDir) {
        if (relFromCacheDir == null || relFromCacheDir.isEmpty()) return null;
        String rel = relFromCacheDir.replace('\\', '/');
        while (rel.startsWith("/")) rel = rel.substring(1);
        int i = rel.indexOf('/');
        if (i <= 0) return null;
        String ns = rel.substring(0, i);
        return isValidNamespace(ns) ? ns : null;
    }

    /**
     * Pruning priority inside {@code art/cache}: {@code 0} (evict first) for anything that is NOT
     * the active namespace — the orphaned namespaces a manifest-hash change leaves behind, plus any
     * unrecognised entry — and {@code 1} for the active one. The cap may therefore never delete the
     * art the page is using while dead bytes from an older namespace still occupy space (that
     * deletion is what turned a hash change into an endless re-download / re-verify loop).
     */
    public static int pruneRank(String relFromCacheDir, String currentHash) {
        String ns = namespaceOf(relFromCacheDir);
        return ns != null && ns.equals(safeHash(currentHash)) ? 1 : 0;
    }

    /**
     * The namespace directory to adopt as the new namespace's predecessor, or null when there is
     * nothing safe to adopt (that is the only case in which the cached bytes are orphaned).
     *
     * <p>WHY: {@code data/assets.json}'s top-level {@code hash} is re-emitted from the referenced
     * bytes on every content release ({@code tools/apk/transcode-assets.mjs hashReferencedBytes}), so
     * an unrelated manifest edit changes it while the referenced art keeps byte-identical paths and
     * bytes. Since the namespace is that hash, a content update would otherwise orphan 100 % of the
     * device's fetched art at once and re-download it all. The caller renames the predecessor
     * directory onto the new namespace — the same files, the same paths, no re-fetch.
     *
     * @param currentHash         the namespace in use now (already sanitised by {@link #safeHash})
     * @param namesNewestFirst    existing namespace dir names, most recently modified first
     */
    public static String pickAdoptable(String currentHash, java.util.List<String> namesNewestFirst) {
        if (namesNewestFirst == null || namesNewestFirst.isEmpty()) return null;
        String current = safeHash(currentHash);
        for (String name : namesNewestFirst) {
            if (!isValidNamespace(name)) continue; // traversal/junk entries are never adopted
            if (name.equals(current)) continue;    // the current namespace is not its own predecessor
            return name;
        }
        return null;
    }

    /**
     * The page's own fetches must win: true when the request carries {@link #PREFETCH_HEADER}
     * (a non-empty, non-"0" value). Header names are compared case-insensitively because WebView
     * does not normalise the casing for us. An absent header (any other client, a proxy that strips
     * it, an older overlay) is simply an ordinary page request — the fallback stays conservative.
     */
    public static boolean isPrefetchRequest(java.util.Map<String, String> headers) {
        if (headers == null || headers.isEmpty()) return false;
        for (java.util.Map.Entry<String, String> e : headers.entrySet()) {
            if (e.getKey() == null || e.getValue() == null) continue;
            if (!PREFETCH_HEADER.equalsIgnoreCase(e.getKey().trim())) continue;
            String v = e.getValue().trim();
            return !v.isEmpty() && !"0".equals(v) && !"false".equalsIgnoreCase(v);
        }
        return false;
    }

    /**
     * Response headers of the "this asset is genuinely not available" placeholder. {@code no-store}
     * is the load-bearing one: a placeholder that reached the WebView's HTTP cache would outlive the
     * fetch that later succeeds, i.e. a blank icon would survive reloads even after the asset
     * arrived. The response is also same-origin readable ({@code *}) so a canvas draw of a missing
     * image cannot taint the page.
     *
     * <p>{@link #PLACEHOLDER_HEADER} is the internal status the audit asked for (2026-10-09 §2 D2):
     * the placeholder is a {@code 200} on purpose (an {@code <img>} must not cascade broken-image
     * errors), so without a marker the page's prefetch cannot tell "here are the real bytes" from
     * "here is the transparent 1x1 stand-in" and counts a missing asset as a successful preload.
     */
    public static java.util.Map<String, String> placeholderHeaders() {
        java.util.Map<String, String> headers = new java.util.HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put(PLACEHOLDER_HEADER, "1");
        return headers;
    }

    /**
     * Marks a {@code 200} as "the placeholder, not the asset". Read by {@code art-prefetch.js}
     * ({@code classify()}): a marked response is TRANSIENT — it must not be counted as a settlement
     * and the path must stay owed, so the next session (or a later retry) can still obtain it.
     */
    public static final String PLACEHOLDER_HEADER = "X-SP-Art-Placeholder";

    // ---------------------------------------------------------------- 逐文件摘要（阶段 1 方案 1）

    /** 逐文件摘要表的路径（webroot 下）：{@code {"version":1,"hash":"…","digests":{"<rel>":"<sha256>"}}}。 */
    public static final String DIGEST_PATH = "/data/asset-digests.json";

    /**
     * {@code /assets/<rel>} → 摘要表的键（{@code <rel>}，**不带** {@code /assets/} 前缀，与构建侧的
     * {@code writeAssetDigests} 一致）；不是安全的 assets 路径返回 null。
     */
    public static String digestKey(String assetPath) {
        if (assetPath == null || !assetPath.startsWith(ASSET_PREFIX)) return null;
        String rel = assetPath.substring(ASSET_PREFIX.length());
        return isSafeRel(rel) ? rel : null;
    }

    /** 64 位十六进制的 sha256 形态；坏清单里的垃圾值不许当摘要用。 */
    public static boolean isValidDigest(String digest) {
        if (digest == null || digest.length() != 64) return false;
        for (int i = 0; i < 64; i++) {
            char c = digest.charAt(i);
            boolean hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
            if (!hex) return false;
        }
        return true;
    }

    /** 摘要一致（大小写不敏感）。任一侧缺失/非法 → false：**宁重下不误信**。 */
    public static boolean digestMatches(String expected, String actual) {
        if (!isValidDigest(expected) || !isValidDigest(actual)) return false;
        return expected.equalsIgnoreCase(actual);
    }

    /**
     * 摘要表能不能用来校验：表里的 {@code hash} 必须与当前清单 hash 一致（旧内容包配新清单 = 不可用）。
     * 表缺失/为空/哈希不符 → false，调用方据此**不采纳**旧命名空间（「无逐文件摘要证据时不得假定字节未变」）。
     */
    public static boolean digestsUsableFor(String manifestHash, String digestsHash, int count) {
        if (manifestHash == null || manifestHash.isEmpty()) return false;
        if (digestsHash == null || !digestsHash.equals(safeHash(manifestHash))) return false;
        return count > 0;
    }

    // ---------------------------------------------------------------- 集合身份键（方向 A，2026-10-10）

    /**
     * 集合身份键（owner 2026-10-10 方向 A）：{@code sha1(JSON.stringify(sorted(rels))).slice(0,12)}，
     * 与构建侧 {@code transcode-assets.mjs setKeyForRels}、页面侧 {@code art-prefetch.js} 三方逐字节
     * 一致（算法一致性由 {@code ArtCdnCheck} 与 {@code transcode-assets.test.mjs} 的同一组向量钉住）。
     *
     * <p>为什么不用清单顶层 {@code hash}：那个 hash 由**各自的生成器按各自的配方**算（我方是「被引用
     * 字节」的内容哈希，上游/第三方是清单 JSON 正文的哈希），所以同一套素材在不同服的清单里 hash 必然
     * 不同 —— 切服 = 换 hash = 换命名空间 = 全量重下。集合身份只随**引用路径集合**变：两台服跑同一上游
     * 版本 ⇒ 集合相同 ⇒ 同键 ⇒ 直接命中，零配合。
     */
    public static String setKeyForRels(java.util.Collection<String> rels) {
        java.util.TreeSet<String> sorted = new java.util.TreeSet<>();
        if (rels != null) for (String r : rels) if (r != null) sorted.add(r);
        StringBuilder sb = new StringBuilder(sorted.size() * 24 + 2);
        sb.append('[');
        boolean first = true;
        for (String r : sorted) {
            if (!first) sb.append(',');
            first = false;
            jsonString(sb, r);
        }
        sb.append(']');
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-1");
            byte[] d = md.digest(sb.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(40);
            for (byte b : d) hex.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
            return hex.substring(0, 12);
        } catch (Exception e) {
            return FALLBACK_HASH; // SHA-1 always exists on the JDK/ART; never fail the cache over it
        }
    }

    /**
     * Appends a JSON string literal exactly as {@code JSON.stringify} would for the ASCII asset rels
     * (and the general case too): the double quote and backslash escaped, C0 controls as the short
     * forms or a four-hex escape. Non-ASCII is emitted raw (UTF-8), matching JS.
     */
    static void jsonString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\t': sb.append("\\t"); break;
                case '\n': sb.append("\\n"); break;
                case '\f': sb.append("\\f"); break;
                case '\r': sb.append("\\r"); break;
                default:
                    if (c < 0x20) sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
    }

    /** The asset-ref grammar shared with the build/JS: {@code /(assets|assets-re)/<rel>"}. */
    private static final java.util.regex.Pattern ASSET_REF_RE = java.util.regex.Pattern.compile(
            "/(?:" + java.util.regex.Pattern.quote(Line.ASSETS_DIR) + "|"
                    + java.util.regex.Pattern.quote(Line.LEGACY_ASSETS_DIR) + ")/([^\"\\\\]+)\"");

    /**
     * Every referenced asset rel in a manifest text, deduped + sorted (JS default order == TreeSet
     * natural order for these ASCII paths). Mirrors {@code transcode-assets.mjs referencedAssetRels}
     * and {@code art-prefetch.js collect+toLocalPath} for the same document.
     */
    public static java.util.List<String> referencedAssetRels(String manifestText) {
        java.util.TreeSet<String> seen = new java.util.TreeSet<>();
        if (manifestText != null) {
            java.util.regex.Matcher m = ASSET_REF_RE.matcher(manifestText);
            while (m.find()) seen.add(m.group(1));
        }
        return new java.util.ArrayList<>(seen);
    }

    /** The set-identity key of a manifest document (see {@link #setKeyForRels}). */
    public static String setKeyOfManifest(String manifestText) {
        return setKeyForRels(referencedAssetRels(manifestText));
    }

    /**
     * 摘要表能不能用于**当前集合身份**：表里的 {@code setKey} 必须等于当前 setKey（表描述的是别的
     * 集合 → 不可用）。表缺失/为空/键不符 → false，调用方据此不采纳旧命名空间。
     */
    public static boolean digestsUsableForSetKey(String currentSetKey, String tableSetKey, int count) {
        if (currentSetKey == null || currentSetKey.isEmpty()) return false;
        if (tableSetKey == null || !tableSetKey.equals(safeHash(currentSetKey))) return false;
        return count > 0;
    }

    // ---------------------------------------------------------------- 合并验证语义（方向 B/C）

    /** 没有证据：不得采纳（宁重下不误信）。 */
    public static final int MERGE_NO_EVIDENCE = 0;
    /** 证据不符：字节与期望摘要不同 → 不采纳、留在原处。 */
    public static final int MERGE_MISMATCH = 1;
    /** 证据相符：可 move 进当前命名空间。 */
    public static final int MERGE_OK = 2;

    /**
     * 逐文件合并裁决：期望摘要缺失/非法 → {@link #MERGE_NO_EVIDENCE}；实际摘要缺失/非法或与期望不同
     * → {@link #MERGE_MISMATCH}；两侧都是合法 sha256 且相等 → {@link #MERGE_OK}。调用方只在
     * {@code MERGE_OK} 时才把文件 move 进当前命名空间，其余一律留在原处不删。
     */
    public static int mergeVerdict(String expectedSha, String actualSha) {
        if (!isValidDigest(expectedSha)) return MERGE_NO_EVIDENCE;
        if (!isValidDigest(actualSha)) return MERGE_MISMATCH;
        return expectedSha.equalsIgnoreCase(actualSha) ? MERGE_OK : MERGE_MISMATCH;
    }

    /**
     * 采纳时用哪份证据做逐文件校验（owner 2026-10-10 方向 C 的顺序）：
     * <ol>
     *   <li>我方随包发的 {@code data/asset-digests.json} —— 当它的 {@code setKey} 等于当前集合身份；</li>
     *   <li>否则，源命名空间自己的 sidecar（{@link #SIDECAR_NAME}）—— 我们自己取回时记下的逐文件证据，
     *       第三方服从第二次交互起就有；</li>
     *   <li>都没有 → {@code null}（不采纳）。</li>
     * </ol>
     * 返回的 map 是 {@code rel → sha256}。只读参数，不修改入参。
     */
    public static java.util.Map<String, String> pickEvidence(String currentSetKey, String tableSetKey,
                                                             java.util.Map<String, String> tableDigests,
                                                             java.util.Map<String, String> sidecarDigests) {
        if (tableDigests != null && !tableDigests.isEmpty()
                && currentSetKey != null && currentSetKey.equals(safeHash(tableSetKey))) {
            return tableDigests;
        }
        if (sidecarDigests != null && !sidecarDigests.isEmpty()) return sidecarDigests;
        return null;
    }

    // ---------------------------------------------------------------- 命名空间 sidecar（方向 C）

    /** 命名空间侧车（逐文件证据）文件名，直接位于 {@code art/cache/<ns>/} 下；以 '.' 开头，统计不计。 */
    public static final String SIDECAR_NAME = ".sp-digests.json";

    /** sidecar 的解析结果（{@link #parseSidecar}）；digests 只含合法 sha256 值。 */
    public static final class Sidecar {
        public final String setKey;
        public final String byteHash;
        public final java.util.Map<String, String> digests;

        Sidecar(String setKey, String byteHash, java.util.Map<String, String> digests) {
            this.setKey = setKey;
            this.byteHash = byteHash;
            this.digests = digests;
        }
    }

    /** 序列化 sidecar（键排序，稳定字节）：{@code {"v":1,"setKey":…,"byteHash":…,"digests":{rel:sha}}}。 */
    public static String sidecarJson(String setKey, String byteHash, java.util.Map<String, String> digests) {
        StringBuilder sb = new StringBuilder(64 + (digests == null ? 0 : digests.size() * 80));
        sb.append("{\"v\":1,\"setKey\":");
        jsonString(sb, setKey == null ? "" : setKey);
        sb.append(",\"byteHash\":");
        jsonString(sb, byteHash == null ? "" : byteHash);
        sb.append(",\"digests\":{");
        if (digests != null) {
            java.util.TreeMap<String, String> sorted = new java.util.TreeMap<>(digests);
            boolean first = true;
            for (java.util.Map.Entry<String, String> e : sorted.entrySet()) {
                if (!isSafeRel(e.getKey()) || !isValidDigest(e.getValue())) continue;
                if (!first) sb.append(',');
                first = false;
                jsonString(sb, e.getKey());
                sb.append(':');
                jsonString(sb, e.getValue());
            }
        }
        sb.append("}}");
        return sb.toString();
    }

    /**
     * 解析我们自己写的 sidecar。格式固定、值全是安全 rel / 十六进制，故用手写扫描（不引入 org.json，
     * 保持本类零 Android 依赖、可 JVM 直测）。任何畸形输入返回 null 或跳过坏键，绝不抛。
     */
    public static Sidecar parseSidecar(String text) {
        if (text == null) return null;
        String setKey = jsonField(text, "setKey");
        String byteHash = jsonField(text, "byteHash");
        int di = text.indexOf("\"digests\"");
        if (di < 0) return null;
        int ob = text.indexOf('{', di + 9);
        if (ob < 0) return null;
        int end = matchBrace(text, ob);
        if (end < 0) return null;
        java.util.Map<String, String> digests = new java.util.HashMap<>();
        String body = text.substring(ob + 1, end);
        int i = 0;
        while (i < body.length()) {
            int k0 = body.indexOf('"', i);
            if (k0 < 0) break;
            Str key = readJsonString(body, k0);
            if (key == null) break;
            int colon = body.indexOf(':', key.next);
            if (colon < 0) break;
            int v0 = body.indexOf('"', colon + 1);
            if (v0 < 0) break;
            Str val = readJsonString(body, v0);
            if (val == null) break;
            if (isSafeRel(key.value) && isValidDigest(val.value)) digests.put(key.value, val.value);
            i = val.next;
        }
        return new Sidecar(setKey, byteHash, digests);
    }

    /** Index of the {@code }} matching the {@code {} at {@code open}, or -1 (string literals skipped). */
    private static int matchBrace(String s, int open) {
        int depth = 0;
        for (int i = open; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"') {
                Str lit = readJsonString(s, i);
                if (lit == null) return -1;
                i = lit.next - 1;
                continue;
            }
            if (c == '{') depth++;
            else if (c == '}') { depth--; if (depth == 0) return i; }
        }
        return -1;
    }

    /** Reads {@code "name":"value"} from a JSON text (first occurrence); "" when absent. */
    private static String jsonField(String text, String name) {
        int i = text.indexOf("\"" + name + "\"");
        if (i < 0) return "";
        int colon = text.indexOf(':', i + name.length() + 2);
        if (colon < 0) return "";
        int q = text.indexOf('"', colon + 1);
        if (q < 0) return "";
        Str r = readJsonString(text, q);
        return r == null ? "" : r.value;
    }

    /** A JSON string literal plus the index one past its closing quote. */
    static final class Str {
        final String value;
        final int next;

        Str(String value, int next) {
            this.value = value;
            this.next = next;
        }
    }

    /**
     * Reads the JSON string literal starting at {@code quote} (which must be a {@code "}).
     * Returns null when the text is not a well-formed literal at that index.
     */
    static Str readJsonString(String s, int quote) {
        if (s == null || quote < 0 || quote >= s.length() || s.charAt(quote) != '"') return null;
        StringBuilder sb = new StringBuilder();
        int i = quote + 1;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c == '"') return new Str(sb.toString(), i + 1);
            if (c == '\\' && i + 1 < s.length()) {
                char e = s.charAt(++i);
                switch (e) {
                    case '"': sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    case '/': sb.append('/'); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case 'n': sb.append('\n'); break;
                    case 'r': sb.append('\r'); break;
                    case 't': sb.append('\t'); break;
                    case 'u':
                        if (i + 4 < s.length()) {
                            try { sb.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16)); i += 4; }
                            catch (NumberFormatException ignored) { }
                        }
                        break;
                    default: sb.append(e);
                }
            } else {
                sb.append(c);
            }
            i++;
        }
        return null;
    }

    // ---------------------------------------------------------------- 错误分类（一个表，两处用）

    /**
     * 明确的「这个路径不存在」——只有 **404 / 410** 算永久缺失，才允许记进 {@code ART_MISS_TTL_MS}
     * 的进程内记忆。
     *
     * <p>408（Request Timeout）/ 425（Too Early）/ 429（Too Many Requests）虽然也是 4xx，但它们是
     * **暂态**：CDN 限流或抖动时把它们记成「这个素材不存在」，会让页面整整 10 分钟只拿到占位图，
     * 而占位图又被预载当成成功（审计 2026-10-09 §2 D3）——一次限流被放大成「资源永久缺失」。
     * 5xx 与超时同理，一律不记。
     */
    public static boolean isPermanentMiss(int code) {
        return code == 404 || code == 410;
    }

    /**
     * 值得重试的暂态状态：408 / 425 / 429 / 5xx，以及无法解析的状态码（0 = 网络层失败/不透明响应）。
     * 页面侧的 {@code art-prefetch.js classify()} 必须与这张表逐值一致（有测试同时钉住两边）。
     */
    public static boolean isTransientStatus(int code) {
        return code == 0 || code == 408 || code == 425 || code == 429 || code >= 500;
    }

    /**
     * Any manifest string that names an asset → the same-origin path the page will ask for:
     * {@code /assets/<rel>} stays, {@code <anything>/assets-re/<rel>} (the CDN form the build bakes
     * in) → {@code /assets/<rel>}, everything else → null. Mirrors art-prefetch.js's toLocalPath so
     * the shell and the page agree on ONE key for a path.
     */
    public static String assetPathOf(String value) {
        if (value == null) return null;
        int i = value.indexOf(ASSET_PREFIX);
        if (i >= 0) {
            String p = value.substring(i);
            return isSafeRel(p.substring(ASSET_PREFIX.length())) ? p : null;
        }
        int j = value.indexOf("/" + Line.ASSETS_DIR + "/");
        if (j >= 0) {
            String rel = value.substring(j + Line.ASSETS_DIR.length() + 2);
            if (!isSafeRel(rel)) return null;
            return ASSET_PREFIX + rel;
        }
        // 过渡期（2026-10-09）：统一命名空间之前发布的 APK 内置清单里全是 /assets-re/…，仓库里已构建
        // 的 webroot 也还带着它。不认这一支会让「本地已可提供」清单静默漏项（覆盖门禁少算而不是报错）。
        int k = value.indexOf("/" + Line.LEGACY_ASSETS_DIR + "/");
        if (k >= 0) {
            String rel = value.substring(k + Line.LEGACY_ASSETS_DIR.length() + 2);
            if (!isSafeRel(rel)) return null;
            return ASSET_PREFIX + rel;
        }
        return null;
    }

    /**
     * One line of the "what can be served locally already" list (see MainActivity#localArtList):
     * {@code /assets/<rel>} → {@code assets/<rel>}, or null when the path is not an asset path or
     * carries a control character (a file name is untrusted input once it is written to a
     * line-oriented body).
     */
    public static String inventoryLine(String assetPath) {
        if (assetPath == null || !assetPath.startsWith(ASSET_PREFIX)) return null;
        String line = assetPath.substring(1);
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c < 0x20 || c == 0x7f) return null;
        }
        return isSafeRel(line) ? line : null;
    }

    /** A relative path with no empty/'.'/'..' segment and no leading/trailing slash. */
    public static boolean isSafeRel(String rel) {        if (rel == null || rel.isEmpty() || rel.startsWith("/") || rel.endsWith("/")) return false;
        for (String seg : rel.split("/", -1)) {
            if (seg.isEmpty() || ".".equals(seg) || "..".equals(seg)) return false;
        }
        return true;
    }

    // ---------------------------------------------------------------- IPv4

    /** Parses an IPv4 literal in dotted/octal/hex/single-integer form; null when it is not one. */
    public static Long parseIpv4(String h) {
        if (h == null || h.isEmpty()) return null;
        String[] parts = h.split("\\.", -1);
        if (parts.length == 0 || parts.length > 4) return null;
        long value = 0;
        for (int i = 0; i < parts.length; i++) {
            String p = parts[i];
            if (p.isEmpty()) return null;
            long n;
            try {
                if (p.length() > 2 && (p.startsWith("0x") || p.startsWith("0X"))) {
                    n = Long.parseLong(p.substring(2), 16);
                } else if (p.length() > 1 && p.charAt(0) == '0') {
                    n = Long.parseLong(p.substring(1), 8);
                } else {
                    n = Long.parseLong(p, 10);
                }
            } catch (NumberFormatException e) {
                return null;
            }
            if (n < 0) return null;
            if (i < parts.length - 1) {
                if (n > 0xFFL) return null;
                value = (value << 8) | n;
            } else {
                int remaining = 4 - i;
                long max = remaining >= 4 ? 0xFFFFFFFFL : ((1L << (8 * remaining)) - 1);
                if (n > max) return null;
                value = (value << (8 * remaining)) | n;
            }
        }
        return value & 0xFFFFFFFFL;
    }

    /** Loopback / private / link-local / CGNAT / documentation / multicast / reserved → true. */
    public static boolean isBlockedIpv4(long ip) {
        long a = (ip >>> 24) & 0xFF;
        long b = (ip >>> 16) & 0xFF;
        long c = (ip >>> 8) & 0xFF;
        if (a == 0) return true;                                  // 0.0.0.0/8 "this network"
        if (a == 10) return true;                                 // 10/8 private
        if (a == 127) return true;                                // 127/8 loopback
        if (a == 100 && b >= 64 && b <= 127) return true;         // 100.64/10 CGNAT
        if (a == 169 && b == 254) return true;                    // 169.254/16 link-local
        if (a == 172 && b >= 16 && b <= 31) return true;          // 172.16/12 private
        if (a == 192 && b == 168) return true;                    // 192.168/16 private
        if (a == 192 && b == 0 && (c == 0 || c == 2)) return true; // 192.0.0/24, 192.0.2/24
        if (a == 192 && b == 88 && c == 99) return true;          // 192.88.99/24 (6to4 relay)
        if (a == 198 && (b == 18 || b == 19)) return true;        // 198.18/15 benchmarking
        if (a == 198 && b == 51 && c == 100) return true;         // 198.51.100/24 doc
        if (a == 203 && b == 0 && c == 113) return true;          // 203.0.113/24 doc
        if (a >= 224) return true;                                // 224/4 multicast + 240/4 reserved
        return false;
    }

    // ---------------------------------------------------------------- IPv6

    public static boolean isBlockedIpv6(String h) {
        String s = h;
        int zone = s.indexOf('%');
        if (zone >= 0) s = s.substring(0, zone);
        s = s.toLowerCase(Locale.ROOT);
        if (s.equals("::") || s.equals("::1")
                || s.equals("0:0:0:0:0:0:0:0") || s.equals("0:0:0:0:0:0:0:1")) return true;
        // IPv4-mapped/-compatible forms (dotted tail): ::ffff:a.b.c.d, ::a.b.c.d, ...:ffff:a.b.c.d
        if (s.indexOf('.') >= 0 && (s.indexOf(":ffff:") >= 0 || s.startsWith("::"))) return true;
        String first = s.startsWith("::") ? "0" : s.split(":", -1)[0];
        int g = hextet(first);
        if (g < 0) return true;                                   // unparseable → fail closed
        if ((g & 0xFFC0) == 0xFE80) return true;                  // fe80::/10 link-local
        if ((g & 0xFE00) == 0xFC00) return true;                  // fc00::/7 ULA
        if ((g & 0xFF00) == 0xFF00) return true;                  // ff00::/8 multicast
        if (g == 0x2001) {                                        // 2001:db8::/32 documentation
            String[] parts = s.split(":", -1);
            if (parts.length > 1 && "db8".equals(parts[1])) return true;
        }
        return false;
    }

    private static int hextet(String x) {
        if (x == null || x.isEmpty() || x.length() > 4) return -1;
        try {
            return (int) Long.parseLong(x, 16);
        } catch (NumberFormatException e) {
            return -1;
        }
    }
}
