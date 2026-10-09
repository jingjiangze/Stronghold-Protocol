#!/usr/bin/env bash
# Build + run the JVM self-test for the art-pack store (ArtStore) against the pure-JVM Updater stub.
#
#   bash tools/apk/jvm/run-art-store-check.sh
#
# ArtStore carries no Android dependency by design (see its header); the three things it needs from
# Updater are provided by tools/apk/jvm/stub/. Since 2026-10-09 the install also drives ArtSyncStats
# (download/unpack speeds for ShellBridge.artSyncStatus), which reuses ArtCacheStats.quote -> ArtCdn
# + Line are compiled too.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

JDK_BIN="${JDK_BIN:-C:/Users/16891/android-build/jdk-extracted/jdk-17.0.20.1+1/bin}"
JAVAC="$JDK_BIN/javac"
JAVA="$JDK_BIN/java"
OUT="${SP_JVM_ART_STORE_OUT:-C:/Users/16891/android-build/spcheck-artstore}"

SRC="$REPO/android/app/src/main/java/icu/jiangjiangze/stronghold"
STUB="$HERE/stub/icu/jiangjiangze/stronghold"

mkdir -p "$OUT"

"$JAVAC" -encoding UTF-8 -d "$OUT" \
  "$SRC/Line.java" \
  "$SRC/ArtCdn.java" \
  "$SRC/ArtCacheStats.java" \
  "$SRC/ArtSyncStats.java" \
  "$SRC/ArtRange.java" \
  "$STUB/Updater.java" \
  "$SRC/ArtStore.java" \
  "$HERE/ArtStoreSelfTest.java"

# The self-test builds its legitimate fixtures by shelling out to node tools/apk/make-art-packs.mjs,
# so it must run from the repository root; without node it falls back to its own zip writer.
cd "$REPO"
"$JAVA" -cp "$OUT" ArtStoreSelfTest
