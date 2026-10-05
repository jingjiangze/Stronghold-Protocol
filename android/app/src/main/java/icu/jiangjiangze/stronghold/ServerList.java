package icu.jiangjiangze.stronghold;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The signed server list (最终执行方案-服务器清单与热更新.md §1.1, §2).
 *
 * Sources, in order: the live list at dl.jiangjiangze.icu → the R2 mirror → the last-good cache
 * on disk → the snapshot baked into the APK. Every remote copy must carry a valid Ed25519
 * signature over its canonical form, so a hostile mirror cannot inject servers; a source that
 * fails verification is discarded and the next one is used. Loading is a SWR two-phase pipeline
 * (审计 §2): {@link #loadCached} serves the cached/builtin snapshot with ZERO network so the panel
 * opens instantly, then {@link #refreshRemote} re-pulls the live list (verify + saveLastGood +
 * advisor) for the second push. Entries are probed concurrently and ranked by tier/weight, local
 * reachability history and latency.
 *
 * Version numbers (the embedded shared/constants.js PROTOCOL_VERSION / APP_VERSION versus the
 * server's /healthz) are SOFT signals only since v3.3: they feed the「版本不同」badge and never
 * gate a join. The APK's versionCode/versionName have nothing to do with any of it.
 */
public final class ServerList {

    /** Live sources, tried in order; each must verify. (dl.* is the Pages site: the list lives
     *  under /data/, not at the domain root — probing the root returns the HTML page.) */
    private static final String[] REMOTE = {
            "https://dl.jiangjiangze.icu/data/servers.json",
            "https://weishucdn.jiangjiangze.icu/site/servers.json",
    };
    private static final String BUILTIN = "shell/servers.json";
    private static final String PUBKEY = "shell/pubkey.bin";
    private static final int PROBE_TIMEOUT_MS = 8000;
    /**
     * Connect stays short so a dead host fails fast, while the read carries a slow first byte. The
     * old 3 s/3 s pair published slow-but-alive servers as "--" (no colour at all) although the
     * site's own probe — 6 s warm-up + 5 s sample, browser-side — still coloured them:
     * xiaolubao measured 5.6 s and misyra 6.7 s on 2026-10-04.
     */
    private static final int PROBE_CONNECT_MS = 4000;
    private static final int RATE_WINDOW = 10;
    private static final String PREFS = "shell";

    /**
     * Advisor-only「有效/无效」sources (审计 §2). This document is NOT signed, so it is used to
     * SUBTRACT only: an id outside its non-empty `valid` array is hidden; it can never add, enable
     * or un-hide anything. Tried in order; the dl.* copy is the preferred one but its /data/ root
     * currently serves the HTML site, so a parse failure simply falls through to the next.
     */
    private static final String[] VERIFIED = {
            "https://dl.jiangjiangze.icu/data/verified.json",
            "https://weishucdn.jiangjiangze.icu/site/verified.json",
    };
    private static final int VERIFIED_TIMEOUT_MS = 4000;
    /**
     * Hosts allowed for the UNSIGNED advisor fetch. Restricted to the project's own hosts so a
     * tampered config can never point the advisor at an arbitrary domain (no new domains, §2).
     */
    private static final java.util.Set<String> ADVISOR_HOSTS = new java.util.HashSet<>(java.util.Arrays.asList(
            "dl.jiangjiangze.icu", "weishucdn.jiangjiangze.icu",
            "stronghold.jiangjiangze.icu", "stronghold2.jiangjiangze.icu",
            "weishu.jiangjiangze.icu", "weishu2.jiangjiangze.icu"));
    /** Persisted copy of the last signature-verified live list (cold-start fallback). */
    private static final String LAST_GOOD = "servers-last-good.json";
    /**
     * SWR (审计 §2): a persisted last-good list NEVER expires out of use — an older file is still
     * preferred over the APK's baked baseline (which can be weeks older still). The TTL now only
     * affects the source label: past the window the panel shows「缓存清单(旧)」instead of
     *「缓存清单」.
     */
    private static final long LAST_GOOD_TTL_MS = 24L * 60 * 60 * 1000;
    /**
     * Persisted advisor verdict (审计 §2): the valid-id set from the last successful verified.json
     * fetch, so the cached phase can keep applying the subtract-only judgement offline. The file
     * is advisory data only (never trusted to ADD anything), so its absence is fail-open.
     */
    private static final String VERIFIED_LAST = "verified-last.json";

    private ServerList() {}

    /** One list entry plus its live probe results. */
    public static final class Entry {
        public String id = "";
        public String name = "";
        public String url = "";
        public String probe = "/healthz";
        public String region = "";
        public String note = "";
        public boolean enabled = true;
        public int tier = 0;
        public int weight = 100;
        public int protocol = -1;
        public String app = "";
        /** Per-entry updated stamp from the signed list ("" when absent; forward-compatible). */
        public String updated = "";
        /**
         * Advisor status (审计-本机服务与清单与404与更新.md §2): "" when unknown, "invalid" or
         * "pending" when the UNSIGNED verified.json advisor excluded this id. It is never trusted
         * to ENABLE anything — the advisor may only subtract (hide), so a hostile verified.json can
         * at worst hide a server, never inject one. Empty by default; the signed servers.json has no
         * such field today (forward-compatible via optString).
         */
        public String status = "";
        /** The advisor's top-level `updated` stamp that produced `status` ("" when unknown). */
        public String verifiedAt = "";

        public volatile long rttMs = -1;
        public volatile String serverVersion = "";
        public volatile String serverApp = "";
        /** True once a probe pass has reached a terminal verdict for this entry (v4.10: the lobby
         *  hides entries whose version could not be obtained — but only AFTER the verdict, so the
         *  grid never collapses while probes are still in flight). */
        public volatile boolean probed = false;
        public volatile int humans = -1;
        public volatile int rooms = -1;
        public volatile int matches = -1;
        public volatile long uptimeSec = -1;
        public volatile boolean reachable = false;
        public double successRate = 1.0;
        public boolean compatible = true;
        /**
         * App version differs from the local content (0.1.0 client vs 0.1.1 server …). SOFT since
         * v2.7.6 — the wire contract is `protocol`; the panel shows a「版本不同」badge, joins allowed.
         */
        public volatile boolean appMismatch = false;
        /**
         * CF Workers ports of the game (healthz `runtime:"cloudflare"`) are room-scoped: their
         * socket is /ws?room=&lt;CODE&gt; behind an auth step, not the plain /ws our client opens.
         * They are therefore usable only through their OWN client (see MainActivity's
         * remote-client flag), never by loading our embedded tree against them.
         *
         * Boundary (v2.8.5): the annotation + probe stay, but such entries are never listed —
         * MainActivity.getServerList() filters them out of the panel/lobby payload. The
         * invite-code path keeps its reachability: resolveInvite() may return them and
         * joinOnOrigin(id, code) still opens their url.
         */
        public volatile boolean roomScoped = false;

        String host() {
            try {
                String h = new URL(url).getHost();
                return h == null ? "" : h.toLowerCase(Locale.ROOT);
            } catch (Exception e) {
                return "";
            }
        }

        /**
         * True when this entry may be offered right now: enabled, not marked unavailable by the
         * advisor source, and carrying a public http(s) URL. `pending` is treated exactly like
         * `invalid` — both mean「不可用/待复核」and must not be offered or joined.
         */
        public boolean usable() {
            return enabled
                    && !"invalid".equals(status)
                    && !"pending".equals(status)
                    && isPublicHttpUrl(url);
        }

        /**
         * Hidden from the panel/lobby payload. Only the advisor's subtractive verdict hides an
         * entry; a merely disabled entry stays listed (the UI greys it out) so that usability and
         * display remain separate concerns.
         */
        public boolean hidden() {
            return "invalid".equals(status) || "pending".equals(status);
        }

        /** True when this entry may be joined right now (v3.3: compatibility never blocks). */
        public boolean joinable() {
            return usable();
        }

        JSONObject toJson() throws Exception {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("name", name);
            o.put("note", note == null ? "" : note);
            o.put("region", region == null ? "" : region);
            o.put("enabled", enabled);
            o.put("compatible", compatible);
            o.put("appMismatch", appMismatch);
            o.put("roomScoped", roomScoped);
            o.put("reachable", reachable);
            o.put("rttMs", rttMs);
            o.put("humans", humans);
            o.put("rooms", rooms);
            o.put("matches", matches);
            o.put("uptimeSec", uptimeSec);
            o.put("protocol", protocol);
            // The signed list carries no per-entry app today, so the version the panel shows comes
            // from the /healthz probe (measured app:"0.1.2"); the list's own value wins when set.
            String appOut = (app != null && !app.isEmpty()) ? app : (serverApp == null ? "" : serverApp);
            o.put("app", appOut);
            o.put("probed", probed); // v4.10: the lobby hides probed entries with no version
            o.put("updated", updated == null ? "" : updated);
            o.put("status", status == null ? "" : status);
            o.put("verifiedAt", verifiedAt == null ? "" : verifiedAt);
            o.put("tier", tier);
            o.put("weight", weight);
            return o;
        }
    }

    /** Result of loading: the ranked list plus where it came from (for the panel footer). */
    public static final class Snapshot {
        public final List<Entry> entries;
        public final String source; // "远端清单" | "缓存清单" | "缓存清单(旧)" | "内置清单"
        /** The signed doc's top-level `updated` stamp (ISO-8601); "" when the doc has none. */
        public final String updated;

        Snapshot(List<Entry> entries, String source, String updated) {
            this.entries = entries;
            this.source = source;
            this.updated = updated == null ? "" : updated;
        }
    }

    /** A signature-verified list plus the doc-level fields that are not per-server. */
    static final class ParsedList {
        final List<Entry> entries;
        final String updated;

        ParsedList(List<Entry> entries, String updated) {
            this.entries = entries;
            this.updated = updated == null ? "" : updated;
        }
    }

    // ------------------------------------------------------------------
    // Loading + verification (SWR two-phase: cached-first, then remote refresh)
    // ------------------------------------------------------------------

    /**
     * SWR phase 1 (审计 §2): builtin → last-good cache → ranked + advisor verdict. ZERO network:
     * the panel gets data instantly and the remote refresh re-pushes later. Order: the last
     * signature-verified live copy (re-verified here, never expiring — TTL only degrades the
     * source label to「缓存清单(旧)」) beats the APK's baked baseline; with no cache at all the
     * builtin snapshot is used. The persisted advisor verdict is applied subtract-only (fail-open
     * when the file is missing/corrupt).
     */
    public static Snapshot loadCached(Context ctx) {
        byte[] pub = publicKey(ctx);
        ParsedList builtin = parseVerified(readShellAsset(ctx, BUILTIN), pub);
        if (builtin == null) builtin = new ParsedList(new ArrayList<>(), "");
        ParsedList lastGood = readLastGood(ctx, pub);
        Snapshot snap;
        if (lastGood != null) {
            annotate(ctx, lastGood.entries);
            // TTL 已过只降级文案：内容本身仍验签通过，继续优先于可能更旧的内置基线（§2）。
            boolean stale = System.currentTimeMillis() - lastGoodFile(ctx).lastModified() > LAST_GOOD_TTL_MS;
            snap = new Snapshot(lastGood.entries, stale ? "缓存清单(旧)" : "缓存清单", lastGood.updated);
        } else {
            annotate(ctx, builtin.entries);
            snap = new Snapshot(builtin.entries, "内置清单", builtin.updated);
        }
        // 应用持久化的顾问判决（subtract-only；文件缺失/损坏 → 不过滤，fail-open）。
        applyPersistedAdvisor(ctx, snap.entries);
        return snap;
    }

    /**
     * SWR phase 2 (审计 §2): the REMOTE loop (verify + non-empty wins, success refreshes
     * saveLastGood) → annotate → advisor fetch with the valid-id set persisted to
     * verified-last.json (with its own updated stamp) → returns the「远端清单」snapshot. Returns
     * null on total failure — callers must keep showing the cached snapshot rather than overwrite
     * it with a worse one.
     */
    public static Snapshot refreshRemote(Context ctx) {
        byte[] pub = publicKey(ctx);
        if (pub == null) return null;
        ParsedList remote = null;
        for (String url : REMOTE) {
            if (!isPublicHttpUrl(url)) continue;
            // Cache-buster: a CDN/reverse-proxy copy of servers.json would otherwise be served
            // from cache and the panel would keep showing a stale list although the pull "worked".
            String body = httpGet(withCacheBuster(url), 6000);
            if (body == null) continue;
            ParsedList parsed = parseVerified(body, pub);
            if (parsed != null && !parsed.entries.isEmpty()) {
                remote = parsed;
                saveLastGood(ctx, body); // refresh the cold-start fallback with this verified body
                break; // a verified, non-empty live list wins outright (its deletions win too)
            }
        }
        if (remote == null) return null;
        annotate(ctx, remote.entries);
        Snapshot snap = new Snapshot(remote.entries, "远端清单", remote.updated);
        // 顾问源：拉到判决就持久化（供缓存段离线复用），拉不到则沿用旧文件（applyPersistedAdvisor）。
        Advisor adv = fetchAdvisor();
        if (adv != null) {
            saveVerifiedLast(ctx, adv);
            applyAdvisor(adv, snap.entries);
        } else {
            applyPersistedAdvisor(ctx, snap.entries);
        }
        return snap;
    }

    /** Persists the advisor verdict (valid-id set + updated stamp) for offline cached-phase use. */
    private static void saveVerifiedLast(Context ctx, Advisor adv) {
        try {
            JSONObject o = new JSONObject();
            o.put("updated", adv.updated == null ? "" : adv.updated);
            JSONArray arr = new JSONArray();
            for (String id : adv.valid) arr.put(id);
            o.put("valid", arr);
            writeAtomic(new File(ctx.getFilesDir(), VERIFIED_LAST), o.toString());
        } catch (Exception ignored) {
            // advisory data only — a full/read-only filesDir must never break the refresh
        }
    }

    /** Reads the persisted advisor verdict; null when missing/corrupt/empty (→ no filtering). */
    private static Advisor readVerifiedLast(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), VERIFIED_LAST);
            if (!f.isFile()) return null;
            byte[] buf = new byte[(int) f.length()];
            try (InputStream in = new FileInputStream(f)) {
                int off = 0;
                while (off < buf.length) {
                    int n = in.read(buf, off, buf.length - off);
                    if (n <= 0) break;
                    off += n;
                }
                if (off != buf.length) return null;
            }
            Advisor adv = parseAdvisor(new String(buf, StandardCharsets.UTF_8));
            return (adv != null && !adv.valid.isEmpty()) ? adv : null;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Cached-phase advisor application (审计 §2): the PERSISTED verdict, same subtract-only
     * semantics as the live one — ids outside the non-empty valid set are hidden, never un-hidden.
     * No file / unparsable → no-op (fail-open): availability beats tidiness.
     */
    static void applyPersistedAdvisor(Context ctx, List<Entry> list) {
        Advisor adv = readVerifiedLast(ctx);
        if (adv != null) applyAdvisor(adv, list);
    }

    /** Marks every entry whose id is absent from the advisor's valid set as `invalid` (hidden). */
    private static void applyAdvisor(Advisor adv, List<Entry> list) {
        for (Entry e : list) {
            if (e.id == null || e.id.isEmpty()) continue;
            if (!adv.valid.contains(e.id)) {
                e.status = "invalid";
                e.verifiedAt = adv.updated;
            }
        }
    }

    /** File holding the persisted last-good list (exposed for the TTL staleness check). */
    private static File lastGoodFile(Context ctx) {
        return new File(ctx.getFilesDir(), LAST_GOOD);
    }

    /** Result of the advisor fetch: the valid-id set plus its own `updated` stamp. */
    static final class Advisor {
        final java.util.Set<String> valid;
        final String updated;

        Advisor(java.util.Set<String> valid, String updated) {
            this.valid = valid;
            this.updated = updated == null ? "" : updated;
        }
    }

    /**
     * Fetches the advisor valid-id set from the whitelisted verified.json mirrors. Returns null
     * when no source yields a parseable, non-empty `valid` array — callers must then NOT filter.
     */
    static Advisor fetchAdvisor() {
        for (String url : VERIFIED) {
            if (!isAdvisorUrl(url)) continue;
            String body = httpGet(withCacheBuster(url), VERIFIED_TIMEOUT_MS);
            if (body == null) continue;
            Advisor adv = parseAdvisor(body);
            if (adv != null && !adv.valid.isEmpty()) return adv;
        }
        return null;
    }

    /** Parses {"valid":[…],"updated":…}; null when the body is not that JSON shape (the dl.*
     *  /data/verified.json currently serves the HTML site — this is the expected fall-through). */
    static Advisor parseAdvisor(String body) {
        if (body == null) return null;
        try {
            JSONObject doc = new JSONObject(body);
            JSONArray arr = doc.optJSONArray("valid");
            if (arr == null) return null;
            java.util.Set<String> ids = new java.util.LinkedHashSet<>();
            for (int i = 0; i < arr.length(); i++) {
                String id = arr.optString(i, "");
                if (!id.isEmpty()) ids.add(id);
            }
            return new Advisor(ids, doc.optString("updated", ""));
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Persists the raw bytes of a signature-verified live list for the next cold start — atomic:
     * write to a temp file in the same directory, then rename over the target, so a crash or OOM
     * mid-write can never leave a half-written last-good cache (which would fail verification and
     * silently fall back to the builtin baseline for days).
     */
    private static void saveLastGood(Context ctx, String body) {
        if (body == null || body.isEmpty()) return;
        try {
            writeAtomic(new File(ctx.getFilesDir(), LAST_GOOD), body);
        } catch (Exception ignored) {
            // a read-only/full filesDir must never break the list load
        }
    }

    /** Temp-file + rename atomic write (same directory → same filesystem, rename is atomic). */
    private static void writeAtomic(File target, String text) throws IOException {
        File tmp = new File(target.getParentFile(), target.getName() + ".tmp");
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(tmp)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        if (!tmp.renameTo(target)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw new IOException("atomic rename failed: " + target);
        }
    }

    /**
     * The persisted last-good list, RE-VERIFIED. Never expires out of use (SWR, 审计 §2): the TTL
     * only degrades the source label via {@link #loadCached}, because a 3-day-old verified list is
     * still strictly better than the APK's baked baseline (which can be weeks older still).
     */
    private static ParsedList readLastGood(Context ctx, byte[] pub) {
        try {
            File f = lastGoodFile(ctx);
            if (!f.isFile()) return null;
            byte[] buf = new byte[(int) f.length()];
            try (InputStream in = new FileInputStream(f)) {
                int off = 0;
                while (off < buf.length) {
                    int n = in.read(buf, off, buf.length - off);
                    if (n <= 0) break;
                    off += n;
                }
                if (off != buf.length) return null;
            }
            // never trusted blindly: a rewritten file must still carry a valid signature
            ParsedList p = parseVerified(new String(buf, StandardCharsets.UTF_8), pub);
            return (p != null && !p.entries.isEmpty()) ? p : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** Advisor URL validation: public http(s) AND an explicit project-host whitelist. */
    static boolean isAdvisorUrl(String url) {
        if (!isPublicHttpUrl(url)) return false;
        try {
            String host = new URL(url).getHost();
            return host != null && ADVISOR_HOSTS.contains(host.toLowerCase(Locale.ROOT));
        } catch (Exception e) {
            return false;
        }
    }

    /** Appends ?t=<epoch ms> so no cache can answer a refresh with a stale body. */
    static String withCacheBuster(String url) {
        if (url == null || url.isEmpty()) return url;
        return url + (url.indexOf('?') >= 0 ? '&' : '?') + "t=" + System.currentTimeMillis();
    }

    /** Parses a signed list; returns null unless the signature verifies. */
    static ParsedList parseVerified(String json, byte[] pub) {
        if (json == null || pub == null) return null;
        try {
            JSONObject doc = new JSONObject(json);
            if (!verifyDoc(doc, pub)) return null;
            JSONArray arr = doc.optJSONArray("servers");
            if (arr == null) return null;
            List<Entry> out = new ArrayList<>();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Entry e = fromJson(o);
                if (e != null) out.add(e);
            }
            return new ParsedList(out, doc.optString("updated", ""));
        } catch (Exception e) {
            return null;
        }
    }

    /** Signature check over the canonical form (sig field excluded). */
    static boolean verifyDoc(JSONObject doc, byte[] pub) {
        try {
            String sig = doc.optString("sig", "");
            if (sig.isEmpty()) return false;
            byte[] sigBytes = Base64.getDecoder().decode(sig);
            return Ed25519.verify(CanonicalJson.canonicalBytes(doc), sigBytes, pub);
        } catch (Exception e) {
            return false;
        }
    }

    private static Entry fromJson(JSONObject o) {
        Entry e = new Entry();
        e.id = o.optString("id", "");
        e.name = o.optString("name", "");
        e.url = o.optString("url", "");
        if (e.url.isEmpty() || !isPublicHttpUrl(e.url)) return null; // a hostile entry never loads
        e.url = e.url.replaceAll("/+$", "");
        e.probe = o.optString("probe", "/healthz");
        if (e.probe.isEmpty() || e.probe.charAt(0) != '/') e.probe = "/healthz";
        e.region = o.optString("region", "");
        e.note = o.optString("note", "");
        e.enabled = o.optBoolean("enabled", true);
        e.tier = o.optInt("tier", 0);
        e.weight = o.optInt("weight", 100);
        e.protocol = o.optInt("protocol", -1);
        e.app = o.optString("app", "");
        e.updated = o.optString("updated", "");
        // forward-compatible: the signed list may some day carry an advisor verdict inline
        e.status = o.optString("status", "");
        e.verifiedAt = o.optString("verifiedAt", "");
        if (e.id.isEmpty()) e.id = e.host();
        if (e.name.isEmpty()) e.name = e.id;
        return e;
    }

    /** Fills in the soft version signals + local success history. */
    private static void annotate(Context ctx, List<Entry> list) {
        String localApp = localApp(ctx);
        for (Entry e : list) {
            // v3.3: compatible is always true — protocol/app numbers are soft signals that only
            // feed the「版本不同」badge; they never gate a join.
            e.appMismatch = !e.app.isEmpty() && !e.app.equals(localApp);
            e.compatible = true;
            e.successRate = successRate(ctx, e.host());
        }
    }

    // ------------------------------------------------------------------
    // Probing + ranking
    // ------------------------------------------------------------------

    /** Probes every entry concurrently (3 s each) and records the outcome in the success window. */
    public static void probeAll(Context ctx, List<Entry> list) {
        List<Thread> threads = new ArrayList<>();
        for (Entry e : list) {
            Thread t = new Thread(() -> probeOne(ctx, e), "probe-" + e.id);
            t.start();
            threads.add(t);
        }
        // The join window must cover connect + read (2 × PROBE_TIMEOUT_MS), not just one of them:
        // with the old 4.5 s cutoff a slow-but-alive entry was published as unreachable while its
        // probe thread kept running, so the ranked snapshot (and the panel) missed it.
        for (Thread t : threads) {
            try {
                t.join(2L * PROBE_TIMEOUT_MS + 1500);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /** scheme://authority of a list URL; probes are built on it, never on the entry's path. */
    private static String originOf(String url) {
        try {
            java.net.URL u = new java.net.URL(url);
            int port = u.getPort();
            return u.getProtocol() + "://" + u.getHost() + (port > 0 ? ":" + port : "");
        } catch (Exception e) {
            return url;
        }
    }

    private static void probeOne(Context ctx, Entry e) {
        if (!e.enabled || !isPublicHttpUrl(e.url)) {
            e.reachable = false;
            e.rttMs = -1;
            e.probed = true; // terminal verdict: never probed → never returns a version
            return;
        }
        // The declared probe path first, then the site root — the site's own probe does the same,
        // and a server whose probe path is missing (404) is otherwise published as unreachable
        // although it answers fine on /. Only a network-level failure moves on to the next one.
        // Both are built on the ORIGIN: a list entry may carry a mount path (raiya/misyra are
        // `https://game.rainya.me/play` with probe `/api/status`), and appending the probe to that
        // path produced `/play/api/status` + `/play/` — both 404, so both servers were painted
        // unreachable although `/api/status` answers 200 on the origin.
        String origin = originOf(e.url);
        String primary = e.probe == null || e.probe.isEmpty() ? "/healthz" : e.probe;
        String[] targets = "/".equals(primary)
                ? new String[]{ origin + primary }
                : new String[]{ origin + primary, origin + "/" };
        for (String target : targets) {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(target).openConnection();
                c.setConnectTimeout(PROBE_CONNECT_MS);
                c.setReadTimeout(PROBE_TIMEOUT_MS);
                c.setRequestProperty("Accept", "application/json");
                c.setRequestProperty("User-Agent", "stronghold-shell");
                long t0 = System.nanoTime();
                int code = c.getResponseCode();
                long ms = Math.max(1, (System.nanoTime() - t0) / 1_000_000);
                // Any response is a timing sample (the site's no-cors probe times even a 502), but
                // the colour must still separate "up and healthy" from "up and erroring": a non-2xx
                // keeps its latency and stays unreachable, which the panel paints red rather than
                // green. (502 anciusland / 429 rincynar measured on 2026-10-04.)
                e.rttMs = ms;
                if (code < 200 || code >= 300) {
                    e.reachable = false;
                    e.probed = true;
                    recordOutcome(ctx, e.host(), false);
                    return;
                }
                e.reachable = true;
                String body = readAll(c.getInputStream());
                try {
                    JSONObject o = new JSONObject(body);
                    e.serverVersion = o.optString("version", "");
                    e.serverApp = o.optString("app", "");
                    // CF Workers ports report {runtime:"cloudflare", version:"0.1.0", build:"…"}: there
                    // `version` is the APP version and no protocol number is reported at all, so a plain
                    // comparison against PROTOCOL_VERSION would wrongly mark the server incompatible.
                    // Normalise the shape (and remember that joining needs their own client).
                    if ("cloudflare".equalsIgnoreCase(o.optString("runtime", ""))) {
                        e.roomScoped = true;
                        if (e.serverApp.isEmpty()) e.serverApp = e.serverVersion;
                        e.serverVersion = "";
                    }
                    e.humans = o.optInt("humans", -1);
                    e.rooms = o.optInt("rooms", -1);
                    e.matches = o.optInt("matches", -1);
                    e.uptimeSec = o.optLong("uptimeSec", -1);
                } catch (Exception ignored) {
                    // reachable but not a Stronghold server: latency still counts
                }
                // v3.3: the protocol/app numbers no longer gate anything — a differing server app is
                // still recorded to feed the「版本不同」badge, but the entry always stays joinable.
                String localApp = localApp(ctx);
                if (!e.serverApp.isEmpty()) e.appMismatch = !e.serverApp.equals(localApp);
                e.probed = true;
                recordOutcome(ctx, e.host(), true);
                return;
            } catch (Exception ex) {
                // network-level failure (DNS/TLS/timeout): fall through to the next candidate
            } finally {
                if (c != null) c.disconnect();
            }
        }
        e.reachable = false;
        e.rttMs = -1;
        e.probed = true;
        recordOutcome(ctx, e.host(), false);
    }

    /** tier/weight desc → success rate (below 0.5 sinks to the bottom) desc → latency asc. */
    public static void rank(List<Entry> list) {
        Collections.sort(list, new Comparator<Entry>() {
            @Override
            public int compare(Entry a, Entry b) {
                if (a.tier != b.tier) return b.tier - a.tier;
                if (a.weight != b.weight) return b.weight - a.weight;
                boolean aBad = a.successRate < 0.5;
                boolean bBad = b.successRate < 0.5;
                if (aBad != bBad) return aBad ? 1 : -1;
                int rate = Double.compare(b.successRate, a.successRate);
                if (rate != 0) return rate;
                long ar = a.rttMs <= 0 ? Long.MAX_VALUE : a.rttMs;
                long br = b.rttMs <= 0 ? Long.MAX_VALUE : b.rttMs;
                return Long.compare(ar, br);
            }
        });
    }

    // ------------------------------------------------------------------
    // Consent (免责声明) — per host, persisted
    // ------------------------------------------------------------------

    public static boolean hasConsent(Context ctx, String host) {
        return prefs(ctx).getBoolean("consent:" + host, false);
    }

    public static void grantConsent(Context ctx, String host) {
        prefs(ctx).edit().putBoolean("consent:" + host, true).apply();
    }

    /** Revokes consent for one host (used when the player stops using that server's own client). */
    public static void revokeConsent(Context ctx, String host) {
        if (host == null || host.isEmpty()) return;
        prefs(ctx).edit().remove("consent:" + host).apply();
    }

    public static void clearConsent(Context ctx) {
        SharedPreferences p = prefs(ctx);
        SharedPreferences.Editor ed = p.edit();
        for (String k : p.getAll().keySet()) {
            if (k.startsWith("consent:")) ed.remove(k);
        }
        ed.apply();
    }

    // ------------------------------------------------------------------
    // Version axis: the embedded upstream client's own numbers
    // ------------------------------------------------------------------

    /** PROTOCOL_VERSION from the embedded shared/constants.js (falls back to the build's value). */
    public static int localProtocol(Context ctx) {
        String js = readClientConstants(ctx);
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("PROTOCOL_VERSION\\s*=\\s*(\\d+)").matcher(js);
        if (m.find()) {
            try {
                return Integer.parseInt(m.group(1));
            } catch (NumberFormatException ignored) {
            }
        }
        return BuildConfig.EMBEDDED_PROTOCOL_VERSION;
    }

    /** APP_VERSION from the embedded shared/constants.js (falls back to the build's value). */
    public static String localApp(Context ctx) {
        String js = readClientConstants(ctx);
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("APP_VERSION\\s*=\\s*'([^']+)'").matcher(js);
        if (m.find()) return m.group(1);
        return BuildConfig.EMBEDDED_APP_VERSION;
    }

    private static String readClientConstants(Context ctx) {
        InputStream in = openLocal(ctx, "/shared/constants.js");
        if (in == null) return "";
        try {
            return readAll(in);
        } catch (IOException e) {
            return "";
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
            }
        }
    }

    // ------------------------------------------------------------------
    // Assets / network / security
    // ------------------------------------------------------------------

    /** Public key pinned into the APK (raw 32 bytes). */
    public static byte[] publicKey(Context ctx) {
        try {
            InputStream in = ctx.getAssets().open(PUBKEY);
            byte[] buf = new byte[32];
            int off = 0;
            while (off < 32) {
                int n = in.read(buf, off, 32 - off);
                if (n <= 0) break;
                off += n;
            }
            in.close();
            return off == 32 ? buf : null;
        } catch (IOException e) {
            return null;
        }
    }

    private static String readShellAsset(Context ctx, String name) {
        try {
            InputStream in = ctx.getAssets().open(name);
            String s = readAll(in);
            in.close();
            return s;
        } catch (IOException e) {
            return null;
        }
    }

    private static InputStream openLocal(Context ctx, String path) {
        File f = new File(HostService.contentRoot(ctx), path);
        if (f.isFile()) {
            try {
                return new FileInputStream(f);
            } catch (IOException ignored) {
            }
        }
        try {
            return ctx.getAssets().open("webroot" + path);
        } catch (IOException notFound) {
            return null;
        }
    }

    private static String httpGet(String url, int timeoutMs) {
        if (!isPublicHttpUrl(url)) return null;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setRequestProperty("User-Agent", "stronghold-shell");
            c.setUseCaches(false);
            c.setRequestProperty("Cache-Control", "no-cache");
            if (c.getResponseCode() != 200) return null;
            return readAll(c.getInputStream());
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /**
     * The one place outbound hosts are validated: http(s) only, no credentials, and no
     * localhost/loopback/private/link-local/reserved literal (a hostile list must not turn
     * the app into an intranet scanner). Hardened (审计 §4): IPv4-mapped/compatible IPv6
     * literals (::ffff:127.0.0.1 and the pure-hex form ::ffff:7f00:1) are unwrapped and
     * re-checked against the IPv4 table, NAT64 64:ff9b::/96 is rejected outright, and a bare
     * numeric host (e.g. {@code 2130706433} = 127.0.0.1 in integer form) is rejected.
     *
     * Portability note: desktop JDK keeps the brackets in {@code URL.getHost()} while some
     * Android libcore versions strip them — brackets are stripped defensively here and the v6
     * path dispatches on the presence of ':' in the host, so mapped literals are caught on both.
     */
    public static boolean isPublicHttpUrl(String url) {
        if (url == null) return false;
        URL u;
        try {
            u = new URL(url);
        } catch (Exception e) {
            return false;
        }
        String scheme = u.getProtocol();
        if (!"http".equals(scheme) && !"https".equals(scheme)) return false;
        if (u.getUserInfo() != null && !u.getUserInfo().isEmpty()) return false;
        String host = u.getHost();
        if (host == null || host.isEmpty()) return false;
        host = host.toLowerCase(Locale.ROOT);
        if (host.startsWith("[") && host.endsWith("]")) {
            host = host.substring(1, host.length() - 1); // desktop JDK keeps the brackets
        }
        if (host.equals("localhost") || host.endsWith(".localhost")
                || host.endsWith(".local") || host.endsWith(".internal")) return false;
        if (host.indexOf('%') >= 0) return false; // zone-scoped (fe80::1%wlan0) is never public
        if (host.indexOf(':') >= 0) { // IPv6 literal (bracketed or not, depending on the runtime)
            String expanded = expandV6(host);
            if (expanded == null) return false; // unparsable literal → reject
            // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052): the trailing 32 bits are an IPv4
            // literal, and a DNS64/NAT64 path is by definition not a public origin — reject.
            if (expanded.startsWith("0064ff9b00000000")) return false;
            // v4-embedded forms (first 64 bits all zero): IPv4-mapped ::ffff:a.b.c.d (80 zero
            // bits + ffff), IPv4-compatible ::a.b.c.d / :: / ::1 (96 zero bits), and the
            // RFC 2765 translated form ::ffff:0:a.b.c.d — unwrap the low 32 bits and apply the
            // IPv4 table, so none of them can dress a loopback/private v4 up as "public v6".
            if (expanded.startsWith("0000000000000000")) {
                return isPublicIpv4(v4FromHexTail(expanded));
            }
            if (expanded.startsWith("fc") || expanded.startsWith("fd")) {
                return false; // unique-local fc00::/7
            }
            if (expanded.startsWith("fe8") || expanded.startsWith("fe9")
                    || expanded.startsWith("fea") || expanded.startsWith("feb")) {
                return false; // link-local fe80::/10
            }
            return true;
        }
        // 纯数字/十六进制整数形态的主机（无点，如 "2130706433" 或 "0x7f000001" — InetAddress
        // 会把它们当 127.0.0.1 解析，但 URL 层查表漏掉）→ 一律拒绝。公网域名不长这样。
        if (host.matches("\\d+") || host.matches("0x[0-9a-f]+")) return false;
        if (host.matches("\\d{1,3}(\\.\\d{1,3}){3}")) {
            return isPublicIpv4(host.replace('.', ':'));
        }
        return true;
    }

    /** The IPv4 deny table; {@code dotted} is ':'-separated ("127:0:0:1"). */
    private static boolean isPublicIpv4(String dotted) {
        String[] p = dotted.split(":");
        if (p.length != 4) return false;
        int a, b, c, d;
        try {
            a = Integer.parseInt(p[0]);
            b = Integer.parseInt(p[1]);
            c = Integer.parseInt(p[2]);
            d = Integer.parseInt(p[3]);
        } catch (NumberFormatException e) {
            return false;
        }
        if (a < 0 || a > 255 || b < 0 || b > 255 || c < 0 || c > 255 || d < 0 || d > 255) {
            return false; // out-of-range octet in a hand-written literal → not resolvable publicly
        }
        if (a == 0 || a == 10 || a == 127) return false;
        if (a == 169 && b == 254) return false;
        if (a == 172 && b >= 16 && b <= 31) return false;
        if (a == 192 && b == 168) return false;
        if (a == 100 && b >= 64 && b <= 127) return false;
        if (a >= 224) return false;
        return true;
    }

    /** Last 32 bits of a 32-char hex expansion, as "a:b:c:d" (':'-separated decimal). */
    private static String v4FromHexTail(String expanded) {
        return Integer.parseInt(expanded.substring(24, 26), 16) + ":"
                + Integer.parseInt(expanded.substring(26, 28), 16) + ":"
                + Integer.parseInt(expanded.substring(28, 30), 16) + ":"
                + Integer.parseInt(expanded.substring(30, 32), 16);
    }

    /**
     * Expands an IPv6 literal (dotted-quad tail allowed) to 32 hex chars. Returns null when the
     * literal is malformed — callers must treat null as "not public".
     */
    static String expandV6(String v6) {
        if (v6 == null || v6.isEmpty()) return null;
        int dc = v6.indexOf("::");
        if (dc >= 0 && v6.indexOf("::", dc + 1) >= 0) return null; // at most one "::"
        // Embedded IPv4 dotted quad (must be the tail, e.g. ::ffff:127.0.0.1) → two hex groups.
        int dot = v6.lastIndexOf('.');
        if (dot >= 0) {
            String[] q = v6.substring(v6.lastIndexOf(':') + 1).split("\\.");
            if (q.length != 4) return null;
            int[] n = new int[4];
            try {
                for (int i = 0; i < 4; i++) {
                    n[i] = Integer.parseInt(q[i]);
                    if (n[i] < 0 || n[i] > 255) return null;
                }
            } catch (NumberFormatException e) {
                return null;
            }
            v6 = v6.substring(0, v6.lastIndexOf(':') + 1)
                    + String.format("%02x%02x:%02x%02x", n[0], n[1], n[2], n[3]);
            dc = v6.indexOf("::");
        }
        String head = dc >= 0 ? v6.substring(0, dc) : v6;
        String tail = dc >= 0 ? v6.substring(dc + 2) : "";
        List<String> groups = new ArrayList<>();
        for (String part : head.split(":", -1)) if (!part.isEmpty()) groups.add(part);
        int tailCount = 0;
        if (dc >= 0) {
            if (!tail.isEmpty()) {
                for (String part : tail.split(":", -1)) {
                    if (!part.isEmpty()) groups.add(part);
                    tailCount++;
                }
            }
            int fill = 8 - groups.size();
            if (fill < 1) return null; // "::" must stand for at least one zero group
            groups.addAll(groups.size() - tailCount, java.util.Collections.nCopies(fill, "0"));
        }
        if (groups.size() != 8) return null;
        StringBuilder sb = new StringBuilder(32);
        for (String g : groups) {
            if (g.isEmpty() || g.length() > 4 || !g.matches("[0-9a-f]+")) return null;
            sb.append("0000".substring(g.length())).append(g);
        }
        return sb.toString();
    }

    // ------------------------------------------------------------------
    // Local success window (last 10 probes per host)
    // ------------------------------------------------------------------

    private static double successRate(Context ctx, String host) {
        if (host == null || host.isEmpty()) return 1.0;
        String w = prefs(ctx).getString("sr:" + host, "");
        if (w.isEmpty()) return 1.0;
        int hits = 0;
        for (int i = 0; i < w.length(); i++) if (w.charAt(i) == '1') hits++;
        return (double) hits / w.length();
    }

    private static void recordOutcome(Context ctx, String host, boolean ok) {
        if (host == null || host.isEmpty()) return;
        String w = prefs(ctx).getString("sr:" + host, "");
        w = w + (ok ? '1' : '0');
        if (w.length() > RATE_WINDOW) w = w.substring(w.length() - RATE_WINDOW);
        prefs(ctx).edit().putString("sr:" + host, w).apply();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toString("UTF-8");
    }

    /** Panel payload: the ranked list as JSON (labels only — no domains ever reach the page).
     *  Advisor-invalidated entries are omitted here so they never appear in the panel/lobby; the
     *  join paths additionally gate on joinable(), and the page re-filters on `status` for old
     *  payloads. */
    public static String toPanelJson(List<Entry> list) {
        try {
            JSONArray arr = new JSONArray();
            for (Entry e : list) {
                if (e.hidden()) continue;
                arr.put(e.toJson());
            }
            return arr.toString();
        } catch (Exception e) {
            return "[]";
        }
    }

    /** Maps an entry id back to its url (used by the panel's setServer). */
    public static Map<String, String> urlById(List<Entry> list) {
        Map<String, String> m = new LinkedHashMap<>();
        for (Entry e : list) m.put(e.id, e.url);
        return m;
    }
}
