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

    /** 全局默认值的「来源语义版本」标记键（本版写入时一并写；老 APK 的自动下推没有它）。 */
    public static final String PREF_DEFAULT_SRC = "remote-client-default-src";

    /**
     * 该不该丢弃一个**来路不明**的全局默认值（审计 2026-10-09：「进到服务器里面后依旧未读取到独有
     * 客户端 ui」，也是 rainya {@code /play} 的公告在安卓端什么都不显示的直接原因）。
     *
     * <p>vc2006–vc2008 的内容侧在 {@code shell-bridge.js} 的 v8.2 块里主动写过
     * {@code remote-client-default=false}（当时还没有首页作用域门，必须把默认压成"本地客户端优先"）。
     * 那个 {@code false} 落在 SharedPreferences 里、**跨升级存活**，而 {@link #resolve} 的取值链是
     * {@code explicitlySet ? perHost : globalDefault} —— 于是它永远压过 {@link #defaultGlobal()}，
     * 每台装过老版的设备都退化成本地客户端：{@code serverUi} 恒 false → {@link #scopeAllows} 恒
     * false → 连 {@code /play} 都由本地树渲染（服务端自有 UI 永不接管）。
     *
     * <p>修法：写入时同时记来源语义版本（{@link #PREF_DEFAULT_SRC}）。
     * <ul>
     *   <li>有值、**没有**标记 = 老 APK 的自动下推（或老版面板写的，二者无法区分）→ 丢弃，回到新默认；</li>
     *   <li>有标记 = 本版写入（玩家显式选择）→ 保留。</li>
     * </ul>
     * 逐 host 的 {@link #PREF_HOST_PREFIX}{@code <host>} 键**不在此列** —— 它们只由玩家在面板里
     * 显式选择写入过，一律保留。
     */
    public static boolean shouldDropLegacyDefault(boolean hasDefault, boolean hasSrc) {
        return hasDefault && !hasSrc;
    }

    /** 全局默认读不到时的缺省值。**true = 服务端界面优先**（业主口径 2026-10-09：
     *  「确保做到连接服务器仅首页页面叠加，其他 ui 按服务器正常显示（静态资源走 web 缓存）」）。
     *
     *  <p>与 2026-10-09 早先那次「紧急翻回 false」的区别只有一条，但正是关键的一条：
     *  {@link #scopeAllows} 的**首页作用域门**当时还不存在，所以默认 true 会让冷启动第一屏就是别人的首页。
     *  现在首页（站点根，含 {@code /index.html}）永远由本地树渲染，默认 true 才成立 ——
     *  它表达的是「首页之外的内容按服务器」，不是「整站按服务器」。
     *
     *  <p>逐服「本地客户端」仍是显式覆盖（写进 {@value #PREF_HOST_PREFIX}{@code <host>} 后永远赢），
     *  想整站都用我们自己的界面就选它。 */
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
     * ③ 作用域门（业主口径 2026-10-09「服务端界面是**首页之外**的内容由服务器加载，依旧是本地首页」）：
     * 即使某个 host 生效了「服务端界面」，**首页（站点根）也永远由本地树渲染**；只有首页之外的
     * 子页面（{@code /play}、{@code /rooms/…}、任意带路径/查询的次级页）才让该服自有页面接管。
     *
     * <p>为什么必须再补这一道门：{@link #resolve} 只回答「这个 host 用不用服务端界面」，它是
     * **host 级**的；而业主要的是「首页必须是我们自己的 UI」——那是**路径级**的。没有这道门，
     * 玩家开任意一个开了「服端」的服，冷启动第一屏就是别人的首页（2026-10-09 现场）。
     *
     * <p>纯函数（零 IO / 零 Android），JVM 可直接测：见 RemoteClientCheck.testHomeAlwaysLocal。
     *
     * @param host           目标主机（仅用于诊断/未来扩展；判定本身只看路径）
     * @param path           请求路径（{@code Uri.getPath()}；null/空/"/" 都算首页）
     * @param remoteClientOn 该 host 是否已生效「服务端界面」（{@link #resolve} 的结果）
     * @return true = 这次导航可以交给服务器自有页面
     */
    public static boolean scopeAllows(String host, String path, boolean remoteClientOn) {
        if (!remoteClientOn) return false;      // host 没开服务端界面 → 一切走本地树（既有行为）
        if (host == null || host.isEmpty()) return false;
        return isSubPagePath(path);
    }

    /**
     * 首页判定：**站点根**（{@code null} / {@code ""} / {@code "/"}）**以及 {@code /index.html}**。
     *
     * <p>为什么 {@code /index.html} 必须算首页：它是首页那个文档的**规范路径**（拦截器自己就把
     * {@code /} 规一化成 {@code /index.html}）。少了这一条，任何以 {@code /index.html} 形式发生的
     * 首页导航（服务器页面里的链接、重定向、历史恢复）都会被判成「首页之外」交给服务器 ——
     * 首页当场被顶掉，而且只在那一种入口下复现（最难查的一类）。
     *
     * <p>带 query 的根 {@code /?room=X} 仍算「首页之外」：那是「加入房间」的深链，玩家点在房间
     * 列表里的「加入」，要的就是该服自己的房间页（首页那个 {@code /?room=} 由本地首页自己渲染，
     * 不经过这里）。同理 {@code /play?room=X}。
     *
     * <p><b>调用方必须传「路径 + query」</b>（{@link #scopePath}）：只传 {@code Uri.getPath()}
     * 会把 {@code /?room=X} 折叠成 {@code "/"}、判成首页 —— 这正是 2026-10-10 业主报障
     * 「未加载服务器样式」的根因（裸 origin 服务器的进房导航被规则 ① 永久劫持）。
     */
    public static boolean isHomePath(String path) {
        if (path == null || path.isEmpty()) return true;
        if ("/".equals(path)) return true;
        return "/index.html".equals(path) || "/index.htm".equals(path);
    }

    /** 首页之外（服务端界面可以接管的那些导航）。 */
    public static boolean isSubPagePath(String path) {
        return !isHomePath(path);
    }

    /**
     * 作用域判定用的路径：把 {@code Uri.getPath()} 与 query 合成。**必须带 query**。
     *
     * <p>{@code /?room=X} 是「加入房间」深链，设计明确要求交给服务器自有页面（见
     * {@link #isHomePath} 文档）。但只取 {@code Uri.getPath()} 会把 query 丢掉、把
     * {@code /?room=X} 误判成首页（{@code getPath()} 就是 {@code "/"}）→ 规则 ① 把**裸 origin
     * 服务器**（游戏客户端就挂在站点根，servers.json 里绝大多数如此）的每一次进房导航都永久
     * 劫持到本地树 → 该服自有 UI 永远加载不到（2026-10-10 业主报障「未加载服务器样式」）。
     *
     * <p>合成后：{@code /?room=X} → {@code "/?room=X"} → {@link #isHomePath} 为假 → 首页之外；
     * 站点根（无 query）与 {@code /index.html} 仍是那几个字面量 → 恒本地，冷启动第一屏不变。
     *
     * <p>纯函数（零 IO / 零 Android），JVM 可直接测：见 RemoteClientCheck.testScopePathCarriesQuery。
     *
     * @param path  {@code Uri.getPath()}（可能为 null）
     * @param query {@code Uri.getQuery()}（null/空 = 无 query，原样返回 {@code path}）
     */
    public static String scopePath(String path, String query) {
        if (query == null || query.isEmpty()) return path;
        return (path == null ? "" : path) + "?" + query;
    }

    /**
     * ③ 字体来源门（业主口径 2026-10-09）：「字体：本地服务走本地，走服务器上走服务器，
     * CDN 仅作为本地下载源」。
     *
     * <p>这条只回答一个问题：「字体主机」（fonts.googleapis.com / fonts.gstatic.com）的请求
     * 该不该由**本地自托管字体表**来回答。
     * <ul>
     *   <li>{@code pageFromLocalTree} 为真（页面是本地树给的：本地服务、或本地客户端渲染的页面）
     *       → true：用本地表回答。表里的 {@code src} 全是同源 {@code /fonts/**}，
     *       运行时一个字节都不取 CDN，也不受 DNS 劫持影响。</li>
     *   <li>为假（页面来自服务器）→ false：**不注入我们的字体**。服务器的字体走它自己的 origin，
     *       我们既不替换、也不放行第三方 CDN —— 「CDN 仅作为本地下载源」对所有页面都成立。</li>
     * </ul>
     *
     * <p>纯函数（零 IO / 零 Android），JVM 可直接测：见 RemoteClientCheck.testFontSource。
     *
     * @param pageFromLocalTree 主帧 HTML 是否由本地树提供（{@code pageServedFromLocalTree}）
     * @return true = 这次字体请求由本地自托管字体表回答
     */
    public static boolean fontFromLocalTable(boolean pageFromLocalTree) {
        return pageFromLocalTree;
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
