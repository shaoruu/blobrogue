# PALE THRONE (F75 GIANT #2) — art manifest + AD gate record

**Status: AD-APPROVED & LOCKED (2026-07-12).** Second giant, inherits the Gorge F50 giant grammar
(docs/art_manifests/GORGE_F50_GIANT.md) EXACTLY — asymmetric listing colossus ~192px, same-shape
shell-peel, dim→mid→reveal — with the MATERIAL swapped to warmth-drain/COLD (no amber). F100 Unmaker
inherits this same grammar + the dark-body-on-light-floor discipline (void/subtraction material).

## Identity & mechanics
GIANT #2 (F75 Pale region cap). A colossal ~192px frozen/petrified monarch-monolith, STATIONARY
front-facing set-piece (no orientations). Multi-phase SHELL-PEEL identical to Gorge: each shell state
is its own mini earned-window fight reached by the player peel action (destroy telegraphed weak-points).
The exposed core is a COLD CRYSTALLINE THRONE-CORE — "the cold at the center pulling heat out of the room"
(a blazing ABSENCE of warmth, not fire). The Pale region DRAINS warmth as you descend (inverse of Gorge).

## Files (public/sprites/, 192×192)
- `pale_shell_stone.png`   — STATE 1: frost-pale petrified DARK stone, dormant/cold, bone rime on high edges, no glow.
- `pale_shell_cracked.png` — STATE 2: shell cracked, COLD-BLUE seams glow through (inverse of Gorge's hot cracks), body still dark.
- `pale_shell_core.png`    — STATE 3: shell peeled, brilliant cold-white/blue CRYSTALLINE throne-core blazing through the dark shell.
Escalation dim-cold→cold-cracks→cold-blaze (bright-px 2%→4%→14%).

## AD gate record (2026-07-12, all pass)
- Asymmetry 51/49/52% (>30% floor), COM offset 7.1/7.6/7.9% (~8%) — proper toppled monolith.
- Palette: 0% off-palette, 0 amber, 0 violet — on the cold lane.
- INVERSE READABILITY (critical, Pale is a LIGHT region): body dark% 67/46/54 holds a dark silhouette
  against the washed floor; S3 core lum 255 vs floor 201 → pops. Body kept DARK (#171227/#2a2140);
  pale lives in rime + cracks + core, NOT the body. Reads on dark bg too (rime edges hold silhouette).
- Cross-state IoU 0.92/0.93/0.89 (advisory; the legit core-reveal peel, not shape drift — reads as one giant).

## Cold pixelize lane (palette-hex, no amber/violet/teal)
05030b,0e0b1a,171227,2a2140,46356b,6b6f8a,c9c9de,ffffff,2a5fa0,57b6ff,bfeaff

## Method (reproduce for F100 Unmaker)
fal-EDIT from the shipped Gorge base states (tools/faledit.mjs, material-swap only → inherits silhouette
+ asym + IoU) → birefnet cutout → crop-fill → DARKEN body pre-pixelize (raw edit quantizes mid-value;
darken body*0.45 preserving brights so it holds dark on a light floor) → pixelize --palette-hex (cold lane)
--grid 48 → 192px nearest-neighbor. The dark-body-on-light-floor discipline is the load-bearing inversion.

## Encounter wiring
Reuses the shipped Gorge F50 encounter code (src/sim: the gorge boss kind's 3-phase shell-peel state
machine, weak-point peel verb, per-phase back-loaded HP, debris cover, 3 distinct spatial phases) with the
Pale material + F75 floor pin + cold-blue VFX instead of amber. Balancer sets F75 HP band (deeper than F50).

## ENCOUNTER MECHANICS — the F75 escalation (GD doctrine + balancer numbers, locked 2026-07-12)
DOCTRINE (sets the giant ladder): each giant adds a NEW READABLE AXIS per phase + ONE regional cross-cutting
mechanic — NEVER escalate by tightening the same pattern (that reads as "same fight, less margin" = punishing).
- F50 Gorge = the pattern (3 phases + peel verb).
- F75 Pale = pattern + one new axis/phase + regional signature (warmth-drain).
- F100 Unmaker = pattern + axes COMPOUNDED + Null "subtraction" signature (periodically REMOVE an affordance:
  delete cover / drop the safe-lane telegraph so you must have LEARNED it — "you know this fight, prove it").

F75 PER-PHASE DELTA vs Gorge (reuse shipped primitives, base params like Gorge, add the axis):
- P1 rings: + SECOND COUNTER-OFFSET ring (RING_BAND ×2), gap offset ~90-120°, ~0.4-0.5s behind; each gap SAME
  width as Gorge (the 2nd ring is the difficulty). Read = SEQUENCE (dash gap A → reposition to gap B).
- P2 pools: pools DRIFT/spread (~1 tile/1.5s) or seed at old edges → safe floor MIGRATES; denial cap ~⅓ arena,
  churn not fill (old expire as new seed). Read = motion-under-denial. Reuse cinder/slag pool + slow-spread tick.
- P3 sweeps: + SECOND COUNTER-ROTATING sweep (SWEEP_ARC ×2 opposite sign), ~same speed; safe = drifting
  INTERSECTION of two gaps, which must NEVER fully close (fairness assert). Read = track two rotations.

PALE SIGNATURE (cross-cutting, re-colors all 3 phases): WARMTH-DRAIN — per-player stillness timer, idle >~1.5s
→ move ×0.5 chill (reuse CHILL_SLOW 0.5), telegraphed by a ramping frost vignette (~1.5s), clears on moving a
meaningful distance. Punishes camping; all three axes already demand motion so it enforces intent coherently.
Slow only (never damage), capped at one ×0.5 (no stun stack), per-player at 4P. Deterministic.

BALANCER NUMBERS (fresh anchor — NOT floor-curve, which clamps at F10 → would give F75=F50=sponge):
total 1210, back-loaded per-shell [340,380,500], windowBankFrac 0.20/phase (tightened from Gorge 0.22),
minLegal 25, BOSS_DPS_CEILING 55 (provisional). Gate row pale_throne { floor:75, soloWall:[62,86],
exposed:[34,50], minLegal:25, party4P50:[44,64] } (provisional, measure-and-surface; reuse Gorge per-phase
windowOpener). The minLegal/bank are ONLY honest because the mechanics are a real step — PROOF METRIC: harness
must show F75 exposed-efficiency LOWER than F50 at same build (mechanic-time not HP-time), else it's a sponge (gate flag).

FAIRNESS (all held): ≥0.6s telegraphs (2nd ring/sweep telegraph like the 1st; warmth ~1.5s ramp), a real
safe pocket/lane ALWAYS exists (dual-ring gaps + dual-sweep intersection never fully close — asserted in test),
tighter windows only to the floor (≥0.30s dodge / ≥0.35s recover / ≥0.6s windup), overlap arbiter never relaxes
(max 2 committed + 1 arena denial, no 2 releases <0.30s same lane), 4P density controller budgets the doubled
patterns + culls ambient, never the fairness tells. Difficulty = execution density, never +damage/+HP/+guarded-time.
