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

export type EnemyKind = "slime" | "bat" | "skeleton" | "ghost" | "boss";

export interface Enemy extends Entity {
  kind: EnemyKind;
  speed: number;
  touchDamage: number;
  // Per-behavior scratch state.
  zig: number;         // heading offset used by the bat's erratic drift
  spawnTimer: number;  // boss: countdown until it spits out a minion
  anim: Anim;
}

export type WeaponId = "pistol" | "shotgun" | "rapid";

export interface Bullet {
  x: number; y: number;
  vx: number; vy: number;
  radius: number;
  life: number;
  friendly: boolean;
  damage: number;
  color: string;
}

export type PickupKind = "heart" | "coin" | "weapon";

export interface Pickup {
  kind: PickupKind;
  x: number; y: number;
  radius: number;
  weapon: WeaponId | null; // set only when kind === "weapon"
  anim: Anim;
}

export interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  color: string;
  size: number;
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
