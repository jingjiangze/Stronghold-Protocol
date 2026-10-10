#!/usr/bin/env bash
# Build + run the pure-JVM checks for the cold-start default line (业主口径 2026-10-10 审计修正后：
# 「默认打开就是本地服务」——默认落在单人服务器；**只有显式选择标记（originSource=user）才尊重
# origin**，老装机遗留值/失败兜底写的 auto 一律按未选择处理进本机服务).
#
#   bash tools/apk/jvm/run-startup-origin-check.sh
#
# StartupOriginPolicy carries no Android dependency by design (see its header), so a bare JDK 17
# is enough — no org.json either (the decision is plain strings). Kept as a script so the exact
# source list lives in one place and CI can call the same line.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

JDK_BIN="${JDK_BIN:-C:/Users/16891/android-build/jdk-extracted/jdk-17.0.20.1+1/bin}"
JAVAC="$JDK_BIN/javac"
JAVA="$JDK_BIN/java"
OUT="${SP_JVM_OUT:-C:/DDDD/Agent Work/_spjvm-startup-origin}"

SRC="$REPO/android/app/src/main/java/icu/jiangjiangze/stronghold"

mkdir -p "$OUT"

"$JAVAC" -encoding UTF-8 -d "$OUT" \
  "$SRC/StartupOriginPolicy.java" \
  "$HERE/StartupOriginCheck.java"

"$JAVA" -cp "$OUT" StartupOriginCheck
