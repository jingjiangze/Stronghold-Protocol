package icu.jiangjiangze.stronghold;

import android.content.Context;
import android.os.Build;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.spec.MGF1ParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Base64;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.atomic.AtomicInteger;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;
import javax.crypto.spec.SecretKeySpec;

/**
 * 崩溃自动上报（原生侧出口）。
 *
 * <p>为什么要有这个类：设备崩溃此前只能靠 {@code filesDir/crash.log} + 用户截图，现场信息拿不回来。
 * 服务端已经提供 {@code POST /api/crash}（见契约），这里只做「加密 + 发出去」，其余一律不做：
 *
 * <ul>
 *   <li><b>混合加密</b>：正文用一次性 AES-256-GCM 加密，AES key 用服务端公钥做 RSA-OAEP(SHA-256) 包裹。
 *       这样即使明文里有设备型号/栈，传输链路上（代理、日志、CDN）也只有密文；每次上报换新 key，
 *       解密能力只在服务端私钥一侧。</li>
 *   <li><b>失败必须静默</b>：这个类是在崩溃路径上被调用的，任何异常都不能再冒出去——
 *       所有入口 catch (Throwable)，最坏情况只是少一条上报（写一行 diag.log）。</li>
 *   <li><b>不阻塞调用线程</b>：网络与读文件都在私有后台线程；崩溃处理线程要尽快交给
 *       prevHandler（进程随时可能被杀）。</li>
 * </ul>
 *
 * <p>平台细节（实测，改动前先读）：
 * <ul>
 *   <li>Android 的 {@code RSA/ECB/OAEPWithSHA-256AndMGF1Padding} 默认 MGF1 摘要**可能仍是 SHA-1**
 *       （取决于 Conscrypt 版本）。服务端用 WebCrypto 解密，按规范 MGF1 也用 SHA-256，
 *       因此这里必须显式传 {@link OAEPParameterSpec}，否则服务端 400「解密失败」。</li>
 *   <li>{@code AES/GCM/NoPadding} 的 {@code doFinal()} 在 Android 上返回的就是「密文 || 16 字节 tag」，
 *       与服务端契约一致，**不要**再手动拼 tag（拼了就成了 ct||tag||tag）。</li>
 * </ul>
 */
final class CrashReporter {

    private static final String ENDPOINT = "https://arknights-gateway.jingjiangze.deno.net/api/crash";

    /**
     * 服务端公钥（SPKI DER 的 base64，2048-bit RSA，仅公钥，泄漏无害——泄漏私钥才致命）。
     * 硬编码而不是远端拉取：上报发生在崩溃路径上，多一次网络往返就少一次送达机会；
     * 换密钥属于服务端版本升级，跟 APK 版本一起走。
     */
    private static final String PUBLIC_KEY_B64 =
            "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAt8aL+iAzU/Th40M2z0Z7DcOMQaNf4fEaqNEt/KeJVHohPhFdyqhmCYu7oSx7EqSpvsPBKS+AHG4Sh0IyEjk83lw6e64TwF/M/OGzBgEId0gN3iB3rhY9l0ZaSf2XtE4XESt7JMiTg2Xsovzl9V4L/+5S61VZTvD2AU0bco+OzidMOiN1De0pt74Q6KkJux/C7Ny0/BMhC5/4RZQGOANRG7pSzOThQXoixfDp+dTE9bBJEm55kfay0dqPLFomYSpaoCifYOzWCfQBaJsvgbwcjicF8edv5c2nbKxvsq/QVVpbJPcMOFGbKdEFXkQv0EWS53La/XMru+orYbnioeAuTQIDAQAB";

    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 8000;

    /** 与服务端契约的截断上限（服务端按字符数截，这里先截免得 413）。 */
    private static final int MAX_MESSAGE = 300;
    private static final int MAX_STACK = 2000;
    private static final int MAX_LOG = 2000;

    /** diag.log 尾部最多读这么多字节再截字符（UTF-8 下 4 字节/字，够覆盖 2000 字）。 */
    private static final int LOG_READ_BYTES = 4096;

    /** 崩溃落盘队列上限：崩溃风暴时保留最近 N 条，避免撑爆存储。 */
    private static final int QUEUE_MAX = 20;

    /** 单个队列文件读取上限（与服务端的 CRASH_MAX_BODY 对齐）。 */
    private static final int CRASH_MAX_QUEUE_BYTES = 64 * 1024;

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    /** 本次进程里「已发起、尚未结束」的上报条数（桥方法 crashReportStatus 的 pending）。 */
    private static final AtomicInteger IN_FLIGHT = new AtomicInteger();

    /** 最后一次成功（HTTP 201）拿到的服务端 id；没有就是 null。 */
    private static volatile String lastId = null;

    private CrashReporter() {
    }

    static String publicKeyB64() {
        return PUBLIC_KEY_B64;
    }

    /**
     * 桥方法 {@code shell.crashReportStatus()} 的正文：
     * {@code {"pending":<在途条数>,"lastId":<string|null>}}。
     * 纯内存读取，可以在 JS bridge 线程同步返回。
     */
    static String statusJson() {
        String id = lastId;
        return "{\"pending\":" + IN_FLIGHT.get() + ",\"lastId\":" + (id == null ? "null" : JSONObject.quote(id)) + "}";
    }

    /**
     * 加密一条上报，返回**请求体的 UTF-8 字节**（已经带上 v/ek/iv/ct/fp 五个字段）。
     *
     * @param plainJson 明文 JSON（字段见 {@link #plainJson}），UTF-8
     * @throws Exception 加密不可用/公钥损坏时抛出；调用方必须兜住（本类内部全部兜住）
     */
    static byte[] encryptPayload(String plainJson) throws Exception {
        byte[] key = new byte[32];
        byte[] iv = new byte[12];
        SecureRandom rnd = new SecureRandom();
        rnd.nextBytes(key);
        rnd.nextBytes(iv);

        try {
            // ① 包裹 AES key：显式 SHA-256 + MGF1-SHA-256（见类注释，默认可能是 SHA-1）。
            PublicKey pub = KeyFactory.getInstance("RSA")
                    .generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(PUBLIC_KEY_B64)));
            Cipher rsa = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding");
            rsa.init(Cipher.ENCRYPT_MODE, pub, new OAEPParameterSpec(
                    "SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT));
            byte[] ek = rsa.doFinal(key);

            // ② 正文：一次性 GCM，doFinal 的返回值本身就是「密文 || tag」。
            Cipher aes = Cipher.getInstance("AES/GCM/NoPadding");
            aes.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
            byte[] ct = aes.doFinal(plainJson.getBytes(StandardCharsets.UTF_8));

            // ③ fp 是明文（服务端要能不解密就按它聚合），所以从明文 JSON 里取 message/stack。
            String fp = "";
            try {
                JSONObject p = new JSONObject(plainJson);
                fp = fingerprint(p.optString("message", ""), p.optString("stack", ""));
            } catch (Throwable ignored) {
                fp = fingerprint(plainJson, "");
            }

            Base64.Encoder b64 = Base64.getEncoder();
            JSONObject body = new JSONObject();
            body.put("v", 1);
            body.put("ek", b64.encodeToString(ek));
            body.put("iv", b64.encodeToString(iv));
            body.put("ct", b64.encodeToString(ct));
            body.put("fp", fp);
            return body.toString().getBytes(StandardCharsets.UTF_8);
        } finally {
            // 密钥只活在一次加密里；擦掉引用副本，降低被 dump 出来的价值。
            Arrays.fill(key, (byte) 0);
        }
    }

    /**
     * 崩溃指纹：message 前 80 字 + stack 前 5 行的 SHA-256 十六进制前 32 位（固定 32 字符，≤64）。
     * 同一处崩溃重复触发时指纹稳定，服务端才能去重/计数。
     */
    static String fingerprint(String message, String stack) {
        try {
            StringBuilder sb = new StringBuilder();
            String m = message == null ? "" : message;
            sb.append(m, 0, Math.min(m.length(), 80)).append('\n');
            String s = stack == null ? "" : stack;
            int lines = 0;
            int from = 0;
            for (int i = 0; i <= s.length() && lines < 5; i++) {
                if (i == s.length() || s.charAt(i) == '\n') {
                    sb.append(s, from, i).append('\n');
                    lines++;
                    from = i + 1;
                }
            }
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(sb.toString().getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(32);
            for (int i = 0; i < 16; i++) {
                int b = digest[i] & 0xff;
                hex.append(HEX[b >>> 4]).append(HEX[b & 0x0f]);
            }
            return hex.toString();
        } catch (Throwable t) {
            // 指纹只是聚合键，算不出来也不能影响上报本身。
            return "unavailable";
        }
    }

    /**
     * Java 侧崩溃上报（未捕获异常处理器里调用）。立即返回，网络在后台线程。
     * 绝不影响调用线程的后续逻辑（prevHandler 仍要走）。
     */
    static void reportAsync(Context ctx, String kind, String thread, Throwable e) {
        try {
            String message = e == null ? "" : String.valueOf(e);
            String stack = e == null ? "" : stackText(e);
            submit(ctx, kind, thread, message, stack);
        } catch (Throwable ignored) {
            // 上报器绝不能成为崩溃源。
        }
    }

    /** 进程级 application context 兜底。持有 application context 是安全的：它与进程同生命周期，
     *  不会泄漏 Activity（Activity 传进来会先被 getApplicationContext() 换掉）。
     *  NodeRunner 是纯静态类、手上没有 Context（它的 start() 只收字符串路径），靠它兜住；
     *  由 MainActivity.onCreate 与 HostService.onCreate 两处写入（后者覆盖 sticky 重启的进程）。 */
    private static volatile Context appContext = null;

    /** 记住一个 application context，供没有 Context 参数的调用方（NodeRunner）使用。 */
    static void rememberContext(Context ctx) {
        try {
            if (ctx == null) return;
            appContext = ctx.getApplicationContext() != null ? ctx.getApplicationContext() : ctx;
        } catch (Throwable ignored) {
        }
    }

    /** WebView 页面侧崩溃上报（桥方法 reportWebViewCrash 走这里）。 */
    static void reportWebViewCrash(Context ctx, String message, String stack) {
        try {
            submit(ctx, "webview", "webview", message, stack);
        } catch (Throwable ignored) {
        }
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    private static void submit(final Context ctx, final String kind, final String thread,
                               final String message, final String stack) {
        try {
            final Context app = resolveCtx(ctx);
            if (app == null) return;
            Thread worker = new Thread(() -> {
                // 计数在工作线程里进出：线程都起不来时 pending 不会凭空多一条。
                IN_FLIGHT.incrementAndGet();
                try {
                    post(app, kind, thread, message, stack);
                } catch (Throwable t) {
                    diag(app, "failed: " + t);
                } finally {
                    IN_FLIGHT.decrementAndGet();
                }
            }, "crash-report");
            worker.start();
        } catch (Throwable ignored) {
            // 连线程都起不来（OOM 等）——只能放弃这一条。
        }
    }

    /** 取一个可用 Context：优先传进来的，其次 {@link #rememberContext} 缓存的。
     *  sticky 重启的进程里 Activity 从未创建过（§Q3），只能靠缓存。 */
    private static Context resolveCtx(Context ctx) {
        try {
            if (ctx != null) {
                return ctx.getApplicationContext() != null ? ctx.getApplicationContext() : ctx;
            }
            return appContext;
        } catch (Throwable ignored) {
            return appContext;
        }
    }

    /**
     * **崩溃路径专用**：在调用线程上**同步**把报告「加密 + 落盘入队」，然后立刻返回。
     *
     * 为什么必须同步：未捕获异常处理器返回后，系统的 KillApplicationHandler 会
     * `Process.killProcess(myPid) + System.exit(10)`，进程**立刻**死亡——后台线程连 DNS/TLS
     * 都来不及做（验收 §Q2 实测：这是 java 崩溃路径 0 送达的真因）。落盘只做 RSA+AES 与一次
     * 小文件写（毫秒级），不联网，因此不会 ANR。
     *
     * 队列文件在 filesDir/crash-queue/*.json，由 {@link #flushQueue} 在下次进程启动时补发。
     * 队列本身有上限（{@link #QUEUE_MAX}），超出丢最旧的——崩溃风暴不该撑爆存储。
     */
    static void enqueueSync(Context ctx, String kind, String thread, String message, String stack) {
        try {
            Context app = resolveCtx(ctx);
            if (app == null) return;
            enqueueEncrypted(app, encryptPayload(plainJson(app, kind, thread, message, stack)));
        } catch (Throwable ignored) {
            // 落盘失败也不能让崩溃处理器抛第二次。
        }
    }

    /** Throwable 版本：栈由本类自己格式化（MainActivity 不必知道 stackText 的细节）。 */
    static void enqueueSync(Context ctx, String kind, String thread, Throwable e) {
        try {
            String message = e == null ? "" : String.valueOf(e);
            String stack = e == null ? "" : stackText(e);
            enqueueSync(ctx, kind, thread, message, stack);
        } catch (Throwable ignored) {
        }
    }

    private static void enqueueEncrypted(Context app, byte[] body) throws Exception {
        File dir = queueDir(app);
        if (!dir.isDirectory() && !dir.mkdirs()) return;
        trimQueue(dir);
        File f = new File(dir, "q_" + System.currentTimeMillis() + "_" +
                Math.abs(new SecureRandom().nextInt()) + ".json");
        // 先写临时名再改名：避免补发线程读到写了一半的文件。
        File tmp = new File(dir, f.getName() + ".part");
        try (OutputStream out = new FileOutputStream(tmp)) {
            out.write(body);
        }
        if (!tmp.renameTo(f)) tmp.delete();
    }

    /** 补发队列（在进程启动时调用一次，后台线程）。
     *
     *  三种结果必须分开处理，否则会互相抵消（第二轮验收 §2 实测出的 CRITICAL）：
     *    · **网络异常**（离线/超时）→ 保留该条并**停止**本轮（没网就全失败，删了就永久丢）
     *    · **HTTP 4xx**（400 解密失败 / 413 过大）→ 这条是毒丸，**删掉它**再继续下一条
     *    · **HTTP 429 / 5xx** → 服务端暂时不收，保留并停止（下次启动再试）
     *  原来只有 boolean，把「没网」和「坏文件」都当坏文件删，离线冷启动一次就丢光队列。 */
    static void flushQueue(Context ctx) {
        try {
            final Context app = resolveCtx(ctx);
            if (app == null) return;
            Thread t = new Thread(() -> {
                try {
                    File dir = queueDir(app);
                    File[] files = dir.listFiles();
                    if (files == null || files.length == 0) return;
                    // 旧的最先发
                    java.util.Arrays.sort(files, (a, b) -> a.getName().compareTo(b.getName()));
                    for (File f : files) {
                        if (!f.isFile() || f.getName().endsWith(".part")) continue;
                        SendResult r = sendBodyDetailed(app, f);
                        if (r == SendResult.DELIVERED) {
                            f.delete();
                        } else if (r == SendResult.POISON) {
                            // 服务端明确拒收这条（4xx）：删掉，别让它永远卡住队列头部。
                            diag(app, "drop poison queue file: " + f.getName());
                            f.delete();
                        } else {
                            // OFFLINE / RETRY_LATER：保留，本轮到此为止。
                            break;
                        }
                    }
                } catch (Throwable ignored) {
                }
            }, "crash-flush");
            t.start();
        } catch (Throwable ignored) {
        }
    }

    private enum SendResult { DELIVERED, POISON, OFFLINE, RETRY_LATER }

    /** 发送一个队列文件并按结果分类；读文件失败按毒丸处理（文件本身坏了）。 */
    private static SendResult sendBodyDetailed(Context app, File f) {
        byte[] body;
        try {
            body = readAll(f);
        } catch (Throwable bad) {
            return SendResult.POISON;
        }
        try {
            int code = sendRaw(app, body);
            if (code == 201 || code == 200) return SendResult.DELIVERED;
            if (code == 429 || code >= 500) return SendResult.RETRY_LATER;
            return SendResult.POISON;                  // 400/413 等：这条永远发不出去
        } catch (Throwable netErr) {
            // UnknownHost / ConnectException / SocketTimeout：没网或服务不可达，保留重试。
            diag(app, "queue send offline: " + netErr);
            return SendResult.OFFLINE;
        }
    }

    private static File queueDir(Context ctx) {
        return new File(ctx.getFilesDir(), "crash-queue");
    }

    /** 队列上限：超过就删最旧的（文件名带时间戳，字典序即时间序）。 */
    private static void trimQueue(File dir) {
        try {
            File[] files = dir.listFiles();
            if (files == null || files.length < QUEUE_MAX) return;
            java.util.Arrays.sort(files, (a, b) -> a.getName().compareTo(b.getName()));
            for (int i = 0; i < files.length - QUEUE_MAX + 1; i++) files[i].delete();
        } catch (Throwable ignored) {
        }
    }

    /** 读整个文件。**不用 InputStream.readAllBytes**：那是 API 33 的方法，本项目 minSdk 26。 */
    private static byte[] readAll(File f) throws IOException {
        try (InputStream in = new java.io.FileInputStream(f)) {
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int n;
            while ((n = in.read(chunk)) > 0) {
                buf.write(chunk, 0, n);
                if (buf.size() > CRASH_MAX_QUEUE_BYTES) break;   // 异常大的队列文件：截断，别吃内存
            }
            return buf.toByteArray();
        }
    }

    private static void post(Context ctx, String kind, String thread, String message, String stack)
            throws Exception {
        sendBody(ctx, encryptPayload(plainJson(ctx, kind, thread, message, stack)));
    }

    /** 发一条已加密的请求体；返回 true 表示服务端已接受（201）或已去重（200）。 */
    private static boolean sendBody(Context ctx, byte[] body) throws Exception {
        int code = sendRaw(ctx, body);
        return code == 201 || code == 200;
    }

    /** 真正发请求并返回 HTTP 码；网络层异常直接向上抛（调用方按异常类型区分「没网」与「被拒」）。 */
    private static int sendRaw(Context ctx, byte[] body) throws Exception {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(ENDPOINT).openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(CONNECT_TIMEOUT_MS);
            c.setReadTimeout(READ_TIMEOUT_MS);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Accept", "application/json");
            c.setFixedLengthStreamingMode(body.length);
            try (OutputStream out = c.getOutputStream()) {
                out.write(body);
            }
            int code = c.getResponseCode();
            if (code == 201 || code == 200) {
                String resp = readCapped(c.getInputStream(), 4096);
                try {
                    lastId = new JSONObject(resp).optString("id", null);
                } catch (Throwable ignored) {
                    // 201 但响应体不是预期 JSON：上报已经成功，id 只是便利信息。
                }
            } else {
                // 400=解密失败 / 413=过大 / 429=限流：记一行。
                diag(ctx, "HTTP " + code);
            }
            return code;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 明文 JSON（AES-GCM 加密前的形状，字段与服务端契约逐字对应）。 */
    private static String plainJson(Context ctx, String kind, String thread, String message, String stack)
            throws Exception {
        JSONObject o = new JSONObject();
        o.put("kind", clipHead(kind, 32));
        o.put("thread", clipHead(thread, 128));
        o.put("message", clipHead(message, MAX_MESSAGE));
        o.put("stack", clipHead(stack, MAX_STACK));
        o.put("app", appId(ctx));
        o.put("vc", BuildConfig.VERSION_CODE);
        o.put("vn", BuildConfig.VERSION_NAME);
        o.put("dev", device());
        o.put("ts", timestamp());
        o.put("log", diagTail(ctx));
        return o.toString();
    }

    private static String appId(Context ctx) {
        try {
            String p = ctx.getPackageName();
            if (p != null && !p.isEmpty()) return p;
        } catch (Throwable ignored) {
        }
        return BuildConfig.APPLICATION_ID;
    }

    private static String device() {
        try {
            String mf = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
            String md = Build.MODEL == null ? "" : Build.MODEL;
            String rel = Build.VERSION.RELEASE == null ? "" : Build.VERSION.RELEASE;
            return (mf + " " + md + " / Android " + rel).trim();
        } catch (Throwable t) {
            return "";
        }
    }

    /** ISO-8601 UTC（例：2026-11-03T08:12:33Z）。每次新建 formatter：SimpleDateFormat 非线程安全。 */
    private static String timestamp() {
        try {
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
            f.setTimeZone(TimeZone.getTimeZone("UTC"));
            return f.format(new Date());
        } catch (Throwable t) {
            return "";
        }
    }

    /** 最近 diag.log 的尾部（≤2000 字）；文件不存在/读取失败都返回空串（服务端字段可空）。 */
    private static String diagTail(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), "diag.log");
            if (!f.isFile()) return "";
            long len = f.length();
            if (len <= 0) return "";
            int want = (int) Math.min(len, LOG_READ_BYTES);
            byte[] buf = new byte[want];
            try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
                raf.seek(len - want);
                raf.readFully(buf);
            }
            String s = new String(buf, StandardCharsets.UTF_8);
            // 从中间字节切开时首行往往是半行：丢掉它，避免把乱码当日志尾巴。
            if (want < len) {
                int nl = s.indexOf('\n');
                if (nl >= 0) s = s.substring(nl + 1);
            }
            return clipTail(s, MAX_LOG);
        } catch (Throwable t) {
            return "";
        }
    }

    private static String stackText(Throwable e) {
        StringBuilder sb = new StringBuilder();
        try {
            sb.append(e);
            for (StackTraceElement el : e.getStackTrace()) sb.append("\n  at ").append(el);
            Throwable cause = e.getCause();
            int depth = 0;
            while (cause != null && depth++ < 3) {
                sb.append("\ncaused by: ").append(cause);
                for (StackTraceElement el : cause.getStackTrace()) sb.append("\n  at ").append(el);
                cause = cause.getCause();
            }
        } catch (Throwable ignored) {
            // 栈取不全不影响上报（message 仍然有）。
        }
        return sb.toString();
    }

    private static String readCapped(InputStream in, int max) throws IOException {
        try (InputStream s = in) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[1024];
            int n;
            while ((n = s.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() >= max) break;
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    /** 上报器自己的日志：写一行到 diag.log（沿用 MainActivity.appendDiagLog 的文件与格式）。 */
    private static void diag(Context ctx, String line) {
        try (FileOutputStream out = new FileOutputStream(new File(ctx.getFilesDir(), "diag.log"), true)) {
            out.write((System.currentTimeMillis() + " crash-report: " + line + "\n")
                    .getBytes(StandardCharsets.UTF_8));
        } catch (Throwable ignored) {
            // diag.log 写不进去也没别的出口了，静默放弃。
        }
    }

    private static String clipHead(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max);
    }

    private static String clipTail(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(s.length() - max);
    }
}
