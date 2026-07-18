# Sever F55 art generation report

**Status:** fal art generated + staged locally. **NOT pushed / NOT merged to main.** Deploy hold respected.

**When:** 2026-07-17 ~17:33 PT (2026-07-18 ~00:33 UTC)

## Problem
`assets.ts` recycled `weaver2_px` for `sever` + `sever_anchor`. Ian rejected the spider reuse.

## Pipeline (locked)
`fal-ai/flux/dev` → `fal-ai/birefnet` → `tools/pixelize.py` (explicit `--palette-hex`, **never** `--lane global`) → directional walks from **ONE** base via gen-walk squash/stretch/bob (no separate AI frames).

## Palette (black-resin / resin incision)
```
--palette-hex 05030b,6b6f8a,c9c9de,ffffff,7a3d12,c77320,ffb43b,ffd166,5a1020
--family-dark 05030b
```
Bible hex only. Soot-dominant body, bone rims, dying-amber incision. No teal. Distinct from Weaver cold-indigo/purple spider lane.

## Selected takes
| Asset | Source cut | Grid→export | Notes |
|---|---|---|---|
| `sever` body | `cut/sever_e-cut.png` (r3 shark-fin / blade-keel) | 48→96 | Solid cutting silhouette, twin fused side flanges, amber dorsal slit. Rejected multi-leg spider takes a/b/c/d. |
| `sever_anchor` | `cut/sever_anchor_a-cut.png` | 32→64 | Stubbly resin tooth pillar + amber tip/incision. Not a creature. Alt `sever_anchor_b` kept as `out/sever_anchor_alt_b.png`. |

**Silhouette IoU vs weaver2_px (alpha masks, 96px):** ~0.41 (under ART bible 0.6 gate). Palette: soot/bone/amber vs Weaver dusk-violet/magenta eyes.

## Prompts used (selected)

### sever_e (body — SELECTED)
> top-down video game boss: black amber resin SHARK-FIN predator viewed from above, compact solid teardrop body pointing UP, two rear-swept blade flanges glued to the flanks as one mass, absolutely no free legs, no spider, no crawler, amber nerve glow as a thin dorsal slit, plain pure white background, centered, isolated, no shadow, no text, crisp 2D illustration

### sever_anchor_a (anchor — SELECTED)
> a single top-down video-game prop sprite of a short stubby black-resin TOOTH pillar, thick triangular resin fang planted in the floor, one dying-amber incision crack down the front face, glossy fossil resin, architectural spike, NOT a creature, NOT legs, NOT spider, NOT thorns tree, NOT webbing, centered on plain flat pure white background, no shadow, no scenery, no text, clean 2D game asset

Rejected body prompts (spider/leg leakage): `sever` r1, `sever_a`, `sever_b`, `sever_c`, `sever_d` — archived under `/workspace/fal-art/sever/cut/` + `raw/`.

## Walks
From ONE base `px/sever.png` via chase-predator lean/bob profile (same contract as `tools/gen-walk.py`):
- `sever_walk_down.png` / `sever_walk_up.png` / `sever_walk_side.png` — 6×96 frames (576×96). Side authored facing RIGHT. Frame 0 = idle pose per facing.

## Staged paths (ready to wire / later PR)
### In-repo drop (local, uncommitted)
- `/workspace/blobrogue/public/sprites/sever.png`
- `/workspace/blobrogue/public/sprites/sever_anchor.png`
- `/workspace/blobrogue/public/sprites/sever_walk_down.png`
- `/workspace/blobrogue/public/sprites/sever_walk_up.png`
- `/workspace/blobrogue/public/sprites/sever_walk_side.png`

### Working masters (fal-art)
- `/workspace/fal-art/sever/cut/sever_e-cut.png`
- `/workspace/fal-art/sever/cut/sever_anchor_a-cut.png`
- `/workspace/fal-art/sever/px/sever.png`
- `/workspace/fal-art/sever/px/sever_anchor.png`
- `/workspace/fal-art/sever/out/*` (copies + alt anchor)

### Local assets.ts hook rewire (uncommitted, on `main` working tree — **do not push**)
- `registerDirectionalSet("sever", { walkFps: 6 })` (dropped `fileBase: "weaver2_px"`)
- `SHEETS["sever_anchor.idle"]` → `/sprites/sever_anchor.png`
- `SPRITES.sever` / `SPRITES.sever_anchor` → `/sprites/sever.png` / `/sprites/sever_anchor.png`

## Explicit non-actions
- Did **not** push, merge, or deploy.
- Did **not** touch `weaver2_px*`.
- Did **not** use PIL/procedural body authoring (PIL only for pixelize enforce + walk transforms from the fal base).
- Did **not** use `--lane global`.
