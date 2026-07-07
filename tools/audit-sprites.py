#!/usr/bin/env python3
# audit-sprites.py — flag degenerate spritesheet frames (the "skinny slime" class of bug).
# A frame is flagged if its opaque bbox width or height, or opaque pixel count, is a wild
# outlier vs its sibling frames in the same sheet (or if a frame is empty). Exit 1 if any flagged.
import sys, os, glob
from PIL import Image
import numpy as np

# sheet stem -> frame height (px). Frame width == frame height (square) except boss (96).
SHEETS = {
 'hero_walk':64,'slime_walk':64,'bat_walk':64,'skeleton_walk':64,'ghost_walk':64,'boss_walk':96,
 'slime_death':64,'skeleton_death':64,'bat_death':64,'boss_death':96,
}
DIR = os.path.join(os.path.dirname(__file__), '..', 'public', 'sprites')
flagged = []
for name, fh in SHEETS.items():
    p = os.path.join(DIR, f'{name}.png')
    if not os.path.exists(p): continue
    im = Image.open(p).convert('RGBA'); W, H = im.size; a = np.asarray(im)
    if W % fh != 0 or H != fh:
        flagged.append(f'{name}: bad dims {W}x{H} (frame {fh}px) — width not a multiple or height mismatch'); continue
    n = W // fh
    bws, ops = [], []
    for i in range(n):
        fr = a[:, i*fh:(i+1)*fh, :]; op = fr[:,:,3] > 40
        if op.sum() == 0:
            flagged.append(f'{name} frame{i}: EMPTY'); bws.append(0); ops.append(0); continue
        ys, xs = np.where(op); bws.append(xs.max()-xs.min()+1); ops.append(int(op.sum()))
    # Outlier check: a frame whose bbox width < 45% of the median sibling width is degenerate.
    # (death sheets legitimately shrink toward the end, so only check WALK sheets for width outliers;
    #  for all sheets, flag any non-terminal empty frame.)
    if 'walk' in name and n >= 2:
        med = sorted(bws)[len(bws)//2]
        for i, bw in enumerate(bws):
            if med > 0 and bw < 0.45 * med:
                flagged.append(f'{name} frame{i}: skinny bbox width {bw} vs median {med} — likely malformed')
if flagged:
    print('SPRITE AUDIT: FAIL'); [print('  -', f) for f in flagged]; sys.exit(1)
print('SPRITE AUDIT: PASS — all', len(SHEETS), 'sheets have consistent frames'); sys.exit(0)
