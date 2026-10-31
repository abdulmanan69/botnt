#!/bin/sh
# Container entrypoint: make sure the persistent volume layout exists and that
# the runtime keeps a usable Go build cache, then hand over to the server.
set -e

: "${PHANTOM_DATA:=/data}"
: "${PHANTOM_PORT:=80}"

# --- dashboard credentials: generated once, persisted in the volume, printed ---
case "${PHANTOM_AUTH:-}" in
  "")
    auth_file="$PHANTOM_DATA/auth"
    if [ -s "$auth_file" ]; then
      PHANTOM_AUTH=$(cat "$auth_file")
    else
      PHANTOM_AUTH="admin:$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 20)"
      mkdir -p "$PHANTOM_DATA"
      printf '%s' "$PHANTOM_AUTH" > "$auth_file"
      chmod 600 "$auth_file"
    fi
    export PHANTOM_AUTH
    echo "[*] dashboard login (generated, persisted in ${auth_file}): ${PHANTOM_AUTH}"
    ;;
  *:*) ;;
  *) echo "[!] PHANTOM_AUTH has no ':' (expected user:password) - dashboard auth disabled" ;;
esac

# --- deployment sanity checks: these are the two settings that cause a 502 ---
case "${PHANTOM_HOST:-0.0.0.0}" in
  127.0.0.1|localhost|::1)
    echo "[!] PHANTOM_HOST=${PHANTOM_HOST} is loopback only;"
    echo "    the Coolify proxy will get 502 - use 0.0.0.0 instead" ;;
esac

case "$(echo "${PHANTOM_TLS:-0}" | tr 'A-Z' 'a-z')" in
  1|true|yes|on)
    if [ "$PHANTOM_PORT" = "80" ]; then
      echo "[!] PHANTOM_TLS is on: the proxy must reach this container over https,"
      echo "    but the domain stays https://your.domain (port 80 is the proxy default)"
    else
      echo "[!] PHANTOM_TLS is on: the proxy must reach this container over https,"
      echo "    so the domain must be https://your.domain:${PHANTOM_PORT}"
    fi ;;
esac

echo "[*] phantom entrypoint: listening target ${PHANTOM_HOST:-0.0.0.0}:${PHANTOM_PORT} data=${PHANTOM_DATA}"

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
