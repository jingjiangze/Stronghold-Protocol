import icu.jiangjiangze.stronghold.ArtRange;
import icu.jiangjiangze.stronghold.ArtSyncStats;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JVM self-test for the art-pack channel's live status (ArtSyncStats) and the segmented-download
 * policy (ArtRange) behind {@code ShellBridge.artSyncStatus()} — owner ask 2026-10-09: the preload
 * progress must show its speeds (download / unpack / preload). Pure logic, bare JDK 17, no Android
 * and no network:
 *
 *   bash tools/apk/jvm/run-art-sync-stats-check.sh
 *
 * Covers:
 *   - the two channels are accounted SEPARATELY (network bytes vs unpack bytes; never summed);
 *   - the rate is a windowed EWMA (a sample inside the window does not move it; a later one does);
 *   - a channel that stops reporting drops to 0 B/s and loses its ETA (never a stale number);
 *   - ETA exists only when there is a rate AND a known total (unknown total -> -1, never a fake 0);
 *   - pack progress counts processed packs (failures included), and begin/end bracket a run;
 *   - the JSON shape of statusJson (parsed, not substring-matched, quotes round-trip);
 *   - ArtRange: conns policy (small/big/extreme), segment tiling covers [0, size) exactly with no
 *     gap or overlap, and Content-Range parsing (incl. the '*' and garbage cases).
 */
public final class ArtSyncStatsCheck {

    private static int checks = 0;
    private static final List<String> failures = new ArrayList<>();

    public static void main(String[] args) throws Exception {
        // ---- begin brackets a run ------------------------------------------------------------
        ArtSyncStats.begin(4, 1);
        ArtSyncStats.Snapshot s0 = ArtSyncStats.snapshot();
        check(s0.active, "begin marks the channel active");
        eq(4, s0.packsTotal, "begin carries the pack count");
        eq(0L, s0.dlBps, "no rate before any byte");

        // ---- the two channels are separate --------------------------------------------------
        ArtSyncStats.packStart("core.ui", ArtSyncStats.STAGE_DOWNLOAD);
        ArtSyncStats.onBytes("p", ArtSyncStats.STAGE_DOWNLOAD, 1024 * 1024, 8 * 1024 * 1024);
        sleep(500); // open the first rate window
        ArtSyncStats.onBytes("p", ArtSyncStats.STAGE_DOWNLOAD, 3 * 1024 * 1024, 8 * 1024 * 1024);
        ArtSyncStats.Snapshot s1 = ArtSyncStats.snapshot();
        eq(ArtSyncStats.STAGE_DOWNLOAD, s1.stage, "the reporting channel is on stage");
        eq(3L * 1024 * 1024, s1.bytesDone, "bytesDone tracks the download channel");
        check(s1.dlBps > 0, "the download rate is measured (got " + s1.dlBps + " B/s)");
        eq(0L, s1.unzipBps, "the unpack rate stays 0 while nothing is unpacked");
        check(s1.etaMs > 0, "a known total + a rate yields an ETA (got " + s1.etaMs + " ms)");

        // an unpack report takes the label over but must NOT touch the download numbers
        ArtSyncStats.packStart("core.ui", ArtSyncStats.STAGE_UNZIP);
        ArtSyncStats.onBytes("p", ArtSyncStats.STAGE_UNZIP, 2 * 1024 * 1024, 0); // total unknown
        ArtSyncStats.Snapshot s2 = ArtSyncStats.snapshot();
        eq(ArtSyncStats.STAGE_UNZIP, s2.stage, "the unpack channel took the label");
        eq(2L * 1024 * 1024, s2.bytesDone, "bytesDone now describes the unpack channel");
        eq(0L, s2.bytesTotal, "an unknown total is reported as 0, not guessed");
        eq(-1L, s2.etaMs, "an unknown total yields etaMs=-1 (the panel then draws no ETA line)");
        eq(0L, s2.unzipBps, "a first unpack sample inside no window yet is not a rate");

        // ---- rate window: a sample inside the window does not move the EWMA -----------------
        sleep(500);
        ArtSyncStats.onBytes("p", ArtSyncStats.STAGE_UNZIP, 4 * 1024 * 1024, 0);
        long uz1 = ArtSyncStats.snapshot().unzipBps;
        check(uz1 > 0, "the unpack rate is measured (got " + uz1 + " B/s)");
        ArtSyncStats.onBytes("p", ArtSyncStats.STAGE_UNZIP, 4 * 1024 * 1024 + 4096, 0); // same window
        eq(uz1, ArtSyncStats.snapshot().unzipBps, "a same-window sample does not re-price the rate");

        // ---- the download meter kept running independently of the unpack channel ------------
        ArtSyncStats.onBytes("p", ArtSyncStats.STAGE_DOWNLOAD, 8 * 1024 * 1024, 8 * 1024 * 1024);
        check(ArtSyncStats.snapshot().dlBps > 0, "the download meter is still live");

        // ---- idle channels drop to 0 ---------------------------------------------------------
        sleep(4300); // > IDLE_RESET_MS
        ArtSyncStats.Snapshot s3 = ArtSyncStats.snapshot();
        eq(0L, s3.unzipBps, "an idle unpack channel reports 0 B/s");
        eq(0L, s3.dlBps, "an idle download channel reports 0 B/s — never a stale rate");

        // ---- pack progress counts processed packs (failures included) -----------------------
        ArtSyncStats.packDone(1);
        eq(1, ArtSyncStats.snapshot().packsDone, "packsDone follows packDone()");
        // Out-of-order completions (packs install concurrently): a LOWER index finishing later must
        // not write the counter backwards — the panel would show 2/4 and then jump back to 1/4.
        ArtSyncStats.packDone(2);
        ArtSyncStats.packDone(1);
        eq(2, ArtSyncStats.snapshot().packsDone, "packDone is monotonic (never regresses)");
        ArtSyncStats.packDone(4);
        ArtSyncStats.end();
        ArtSyncStats.Snapshot s4 = ArtSyncStats.snapshot();
        check(!s4.active, "end() closes the run");
        eq(4, s4.packsTotal, "a finished run keeps the pack count on screen");
        eq(4, s4.packsDone, "…and the processed count");
        eq(0L, s4.dlBps + s4.unzipBps, "end() zeroes both rates");

        // ---- JSON shape: parsed, not substring-matched --------------------------------------
        ArtSyncStats.begin(2, 3);
        ArtSyncStats.packStart("audio.voice.3", ArtSyncStats.STAGE_DOWNLOAD);
        ArtSyncStats.onBytes("audio.voice.3", ArtSyncStats.STAGE_DOWNLOAD, 5, 10);
        ArtSyncStats.packDone(1);
        Map<String, Object> j = parseJson(ArtSyncStats.liveJson());
        eq(Boolean.TRUE, j.get("ok"), "status.ok is true");
        eq(Boolean.TRUE, j.get("active"), "status.active follows the run");
        eq("download", j.get("stage"), "status.stage names the channel");
        eq("audio.voice.3", j.get("pack"), "status.pack names the pack");
        eq(1L, j.get("packsDone"), "status.packsDone is a number");
        eq(2L, j.get("packsTotal"), "status.packsTotal is a number");
        eq(3L, j.get("conns"), "status.conns is a number (segmented downloads say so)");
        eq(5L, j.get("bytesDone"), "status.bytesDone is a number");
        eq(10L, j.get("bytesTotal"), "status.bytesTotal is a number");
        check(j.get("dlBps") instanceof Long, "status.dlBps is a number");
        check(j.get("unzipBps") instanceof Long, "status.unzipBps is a number");
        check(j.get("etaMs") instanceof Long, "status.etaMs is a number");
        check(j.get("elapsedMs") instanceof Long, "status.elapsedMs is a number");
        eq(13, j.size(), "status has exactly the 13 contract keys");
        Map<String, Object> q = parseJson(ArtSyncStats.statusJson(
                new ArtSyncStats.Snapshot(true, "a\"b", "c\\d", 0, 0, 1, 0, 0, 0, 0, -1, 0)));
        eq("a\"b", q.get("stage"), "quotes in a value survive the round-trip");
        eq("c\\d", q.get("pack"), "backslashes in a value survive the round-trip");
        eq(-1L, q.get("etaMs"), "a negative ETA is passed through as -1");
        ArtSyncStats.end();

        // ---- per-pack aggregation (audit 2026-10-09 phase 5) ---------------------------------
        // Two packs install concurrently (PACK_CONCURRENCY = 2) and each reports its OWN cumulative
        // bytes. Sharing one field let the later report overwrite the earlier one (A reports 5 MB,
        // B reports 3 MB -> the reading showed 3 MB, and the rate window saw fake jumps). The ledger
        // sums the packs, so the number stays explainable: "bytes moved by this sync".
        ArtSyncStats.begin(2, 1);
        ArtSyncStats.packStart("a", ArtSyncStats.STAGE_DOWNLOAD);
        ArtSyncStats.onBytes("a", ArtSyncStats.STAGE_DOWNLOAD, 5 * 1024 * 1024, 10 * 1024 * 1024);
        eq(5L * 1024 * 1024, ArtSyncStats.snapshot().bytesDone, "one pack reports its own bytes");
        ArtSyncStats.packStart("b", ArtSyncStats.STAGE_DOWNLOAD);
        ArtSyncStats.onBytes("b", ArtSyncStats.STAGE_DOWNLOAD, 3 * 1024 * 1024, 4 * 1024 * 1024);
        ArtSyncStats.Snapshot agg = ArtSyncStats.snapshot();
        eq(8L * 1024 * 1024, agg.bytesDone, "two concurrent packs are SUMMED, not overwritten");
        eq(14L * 1024 * 1024, agg.bytesTotal, "the totals are summed too");
        ArtSyncStats.onBytes("a", ArtSyncStats.STAGE_DOWNLOAD, 6 * 1024 * 1024, 10 * 1024 * 1024);
        eq(9L * 1024 * 1024, ArtSyncStats.snapshot().bytesDone, "a later report from the first pack still adds up");
        ArtSyncStats.begin(1, 1);
        eq(0L, ArtSyncStats.snapshot().bytesDone, "begin() clears the ledger");
        ArtSyncStats.end();

        // ---- ArtRange: connection policy (owner 2026-10-09: default 16) ---------------------
        eq(16, ArtRange.MAX_CONNS, "the default connection ceiling is 16");
        eq(1, ArtRange.connsFor(1024 * 1024), "a small pack stays linear (< MIN)");
        eq(1, ArtRange.connsFor(ArtRange.MIN_BYTES - 1), "just under MIN is still linear");
        eq(2, ArtRange.connsFor(ArtRange.MIN_BYTES), "at MIN the two-connection floor applies");
        eq(5, ArtRange.connsFor(20L * 1024 * 1024), "a 20 MiB pack is 5 connections (ceil(20/4))");
        eq(9, ArtRange.connsFor(36L * 1024 * 1024), "a 36 MiB pack is 9 connections");
        eq(16, ArtRange.connsFor(64L * 1024 * 1024), "a 64 MiB pack fills all 16 connections");
        eq(16, ArtRange.connsFor(100L * 1024 * 1024), "a 100 MiB pack caps at MAX_CONNS");
        eq(16, ArtRange.connsFor(1L << 40), "an absurd size still caps at MAX_CONNS");
        eq(1, ArtRange.connsFor(-1), "a negative/unknown size falls back to linear");
        // 「如无这些线程则取最高」: the device's thread count caps the count; 0/unknown = full 16.
        eq(16, ArtRange.connsFor(64L * 1024 * 1024, 0), "threads=0 (unknown) uses the full ceiling");
        eq(16, ArtRange.connsFor(64L * 1024 * 1024, 64), "more threads than MAX_CONNS does not exceed it");
        eq(4, ArtRange.connsFor(64L * 1024 * 1024, 4), "a 4-thread device gets 4 connections");
        eq(2, ArtRange.connsFor(20L * 1024 * 1024, 2), "the thread cap also lowers a mid-size pack");
        eq(1, ArtRange.connsFor(1L << 40, 1), "a single-thread device never segments");
        eq(1, ArtRange.connsFor(1024 * 1024, 8), "the size floor still wins over the thread cap");

        // ---- ArtRange: the tiling must cover [0, size) exactly ------------------------------
        long[][] exact = ArtRange.segments(100, 4);
        eq(4, exact.length, "100 bytes / 4 connections = 4 segments");
        eq(0L, exact[0][0], "the first segment starts at 0");
        eq(99L, exact[exact.length - 1][1], "the last segment ends at size-1");
        tiling("100/4", 100, exact);
        tiling("1/4", 1, ArtRange.segments(1, 4));
        tiling("7/3", 7, ArtRange.segments(7, 3));
        tiling("9/4", 9, ArtRange.segments(9, 4));
        tiling("1000/1", 1000, ArtRange.segments(1000, 1));
        tiling("64MiB+1/4", 64L * 1024 * 1024 + 1, ArtRange.segments(64L * 1024 * 1024 + 1, 4));
        eq(0, ArtRange.segments(0, 4).length, "a zero-length file has no segments");
        eq(1, ArtRange.segments(10, 1).length, "one connection = one segment covering everything");

        // ---- ArtRange: Content-Range parsing ------------------------------------------------
        eq(12345L, ArtRange.contentRangeTotal("bytes 0-0/12345"), "bytes 0-0/12345 parses to 12345");
        eq(5L, ArtRange.contentRangeTotal("bytes 0-4/5"), "a plain total parses");
        eq(-1L, ArtRange.contentRangeTotal("bytes 0-0/*"), "a '*' total is unknown");
        eq(-1L, ArtRange.contentRangeTotal("bytes 0-0"), "a missing slash is unknown");
        eq(-1L, ArtRange.contentRangeTotal("bytes 0-0/abc"), "garbage is unknown");
        eq(-1L, ArtRange.contentRangeTotal(null), "null is unknown");
        eq(-1L, ArtRange.contentRangeTotal("bytes 0-0/0"), "a zero total is treated as unknown");

        System.out.println("ArtSyncStatsCheck OK (" + checks + " checks)");
        if (!failures.isEmpty()) {
            System.out.println("FAILURES:");
            for (String f : failures) System.out.println("  - " + f);
            System.exit(1);
        }
    }

    /** Asserts the plan tiles [0, size) exactly: contiguous, ordered, in range, no duplicate byte. */
    private static void tiling(String label, long size, long[][] plan) {
        checks++;
        long expect = 0;
        for (long[] seg : plan) {
            if (seg[0] != expect) {
                failures.add("FAILED: " + label + " tiling gap/overlap at " + expect + " (segment starts " + seg[0] + ")");
                return;
            }
            if (seg[1] < seg[0] || seg[1] >= size) {
                failures.add("FAILED: " + label + " segment " + seg[0] + "-" + seg[1] + " is out of range");
                return;
            }
            expect = seg[1] + 1;
        }
        if (expect != size) failures.add("FAILED: " + label + " tiling covers " + expect + " of " + size + " bytes");
    }

    private static void sleep(long ms) throws InterruptedException {
        Thread.sleep(ms);
    }

    private static void check(boolean ok, String label) {
        checks++;
        if (!ok) failures.add("FAILED: " + label);
    }

    private static void eq(Object expected, Object actual, String label) {
        checks++;
        boolean ok = expected == null ? actual == null : expected.equals(actual);
        if (!ok) failures.add("FAILED: " + label + " (expected " + expected + ", got " + actual + ")");
    }

    private static void eq(long expected, long actual, String label) {
        eq(Long.valueOf(expected), Long.valueOf(actual), label);
    }

    private static void eq(int expected, int actual, String label) {
        eq(Integer.valueOf(expected), Integer.valueOf(actual), label);
    }

    // ---- minimal flat JSON parser (same shape as ArtCacheStatsCheck's) -----------------------

    private static Map<String, Object> parseJson(String s) {
        Map<String, Object> m = new LinkedHashMap<>();
        int i = skip(s, 0);
        if (i >= s.length() || s.charAt(i) != '{') throw new IllegalArgumentException("not an object: " + s);
        i = skip(s, i + 1);
        while (i < s.length() && s.charAt(i) != '}') {
            StringBuilder key = new StringBuilder();
            if (s.charAt(i) != '"') throw new IllegalArgumentException("expected key at " + i + ": " + s);
            i = readString(s, i, key);
            i = skip(s, i);
            if (i >= s.length() || s.charAt(i) != ':') throw new IllegalArgumentException("expected ':' at " + i);
            i = skip(s, i + 1);
            Object v;
            char c = s.charAt(i);
            if (c == '"') {
                StringBuilder sb = new StringBuilder();
                i = readString(s, i, sb);
                v = sb.toString();
            } else if (c == 't') {
                i += 4;
                v = Boolean.TRUE;
            } else if (c == 'f') {
                i += 5;
                v = Boolean.FALSE;
            } else if (c == 'n') {
                i += 4;
                v = null;
            } else {
                int j = i;
                while (j < s.length() && "-+.0123456789eE".indexOf(s.charAt(j)) >= 0) j++;
                v = Long.valueOf(Long.parseLong(s.substring(i, j)));
                i = j;
            }
            m.put(key.toString(), v);
            i = skip(s, i);
            if (i < s.length() && s.charAt(i) == ',') i = skip(s, i + 1);
        }
        return m;
    }

    private static int skip(String s, int i) {
        while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        return i;
    }

    private static int readString(String s, int i, StringBuilder out) {
        i++;
        while (i < s.length()) {
            char c = s.charAt(i++);
            if (c == '"') return i;
            if (c == '\\') {
                char e = s.charAt(i++);
                switch (e) {
                    case 'n': out.append('\n'); break;
                    case 'r': out.append('\r'); break;
                    case 't': out.append('\t'); break;
                    case '"': out.append('"'); break;
                    case '\\': out.append('\\'); break;
                    case 'u': out.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                    default: out.append(e);
                }
            } else {
                out.append(c);
            }
        }
        throw new IllegalArgumentException("unterminated string");
    }
}
