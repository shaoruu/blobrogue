#!/usr/bin/env python3
# gen-fx.py — bake blobrogue's tintable bullet-FX primitives.
# Every asset is pure white (RGB=255) with all intensity in the ALPHA channel, so the
# renderer can tint via a single source-in fill and composite additively ('lighter').
# Output: public/sprites/fx/*.png
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "sprites", "fx")
os.makedirs(OUT, exist_ok=True)


def save(alpha, name):
    a = np.clip(alpha, 0.0, 1.0)
    h, w = a.shape
    rgba = np.full((h, w, 4), 255, dtype=np.uint8)
    rgba[..., 3] = (a * 255.0 + 0.5).astype(np.uint8)
    Image.fromarray(rgba, "RGBA").save(os.path.join(OUT, name))
    print(f"{name}: {w}x{h}")


def grid(w, h):
    yy, xx = np.mgrid[0:h, 0:w]
    return xx.astype(np.float32), yy.astype(np.float32)


def glow_round():
    w = h = 64
    xx, yy = grid(w, h)
    r = np.hypot(xx - (w - 1) / 2, yy - (h - 1) / 2) / (w / 2)
    save(np.clip(1 - r, 0, 1) ** 1.9, "glow_round.png")


def core_dot():
    w = h = 32
    xx, yy = grid(w, h)
    r = np.hypot(xx - (w - 1) / 2, yy - (h - 1) / 2) / (w / 2)
    a = np.clip((1.0 - r) / 0.42, 0, 1) ** 0.85
    save(a, "core_dot.png")


def trail_streak():
    w, h = 96, 28
    xx, yy = grid(w, h)
    along = (xx / (w - 1)) ** 1.7            # bright head at +X, fading to the tail
    across = np.exp(-(((yy - (h - 1) / 2) / 6.0) ** 2))
    save(along * across, "trail_streak.png")


def slug():
    w = h = 48
    xx, yy = grid(w, h)
    nx = (xx - (w - 1) / 2) / 22.0           # horizontal capsule, oriented +X
    ny = (yy - (h - 1) / 2) / 10.0
    r = np.hypot(nx, ny)
    save(np.clip(1 - r, 0, 1) ** 0.7, "slug.png")


def spark():
    w = h = 48
    xx, yy = grid(w, h)
    nx = (xx - (w - 1) / 2) / ((w - 1) / 2)
    ny = (yy - (h - 1) / 2) / ((h - 1) / 2)
    r = np.hypot(nx, ny)
    ang = np.arctan2(ny, nx)
    spike = np.maximum(np.abs(np.cos(ang)) ** 8, np.abs(np.sin(ang)) ** 8)
    a = np.clip(1 - r, 0, 1) * (0.3 + 0.7 * spike)
    a = np.clip(a + np.clip(1 - r * 3, 0, 1) * 0.8, 0, 1)
    save(a, "spark.png")


def comet_trail():
    w, h = 96, 40
    xx, yy = grid(w, h)
    cy = (h - 1) / 2
    fx = xx / (w - 1)
    head = np.clip(1 - np.hypot((xx - 80) / 15.0, (yy - cy) / 15.0), 0, 1) ** 0.8
    tail = (fx ** 2) * np.exp(-(((yy - cy) / (3 + 9 * fx)) ** 2))
    save(np.clip(head + tail * 0.85, 0, 1), "comet_trail.png")


def _bolt(w, h, ax, points, jitter, seed, widths):
    # Rasterize a jagged polyline (bright thin core over a wider soft body) into alpha.
    rng = np.random.default_rng(seed)
    img = Image.new("L", (w, h), 0)
    dr = ImageDraw.Draw(img)
    for width, gain in widths:
        pts = []
        for i in range(points):
            t = i / (points - 1)
            x = ax[0] + (ax[1] - ax[0]) * t
            y = h / 2 + (rng.random() * 2 - 1) * jitter * (0.4 + 0.6 * np.sin(t * np.pi))
            pts.append((x, y))
        dr.line(pts, fill=int(255 * gain), width=width, joint="curve")
    arr = np.asarray(img).astype(np.float32) / 255.0
    return arr


def crackle():
    w = h = 48
    rng = np.random.default_rng(7)
    acc = np.zeros((h, w), np.float32)
    for k in range(4):
        ang = k * (np.pi / 2) + rng.random() * 0.5
        ex = w / 2 + np.cos(ang) * 22
        ey = h / 2 + np.sin(ang) * 22
        img = Image.new("L", (w, h), 0)
        dr = ImageDraw.Draw(img)
        pts, n = [], 5
        for i in range(n):
            t = i / (n - 1)
            x = w / 2 + (ex - w / 2) * t + (rng.random() * 2 - 1) * 5 * t
            y = h / 2 + (ey - h / 2) * t + (rng.random() * 2 - 1) * 5 * t
            pts.append((x, y))
        dr.line(pts, fill=255, width=2, joint="curve")
        acc = np.maximum(acc, np.asarray(img).astype(np.float32) / 255.0)
    glow = np.asarray(Image.fromarray((acc * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2))).astype(np.float32) / 255.0
    xx, yy = grid(w, h)
    core = np.clip(1 - np.hypot(xx - w / 2, yy - h / 2) / 6, 0, 1)
    save(np.clip(acc + glow * 0.5 + core * 0.9, 0, 1), "crackle.png")


def arc_chain():
    w, h = 120, 32
    core = _bolt(w, h, (3, w - 4), 9, 8.5, 21, [(1, 1.0)])
    body = _bolt(w, h, (3, w - 4), 9, 8.5, 21, [(4, 0.5)])
    body = np.asarray(Image.fromarray((body * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.6))).astype(np.float32) / 255.0
    save(np.clip(core + body, 0, 1), "arc_chain.png")


def smoke_puff():
    w = h = 40
    rng = np.random.default_rng(3)
    xx, yy = grid(w, h)
    acc = np.zeros((h, w), np.float32)
    for _ in range(5):
        cx = w / 2 + (rng.random() * 2 - 1) * 7
        cy = h / 2 + (rng.random() * 2 - 1) * 7
        rad = 8 + rng.random() * 6
        acc += np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * rad ** 2))
    acc /= acc.max()
    save(acc ** 1.2 * 0.8, "smoke_puff.png")


if __name__ == "__main__":
    glow_round()
    core_dot()
    trail_streak()
    slug()
    spark()
    comet_trail()
    crackle()
    arc_chain()
    smoke_puff()
    print("gen-fx done")
