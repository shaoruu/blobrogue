# blobrogue — META-PROGRESSION LOOP — AUTHORITATIVE SPEC
**Owner:** game designer. **Status:** authoritative design source for the meta-progression build waves. Recommendations realized as a committed spec at the runner's request; runner integrates + slices into waves + launches builds. Coordinate: creative director (theme/naming/hook), game balancer (currency economy math + Foundation ceiling validation).
**Grounded against live code (read-only):** `convex/schema.ts` (`players.amber`, `players.masteryXp` ALREADY EXIST), `src/sim/balance.ts` (PREMIUM.amber_cache / amberPerHundredCoins 2 / amberRunCap 5 / mythicAmber 8 / `amberForRun()` ALREADY WIRED), `src/net/protocol.ts` (`amc` isAmberCacheArmed, `amw` amberWindfall on the wire), `convex/cosmeticsCore.ts` (cosmetics = achievement-only, never currency, never power — HARD LINE, locked by test/cosmetics.test.ts), `docs/specs/blobrogue_PROGRESSION_spec.md` §4 (Amber economy + Amber Camp tree + Foundation ≤20–30% already DESIGNED).

---
## 0. IMPORTANT CORRECTION TO THE BRIEF (read first)
The brief says "there is NO persistent/meta currency; step 1 is a NEW persistent currency." **That is out of date — the persistent currency already exists and is partially wired.** It's **AMBER**:
- `players.amber` is in the Convex schema (the ONE persistent currency, by design).
- It's already EARNED at run end: `amberForRun()` converts unspent Coins via the premium "amber_cache" (≤2 Amber per 100 coins, capped +5/run) + the mythic "amberWindfall" (+8). It rides the wire as `amc`/`amw`.
- The PROGRESSION spec §4 already designs the full Amber economy, the Amber Camp tree, horizontal stations, and a Foundation perk tier capped at 20–30% (equip max 3).
**So this is NOT a greenfield currency design — it's LIGHTING UP a loop whose rails are already laid.** That's much safer: we don't add a currency, we don't touch the 2-currency rule (Coins temporary / Amber persistent — still the only two), we make Amber actually WORTH earning by giving it a hub, sinks, pets, and retention. This spec supersedes nothing in PROGRESSION §4; it EXECUTES it and adds the hub/pets/retention layer the brief asks for.

Two-currency hard rule (unchanged, enforce in build): **Coins (per-run, gone at run end) + Amber (persistent) are the ONLY spendables. No XP-as-currency, no dust/shards/keys/souls.** Mastery XP stays a non-spendable ACCESS gate.

---
## 1. THE PERSISTENT CURRENCY — AMBER (execute + widen the earn)
**Name:** Amber (thematically locked — it's the world's lifeblood; the endgame is restoring the Amber Heart). CD owns any flavor naming of sub-sinks.
**Current earn is too thin to drive retention** (only leftover-coin trickle + mythic windfall). Widen it so deeper/better runs pay more, WITHOUT creating mindless grind:
- **+1 Amber per floor cleared** (the reliable spine — depth = pay; already the PROGRESSION §4 intent). A F5 run ≈ 5, a F20 run ≈ 20, a F100 clear ≈ 100.
- **Boss bounty:** +2–4 Amber per boss defeated (first-clear-of-that-boss-this-run; scales slightly with boss tier). Rewards actually beating gates, not just descending.
- **Keep the existing end-run cache** (unspent-coins trickle) + **mythic windfall** — they now read as "cash out your leftover coins into permanence," a nice sink-to-earn bridge.
- **Milestone one-time grants:** first time reaching each new region, first boss kill ever, etc. — one-time Amber injections that fund early hub unlocks so a new player feels the loop in the first 2–3 runs.
- **NO Amber from ordinary mob kills** (explicit anti-grind rule from PROGRESSION §4 — hold it). Amber comes from PROGRESS (floors/bosses/milestones), never from farming trash.
- **Banking rule (consequence without rage-loss):** returning to hub / clearing a run banks 100% earned Amber; a party wipe banks a partial share (≥50%) of unbanked Amber. Persistent unlocks/gear already earned are never lost. (Matches PROGRESSION §4 death rules.)
**Balancer owns:** exact per-floor/boss/milestone values, the wipe-bank %, and the total earn curve so that a full hub + Foundation build takes a satisfying but bounded number of runs (target: the core hub reads as reachable in ~10–20 runs, the Foundation ceiling meaningfully later). All Amber grants are computed SERVER-SIDE at run end (authoritative; clients never author Amber).

---
## 2. THE HUB — "AMBER CAMP" (the non-combat space between runs)
Ian wants "gameplay OUTSIDE of fighting" + "a place to walk around, spend, customize, talk to NPCs." The lobby already conceptually exists (Amber Camp / online lobby + kit-select shipped in #83). This turns it from a menu into a WALKABLE hub.
**What it IS:** a small, safe, top-down explorable camp you spawn into between runs — same movement/camera as the game, no enemies. In co-op, your party shares the camp (you see each other walk around) — this is a huge social/retention hook (people hang out, show off pets/cosmetics, ready up together).
**What you DO there (each is a "station" — horizontal, visible town growth per PROGRESSION §4):**
- **The Descent Gate** — start/continue a run; pick floor/region entry (whatever the run-select model is), ready-up in co-op. The camp's purpose anchor.
- **The Foundation Shrine** — spend Amber on the capped permanent Foundation perks (see §4). Equip max 3.
- **The Kennel** — adopt + manage PETS (see §3). Ian's doggie lives here.
- **The Wardrobe** — equip cosmetics. ⚠ ACHIEVEMENT-UNLOCKED ONLY, never bought with Amber (see §6 hard line). This is a "look at what I earned" station, NOT a shop.
- **The Workshop / Quartermaster** — manage the persistent loadout (weapons + trinkets as SIDEGRADES, per PROGRESSION §5). Not a power-shop; a specialization bench.
- **The Board** — dailies / weekly challenges / goals (see §5). The "what do I do today" anchor.
- **NPCs** — a few flavor characters who give the camp life + deliver goals/lore/tutorial one-liners (CD owns who they are). At least one is the goals-giver (the Board's voice); one runs the Kennel. NPCs are pure presentation + quest-delivery, NOT vendors of power.
- **Visible growth:** as you spend Amber, the camp visibly upgrades (a ruined camp slowly restored — ties to the Amber Heart restoration endgame). Every purchase should CHANGE something you can walk past and see. This is the single strongest "keep playing" feel — your progress is a place, not a number.
**Determinism note:** the hub is NON-COMBAT and can be largely client-side/cosmetic, BUT anything that grants/spends Amber, unlocks, or equips loadout MUST be a server-authoritative Convex mutation (clients never author Amber/unlocks — same trust level as recordRun). Co-op camp presence (seeing teammates walk) can reuse the presence/lobby system; it does NOT need the authoritative sim tick (no combat), so keep it cheap — position sync at low rate, no hit registration. Do NOT run the combat sim in the hub.

---
## 3. PETS — the two-mode system (Ian's headline: cute AND sometimes combat)
**The fantasy:** a small companion that's ALWAYS with you — sits next to you when idle, trots to keep near you when you move, follows you into battle. Ian wants BOTH a pure-cute companion (the doggie) AND pets that can "sometimes help fighting." The bridge below satisfies both WITHOUT touching the ≤30% permanent-power ceiling: **every pet has two modes, and combat is a horizontal CHOICE that spends budget, never free additive power.** (Thematically, per the CD's "Remembering" frame, a pet is *a memory that refused to be unmade* — you RESCUE it, never buy it.)

### 3.1 THE TWO MODES (the bridge — protects the capped ceiling)
- **COMPANION mode — default, always free, cosmetic.** Pure companionship: follows / sits / runs, reacts, emotes. ZERO gameplay power and OUT of the authoritative sim (see determinism). This is every pet's default and it's ALWAYS available at no cost — you can always bring any pet along as just a cute buddy.
- **COMBAT mode — optional, gated, costs budget.** Running a combat-capable pet in combat mode **consumes one of the equip-max-3 permanent-power (Foundation) slots** — you bring the attack-dog INSTEAD of a damage perk. It is NOT extra power; it's a different allocation of the same capped budget, so the same-seed ≤30% ceiling is untouched. A combat pet in the sim is a server-authoritative entity whose attacks are SimEvents.
- **Same pet, both modes — nobody is ever forced to pay to keep their buddy.** A combat-capable pet can always be run in free companion mode; you only spend the slot on the runs where you want it to actually fight. Combat is opt-in per run, decided at the Heart/loadout before a dive (never mid-run).

### 3.2 v1 = THE DOGGIE (companion mode, SHIPS FIRST)
The base companion ships first and is the emotional anchor. Behavior (the whole point — get this feel right):
- **Idle:** when you stand still, the dog sits/lies down beside you (small offset), occasional idle animation (tail wag, look around, scratch). Cozy.
- **Move:** when you move, it trots to keep near you at a comfortable distance with a little lag/catch-up so it feels alive (not glued to a fixed offset). If it falls too far behind (you dashed/teleported), it scampers / warps-with-a-puff to catch up. Never blocks or collides with you.
- **Battle (companion mode):** it follows you into combat and stays near — reacts to danger (flinch, bark at a nearby enemy) but deals/takes no damage and enemies ignore it entirely (not a sim combat entity). Emotionally it "fights beside you"; mechanically it's pure presence. Dead-simple, un-exploitable, ships fast.
- **Unlock = RESCUED, never bought.** The first pup is a discovery/achievement rescue deep in the Sump (per the Remembering frame), NOT an Amber purchase. Tuned reachable early (first few runs) so the loop lands immediately. (This supersedes the earlier draft's "Amber-purchasable pet" line — pets are rescued/earned only, keeping them clear of any pay-for-advantage read.)

### 3.3 COMBAT-CAPABLE PETS (later gated tier)
- **Server-authoritative sim entity.** In combat mode the pet is a real sim actor: its spawn, targeting, and attacks are SimEvents computed on the server — NEVER client-authored. Deterministic; part of the snapshot.
- **Costs one Foundation slot** (opportunity cost — bring the attack-dog instead of a damage perk). Balancer (dc9dfebf) owns the EXACT slot cost.
- **Balance-integrity rule (the important one, flagged to balancer):** the combat pet's TOTAL effective contribution must be ≤ the value of the slot(s) it consumes, so it's a genuine reallocation, not a sneaky net gain. Since 3 slots ≈ 20–27% total, one slot ≈ ~7–9%; the pet's combat value must sit at/under one slot's worth. If the pet is worth more than a slot, either raise its slot cost or lower its output — pet-value ≤ slot-value is the invariant.
- **Double-gated:** a combat pet counts against BOTH the shipped combat pet-DPS caps (owner ≤12% sustained, party ≤25%) AND the ≤30% permanent ceiling (via the slot). Two independent firewalls.
- **Shipped pet guardrails (all hold):** one active pet per player; companion-not-a-second-gun; no body-block, no aggro-hold, no loot pickup, no boss-phase trigger; collapses to a quiet presence under 4-player/boss clutter so it never masks an enemy telegraph (Gate 2 density controller).
- **My design lean on WHAT it does:** favor ONE legible, owner-colored action over raw DPS — e.g. an occasional bite/pounce on YOUR current target, or the on-theme "nose out a hidden memory-room" utility, on a readable cadence. A pet that does one clear helpful thing reads as delightful; a pet spraying continuous damage reads as a second gun (and fights the caps). Balancer sets the exact numbers.
- **Horizontal only:** tricks, looks, more rescued friends. NO pet XP, NO pet rarity, NO pet power ladder, NO pet currency, NO per-pet upgrade tree. A "stronger" pet is never a thing; a *different* rescued friend is.

### 3.4 DETERMINISM / CO-OP (per mode)
- **Companion mode:** out of the sim entirely — a client-side cosmetic companion (equippedPet id on the player wire, same channel as hat/face). Nothing gameplay branches on it; it literally cannot desync a run because the sim doesn't know it exists.
- **Combat mode:** in the sim — server-authoritative spawn/targeting/attacks as SimEvents, deterministic, counts against pet caps + the slot budget, and gets golden-master coverage under P=1..4 + reconnect + same-seed replay (same bar as any sim actor). If it deals damage, it's a sim citizen with all the same rules; there is no middle "client pet that touches combat" state.

### 3.5 DELIGHT (make it genuinely lovable, not an afterthought)
- The pup **waits for you at the Amber Heart between runs**, greets you on return, and gets more animated as the camp warms (your "living bookmark" of progress).
- Reacts to your ults / big moments; barks (emote); little idle personality.
- The **Kennel holds a growing COLLECTION** of rescued friends (cat, floaty amber-wisp, tiny slime, …), each with its own where/how-you-found-it story — collecting them is a retention hook (§5) and the warmest expression of "winning against the dark."
- Each new pet reuses the same follow/sit/run rig + (for combat-capable ones) the same sim-actor rig; new art + idle animations per pet.

### 3.6 PET ABILITY ROSTER (each pet its OWN on-theme ability — inspired by Soul Knight's ability-per-pet, NOT ported)
Ian's reference: Soul Knight pets (tiny, chunky, big-head, big expressive eyes, tons of personality) each have a special ability. We take the PRINCIPLE (every pet does one distinct, legible thing) and make all of them native to the amber/memory world — none is a copy of a Soul Knight ability or of each other. Because it's **one active pet per player per run**, a pet's ability is a genuine CHOICE, so collecting pets = collecting options (horizontal). That's the reason the collection exists beyond looks.

**Classification is locked to the balance frame:** a **utility** ability is FREE / companion-mode (non-combat: info, convenience, navigation — never alters drops or combat). A **combat** ability (deals damage / mitigation) is **slot-mode**: it consumes the permanent-power slot (Foundation/Heartwork) and obeys the balancer's final numbers (owner ≤8% sustained, delivered as ONE legible action, pet-value ≤ marginal-slot-value). Abilities differ by SHAPE, never by a bigger number.

**UTILITY pets (free, companion-mode — pure convenience/info, no slot):**
- **Amber Pup (dog) — WARMSCENT:** sniffs out a hidden room / buried amber cache on the current floor (points toward already-authored secrets; on-theme with the memory-nose the CD locked as the v2 utility default). The canonical starter ability.
- **Hearth Cat (cat) — PAWBACK:** every so often bats an out-of-reach dropped pickup (coin/heart) toward you. Moves loot that already exists; never creates or increases drops.
- **Lantern-Finch (bird) — SCOUT:** briefly reveals the NEXT room's layout on the minimap before you enter. Pure information, readable cadence.
- **Amber Wisp (floaty mote) — WAYGLOW:** pings the direction to the floor's exit / nearest unopened secret. Cozy navigation, zero combat.
- **Pocket Slime (tiny slime) — GLIMMER-SENSE:** briefly highlights nearby coin/amber-cache pickups through walls (a collector's nose — distinct from the Pup, which finds ROOMS, and the Cat, which physically MOVES a pickup). Reveal only.

**COMBAT pets (slot-mode, ≤8% owner per balancer — differ by target-selection SHAPE, same cap):**
- **Ember Fox (fox) — AMBERBITE:** darts in for one amber-fanged pounce on YOUR CURRENT target on a readable cadence (the balancer's ~one bite / 3.5s ≈ 7.6 dmg @ F20 ref). Focus-fire flavor; the canonical combat pet.
- **Cinder Sprite (drifting ember) — MOTEFALL:** lobs one small amber mote at the NEAREST enemy (not necessarily your target) on the same cadence — identical damage budget, add-clearing flavor instead of focus. Same ≤8% cap, different feel.

**Guardrails (all hold):** free utilities stay pure convenience/info — if any ever reads as power (e.g. a reveal that trivializes a mutator), it gets a cooldown or is reclassed; it never touches drops or combat. Combat abilities are the ONLY slot-spenders and are double-gated (≤8% owner / party ≤18% AND ≤ marginal slot value), one legible action, collapse to quiet presence under 4p/boss clutter (Gate 2). Horizontal only — a pet is never a STRONGER pet, only a DIFFERENT rescued friend with a different ability; no pet XP / rarity / power ladder / per-pet upgrade tree.

**Flags for the disciplines:** ⚠ if we ever want a DEFENSIVE combat pet (e.g. a Gilded Beetle that periodically pops a tiny 1-hit ward), that's MITIGATION, not DPS — it still costs the slot but needs its OWN balancer-set mitigation budget (do NOT fold it under the 8% DPS number). I'm holding the combat roster to offense-only until the balancer defines a mitigation cap. CD owns final names/flavor + which pets ship in which collection wave; AD owns the chunky big-eyes personality art per pet; balancer owns every combat number + validating utilities stay non-power.

**Coordinate:** balancer (dc9dfebf) owns the exact Foundation-slot cost for combat mode + the pet-value≤slot-value tuning + pet-cap validation; CD owns pet flavor/naming + the rescue fiction; AD owns pet art + idle language. I own the two-mode structure, the companion feel, and the horizontal-only guardrail.

---
## 4. THE UNLOCK / UPGRADE TREE — horizontal-first, permanent-power hard-capped
This is the classic trap and where the brief explicitly wants my call. **Rule: the run is the power arc; the meta is OPTIONS, CONVENIENCE, and a HARD-CAPPED sliver of permanent power.** Four categories, in order of how much Amber they should absorb:
**(A) HORIZONTAL UNLOCKS (the bulk of the tree — unlimited ownership, zero balance risk):**
- **New kits** (already gated by Mastery XP — access, not power).
- **New starting weapon options / persistent loadout sidegrades** (PROGRESSION §5 — sidegrades, not gear score; a trinket adds a playstyle rule + a tradeoff, capped mechanical budget).
- **New pets** (§3).
- **Cosmetics** stay ACHIEVEMENT-only (§6) — NOT bought here.
- **Camp stations themselves** (unlocking/upgrading a station is horizontal town growth).
- **Run modifiers you TOGGLE** (see D).
**(B) CONVENIENCE / QUALITY-OF-LIFE (Amber sinks that don't touch power):**
- Reroll/curate the in-run shop or blessing offers slightly (bounded — never guarantees).
- Stash/loadout slots, a starting-blessing PICK (choose which starter blessing you begin with — sideways, not stronger), faster hub navigation, a "resume region" convenience.
- These are great Amber sinks precisely because they add no power — spend freely, balance-safe.
**(C) FOUNDATION PERKS (the ONLY permanent power — HARD-CAPPED, already specced):**
- Per PROGRESSION §4: a small set of Foundation nodes, **equip MAX 3 at once**, strongest legal combined permanent uplift **20–27%, hard ceiling <30%**. Own many, equip 3 → you SPECIALIZE, you don't stack everything.
- **No stat treadmill, no later tiers.** Do NOT add rank 2/3/4 over time — that's the power-creep death spiral. The ceiling is permanent and final. Balancer VALIDATES: new account vs fully-upgraded Foundation on an identical seed → room-clear/survival advantage ≤30%; player skill still dominates. (PROGRESSION §198.)
- This is the one vertical thing, and it's small on purpose. Everything aspirational and big is horizontal.
**(D) RUN MODIFIERS / "ASCENSION" TOGGLES (replayability without power creep — points UP in difficulty):**
- Unlockable toggles you CHOOSE before a run that change/harden it for better rewards (more Amber, cosmetic unlocks, leaderboard flags): heat/ascension levels (tougher enemies), mutator-forced runs, "no-hub-purchase" purist runs, daily-seed runs.
- These add depth by making runs HARDER/DIFFERENT, never by making the player permanently stronger. This is where long-term "mastery" lives (Hades' Heat / StS Ascension model) and it's the healthiest retention engine for a roguelike.
**Anti-power-creep guardrails (enforce in build + balancer sign-off):**
- Permanent power lives ONLY in (C), capped <30%, equip-3, no new ranks ever.
- (A)(B)(D) are the growth surface and are balance-safe by construction (options/convenience/harder-not-stronger).
- Every permanent-power node counts against the existing raw caps (damage 2.25×/fire 1.8×/move 1.35×/+4 hearts/pierce 3/status 50%) — Foundation is a FASTER route to a cap, never a higher cap, same law as the coin-sink premium items.
- Determinism: all costs/prereqs/caps validated server-side (Convex mutations); clients never author Amber/unlocks/equipped-Foundation. Foundation effects feed the sim as authoritative player mods at run START (baked into the seed-locked run state), never mutated mid-run.

---
## 5. RETENTION HOOKS — "one more run"
Layered so there's always a reason to start again:
- **DAILIES (the Board):** 2–3 daily goals ("clear F10", "kill a boss with the Mender", "300 kills") → Amber + progress toward collection. Resets daily. The core habit loop. + a **DAILY SEED run** (everyone plays the same seed; leaderboard for the day) — competitive parity, ties to the shipped normalized boards.
- **WEEKLY CHALLENGE:** a bigger modified run (forced mutators/ascension) for a chunk of Amber + a cosmetic/title. The "come back this week" hook.
- **GOALS / ACHIEVEMENTS (long tail):** the achievement system already drives COSMETIC unlocks (§6) — surface a visible goals list ("beat the Weaver without taking damage" → a hat). This is the cosmetic earn engine; make it legible in the hub so people chase specific looks.
- **COLLECTION:** pets (§3), cosmetics, bestiary (enemies encountered), weapon codex, boss-kill log. "Gotta catch 'em all" completionism. A bestiary/codex that fills in as you play is cheap to build and a strong long-tail hook.
- **ASCENSION / HEAT (§4D):** the skill-expression long game — climb difficulty tiers, each a fresh mountain. This is what keeps the hardcore playing for hundreds of hours.
- **PRESTIGE (optional, LATE):** once Foundation is maxed + high ascension cleared, an optional prestige that grants COSMETIC/TITLE prestige markers (never power) — a visible "I've done everything" flex. Keep it cosmetic to avoid reset-the-grind resentment. Defer; design later.
- **THE CAMP ITSELF:** the visibly-restoring hub (§2) is a passive retention hook — every session your place looks a little more alive. Ties the whole loop to the Amber Heart restoration narrative payoff.

---
## 6. HARD LINES / RISK FLAGS (call out before any build)
1. **COSMETIC NO-PAY-FOR-POWER LINE (do NOT cross):** per `convex/cosmeticsCore.ts` (locked by test/cosmetics.test.ts), cosmetics are TROPHIES YOU WEAR — achievement-unlocked, NEVER currency, NEVER power, NEVER random drops, and `src/sim` may not import the catalog. **Amber must NOT buy cosmetics.** The Wardrobe is an equip station for EARNED items, not a shop. The only things Amber buys: Foundation perks (capped power), convenience/QoL, and horizontal unlocks / run-modifier toggles. (Pets are RESCUED/earned, never bought — see §3.) If any wave proposes "buy a hat with Amber," reject it — it breaks a tested contract and the game's whole cosmetic ethos.
2. **TWO-CURRENCY LINE:** Coins (per-run) + Amber (persistent) remain the ONLY spendables. Mastery XP stays non-spendable access. No new currency (the brief's "new currency" is unnecessary — Amber already exists).
3. **PERMANENT POWER CAP:** Foundation <30%, equip-3, NO new ranks ever. Balancer validates ≤30% identical-seed advantage. This is THE anti-power-creep firewall.
4. **PETS — TWO MODES, DETERMINISM PER MODE (see §3):** COMPANION mode (every pet's default, and the v1 doggie) is a client-side cosmetic companion — zero combat, not a sim entity, nothing gameplay branches on it, so it literally cannot desync a co-op run. COMBAT mode (later gated tier) is a full server-authoritative sim actor: attacks are SimEvents, deterministic, golden-mastered under P=1..4 + reconnect + replay, and DOUBLE-gated — it counts against both the combat pet-DPS caps (owner ≤8% sustained / party ≤18%, the invariant measured vs the MARGINAL equipped Foundation node — the weakest displaced slot, computed server-side, not a constant) AND the ≤30% ceiling by consuming a Foundation slot (pet-value ≤ marginal-slot-value). There is no middle 'client pet that touches combat' state. Pets are RESCUED/earned, never bought.
5. **HUB IS NON-COMBAT:** don't run the authoritative combat sim in the camp; reuse presence/lobby for co-op walk-around at a low sync rate. All Amber/unlock/equip actions are server-authoritative Convex mutations (clients never author).
6. **AMBER EARN = PROGRESS, NOT GRIND:** floors/bosses/milestones pay; trash mobs never drop Amber. Protects against mindless farming and keeps the currency tied to skill/depth.

---
## 7. WHAT SHIPS FIRST → BUILD WAVES
Ian wants the DOGGIE early, and the loop needs a spendable-Amber reason to exist. Sequenced so each wave is playable + adds a visible hook:

**WAVE 1 — "The loop turns + the doggie" (ship first, highest emotional ROI):**
1. **Widen Amber earn** (§1: +1/floor, boss bounty, milestone grants) — makes Amber actually accumulate. (Small; mostly server-side recordRun math — balancer sets values.)
2. **Amber balance visible** in the hub/HUD (you can SEE it grow — prerequisite for wanting to spend it).
3. **THE KENNEL + THE DOGGIE** (§3): the pet system (client-side companion rig: follow/sit/run), the doggie as pet #1 in COMPANION mode, RESCUED early (discovery/achievement, not bought) so it lands in the first few runs. Ian's headline — and because companion mode is out-of-sim cosmetic, it's low-risk to build fast. (Combat mode is a later gated tier, §3.3 — not Wave 1.)
4. **A first real Amber SINK** so earning matters day one — recommend shipping the Kennel (doggie) + 2–3 CONVENIENCE unlocks (§4B) as the launch sinks (balance-safe, no power).
→ After Wave 1 a player: finishes a run, earns Amber, walks to the Kennel, adopts a dog that follows them. The loop is REAL and lovable with zero balance risk.

**WAVE 2 — "The camp becomes a place":**
5. **Walkable Amber Camp hub** (§2): turn the lobby into an explorable space, co-op shared presence, the station anchors (Descent Gate, Kennel, Board), 1–2 NPCs, visible camp growth on spend.
6. **The Board + DAILIES** (§5): daily goals + Amber payout — the habit loop.

**WAVE 3 — "Depth + permanence":**
7. **Foundation Shrine + Foundation perks** (§4C, PROGRESSION §4): the capped permanent-power tier + balancer's ≤30% validation. (Gate carefully — this is the only power lever.)
8. **Persistent loadout / Workshop** (§4A + PROGRESSION §5): weapon/trinket sidegrades.
9. **Wardrobe station** surfacing the existing achievement cosmetics in the walkable hub (equip-only, no purchase).

**WAVE 4 — "The long game":**
10. **Ascension / Heat toggles** (§4D) — replayability without power creep.
11. **Weekly challenge + daily-seed leaderboard runs** (§5).
12. **Collection systems** (bestiary/codex/pet-collection) + **more pets**.
13. **Prestige** (cosmetic-only, §5) — last.

**Coordinate:** CD owns camp/NPC/pet theme + naming + the restoration hook narrative; balancer owns the Amber earn curve, sink pricing, and the Foundation ≤30% validation. I own the loop structure, the pet behavior/feel, the horizontal-vs-vertical split, and the anti-power-creep firewall above.

**Net:** we don't invent a currency — we LIGHT UP Amber (already in the schema + earning) with a walkable camp, an early lovable doggie, a mostly-horizontal unlock tree with one small hard-capped power tier, and a layered retention stack — all without crossing the cosmetic no-pay-for-power line or risking co-op determinism (the pet lives outside the sim). Doggie ships in Wave 1.

---

# 11. HEART BLOOM — CANONICAL TIER COUNT (wave 2, lock this number)

The Amber Heart / camp bloom is a **6-tier** system: `heartTier` **0–5** (single server-authoritative signal both the visual bloom and the audio stems read; client renders, never authors). Final table:

- **T0 Dormant** — music-box skeleton
- **T1 Ember** — +strings
- **T2 Warm** — +heartbeat
- **T3 Bright** — +dulcimer
- **T4 Radiant** — +low foundation = full motif COMPLETE
- **T5 Whole** — holds + swells, NO new stem (the F100 capstone: the complete known theme returning, never a new instrument)

Rules: motif finishes assembling at **T4**; T5 adds no stem. Bloom+swell renders on a tier-change tick only if the client is present in camp (else the scene loads already-assembled) — presence-at-increment, co-op per-observer. One action crossing multiple tiers = one grand swell; separate actions serialize. Continuous micro-warming on raw Warmth may play between the 6 discrete tier events. Bloom is COSMETIC / zero combat power (hard rule).

**ANY earlier reference to "7 tiers" or "T6" is STALE (the collapse dropped the old "Flicker" stage). The balancer sets Warmth→tier thresholds for SIX steps (0–5), not seven.** Tiebreaker source of truth for the full bloom design: the CD's META_LOOP packet. Pacing guardrail (CD): no INTERMEDIATE tier may be hard-gated behind a boss — reclaim-alone always inches the camp forward; only the final T5 Whole is deed-gated (the two Null keystones / F100).
