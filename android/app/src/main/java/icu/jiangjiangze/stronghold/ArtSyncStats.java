package icu.jiangjiangze.stronghold;

/**
 * 素材包通道（{@link ArtStore#sync}）的实时状态与速率 —— 业主 2026-10-09 口径：预载进度必须显示
 * 速度（下载 / 解压 / 预载），不只是个数。页面侧 preload-center.js 经
 * {@code ShellBridge.artSyncStatus()} 读它，因此本类与 {@link ArtCacheStats} 同构：
 *
 * <ul>
 *   <li><b>O(1)</b>：读写都是几个 volatile 字段（同步线程写、桥线程读），绝不遍历文件系统、绝不做
 *       IO，所以预载面板随时调都不心疼；</li>
 *   <li><b>两条通道分开记账、绝不混</b>：网络下载（包 zip）与解压（zip → packs/&lt;id&gt;）各有独立的
 *       字节对与速率窗口。包级并发（{@code ArtStore.PACK_CONCURRENCY}）下两个阶段会同时在跑，
 *       所以这里绝不把它们相加：「下载速度」只算网络字节，「解压速度」只算解包字节；</li>
 *   <li>速率 = 滑动窗口（≥ {@link #MIN_WINDOW_MS}）的 EWMA；某条通道空闲 {@link #IDLE_RESET_MS}
 *       后它的速率归零 —— 卡住就显示 0，绝不让一个陈旧的数字挂在屏幕上；</li>
 *   <li>{@code stage}/{@code bytesDone}/{@code bytesTotal}/{@code etaMs} 描述「最近有动静的那条通道」
 *       （谁报数谁上屏），算不出 ETA 就是 -1，页面据此<b>不画</b>那一行，而不是画 0；</li>
 *   <li>{@code packsDone/packsTotal} 是「本次需要安装的包」（已装好的不算，所以 4/4 就意味着这次真装完了）。</li>
 * </ul>
 *
 * <p>零 Android 依赖（只有 java.lang），JVM 可直接跑：{@code tools/apk/jvm/ArtSyncStatsCheck.java}。
 */
public final class ArtSyncStats {

    /** 通道名：网络下载包 zip。 */
    public static final String STAGE_DOWNLOAD = "download";
    /** 通道名：解包包 zip 到 packs/&lt;id&gt;。 */
    public static final String STAGE_UNZIP = "unzip";

    /** 速率窗口下限：样本比这更密就沿用上一次的窗口，避免瞬时值抖成噪声。 */
    private static final long MIN_WINDOW_MS = 400L;
    /** 多久没有新字节就认定「这条通道没在动」：它的速率归零（诚实优先于好看）。 */
    private static final long IDLE_RESET_MS = 4000L;
    /** EWMA 权重（新值 1/4）：一秒内的抖动不至于把数字甩来甩去。 */
    private static final int EWMA_SHIFT = 2;

    private static final Object LOCK = new Object();

    /** 一条通道的速率计（只在 LOCK 下改；读数经下面的 volatile 镜像出去）。 */
    private static final class Meter {
        long done = 0;
        long total = 0;
        long bps = 0;
        long at = 0;        // 最后一次报数的时间
        long winAt = 0;     // 窗口起点
        long winBytes = 0;  // 窗口起点的字节数

        /** 该通道开工：字节对与窗口复位。 */
        void start() {
            done = 0;
            total = 0;
            winAt = 0;
            winBytes = 0;
        }

        void add(long now, long d, long t) {
            done = Math.max(0L, d);
            if (t > 0) total = Math.max(0L, t);
            at = now;
            if (winAt == 0) {
                winAt = now;
                winBytes = done;
                return;
            }
            long dt = now - winAt;
            if (dt < MIN_WINDOW_MS) return;
            long delta = done - winBytes;
            long inst = delta > 0 ? delta * 1000L / dt : 0L;
            bps = bps <= 0 ? inst : bps + (inst - bps) / (1 << EWMA_SHIFT);
            if (bps < 0) bps = 0;
            winAt = now;
            winBytes = done;
        }

        /** 空闲太久就报 0：不动的通道不该在屏幕上留一个过期速率。 */
        long bpsNow(long now) {
            if (at == 0) return 0;
            return now - at > IDLE_RESET_MS ? 0L : Math.max(0L, bps);
        }
    }

    private static final Meter DL = new Meter();
    private static final Meter UZ = new Meter();

    // 读数镜像（volatile；snapshot() 不持锁就能读到一致的一帧）
    private static volatile boolean active = false;
    private static volatile String stage = "";
    private static volatile String pack = "";
    private static volatile int packsDone = 0;
    private static volatile int packsTotal = 0;
    private static volatile int conns = 1;
    private static volatile long startedAt = 0;
    private static volatile long elapsedMs = 0;
    private static volatile long dlDone = 0;
    private static volatile long dlTotal = 0;
    private static volatile long dlBps = 0;
    private static volatile long dlAt = 0;
    private static volatile long uzDone = 0;
    private static volatile long uzTotal = 0;
    private static volatile long unzipBps = 0;
    private static volatile long uzAt = 0;

    private ArtSyncStats() {}

    /** 不可变读数（JVM 自测与桥方法都读它；不这样做就得在持锁时拼 JSON）。 */
    public static final class Snapshot {
        public final boolean active;
        public final String stage;
        public final String pack;
        public final int packsDone;
        public final int packsTotal;
        public final int conns;
        public final long bytesDone;
        public final long bytesTotal;
        public final long dlBps;
        public final long unzipBps;
        public final long etaMs;
        public final long elapsedMs;

        /** public：JVM 自测也要能造一个读数来钉 statusJson 的形状（见 ArtSyncStatsCheck）。 */
        public Snapshot(boolean active, String stage, String pack, int packsDone, int packsTotal, int conns,
                        long bytesDone, long bytesTotal, long dlBps, long unzipBps, long etaMs,
                        long elapsedMs) {
            this.active = active;
            this.stage = stage == null ? "" : stage;
            this.pack = pack == null ? "" : pack;
            this.packsDone = Math.max(0, packsDone);
            this.packsTotal = Math.max(0, packsTotal);
            this.conns = Math.max(1, conns);
            this.bytesDone = Math.max(0L, bytesDone);
            this.bytesTotal = Math.max(0L, bytesTotal);
            this.dlBps = Math.max(0L, dlBps);
            this.unzipBps = Math.max(0L, unzipBps);
            this.etaMs = etaMs < 0 ? -1L : etaMs;
            this.elapsedMs = Math.max(0L, elapsedMs);
        }
    }

    // ------------------------------------------------------------------
    // 写入侧（只有 ArtStore.sync 的安装线程 / 下载线程调）
    // ------------------------------------------------------------------

    /**
     * 一次 sync 开始。{@code packsTotal} 是<b>本次需要安装</b>的包数（已装好的不进去）；
     * {@code conns} 是下载通道的并发连接数（1 = 单连接续传，&gt;1 = 分段，{@link #setConns} 之后会更新）。
     */
    public static void begin(int packsTotal, int conns) {
        synchronized (LOCK) {
            active = true;
            stage = "";
            pack = "";
            packsDone = 0;
            ArtSyncStats.packsTotal = Math.max(0, packsTotal); // 名字与字段同名，必须限定（否则只写参数）
            ArtSyncStats.conns = Math.max(1, conns);
            startedAt = System.currentTimeMillis();
            elapsedMs = 0;
            DL.start();
            UZ.start();
            dlDone = 0; dlTotal = 0; dlBps = 0; dlAt = 0;
            uzDone = 0; uzTotal = 0; unzipBps = 0; uzAt = 0;
        }
    }

    /** 一个包的一条通道开工：把该通道抬上前台（stage/pack 上屏），并复位它的字节对与窗口。 */
    public static void packStart(String id, String newStage) {
        synchronized (LOCK) {
            pack = id == null ? "" : id;
            stage = newStage == null ? "" : newStage;
            if (STAGE_UNZIP.equals(stage)) {
                UZ.start();
                uzDone = 0; uzTotal = 0;
            } else {
                DL.start();
                dlDone = 0; dlTotal = 0;
            }
        }
    }

    /**
     * 某条通道的字节进度；由下载循环（每块）与解包循环（每条目）调用。
     * {@code stage} 必须显式给出 —— 包级并发下，「这是哪条通道」靠参数区分，不靠猜。
     * {@code total &lt;= 0} = 总长未知（解包常见）：只记进度、不推 ETA。
     */
    public static void onBytes(String stage, long done, long total) {
        long now = System.currentTimeMillis();
        boolean unzip = STAGE_UNZIP.equals(stage);
        synchronized (LOCK) {
            ArtSyncStats.stage = unzip ? STAGE_UNZIP : STAGE_DOWNLOAD; // 谁报数谁上屏
            if (unzip) {
                UZ.add(now, done, total);
                uzDone = UZ.done;
                uzTotal = UZ.total;
                uzAt = now;
                unzipBps = UZ.bpsNow(now);
            } else {
                DL.add(now, done, total);
                dlDone = DL.done;
                dlTotal = DL.total;
                dlAt = now;
                dlBps = DL.bpsNow(now);
            }
            if (active && startedAt > 0) elapsedMs = now - startedAt;
        }
    }

    /** 一个包装完了（含失败 —— 进度是「处理到的包数」，不是「成功的包数」）。 */
    public static void packDone(int done) {
        synchronized (LOCK) {
            packsDone = Math.max(0, done);
        }
    }

    /** 下载用的是几条连接（Updater 选中分段模式时调；1 = 线性续传）。 */
    public static void setConns(int n) {
        conns = Math.max(1, n);
    }

    /** 一次 sync 结束（成功或失败都调）：两条通道的速率归零，但保留最后的 stage / 包进度读数。 */
    public static void end() {
        synchronized (LOCK) {
            active = false;
            if (startedAt > 0) elapsedMs = System.currentTimeMillis() - startedAt;
            DL.start();
            UZ.start();
            dlBps = 0;
            unzipBps = 0;
        }
    }

    // ------------------------------------------------------------------
    // 读取侧（桥 / 自测）
    // ------------------------------------------------------------------

    /** 读数：某条通道空闲太久的话它的速率按 0 报（见 IDLE_RESET_MS），其余字段原样。 */
    public static Snapshot snapshot() {
        long now = System.currentTimeMillis();
        boolean unzip = STAGE_UNZIP.equals(stage);
        long dl = dlAt > 0 && now - dlAt > IDLE_RESET_MS ? 0L : dlBps;
        long uz = uzAt > 0 && now - uzAt > IDLE_RESET_MS ? 0L : unzipBps;
        long done = unzip ? uzDone : dlDone;
        long total = unzip ? uzTotal : dlTotal;
        long rate = unzip ? uz : dl;
        long eta = (rate > 0 && total > done) ? (total - done) * 1000L / rate : -1L;
        return new Snapshot(active, stage, pack, packsDone, packsTotal, conns, done, total, dl, uz, eta,
                active && startedAt > 0 ? now - startedAt : elapsedMs);
    }

    /**
     * {@code {"ok":true,"active":…,"stage":…,"pack":…,"packsDone":…,"packsTotal":…,"conns":…,
     * "bytesDone":…,"bytesTotal":…,"dlBps":…,"unzipBps":…,"etaMs":…,"elapsedMs":…}}。
     * {@code etaMs} 传 -1 = 算不出（页面不画那一行）。
     */
    public static String statusJson(Snapshot s) {
        return "{\"ok\":true,\"active\":" + s.active
                + ",\"stage\":" + ArtCacheStats.quote(s.stage)
                + ",\"pack\":" + ArtCacheStats.quote(s.pack)
                + ",\"packsDone\":" + s.packsDone
                + ",\"packsTotal\":" + s.packsTotal
                + ",\"conns\":" + s.conns
                + ",\"bytesDone\":" + s.bytesDone
                + ",\"bytesTotal\":" + s.bytesTotal
                + ",\"dlBps\":" + s.dlBps
                + ",\"unzipBps\":" + s.unzipBps
                + ",\"etaMs\":" + s.etaMs
                + ",\"elapsedMs\":" + s.elapsedMs + "}";
    }

    /** 桥直接调它：一次 volatile 读数 + 拼串，O(1)。 */
    public static String liveJson() {
        return statusJson(snapshot());
    }
}
