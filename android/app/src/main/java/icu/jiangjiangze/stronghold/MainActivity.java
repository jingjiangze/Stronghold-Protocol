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
import android.widget.FrameLayout;
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
    /** Cached signed server list (loaded and probed off the main thread). */
    private volatile ServerList.Snapshot serverSnapshot;
    private volatile boolean serverListLoading = false;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("shell", Context.MODE_PRIVATE);
        String saved = prefs.getString("origin", "auto");
        boolean autoLine = "auto".equals(saved);
        origin = autoLine ? "https://stronghold.jiangjiangze.icu" : saved;
        originHost = hostOf(origin);
        onlineMode = false;

        // Crash forensics: an uncaught Java exception is written to filesDir/crash.log before the
        // default handler runs, so the next field crash is diagnosable without adb.
        final Thread.UncaughtExceptionHandler prevHandler = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            appendCrash("java", t.getName(), e);
            if (prevHandler != null) prevHandler.uncaughtException(t, e);
        });

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        ShellConfig cfg = ShellConfig.load(this);
        new Thread(() -> cfg.refresh(this), "shell-config").start();

        // Edge-to-edge adaptive layout: the WebView fills the ENTIRE window on any device
        // (no reserved bands → no window background can show through); the menu hotspot is a
        // transparent OVERLAY (zero layout cost) pinned to the top edge and offset by the
        // real system insets, so cutout/gesture devices get the same full-bleed result.
        FrameLayout root = new FrameLayout(this);
        web = buildWebView();
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        View strip = buildMenuStrip();
        FrameLayout.LayoutParams stripLp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, dp(MENU_STRIP_DP), Gravity.TOP);
        strip.setOnApplyWindowInsetsListener((v, insets) -> {
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) v.getLayoutParams();
            int top = insets.getSystemWindowInsetTop();
            if (lp.topMargin != top) {
                lp.topMargin = top;
                v.setLayoutParams(lp);
            }
            return insets;
        });
        root.addView(strip, stripLp);
        loading = buildLoadingView();
        root.addView(loading, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        applyImmersive();
        checkServerVersion();

        final boolean autoLineFinal = autoLine;
        new Thread(() -> {
            // 0) one-time migration after an overwrite-install: stale trees from earlier versions
            // are wiped (user-directed) so half-written/legacy layouts can never cause page crashes.
            int lastVc = prefs.getInt("versionCode", 0);
            if (lastVc != BuildConfig.VERSION_CODE) {
                setLoadingText("正在更新数据…");
                migrateWipe();
                prefs.edit().putInt("versionCode", BuildConfig.VERSION_CODE).apply();
            }
            // a hot update that never rendered rolls back to the tree it replaced
            Updater.rollbackIfUnhealthy(this);
            // 1) pick the line, then load the page exactly once. COLD START DOES NO MATERIALISE AND
            // STARTS NO NODE — the host service (离线服务) is started on demand from the panel.
            if (autoLineFinal) {
                setLoadingText("正在选择最优线路…");
                String best = probeBestLine();
                main.post(() -> {
                    if (best != null) {
                        applyOrigin(best);
                    } else {
                        toast("线路探测失败，使用默认线路");
                        applyOrigin(origin);
                    }
                });
            } else {
                main.post(() -> web.loadUrl(origin + "/"));
            }
        }, "shell-boot").start();

        // The signed server list is pulled and probed in the background; the panel shows it when ready.
        reloadServerList(false);

        if ("params".equals(getIntent() != null ? getIntent().getStringExtra("open") : null)) {
            main.postDelayed(() -> openPanelJs("params"), 2500);
        }
    }

    private View loading;
    private TextView loadingText;

    private View buildLoadingView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.parseColor("#0C0F0E"));
        TextView title = new TextView(this);
        title.setText("卫戍协议 · 盟约");
        title.setTextColor(Color.parseColor("#4ED8AF"));
        title.setTextSize(22);
        title.setGravity(Gravity.CENTER);
        loadingText = new TextView(this);
        loadingText.setText("正在启动…");
        loadingText.setTextColor(Color.parseColor("#8A9A93"));
        loadingText.setTextSize(13);
        loadingText.setGravity(Gravity.CENTER);
        android.widget.ProgressBar bar = new android.widget.ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setIndeterminate(true);
        LinearLayout.LayoutParams barLp = new LinearLayout.LayoutParams(dp(220), dp(6));
        barLp.topMargin = dp(16);
        box.addView(title);
        box.addView(loadingText);
        box.addView(bar, barLp);
        return box;
    }

    private void setLoadingText(String text) {
        main.post(() -> {
            if (loadingText != null) loadingText.setText(text);
        });
    }

    private void hideLoading() {
        if (loading != null && loading.getVisibility() == View.VISIBLE) {
            loading.setVisibility(View.GONE);
        }
    }

    /** Remote-editable line origins (ShellConfig.fallbackOrigins), falling back to the built-in three. */
    private java.util.List<String> lineOrigins() {
        java.util.List<String> cfg = ShellConfig.load(this).fallbackOrigins();
        if (cfg != null && cfg.size() >= 3) return cfg;
        return java.util.Arrays.asList(
                "https://map.u712507.nyat.app:38916",  // 国内线路（frp）
                "https://stronghold.jiangjiangze.icu", // 国际线路 1
                "https://stronghold2.jiangjiangze.icu" // 国际线路 2
        );
    }

    /** Probes the remote lines in parallel and returns the one with the lowest /healthz RTT (null = none). */
    private String probeBestLine() {
        String[] lines = lineOrigins().toArray(new String[0]);
        final long[] rtt = new long[lines.length];
        Thread[] ts = new Thread[lines.length];
        for (int i = 0; i < lines.length; i++) {
            final int idx = i;
            ts[i] = new Thread(() -> rtt[idx] = probeRtt(lines[idx]), "probe-" + i);
            ts[i].start();
        }
        for (Thread t : ts) {
            try {
                t.join(2500);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
        long best = Long.MAX_VALUE;
        String chosen = null;
        for (int i = 0; i < lines.length; i++) {
            if (rtt[i] > 0 && rtt[i] < best) {
                best = rtt[i];
                chosen = lines[i];
            }
        }
        return chosen;
    }

    /** One /healthz round trip; returns milliseconds or -1. */
    private long probeRtt(String base) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(base + "/healthz").openConnection();
            c.setConnectTimeout(1500);
            c.setReadTimeout(1500);
            long t0 = System.nanoTime();
            if (c.getResponseCode() != 200) {
                c.disconnect();
                return -1;
            }
            long ms = (System.nanoTime() - t0) / 1_000_000;
            c.disconnect();
            return Math.max(1, ms);
        } catch (IOException e) {
            return -1;
        }
    }

    /** Human label for the current origin — the raw domain is never shown in the UI. */
    private String currentLineLabel() {
        if (origin.startsWith("http://127.0.0.1")) return "离线服务";
        if (origin.contains("nyat.app")) return "国内线路";
        if (origin.contains("stronghold2") || origin.contains("weishu2")) return "国际线路 2";
        if (origin.contains("jiangjiangze.icu")) return "国际线路 1";
        return "自定义线路";
    }

    // ------------------------------------------------------------------
    // Migration / crash forensics / on-demand host service
    // ------------------------------------------------------------------

    /** One-time wipe of data written by earlier app versions (user-directed on every version bump). */
    private void migrateWipe() {
        File[] targets = {
                new File(getFilesDir(), "webroot"),
                new File(getFilesDir(), "webroot.next"),
                new File(getFilesDir(), "webroot.old"),
                new File(getFilesDir(), "webroot.meta.json"),
                new File(getFilesDir(), "shell-config.json"),
        };
        int wiped = 0;
        for (File f : targets) {
            if (f.exists()) {
                deleteRecursively(f);
                wiped++;
            }
        }
        appendLogFile("migration.log", "wiped " + wiped + " stale entries (versionCode " + BuildConfig.VERSION_CODE + ")");
    }

    private static void deleteRecursively(File f) {
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) deleteRecursively(k);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private void appendLogFile(String name, String line) {
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(new File(getFilesDir(), name), true)) {
            out.write((System.currentTimeMillis() + " " + line + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (IOException ignored) {
        }
    }

    private void appendCrash(String kind, String thread, Throwable e) {
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(new File(getFilesDir(), "crash.log"), true)) {
            StringBuilder sb = new StringBuilder();
            sb.append("=== ").append(kind).append(" @ ").append(thread).append(" ")
                    .append(new java.util.Date()).append(" ===\n");
            sb.append(e).append('\n');
            for (StackTraceElement el : e.getStackTrace()) sb.append("  at ").append(el).append('\n');
            Throwable cause = e.getCause();
            if (cause != null) sb.append("caused by: ").append(cause).append('\n');
            sb.append('\n');
            out.write(sb.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (IOException ignored) {
        }
    }

    private boolean crashNoticeShown = false;

    /** Shows the recorded crash once per process so the next failure is actionable from a screenshot. */
    private void maybeShowCrashNotice() {
        if (crashNoticeShown) return;
        File crash = new File(getFilesDir(), "crash.log");
        if (!crash.isFile()) return;
        crashNoticeShown = true;
        String text = "";
        try (java.io.FileInputStream in = new java.io.FileInputStream(crash)) {
            byte[] buf = new byte[1600];
            int n = in.read(buf);
            if (n > 0) text = new String(buf, 0, n, java.nio.charset.StandardCharsets.UTF_8);
        } catch (IOException ignored) {
        }
        final String body = text;
        main.post(() -> new AlertDialog.Builder(this)
                .setTitle("检测到上次崩溃记录")
                .setMessage(body.isEmpty() ? "（日志为空）" : body)
                .setPositiveButton("清除记录", (d, w) -> {
                    //noinspection ResultOfMethodCallIgnored
                    crash.delete();
                })
                .setNegativeButton("保留", null)
                .show());
    }

    /** CDN hosts whose asset URLs resolve against the embedded tree (APK clients stay fully local). */
    private boolean isAssetCdnHost(String host) {
        return "weishucdn.jiangjiangze.icu".equals(host) || "jingjiangze.github.io".equals(host);
    }

    /** 离线服务: start the host service on demand, wait for healthz, then switch to it. */
    private void ensureHostAndSwitch() {
        toast("离线服务启动中…");
        if (!HostService.isUp()) {
            startForegroundServiceCompat(new Intent(this, HostService.class));
        }
        new Thread(() -> {
            boolean up = false;
            for (int i = 0; i < 60 && !up; i++) {
                sleep(500);
                up = healthzOk("http://127.0.0.1:" + HostService.PORT + "/healthz");
            }
            final boolean ready = up;
            main.post(() -> {
                if (ready) {
                    applyOrigin("http://127.0.0.1:" + HostService.PORT);
                } else {
                    toast("离线服务启动超时，请稍后重试或查看参数");
                }
            });
        }, "host-ensure").start();
    }

    /** Opens one of the in-page game-styled panels (servers / params) inside the WebView. */
    private void openPanelJs(String kind) {
        if (web == null) return;
        web.evaluateJavascript(
                "window.__SP_SHELL && window.__SP_SHELL.openPanel && window.__SP_SHELL.openPanel('" + kind + "')",
                null);
    }

    /** Applies an origin (switch + persist + reload). */
    private void applyOrigin(String url) {
        origin = url;
        originHost = hostOf(origin);
        prefs.edit().putString("origin", origin).apply();
        onlineMode = false;
        dcConfig = null;
        checkServerVersion();
        web.loadUrl(origin + "/");
    }

    /** 自动线路: probe all remote lines and switch to the LOWEST-RTT one (null-safe). */
    private void resolveAutoOrigin(boolean announce) {
        new Thread(() -> {
            String best = probeBestLine();
            main.post(() -> {
                if (best != null) {
                    applyOrigin(best);
                    if (announce) toast("自动线路：" + currentLineLabel());
                } else if (announce) {
                    toast("自动线路未探测到可用服务器");
                }
            });
        }, "shell-auto-line").start();
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
        String[] items = {"输房号加入", "服务器（切换线路）", "参数（房主配置）", "检查更新", "停止房主服务"};
        new AlertDialog.Builder(this)
                .setTitle("卫戍协议壳")
                .setMessage("当前线路：" + currentLineLabel() + "\n" + contentLabel + "\n" + hostLabel)
                .setItems(items, (d, which) -> {
                    if (which == 0) joinByCode();
                    else if (which == 1) openPanelJs("servers");
                    else if (which == 2) openPanelJs("params");
                    else if (which == 3) checkForUpdate();
                    else stopService(new Intent(this, HostService.class));
                })
                .show();
    }

    // ------------------------------------------------------------------
    // Host mode: the service auto-starts in onCreate (默认启动房主服务); the
    // shell menu only offers 停止房主服务, everything else lives in-page.
    // ------------------------------------------------------------------

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
    // Hot update (upstream release → filesDir/webroot)
    // ------------------------------------------------------------------

    private void checkForUpdate() {
        toast("正在检查内容更新…");
        new Thread(() -> {
            Updater.Manifest m = Updater.fetchManifest(this);
            main.post(() -> {
                if (isFinishing()) return;
                if (m == null || !m.usable()) {
                    toast("检查失败：清单不可用（可稍后重试）");
                    return;
                }
                if (Updater.requiresNewApk(m)) {
                    new AlertDialog.Builder(this)
                            .setTitle("需要新版应用")
                            .setMessage("最新内容要求更高的应用版本（需要 " + m.minApk + "，当前 "
                                    + BuildConfig.VERSION_CODE + "）。\n\n请下载安装新版 APK。")
                            .setPositiveButton("前往下载", (d, w) -> openApkPage())
                            .setNegativeButton("以后再说", null)
                            .show();
                    return;
                }
                if (!Updater.needsUpdate(this, m)) {
                    toast("已是最新：" + m.buildTag);
                    return;
                }
                String size = m.slimSize > 0 ? "（约 " + (m.slimSize / 1024 / 1024) + "MB）" : "";
                new AlertDialog.Builder(this)
                        .setTitle("发现内容更新")
                        .setMessage("内容 " + m.buildTag + " 已发布（当前：" + Updater.currentBuildTag(this) + "）"
                                + size + "。\n\n只更新游戏内容，无需重装 APK；失败会自动回滚。")
                        .setPositiveButton("下载并安装", (d, w) -> runUpdate(m))
                        .setNegativeButton("以后再说", null)
                        .show();
            });
        }, "shell-update-check").start();
    }

    private void openApkPage() {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(Updater.APK_PAGE)));
        } catch (Exception e) {
            toast("请在浏览器打开：" + Updater.APK_PAGE);
        }
    }

    private AlertDialog updatingDialog;

    private void runUpdate(Updater.Manifest manifest) {
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
                .setTitle("内容更新 " + manifest.buildTag)
                .setView(box)
                .setCancelable(false)
                .show();

        new Thread(() -> {
            try {
                Updater.hotUpdate(this, manifest, new Updater.Progress() {
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
                            .setMessage("内容已更新到 " + manifest.buildTag + "。")
                            .setPositiveButton("热重载", (d, w) -> {
                                if (HostService.isUp()) {
                                    restartHostService();
                                } else {
                                    web.reload();
                                }
                            })
                            .setNegativeButton("稍后", null)
                            .show();
                });
            } catch (IOException e) {
                main.post(() -> {
                    dismissUpdating();
                    new AlertDialog.Builder(this)
                            .setTitle("更新失败")
                            .setMessage("已保留当前版本。\n\n" + e.getMessage()
                                    + "\n\n可前往下载站安装最新 APK。")
                            .setPositiveButton("前往下载", (d, w) -> openApkPage())
                            .setNegativeButton("关闭", null)
                            .show();
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

            String rawPath = url.getPath();
            // Shell-owned bridge scripts are ALWAYS served from the APK (never from a server), so a
            // third-party page cannot shadow the CORS guard or the DataChannel adapter (P0-2).
            if (rawPath != null && rawPath.startsWith(SHELL_JS_PREFIX)) return serveShellAsset(rawPath);

            // CDN asset host: resolve /assets/** against the embedded tree so APK clients stay
            // fully local even though the manifests point at the CDN; a miss falls through to the network.
            if (!onlineMode && isAssetCdnHost(host)) {
                if (rawPath != null && rawPath.startsWith("/assets/")) {
                    InputStream cdnIn = openLocal(rawPath);
                    if (cdnIn != null) return serveLocal(rawPath, cdnIn);
                }
                return null;
            }
            if (onlineMode) return null;
            if (originHost == null || !originHost.equalsIgnoreCase(host)) return null;
            if (!"GET".equalsIgnoreCase(request.getMethod())) return null;

            String path = normalizePath(rawPath);
            if (path == null) return null;
            if (path.endsWith("/")) path = path + "index.html";

            // 1) local tree first (filesDir → APK assets): a hit is served from the device, and HTML
            //    responses get the shell's bridge injection (P0-2)
            InputStream in = openLocal(path);
            if (in != null) return serveLocal(path, in);

            // 2) not embedded → the passthrough table
            if ("/healthz".equals(path) || "/ws".equals(path)) return null; // game protocol
            if (path.startsWith("/assets/")) return null;                   // third-party art

            // 3) other client code the local tree does not have → explicit consent, per host
            if (!ServerList.hasConsent(MainActivity.this, host)) {
                requestConsent(host);
                return notFound();
            }
            return null;
        }

        /**
         * Serves a local file. HTML gets the bridge injection; the two asset manifests are
         * de-CDN'd back to origin-relative paths so an APK never loads a cross-origin texture
         * (same-origin images can never taint a canvas — the SecurityError that killed the 3D board).
         */
        private WebResourceResponse serveLocal(String path, InputStream in) {
            String mime = mimeFor(path);
            boolean html = "text/html".equals(mime);
            boolean manifest = "/data/assets.json".equals(path) || "/data/local-assets.json".equals(path);
            if (html || manifest) {
                try {
                    String text = readAll(in);
                    if (html) {
                        if (dcConfig != null && path.endsWith("/index.html") && text.contains("/*SPDC*/")) {
                            text = text.replace("/*SPDC*/", dcConfig.toString());
                        }
                        text = injectShellHtml(text);
                    } else {
                        text = text.replace("https://weishucdn.jiangjiangze.icu/assets/", "/assets/")
                                   .replace("https://jingjiangze.github.io/Stronghold-Protocol/assets/", "/assets/");
                    }
                    return respond(mime, "utf-8", new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)));
                } catch (IOException ignored) {
                    // fall through and serve the raw stream
                }
            }
            String enc = mime.startsWith("text/") || mime.contains("json") || mime.contains("javascript")
                    ? "utf-8" : null;
            return respond(mime, enc, in);
        }

        /** /__sp/<name> → the APK's own webroot/js/<name>; never the network, never filesDir. */
        private WebResourceResponse serveShellAsset(String path) {
            String name = path.substring(SHELL_JS_PREFIX.length());
            if (name.isEmpty() || name.indexOf('/') >= 0 || name.contains("..")) return notFound();
            try {
                InputStream in = getAssets().open(ASSET_ROOT + "/js/" + name);
                return respond(mimeFor(name), "utf-8", in);
            } catch (IOException e) {
                return notFound();
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            hideLoading();
            view.evaluateJavascript(
                "try{document.documentElement.classList.add('sp-standalone')}catch(e){}"
                + "try{if(!window.__SP_ERR_HOOK){window.__SP_ERR_HOOK=1;"
                + "window.addEventListener('error',function(ev){try{window.shell&&window.shell.logJsError&&window.shell.logJsError((ev.message||'error')+' @ '+((ev.filename||'')+':'+(ev.lineno||0)))}catch(e){}});"
                + "window.addEventListener('unhandledrejection',function(ev){try{window.shell&&window.shell.logJsError&&window.shell.logJsError('rejection: '+String(ev.reason))}catch(e){}})}}catch(e){}",
                null);
            maybeShowCrashNotice();
            // the page rendered: the freshly swapped tree is good, drop the rollback copy
            Updater.markHealthy(MainActivity.this);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
            if (request.isForMainFrame()) {
                hideLoading();
                showErrorPage();
            }
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

    private static final String SHELL_JS_PREFIX = "/__sp/";

    /** Rejects traversal/empty segments; returns null when the path is not servable. */
    private static String normalizePath(String p) {
        if (p == null || p.isEmpty() || !p.startsWith("/")) return null;
        if (p.contains("//")) return null;
        for (String seg : p.split("/")) {
            if (seg.isEmpty()) continue;
            if (seg.equals(".") || seg.equals("..") || seg.startsWith(".")) return null;
        }
        return p;
    }

    private WebResourceResponse notFound() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers,
                new ByteArrayInputStream(new byte[0]));
    }

    /**
     * P0-2: the CORS guard and the bridge adapters are injected into EVERY HTML response, so an
     * upstream release that replaces index.html/assets.js cannot drop them. Both snippets are
     * self-guarding, so a page that already loads them is left untouched.
     */
    private static final String SHELL_INJECT =
            "<script>(function(){if(window.__SP_CORS_HOOK)return;window.__SP_CORS_HOOK=1;"
            + "try{var d=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');"
            + "if(d&&d.set){Object.defineProperty(HTMLImageElement.prototype,'src',{get:d.get,set:function(v){"
            + "try{if(v&&!this.crossOrigin)this.crossOrigin='anonymous'}catch(e){}return d.set.call(this,v)}})}}"
            + "catch(e){}})();</script>"
            + "<script>(function(){if(window.__SP_SHELL)return;"
            + "['shell-bridge.js','dc-bridge.js'].forEach(function(n){"
            + "var s=document.createElement('script');s.src='" + SHELL_JS_PREFIX + "'+n;document.head.appendChild(s)})})();</script>";

    private String injectShellHtml(String html) {
        if (html.contains(SHELL_JS_PREFIX + "shell-bridge.js")) return html;
        int at = html.lastIndexOf("</body>");
        if (at < 0) at = html.lastIndexOf("</html>");
        if (at < 0) return html + SHELL_INJECT;
        return html.substring(0, at) + SHELL_INJECT + html.substring(at);
    }

    private final java.util.Set<String> consentAsking =
            java.util.Collections.synchronizedSet(new java.util.HashSet<String>());

    /** 免责声明: asked once per host, before any third-party client code is allowed to load. */
    private void requestConsent(String host) {
        if (!consentAsking.add(host)) return;
        main.post(() -> new AlertDialog.Builder(this)
                .setTitle("该服务器提供了额外内容")
                .setMessage("该服务器提供了本地没有的内容（可能包含它自己的客户端代码），加载后将运行第三方代码。"
                        + "仅在信任该服务器时继续。")
                .setPositiveButton("信任并加载", (d, w) -> {
                    ServerList.grantConsent(this, host);
                    consentAsking.remove(host);
                    if (web != null) web.reload();
                })
                .setNegativeButton("拒绝", (d, w) -> consentAsking.remove(host))
                .setOnCancelListener(d -> consentAsking.remove(host))
                .show());
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
                .setNeutralButton("切换服务器", (d, w) -> openPanelJs("servers"))
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
            main.post(() -> openPanelJs("servers"));
        }

        @JavascriptInterface
        public void host() {
            main.post(() -> {
                if (!HostService.isUp()) {
                    startForegroundServiceCompat(new Intent(MainActivity.this, HostService.class));
                    toast("房主服务启动中，房间将自动发布…");
                } else {
                    toast("房主服务运行中，房间已自动发布");
                }
            });
        }

        @JavascriptInterface
        public void join() {
            main.post(MainActivity.this::joinByCode);
        }

        @JavascriptInterface
        public void params() {
            main.post(() -> openPanelJs("params"));
        }

        @JavascriptInterface
        public String hostStatus() {
            return HostService.isUp() ? "房主服务：运行中 · 房间已自动发布" : "房主服务：未启动";
        }

        @JavascriptInterface
        public void logJsError(String msg) {
            appendLogFile("crash.log", "js: " + (msg == null ? "" : msg));
        }

        @JavascriptInterface
        public String currentServer() {
            return origin;
        }

        /** 服务器面板的数据源：三行（自动线路 / 离线服务 / 自定义线路）；域名一律不出现。 */
        @JavascriptInterface
        public String getServers() {
            try {
                boolean localUp = healthzOk("http://127.0.0.1:" + HostService.PORT + "/healthz");
                org.json.JSONArray arr = new org.json.JSONArray();
                arr.put(serverEntry("auto", "自动线路", "", "测速选最优"));
                arr.put(serverEntry("local", "离线服务",
                        "http://127.0.0.1:3000",
                        localUp ? "运行中 · 单机自开房推荐" : "按需启动 · 单机自开房推荐"));
                arr.put(serverEntry("custom", "自定义线路", "", ""));
                return arr.toString();
            } catch (Exception e) {
                return "[]";
            }
        }

        private org.json.JSONObject serverEntry(String id, String label, String url, String note) throws Exception {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("id", id);
            o.put("label", label);
            o.put("url", url);
            o.put("note", note == null ? "" : note);
            o.put("current", !url.isEmpty() && origin.startsWith(url));
            return o;
        }

        /**
         * The signed server list for the panel: source + ranked entries. Served from the cache so
         * the panel opens instantly; refreshServerList() re-pulls and re-probes in the background.
         * Domains never leave the shell — the page only ever sees names and measurements.
         */
        @JavascriptInterface
        public String getServerList() {
            ServerList.Snapshot snap = serverSnapshot;
            try {
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("source", snap == null ? "载入中" : snap.source);
                o.put("loading", serverListLoading);
                o.put("localProtocol", ServerList.localProtocol(MainActivity.this));
                o.put("localApp", ServerList.localApp(MainActivity.this));
                o.put("entries", snap == null
                        ? new org.json.JSONArray()
                        : new org.json.JSONArray(ServerList.toPanelJson(snap.entries)));
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        /** Re-pulls the signed list and re-probes every entry, then pushes the result to the page. */
        @JavascriptInterface
        public void refreshServerList() {
            reloadServerList(true);
        }

        @JavascriptInterface
        public void clearConsent() {
            ServerList.clearConsent(MainActivity.this);
            toast("已清除全部第三方内容授权");
        }

        /** 面板点选线路：id 或 "custom:<url>"。 */
        @JavascriptInterface
        public void setServer(String target) {
            main.post(() -> {
                if (target == null) return;
                String url;
                switch (target) {
                    case "local":
                        // 离线服务: on-demand start (slim materialise + Node) then switch
                        ensureHostAndSwitch();
                        return;
                    case "auto":
                        prefs.edit().putString("origin", "auto").apply();
                        resolveAutoOrigin(true);
                        return;
                    default:
                        if (target.startsWith("custom:https://")) {
                            url = target.substring("custom:".length());
                        } else {
                            // a signed-list entry id → its URL (already validated when the list was parsed)
                            String byId = lookupServerUrl(target);
                            if (byId == null) return;
                            url = byId;
                        }
                }
                applyOrigin(url);
            });
        }

        /** Resolves a signed-list entry id to a joinable URL; null when unknown or incompatible. */
        private String lookupServerUrl(String id) {
            ServerList.Snapshot snap = serverSnapshot;
            if (snap == null) return null;
            for (ServerList.Entry e : snap.entries) {
                if (e.id.equals(id)) return e.joinable() ? e.url : null;
            }
            return null;
        }

        @JavascriptInterface
        public String getParams() {
            HostParams p = HostParams.load(MainActivity.this);
            try {
                return new org.json.JSONObject()
                        .put("port", p.port)
                        .put("hostBind", p.hostBind)
                        .put("spCombat", p.spCombat)
                        .put("spVerify", p.spVerify)
                        .put("trustProxy", p.trustProxy)
                        .toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void setParamsJson(String json) {
            try {
                org.json.JSONObject o = new org.json.JSONObject(json == null ? "{}" : json);
                HostParams.save(MainActivity.this,
                        o.optInt("port", 3000),
                        o.optString("hostBind", "::"),
                        o.optString("spCombat", "client"),
                        o.optString("spVerify", "off"),
                        o.optString("trustProxy", "auto"));
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void restartApp() {
            main.post(() -> {
                stopService(new Intent(MainActivity.this, HostService.class));
                toast("参数已保存，重启应用…");
                main.postDelayed(() -> {
                    finishAffinity();
                    android.os.Process.killProcess(android.os.Process.myPid());
                }, 300);
            });
        }

        /** 热切换：只重启内嵌房主服务（约 2 秒），不重启应用。 */
        @JavascriptInterface
        public void restartHost() {
            main.post(MainActivity.this::restartHostService);
        }
    }

    /** Loads (and optionally probes) the signed server list off the main thread. */
    private void reloadServerList(boolean announce) {
        if (serverListLoading) return;
        serverListLoading = true;
        new Thread(() -> {
            try {
                ServerList.Snapshot snap = ServerList.load(this);
                ServerList.probeAll(this, snap.entries);
                ServerList.rank(snap.entries);
                serverSnapshot = snap;
            } catch (Exception e) {
                appendLogFile("crash.log", "server list: " + e);
            } finally {
                serverListLoading = false;
            }
            main.post(() -> {
                if (announce) toast("服务器清单已更新");
                pushServerList();
            });
        }, "shell-server-list").start();
    }

    /** Hands the current list to the in-page panel (a no-op until the page defines the hook). */
    private void pushServerList() {
        if (web == null) return;
        String json = new ShellBridge().getServerList();
        web.evaluateJavascript(
                "window.__SP_SHELL&&window.__SP_SHELL.onServers&&window.__SP_SHELL.onServers("
                        + org.json.JSONObject.quote(json) + ")", null);
    }

    /** Hot-switch/hot-reload: restart only the embedded host service, then refresh the page (~2s). */
    private void restartHostService() {
        toast("房主服务重启中…");
        stopService(new Intent(this, HostService.class));
        startForegroundServiceCompat(new Intent(this, HostService.class));
        new Thread(() -> {
            boolean up = false;
            for (int i = 0; i < 24 && !up; i++) {
                sleep(500);
                up = healthzOk("http://127.0.0.1:" + HostService.PORT + "/healthz");
            }
            final boolean ready = up;
            main.post(() -> {
                if (ready) {
                    web.loadUrl(origin + "/");
                }
                toast(ready ? "房主服务已重启" : "房主服务重启超时，请查看参数或重试");
            });
        }, "host-restart").start();
    }

    private void setOnlineMode(boolean on) {
        onlineMode = on;
        if (on) toast("已切换在线模式：资源改从服务器加载");
        web.loadUrl(origin + "/");
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
            // domains are never surfaced: pass an empty origin to the page
            html = html.replace("</head>",
                    "<script>window.__SHELL_ORIGIN='';</script></head>");
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
