import icu.jiangjiangze.stronghold.StartupOriginPolicy;

import java.util.ArrayList;
import java.util.List;

/**
 * JVM self-test for the cold-start default line (业主口径 2026-10-10：「开屏进入后默认首页为单人
 * 服务器」). Pure logic: no Android, no IO, no network. Bare JDK 17 (the class under test is
 * Android-free by design — see its header).
 *
 *   bash tools/apk/jvm/run-startup-origin-check.sh
 *
 * Covers the three assertions the protocol demands:
 *   ① 从未做过选择（origin 键缺失 / 值损坏为空）→ 冷启动默认单人服务器（{@code LOCAL}）；
 *   ② 已选择过（含显式选的 {@code "auto"}、任意具体地址）→ 逐字尊重，绝不被新默认覆盖；
 *   ③ 老装机（只有旧 origin 值、没有来源标记）→ 视为「已选择过」（值域上 old 版本只会写 "auto"
 *      与具体 URL，没有别的形态可丢）。
 * Plus the loadBase write-through values: 单人默认写符号值 "local"（绝不固化 127.0.0.1:PORT ——
 * 端口是 OS 随机分配的临时目标）、失败兜底写 "auto"（下次冷启动走自动线路，失败不能被固化成
 * local）、显式切服写具体地址（既有语义）。
 */
public final class StartupOriginCheck {

    private static int checks = 0;
    private static final List<String> failures = new ArrayList<>();

    /** 与 build.gradle 的 BuildConfig.DEFAULT_ORIGIN 同值（只在此测试里用作注入样例）。 */
    private static final String DEFAULT_LINE = "https://stronghold.jiangjiangze.icu";

    public static void main(String[] args) {
        testNeverChosenGoesSinglePlayer();
        testExplicitChoiceIsRespected();
        testLegacyInstallIsTreatedAsChosen();
        testPersistedValues();
        testSymbolValuesDoNotCollide();

        System.out.println("StartupOriginCheck OK: " + checks + " checks passed");
        if (!failures.isEmpty()) {
            System.out.println("FAILURES:");
            for (String f : failures) System.out.println("  - " + f);
            System.exit(1);
        }
    }

    // ------------------------------------------------------------------
    // ① 无显式选择 → 默认单人服务器
    // ------------------------------------------------------------------

    /** 全新安装：origin 键从未被写过（{@code getString} 的 null 默认）→ 单人服务器。 */
    private static void testNeverChosenGoesSinglePlayer() {
        check("no origin key -> single player (local)", isLocal(StartupOriginPolicy.resolveStartupOrigin(null)));
        // 值损坏/半截（空串）也算「没选过」：旧代码会把空串当成 URL loadBase("") → 首页永远不加载，
        // 新判据把它收进默认分支，最坏也只是走单人服务器/兜底线路，不会给玩家一个死页。
        check("empty origin value -> single player (local)", isLocal(StartupOriginPolicy.resolveStartupOrigin("")));
        // 默认分支与「选了 auto」必须可区分：auto 是选择，不是缺省。
        check("auto is NOT the never-chosen default", !isLocal(StartupOriginPolicy.resolveStartupOrigin("auto")));
    }

    // ------------------------------------------------------------------
    // ② / ③ 有显式选择（含 auto）与老装机 → 尊重
    // ------------------------------------------------------------------

    /** 显式选择：任何具体地址逐字返回；显式「自动线路」继续按既有语义（auto → 内置线路）。 */
    private static void testExplicitChoiceIsRespected() {
        String[] chosen = {
                DEFAULT_LINE,
                "https://map.u712507.nyat.app:38916",   // 国内线路
                "https://stronghold2.jiangjiangze.icu", // 国际线路 2
                "https://game.xiaolubao.com",           // 清单里的社区服
                "http://127.0.0.1:34567",               // 显式进过本机服务（老语义：具体地址）
        };
        for (String c : chosen) {
            check("explicit choice kept: " + q(c),
                    c.equals(StartupOriginPolicy.resolveStartupOrigin(c)));
            check("explicit choice never turns into the new default: " + q(c),
                    !isLocal(StartupOriginPolicy.resolveStartupOrigin(c)));
        }
        // 显式选「自动线路」：返回 auto 本身，由 MainActivity 按既有映射（BuildConfig.DEFAULT_ORIGIN）
        // 直达内置线路 —— 开屏仍不探测（业主 2026-10-09 口径），也绝不被新默认吃掉。
        check("explicit auto is respected (not overridden by local)",
                "auto".equals(StartupOriginPolicy.resolveStartupOrigin("auto")));
        // 自己写下的符号值 "local" 必须幂等：下次冷启动仍进单人服务器。
        check("the symbolic local value re-boots into single player",
                isLocal(StartupOriginPolicy.resolveStartupOrigin(StartupOriginPolicy.LOCAL)));
    }

    /**
     * 老装机（只有旧 origin 值、没有来源标记）→ 视为「已选择过」，不被新默认覆盖。
     * 旧版本的写入者只有两个：{@code setServer("auto")} 与 loadBase（写具体 URL）；因此老值域就是
     * 「auto 或 URL」，下面的每一条都必须原样保留 / 按既有 auto 语义处理，且绝不落进 LOCAL。
     */
    private static void testLegacyInstallIsTreatedAsChosen() {
        String[] legacy = {
                "auto",                                     // 老默认 / 老失败兜底写下的值
                DEFAULT_LINE,
                "https://map.u712507.nyat.app:38916",
                "https://stronghold2.jiangjiangze.icu",
        };
        for (String v : legacy) {
            String got = StartupOriginPolicy.resolveStartupOrigin(v);
            check("legacy install is 'already chosen' (not the new default): " + q(v), !isLocal(got));
            if ("auto".equals(v)) {
                check("legacy auto keeps the existing semantics (auto back, mapped by the caller)",
                        "auto".equals(got));
            } else {
                check("legacy concrete value is kept verbatim: " + q(v), v.equals(got));
            }
        }
    }

    // ------------------------------------------------------------------
    // loadBase 写盘值：符号模式不固化随机端口
    // ------------------------------------------------------------------

    private static void testPersistedValues() {
        String concrete = "http://127.0.0.1:34567";
        // 单人默认：写符号值，绝不把 OS 随机分配的端口固化进 prefs（否则下次冷启动带上死端口）。
        String single = StartupOriginPolicy.persistedValue(StartupOriginPolicy.PERSIST_LOCAL, concrete);
        check("single-player default persists the symbolic value", "local".equals(single));
        check("single-player default never fossilises the loopback port", !single.contains("127.0.0.1"));
        // 失败兜底：写 "auto"（下次冷启动走自动线路）——失败不能被固化成 local。
        String fallback = StartupOriginPolicy.persistedValue(StartupOriginPolicy.PERSIST_AUTO, concrete);
        check("failure fallback persists auto (not local)", "auto".equals(fallback));
        check("failure fallback is not the single-player default", !isLocal(fallback));
        // 显式切服：写去掉 room 的具体地址（既有语义）。
        check("explicit switch persists the concrete address",
                concrete.equals(StartupOriginPolicy.persistedValue(StartupOriginPolicy.PERSIST_CONCRETE, concrete)));
        // 回环闭合：写盘值再喂回 resolve，三条路径各自回到自己。
        check("round-trip: single player stays single player",
                isLocal(StartupOriginPolicy.resolveStartupOrigin(single)));
        check("round-trip: fallback resolves to the auto line, not local",
                "auto".equals(StartupOriginPolicy.resolveStartupOrigin(fallback)));
        check("round-trip: explicit stays explicit",
                concrete.equals(StartupOriginPolicy.resolveStartupOrigin(
                        StartupOriginPolicy.persistedValue(StartupOriginPolicy.PERSIST_CONCRETE, concrete))));
    }

    // ------------------------------------------------------------------
    // 值域：符号值不与任何真实地址相撞
    // ------------------------------------------------------------------

    private static void testSymbolValuesDoNotCollide() {
        check("symbol values are stable", "local".equals(StartupOriginPolicy.LOCAL)
                && "auto".equals(StartupOriginPolicy.AUTO));
        check("the two symbols are distinct", !StartupOriginPolicy.LOCAL.equals(StartupOriginPolicy.AUTO));
        // 长得像但不同的值绝不能被当成符号值（否则一台叫 local 的主机会被吞进单人服务器）。
        String[] lookalikes = {"https://local.example.com", "https://auto.example.com", "LOCAL", "Auto", "local:"};
        for (String v : lookalikes) {
            check("lookalike is not a symbol: " + q(v), v.equals(StartupOriginPolicy.resolveStartupOrigin(v)));
        }
    }

    // ------------------------------------------------------------------

    private static boolean isLocal(String resolved) {
        return StartupOriginPolicy.LOCAL.equals(resolved);
    }

    private static String q(String s) {
        return s == null ? "null" : "\"" + s + "\"";
    }

    private static void check(String name, boolean ok) {
        checks++;
        if (!ok) {
            failures.add(name);
            System.out.println("FAIL " + name);
        }
    }
}
