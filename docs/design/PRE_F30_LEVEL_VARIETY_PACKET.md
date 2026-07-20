# PRE-F30 LEVEL VARIETY PACKET — turn on the machinery, fairly
**Owner:** Rook (GD: which levers + fairness gating + feel) · **Numbers/intensity:** Quill FINAL · **Design-only** (nothing ships until Ian signs off)
**Main tip:** `fcd6d1faac95e22a172623102eeca5fc0a898221`
**Trigger:** Ian + friend — floors 1-4 between each boss feel samey. Boss floors fine.

## 0. Framing
The variety machinery is ALL built + wired end-to-end (6 mutators, 5 elite affixes, spiceDraw deck rotation), just hard-gated to `RANDOMNESS_MIN_FLOOR = 31` + all six pre-F30 regions on the shared CURRICULUM deck at `spiceDraw:0`. So this spec **turns levers on with a fairness ramp** — it invents nothing new.

**Two root causes of the sameness, two fixes:**
1. Every pre-F30 floor draws the SAME hand (cumulative signature-only deck, spiceDraw:0) → **give the six curriculum regions signature/spice split + spiceDraw.**
2. Zero procedural variety pre-F30 (descriptor empty) → **lower the gate on a per-lever ramp** (not a flat drop to 31).

**Hard constraint (Quill audit):** elites gate at `minFloor=6`, brutes at F4. So on **floors 1-5, twinnedElites + all elite affixes express NOTHING.** Early variety MUST come from hazard/vision/dash mutators + deck curation. Elites/affixes only become a lever from F6 (Rootbound) on.

---

## 1. Floor 1 — always clean (locked)
**Floor 1 = zero mutators, zero affixes, no spice.** Brand-new players meet the core loop (move, shoot, clear, exit) with slime-only (FAMILY_INTRO_FLOOR slime:1) and nothing else. First impression must teach the baseline before it varies. Non-negotiable.

## 2. First-floor-after-a-boss = breather (locked)
Every band's **opening floor stays calm** (post-boss decompression): F6, F11, F16, F21, F26 roll **at most a light deck-only variety, no mutator.** The player just spent a boss; the next floor rewards arrival, then pressure rebuilds across the band. This is a cadence rule the current roll path doesn't have — add it as a "calm slot" gate.

## 3. Mutator fairness ramp (which lever, from which floor)
Rank by how much a mutator can feel UNFAIR to a low-power early build. Ramp in gently; no cliff.

| Mutator | Lever | First eligible floor | Why the gate |
|---|---|---|---|
| **amberfall** (toxic pools) | hazard, telegraphed, avoidable | **F3** | gentlest hazard — static pools you walk around; safe intro to "the floor itself is a threat" |
| **moltenFloor** (fire vents) | hazard, telegraphed | **F4** | rhythmic vents, slightly more demanding than static pools |
| **thinAir** (dash tuning) | movement buff-ish | **F4** | changes dash feel; harmless-to-helpful, good early spice, low unfairness |
| **denseDark** (vision contract) | vision | **F7** (Rootbound, NOT F2-5) | vision loss on a fresh build with no map knowledge is the harshest early — hold it past band 1; telegraphs stay bright so it's fair once enemies are readable |
| **fractureStorm** (void rifts) | hazard, highest density weight (2.5) | **F8** | most punishing hazard; needs player power + dash comfort first |
| **twinnedElites** (+1 elite, budget-folded) | spawn | **F9** (elites exist F6, 2-elite floors start F9) | pointless before F6 (no elites); most meaningful once 2-elite floors exist. Budget-folded so it trades chaff, doesn't double difficulty |

**F1-5 backbone = amberfall / moltenFloor / thinAir only** (per the dead-zone constraint). That's a real 3-lever variety spread for the exact floors people complain about, none of it elite-dependent.

## 4. Mutator cadence (per band)
- **Not every floor.** A boss every 5th floor is the tentpole; between them the rhythm should breathe: **calm (post-boss) → build → spike → (pre-boss) → BOSS.**
- Proposed per-band slot pattern (floors A-D between bosses, e.g. Amberwild 1-4 before F5 boss... but band 1 is special, see §6):
  - **Slot 1 (post-boss opener):** calm — no mutator (§2).
  - **Slot 2:** 40-ish% chance of ONE light mutator (Quill sets rate).
  - **Slot 3:** the variety spike — up to the FLOOR_CAPS.maxMutators=2, density-veto still applies.
  - **Slot 4 (pre-boss):** ONE mutator max — ramp toward the boss without pre-exhausting the player.
- **Stacking cap stays 2** (existing FLOOR_CAPS.maxMutators) and the **density veto stays as-is** (P4 budget 2.5 already sheds heavy mutators first — that 4-player readability budget is exactly right, keep it). GD does not raise the cap.
- **Boss + gauntlet floors (F5/F10/... F30):** keep hazard/vision/dash mutators eligible (they already apply), but twinnedElites/affixes are inert there anyway (spawn path early-returns) — fine, no change.

## 5. Elite affixes — gating + the pricing question
- **First eligible: F6** (Rootbound opener is calm, so really **expressed F7+**). Never F1-5 (can't fire).
- **Early affix subset (mild first):** `enrage` (approach-speed ramp) and `hazardTrail` (cinder drip) are the readable, fair-early ones → **F6+**. `shielded` (frontal crust — a positioning puzzle) → **F8+**. `splits` (death swarm) → **F9+** (needs clear-speed). `reflect` (bounces a frontal shot) → **F11+ (Sunless)** — it punishes careless fire, the most "gotcha" one, hold it latest.
- **Roll rate low early** — one affixed elite is plenty of novelty on an early floor; ramp frequency up by band (Quill numbers).

### Affix PRICING — my fairness call (blobrogue's question)
**Ask Quill to fold in a token surcharge — make affixes budget-NEUTRAL, not free.** Rationale: affixes are unpriced today (free difficulty). Kept "free but low-rate" they're fine on average, but the failure mode is a bad-luck floor where an affixed elite lands on top of an already-heavy encounter and the floor spikes unfairly — exactly the "this run feels cheap" feedback we want to avoid on the early-to-mid floors we're now enabling. A small budget fold (trade a little chaff for the affix, like twinnedElites already does) keeps the affix as *flavor/variety* rather than *stacked difficulty*, which is the whole intent of this pass (variety, not a difficulty bump). So: **budget-neutral, affixes fold like twinnedElites.** If Quill finds the surcharge makes early floors feel *under*-populated, low-rate-unpriced is an acceptable fallback — but neutral is my default.

## 6. Per-region deck shape (the real anti-repetition fix)
Give the six CURRICULUM regions a **signature/spice split + spiceDraw ≥ 2** (mirror what SUMP/VEINWORKS/PALE/NULLCORE already do post-F30). This makes floors 1-4 of a band feel distinct by ROTATING the hand, not just gating new kinds on.

**Shape per band (describe, Quill/roster owns exact lists + weights):**
- Each band picks a **small signature core** (2-3 kinds that define the band's feel, always present) + a **spice pool** (the rest, rotate 2 per floor via spiceDraw:2).
- **Per-floor identity within a band** (the "A/B/C/D feel distinct" ask):
  - **Floor A (opener, calm):** signature core only, lightest — reintroduce the band's baseline.
  - **Floor B:** lean **melee/swarm** spice (slime/bat/skeleton/charger flavor) — a "press in" floor.
  - **Floor C:** lean **ranged/zoner** spice (spitter/orbiter/caskbellows/rootward) — a "watch your spacing" floor, contrasts B.
  - **Floor D (pre-boss):** **mini-spotlight the band's newest unlocked family** (the FAMILY_INTRO_FLOOR debut) as the featured threat — teaches the kind the boss/next band will lean on.
- **Amberwild (1-5) special:** F1 clean slime; F2 introduce bat/skeleton/spitter as the spice; F3 +ghost/charger; F4 +burrower + first brute (the band's "graduation" before Slime King F5). This band is the tutorial arc — spiceDraw can be lower (1) so it's legible, ramping to 2 from Rootbound on.
- **Contrast is the goal:** consecutive floors should differ on the melee↔ranged and open↔zoner axes so back-to-back floors never feel like the same fight.

## 7. What Quill numbers
- Mutator roll rate per slot/band; affix roll rate per band; spiceDraw value per region (rec: Amberwild 1, others 2); the affix budget-fold surcharge (§5); mutator intensity params per floor (hazard budget mult, denseDark radius, thinAir dash values) — ramp within the existing values, gentler early.
- Signature/spice split lists per region (with roster.ts) — GD gives the SHAPE (§6), Quill/roster picks kinds + weights.

## 8. GD stamp
**Levers on, fairness-ramped:** F1 clean · post-boss floors calm · F1-5 variety = amberfall/molten/thinAir (elites dead early) · denseDark F7+ · fractureStorm F8+ · twinnedElites F9+ · affixes F6+ mild→F11 reflect · **affixes budget-neutral (my call)** · deck signature/spice split + spiceDraw for per-floor A/B/C/D contrast · stacking cap 2 + density veto unchanged.
**Status:** spec for Ian sign-off → Quill numbers. Design-only.
