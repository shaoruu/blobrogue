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
// so existing enemies keep their exact current look. `lastVertical` remembers the most
// recent down/up facing — the art contract's "nearest approved vertical" for bodies whose
// side profile is blocked (they hold that pose while strafing, never a fake side slide).
export interface FacingState {
  facing: Facing4;
  isMirrored: boolean;
  lastVertical: "down" | "up";
}

export function createFacing(): FacingState {
  return { facing: "down", isMirrored: false, lastVertical: "down" };
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
    if (ay > ax * FACING_AXIS_BIAS && ay >= FACING_DEADZONE) setVertical(f, vy);
  } else if (ax > ay * FACING_AXIS_BIAS && ax >= FACING_DEADZONE) {
    f.facing = "side";
  } else if (ay >= FACING_DEADZONE) {
    setVertical(f, vy);
  }
}

function setVertical(f: FacingState, vy: number): void {
  f.facing = vy >= 0 ? "down" : "up";
  f.lastVertical = f.facing;
}

// Snap facing to an explicit intent angle (no deadzone — an aim is always meaningful).
export function facingFromAngle(f: FacingState, angle: number): void {
  const c = Math.cos(angle), s = Math.sin(angle);
  if (Math.abs(c) >= Math.abs(s)) {
    f.facing = "side";
    f.isMirrored = c < 0;
  } else {
    setVertical(f, s);
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
  // The most recent down/up facing — the "nearest approved vertical" a body with a
  // blocked side profile holds while it strafes.
  verticalFacing: "down" | "up";
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
    verticalFacing: f.lastVertical,
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

// MOVE-SPECIFIC telegraph sheets: a generic attack sheet cannot express a multi-move
// boss (MARROW's charge is not its volley; the Warden's quake is not its sweep), so any
// authored move+phase — `<sprite>.<move>_<phase>[_<facing>]`, e.g. "rush_windup_side" or
// "slam_active" — outranks the generic tiers. Phase includes "recover", so authored
// punish-window poses (the crash stun's dizzy sheet) have a first-class slot too.
export type MovePhaseClip = `${Exclude<AttackMove, "none">}_${Exclude<AttackPhase, "none">}`;
export type MoveClip = MovePhaseClip | `${MovePhaseClip}_${Facing4}`;

// Every clip the selection ladder can request (the "death" one-shot lives outside the
// ladder — corpses are their own render pass).
export type SelectableClip = "idle" | "walk" | DirectionalClip | MoveClip;

export interface ClipChoice {
  clip: SelectableClip;      // absent sheets additionally fall through in drawChar
  isMirrored: boolean;       // horizontal flip the draw should apply
  isHoldFirstFrame: boolean; // directional sheets: hold frame 0 as the idle pose
}

// Resolve the best available clip for a pose against whatever sheets have actually
// loaded, degrading one deliberate step at a time:
//   <move>_<phase>_<facing>  ->  <move>_<phase>  ->  attack_<facing>  ->  attack
//   ->  walk_<facing> (frame 0 idles)  ->  legacy walk/idle
//   ->  static base sprite + procedural juice (today's look, untouched).
// Every tier is optional — a sprite with only a base PNG, only a walk set, one generic
// attack sheet, or a full per-move library all resolve cleanly. Directional art only
// mirrors on side-left; legacy art keeps the persistent 1-D mirror existing enemies have
// always used.
export function resolveClip(hasClip: (clip: SelectableClip) => boolean, pose: EnemyPose): ClipChoice {
  const isSideMirror = pose.facing === "side" && pose.isMirrored;
  if (pose.move !== "none" && pose.phase !== "none") {
    const movePhase: SelectableClip = `${pose.move}_${pose.phase}`;
    const movePhaseFacing: SelectableClip = `${movePhase}_${pose.facing}`;
    if (hasClip(movePhaseFacing)) return { clip: movePhaseFacing, isMirrored: isSideMirror, isHoldFirstFrame: false };
    if (hasClip(movePhase)) return { clip: movePhase, isMirrored: isSideMirror, isHoldFirstFrame: false };
  }
  if (pose.isAttacking) {
    const dirAttack: SelectableClip = `attack_${pose.facing}`;
    if (hasClip(dirAttack)) return { clip: dirAttack, isMirrored: isSideMirror, isHoldFirstFrame: false };
    if (hasClip("attack")) return { clip: "attack", isMirrored: isSideMirror, isHoldFirstFrame: false };
  }
  const dirWalk: SelectableClip = `walk_${pose.facing}`;
  if (hasClip(dirWalk)) return { clip: dirWalk, isMirrored: isSideMirror, isHoldFirstFrame: !pose.isMoving };
  // A blocked/missing SIDE profile holds the nearest approved vertical sheet during
  // horizontal movement (the Warden's art contract: down/up only, never a mirrored side
  // fake or a static slide). Down/up art never mirrors.
  if (pose.facing === "side") {
    const vertWalk: SelectableClip = `walk_${pose.verticalFacing}`;
    if (hasClip(vertWalk)) return { clip: vertWalk, isMirrored: false, isHoldFirstFrame: !pose.isMoving };
  }
  // Legacy tier: exactly the pre-contract behavior for sprites without directional art —
  // except that a MOVING body with no walk sheet keeps its idle loop when one exists
  // (the Hollow Choir's stationary-boss contract: a drifting mass breathes, it never
  // "walks"), rather than dropping all the way to the static base.
  if (pose.isMoving && hasClip("walk")) return { clip: "walk", isMirrored: pose.isMirrored, isHoldFirstFrame: false };
  if (pose.isMoving && !hasClip("idle")) return { clip: "walk", isMirrored: pose.isMirrored, isHoldFirstFrame: false };
  return { clip: "idle", isMirrored: pose.isMirrored, isHoldFirstFrame: false };
}
