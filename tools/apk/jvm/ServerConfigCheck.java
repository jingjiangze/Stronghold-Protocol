import icu.jiangjiangze.stronghold.ServerConfig;
import icu.jiangjiangze.stronghold.ServerConfigStore;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * JVM self-test for the server-config protocol + cache (方案 §17 cases 1-16). Bare JDK 17, no Android,
 * no network — the network primitive is the injected {@link ServerConfigStore.Fetcher}.
 *
 *   bash tools/apk/jvm/run-server-config-check.sh
 */
public final class ServerConfigCheck {

    private static int checks = 0;
    private static final List<String> failures = new ArrayList<>();

    public static void main(String[] args) throws Exception {
        File root = Files.createTempDirectory("sp-srvcfg-").toFile();
        try {
            testParseAnnounce();
            testParseMatchmaking();
            testFeatures();
            testFeaturePacks();
            testSafePaths();
            testSchemaAndSize();
            testServerIdMismatch();
            testServerKey();
            testConfigUrl();
            testFirstLoadThenCache();
            testRemoteRefresh();
            testNotModified();
            testStaleCache();
            testMalformedKeepsLastGood();
            testVersionRollback();
            testServerSwitching();
            testPrefersLastGoodPath();
            testFetchFailureKeepsLastGood();
            testCacheSurvivesReload();

            System.out.println("ServerConfigCheck OK: " + checks + " checks passed");
        } finally {
            deleteRecursively(root);
        }
        if (!failures.isEmpty()) {
            System.out.println("FAILURES:");
            for (String f : failures) System.out.println("  - " + f);
            System.exit(1);
        }
    }

    // ------------------------------------------------------------------ parse

    private static void testParseAnnounce() {
        ServerConfig c = ServerConfig.parse(
                "{\"schema\":1,\"serverId\":\"a\",\"version\":3,\"ttl\":60,"
                        + "\"announce\":{\"enabled\":true,\"title\":\"T\",\"body\":\"line1\\nline2\",\"level\":\"warn\"}}",
                null);
        check("announce: parsed", c != null);
        check("announce: title", c != null && "T".equals(c.announce().title));
        check("announce: body", c != null && "line1\nline2".equals(c.announce().body));
        check("announce: level", c != null && "warn".equals(c.announce().level));
        check("announce: version", c != null && c.version() == 3);
        check("announce: ttl", c != null && c.ttl() == 60);

        // disabled / empty -> no announce at all
        ServerConfig off = ServerConfig.parse("{\"schema\":1,\"announce\":{\"enabled\":false,\"title\":\"T\"}}", null);
        check("announce: disabled -> null", off != null && off.announce() == null);
        ServerConfig empty = ServerConfig.parse("{\"schema\":1,\"announce\":{\"enabled\":true}}", null);
        check("announce: enabled but empty -> null", empty != null && empty.announce() == null);
        // unknown level collapses to info, never propagates
        ServerConfig lv = ServerConfig.parse("{\"schema\":1,\"announce\":{\"enabled\":true,\"body\":\"x\",\"level\":\"evil\"}}", null);
        check("announce: unknown level -> info", lv != null && "info".equals(lv.announce().level));
    }

    private static void testParseMatchmaking() {
        ServerConfig c = ServerConfig.parse(
                "{\"schema\":1,\"matchmaking\":{\"enabled\":true,\"endpoint\":\"/api/match\","
                        + "\"modes\":[\"normal\",\"HARD\"],\"partySize\":4,\"queueTimeoutSec\":90}}", null);
        check("match: parsed", c != null && c.matchmaking() != null);
        check("match: enabled", c.matchmaking().enabled);
        check("match: endpoint", "/api/match".equals(c.matchmaking().endpoint));
        check("match: modes upper-cased", c.matchmaking().modes.contains("NORMAL") && c.matchmaking().modes.contains("HARD"));
        check("match: partySize", c.matchmaking().partySize == 4);
        check("match: timeout", c.matchmaking().queueTimeoutSec == 90);
        // clamping
        ServerConfig cl = ServerConfig.parse(
                "{\"schema\":1,\"matchmaking\":{\"enabled\":true,\"partySize\":99,\"queueTimeoutSec\":1}}", null);
        check("match: partySize clamped", cl.matchmaking().partySize == 16);
        check("match: timeout clamped", cl.matchmaking().queueTimeoutSec == 5);
        // absolute endpoint -> the whole block is dropped (never "join a URL and request it")
        ServerConfig bad = ServerConfig.parse(
                "{\"schema\":1,\"matchmaking\":{\"enabled\":true,\"endpoint\":\"https://evil.example/x\"}}", null);
        check("match: absolute endpoint -> block dropped", bad != null && bad.matchmaking() == null);
        ServerConfig proto = ServerConfig.parse(
                "{\"schema\":1,\"matchmaking\":{\"enabled\":true,\"endpoint\":\"//evil.example/x\"}}", null);
        check("match: protocol-relative endpoint -> dropped", proto != null && proto.matchmaking() == null);
    }

    private static void testFeatures() {
        ServerConfig c = ServerConfig.parse(
                "{\"schema\":1,\"features\":{"
                        + "\"newModeA\":{\"enabled\":true,\"mode\":\"config\"},"
                        + "\"eventB\":{\"enabled\":true,\"mode\":\"config\",\"startAt\":1000,\"endAt\":2000},"
                        + "\"packC\":{\"enabled\":true,\"mode\":\"pack\"},"
                        + "\"bogusMode\":{\"enabled\":true,\"mode\":\"exec\"},"
                        + "\"notAnObject\":\"yes\","
                        + "\"bad/id\":{\"enabled\":true,\"mode\":\"config\"}"
                        + "}}", null);
        check("feature: enabled flag", c.featureEnabled("newModeA", 1500));
        check("feature: window not started yet", !c.featureEnabled("eventB", 500));
        check("feature: window active", c.featureEnabled("eventB", 1500));
        check("feature: window ended", !c.featureEnabled("eventB", 2500));
        check("feature: pack mode recorded", c.feature("packC") != null && "pack".equals(c.feature("packC").mode));
        check("feature: unknown mode ignored", c.feature("bogusMode") == null);
        check("feature: non-object ignored", c.feature("notAnObject") == null);
        check("feature: bad id ignored", c.feature("bad/id") == null);
        check("feature: disabled -> false", !c.featureEnabled("nope", 1500));
        check("feature: unknown id -> false (safe ignore)", !c.featureEnabled("totallyUnknown", 1500));
    }

    private static void testFeaturePacks() {
        ServerConfig c = ServerConfig.parse(
                "{\"schema\":1,\"featurePacks\":[{\"id\":\"match-v2\",\"version\":3},"
                        + "{\"id\":\"match-v2\",\"version\":9},{\"id\":\"../etc\",\"version\":1},"
                        + "{\"id\":\"ok\",\"version\":-5}]}", null);
        check("packs: parsed", c.featurePacks().size() == 2);
        check("packs: duplicate id collapsed to first", c.featurePacks().get(0).version == 3);
        check("packs: bad id dropped", c.feature("match-v2") == null && c.featurePacks().size() == 2);
        check("packs: negative version floored to 0", c.featurePacks().get(1).version == 0);
    }

    private static void testSafePaths() {
        check("path: relative ok", "/api/match".equals(ServerConfig.safeRelativePath("/api/match")));
        check("path: absolute url rejected", ServerConfig.safeRelativePath("https://evil.example/x") == null);
        check("path: protocol-relative rejected", ServerConfig.safeRelativePath("//evil.example") == null);
        check("path: traversal rejected", ServerConfig.safeRelativePath("/api/../../x") == null);
        check("path: backslash rejected", ServerConfig.safeRelativePath("/api\\x") == null);
        check("path: scheme-ish rejected", ServerConfig.safeRelativePath("/a:b") == null);
        check("path: no leading slash rejected", ServerConfig.safeRelativePath("api/match") == null);
        check("path: dotdir rejected", ServerConfig.safeRelativePath("/.hidden") == null);
    }

    private static void testSchemaAndSize() {
        check("schema: 1 accepted", ServerConfig.parse("{\"schema\":1}", null) != null);
        check("schema: absent defaults to 1", ServerConfig.parse("{}", null) != null);
        check("schema: 2 rejected (unknown semantics)", ServerConfig.parse("{\"schema\":2}", null) == null);
        check("schema: 0 rejected", ServerConfig.parse("{\"schema\":0}", null) == null);
        check("size: empty rejected", ServerConfig.parse("", null) == null);
        check("size: null rejected", ServerConfig.parse(null, null) == null);
        StringBuilder big = new StringBuilder("{\"schema\":1,\"pad\":\"");
        for (int i = 0; i < ServerConfig.MAX_BODY_BYTES + 100; i++) big.append('x');
        big.append("\"}");
        check("size: oversized rejected", ServerConfig.parse(big.toString(), null) == null);
    }

    private static void testServerIdMismatch() {
        String doc = "{\"schema\":1,\"serverId\":\"alpha\"}";
        check("id: matching expect accepted", ServerConfig.parse(doc, "alpha") != null);
        check("id: case-insensitive", ServerConfig.parse(doc, "ALPHA") != null);
        check("id: mismatching expect rejected", ServerConfig.parse(doc, "beta") == null);
        check("id: no expect accepts anything", ServerConfig.parse(doc, null) != null);
    }

    private static void testServerKey() {
        check("key: host+port", "example.com_8443".equals(ServerConfigStore.serverKeyOf("https://example.com:8443/x")));
        check("key: default port omitted", "example.com".equals(ServerConfigStore.serverKeyOf("https://example.com/")));
        check("key: https vs http same host", "example.com".equals(ServerConfigStore.serverKeyOf("http://example.com")));
        check("key: uppercase folded", "example.com".equals(ServerConfigStore.serverKeyOf("https://EXAMPLE.com")));
        check("key: traversal collapsed", !ServerConfigStore.serverKeyOf("https://../../etc").contains(".."));
        check("key: empty -> default", "default".equals(ServerConfigStore.serverKeyOf("")));
        check("key: localhost is addressable", "127.0.0.1_32123".equals(ServerConfigStore.serverKeyOf("http://127.0.0.1:32123")));
    }

    private static void testConfigUrl() {
        check("url: built from origin",
                "http://127.0.0.1:32123/stronghold-client.json".equals(
                        ServerConfigStore.configUrlFor("http://127.0.0.1:32123", "/stronghold-client.json")));
        check("url: well-known path",
                "https://a.example/.well-known/stronghold-client.json".equals(
                        ServerConfigStore.configUrlFor("https://a.example", "/.well-known/stronghold-client.json")));
        check("url: base path dropped",
                "https://a.example/stronghold-client.json".equals(
                        ServerConfigStore.configUrlFor("https://a.example/play?x=1", "/stronghold-client.json")));
        check("url: file scheme rejected", ServerConfigStore.configUrlFor("file:///etc/passwd", "/x") == null);
        check("url: javascript rejected", ServerConfigStore.configUrlFor("javascript:alert(1)", "/x") == null);
        check("url: traversal path rejected", ServerConfigStore.configUrlFor("https://a.example", "/../x") == null);
        check("url: null origin rejected", ServerConfigStore.configUrlFor(null, "/x") == null);
    }

    // ------------------------------------------------------------------ store

    private static void testFirstLoadThenCache() throws Exception {
        File dir = freshDir();
        check("first load: no config", ServerConfigStore.load(dir, "https://a.example").config == null);
        StubFetch f = new StubFetch();
        f.push(200, "{\"schema\":1,\"version\":5,\"announce\":{\"enabled\":true,\"body\":\"hello\"}}", "\"e1\"");
        ServerConfigStore.Cached c = ServerConfigStore.refresh(dir, "https://a.example", f, 1000L);
        check("first load: fetched", c.config != null && c.config.version() == 5);
        check("first load: announce", c.config.announce() != null && "hello".equals(c.config.announce().body));
        check("first load: wrote to disk", new File(ServerConfigStore.dirFor(dir, "https://a.example"), "config.json").isFile());
        check("first load: one request", f.calls.size() == 1);
        check("first load: used well-known first", f.calls.get(0).endsWith("/.well-known/stronghold-client.json"));
    }

    private static void testRemoteRefresh() throws Exception {
        File dir = freshDir();
        StubFetch f = new StubFetch();
        f.push(404, null, null);
        f.push(200, "{\"schema\":1,\"version\":2}", "\"e2\"");
        ServerConfigStore.Cached c = ServerConfigStore.refresh(dir, "https://a.example", f, 1000L);
        check("refresh: fell back to second path", c.config != null && c.config.version() == 2);
        check("refresh: second path is the upstream-servable one",
                f.calls.get(1).endsWith("/stronghold-client.json"));
    }

    private static void testNotModified() throws Exception {
        File dir = freshDir();
        StubFetch f = new StubFetch();
        f.push(200, "{\"schema\":1,\"version\":7}", "\"abc\"");
        ServerConfigStore.Cached first = ServerConfigStore.refresh(dir, "https://a.example", f, 1000L);
        check("304: first fetch ok", first.config != null && first.config.version() == 7);
        f.push(304, null, "\"abc\"");
        ServerConfigStore.Cached second = ServerConfigStore.refresh(dir, "https://a.example", f, 2000L);
        check("304: keeps config", second.config != null && second.config.version() == 7);
        check("304: bumps timestamp", second.fetchedAt == 2000L);
        check("304: sent if-none-match", "\"abc\"".equals(f.etags.get(1)));
        check("304: remembered the working path",
                f.calls.get(1).endsWith("/.well-known/stronghold-client.json"));
    }

    private static void testStaleCache() throws Exception {
        File dir = freshDir();
        StubFetch f = new StubFetch();
        f.push(200, "{\"schema\":1,\"version\":1,\"ttl\":60}", "\"x\"");
        ServerConfigStore.Cached c = ServerConfigStore.refresh(dir, "https://a.example", f, 1000L);
        check("ttl: fresh right after fetch", !ServerConfigStore.isStale(c, 1000L + 59_000L));
        check("ttl: stale at the boundary", ServerConfigStore.isStale(c, 1000L + 60_000L));
        check("ttl: no config is always stale",
                ServerConfigStore.isStale(ServerConfigStore.load(freshDir(), "https://z.example"), 0L));
        // ttl clamping: 0/garbage -> default 300, huge -> 1 day
        ServerConfig none = ServerConfig.parse("{\"schema\":1,\"ttl\":0}", null);
        check("ttl: zero -> default", none.ttl() == 300);
        ServerConfig huge = ServerConfig.parse("{\"schema\":1,\"ttl\":999999}", null);
        check("ttl: clamped to a day", huge.ttl() == 24 * 3600);
    }

    private static void testMalformedKeepsLastGood() throws Exception {
        File dir = freshDir();
        StubFetch f = new StubFetch();
        f.push(200, "{\"schema\":1,\"version\":4,\"announce\":{\"enabled\":true,\"body\":\"good\"}}", "\"g\"");
        ServerConfigStore.refresh(dir, "https://a.example", f, 1000L);
        f.push(200, "{not json at all", null);
        f.push(200, "{also bad", null);
        ServerConfigStore.Cached c = ServerConfigStore.refresh(dir, "https://a.example", f, 2000L);
        check("malformed: last-good kept", c.config != null && c.config.version() == 4);
        check("malformed: announce kept", c.config.announce() != null && "good".equals(c.config.announce().body));
        check("malformed: timestamp not advanced", c.fetchedAt == 1000L);
        check("malformed: nothing overwritten on disk",
                ServerConfigStore.load(dir, "https://a.example").config.version() == 4);
    }

    private static void testVersionRollback() throws Exception {
        File dir = freshDir();
        StubFetch f = new StubFetch();
        f.push(200, "{\"schema\":1,\"version\":9,\"announce\":{\"enabled\":true,\"body\":\"new\"}}", "\"n\"");
        ServerConfigStore.refresh(dir, "https://a.example", f, 1000L);
        // a stale mirror / rolled-back server offers an older doc. Rejecting it does NOT end the
        // walk -- the other candidate path may still hold a current copy -- so a 200-with-older-version
        // costs one more probe before the walk gives up.
        f.push(200, "{\"schema\":1,\"version\":8,\"announce\":{\"enabled\":true,\"body\":\"old\"}}", "\"o\"");
        f.push(404, null, null);
        ServerConfigStore.Cached c = ServerConfigStore.refresh(dir, "https://a.example", f, 2000L);
        check("rollback: rejected", c.config != null && c.config.version() == 9);
        check("rollback: content unchanged", "new".equals(c.config.announce().body));
        check("rollback: nothing written to disk",
                ServerConfigStore.load(dir, "https://a.example").config.version() == 9);
        // an EQUAL version is accepted: servers legitimately correct the content of a release in place
        f.push(200, "{\"schema\":1,\"version\":9,\"announce\":{\"enabled\":true,\"body\":\"fixed\"}}", "\"f\"");
        ServerConfigStore.Cached c2 = ServerConfigStore.refresh(dir, "https://a.example", f, 3000L);
        check("rollback: same version accepted", "fixed".equals(c2.config.announce().body));
    }

    private static void testServerSwitching() throws Exception {
        File dir = freshDir();
        StubFetch f = new StubFetch();
        f.push(200, "{\"schema\":1,\"version\":1,\"announce\":{\"enabled\":true,\"body\":\"A\"}}", "\"a\"");
        ServerConfigStore.refresh(dir, "https://a.example", f, 1000L);
        f.push(200, "{\"schema\":1,\"version\":1,\"announce\":{\"enabled\":true,\"body\":\"B\"}}", "\"b\"");
        ServerConfigStore.refresh(dir, "https://b.example", f, 1000L);
        check("switch: A keeps its own", "A".equals(ServerConfigStore.load(dir, "https://a.example").config.announce().body));
        check("switch: B has its own", "B".equals(ServerConfigStore.load(dir, "https://b.example").config.announce().body));
        check("switch: separate directories",
                !ServerConfigStore.dirFor(dir, "https://a.example").equals(ServerConfigStore.dirFor(dir, "https://b.example")));
        check("switch: unknown server has none", ServerConfigStore.load(dir, "https://c.example").config == null);
    }

    private static void testPrefersLastGoodPath() throws Exception {
        File dir = freshDir();
        StubFetch f = new StubFetch();
        f.push(404, null, null);
        f.push(200, "{\"schema\":1,\"version\":1}", "\"p\"");
        ServerConfigStore.refresh(dir, "https://a.example", f, 1000L);
        int before = f.calls.size();
        f.push(304, null, "\"p\"");
        ServerConfigStore.refresh(dir, "https://a.example", f, 2000L);
        check("path memo: only one request", f.calls.size() == before + 1);
        check("path memo: asked the remembered path first",
                f.calls.get(before).endsWith("/stronghold-client.json"));
    }

    private static void testFetchFailureKeepsLastGood() throws Exception {
        File dir = freshDir();
        StubFetch f = new StubFetch();
        f.push(200, "{\"schema\":1,\"version\":2,\"announce\":{\"enabled\":true,\"body\":\"cached\"}}", "\"c\"");
        ServerConfigStore.refresh(dir, "https://a.example", f, 1000L);
        f.failAll = true;
        ServerConfigStore.Cached c = ServerConfigStore.refresh(dir, "https://a.example", f, 5000L);
        check("offline: last-good still served", c.config != null && c.config.version() == 2);
        check("offline: content intact", "cached".equals(c.config.announce().body));
        // and a brand-new origin with no cache simply has none
        ServerConfigStore.Cached n = ServerConfigStore.refresh(dir, "https://off.example", f, 5000L);
        check("offline: fresh origin -> no config (not an error)", n.config == null);
    }

    private static void testCacheSurvivesReload() throws Exception {
        File dir = freshDir();
        StubFetch f = new StubFetch();
        f.push(200, "{\"schema\":1,\"version\":11,\"ttl\":120}", "\"s\"");
        ServerConfigStore.refresh(dir, "https://a.example", f, 7777L);
        ServerConfigStore.Cached reloaded = ServerConfigStore.load(dir, "https://a.example");
        check("reload: version", reloaded.config != null && reloaded.config.version() == 11);
        check("reload: timestamp", reloaded.fetchedAt == 7777L);
        check("reload: etag", "\"s\"".equals(reloaded.etag));
        check("reload: path", reloaded.path.endsWith("/.well-known/stronghold-client.json"));
        // corrupt the cache: must degrade to "no config", never throw
        File cf = new File(ServerConfigStore.dirFor(dir, "https://a.example"), "config.json");
        Files.write(cf.toPath(), "{{{".getBytes(StandardCharsets.UTF_8));
        ServerConfigStore.Cached broken = ServerConfigStore.load(dir, "https://a.example");
        check("reload: corrupt cache -> no config", broken.config == null);
        check("reload: corrupt cache -> timestamp cleared", broken.fetchedAt == 0L);
    }

    // ------------------------------------------------------------------ helpers

    /** A Fetcher backed by a scripted queue of responses (per call). */
    private static final class StubFetch implements ServerConfigStore.Fetcher {
        final List<int[]> codes = new ArrayList<>();
        final List<String> bodies = new ArrayList<>();
        final List<String> etagsOut = new ArrayList<>();
        final List<String> calls = new ArrayList<>();
        final List<String> etags = new ArrayList<>();
        boolean failAll = false;

        void push(int code, String body, String etag) {
            codes.add(new int[]{code});
            bodies.add(body);
            etagsOut.add(etag);
        }

        @Override
        public ServerConfigStore.Response fetch(String url, String etag) throws IOException {
            int i = calls.size();
            calls.add(url);
            etags.add(etag == null ? "" : etag);
            if (failAll || i >= codes.size()) throw new IOException("network down");
            return new ServerConfigStore.Response(codes.get(i)[0], bodies.get(i), etagsOut.get(i));
        }
    }

    private static File freshDir() throws IOException {
        return Files.createTempDirectory("sp-srvcfg-store-").toFile();
    }

    private static void deleteRecursively(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRecursively(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static void check(String name, boolean ok) {
        checks++;
        if (!ok) {
            failures.add(name);
            System.out.println("FAIL " + name);
        }
    }
}
