package icu.jiangjiangze.stronghold;

/**
 * Bridges to the embedded Node.js runtime (nodejs-mobile libnode) that powers the
 * host-server mode. The Node process blocks its thread for the whole lifetime of
 * the server — exactly what we want inside the foreground HostService. Parameters
 * reach the server as environment variables (see HostParams); editing them
 * therefore requires an app restart.
 */
public final class NodeRunner {

    static {
        System.loadLibrary("node");
        System.loadLibrary("node_launcher");
    }

    private static volatile boolean running = false;

    private NodeRunner() {}

    /** Starts `node server/index.js` once per process; later calls are no-ops. */
    public static synchronized void start(String cwd, String script, int port, String host,
                                          String[] envPairs) {
        if (running) return;
        running = true;
        Thread t = new Thread(() -> startNodeWithArguments(cwd, script, port, host, envPairs), "node-host-server");
        t.setDaemon(true);
        t.start();
    }

    public static boolean isRunning() {
        return running;
    }

    private static native int startNodeWithArguments(String cwd, String script, int port, String host,
                                                     String[] envPairs);
}
