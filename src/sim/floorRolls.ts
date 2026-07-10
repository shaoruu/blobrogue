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
import { isBossFloor } from "./enemies.js";

// ---- caps enforced at generation (roadmap "Randomness (Wave 1)") ----
export const FLOOR_CAPS = {
  maxMutators: 2, // ≤2 floor mutators per deep floor
  eliteAffixSlots: 2, // rolled affix slots (≤1 affix per elite is inherent: one roll per ordinal)
  maxBossAffix: 1, // ≤1 boss affix per boss floor
} as const;

// The first floor THE UNMAKING's randomness turns on (post-F30, the Sump onward). Pre-F30 is the
// authored curriculum — no floor mutators, no boss affixes — so its descriptor is empty and its
// golden is trivially stable.
export const RANDOMNESS_MIN_FLOOR = 31;

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

// VISION: denseDark contracts the sight radius. A multiplier the client applies to its hero /
// teammate glow radius; fairness telegraphs are drawn on top and stay full-bright.
export function floorVisionMult(mutators: readonly string[]): number {
  return hasMutator(mutators, "denseDark") ? 0.72 : 1;
}

// DASH TUNING: thinAir makes the dash longer/faster and recover quicker. Read by the shared dash
// step (server sim + client prediction both hold the same descriptor), so a snared player's out
// is unchanged in shape — only its reach/cadence shift.
export interface DashProfile { speedMult: number; activeMult: number; cdMult: number; }
export function floorDashProfile(mutators: readonly string[]): DashProfile {
  if (hasMutator(mutators, "thinAir")) return { speedMult: 1.28, activeMult: 1.18, cdMult: 0.85 };
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
export interface HazardMutation { budgetMult: number; biasKinds: FloorHazardKind[]; }
export function floorHazardMutation(mutators: readonly string[]): HazardMutation {
  let budgetMult = 1;
  const biasKinds: FloorHazardKind[] = [];
  if (hasMutator(mutators, "moltenFloor")) { budgetMult *= 1.5; biasKinds.push("fire_vent"); }
  if (hasMutator(mutators, "fractureStorm")) { budgetMult *= 1.45; biasKinds.push("void_rift"); }
  if (hasMutator(mutators, "amberfall")) { budgetMult *= 1.4; biasKinds.push("toxic_pool"); }
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

  // Contract step 1 — FLOOR_MUTATORS. Roll 0..maxMutators distinct mutators (draw without
  // replacement) on deep floors; pre-F30 rolls none (authored curriculum).
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
      // Half the slots roll an affix (stub cadence); ≤1 affix per elite is inherent.
      const affix = rng.chance(0.5) ? ELITE_AFFIX_POOL[rng.int(0, ELITE_AFFIX_POOL.length - 1)] : null;
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
