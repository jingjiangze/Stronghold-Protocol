package icu.jiangjiangze.stronghold;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * WebView shell for the Stronghold Protocol client. v2 adds the embedded host
 * server (phone-as-room-host), the hot-update channel and the shell menu.
 *
 * Layers, top to bottom: the WebView loads the configured origin so that location,
 * Origin and sessionStorage keep matching the server the WebSocket connects to;
 * static requests on that origin are served from filesDir/webroot (hot-updated
 * content) and then from the APK-embedded webroot; anything missing falls through
 * to the network. WebSocket upgrades always go to the network.
 *
 * Host mode runs the real game server inside the app (nodejs-mobile libnode) so
 * the room owner's phone IS the multiplayer server; friends connect over
 * ZeroTier / IPv6 / LAN / hotspot. A foreground service keeps it alive.
 */
public class MainActivity extends Activity {

    private static final String ASSET_ROOT = "webroot";
    private static final String FONT_CSS_HOST = "fonts.googleapis.com";
    private static final String FONT_FILE_HOST = "fonts.gstatic.com";
    private static final Pattern APP_VERSION_JSON = Pattern.compile("\"app\"\\s*:\\s*\"([^\"]+)\"");
    private static final int MENU_STRIP_DP = 12;

    private WebView web;
    private SharedPreferences prefs;
    private String origin;
    private String originHost;
    private volatile boolean onlineMode = false;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("shell", Context.MODE_PRIVATE);
        origin = prefs.getString("origin", BuildConfig.DEFAULT_ORIGIN);
        originHost = hostOf(origin);
        onlineMode = false;

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        web = buildWebView();
        root.addView(web, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(buildMenuStrip(), new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(MENU_STRIP_DP)));
        setContentView(root);
        applyImmersive();
        web.loadUrl(origin + "/");
        checkServerVersion();
    }

    private View buildMenuStrip() {
        View strip = new View(this);
        strip.setBackgroundColor(Color.TRANSPARENT);
        strip.setOnClickListener(v -> showShellMenu());
        return strip;
    }

    // ------------------------------------------------------------------
    // Shell menu (tap the very top edge of the screen)
    // ------------------------------------------------------------------

    private void showShellMenu() {
        String content = Updater.installedTag(this);
        String contentLabel = content == null
                ? "内嵌内容 " + BuildConfig.EMBEDDED_APP_VERSION
                : "内容 " + content + "（热更新）";
        String hostLabel = HostService.isUp()
                ? "房主服务：运行中 (端口 " + HostService.PORT + ")"
                : "房主服务：未启动";
        new AlertDialog.Builder(this)
                .setTitle("卫戍协议壳")
                .setMessage(origin + "\n" + contentLabel + "\n" + hostLabel)
                .setPositiveButton("房主模式", (d, w) -> toggleHostMode())
                .setNeutralButton("检查更新", (d, w) -> checkForUpdate())
                .setNegativeButton("切换服务器", (d, w) -> pickServer())
                .show();
    }

    // ------------------------------------------------------------------
    // Host mode (embedded game server)
    // ------------------------------------------------------------------

    private void toggleHostMode() {
        if (HostService.isUp()) {
            showHostDialog(true);
            return;
        }
        if (!HostService.contentMaterialised(this)) {
            toast("正在释放本地资源（首次约 1 分钟）…");
        }
        Intent intent = new Intent(this, HostService.class);
        ContextCompatStart.startForegroundService(this, intent);
        toast("房主服务启动中…");
        // poll the loopback healthz until the embedded server answers, then show addresses
        new Thread(() -> {
            boolean ok = false;
            for (int i = 0; i < 40 && !ok; i++) {
                sleep(500);
                ok = healthzOk("http://127.0.0.1:" + HostService.PORT + "/healthz");
            }
            final boolean up = ok;
            main.post(() -> showHostDialog(up));
        }, "host-wait").start();
    }

    private void showHostDialog(boolean serverUp) {
        if (!isFinishing()) return;
        StringBuilder sb = new StringBuilder();
        if (serverUp) {
            sb.append("房主服务已就绪，进游戏建好房间后，把下面的地址发给朋友"
                    + "（朋友在断线页选「切换服务器」粘贴即可）：\n\n");
            appendAddresses(sb);
            sb.append("\n自己不需要切地址，本机自动连内置服务器。");
        } else {
            sb.append("房主服务未能启动。请确认本地资源完整（可在「检查更新」里重新拉取），"
                    + "或稍后再试。");
        }
        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle("房主模式")
                .setMessage(sb.toString())
                .setPositiveButton("好的", null);
        if (serverUp) {
            b.setNeutralButton("复制地址", (d, w) -> copyHostAddresses());
            b.setNegativeButton("停止并退出", (d, w) -> stopService(new Intent(this, HostService.class)));
        }
        b.show();
    }

    private void appendAddresses(StringBuilder sb) {
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            while (nis != null && nis.hasMoreElements()) {
                NetworkInterface ni = nis.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isAnyLocalAddress()) continue;
                    String name = ni.getName() == null ? "" : ni.getName().toLowerCase(Locale.ROOT);
                    String kind;
                    if (a instanceof Inet4Address) kind = name.startsWith("zt") ? "ZeroTier" : "局域网";
                    else if (a instanceof Inet6Address) kind = "IPv6";
                    else continue;
                    String literal = a instanceof Inet6Address
                            ? "[" + a.getHostAddress().split("%")[0] + "]" : a.getHostAddress();
                    sb.append(kind).append("：http://").append(literal).append(":").append(HostService.PORT).append("\n");
                }
            }
        } catch (Exception ignored) {
            // address enumeration is best-effort
        }
    }

    private void copyHostAddresses() {
        StringBuilder sb = new StringBuilder("卫戍协议联机地址：\n");
        appendAddresses(sb);
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        cm.setPrimaryClip(ClipData.newPlainText("stronghold-hosts", sb.toString()));
        toast("地址已复制");
    }

    // ------------------------------------------------------------------
    // Hot update (upstream release → filesDir/webroot)
    // ------------------------------------------------------------------

    private void checkForUpdate() {
        toast("正在检查上游版本…");
        new Thread(() -> {
            Updater.Release rel = null;
            String err = null;
            try {
                rel = Updater.latestRelease(BuildConfig.UPSTREAM_RELEASE_API);
            } catch (IOException e) {
                err = e.getMessage();
            }
            final Updater.Release release = rel;
            final String failure = err;
            main.post(() -> {
                if (isFinishing()) return;
                if (release == null) {
                    toast("检查失败：" + failure);
                    return;
                }
                String installed = Updater.installedTag(this);
                if (release.tag.equals(installed)) {
                    toast("已是最新：" + release.tag);
                    return;
                }
                String current = installed == null ? "内嵌 " + BuildConfig.EMBEDDED_APP_VERSION : installed;
                new AlertDialog.Builder(this)
                        .setTitle("发现上游更新")
                        .setMessage("上游 " + release.tag + " 已发布（当前：" + current + "）。\n\n"
                                + "将下载约 270MB 的官方整合包并本地解包，仅更新游戏内容，"
                                + "无需重装 APK。下载完成后会自动重启应用生效。\n\n"
                                + "房主服务如正在运行也会随之更新。")
                        .setPositiveButton("下载并安装", (d, w) -> runUpdate(release))
                        .setNegativeButton("以后再说", null)
                        .show();
            });
        }, "shell-update-check").start();
    }

    private AlertDialog updatingDialog;

    private void runUpdate(Updater.Release release) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(24);
        box.setPadding(pad, pad, pad, pad);
        TextView stage = new TextView(this);
        stage.setText("连接中…");
        TextView detail = new TextView(this);
        detail.setTextSize(12);
        box.addView(stage);
        box.addView(detail);

        updatingDialog = new AlertDialog.Builder(this)
                .setTitle("热更新 " + release.tag)
                .setView(box)
                .setCancelable(false)
                .show();

        new Thread(() -> {
            try {
                Updater.downloadAndInstall(this, release, new Updater.Progress() {
                    @Override
                    public void onStage(String s) {
                        main.post(() -> stage.setText(s));
                    }

                    @Override
                    public void onProgress(long bytes, long total) {
                        main.post(() -> detail.setText(bytes / (1024 * 1024) + " MB"
                                + (total > 0 ? " / " + total / (1024 * 1024) + " MB" : "")));
                    }
                });
                main.post(() -> {
                    dismissUpdating();
                    new AlertDialog.Builder(this)
                            .setTitle("更新完成")
                            .setMessage("内容已更新到 " + release.tag + "，重启应用生效。")
                            .setPositiveButton("重启", (d, w) -> recreate())
                            .setNegativeButton("稍后", null)
                            .show();
                });
            } catch (IOException e) {
                main.post(() -> {
                    dismissUpdating();
                    toast("更新失败：" + e.getMessage());
                });
            }
        }, "shell-update-run").start();
    }

    private void dismissUpdating() {
        if (updatingDialog != null && updatingDialog.isShowing()) updatingDialog.dismiss();
    }

    // ------------------------------------------------------------------
    // WebView: interception (filesDir → assets → network)
    // ------------------------------------------------------------------

    private WebView buildWebView() {
        WebView v = new WebView(this);
        v.setBackgroundColor(Color.parseColor("#0C0F0E"));
        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        v.setWebViewClient(new ShellClient());
        v.setWebChromeClient(new WebChromeClient());
        v.addJavascriptInterface(new ShellBridge(), "shell");
        return v;
    }

    private class ShellClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.ROOT);
            String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) return null;

            if (FONT_CSS_HOST.equals(host)) return emptyCss();
            if (FONT_FILE_HOST.equals(host)) return emptyCss();
            if (onlineMode || originHost == null || !originHost.equalsIgnoreCase(host)) return null;
            if (!"GET".equalsIgnoreCase(request.getMethod())) return null;

            String path = url.getPath();
            if (path == null || path.isEmpty() || !path.startsWith("/")) return null;
            if (path.contains("//")) return null;
            for (String seg : path.split("/")) {
                if (seg.isEmpty()) continue;
                if (seg.equals(".") || seg.equals("..") || seg.startsWith(".")) return null;
            }
            if ("/healthz".equals(path)) return null;
            if (path.endsWith("/")) path = path + "index.html";

            // 1) hot-updated content in filesDir, 2) the APK-embedded copy, 3) the network.
            InputStream in = openLocal(path);
            if (in == null) return null;
            String mime = mimeFor(path);
            String enc = mime.startsWith("text/") || mime.contains("json") || mime.contains("javascript")
                    ? "utf-8" : null;
            WebResourceResponse resp = new WebResourceResponse(mime, enc, in);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-cache");
            headers.put("Access-Control-Allow-Origin", "*");
            resp.setResponseHeaders(headers);
            return resp;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            view.evaluateJavascript(
                "try{document.documentElement.classList.add('sp-standalone')}catch(e){}", null);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
            if (request.isForMainFrame()) showErrorPage();
        }

        @Override
        public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler, android.net.http.SslError error) {
            handler.cancel();
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            if (detail.didCrash()) {
                recreate();
                return true;
            }
            return false;
        }
    }

    private InputStream openLocal(String path) {
        // hot-updated copy first
        File f = new File(HostService.contentRoot(this), path);
        if (f.isFile()) {
            try {
                return new FileInputStream(f);
            } catch (IOException ignored) {
                // fall through to assets
            }
        }
        try {
            return getAssets().open(ASSET_ROOT + path);
        } catch (IOException notFound) {
            return null; // not embedded (newer server?) → network
        }
    }

    private WebResourceResponse emptyCss() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "max-age=86400");
        return new WebResourceResponse("text/css", "utf-8", 200, "OK", headers,
                new ByteArrayInputStream("/* embedded shell: local fonts are provided by /fonts/fonts.css */".getBytes(StandardCharsets.UTF_8)));
    }

    private static String mimeFor(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        int dot = p.lastIndexOf('.');
        String ext = dot >= 0 ? p.substring(dot) : "";
        switch (ext) {
            case ".html": case ".htm": return "text/html";
            case ".js": case ".mjs": return "text/javascript";
            case ".css": return "text/css";
            case ".json": case ".map": return "application/json";
            case ".txt": case ".atlas": return "text/plain";
            case ".csv": return "text/csv";
            case ".xml": return "application/xml";
            case ".webmanifest": return "application/manifest+json";
            case ".svg": return "image/svg+xml";
            case ".png": return "image/png";
            case ".jpg": case ".jpeg": return "image/jpeg";
            case ".gif": return "image/gif";
            case ".webp": return "image/webp";
            case ".avif": return "image/avif";
            case ".ico": return "image/x-icon";
            case ".mp3": return "audio/mpeg";
            case ".ogg": case ".oga": case ".opus": return "audio/ogg";
            case ".wav": return "audio/wav";
            case ".m4a": return "audio/mp4";
            case ".aac": return "audio/aac";
            case ".webm": return "video/webm";
            case ".mp4": return "video/mp4";
            case ".woff2": return "font/woff2";
            case ".woff": return "font/woff";
            case ".otf": return "font/otf";
            case ".ttf": return "font/ttf";
            case ".skel": case ".bin": return "application/octet-stream";
            case ".wasm": return "application/wasm";
            default: return "application/octet-stream";
        }
    }

    // ------------------------------------------------------------------
    // Version gate (embedded client vs. the connected server)
    // ------------------------------------------------------------------

    private void checkServerVersion() {
        final String target = origin;
        new Thread(() -> {
            String serverVersion = null;
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(target + "/healthz").openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setRequestProperty("Accept", "application/json");
                if (c.getResponseCode() == 200) {
                    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                    try (InputStream in = c.getInputStream()) {
                        byte[] buf = new byte[4096];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    }
                    Matcher m = APP_VERSION_JSON.matcher(out.toString("UTF-8"));
                    if (m.find()) serverVersion = m.group(1);
                }
                c.disconnect();
            } catch (IOException ignored) {
                // connectivity errors surface through the WebView error page
            }
            final String server = serverVersion;
            main.post(() -> {
                if (server != null && !BuildConfig.EMBEDDED_APP_VERSION.equals(server) && !onlineMode) {
                    showVersionMismatch(server);
                }
            });
        }, "shell-version-check").start();
    }

    private void showVersionMismatch(String serverVersion) {
        new AlertDialog.Builder(this)
                .setTitle("版本提示")
                .setMessage("服务器版本 " + serverVersion + " 与内嵌客户端 "
                        + BuildConfig.EMBEDDED_APP_VERSION + " 不同。\n\n"
                        + "继续用本地版可能遇到不兼容；在线模式加载服务器上的最新网页版（较慢）；"
                        + "也可以在顶部菜单「检查更新」热更新到新内容。")
                .setPositiveButton("切换在线模式", (d, w) -> setOnlineMode(true))
                .setNeutralButton("切换服务器", (d, w) -> pickServer())
                .setNegativeButton("仍要继续", null)
                .show();
    }

    // ------------------------------------------------------------------
    // JS bridge (used by the embedded error page)
    // ------------------------------------------------------------------

    private class ShellBridge {
        @JavascriptInterface
        public void retry() {
            main.post(() -> {
                checkServerVersion();
                web.loadUrl(origin + "/");
            });
        }

        @JavascriptInterface
        public void onlineMode() {
            main.post(() -> setOnlineMode(true));
        }

        @JavascriptInterface
        public void pickServer() {
            main.post(MainActivity.this::pickServer);
        }

        @JavascriptInterface
        public void host() {
            main.post(MainActivity.this::toggleHostMode);
        }
    }

    private void setOnlineMode(boolean on) {
        onlineMode = on;
        if (on) toast("已切换在线模式：资源改从服务器加载");
        web.loadUrl(origin + "/");
    }

    private void pickServer() {
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setText(origin);
        new AlertDialog.Builder(this)
                .setTitle("服务器地址")
                .setMessage("支持 https:// 域名、局域网 IP、ZeroTier/Tailscale 地址（http://IP:3000）等")
                .setView(input)
                .setPositiveButton("保存并连接", (d, w) -> {
                    String v = input.getText().toString().trim();
                    if (v.isEmpty()) return;
                    if (!v.startsWith("http://") && !v.startsWith("https://")) v = "https://" + v;
                    while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
                    origin = v;
                    originHost = hostOf(origin);
                    prefs.edit().putString("origin", origin).apply();
                    onlineMode = false;
                    checkServerVersion();
                    web.loadUrl(origin + "/");
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void showErrorPage() {
        try {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            try (InputStream in = getAssets().open("error.html")) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            String html = out.toString("UTF-8");
            String safeOrigin = origin.replace("'", "");
            html = html.replace("</head>",
                    "<script>window.__SHELL_ORIGIN='" + safeOrigin + "';</script></head>");
            web.loadDataWithBaseURL(origin + "/", html, "text/html", "utf-8", null);
        } catch (IOException e) {
            toast("连接失败：" + origin);
        }
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    private static String hostOf(String origin) {
        String h = Uri.parse(origin).getHost();
        return h == null ? null : h.toLowerCase(Locale.ROOT);
    }

    private boolean healthzOk(String selfUrl) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(selfUrl).openConnection();
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

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    // ------------------------------------------------------------------
    // Chrome: immersive landscape, back key
    // ------------------------------------------------------------------

    private void applyImmersive() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("shell");
            web.destroy();
        }
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(HostService.NOTIFICATION_ID);
        super.onDestroy();
    }

    /** Tiny shim so the same code path compiles against API 26 without extra branches. */
    private static final class ContextCompatStart {
        static void startForegroundService(Context ctx, Intent intent) {
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent);
            else ctx.startService(intent);
        }
    }
}
