"""Renders the dashboard's own app icon (home screen / installed app) as PNGs, with no
dependencies beyond the standard library: a dark square with a light dot, like the favicon.
Full-bleed, so the same file works as a "maskable" icon.

    python3 icons-src/app-icon.py
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'public')

BACKGROUND = (0x22, 0x22, 0x20)
DOT = (0xF6, 0xF5, 0xF2)
DOT_RADIUS = 0.19  # of the icon size
SAMPLES = 4  # per axis, for anti-aliasing


def render(size):
    rows = []
    centre = size / 2
    radius = size * DOT_RADIUS
    for y in range(size):
        row = bytearray([0])  # PNG filter type: none
        for x in range(size):
            inside = 0
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    dx = x + (sx + 0.5) / SAMPLES - centre
                    dy = y + (sy + 0.5) / SAMPLES - centre
                    if dx * dx + dy * dy <= radius * radius:
                        inside += 1
            a = inside / (SAMPLES * SAMPLES)
            row.extend(round(b + (d - b) * a) for b, d in zip(BACKGROUND, DOT))
        rows.append(bytes(row))
    return png(size, b''.join(rows))


def png(size, raw):
    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body))

    header = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


for name, size in [('icon-192.png', 192), ('icon-512.png', 512), ('apple-touch-icon.png', 180)]:
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(render(size))
    print(f'wrote public/{name}')
