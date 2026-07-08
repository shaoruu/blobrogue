# blobrogue — Final Balance Implementation Spec

**Audience:** the build agent that implements balance the moment Stage C (authoritative server) merges.  
**Type:** numbers + formulas only, no code.  
**Companion:** `docs/specs/blobrogue_BALANCE_RESET_spec.md` (rationale, diagnosis, source line refs). This document is the exact-value tightening of that reset.  
**Non-negotiable design rule:** difficulty comes from techniques, telegraphed commitments, room composition, movement and scarcity. HP is a calibration output, never the difficulty lever. Every value below is authoritative simulation data placed in one versioned `BalanceDef`, integer/fixed-point where noted, consumed identically by LocalTransport (solo) and the server.

---

## 1. Player constants (final)

| Constant | Value |
|---|---:|
| Base/max HP | 6 |
| Post-hit invulnerability | 0.80s |
| Dash cooldown (base) | 0.70s |
| Dash active duration | 0.16s |
| Dash iframe | 0.18s, non-refreshing, non-overlapping |
| Second Wind dash CD by level | ×0.65 / ×0.55 / ×0.50 (lookup from base, never multiplied copy-over-copy) → 0.455 / 0.385 / 0.350s |

Dash iframe at Second Wind Lv3: 0.18 / 0.35 = 51.4% theoretical uptime; covers the 0.16s active dash + 0.02s tail. Post-hit 0.80s is a separate protection and must not extend dash protection.

---

## 2. Sustain / heart economy (final — ambient healing roughly halved)

| Source | Old | Final |
|---|---:|---:|
| Normal-floor descent heal | +2 | 0 |
| Boss completion heal | chest heart + descent +2 | chest +1 only |
| Enemy heart drop | 12% | 6% |
| Crate heart (crate = 28% of props) | 15% | 6% |
| Wood chest heart | 20% | 15% |
| Loose heart at full HP | remains on floor | consumed, converts to 2 coins |
| Dealer heart (floors 3/6/9) | n/a in code | 6 coins, +1 HP, never full heal |
| Revive | 3 HP / 1.1s channel / 1.2s iframe | 2 HP / 1.5s channel (any damage cancels) / 1.0s iframe, no attack first 0.35s |

Ambient hearts must land at **0.55–0.90/floor** (excluding boss reward and Dealer). Recovery pity: after two consecutive non-boss floors that generated zero hearts while the player entered below 50% HP, force one heart into the next wood chest (deterministic counter, reset on generation).

### Sustain blessings (final Lv1/Lv2/Lv3 cumulative)

| Blessing | Lv1 | Lv2 | Lv3 | Notes |
|---|---:|---:|---:|---|
| Vampire Fang (kill-heal chance) | 8% | 13% | 17% | 1 heart/proc; shared 1.25s proc cooldown; excludes boss-spawned/summoned adds |
| Vitality (max HP) | +2 | +3 | +4 | heal exactly 1 current heart on each upgrade, not the full capacity delta |
| Second Wind (dash CD mult) | ×0.65 | ×0.55 | ×0.50 | level lookup, see §1 |

Fang expected pre-cooldown recovery on a 10-eligible-kill floor with 6% natural drops: 1.4 / 1.9 / 2.3 hearts. Fang-only ship-gate contribution ≤1.7 hearts/10 kills after cooldown/exclusions.

---

## 3. Regular enemy scaling (final exact tables)

Formula: `HP(f) = round(baseHP × HPmult(f))`, `speed(f) = round(baseSpeed × speedMult(f))`, applied to F1 archetype baselines (Slime 3/42, Bat 2/96, Skeleton 6/62, Ghost 4/56, Spitter 3/30). Damage never scales with floor.

HPmult / speedMult by floor: 1.00/1.00, 1.25/1.02, 1.50/1.04, 1.72/1.06, 1.94/1.07, 2.12/1.09, 2.30/1.11, 2.47/1.13, 2.60/1.14, 2.71/1.16.

### HP by floor

| Floor | Slime | Bat | Skeleton | Ghost | Spitter |
|---|---:|---:|---:|---:|---:|
| 1 | 3 | 2 | 6 | 4 | 3 |
| 2 | 4 | 2 | 8 | 5 | 4 |
| 3 | 4 | 3 | 9 | 6 | 4 |
| 4 | 5 | 3 | 10 | 7 | 5 |
| 5 | 6 | 4 | 12 | 8 | 6 |
| 6 | 6 | 4 | 13 | 8 | 6 |
| 7 | 7 | 5 | 14 | 9 | 7 |
| 8 | 7 | 5 | 15 | 10 | 7 |
| 9 | 8 | 5 | 16 | 10 | 8 |
| 10 | 8 | 5 | 16 | 11 | 8 |

### Speed by floor (px/s)

| Floor | Slime | Bat | Skeleton | Ghost | Spitter |
|---|---:|---:|---:|---:|---:|
| 1 | 42 | 96 | 62 | 56 | 30 |
| 2 | 43 | 98 | 63 | 57 | 31 |
| 3 | 44 | 100 | 64 | 58 | 31 |
| 4 | 45 | 102 | 66 | 59 | 32 |
| 5 | 45 | 103 | 66 | 60 | 32 |
| 6 | 46 | 105 | 68 | 61 | 33 |
| 7 | 47 | 107 | 69 | 62 | 33 |
| 8 | 47 | 108 | 70 | 63 | 34 |
| 9 | 48 | 109 | 71 | 64 | 34 |
| 10 | 49 | 111 | 72 | 65 | 35 |

**Authority note:** these HP values serve the TTK gates in §7. If measured late (F9–10) normal focused TTK exceeds 1.4s at the median legal build, cut the HP band before touching composition/pressure. HP never sponges.

Damage tiers (all floors): light/contact/projectile = 1; clearly telegraphed heavy = 2 (≥0.8s tell); only endgame elite signatures may reach 3. No floor multiplies ordinary damage.

---

## 4. Threat budget, density and variety tiers (difficulty ≠ HP)

Spawn by budget, not body count:

```
FloorThreat   = min(30, 6 + 2×(floor−1))
ActiveThreatCap = min(16, 8 + floor)
```

Distribute FloorThreat across 3–5 combat rooms; never exceed ActiveThreatCap simultaneously.

| Tier | HP mult | Speed | Radius/draw | Damage | Threat cost | First floor |
|---|---:|---:|---:|---:|---:|---:|
| Swarm/small | 0.55× | 1.15× | 0.78× | unchanged | 0.55 | 1 |
| Standard | 1.00× | 1.00× | 1.00× | unchanged | 1.0 | 1 |
| Brute | 2.40× | 0.82× | 1.30/1.35× | telegraphed heavy +1 (cap 2) | 2.2 | 4 |
| Elite | 1.70× | 1.12× | 1.08/1.12× | unchanged; one affix + 20% shorter CD | 2.8 | 6 |

Complex-movement archetype multiplies its tier cost ×2. Max 2 complex archetypes per room; never >1 Rattleback + >1 Crookleg in a small room; no brute+elite combo before floor 8. Preserve ≥0.30s post-lock dodge and ≥0.35s recovery on every commitment. Elite = one readable modifier (rally, shield arc, delayed hazard, split, reinforcement commander), never blanket doubled stats.

Biome pressure (bodies/hazard, not HP): Verdant 1.00× budget, +15% pack units; Sunless 0.95× bodies / 1.10× complex share; Deep 0.90× bodies / 1.15× hazard; Emberreach 1.05× budget / 1.15× reinforcement.

---

## 5. Slime King (final, floor 5)

**Initial HP: 900.** Recompute whenever the legal pool changes:
```
bossHP = max( round10(38 × medianPracticalDPS),
              ceil10((20 − forcedTransitionTime) × P95LegalSustainedDPS) )
```
With median 24 DPS, P95 51 DPS, forcedTransitionTime 2.4s → 900. TTK: median ≈37.5s; P95 high-roll ≈17.6s burn + 2.4s forced = 20.0s.

Phase thresholds evaluated immediately after every authoritative damage event (not only while idle): P1 100–70%, P2 70–35%, P3 35–0%. Contact damage 2 (was 3); slam center 2 / outer shockwave 1; globs 1.

| Phase | HP band | Attack cadence | Pattern | Adds |
|---|---|---:|---|---|
| Entrance | — | 1.2s grace | none | none |
| P1 | 100–70% | hop slam 3.2s | windup 0.65 / lock 0.32 / air 0.45 / recover 0.65 | 1 slime @4.5s, then every 6.5s, cap 5 |
| Transition @70% | floor 62% | 1.2s roar | 35% damage reduction (not immunity); clear bullets ≤70px; 2 slimes at opposite marked edges | overflow QUEUED, applied only after transition exits |
| P2 | 70–35% | 2.7s | alternate hop / 10-glob radial (windup 0.75 / recover 0.60, 36° gaps); every 2nd radial orders existing slimes into a delayed pack surge (no extra HP) | interval within cadence, cap 5 |
| Transition @35% | floor 27% | 1.2s roar | same 35% reduction | overflow QUEUED, applied only after transition exits |
| P3 | 35–0% | 2.25s | hop landing fires 4 cardinal globs; every 3rd attack is a 1.0s-telegraphed arena squeeze lasting 3.0s; chase +12% | 2 slimes every 7s, cap 7 |

No invuln/reduction beat exceeds 1.2s; total forced transition time = 2.4s. Log transition enter/exit and queued overflow so the ≥20s gate stays verifiable. Boss death ends danger and opens exit regardless of remaining adds.

### Future boss baseline
Three 25–40% HP technique chapters, 1.0–1.8s transitions, one signature arena rule, ≤2 simultaneous pattern families. Later-boss effective HP after expected player power ≤1.5× Slime King. Target 45–65s median solo.

---

## 6. Power budget (temporary ~4–6× expressive; permanent ~20–30%)

**Temporary (per-run blessings).** Raw caps enforced in authoritative sim after full build recompute from `itemLevels`:

| Axis | Cap |
|---|---:|
| Blessing damage mult | 2.25× |
| Fire rate mult | 1.80× |
| Move speed mult | 1.35× |
| Max HP bonus | +4 |
| Blessing-added pierce | +3 |
| Each elemental chance | 50% |

The 4–6× strong-run fantasy is *expressive capability* (pellets, pierce, ricochet, status, crit, Fracture, positioning, Resonance), never a product of raw flat stats. 95th percentile ≤6× outside Resonance; ~7× only in full Resonance windows.

Lv1–3 growth budget: Lv1 establishes the mechanic (~12–25% single-target power or strong utility); Lv2 adds 35–55% of Lv1's raw delta + consistency; Lv3 adds 20–40% of Lv1's raw delta + a qualitative payoff (do not simply triple Lv1). Value multitarget at 45% of paper secondary DPS, status/control at 35%, mobility at 50% for budgeting.

Duplicates: duplicate = explicit Lv2/Lv3 upgrade, recompute mods from levels (no irreversible incremental applies), remove at Lv3, weight a new eligible blessing 3× an upgrade. Cadence: 1-of-3 on every non-boss descent; boss chest replaces that floor's reward with a Rare/Boss pick; remove random wood-chest blessings. ~4 picks by F5, 8–9 by F10.

Canonical example levels: Hair Trigger +35/+55/+70%; Full Metal +1/+2/+3; statuses 25/40/50%; Coin Magnet 90/240 → 240/480 → 900/900; Fang 8/13/17%; Vitality +2/+3/+4; Second Wind ×0.65/0.55/0.50.

**Permanent (Foundation).** Strongest legal permanent loadout advantage 20–27%, hard ceiling <30%, equip max 3, gear is sidegrade/specialization with no stat treadmill. Validate identical-seed room-clear/survival advantage ≤30%.

---

## 7. Acceptance gates (ship = all pass)

1. Slime King median solo TTK 35–50s; legal high-roll 20–25s; **absolute observed minimum ≥20s** across all legal builds.
2. No boss transition invuln/reduction beat >1.2s; total forced downtime ≤2.4s; queued-overflow logging present.
3. Normal focused TTK 0.45–0.90s (F1–2) and 0.70–1.40s (F7–10); elite 3–6s; brute 1.8–3.2s at median legal build. These TTK gates override the §3 HP bands.
4. Ambient healing 0.55–0.90 hearts/floor median, P90 ≤1.6; Fang Lv3 ≤1.7 hearts/10 eligible kills.
5. Median skilled player ends a non-boss floor 1.5–2.5 HP below entry before recovery; <10% of floors erase ≥4 damage via free sustain.
6. Second Wind Lv3 dash iframe uptime 50–52% under deterministic continuous-optimal-dash test; no overlap/refresh; post-hit 0.80s tested separately.
7. F5 entry median 4 picks, F10 8–9; zero raw-cap violations across 100,000 generated legal builds.
8. No-cap-violating permanent loadout exceeds 30% identical-seed advantage.

---

## 8. Future co-op scaling — Stage C authoritative combat ONLY

Do NOT apply or validate against the current client-local prototype (remote shots are cosmetic, enemy HP/death is client-local). Gate implementation until shared server combat Stage C. Snapshot `P` (living players, 1–4) at encounter creation; do not rescale living enemies on disconnect/down.

```
NormalMobHP  = solo × (1 + 0.55×(P−1))   → 1.00 / 1.55 / 2.10 / 2.65
BossHP       = solo × (1 + 0.65×(P−1))   → 1.00 / 1.65 / 2.30 / 2.95
ThreatBudget = solo × (1 + 0.35×(P−1))   → 1.00 / 1.35 / 1.70 / 2.05
Stagger/KB resist = 1 + 0.20×(P−1)
Enemy damage: unchanged P1–3; ×1.10 at P4 (author integer damage explicitly)
Ambient heart rate × (1 + 0.30×(P−1)); pickup heals collector only; Dealer stocks P hearts @6 coins
```

Co-op boss TTK target: duo 0.75–0.95× solo, four-player 0.65–0.90× solo; damage taken per player within ±20% of solo.

---

## 9. Determinism requirements

Remove all simulation `Math.random()` (enemy zig seed and boss-add angle included); seed one PRNG per world/region, derive entity streams from `(worldSeed, regionId, spawnOrdinal)`. Integer/fixed-point HP and timers. Server alone computes spawns, tiers, targeting, attacks, hits, damage, phase changes, loot and death; clients send inputs only. Golden-master tests cover floor spawn composition, tier assignment, boss phase timing, P=1–4 scaling, reconnect, and same-seed replay.

---

## 10. Open-world translation (Stage D)

Replace floor with deterministic biome danger rank `R` from `(worldSeed, biomeRing, POItier, bossGateState)`; feed `R` into the same HP/speed/tier/threat formulas within the F1–10 envelope. Interest-local threat budgets per active region; dormant regions with no players. Lock boss HP to eligible arena participants at pull; late joiners add pressure but never rescale/heal the boss mid-phase. Persist boss/event state and player progression only; mobs are deterministic ephemeral respawns. Post-cap progression is horizontal.
