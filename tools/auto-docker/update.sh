#!/bin/sh
# update.sh -- blue/green auto-update for the Docker server. Same gates as the Windows version:
#   1. only a change under the server paths may restart anything
#   2. never move backwards (version, then ancestor check)
#   3. a PROTOCOL_VERSION change refuses to deploy and asks a human instead
#   4. the staged build must pass its own health check before it can receive players
# Drain afterwards: the old container is stopped only once it has no sockets (or after TTL).
set -eu
REPO=${REPO:-https://github.com/sganggs/Stronghold-Protocol.git}
BRANCH=${BRANCH:-master}
SERVER_PATHS="server shared data package.json package-lock.json"
TTL=${DRAIN_TTL_MIN:-45}
HERE=$(cd "$(dirname "$0")" && pwd)
STATE=$HERE/state.json
say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
hz() { curl -fsS -m 8 "http://127.0.0.1:8080$1" 2>/dev/null || true; }

[ -f "$HERE/.lock" ] && [ "$(( $(date +%s) - $(stat -c %Y "$HERE/.lock" 2>/dev/null || echo 0) ))" -lt 5400 ] \
  && { say "another run active -> exit"; exit 0; }
: > "$HERE/.lock"; trap 'rm -f "$HERE/.lock"' EXIT

if [ -f "$HERE/PAUSE_AUTOUPDATE" ]; then say "PAUSE_AUTOUPDATE present -> nothing done"; exit 0; fi
FORCE=0; [ -f "$HERE/FORCE" ] && { FORCE=1; say "FORCE set"; }

# ---- which side is live, and what is upstream ----
LIVE=$(sed -n 's/.*server \([a-z]*\):300.*/\1/p' "$HERE/nginx/upstream.conf" | head -1)
IDLE=$([ "$LIVE" = blue ] && echo green || echo blue)
say "live=$LIVE idle=$IDLE"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"; rm -f "$HERE/.lock"' EXIT
git clone -q --depth 80 --single-branch --branch "$BRANCH" "$REPO" "$WORK" || { say "clone failed -> retry next cycle"; exit 0; }
NEW=$(git -C "$WORK" rev-parse HEAD)
TAG=$(git -C "$WORK" tag --list 'v*' --sort=-v:refname | head -1)
CUR=$(docker inspect --format '{{index .Config.Labels "sp.sha"}}' "${LIVE}" 2>/dev/null || echo unknown)
CURAPP=$(docker inspect --format '{{index .Config.Labels "sp.app"}}' "${LIVE}" 2>/dev/null || echo '?')
say "upstream $BRANCH=$NEW tag=$TAG running=$CUR app=$CURAPP"
[ "$CUR" = "$NEW" ] && [ "$FORCE" = 0 ] && { say "already current"; exit 0; }

# ---- gate 1: server-relevant change only ----
if [ "$CUR" != unknown ] && [ "$FORCE" = 0 ]; then
  if [ -z "$(git -C "$WORK" diff --name-only "$CUR" "$NEW" -- $SERVER_PATHS 2>/dev/null || echo x)" ]; then
    say "no change under $SERVER_PATHS -> record head, no restart"; exit 0
  fi
  say "server-relevant change -> proceeding"
fi

# ---- gates 2 and 3 ----
NEWAPP=$(sed -n "s/.*APP_VERSION = '\([^']*\)'.*/\1/p" "$WORK/shared/constants.js" | head -1)
NEWPROTO=$(sed -n 's/.*PROTOCOL_VERSION = \([0-9]*\).*/\1/p' "$WORK/shared/constants.js" | head -1)
LIVEPROTO=$(echo "$(hz /healthz)" | sed -n 's/.*"version":\([0-9]*\).*/\1/p')
say "incoming app=$NEWAPP proto=$NEWPROTO (running proto=$LIVEPROTO)"
if [ -n "$LIVEPROTO" ] && [ -n "$NEWPROTO" ] && [ "$NEWPROTO" != "$LIVEPROTO" ]; then
  printf '{"at":"%s","reason":"PROTOCOL_VERSION change","from":"%s","to":"%s","sha":"%s"}\n' \
    "$(date -Is)" "$LIVEPROTO" "$NEWPROTO" "$NEW" > "$HERE/ALERT_PROTOCOL_CHANGE.json"
  : > "$HERE/PAUSE_AUTOUPDATE"
  say "protocol change -> paused for a human"; exit 0
fi
if [ "$CUR" != unknown ] && git -C "$WORK" merge-base --is-ancestor "$NEW" "$CUR" 2>/dev/null && [ "$NEW" != "$CUR" ]; then
  say "refusing downgrade (target is an ancestor)"; exit 0
fi

# ---- build + stage the idle side, sharing the same asset volume ----
docker build -q -f "$HERE/Dockerfile" --build-arg SP_SHA="$NEW" --build-arg SP_APP="$NEWAPP" -t "stronghold:$IDLE" "$WORK/.." >/dev/null
docker compose -f "$HERE/docker-compose.yml" up -d "$IDLE"
ok=0; i=0
while [ $i -lt 30 ]; do
  i=$((i+1)); sleep 2
  if docker inspect --format '{{.State.Health.Status}}' "$IDLE" 2>/dev/null | grep -q healthy; then ok=1; break; fi
done
if [ $ok = 0 ]; then
  say "staged build never became healthy -> not flipping"
  docker compose -f "$HERE/docker-compose.yml" stop "$IDLE" >/dev/null || true
  printf '{"at":"%s","sha":"%s","reason":"staged container unhealthy"}\n' "$(date -Is)" "$NEW" > "$HERE/ALERT_STAGE_FAILED.json"
  exit 2
fi
say "staged $IDLE healthy (app $NEWAPP)"
[ -f "$HERE/STAGE_ONLY" ] && { say "STAGE_ONLY -> no flip"; docker compose -f "$HERE/docker-compose.yml" stop "$IDLE" >/dev/null; exit 0; }

# ---- flip: one line + reload. open sockets stay on the old worker ----
printf 'upstream sp_current {\n    server %s:300%s;\n    keepalive 48;\n}\n' "$IDLE" "$([ "$IDLE" = blue ] && echo 0 || echo 1)" > "$HERE/nginx/upstream.conf"
docker compose -f "$HERE/docker-compose.yml" exec -T front nginx -t
docker compose -f "$HERE/docker-compose.yml" exec -T front nginx -s reload
sleep 4
say "through front: $(hz /healthz | cut -c1-90)"

# ---- drain the old side ----
say "draining $LIVE (ttl ${TTL}m)"
end=$(( $(date +%s) + TTL * 60 )); streak=0
while [ $(date +%s) -lt $end ]; do
  sleep 20
  s=$(hz /healthz | sed -n 's/.*"sockets":\([0-9]*\).*/\1/p')
  [ -z "$s" ] && { say "old side gone -> retired"; break; }
  [ "$s" = 0 ] && streak=$((streak+1)) || streak=0
  say "old sockets=$s streak=$streak"
  [ $streak -ge 3 ] && break
done
docker compose -f "$HERE/docker-compose.yml" stop "$LIVE" >/dev/null || true
docker compose -f "$HERE/docker-compose.yml" rm -f "$LIVE" >/dev/null || true

printf '{"branch":"%s","sha":"%s","app":"%s","proto":"%s","live":"%s","tag":"%s","updatedAt":"%s"}\n' \
  "$BRANCH" "$NEW" "$NEWAPP" "$NEWPROTO" "$IDLE" "$TAG" "$(date -Is)" > "$STATE"
[ $FORCE = 1 ] && rm -f "$HERE/FORCE"
say "done: $LIVE -> $IDLE, app $CURAPP -> $NEWAPP"
