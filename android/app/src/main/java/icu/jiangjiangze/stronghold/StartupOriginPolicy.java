package icu.jiangjiangze.stronghold;

/**
 * 冷启动「默认线路」的**纯决策表** —— 零 IO、零 Android 依赖，JVM 可直接测
 * （见 {@code tools/apk/jvm/run-startup-origin-check.sh} 与 StartupOriginCheck）。
 *
 * <p>业主口径 2026-10-10：「开屏进入后默认首页为单人服务器」。单人服务器 = 本机服务
 * （{@code setServer("local")} → {@code 127.0.0.1:<随机端口>}，壳侧 materialise + Node 运行时；
 * 见 {@code MainActivity.bootSinglePlayerDefault}），是没有 GUI 的本地单人局，首屏必须是本地树
 * 页面（叠加层可用 —— 本机/局域网 host 被 {@link RemoteClientPolicy} 的公网硬门挡在服务端界面
 * 之外，逐字保留内嵌树）。
 *
 * <h3>判据：origin 键有没有被写过</h3>
 * <ul>
 *   <li><b>没写过</b>（全新安装 / 从未做过选择；{@code prefs.getString("origin", null)} 为 null，
 *       或值损坏为空）→ {@link #LOCAL}：冷启动默认进单人服务器。</li>
 *   <li><b>写过</b>→ 一律尊重该值：{@link #AUTO} 交回调用方按既有语义映射到内置线路
 *       （{@code BuildConfig.DEFAULT_ORIGIN}，开屏不探测 —— 业主 2026-10-09「开屏不自动测速选服」）；
 *       其余是具体地址（含老装机的遗留值），逐字加载。</li>
 * </ul>
 *
 * <h3>为什么用现成的 origin 键、不新增「来源标记」</h3>
 * 老装机（任何旧版本的持久化）里**只有** origin 值、没有来源标记。新键方案必须把「键缺失 + 值在」
 * 判成「已选择过」才不会吃掉老用户的显式选择 —— 等价于本方案，却多一次键空间扩张与迁移路径。
 * 值域上 {@link #LOCAL} 是**新引入的符号值**（旧版本的写入者只有 {@code setServer("auto")} 与
 * loadBase 的具体 URL，从不写 "local"），所以新默认不会与任何老值相撞；{@link #AUTO} 与具体地址
 * 的语义逐字不变。失败兜底写的 "auto" 与显式选的 "auto" **故意不再区分**：两者的下次冷启动行为
 * 本来就该一致（见 MainActivity 的 A2 注释）。
 *
 * <h3>失败兜底（不能丢）</h3>
 * 单人服务器起不来（Node 缺失 / healthz 超时）由 MainActivity 退回既有 "auto" 线路并持久化
 * {@link #PERSIST_AUTO}，绝不给玩家一个死页；本类只回答「冷启动该走哪条」，不回答「起不来怎么办」。
 * 反过来，失败**绝不能**被固化成 {@link #LOCAL}（那会让下次冷启动又等一个起不来的服务）。
 *
 * <h3>持久化模式（loadBase 一次性消费）</h3>
 * {@link #persistedValue} 把「本次导航为什么发生」翻译成写盘值：符号模式写符号值 —— 本机服务端口
 * 是 OS 随机分配的临时目标（{@code HostService.PORT} 由 Node handshake 采纳），固化它 = 下次冷启动
 * 带死端口直连失败（A2 审计的原话），所以单人默认写 {@link #LOCAL} 而不是 127.0.0.1:PORT。
 */
public final class StartupOriginPolicy {

    /** 从未做过选择时的冷启动默认：单人服务器（本机服务，{@code 127.0.0.1:<port>}）。 */
    public static final String LOCAL = "local";
    /** 自动线路的符号值（既有值域）：冷启动由调用方映射到内置线路，不探测。 */
    public static final String AUTO = "auto";

    /** 显式切服：持久化去掉 room 的具体地址（A2 之前的既有语义）。 */
    public static final String PERSIST_CONCRETE = "concrete";
    /** 失败兜底（A2，审计 §1）：持久化 "auto" —— 下次冷启动重走自动线路，不固化本地端口。 */
    public static final String PERSIST_AUTO = AUTO;
    /** 单人服务器默认（2026-10-10）：持久化符号值 "local" —— 下次冷启动仍进单人服务器。 */
    public static final String PERSIST_LOCAL = LOCAL;

    /**
     * 冷启动该加载哪条线路。返回 {@link #LOCAL}（单人服务器）或一个可直接 loadBase 的值
     * （{@link #AUTO} 或具体地址）—— auto 的 URL 映射留给调用方（BuildConfig.DEFAULT_ORIGIN）。
     *
     * @param savedOrigin {@code prefs.getString("origin", null)} 的原始值；null / 空 = 没写过
     * @return {@link #LOCAL} 或已选择/遗留的值（逐字）
     */
    public static String resolveStartupOrigin(String savedOrigin) {
        if (savedOrigin == null || savedOrigin.isEmpty()) return LOCAL;  // 从未选择 → 单人服务器
        return savedOrigin;                                             // 显式选择 / 老装机遗留：尊重
    }

    /**
     * loadBase 的写盘值（{@code prefs "origin"}）：符号模式写符号值，显式模式写具体地址。
     * 一次性消费由调用方负责（MainActivity.persistMode）。
     *
     * @param persistMode  {@link #PERSIST_CONCRETE} / {@link #PERSIST_AUTO} / {@link #PERSIST_LOCAL}
     * @param concreteUrl  本次导航落地的具体地址（已去掉临时 room 参数）
     * @return 写进 prefs 的 origin 值
     */
    public static String persistedValue(String persistMode, String concreteUrl) {
        if (LOCAL.equals(persistMode) || AUTO.equals(persistMode)) return persistMode;
        return concreteUrl;
    }

    private StartupOriginPolicy() {}
}
