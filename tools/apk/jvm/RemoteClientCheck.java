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
 * Covers (业主口径 2026-10-08「默认使用服务端 UI（设置中可改）」):
 *   HostPolicy         -- the host table moved out of ServerList.isPublicHttpUrl: loopback/private/
 *                         reserved v4+v6, v4-embedded v6 forms, NAT64, .local/.internal/.localhost,
 *                         integer hosts, zone ids; public v4/v6/domains pass.
 *   RemoteClientPolicy -- resolve(): explicit per-host pref wins, else the global default (true);
 *                         the two hard guards (known server host; public host) can only turn it OFF,
 *                         so 127.0.0.1 and private LAN hosts always keep the embedded tree;
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
        testHomeAlwaysLocal();
        testScopePathCarriesQuery();
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

    /** 默认（业主口径 2026-10-09「连接服务器：仅首页页面叠加，其他 ui 按服务器正常显示」）：
     *  **服务端界面优先** —— 但这条只在首页作用域门存在时才安全，所以这里两条一起断言：
     *  默认 true **且** 首页（站点根 + /index.html）永不放行。 */
    private static void testDefaultIsServerUi() {
        check("defaultGlobal() is true (server UI for everything OUTSIDE the home page)",
                RemoteClientPolicy.defaultGlobal());
        check("known public host, no explicit, default on -> server UI",
                RemoteClientPolicy.resolve("stronghold.jiangjiangze.icu", true, false, false, true));
        check("known public host, no explicit, default off -> local tree",
                !RemoteClientPolicy.resolve("stronghold.jiangjiangze.icu", true, false, false, false));
        check("defaultGlobal() is what an unread pref falls back to (server UI)",
                RemoteClientPolicy.resolve("raiya.example.com", true, false, false,
                        RemoteClientPolicy.defaultGlobal()));
        // 门与默认必须**同时**成立：默认 true 而没有门 = 2026-10-09 早先那次首页被顶掉的事故。
        check("default true is paired with a home-scope gate",
                !RemoteClientPolicy.scopeAllows("h.example.com", "/", RemoteClientPolicy.defaultGlobal()));
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
    // 作用域门（业主口径 2026-10-09：首页恒本地，服务端界面只接管首页之外）
    // ------------------------------------------------------------------

    /**
     * 「服务端界面是首页之外的内容由服务器加载（依旧是本地首页）」的可测表述：
     * <ul>
     *   <li>站点根（"/" / "" / null）**永远**由本地树渲染，即使该 host 生效了服务端界面；</li>
     *   <li>首页之外的子页面（/play、/rooms/abc、/settings…）在服务端界面开启时交给服务器；</li>
     *   <li>host 没开服务端界面时一切照旧走本地树（既有行为，逐字不变）。</li>
     * </ul>
     */
    private static void testHomeAlwaysLocal() {
        final String H = "stronghold.jiangjiangze.icu";

        // ① 首页：服务端界面开着也不放行 —— 这就是「首页必须是我自己的 UI」。
        check("home \"/\" stays local even with server UI on", !RemoteClientPolicy.scopeAllows(H, "/", true));
        check("home \"\" stays local even with server UI on", !RemoteClientPolicy.scopeAllows(H, "", true));
        check("home null stays local even with server UI on", !RemoteClientPolicy.scopeAllows(H, null, true));

        // ② 首页之外：服务端界面开着就交给服务器。
        check("/play goes to the server when server UI is on", RemoteClientPolicy.scopeAllows(H, "/play", true));
        check("/rooms/abc goes to the server when server UI is on",
                RemoteClientPolicy.scopeAllows(H, "/rooms/abc", true));
        // /index.html 是首页那个文档的规范路径 —— 必须和 "/" 一样留在本地，否则那种入口下的首页
        // 会被交给服务器（首页被顶掉，而且只在那一种入口复现）。
        check("/index.html stays LOCAL (it is the home document)",
                !RemoteClientPolicy.scopeAllows(H, "/index.html", true));
        check("/index.htm stays LOCAL too", !RemoteClientPolicy.scopeAllows(H, "/index.htm", true));
        check("isHomePath(\"/index.html\") is true", RemoteClientPolicy.isHomePath("/index.html"));

        // ③ 服务端界面关着 → 首页与子页面都走本地树（既有行为）。
        check("/play stays local when server UI is off", !RemoteClientPolicy.scopeAllows(H, "/play", false));
        check("home stays local when server UI is off", !RemoteClientPolicy.scopeAllows(H, "/", false));

        // ④ 空 host 不放行（host 是 identity 的一部分，缺了就不能放）。
        check("null host never allowed", !RemoteClientPolicy.scopeAllows(null, "/play", true));
        check("empty host never allowed", !RemoteClientPolicy.scopeAllows("", "/play", true));

        // ⑤ isSubPagePath 的边界（纯路径判定，与 host 无关）。
        check("\"/\" is not a sub-page", !RemoteClientPolicy.isSubPagePath("/"));
        check("\"\" is not a sub-page", !RemoteClientPolicy.isSubPagePath(""));
        check("null is not a sub-page", !RemoteClientPolicy.isSubPagePath(null));
        check("\"/play\" is a sub-page", RemoteClientPolicy.isSubPagePath("/play"));
        check("\"/p\" is a sub-page (shortest real path)", RemoteClientPolicy.isSubPagePath("/p"));
        // 尾斜杠的子页面仍是子页面（不是站点根）—— 绝不因为一个尾斜杠把首页当成子页面放行。
        check("\"/play/\" is still a sub-page", RemoteClientPolicy.isSubPagePath("/play/"));
    }

    // ------------------------------------------------------------------
    // 作用域判定必须带 query（2026-10-10 业主报障「未加载服务器样式」的根因）
    //   `Uri.getPath()` 会把 `/?room=X` 折叠成 `/`，于是进房深链被判成首页 → 规则 ① 永久劫持
    //   裸 origin 服务器的每一次进房导航。scopePath 把 path + query 合成，交给 scopeAllows。
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

        // ② 端到端语义：站点根**带 query** 是「加入房间」深链 → 首页之外 → 交给服务器。
        check("home WITH query goes to the server (join deep link)",
                RemoteClientPolicy.scopeAllows(H, RemoteClientPolicy.scopePath("/", "room=X"), true));
        // ③ 站点根**无 query** 仍恒本地（冷启动第一屏不变）。
        check("home WITHOUT query stays local",
                !RemoteClientPolicy.scopeAllows(H, RemoteClientPolicy.scopePath("/", null), true));
        // ④ /index.html 带 query 同样按子页面（深链）走服务器；不带仍是首页。
        check("/index.html WITHOUT query stays local",
                !RemoteClientPolicy.scopeAllows(H, RemoteClientPolicy.scopePath("/index.html", null), true));
        check("/index.html WITH query goes to the server",
                RemoteClientPolicy.scopeAllows(H, RemoteClientPolicy.scopePath("/index.html", "room=X"), true));
        // ⑤ 服务端界面关着 → 带 query 的根也仍走本地树（既有行为，逐字不变）。
        check("home WITH query stays local when server UI is off",
                !RemoteClientPolicy.scopeAllows(H, RemoteClientPolicy.scopePath("/", "room=X"), false));
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
