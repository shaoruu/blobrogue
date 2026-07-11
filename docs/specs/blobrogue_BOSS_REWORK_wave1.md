# WAVE 1 DEEP BOSS REWORK — JET / TITHE / QUORUM
Root cause of Ian's "weak / uncreative / easy to dodge / spammable": body takes direct damage (mechanic optional) + attacks are single point-projectiles a reflexive dash/strafe beats.

## TWO-PART FIX
### A. GUARD GATE (stops spam) — body near-zero damage by default; damage ONLY in a player-created EXPOSED window; the mechanic is the ONLY damage path.
- JET & QUORUM body ≤10-15% by default; TITHE = ZERO while armored/feeding.
- Balancer owns: guard %, EXPOSED window duration, per-window damage BANK cap (anti-burst so no burst skips a phase), slab/husk HPs, party-scaling (surplus DPS → more mechanic not just HP).

### B. MOVESETS (fixes boring/dodgeable) — designed AGAINST the dodge kit: dash=620spd ~112px/2.3tiles, 0.18s iframes, 0.70s cd; walk 200; tile 48px.
Fix principles: (1) attacks COVER SPACE (cones/rings/converging lines/sweeping arcs) so you can't strafe; (2) MULTI-STAGE + FEINTS so one dodge isn't enough; (3) DASH-PUNISH (delayed detonation timed to iframe-end, follow-up in dash destination); (4) AREA DENIAL shrinks safe space. Fairness: telegraph 0.6-1.0s, aim locks partway (juke window), recover 0.5-0.9s = punish window. Goal = "dodge the RIGHT way", never undodgeable.

## JET (F35) — attacks = YOUR arsenal weaponized
- A1 MIRROR SALVO (signature): copies a resonance family's shot pattern (cone/spray/lance/orbs), 0.7s ghost-outline telegraph shows where it lands; covers space like that weapon, dodge to authored dead-zone.
- A2 TRACER BURST (dash-punish): 3 homing motes lock then SNAP to your lock-position after 1.0s; must dash LATE after the snap tell.
- A3 RECOIL LINE (space-cover): dashes leaving amber wall trails that bisect arena 3s, then perpendicular = a cross; reposition through gap.
- A4 (P2) OVERCLOCK FEINT: big beam 0.8s tell, 30% feints into instant burst on the beam's safe side; don't commit dash until beam fires.
- Phases: P1 A1+A2; P2 +A3+A4, salvo fires TWO patterns back-to-back; P3 CORRUPTION (33%): mirrors squad's BIGGEST attack as screen beam, dodge-through to counter.

## THE TITHE (F40) — attacks around feeding/slab
- A1 GORGE SLAM (space-cover): rears 0.9s, slams → 360° ring shockwave + debris; dash THROUGH ring on iframes or stand in debris-shadow gap.
- A2 TETHER FEED (area denial): feeding-tethers make 2-3 zones damaging over 1.5s; why you break the slab (break snaps tethers).
- A3 SPEW ARC (multi-stage): amber globs arc into pools, THEN 2nd wave fills wave-1's gaps; read both.
- A4 (P2) SLAB HURL: throws own slab as line projectile 0.8s, leaves side unarmored → creates window.
- Phases: P1 A1+A2; P2 +A3+A4, GORGE double-pulses. SIGNATURE (low HP): rips ALL slabs, rotating barrage wheel, then collapses exposed long window.

## QUORUM (F45) — attacks use 3-husk/link/merge geometry
- A1 CROSSFIRE LINES (space-cover, 3 bodies): three beams sweep toward each other closing safe space; pick a pocket or dash a beam.
- A2 TETHER SNAP (uses link): shield-tether whips across in an arc = moving wall; dash under/over on iframes.
- A3 ROLE VOLLEY (combo): damage=aimed 3-burst, heal=knockback heal-pulse, shield=drops barrier blocking your shots; read 3 tells in sequence.
- A4 (P2, shield dead) HUNT PAIR: 2 survivors split + pincer (herd wall → charge lane); break pincer geometry.
- Phases: P1 A1+A3; moveset changes as husks die (A2 gone once a husk dies, A4 at 2 husks). SIGNATURE THE MERGE (low pool): fuse into fast amalgam (1.2s non-invuln tell), CROSSFIRE→TETHER-SNAP combo in one body, widened ≥.45s recover.

## THREE LEVERS every boss: GUARD (kills spam) + big TELEGRAPH (legible = fixes "uncreative") + one SIGNATURE MOMENT (memorable).
Reference: docs/specs/BOSS_EARNED_WINDOWS_AND_SCALING.md (Weaver = working standard). Balancer numbers + AD scale/presence pending.

## BALANCER EXACT CONSTANTS (src/sim/balance.ts) — traced: bosses ride R framework (bossHpFracFor), NOT coopBossHpMult. Do NOT change bossHpPerExtra or soloGearCap.
- FIX1 focus-fire premium: POWER.focusFire NEW = 0.08; in powerRatioFor multiply partyDps *= (1 + focusFire × (P−1)) BEFORE the [1,6] clamp. (2p co-op focus-fires one target → real burst > paper sustained sum; lifts 2p R≈2.6→2.8.)
- FIX2 HP curve: POWER.hpPerR 0.45→0.55; POWER.hpFracCap 2.9→3.1. (2p good-gun TTK 0.86→0.92, solo UNCHANGED via soloGearCap 1.15.)
- FIX3 anti-skip (the big one): windowBankFrac 0.40→0.22 (JET/TITHE/QUORUM + marrow/weaver/gilded/choir for consistency) → crossing a phase needs ≥2 earned windows, can't one-burst. guardMult → 0.20 all (was 0.30-0.35) → chip-through guard ~5× slower than mechanic, still not immunity. Confirm/wire EXPOSE_WINDOW_CAP clamps applied dmg per window to windowBankFrac×maxHp (discard overflow, true anti-one-shot).
- 4p: R=6 clamp means HP can't carry 4p BY DESIGN — surplus routes to MECHANICS via bossAddCapFor/bossAddIntervalFor/phaseTimerFor (soft-enrage). MUST confirm JET/TITHE/QUORUM actually call these off encounterPower; if not wired, that's why 4p feels weak (fight-design task).
- SHIP GATES: (1) 2p good-gun TTK vs solo in [0.80,0.95], 2p median ≥0.72, solo ±3%; (2) no phase crossed in <2 windows any legal 2p/4p burst; (3) guarded chip-kill of a phase ≥3× playing the window; (4) no single event >windowBankFrac×maxHp; (5) solo high-roll ≥ boss floor min; (6) determinism P1-4 + reconnect + replay.

## BALANCER FINAL (supersedes ranges above — use EXACTLY):
guardMult JET 0.32→0.12, QUORUM 0.30→0.12, TITHE 0.30→0.0 (true hard gate). windowBankFrac 0.40→0.22 (JET/TITHE/QUORUM). OVERFLOW-DISCARD CLAMP (separate from EXPOSE_WINDOW_CAP=8 stacked-break count): single event exceeding remaining bank applies only up to bank, DISCARD overflow. TITHE.slabBaseHp 46→84, slabThickFor [0,1.0,1.6,2.0,2.4], slabsFor [0,1,1,2,2], rearmChannel 3.0. QUORUM.huskIntegrityFrac 0.20→0.10, healRegenPerSec 10→14. POWER.focusFire 0.08 (×partyDps in powerRatioFor pre-clamp), hpPerR 0.45→0.55, hpFracCap 2.9→3.1. refDpsForFloor F35/40/45=46. Exposed durations UNCHANGED (bank is the lever). NOT bossHpPerExtra/soloGearCap. If 2p phase still one-windows → windowBankFrac 0.20.

## QUORUM HUSK-STACK BUG FIX (Ian: "snuggle into one stacked boss, looks odd"): updateQuorumHusk (world.ts ~L7726) — husks free-chase player + only leash past huskRingDist*2 → collapse into one blob (breaks kill-order readability). FIX: each husk holds an assigned FORMATION SLOT (angle = base + i*2π/3 at huskRingDist 120 from core centroid, slot slowly rotates for orbit), steers to its slot not free-chase; stay a readable spread triangle, tether taut, never overlap.

## ART/PRESENCE (AD): scale JET 76→96, Tithe 96→104(+slab), Quorum core 100→112/husks 80→86. Presence = boss aura ground-ring (family hue, beneath body, doubles as guard/expose tell) + dramatized asymmetric silhouettes (regen gpt-image-2) + phase-visual escalation. Quorum art = 3 DISTINCT gaunt husks + always-visible taut tether.
