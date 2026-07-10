# THE TITHE (F40 boss) — art manifest

**Status: AD-APPROVED & LOCKED (2026-07-10).** Feeder down/up/side (+ mirror) + 2-state destructible slab.
Fresh gen (NOT a hero remap). Amber-feeder identity, contrast-verified against the real Sump floor (#16131a).

## Identity
The Tithe is a heavy, LOW, WIDE armored FEEDER gorged on the players' stolen amber — swollen translucent
amber sacs (#c77320/#ffb43b) bulging between dark chitin segments (#301c0e). It builds cover and re-armors
behind a feeding SLAB; the fight window = destroy the slab before it re-armors. Heavy, not colossal.

## Files (in public/sprites/, 96×96, art-bible palette)
- `tithe_walk_down.png` — down/front facing (LOCKED base, head-down feeding). Frame 0 = idle.
- `tithe_walk_up.png` — up/back facing (chitin back, sacs bulging up, legs splayed).
- `tithe_walk_side.png` — side profile, authored FACING RIGHT (renderer mirrors for left).
- `tithe_slab_intact.png` — feeding slab/trough INTACT (amber-crust over dark core, simmering amber in seams).
- `tithe_slab_cracked.png` — slab CRACKED/failing (hot amber bursting up the seams). Normalized to the
  intact's EXACT bbox (6,10,90,86) so the in-place state-swap does not pop.

## Wiring (build agent)
1. Add `tithe: "/sprites/tithe_walk_down.png"` to the SPRITES map in src/game/assets.ts (boss roster hooks).
2. registerDirectionalSet("tithe", { walkFps: <n>, facings: ["down","up","side"] }) — resolves
   tithe.walk_{down,up,side} to /sprites/tithe_walk_{facing}.png. Side is facing-right; renderer mirrors.
3. SLAB is a SEPARATE destructible entity (not part of the feeder sprite). Register the 2 states as its own
   sprite pair and swap intact->cracked as its HP drops; they share a footprint so the swap aligns in-place.
   Re-armor tell per brief = amber ooze rising up the seams (cracked->intact on re-armor).
4. Single-frame sheets today; a later pass can add multi-frame walk/attack under the same names.

## Audio (audio director owns)
Swell layer fades IN while feeding/re-armoring, drops OUT when the feeder is exposed (window audible).
Heavy but not colossal — NOT the giant signature (that is Gorge F50).

## Metric caveat (for future art gates)
The box red->amber re-lane inflates automated "amber-%" readouts (warm edge px counted as amber): my script
read ~20% amber on up/side where the true visible sacs are ~9% (AD's measure). The ART is correct (AD
verified sacs present in every view at zoom). Lesson: trust the AD visual gate + bright-luma amber (L>115),
not the loose amber bucket. Identity/silhouette gate > raw color %.
