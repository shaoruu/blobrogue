# blobrogue — KIT / CLASS + XP SYSTEM — v1 AUTHORITATIVE SPEC
**Owner:** game designer. **Status:** authoritative source for the v1 build. Recommendations realized as a committed spec at the runner's request; the runner integrates + launches the build. **Non-canonical for anything outside this file** — does not modify any other spec.
**Grounded against live code (read-only):** `src/sim/balance.ts` (baseMaxHp 6, moveSpeed 200, postHitInvuln 0.80s, dashIframe 0.18s), `src/net/protocol.ts` (PROTOCOL_VERSION 17, TICK_HZ 20 → FIXED_DT 50ms). All second-values below are quantized to the 50ms tick at build time.

## 0. Design thesis
Kits give co-op a class/ultimate fantasy (healer, tank, DPS, mobility) WITHOUT breaking the shipped systems. A kit is: one starting weapon + one stat lean + one passive + one ultimate. XP is an ACCOUNT MASTERY track that gates ACCESS (which kits/cosmetics you can pick), never spendable power. No third currency, no new in-run level layer, no raised caps. Every cross-player effect is server-authoritative + deterministic.

## 1. NON-NEGOTIABLE COHERENCE CONSTRAINTS (do not violate in the build)
- **Currencies unchanged:** Coins (per-run) and Amber (persistent) remain the ONLY spendables. Mastery XP is NOT spendable.
- **No parallel in-run level system.** In-run progression stays = blessings + weapons + coins. Kits add the ult meter only; they do NOT add an in-run "kit level."
- **Raw caps untouched.** Kit stat leans + passives resolve INSIDE the committed envelope: damage ≤2.25×, fire-rate ≤1.8×, move ≤1.35×, max HP +4 total (shared cap), blessing pierce ≤3, status intensity ≤50%. A kit is a different ROUTE to the caps + a signature ult, never a higher ceiling.
- **Solo-complete rule.** Every kit is fully playable solo; every ult has a real solo use. No kit is dead without a team.
- **No forced roles.** Quick Play never enforces comp; 4× same kit is legal. Comp is a bonus ceiling, not a requirement floor.
- **Nothing buys past a mechanic.** No ult grants a boss phase-skip, permanent invuln, or bypasses an earned window. Aegis/Phase invuln windows are short and capped (below).

## 2. THE FOUR v1 KITS
Numbers are design targets; balancer owns final tuning and must validate against the TTK/threat gates. Ranges given where a single value isn't yet earned. Player baseline for reference: maxHp 6 (3 hearts × 2), moveSpeed 200, dash iframe 0.18s, post-hit invuln 0.80s.

### 2.1 GUNNER — DPS carry (starter, unlocked by default)
- **Start weapon:** reliable mid-range rifle (existing Camp Iron neutral archetype).
- **Stat lean:** +damage / +fire-rate leaning, within 2.25× / 1.8× caps.
- **Passive — MOMENTUM:** consecutive hits WITHOUT taking damage ramp a small bonus (target: up to +15% damage AND/OR +10% fire-rate at max stacks; ramps over ~5 landed hits; FULLY decays on taking any damage). Must stay inside the raw caps at max stack even when combined with legal blessings — clamp at the cap.
- **Ultimate — OVERDRIVE (self):** ~5s of large fire-rate boost + suspends cadence/heat/reload downtime + temporary +pierce (e.g. +2, respecting pierce behavior). Pure self-buff. Solo use: melt a boss EXPOSED window. Duration 5.0s; effect magnitude balancer-tuned so a 5s Overdrive does NOT exceed the ~7× Resonance-window ceiling when stacked with a strong build.
- **Charge sources:** damage dealt (primary) + kill bonus.

### 2.2 MENDER — healer (Ian's named kit; unlocked by default alongside Gunner)
- **Start weapon:** mid-range beam/wand, moderate STEADY damage (real offense so solo works).
- **Stat lean:** +max HP (counts vs +4 cap), faster ally revive.
- **Passive — LIFEBLOOM:** a fraction of damage you deal returns as heal-over-time to the LOWEST-HP ally in range (yourself if solo/none). Target: ~8–12% of damage dealt as HoT, HARD-CAPPED at a max heal/sec (e.g. ≤ ~1.0 HP/s equivalent) so it tops people off, never makes a team unkillable. Overheal does nothing (never exceeds maxHp).
- **Ultimate — SANCTUARY (team, ground-placed):** drop an AoE zone (radius ~120px / ~2.5 tiles). On cast: burst heal (~2 HP) to allies inside; then 4.0s HoT (~1 HP/s) to allies who stay inside; cleanses chill + shock slows on entry. Does NOT grant invuln. Solo use: a panic heal + safe-stand pocket for a boss window. Zone is a deterministic sim entity with a fixed 4.0s lifetime.
- **Charge sources:** damage dealt + healing done (so a support-heavy Mender still charges).

### 2.3 BULWARK — tank
- **Start weapon:** short-range scattergun.
- **Stat lean:** +max HP (vs +4 cap), slightly slower move (e.g. ~0.92× base, still well above any floor).
- **Passive — HARDENED:** flat small damage reduction (target ~15%; NO invuln, NO full immunity). Optional out-of-combat regenerating overshield (small, decays in combat) — ship the DR first; overshield is a stretch within v1.
- **Ultimate — AEGIS (team, deployed barrier):** deploy a barrier/dome (radius ~110px) that BLOCKS enemy projectiles from crossing inward while allies shoot OUT. Duration ~4.0s OR an HP budget (whichever first) so it can't tank an infinite burst — barrier has its own HP pool, balancer-set. Does NOT block the boss earned-window logic or grant player invuln (it's cover, not immunity). Solo use: a bubble to survive a burst or hold a window. Deterministic sim entity, server-owned lifetime + HP.
- **Charge sources:** damage TAKEN (primary — a tank charges by tanking) + damage dealt (secondary).

### 2.4 PHANTOM — mobility trickster
- **Start weapon:** fast SMG or dual pistols.
- **Stat lean:** +move (≤1.35× cap), +1 dash charge.
- **Passive — SLIPSTREAM:** extra dash charge / shorter dash cooldown; dashing THROUGH an enemy applies a brief mark OR refunds dash cooldown on a kill. Respects the 1.35× move cap and the existing dash iframe (0.18s) — this passive changes CHARGES/cooldown, not the iframe duration.
- **Ultimate — PHASE (self + nearby allies):** brief invuln (~1.0s, hard-capped ≤1.2s to stay under the "no invuln >1.2s" boss rule) + speed surge (~1.4× for ~3s) for you and allies within ~90px at cast. The "get us out / reposition" button. Alt design (deferred): a decoy clone that pulls aggro — ship the team-dash-invuln version for v1. Solo use: an escape / reset.
- **Charge sources:** dashes performed + kills.

## 3. UNIVERSAL ULT METER
- **One meter, 0→100%, SERVER-OWNED.** Distinct from the Resonance weapon meter: Resonance = per-weapon-family payload (resets on weapon identity); Ult = kit identity that PERSISTS across weapon swaps. Both must render as clearly separate HUD elements (see §6 + flag ui designer).
- **Charge formula (server-computed, deterministic):**
  `ultCharge += (dmgDealt × K_dmg) + (kill × K_kill) + (dt × K_time)` clamped to [0,100],
  where K_time is a slow trickle FLOOR ensuring a long boss fight eventually grants an ult even with low damage output. Per-kit overrides: Bulwark adds `dmgTaken × K_taken`; Mender adds `healingDone × K_heal`. Balancer sets K_* so median full-charge time in active combat ≈ one ult per ~2–3 encounters (tune to feel), and a defensive kit is never starved.
- **Min-time-between-casts: 8.0s hard floor** even if re-charged faster — ults cannot be chained. Enforced server-side (a per-player `ultReadyAt` tick).
- **Trigger:** dedicated input (Q / controller button). On trigger the server validates (meter ==100% AND now ≥ ultReadyAt), then applies the effect + emits the SimEvent(s), resets meter to 0, sets ultReadyAt = now + 8s.
- **Anti-cheat:** clients CANNOT set charge or trigger effects locally; client sends an "ult requested" input only; server is sole authority over charge %, validation, and effect resolution.

## 4. XP = ACCOUNT MASTERY TRACK
- **What it is:** a persistent ACCOUNT level. It is NOT a currency and is NOT spendable — it gates ACCESS only (which kits/cosmetics you may select). This keeps the 2-currency rule intact and directly realizes Ian's "XP where I can pick a kit."
- **How you earn it:** granted at run end from run performance — floors cleared (primary), bosses defeated (bonus), run depth. Earned every run, win or lose (a cleared floor always pays). Server-authoritative tally; persisted with account progression only (per the authoritative persistence rules — progression + boss/event state persist, mobs are ephemeral).
- **What it gates (v1 unlock thresholds — balancer/CD may retune the level numbers, not the model):**
  - **Account Lv1 (start):** GUNNER + MENDER unlocked.
  - **Account Lv ~3:** BULWARK unlocks.
  - **Account Lv ~5:** PHANTOM unlocks.
  - Above that (v2): alternate ult variants, kit cosmetic tints — ACCESS/cosmetic only, never raw power.
- **Coherence:** unlocks are ACCESS + cosmetics. Persistent POWER stays in Amber (Heartwork/Foundation ≤20–30%). Mastery XP must never grant a stat, a cap increase, or a spendable balance.
- **v1 provides an immediate hook:** starting with 2 kits and earning 2 more in the first few account levels means a new player has a visible progression goal from run 1.

## 5. KIT-SELECT FLOW (Amber Camp lobby)
- **Where:** the Amber Camp lobby (the shipped persistent lobby), PRE-RUN. Each player selects their own kit before descending.
- **Per-player + co-op:** every player picks independently → comps emerge (Mender sustains Gunner's Overdrive uptime; Bulwark's Aegis buys a safe Sanctuary cast; Phantom's Phase saves a wipe). No comp is enforced or suggested as required.
- **No mid-run swap:** kit is locked for the run once you descend (swap only back at camp) so kit identity matters. Drop-in / late-join: pick kit at join, before spawning into the world.
- **Locked kits:** shown greyed with their unlock threshold ("Reach Account Lv 3") so the progression goal is visible — same aspiration pattern as the premium shop's visible-but-locked items.

## 6. HUD / READABILITY (dependency, ships with kits)
- **Ult meter:** a dedicated meter visually SEPARATE from the Resonance meter (different position + iconography); fills 0→100; a distinct "ULT READY" state; shows the 8s cooldown lockout after a cast.
- **Teammate HP is REQUIRED** for the Mender fantasy: teammate HP on nameplates / party HUD (number + small bar). Mender cannot function without seeing who to heal — this ships WITH kits, not later.
- **HP numbers on own heart row** (current/max, e.g. "12/12") with the settings toggle (Hearts only / Hearts + number [default] / Number only) — see the HP-visibility rec; bundled here because the healer loop needs numeric HP legibility.
- Flag ui designer to own exact placement/iconography.

## 7. DETERMINISM / AUTHORITATIVE NOTES (build-critical)
- **All ults are server-owned.** Client sends an "ult requested" input; the SERVER validates charge + cooldown, computes the effect, mutates world state, and emits SimEvent(s). Clients render off those events only. No client-authoritative heal/shield/teleport/invuln.
- **Ult meter charge % is server-owned** and part of the authoritative player state (never client-computed, never trusted from client).
- **Cross-wire additions (protocol bump — currently v17 → v18):**
  - Player state: add `kitId` (enum), `ultCharge` (fixed-point 0..N), `ultReadyAtTick`.
  - New SimEvents: `ULT_OVERDRIVE` (playerId, durationTicks), `ULT_SANCTUARY` (playerId, x, y, radius, lifetimeTicks), `ULT_AEGIS` (playerId, x, y, radius, hpBudget, lifetimeTicks), `ULT_PHASE` (playerId, affectedPlayerIds[], invulnTicks, speedMult, speedTicks). Each carries only integers/fixed-point + ids.
  - New sim entities: Sanctuary zone, Aegis barrier — both deterministic with fixed lifetimes/HP, simulated identically on server + (for prediction) client, reconciled from snapshot. Add to snapshot serialization.
  - Kit-select: `kitId` chosen in lobby travels in the join/ready payload; validated server-side against the player's account Mastery unlocks (server is source of truth for what's unlocked — never trust a client claim to an unowned kit).
  - Bump PROTOCOL_VERSION to 18; the join handler already enforces protocol equality, so old clients are rejected cleanly.
- **Caps enforced server-side:** Sanctuary heal/sec, Lifebloom heal/sec, Aegis HP + duration, Phase invuln ≤1.2s + duration, Overdrive magnitude — all clamped on the server so no client desync or exploit can exceed them. Sanctuary can never out-heal all incoming damage (there is no god-mode configuration).
- **Co-op scaling:** ults follow the shipped co-op rules — snapshot living players at encounter pull; ults do NOT rescale a boss; they are player capability, budgeted so 4 players' ults can't trivialize an earned window (the window still requires the mechanic).
- **Downed/dead allies:** define server-side — Sanctuary may SPEED a revive but never auto-revives; Phase does not resurrect; Aegis protects the downed player's reviver but doesn't auto-res. No ult replaces the revive mechanic.
- **Determinism tests to require:** golden-master for ult charge accrual (given damage/kill/time inputs), ult trigger validation + 8s lockout, Sanctuary/Aegis entity lifetime, and Phase multi-target selection — each under P=1..4 + reconnect + same-seed replay. If it crosses the wire and isn't golden-mastered, it isn't deterministic.

## 8. SCOPE — v1 vs DEFERRED
- **v1 (this spec):** 4 kits (Gunner/Mender/Bulwark/Phantom), one ult each, universal server-owned ult meter, account Mastery XP gating kit access (2 start + 2 early unlocks), Amber Camp kit-select (per-player, co-op, no forced roles), HUD (ult meter + teammate HP + HP numbers), protocol v18.
- **Deferred to v2+ (designed, not in this build):**
  - **BROODMOTHER** (summoner): permanent capped combat pet + SWARM ult. ⚠ Aggregate pet+ult minion DPS MUST obey the shipped pet caps (owner ≤12% sustained, party ≤25%) — deferred because that accounting is the fiddly part.
  - **EMBERWRIGHT** (elementalist/status): status-applying weapon + status-spread passive + CATACLYSM AoE ult. Uses the 4-status system, respects the 50% intensity cap — deferred for its own status-balance pass.
  - Per-kit MASTERY (kit XP → alternate ult / passive upgrade / cosmetic tint — horizontal only).
  - Ult VARIANTS + kit cosmetics.
  - The Nuclear-Throne-style "in-run XP orbs → level → pick a blessing" reframe — a SEPARATE future decision (would reframe blessing acquisition; deliberately NOT bundled here).

## 9. CHANGES FROM THE v1 OUTLINE (flags for the runner)
- No mechanical changes to the outline — this spec HARDENS it with numbers + the authoritative contract. Specific additions worth noting before the build:
  1. **Phase invuln explicitly capped ≤1.2s** to stay under the boss "no invuln >1.2s" rule (was unspecified in the outline).
  2. **Aegis is duration OR HP-budget, whichever first** (not pure duration) so it can't eat an infinite burst.
  3. **Overdrive magnitude clamped so it can't exceed the ~7× Resonance-window ceiling** when stacked with a strong build (coherence with BALANCE_FINAL §expressive-capability).
  4. **Protocol bump to v18** is required (kitId + ult state + 4 new SimEvents + 2 new sim entities cross the wire).
  5. **Teammate HP + HP numbers are a hard dependency** bundled into v1 (the Mender is non-functional without them) — do not split them into a later UI wave.
- **Build order (impact/effort):** (1) HP numbers + teammate HP HUD [tiny, hard dependency]; (2) ult meter + 4 kits with one ult each [core; the two ally-ults Sanctuary/Aegis are the server-auth work to budget]; (3) account Mastery XP + lobby kit-select [wraps the meta hook]. Then the deferred kits/mastery in v2.

## 10. BALANCER STRUCTURAL ADDENDUM (2026-07-10 — plumb these so K_* + magnitudes stay tunable without re-plumbing)
These are STRUCTURAL (how the code is shaped), not final numbers. Balancer (dc9dfebf) owns the actual values later; build must make them tunable per below.

### Charge model (§3)
- **Store charge as fixed-point fractions of 100**, NOT raw (damage × coefficient). Normalize to be target-agnostic: `charge% per hit = 100 × (dmgDealt / RefEncounterHP) × W_dmg`, where RefEncounterHP = the floor's expected effective HP. (A flat K_dmg charges ~2–3× faster on low-HP early floors than deep bosses — normalize it out.)
- **Per-source contribution share caps** so no single input dominates: damage ≤70%, kills ≤40%, time-floor via trickle. (Stops AoE-farming trash from perma-charging while a boss-only fight starves.)
- **Time-floor is encounter-relative + combat-gated:** guarantee ~1 ult by ~45–60s of sustained boss combat even at low DPS; K_time floor ≈ 100 / (55s / FIXED_DT), accruing ONLY while in combat (enemies alive/aggro), never in empty rooms.
- **Charge KEEPS accruing during the 8s lockout** (clamped ≤100, not wasted), still gated by the floor. Meter does NOT reset on floor descent or weapon swap (persists per §3).
- **Log "charge wasted %"** (overcharge held at 100 is lost) so balancer can tune median to ~1 ult / 2–3 encounters.

### Magnitude structure (§2)
- **GUNNER Overdrive = a SEPARATE multiplicative layer clamped AFTER combining with blessings/Resonance to the 7× expressive ceiling** — NOT a raw fireRateMult add (that would collide with the 1.8× raw cap). Duration 5s fine.
- **MENDER: Lifebloom HoT + Sanctuary HoT share ONE healing budget.** Implement a per-target server-side incoming-heal clamp: combined Mender output to one ally ≤~1.5 HP/s, party-wide ≤~3 HP/s, regardless of Mender count (two Menders must NOT double-stack). Overheal discard stays.
- **BULWARK Aegis HP scales with encounter, not flat:** `hpBudget = k × RefEncounterDPS(floor) × duration`, clamped; duration OR HP whichever first. 15% Hardened DR applies inside damage-taken math BEFORE co-op/mode pressure, and must NOT stack past ~25% total DR with any future DR.
- **PHANTOM Phase:** invuln ≤1.0s (≤1.2 hard cap) — one Phase must NOT trivialize a single ≤1.2s forced boss transition (8s floor mostly handles; confirm). **Ult speed 1.4× is an EXEMPT short burst (≤1.4× ≤3s), NOT clamped to the 1.35× raw mover cap** — plumb it as an ult burst so the shared mover cap doesn't clamp it.

### Co-op / anti-stack (§7)
- **Overlapping same-ult zone effects on one target take MAX, not SUM:** two Aegis overlap = cover only (no double DR); two Sanctuary overlap = max HoT not sum; two Overdrive on different players = fine (self-buff).
- **Ults are PLAYER capability only** in the boss survivability math — they never reduce a boss forced-transition or skip a phase floor (make explicit for the QA gate).

### Test hooks (golden-master, §7)
- Deterministic per-tick dump of ultCharge accrual per input (dmg/kill/time/taken/heal), ultReadyAt enforcement, per-target incoming-heal clamp, Aegis barrier HP depletion, Phase multi-target selection — each under P=1..4 + reconnect + same-seed replay.
