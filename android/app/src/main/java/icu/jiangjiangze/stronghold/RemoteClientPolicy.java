package icu.jiangjiangze.stronghold;

/**
 * 服务端界面（「用该服自有客户端」）的**纯决策表** —— 零 IO、零 Android 依赖，JVM 可直接测。
 *
 * <p>业主口径 2026-10-08：「默认使用服务端 UI（设置中可改）」。页面/资源都走该服 origin（浏览器
 * 缓存提速、UI 与玩法与该服一致），设置面板可改回本地客户端；逐服也能单独覆盖。真正读偏好、
 * 装偏好、切导航仍是 {@link MainActivity}（{@code remoteClientFor} / {@code setRemoteClient}），
 * 这里只回答几个问题，让它们可测、可审：
 * <ol>
 *   <li>{@link #resolve} —— 这个 host 现在生效的是服务端界面吗？（两道硬门 + 显式优先）</li>
 *   <li>{@link #scopeAllows} —— 这次导航可以交给该服自有客户端吗？（口径已反转，见下）</li>
 *   <li>{@link #healthy} —— 这次主帧落地算不算「热更健康」？（两条路径的不变量）</li>
 * </ol>
 *
 * <h3>④ 不遮蔽（业主口径 2026-10-10，**正式反转 2026-10-09 的首页作用域门**）</h3>
 * 业主原话（2026-10-10，重复五次）：「第三方服务器的自有客户端不能被遮蔽（包含首页）」「所有服务器
 * 都能取缓存」。2026-10-09 的口径是「连接服务器：**仅首页**页面叠加，其他 ui 按服务器正常显示」，
 * 于是首页被本地树永久接管 —— 那是**遮蔽**，现被明确否定。本版起：
 * <ul>
 *   <li>已知服务器主机 + 服务端界面开启 → {@link #scopeAllows} 对**所有路径**放行（含站点根
 *       {@code /}、空串、{@code /index.html}、{@code /index.htm}）；冷启动第一屏就是该服自有客户端。</li>
 *   <li>逐服显式「本地客户端」（{@value #PREF_HOST_PREFIX}{@code <host>} 被显式写成 false）仍是唯一
 *       的「我就是要本地树」途径 → {@link #resolve} 为 false → {@link #scopeAllows} 恒 false（整站本地树）。</li>
 *   <li>本地树仍在两种情形下生效：① 服务器主帧答不出可用页面（**5xx** → 本地 {@code index.html}
 *       兜底；连接层失败不回退 —— 见 {@link #localTreeFallbackOnMainFrameFetch} 的边界）；② 逐服显式
 *       本地客户端。</li>
 * </ul>
 * {@link #isHomePath} / {@link #isSubPagePath} / {@link #scopePath} 保留为**纯路径判定**（首页概念仍在
 * 报告/诊断/未来按路径规则里用），但**自 2026-10-10 起不再参与放行判定** —— 放行不再看路径。
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

    /** 全局默认读不到时的缺省值。**true = 服务端界面优先**（业主口径 2026-10-10：「第三方服务器的自有
     *  客户端不能被遮蔽（包含首页）」「所有服务器都能取缓存」）。
     *
     *  <p>历史：2026-10-09 的这次默认曾**必须**与 {@link #scopeAllows} 的「首页作用域门」成对出现 ——
     *  当时门把首页永久留给本地树，所以默认 true 只表达「首页之外按服务器」。2026-10-10 业主把那条
     *  口径正式反转（首页也包括在内，不得遮蔽），作用域门随之删除；默认 true 现在就是字面意思：
     *  已知服务器主机的全部页面（含首页）都由该服自有客户端渲染。
     *
     *  <p>逐服「本地客户端」仍是显式覆盖（写进 {@value #PREF_HOST_PREFIX}{@code <host>} 后永远赢，
     *  见 {@link #resolve}），想整站都用我们自己的界面就选它；服务器主帧答不出可用页面（5xx）时另有
     *  本地树兜底，见 {@link #localTreeFallbackOnMainFrameFetch}。 */
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
     * ③ 作用域门 —— **已被业主 2026-10-10 口径反转，现在对已知服务器主机的所有路径放行**。
     *
     * <p>旧口径（2026-10-09）：「服务端界面是**首页之外**的内容由服务器加载，依旧是本地首页」——
     * 首页（站点根/ {@code /index.html}）被永久留给本地树，等于**遮蔽**了第三方服务器的首页。
     * 新口径（2026-10-10，业主原话「第三方服务器的自有客户端不能被遮蔽（包含首页）」）：站内所有
     * 路径都交给该服自有客户端，首页不再例外。调用方仍必须先过 {@code knownServerHost} 与
     * {@link #resolve} 的两道硬门（本方法只回答"这次导航可以交出去吗"，不负责"这个 host 有没有资格"）。
     *
     * <p>判定：
     * <ul>
     *   <li>{@code remoteClientOn == false}（host 没生效服务端界面：逐服显式「本地客户端」、未知主机、
     *       环回/私网 host，或全局默认被显式关掉）→ false，一切走本地树（既有行为，逐字不变）。</li>
     *   <li>host 为空 → false（host 是身份的一部分，缺了就不能放）。</li>
     *   <li>host 非公网可寻址 → false（纵深防御：本机服务与局域网房间永远保留内嵌树。这道门在
     *       {@link #resolve} 已有一份，这里再钉一次，防止调用方直接调本方法时绕过）。</li>
     *   <li>其余 → **true：含 {@code "/"}、{@code ""}、{@code /index.html}、{@code /index.htm} 在内，
     *       所有路径一律放行**。</li>
     * </ul>
     *
     * <p>纯函数（零 IO / 零 Android），JVM 可直接测：见 RemoteClientCheck.testServerClientNotShadowed。
     *
     * @param host           目标主机（{@code Uri.getHost()}；非空 + 公网是放行的必要条件）
     * @param path           请求路径（{@code Uri.getPath()}）—— **本版不参与判定**，保留参数是为了调用
     *                       点形状稳定与将来可能的按路径规则（例如再次收窄时只放行某些路径）
     * @param remoteClientOn 该 host 是否已生效「服务端界面」（{@link #resolve} 的结果）
     * @return true = 这次导航可以交给服务器自有页面
     */
    public static boolean scopeAllows(String host, String path, boolean remoteClientOn) {
        if (!remoteClientOn) return false;      // host 没开服务端界面 → 一切走本地树（既有行为）
        if (host == null || host.isEmpty()) return false;
        if (!HostPolicy.isPublicHost(host)) return false; // 纵深：本机/局域网永不放行
        return true;                            // 2026-10-10 反转：首页也在内，所有路径都放行
    }

    /**
     * 首页判定（纯路径事实，**自 2026-10-10 起不再参与放行判定**，见 {@link #scopeAllows}）：
     * **站点根**（{@code null} / {@code ""} / {@code "/"}）**以及 {@code /index.html}**。
     *
     * <p>为什么 {@code /index.html} 必须算首页：它是首页那个文档的**规范路径**（拦截器自己就把
     * {@code /} 规一化成 {@code /index.html}）。少了这一条，任何以 {@code /index.html} 形式发生的
     * 首页导航（页面里的链接、重定向、历史恢复）都会被判成「首页之外」——在旧口径下那意味着首页被
     * 顶掉，只在那一种入口复现（最难查的一类）。新口径下所有路径都放行，这条判定留给报告/诊断/
     * 将来的按路径规则复用。
     *
     * <p>带 query 的根 {@code /?room=X} 仍算「首页之外」：那是「加入房间」的深链（本方法只看路径，
     * query 的合成见 {@link #scopePath}）。
     *
     * <p><b>调用方若需要「路径 + query」</b>用 {@link #scopePath}：只传 {@code Uri.getPath()} 会把
     * {@code /?room=X} 折叠成 {@code "/"}。
     */
    public static boolean isHomePath(String path) {
        if (path == null || path.isEmpty()) return true;
        if ("/".equals(path)) return true;
        return "/index.html".equals(path) || "/index.htm".equals(path);
    }

    /** 首页之外（纯路径事实；**自 2026-10-10 起不再参与放行判定**，见 {@link #scopeAllows}）。 */
    public static boolean isSubPagePath(String path) {
        return !isHomePath(path);
    }

    /**
     * 把 {@code Uri.getPath()} 与 query 合成（纯字符串操作；**自 2026-10-10 起不再参与放行判定**，
     * 见 {@link #scopeAllows}）——保留它是为了让「路径 + query」这个单元仍有一个单一真源。
     *
     * <p>历史：旧口径下 {@code /?room=X} 是「加入房间」深链，设计要求交给服务器自有页面；而只取
     * {@code Uri.getPath()} 会把它折叠成 {@code "/"} 判成首页 → 规则 ① 把**裸 origin 服务器**
     * （游戏客户端就挂在站点根）的每一次进房导航都劫持到本地树（2026-10-10 业主报障「未加载服务器
     * 样式」）。新口径对所有路径一律放行，query 不再影响判定；本方法供诊断与将来的按路径规则使用。
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
     * P1 失败兜底（业主口径 2026-10-10）：「服务器自有客户端不得被遮蔽」不等于「服务器答不出页面时把玩家
     * 扔在浏览器错误页上」。主帧取回的结果按下表处置 —— **纯决策，JVM 可直接测**：
     * <ul>
     *   <li><b>3xx</b> → false：交回 WebView 自己跟重定向（必须继续如此：我们包装的 body 会让文档
     *       URL 与内容不符，登录跳转/房间深链都会断）。</li>
     *   <li><b>2xx</b> → false：内容由调用方接住（HTML 注入成功就回吐；已注入过/非 HTML/体积超限
     *       则交回原生加载）。</li>
     *   <li><b>4xx</b> → false：这是服务器对这次路径的**定论**（它自己的 404 页也是它自有客户端的
     *       一部分），照原样交给 WebView。</li>
     *   <li><b>5xx</b> → true：服务器收到了请求、但答不出可用页面 → 回退本地树 {@code index.html}
     *       （带 SHELL_INJECT：面板/设置/热更钩子都在），比浏览器里那张服务器错误页有用。本地树也取不到
     *       时调用方仍返回 null（原生加载，行为不变）。</li>
     * </ul>
     *
     * <h3>为什么「连接层失败」**不**回退本地树（2026-10-10 模拟器实测，边界收窄）</h3>
     * 一次真机验证里发现：Java 的 HttpURLConnection 对 **Cloudflare 前**的服务器（stronghold.lunar.ag、
     * stronghold.jiangjiangze.icu）一律 {@code SocketTimeoutException}，而同一台设备的 WebView/Chromium
     * 能正常取回同一站点（协议端点探针 200、页面原生加载成功）；非 CF 前（openresty / NAT 端口）的第三方
     * 服则 Java 取回成功。"Java 取不到"因此**不等于**"服务器取不到"——这时回退本地树，正好会**遮蔽一个
     * 可用**的第三方自有客户端（业主口径最不能接受的事，且它正是 2026-10-10 反转要修的东西）。
     *
     * <p>所以这条边界是：连接层失败（超时/拒绝/DNS/TLS/读失败）→ false = **交回 WebView 原生加载**。
     * 收益是「能取到时就是该服自带客户端」（Chromium 的栈是最终渲染页面的那一个）；代价是原生加载拿不到
     * 我们的 SHELL_INJECT（叠加层/钩子不在这张页面上）——但那是既有语义（旧 fail-open 一直如此），
     * 而且页面顶部菜单的原生退出口仍在。真正的「服务器不可达」不会把玩家留在浏览器错误页上：
     * 原生加载失败会触发 {@code onReceivedError → ensureHostAndSwitch(true)}（既有兜底：起本地服务 →
     * 切到本地树），玩家最终仍落在本地客户端上。5xx 与之不同——服务器**答了**，只是答的是错误页，
     * 原生加载只会把那张错误页展示出来，所以 5xx 才回退本地树。
     *
     * <p>纯函数（零 IO / 零 Android），见 RemoteClientCheck.testMainFrameFallback。
     *
     * @param statusCode HTTP 状态码；{@code <= 0} 表示连接层失败（无响应）
     * @param ioFailure  抛了异常（连接被拒/DNS/超时/读失败）→ 交回 WebView（见上：Java 取不到 ≠ 服务器不可用）
     * @return true = 这次主帧导航失败后回退本地树 index.html
     */
    public static boolean localTreeFallbackOnMainFrameFetch(int statusCode, boolean ioFailure) {
        if (ioFailure) return false;                             // 交回 WebView（取不到 ≠ 服务器不可用）
        if (statusCode >= 300 && statusCode < 400) return false;  // 3xx：交回 WebView 跟重定向
        if (statusCode >= 200 && statusCode < 300) return false;  // 2xx：内容自己决定
        if (statusCode >= 500) return true;                       // 5xx：答了但答不出可用页面 → 本地树
        return false;                                             // 4xx（含 404）：服务器的定论
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
