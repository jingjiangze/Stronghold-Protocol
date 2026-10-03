package icu.jiangjiangze.stronghold;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.app.PendingIntent;
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

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * WebView shell for the Stronghold Protocol client. v2.1: join-by-room-code via the
 * box directory service (伪 P2P: box = discovery only, data path is direct
 * client ↔ host), editable host-server parameters, WebRTC DataChannel fallback for
 * double-CGNAT, and remotely hot-updatable shell URLs (config.json indirection).
 */
public class MainActivity extends Activity {

    private static final String ASSET_ROOT = "webroot";
    private static final String FONT_CSS_HOST = "fonts.googleapis.com";
    private static final String FONT_FILE_HOST = "fonts.gstatic.com";
    private static final Pattern APP_VERSION_JSON = Pattern.compile("\"app\"\\s*:\\s*\"([^\"]+)\"");
    private static final Pattern ROOM_CODE = Pattern.compile("^[A-Z]{4}$");
    private static final int MENU_STRIP_DP = 12;

    private WebView web;
    private SharedPreferences prefs;
    private String origin;
    private String originHost;
    private volatile boolean onlineMode = false;
    /** When a join-by-code could not probe the host over TCP, the page gets a WebRTC-bridged WebSocket. */
    private volatile JSONObject dcConfig = null;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("shell", Context.MODE_PRIVATE);
        origin = prefs.getString("origin", BuildConfig.DEFAULT_ORIGIN);
        originHost = hostOf(origin);
        onlineMode = false;

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        ShellConfig cfg = ShellConfig.load(this);
        new Thread(() -> cfg.refresh(this), "shell-config").start();

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
        if ("params".equals(getIntent() != null ? getIntent().getStringExtra("open") : null)) {
            main.postDelayed(this::showParamsEditor, 800);
        }
    }

    public static PendingIntent hostParamsPendingIntent(Context ctx) {
        Intent i = new Intent(ctx, MainActivity.class).putExtra("open", "params");
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getActivity(ctx, 1, i, flags);
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
                ? "房主服务：运行中（房间已自动发布，朋友输房号即可加入）"
                : "房主服务：未启动";
        String[] items = {"房主模式", "输房号加入", "服务器参数", "检查更新", "切换服务器（高级）"};
        new AlertDialog.Builder(this)
                .setTitle("卫戍协议壳")
                .setMessage(origin + "\n" + contentLabel + "\n" + hostLabel)
                .setItems(items, (d, which) -> {
                    if (which == 0) toggleHostMode();
                    else if (which == 1) joinByCode();
                    else if (which == 2) showParamsEditor();
                    else if (which == 3) checkForUpdate();
                    else pickServer();
                })
                .show();
    }

    // ------------------------------------------------------------------
    // Host mode (embedded server + auto room publishing)
    // ------------------------------------------------------------------

    private void toggleHostMode() {
        if (HostService.isUp()) {
            showHostDialog(true);
            return;
        }
        if (!HostService.contentMaterialised(this)) {
            toast("正在释放本地资源（首次约 1 分钟）…");
        }
        startForegroundServiceCompat(new Intent(this, HostService.class));
        toast("房主服务启动中，房间将自动发布…");
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
        if (isFinishing()) return;
        String msg = serverUp
                ? "房主服务已就绪。你创建的房间会自动发布到目录服务——朋友只需输入 4 位房号即可直连加入，无需任何地址。"
                : "房主服务未能启动。请确认本地资源完整（可在「检查更新」里重新拉取），或稍后再试。";
        new AlertDialog.Builder(this)
                .setTitle("房主模式")
                .setMessage(msg)
                .setPositiveButton("好的", null)
                .setNeutralButton("服务器参数", (d, w) -> showParamsEditor())
                .setNegativeButton(serverUp ? "停止并退出" : "关闭", (d, w) -> {
                    if (serverUp) stopService(new Intent(this, HostService.class));
                })
                .show();
    }

    // ------------------------------------------------------------------
    // Join by room code (玩家：只输房号)
    // ------------------------------------------------------------------

    private void joinByCode() {
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint("4 位房号，如 KHFP");
        new AlertDialog.Builder(this)
                .setTitle("输入房号加入")
                .setMessage("向房主索要 4 位房号。将自动探测房主的 ZeroTier / IPv6 / 局域网地址并直连；"
                        + "直连不通时自动改用打洞通道，最后回落盒子常驻房。")
                .setView(input)
                .setPositiveButton("加入", (d, w) -> {
                    String code = input.getText().toString().trim().toUpperCase(Locale.ROOT);
                    if (!ROOM_CODE.matcher(code).matches()) {
                        toast("房号格式不对：4 个字母");
                        return;
                    }
                    resolveAndJoin(code);
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void resolveAndJoin(String code) {
        toast("正在查找房间 " + code + "…");
        final List<String> dirs = ShellConfig.load(this).directoryUrls();
        new Thread(() -> {
            String probed = null; // an address whose /healthz answered → plain WS will work
            String firstAddr = null;
            String usedDir = null;
            JSONObject addrs = null;
            outer:
            for (String dir : dirs) {
                try {
                    JSONObject r = getJson(dir + "/rooms/" + code, 4000);
                    addrs = r.optJSONObject("addresses");
                    if (addrs == null) continue;
                    usedDir = dir;
                    for (String key : new String[]{"zt", "v6", "lan"}) {
                        String addr = addrs.optString(key, "");
                        if (addr.isEmpty()) continue;
                        if (firstAddr == null) firstAddr = addr;
                        if (probed == null && healthzOk(addr + "/healthz")) probed = addr;
                        if (probed != null) break outer;
                    }
                } catch (Exception ignored) {
                    // try the next directory
                }
            }
            final String addr = probed != null ? probed : firstAddr;
            final boolean useDc = probed == null && addr != null;
            final String dirUsed = usedDir;
            final JSONObject addresses = addrs;
            main.post(() -> {
                if (isFinishing()) return;
                if (addr == null) {
                    toast("没有找到房间 " + code + "（可能已过期）");
                    return;
                }
                origin = addr;
                originHost = hostOf(origin);
                prefs.edit().putString("origin", origin).apply();
                onlineMode = false;
                if (useDc) {
                    // host unreachable over TCP → WebRTC DataChannel bridge via the directory
                    try {
                        dcConfig = new JSONObject()
                                .put("enabled", true)
                                .put("room", code)
                                .put("directory", dirUsed)
                                .put("stun", ShellConfig.load(this).stunUrls());
                        toast("直连不通，改用打洞通道…");
                    } catch (Exception e) {
                        dcConfig = null;
                    }
                } else {
                    dcConfig = null;
                    toast("已直连房主： " + addr);
                }
                checkServerVersion();
                web.loadUrl(origin + "/?room=" + code);
            });
        }, "shell-join").start();
    }

    // ------------------------------------------------------------------
    // Host server parameters (房主可编辑参数)
    // ------------------------------------------------------------------

    private void showParamsEditor() {
        HostParams p = HostParams.load(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        box.setPadding(pad, pad, pad, pad);

        EditText port = addParam(box, "端口 PORT",
                "朋友连接地址里的端口；改动后需重新发布房间。", String.valueOf(p.port));
        EditText combat = addParam(box, "战斗模拟位置 SP_COMBAT",
                "client=玩家手机各自模拟（推荐·省电）；server=房主统一模拟（耗电高，仅设备强时选）",
                p.spCombat);
        EditText verify = addParam(box, "结果校验 SP_VERIFY",
                "off=不校验（默认）；sample=抽查部分结果；all=全量校验（最耗性能）", p.spVerify);
        EditText hostBind = addParam(box, "监听地址 HOST",
                "::=全部网卡（朋友可直连，推荐）；127.0.0.1=仅本机（单机练习）", p.hostBind);
        EditText proxy = addParam(box, "信任代理 TRUST_PROXY",
                "auto=自动（直连无需改动）；1=信任代理头；0=不信任", p.trustProxy);

        new AlertDialog.Builder(this)
                .setTitle("服务器参数")
                .setView(box)
                .setPositiveButton("保存并重启应用", (d, w) -> {
                    HostParams.save(this, parseInt(port, 3000), text(hostBind, "::"),
                            text(combat, "client"), text(verify, "off"), text(proxy, "auto"));
                    stopService(new Intent(this, HostService.class));
                    toast("参数已保存，重启应用…");
                    main.postDelayed(() -> {
                        finishAffinity();
                        android.os.Process.killProcess(android.os.Process.myPid());
                    }, 300);
                })
                .setNeutralButton("恢复默认", (d, w) -> {
                    HostParams.save(this, 3000, "::", "client", "off", "auto");
                    toast("已恢复默认，重启应用后生效");
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private EditText addParam(LinearLayout box, String label, String note, String value) {
        TextView l = new TextView(this);
        l.setText(label);
        l.setTextSize(15);
        box.addView(l);
        EditText e = new EditText(this);
        e.setSingleLine(true);
        e.setText(value);
        box.addView(e);
        TextView n = new TextView(this);
        n.setText(note);
        n.setTextSize(11);
        n.setAlpha(0.65f);
        box.addView(n);
        TextView gap = new TextView(this);
        gap.setTextSize(4);
        box.addView(gap);
        return e;
    }

    private static String text(EditText e, String def) {
        String v = e.getText().toString().trim();
        return v.isEmpty() ? def : v;
    }

    private static int parseInt(EditText e, int def) {
        try {
            return Integer.parseInt(e.getText().toString().trim());
        } catch (Exception ex) {
            return def;
        }
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
                                + "将下载官方整合包并本地解包，仅更新游戏内容，无需重装 APK。"
                                + "下载完成后重启应用生效。")
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
    // WebView: interception (filesDir → assets → network) + DC injection
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

            // main frame in DC mode → inject the per-session transport config into index.html
            if (path.equals("/index.html") && dcConfig != null) {
                InputStream in = openLocal(path);
                if (in != null) {
                    try {
                        String html = readAll(in);
                        String injected = dcConfig.toString();
                        if (html.contains("/*SPDC*/")) {
                            html = html.replace("/*SPDC*/", injected);
                            return respond("text/html", "utf-8", new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
                        }
                        // fall through with the unmodified page if the placeholder is gone
                    } catch (IOException ignored) {
                    }
                }
            }

            InputStream in = openLocal(path);
            if (in == null) return null; // not embedded (newer server?) → network
            String mime = mimeFor(path);
            String enc = mime.startsWith("text/") || mime.contains("json") || mime.contains("javascript")
                    ? "utf-8" : null;
            return respond(mime, enc, in);
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

    private WebResourceResponse respond(String mime, String enc, InputStream in) {
        WebResourceResponse resp = new WebResourceResponse(mime, enc, in);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache");
        headers.put("Access-Control-Allow-Origin", "*");
        resp.setResponseHeaders(headers);
        return resp;
    }

    private InputStream openLocal(String path) {
        File f = new File(HostService.contentRoot(this), path);
        if (f.isFile()) {
            try {
                return new FileInputStream(f);
            } catch (IOException ignored) {
            }
        }
        try {
            return getAssets().open(ASSET_ROOT + path);
        } catch (IOException notFound) {
            return null;
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

    private static String readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toString("UTF-8");
    }

    private static JSONObject getJson(String url, int timeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(timeoutMs);
        c.setReadTimeout(timeoutMs);
        c.setRequestProperty("User-Agent", "stronghold-shell");
        if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
        String body = readAll(c.getInputStream());
        c.disconnect();
        return new JSONObject(body);
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
                    Matcher m = APP_VERSION_JSON.matcher(readAll(c.getInputStream()));
                    if (m.find()) serverVersion = m.group(1);
                }
                c.disconnect();
            } catch (IOException ignored) {
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
    // JS bridge
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

        @JavascriptInterface
        public void join() {
            main.post(MainActivity.this::joinByCode);
        }

        @JavascriptInterface
        public void params() {
            main.post(MainActivity.this::showParamsEditor);
        }

        @JavascriptInterface
        public String hostStatus() {
            return HostService.isUp() ? "房主服务：运行中 · 房间已自动发布" : "房主服务：未启动";
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
                .setTitle("服务器地址（高级）")
                .setMessage("一般情况请用「输房号加入」。此处支持 https:// 域名、局域网 IP、"
                        + "ZeroTier/Tailscale 地址（http://IP:3000）等")
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
            c.setConnectTimeout(2500);
            c.setReadTimeout(2500);
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

    private void startForegroundServiceCompat(Intent intent) {
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
        else startService(intent);
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
}
