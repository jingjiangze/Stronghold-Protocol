import icu.jiangjiangze.stronghold.HostPolicy;
import icu.jiangjiangze.stronghold.RemoteClientPolicy;

import java.util.ArrayList;
import java.util.List;

/**
 * JVM self-test for the「服务端界面」default + its two hard guards + the hot-update health invariant.
 * Pure logic: no Android, no IO, no network. Bare JDK 17 (the classes under test are Android-free).
 *
 *   bash tools/apk/jvm/run-remote-client-check.sh
 *
 * Covers (业主口径，最新为 **2026-10-10**：「第三方服务器的自有客户端不能被遮蔽（包含首页）」「所有服务器
 * 都能取缓存」—— **正式反转 2026-10-09 的「仅首页叠加」口径**):
 *   HostPolicy         -- the host table moved out of ServerList.isPublicHttpUrl: loopback/private/
 *                         reserved v4+v6, v4-embedded v6 forms, NAT64, .local/.internal/.localhost,
 *                         integer hosts, zone ids; public v4/v6/domains pass.
 *   RemoteClientPolicy -- resolve(): explicit per-host pref wins, else the global default (true);
 *                         the two hard guards (known server host; public host) can only turn it OFF,
 *                         so 127.0.0.1 and private LAN hosts always keep the embedded tree;
 *                         scopeAllows(): a known server host with the server client ON is passed
 *                         through on EVERY path (**including the home page** -- the 2026-10-09
 *                         home-scope gate is gone); a per-host explicit「本地客户端」turns it off;
 *                         localTreeFallbackOnMainFrameFetch(): 3xx must stay native, 5xx / connect
 *                         failures fall back to the local index.html;
 *                         healthy(): local-tree render OR a successful remote-client landing counts,
 *                         a failed remote load / a non-rendering local tree does not (rollback kept).
 */
public final class RemoteClientCheck {

    private static int checks = 0;
    private static final List<String> failures = new ArrayList<>();

    public static void main(String[] args) {
        testHostTableRejects();
        testHostTableAccepts();
        testDefaultIsServerUi();
        testExplicitPerHostWins();
        testGuardKnownServerHost();
        testGuardLoopbackAndLan();
        testServerClientNotShadowed();
        testScopePathCarriesQuery();
        testMainFrameFallback();
        testFontSource();
        testHealthTwoPaths();
        testPrefKeys();
        testLegacyDefaultMigration();

        System.out.println("RemoteClientCheck OK: " + checks + " checks passed");
        if (!failures.isEmpty()) {
            System.out.println("FAILURES:");
            for (String f : failures) System.out.println("  - " + f);
            System.exit(1);
        }
    }

    // ------------------------------------------------------------------
    // HostPolicy: the moved host table (must be byte-for-byte the old semantics)
    // ------------------------------------------------------------------

    private static void testHostTableRejects() {
        String[] rejected = {
                // IPv4 loopback / private / link-local / CGNAT / reserved / multicast
                "127.0.0.1", "127.1.2.3", "0.0.0.0", "10.0.0.5", "10.255.255.255",
                "192.168.1.5", "172.16.0.1", "172.31.255.255", "169.254.1.1",
                "100.64.0.1", "100.127.255.255", "224.0.0.1", "239.255.255.255", "255.255.255.255",
                // IPv6 loopback / link-local / unique-local
                "::1", "[::1]", "::", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1",
                // v4-embedded v6 forms (must unwrap to the v4 table)
                "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:192.168.0.1",
                "::ffff:0:127.0.0.1", "::127.0.0.1",
                // NAT64 well-known prefix
                "64:ff9b::7f00:1", "64:ff9b::a00:1",
                // names + forms that never denote a public origin
                "localhost", "x.localhost", "box.local", "printer.internal",
                "2130706433", "0x7f000001", "300.1.1.1", "fe80::1%wlan0",
                "1:2:3:4:5:6:7:8:9", // malformed v6 literal (nine groups, no "::")
                "",
        };
        for (String h : rejected) {
            check("reject host " + q(h), !HostPolicy.isPublicHost(h));
        }
        check("reject null host", !HostPolicy.isPublicHost(null));
    }

    private static void testHostTableAccepts() {
        String[] accepted = {
                "8.8.8.8", "1.1.1.1", "93.184.216.34", "223.255.255.255",
                "2001:4860:4860::8888", "[2001:4860:4860::8888]", "2606:4700::1111",
                "example.com", "stronghold.jiangjiangze.icu", "map.u712507.nyat.app",
                "sub.domain.example.co.uk",
        };
        for (String h : accepted) {
            check("accept host " + q(h), HostPolicy.isPublicHost(h));
        }
        // Case / brackets are normalised, not treated as a different host.
        check("accept upper-case domain", HostPolicy.isPublicHost("Example.COM"));
        check("accept bracketed public v6", HostPolicy.isPublicHost("[2606:4700::1111]"));
    }

    // ------------------------------------------------------------------
    // RemoteClientPolicy.resolve: default + explicit + the two hard guards
    // ------------------------------------------------------------------

    /** 默认（业主口径 **2026-10-10**「第三方服务器的自有客户端不能被遮蔽（包含首页）」）：
     *  **服务端界面优先**，而且**首页也交给它** —— 2026-10-09 那道「首页恒本地」的作用域门已被
     *  正式反转、从 {@link RemoteClientPolicy#scopeAllows} 里删除。 */
    private static void testDefaultIsServerUi() {
        check("defaultGlobal() is true (the server's own client, home page included)",
                RemoteClientPolicy.defaultGlobal());
        check("known public host, no explicit, default on -> server UI",
                RemoteClientPolicy.resolve("stronghold.jiangjiangze.icu", true, false, false, true));
        check("known public host, no explicit, default off -> local tree",
                !RemoteClientPolicy.resolve("stronghold.jiangjiangze.icu", true, false, false, false));
        check("defaultGlobal() is what an unread pref falls back to (server UI)",
                RemoteClientPolicy.resolve("raiya.example.com", true, false, false,
                        RemoteClientPolicy.defaultGlobal()));
        // 2026-10-10 反转：默认 true 的语义是「**整站**（含首页）按服务器」，不再是「首页之外」。
        check("default true now passes the HOME page to the server client too",
                RemoteClientPolicy.scopeAllows("h.example.com", "/", RemoteClientPolicy.defaultGlobal()));
    }

    /** 显式写过的逐 host 值永远赢过全局默认（两个方向都要赢）。 */
    private static void testExplicitPerHostWins() {
        check("explicit false beats default on",
                !RemoteClientPolicy.resolve("raiya.example.com", true, true, false, true));
        check("explicit true beats default off",
                RemoteClientPolicy.resolve("raiya.example.com", true, true, true, false));
        check("explicit false is sticky across a default flip",
                !RemoteClientPolicy.resolve("raiya.example.com", true, true, false, true));
    }

    /** 硬门 ①：不是「已知服务器 host」→ 永远 false（任意第三方页面保持今天的行为）。 */
    private static void testGuardKnownServerHost() {
        check("unknown host stays local even with default on",
                !RemoteClientPolicy.resolve("evil.example.com", false, false, false, true));
        check("unknown host stays local even if explicitly on",
                !RemoteClientPolicy.resolve("evil.example.com", false, true, true, true));
        check("null host stays local", !RemoteClientPolicy.resolve(null, true, false, false, true));
        check("empty host stays local", !RemoteClientPolicy.resolve("", true, false, false, true));
    }

    /**
     * 硬门 ②：环回/私网/保留 host 永远 false —— 本机服务 127.0.0.1 与局域网房间必须保留内嵌树
     * （否则 SHELL_INJECT 丢失：没有面板、没有设置、没有热更钩子）。**即使它是当前 origin
     * （knownServerHost=true）且全局默认是 true。**
     */
    private static void testGuardLoopbackAndLan() {
        // The literal assertions the deliverable calls for: the local host service and a LAN room.
        check("remoteClientFor(127.0.0.1) == false",
                !RemoteClientPolicy.resolve("127.0.0.1", true, false, false, true));
        check("remoteClientFor(192.168.1.7) == false (LAN room)",
                !RemoteClientPolicy.resolve("192.168.1.7", true, false, false, true));
        check("remoteClientFor(10.0.0.9) == false (LAN room)",
                !RemoteClientPolicy.resolve("10.0.0.9", true, false, false, true));
        check("remoteClientFor(::1) == false",
                !RemoteClientPolicy.resolve("::1", true, false, false, true));
        check("remoteClientFor(host.local) == false",
                !RemoteClientPolicy.resolve("box.local", true, false, false, true));
        // And even an explicit per-host "on" cannot override the guard (defence in depth: the local
        // client must always be reachable).
        check("explicit on cannot turn the local host remote",
                !RemoteClientPolicy.resolve("127.0.0.1", true, true, true, true));
        check("explicit on cannot turn a LAN host remote",
                !RemoteClientPolicy.resolve("192.168.1.7", true, true, true, true));
    }

    // ------------------------------------------------------------------
    // 不遮蔽（业主口径 2026-10-10，**正式反转 2026-10-09 的首页作用域门**）
    //   「第三方服务器的自有客户端不能被遮蔽（包含首页）」：已知服 + 服务端界面开 → 站内所有路径
    //   （含 "/"、""、null、/index.html、/index.htm）一律交给该服自有客户端。旧口径的
    //   「首页恒本地」断言在此处被**翻面**（见文件头与 RemoteClientPolicy 的类注释）。
    // ------------------------------------------------------------------

    /**
     * 新口径的可测表述：
     * <ul>
     *   <li>已知服 + 服务端界面开 → 首页（站点根 / "" / null / /index.html / /index.htm）**放行**；</li>
     *   <li>逐服显式「本地客户端」（{@code remoteClientOn=false}）→ 首页**不放行**（逃生阀仍在，
     *       整站本地树）；</li>
     *   <li>空 host / 非公网 host → 永不放行（既有硬门，纵深防御，不许松）；</li>
     *   <li>{@link RemoteClientPolicy#isHomePath} / {@code isSubPagePath} 保留为**纯路径事实**（不再
     *       参与放行）：语义仍断言，防漂移。</li>
     * </ul>
     */
    private static void testServerClientNotShadowed() {
        final String H = "stronghold.lunar.ag";

        // ① 首页也交给该服自有客户端 —— 这就是「不能遮蔽（包含首页）」，也是本次反转的落点。
        check("home \"/\" goes to the server client", RemoteClientPolicy.scopeAllows(H, "/", true));
        check("home \"\" goes to the server client", RemoteClientPolicy.scopeAllows(H, "", true));
        check("home null goes to the server client", RemoteClientPolicy.scopeAllows(H, null, true));
        check("/index.html goes to the server client", RemoteClientPolicy.scopeAllows(H, "/index.html", true));
        check("/index.htm goes to the server client", RemoteClientPolicy.scopeAllows(H, "/index.htm", true));
        // 子页面照旧放行（2026-10-09 已放行的路径不许因这次反转而回退）。
        check("/play goes to the server client", RemoteClientPolicy.scopeAllows(H, "/play", true));
        check("/rooms/abc goes to the server client", RemoteClientPolicy.scopeAllows(H, "/rooms/abc", true));
        check("home WITH query goes to the server client",
                RemoteClientPolicy.scopeAllows(H, RemoteClientPolicy.scopePath("/", "room=X"), true));

        // ② 逃生阀（必须保留）：逐服显式「本地客户端」→ 一切走本地树（含首页）。
        check("home stays LOCAL when the per-host pref is OFF", !RemoteClientPolicy.scopeAllows(H, "/", false));
        check("/play stays LOCAL when the per-host pref is OFF",
                !RemoteClientPolicy.scopeAllows(H, "/play", false));
        check("explicit OFF keeps /index.html local too",
                !RemoteClientPolicy.scopeAllows(H, "/index.html", false));

        // ③ 硬门不许松：空 host / 非公网 host 永不放行（即使 remoteClientOn 被误传 true）。
        check("null host never allowed", !RemoteClientPolicy.scopeAllows(null, "/", true));
        check("empty host never allowed", !RemoteClientPolicy.scopeAllows("", "/", true));
        check("loopback host never allowed", !RemoteClientPolicy.scopeAllows("127.0.0.1", "/", true));
        check("LAN host never allowed", !RemoteClientPolicy.scopeAllows("192.168.1.7", "/play", true));
        check("non-public name never allowed", !RemoteClientPolicy.scopeAllows("box.local", "/", true));

        // ④ 纯路径事实保留（注释/报告/将来的按路径规则用；不再参与放行判定）。
        check("isHomePath(\"/index.html\") is true", RemoteClientPolicy.isHomePath("/index.html"));
        check("isHomePath(\"/\") is true", RemoteClientPolicy.isHomePath("/"));
        check("\"/\" is not a sub-page", !RemoteClientPolicy.isSubPagePath("/"));
        check("\"/play\" is a sub-page", RemoteClientPolicy.isSubPagePath("/play"));
        check("\"/p\" is a sub-page (shortest real path)", RemoteClientPolicy.isSubPagePath("/p"));
        check("\"/play/\" is still a sub-page", RemoteClientPolicy.isSubPagePath("/play/"));
        check("\"\" is not a sub-page", !RemoteClientPolicy.isSubPagePath(""));
        check("null is not a sub-page", !RemoteClientPolicy.isSubPagePath(null));
    }

    // ------------------------------------------------------------------
    // 「路径 + query」的合成（纯字符串事实）
    //   历史：旧口径下 `Uri.getPath()` 会把 `/?room=X` 折叠成 `/`，进房深链被误判成首页 → 永久劫持
    //   裸 origin 服务器的进房导航（2026-10-10 业主报障「未加载服务器样式」）。**2026-10-10 的正式
    //   反转后路径与 query 都不再影响放行**（所有路径一律放行），scopePath 保留为单一真源供诊断/
    //   将来的按路径规则使用，语义不许漂移。
    // ------------------------------------------------------------------

    private static void testScopePathCarriesQuery() {
        final String H = "stronghold.lunar.ag";

        // ① 合成：无 query 原样；有 query 拼上（null path 不产生 "null" 字面量）。
        check("scopePath no query -> path unchanged",
                "/".equals(RemoteClientPolicy.scopePath("/", null)));
        check("scopePath empty query -> path unchanged",
                "/".equals(RemoteClientPolicy.scopePath("/", "")));
        check("scopePath joins path + query",
                "/?room=X".equals(RemoteClientPolicy.scopePath("/", "room=X")));
        check("scopePath joins subpath + query",
                "/play?room=X".equals(RemoteClientPolicy.scopePath("/play", "room=X")));
        check("scopePath null path + query -> \"?room=X\"",
                "?room=X".equals(RemoteClientPolicy.scopePath(null, "room=X")));

        // ② 带 query 的深链与不带 query 的站点根**都**放行（新口径：路径不参与判定）。
        check("home WITH query goes to the server client (join deep link)",
                RemoteClientPolicy.scopeAllows(H, RemoteClientPolicy.scopePath("/", "room=X"), true));
        check("home WITHOUT query goes to the server client too",
                RemoteClientPolicy.scopeAllows(H, RemoteClientPolicy.scopePath("/", null), true));
        check("/index.html WITH query goes to the server client",
                RemoteClientPolicy.scopeAllows(H, RemoteClientPolicy.scopePath("/index.html", "room=X"), true));
        // ③ 逃生阀：服务端界面关着 → 带 query 的根也仍走本地树（既有行为，逐字不变）。
        check("home WITH query stays LOCAL when the per-host pref is OFF",
                !RemoteClientPolicy.scopeAllows(H, RemoteClientPolicy.scopePath("/", "room=X"), false));
    }

    // ------------------------------------------------------------------
    // P1 失败兜底（业主口径 2026-10-10）：主帧取回结果的处置
    //   3xx 必须让 WebView 自己跟（硬约束，任何口径反转都不许破坏）；4xx 是服务器的定论；
    //   **5xx** → 回退本地树 index.html（服务器答了、但答不出可用页面）。
    //   连接层失败**不回退**：Java 取不到 ≠ 服务器取不到（CF 前的服务器在模拟器上对 Java 一律超时、
    //   Chromium 却能取回），回退本地树会遮蔽一个可用的第三方客户端；交回 WebView，真失败时由既有
    //   onReceivedError → ensureHostAndSwitch(true) 兜到本地服务。
    // ------------------------------------------------------------------

    private static void testMainFrameFallback() {
        // 3xx：交回 WebView 跟重定向（我们包装的 body 会让文档 URL 与内容不符，登录跳转/深链都会断）。
        check("301 -> native (WebView follows)", !RemoteClientPolicy.localTreeFallbackOnMainFrameFetch(301, false));
        check("302 -> native (WebView follows)", !RemoteClientPolicy.localTreeFallbackOnMainFrameFetch(302, false));
        check("307 -> native (WebView follows)", !RemoteClientPolicy.localTreeFallbackOnMainFrameFetch(307, false));
        // 2xx：内容自己决定（HTML 注入成功 → 回吐；已注入/非 HTML/超限 → 原生加载）。
        check("200 -> native (the body decides)",
                !RemoteClientPolicy.localTreeFallbackOnMainFrameFetch(200, false));
        // 4xx：服务器对这次路径的定论（它自己的 404 页也是它自有客户端的一部分）。
        check("404 -> native (the server's answer)",
                !RemoteClientPolicy.localTreeFallbackOnMainFrameFetch(404, false));
        check("403 -> native (the server's answer)",
                !RemoteClientPolicy.localTreeFallbackOnMainFrameFetch(403, false));
        // 5xx：服务器答了、但答不出可用页面 → 本地树兜底。
        check("500 -> local tree fallback", RemoteClientPolicy.localTreeFallbackOnMainFrameFetch(500, false));
        check("503 -> local tree fallback", RemoteClientPolicy.localTreeFallbackOnMainFrameFetch(503, false));
        // 连接层失败（无响应/异常）→ **原生加载**（Java 取不到 ≠ 服务器不可用；回退本地树会遮蔽可用的
        // 第三方客户端）。这条与「5xx → 本地树」是不同的失败面，绝不许合并成一个 true。
        check("connect failure -> native (not the local tree)",
                !RemoteClientPolicy.localTreeFallbackOnMainFrameFetch(0, true));
        check("timeout/IO exception -> native",
                !RemoteClientPolicy.localTreeFallbackOnMainFrameFetch(-1, true));
        // ioFailure 优先于状态码（读失败时那张代码不可信）。
        check("io failure wins over a status code",
                !RemoteClientPolicy.localTreeFallbackOnMainFrameFetch(301, true));
        // 连接失败与 5xx 必须可分辨（否则「可用的服务器」会被本地树遮蔽）。
        check("io failure and 5xx are distinguishable",
                RemoteClientPolicy.localTreeFallbackOnMainFrameFetch(500, false)
                        != RemoteClientPolicy.localTreeFallbackOnMainFrameFetch(0, true));
    }

    // ------------------------------------------------------------------
    // RemoteClientPolicy.fontFromLocalTable: the font-source gate
    //   业主口径 2026-10-09「字体：本地服务走本地，走服务器上走服务器，CDN 仅作为本地下载源」
    // ------------------------------------------------------------------

    private static void testFontSource() {
        // 本地服务 / 本地客户端渲染的页面 → 本地自托管字体表回答（src 全是同源 /fonts/**）。
        check("font: local-tree page -> local table answers", RemoteClientPolicy.fontFromLocalTable(true));
        // 服务器页面 → 不注入我们的字体（服务器的字体走服务器自己，我们一个字节都不插）。
        check("font: server page -> we inject nothing", !RemoteClientPolicy.fontFromLocalTable(false));
        // 门必须是「两个方向都可分辨」的：任何把它退化成常量的重构都会让服务器页面吃我们的字体
        // （或让本地页面丢字体），这条钉住这个不变量。
        check("font: gate distinguishes both page sources",
                RemoteClientPolicy.fontFromLocalTable(true) != RemoteClientPolicy.fontFromLocalTable(false));
    }

    // ------------------------------------------------------------------
    // RemoteClientPolicy.healthy: the two-path invariant
    // ------------------------------------------------------------------

    private static void testHealthTwoPaths() {
        // Local-tree path: the tree rendered -> healthy (existing semantics, unchanged).
        check("local tree rendered -> healthy", RemoteClientPolicy.healthy(true, false, false));
        check("local tree rendered, stray error flag -> still healthy",
                RemoteClientPolicy.healthy(true, false, true));
        // Remote-client path (the new default): a clean landing on the server's own page is healthy.
        check("remote page landed clean -> healthy", RemoteClientPolicy.healthy(false, true, false));
        // A failed remote load must NOT consume the pending marker (rollback preserved).
        check("remote page errored -> NOT healthy", !RemoteClientPolicy.healthy(false, true, true));
        // An external page that is neither -> says nothing.
        check("neither path -> NOT healthy", !RemoteClientPolicy.healthy(false, false, false));
        check("neither path, error -> NOT healthy", !RemoteClientPolicy.healthy(false, false, true));
        // The "broken local tree still rolls back" case: main frame not served from the local tree
        // (no index.html rendered) and no remote-client host -> the marker stays -> rollback.
        check("broken local tree -> NOT healthy (rollback kept)",
                !RemoteClientPolicy.healthy(false, false, false));
        // A broken local tree that fell back to a remote-client host WITHOUT an error is the one
        // combination that consumes the marker -- but that is a working page (the fallback target),
        // exactly what「默认服务端界面」means. Documented, not asserted as a failure.
    }

    private static void testPrefKeys() {
        check("global default pref key", "remote-client-default".equals(RemoteClientPolicy.PREF_DEFAULT));
        check("per-host pref prefix", "remote-client:".equals(RemoteClientPolicy.PREF_HOST_PREFIX));
        check("global key is NOT under the per-host prefix (migration must not clear it)",
                !RemoteClientPolicy.PREF_DEFAULT.startsWith(RemoteClientPolicy.PREF_HOST_PREFIX));
        check("the source marker key is distinct from the value key",
                !RemoteClientPolicy.PREF_DEFAULT_SRC.equals(RemoteClientPolicy.PREF_DEFAULT));
    }

    /**
     * 2026-10-09 审计：「进到服务器里面后依旧未读取到独有客户端 ui」。
     * vc2006–vc2008 的内容侧自动下推过 {@code remote-client-default=false}（无标记），它跨升级存活
     * 并永远压过新默认值 → 本地客户端接管一切。迁移规则：有值无标记 = 丢弃；有标记 = 保留（玩家选择）。
     */
    private static void testLegacyDefaultMigration() {
        check("a legacy default (value, no src) is dropped",
                RemoteClientPolicy.shouldDropLegacyDefault(true, false));
        check("a marked default (the player's own choice) is kept",
                !RemoteClientPolicy.shouldDropLegacyDefault(true, true));
        check("no default at all: nothing to drop",
                !RemoteClientPolicy.shouldDropLegacyDefault(false, false));
        check("only a src marker (no value): nothing to drop",
                !RemoteClientPolicy.shouldDropLegacyDefault(false, true));
        // 迁移后必须回到「服务端界面优先」这条业主口径，而不是留在 false。
        check("after the drop the default is the server UI",
                RemoteClientPolicy.defaultGlobal());
        check("and resolve() then engages the server UI for a known public host",
                RemoteClientPolicy.resolve("game.rainya.me", true, false, false, RemoteClientPolicy.defaultGlobal()));
        // 逐 host 的显式选择不受影响（它们只由玩家写入过）。
        check("a per-host explicit choice still wins",
                !RemoteClientPolicy.resolve("game.rainya.me", true, true, false, true));
    }

    // ------------------------------------------------------------------

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
