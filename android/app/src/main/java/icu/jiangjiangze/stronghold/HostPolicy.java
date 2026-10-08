package icu.jiangjiangze.stronghold;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 主机「是否公网可寻址」的判定表 —— **纯逻辑，零 IO、零 Android 依赖**，JVM 可直接测。
 *
 * <p>这段判定原先内联在 {@link ServerList#isPublicHttpUrl(String)} 里。把它抽出来只有一个理由：
 * 「服务端界面」（用该服自有客户端）的默认值与安全门也依赖同一张表 —— 环回/私网/保留地址与
 * {@code .local}/{@code .internal} 名**必须**保留内嵌树（本机服务 {@code 127.0.0.1}、局域网房间），
 * 否则「本地客户端」那一页会丢掉 {@code SHELL_INJECT}（没有面板、没有设置、没有热更钩子）。
 * 一张表两个调用方，任何一侧的加固都自动对另一侧生效；复制第二份表迟早会漂移。
 *
 * <p>调用方：{@link ServerList#isPublicHttpUrl(String)}（URL 准入，先做 scheme/userinfo 检查再交给
 * 本类）与 {@link RemoteClientPolicy#resolve}（服务端界面开关的两道硬门之一）。
 *
 * <h3>拒斥范围（与审计 §4 逐字一致，未放宽）</h3>
 * <ul>
 *   <li>字面量环回/私网/链路本地/保留 IPv4：{@code 0/10/127/169.254/172.16-31/192.168/100.64-127/
 *       >=224}；</li>
 *   <li>IPv6：unique-local {@code fc00::/7}、link-local {@code fe80::/10}、NAT64 64:ff9b::/96、
 *       以及 v4-嵌入形态（IPv4-mapped {@code ::ffff:a.b.c.d}、IPv4-compatible {@code ::a.b.c.d}/
 *       {@code ::}/{@code ::1}、RFC 2765 {@code ::ffff:0:a.b.c.d}）—— 一律解开低位 32 bit 后套 IPv4 表；</li>
 *   <li>{@code localhost}/{@code .localhost}/{@code .local}/{@code .internal}；zone id（含 {@code %}）；
 *       纯数字/十六进制整数主机（{@code 2130706433}、{@code 0x7f000001}）；无法解析的 v6 字面量。</li>
 * </ul>
 *
 * <p>Portability: desktop JDK keeps the brackets in {@code URL.getHost()} while some Android libcore
 * versions strip them — brackets are stripped defensively here and the v6 path dispatches on the
 * presence of ':' in the host, so mapped literals are caught on both.
 */
public final class HostPolicy {

    /** True when {@code host} (as returned by {@code URL.getHost()} / {@code Uri.getHost()}) is a
     *  publicly routable name or address. Bracketed v6 literals are accepted; null/empty → false. */
    public static boolean isPublicHost(String host) {
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
    private static String expandV6(String v6) {
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

    private HostPolicy() {}
}
