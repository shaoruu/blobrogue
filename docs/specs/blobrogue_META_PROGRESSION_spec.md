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
## 3. PETS — the doggie first (Ian's headline ask, SHIPS EARLY)
**The fantasy:** a cute tiny companion that's ALWAYS with you — sits next to you when idle, trots to you when you move, follows you into battle. Pure companionship first; a whisper of utility later (tightly capped).
**v1 = THE DOGGIE. Behavior (the whole point — get this feel right):**
- **Idle:** when you stand still, the dog sits/lies down next to you (small offset), occasional idle animation (tail wag, look around, scratch). Cozy.
- **Move:** when you move, the dog trots to keep near you — follows at a comfortable distance with a little lag/catch-up so it feels alive (not glued to a fixed offset). If it falls too far behind (you dashed / teleported), it scampers/warps-with-a-puff to catch up. Never blocks you, never collides with you.
- **Battle:** it follows you into combat and stays near — reacts to danger (flinch, bark at a nearby enemy) but by default is a PURE companion: **it cannot die, cannot take damage, cannot deal damage, cannot block, and enemies ignore it entirely** (it's not a sim combat entity — see determinism). This keeps v1 dead-simple and un-exploitable.
- **Cosmetic expression:** it can bark (emote), and it reacts to your ults / big moments. Little touches = the retention magic.
**Unlock:** the FIRST pet (doggie) should be **cheap + early** — Ian wants it early, and a companion is the best possible "the meta loop exists!" first taste. Recommend: a small Amber cost at the Kennel available from your first hub visit (or a first-few-runs milestone grant that funds it). Not free-at-spawn (earning it is the hook), but reachable in run 1–2.
**Pure companion vs utility (my call, per the brief):**
- **v1: PURE COMPANION. Zero gameplay power.** No stat, no pickup-magnet, no combat. This is the safe, ships-first version and it's genuinely what makes the doggie lovable — resist bolting power on. It sidesteps every balance + determinism risk.
- **v2 (optional, tightly capped): a WHISPER of NON-POWER utility** — e.g. the dog trots over and "sniffs out" a already-existing pickup (visual ping toward loot already on the floor), or fetches a coin that dropped just out of reach. Convenience/juice, NOT power: it must never increase drops, never fight, never tank. If any proposed pet utility touches combat DPS/survivability, it's rejected — pets are NOT the pet-summoner kit (Broodmother, deferred), and must NEVER count against or interact with the combat pet-DPS caps because they deal no damage at all.
**Room for more pets:** the Kennel + pet system is built to hold a COLLECTION (cat, a floaty amber-wisp, a tiny slime, etc.). Later pets are: (a) achievement/collection unlocks OR (b) Amber-purchasable at the Kennel — pets are the ONE thing beyond Foundation that Amber can buy, because they're companionship, not power (keeps a meaningful Amber sink alive long-term). Each new pet = same follow/sit/run rig, new art + idle animations. Collection itself becomes a retention hook (§5).
**⚠ Determinism / co-op:** because the v1 pet has ZERO combat interaction, it does NOT need to be in the authoritative sim — it's a CLIENT-SIDE cosmetic companion (like a hat that walks). Each client renders their own + teammates' pets from a cosmetic "equippedPet" id on the player wire (same channel as hat/face labels). **Nothing gameplay branches on a pet.** This is the safe architecture: a pet can never desync a run because the sim doesn't know it exists. If v2 utility is ever added, re-evaluate — but keep it out of the sim as long as it's non-power (a loot PING is a client hint toward server-authoritative loot that already exists, not a sim actor).

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
1. **COSMETIC NO-PAY-FOR-POWER LINE (do NOT cross):** per `convex/cosmeticsCore.ts` (locked by test/cosmetics.test.ts), cosmetics are TROPHIES YOU WEAR — achievement-unlocked, NEVER currency, NEVER power, NEVER random drops, and `src/sim` may not import the catalog. **Amber must NOT buy cosmetics.** The Wardrobe is an equip station for EARNED items, not a shop. The only things Amber buys: Foundation perks (capped power), pets (companionship), convenience/QoL, horizontal unlocks, run-modifier toggles. If any wave proposes "buy a hat with Amber," reject it — it breaks a tested contract and the game's whole cosmetic ethos.
2. **TWO-CURRENCY LINE:** Coins (per-run) + Amber (persistent) remain the ONLY spendables. Mastery XP stays non-spendable access. No new currency (the brief's "new currency" is unnecessary — Amber already exists).
3. **PERMANENT POWER CAP:** Foundation <30%, equip-3, NO new ranks ever. Balancer validates ≤30% identical-seed advantage. This is THE anti-power-creep firewall.
4. **PETS OUT OF THE SIM (determinism):** v1 pet is a client-side cosmetic companion — zero combat interaction, not a sim entity, nothing gameplay branches on it. It literally cannot desync a co-op run because the authoritative sim doesn't know it exists. Any future pet utility stays non-power + preferably out of the sim (a loot PING toward already-authoritative loot, not a sim actor). Pets never touch the combat pet-DPS caps (they deal no damage).
5. **HUB IS NON-COMBAT:** don't run the authoritative combat sim in the camp; reuse presence/lobby for co-op walk-around at a low sync rate. All Amber/unlock/equip actions are server-authoritative Convex mutations (clients never author).
6. **AMBER EARN = PROGRESS, NOT GRIND:** floors/bosses/milestones pay; trash mobs never drop Amber. Protects against mindless farming and keeps the currency tied to skill/depth.

---
## 7. WHAT SHIPS FIRST → BUILD WAVES
Ian wants the DOGGIE early, and the loop needs a spendable-Amber reason to exist. Sequenced so each wave is playable + adds a visible hook:

**WAVE 1 — "The loop turns + the doggie" (ship first, highest emotional ROI):**
1. **Widen Amber earn** (§1: +1/floor, boss bounty, milestone grants) — makes Amber actually accumulate. (Small; mostly server-side recordRun math — balancer sets values.)
2. **Amber balance visible** in the hub/HUD (you can SEE it grow — prerequisite for wanting to spend it).
3. **THE KENNEL + THE DOGGIE** (§3): the pet system (client-side companion rig: follow/sit/run), the doggie as pet #1, unlockable cheap/early with Amber. Ian's headline — and because the pet is out-of-sim cosmetic, it's low-risk to build fast.
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
