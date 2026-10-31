"""Minimal PE resource patcher.

Injects arbitrary resources (icons, RT_VERSION metadata, RT_MANIFEST) into an
executable. Pure stdlib — no windres / rsrc toolchain needed.

Resources matter for evasion: a binary that carries vendor metadata, a manifest
and an icon looks like a normal signed-up application instead of a bare "Go
dropper", which knocks the ML verdict (Trojan:Win32/Bearfoos.A!ml and friends)
down a lot.
"""

import struct

RT_ICON = 3
RT_GROUP_ICON = 14
RT_VERSION = 16
RT_MANIFEST = 24
LANG_EN = 1033

DIR = 0x80000000


class PEError(Exception):
    pass


def _u16(b, off):
    return struct.unpack_from("<H", b, off)[0]


def _u32(b, off):
    return struct.unpack_from("<I", b, off)[0]


def _put32(b, off, val):
    struct.pack_into("<I", b, off, val)


def _align(v, a):
    return (v + a - 1) // a * a


def parse_ico(ico: bytes):
    if len(ico) < 6 or _u16(ico, 0) != 0 or _u16(ico, 2) != 1:
        raise PEError("not an icon file")
    count = _u16(ico, 4)
    if count == 0 or count > 64:
        raise PEError("bad icon count")
    out = []
    for i in range(count):
        base = 6 + i * 16
        w, h = ico[base], ico[base + 1]
        bits = _u16(ico, base + 6)
        size = _u32(ico, base + 8)
        off = _u32(ico, base + 12)
        if off + size > len(ico) or size == 0:
            raise PEError("truncated icon entry")
        out.append((w, h, bits, ico[off:off + size]))
    return out


def _group_blob(images):
    blob = bytearray(struct.pack("<HHH", 0, 1, len(images)))
    for idx, (w, h, bits, data) in enumerate(images, start=1):
        blob += struct.pack("<BBBBHHIH", w, h, 0, 0, 1, bits or 32,
                            len(data), idx)
    return bytes(blob)


def _build_rsrc(items, base_rva):
    """items: iterable of (type_id, name_id, data). Returns (blob, size)."""
    groups = {}
    for rtype, rid, data in items:
        groups.setdefault(rtype, {})[rid] = data
    types = sorted(groups)

    off = 16 + len(types) * 8
    type_dirs = {}
    for rtype in types:
        type_dirs[rtype] = off
        off += 16 + len(groups[rtype]) * 8
    lang_dirs = {}
    for rtype in types:
        for rid in sorted(groups[rtype]):
            lang_dirs[(rtype, rid)] = off
            off += 16 + 8
    data_entries = off
    total_ids = sum(len(v) for v in groups.values())
    off += 16 * total_ids
    data_offs = {}
    for rtype in types:
        for rid in sorted(groups[rtype]):
            data_offs[(rtype, rid)] = off
            off += _align(len(groups[rtype][rid]), 4)

    blob = bytearray(off)

    def dir_header(at, n):
        struct.pack_into("<IIHHHH", blob, at, 0, 0, 0, 0, 0, n)

    def entry(at, name, target, is_dir):
        struct.pack_into("<II", blob, at, name,
                         (target | DIR) if is_dir else target)

    dir_header(0, len(types))
    idx = 0
    for rtype in types:
        entry(16 + idx * 8, rtype, type_dirs[rtype], True)
        idx += 1

    idx = 0
    for rtype in types:
        dir_header(type_dirs[rtype], len(groups[rtype]))
        for i, rid in enumerate(sorted(groups[rtype])):
            entry(type_dirs[rtype] + 16 + i * 8, rid,
                  lang_dirs[(rtype, rid)], True)

    n = 0
    for rtype in types:
        for rid in sorted(groups[rtype]):
            d = lang_dirs[(rtype, rid)]
            dir_header(d, 1)
            entry(d + 16, LANG_EN, data_entries + n * 16, False)
            n += 1

    n = 0
    for rtype in types:
        for rid in sorted(groups[rtype]):
            payload = groups[rtype][rid]
            at = data_offs[(rtype, rid)]
            struct.pack_into("<IIII", blob, data_entries + n * 16,
                             base_rva + at, len(payload), 0, 0)
            blob[at:at + len(payload)] = payload
            n += 1
    return bytes(blob), off


def inject(pe: bytes, items) -> bytes:
    """Return a copy of `pe` with the given resources attached."""
    items = list(items)
    if not items:
        return pe
    data = bytearray(pe)

    if len(data) < 0x40 or data[:2] != b"MZ":
        raise PEError("not a PE image")
    e_lfanew = _u32(data, 0x3C)
    if data[e_lfanew:e_lfanew + 4] != b"PE\0\0":
        raise PEError("missing PE signature")

    coff = e_lfanew + 4
    nsec = _u16(data, coff + 2)
    opt_size = _u16(data, coff + 16)
    opt = coff + 20
    if _u16(data, opt) not in (0x10B, 0x20B):
        raise PEError("bad optional header")
    pe32plus = _u16(data, opt) == 0x20B

    sec_align = _u32(data, opt + 32)
    file_align = _u32(data, opt + 36)
    if sec_align == 0 or file_align == 0:
        raise PEError("bad alignment")
    dd = opt + (112 if pe32plus else 96)
    n_rva = _u32(data, opt + (108 if pe32plus else 92))
    if n_rva < 3:
        raise PEError("no resource directory slot")

    sections = opt + opt_size
    headers_end = sections + nsec * 40
    first_raw = _u32(data, sections + 20)

    if headers_end + 40 > first_raw:
        pad = file_align
        data[first_raw:first_raw] = b"\0" * pad
        for i in range(nsec):
            ptr = _u32(data, sections + i * 40 + 20)
            if ptr >= first_raw:
                _put32(data, sections + i * 40 + 20, ptr + pad)
        _put32(data, opt + 60, _u32(data, opt + 60) + pad)  # SizeOfHeaders
        first_raw += pad

    last = sections + (nsec - 1) * 40
    last_va = _u32(data, last + 12)
    last_vsize = _u32(data, last + 8)
    last_raw_end = _u32(data, last + 20) + _u32(data, last + 16)

    new_va = _align(last_va + last_vsize, sec_align)
    raw_ptr = _align(max(len(data), last_raw_end), file_align)
    if raw_ptr > len(data):
        data += b"\0" * (raw_ptr - len(data))

    blob, size = _build_rsrc(items, new_va)
    raw_size = _align(size, file_align)
    blob += b"\0" * (raw_size - size)

    data += blob

    hdr = headers_end
    data[hdr:hdr + 8] = b".rsrc\0\0\0"
    struct.pack_into("<IIIIIIHHI", data, hdr + 8,
                     size, new_va, raw_size, raw_ptr, 0, 0, 0, 0, 0x40000040)
    _put32(data, coff + 2, nsec + 1)

    _put32(data, opt + 56, _align(new_va + size, sec_align))  # SizeOfImage
    _put32(data, dd + 2 * 8, new_va)
    _put32(data, dd + 2 * 8 + 4, size)
    _put32(data, opt + 64, 0)  # checksum is not verified for images
    return bytes(data)


def icon_items(ico: bytes, first_id: int = 1):
    """Expand an .ico into (RT_ICON..) / (RT_GROUP_ICON..) resource items."""
    images = parse_ico(ico)
    items = []
    for idx, (_w, _h, _bits, data) in enumerate(images, start=first_id):
        items.append((RT_ICON, idx, data))
    items.append((RT_GROUP_ICON, 1, _group_blob(images)))
    return items


def inject_icon(pe: bytes, ico: bytes) -> bytes:
    return inject(pe, icon_items(ico))


def checksum(pe: bytes) -> int:
    """PE checksum (kept for callers that want a valid value)."""
    total = 0
    for i in range(0, len(pe), 2):
        word = pe[i] | ((pe[i + 1] if i + 1 < len(pe) else 0) << 8)
        total = (total + word) & 0xFFFFFFFF
        total = (total & 0xFFFF) + (total >> 16)
    return (total + len(pe)) & 0xFFFFFFFF

