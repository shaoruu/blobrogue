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
- RAW stat caps inside a run: damageMult ≤2.25× from blessings (excluding conditional crit/Resonance), fire rate ≤1.8×, move ≤1.35×, max HP bonus ≤+4 hearts, pierce ≤3, status chance per element ≤50%. The rest of the 4–6× comes from mechanics: more targets hit, crit timing, freeze/shock amps, Fracture bank/snap, positioning, and signature technique.
This prevents "numbers soup" while still letting a build feel outrageous.

## Pick cadence (floor mode)
- Start with persistent loadout (bounded in §5), no temporary blessing.
- Every non-boss descent: **1-of-3 blessing** (current flow already does this).
- Boss defeat: **1-of-3 Rare/Boss blessing** + weapon choice; no normal blessing that floor.
- By floor 5: ~4 picks → 2.25–3×. By floor 10: ~8–9 picks → 4–6× with synergy.
- Duplicate common blessings allowed max 2 copies; uncommon max 2; rare unique. This keeps stacking legible and prevents Hair Trigger / Split Shot spam from breaking caps.

## Pick cadence (open-world mode)
There is no run end, so define an **Expedition Attunement** without adding a new currency or meter:
- Blessings found at shrines/events fill max **6 temporary blessing slots**.
- They last until DEATH or voluntary RETURN TO CAMP; returning banks loot and clears attunement. This preserves the same "build an identity, risk going farther" arc without pretending the world is a floor run.
- World bosses grant one temporary Boss blessing for the current expedition plus a permanent first-kill unlock (§4).
- Persistent gear stays; temporary blessings reset. Same item definitions/math in both modes, only reset boundary differs.

## Current blessing tuning roles (`items.ts`)
Keep each pick in one of four readable buckets (tag ItemDef; used by draft weighting):
- **Output:** Hair Trigger, Big Iron, Deadeye, Split/Scatter, Full Metal, elemental coatings.
- **Survival/mobility:** Vitality, Swift Boots, Second Wind, Fang.
- **Economy:** Greed, Coin Magnet (never offered in boss reward).
- **Risk/identity:** Glass Cannon, Berserk, Adrenaline, Elementalist.
Draft rule: every 1-of-3 guarantees at least 2 different buckets; never show 3 economy/small-stat cards. This is coherence in the choice UI.

===============================================================
# 3. BOSS → UNLOCK GRAPH (horizontal first)
===============================================================
Boss first-kills unlock OPTIONS/REGIONS, not +damage. Store in existing `players.unlocks[]` (or shared-world boss flags for open world); one canonical unlock id per node.

**Start (no boss):** Verdant Hollow / floors 1–5; core weapons; 8 starter blessings; 1 primary weapon + 1 trinket slot; basic Camp.

**The Slime King (First of the Fallen):**
- Unlock Sunless Caves / next floor-biome band.
- Unlock SECOND weapon slot (weapon swap; horizontal versatility, not passive DPS).
- Add status blessings (burn/chill/shock) to pool.

**Marrow:**
- Unlock The Deep region/band.
- Unlock second trinket slot.
- Unlock The Hollow family (final CD name), including Fracture bank/snap + low-HP sidegrades.

**The Weaver:**
- Unlock advanced mobility/precision gear and the first family mastery challenges.
- Unlock Rare blessing pool expansion (not higher base rarity chance — more options).

**Jet:**
- Unlock family FUSIONS/endgame mastery (§7), not a raw-stat tier.
- Unlock adaptive/challenge variants (bosses borrow one equipped-family technique).

**The Hollow Choir:**
- Unlock Emberreach endgame events + Choir family gear.
- Unlock repeatable boss contracts / mastery cosmetics.

**The Gilded Warden (optional branch):**
- Unlock Goldwork/deployable family + Camp construction cosmetics/functions.

Floor mode: bosses at floor milestones set account unlocks after the run. Open world: defeating the arena boss opens the next biome gate immediately and persists the world flag. Same graph, different presentation.

===============================================================
# 4. AMBER ECONOMY + BLOB CAMP TREE
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
Boss/enemy difficulty scales through new techniques, phase combinations, speed/read pressure, elite movement variants — NOT HP sponges. Guideline: later boss effective health ≤~1.5× earlier boss after accounting for expected player power; extra challenge comes from pattern complexity.

===============================================================
# 7. COHERENCE BUDGET (hard limits)
===============================================================
This is the guardrail against "piecing together a shit ton of weird stuff."
- **Visible currencies: max 2:** Coins (temporary shops) + Amber (persistent Camp). No XP, dust, shards, souls, family tokens.
- **Combat HUD meters: max 3:** HP, combo, ONE universal Resonance meter. Weapon-local cylinder/reload is shown inside the weapon widget, not another global meter. No separate meter per family.
- **Statuses: max 4 universal named statuses in v1:** burn, chill, shock, bank/detonate. Future families must reuse/reskin/combine these before adding one. Never one status per family.
- **Simultaneous temporary blessings: floor target 8–10 by boss 2; open world max 6 slots.** Owned list can be long, active presentation cannot.
- **Gear slots: max 4** (2 weapons + 2 trinkets), Boss Relic consumes a trinket slot.
- **One family signature at a time; one optional fusion.** Families are content tags/playstyles on universal systems, not independent progression games.
- **Onboarding rule:** introduce ONE new system per biome: Verdant = movement/combo/blessings; Sunless = statuses + weapon swap; Deep = trinkets/risk family; Emberreach = mastery/fusion. Every tutorial is playable, one sentence, and tied to an immediate reward.
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
