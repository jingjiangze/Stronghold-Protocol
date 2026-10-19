package icu.jiangjiangze.stronghold;

import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/**
 * Runs the embedded game server as a CHILD PROCESS — the Termux Node 24 runtime staged into
 * jniLibs as libnode.so (tools/apk/fetch-termux-node.mjs). The build also points the executable's
 * DT_RUNPATH at $ORIGIN (tools/apk/patch-elf-sonames.mjs), so the loader finds the nine Termux
 * libraries that sit next to it without any environment manipulation.
 *
 * Safety shape (no shell, no dynamic argv, no environment API): three launch variants, each built
 * from a FULLY INLINE LITERAL argument vector in its own statement:
 *   V1  /system/bin/linker64 ./libnode.so -e <bootstrap>      (RUNPATH=$ORIGIN resolves libs)
 *   V2  /system/bin/linker64 --library-path . ./libnode.so -e <bootstrap>   (belt & suspenders)
 *   V3  ./libnode.so -e <bootstrap>                           (ROMs that allow direct exec)
 * cwd = nativeLibraryDir so "./" is self-referential; all variable config travels through
 * filesDir/run/launch.json, which the fixed bootstrap reads before importing the entry.
 * A variant that dies within 1.5 s (or cannot start at all) hands over to the next one; every
 * transition is logged to filesDir/run/server.log for field diagnosis.
 */
public final class NodeRunner {

    private static final String TAG = "StrongholdNode";
    private static final long VARIANT_PROBE_MS = 1500;

    private static volatile boolean running = false;
    private static volatile boolean stopped = false;
    private static volatile Process process = null;
    private static volatile File logFile = null;
    /** 2026-10-19: the handshake.json path (set when launch.json is written) — lets a launcher-side
     *  death write a FAILED handshake so the UI shows the reason instead of a bare 「已退出」. */
    private static volatile File handshakeFile = null;
    /**
     * 2026-10-19: the reason the launcher itself died (run dir / launch.json / all variants).
     * These paths never reach handshake.json, so without this field the UI could only ever say
     * 「已退出」. HostService.startupError() folds it into the bridge answer.
     */
    private static volatile String startupError = null;

    public static String startupError() { return startupError; }

    private NodeRunner() {}

    /**
     * Starts the embedded server once per process; later calls are no-ops.
     *
     * v2.9.3: runBase OWNS the run/ workspace (filesDir), and is deliberately separate from cwd.
     * cwd stays the materialised webroot — entry/upstreamEntry/HOME all resolve against it — while
     * launch.json/server.log/handshake.json/tmp live in runBase/run: the exact path the bootstrap,
     * the HostService handshake watcher and MainActivity's diagnostics reader all use. Keeping run/
     * OUT of webroot also means a content hot-update (root → webroot.old → rm) can no longer delete
     * the live logs and handshake files.
     */
    public static synchronized void start(String nativeLibDir, String cwd, String runBase, int port,
                                          String host, String spCombat, String spVerify, String trustProxy,
                                          String dirUrl) {
        if (running) return;
        running = true;
        stopped = false;
        startupError = null;

        File runDir = new File(runBase, "run");
        if (!runDir.isDirectory() && !runDir.mkdirs() && !runDir.isDirectory()) {
            startupError = "无法创建运行目录 " + runDir;
            Log.e(TAG, "cannot create run dir " + runDir);
            running = false;
            return;
        }
        // v2.7.5: a handshake left by a PREVIOUS node run would make HostService's watcher adopt
        // a stale port (or declare READY before this node even starts) — invalidate it here, the
        // new node writes a fresh one once it is actually serving.
        //noinspection ResultOfMethodCallIgnored
        new File(runDir, "handshake.json").delete();
        File tmpDir = new File(runDir, "tmp");
        if (!tmpDir.isDirectory()) tmpDir.mkdirs();
        File launchJson = new File(runDir, "launch.json");
        if (!writeLaunchJson(launchJson, cwd, tmpDir, port, host, spCombat, spVerify, trustProxy, dirUrl)) {
            startupError = "无法写入启动配置 launch.json";
            running = false;
            return;
        }
        logFile = new File(runDir, "server.log");
        handshakeFile = new File(runDir, "handshake.json");
        File workDir = new File(nativeLibDir);

        // Single source of truth for the bootstrap: the launch.json path the child reads is derived
        // from the SAME File we just wrote, so parent and child can never disagree on where the
        // config lives (the P0 was a second, hardcoded copy drifting from this one).
        String bootstrap = bootstrapSource(launchJson.getAbsolutePath());

        Thread t = new Thread(() -> runVariants(workDir, bootstrap), "node-host-server");
        t.setDaemon(true);
        t.start();
    }

    public static boolean isRunning() {
        return running;
    }

    /** True when the Node child process is alive right now (diagnostics use this, not isRunning). */
    public static boolean isAlive() {
        Process p = process;
        return p != null && p.isAlive();
    }

    /** Stops the embedded server (hot-switch: the service restarts it with fresh parameters). */
    public static synchronized void stop() {
        stopped = true;
        Process p = process;
        if (p != null) {
            p.destroy();
            // 2026-10-18 审计 A1：linker64 是父进程，destroy() 只发信号且不等回收；设备上实测可能
            // 留下仍在跑的运行时（端口/内存挂住，下一次启动拿不到干净状态）。给 3 秒，然后强杀。
            try {
                if (!p.waitFor(3, TimeUnit.SECONDS)) {
                    p.destroyForcibly();
                    p.waitFor(2, TimeUnit.SECONDS);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                p.destroyForcibly();
            }
            process = null;
        }
        running = false;
    }

    /** Runs the variant chain, waits for exit, and self-heals with ONE relaunch unless user-stopped. */
    private static void runVariants(File workDir, String bootstrap) {
        for (int attempt = 1; attempt <= 2 && !stopped; attempt++) {
            Process started = launchChain(workDir, bootstrap);
            if (started == null) {
                startupError = "三种启动方式全部失败（详见 run/server.log）";
                appendLog("all launch variants failed" + (attempt == 1 ? "" : " (on retry)"));
                Log.e(TAG, "all launch variants failed");
                // 2026-10-19: a launcher-side death never reaches handshake.json, so the UI could
                // only ever say 「已退出」. Write the failure handshake NOW (when launch.json made
                // it) so HostService's existing error path shows the reason on screen.
                writeFailureHandshake("all launch variants failed");
                break;
            }
            process = started;
            try {
                int code = started.waitFor();
                appendLog("node exited with code " + code);
                if (stopped) break;
                if (attempt < 2) appendLog("self-heal: relaunching once");
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        running = false;
    }

    /**
     * The launch variants, first live wins. 2026-10-19 (owner: 「本机服务依旧启动失败，审计更换其他
     * 的 node 服务链路」): the reference launcher (com.sp.web) boots the SAME Termux node by exec'ing
     * libnode.so DIRECTLY with LD_LIBRARY_PATH pointing at nativeLibraryDir — no linker64 hand-
     * invocation. On Android 10+ SELinux the linker64 variants are the likely-dying ones, so V0
     * (the reference shape) goes FIRST; V1–V3 stay as fallbacks for ROMs where it does not work.
     * The safety shape holds: no shell, every argv element is a fully literal absolute path or a
     * fixed string; the env map only ever gets one constant value.
     */
    private static Process launchChain(File workDir, String bootstrap) {
        // V0: direct exec + LD_LIBRARY_PATH (the reference chain's shape)
        try {
            ProcessBuilder pb = new ProcessBuilder(new java.io.File(workDir, "libnode.so").getAbsolutePath(),
                    "-e", bootstrap);
            pb.directory(workDir);
            pb.redirectErrorStream(true);
            pb.environment().put("LD_LIBRARY_PATH", workDir.getAbsolutePath());
            Process p = probe(pb.start(), "v0 direct+LD_LIBRARY_PATH");
            if (p != null) {
                appendLog("launched via: v0 direct exec + LD_LIBRARY_PATH (reference shape)");
                return p;
            }
        } catch (IOException e) {
            appendLog("v0 failed to start: " + e.getMessage());
        }

        // V1: linker64 with RUNPATH=$ORIGIN baked into the executable
        try {
            ProcessBuilder pb = new ProcessBuilder("/system/bin/linker64", "./libnode.so", "-e", bootstrap);
            pb.directory(workDir);
            pb.redirectErrorStream(true);
            Process p = probe(pb.start(), "v1 linker64+RUNPATH");
            if (p != null) {
                appendLog("launched via: v1 linker64+RUNPATH");
                return p;
            }
        } catch (IOException e) {
            appendLog("v1 failed to start: " + e.getMessage());
        }

        // V2: linker64 + explicit library path
        try {
            ProcessBuilder pb = new ProcessBuilder("/system/bin/linker64", "--library-path", ".", "./libnode.so",
                    "-e", bootstrap);
            pb.directory(workDir);
            pb.redirectErrorStream(true);
            Process p = probe(pb.start(), "v2 linker64+libpath");
            if (p != null) {
                appendLog("launched via: v2 linker64+--library-path");
                return p;
            }
        } catch (IOException e) {
            appendLog("v2 failed to start: " + e.getMessage());
        }

        // V3: direct execution (ROMs that allow exec in app storage)
        try {
            ProcessBuilder pb = new ProcessBuilder("./libnode.so", "-e", bootstrap);
            pb.directory(workDir);
            pb.redirectErrorStream(true);
            Process p = probe(pb.start(), "v3 direct");
            if (p != null) {
                appendLog("launched via: v3 direct exec");
                return p;
            }
        } catch (IOException e) {
            appendLog("v3 failed to start: " + e.getMessage());
        }
        return null;
    }

    /**
     * Builds the `-e` bootstrap program. Its launch.json path is CONCATENATED from the exact File
     * the parent just wrote — never a second literal — so the parent (writer) and the child (reader)
     * cannot drift apart again. jsEscape keeps the single-quoted JS string valid for any path.
     */
    private static String bootstrapSource(String launchJsonPath) {
        // 2026-10-19 审计 N3 改动1: the SAME path is hung on globalThis BEFORE the child reads
        // launch.json, so android-main.mjs never needs its own literal again.
        return "globalThis.__SP_LAUNCH='" + jsEscape(launchJsonPath) + "';"
                + "const fs=require('fs');const c=JSON.parse(fs.readFileSync(globalThis.__SP_LAUNCH,'utf8'));"
                + "Object.assign(process.env,c.env);import('file://'+c.entry);";
    }

    /** Escapes a filesystem path for embedding in a single-quoted JS string literal. */
    private static String jsEscape(String s) {
        return s.replace("\\", "\\\\").replace("'", "\\'");
    }

    /** Waits out the probe window: an immediately-dead process is a failed variant; a live one gets its log pumped. */
    private static Process probe(Process p, String label) {
        try {
            Thread.sleep(VARIANT_PROBE_MS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        if (p.isAlive()) {
            pumpOutput(p);
            return p;
        }
        // 2026-10-19：an immediate death used to lose the child's stderr (the stream was never
        // pumped) — the field log only said "exited immediately (code 1)". Drain what it wrote
        // (redirectErrorStream merged it into stdout) so the REAL reason reaches run/server.log.
        String why = drain(p);
        appendLog(label + " exited immediately (code " + p.exitValue() + ")"
                + (why.isEmpty() ? "" : ": " + why));
        return null;
    }

    /** Reads everything a dead child still holds on its (merged) stdout/stderr. Never throws. */
    private static String drain(Process p) {
        try (java.io.InputStream in = p.getInputStream()) {
            byte[] buf = new byte[4096];
            StringBuilder sb = new StringBuilder();
            int n;
            while ((n = in.read(buf)) > 0) {
                sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                if (sb.length() > 4000) break;
            }
            return sb.toString().trim();
        } catch (Exception e) {
            return "";
        }
    }

    /** Pumps the process output into filesDir/run/server.log on a helper thread. */
    private static void pumpOutput(Process p) {
        Thread t = new Thread(() -> {
            try (java.io.InputStream in = p.getInputStream()) {
                File lf = logFile;
                try (java.io.OutputStream out = new java.io.FileOutputStream(lf, true)) {
                    byte[] buf = new byte[16 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
            } catch (IOException ignored) {
            }
        }, "node-log");
        t.setDaemon(true);
        t.start();
    }

    private static void appendLog(String line) {
        File lf = logFile;
        if (lf == null) return;
        try (FileOutputStream out = new FileOutputStream(lf, true)) {
            out.write((System.currentTimeMillis() + " " + line + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) {
        }
    }

    /**
     * 2026-10-19: a launcher-side death (all variants failed) never reaches handshake.json, so the
     * UI could only ever show 「已退出」. Write a FAILED handshake now so HostService's existing
     * error path (handshakeError) surfaces the reason on screen. Best effort — never throws.
     */
    private static void writeFailureHandshake(String reason) {
        File f = handshakeFile;
        if (f == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("ok", false);
            o.put("error", reason);
            o.put("ts", System.currentTimeMillis());
            File tmp = new File(f.getParentFile(), "handshake.json.javatmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(o.toString().getBytes(StandardCharsets.UTF_8));
            }
            //noinspection ResultOfMethodCallIgnored
            tmp.renameTo(f);
        } catch (Exception ignored) {
        }
    }

    /** Writes the launch description the fixed bootstrap reads; all values are validated app config. */
    private static boolean writeLaunchJson(File launchJson, String cwd, File tmpDir, int port, String host,
                                           String spCombat, String spVerify, String trustProxy, String dirUrl) {
        try {
            JSONObject env = new JSONObject();
            // v2.7.5: PORT is only a fallback — the entry binds port 0 (OS-assigned) and reports the
            // real port through handshake.json; this value reaches Node as env.PORT for that fallback.
            env.put("PORT", port >= 1024 && port <= 65535 ? port : 3000);
            env.put("HOST", "::".equals(host) ? "::" : "127.0.0.1");
            env.put("SP_COMBAT", oneOf(spCombat, "client", "server"));
            env.put("SP_VERIFY", oneOf(spVerify, "off", "sample", "all"));
            env.put("TRUST_PROXY", oneOf(trustProxy, "auto", "1", "0"));
            env.put("TMPDIR", tmpDir.getAbsolutePath());
            env.put("HOME", cwd);
            if (dirUrl != null && dirUrl.startsWith("https://") && dirUrl.length() <= 128) {
                env.put("SP_DIR_URL", dirUrl);
                env.put("SP_DC", "1");
                // the embedded host advertises joinable rooms to the directory presence plane
                // under a stable id; resolveInvite maps it through the signed server list
                env.put("SP_SERVER_ID", "sp-phone-host");
            }
            JSONObject root = new JSONObject();
            // v2.7.5 P0: the dedicated Android entry calls the EXPORTED startServer() directly.
            // The old bootstrap imported server/index.js, whose isMain() gate is always false
            // under `-e` dynamic import (argv[1] is undefined) — main() never ran and the node
            // exited immediately. android-main.mjs does the explicit startServer + handshake.
            root.put("entry", new File(cwd, "server/android-main.mjs").getAbsolutePath());
            root.put("upstreamEntry", new File(cwd, "server/index.js").getAbsolutePath());
            root.put("handshake", new File(launchJson.getParentFile(), "handshake.json").getAbsolutePath());
            root.put("env", env);
            try (FileOutputStream out = new FileOutputStream(launchJson)) {
                out.write(root.toString().getBytes(StandardCharsets.UTF_8));
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, "cannot write launch.json", e);
            return false;
        }
    }

    /** Value must be one of the allowed literals; anything else falls back to the first one. */
    private static String oneOf(String value, String... allowed) {
        if (value != null) {
            for (String a : allowed) {
                if (a.equals(value)) return value;
            }
        }
        return allowed[0];
    }
}
