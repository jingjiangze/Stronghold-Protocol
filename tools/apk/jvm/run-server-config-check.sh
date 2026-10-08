#!/usr/bin/env bash
# Build + run the pure-JVM checks for the server-config feature.
#
#   bash tools/apk/jvm/run-server-config-check.sh
#
# These classes carry no Android dependency by design (see each file's header), so a bare JDK 17
# plus a stock org.json jar is enough. Kept as a script so the exact source list lives in one place
# and CI can call the same line.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

JDK_BIN="${JDK_BIN:-C:/Users/16891/android-build/jdk-extracted/jdk-17.0.20.1+1/bin}"
JAVAC="$JDK_BIN/javac"
JAVA="$JDK_BIN/java"
JSON_JAR="${SP_JSON_JAR:-C:/Users/16891/android-build/edtest/lib/json.jar}"
OUT="${SP_JVM_OUT:-C:/DDDD/Agent Work/_spjvm}"

SRC="$REPO/android/app/src/main/java/icu/jiangjiangze/stronghold"

mkdir -p "$OUT"

# The classpath separator is ';' even under Git Bash: the JDK is a Windows binary and the paths
# themselves contain ':' (drive letters), so ':' would split inside "C:/...".
CP="$OUT;$JSON_JAR"

"$JAVAC" -encoding UTF-8 -cp "$JSON_JAR" -d "$OUT" \
  "$SRC/Line.java" \
  "$SRC/ArtCdn.java" \
  "$SRC/ArtCacheStats.java" \
  "$SRC/ServerConfig.java" \
  "$SRC/ServerConfigStore.java" \
  "$SRC/ResourceResolver.java" \
  "$HERE/ServerConfigCheck.java" \
  "$HERE/ResourceResolverCheck.java"

"$JAVA" -cp "$CP" ServerConfigCheck
"$JAVA" -cp "$CP" ResourceResolverCheck
