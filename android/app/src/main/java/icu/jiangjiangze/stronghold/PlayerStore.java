package icu.jiangjiangze.stronghold;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * Player-data v1 store: a dumb, origin-independent local source of truth.
 *
 * The document is one opaque JSON string kept at filesDir/player-v1.json. This class knows
 * NOTHING about its fields beyond the version field {@code v} (used only by the migration hook);
 * merging / normalising lives in the injected page script. Writes are atomic (temp file + rename,
 * fsync'd) so a kill mid-write can never truncate the doc. No network, no crypto, no business
 * logic -- it is a file with two verbs.
 */
public final class PlayerStore {

    /** Current document schema version (mirrors shared/player-data.js). */
    public static final int VERSION = 1;

    private static final String DOC = "player-v1.json";
    private static final String TMP = DOC + ".tmp";

    private final File dir;

    public PlayerStore(Context ctx) {
        this(ctx == null ? null : ctx.getFilesDir());
    }

    public PlayerStore(File dir) {
        this.dir = dir;
    }

    /** Stored document text, or null when there is none (first run). Applies the v migration in memory. */
    public String read() {
        if (dir == null) return null;
        byte[] raw = readBytes(new File(dir, DOC));
        if (raw == null) return null;
        return migrate(new String(raw, StandardCharsets.UTF_8));
    }

    /** Atomically replace the stored document. Null/empty input is ignored (a put never deletes the doc). */
    public void write(String json) {
        if (dir == null || json == null || json.isEmpty()) return;
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File tmp = new File(dir, TMP);
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        if (!writeBytes(tmp, bytes)) return;
        File dst = new File(dir, DOC);
        if (tmp.renameTo(dst)) return;
        // rename(2) replaces an existing destination on Android/Linux; the delete+rename step only
        // matters on filesystems that refuse to overwrite (e.g. a Windows test box).
        if (dst.exists() && dst.delete() && tmp.renameTo(dst)) return;
        // last resort: direct overwrite (non-atomic, but better than silently dropping the write)
        writeBytes(dst, bytes);
        //noinspection ResultOfMethodCallIgnored
        tmp.delete();
    }

    /**
     * {@code v}-field migration hook. v1 is the first schema, so the only migration is stamping a
     * missing/older version; a future/unknown version is returned untouched (never downgraded).
     * Invalid JSON is returned untouched too -- this store stays dumb and the page layer decides.
     */
    protected String migrate(String json) {
        try {
            JSONObject obj = new JSONObject(json);
            Object v = obj.opt("v");
            if (v instanceof Number && ((Number) v).intValue() == VERSION) return json;
            if (v == null || (v instanceof Number && ((Number) v).intValue() < VERSION)) {
                obj.put("v", VERSION);
                return obj.toString();
            }
            return json;
        } catch (Exception e) {
            return json;
        }
    }

    private static byte[] readBytes(File f) {
        if (!f.isFile()) return null;
        try (FileInputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(64, f.length()));
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } catch (IOException e) {
            return null;
        }
    }

    private static boolean writeBytes(File f, byte[] bytes) {
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(bytes);
            out.flush();
            out.getFD().sync();
            return true;
        } catch (IOException e) {
            return false;
        }
    }
}
