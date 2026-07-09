// Difficulty modes — the §1 modifier table of docs/specs/blobrogue_STUDIO_BALANCE_GATE.md,
// as the sim capability the MANDATORY pet balance gates (test/petgate.test.ts) run across.
//
// INTEGRATION NOTE: difficulty modes are OWNER-FACING and ship via PR #34
// (ian/difficulty-modes-dc70), where this exact table lives in balance.ts as
// `DIFFICULTIES` with menu/lobby/ticket plumbing. This module deliberately mirrors that
// PR's shape — same `Difficulty` ids, same field names, same helper signatures, same
// rounding rules — so integrating after difficulty lands is a pure import swap (delete
// this file, point the gates at balance.ts). Rows #34 owns beyond the pet gates' needs
// (blurbs/tints, HP-mult seams, down limits, complex-mover caps) live there.
//
// Standard is the authored baseline: every multiplier is exactly 1 and every helper is an
// identity for it, so all existing worlds — solo, co-op, the authoritative server, the
// golden-master oracle — are bit-for-bit unchanged.

import { REVIVE } from "./balance.js";

export type Difficulty = "casual" | "standard" | "brutal";

export interface DifficultyDef {
  id: Difficulty;
  threatBudgetMult: number;      // floor threat budget (planFloorUnits)
  activeCapMult: number;         // active-threat cap (casual floors w/ min 6; brutal ceils w/ max 18)
  attackCdMult: number;          // enemy AND boss idle attack cooldowns (never tells/recovery)
  reinforceIntervalMult: number; // seconds between reinforcement release waves
  bossAddIntervalMult: number;   // boss recurring add cadence
  bossAddCapDelta: number;       // per-phase live add cap adjustment (clamped to ≥2)
  projectileSpeedMult: number;   // enemy projectile speed (globs; never player bullets)
  hazardMult: number;            // hazard budget (the explosive-prop band lever)
  heartMult: number;             // §2 ambient heart-drop chances (enemy / crate / wood chest)
  bossChestHearts: number;       // hearts the boss chest ejects (the boss heart reward)
  reviveChannel: number;         // seconds an uninterrupted revive hold takes
  reviveHp: number;              // HP a revived player returns at
}

export const DIFFICULTIES: Record<Difficulty, DifficultyDef> = {
  casual: {
    id: "casual",
    threatBudgetMult: 0.80, activeCapMult: 0.85, attackCdMult: 1.15,
    reinforceIntervalMult: 1.25, bossAddIntervalMult: 1.20, bossAddCapDelta: -1,
    projectileSpeedMult: 0.90, hazardMult: 0.65,
    heartMult: 1.25, bossChestHearts: 2, reviveChannel: 1.20, reviveHp: 3,
  },
  standard: {
    id: "standard",
    threatBudgetMult: 1.00, activeCapMult: 1.00, attackCdMult: 1.00,
    reinforceIntervalMult: 1.00, bossAddIntervalMult: 1.00, bossAddCapDelta: 0,
    projectileSpeedMult: 1.00, hazardMult: 1.00,
    // Standard IS the authored baseline — its revive numbers are the balance table's,
    // never a second copy that could drift.
    heartMult: 1.00, bossChestHearts: 1, reviveChannel: REVIVE.channel, reviveHp: REVIVE.hp,
  },
  brutal: {
    id: "brutal",
    threatBudgetMult: 1.20, activeCapMult: 1.15, attackCdMult: 0.85,
    reinforceIntervalMult: 0.85, bossAddIntervalMult: 0.85, bossAddCapDelta: 1,
    projectileSpeedMult: 1.10, hazardMult: 1.30,
    heartMult: 0.80, bossChestHearts: 1, reviveChannel: 1.80, reviveHp: 2,
  },
};

export const DEFAULT_DIFFICULTY: Difficulty = "standard";

export function difficultyThreatBudget(base: number, difficulty: Difficulty): number {
  // Standard passes through untouched (gate §8); scaled modes multiply AFTER summing and
  // round to the nearest 0.5 so budgets stay on the same half-point grid as the §2 threat
  // costs. Party scaling (§4) applies on top.
  if (difficulty === "standard") return base;
  return Math.round(base * DIFFICULTIES[difficulty].threatBudgetMult * 2) / 2;
}

export function difficultyActiveCap(base: number, difficulty: Difficulty): number {
  // §1: casual 0.85× FLOORED with a 6-threat minimum (a mercy cap can never starve the
  // floor's composition); brutal 1.15× CEILED with an 18 ceiling. Standard passes the
  // authored formula through untouched.
  if (difficulty === "casual") return Math.max(6, Math.floor(base * DIFFICULTIES.casual.activeCapMult));
  if (difficulty === "brutal") return Math.min(18, Math.ceil(base * DIFFICULTIES.brutal.activeCapMult));
  return base;
}

export function difficultyBossAddCap(base: number, difficulty: Difficulty): number {
  // §1 "boss add interval / cap": casual −1 (never below 2 — adds are boss mechanics,
  // not optional), brutal +1, standard authored. A zero base (phase 0 slot) stays zero.
  if (base <= 0) return base;
  return Math.max(2, base + DIFFICULTIES[difficulty].bossAddCapDelta);
}
