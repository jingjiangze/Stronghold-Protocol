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
    public static void materialiseContent(Context ctx) throws IOException {
        File root = contentRoot(ctx);
        copyAssetDir(ctx, "webroot", root);
    }

    public static void copyAssetDir(Context ctx, String assetPath, File targetDir) throws IOException {
        String[] list = ctx.getAssets().list(assetPath);
        if (list == null || list.length == 0) {
            File out = targetDir;
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
            return;
        }
        if (!targetDir.isDirectory() && !targetDir.mkdirs() && !targetDir.isDirectory()) {
            throw new IOException("mkdirs failed: " + targetDir);
        }
        for (String name : list) {
            copyAssetDir(ctx, assetPath + "/" + name, new File(targetDir, name));
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
        Notification notification = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle("卫戍协议 · 房主服务运行中")
                .setContentText("点按可编辑服务器参数；房间在等你回来")
                .setContentIntent(MainActivity.hostParamsPendingIntent(this))
                .setOngoing(true)
                .build();
        startForeground(NOTIFICATION_ID, notification);

        try {
            materialiseContent(this);
        } catch (IOException e) {
            // content unusable — MainActivity surfaces it through the healthz wait
        }
        File root = contentRoot(this);
        if (new File(root, "server/index.js").isFile()) {
            HostParams params = HostParams.load(this);
            PORT = params.port;
            String dirUrl = directoryUrl(this);
            // HOST=:: binds dual-stack: ZeroTier / LAN / IPv6 / loopback all reach the room
            NodeRunner.start(root.getAbsolutePath(), "server/index.js", params.port,
                    params.hostBind, params.envPairs(dirUrl));
            startPublisher(params.port, dirUrl);
        }
        serviceUp = true;
        return START_STICKY;
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
                            JSONObject body = addressesJson()
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

    private static JSONObject addressesJson() {
        JSONObject o = new JSONObject();
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
                        if (!o.has(key)) o.put(key, "http://" + a.getHostAddress() + ":3000");
                    } else if (!o.has("v6")) {
                        o.put("v6", "http://[" + a.getHostAddress().split("%")[0] + "]:3000");
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return o;
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
        serviceUp = false;
        super.onDestroy();
    }
}
