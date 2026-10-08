import icu.jiangjiangze.stronghold.PatchEngine;
import icu.jiangjiangze.stronghold.SlimPaths;

/**
 * JVM self-test for the hot-update P0 fixes, runnable without any Android runtime:
 *
 *   SlimPaths  -- flat RAW slim layout (the real bundle: js/main.js, server/index.js ...),
 *                 wrapper layout (Stronghold-Protocol-0.1.1/...), upstream public/ layout,
 *                 the deny-list semantics (dev/assets/stamp.txt/slim-manifest.txt rejected at the
 *                 top level only; a brand-new top-level dir is KEPT -- audit R-04), explicit
 *                 traversal rejection.
 *   PatchEngine -- the five applyPatches semantics: find/replace (replace-all), already
 *                 applied, optional, shrink (first anchor line), minApp/maxApp gate, plus
 *                 CRLF input normalisation, plus the content-pack shell-overlay policy
 *                 (shouldUseSlimOverlay / chooseOverlaySource / parseOverlayVersion).
 *
 * Build & run (JDK 17, no Android SDK needed):
 *   javac -d /tmp/spjvm \
 *     android/app/src/main/java/icu/jiangjiangze/stronghold/SlimPaths.java \
 *     android/app/src/main/java/icu/jiangjiangze/stronghold/PatchEngine.java \
 *     tools/apk/jvm/UpdaterSelfTest.java
 *   java -cp /tmp/spjvm UpdaterSelfTest
 */
public final class UpdaterSelfTest {

    private static int checks = 0;

    public static void main(String[] args) {
        testFlatSlotLayout();
        testWrapperLayout();
        testPublicLayout();
        testNewTopLevelDirs();
        testExclusionsAndJunk();
        testTraversalRejected();
        testIsSafeRel();
        testPatchFindReplace();
        testPatchAlreadyApplied();
        testPatchOptional();
        testPatchShrink();
        testPatchVersionGate();
        testPatchCrlf();
        testPatchNoAnchor();
        testSlimOverlayDecision();
        testOverlayVersionParsing();
        testOverlaySourceChoice();
        System.out.println("UpdaterSelfTest OK: " + checks + " checks passed");
    }

    // ------------------------------------------------------------------
    // SlimPaths
    // ------------------------------------------------------------------

    /** The confirmed P0-1: flat RAW slim entries must map to themselves. */
    private static void testFlatSlotLayout() {
        eq("flat index.html", "index.html", SlimPaths.resolve("index.html"));
        eq("flat data.js", "data.js", SlimPaths.resolve("data.js"));
        eq("flat js/main.js", "js/main.js", SlimPaths.resolve("js/main.js"));
        eq("flat js/x/y.js", "js/x/y.js", SlimPaths.resolve("js/x/y.js"));
        eq("flat server/index.js", "server/index.js", SlimPaths.resolve("server/index.js"));
        eq("flat shared/constants.js", "shared/constants.js", SlimPaths.resolve("shared/constants.js"));
        eq("flat package.json", "package.json", SlimPaths.resolve("package.json"));
        eq("flat css/theme.css", "css/theme.css", SlimPaths.resolve("css/theme.css"));
        eq("flat sim/content/support/index.js", "sim/content/support/index.js",
                SlimPaths.resolve("sim/content/support/index.js"));
        eq("flat node_modules/ws/index.js", "node_modules/ws/index.js",
                SlimPaths.resolve("node_modules/ws/index.js"));
        eq("flat dir js/", "js", SlimPaths.resolve("js/"));
        eq("flat dir server/", "server", SlimPaths.resolve("server/"));
        eq("backslash js\\main.js", "js/main.js", SlimPaths.resolve("js\\main.js"));
        eq("leading slash /js/main.js", "js/main.js", SlimPaths.resolve("/js/main.js"));
    }

    /** Wrapper folder around the flat tree: one segment is stripped on retry. */
    private static void testWrapperLayout() {
        eq("wrapper index.html", "index.html",
                SlimPaths.resolve("Stronghold-Protocol-0.1.1/index.html"));
        eq("wrapper js/main.js", "js/main.js",
                SlimPaths.resolve("Stronghold-Protocol-0.1.1/js/main.js"));
        eq("wrapper js/x/y.js", "js/x/y.js",
                SlimPaths.resolve("Stronghold-Protocol-0.1.1/js/x/y.js"));
        eq("wrapper server/index.js", "server/index.js",
                SlimPaths.resolve("Stronghold-Protocol-0.1.1/server/index.js"));
        eq("wrapper shared/constants.js", "shared/constants.js",
                SlimPaths.resolve("Stronghold-Protocol-0.1.1/shared/constants.js"));
        eq("wrapper package.json", "package.json",
                SlimPaths.resolve("Stronghold-Protocol-0.1.1/package.json"));
    }

    /** Upstream public/ layout, with and without a wrapper folder (kept legacy semantics). */
    private static void testPublicLayout() {
        eq("public index.html", "index.html", SlimPaths.resolve("public/index.html"));
        eq("public data.js", "data.js", SlimPaths.resolve("public/data.js"));
        eq("public js/main.js", "js/main.js", SlimPaths.resolve("public/js/main.js"));
        eq("wrapper+public js/main.js", "js/main.js",
                SlimPaths.resolve("Stronghold-Protocol-0.1.1/public/js/main.js"));
        eq("wrapper+public index.html", "index.html",
                SlimPaths.resolve("Stronghold-Protocol-0.1.1/public/index.html"));
    }

    /** Audit R-04: L1 membership is a DENY-list (mirrors tools/apk/slim-top.mjs). A top-level dir
     *  nobody has ever seen must survive a hot update -- the whole-tree swap makes a dropped entry
     *  permanent -- while the exclusions and the build artifacts stay rejected. */
    private static void testNewTopLevelDirs() {
        eq("new top dir wasm/engine.wasm", "wasm/engine.wasm", SlimPaths.resolve("wasm/engine.wasm"));
        eq("new top dir workers/worker.js", "workers/worker.js", SlimPaths.resolve("workers/worker.js"));
        eq("new top dir packs/cards/zh.json", "packs/cards/zh.json", SlimPaths.resolve("packs/cards/zh.json"));
        eq("new top dir after public folding", "wasm/engine.wasm",
                SlimPaths.resolve("public/wasm/engine.wasm"));
        eq("a dotfile is a plain top-level name", ".env", SlimPaths.resolve(".env"));
        eq("README.md rides as a new top-level file", "README.md", SlimPaths.resolve("README.md"));
        // Wrapper honesty: one folder is peeled ONLY when the peeled path is root-shaped. Per entry
        // a novel dir inside a wrapper cannot be distinguished from a genuine nested path, so the
        // prefix is KEPT (documented deviation from verify-slim's whole-archive wrapper detection;
        // the real published slim is flat, so this only concerns legacy wrapper archives).
        eq("wrapper + new dir keeps its prefix", "Legacy-0.1.1/wasm/engine.wasm",
                SlimPaths.resolve("Legacy-0.1.1/wasm/engine.wasm"));
        eq("wrapper + public + new dir keeps its prefix", "Legacy-0.1.1/public/wasm/engine.wasm",
                SlimPaths.resolve("Legacy-0.1.1/public/wasm/engine.wasm"));
    }

    private static void testExclusionsAndJunk() {
        // Top-level exclusions: dev/ and assets/ (L2 art), plus the build artifacts as whole
        // top-level names. Nested namesakes are NOT exclusions (the deny-list is top-level only).
        isNull("dev/x", SlimPaths.resolve("dev/x"));
        isNull("dev dir", SlimPaths.resolve("dev"));
        isNull("assets/x.png", SlimPaths.resolve("assets/x.png"));
        isNull("assets dir", SlimPaths.resolve("assets"));
        isNull("public/dev/x", SlimPaths.resolve("public/dev/x"));
        isNull("public/dev dir", SlimPaths.resolve("public/dev"));
        isNull("public/assets/x.png", SlimPaths.resolve("public/assets/x.png"));
        isNull("public/assets dir", SlimPaths.resolve("public/assets"));
        isNull("wrapper+public/ assets", SlimPaths.resolve("Legacy-0.1.1/public/assets/x.png"));
        isNull("stamp.txt", SlimPaths.resolve("stamp.txt"));
        isNull("slim-manifest.txt", SlimPaths.resolve("slim-manifest.txt"));
        isNull("public/stamp.txt", SlimPaths.resolve("public/stamp.txt"));
        isNull("public/slim-manifest.txt", SlimPaths.resolve("public/slim-manifest.txt"));
        eq("nested assets is content", "js/assets/keep.js", SlimPaths.resolve("js/assets/keep.js"));
        eq("nested dev inside a new dir is content", "newdir/dev/tool.js",
                SlimPaths.resolve("newdir/dev/tool.js"));
        eq("assets.txt is a plain name", "assets.txt", SlimPaths.resolve("assets.txt"));
        eq("stamp.txt.bak is a plain name", "stamp.txt.bak", SlimPaths.resolve("stamp.txt.bak"));
        // The JS root-shape expression is deliberately loose (startsWith, not a segment match).
        eq("index.html.bak is root-shaped (JS looseness mirrored)", "index.html.bak",
                SlimPaths.resolve("index.html.bak"));
        eq("jsx/main.js is accepted as a new top dir", "jsx/main.js", SlimPaths.resolve("jsx/main.js"));
        // Degenerate names normalise to nothing.
        isNull("null entry", SlimPaths.resolve(null));
        isNull("empty entry", SlimPaths.resolve(""));
        isNull("slash only", SlimPaths.resolve("/"));
        isNull("dir slash only", SlimPaths.resolve("//"));
        eq("three dots is a plain name", ".../x", SlimPaths.resolve(".../x"));
    }

    /** Explicit traversal guard: any "." / ".." path segment rejects the entry, wherever it sits. */
    private static void testTraversalRejected() {
        isNull("../x", SlimPaths.resolve("../x"));
        isNull("../../etc/passwd", SlimPaths.resolve("../../etc/passwd"));
        isNull("a/../b", SlimPaths.resolve("a/../b"));
        isNull("..", SlimPaths.resolve(".."));
        isNull(".", SlimPaths.resolve("."));
        isNull("./x", SlimPaths.resolve("./x"));
        isNull("./js/main.js", SlimPaths.resolve("./js/main.js"));
        isNull("js/./main.js", SlimPaths.resolve("js/./main.js"));
        isNull("public/../js/main.js", SlimPaths.resolve("public/../js/main.js"));
        isNull("wrapper/../js/main.js", SlimPaths.resolve("Legacy-0.1.1/../js/main.js"));
        isNull("backslash traversal", SlimPaths.resolve("..\\..\\x"));
        isNull("empty middle segment", SlimPaths.resolve("js//main.js"));
        eq("a name merely starting with dots is fine", "..env.txt", SlimPaths.resolve("..env.txt"));
        eq("a name containing dots is fine", "a..b/c", SlimPaths.resolve("a..b/c"));
    }

    /**
     * The zero-I/O lexical guard the hot-update extraction uses INSTEAD of a per-entry
     * getCanonicalPath() walk (Updater.extractSlim). Every traversal/absolute/colon form must be
     * rejected without touching the filesystem; a plain relative path must pass.
     */
    private static void testIsSafeRel() {
        eq("safe plain", "true", String.valueOf(SlimPaths.isSafeRel("js/main.js")));
        eq("safe nested", "true", String.valueOf(SlimPaths.isSafeRel("server/overlay/sp-host.mjs")));
        eq("safe dots in name", "true", String.valueOf(SlimPaths.isSafeRel("a..b/c")));
        eq("reject traversal", "false", String.valueOf(SlimPaths.isSafeRel("../x")));
        eq("reject inner traversal", "false", String.valueOf(SlimPaths.isSafeRel("a/../b")));
        eq("reject dot segment", "false", String.valueOf(SlimPaths.isSafeRel("a/./b")));
        eq("reject empty segment", "false", String.valueOf(SlimPaths.isSafeRel("a//b")));
        eq("reject absolute", "false", String.valueOf(SlimPaths.isSafeRel("/etc/passwd")));
        eq("reject trailing slash", "false", String.valueOf(SlimPaths.isSafeRel("js/")));
        eq("reject drive colon", "false", String.valueOf(SlimPaths.isSafeRel("C:/x")));
        eq("reject scheme colon", "false", String.valueOf(SlimPaths.isSafeRel("http:/x")));
        eq("reject null", "false", String.valueOf(SlimPaths.isSafeRel(null)));
        eq("reject empty", "false", String.valueOf(SlimPaths.isSafeRel("")));
    }

    // ------------------------------------------------------------------
    // PatchEngine
    // ------------------------------------------------------------------

    private static void testPatchFindReplace() {
        PatchEngine.Result r = PatchEngine.apply("alpha BETA gamma", "BETA", "beta",
                false, false, null, null, null);
        eqStatus("find/replace status", PatchEngine.Status.PATCHED, r);
        eq("find/replace text", "alpha beta gamma", r.text);

        PatchEngine.Result all = PatchEngine.apply("X a X b X", "X", "Y",
                false, false, null, null, null);
        eqStatus("replace-all status", PatchEngine.Status.PATCHED, all);
        eq("replace-all text", "Y a Y b Y", all.text);
    }

    private static void testPatchAlreadyApplied() {
        PatchEngine.Result r = PatchEngine.apply("alpha beta gamma", "BETA", "beta",
                false, false, null, null, null);
        eqStatus("already status", PatchEngine.Status.ALREADY, r);
        eq("already text untouched", "alpha beta gamma", r.text);

        // A CRLF tree which already carries the replacement: ALREADY, but still LF-normalised.
        PatchEngine.Result crlf = PatchEngine.apply("a\r\nbeta\r\nc", "BETA", "beta",
                false, false, null, null, null);
        eqStatus("already (crlf) status", PatchEngine.Status.ALREADY, crlf);
        eq("already (crlf) normalized", "a\nbeta\nc", crlf.text);
    }

    private static void testPatchOptional() {
        PatchEngine.Result r = PatchEngine.apply("nothing here", "MISSING", "Y",
                true, false, null, null, null);
        eqStatus("optional status", PatchEngine.Status.SKIPPED, r);
        eq("optional text untouched", "nothing here", r.text);

        PatchEngine.Result present = PatchEngine.apply("nothing here", "here", "there",
                true, false, null, null, null);
        eqStatus("optional-but-present status", PatchEngine.Status.PATCHED, present);
        eq("optional-but-present text", "nothing there", present.text);
    }

    private static void testPatchShrink() {
        // Full multi-line anchor is gone (upstream reflowed the middle), first anchor line is
        // still there -> rewrite that whole line with the replacement.
        PatchEngine.Result r = PatchEngine.apply("a\nXXX\nQ\nb", "\nXXX\nYYY", "ZZZ",
                false, true, null, null, null);
        eqStatus("shrink status", PatchEngine.Status.PATCHED, r);
        eq("shrink text", "a\nZZZ\nQ\nb", r.text);

        // Shrink line absent -> NO_ANCHOR (no optional).
        PatchEngine.Result miss = PatchEngine.apply("a\nQ\nb", "\nXXX\nYYY", "ZZZ",
                false, true, null, null, null);
        eqStatus("shrink miss status", PatchEngine.Status.NO_ANCHOR, miss);

        // Shrink + optional -> SKIPPED.
        PatchEngine.Result opt = PatchEngine.apply("a\nQ\nb", "\nXXX\nYYY", "ZZZ",
                true, true, null, null, null);
        eqStatus("shrink optional miss status", PatchEngine.Status.SKIPPED, opt);

        // Normal multi-line hit wins over shrink.
        PatchEngine.Result full = PatchEngine.apply("a\nXXX\nYYY\nb", "\nXXX\nYYY", "\nZZZ",
                false, true, null, null, null);
        eqStatus("shrink full-hit status", PatchEngine.Status.PATCHED, full);
        eq("shrink full-hit text", "a\nZZZ\nb", full.text);
    }

    private static void testPatchVersionGate() {
        // app 0.1.0 < minApp 0.2.0 -> skipped even though the anchor is present.
        PatchEngine.Result below = PatchEngine.apply("anchor A", "A", "B",
                false, false, "0.1.0", "0.2.0", null);
        eqStatus("minApp below status", PatchEngine.Status.SKIPPED, below);
        eq("minApp below text untouched", "anchor A", below.text);

        // dotted-NUMERIC compare: 0.10.0 >= 0.9.0 (string compare would have said "0.1" < "0.9").
        PatchEngine.Result numeric = PatchEngine.apply("anchor A", "A", "B",
                false, false, "0.10.0", "0.9.0", null);
        eqStatus("minApp numeric status", PatchEngine.Status.PATCHED, numeric);

        // app 0.3.0 > maxApp 0.2.0 -> skipped; equal maxApp applies.
        PatchEngine.Result above = PatchEngine.apply("anchor A", "A", "B",
                false, false, "0.3.0", null, "0.2.0");
        eqStatus("maxApp above status", PatchEngine.Status.SKIPPED, above);

        PatchEngine.Result equal = PatchEngine.apply("anchor A", "A", "B",
                false, false, "0.2.0", null, "0.2.0");
        eqStatus("maxApp equal status", PatchEngine.Status.PATCHED, equal);

        // Unknown tree version matches any range (Node cmpVer null -> 0).
        PatchEngine.Result unknown = PatchEngine.apply("anchor A", "A", "B",
                false, false, null, "9.9.9", null);
        eqStatus("unknown app status", PatchEngine.Status.PATCHED, unknown);
    }

    private static void testPatchCrlf() {
        PatchEngine.Result r = PatchEngine.apply("a\r\nBETA\r\nc", "BETA", "beta",
                false, false, null, null, null);
        eqStatus("crlf status", PatchEngine.Status.PATCHED, r);
        eq("crlf text", "a\nbeta\nc", r.text);
        check("crlf output has no \\r", !r.text.contains("\r"));

        // Multi-line find written with CRLF in the source spec still matches after normalisation.
        PatchEngine.Result multi = PatchEngine.apply("a\nL1\nL2\nc", "L1\nL2", "L1\nL2x",
                false, false, null, null, null);
        eqStatus("multiline status", PatchEngine.Status.PATCHED, multi);
        eq("multiline text", "a\nL1\nL2x\nc", multi.text);
    }

    private static void testPatchNoAnchor() {
        PatchEngine.Result r = PatchEngine.apply("abc", "MISSING", "Y",
                false, false, null, null, null);
        eqStatus("no-anchor status", PatchEngine.Status.NO_ANCHOR, r);
        eq("no-anchor text untouched", "abc", r.text);

        // Empty find (malformed spec) is never a match: NO_ANCHOR, or SKIPPED when optional.
        PatchEngine.Result empty = PatchEngine.apply("abc", "", "Y",
                false, false, null, null, null);
        eqStatus("empty find status", PatchEngine.Status.NO_ANCHOR, empty);
        PatchEngine.Result emptyOpt = PatchEngine.apply("abc", "", "Y",
                true, false, null, null, null);
        eqStatus("empty find optional status", PatchEngine.Status.SKIPPED, emptyOpt);
    }

    // ------------------------------------------------------------------
    // PatchEngine shell-overlay policy (content-pack shell-ui/ channel)
    // ------------------------------------------------------------------

    /** The decision must be strictly "slim version is newer"; null/equal never wins. */
    private static void testSlimOverlayDecision() {
        check("overlay: null slim version never wins", !PatchEngine.shouldUseSlimOverlay(null, 0));
        check("overlay: null slim version never wins even at baseline 5",
                !PatchEngine.shouldUseSlimOverlay(null, 5));
        check("overlay: any positive version beats baseline 0",
                PatchEngine.shouldUseSlimOverlay(1, 0));
        check("overlay: newer than device wins", PatchEngine.shouldUseSlimOverlay(4, 3));
        check("overlay: equal keeps the installed overlay",
                !PatchEngine.shouldUseSlimOverlay(3, 3));
        check("overlay: older loses", !PatchEngine.shouldUseSlimOverlay(2, 3));
        check("overlay: version 0 never beats baseline 0",
                !PatchEngine.shouldUseSlimOverlay(0, 0));
        check("overlay: boxed Integer(7) vs 6 wins",
                PatchEngine.shouldUseSlimOverlay(Integer.valueOf(7), 6));
    }

    /** Device/producer both read an integer; anything malformed must degrade to 0, never throw. */
    private static void testOverlayVersionParsing() {
        eqInt("parse '1'", 1, PatchEngine.parseOverlayVersion("1"));
        eqInt("parse '1\\n'", 1, PatchEngine.parseOverlayVersion("1\n"));
        eqInt("parse ' 42 '", 42, PatchEngine.parseOverlayVersion(" 42 "));
        eqInt("parse '0'", 0, PatchEngine.parseOverlayVersion("0"));
        eqInt("parse null", 0, PatchEngine.parseOverlayVersion(null));
        eqInt("parse empty", 0, PatchEngine.parseOverlayVersion(""));
        eqInt("parse blank", 0, PatchEngine.parseOverlayVersion("   \n"));
        eqInt("parse 'abc'", 0, PatchEngine.parseOverlayVersion("abc"));
        eqInt("parse '1.5'", 0, PatchEngine.parseOverlayVersion("1.5"));
        eqInt("parse '1abc'", 0, PatchEngine.parseOverlayVersion("1abc"));
        eqInt("parse '-1'", 0, PatchEngine.parseOverlayVersion("-1"));
        eqInt("parse '0x10'", 0, PatchEngine.parseOverlayVersion("0x10"));
        eqInt("parse 'version 3'", 0, PatchEngine.parseOverlayVersion("version 3"));
        eqInt("parse overflowing digits", 0, PatchEngine.parseOverlayVersion("99999999999999999999"));
    }

    /** Source selection: exactly one of the two overlay sources may ever be chosen. */
    private static void testOverlaySourceChoice() {
        eqSource("choice: no shell-ui -> assets", PatchEngine.OverlaySource.ASSETS,
                PatchEngine.chooseOverlaySource(null, 0));
        eqSource("choice: newer slim -> slim", PatchEngine.OverlaySource.SLIM,
                PatchEngine.chooseOverlaySource(1, 0));
        eqSource("choice: equal -> assets", PatchEngine.OverlaySource.ASSETS,
                PatchEngine.chooseOverlaySource(4, 4));
        eqSource("choice: older slim -> assets", PatchEngine.OverlaySource.ASSETS,
                PatchEngine.chooseOverlaySource(3, 4));
        eqSource("choice: version 0 -> assets", PatchEngine.OverlaySource.ASSETS,
                PatchEngine.chooseOverlaySource(0, 0));
        eqSource("choice: bigger jump -> slim", PatchEngine.OverlaySource.SLIM,
                PatchEngine.chooseOverlaySource(9, 1));
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private static void eqInt(String what, int expected, int actual) {
        checks++;
        if (expected != actual) {
            throw new AssertionError(what + ": expected " + expected + " but was " + actual);
        }
    }

    private static void eqSource(String what, PatchEngine.OverlaySource expected,
                                 PatchEngine.OverlaySource actual) {
        checks++;
        if (actual != expected) {
            throw new AssertionError(what + ": expected " + expected + " but was " + actual);
        }
    }

    private static void eq(String what, String expected, String actual) {
        checks++;
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(what + ": expected " + show(expected) + " but was " + show(actual));
        }
    }

    private static void eqStatus(String what, PatchEngine.Status expected, PatchEngine.Result actual) {
        checks++;
        if (actual == null || actual.status != expected) {
            throw new AssertionError(what + ": expected " + expected + " but was "
                    + (actual == null ? "null" : actual.status + " (" + actual.reason + ")"));
        }
    }

    private static void isNull(String what, String actual) {
        checks++;
        if (actual != null) throw new AssertionError(what + ": expected null but was " + show(actual));
    }

    private static void check(String what, boolean cond) {
        checks++;
        if (!cond) throw new AssertionError(what);
    }

    private static String show(String s) {
        return s == null ? "null" : "\"" + s.replace("\n", "\\n").replace("\r", "\\r") + "\"";
    }
}
