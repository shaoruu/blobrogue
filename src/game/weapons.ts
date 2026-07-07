import type { Bullet, WeaponId } from "./types.js";

export interface Weapon {
  id: WeaponId;
  name: string;
  fireCd: number;      // seconds between shots
  speed: number;       // bullet speed px/s
  life: number;        // bullet lifetime (doubles as range)
  damage: number;      // per pellet
  pellets: number;
  spread: number;      // total cone width in radians
  bulletRadius: number;
  color: string;
  muzzle: number;      // muzzle-flash particle count
  // Optional bullet behaviors. Absent on the base weapons; each stamps one field onto
  // every bullet it fires (see fire) to switch on an isolated update-loop branch.
  bounce?: number;     // ricochet: wall reflections before the bullet dies
  homing?: number;     // homing: steering turn rate (rad/s)
  chain?: number;      // tesla: lightning jumps after the first hit
  chainRange?: number; // tesla: max px per chain jump
}

export const WEAPONS: Record<WeaponId, Weapon> = {
  pistol: {
    id: "pistol", name: "Pistol", fireCd: 0.16, speed: 560, life: 1.1,
    damage: 2, pellets: 1, spread: 0, bulletRadius: 6, color: "#ffd27a", muzzle: 2,
  },
  shotgun: {
    id: "shotgun", name: "Shotgun", fireCd: 0.52, speed: 500, life: 0.32,
    damage: 1.7, pellets: 5, spread: 0.52, bulletRadius: 5, color: "#ffb43b", muzzle: 6,
  },
  rapid: {
    id: "rapid", name: "Rapid", fireCd: 0.07, speed: 660, life: 0.85,
    damage: 0.9, pellets: 1, spread: 0.07, bulletRadius: 4, color: "#8affe0", muzzle: 1,
  },
  // Tier A — pure data (no engine branches).
  smg: {
    id: "smg", name: "Hornet", fireCd: 0.09, speed: 640, life: 0.9,
    damage: 1.1, pellets: 1, spread: 0.03, bulletRadius: 4, color: "#b6ff6a", muzzle: 1,
  },
  cannon: {
    id: "cannon", name: "Thunderbolt", fireCd: 0.72, speed: 520, life: 1.3,
    damage: 9, pellets: 1, spread: 0, bulletRadius: 11, color: "#ff8a3b", muzzle: 5,
  },
  burst: {
    id: "burst", name: "Triplet", fireCd: 0.34, speed: 680, life: 1.0,
    damage: 2.2, pellets: 3, spread: 0.14, bulletRadius: 4, color: "#6ad0ff", muzzle: 2,
  },
  // Tier B — each carries one optional behavior field stamped onto its bullets.
  ricochet: {
    id: "ricochet", name: "Rebound", fireCd: 0.28, speed: 600, life: 1.6,
    damage: 2.4, pellets: 1, spread: 0.02, bulletRadius: 5, color: "#c98bff", muzzle: 2,
    bounce: 2,
  },
  homing: {
    id: "homing", name: "Wisp", fireCd: 0.16, speed: 420, life: 1.4,
    damage: 1.6, pellets: 1, spread: 0.25, bulletRadius: 5, color: "#8affe0", muzzle: 1,
    homing: 6,
  },
  tesla: {
    id: "tesla", name: "Tesla", fireCd: 0.4, speed: 900, life: 0.5,
    damage: 3, pellets: 1, spread: 0, bulletRadius: 5, color: "#7fe9ff", muzzle: 2,
    chain: 3, chainRange: 130,
  },
};

export const DEFAULT_WEAPON: WeaponId = "pistol";

// Weapons that can appear as floor pickups (the pistol is the always-owned default).
export const PICKUP_WEAPONS: readonly WeaponId[] = [
  "shotgun", "rapid", "smg", "cannon", "burst", "ricochet", "homing", "tesla",
];

// A resolved shot: the base weapon merged with the player's in-run item mods. Built
// once per trigger-pull in the game core so fire() stays a pure geometry helper.
export interface ShotSpec {
  pellets: number;
  spread: number;
  speed: number;
  life: number;
  radius: number;
  color: string;
  damage: number;      // per-pellet damage, already scaled by damage mods
  pierce: number;
  critChance: number;
  critMult: number;
  // Carried straight from the weapon (item mods never touch these) and stamped onto
  // each bullet. Undefined for weapons without the behavior.
  bounce?: number;
  homing?: number;
  chain?: number;
  chainRange?: number;
}

const CRIT_COLOR = "#fff3c4";

export function fire(spec: ShotSpec, x: number, y: number, aim: number): Bullet[] {
  const shots: Bullet[] = [];
  for (let i = 0; i < spec.pellets; i++) {
    const t = spec.pellets === 1 ? 0 : (i / (spec.pellets - 1)) - 0.5;
    const jitter = (Math.random() - 0.5) * (spec.spread * 0.3);
    const a = aim + t * spec.spread + jitter;
    const isCrit = spec.critChance > 0 && Math.random() < spec.critChance;
    shots.push({
      x, y,
      vx: Math.cos(a) * spec.speed,
      vy: Math.sin(a) * spec.speed,
      radius: spec.radius,
      life: spec.life,
      friendly: true,
      damage: isCrit ? spec.damage * spec.critMult : spec.damage,
      color: isCrit ? CRIT_COLOR : spec.color,
      pierce: spec.pierce,
      hitList: null,
      isCrit,
      bounce: spec.bounce,
      homing: spec.homing,
      chain: spec.chain,
      chainRange: spec.chainRange,
    });
  }
  return shots;
}
