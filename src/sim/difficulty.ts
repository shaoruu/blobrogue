// Difficulty modes — the §1 modifier table of docs/specs/blobrogue_STUDIO_BALANCE_GATE.md,
// as a pure sim capability. Modes change CONCURRENT PRESSURE AND RECOVERY only: identical
// enemy/boss HP, identical damage integers, identical telegraphs/locks/recoveries, identical
// loot quality. Standard is the authored experience and every Standard multiplier is exactly
// 1 (and every helper below is identity for it), so all existing worlds — solo, co-op, the
// authoritative server, the golden-master oracle — are bit-for-bit unchanged.
//
// NOT SHIPPED to players: there is deliberately no mode picker, wire field, or persistence —
// the gate spec (§8) forbids shipping modes before the Standard baseline passes its gates.
// The sim-level capability exists so the MANDATORY balance gates (test/petgate.test.ts) can
// exercise pets and pressure across Casual/Standard/Brutal today.
//
// §1 rows with no runtime system on main yet are intentionally absent and land with their
// systems: down limits per floor (no down counter exists), max simultaneous complex movers
// and the hazard release arbiter (no hazard-unit system), and the boss FIRST-add timing
// (addFirstAt stays authored; the mode scales the recurring interval).

import { REVIVE } from "./balance.js";

export type DifficultyMode = "casual" | "standard" | "brutal";

export interface ModeDef {
  threatBudgetMult: number;    // floor threat budget (planFloorUnits)
  attackCdMult: number;        // enemy/boss idle attack cooldowns (telegraphs untouched)
  reinforceMult: number;       // reinforcement release stagger
  bossAddIntervalMult: number; // boss recurring add cadence
  bossAddCapDelta: number;     // boss add cap shift (casual min-clamped to 2)
  projectileSpeedMult: number; // ENEMY projectiles only (spitter globs, boss globs)
  hazardMult: number;          // explosive-prop band on top of the biome hazard bias
  heartRateMult: number;       // ambient heart drops (enemy/crate/wood-chest)
  bossChestHearts: number;     // hearts in the boss completion chest
  reviveChannel: number;       // seconds a revive hold takes
  reviveHp: number;            // HP a revived player returns with
}

export const MODES: Record<DifficultyMode, ModeDef> = {
  casual: {
    threatBudgetMult: 0.80,
    attackCdMult: 1.15,
    reinforceMult: 1.25,
    bossAddIntervalMult: 1.20,
    bossAddCapDelta: -1,
    projectileSpeedMult: 0.90,
    hazardMult: 0.65,
    heartRateMult: 1.25,
    bossChestHearts: 2,
    reviveChannel: 1.2,
    reviveHp: 3,
  },
  standard: {
    threatBudgetMult: 1,
    attackCdMult: 1,
    reinforceMult: 1,
    bossAddIntervalMult: 1,
    bossAddCapDelta: 0,
    projectileSpeedMult: 1,
    hazardMult: 1,
    heartRateMult: 1,
    bossChestHearts: 1,
    // Standard IS the authored baseline — its revive numbers are the balance table's, never
    // a second copy that could drift.
    reviveChannel: REVIVE.channel,
    reviveHp: REVIVE.hp,
  },
  brutal: {
    threatBudgetMult: 1.20,
    attackCdMult: 0.85,
    reinforceMult: 0.85,
    bossAddIntervalMult: 0.85,
    bossAddCapDelta: 1,
    projectileSpeedMult: 1.10,
    hazardMult: 1.30,
    heartRateMult: 0.80,
    bossChestHearts: 1,
    reviveChannel: 1.8,
    reviveHp: 2,
  },
};

// Active-threat cap under a mode. The spec authors the ROUNDING DIRECTION per mode (casual
// rounds down with a floor of 6; brutal rounds up with a ceiling of 18); standard is a pure
// identity so the untouched paths cannot drift by a float op.
export function modeActiveCap(mode: DifficultyMode, baseCap: number): number {
  if (mode === "casual") return Math.max(6, Math.floor(baseCap * 0.85));
  if (mode === "brutal") return Math.min(18, Math.ceil(baseCap * 1.15));
  return baseCap;
}

// Boss add cap under a mode (casual's −1 never drops below the spec's minimum pair).
export function modeBossAddCap(mode: DifficultyMode, baseCap: number): number {
  return Math.max(2, baseCap + MODES[mode].bossAddCapDelta);
}
