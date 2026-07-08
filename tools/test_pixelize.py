#!/usr/bin/env python3
# test_pixelize.py — proves the family-palette-lane system in pixelize.py:
#   1. a cool neutral sample through neutral_bone NEVER yields teal (the contamination bug)
#   2. teal_spitter CAN yield teal
#   3. every lane's output is a subset of that lane + outline
#   4. --palette-hex restricts output exactly
#   5. the default global lane is byte-identical to the pre-lane algorithm
# Run: python3 tools/test_pixelize.py   (wired into `npm test`)
import os,sys,tempfile
from PIL import Image
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import pixelize
from pixelize import LANES,PAL,PALETTE_HEX,OUTLINE,TILE_DARKS,rgb,run

TEAL={rgb(h) for h in ("0f4a4a","1fa89a","6ff0d8")}
GRID=16

def make_image(colors,size=64):
    im=Image.new("RGBA",(size,size),(0,0,0,0))
    px=im.load()
    n=len(colors)
    for y in range(8,size-8):
        for x in range(8,size-8):
            px[x,y]=colors[(x//4+y//4)%n]+(255,)
    return im

def opaque_colors(path):
    im=Image.open(path).convert("RGBA")
    px=im.load()
    return {px[x,y][:3] for y in range(im.height) for x in range(im.width) if px[x,y][3]==255}

def process(im,**kw):
    with tempfile.TemporaryDirectory() as d:
        inp,out=os.path.join(d,"in.png"),os.path.join(d,"out.png")
        im.save(inp)
        run(inp,out,GRID,GRID*2,**kw)
        return opaque_colors(out)

# Cool/dark neutral shadow tones measured in the contaminated bosses: globally these
# sit nearest the teal lane, which is exactly how the green cast crept in.
COOL_NEUTRALS=[(28,62,60),(40,90,85),(70,110,105),(24,52,50),(90,140,130)]
COOL_SAMPLE=make_image(COOL_NEUTRALS)

def test_neutral_bone_never_teal():
    contaminated=process(COOL_SAMPLE)  # legacy global lane
    assert contaminated&TEAL,"sample should reproduce the teal-contamination bug under global snapping"
    clean=process(COOL_SAMPLE,lane="neutral_bone")
    assert not clean&TEAL,f"neutral_bone leaked teal: {sorted(clean&TEAL)}"
    allowed={rgb(h) for h in LANES["neutral_bone"]["hex"]}|{OUTLINE}
    assert clean<=allowed,f"neutral_bone out of lane: {sorted(clean-allowed)}"

def test_teal_spitter_can_teal():
    got=process(make_image([(20,80,78),(35,160,150),(110,235,215)]),lane="teal_spitter")
    assert got&TEAL,"teal_spitter should be able to produce teal"

def test_every_lane_subset():
    rainbow=make_image([(250,60,60),(60,250,60),(60,60,250),(250,250,60),(30,30,30),
                        (240,240,240),(150,80,200),(80,200,190),(200,140,60),(20,60,58)])
    for name,spec in LANES.items():
        allowed={rgb(h) for h in spec["hex"]}|{OUTLINE}
        got=process(rainbow,lane=name)
        assert got<=allowed,f"lane {name} escaped its palette: {sorted(got-allowed)}"
        if name!="teal_spitter" and name!="global":
            assert not got&TEAL,f"non-teal lane {name} produced teal"

def test_palette_hex_exact():
    hexes="5a1020,c0243a,ff5a5f"
    allowed={rgb(h) for h in hexes.split(",")}|{OUTLINE}
    got=process(make_image([(250,60,60),(60,250,60),(30,30,30),(240,240,240)]),palette_hex=hexes)
    assert got<=allowed,f"--palette-hex output escaped: {sorted(got-allowed)}"

def legacy_reference(inp,out,grid,export,family_dark=None):
    """The pre-lane pixelize algorithm, verbatim, as the back-compat oracle."""
    def nearest(c):
        r,g,b=c
        return min(PAL,key=lambda p:(p[0]-r)**2+(p[1]-g)**2+(p[2]-b)**2)
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
    _fd=rgb(family_dark) if family_dark else None
    _nontile=[c for c in PAL if c not in TILE_DARKS and c!=OUTLINE]
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

def test_global_backwards_compatible():
    samples=[
        (make_image([(28,62,60),(42,33,64),(23,18,39),(200,140,60),(120,120,140)]),None),
        (make_image([(14,11,26),(70,53,107),(250,60,60),(60,60,250)]),"5a1020"),
    ]
    for im,fd in samples:
        with tempfile.TemporaryDirectory() as d:
            inp=os.path.join(d,"in.png");im.save(inp)
            new_out=os.path.join(d,"new.png");ref_out=os.path.join(d,"ref.png")
            run(inp,new_out,GRID,GRID*2,family_dark=fd)
            legacy_reference(inp,ref_out,GRID,GRID*2,family_dark=fd)
            new=Image.open(new_out).convert("RGBA").tobytes()
            ref=Image.open(ref_out).convert("RGBA").tobytes()
            assert new==ref,f"global lane diverged from legacy behavior (family_dark={fd})"

def test_lane_manifest_invariants():
    for name,spec in LANES.items():
        assert "05030b" in spec["hex"],f"lane {name} is missing soot/outline"
        if spec["dark"]:
            assert spec["dark"] in spec["hex"],f"lane {name} dark not in its own palette"
        if name not in ("teal_spitter","global"):
            assert not {rgb(h) for h in spec["hex"]}&TEAL,f"lane {name} contains teal"
        assert all(h in PALETTE_HEX for h in spec["hex"]),f"lane {name} has off-bible colors"

if __name__=="__main__":
    tests=[v for k,v in sorted(globals().items()) if k.startswith("test_")]
    failed=0
    for t in tests:
        try:
            t();print(f"PASS {t.__name__}")
        except AssertionError as e:
            failed+=1;print(f"FAIL {t.__name__}: {e}")
    print(f"{len(tests)-failed}/{len(tests)} pixelize lane tests passed")
    sys.exit(1 if failed else 0)
