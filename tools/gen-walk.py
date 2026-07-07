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

# slime: bouncy — squashes wide/short at the bottom of the bounce, stretches tall at apex
def slime(t):
    b=math.sin(t*2*math.pi)              # -1..1 bounce
    sx=1.0 - 0.10*b                       # wide when low
    sy=1.0 + 0.10*b
    dy=int(round(-6*max(0,b)))            # hop up on the up-phase
    return (sx,sy,0,dy)

# bat: hovering wing-wobble — slight horizontal sway + vertical flutter, minimal squash
def bat(t):
    return (1.0+0.04*math.sin(t*2*math.pi), 1.0-0.04*math.sin(t*2*math.pi),
            int(round(3*math.sin(t*2*math.pi))), int(round(-3*abs(math.cos(t*math.pi)))))

# skeleton: stiff shamble — small side-to-side lean, little vertical, a rigid gait
def skeleton(t):
    lean=int(round(3*math.sin(t*2*math.pi)))
    return (1.0, 1.0+0.03*abs(math.sin(t*2*math.pi)), lean, int(round(-2*abs(math.sin(t*math.pi)))))

cycle('slime', slime)
cycle('bat', bat)
cycle('skeleton', skeleton)
