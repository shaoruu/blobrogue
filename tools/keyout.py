#!/usr/bin/env python3
# keyout.py — remove light/white background from a sprite via edge flood-fill, trim, center, resize.
# Usage: python3 keyout.py <in.png> <out.png> [size]
import sys
from collections import deque
from PIL import Image

def keyout(path, out, size=64):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    px = im.load()
    def is_bg(r, g, b):
        mx, mn = max(r, g, b), min(r, g, b)
        return mx > 165 and (mx - mn) < 34
    visited = bytearray(w * h)
    dq = deque()
    for x in range(w):
        dq.append((x, 0)); dq.append((x, h - 1))
    for y in range(h):
        dq.append((0, y)); dq.append((w - 1, y))
    while dq:
        x, y = dq.popleft()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        i = y * w + x
        if visited[i]:
            continue
        r, g, b, a = px[x, y]
        if not is_bg(r, g, b):
            continue
        visited[i] = 1
        px[x, y] = (r, g, b, 0)
        dq.append((x+1,y)); dq.append((x-1,y)); dq.append((x,y+1)); dq.append((x,y-1))
    bbox = im.split()[3].getbbox()
    if bbox:
        im = im.crop(bbox)
    w2, h2 = im.size
    side = int(max(w2, h2) * 1.06)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w2)//2, (side - h2)//2), im)
    canvas = canvas.resize((size, size), Image.LANCZOS)
    canvas.save(out)
    a0 = canvas.getpixel((1,1))[3]
    print(f"{out}  corner_alpha={a0}  ({w2}x{h2} -> {size})")

if __name__ == "__main__":
    keyout(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 64)
