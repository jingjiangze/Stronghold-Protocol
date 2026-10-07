# one-click Stronghold server, code only.
#
# The image deliberately contains NO game assets: the asset tree is third-party material that
# upstream keeps out of git ("NEVER committed"), so each operator fetches it into a named volume
# with `docker compose run --rm make-assets` (runs the upstream fetch tool) or mounts their own.
FROM node:22-alpine AS base
WORKDIR /game

# git is needed by the updater to diff the two trees inside the build context
RUN apk add --no-cache git

COPY . /game

RUN npm install --no-audit --no-fund --loglevel=error \
 && npm cache clean --force

EXPOSE 3000
ENV HOST=0.0.0.0 PORT=3000 TRUST_PROXY=1

# the updater reads these labels to know what is currently running
ARG SP_SHA=unknown
ARG SP_APP=unknown
LABEL sp.sha=$SP_SHA sp.app=$SP_APP

HEALTHCHECK --interval=20s --timeout=6s --start-period=15s --retries=6 \
  CMD wget -qO- http://127.0.0.1:3000/healthz | grep -q '"ok":true' || exit 1

CMD ["node", "server/index.js"]
