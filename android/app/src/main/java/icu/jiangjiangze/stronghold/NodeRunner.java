package icu.jiangjiangze.stronghold;

import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * Runs the embedded game server as a CHILD PROCESS — the Termux Node 24 runtime staged into
 * jniLibs as libnode.so (see tools/apk/fetch-termux-node.mjs). Replaces the nodejs-mobile JNI
 * bridge: a plain PIE executable + shared libraries never conflict with the app's own C++
 * runtime, is not stuck on Node 18, and matches upstream's engines>=22.
 *
 * Safety shape — every argument of the process command is a literal in the source, evaluated
 * statically by review tooling:
 *   /system/bin/linker64        the platform linker (also execs from app storage despite W^X)
 *   --library-path .
 *   ./libnode.so                resolved against the child cwd (nativeLibraryDir)
 *   -e <fixed bootstrap>        reads the launch JSON this class writes, then imports the entry
 * Nothing variable enters the command or the environment; all variable input travels through
 * filesDir/run/launch.json (file I/O only, values validated before writing).
 */
public final class NodeRunner {

    private static final String TAG = "StrongholdNode";

    private static volatile boolean running = false;
    private static volatile Process process = null;

    private NodeRunner() {}

    /** Starts the embedded server once per process; later calls are no-ops. */
    public static synchronized void start(String nativeLibDir, String cwd, int port, String host,
                                          String spCombat, String spVerify, String trustProxy, String dirUrl) {
        if (running) return;
        running = true;

        File runDir = new File(cwd, "run");
        if (!runDir.isDirectory() && !runDir.mkdirs() && !runDir.isDirectory()) {
            Log.e(TAG, "cannot create run dir " + runDir);
            running = false;
            return;
        }
        File launchJson = new File(runDir, "launch.json");
        if (!writeLaunchJson(launchJson, cwd, port, host, spCombat, spVerify, trustProxy, dirUrl)) {
            running = false;
            return;
        }
        File workDir = new File(nativeLibDir);
        File log = new File(runDir, "server.log");
        try {
            process = new ProcessBuilder(
                    "/system/bin/linker64",
                    "--library-path",
                    ".",
                    "./libnode.so",
                    "-e",
                    "const fs=require('fs');const c=JSON.parse(fs.readFileSync('/data/user/0/icu.jiangjiangze.stronghold/files/run/launch.json','utf8'));Object.assign(process.env,c.env);import('file://'+c.entry);"
            ).directory(workDir).redirectErrorStream(true).redirectOutput(log).start();
        } catch (IOException e) {
            Log.e(TAG, "launch failed", e);
            running = false;
            return;
        }

        Thread t = new Thread(NodeRunner::waitForExit, "node-host-server");
        t.setDaemon(true);
        t.start();
    }

    public static boolean isRunning() {
        return running;
    }

    /** Writes the launch description the fixed bootstrap reads; all values are validated app config. */
    private static boolean writeLaunchJson(File launchJson, String cwd, int port, String host,
                                           String spCombat, String spVerify, String trustProxy, String dirUrl) {
        try {
            JSONObject env = new JSONObject();
            env.put("PORT", port >= 1024 && port <= 65535 ? port : 3000);
            env.put("HOST", "::".equals(host) ? "::" : "127.0.0.1");
            env.put("SP_COMBAT", oneOf(spCombat, "client", "server"));
            env.put("SP_VERIFY", oneOf(spVerify, "off", "sample", "all"));
            env.put("TRUST_PROXY", oneOf(trustProxy, "auto", "1", "0"));
            if (dirUrl != null && dirUrl.startsWith("https://") && dirUrl.length() <= 128) {
                env.put("SP_DIR_URL", dirUrl);
                env.put("SP_DC", "1");
            }
            JSONObject root = new JSONObject();
            root.put("entry", new File(cwd, "server/index.js").getAbsolutePath());
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

    private static void waitForExit() {
        Process p = process;
        try {
            int code = p.waitFor();
            Log.i(TAG, "node exited with code " + code);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        running = false;
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
