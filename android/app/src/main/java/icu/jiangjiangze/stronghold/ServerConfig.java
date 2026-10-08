package icu.jiangjiangze.stronghold;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 服务器配置协议（方案 §5）——**纯解析/校验，零 IO、零 Android 依赖**，JVM 可直接测。
 *
 * <p>服务器通过自己 origin 下的 `/.well-known/stronghold-client.json`（或兜底路径，见
 * {@link ServerConfigStore}）声明它想控制的东西：公告、匹配参数、开关、活动时间、Feature 引用。
 * 它是**声明式数据**，不是代码：本类刻意不提供任何「执行」入口，也不认识 URL 之外的任何东西。
 *
 * <h3>服务器能控制 / 不能控制（§5 硬边界，代码即边界）</h3>
 * <ul>
 *   <li><b>能</b>：公告文字、开关、模式列表、匹配参数、规则数值、活动时间、API 相对路径、
 *       服务器自己的资源路径（相对）。</li>
 *   <li><b>不能</b>：任意 JS / eval / APK 安装 / Android 权限 / 签名公钥 / CDN 信任根 /
 *       WebView 安全策略 / 任意文件路径 / 任意外部 URL。这些不是「本类不读」，而是
 *       <b>本类没有对应的字段和出口</b>——没有字段就没有注入面。</li>
 * </ul>
 *
 * <h3>未知内容一律安全忽略（§14 cases 13、16）</h3>
 * 未知键、未知 feature、坏类型：跳过该条并继续，而不是整份失败——服务器可以先于客户端升级。
 * 唯一整份拒绝的是 {@code schema} 高于 {@link #SUPPORTED_SCHEMA}（语义可能不同，猜不得）。
 */
public final class ServerConfig {

    /** 本客户端理解的服务器配置 schema。 */
    public static final int SUPPORTED_SCHEMA = 1;
    /** 远程配置体上限（§16）。 */
    public static final int MAX_BODY_BYTES = 256 * 1024;
    /** 单条公告正文字符上限：公告要显示在面板里，超长既没用又会挤爆布局。 */
    public static final int MAX_ANNOUNCE_CHARS = 4000;
    /** 一个 feature id 的合法形态（与 pack id 同族：禁 `/`、`.`、`..`）。 */
    static final String FEATURE_ID_RE = "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$";

    private final int schema;
    private final String serverId;
    private final int version;
    private final int ttl;
    private final Announce announce;          // 可为 null（无公告）
    private final Matchmaking matchmaking;    // 可为 null（未声明）
    private final List<Feature> features;     // 只含**解析成功**的条目
    private final List<FeaturePackRef> featurePacks;
    private final int minShellApi;
    private final boolean serveAssets;

    private ServerConfig(int schema, String serverId, int version, int ttl, Announce announce,
                         Matchmaking matchmaking, List<Feature> features,
                         List<FeaturePackRef> featurePacks, int minShellApi, boolean serveAssets) {
        this.schema = schema;
        this.serverId = serverId;
        this.version = version;
        this.ttl = ttl;
        this.announce = announce;
        this.matchmaking = matchmaking;
        this.features = Collections.unmodifiableList(features);
        this.featurePacks = Collections.unmodifiableList(featurePacks);
        this.minShellApi = minShellApi;
        this.serveAssets = serveAssets;
    }

    // ------------------------------------------------------------------
    // 解析
    // ------------------------------------------------------------------

    /**
     * 解析一份服务器配置。返回 null = 这份配置不可用（坏 JSON / schema 过高 / body 超限），
     * 调用方必须保留 last-good。
     */
    public static ServerConfig parse(String body, String expectServerId) {
        if (body == null || body.isEmpty()) return null;
        if (body.length() > MAX_BODY_BYTES) return null; // 字符数 ≥ 字节数，先挡一道
        JSONObject o;
        try {
            o = new JSONObject(body);
        } catch (Exception e) {
            return null;
        }
        int schema = o.optInt("schema", SUPPORTED_SCHEMA);
        if (schema < 1 || schema > SUPPORTED_SCHEMA) return null; // 未知语义 → 整份拒绝

        String serverId = o.optString("serverId", "");
        // serverId 是**校验**字段不是身份来源：服务器不能靠改名去读别的服务器的缓存。
        // 声明了就必须与期望值一致（大小写不敏感）；没声明则接受。
        if (expectServerId != null && !expectServerId.isEmpty() && !serverId.isEmpty()
                && !serverId.equalsIgnoreCase(expectServerId)) {
            return null;
        }

        int version = Math.max(0, o.optInt("version", 0));
        int ttl = clampTtl(o.optInt("ttl", 300));

        return new ServerConfig(schema, serverId, version, ttl,
                parseAnnounce(o.optJSONObject("announce")),
                parseMatchmaking(o.optJSONObject("matchmaking")),
                parseFeatures(o.optJSONObject("features")),
                parseFeaturePacks(o.optJSONArray("featurePacks")),
                Math.max(0, o.optJSONObject("client") == null ? 0
                        : o.optJSONObject("client").optInt("minShellApi", 0)),
                parseServeAssets(o.optJSONObject("resources")));
    }

    /**
     * {@code resources.serveAssets} —— 服务器声明「我自己的 origin 下也提供 /assets/**」。
     * <p>默认 **false**：官方服的素材在 CDN 上，把「先问服务器」变成默认会给每个素材加一次 404
     * 往返（客户端预取要走上万条），所以必须是服务器主动声明的能力，而不是客户端猜的。
     * <p>它只影响**取字节的顺序**（见 {@link ResourceResolver#assetPlan(boolean)}），不影响信任：
     * 从服务器取回的素材与从 CDN 取回的一样是 best-effort 未逐文件签名的字节。
     */
    private static boolean parseServeAssets(JSONObject o) {
        return o != null && o.optBoolean("serveAssets", false);
    }

    private static int clampTtl(int ttl) {
        if (ttl <= 0) return 300;
        return Math.min(ttl, 24 * 3600); // 上限一天：再长就等于「永不刷新」，那不是 TTL 的用法
    }

    private static Announce parseAnnounce(JSONObject o) {
        if (o == null || !o.optBoolean("enabled", false)) return null;
        String title = clip(o.optString("title", ""), 200);
        String body = clip(o.optString("body", ""), MAX_ANNOUNCE_CHARS);
        if (title.isEmpty() && body.isEmpty()) return null; // 开了但没内容 = 没有公告
        String level = o.optString("level", "info").toLowerCase(Locale.ROOT);
        if (!"info".equals(level) && !"warn".equals(level) && !"error".equals(level)) level = "info";
        return new Announce(title, body, level);
    }

    private static Matchmaking parseMatchmaking(JSONObject o) {
        if (o == null) return null;
        boolean enabled = o.optBoolean("enabled", false);
        String endpoint = safeRelativePath(o.optString("endpoint", "/api/match"));
        if (endpoint == null) return null; // 坏 endpoint → 整块忽略，绝不落到「拼一个 URL 去请求」
        List<String> modes = new ArrayList<>();
        JSONArray arr = o.optJSONArray("modes");
        for (int i = 0; arr != null && i < arr.length() && modes.size() < 32; i++) {
            String m = arr.optString(i, "").trim();
            if (m.isEmpty() || m.length() > 32) continue;
            if (safeToken(m)) modes.add(m.toUpperCase(Locale.ROOT));
        }
        return new Matchmaking(enabled, endpoint, modes,
                clampRange(o.optInt("partySize", 4), 1, 16),
                clampRange(o.optInt("queueTimeoutSec", 60), 5, 600));
    }

    private static List<Feature> parseFeatures(JSONObject o) {
        List<Feature> out = new ArrayList<>();
        if (o == null) return out;
        for (java.util.Iterator<String> it = o.keys(); it.hasNext(); ) {
            String id = it.next();
            if (id == null || !id.matches(FEATURE_ID_RE)) continue; // 坏 id → 跳过该条
            JSONObject f = o.optJSONObject(id);
            if (f == null) continue;                                // 不是对象 → 跳过该条
            String mode = f.optString("mode", "config").toLowerCase(Locale.ROOT);
            if (!"config".equals(mode) && !"pack".equals(mode)) continue; // 未知 mode → 跳过
            Long startAt = optEpoch(f, "startAt");
            Long endAt = optEpoch(f, "endAt");
            out.add(new Feature(id, f.optBoolean("enabled", false), mode, startAt, endAt));
        }
        return out;
    }

    private static List<FeaturePackRef> parseFeaturePacks(JSONArray arr) {
        List<FeaturePackRef> out = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (int i = 0; arr != null && i < arr.length(); i++) {
            JSONObject p = arr.optJSONObject(i);
            if (p == null) continue;
            String id = p.optString("id", "");
            if (!id.matches(FEATURE_ID_RE)) continue;
            if (!seen.add(id)) continue; // 重复 id → 只认第一条
            out.add(new FeaturePackRef(id, Math.max(0, p.optInt("version", 0))));
        }
        return out;
    }

    /** 时间字段：接受 epoch 毫秒（数字）或可解析为 long 的字符串；其它一律 null（= 不设限制）。 */
    private static Long optEpoch(JSONObject o, String key) {
        Object v = o.opt(key);
        if (v instanceof Number) return ((Number) v).longValue();
        if (v instanceof String) {
            try {
                return Long.parseLong(((String) v).trim());
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------
    // 校验助手（安全边界）
    // ------------------------------------------------------------------

    /**
     * 只接受**站内相对路径**：以单个 `/` 开头，禁止 `//`、`..`、反斜杠、协议前缀。
     * 服务器因此无法用配置把客户端指到任意外部 URL（§16）。public 是为了让 JVM 侧的安全断言
     * 直接跑在这条规则上（{@code tools/apk/jvm/ServerConfigCheck.java}）——安全边界必须可测。
     */
    public static String safeRelativePath(String p) {
        if (p == null) return null;
        String s = p.trim();
        if (s.isEmpty() || s.length() > 200) return null;
        if (!s.startsWith("/") || s.startsWith("//")) return null;
        if (s.contains("\\") || s.contains("..") || s.contains(":")) return null;
        if (s.startsWith("/.")) return null;
        return s;
    }

    /** 标识符（模式名等）：字母数字与 `_-.`，禁空白与控制字符。 */
    static boolean safeToken(String s) {
        if (s == null || s.isEmpty() || s.length() > 32) return false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '_' || c == '-' || c == '.';
            if (!ok) return false;
        }
        return true;
    }

    private static String clip(String s, int max) {
        if (s == null) return "";
        String t = s.trim();
        return t.length() <= max ? t : t.substring(0, max);
    }

    private static int clampRange(int v, int lo, int hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    // ------------------------------------------------------------------
    // 快照字段
    // ------------------------------------------------------------------

    public int schema() { return schema; }
    public String serverId() { return serverId; }
    public int version() { return version; }
    public int ttl() { return ttl; }
    public Announce announce() { return announce; }
    public Matchmaking matchmaking() { return matchmaking; }
    public List<Feature> features() { return features; }
    public List<FeaturePackRef> featurePacks() { return featurePacks; }
    public int minShellApi() { return minShellApi; }
    /** 服务器是否声明自己的 origin 也提供 {@code /assets/**}（默认 false）。 */
    public boolean serveAssets() { return serveAssets; }

    /** 这个 feature 是否被服务器开启**且**当前时间在它的活动窗口内。未知 id → false。 */
    public boolean featureEnabled(String id, long nowMs) {
        Feature f = feature(id);
        if (f == null || !f.enabled) return false;
        if (f.startAt != null && nowMs < f.startAt) return false;
        if (f.endAt != null && nowMs > f.endAt) return false;
        return true;
    }

    /** 按 id 找 feature；找不到返回 null（调用方据此安全忽略未知 feature）。 */
    public Feature feature(String id) {
        if (id == null) return null;
        for (Feature f : features) if (f.id.equals(id)) return f;
        return null;
    }

    // ------------------------------------------------------------------

    /** 公告（§8）：纯文本 + 等级；没有任何可执行字段。 */
    public static final class Announce {
        public final String title;
        public final String body;
        public final String level; // info | warn | error

        Announce(String title, String body, String level) {
            this.title = title;
            this.body = body;
            this.level = level;
        }
    }

    /** 匹配配置（§9）：客户端只做 UI 与请求编排，真正的匹配逻辑仍在服务器 API。 */
    public static final class Matchmaking {
        public final boolean enabled;
        public final String endpoint;   // 站内相对路径
        public final List<String> modes;
        public final int partySize;
        public final int queueTimeoutSec;

        Matchmaking(boolean enabled, String endpoint, List<String> modes, int partySize, int queueTimeoutSec) {
            this.enabled = enabled;
            this.endpoint = endpoint;
            this.modes = Collections.unmodifiableList(modes);
            this.partySize = partySize;
            this.queueTimeoutSec = queueTimeoutSec;
        }
    }

    /**
     * 一个 feature 声明。
     * <p>{@code mode} 是「配置型 / 代码型」的分界线（§10）：{@code config} = 客户端已有代码，只缺
     * 参数；{@code pack} = 需要新客户端代码，必须由 {@link FeaturePackRef} 指向**签名热更新链**里
     * 的 Feature Pack，绝不能是服务器下发的 JS。
     */
    public static final class Feature {
        public final String id;
        public final boolean enabled;
        public final String mode;       // config | pack
        public final Long startAt;      // 可空
        public final Long endAt;        // 可空

        Feature(String id, boolean enabled, String mode, Long startAt, Long endAt) {
            this.id = id;
            this.enabled = enabled;
            this.mode = mode;
            this.startAt = startAt;
            this.endAt = endAt;
        }
    }

    /**
     * Feature Pack 引用（§10-B）：只有 id + version —— **没有 URL 字段是刻意的**。
     * 客户端拿这个引用去查既有的 Ed25519 签名热更新链（shell-ui / manifest）里有没有对应的
     * 能力；服务器无法在这里塞一个下载地址，也就无法绕过签名链。
     */
    public static final class FeaturePackRef {
        public final String id;
        public final int version;

        FeaturePackRef(String id, int version) {
            this.id = id;
            this.version = version;
        }
    }
}
