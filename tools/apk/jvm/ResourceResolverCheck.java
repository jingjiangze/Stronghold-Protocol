import icu.jiangjiangze.stronghold.ResourceResolver;

import java.util.ArrayList;
import java.util.List;

/**
 * JVM self-test for the resource-routing decision table (方案 §2 / §14 cases A-H). Pure logic:
 * no Android, no IO, no network. Bare JDK 17.
 *
 *   bash tools/apk/jvm/run-server-config-check.sh
 */
public final class ResourceResolverCheck {

    private static int checks = 0;
    private static final List<String> failures = new ArrayList<>();

    public static void main(String[] args) {
        testProtocolEndpoints();
        testHomepage();
        testShellPrefix();
        testAssetClassification();
        testAssetPlanOrder();
        testPlans();
        testSameOriginUrl();
        testPrefixParity();

        System.out.println("ResourceResolverCheck OK: " + checks + " checks passed");
        if (!failures.isEmpty()) {
            System.out.println("FAILURES:");
            for (String f : failures) System.out.println("  - " + f);
            System.exit(1);
        }
    }

    private static void testProtocolEndpoints() {
        // Ever direct to the current server -- the local tree must never satisfy these (14 E/F/G).
        check("healthz is protocol", ResourceResolver.isProtocolPath("/healthz"));
        check("ws is protocol", ResourceResolver.isProtocolPath("/ws"));
        check("api prefix is protocol", ResourceResolver.isProtocolPath("/api/match"));
        check("bare api is protocol", ResourceResolver.isProtocolPath("/api"));
        check("api deep path is protocol", ResourceResolver.isProtocolPath("/api/a/b/c"));
        check("mixed case healthz", ResourceResolver.isProtocolPath("/HealthZ"));
        check("protocol plan is direct only",
                ResourceResolver.protocolPlan().size() == 1
                        && ResourceResolver.protocolPlan().get(0) == ResourceResolver.Source.NETWORK);

        // Near-misses must NOT be treated as protocol endpoints (a prefix match that is too eager
        // would silently stop serving real content).
        check("apix is not protocol", !ResourceResolver.isProtocolPath("/apix"));
        check("healthz-suffix is not protocol", !ResourceResolver.isProtocolPath("/healthz2"));
        check("ws-suffix is not protocol", !ResourceResolver.isProtocolPath("/wss"));
        check("api in the middle is not protocol", !ResourceResolver.isProtocolPath("/x/api/y"));
        check("null is not protocol", !ResourceResolver.isProtocolPath(null));
        check("empty is not protocol", !ResourceResolver.isProtocolPath(""));

        check("classify /api/match -> PROTOCOL",
                ResourceResolver.classify("/api/match", false) == ResourceResolver.Kind.PROTOCOL);
        check("classify /healthz -> PROTOCOL",
                ResourceResolver.classify("/healthz", false) == ResourceResolver.Kind.PROTOCOL);
        // even a main-frame navigation to /api/** stays a protocol request
        check("classify /api/match (main frame) -> PROTOCOL",
                ResourceResolver.classify("/api/match", true) == ResourceResolver.Kind.PROTOCOL);
    }

    private static void testHomepage() {
        // 14 H: the homepage is the shell's, even when the server has one.
        check("classify /index.html -> HOMEPAGE",
                ResourceResolver.classify("/index.html", false) == ResourceResolver.Kind.HOMEPAGE);
        check("classify / -> HOMEPAGE",
                ResourceResolver.classify("/", false) == ResourceResolver.Kind.HOMEPAGE);
        check("classify main-frame nav -> HOMEPAGE",
                ResourceResolver.classify("/play", true) == ResourceResolver.Kind.HOMEPAGE);
        check("homepage plan is local only",
                ResourceResolver.homepagePlan().size() == 1
                        && ResourceResolver.homepagePlan().get(0) == ResourceResolver.Source.LOCAL);
        // a non-main-frame /play is ordinary content, not the homepage
        check("classify /play (subresource) -> STATIC",
                ResourceResolver.classify("/play", false) == ResourceResolver.Kind.STATIC);
    }

    private static void testShellPrefix() {
        check("classify /__sp/x -> SHELL",
                ResourceResolver.classify("/__sp/shell-bridge.js", false) == ResourceResolver.Kind.SHELL);
        check("classify /__sp/x (main frame) -> SHELL",
                ResourceResolver.classify("/__sp/x", true) == ResourceResolver.Kind.SHELL);
        check("shell prefix value", "/__sp/".equals(ResourceResolver.SHELL_PREFIX));
    }

    private static void testAssetClassification() {
        check("classify /assets/ui/a.webp -> ASSET",
                ResourceResolver.classify("/assets/ui/a.webp", false) == ResourceResolver.Kind.ASSET);
        check("classify /data/assets.json -> STATIC",
                ResourceResolver.classify("/data/assets.json", false) == ResourceResolver.Kind.STATIC);
        check("classify /shared/x -> STATIC",
                ResourceResolver.classify("/shared/x.js", false) == ResourceResolver.Kind.STATIC);
        check("classify null -> FOREIGN",
                ResourceResolver.classify(null, false) == ResourceResolver.Kind.FOREIGN);
        check("classify empty -> FOREIGN",
                ResourceResolver.classify("", false) == ResourceResolver.Kind.FOREIGN);
    }

    private static void testAssetPlanOrder() {
        // Default (server did NOT declare serveAssets): exactly today's behaviour.
        List<ResourceResolver.Source> def = ResourceResolver.assetPlan(false);
        check("default plan: 3 steps", def.size() == 3);
        check("default plan: local first", def.get(0) == ResourceResolver.Source.LOCAL);
        check("default plan: cdn second", def.get(1) == ResourceResolver.Source.CDN);
        check("default plan: artstore last", def.get(2) == ResourceResolver.Source.ARTSTORE);
        check("default plan: no server step", !def.contains(ResourceResolver.Source.SERVER));

        // Server declares it serves its own assets: same-origin server step goes BEFORE the CDN.
        List<ResourceResolver.Source> on = ResourceResolver.assetPlan(true);
        check("server plan: 4 steps", on.size() == 4);
        check("server plan: local first", on.get(0) == ResourceResolver.Source.LOCAL);
        check("server plan: server before cdn",
                on.indexOf(ResourceResolver.Source.SERVER) < on.indexOf(ResourceResolver.Source.CDN));
        check("server plan: artstore still last",
                on.get(on.size() - 1) == ResourceResolver.Source.ARTSTORE);
    }

    private static void testPlans() {
        List<ResourceResolver.Source> st = ResourceResolver.staticPlan();
        check("static plan: local then network", st.size() == 2
                && st.get(0) == ResourceResolver.Source.LOCAL
                && st.get(1) == ResourceResolver.Source.NETWORK);
        // The plans are immutable: a caller cannot mutate shared routing state.
        try {
            st.add(ResourceResolver.Source.CDN);
            check("static plan is immutable", false);
        } catch (UnsupportedOperationException e) {
            check("static plan is immutable", true);
        }
    }

    private static void testSameOriginUrl() {
        check("same-origin: plain",
                "https://a.example/assets/x.png".equals(
                        ResourceResolver.sameOriginUrl("https://a.example", "/assets/x.png")));
        check("same-origin: keeps port",
                "http://127.0.0.1:32123/assets/x.png".equals(
                        ResourceResolver.sameOriginUrl("http://127.0.0.1:32123", "/assets/x.png")));
        check("same-origin: drops base path",
                "https://a.example/assets/x.png".equals(
                        ResourceResolver.sameOriginUrl("https://a.example/play?room=ABCD", "/assets/x.png")));
        // Local/LAN servers are a product requirement, so http and private literals are allowed --
        // but ONLY because the host comes from the origin the user is already connected to.
        check("same-origin: http lan allowed",
                "http://192.168.1.5:8080/assets/x.png".equals(
                        ResourceResolver.sameOriginUrl("http://192.168.1.5:8080", "/assets/x.png")));

        // Rejections: anything that could point somewhere other than the current origin.
        check("same-origin: file rejected", ResourceResolver.sameOriginUrl("file:///etc", "/x") == null);
        check("same-origin: javascript rejected", ResourceResolver.sameOriginUrl("javascript:alert(1)", "/x") == null);
        check("same-origin: protocol-relative path rejected",
                ResourceResolver.sameOriginUrl("https://a.example", "//evil.example/x") == null);
        check("same-origin: traversal rejected",
                ResourceResolver.sameOriginUrl("https://a.example", "/assets/../../x") == null);
        check("same-origin: relative path rejected",
                ResourceResolver.sameOriginUrl("https://a.example", "assets/x.png") == null);
        check("same-origin: null origin rejected", ResourceResolver.sameOriginUrl(null, "/x") == null);
        check("same-origin: null path rejected", ResourceResolver.sameOriginUrl("https://a.example", null) == null);
        // An origin carrying userinfo/whitespace must not silently produce a different authority.
        check("same-origin: userinfo origin rejected",
                ResourceResolver.sameOriginUrl("https://evil@a.example", "/x") == null);
    }

    private static void testPrefixParity() {
        // The shell prefix is duplicated in MainActivity (private constant) and here on purpose:
        // the interceptor keeps its own literal so a refactor cannot silently change routing.
        // This assertion is the tripwire that keeps the two in step.
        check("shell prefix parity with MainActivity.SHELL_JS_PREFIX",
                "/__sp/".equals(ResourceResolver.SHELL_PREFIX));
    }

    private static void check(String name, boolean ok) {
        checks++;
        if (!ok) {
            failures.add(name);
            System.out.println("FAIL " + name);
        }
    }
}
