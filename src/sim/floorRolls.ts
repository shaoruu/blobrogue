// The frozen FLOOR DESCRIPTOR — Gate 3's resolve-once-at-generation artifact
// (docs/blobrogue_WAVE1_FOUNDATIONS.md). resolveFloorDescriptor runs THE ROLL-ORDER CONTRACT
// (streams.ts) in order, enforces caps at generation, applies the density controller's
// deterministic veto, and returns a frozen descriptor. loadFloorIntoWorld calls it once and
// stores it on WorldState; nothing re-rolls per frame. The descriptor is a pure function of
// (worldSeed, floorIndex, playerCountAtLock), so it never travels the wire as a blob: the server
// freezes it at generation, and each client reproduces the identical descriptor by resolving it
// with the AUTHORITATIVE locked player count (SnapWire.pcl — see net/protocol.ts, PROTOCOL v16)
// passed into its own loadFloorIntoWorld. Reconnect + same-seed replay = identical.
//
// WAVE 1 CONTENT. The pools below are the authored mutator / elite-affix / boss-affix sets, and
// their in-sim expression is wired at floor generation (mutators), elite spawn (affixes by
// ascending ordinal) and deep-boss update (boss affix). Every expression derives ONLY from
// already-simulated data — vision radius, hazard density / tile behavior, spawn count, dash
// tuning, real enemy behavior — so no new per-frame runtime path touches floats/wall-clock/
// player-count inside a draw. Adding a mutator/affix is DATA (a row here + its expression helper);
// new SYSTEMS still APPEND to the roll-order contract so stored seeds stay stable.

import { RollStream, ROLL_ORDER, rollStream } from "./streams.js";
import type { RollStreamId } from "./streams.js";
import type { FloorHazardKind } from "./types.js";
import { isBossFloor, isMinibossFloor } from "./enemies.js";

// ---- caps enforced at generation (roadmap "Randomness (Wave 1)") ----
export const FLOOR_CAPS = {
  maxMutators: 2, // ≤2 floor mutators per deep floor
  eliteAffixSlots: 2, // rolled affix slots (≤1 affix per elite is inherent: one roll per ordinal)
  maxBossAffix: 1, // ≤1 boss affix per boss floor
} as const;

// The first floor THE UNMAKING's uniform randomness turns on (post-F30, the Sump onward): at F31+
// mutators roll uniformly (rng.int(0,maxMutators)) over the full pool and affixes roll 2 slots @
// 50% — the byte-stable legacy behavior, unchanged by Tier 1. Pre-F30 is no longer empty: it turns
// the SAME machinery on with a fairness ramp (PRE_F30_LEVEL_VARIETY: per-lever eligibility floors,
// a floor-keyed roll-probability table, calm gates, and a per-band affix rate) — boss floors and
// F1 still resolve to an empty descriptor.
export const RANDOMNESS_MIN_FLOOR = 31;

// ---- PRE-F30 FAIRNESS RAMP (PRE_F30_LEVEL_VARIETY_NUMBERS.md §2-4) ----
// Per-lever first-eligible floor (§3): a mutator is only in the bag when floor >= its first floor.
// F31+ ignores this (the whole pool is eligible), so the ramp is a pure pre-F30 gate.
const MUTATOR_FIRST_FLOOR: Readonly<Record<MutatorId, number>> = {
  amberfall: 3, moltenFloor: 4, thinAir: 4, denseDark: 7, fractureStorm: 8, twinnedElites: 9,
};

// Miniboss floors (F13/18/23/28) allow at most ONE mutator AND only the mild set (§3): the captain
// IS the spike, so denseDark / fractureStorm / twinnedElites are excluded there.
const MILD_MUTATORS: readonly MutatorId[] = ["amberfall", "moltenFloor", "thinAir"];

// Floor-keyed mutator-count weights P(0)/P(1)/P(2) (§3), replacing the F31+ uniform rng.int(0,2).
// Any pre-F30 floor absent from this table (F1, boss floors F5/10/15/20/25/30, the F10 gauntlet,
// and the post-boss opener floors F6/11/16/21/26) resolves to P(0)=100% — the locked calm slots.
const PRE_F30_MUTATOR_P: Readonly<Record<number, readonly [number, number, number]>> = {
  3: [0.75, 0.25, 0], 4: [0.65, 0.35, 0],
  7: [0.60, 0.40, 0], 8: [0.45, 0.45, 0.10], 9: [0.60, 0.40, 0],
  12: [0.50, 0.45, 0.05], 13: [0.75, 0.25, 0], 14: [0.55, 0.45, 0],
  17: [0.40, 0.50, 0.10], 18: [0.75, 0.25, 0], 19: [0.55, 0.45, 0],
  22: [0.35, 0.50, 0.15], 23: [0.70, 0.30, 0], 24: [0.50, 0.50, 0],
  27: [0.25, 0.55, 0.20], 28: [0.70, 0.30, 0], 29: [0.45, 0.55, 0],
};

// Per-affix first-eligible floor (§4, mild-first): which affixes are in the pool at a given floor.
const AFFIX_FIRST_FLOOR: Readonly<Record<RollAffixId, number>> = {
  enrage: 6, hazardTrail: 6, shielded: 8, splits: 9, reflect: 11,
};

// The first floor any elite affix can express (min of AFFIX_FIRST_FLOOR — elites debut F6 anyway).
const AFFIX_MIN_FLOOR = 6;

// Elite-affix roll rate per slot by band (§4), ramping toward the F31+ 50%. floor is always >= F6.
function preF30AffixRate(floor: number): number {
  if (floor <= 10) return 0.25;
  if (floor <= 15) return 0.30;
  if (floor <= 20) return 0.35;
  if (floor <= 25) return 0.40;
  return 0.45; // F26-30
}

// ---- FLOOR MUTATORS v1 (authored — Wave 1) ----
// Six authored mutators, ≤2 per deep floor. Each expresses ONLY through already-simulated data:
//   denseDark     — VISION: the run's sight radius contracts (client hero/teammate glow),
//                   telegraphs stay full-bright (fairness cues are never dimmed).
//   moltenFloor   — HAZARD DENSITY + TILE BEHAVIOR: denser floor hazards biased to FIRE VENTS
//                   (pulsing safe-tile telegraphs — stand off the vent while it blazes).
//   twinnedElites — SPAWN COUNT: one extra elite in the floor plan (paired elite pressure).
//   fractureStorm — HAZARD DENSITY + TILE BEHAVIOR: denser hazards biased to VOID RIFTS whose
//                   open-maw pull + arming pulse are the global pre-snap warning.
//   amberfall     — HAZARD DENSITY + TILE BEHAVIOR: denser hazards biased to TOXIC (amber) pools.
//   thinAir       — DASH TUNING: a longer, faster, quicker-recovering dash (the whole floor
//                   feels slippery; no tells, pure movement feel).
// densityWeight = the projected 4P telegraph/FX pressure the mutator adds; priority = veto rank
// (higher survives; the LOWEST-priority mutator is dropped first when the 4P budget is exceeded).
export type MutatorId =
  | "denseDark" | "moltenFloor" | "twinnedElites" | "fractureStorm" | "amberfall" | "thinAir";

export interface MutatorDef {
  id: MutatorId;
  label: string; // the compact HUD readout name
  densityWeight: number; // projected 4P telegraph/FX pressure this mutator adds
  priority: number; // veto priority (higher survives; lower is dropped/re-rolled first)
}

export const MUTATOR_POOL: readonly MutatorDef[] = [
  { id: "denseDark", label: "Dense Dark", densityWeight: 1, priority: 6 },
  { id: "thinAir", label: "Thin Air", densityWeight: 0.5, priority: 5 },
  { id: "twinnedElites", label: "Twinned Elites", densityWeight: 2, priority: 4 },
  { id: "moltenFloor", label: "Molten Floor", densityWeight: 2, priority: 3 },
  { id: "amberfall", label: "Amberfall", densityWeight: 1.5, priority: 2 },
  { id: "fractureStorm", label: "Fracture Storm", densityWeight: 2.5, priority: 1 },
];

// ELITE AFFIXES v1 (authored). One rolled affix per elite slot (by ascending spawn ordinal);
// null = the slot rolled no affix. Each wires to real enemy behavior with a material-readable
// tell (see world.ts + game.ts):
//   splits     — pre-cracked seams; on death it splits into two swarm bodies.
//   shielded   — an asymmetric crust slab (a directional breakable plate) that FALLS when spent.
//   hazardTrail— the body drips its element, planting a short-lived cinder trail as it moves.
//   reflect    — a glassy amber facet: while ARMED it reflects a frontal shot back, then CRACKS
//                (disarmed) for a cooldown — the armed facet is the fairness tell.
//   enrage     — dead-amber veins heat as HP drops; it closes faster the more bloodied it is.
export type RollAffixId = "splits" | "shielded" | "hazardTrail" | "reflect" | "enrage";

export const ELITE_AFFIX_POOL: readonly RollAffixId[] = ["splits", "shielded", "hazardTrail", "reflect", "enrage"];

// BOSS AFFIXES v1 (authored). ONE extra telegraphed pattern layered onto a deep boss (F31+ boss
// floor) so a repeated boss fights fresh. Each blooms telegraphed detonation zones (the shared
// "charge" hazard: a ≥0.6s arming fuse, walk-dodgeable, routed through the telegraph budget as a
// fairness cue) in a distinct spatial signature — see stepBossAffix in world.ts:
//   emberwake — a bloom under each living player's feet (keep moving).
//   sundering — a fracture SEAM of blooms drawn across the arena through the boss (leave the line).
//   amberrain — a seeded scatter of blooms around the party (read the raining amber).
export type BossAffixId = "emberwake" | "sundering" | "amberrain";

export const BOSS_AFFIX_POOL: readonly BossAffixId[] = ["emberwake", "sundering", "amberrain"];

// ---- mutator EXPRESSION helpers (pure; read the frozen mutator set) ----
// Every helper is a pure function of the frozen mutator id list — a per-floor CONSTANT resolved at
// generation. The sim and every client read the same list (server: players.size; client: the
// authoritative SnapWire.pcl), so expression is identical everywhere and never branches on
// wall-clock or live player count inside a frame.

export function hasMutator(mutators: readonly string[], id: MutatorId): boolean {
  return mutators.indexOf(id) !== -1;
}

// The mutator INTENSITY band a floor sits in (PRE_F30_LEVEL_VARIETY_NUMBERS.md §2): five 5-floor
// pre-F30 bands ramping GENTLER early, reaching the F31+ value by F26-30, then a flat F31+ band.
// Band 6 (F31+) always returns exactly today's constants, so the Unmaking is byte-for-byte
// unchanged; the eligibility gate guarantees a mutator's helper is only ever read at or above its
// first floor, so bands below that first floor are never observed for it.
function intensityBand(floor: number): number {
  if (floor <= 5) return 0;
  if (floor <= 10) return 1;
  if (floor <= 15) return 2;
  if (floor <= 20) return 3;
  if (floor <= 25) return 4;
  if (floor <= 30) return 5;
  return 6;
}

// VISION: denseDark contracts the sight radius. A multiplier the client applies to its hero /
// teammate glow radius; fairness telegraphs are drawn on top and stay full-bright. Milder early
// (closer to 1.0), reaching the F31+ 0.72 by F26-30. denseDark is F7+, so bands 0 (F≤5) is unread.
const DENSE_DARK_VISION_BY_BAND: readonly number[] = [0.85, 0.85, 0.82, 0.79, 0.76, 0.72, 0.72];
export function floorVisionMult(mutators: readonly string[], floor: number): number {
  return hasMutator(mutators, "denseDark") ? DENSE_DARK_VISION_BY_BAND[intensityBand(floor)] : 1;
}

// DASH TUNING: thinAir makes the dash longer/faster and recover quicker. Read by the shared dash
// step (server sim + client prediction both hold the same descriptor), so a snared player's out
// is unchanged in shape — only its reach/cadence shift. Gentler early, reaching the F31+ profile
// by F26-30. thinAir is F4+, so band 0 anchors the F4-5 values.
export interface DashProfile { speedMult: number; activeMult: number; cdMult: number; }
const THIN_AIR_DASH_BY_BAND: readonly DashProfile[] = [
  { speedMult: 1.15, activeMult: 1.10, cdMult: 0.92 }, // F4-5
  { speedMult: 1.18, activeMult: 1.12, cdMult: 0.90 }, // F6-10
  { speedMult: 1.20, activeMult: 1.14, cdMult: 0.89 }, // F11-15
  { speedMult: 1.22, activeMult: 1.15, cdMult: 0.88 }, // F16-20
  { speedMult: 1.25, activeMult: 1.16, cdMult: 0.86 }, // F21-25
  { speedMult: 1.28, activeMult: 1.18, cdMult: 0.85 }, // F26-30
  { speedMult: 1.28, activeMult: 1.18, cdMult: 0.85 }, // F31+ (today's values)
];
export function floorDashProfile(mutators: readonly string[], floor: number): DashProfile {
  if (hasMutator(mutators, "thinAir")) return THIN_AIR_DASH_BY_BAND[intensityBand(floor)];
  return { speedMult: 1, activeMult: 1, cdMult: 1 };
}

// SPAWN COUNT: twinnedElites adds one elite to the floor plan.
export function floorExtraElites(mutators: readonly string[]): number {
  return hasMutator(mutators, "twinnedElites") ? 1 : 0;
}

// HAZARD DENSITY + TILE BEHAVIOR: molten/fracture/amberfall each raise the floor-hazard budget and
// bias the kind mix toward their signature tile (fire vents / void rifts / toxic amber pools). The
// budgets multiply when two hazard mutators co-occur; the biased kinds accumulate so the pick is
// weighted toward the storm's tiles (never AWAY from a biome's other tiles — the veto/caps keep it
// fair). Returns identity when no hazard mutator is active.
// Per-mutator hazard-budget multipliers by intensity band (§2). Each hazard mutator's first floor
// (amberfall F3, moltenFloor F4, fractureStorm F8) means bands below it are never read for that
// kind; the last band is F31+ (today's value). budgetMult MULTIPLIES when hazard mutators co-occur.
const HAZARD_MULT_BY_BAND: Readonly<Record<"amberfall" | "moltenFloor" | "fractureStorm", readonly number[]>> = {
  amberfall: [1.15, 1.20, 1.25, 1.30, 1.35, 1.40, 1.40],
  moltenFloor: [1.20, 1.25, 1.30, 1.35, 1.42, 1.50, 1.50],
  fractureStorm: [1.20, 1.20, 1.28, 1.35, 1.40, 1.45, 1.45],
};
export interface HazardMutation { budgetMult: number; biasKinds: FloorHazardKind[]; }
export function floorHazardMutation(mutators: readonly string[], floor: number): HazardMutation {
  const band = intensityBand(floor);
  let budgetMult = 1;
  const biasKinds: FloorHazardKind[] = [];
  if (hasMutator(mutators, "moltenFloor")) { budgetMult *= HAZARD_MULT_BY_BAND.moltenFloor[band]; biasKinds.push("fire_vent"); }
  if (hasMutator(mutators, "fractureStorm")) { budgetMult *= HAZARD_MULT_BY_BAND.fractureStorm[band]; biasKinds.push("void_rift"); }
  if (hasMutator(mutators, "amberfall")) { budgetMult *= HAZARD_MULT_BY_BAND.amberfall[band]; biasKinds.push("toxic_pool"); }
  return { budgetMult, biasKinds };
}

// The compact HUD readout: the active mutators' display labels, in pool order for a stable read.
export function mutatorLabels(mutators: readonly string[]): string[] {
  return MUTATOR_POOL.filter((m) => mutators.indexOf(m.id) !== -1).map((m) => m.label);
}

// The density budget the 4-player controller enforces at LOCK: a projected telegraph/FX pressure
// ceiling that scales with the locked player count (more players = more simultaneous own-FX, so
// less headroom for mutator-driven pressure). Pure function of playerCountAtLock; the veto below
// is the ONLY place the descriptor consults it.
function densityBudgetFor(playerCountAtLock: number): number {
  // 4 headroom solo, tightening by ~0.5 per extra player: P1=4, P2=3.5, P3=3, P4=2.5.
  return 4 - (Math.max(1, playerCountAtLock) - 1) * 0.5;
}

// One elite slot's rolled affix (by ascending spawn ordinal). ordinal sub-keys the ELITE_AFFIXES
// stream so slot N is stable regardless of how many slots a floor ends up with.
export interface EliteAffixRoll {
  ordinal: number;
  affix: string | null;
}

// The frozen per-floor roll result. Read by the sim + clients; NEVER re-rolled.
export interface FloorDescriptor {
  floorIndex: number;
  playerCountAtLock: number;
  mutators: string[]; // ≤ FLOOR_CAPS.maxMutators, capped + density-vetoed at generation
  eliteAffixes: EliteAffixRoll[]; // one entry per rolled slot, by ascending ordinal
  bossAffix: string | null; // ≤1, boss floors past F30 only
  // The density veto's decision, frozen for the controller + the golden: the projected pressure
  // after capping, the budget it was checked against, and whether the veto fired.
  densityBudget: number;
  projectedDensity: number;
  isDensityVetoed: boolean;
}

// ---- the resolver: walk the roll-order contract, cap, veto, freeze ----
export function resolveFloorDescriptor(worldSeed: number, floorIndex: number, playerCountAtLock: number): FloorDescriptor {
  const players = Math.max(1, Math.floor(playerCountAtLock));
  const isDeep = floorIndex >= RANDOMNESS_MIN_FLOOR;

  // Contract step 1 — FLOOR_MUTATORS. Draw 0..maxMutators distinct mutators without replacement.
  // F31+: uniform count over the full pool (byte-stable legacy). Pre-F30: the fairness ramp —
  // eligible bag (per-lever first floor; miniboss floors are mild-only) + the floor-keyed P-table.
  const mutators: string[] = [];
  if (isDeep && MUTATOR_POOL.length > 0) {
    const rng = rollStream(worldSeed, floorIndex, RollStream.FLOOR_MUTATORS);
    const count = rng.int(0, FLOOR_CAPS.maxMutators);
    const bag = MUTATOR_POOL.map((m) => m.id);
    for (let k = bag.length - 1; k > 0; k--) {
      const j = rng.int(0, k);
      [bag[k], bag[j]] = [bag[j], bag[k]];
    }
    for (let i = 0; i < count && i < bag.length; i++) mutators.push(bag[i]);
  } else if (!isDeep && MUTATOR_POOL.length > 0) {
    // The count weights table is the calm gate: F1, boss floors (F5/10/…/30), the F10 gauntlet and
    // the post-boss openers (F6/11/16/21/26) are absent from it, so they never roll (P(0)=100%).
    const weights = PRE_F30_MUTATOR_P[floorIndex];
    if (weights !== undefined) {
      const isMini = isMinibossFloor(floorIndex);
      const bag = MUTATOR_POOL
        .map((m) => m.id)
        .filter((id) => floorIndex >= MUTATOR_FIRST_FLOOR[id] && (!isMini || MILD_MUTATORS.indexOf(id) !== -1));
      if (bag.length > 0) {
        const rng = rollStream(worldSeed, floorIndex, RollStream.FLOOR_MUTATORS);
        const r = rng.next();
        let count = r < weights[0] ? 0 : r < weights[0] + weights[1] ? 1 : 2;
        count = Math.min(count, FLOOR_CAPS.maxMutators, bag.length);
        for (let k = bag.length - 1; k > 0; k--) {
          const j = rng.int(0, k);
          [bag[k], bag[j]] = [bag[j], bag[k]];
        }
        for (let i = 0; i < count; i++) mutators.push(bag[i]);
      }
    }
  }

  // Contract step 2 — ENCOUNTER_DECK. The Gate 1 per-region roster draw consumes this stream
  // (roster.ts, rollStream(seed, floor, ENCOUNTER_DECK)); the descriptor does not duplicate the
  // roster, but the step's POSITION in the contract is fixed here so appended systems land after
  // it. Reserving the position keeps the contract honest and the golden order-sensitive.

  // Contract step 3 — ELITE_AFFIXES, by ascending spawn ordinal. One roll per slot; each slot
  // gets its own ordinal sub-key so slot N is stable no matter how many slots exist.
  const eliteAffixes: EliteAffixRoll[] = [];
  if (isDeep && ELITE_AFFIX_POOL.length > 0) {
    for (let ordinal = 0; ordinal < FLOOR_CAPS.eliteAffixSlots; ordinal++) {
      const rng = rollStream(worldSeed, floorIndex, RollStream.ELITE_AFFIXES, ordinal);
      // Each slot has a 50% chance of a rolled affix (else null); ≤1 affix per elite is inherent
      // (one roll per ordinal). The slot maps to the elite spawned at that ascending ordinal.
      const affix = rng.chance(0.5) ? ELITE_AFFIX_POOL[rng.int(0, ELITE_AFFIX_POOL.length - 1)] : null;
      eliteAffixes.push({ ordinal, affix });
    }
  } else if (!isDeep && !isBossFloor(floorIndex) && floorIndex >= AFFIX_MIN_FLOOR && ELITE_AFFIX_POOL.length > 0) {
    // Pre-F30 ramp (§4): mild-first eligible pool + a per-band rate, miniboss floors capped to ONE
    // slot. Boss floors stay clean — their elites (and thus affixes) are inert (spawn early-returns).
    const pool = ELITE_AFFIX_POOL.filter((id) => floorIndex >= AFFIX_FIRST_FLOOR[id]);
    const rate = preF30AffixRate(floorIndex);
    const slots = isMinibossFloor(floorIndex) ? 1 : FLOOR_CAPS.eliteAffixSlots;
    for (let ordinal = 0; ordinal < slots; ordinal++) {
      const rng = rollStream(worldSeed, floorIndex, RollStream.ELITE_AFFIXES, ordinal);
      const affix = rng.chance(rate) ? pool[rng.int(0, pool.length - 1)] : null;
      eliteAffixes.push({ ordinal, affix });
    }
  }

  // Contract step 4 — BOSS_AFFIX. Only a boss floor past F30 rolls one extra telegraphed pattern.
  let bossAffix: string | null = null;
  if (isDeep && isBossFloor(floorIndex) && BOSS_AFFIX_POOL.length > 0) {
    const rng = rollStream(worldSeed, floorIndex, RollStream.BOSS_AFFIX);
    if (rng.chance(0.5)) bossAffix = BOSS_AFFIX_POOL[rng.int(0, BOSS_AFFIX_POOL.length - 1)];
  }

  // ---- the density controller's DETERMINISTIC veto (a pure function of seed+floor+players) ----
  // Project the rolled mutators' 4P telegraph/FX pressure; if it exceeds the locked budget, drop
  // the LOWEST-priority mutator (authored-priority veto) until it fits. Pure + reproducible: same
  // seed+floor+players => same veto on every client.
  const budget = densityBudgetFor(players);
  const weightOf = (id: string): number => MUTATOR_POOL.find((m) => m.id === id)?.densityWeight ?? 0;
  const priorityOf = (id: string): number => MUTATOR_POOL.find((m) => m.id === id)?.priority ?? 0;
  const density = (ids: readonly string[]): number => ids.reduce((s, id) => s + weightOf(id), 0);
  let isDensityVetoed = false;
  while (density(mutators) > budget && mutators.length > 0) {
    let worst = 0;
    for (let i = 1; i < mutators.length; i++) {
      if (priorityOf(mutators[i]) < priorityOf(mutators[worst])) worst = i;
    }
    mutators.splice(worst, 1);
    isDensityVetoed = true;
  }

  return {
    floorIndex,
    playerCountAtLock: players,
    mutators,
    eliteAffixes,
    bossAffix,
    densityBudget: budget,
    projectedDensity: density(mutators),
    isDensityVetoed,
  };
}

// The roll-order contract as data, re-exported for the golden test's structural lock.
export { ROLL_ORDER };
export type { RollStreamId };
