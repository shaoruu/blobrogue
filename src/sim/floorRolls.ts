// The frozen FLOOR DESCRIPTOR — Gate 3's resolve-once-at-generation artifact
// (docs/blobrogue_WAVE1_FOUNDATIONS.md). resolveFloorDescriptor runs THE ROLL-ORDER CONTRACT
// (streams.ts) in order, enforces caps at generation, applies the density controller's
// deterministic veto, and returns a frozen descriptor. loadFloorIntoWorld calls it once and
// stores it on WorldState; nothing re-rolls per frame, clients recompute it identically inside
// their own loadFloorIntoWorld (a pure function of seed+floor+playerCountAtLock — the same
// pattern as floorHazards / the encounter deck, so it never rides the wire and PROTOCOL_VERSION
// is unchanged). Reconnect + same-seed replay = identical.
//
// FRAMEWORK ONLY. The mutator / affix pools below are a couple of clearly-marked STUB entries —
// enough to exercise the framework end-to-end and golden-master it. They carry NO sim expression
// yet (no vision / hazard / spawn changes), so existing floors stay byte-identical. Authoring the
// real 6 floor mutators + 5 elite affixes + boss affixes (and wiring their expression) is the
// NEXT build; new pool entries are DATA, and new systems APPEND to the roll-order contract.

import { RollStream, ROLL_ORDER, rollStream } from "./streams.js";
import type { RollStreamId } from "./streams.js";
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

// ---- STUB content pools (framework only — inert, no sim expression yet) ----
// Each carries the minimum metadata the density controller's veto needs: a telegraph-density
// weight (how much per-frame tell/FX pressure it would add at 4P) and a priority (lower = culled
// first under the density veto). Real pools + expression land next build.
export interface MutatorDef {
  id: string;
  densityWeight: number; // projected 4P telegraph/FX pressure this mutator adds
  priority: number; // veto priority (higher survives; lower is dropped/re-rolled first)
}

// TODO(content): replace these two stubs with the authored pool (Dense Dark, Molten Floor,
// Twinned Elites, Fracture Storm, Amberfall, Thin Air) and wire their expression.
export const MUTATOR_POOL: readonly MutatorDef[] = [
  { id: "stubDenseDark", densityWeight: 1, priority: 2 },
  { id: "stubMoltenFloor", densityWeight: 2, priority: 1 },
];

// TODO(content): replace with the authored affix set (splits / shielded / hazard-trail /
// reflect / enrage). null = "this elite slot rolled no affix".
export const ELITE_AFFIX_POOL: readonly string[] = ["stubSplits", "stubShielded"];

// TODO(content): replace with the authored deep boss-affix set (one extra telegraphed pattern).
export const BOSS_AFFIX_POOL: readonly string[] = ["stubExtraPattern"];

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
