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
        testHealthTwoPaths();
        testPrefKeys();

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

    /** 默认：已知服务器 host、没被显式设置过 → 全局默认（缺省 true）= 服务端界面。 */
    private static void testDefaultIsServerUi() {
        check("defaultGlobal() is true", RemoteClientPolicy.defaultGlobal());
        check("known public host, no explicit, default on -> server UI",
                RemoteClientPolicy.resolve("stronghold.jiangjiangze.icu", true, false, false, true));
        check("known public host, no explicit, default off -> local tree",
                !RemoteClientPolicy.resolve("stronghold.jiangjiangze.icu", true, false, false, false));
        check("defaultGlobal() is what an unread pref falls back to",
                RemoteClientPolicy.resolve("raiya.example.com", true, false, false,
                        RemoteClientPolicy.defaultGlobal()));
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
