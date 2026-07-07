#!/usr/bin/env python3
# gen-walk.py — build a clean N-frame walk-cycle strip from a single static sprite via
# per-frame squash/stretch/bob transforms. NO frame blending (that ghosts), so every
# frame is one crisp copy of the source. Per-enemy motion profiles.
import sys, math
from PIL import Image

SRC='public/sprites'; W=64; N=6

def transform(base, sx, sy, dx, dy):
    """Scale base by (sx,sy) around center-bottom, offset by (dx,dy), composite onto WxW."""
    bw,bh=max(1,int(round(W*sx))),max(1,int(round(W*sy)))
    scaled=base.resize((bw,bh), Image.NEAREST)
    canvas=Image.new('RGBA',(W,W),(0,0,0,0))
    px=(W-bw)//2 + dx
    py=(W-bh) + dy          # bottom-anchored
    canvas.alpha_composite(scaled,(px,py))
    return canvas

def cycle(name, profile):
    base=Image.open(f'{SRC}/{name}.png').convert('RGBA')
    sheet=Image.new('RGBA',(W*N,W),(0,0,0,0))
    for i in range(N):
        t=i/N
        sx,sy,dx,dy=profile(t)
        sheet.alpha_composite(transform(base,sx,sy,dx,dy),(i*W,0))
    sheet.save(f'{SRC}/{name}_walk.png')
    print(f'{name}_walk.png: {N} clean frames')

# slime: bouncy hop. Bounce at 2x (two bounces per loop feels lively) + a slight
# forward lean phase so frames stay distinct.
def slime(t):
    b=math.sin(t*2*2*math.pi)
    sx=1.0-0.10*b; sy=1.0+0.10*b
    dy=int(round(-6*max(0,b)))
    return (sx,sy,int(round(2*math.sin(t*2*math.pi))),dy)

# bat: strong wing-flap hover — big vertical bob (flap up/down) + horizontal sway + a
# wide/narrow squash as the wings beat. Reads clearly as flying, not a static sprite.
def bat(t):
    beat=math.sin(t*2*math.pi)
    return (1.0+0.14*beat, 1.0-0.14*beat,        # wings spread wide / pull narrow
            int(round(5*math.cos(t*2*math.pi))),  # side sway
            int(round(-8*max(0,beat)-2)))          # bob up on the up-beat (8px)

# skeleton: stiff shamble. Lean at 1x + step-bob at 2x (two footfalls per cycle) so no
# two of the 6 frames repeat; the offset phase makes the gait progress.
def skeleton(t):
    lean=int(round(7*math.sin(t*2*math.pi)))
    bob=int(round(-5*abs(math.sin(t*2*math.pi))))
    return (1.0+0.05*math.sin(t*2*2*math.pi), 1.0, lean, bob)

cycle('slime', slime)
cycle('bat', bat)
cycle('skeleton', skeleton)
