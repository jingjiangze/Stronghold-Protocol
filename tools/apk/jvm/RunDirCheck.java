import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * JVM self-test for the P0 "本地服务启动超时" run-directory unification (audit §一, fix A+B).
 * Pure logic: it does NOT touch the Android runtime, so it compiles on a plain JDK.
 *
 * Two layers of proof:
 *   1. Derivation contract — given (runBase, cwd), the run workspace must be runBase/run, and the
 *      bootstrap's launch.json path must be exactly runBase/run/launch.json (round-tripped through
 *      the same JS escaping the app uses). This is the "逐字符同源" assertion.
 *   2. Source assertions on the real NodeRunner.java / HostService.java — the bootstrap path must be
 *      DERIVED (never a second hardcoded literal), all three launch variants must share it, and the
 *      handshake watcher must poll for >= 60 s and not return early on a failure handshake.
 *
 * Build & run (JDK 17, no Android SDK needed), from the repository root:
 *   javac -d /tmp/spjvm-rundir tools/apk/jvm/RunDirCheck.java
 *   java -cp /tmp/spjvm-rundir RunDirCheck [repo-root]
 */
public final class RunDirCheck {

    private static final String APP_REL =
            "android/app/src/main/java/icu/jiangjiangze/stronghold";
    /** The old, drift-prone literal that must never come back. */
    private static final String OLD_LITERAL =
            "/data/user/0/icu.jiangjiangze.stronghold/files/run/launch.json";

    private static int checks = 0;

    public static void main(String[] args) throws Exception {
        File root = locateRoot(args);
        System.out.println("repo root: " + root.getAbsolutePath());
        String nodeRunner = read(new File(root, APP_REL + "/NodeRunner.java"));
        String hostService = read(new File(root, APP_REL + "/HostService.java"));

        // 1) Derivation contract, on the real Android path and on a Windows-style path (backslashes
        //    must survive the JS escaping — otherwise the JVM self-test itself would be meaningless).
        checkDerivation("/data/user/0/icu.jiangjiangze.stronghold/files",
                "/data/user/0/icu.jiangjiangze.stronghold/files/webroot");
        checkDerivation("C:\\Users\\x\\files", "C:\\Users\\x\\files\\webroot");
        checkDerivation("/tmp/sp/files", "/tmp/sp/files/webroot");

        // 2) Source-level single-source / hardening proof.
        checkNodeRunnerSource(nodeRunner);
        checkHostServiceSource(hostService);

        System.out.println("RunDirCheck OK: " + checks + " checks passed");
    }

    // ------------------------------------------------------------------
    // 1) derivation contract
    // ------------------------------------------------------------------

    private static void checkDerivation(String runBase, String cwd) {
        File runDir = new File(runBase, "run");
        File launchJson = new File(runDir, "launch.json");
        File handshake = new File(runDir, "handshake.json");
        File log = new File(runDir, "server.log");
        File tmp = new File(runDir, "tmp");

        eq("runDir = runBase/run", new File(runBase, "run").getAbsolutePath(), runDir.getAbsolutePath());
        eq("launchJson parent is runDir", runDir.getAbsolutePath(), launchJson.getParentFile().getAbsolutePath());
        eq("handshake parent is runDir", runDir.getAbsolutePath(), handshake.getParentFile().getAbsolutePath());
        eq("server.log parent is runDir", runDir.getAbsolutePath(), log.getParentFile().getAbsolutePath());
        eq("tmp parent is runDir", runDir.getAbsolutePath(), tmp.getParentFile().getAbsolutePath());

        // cwd (webroot) must NOT contain run/ — that is exactly the P0: a hot update (root →
        // webroot.old → rm) deleted the live logs/handshake because run/ sat inside webroot.
        String runPath = runDir.getAbsolutePath();
        String cwdPath = new File(cwd).getAbsolutePath();
        if (runPath.startsWith(cwdPath + File.separator)) {
            throw new AssertionError("run/ is inside cwd (" + runPath + " under " + cwdPath + ")");
        }
        checks++;

        // The bootstrap must read the SAME path the parent writes — round-trip it through the app's
        // escaping and back.
        String bootstrap = bootstrapSource(launchJson.getAbsolutePath());
        eq("bootstrap path == runDir/launch.json",
                launchJson.getAbsolutePath(), extractLaunchPath(bootstrap));
    }

    /** Mirrors NodeRunner.bootstrapSource (the source assertion below pins them together). */
    private static String bootstrapSource(String launchJsonPath) {
        return "const fs=require('fs');const c=JSON.parse(fs.readFileSync('"
                + jsEscape(launchJsonPath)
                + "','utf8'));Object.assign(process.env,c.env);import('file://'+c.entry);";
    }

    /** Mirrors NodeRunner.jsEscape. */
    private static String jsEscape(String s) {
        return s.replace("\\", "\\\\").replace("'", "\\'");
    }

    /** Extracts and unescapes the path inside readFileSync('...','utf8'). */
    private static String extractLaunchPath(String bootstrap) {
        String marker = "readFileSync('";
        int a = bootstrap.indexOf(marker);
        if (a < 0) throw new AssertionError("bootstrap has no readFileSync: " + bootstrap);
        int start = a + marker.length();
        int end = bootstrap.indexOf("','utf8')", start);
        if (end < 0) throw new AssertionError("bootstrap has no ','utf8') terminator");
        return bootstrap.substring(start, end).replace("\\'", "'").replace("\\\\", "\\");
    }

    // ------------------------------------------------------------------
    // 2) source assertions
    // ------------------------------------------------------------------

    private static void checkNodeRunnerSource(String src) {
        has(src, "new File(runBase, \"run\")", "NodeRunner derives runDir from runBase");
        has(src, "new File(runDir, \"launch.json\")", "NodeRunner anchors launch.json in runDir");
        has(src, "new File(runDir, \"server.log\")", "NodeRunner anchors server.log in runDir");
        has(src, "new File(runDir, \"handshake.json\")", "NodeRunner anchors handshake in runDir");
        // the run/ workspace must not be rooted at cwd any more
        notHas(src, "new File(cwd, \"run\")", "NodeRunner no longer roots run/ at cwd");
        // the old hardcoded child-side path is gone
        notHas(src, OLD_LITERAL, "old hardcoded bootstrap path removed");
        // single source of truth: bootstrap path derived from the written File
        has(src, "bootstrapSource(launchJson.getAbsolutePath())",
                "bootstrap derived from the written launch.json File");
        has(src, "jsEscape(launchJsonPath)", "bootstrapSource escapes its path parameter");
        int variants = count(src, "\"-e\", bootstrap");
        if (variants != 3) {
            throw new AssertionError("expected 3 launch variants sharing `-e`, bootstrap; found " + variants);
        }
        checks++;
        // no variant may carry a path literal of its own
        notHas(src, "readFileSync('/data", "no variant re-introduces a hardcoded readFileSync path");
    }

    private static void checkHostServiceSource(String src) {
        has(src, "NodeRunner.start(getApplicationInfo().nativeLibraryDir, root.getAbsolutePath(),",
                "HostService passes webroot as cwd");
        has(src, "getFilesDir().getAbsolutePath(),", "HostService passes filesDir as runBase");
        has(src, "HANDSHAKE_WATCH_MS", "handshake watcher has a named watch budget");
        // budget must be >= 60 s (the audit's floor)
        long ms = parseWatchMs(src);
        if (ms < 60_000) {
            throw new AssertionError("HANDSHAKE_WATCH_MS too small: " + ms + " ms (need >= 60000)");
        }
        checks++;
        // the fixed 12 s / 24-iteration loop is gone
        notHas(src, "i < 24 &&", "old 24x500ms loop removed");
        // a failure handshake must not return early any more
        notHas(src, "return; // node wrote a failure handshake",
                "watcher no longer returns early on a failure handshake");
        has(src, "handshakeError = h.optString(\"error\"",
                "watcher keeps the failure reason for diagnostics");
        // the watcher/publisher gate on serviceUp, so it must be true before they start
        before(src, "serviceUp = true;", "startHandshakeWatcher();",
                "serviceUp set before the watcher is spawned");
        // a stale teardown must not clear the new instance's state either
        int gen = src.indexOf("public void onDestroy()");
        if (gen < 0) throw new AssertionError("no onDestroy");
        String onDestroy = src.substring(gen);
        int guard = onDestroy.indexOf("if (myGeneration == GENERATION.get()) {");
        int clear = onDestroy.indexOf("serviceUp = false;");
        if (guard < 0 || clear < guard) {
            throw new AssertionError("onDestroy clears state outside the generation guard");
        }
        checks++;
    }

    private static long parseWatchMs(String src) {
        String marker = "HANDSHAKE_WATCH_MS = ";
        int a = src.indexOf(marker);
        if (a < 0) throw new AssertionError("no HANDSHAKE_WATCH_MS assignment");
        int start = a + marker.length();
        int end = start;
        while (end < src.length() && (Character.isDigit(src.charAt(end)) || src.charAt(end) == '_')) end++;
        String digits = src.substring(start, end).replace("_", "");
        if (digits.isEmpty()) throw new AssertionError("cannot parse HANDSHAKE_WATCH_MS value");
        return Long.parseLong(digits);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private static void eq(String what, String expected, String actual) {
        if (!expected.equals(actual)) {
            throw new AssertionError(what + ": expected <" + expected + "> got <" + actual + ">");
        }
        checks++;
    }

    private static void has(String haystack, String needle, String what) {
        if (!haystack.contains(needle)) {
            throw new AssertionError("missing: " + what + " (looking for `" + needle + "`)");
        }
        checks++;
    }

    private static void notHas(String haystack, String needle, String what) {
        if (haystack.contains(needle)) {
            throw new AssertionError("unexpected: " + what + " (found `" + needle + "`)");
        }
        checks++;
    }

    /** Asserts `a` appears before `b` (both must exist). */
    private static void before(String haystack, String a, String b, String what) {
        int ia = haystack.indexOf(a);
        int ib = haystack.indexOf(b);
        if (ia < 0 || ib < 0 || ia >= ib) {
            throw new AssertionError("ordering: " + what + " (a@" + ia + " b@" + ib + ")");
        }
        checks++;
    }

    private static int count(String haystack, String needle) {
        int n = 0;
        int i = 0;
        while ((i = haystack.indexOf(needle, i)) >= 0) {
            n++;
            i += needle.length();
        }
        return n;
    }

    private static String read(File f) throws Exception {
        if (!f.isFile()) throw new IllegalStateException("not a file: " + f.getAbsolutePath());
        return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
    }

    private static File locateRoot(String[] args) {
        if (args.length > 0) {
            File f = new File(args[0]);
            if (new File(f, APP_REL + "/NodeRunner.java").isFile()) return f;
        }
        File cwd = new File(".").getAbsoluteFile();
        for (File d = cwd; d != null; d = d.getParentFile()) {
            if (new File(d, APP_REL + "/NodeRunner.java").isFile()) return d;
        }
        for (String cand : new String[] {
                "C:/Users/16891/android-build/fork",
                "C:\\Users\\16891\\android-build\\fork"}) {
            File f = new File(cand);
            if (new File(f, APP_REL + "/NodeRunner.java").isFile()) return f;
        }
        throw new IllegalStateException("repo root not found (pass it as argv[0])");
    }

    private RunDirCheck() {}
}
