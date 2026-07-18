# blobrogue — COHERENT PROGRESSION SPEC (build-ready)
Grounded in current systems: `items.ts` blessings + PlayerMods (21 items, statuses, crit/pierce/pellets/low-HP), Convex `players` (`unlocks[]` + lifetime stats; add Amber/loadout fields), dual modes (per-run floors + persistent open world), weapon families, boss roster/biome gates. Locked direction: variety through ONE universal foundation — health + weapons/gear + blessings/statuses + combo + ONE signature-technique meter. No family-specific currency trees or derivative lore. Power is mechanical/synergistic, not infinite raw-stat creep.

## 1. THE PROGRESSION PROMISE (three layers only)
1. **Temporary build (minutes):** blessings + temporary weapon finds create a 1×→4–6× effective-power arc through mechanics/synergy. Resets at the mode's expedition boundary.
2. **Persistent loadout (hours):** weapons + 2 trinkets are SIDEGRADES/specializations, not gear-score upgrades. Bosses expand options.
3. **World/account progression (dozens of hours):** bosses gate regions, families, recipes, and mastery challenges; Amber grows Blob Camp and buys a tightly capped 20–30% permanent foundation.
No player level. No XP bar. No item-level number. No infinite stat tree. Boss difficulty grows through techniques/patterns/movement composition, never sponge HP.

===============================================================
# 2. IN-RUN POWER CURVE — exact targets
===============================================================
## Baseline and ceiling
Define `effective capability` as practical room-clear / survival output, including multi-target mechanics (pellets, pierce, status, lifesteal, Resonance), NOT sheet DPS alone.
- Start: **1.0×**.
- End floor 3 / first short expedition beat: **1.5–2.0×**.
- Before first boss (floor 5): **2.25–3.0×**.
- Floor 8–10: **3.5–4.5×**.
- Mature/high-roll build (10–12 meaningful picks): **4–6×**, with rare 7× spectacle windows only during a full Resonance/synergy payoff.
- RAW stat caps inside a run: damageMult ≤2.25× from blessings (excluding conditional crit/Resonance), fire rate ≤1.8×, move ≤1.35×, max HP bonus ≤+4 hearts, blessing-added pierce ≤3 (weapon-native pierce resolves under each weapon’s cap), status chance per element ≤50%. The rest of the 4–6× comes from mechanics: more targets hit, crit timing, freeze/shock amps, Fracture bank/snap, positioning, and signature technique.
This prevents "numbers soup" while still letting a build feel outrageous.

## Pick cadence (floor mode)
- Start with persistent loadout (bounded in §5), no temporary blessing.
- Every non-boss descent: **1-of-3 blessing** (current flow already does this).
- Boss defeat: **1-of-3 Rare/Boss blessing** + weapon choice; no normal blessing that floor.
- By floor 5: ~4 picks → 2.25–3×. By floor 10: ~8–9 picks → 4–6× with synergy.
- Duplicate common blessings allowed max 2 copies; uncommon max 2; rare unique. This keeps stacking legible and prevents repeated stat picks from breaking caps.

## Pick cadence (open-world mode)
There is no run end, so define an **Expedition Attunement** without adding a new currency or meter:
- Blessings found at shrines/events fill max **6 temporary blessing slots**.
- They last until DEATH or voluntary RETURN TO CAMP; returning banks loot and clears attunement. This preserves the same "build an identity, risk going farther" arc without pretending the world is a floor run.
- World bosses grant one temporary Boss blessing for the current expedition plus a permanent first-kill unlock (§4).
- Persistent gear stays; temporary blessings reset. Same item definitions/math in both modes, only reset boundary differs.

## Current blessing tuning roles (`items.ts`)
Keep each pick in one of four readable buckets (tag ItemDef; used by draft weighting):
- **Output:** Hair Trigger, Big Iron, Deadeye, Full Metal, elemental coatings.
- **Positioning:** Side Channel rewards a dash or hard aim flick with one plain ghost round along the previous aim, scaling to 55% damage or 30% against bosses.
- **Survival/mobility:** Vitality, Swift Boots, Second Wind, Fang.
- **Economy:** Greed, Coin Magnet (never offered in boss reward).
- **Risk/identity:** Glass Cannon, Berserk, Adrenaline, Elementalist.
Draft rule: every 1-of-3 guarantees at least 2 different buckets; never show 3 economy/small-stat cards. This is coherence in the choice UI.

===============================================================
# 3. BOSS → UNLOCK GRAPH (horizontal first)
===============================================================
Boss first-kills unlock OPTIONS/REGIONS, not +damage. Store in existing `players.unlocks[]` (or shared-world boss flags for open world); one canonical unlock id per node.

**Start (no boss):** Amberwild / floors 1–5; core weapons; 8 starter blessings; 1 primary weapon + 1 trinket slot; basic Camp.

**The Slime King (F5):**
- Unlock Rootbound Warrens region/band.
- Unlock SECOND weapon slot + status blessings (burn/chill/shock).

**F10 Gauntlet clear (non-boss milestone):**
- Unlock Sunless Caves.
- Unlock tougher Dealer/rare option pool; no new currency/system.

**Marrow (F15):**
- Unlock The Deep.
- Unlock second addon/trinket + The Hollow family/Fracture.

**The Weaver (F20):**
- Unlock Gilded Archive.
- Unlock precision/mobility sidegrades, first family mastery, broader Rare OPTIONS.

**The Gilded Warden (F25):**
- Unlock Emberreach.
- Unlock Goldwork/deployable family + Camp construction cosmetics/functions.

**The Hollow Choir (F30):**
- Complete first-clear chain.
- Unlock Choir family gear, Archive Contracts/mastery/authoritative normalized global boards, and later Jet endgame path.
- Add Camp Listening Hall/Memorial.

**Jet (later endgame):**
- Unlock family Fusions/adaptive mastery (§7), not raw stats.
- Visibly evolves the Amber Heart / post-clear Archive research.
Floor mode: approved bosses plus the F10 Gauntlet milestone set canonical account unlocks after the run. Open world: corresponding gates persist immediately. Same graph, different presentation.

===============================================================
# 4. AMBER ECONOMY + AMBER CAMP TREE
===============================================================
## One persistent currency only: Amber
Add to `players`: `amber:number`, `equippedFoundation:string[]`, `gearInventory:string[]`, `loadout` (ids). Keep `unlocks[]`. Coins remain the temporary shop currency; no XP/dust/shards/keys-as-currencies.

## Earn rates (target: one meaningful unlock every 2–4 normal sessions)
Floor mode payout on run end:
- +1 Amber per floor cleared.
- +1 per 10 kills (floor).
- +8 first boss kill in run; +4 repeat boss.
- +3 clean-run bonus (reached boss without being downed), once/run.
Example floor-5 run: ~8–12 Amber. Deep floor-10 run: ~18–25.
Open world:
- +12 first kill of each world boss (account flag, once).
- +3 repeat world-boss contract.
- +1–3 major event/vault; ordinary mobs do NOT drop Amber (prevents mindless grind).
- Return-to-camp banks earned Amber; death banks 50% of unbanked expedition Amber (persistent loot/gear remains — consequence without rage-quit loss).

## Camp tree: functional unlocks first, bounded stats second
**Stations / horizontal (unlimited ownership; visible town growth):**
- Weapon Rack 20A: starting weapon selection / saved loadout.
- Trinket Bench 30A: trinket management + reroll one affix.
- Shrine 35A: choose which signature-technique family is armed.
- Practice Range 20A: sandbox targets + DPS readout.
- Archive 40A: boss contracts/mastery challenges.
- Fusion Forge 75A + Jet defeated: family fusion slot (§7).

**Foundation perks / vertical (BUYABLE, but equip max 3 Foundation nodes at Camp):**
- Tempered Shot I 30A / II 60A: +5% damage each (hard cap +10%).
- Stout Heart 50A: +1 max heart (one rank only; +16.7% from base 6).
- Light Step 35A: +5% move speed (one rank).
- Quick Recovery 40A: -10% dash cooldown (one rank).
- Field Pouch 25A: start floor runs with +5 coins (economy, no combat power).
Only **3 foundation nodes can be equipped simultaneously**; damage ranks count separately. Strongest combat setup lands around ~20–27% effective permanent uplift, inside Ian's 20–30% ceiling. Players may own all nodes but must specialize at Camp. No later stat tiers.

===============================================================
# 5. PERSISTENT GEAR — sidegrades, not gear score
===============================================================
## Slots
- Primary weapon.
- Secondary weapon (unlocked by Slime King).
- Trinket A.
- Trinket B (unlocked by Marrow).
No armor treadmill. Four slots are enough to express a build and keep UI readable.

## Rarity = complexity, not raw power
- **Common:** base weapon / 1 simple trinket affix.
- **Uncommon:** 1 meaningful mechanic + 1 tradeoff (e.g. +pierce, -fire rate).
- **Rare:** signature sidegrade that changes play (ricochet refund, charge split, low-HP payoff), not just more stats.
- **Boss Relic:** unique rule tied to a boss technique; equip max 1. No "Mythic +40%" tier.
No gear-score number. Same weapon family can remain viable through endgame.

## Affix budget / caps
A trinket gets max 2 affixes; total persistent loadout may provide at most: +10% raw damage, +10% fire rate, +1 pierce, +10% status chance, or equivalent mechanical budget. Gear effects must include either a condition/tradeoff or a playstyle rule. They stack under the same run caps in §2.

## Mode semantics
- **Floor mode death/run end:** temporary blessings + found temporary weapons reset. Persistent loadout/gear/Amber/unlocks remain. New gear is banked only after boss clear or run end (never lost permanently once awarded).
- **Open-world death:** temporary 6-slot Attunement clears; respawn at Camp; persistent gear stays; bank 50% unbanked Amber. Voluntary Camp return clears temporary blessings and banks 100%.
- In floor mode, persistent loadout power is NORMALIZED by the bounded caps above; the run remains the main power arc.

===============================================================
# 6. ENDGAME / MASTERY / FUSION
===============================================================
## Family mastery (horizontal)
No mastery XP bar. Complete technique challenges (tracked as unlock flags): e.g. 5 ricochet kills in one room, detonate max banked damage, clear a boss without breaking a combo. Rewards: alternate weapon behavior, cosmetics, Camp trophies, Resonance visual variant — not +damage.

## Fusion (after Jet)
- Equip weapons/trinkets from 2 families → unlock one hand-authored **Fusion Technique** option at the Fusion Forge.
- Equip max ONE fusion. It modifies the existing universal signature-technique payload; it does NOT add another meter/currency/status.
- Start with 3 fusions only; each is a high-quality interaction of existing mechanics. Example (theme names owned by CD): Fracture + shock → detonations chain once; precision + Goldwork → Deadeye kills crystallize cover.
This is the theorycrafting endgame without combinatorial system soup.

## Difficulty growth
Boss/enemy difficulty scales through new techniques, phase combinations, speed/read pressure, elite movement variants — NOT HP sponges. Guideline: later boss effective health ≤~1.5× earlier boss after accounting for expected player power; extra challenge comes from pattern complexity. Slime King calibration target: median35–50s, legal high-roll20–25s, absolute minimum20s; derive HP from measured median/P95 DPS and forced transition time rather than freezing a permanent value.

===============================================================
# 7. COHERENCE BUDGET (hard limits)
===============================================================
This is the guardrail against "piecing together a shit ton of weird stuff."
- **Visible currencies: max 2:** Coins (temporary shops) + Amber (persistent Camp). No XP, dust, shards, souls, family tokens.
- **Combat HUD meters: max 3:** HP, combo, ONE universal Resonance meter. Weapon-local cylinder/reload is shown inside the weapon widget, not another global meter. No separate meter per family.
- **Statuses: max 4 universal named statuses in v1:** burn, chill, shock, Fracture. Future families must reuse/reskin/combine these before adding one. Never one status per family.
- **Simultaneous temporary blessings: floor target 8–10 by boss 2; open world max 6 slots.** Owned list can be long, active presentation cannot.
- **Gear slots: max 4** (2 weapons + 2 trinkets), Boss Relic consumes a trinket slot.
- **One family signature at a time; one optional fusion.** Families are content tags/playstyles on universal systems, not independent progression games.
- **Onboarding rule:** introduce ONE new system per biome: Amberwild = movement/combo/blessings; Rootbound = pack roles + shields; Sunless = statuses/sound commitment; Deep = trinkets/risk family; Gilded Archive = addons/sidegrade control; Emberreach = pressure/raid coordination. Every tutorial is playable, one sentence, and tied to an immediate reward.
- **Choice-card rule:** every item card states one verb + one number; lore is secondary. If an effect needs a paragraph, simplify it.

===============================================================
# 8. SCHEMA / CODE HOOKS
===============================================================
Convex players (current has unlocks[]): add:
```
amber: number,
equippedFoundation: string[], // max 3 validated server-side
gearInventory: string[],      // ids into static GearDef table
loadout: { primary:string, secondary?:string, trinkets:string[] },
masteryFlags: string[],
```
Boss/world first-kills remain canonical ids in `unlocks[]` (or a separate worldBossFlags table for shared open-world state).
Static code tables parallel to ITEMS/WEAPONS: `GEAR`, `CAMP_NODES`, `BOSS_UNLOCKS`. Server validates costs/prereqs/caps; clients never author Amber/unlocks.

===============================================================
# 9. STAGED BUILD ORDER (fun/effort, no bloat)
===============================================================
1. **Curve guardrails now:** tag blessings by bucket, duplicate caps, guarantee diverse 1-of-3 drafts, enforce run stat caps. Highest impact on current floor mode; no backend.
2. **Boss unlock graph:** use existing `unlocks[]`; first-kill flags unlock item/weapon pools + regions. Horizontal only.
3. **Amber + Camp stations:** add schema/mutations, earn/payout, 5 horizontal stations. Visible progression.
4. **Foundation perks:** 5 nodes, equip max 3, hard 20–30% ceiling. Do NOT add more ranks later.
5. **Persistent gear/loadout:** 2 weapons + 2 trinkets; GearDef sidegrades; mode reset rules.
6. **Open-world Attunement:** 6 temporary slots, death/Camp reset, bank rules — when open-world mode lands.
7. **Mastery + Fusion:** after Jet/endgame content exists; challenges + one fusion slot, no new currencies/meters.

## Acceptance / balance tests
- Scripted 10-floor builds across 1000 seeded drafts: median effective capability hits the targets (§2), 95th percentile ≤6× outside Resonance; raw caps never exceeded.
- New account vs fully upgraded Foundation on identical seed: room-clear time / survival advantage ≤30%; player skill still dominates.
- Every boss unlock adds an option/region, not mandatory raw damage.
- HUD audit passes the coherence budget: 2 currencies, 3 global meters, 4 statuses, 4 gear slots.

## Bottom line
The progression fantasy is not "level 1→100." It's: **learn a style during a run, keep an expressive loadout between adventures, defeat bosses to widen the world, and master/fuse families at endgame.** Temporary builds reach 4–6× through synergy spectacle; permanent stats stop at 20–30%; everything else is horizontal. Two currencies, one universal Resonance meter, four statuses (burn/chill/shock/Fracture), four gear slots. Deep enough to theorycraft, coherent enough to explain in one screen.

===============================================================
# 10. PLAYTEST-LOCKED FLOOR PURPOSE / ECONOMY / DISCOVERY CONTRACTS
===============================================================
These override older ambiguous pickup/duplicate language.

## Floor-purpose UX (normal vs boss) — always visible, never hidden in stats
Add one compact objective line under/near the main HUD:
- **Normal floor, enemies alive:** `CLEAR THE FLOOR · N ENEMIES LEFT` (N updates immediately on authoritative death).
- **Normal floor, N=0:** `FLOOR CLEAR — EXIT OPEN` (hold ≥1.2s, then may settle to a smaller persistent objective).
- **Boss floor, boss alive:** `DEFEAT THE BOSS` + the shipped boss HP bar (no generic enemy-count objective; adds are subordinate).
- **Boss dead:** `BOSS DEFEATED — EXIT OPEN`.
Exit presentation state is canonical data: `exitLocked = enemies.length>0` on normal floors; `exitLocked = bossAlive` on boss floors.
- Minimap: locked exit = dim/desaturated stair marker; open exit = bright amber/green stair marker with a 0.8s pulse. Use a stair silhouette, not a generic dot.
- World stairs: locked stairs remain visible but dark/inert (players understand where the objective leads); unlocked stairs animate between stairs_f0/f1 and show `▾ GO DOWN` only within interaction range. Walking over locked stairs does nothing.
- Objective transitions emit one semantic event (`floorClear` / `bossDefeated`) for banner+sfx+minimap pulse; server owns cleared state later. No separate quest system.

## Coins = temporary run currency; Amber = persistent
- Coins reset at run start/death in floor mode and are spent ONLY at Dealer rooms / run services. They never buy permanent stats.
- Dealer room guaranteed every 3 floors (3,6,9...), replacing one normal room; inventory: 3 pedestals + heart + reroll.
- Prices: heart6, reroll5; Common blessing8, Uncommon15, Rare28; weapon Common12 / specialized18 / signature24. Infinite reserve ammo remains universal — never sell ammo or add ammo currency. Weapon rhythm comes from fire cadence, charge, cylinder/reload, heat, etc.
- Open-world expedition coins clear on death/Camp return; Amber banks under §4 rules. One temporary currency + one persistent currency, preserving coherence budget.

## Blessing duplicates = explicit LV2/LV3 upgrades, then leave the pool
Replace `ownedItems: ItemDef[]` with `itemLevels: Map<ItemId,1|2|3>` (HUD/summary reads id+level). ItemDef gains `levels:[LevelEffect,LevelEffect,LevelEffect]` or `apply(m, levelDelta)`.
- Choice generator weights NEW items 3× an eligible upgrade, but may offer upgrades; card must display `NAME · LV2` / `LV3` + exact next-level delta. Never show a max-level item. Distinct choices by id.
- On pick: increment exactly one level; recompute PlayerMods from scratch over all itemLevels (avoids irreversible incremental math and makes respec/testing deterministic).
- Hard max Lv3; after Lv3 remove id from pool. Existing run caps (§2) still clamp totals.

### Exact level effects (cumulative result at Lv1 / Lv2 / Lv3)
- Glass Cannon: damage +60%/-2HP · +90%/-3HP · +110%/-3HP.
- Hair Trigger: fire rate +35% · +55% · +70%.
- Side Channel: after a dash or a 90-degree aim change within 0.40s, the next projectile shot fires exactly one plain ghost round along the previous aim; damage is 30%/45%/55%, or 16%/24%/30% against bosses; 1.2s internal cooldown at every level.
- Full Metal: pierce +1 · +2 · +3.
- Swift Boots: move +20% · +30% · +35%.
- Big Iron: bullet size +80%/dmg+50%/speed-22%/rate-12% · size+115%/dmg+75%/speed-30%/rate-16% · size+140%/dmg+90%/speed-35%/rate-20%.
- Vampire Fang: lifesteal **8% · 13% · 17%** (canonical sustain-reset exception; shared 1.25s proc cooldown + summon exclusions).
- Adrenaline: low-HP rate scaler +0.6 · +0.9 · +1.1.
- Berserk: low-HP damage scaler +0.6 · +0.9 · +1.1.
- Second Wind: dash cooldown ×0.65 · ×0.55 · ×0.50. Canonical dash iframe = **0.18s**, cannot refresh/overlap; Lv3 max theoretical uptime 0.18/0.35=51.4% (<55% gate).
- Thorns: 2 · 4 · 6 reflected damage.
- Coin Magnet: **Lv1 radius90, pull240px/s; Lv2 radius240, pull480px/s; Lv3 radius900, pull900px/s** (aggressive near-global pull across most visible combat space, still finite). Add `coinMagnetPull` to PlayerMods; current single COIN_MAGNET_PULL constant becomes this mod value.
- Greed: coin value ×2 · ×2.5 · ×3.
- Deadeye: crit25%/mult2.5 · crit40%/mult2.75 · crit50%/mult3.0.
- Vitality: maxHP +2 · +3 · +4 (new hearts filled when level gained).
- Incendiary / Cryo / Static: respective chance25% · 40% · 50%.
- Elementalist: all three +15% · +25% · +30%.
These levels are the duplicate policy; do not also allow raw duplicate copies.

## Weapon ownership / duplicate pickups
Current code calls `pickUpWeapon()` and consumes every pickup. Locked behavior:
- Before collection, if `ownedWeapons.includes(p.weapon)`, DO NOTHING: no pickup, no switch/equip, no sfx/particles; keep the weapon object on the floor. Optional client label on proximity: `OWNED`.
- If new: add to inventory, equip it, consume pickup as today.
- Dealer pedestals follow the same rule: owned weapon remains unpurchasable/marked OWNED; dealer rolls a replacement when stock is generated if possible.
No duplicate weapon→coins conversion; the physical choice remains available to teammates in co-op.

## Melee discovery guarantee
Persist `unlocks[]` flag `discover:melee` on first melee pickup (sword/longsword/spear).
- New account with no flag: floor 2 gets one deterministic guaranteed melee pickup in a reachable non-exit room. If not collected, floor 3 guarantees it again. Once collected, set flag and normal weighted drops resume.
- Dealer rule: until `discover:melee`, one of its 3 weapon/blessing pedestals is guaranteed melee (rotate Cutlass/Claymore/Pike deterministically); after discovery, normal stock.
- Floor 1 remains ranged-only onboarding; floor 2–3 guarantees players learn melee exists without a tutorial modal.

## Thunderbolt benchmark + charge-weapon direction
Thunderbolt is the feel benchmark for heavy ranged weapons. Lock it as a line-breaker:
- Base stats remain damage9/fireCd0.72/radius11/speed520.
- Add **innate basePierce=2** (hits up to 3 enemies baseline). Resolve `pierce=min(4, basePierce + mods.pierce)` for Thunderbolt specifically: Full Metal can extend the line to 5 total hits, never infinite-room clear.
- Raise/lock hard enemy knockback target to **18px total shove before kbResist** (current table14); player recoil/kick stays heavy. Every connect should visibly punch a line through the pack.
- This becomes the benchmark: one input → one unmistakable projectile → line pierce + hard shove + long recovery.
Charge weapons are desired and retain infinite reserve: hold→release controls local rhythm; no ammo pool. Charge state belongs to the weapon/player, server-authoritative later; tap shot stays useful, full charge changes size/damage/behavior. Do not couple charge to another currency/meter.

---
## POST-SERVER PHYSICAL CAMP / MODE GATES (canonical pointer)
Menu-on-launch is replaced AFTER authoritative Stage C by the shared walkable Amber Camp in `blobrogue_POST_SERVER_WORLD_UX_spec.md`. The Amber tree/stations in this spec become physical NPCs/buildings; unlocked characters live in Camp; floor-run/open-world selection and party formation happen at authoritative physical gates. This changes presentation, not progression math/caps. Rare Arena floors use the same currencies/rewards and add no new progression layer.

---
## WEAPON BENCHMARK POINTER
Wisp and Thunderbolt are locked blind-identifiable benchmarks in `blobrogue_WEAPONS_spec_2.md`. Infinite reserve is universal; weapon identity comes from per-weapon movement/commitment/charge/cylinder/heat constraints, never a shared ammo scarcity layer.

---
## FLOOR PURPOSE CADENCE (canonical pointer)
Floors cannot feel like filler. The authoritative 30-floor / six-region teaching→remix→prove curriculum, Dealer/Arena placement, anti-repetition deck, approved boss/Gauntlet cadence and Emberreach finale live in `blobrogue_ENCOUNTER_CURRICULUM_spec.md`. It supersedes the older ten-floor sketch. Progression math/caps in this document remain unchanged; the curriculum owns floor sequencing/content purpose.
