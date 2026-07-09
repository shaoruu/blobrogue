// The render-contract facing + clip-selection system (Ian + AD, art/render contract):
// every mob/boss faces its movement direction with persistent 4-way facing (down/up/side,
// side mirrored for left), attack intent overrides movement while a committed move
// telegraphs, and directional sheets resolve through a fixed fallback ladder so AD assets
// drop in with zero further architecture changes. Pure data + math — no DOM — so the
// whole contract is unit-testable (test/facing.test.ts).

import type { Enemy, AttackMove, AttackPhase } from "../sim/types.js";

export type Facing4 = "down" | "up" | "side";

// Per-entity persistent facing. `isMirrored` is the L/R memory: it drives the side
// sheet's mirror AND remains the legacy 1-D flip for sprites without directional art,
// so existing enemies keep their exact current look.
export interface FacingState {
  facing: Facing4;
  isMirrored: boolean;
}

export function createFacing(): FacingState {
  return { facing: "down", isMirrored: false };
}

// px/s below which facing holds its last value — knockback dribbles, interpolation noise
// and idle drift can never twitch a body around (≈ the old 0.6px-per-60Hz-frame rule).
export const FACING_DEADZONE = 36;
// How decisively the OTHER axis must lead before it steals the facing. Without this, a
// 45° walk flips between down and side every frame the ratio wobbles across 1.
export const FACING_AXIS_BIAS = 1.25;

export function updateFacing(f: FacingState, vx: number, vy: number): void {
  const ax = Math.abs(vx), ay = Math.abs(vy);
  if (ax < FACING_DEADZONE && ay < FACING_DEADZONE) return;
  // The L/R memory follows any committed horizontal motion, whatever the facing axis.
  if (ax >= FACING_DEADZONE) f.isMirrored = vx < 0;
  if (f.facing === "side") {
    if (ay > ax * FACING_AXIS_BIAS && ay >= FACING_DEADZONE) f.facing = vy >= 0 ? "down" : "up";
  } else if (ax > ay * FACING_AXIS_BIAS && ax >= FACING_DEADZONE) {
    f.facing = "side";
  } else if (ay >= FACING_DEADZONE) {
    f.facing = vy >= 0 ? "down" : "up";
  }
}

// Snap facing to an explicit intent angle (no deadzone — an aim is always meaningful).
export function facingFromAngle(f: FacingState, angle: number): void {
  const c = Math.cos(angle), s = Math.sin(angle);
  if (Math.abs(c) >= Math.abs(s)) {
    f.facing = "side";
    f.isMirrored = c < 0;
  } else {
    f.facing = s >= 0 ? "down" : "up";
  }
}

// Which moves carry a real aim the body should FACE while charging/executing. Non-aimed
// moves (roars, fades, spins, stuns…) keep the movement-derived facing. A Record over
// AttackMove so adding a move without deciding this is a compile error.
export const AIMED_MOVES: Readonly<Record<AttackMove, boolean>> = {
  none: false,
  lunge: true, spit: true, hopslam: true, radial: false, roar: false, squeeze: false,
  rush: true, crash: false, dive: false, erupt: false, volley: true, spin: false, shield: false,
  fade: false, wail: true, split: false, pounce: true, weave: true, slam: true, sweep: false,
};

// The renderer-facing pose contract: everything a draw pass (or the AD's sheet set)
// needs about a body this frame — 4-way facing, motion, and the attack/telegraph state
// (move, phase, 0..1 windup charge, aim) so bosses expose their commitments, never only
// a generic walk.
export interface EnemyPose {
  facing: Facing4;
  isMirrored: boolean;
  isMoving: boolean;
  isAttacking: boolean;
  move: AttackMove;
  phase: AttackPhase;
  windup: number;
  aimAngle: number;
}

// `vx/vy` is the client's observed velocity (position deltas / interpolation), px/s.
// Mutates `f` — the persistent facing memory — and returns the frame's pose.
export function computeEnemyPose(e: Enemy, f: FacingState, vx: number, vy: number, isMoving: boolean): EnemyPose {
  const a = e.attack;
  const isAttacking = a.move !== "none" && (a.phase === "windup" || a.phase === "active");
  if (isAttacking && AIMED_MOVES[a.move]) facingFromAngle(f, a.lockedAngle);
  else updateFacing(f, vx, vy);
  return {
    facing: f.facing,
    isMirrored: f.isMirrored,
    isMoving,
    isAttacking,
    move: a.move,
    phase: a.phase,
    windup: a.windup,
    aimAngle: isAttacking && AIMED_MOVES[a.move] ? a.lockedAngle : Math.atan2(vy, vx),
  };
}

// ---- clip resolution (the AD drop-in ladder) ----

// Directional sheet convention: `<sprite>_walk_down.png` / `_walk_up.png` / `_walk_side.png`
// (side authored facing RIGHT; the renderer mirrors for left; frame 0 doubles as the idle
// pose), plus optional `<sprite>_attack[_dir].png` windup/strike sheets.
export type DirectionalClip =
  | "walk_down" | "walk_up" | "walk_side"
  | "attack_down" | "attack_up" | "attack_side" | "attack";

// Every clip the selection ladder can request (the "death" one-shot lives outside the
// ladder — corpses are their own render pass).
export type SelectableClip = "idle" | "walk" | DirectionalClip;

export interface ClipChoice {
  clip: SelectableClip;      // absent sheets additionally fall through in drawChar
  isMirrored: boolean;       // horizontal flip the draw should apply
  isHoldFirstFrame: boolean; // directional sheets: hold frame 0 as the idle pose
}

// Resolve the best available clip for a pose against whatever sheets have actually
// loaded, degrading one deliberate step at a time:
//   attack_<facing>  ->  attack  ->  walk_<facing> (frame 0 idles)  ->  legacy walk/idle
//   ->  static base sprite + procedural juice (today's look, untouched).
// Directional art only mirrors on side-left; legacy art keeps the persistent 1-D mirror
// existing enemies have always used.
export function resolveClip(hasClip: (clip: SelectableClip) => boolean, pose: EnemyPose): ClipChoice {
  const isSideMirror = pose.facing === "side" && pose.isMirrored;
  if (pose.isAttacking) {
    const dirAttack: SelectableClip = `attack_${pose.facing}`;
    if (hasClip(dirAttack)) return { clip: dirAttack, isMirrored: isSideMirror, isHoldFirstFrame: false };
    if (hasClip("attack")) return { clip: "attack", isMirrored: isSideMirror, isHoldFirstFrame: false };
  }
  const dirWalk: SelectableClip = `walk_${pose.facing}`;
  if (hasClip(dirWalk)) return { clip: dirWalk, isMirrored: isSideMirror, isHoldFirstFrame: !pose.isMoving };
  // Legacy tier: exactly the pre-contract behavior for sprites without directional art.
  const legacy: SelectableClip = pose.isMoving ? "walk" : "idle";
  return { clip: legacy, isMirrored: pose.isMirrored, isHoldFirstFrame: false };
}
