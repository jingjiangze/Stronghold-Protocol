package icu.jiangjiangze.stronghold;

/**
 * Pure patch replay engine (no Android dependencies). Mirrors the Node engine in
 * tools/apk/build-webroot.mjs applyPatches() and the sequential simulation in
 * tools/apk/check-patches.mjs, so the on-device hot update and the build apply the SAME
 * semantics:
 *
 *   minApp/maxApp gate (dotted-numeric, unknown app version matches) -> find/replace
 *   (already-applied when the replace text is present) -> optional (anchor absent -> skip) ->
 *   shrink (rewrite the first matching anchor line) -> NO_ANCHOR (the caller aborts).
 *
 * Text is LF on output: CRLF input is normalised on read, exactly like the Node engine
 * (the 2026-10-04 Windows CRLF divergence).
 */
public final class PatchEngine {

    public enum Status { PATCHED, ALREADY, SKIPPED, NO_ANCHOR }

    /** Outcome of one patch entry: status plus the (possibly rewritten) text. */
    public static final class Result {
        public final Status status;
        public final String text;
        /** Diagnostic for SKIPPED / NO_ANCHOR / logging; never null. */
        public final String reason;

        Result(Status status, String text, String reason) {
            this.status = status;
            this.text = text;
            this.reason = reason;
        }
    }

    private PatchEngine() {}

    /**
     * Applies one patch entry. {@code appVersion} is the tree's APP_VERSION
     * (shared/constants.js); null means "unknown" and matches any range (like Node's cmpVer).
     */
    public static Result apply(String text, String find, String replace, boolean optional,
                               boolean shrink, String appVersion, String minApp, String maxApp) {
        String t = (text == null ? "" : text).replace("\r\n", "\n");
        if (minApp != null && !minApp.isEmpty() && cmpVer(appVersion, minApp) < 0) {
            return new Result(Status.SKIPPED, t, "app " + appVersion + " < minApp " + minApp);
        }
        if (maxApp != null && !maxApp.isEmpty() && cmpVer(appVersion, maxApp) > 0) {
            return new Result(Status.SKIPPED, t, "app " + appVersion + " > maxApp " + maxApp);
        }
        String f = find == null ? "" : find;
        String r = replace == null ? "" : replace;
        if (!f.isEmpty() && t.contains(f)) {
            return new Result(Status.PATCHED, t.replace(f, r), "find/replace");
        }
        if (!r.isEmpty() && t.contains(r)) {
            return new Result(Status.ALREADY, t, "replace text already present");
        }
        if (shrink) {
            String first = firstNonBlankLine(f);
            if (first != null && t.contains(first)) {
                String[] lines = t.split("\n", -1);
                for (int i = 0; i < lines.length; i++) {
                    if (lines[i].contains(first)) {
                        lines[i] = r; // rewrite the whole anchor line, like Node's splice(at, 1, replace)
                        return new Result(Status.PATCHED, String.join("\n", lines), "shrink@line " + (i + 1));
                    }
                }
            }
        }
        if (optional) return new Result(Status.SKIPPED, t, "anchor absent (optional)");
        return new Result(Status.NO_ANCHOR, t, "anchor not found");
    }

    private static String firstNonBlankLine(String find) {
        if (find == null) return null;
        for (String line : find.split("\n", -1)) {
            if (!line.trim().isEmpty()) return line;
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Shell overlay policy (content-pack shell-ui/ channel) -- pure, JVM-testable
    // ------------------------------------------------------------------

    /** Where the shell's own extras+patches are replayed from. The two are mutually exclusive. */
    public enum OverlaySource {
        /** Today's behavior: the overlay baked into the APK (assets/shell). */
        ASSETS,
        /** The versioned overlay snapshot the slim bundle carries under shell-ui/. */
        SLIM
    }

    /**
     * True when the slim-carried overlay is STRICTLY NEWER than what the device already has.
     * null means "the bundle carries no (usable) shell-ui package" and never wins; an equal
     * version keeps the installed overlay: the two sources must never both be applied.
     */
    public static boolean shouldUseSlimOverlay(Integer slimVersion, int deviceVersion) {
        return slimVersion != null && slimVersion > deviceVersion;
    }

    /** The single branch the updater takes: slim-carried overlay vs the APK's assets/shell. */
    public static OverlaySource chooseOverlaySource(Integer slimVersion, int deviceVersion) {
        return shouldUseSlimOverlay(slimVersion, deviceVersion) ? OverlaySource.SLIM : OverlaySource.ASSETS;
    }

    /**
     * Version out of a shell-ui version file body ("1\n"). Anything that is not a non-negative
     * decimal integer -- empty, hex, "1.5", trailing words, overflow -- parses as 0, which the
     * decision treats as "no overlay" (an APK that predates the channel is also baseline 0).
     */
    public static int parseOverlayVersion(String body) {
        if (body == null) return 0;
        String s = body.trim();
        if (s.isEmpty()) return 0;
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) < '0' || s.charAt(i) > '9') return 0;
        }
        try {
            long v = Long.parseLong(s);
            return v > Integer.MAX_VALUE ? 0 : (int) v;
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** Dotted-numeric version compare (-1 / 0 / 1); a null app version matches any range. */
    static int cmpVer(String a, String b) {
        if (a == null) return 0; // unknown -> treat as matching any range
        String[] aa = String.valueOf(a).split("\\.", -1);
        String[] bb = String.valueOf(b).split("\\.", -1);
        int n = Math.max(aa.length, bb.length);
        for (int i = 0; i < n; i++) {
            String x = i < aa.length ? aa[i] : "0";
            String y = i < bb.length ? bb[i] : "0";
            Double nx = num(x);
            Double ny = num(y);
            int c;
            if (nx != null && ny != null) c = Double.compare(nx, ny);
            else c = x.compareTo(y) < 0 ? -1 : (x.equals(y) ? 0 : 1);
            if (c != 0) return c < 0 ? -1 : 1;
        }
        return 0;
    }

    /** JS Number() approximation for one dotted segment (''/blank -> 0, non-numeric -> NaN). */
    private static Double num(String segment) {
        String s = segment == null ? "" : segment.trim();
        if (s.isEmpty()) return Double.valueOf(0);
        try {
            return Double.valueOf(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
