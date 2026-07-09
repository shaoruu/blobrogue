# blobrogue — MOB MOVEMENT VARIETY WAVE 1 (build-ready)
Strongest first wave, chosen (not a menu): **Bat Orbit→Dive, Slime Pack Encirclement→Surge, new Rattleback Ambush, new Crookleg Wall-Pounce.** Four reads before sprite: flank / surround / vanish-erupt / wall-to-air leap. Maximum contrast with minimal architecture: all reuse `AttackState` (windup→active→recover), flow-field approach, `moveEnemyBy`, line/ground telegraphs, spawn grace, and the shipped anti-stuck net. Future `stepWorld` compatible: all state is plain deterministic data; no render/browser logic in movement.

## Universal movement grammar (CD spine — adopted)
Every mob has **ONE primary movement verb** and at most one escalation modifier. These are reusable AI modules, not bespoke rules per sprite:
- **HUNT** — close, telegraph, commit (chase/lunge).
- **ORBIT** — hold radius/angle, look for an opening.
- **BURROW** — leave the combat plane, visibly mark destination, return.
- **ANCHOR** — claim space and force repositioning.
- **FLOCK** — group steering, separate/re-form around obstacles.
- **FLEE / BAIT** — retreat toward support/hazards, turn when safe.

Wave-1 mapping: Bat = ORBIT→HUNT; Slime = FLOCK→HUNT; Rattleback = BURROW; Crookleg = HUNT with a wall-launch modifier. This framework is the lasting contract: future mobs should reuse these modules and add at most one genuine hook.

## Biome movement grammar (CD spine — adopted)
- **Amberwild = elastic/alive:** coil, hop, flock, recoil. Telegraph through squash, leaves, roots. Wave-1 Pack Slime teaches FLOCK safely.
- **Sunless Caves = sound/momentum:** pause/listen, commit to last-heard position, wall impacts matter. Telegraph with head/ear tilt, falling dust, hearing flare. Wave-1 Orbit-Dive Bat and Rattleback fit here; later add a FLEE/BAIT Knellbat.
- **The Deep = fracture/wrong geometry:** fixed-beat orbit radius changes, visible seams, angular blinks (never unreadable teleport spam). Wave-1 Crookleg introduces wall geometry; later Seamwalker becomes the pure biome thesis.
- **Emberreach = convection/pressure:** anchor, vent, jet-dash, fissure eruption; bursts separated by visible cooling/recovery. Re-skin existing verbs before inventing new ones.

**Silhouette/readability rule:** the idle silhouette must imply the verb before it starts (leaf fins=flock, ears=listen/bait, low shell=burrow, wall claws=pounce). Direction/destination visible 0.4–0.7s before commitment; walking dodgeable; real recovery.

## Why these four
- Current roster already covers direct chase (slime), zigzag chase (bat), phase drift (ghost), lunge (skeleton), and kite (spitter), but the first two still READ as "everyone comes at me."
- This wave changes the geometry of the fight: enemies approach your SIDE, occupy a RING, attack from BELOW, and launch from WALLS. It creates positioning decisions without another projectile/status/currency system.
- Explicit cuts for Wave 1: no anchor/pull (moves the player, high frustration/network reconciliation risk), no split-on-hit (spawn mechanic, not movement), no retreat-then-charge (overlaps spitter+skeleton), no generic speed variants.

===============================================================
# Shared code changes (small, data-driven)
===============================================================
Extend:
```
Movement = ... | "orbit" | "pack" | "burrow" | "wallPounce";
AttackMove = ... | "dive" | "surge" | "burrow" | "pounce";
EnemyKind += "rattleback" | "crookleg";
```
Add plain scratch to Enemy (or a generic `moveState` object post-Stage-A):
```
moveSeed:number;       // deterministic 0..1; replaces using visual anim clock for sim decisions
moveTargetX/Y:number;  // orbit slot / wall anchor / underground target
moveTimer:number;
flags:number;          // SUBMERGED, AIRBORNE bits (or explicit booleans)
```
`zig` may supply moveSeed in current code, but after Stage-A initialize it from seeded Rng, never Math.random.

New helpers, all in sim/world AI:
- `moveEnemyFree(e,dx,dy)`: ignores walls/props but clamps world bounds — ONLY for SUBMERGED or AIRBORNE active phases. Do not set archetype `isPhasing:true` permanently.
- `nearestWallPoint(e, maxTiles=3)`: scan local tile square for closest wall edge; deterministic tie-break by tile index. Used only by crookleg.
- `nearbyCount(kind,x,y,r)` + optional separation vector. Enemy counts are ≤14 now; O(n²) is fine. Post-open-world use spatial grid, same call contract.
Everything else reuses `findTarget`, `chaseAngle`, `applyChaseStep`, `stepWindupTimer`, `beginWindup`, `enterRecover`, `enterIdle`, `moveEnemyBy`.

===============================================================
# SMART AI CONTRACT (contextual, readable, never cheating)
===============================================================
"Smart" means decisions from authoritative WORLD FACTS the creature could plausibly sense — own HP, ally count/positions, distance/LOS, recent damage, terrain anchors, boss phase. It NEVER reads raw player input, aim cursor, cooldown buttons, future path, or hidden inventory to counter the player.
- Evaluate expensive context at 4–6Hz, not every frame; commit to a state for a minimum duration so behavior is readable and network deterministic.
- Every decision change has a material tell ≥0.35s and a counter: chase the bait vs hold ground; kill the leader vs accept flanks; deny a wall anchor vs dodge the leap.
- Context creates positioning decisions, never perfect dodges. Enemies may target current/last-seen positions, not predicted inputs.
- Pack roles are deterministic from stable entity ids and context, not random each tick. Leader death breaks coordination visibly before re-election.

**Boss smart-movement contract (future boss handlers, lock now):** phase transitions may reposition using terrain, but only to authored arena anchors/valid walkable points. On phase change: choose the farthest valid anchor with LOS/path constraints, telegraph destination/material path ≥0.7s, then move; never teleport directly onto/behind a player. Bosses can choose a technique based on range/terrain/add count, not based on player button state. Reposition is limited to once/phase or a clear cooldown; reaching favorable terrain enables the move, it does not grant hidden stat buffs.

===============================================================
# 1. BAT — ORBIT → DIVE (existing bat; build FIRST)
===============================================================
**Read:** bats stop being wobbly chasers. They circle your flank at range, then visibly fold wings and knife through you. Movement alone reads "harasser."
**Stats:** keep current bat HP 2, base speed 96, radius13, one-shot fragility. Movement="orbit".

## State machine
**ORBIT (attack.phase none):**
- Target nearest player as today. Desired radius `BAT_ORBIT_R = 145px` (≈3 tiles).
- If outside 190px: approach via `chaseAngle`/flow field.
- Within orbit band 110–190px and LOS: heading = tangent to player (`toTarget + orbitDir*PI/2`) blended 35% inward/outward to maintain radius. `orbitDir = moveSeed<0.5 ? -1 : +1` (stable per bat; half clockwise, half counterclockwise). Move at 1.05× base speed.
- Local separation: if another bat within 32px, add a small away vector so they form a readable ring rather than stack sprites.
- Trigger dive when cooldown=0, spawnTimer=0, LOS, distance 90–180px.

**DIVE WINDUP 0.45s; lock at 0.25s:**
- Stop lateral motion; hover BACK 8px (visual/client), wings/fuselage compress; a thin silver aim-line points to player. Aim tracks until 0.25 then locks. SFX wing snap.
- WALK dodge window = last 0.20s plus flight travel.

**ACTIVE 0.38s @ 360px/s (~137px):**
- `moveEnemyBy` along lockedAngle (ground collision applies — a wall interrupts into recover, no clipping). Contact damage 1; on first contact enter recover immediately so it cannot multi-hit during player i-frames.

**RECOVER 0.35s:**
- Stalls/overshoots, stationary and vulnerable. Then cooldown 1.8s + orbit.

## Fairness / anti-stuck
Walls interrupt dives. Orbit falls back to flow approach without LOS. `applyChaseStep` handles orbit obstruction/props. Bat is 1 pistol shot, so the telegraph can be brisk.
## Art/VFX
NO new base sprite required. Add dive frames/pose if available: folded sharp wings vs open flapping orbit. VFX: thin silver aim line, 2–3 grey trail streaks during dive, small dust/spark on wall impact. Existing bat sprite + trail masks suffice for v1.

===============================================================
# 2. SLIME — PACK ENCIRCLEMENT → SURGE (existing slime; build SECOND)
===============================================================
**Read:** slimes act like a coordinated soft pack: fan out into ring slots instead of forming a conga line, then staggered hops collapse inward. Movement reads "swarm" before any attack animation.
**Stats:** keep current slime HP3/speed42. Movement="pack".

## Movement (phase none)
- Assign stable ring slot from moveSeed: angle offset `slot = moveSeed*TAU`; desired target point = player + unit(slot + slow orbitClock*0.25)*`PACK_RING_R=72px`.
- Move toward the SLOT point using direct LOS; otherwise use existing flow `chaseAngle` until in the player's room. Add separation from same-kind slimes within 34px.
- This naturally surrounds rather than stacks. Do NOT globally synchronize the orbit; moveSeed gives stable spacing.

## SURGE trigger / state
Only when `nearbyCount("slime", target, 115px) >= 3`, own cooldown=0, spawnTimer=0, and distance 60–105px.
- **WINDUP 0.55s; lock 0.32s:** slime squashes FLAT and pulls backward, tint pulse; a short wet skid-shadow / stretched amber smear aligns to the locked hop (material evidence, not UI geometry). Each slime's deterministic cooldown starts offset (`2.2 + moveSeed*0.8s`) so the pack surges in a WAVE, never all on one frame.
- **ACTIVE 0.30s @ 210px/s (~63px):** fast inward hop along locked angle, touchDamage1. Use `moveEnemyBy` (no wall clip). Contact/blocked → recover.
- **RECOVER 0.40s:** splats flat, stationary punish window; cooldown 2.2–3.0s.
If fewer than 3 nearby, slimes only encircle/chase — solo stragglers stay simple tutorial fodder.

## Fairness / anti-stuck
Staggered deterministic cooldowns prevent unavoidable simultaneous dogpiles. Aim locks partway. Ring radius leaves player space to escape. Flow field handles room entry; existing anti-stuck on slot movement. Add a hard fallback: if a slime makes <20px progress toward its ring slot over 1s, abandon slot for 0.75s and use normal chaseAngle.
## Art/VFX
No new sprite. Existing squash/stretch is ideal: exaggerated flat windup, long forward stretch active, pancake recovery. VFX only: a wet skid-shadow / stretched amber smear aligned to the hop + 1 puff on takeoff/landing; no geometric arrow.

===============================================================
# 3. RATTLEBACK — BURROW → TRACK → ERUPT (build THIRD)
===============================================================
**Read:** Rattleback presses its floor-jaw down, disappears, a moving chevron of three lifted shale chips and a narrow seam track it, then an asymmetric rupture scar locks before it erupts. Ambush/area-denial unlike every current mob.
**Biome:** Sunless Caves (rare intro, 1 max/room) → The Deep (2 max). Never Amberwild/tutorial.
**Stats:** baseHP5 (+0.7/floor), surface speed55, radius16, drawSize46, touch1, kbResist1.3. Movement="burrow".

## State machine
**SURFACE (none):** normal flow-field chase at speed55. Trigger if target distance 120–300px, LOS not required, cooldown=0, spawn grace done.

**BURROW WINDUP 0.50s:** stationary; squash down/fade, jagged split-stone scar under the jaw; three back plates collapse downward in sequence. Cannot damage player. Still targetable until it fully submerges (reward interrupt/kill).

**ACTIVE SUBMERGED 0.90s:** set SUBMERGED flag. Invisible body; render ONLY the authored moving chevron of three lifted shale chips plus a narrow disturbed seam (never a ripple/ring). Collision/damage rules while submerged: cannot be hit by bullets/melee, cannot contact player, ignores walls/props via `moveEnemyFree`, but clamps bounds.
- Tracks current target for first 0.50s at 170px/s.
- At t=0.50 locks `markX/Y` to target's position; for final 0.40s moves toward mark and displays an asymmetric rupture seam there; three tooth-shaped stones lift along one side to communicate the radius (no more tracking → walk off it).
- At t=0.90: erupt at current/mark point, radial hit radius55, damage1 + knockback. Emit dirt/gib burst.

**RECOVER 0.60s:** fully visible, stunned, stationary punish window. cooldown 3.0s.

## Fairness / anti-stuck
The ripple NEVER disappears; ground marker visible ≥0.4s. No tracking after lock. Eruption dodgeable by walking (player covers 80px in 0.4s > r55). Submerged timeout guarantees return even if path weird; `moveEnemyFree` avoids wedge. Never spawn more than 2 in active interest region; stagger with moveSeed.
## Art/VFX
One new sprite (low angular mole/beetle form). Use a simple low-wedge silhouette placeholder until final art; do not substitute a generic circle. VFX/art required: authored moving chevron of lifted shale chips, asymmetric rupture-seam mask with three raised stone teeth, soil/rock gibs. 3 visual poses: surface crawl, sink, erupt. Movement sells it more than detail.

===============================================================
# 4. CROOKLEG — SEEK WALL → CLING → LEAP (build FOURTH)
===============================================================
**Read:** Crookleg retreats SIDEWAYS to a wall, visibly refolds/clings, converging claw-scores plus its displaced body-shadow reveal the landing, then it snaps across the room. Vertical-feeling movement in a top-down game.
**Biome:** The Deep first; Emberreach variant later. Max 1–2/room.
**Stats:** baseHP7 (+0.9/floor), ground speed70, radius15, drawSize48, touch1, kbResist1.2. Movement="wallPounce".

## State machine
**SEEK/CHASE (none):**
- If target distance <110px, retreat via reverse target angle using `applyChaseStep`.
- If 110–300px and cooldown=0, scan nearest wall point within 3 tiles (`nearestWallPoint`). Store in moveTargetX/Y and path toward it (use flow field for coarse route, direct final approach).
- Otherwise ordinary flow chase.

**CLING WINDUP 0.65s; landing lock 0.35s:** once within radius+8 of wall, stop, rotate/press into wall; body compresses. Three long CLAW-SCORES converge at player position and an offset body-shadow hangs between them; the marker tracks until 0.35, then locks for final 0.30. Telegraph includes 2–3 displaced after-silhouettes of Crookleg’s actual folded body along the future route (client render only); no generic trajectory arc.

**ACTIVE AIRBORNE 0.45s:** set AIRBORNE. Move along a quadratic arc in world-space from wall start to mark using `moveEnemyFree`; cannot touch-damage mid-air and cannot be hit by ground melee (bullets CAN hit it — skill shot). At landing: AoE radius48 damage1 + small knockback.

**RECOVER 0.55s:** sprawled/stunned at landing, stationary punish. cooldown 2.8s.

## Fairness / collision / anti-stuck
Landing locks ≥0.30s; player walks 60px, clears r48. Wall scan is local/deterministic. If no wall found within 3 tiles, fall back to chase for 1s. If wall approach stuck, existing `applyChaseStep` escape handles it; timeout seek after 1.2s and choose another wall. AIRBORNE ignores geometry but clamps to floor tiles; if mark is invalid/wall, snap it to nearest walkable tile before launch (spiral scan radius2).
## Art/VFX
New angular crawler sprite with long legs or compressed spring-body. Needs wall-cling pose and airborne stretched pose; shadow separates from body during leap (existing drop-shadow can scale/offset). VFX: 2–3 crooked-body after-silhouettes, converging claw-score landing mask + offset body shadow, small debris puff.

===============================================================
# ROSTER / REGION PLACEMENT + COMPOSITION RULES
===============================================================
- Amberwild F1–5: Pack Slimes + Orbit-Dive Bats.
- Rootbound F6–10: Knellbat (Wave2) leader packs + root-shell Shielder/formations.
- Sunless F11–15: Rattleback + authored Charger; Knellbat recurs as elite leader.
- The Deep F16–20: Crookleg + Seamwalker; Rattleback recurs sparingly.
- Gilded Archive F21–25: SHIELD/ANCHOR expressions, no new movement engine.
- Emberreach F26–30: Bellows ANCHOR + Cinderjack jet-HUNT; reuse modules.

Composition budget per room (coherence/fairness): max **2 complex movement archetypes** at once, plus simple chasers. Never combine >1 Rattleback + >1 Crookleg in a small room. Complex movement threat weights count double in spawn budget. This keeps variety readable rather than chaotic.

===============================================================
# WAVE 2 (creative pipeline — after Wave 1 proves modules)
===============================================================
The remaining CD seeds slot cleanly into the grammar without displacing the cheaper Wave-1 rollout:
===============================================================
# WAVE 2 FIRST — KNELLBAT: SMART BAIT → RALLY → PACK COMMIT
===============================================================
**First locked SMART archetype.** A Sunless-Caves bat variant with oversized ears. It does not become clairvoyant: it reacts only to own HP, nearby allies, player distance/LOS, and recent damage. The decision is readable: alone/wounded it flees while clicking; with support it turns and rallies flanking bats.
**Stats:** baseHP4 (+0.5/floor), speed104, radius14, touch1, kbResist0.8. Movement=`fleeBait`; max1 leader per pack/room. Biome Sunless floor3+; never tutorial floor1–2.

## Pack roles (recomputed every 0.5s, deterministic)
Pack = bats/Knellbats within 240px sharing the room/region. Stable role assignment:
- **Leader:** living Knellbat with lowest stable entity id. Only leader can Rally.
- **Bait:** lowest-HP fraction non-leader bat; if none, leader baits.
- **Flankers:** remaining bats; use existing Orbit→Dive with alternating orbitDir by id.
If leader dies: all pack bats emit one sharp broken-click, **panic outward for 0.65s**, and cannot start dives/rally for **1.20s**. Then the next Knellbat id becomes leader. Counter is explicit: kill the leader to break the formation.

## Context thresholds / state machine
**BAIT/FLEE trigger:** own HP≤40% OR fewer than2 living allies within160px, while player within240px. Tell 0.35s: ears flare/tilt toward allies, three clicks rise in pitch, body turns sideways. Then FLEE for max1.25s @135px/s:
- If ≥1 ally within320px: move toward centroid of nearest two allies, but offset 70px past them away from player (pulls pursuit into support, not directly through bodies).
- If none: flee directly away from last-seen player using `applyChaseStep`/avoidance; no teleport.
- Counter: do NOT chase into the pack; hold position/range and shoot the fragile bait. If blocked/no progress0.35s, perpendicular nudge via existing anti-stuck; after1.25s it stops fleeing regardless.

**RALLY trigger (leader only):** at least2 allies within130px, player distance100–240px, LOS, cooldown0, spawn grace done. WINDUP0.60s; aim locks0.32s. Tell: leader plants, oversized ears pulse once, a visible sound-wave chevron points toward the locked player position (material/audio tell, not a clean ring). During windup flankers maintain orbit but cannot dive.
**PACK COMMIT:** on release, assign flankers deterministic stagger `0.0/0.18/0.36s`; each performs the shipped Bat Dive from opposite orbit sides. Leader dives last at0.45s or remains at range if HP≤40%. No more than3 dives per rally. RECOVER leader0.55s; rally cooldown3.2s.

## Fairness / no cheating
Leader locks current position at0.32s and never reads subsequent movement input. Stagger prevents simultaneous unavoidable contact. The player has three counters: kill leader→break, refuse bait pursuit, or dodge the visually ordered dives. Pack decisions update only twice/sec and minimum state durations prevent twitchy perfect reactions.
## Art/VFX
Use Bat body initially with oversized ear silhouette/tint variant. Essential read: ears point toward support while fleeing; leader ear flare + authored sound chevron on rally; broken-click/panic wing flare on leader death. No invisible buff aura.


- **Seamwalker (Deep, ORBIT):** lays 3–4 visible fracture segments and moves only along them; pauses at junctions before switching. Reuses orbit but adds path-preview geometry. Strong biome thesis, moderate hook.
- **Rootkite (Amberwild, FLOCK):** 3 leaf-backed blobs share formation; shooting one breaks formation, survivors panic outward then re-form. Uses the FLOCK/separation module but requires group identity + formation state.
- **Bellows / Cinderjack (Emberreach):** ANCHOR thermal lane / jet HUNT; ship once hazards/projectile push exist.

Why Wave 1 remains first: Bat+Slime prove ORBIT/FLOCK with existing art; Knellbat adds contextual pack roles after the shared nearby-count helper; Rattleback adds free-motion/material destination tells; Crookleg reuses that foundation. Wave 2 then expresses the remaining biome grammars through more bespoke path-preview/formation/hazard hooks.

===============================================================
# CODE / STEPWORLD INTEGRATION
===============================================================
- Dispatch in `updateEnemyAI` by movement/archetype handler (current kind switch can migrate to `arch.movement` handlers in Stage-A; data-driven and avoids a growing kind switch).
- All new state lives in Enemy plain data + AttackState; no anim clocks drive decisions. `moveSeed` comes from seeded Rng. Sim emits semantic events (diveStart, surge, rallyBreak, rattleTrack/erupt, pounce/land); client owns art/VFX/telegraphs under the Stage-A event model.
- Chill/freeze still applies at `moveEnemyBy`. For `moveEnemyFree`, explicitly apply chill scale before free motion; frozen enemies cannot continue active motion (pause active timer or immediately recover — recommendation: pause active timer, keeping status universally meaningful).
- Knockback: normal/windup/recover uses existing impulse. SUBMERGED ignores knockback; AIRBORNE accepts bullet damage but knockback applies only on landing (bank impulse or ignore until recover) to avoid arc corruption.
- Server-ready: deterministic state/timers, no Math.random, no camera/render checks, fixed-dt. Golden-master scenario added per archetype.

===============================================================
# BUILD ORDER + ACCEPTANCE
===============================================================
1. **Bat Orbit→Dive** — existing art, reuses lunge/flow.
2. **Slime Pack Encircle→Surge** — existing art, adds nearby-count/separation.
3. **Rattleback** — adds `moveEnemyFree` + SUBMERGED + material destination lock.
4. **Crookleg** — reuses free-motion state, adds wall scan + airborne arc.
**Wave 2 begins with Knellbat Smart Pack** — contextual roles/flee/rally/leader-break after core modules/readability are proven.

Acceptance per archetype:
- Readable with simple silhouette placeholders: a blind playtester can name "orbit-dive / surround-surge / bait-rally / underground-erupt / wall-leap" from movement alone.
- Every committed attack dodgeable by walking, has ≥0.30s post-lock window, and ≥0.35s recover.
- Smart-AI audit: Knellbat decisions derive only from HP/ally count/distance/LOS/recent damage; recorded input changes with identical world state do not alter its choice until the player position itself changes. Leader death always creates the 1.2s break window.
- No enemy stuck >1s against walls/props in 100 seeded rooms.
- Deterministic replay: same seed+inputs → same positions/phases tick-for-tick in stepWorld golden tests.
- 50-enemy stress: new nearby/separation scans keep server tick well under budget (if not, replace O(n²) nearbyCount with the Stage-E spatial grid; API unchanged).

## Bottom line
Wave 1 deliberately changes where danger comes from, not just speed or damage: bats FLANK, slimes SURROUND, Rattlebacks AMBUSH FROM BELOW, and Crooklegs LEAP FROM WALLS; Wave 2 adds Knellbats that BAIT THEN RALLY. Two existing enemies become new fights before new art arrives; two new mobs reuse the same AttackState/flow/movement helpers. Five high-contrast reads, a few small shared helpers, zero new combat architecture.
