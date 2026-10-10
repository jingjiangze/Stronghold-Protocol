package icu.jiangjiangze.stronghold;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Which mirror THIS device actually downloads art from, for this session — and it picks SEPARATELY
 * for small and large assets.
 *
 * <p>WHY (measured 2026-10-10, real asset paths, one machine): the asset tree is ~12k SMALL files, so
 * what a player pays is one round trip per file far more than the bytes in it — but a 3.2 MB map PNG
 * behaves the other way round. The two best sources were NOT the same: ghfast-assets won on small
 * files (median TTFB 654 ms vs r2 926 ms), r2 and ghfast both beat the others on a 3.2 MB file, and
 * jsdelivr@assets-raw was the WORST on small files (median TTFB 1479 ms, 1 timeout in 8) despite
 * winning a 256 KiB warm-probe benchmark — because jsDelivr fetches uncached files from GitHub on
 * demand. A single choice measured on a warm probe therefore both mis-ranked the sources AND could
 * not be right for two different workloads at once.
 *
 * <p>THREE RULES, all learned from that measurement:
 * <ol>
 *   <li>Measure on REAL ASSET PATHS of the class being decided, never on a warm probe file.</li>
 *   <li>A mirror must beat the compile-time origin ({@link Line#ASSETS_CDN_PREFIX}) by {@link
 *       #MARGIN} before it is allowed to take over. The origin holds the bytes natively and has no
 *       on-demand fetch between it and the player, so the cost of being wrong about it is asymmetric.</li>
 *   <li>A source that fails once is dropped for this session ({@link Sample#failed}).</li>
 * </ol>
 *
 * <p>FAIL-SAFE BY CONSTRUCTION: every failure path leaves the compile-time origin in force, so a
 * device that cannot measure behaves exactly as it did before this class existed.
 *
 * <p>WHAT IT WILL NOT DO: it never invents a host — a mirror is usable only if its host is in
 * {@link #mirrorHosts()} — and it never picks a source the published list marks as unable to serve
 * art ({@code assetEligible:false} / {@code coverage:"partial"}), as disabled ({@code enabled:false}),
 * or as a Worker relay ({@code proxied:true}).
 */
final class ArtSource {

    private ArtSource() {
    }

    /** The published mirror list. Read from the line's own CDN, like every other interface file. */
    static final String MIRRORS_URL = Line.CDN + "/cdn/v1/mirrors.json";

    /** Mirror hosts this build is willing to fetch art from. Fail-closed: anything else is refused. */
    private static final Set<String> MIRROR_HOSTS = buildMirrorHosts();

    private static final String PREF = "sp-art-source";
    private static final String KEY_SMALL = "smallBase";
    private static final String KEY_LARGE = "largeBase";
    private static final String KEY_AT = "at";

    /** A pick older than this is re-measured. Six hours matches the picker's own TTL. */
    static final long TTL_MS = 6L * 60 * 60 * 1000;

    /** A mirror must be at least this much better than the origin before it is allowed to take over. */
    static final double MARGIN = 0.20;

    private static final int PROBE_CAP = 32 * 1024;
    private static final int TIMEOUT_MS = 6000;
    private static final int MAX_CANDIDATES = 5;

    /**
     * Real paths the pick measures, one set per class. They must exist in the release tree — a pick
     * that measures a 404 would rank the sources by how fast they serve an error page.
     */
    private static final String[] SMALL_PATHS = {
            "assets/spine/op/char_1016_agoat2/front/char_1016_agoat2.atlas",
            "assets/char/avatar/char_1016_agoat2.png",
            "fonts/bender-light.woff2",
    };
    private static final String[] LARGE_PATHS = {
            "assets/local/map/autochess/TX_autochessi_D.png",
    };

    /** Latency class: a per-file round trip dominates. Everything that is not {@link #isLarge} is here. */
    private static final AtomicReference<String> BASE_SMALL = new AtomicReference<>(null);
    /** Throughput class: the bytes dominate (audio, the big map images). */
    private static final AtomicReference<String> BASE_LARGE = new AtomicReference<>(null);
    private static final AtomicReference<String> ID_SMALL = new AtomicReference<>(null);
    private static final AtomicReference<String> ID_LARGE = new AtomicReference<>(null);
    private static volatile boolean refreshing = false;

    private static Set<String> buildMirrorHosts() {
        Set<String> s = new HashSet<>();
        s.add(hostOf(Line.CDN));
        s.add("weishucdn2.jiangjiangze.icu");
        s.add("spages.jiangjiangze.icu");
        s.add("gitcdn.jiangjiangze.icu");
        s.add("cdn.jsdelivr.net");
        s.add("ghfast.top");
        s.add("dl.jiangjiangze.icu");
        s.add("jingjiangze.github.io");
        s.remove("");
        return Collections.unmodifiableSet(s);
    }

    /** Host of a URL, lowercased, or "" when it cannot be parsed. Local to keep static init acyclic. */
    static String hostOf(String url) {
        if (url == null) return "";
        try {
            String h = new URL(url).getHost();
            return h == null ? "" : h.toLowerCase(Locale.ROOT);
        } catch (Exception e) {
            return "";
        }
    }

    static Set<String> mirrorHosts() {
        return MIRROR_HOSTS;
    }

    /**
     * The asset base to use for one request. Large assets (audio, the big map images) go to the
     * throughput winner; everything else to the latency winner. Both fall back to the origin.
     */
    static String baseFor(String assetPath) {
        if (isLarge(assetPath)) {
            String b = BASE_LARGE.get();
            return b != null ? b : Line.ASSETS_CDN_PREFIX;
        }
        String b = BASE_SMALL.get();
        return b != null ? b : Line.ASSETS_CDN_PREFIX;
    }

    /**
     * Which class a path belongs to.
     *
     * <p>Classified by prefix and extension, not by a size table: the client must decide BEFORE the
     * request, and it has no per-file size for a path it has not fetched. Audio and the large map /
     * background images are the parts of the tree where a single file's bytes dwarf its round trips.
     */
    static boolean isLarge(String assetPath) {
        String p = assetPath == null ? "" : assetPath.toLowerCase(Locale.ROOT);
        if (p.startsWith("/")) p = p.substring(1);
        if (p.startsWith("assets/audio/")) return true;
        if (p.startsWith("assets/local/map/")) return true;
        return p.endsWith(".mp3") || p.endsWith(".ogg") || p.endsWith(".m4a") || p.endsWith(".wav")
                || p.endsWith(".mp4") || p.endsWith(".webm");
    }

    /** The latency-class base in force right now (diagnostics; always ends with "/"). */
    static String base() {
        String b = BASE_SMALL.get();
        return b != null ? b : Line.ASSETS_CDN_PREFIX;
    }

    static String chosenId() {
        return ID_SMALL.get();
    }

    static String chosenIdLarge() {
        return ID_LARGE.get();
    }

    /** Adopt a cached pick if it is still fresh, so the first screen does not wait for a re-measure. */
    static void loadCached(Context context) {
        try {
            SharedPreferences p = context.getSharedPreferences(PREF, Context.MODE_PRIVATE);
            long at = p.getLong(KEY_AT, 0);
            if (at <= 0 || System.currentTimeMillis() - at >= TTL_MS) return;
            String small = p.getString(KEY_SMALL, null);
            String large = p.getString(KEY_LARGE, null);
            if (small != null && isAllowedHost(hostOf(small))) BASE_SMALL.set(small);
            if (large != null && isAllowedHost(hostOf(large))) BASE_LARGE.set(large);
            ID_SMALL.set(p.getString("smallId", null));
            ID_LARGE.set(p.getString("largeId", null));
        } catch (Exception e) {
            // A broken preference must never break art: fall through to the compile-time default.
        }
    }

    /** Re-measure in the background. Idempotent and safe to call on every start. */
    static void refresh(final Context context) {
        if (refreshing) return;
        refreshing = true;
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Picks picks = pick();
                    if (picks != null) {
                        BASE_SMALL.set(picks.smallBase);
                        BASE_LARGE.set(picks.largeBase);
                        ID_SMALL.set(picks.smallId);
                        ID_LARGE.set(picks.largeId);
                        save(context, picks);
                    }
                } catch (Exception e) {
                    // Best effort: keep whatever is already in force (cached pick or the origin).
                } finally {
                    refreshing = false;
                }
            }
        }, "art-source-refresh");
        t.setDaemon(true);
        t.start();
    }

    /** Only a host this build already trusts may serve art. */
    static boolean isAllowedHost(String host) {
        if (host == null) return false;
        String h = host.trim().toLowerCase(Locale.ROOT);
        return !h.isEmpty() && MIRROR_HOSTS.contains(h);
    }

    private static void save(Context context, Picks picks) {
        try {
            context.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit()
                    .putString(KEY_SMALL, picks.smallBase)
                    .putString(KEY_LARGE, picks.largeBase)
                    .putString("smallId", picks.smallId)
                    .putString("largeId", picks.largeId)
                    .putLong(KEY_AT, System.currentTimeMillis())
                    .apply();
        } catch (Exception e) {
            // Caching is an optimisation; losing it only costs a re-measure next launch.
        }
    }

    // ---- the pick ------------------------------------------------------------------------------

    private static final class Picks {
        final String smallId;
        final String smallBase;
        final String largeId;
        final String largeBase;

        Picks(String smallId, String smallBase, String largeId, String largeBase) {
            this.smallId = smallId;
            this.smallBase = smallBase;
            this.largeId = largeId;
            this.largeBase = largeBase;
        }
    }

    /** One measured mirror for one class: who it is, its score, and whether it failed outright. */
    private static final class Sample {
        final String id;
        final String base;
        final long scoreMs;   // latency class: median TTFB; throughput class: total ms for the sample
        final boolean failed;

        Sample(String id, String base, long scoreMs, boolean failed) {
            this.id = id;
            this.base = base;
            this.scoreMs = scoreMs;
            this.failed = failed;
        }
    }

    /**
     * Fetch the list, keep the sources that may serve art, measure each on the real paths of BOTH
     * classes, and return the two winners — each only if it beats the origin by {@link #MARGIN}.
     */
    private static Picks pick() throws Exception {
        JSONObject doc = new JSONObject(fetchText(MIRRORS_URL, 64 * 1024));
        JSONArray flat = doc.optJSONArray("flat");
        if (flat == null || flat.length() == 0) return null;

        List<JSONObject> candidates = new ArrayList<>();
        Set<String> domains = new HashSet<>();
        for (int i = 0; i < flat.length() && candidates.size() < MAX_CANDIDATES; i++) {
            JSONObject m = flat.optJSONObject(i);
            if (m == null) continue;
            if (!m.optBoolean("enabled", true)) continue;
            if (!m.optBoolean("assetEligible", true)) continue;
            if ("partial".equals(m.optString("coverage", ""))) continue;
            if (m.optBoolean("proxied", false)) continue;
            String root = trimSlash(m.optString("root", ""));
            if (root.isEmpty() || !isAllowedHost(hostOf(root))) continue;
            String domain = m.optString("faultDomain", hostOf(root));
            if (!domains.add(domain)) continue;
            candidates.add(m);
        }

        // The origin is measured on the same paths as everyone else, so "is the mirror better" is a
        // comparison of like with like rather than of a mirror against an assumed-fast default.
        Sample originSmall = measureClass(Line.ASSETS_CDN_PREFIX, null, SMALL_PATHS, true);
        Sample originLarge = measureClass(Line.ASSETS_CDN_PREFIX, null, LARGE_PATHS, false);

        Sample bestSmall = null;
        Sample bestLarge = null;
        for (JSONObject m : candidates) {
            String root = trimSlash(m.optString("root", ""));
            String id = m.optString("id", "");
            String base = root + "/assets/";
            Sample s = measureClass(base, id, SMALL_PATHS, true);
            if (!s.failed && (bestSmall == null || s.scoreMs < bestSmall.scoreMs)) bestSmall = s;
            Sample l = measureClass(base, id, LARGE_PATHS, false);
            if (!l.failed && (bestLarge == null || l.scoreMs < bestLarge.scoreMs)) bestLarge = l;
        }

        Sample small = wins(bestSmall, originSmall);
        Sample large = wins(bestLarge, originLarge);
        return new Picks(
                small == originSmall ? null : small.id, small.base,
                large == originLarge ? null : large.id, large.base);
    }

    /**
     * The winner of a class: the mirror only if it beats the origin by {@link #MARGIN}; otherwise the
     * origin. Rule 2 from the class comment — being wrong about the origin is the expensive direction.
     */
    private static Sample wins(Sample mirror, Sample origin) {
        if (mirror == null || mirror.failed) return origin;
        if (origin == null || origin.failed) return mirror;
        return mirror.scoreMs <= origin.scoreMs * (1 - MARGIN) ? mirror : origin;
    }

    /**
     * Measure one source over one class's real paths.
     *
     * <p>Latency class: the MEDIAN time-to-first-byte (what the workload pays 12k times).
     * Throughput class: the total time for the sample (what the bytes cost).
     */
    private static Sample measureClass(String base, String id, String[] paths, boolean latencyClass) {
        long[] values = new long[paths.length];
        int ok = 0;
        for (int i = 0; i < paths.length; i++) {
            long ms = fetchOne(base + paths[i], latencyClass);
            if (ms < 0) return new Sample(id, base, Long.MAX_VALUE, true);
            values[i] = ms;
            ok++;
        }
        if (ok == 0) return new Sample(id, base, Long.MAX_VALUE, true);
        java.util.Arrays.sort(values);
        long score = latencyClass ? values[values.length / 2] : values[values.length - 1];
        return new Sample(id, base, score, false);
    }

    /**
     * One real file: returns the metric the class cares about, or -1 when the source failed.
     *
     * @param latencyClass true → time to first byte; false → total time for the whole file.
     */
    private static long fetchOne(String url, boolean latencyClass) {
        HttpURLConnection conn = null;
        try {
            long t0 = System.currentTimeMillis();
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("Accept", "*/*");
            conn.setRequestProperty("Accept-Encoding", "identity");
            if (conn.getResponseCode() != 200) return -1;
            long ttfb = System.currentTimeMillis() - t0;
            InputStream in = new BufferedInputStream(conn.getInputStream());
            byte[] buf = new byte[8 * 1024];
            int total = 0;
            int n;
            // Latency class needs the first bytes only; throughput class must read the whole file.
            int cap = latencyClass ? PROBE_CAP : Integer.MAX_VALUE;
            while (total < cap && (n = in.read(buf, 0, Math.min(buf.length, cap - total))) > 0) total += n;
            in.close();
            if (total <= 0) return -1;
            return latencyClass ? ttfb : System.currentTimeMillis() - t0;
        } catch (Exception e) {
            return -1;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String fetchText(String url, int cap) throws Exception {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("Accept", "application/json");
            if (conn.getResponseCode() != 200) throw new IllegalStateException("HTTP " + conn.getResponseCode());
            InputStream in = new BufferedInputStream(conn.getInputStream());
            byte[] buf = new byte[8 * 1024];
            StringBuilder sb = new StringBuilder();
            int total = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > cap) break;
                sb.append(new String(buf, 0, n, "UTF-8"));
            }
            in.close();
            return sb.toString();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String trimSlash(String s) {
        String v = s == null ? "" : s.trim();
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        return v;
    }
}
