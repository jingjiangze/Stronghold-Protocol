package icu.jiangjiangze.stronghold;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import javax.net.ssl.HttpsURLConnection;

/**
 * Hot-update channel: checks the upstream project's latest GitHub release, downloads its
 * integration zip (the author's own distribution channel — nothing is re-hosted), extracts
 * the parts the shell needs into filesDir/webroot and swaps atomically. The WebView
 * interceptor and the host server both read that directory first, so an update lands
 * without reinstalling the APK.
 *
 * Server-side rules enforced here: https only, a strict host allowlist, and rejection of
 * localhost/loopback/private/reserved IP literals (redirect targets are validated too).
 */
public final class Updater {

    public static final String META_FILE = "webroot.meta.json";

    /** Hosts the updater may ever talk to. Anything else — including redirects — is rejected. */
    private static final List<String> ALLOWED_HOSTS = Arrays.asList(
            "api.github.com", "github.com", "objects.githubusercontent.com",
            "release-assets.githubusercontent.com", "codeload.github.com",
            "gh-proxy.com");

    public interface Progress {
        void onStage(String stage);

        void onProgress(long bytes, long total);
    }

    public static class Release {
        public final String tag;
        public final String zipUrl;

        Release(String tag, String zipUrl) {
            this.tag = tag;
            this.zipUrl = zipUrl;
        }
    }

    private Updater() {}

    /** Installed content tag, or null when only the bundled copy exists. */
    public static String installedTag(Context ctx) {
        File meta = new File(new File(ctx.getFilesDir(), META_FILE), "meta.json");
        if (!meta.isFile()) return null;
        try (FileInputStream in = new FileInputStream(meta)) {
            byte[] buf = new byte[512];
            int n = in.read(buf);
            String s = new String(buf, 0, Math.max(0, n), StandardCharsets.UTF_8);
            return s.replaceAll("[^0-9A-Za-z.\\-]", "");
        } catch (IOException e) {
            return null;
        }
    }

    static void writeInstalledTag(Context ctx, String tag) throws IOException {
        File dir = new File(ctx.getFilesDir(), META_FILE);
        if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) throw new IOException("mkdirs failed");
        try (FileOutputStream out = new FileOutputStream(new File(dir, "meta.json"))) {
            out.write(tag.getBytes(StandardCharsets.UTF_8));
        }
    }

    /** Fetches the upstream latest release. Returns null on network failure (caller decides). */
    public static Release latestRelease(String api) throws IOException {
        HttpURLConnection c = open(new URL(api), 12000, 12000);
        try {
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            String body = readAll(c.getInputStream());
            String tag = "";
            String zip = null;
            try {
                JSONObject o = new JSONObject(body);
                tag = o.optString("tag_name", "");
                JSONArray assets = o.optJSONArray("assets");
                if (assets != null) {
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject a = assets.getJSONObject(i);
                        String name = a.optString("name", "");
                        if (name.toLowerCase(Locale.ROOT).endsWith(".zip")) {
                            zip = a.optString("browser_download_url", "");
                            break;
                        }
                    }
                }
            } catch (org.json.JSONException e) {
                throw new IOException("bad release JSON: " + e.getMessage());
            }
            if (tag.isEmpty() || zip == null || zip.isEmpty()) throw new IOException("no zip asset");
            return new Release(tag, zip);
        } finally {
            c.disconnect();
        }
    }

    /** Downloads the release zip and extracts the shell-relevant subset into filesDir/webroot. */
    public static void downloadAndInstall(Context ctx, Release release, Progress progress) throws IOException {
        File files = ctx.getFilesDir();
        File staging = new File(files, "webroot.staging");
        File tmpZip = new File(files, "update.zip");
        File dst = HostService.contentRoot(ctx);
        File old = new File(files, "webroot.old");
        // self-hosted mirror (personal project): the same content bundle attached to our own release
        String selfMirror = "https://github.com/jingjiangze/Stronghold-Protocol/releases/download/content-"
                + release.tag + "/content-bundle-" + release.tag + ".zip";

        long free = files.getUsableSpace();
        if (free < 3L * 1024 * 1024 * 1024) throw new IOException("剩余空间不足（需要约 3GB）");

        rm(staging);
        rm(tmpZip);

        progress.onStage("下载中");
        long total = download(release.zipUrl, selfMirror, tmpZip, progress);

        progress.onStage("解压中");
        try (ZipInputStream zin = new ZipInputStream(new FileInputStream(tmpZip))) {
            ZipEntry e;
            byte[] buf = new byte[128 * 1024];
            while ((e = zin.getNextEntry()) != null) {
                String rel = mapEntry(e.getName());
                if (rel == null) continue;
                File out = new File(staging, rel);
                if (!out.getCanonicalPath().startsWith(staging.getCanonicalPath() + File.separator)
                        && !out.getCanonicalPath().equals(staging.getCanonicalPath() + File.separator + rel)) {
                    continue; // zip-slip guard
                }
                if (e.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
                    throw new IOException("mkdirs failed: " + parent);
                }
                try (OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = zin.read(buf)) > 0) os.write(buf, 0, n);
                }
            }
        }
        if (!new File(staging, "server/index.js").isFile()) throw new IOException("内容包不完整（缺 server）");

        progress.onStage("切换版本");
        // mark the new tree as updater-owned so HostService's materialiser never clobbers it
        try (FileOutputStream stampOut = new FileOutputStream(
                new File(staging, HostService.STAMP_NAME))) {
            stampOut.write((HostService.UPDATED_PREFIX + release.tag)
                    .getBytes(StandardCharsets.UTF_8));
        }
        rm(old);
        if (dst.isDirectory() && !dst.renameTo(old)) throw new IOException("无法切换旧目录");
        if (!staging.renameTo(dst)) throw new IOException("无法启用新目录");
        rm(old);
        writeInstalledTag(ctx, release.tag);
        rm(tmpZip);
        progress.onStage("完成 " + total / (1024 * 1024) + "MB");
    }

    /**
     * Upstream zip → shell webroot mapping. Returns the destination relative path for an
     * archive entry, or null to skip it (docs, tests, dev tooling and everything unrelated).
     */
    static String mapEntry(String name) {
        String p = name.replace('\\', '/');
        while (p.startsWith("/")) p = p.substring(1);
        int slash = p.indexOf('/');
        String root = slash < 0 ? "" : p.substring(0, slash);
        String rest = slash < 0 ? "" : p.substring(slash + 1);
        if (!root.isEmpty() && !rest.isEmpty()) {
            // strip a single top-level folder such as "Stronghold-Protocol/"
            p = rest;
        }
        if (p.isEmpty()) return null;
        for (String drop : new String[]{"test/", "docs/", "tools/", "scripts/", ".github/"}) {
            if (p.startsWith(drop)) return null;
        }
        if (p.startsWith("public/")) {
            String sub = p.substring("public/".length());
            if (sub.startsWith("dev/") || sub.equals("dev")) return null;
            return sub;
        }
        if (p.equals("package.json") || p.equals("package-lock.json")) return p;
        if (p.startsWith("data/") || p.startsWith("shared/") || p.startsWith("node_modules/")
                || p.startsWith("server/")) {
            return p;
        }
        return null;
    }

    /** The one place network hosts are validated: https + allowlist + no private/loopback literals. */
    private static HttpURLConnection open(URL url, int connMs, int readMs) throws IOException {
        String proto = url.getProtocol();
        String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.ROOT);
        if (!"https".equals(proto)) throw new IOException("non-https");
        if (!ALLOWED_HOSTS.contains(host)) throw new IOException("host not allowed: " + host);
        if (isLocalOrPrivateLiteral(host)) throw new IOException("private host rejected");
        HttpsURLConnection c = (HttpsURLConnection) url.openConnection();
        c.setConnectTimeout(connMs);
        c.setReadTimeout(readMs);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "stronghold-shell");
        return c;
    }

    /** Manual redirect handling so every hop is host-validated. Candidate order: upstream
     *  official zip → self-hosted release mirror → gh-proxy over each. */
    private static long download(String primary, String selfMirror, File dst, Progress progress) throws IOException {
        List<String> candidates = new ArrayList<>();
        candidates.add(primary);
        candidates.add(selfMirror);
        candidates.add("https://gh-proxy.com/" + primary);
        IOException last = null;
        for (String candidate : candidates) {
            try {
                return downloadOne(candidate, dst, progress);
            } catch (IOException e) {
                last = e;
            }
        }
        throw last != null ? last : new IOException("download failed");
    }

    private static long downloadOne(String url, File dst, Progress progress) throws IOException {
        URL u = new URL(url);
        HttpURLConnection c = open(u, 15000, 30000);
        int status = c.getResponseCode();
        if (status >= 301 && status <= 308) {
            String loc = c.getHeaderField("Location");
            c.disconnect();
            if (loc == null) throw new IOException("redirect without Location");
            URL next = new URL(u, loc);
            // validate the redirect target against the allowlist before following it
            HttpURLConnection nextConn = open(new URL(next.toString()), 15000, 30000);
            nextConn.disconnect();
            return downloadOne(next.toString(), dst, progress);
        }
        if (status != 200) {
            c.disconnect();
            throw new IOException("HTTP " + status);
        }
        long total = c.getContentLengthLong();
        try (InputStream in = c.getInputStream();
             OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[128 * 1024];
            long done = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                done += n;
                if (progress != null) progress.onProgress(done, total);
            }
            return done;
        } finally {
            c.disconnect();
        }
    }

    private static boolean isLocalOrPrivateLiteral(String host) {
        if (host.equals("localhost") || host.endsWith(".localhost") || host.endsWith(".local")
                || host.endsWith(".internal")) return true;
        if (!host.matches("\\d{1,3}(\\.\\d{1,3}){3}")) return false; // not an IPv4 literal
        String[] parts = host.split("\\.");
        int a = Integer.parseInt(parts[0]);
        int b = parts.length > 1 ? Integer.parseInt(parts[1]) : 0;
        if (a == 10 || a == 127 || a == 0) return true;
        if (a == 169 && b == 254) return true;
        if (a == 172 && b >= 16 && b <= 31) return true;
        if (a == 192 && b == 168) return true;
        if (a == 100 && b >= 64 && b <= 127) return true;
        return a >= 224; // multicast + reserved
    }

    private static String readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toString("UTF-8");
    }

    private static void rm(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) rm(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
