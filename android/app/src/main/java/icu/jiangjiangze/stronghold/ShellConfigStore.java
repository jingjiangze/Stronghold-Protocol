package icu.jiangjiangze.stronghold;

import android.content.Context;

import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 进程级 {@link ShellConfig} 快照持有者 —— 修掉「刷新成功但业务代码不知道」的生命周期缺陷
 * （方案 §3）。
 *
 * <p>缺陷原状：{@code ShellConfig.load()} 每次都重读磁盘并**返回新实例**，{@code refresh()} 只改
 * 自己那一个实例。启动线程写完就丢弃了实例，其它调用点（{@code MainActivity} 4 处 + {@code HostService}）
 * 各自 {@code load()} —— 同一进程内可能同时存在「已刷新」和「未刷新」两种视图，刷新结果要么靠下一次
 * {@code load()} 重读磁盘才偶然可见，要么永不可见。
 *
 * <p>现在：全进程只有一个快照。{@code load()} 走 {@link #current(Context)}（首次读盘，之后直接返回
 * 内存快照），{@code refresh()} 走 {@link #refresh(Context)}（远程成功 → 原地替换快照 → 通知监听者）。
 * 远程失败或返回异常内容时**保留 last-good**：配置服务器短时故障不影响启动（方案 §3 硬要求）。
 *
 * <p>线程安全：{@code snapshot} 是 volatile 的单次赋值引用，读路径无锁；刷新与首次读盘在 {@link #LOCK}
 * 内串行，监听者在锁外通知（监听者回调里再读配置不会自锁）。
 */
public final class ShellConfigStore {

    /** 快照；null = 尚未从磁盘装载过。volatile 单次赋值 → 读路径天然可见。 */
    private static volatile ShellConfig snapshot;

    /** 最近一次**成功**刷新的墙上时间（epoch ms）；0 = 本次安装从未成功刷新过。 */
    private static volatile long lastUpdated;

    private static final Object LOCK = new Object();

    private static final CopyOnWriteArrayList<Listener> LISTENERS = new CopyOnWriteArrayList<>();

    private ShellConfigStore() {
    }

    /** 快照变化通知（刷新成功时触发）。回调在刷新线程上执行，必须自行切主线程。 */
    public interface Listener {
        void onShellConfigChanged(ShellConfig config);
    }

    /**
     * 当前快照：首次调用读盘（缓存 → 内置默认），之后永远返回同一实例。**不发起网络**
     * —— 网络只发生在 {@link #refresh(Context)}。
     */
    public static ShellConfig current(Context ctx) {
        ShellConfig snap = snapshot;
        if (snap != null) return snap;
        synchronized (LOCK) {
            if (snapshot == null) {
                snapshot = ShellConfig.readSnapshot(ctx);
                lastUpdated = snapshot.lastUpdated();
            }
            return snapshot;
        }
    }

    /**
     * 拉远程配置并替换快照。成功返回 true 并通知监听者；失败返回 false 且**快照不变**
     * （last-good 继续服务）。
     */
    public static boolean refresh(Context ctx) {
        ShellConfig merged;
        long stamp;
        synchronized (LOCK) {
            ShellConfig base = current(ctx);
            merged = base.fetchRemote(ctx);
            if (merged == null) return false; // 全部源失败 → 保留 last-good
            stamp = System.currentTimeMillis();
            merged.markUpdated(stamp);
            snapshot = merged;
            lastUpdated = stamp;
        }
        for (Listener l : LISTENERS) {
            try {
                l.onShellConfigChanged(merged);
            } catch (Throwable ignored) {
                // 一个监听者抛异常不能影响其它监听者或调用方
            }
        }
        return true;
    }

    /** 最近一次成功刷新的时间（epoch ms）；0 = 从未成功。 */
    public static long lastUpdated() {
        return lastUpdated;
    }

    /** 注册变化监听（重复注册同一实例会被忽略）。 */
    public static void addListener(Listener l) {
        if (l != null) LISTENERS.addIfAbsent(l);
    }

    /** 注销监听。 */
    public static void removeListener(Listener l) {
        if (l != null) LISTENERS.remove(l);
    }

    /** 测试/诊断用：丢弃内存快照，迫使下次 {@link #current(Context)} 重新读盘。 */
    static void resetForTest() {
        synchronized (LOCK) {
            snapshot = null;
            lastUpdated = 0;
        }
    }
}
