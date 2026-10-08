package icu.jiangjiangze.stronghold;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import javax.net.ssl.HttpsURLConnection;

/**
 * Hot update (最终执行方案-服务器清单与热更新.md §4).
 *
 * The manifest is a signed document naming the current build tag, the slim content bundle
 * (L1: the tree's top-level entries minus dev/ and the L2 assets/ — DERIVED at build time by
 * tools/apk/slim-top.mjs, no longer a hand-maintained list) and where to fetch it. Because the
 * bundle is upstream content, the shell re-applies its own extras and patches after extraction —
 * without that step a hot update would silently drop the bridge scripts and the DC wiring.
 * NOTE: the device-side filter (SlimPaths.resolve) is the DENY-list mirror of that same JS module —
 * dev/, assets/ and the build artifacts are rejected, every other top-level entry (including a
 * future upstream dir) is kept, so the whole-tree swap can no longer lose one (审计 R-04).
 * tools/apk/verify-slim.mjs cross-checks SlimPaths' exclusion/anchor arrays for parity.
 *
 * Order: signed manifest → mirror chain download (sha256-verified) → L1-only extraction →
 * extras + patches (anchor-asserted) → CDN manifest transform → atomic swap → health flag.
 * Any failure keeps the old tree and points the player at the APK download.
 *
 * Content-pack shell overlay (v2.8.x): a slim may additionally carry a versioned snapshot of the
 * shell's own extras+patches under the reserved shell-ui/ dir ({"version", extras/, patches/}).
 * The slim's sha256 sits inside the signed manifest, so that snapshot is covered by the SAME
 * Ed25519 chain — no second trust root. After verification the updater replays EITHER the
 * slim-carried overlay (strictly newer than the installed device version) OR the APK's
 * assets/shell overlay; the two sources are mutually exclusive and never both applied.
 */
public final class Updater {

    public static final String META_FILE = "webroot.meta.json";
    /** Marker written at swap time and cleared once the new tree actually renders. */
    public static final String HEALTH_FILE = "webroot.pending";

    /**
     * 全局互斥（审计 §4）：静默更新与手动检查更新若并发，会互相 rm 共享的
     * webroot.staging / update-slim.zip，并按 dst.length() 续传把半成品当断点续传，
     * 造成 sha256 失败、rename 冲突与双弹窗。这里保证同一时刻只有一个 hotUpdate 在跑。
     */
    private static final AtomicBoolean IN_FLIGHT = new AtomicBoolean(false);

    /**
     * 可取消阶段（下载循环内、各阶段边界）的取消请求。切换临界区
     * （dst→old 之后、staging→dst 之前）绝不检查它，保证旧树/新树不会被中途清理。
     */
    public static volatile boolean cancelRequested = false;

    /** Hosts the updater may ever talk to. Anything else — including redirects — is rejected. */
    private static final List<String> ALLOWED_HOSTS = Arrays.asList(
            "dl.jiangjiangze.icu", "weishucdn.jiangjiangze.icu",
            "stronghold.jiangjiangze.icu", "stronghold2.jiangjiangze.icu",
            "weishu.jiangjiangze.icu", "weishu2.jiangjiangze.icu",
            "ghfast.top", "gh-proxy.com", "gh.llkk.cc", "ghproxy.net",
            "api.github.com", "github.com", "objects.githubusercontent.com",
            "release-assets.githubusercontent.com", "codeload.github.com");

    /** Mirror chain, in order; each entry is a URL prefix applied to the canonical asset URL. */
    private static final String[][] MIRRORS = {
            {"ghfast", "https://ghfast.top/"},
            {"ghproxy", "https://gh-proxy.com/"},
            {"llkk", "https://gh.llkk.cc/"},
            {"ghproxynet", "https://ghproxy.net/"},
            {"r2", ""},   // R2-hosted copy is fetched directly
            {"box", ""},  // box-hosted copy is fetched directly
    };

    /**
     * Content manifest. The re-apk line reads ONLY its own pointer: the shared
     * {@code site/manifest.json} is the apk line's, and its slims are built from a different tree
     * (different patches/extras), so following it would pour another product's content into this
     * shell. Until the re line's controller publishes, this 404s and the updater stays on the
     * baked-in baseline — the correct "no update" answer.
     */
    private static final String[] MANIFEST_URLS = {
            Line.MANIFEST_URL,
    };
    private static final String BUILTIN_MANIFEST = "shell/manifest.json";
    /** Where the "download the newest APK instead" prompt points (the update failed for good). */
    public static final String APK_PAGE = "https://stronghold-download.pages.dev/";
    /**
     * APK "latest" sources, tried in order (v5.3.3):
     *  ① dl.jiangjiangze.icu/api/latest — the download site's edge-cached proxy of the newest
     *     APK-carrying release (KV fallback, mainland-friendly). GitHub release-object shape:
     *     tag_name + assets[] — parsed by apkFromDlLatest().
     *  ② weishucdn apk/latest.json — the R2 manifest (versionCode/versionName authority; the
     *     only source老 APK know). Never renamed/moved.
     * fetchApkLatest() tries both and keeps the NEWER ApkInfo, so either source being stale or
     * unreachable degrades gracefully.
     */
    /**
     * The dl.jiangjiangze.icu edge proxy belongs to the apk line (its KV maps "the newest
     * APK-carrying release", which is that line's). Disabled here — an empty URL makes
     * {@link #fetchDlLatest()} return null so the R2 pointer stays the single authority.
     */
    private static final String APK_LATEST_DL_URL = "";
    private static final String APK_LATEST_URL = Line.APK_LATEST_URL;
    /**
     * Download route for a release tag. The apk line hands this to its download site's counted
     * 302 endpoint; the re line has no such site, so it points straight at the R2 object
     * ({@code apk/re-stronghold-v<version>.apk}) and falls back to the manual page.
     */
    public static String apkDownloadUrl(String tag) {
        String t = tag == null ? "" : tag.trim();
        if (t.startsWith("shell-v") && t.matches("shell-v\\d+\\.\\d+\\.\\d+")) {
            return Line.CDN + "/apk/" + Line.APK_NAME_PREFIX + "stronghold-" + t.substring("shell-".length()) + ".apk";
        }
        return APK_PAGE;
    }

    /** CDN base the manifests point at after an update (mirrors build-webroot's SP_CDN_BASE). */
    private static final String CDN_BASE = Line.CDN;
    /** Where slim bundles are mirrored on R2 (apk/ prefix of the assets bucket). */
    private static final String R2_BUNDLE_BASE = Line.CDN + "/apk/";

    /** Reserved dir a slim may carry the shell's own overlay in (extras+patches snapshot). */
    private static final String SHELL_UI_DIR = "shell-ui";
    /** APK-baked overlay baseline (build-webroot writes it next to extras/patches; absent = 0). */
    private static final String ASSET_SHELL_UI_VERSION = "shell/shell-ui-version.txt";
    /** Prefs file/key holding the overlay version the device has actually applied. */
    private static final String PREFS_NAME = "shell-update";
    static final String PREF_SHELL_UI_VERSION = "shellUiVersion";
    /**
     * One-shot release bookkeeping: the installed content tag releaseUpdateResources() has already
     * run for. Dropped at every swap (writeHealthFlag), so a re-install of the same tag after a
     * rollback gets its own release instead of being mistaken for a repeat of the old one.
     */
    static final String PREF_RELEASED_TAG = "releasedTag";

    public interface Progress {
        void onStage(String stage);

        default void onProgress(long bytes, long total) {}
    }

    /** Sink for callers with no UI (silent background update); also makes a null sink harmless. */
    public static final Progress NOOP = stage -> { };

    /** The signed hot-update manifest. */
    public static final class Manifest {
        public String buildTag = "";
        public String upstreamTag = "";
        public int minApk = 0;
        public String slimUrl = "";
        public String slimSha256 = "";
        public long slimSize = 0;
        public String artBase = "";
        public String keyId = "";
        /** Signed shellOverlay.version (the slim carries a shell-ui/ snapshot), or null when
         *  the field is absent — old-shape manifests and slims without the overlay. */
        public Integer shellOverlayVersion;

        boolean usable() {
            return !buildTag.isEmpty() && !slimUrl.isEmpty();
        }
    }

    private Updater() {}

    // ------------------------------------------------------------------
    // Installed state
    // ------------------------------------------------------------------

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

    /**
     * The build tag of the running content, or null when only the bundled copy exists. NEVER
     * derive it from the shell's versionName: the shell version and the content buildTag are
     * independent axes, and conflating them made a fresh install with no hot-update history look
     * older than the live manifest — re-downloading on every launch. A null return means "content
     * = whatever this APK embedded"; needsUpdate() then compares against the embedded manifest's
     * own buildTag, which the APK can never be behind.
     */
    public static String currentBuildTag(Context ctx) {
        return installedTag(ctx);
    }

    // ------------------------------------------------------------------
    // Manifest
    // ------------------------------------------------------------------

    /** Fetches and verifies the manifest from EVERY source and returns the NEWEST one. A stale
     *  mirror can no longer shadow a fresh one (the dl source once served v2.6.0 while R2 already
     *  had v2.6.1, and "first verified wins" made devices miss the update entirely). */
    public static Manifest fetchManifest(Context ctx) {
        byte[] pub = ServerList.publicKey(ctx);
        Manifest best = null;
        if (pub != null) {
            for (String url : MANIFEST_URLS) {
                if (!ServerList.isPublicHttpUrl(url)) continue;
                String body = httpGet(url);
                if (body == null) continue;
                Manifest m = parseVerified(body, pub);
                if (m != null && m.usable() && belongsToLine(m)
                        && (best == null || compareBuildTags(m.buildTag, best.buildTag) > 0)) {
                    best = m;
                }
            }
        }
        Manifest builtin = parseVerified(readBuiltinManifest(ctx), pub);
        if (builtin != null && builtin.usable()
                && (best == null || compareBuildTags(builtin.buildTag, best.buildTag) > 0)) {
            best = builtin;
        }
        return best;
    }

    /**
     * True when the manifest describes THIS line: its signed body names the line's own asset tree
     * ({@code /assets-re/}). Manifests are the only thing that can pour content into this shell, and
     * both lines share one signing key, so the namespace marker — not the source URL — is what
     * separates them. Foreign manifests are dropped everywhere: picker, baked baseline, apply.
     */
    private static boolean belongsToLine(Manifest m) {
        return m != null && m.artBase != null && m.artBase.contains("/assets" + Line.SUFFIX + "/");
    }

    /**
     * The baked baseline, but only when it describes THIS line (same marker as
     * {@link #belongsToLine}: the raw text is tested first so a foreign baseline never even parses).
     *
     * <p>The file is a signed snapshot produced by whichever line last ran a content release, and
     * this branch's copy still carries the apk line's (its slim would pour another product's content
     * into this shell whenever the live pointer is unreachable). A baseline without the marker is
     * ignored — the first content release of this line regenerates the file with the right fields.
     */
    private static String readBuiltinManifest(Context ctx) {
        String text = readAsset(ctx, BUILTIN_MANIFEST);
        if (text == null) return null;
        return text.contains("/assets" + Line.SUFFIX + "/") ? text : null;
    }

    static Manifest parseVerified(String json, byte[] pub) {
        if (json == null || pub == null) return null;
        try {
            JSONObject doc = new JSONObject(json);
            if (!ServerList.verifyDoc(doc, pub)) return null;
            Manifest m = new Manifest();
            m.buildTag = doc.optString("buildTag", "");
            m.upstreamTag = doc.optString("upstreamTag", "");
            m.minApk = doc.optInt("minApk", 0);
            m.keyId = doc.optString("keyId", "");
            JSONObject slim = doc.optJSONObject("slim");
            if (slim != null) {
                m.slimUrl = slim.optString("url", "");
                m.slimSha256 = slim.optString("sha256", "");
                m.slimSize = slim.optLong("size", 0);
            }
            JSONObject art = doc.optJSONObject("art");
            if (art != null) m.artBase = art.optString("base", "");
            JSONObject overlay = doc.optJSONObject("shellOverlay");
            if (overlay != null) m.shellOverlayVersion = overlay.optInt("version", 0);
            return m;
        } catch (Exception e) {
            return null;
        }
    }

    /** True only when the manifest describes content STRICTLY newer than installed — a stale
     *  mirror must never DOWNGRADE a device (string inequality would happily do that). With no
     *  hot-update history the content IS the APK's embedded tree, so the right baseline is the
     *  embedded manifest's own buildTag (it ships with the content it describes). */
    public static boolean needsUpdate(Context ctx, Manifest m) {
        if (m == null || !m.usable() || !belongsToLine(m)) return false;
        String baseline = currentBuildTag(ctx);
        if (baseline == null) {
            Manifest embedded = parseVerified(readBuiltinManifest(ctx), ServerList.publicKey(ctx));
            baseline = embedded != null && embedded.usable() ? embedded.buildTag : null;
        }
        // No baseline at all — a fresh install whose baked baseline belongs to the other line. The
        // first verifiable manifest OF THIS LINE is by definition newer than whatever shipped in the
        // APK, so offer it. Staying quiet here (the pre-2026-10-07 behaviour) deadlocks the line: no
        // baseline until an update lands, and no update without a baseline.
        if (baseline == null) return true;
        return compareBuildTags(m.buildTag, baseline) > 0;
    }

    /** Numeric build-tag comparison ("shell-v2.6.10" > "shell-v2.6.9"); unparseable tags fall
     *  back to plain string comparison so an unexpected scheme can never throw. */
    public static int compareBuildTags(String a, String b) {
        long[] pa = parseTag(a);
        long[] pb = parseTag(b);
        if (pa == null || pb == null) {
            return String.valueOf(a).compareTo(String.valueOf(b));
        }
        for (int i = 0; i < 3; i++) {
            if (pa[i] != pb[i]) return pa[i] < pb[i] ? -1 : 1;
        }
        return 0;
    }

    private static long[] parseTag(String tag) {
        if (tag == null) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("(\\d+)\\.(\\d+)\\.(\\d+)").matcher(tag);
        if (!m.find()) return null;
        try {
            return new long[] { Long.parseLong(m.group(1)), Long.parseLong(m.group(2)),
                    Long.parseLong(m.group(3)) };
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** minApk gate: a manifest built for a newer shell cannot be hot-updated — go get the APK. */
    public static boolean requiresNewApk(Manifest m) {
        return m != null && m.minApk > BuildConfig.VERSION_CODE;
    }

    // ------------------------------------------------------------------
    // Shell (APK) version check — apk/latest.json
    // ------------------------------------------------------------------

    /** apk/latest.json as published by tools/apk/publish-apk-latest.mjs. versionCode 0 means the
     *  file predates the field (or malformed) and is treated as "not newer" — never a downgrade. */
    public static final class ApkInfo {
        public int versionCode = 0;
        public String versionName = "";
        public String tag = "";
        public String apkUrl = "";
        public long size = -1;      // v5.3.3: from the dl site's asset (R2 manifest carries it too via size? keep optional)
        public String sha256 = "";  // v5.3.3: from the dl site's digest field ("" when unknown)

        public boolean newerThanInstalled() {
            return versionCode > BuildConfig.VERSION_CODE;
        }
    }

    /** Fetches apk/latest.json over the validated channel: https only, host whitelisted (open()
     *  enforces both, one re-validated redirect hop at most). Null when unavailable/malformed. */
    /** Newest APK-carrying release from the download site's /api/latest (GitHub release shape).
     *  versionCode is derived from the shell tag (shell-v2.9.6 → 2.9.6 → compared numerically by
     *  newerThanInstalled via versionName-major ordering is NOT possible without a real code, so
     *  we synthesize major*1_000_000 + minor*1_000 + patch — same scheme the site uses). */
    static ApkInfo apkFromDlLatest(String body) {
        try {
            JSONObject doc = new JSONObject(body);
            if (!doc.optBoolean("ok", true)) return null;
            String tag = doc.optString("tag_name", "");
            if (!tag.matches("shell-v\\d+\\.\\d+\\.\\d+")) return null;
            JSONObject apkAsset = null;
            org.json.JSONArray assets = doc.optJSONArray("assets");
            for (int i = 0; assets != null && i < assets.length(); i++) {
                JSONObject a = assets.optJSONObject(i);
                if (a != null && "app-release.apk".equals(a.optString("name", ""))) { apkAsset = a; break; }
            }
            if (apkAsset == null) return null; // a content-only release is not an APK update
            long size = apkAsset.optLong("size", -1);
            String digest = apkAsset.optString("digest", "");
            String sha = digest.startsWith("sha256:") ? digest.substring("sha256:".length()) : "";
            ApkInfo info = new ApkInfo();
            info.tag = tag;
            info.versionName = tag.substring("shell-v".length());
            String[] parts = info.versionName.split("\\.");
            info.versionCode = parts.length == 3
                    ? Integer.parseInt(parts[0]) * 1_000_000 + Integer.parseInt(parts[1]) * 1_000 + Integer.parseInt(parts[2])
                    : 0;
            info.apkUrl = apkDownloadUrl(tag); // accelerated route (302 → CDN/accelerator)
            if (size > 0) info.size = size;
            if (!sha.isEmpty()) info.sha256 = sha;
            return info;
        } catch (Exception e) {
            return null;
        }
    }

    public static ApkInfo fetchApkLatest() {
        // ① dl site edge proxy (fast in mainland; KV-backed)
        ApkInfo best = fetchDlLatest();
        // ② R2 manifest (versionCode authority; the only source old shells poll)
        HttpURLConnection c = null;
        try {
            URL u = new URL(APK_LATEST_URL);
            c = open(u, 6000, 6000);
            int status = c.getResponseCode();
            if (status >= 301 && status <= 308) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null) return null;
                URL next = new URL(u, loc);
                c = open(next, 6000, 6000); // validates the hop's protocol + host
                status = c.getResponseCode();
            }
            if (status != 200) return null;
            JSONObject doc = new JSONObject(ServerList.readAll(c.getInputStream()));
            ApkInfo info = new ApkInfo();
            info.versionCode = doc.optInt("versionCode", 0);
            info.versionName = doc.optString("versionName", "");
            info.tag = doc.optString("tag", "");
            info.apkUrl = doc.optString("apkUrl", "");
            info.size = doc.optLong("size", -1);
            info.sha256 = doc.optString("sha256", "");
            // v5.3.3: keep whichever source reports the newer versionCode
            if (best == null || (info.versionCode > 0 && info.versionCode > best.versionCode)) return info;
            return best;
        } catch (Exception e) {
            return best; // source ② failed to parse: ① still counts
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** dl.jiangjiangze.icu/api/latest → ApkInfo (null when unreachable/malformed/no APK asset). */
    private static ApkInfo fetchDlLatest() {
        if (APK_LATEST_DL_URL.isEmpty()) return null; // this line has no dl-site API (see above)
        HttpURLConnection c = null;
        try {
            URL u = new URL(APK_LATEST_DL_URL);
            c = open(u, 6000, 6000);
            int status = c.getResponseCode();
            if (status != 200) return null;
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[2048];
            int n;
            java.io.InputStream in = c.getInputStream();
            while ((n = in.read(buf)) > 0 && bos.size() < 512 * 1024) bos.write(buf, 0, n);
            in.close();
            return apkFromDlLatest(bos.toString("UTF-8"));
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ------------------------------------------------------------------
    // Hot update
    // ------------------------------------------------------------------

    /** Downloads, verifies and installs the slim bundle; throws (old tree kept) on any failure. */
    public static void hotUpdate(Context ctx, Manifest m, Progress progress) throws IOException {
        if (progress == null) progress = NOOP; // a null sink must never NPE (v2.8.1 field crash)
        if (m == null || !m.usable()) throw new IOException("清单不可用");
        if (requiresNewApk(m)) throw new IOException("需要新版应用（minApk " + m.minApk + "）");
        // 全局互斥：已有更新在跑时直接拒绝，绝不让两个更新共用 staging/zip。
        if (!IN_FLIGHT.compareAndSet(false, true)) throw new IOException("已有更新进行中");
        cancelRequested = false; // 本次更新接管取消标志（上一次的取消请求到此为止）

        File files = ctx.getFilesDir();
        File staging = new File(files, "webroot.staging");
        File tmpZip = new File(files, "update-slim.zip");
        File dst = HostService.contentRoot(ctx);
        File old = new File(files, "webroot.old");

        long total = 0;
        // swapStarted 之后即进入「切换临界区」：此区绝不响应取消，避免把刚 rename 的旧/新树
        // 清理掉（不变量：任何失败/取消后旧树仍可用）。
        boolean swapStarted = false;
        try {
            if (files.getUsableSpace() < 2L * 1024 * 1024 * 1024) throw new IOException("剩余空间不足（需要约 2GB）");
            rm(staging);
            rm(tmpZip);
            checkCancel();

            progress.onStage("下载更新包");
            total = downloadWithMirrors(m, tmpZip, progress);
            checkCancel();

            progress.onStage("校验");
            if (!m.slimSha256.isEmpty()) {
                String got = sha256(tmpZip);
                if (!got.equalsIgnoreCase(m.slimSha256)) {
                    throw new IOException("校验失败（sha256 不符）");
                }
            }
            checkCancel();

            progress.onStage("解压");
            extractSlim(tmpZip, staging);
            if (!new File(staging, "server/index.js").isFile()) throw new IOException("内容包不完整（缺 server）");
            checkCancel();

            progress.onStage("应用外壳补丁");
            // Content-pack shell overlay: the slim's sha256 already passed the signed-manifest check
            // above, so shell-ui/ (version.txt + extras/ + patches/ snapshot) is covered by the same
            // signature chain. ONE branch decides the single source to replay — never both.
            Integer slimOverlay = readSlimOverlayVersion(staging);
            if (slimOverlay != null && m.shellOverlayVersion != null
                    && m.shellOverlayVersion.intValue() != slimOverlay.intValue()) {
                // signed manifest and bundle disagree on the overlay version -> internally
                // inconsistent pair; fall back to the APK overlay instead of trusting either.
                slimOverlay = null;
            }
            PatchEngine.OverlaySource overlaySource =
                    PatchEngine.chooseOverlaySource(slimOverlay, deviceShellUiVersion(ctx));
            if (overlaySource == PatchEngine.OverlaySource.SLIM) {
                File overlay = new File(staging, SHELL_UI_DIR);
                applyExtras(ctx, staging, new File(overlay, "extras"));
                applyPatches(ctx, staging, new File(overlay, "patches"));
                rm(overlay); // the snapshot itself never lands in the served content tree
            } else {
                rm(new File(staging, SHELL_UI_DIR)); // not adopted: drop the package, never apply both
                applyExtras(ctx, staging, null);
                applyPatches(ctx, staging, null);
            }

            transformManifests(new File(staging, "data"));
            checkCancel(); // 最后一个可取消点，紧邻临界区

            progress.onStage("切换版本");
            try (FileOutputStream stampOut = new FileOutputStream(new File(staging, HostService.STAMP_NAME))) {
                stampOut.write((HostService.UPDATED_PREFIX + m.buildTag).getBytes(StandardCharsets.UTF_8));
            }
            swapStarted = true; // —— 临界区开始：此后绝不检查取消 ——
            rm(old);
            if (dst.isDirectory() && !dst.renameTo(old)) throw new IOException("无法切换旧目录");
            if (!staging.renameTo(dst)) throw new IOException("无法启用新目录");
            // keep webroot.old until the new tree proves it renders (rollback on next cold start)
            writeHealthFlag(ctx);
            writeInstalledTag(ctx, m.buildTag);
            if (overlaySource == PatchEngine.OverlaySource.SLIM) {
                // only now is the slim-carried overlay the device's applied version (rollback clears
                // the record again, so a rolled-back device never claims a version its tree lacks)
                writeShellUiVersion(ctx, slimOverlay == null ? 0 : slimOverlay);
            }
            rm(tmpZip);
            progress.onStage("完成 " + total / (1024 * 1024) + "MB");
        } catch (IOException e) {
            // 取消 / 失败：清理本次半成品；未进临界区才动 staging，旧树始终可用。
            if (!swapStarted) {
                rm(tmpZip);
                rm(staging);
            }
            if (cancelRequested) progress.onStage("已取消");
            throw e;
        } finally {
            IN_FLIGHT.set(false);
        }
    }

    /** 可取消阶段的取消检查；切换临界区绝不调用（见 hotUpdate 的 swapStarted）。 */
    private static void checkCancel() throws IOException {
        if (cancelRequested) throw new IOException("更新已取消");
    }

    /** Downloads over the mirror chain, resuming a partial file when the server allows it. */
    private static long downloadWithMirrors(Manifest m, File dst, Progress progress) throws IOException {
        if (progress == null) progress = NOOP;
        List<String> candidates = new ArrayList<>();
        for (String[] mirror : MIRRORS) {
            if (mirror[1].isEmpty()) continue; // r2/box are added explicitly below
            candidates.add(mirror[1] + m.slimUrl);
        }
        // the R2 copy is derived from the build tag, so it works even when the GitHub asset is
        // missing and every mirror prefix (which only understands GitHub URLs) 404s
        candidates.add(R2_BUNDLE_BASE + "content-slim-" + m.buildTag + ".zip");
        candidates.add(m.slimUrl);
        IOException last = null;
        for (String candidate : candidates) {
            try {
                return downloadOne(candidate, dst, progress);
            } catch (IOException e) {
                if (cancelRequested) throw e; // 取消不应被镜像链吞掉后继续试下一个源
                last = e;
            }
        }
        throw last != null ? last : new IOException("下载失败");
    }

    private static long downloadOne(String spec, File dst, Progress progress) throws IOException {
        if (progress == null) progress = NOOP;
        URL u = new URL(spec);
        long have = dst.isFile() ? dst.length() : 0;
        HttpURLConnection c = open(u, 15000, 30000);
        if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
        int status = c.getResponseCode();
        if (status >= 301 && status <= 308) {
            String loc = c.getHeaderField("Location");
            c.disconnect();
            if (loc == null) throw new IOException("redirect without Location");
            URL next = new URL(u, loc);
            open(next, 15000, 30000).disconnect(); // validates the hop before following it
            return downloadOne(next.toString(), dst, progress);
        }
        boolean resuming = have > 0 && status == 206;
        if (status != 200 && status != 206) {
            c.disconnect();
            throw new IOException("HTTP " + status);
        }
        long total = c.getContentLengthLong() + (resuming ? have : 0);
        try (InputStream in = c.getInputStream();
             OutputStream out = new FileOutputStream(dst, resuming)) {
            byte[] buf = new byte[128 * 1024];
            long done = resuming ? have : 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                if (cancelRequested) throw new IOException("更新已取消"); // 下载循环内的可取消点
                out.write(buf, 0, n);
                done += n;
                if (progress != null) progress.onProgress(done, total);
            }
            return done;
        } finally {
            c.disconnect();
        }
    }

    /** Extracts only the L1 (slim) paths from the bundle plus the reserved shell-ui/ overlay
     *  snapshot (replayed later, never served); everything else never lands on disk. */
    private static void extractSlim(File zip, File staging) throws IOException {
        try (ZipInputStream zin = new ZipInputStream(new FileInputStream(zip))) {
            ZipEntry e;
            byte[] buf = new byte[128 * 1024];
            while ((e = zin.getNextEntry()) != null) {
                String rel = slimEntry(e.getName());
                if (rel == null) rel = shellUiEntry(e.getName());
                if (rel == null) continue;
                File out = new File(staging, rel);
                if (!out.getCanonicalPath().startsWith(staging.getCanonicalPath() + File.separator)) continue;
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
    }

    /** Archive path → slim relative path, or null when the entry is outside the L1 set. */
    static String slimEntry(String name) {
        return SlimPaths.resolve(name);
    }

    /**
     * Archive path → shell-ui/<path> for the reserved overlay dir the slim may carry
     * ({"version.txt", extras/, patches/}, packed by make-bundle when shell-ui-version.txt > 0),
     * or null. Mirrors SlimPaths' single-wrapper tolerance; path traversal is caught by the
     * canonical-prefix guard in extractSlim.
     */
    static String shellUiEntry(String name) {
        if (name == null) return null;
        String p = name.replace('\\', '/');
        while (p.startsWith("/")) p = p.substring(1);
        String hit = matchShellUi(p);
        if (hit != null) return hit;
        int slash = p.indexOf('/');
        return slash > 0 ? matchShellUi(p.substring(slash + 1)) : null; // wrapper folder retry
    }

    private static String matchShellUi(String p) {
        while (p.endsWith("/")) p = p.substring(0, p.length() - 1);
        if (p.equals(SHELL_UI_DIR) || p.startsWith(SHELL_UI_DIR + "/")) return p;
        return null;
    }

    // ------------------------------------------------------------------
    // Shell-owned overlays (extras + patches), bundled as assets
    // ------------------------------------------------------------------

    /** Copies the shell's extras over the staging tree (bridge scripts, panels, DC bridge).
     *  {@code extrasDir} != null reads a slim-carried shell-ui/extras snapshot from disk;
     *  null keeps today's APK-assets source. Callers pick exactly one of the two. */
    private static void applyExtras(Context ctx, File staging, File extrasDir) throws IOException {
        if (extrasDir == null) {
            copyAssetTree(ctx, "shell/extras/public", staging);
            copyAssetTree(ctx, "shell/extras/server", new File(staging, "server"));
            return;
        }
        copyFileTree(new File(extrasDir, "public"), staging);
        copyFileTree(new File(extrasDir, "server"), new File(staging, "server"));
    }

    /** Recursively copies a directory tree; a missing source is a no-op (like the assets side). */
    private static void copyFileTree(File from, File to) throws IOException {
        if (!from.isDirectory()) return;
        File[] kids = from.listFiles();
        if (kids == null) return;
        for (File kid : kids) {
            File dst = new File(to, kid.getName());
            if (kid.isDirectory()) {
                copyFileTree(kid, dst);
            } else {
                File parent = dst.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
                    throw new IOException("mkdirs failed: " + parent);
                }
                java.nio.file.Files.copy(kid.toPath(), dst.toPath(),
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
        }
    }

    private static void copyAssetTree(Context ctx, String assetDir, File targetDir) throws IOException {
        String[] kids = ctx.getAssets().list(assetDir);
        if (kids == null || kids.length == 0) return;
        for (String kid : kids) {
            String childAsset = assetDir + "/" + kid;
            String[] grand = ctx.getAssets().list(childAsset);
            if (grand != null && grand.length > 0) {
                copyAssetTree(ctx, childAsset, new File(targetDir, kid));
            } else {
                File out = new File(targetDir, kid);
                File parent = out.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
                    throw new IOException("mkdirs failed: " + parent);
                }
                try (InputStream in = ctx.getAssets().open(childAsset);
                     OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                }
            }
        }
    }

    /**
     * Replays the shell's patch JSONs with the same semantics as the Node engine
     * (tools/apk/build-webroot.mjs applyPatches + tools/apk/check-patches.mjs): CRLF is
     * normalised to LF on read, already-applied entries are skipped, optional anchors are
     * tolerated, shrink rewrites the first matching anchor line, minApp/maxApp gate on the
     * tree's APP_VERSION. A missing required anchor still aborts the update rather than
     * shipping a tree where the bridge tags silently vanished.
     *
     * {@code patchesDir} != null reads a slim-carried shell-ui/patches snapshot from disk;
     * null keeps today's APK-assets source. Callers pick exactly one of the two.
     */
    private static void applyPatches(Context ctx, File staging, File patchesDir) throws IOException {
        String[] files = patchesDir == null ? ctx.getAssets().list("shell/patches") : patchesDir.list();
        if (files == null || files.length == 0) return;
        Arrays.sort(files);
        String appVersion = readAppVersion(staging);
        for (String name : files) {
            if (!name.endsWith(".json")) continue;
            JSONObject spec;
            try {
                String body = patchesDir == null
                        ? readAsset(ctx, "shell/patches/" + name)
                        : readTextFile(new File(patchesDir, name));
                spec = new JSONObject(body == null ? "" : body);
            } catch (org.json.JSONException e) {
                throw new IOException("补丁文件解析失败：" + name);
            }
            JSONArray patches = spec.optJSONArray("patches");
            if (patches == null) continue;
            for (int i = 0; i < patches.length(); i++) {
                JSONObject p = patches.optJSONObject(i);
                if (p == null) continue;
                String file = p.optString("file", "");
                File target = new File(staging, file);
                if (!target.isFile()) throw new IOException("补丁目标缺失：" + file);
                String text = new String(java.nio.file.Files.readAllBytes(target.toPath()), StandardCharsets.UTF_8);
                PatchEngine.Result result = PatchEngine.apply(text,
                        p.optString("find", ""),
                        p.optString("replace", ""),
                        p.optBoolean("optional", false),
                        p.optBoolean("shrink", false),
                        appVersion,
                        optVersion(p, "minApp"),
                        optVersion(p, "maxApp"));
                if (result.status == PatchEngine.Status.NO_ANCHOR) {
                    throw new IOException("补丁锚点未命中：" + file);
                }
                if (result.status == PatchEngine.Status.PATCHED) {
                    java.nio.file.Files.write(target.toPath(), result.text.getBytes(StandardCharsets.UTF_8));
                }
            }
        }
    }

    /** Optional version bound from a patch entry; absent/null/empty means "no constraint". */
    private static String optVersion(JSONObject p, String key) {
        if (!p.has(key) || p.isNull(key)) return null;
        String v = p.optString(key, "");
        return v.isEmpty() ? null : v;
    }

    /** APP_VERSION of the staging tree (shared/constants.js), or null when unresolvable. */
    private static String readAppVersion(File staging) {
        File f = new File(new File(staging, "shared"), "constants.js");
        try {
            String t = new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("APP_VERSION\\s*=\\s*'([^']+)'").matcher(t);
            if (m.find()) return m.group(1);
            m = java.util.regex.Pattern.compile("APP_VERSION\\s*=\\s*\"([^\"]+)\"").matcher(t);
            return m.find() ? m.group(1) : null;
        } catch (IOException e) {
            return null;
        }
    }

    // ------------------------------------------------------------------
    // Content-pack shell overlay (shell-ui/) — device version bookkeeping
    // ------------------------------------------------------------------

    /** Whole file as UTF-8; a read failure aborts the update (never a silent skip). */
    private static String readTextFile(File f) throws IOException {
        return new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
    }

    /**
     * Version of the slim-carried overlay, or null when the unpacked bundle does not carry a
     * complete shell-ui/ package (version.txt + extras/ + patches/). Invalid version text
     * parses as 0 — never wins a decision against a baseline of 0.
     */
    private static Integer readSlimOverlayVersion(File staging) {
        File overlay = new File(staging, SHELL_UI_DIR);
        File versionFile = new File(overlay, "version.txt");
        if (!versionFile.isFile() || !new File(overlay, "extras").isDirectory()
                || !new File(overlay, "patches").isDirectory()) {
            return null;
        }
        try {
            return PatchEngine.parseOverlayVersion(readTextFile(versionFile));
        } catch (IOException e) {
            return null;
        }
    }

    /** Overlay version the device has actually applied: prefs first (written after a successful
     *  slim-overlay swap), else the APK-baked baseline; unreadable/unparseable → 0. */
    static int deviceShellUiVersion(Context ctx) {
        int pref = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getInt(PREF_SHELL_UI_VERSION, 0);
        if (pref > 0) return pref;
        return PatchEngine.parseOverlayVersion(readAsset(ctx, ASSET_SHELL_UI_VERSION));
    }

    private static void writeShellUiVersion(Context ctx, int version) {
        // commit() on purpose (synchronous): the record must survive a crash right after the
        // swap, or the next launch would replay the very same overlay on top of itself.
        ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().putInt(PREF_SHELL_UI_VERSION, version).commit();
    }

    // ------------------------------------------------------------------
    // Health flag / rollback
    // ------------------------------------------------------------------

    private static void writeHealthFlag(Context ctx) throws IOException {
        try (FileOutputStream out = new FileOutputStream(new File(ctx.getFilesDir(), HEALTH_FILE))) {
            out.write("pending".getBytes(StandardCharsets.UTF_8));
        }
        // A swap starts a NEW update generation: its resources must become releasable exactly once
        // on their own, so the record of the generation this one replaces is dropped here.
        ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().remove(PREF_RELEASED_TAG).commit();
    }

    /**
     * Called from onPageFinished; keeps the new tree and drops the rollback copy — but ONLY when
     * an update is actually pending AND the finished page was served from the local tree. Without
     * that guard, loading ANY external page after a hot update (server switch, 免责声明 consent
     * flow, remote-client mode) would consume the rollback copy before the new tree ever rendered.
     */
    public static void markHealthy(Context ctx, boolean pageFromLocalTree) {
        if (!pageFromLocalTree) return; // an external/consent page says nothing about the new tree
        File flag = new File(ctx.getFilesDir(), HEALTH_FILE);
        if (!flag.exists()) return;
        //noinspection ResultOfMethodCallIgnored
        flag.delete();
        // Rollback window closed → release the update's disk exactly once (releaseUpdateResources
        // re-checks the flag it just deleted, the tree's own stamp and the in-flight mutex before
        // anything is removed, and it is the call that drops the rollback copy webroot.old).
        // This runs on the WebView callback thread (onPageFinished) and webroot.old is update-sized:
        // the recursive delete goes to a worker so it can never stall page rendering.
        Context app = ctx.getApplicationContext();
        Thread t = new Thread(() -> releaseUpdateResources(app), "content-release");
        t.start();
    }

    /** True while a hot update awaits its first successful render of the local tree. */
    public static boolean healthPending(Context ctx) {
        return new File(ctx.getFilesDir(), HEALTH_FILE).exists();
    }

    /** At cold start: a pending flag means the previous update never rendered → roll back. */
    public static void rollbackIfUnhealthy(Context ctx) {
        File flag = new File(ctx.getFilesDir(), HEALTH_FILE);
        File old = new File(ctx.getFilesDir(), "webroot.old");
        if (flag.exists() && old.isDirectory()) {
            File dst = HostService.contentRoot(ctx);
            File failed = new File(ctx.getFilesDir(), "webroot.failed");
            rm(failed);
            boolean rolledBack = false;
            if (dst.isDirectory() && dst.renameTo(failed)) {
                if (old.renameTo(dst)) {
                    rm(failed);
                    rm(new File(new File(ctx.getFilesDir(), META_FILE), "meta.json"));
                    // the rolled-back tree carries the overlay it was built with: drop the recorded
                    // version so deviceShellUiVersion() falls back to the APK baseline instead of
                    // claiming the version of the tree that failed to render.
                    ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                            .edit().remove(PREF_SHELL_UI_VERSION).commit();
                    rolledBack = true;
                } else {
                    //noinspection ResultOfMethodCallIgnored
                    failed.renameTo(dst); // failed tree live again: retry the rollback next cold start
                }
            }
            if (rolledBack) {
                // Only a COMPLETED rollback closes the window. If a rename failed, the failed
                // update is still live with its matching stamp, and deleting the flag here would
                // let releaseUpdateResources() pass its gate and delete webroot.old — this device's
                // only copy of the tree it is supposed to be running. The flag therefore stays:
                // gate (a) of the release keeps the recovery tree, and the next cold start retries.
                //noinspection ResultOfMethodCallIgnored
                flag.delete();
            }
        }
        // Cold-start retry hook of the one-shot release: a release interrupted by a process kill
        // left its marker unwritten, and this is the one path every launch runs before the tree is
        // touched. A rollback just performed removed the installed tag, so the release's own gate
        // fails that state on purpose — the tree that was just restored is never a candidate.
        // A rollback that did NOT complete leaves webroot.pending, which is the release's (a) gate.
        releaseUpdateResources(ctx);
    }

    // ------------------------------------------------------------------
    // One-shot post-update resource release
    // ------------------------------------------------------------------

    /**
     * Frees the disk a finished hot update still holds — the rollback copy (webroot.old) and the
     * pipeline's leftovers (a dead webroot.staging, the downloaded update-slim.zip, rollback
     * debris webroot.failed, and an interrupted materialisation's webroot.next).
     *
     * WHY IT MAY ONLY RUN ONCE
     *   The release is keyed to the installed content tag in prefs ({@link #PREF_RELEASED_TAG}) and
     *   the key is written only AFTER the deletions, so: repeated renders, repeated launches and
     *   process restarts never re-run it for the same update; a process killed mid-release retries
     *   (rm is idempotent — nothing can be deleted twice or wrongly); and a re-install of the same
     *   tag after a rollback gets a fresh release because every swap (writeHealthFlag) drops the
     *   record. A release that runs on every launch would free nothing extra — it would only be a
     *   second, uncontrolled deleter next to the rollback logic.
     *
     * WHY IT CANNOT BREAK ROLLBACK
     *   webroot.pending + webroot.old are the rollback invariant (cold start rolls back to the old
     *   tree while the flag exists). The gate passes only when every one of these holds:
     *     (a) no HEALTH_FILE is pending — the rollback window is closed (markHealthy just consumed
     *         it, or the cold-start rollback resolved it);
     *     (b) the recorded tag and the live tree's own stamp.txt agree ("updated:<tag>") — the tree
     *         on disk is exactly the one the record describes, so an interrupted swap (mismatch)
     *         is left completely alone;
     *     (c) the sweep can take the update mutex (IN_FLIGHT, by CAS) — a running attempt owns
     *         webroot.staging / update-slim.zip and may still consider webroot.old its rollback
     *         base, so the sweep never runs against it; and the mutex is held until every deletion
     *         AND the one-shot marker are done, so no attempt can start mid-sweep and have its
     *         freshly parked webroot.old deleted before its own health flag even exists.
     *   While any condition is false nothing is deleted. This is strictly safer than the previous
     *   unconditional rm(webroot.old) in markHealthy, which could delete a rollback copy the
     *   concurrent update had just parked.
     *
     * Failures degrade silently (nothing in the app depends on the release) but leave one line in
     * filesDir/diag.log — same shape as MainActivity.appendDiagLog.
     */
    private static void releaseUpdateResources(Context ctx) {
        try {
            // (c) take the SAME mutex hotUpdate takes, so the gate and the deletions are one atomic
            // step: while an attempt runs, the sweep returns without touching staging/zip/old; from
            // here until the marker commit, no attempt can start (otherwise one could begin right
            // after the check, park a fresh webroot.old, and have this sweep delete its rollback
            // base before its own health flag even existed).
            if (!IN_FLIGHT.compareAndSet(false, true)) return;
            try {
                if (HostService.materialising) return; // HostService is writing webroot.next as we speak
                if (healthPending(ctx)) return;   // (a) rollback window still open
                String tag = installedTag(ctx);
                if (tag == null) return;          // only the APK's embedded tree exists — nothing of ours
                File root = HostService.contentRoot(ctx);
                String stamp = readTextOrNull(new File(root, HostService.STAMP_NAME));
                if (!(HostService.UPDATED_PREFIX + tag).equals(stamp)) return; // (b) not our tree / partial swap
                SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                if (tag.equals(prefs.getString(PREF_RELEASED_TAG, null))) return; // already released for this tag

                File files = ctx.getFilesDir();
                StringBuilder freed = new StringBuilder();
                // webroot.old is dead by (a)+(b): the swapped tree rendered, the window is closed.
                // webroot.staging / update-slim.zip can only be leftovers of an interrupted attempt by
                // (c) + the tag/stamp agreement. webroot.failed is rollback debris. webroot.next is an
                // interrupted materialisation whose only writer (HostService.materialiseContent) skips
                // every tree whose stamp starts with "updated:", so (b) proves it will never be reused.
                for (String name : new String[] {
                        "webroot.old", "webroot.staging", "update-slim.zip", "webroot.failed", "webroot.next" }) {
                    File f = new File(files, name);
                    if (!f.exists()) continue;
                    rm(f);
                    if (freed.length() > 0) freed.append(',');
                    freed.append(name);
                }
                // marker LAST: if the process dies during the deletions above, the next launch resumes
                // them (rm is idempotent) instead of leaving a half-deleted rollback copy behind forever.
                prefs.edit().putString(PREF_RELEASED_TAG, tag).commit();
                diag(ctx, "release", "released for " + tag
                        + (freed.length() > 0 ? ": " + freed : " (nothing left)"));
            } finally {
                IN_FLIGHT.set(false); // the mutex covers gate-check + deletions + marker, nothing else
            }
        } catch (Throwable t) {
            diag(ctx, "release", String.valueOf(t)); // silent degrade: usage never depends on this
        }
    }

    /** One line into filesDir/diag.log (MainActivity.appendDiagLog format); never throws. */
    private static void diag(Context ctx, String tag, String msg) {
        try (FileOutputStream out = new FileOutputStream(new File(ctx.getFilesDir(), "diag.log"), true)) {
            out.write((System.currentTimeMillis() + " " + tag + ": " + msg + "\n")
                    .getBytes(StandardCharsets.UTF_8));
        } catch (Throwable ignored) {
        }
    }

    /** Whole file as UTF-8, or null when it cannot be read (gate reads must never abort a caller). */
    private static String readTextOrNull(File f) {
        try {
            return readTextFile(f);
        } catch (IOException e) {
            return null;
        }
    }

    // ------------------------------------------------------------------
    // Network / hashing / assets
    // ------------------------------------------------------------------

    private static HttpURLConnection open(URL url, int connMs, int readMs) throws IOException {
        String proto = url.getProtocol();
        String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.ROOT);
        if (!"https".equals(proto)) throw new IOException("non-https");
        if (!ALLOWED_HOSTS.contains(host)) throw new IOException("host not allowed: " + host);
        if (isLocalOrPrivateLiteral(host)) throw new IOException("private host rejected");
        HttpsURLConnection c = (HttpsURLConnection) url.openConnection();
        c.setConnectTimeout(connMs);
        c.setReadTimeout(readMs);
        c.setInstanceFollowRedirects(false); // redirects are followed manually, one validated hop at a time
        c.setRequestProperty("User-Agent", "stronghold-shell");
        return c;
    }

    private static boolean isLocalOrPrivateLiteral(String host) {
        if (host.equals("localhost") || host.endsWith(".localhost") || host.endsWith(".local")
                || host.endsWith(".internal")) return true;
        if (!host.matches("\\d{1,3}(\\.\\d{1,3}){3}")) return false;
        String[] parts = host.split("\\.");
        int a = Integer.parseInt(parts[0]);
        int b = Integer.parseInt(parts[1]);
        if (a == 10 || a == 127 || a == 0) return true;
        if (a == 169 && b == 254) return true;
        if (a == 172 && b >= 16 && b <= 31) return true;
        if (a == 192 && b == 168) return true;
        if (a == 100 && b >= 64 && b <= 127) return true;
        return a >= 224;
    }

    private static String httpGet(String url) {
        if (!ServerList.isPublicHttpUrl(url)) return null;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(6000);
            c.setReadTimeout(6000);
            c.setRequestProperty("User-Agent", "stronghold-shell");
            if (c.getResponseCode() != 200) return null;
            return ServerList.readAll(c.getInputStream());
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static String sha256(File f) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            try (InputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[128 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            }
            byte[] d = md.digest();
            StringBuilder sb = new StringBuilder(64);
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException("SHA-256 unavailable", e);
        }
    }

    private static String readAsset(Context ctx, String name) {
        try (InputStream in = ctx.getAssets().open(name)) {
            return ServerList.readAll(in);
        } catch (IOException e) {
            return null;
        }
    }

    /** "/assets/..." → CDN absolute URLs in the manifest JSONs (plain text rewrite, no parsing). */
    private static void transformManifests(File dataDir) {
        for (String name : new String[] { "assets.json", "local-assets.json" }) {
            File f = new File(dataDir, name);
            if (!f.isFile()) continue;
            try {
                String text = new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
                String transformed = text.replace("\"/assets/", "\"" + Line.ASSETS_CDN_PREFIX);
                java.nio.file.Files.write(f.toPath(), transformed.getBytes(StandardCharsets.UTF_8));
            } catch (IOException ignored) {
                // a malformed manifest only means no CDN rewrite for that file; the update still lands
            }
        }
    }

    private static void rm(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) rm(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    @SuppressWarnings("unused")
    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }
}
