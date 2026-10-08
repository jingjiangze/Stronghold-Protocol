import icu.jiangjiangze.stronghold.ArtCdn;

/**
 * JVM self-test for the pure logic behind the no-embedded-assets fallback (ArtCdn): the host
 * allow-list / private-address rejection, the /assets path → CDN URL mapping and the /assets path →
 * cache-path mapping. No Android runtime, no network — plain JDK 17.
 *
 * Build &amp; run:
 *   javac -d /tmp/spjvm-art \
 *     android/app/src/main/java/icu/jiangjiangze/stronghold/Line.java \
 *     android/app/src/main/java/icu/jiangjiangze/stronghold/ArtCdn.java \
 *     tools/apk/jvm/ArtCdnCheck.java
 *   java -cp /tmp/spjvm-art ArtCdnCheck
 */
public final class ArtCdnCheck {

    private static int checks = 0;

    public static void main(String[] args) {
        // ---- allow-list: only OUR configured CDN/mirror hosts -------------------------------
        allow("weishucdn.jiangjiangze.icu");
        allow("WEISHUCDN.JIANGJIANGZE.ICU");
        allow("weishucdn.jiangjiangze.icu."); // trailing root dot
        allow("dl.jiangjiangze.icu");
        allow("jingjiangze.github.io");
        eq(3, ArtCdn.allowedHosts().size(), "allow-list has exactly the 3 configured hosts");
        check(ArtCdn.allowedHosts().contains("weishucdn.jiangjiangze.icu"), "CDN host from Line.CDN is allowed");

        // ---- reject: null/empty/localhost ----------------------------------------------------
        deny(null);
        deny("");
        deny("   ");
        deny("localhost");
        deny("LOCALHOST");
        deny("foo.localhost");
        deny("localhost.");

        // ---- reject: IPv4 in every notation --------------------------------------------------
        deny("127.0.0.1");
        deny("127.1");            // 2-part
        deny("127.0.1");          // 3-part
        deny("0177.0.0.1");       // octal
        deny("0x7f.0.0.1");       // hex part
        deny("0x7f000001");       // single hex integer
        deny("2130706433");       // single decimal integer == 127.0.0.1
        deny("0.0.0.0");
        deny("10.0.0.5");
        deny("10.255.255.255");
        deny("172.16.0.1");
        deny("172.31.255.255");
        deny("192.168.1.1");
        deny("169.254.1.1");
        deny("100.64.0.1");
        deny("100.127.255.254");
        deny("192.0.0.1");
        deny("192.0.2.1");
        deny("192.88.99.1");
        deny("198.18.0.1");
        deny("198.51.100.1");
        deny("203.0.113.1");
        deny("224.0.0.1");        // multicast
        deny("240.0.0.1");        // reserved
        deny("255.255.255.255");  // broadcast

        // ---- reject: IPv6 loopback / ULA / link-local / multicast / mapped -------------------
        deny("::1");
        deny("[::1]");
        deny("::");
        deny("0:0:0:0:0:0:0:1");
        deny("fe80::1");
        deny("FE80::ABCD");
        deny("fd00::1");
        deny("fc00::1");
        deny("ff02::1");
        deny("::ffff:127.0.0.1");
        deny("0:0:0:0:0:ffff:127.0.0.1");
        deny("2001:db8::1");
        deny("fe80::1%eth0");

        // ---- reject: hosts not in the allow-list (incl. suffix/prefix tricks) ----------------
        deny("example.com");
        deny("weishucdn.jiangjiangze.icu.evil.com");
        deny("evil-weishucdn.jiangjiangze.icu");
        deny("cdn.jiangjiangze.icu"); // not one of the configured hosts

        // ---- isBlockedLiteral in isolation ---------------------------------------------------
        check(ArtCdn.isBlockedLiteral("127.0.0.1"), "127.0.0.1 is a blocked literal");
        check(ArtCdn.isBlockedLiteral("localhost"), "localhost is a blocked literal");
        check(ArtCdn.isBlockedLiteral("10.1.2.3"), "10.1.2.3 is a blocked literal");
        check(ArtCdn.isBlockedLiteral("fe80::1"), "fe80::1 is a blocked literal");
        check(!ArtCdn.isBlockedLiteral("weishucdn.jiangjiangze.icu"), "the CDN host is not a blocked literal");
        check(!ArtCdn.isBlockedLiteral("8.8.8.8"), "a public IPv4 is not a blocked literal");

        // ---- parseIpv4 normalisation ---------------------------------------------------------
        eq(2130706433L, ArtCdn.parseIpv4("127.0.0.1").longValue(), "127.0.0.1 parses to 0x7F000001");
        eq(2130706433L, ArtCdn.parseIpv4("2130706433").longValue(), "single-integer form parses the same");
        eq(2130706433L, ArtCdn.parseIpv4("0177.0.0.1").longValue(), "octal form parses the same");
        eq(2130706433L, ArtCdn.parseIpv4("0x7f.0.0.1").longValue(), "hex form parses the same");
        eq(167772161L, ArtCdn.parseIpv4("10.0.0.1").longValue(), "10.0.0.1 parses correctly");
        check(ArtCdn.parseIpv4("weishucdn.jiangjiangze.icu") == null, "a DNS name is not an IPv4 literal");
        check(ArtCdn.parseIpv4("300.1.1.1") == null, "an out-of-range octet is not an IPv4 literal");

        // ---- cdnUrlFor: /assets/** -> <Line.ASSETS_CDN_PREFIX><rel> --------------------------
        eq("https://weishucdn.jiangjiangze.icu/assets-re/ui/x.png",
                ArtCdn.cdnUrlFor("/assets/ui/x.png"), "simple asset path maps to the CDN");
        eq("https://weishucdn.jiangjiangze.icu/assets-re/spine/a/b.skel",
                ArtCdn.cdnUrlFor("/assets/spine/a/b.skel"), "nested asset path maps to the CDN");
        check(ArtCdn.cdnUrlFor("/other/x.png") == null, "a non-asset path has no CDN URL");
        check(ArtCdn.cdnUrlFor(null) == null, "null has no CDN URL");
        check(ArtCdn.cdnUrlFor("/assets/") == null, "a bare /assets/ has no CDN URL");
        check(ArtCdn.cdnUrlFor("/assets/../x.png") == null, "traversal has no CDN URL");
        check(ArtCdn.cdnUrlFor("/assets/a//b.png") == null, "an empty segment has no CDN URL");
        check(ArtCdn.cdnUrlFor("/assets/a/./b.png") == null, "a dot segment has no CDN URL");

        // ---- cacheRelPath: /assets/** -> art/cache/<hash>/assets/** ---------------------------
        eq("art/cache/abc123/assets/ui/x.png", ArtCdn.cacheRelPath("abc123", "/assets/ui/x.png"),
                "cache path is hash-namespaced");
        eq("art/cache/abc123/assets/spine/a/b.skel", ArtCdn.cacheRelPath("abc123", "/assets/spine/a/b.skel"),
                "nested cache path");
        check(ArtCdn.cacheRelPath("abc123", "/other/x.png") == null, "a non-asset path has no cache path");
        check(ArtCdn.cacheRelPath("abc123", "/assets/../x.png") == null, "traversal has no cache path");
        check(ArtCdn.cacheRelPath("abc123", null) == null, "null has no cache path");

        // ---- cache invalidation by manifest hash ---------------------------------------------
        // same path + changed hash -> a DIFFERENT cache entry (miss -> re-fetch): the acceptance
        // "replace one image, republish, reload shows the new art" depends on exactly this.
        check(!ArtCdn.cacheRelPath("h1", "/assets/ui/x.png").equals(ArtCdn.cacheRelPath("h2", "/assets/ui/x.png")),
                "a changed manifest hash misses the old cache entry");
        eq(ArtCdn.cacheRelPath("h1", "/assets/ui/x.png"), ArtCdn.cacheRelPath("h1", "/assets/ui/x.png"),
                "an unchanged manifest hash hits the same cache entry");

        // ---- safeHash: fallback on missing/unsafe, never escapes art/cache/ ------------------
        eq("v0", ArtCdn.FALLBACK_HASH, "FALLBACK_HASH");
        eq("v0", ArtCdn.safeHash(null), "null hash -> v0");
        eq("v0", ArtCdn.safeHash(""), "empty hash -> v0");
        eq("v0", ArtCdn.safeHash("   "), "blank hash -> v0");
        eq("v0", ArtCdn.safeHash("../evil"), "traversal hash -> v0");
        eq("v0", ArtCdn.safeHash("a/b"), "slash hash -> v0");
        eq("v0", ArtCdn.safeHash("a\\b"), "backslash hash -> v0");
        eq("v0", ArtCdn.safeHash("x".repeat(65)), "over-long hash -> v0");
        eq("7ae1d03466cb", ArtCdn.safeHash("7ae1d03466cb"), "a real manifest hash passes through");
        eq("art/cache/v0", ArtCdn.cacheRootForHash(null), "missing hash degrades to art/cache/v0 (still caches)");
        eq("art/cache/v0/assets/ui/x.png", ArtCdn.cacheRelPath(null, "/assets/ui/x.png"),
                "a missing hash still caches, under v0");
        check(!ArtCdn.cacheRootForHash("../../etc").contains(".."), "a hostile hash can never escape art/cache/");

        // ---- H1: a manifest-hash change adopts the previous namespace (never orphans the bytes) --
        // A content release re-emits data/assets.json's `hash` over the SAME referenced bytes
        // (tools/apk/transcode-assets.mjs hashReferencedBytes): measured on the live pair, both
        // b699458e3e10 and 7ae1d03466cb enumerate 7969 identical paths. The namespace is that hash,
        // so without adoption one update drops 100 % of the fetched art.
        eq("b699458e3e10", ArtCdn.pickAdoptable("7ae1d03466cb", java.util.Arrays.asList("b699458e3e10")),
                "the only other namespace is the predecessor");
        eq("newest", ArtCdn.pickAdoptable("h3", java.util.Arrays.asList("newest", "older")),
                "several candidates: the most recent one wins");
        check(ArtCdn.pickAdoptable("h1", java.util.Arrays.asList("h1")) == null,
                "the current namespace is never its own predecessor");
        check(ArtCdn.pickAdoptable("h1", java.util.Arrays.asList()) == null,
                "no candidate -> the bytes really are orphaned (fetch)");
        eq("v0", ArtCdn.pickAdoptable("h1", java.util.Arrays.asList("v0")),
                "the fallback namespace v0 adopts like any other");
        check(ArtCdn.pickAdoptable("h1", java.util.Arrays.asList("../evil", "a/b", "..")) == null,
                "malformed candidates are never adopted");
        check(ArtCdn.pickAdoptable("h1", java.util.Arrays.asList("has space")) == null,
                "a candidate that is not a safe namespace is refused");

        // ---- namespace parsing / prune ranking (the active art is deleted LAST) ---------------
        eq("abc123", ArtCdn.namespaceOf("abc123/assets/ui/x.png"), "the first segment is the namespace");
        eq("abc123", ArtCdn.namespaceOf("abc123\\assets\\ui\\x.png"), "windows separators accepted");
        check(ArtCdn.namespaceOf("abc123") == null, "a bare namespace is not a file path");
        eq("abc123", ArtCdn.namespaceOf("/abc123/assets/x.png"), "a leading slash still parses the namespace");
        eq(1, ArtCdn.pruneRank("h1/assets/ui/x.png", "h1"), "the active namespace is pruned last");
        eq(0, ArtCdn.pruneRank("h2/assets/ui/x.png", "h1"), "a foreign namespace is pruned first");
        eq(0, ArtCdn.pruneRank("unknown-junk/x.png", "h1"), "an unparsable entry is never the active one");
        eq(0, ArtCdn.pruneRank(null, "h1"), "null is never active");
        check(ArtCdn.isValidNamespace("7ae1d03466cb"), "a real hash is a valid namespace");
        check(!ArtCdn.isValidNamespace(""), "an empty name is not a namespace");
        check(!ArtCdn.isValidNamespace("../x"), "traversal is not a namespace");

        // ---- H3: the background prefetch is marked, an ordinary page request is not -----------
        java.util.Map<String, String> marked = new java.util.HashMap<>();
        marked.put("X-SP-Prefetch", "1");
        check(ArtCdn.isPrefetchRequest(marked), "an explicit marker is a prefetch request");
        marked.clear();
        marked.put("x-sp-prefetch", "1");
        check(ArtCdn.isPrefetchRequest(marked), "the header name is matched case-insensitively");
        marked.clear();
        marked.put("X-SP-Prefetch", " 1 ");
        check(ArtCdn.isPrefetchRequest(marked), "a padded value still marks the request");
        marked.clear();
        marked.put("X-SP-Prefetch", "0");
        check(!ArtCdn.isPrefetchRequest(marked), "0 is an explicit no");
        marked.clear();
        check(!ArtCdn.isPrefetchRequest(marked), "no headers -> an ordinary page request");
        check(!ArtCdn.isPrefetchRequest(null), "null headers -> an ordinary page request");
        marked.put("Accept", "*/*");
        check(!ArtCdn.isPrefetchRequest(marked), "an unrelated header is not the marker");

        // ---- H4: the placeholder must never be cached anywhere --------------------------------
        java.util.Map<String, String> ph = ArtCdn.placeholderHeaders();
        eq("no-store", ph.get("Cache-Control"), "the placeholder is served no-store");
        eq("*", ph.get("Access-Control-Allow-Origin"), "and stays readable same-origin");

        // ---- local coverage: which manifest strings name an asset, and how they are listed ----
        eq("/assets/ui/x.png", ArtCdn.assetPathOf("/assets/ui/x.png"), "the same-origin form passes through");
        eq("/assets/ui/x.png", ArtCdn.assetPathOf("https://weishucdn.jiangjiangze.icu/assets-re/ui/x.png"),
                "the CDN form is normalised to the same-origin form");
        eq("/assets/ui/x.png", ArtCdn.assetPathOf("/assets-re/ui/x.png"), "the bare namespaced form too");
        check(ArtCdn.assetPathOf("/fonts/x.css") == null, "a non-asset string is not a coverage entry");
        check(ArtCdn.assetPathOf(null) == null, "null is not a coverage entry");
        eq("assets/ui/x.png", ArtCdn.inventoryLine("/assets/ui/x.png"), "the list drops the leading slash");
        check(ArtCdn.inventoryLine("/fonts/x.css") == null, "only asset paths are listed");
        check(ArtCdn.inventoryLine("/assets/a\nb.png") == null, "a control char can never break the list format");
        check(ArtCdn.inventoryLine("/assets/../x.png") == null, "traversal is not listed");

        System.out.println("ArtCdnCheck OK (" + checks + " checks)");
    }

    // ------------------------------------------------------------------ helpers

    private static void allow(String host) {
        check(ArtCdn.isAllowedHost(host), "allowed: " + host);
    }

    private static void deny(String host) {
        check(!ArtCdn.isAllowedHost(host), "rejected: " + host);
    }

    private static void check(boolean ok, String label) {
        checks++;
        if (!ok) throw new AssertionError("FAILED: " + label);
    }

    private static void eq(Object expected, Object actual, String label) {
        checks++;
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError("FAILED: " + label + " (expected " + expected + ", got " + actual + ")");
        }
    }

    private static void eq(long expected, long actual, String label) {
        eq(Long.valueOf(expected), Long.valueOf(actual), label);
    }
}
