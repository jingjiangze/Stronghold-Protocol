import icu.jiangjiangze.stronghold.StartupOriginPolicy;

import java.util.ArrayList;
import java.util.List;

/**
 * JVM self-test for the cold-start default line (业主口径 2026-10-10 审计修正后：「默认打开就是
 * 本地服务」). Pure logic: no Android, no IO, no network. Bare JDK 17 (the class under test is
 * Android-free by design — see its header).
 *
 *   bash tools/apk/jvm/run-startup-origin-check.sh
 *
 * Covers the four assertions the protocol demands (2026-10-10 业主：「默认打开必须是本地服务，
 * 老值不得被当成用户选择」):
 *   ① **没有「用户选择」来源标记** —— 全新安装（origin null/空）、升级机遗留的旧 origin 值
 *      （{@code "auto"} 或任意具体 URL）、失败兜底写下的 "auto" —— 一律 → 本机服务（{@code LOCAL}）；
 *   ② 有标记（{@code originSource = "user"}）→ 逐字尊重 origin（含显式 {@code "auto"}）；
 *   ③ 失败兜底写 "auto" 但**不**标记 → 下次冷启动仍优先本机服务（一次失败不许把设备钉在远端）；
 *   ④ 用户显式切服（面板选线路 / 自定义线路 / 显式进本机服务 / 显式选 auto）→ 标记为「用户选择」。
 * Plus the loadBase write-through values: 本机服务写符号值 "local"（绝不固化 127.0.0.1:PORT ——
 * 端口是 OS 随机分配的临时目标）、失败兜底写 "auto"、显式切服写具体地址。
 */
public final class StartupOriginCheck {

    private static int checks = 0;
    private static final List<String> failures = new ArrayList<>();

    /** 与 build.gradle 的 BuildConfig.DEFAULT_ORIGIN 同值（只在此测试里用作注入样例）。 */
    private static final String DEFAULT_LINE = "https://stronghold.jiangjiangze.icu";
    private static final String SOURCE = StartupOriginPolicy.SOURCE_USER;

    public static void main(String[] args) {
        testNeverChosenGoesSinglePlayer();
        testLegacyInstallWithoutMarkerIsTreatedAsNeverChosen();
        testUserChoiceIsRespected();
        testFailureFallbackDoesNotPinTheDevice();
        testExplicitChoicesAreMarked();
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
    // ① 没有用户选择标记 → 默认单人服务器（本机服务）
    // ------------------------------------------------------------------

    /** 全新安装：origin 与来源标记都从未被写过（{@code getString} 的 null 默认）→ 单人服务器。 */
    private static void testNeverChosenGoesSinglePlayer() {
        check("no origin key, no source -> single player (local)",
                isLocal(StartupOriginPolicy.resolveStartupOrigin(null, null)));
        // 值损坏/半截（空串）也算「没选过」：旧代码会把空串当成 URL loadBase("") → 首页永远不加载，
        // 新判据把它收进默认分支，最坏也只是走单人服务器/兜底线路，不会给玩家一个死页。
        check("empty origin value, no source -> single player (local)",
                isLocal(StartupOriginPolicy.resolveStartupOrigin("", null)));
        check("empty origin value with a user marker -> still single player (local)",
                isLocal(StartupOriginPolicy.resolveStartupOrigin("", SOURCE)));
        // 未知/损坏的来源值不是「用户选择」：只认 SOURCE_USER 一个字面值。
        check("unknown source value -> single player (local)",
                isLocal(StartupOriginPolicy.resolveStartupOrigin("auto", "old-version")));
        // 自己写下的符号值 "local" 必须幂等：下次冷启动仍进单人服务器（无论标记是否还在）。
        check("the symbolic local value re-boots into single player (no marker)",
                isLocal(StartupOriginPolicy.resolveStartupOrigin(StartupOriginPolicy.LOCAL, null)));
        check("the symbolic local value re-boots into single player (user marker)",
                isLocal(StartupOriginPolicy.resolveStartupOrigin(StartupOriginPolicy.LOCAL, SOURCE)));
    }

    // ------------------------------------------------------------------
    // ① 老装机：有 origin 无标记 = 不是用户选择 → 本机服务
    // ------------------------------------------------------------------

    /**
     * 老装机（2026-10-10 审计的核心修复）：旧版本的写入者只有 {@code setServer("auto")}、
     * loadBase 的具体 URL 与失败兜底的 "auto" —— 它们**都没有**来源标记，因此升级后的首次冷启动
     * 一律进本机服务（一次性行为变化，业主拍板）。「系统写的兜底值」与「用户的选择」不再混淆。
     */
    private static void testLegacyInstallWithoutMarkerIsTreatedAsNeverChosen() {
        String[] legacy = {
                "auto",                                     // 老默认 / 老冷启动写下的值
                DEFAULT_LINE,                               // 老冷启动 loadBase 的具体地址
                "https://map.u712507.nyat.app:38916",
                "https://stronghold2.jiangjiangze.icu",
                "https://game.xiaolubao.com",
                "http://127.0.0.1:34567",                   // 老版显式进过本机服务留下的死端口
        };
        for (String v : legacy) {
            String got = StartupOriginPolicy.resolveStartupOrigin(v, null);
            check("legacy value without marker is NOT a user choice -> local: " + q(v), isLocal(got));
        }
        // 反向哨兵：这些值只要带上「用户选择」标记就必须逐字尊重（否则上面那组会因为「实现把
        // 所有值都吃掉」而假绿）。
        for (String v : legacy) {
            String got = StartupOriginPolicy.resolveStartupOrigin(v, SOURCE);
            check("same value WITH the user marker is respected: " + q(v), v.equals(got));
        }
    }

    // ------------------------------------------------------------------
    // ② 用户显式选择 → 逐字尊重
    // ------------------------------------------------------------------

    /** 显式选择：任何具体地址逐字返回；显式「自动线路」继续按既有语义（auto → 内置线路）。 */
    private static void testUserChoiceIsRespected() {
        String[] chosen = {
                DEFAULT_LINE,
                "https://map.u712507.nyat.app:38916",   // 国内线路
                "https://stronghold2.jiangjiangze.icu", // 国际线路 2
                "https://game.xiaolubao.com",           // 清单里的社区服
        };
        for (String c : chosen) {
            check("explicit choice kept: " + q(c),
                    c.equals(StartupOriginPolicy.resolveStartupOrigin(c, SOURCE)));
            check("explicit choice never turns into the new default: " + q(c),
                    !isLocal(StartupOriginPolicy.resolveStartupOrigin(c, SOURCE)));
        }
        // 显式选「自动线路」：返回 auto 本身，由 MainActivity 按既有映射（BuildConfig.DEFAULT_ORIGIN）
        // 直达内置线路 —— 开屏仍不探测（业主 2026-10-09 口径），也绝不被新默认吃掉。
        check("explicit auto is respected (not overridden by local)",
                "auto".equals(StartupOriginPolicy.resolveStartupOrigin("auto", SOURCE)));
    }

    // ------------------------------------------------------------------
    // ③ 失败兜底：写 auto、不标记 → 下次冷启动仍优先本机服务
    // ------------------------------------------------------------------

    /**
     * 失败兜底（本机服务起不来 / 远端主帧失败）：写 "auto" 但**不写**用户标记 ——
     * 「别让一次失败把设备永久钉在远端」：写盘值喂回判据后必须是 LOCAL（下次冷启动优先尝试
     * 本机服务），而不是被当成用户选过 auto 直连内置线路。
     */
    private static void testFailureFallbackDoesNotPinTheDevice() {
        String concrete = "http://127.0.0.1:34567";
        String value = StartupOriginPolicy.persistedValue(StartupOriginPolicy.PERSIST_AUTO, concrete);
        String source = StartupOriginPolicy.persistedSource(StartupOriginPolicy.PERSIST_AUTO);
        check("failure fallback persists the symbolic auto", "auto".equals(value));
        check("failure fallback writes NO user marker", source == null);
        check("failure fallback round-trip -> single player retried next cold start",
                isLocal(StartupOriginPolicy.resolveStartupOrigin(value, source)));
        // 冷启动默认进本机服务成功：写 "local"、同样不标记（系统的默认行为不伪装成用户的选择）
        // —— 回环仍是本机服务。
        String bootValue = StartupOriginPolicy.persistedValue(StartupOriginPolicy.PERSIST_BOOT_LOCAL, concrete);
        String bootSource = StartupOriginPolicy.persistedSource(StartupOriginPolicy.PERSIST_BOOT_LOCAL);
        check("boot default persists the symbolic local", "local".equals(bootValue));
        check("boot default writes NO user marker", bootSource == null);
        check("boot default round-trip -> single player again",
                isLocal(StartupOriginPolicy.resolveStartupOrigin(bootValue, bootSource)));
    }

    // ------------------------------------------------------------------
    // ④ 用户显式切服 → 写用户标记
    // ------------------------------------------------------------------

    /** 显式切服（面板选线路/自定义线路）、显式进本机服务、显式选 auto：必须写用户标记。 */
    private static void testExplicitChoicesAreMarked() {
        check("explicit switch marks the source as user",
                SOURCE.equals(StartupOriginPolicy.persistedSource(StartupOriginPolicy.PERSIST_CONCRETE)));
        check("explicit local service marks the source as user",
                SOURCE.equals(StartupOriginPolicy.persistedSource(StartupOriginPolicy.PERSIST_LOCAL)));
        check("explicit auto (probe pending) marks the source as user",
                SOURCE.equals(StartupOriginPolicy.persistedSource(StartupOriginPolicy.PERSIST_AUTO_USER)));
        check("non-choice navigations never mark the source as user",
                StartupOriginPolicy.persistedSource(StartupOriginPolicy.PERSIST_BOOT_LOCAL) == null
                        && StartupOriginPolicy.persistedSource(StartupOriginPolicy.PERSIST_AUTO) == null
                        && StartupOriginPolicy.persistedSource(StartupOriginPolicy.PERSIST_KEEP) == null);
        // 显式选 auto、探测未落地就被杀：写盘值是 auto、标记在 → 下次冷启动尊重（不落回本机服务）。
        String pending = StartupOriginPolicy.persistedValue(StartupOriginPolicy.PERSIST_AUTO_USER, null);
        check("user-chosen auto survives a probe-time kill",
                "auto".equals(pending) && "auto".equals(StartupOriginPolicy.resolveStartupOrigin(
                        pending, StartupOriginPolicy.persistedSource(StartupOriginPolicy.PERSIST_AUTO_USER))));
    }

    // ------------------------------------------------------------------
    // loadBase 写盘值：符号模式不固化随机端口
    // ------------------------------------------------------------------

    private static void testPersistedValues() {
        String concrete = "http://127.0.0.1:34567";
        // 本机服务（默认或显式）：写符号值，绝不把 OS 随机分配的端口固化进 prefs。
        for (String mode : new String[]{StartupOriginPolicy.PERSIST_LOCAL, StartupOriginPolicy.PERSIST_BOOT_LOCAL}) {
            String single = StartupOriginPolicy.persistedValue(mode, concrete);
            check("local service persists the symbolic value (" + mode + ")", "local".equals(single));
            check("local service never fossilises the loopback port (" + mode + ")", !single.contains("127.0.0.1"));
        }
        // 显式切服：写去掉 room 的具体地址（既有语义）。
        check("explicit switch persists the concrete address",
                concrete.equals(StartupOriginPolicy.persistedValue(StartupOriginPolicy.PERSIST_CONCRETE, concrete)));
        // KEEP（重启服务后的 reload）：不写盘 —— 调用方据此跳过落盘（见 MainActivity.loadBase）。
        check("PERSIST_KEEP writes nothing", StartupOriginPolicy.persistedValue(StartupOriginPolicy.PERSIST_KEEP, concrete) == null
                && StartupOriginPolicy.persistedSource(StartupOriginPolicy.PERSIST_KEEP) == null);
        // 回环闭合：写盘值 + 写盘标记再喂回 resolve，三条路径各自回到自己。
        check("round-trip: boot default stays single player",
                isLocal(StartupOriginPolicy.resolveStartupOrigin(
                        StartupOriginPolicy.persistedValue(StartupOriginPolicy.PERSIST_BOOT_LOCAL, concrete),
                        StartupOriginPolicy.persistedSource(StartupOriginPolicy.PERSIST_BOOT_LOCAL))));
        check("round-trip: explicit stays explicit",
                concrete.equals(StartupOriginPolicy.resolveStartupOrigin(
                        StartupOriginPolicy.persistedValue(StartupOriginPolicy.PERSIST_CONCRETE, concrete),
                        StartupOriginPolicy.persistedSource(StartupOriginPolicy.PERSIST_CONCRETE))));
    }

    // ------------------------------------------------------------------
    // 值域：符号值/标记值不与任何真实地址相撞
    // ------------------------------------------------------------------

    private static void testSymbolValuesDoNotCollide() {
        check("symbol values are stable", "local".equals(StartupOriginPolicy.LOCAL)
                && "auto".equals(StartupOriginPolicy.AUTO)
                && "user".equals(StartupOriginPolicy.SOURCE_USER));
        check("the symbols are distinct", !StartupOriginPolicy.LOCAL.equals(StartupOriginPolicy.AUTO)
                && !StartupOriginPolicy.LOCAL.equals(StartupOriginPolicy.SOURCE_USER)
                && !StartupOriginPolicy.AUTO.equals(StartupOriginPolicy.SOURCE_USER));
        check("pref keys are stable", "origin".equals(StartupOriginPolicy.PREF_ORIGIN)
                && "originSource".equals(StartupOriginPolicy.PREF_SOURCE));
        // 持久化模式字符串两两不同（PERSIST_AUTO 与 AUTO 有意同值：它就是符号 auto 的别名），
        // 否则 persistedValue/persistedSource 的等值判断会互相串。
        String[] modes = {StartupOriginPolicy.PERSIST_CONCRETE, StartupOriginPolicy.PERSIST_LOCAL,
                StartupOriginPolicy.PERSIST_BOOT_LOCAL, StartupOriginPolicy.PERSIST_AUTO_USER,
                StartupOriginPolicy.PERSIST_KEEP};
        for (int i = 0; i < modes.length; i++) {
            for (int j = i + 1; j < modes.length; j++) {
                final String a = modes[i];
                final String b = modes[j];
                check("persist modes are distinct: " + q(a) + " vs " + q(b), !a.equals(b));
            }
        }
        check("PERSIST_AUTO is the auto symbol alias", "auto".equals(StartupOriginPolicy.PERSIST_AUTO));
        // 长得像但不同的值绝不能被当成符号值（否则一台叫 local 的主机会被吞进单人服务器）——
        // 在「用户选择」分支必须逐字保留，不做任何字符串嗅探。
        String[] lookalikes = {"https://local.example.com", "https://auto.example.com", "LOCAL", "Auto", "local:"};
        for (String v : lookalikes) {
            check("lookalike with a user marker is kept verbatim: " + q(v),
                    v.equals(StartupOriginPolicy.resolveStartupOrigin(v, SOURCE)));
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
