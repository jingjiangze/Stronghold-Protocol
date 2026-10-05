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
 * shared/constants.js, index.html) and never leaks L2 art (assets/...). This is the exact P0-1
 * regression that made every hot update fail ("incomplete content pack, no server"): js/main.js was
 * stripped to main.js and dropped.
 *
 * Build & run (JDK 17, no Android SDK needed):
 *   javac -d /tmp/spjvm-slim \
 *     android/app/src/main/java/icu/jiangjiangze/stronghold/SlimPaths.java \
 *     tools/apk/jvm/SlimExtractCheck.java
 *   java -cp /tmp/spjvm-slim SlimExtractCheck [path/to/content-slim-shell-v2.8.1.zip]
 *
 * Run from the repository root, or pass the zip path explicitly.
 */
public final class SlimExtractCheck {

    private static final String[] REQUIRED = {
            "server/index.js", "js/main.js", "shared/constants.js", "index.html"};

    public static void main(String[] args) throws Exception {
        File zip = locate(args);
        System.out.println("slim zip: " + zip.getPath() + " (" + zip.length() + " bytes)");

        TreeSet<String> resolved = new TreeSet<>();
        List<String> assetLeaks = new ArrayList<>();
        int entries = 0;
        int mapped = 0;
        try (ZipFile zf = new ZipFile(zip)) {
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                entries++;
                String rel = SlimPaths.resolve(e.getName());
                if (rel == null) continue;
                mapped++;
                if (rel.startsWith("assets/") || rel.equals("assets")) assetLeaks.add(rel);
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
        if (!assetLeaks.isEmpty()) {
            throw new AssertionError("L2 assets leaked into the slim set: " + assetLeaks
                    + " (" + assetLeaks.size() + " entries)");
        }
        if (mapped < 100) {
            throw new AssertionError("only " + mapped + " entries mapped of " + entries
                    + " -- resolver looks broken");
        }

        System.out.println("entries: " + entries + ", mapped: " + mapped
                + ", distinct slim paths: " + resolved.size());
        System.out.println("no assets/ entries in the resolved set");
        System.out.println("SlimExtractCheck OK");
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
        candidates.add(new File("../dl-cache/dist/content-slim-shell-v2.8.1.zip"));
        candidates.add(new File("C:/Users/16891/android-build/dl-cache/dist/content-slim-shell-v2.8.1.zip"));
        for (File f : candidates) {
            if (f.isFile()) return f;
        }
        throw new IllegalStateException("slim zip not found; tried " + candidates);
    }
}
