# TELEGRAPH RENDER CONTRACT (art-side drawing spec)
# AD owns: how each footprint RENDERS. Designer owns: the geometry/hitbox (see TELEGRAPH_GEOMETRY_from_designer.md).
# Code-drawn parametric, extends existing renderTelegraph/TELEGRAPH_COLOR + frost_zone/tether. Ground plane: under sprites, over floor.

## PRIMITIVE LIBRARY (all boss attacks decompose into these — build the renderer once, param per attack)
1. LANE (capsule)         — start, end|angle, width, length. -> beams, lances, slab lanes, charges, recoil walls, dmg-husk shots.
2. WEDGE (filled cone)    — origin, facing, half-angle, range. -> Jet cone copy.
3. FAN (N sub-lanes)      — origin, center-angle, count, angular-gap, per-lane width, range. -> Jet SMG copy. Safe=gaps (unpainted).
4. ARC_PARABOLA (dotted)  — from, landing pt, dotted parabola. -> Jet bouncing-orb copy.
5. TRACK_DISC (lock-flip) — follows target, radius; HOLLOW while tracking -> SOLID + snap-ring at lock. -> Jet A2 tracer. THE lock primitive.
6. RING_BAND (annulus)    — center, inner r, outer r, band thickness, expand-rate, safe-center r. -> Tithe slam (double=2 staggered), Quorum heal ring.
7. IMPACT_DISCS (set)     — centers[], radius, wave-index. -> Tithe debris, spew waves, Jet feint burst.
8. RAMP_FILL (area-denial)— center, radius, intensity ramps over lead. -> Tithe tether feed.
9. SWEEP_ARC (swept band) — pivot, radius, band width, arc-span, sweep rate. -> Quorum tether snap; Tithe signature rotating spokes (each spoke=rotating LANE from pivot).
10. BARRIER_WALL (solid)  — pos, facing, width, arc. Solid obstacle (blocks shots), NOT hatched-danger. -> Quorum shield husk.
11. CONVERGE_POCKET       — moving boundary of clear area as beams close. Draw the pocket EDGE shrinking inward. -> Quorum crossfire.
12. MOVING_CAPSULE        — LANE that translates over time (herder push). -> Quorum A4 herder.

## CROSS-CUTTING RENDER RULES
R1 REGISTER: reserved enemy-telegraph register only. Never reuse bullet/player-FX colors. Ground plane.
R2 FILL + DANGER-EDGE (AD proposal, needs designer/blobrogue buy-in): FILL = family hue @ ~0.22-0.30 alpha (Jet cold-indigo, Tithe amber, Quorum bone-cyan) = WHICH boss. EDGE = universal hot danger-hatch (high-value warning) = "this HURTS," reads regardless of boss. EXCEPTION: Jet mirror-salvo + Jet signature draw in the COPIED WEAPON'S OWN hue (identity read trumps — "that's my gun").
R3 SAFE = CLEAR FLOOR: never paint the safe pocket. Absence of danger-paint IS the safe read. Pockets stay >=1 tile, visually open.
R4 FIXED vs DYNAMIC (critical juke-window tell): FIXED = crisp solid edge from cast (committed). DYNAMIC = SOFT pulsing edge that FOLLOWS the player during track, then SNAPS to crisp + lock-flash at lock (~60% of lead). Soft->hard snap = "juke window just closed."
R5 LOCK-FLIP (shared): hollow/soft -> solid/crisp + one bright snap-ring/edge-flash the frame it locks. Instant, no fade. Same discipline as boss expose overlay.
R6 MULTI-STAGE: later stage drawn in distinct sub-treatment (lighter value + DASHED edge), visible BEFORE prior stage resolves. Stage1 solid, stage2 dashed-lighter. (Tithe spew wave2-in-gaps; slam double-pulse.)
R7 FEINT HONESTY: real tell + feint tell BOTH drawn truthfully. Cancel = visible FADE of the beam tell; burst then gets its own 0.35s mini-tell (ring) before firing. No untelegraphed damage ever.
R8 LINGERING: pre-fire tell = bright. Post-fire lingering hazard = dimmer sustained fill ("still hot, not the tell"). (Jet recoil wall 3s, Tithe pools 2s.)
R9 4P OVERLAP SURVIVAL: fixed hatch ANGLE per boss so overlapping dangers still parse. Family hue saturated. Z: fills bottom, edges/lock-flashes top (lock never buried). Cap combined telegraph alpha so 3 stacked don't black the floor.
R10 AURA vs TELEGRAPH: boss aura ring = soft low-sat pulsing UNDER-glow (ambient identity). Telegraph = hard-edged high-sat hatched danger. Same family hue OK — value+edge+shape differ (never hue alone).

## ATTACK -> PRIMITIVE MAP
JET: A1=WEDGE|FAN|LANE|ARC_PARABOLA (copied-weapon hue) · A2=TRACK_DISC · A3=LANE(+lingering, 2nd perpendicular) · A4=LANE(honest)+feint IMPACT_DISCS ring · SIG=LANE width2 in copied hue + dash-gap.
TITHE: A1=RING_BAND+IMPACT_DISCS (P2 double band) · A2=RAMP_FILL x2-3 · A3=IMPACT_DISCS wave1 solid + wave2 dashed-in-gaps · A4=LANE DYNAMIC · SIG=SWEEP_ARC spokes (4-6 rotating LANEs).
QUORUM: A1=LANE x3 + CONVERGE_POCKET · A2=SWEEP_ARC · A3=LANE(dmg)+RING_BAND(heal)+BARRIER_WALL(shield), time-staggered · A4=MOVING_CAPSULE(herder)+LANE DYNAMIC(charger), safe=dash perpendicular past herder off the herder-charger line · SIG=THE MERGE (transition, no danger footprint; fuse VFX only) then A1->A2 combo w/ >=0.45s recover-gap. NO new primitive.

## STATUS / OPEN ITEMS
- [RESOLVED] Quorum A4 + SIGNATURE geometry: designer resent. A4 = MOVING_CAPSULE+LANE pincer, safe=dash past herder. SIGNATURE = the merge (fuse VFX, no footprint) then A1->A2 combo. Geometry now COMPLETE across all 3 bosses.
- [APPROVED] R2 universal hot danger-edge + family-hue fill: designer confirmed. Danger-edge="dodge" everywhere; fill-hue="who/what" everywhere; EXCEPT Jet mirror-salvo + signature fill in copied weapon's OWN hue (identity trumps). Universal edge also serves colorblind / 2-boss-hue-overlap cases.
- [NEW — RUNNER WIRE] Aim-lock snap binding: the DYNAMIC soft->hard SNAP must fire on the ACTUAL isAimLocked/lockedAngle commit tick (~60% lead), NOT a separate art timer, or players learn wrong juke timing. Runner must fire a lock EVENT the renderer reads (same pattern as the expose flag). After snap, tell is FIXED-crisp for remaining ~40% lead = "you can still move out, aim won't follow."
- Renderer can be built NOW (independent of boss BODY art) — designer confirms it can build+ship AHEAD of the body-art gate. Highest-value piece (the "creative not unfair" fix). Body sprites still pending Ian's gate.
- Designer offers exact px + per-primitive default lead times for any primitive on request.
