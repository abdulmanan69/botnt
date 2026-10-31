"""Minimal PE resource patcher: injects RT_ICON / RT_GROUP_ICON into an .exe.

Used by the builder so a bound file shows the icon of the document it carries
instead of the generic executable icon. Pure stdlib, no windres needed.
"""

import struct

RT_ICON = 3
RT_GROUP_ICON = 14
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


def _build_rsrc(images, base_rva):
    """Lay out a 3-level resource tree; returns (blob, total_size)."""
    icon_ids = list(range(1, len(images) + 1))
    group_id = 1

    # pre-compute the size of every directory so offsets are known up front
    off = 16 + 2 * 8                      # root: 2 id entries
    type3_dir = off
    off += 16 + len(icon_ids) * 8
    type14_dir = off
    off += 16 + 8
    lang3 = []
    for _ in icon_ids:
        lang3.append(off)
        off += 16 + 8
    lang14 = off
    off += 16 + 8
    data_entries = off
    off += 16 * (len(icon_ids) + 1)
    icon_data = []
    for data in images:
        icon_data.append(off)
        off += _align(len(data), 4)
    group_data = off
    group = _group_blob(images)
    off += _align(len(group), 4)

    blob = bytearray(off)

    def dir_header(at, n):
        struct.pack_into("<IIHHHH", blob, at, 0, 0, 0, 0, 0, n)

    def entry(at, name, target, is_dir):
        struct.pack_into("<II", blob, at, name,
                         (target | DIR) if is_dir else target)

    dir_header(0, 2)
    entry(16, RT_ICON, type3_dir, True)
    entry(24, RT_GROUP_ICON, type14_dir, True)

    dir_header(type3_dir, len(icon_ids))
    for i, iid in enumerate(icon_ids):
        entry(type3_dir + 16 + i * 8, iid, lang3[i], True)

    dir_header(type14_dir, 1)
    entry(type14_dir + 16, group_id, lang14, True)

    for i, iid in enumerate(icon_ids):
        dir_header(lang3[i], 1)
        entry(lang3[i] + 16, LANG_EN, data_entries + i * 16, False)

    dir_header(lang14, 1)
    entry(lang14 + 16, LANG_EN, data_entries + len(icon_ids) * 16, False)

    for i, (_w, _h, _bits, data) in enumerate(images):
        struct.pack_into("<IIII", blob, data_entries + i * 16,
                         base_rva + icon_data[i], len(data), 0, 0)
        blob[icon_data[i]:icon_data[i] + len(data)] = data

    struct.pack_into("<IIII", blob, data_entries + len(icon_ids) * 16,
                     base_rva + group_data, len(group), 0, 0)
    blob[group_data:group_data + len(group)] = group
    return bytes(blob), off


def inject_icon(pe: bytes, ico: bytes) -> bytes:
    """Return a copy of `pe` with `ico` attached as its resource icon."""
    images = parse_ico(ico)
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

    # make room for one more section header if the header area is tight
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

    blob, size = _build_rsrc(images, new_va)
    raw_size = _align(size, file_align)
    blob += b"\0" * (raw_size - size)

    data += blob

    hdr = headers_end
    data[hdr:hdr + 8] = b".rsrc\0\0\0"
    struct.pack_into("<IIIIIIHHI", data, hdr + 8,
                     size, new_va, raw_size, raw_ptr, 0, 0, 0, 0, 0x40000040)
    _put32(data, coff + 2, nsec + 1)

    size_of_image = _align(new_va + size, sec_align)
    _put32(data, opt + 56, size_of_image)
    _put32(data, dd + 2 * 8, new_va)
    _put32(data, dd + 2 * 8 + 4, size)
    _put32(data, opt + 64, 0)  # checksum is not verified for images
    return bytes(data)


def checksum(pe: bytes) -> int:
    """PE checksum (kept for callers that want a valid value)."""
    total = 0
    for i in range(0, len(pe), 2):
        word = pe[i] | ((pe[i + 1] if i + 1 < len(pe) else 0) << 8)
        total = (total + word) & 0xFFFFFFFF
        total = (total & 0xFFFF) + (total >> 16)
    return (total + len(pe)) & 0xFFFFFFFF

