package icu.jiangjiangze.stronghold;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;

/**
 * JVM 编译桩：只为 {@code ArtStoreSelfTest} 而存在，安装进 APK 的永远是 {@code Updater.java} 本身。
 *
 * 为什么需要它：真实的 Updater.java 直接 import android.content.Context / SharedPreferences /
 * org.json / BuildConfig，纯 JVM 编译不了；而 ArtStore 只用它三样东西——{@code Progress} 接口、
 * {@code NOOP} sink 与 {@code sha256(File)} 助手。这里给出与真实实现语义一致的这三样，
 * ArtStore.java 本体保持零 Android 依赖、可独立编译运行。
 *
 * 注意：本文件不在 android 源集里（tools/apk/jvm/stub/ 只是测试夹具），Gradle 构建不会看到它；
 * 若真实 Updater 的这三个成员改了签名，这个桩必须同步（ArtStoreSelfTest 头部的命令会一起编译它们）。
 */
public final class Updater {

    public interface Progress {
        void onStage(String stage);

        default void onProgress(long bytes, long total) {}
    }

    /** 与真实 Updater.NOOP 同义（静默 sink）。 */
    public static final Progress NOOP = stage -> { };

    /** 与真实 Updater.sha256(File) 同实现（小写 hex）；ArtStore 复用它做包校验。 */
    public static String sha256(File f) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            try (InputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[128 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            }
            byte[] d = md.digest();
            StringBuilder sb = new StringBuilder(64);
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException("SHA-256 unavailable", e);
        }
    }

    /** 让 javac 不再提示未使用；也提醒读到这里的人这个桩是有意为之。 */
    public static String stubMarker() {
        return "jvm-stub";
    }

    private Updater() {}
}
