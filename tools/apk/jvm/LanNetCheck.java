import icu.jiangjiangze.stronghold.LanNet;

import java.util.ArrayList;
import java.util.List;

/**
 * JVM self-test for the LAN address predicate ({@link LanNet#isPrivateIpv4}). Pure logic: no
 * Android, no IO, no network — bare JDK 17 (LanNet carries no Android dependency by design).
 *
 *   bash tools/apk/jvm/run-lan-net-check.sh
 *
 * Why this exists (2026-10-12, the Paper-Yuan 0.2.4 APK audit): the host side
 * (tools/apk/overlay/sp-host.mjs) already answers LAN probes from RFC 6598 CGNAT 100.64/10,
 * but the client used InetAddress.isSiteLocalAddress(), which does NOT count that range. The
 * result was a one-sided gap: a phone on Tailscale/ZeroTier showed a "zt" address yet could
 * neither scan nor join rooms in that same segment. These checks pin:
 *
 *   ① the three classic private ranges stay in;
 *   ② CGNAT 100.64/10 is in (virtual LANs — the fix), and its boundaries are exact;
 *   ③ public / loopback / link-local / carrier-grade-but-out-of-range stay OUT — widening the
 *      scan range must never widen it past "private";
 *   ④ malformed literals are rejected (the predicate is a range gate, not a formatter):
 *      reject over parsing rather than accept-and-guess.
 */
public final class LanNetCheck {

    private static int checks = 0;
    private static final List<String> failures = new ArrayList<>();

    private static void check(boolean ok, String what) {
        checks++;
        if (!ok) failures.add(what);
    }

    private static void expect(boolean want, String ip, String why) {
        boolean got = LanNet.isPrivateIpv4(ip);
        check(got == want, String.format("isPrivateIpv4(%s) = %s, expected %s — %s",
                ip == null ? "null" : '"' + ip + '"', got, want, why));
    }

    public static void main(String[] args) {
        // ① the classic private ranges
        expect(true, "10.0.0.1", "10/8 lower bound");
        expect(true, "10.255.255.254", "10/8 upper bound");
        expect(true, "192.168.1.1", "192.168/16");
        expect(true, "192.168.0.255", "192.168/16 edge");
        expect(true, "172.16.0.1", "172.16/12 lower bound");
        expect(true, "172.31.255.254", "172.16/12 upper bound");

        // ② CGNAT 100.64/10 — the fix (Tailscale / ZeroTier / mesh VPNs land here)
        expect(true, "100.64.0.1", "RFC 6598 lower bound");
        expect(true, "100.127.255.254", "RFC 6598 upper bound");
        expect(true, "100.100.100.100", "typical Tailscale address");

        // ②b the boundaries of that range must be exact, not approximate
        expect(false, "100.63.255.255", "just below 100.64/10 is public, not CGNAT");
        expect(false, "100.128.0.0", "just above 100.127/16 is public, not CGNAT");

        // ③ everything else stays out: widening the range must not leak past "private"
        expect(false, "8.8.8.8", "public DNS");
        expect(false, "1.1.1.1", "public DNS");
        expect(false, "203.0.113.5", "public documentation range");
        expect(false, "127.0.0.1", "loopback — never a LAN peer");
        expect(false, "169.254.1.1", "link-local — not a scannable LAN segment");
        expect(false, "172.15.0.1", "just below 172.16/12 is public");
        expect(false, "172.32.0.1", "just above 172.31/16 is public");
        expect(false, "192.167.1.1", "just outside 192.168/16 is public");
        expect(false, "192.169.1.1", "just outside 192.168/16 is public");
        expect(false, "11.0.0.1", "just outside 10/8 is public");

        // ④ malformed / hostile literals are rejected outright
        expect(false, null, "null");
        expect(false, "", "empty");
        expect(false, "10.0.0", "three octets");
        expect(false, "10.0.0.1.2", "five octets");
        expect(false, "10.0.0.256", "octet out of range");
        expect(false, "10.0.0.-1", "negative octet (not a plain decimal literal)");
        expect(false, "10.0.0.+1", "signed octet");
        expect(false, "10.0.0. 1", "embedded space");
        expect(false, "010.0.0.1", "over-long octet (leading zero) is still 3 chars, must parse to 10");
        expect(false, "10.0.0.1\n", "trailing newline");
        expect(false, "1e2.0.0.1", "non-decimal notation");

        if (!failures.isEmpty()) {
            System.out.println("FAIL " + failures.size() + "/" + checks);
            for (String f : failures) System.out.println("  · " + f);
            System.exit(1);
        }
        System.out.println("PASS " + checks + " checks (LAN private-range predicate)");
    }
}
