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
 * Which mirror THIS device actually downloads art from, for this session.
 *
 * <p>WHY: the asset base used to be a compile-time constant ({@link Line#ASSETS_CDN_PREFIX}). A
 * deployment in one network and a player in another do not agree on which mirror is fastest, so the
 * choice has to be made per device — and the only vantage point that can measure "this device's link
 * to each mirror" is the device itself.
 *
 * <p>FAIL-SAFE BY CONSTRUCTION: every failure path (no network, unparseable list, nothing answers,
 * an answer that is not one of the allowed hosts) leaves {@link #base()} at the compile-time
 * constant. A device that cannot measure behaves EXACTLY as it did before this class existed, so the
 * blast radius of the whole feature is "the pick succeeded and was right, or nothing changed".
 *
 * <p>WHAT IT WILL NOT DO: it never invents a host. A mirror is usable only if its host is in
 * {@link #mirrorHosts()} — the same fail-closed allow-list idea {@link ArtCdn} already uses for the
 * fallback — and it never picks a source the published list marks as unable to serve art
 * ({@code assetEligible:false} / {@code coverage:"partial"}) or as a Worker relay ({@code proxied}),
 * because a relay carries every byte through a Worker and the free-plan request budget cannot pay
 * for bulk traffic.
 *
 * <p>COST: one list fetch plus one small capped probe per candidate, once per {@link #TTL_MS}, and
 * it is cached across launches. It never blocks startup: {@link #refresh} runs on its own thread and
 * the page keeps using {@link Line#ASSETS_CDN_PREFIX} until a pick is ready.
 */
final class ArtSource {

    private ArtSource() {
    }

    /** The published mirror list. Read from the line's own CDN, like every other interface file. */
    static final String MIRRORS_URL = Line.CDN + "/cdn/v1/mirrors.json";

    /** Mirror hosts this build is willing to fetch art from. Fail-closed: anything else is refused. */
    private static final Set<String> MIRROR_HOSTS = buildMirrorHosts();

    private static final String PREF = "sp-art-source";
    private static final String KEY_ID = "id";
    private static final String KEY_AT = "at";
    private static final String KEY_BASE = "base";

    /** A pick older than this is re-measured. Six hours matches the picker's own TTL. */
    static final long TTL_MS = 6L * 60 * 60 * 1000;

    /** Bytes read per probe. Small on purpose: the pick is a link sample, not a download. */
    private static final int PROBE_CAP = 32 * 1024;
    private static final int TIMEOUT_MS = 6000;
    private static final int MAX_CANDIDATES = 5;

    private static final AtomicReference<String> BASE = new AtomicReference<>(null);
    private static final AtomicReference<String> ID = new AtomicReference<>(null);
    private static volatile boolean refreshing = false;

    private static Set<String> buildMirrorHosts() {
        Set<String> s = new HashSet<>();
        // The line's own origins (r2 + the Pages mirror) and the public git-mount chains. Kept here,
        // not read from the network, so a tampered list can never point the device somewhere new.
        // Parsed locally, NOT via ArtCdn.hostOf: ArtCdn's allow-list is built from this set, and a
        // mutual static call would leave one of the two classes half-initialised.
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

    /** The asset base prefix in use right now (always ends with "/"). */
    static String base() {
        String b = BASE.get();
        return b != null ? b : Line.ASSETS_CDN_PREFIX;
    }

    /** Id of the picked mirror, or null when the compile-time default is in use. Diagnostics only. */
    static String chosenId() {
        return ID.get();
    }

    /** Adopt a cached pick if it is still fresh, so the first screen does not wait for a re-measure. */
    static void loadCached(Context context) {
        try {
            SharedPreferences p = context.getSharedPreferences(PREF, Context.MODE_PRIVATE);
            String id = p.getString(KEY_ID, null);
            String base = p.getString(KEY_BASE, null);
            long at = p.getLong(KEY_AT, 0);
            if (id == null || base == null || at <= 0) return;
            if (System.currentTimeMillis() - at >= TTL_MS) return;
            if (!isAllowedHost(hostOf(base))) return;
            ID.set(id);
            BASE.set(base);
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
                    Pick pick = pick(context);
                    if (pick != null) {
                        ID.set(pick.id);
                        BASE.set(pick.base);
                        save(context, pick);
                    }
                } catch (Exception e) {
                    // Best effort: keep whatever is already in force (cached pick or the constant).
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

    private static void save(Context context, Pick pick) {
        try {
            context.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit()
                    .putString(KEY_ID, pick.id)
                    .putString(KEY_BASE, pick.base)
                    .putLong(KEY_AT, System.currentTimeMillis())
                    .apply();
        } catch (Exception e) {
            // Caching is an optimisation; losing it only costs a re-measure next launch.
        }
    }

    // ---- the pick ------------------------------------------------------------------------------

    /** One measured mirror: its published id and the asset base that goes with it. */
    private static final class Pick {
        final String id;
        final String base;
        final long bytesPerSec;

        Pick(String id, String base, long bytesPerSec) {
            this.id = id;
            this.base = base;
            this.bytesPerSec = bytesPerSec;
        }
    }

    /**
     * Fetch the list, keep the sources that may serve art, probe each on the path IT declares, and
     * return the fastest. Returns null when nothing usable answered — the caller then leaves the
     * compile-time base in force.
     */
    private static Pick pick(Context context) throws Exception {
        JSONObject doc = new JSONObject(fetchText(MIRRORS_URL, 64 * 1024));
        JSONArray flat = doc.optJSONArray("flat");
        if (flat == null || flat.length() == 0) return null;

        List<JSONObject> candidates = new ArrayList<>();
        Set<String> domains = new HashSet<>();
        for (int i = 0; i < flat.length() && candidates.size() < MAX_CANDIDATES; i++) {
            JSONObject m = flat.optJSONObject(i);
            if (m == null) continue;
            if (m.optBoolean("enabled", true) == false) continue;
            if (m.optBoolean("assetEligible", true) == false) continue;
            if ("partial".equals(m.optString("coverage", ""))) continue;
            if (m.optBoolean("proxied", false)) continue;
            String root = trimSlash(m.optString("root", ""));
            if (root.isEmpty() || !isAllowedHost(hostOf(root))) continue;
            // One probe per fault domain: two custom domains on one bucket are one backend.
            String domain = m.optString("faultDomain", hostOf(root));
            if (!domains.add(domain)) continue;
            candidates.add(m);
        }
        if (candidates.isEmpty()) return null;

        Pick best = null;
        for (JSONObject m : candidates) {
            try {
                String root = trimSlash(m.optString("root", ""));
                String probe = m.optString("probe", "");
                if (probe.isEmpty()) probe = "/robots.txt";
                Sample s = probe(root + probe);
                if (s == null) continue;
                if (best == null || s.bytesPerSec > best.bytesPerSec) {
                    best = new Pick(m.optString("id", ""), root + "/assets/", s.bytesPerSec);
                }
            } catch (Exception e) {
                // A source that fails simply loses the race.
            }
        }
        return best;
    }

    /** TTFB + throughput for one probe, capped so a probe never becomes a download. */
    private static final class Sample {
        final long ttfbMs;
        final int bytes;
        final long bytesPerSec;

        Sample(long ttfbMs, int bytes, long bytesPerSec) {
            this.ttfbMs = ttfbMs;
            this.bytes = bytes;
            this.bytesPerSec = bytesPerSec;
        }
    }

    private static Sample probe(String url) {
        HttpURLConnection conn = null;
        try {
            long t0 = System.currentTimeMillis();
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("Accept", "*/*");
            conn.setRequestProperty("Accept-Encoding", "identity");
            int code = conn.getResponseCode();
            long ttfb = System.currentTimeMillis() - t0;
            if (code != 200) return null;
            int declared = conn.getContentLength();
            InputStream in = new BufferedInputStream(conn.getInputStream());
            byte[] buf = new byte[8 * 1024];
            int total = 0;
            while (total < PROBE_CAP) {
                int n = in.read(buf, 0, Math.min(buf.length, PROBE_CAP - total));
                if (n <= 0) break;
                total += n;
            }
            in.close();
            long bodyMs = Math.max(1, System.currentTimeMillis() - t0 - ttfb);
            if (total <= 0) return null;
            // A 200 that delivered less than it declared is a truncating mirror, not a fast one.
            if (declared > 0 && total < Math.min(declared, PROBE_CAP)) return null;
            return new Sample(ttfb, total, (long) total * 1000L / bodyMs);
        } catch (Exception e) {
            return null;
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
