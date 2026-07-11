# Boss telegraph footprint GEOMETRY (source: game designer 909783f3, 2026-07-06)
Grounded units: TILE=48px, player body ~13px radius, dash reach ~112px (~2.3 tiles) w/ 0.18s iframe, walk 200px/s.
Every safe pocket sized >=1 tile (fits 13px body + margin), reachable by walk or one dash. Lead times in fair band 0.45-1.4s.
DYNAMIC(aim-locks) = tell TRACKS player during windup, LOCKS at ~60% of lead (juke window). FIXED = geometry set at cast.

## JET (F35) — family hue cold-indigo
- A1 MIRROR SALVO — footprint IS the copied weapon's shape. Lead 0.7s. DYNAMIC (locks ~0.45s).
  - CONE copy: filled wedge from Jet, half-angle 30°, range 5 tiles (240px). Safe = outside wedge / dash apex sides; pocket = two ~40° clear arcs flanking cone.
  - SMG/SPRAY copy: fan of 5 narrow sub-lines, 8° apart, range 6 tiles. Safe = the 4 gaps between lines (~1 tile wide mid-range). "stand in a gap."
  - CHARGED LANCE copy: single straight beam-lane, width 1 tile (48px), full arena length. Safe = either side. Sidestep, don't dash in.
  - BOUNCING ORBS copy: 3 telegraphed launch arcs (dotted parabola) to first bounce point. Safe = not on landing dots.
  - Draw copied weapon footprint in cold-indigo hatch + leave dead-zone clear. SIGNATURE read.
- A2 TRACER BURST — 3 homing motes then snap. Motes track 1.0s, SNAP flash 0.2s before fire to locked pos. DYNAMIC then locks.
  - 3 small filled discs (r ~0.5 tile) following each player, HOLLOW (tracking) -> SOLID + bright snap-ring the instant they lock. Safe = move after snap flash. Job: make lock-moment unmistakable.
- A3 RECOIL LINE — Jet dashes leaving wall-trail. Lead 0.6s (shows path pre-dash). FIXED.
  - straight capsule along dash path, width 1 tile, persists 3s as lingering hazard (solid indigo bar during 0.6s tell, then dimmer sustained wall). 2nd RECOIL perpendicular -> draw 2nd tell while 1st wall stands. Safe = half arena wall doesn't cut; cross = quadrant clear of both.
- A4 OVERCLOCK FEINT (P2) — big beam windup, 30% cancels into short burst. Lead 0.8s. Beam telegraph drawn HONESTLY every time (filled beam-lane width 1.5 tiles, arena length). Feint: beam tell FADES (cancel cue) then SMALL radial burst footprint (ring inner 0 outer 1.5 tiles centered on Jet) flashes own 0.35s mini-tell before firing. feint = beam-fades-THEN-tiny-ring. Both honest. Safe: real=off lane; feint=outside 1.5-tile ring.
- SIGNATURE @35% — mirrors squad's BIGGEST attack as screen-crossing beam. Lead 1.0s. FIXED. Wide beam-lane (width 2 tiles) across whole arena, drawn in the COPIED ATTACK'S OWN hue, with clear dash-gap to roll through on iframes. Safe = authored gap + dash-through timing.

## THE TITHE (F40) — family hue amber
- A1 GORGE SLAM — rear-up, shockwave RING + debris. Lead 0.9s. FIXED (centered on Tithe).
  - expanding annulus — outer reach r 5 tiles = danger; SAFE = clear center disc within 1 tile of Tithe (inside ring) OR beyond 5 tiles. Band ~1 tile thick expanding outward over 0.5s; dash THROUGH band on iframes or stand safe center. Draw band as hatched danger edge + debris as 3-4 fixed impact discs (0.5 tile) in gaps.
  - P2 DOUBLE-PULSE = two concentric bands staggered 0.4s — draw both ("dash first, reposition, dash second").
- A2 TETHER FEED — feeding zones become damaging. Lead 1.0s (glow ramps). FIXED (2-3 anchors).
  - 2-3 filled circles (r 1.5 tiles) at anchors, glowing brighter over 1.5s ramp. Safe = outside them (area-denial not burst). Fill intensifies = "getting hot."
- A3 SPEW ARC (P2) — two-wave glob spread. Lead 0.7s per wave, wave-2 tell visible BEFORE wave-1 lands. FIXED, arced in front.
  - WAVE1 = ~6 landing discs (0.75 tile) in arc 3-5 tiles out. WAVE2 = ~6 discs filling GAPS between wave-1, in distinct lighter/dashed amber. Both become lingering pools (2s). Safe = wave-1 gaps ONLY until wave-2 tell shows, then spots neither covers. KEY multi-stage read.
- A4 SLAB HURL (P2) — throws slab as line projectile. Lead 0.8s. DYNAMIC (aims at player, locks ~0.5s). straight lane (width 1.5 tiles) Tithe->locked target, full length. Safe = off lane. Leaves that side of Tithe unarmored.
- SIGNATURE (low HP) — rips ALL slabs, rotating barrage. Lead 1.0s (big rip tell). ROTATING SPOKE: 4-6 slab-projectiles as spinning spokes (each 1.5-tile-wide arm) rotating ~90°/s. Draw rotating arms + clear wedges between (moving safe pockets). Safe = ride a rotating gap. Then Tithe collapses exposed.

## QUORUM (F45) — family hue bone-cyan
- A1 CROSSFIRE LINES — 3 husks fire converging beams. Lead 0.7s. Semi-DYNAMIC (aim tracks, locks ~0.45s, THEN beams sweep toward each other over 0.6s active).
  - 3 beam-lanes (width 1 tile each) from husks + drawn indicator of convergence sweep — the SHRINKING pocket between them. Draw pocket boundary moving inward. Safe = be in shrinking pocket early, or dash a beam as they close. "read the convergence."
- A2 TETHER SNAP — shield-tether whips across floor. Lead 0.8s. FIXED (shows arc). swept arc — curved band ~1.5 tiles wide sweeping ~120° around tether pivot, pivot clear. Safe = inside pivot (near anchor husk) OR dash band on iframes. Signature "the link is the weapon."
- A3 ROLE VOLLEY — each husk attacks in character, in SEQUENCE. Lead 0.6s per husk, staggered ~0.4s (three tells in a row).
  - DMG husk: aimed 3-shot, 3 short lanes (0.75 tile wide) — DYNAMIC, locks 0.4s.
  - HEAL husk: expanding knockback ring (annulus outer 2.5 tiles) centered on heal husk — FIXED. Safe = outside or center.
  - SHIELD husk: directional barrier (2-tile-wide arc-wall in front) that BLOCKS YOUR shots — FIXED. Solid bone-cyan wall = "reposition to keep DPS."
  - Draw all three time-staggered so player reads a SEQUENCE not a blob.
- A4 HUNT PAIR (P2, after shield husk dies) — two husks pincer. HERDER = MOVING_CAPSULE (slow 1.5-tile-wide wall pushing you); CHARGER = LANE DYNAMIC (1-tile lane, locks ~0.5s) from opposite side. Lead: herder telegraphs continuously (capsule drawn as it advances), charger 0.75s.
  Safe = break the pincer GEOMETRY: dash PAST the herder before the charger lane locks. Trap = herder pushes you into the charge lane; escape = dash perpendicular past the herder (through its capsule on iframes) so you are no longer between the two. Pocket = anywhere NOT on the line between herder and charger. Read: do NOT back away from the wall (that is where the charge wants you), cut sideways past it.
- QUORUM SIGNATURE = THE MERGE (@45%, the transition itself, NOT a separate attack): fuse beat = flash + tether beams collapsing inward into amalgam (AD VFX). NO danger footprint of its own (1.2s NON-invuln transition — players keep hitting it, no dodge during fuse). AFTER merge, amalgam threat = back-to-back COMBO of existing primitives: CONVERGE_POCKET (A1 crossfire) immediately -> SWEEP_ARC (A2 tether-snap) in one body, widened >=0.45s recover drawn as the gap between them. Signature footprint = A1->A2 chained faster w/ readable recover-gap. NO new primitive. Drama is all in the fuse VFX.

### RESOLVED 2026-07-06: designer resent A4 safe-pocket + Quorum signature (the merge). Geometry now COMPLETE.
