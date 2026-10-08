package icu.jiangjiangze.stronghold;

import java.net.URL;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * 资源路由决策表（方案 §2 / §14）——**纯逻辑，零 IO、零 Android 依赖**，JVM 可直接测。
 *
 * <p>本类只回答两个问题：「这条请求属于哪一类？」和「按顺序该去哪些源找？」真正取字节仍由
 * {@link MainActivity} 的拦截器做。把决策抽出来是为了让它可测、可审、可被 upstream 同步反复读取
 * 而不受影响 —— 拦截器本身只多一次调用，不做重构。
 *
 * <h3>分层（谁先谁后）</h3>
 * <pre>
 * ① filesDir/webroot      代码热更树（slim）
 * ② ArtStore packs        签名素材包
 * ③ APK 内嵌资源          壳自带
 * ④ filesDir/art/cache    同源回取缓存
 * ⑤ 当前服务器            同一 origin —— 用户已经连上的那台（新增的这一步）
 * ⑥ 官方 CDN              唯一跨域取字节处（必须同源回吐，否则 canvas 被污染）
 * ⑦ ArtStore 后台补包      占位 + 入队
 * </pre>
 *
 * <h3>三条例外（§14 E/F/G/H，绝不能被上层覆盖）</h3>
 * <ul>
 *   <li>{@code /api/**}、{@code /ws}、{@code /healthz} → **永远**直连当前服务器。它们是协议端点，
 *       本地树里不存在、也绝不允许存在同名文件把它们顶掉（那会变成「假成功」）。</li>
 *   <li>{@code /index.html}（及主帧 HTML 导航）→ **永远**由壳提供，服务器有同名页面也不接管 ——
 *       首页是壳的资产（叠加层/钩子/桥都在里面）。</li>
 *   <li>{@code /__sp/**} → 壳自有脚本，永远从 APK/热更树读，绝不走网络。</li>
 * </ul>
 */
public final class ResourceResolver {

    /** 一条请求的类别。 */
    public enum Kind {
        /** 壳自有脚本前缀 {@code /__sp/}。 */
        SHELL,
        /** 协议端点：{@code /api/**}、{@code /ws}、{@code /healthz} —— 永远直连当前服务器。 */
        PROTOCOL,
        /** 首页/主帧 HTML —— 永远由壳提供。 */
        HOMEPAGE,
        /** {@code /assets/**} —— 分层素材，可能走 CDN/ArtStore。 */
        ASSET,
        /** 其它站内静态资源（{@code /data/**}、{@code /shared/**}、{@code /js/**} …）。 */
        STATIC,
        /** 与当前 origin 无关的请求（第三方、CDN 主机等），交给既有分支处理。 */
        FOREIGN,
    }

    /** 一个可能的取字节来源。 */
    public enum Source {
        /** 设备上的本地树（① ② ③ ④ 合并成一个 openLocal 调用）。 */
        LOCAL,
        /** 当前页面 origin —— 同一台服务器，同源。 */
        SERVER,
        /** 官方 CDN（回吐时必须同源包装）。 */
        CDN,
        /** 签名素材包的后台补齐（占位 + 入队，不是同步取字节）。 */
        ARTSTORE,
        /** 交给 WebView 自己发（= 直连当前服务器）。 */
        NETWORK,
    }

    private ResourceResolver() {
    }

    /** 壳自有脚本前缀；与 {@code MainActivity.SHELL_JS_PREFIX} 同值，测试会锁死一致性。 */
    public static final String SHELL_PREFIX = "/__sp/";

    /** 协议端点前缀：这些路径永远不能被本地树/缓存顶掉。 */
    static final String[] PROTOCOL_PREFIXES = {"/api/", "/healthz", "/ws"};

    /**
     * 归类。{@code mainFrameHtml} = 这次请求是主帧 HTML 导航（Accept: text/html 且 isForMainFrame）。
     *
     * <p>路由优先级刻意是「协议 > 壳 > 首页 > 素材 > 静态」：协议端点即使被人放进本地树也顶不掉
     * （§14 E/F/G），壳脚本即使服务器有同名文件也不会被顶掉（历史 P0-2）。
     */
    public static Kind classify(String path, boolean mainFrameHtml) {
        if (path == null || path.isEmpty()) return Kind.FOREIGN;
        if (path.startsWith(SHELL_PREFIX)) return Kind.SHELL;
        if (isProtocolPath(path)) return Kind.PROTOCOL;
        if (mainFrameHtml) return Kind.HOMEPAGE;
        if (path.equals("/index.html") || path.equals("/")) return Kind.HOMEPAGE;
        if (path.startsWith("/assets/")) return Kind.ASSET;
        return Kind.STATIC;
    }

    /**
     * 协议端点判定。{@code /healthz}、{@code /ws} 精确匹配，{@code /api/} 前缀匹配（含裸 {@code /api}）。
     * 查询串不影响判定（这里收到的已经是 path，不含 query）。
     */
    public static boolean isProtocolPath(String path) {
        if (path == null || path.isEmpty()) return false;
        String p = path.toLowerCase(Locale.ROOT);
        if (p.equals("/healthz") || p.equals("/ws")) return true;
        if (p.equals("/api") || p.startsWith("/api/")) return true;
        return false;
    }

    /**
     * {@code /assets/**} 的候选来源，按序。
     *
     * <p>{@code serverServesAssets} = 当前服务器声明它自己也提供素材（ServerConfig 的
     * {@code resources.serveAssets}）。**默认 false = 与今天逐字节相同**：官方服素材在 CDN 上，
     * 无条件先问服务器会给每个素材加一次 404 往返（技能预取要走上万次），所以这一步必须是服务器
     * 主动声明的，而不是默认行为。
     *
     * <p>服务器自己提供时排在最前：它是**同源**的（页面就来自它），既没有跨域污染问题，又能让
     * 服务器私有素材（官方 CDN 没有的）真正可用。
     */
    public static List<Source> assetPlan(boolean serverServesAssets) {
        List<Source> plan = new ArrayList<>(Arrays.asList(Source.LOCAL));
        if (serverServesAssets) plan.add(Source.SERVER);
        plan.add(Source.CDN);
        plan.add(Source.ARTSTORE);
        return Collections.unmodifiableList(plan);
    }

    /** 非素材站内静态资源：本地 → 当前服务器（同源，直接交给 WebView 发）。 */
    public static List<Source> staticPlan() {
        return Collections.unmodifiableList(Arrays.asList(Source.LOCAL, Source.NETWORK));
    }

    /** 协议端点：只有直连，没有任何本地/缓存层。 */
    public static List<Source> protocolPlan() {
        return Collections.unmodifiableList(Collections.singletonList(Source.NETWORK));
    }

    /** 首页：只有壳，服务器同名页面不参与。 */
    public static List<Source> homepagePlan() {
        return Collections.unmodifiableList(Collections.singletonList(Source.LOCAL));
    }

    /**
     * 把站内路径拼到当前 origin 上，用于「向当前服务器取同一路径」。**唯一**的 URL 构造点，
     * 目标 host 恒等于当前 origin（同源）；协议只允许 http/https（局域网服与本地主机服务都是
     * http —— 这是产品前提）。任何异常返回 null，调用方退回既有行为。
     */
    public static String sameOriginUrl(String origin, String path) {
        if (origin == null || path == null) return null;
        if (!path.startsWith("/") || path.startsWith("//") || path.contains("..")) return null;
        if (originHasUserInfo(origin)) return null;
        try {
            URL u = new URL(origin);
            String scheme = u.getProtocol() == null ? "" : u.getProtocol().toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
            String host = u.getHost();
            if (host == null || host.isEmpty()) return null;
            for (int i = 0; i < host.length(); i++) {
                char c = host.charAt(i);
                if (c == '@' || c == '/' || c == '\\' || c == '?' || c == '#' || c <= ' ') return null;
            }
            int port = u.getPort();
            return scheme + "://" + host + (port > 0 ? ":" + port : "") + path;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * origin 的 authority 里是否带了 userinfo（{@code user:pass@host}）。
     * <p>{@code URL.getHost()} 会把 userinfo 丢掉，所以「照 host 重建 URL」本身是安全的；但一个
     * 带凭据的 origin 说明用户/上层配置给进来的并不是一个干净 origin，此时**拒绝**比悄悄丢掉凭据
     * 更好——不一致的输入不该被我们擅自「修正」成另一个请求目标。
     */
    static boolean originHasUserInfo(String origin) {
        int i = origin.indexOf("://");
        if (i < 0) return false;
        int start = i + 3;
        int end = origin.length();
        for (int j = start; j < origin.length(); j++) {
            char c = origin.charAt(j);
            if (c == '/' || c == '?' || c == '#') {
                end = j;
                break;
            }
        }
        return end > start && origin.lastIndexOf('@', end - 1) >= start;
    }
}
