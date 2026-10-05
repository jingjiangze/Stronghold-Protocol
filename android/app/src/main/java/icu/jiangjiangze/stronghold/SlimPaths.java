package icu.jiangjiangze.stronghold;

/**
 * Pure archive-path mapper for the on-device hot update (no Android dependencies).
 *
 * The RAW slim bundles make-bundle.mjs publishes are FLAT (index.html, data.js, js/main.js,
 * server/index.js ...), but a bundle may also carry one wrapper folder
 * (Stronghold-Protocol-0.1.1/js/main.js) or arrive with the upstream public/ layout. resolve()
 * therefore tries the entry as-is first and only then retries with ONE leading segment stripped.
 * The old handler stripped the first segment unconditionally, which turned js/main.js into
 * main.js, dropped every nested file and made hotUpdate() fail its server/index.js completeness
 * check 100% of the time.
 */
public final class SlimPaths {

    /** The L1 (slim) set the on-device hot update materialises -- mirrors build-webroot's SLIM_TOP. */
    public static final String[] SLIM_TOP = {
            "index.html", "data.js", "js", "css", "vendor", "fonts", "shared", "sim", "data",
            "server", "package.json", "node_modules"};

    private SlimPaths() {}

    /**
     * Archive entry name -> slim relative path, or null when the entry is outside the L1 set.
     * Backslashes and leading slashes are normalised; a single wrapper folder is tolerated.
     */
    public static String resolve(String entryName) {
        if (entryName == null) return null;
        String p = entryName.replace('\\', '/');
        while (p.startsWith("/")) p = p.substring(1);
        String hit = match(p);
        if (hit != null) return hit;
        int slash = p.indexOf('/');
        if (slash > 0) {
            hit = match(p.substring(slash + 1)); // wrapper layout: strip one folder and retry
        }
        return hit;
    }

    /** public/ folding + L1 whitelist match on ONE candidate path. Null when not in the L1 set. */
    private static String match(String p) {
        while (p.endsWith("/")) p = p.substring(0, p.length() - 1);
        if (p.isEmpty()) return null;
        if (p.startsWith("public/")) {
            String sub = p.substring("public/".length());
            if (sub.startsWith("dev/") || sub.equals("dev")) return null;
            if (sub.startsWith("assets/") || sub.equals("assets")) return null; // L2 art: CDN only
            p = sub;
        }
        for (String top : SLIM_TOP) {
            if (p.equals(top) || p.startsWith(top + "/")) return p;
        }
        return null;
    }
}
