# blobrogue — Studio Balance Gate

**Status:** implementation contract after Stage C merge. **Baseline:** Standard. **Audited state:** main `b2e72f4`; content wave `origin/ian/content-wave-variety-1eaf`; depth ladder `origin/ian/depth-progression-world-2267`. Main has five mobs + Slime King; content wave has nine mobs, five implemented bosses and bat flocking; depth branch owns the correct five-floor biome ladder. Old early-mob/boss melting is confirmed (`docs/PLAYTEST_FEEDBACK.md:58–60`, content-wave spent-round tests). No workspace evidence confirms a named Standard mode or the claim that late Standard was too hard; modes do not exist yet. Treat late overload as a gate to test, not a proven result. This contract prevents both failure modes: early enemies meet TTK floors, while late difficulty is capped by concurrent-pressure budgets.

## 1. Difficulty modes

All modes use identical enemy/boss HP, tier HP, weapon DPS, damage, phase thresholds/floors, windups, locks, recoveries, loot quality and unlocks. Mode changes concurrent pressure and recovery only; focused TTK stays authored. Never shorten a telegraph below 0.30s post-lock or recovery below 0.35s.

| Modifier | Casual | Standard | Brutal |
|---|---:|---:|---:|
| Normal/elite HP | 1.00× | 1.00× | 1.00× |
| Boss HP | 1.00× | 1.00× | 1.00× |
| Threat budget | 0.80× | 1.00× | 1.20× |
| Active-threat cap | 0.85×, floor, min 6 | 1.00× | 1.15×, ceil, max 18 |
| Enemy/boss idle attack CD | 1.15× | 1.00× | 0.85× |
| Reinforcement interval | 1.25× | 1.00× | 0.85× |
| Boss add interval / cap | 1.20× / −1 (min2) | 1.00× | 0.85× / +1 |
| Projectile speed | 0.90× | 1.00× | 1.10× |
| Enemy damage | authored integers, unchanged | authored integers | authored integers, unchanged |
| Hazard budget | 0.65× | 1.00× | 1.30× |
| Max simultaneous complex movers | 1 | 2 | 2 (3 only large Arena) |
| Ambient heart-rate multiplier | 1.25× | 1.00× | 0.80× |
| Boss heart reward | +2 HP | +1 HP | +1 HP |
| Revive channel / HP | 1.20s / 3 | 1.50s / 2 | 1.80s / 2 |
| Down limit per floor | unlimited | 3/player | 2/player |

Standard remains the authored experience. Casual gives more reaction and recovery. Brutal increases composition/opportunity frequency without extra HP or ordinary damage.

Focused TTK gates are identical in every mode: normal 0.45–0.90s early and 0.70–1.40s late; brute 1.8–3.2s; elite 3–6s. If late Standard exceeds them, reduce HP before budget. If early Standard falls below them, raise that archetype HP before adding bodies.

## 2. Standard floor/biome threat cadence

`FloorThreat = min(30, 6 + 2×(floor−1))`; `ActiveCap = min(16, 8+floor)`. Costs: swarm .55, standard 1, ranged/charger/burrower/orbiter/shielder 1.5, brute 2.2, complex movement cost ×2, elite 2.8. Apply mode multiplier after summing, round to nearest .5.

First-clear floors 1–30 are six authored five-floor bands. No random boss rotation on first clear; later-run remix unlocks only after Choir F30 is cleared:

| Band | Curriculum / boss | Threat / cap | Required roster cadence | Hazard cap |
|---|---|---|---|---:|
| F1 | Verdant teach | 6 / 9 | Slime only; one pack-surge group max | 0 |
| F2 | Verdant expand | 8 / 10 | +Bat, Skeleton, Spitter; bat flock isolated first | .5 |
| F3 | Verdant remix | 10 / 11 | +Ghost, Charger; max one complex group | 1 |
| F4 | Verdant prove | 12 / 12 | +Burrower; first guaranteed brute; max two complex types | 1 |
| F5 | Slime King | boss / 8 adds | §3 | authored only |
| F6 | Sunless recover | 16 / 14 | +Orbiter isolated teaching room; lower body count | 1 |
| F7 | Sunless adapt | 18 / 15 | +Shielder; one elite every two rooms | 1.5 |
| F8 | Sunless risk | 20 / 16 | all nine mobs; first optional Arena; max one elite/room | 2 |
| F9 | Sunless prove | 22 / 16 | smart flock + ranged cross-pressure; max one brute + one elite/room | 2 |
| F10 | Authored miniboss gauntlet | gauntlet / 10 | three sequential rounds (commander → elite → brute), 5s intermissions; §3 | authored only |
| F11–14 | Deep | 24/26/28/30 / 16 | nine-mob remixes; one elite/room, second only large F14; no new verb before isolated teach | 2 |
| F15 | Marrow | boss / 9 | §3 | authored only |
| F16–19 | Deep fracture | 30 / 16 | wrong-geometry/hazard remixes; replace bodies with pressure, never exceed overlap caps | 2.5 |
| F20 | Weaver | boss / 10 | §3 | authored only |
| F21–24 | Goldwork | 30 / 16 | shielder/commander emphasis; brute+elite allowed; max two complex types | 3 |
| F25 | Gilded Warden | boss / 10 | §3 | authored only |
| F26–29 | Emberreach | 30 / 16 | convection + commander elites; replace 5% simple budget with hazards | 3 |
| F30 | Hollow Choir | boss / 12 | §3 | authored only |

Nine implemented content-wave mobs: Slime, Bat, Skeleton, Ghost, Spitter, Charger (F3), Burrower (F4), Orbiter (F6), Shielder (F7). Their in-flight bases remain authoritative: Charger 5HP/46 speed/r17; Burrower 4/40/r15; Orbiter 3/95/r13; Shielder 5/50/r16; each threat1.5 and damage1. Do not substitute older Knellbat/Rattleback/Crookleg names into this wave.

Bat flock constants stay in-flight: neighbor radius90, separation30, max5 neighbors, weights separation1.7/alignment.5/cohesion.35/target1, turn7rad/s, minimum speed .5, hard core18. A flock is 3–5 bats, consumes ≤35% room threat, and only one flock may commit inside any .36s window; deterministic member offsets 0/.18/.36s.

Per room: max2 complex types, max1 Burrower and max1 Shielder, no brute+elite before F8. Large chance 0% F1–2, 12% F3–4, 18% F6–9, 24% F11+. Brute first guaranteed F4, cap1/room until F10 then 2 only large rooms. Elite guaranteed F6, every second room F7–8, max1/room F9–13, second only large F14+.

Hazard unit = one 48–72px danger area active 2.0s after ≥.65s tell. Standard max2 simultaneous units (3 boss/Arena), ≤35% walkable denial and one ≥64px safe route. Brutal max3/45%; Casual max1/25%. Shared overlap arbiter forbids two releases within .30s covering the same escape lane.

## 3. Five-boss roster

Implemented content-wave five: Slime King, Marrow, Hollow Choir, Weaver, Gilded Warden. Jet remains spec-only and is not in this gate. First-clear order is King F5 → authored miniboss gauntlet F10 → Marrow F15 → Weaver F20 → Warden F25 → Choir F30. No random rotation on first clear. Seeded later-run remix/rematches unlock only after Choir F30 is cleared.

First-clear boss floor mapping is fixed: `bossFloor={king:5, gauntlet:10, marrow:15, weaver:20, warden:25, choir:30}`. Boss HP remains DPS-calibrated by the same formula, using telemetry for the intended floor's legal build pool. Do not apply an extra floor HP multiplier after calibration. The F10 gauntlet uses three sequential captains derived from calibrated Marrow F15 HP: commander `round10(.28×)`, elite `round10(.32×)`, brute `round10(.40×)` (total 1.00×). Party scaling applies independently at each spawn. The next captain cannot spawn until the prior captain, its summons and its hazards are dead/cleared.

HP recalibration whenever the legal pool changes: `HP=max(round10(targetMedianBurn×medianPracticalDPS), ceil10((minLegalTTK−forcedTransitionTime)×P95LegalDPS))`. Initial Standard solo values below are in-flight values, not permanent constants.

| Boss / floor | Initial HP | Median / high-roll gate | Exact phase-pressure contract |
|---|---:|---|---|
| Slime King F5 | 950 (content wave measured 48.2s / 22.8s) | 35–50 / 20–25s | 70/35%; floors62/27%; CD3.2/2.7/2.25; add intervals4.5 then6.5/6.5/7, caps5/5/7; contact2 |
| Miniboss gauntlet F10 | 3 sequential rounds: commander .28×, elite .32×, brute .40× calibrated Marrow HP | 55–80s total / ≥35s high-roll; each round ≥10s | R1 Charger commander + max4 simple adds (active threat≤8); R2 Shielder elite + max3 ranged adds (≤8); R3 Brute Burrower alone plus max1 hazard (≤6). Each captain has two phases split at50%, one .8s non-invulnerable transition, no phase floor. Intermission5s after R1/R2; +1 heart only after R2; no blessing until full clear. Never more than one captain/miniboss alive; next spawn waits for all prior adds/hazards to clear |
| Marrow F15 | 1,250 | 35–50 / 20–25s | 65/30%, floors57/22%; CD3/2.6/2.2; charge tell.9/lock.5, 520 for1.1s, recover.7 or crash1.6; P3 spiral tell.8/dur2.2/emission.22/recover.8; shield .9–2.6s at 35% reduction; adds7s cap4/4/6 |
| Weaver F20 | 1,080 | 38–55 / 20–28s | 65/30%, floors57/22%; CD3/2.7/2.3; weave .7/.35/.7, 3/3/4 webs r62/life12/slow.55/cap8; pounce .65/.3/.35air/.9 recover, chains1/2/2; molt1.4 +2 adds |
| Gilded Warden F25 | 800 | 40–58 / 22–30s | 70/35%, floors62/27%; CD3.6/3.2/2.8; closed armor takes30%; slam .8/.45/.3 then exposed2.2; sweep tell.75 then exposed2.0, 10 bolts, two waves P3; transition1.2/35% reduction |
| Hollow Choir F30 | 1,130 | 40–58 / 22–30s | 65/30%, floors57/22%; CD3.2/2.8/2.4; fade every third, tell.6/drift1.8×1.6/recover.8; 2/3/4 homing wails @150; transition split3 wisps, 1–3.2s |

All transitions queue overflow until exit and log enter/exit/overflow. No immunity. Ordinary/signature damage caps at 1/2. At most one arena-wide denial plus one committed boss pattern. Boss death clears danger. The existing content-wave deep-boss test of 30–45s is replaced by the individual gates above; Warden's 800 HP is valid only if its closed-armor/exposure cycle lands inside its gate.

## 4. Party scaling and weapon opportunities (Stage C only)

Encounter snapshot P=1–4 at room/pull start; no mid-fight rescale on down/disconnect. Normal HP `1+.55(P−1)`; boss HP `1+.65(P−1)`; threat `1+.35(P−1)`; stagger/KB `1+.20(P−1)`. Damage unchanged P1–3; P4 +1 only on explicitly authored heavies.

Weapon opportunity rules prevent party dilution without multiplying combat power:
- Normal weapon pedestal rolls: `max(1, ceil(P/2))` physical weapons (P1–2:1, P3–4:2), distinct IDs when pool permits.
- Boss weapon reward: `P+1` distinct choices, capped 5; each player claims one personal choice. A claim does not remove choices for teammates. Duplicate owned weapons stay available for another player; claimant gets one reroll, never coins/raw damage.
- Dealer weapon stock: `max(2,P)` distinct weapons; purchases personal and do not deplete teammate stock. Prices unchanged 12/18/24.
- Per-player weapon-opportunity gate by each boss: ≥3 distinct offered IDs, ≥1 compatible with each equipped family, and no player goes >2 consecutive non-boss floors without a weapon opportunity.
- Party quantity increases options, not rarity: rare chance and weapon stats identical solo/co-op. No shared-drop race.

## 5. Pets / companions (new hard caps)

No current canonical pet combat contract was found; use this ceiling before any pet ships.

- One active pet/player; pet is untargetable utility, cannot body-block, revive, collect hearts, trigger boss phases, or hold objectives.
- Pet sustained single-target damage ≤12% of owner's measured median weapon DPS; burst over any 3s window ≤18%; all party pets combined ≤25% of party DPS.
- Pet room-clear contribution ≤15% of owner kills and secondary-target contribution valued under the same 45% multitarget budget.
- Control: slow ≤15% with ≤40% uptime; mark/vulnerability ≤8% with ≤25% uptime; no hard stun/freeze on bosses; nonboss hard control ≤0.35s once/6s.
- Healing pet ≤0.25 HP/floor expected and ≤1 HP per 90s; shares global sustain budget, never creates hearts. Shield pet ≤1 prevented damage/45s.
- Pet proc RNG server-seeded; pet disappears while owner downed; reconnect restores cooldown/state snapshot, not charges.
- Pet progression is horizontal behavior only. Permanent pet raw contribution counts inside the account-wide <30% Foundation ceiling.

## 6. Revive, down and reconnect

Standard baseline: 1.5s uninterrupted revive, radius46, restore2 HP, 1.0s protection, cannot attack first .35s. Any reviver damage, dash, attack, or leaving radius cancels. One reviver only; extra players do not accelerate. Downed players add no targets but room snapshot scaling remains.

Reconnect contract: reserve party slot and player snapshot for 90s. Body becomes invulnerable/non-targeting after 3s disconnect detection and cannot deal damage/loot; it is removed from play, not an AI bot. Rejoin restores exact HP (minimum1 if alive), down state, items, cooldowns, coins and position at nearest valid tile within 64px; no heal, ammo/resource refill, reroll or duplicate reward. During boss pull, reconnect may re-enter but boss HP never rescales/heals; player is eligible for rewards only if connected for ≥50% of fight time or dealt ≥5% boss HP. After 90s, spectator until next descent/checkpoint; rewards earned before disconnect remain.

Wipe: all connected players down simultaneously for 4.0s. Pending reconnect reservations do not block wipe. Casual down limit unlimited; Standard 3/player/floor; Brutal 2/player/floor.

## 7. Required tests / gates

1. **Early-melt gate:** 100 seeds × F1–4 × starter/median build. Standard normal focused TTK never <.45s median archetype and room clear 55–100s; if violated, adjust archetype HP, not body count.
2. **Late-Standard gate:** 100 seeds × F11–30. Normal TTK ≤1.4s, damage events 2.5–4.5/floor, no >2 complex types, hazard denial ≤35%, and <15% deaths from two releases within .30s on same escape lane.
3. **Mode separation:** Casual completion 1.30–1.55× Standard; Brutal .55–.75× Standard. Standard first-clear 18–28% solo / 25–38% duo. If Brutal too easy, add composition first; if Standard too hard, remove overlap first.
4. **Boss gate:** ≥200 pulls/boss or full gauntlet/mode/P at fixed floors 5/10/15/20/25/30. TTK in §3; gauntlet verifies exactly three ordered captain spawns, zero overlap, each round ≥10s, total high-roll ≥35s; no legal build below high-roll minimum; no transition >1.2s; forced downtime logged. Choir split/wisp sequence is active pressure, not forced invulnerability.
5. **Roster gate:** every nonboss archetype appears in ≥2 authored combinations; each new movement verb gets one isolated teaching room before remix; flock commitments retain .18s stagger under replay.
6. **Party reward gate:** 10,000 seeds/P; opportunity counts exactly §4, no claim removes teammate choice, no rarity uplift, no player starved >2 floors.
7. **Pet gate:** 1,000 simulated rooms + 100 boss pulls; owner pet ≤12% sustained, all pets ≤25%, healing/control caps never exceeded.
8. **Revive/reconnect gate:** deterministic tests for cancel, simultaneous revivers, down-limit, disconnect during attack/loot/transition, rejoin <90s, expiry, wipe, reward eligibility; no duplication/heal/boss rescale.
9. **Determinism:** same seed/input stream produces byte-identical spawns, tier/flock roles, hazard arbitration, damage, loot, pet procs and boss phases across LocalTransport and server.
10. **Power ceilings:** 100,000 generated legal builds: temporary P95 ≤6× outside Resonance; raw caps damage2.25/fire1.8/move1.35/maxHP+4/pierce+3/status50%; strongest permanent loadout 20–27%, never ≥30%.
11. **Depth/hazard gate (SHIPPED, mandatory in `npm test` via `test/depth.test.ts`):** generator invariants (full-floor connectivity, open centers, sealed border, determinism) across seed×floor sweeps; archetype/biome-ladder escalation; hazard fairness (telegraph-before-hit, 1 damage, iframe gating, pool-path reachability, spawn/exit/center radii, boss floors generator-hazard-free); §1–2 hazard rows per mode — budget 0.65/1.00/1.30×, per-room simultaneity 1/2/3 (+1 arenas), denial 25/35/45%, and the 0.30s release-spacing arbiter proven over one shared 4.8s pulse cycle per room; flock separation/cohesion/stagger determinism; physical-interaction hooks (slam/charge/body breakage, cover absorption). Mob commitments join the same overlap arbiter when the difficulty system lands (`hazardOnsetsInRoom`/`HAZARD_DIFFICULTY` are the integration points).

## 8. Release decision

Do not ship modes, pets or late-biome pressure on subjective feel alone. Standard passes only when both early-melt and late-overlap gates pass together. Mode modifiers are then applied around that validated baseline; boss HP is recalibrated from measured median/P95 DPS every time the legal arsenal changes.
