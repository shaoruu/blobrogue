#!/usr/bin/env python3
# pixelize.py — enforce blobrogue's art bible on a generated sprite:
# hard-alpha threshold -> downscale to grid -> snap to 25-color palette -> 1px outline -> export 64px NEAREST.
# From the art director's spec. Usage: python3 tools/pixelize.py in.png out.png [--grid 32]
import argparse
from PIL import Image
PALETTE_HEX=["05030b","0e0b1a","171227","2a2140","46356b","7a3d12","c77320","ffb43b","ffd166","ffe9b0","5a1020","c0243a","ff5a5f","1f5a2e","3fbf5f","8fffa8","6b6f8a","c9c9de","ffffff","2a5fa0","57b6ff","bfeaff","6a2fb0","a24bff","d9a6ff","301c0e","6b401e","9c6633","0f4a4a","1fa89a","6ff0d8"]
PAL=[tuple(int(h[i:i+2],16) for i in (0,2,4)) for h in PALETTE_HEX]
OUTLINE=(5,3,11)
# Dungeon-tile darks that leak in via the birefnet cutout picking up floor pixels.
# Inside a sprite silhouette these should be snapped to the sprite's own family-dark.
TILE_DARKS={(42,33,64),(23,18,39),(14,11,26),(70,53,107)}  # 2a2140,171227,0e0b1a,46356b
DUNGEON_RAMP=[(5,3,11),(14,11,26),(23,18,39),(42,33,64),(70,53,107)]  # 05030b 0e0b1a 171227 2a2140 46356b
def nearest(c):
    r,g,b=c
    return min(PAL,key=lambda p:(p[0]-r)**2+(p[1]-g)**2+(p[2]-b)**2)
def run(inp,out,grid,export,family_dark=None,tile=False):
    if tile:
        return run_tile(inp,out,grid,export)
    im=Image.open(inp).convert("RGBA");px=im.load();w,h=im.size
    for y in range(h):
        for x in range(w):
            r,g,b,a=px[x,y];px[x,y]=(r,g,b,255 if a>=128 else 0)
    small=im.resize((grid,grid),Image.LANCZOS);sp=small.load()
    for y in range(grid):
        for x in range(grid):
            r,g,b,a=sp[x,y];sp[x,y]=(r,g,b,255 if a>=128 else 0)
    for y in range(grid):
        for x in range(grid):
            r,g,b,a=sp[x,y]
            if a>0:
                nc=nearest((r,g,b));sp[x,y]=(nc[0],nc[1],nc[2],255)
    # Tile-dark clamp ALWAYS runs (AD rule): a leaked dungeon-floor dark can never survive.
    # If a family-dark is given, snap to it; else snap each leak to the nearest palette color
    # that ISN'T itself a tile-dark (so gray/metal/prop objects still get cleaned).
    _fd = tuple(int(family_dark[i:i+2],16) for i in (0,2,4)) if family_dark else None
    _nontile = [c for c in PAL if c not in TILE_DARKS and c != OUTLINE]
    for y in range(grid):
        for x in range(grid):
            r,g,b,a=sp[x,y]
            if a==255 and (r,g,b) in TILE_DARKS:
                if _fd is not None:
                    sp[x,y]=(_fd[0],_fd[1],_fd[2],255)
                else:
                    nc=min(_nontile,key=lambda pc:(pc[0]-r)**2+(pc[1]-g)**2+(pc[2]-b)**2)
                    sp[x,y]=(nc[0],nc[1],nc[2],255)
    ring=set()
    for y in range(grid):
        for x in range(grid):
            if sp[x,y][3]==0:
                for dx,dy in((1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)):
                    nx,ny=x+dx,y+dy
                    if 0<=nx<grid and 0<=ny<grid and sp[nx,ny][3]==255 and (sp[nx,ny][0],sp[nx,ny][1],sp[nx,ny][2])!=OUTLINE:
                        ring.add((x,y));break
    for(x,y)in ring:sp[x,y]=(OUTLINE[0],OUTLINE[1],OUTLINE[2],255)
    small.resize((export,export),Image.NEAREST).save(out)
    # report color count
    colors=set()
    fin=small.load()
    for y in range(grid):
        for x in range(grid):
            if fin[x,y][3]==255: colors.add(fin[x,y][:3])
    print(f"wrote {out} — {len(colors)} colors, grid {grid}")
def run_tile(inp,out,grid,export,ramp=None):
    """Floor/wall tile enforce: 5-color dark-ramp palette only, NO outline, opaque, seamless edge-wrap.
    --ramp "hex,hex,hex,hex,hex" pins a per-biome ramp (defaults to the shared dungeon ramp),
    so each biome's floor/wall art keeps the art bible's ramp discipline in its own palette."""
    RAMP=[tuple(int(h.strip().lstrip("#")[i:i+2],16) for i in (0,2,4)) for h in ramp.split(",")] if ramp else DUNGEON_RAMP
    im=Image.open(inp).convert("RGB").resize((grid,grid),Image.LANCZOS);sp=im.load()
    def nearest_ramp(c):
        r,g,b=c
        return min(RAMP,key=lambda p:(p[0]-r)**2+(p[1]-g)**2+(p[2]-b)**2)
    for y in range(grid):
        for x in range(grid):
            sp[x,y]=nearest_ramp(sp[x,y])
    # seamless: average-blend opposite edges so tiles repeat without a seam (copy left col->right, top row->bottom)
    for y in range(grid):
        sp[grid-1,y]=sp[0,y]
    for x in range(grid):
        sp[x,grid-1]=sp[x,0]
    im.resize((export,export),Image.NEAREST).save(out)
    colors=len({sp[x,y] for y in range(grid) for x in range(grid)})
    print(f"wrote {out} (tile) — {colors} colors, grid {grid}, seamless edges")

if __name__=="__main__":
    ap=argparse.ArgumentParser();ap.add_argument("inp");ap.add_argument("out");ap.add_argument("--grid",type=int,default=32);ap.add_argument("--export",type=int,default=64);ap.add_argument("--family-dark",default=None);ap.add_argument("--tile",action="store_true");ap.add_argument("--ramp",default=None)
    a=ap.parse_args()
    if a.tile: run_tile(a.inp,a.out,a.grid,a.export,a.ramp)
    else: run(a.inp,a.out,a.grid,a.export,a.family_dark)
