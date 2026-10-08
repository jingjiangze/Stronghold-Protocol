import icu.jiangjiangze.stronghold.ArtCacheStats;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JVM self-test for the O(1) fetched-art cache counters (ArtCacheStats) behind
 * {@code ShellBridge.artCacheStatus()}/{@code clearArtCache()} (feat/art-cache-status, 2026-10-08).
 * Pure logic + plain IO: no Android, no network, bare JDK 17.
 *
 *   bash tools/apk/jvm/run-art-cache-stats-check.sh
 *
 * Covers:
 *   - counter arithmetic: increment on write, decrement on delete (floored at 0);
 *   - the counting口径: real files only, .part/.tmp/hidden temp artefacts excluded, foreign
 *     namespaces excluded, art/packs/** never counted, lexical escape (`..`) refused;
 *   - clear(): removes every child of art/cache, keeps art/packs intact, resets the counters;
 *   - persistence + startup reconcile: metadata restores the counters, a namespace mismatch does not;
 *   - the JSON shape of statusJson/errorJson/clearJson (parsed, not substring-matched).
 */
public final class ArtCacheStatsCheck {

    private static int checks = 0;
    private static final List<String> failures = new ArrayList<>();

    private static final String NS = "7ae1d03466cb";

    public static void main(String[] args) throws Exception {
        File root = Files.createTempDirectory("sp-artcache").toFile();
        try {
            File cacheRoot = new File(root, "art/cache");
            File packsRoot = new File(root, "art/packs");
            File meta = ArtCacheStats.metaFile(new File(root, "art"));

            // ---- fixture: current namespace + a foreign namespace + a pack tree ------------------
            write(new File(cacheRoot, NS + "/assets/ui/x.png"), 10);
            write(new File(cacheRoot, NS + "/assets/ui/y.png.part"), 99);   // half-written: excluded
            write(new File(cacheRoot, NS + "/assets/ui/.hidden.tmp"), 7);   // temp artefact: excluded
            write(new File(cacheRoot, NS + "/srv-abc-1/assets/z.png"), 20); // server slot: counted
            write(new File(cacheRoot, NS + "/sub/deep.png"), 5);
            write(new File(cacheRoot, "oldhash/assets/o.png"), 100);        // foreign namespace
            write(new File(packsRoot, "p1/assets/p.png"), 200);             // signed pack: never counted

            // ---- scan: only the current namespace, only countable files --------------------------
            ArtCacheStats stats = new ArtCacheStats();
            ArtCacheStats.Count c = stats.scan(cacheRoot, NS);
            eq(3, c.files, "scan counts 3 real files (x.png + srv z.png + deep.png)");
            eq(35L, c.bytes, "scan sums 35 bytes (10 + 20 + 5)");
            eq(0, stats.scan(cacheRoot, "does-not-exist").files, "an absent namespace scans to 0");
            eq(0, stats.scan(cacheRoot, "../evil").files, "an unsafe namespace scans to 0");
            eq(0, stats.scan(null, NS).files, "a null cache root scans to 0");

            // ---- isCountable: the exclusion + lexical rules in isolation ------------------------
            check(ArtCacheStats.isCountable(cacheRoot, new File(cacheRoot, NS + "/assets/ui/x.png")),
                    "a real file under the namespace is countable");
            check(!ArtCacheStats.isCountable(cacheRoot, new File(cacheRoot, NS + "/assets/ui/y.png.part")),
                    "a .part file is never counted");
            check(!ArtCacheStats.isCountable(cacheRoot, new File(cacheRoot, NS + "/assets/ui/a.tmp")),
                    "a .tmp file is never counted");
            check(!ArtCacheStats.isCountable(cacheRoot, new File(cacheRoot, NS + "/assets/ui/.hidden")),
                    "a hidden temp file is never counted");
            check(!ArtCacheStats.isCountable(cacheRoot, new File(cacheRoot, NS)),
                    "a directory is never counted");
            check(!ArtCacheStats.isCountable(cacheRoot, new File(packsRoot, "p1/assets/p.png")),
                    "a file outside the cache root (art/packs) is never counted");
            check(!ArtCacheStats.isCountable(cacheRoot, new File(cacheRoot, "../packs/p1/assets/p.png")),
                    "a `..` path is refused even if it resolves to a real file");
            check(!ArtCacheStats.isSafeUnder(cacheRoot, cacheRoot), "the cache root itself is not 'under' it");
            check(!ArtCacheStats.isSafeUnder(null, new File(cacheRoot, NS)), "a null root is unsafe");

            // ---- counter arithmetic: increment on write, decrement on delete --------------------
            ArtCacheStats arith = new ArtCacheStats();
            arith.configure(meta, NS);
            arith.onWrite(10);
            eq(1, arith.files(), "onWrite(10) -> 1 file");
            eq(10L, arith.bytes(), "onWrite(10) -> 10 bytes");
            arith.onWrite(20);
            eq(2, arith.files(), "onWrite(20) -> 2 files");
            eq(30L, arith.bytes(), "onWrite(20) -> 30 bytes");
            arith.onDelete(20);
            eq(1, arith.files(), "onDelete(20) -> 1 file");
            eq(10L, arith.bytes(), "onDelete(20) -> 10 bytes");
            arith.onDelete(9999);
            eq(0, arith.files(), "the file counter floors at 0");
            eq(0L, arith.bytes(), "the byte counter floors at 0");

            // ---- persistence: reconcile writes metadata, a fresh instance restores it -----------
            ArtCacheStats p1 = new ArtCacheStats();
            p1.configure(meta, NS);
            p1.reconcileTo(new ArtCacheStats.Count(3, 35), NS);
            eq(3, p1.files(), "reconcileTo sets the file counter");
            eq(35L, p1.bytes(), "reconcileTo sets the byte counter");
            check(meta.isFile(), "reconcileTo persists the metadata file");
            ArtCacheStats p2 = new ArtCacheStats();
            p2.configure(meta, NS);
            eq(3, p2.files(), "a fresh instance restores the file count from metadata");
            eq(35L, p2.bytes(), "a fresh instance restores the byte count from metadata");
            ArtCacheStats p3 = new ArtCacheStats();
            p3.configure(meta, "otherhash");
            eq(0, p3.files(), "a foreign namespace never inherits another namespace's counters");
            // a stale namespace in the metadata is ignored (repair happens by scanning)
            Files.write(meta.toPath(), "{\"namespace\":\"stalehash\",\"files\":9,\"bytes\":9}"
                    .getBytes(StandardCharsets.UTF_8));
            ArtCacheStats p4 = new ArtCacheStats();
            p4.configure(meta, NS);
            eq(0, p4.files(), "metadata naming another namespace is not trusted");

            // ---- clear: cache gone, packs kept, counters reset ----------------------------------
            ArtCacheStats s = new ArtCacheStats();
            s.configure(meta, NS);
            s.set(3, 35);
            ArtCacheStats.ClearResult r = s.clear(cacheRoot);
            check(r.ok, "clear reports ok on a healthy cache");
            eq(6, r.files, "clear removed all 6 cache files (incl. the .part/foreign ones)");
            eq(241L, r.bytes, "clear summed 241 removed bytes (10+99+7+20+5+100)");
            eq(0, s.files(), "clear resets the file counter");
            eq(0L, s.bytes(), "clear resets the byte counter");
            File[] left = cacheRoot.listFiles();
            check(left == null || left.length == 0, "clear left no children under art/cache");
            check(new File(packsRoot, "p1/assets/p.png").isFile(),
                    "clear KEEPS art/packs (the signed pack bytes survive)");
            check(!new File(cacheRoot, NS).exists(), "clear removed the namespace directory itself");
            // a second clear on an empty cache is still ok
            check(s.clear(cacheRoot).ok, "clearing an already-empty cache is ok");

            // ---- JSON shape: parsed, not substring-matched --------------------------------------
            Map<String, Object> st = parseJson(ArtCacheStats.statusJson(
                    "7ae1d03466cb", "art/cache/7ae1d03466cb", 1278, 143829381L, -1L));
            eq(Boolean.TRUE, st.get("ok"), "status.ok is true");
            eq("7ae1d03466cb", st.get("manifestHash"), "status.manifestHash is the manifest hash");
            eq(1278L, st.get("cachedFiles"), "status.cachedFiles is a number");
            eq(143829381L, st.get("cachedBytes"), "status.cachedBytes is a number");
            eq("art/cache/7ae1d03466cb", st.get("cacheRoot"), "status.cacheRoot is the namespaced root");
            eq(-1L, st.get("pending"), "status.pending is -1 when it cannot be known cheaply");
            eq(6, st.size(), "status has exactly the 6 contract keys");
            Map<String, Object> st2 = parseJson(ArtCacheStats.statusJson("h", "art/cache/h", 1, 2, 1276L));
            eq(1276L, st2.get("pending"), "status.pending passes a real number through");

            Map<String, Object> er = parseJson(ArtCacheStats.errorJson("boom"));
            eq(Boolean.FALSE, er.get("ok"), "error.ok is false");
            eq("boom", er.get("error"), "error.error carries the message");
            eq("unknown error", parseJson(ArtCacheStats.errorJson(null)).get("error"),
                    "a null error message still yields valid JSON");

            Map<String, Object> cl = parseJson(ArtCacheStats.clearJson(true, 6, 241L, null));
            eq(Boolean.TRUE, cl.get("ok"), "clear.ok is true");
            eq(6L, cl.get("removedFiles"), "clear.removedFiles is a number");
            eq(241L, cl.get("removedBytes"), "clear.removedBytes is a number");
            eq(Boolean.TRUE, cl.get("keptPacks"), "clear.keptPacks is always true");
            check(!cl.containsKey("error"), "a successful clear carries no error key");
            Map<String, Object> cf = parseJson(ArtCacheStats.clearJson(false, 2, 50L, "delete failed: x"));
            eq(Boolean.FALSE, cf.get("ok"), "a partial clear reports ok=false");
            eq(2L, cf.get("removedFiles"), "a partial clear still reports what was removed");
            eq("delete failed: x", cf.get("error"), "a partial clear carries the error");

            // quoting round-trips (the bridge must never emit invalid JSON)
            Map<String, Object> q = parseJson(ArtCacheStats.statusJson("a\"b", "c\\d", 0, 0, -1));
            eq("a\"b", q.get("manifestHash"), "quotes in a value survive the round-trip");
            eq("c\\d", q.get("cacheRoot"), "backslashes in a value survive the round-trip");
        } finally {
            rm(root);
        }

        System.out.println("ArtCacheStatsCheck OK (" + checks + " checks)");
        if (!failures.isEmpty()) {
            System.out.println("FAILURES:");
            for (String f : failures) System.out.println("  - " + f);
            System.exit(1);
        }
    }

    // ------------------------------------------------------------------ helpers

    private static void write(File f, int n) throws Exception {
        File dir = f.getParentFile();
        if (dir != null) Files.createDirectories(dir.toPath());
        Files.write(f.toPath(), new byte[n]);
    }

    private static void rm(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) rm(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static void check(boolean ok, String label) {
        checks++;
        if (!ok) failures.add("FAILED: " + label);
    }

    private static void eq(Object expected, Object actual, String label) {
        checks++;
        boolean ok = expected == null ? actual == null : expected.equals(actual);
        if (!ok) failures.add("FAILED: " + label + " (expected " + expected + ", got " + actual + ")");
    }

    private static void eq(long expected, long actual, String label) {
        eq(Long.valueOf(expected), Long.valueOf(actual), label);
    }

    private static void eq(int expected, int actual, String label) {
        eq(Integer.valueOf(expected), Integer.valueOf(actual), label);
    }

    // ------------------------------------------------------------------ minimal flat JSON parser

    /** Parses a flat JSON object (string/number/bool/null values) into a LinkedHashMap. */
    private static Map<String, Object> parseJson(String s) {
        Map<String, Object> m = new LinkedHashMap<>();
        int i = skip(s, 0);
        if (i >= s.length() || s.charAt(i) != '{') throw new IllegalArgumentException("not an object: " + s);
        i = skip(s, i + 1);
        while (i < s.length() && s.charAt(i) != '}') {
            StringBuilder key = new StringBuilder();
            if (s.charAt(i) != '"') throw new IllegalArgumentException("expected key at " + i + ": " + s);
            i = readString(s, i, key);
            i = skip(s, i);
            if (i >= s.length() || s.charAt(i) != ':') throw new IllegalArgumentException("expected ':' at " + i);
            i = skip(s, i + 1);
            Object v;
            char c = s.charAt(i);
            if (c == '"') {
                StringBuilder sb = new StringBuilder();
                i = readString(s, i, sb);
                v = sb.toString();
            } else if (c == 't') {
                expect(s, i, "true");
                i += 4;
                v = Boolean.TRUE;
            } else if (c == 'f') {
                expect(s, i, "false");
                i += 5;
                v = Boolean.FALSE;
            } else if (c == 'n') {
                expect(s, i, "null");
                i += 4;
                v = null;
            } else {
                int j = i;
                while (j < s.length() && "-+.0123456789eE".indexOf(s.charAt(j)) >= 0) j++;
                v = Long.valueOf(Long.parseLong(s.substring(i, j)));
                i = j;
            }
            m.put(key.toString(), v);
            i = skip(s, i);
            if (i < s.length() && s.charAt(i) == ',') i = skip(s, i + 1);
        }
        return m;
    }

    private static int skip(String s, int i) {
        while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        return i;
    }

    private static int readString(String s, int i, StringBuilder out) {
        i++; // opening quote
        while (i < s.length()) {
            char c = s.charAt(i++);
            if (c == '"') return i;
            if (c == '\\') {
                char e = s.charAt(i++);
                switch (e) {
                    case 'n': out.append('\n'); break;
                    case 'r': out.append('\r'); break;
                    case 't': out.append('\t'); break;
                    case '"': out.append('"'); break;
                    case '\\': out.append('\\'); break;
                    case 'u': out.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                    default: out.append(e);
                }
            } else {
                out.append(c);
            }
        }
        throw new IllegalArgumentException("unterminated string");
    }

    private static void expect(String s, int i, String lit) {
        if (!s.startsWith(lit, i)) throw new IllegalArgumentException("expected " + lit + " at " + i);
    }
}
