# syntax=docker/dockerfile:1
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.22

# ---- 1. Web UI (static files) ----
FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
COPY server/src/protocol.ts /src/server/src/protocol.ts
RUN npm run build

# ---- 2. Server (TypeScript -> JS, production deps for musl) ----
FROM node:22-alpine AS server
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/ ./
RUN npm run build && npm prune --omit=dev --no-audit --no-fund \
 # The lockfile cannot tell glibc from musl builds; drop the glibc Claude binaries (unusable on Alpine).
 && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64

# ---- 3. Add-on image ----
FROM ${BUILD_FROM}

# git/ripgrep/jq: tools the agents use. bubblewrap: Codex sandbox.
# util-linux-misc: provides `script`, which gives `claude auth login` a terminal.
RUN apk add --no-cache \
      nodejs \
      bash \
      git \
      ripgrep \
      jq \
      bubblewrap \
      util-linux-misc \
      openssh-client \
      ca-certificates

COPY --from=server /src/server/dist /opt/twinmind/server/dist
COPY --from=server /src/server/node_modules /opt/twinmind/server/node_modules
COPY --from=server /src/server/package.json /opt/twinmind/server/package.json
COPY --from=web /src/web/dist /opt/twinmind/web/dist
COPY run.sh /run.sh
RUN chmod a+x /run.sh

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD wget -qO- "http://127.0.0.1:${TWINMIND_PORT:-8099}/healthz" >/dev/null || exit 1

LABEL \
  io.hass.name="Twinmind" \
  io.hass.description="Claude and Codex chat for Home Assistant" \
  io.hass.type="addon" \
  io.hass.version="0.3.3" \
  org.opencontainers.image.source="https://github.com/Gokaku/homeassistant-twinmind"

CMD ["/run.sh"]
