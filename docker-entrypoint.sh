#!/bin/sh
# Container entrypoint: make sure the persistent volume layout exists and that
# the runtime keeps a usable Go build cache, then hand over to the server.
set -e

: "${PHANTOM_DATA:=/data}"
: "${PHANTOM_PORT:=8000}"

mkdir -p "$PHANTOM_DATA/builds" /root/.cache/go-build
chmod 700 "$PHANTOM_DATA/psk" 2>/dev/null || true

# keep build artifacts inside the volume so they survive redeploys
case "$PHANTOM_DATA" in
  /data) ;;
  *) mkdir -p "$PHANTOM_DATA/builds" ;;
esac

cd "$(dirname "$0")" 2>/dev/null || true
cd /app/server

exec "$@"
