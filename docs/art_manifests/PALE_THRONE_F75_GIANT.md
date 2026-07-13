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
