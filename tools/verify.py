"""Inspect a bound artifact: footer, flags, decoy, and (if sealed) decrypt."""

import struct
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"PHNTBINDv2______"
FOOTER = 76

blob = Path(sys.argv[1]).read_bytes()
f = blob[-FOOTER:]
assert f[60:76] == MAGIC, "bad magic"
imp_len, doc_len, name_len, flags = struct.unpack("<IIII", f[:16])
key, nonce = f[16:48], f[48:60]
name_off = len(blob) - FOOTER - name_len
doc_off = name_off - doc_len
imp_off = doc_off - imp_len
name = blob[name_off:name_off + name_len].decode()
doc = blob[doc_off:name_off]
imp = blob[imp_off:doc_off]
if flags & 2:
    imp = AESGCM(key).decrypt(nonce, imp, None)
    sealed = "yes"
else:
    sealed = "no"

print("size", len(blob))
print("flags", flags, "sealed", sealed)
print("stub", blob[:2])
print("implant", imp[:2], len(imp))
print("doc", name, doc)
print("ok" if imp[:2] in (b"\x7fE", b"MZ") and doc.startswith(b"%PDF") else "BAD")
