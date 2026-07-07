import type { Enemy, EnemyKind } from "./types.js";
import type { SpriteName } from "./assets.js";
import type { Dungeon } from "./dungeon.js";
import { TILE } from "./types.js";
import { Rng } from "./rng.js";
import { createAnim } from "./anim.js";

export type Movement = "chase" | "zigzag" | "drift" | "kite" | "boss";

// Seconds a freshly-spawned enemy stays passive before it may start a windup, so
// boss-spat adds (or a room's mob on entry) never telegraph-and-hit on frame one.
export const SPAWN_GRACE = 0.8;

export interface EnemyArchetype {
  kind: EnemyKind;
  sprite: SpriteName;
  movement: Movement;
  isPhasing: boolean; // ghosts drift through geometry
  radius: number;
  drawSize: number;     // sprite draw size in px
  alpha: number;        // render opacity (ghost is semi-transparent)
  tint: string;         // gib / impact-puff color for this enemy
  kbResist: number;     // knockback divisor — heavier things budge less (boss ~unmovable)
  baseHp: number;
  hpPerFloor: number;
  baseSpeed: number;
  speedPerFloor: number;
  touchDamage: number;
}

export const ENEMY_ARCHETYPES: Record<EnemyKind, EnemyArchetype> = {
  slime: {
    kind: "slime", sprite: "slime", movement: "chase", isPhasing: false,
    radius: 16, drawSize: 44, alpha: 1, tint: "#a855f7", kbResist: 1,
    baseHp: 3, hpPerFloor: 0.6, baseSpeed: 42, speedPerFloor: 3, touchDamage: 1,
  },
  bat: {
    kind: "bat", sprite: "bat", movement: "zigzag", isPhasing: false,
    radius: 13, drawSize: 40, alpha: 1, tint: "#9aa4bf", kbResist: 0.7,
    baseHp: 2, hpPerFloor: 0.3, baseSpeed: 96, speedPerFloor: 4, touchDamage: 1,
  },
  skeleton: {
    kind: "skeleton", sprite: "skeleton", movement: "chase", isPhasing: false,
    radius: 15, drawSize: 46, alpha: 1, tint: "#e8e0cf", kbResist: 1.6,
    baseHp: 6, hpPerFloor: 0.9, baseSpeed: 62, speedPerFloor: 3, touchDamage: 1,
  },
  ghost: {
    kind: "ghost", sprite: "ghost", movement: "drift", isPhasing: true,
    radius: 15, drawSize: 46, alpha: 0.62, tint: "#bfe9ff", kbResist: 1.1,
    baseHp: 4, hpPerFloor: 0.6, baseSpeed: 56, speedPerFloor: 3, touchDamage: 1,
  },
  // Glass-cannon ranged caster. Kites the player and lobs projectiles on a telegraph.
  // TODO(art): using beetle.png as a placeholder body — the art director is making a
  // dedicated bright-caster Spitter sprite (distinct from the purple boss).
  spitter: {
    kind: "spitter", sprite: "spitter", movement: "kite", isPhasing: false,
    radius: 15, drawSize: 42, alpha: 1, tint: "#ff5a7a", kbResist: 0.8,
    baseHp: 3, hpPerFloor: 0.5, baseSpeed: 30, speedPerFloor: 1, touchDamage: 1,
  },
  boss: {
    kind: "boss", sprite: "boss", movement: "boss", isPhasing: false,
    radius: 34, drawSize: 100, alpha: 1, tint: "#ffb43b", kbResist: 6,
    baseHp: 42, hpPerFloor: 7, baseSpeed: 34, speedPerFloor: 1.5, touchDamage: 2,
  },
};

export const BOSS_EVERY = 5;
export function isBossFloor(floor: number): boolean {
  return floor % BOSS_EVERY === 0;
}

// The seeded sim Rng supplies the bat's initial `zig` heading so enemy creation is
// deterministic (golden-master oracle + later prediction). spawnFloorEnemies passes its
// own per-floor Rng; runtime spawns (boss minions, dev) pass the live world Rng.
export function createEnemy(kind: EnemyKind, x: number, y: number, floor: number, rng: Rng): Enemy {
  const a = ENEMY_ARCHETYPES[kind];
  const hp = Math.round(a.baseHp + a.hpPerFloor * (floor - 1));
  const isBoss = kind === "boss";
  // Seed the anim clock from the sim Rng (not Math.random): the slime's hop-cadence reads
  // this clock, so it must be deterministic. The clock still desyncs each enemy (so a room
  // of blobs doesn't bob in lockstep) but now reproducibly.
  const anim = createAnim();
  anim.clock = rng.next() * 10;
  return {
    kind, x, y, vx: 0, vy: 0,
    radius: a.radius,
    hp, maxHp: hp, dead: false,
    speed: a.baseSpeed + a.speedPerFloor * (floor - 1),
    touchDamage: a.touchDamage,
    zig: rng.next() * Math.PI * 2,
    spawnTimer: SPAWN_GRACE,
    stuckTimer: 0,
    burn: 0, burnDmg: 0, chill: 0, shock: 0, statusTick: 0,
    anim,
    attack: {
      phase: "none", time: 0, move: "none", windup: 0,
      // The boss waits a beat after its dramatic entrance before its first slam.
      cooldown: isBoss ? 1.2 : 0,
      lockedAngle: 0, isAimLocked: false, markX: 0, markY: 0,
    },
    boss: isBoss ? { phase: 1, minionTimer: 3, isNextRadial: false, burstParity: 0 } : null,
  };
}

function floorRoster(floor: number): Array<{ kind: EnemyKind; weight: number }> {
  const roster: Array<{ kind: EnemyKind; weight: number }> = [{ kind: "slime", weight: 5 }];
  if (floor >= 2) {
    roster.push({ kind: "bat", weight: 3 });
    roster.push({ kind: "skeleton", weight: 2 });
    // Ranged threat: rare on floor 2 (a gentle intro) and a bit more common from floor 3
    // once the player has learned to dodge the melee lunge.
    roster.push({ kind: "spitter", weight: floor >= 3 ? 2 : 1 });
  }
  if (floor >= 3) roster.push({ kind: "ghost", weight: 2 });
  return roster;
}

function weightedPick(rng: Rng, roster: Array<{ kind: EnemyKind; weight: number }>): EnemyKind {
  const total = roster.reduce((s, r) => s + r.weight, 0);
  let roll = rng.next() * total;
  for (const r of roster) {
    roll -= r.weight;
    if (roll <= 0) return r.kind;
  }
  return roster[roster.length - 1].kind;
}

function pointInRoom(rng: Rng, dungeon: Dungeon, roomIndex: number): { x: number; y: number } {
  const room = dungeon.rooms[roomIndex];
  const x = (room.x + 1 + rng.next() * Math.max(1, room.w - 2)) * TILE;
  const y = (room.y + 1 + rng.next() * Math.max(1, room.h - 2)) * TILE;
  return { x, y };
}

export function spawnFloorEnemies(dungeon: Dungeon, seed: number, floor: number): Enemy[] {
  const rng = new Rng((seed ^ 0x9e3779b9) + floor * 2654435761);
  const enemies: Enemy[] = [];
  const roomCount = dungeon.rooms.length;
  if (roomCount <= 1) return enemies;

  if (isBossFloor(floor)) {
    // Boss lives in the last room (next to the exit). A few slimes for company.
    const bossRoom = roomCount - 1;
    const b = pointInRoom(rng, dungeon, bossRoom);
    enemies.push(createEnemy("boss", b.x, b.y, floor, rng));
    const minions = 2 + Math.floor(floor / BOSS_EVERY);
    for (let i = 0; i < minions; i++) {
      const roomIndex = 1 + rng.int(0, roomCount - 2);
      const p = pointInRoom(rng, dungeon, roomIndex);
      enemies.push(createEnemy("slime", p.x, p.y, floor, rng));
    }
    return enemies;
  }

  const roster = floorRoster(floor);
  // Pace keeps ramping into deeper floors (early floors unchanged); the real
  // difficulty now comes from telegraphed attacks rather than raw enemy count.
  const count = Math.min(3 + floor, 14);
  for (let i = 0; i < count; i++) {
    const roomIndex = 1 + rng.int(0, roomCount - 2);
    const p = pointInRoom(rng, dungeon, roomIndex);
    enemies.push(createEnemy(weightedPick(rng, roster), p.x, p.y, floor, rng));
  }
  return enemies;
}
