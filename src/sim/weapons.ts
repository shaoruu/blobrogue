import type { Bullet, WeaponId } from "./types.js";
import type { Rng } from "./rng.js";

export interface MeleeSpec {
  arc: number;         // swing arc in radians (thrust uses a narrow forward cone)
  reach: number;       // hitbox reach in px from the player center
  isThrust?: boolean;  // spear: line/capsule forward instead of a wide sweep
  swingDur?: number;   // active swing seconds (defaults to 0.2)
}

export interface Weapon {
  id: WeaponId;
  name: string;
  fireCd: number;      // seconds between shots / swings
  speed: number;       // bullet speed px/s (unused on melee)
  life: number;        // bullet lifetime (doubles as range; unused on melee)
  damage: number;      // per pellet / per swing hit
  pellets: number;
  spread: number;      // total cone width in radians
  bulletRadius: number;
  color: string;
  muzzle: number;      // muzzle-flash particle count
  melee?: MeleeSpec;   // present => melee class (swing hitbox, no bullets)
  basePierce?: number;  // intrinsic pass-through count before item pierce
  // Optional bullet behaviors. Absent on the base weapons; each stamps one field onto
  // every bullet it fires (see fire) to switch on an isolated update-loop branch.
  bounce?: number;     // ricochet: wall reflections before the bullet dies
  homing?: number;     // homing: steering turn rate (rad/s)
  chain?: number;      // tesla: lightning jumps after the first hit
  chainRange?: number; // tesla: max px per chain jump
  // Elemental status the weapon stamps on every round (seconds of the effect). The
  // flamethrower is the only base weapon that carries one; item blessings roll the
  // rest at hit time (see PlayerMods.burnChance etc.), so any weapon can go elemental.
  burn?: number;
  chill?: number;
  shock?: number;
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
    basePierce: 2,
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
  // Tier A — pure data. Point-blank devastator: a dense, short-range pellet wall.
  sawnoff: {
    id: "sawnoff", name: "Boomstick", fireCd: 0.62, speed: 440, life: 0.22,
    damage: 2.4, pellets: 8, spread: 0.85, bulletRadius: 5, color: "#ff7a3b", muzzle: 8,
  },
  // Tier A — pure data. Near-hitscan precision slug (pierce comes from the Full Metal item).
  railgun: {
    id: "railgun", name: "Longshot", fireCd: 0.85, speed: 1400, life: 1.6,
    damage: 11, pellets: 1, spread: 0, bulletRadius: 4, color: "#e8f0ff", muzzle: 3,
  },
  // Tier B — reuses the ricochet bounce field: fast full-auto that ricochets once.
  nailer: {
    id: "nailer", name: "Nailer", fireCd: 0.12, speed: 720, life: 1.1,
    damage: 1.4, pellets: 1, spread: 0.05, bulletRadius: 3, color: "#d9d2c0", muzzle: 1,
    bounce: 1,
  },
  // Tier B — carries the `burn` status field. Fast tiny short-life wide puffs read as a
  // continuous flame cone; low per-hit damage but every round stamps burn, so the DoT
  // (and any elemental blessings) do the real work. See the status system in game.ts.
  flamer: {
    id: "flamer", name: "Dragon", fireCd: 0.04, speed: 300, life: 0.28,
    damage: 0.6, pellets: 2, spread: 0.5, bulletRadius: 7, color: "#ff8a3b", muzzle: 2,
    burn: 2,
  },
  sword: {
    id: "sword", name: "Cutlass", fireCd: 0.22, speed: 0, life: 0, damage: 3.5,
    pellets: 1, spread: 0, bulletRadius: 0, color: "#c8e0ff", muzzle: 0,
    melee: { arc: 1.25, reach: 48, swingDur: 0.2 },
  },
  longsword: {
    id: "longsword", name: "Claymore", fireCd: 0.38, speed: 0, life: 0, damage: 6.2,
    pellets: 1, spread: 0, bulletRadius: 0, color: "#d8dce8", muzzle: 0,
    melee: { arc: 1.85, reach: 58, swingDur: 0.25 },
  },
  spear: {
    id: "spear", name: "Pike", fireCd: 0.28, speed: 0, life: 0, damage: 4.8,
    pellets: 1, spread: 0, bulletRadius: 0, color: "#9ee8c8", muzzle: 0,
    melee: { arc: 0.32, reach: 74, isThrust: true, swingDur: 0.18 },
  },
};

export const DEFAULT_WEAPON: WeaponId = "pistol";

// Weapons that can appear as floor pickups (the pistol is the always-owned default).
export const PICKUP_WEAPONS: readonly WeaponId[] = [
  "shotgun", "rapid", "smg", "cannon", "burst", "ricochet", "homing", "tesla",
  "sawnoff", "railgun", "nailer", "flamer",
  "sword", "longsword", "spear",
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
  fx?: WeaponId;       // render recipe tag, stamped onto each bullet (see renderBullets)
  // Carried straight from the weapon (item mods never touch these) and stamped onto
  // each bullet. Undefined for weapons without the behavior.
  bounce?: number;
  homing?: number;
  chain?: number;
  chainRange?: number;
  burn?: number;
  chill?: number;
  shock?: number;
}

const CRIT_COLOR = "#fff3c4";

// The seeded sim Rng is threaded in so pellet jitter + crit rolls are deterministic
// (required for the golden-master oracle and for later client prediction).
export function fire(spec: ShotSpec, x: number, y: number, aim: number, rng: Rng): Bullet[] {
  const shots: Bullet[] = [];
  for (let i = 0; i < spec.pellets; i++) {
    const t = spec.pellets === 1 ? 0 : (i / (spec.pellets - 1)) - 0.5;
    const jitter = (rng.next() - 0.5) * (spec.spread * 0.3);
    const a = aim + t * spec.spread + jitter;
    const isCrit = spec.critChance > 0 && rng.next() < spec.critChance;
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
      fx: spec.fx,
      bounce: spec.bounce,
      homing: spec.homing,
      chain: spec.chain,
      chainRange: spec.chainRange,
      burn: spec.burn,
      chill: spec.chill,
      shock: spec.shock,
    });
  }
  return shots;
}
