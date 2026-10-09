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
