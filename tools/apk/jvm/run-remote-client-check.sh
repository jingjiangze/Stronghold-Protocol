#!/usr/bin/env bash
# Build + run the pure-JVM checks for the「服务端界面」default + its two hard guards + the hot-update
# health invariant.
#
#   bash tools/apk/jvm/run-remote-client-check.sh
#
# HostPolicy and RemoteClientPolicy carry no Android dependency by design (see each file's header),
# so a bare JDK 17 is enough — no org.json either (the decision is plain booleans + host strings).
# Kept as a script so the exact source list lives in one place and CI can call the same line.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

JDK_BIN="${JDK_BIN:-C:/Users/16891/android-build/jdk-extracted/jdk-17.0.20.1+1/bin}"
JAVAC="$JDK_BIN/javac"
JAVA="$JDK_BIN/java"
OUT="${SP_JVM_OUT:-C:/DDDD/Agent Work/_spjvm-remote-client}"

SRC="$REPO/android/app/src/main/java/icu/jiangjiangze/stronghold"

mkdir -p "$OUT"

"$JAVAC" -encoding UTF-8 -d "$OUT" \
  "$SRC/HostPolicy.java" \
  "$SRC/RemoteClientPolicy.java" \
  "$HERE/RemoteClientCheck.java"

"$JAVA" -cp "$OUT" RemoteClientCheck
