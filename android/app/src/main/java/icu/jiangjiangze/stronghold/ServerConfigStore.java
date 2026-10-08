package icu.jiangjiangze.stronghold;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * 服务器配置的获取 / 校验 / 缓存 / 版本比较（方案 §4–§6）。
 *
 * <p>与 {@link ArtStore} 同一套路：**落盘/决策逻辑是纯的**（只吃 {@link File} + 注入的
 * {@link Fetcher}），Android 只负责把 {@code filesDir} 和 {@code Updater} 风格的网络原语接进来，
 * 因此整个类可以在裸 JDK 上跑测试。
 *
 * <pre>
 * filesDir/server-config/&lt;serverKey&gt;/
 *     config.json   最后一次**可用**的配置（last-good）
 *     meta.json     {"serverKey","serverId","version","fetchedAt","etag","path","schema"}
 * </pre>
 *
 * <h3>为什么缓存键是 origin 而不是配置里的 serverId</h3>
 * 配置是**远端输入**：如果缓存键由它自己声明，一个服务器就能声明别人的 id 去读/写别人的缓存槽。
 * origin（host+port）是用户已经连上的目标，不可伪造，天然一服一槽 —— 所以 {@code serverKey} 由
 * origin 推导，配置里的 {@code serverId} 只作为元数据/展示。这也让「切服」自动就是「换槽」：
 * 换服务器即换配置，回切仍是它自己的 last-good。
 *
 * <h3>安全边界</h3>
 * 配置 URL **只由当前页面 origin + 固定相对路径拼出**，配置内容里没有任何 URL 字段能影响它。
 * 也就是说：目标 host 永远是用户已经连着的那一个，请求不构成对第三方的探测；配置自身也无法把
 * 客户端指向任意外部地址（见 {@link ServerConfig#safeRelativePath(String)}）。
 */
public final class ServerConfigStore {

    /** 候选路径，按序尝试：标准位置优先，再退到 upstream 今天就能提供的路径。 */
    static final String[] PATHS = {
            "/.well-known/stronghold-client.json",
            "/stronghold-client.json",
    };

    private static final String CONFIG = "config.json";
    private static final String META = "meta.json";
    private static final String ROOT = "server-config";

    private ServerConfigStore() {
    }

    /** 网络原语注入点（设备上 = HttpURLConnection；测试里 = 本地桩）。 */
    public interface Fetcher {
        /** GET {@code url}，带上次的 etag（可为空）。失败抛 IOException。 */
        Response fetch(String url, String etag) throws IOException;
    }

    /** 一次 HTTP 结果：状态码 + body（非 200 时可为 null）+ 响应 etag。 */
    public static final class Response {
        public final int code;
        public final String body;
        public final String etag;

        public Response(int code, String body, String etag) {
            this.code = code;
            this.body = body;
            this.etag = etag;
        }
    }

    /** 一份可用配置 + 它的元数据（last-good）。 */
    public static final class Cached {
        public final ServerConfig config;
        public final long fetchedAt;
        public final String etag;
        public final String path;
        public final String serverId;

        Cached(ServerConfig config, long fetchedAt, String etag, String path, String serverId) {            this.config = config;
            this.fetchedAt = fetchedAt;
            this.etag = etag;
            this.path = path;
            this.serverId = serverId;
        }

        public boolean hasConfig() {
            return config != null;
        }
    }

    // ------------------------------------------------------------------
    // 纯逻辑（JVM 可测）
    // ------------------------------------------------------------------

    /** origin → 缓存槽名。host 与 port 都进去：同一台机器的不同端口是不同服务器。public：可测。 */
    public static String serverKeyOf(String origin) {
        if (origin == null || origin.isEmpty()) return "default";
        String host = "";
        int port = -1;
        try {
            URL u = new URL(origin);
            host = u.getHost() == null ? "" : u.getHost();
            port = u.getPort();
        } catch (Exception ignored) {
            // 解析不了就用原文过一遍 sanitize（比直接丢成 default 更有诊断价值）
            host = origin;
        }
        String raw = host.toLowerCase(Locale.ROOT) + (port > 0 ? "_" + port : "");
        return sanitizeKey(raw);
    }

    /** 只保留目录名安全字符；折叠连续分隔；截断到 64；空 → default。 */
    static String sanitizeKey(String raw) {
        if (raw == null) return "default";
        StringBuilder sb = new StringBuilder(raw.length());
        boolean lastDash = false;
        for (int i = 0; i < raw.length() && sb.length() < 64; i++) {
            char c = raw.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_';
            if (ok) {
                sb.append(c);
                lastDash = false;
            } else if (c >= 'A' && c <= 'Z') {
                sb.append((char) (c + 32));
                lastDash = false;
            } else if (!lastDash) {
                sb.append('-');
                lastDash = true;
            }
        }
        while (sb.length() > 0 && sb.charAt(sb.length() - 1) == '-') sb.setLength(sb.length() - 1);
        while (sb.length() > 0 && sb.charAt(0) == '.') sb.deleteCharAt(0);
        return sb.length() == 0 ? "default" : sb.toString();
    }

    /**
     * 配置 URL = 当前页面 origin + 固定相对路径。**这是本类唯一的 URL 构造点**，因此
     * 目标 host 必然等于用户已连接的服务器；协议只允许 http/https（局域网服与本地主机服务都是
     * http，这是产品前提，不是放松）。任何异常返回 null → 调用方保持 last-good、不发请求。
     */
    public static String configUrlFor(String pageOrigin, String path) {
        if (pageOrigin == null || path == null) return null;
        if (!path.startsWith("/") || path.startsWith("//") || path.contains("..")) return null;
        if (ResourceResolver.originHasUserInfo(pageOrigin)) return null;
        try {
            URL u = new URL(pageOrigin);
            String scheme = u.getProtocol() == null ? "" : u.getProtocol().toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
            String host = u.getHost();
            if (host == null || host.isEmpty()) return null;
            if (wouldEscapeAuthority(host)) return null;
            int port = u.getPort();
            return scheme + "://" + host + (port > 0 ? ":" + port : "") + path;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * host 里出现能改变 URL 语义的字符（userinfo / 路径 / 空白 / 非 ASCII 空白）时拒绝：
     * {@code new URL()} 对这些输入并不总是报错，先挡一道，避免拼出意料之外的 authority。
     */
    private static boolean wouldEscapeAuthority(String host) {
        for (int i = 0; i < host.length(); i++) {
            char c = host.charAt(i);
            if (c == '@' || c == '/' || c == '\\' || c == '?' || c == '#' || c <= ' ' || c == 0x7f) return true;
        }
        return false;
    }

    /** 缓存槽目录。 */
    public static File dirFor(File filesDir, String origin) {
        return new File(new File(filesDir, ROOT), serverKeyOf(origin));
    }

    /**
     * TTL 是否已过（该刷新了）。没有配置、或没有时间戳（0）都算过期。public：可测。
     */
    public static boolean isStale(Cached c, long nowMs) {
        if (c == null || c.config == null) return true;
        if (c.fetchedAt <= 0) return true;
        long ttlMs = Math.max(1, c.config.ttl()) * 1000L;
        return nowMs - c.fetchedAt >= ttlMs;
    }

    /**
     * 是否接受远端这份配置（§17 case 8：版本回退）。
     * <p>版本**只增不减**：远端 version 小于本地已缓存 version 时拒绝 —— 一个被回滚/被缓存的旧
     * 配置不能把设备降级回去。相同版本接受（内容可能修正，且 ETag 会替我们省掉重复下载）。
     */
    static boolean acceptRemote(Cached cached, ServerConfig remote) {
        if (remote == null) return false;
        if (cached == null || cached.config == null) return true;
        return remote.version() >= cached.config.version();
    }

    // ------------------------------------------------------------------
    // 读 last-good
    // ------------------------------------------------------------------

    /** 读取该 origin 的 last-good；没有则返回一个 config=null 的壳。永不抛。 */
    public static Cached load(File filesDir, String origin) {
        File dir = dirFor(filesDir, origin);
        ServerConfig cfg = null;
        long fetchedAt = 0;
        String etag = "";
        String path = "";
        String serverId = "";
        try {
            File cf = new File(dir, CONFIG);
            if (cf.isFile()) {
                cfg = ServerConfig.parse(readFile(cf), null);
            }
            File mf = new File(dir, META);
            if (mf.isFile()) {
                org.json.JSONObject m = new org.json.JSONObject(readFile(mf));
                fetchedAt = m.optLong("fetchedAt", 0);
                etag = m.optString("etag", "");
                path = m.optString("path", "");
                serverId = m.optString("serverId", "");
            }
        } catch (Throwable ignored) {
            // 坏缓存 = 没有缓存；下次刷新重建
        }
        if (cfg == null) fetchedAt = 0; // 配置没了，时间戳就不算数
        return new Cached(cfg, fetchedAt, etag, path, serverId);
    }

    // ------------------------------------------------------------------
    // 刷新
    // ------------------------------------------------------------------

    /**
     * 拉一次配置。返回**要用的**那份 Cached（成功 = 新的；失败/304 = 传进来的 last-good）。
     *
     * <p>行为矩阵：
     * <ul>
     *   <li>200 + 解析成功 + 版本不回退 → 原子写盘，返回新配置</li>
     *   <li>200 + 解析失败/schema 过高/版本回退 → **不落盘**，返回 last-good（§17 cases 6、7、8）</li>
     *   <li>304 → 只把 fetchedAt 推到 now（省掉下一次请求），配置与 etag 不变</li>
     *   <li>404/其它 → 试下一个候选路径；全失败 → last-good（§17 case 5）</li>
     * </ul>
     */
    public static Cached refresh(File filesDir, String origin, Fetcher f, long nowMs) {
        Cached cached = load(filesDir, origin);
        if (f == null) return cached;
        // 已记住上次成功的路径就先试它，省掉一次必然 404 的探测
        String[] order = cached.path.isEmpty() ? PATHS : preferPath(cached.path);
        for (String path : order) {
            String url = configUrlFor(origin, path);
            if (url == null) return cached; // origin 不可用 → 不请求，保持 last-good
            Response r;
            try {
                r = f.fetch(url, cached.etag);
            } catch (IOException e) {
                continue; // 换下一个候选（网络错误可能只影响这一条路径）
            }
            if (r == null) continue;
            if (r.code == 304) {
                touch(filesDir, origin, cached, path, nowMs);
                return new Cached(cached.config, nowMs, cached.etag, path, cached.serverId);
            }
            if (r.code != 200) continue;
            ServerConfig remote = ServerConfig.parse(r.body, null);
            if (!acceptRemote(cached, remote)) continue; // 坏/回退 → 保持 last-good
            String serverId = remote.serverId();
            write(filesDir, origin, r.body, serverId, remote.version(), nowMs, r.etag, path);
            return new Cached(remote, nowMs, r.etag, path, serverId);
        }
        return cached;
    }

    /** 上次成功的路径排第一，其余按原顺序跟后。 */
    private static String[] preferPath(String first) {
        String[] out = new String[PATHS.length];
        out[0] = first;
        int n = 1;
        for (String p : PATHS) if (!p.equals(first) && n < out.length) out[n++] = p;
        while (n < out.length) out[n++] = PATHS[0];
        return out;
    }

    // ------------------------------------------------------------------
    // 落盘（原子：写 .tmp → rename）
    // ------------------------------------------------------------------

    private static void write(File filesDir, String origin, String body, String serverId, int version,
                              long fetchedAt, String etag, String path) {
        File dir = dirFor(filesDir, origin);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        try {
            writeAtomic(new File(dir, CONFIG), body);
            org.json.JSONObject m = new org.json.JSONObject();
            m.put("serverKey", serverKeyOf(origin));
            m.put("serverId", serverId == null ? "" : serverId);
            m.put("version", version);
            m.put("fetchedAt", fetchedAt);
            m.put("etag", etag == null ? "" : etag);
            m.put("path", path);
            m.put("schema", ServerConfig.SUPPORTED_SCHEMA);
            writeAtomic(new File(dir, META), m.toString());
        } catch (Throwable ignored) {
            // 落盘失败只影响「下次冷启动还能不能用 last-good」；本次内存快照仍然有效
        }
    }

    /** 304：只把时间戳推到现在，避免每个页面都重复发一次条件请求。 */
    private static void touch(File filesDir, String origin, Cached cached, String path, long nowMs) {
        File dir = dirFor(filesDir, origin);
        try {
            if (!dir.isDirectory()) return;
            File mf = new File(dir, META);
            org.json.JSONObject m = mf.isFile() ? new org.json.JSONObject(readFile(mf)) : new org.json.JSONObject();
            m.put("fetchedAt", nowMs);
            m.put("path", path);
            writeAtomic(mf, m.toString());
        } catch (Throwable ignored) {
        }
    }

    private static void writeAtomic(File dst, String text) throws IOException {
        File tmp = new File(dst.getParentFile(), dst.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
        if (!tmp.renameTo(dst)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
    }

    private static String readFile(File f) throws IOException {
        try (FileInputStream in = new FileInputStream(f)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > ServerConfig.MAX_BODY_BYTES) break;
            }
            return out.toString("UTF-8");
        }
    }
}
