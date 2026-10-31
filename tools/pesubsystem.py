import struct
import sys

blob = open(sys.argv[1], "rb").read()
e = struct.unpack_from("<I", blob, 0x3C)[0]
assert blob[e:e + 4] == b"PE\0\0"
coff = e + 4
opt = coff + 20
magic = struct.unpack_from("<H", blob, opt)[0]
print("magic %#x" % magic)
print("subsystem", struct.unpack_from("<H", blob, opt + 68)[0], "(2 = windowsgui)")
dd = opt + (112 if magic == 0x20B else 96)
print("rsrc rva/size", struct.unpack_from("<II", blob, dd + 16))
print("size", len(blob))
