#!/bin/sh
# Container entrypoint: create the persistent volume layout, generate the
# secrets that were left empty, print what the container will actually do, and
# hand over to the server. Everything here is idempotent, so a redeploy on the
# same volume keeps the credentials and the PSK.
set -e

: "${PHANTOM_DATA:=/data}"
: "${PHANTOM_PORT:=80}"
: "${PHANTOM_HOST:=0.0.0.0}"

mkdir -p "$PHANTOM_DATA/builds" "${PHANTOM_BUILDS:-$PHANTOM_DATA/builds}" /root/.cache/go-build 2>/dev/null || true

if ! [ -w "$PHANTOM_DATA" ]; then
  echo "[!] PHANTOM_DATA=$PHANTOM_DATA is not writable - secrets and builds will be lost on redeploy"
  echo "    mount a persistent volume at /data and keep PHANTOM_DATA=/data"
fi

# --- dashboard credentials: generated once, persisted in the volume, printed ---
case "${PHANTOM_AUTH:-}" in
  "")
    auth_file="$PHANTOM_DATA/auth"
    if [ -s "$auth_file" ]; then
      PHANTOM_AUTH=$(cat "$auth_file")
    else
      PHANTOM_AUTH="admin:$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 20)"
      printf '%s' "$PHANTOM_AUTH" > "$auth_file"
      chmod 600 "$auth_file"
    fi
    export PHANTOM_AUTH
    echo "[*] dashboard login (generated, persisted in ${auth_file}): ${PHANTOM_AUTH}"
    ;;
  *:*) ;;
  *) echo "[!] PHANTOM_AUTH has no ':' (expected user:password) - dashboard auth disabled" ;;
esac

# --- pre-shared key: same contract, generated once and persisted ---
if [ -z "${PHANTOM_PSK:-}" ]; then
  psk_file="$PHANTOM_DATA/psk"
  if [ -s "$psk_file" ]; then
    PHANTOM_PSK=$(tr -d ' \r\n' < "$psk_file")
  else
    PHANTOM_PSK=$(tr -dc 'a-f0-9' < /dev/urandom | head -c 64)
    printf '%s' "$PHANTOM_PSK" > "$psk_file"
  fi
  chmod 700 "$psk_file" 2>/dev/null || true
  export PHANTOM_PSK
  echo "[*] beacon PSK (generated, persisted in ${psk_file}): ${PHANTOM_PSK}"
elif [ ${#PHANTOM_PSK} -ne 64 ]; then
  echo "[!] PHANTOM_PSK must be 64 hex characters (openssl rand -hex 32) - got ${#PHANTOM_PSK}"
  exit 1
else
  case "$PHANTOM_PSK" in
    *[!0-9a-fA-F]*)
      echo "[!] PHANTOM_PSK must be hex only (0-9, a-f) - use: openssl rand -hex 32"
      exit 1 ;;
  esac
  echo "[*] beacon PSK: supplied via PHANTOM_PSK"
fi

case "$(echo "${PHANTOM_DEFAULT_PSK:-0}" | tr 'A-Z' 'a-z')" in
  1|true|yes|on) echo "[i] PHANTOM_DEFAULT_PSK is on: the shipped dev key is used unless PHANTOM_PSK is set" ;;
esac

# --- deployment sanity checks: these are the settings that cause a 502 ---
case "$PHANTOM_HOST" in
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

case "$PHANTOM_PORT" in
  ''|*[!0-9]*) echo "[!] PHANTOM_PORT=${PHANTOM_PORT} is not numeric - keep it at 80" ;;
esac

echo "[*] phantom entrypoint: listening target ${PHANTOM_HOST}:${PHANTOM_PORT} data=${PHANTOM_DATA}"
echo "[*] options: tls=${PHANTOM_TLS:-false} socks=${PHANTOM_SOCKS:-true} garble=${PHANTOM_GARBLE:-false} upx=${PHANTOM_UPX:-false} encrypt=${PHANTOM_ENCRYPT:-true} metadata=${PHANTOM_METADATA:-true}"
case "${PHANTOM_PUBLIC_URL:-}" in
  "") echo "[*] callback url: auto-detected per request (set PHANTOM_PUBLIC_URL to pin it)" ;;
  *) echo "[*] callback url: ${PHANTOM_PUBLIC_URL}" ;;
esac

cd "$(dirname "$0")" 2>/dev/null || true
cd /app/server

exec "$@"
