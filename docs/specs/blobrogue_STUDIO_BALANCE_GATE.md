# blobrogue — Studio Balance Gate

**Status:** implementation contract after Stage C merge. **Baseline:** Standard. **Evidence:** current runtime formerly used only `min(3+floor,14)` enemies over an entire floor and weak HP growth, so early mobs lost to 2.25–3× pre-F5 build growth; the newer pressure stack can make late Standard unfair if complex movers, elites and hazards overlap. This gate fixes both: early enemies meet TTK floors, while late difficulty is capped by concurrent-pressure budgets.

## 1. Difficulty modes

All modes use identical tells, hitboxes, boss phase mechanics, loot quality, unlocks and permanent rewards. Never shorten a telegraph below 0.30s post-lock or recovery below 0.35s.

| Modifier | Casual | Standard | Brutal |
|---|---:|---:|---:|
| Normal/elite HP | 0.90× | 1.00× | 1.12× |
| Boss HP | 0.90× | 1.00× | 1.15× |
| Threat budget | 0.80× | 1.00× | 1.25× |
| Active-threat cap | 0.80×, round up | 1.00× | 1.15×, round up |
| Enemy attack cooldown | 1.15× | 1.00× | 0.90× |
| Enemy move speed | 0.95× | 1.00× | 1.05× |
| Enemy damage | authored integers, unchanged | authored integers | authored integers; +1 only on marked Brutal elite signature |
| Hazard budget | 0.65× | 1.00× | 1.30× |
| Max simultaneous complex movers | 1 | 2 | 2 (3 only in large Arena rooms) |
| Ambient heart-rate multiplier | 1.35× | 1.00× | 0.75× |
| Boss heart reward | +2 HP | +1 HP | +1 HP |
| Revive channel | 1.20s | 1.50s | 1.80s |
| Revive HP | 3 | 2 | 2 |
| Down limit per floor | unlimited | 3/player, then spectator until descent | 2/player, then spectator until descent |

Standard remains the authored experience. Casual is forgiveness, not inert enemies. Brutal adds 25% composition and 30% hazard pressure but only 12–15% HP, preventing sponges.

Mode TTK gates: normal focused TTK Casual 0.40–1.20s / Standard 0.45–1.40s / Brutal 0.50–1.55s; elite 2.5–5.0 / 3–6 / 3.5–6.5s. If late Standard exceeds these, reduce HP before budget. If early Standard falls below these, raise that archetype HP before adding bodies.

## 2. Standard floor/biome threat cadence

`FloorThreat = min(30, 6 + 2×(floor−1))`; `ActiveCap = min(16, 8+floor)`. Threat costs: swarm .55, standard 1, ranged 1.5, brute 2.2, complex movement cost ×2, elite 2.8 (elite complex = 5.6). Apply mode multiplier after summing, round to nearest 0.5.

| Band | Biome / teaching job | Floor threat | Active cap | Roster cadence | Hazards |
|---|---|---:|---:|---|---:|
| F1 | Verdant establish | 6 | 9 | Slime + Spitter; 0 elite/brute; one pack-surge group max | 0 |
| F2 | Verdant expand | 8 | 10 | +Bat orbit/dive + Skeleton; max 1 complex group | 0.5 |
| F3 | Verdant decide | 10 | 11 | +Ghost; 12% large variants; max 1 brute room | 1.0 |
| F4 | Verdant prove | 12 | 12 | full five base mobs; first guaranteed brute; max 2 complex | 1.0 |
| F5 | Slime King | boss budget | 8 adds | boss table §3 | boss-authored only |
| F6 | Sunless recover | 16 | 14 | Knellbat appears; lower bodies: spend ≥40% budget on one smart pack | 1.0 |
| F7 | Sunless adapt | 18 | 15 | +Rattleback; 1 elite every 2 rooms; max 1 burrower/room | 1.5 |
| F8 | Sunless risk | 20 | 16 | 18% large; first optional Arena; max 1 elite/room | 2.0 |
| F9 | Sunless mastery | 22 | 16 | smart flock + ranged cross-pressure; 1 brute and 1 elite max/room | 2.0 |
| F10 | Marrow | boss budget | 9 adds/hazards | boss table §3 | boss-authored only |
| F11–14 | Deep | 24/26/28/30 | 16 | +Crookleg F11, Seamwalker F12; Weaver grammar; 1 elite/room, two only large room F14 | 2.0 |
| F15 | Weaver | boss budget | 10 | boss table §3 | boss-authored only |
| F16–19 | Deep climax | 30 | 16 | all 9+ mobs; brute+elite allowed F16+; never >2 complex types or >1 Rattleback + >1 Crookleg small room | 2.5 |
| F20 | Jet | boss budget | 10 | boss table §3 | boss-authored only |
| F21–24 | Emberreach | 30 | 16 | 1.05× body budget already included by replacing 5% simple with hazards; convection + commander elites | 3.0 |
| F25 | Hollow Choir | boss budget | 12 | boss table §3 | boss-authored only |

Roster is at least 10: Slime, Bat, Skeleton, Ghost, Spitter, Knellbat, Rattleback, Crookleg, Seamwalker, plus biome commander/elite variants. Flocking: one deterministic leader per 3–5 units; member commitments stagger 0/.18/.36s; only leader can rally; leader death causes .65s panic + 1.20s no rally/dive. No flock may consume >35% of room threat.

Tier cadence: large chance 0/0/12/18/24% across tutorial/F3–4/F6–9/F11–19/F21+; brutes first guaranteed F4, cap 1/room until F10 then 2 only large rooms; elites guaranteed F6, every second room F7–8, max one/room F9–13, second only large room F14+. Elite is one readable affix, never blanket doubled damage.

Hazard budget unit = one 48–72px danger area active for 2.0s after ≥0.65s tell. Standard permits max 2 simultaneous hazard units (3 in boss/Arena), max 35% walkable area denied, and one safe route ≥64px wide. Brutal: max 3 units/45% denial. Casual: max 1/25%. Mob commitments + hazards share one overlap arbiter: no two damage releases within 0.30s covering the same escape lane.

## 3. Five-boss roster

Boss HP is recalibrated whenever legal weapon/blessing pool changes:
`HP = max(round10(targetMedianBurn × medianPracticalDPS), ceil10((minLegalTTK − forcedTransitionTime) × P95LegalDPS))`.
Use per-boss Stage-C telemetry, not sheet DPS. Later effective health after expected power ≤1.5× Slime King. HP below is initial Standard solo calibration.

| Boss / floor | Standard solo HP | Casual / Brutal | Median / high-roll TTK | Phases + forced time | Pressure contract |
|---|---:|---:|---|---|---|
| Slime King F5 | 900 | 810 / 1,040 | 35–50 / 20–25s | 70%,35%; 1.2s each (2.4s) | add cap 5/5/7; attacks 3.2/2.7/2.25s; contact2, slam2/1, glob1 |
| Marrow F10 | formula initial 1,260 | 1,130 / 1,450 | 38–52 / 22–28s | 66%,33%; .9s each | charge windup .70, lock .40, active .60@520, wall recover1.0; P2 pairs; P3 +20% charge speed + rubble; max 2 rubble lanes, each 4s |
| Weaver F15 | formula initial 1,340 | 1,210 / 1,540 | 40–55 / 22–30s | 66%,33%; .8s each | blink tell .65, lock .35, recover .60; P2 2-hit with .45 gap; P3 one real + two afterimages; max 2 web zones/30% denial |
| Jet F20 | formula initial 1,520 | 1,370 / 1,750 | 42–58 / 24–32s | 66%,33%; 1.0s each | P1 one school; P2 two + corrupt dash; P3 all + one 4s Resonance survival, then 2.0s punish; no copied move <original tell |
| Hollow Choir F25 | formula initial 1,800 | 1,620 / 2,070 | 45–65 / 25–35s | 66%,33%; 1.2s each | strike markers ≥.75s; charge-floor tell1.2s; safe ring ≥72px; P3 doubles rain sequentially, never simultaneous release; max 12 adds |

All transitions queue overflow until the transition ends. Reduction may be 35%, never immunity. Log enter/exit/queued overflow. Boss contact/signatures cap 2 damage on Casual/Standard; Brutal may use 3 only for ≥1.0s signature tells. Boss death clears danger and opens exit regardless of adds.

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
2. **Late-Standard gate:** 100 seeds × F11–24. Normal TTK ≤1.4s, damage events 2.5–4.5/floor, no >2 complex types, hazard denial ≤35%, and <15% deaths from two releases within .30s on same escape lane.
3. **Mode separation:** Casual completion 1.30–1.55× Standard; Brutal .55–.75× Standard. Standard first-clear 18–28% solo / 25–38% duo. If Brutal too easy, add composition first; if Standard too hard, remove overlap first.
4. **Boss gate:** ≥200 pulls/boss/mode/P. TTK in §3; no legal build below high-roll minimum; no transition >1.2s except Jet's authored 4s survival; forced downtime logged.
5. **Roster gate:** every nonboss archetype appears in ≥2 authored combinations; each new movement verb gets one isolated teaching room before remix; flock commitments retain .18s stagger under replay.
6. **Party reward gate:** 10,000 seeds/P; opportunity counts exactly §4, no claim removes teammate choice, no rarity uplift, no player starved >2 floors.
7. **Pet gate:** 1,000 simulated rooms + 100 boss pulls; owner pet ≤12% sustained, all pets ≤25%, healing/control caps never exceeded.
8. **Revive/reconnect gate:** deterministic tests for cancel, simultaneous revivers, down-limit, disconnect during attack/loot/transition, rejoin <90s, expiry, wipe, reward eligibility; no duplication/heal/boss rescale.
9. **Determinism:** same seed/input stream produces byte-identical spawns, tier/flock roles, hazard arbitration, damage, loot, pet procs and boss phases across LocalTransport and server.
10. **Power ceilings:** 100,000 generated legal builds: temporary P95 ≤6× outside Resonance; raw caps damage2.25/fire1.8/move1.35/maxHP+4/pierce+3/status50%; strongest permanent loadout 20–27%, never ≥30%.
11. **Depth/hazard gate (SHIPPED, mandatory in `npm test` via `test/depth.test.ts`):** generator invariants (full-floor connectivity, open centers, sealed border, determinism) across seed×floor sweeps; archetype/biome-ladder escalation; hazard fairness (telegraph-before-hit, 1 damage, iframe gating, pool-path reachability, spawn/exit/center radii, boss floors generator-hazard-free); §1–2 hazard rows per mode — budget 0.65/1.00/1.30×, per-room simultaneity 1/2/3 (+1 arenas), denial 25/35/45%, and the 0.30s release-spacing arbiter proven over one shared 4.8s pulse cycle per room; flock separation/cohesion/stagger determinism; physical-interaction hooks (slam/charge/body breakage, cover absorption). Mob commitments join the same overlap arbiter when the difficulty system lands (`hazardOnsetsInRoom`/`HAZARD_DIFFICULTY` are the integration points).

## 8. Release decision

Do not ship modes, pets or late-biome pressure on subjective feel alone. Standard passes only when both early-melt and late-overlap gates pass together. Mode modifiers are then applied around that validated baseline; boss HP is recalibrated from measured median/P95 DPS every time the legal arsenal changes.
