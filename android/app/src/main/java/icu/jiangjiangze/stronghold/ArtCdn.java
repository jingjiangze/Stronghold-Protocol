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

    /** Path prefix of the assets the page requests same-origin (the manifests are de-CDN'd to this). */
    public static final String ASSET_PREFIX = "/assets/";

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

    /** A relative path with no empty/'.'/'..' segment and no leading/trailing slash. */
    public static boolean isSafeRel(String rel) {
        if (rel == null || rel.isEmpty() || rel.startsWith("/") || rel.endsWith("/")) return false;
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
