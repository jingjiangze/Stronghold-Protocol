package icu.jiangjiangze.stronghold;

/**
 * 服务端界面（「用该服自有客户端」）的**纯决策表** —— 零 IO、零 Android 依赖，JVM 可直接测。
 *
 * <p>业主口径 2026-10-08：「默认使用服务端 UI（设置中可改）」。页面/资源都走该服 origin（浏览器
 * 缓存提速、UI 与玩法与该服一致），设置面板可改回本地客户端；逐服也能单独覆盖。真正读偏好、
 * 装偏好、切导航仍是 {@link MainActivity}（{@code remoteClientFor} / {@code setRemoteClient}），
 * 这里只回答两个问题，让它们可测、可审：
 * <ol>
 *   <li>{@link #resolve} —— 这个 host 现在生效的是服务端界面吗？（两道硬门 + 显式优先）</li>
 *   <li>{@link #healthy} —— 这次主帧落地算不算「热更健康」？（两条路径的不变量）</li>
 * </ol>
 *
 * <h3>① 生效值：显式优先，缺省用全局默认（默认 true）</h3>
 * 逐 host 偏好（{@value #PREF_HOST_PREFIX}{@code <host>}）一旦被显式写过，就永远赢过全局默认
 * （{@value #PREF_DEFAULT}）；没写过才用全局默认。全局默认缺省 {@code true} = 服务端界面优先，
 * 这就是「默认服务端 UI」的落点；设置面板写的就是这个键（桥 {@code setRemoteClientDefault}）。
 *
 * <h3>两道硬门（都不可协商）</h3>
 * <ul>
 *   <li><b>已知服务器 host</b>（调用方传入 {@code knownServerHost}）：任意第三方页面保持今天的
 *       行为，绝不被接管。判定见 MainActivity.isKnownServerHost（当前 origin / 官方线路 /
 *       签名清单条目）。</li>
 *   <li><b>公网可寻址</b>（{@link HostPolicy#isPublicHost}）：环回/私网/保留地址与
 *       {@code .local}/{@code .internal} 名永远返回 false —— 本机服务 {@code 127.0.0.1} 与
 *       局域网房间必须保留内嵌树，否则「本地客户端」那一页会丢掉 {@code SHELL_INJECT}
 *       （没有面板、没有设置、没有热更钩子）。</li>
 * </ul>
 *
 * <h3>② 热更健康确认（两条路径的不变量）</h3>
 * <ul>
 *   <li><b>本地树路径</b>：{@code pageFromLocalTree} 为真 = 新树真的渲染了 → 消费 pending 标记
 *       （既有语义，逐字不变）。本地树坏掉时它不成立 → 标记保留 → 冷启动照旧回滚。</li>
 *   <li><b>服务端界面路径</b>：{@code remoteClientPage && !mainFrameErrored} = 主帧在服务端页面上
 *       成功落地。默认「服务端界面」时本地树永不渲染，若这条路径不算健康，pending 标记永远不被
 *       消费 → 下一次冷启动会把刚装好的热更回滚（这正是必须与默认值同批修掉的原因）。</li>
 * </ul>
 * 两条都不成立（本地树没渲染 **且** 远程页加载失败）→ 标记保留 → 冷启动回滚。
 */
public final class RemoteClientPolicy {

    /** 全局默认偏好键：未被显式设置过的 host 用它（默认 {@code true} = 服务端界面优先）。 */
    public static final String PREF_DEFAULT = "remote-client-default";
    /** 逐 host 偏好键前缀（显式设置过就永远赢过全局默认）。 */
    public static final String PREF_HOST_PREFIX = "remote-client:";

    /** 全局默认读不到时的缺省值（业主口径：默认服务端界面）。 */
    public static boolean defaultGlobal() {
        return true;
    }

    /**
     * 生效值：{@code knownServerHost && 公网 host} 才有资格；通过后显式值优先，否则全局默认。
     * {@code host} 为 null/空、或任一硬门不通过 → false（保持内嵌树，今天的行为）。
     *
     * @param host            目标主机（{@code Uri.getHost()} 的结果；大小写/括号由 HostPolicy 处理）
     * @param knownServerHost 是否属于「已知服务器主机」（第三方页面必须传 false）
     * @param explicitlySet   该 host 的逐 host 偏好是否被显式写过
     * @param perHost         显式写下的逐 host 值（{@code explicitlySet} 为假时忽略）
     * @param globalDefault   全局默认值（{@code PREF_DEFAULT}，读不到时用 {@link #defaultGlobal()}）
     */
    public static boolean resolve(String host, boolean knownServerHost,
                                  boolean explicitlySet, boolean perHost, boolean globalDefault) {
        if (host == null || host.isEmpty()) return false;
        if (!knownServerHost) return false;              // 硬门 ①：第三方页面保持今天的行为
        if (!HostPolicy.isPublicHost(host)) return false; // 硬门 ②：本机/局域网永远走内嵌树
        return explicitlySet ? perHost : globalDefault;
    }

    /**
     * 热更健康确认：本地树渲染（既有路径）或服务端界面主帧成功落地（新路径）都算健康。
     * 两条都不成立 → false，pending 标记保留，冷启动回滚（本地树坏掉时仍必须回滚）。
     *
     * @param pageFromLocalTree 主帧 HTML 由本地树提供（serveLocal 置位）
     * @param remoteClientPage  落地的主帧 host 现在生效的是服务端界面
     * @param mainFrameErrored  本次主帧导航报了 onReceivedError
     */
    public static boolean healthy(boolean pageFromLocalTree, boolean remoteClientPage,
                                  boolean mainFrameErrored) {
        return pageFromLocalTree || (remoteClientPage && !mainFrameErrored);
    }

    private RemoteClientPolicy() {}
}
