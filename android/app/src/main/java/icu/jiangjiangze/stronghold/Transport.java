package icu.jiangjiangze.stronghold;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Locale;

/**
 * 加入房间的传输档位（Transport）。四档各有明确的稳定性差异，所以默认 auto 的探测顺序是
 * 「局域网 → 虚拟网 → IPv6 → 打洞」——从最稳到最不稳：
 * <ul>
 *   <li>{@code lan} 局域网直连：同一网段无 NAT、无中继，成功率与延迟都最好；</li>
 *   <li>{@code zt} 虚拟网 P2P：自带中继兜底，两端都装了才通，但通了以后基本不挑网络；</li>
 *   <li>{@code v6} IPv6 直连：无 NAT，但要求双方都有全局单播 IPv6，缺一方就完全不通；</li>
 *   <li>{@code dc} WebRTC 打洞：只有 STUN 没有 TURN，对称 NAT/CGNAT 下打不通，成功率最低，
 *       所以永远排在最后，只在其余三档全失败时作为兜底（见 resolveAndJoin 的 useDc）。</li>
 * </ul>
 * 用户显式选定某档只是「优先」该档，其余档仍按 auto 顺序补全——某一档临时不可用时不至于
 * 直接失败。非法/空值一律回落 auto，避免坏偏好把加入路径锁死。
 */
public final class Transport {

    public static final String LAN = "lan";
    public static final String ZT = "zt";
    public static final String V6 = "v6";
    public static final String DC = "dc";
    public static final String AUTO = "auto";

    /** 与 HostParams 共用同一个 SharedPreferences 文件，房主参数与传输偏好一处管理。 */
    private static final String PREF_FILE = "host_params";
    private static final String PREF_KEY = "transport";

    /** auto 的基准顺序：稳定度从高到低。order() 的补全也以此为模板。 */
    private static final String[] AUTO_ORDER = {LAN, ZT, V6, DC};

    private Transport() {
    }

    /** 读取规范化后的档位；无值/非法值一律返回 {@link #AUTO}。 */
    public static String load(Context ctx) {
        String v = ctx.getSharedPreferences(PREF_FILE, Context.MODE_PRIVATE)
                .getString(PREF_KEY, AUTO);
        return normalize(v);
    }

    /** 持久化档位（写入前规范化，非法值存 auto）。 */
    public static void save(Context ctx, String v) {
        ctx.getSharedPreferences(PREF_FILE, Context.MODE_PRIVATE).edit()
                .putString(PREF_KEY, normalize(v))
                .apply();
    }

    /**
     * 探测顺序：显式档放首位，其余按 auto 顺序补全（不是只走该档）。auto 时即
     * {@code {"lan","zt","v6","dc"}}。返回新数组，调用方持有后不会被并发写坏。
     */
    public static String[] order(Context ctx) {
        String want = load(ctx);
        String[] out = new String[AUTO_ORDER.length];
        int n = 0;
        if (!AUTO.equals(want)) out[n++] = want;
        for (String t : AUTO_ORDER) {
            if (t.equals(want)) continue;
            out[n++] = t;
        }
        return out;
    }

    private static String normalize(String v) {
        if (v == null) return AUTO;
        switch (v.trim().toLowerCase(Locale.ROOT)) {
            case LAN: return LAN;
            case ZT: return ZT;
            case V6: return V6;
            case DC: return DC;
            default: return AUTO;
        }
    }
}
