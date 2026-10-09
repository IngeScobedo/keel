#!/usr/bin/env python3
"""Convierte un PNG RGB/RGBA de 8 bits a escala de grises (luminancia Rec. 709)
sin dependencias. Sirve para verificar que las formas de estado se distinguen sin
color (ADR-0006). Uso: png-grayscale.py entrada.png salida.png [zoom]"""
import struct
import sys
import zlib


def read_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "no es PNG"
    pos, idat, w, h, ctype = 8, b"", 0, 0, 0
    while pos < len(data):
        (ln,) = struct.unpack(">I", data[pos : pos + 4])
        typ = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + ln]
        if typ == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and interlace == 0 and ctype in (2, 6), f"PNG no soportado: depth={depth} ctype={ctype}"
        elif typ == b"IDAT":
            idat += body
        pos += 12 + ln
    raw = zlib.decompress(idat)
    bpp = 4 if ctype == 6 else 3
    stride = w * bpp
    rows, prev, p = [], bytearray(stride), 0
    for _ in range(h):
        f = raw[p]
        line = bytearray(raw[p + 1 : p + 1 + stride])
        p += 1 + stride
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 255
            elif f == 2:
                line[i] = (line[i] + b) & 255
            elif f == 3:
                line[i] = (line[i] + ((a + b) >> 1)) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line)
        prev = line
    return w, h, bpp, rows


def write_png_gray(path, w, h, rows, zoom):
    out = bytearray()
    for row in rows:
        line = bytes(v for v in row for _ in range(zoom))
        for _ in range(zoom):
            out += b"\x00" + line
    def chunk(t, b):
        return struct.pack(">I", len(b)) + t + b + struct.pack(">I", zlib.crc32(t + b) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w * zoom, h * zoom, 8, 0, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(out), 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(png)


src, dst = sys.argv[1], sys.argv[2]
zoom = int(sys.argv[3]) if len(sys.argv) > 3 else 1
w, h, bpp, rows = read_png(src)
gray = []
for row in rows:
    g = bytearray(w)
    for x in range(w):
        r, gg, b = row[x * bpp], row[x * bpp + 1], row[x * bpp + 2]
        g[x] = int(0.2126 * r + 0.7152 * gg + 0.0722 * b)
    gray.append(g)
write_png_gray(dst, w, h, gray, zoom)
print(f"{dst}: {w*zoom}x{h*zoom}")
