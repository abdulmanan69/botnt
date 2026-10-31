"""Generate small document-looking .ico files without any external deps.

Windows Explorer renders the icon of the bound executable, so a bound "pdf"
shows a PDF icon instead of a generic .exe icon.
"""

# 3x5 bitmap font, only the glyphs we need
_FONT = {
    "A": ["010", "101", "111", "101", "101"],
    "B": ["110", "101", "110", "101", "110"],
    "C": ["011", "100", "100", "100", "011"],
    "D": ["110", "101", "101", "101", "110"],
    "E": ["111", "100", "110", "100", "111"],
    "F": ["111", "100", "110", "100", "100"],
    "G": ["011", "100", "101", "101", "011"],
    "H": ["101", "101", "111", "101", "101"],
    "I": ["111", "010", "010", "010", "111"],
    "J": ["001", "001", "001", "101", "010"],
    "K": ["101", "101", "110", "101", "101"],
    "L": ["100", "100", "100", "100", "111"],
    "M": ["101", "111", "111", "101", "101"],
    "N": ["101", "111", "111", "111", "101"],
    "O": ["010", "101", "101", "101", "010"],
    "P": ["110", "101", "110", "100", "100"],
    "Q": ["010", "101", "101", "111", "011"],
    "R": ["110", "101", "110", "101", "101"],
    "S": ["011", "100", "010", "001", "110"],
    "T": ["111", "010", "010", "010", "010"],
    "U": ["101", "101", "101", "101", "011"],
    "V": ["101", "101", "101", "101", "010"],
    "W": ["101", "101", "111", "111", "101"],
    "X": ["101", "101", "010", "101", "101"],
    "Y": ["101", "101", "010", "010", "010"],
    "Z": ["111", "001", "010", "100", "111"],
    "0": ["111", "101", "101", "101", "111"],
    "1": ["010", "110", "010", "010", "111"],
    "2": ["110", "001", "010", "100", "111"],
    "3": ["110", "001", "010", "001", "110"],
    "4": ["101", "101", "111", "001", "001"],
    "5": ["111", "100", "110", "001", "110"],
    "6": ["011", "100", "110", "101", "010"],
    "7": ["111", "001", "010", "010", "010"],
    "8": ["010", "101", "010", "101", "010"],
    "9": ["010", "101", "011", "001", "110"],
    "?": ["110", "001", "010", "000", "010"],
}


# kind -> (label, accent colour)
KINDS = {
    "pdf": ("PDF", (0xD9, 0x30, 0x25)),
    "doc": ("DOC", (0x2B, 0x57, 0x9A)),
    "xls": ("XLS", (0x21, 0x7A, 0x3C)),
    "ppt": ("PPT", (0xC4, 0x3E, 0x16)),
    "zip": ("ZIP", (0xB8, 0x8A, 0x1E)),
    "img": ("IMG", (0x6B, 0x3F, 0xA0)),
    "txt": ("TXT", (0x55, 0x5F, 0x6B)),
    "csv": ("CSV", (0x1F, 0x7A, 0x6B)),
    "exe": ("EXE", (0x33, 0x3C, 0x48)),
    "rtf": ("RTF", (0x7A, 0x4A, 0x1E)),
    "apk": ("APK", (0x2E, 0x7D, 0x32)),
    "media": ("VID", (0xA8, 0x2C, 0x6B)),
    "generic": ("", (0x55, 0x5F, 0x6B)),
}

EXT_KIND = {
    ".pdf": "pdf", ".doc": "doc", ".docx": "doc", ".odt": "doc", ".rtf": "rtf",
    ".xls": "xls", ".xlsx": "xls", ".csv": "csv", ".ods": "xls",
    ".ppt": "ppt", ".pptx": "ppt", ".odp": "ppt",
    ".zip": "zip", ".rar": "zip", ".7z": "zip", ".tar": "zip", ".gz": "zip",
    ".jpg": "img", ".jpeg": "img", ".png": "img", ".gif": "img", ".bmp": "img",
    ".webp": "img", ".svg": "img", ".tif": "img", ".tiff": "img",
    ".txt": "txt", ".log": "txt", ".md": "txt", ".ini": "txt", ".json": "txt",
    ".xml": "txt", ".html": "txt", ".htm": "txt",
    ".exe": "exe", ".msi": "exe", ".bat": "exe", ".cmd": "exe",
    ".apk": "apk",
    ".mp4": "media", ".mkv": "media", ".avi": "media", ".mov": "media",
    ".mp3": "media", ".wav": "media", ".flac": "media",
}


def kind_for(filename: str) -> str:
    name = (filename or "").lower()
    for ext, kind in EXT_KIND.items():
        if name.endswith(ext):
            return kind
    return "generic"


def _canvas(size):
    return [[(0, 0, 0, 0) for _ in range(size)] for _ in range(size)]


def _rect(px, x0, y0, x1, y1, color):
    size = len(px)
    for y in range(max(0, y0), min(size, y1)):
        for x in range(max(0, x0), min(size, x1)):
            px[y][x] = color


def _page(px, size, accent):
    """Draw a white page with a folded top-right corner and an accent band."""
    m = max(1, size // 16)
    left, top = m, max(1, size // 10)
    right, bottom = size - m, size - m
    fold = max(3, size // 5)

    _rect(px, left, top, right - fold, bottom, (255, 255, 255, 255))
    _rect(px, left, top, right, top + 1, (196, 202, 210, 255))
    _rect(px, left, top, left + 1, bottom, (196, 202, 210, 255))
    _rect(px, left, bottom - 1, right, bottom, (196, 202, 210, 255))
    _rect(px, right - 1, top, right, bottom, (196, 202, 210, 255))
    _rect(px, right - fold, top, right, top + fold, (228, 232, 238, 255))
    for i in range(fold):
        _rect(px, right - fold + i, top + fold - i - 1,
              right - fold + i + 1, top + fold - i, (168, 174, 182, 255))
    band = max(6, size // 4)
    _rect(px, left, bottom - band, right, bottom, accent + (255,))


def _label(px, size, text, color):
    if not text:
        return
    scale = max(1, size // 16)
    gw, gap, gh = 3 * scale, scale, 5 * scale
    total = len(text) * gw + (len(text) - 1) * gap
    x = (size - total) // 2
    band = max(6, size // 4)
    y = size - band + max(0, (band - gh) // 2)
    for ch in text:
        rows = _FONT.get(ch)
        if rows:
            for ry, row in enumerate(rows):
                for rx, bit in enumerate(row):
                    if bit == "1":
                        _rect(px, x + rx * scale, y + ry * scale,
                              x + rx * scale + scale, y + ry * scale + scale,
                              color)
        x += gw + gap


def _dib(px, size):
    header = bytearray()
    header += (40).to_bytes(4, "little")            # biSize
    header += size.to_bytes(4, "little")            # biWidth
    header += (size * 2).to_bytes(4, "little")      # biHeight (xor + and)
    header += (1).to_bytes(2, "little")             # biPlanes
    header += (32).to_bytes(2, "little")            # biBitCount
    header += (0).to_bytes(4, "little")             # biCompression
    header += (size * size * 4).to_bytes(4, "little")

    xor = bytearray()
    for y in range(size - 1, -1, -1):
        for x in range(size):
            r, g, b, a = px[y][x]
            xor += bytes((b, g, r, a))

    stride = ((size + 31) // 32) * 4
    and_mask = bytearray()
    for y in range(size - 1, -1, -1):
        row = bytearray(stride)
        for x in range(size):
            if px[y][x][3] == 0:
                row[x // 8] |= 0x80 >> (x % 8)
        and_mask += row
    return bytes(header) + bytes(xor) + bytes(and_mask)


def build_ico(kind: str) -> bytes:
    label, accent = KINDS.get(kind, KINDS["generic"])
    sizes = [16, 32, 48]
    images = []
    for size in sizes:
        px = _canvas(size)
        _page(px, size, accent)
        _label(px, size, label, (255, 255, 255, 255) if label else accent)
        images.append(_dib(px, size))

    out = bytearray()
    out += (0).to_bytes(2, "little")      # reserved
    out += (1).to_bytes(2, "little")      # type = icon
    out += (len(sizes)).to_bytes(2, "little")
    offset = 6 + 16 * len(sizes)
    for size, data in zip(sizes, images):
        out += bytes((size if size < 256 else 0, size if size < 256 else 0, 0, 0))
        out += (1).to_bytes(2, "little")
        out += (32).to_bytes(2, "little")
        out += len(data).to_bytes(4, "little")
        out += offset.to_bytes(4, "little")
        offset += len(data)
    for data in images:
        out += data
    return bytes(out)

