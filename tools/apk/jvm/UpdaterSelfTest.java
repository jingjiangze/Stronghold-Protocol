import icu.jiangjiangze.stronghold.PatchEngine;
import icu.jiangjiangze.stronghold.SlimPaths;

/**
 * JVM self-test for the hot-update P0 fixes, runnable without any Android runtime:
 *
 *   SlimPaths  -- flat RAW slim layout (the real bundle: js/main.js, server/index.js ...),
 *                 wrapper layout (Stronghold-Protocol-0.1.1/...), upstream public/ layout,
 *                 dev/ and assets/ exclusions.
 *   PatchEngine -- the five applyPatches semantics: find/replace (replace-all), already
 *                 applied, optional, shrink (first anchor line), minApp/maxApp gate, plus
 *                 CRLF input normalisation.
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
        testExclusionsAndJunk();
        testPatchFindReplace();
        testPatchAlreadyApplied();
        testPatchOptional();
        testPatchShrink();
        testPatchVersionGate();
        testPatchCrlf();
        testPatchNoAnchor();
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

    private static void testExclusionsAndJunk() {
        isNull("public/assets/x.png", SlimPaths.resolve("public/assets/x.png"));
        isNull("public/dev/x", SlimPaths.resolve("public/dev/x"));
        isNull("public/assets dir", SlimPaths.resolve("public/assets"));
        isNull("public/dev dir", SlimPaths.resolve("public/dev"));
        isNull("dev/x", SlimPaths.resolve("dev/x"));
        isNull("assets/x.png", SlimPaths.resolve("assets/x.png"));
        isNull("README.md", SlimPaths.resolve("README.md"));
        isNull("index.html.bak", SlimPaths.resolve("index.html.bak"));
        isNull("jsx/main.js", SlimPaths.resolve("jsx/main.js"));
        isNull("null entry", SlimPaths.resolve(null));
        isNull("empty entry", SlimPaths.resolve(""));
        isNull("slash only", SlimPaths.resolve("/"));
        isNull("dotfile .env", SlimPaths.resolve(".env"));
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
    // helpers
    // ------------------------------------------------------------------

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
