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

export function fire(weapon: Weapon, x: number, y: number, aim: number): Bullet[] {
  const shots: Bullet[] = [];
  for (let i = 0; i < weapon.pellets; i++) {
    const t = weapon.pellets === 1 ? 0 : (i / (weapon.pellets - 1)) - 0.5;
    const jitter = (Math.random() - 0.5) * (weapon.spread * 0.3);
    const a = aim + t * weapon.spread + jitter;
    shots.push({
      x, y,
      vx: Math.cos(a) * weapon.speed,
      vy: Math.sin(a) * weapon.speed,
      radius: weapon.bulletRadius,
      life: weapon.life,
      friendly: true,
      damage: weapon.damage,
      color: weapon.color,
    });
  }
  return shots;
}
