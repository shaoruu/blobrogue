export interface Vec2 { x: number; y: number; }

export interface Entity {
  x: number; y: number;
  vx: number; vy: number;
  radius: number;
  hp: number;
  maxHp: number;
  dead: boolean;
}

export interface Enemy extends Entity {
  kind: "slime";
  speed: number;
  touchDamage: number;
  hitFlash: number;
  wobble: number;
}

export interface Bullet {
  x: number; y: number;
  vx: number; vy: number;
  radius: number;
  life: number;
  friendly: boolean;
  damage: number;
}

export interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  color: string;
  size: number;
}

export const TILE = 48;
export type TileKind = 0 | 1; // 0 = floor, 1 = wall
