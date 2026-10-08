package icu.jiangjiangze.stronghold;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * O(1) 素材缓存实况计数器（feat/art-cache-status，2026-10-08）：页面此前只能看到
 * {@code art-prefetch.js} 的 {@code done}（把「本地已有」和「已从 CDN 取回」混在一起），问不到
 * 「壳侧磁盘上到底缓存了多少素材」。这里维护 {@code filesDir/art/cache/<manifest hash>/} 的真实
 * 文件数与字节数，供 {@code ShellBridge.artCacheStatus()} 同步读取。
 *
 * <p><b>性能是硬要求</b>（业主原话：不要每次调用都递归扫整棵缓存树）：
 * <ul>
 *   <li>写入路径（{@link #onWrite}）与删除路径（{@link #onDelete}）只做原子自增/自减；</li>
 *   <li>每 {@link #PERSIST_EVERY_WRITES} 次写入（且距上次落盘至少 {@link #PERSIST_INTERVAL_MS} ms）
 *       把计数器持久化到素材根下的小元数据文件，重启后可直接恢复；</li>
 *   <li>启动时（或命名空间变化后）由调用方在**后台**调用一次 {@link #scan} 对账，并以磁盘为准
 *       {@link #reconcileTo} 修复元数据。{@link #files()}/{@link #bytes()} 因此永远是 O(1)。</li>
 * </ul>
 *
 * <p>计数口径：只统计**当前 manifest hash** 的命名空间目录（{@code art/cache/<hash>}，含其下的
 * {@code srv-*} 服务器素材槽），排除 {@code .part}/{@code .tmp}/隐藏临时件，并要求路径通过词法安全
 * 检查（规范化后确实位于缓存根之下、无 {@code ..}）。**绝不**统计 {@code art/packs/**} —— 那是
 * 签名清单覆盖、装包时已 sha256 校验的内容，与本层 best-effort 取回缓存是两套信任级别。
 *
 * <p>零 Android 依赖（只有 java.io/java.nio/java.util.concurrent），JVM 可直接跑：
 * 见 {@code tools/apk/jvm/ArtCacheStatsCheck.java}。
 */
public final class ArtCacheStats {

    /** 每 N 次写入落一次盘（元数据只是加速重启恢复，磁盘对账永远兜底）。 */
    private static final int PERSIST_EVERY_WRITES = 64;
    /** 两次落盘之间的最小间隔（"at most once per second"）：避免冷启动预取把 IO 打满。 */
    private static final long PERSIST_INTERVAL_MS = 1000L;

    /** 一个不可变的计数快照（扫描结果 / 元数据内容）。 */
    public static final class Count {
        public final int files;
        public final long bytes;

        public Count(int files, long bytes) {
            this.files = Math.max(0, files);
            this.bytes = Math.max(0L, bytes);
        }
    }

    /** {@link #clear(File)} 的结果：成功与否 + 实际删除量（中途失败也带回已删部分）。 */
    public static final class ClearResult {
        public boolean ok = true;
        public int files;
        public long bytes;
        public String error;
    }

    private final AtomicInteger files = new AtomicInteger();
    private final AtomicLong bytes = new AtomicLong();
    private final AtomicInteger writesSincePersist = new AtomicInteger();
    private final AtomicLong lastPersistAt = new AtomicLong();

    /** 计数器当前所属的命名空间（null = 尚未配置：读数为 0，且不落盘）。 */
    private volatile String namespace;
    /** 计数器持久化目标（素材根下的小文件）；null = 不落盘。 */
    private volatile File metaFile;

    // ------------------------------------------------------------------
    // 计数器（O(1)）
    // ------------------------------------------------------------------

    public int files() {
        return files.get();
    }

    public long bytes() {
        return bytes.get();
    }

    /** 一次成功写入：文件数 +1、字节数 +n，并按节奏落盘。 */
    public void onWrite(long n) {
        files.incrementAndGet();
        if (n > 0) bytes.addAndGet(n);
        maybePersist();
    }

    /** 一次删除：文件数 -1、字节数 -n（下限 0），并按节奏落盘。 */
    public void onDelete(long n) {
        if (files.get() > 0) files.decrementAndGet();
        long after = n > 0 ? bytes.addAndGet(-n) : bytes.get();
        if (after < 0) bytes.set(0);
        maybePersist();
    }

    /** 直接设定计数（对账修复用）。 */
    public void set(int f, long b) {
        files.set(Math.max(0, f));
        bytes.set(Math.max(0L, b));
    }

    /**
     * 绑定持久化目标与命名空间。命名空间不变时是廉价 no-op；变化时清零并尝试从元数据恢复
     * （元数据缺失/不匹配就保持 0，等后台对账修复）。synchronized：桥线程与对账线程都会调。
     */
    public synchronized void configure(File meta, String ns) {
        this.metaFile = meta;
        if (ns != null && ns.equals(namespace)) return;
        this.namespace = ns;
        files.set(0);
        bytes.set(0);
        writesSincePersist.set(0);
        lastPersistAt.set(System.currentTimeMillis());
        Count loaded = readMeta(meta, ns);
        if (loaded != null) {
            files.set(loaded.files);
            bytes.set(loaded.bytes);
        }
    }

    /** 后台对账结果写回（仅当命名空间仍是 {@code ns}，避免与更新的命名空间抢写）。 */
    public synchronized void reconcileTo(Count actual, String ns) {
        if (actual == null || ns == null || !ns.equals(namespace)) return;
        files.set(actual.files);
        bytes.set(actual.bytes);
        writeMeta();
    }

    // ------------------------------------------------------------------
    // 扫描 / 清理（IO，调用方负责放到后台线程）
    // ------------------------------------------------------------------

    /**
     * 单次递归扫描当前命名空间（{@code cacheRoot/<ns>}）的真实占用：只统计
     * {@link #isCountable} 认可的普通文件。命名空间非法或目录不存在时返回 0/0。
     */
    public Count scan(File cacheRoot, String ns) {
        if (cacheRoot == null || ns == null || !ArtCdn.isValidNamespace(ns)) return new Count(0, 0);
        final int[] f = {0};
        final long[] b = {0};
        scanInto(new File(cacheRoot, ns), cacheRoot, f, b);
        return new Count(f[0], b[0]);
    }

    private static void scanInto(File dir, File cacheRoot, int[] f, long[] b) {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            if (k.isDirectory()) {
                if (isSafeUnder(cacheRoot, k)) scanInto(k, cacheRoot, f, b);
            } else if (isCountable(cacheRoot, k)) {
                f[0]++;
                b[0] += k.length();
            }
        }
    }

    /**
     * 清除 {@code cacheRoot} 的**全部子项**（所有命名空间，含 {@code srv-*} 槽），随后把计数器
     * 归零并落盘。**绝不**触碰缓存根之外的任何东西 —— {@code art/packs/**}（已验签内容）与
     * {@code filesDir/webroot} 都不在 cacheRoot 之下。每个子项先过词法安全门；任一删除失败只把
     * {@code ok} 置 false 并带上已删数量，不抛异常。
     */
    public synchronized ClearResult clear(File cacheRoot) {
        ClearResult r = new ClearResult();
        if (cacheRoot == null) {
            r.ok = false;
            r.error = "cache root unavailable";
            return r;
        }
        File[] kids = cacheRoot.listFiles();
        if (kids != null) {
            for (File k : kids) {
                if (!isSafeUnder(cacheRoot, k)) {
                    r.ok = false;
                    r.error = "unsafe cache entry skipped";
                    continue;
                }
                deleteInto(k, cacheRoot, r);
            }
        }
        files.set(0);
        bytes.set(0);
        writesSincePersist.set(0);
        lastPersistAt.set(System.currentTimeMillis());
        if (metaFile != null && !writeMeta() && r.ok) {
            r.ok = false;
            r.error = "cache metadata persist failed";
        }
        return r;
    }

    private static void deleteInto(File f, File root, ClearResult r) {
        File[] kids = f.isDirectory() ? f.listFiles() : null;
        if (kids != null) {
            for (File k : kids) {
                if (!isSafeUnder(root, k)) {
                    r.ok = false;
                    r.error = "unsafe cache entry skipped";
                    continue;
                }
                deleteInto(k, root, r);
            }
        }
        boolean wasFile = f.isFile();
        long sz = wasFile ? f.length() : 0;
        if (f.delete()) {
            if (wasFile) {
                r.files++;
                r.bytes += sz;
            }
        } else {
            r.ok = false;
            r.error = "delete failed: " + f.getName();
        }
    }

    // ------------------------------------------------------------------
    // 计数口径
    // ------------------------------------------------------------------

    /**
     * True when a regular file under the cache root counts toward the real cache size: a real file
     * (not a directory), not a {@code .part}/{@code .tmp}/{@code .partial}/hidden temp artefact
     * (half-written downloads must never inflate the number), and lexically inside the cache root.
     */
    public static boolean isCountable(File cacheRoot, File f) {
        if (cacheRoot == null || f == null || !f.isFile()) return false;
        String name = f.getName();
        if (name.isEmpty()) return false;
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".part") || lower.endsWith(".partial") || lower.endsWith(".tmp")
                || lower.startsWith(".")) return false;
        return isSafeUnder(cacheRoot, f);
    }

    /**
     * 词法安全门：{@code f} 规范化（absolute + normalize，纯词法解析 {@code ..}，不跟随符号链接）
     * 后必须严格位于 {@code root} 之下，且相对路径没有空段/{@code .}/{@code ..}。绝对路径或任何
     * 逃逸尝试一律 false。
     */
    public static boolean isSafeUnder(File root, File f) {
        if (root == null || f == null) return false;
        try {
            java.nio.file.Path r = root.toPath().toAbsolutePath().normalize();
            java.nio.file.Path p = f.toPath().toAbsolutePath().normalize();
            if (p.equals(r) || !p.startsWith(r)) return false;
            for (java.nio.file.Path seg : r.relativize(p)) {
                String s = seg.toString();
                if (s.isEmpty() || ".".equals(s) || "..".equals(s)) return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // 元数据（素材根下的小文件；手写 JSON，零 org.json 依赖，JVM 可测）
    // ------------------------------------------------------------------

    /** 元数据文件：{@code <artRoot>/cache-stats.txt}（artRoot 设备上 = filesDir/art）。 */
    public static File metaFile(File artRoot) {
        return new File(artRoot, "cache-stats.txt");
    }

    private static Count readMeta(File meta, String ns) {
        if (meta == null || ns == null || !meta.isFile()) return null;
        try {
            String text = new String(Files.readAllBytes(meta.toPath()), StandardCharsets.UTF_8);
            Matcher nm = Pattern.compile("\"namespace\"\\s*:\\s*\"([^\"]{0,64})\"").matcher(text);
            Matcher fm = Pattern.compile("\"files\"\\s*:\\s*(\\d+)").matcher(text);
            Matcher bm = Pattern.compile("\"bytes\"\\s*:\\s*(\\d+)").matcher(text);
            if (!nm.find() || !fm.find() || !bm.find()) return null;
            if (!ns.equals(nm.group(1))) return null; // a foreign namespace's counters are not ours
            return new Count(Integer.parseInt(fm.group(1)), Long.parseLong(bm.group(1)));
        } catch (Throwable t) {
            return null;
        }
    }

    /** 写回元数据；失败只返回 false（对账会兜底），永不抛。 */
    private synchronized boolean writeMeta() {
        File m = metaFile;
        String ns = namespace;
        if (m == null || ns == null) return false;
        try {
            File dir = m.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) return false;
            String json = "{\"namespace\":" + quote(ns)
                    + ",\"files\":" + Math.max(0, files.get())
                    + ",\"bytes\":" + Math.max(0L, bytes.get()) + "}";
            Files.write(m.toPath(), json.getBytes(StandardCharsets.UTF_8));
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    private void maybePersist() {
        if (metaFile == null) return;
        long now = System.currentTimeMillis();
        int w = writesSincePersist.incrementAndGet();
        if (w >= PERSIST_EVERY_WRITES || now - lastPersistAt.get() >= PERSIST_INTERVAL_MS) {
            writesSincePersist.set(0);
            lastPersistAt.set(now);
            writeMeta();
        }
    }

    // ------------------------------------------------------------------
    // 桥接 JSON（手写，字段名是页面契约）
    // ------------------------------------------------------------------

    /**
     * {@code {"ok":true,"manifestHash":…,"cachedFiles":…,"cachedBytes":…,"cacheRoot":…,"pending":…}}。
     * {@code pending} 传 -1 = 「无法廉价得知」（页面自己能从 manifest 算出）；绝不编造数字。
     */
    public static String statusJson(String manifestHash, String cacheRoot, int cachedFiles,
                                    long cachedBytes, long pending) {
        return "{\"ok\":true,\"manifestHash\":" + quote(manifestHash)
                + ",\"cachedFiles\":" + Math.max(0, cachedFiles)
                + ",\"cachedBytes\":" + Math.max(0L, cachedBytes)
                + ",\"cacheRoot\":" + quote(cacheRoot)
                + ",\"pending\":" + (pending < 0 ? -1L : pending) + "}";
    }

    /** {@code {"ok":false,"error":…}} —— 桥方法任何失败都返回它，绝不把异常抛进页面。 */
    public static String errorJson(String error) {
        return "{\"ok\":false,\"error\":" + quote(error == null ? "unknown error" : error) + "}";
    }

    /** {@code {"ok":…,"removedFiles":…,"removedBytes":…,"keptPacks":true[,"error":…]}}。 */
    public static String clearJson(boolean ok, int removedFiles, long removedBytes, String error) {
        StringBuilder sb = new StringBuilder(96);
        sb.append("{\"ok\":").append(ok)
                .append(",\"removedFiles\":").append(Math.max(0, removedFiles))
                .append(",\"removedBytes\":").append(Math.max(0L, removedBytes))
                .append(",\"keptPacks\":true");
        if (!ok) sb.append(",\"error\":").append(quote(error == null ? "clear failed" : error));
        sb.append('}');
        return sb.toString();
    }

    /** Minimal JSON string quoting (the two bridge methods must never emit invalid JSON). */
    static String quote(String s) {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder(s.length() + 2);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
    }
}
