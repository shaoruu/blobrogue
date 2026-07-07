import type { Anim } from "./anim.js";

export interface Vec2 { x: number; y: number; }

export interface Entity {
  x: number; y: number;
  vx: number; vy: number;
  radius: number;
  hp: number;
  maxHp: number;
  dead: boolean;
}

export type EnemyKind = "slime" | "bat" | "skeleton" | "ghost" | "spitter" | "boss";

// Telegraphed-attack state machine. Committed attacks read as
// CHASE -> WINDUP (telegraph, aim locks partway) -> ACTIVE -> RECOVER -> cooldown.
export type AttackPhase = "none" | "windup" | "active" | "recover";
// Which move an attacker is mid-executing. The boss owns two; others own one.
export type AttackMove = "none" | "lunge" | "spit" | "hopslam" | "radial" | "roar";

// Grouped so the whole attack subsystem lives in one cohesive place per enemy
// (allocated once at spawn, never per frame).
export interface AttackState {
  phase: AttackPhase;
  time: number;        // seconds elapsed in the current phase
  move: AttackMove;
  windup: number;      // 0..1 telegraph progress; drives tint pulse / aim line / marker
  cooldown: number;    // seconds until this enemy may commit again
  lockedAngle: number; // aim direction captured partway through the windup
  isAimLocked: boolean;// whether lockedAngle has been captured this windup
  markX: number;       // world-space AoE marker point (locked hop-slam tile)
  markY: number;
}

// Boss-only extra state (HP-phase tracking + minion/attack pacing).
export interface BossState {
  phase: number;         // 1..3, driven by HP thresholds
  minionTimer: number;   // countdown until it spits out a slime
  isNextRadial: boolean; // alternates hop-slam / radial-burst in phase 2+
  burstParity: number;   // flips the radial ring offset each burst (0/1)
}

export interface Enemy extends Entity {
  kind: EnemyKind;
  speed: number;
  touchDamage: number;
  // Per-behavior scratch state.
  zig: number;         // heading offset used by the bat's erratic drift
  spawnTimer: number;  // spawn-in grace: counts to 0 before the enemy may attack
  anim: Anim;
  attack: AttackState;
  boss: BossState | null; // set only on the boss
}

export type WeaponId =
  | "pistol" | "shotgun" | "rapid"
  | "smg" | "cannon" | "burst" | "ricochet" | "homing" | "tesla";

export interface Bullet {
  x: number; y: number;
  vx: number; vy: number;
  radius: number;
  life: number;
  friendly: boolean;
  damage: number;
  color: string;
  pierce: number;          // remaining enemies this bullet can punch through
  hitList: Enemy[] | null; // enemies already struck (only allocated for piercing shots)
  isCrit: boolean;         // rolled at fire time; drives the brighter hit feedback
  // Optional per-weapon behaviors. Undefined for the base weapons, so their bullets
  // take the exact same paths they always did.
  bounce?: number;         // ricochet: wall reflections left before the bullet dies
  homing?: number;         // homing: steering turn rate (rad/s) toward the nearest enemy
  chain?: number;          // tesla: lightning jumps left after the first hit
  chainRange?: number;     // tesla: max px a chain jump can reach
}

export type PickupKind = "heart" | "coin" | "weapon";

export interface Pickup {
  kind: PickupKind;
  x: number; y: number;
  radius: number;
  weapon: WeaponId | null; // set only when kind === "weapon"
  anim: Anim;
}

export type ParticleKind = "dot" | "gib" | "spark" | "puff" | "shell";

export interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  color: string;
  size: number;
  kind: ParticleKind;
  rot: number;     // current rotation (rad) — only spun kinds (gib/shell) render rotated
  vr: number;      // angular velocity (rad/s)
  gravity: number; // downward acceleration (px/s²)
  drag: number;    // per-frame velocity multiplier (0.92 == the classic dot puff)
}

// A teammate as the local client sees them (mapped from Convex presence rows).
export interface RemotePlayer {
  playerId: string;
  name: string;
  x: number; y: number;
  facing: number;
  hp: number; maxHp: number;
  weapon: WeaponId;
  floor: number;
  isDown: boolean;
  aimAngle: number;
  shotSeq: number;    // increments each time they fire, so we can flash a tracer
  colorIndex: number; // stable palette slot for this player
  updatedAt: number;
}

export const TILE = 48;
export type TileKind = 0 | 1; // 0 = floor, 1 = wall
