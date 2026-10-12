package icu.jiangjiangze.stronghold;

/**
 * 局域网地址判定（纯逻辑：无 Android 依赖、无 IO、无网络，裸 JDK 可测 —— 见
 * {@code tools/apk/jvm/run-lan-net-check.sh}）。
 *
 * <p><b>为什么单独成类</b>：同一个「哪些 IPv4 算局域网」的判定原本在 {@link LanScan}（扫描/加入
 * 的目标范围）与 MainActivity 的 JS 桥（{@code lan:} id 校验）里各写了一份。两处一旦漂移就会出现
 * 「扫描能发现、加入却被拒」这类只在一半路径上出现的裂缝，因此收敛到一处，两边都调它。
 *
 * <p><b>范围</b>：10/8、172.16/12、192.168/16（Java 的
 * {@code InetAddress.isSiteLocalAddress()} 口径），再加 RFC 6598 的 100.64/10（CGNAT）。
 *
 * <p><b>为什么要 100.64/10</b>：Tailscale / ZeroTier / 各类组网 VPN 的虚拟局域网就落在这段，
 * 而 {@code isSiteLocalAddress()} 不认它。房主 Node 侧（{@code tools/apk/overlay/sp-host.mjs}
 * 的私网判定）早已接受该段的探测请求，于是客户端出现了「地址表里有 zt 地址、却扫不到也加入不了
 * 同段房间」——两端口径不一致。补上这一段只是把客户端拉到与服务端口径一致。
 *
 * <p><b>它不是安全边界</b>：只描述「允许的目标范围」。真正拦住「页面让应用去请求任意内网服务」的
 * 仍是 {@link LanScan#isDiscovered}（近期扫描真实应答过的 ip:port）。放大范围不会让页面拿到它
 * 编不出来的 id。
 */
public final class LanNet {

    private LanNet() {
    }

    /**
     * 私网 IPv4 字面量判定。只认点分十进制、每段 0–255 且无前导符号/空格；任何不合规形态一律 false
     * （拒绝比宽容重要：这是范围闸，不是格式化工具）。
     */
    public static boolean isPrivateIpv4(String ip) {
        if (ip == null) return false;
        String[] o = ip.split("\\.");
        if (o.length != 4) return false;
        int[] n = new int[4];
        for (int i = 0; i < 4; i++) {
            String part = o[i];
            if (part.isEmpty() || part.length() > 3) return false;
            // 前导零一律拒绝：不同解析器对 "010" 有十进制 10 与八进制 8 两种读法，而这是范围闸，
            // 一旦两边读法不同就能绕过（同一串在扫描侧是私网、在校验侧不是）。
            if (part.length() > 1 && part.charAt(0) == '0') return false;
            for (int j = 0; j < part.length(); j++) {
                if (!Character.isDigit(part.charAt(j))) return false; // 只认纯十进制字面量
            }
            n[i] = Integer.parseInt(part);
            if (n[i] < 0 || n[i] > 255) return false;
        }
        if (n[0] == 10) return true;
        if (n[0] == 192 && n[1] == 168) return true;
        if (n[0] == 172 && n[1] >= 16 && n[1] <= 31) return true;
        return n[0] == 100 && n[1] >= 64 && n[1] <= 127; // RFC 6598 CGNAT（虚拟局域网）
    }
}
