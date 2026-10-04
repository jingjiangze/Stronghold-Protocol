package icu.jiangjiangze.stronghold;

import android.content.Context;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/**
 * {@code window.spData} bridge for the injected player-data script (v1).
 *
 * All methods are synchronous string in/out and run on the WebView's JavaScript thread; the
 * underlying store is one small local file, so no threads are spawned here. No network, no crypto:
 * export/import hand the JSON back to the page, which owns any save/share/download UI. The class is
 * self-contained (context in, strings out) so the activity only has to register it, e.g.
 * {@code web.addJavascriptInterface(new PlayerBridge(this), "spData")}.
 */
public final class PlayerBridge {

    private final PlayerStore store;

    public PlayerBridge(Context ctx) {
        this(new PlayerStore(ctx));
    }

    public PlayerBridge(PlayerStore store) {
        this.store = store;
    }

    /** @return the stored document (null when absent) with the in-memory v migration applied. */
    @JavascriptInterface
    public String get() {
        try {
            return store.read();
        } catch (Throwable t) {
            return null; // a broken local read must never crash the WebView; the page starts empty
        }
    }

    /** Replace the stored document with the page's serialised doc (the page keeps its own copy). */
    @JavascriptInterface
    public void put(String json) {
        try {
            store.write(json);
        } catch (Throwable t) {
            // a failed local write must never crash the WebView; the page retries on the next flush
        }
    }

    /** Export = get: the JSON text the page hands to the save/share UI. */
    @JavascriptInterface
    public String exportJson() {
        return get();
    }

    /**
     * Import a user-supplied document. Accepted only when it parses as a JSON object whose integer
     * {@code v} lies within [1, {@link PlayerStore#VERSION}] (a future schema cannot be understood
     * by this build). The page merges it (LWW); this method only validates and writes it.
     *
     * @return true when the document was accepted and stored.
     */
    @JavascriptInterface
    public boolean importJson(String json) {
        if (json == null || json.isEmpty()) return false;
        try {
            JSONObject obj = new JSONObject(json);
            Object v = obj.opt("v");
            if (!(v instanceof Number)) return false;
            int n = ((Number) v).intValue();
            if (n < 1 || n > PlayerStore.VERSION) return false;
            store.write(json);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
}
