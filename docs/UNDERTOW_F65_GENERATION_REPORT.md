# Undertow F65 Generation Report — THE RIVER COMES BACK

**Status:** fal art generated + staged locally. **NOT pushed / NOT merged to main.**

**When:** 2026-07-17 ~17:45 PT (2026-07-18 ~00:45 UTC)

## Problem
`assets.ts` recycled `weaver2_px` for `undertow` + `relief_vent`. Ian rejected spider reuse across deep bosses.

## Creative lock
- **Undertow:** resin-eel / reverse-floor / **THE RIVER COMES BACK** — flood predator, **not** spider
- **relief_vent:** BREAK/USE deposit target (floor grate), distinct from boss body

## Pipeline (locked)
`fal-ai/flux/dev` → `fal-ai/birefnet` → crop-fill → `tools/pixelize.py` (explicit `--palette-hex`, **never** `--lane global`) → directional walks from **ONE** base via squash/stretch/undulate (no separate AI frames).

## Palette (teal flood resin + amber reverse-current)
```
--palette-hex 05030b,0f4a4a,1fa89a,6ff0d8,7a3d12,c77320,ffb43b,6b6f8a,c9c9de,ffffff
--family-dark 0f4a4a
```
Distinct from Weaver cold-indigo, Sever soot/amber blade, Claimant gilded gold, Wake dusk wood.

## Selected takes
| Asset | Source cut | Grid→export | Notes |
|---|---|---|---|
| `undertow` body | `cut/undertow_b-cut.png` | 56→96 | Teal resin-eel S-coil + amber dorsal/eye glow. Legless flood serpent. |
| `relief_vent` | `cut/relief_vent_a-cut.png` | 32→64 | Circular floor grate + amber deposit mouth. Reads as USE/BREAK target. |

**Silhouette IoU vs weaver2_px (96px):** ~0.375 (under 0.6 gate).

### Rejected
- `undertow_c` — spider-leg hybrid leak
- `undertow_a` / `undertow_r2*` — weaker silhouette or extra splash mass after pixelize
- `relief_vent_b` — kept as alt square hatch under `cut/`

## Prompts used (selected)

### undertow_b (body — SELECTED)
> a single top-down video-game boss sprite of a living black-teal RESIN EEL: thick continuous serpentine body of glossy flood-resin, coiled horseshoe loop with head at top of canvas, dorsal ridge of wet black resin, thin warm amber reverse-current glow along the spine, reads as a river predator returning upstream, legless, CRITICAL SHAPE RULES: ZERO spider… centered on plain flat pure white background…

### relief_vent_a (prop — SELECTED)
> a single top-down video-game USE/BREAK-TARGET prop: a circular FLOOR RELIEF VENT grate of dark wet stone with glowing warm-amber deposit aperture in the center, chunky readable grill bars… NOT a creature…

## Walks
From ONE base `px/undertow.png` via undulate swim profile:
- `undertow_walk_down.png` / `_up.png` / `_side.png` — 6×96 frames (576×96). Side facing RIGHT.

## Staged paths
### In-repo (`blobrogue`, uncommitted)
- `/workspace/blobrogue/public/sprites/undertow.png`
- `/workspace/blobrogue/public/sprites/relief_vent.png`
- `/workspace/blobrogue/public/sprites/undertow_walk_{down,up,side}.png`

### Working masters
- `/workspace/fal-art/undertow/cut/undertow_b-cut.png`
- `/workspace/fal-art/undertow/cut/relief_vent_a-cut.png`
- `/workspace/fal-art/undertow/px/undertow.png`
- `/workspace/fal-art/undertow/px/relief_vent.png`

### Local assets.ts (dirty tree — do not push)
- `registerDirectionalSet("undertow", { walkFps: 6 })` (dropped `fileBase: "weaver2_px"`)
- `SHEETS["relief_vent.idle"]` → `/sprites/relief_vent.png`
- `SPRITES.undertow` / `relief_vent` → unique PNGs

## Explicit non-actions
- Did **not** push, merge, or deploy.
- Did **not** touch `weaver2_px*`.
- Did **not** use PIL/procedural body authoring (PIL only for fill/pixelize/walk transforms).
- Did **not** use `--lane global`.
