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
};

export const DEFAULT_WEAPON: WeaponId = "pistol";

// Weapons that can appear as floor pickups (the pistol is the always-owned default).
export const PICKUP_WEAPONS: readonly WeaponId[] = ["shotgun", "rapid"];

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
    });
  }
  return shots;
}
