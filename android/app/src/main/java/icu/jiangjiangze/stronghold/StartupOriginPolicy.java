package icu.jiangjiangze.stronghold;

/**
 * 冷启动「默认线路」的**纯决策表** —— 零 IO、零 Android 依赖，JVM 可直接测
 * （见 {@code tools/apk/jvm/run-startup-origin-check.sh} 与 StartupOriginCheck）。
 *
 * <p>业主口径 2026-10-10（审计修正后逐字）：「默认打开就是本地服务」。单人服务器 = 本机服务
 * （{@code setServer("local")} → {@code 127.0.0.1:<随机端口>}，壳侧 materialise + Node 运行时；
 * 见 {@code MainActivity.bootSinglePlayerDefault}），是没有 GUI 的本地单人局，首屏必须是本地树
 * 页面（叠加层可用 —— 本机/局域网 host 被 {@link RemoteClientPolicy} 的公网硬门挡在服务端界面
 * 之外，逐字保留内嵌树）。
 *
 * <h3>判据：来源标记（{@link #PREF_SOURCE}）—— 不是 origin 值本身</h3>
 * <ul>
 *   <li><b>标记 = {@link #SOURCE_USER}</b>（用户在**本次构建里**显式选了线路/服务器：
 *       面板选线路 / 自定义线路 / 显式进本机服务）→ 尊重 {@code origin} 值：
 *       {@link #AUTO} 交回调用方按既有语义映射到内置线路（{@code BuildConfig.DEFAULT_ORIGIN}，
 *       开屏不探测 —— 业主 2026-10-09「开屏不自动测速选服」）；其余是具体地址，逐字加载。</li>
 *   <li><b>没有标记</b>（全新安装 / 升级机遗留的旧 origin 值 / 失败兜底写下的 {@code "auto"}）
 *       → {@link #LOCAL}：冷启动默认进单人服务器。**老装机有 origin 值但没有标记，按「从未选择」
 *       处理** —— 这是 2026-10-10 的一次性行为变化，符合业主新口径（升级后首次冷启动即进本机服务）。</li>
 * </ul>
 *
 * <h3>为什么必须是「来源标记」而不是「origin 键有没有被写过」（2026-10-10 审计修正）</h3>
 * 上一版把「origin 键写过」当成「用户选择过」：升级机（业主设备真机）的 prefs 里旧版本冷启动
 * 就写过 {@code auto} 或具体 URL，于是被判成显式选择 → 默认进了远端 —— 这正是业主看到的现象。
 * 结论：「系统写的兜底值」与「用户的选择」必须分开：本类只信 {@link #PREF_SOURCE} 标记。
 *
 * <h3>失败兜底（不能丢，且不许钉设备）</h3>
 * 单人服务器起不来（Node 缺失 / healthz 超时）由 MainActivity 退回既有 "auto" 线路并持久化
 * {@link #PERSIST_AUTO} —— **不写来源标记**，下次冷启动仍优先尝试本机服务（一次失败不许把设备
 * 永久钉在远端）。本类只回答「冷启动该走哪条」，不回答「起不来怎么办」。
 *
 * <h3>持久化模式（loadBase 一次性消费）</h3>
 * {@link #persistedValue} 把「本次导航为什么发生」翻译成写盘值（符号模式写符号值 —— 本机服务端口
 * 是 OS 随机分配的临时目标，{@code HostService.PORT} 由 Node handshake 采纳，固化它 = 下次冷启动
 * 带死端口直连失败）；{@link #persistedSource} 翻译成来源标记：
 * <ul>
 *   <li>{@link #PERSIST_CONCRETE}（显式切服：面板选线路/自定义线路/邀请码加入）→ 具体地址 +
 *       {@link #SOURCE_USER}；</li>
 *   <li>{@link #PERSIST_LOCAL}（显式进本机服务）→ 符号 {@link #LOCAL} + {@link #SOURCE_USER}；</li>
 *   <li>{@link #PERSIST_AUTO_USER}（用户选「自动线路」、探测尚未落地就被杀）→ 符号 {@link #AUTO}
 *       + {@link #SOURCE_USER}；</li>
 *   <li>{@link #PERSIST_BOOT_LOCAL}（冷启动默认进本机服务成功）/ {@link #PERSIST_AUTO}（失败兜底）
 *       → 写符号值，**不带标记**（清除旧标记）；</li>
 *   <li>{@link #PERSIST_KEEP}（重启房主服务后的 reload：不是选择）→ 不写盘、不动标记。</li>
 * </ul>
 */
public final class StartupOriginPolicy {

    /** 从未做过选择时的冷启动默认：单人服务器（本机服务，{@code 127.0.0.1:<port>}）。 */
    public static final String LOCAL = "local";
    /** 自动线路的符号值（既有值域）：冷启动由调用方映射到内置线路，不探测。 */
    public static final String AUTO = "auto";

    /** prefs 键：上次加载的线路值（符号值或具体地址）。 */
    public static final String PREF_ORIGIN = "origin";
    /** prefs 键：来源标记 —— **只在用户在本次构建里显式选择过线路/服务器时才写**（值见 {@link #SOURCE_USER}）。 */
    public static final String PREF_SOURCE = "originSource";
    /** {@link #PREF_SOURCE} 的值：本次构建里用户显式选择（面板选线路/自定义线路/显式进本机服务）。 */
    public static final String SOURCE_USER = "user";

    /** 显式切服：持久化去掉 room 的具体地址 + 用户标记（既有语义 + 2026-10-10 标记）。 */
    public static final String PERSIST_CONCRETE = "concrete";
    /** 显式进本机服务（用户点「离线服务」/首页「进入」）：持久化符号值 "local" + 用户标记。 */
    public static final String PERSIST_LOCAL = "local";
    /**
     * 冷启动默认进本机服务成功：持久化符号值 "local"，**不带用户标记** —— 下次冷启动仍按
     * 「未选择」判据进本机服务（行为等价，且不会把系统的默认行为伪装成用户的选择）。
     */
    public static final String PERSIST_BOOT_LOCAL = "boot-local";
    /** 失败兜底（本机服务起不来 / 远端页加载失败）：持久化 "auto"，**且清除用户标记**。 */
    public static final String PERSIST_AUTO = AUTO;
    /** 用户显式选「自动线路」、探测落点尚未写盘：持久化 "auto" + 用户标记。 */
    public static final String PERSIST_AUTO_USER = "auto-user";
    /** 非选择的导航（重启房主服务后的 reload 当前 origin）：不写盘、不动来源标记。 */
    public static final String PERSIST_KEEP = "keep";

    /**
     * 冷启动该加载哪条线路。返回 {@link #LOCAL}（单人服务器）或一个可直接 loadBase 的值
     * （{@link #AUTO} 或具体地址）—— auto 的 URL 映射留给调用方（BuildConfig.DEFAULT_ORIGIN）。
     *
     * <p><b>核心判据（2026-10-10）</b>：只认「来源标记 = 用户选择」。没有标记 —— 无论 origin 里
     * 是 null、空串、{@code "auto"}（老默认/失败兜底）还是老装机遗留的具体地址 —— 一律走本机服务。
     *
     * @param savedOrigin {@code prefs.getString("origin", null)} 的原始值
     * @param savedSource {@code prefs.getString("originSource", null)}：null/其它 = 没有用户选择
     * @return {@link #LOCAL} 或用户显式选择的值（逐字）
     */
    public static String resolveStartupOrigin(String savedOrigin, String savedSource) {
        // 没有「用户选择」标记：老装机遗留值 / 失败兜底写的 auto / 冷启动默认一律按未选择处理。
        if (!SOURCE_USER.equals(savedSource)) return LOCAL;
        // 标记在但值损坏（空/缺失）：退回默认而不是 loadBase("") 的永久死页。
        if (savedOrigin == null || savedOrigin.isEmpty()) return LOCAL;
        return savedOrigin;  // 用户显式选择（含显式 auto）：逐字尊重
    }

    /**
     * loadBase 的写盘值（{@code prefs "origin"}）：符号模式写符号值，显式模式写具体地址。
     * 一次性消费由调用方负责（MainActivity.persistMode）。
     *
     * @param persistMode  {@link #PERSIST_CONCRETE} / {@link #PERSIST_LOCAL} / {@link #PERSIST_BOOT_LOCAL}
     *                     / {@link #PERSIST_AUTO} / {@link #PERSIST_AUTO_USER} / {@link #PERSIST_KEEP}
     * @param concreteUrl  本次导航落地的具体地址（已去掉临时 room 参数）
     * @return 写进 prefs 的 origin 值；{@link #PERSIST_KEEP} → null（本次导航不写盘）
     */
    public static String persistedValue(String persistMode, String concreteUrl) {
        if (PERSIST_LOCAL.equals(persistMode) || PERSIST_BOOT_LOCAL.equals(persistMode)) return LOCAL;
        if (PERSIST_AUTO.equals(persistMode) || PERSIST_AUTO_USER.equals(persistMode)) return AUTO;
        if (PERSIST_KEEP.equals(persistMode)) return null;
        return concreteUrl;
    }

    /**
     * loadBase 的写盘来源标记（{@code prefs "originSource"}）。**只有用户显式选择过才写**；
     * 返回 null 表示调用方必须删除该键（冷启动默认 / 失败兜底 / KEEP —— 下次冷启动按「未选择」
     * 处理，仍优先尝试本机服务）。
     *
     * @param persistMode 见 {@link #persistedValue}
     * @return {@link #SOURCE_USER} 或 null（删除标记）
     */
    public static String persistedSource(String persistMode) {
        if (PERSIST_CONCRETE.equals(persistMode)
                || PERSIST_LOCAL.equals(persistMode)
                || PERSIST_AUTO_USER.equals(persistMode)) return SOURCE_USER;
        return null;
    }

    private StartupOriginPolicy() {}
}
