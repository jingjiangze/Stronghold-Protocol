#!/usr/bin/env bash
# Build + run the pure-JVM check for the LAN private-range predicate (LanNet).
#
#   bash tools/apk/jvm/run-lan-net-check.sh
#
# LanNet carries no Android dependency by design (see its header), so a bare JDK 17 is enough —
# no org.json either. Added 2026-10-12 with the Paper-Yuan 0.2.4 audit fix: the host side already
# answered probes from CGNAT 100.64/10 while the client's isSiteLocalAddress() did not, so a
# Tailscale/ZeroTier phone showed an address it could neither scan nor join.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

JDK_BIN="${JDK_BIN:-C:/Users/16891/android-build/jdk-extracted/jdk-17.0.20.1+1/bin}"
JAVAC="$JDK_BIN/javac"
JAVA="$JDK_BIN/java"
OUT="${SP_JVM_OUT:-C:/DDDD/Agent Work/_spjvm-lan-net}"

SRC="$REPO/android/app/src/main/java/icu/jiangjiangze/stronghold"

mkdir -p "$OUT"

"$JAVAC" -encoding UTF-8 -d "$OUT" \
  "$SRC/LanNet.java" \
  "$HERE/LanNetCheck.java"

"$JAVA" -cp "$OUT" LanNetCheck
