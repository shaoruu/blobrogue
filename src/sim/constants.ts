// Simulation ENGINE constants: mechanical tuning that drives stepWorld but is not part of
// the balance contract (that lives in balance.ts — the versioned BalanceDef). Cosmetic
// magnitudes (trauma/freeze amounts, recoil, camera kick, tints, sprite tables) stay
// client-side in game.ts.

import type { WeaponId, PropKind } from "./types.js";

export const HALF_PI = Math.PI / 2;

// Pathfinding rebuild throttle.
export const FLOW_REBUILD = 0.2;

// Slime hop cadence (speed pulse synced to its squash clock; mean 1x -> balance intact).
export const SLIME_HOP_FREQ = 3.4;
export const SLIME_HOP_AMOUNT = 0.55;

// Bat flock steering (deterministic boids): separation/alignment/cohesion + target
// attraction, blended into a persistent heading (stored in the bat's `zig` scratch) that
// turns at a capped rate — a readable flock, never a stack, never independent beelines.
// The neighbor scan is BOUNDED: same-kind bodies inside FLOCK_RADIUS, first
// FLOCK_MAX_NEIGHBORS in deterministic array order, so cost is O(n·k) with a small k.
export const FLOCK_RADIUS = 90;
export const FLOCK_SEP_RADIUS = 30;
export const FLOCK_MAX_NEIGHBORS = 5;
export const FLOCK_SEP_WEIGHT = 1.7;
export const FLOCK_ALIGN_WEIGHT = 0.5;
export const FLOCK_COHESION_WEIGHT = 0.35;
export const FLOCK_TARGET_WEIGHT = 1.0;
export const FLOCK_TURN_RATE = 7;   // rad/s cap on heading change
export const FLOCK_MIN_SPEED = 0.5; // airspeed floor while the desired pull opposes the heading
export const FLOCK_HARD_CORE = 18;  // px: inside this, separation overrides every other pull

// Anti-stuck nudge for wedged chasers.
export const STUCK_TIME = 0.12;
export const STUCK_PROGRESS = 0.5;
export const STUCK_MIN_STEP = 0.05;

// Local prop avoidance — the FINISHING layer. Routes come from the prop-aware nav fields
// (see nav.ts); this steering only rounds the ring of a prop the current leg happens to
// graze, so it can no longer be trapped by clusters/rows/pockets the route already avoids.
export const AVOID_LOOKAHEAD = 30;   // px past touching distance a chaser anticipates a prop
export const AVOID_CLEARANCE = 5;    // px of extra clearance the detour tangent aims for
export const AVOID_COMMIT = 0.45;    // seconds a chosen detour side persists after the last block
export const AVOID_SIDE_PROBE = 20;  // px beyond the body the side-clearance probes test

// The fraction of a prop's radius that actually blocks movement. Single source of truth
// shared by collision (blockedByProp) and the navigation clearance grid (nav.ts): the
// routes enemies follow must reflect exactly the rings their bodies collide with.
export const PROP_BLOCK_RING = 0.8;

// Inside this range a chaser commits to the direct line whenever it has wall LOS: the
// last prop between the bodies is the tangent steering's job (single-obstacle rounding is
// what it is good at), and melee contact must never be gated on tile-resolution routing.
export const NAV_DIRECT_RANGE = 76;

// Spawn settling (see settleSpawnPoint): how many Chebyshev tile rings the deterministic
// relocation scan walks around an invalid spawn point before giving up and leaving the
// intended point as-is. 8 rings cover any room a floor can generate.
export const SPAWN_SCAN_RINGS = 8;

// How long a pending blessing offer may sit unanswered (sim seconds) before it expires and
// the run moves on without the pick. Matches the server's offer TTL default, and — because
// it ticks on the SIM clock — it can never hold the party's descend gate hostage.
export const BLESSING_OFFER_TTL = 60;

// Mercy window on spawning into a freshly BUILT floor (run start, every descend, run
// reset): no damage can land while the level is still fading in and the player is
// reorienting after the blessing pick. Belt-and-suspenders on top of the enemies' own
// SPAWN_GRACE and the boss's entranceGrace — every foe also begins idle and must telegraph
// its first attack, so nothing can even START an attack inside this window, let alone
// land one. Rides the ordinary post-hit invuln timer (it protects, decays, and renders
// exactly like post-hit protection).
export const PLAYER_SPAWN_GRACE = 1.75;

export const MIN_MULTI_SPREAD = 0.26;

// Enemy knockback impulse.
export const WEAPON_KB: Record<WeaponId, number> = {
  pistol: 4, shotgun: 8, rapid: 2,
  smg: 2, cannon: 14, burst: 3, ricochet: 5, homing: 2, tesla: 3,
  sawnoff: 10, railgun: 12, nailer: 3, flamer: 1, mortar: 6, beam: 1,
  sword: 14, longsword: 20, spear: 16,
};
export const KB_LAMBDA = 16;
export const KB_MAX_SPEED = 520;
export const MELEE_THRUST_WIDTH = 18;

// Weapon self-knockback (shoves the firing player) — a real sim position change.
export const FIRE_KNOCKBACK: Record<WeaponId, number> = {
  pistol: 0, shotgun: 22, rapid: 0,
  smg: 0, cannon: 10, burst: 0, ricochet: 0, homing: 0, tesla: 0,
  sawnoff: 26, railgun: 6, nailer: 0, flamer: 0, mortar: 8, beam: 0,
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

// Skeleton lunge. Aim locks early enough to leave the ≥0.30s post-lock dodge window the
// balance spec (§4) guarantees on every commitment.
export const SKELETON_TRIGGER = 200;
export const SKELETON_WINDUP = 0.55;
export const SKELETON_LOCK = 0.25;
export const SKELETON_LUNGE_DUR = 0.28;
export const SKELETON_LUNGE_SPEED = 520;
export const SKELETON_RECOVER = 0.5;
export const SKELETON_CD = 2.0;

// Spitter caster. Same §4 guarantees: ≥0.30s post-lock dodge, ≥0.35s recovery.
export const SPITTER_FLEE = 160;
export const SPITTER_APPROACH = 420;
export const SPITTER_WINDUP = 0.7;
export const SPITTER_LOCK = 0.4;
export const SPITTER_RECOVER = 0.35;
export const SPITTER_CD = 1.8;
export const SPITTER_SPREAD_FLOOR = 4;
export const GLOB_SPREAD = 0.18;

// Ghost solidify.
export const GHOST_SOLID_RANGE = 120;
export const GHOST_SOLID_TIME = 0.4;
export const GHOST_SOLID_AT = 0.98;

// Charger line rush. A much longer lane than the skeleton's hop-lunge (sidestep, don't
// backpedal), and a wall crash self-stuns for CHARGER_CRASH_STUN — the authored punish
// window. Same §4 guarantees: ≥0.30s post-lock dodge, ≥0.35s recovery.
export const CHARGER_TRIGGER = 320;
export const CHARGER_WINDUP = 0.75;
export const CHARGER_LOCK = 0.4;
export const CHARGER_RUSH_SPEED = 480;
export const CHARGER_RUSH_DUR = 0.85;
export const CHARGER_RECOVER = 0.5;
export const CHARGER_CRASH_STUN = 1.4;
export const CHARGER_CD = 3.0;

// Burrower dive cycle: submerge (untargetable), tunnel to the target at a flat burst speed
// (like the skeleton's flat lunge speed — the commitment, not the walk, is the threat),
// then a marked, telegraphed eruption. Travel is hard-capped so the untargetable window is
// bounded; the eruption marker is armed for the FULL windup (≥0.30s dodge by construction).
export const BURROW_TRIGGER = 380;
export const BURROW_DIVE_WINDUP = 0.45;
// Slightly faster than the player's 200px/s run: walking away from the mound is not an
// answer (that's the point) — dodging the eruption marker is.
export const BURROW_TRAVEL_SPEED = 230;
export const BURROW_MAX_TRAVEL = 1.5;
export const BURROW_EMERGE_DIST = 52;
export const BURROW_ERUPT_WINDUP = 0.6;
export const BURROW_ERUPT_RADIUS = 52;
export const BURROW_POP = 0.22;
export const BURROW_RECOVER = 0.6;
export const BURROW_CD = 3.2;

// Orbiter: circles the target at ring distance, strafing sideways (rotational tracking —
// a different aim problem from the spitter's radial kiting), and stops to fire a quick
// telegraphed bolt. The orbit direction flips on its seeded zig clock.
export const ORBITER_RING = 170;
export const ORBITER_RING_SLACK = 30;
export const ORBITER_FLIP_RATE = 0.45; // zig advance (rad/s); sign of sin(zig) picks the direction
export const ORBITER_WINDUP = 0.6;
export const ORBITER_LOCK = 0.3;
export const ORBITER_RECOVER = 0.5;
export const ORBITER_CD = 2.2;
export const ORBITER_BOLT_SPEED = 380;
export const ORBITER_BOLT_RADIUS = 5;
export const ORBITER_BOLT_LIFE = 1.6;

// Shielder: a walking wall. Bullets arriving inside its front arc are ABSORBED (the
// answer is the flank, melee over the top, or splash) — the arc is anchored on the same
// lockedAngle the wire already carries, so the client renders the exact authoritative
// guard. Its bash is an ordinary short telegraphed lunge.
export const SHIELDER_BLOCK_ARC = 2.1;   // radians of protected frontage (~120°)
export const SHIELDER_TRIGGER = 150;
export const SHIELDER_WINDUP = 0.6;
export const SHIELDER_LOCK = 0.3;
export const SHIELDER_BASH_DUR = 0.22;
export const SHIELDER_BASH_SPEED = 420;
export const SHIELDER_RECOVER = 0.55;
export const SHIELDER_CD = 2.6;

// Destructible props + chests.
export const PROP_RADIUS = 15;
export const PROP_HP: Record<PropKind, number> = {
  crate: 4, pot: 1, barrel: 3, barrel_explosive: 3, brazier: 0,
};
export const PROP_BREAK_DUR = 0.25;
export const CHEST_OPEN_DUR = 0.4;
// Chest loot ejection (see ejectChestLoot). Every drop a chest produces — coin, heart or
// weapon — lands on a candidate ring around the chest, toward the opener. Radii are tried
// inner-to-outer and angles fan out from the opener direction; the fixed candidate order
// keeps every landing spot deterministic across clients and replays.
export const CHEST_EJECT_RADII: readonly number[] = [36, 52, 68];
export const CHEST_EJECT_ANGLES: readonly number[] = [0, 0.6, -0.6, 1.2, -1.2, 2.0, -2.0, Math.PI];
// Preferred minimum spacing between drops of ONE opening (the pleasing spread); dropped
// when space is too tight for it (overlapping loot beats hidden loot).
export const CHEST_LOOT_SEPARATION = 20;
// Last-resort ring at the source chest's rim: peeking out from under the opened chest's
// sprite, ignoring only the source chest's own hide-exclusion — never other chests.
export const CHEST_EJECT_RIM = 24;
// A loot spot must keep this margin of open floor on all four sides so the sprite never
// visually clips into a wall.
export const CHEST_LOOT_WALL_MARGIN = 10;
// Player weapon drop (Q / inventory UI): candidate rings around the dropper, preferred
// toward the aim direction. The inner radius sits beyond pickup range (pr 18 + weapon
// pickup radius 16 = 34), so a stationary dropper never instantly re-collects the drop.
export const WEAPON_DROP_RADII: readonly number[] = [44, 60, 76];
export const BARREL_EXPLOSION_RADIUS = 70;
export const BARREL_EXPLOSION_DAMAGE = 6;
export const BARREL_EXPLOSION_SELF_DMG = 2;

// Lag compensation (Stage C). The world keeps a short ring of past enemy positions so the
// server can rewind a shooter's hit test to where they actually saw the target (their
// render-time view), then apply damage in the present. Bounded to anti-cheat-safe depth: a
// rewind can never reach further back than the history window, and the per-player rewind
// (derived from measured RTT + interp delay) is clamped to LAGCOMP_MAX_TICKS.
export const LAGCOMP_HISTORY = 6;    // stored past ticks (~300ms at 20Hz)
export const LAGCOMP_MAX_TICKS = 6;  // max ticks a hit test may be rewound

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
