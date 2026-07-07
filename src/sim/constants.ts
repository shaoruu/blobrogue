// Simulation tuning constants. These drive gameplay logic in stepWorld and must live
// with the sim (node + browser). Cosmetic magnitudes (trauma/freeze amounts, recoil,
// camera kick, tints, sprite tables) stay client-side in game.ts.

import type { WeaponId, PropKind } from "./types.js";

export const HALF_PI = Math.PI / 2;

// Pathfinding rebuild throttle.
export const FLOW_REBUILD = 0.2;

// Slime hop cadence (speed pulse synced to its squash clock; mean 1x -> balance intact).
export const SLIME_HOP_FREQ = 3.4;
export const SLIME_HOP_AMOUNT = 0.55;

// Anti-stuck nudge for wedged chasers.
export const STUCK_TIME = 0.4;
export const STUCK_PROGRESS = 0.5;
export const STUCK_MIN_STEP = 0.05;

export const BOSS_MINION_CAP = 14;
export const DASH_COOLDOWN = 0.7;
export const BASE_MAX_HP = 6;
export const MIN_MULTI_SPREAD = 0.26;
export const COIN_MAGNET_PULL = 300;

// Enemy knockback impulse.
export const WEAPON_KB: Record<WeaponId, number> = {
  pistol: 4, shotgun: 8, rapid: 2,
  smg: 2, cannon: 14, burst: 3, ricochet: 5, homing: 2, tesla: 3,
  sawnoff: 10, railgun: 12, nailer: 3, flamer: 1,
  sword: 14, longsword: 20, spear: 16,
};
export const KB_LAMBDA = 16;
export const KB_MAX_SPEED = 520;
export const MELEE_THRUST_WIDTH = 18;

// Weapon self-knockback (shoves the firing player) — a real sim position change.
export const FIRE_KNOCKBACK: Record<WeaponId, number> = {
  pistol: 0, shotgun: 22, rapid: 0,
  smg: 0, cannon: 10, burst: 0, ricochet: 0, homing: 0, tesla: 0,
  sawnoff: 26, railgun: 6, nailer: 0, flamer: 0,
  sword: 0, longsword: 0, spear: 8,
};

// Point-blank shotgun hit distance that triggers the (client-side) freeze.
export const SHOTGUN_FREEZE_RANGE = 96;

// Elemental status.
export const BURN_TICK = 0.25;
export const BURN_DMG_STACK = 2;
export const BURN_DMG_MAX = 6;
export const CHILL_SLOW = 0.5;
export const CHILL_MAX = 4;
export const FREEZE_AT = 3;
export const FROZEN_DMG_MULT = 1.5;
export const SHOCK_DMG_MULT = 1.25;
export const SHOCK_ARC_RANGE = 130;
export const SHOCK_ARC_DMG = 1;
export const ITEM_BURN_SECS = 2;
export const ITEM_CHILL_SECS = 1.2;
export const ITEM_SHOCK_SECS = 2;
export const BARREL_BURN_SECS = 2;

// Skeleton lunge.
export const SKELETON_TRIGGER = 200;
export const SKELETON_WINDUP = 0.55;
export const SKELETON_LOCK = 0.35;
export const SKELETON_LUNGE_DUR = 0.28;
export const SKELETON_LUNGE_SPEED = 520;
export const SKELETON_RECOVER = 0.5;
export const SKELETON_CD = 2.0;

// Spitter caster.
export const SPITTER_FLEE = 160;
export const SPITTER_APPROACH = 420;
export const SPITTER_WINDUP = 0.7;
export const SPITTER_LOCK = 0.45;
export const SPITTER_RECOVER = 0.3;
export const SPITTER_CD = 1.8;
export const SPITTER_SPREAD_FLOOR = 4;
export const GLOB_SPREAD = 0.18;

// Ghost solidify.
export const GHOST_SOLID_RANGE = 120;
export const GHOST_SOLID_TIME = 0.4;
export const GHOST_SOLID_AT = 0.98;

// Boss Slime King.
export const BOSS_SLAM_RADIUS = 90;
export const BOSS_ROAR_DUR = 0.8;
export const BOSS_HOPSLAM_WINDUP = 0.6;
export const BOSS_HOPSLAM_LOCK = 0.3;
export const BOSS_HOPSLAM_AIR = 0.5;
export const BOSS_HOPSLAM_RECOVER = 0.7;
export const BOSS_RADIAL_WINDUP = 0.8;
export const BOSS_RADIAL_RECOVER = 0.6;
export const BOSS_RADIAL_COUNT = 8;
export const BOSS_ATTACK_CD = [0, 3.5, 2.8, 2.2]; // indexed by phase 1..3
export const BOSS_MINION_CD = 3.4;

// Destructible props + chests.
export const PROP_RADIUS = 15;
export const PROP_HP: Record<PropKind, number> = {
  crate: 4, pot: 1, barrel: 3, barrel_explosive: 3, brazier: 0,
};
export const PROP_BREAK_DUR = 0.25;
export const CHEST_OPEN_DUR = 0.4;
export const BARREL_EXPLOSION_RADIUS = 70;
export const BARREL_EXPLOSION_DAMAGE = 6;
export const BARREL_EXPLOSION_SELF_DMG = 2;

// Kill-chain combo. The multiplier is sim (drives coin value); the color is a HUD accent
// (client) kept here so the tiers have a single source of truth.
export const COMBO_WINDOW = 3;
export const COMBO_MAX_MULT = 3;
export interface ComboTier { min: number; mult: number; color: string; }
export const COMBO_TIERS: ComboTier[] = [
  { min: 20, mult: 3, color: "#ff3a3a" },
  { min: 10, mult: 2, color: "#ff8a3b" },
  { min: 5, mult: 1.5, color: "#ffd166" },
  { min: 0, mult: 1, color: "#d9d2c0" },
];

export function comboTierFor(combo: number): ComboTier {
  for (const t of COMBO_TIERS) if (combo >= t.min) return t;
  return COMBO_TIERS[COMBO_TIERS.length - 1];
}
