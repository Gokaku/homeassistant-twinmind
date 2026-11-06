#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -euo pipefail

# Everything the CLIs store (logins, sessions) lives in the add-on's private /data.
export HOME=/data/home
export CLAUDE_CONFIG_DIR=/data/claude
export CODEX_HOME=/data/codex
mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR" "$CODEX_HOME" /data/conversations /data/uploads
chmod 700 /data/home /data/claude /data/codex /data/conversations /data/uploads

export TWINMIND_DATA_DIR=/data
export TWINMIND_WORKDIR=/config
export TWINMIND_PORT="$(bashio::addon.ingress_port)"
export TWINMIND_WEB_DIR=/opt/twinmind/web/dist

# Updates come with new add-on versions, not from inside the container.
export DISABLE_AUTOUPDATER=1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

if bashio::config.true 'debug'; then
  export TWINMIND_DEBUG=1
fi

# The Supervisor token is now in this process's environment. Remove s6's on-disk copy so
# commands run by the assistants cannot simply read it from there. (Twinmind also strips
# it from the assistants' environment.)
rm -f /run/s6/container_environment/SUPERVISOR_TOKEN /run/s6/container_environment/HASSIO_TOKEN \
      /var/run/s6/container_environment/SUPERVISOR_TOKEN /var/run/s6/container_environment/HASSIO_TOKEN

bashio::log.info "Starting Twinmind on ingress port ${TWINMIND_PORT}"
cd /config
exec node /opt/twinmind/server/dist/index.js
