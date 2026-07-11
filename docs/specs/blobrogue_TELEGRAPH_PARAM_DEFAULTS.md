# TELEGRAPH PRIMITIVE PARAM DEFAULTS (designer 909783f3, exact px + lead times, 2026-07-06)
# Base units: TILE=48px, dash reach ~112px, player body r~13px, walk 200px/s.
# Bake as renderer defaults; runner overrides per-instance from balancer timings if retuned. DYNAMIC lock = 60% of lead, bound to real isAimLocked tick.

## 12 PRIMITIVES — bake these params
1. LANE       width 48px default (Jet lance, Quorum dmg-volley 48; Tithe SLAB HURL + OVERCLOCK beam 72). length=full arena. lead 0.75s. DYNAMIC lock 0.45s.
2. WEDGE      half-angle 30°, range 240px (5 tiles). origin = boss center + radius. safe = 2 flanking arcs (each >=40° clear). lead 0.7s. DYNAMIC (mirror-cone) lock 0.42s.
3. FAN (spread family) 5 shards, 12.9° apart (0.9rad total), 16px shard width, range 288px. safe = the 4 gaps but ONLY from mid-far: gap clears 26px body from ~tile4, reaches full 48px comfortable-stand at tile6. NEAR field (tiles 1-3, gaps<26px) = NO pocket, dash-through. lead 0.7s. [AD-VERIFIED corrected split]
3b. RAPID (dash-through dense LANE) 4 shards, 0.18rad total (~3.4° apart) = tight aimed suppressing stream, NO standable pocket BY DESIGN. render as ONE dense dash-through band (~42-59px wide mid-range, < dash 112px so a roll clears it). honest read = 'dash the stream on iframes', NOT stand in a gap. DYNAMIC (aimed). lead 0.7s.
4. ARC_PARABOLA  3 dotted parabolas to first-bounce; landing marker disc r=36px. lead 0.7s.
5. TRACK_DISC r=24px hollow while tracking -> SOLID + snap-ring (r->32px 1 frame) at lock. track 1.0s, snap-flash 0.2s before fire. hollow->solid = "dash now."
6. RING_BAND  band thickness 48px, expands r=0 -> outer 240px (5 tiles) over 0.5s active. safe = center disc <=48px of origin OR beyond outer. lead 0.9s (Gorge) / 0.8s (Quorum heal-ring, outer 120px). dash-through on iframes.
7. IMPACT_DISCS  r=36px each, count per attack. safe = gaps >=48px. lead 0.7s. (debris + SPEW)
8. RAMP_FILL  filled circle r=72px (1.5 tiles), intensity ramps over 1.0s. area-denial. lead = the 1.0s ramp.
9. SWEEP_ARC  swept band width 72px, sweep 120° around pivot, 0.6s active. safe = inside pivot (near anchor) OR dash band. lead 0.8s. Tithe SIG spokes = 4-6 arms @72px, ~90°/s continuous.
10. BARRIER_WALL  arc-wall 96px wide (2 tiles), in front of shield husk. NOT danger — LOS blocker (solid bone-cyan). persists while shield husk lives. no lead (placed state).
11. CONVERGE_POCKET  3 LANEs (48px) from 3 origins converging; draw shrinking pocket boundary. pocket ~192px -> ~64px over 0.6s active. NEVER < 64px. lead 0.7s, lock 0.42s then sweep.
12. MOVING_CAPSULE  width 72px (1.5 tiles), moves ~140px/s (< player walk 200 = outrunnable). continuous telegraph. safe = dash perpendicular past (72 < 112 dash = clears).

## PER-ATTACK LEAD OVERRIDES (differ from primitive default)
JET:    mirror salvo 0.7 · tracer 1.0 track +0.2 snap · recoil line 0.6 · overclock feint 0.8 (mini-ring 0.35) · SIGNATURE beam 1.0
TITHE:  gorge 0.9 (double-pulse staggered 0.4) · tether feed 1.0 · spew 0.7/wave · slab hurl 0.8 · SIGNATURE rip 1.0
QUORUM: crossfire 0.7 · tether snap 0.8 · role volley 0.6/husk (staggered 0.4) · hunt-pair charger 0.75 · merge fuse 1.2 (non-invuln, no dodge)
Global floor: nothing under 0.6s cold. Only sub-0.6 = tracer snap-flash 0.2s but rides a 1.0s track (total warning >=1.0s).

## BAKE INVARIANTS (renderer must enforce)
- Safe-pocket CLAMP: every pocket >=48px, reachable by walk-or-one-dash (112px). If renderer computes pocket <48px at runtime (e.g. CONVERGE_POCKET fully closed), CLAMP to 64px min. A sealed pocket = unfair; clamp rather than let it close. THIS IS A HARD RENDERER RULE.
- Lead default if unspecified 0.75s; signatures 1.0s; merge 1.2s.
- DYNAMIC lock at 60% of lead universally, bound to the real isAimLocked tick (not an art timer).

## CROSS-CHECK vs my primitive->attack map (TELEGRAPH_RENDER_CONTRACT.md): CONSISTENT.
All 12 params map cleanly onto the attack->primitive assignments. No conflicts. Renderer now has real numbers for every shape + every attack's lead. Only remaining open items: mirror family enum on wire (JET signature shape/hue) + Tithe rip move flag (runner) + hue-source question (designer). None block building the renderer with these defaults.

## *** [RESOLVED 2026-07-06] FAN split into spread-FAN + rapid-dash-lane (was: params violated safe-pocket invariant) ***
## Root cause: 'FAN' merged TWO sim families. Fixed by splitting (see primitive 3 + 3b above). AD re-verified corrected spread geometry: standable gap opens tile4(body)/tile6(comfortable), near-field dash-through. rapid = dash-through, no pocket by design. FAN HOLD LIFTED — renderer cleared to build both.
## [original flag, for record]
FAN as stated (5 lines, 8° apart, 24px wide, range 288px) yields clear gaps between adjacent lines of only:
  tile3 -4px (lines OVERLAP) · tile4 +2.7px · tile5 +9.4px · tile6 +16.1px — ALL far below the 48px min (and below the 26px body).
Root: at 8° a 48px clear gap (24px line + 48 gap) needs range >=517px (~10.8 tiles); range is 288px (6). "Stand in a gap" is un-standable.
FIX OPTIONS (designer's call — geometry, not art):
  (a) widen spacing to ~22° between lines (gives ~48px gap at tile 4), OR
  (b) fewer/narrower lines (e.g. 3 lines), OR
  (c) reduce line width + push effective range, OR
  (d) reclassify: if it's meant to be dense suppressing fire dodged by DASHING THROUGH (not standing in a gap), then the safe read is "dash a line on iframes," not "stand between" — which changes the RENDER (I draw it as dash-through hazard, no promised standing pocket).
HOLDING FAN render pending designer resolution. All other 11 primitives verified consistent with the >=48px / dash-112 math.

## IMPACT_DISCS debris counts — DESIGN TARGETS (designer intent, NOT balancer-confirmed constants; bake as defaults, runner finalizes)
- GORGE SLAM: 3-4 discs (r=36px) in the ring gaps.
- SPEW ARC: ~6 discs/wave (r=36px), wave2 fills wave1 gaps.
- Jet lob (arc-family bloom): 1 marked bloom at target feet (single affix-charge) = 1 IMPACT_DISC (corrected — NOT several).
- Jet P3 drain (inverted salvo): 3 blooms (drainCount 3, spread 150px) around party = 3 IMPACT_DISCS.
- arc-family ring: 10 shards (arcCount 10) even around = RING_BAND spokes (count noted; not IMPACT_DISCS).
FLAGGED: to lock as hard numbers, runner/balancer must add to constants. Baked as reasonable defaults, clearly marked targets.

## CORRECTED FAMILY->PRIMITIVE MAP (supersedes rapid->FAN):
spread->FAN(12.9°, standable tile4+) · rapid->dash-through dense LANE(no pocket, option d) · lance->LANE · arc->RING_BAND(10 shards) · lob->ARC_PARABOLA+1 IMPACT_DISC · melee->short WEDGE. All match emit code. Only FAN split; other 11 stand.
