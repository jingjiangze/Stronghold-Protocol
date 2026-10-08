import icu.jiangjiangze.stronghold.SlimPaths;

import java.io.File;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.TreeSet;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Runs SlimPaths.resolve() over EVERY entry of the real published slim bundle and asserts the
 * resolved set still carries the host-critical files (server/index.js, js/main.js,
 * shared/constants.js, index.html), never leaks L2 art (assets/...) and maps the whole derived
 * top-level set. This is the exact P0-1 regression that made every hot update fail ("incomplete
 * content pack, no server": js/main.js was stripped to main.js and dropped), plus the audit R-04
 * contract: L1 membership is a DENY-list (mirrors tools/apk/slim-top.mjs), so every top-level entry
 * of the artifact that is not excluded must resolve -- a top-level dir the device has never seen
 * must never be silently dropped by the whole-tree hot update swap.
 *
 * Build & run (JDK 17, no Android SDK needed):
 *   javac -d /tmp/spjvm-slim \
 *     android/app/src/main/java/icu/jiangjiangze/stronghold/SlimPaths.java \
 *     tools/apk/jvm/SlimExtractCheck.java
 *   java -cp /tmp/spjvm-slim SlimExtractCheck [path/to/content-slim-shell-v2.9.102.zip]
 *
 * Run from the repository root, or pass the zip path explicitly.
 */
public final class SlimExtractCheck {

    private static final String[] REQUIRED = {
            "server/index.js", "js/main.js", "shared/constants.js", "index.html"};

    /** Top-level names the device-side deny-list rejects (mirror of SlimPaths' arrays). */
    private static final String[] EXCLUDED_TOP = {"dev", "assets", "stamp.txt", "slim-manifest.txt"};

    public static void main(String[] args) throws Exception {
        checkSyntheticEntries();

        File zip = locate(args);
        System.out.println("slim zip: " + zip.getPath() + " (" + zip.length() + " bytes)");

        TreeSet<String> resolved = new TreeSet<>();
        TreeSet<String> rawTops = new TreeSet<>();
        List<String> exclusionLeaks = new ArrayList<>();
        int entries = 0;
        int mapped = 0;
        try (ZipFile zf = new ZipFile(zip)) {
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                entries++;
                String raw = e.getName().replace('\\', '/').replaceAll("^/+", "");
                if (!raw.isEmpty()) {
                    int slash = raw.indexOf('/');
                    rawTops.add(slash < 0 ? raw : raw.substring(0, slash));
                }
                String rel = SlimPaths.resolve(e.getName());
                if (rel == null) continue;
                mapped++;
                String top = rel.contains("/") ? rel.substring(0, rel.indexOf('/')) : rel;
                for (String bad : EXCLUDED_TOP) {
                    if (rel.equals(bad) || rel.startsWith(bad + "/")) exclusionLeaks.add(rel);
                }
                if (top.isEmpty()) throw new AssertionError("empty top segment for " + e.getName());
                resolved.add(rel);
            }
        }

        for (String needle : REQUIRED) {
            if (!resolved.contains(needle)) {
                throw new AssertionError("resolved set is missing " + needle
                        + " (raw flat entry check: " + rawHas(zip, needle) + ")");
            }
            System.out.println("  ok: " + needle + " -> " + needle);
        }
        if (!exclusionLeaks.isEmpty()) {
            throw new AssertionError("excluded paths leaked into the slim set: " + exclusionLeaks
                    + " (" + exclusionLeaks.size() + " entries)");
        }
        if (mapped < 100) {
            throw new AssertionError("only " + mapped + " entries mapped of " + entries
                    + " -- resolver looks broken");
        }
        // Audit R-04 on the REAL artifact: every non-excluded top-level entry rides the device set.
        for (String top : rawTops) {
            if (isExcludedTop(top)) continue;
            boolean present = resolved.contains(top) || resolved.stream().anyMatch((r) -> r.startsWith(top + "/"));
            if (!present) {
                throw new AssertionError("top-level entry \"" + top + "\" of the real slim is dropped "
                        + "by SlimPaths.resolve() -- a hot update would permanently lose it (R-04)");
            }
            System.out.println("  ok: top-level " + top + " rides the resolved set");
        }

        System.out.println("entries: " + entries + ", mapped: " + mapped
                + ", distinct slim paths: " + resolved.size());
        System.out.println("no dev/ or assets/ entries in the resolved set");
        System.out.println("SlimExtractCheck OK");
    }

    /** Synthetic entries (not from a zip): the deny-list must keep a top-level dir the device has
     *  never seen (audit R-04) while the exclusions / traversal guard still reject. */
    private static void checkSyntheticEntries() {
        expect("wasm/engine.wasm", "wasm/engine.wasm");
        expect("wasm/pkg/stronghold_bg.wasm", "wasm/pkg/stronghold_bg.wasm");
        expect("workers/worker.js", "workers/worker.js");
        expect("wasm/engine.wasm", "public/wasm/engine.wasm");
        expect("js/main.js", "Legacy-0.1.1/js/main.js");           // wrapper still peels
        expect("js/main.js", "Legacy-0.1.1/public/js/main.js");    // wrapper+public still folds
        expect("newdir/dev/tool.js", "newdir/dev/tool.js");        // nested dev is not an exclusion
        expect(null, "dev/tool.js");
        expect(null, "assets/art/x.webp");
        expect(null, "public/dev/serve.js");
        expect(null, "stamp.txt");
        expect(null, "slim-manifest.txt");
        expect(null, "../escape.txt");
        expect(null, "js/../escape.txt");
        expect(null, "./vendor/x.js");
        System.out.println("synthetic entries: novel top-level dir kept, exclusions/traversal rejected");
    }

    private static void expect(String want, String entry) {
        String got = SlimPaths.resolve(entry);
        if (want == null ? got != null : !want.equals(got)) {
            throw new AssertionError("resolve(" + entry + ") = " + got + ", expected " + want);
        }
    }

    private static boolean isExcludedTop(String top) {
        for (String bad : EXCLUDED_TOP) {
            if (bad.equals(top)) return true;
        }
        return false;
    }

    /** True when the archive literally contains that flat entry (documents the RAW slim layout). */
    private static boolean rawHas(File zip, String name) throws Exception {
        try (ZipFile zf = new ZipFile(zip)) {
            return zf.getEntry(name) != null;
        }
    }

    private static File locate(String[] args) {
        List<File> candidates = new ArrayList<>();
        if (args.length > 0) candidates.add(new File(args[0]));
        candidates.add(new File("../dl-cache/dist/content-slim-shell-v2.9.102.zip"));
        candidates.add(new File("C:/Users/16891/android-build/dl-cache/dist/content-slim-shell-v2.9.102.zip"));
        candidates.add(new File("../dl-cache/dist/content-slim-shell-v2.8.1.zip"));
        candidates.add(new File("C:/Users/16891/android-build/dl-cache/dist/content-slim-shell-v2.8.1.zip"));
        for (File f : candidates) {
            if (f.isFile()) return f;
        }
        throw new IllegalStateException("slim zip not found; tried " + candidates);
    }
}
