package icu.jiangjiangze.stronghold;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import javax.net.ssl.HttpsURLConnection;

/**
 * Remotely editable shell configuration ("可热更新网址"). The APK hardcodes only two
 * bootstrap URLs (both on the box's stable CF domain + a static mirror); everything
 * else — directory service URLs, fallback origins, STUN list, announcement — lives in
 * config.json, so changing any URL is a one-file edit on the box that every APK picks
 * up on next start. The last successful copy is cached in filesDir for offline use.
 *
 * <p><b>实例是不可变快照</b>（2026-10-08 起）：唯一真源是 {@link ShellConfigStore} 里的进程级快照，
 * {@link #load(Context)} 只是它的便捷入口。这样「刷新成功」对所有调用方立即可见，而不是各调用点
 * 各自读盘、各自看到不同版本。刷新请调用 {@link #refresh(Context)}（或 store 的同名方法）。
 */
public final class ShellConfig {

    private static final String[] BOOTSTRAP = {
            "https://stronghold.jiangjiangze.icu/dl/config.json",
    };
    private static final String CACHE = "shell-config.json";

    /** 本客户端理解的配置 schema；远程声明更高的 schema 时整份拒绝（保留 last-good，fail-closed）。 */
    static final int SUPPORTED_SCHEMA = 1;
    /** 远程配置体上限：防止超大/恶意响应把内存吃掉（方案 §16）。 */
    static final int MAX_BODY_BYTES = 256 * 1024;

    /** 默认值 + 磁盘缓存 + 远程覆盖合并后的最终视图。不可变——替换实例，不原地改。 */
    private final JSONObject json;
    /** 这份快照被标记的刷新时间（epoch ms）；0 = 尚未成功刷新过（用了内置默认/缓存）。 */
    private volatile long lastUpdated;

    private ShellConfig(JSONObject json) {
        this.json = json;
    }

    /** 兼容入口：返回**进程级共享快照**（首次调用读盘，之后零 IO）。 */
    public static ShellConfig load(Context ctx) {
        return ShellConfigStore.current(ctx);
    }

    /** 兼容入口：刷新共享快照并通知监听者。语义同 {@link ShellConfigStore#refresh(Context)}。 */
    public boolean refresh(Context ctx) {
        return ShellConfigStore.refresh(ctx);
    }

    // ------------------------------------------------------------------
    // 快照构造（由 ShellConfigStore 驱动）
    // ------------------------------------------------------------------

    /** 缓存 → 内置默认（不联网）。缺失/损坏的缓存静默降级为内置默认。 */
    static ShellConfig readSnapshot(Context ctx) {
        JSONObject cached = readCache(ctx);
        JSONObject base = defaults();
        if (cached != null) base = merge(base, cached);
        ShellConfig cfg = new ShellConfig(base);
        cfg.lastUpdated = parseEpoch(base.opt("lastUpdated"));
        return cfg;
    }

    /**
     * 拉远程配置。返回合并后的**新实例**；所有源都失败、或远端 schema 高于
     * {@link #SUPPORTED_SCHEMA}、或响应超限时返回 {@code null}（调用方保留 last-good）。
     */
    ShellConfig fetchRemote(Context ctx) {
        for (String url : BOOTSTRAP) {
            HttpURLConnection c = null;
            try {
                c = open(url, 8000, 8000);
                int code = c.getResponseCode();
                String body = code == 200 ? readAllCapped(c.getInputStream(), MAX_BODY_BYTES) : null;
                if (body == null) continue;
                JSONObject remote = new JSONObject(body);
                // fail-closed：远端声明了我们不认识的 schema（更高版本）时整份拒绝，而不是
                // 猜着用——猜错的代价是拿一个语义不同的配置去改线路/目录地址。
                int schema = remote.optInt("schema", SUPPORTED_SCHEMA);
                if (schema > SUPPORTED_SCHEMA) continue;
                JSONObject merged = merge(defaults(), remote);
                writeCache(ctx, merged);
                return new ShellConfig(merged);
            } catch (Exception ignored) {
                // try the next bootstrap
            } finally {
                if (c != null) c.disconnect();
            }
        }
        return null;
    }

    /** 标记刷新时间（由 store 在发布快照前调用）。 */
    void markUpdated(long epochMs) {
        lastUpdated = epochMs;
        try {
            json.put("lastUpdated", epochMs);
        } catch (org.json.JSONException ignored) {
            // 写不进去只影响下次读盘的初值，不影响内存视图
        }
    }

    /** 这份快照的刷新时间（epoch ms）；0 = 从未成功刷新（用内置默认/缓存）。 */
    public long lastUpdated() {
        return lastUpdated;
    }

    /** 远程配置声明的 schema（缺省 = 1）。 */
    public int schema() {
        return json.optInt("schema", SUPPORTED_SCHEMA);
    }

    /** 远程配置声明的版本号（整数；缺省 0）。 */
    public int version() {
        return json.optInt("version", 0);
    }

    public List<String> directoryUrls() {
        return stringList("directoryUrls", "https://spdir.jiangjiangze.icu");
    }

    public List<String> fallbackOrigins() {
        return stringList("fallbackOrigins",
                "https://map.u712507.nyat.app:38916",
                "https://stronghold.jiangjiangze.icu",
                "https://stronghold2.jiangjiangze.icu",
                "https://weishu2.jiangjiangze.icu");
    }

    public List<String> stunUrls() {
        return stringList("stunUrls",
                "stun:stun.qq.com:3478", "stun:stun.miwifi.com:3478", "stun:stun.l.google.com:19302");
    }

    public String announce() {
        return json.optString("announce", "");
    }

    public String configVersion() {
        return json.optString("configVersion", "builtin");
    }

    // ------------------------------------------------------------------

    private static JSONObject defaults() {
        try {
            return new JSONObject()
                    .put("directoryUrls", new JSONArray().put("https://spdir.jiangjiangze.icu"))
                    .put("fallbackOrigins", new JSONArray()
                            .put("https://map.u712507.nyat.app:38916")
                            .put("https://stronghold.jiangjiangze.icu")
                            .put("https://stronghold2.jiangjiangze.icu")
                            .put("https://weishu2.jiangjiangze.icu"))
                    .put("stunUrls", new JSONArray()
                            .put("stun:stun.qq.com:3478")
                            .put("stun:stun.miwifi.com:3478")
                            .put("stun:stun.l.google.com:19302"))
                    .put("schema", SUPPORTED_SCHEMA)
                    .put("configVersion", "builtin");
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static JSONObject merge(JSONObject base, JSONObject override) {
        try {
            JSONObject out = new JSONObject(base.toString());
            Iterator<String> keys = override.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                out.put(k, override.opt(k));
            }
            return out;
        } catch (org.json.JSONException e) {
            return base; // keep the built-in defaults if a remote entry is malformed
        }
    }

    private List<String> stringList(String key, String... fallback) {
        List<String> out = new ArrayList<>();
        JSONArray arr = json.optJSONArray(key);
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                String v = arr.optString(i, "");
                if (!v.isEmpty() && v.startsWith("https://")) out.add(v);
            }
        }
        if (out.isEmpty()) for (String f : fallback) out.add(f);
        return out;
    }

    private static JSONObject readCache(Context ctx) {
        try (FileInputStream in = new FileInputStream(new File(ctx.getFilesDir(), CACHE))) {
            byte[] buf = new byte[8192];
            int n = in.read(buf);
            if (n <= 0) return null;
            return new JSONObject(new String(buf, 0, n, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    private static void writeCache(Context ctx, JSONObject o) {
        try (FileOutputStream out = new FileOutputStream(new File(ctx.getFilesDir(), CACHE))) {
            out.write(o.toString().getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) {
        }
    }

    /** lastUpdated 可能来自 JSON（Integer/Long）或字符串；非数字一律 0。 */
    private static long parseEpoch(Object v) {
        if (v instanceof Number) return ((Number) v).longValue();
        if (v instanceof String) {
            try {
                return Long.parseLong(((String) v).trim());
            } catch (NumberFormatException ignored) {
                return 0;
            }
        }
        return 0;
    }

    /**
     * opens a bootstrap URL. https only, and the host must not be localhost / loopback / private /
     * reserved in ANY notation — reuse {@link ArtCdn#isBlockedLiteral(String)} so the "blocked
     * address" rule has exactly one implementation in the shell.
     */
    private static HttpURLConnection open(String spec, int connMs, int readMs) throws IOException {
        URL url = new URL(spec);
        String proto = url.getProtocol();
        String host = url.getHost() == null ? "" : url.getHost().toLowerCase(java.util.Locale.ROOT);
        if (!"https".equals(proto)) throw new IOException("non-https");
        if (ArtCdn.isBlockedLiteral(host)) throw new IOException("blocked host rejected");
        HttpsURLConnection c = (HttpsURLConnection) url.openConnection();
        c.setConnectTimeout(connMs);
        c.setReadTimeout(readMs);
        c.setRequestProperty("User-Agent", "stronghold-shell");
        return c;
    }

    /** Reads at most {@code max} bytes; returns null when the body exceeds it (reject, don't truncate). */
    private static String readAllCapped(InputStream in, int max) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (out.size() + n > max) return null;
            out.write(buf, 0, n);
        }
        return out.toString("UTF-8");
    }
}
