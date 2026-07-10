# blobrogue — WAVE 1 FOUNDATIONS (the deterministic backbone)

Companion to `blobrogue_WAVE1_BUILD_PACKET_RECOMMENDATION.md` and
`blobrogue_CONTENT_ROADMAP_to100_RECOMMENDATION.md`. This documents the THREE prerequisite
foundation systems built ahead of THE UNMAKING (F31–100) content. Bosses / guns / enemies /
the actual floor-mutator + affix CONTENT hang off this backbone in the NEXT build; this build
is the framework + the contracts, deterministic and golden-mastered.

Everything here is server-authoritative and resolved ONCE at generation. Clients READ, never
roll. Reconnect + same-seed replay = identical. All rolls are integer/fixed-point only — no
floats, no wall-clock, no player-count branching *inside a draw*.

## Regions vs biome bands

`biomes.ts` now carries a first-class **region** model (`REGIONS`, `regionForFloor`). A region
is the encounter-identity unit the roadmap describes:

| Region | Floors | Notes |
|--------|--------|-------|
| Amberwild | 1–5 | pre-F30 bands map 1:1 to the six curriculum biome bands |
| Rootbound Warrens | 6–10 | |
| Sunless Caves | 11–15 | |
| The Deep | 16–20 | |
| Gilded Archive | 21–25 | |
| Emberreach | 26–30 | |
| The Sump | 31–50 | THE UNMAKING wave 1 — canonical AD palette |
| The Veinworks | 51–70 | wave 2 — canonical AD palette |
| The Pale | 71–90 | wave 3 — canonical AD palette |
| Null Core | 91–100 | wave 4 (terminal) — canonical AD palette |

The **biome PALETTE ladder** (`BIOMES`, `biomeIndexForFloor`) is now **1:1 with `REGIONS`** — ten
bands, one granularity for palette, pressure, hazards AND encounter identity. `biomeIndexForFloor`
== `regionIndexForFloor`; `biomeDepthForFloor` ramps over each region's span (pre-F30 over 5
floors, post-F30 over 20/20/20/10). The four post-F30 bands carry the art director's CANONICAL
palettes (warmth drains as you descend: Sump warm-corrupted → Veinworks resin/amber → Pale
near-grey subtraction → Null Core void), validated for the walkability readability gate (floorA
sits 24–48L below wallCap in every region). The post-F30 bands reuse existing authored tile art
(nullvoid/ember/sunless) as interim texture until dedicated art lands.

Readability note for the AD: Null Core's intentional near-black void palette meets the raw
floorA-vs-wallCap criterion and passes the art-backed (authored + shared) readability tiers, but
cannot reach the no-art FLAT fallback's graded luma-delta floor (the near-black floor is pinned
and the grade compresses the wall; `floorDim`/`wallLift` can't lift it without lightening the
palette). Null Core is therefore gated in the art tiers + the synthetic edge scenes, not the flat
no-art fallback — a known void-aesthetic limitation, flagged for a possible AD relock.

## GATE 1 — biome-selective encounter deck (`roster.ts`)

`floorRoster()` was a cumulative/global pool: every unlocked enemy could appear on every deep
floor. That IS the repetition. It is replaced by a per-region deck (`REGION_ROSTERS`):

- each region declares an **INCLUDE** set (its native kinds) + an explicit **CARRYOVER**
  whitelist (which earlier kinds still appear) — not "everything unlocked";
- each entry is tiered **signature** (common) or **spice** (rare), with a weight;
- the floor draws a **hand**: every introduced *signature* kind is always in, plus a bounded
  **draw-WITHOUT-replacement** subset of the introduced *spice* kinds, seeded off the encounter
  deck's named PRNG stream. A floor never over-draws (hand ≤ pool) and never repeats a kind
  within its own hand.

Pre-F30 regions declare every kind *signature* with the historical weights, so their hand is the
full introduced pool — **byte-identical to the old cumulative roster** (existing floors stay
valid; goldens unchanged). Post-F30 regions curate INCLUDE + CARRYOVER + a rotating spice draw,
so consecutive Sump floors feel different.

Adding a region or an enemy is DATA (a row in `REGION_ROSTERS`), not code.

## GATE 2 — 4-player telegraph / effect-density controller (`telegraphBudget.ts`)

A per-frame budget over telegraph / effect sources, deterministic where it touches the sim and
client-only for pure cosmetic culling.

- **Priority order** (highest first): `bossWindup` > `giantPhase` > `eliteAffix` > `hazardMutator`
  > `ambient`.
- **Reserved visual registers**: `enemyTell` (incoming-damage tells), `playerWeapon` (the 4
  players' own weapon FX), `ambient` (cosmetic). A teammate's weapon FX can never occupy the
  enemy-tell register, so it can't mask an incoming attack.
- **HARD RULE — fairness cues are EXEMPT from culling.** Anything that tells the player about
  incoming damage (boss/enemy attack telegraphs) always renders. `planBudget` keeps every
  fairness cue first, then fills the remaining budget by priority, culling ONLY ambient/cosmetic.
- **Overlap arbitration** (`arbitrateLethalWindups`): two LETHAL windups never resolve on the
  same tile within `LETHAL_WINDOW_S` (~0.3s). Colliding windups are staggered (delayed) or
  relocated deterministically, seeded from the roll streams — identical on every client. This
  generalizes the sim's existing release arbiter (`world.ts` recentReleases) into a documented,
  testable controller.

The cosmetic culling half is wired at the client ambient layer only (golden-safe); the
classification + arbitration are pure and shared, so giants/mutators plug their sources in next.

## GATE 3 — the randomness DETERMINISM backbone (`streams.ts` + `floorRolls.ts`)

### Named PRNG streams (`streams.ts`)

Every roll draws from a stream keyed by `(worldSeed, floorIndex, rollStreamId, ordinal)`,
integer/fixed-point only. `rollStream(seed, floor, id, ordinal?)` returns an `Rng`. The player
count is deliberately NOT part of the stream key — a draw never branches on it (the density veto
takes `playerCountAtLock` for CAPS, outside the draw).

### THE ROLL-ORDER CONTRACT (authoritative)

Floor rolls resolve in EXACTLY this order; new systems APPEND to the end, never insert mid-list,
so existing seeds stay stable:

1. `FLOOR_MUTATORS`
2. `ENCOUNTER_DECK` (the Gate 1 roster/deck draw)
3. `ELITE_AFFIXES` — by ASCENDING spawn ordinal
4. `BOSS_AFFIX`

The order is written here and in `streams.ts`, and **enforced by a golden-master test**
(`test/determinism.test.ts`): any reorder or mid-list insert changes the frozen bytes and fails.

### Resolve-once, freeze (`floorRolls.ts`)

`resolveFloorDescriptor(worldSeed, floorIndex, playerCountAtLock)` runs the contract in order,
enforces caps at generation, applies the density controller's deterministic veto (authored
priority OR seeded re-roll from the SAME stream — a pure function of seed+floor+playerCountAtLock),
and returns a frozen `FloorDescriptor`. `loadFloorIntoWorld` calls it once and stores
`w.floorDescriptor`; nothing re-rolls per frame.

The descriptor is a pure function of `(seed, floor, playerCountAtLock)`, so clients recompute it
identically inside their own `loadFloorIntoWorld` (the same pattern as `floorHazards` and the
encounter deck, which are explicitly never on the wire). **No wire growth, so PROTOCOL_VERSION
stays 15.** When the actual mutator/affix CONTENT lands and the descriptor must carry authority-
only inputs the client can't recompute, that is when it graduates onto the snapshot and bumps
v15→v16.

### Golden-master (required)

`test/determinism.test.ts` captures `resolveFloorDescriptor` across a floor sweep for **P=1..4**,
asserts:
- determinism (recompute == identical),
- reconnect (rebuild the world from the same seed+floor+players == identical descriptor),
- same-seed replay (a second run == identical),
- the frozen golden bytes match.

"Not golden-mastered = doesn't ship."

### Content is deferred

The mutator/affix pools here are a couple of clearly-marked STUB entries — enough to exercise the
framework end-to-end. The descriptor is resolved and frozen but NOT yet expressed through the sim
(no vision/hazard/spawn changes), so existing floors are byte-identical. Authoring the real 6
mutators + 5 elite affixes + boss affixes (and wiring their expression) is the NEXT build.
