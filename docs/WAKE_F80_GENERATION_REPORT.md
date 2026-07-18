# Wake F80 Generation Report — THE LAST PROCESSION

**Status:** fal art generated + staged locally. **NOT pushed / NOT merged to main.**

**When:** 2026-07-17 ~17:45 PT (2026-07-18 ~00:45 UTC)

## Problem
`assets.ts` recycled `weaver2_px` for `wake` + `convoy_blocker`.

## Creative lock
- **Wake:** last-light convoy / **THE LAST PROCESSION** — dusk front, **not** weaver
- **convoy_blocker:** BREAK/USE barricade latch, distinct from bier body
- NIGHTFALL_PROCESSION naming retired forever

## Pipeline (locked)
`fal-ai/flux/dev` → `fal-ai/birefnet` → crop-fill → `tools/pixelize.py` (`--palette-hex`, **never** `--lane global`) → walks from ONE base.

## Palette (last-light dusk wood + amber)
```
--palette-hex 05030b,0e0b1a,301c0e,6b401e,9c6633,7a3d12,c77320,ffb43b,ffd166,ffffff
--family-dark 05030b
```

## Selected takes
| Asset | Source cut | Grid→export | Notes |
|---|---|---|---|
| `wake` body | `cut/wake_r3a-cut.png` | 48→96 | Flat hexagonal funeral bier / coffin lid, warm amber wood. No limbs. |
| `convoy_blocker` | `cut/convoy_blocker_a-cut.png` | 32→64 | Dark plank barricade + glowing amber latch. BREAK target. |

**Silhouette IoU vs weaver2_px (96px):** ~0.417 (under 0.6 gate).

### Rejected
- `wake_a/b/c` (r1) — gothic arches / spider legs / oval spider chassis
- `wake_r2*` — still isometric shrine/altar leakage
- `wake_r3b/c` — portal / hearth isometric, not flat bier
- `convoy_blocker_b` — kept as alt post under `cut/`

## Prompts used (selected)

### wake_r3a (body — SELECTED)
> TRUE bird's-eye TOP-DOWN 2D game boss sprite: a FLAT elongated oval FUNERAL BIER LID seen from directly above, warm amber wood grain coffin-litter board… ABSOLUTE BANS: no spider, no legs, no archway, no stairs…

### convoy_blocker_a (prop — SELECTED)
> a single top-down video-game BREAK-TARGET prop: a thick dusk CONVOY BLOCKER barricade plank of soot-black wood with a warm amber last-light latch glowing in the center…

## Walks
From ONE base `px/wake.png` via solemn procession bob:
- `wake_walk_down.png` / `_up.png` / `_side.png` — 6×96 (576×96).

## Staged paths
### In-repo
- `/workspace/blobrogue/public/sprites/wake.png`
- `/workspace/blobrogue/public/sprites/convoy_blocker.png`
- `/workspace/blobrogue/public/sprites/wake_walk_{down,up,side}.png`

### Working masters
- `/workspace/fal-art/wake/cut/wake_r3a-cut.png`
- `/workspace/fal-art/wake/cut/convoy_blocker_a-cut.png`
- `/workspace/fal-art/wake/px/wake.png`
- `/workspace/fal-art/wake/px/convoy_blocker.png`

### Local assets.ts
- `registerDirectionalSet("wake", { walkFps: 6 })`
- `SHEETS["convoy_blocker.idle"]` → `/sprites/convoy_blocker.png`
- `SPRITES.wake` / `convoy_blocker` → unique PNGs

## Explicit non-actions
- No push/merge/deploy. No `weaver2_px` edits. No `--lane global`. No PIL body authoring.
