package icu.jiangjiangze.stronghold;

/**
 * Pure archive-path mapper for the on-device hot update (no Android dependencies).
 *
 * L1 membership is a DENY-LIST here, mirroring tools/apk/slim-top.mjs (the single source of truth
 * for the slim's top-level set): every top-level entry rides the bundle except the content
 * exclusions below. A fixed allow-list used to live here and silently DROPPED any top-level entry
 * it did not name -- upstream's i18n/ was already being lost that way, and any future dir
 * (wasm/, workers/, packs/ ...) would vanish after one hot update, because the device swaps the
 * WHOLE webroot tree with the staging dir (2026-10-08 upstream-conflict audit, sec 6.2 / R-04).
 * verify-slim.mjs parses the three arrays below and warns when they drift from slim-top.mjs's
 * exports.
 *
 * Archive layouts tolerated (make-bundle publishes FLAT zips; the rest are legacy shapes):
 *   flat             js/main.js                          -> js/main.js
 *   wrapper          Stronghold-Protocol-0.1.1/js/main.js -> js/main.js
 *   public/ layout   public/js/main.js                   -> js/main.js
 *   wrapper+public   Stronghold-Protocol-0.1.1/public/js/main.js -> js/main.js
 * One wrapper folder is peeled ONLY when the peeled path is root-shaped (ROOT_ANCHORS), using the
 * JS's exact structural rule:
 *   isRootShape(p) = ROOT_ANCHORS.some(a -> p.equals(a) || p.startsWith(a))
 * A per-entry function cannot tell a wrapper from a genuine nested path, so a novel top-level dir
 * inside a wrapper keeps the prefix (Legacy/wasm/engine.wasm stays as-is) -- the real slim is flat,
 * and verify-slim.mjs does the whole-archive wrapper detection for the gate.
 *
 * Traversal guard (audit R-04 hardening): an entry whose path contains a "." or ".." segment, or
 * that normalises to empty, is rejected outright. The old allow-list rejected such names only
 * incidentally (nothing matched); now it is explicit.
 */
public final class SlimPaths {

    /** Content never carried by the slim: dev tooling and the L2 art tree (CDN / APK-local only).
     *  Mirrors SLIM_EXCLUDE_DIRS in tools/apk/slim-top.mjs; verify-slim.mjs cross-checks the pair. */
    public static final String[] SLIM_EXCLUDE_DIRS = {"dev", "assets"};

    /** Build artifacts the slim must never carry: they are produced per build, and a
     *  self-referential stamp.txt would change the content stamp on every run.
     *  Mirrors SLIM_EXCLUDE_FILES in tools/apk/slim-top.mjs. */
    public static final String[] SLIM_EXCLUDE_FILES = {"stamp.txt", "slim-manifest.txt"};

    /** Paths that only ever exist at the ROOT of a slim tree -- tells a wrapper folder from a
     *  genuine (possibly new) top-level directory without a whitelist. Mirrors ROOT_ANCHORS in
     *  tools/apk/slim-top.mjs exactly, including its looseness (a plain startsWith, not a segment
     *  match: "index.html.bak" counts as root-shaped). */
    public static final String[] ROOT_ANCHORS = {
            "index.html", "js/", "server/", "shared/", "data/", "css/", "vendor/", "fonts/",
            "data.js", "package.json"};

    private SlimPaths() {}

    /**
     * Archive entry name -> slim relative path, or null when the entry is outside the L1 set.
     * Backslashes and leading/trailing slashes are normalised; one leading public/ is folded; a
     * single wrapper folder is tolerated when peeling it yields a root-shaped path. This is a
     * deny-list: a top-level entry that is not excluded is ACCEPTED as-is, even if nobody has ever
     * seen it (audit R-04 -- dropping it here would lose it from the on-device tree forever).
     */
    public static String resolve(String entryName) {
        if (entryName == null) return null;
        String p = normalize(entryName);
        if (p == null) return null;                  // empty, or a "." / ".." traversal segment
        String folded = foldPublic(p);
        if (isExcluded(folded)) return null;         // dev/, assets/, stamp.txt, slim-manifest.txt
        if (isRootShape(folded)) return folded;
        int slash = folded.indexOf('/');
        if (slash > 0) {
            String inner = folded.substring(slash + 1);
            String foldedInner = foldPublic(inner);
            if (isRootShape(foldedInner)) return foldedInner; // wrapper: exactly one folder peeled
            // A wrapped upstream public/ layout (W/public/assets/x.png) is still a public/ layout,
            // so its exclusions apply to the peeled candidate too; without this the L2 art tree
            // would land in the device tree under the wrapper's name. (W/dev/x is left alone:
            // exclusions are TOP-LEVEL only, and a nested dev/ inside a new dir must survive.)
            if (inner.startsWith("public/") && isExcluded(foldedInner)) return null;
        }
        return folded; // deny-list: a genuinely new top-level dir (wasm/engine.wasm) is kept
    }

    /** Backslashes -> slashes, strip leading/trailing slashes, reject empty and "."/".." segments. */
    private static String normalize(String raw) {
        String p = raw.replace('\\', '/');
        while (p.startsWith("/")) p = p.substring(1);
        while (p.endsWith("/")) p = p.substring(0, p.length() - 1);
        if (p.isEmpty()) return null;
        int from = 0;
        while (true) {
            int i = p.indexOf('/', from);
            String seg = i < 0 ? p.substring(from) : p.substring(from, i);
            if (seg.isEmpty() || seg.equals(".") || seg.equals("..")) return null;
            if (i < 0) return p;
            from = i + 1;
        }
    }

    /** Strip ONE leading "public/" (upstream public/ layout; tried on the wrapper candidate too). */
    private static String foldPublic(String p) {
        return p.startsWith("public/") ? p.substring("public/".length()) : p;
    }

    /** Mirrors isSlimExcluded() in slim-top.mjs: exclusions apply to the TOP level only, and the
     *  build-artifact names only as whole top-level entries. */
    private static boolean isExcluded(String p) {
        if (p == null || p.isEmpty()) return true;
        int slash = p.indexOf('/');
        String top = slash < 0 ? p : p.substring(0, slash);
        for (String dir : SLIM_EXCLUDE_DIRS) {
            if (dir.equals(top)) return true;
        }
        if (slash < 0) {
            for (String file : SLIM_EXCLUDE_FILES) {
                if (file.equals(p)) return true;
            }
        }
        return false;
    }

    /** Mirrors isRootShape() in verify-slim.mjs exactly:
     *  ROOT_ANCHORS.some(a -> p == a || p.startsWith(a)). */
    private static boolean isRootShape(String p) {
        for (String anchor : ROOT_ANCHORS) {
            if (p.equals(anchor) || p.startsWith(anchor)) return true;
        }
        return false;
    }

    /**
     * Zero-I/O lexical guard for an ALREADY-RESOLVED slim path: a plain relative path with no
     * empty / "." / ".." segment and no ":" (drive-letter / scheme / UNC trick). This is the
     * traversal check the device hot-update extraction uses INSTEAD of a per-entry
     * {@code getCanonicalPath()} walk (which cost ~2/3 of the whole install; see Updater.extractSlim).
     * {@link #resolve} already rejects those segments for archive entries, so this is a cheap
     * belt-and-suspenders that keeps the property true for any caller — never a filesystem call.
     */
    public static boolean isSafeRel(String rel) {
        if (rel == null || rel.isEmpty() || rel.startsWith("/") || rel.endsWith("/")) return false;
        for (String seg : rel.split("/", -1)) {
            if (seg.isEmpty() || seg.equals(".") || seg.equals("..") || seg.indexOf(':') >= 0) return false;
        }
        return true;
    }
}
