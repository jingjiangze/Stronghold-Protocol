package icu.jiangjiangze.stronghold;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ClipDrawable;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
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
import android.widget.ProgressBar;
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
    /**
     * 本地自托管字体表（extras → webroot/fonts/，随热更更新）。上游 index.html 仍向
     * fonts.googleapis.com 要 CSS（那是上游文件，我们不改）；页面来自本地树时这份表就是那个
     * 请求的答案 —— 见 {@link RemoteClientPolicy#fontFromLocalTable}。
     */
    private static final String LOCAL_FONT_CSS = "/fonts/webfonts-local.css";
    private static final Pattern ROOM_CODE = Pattern.compile("[A-HJ-NP-Z]{4}");
    private static final int MENU_STRIP_DP = 12;

    /**
     * 素材热更（P0）占位图：1×1 透明 PNG（68 字节，RGBA 全 0）。素材缺失时页面必须拿到 200 +
     * 可用图片而不是 404/跨域失败——图片用透明像素，音频等其它类型用空体 + 正确 MIME（§6.3-A、§10-13）。
     */
    private static final byte[] ART_PLACEHOLDER_PNG = {
            -119, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13,
            73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
            8, 6, 0, 0, 0, 31, 21, -60, -119, 0, 0, 0,
            11, 73, 68, 65, 84, 120, -100, 99, 96, 0, 2, 0,
            0, 5, 0, 1, 122, 94, -85, 63, 0, 0, 0, 0,
            73, 69, 78, 68, -82, 66, 96, -126,
    };

    // 提交服务器（lobby 面板 → 站点 /api/servers/submit）: a fixed https endpoint only, no credentials.
    private static final String SUBMIT_ENDPOINT = "https://dl.jiangjiangze.icu/api/servers/submit";
    private static final String SUBMIT_HOST = "dl.jiangjiangze.icu";
    private static final int SUBMIT_TIMEOUT_MS = 6000;
    private static final int SUBMIT_MAX_BYTES = 8 * 1024;

    /**
     * 自动线路（业主 2026-10-08 口径）：优先取**网页服务器清单的第一个服务器**。数据就是
     * dl.jiangjiangze.icu/servers 页面用的那份 JSON —— 页面脚本先取 R2 热副本
     * (weishucdn…/site/servers.json)、再回退 ./data/servers.json；根路径 /servers.json 与两者
     * 逐字节相同（2026-10-08 cmp 验证），故第一来源用根路径这个稳定别名，R2 副本作第二来源。
     * 任一来源失败即按序回退，全部缺席/不可达 → 回落到既有的「版本 → 延迟」探测（today 行为）。
     */
    private static final String[] AUTO_LIST_SOURCES = {
            "https://dl.jiangjiangze.icu/servers.json",
            "https://weishucdn.jiangjiangze.icu/site/servers.json",
    };
    /** 清单 JSON 的主机白名单（纵深防御：只许项目自己的主机；绝不跟随重定向到别的主机）。 */
    private static final java.util.Set<String> AUTO_LIST_HOSTS = new java.util.HashSet<>(java.util.Arrays.asList(
            "dl.jiangjiangze.icu", "weishucdn.jiangjiangze.icu"));
    private static final int AUTO_LIST_TIMEOUT_MS = 2000;        // connect + read，各自的上限
    private static final int AUTO_LIST_MAX_BYTES = 256 * 1024;   // 清单 JSON 体积上限
    private static final long AUTO_LIST_TTL_MS = 5 * 60 * 1000;  // 首选服务器 url 的缓存窗口

    // no-embedded-assets fallback (/assets/** miss → CDN same-origin回源 + filesDir/art/cache 缓存).
    // See ArtCdn + 方案-静态资源热更新-2026-10-08.md §6.3. Kept small and boring on purpose.
    private static final long ART_CACHE_MAX_BYTES = 512L * 1024 * 1024; // filesDir/art/cache soft cap (inside ArtStore's art root)
    private static final int ART_FETCH_TIMEOUT_MS = 6000;               // connect timeout, per request
    /** Read timeout: a 1–3 MB spine page / voice line on a phone link legitimately needs more than
     *  the connect budget — timing out mid-body answered a live icon with the 1×1 placeholder. */
    private static final int ART_FETCH_READ_TIMEOUT_MS = 20000;
    private static final int ART_FETCH_MAX_BYTES = 64 * 1024 * 1024;    // per-response ceiling
    /**
     * 预载游标的 shell 侧落点（附加 A：跨 origin 可见，切服不再从头预载）。上限 1 MiB：记录里最多
     * 1000 条失败路径 + 少量计数，1 MiB 有十倍余量，同时挡住页面侧意外写入的巨型字符串。
     */
    private static final String ART_WALK_FILE = "art/walk-v1.json";
    private static final int ART_WALK_MAX_BYTES = 1 << 20;
    private static final int ART_FETCH_MAX_PARALLEL = 6;                // page in-flight fetches
    /**
     * Prefetch (marked) fetches: at most {@code ART_PREFETCH_MAX_PARALLEL} at a time, and they only
     * take a page slot when the page is idle (short patience) — so the prefetch can never starve a
     * live screen (H3, 2026-10-08).
     *
     * <p>审计 2026-10-09 阶段 5：预取允许 4 条（原来 2 条），与页面侧的 {@code MAX_WINDOW} 一致 ——
     * 页面侧健康时会把窗口从 2 扩到 4，而槽位不跟着放，多出来的那两条只会在 300 ms 后失败重试，
     * 纯属浪费。总并发同时 4 → 6，保证页面**永远**还有 2 条槽（预取在 300 ms 内让路），所以
     * 「页面优先」这条不变量没有被削弱。
     */
    private static final int ART_PREFETCH_MAX_PARALLEL = 4;
    private static final int ART_PREFETCH_SLOT_WAIT_MS = 300;
    /** How long a PAGE request waits for a CDN slot before giving up (a blank icon is worse than a
     *  short wait; the old value was the 6 s connect timeout, which a cold prefetch could exhaust). */
    private static final int ART_PAGE_SLOT_WAIT_MS = 12000;
    /** An auto-triggered art sync (one per missing asset) re-fetches the signed manifest and
     *  re-verifies every uninstalled pack — at thousands of misses that is the "资源一直在重复校验"
     *  loop of 2026-10-08. One auto attempt per window; the bridge/user path is never throttled. */
    private static final long ART_AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000L;
    /** A definitive 404/410 answer is remembered this long (per process): a missing asset must not
     *  be re-requested from the CDN on every page render. */
    private static final long ART_MISS_TTL_MS = 10 * 60 * 1000L;
    /** Local-art coverage list the prefetch consumes (see localArtListResponse). Same shell prefix
     *  as {@link #SHELL_JS_PREFIX}; spelled out here because a field initializer cannot forward-
     *  reference another field. */
    private static final String LOCAL_ART_LIST_PATH = "/__sp/local-assets.txt";
    private static final long LOCAL_ART_LIST_TTL_MS = 5 * 60 * 1000L;
    /** Cap on the "not in the APK" memory: more than the whole tree, so it never thrashes. */
    private static final int APK_MISS_CAP = 16384;

    private WebView web;
    /** HTML5 全屏（页面 requestFullscreen）当前交给原生的自定义 View；null = 不在全屏。见 ShellChromeClient。 */
    private View fullscreenView;
    /** 全屏容器：黑底 FrameLayout，MATCH_PARENT 挂在 android.R.id.content 上（盖住壳的全部内容）。 */
    private FrameLayout fullscreenContainer;
    /** WebView 给的回调：BACK 主动退全屏时用它通知页面（见 exitFullscreenFromBack）。 */
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    /** 进入全屏前 decor 的 system UI flags（26–29 退出时原样写回；30+ 见 exitFullscreen 注释）。 */
    private int preFullscreenUiVisibility;
    private SharedPreferences prefs;
    private String origin;
    private String originHost;
    /**
     * A2（审计 §1）：一次性标志——由失败兜底路径置位（见 {@link #applyOrigin(String, boolean)}），
     * loadBase 消费：置位时持久化写 "auto" 而非具体地址，保证失败兜底后下次冷启动仍走自动线路，
     * 而不是固定到本地 127.0.0.1:PORT。
     */
    private volatile boolean autoPersist = false;
    private volatile boolean onlineMode = false;
    /** Set by the interceptor when the MAIN FRAME's HTML came from the local tree (index.html served
     *  by serveLocal) — the local-tree half of the hot-update health signal. */
    private volatile boolean pageServedFromLocalTree = false;
    /**
     * Set when the MAIN FRAME's navigation reported an error (onReceivedError), cleared when a new
     * main-frame navigation starts (onPageStarted). The remote-client half of the health signal:
     * with「服务端界面」as the default the local tree never renders, so a successful landing on the
     * remote page must count as healthy — see {@link RemoteClientPolicy#healthy}.
     */
    private volatile boolean mainFrameErrored = false;
    /** When a join-by-code could not probe the host over TCP, the page gets a WebRTC-bridged WebSocket. */
    private volatile JSONObject dcConfig = null;
    /**
     * B（审计 §1）：dcConfig 设置时的基准 host。打洞配置只对「加入目标」这次导航有意义——页面
     * 落地后 host 已变（onPageFinished）或用户按返回（onBackPressed）即清除。注入发生在 HTML
     * 响应期（serveLocal），事后清除不影响已加载页面。
     */
    private volatile String dcOriginHost = null;
    /** Cached signed server list (loaded and probed off the main thread). */
    private volatile ServerList.Snapshot serverSnapshot;
    /** 自动线路的「网页清单第一个服务器」短缓存：url/probe + 拉取时刻（拉取失败不写缓存）。 */
    private volatile String autoFirstUrl = "";
    private volatile String autoFirstProbe = "/healthz";
    private volatile long autoFirstAt = 0;
    /** CAS-guarded so a panel refresh cannot race the cold-start load into two parallel pulls. */
    private final java.util.concurrent.atomic.AtomicBoolean serverListLoading =
            new java.util.concurrent.atomic.AtomicBoolean(false);
    private final Handler main = new Handler(Looper.getMainLooper());
    /** 离线服务默认启动：首帧页面渲染后拉起一次本机房主服务，进程内只触发一次（见 onPageFinished）。 */
    private volatile boolean hostDefaultStarted = false;

    /** One lock per in-flight /assets path so concurrent requests download it once (openAssetFromCdn). */
    private final java.util.concurrent.ConcurrentHashMap<String, Object> artFetchLocks =
            new java.util.concurrent.ConcurrentHashMap<>();
    /** Caps simultaneous CDN fetches the interceptor may hold (avoids a request storm on a cold page). */
    private final java.util.concurrent.Semaphore artFetchSlots =
            new java.util.concurrent.Semaphore(ART_FETCH_MAX_PARALLEL);
    /** Prefetch-only slots: a marked fetch must hold one of these AND a page slot (H3). */
    private final java.util.concurrent.Semaphore artPrefetchSlots =
            new java.util.concurrent.Semaphore(ART_PREFETCH_MAX_PARALLEL);
    /** Definitive-miss memory (path -> deadline): no CDN round-trip for a path already answered 4xx. */
    private final java.util.concurrent.ConcurrentHashMap<String, Long> artMissUntil =
            new java.util.concurrent.ConcurrentHashMap<>();
    /** Namespace the fetched-art cache was migrated to in this process (see artCacheNamespace). */
    private volatile String artCacheNamespaceDone = null;
    /** Guards the one-shot namespace adoption (a directory rename). */
    private final Object artCacheMigrateLock = new Object();
    /**
     * 审计 2026-10-09 阶段 1（方案 1）：逐文件摘要。
     * <ul>
     *   <li>{@code artDigests} / {@code artDigestsHash} —— 从 {@code /data/asset-digests.json} 解析出的
     *       {@code <rel> → sha256} 表，以及它声明的清单 hash。两者一起缓存；hash 不符的表不采用。</li>
     *   <li>{@code artNamespaceAdopted} —— 当前命名空间是不是**改名继承**来的。只有继承来的字节才需要
     *       逐个校验：自己下载的字节就是当前 hash 下的内容。</li>
     *   <li>{@code artVerified} / {@code artVerifiedNs} —— 本进程内已验过的路径（命名空间变化即清空）。</li>
     * </ul>
     */
    private volatile java.util.Map<String, String> artDigests = null;
    private volatile String artDigestsHash = null;
    private volatile boolean artNamespaceAdopted = false;
    private volatile java.util.Set<String> artVerified =
            java.util.concurrent.ConcurrentHashMap.<String>newKeySet();
    private volatile String artVerifiedNs = null;
    /** Last auto-triggered art sync (see ART_AUTO_SYNC_MIN_INTERVAL_MS). */
    private volatile long lastAutoArtSyncAt = 0L;
    /** Local-art coverage list + the APK's own asset-path list (both cached; see localArtList). */
    private volatile String localArtListCache = null;
    private volatile long localArtListAt = 0L;
    private volatile java.util.List<String> apkArtListCache = null;
    /** Paths the APK tree does NOT carry (probed once per process: the APK never changes at runtime). */
    private final java.util.Set<String> apkMisses =
            java.util.concurrent.ConcurrentHashMap.<String>newKeySet();
    /** Cache-write counter: prune every N writes instead of walking the tree on every request. */
    private static final java.util.concurrent.atomic.AtomicLong ART_CACHE_WRITES =
            new java.util.concurrent.atomic.AtomicLong();
    /** Manifest `hash` used to namespace filesDir/art/cache (see currentArtHash). */
    private volatile String artHashCache = null;
    private volatile long artHashStamp = Long.MIN_VALUE;

    /** 加入房间 404 兜底窗口：非 null 表示正处于「加入房间导航」中（见 joinOnOrigin）。 */
    private volatile String joinFallbackBase;    // 签名清单里的原始 base（如 .../play）
    private volatile String joinFallbackCode;    // 房号
    private volatile String joinFallbackLoading; // 当前正在加载的候选 URL（成功渲染即关窗）
    private volatile int joinFallbackStep;       // 已尝试到第几个候选
    private volatile long joinFallbackAt;        // 窗口起点，超时后不再兜底
    private static final long JOIN_FALLBACK_WINDOW_MS = 15000L;

    /**
     * 返回键修复（审计 PR#23 中优先级）：只在**切服/加入这类顶层导航**之后清一次 WebView 历史，
     * 而不是每次同主机页面加载都清 —— 后者会把站点内部的整页跳转历史也一起抹掉，返回键就回不去上一页了。
     * 由 loadBase / 404 兜底 / lan: 加入置位，onPageFinished 消费一次。
     */
    private volatile boolean historyClearPending;

    /** 局域网扫描的请求序号：只有最新一轮的结果会被回吐（审计 PR#23：结果要认领回发起它的请求）。 */
    private volatile long lanScanSeq;

    /** 邀请码兜底探测：并发上限、单站超时、整体预算（resolveInvite 同步桥调用，必须封顶）。 */
    private static final int INVITE_PROBE_CONCURRENCY = 6;
    private static final int INVITE_PROBE_TIMEOUT_MS = 3000;
    private static final long INVITE_TOTAL_BUDGET_MS = 8000L;

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

        // 服务器配置（ServerConfig）：进程级接线 + 变化回调。配置**不是启动依赖** —— 拿不到就是
        // 「服务器没声明任何东西」，页面照常运行（§3/§20 last-good 要求）。
        ServerConfigHub.init(this);
        ServerConfigHub.addListener((c, o) -> {
            appendDiagLog("server-config", "v" + c.version() + " from " + o);
            notifyServerConfigChanged();
        });
        ShellConfigStore.addListener(c -> appendDiagLog("shell-config", "v" + c.version() + " " + c.configVersion()));

        // 素材缓存实况（feat/art-cache-status）：启动时后台对账一次（单次扫描 art/cache/<hash> 并把
        // 内存计数器/元数据修到与磁盘一致）。此后 ShellBridge.artCacheStatus() 只读计数器，O(1)。
        ensureArtCacheReconcile();

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
            // The hotspot rides the top edge below whatever system bar is actually visible; with
            // the bars hidden by applyImmersive() this is 0 → full-bleed top edge.
            int top = Build.VERSION.SDK_INT >= 30
                    ? insets.getInsets(WindowInsets.Type.systemBars()).top
                    : insets.getSystemWindowInsetTop();
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

        new Thread(() -> {
            // 0) one-time migration after an overwrite-install: stale trees from earlier versions
            // are wiped (user-directed) so half-written/legacy layouts can never cause page crashes.
            int lastVc = prefs.getInt("versionCode", 0);
            if (lastVc != BuildConfig.VERSION_CODE) {
                setLoadingText("正在更新数据…");
                migrateWipe();
                // v2.7.0: tapping a room-scoped row used to silently enable its own client; reset
                // every per-host flag so the default is again the embedded client (explicit only)
                resetRemoteClientFlags();
                prefs.edit().putInt("versionCode", BuildConfig.VERSION_CODE).apply();
            }
            // a hot update that never rendered rolls back to the tree it replaced
            Updater.rollbackIfUnhealthy(this);
            // 1) 开屏**不做任何线路探测、不自动切服**（业主 2026-10-09 紧急口径：开屏自动测速选服
            //    会把首页顶到别人的服务器上）。冷启动只加载本地/上次线路，首页永远是我们的界面；
            //    「自动线路」只在玩家在服务器面板里显式点它时才探测（见 ShellBridge 的 auto 分支）。
            //    COLD START DOES NO MATERIALISE AND STARTS NO NODE — 离线服务由面板按需启动。
            main.post(() -> loadBase(origin));
        }, "shell-boot").start();

        // The signed server list is pulled and probed in the background; the panel shows it when ready.
        reloadServerList(false);
        // patch-type updates are the DEFAULT: check right after the page is up, silently, and
        // never block the boot path (failures are quiet; the manual 检查更新 entry stays as backup).
        main.postDelayed(() -> autoCheckForUpdate(), 8000);

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

    /** One /healthz probe verdict: RTT (ms, -1 = unreachable) + the app version the line reports ("" = none). */
    private static final class LineProbe {
        final long rttMs;
        final String app;
        LineProbe(long rttMs, String app) {
            this.rttMs = rttMs;
            this.app = app == null ? "" : app;
        }
    }

    /** 自动线路: the highest reported version wins; equal versions fall back to the lowest /healthz RTT.
     *  A line that reports no version at all ranks below every versioned line — an unsynced or broken
     *  line must never be auto-picked over a healthy one (null = none reachable).
     *  v7.6（业主口径）：先试网页服务器清单的第一个服务器（{@link #probeWebListFirst}），只有它
     *  缺席/不可达时才回落到下面的版本+延迟排名（today 行为）。 */
    private String probeBestLine() {
        String webFirst = probeWebListFirst();
        if (webFirst != null) return webFirst;
        String[] lines = lineOrigins().toArray(new String[0]);
        final LineProbe[] probes = new LineProbe[lines.length];
        Thread[] ts = new Thread[lines.length];
        for (int i = 0; i < lines.length; i++) {
            final int idx = i;
            ts[i] = new Thread(() -> probes[idx] = probeLine(lines[idx]), "probe-" + i);
            ts[i].start();
        }
        for (Thread t : ts) {
            try {
                t.join(2500);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
        int bestIdx = -1;
        for (int i = 0; i < lines.length; i++) {
            LineProbe p = probes[i];
            if (p == null || p.rttMs <= 0) continue; // unreachable lines never win
            if (bestIdx < 0) {
                bestIdx = i;
                continue;
            }
            LineProbe b = probes[bestIdx];
            int cmp = compareVersions(p.app, b.app);
            if (cmp != 0 ? cmp > 0 : p.rttMs < b.rttMs) bestIdx = i;
        }
        return bestIdx < 0 ? null : lines[bestIdx];
    }

    /** 网页服务器清单第一个服务器的 url + 探测路径（servers[0]，与站点页面同一份数据）。 */
    private static final class WebPick {
        final String url;
        final String probe;
        WebPick(String url, String probe) {
            this.url = url;
            this.probe = probe;
        }
    }

    /**
     * v7.6（业主口径）：自动线路优先取网页服务器清单（dl.jiangjiangze.icu/servers 的数据，
     * AUTO_LIST_SOURCES）的**第一个**服务器。清单本体缓存 {@link #AUTO_LIST_TTL_MS}，可达性
     * 每次都实测（{@link #probeLine(String, String)}）。返回 null = 清单缺席/首个条目停用或非法/
     * 不可达 → 调用方回落到既有探测（失败 = today 行为）。
     * <p>安全：只拉 AUTO_LIST_HOSTS 上的 https；不跟随重定向；超时 + 体积上限；首个服务器的
     * url 必须 https + 公网主机（ServerList.isPublicHttpUrl 的 loopback/private/reserved 全表
     * 拒斥）——一份被篡改的清单不能把应用变成内网探测器。
     */
    private String probeWebListFirst() {
        String url = autoFirstUrl;
        String probe = autoFirstProbe;
        if (url == null || url.isEmpty() || System.currentTimeMillis() - autoFirstAt > AUTO_LIST_TTL_MS) {
            url = "";
            probe = "/healthz";
            for (String src : AUTO_LIST_SOURCES) {
                WebPick pick = firstServerOf(fetchAutoListJson(src));
                if (pick != null) {
                    url = pick.url;
                    probe = pick.probe;
                    break;
                }
            }
            autoFirstUrl = url;
            autoFirstProbe = probe;
            autoFirstAt = System.currentTimeMillis();
            if (url.isEmpty()) return null; // 两份来源都缺席：下次调用重试（不吃 TTL 缓存）
        }
        if (!isAutoTargetUrl(url)) return null;
        return probeLine(url, probe).rttMs > 0 ? url : null;
    }

    /** 自动线路目标校验：https + 公网主机（拒绝 localhost/回环/私有/保留地址与带凭据的 URL）。 */
    private static boolean isAutoTargetUrl(String url) {
        return url != null && url.startsWith("https://") && ServerList.isPublicHttpUrl(url);
    }

    /** 网页清单里的第一个服务器：servers[0].url（缺失/非法/停用 → null）。 */
    private static WebPick firstServerOf(String json) {
        if (json == null || json.isEmpty()) return null;
        try {
            org.json.JSONObject o = new org.json.JSONObject(json);
            org.json.JSONArray arr = o.optJSONArray("servers");
            if (arr == null || arr.length() == 0) return null;
            org.json.JSONObject first = arr.optJSONObject(0);
            if (first == null) return null;
            if (first.has("enabled") && !first.optBoolean("enabled", true)) return null; // 停用视为缺席
            String url = first.optString("url", "").trim();
            if (url.isEmpty() || !isAutoTargetUrl(url)) return null;
            String probe = first.optString("probe", "/healthz").trim();
            if (probe.isEmpty() || probe.indexOf(' ') >= 0) probe = "/healthz";
            return new WebPick(url, probe);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 拉取一份服务器清单 JSON（https only + 固定主机白名单 + 不跟重定向 + 短超时 + 体积上限）。
     * 任何失败（网络/DNS/状态码/超限/解析前置）都返回 ""，调用方按序回退、最终回落既有探测。
     */
    private static String fetchAutoListJson(String url) {
        HttpURLConnection c = null;
        try {
            URL u = new URL(url);
            if (!"https".equalsIgnoreCase(u.getProtocol())) return "";
            String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
            if (!AUTO_LIST_HOSTS.contains(host)) return "";
            if (u.getUserInfo() != null && !u.getUserInfo().isEmpty()) return "";
            c = (HttpURLConnection) u.openConnection();
            c.setInstanceFollowRedirects(false); // 重定向（含跨主机）一律视为失败
            c.setConnectTimeout(AUTO_LIST_TIMEOUT_MS);
            c.setReadTimeout(AUTO_LIST_TIMEOUT_MS);
            c.setUseCaches(false);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "stronghold-shell");
            if (c.getResponseCode() != 200) return "";
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            try (InputStream in = c.getInputStream()) {
                while ((n = in.read(buf)) > 0) {
                    if (out.size() + n > AUTO_LIST_MAX_BYTES) return "";
                    out.write(buf, 0, n);
                }
            }
            return out.toString("UTF-8");
        } catch (Exception e) {
            return "";
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Numeric dot comparison ("0.1.10" > "0.1.9"); missing parts count as 0, non-digits end a part. */
    static int compareVersions(String a, String b) {
        String[] pa = String.valueOf(a == null ? "" : a).split("\\.");
        String[] pb = String.valueOf(b == null ? "" : b).split("\\.");
        int n = Math.max(pa.length, pb.length);
        for (int i = 0; i < n; i++) {
            long va = versionPart(pa, i);
            long vb = versionPart(pb, i);
            if (va != vb) return va < vb ? -1 : 1;
        }
        return 0;
    }

    private static long versionPart(String[] parts, int idx) {
        if (idx >= parts.length) return 0;
        String s = parts[idx].trim();
        long v = 0;
        for (int k = 0; k < s.length(); k++) {
            char ch = s.charAt(k);
            if (ch < '0' || ch > '9') break; // "0.1.3-rc1" → 3
            v = v * 10 + (ch - '0');
            if (v > 1000000000L) break;
        }
        return v;
    }

    /** One /healthz round trip: RTT + the reported app version (node {version,app} / cloudflare {version}). */
    private LineProbe probeLine(String base) {
        return probeLine(base, "/healthz");
    }

    /** 同上，但探测路径可指定（网页清单条目自带 probe 字段；缺省 /healthz）。 */
    private LineProbe probeLine(String base, String probePath) {
        String path = probePath == null || probePath.isEmpty() ? "/healthz" : probePath;
        if (!path.startsWith("/")) path = "/" + path;
        String root = String.valueOf(base == null ? "" : base).replaceAll("/+$", "");
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(root + path).openConnection();
            c.setConnectTimeout(1500);
            c.setReadTimeout(1500);
            c.setRequestProperty("Accept", "application/json");
            long t0 = System.nanoTime();
            if (c.getResponseCode() != 200) {
                c.disconnect();
                return new LineProbe(-1, "");
            }
            long ms = Math.max(1, (System.nanoTime() - t0) / 1_000_000);
            String app = readHealthzApp(c);
            c.disconnect();
            return new LineProbe(ms, app);
        } catch (Exception e) {
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Exception ignored) { /* already gone */ }
            }
            return new LineProbe(-1, "");
        }
    }

    /** app/version from a /healthz body (bounded read: 2 KB); "" when the body has neither. */
    private static String readHealthzApp(HttpURLConnection c) {
        try {
            java.io.InputStream in = c.getInputStream();
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[512];
            int n;
            while ((n = in.read(buf)) > 0 && bos.size() < 2048) bos.write(buf, 0, n);
            in.close();
            org.json.JSONObject o = new org.json.JSONObject(bos.toString("UTF-8"));
            String app = o.optString("app", "");
            if (app.isEmpty()) app = o.optString("version", "");
            return app;
        } catch (Exception e) {
            return "";
        }
    }

    /** Human label for the current origin — the raw domain is never shown in the UI. */
    private String currentLineLabel() {
        if (origin.startsWith("http://127.0.0.1")) return "离线服务";
        if (origin.contains("nyat.app")) return "国内线路";
        if (origin.contains("stronghold2") || origin.contains("weishu2")) return "国际线路 2";
        if (origin.contains("jiangjiangze.icu")) return "国际线路 1";
        // v7.6: 自动线路可能落到网页清单里的任意服务器（社区服）—— 先按签名清单条目的 host
        // 找友好名；找不到才叫「自定义线路」。
        try {
            ServerList.Snapshot snap = serverSnapshot;
            String h = originHost;
            if (snap != null && snap.entries != null && h != null) {
                for (ServerList.Entry e : snap.entries) {
                    if (e == null || e.url == null) continue;
                    if (h.equalsIgnoreCase(hostOf(e.url))) return e.name == null || e.name.isEmpty() ? "自动线路" : e.name;
                }
            }
        } catch (Exception e) { /* 快照未就绪：走内置标签 */ }
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

    /** Clears every per-host「使用对方客户端」flag (v2.7.0 migration: the flag is explicit-only now). */
    private void resetRemoteClientFlags() {
        SharedPreferences p = prefs;
        int cleared = 0;
        for (String k : p.getAll().keySet()) {
            if (k.startsWith("remote-client:")) {
                p.edit().remove(k).apply();
                cleared++;
            }
        }
        if (cleared > 0) {
            appendLogFile("migration.log", "reset " + cleared + " remote-client flags");
        }
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

    /** Diagnostics that are NOT crashes (js errors, failed background tasks, guard trips) go to
     *  filesDir/diag.log. crash.log stays a true crash record, so the startup notice never lies. */
    private void appendDiagLog(String tag, String msg) {
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(new File(getFilesDir(), "diag.log"), true)) {
            out.write((System.currentTimeMillis() + " " + tag + ": " + msg + "\n")
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
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
        main.post(() -> {
            AlertDialog dlg = new AlertDialog.Builder(this)
                    .setTitle("检测到上次崩溃记录")
                    .setMessage(body.isEmpty() ? "（日志为空）" : body)
                    .setPositiveButton("清除记录", (d, w) -> {
                        //noinspection ResultOfMethodCallIgnored
                        crash.delete();
                    })
                    // listener attached after show(): 复制 must read the FULL log, not the 1.6 KB preview
                    .setNeutralButton("复制", null)
                    .setNegativeButton("保留", null)
                    .create();
            dlg.show();
            TextView msg = dlg.findViewById(android.R.id.message);
            if (msg != null) msg.setTextIsSelectable(true); // long-press to select/copy in the dialog
            dlg.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> {
                copyToClipboard("crash", readCrashLog());
                toast("已复制");
            });
        });
    }

    /** The complete crash record (the dialog shows only the first 1.6 KB). */
    private String readCrashLog() {
        File crash = new File(getFilesDir(), "crash.log");
        try (java.io.FileInputStream in = new java.io.FileInputStream(crash)) {
            return readAll(in);
        } catch (IOException e) {
            return "";
        }
    }

    private void copyToClipboard(String label, String text) {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) return;
        cm.setPrimaryClip(ClipData.newPlainText(label, text == null ? "" : text));
    }

    /** CDN hosts whose asset URLs resolve against the embedded tree (APK clients stay fully local). */
    private boolean isAssetCdnHost(String host) {
        return "weishucdn.jiangjiangze.icu".equals(host) || "jingjiangze.github.io".equals(host);
    }

    /**
     * Hosts the player opened with the server's OWN client. Some third-party deployments (CF
     * Workers ports) are room-scoped — their socket is /ws?room=&lt;code&gt; behind an auth step, so
     * our embedded client can never join them. For those the shell steps aside and serves nothing
     * locally, which also routes the first load through the 免责声明 gate.
     *
     * <p>v7.6（业主口径 2026-10-08「默认使用服务端 UI（设置中可改）」）：**默认开**。生效值 =
     * 逐 host 偏好显式写过就用它，否则全局默认 {@code remote-client-default}（缺省 true）。
     * 判定与两道硬门集中在 {@link RemoteClientPolicy#resolve}（纯逻辑，JVM 有测试）：
     * <ol>
     *   <li>只有「已知服务器 host」才有资格（{@link #isKnownServerHost}）—— 任意第三方页面
     *       保持今天的行为，绝不被接管。</li>
     *   <li>只有公网可寻址的 host 才有资格（{@link HostPolicy#isPublicHost}，与
     *       {@link ServerList#isPublicHttpUrl} 同一张表）—— 本机服务 {@code 127.0.0.1} 与局域网
     *       房间永远保留内嵌树，否则「本地客户端」那一页会丢掉 SHELL_INJECT（没有面板、没有设置、
     *       没有热更钩子）。</li>
     * </ol>
     */
    private boolean remoteClientFor(String host) {
        if (host == null || host.isEmpty()) return false;
        String key = RemoteClientPolicy.PREF_HOST_PREFIX + host;
        boolean explicit = prefs.contains(key);
        return RemoteClientPolicy.resolve(
                host,
                isKnownServerHost(host),
                explicit,
                explicit && prefs.getBoolean(key, false),
                prefs.getBoolean(RemoteClientPolicy.PREF_DEFAULT, RemoteClientPolicy.defaultGlobal()));
    }

    /** Opts a host in/out of using its own client (v3.3: pure UI preference, no consent record).
     *  显式写下逐 host 值后，它就永远赢过全局默认（{@code remote-client-default}）——包括
     *  「回到本地客户端」写下的 false（见 {@link #returnToLocalClient()}）。 */
    private void setRemoteClient(String host, boolean on) {
        if (host == null || host.isEmpty()) return;
        prefs.edit().putBoolean(RemoteClientPolicy.PREF_HOST_PREFIX + host, on).apply();
    }

    /**
     * 离线服务: start the host service on demand, wait for healthz, then switch to it.
     *  v2.7.0: the wait window is 60 s with staged feedback (materialise → node → still starting);
     *  a timeout is no longer a dead end — a diagnostic sheet offers 再等 / 查看日志 / 停止服务.
     *  A2（审计 §1）：成功落地即按「失败兜底切换」处理——持久化写 "auto"（不固化 127.0.0.1:PORT），
     *  下次冷启动仍走自动线路；显式语义通过 fallback 参数交给 applyOrigin 决定。
     */
    private void ensureHostAndSwitch() {
        // 无参 = 用户显式进入本机服务（首页「进入」/服务器面板）：这是明确选择，
        // 持久化具体地址而非 "auto"（A2 的 "auto" 只属于失败兜底路径，见 :1501）。
        ensureHostAndSwitch(false);
    }

    /** ensureHostAndSwitch 的语义参数版：fallback=true = 本次切换是失败兜底（A2 持久化 "auto"）。 */
    private void ensureHostAndSwitch(final boolean fallback) {
        setLoadingText("正在启动离线服务…");
        if (!HostService.isUp()) {
            HostService.nextGeneration();
            startForegroundServiceCompat(new Intent(this, HostService.class));
        }
        new Thread(() -> {
            final long t0 = System.currentTimeMillis();
            boolean up = false;
            for (int i = 0; i < 120 && !up; i++) { // 120 × 500ms = 60 s
                sleep(500);
                // v2.7.5: the node's handshake names the REAL port (port 0 → OS-assigned), so
                // poll readiness instead of a guessed port; PORT follows the handshake watcher
                up = HostService.isReady()
                        || healthzOk("http://127.0.0.1:" + HostService.PORT + "/healthz");
                long s = (System.currentTimeMillis() - t0) / 1000;
                if (i % 4 == 0) { // every 2 s
                    String stage = s < 10 ? "正在释放本地资源…"
                            : (s < 25 ? "正在启动房主服务（Node）…" : "仍在启动，大型内容首次解包较慢…");
                    setLoadingText(stage);
                }
            }
            final boolean ready = up;
            main.post(() -> {
                hideLoading();
                if (ready) {
                    applyOrigin("http://127.0.0.1:" + HostService.PORT, fallback);
                } else {
                    showHostStartupDiagnostic(fallback);
                }
            });
        }, "host-ensure").start();
    }

    /**
     * 进 app 默认启动离线服务（用户要求）：首帧页面渲染完成后异步拉起本机房主服务。
     * 只起服务、不切线路——切服仍由「进入」按钮的 {@link #ensureHostAndSwitch()} 负责；
     * {@link HostService#isUp()} 判重，因此与 ensureHostAndSwitch()/restartHostService() 不会重复启动。
     * 失败静默记 diag（用户无感，但可在参数页日志里诊断），绝不阻塞主线程。
     */
    private void ensureHostStartedDefault() {
        if (HostService.isUp()) return;
        try {
            startForegroundServiceCompat(new Intent(this, HostService.class));
        } catch (Exception e) {
            appendDiagLog("host-default", String.valueOf(e));
        }
    }

    /** 超时终态诊断：Node 状态 + 端口探测 + server.log 尾部，给出三条出路。 */
    private void showHostStartupDiagnostic(final boolean fallback) {
        // The probe and the log read are blocking I/O — never on the main thread (this method is
        // posted from ensureHostAndSwitch; the healthz call here was the field
        // NetworkOnMainThreadException). Facts are gathered on "host-diagnostic", the dialog is
        // built on main.
        new Thread(() -> {
            StringBuilder sb = new StringBuilder();
            boolean nodeAlive = NodeRunner.isAlive();
            boolean portAnswering = healthzOk("http://127.0.0.1:" + HostService.PORT + "/healthz");
            sb.append("等待 60 秒仍未就绪。\n\n");
            sb.append("Node 进程：").append(nodeAlive ? "存活（可能仍在初始化）" : "已退出").append('\n');
            sb.append("端口 ").append(HostService.PORT).append("：")
                    .append(portAnswering ? "有响应" : "无响应").append('\n');
            String logTail = readLastLines("run/server.log", 6);
            if (!logTail.isEmpty()) sb.append('\n').append("日志尾部：\n").append(logTail);
            final String body = sb.toString();
            main.post(() -> {
                if (isFinishing()) return;
                new AlertDialog.Builder(this)
                        .setTitle("离线服务启动慢")
                        .setMessage(body)
                        .setPositiveButton("再等 30 秒", (d, w) -> new Thread(() -> {
                            boolean ok = false;
                            for (int i = 0; i < 60 && !ok; i++) {
                                sleep(500);
                                ok = healthzOk("http://127.0.0.1:" + HostService.PORT + "/healthz");
                            }
                            final boolean ready = ok;
                            main.post(() -> {
                                if (ready) applyOrigin("http://127.0.0.1:" + HostService.PORT, fallback);
                                else toast("仍未就绪，请查看参数或稍后再试");
                            });
                        }, "host-ensure-more").start())
                        .setNeutralButton("停止服务", (d, w) -> stopService(new Intent(this, HostService.class)))
                        .setNegativeButton("关闭", null)
                        .show();
            });
        }, "host-diagnostic").start();
    }

    /** Last n lines of a file under filesDir (diagnostics only; missing file → empty). */
    private String readLastLines(String relPath, int n) {
        File f = new File(getFilesDir(), relPath);
        if (!f.isFile()) return "";
        try {
            java.util.Deque<String> lines = new java.util.ArrayDeque<>(n);
            try (java.io.BufferedReader r = new java.io.BufferedReader(
                    new java.io.InputStreamReader(new java.io.FileInputStream(f), java.nio.charset.StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    if (lines.size() == n) lines.pollFirst();
                    lines.addLast(line);
                }
            }
            StringBuilder sb = new StringBuilder();
            for (String l : lines) sb.append(l).append('\n');
            return sb.toString().trim();
        } catch (IOException e) {
            return "";
        }
    }

    /** Opens one of the in-page game-styled panels (servers / params) inside the WebView. */
    private void openPanelJs(String kind) {
        if (web == null) return;
        web.evaluateJavascript(
                "window.__SP_SHELL && window.__SP_SHELL.openPanel && window.__SP_SHELL.openPanel('" + kind + "')",
                null);
    }

    /** Applies an origin (switch + full state reset + persist + reload); 路径保真，见 loadBase。 */
    private void applyOrigin(String url) {
        applyOrigin(url, false);
    }

    /**
     * applyOrigin 的持久化语义扩展（A2，审计 §1）。显式切服（面板选线路/离线服务/自定义线路）
     * 持久化具体地址；而「失败兜底切换」（主帧加载失败 → ensureHostAndSwitch → 本地服务）只把
     * prefs 写成 {@code "auto"}——本地端口是 OS 随机分配的临时目标，若把 127.0.0.1:PORT 固化，
     * 下次冷启动会带着死端口直连失败。写 "auto" 让下次冷启动重新走线路探测（探测失败再落到
     * 默认远端线路），与用户选「自动线路」后的行为一致。
     *
     * @param url      切换目标
     * @param fallback true = 本次切换由失败兜底触发（onReceivedError ③ / setServer("local") 用户
     *                 显式点击不算——显式选择的行为不因实现细节改变）
     */
    private void applyOrigin(String url, boolean fallback) {
        // A2：失败兜底切换 → 冷启动恢复自动线路；显式切服 → 持久化具体地址。
        autoPersist = fallback;
        onlineMode = false;
        dcConfig = null;
        loadBase(url);
    }

    /**
     * 路径保真的导航入口（审计 §3）：裸 origin（path 为空）补 "/" 请求站点根；已带路径的 base
     * <b>原样加载</b>，绝不产生 {@code /play/} 这类站点自带 404 的地址。刷新 origin/host 并持久化
     * origin（持久化值去掉临时 room 参数，保持既有语义；A2：失败兜底切换持久化 "auto" 而非具体
     * 地址，见 {@link #applyOrigin(String, boolean)}）。
     * <p>不重置 onlineMode/dcConfig——各调用点语义不同（applyOrigin 全量重置、joinOnOrigin 显式清零），
     * 只重置 pageServedFromLocalTree（每次导航都应由拦截器重新判定）。
     */
    private void loadBase(String base) {
        if (base == null || base.isEmpty() || web == null) return;
        String baseOnly = stripRoom(base);      // room 是临时导航态，不写进 origin/持久化
        origin = baseOnly;
        originHost = hostOf(baseOnly);
        // A2（审计 §1）：autoPersist 置位 = 本次切换由失败兜底触发，持久化写 "auto"（下次冷启动
        // 重新走线路探测），只消费一次；显式切服则持久化去掉 room 的具体地址（既有语义）。
        prefs.edit().putString("origin", autoPersist ? "auto" : baseOnly).apply();
        autoPersist = false;
        pageServedFromLocalTree = false; // reset per navigation; the interceptor re-arms it
        historyClearPending = true;      // 切服后清一次历史（返回键一次回首页，见字段注释）
        // 服务器配置（§15）：换服务器 = 换配置槽。丢旧快照 → 读该服务器的 last-good → 后台刷新。
        syncServerConfigFor(baseOnly);
        web.loadUrl(normalizeBase(base));
    }

    /** 裸 origin（无路径）补 "/"；已带路径原样返回（仅规范化，不改 query/fragment）。 */
    private static String normalizeBase(String base) {
        if (base == null || base.isEmpty()) return base;
        Uri u = Uri.parse(base);
        String path = u.getPath();
        if (path != null && !path.isEmpty()) return base;
        return u.buildUpon().path("/").build().toString();
    }

    /** 去掉 room 查询参数（房间码只影响一次导航，不属于服务器身份）。 */
    private static String stripRoom(String base) {
        if (base == null || base.isEmpty()) return base;
        Uri u = Uri.parse(base);
        if (!u.getQueryParameterNames().contains("room")) return base;
        Uri.Builder b = u.buildUpon().query(null);
        appendQueryExceptRoom(u, b);
        return b.build().toString();
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
        // 「重启房主服务」单独成项：热重载只 reload 页面，内嵌 node 仍跑旧服务端代码；需要让新的
        // 服务端代码生效时由此显式重启（restartHostService 保留）。
        String[] baseItems = {"邀请码加入（跨服查找）", "服务器（切换线路）", "参数（房主配置）", "检查更新", "重启房主服务", "停止房主服务"};
        // 原生退出口（业主口径 2026-10-08）：默认「服务端界面」时页面来自该服自有客户端，拦截器
        // 直接放行到网络 → 服务器页面里**没有** SHELL_INJECT，页内面板/设置都点不到，唯一能回来的
        // 路就是这里。只在「当前 host 现在确实生效服务端界面」时出现（不是的话不打扰用户）；
        // 这也是页面能力门（shell.remoteClientCurrent 的存在）承诺的那条退路。
        boolean remoteNow = originHost != null && remoteClientFor(originHost);
        String escapeLabel = "回到本地客户端";
        String[] items = baseItems;
        if (remoteNow) {
            items = java.util.Arrays.copyOf(baseItems, baseItems.length + 1);
            items[baseItems.length] = escapeLabel;
        }
        String sourceLabel = remoteNow ? "服务端自带界面（该服自有客户端）" : "本地客户端（内嵌页面）";
        final boolean escapeShown = remoteNow;
        new AlertDialog.Builder(this)
                .setTitle("卫戍协议壳")
                .setMessage("当前线路：" + currentLineLabel() + "\n界面来源：" + sourceLabel
                        + "\n" + contentLabel + "\n" + hostLabel)
                .setItems(items, (d, which) -> {
                    if (which == 0) openPanelJs("join");
                    else if (which == 1) openPanelJs("servers");
                    else if (which == 2) openPanelJs("params");
                    else if (which == 3) checkForUpdate();
                    else if (which == 4) restartHostService();
                    else if (which == 5) stopService(new Intent(this, HostService.class));
                    else if (escapeShown && which == baseItems.length) returnToLocalClient();
                })
                .show();
    }

    /**
     * 「回到本地客户端」（原生退出口）：清掉当前 host 的服务端界面标志，再就地重载回内嵌树。
     * <p>写的是**显式 false**（{@link #setRemoteClient}(host,false)），不是 remove —— 全局默认
     * 是 true，remove 只会让 {@link #remoteClientFor} 立刻又判成 true（用户逃不出去）；显式 false
     * 永远赢过全局默认，所以这个选择对该 host 是粘性的。
     * <p>重载用 {@code web.reload()} 而不是 {@code applyOrigin(origin)}：reload 保留用户当前所在的
     * URL/路径，只是把文档来源从服务器换成内嵌树（拦截器对「当前 origin」的任何请求都先查本地树，
     * 主帧 miss 还有 index.html 兜底）—— 与页面开关的「关」方向（ShellBridge.useRemoteClient）
     * 逐字同一语义，不产生额外的线路切换/历史清理。
     */
    private void returnToLocalClient() {
        String h = originHost;
        if (h == null || !remoteClientFor(h)) return;
        setRemoteClient(h, false);
        toast("已回到本地客户端（内嵌界面）");
        if (web != null) web.reload();
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
        // 传输档位顺序在进入后台线程前取好（SharedPreferences 读取，主线程廉价）；显式档优先，
        // 其余按 auto 顺序补全，见 Transport。
        final String[] order = Transport.order(this);
        new Thread(() -> {
            // 审计 PR#23（高）：必须遍历**所有**目录再决定 —— 旧实现「首个下发 addresses 对象的目录
            // 即用」，遇到该目录只发了空/失效地址时就停住了，后面目录里可用的地址永远看不到。
            // 现在把各目录的地址按档位合并（先到的目录优先），并记录最终提供地址的目录。
            String usedDir = null;
            final java.util.Map<String, String> byKey = new java.util.HashMap<>();
            for (String dir : dirs) {
                try {
                    JSONObject r = getJson(dir + "/rooms/" + code, 4000);
                    JSONObject a = r.optJSONObject("addresses");
                    if (a == null) continue;
                    boolean took = false;
                    java.util.Iterator<String> keys = a.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        String addr = a.optString(key, "");
                        if (addr.isEmpty() || byKey.containsKey(key)) continue;
                        byKey.put(key, addr); // dc 档没有 TCP 地址，不会出现在这里
                        took = true;
                    }
                    if (took) usedDir = dir;
                } catch (Exception ignored) {
                    // try the next directory
                }
            }
            // 审计 PR#23（高）：用户显式选「优先打洞」时，dc 在 order 里排首位却永远被跳过
            // （目录里没有 dc 的 TCP 地址），于是又走了直连。显式首选 dc = 直接走打洞，不做 TCP 探测。
            final boolean dcFirst = order.length > 0 && Transport.DC.equals(order[0]);
            // 并行探测：每档一个线程，总耗时 ≈ 单档超时（2.5s），而不是旧实现的串行 7.5s。
            // 结果必须用 AtomicBoolean：join(3000) 超时返回时线程仍在跑，裸 boolean[] 的写入与
            // join 后的读取之间没有 happens-before，探测成功却被读到旧值会让可用档误判为不可达。
            final Thread[] workers = new Thread[order.length];
            final java.util.concurrent.atomic.AtomicBoolean[] ok =
                    new java.util.concurrent.atomic.AtomicBoolean[order.length];
            for (int i = 0; i < order.length; i++) ok[i] = new java.util.concurrent.atomic.AtomicBoolean(false);
            if (!dcFirst) {
                for (int i = 0; i < order.length; i++) {
                    final int idx = i;
                    final String addr = byKey.get(order[i]);
                    if (addr == null) continue;
                    workers[idx] = new Thread(() -> ok[idx].set(healthzOk(addr + "/healthz")), "shell-join-probe");
                }
                for (Thread t : workers) if (t != null) t.start();
                for (Thread t : workers) if (t != null) {
                    try { t.join(3000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                }
            }
            // 按 Transport.order 取第一个探测成功的档（dcFirst 时必然为空 → 走打洞）
            String probed = null;
            String probedKey = null;
            for (int i = 0; i < order.length; i++) {
                if (ok[i].get()) { probedKey = order[i]; probed = byKey.get(order[i]); break; }
            }
            // 全部失败时，firstAddr = 按同一顺序的第一个非空地址
            String firstAddr = null;
            for (int i = 0; i < order.length; i++) {
                String a = byKey.get(order[i]);
                if (a != null) { firstAddr = a; break; }
            }
            final String addr = probed != null ? probed : firstAddr;
            final boolean useDc = dcFirst || (probed == null && addr != null); // dcFirst 强制走打洞
            final String dirUsed = usedDir;
            final String label = probedKey == null ? null : transportLabel(probedKey);
            main.post(() -> {
                if (isFinishing()) return;
                if (addr == null) {
                    toast("没有找到房间 " + code + "（可能已过期）");
                    return;
                }
                // A1（审计 §1）：目录下发的房主地址是「临时加入目标」——只更新内存 origin/host
                // 供本次导航使用，绝不持久化（持久化会无条件覆盖用户已选线路，返回后冷启动也被
                // 固定到已失效的房间地址）。只有用户在面板显式切服（applyOrigin → loadBase 持久化）
                // 或选「自动线路」才落盘。
                origin = addr;
                originHost = hostOf(origin);
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
                    toast("已直连房主（" + label + "）： " + addr);
                }
                // B（审计 §1）：先记下 dcConfig 的基准 host——返回落地页（host 已变）时由
                // onPageFinished / onBackPressed 清除，避免返回后向无关页面复读打洞注入。
                if (dcConfig != null) dcOriginHost = hostOf(origin);
                historyClearPending = true; // 加入导航也是顶层导航：落地后清一次历史
                web.loadUrl(withRoom(origin, code));
            });
        }, "shell-join").start();
    }

    /** 传输档位的中文名（直连 toast 展示；dc 不会走到直连 toast，但一并给出以免遗漏）。 */
    private static String transportLabel(String key) {
        if (Transport.LAN.equals(key)) return "局域网";
        if (Transport.ZT.equals(key)) return "虚拟网";
        if (Transport.V6.equals(key)) return "IPv6";
        if (Transport.DC.equals(key)) return "打洞";
        return key == null ? "" : key;
    }


    // ------------------------------------------------------------------
    // Hot update (upstream release → filesDir/webroot)
    // ------------------------------------------------------------------

    /** 手动检查更新：内容有更新就直接下载安装（无二次确认）；内容最新时再比壳版本。 */
    private void checkForUpdate() {
        toast("正在检查更新…");
        appendDiagLog("manual-update", "begin");
        // 与静默更新互斥（审计 §4）：先请求取消可能正在跑的更新，interrupt/join 等它退出，
        // 再起自己的检查线程，避免两个 hotUpdate 抢同一个 webroot.staging / update-slim.zip。
        manualChecking = true;
        Updater.cancelRequested = true;
        Thread prev = updateThread;
        if (prev != null && prev.isAlive() && prev != Thread.currentThread()) {
            prev.interrupt();
            try {
                prev.join(1500);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        Thread t = new Thread(() -> {
            try {
                Updater.Manifest m = Updater.fetchManifest(this);
                if (m != null) manifestArtVersion = m.artVersion; // 素材轴水位（解析清单即刷新）
                Updater.ApkInfo apk = Updater.fetchApkLatest(); // shell axis: apk/latest.json
                main.post(() -> {
                    if (isFinishing()) return;
                    if (m == null || !m.usable()) {
                        toast("检查失败：清单不可用（可稍后重试）");
                        return;
                    }
                    if (Updater.requiresNewApk(m)) {
                        GameDialog dlg = new GameDialog("需要新版应用");
                        dlg.text("最新内容要求更高的应用版本（需要 " + m.minApk + "，当前 "
                                + BuildConfig.VERSION_CODE + "）。\n\n请下载安装新版 APK。");
                        dlg.button("前往下载", true, this::openApkPage);
                        dlg.button("以后再说", false, null);
                        dlg.show();
                        return;
                    }
                    boolean shellNew = apk != null && apk.newerThanInstalled();
                    if (Updater.needsUpdate(this, m)) {
                        // 有新内容 → 直接更新；壳同时有新版时由完成弹窗顺带提示（不叠第三个弹窗）
                        runUpdate(m, shellNew ? apk : null);
                        return;
                    }
                    if (shellNew) {
                        // 非必须不弹：记入 pendingApk 供结果弹窗复用，只给一条轻量提示
                        showNewApkDialog(apk);
                        toast("内容已是最新；检测到新版本应用 v" + apkName(apk) + "，可在下载页更新");
                    } else {
                        toast("已是最新：" + m.buildTag);
                    }
                });
            } finally {
                manualChecking = false;
                Updater.cancelRequested = false;
            }
        }, "shell-update-check");
        updateThread = t;
        t.start();
    }

    /** 内容已最新、但壳（APK）有新版本：非必须不弹，记入 pendingApk 供结果弹窗复用。 */
    private void showNewApkDialog(Updater.ApkInfo apk) {
        if (apk != null) pendingApk = apk;
    }

    private void openApkPage() {
        // v5.3.3: 已知目标 tag 时直接走下载站的加速路由（302 → CDN/加速器，国内可达）；
        // 没有 tag（纯浏览）才落下载站首页。
        Updater.ApkInfo shell = pendingApk;
        String url = (shell != null && shell.tag != null && !shell.tag.isEmpty())
                ? Updater.apkDownloadUrl(shell.tag)
                : Updater.APK_PAGE;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            toast("请在浏览器打开：" + url);
        }
    }

    // ------------------------------------------------------------------
    // Game-styled dialogs (built in code — no new xml resources)
    // ------------------------------------------------------------------

    private static final String UI_DIALOG_BG = "#0C0F0E";     // card fill (matches the boot screen)
    private static final String UI_DIALOG_BORDER = "#2C3A35"; // 1px border / progress track
    private static final String UI_MINT = "#4ED8AF";          // title / primary action
    private static final String UI_TEXT = "#D8E3DE";          // body
    private static final String UI_MUTED = "#8A9A93";         // stage / secondary text

    /** Rounded rect used for the card background and the progress track/fill. */
    private GradientDrawable rounded(String color, int radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(Color.parseColor(color));
        d.setCornerRadius(dp(radiusDp));
        return d;
    }

    /**
     * Minimal game-style dialog: flat dark card (#0C0F0E) with a 1px #2C3A35 border, mint title
     * (#4ED8AF), body #D8E3DE, secondary text #8A9A93, mint/gray text buttons and a mint
     * horizontal progress bar. show() is finishing-safe and dismiss() never throws.
     */
    private final class GameDialog {
        private final Dialog dialog;
        private final LinearLayout content;
        private final LinearLayout actions;
        private TextView stageView;
        private TextView percentView;
        private ProgressBar bar;
        private boolean closed = false;

        GameDialog(String title) {
            dialog = new Dialog(MainActivity.this);
            LinearLayout root = new LinearLayout(MainActivity.this);
            root.setOrientation(LinearLayout.VERTICAL);
            int pad = dp(20);
            root.setPadding(pad, dp(18), pad, dp(10));
            GradientDrawable bg = rounded(UI_DIALOG_BG, 14);
            bg.setStroke(dp(1), Color.parseColor(UI_DIALOG_BORDER));
            root.setBackground(bg);

            TextView titleView = new TextView(MainActivity.this);
            titleView.setText(title);
            titleView.setTextColor(Color.parseColor(UI_MINT));
            titleView.setTextSize(16);
            titleView.setTypeface(Typeface.DEFAULT_BOLD);
            root.addView(titleView);

            content = new LinearLayout(MainActivity.this);
            content.setOrientation(LinearLayout.VERTICAL);
            root.addView(content);

            actions = new LinearLayout(MainActivity.this);
            actions.setOrientation(LinearLayout.HORIZONTAL);
            actions.setGravity(Gravity.END);
            LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            alp.topMargin = dp(6);
            root.addView(actions, alp);

            dialog.setContentView(root);
            Window w = dialog.getWindow();
            if (w != null) w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            dialog.setCanceledOnTouchOutside(false);
        }

        /** Body paragraph (#D8E3DE). */
        GameDialog text(String s) {
            TextView tv = new TextView(MainActivity.this);
            tv.setText(s);
            tv.setTextColor(Color.parseColor(UI_TEXT));
            tv.setTextSize(13.5f);
            tv.setLineSpacing(dp(3), 1f);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lp.topMargin = dp(12);
            content.addView(tv, lp);
            return this;
        }

        /** Stage line + mint progress bar + percent/detail line. */
        GameDialog progress() {
            stageView = new TextView(MainActivity.this);
            stageView.setTextColor(Color.parseColor(UI_TEXT));
            stageView.setTextSize(13.5f);
            LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            slp.topMargin = dp(14);
            content.addView(stageView, slp);

            bar = new ProgressBar(MainActivity.this, null, android.R.attr.progressBarStyleHorizontal);
            bar.setMax(1000);
            LayerDrawable ld = new LayerDrawable(new Drawable[] {
                    rounded(UI_DIALOG_BORDER, 4),
                    new ClipDrawable(rounded(UI_MINT, 4), Gravity.START, ClipDrawable.HORIZONTAL) });
            ld.setId(0, android.R.id.background);
            ld.setId(1, android.R.id.progress);
            bar.setProgressDrawable(ld);
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, dp(8));
            blp.topMargin = dp(10);
            content.addView(bar, blp);

            percentView = new TextView(MainActivity.this);
            percentView.setTextColor(Color.parseColor(UI_MUTED));
            percentView.setTextSize(12);
            LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            plp.topMargin = dp(6);
            content.addView(percentView, plp);
            return this;
        }

        void setStage(String s) {
            if (!closed && stageView != null) stageView.setText(s);
        }

        void setProgress(long bytes, long total) {
            if (closed || bar == null) return;
            long pct = total > 0 ? Math.min(100, bytes * 100 / total) : 0;
            bar.setProgress((int) (pct * 10));
            if (percentView != null) {
                String mb = (bytes / 1024 / 1024) + " MB"
                        + (total > 0 ? " / " + (total / 1024 / 1024) + " MB" : "");
                percentView.setText(total > 0 ? pct + "% · " + mb : mb);
            }
        }

        /** Text button; `primary` = mint (#4ED8AF), otherwise gray (#8A9A93). */
        GameDialog button(String label, boolean primary, Runnable action) {
            TextView b = new TextView(MainActivity.this);
            b.setText(label);
            b.setTextSize(15);
            b.setTextColor(Color.parseColor(primary ? UI_MINT : UI_MUTED));
            b.setPadding(dp(14), dp(10), dp(14), dp(10));
            b.setGravity(Gravity.CENTER);
            b.setOnClickListener(v -> {
                dismiss();
                if (action != null) action.run();
            });
            actions.addView(b);
            return this;
        }

        GameDialog cancelable(boolean c) {
            dialog.setCancelable(c);
            return this;
        }

        void show() {
            if (isFinishing()) return;
            try {
                dialog.show();
                Window w = dialog.getWindow();
                if (w != null) {
                    w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
                    int width = Math.min(
                            getResources().getDisplayMetrics().widthPixels - dp(48), dp(340));
                    w.setLayout(width, WindowManager.LayoutParams.WRAP_CONTENT);
                }
            } catch (Exception ignored) {
                // window already gone (activity finishing) — the update itself is unaffected
            }
        }

        void dismiss() {
            closed = true;
            try {
                if (dialog.isShowing()) dialog.dismiss();
            } catch (Exception ignored) {
                // never let a torn-down window kill an update callback
            }
        }
    }

    /** Session-scoped guard: one automatic check per cold start, never nag in a loop. */
    private boolean autoUpdateChecked = false;

    /** 当前更新线程（静默或手动检查），手动检查前 interrupt/join 它以取得互斥（审计 §4）。 */
    private volatile Thread updateThread;
    /** 手动检查窗口：静默更新见此为 true 直接让路，不与其抢 webroot.staging。 */
    private volatile boolean manualChecking = false;
    /** 静默发现的壳新版本：不弹窗，仅在热更新结果弹窗里以一行备注呈现（已存在则复用）。 */
    private volatile Updater.ApkInfo pendingApk;
    /** minApk 硬门禁等拿不到 ApkInfo 时的一行备注文案。 */
    private volatile String pendingApkNote;

    /**
     * 素材热更（P0）：最近一次验签清单的 art.version（0 = 素材通道未启用）。每次解析清单（静默/手动/
     * 桥接）都刷新它；只有 > 0 时 CDN 素材缺失才会走「占位 + 后台 artSync」这条新行为，
     * 否则拦截器保持旧的 return null（老清单/老壳行为逐字不变）。
     */
    private volatile int manifestArtVersion = 0;
    /** 后台 artSync 单飞：一次只允许一个在跑（ArtStore.sync 内部还有一层互斥兜底）。 */
    private final java.util.concurrent.atomic.AtomicBoolean artSyncRunning =
            new java.util.concurrent.atomic.AtomicBoolean(false);

    /** 壳新版本的可读名字（versionName → tag → versionCode）。 */
    private static String apkName(Updater.ApkInfo apk) {
        if (apk == null) return "";
        return !apk.versionName.isEmpty() ? apk.versionName
                : (!apk.tag.isEmpty() ? apk.tag : String.valueOf(apk.versionCode));
    }

    /**
     * 默认进游戏就下载补丁类更新：启动后静默检查一次，发现新 buildTag 直接后台下载安装，
     * 完成后只弹「点按重载」——不打断对局，不阻塞启动；minApk 不够时只提示一次。
     * 任何失败都保持静默（旧树原样保留，diag.log 有记录）。
     */
    private void autoCheckForUpdate() {
        if (autoUpdateChecked || isFinishing() || manualChecking) return; // 手动检查已接管则让路
        autoUpdateChecked = true;
        appendDiagLog("auto-update", "begin");
        Thread t = new Thread(() -> {
            try {
                Updater.Manifest m = Updater.fetchManifest(this);
                if (m != null) manifestArtVersion = m.artVersion; // 素材轴水位（解析清单即刷新）
                if (m == null || !m.usable() || isFinishing()) return; // offline/broken → stay quiet
                if (manualChecking) return; // 手动检查已接管
                Updater.ApkInfo apk = Updater.fetchApkLatest();
                if (Updater.requiresNewApk(m)) {
                    // minApk 硬门禁：非必须不弹，只记录，等热更新结果/手动检查时再说明。
                    if (apk != null && apk.newerThanInstalled()) pendingApk = apk;
                    pendingApkNote = "最新内容 " + m.buildTag + " 需要更高的应用版本（需要 "
                            + m.minApk + "，当前 " + BuildConfig.VERSION_CODE + "）";
                    appendDiagLog("auto-update", "requires-new-apk minApk=" + m.minApk);
                    return;
                }
                if (!Updater.needsUpdate(this, m)) {
                    // 内容已最新：壳有新版本只静默记录，不弹窗打断。
                    if (apk != null && apk.newerThanInstalled()) pendingApk = apk;
                    return;
                }
                final Updater.ApkInfo shellNew = apk != null && apk.newerThanInstalled() ? apk : null;
                // background download + install; the switch is atomic and rollback-protected.
                // NOOP sink, and hotUpdate itself null-guards: a null Progress must never NPE
                // (v2.8.1 field crash — a NullPointerException written to crash.log on every launch).
                try {
                    Updater.hotUpdate(this, m, Updater.NOOP);
                } catch (Throwable t2) {
                    if (Updater.cancelRequested) appendDiagLog("auto-update", "cancelled");
                    else if (String.valueOf(t2.getMessage()).contains("已有更新进行中"))
                        appendDiagLog("update", "skipped: in-flight");
                    else appendDiagLog("auto-update", String.valueOf(t2));
                    return; // silent failure, old tree intact
                }
                // 素材轴（P0）：**热补丁落地后不重校验素材**（业主口径 2026-10-08，最高优先级）：
                // 热更只换 L1 代码/叠加层，素材字节没变就不该被重新校验/重新下载 —— 以前这里强制跑
                // 一次整轴 artSync（拉验签清单 + 每个未装包重新下载 + sha256），在「包一直装不上」的
                // 设备上等于每次热更后都全量重验一遍，用户看到的就是「开屏强制校验、素材还是不显示」。
                // 素材轴现在只有两条入口：①页面真的缺图（拦截器 art-miss，限流 5 分钟一次）；
                // ②用户在壳面板显式触发 syncArt。两者都在**写入时**校验（装包/落盘那一刻）。
                main.post(() -> {
                    if (isFinishing()) return;
                    GameDialog dlg = new GameDialog("内容已更新");
                    StringBuilder msg = new StringBuilder("已静默更新到 " + m.buildTag
                            + "。\n\n立即重载生效（对局中建议稍后，下次启动也会生效）。");
                    Updater.ApkInfo note = shellNew != null ? shellNew : pendingApk;
                    if (note != null) {
                        pendingApk = note; // 复用/更新待提示的壳版本信息
                        msg.append("\n\n备注：检测到新版本应用 v").append(apkName(note))
                                .append("（当前 v").append(BuildConfig.VERSION_NAME)
                                .append("），可稍后下载安装。");
                    } else if (pendingApkNote != null) {
                        msg.append("\n\n备注：").append(pendingApkNote);
                    }
                    dlg.text(msg.toString());
                    // 热重载只 reload 页面：内嵌 node 服务端代码若也更新，需用户从壳菜单显式
                    // 「重启房主服务」（见 showShellMenu），避免每次内容更新都重启 Node 打断房主。
                    dlg.button("立即重载", true, () -> web.reload());
                    if (note != null) dlg.button("前往下载", false, this::openApkPage); // 次按钮
                    dlg.button("稍后", false, null);
                    dlg.show();
                });
            } finally {
                if (updateThread == Thread.currentThread()) updateThread = null;
            }
        }, "shell-auto-update");
        updateThread = t;
        t.start();
    }

    private GameDialog updatingDialog;

    /** 手动更新：游戏风格进度弹窗；shellNew 非空时，完成弹窗顺带提示壳更新（不叠加弹窗）。 */
    private void runUpdate(Updater.Manifest manifest, Updater.ApkInfo shellNew) {
        if (isFinishing()) return;
        final GameDialog dlg = new GameDialog("内容更新");
        dlg.text("目标 " + manifest.buildTag + " · 失败自动回滚");
        dlg.progress();
        dlg.setStage("连接中…");
        dlg.cancelable(false);
        dlg.show();
        updatingDialog = dlg;

        new Thread(() -> {
            try {
                Updater.hotUpdate(this, manifest, new Updater.Progress() {
                    @Override
                    public void onStage(String s) {
                        main.post(() -> dlg.setStage(s));
                    }

                    @Override
                    public void onProgress(long bytes, long total) {
                        main.post(() -> dlg.setProgress(bytes, total));
                    }
                });
                // 素材轴同样不在这里触发：热补丁 ≠ 素材变化（见 autoCheckForUpdate 处的口径说明）
                main.post(() -> {
                    dismissUpdating();
                    if (isFinishing()) return;
                    Updater.ApkInfo shell = shellNew != null ? shellNew : pendingApk; // 复用静默期记录
                    GameDialog done = new GameDialog("更新完成");
                    String msg = "内容已更新到 " + manifest.buildTag + "。";
                    if (shell != null) {
                        pendingApk = shell;
                        msg += "\n\n同时检测到新版本应用 v" + apkName(shell) + "（当前 v"
                                + BuildConfig.VERSION_NAME + "），建议下载安装。";
                    }
                    done.text(msg);
                    if (shell != null) done.button("前往下载", true, this::openApkPage);
                    // 热重载只 reload 页面（原因见 autoCheckForUpdate 处注释）：内嵌 node 仍跑旧
                    // 服务端代码时，由用户在壳菜单「重启房主服务」显式重启。
                    done.button("热重载", shell == null, () -> web.reload());
                    done.button("稍后", false, null);
                    done.show();
                });
            } catch (Throwable t) { // the manual path has a dialog; still never let it kill the process
                if (String.valueOf(t.getMessage()).contains("已有更新进行中"))
                    appendDiagLog("update", "skipped: in-flight");
                main.post(() -> {
                    dismissUpdating();
                    if (isFinishing()) return;
                    GameDialog fail = new GameDialog("更新失败");
                    fail.text("已保留当前版本。\n\n" + t.getMessage()
                            + "\n\n可前往下载站安装最新 APK。");
                    fail.button("前往下载", true, this::openApkPage);
                    fail.button("关闭", false, null);
                    fail.show();
                });
            }
        }, "shell-update-run").start();
    }

    private void dismissUpdating() {
        if (updatingDialog != null) updatingDialog.dismiss();
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
        v.setWebChromeClient(new ShellChromeClient());
        v.addJavascriptInterface(new ShellBridge(), "shell");
        // player data vault (v2.7.7): origin-independent file store behind window.spData
        v.addJavascriptInterface(new PlayerBridge(this), "spData");
        return v;
    }

    /**
     * WebChromeClient 的唯一职责：HTML5 全屏。页面的全屏按钮（title 屏 .title-fs / 对局 HUD，
     * 见 public/js/ui/device.js fullscreen.enter）走 document.documentElement.requestFullscreen()；
     * WebView 只有看到 onShowCustomView/onHideCustomView 被覆写，才把这请求当作「支持全屏」并
     * 把渲染出的自定义 View 递过来——裸 new WebChromeClient() 时页面的按钮是静默 no-op。
     * 回调都在主线程（与 onBackPressed/onDestroy 同一线程），View 操作无需再 post。
     */
    private class ShellChromeClient extends WebChromeClient {
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            // 已在全屏：拒绝后来者（onCustomViewHidden 是「宿主不收这个 View」的答复，见官方文档），
            // 绝不叠第二个容器——先来的 View 一旦失去唯一引用，既没人 remove 也没人回调，黑屏关不掉。
            if (fullscreenView != null) {
                callback.onCustomViewHidden();
                return;
            }
            ViewGroup content = findViewById(android.R.id.content);
            if (content == null) { // 壳的根容器不存在（理论不可达）：拒绝，不留半全屏状态
                callback.onCustomViewHidden();
                return;
            }
            // WebView 递过来的 View 可能还挂在它自己的父容器上；先摘再 addView，否则直接抛
            // IllegalStateException: The specified child already has a parent。
            if (view.getParent() instanceof ViewGroup) {
                ((ViewGroup) view.getParent()).removeView(view);
            }
            if (fullscreenContainer == null) {
                fullscreenContainer = new FrameLayout(MainActivity.this);
                fullscreenContainer.setBackgroundColor(Color.BLACK); // 黑底：露出非页面区域时不出白板
            }
            if (fullscreenContainer.getParent() instanceof ViewGroup) { // 容器复用：先脱离旧父
                ((ViewGroup) fullscreenContainer.getParent()).removeView(fullscreenContainer);
            }
            // 进入前记下 decor 的 system UI flags（退出时恢复用；30+ 见 exitFullscreen 注释）
            preFullscreenUiVisibility = getWindow().getDecorView().getSystemUiVisibility();
            fullscreenView = view;
            fullscreenCallback = callback;
            content.addView(fullscreenContainer, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
            fullscreenContainer.addView(view, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
            // WebView 只是藏起来（不销毁）：退出全屏要回到同一现场（DOM / 会话 / 滚动位置原样）。
            if (web != null) web.setVisibility(View.GONE);
            enterFullscreenImmersive(); // 全屏期间保持沉浸（sticky），形态与 applyImmersive() 一致
        }

        @Override
        public void onHideCustomView() {
            // 页面自己退出全屏（再点一次全屏按钮）：WebView 走到这里，宿主只做收尾。
            exitFullscreen();
        }
    }

    /**
     * 全屏收尾：摘走自定义 View 与容器、恢复 WebView 与 system UI。幂等（不在全屏时 no-op）——
     * BACK、onHideCustomView、onDestroy 三条路径都可能重复抵达。只在主线程调用。
     */
    private void exitFullscreen() {
        View view = fullscreenView;
        if (view == null) return;
        fullscreenView = null;
        fullscreenCallback = null;
        if (fullscreenContainer != null) {
            fullscreenContainer.removeView(view); // 归还给 WebView，不给已脱离的 View 留悬挂引用
            if (fullscreenContainer.getParent() instanceof ViewGroup) {
                ((ViewGroup) fullscreenContainer.getParent()).removeView(fullscreenContainer);
            }
        }
        if (web != null) web.setVisibility(View.VISIBLE); // 回到同一个 WebView（它从未被销毁）
        // system UI 恢复：26–29 把进入前记下的 flags 原样写回；30+ 的控制器状态没有 getter
        //（applyImmersive 的注释解释过为什么不上 androidx），按应用常态重新断言——applyImmersive
        // 幂等，且不会改动它在全屏外维护的 edge-to-edge / cutout 形态。
        if (Build.VERSION.SDK_INT >= 30) {
            applyImmersive();
        } else {
            getWindow().getDecorView().setSystemUiVisibility(preFullscreenUiVisibility);
        }
    }

    /**
     * BACK 退全屏：先用 WebView 给的回调通知页面/引擎退出（callback.onCustomViewHidden() 是官方
     * 文档约定的「宿主主动退全屏」通道——页面据此翻回全屏按钮状态，WebView 随后回调
     * onHideCustomView），再当场收尾一次：回调派发要等引擎一轮，BACK 必须立即见效，不能把用户
     * 留在黑屏里（重复抵达由 exitFullscreen 的幂等兜住）。
     */
    private void exitFullscreenFromBack() {
        WebChromeClient.CustomViewCallback cb = fullscreenCallback;
        if (cb != null) {
            try {
                cb.onCustomViewHidden();
            } catch (Throwable ignored) {
                // 引擎侧已自行退全屏时这条通道可能已失效；下面的收尾必须照跑，BACK 不能崩、不能困住用户
            }
        }
        exitFullscreen();
    }

    private class ShellClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.ROOT);
            String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) return null;

            // 字体来源（业主口径 2026-10-09：「本地服务走本地，走服务器上走服务器，cdn 仅作为本地下载源」；
            // 同日追加「**第三方 CDN 接受**」）：
            //   页面来自**本地树**（本地服务 / 本地客户端 / 本地渲染的首页）→ 由**本地自托管字体表**回答，
            //   运行时一个字节都不取 CDN；页面来自**服务器** → **放行**（该服页面自己引的字体与 CDN 正常
            //   加载，不再替对方决定）。上游 index.html 的那两条 <link> 是上游文件，我们不改。
            if (FONT_CSS_HOST.equals(host) || FONT_FILE_HOST.equals(host)) {
                if (!RemoteClientPolicy.fontFromLocalTable(pageServedFromLocalTree)) return null; // 服务器页面：放行
                if (FONT_CSS_HOST.equals(host)) {
                    // 表里的 src 是 `url('/fonts/…')`。**CSS 里的相对地址是按样式表自身的 URL 解析的**，
                    // 而这份表是从 fonts.googleapis.com 的 URL 上回来的 → 浏览器会去取
                    // `https://fonts.googleapis.com/fonts/x.woff2`。所以该 host 上的同路径要映射回本地树
                    // （别名的落点；真字节永远来自设备，一个字节都不出网）。
                    String fontPath = url.getPath();
                    if (fontPath != null && fontPath.startsWith("/fonts/")) {
                        InputStream f = openLocal(fontPath);
                        if (f != null) return respond(mimeFor(fontPath), null, f);
                    }
                    InputStream css = openLocal(LOCAL_FONT_CSS);
                    if (css != null) return respond("text/css", "utf-8", css);
                }
                // 字体文件主机（gstatic）在本地页面下回空表：本地表的 src 经上面的别名就地解决，走不到这里。
                return emptyCss();
            }

            String rawPath = url.getPath();
            // Shell-owned bridge scripts are ALWAYS served from the APK (never from a server), so a
            // third-party page cannot shadow the CORS guard or the DataChannel adapter (P0-2).
            if (rawPath != null && rawPath.startsWith(SHELL_JS_PREFIX)) {
                // 本地素材清单（tree/packs/APK 三层覆盖）：art-prefetch.js 用它把「本机已有、永远不会走
                // CDN」的条目直接计数跳过 —— 内嵌素材不可热更、无需校验、也无需预热（业主口径）。
                if (LOCAL_ART_LIST_PATH.equals(rawPath)) return localArtListResponse();
                return serveShellAsset(rawPath);
            }

            // H3（2026-10-08 现场报告）：后台预取带 X-SP-Prefetch 标记。标记请求永远给页面让路 ——
            // 它只拿独立的 2 个预取槽，并在页面忙时 300 ms 内放弃（页面请求则最多等 12 s 而不是
            // 6 s 后回占位）；没有这个标记（老叠加层/被剥离）就按普通页面请求处理，行为不变。
            boolean prefetch = ArtCdn.isPrefetchRequest(request.getRequestHeaders());

            // 协议端点（§14 E/F/G）：/api/**、/ws、/healthz **永远直连当前服务器**，本地树与任何缓存
            // 都不参与。今天这条路径靠「本地树里恰好没有同名文件」而成立——那是巧合不是保证：一旦
            // 内容包/服务器页面带来同名文件就会静默变成「假成功」。这里把它变成显式规则。
            if (ResourceResolver.isProtocolPath(rawPath)) return null;

            // CDN asset host: resolve the asset tree against the embedded files so APK clients stay
            // fully local even though the manifests point at the CDN; a miss falls through to the
            // network. Two URL shapes arrive here: the un-suffixed `/assets/` (upstream form) and
            // this line's `/assets-re/` (what build-webroot bakes into the manifests). Both come
            // from the SAME embedded directory `assets/`, so the namespaced one is mapped onto it.
            if (!onlineMode && isAssetCdnHost(host)) {
                String localAsset = null;
                if (rawPath != null) {
                    if (rawPath.startsWith("/assets/")) {
                        localAsset = rawPath;
                    } else if (rawPath.startsWith("/" + Line.ASSETS_DIR + "/")) {
                        localAsset = "/assets/" + rawPath.substring(Line.ASSETS_DIR.length() + 2);
                    }
                }
                if (localAsset != null) {
                    InputStream cdnIn = openLocal(localAsset);
                    if (cdnIn != null) return serveLocal(request, localAsset, cdnIn);
                    // no-embedded-assets 同源回源（owner 口径：本地优先、缺失才回源，不是硬性 local-only）：
                    // 缓存命中或从本线 CDN base 取回并落盘后，与本地命中一样同源返回（跨域贴图会 taint
                    // canvas）。取不回时才回落到素材热更链路：artVersion > 0 → 200 占位 + 单飞后台补包
                    // （绝不把 /assets/** 交给 WebView 跨域直取）；artVersion == 0（老清单/老壳）→ 保持
                    // 既有 return null 行为逐字不变。
                    InputStream fetched = openAssetFromCdn(localAsset, prefetch);
                    if (fetched != null) return serveLocal(request, localAsset, fetched);
                    if (manifestArtVersion > 0) {
                        appendDiagLog("art-miss", localAsset);
                        requestArtSync();
                        return artPlaceholder(localAsset);
                    }
                }
                return null;
            }
            if (onlineMode) return null;
            // A host the player chose to open with the server's OWN client (room-scoped Workers
            // deployments, whose /ws needs a room code our client never sends): skip the embedded
            // tree for it entirely and let every request go to that server.
            //
            // 服务端界面（业主口径 2026-10-09）：「连接服务器：**仅首页**页面叠加，其他 ui 按服务器
            // 正常显示，静态资源走 web 缓存；第三方 CDN 接受」。
            //
            // 三条规则，按「页面来源」而不是「路径」分：
            //   ① 首页主帧（站点根 / index.html）永远是我们 —— scopeAllows=false → 落到下面的本地树链，
            //      首页的叠加层、面板、跨服配置都在本地 index.html 上，冷启动第一屏永远不会是别人的首页。
            //      判定是纯函数（RemoteClientPolicy.scopeAllows / isHomePath），JVM 有测试。
            //   ② 首页之外的**主帧导航** → 该服自有页面：取回并注入外壳（钩子/面板/回首页口保留；注入失败
            //      就返回 null 交回 WebView 原生加载，fail-open），并把它标记成「服务器页面」。
            //   ③ **服务器页面**上的其余请求（js/css/data/art/字体…）一律放行 → 服务器自己取、WebView 按
            //      服务器自己的缓存头走 web 缓存（业主口径里的「静态资源走 web 缓存」）。
            //      我们自己的页面（本地树渲染的首页）**不**走这条 —— 否则首页会变成「我们的 HTML +
            //      服务器的 js」的半成品。
            boolean mainFrameHtml = request.isForMainFrame() && acceptsHtml(request);
            boolean knownServerHost = isKnownServerHost(host);
            boolean currentOrigin = originHost != null && originHost.equalsIgnoreCase(host);
            boolean serverUi = remoteClientFor(host);

            if (serverUi && knownServerHost && mainFrameHtml
                    && RemoteClientPolicy.scopeAllows(host, rawPath, true)) {
                pageServedFromLocalTree = false; // 这一页是服务器的 → 它的资源一律放行（规则 ③）
                return fetchAndInjectMainFrame(url.toString()); // null = 原生加载（fail-open）
            }
            if (serverUi && knownServerHost && currentOrigin && !pageServedFromLocalTree && !mainFrameHtml) {
                return null;                     // 服务器页面的静态资源 → 服务器 + web 缓存
            }

            // 本地树参与的条件：① 当前 origin 的任何请求（既有行为，静态资源保持全本地）；
            // ② 主帧 HTML 导航到已知服务器主机（即使不是当前 origin）。其余请求交给网络。
            if (!currentOrigin && !(mainFrameHtml && knownServerHost)) return null;
            if (!"GET".equalsIgnoreCase(request.getMethod())) return null;

            String path = normalizePath(rawPath);
            if (path == null) return null;
            if (path.endsWith("/")) path = path + "index.html";

            // 1) local tree first (filesDir → APK assets): a hit is served from the device, and HTML
            //    responses get the shell's bridge injection (P0-2)
            InputStream in = openLocal(path);
            if (in != null) return serveLocal(request, path, in);

            // 1b) no-embedded-assets 同源回源：/assets/** 在本地树（filesDir/webroot）与 APK、以及
            //     ArtStore 已装素材包（openLocal 第 2 层）里都没有时，从本线 CDN base 取回同一相对路径、
            //     落到 filesDir/art/cache/<manifest hash>/ 并**同源**返回（跨域图片会 taint canvas）。
            //     再失败才回落到素材热更链路（artVersion > 0 → 占位 + 后台补包），否则维持原有 404/网络行为。
            if (path.startsWith(ArtCdn.ASSET_PREFIX)) {
                // 服务器自己提供的素材（ServerConfig.resources.serveAssets，默认关）排在 CDN 之前：
                // 它是**同源**的（页面就来自这台服务器），所以既无跨域污染，又能让「服务器私有素材」
                // （官方 CDN 上根本没有的图）真正可用。服务器没声明时这一层整体不参与 —— 与今天逐字相同。
                InputStream srv = openAssetFromServer(path, prefetch);
                if (srv != null) return serveLocal(request, path, srv);
                InputStream cdn = openAssetFromCdn(path, prefetch);
                if (cdn != null) return serveLocal(request, path, cdn);
                if (manifestArtVersion > 0) {
                    appendDiagLog("art-miss", path);
                    requestArtSync();
                    return artPlaceholder(path);
                }
            }

            // 2) 主帧本地优先兜底：已知服务器主机的主帧 HTML 导航，本地树没有该路径时，返回本地
            //    index.html（复用 serveLocal，自动带上 SHELL_INJECT 注入与 dcConfig 注入）。
            //    协议端点 /healthz、/ws 与静态资源 /assets/** 不参与这条兜底。
            if (mainFrameHtml && knownServerHost
                    && !"/healthz".equals(path) && !"/ws".equals(path)
                    && !path.startsWith("/assets/")) {
                appendDiagLog("local-first", "main-frame miss -> index.html host=" + host + " path=" + path);
                InputStream idx = openLocal("/index.html");
                if (idx != null) return serveLocal(request, "/index.html", idx);
            }

            // 4) 主帧 HTML 来自服务器时，也要注入外壳（叠加层 + 钩子）：服务器页面里没有我们的
            //    script 标签，不注入就等于「首页叠加层 / 复制密钥钩子」在服务器页面上完全不存在。
            //    失败/非 200/非 HTML 一律返回 null，交回 WebView 原生加载（维持原行为）。
            if (mainFrameHtml && "GET".equalsIgnoreCase(request.getMethod())) {
                WebResourceResponse injected = fetchAndInjectMainFrame(url.toString());
                if (injected != null) return injected;
            }

            // 3) 其余（/healthz、/ws、/assets/**、本地树没有的第三方资源）交给网络
            return null;
        }

        /** 主帧导航判定：Accept 头含 text/html（WebView 的主帧导航恒带该值）。 */
        private boolean acceptsHtml(WebResourceRequest request) {
            Map<String, String> headers = request.getRequestHeaders();
            if (headers == null) return false;
            String accept = headers.get("Accept");
            if (accept == null) { // 头名大小写不定，回退遍历
                for (Map.Entry<String, String> e : headers.entrySet()) {
                    if (e.getKey() != null && "accept".equalsIgnoreCase(e.getKey())) {
                        accept = e.getValue();
                        break;
                    }
                }
            }
            return accept != null && accept.toLowerCase(Locale.ROOT).contains("text/html");
        }

        /**
         * Serves a local file. HTML gets the bridge injection; the two asset manifests are
         * de-CDN'd back to origin-relative paths so an APK never loads a cross-origin texture
         * (same-origin images can never taint a canvas — the SecurityError that killed the 3D board).
         */
        private WebResourceResponse serveLocal(WebResourceRequest request, String path, InputStream in) {
            String mime = mimeFor(path);
            boolean html = "text/html".equals(mime);
            if (request.isForMainFrame() && html) {
                pageServedFromLocalTree = true; // main frame came from the local tree
            }
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
                        text = text.replace(Line.ASSETS_CDN_PREFIX, "/assets/")
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

        /**
         * /__sp/&lt;name&gt; → 外壳自有脚本。**先 filesDir（热更树）再 APK**：注入到服务器页面上的外壳代码
         * 也必须能随热更更新，否则「首页叠加层 / 复制密钥钩子」在服务器页面上会永远停在装机那一版。
         * 仍然**绝不走网络** —— P0-2 的本意是「第三方页面不能顶掉外壳适配层」，不是「外壳不能热更」。
         */
        private WebResourceResponse serveShellAsset(String path) {
            String name = path.substring(SHELL_JS_PREFIX.length());
            if (name.isEmpty() || name.indexOf('/') >= 0 || name.contains("..")) return notFound();
            InputStream in = openLocal("/js/" + name);
            if (in == null) return notFound();
            return respond(mimeFor(name), "utf-8", in);
        }

        /**
         * 取回**来自服务器的主帧 HTML** 并注入外壳脚本（叠加层 + 钩子）。
         * <p>没有这一步，服务器页面里就一点我们的东西都没有：`window.shell` 桥是 Java 注入的、天然存在，
         * 但叠加层/钩子脚本全靠 `SHELL_INJECT`，而它此前只在本地命中（serveLocal）时才会执行。
         * <p>**任何不确定情形一律返回 null**，交回 WebView 原生加载（等于维持原行为）：
         * 只接受 200 + text/html；不跟随重定向（让 WebView 自己跟随，避免文档 URL 与 body 不符）；
         * body 上限 2 MB；已注入过的页面直接放行。
         */
        private WebResourceResponse fetchAndInjectMainFrame(String urlStr) {
            HttpURLConnection c = null;
            try {
                URL u = new URL(urlStr);
                String proto = u.getProtocol();
                if (!"http".equals(proto) && !"https".equals(proto)) return null;
                c = (HttpURLConnection) u.openConnection();
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(6000);
                c.setReadTimeout(6000);
                c.setRequestProperty("Accept", "text/html,application/xhtml+xml");
                String cookie = CookieManager.getInstance().getCookie(urlStr);
                if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
                int code = c.getResponseCode();
                if (code < 200 || code >= 300) return null; // 3xx/4xx/5xx 交给 WebView 自己处理
                String ct = c.getContentType();
                if (ct == null || !ct.toLowerCase(Locale.ROOT).contains("text/html")) return null;
                String body = readAllCapped(c.getInputStream(), 2 * 1024 * 1024);
                if (body == null || body.isEmpty()) return null;
                String injected = injectShellHtml(body);
                if (injected == null || injected.equals(body)) return null; // 已注入过 → 原生加载
                // 包装响应会丢掉服务器原本的头，`Set-Cookie` 必须在丢掉前转交给 CookieManager，
                // 否则主帧那次下发/续期的会话 cookie 会消失（登录态、房间票据都可能靠它）。
                for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
                    if (e.getKey() == null || !"set-cookie".equalsIgnoreCase(e.getKey())) continue;
                    for (String v : e.getValue()) {
                        try { CookieManager.getInstance().setCookie(urlStr, v); } catch (Exception ignored) { /* ignore */ }
                    }
                }
                Map<String, String> h = new HashMap<>();
                h.put("Cache-Control", "no-store");
                // 注意：这里**没有**回填原响应的 CSP —— 我们的注入脚本要能运行。对本 App 而言
                // 服务器页面的信任级别本来就等同"执行它的 JS"，所以这不降低实际安全边界。
                return new WebResourceResponse("text/html", "utf-8", 200, "OK", h,
                        new ByteArrayInputStream(injected.getBytes(StandardCharsets.UTF_8)));
            } catch (Exception e) {
                return null;
            } finally {
                if (c != null) c.disconnect();
            }
        }

        /** 读满上限就放弃（返回 null），避免异常大响应把内存吃掉；给主帧 HTML 用。 */
        private static String readAllCapped(InputStream in, int maxBytes) throws IOException {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                if (out.size() + n > maxBytes) return null;
                out.write(buf, 0, n);
            }
            return out.toString("UTF-8");
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            // 新一次主帧导航开始 → 清掉上一次的失败标记；onReceivedError 只在**本次**失败时置位，
            // 因此 onPageFinished 读到的永远是本次导航的结论（见 RemoteClientPolicy.healthy）。
            mainFrameErrored = false;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            hideLoading();
            // 返回键修复（审计 2026-10-05 §5 + PR#23 中优先级）：切服/加入都是一次真正的 loadUrl，
            // 历史栈会留下上一台服务器的页面；落地后清一次历史，使 canGoBack() 恒 false，返回键只由
            // 页面语义决定。只清「本次顶层导航」这一次（historyClearPending），不再按 host 匹配清 ——
            // 后者会把站点内部整页跳转的历史也抹掉（PR#23 发现：同站点返回历史消失）。
            if (historyClearPending && web != null && url != null
                    && originHost != null && originHost.equalsIgnoreCase(hostOf(url))) {
                historyClearPending = false;
                web.clearHistory();
            }
            // B（审计 §1）：打洞配置只属于「加入目标」这次导航——页面落地后 host 已不是当初设置
            // dcConfig 的那个（返回落地页/重载了他站），立即清除，避免 serveLocal 在后续导航里
            // 复读注入把无关页面的 WebSocket 也替换到打洞通道。注入发生在响应期，已加载页面不受影响。
            if (dcConfig != null && url != null) {
                String h = hostOf(url);
                if (h == null || !h.equalsIgnoreCase(dcOriginHost)) {
                    dcConfig = null;
                    dcOriginHost = null;
                    appendDiagLog("dc-config", "cleared: landed on " + h);
                }
            }
            // 离线服务默认启动（用户要求「进 app 默认启动离线服务」）：放在 onPageFinished 首次
            // 而非 onCreate 定时器——它意味着 shell UI 已经渲染可交互，「进入」按钮可立即命中已在跑/
            // 正在起的服务；且只在首帧触发一次，不会在每次换页重复拉起。isUp() 判重，异步起服务，
            // 失败静默记 diag，主线程零阻塞。
            if (!hostDefaultStarted) {
                hostDefaultStarted = true;
                ensureHostStartedDefault();
            }
            // Every (re)load re-lays-out the WebView — re-assert edge-to-edge + cutout here too
            // (idempotent, main thread, no heavy work) so a bar/cutout inset revealed during
            // navigation can never squeeze the page.
            applyImmersive();
            view.evaluateJavascript(
                "try{document.documentElement.classList.add('sp-standalone')}catch(e){}"
                + "try{if(!window.__SP_ERR_HOOK){window.__SP_ERR_HOOK=1;"
                + "window.addEventListener('error',function(ev){try{window.shell&&window.shell.logJsError&&window.shell.logJsError((ev.message||'error')+' @ '+((ev.filename||'')+':'+(ev.lineno||0)))}catch(e){}});"
                + "window.addEventListener('unhandledrejection',function(ev){try{window.shell&&window.shell.logJsError&&window.shell.logJsError('rejection: '+String(ev.reason))}catch(e){}})}}catch(e){}",
                null);
            maybeShowCrashNotice();
            // 服务器配置（§15）：页面已落地 → 该服务器的配置按「last-good 立刻可用、远程后台刷」就位，
            // 并推一次给页面（快照已存在时是纯内存操作，不产生网络）。
            ServerConfigHub.ensureFresh(origin);
            notifyServerConfigChanged();
            // 热更健康确认（v7.6，两条路径的不变量，见 RemoteClientPolicy.healthy）：
            //  • 本地树路径：主帧由内嵌树提供 → 新树真的渲染了 → 消费 pending（既有语义，逐字不变）。
            //  • 服务端界面路径：主帧 host 现在生效服务端界面，且本次导航没有报错 → 也算健康。
            //    默认「服务端界面」时本地树永不渲染；若这条不算，pending 标记永远不被消费 →
            //    下一次冷启动会把刚装好的热更回滚（这就是它与「默认开」必须同批改掉的原因）。
            // 本地树坏掉（没渲染）或远程页加载失败 → 两条都不成立 → 标记保留 → 冷启动照旧回滚。
            String finishedHost = url != null ? hostOf(url) : originHost;
            boolean remoteClientPage = finishedHost != null && remoteClientFor(finishedHost);
            Updater.markHealthy(MainActivity.this,
                    RemoteClientPolicy.healthy(pageServedFromLocalTree, remoteClientPage, mainFrameErrored));
            // 加入房间兜底：候选 URL 成功渲染（未再收到主帧 404）→ 关闭窗口。
            if (joinFallbackBase != null && joinFallbackLoading != null
                    && joinFallbackLoading.equals(url)) {
                clearJoinFallback();
            }
            // SWR（审计 §2）：若本页完成早于清单缓存段（段 1），页面拿不到 push（onServers 尚未
            // 定义，evaluateJavascript 被丢弃）→ 这里补一次 re-push。pushServerList 自带 web==null
            // 与钩子未定义兜底，直接调用即可（幂等）。
            pushServerList();
        }

        /**
         * 加入房间 404 兜底（审计 §3.5）：仅当主帧返回 404 且处于「加入房间导航」窗口内时，
         * 按候选序重载 withRoom(base) → base 补 "/" + room → 站点根 + room，命中即停。
         * 只对主帧生效、只在窗口内生效，绝不误伤普通页面的 404。
         */
        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
            if (request == null || errorResponse == null) return;
            if (!request.isForMainFrame()) return;
            if (errorResponse.getStatusCode() != 404) return;
            String base = joinFallbackBase;
            String code = joinFallbackCode;
            if (base == null || code == null) return; // 非「加入房间导航」状态 → 不干预
            if (System.currentTimeMillis() - joinFallbackAt > JOIN_FALLBACK_WINDOW_MS) {
                clearJoinFallback();
                return;
            }
            joinFallbackStep++;
            if (joinFallbackStep > 2) { // 候选耗尽（step 0 已是首次加载）
                clearJoinFallback();
                toast("加入失败：目标服务器入口 404，已尝试多种入口，请切换线路或更新服务器清单");
                return;
            }
            String next = joinCandidate(base, code, joinFallbackStep);
            if (next == null) {
                clearJoinFallback();
                return;
            }
            joinFallbackLoading = next;
            appendDiagLog("join-404", "step " + joinFallbackStep + " -> " + next);
            historyClearPending = true; // 兜底候选也是顶层导航：落地后同样清一次历史
            web.loadUrl(next);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
            if (request == null || !request.isForMainFrame()) return;
            // 本次主帧导航失败 → 服务端界面路径不能算健康（onPageFinished 会读到它，见
            // RemoteClientPolicy.healthy）；下一次导航开始时由 onPageStarted 清零。
            mainFrameErrored = true;
            hideLoading();
            // 断网/加载失败：不再跳转断网错误页。分三种情况处理（用户拍板）。
            if (joinFallbackBase != null) {
                // ① 正在「加入房间」导航窗口内：只提示，绝不劫持该加入导航（404 兜底与页面 pendingJoin
                //    仍可能成功），清窗避免影响后续。
                clearJoinFallback();
                toast("连接失败，请重试或切换线路");
                return;
            }
            if (origin != null && origin.startsWith("http://127.0.0.1")) {
                // ② 本地服务本身加载失败：只提示，避免 ensureHostAndSwitch 反复重启 Node 的死循环。
                toast("本地服务连接失败，请稍后重试或查看参数");
                return;
            }
            // ③ 远端线路失败：起本地服务 → 切本地 origin → 回首页（ensureHostAndSwitch 内部完成切换）。
            // A2（审计 §1）：这是失败兜底切换——落地后持久化写 "auto"（不固化 127.0.0.1:PORT），
            // 下次冷启动仍走自动线路重新探测，而不是直连一个已死的具体地址。
            ensureHostAndSwitch(true);
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
            + "['player-data.js','shell-bridge.js','dc-bridge.js'].forEach(function(n){"
            + "var s=document.createElement('script');s.async=false;s.src='" + SHELL_JS_PREFIX + "'+n;document.head.appendChild(s)})})();</script>";

    private String injectShellHtml(String html) {
        // 打洞配置（零补丁线）：老线靠 index.html 里的 /*SPDC*/ 锚点 + 构建期补丁，上游一换
        // index.html 就静默失效。改由外壳在**每次 HTML 响应**里内联注入，配置仍在 Java 侧计算
        // （joinOnOrigin 判定直连不通时设置），上游文件保持原样；dc-bridge.js 懒解析该全局，
        // 因此注入顺序无关。
        String dc = html.contains("__SP_DC_INPUT") ? "" : dcInjectScript();
        boolean loaderPresent = html.contains(SHELL_JS_PREFIX + "shell-bridge.js");
        if (loaderPresent && dc.isEmpty()) return html;
        String block = dc + (loaderPresent ? "" : SHELL_INJECT);
        int at = html.lastIndexOf("</body>");
        if (at < 0) at = html.lastIndexOf("</html>");
        if (at < 0) return html + block;
        return html.substring(0, at) + block + html.substring(at);
    }

    /** 仅打洞会话（本次导航）注入；dcConfig 在离开会话时被清空（onPageFinished/onBackPressed）。 */
    private String dcInjectScript() {
        JSONObject cfg = dcConfig;
        if (cfg == null) return "";
        // 房号来自用户输入，且这段会进**任何** HTML 响应（含第三方服务器页）：把 `</` 转义成 `<\/`
        // （JSON 与 JS 都认），否则 `</script>` 能提前闭合脚本块。
        String json = cfg.toString().replace("</", "<\\/");
        return "<script>window.__SP_DC_INPUT=" + json + ";</script>";
    }

    private WebResourceResponse respond(String mime, String enc, InputStream in) {
        WebResourceResponse resp = new WebResourceResponse(mime, enc, in);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", cacheControlFor(mime));
        headers.put("Access-Control-Allow-Origin", "*");
        resp.setResponseHeaders(headers);
        return resp;
    }

    /**
     * 本地命中（内嵌树 / 素材包 / 回源缓存）的 Cache-Control。
     *
     * <p><b>2026-10-09 审计阶段 4（D5）：可热更的静态素材不再给 {@code max-age=86400}，一律
     * {@code no-cache}。</b> 24 小时缓存在这里是陷阱：素材是**可热更**的（ArtStore 的 pack 与代码
     * 热更树都能就地把 {@code assets/foo.png} 换成新字节，而路径不变），WebView 一旦命中自己那层缓存
     * 就不会再问拦截器 —— 热更于是最多 24 小时不生效。业主口径「改了不生效」的另一半就在这里
     * （另一半是清单用 {@code force-cache} 读，见 art-prefetch.js）。
     *
     * <p>为什么 {@code no-cache} 在这里几乎不花钱：这些响应**全部由本进程的拦截器**从 filesDir
     * 直接给出（本地树 → 素材包 → 取回缓存），「重新验证」就是一次本地文件读，一个字节都不过网络。
     * CDN 那侧的带宽节省不受影响 —— 它由 {@link ArtCdn} 的取回缓存负责，与 WebView 的 HTTP 缓存无关。
     *
     * <p>将来若要拿回长缓存，正确的做法是**内容版本化 URL**（{@code ?v=<摘要>}）而不是放宽这里的
     * max-age：版本变了 URL 就变，缓存自然不命中，且不依赖任何重新验证语义。
     */
    private static String cacheControlFor(String mime) {
        return "no-cache";
    }

    /**
     * 本地命中序：filesDir/webroot（代码热更树）→ {@code filesDir/art/packs/<id>/}（素材热更，
     * 仅 /assets/**）→ APK 内嵌 assets/webroot。
     *
     * <p>**内嵌（不可热更）素材不做任何校验**（业主口径 2026-10-08）：APK 内嵌树的字节由 APK 签名
     * 覆盖、且在 APK 生命周期内不可变，所以命中即原样返回字节流 —— 没有 sha256、没有摘要，也没有
     * 第二次存在性探测。APK 的**未命中**在本进程内只记一次（{@link #apkMisses}）：否则同一张缺图
     * 的每一次请求都要再进一次 AssetManager（那是一次 zip 目录查询）。树与素材包两层仍先于 APK 查
     * （它们可热更，优先级不能反），所以热更新新增的文件依旧赢过内嵌副本：素材包里的字节在装包时已
     * 按签名清单的 sha256 校验过（ArtStore.sync），此后只读不验；任何异常都被吞掉 —— 素材永远不会
     * 弄坏一次页面加载（方案 §9 步骤 4）。
     */
    private InputStream openLocal(String path) {
        File f = new File(HostService.contentRoot(this), path);
        if (f.isFile()) {
            try {
                return new FileInputStream(f);
            } catch (IOException ignored) {
            }
        }
        if (path.startsWith("/assets/")) {
            try {
                InputStream art = ArtStore.open(ArtStore.rootOf(getFilesDir()), path);
                if (art != null) return art;
            } catch (Throwable ignored) {
            }
        }
        if (apkMisses.contains(path)) return null; // probed already this process: no re-check
        try {
            InputStream in = getAssets().open(ASSET_ROOT + path);
            if (in != null) return in;
        } catch (IOException notFound) {
            // fall through: remembered below
        }
        if (apkMisses.size() > APK_MISS_CAP) apkMisses.clear();
        apkMisses.add(path);
        return null;
    }

    // ------------------------------------------------------------------
    // 本地素材清单（业主口径 2026-10-08：内嵌素材不可热更 → 无需校验/无需预热）
    // ------------------------------------------------------------------

    /**
     * 「本机已经能提供哪些素材」清单：{@code filesDir/webroot/assets/**}（热更树，按设计通常为空）、
     * 已装素材包 {@code art/packs/<id>/assets/**}、以及 APK 内嵌 {@code webroot/assets/**} 三层。
     *
     * <p>为什么需要：预取的目的是把**将来会从 CDN 取**的素材提前取回来；已经在树/包/内嵌里的条目
     * 永远不会走 CDN（openLocal 先于回源缓存），为它们发请求纯属浪费 —— 在「APK 内嵌全量素材」的
     * 机型上那一轮游走会把 7969 条里的绝大部分打成无意义的请求，与页面自己抢加载线程（H3 的另一半）。
     * 页面侧（art-prefetch.js）拿到清单后把这些条目直接计数、不请求。
     *
     * <p>形态：一行一个 {@code assets/<rel>}（无前导斜杠），text/plain + no-cache，5 分钟 TTL。
     * 任何一层枚举失败只是少列几条（预取退回旧行为），绝不让清单本身报错。
     */
    private WebResourceResponse localArtListResponse() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache");
        headers.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse("text/plain", "utf-8", 200, "OK", headers,
                new ByteArrayInputStream(localArtList().getBytes(StandardCharsets.UTF_8)));
    }

    private String localArtList() {
        String cached = localArtListCache;
        if (cached != null && System.currentTimeMillis() - localArtListAt < LOCAL_ART_LIST_TTL_MS) return cached;
        StringBuilder sb = new StringBuilder(512 * 1024);
        java.util.Set<String> seen = new java.util.HashSet<>();
        collectLocalArt(new File(HostService.contentRoot(this), "assets"), "assets", sb, seen);
        File[] packs = ArtStore.packsDir(ArtStore.rootOf(getFilesDir())).listFiles();
        if (packs != null) {
            for (File p : packs) {
                if (p.isDirectory()) collectLocalArt(new File(p, "assets"), "assets", sb, seen);
            }
        }
        for (String p : apkArtList()) collectLocalArtLine(p, sb, seen);
        String out = sb.toString();
        localArtListCache = out;
        localArtListAt = System.currentTimeMillis();
        return out;
    }

    private static void collectLocalArt(File dir, String rel, StringBuilder sb, java.util.Set<String> seen) {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            String p = rel + "/" + k.getName();
            if (k.isDirectory()) collectLocalArt(k, p, sb, seen);
            else collectLocalArtLine(p, sb, seen);
        }
    }

    private static void collectLocalArtLine(String path, StringBuilder sb, java.util.Set<String> seen) {
        String line = ArtCdn.inventoryLine(path);
        if (line == null || !seen.add(line)) return;
        sb.append(line).append('\n');
    }

    /**
     * The asset paths the APK's embedded tree can serve. A {@code --no-assets} build embeds the
     * manifests but no {@code assets/**} bytes at all, so the tree is probed ONCE first
     * ({@code AssetManager.list}); only a non-empty directory means the bytes are really there.
     * The list itself comes from the APK's own {@code webroot/data/assets.json} (parsed once per
     * process — the APK cannot change while the process runs), which is exactly the set of asset
     * paths that build shipped.
     */
    private java.util.List<String> apkArtList() {
        java.util.List<String> cached = apkArtListCache;
        if (cached != null) return cached;
        java.util.List<String> out = new java.util.ArrayList<>();
        InputStream in = null;
        try {
            String[] top = getAssets().list(ASSET_ROOT + "/assets");
            if (top != null && top.length > 0) {
                in = getAssets().open(ASSET_ROOT + "/data/assets.json");
                java.util.regex.Matcher m = java.util.regex.Pattern
                        .compile("\"([^\"]*/assets(?:-re)?/[^\"]*)\"").matcher(readAll(in));
                while (m.find()) {
                    String p = ArtCdn.assetPathOf(m.group(1));
                    if (p != null) out.add(p);
                }
            }
        } catch (Throwable t) {
            out.clear(); // no (or unreadable) embedded tree: claim nothing rather than too much
        } finally {
            closeQuietly(in);
        }
        apkArtListCache = out;
        return out;
    }

    /**
     * 素材缺失占位（§6.3-A）：图片给 1×1 透明 PNG，其它类型给空体 + 正确 MIME，no-store。
     * 页面因此不会 404 连环失败，也不会为了一个缺图去请求游戏服务器/跨域 CDN。
     *
     * <p>唯一两个调用点都在「本地树 → ArtStore 素材包 → APK → 取回缓存 → CDN」全部落空之后，
     * 也就是说它是「此刻确实拿不到字节」的占位，不是「忙/慢」的占位；槽位等待已经由
     * {@link #acquireArtSlot(boolean)} 改成有界等待（页面 12 s），不会再因为预取占满槽位而回占位。
     * 响应头（no-store）由 {@link ArtCdn#placeholderHeaders()} 提供并单测，避免占位被 WebView 缓存
     * 而在素材到位后仍然显示空白（H4）。
     */
    private WebResourceResponse artPlaceholder(String path) {
        String mime = mimeFor(path);
        Map<String, String> headers = ArtCdn.placeholderHeaders();
        if (mime.startsWith("image/")) {
            return new WebResourceResponse("image/png", null, 200, "OK", headers,
                    new ByteArrayInputStream(ART_PLACEHOLDER_PNG));
        }
        return new WebResourceResponse(mime, null, 200, "OK", headers, new ByteArrayInputStream(new byte[0]));
    }

    // ------------------------------------------------------------------
    // 素材热更（P0）：artSync 编排（ArtStore 是纯核心，网络与落点都在这里接线）
    // ------------------------------------------------------------------

    /**
     * 「这个 APK 随包内嵌了 public/assets/** 吗」（构建期事实，见 build.gradle 的 EMBEDDED_ASSETS）。
     *
     * <p>运行期再叠一层实测：APK 里真的能列出 webroot/assets 才作数。BuildConfig 是构建期快照，
     * 而热更/物化可能改变实际布局 —— 两者取「与」：构建期说内嵌 **且** 包里确实有这一棵，才跳过
     * pack 安装。任一层说不准就退回「装」（既有行为），因为漏装会让无素材版真的没图。
     */
    private boolean embeddedAssets() {
        if (!BuildConfig.EMBEDDED_ASSETS) return false;
        try {
            String[] kids = getAssets().list(ASSET_ROOT + "/assets");
            return kids != null && kids.length > 0;
        } catch (IOException e) {
            return false; // 列不出来 → 当成没内嵌，退回装包（保守）
        }
    }

    /**
     * 拉最新验签清单并让 ArtStore 安装缺失的包；返回 JSON 字符串（字段同 ShellBridge.syncArt）。
     * 同步阻塞（桥线程/后台线程调用），耗时的下载在 ArtStore.sync 里；任何失败都只进 JSON 与 diag。
     */
    private String runArtSync() {
        File artRoot = ArtStore.rootOf(getFilesDir());
        try {
            Updater.Manifest m = Updater.fetchManifest(this);
            if (m == null || !m.usable()) {
                return "{\"ok\":false,\"version\":" + ArtStore.recordedVersion(artRoot)
                        + ",\"installed\":[],\"failed\":[],\"error\":\"manifest unavailable\"}";
            }
            manifestArtVersion = m.artVersion;
            if (m.artVersion < 1 || m.artPacks.isEmpty()) {
                return "{\"ok\":true,\"version\":" + ArtStore.recordedVersion(artRoot)
                        + ",\"installed\":[],\"failed\":[]}";
            }
            // 内嵌门禁（审计 2026-10-09 §1.2）：这个 APK 随包带了 public/assets/** 时，**不装 art pack**。
            // pack 里的字节 APK 里已经有一份，装下去就是 379 MiB 的纯重复（同一张图在设备上存两份，
            // 且 packs 永远先命中 → APK 内嵌那 381 MiB 从此不可达）。缺图由 ArtCdn 同源回源兜住。
            //
            // 保守方向：判定不了（BuildConfig 缺失/异常）时**照旧装**（既有行为逐字不变），宁可多下
            // 也不冒着缺素材的风险 —— 这里唯一要堵的是「明明内嵌了还去下一份」这种确定性的浪费。
            if (embeddedAssets()) {
                appendDiagLog("art-sync", "skipped: assets embedded in this APK (no pack install)");
                return "{\"ok\":true,\"version\":" + ArtStore.recordedVersion(artRoot)
                        + ",\"installed\":[],\"failed\":[],\"skipped\":\"embedded-assets\"}";
            }
            int failures = ArtStore.sync(artRoot, m.artVersion, m.artPacks, new ArtStore.Fetcher() {
                @Override
                public long fetch(String url, File dst, Updater.Progress p) throws IOException {
                    // 单连接 Range 续传 / 多连接分段的选择在 downloadArt 里（业主 2026-10-09
                    // 「多线程下载优化」：大包走分段，小包或半成品仍走线性）；
                    // https-only + ALLOWED_HOSTS + 重定向逐跳复验仍全部由 Updater.open() 执行
                    return Updater.downloadArt(url, dst, p);
                }
            }, new Updater.Progress() {
                @Override
                public void onStage(String stage) {
                    appendDiagLog("art-sync", stage);
                }
            });
            if (failures < 0) { // -1 = 已有 artSync 在跑（ArtStore 的互斥）
                return "{\"ok\":false,\"version\":" + ArtStore.recordedVersion(artRoot)
                        + ",\"installed\":[],\"failed\":[],\"error\":\"art sync already running\"}";
            }
            org.json.JSONArray installed = new org.json.JSONArray();
            org.json.JSONArray failed = new org.json.JSONArray();
            for (ArtStore.Pack p : m.artPacks) {
                if (ArtStore.installedAt(artRoot, p)) installed.put(p.id);
                else failed.put(p.id);
            }
            org.json.JSONObject out = new org.json.JSONObject();
            out.put("ok", failures == 0);
            out.put("version", m.artVersion);
            out.put("installed", installed);
            out.put("failed", failed);
            return out.toString();
        } catch (Throwable t) {
            appendDiagLog("art-sync", String.valueOf(t));
            return "{\"ok\":false,\"version\":" + ArtStore.recordedVersion(artRoot)
                    + ",\"installed\":[],\"failed\":[],\"error\":" + org.json.JSONObject.quote(String.valueOf(t)) + "}";
        }
    }

    /**
     * 后台单飞 artSync（拦截器缺图命中时自动触发）；静默，失败只留 diag。
     *
     * <p>H2（2026-10-08 现场报告「资源一直在重复校验」）：拦截器**每个**缺图都会走到这里，而一次
     * artSync 会重新拉取验签清单并对每个未安装的包重新下载 + sha256 校验（{@code ArtStore.sync}）。
     * 缓存曾因清单 hash 变化被整体孤儿化（见 {@link #artCacheNamespace()}）时缺图成千上万，
     * 于是清单/整包校验被反复跑了成千上万遍。自动路径因此限流：每个窗口最多一次。用户/桥接的显式
     * 请求（{@code ShellBridge.syncArt}）仍直连 {@link #runArtSync()}，不受限。
     */
    private void requestArtSync() {
        if (!artSyncRunning.compareAndSet(false, true)) return;
        long now = System.currentTimeMillis();
        if (now - lastAutoArtSyncAt < ART_AUTO_SYNC_MIN_INTERVAL_MS) {
            artSyncRunning.set(false); // throttled: the loop must not become a re-verify storm
            return;
        }
        lastAutoArtSyncAt = now;
        Thread t = new Thread(() -> {
            try {
                runArtSync();
            } catch (Throwable e) {
                appendDiagLog("art-sync", String.valueOf(e));
            } finally {
                artSyncRunning.set(false);
            }
        }, "art-sync");
        t.start();
    }

    // 已删除 maybeArtSyncAfterUpdate（2026-10-08 业主口径）：热补丁落地后不再触发整轴素材重校验，
    // 见 autoCheckForUpdate / 手动更新两处调用点的口径说明。素材轴入口只剩「缺图（限流）」与
    // 「用户显式 syncArt」，且都在写入时校验。

    // ------------------------------------------------------------------
    // 服务器配置（ServerConfig）：快照 → JSON（桥接），与刷新时机编排
    // ------------------------------------------------------------------

    /**
     * 配置快照 → 页面用的 JSON。字段名与 {@code server-config.js} 的读取侧一一对应；任何序列化
     * 失败都降级成 "{}"（= 没有配置），绝不让配置把页面搞崩。
     */
    private static String serverConfigJson(ServerConfig cfg) {
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("schema", cfg.schema());
            o.put("serverId", cfg.serverId());
            o.put("version", cfg.version());
            o.put("ttl", cfg.ttl());

            ServerConfig.Announce a = cfg.announce();
            if (a != null) {
                org.json.JSONObject ao = new org.json.JSONObject();
                ao.put("title", a.title);
                ao.put("body", a.body);
                ao.put("level", a.level);
                o.put("announce", ao);
            }
            ServerConfig.Matchmaking m = cfg.matchmaking();
            if (m != null) {
                org.json.JSONObject mo = new org.json.JSONObject();
                mo.put("enabled", m.enabled);
                mo.put("endpoint", m.endpoint);
                mo.put("modes", new org.json.JSONArray(m.modes));
                mo.put("partySize", m.partySize);
                mo.put("queueTimeoutSec", m.queueTimeoutSec);
                o.put("matchmaking", mo);
            }
            org.json.JSONArray feats = new org.json.JSONArray();
            for (ServerConfig.Feature f : cfg.features()) {
                org.json.JSONObject fo = new org.json.JSONObject();
                fo.put("id", f.id);
                fo.put("enabled", f.enabled);
                fo.put("mode", f.mode);
                if (f.startAt != null) fo.put("startAt", f.startAt.longValue());
                if (f.endAt != null) fo.put("endAt", f.endAt.longValue());
                feats.put(fo);
            }
            o.put("features", feats);
            org.json.JSONArray packs = new org.json.JSONArray();
            for (ServerConfig.FeaturePackRef p : cfg.featurePacks()) {
                org.json.JSONObject po = new org.json.JSONObject();
                po.put("id", p.id);
                po.put("version", p.version);
                packs.put(po);
            }
            o.put("featurePacks", packs);
            return o.toString();
        } catch (Throwable t) {
            return "{}";
        }
    }

    /**
     * 配置变化 → 通知页面（{@code __SP_SERVER_CONFIG_CHANGED}）。监听者只在配置真正变化时被通知
     * （ServerConfigHub 已做版本去重），所以这里不会形成定时风暴。
     */
    private void notifyServerConfigChanged() {
        if (web == null) return;
        final String js = "(function(){try{var e=document.createEvent('Event');"
                + "e.initEvent('__SP_SERVER_CONFIG_CHANGED',true,true);window.dispatchEvent(e);"
                + "if(window.__SP_SERVER_CONFIG&&window.__SP_SERVER_CONFIG.reload)window.__SP_SERVER_CONFIG.reload();"
                + "}catch(err){}})();";
        main.post(() -> {
            if (web == null || isFinishing()) return;
            try {
                web.evaluateJavascript(js, null);
            } catch (Throwable ignored) {
            }
        });
    }

    /**
     * 进入/切换服务器后的配置编排（§15）：先把上一个服务器的快照丢掉（防跨服串味），再按
     * 「磁盘 last-good → 后台远程刷新」的次序就位。**只读一次盘**，联网永远在后台线程。
     */
    private void syncServerConfigFor(String base) {
        try {
            ServerConfigHub.onOriginChanged();
            ServerConfigHub.ensureFresh(base);
        } catch (Throwable t) {
            appendDiagLog("server-config", String.valueOf(t));
        }
    }

    // ------------------------------------------------------------------
    // no-embedded-assets 同源回源：/assets/** 缺 → CDN 取回 + filesDir/art/cache/<hash>/ 缓存
    // ------------------------------------------------------------------
    // 缓存位置刻意放在 ArtStore 的素材根之下（filesDir/art/cache/），让 filesDir/art 保持「唯一素材
    // 根」：packs/ 是签名清单覆盖、装包时 sha256 校验过的内容；cache/ 是未被任何 pack 覆盖的素材从
    // 本线 CDN base 的同源回取（ArtStore 只枚举 packs/，两者互不可见；整棵 art/ 可一起清理）。
    // 本地命中序（openLocal + 本段）：filesDir/webroot → ArtStore packs → APK 内嵌 → cache → CDN 取回。

    /**
     * The manifest's top-level {@code hash} (data/assets.json), used to namespace the fetched-art
     * cache. Read from the local tree first (filesDir/webroot) then the APK, cached in memory, and
     * re-read only when the local manifest's (length, lastModified) changes — a hot update swaps the
     * tree, so the namespace follows automatically. Any failure degrades to
     * {@link ArtCdn#FALLBACK_HASH} (never disables caching).
     */
    private String currentArtHash() {
        File f = new File(HostService.contentRoot(this), "/data/assets.json");
        long stamp;
        InputStream in = null;
        if (f.isFile()) {
            stamp = (f.length() * 31L) + f.lastModified();
            in = openFileQuietly(f);
        } else {
            stamp = -1L; // APK-baked manifest: immutable for the life of this APK
            try {
                in = getAssets().open(ASSET_ROOT + "/data/assets.json");
            } catch (IOException ignored) {
            }
        }
        String cached = artHashCache;
        if (cached != null && stamp == artHashStamp) {
            closeQuietly(in);
            return cached;
        }
        String hash = readManifestHash(in);
        closeQuietly(in);
        if (hash == null) hash = ArtCdn.FALLBACK_HASH;
        artHashCache = hash;
        artHashStamp = stamp;
        return hash;
    }

    /** Parses just the top-level {@code "hash"} from a manifest stream (bounded; null when absent). */
    private static String readManifestHash(InputStream in) {
        if (in == null) return null;
        try {
            StringBuilder sb = new StringBuilder();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                if (sb.length() > 8 * 1024 * 1024) break;
            }
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("\"hash\"\\s*:\\s*\"([^\"]{1,64})\"").matcher(sb);
            return m.find() ? m.group(1) : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static void closeQuietly(InputStream in) {
        if (in == null) return;
        try {
            in.close();
        } catch (IOException ignored) {
        }
    }

    /**
     * Serves a missing {@code /assets/**} path from the CDN, caching it under
     * {@code filesDir/art/cache/<manifest hash>/assets/**}. Returns a stream over the cache file, or
     * null on ANY failure — the caller then falls back to the art-pack path (placeholder + background
     * artSync) or, for old manifests, to the original behavior.
     * <p>Same path = one download: concurrent requests for the same asset block on a per-path lock and
     * the losers read the freshly written file. A global semaphore caps how many CDN fetches the
     * interceptor can hold at once. Pure path/host decisions live in {@link ArtCdn}.
     * <p>信任分级：pack 字节由签名清单的 art.packs[].sha256 覆盖（装包时校验）；这里回取的 CDN
     * 字节**没有**逐文件哈希可用（上游 data/assets.json 只有顶层元数据 hash，没有 per-file sha），
     * 因此这一层不引入第二个信任根，也不冒充已验签内容——只做 https + host 白名单 + 无重定向 +
     * 2xx + 体积上限，失败即不落盘。命名空间随清单 hash 变化（本仓库构建期会把该 hash 重算为
     * 覆盖素材字节的内容哈希，见 tools/apk/transcode-assets.mjs）。
     */
    /**
     * 从**当前服务器**取一个素材（方案 §2 第 ⑤ 层）。
     *
     * <p>只在服务器声明了 {@code resources.serveAssets} 时才动作（{@link ServerConfig#serveAssets()}）——
     * 默认关闭，所以官方服的每一次素材请求都仍然只走本地 + CDN，一个字节的额外往返都没有。
     *
     * <p><b>同源是构造出来的，不是检查出来的</b>：URL 由 {@link ResourceResolver#sameOriginUrl} 用
     * 「当前 origin 的 scheme+host+port + 站内相对路径」拼成，请求只会发给用户已经连着的那台服务器；
     * 素材路径里出现 {@code ..}、绝对 URL、反斜杠一律不构造。因此这一层既不会变成对第三方的探测，
     * 也不会有第二个 host。局域网服/本机主机服务都是 http —— 这是产品前提，故此处允许 http。
     *
     * <p>取回后按 {@code art/cache/<hash>/srv-<serverKey>-<cfgVersion>/} 落盘（与 CDN 槽分开，见
     * {@link ArtCdn#serverCacheRelPath}）并同源回吐。任何失败返回 null，由调用方继续 CDN → 占位。
     */
    private InputStream openAssetFromServer(String path, boolean prefetch) {
        ServerConfig cfg = ServerConfigHub.current();
        if (cfg == null || !cfg.serveAssets()) return null;
        String base = origin;
        if (base == null || base.isEmpty()) return null;
        String rel = ArtCdn.serverCacheRelPath(artCacheNamespace(),
                ServerConfigStore.serverKeyOf(base), cfg.version(), path);
        if (rel == null) return null;
        File cached = new File(getFilesDir(), rel);
        InputStream hit = openFileQuietly(cached);
        if (hit != null) return hit; // 缓存命中 → 不联网（命中即纯字节：不重算任何哈希）
        String url = ResourceResolver.sameOriginUrl(base, path);
        if (url == null) return null;
        if (artMissRemembered(cached)) return null; // 明确的 4xx 才被记住，见 rememberArtMiss
        Object lock = artFetchLocks.computeIfAbsent(path, k -> new Object());
        synchronized (lock) {
            try {
                hit = openFileQuietly(cached); // 并发等待期间别的线程可能已经写完
                if (hit != null) return hit;
                if (!downloadAssetSameOrigin(url, cached, prefetch)) return null;
                return openFileQuietly(cached);
            } finally {
                artFetchLocks.remove(path, lock);
            }
        }
    }

    /**
     * 从当前服务器取回一个素材并原子落盘。与 {@link #downloadArtToCache} 同一套硬约束（不跟随重定向、
     * 超时、体积上限、{@code .part} → rename），但**不复用主机白名单**：这里的目标是用户当前所在的
     * 服务器，可能是私网地址（局域网联机与「本机主机服务」都是产品核心场景），所以判定的是
     * 「与当前 origin 同源」而不是「在白名单里」——同源比白名单更严：它一个第三方主机都不允许。
     */
    private boolean downloadAssetSameOrigin(String url, File dest, boolean prefetch) {
        HttpURLConnection c = null;
        boolean slot = false;
        File part = new File(dest.getParentFile(), dest.getName() + ".part");
        try {
            URL u = new URL(url);
            if (!sameOriginAs(u, origin)) {
                appendDiagLog("art-srv", "not same-origin: " + u.getHost());
                return false;
            }
            if (!acquireArtSlot(prefetch)) {
                return false; // 饱和就放弃，不堆线程（页面请求是有界等待，预取是 300 ms 让路）
            }
            slot = true;
            c = (HttpURLConnection) u.openConnection();
            c.setInstanceFollowRedirects(false); // 重定向可能指向别的 host
            c.setConnectTimeout(ART_FETCH_TIMEOUT_MS);
            c.setReadTimeout(ART_FETCH_READ_TIMEOUT_MS);
            c.setRequestProperty("Accept", "*/*");
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) {
                if (ArtCdn.isPermanentMiss(code)) rememberArtMiss(dest); // 只有 404/410 是定论（见 ArtCdn）
                return false;
            }
            long len = c.getContentLength();
            if (len > ART_FETCH_MAX_BYTES) return false;
            File dir = dest.getParentFile();
            if (dir != null) //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
            long total = 0;
            boolean tooBig = false;
            try (InputStream in = c.getInputStream();
                 java.io.FileOutputStream out = new java.io.FileOutputStream(part)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    total += n;
                    if (total > ART_FETCH_MAX_BYTES) {
                        tooBig = true;
                        break;
                    }
                    out.write(buf, 0, n);
                }
            }
            if (tooBig || total <= 0) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                return false;
            }
            if (!part.renameTo(dest)) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                return false;
            }
            artCacheStats().onWrite(dest.length()); // O(1): the server-slot file is under the same cache root
            return true;
        } catch (Throwable t) {
            //noinspection ResultOfMethodCallIgnored
            part.delete();
            return false;
        } finally {
            if (slot) releaseArtSlot(prefetch);
            if (c != null) c.disconnect();
        }
    }

    /**
     * 取一个 CDN 槽：页面请求（{@code prefetch=false}）有界等待 {@link #ART_PAGE_SLOT_WAIT_MS}——
     * 占位（空白图标）比多等一会儿更糟；预取请求先拿预取槽，再以 300 ms 耐心去抢页面槽，抢不到就当
     * 这一轮预取失败（下一轮再试），所以预取永远不会把页面挤成占位。返回 true 表示已持有两种槽。
     */
    private boolean acquireArtSlot(boolean prefetch) {
        java.util.concurrent.TimeUnit ms = java.util.concurrent.TimeUnit.MILLISECONDS;
        boolean pageSlot;
        try {
            if (prefetch) {
                if (!artPrefetchSlots.tryAcquire(ART_PREFETCH_SLOT_WAIT_MS, ms)) return false;
            }
            pageSlot = artFetchSlots.tryAcquire(prefetch ? ART_PREFETCH_SLOT_WAIT_MS : ART_PAGE_SLOT_WAIT_MS, ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt(); // the caller is being torn down: no slot, no fetch
            if (prefetch) artPrefetchSlots.release();
            return false;
        }
        if (pageSlot) return true;
        if (prefetch) artPrefetchSlots.release();
        return false;
    }

    /** 释放 {@link #acquireArtSlot(boolean)} 取得的槽（成功才调用，与上面一一对应）。 */
    private void releaseArtSlot(boolean prefetch) {
        artFetchSlots.release();
        if (prefetch) artPrefetchSlots.release();
    }

    /**
     * 明确的 4xx（404/410 等）是本进程内的定论：记住它，别让同一张缺图在每次页面重绘时都再打一次
     * CDN、再触发一次 artSync（超时/5xx 不记 —— 那是暂态，必须马上能重试）。换命名空间后目标文件
     * 路径不同，自然重新尝试。
     */
    private boolean artMissRemembered(File dest) {
        String key = dest.getAbsolutePath();
        Long until = artMissUntil.get(key);
        if (until == null) return false;
        if (until.longValue() < System.currentTimeMillis()) {
            artMissUntil.remove(key);
            return false;
        }
        return true;
    }

    private void rememberArtMiss(File dest) {
        if (artMissUntil.size() > 4096) artMissUntil.clear(); // bounded: a bad manifest may 404 a lot
        artMissUntil.put(dest.getAbsolutePath(), System.currentTimeMillis() + ART_MISS_TTL_MS);
    }

    /** 同源判定：scheme + host（大小写不敏感）+ 有效端口三者全等。 */
    private static boolean sameOriginAs(URL u, String originBase) {
        try {
            URL o = new URL(originBase);
            String us = u.getProtocol() == null ? "" : u.getProtocol().toLowerCase(Locale.ROOT);
            String os = o.getProtocol() == null ? "" : o.getProtocol().toLowerCase(Locale.ROOT);
            if (!us.equals(os)) return false;
            String uh = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
            String oh = o.getHost() == null ? "" : o.getHost().toLowerCase(Locale.ROOT);
            if (!uh.equals(oh) || uh.isEmpty()) return false;
            return effectivePort(u) == effectivePort(o);
        } catch (Exception e) {
            return false;
        }
    }

    /** 显式端口，缺省时按 scheme 归一（http 80 / https 443）。 */
    private static int effectivePort(URL u) {
        if (u.getPort() > 0) return u.getPort();
        return "https".equalsIgnoreCase(u.getProtocol()) ? 443 : 80;
    }

    /**
     * The namespace the fetched-art cache is addressed with, after adopting the predecessor
     * namespace when the manifest hash changed.
     *
     * <p>H1（2026-10-08 现场报告：图标空白 + 进度从 0 重数）：{@code data/assets.json} 的顶层
     * {@code hash} 由构建按「被引用字节」重算（{@code tools/apk/transcode-assets.mjs
     * hashReferencedBytes}），所以一次内容发布换掉 hash 是常态 —— 实测 7969 条引用路径与顺序完全
     * 未变（指纹 7c35d506 前后一致），只是 hash 从 {@code b699458e3e10} 变成 {@code 7ae1d03466cb}。
     * 而设备上的缓存目录名就是那个 hash：不处理就等于「一次更新把 100 % 已取回的素材作废并全部重下」。
     * 这里把旧命名空间**目录改名**成新命名空间（同一文件系统内的 rename，字节与相对路径都没变），
     * 于是路径不变的文件立刻命中；只有当确实没有旧目录时才会真的从头取回。
     */
    private String artCacheNamespace() {
        String hash = ArtCdn.safeHash(currentArtHash());
        if (!hash.equals(artCacheNamespaceDone)) adoptArtCacheNamespace(new File(getFilesDir(), ArtCdn.CACHE_DIR), hash);
        return hash;
    }

    /** 「试过了、但没有可用的表」的负缓存哨兵（避免每个请求都去重读一次）。 */
    private static final java.util.Map<String, String> NO_DIGESTS = java.util.Collections.emptyMap();

    /**
     * 当前清单 hash 对应的逐文件摘要表（{@code <rel> → sha256}）；没有可用表返回 null。
     *
     * <p>从 webroot 的 {@code /data/asset-digests.json} 读（走 {@link #openLocal} 同一条链：本地树 →
     * 素材包 → APK），每个 hash 只解析一次。**表里的 {@code hash} 必须等于当前清单 hash**：旧内容包配
     * 新清单时这张表描述的是别的字节，拿它校验会把好文件判成坏的。
     */
    private java.util.Map<String, String> artDigestsFor(String hash) {
        java.util.Map<String, String> cached = artDigests;
        if (cached != null && hash.equals(artDigestsHash)) return cached == NO_DIGESTS ? null : cached;
        synchronized (artCacheMigrateLock) {
            cached = artDigests;
            if (cached != null && hash.equals(artDigestsHash)) return cached == NO_DIGESTS ? null : cached;
            java.util.Map<String, String> loaded = NO_DIGESTS;
            InputStream in = null;
            try {
                in = openLocal(ArtCdn.DIGEST_PATH);
                if (in != null) {
                    java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream(1 << 20);
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        bos.write(buf, 0, n);
                        if (bos.size() > 8 * 1024 * 1024) break; // 防御：畸形/超大文件不当表用
                    }
                    org.json.JSONObject doc = new org.json.JSONObject(bos.toString("UTF-8"));
                    String dh = doc.optString("hash", "");
                    org.json.JSONObject map = doc.optJSONObject("digests");
                    if (map != null && ArtCdn.digestsUsableFor(hash, dh, map.length())) {
                        java.util.Map<String, String> out = new java.util.HashMap<>(map.length() * 2);
                        java.util.Iterator<String> it = map.keys();
                        while (it.hasNext()) {
                            String k = it.next();
                            String v = map.optString(k, "");
                            if (ArtCdn.isValidDigest(v)) out.put(k, v);
                        }
                        if (!out.isEmpty()) loaded = out;
                    } else {
                        appendDiagLog("art-digests", "unusable (file hash=" + dh + ", manifest hash=" + hash + ")");
                    }
                }
            } catch (Throwable t) {
                appendDiagLog("art-digests", String.valueOf(t));
            } finally {
                closeQuietly(in);
            }
            artDigests = loaded;
            artDigestsHash = hash;
            return loaded == NO_DIGESTS ? null : loaded;
        }
    }

    /**
     * 采纳（改名继承）旧命名空间 —— **只在有与当前 hash 对应的逐文件摘要表时**。
     *
     * <p>审计 2026-10-09 阶段 1（方案 1）：清单 hash 是字节敏感的（{@code transcode-assets.mjs}
     * {@code hashReferencedBytes}），所以「hash 变了」就等于「内容变了」。旧实现无条件改名复用，于是
     * **那张唯一改过的图恰好是唯一永远不更新的图**。现在：有摘要表 → 改名继承，并在**使用时逐个校验**
     * （不符即丢掉重取）；没有摘要表 → **不采纳**（新命名空间自然落空、按需重取）——「无逐文件摘要证据
     * 时不得假定字节未变」。
     */
    private void adoptArtCacheNamespace(File cacheRoot, String current) {
        synchronized (artCacheMigrateLock) {
            if (current.equals(artCacheNamespaceDone)) return;
            boolean adopted = false;
            try {
                if (artDigestsFor(current) == null) {
                    appendDiagLog("art-adopt", "no digests for " + current + " — not adopting (correctness over bandwidth)");
                } else {
                    File to = new File(cacheRoot, current);
                    String[] existing = to.list();
                    boolean emptyLeftover = to.isDirectory() && (existing == null || existing.length == 0);
                    if (!to.exists() || emptyLeftover) {
                        // An EMPTY current-namespace dir is a failed fetch's leftover (mkdirs, then the
                        // body died), not a populated namespace: drop it so the rename can land.
                        if (emptyLeftover) //noinspection ResultOfMethodCallIgnored
                            to.delete();
                        File from = pickArtCachePredecessor(cacheRoot, current);
                        if (from != null) {
                            if (from.renameTo(to)) {
                                adopted = true; // 继承来的字节：使用时必须逐个按摘要校验
                                appendDiagLog("art-adopt", from.getName() + " -> " + current + " (verified on use)");
                            } else {
                                appendDiagLog("art-adopt", "rename failed: " + from.getName());
                            }
                        }
                    }
                    // 已存在且有内容的当前命名空间：它的字节是本 hash 下取回的，不是继承来的 → adopted 保持 false
                }
            } catch (Throwable t) {
                appendDiagLog("art-adopt", String.valueOf(t));
            }
            artNamespaceAdopted = adopted;
            if (!current.equals(artVerifiedNs)) {
                artVerified = java.util.concurrent.ConcurrentHashMap.<String>newKeySet();
                artVerifiedNs = current;
            }
            artCacheNamespaceDone = current; // set either way: one attempt per hash per process
        }
    }

    /**
     * 采纳继承来的缓存文件在**首次使用时**按摘要校验一次（本进程内只验一次/路径）。
     *
     * <p>只对「继承来的命名空间」做这件事：本 hash 下自己下载的字节本来就是这个 hash 的内容，再验一遍
     * 纯属浪费。摘要缺失（清单没引用它 / 表里没有该键）一律放行 —— 校验是**加强**，不是新的拒绝理由。
     */
    private boolean verifyAdoptedCached(String path, File file) {
        if (!artNamespaceAdopted) return true;
        String ns = artVerifiedNs;
        if (ns == null) return true;
        java.util.Set<String> verified = artVerified;
        if (verified.contains(path)) return true;
        String key = ArtCdn.digestKey(path);
        if (key == null) return true;
        java.util.Map<String, String> digests = artDigestsFor(ns);
        if (digests == null) return true;
        String want = digests.get(key);
        if (want == null) return true;
        String got;
        try {
            got = Updater.sha256(file);
        } catch (Throwable t) {
            return true; // 读不出就不拦（宁可用可疑字节，也不让页面缺图；下一轮还会再验）
        }
        if (ArtCdn.digestMatches(want, got)) {
            verified.add(path);
            return true;
        }
        appendDiagLog("art-digest", "stale inherited bytes, refetching: " + path);
        return false;
    }

    /**
     * The most recently used namespace directory that is not the current one (null when there is
     * nothing to adopt — the only case where the cached bytes are orphaned). Only non-empty
     * directories are considered: an empty leftover is worth nothing, and adopting it would just
     * hide the real predecessor. The decision itself is pure ({@link ArtCdn#pickAdoptable}).
     */
    private static File pickArtCachePredecessor(File cacheRoot, String current) {
        File[] kids = cacheRoot.listFiles();
        if (kids == null) return null;
        java.util.List<File> dirs = new java.util.ArrayList<>();
        for (File k : kids) {
            if (!k.isDirectory() || k.getName().equals(current) || !ArtCdn.isValidNamespace(k.getName())) continue;
            String[] inner = k.list();
            if (inner == null || inner.length == 0) continue;
            dirs.add(k);
        }
        dirs.sort((x, y) -> Long.compare(y.lastModified(), x.lastModified()));
        java.util.List<String> names = new java.util.ArrayList<>();
        for (File d : dirs) names.add(d.getName());
        String pick = ArtCdn.pickAdoptable(current, names);
        if (pick == null) return null;
        for (File d : dirs) if (d.getName().equals(pick)) return d;
        return null;
    }

    // ------------------------------------------------------------------
    // 素材缓存实况（feat/art-cache-status）：O(1) 计数器 + 启动后台对账
    // ------------------------------------------------------------------

    /** 已排队/已对账的命名空间；命名空间（清单 hash）变化时重新对账一次。 */
    private volatile String artCacheReconciledNs = null;
    private final Object artCacheReconcileLock = new Object();

    /**
     * 配置好的计数器集合：把持久化元数据（素材根下 cache-stats.txt）与当前命名空间绑定。
     * 命名空间不变时是廉价 no-op；变化时清零并从元数据恢复（缺失就等后台对账）。
     */
    private ArtCacheStats artCacheStats() {
        ArtCacheStats stats = ArtCdn.cacheStats();
        try {
            stats.configure(ArtCacheStats.metaFile(ArtStore.rootOf(getFilesDir())), artCacheNamespace());
        } catch (Throwable ignored) {
            // 计数器是诊断增强，绝不允许它弄坏素材服务/桥调用
        }
        return stats;
    }

    /**
     * 后台对账一次：单次扫描 {@code art/cache/<hash>} 的真实文件数与字节数，与内存计数器（含持久化
     * 元数据）比对，不一致就以磁盘为准修复并写回元数据。**只在后台线程跑**，桥调用本身仍是 O(1)。
     * 每个命名空间只对账一次（清单 hash 变化后重新对账）。
     */
    private void ensureArtCacheReconcile() {
        String ns;
        try {
            ns = artCacheNamespace();
        } catch (Throwable t) {
            return; // 拿不到命名空间就放弃对账：artCacheStatus 仍会诚实地报 0（而不是假数字）
        }
        if (ns.equals(artCacheReconciledNs)) return;
        synchronized (artCacheReconcileLock) {
            if (ns.equals(artCacheReconciledNs)) return;
            artCacheReconciledNs = ns;
        }
        final String target = ns;
        Thread t = new Thread(() -> {
            try {
                ArtCacheStats stats = artCacheStats();
                ArtCacheStats.Count actual = stats.scan(new File(getFilesDir(), ArtCdn.CACHE_DIR), target);
                stats.reconcileTo(actual, target);
            } catch (Throwable e) {
                appendDiagLog("art-cache", String.valueOf(e));
            }
        }, "art-cache-reconcile");
        t.start();
    }

    /**
     * 被未嵌入素材的构建使用：缓存命中即纯字节返回（{@link #openFileQuietly} 只做一次
     * {@code File.isFile()} 探测，**不重算任何哈希** —— 校验只发生在写盘/装包那一刻），未命中才回源。
     * {@code prefetch} 为 true 表示这是 {@code art-prefetch.js} 的后台请求（见 {@link #acquireArtSlot}）。
     */
    private InputStream openAssetFromCdn(String path, boolean prefetch) {
        String rel = ArtCdn.cacheRelPath(artCacheNamespace(), path);
        if (rel == null) return null;
        File cached = new File(getFilesDir(), rel);
        InputStream hit = openFileQuietly(cached);
        if (hit != null) {
            // 阶段 1（方案 1）：继承来的命名空间要按摘要逐个校验；不符说明这份缓存属于**旧内容**，
            // 丢掉并当作未命中回源重取（这正是「同路径换字节后能加载新素材」的那一步）。
            if (verifyAdoptedCached(path, cached)) return hit; // cache hit → never touch the network
            closeQuietly(hit);
            //noinspection ResultOfMethodCallIgnored
            cached.delete();
            hit = null;
        }
        String url = ArtCdn.cdnUrlFor(path);
        if (url == null) return null;
        if (artMissRemembered(cached)) return null; // a definitive 4xx, remembered for ART_MISS_TTL_MS
        Object lock = artFetchLocks.computeIfAbsent(path, k -> new Object());
        synchronized (lock) {
            try {
                hit = openFileQuietly(cached); // another thread may have finished while we waited
                if (hit != null) return hit;
                if (!downloadArtToCache(url, cached, prefetch)) return null;
                return openFileQuietly(cached);
            } finally {
                artFetchLocks.remove(path, lock);
            }
        }
    }

    private static InputStream openFileQuietly(File f) {
        if (f == null || !f.isFile()) return null;
        try {
            return new FileInputStream(f);
        } catch (IOException ignored) {
            return null;
        }
    }

    /**
     * Fetches ONE asset into the cache, atomically (write {@code .part}, then rename). https only,
     * allowlisted host only (loopback/private/reserved rejected BEFORE the request), no redirects,
     * 2xx only, connect/read timeout + body ceiling enforced. Any failure deletes the partial file
     * and returns false.
     */
    private boolean downloadArtToCache(String url, File dest, boolean prefetch) {
        HttpURLConnection c = null;
        boolean slot = false;
        File part = new File(dest.getParentFile(), dest.getName() + ".part");
        try {
            URL u = new URL(url);
            if (!"https".equalsIgnoreCase(u.getProtocol())) return false;
            if (!ArtCdn.isAllowedHost(u.getHost())) {
                appendDiagLog("art-cdn", "blocked host: " + u.getHost());
                return false;
            }
            if (!acquireArtSlot(prefetch)) {
                return false; // saturated: give up rather than pile up threads (prefetch yields first)
            }
            slot = true;
            c = (HttpURLConnection) u.openConnection();
            c.setInstanceFollowRedirects(false); // a redirect could point at a non-allowlisted host
            c.setConnectTimeout(ART_FETCH_TIMEOUT_MS);
            c.setReadTimeout(ART_FETCH_READ_TIMEOUT_MS);
            c.setRequestProperty("Accept", "*/*");
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) {
                if (ArtCdn.isPermanentMiss(code)) rememberArtMiss(dest); // 只有 404/410 是定论（见 ArtCdn）
                return false;
            }
            long len = c.getContentLength();
            if (len > ART_FETCH_MAX_BYTES) return false;
            File dir = dest.getParentFile();
            if (dir != null) //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
            long total = 0;
            boolean tooBig = false;
            try (InputStream in = c.getInputStream();
                 java.io.FileOutputStream out = new java.io.FileOutputStream(part)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    total += n;
                    if (total > ART_FETCH_MAX_BYTES) {
                        tooBig = true;
                        break;
                    }
                    out.write(buf, 0, n);
                }
            }
            if (tooBig || total <= 0) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                return false;
            }
            if (!part.renameTo(dest)) { // same-dir rename is atomic on the app's filesystem
                //noinspection ResultOfMethodCallIgnored
                dest.delete();
                if (!part.renameTo(dest)) {
                    //noinspection ResultOfMethodCallIgnored
                    part.delete();
                    return false;
                }
            }
            artCacheStats().onWrite(dest.length()); // O(1): the fetched-cache counter (never walks)
            maybePruneArtCache();
            return true;
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            part.delete();
            return false;
        } finally {
            if (c != null) c.disconnect();
            if (slot) releaseArtSlot(prefetch);
        }
    }

    /** Prune every 32 writes — the cache is a soft cap, not a hard quota (先简单实现). */
    private void maybePruneArtCache() {
        if ((ART_CACHE_WRITES.incrementAndGet() & 31) != 0) return;
        pruneArtCache(getFilesDir(), ART_CACHE_MAX_BYTES, artCacheNamespace());
    }

    /**
     * Deletes fetched-art cache files until the tree fits under maxBytes (or is empty): the bytes of
     * a FOREIGN namespace (an orphan from an earlier manifest hash) go first, and only then the
     * oldest files of the active one. Without that order the cap could delete the art the page is
     * using while dead bytes from an older release still held the space — fetch/prune/fetch churn,
     * i.e. the same endless re-download the namespace adoption exists to stop.
     */
    private static void pruneArtCache(File filesDir, long maxBytes, String currentNamespace) {
        File root = new File(filesDir, ArtCdn.CACHE_DIR);
        if (!root.isDirectory()) return;
        java.util.List<File> files = new java.util.ArrayList<>();
        long[] total = {0};
        collectArtFiles(root, files, total);
        if (total[0] <= maxBytes) return;
        final java.nio.file.Path rootPath = root.toPath();
        files.sort((x, y) -> {
            int rx = ArtCdn.pruneRank(relOfCache(rootPath, x), currentNamespace);
            int ry = ArtCdn.pruneRank(relOfCache(rootPath, y), currentNamespace);
            if (rx != ry) return rx - ry; // 0 (foreign/orphan) is evicted before 1 (active)
            return Long.compare(x.lastModified(), y.lastModified());
        });
        for (File f : files) {
            if (total[0] <= maxBytes) break;
            long sz = f.length();
            boolean active = ArtCdn.pruneRank(relOfCache(rootPath, f), currentNamespace) == 1;
            //noinspection ResultOfMethodCallIgnored
            if (f.delete()) {
                total[0] -= sz;
                // O(1): a deleted file of the ACTIVE namespace leaves the counter set (foreign bytes
                // were never counted). See ArtCacheStats.
                if (active) ArtCdn.cacheStats().onDelete(sz);
            }
        }
    }

    /** A file's path relative to art/cache, in slash form ("" when it cannot be computed). */
    private static String relOfCache(java.nio.file.Path root, File f) {
        try {
            return root.relativize(f.toPath()).toString().replace('\\', '/');
        } catch (Exception e) {
            return "";
        }
    }

    private static void collectArtFiles(File dir, java.util.List<File> out, long[] total) {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            if (k.isDirectory()) collectArtFiles(k, out, total);
            else {
                out.add(k);
                total[0] += k.length();
            }
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
    // JS bridge
    // ------------------------------------------------------------------

    private class ShellBridge {
        @JavascriptInterface
        public void checkUpdate() {
            main.post(MainActivity.this::checkForUpdate);
        }

        /**
         * 服务器配置（§7）：当前 origin 的声明式配置快照，JSON 字符串。
         * <p>字段与 {@link ServerConfig} 对应；**没有可用配置时返回 "{}"**（不是 null、不是异常）——
         * 页面把空对象当「服务器没声明任何东西」处理，行为与没有这个特性时逐字相同。
         * 纯内存读取（快照由 ServerConfigHub 在进页面/切服/TTL 到期时刷新），因此可以在桥线程同步返回。
         */
        @JavascriptInterface
        public String serverConfig() {
            ServerConfig cfg = ServerConfigHub.current();
            return cfg == null ? "{}" : serverConfigJson(cfg);
        }

        /** 请求一次异步刷新（面板「刷新」按钮）；立刻返回，结果通过 CC 事件推给页面。 */
        @JavascriptInterface
        public void serverConfigRefresh() {
            ServerConfigHub.refreshAsync(origin);
        }

        @JavascriptInterface
        public void pickServer() {
            main.post(() -> openPanelJs("servers"));
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

        /**
         * 素材热更（P0）：拉验签清单 → ArtStore 安装缺失的包 → JSON
         * {@code {ok, version, installed:[...], failed:[...], error?}}。桥线程上同步阻塞（网络超时沿用
         * Updater 既有值）；任何异常都返回 JSON，绝不抛（页面拿到的是结果而不是崩溃）。
         */
        @JavascriptInterface
        public String syncArt() {
            return runArtSync();
        }

        /**
         * 素材状态：{@code {version, packs:[{id, sha256, installed}]}}。version 是设备记录值
         * （filesDir/art/art.json），packs 来自当前验签清单；清单不可达时 packs 为空、version 照常。
         */
        @JavascriptInterface
        public String artStatus() {
            File artRoot = ArtStore.rootOf(getFilesDir());
            try {
                org.json.JSONObject out = new org.json.JSONObject();
                out.put("version", ArtStore.recordedVersion(artRoot));
                org.json.JSONArray arr = new org.json.JSONArray();
                Updater.Manifest m = Updater.fetchManifest(MainActivity.this);
                if (m != null) {
                    manifestArtVersion = m.artVersion;
                    for (ArtStore.Pack p : m.artPacks) {
                        org.json.JSONObject o = new org.json.JSONObject();
                        o.put("id", p.id);
                        o.put("sha256", p.sha256);
                        o.put("installed", ArtStore.installedAt(artRoot, p));
                        arr.put(o);
                    }
                }
                out.put("packs", arr);
                return out.toString();
            } catch (Throwable t) {
                return "{\"version\":" + ArtStore.recordedVersion(artRoot) + ",\"packs\":[]}";
            }
        }

        /**
         * 素材缓存实况（feat/art-cache-status）：页面此前只能看到 art-prefetch.js 的 done（把「本地
         * 已有」和「已从 CDN 取回」混在一起），问不到壳侧磁盘上到底缓存了多少。这里回吐壳侧真实计数：
         * {@code {ok,manifestHash,cachedFiles,cachedBytes,cacheRoot,pending}}。
         * <p><b>O(1)</b>：只读 {@link ArtCacheStats} 的内存计数器（写入时累加、启动时后台对账一次），
         * 绝不递归扫缓存树。口径只覆盖当前清单 hash 的 {@code art/cache/<hash>}（排除 .part/临时件），
         * **从不**把 {@code art/packs/**} 的已验签内容算进来。pending 恒为 -1 —— 诚实：manifest 的
         * 覆盖情况页面自己就能算，壳侧不便宜，绝不编造数字。任何失败返回
         * {@code {"ok":false,"error":…}}，绝不把异常抛进页面。
         */
        @JavascriptInterface
        public String artCacheStatus() {
            try {
                String hash = artCacheNamespace();
                ArtCacheStats stats = artCacheStats();
                ensureArtCacheReconcile();
                return ArtCacheStats.statusJson(hash, ArtCdn.cacheRootForHash(hash),
                        stats.files(), stats.bytes(), -1L);
            } catch (Throwable t) {
                return ArtCacheStats.errorJson(String.valueOf(t));
            }
        }

        /**
         * 素材包通道（首次装包 / 素材热更）的实时状态：业主 2026-10-09 口径「预载进度要显示下载速度、
         * 解压速度、预载速度」里，**包通道**那一半的读数（文件通道那半由 art-prefetch.js 自己量）。
         * 返回 {@code {ok,active,stage,pack,packsDone,packsTotal,conns,bytesDone,bytesTotal,dlBps,
         * unzipBps,etaMs,elapsedMs}}；{@code etaMs=-1} = 算不出。
         * <p><b>O(1)</b>：只读 {@link ArtSyncStats} 的 volatile 字段，绝不碰文件系统、绝不等锁 IO。
         * 没有包在装时返回 {@code active:false} 的读数（页面据此不画那两行），绝不编造速度。
         */
        @JavascriptInterface
        public String artSyncStatus() {
            try {
                return ArtSyncStats.liveJson();
            } catch (Throwable t) {
                return ArtCacheStats.errorJson(String.valueOf(t));
            }
        }

        /**
         * 预载游标的 shell 侧存储（审计 2026-10-09 附加 A：**切换服务器不再重复预载**）。
         *
         * <p>页面侧原本把游标存在 {@code localStorage} 里，而 localStorage **按 origin 隔离**，页面的
         * origin 就是当前连接的服务器 —— 切服 = 换 origin = 游标不可见 = 7969 条从头再走一遍（芯片从 0
         * 重数、owed 列表丢失）。这里把同一份记录存到 {@code filesDir/art/walk-v1.json}（与
         * player-data 的 {@code spData} 同一思路：文件是真源、桥是同步读写），跨 origin 可见。
         *
         * <p>壳侧**不解释**这段 JSON（它是页面自己的游标格式），只做大小上限与原子写。读不到返回空串、
         * 写失败返回 false，页面侧照旧退回 localStorage —— 功能在任何情况下都不会消失。
         */
        @JavascriptInterface
        public String artWalkGet() {
            try {
                File f = new File(getFilesDir(), ART_WALK_FILE);
                if (!f.isFile() || f.length() <= 0L || f.length() > ART_WALK_MAX_BYTES) return "";
                try (InputStream in = new FileInputStream(f)) {
                    java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream((int) f.length());
                    byte[] buf = new byte[16 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                    return bos.toString("UTF-8");
                }
            } catch (Throwable t) {
                return "";
            }
        }

        /** {@link #artWalkGet()} 的写侧：整段替换、原子落盘（tmp → rename）。 */
        @JavascriptInterface
        public boolean artWalkPut(String json) {
            if (json == null) return false;
            try {
                byte[] bytes = json.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                if (bytes.length == 0 || bytes.length > ART_WALK_MAX_BYTES) return false;
                File f = new File(getFilesDir(), ART_WALK_FILE);
                File dir = f.getParentFile();
                if (dir != null && !dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) return false;
                File tmp = new File(dir, f.getName() + ".tmp");
                try (java.io.FileOutputStream out = new java.io.FileOutputStream(tmp)) {
                    out.write(bytes);
                }
                if (!tmp.renameTo(f)) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                    if (!tmp.renameTo(f)) {
                        //noinspection ResultOfMethodCallIgnored
                        tmp.delete();
                        return false;
                    }
                }
                return true;
            } catch (Throwable t) {
                return false;
            }
        }

        /**
         * 清除已取回的素材缓存（feat/art-cache-status）：只删 {@code filesDir/art/cache/**}，**绝不**
         * 碰 {@code filesDir/art/packs/**}（签名清单覆盖、装包时 sha256 校验过的内容）或
         * {@code filesDir/webroot}。返回
         * {@code {ok,removedFiles,removedBytes,keptPacks:true[,"error"]}}；中途失败也把已删数量带回。
         */
        @JavascriptInterface
        public String clearArtCache() {
            try {
                ArtCacheStats stats = artCacheStats();
                ArtCacheStats.ClearResult r = stats.clear(new File(getFilesDir(), ArtCdn.CACHE_DIR));
                return ArtCacheStats.clearJson(r.ok, r.files, r.bytes, r.error);
            } catch (Throwable t) {
                return ArtCacheStats.clearJson(false, 0, 0, String.valueOf(t));
            }
        }

        @JavascriptInterface
        public void logJsError(String msg) {
            appendDiagLog("js", msg == null ? "" : msg);
        }

        @JavascriptInterface
        public String currentServer() {
            return origin;
        }

        /**
         * The signed-list id of the currently connected server (room-observer reporting uses it;
         * URLs never leave the shell). The offline host reports as sp-phone-host — it has no entry
         * with a 127.0.0.1 URL in the list, but its Node publishes presence under that id.
         */
        @JavascriptInterface
        public String currentServerId() {
            if (originHost != null && (originHost.equals("127.0.0.1") || originHost.equals("::1"))) {
                return "sp-phone-host"; // must match NodeRunner's SP_SERVER_ID
            }
            ServerList.Snapshot snap = serverSnapshot;
            if (snap == null || originHost == null) return "";
            for (ServerList.Entry e : snap.entries) {
                if (originHost.equalsIgnoreCase(hostOf(e.url))) return e.id;
            }
            return "";
        }

        /** 服务器面板的数据源：三行（自动线路 / 离线服务 / 自定义线路）；域名一律不出现。
         *  No network on this path: the probe here was a field NetworkOnMainThreadException, and
         *  the bridge thread must not block on HTTP either — readiness comes from the service +
         *  handshake state (see localServiceReady()). */
        @JavascriptInterface
        public String getServers() {
            try {
                boolean localUp = HostService.isUp() && HostService.isReady();
                org.json.JSONArray arr = new org.json.JSONArray();
                arr.put(serverEntry("auto", "自动线路", "", "测速选最优"));
                arr.put(serverEntry("local", "离线服务",
                        "http://127.0.0.1:" + HostService.PORT,
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
         *
         * Room-scoped entries (CF Workers deployments, roomScoped=true) are filtered out here: the
         * decision is that they never appear in the panel/lobby list. This hides display only —
         * ServerList still annotates/probes them, and the invite-code path (resolveInvite →
         * joinOnOrigin) can still reach them (see ServerList.Entry#roomScoped).
         */
        @JavascriptInterface
        public String getServerList() {
            ServerList.Snapshot snap = serverSnapshot;
            try {
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("source", snap == null ? "载入中" : snap.source);
                // the signed list's own updated stamp ("2026-…Z" or "") so the panel can show freshness
                o.put("updated", snap == null ? "" : snap.updated);
                o.put("loading", serverListLoading.get());
                o.put("localProtocol", ServerList.localProtocol(MainActivity.this));
                o.put("localApp", ServerList.localApp(MainActivity.this));
                org.json.JSONArray all = snap == null
                        ? new org.json.JSONArray()
                        : new org.json.JSONArray(ServerList.toPanelJson(snap.entries));
                // 房间制（CF Workers）条目不出现在列表：跳过；其余条目在此打上只读标注。
                // annotate with the per-host remote-client flag; the url itself never reaches the page
                org.json.JSONArray arr = new org.json.JSONArray();
                for (int i = 0; i < all.length(); i++) {
                    org.json.JSONObject item = all.getJSONObject(i);
                    if (item.optBoolean("roomScoped", false)) continue; // never listed
                    String host = hostOfEntry(item.optString("id", ""));
                    item.put("remoteClient", host != null && remoteClientFor(host));
                    String id = item.optString("id", "");
                    item.put("current", !id.isEmpty() && id.equals(currentServerId()));
                    arr.put(item);
                }
                o.put("entries", arr);
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        /**
         * 面板手动刷新（SWR 桥，审计 §2）：只跑段 2（强制远端重拉 + 探测 + 二次 push）——缓存段
         * 在冷启动 reloadServerList 里已经跑过，手动刷新不必再吃一遍探测延迟。CAS 状态机兼容：
         * 刷新期间 getServerList() 的 loading=true 一直挂到二次 push 完成；失败时缓存快照保留。
         */
        @JavascriptInterface
        public void refreshServerList() {
            reloadServerList(true, false);
        }

        /** Kept as a no-op for hot-updated trees that still call it (v3.3: consent gate removed). */
        @JavascriptInterface
        public void clearConsent() {
        }

        /** 复制文本到剪贴板（页面「复制」按钮）；null → 空串，>200KB 拒绝并提示。 */
        @JavascriptInterface
        public void copyText(String s) {
            final String text = s == null ? "" : s;
            if (text.length() > 200 * 1024) {
                main.post(() -> toast("内容过大，未复制"));
                return;
            }
            main.post(() -> {
                copyToClipboard("shell", text);
                toast("已复制");
            });
        }

        /** 读取剪贴板文本；无内容 / 不可读（如应用不在前台）时返回 ""。 */
        @JavascriptInterface
        public String readClipboard() {
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null || !cm.hasPrimaryClip()) return "";
                ClipData clip = cm.getPrimaryClip();
                if (clip == null || clip.getItemCount() == 0) return "";
                CharSequence cs = clip.getItemAt(0).coerceToText(MainActivity.this);
                return cs == null ? "" : cs.toString();
            } catch (Exception e) {
                return "";
            }
        }

        /** 启动本机房主服务并切到本地线路（复用 ensureHostAndSwitch，线程安全）。 */
        @JavascriptInterface
        public void startLocalService() {
            main.post(() -> {
                if (!HostService.isUp()) toast("本地服务启动中…");
                ensureHostAndSwitch();
            });
        }

        /** 本地服务是否已就绪；不发任何网络请求（service + handshake 状态判断）。 */
        @JavascriptInterface
        public String localServiceReady() {
            return (HostService.isUp() && HostService.isReady()) ? "1" : "0";
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
                            if (byId == null) {
                                // room-scoped servers need the explicit「使用对方客户端进入」button;
                                // tapping the row never flips that flag by itself (v2.7.0 decision)
                                if (isRoomScoped(target)) toast("该服务器为房间制，请点「使用对方客户端进入」");
                                return;
                            }
                            url = byId;
                        }
                }
                applyOrigin(url);
            });
        }

        /** Resolves a signed-list entry id to a joinable URL; null when unknown or incompatible. */
        private String lookupServerUrl(String id) {
            ServerList.Entry e = findEntry(id);
            return e != null && e.joinable() ? e.url : null;
        }

        /** True when the entry is a room-scoped deployment (joinable only through its own client). */
        private boolean isRoomScoped(String id) {
            ServerList.Entry e = findEntry(id);
            return e != null && e.roomScoped;
        }

        private ServerList.Entry findEntry(String id) {
            ServerList.Snapshot snap = serverSnapshot;
            if (snap == null || id == null) return null;
            for (ServerList.Entry e : snap.entries) {
                if (id.equals(e.id)) return e;
            }
            return null;
        }

        /** The entry's host — used internally for the remote-client flag; never sent to the page. */
        private String hostOfEntry(String id) {
            ServerList.Entry e = findEntry(id);
            return e == null ? null : hostOf(e.url);
        }

        /** 房间制服务器：改用/停用对方客户端加载（开启时会记下第三方内容授权）。 */
        @JavascriptInterface
        public void useRemoteClient(String id, boolean on) {
            main.post(() -> {
                ServerList.Entry e = findEntry(id);
                if (e == null) return;
                String h = hostOf(e.url);
                setRemoteClient(h, on);
                if (on) {
                    applyOrigin(e.url);
                } else if (h != null && h.equalsIgnoreCase(originHost)) {
                    web.reload();
                }
                toast(on ? "已改用对方客户端加载" : "已改回本地客户端");
            });
        }

        /**
         * 当前 host 实际生效的界面来源：{@code "1"} = 服务端自带界面，{@code "0"} = 本地客户端。
         * <p>页面用两件事都靠它：① 设置/服务器面板显示「当前实际使用」的**权威**值（拦截器读的
         * 就是 {@link MainActivity#remoteClientFor}）；② 它的**存在**本身就是「这个 APK 有原生
         * 退出口（{@link MainActivity#showShellMenu} 的「回到本地客户端」）」的能力标记 ——
         * shell-bridge.js 据此置 {@code __SP_SHELL.remoteClientEscape}，旧 APK 上页面只允许
         * 「关」不允许「开」（否则用户会把自己锁在服务器页里）。**绝不能**在不提供退出口时加它。
         */
        @JavascriptInterface
        public String remoteClientCurrent() {
            String h = originHost;
            return (h != null && remoteClientFor(h)) ? "1" : "0";
        }

        /**
         * 设置里的「界面来源」开关把全局默认值交给拦截器：写 {@code remote-client-default}。
         * 只影响**没有**被显式设置过的 host（逐 host 偏好永远优先，见
         * {@link MainActivity#remoteClientFor}）。页面按 {@code typeof} 探测本方法是否存在。
         */
        @JavascriptInterface
        public void setRemoteClientDefault(boolean on) {
            prefs.edit().putBoolean(RemoteClientPolicy.PREF_DEFAULT, on).apply();
        }

        /**
         * 外壳能力探测（页面按 {@code typeof} 调用，老 APK 没有这个方法 → undefined）。
         *
         * <p>返回值 = 本 APK 的「服务端界面」语义版本：
         * <ul>
         *   <li><b>缺方法</b>（vc2006–vc2008）：那时**没有首页作用域门**，Java 缺省是「服务端界面」，
         *       冷启动第一屏会是别人的首页 —— 所以内容侧要把它下推成 {@code false}（本地客户端优先）。</li>
         *   <li><b>&gt;= 2</b>（本版起）：有首页作用域门（首页恒本地，见
         *       {@link RemoteClientPolicy#scopeAllows}），缺省 {@code true} 表达的已经是
         *       「首页之外按服务器」而不是「整站按服务器」→ 内容侧**不再**下推任何默认值，
         *       否则会把业主 2026-10-09 的口径（连接服务器时其他 ui 按服务器正常显示）按回本地。</li>
         * </ul>
         */
        @JavascriptInterface
        public int remoteClientSemantics() {
            return 2;
        }

        /**
         * 跨服邀请码（v2.7.2 Discovery Plane）：目录只回答「哪台服务器有此房号的房」（serverId），
         * URL 由签名清单解析——目录被篡改也无法指向任意地址。候选按目录记录的新鲜度排序。
         * 返回 JSON 数组 [{id,name,rttMs,humans}]（无 URL），页面选择后调 joinOnOrigin。
         *
         * v3.7：① 遍历所有目录（不再首个即停），按 observedAt 合并取最新；② 目录无结果时，对签名
         * 清单内 joinable() 的服务器并发探测 &lt;origin&gt;/api/rooms（限并发 6、单站 3s、整体 ≤8s），
         * 命中该 code 即并入候选。运行在 JS bridge 工作线程，绝不触碰 UI 线程。
         */
        @JavascriptInterface
        public String resolveInvite(String code) {
            final String c = code == null ? "" : code.trim().toUpperCase(Locale.ROOT);
            if (!c.matches("[A-HJ-NP-Z]{4}")) return "[]";
            try {
                org.json.JSONArray out = new org.json.JSONArray();
                ServerList.Snapshot snap = serverSnapshot;
                final long deadline = System.currentTimeMillis() + INVITE_TOTAL_BUDGET_MS;
                if (snap != null) {
                    java.util.Map<String, ServerList.Entry> byId = indexById(snap);
                    // ---- discovery layers, merged: ① server presence（遍历所有目录，按 observedAt 取最新）
                    java.util.Map<String, Long> candidates = new java.util.LinkedHashMap<>();
                    for (String dir : ShellConfig.load(MainActivity.this).directoryUrls()) {
                        long now = System.currentTimeMillis();
                        if (now >= deadline) break; // 总预算耗尽：返回已得结果
                        int t = (int) Math.max(500L, Math.min(4000L, deadline - now));
                        JSONObject r = presenceLookup(dir, c, t);
                        if (r == null) continue;
                        org.json.JSONArray servers = r.optJSONArray("servers");
                        if (servers == null) continue;
                        for (int i = 0; i < servers.length(); i++) {
                            JSONObject s = servers.optJSONObject(i);
                            if (s == null) continue;
                            String serverId = s.optString("serverId", "");
                            long observedAt = s.optLong("observedAt", 0L);
                            if (!serverId.isEmpty() && byId.containsKey(serverId)
                                    && observedAt > candidates.getOrDefault(serverId, 0L)) {
                                candidates.put(serverId, observedAt);
                            }
                        }
                    }
                    // ---- ② 目录无结果 → 并发探测签名清单内可加入服务器的 /api/rooms
                    if (candidates.isEmpty()) {
                        probeRoomsForCode(snap.entries, byId, c, candidates, deadline);
                    }
                    // ---- signed-list validation: unknown ids are ignored, never guessed at
                    for (java.util.Map.Entry<String, Long> e : candidates.entrySet()) {
                        ServerList.Entry entry = byId.get(e.getKey());
                        if (entry != null && entry.joinable()) {
                            out.put(candidate(entry, System.currentTimeMillis() - e.getValue()));
                        }
                    }
                }
                // ---- ③ 局域网兜底（审计 PR#23 两条中优先级）：判定必须看「验证后真正可加入的候选」，
                // 不能看原始 candidates 是否为空 —— 目录可能返回一堆不在签名清单或不可加入的条目，
                // 那样会把本来能进的局域网房间挡掉；清单尚未就绪（snap == null）时也必须照常扫描。
                // 预算取「总预算的剩余量」而不是另开 3s：本方法是同步 JS 桥，超支会阻塞调用方。
                if (out.length() == 0 && lanCapablePage()) {
                    long left = deadline - System.currentTimeMillis();
                    if (left >= 800L) addLanCandidates(out, c, (int) Math.min(3000L, left));
                }
                return out.toString();
            } catch (Exception e) {
                return "[]";
            }
        }

        private java.util.Map<String, ServerList.Entry> indexById(ServerList.Snapshot snap) {
            java.util.Map<String, ServerList.Entry> m = new java.util.HashMap<>();
            for (ServerList.Entry e : snap.entries) m.put(e.id, e);
            return m;
        }

        /**
         * 目录无结果时的兜底：对签名清单内 joinable() 的服务器并发 GET &lt;origin&gt;/api/rooms，解析出
         * 含该 code 的条目即并入候选。限并发 {@link #INVITE_PROBE_CONCURRENCY}、单站
         * {@link #INVITE_PROBE_TIMEOUT_MS}，整体受 deadline 约束（超时即返回已得结果）。
         */
        private void probeRoomsForCode(List<ServerList.Entry> entries,
                java.util.Map<String, ServerList.Entry> byId, String code,
                java.util.Map<String, Long> candidates, long deadline) {
            List<ServerList.Entry> targets = new ArrayList<>();
            java.util.Set<String> seenUrls = new java.util.HashSet<>();
            for (ServerList.Entry e : entries) {
                if (e == null || !e.joinable()) continue;
                if (e.url.isEmpty() || !seenUrls.add(e.url)) continue; // 同一 URL 只探一次
                targets.add(e);
            }
            if (targets.isEmpty()) return;
            java.util.concurrent.ExecutorService pool =
                    java.util.concurrent.Executors.newFixedThreadPool(INVITE_PROBE_CONCURRENCY);
            try {
                List<java.util.concurrent.Future<String>> futures = new ArrayList<>();
                for (ServerList.Entry e : targets) {
                    futures.add(pool.submit(() -> roomsContainCode(e.url, code)));
                }
                for (int i = 0; i < futures.size(); i++) {
                    long left = deadline - System.currentTimeMillis();
                    if (left <= 0) break;
                    String serverId;
                    try {
                        serverId = futures.get(i).get(left, java.util.concurrent.TimeUnit.MILLISECONDS);
                    } catch (Exception ex) {
                        continue; // 超时/失败 → 跳过该站
                    }
                    if (serverId == null) continue; // 该站牌面未命中
                    // 房间牌条目自带 serverId（聚合牌可能指向别站）：优先按它映射签名清单条目，
                    // 无/未知时回落到被探测站点自身。
                    String id = byId.containsKey(serverId) ? serverId : targets.get(i).id;
                    if (byId.containsKey(id)) candidates.put(id, System.currentTimeMillis());
                }
            } finally {
                pool.shutdownNow();
            }
        }

        /**
         * GET &lt;origin&gt;/api/rooms，返回牌面中命中该 code 的条目的 serverId（可能为 ""）；未命中/失败
         * 返回 null。响应形如 { ok, now, ttlSec, rooms:[{code, serverId, ...}] }（rainya 契约）。
         */
        private String roomsContainCode(String origin, String code) {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(origin.replaceAll("/+$", "") + "/api/rooms").openConnection();
                conn.setConnectTimeout(INVITE_PROBE_TIMEOUT_MS);
                conn.setReadTimeout(INVITE_PROBE_TIMEOUT_MS);
                conn.setRequestProperty("Accept", "application/json");
                conn.setRequestProperty("User-Agent", "stronghold-shell");
                if (conn.getResponseCode() != 200) return null;
                JSONObject doc = new JSONObject(ServerList.readAll(conn.getInputStream()));
                org.json.JSONArray rooms = doc.optJSONArray("rooms");
                if (rooms == null) return null;
                for (int i = 0; i < rooms.length(); i++) {
                    JSONObject room = rooms.optJSONObject(i);
                    if (room == null) continue;
                    if (code.equalsIgnoreCase(room.optString("code", ""))) {
                        return room.optString("serverId", "");
                    }
                }
                return null;
            } catch (Exception e) {
                return null;
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        /** One GET {dir}/presence/<code>; null on any failure/absence (no redirects followed). */
        private JSONObject presenceLookup(String dir, String code, int timeoutMs) {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(dir.replaceAll("/+$", "") + "/presence/" + code).openConnection();
                conn.setConnectTimeout(timeoutMs);
                conn.setReadTimeout(timeoutMs);
                conn.setRequestProperty("Accept", "application/json");
                conn.setRequestProperty("User-Agent", "stronghold-shell");
                if (conn.getResponseCode() != 200) return null;
                return new JSONObject(ServerList.readAll(conn.getInputStream()));
            } catch (Exception e) {
                return null;
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        private org.json.JSONObject candidate(ServerList.Entry e, long ageMs) throws Exception {
            return new org.json.JSONObject()
                    .put("id", e.id)
                    .put("name", e.name)
                    .put("rttMs", e.rttMs)
                    .put("humans", e.humans)
                    .put("ageMs", ageMs);
        }

        /**
         * 第③层局域网发现（审计 2026-10-05）：前两层（目录 presence / 清单探测）都没命中时，扫本机
         * 私网 /24 的发现端口找同网段房主。预算 3s（LanScan 内部封顶），失败/未命中静默返回——绝不
         * 让「局域网不可用」拖慢或打断跨服查找。
         * <p>id 形如 {@code lan:<ip>:<port>}，由 joinOnOrigin 解析回 URL；URL 只在本机扫描结果里
         * 产生，页面既拿不到也传不进任意地址。
         */
        private void addLanCandidates(org.json.JSONArray out, String code, int budgetMs) {
            try {
                JSONObject doc = new JSONObject(LanScan.scanCode(code, budgetMs));
                org.json.JSONArray rooms = doc.optJSONArray("rooms");
                for (int i = 0; rooms != null && i < rooms.length(); i++) {
                    JSONObject room = rooms.optJSONObject(i);
                    if (room == null) continue;
                    String ip = room.optString("ip", "");
                    int port = room.optInt("port", 0);
                    if (ip.isEmpty() || port < 1024 || port > 65535) continue;
                    String name = room.optString("name", "");
                    out.put(new org.json.JSONObject()
                            .put("id", "lan:" + ip + ":" + port)
                            .put("name", "局域网" + (name.isEmpty() ? "" : "：" + name))
                            .put("rttMs", -1)
                            .put("humans", room.optInt("humans", -1))
                            .put("url", "http://" + ip + ":" + port));
                }
            } catch (Exception ignored) {
                // 局域网不可用：保持原结果，不报错
            }
        }

    /**
     * 跨服邀请码：切到清单内指定 id 的服务器并带上 ?room=CODE（页面的 pendingJoin 机制
     * 会自动完成加入）。origin 必须来自签名清单，页面拿不到裸地址。
     * <p>第③层局域网发现的 {@code lan:<ip>:<port>} 候选同样经此进入：URL 由本机扫描结果推导，
     * 只认私网 IPv4 + 合法端口（见 {@link #lanEntryUrl}），桥因此无法被页面当作任意地址跳板。
     */
    @JavascriptInterface
    public boolean joinOnOrigin(String id, String code) {
        if (code == null || !code.matches("(?i)[A-HJ-NP-Z]{4}")) return false;
        final String c = code.toUpperCase(Locale.ROOT);
        if (id != null && id.startsWith("lan:")) {
            // 审计 PR#23（高）：第三方页面不得用 lan: id 把应用导向内网主机。
            if (!lanCapablePage()) return false;
            final String url = lanEntryUrl(id);
            if (url == null) return false;
            main.post(() -> {
                onlineMode = false;
                dcConfig = null;
                armAutostart();
                // 审计 PR#23（中）：局域网房主地址是**临时**加入目标，不能像切服那样持久化 ——
                // loadBase 会把 http://192.168.x.x:port 写进 origin 偏好，下次冷启动就去连一个
                // 早已失效的内网地址。这里照 resolveAndJoin 的做法：只更新内存 origin/host。
                String target = withRoom(url, c);
                origin = stripRoom(url);
                originHost = hostOf(origin);
                pageServedFromLocalTree = false;
                historyClearPending = true;
                joinFallbackBase = url;
                joinFallbackCode = c;
                joinFallbackStep = 0;
                joinFallbackAt = System.currentTimeMillis();
                joinFallbackLoading = target;
                web.loadUrl(target);
            });
            return true;
        }
        ServerList.Entry e = findEntry(id);
        if (e == null || !e.joinable()) return false;
        main.post(() -> {
            // 只做一次路径保真的导航：withRoom 已保证 /play → /play?room=X（不再先落 /play/）。
            String target = withRoom(e.url, c);
            // 与旧 applyOrigin(e.url) 一致：进入他服前清掉在线/DC 状态（loadBase 持久化具体
            // 地址——邀请码加入是用户在面板里的显式选择，属正常切服，不属 A2 失败兜底）。
            onlineMode = false;
            dcConfig = null;
            // 自动进入：任何走此方法的加入路径（大厅面板、游戏大厅页、公开房间）都布防 autostart，
            // 切服重载后由标题页 takeAutostart() 消费一次即自动 start()。
            armAutostart();
            // 进入「加入房间导航」窗口：若主帧 404，onReceivedHttpError 会按候选序兜底重载。
            joinFallbackBase = e.url;
            joinFallbackCode = c;
            joinFallbackStep = 0;
            joinFallbackAt = System.currentTimeMillis();
            joinFallbackLoading = target;
            loadBase(target);
        });
        return true;
    }

        /**
         * 解析局域网候选 id（{@code lan:<ipv4>:<port>}）为 URL；格式/范围不合法、或该端点
         * <b>不是本进程扫描真实发现过的</b>主机时返回 null。
         * <p>审计 PR#23 高优先级：只校验「私网 IPv4 + 合法端口」是不够的 —— 页面可以伪造
         * {@code lan:192.168.1.1:8080} 让应用去请求任意内网服务。因此必须同时命中
         * {@link LanScan#isDiscovered}（近期扫描真实应答过的主机），页面拿不到也编不出这种 id。
         */
        private String lanEntryUrl(String id) {
            String[] parts = id.split(":");
            if (parts.length != 3 || !"lan".equals(parts[0])) return null;
            int port;
            try {
                port = Integer.parseInt(parts[2]);
            } catch (Exception e) {
                return null;
            }
            if (port < 1024 || port > 65535) return null;
            if (!isPrivateIpv4(parts[1])) return null;
            if (!LanScan.isDiscovered(parts[1], port)) return null;
            return "http://" + parts[1] + ":" + port;
        }

        /**
         * 局域网能力（扫描 / 邀请码的局域网层 / {@code lan:} 加入）只对「本机服务页面」与
         * 「签名清单内的官方服务器页面」开放。
         * <p>审计 PR#23 高优先级：第三方服务器的页面内容在用户同意免责声明后是允许加载的，
         * 但全局 {@code shell} 桥对它同样可见 —— 不设边界的话，一个第三方页面就能枚举用户内网
         * 并让应用向内网主机发起请求。这里按「当前页面 host」判定，未列入清单一律不给局域网能力。
         */
        private boolean lanCapablePage() {
            String h = originHost;
            if (h == null || h.isEmpty()) return false;
            if (h.equals("127.0.0.1") || h.equals("localhost") || h.equals("::1") || h.equals("[::1]")) return true;
            ServerList.Snapshot snap = serverSnapshot;
            if (snap != null) {
                for (ServerList.Entry e : snap.entries) {
                    if (e == null || e.url == null || e.url.isEmpty()) continue;
                    String eh = hostOf(e.url);
                    if (eh != null && eh.equalsIgnoreCase(h)) return true;
                }
            }
            return false;
        }

        /** 私网 IPv4 判定（site-local：10/8、172.16/12、192.168/16）。 */
        private boolean isPrivateIpv4(String ip) {
            String[] o = ip == null ? new String[0] : ip.split("\\.");
            if (o.length != 4) return false;
            int[] n = new int[4];
            for (int i = 0; i < 4; i++) {
                try {
                    n[i] = Integer.parseInt(o[i]);
                } catch (Exception e) {
                    return false;
                }
                if (n[i] < 0 || n[i] > 255) return false;
            }
            if (n[0] == 10) return true;
            if (n[0] == 192 && n[1] == 168) return true;
            return n[0] == 172 && n[1] >= 16 && n[1] <= 31;
        }

        /** 当前传输档位（lan/zt/v6/dc/auto）；页面设置面板读取。 */
        @JavascriptInterface
        public String getTransport() {
            return Transport.load(MainActivity.this);
        }

        /** 保存传输档位（非法值由 Transport 规范化为 auto）。 */
        @JavascriptInterface
        public void setTransport(String v) {
            Transport.save(MainActivity.this, v);
        }

        /**
         * 局域网扫描桥（内网发现）。必须后台线程：一轮要打 254 个 IP，绝不能阻塞 JS/UI 线程；
         * 结果在主线程经 evaluateJavascript 回调 {@code window.__SP_LAN.onFound(json)}（JSON 字符串
         * 用 JSONObject.quote 转义，页面 JSON.parse 即可）。立即返回 {"ok":true,"started":true}。
         * <p>mode=="code" 且 code 非空 → 按房号精确查找；否则扫全网段房间。目标 IP 由 LanScan
         * 从本机网卡私网前缀推导，本桥不接受任何 host/URL 入参。
         */
        @JavascriptInterface
        public String lanScan(String mode, String code) {
            // 审计 PR#23（高）：第三方页面不得调用内网扫描。
            if (!lanCapablePage()) return "{\"ok\":false,\"error\":\"not allowed\"}";
            final boolean byCode = "code".equals(mode) && code != null && !code.trim().isEmpty();
            final String c = byCode ? code.trim().toUpperCase(Locale.ROOT) : null;
            // 审计 PR#23（中）：结果必须能认领回**发起它的那次调用与那个页面** —— 用序号 + 发起时的
            // origin 做标签，页面导航走了或已经有更新的一轮扫描时，这次的结果直接丢弃（在 Java 侧
            // 丢弃，不把过期结果交给页面）。注意不要把 Java 的序号传给页面：页面的 __SP_LAN 有自己
            // 的计数器，两套序号混用会让页面把所有结果都当成过期而全部丢弃。
            final long seq = ++lanScanSeq;
            final String host = originHost;
            new Thread(() -> {
                String json = byCode ? LanScan.scanCode(c, 3000) : LanScan.scanRooms(350);
                main.post(() -> {
                    if (web == null) return;
                    if (seq != lanScanSeq) return;                       // 已被更新的一轮取代
                    if (host == null || !host.equalsIgnoreCase(originHost)) return; // 页面已导航走
                    String quoted;
                    try {
                        quoted = JSONObject.quote(json);
                    } catch (Exception e) {
                        quoted = "\"\"";
                    }
                    web.evaluateJavascript(
                            "window.__SP_LAN&&window.__SP_LAN.onFound(" + quoted + ")", null);
                });
            }, "shell-lan-scan").start();
            return "{\"ok\":true,\"started\":true}";
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

        /**
         * 线上服务→选服→自动进入的一次性桥（另一车道调用）：页面切服前 setAutostart()，重载/
         * 冷启动后由页面 takeAutostart() 消费。纯 prefs（"shell"），无网络、无 main.post。
         */
        @JavascriptInterface
        public void setAutostart() {
            prefs.edit().putBoolean("autostart", true).apply();
        }

        /** 读取并立即清除 autostart 标志；返回 "1"（已布防）/ "0"。 */
        @JavascriptInterface
        public String takeAutostart() {
            boolean armed = prefs.getBoolean("autostart", false);
            if (armed) {
                // synchronous clear (runs on the JS bridge thread, not main): once we report "1"
                // the flag is durably gone, so a process kill right after cannot re-trigger it
                //noinspection ResultOfMethodCallIgnored
                prefs.edit().remove("autostart").commit();
            }
            return armed ? "1" : "0";
        }

        /**
         * 提交服务器到站点（POST /api/servers/submit）。服务端才是最终校验方：App 只做「非空 +
         * 长度 + JSON 形状」的入参安全校验，并把响应体（含 4xx 的 {"ok":false,"error":"…"}）原样
         * 回传。仅 https、固定 host 白名单，逐跳校验重定向，拒绝环回/私网/保留地址；不附带任何
         * 凭据。运行在 WebView JavaBridge 工作线程（同 resolveInvite），绝不在主线程发网——防御性
         * 主线程守卫只记日志并拒绝，避免 StrictMode 崩溃。
         *
         * 纵深防御（审计 §4）：服务端对 serverId/serverName 不查主机，页面兜底 serverId=location.host
         * 会把 127.0.0.1 等私网地址当「服务器名」提交上来——payload 里任何 http(s) URL 形态的值
         * （字符串或嵌套对象/数组内的字符串）都过 isPublicHttpUrl 复核，私网/环回/NAT64/纯数字
         * 主机直接拒绝，不发出请求。
         */
        @JavascriptInterface
        public String submitServer(String json) {
            if (Looper.myLooper() == Looper.getMainLooper()) {
                appendDiagLog("submitServer", "on main thread (blocked)");
                return "{\"ok\":false,\"error\":\"网络不可用，请稍后重试\"}";
            }
            final String body = json == null ? "" : json;
            if (body.isEmpty() || body.getBytes(StandardCharsets.UTF_8).length > SUBMIT_MAX_BYTES) {
                return "{\"ok\":false,\"error\":\"提交内容为空或过大\"}";
            }
            try {
                // 只做形状检查（真正的服务器/URL 校验在站点侧）：一个带 servers 数组的对象，
                // 绝不让任意文本被 POST 到固定端点。
                org.json.JSONObject o = new org.json.JSONObject(body);
                if (o.optJSONArray("servers") == null) {
                    return "{\"ok\":false,\"error\":\"提交内容不合法\"}";
                }
                String bad = firstPrivateUrlIn(o);
                if (bad != null) {
                    appendDiagLog("submitServer", "private url rejected");
                    return org.json.JSONObject.quote(
                            "{\"ok\":false,\"error\":\"提交内容包含私网/本机地址，已拒绝\"}");
                }
            } catch (Exception e) {
                return "{\"ok\":false,\"error\":\"提交内容不合法\"}";
            }
            HttpURLConnection c = null;
            try {
                URL target = new URL(SUBMIT_ENDPOINT);
                byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                // manual redirects: every hop must stay on the pinned https host
                for (int hop = 0; hop < 4; hop++) {
                    if (!isAllowedSubmitUrl(target)) throw new IOException("submit host not allowed");
                    c = (HttpURLConnection) target.openConnection();
                    c.setInstanceFollowRedirects(false);
                    c.setConnectTimeout(SUBMIT_TIMEOUT_MS);
                    c.setReadTimeout(SUBMIT_TIMEOUT_MS);
                    c.setRequestMethod("POST");
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json");
                    c.setRequestProperty("Accept", "application/json");
                    c.setRequestProperty("User-Agent", "stronghold-shell");
                    try (java.io.OutputStream os = c.getOutputStream()) {
                        os.write(payload);
                        os.flush();
                    }
                    int code = c.getResponseCode();
                    if (code >= 300 && code < 400) {
                        String loc = c.getHeaderField("Location");
                        c.disconnect();
                        c = null;
                        if (loc == null || loc.isEmpty()) throw new IOException("redirect without location");
                        target = new URL(target, loc); // validated at the top of the next hop
                        continue;
                    }
                    String text;
                    try (InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream()) {
                        text = in == null ? "" : readAll(in);
                    }
                    c.disconnect();
                    c = null;
                    return text.isEmpty() ? "{\"ok\":false,\"error\":\"服务器无响应内容\"}" : text;
                }
                return "{\"ok\":false,\"error\":\"重定向过多\"}";
            } catch (Exception e) {
                return "{\"ok\":false,\"error\":\"网络不可用，请稍后重试\"}";
            } finally {
                if (c != null) c.disconnect();
            }
        }

        /** Fixed https host allow-list + no loopback/private/reserved host (defense in depth). */
        private boolean isAllowedSubmitUrl(URL u) {
            if (u == null || !"https".equalsIgnoreCase(u.getProtocol())) return false;
            String host = u.getHost();
            if (host == null) return false;
            host = host.toLowerCase(Locale.ROOT);
            return host.equals(SUBMIT_HOST) && !isPrivateOrReservedHost(host);
        }

        private boolean isPrivateOrReservedHost(String h) {
            if (h == null || h.isEmpty()) return true;
            if (h.equals("localhost") || h.equals("::1") || h.equals("0.0.0.0")) return true;
            if (h.endsWith(".local")) return true;
            if (h.startsWith("127.") || h.startsWith("10.") || h.startsWith("192.168.")
                    || h.startsWith("169.254.")) return true;
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("^172\\.(\\d{1,3})\\.").matcher(h);
            if (m.find()) {
                int n = Integer.parseInt(m.group(1));
                if (n >= 16 && n <= 31) return true;
            }
            return false;
        }

        /**
         * 纵深防御扫描（审计 §4）：递归找 payload 里第一个「http(s) URL 形态但 host 不是公网」的
         * 字符串值。只拒绝 URL 形态的值——普通句子里的 "127.0.0.1" 字样（备注/描述）不拦截，
         * 避免误伤正常文本；公网 URL 原样放行（站点侧仍会做完整校验）。无违规返回 null。
         */
        private String firstPrivateUrlIn(Object node) {
            if (node instanceof org.json.JSONObject) {
                org.json.JSONObject o = (org.json.JSONObject) node;
                java.util.Iterator<String> keys = o.keys();
                while (keys.hasNext()) {
                    String bad = firstPrivateUrlIn(o.opt(keys.next()));
                    if (bad != null) return bad;
                }
            } else if (node instanceof org.json.JSONArray) {
                org.json.JSONArray arr = (org.json.JSONArray) node;
                for (int i = 0; i < arr.length(); i++) {
                    String bad = firstPrivateUrlIn(arr.opt(i));
                    if (bad != null) return bad;
                }
            } else if (node instanceof String) {
                String s = (String) node;
                // http(s)://… 形态才校验（host 为空/解析失败 → isPublicHttpUrl=false → 拒绝）
                if (s.matches("(?i)^https?://\\S.*$") && !ServerList.isPublicHttpUrl(s.trim())) {
                    return s;
                }
            }
            return null;
        }
    }

    /**
     * SWR 两段管线（审计 §2）。段 1（缓存）：ServerList.loadCached（零网络）→ probeAll → rank →
     * serverSnapshot= → pushServerList()，面板立即出数据；段 2（远端）：ServerList.refreshRemote →
     * 成功则 probeAll → rank → serverSnapshot= → 二次 push，失败不覆盖缓存快照、只记 diag。
     * compareAndSet 保证单飞：面板 refreshServerList() 与冷启动 load 竞争时不会出现两份并行拉取。
     *
     * @param announce 面板手动刷新（true）时失败要可见（静默失败将无从诊断，用户要求失败必须能看见）；
     *                 冷启动（false）全程静默。
     */
    private void reloadServerList(boolean announce) {
        reloadServerList(announce, true);
    }

    /**
     * @param announce   失败提示/toast 语义（同上）
     * @param cachedPhase false = 只跑段 2（强制远端重拉，面板手动刷新路径）；true = 缓存段 + 远端段
     *                    （冷启动路径）。两段共用同一把 CAS 锁：整个管线期间 serverListLoading 为
     *                    true，面板 loading 态贯穿到二次 push 完成。
     */
    private void reloadServerList(boolean announce, boolean cachedPhase) {
        // compareAndSet, not a plain check: the panel's refreshServerList() can race the cold-start
        // load (two callers pass the check before either flips the flag → two concurrent loads).
        if (!serverListLoading.compareAndSet(false, true)) {
            // v2.9.2: 「服务器清单正在刷新…」提示 toast 已按用户要求移除（并发刷新静默返回）。
            return;
        }
        final Context app = getApplicationContext();
        new Thread(() -> {
            // ---- 段 1：缓存优先（零网络），先让面板出数据（审计 §2）----
            if (cachedPhase) {
                try {
                    ServerList.Snapshot snap = ServerList.loadCached(app);
                    ServerList.probeAll(app, snap.entries);
                    ServerList.rank(snap.entries);
                    serverSnapshot = snap;
                    main.post(() -> pushServerList()); // 缓存立即出
                } catch (Exception e) {
                    appendDiagLog("server list cache", String.valueOf(e));
                }
            }
            // ---- 段 2：远端重拉（成功 → 二次 push；失败 → 保留缓存快照）----
            boolean ok = false;
            try {
                ServerList.Snapshot remote = ServerList.refreshRemote(app);
                if (remote != null) {
                    ServerList.probeAll(app, remote.entries);
                    ServerList.rank(remote.entries);
                    serverSnapshot = remote; // 成功才覆盖；失败时缓存快照原地不动
                    ok = true;
                } else {
                    appendDiagLog("server list", "remote refresh failed, cached snapshot kept");
                }
            } catch (Exception e) {
                appendDiagLog("server list", String.valueOf(e));
            } finally {
                serverListLoading.set(false);
            }
            final boolean done = ok;
            main.post(() -> {
                if (announce && !done) {
                    // v2.9.2: 成功提示 toast 已按用户要求移除（面板内清单本身即反馈）。失败提示
                    // 刻意保留——静默失败将无从诊断，用户要求失败必须能看见。
                    toast("清单刷新失败，仍显示已有清单");
                }
                pushServerList(); // 段 2 成功的二次 push / 失败时确认性重推（缓存快照）
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

    /** Hot-switch/hot-reload: restart only the embedded host service, then refresh the page.
     *  v2.7.3: stop and start are TWO phases — we wait for onDestroy to actually run before
     *  starting again. Same-frame stop+start let the OLD instance's onDestroy kill the NEW node
     *  (30 s healthz timeout) and violate Android 12+ startForeground timing (process crash). */
    private void restartHostService() {
        toast("房主服务重启中…");
        stopService(new Intent(this, HostService.class));
        new Thread(() -> {
            // phase 1: wait for the old instance to fully tear down (onDestroy is synchronous;
            // give the system up to 3 s to deliver it)
            for (int i = 0; i < 6 && HostService.isUp(); i++) sleep(500);
            // phase 2: fresh start with a new generation token
            HostService.nextGeneration();
            startForegroundServiceCompat(new Intent(this, HostService.class));
            boolean up = false;
            for (int i = 0; i < 60 && !up; i++) { // 60 × 500ms = 30 s
                sleep(500);
                up = healthzOk("http://127.0.0.1:" + HostService.PORT + "/healthz");
            }
            final boolean ready = up;
            main.post(() -> {
                if (ready) {
                    loadBase(origin);
                }
                toast(ready ? "房主服务已重启" : "房主服务重启超时，请查看参数或重试");
            });
        }, "host-restart").start();
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    private static String hostOf(String origin) {
        String h = Uri.parse(origin).getHost();
        return h == null ? null : h.toLowerCase(Locale.ROOT);
    }

    /**
     * host 是否属于「已知服务器主机」：当前 origin、官方线路 host、签名清单内条目的 host。
     * 只用于「主帧本地优先」兜底，避免把真正的第三方页面也劫持成本地 index.html。
     */
    private boolean isKnownServerHost(String host) {
        if (host == null || host.isEmpty()) return false;
        if (originHost != null && originHost.equalsIgnoreCase(host)) return true;
        for (String o : lineOrigins()) {
            String h = hostOf(o);
            if (h != null && h.equalsIgnoreCase(host)) return true;
        }
        ServerList.Snapshot snap = serverSnapshot;
        if (snap != null) {
            for (ServerList.Entry e : snap.entries) {
                if (host.equalsIgnoreCase(e.host())) return true;
            }
        }
        return false;
    }

    /**
     * 给任意基础 URL 拼接房间码（路径/查询感知，审计 §3）：{@code /play → /play?room=X}、
     * 根 {@code → /?room=X}；保留原有 query（覆盖已有 room，绝不重复追加）；room 落在 {@code #}
     * 之前；裸 origin 补 "/"。绝不产生 {@code /play/?room=} 这类站点 404 地址。
     * {@code baseUrl} 为 null/空时返回 null，由调用方处理。
     */
    private static String withRoom(String baseUrl, String code) {
        if (baseUrl == null || baseUrl.isEmpty()) return null;
        Uri u = Uri.parse(baseUrl);
        String path = u.getPath();
        Uri.Builder b = u.buildUpon().query(null).fragment(null);
        if (path == null || path.isEmpty()) b.path("/");
        appendQueryExceptRoom(u, b);
        b.appendQueryParameter("room", code);
        if (u.getEncodedFragment() != null) b.fragment(u.getEncodedFragment());
        return b.build().toString();
    }

    /** 把 u 的全部 query 参数（除 room 外，room 由调用方决定）按序追加到 b。 */
    private static void appendQueryExceptRoom(Uri u, Uri.Builder b) {
        for (String name : u.getQueryParameterNames()) {
            if ("room".equals(name)) continue;
            List<String> vals = u.getQueryParameters(name);
            if (vals == null || vals.isEmpty()) b.appendQueryParameter(name, "");
            else for (String v : vals) b.appendQueryParameter(name, v);
        }
    }

    /** 加入房间兜底候选：1 = base 补 "/" 后再带 room；2 = 站点根 + room；其余 null。 */
    private static String joinCandidate(String base, String code, int step) {
        if (step == 1) return withRoom(ensureTrailingSlash(base), code);
        if (step == 2) {
            Uri u = Uri.parse(base);
            String root = u.buildUpon().path("/").query(null).fragment(null).build().toString();
            return withRoom(root, code);
        }
        return null;
    }

    /** base 的 path 补一个结尾 "/"（已带则原样）。 */
    private static String ensureTrailingSlash(String base) {
        if (base == null || base.isEmpty()) return base;
        Uri u = Uri.parse(base);
        String p = u.getPath();
        if (p != null && p.endsWith("/")) return base;
        return u.buildUpon().path((p == null ? "" : p) + "/").build().toString();
    }

    /** joinOnOrigin 布防序号：旧的延迟清除不得清掉更新的布防。 */
    private int autostartArmSeq = 0;
    /** 布防后多久兜底清除未被消费的 autostart 标志（应大于标题页挂载+400ms 的消费窗口）。 */
    private static final long AUTOSTART_STALE_CLEAR_MS = 6000L;

    /**
     * 布防 autostart：切服重载后由标题页 takeAutostart() 消费一次即自动 start()。若会话已 entered，
     * 标题页不会挂载、takeAutostart() 不会被调用，标志会残留到下次冷启动误触发；这里在延迟窗口后
     * 兜底清除仍未被消费的标志（已被消费则为 no-op），避免下次冷启动误触发自动进入。
     */
    private void armAutostart() {
        final int seq = ++autostartArmSeq;
        prefs.edit().putBoolean("autostart", true).apply();
        main.postDelayed(() -> {
            if (autostartArmSeq != seq) return; // 已有更新的布防，交给它
            if (prefs.getBoolean("autostart", false)) {
                prefs.edit().remove("autostart").apply();
                appendDiagLog("autostart", "stale flag cleared (session already entered?)");
            }
        }, AUTOSTART_STALE_CLEAR_MS);
    }

    /** 关闭「加入房间」404 兜底窗口。 */
    private void clearJoinFallback() {
        joinFallbackBase = null;
        joinFallbackCode = null;
        joinFallbackLoading = null;
        joinFallbackStep = 0;
        joinFallbackAt = 0L;
    }

    private boolean healthzOk(String selfUrl) {
        // StrictMode: an HTTP call on the UI thread throws NetworkOnMainThreadException (the
        // targetSdk-34 field crash). Every call site is a worker thread already; this guard keeps
        // a future main-thread caller from crashing the app — it reports "not up" instead and
        // leaves the misuse in diag.log.
        if (Looper.myLooper() == Looper.getMainLooper()) {
            appendDiagLog("healthzOk", "on main thread (blocked)");
            return false;
        }
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
        // targetSdk 34: the deprecated setSystemUiVisibility flags are unreliable on current
        // system versions (residual status-bar strip on edge-to-edge devices). API 30+ uses the
        // platform WindowInsetsController — the same calls WindowCompat/WindowInsetsControllerCompat
        // wrap (androidx is not on this app's classpath, and build.gradle is out of scope);
        // API 26–29 keeps the legacy flags as the fallback.
        Window window = getWindow();
        // Display cutout: without this the system letterboxes the window around the camera hole in
        // landscape (the "black bars on every edge" field report on cutout devices). ALWAYS (API 30+)
        // lets the window extend into the cutout area; on API 28/29 the defined value that does the
        // same for a landscape edge cutout is SHORT_EDGES (ALWAYS is not a known value before 30);
        // <28 has no cutout modes at all.
        if (Build.VERSION.SDK_INT >= 30) {
            WindowManager.LayoutParams attrs = window.getAttributes();
            attrs.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
            window.setAttributes(attrs);
        } else if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams attrs = window.getAttributes();
            attrs.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(attrs);
        }
        View decor = window.getDecorView();
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false); // layout edge-to-edge; insets still dispatched
            WindowInsetsController c = window.getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            } else {
                legacyHideSystemBars(decor);
            }
        } else {
            legacyHideSystemBars(decor);
        }
        // Transparent bars: if a bar is mid-transition it blends over the game instead of drawing
        // the theme's bar colour as a strip.
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        // Opaque dark window background: any pixel not covered by the WebView (bar transition,
        // resize, cutout) shows the game colour, never a white platform surface.
        window.setBackgroundDrawable(new ColorDrawable(0xFF0C0F0E));
    }

    /** API 26–29 (and last-resort API 30+) system-bar hiding. */
    private static void legacyHideSystemBars(View decor) {
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    /**
     * 全屏（HTML5）期间的沉浸模式：与 applyImmersive() 同形态（API 30+ 走控制器 + transient-by-swipe
     * 的 sticky 语义，26–29 用旧 flags），但只隐藏 system bars——cutout / edge-to-edge 设置归
     * applyImmersive() 管，这里不重复设置，全屏退出后既有 letterbox 形态不受影响。
     */
    private void enterFullscreenImmersive() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = window.getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                return;
            }
        }
        legacyHideSystemBars(window.getDecorView()); // API 26–29（及拿不到控制器的 30+）
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Returning from the background (install prompt, notification shade, other app) can leave
        // the bars revealed on some firmwares, and onWindowFocusChanged alone misses the resumes
        // where focus never changed — re-asserting is cheap and idempotent.
        applyImmersive();
    }

    @Override
    public void onBackPressed() {
        // 全屏优先：页面处于 HTML5 全屏时，BACK 先退全屏并直接返回——本轮不导航、也不清 dcConfig。
        // （dcConfig 是「加入打洞会话」的导航语义，退全屏不算导航——清了反而误伤下方 B 注释要保护的状态。）
        if (fullscreenView != null) {
            exitFullscreenFromBack();
            return;
        }
        // B（审计 §1）：返回离开打洞会话时清掉 dcConfig——goBack 落回的页面（落地页/上一站）不再
        // 是打洞目标，serveLocal 不得再向它注入打洞 WebSocket。已加载页面不受影响（注入只在响应期）。
        if (dcConfig != null) {
            dcConfig = null;
            dcOriginHost = null;
            appendDiagLog("dc-config", "cleared: back pressed");
        }
        // 返回键语义（审计 2026-10-05 §5）：先问页面能否自处理（关弹窗 / 回首页），页面不认领才走
        // WebView 历史或退后台。onBackPressed 本就在主线程，evaluateJavascript 回调也在主线程。
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript(
                "(function(){try{return (window.__SP_BACK&&window.__SP_BACK())?'1':'0'}catch(e){return '0'}})()",
                value -> {
                    if ("\"1\"".equals(value)) return; // 页面自己处理了
                    if (web.canGoBack()) web.goBack();
                    else moveTaskToBack(true);
                });
    }

    @Override
    protected void onDestroy() {
        // 全屏收尾（先于 web.destroy()）：容器里的自定义 View 属于 WebView 的渲染树，销毁前先摘干净，
        // 免得已死视图留在 content 里（引用也一并清空）。
        if (fullscreenContainer != null) {
            fullscreenContainer.removeAllViews();
            if (fullscreenContainer.getParent() instanceof ViewGroup) {
                ((ViewGroup) fullscreenContainer.getParent()).removeView(fullscreenContainer);
            }
            fullscreenContainer = null;
        }
        fullscreenView = null;
        fullscreenCallback = null;
        if (web != null) {
            web.removeJavascriptInterface("shell");
            web.destroy();
        }
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(HostService.NOTIFICATION_ID);
        super.onDestroy();
    }
}
