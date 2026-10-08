#!/usr/bin/env bash
# Build + run the pure-JVM check for the O(1) fetched-art cache counters (ArtCacheStats) behind the
# two new bridge methods (ShellBridge.artCacheStatus / clearArtCache, feat/art-cache-status).
#
#   bash tools/apk/jvm/run-art-cache-stats-check.sh
#
# ArtCacheStats carries no Android dependency by design (see its header): a bare JDK 17 is enough
# (only java.io/java.nio/java.util.concurrent). It reuses ArtCdn's namespace rule, so ArtCdn + Line
# are compiled too. Covers the counter arithmetic, the .part/temp/lexical exclusion, the
# "clear drops art/cache but keeps art/packs" rule, the persistence/reconcile path and the JSON shape.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

JDK_BIN="${JDK_BIN:-C:/Users/16891/android-build/jdk-extracted/jdk-17.0.20.1+1/bin}"
JAVAC="$JDK_BIN/javac"
JAVA="$JDK_BIN/java"
OUT="${SP_JVM_ART_CACHE_OUT:-C:/Users/16891/android-build/spcheck-artcache}"

SRC="$REPO/android/app/src/main/java/icu/jiangjiangze/stronghold"

mkdir -p "$OUT"

"$JAVAC" -encoding UTF-8 -d "$OUT" \
  "$SRC/Line.java" \
  "$SRC/ArtCdn.java" \
  "$SRC/ArtCacheStats.java" \
  "$HERE/ArtCacheStatsCheck.java"

"$JAVA" -cp "$OUT" ArtCacheStatsCheck
