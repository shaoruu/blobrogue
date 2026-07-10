# Boss earned-window rework + party/gear-aware scaling (APPROVED SPEC)
Source: game designer (t890) + balancer (t891), approved by Ian 2026-07-09.

## Core principle
Surprise = unpredictable in WHICH/WHERE/WHEN, NEVER unpredictable in whether you got a fair tell.
Randomize composition; always telegraph the individual hit. The boss controls WHEN damage
counts (earned EXPOSED windows), keeps players reading by varying WHAT/WHERE within always-fair tells.

## Weaver (F20) rework — reference implementation
Identity: she builds the arena, you fight the arena she built. Standing-and-hosing is punished.
- Arena baseline GUARDED (~30% dmg taken, never full immunity >1.2s). HP calibrated on EXPOSED time (median 20-30s exposed), not uptime.
- P1 (100-66%) SHE CARVES THE ROOM: web lines partition arena into lanes + sticky silk zones (move x0.5). Blink-strikes along her lines. EARNED WINDOW: shoot glowing ANCHOR KNOT where lines cross; breaking one collapses that lane AND snags her if traveling it -> EXPOSED 3s. Knot never on your current tile (movement IS the mechanic). Co-op: more players -> more anchors/lanes; coordinated multi-anchor breaks stack exposure.
- P2 (66-33%) SHE VANISHES CLEAR THE NEST: Weaver UNTARGETABLE (anti-out-DPS core). Drops spiderling flock adds + aimed silk (telegraphed ground markers). EGG-SACS on walls (2 solo / +1 per extra player); destroy all -> she drops exhausted EXPOSED 4s. Task, not DPS race.
- P3 (33-0%) SHE HUNTS HER OWN WEB: fast, wall-crawls perimeter then charge-dashes across P1 lanes (reuses lines as rails). Telegraph: perches, target lane's web flares .5s before she rockets. EARNED WINDOW: bait charge into a broken/empty lane -> overshoots into wall -> stagger EXPOSED 3.5s.

## "Keep them guessing" template (all bosses)
1. Unpredictable add composition from a curated per-boss pool (weighted, non-repeating); every member a known readable creature. Obey complex-mover cap + overlap scheduler.
2. Ambush spawns get 0.6-0.8s pre-spawn tell at location BEFORE they can damage + spawn-grace. Never on a player / behind camera. Spawns land >=140px from every player.
3. Phase shifts reshape the room (add/remove lanes/zones/cover) on a 1.2s non-invuln transition. Always >=1 readable safe route.
4. Earned-window gating: Guarded <=35% default; damage counts during player-created EXPOSED windows; per-window damage cap prevents phase-skip.

## Party+gear-aware scaling (hold TTK ~constant; surplus buys mechanics not HP)
- Measure at pull (deterministic, server-authoritative, no live rescale): per player ExpectedDPS = weapon base DPS x blessing mults x .72 practical factor. PartyDPS = sum. R = PartyDPS/refDPS clamped [1.0,6.0]. refDPS: F5 20.7, F15 36, F20 36, F25 43, F30 46.
- Eff HP sublinear+capped: bossHP = round10(baseSoloHP x HPfrac), HPfrac = 1 + 0.62*(R-1), clamp <=2.9. Weaver base 1500.
- Surplus (R-1) -> mechanics: add cap = round(2+1.6*(R-1)) clamp 8; spawn interval = max(3.0, 7.0-0.9*(R-1)); phase timer soft-enrage (burn phase <0.55xTphase -> next transition adds one authored PATTERN, never HP/damage); pattern density in disjoint lanes only, overlap arbiter never relaxed.
- Guardrails: HPfrac hard clamp 2.9x; if 4-stack TTK <22s after clamp add mechanics not HP; solo gear capped R1.15; weakest player guaranteed baseline; snapshot at pull (downed/dc doesn't move R); forced transition <=1.2s no immunity; deterministic given seed+inputs.

## Priority order for rework
1. Weaver F20 (reported failure) 2. Gilded Warden F25 3. Hollow Choir F30 4. Marrow F15 (light) 5. Slime King F5 (teach only, gentle) 6. F10 Gauntlet (keep as DPS contrast; only pull add composition from pool).
