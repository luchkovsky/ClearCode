#!/usr/bin/env python3
"""Generate Clear Copy's toolbar icons.

    python3 tools/make-icons.py

Writes icons/icon16.png, icon48.png and icon128.png. No dependencies — PNGs are
assembled directly with zlib, so this runs anywhere Python does.

The mark is a document sheet with a folded corner and text rules, drawn on the
app's accent blue (#4c8dff). It is rendered per size rather than scaled, so the
16px version stays legible instead of turning to mush.
"""

import os
import struct
import zlib

ACCENT = (0x4C, 0x8D, 0xFF)
SHEET = (0xFF, 0xFF, 0xFF)
RULE = (0xC8, 0xDA, 0xFF)

Canvas = list  # [row][col] -> (r, g, b, a)


def new_canvas(size):
    return [[(0, 0, 0, 0)] * size for _ in range(size)]


def rounded_rect(canvas, x0, y0, x1, y1, radius, colour, alpha=255):
    """Filled rounded rectangle with a 1px analytic antialiased edge."""
    size = len(canvas)
    for y in range(max(0, int(y0) - 1), min(size, int(y1) + 2)):
        for x in range(max(0, int(x0) - 1), min(size, int(x1) + 2)):
            px, py = x + 0.5, y + 0.5
            # Distance outside the rounded rect (0 inside).
            dx = max(x0 + radius - px, 0, px - (x1 - radius))
            dy = max(y0 + radius - py, 0, py - (y1 - radius))
            if dx == 0 and dy == 0:
                inside_x = x0 <= px <= x1
                inside_y = y0 <= py <= y1
                cover = 1.0 if (inside_x and inside_y) else 0.0
            else:
                dist = (dx * dx + dy * dy) ** 0.5
                cover = max(0.0, min(1.0, radius + 0.5 - dist))
            if cover <= 0:
                continue
            blend(canvas, x, y, colour, int(alpha * cover))


def blend(canvas, x, y, colour, alpha):
    if alpha <= 0:
        return
    br, bg, bb, ba = canvas[y][x]
    fr, fg, fb = colour
    a = alpha / 255.0
    out_a = a + ba / 255.0 * (1 - a)
    if out_a <= 0:
        canvas[y][x] = (0, 0, 0, 0)
        return
    r = (fr * a + br * (ba / 255.0) * (1 - a)) / out_a
    g = (fg * a + bg * (ba / 255.0) * (1 - a)) / out_a
    b = (fb * a + bb * (ba / 255.0) * (1 - a)) / out_a
    canvas[y][x] = (int(r + 0.5), int(g + 0.5), int(b + 0.5), int(out_a * 255 + 0.5))


def draw_icon(size):
    c = new_canvas(size)
    s = size / 128.0  # design at 128 and scale

    # Rounded-square background in the accent colour.
    pad = 6 * s
    rounded_rect(c, pad, pad, size - pad, size - pad, 26 * s, ACCENT)

    # Document sheet.
    sx0, sy0 = 34 * s, 26 * s
    sx1, sy1 = 94 * s, 102 * s
    fold = 20 * s  # folded corner
    radius = max(1.0, 4 * s)
    rounded_rect(c, sx0, sy0, sx1, sy1, radius, SHEET)

    # Cut the top-right corner away, then lay the fold over it.
    for y in range(int(sy0) - 1, int(sy0 + fold) + 2):
        for x in range(int(sx1 - fold) - 1, int(sx1) + 2):
            if 0 <= x < size and 0 <= y < size:
                # Above the diagonal running from (sx1-fold, sy0) to (sx1, sy0+fold)
                if (x + 0.5 - (sx1 - fold)) + (sy0 + fold - (y + 0.5)) > fold:
                    c[y][x] = (0, 0, 0, 0)
    # Fold shadow triangle.
    for y in range(int(sy0), int(sy0 + fold) + 1):
        for x in range(int(sx1 - fold), int(sx1) + 1):
            if 0 <= x < size and 0 <= y < size:
                dx = x + 0.5 - (sx1 - fold)
                dy = y + 0.5 - sy0
                if dy <= dx <= fold and dy >= 0:
                    blend(c, x, y, RULE, 255)

    # Text rules on the sheet. At 16px four rules collapse into a smudge, so
    # drop to two thicker ones — the mark has to read as "document", not as
    # legible text, and fewer strokes survive the downscale.
    if size <= 24:
        rules, line_h, gap = 2, max(1.0, 8 * s), 20 * s
    elif size <= 64:
        rules, line_h, gap = 3, max(1.0, 6 * s), 16 * s
    else:
        rules, line_h, gap = 4, max(1.0, 5 * s), 13 * s

    top = sy0 + 30 * s
    for i in range(rules):
        y = top + i * gap
        if y + line_h > sy1 - 6 * s:
            break
        # Last rule is short, the way a paragraph ends.
        right = sx1 - (10 * s if i < rules - 1 else 26 * s)
        rounded_rect(c, sx0 + 10 * s, y, right, y + line_h, line_h / 2, RULE)

    return c


def write_png(path, canvas):
    size = len(canvas)
    raw = bytearray()
    for row in canvas:
        raw.append(0)  # filter type 0 (None)
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        out = struct.pack('>I', len(data)) + tag + data
        return out + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')

    with open(path, 'wb') as fh:
        fh.write(png)
    return len(png)


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(here, 'icons')
    os.makedirs(out_dir, exist_ok=True)

    for size in (16, 48, 128):
        path = os.path.join(out_dir, f'icon{size}.png')
        written = write_png(path, draw_icon(size))
        print(f'wrote icons/icon{size}.png  ({size}x{size}, {written} bytes)')


if __name__ == '__main__':
    main()
