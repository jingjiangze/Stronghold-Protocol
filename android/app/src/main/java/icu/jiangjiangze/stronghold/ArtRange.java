package icu.jiangjiangze.stronghold;

/**
 * 分段下载的**纯策略**（业主 2026-10-09「多线程下载优化」）：包要不要分段、分成几段、每段是哪个
 * 字节区间、{@code Content-Range} 怎么读。放在这里是为了可测：{@link Updater} 本体依赖 Android，
 * 而这几条规则恰恰是最容易写错（差一字节就丢数据）的地方，{@code tools/apk/jvm/ArtSyncStatsCheck}
 * 用裸 JDK 直接跑它们。
 *
 * <p>零 Android 依赖、零副作用：没有网络、没有文件、没有线程 —— 网络那一层仍在 {@link Updater}
 * （https + ALLOWED_HOSTS + 重定向逐跳复验一个不少）。
 */
public final class ArtRange {

    /** 分段下载的最小体积：再小的话「探测 + 多连接」的开销盖过省下的时间。 */
    public static final long MIN_BYTES = 8L * 1024 * 1024;
    /** 每段的目标体积：段数 = ceil(size / 这个值)。4 MiB 让 64 MiB 的包正好铺满 16 条连接。 */
    public static final long SEGMENT_BYTES = 4L * 1024 * 1024;
    /**
     * 单包默认最多几条连接（业主 2026-10-09：「多线程默认为 16」）。
     *
     * <p>实测（2026-10-09，审计本仓「分段下载未生效」）：主源 {@code weishucdn} 支持 Range
     * （206 + {@code Content-Range}），而**备用源 {@code dl.jiangjiangze.icu} 不支持**（对 Range
     * 请求回 200）—— 后者会命中 {@code RangeUnsupported} 退回线性。旧值 4 条 + 12 MiB/段，使
     * 16–36 MiB 的包只拿到 2 条连接，看起来「多线程没生效」。
     */
    public static final int MAX_CONNS = 16;

    private ArtRange() {}

    /** {@link #connsFor(long, int)} 的默认形式（线程数未知 = 用满 {@link #MAX_CONNS}）。 */
    public static int connsFor(long size) {
        return connsFor(size, 0);
    }

    /**
     * 这个体积该用几条连接：&lt; {@link #MIN_BYTES} → 1（线性续传）；否则
     * {@code ceil(size / SEGMENT_BYTES)} 夹在 [2, {@link #MAX_CONNS}]，再按设备可用线程数封顶
     * （业主口径：「如无这些线程则取最高」—— {@code threads <= 0} 视为未知，用满上限）。
     */
    public static int connsFor(long size, int threads) {
        if (size < MIN_BYTES) return 1;
        long n = (size + SEGMENT_BYTES - 1) / SEGMENT_BYTES; // ceil: 64 MiB -> 16
        if (n < 2) n = 2;
        if (n > MAX_CONNS) n = MAX_CONNS;
        int cap = threads <= 0 ? MAX_CONNS : Math.max(1, Math.min(threads, MAX_CONNS));
        return (int) Math.max(1, Math.min(n, cap));
    }

    /**
     * 分段表：把 [0, size) 切成至多 conns 段，返回 {@code {{from, to}, …}}（闭区间、首尾相接、
     * 不重不漏、覆盖整个文件）。{@code size <= 0} 或 {@code conns < 1} 时返回空表 —— 调用方据此
     * 退回线性下载，而不是把零长度的东西当成一个文件。
     */
    public static long[][] segments(long size, int conns) {
        int n = Math.max(1, conns);
        if (size <= 0) return new long[0][];
        long seg = (size + n - 1) / n;
        long[][] out = new long[n][];
        int used = 0;
        for (int i = 0; i < n; i++) {
            long from = i * seg;
            if (from >= size) break;
            long to = Math.min(size - 1, from + seg - 1);
            out[used++] = new long[]{from, to};
        }
        long[][] trimmed = new long[used][];
        System.arraycopy(out, 0, trimmed, 0, used);
        return trimmed;
    }

    /** {@code Content-Range: bytes 0-0/12345} → 12345；解析不出（缺斜杠 / {@code *} / 非数字）返回 -1。 */
    public static long contentRangeTotal(String header) {
        if (header == null) return -1L;
        int slash = header.lastIndexOf('/');
        if (slash < 0) return -1L;
        String tail = header.substring(slash + 1).trim();
        if (tail.isEmpty() || tail.equals("*")) return -1L;
        try {
            long n = Long.parseLong(tail);
            return n > 0 ? n : -1L;
        } catch (NumberFormatException e) {
            return -1L;
        }
    }
}
