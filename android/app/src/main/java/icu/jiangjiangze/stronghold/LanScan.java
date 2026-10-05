package icu.jiangjiangze.stronghold;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 局域网房间发现（内网扫描）。房主 Node 侧在固定发现端口 {@link #DISCOVERY_PORT} 暴露
 * {@code /lan/rooms} 与 {@code /lan/room?code=CODE}，本类并发扫本机所在私网 /24 段把它们找出来。
 *
 * <p><b>安全边界（硬性）</b>：目标 IP 只能由「本机网卡的私网前缀」推导，本类不暴露任何接受外部
 * host/URL 的入口；请求不跟随重定向（发现端点不可能合法重定向）。这样即使发现结果被滥用，也扫不出
 * 本机私网之外。
 *
 * <p><b>超时纪律</b>：单个 IP 的失败/超时全部吞掉，绝不拖垮整轮；scanRooms 整体 ≤8s，
 * scanCode 整体按调用方预算（≤4s）。为此并发 32 线程，且用 deadline + Future.get 兜住慢请求。
 */
public final class LanScan {

    /** 与 Node 侧补丁共用的固定发现端口（不是游戏端口；游戏端口由响应里的 {@code port} 给出）。 */
    public static final int DISCOVERY_PORT = 32123;

    private static final int CONCURRENCY = 32;
    private static final int DEFAULT_PER_REQUEST_MS = 350;
    private static final long SCAN_ROOMS_BUDGET_MS = 8000L;
    private static final long SCAN_CODE_BUDGET_MS = 4000L;

    /**
     * 单个探测响应体的硬上限（64 KiB）。合法发现响应是几十到几百字节的 JSON，64 KiB 已远超任何
     * 正常响应。上限存在的唯一目的：防止同网段恶意/异常主机返回超大响应体，把 readAll 的无界
     * ByteArrayOutputStream 读爆、耗尽本进程堆内存并让扫描期间进程崩溃（Sourcery #23 发现 1）。
     */
    private static final int MAX_BODY_BYTES = 64 * 1024;

    /** 「近期真实发现」白名单有效期：页面只能加入 10 分钟内本进程实际扫到过的局域网主机。 */
    private static final long DISCOVERY_TTL_MS = 10 * 60 * 1000L;

    /**
     * 进程内「近期真实发现」端点表：key = {@code ip:port}，value = 发现时刻（epoch ms）。
     * 由 scan 成功探测（HTTP 200）时写入，只被 {@link #isDiscovered} 读取——它是「页面只能加入
     * 扫描真实发现过的局域网主机」这条安全边界的落点，不承载任何外部传入的 host/URL。
     */
    private static final ConcurrentHashMap<String, Long> DISCOVERED = new ConcurrentHashMap<>();

    /**
     * 不参与扫描的网卡：回环/隧道/VPN/虚拟网桥/蜂窝。蜂窝（rmnet*）与虚拟网（tun0）不是「局域网
     * 邻居」的所在网段，扫它们只会浪费预算并可能触发运营商侧的无意义请求。
     */
    private static final Set<String> IGNORED_IFACES = new HashSet<>(Arrays.asList(
            "lo", "tun0", "tap0", "ppp0", "ifb0", "dummy0", "br0", "rndis0", "usb0"));

    private LanScan() {
    }

    /** 一轮扫描的聚合计数：区分「扫描失败」与「真的没有房间」靠的就是这几个数（发现 2/3）。 */
    private static final class Stats {
        final AtomicInteger probed = new AtomicInteger(0);  // 实际发出的探测数（本机自身不计）
        final AtomicInteger answered = new AtomicInteger(0); // HTTP 200 应答数（不论 ok:false）
        final AtomicInteger errors = new AtomicInteger(0);   // 连接/读取/解析失败数
        final AtomicInteger hosts = new AtomicInteger(0);    // 200 且 ok:true 的主机数（语义不变）
    }

    /**
     * 扫描本机所有私网 /24 段的发现端口，聚合各房主发布的房间。
     *
     * @param timeoutMs 单请求 connect/read 超时（建议 350ms）；整体预算固定 8s
     * @return {@code {"ok":true,"hosts":N,"probed":P,"answered":A,"errors":E,"unreachable":bool,
     *         "rooms":[{"code","name","mode","difficulty","seats","humans","inMatch","ip","port",
     *         "url"}]}}；{@code unreachable} 为真表示「发了探测但一台都没答上」，界面据此把空
     *         rooms 显示成「扫描失败/网络不可达」而非「局域网内没有发现房间」
     */
    public static String scanRooms(int timeoutMs) {
        return scan(null, timeoutMs, SCAN_ROOMS_BUDGET_MS);
    }

    /**
     * 按房号精确查找（走 {@code /lan/room?code=CODE}）。房号先做 {@code [A-Z0-9]{4}} 校验，
     * 不合法直接返回空结果，绝不发请求。
     *
     * @param budgetMs 整轮预算（B3 调用方给 3000，保证「绝不阻塞主流程超过 3s」）；单请求超时
     *                 由它派生，避免 254 个 IP 各等满预算
     * @return 同 {@link #scanRooms} 的结构
     */
    public static String scanCode(String code, int budgetMs) {
        String c = code == null ? "" : code.trim().toUpperCase(Locale.ROOT);
        if (!c.matches("[A-Z0-9]{4}")) return emptyResult();
        long budget = Math.max(500L, Math.min(budgetMs <= 0 ? SCAN_CODE_BUDGET_MS : budgetMs,
                SCAN_CODE_BUDGET_MS));
        return scan(c, DEFAULT_PER_REQUEST_MS, budget);
    }

    private static String scan(String code, int perRequestMs, long budgetMs) {
        long deadline = System.currentTimeMillis() + budgetMs;
        int perIp = Math.max(150, Math.min(perRequestMs <= 0 ? DEFAULT_PER_REQUEST_MS : perRequestMs, 800));

        List<Inet4Address> locals = localSiteLocalV4();
        Set<String> selfIps = new HashSet<>();
        for (Inet4Address a : locals) selfIps.add(a.getHostAddress());
        List<String> targets = targets(locals);

        // 同 code 取首个命中：putIfAbsent 让先到者胜出（并发下「首个」不保证顺序，但对发现已足够）。
        ConcurrentHashMap<String, JSONObject> hits = new ConcurrentHashMap<>();
        Stats stats = new Stats();

        if (!targets.isEmpty()) {
            ExecutorService pool = Executors.newFixedThreadPool(CONCURRENCY);
            try {
                List<Future<?>> futures = new ArrayList<>();
                for (String ip : targets) {
                    if (System.currentTimeMillis() >= deadline) break; // 预算耗尽：不再发新请求
                    futures.add(pool.submit(() -> probe(ip, code, perIp, selfIps, hits, stats)));
                }
                for (Future<?> f : futures) {
                    long left = deadline - System.currentTimeMillis();
                    if (left <= 0) break;
                    try {
                        f.get(left, TimeUnit.MILLISECONDS);
                    } catch (Exception ignored) {
                        // 单 IP 超时/异常：吞掉，继续等后面的
                    }
                }
            } finally {
                pool.shutdownNow();
            }
        }

        try {
            List<String> codes = new ArrayList<>(hits.keySet());
            java.util.Collections.sort(codes); // 稳定输出，便于对照/调试
            JSONArray rooms = new JSONArray();
            for (String c : codes) rooms.put(hits.get(c));
            // 不可达判定：发了探测却一台都没答上 → 基本可判定不在同一网段/被隔离（发现 2）。
            // 空 rooms + unreachable=true 才是「扫描失败」；unreachable=false 才是「真没有房间」。
            boolean unreachable = stats.probed.get() > 0
                    && stats.answered.get() == 0
                    && stats.errors.get() > 0;
            return new JSONObject()
                    .put("ok", true)
                    .put("hosts", stats.hosts.get())
                    .put("probed", stats.probed.get())
                    .put("answered", stats.answered.get())
                    .put("errors", stats.errors.get())
                    .put("unreachable", unreachable)
                    .put("rooms", rooms)
                    .toString();
        } catch (Exception e) {
            return emptyResult();
        }
    }

    /**
     * 探测单个 IP：GET 发现端点，ok 即计一台主机；命中房号则并入结果（附 ip/port/url）。
     * 任何异常（拒绝/超时/非 JSON/响应超限）计入 errors，不打断整轮。
     */
    private static void probe(String ip, String code, int timeoutMs, Set<String> selfIps,
                              ConcurrentHashMap<String, JSONObject> hits, Stats stats) {
        if (selfIps.contains(ip)) return; // 本机自己的服务不算「局域网邻居」，也不计探测数
        stats.probed.incrementAndGet();
        HttpURLConnection conn = null;
        try {
            String path = code == null ? "/lan/rooms" : "/lan/room?code=" + code;
            URL url = new URL("http://" + ip + ":" + DISCOVERY_PORT + path);
            conn = (HttpURLConnection) url.openConnection();
            conn.setInstanceFollowRedirects(false); // 内网发现：绝不跟随重定向
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("User-Agent", "stronghold-shell");
            if (conn.getResponseCode() != 200) return; // 非 200 既不算应答也不算失败
            stats.answered.incrementAndGet();

            // Content-Length 若已声明超限，直接拒绝，连 body 都不读（发现 1 的第一道闸）。
            if (conn.getContentLengthLong() > MAX_BODY_BYTES) {
                stats.errors.incrementAndGet();
                return;
            }

            JSONObject doc;
            try {
                doc = new JSONObject(readAll(conn.getInputStream(), MAX_BODY_BYTES));
            } catch (Exception e) {
                stats.errors.incrementAndGet(); // 读取超限/连接中断/非 JSON：计入失败
                return;
            }
            // 响应里的 port 是游戏端口；缺失/越界时才回落到探测端口（契约：缺省用探测端口）。
            int port = doc.optInt("port", DISCOVERY_PORT);
            if (port < 1024 || port > 65535) port = DISCOVERY_PORT;
            // HTTP 200 即记入「近期真实发现」白名单（供 isDiscovered 校验页面传来的 lan: id）。
            DISCOVERED.put(ip + ":" + port, System.currentTimeMillis());

            if (!doc.optBoolean("ok", false)) return;
            stats.hosts.incrementAndGet();

            JSONArray list = doc.optJSONArray("rooms");
            if (list == null) return;
            for (int i = 0; i < list.length(); i++) {
                JSONObject room = list.optJSONObject(i);
                if (room == null) continue;
                String rc = room.optString("code", "").toUpperCase(Locale.ROOT);
                if (rc.isEmpty()) continue;
                if (code != null && !code.equals(rc)) continue; // 端点若多返回，只认目标房号
                JSONObject out = new JSONObject(room.toString());
                out.put("ip", ip);
                out.put("port", port);
                out.put("url", "http://" + ip + ":" + port);
                hits.putIfAbsent(rc, out);
            }
        } catch (Exception ignored) {
            // 拒绝/超时：计入失败，不打断整轮
            stats.errors.incrementAndGet();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 本机私网 IPv4，按网卡优先级排序（wlan0 最优，其余靠后）。 */
    private static List<Inet4Address> localSiteLocalV4() {
        List<Object[]> found = new ArrayList<>(); // {priority, Inet4Address}
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            while (nis != null && nis.hasMoreElements()) {
                NetworkInterface ni = nis.nextElement();
                String name = ni.getName() == null ? "" : ni.getName().toLowerCase(Locale.ROOT);
                if (IGNORED_IFACES.contains(name) || name.startsWith("rmnet")) continue;
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (!(a instanceof Inet4Address)) continue;
                    if (!a.isSiteLocalAddress()) continue; // 只收私网 IPv4（10/8、172.16/12、192.168/16）
                    found.add(new Object[]{ifacePriority(name), a});
                }
            }
        } catch (Exception ignored) {
        }
        found.sort((x, y) -> ((Integer) x[0]) - ((Integer) y[0]));
        List<Inet4Address> out = new ArrayList<>();
        for (Object[] o : found) out.add((Inet4Address) o[1]);
        return out;
    }

    /** 网卡优先级：wlan0=0，wlan* / swlan*=1，ap* / ath*=2，eth*=3，其余=5。 */
    private static int ifacePriority(String name) {
        if (name.equals("wlan0")) return 0;
        if (name.startsWith("wlan") || name.startsWith("swlan")) return 1;
        if (name.startsWith("ap") || name.startsWith("ath")) return 2;
        if (name.startsWith("eth")) return 3;
        return 5;
    }

    /** 每个本机私网 IPv4 所在 /24 的 1..254，按网卡优先级顺序去重展开。 */
    private static List<String> targets(List<Inet4Address> locals) {
        LinkedHashSet<String> set = new LinkedHashSet<>();
        for (Inet4Address a : locals) {
            byte[] b = a.getAddress();
            String prefix = (b[0] & 0xff) + "." + (b[1] & 0xff) + "." + (b[2] & 0xff) + ".";
            for (int i = 1; i <= 254; i++) set.add(prefix + i);
        }
        return new ArrayList<>(set);
    }

    /**
     * 读满响应体，硬上限 {@code maxBytes}。上限是内存安全的硬闸：一旦累计写入将超过上限就立刻抛
     * 异常，绝不把超限内容读进内存（发现 1）。调用方把该异常计入 errors，既不解析也不再继续读。
     */
    private static String readAll(InputStream in, int maxBytes) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (out.size() + n > maxBytes) {
                throw new java.io.IOException("lan discovery response exceeds " + maxBytes + " bytes");
            }
            out.write(buf, 0, n);
        }
        return out.toString("UTF-8");
    }

    /**
     * 该 (ip,port) 是否是本进程近期（10 分钟内）扫描真实发现过的端点（供 MainActivity 校验页面
     * 传来的 {@code lan:} id）。
     *
     * <p><b>安全边界落点</b>：这是「页面只能加入扫描真实发现过的局域网主机」这条约束的唯一实现——
     * 只查 {@link #DISCOVERED} 这张由扫描结果写入的表，不校验、也不接受任何调用方传入的任意
     * host/URL。私网 IPv4 字面量 + 端口范围校验是为了让被篡改的 id 无法借白名单绕过范围限制。
     *
     * <p>过期项在查询时顺手清理（表规模 ≤ 一轮扫描的主机数，无需额外线程/定时器）。
     */
    public static boolean isDiscovered(String ip, int port) {
        if (!isPrivateIpv4(ip)) return false;
        if (port < 1024 || port > 65535) return false;
        long now = System.currentTimeMillis();
        for (Iterator<Map.Entry<String, Long>> it = DISCOVERED.entrySet().iterator(); it.hasNext(); ) {
            if (now - it.next().getValue() > DISCOVERY_TTL_MS) it.remove();
        }
        Long at = DISCOVERED.get(ip + ":" + port);
        return at != null && now - at <= DISCOVERY_TTL_MS;
    }

    /** 私网 IPv4 字面量判定（10/8、172.16/12、192.168/16），与扫描范围一致。 */
    private static boolean isPrivateIpv4(String ip) {
        if (ip == null) return false;
        String[] o = ip.split("\\.");
        if (o.length != 4) return false;
        int[] n = new int[4];
        for (int i = 0; i < 4; i++) {
            String part = o[i];
            if (part.isEmpty() || part.length() > 3) return false;
            for (int j = 0; j < part.length(); j++) {
                if (!Character.isDigit(part.charAt(j))) return false; // 只认纯十进制字面量
            }
            n[i] = Integer.parseInt(part);
            if (n[i] < 0 || n[i] > 255) return false;
        }
        if (n[0] == 10) return true;
        if (n[0] == 192 && n[1] == 168) return true;
        return n[0] == 172 && n[1] >= 16 && n[1] <= 31;
    }

    /**
     * 空结果：无本机私网网卡（或非法房号）时返回。probed/answered/errors 全 0 且 unreachable=false，
     * 界面据此显示「局域网内没有发现房间」而非「扫描失败」。
     */
    private static String emptyResult() {
        return "{\"ok\":true,\"hosts\":0,\"probed\":0,\"answered\":0,\"errors\":0,"
                + "\"unreachable\":false,\"rooms\":[]}";
    }
}
