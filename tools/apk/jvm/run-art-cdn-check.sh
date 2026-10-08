#!/usr/bin/env bash
# Build + run the pure-JVM check for the fetched-art fallback (ArtCdn).
#
#   bash tools/apk/jvm/run-art-cdn-check.sh
#
# ArtCdn carries no Android dependency by design (see its header): a bare JDK 17 is enough. Kept as
# a script so the exact source list lives in one place and CI can call the same line. Covers the
# decisions the 2026-10-08 field report touched: the host allow-list, the /assets -> CDN and cache
# mappings, the manifest-hash namespace adoption (a content release must not orphan the cache), the
# prune ranking (active namespace deleted last), the prefetch request marker and the placeholder's
# no-store headers.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

JDK_BIN="${JDK_BIN:-C:/Users/16891/android-build/jdk-extracted/jdk-17.0.20.1+1/bin}"
JAVAC="$JDK_BIN/javac"
JAVA="$JDK_BIN/java"
OUT="${SP_JVM_ART_OUT:-C:/Users/16891/android-build/spcheck-artcdn}"

SRC="$REPO/android/app/src/main/java/icu/jiangjiangze/stronghold"

mkdir -p "$OUT"

"$JAVAC" -encoding UTF-8 -d "$OUT" \
  "$SRC/Line.java" \
  "$SRC/ArtCdn.java" \
  "$HERE/ArtCdnCheck.java"

"$JAVA" -cp "$OUT" ArtCdnCheck
