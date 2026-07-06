#!/usr/bin/env python3
# add_shadow.py — bake the standard grounding shadow (#261a14, ~4px ellipse) under a sprite. Art bible standing rule.
import sys
from PIL import Image
def run(path):
    im=Image.open(path).convert("RGBA").resize((32,32),Image.NEAREST)
    p=im.load()
    cols_bottom={}
    for x in range(32):
        ys=[y for y in range(32) if p[x,y][3]==255]
        if ys: cols_bottom[x]=max(ys)
    if cols_bottom:
        xs=sorted(cols_bottom); cx=(min(xs)+max(xs))//2; half=max(1,(max(xs)-min(xs))//2)
        sy=max(cols_bottom.values())
        for x in range(min(xs)+2,max(xs)-1):
            t=1 if abs(x-cx)>half-2 else 2
            for dy in range(1,1+t):
                yy=sy+dy
                if yy<32 and p[x,yy][3]==0: p[x,yy]=(38,26,20,255)
    im.resize((64,64),Image.NEAREST).save(path)
    print("shadowed",path)
if __name__=="__main__": run(sys.argv[1])
