import icu.jiangjiangze.stronghold.ArtStore;
import icu.jiangjiangze.stronghold.Updater;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * JVM self-test for the art-pack store (P0 素材热更), runnable with a bare JDK 17 — no Android SDK,
 * no emulator, no device. Covers the whole install loop against a temp artRoot with a stub Fetcher
 * that serves locally built pack zips:
 *
 *   install → open() returns the new bytes;  sha mismatch → rejected, old pack intact;
 *   repack with a second file → atomic replace;  non-assets entry → whole pack rejected;
 *   `../` traversal entry → rejected;  recordedVersion round-trip (+ no downgrade);
 *   optional pack failure ignored;  open() miss → null (never throws).
 *
 * FIXTURES: the legitimate packs are built by the SHIPPING tool (make-art-packs.mjs) so the test
 * exercises the exact bytes that will be published; if node/the script are unavailable the test
 * falls back to its own ZipOutputStream writer. The malformed packs (bad entries) MUST be raw —
 * make-art-packs refuses to build them by design — so those are always written in-test.
 *
 * Build & run (JDK 17; run from the repository root; Windows paths shown for this machine):
 *   "C:/Users/16891/android-build/jdk-extracted/jdk-17.0.20.1+1/bin/javac" -d /tmp/artstore-jvm \
 *     tools/apk/jvm/stub/icu/jiangjiangze/stronghold/Updater.java \
 *     android/app/src/main/java/icu/jiangjiangze/stronghold/ArtStore.java \
 *     tools/apk/jvm/ArtStoreSelfTest.java
 *   "C:/Users/16891/android-build/jdk-extracted/jdk-17.0.20.1+1/bin/java" -cp /tmp/artstore-jvm ArtStoreSelfTest
 *
 * The same pack fixture can be rebuilt by hand (also documented for the device recipe):
 *   node tools/apk/make-art-packs.mjs --webroot <dir> --art-version 1 \
 *        --out <tmp>/art-packs.json --packs-dir <tmp>/packs
 */
public final class ArtStoreSelfTest {

    private static int checks = 0;

    public static void main(String[] args) throws Exception {
        File root = Files.createTempDirectory("artstore-jvm-").toFile();
        try {
            testInstallAndOpen(root);
            testShaMismatchKeepsOldPack(root);
            testRepackReplacesAtomically(root);
            testNonAssetsEntryRejected(root);
            testTraversalEntryRejected(root);
            testVersionRoundTripAndNoDowngrade(root);
            testOptionalFailureIgnored(root);
            testOpenMissAndSafety(root);
            System.out.println("ArtStoreSelfTest OK: " + checks + " checks passed");
        } finally {
            rm(root);
        }
    }

    // ------------------------------------------------------------------
    // cases
    // ------------------------------------------------------------------

    /** install → the new bytes are served through open(); marker/art.json agree. */
    private static void testInstallAndOpen(File root) throws Exception {
        File artRoot = new File(root, "case-install");
        byte[] img = "WEBP-v1".getBytes(StandardCharsets.UTF_8);
        File zip = fixturePack(root, "install", 1, new String[][] { { "assets/ui/a.webp" } }, new byte[][] { img });
        List<ArtStore.Pack> packs = new ArrayList<>();
        packs.add(pack("core.ui", zip));

        StubFetcher fetcher = new StubFetcher();
        fetcher.serve(packs.get(0).urls.get(0), zip);
        int failed = ArtStore.sync(artRoot, 1, packs, fetcher, Updater.NOOP);
        eqInt("install: no failures", 0, failed);
        eqInt("install: recorded version", 1, ArtStore.recordedVersion(artRoot));
        check("install: installedAt true", ArtStore.installedAt(artRoot, packs.get(0)));
        eq("install: open serves the new bytes", "WEBP-v1", readAll(ArtStore.open(artRoot, "/assets/ui/a.webp")));
        eq("install: open also resolves without the leading slash", "WEBP-v1",
                readAll(ArtStore.open(artRoot, "assets/ui/a.webp")));
        check("install: marker exists", new File(ArtStore.packDir(artRoot, "core.ui"), "sha256.txt").isFile());
        check("install: part file released", !new File(new File(artRoot, "parts"), "core.ui.part").exists());
        check("install: no staging left", !new File(ArtStore.packsDir(artRoot), "core.ui.tmp").exists());
    }

    /** A pack whose zip does not hash to pack.sha256 is never unpacked; the installed one survives. */
    private static void testShaMismatchKeepsOldPack(File root) throws Exception {
        File artRoot = new File(root, "case-sha");
        File oldZip = fixturePack(root, "sha-old", 1, new String[][] { { "assets/ui/a.webp" } },
                new byte[][] { "OLD".getBytes(StandardCharsets.UTF_8) });
        ArtStore.Pack v1 = pack("core.ui", oldZip);
        StubFetcher f1 = new StubFetcher();
        f1.serve(v1.urls.get(0), oldZip);
        eqInt("sha: v1 installs", 0, ArtStore.sync(artRoot, 1, list(v1), f1, Updater.NOOP));

        File tampered = fixturePack(root, "sha-new", 2, new String[][] { { "assets/ui/a.webp" } },
                new byte[][] { "TAMPERED".getBytes(StandardCharsets.UTF_8) });
        File decoy = fixturePack(root, "sha-other", 2, new String[][] { { "assets/ui/a.webp" } },
                new byte[][] { "SOMETHING-ELSE".getBytes(StandardCharsets.UTF_8) });
        ArtStore.Pack v2 = pack("core.ui", tampered);
        v2.sha256 = sha256(decoy); // signed hash describes OTHER bytes -> the delivered zip must be refused
        StubFetcher f2 = new StubFetcher();
        f2.serve(v2.urls.get(0), tampered);
        int failed = ArtStore.sync(artRoot, 2, list(v2), f2, Updater.NOOP);
        eqInt("sha: mismatch counts as a required failure", 1, failed);
        eq("sha: old pack still served", "OLD", readAll(ArtStore.open(artRoot, "assets/ui/a.webp")));
        eqInt("sha: version not advanced", 1, ArtStore.recordedVersion(artRoot));
        check("sha: partial download removed", !new File(new File(artRoot, "parts"), "core.ui.part").exists());
        check("sha: staging removed", !new File(ArtStore.packsDir(artRoot), "core.ui.tmp").exists());
    }

    /** A newer pack with an extra file replaces the old one (delete + rename, no leftovers). */
    private static void testRepackReplacesAtomically(File root) throws Exception {
        File artRoot = new File(root, "case-repack");
        File zip1 = fixturePack(root, "repack-1", 1, new String[][] { { "assets/ui/a.webp" } },
                new byte[][] { "ONE".getBytes(StandardCharsets.UTF_8) });
        ArtStore.Pack p1 = pack("core.ui", zip1);
        StubFetcher f1 = new StubFetcher();
        f1.serve(p1.urls.get(0), zip1);
        ArtStore.sync(artRoot, 1, list(p1), f1, Updater.NOOP);

        File zip2 = fixturePack(root, "repack-2", 2,
                new String[][] { { "assets/ui/a.webp" }, { "assets/ui/sub/b.webp" } },
                new byte[][] { "TWO-A".getBytes(StandardCharsets.UTF_8), "TWO-B".getBytes(StandardCharsets.UTF_8) });
        ArtStore.Pack p2 = pack("core.ui", zip2);
        StubFetcher f2 = new StubFetcher();
        f2.serve(p2.urls.get(0), zip2);
        eqInt("repack: installs", 0, ArtStore.sync(artRoot, 2, list(p2), f2, Updater.NOOP));
        eq("repack: replaced file", "TWO-A", readAll(ArtStore.open(artRoot, "assets/ui/a.webp")));
        eq("repack: added file", "TWO-B", readAll(ArtStore.open(artRoot, "assets/ui/sub/b.webp")));
        eqInt("repack: version advanced", 2, ArtStore.recordedVersion(artRoot));
        check("repack: old marker replaced", ArtStore.installedAt(artRoot, p2));
        check("repack: skipped on second sync", ArtStore.sync(artRoot, 2, list(p2), new StubFetcher(), Updater.NOOP) == 0);
    }

    /** 素材包只允许 assets/**：js/ 或 index.html 条目 → 整包拒绝。 */
    private static void testNonAssetsEntryRejected(File root) throws Exception {
        File artRoot = new File(root, "case-policy");
        File zip = rawZip(root, "policy", new String[][] {
                { "assets/ui/a.webp", "IMG" }, { "js/main.js", "EVIL" } });
        ArtStore.Pack p = pack("core.ui", zip);
        StubFetcher f = new StubFetcher();
        f.serve(p.urls.get(0), zip);
        int failed = ArtStore.sync(artRoot, 1, list(p), f, Updater.NOOP);
        eqInt("policy: pack rejected", 1, failed);
        check("policy: nothing installed", !ArtStore.installedAt(artRoot, p));
        isNull("policy: no file served", ArtStore.open(artRoot, "assets/ui/a.webp"));
        check("policy: staging removed", !new File(ArtStore.packsDir(artRoot), "core.ui.tmp").exists());

        File zip2 = rawZip(root, "policy-html", new String[][] { { "index.html", "<html>" } });
        ArtStore.Pack p2 = pack("core.ui", zip2);
        StubFetcher f2 = new StubFetcher();
        f2.serve(p2.urls.get(0), zip2);
        eqInt("policy: index.html rejected too", 1, ArtStore.sync(artRoot, 1, list(p2), f2, Updater.NOOP));
    }

    /** `../` 条目 → 整包拒绝（zip-slip 守卫 + 名字规范化）。 */
    private static void testTraversalEntryRejected(File root) throws Exception {
        File artRoot = new File(root, "case-traversal");
        File zip = rawZip(root, "traversal", new String[][] {
                { "assets/ui/a.webp", "IMG" }, { "../escape.webp", "EVIL" } });
        ArtStore.Pack p = pack("core.ui", zip);
        StubFetcher f = new StubFetcher();
        f.serve(p.urls.get(0), zip);
        eqInt("traversal: pack rejected", 1, ArtStore.sync(artRoot, 1, list(p), f, Updater.NOOP));
        check("traversal: no file escaped", !new File(artRoot, "escape.webp").exists()
                && !new File(root, "escape.webp").exists());
        isNull("traversal: nothing installed", ArtStore.open(artRoot, "assets/ui/a.webp"));
    }

    /** recordedVersion round-trip; a LOWER art version never rolls the index back. */
    private static void testVersionRoundTripAndNoDowngrade(File root) throws Exception {
        File artRoot = new File(root, "case-version");
        File zip = fixturePack(root, "version", 5, new String[][] { { "assets/ui/a.webp" } },
                new byte[][] { "V5".getBytes(StandardCharsets.UTF_8) });
        ArtStore.Pack p5 = pack("core.ui", zip);
        StubFetcher f = new StubFetcher();
        f.serve(p5.urls.get(0), zip);
        eqInt("version: round-trip", 0, ArtStore.syncAt(artRoot, 5, list(p5), f, Updater.NOOP));
        eqInt("version: recorded", 5, ArtStore.recordedVersion(artRoot));
        eqInt("version: downgrade attempt installs nothing", 0,
                ArtStore.sync(artRoot, 3, list(p5), new StubFetcher(), Updater.NOOP));
        eqInt("version: never rolls back", 5, ArtStore.recordedVersion(artRoot));
    }

    /** 可选包失败不进失败计数、不阻断版本推进（voice:* 这类允许整包跳过）。 */
    private static void testOptionalFailureIgnored(File root) throws Exception {
        File artRoot = new File(root, "case-optional");
        File zip = fixturePack(root, "optional", 7, new String[][] { { "assets/ui/a.webp" } },
                new byte[][] { "IMG".getBytes(StandardCharsets.UTF_8) });
        ArtStore.Pack p = pack("voice:char_x", zip);
        p.optional = true;
        p.sha256 = "0".repeat(64); // wrong hash -> download "succeeds", verification must fail
        StubFetcher f = new StubFetcher();
        f.serve(p.urls.get(0), zip);
        eqInt("optional: failure ignored", 0, ArtStore.sync(artRoot, 7, list(p), f, Updater.NOOP));
        eqInt("optional: version still advances", 7, ArtStore.recordedVersion(artRoot));
        check("optional: pack not installed", !ArtStore.installedAt(artRoot, p));
        check("optional: failure logged", new File(artRoot, "art.log").isFile());
    }

    /** open(): 缺失路径/坏路径/不存在的 artRoot 一律 null，绝不抛。 */
    private static void testOpenMissAndSafety(File root) throws Exception {
        File artRoot = new File(root, "case-miss");
        isNull("miss: no artRoot", ArtStore.open(artRoot, "assets/ui/a.webp"));
        File zip = fixturePack(root, "miss", 1, new String[][] { { "assets/ui/a.webp" } },
                new byte[][] { "IMG".getBytes(StandardCharsets.UTF_8) });
        ArtStore.Pack p = pack("core.ui", zip);
        StubFetcher f = new StubFetcher();
        f.serve(p.urls.get(0), zip);
        ArtStore.sync(artRoot, 1, list(p), f, Updater.NOOP);
        isNull("miss: missing file", ArtStore.open(artRoot, "assets/ui/nope.webp"));
        isNull("miss: traversal path", ArtStore.open(artRoot, "assets/ui/../../etc/passwd"));
        isNull("miss: outside assets/", ArtStore.open(artRoot, "js/main.js"));
        isNull("miss: null path", ArtStore.open(artRoot, null));
        isNull("miss: directory path", ArtStore.open(artRoot, "assets/ui/"));
    }

    // ------------------------------------------------------------------
    // fixtures / helpers
    // ------------------------------------------------------------------

    private static ArtStore.Pack pack(String id, File zip) throws IOException {
        ArtStore.Pack p = new ArtStore.Pack();
        p.id = id;
        p.sha256 = sha256(zip);
        p.size = zip.length();
        p.urls = new ArrayList<>();
        p.urls.add("https://weishucdn.jiangjiangze.icu/assets/packs/" + id + ".zip");
        p.optional = false;
        return p;
    }

    private static List<ArtStore.Pack> list(ArtStore.Pack p) {
        List<ArtStore.Pack> l = new ArrayList<>();
        l.add(p);
        return l;
    }

    /** 合法夹具：优先用出货工具 make-art-packs.mjs 打包（测试的字节 == 将来发布的字节）。 */
    private static File fixturePack(File root, String tag, int artVersion, String[][] entries, byte[][] data)
            throws Exception {
        File webroot = new File(root, "webroot-" + tag);
        for (int i = 0; i < entries.length; i++) {
            writeFile(new File(webroot, entries[i][0]), data[i]);
        }
        File packsDir = new File(root, "packs-" + tag);
        File viaNode = packWithNode(webroot, packsDir, artVersion);
        if (viaNode != null && viaNode.isFile()) return viaNode;
        System.out.println("  (node/make-art-packs unavailable — in-test zip writer used for " + tag + ")");
        File out = new File(packsDir, "core.ui-" + artVersion + ".zip");
        writeFile(out, rawZipBytes(entries, data));
        return out;
    }

    private static File packWithNode(File webroot, File packsDir, int artVersion) {
        String node = System.getenv("SP_NODE") != null ? System.getenv("SP_NODE") : "node";
        File script = new File("tools/apk/make-art-packs.mjs");
        if (!script.isFile()) return null; // not run from the repo root
        try {
            Process p = new ProcessBuilder(node, script.getPath(), "--webroot", webroot.getPath(),
                    "--art-version", String.valueOf(artVersion),
                    "--out", new File(packsDir, "art-packs.json").getPath(),
                    "--packs-dir", packsDir.getPath())
                    .redirectErrorStream(true).start();
            String out = readAll(p.getInputStream());
            int code = p.waitFor();
            if (code != 0) {
                System.out.println("  (make-art-packs exited " + code + ": " + out.trim() + ")");
                return null;
            }
            return new File(packsDir, "core.ui-" + artVersion + ".zip");
        } catch (Exception e) {
            return null;
        }
    }

    /** 非法夹具：make-art-packs 按设计会拒绝这些 zip，只能在测试里手写。 */
    private static File rawZip(File root, String tag, String[][] entries) throws IOException {
        File dir = new File(root, "raw-" + tag);
        File out = new File(dir, tag + ".zip");
        writeFile(out, rawZipBytes(entries, null));
        return out;
    }

    private static byte[] rawZipBytes(String[][] entries, byte[][] data) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(bos)) {
            for (int i = 0; i < entries.length; i++) {
                ZipEntry e = new ZipEntry(entries[i][0]);
                e.setTime(315532800000L); // 1980-01-01, fixed
                zos.putNextEntry(e);
                byte[] bytes = data != null ? data[i] : entries[i][1].getBytes(StandardCharsets.UTF_8);
                zos.write(bytes);
                zos.closeEntry();
            }
        }
        return bos.toByteArray();
    }

    /** 本地"服务器"：URL → 文件字节，写入 Fetcher 的 dst（等价于 downloadOne 的第 0 次续传）。 */
    private static final class StubFetcher implements ArtStore.Fetcher {
        private final Map<String, byte[]> files = new HashMap<>();

        void serve(String url, File file) throws IOException {
            files.put(url, Files.readAllBytes(file.toPath()));
        }

        @Override
        public long fetch(String url, File dst, Updater.Progress p) throws IOException {
            byte[] bytes = files.get(url);
            if (bytes == null) throw new IOException("stub: no route for " + url);
            File parent = dst.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
                throw new IOException("stub: mkdirs failed");
            }
            try (FileOutputStream out = new FileOutputStream(dst)) {
                out.write(bytes);
            }
            if (p != null) p.onProgress(bytes.length, bytes.length);
            return bytes.length;
        }
    }

    private static void writeFile(File f, byte[] data) throws IOException {
        File parent = f.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IOException("mkdirs failed: " + parent);
        }
        Files.write(f.toPath(), data);
    }

    private static String sha256(File f) throws IOException {
        return Updater.sha256(f);
    }

    private static String readAll(InputStream in) throws IOException {
        if (in == null) return null;
        try (InputStream close = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = close.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    private static void rm(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) rm(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static void eqInt(String what, int expected, int actual) {
        checks++;
        if (expected != actual) {
            throw new AssertionError(what + ": expected " + expected + " but was " + actual);
        }
    }

    private static void eq(String what, String expected, String actual) {
        checks++;
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(what + ": expected " + expected + " but was " + actual);
        }
    }

    private static void isNull(String what, Object actual) {
        checks++;
        if (actual != null) throw new AssertionError(what + ": expected null but was non-null");
    }

    private static void check(String what, boolean cond) {
        checks++;
        if (!cond) throw new AssertionError(what);
    }
}
