#!/usr/bin/env python3
# gen-death.py — bake one-shot enemy death spritesheets from the existing static sprites.
# Each frame squashes the body toward the ground, punches a white damage-flash early, then
# dissolves the alpha away, reading as a quick pop-and-crumble. Horizontal 1xN strips:
#   slime/skeleton/bat -> 5 frames (320x64), boss -> 8 frames (768x96).
# Output overwrites public/sprites/<name>_death.png
import os
import numpy as np
from PIL import Image

SPR = os.path.join(os.path.dirname(__file__), "..", "public", "sprites")

# Per-frame white-flash strength. Boss frames 2-3 are a full-white VFX flash (intentionally
# off-palette) before it breaks apart.
FLASH = {
    5: [0.5, 0.85, 0.4, 0.12, 0.0],
    8: [0.3, 0.7, 1.0, 1.0, 0.5, 0.25, 0.1, 0.0],
}


def make_sheet(name, frames):
    src = Image.open(os.path.join(SPR, f"{name}.png")).convert("RGBA")
    W, H = src.size
    rng = np.random.default_rng(hash(name) & 0xFFFF)
    noise = rng.random((H, W)).astype(np.float32)
    flash = FLASH[frames]
    strip = Image.new("RGBA", (W * frames, H), (0, 0, 0, 0))
    for i in range(frames):
        t = i / (frames - 1)
        sx = 1.0 + 0.4 * t          # spread wide
        sy = max(0.05, 1.0 - 0.6 * t)  # flatten down
        nw, nh = max(1, round(W * sx)), max(1, round(H * sy))
        resized = src.resize((nw, nh), Image.LANCZOS)
        frame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        px = (W - nw) // 2
        py = int((H - nh) * 0.62 + 5 * t)   # settle toward the floor as it flattens
        frame.alpha_composite(resized, (px, py))

        arr = np.asarray(frame).astype(np.float32) / 255.0
        rgb, a = arr[..., :3], arr[..., 3]
        f = flash[i]
        rgb = rgb * (1 - f) + 1.0 * f
        diss = np.clip((t - 0.35) / 0.65, 0, 1) * 1.05
        erode = np.clip((noise - diss) * 6 + 0.5, 0, 1)
        fade = np.clip(1 - (t - 0.45) / 0.55, 0, 1)
        a = a * erode * fade
        out = np.dstack([rgb, a])
        strip.alpha_composite(Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8), "RGBA"), (i * W, 0))
    path = os.path.join(SPR, f"{name}_death.png")
    strip.save(path)
    print(f"{name}_death.png: {strip.size[0]}x{strip.size[1]} ({frames} frames)")


if __name__ == "__main__":
    make_sheet("slime", 5)
    make_sheet("skeleton", 5)
    make_sheet("bat", 5)
    make_sheet("boss", 8)
    print("gen-death done")
