package icu.jiangjiangze.stronghold;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Foreground service that keeps the embedded Node game server alive while the
 * player hosts a room ("房主模式"). Android kills background work when the screen
 * goes off; the sticky foreground notification is what makes the room survive.
 *
 * The server needs real files (Node cannot read APK assets), so on first host
 * start the bundled webroot is materialised into filesDir/webroot — the same
 * directory the hot-updater writes to, so updated content is picked up here too.
 */
public class HostService extends Service {

    public static final String CHANNEL_ID = "host-server";
    public static final int NOTIFICATION_ID = 42;
    public static final int PORT = 3000;

    private static volatile boolean serviceUp = false;

    public static boolean isUp() {
        return serviceUp;
    }

    /** The directory the embedded server (and the WebView interceptor) treat as webroot. */
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
            // a leaf: copy bytes
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
                .setContentText("房间在等你回来；关闭本通知前请先结束对局")
                .setOngoing(true)
                .build();
        startForeground(NOTIFICATION_ID, notification);

        try {
            materialiseContent(this);
        } catch (IOException e) {
            // content unusable — the service stays up but the server cannot start;
            // MainActivity surfaces the failure through NodeRunner state / healthz.
        }
        File root = contentRoot(this);
        if (new File(root, "server/index.js").isFile()) {
            // HOST=:: on Node binds dual-stack: IPv4 (incl. ZeroTier/LAN) and IPv6 both reach the room.
            NodeRunner.start(root.getAbsolutePath(), "server/index.js", PORT, "::");
        }
        serviceUp = true;
        return START_STICKY;
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
