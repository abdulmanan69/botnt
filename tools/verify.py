import struct
import sys
from pathlib import Path

path = Path(sys.argv[1])
blob = path.read_bytes()
MAGIC = b"PHNTBINDv1______"

f = blob[-36:]
assert f[20:36] == MAGIC, "bad magic"
imp_len, doc_len, name_len = struct.unpack("<III", f[:12])
name_off = len(blob) - 36 - name_len
doc_off = name_off - doc_len
imp_off = doc_off - imp_len
name = blob[name_off:name_off + name_len].decode()
doc = blob[doc_off:name_off]
imp = blob[imp_off:doc_off]

print("size", len(blob))
print("stub", blob[:4])
print("implant head", imp[:4], len(imp))
print("doc", name, doc)
print("ok" if imp[:2] in (b"\\x7fE", b"MZ") and doc.startswith(b"%PDF") else "BAD")

