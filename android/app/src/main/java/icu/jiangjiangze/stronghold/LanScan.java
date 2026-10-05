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
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
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
     * 不参与扫描的网卡：回环/隧道/VPN/虚拟网桥/蜂窝。蜂窝（rmnet*）与虚拟网（tun0）不是「局域网
     * 邻居」的所在网段，扫它们只会浪费预算并可能触发运营商侧的无意义请求。
     */
    private static final Set<String> IGNORED_IFACES = new HashSet<>(Arrays.asList(
            "lo", "tun0", "tap0", "ppp0", "ifb0", "dummy0", "br0", "rndis0", "usb0"));

    private LanScan() {
    }

    /**
     * 扫描本机所有私网 /24 段的发现端口，聚合各房主发布的房间。
     *
     * @param timeoutMs 单请求 connect/read 超时（建议 350ms）；整体预算固定 8s
     * @return {@code {"ok":true,"hosts":N,"rooms":[{"code","name","mode","difficulty","seats",
     *         "humans","inMatch","ip","port","url"}]}}
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
        AtomicInteger hosts = new AtomicInteger(0);

        if (!targets.isEmpty()) {
            ExecutorService pool = Executors.newFixedThreadPool(CONCURRENCY);
            try {
                List<Future<?>> futures = new ArrayList<>();
                for (String ip : targets) {
                    if (System.currentTimeMillis() >= deadline) break; // 预算耗尽：不再发新请求
                    futures.add(pool.submit(() -> probe(ip, code, perIp, selfIps, hits, hosts)));
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
            return new JSONObject()
                    .put("ok", true)
                    .put("hosts", hosts.get())
                    .put("rooms", rooms)
                    .toString();
        } catch (Exception e) {
            return emptyResult();
        }
    }

    /**
     * 探测单个 IP：GET 发现端点，ok 即计一台主机；命中房号则并入结果（附 ip/port/url）。
     * 任何异常（拒绝/超时/非 JSON）静默计入失败。
     */
    private static void probe(String ip, String code, int timeoutMs, Set<String> selfIps,
                              ConcurrentHashMap<String, JSONObject> hits, AtomicInteger hosts) {
        if (selfIps.contains(ip)) return; // 本机自己的服务不算「局域网邻居」
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
            if (conn.getResponseCode() != 200) return;
            JSONObject doc = new JSONObject(readAll(conn.getInputStream()));
            if (!doc.optBoolean("ok", false)) return;
            hosts.incrementAndGet();

            JSONArray list = doc.optJSONArray("rooms");
            if (list == null) return;
            // 响应里的 port 是游戏端口；缺失时才回落到探测端口（契约：缺省用探测端口）。
            int port = doc.optInt("port", DISCOVERY_PORT);
            if (port < 1024 || port > 65535) port = DISCOVERY_PORT;
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
            // 拒绝/超时/非 JSON：计入失败，不打断整轮
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

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toString("UTF-8");
    }

    private static String emptyResult() {
        return "{\"ok\":true,\"hosts\":0,\"rooms\":[]}";
    }
}
