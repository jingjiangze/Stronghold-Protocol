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
 * One wrapper folder is peeled, and it is decided ONCE for the WHOLE archive by
 * {@link #detectWrapper} — the same structural rule as tools/apk/verify-slim.mjs: every entry shares
 * one first segment, stripping it leaves only root-shaped names, and no entry is root-shaped as it
 * stands. A per-entry heuristic cannot tell a wrapper from a genuine nested path: it rewrote
 * studio/index.html to the root index.html and studio/js/** to js/** (device served the studio page
 * as the game, 2026-10-19).
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
        return resolve(entryName, null);
    }

    /**
     * Archive entry name -> slim relative path, or null when the entry is outside the L1 set.
     * Backslashes and leading/trailing slashes are normalised; {@code wrapper} (detected once for
     * the WHOLE archive by {@link #detectWrapper}) is peeled; one leading public/ is folded. This is
     * a deny-list: a top-level entry that is not excluded is ACCEPTED as-is.
     *
     * <p>The wrapper peel used to be a per-entry heuristic ("peel one folder when the rest is
     * root-shaped"). That silently rewrote a genuine {@code studio/index.html} to the root
     * {@code index.html} and every {@code studio/js/**} to root {@code js/**} — the device served the
     * studio page as the game after a hot update (2026-10-19). Wrapper detection is now a property
     * of the archive, exactly like tools/apk/verify-slim.mjs.
     */
    public static String resolve(String entryName, String wrapper) {
        if (entryName == null) return null;
        String p = normalize(entryName);
        if (p == null) return null;                  // empty, or a "." / ".." traversal segment
        if (wrapper != null && !wrapper.isEmpty() && p.startsWith(wrapper + "/")) {
            p = p.substring(wrapper.length() + 1);
        }
        String folded = foldPublic(p);
        if (isExcluded(folded)) return null;         // dev/, assets/, stamp.txt, slim-manifest.txt
        return folded; // deny-list: a genuinely new top-level dir (wasm/engine.wasm) is kept
    }

    /**
     * The wrapper folder of an archive, or null — the same rule as tools/apk/verify-slim.mjs
     * {@code mapArchive()}: every entry shares one first segment, stripping it leaves only
     * non-empty root-shaped names, and no entry is root-shaped as it stands. A flat archive (what
     * make-bundle publishes) has several first segments and gets null.
     * @param entryNames every name in the archive (directories may end with "/")
     */
    public static String detectWrapper(Iterable<String> entryNames) {
        java.util.Set<String> firsts = new java.util.HashSet<>();
        java.util.List<String> files = new java.util.ArrayList<>();
        boolean anyRoot = false;
        for (String raw : entryNames) {
            if (raw == null || raw.endsWith("/") || raw.endsWith("\\")) continue; // directory entries: no path
            String p = normalize(raw);
            if (p == null) continue;
            files.add(p);
            int slash = p.indexOf('/');
            firsts.add(slash < 0 ? p : p.substring(0, slash));
            if (isRootShape(p)) anyRoot = true;
        }
        if (anyRoot || firsts.size() != 1 || files.isEmpty()) return null;
        String wrapper = firsts.iterator().next();
        boolean any = false;
        for (String p : files) {
            if (!p.startsWith(wrapper + "/")) return null;
            String inner = p.substring(wrapper.length() + 1);
            if (inner.isEmpty()) return null;
            if (!isRootShape(foldPublic(inner))) return null;
            any = true;
        }
        return any ? wrapper : null;
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
