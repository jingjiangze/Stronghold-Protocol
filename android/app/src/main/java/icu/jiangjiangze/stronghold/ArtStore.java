package icu.jiangjiangze.stronghold;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;

/**
 * 素材热更（P0，方案 §5 layer ② / §7.3 / §9）。纯粹的文件层：**零 Android 依赖**（JVM 可测），
 * 下载通道由调用方以 {@link Fetcher} 注入（设备上是 Updater 的 downloadArt：https-only +
 * ALLOWED_HOSTS + Range 续传/分段）。
 *
 * 并发（业主 2026-10-09「多线程下载优化」）：包之间互不共享文件（各自的 parts/&lt;id&gt;.part 与
 * packs/&lt;id&gt;），所以最多 {@link #PACK_CONCURRENCY} 个包同时安装；每条连接的内部再按
 * {@code Updater} 的分段策略决定并发度。实时进度/速率（下载、解压两条通道分开记）写在
 * {@link ArtSyncStats}，页面经 {@code ShellBridge.artSyncStatus()} 读。
 *
 * 落盘布局（全部在 artRoot 之下，设备上 artRoot = filesDir/art；**绝不**碰 filesDir/webroot，
 * 也不参与 webroot 的回滚/一次性释放机制——方案 §4.6 / §10-8/9）：
 *   art/
 *     packs/&lt;id&gt;/           已安装内容（条目只允许 assets/**，webroot 相对路径原样）
 *     packs/&lt;id&gt;/sha256.txt  安装标记：内容等于 pack.sha256 才算已安装
 *     packs/&lt;id&gt;.tmp/        解包暂存（同卷，rename 原子切换）
 *     parts/&lt;id&gt;.part       下载半成品（Fetcher 按 Range 续传）
 *     cache/&lt;hash&gt;/assets/** 未被 pack 覆盖素材的同源回取缓存（ArtCdn/MainActivity 写；本类只
 *                             枚举 packs/，两者互不可见；整棵 art/ 可一起清理）
 *     art.json               {"version":N,"packs":[{"id","sha256","size"}, …]}
 *     art.log                失败/诊断（静默降级，追加写，永不抛）
 *
 * 信任链：签名清单的 art.packs[].sha256 → 本类先校验再解包；未过 sha256 的字节永不落进 packs/。
 * 版本轴：art.version 严格大于设备记录才由调用方采纳（本类只负责记账，不做比较）。
 */
public final class ArtStore {

    /** 已安装标记文件名（内容 = pack.sha256）。 */
    private static final String MARKER = "sha256.txt";
    private static final String INDEX = "art.json";

    /** pack id 的合法形态（与方案 §7.3 / JS 侧 PACK_ID_RE 一致；禁 `/`、`.`、`..`）。 */
    private static final Pattern ID_RE = Pattern.compile("^[a-z0-9][a-z0-9._:-]{0,63}$");

    /** 同一时刻只允许一个 sync（移动网络 + 与既有单飞语义一致；失败返回 -1 而不是排队）。 */
    private static final AtomicBoolean IN_FLIGHT = new AtomicBoolean(false);

    /**
     * 同时在装的包数（业主 2026-10-09「多线程下载优化」）。包之间的文件互不相干（各自的
     * {@code parts/<id>.part}、{@code packs/<id>.tmp}），所以并发只争带宽与 I/O；2 是手机上的保守
     * 值 —— 再高只会让每条连接都变慢。分段下载（单包内部多连接）另由 Updater 决定。
     */
    private static final int PACK_CONCURRENCY = 2;

    /** 包安装线程池的等待上限：超过就放弃（返回失败），绝不把 sync 挂死。 */
    private static final long PACK_WAIT_MINUTES = 90L;

    /** 清单里的一个素材包（字段与 §7.3 的 art.packs[] 对应）。 */
    public static final class Pack {
        public String id = "";
        public String sha256 = "";
        public long size = 0;
        public List<String> urls = new ArrayList<>();
        public boolean optional = false;
    }

    /** 下载原语注入点：设备端 = Updater.downloadOne（Range 续传 + ALLOWED_HOSTS 全在 open() 里）。 */
    public interface Fetcher {
        long fetch(String url, File dst, Updater.Progress p) throws IOException;
    }

    private ArtStore() {}

    /** filesDir/art ——设备上的素材根；模板文件系统的人工排查也只看这一个目录。 */
    public static File rootOf(File filesDir) {
        return new File(filesDir, "art");
    }

    /** packs/ ——公开给调用方/测试构造路径（layout 是契约，见类注释）。 */
    public static File packsDir(File artRoot) {
        return new File(artRoot, "packs");
    }

    /** packs/&lt;id&gt; ——已安装内容目录（packDir(...,id)+".tmp" 是解包暂存）。 */
    public static File packDir(File artRoot, String id) {
        return new File(packsDir(artRoot), id);
    }

    /** pack id 是否合法（防御性：清单已被 parseVerified 过滤，这里再挡一次）。 */
    static boolean validId(String id) {
        return id != null && ID_RE.matcher(id).matches();
    }

    /**
     * 已安装判定：packs/&lt;id&gt;/sha256.txt == pack.sha256（内容寻址，天然幂等；换版本即失效重装）。
     * 任何读取失败都算「未安装」——宁重下不误信。
     */
    public static boolean installedAt(File artRoot, Pack p) {
        if (artRoot == null || p == null || !validId(p.id) || p.sha256 == null || p.sha256.isEmpty()) return false;
        File marker = new File(packDir(artRoot, p.id), MARKER);
        if (!marker.isFile()) return false;
        try {
            String got = new String(Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8).trim();
            return got.equalsIgnoreCase(p.sha256.trim());
        } catch (IOException e) {
            return false;
        }
    }

    /**
     * 打开已安装素材：path 先规范化（'\'→'/'、去前导 '/'），含 `..`/绝对路径直接拒绝；随后按
     * pack id 升序依次在 packs/&lt;id&gt;/&lt;path&gt; 查找，命中返回 FileInputStream，否则 null。
     * 只有 {@code assets/**} 可能命中（包内容策略），且**永不抛异常**——openLocal 的兜底必须稳。
     */
    public static InputStream open(File artRoot, String path) {
        try {
            if (artRoot == null || path == null) return null;
            String rel = path.replace('\\', '/');
            while (rel.startsWith("/")) rel = rel.substring(1);
            if (rel.isEmpty() || rel.endsWith("/")) return null;
            for (String seg : rel.split("/")) {
                if (seg.isEmpty() || seg.equals(".") || seg.equals("..")) return null;
            }
            // 包只装 assets/**（§10-5）：路径不在素材区就绝不进 pack 树。
            if (!rel.startsWith("assets/")) return null;

            File[] kids = packsDir(artRoot).listFiles();
            if (kids == null) return null;
            List<File> dirs = new ArrayList<>();
            for (File k : kids) {
                if (k.isDirectory() && !k.getName().endsWith(".tmp") && validId(k.getName())) dirs.add(k);
            }
            Collections.sort(dirs, new Comparator<File>() {
                @Override
                public int compare(File a, File b) {
                    return a.getName().compareTo(b.getName());
                }
            });
            for (File dir : dirs) {
                File f = new File(dir, rel);
                if (!f.isFile()) continue;
                try {
                    return new FileInputStream(f);
                } catch (IOException e) {
                    // 单个包读不到就试下一个，全部失败自然返回 null
                }
            }
            return null;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 设备记录的素材版本；unreadable/坏 JSON 一律 0（=「没有素材通道」）。 */
    public static int recordedVersion(File artRoot) {
        try {
            if (artRoot == null) return 0;
            File idx = new File(artRoot, INDEX);
            if (!idx.isFile()) return 0;
            String text = new String(Files.readAllBytes(idx.toPath()), StandardCharsets.UTF_8);
            Matcher m = Pattern.compile("\"version\"\\s*:\\s*(\\d+)").matcher(text);
            return m.find() ? (int) Math.min(Integer.MAX_VALUE, Long.parseLong(m.group(1))) : 0;
        } catch (Throwable t) {
            return 0;
        }
    }

    /**
     * 逐包：已装（marker 匹配）跳过；否则下载到 parts/&lt;id&gt;.part → sha256 校验 → 解包到
     * packs/&lt;id&gt;.tmp（zip-slip 守卫 + 只允许 assets/**）→ 原子切换 → 写 marker；最后写
     * art.json（标记最后写：进程被杀也不会出现「索引说装了、磁盘没有」的谎报）。
     *
     * <p>安装本身并发（≤ {@link #PACK_CONCURRENCY} 个包同时跑）；实时进度/速率进
     * {@link ArtSyncStats}（下载与解压两条通道分开记），页面经 {@code ShellBridge.artSyncStatus()} 读。
     *
     * 返回「必需包」的失败数；可选包失败只记日志（返回值不受影响）。另一个 sync 正在跑时返回 -1。
     * 版本记账：只有必需包全部成功才把 art.json 的 version 抬到 artVersion（失败则保留旧值，
     * 下次自动触发会重试）；版本永不回退。
     */
    public static int sync(File artRoot, int artVersion, List<Pack> packs, Fetcher f, Updater.Progress p) {
        if (p == null) p = Updater.NOOP;
        if (artRoot == null || packs == null || f == null || artVersion < 1) return 0;
        if (!IN_FLIGHT.compareAndSet(false, true)) {
            diag(artRoot, "sync skipped: another sync is in flight");
            return -1;
        }
        try {
            sweepStaging(artRoot);
            int previousVersion = recordedVersion(artRoot);
            // 1) 先挑出「本次真的要装的」：已装好的不占通道，也不进进度的分母
            List<Pack> pending = new ArrayList<>();
            int requiredFailures = 0;
            for (Pack pack : packs) {
                if (pack == null || !validId(pack.id) || pack.sha256 == null || pack.sha256.isEmpty()) {
                    requiredFailures++;
                    diag(artRoot, "invalid pack entry skipped: " + (pack == null ? "null" : pack.id));
                    continue;
                }
                if (installedAt(artRoot, pack)) continue;
                pending.add(pack);
            }
            // 2) 安装（并发；每个包的失败只影响它自己）
            ArtSyncStats.begin(pending.size(), 1); // conns 由 Updater 选中下载模式后更新
            try {
                requiredFailures += installAll(artRoot, pending, f, p);
            } finally {
                ArtSyncStats.end();
            }
            int version = requiredFailures == 0 ? artVersion : previousVersion;
            writeIndex(artRoot, Math.max(previousVersion, version), packs);
            return requiredFailures;
        } finally {
            IN_FLIGHT.set(false);
        }
    }

    /** 纯核心别名：调用方（JVM 自测/宿主）用同一个 artRoot 就能跑完全部流程。 */
    public static int syncAt(File artRoot, int artVersion, List<Pack> packs, Fetcher f, Updater.Progress p) {
        return sync(artRoot, artVersion, packs, f, p);
    }

    // ------------------------------------------------------------------
    // 包级并发
    // ------------------------------------------------------------------

    /** 并发安装 pending（≤ {@link #PACK_CONCURRENCY}），返回必需包失败数。 */
    private static int installAll(final File artRoot, final List<Pack> pending, final Fetcher f,
                                  final Updater.Progress p) {
        if (pending.isEmpty()) return 0;
        if (pending.size() == 1 || PACK_CONCURRENCY <= 1) {
            int failures = 0;
            for (int i = 0; i < pending.size(); i++) {
                failures += installOne(artRoot, pending.get(i), f, p, i + 1);
            }
            return failures;
        }
        final AtomicInteger failures = new AtomicInteger();
        final AtomicInteger processed = new AtomicInteger();
        ExecutorService pool = Executors.newFixedThreadPool(Math.min(PACK_CONCURRENCY, pending.size()),
                new ThreadFactory() {
                    @Override
                    public Thread newThread(Runnable r) {
                        Thread t = new Thread(r, "art-pack");
                        t.setDaemon(true);
                        return t;
                    }
                });
        try {
            for (final Pack pack : pending) {
                pool.execute(new Runnable() {
                    @Override
                    public void run() {
                        // 进度是「处理到的包数」（含失败）：1/4、2/4… 与安装顺序无关，只与完成顺序有关
                        failures.addAndGet(installOne(artRoot, pack, f, p, processed.incrementAndGet()));
                    }
                });
            }
        } finally {
            pool.shutdown();
        }
        try {
            // 必须等到全部落地：sync 的返回值（以及 art.json 的版本记账）就靠它
            if (!pool.awaitTermination(PACK_WAIT_MINUTES, TimeUnit.MINUTES)) {
                pool.shutdownNow();
                diag(artRoot, "pack install timed out after " + PACK_WAIT_MINUTES + " min");
                failures.incrementAndGet();
            }
        } catch (InterruptedException e) {
            pool.shutdownNow();
            Thread.currentThread().interrupt();
            failures.incrementAndGet();
        }
        return failures.get();
    }

    /** 装一个包：必装失败返回 1，可选包失败返回 0（只记日志）。进度按「处理到的包数」推进。 */
    private static int installOne(File artRoot, Pack pack, Fetcher f, Updater.Progress p, int doneIndex) {
        try {
            p.onStage("素材 " + pack.id);
            install(artRoot, pack, f, p);
            ArtSyncStats.packDone(doneIndex);
            return 0;
        } catch (IOException e) {
            ArtSyncStats.packDone(doneIndex);
            diag(artRoot, (pack.optional ? "optional pack " : "pack ") + pack.id + " failed: " + e);
            return pack.optional ? 0 : 1;
        } catch (Throwable t) {
            // 解包/IO 之外的东西（磁盘满、权限）也不许打断其它包
            ArtSyncStats.packDone(doneIndex);
            diag(artRoot, (pack.optional ? "optional pack " : "pack ") + pack.id + " failed: " + t);
            return pack.optional ? 0 : 1;
        }
    }

    // ------------------------------------------------------------------
    // 单包安装
    // ------------------------------------------------------------------

    private static void install(File artRoot, Pack pack, Fetcher f, Updater.Progress p)
            throws IOException {
        File parts = new File(artRoot, "parts");
        mkdirs(parts);
        File packsRoot = packsDir(artRoot);
        mkdirs(packsRoot);
        File part = new File(parts, pack.id + ".part");
        File staging = new File(packsRoot, pack.id + ".tmp");
        File live = new File(packsRoot, pack.id);
        rm(staging); // 上一次中断的解包残骸

        // 1) 下载：逐候选 URL 尝试；Range 续传/分段由 Fetcher 负责（半成品就是续传基础）。
        //    进度经包装后的 sink 走两条通道里的「下载」那条（ArtSyncStats 里它有自己的速率窗口）。
        ArtSyncStats.packStart(pack.id, ArtSyncStats.STAGE_DOWNLOAD);
        Updater.Progress fp = new Updater.Progress() {
            @Override
            public void onStage(String stage) {
                p.onStage(stage);
            }

            @Override
            public void onProgress(long bytes, long total) {
                ArtSyncStats.onBytes(ArtSyncStats.STAGE_DOWNLOAD, bytes, total);
                p.onProgress(bytes, total);
            }
        };
        IOException last = null;
        boolean downloaded = false;
        List<String> urls = new ArrayList<>();
        for (String u : pack.urls) {
            if (u != null && u.startsWith("https://")) urls.add(u);
        }
        if (urls.isEmpty()) throw new IOException("包没有可用 URL（https-only，host 白名单在下载层复验）");
        for (String url : urls) {
            try {
                // 比目标还大的半成品只可能是坏文件：丢掉重下，别让 Range 续传出错
                if (part.isFile() && pack.size > 0 && part.length() > pack.size) rm(part);
                long t0 = System.currentTimeMillis();
                f.fetch(url, part, fp);
                long ms = Math.max(1L, System.currentTimeMillis() - t0);
                long got = part.isFile() ? part.length() : 0;
                // 吞吐可见性（业主 2026-10-08：pack 到底比 7969 个小文件快多少）——一行 diag + 一行
                // onStage，MB/s 直接可读；下载通道本身（Range 续传/分段 + 镜像链）在 Fetcher 里，此处只计时。
                String rate = String.format(java.util.Locale.ROOT, "%.2f", got / 1048576.0 / (ms / 1000.0));
                diag(artRoot, "pack " + pack.id + " fetched " + got + " B in " + ms + " ms (" + rate + " MB/s)");
                p.onStage("素材 " + pack.id + " " + rate + " MB/s");
                downloaded = true;
                last = null;
                break;
            } catch (IOException e) {
                last = e;
                diag(artRoot, "download failed (" + pack.id + "): " + url + " — " + e);
            }
        }
        if (!downloaded) throw last != null ? last : new IOException("下载失败");
        if (!part.isFile()) throw new IOException("下载未落盘");

        // 2) sha256 双校验：签名清单覆盖的就是这个哈希；不符 → 删半成品，旧包原样保留
        String got = Updater.sha256(part);
        if (!got.equalsIgnoreCase(pack.sha256)) {
            rm(part);
            throw new IOException("sha256 不符（期望 " + pack.sha256 + "，实得 " + got + "）");
        }

        // 3) 解包（白名单 + 穿越守卫，失败整体丢弃 staging）；切到「解压」通道报字节进度
        ArtSyncStats.packStart(pack.id, ArtSyncStats.STAGE_UNZIP);
        extract(pack, part, staging, zipUncompressedTotal(part));

        // 4) 原子切换：删旧 → rename → 写 marker（marker 是「已安装」的唯一凭据）
        rm(live);
        if (!staging.renameTo(live)) {
            rm(staging);
            throw new IOException("无法切换素材目录 (rename 失败)");
        }
        try (FileOutputStream out = new FileOutputStream(new File(live, MARKER))) {
            out.write((pack.sha256 + "\n").getBytes(StandardCharsets.UTF_8));
        }
        rm(part); // 装好即释放下载暂存（下次重启不从 .part 走，直接从 marker 判已装）
    }

    /**
     * 解包一个已校验的 pack zip 到 staging。三道门：
     * ① 条目名规范化（'\'→'/'、去前导/尾随 '/'、拒绝空段与 `.`/`..`）失败 → 整包拒绝；
     * ② 只允许 {@code assets/**}（§10-5：素材包永远不写 js/server/index.html/__sp/extras/patches）；
     * ③ canonical 前缀守卫（对照 Updater.extractSlim），任何条目解出 staging 之外 → 整包拒绝。
     *
     * <p>{@code unzipTotal}（zip 中央目录里的解压后总字节，未知 = -1）只用于进度：解包字节经
     * {@link ArtSyncStats} 的「解压」通道上报（业主 2026-10-09 的口径：解压速度也要看得见）。
     * 总长未知时只报进度不报 ETA —— 页面据此不画 ETA 行，而不是画 0。
     */
    private static void extract(Pack pack, File zip, File staging, long unzipTotal) throws IOException {
        mkdirs(staging);
        String stagingCanon = staging.getCanonicalPath() + File.separator;
        byte[] buf = new byte[128 * 1024];
        Set<String> seen = new HashSet<>();
        long written = 0;
        try (ZipInputStream zin = new ZipInputStream(new FileInputStream(zip))) {
            ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                String rel = normalizeEntry(e.getName());
                if (rel == null) throw new IOException("包含非法条目名：" + e.getName());
                if (!rel.startsWith("assets/")) {
                    throw new IOException("条目不在 assets/ 下：" + rel + "（素材包只能写素材）");
                }
                File out = new File(staging, rel);
                if (!out.getCanonicalPath().startsWith(stagingCanon)) {
                    throw new IOException("路径穿越：" + rel);
                }
                if (!seen.add(rel)) throw new IOException("重复条目：" + rel);
                if (e.isDirectory()) {
                    mkdirs(out);
                    continue;
                }
                mkdirs(out.getParentFile());
                try (OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = zin.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        written += n;
                        ArtSyncStats.onBytes(ArtSyncStats.STAGE_UNZIP, written, unzipTotal);
                    }
                }
            }
        } catch (IOException e) {
            rm(staging); // 半包永不落进 packs/<id>
            throw e;
        }
    }

    /**
     * zip 里所有条目的解压后总字节（读中央目录）；读不出来（流式 zip / 损坏）返回 -1 —— 进度会
     * 诚实地只报字节、不报比例。绝不抛。
     */
    private static long zipUncompressedTotal(File zip) {
        try (ZipFile zf = new ZipFile(zip)) {
            long total = 0;
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                long sz = en.nextElement().getSize();
                if (sz > 0) total += sz;
            }
            return total > 0 ? total : -1L;
        } catch (Throwable t) {
            return -1L;
        }
    }

    /** 归档条目名 → 相对路径；null = 非法（绝对路径、`.`、`..`、空段）。 */
    private static String normalizeEntry(String name) {
        if (name == null) return null;
        String p = name.replace('\\', '/');
        while (p.startsWith("/")) p = p.substring(1);
        while (p.endsWith("/")) p = p.substring(0, p.length() - 1);
        if (p.isEmpty()) return null;
        for (String seg : p.split("/")) {
            if (seg.isEmpty() || seg.equals(".") || seg.equals("..")) return null;
        }
        return p;
    }

    /** 冷启动自愈：清掉遗留的 packs/*.tmp（rename 原子性保证 .tmp 永远是不完整件）。 */
    private static void sweepStaging(File artRoot) {
        File[] kids = packsDir(artRoot).listFiles();
        if (kids == null) return;
        for (File k : kids) {
            if (k.isDirectory() && k.getName().endsWith(".tmp")) rm(k);
        }
    }

    // ------------------------------------------------------------------
    // 索引（art.json）——手写 JSON：本类零 org.json 依赖，JVM 可直接跑
    // ------------------------------------------------------------------

    /** 已装包一律从磁盘现状生成记录（marker 是哈希来源），size 取旧索引/本次清单里的值。 */
    private static void writeIndex(File artRoot, int version, List<Pack> packs) {
        try {
            Map<String, Long> sizes = new HashMap<>();
            for (IndexRecord r : readIndex(artRoot)) sizes.put(r.id, r.size);
            for (Pack p : packs) {
                if (p != null && validId(p.id)) sizes.put(p.id, p.size);
            }
            List<String> ids = new ArrayList<>();
            File[] kids = packsDir(artRoot).listFiles();
            if (kids != null) {
                for (File k : kids) {
                    if (k.isDirectory() && !k.getName().endsWith(".tmp") && validId(k.getName())
                            && new File(k, MARKER).isFile()) {
                        ids.add(k.getName());
                    }
                }
            }
            Collections.sort(ids);
            StringBuilder sb = new StringBuilder();
            sb.append("{\"version\":").append(Math.max(0, version)).append(",\"packs\":[");
            boolean first = true;
            for (String id : ids) {
                String sha = readMarker(artRoot, id);
                if (sha == null) continue;
                if (!first) sb.append(',');
                first = false;
                Long size = sizes.get(id);
                sb.append("{\"id\":\"").append(id).append("\",\"sha256\":\"").append(sha)
                        .append("\",\"size\":").append(size == null ? 0 : Math.max(0, size)).append('}');
            }
            sb.append("]}");
            Files.write(new File(artRoot, INDEX).toPath(), sb.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Throwable t) {
            diag(artRoot, "index write failed: " + t); // 索引失败下次 sync 会重建，不抛
        }
    }

    private static final class IndexRecord {
        final String id;
        final String sha256;
        final long size;

        IndexRecord(String id, String sha256, long size) {
            this.id = id;
            this.sha256 = sha256;
            this.size = size;
        }
    }

    /** 解析本类自己写出的 art.json（无空白，键序固定）；容忍损坏 → 空列表。 */
    private static List<IndexRecord> readIndex(File artRoot) {
        List<IndexRecord> out = new ArrayList<>();
        try {
            File idx = new File(artRoot, INDEX);
            if (!idx.isFile()) return out;
            String text = new String(Files.readAllBytes(idx.toPath()), StandardCharsets.UTF_8);
            Matcher m = Pattern.compile(
                    "\"id\"\\s*:\\s*\"([a-z0-9][a-z0-9._:-]{0,63})\"\\s*,\\s*\"sha256\"\\s*:\\s*\"([0-9a-fA-F]{64})\"\\s*,\\s*\"size\"\\s*:\\s*(\\d+)")
                    .matcher(text);
            while (m.find()) out.add(new IndexRecord(m.group(1), m.group(2), Long.parseLong(m.group(3))));
        } catch (Throwable ignored) {
        }
        return out;
    }

    private static String readMarker(File artRoot, String id) {
        try {
            return new String(Files.readAllBytes(new File(packDir(artRoot, id), MARKER).toPath()),
                    StandardCharsets.UTF_8).trim();
        } catch (IOException e) {
            return null;
        }
    }

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------

    private static void mkdirs(File dir) throws IOException {
        if (dir == null) return;
        if (dir.isDirectory()) return;
        if (!dir.mkdirs() && !dir.isDirectory()) throw new IOException("mkdirs failed: " + dir);
    }

    private static void rm(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) rm(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** 一行诊断写进 artRoot/art.log（releaseUpdateResources 的 diag 同款形态）；永不抛。 */
    private static void diag(File artRoot, String msg) {
        try {
            mkdirs(artRoot);
            try (FileOutputStream out = new FileOutputStream(new File(artRoot, "art.log"), true)) {
                out.write((System.currentTimeMillis() + " art: " + msg + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (Throwable ignored) {
        }
    }
}
