package icu.jiangjiangze.stronghold;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;

/**
 * Foreground service that keeps the embedded Node game server alive while the
 * player hosts a room ("房主模式"). Android kills background work when the screen
 * goes off; the sticky foreground notification is what makes the room survive.
 *
 * The server needs real files (Node cannot read APK assets), so on first host
 * start the bundled webroot is materialised into filesDir/webroot — the same
 * directory the hot-updater writes to, so updated content is picked up here too.
 *
 * The publisher thread auto-registers every room this host creates with the
 * directory service (房号 → 本机地址), refreshing every 60 s while the service
 * lives; players only ever need the 4-letter room code.
 */
public class HostService extends Service {

    public static final String CHANNEL_ID = "host-server";
    public static final int NOTIFICATION_ID = 42;
    public static int PORT = 3000;

    private static volatile boolean serviceUp = false;
    private static volatile boolean publisherOn = false;
    /** v2.7.5: set once the node's handshake.json reports a working server (READY semantics). */
    private static volatile boolean handshakeReady = false;
    /** v2.9.3: the node's last startup failure, for the diagnostic dialog (null when none/healthy). */
    private static volatile String handshakeError = null;
    /**
     * How long the handshake watcher keeps polling for a fresh handshake. This must cover the UI's
     * own start timeout (60 s, up to 120 s on slow devices): a low-end phone can need well over the
     * old 12 s to cold-start Node, and giving up early made the service look permanently not-READY.
     */
    private static final long HANDSHAKE_WATCH_MS = 120_000;
    /**
     * Restart generation (v2.7.3). stopService→startForegroundService in the same frame let the
     * OLD instance's onDestroy run AFTER the NEW onStartCommand and kill the freshly spawned node
     * (30 s healthz timeout), and could also violate startForeground timing (process crash on
     * Android 12+). A restart bumps the generation first; onDestroy only stops the node when its
     * generation is still current — a stale teardown can no longer reach the new process.
     */
    private static final java.util.concurrent.atomic.AtomicInteger GENERATION =
            new java.util.concurrent.atomic.AtomicInteger(0);
    private volatile int myGeneration;

    /** Bumps the generation: any in-flight service instance becomes stale. Call before starting. */
    public static void nextGeneration() {
        GENERATION.incrementAndGet();
    }

    public static boolean isUp() {
        return serviceUp;
    }

    /** The directory the shell's hot-updatable config points at (first entry). */
    public static String directoryUrl(Context ctx) {
        ShellConfig cfg = ShellConfig.load(ctx);
        return cfg.directoryUrls().get(0);
    }

    /** The directory the shell's hot-updatable config points at (first entry). */
    public static File contentRoot(Context ctx) {
        return new File(ctx.getFilesDir(), "webroot");
    }

    public static boolean contentMaterialised(Context ctx) {
        return new File(contentRoot(ctx), "server/index.js").isFile();
    }

    /** Copies the bundled webroot out of the APK into filesDir (idempotent per file). */
    /** Progress callback for the loading screen (copied, total); null-safe. */
    public interface Progress {
        void onProgress(int copied, int total);
    }

    /** Non-dot name: aapt drops dotfiles under assets/ (the old ".stamp" never shipped in any APK). */
    public static final String STAMP_NAME = "stamp.txt";
    /** Written into an updater-swapped tree: marks it newer than anything embedded in the APK. */
    public static final String UPDATED_PREFIX = "updated:";

    /**
     * Materialises the bundled webroot into filesDir — with the version stamp + per-file skip logic:
     *   - tree stamped "updated:*"  → skip entirely (a hot update owns this tree; embedded must not clobber it)
     *   - tree stamp == asset stamp → skip entirely (already materialised)
     *   - otherwise copy, skipping files whose on-disk size already matches the (uncompressed) asset
     * This turns the old full 433 MB re-copy on every cold start into a no-op after the first launch.
     */
    /** Slim-set top-level names the on-device host server needs (assets are APK-local / CDN — never copied). */
    private static final String[] SLIM_FALLBACK = {
            "index.html", "data.js", "js", "css", "vendor", "fonts", "shared", "sim", "data", "server",
            "package.json", "node_modules"
    };

    /**
     * Materialises the SLIM webroot (code + host runtime deps only, ~45 MB instead of 433 MB) into
     * filesDir — version stamp first, then an atomic swap:
     *   - tree stamped "updated:*"  → skip (a hot update owns this tree)
     *   - tree stamp == asset stamp → skip (already materialised)
     *   - otherwise build filesDir/webroot.next, then rename next → webroot (a half-written tree is
     *     never visible — the class of crash this replaces)
     * The completion callback always fires (finally) so the loading UI can never hang at 99%.
     */
    public static void materialiseContent(Context ctx, Progress progress) throws IOException {
        File root = contentRoot(ctx);
        String assetStamp = readAssetText(ctx, "webroot/" + STAMP_NAME);
        String treeStamp = readText(new File(root, STAMP_NAME));
        if (treeStamp != null && treeStamp.startsWith(UPDATED_PREFIX)) {
            if (progress != null) progress.onProgress(1, 1);
            return;
        }
        if (assetStamp != null && assetStamp.equals(treeStamp)
                && new File(root, "server/index.js").isFile()) {
            if (progress != null) progress.onProgress(1, 1);
            return;
        }

        java.util.List<String> tops = readSlimTops(ctx);
        File next = new File(ctx.getFilesDir(), "webroot.next");
        File old = new File(ctx.getFilesDir(), "webroot.old");
        rm(next);
        rm(old);
        int total = 0;
        for (String t : tops) total += countAssetFiles(ctx, "webroot/" + t);
        int[] counter = new int[] { 0, Math.max(1, total) };
        try {
            for (String t : tops) {
                copyAssetDir(ctx, "webroot/" + t, new File(next, t), counter, progress);
            }
        } finally {
            if (progress != null) progress.onProgress(counter[1], counter[1]);
        }
        if (assetStamp != null) {
            writeText(new File(next, STAMP_NAME), assetStamp);
        }
        if (root.isDirectory() && !root.renameTo(old)) throw new IOException("cannot park the old webroot");
        if (!next.renameTo(root)) {
            if (old.isDirectory()) {
                //noinspection ResultOfMethodCallIgnored
                old.renameTo(root);
            }
            throw new IOException("cannot activate the new webroot");
        }
        rm(old);
    }

    /** The slim set: assets/webroot/slim-manifest.txt (written by build-webroot), or a built-in fallback. */
    private static java.util.List<String> readSlimTops(Context ctx) {
        java.util.List<String> out = new java.util.ArrayList<>();
        String text = readAssetText(ctx, "webroot/slim-manifest.txt");
        if (text != null) {
            for (String line : text.split("\n")) {
                String t = line.trim();
                if (!t.isEmpty()) out.add(t);
            }
        }
        if (out.isEmpty()) {
            for (String t : SLIM_FALLBACK) out.add(t);
            out.add(STAMP_NAME);
        } else if (!out.contains(STAMP_NAME)) {
            out.add(STAMP_NAME);
        }
        return out;
    }

    private static void rm(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) rm(k);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    public static void copyAssetDir(Context ctx, String assetPath, File targetDir) throws IOException {
        copyAssetDir(ctx, assetPath, targetDir, null, null);
    }

    private static void copyAssetDir(Context ctx, String assetPath, File targetDir,
                                     int[] counter, Progress progress) throws IOException {
        String[] list = ctx.getAssets().list(assetPath);
        if (list == null || list.length == 0) {
            File out = targetDir;
            long assetLen = -1;
            try (android.content.res.AssetFileDescriptor fd = ctx.getAssets().openFd(assetPath)) {
                assetLen = fd.getLength();
            } catch (IOException ignored) {
                // compressed asset: length unknown → copy unconditionally
            }
            if (assetLen >= 0 && out.isFile() && out.length() == assetLen) {
                if (counter != null) counter[0]++;
                return; // already materialised at the right size
            }
            File parent = out.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
                throw new IOException("mkdirs failed: " + parent);
            }
            try (InputStream in = ctx.getAssets().open(assetPath);
                 OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            if (counter != null) {
                counter[0]++;
                if (progress != null && counter[0] % 64 == 0) progress.onProgress(counter[0], counter[1]);
            }
            return;
        }
        if (!targetDir.isDirectory() && !targetDir.mkdirs() && !targetDir.isDirectory()) {
            throw new IOException("mkdirs failed: " + targetDir);
        }
        for (String name : list) {
            copyAssetDir(ctx, assetPath + "/" + name, new File(targetDir, name), counter, progress);
        }
    }

    private static int countAssetFiles(Context ctx, String assetPath) {
        try {
            String[] list = ctx.getAssets().list(assetPath);
            if (list == null || list.length == 0) return 1;
            int n = 0;
            for (String name : list) n += countAssetFiles(ctx, assetPath + "/" + name);
            return n;
        } catch (IOException e) {
            return 1;
        }
    }

    private static String readAssetText(Context ctx, String path) {
        try (InputStream in = ctx.getAssets().open(path)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8").trim();
        } catch (IOException e) {
            return null;
        }
    }

    private static String readText(File f) {
        if (f == null || !f.isFile()) return null;
        try (InputStream in = new java.io.FileInputStream(f)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8").trim();
        } catch (IOException e) {
            return null;
        }
    }

    private static void writeText(File f, String text) {
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (IOException ignored) {
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "房主服务", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("保持联机房间在线");
        nm.createNotificationChannel(ch);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        myGeneration = GENERATION.get(); // a later nextGeneration() makes THIS instance stale
        Notification notification = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle("卫戍协议 · 房主服务运行中")
                .setContentText("点按可编辑服务器参数；房间在等你回来")
                .setContentIntent(MainActivity.hostParamsPendingIntent(this))
                .setOngoing(true)
                .build();
        try {
            startForeground(NOTIFICATION_ID, notification);
        } catch (Exception e) {
            // Android 12+ can refuse startForeground during lifecycle races (same-frame
            // stop/start). The game server works fine as a background service; crashing the
            // process over it would be worse (user-reported: 超时后闪退).
        }

        try {
            materialiseContent(this, null);
        } catch (IOException e) {
            // content unusable — MainActivity surfaces it through the healthz wait
        }
        File root = contentRoot(this);
        // v2.9.3: mark the service up BEFORE spawning the watcher/publisher. They gate their loops
        // on serviceUp, so setting it afterwards let a freshly started thread observe false and exit
        // instantly — the watcher would then never adopt the handshake.
        serviceUp = true; // "service intent running"; isUp() below refines to READY via handshake
        if (new File(root, "server/index.js").isFile()) {
            HostParams params = HostParams.load(this);
            PORT = params.port; // fallback; replaced by the handshake port once Node reports it
            String dirUrl = directoryUrl(this);
            // Termux Node child process (v2.7.5): the dedicated entry binds port 0 and writes
            // handshake.json with the REAL port; a watcher thread adopts it into PORT.
            // v2.9.3: cwd stays the webroot (entry/upstreamEntry/HOME resolve against it) while the
            // run/ workspace (launch.json/server.log/handshake.json) is anchored at filesDir — the
            // same base the bootstrap, this watcher and MainActivity's diagnostics all use, and a
            // base that a content hot-update can no longer wipe.
            NodeRunner.start(getApplicationInfo().nativeLibraryDir, root.getAbsolutePath(),
                    getFilesDir().getAbsolutePath(),
                    params.port, params.hostBind, params.spCombat, params.spVerify,
                    params.trustProxy, dirUrl);
            startHandshakeWatcher();
            startPublisher(params.port, dirUrl);
        }
        return START_STICKY;
    }

    /**
     * v2.7.5: the node writes filesDir/run/handshake.json when it is actually serving (healthz
     * 200). Until then the service is STARTING, not READY — isUp() used to be true the instant
     * the service started, even if the node died instantly (the "fake running state").
     */
    private void startHandshakeWatcher() {
        handshakeError = null;
        Thread t = new Thread(() -> {
            File f = new File(new File(getFilesDir(), "run"), "handshake.json");
            long deadline = System.currentTimeMillis() + HANDSHAKE_WATCH_MS;
            // v2.9.3: poll for as long as THIS service generation is live (bounded by
            // HANDSHAKE_WATCH_MS), instead of a fixed 12 s. A failure handshake no longer returns
            // early — its reason is stashed for the diagnostic dialog and polling continues, since
            // the node's own self-heal relaunch may yet write a good handshake.
            while (myGeneration == GENERATION.get() && serviceUp
                    && System.currentTimeMillis() < deadline) {
                if (f.isFile()) {
                    try {
                        JSONObject h = new JSONObject(new String(
                                java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
                        if (h.optBoolean("ok") && h.optInt("port", 0) >= 1024) {
                            PORT = h.getInt("port");
                            handshakeError = null;
                            handshakeReady = true;
                            return;
                        }
                        if (!h.optBoolean("ok") && h.has("error")) {
                            // stay not-READY; keep the reason for diagnostics and keep polling
                            handshakeError = h.optString("error", "node startup failed");
                        }
                    } catch (Exception ignored) {
                        // partial write → keep polling
                    }
                }
                sleep(500);
            }
        }, "handshake-watcher");
        t.setDaemon(true);
        t.start();
    }

    /** True only when the node reported a working server (v2.7.5 READY semantics). */
    public static boolean isReady() {
        return handshakeReady && NodeRunner.isAlive();
    }

    /** The node's last reported startup failure, for the diagnostic dialog (null when none). */
    public static String handshakeError() {
        return handshakeError;
    }

    /** Auto-registers created rooms with the directory service while hosting. */
    private void startPublisher(int port, String dirUrl) {
        if (publisherOn || dirUrl == null || dirUrl.isEmpty()) return;
        publisherOn = true;
        Thread t = new Thread(() -> {
            // give the server a moment to boot before the first publish
            for (int i = 0; i < 20; i++) {
                sleep(1500);
                if (healthzOk(port)) break;
            }
            while (serviceUp) {
                try {
                    JSONObject rooms = getJson("http://127.0.0.1:" + port + "/_shell/rooms");
                    org.json.JSONArray arr = rooms.optJSONArray("rooms");
                    if (arr != null) {
                        for (int i = 0; i < arr.length(); i++) {
                            JSONObject room = arr.optJSONObject(i);
                            if (room == null) continue;
                            String code = room.optString("code", "");
                            if (code.isEmpty()) continue;
                            // 发布端口用 handshake 采纳的真实端口（PORT 字段）：Node 以 port 0 起
                            // 服务、OS 随机分配，写死 3000 的旧地址对不上任何监听（审计 §4）。
                            JSONObject body = addressesJson(PORT)
                                    .put("code", code)
                                    .put("name", "host")
                                    .put("mode", room.optString("mode", "coop"));
                            postJson(dirUrl + "/rooms", body);
                        }
                    }
                } catch (Exception ignored) {
                    // directory unreachable — retried on the next beat
                }
                sleep(60_000);
            }
        }, "host-publisher");
        t.setDaemon(true);
        t.start();
    }

    /**
     * 本机对外地址表（目录发布用）。
     * @param port handshake 采纳的真实监听端口（绝不再写死 3000，审计 §4）
     */
    private static JSONObject addressesJson(int port) {
        JSONObject o = new JSONObject();
        if (port < 1024 || port > 65535) port = 3000; // handshake 未就绪时的保守回退
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            while (nis != null && nis.hasMoreElements()) {
                NetworkInterface ni = nis.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                String name = ni.getName() == null ? "" : ni.getName().toLowerCase();
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isAnyLocalAddress()) continue;
                    if (a instanceof Inet4Address) {
                        String key = name.startsWith("zt") ? "zt" : "lan";
                        if (!o.has(key)) o.put(key, "http://" + a.getHostAddress() + ":" + port);
                    } else if (!o.has("v6") && isGlobalUnicastV6(a)) {
                        // 只发布全局单播 2000::/3：ULA fc00::/7（fd00::/8 常见）不是公网可达地址，
                        // 发上去只会让加入方在不可路由的地址上白白超时（审计 §4）。
                        o.put("v6", "http://[" + a.getHostAddress().split("%")[0] + "]:" + port);
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return o;
    }

    /**
     * 全局单播 IPv6 判定（审计 §4）：2000::/3 —— 首字节 0x20–0x3f。该判定天然排除本任务要求
     * 的全部非公开范围：链路本地 fe80::/10（0xfe）、ULA fc00::/7（0xfc/0xfd）、NAT64
     * 64:ff9b::/96（0x64）、映射/兼容形态 ::ffff:x 与 ::x.x.x.x（0x00）、环回 ::1（0x00）——
     * 它们的首字节都落在 0x20–0x3f 之外，无需逐条再判。
     */
    private static boolean isGlobalUnicastV6(InetAddress a) {
        if (!(a instanceof java.net.Inet6Address)) return false;
        byte[] b = a.getAddress();
        if (b.length != 16) return false;
        int first = b[0] & 0xff;
        return first >= 0x20 && first <= 0x3f;
    }

    private static JSONObject getJson(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(4000);
        c.setReadTimeout(4000);
        c.setRequestProperty("User-Agent", "host-publisher");
        if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        try (InputStream in = c.getInputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        c.disconnect();
        return new JSONObject(out.toString("UTF-8"));
    }

    private static void postJson(String url, JSONObject body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(4000);
        c.setReadTimeout(4000);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("User-Agent", "host-publisher");
        try (OutputStream os = c.getOutputStream()) {
            os.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        int code = c.getResponseCode();
        c.disconnect();
        if (code != 200) throw new IOException("HTTP " + code);
    }

    private static boolean healthzOk(int port) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/healthz").openConnection();
            c.setConnectTimeout(2000);
            c.setReadTimeout(2000);
            boolean ok = c.getResponseCode() == 200;
            c.disconnect();
            return ok;
        } catch (IOException e) {
            return false;
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        // v2.9.3: a stale teardown (this instance was already superseded by a restart) must be
        // COMPLETELY inert — it may neither stop the freshly spawned node nor clear the new
        // instance's READY/handshake state. Guard the whole teardown on the generation.
        if (myGeneration == GENERATION.get()) {
            serviceUp = false;
            handshakeReady = false; // next start must wait for a fresh handshake
            handshakeError = null;
            NodeRunner.stop();
        }
        super.onDestroy();
    }
}
