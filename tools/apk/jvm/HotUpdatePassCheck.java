import icu.jiangjiangze.stronghold.SlimPaths;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Device-like measurement of the hot-update install path, runnable on a bare JVM (no Android).
 *
 * It replays, in the exact order Updater.hotUpdate() does, the per-file work of an install over the
 * REAL published slim, and times each phase so the "re-verify ~3000 items" cost can be attributed:
 *
 *   1. sha256 of the downloaded zip            (the ONE integrity check the signed manifest names)
 *   2. extractSlim                             (Updater.extractSlim: per-entry map + write)
 *   3. "extract + per-entry getCanonicalPath"  (today's traversal guard, called TWICE per entry)
 *   4. applyExtras                             (shell-ui/extras overlay: proportional to the overlay)
 *   5. a hypothetical per-file sha256 walk     (what a "tree verification" pass would cost)
 *   6. a stat-only walk + size compare         (HostService.materialiseContent's per-file skip)
 *
 * Usage: java -cp <classes> HotUpdatePassCheck [slim.zip]
 */
public final class HotUpdatePassCheck {

    public static void main(String[] args) throws Exception {
        File zip = locate(args);
        System.out.println("slim zip: " + zip.getPath() + "  (" + (zip.length() / 1024 / 1024) + " MB)");

        File work = Files.createTempDirectory("sp-hotupdate").toFile();
        work.deleteOnExit();

        // ---- phase 1: the zip sha256 (the ONLY integrity check the hot update needs) ----
        long t0 = System.nanoTime();
        String sha = sha256(zip);
        long tSha = ms(t0);
        System.out.printf("1) zip sha256           : %6d ms  (%s)%n", tSha, sha.substring(0, 12));

        // ---- phase 2: extract with the CURRENT per-entry getCanonicalPath guard ----
        File stagingA = new File(work, "stagingA");
        long tA0 = System.nanoTime();
        int[] a = extract(zip, stagingA, true);
        long tA = ms(tA0);
        System.out.printf("2) extractSlim (as-is)  : %6d ms  files=%d  entries=%d%n", tA, a[0], a[1]);

        // ---- phase 2b: ISOLATED cost of the per-entry canonical verification (no writes) ----
        long tG0 = System.nanoTime();
        int guarded = canonicalGuardOnly(zip, stagingA);
        long tG = ms(tG0);
        System.out.printf("2b) canonical guard only: %6d ms  checks=%d (per-file FS verification)%n", tG, guarded);

        // ---- phase 3: extract with the canonical path computed ONCE (staging root only) ----
        File stagingB = new File(work, "stagingB");
        long tB0 = System.nanoTime();
        int[] b = extract(zip, stagingB, false);
        long tB = ms(tB0);
        System.out.printf("3) extractSlim (canon 1): %6d ms  files=%d  entries=%d%n", tB, b[0], b[1]);

        // ---- phase 3b: extract with the per-entry canonical verification REMOVED (lexical) ----
        File stagingB2 = new File(work, "stagingB2");
        long tB2 = System.nanoTime();
        int[] b2 = extractLexical(zip, stagingB2);
        long tB2ms = ms(tB2);
        System.out.printf("3b) extractSlim (lexical): %6d ms  files=%d  entries=%d%n", tB2ms, b2[0], b2[1]);

        // ---- phase 4: overlay replay (extras) ----
        File extras = new File("android/app/src/main/assets/shell/extras");
        File stagingC = new File(work, "stagingC");
        extract(zip, stagingC, false);
        long tC0 = System.nanoTime();
        int copied = 0;
        copied += copyTree(new File(extras, "public"), stagingC);
        copied += copyTree(new File(extras, "server"), new File(stagingC, "server"));
        long tC = ms(tC0);
        System.out.printf("4) applyExtras overlay  : %6d ms  files=%d (overlay-sized)%n", tC, copied);

        // ---- phase 5: a hypothetical per-file sha256 verification of the tree (opt-in: slow) ----
        if (hasArg(args, "--hash-walk")) {
            long tD0 = System.nanoTime();
            long[] d = hashWalk(stagingA);
            long tD = ms(tD0);
            System.out.printf("5) per-file sha256 walk : %6d ms  files=%d  bytes=%d (HYPOTHETICAL)%n", tD, d[0], d[1]);
        } else {
            System.out.println("5) per-file sha256 walk : skipped (pass --hash-walk to measure)");
        }

        // ---- phase 6: stat-only walk + size compare (materialise per-file skip) ----
        long tE0 = System.nanoTime();
        int[] e = statWalk(stagingA, stagingA);
        long tE = ms(tE0);
        System.out.printf("6) stat walk + size gate: %6d ms  files=%d  matched=%d%n", tE, e[0], e[1]);

        System.out.println();
        System.out.println("touched files: extract=" + a[0] + ", overlay=" + copied);
        System.out.println("HotUpdatePassCheck OK");
    }

    /** Updater.extractSlim: map every entry via SlimPaths, write the L1 tree. perEntryCanon=true
     *  reproduces today's guard (out.getCanonicalPath() + staging.getCanonicalPath() per entry). */
    private static int[] extract(File zip, File staging, boolean perEntryCanon) throws Exception {
        int files = 0, entries = 0;
        String stagingCanon = null;
        if (!perEntryCanon) {
            stagingCanon = staging.getCanonicalPath() + File.separator;
        }
        byte[] buf = new byte[128 * 1024];
        try (ZipFile zf = new ZipFile(zip)) {
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry ze = en.nextElement();
                entries++;
                String rel = SlimPaths.resolve(ze.getName());
                if (rel == null) continue;
                File out = new File(staging, rel);
                if (perEntryCanon) {
                    if (!out.getCanonicalPath().startsWith(staging.getCanonicalPath() + File.separator)) continue;
                } else {
                    if (!out.getCanonicalPath().startsWith(stagingCanon)) continue;
                }
                if (ze.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
                    throw new java.io.IOException("mkdirs failed: " + parent);
                }
                try (InputStream in = zf.getInputStream(ze); OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                }
                files++;
            }
        }
        return new int[] { files, entries };
    }

    /** ISOLATED: run ONLY the removed per-entry guard (getCanonicalPath twice per entry, no I/O). */
    private static int canonicalGuardOnly(File zip, File staging) throws Exception {
        int checks = 0;
        try (ZipFile zf = new ZipFile(zip)) {
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry ze = en.nextElement();
                String rel = SlimPaths.resolve(ze.getName());
                if (rel == null) continue;
                File out = new File(staging, rel);
                // exactly what the old extractSlim line did, per entry:
                if (!out.getCanonicalPath().startsWith(staging.getCanonicalPath() + File.separator)) continue;
                checks++;
            }
        }
        return checks;
    }

    /** Updater.extractSlim after the fix: no per-entry filesystem verification, lexical guard only. */
    private static int[] extractLexical(File zip, File staging) throws Exception {
        int files = 0, entries = 0;
        byte[] buf = new byte[128 * 1024];
        try (ZipFile zf = new ZipFile(zip)) {
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry ze = en.nextElement();
                entries++;
                String rel = SlimPaths.resolve(ze.getName());
                if (rel == null || !SlimPaths.isSafeRel(rel)) continue;
                File out = new File(staging, rel);
                if (ze.isDirectory()) { out.mkdirs(); continue; }
                File parent = out.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
                    throw new java.io.IOException("mkdirs failed: " + parent);
                }
                try (InputStream in = zf.getInputStream(ze); OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                }
                files++;
            }
        }
        return new int[] { files, entries };
    }

    private static int copyTree(File from, File to) throws Exception {
        if (!from.isDirectory()) return 0;
        File[] kids = from.listFiles();
        if (kids == null) return 0;
        int n = 0;
        for (File k : kids) {
            File dst = new File(to, k.getName());
            if (k.isDirectory()) n += copyTree(k, dst);
            else {
                File parent = dst.getParentFile();
                if (parent != null) parent.mkdirs();
                Files.copy(k.toPath(), dst.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                n++;
            }
        }
        return n;
    }

    /** A full per-file content verification: read every file and SHA-256 it. */
    private static long[] hashWalk(File dir) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        List<File> files = new ArrayList<>();
        collect(dir, files);
        long bytes = 0;
        byte[] buf = new byte[128 * 1024];
        for (File f : files) {
            try (InputStream in = new FileInputStream(f)) {
                int n;
                while ((n = in.read(buf)) > 0) { md.update(buf, 0, n); bytes += n; }
            }
        }
        md.digest();
        return new long[] { files.size(), bytes };
    }

    /** A stat-only walk with a size compare against the source tree (materialise's skip gate). */
    private static int[] statWalk(File root, File srcRoot) {
        List<File> files = new ArrayList<>();
        collect(root, files);
        int matched = 0;
        for (File f : files) {
            File src = new File(srcRoot, root.toPath().relativize(f.toPath()).toString());
            if (f.isFile() && src.isFile() && f.length() == src.length()) matched++;
        }
        return new int[] { files.size(), matched };
    }

    private static void collect(File dir, List<File> out) {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            if (k.isDirectory()) collect(k, out);
            else out.add(k);
        }
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[128 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte x : md.digest()) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    private static long ms(long nano) { return (System.nanoTime() - nano) / 1_000_000L; }

    private static boolean hasArg(String[] args, String flag) {
        for (String a : args) if (flag.equals(a)) return true;
        return false;
    }

    private static File locate(String[] args) {
        List<File> c = new ArrayList<>();
        for (String a : args) if (!a.startsWith("--")) { c.add(new File(a)); break; }
        c.add(new File("C:/Users/16891/android-build/dl-cache/dist/content-slim-shell-v2.9.111.zip"));
        c.add(new File("C:/Users/16891/android-build/dl-cache/dist/content-slim-shell-v2.9.109.zip"));
        c.add(new File("../dl-cache/dist/content-slim-shell-v2.9.111.zip"));
        for (File f : c) if (f.isFile()) return f;
        throw new IllegalStateException("slim zip not found; tried " + c);
    }
}
