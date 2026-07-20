# PRE-F30 LEVEL VARIETY — QUILL NUMBERS (FINAL, design-only)
**Owner:** Quill (final numbers) · pairs with Rook's PRE_F30_LEVEL_VARIETY_PACKET.md
**Gate against main tip:** fcd6d1faac95e22a172623102eeca5fc0a898221 (Rook's stated tip; re-fetch live before any PR gate)
**Status:** numbers locked for Ian sign-off. Nothing ships until Ian approves the combined plan.

Grounding (audited on main): floorThreat = min(30, 6+2(f-1)) → caps at 30 from F13. activeThreatCap = min(16, 8+f) → caps at 16 from F8. Elite minFloor 6, brute F4. Elite threatCost 4, ELITE_COST_CAP 6. Affix slots 2 @ 50%/slot (F31+). Density veto budget = 4 - 0.5(P-1) → P1 4 / P4 2.5. Bosses F5/10/15/20/25/30. Minibosses F13/18/23/28 (cost 10 out of budget).

---

## 1. AFFIX SURCHARGE — the headline number (Rook's budget-neutral call)
**Surcharge = +1.0 threat per affixed elite**, folded into the elite's cost at placement, UNDER the existing ELITE_COST_CAP (6). Not free, not additive-on-top — it trades chaff, exactly like twinnedElites.

- Simple/standard-chassis elite (base 4.0): affixed cost = min(4.0 + 1.0, 6) = **5.0** → surcharge fully applied (trades ~1 standard or 2 swarm bodies). This is the common early case.
- Complex-chassis elite (base clamps to 6): affixed = min(6+1, 6) = **6.0** → surcharge absorbed by the cap. Keeps the "elite + complex chassis ≤ 6" envelope contract intact; no spike.
- Why +1.0: each affix is one readable behavior (~0.5–1.0 threat-equiv: enrage/hazardTrail lighter, shielded/splits/reflect heavier). A flat 1.0 is deterministic, simple, ~25% of base elite cost, and trades ~1 body. Populated check: F9 budget = floorThreat(9)=22; two elites w/ one affix = 4+5=9, leaves 13 for the rest → NOT under-populated, so neutral holds (Rook's unpriced fallback not needed).

**Implementation note (the one non-trivial code change in my half):** affixes roll in resolveFloorDescriptor but apply post-plan (applyRollAffix by ordinal). To charge the surcharge, planFloorUnits must know how many of its elites will be affixed. Pass the descriptor's non-null affix count (capped by elite count) into planFloorUnits; when it places elite at ascending ordinal N, if slot N has an affix, charge +1.0 before the budget subtract, clamped at 6. Deterministic (affixes map to elites by ordinal already).

---

## 2. MUTATOR INTENSITY CURVE — pre-F30 (scaled) vs F31+ (current)
All values ramp GENTLER early → reach the current F31+ value by F26-30 (seamless into the Unmaking). These are per-band; a linear per-floor interp between band anchors is fine if you prefer smoothness.

### Hazard-budget multipliers (hit the SEPARATE hazard-tile budget, NOT enemy floorThreat)
| Mutator | F3-5 | F6-10 | F11-15 | F16-20 | F21-25 | F26-30 | **F31+ (now)** |
|---|---|---|---|---|---|---|---|
| amberfall (F3+) | 1.15 | 1.20 | 1.25 | 1.30 | 1.35 | 1.40 | **1.40** |
| moltenFloor (F4+) | 1.20 | 1.25 | 1.30 | 1.35 | 1.42 | 1.50 | **1.50** |
| fractureStorm (F8+) | — | 1.20 | 1.28 | 1.35 | 1.40 | 1.45 | **1.45** |

### denseDark — vision mult (F7+; lower = harsher; milder early = closer to 1.0)
| F7-10 | F11-15 | F16-20 | F21-25 | F26-30 | **F31+ (now)** |
|---|---|---|---|---|---|
| 0.85 | 0.82 | 0.79 | 0.76 | 0.72 | **0.72** |

### thinAir — dash profile (F4+; milder early = closer to 1.0)
| Band | speedMult | activeMult | cdMult |
|---|---|---|---|
| F4-5 | 1.15 | 1.10 | 0.92 |
| F6-10 | 1.18 | 1.12 | 0.90 |
| F11-15 | 1.20 | 1.14 | 0.89 |
| F16-20 | 1.22 | 1.15 | 0.88 |
| F21-25 | 1.25 | 1.16 | 0.86 |
| F26-30 | 1.28 | 1.18 | 0.85 |
| **F31+ (now)** | **1.28** | **1.18** | **0.85** |

### twinnedElites (F9+): no intensity param — it's +1 elite, budget-folded. Gating + roll rate only.
**Code note:** intensity helpers (floorVisionMult, floorDashProfile, floorHazardMutation) are currently flat constants. To scale by floor they need a floor arg + a band lookup. Data-driven, small.

---

## 3. MUTATOR ELIGIBILITY + ROLL PROBABILITY
### Eligibility (which mutators are in the bag, by first floor — Rook's ramp)
`amberfall:3 · moltenFloor:4 · thinAir:4 · denseDark:7 · fractureStorm:8 · twinnedElites:9`
Bag per floor = mutators whose first-floor ≤ current floor. (Today the bag is all 6 unconditionally — this filter is the ramp.)

### Calm rules (hard gates, override the roll)
- **F1:** no roll ever (clean, locked).
- **Post-boss openers F6/F11/F16/F21/F26:** 0 mutators (calm slot, locked).
- **Miniboss floors F13/F18/F23/F28:** ≤1 mutator AND restricted to the mild set {amberfall, moltenFloor, thinAir} (exclude denseDark/fractureStorm/twinnedElites). The captain IS the spike.

### Roll probability — replace `rng.int(0,2)` with floor-keyed weights P(0)/P(1)/P(2)
| Floor | P(0) | P(1) | P(2) | Note |
|---|---|---|---|---|
| F1 | 100% | — | — | clean (locked) |
| F2 | 100% | — | — | deck-only (amberfall not eligible til F3) |
| F3 | 75% | 25% | — | amberfall only; light intro |
| F4 | 65% | 35% | — | +molten/thinAir; band-1 never 2-stacks |
| F5/10/15/20/25/30 | boss | | | mutators eligible but elites/affixes inert |
| F6 | 100% | — | — | opener calm |
| F7 | 60% | 40% | — | slot 2 |
| F8 | 45% | 45% | 10% | slot 3 spike (fracture now in pool) |
| F9 | 60% | 40% | — | slot 4 pre-boss (1 max) |
| F11 | 100% | — | — | opener calm |
| F12 | 50% | 45% | 5% | slot 2 |
| F13 | 75% | 25% | — | MINIBOSS: ≤1 mild only |
| F14 | 55% | 45% | — | slot 4 pre-boss |
| F16 | 100% | — | — | opener calm |
| F17 | 40% | 50% | 10% | slot 2 |
| F18 | 75% | 25% | — | MINIBOSS: ≤1 mild |
| F19 | 55% | 45% | — | slot 4 pre-boss |
| F21 | 100% | — | — | opener calm |
| F22 | 35% | 50% | 15% | slot 2 |
| F23 | 70% | 30% | — | MINIBOSS: ≤1 mild |
| F24 | 50% | 50% | — | slot 4 pre-boss |
| F26 | 100% | — | — | opener calm |
| F27 | 25% | 55% | 20% | slot 2 |
| F28 | 70% | 30% | — | MINIBOSS: ≤1 mild |
| F29 | 45% | 55% | — | slot 4 pre-boss (ramps toward F31+) |
| **F31+** | **33%** | **33%** | **33%** | existing uniform rng.int(0,2) |
Density veto (P4 budget 2.5) still applies AFTER the count roll — unchanged, keep it. 2-stacks realistically only survive solo/P2; that's intended.

---

## 4. ELITE AFFIX ROLL RATE + ELIGIBILITY
### Eligibility (which affixes in the pool, by first floor — Rook's mild-first ramp)
`enrage:6 · hazardTrail:6 · shielded:8 · splits:9 · reflect:11`

### Roll rate per elite slot (per band; ramps toward the F31+ 50%)
| Band | rate/slot | Note |
|---|---|---|
| F6-10 | 25% | mild subset only til F8/F9 unlock |
| F11-15 | 30% | reflect now in pool |
| F16-20 | 35% | |
| F21-25 | 40% | |
| F26-30 | 45% | |
| **F31+** | **50%** | existing |
- **Miniboss floors (F13/18/23/28): cap to 1 affix slot** (not 2) — keep the captain floor from stacking.
- Intensity params (ROLL_AFFIX: slabHp 10, dripGap/life/radius, reflect arc/armed/crackCd/bolt, enrage +50%, splitCount 2 @ 35% HP) — **KEEP F31+ values, no early scale-down.** The affixes are already mild single behaviors; gating (which affix, how often) + the surcharge carry the fairness ramp. Scaling their internals too would over-neuter them.

---

## 5. twinnedElites / affix ↔ floorThreat — the explicit interaction answer
- **twinnedElites: KEEP budget-folded (already is).** The +1 elite draws through add() (`budget -= cost`), so on the F13+ cap of 30 it TRADES chaff for the elite — it can't push total threat over the curve. Do NOT make it additive.
- **affixes: NEW +1.0 surcharge, folded pre-clamp under cap 6** (§1). Budget-neutral per Rook.
- **The guarantee:** both fold into the SAME capped budget (30 past F13). So enabling them mathematically CANNOT raise total floor threat above today's curve. That's the proof this is variety, not difficulty.

---

## 6. GUARDRAIL — "variety, not harder" (blobrogue's + my original concern)
1. Threat/HP curve past ~F13 is flat (floorThreat cap 30, activeThreatCap 16, HP untouched). My design keeps enemy/elite adds budget-folded → **total enemy threat unchanged.**
2. The ONLY net-new pressure is hazard-mutator tile density (separate budget). Mitigated 3 ways: scaled DOWN early (1.15-1.20× vs 1.40-1.50×), telegraphed + avoidable by design, and still under the hazard system's own studio caps (tile budget + denial/simultaneity).
3. denseDark/thinAir add ZERO enemies/hazards — pure feel (vision/dash). No difficulty cost at all.
4. Miniboss floors capped to ≤1 mild mutator + 1 affix slot (captain is the spike).
5. Density veto unchanged (P4 2.5 sheds heavy mutators first).
**Net:** difficulty delta ≈ scaled-down avoidable hazards only; everything else is trade-neutral or cosmetic-feel. Passes the "flat curve stays flat" bar.

---

## 7. DECK CURATION — signature/spice split + spiceDraw (co-owned w/ roster/shao)
spiceDraw: **Amberwild 1** (tutorial legibility), **other 5 regions 2** (mirror Sump). Confirmed per Rook.
Roles: simple/melee = slime,bat,skeleton,ghost · ranged/zoner = spitter,orbiter,caskbellows · complex = charger,burrower,shielder,rootward,seamcutter,sinderling,mason · controller = echojack,fragment.
Only introduced kinds appear (FAMILY_INTRO_FLOOR), so each region's usable pool is its cumulative unlocks. Proposed split (signature = always-in core; spice = rotating pool):

| Region (floors) | Signature core (always in) | Spice pool (rotate) | spiceDraw |
|---|---|---|---|
| Amberwild (1-5) | slime(5), bat(3), skeleton(2) | spitter(2), ghost(2), charger(2), burrower(2) | 1 |
| Rootbound (6-10) | slime(5), skeleton(2), orbiter(2)* | bat(3), ghost(2), spitter(2), charger(2), burrower(2), shielder(2), rootward(2) | 2 |
| Sunless (11-15) | slime(4), spitter(2), caskbellows(2)* | bat(2), skeleton(2), ghost(2), charger(2), burrower(2), orbiter(2), shielder(2), rootward(2), echojack(1.5) | 2 |
| The Deep (16-20) | slime(4), charger(2), seamcutter(2)* | skeleton(2), ghost(2), spitter(2), burrower(2), orbiter(2), shielder(2), rootward(2), caskbellows(2), echojack(1.5) | 2 |
| Gilded (21-25) | slime(4), shielder(2), echojack(1.5) | skeleton(2), ghost(2), spitter(2), charger(2), burrower(2), orbiter(2), rootward(2), caskbellows(2), seamcutter(2) | 2 |
| Emberreach (26-30) | slime(5), sinderling(2.5)*, mason(1.5)* | skeleton(2), ghost(2), spitter(2), charger(2), burrower(2), orbiter(2), shielder(2), rootward(2), caskbellows(2), seamcutter(2), echojack(1.5) | 2 |
*= the region's teaching-kind debut (FAMILY_INTRO). Weights carried from CURRICULUM; complexWeighted flags unchanged from current roster rows.
**Roster/shao: confirm the signature-CORE kind identity** (it touches biome ecology/art). Weights + spiceDraw are mine.

### Per-floor A/B/C/D contrast — two ship tiers
- **Tier 1 (baseline, ~zero new mechanic):** just apply the split + spiceDraw above. The seeded draw-without-replacement already rotates the hand per floor → real variety, kills the "same hand every floor" root cause. **This alone satisfies Ian's ask.**
- **Tier 2 (Rook's full A/B/C/D identity, small add):** a position-in-band `spiceLean` weight bias on the existing ENCOUNTER_DECK draw (no new stream): opener = core only · floor B = ×1.5 melee/swarm spice · floor C = ×1.5 ranged/zoner spice · floor D (pre-boss) = ×2.0 the band's newest FAMILY_INTRO kind. Deterministic weight tweak, one helper.
**Rec:** ship Tier 1 first (delivers the fix), layer Tier 2 as polish.

---

## 8. SUMMARY (hand to Ian)
- Affix surcharge **+1.0** folded pre-clamp (cap 6) → budget-neutral.
- Mutator intensity scaled down early (hazard mults 1.15-1.20× vs 1.40-1.50×; denseDark 0.85→0.72; thinAir gentler), reaching F31+ values by F26-30.
- Roll prob table ramps rare/mild (F3-5) → common (F27-29), with F1 clean, post-boss openers calm, miniboss floors ≤1 mild.
- Affix rate 25%→45%/slot by band; mild-first eligibility.
- twinnedElites stays folded; both adds fold into the capped budget → provably variety, not harder.
- Deck: spiceDraw 1/6 regions w/ signature+spice split; Tier 1 ships the fix, Tier 2 adds A/B/C/D contrast.
