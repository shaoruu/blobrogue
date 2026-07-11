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

## BALANCER SURPLUS CURVES (4p fix — wire encounterPower into updateJet/Tithe/Quorum like Weaver/Marrow):
PHASE_TIME_BASE (add — currently none, soft-enrage can't fire): JET 16, TITHE 16, QUORUM 14.
- JET: salvo interval −0.15/(R−1) floor 1.8s (more windows); simulVerbs +1 at R≥3.5 P2/P3 but simulCapFor renders 1 at 4p (faster seq, same read); soft-enrage +1 inverted salvo next phase.
- TITHE: NEW feed-add path chasers cap solo0/2p3/4p4 (active-threat cap); slabsFor stays [_,1,1,2,2]; rearmChannel FLAT 3.0 (task scales via slab HP/thick+adds not timer); soft-enrage +1 slab next feed.
- QUORUM: husk-adds wave on husk break cap solo1/2p4/4p5, interval 6.0→3.0 floor w/R; merge-form continuous final window regardless R.
POWER scalers unchanged (addCapPerR 1.6 max8, addIntervalPerR 0.9 min3.0, burnFrac 0.55). Order: anti-burst constants stop spam NOW; surplus wiring makes 4p harder-not-spongier. GD owns WHAT adds are (in spec), balancer owns count/cadence.

## BALANCER SURPLUS — FINAL EXACT (supersedes curves above; solo/2p(R2.8)/3p(R4.2)/4p(R6)):
Shared: addCapPerR 1.6/max8, phaseTimerPerR 0.10, burnFrac 0.55.
JET (PHASE_TIME_BASE=16): salvo-pattern count bossAddCapFor(base0) cap2 = 0/2/2/2. ⚠ NEW salvoIntervalPerR=0.12 floor1.8 (NOT generic 0.9): P1 3.0→3.0/2.78/2.62/2.40, P2 2.6→2.6/2.38/2.22/2.00, P3 2.2→2.2/1.98/1.82/1.80. enrage phaseTimerFor(16)=16/18.9/21.1/24, burn<0.55×T→+1 inverted salvo.
TITHE (PHASE_TIME_BASE=16): feed-add chasers bossAddCapFor(base0) cap4 = 0/3/4/4. ⚠ re-arm interval FLAT 3.0 ALL R (perR 0, NEVER shorter timer). slabsFor [_,1,1,2,2], soft-enrage +1 slab next feed. phaseTimerFor(16).
QUORUM (PHASE_TIME_BASE=14): husk-adds-wave bossAddCapFor(base1) cap5 = 1/4/5/5. wave interval bossAddIntervalFor(base6.0) floor3.0 (generic 0.9 ok) = 6.0/4.38/3.12/3.0. phaseTimerFor(14). merge final window UNGATED by R (no adds).
READABILITY: surplus = simple chasers on telegraph (active-threat cap only, not ≤2-complex rule); enrage = PATTERN not dmg/HP; ≥0.30s post-lock dodgeable. VERIFY: Jet salvoIntervalPerR 0.12; Tithe re-arm no R scale; 4p add-count hits targets AND HP frac ≤3.1.

## SURPLUS CONTENT (what the 4p surplus spawns — GD, pairs w/ balancer counts):
- JET: NO new entity — just more salvos (1.8s floor) = more parry windows. Soft-enrage: next phase +1 MIRROR-FLIPPED salvo (opposite safe-pocket, forces re-read). Uses existing mirror pool, zero new art.
- TITHE: NEW add TRIBUTE — slow amber-glob crawler (cap 0/3/4) shuffles to the feeding slab + reinforces it if it reaches (heals/thickens). Threatens slab-break PROGRESS not player (4p divide-labor). 0.6-0.8s tell. SUPPRESS while GORGE ring active.
- QUORUM: NEW add SPLINTERS — role-echo shards break off a husk ON DEATH (cap 1/4/5), weak version of parent role (shield-bubble/heal-trickle/slow-pip). Nuking shield husk → splinter wave before pool window (kill-order lesson at small scale). ~1s spawn-grace (not mid tether-snap). Simple chasers at dying husk.
Implement tribute + splinter as new simple-chaser enemy kinds (deterministic, active-threat cap only, NOT ≤2-complex-mover rule).

## REWORK = 4 pieces + presence, ALL injected to build bc-1fe0ba23: (1) movesets (2) balancer constants (3) overflow-discard clamp @damageEnemy (4) encounterPower wiring + tribute/splinter surplus. + Quorum husk-formation fix + AD presence/aura/scale.

## BALANCER DELTAS (final corrections, supersede above):
- TITHE.slabThickFor [0,1.0,1.6,2.0,2.4] → [0,1.0,1.8,2.0,1.9] (2.4 overshot 4p slab-TTK w/ repair-adds; holds 1.6-2.0s P1-4). slabBaseHp 84, rearmChannel FLAT 3.0.
- NEW Tithe TRIBUTE slab-repair = 6 HP/s each (unintercepted tribute repairs slab; the 4p divide-labor job).
- NEW JET tracer-mote count = round((R-1)/1.5) cap 3 = solo0/2p1/3p2/4p3 (off encounterPower R).
Everything else stands: JET salvo cap2 salvoIntervalPerR 0.12 floor1.8; TITHE feed-add cap4 re-arm FLAT 3.0; QUORUM husk-adds cap5 interval 6→3; PHASE_TIME_BASE JET16/TITHE16/QUORUM14 (NEW, required for soft-enrage). Overflow-discard = CONFIRMED BUG (damageEnemy ~L2249-2258, earned-window branch only, leave roar.queued).

## ITEM 5 — TWO EXPLICIT SCHEDULER SUPPRESSIONS (NOT covered by generic overlap arbiter, need explicit code):
1. TITHE ring suppression: while GORGE SLAM ring telegraphing/active → tributeActiveCap = min(surplusCap, 2); restore to full 4 after ring clears, re-activation staggered REINFORCE_STAGGER (0/.18/.36s). Arbiter never gates tribute vs ring (tribute = slab-REPAIR actor not damage release) → add explicitly in Tithe update path.
2. QUORUM splinter grace: 1.0s spawn-grace — splinters spawn+telegraph immediately but first action (bubble/trickle/pip) gated until 1.0s passed AND no major release (tether-snap/crossfire) mid-flight. Arbiter covers instant pip-vs-sweep but NOT the 1.0s hold → add explicitly.

## FINAL: rework = 5 items (movesets / balancer constants / overflow clamp / encounterPower wiring+surplus / 2 suppressions) + Quorum formation fix + AD presence. This doc is THE single source of truth. All injected to build bc-1fe0ba23.
