#!/usr/bin/env python3
# pixelize.py — enforce blobrogue's art bible on a generated sprite:
# hard-alpha threshold -> downscale to grid -> snap to a PALETTE LANE -> 1px outline -> export 64px NEAREST.
# From the art director's spec.
#
# FAMILY PALETTE LANES (art director's manifest, typed below in LANES):
# nearest-color lookup is restricted to ONE family's ramp + soot, so cool/dark neutral
# shadows can never contaminate into another family's hues. This fixes the teal-cast bug:
# global snapping pulled unrelated shadows into the Spitter's 0f4a4a/1fa89a/6ff0d8 teal
# lane (Weaver 32%, Marrow 28%, Orbiter 41%, Beam 44% contamination). ONLY the
# teal_spitter lane contains those teal colors.
#
# Usage:
#   python3 tools/pixelize.py in.png out.png --lane neutral_bone [--grid 32]
#   python3 tools/pixelize.py in.png out.png --palette-hex 6b6f8a,c9c9de,ffffff
#   python3 tools/pixelize.py in.png out.png --tile            # dungeon-ramp tile (unchanged)
#   python3 tools/pixelize.py in.png out.png                   # legacy GLOBAL lane
# The default "global" lane (snap across the whole 31-color palette) exists ONLY so old
# recipes keep reproducing byte-identical output. New assets MUST pass an explicit
# --lane (or --palette-hex for one-off work) — unrestricted global snapping is banned.
import argparse
from PIL import Image

SOOT="05030b"  # outline + deliberate interior darks (sockets); in every lane
BONE=["6b6f8a","c9c9de","ffffff"]
AMBER=["7a3d12","c77320","ffb43b","ffd166","ffe9b0"]
RED=["5a1020","c0243a","ff5a5f"]
GREEN=["1f5a2e","3fbf5f","8fffa8"]
BLUE=["2a5fa0","57b6ff","bfeaff"]
PURPLE=["6a2fb0","a24bff","d9a6ff"]
LEATHER=["301c0e","6b401e","9c6633"]
TEAL=["0f4a4a","1fa89a","6ff0d8"]  # Spitter family ONLY — never in any other lane
DUSK=["0e0b1a","171227","2a2140","46356b"]  # dungeon-tile darks: global lane + tiles only

PALETTE_HEX=[SOOT]+DUSK+AMBER+RED+GREEN+BONE+BLUE+PURPLE+LEATHER+TEAL

# Art director's family manifest. "dark" is the lane's family-dark: what a leaked
# dungeon-floor pixel clamps to (overridable with --family-dark). No lane except
# "global" contains the dungeon dusk ramp, and none but teal_spitter contains teal.
LANES={
    "neutral_bone":   {"hex":[SOOT]+BONE,                        "dark":"6b6f8a"},
    "choir_cyan":     {"hex":[SOOT]+BLUE+["ffffff"],             "dark":"2a5fa0"},
    "cold_indigo":    {"hex":[SOOT]+PURPLE+["ffffff"],           "dark":"6a2fb0"},
    "amber_construct":{"hex":[SOOT]+AMBER,                       "dark":"7a3d12"},
    "shale_bone":     {"hex":[SOOT]+LEATHER+["6b6f8a","c9c9de"], "dark":"301c0e"},
    "red_brute":      {"hex":[SOOT]+RED+["ffffff"],              "dark":"5a1020"},
    "cold_orbiter":   {"hex":[SOOT]+BLUE+["6b6f8a","c9c9de"],    "dark":"2a5fa0"},
    "weapon_orange":  {"hex":[SOOT]+AMBER[:4]+LEATHER[:2],       "dark":"301c0e"},
    "weapon_metal":   {"hex":[SOOT]+BONE+LEATHER[:2],            "dark":"301c0e"},
    "weapon_beam":    {"hex":[SOOT]+BLUE+["ffffff"],             "dark":"2a5fa0"},
    "teal_spitter":   {"hex":[SOOT]+TEAL+["ffffff"],             "dark":"0f4a4a"},
    # Legacy whole-palette snapping, kept for byte-identical back-compat with old
    # recipes. Do NOT use for new assets — pick a family lane above.
    "global":         {"hex":PALETTE_HEX,                        "dark":None},
}

def rgb(h):
    h=h.strip().lstrip("#").lower()
    return tuple(int(h[i:i+2],16) for i in (0,2,4))

PAL=[rgb(h) for h in PALETTE_HEX]
OUTLINE=rgb(SOOT)
TILE_DARKS={rgb(h) for h in DUSK}
DUNGEON_RAMP=[OUTLINE]+[rgb(h) for h in DUSK]

def nearest(c,pal=PAL):
    r,g,b=c
    return min(pal,key=lambda p:(p[0]-r)**2+(p[1]-g)**2+(p[2]-b)**2)

def luma(c):
    return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]

def resolve_palette(lane="global",palette_hex=None,family_dark=None):
    if palette_hex:
        pal=[rgb(h) for h in palette_hex.split(",") if h.strip()]
        if not pal: raise ValueError("--palette-hex given but no colors parsed")
        lane_dark=min([c for c in pal if c not in TILE_DARKS and c!=OUTLINE] or pal,key=luma)
    else:
        spec=LANES[lane]
        pal=[rgb(h) for h in spec["hex"]]
        lane_dark=rgb(spec["dark"]) if spec["dark"] else None
    clamp_dark=rgb(family_dark) if family_dark else lane_dark
    return pal,clamp_dark

def run(inp,out,grid,export,family_dark=None,tile=False,lane="global",palette_hex=None):
    if tile:
        return run_tile(inp,out,grid,export)
    pal,clamp_dark=resolve_palette(lane,palette_hex,family_dark)
    im=Image.open(inp).convert("RGBA");px=im.load();w,h=im.size
    for y in range(h):
        for x in range(w):
            r,g,b,a=px[x,y];px[x,y]=(r,g,b,255 if a>=128 else 0)
    small=im.resize((grid,grid),Image.LANCZOS);sp=small.load()
    for y in range(grid):
        for x in range(grid):
            r,g,b,a=sp[x,y];sp[x,y]=(r,g,b,255 if a>=128 else 0)
    # Snap + tile-dark clamp in one pass. Leak detection uses the GLOBAL nearest so a
    # leaked dungeon-floor dark is recognized whatever lane is active (AD rule: it can
    # never survive). Leaks clamp to the FAMILY LANE'S dark (or --family-dark override),
    # never to an unrelated global nearest color; only the legacy global lane run
    # without --family-dark keeps its old nearest-non-tile-dark fallback.
    _nontile=[c for c in PAL if c not in TILE_DARKS and c!=OUTLINE]
    for y in range(grid):
        for x in range(grid):
            r,g,b,a=sp[x,y]
            if a==0: continue
            g_near=nearest((r,g,b))
            if g_near in TILE_DARKS:
                nc=clamp_dark if clamp_dark is not None else nearest(g_near,_nontile)
            else:
                nc=nearest((r,g,b),pal)
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
    label="custom-hex" if palette_hex else lane
    print(f"wrote {out} — {len(colors)} colors, grid {grid}, lane {label}")

def run_tile(inp,out,grid,export):
    """Floor/wall tile enforce: dungeon-ramp palette only, NO outline, opaque, seamless edge-wrap."""
    im=Image.open(inp).convert("RGB").resize((grid,grid),Image.LANCZOS);sp=im.load()
    def nearest_ramp(c):
        r,g,b=c
        return min(DUNGEON_RAMP,key=lambda p:(p[0]-r)**2+(p[1]-g)**2+(p[2]-b)**2)
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
    ap=argparse.ArgumentParser()
    ap.add_argument("inp");ap.add_argument("out")
    ap.add_argument("--grid",type=int,default=32);ap.add_argument("--export",type=int,default=64)
    ap.add_argument("--family-dark",default=None);ap.add_argument("--tile",action="store_true")
    g=ap.add_mutually_exclusive_group()
    g.add_argument("--lane",choices=sorted(LANES),default="global",help="family palette lane (new assets MUST pass one)")
    g.add_argument("--palette-hex",default=None,help="comma-separated hex colors for one-off explicit palettes")
    a=ap.parse_args()
    run(a.inp,a.out,a.grid,a.export,a.family_dark,a.tile,a.lane,a.palette_hex)
