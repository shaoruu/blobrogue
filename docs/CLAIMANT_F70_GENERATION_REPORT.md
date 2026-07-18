# Claimant F70 Generation Report — ALL THINGS OWED

**Status:** fal art generated + staged locally. **NOT pushed / NOT merged to main.**

**When:** 2026-07-17 ~17:45 PT (2026-07-18 ~00:45 UTC)

## Problem
`assets.ts` recycled `weaver2_px` for `claimant` + `claim_socket`.

## Creative lock
- **Claimant:** gilded debt / crown / **ALL THINGS OWED** — token boss, **not** weaver
- **claim_socket:** BREAK/USE deposit socket, distinct from crown body
- CROWNFALL naming retired forever

## Pipeline (locked)
`fal-ai/flux/dev` → `fal-ai/birefnet` → crop-fill → `tools/pixelize.py` (`--palette-hex`, **never** `--lane global`) → walks from ONE base.

## Palette (gilded debt / amber construct)
```
--palette-hex 05030b,301c0e,7a3d12,c77320,ffb43b,ffd166,ffffff,6b6f8a,c9c9de
--family-dark 301c0e
```

## Selected takes
| Asset | Source cut | Grid→export | Notes |
|---|---|---|---|
| `claimant` body | `cut/claimant_r2b-cut.png` | 48→96 | Hex gilded debt seal + amber claim-core. ZERO legs (r1 spider takes rejected). |
| `claim_socket` | `cut/claim_socket_a-cut.png` | 32→64 | Octagonal deposit socket + amber well. USE/BREAK target. |

**Silhouette IoU vs weaver2_px (96px):** ~0.486 (under 0.6 gate).

### Rejected
- `claimant_a/b/c` (r1) — multi-leg spider/crown hybrids
- `claimant_r2a` — star-seal; higher fill overlap
- `claimant_r2c` — crown-in-ring; higher IoU vs weaver

## Prompts used (selected)

### claimant_r2b (body — SELECTED)
> a single top-down twin-stick boss sprite: a living GOLDEN CROWN as a thick flat hexagon of amber-gold obligation metal, solid continuous body with NO limbs, a small fused crown notch at the top edge, glowing amber debt lens in the middle… CRITICAL: ZERO legs…

### claim_socket_a (prop — SELECTED)
> a single top-down video-game USE/BREAK-TARGET prop: a hexagonal CLAIM SOCKET pedestal of dark bronze with a bright glowing amber-gold hexagonal receptacle… NOT a creature…

## Walks
From ONE base `px/claimant.png` via crown-pulse profile:
- `claimant_walk_down.png` / `_up.png` / `_side.png` — 6×96 (576×96).

## Staged paths
### In-repo
- `/workspace/blobrogue/public/sprites/claimant.png`
- `/workspace/blobrogue/public/sprites/claim_socket.png`
- `/workspace/blobrogue/public/sprites/claimant_walk_{down,up,side}.png`

### Working masters
- `/workspace/fal-art/claimant/cut/claimant_r2b-cut.png`
- `/workspace/fal-art/claimant/cut/claim_socket_a-cut.png`
- `/workspace/fal-art/claimant/px/claimant.png`
- `/workspace/fal-art/claimant/px/claim_socket.png`

### Local assets.ts
- `registerDirectionalSet("claimant", { walkFps: 6 })`
- `SHEETS["claim_socket.idle"]` → `/sprites/claim_socket.png`
- `SPRITES.claimant` / `claim_socket` → unique PNGs

## Explicit non-actions
- No push/merge/deploy. No `weaver2_px` edits. No `--lane global`. No PIL body authoring.


## Ship override (blobrogue)
Selected body for ship: `claimant_r2b` (crowned dome) over r2a hex-seal — r2a read as a socket/prop, not a boss.
