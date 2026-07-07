# blobrogue — Current Balance Reset

**Status:** build-ready balance contract  
**Scope:** floor-run baseline, solo/co-op scaling, future open-world translation  
**Principle:** add readable pressure, commitments, composition and scarcity; do not solve difficulty with HP sponges.

## 0. Source of truth

Runtime currently loads `src/main.ts` (`index.html:269`), so `src/game/*.ts` overrides old design notes. New target data should live in one deterministic, server-shared balance module and be consumed by both `LocalTransport` and authoritative server simulation. Do not leave balancing constants duplicated in UI/client code.

Canonical design constraints are `docs/specs/blobrogue_PROGRESSION_spec.md` §10, `blobrogue_MOB_MOVEMENT_spec.md`, `blobrogue_WEAPONS_spec_2.md`, `blobrogue_SCHOOLS_spec.md`, and `blobrogue_BOSS_ROSTER_spec.md`. Progression §10 overrides older duplicate language.

## 1. Reset targets

| Metric | Target |
|---|---:|
| Normal mob focused TTK | 0.45–0.90s floors 1–2; 0.70–1.40s floors 7–10 |
| Brute focused TTK | 1.8–3.2s |
| Elite focused TTK | 3–6s |
| Slime King solo sustained TTK | median 35–50s; legal high-roll 20–25s; hard floor 20s |
| Later boss solo sustained TTK | 45–65s; effective HP after expected power ≤1.5× boss 1 |
| Net HP lost before recovery, median skilled run | 1.5–2.5 hearts/floor |
| Ambient hearts collected | 0.55–0.90/floor, excluding boss reward/dealer |
| Damage events suffered | 1.5–3.0/floor early; 2.5–4.5 late |
| Floor clear duration | 70–110s early; 100–150s late |
| First-clear completion | 18–28% solo; 25–38% coordinated duo |
| Strong-run capability | F3 1.5–2×; pre-boss 2.25–3×; F8–10 3.5–4.5×; high roll 4–6× |

The 95th percentile stays ≤6× outside Resonance; ~7× is allowed only during full Resonance spectacle windows.

## 2. Current runtime diagnosis

### Sustain

| System | Current | Source | Reset |
|---|---:|---|---:|
| Base HP | 6/6 | `src/game/game.ts:125,402,568–569` | 6/6 unchanged |
| Post-hit invulnerability | 0.90s | `game.ts:2312–2315` | 0.80s |
| Dash | 0.70s CD; 0.35s iframe | `game.ts:124,942–957,1104–1106` | iframe 0.18s; CD levels below |
| Loose heart | +1; not consumed at full HP | `game.ts:2043–2049` | +1; consume at full and convert to 2 coins |
| Normal descent | +2 HP | `game.ts:2299–2309` | 0 HP |
| Boss completion recovery | guaranteed chest heart plus descent +2 | `game.ts:2008–2013,2199–2204,2304` | boss chest +1 only |
| Enemy heart drop | 12% per non-boss | `game.ts:2015–2017` | 6% |
| Crate heart | 15%; crates are 28% of props | `game.ts:704–710,2097–2103` | 6% crate heart |
| Wood chest heart | 20%; mean 1.5 chests/floor | `game.ts:713–748,2182–2196` | 15% |
| Fang | +10pp kill-heal/copy, uncapped | `items.ts:122–125`; `game.ts:2000–2004` | 8/13/17% cumulative, Lv1–3 |
| Vitality | +2 max HP/copy and fills delta | `items.ts:162–165`; `game.ts:1161–1168` | +2/+3/+4 cumulative; heal exactly 1 on upgrade |
| Second Wind | ×0.65 per copy | `items.ts:137–140` | CD ×0.65/0.55/0.50 by level from base |
| Revive | 3 HP; 1.2s iframe; 1.1s channel | `convex/presence.ts:5,73–86`; `game.ts:2345–2352,2395–2411` | 2 HP; 1.0s iframe; 1.5s channel |

Current theoretical F1 supply is about 4.39 hearts: descent 2 + enemy drops 0.48 + chest 0.30 + pre-placement-failure crates ~1.61. That nearly refills a six-heart bar each floor. Fang further raises expected healing from 0.12 to 0.22 per kill at one copy. Three current Second Winds yield a 0.192s cooldown inside a 0.35s iframe, enabling near-continuous immunity.

### Enemy curve

Runtime uses `HP = round(baseHp + hpPerFloor × (floor−1))`, speed `baseSpeed + speedPerFloor × (floor−1)` (`src/game/enemies.ts:72–80`), and normal count `min(3+floor,14)` (`enemies.ts:147–155`).

| Enemy | Current HP base/+floor | Current speed base/+floor | Damage |
|---|---:|---:|---:|
| Slime | 3 / +0.6 | 42 / +3 | 1 |
| Bat | 2 / +0.3 | 96 / +4 | 1 |
| Skeleton | 6 / +0.9 | 62 / +3 | 1 |
| Ghost | 4 / +0.6 | 56 / +3 | 1 |
| Spitter | 3 / +0.5 | 30 / +1 | 1 |
| Boss | 90 / +16 | 40 / +2 | 3 contact |

Sources: `src/game/enemies.ts:32–63`. At floor 5 the boss has 154 HP. Thunderbolt is 9 damage every 0.72s before blessings (`src/game/weapons.ts:55–58`), while rapid/high-roll multiplicative builds and unlimited duplicates can erase 154 HP in ~3s. There is no player-count difficulty scaling. Current co-op is also not shared authoritative combat: each client simulates local enemy HP/death, remote shots are cosmetic (`game.ts:2363–2375`), and only nearest-target poses split aggro (`game.ts:1263–1265`). Thus current party DPS must not be inferred from the client prototype; §7 is the future shared-authority model.

## 3. Sustain reset

1. Remove normal descent healing. The descent is pacing, not a free full mistake reset.
2. Keep boss chest +1 heart. Dealer heart costs 6 coins and restores exactly +1; no full heal.
3. Natural heart rates: enemy 6%, crate 6%, wood chest 15%. Exclude boss-spawned adds and trivial summons from both heart and Fang rolls.
4. Fang 8/13/17%, one heart, shared 1.25s proc cooldown. Expected ten-kill recovery with natural drops is 1.4/1.9/2.3 hearts, before crates/chests.
5. Vitality +2/+3/+4 cumulative; gaining a level restores one current heart, not the full capacity delta.
6. Second Wind uses level lookup against base cooldown, never repeated multiplication: 0.455/0.385/0.350s. Dash iframe becomes 0.18s and cannot refresh or overlap. At Lv3, theoretical maximum uptime is 0.18/0.35 = 51.4%; the iframe still covers the 0.16s active dash plus 20ms forgiveness. It remains excellent mobility without immunity.
7. Full-health loose hearts are consumed and convert to 2 coins. No backtracking stockpile.
8. Revives restore 2 HP after a 1.5s uninterrupted channel. Any damage cancels the channel. A revived player gets 1.0s protection but cannot attack for the first 0.35s.
9. Recovery pity: after two consecutive non-boss floors with zero heart generated while entering below 50% HP, force one heart in the next wood chest. Deterministic counter, reset on generation.

## 4. Floor threat curve

Apply band multipliers to archetype F1 baselines. Stop linear per-floor speed inflation; speed beyond readability is not difficulty.

| Floors | HP | Speed | Contact/projectile damage | Base active threat budget | Spawn cadence |
|---|---:|---:|---:|---:|---|
| 1–2 | 1.00 / 1.25 | 1.00 / 1.02 | 1 | 6 / 7 | one readable wave |
| 3–4 | 1.50 / 1.72 | 1.04 / 1.06 | 1 | 9 / 10 | 65% second wave |
| 5–6 | 1.94 / 2.12 | 1.07 / 1.09 | 1; heavy telegraph 2 | 11 / 12 | two waves |
| 7–8 | 2.30 / 2.47 | 1.11 / 1.13 | 1; heavy 2 | 13 / 14 | two waves + reinforcement trigger |
| 9–10 | 2.60 / 2.71 | 1.14 / 1.16 | 1; heavy 2 | 15 / 16 | 2–3 waves, no spawn behind camera |

Threat costs: simple chaser 1.0, ranged/kiter 1.5, complex movement 2.0, brute 2.5, elite 4.0. Count budget, not bodies. Maximum two complex archetypes per room. Small rooms never combine more than one Rattleback and one Crookleg. Preserve ≥0.30s post-lock dodge time and ≥0.35s recovery.

### Size / brute / elite cadence

- **Large:** 1.25× radius, 1.35× HP, 0.90× speed, 1.25× knockback resistance; still 1 damage. First appears F3; 12/18/24/30% of simple enemies in bands 3–4/5–6/7–8/9–10.
- **Brute:** 1.45× radius, 2.25× HP, 0.82× speed, 2× knockback resistance; only authored, clearly telegraphed attacks deal 2. First appears F4. Cap 1 per room F4–6, 2 F7–10; costs 2.5.
- **Elite:** 1.20× radius, 3.25× HP, 1.08× speed, one visible affix mechanic, never a blanket damage multiplier. First guaranteed F6; then one every two combat rooms F7–8 and every combat room at most F9–10. Cap one elite per room until F9, then two only in large rooms.
- No tier may multiply attack cadence by more than 1.15×. Difficulty comes from one authored modifier: rally, shield arc, delayed hazard, split, or commander reinforcement.

### Biome pressure modifiers

- **Verdant:** 1.00× budget. +15% pack units; elastic surge and flanking. No stat surcharge.
- **Sunless:** 0.95× bodies, 1.10× complex-threat share. Sound tells, momentum dives, staggered commitments.
- **Deep:** 0.90× bodies, 1.15× hazard budget. Fracture lanes and wrong geometry; never hide unavoidable contact in walls.
- **Emberreach:** 1.05× budget, 1.15× reinforcement rate, convection lanes. Heat pressure changes safe space, not enemy HP.

## 5. Slime King reset

### Current

Floor 5 Slime King is 154 HP from `90 + 16×4` (`enemies.ts:63,74`). Phases are >66%, 66–33%, <33% (`game.ts:1657–1659`). Hop slam: 0.6s windup, target lock at 0.3s, 0.5s air, 0.7s recovery; radial: 0.8s windup/0.6s recovery, 8 globs; attack CDs 3.5/2.8/2.2s; minion drip 3.4s; total enemy cap 14 (`game.ts:302–316,1631–1666,1721–1752`).

### Recommended encounter

Target 35–50s median solo sustained TTK, 28–42s duo, and 20–25s for legal high-roll solo builds. Initial solo F5 HP is **900** for the present arsenal. Recompute whenever the legal pool changes using `bossHP = max(round10(38s × medianPracticalDPS), ceil10((20s − forcedTransitionTime) × P95LegalSustainedDPS))`. At median 24 DPS, P95 51 DPS and 2.4s forced transition time, 900 is the accepted initial calibration: 37.5s raw median burn and ~20.05s P95 including transitions. HP is a calibration result, not the difficulty lever.

- **Opening, 100–70%:** 1.2s entrance grace. Hop slam every 3.2s. Windup 0.65s, lock at 0.32s, air 0.45s, recovery 0.65s. One slime pair at 4.5s, then every 6.5s. Add cap 5.
- **Phase transition at 70%:** 1.2s roar, 35% damage reduction (not immunity), clear bullets within 70px, spawn two slimes at marked opposite edges. Phase floor prevents crossing below 62% until roar ends; overflow damage is queued and applies only after the full transition exits. Log transition enter, exit and queued overflow.
- **Middle, 70–35%:** alternate hop and 10-glob radial. Radial windup 0.75s, recovery 0.60s, alternating gaps of 36°. Attack CD 2.7s. Every second radial orders existing slimes into a delayed pack surge; no extra HP.
- **Transition at 35%:** same 1.2s/35% reduction, phase floor 27%; overflow is queued and applies only after the full transition exits.
- **Final, 35–0%:** attack CD 2.25s. Hop landing fires four cardinal globs, as current. Minion pair every 7s, cap 7. Every third attack is a 1.0s telegraphed arena squeeze lasting 3.0s. Boss chase +12%, not +20%.
- Boss contact 2 (down from 3); slam center 2, outer shockwave 1; globs 1. A technique failure hurts, but collision cannot delete half a base bar.
- Hard anti-burst uses only transition phase floors; no invulnerability segment exceeds 1.2s and total forced transition time is 2.4s.
- Boss death ends danger immediately and opens exit regardless of adds.

### Future boss baseline

Use three 25–40% HP technique chapters, 1.0–1.8s transition beats, one signature arena rule, and no more than two simultaneous pattern families. Later boss effective HP after expected player power is at most 1.5× Slime King. Target 45–65s solo; difficulty growth is pattern composition, movement and decision pressure.

## 6. Blessing Lv1–3 budget

Implement `itemLevels`, recompute modifiers from levels, remove Lv3 cards, and weight a new eligible blessing 3× an upgrade. No incremental irreversible applies.

Hard caps: damage 2.25×, fire rate 1.8×, move 1.35×, max HP +4, blessing pierce +3, each elemental chance 50%. Apply clamping in authoritative simulation after full build recompute.

Budget per blessing:

- Lv1 establishes the mechanic and should add roughly 12–25% single-target effective power or a strong utility behavior.
- Lv2 adds 35–55% of Lv1's raw delta plus a consistency improvement.
- Lv3 adds 20–40% of Lv1's raw delta plus a qualitative payoff. Do not simply triple Lv1.
- Multitarget power is valued at 45% of paper secondary-target DPS in room-clear budgeting; status/control at 35%; mobility at 50%. This lets exciting mechanics coexist without pretending all paper DPS is always realized.
- Preserve canonical examples: Hair Trigger +35/+55/+70% cumulative; Full Metal +1/+2/+3; Vitality +2/+3/+4; statuses 25/40/50%; Second Wind ×0.65/0.55/0.50; Coin Magnet 90/240 → 240/480 → 900/900 radius/pull.
- Fang exception is 8/13/17%, lower than the prior 10/17/22 sustain proposal because ambient hearts and dealer recovery coexist.
- One build may reach 4–6× *expressive capability* through pellets, ricochet, pierce, status, crit, Fracture, positioning and Resonance. Raw flat-stat products must not independently reach that number.
- Reward cadence: normal blessing only on non-boss descent; boss chest replaces it with Rare/Boss reward. Remove random wood-chest blessings. Target ~4 picks by F5 and 8–9 by F10.

## 7. Future co-op scaling (Stage C authoritative combat only)

Do not apply or validate these values against the current client-local prototype. Gate implementation until shared server combat Stage C. Let `P` be living/connected players at encounter creation, clamped 1–4. Snapshot P per room; do not rescale living enemies when someone disconnects or is downed.

- Normal/elite HP multiplier: `1 + 0.55 × (P−1)` = 1.00/1.55/2.10/2.65.
- Boss HP multiplier: `1 + 0.65 × (P−1)` = 1.00/1.65/2.30/2.95.
- Active threat budget: `1 + 0.35 × (P−1)` = 1.00/1.35/1.70/2.05.
- Boss/add stagger and knockback resistance: `1 + 0.20 × (P−1)`.
- Enemy damage: unchanged P1–3; 1.10× at P4, with integer damage authored explicitly rather than fractional hidden rounding.
- Heart generation is per party, not per player: ambient heart rate × `1 + 0.30×(P−1)`. Pickup heals the collector only. Dealer stock offers `P` hearts at 6 coins each.
- Revive rules above are the co-op survival advantage. Downed players contribute no target or threat-budget relief mid-room.

Expected focus-fire gain is greater than HP scaling, intentionally shortening co-op boss TTK modestly while increased threat budget prevents free firing.

## 8. Open-world translation

Do not scale by an endless global level. Each region has a fixed recommended threat band and a local **encounter budget** using the same costs/tier rules. Player-count snapshot and deterministic seed are `(worldSeed, regionId, encounterId, respawnIndex, P)`. Regions can remix biome pressure, objectives and elite affixes; HP remains within the F1–10 envelope. Post-cap progression is horizontal. Death returns to hub, and recovery sources respawn only with the encounter, never from farmable trivial adds.

## 9. Acceptance and test plan

Instrument authoritative events: encounter start/end, damage dealt by source, damage taken by source, dash iframe avoidance, hearts generated/collected/wasted/converted, Fang procs, dealer buys, blessing levels, boss phase timestamps, downs/revives, player count, seed and build snapshot.

### Deterministic matrix

Run 100 fixed seeds per cell, replayed with scripted aim/movement profiles and then human validation:

- Floors 1, 3, 5, 8, 10.
- Solo, duo, four-player.
- Baseline build, median legal build, 95th-percentile legal high roll.
- Pistol, Thunderbolt, Rebound/wall-bounce, melee.
- No-hit bot, median-hit bot, stress bot.

### Ship gates

1. Slime King median solo TTK 35–50s; legal high-roll P10 20–25s; absolute observed minimum ≥20s across legal builds.
2. No boss transition invulnerability/reduction beat >1.2s; forced downtime total ≤3s.
3. Normal TTK and elite TTK remain in §1 ranges at median legal build. These TTK gates override floor HP multipliers; if late normal focused TTK exceeds 1.4s, reduce HP before reducing composition pressure.
4. Median ambient healing 0.55–0.90 hearts/floor; P90 ≤1.6. Fang Lv3 contributes ≤1.7 hearts on a 10-kill floor after cooldown/exclusions.
5. Median skilled player ends a non-boss floor 1.5–2.5 HP below entry before recovery; fewer than 10% of floors erase ≥4 damage through free sustain.
6. Second Wind Lv3 iframe uptime under a deterministic continuous-optimal-dash test is 50–52% (theoretical 51.4%); no overlapping or refreshable iframe. Post-hit 0.80s protection is tested separately and must not extend dash protection.
7. F5 entry blessing count median 4; F10 8–9. No raw cap violation in 100,000 generated legal builds.
8. Co-op boss TTK: duo 0.75–0.95× solo; four-player 0.65–0.90× solo. Damage taken per player stays within ±20% of solo.
9. First-clear completion target: solo 18–28%, duo 25–38%. Expert repeat completion 45–65%; if lower, reduce composition pressure before HP.
10. Same seed/input stream produces identical enemy spawns, loot, procs, phase changes and damage on local and dedicated server simulations.

### A/B rollout

- **A:** current production.
- **B1:** sustain reset only. Measure free healing, damage erased, completion and dealer spend for 500 runs.
- **B2:** add floor threat budgets/tiers. Measure clear time, damage sources, unreadable double-commit deaths for 500 runs.
- **B3:** add boss reset and co-op scaling. Require 200 Slime King pulls per party size plus 20 moderated human sessions.
- Promote only if completion enters target without >15% of deaths occurring within 0.4s of two independently committed attacks. If deaths are too high, first reduce simultaneous complex threat budget 10%; do not add global healing.

## 10. Implementation order

1. Create shared deterministic balance tables and telemetry schema.
2. Implement blessing `itemLevels`, full recompute, caps, Lv3 removal and reward cadence.
3. Apply sustain changes and anti-farm tags.
4. Remove simulation `Math.random()` (enemy zig and boss-add angle included) and use seeded entity streams.
5. Replace body-count spawning with threat budgets, bands and tier cadence.
6. Rebuild Slime King phases and phase-floor overflow handling.
7. Apply room-snapshotted co-op scaling.
8. Run deterministic matrix, then human readability/feel sessions.
9. Tune only from telemetry: sustain first, pressure second, boss HP last.
