#!/bin/sh
# Local bootstrap (no Docker). For production use the Dockerfile instead.
set -e
cd "$(dirname "$0")"

command -v go >/dev/null 2>&1 || { echo "[!] Go toolchain required"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "[!] python3 required"; exit 1; }

echo "[*] python deps"
python3 -m venv .venv 2>/dev/null || true
. .venv/bin/activate
pip install -q -r requirements.txt

echo "[*] priming go build cache for every target"
cd implant
for t in windows/amd64 linux/amd64 darwin/amd64; do
  os=${t%/*}; arch=${t#*/}
  extra=""; [ "$os" = windows ] && extra="-H windowsgui"
  GOOS=$os GOARCH=$arch CGO_ENABLED=0 go build -trimpath -buildvcs=false \
    -ldflags "-s -w $extra" -o /dev/null . || exit 1
done
cd ../server/stub
for t in windows/amd64 linux/amd64; do
  os=${t%/*}; arch=${t#*/}
  extra=""; [ "$os" = windows ] && extra="-H windowsgui"
  GOOS=$os GOARCH=$arch CGO_ENABLED=0 go build -trimpath -buildvcs=false \
    -ldflags "-s -w $extra" -o /dev/null . || exit 1
done
cd ..

echo "[*] generating psk"
mkdir -p server/data
[ -f server/data/psk ] || python3 -c "import secrets;open('server/data/psk','w').write(secrets.token_hex(32))"

echo "[*] ready"
echo "    export PHANTOM_AUTH=admin:\$(python3 -c 'import secrets;print(secrets.token_urlsafe(12))')"
echo "    cd server && python3 server.py"
