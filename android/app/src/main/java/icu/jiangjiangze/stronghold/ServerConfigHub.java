package icu.jiangjiangze.stronghold;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 服务器配置的 Android 侧接线（方案 §4/§15）——把 {@link ServerConfigStore} 的纯逻辑接到
 * {@code filesDir} 与真实网络，并持有**进程级快照**，让「刷新成功」对业务代码立即可见。
 *
 * <p>职责边界（刻意收得很窄）：
 * <ul>
 *   <li>何时刷新（进入服务器 / 切服 / TTL 到期 / 手动）——{@link #ensureFresh}</li>
 *   <li>当前 origin 的配置快照——{@link #current}</li>
 *   <li>变化通知——{@link #addListener}</li>
 * </ul>
 * 解析/校验/缓存/版本比较全在 {@link ServerConfigStore} 与 {@link ServerConfig}，本类不含规则，
 * 因此不需要单测去覆盖「规则」——规则测试在 JVM 侧跑（见 {@code tools/apk/jvm/ServerConfigCheck.java}）。
 *
 * <p><b>不含任何 webroot/ArtStore/Updater 逻辑</b>：那三者职责稳定，服务器配置不往里面塞
 * （方案 §4 硬要求）。
 */
public final class ServerConfigHub {

    /** 网络超时：配置是「有就用、没有照常玩」的东西，绝不能拖慢启动。 */
    private static final int CONNECT_MS = 5000;
    private static final int READ_MS = 5000;
    /** 单次响应上限（与服务端 max body 同值；多读一个字节都算超限 → 整份丢弃）。 */
    private static final int MAX_BYTES = ServerConfig.MAX_BODY_BYTES;

    /** 进程级快照：当前 origin 的配置。null = 还没有可用配置（不是错误状态）。 */
    private static volatile ServerConfig snapshot;
    /** snapshot 对应的 origin；切服时用它判断要不要换。 */
    private static volatile String snapshotOrigin = "";
    /** 快照被采用的时间（用于 TTL 判断）。 */
    private static volatile long snapshotAt;
    private static final Object LOCK = new Object();
    /** 单飞：一次只允许一个刷新在跑（进页面/切服/TTL 三个触发点会给同一目标各发一次）。 */
    private static final AtomicBoolean IN_FLIGHT = new AtomicBoolean(false);
    private static final CopyOnWriteArrayList<Listener> LISTENERS = new CopyOnWriteArrayList<>();

    private ServerConfigHub() {
    }

    /** 配置变化通知。回调发生在刷新线程，UI 侧请自行切主线程。 */
    public interface Listener {
        void onServerConfigChanged(ServerConfig config, String origin);
    }

    private static Context appContext;

    /** 由 MainActivity.onCreate 调一次，之后所有静态入口都有 Context 可用。 */
    public static void init(Context ctx) {
        if (ctx != null) appContext = ctx.getApplicationContext();
    }

    /** 当前配置快照；没有可用配置时返回 null（调用方必须能接受 null）。 */
    public static ServerConfig current() {
        return snapshot;
    }

    /** 当前快照对应的 origin（诊断用）。 */
    public static String currentOrigin() {
        return snapshotOrigin;
    }

    /** 快照采用时间（epoch ms）；0 = 无快照。 */
    public static long currentAt() {
        return snapshotAt;
    }

    public static void addListener(Listener l) {
        if (l != null) LISTENERS.addIfAbsent(l);
    }

    public static void removeListener(Listener l) {
        if (l != null) LISTENERS.remove(l);
    }

    /**
     * 切服/离开服务器时调用：丢弃上一个服务器的快照。**必须**在切服时调用，否则会把 A 服的
     * 公告/开关继续用在 B 服上（跨服串味）。
     */
    public static void onOriginChanged() {
        synchronized (LOCK) {
            snapshot = null;
            snapshotOrigin = "";
            snapshotAt = 0;
        }
    }

    /**
     * 「有需要就刷新」——唯一的正常入口。TTL 未过且 origin 未变时是纯内存判断，不发请求。
     *
     * @param origin 当前页面 origin（如 {@code https://stronghold.jiangjiangze.icu}）
     */
    public static void ensureFresh(String origin) {
        if (appContext == null || origin == null || origin.isEmpty()) return;
        if (!origin.equals(snapshotOrigin)) {
            // 切服：先把上一个服务器的 last-good 装载进来（离线也有配置），再决定要不要联网。
            // 这一步是同步的（只读文件），不阻塞启动 —— 读盘失败就是 null，与今天行为一致。
            ServerConfigStore.Cached c = ServerConfigStore.load(appContext.getFilesDir(), origin);
            synchronized (LOCK) {
                snapshotOrigin = origin;
                snapshot = c.config;
                snapshotAt = c.fetchedAt;
            }
            refreshAsync(origin);
            return;
        }
        if (ServerConfigStore.isStale(new ServerConfigStore.Cached(snapshot, snapshotAt, "", "", ""),
                System.currentTimeMillis())) {
            refreshAsync(origin);
        }
    }

    /** 手动/强制刷新（桥接与面板用）。异步，不阻塞调用线程。 */
    public static void refreshAsync(String origin) {
        if (appContext == null || origin == null || origin.isEmpty()) return;
        if (!IN_FLIGHT.compareAndSet(false, true)) return;
        final Context ctx = appContext;
        Thread t = new Thread(() -> {
            try {
                refreshBlocking(ctx, origin);
            } finally {
                IN_FLIGHT.set(false);
            }
        }, "server-config");
        t.start();
    }

    /**
     * 同步刷新（测试/诊断用；**不要**在 UI 线程调用）。
     *
     * @return 是否拿到了与调用前不同的可用配置
     */
    public static boolean refreshBlocking(Context ctx, String origin) {
        ServerConfigStore.Cached c = ServerConfigStore.refresh(ctx.getFilesDir(), origin,
                new ServerConfigStore.Fetcher() {
                    @Override
                    public ServerConfigStore.Response fetch(String url, String etag) throws IOException {
                        return httpGet(url, etag);
                    }
                }, System.currentTimeMillis());
        if (c == null || c.config == null) return false;
        boolean changed;
        synchronized (LOCK) {
            changed = snapshot == null || snapshot.version() != c.config.version();
            snapshot = c.config;
            snapshotOrigin = origin;
            snapshotAt = c.fetchedAt;
        }
        // 内容没变就不打扰 UI：面板每 60s 轮询一次，通知风暴没有意义。
        if (changed) {
            for (Listener l : LISTENERS) {
                try {
                    l.onServerConfigChanged(c.config, origin);
                } catch (Throwable ignored) {
                }
            }
        }
        return changed;
    }

    /**
     * 一次 GET。**只接受 {@code ServerConfigStore.configUrlFor()} 拼出来的 URL**（host 恒等于当前
     * 页面 origin）—— 由调用链保证，本方法自身再复核一遍 scheme/host，防的是将来有人误用。
     * 不跟随重定向（重定向可能指向任意 host）。
     */
    private static ServerConfigStore.Response httpGet(String url, String etag) throws IOException {
        URL u = new URL(url);
        String scheme = u.getProtocol() == null ? "" : u.getProtocol().toLowerCase(java.util.Locale.ROOT);
        if (!"http".equals(scheme) && !"https".equals(scheme)) throw new IOException("scheme not allowed");
        String host = u.getHost();
        if (host == null || host.isEmpty()) throw new IOException("no host");
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) u.openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(CONNECT_MS);
            c.setReadTimeout(READ_MS);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "stronghold-shell");
            if (etag != null && !etag.isEmpty()) c.setRequestProperty("If-None-Match", etag);
            int code = c.getResponseCode();
            if (code == 304) return new ServerConfigStore.Response(304, null, etag);
            if (code != 200) return new ServerConfigStore.Response(code, null, null);
            String body = readCapped(c.getInputStream(), MAX_BYTES);
            if (body == null) throw new IOException("body too large");
            return new ServerConfigStore.Response(200, body, c.getHeaderField("ETag"));
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 读满上限即放弃（返回 null），避免超大响应把内存吃掉。 */
    private static String readCapped(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (out.size() + n > max) return null;
            out.write(buf, 0, n);
        }
        return out.toString("UTF-8");
    }

    /** 缓存根目录（诊断/清理用）。 */
    public static File rootOf(File filesDir) {
        return new File(filesDir, "server-config");
    }

    /** 测试用：丢弃进程内快照。 */
    static void resetForTest() {
        onOriginChanged();
    }
}
