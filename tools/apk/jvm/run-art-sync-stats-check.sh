#!/usr/bin/env bash
# Build + run the pure-JVM check for the art-pack channel's live status/speeds (ArtSyncStats +
# ArtRange) behind ShellBridge.artSyncStatus() — owner ask 2026-10-09 (the preload progress must
# show download / unpack / preload speeds).
#
#   bash tools/apk/jvm/run-art-sync-stats-check.sh
#
# Both classes carry no Android dependency by design (see their headers): a bare JDK 17 is enough.
# ArtSyncStats reuses ArtCacheStats.quote for its JSON, so ArtCacheStats is compiled too (it in turn
# reuses ArtCdn's namespace rule → ArtCdn + Line as well).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

JDK_BIN="${JDK_BIN:-C:/Users/16891/android-build/jdk-extracted/jdk-17.0.20.1+1/bin}"
JAVAC="$JDK_BIN/javac"
JAVA="$JDK_BIN/java"
OUT="${SP_JVM_ART_SYNC_OUT:-C:/Users/16891/android-build/spcheck-artsync}"

SRC="$REPO/android/app/src/main/java/icu/jiangjiangze/stronghold"

mkdir -p "$OUT"

"$JAVAC" -encoding UTF-8 -d "$OUT" \
  "$SRC/Line.java" \
  "$SRC/ArtCdn.java" \
  "$SRC/ArtCacheStats.java" \
  "$SRC/ArtSyncStats.java" \
  "$SRC/ArtRange.java" \
  "$HERE/ArtSyncStatsCheck.java"

"$JAVA" -cp "$OUT" ArtSyncStatsCheck
