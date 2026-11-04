package icu.jiangjiangze.stronghold;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

/**
 * APK 在线统计：启动时上报一次匿名心跳（2026-11-04）。
 *
 * <p><b>为什么需要它</b>：管理后台要回答「现在有多少台设备在用这个 APK」。游戏服自己的
 * {@code /healthz} 只能看到「正在房间里的人」，看不到「开着 APK 但没进房」；而且那台服的
 * healthz 需要 ModelScope 令牌，匿名取不到。所以只能自己数。
 *
 * <p><b>隐私设计（硬约束）</b>：安装 ID 是本机首次启动时生成的 16 字节随机串（Base64URL，
 * 约 22 字符），存在 {@code filesDir/install-id.txt}。
 * <ul>
 *   <li>不含 IMEI / MAC / Android ID / 序列号 / 账号 —— 那些都要权限或本身就是设备标识；</li>
 *   <li>不申请任何 Android 权限（{@code getFilesDir()} 是应用私有目录，无需权限；网络用已有
 *       的 INTERNET 权限，那是壳本来就要的）；</li>
 *   <li>上报内容只有：安装 ID、versionCode、versionName。**不报 IP（服务端也不存）、
 *       不报机型、不报系统版本、不报地理位置**；</li>
 *   <li>卸载重装会换新 ID（这是刻意的：让「设备数」而不是「人」被统计）。</li>
 * </ul>
 *
 * <p><b>失败静默</b>：离线、服务端 5xx、超时——全部只写一行 diag，绝不重试、绝不阻塞启动、
 * 绝不抛给调用方。统计不是功能，坏了不能让玩家感知。
 *
 * <p><b>发送时机</b>：只在冷启动发一次（{@code MainActivity.onCreate}）。不做定期心跳——
 * 那会把请求量放大两个数量级，而 Deno 免费额度只有 1M 请求/月。
 */
final class ApkHeartbeat {

    private static final String TAG = "ApkHeartbeat";
    private static final String ENDPOINT = "https://arknights-gateway.jingjiangze.deno.net/api/apk/heartbeat";
    private static final String ID_FILE = "install-id.txt";
    private static final int CONNECT_TIMEOUT_MS = 6000;
    private static final int READ_TIMEOUT_MS = 6000;

    private ApkHeartbeat() {}

    /**
     * 启动时调用一次：后台线程发心跳。立即返回，不阻塞 UI。
     *
     * @param ctx 任意 context（内部取 application context）
     */
    static void reportOnce(final Context ctx) {
        try {
            if (ctx == null) return;
            final Context app = ctx.getApplicationContext() != null ? ctx.getApplicationContext() : ctx;
            Thread t = new Thread(() -> {
                try {
                    String id = installId(app);
                    if (id == null) return;
                    send(app, id);
                } catch (Throwable ignored) {
                    // 统计失败绝不能影响启动。
                }
            }, "apk-heartbeat");
            t.setDaemon(true);
            t.start();
        } catch (Throwable ignored) {
        }
    }

    /**
     * 取安装 ID；不存在就生成一个并落盘。
     *
     * <p>用 {@code SecureRandom} 生成 16 字节 → Base64URL 无填充（22 字符），
     * 服务端校验规则是 {@code [A-Za-z0-9_-]{8,64}}，这个形状正好符合。
     *
     * <p>落盘失败（存储满/权限异常）时返回 null —— 宁可不报，也不要用一个每次启动都变的
     * 假 ID 把「设备数」统计成天文数字。
     */
    private static String installId(Context ctx) {
        File f = new File(ctx.getFilesDir(), ID_FILE);
        try {
            if (f.isFile()) {
                String s = readText(f).trim();
                if (s.length() >= 8 && s.length() <= 64) return s;
                // 文件损坏（被截断/写入中断）：删掉重建
                f.delete();
            }
            byte[] raw = new byte[16];
            new SecureRandom().nextBytes(raw);
            String id = base64Url(raw);
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(id.getBytes(StandardCharsets.UTF_8));
            }
            return id;
        } catch (Throwable t) {
            Log.w(TAG, "install id unavailable: " + t);
            return null;
        }
    }

    /** 无填充的 Base64URL（JVM 的 java.util.Base64 在 minSdk 26 可用，项目已用它）。 */
    private static String base64Url(byte[] raw) {
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
    }

    private static String readText(File f) throws IOException {
        try (InputStream in = new java.io.FileInputStream(f)) {
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[512];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            return buf.toString("UTF-8");
        }
    }

    /** 发一次心跳。成功/失败都不影响调用方（调用方已在 try/catch 里）。 */
    private static void send(Context ctx, String id) throws Exception {
        JSONObject body = new JSONObject();
        body.put("id", id);
        body.put("vc", BuildConfig.VERSION_CODE);
        body.put("vn", BuildConfig.VERSION_NAME);
        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);

        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(ENDPOINT).openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(CONNECT_TIMEOUT_MS);
            c.setReadTimeout(READ_TIMEOUT_MS);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Accept", "application/json");
            c.setFixedLengthStreamingMode(payload.length);
            try (OutputStream out = c.getOutputStream()) {
                out.write(payload);
            }
            int code = c.getResponseCode();
            // 200/201 = 已记账；429 = 限流（不重试）；4xx/5xx 一律静默。
            if (code != 200 && code != 201) {
                Log.i(TAG, "heartbeat HTTP " + code);
            }
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
