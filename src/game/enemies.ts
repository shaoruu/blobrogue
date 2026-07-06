import type { Enemy, EnemyKind } from "./types.js";
import type { SpriteName } from "./assets.js";
import type { Dungeon } from "./dungeon.js";
import { TILE } from "./types.js";
import { Rng } from "./rng.js";
import { createAnim } from "./anim.js";

export type Movement = "chase" | "zigzag" | "drift" | "boss";

export interface EnemyArchetype {
  kind: EnemyKind;
  sprite: SpriteName;
  movement: Movement;
  isPhasing: boolean; // ghosts drift through geometry
  radius: number;
  drawSize: number;     // sprite draw size in px
  alpha: number;        // render opacity (ghost is semi-transparent)
  tint: string;         // gib / impact-puff color for this enemy
  baseHp: number;
  hpPerFloor: number;
  baseSpeed: number;
  speedPerFloor: number;
  touchDamage: number;
}

export const ENEMY_ARCHETYPES: Record<EnemyKind, EnemyArchetype> = {
  slime: {
    kind: "slime", sprite: "slime", movement: "chase", isPhasing: false,
    radius: 16, drawSize: 44, alpha: 1, tint: "#a855f7",
    baseHp: 3, hpPerFloor: 0.6, baseSpeed: 42, speedPerFloor: 3, touchDamage: 1,
  },
  bat: {
    kind: "bat", sprite: "bat", movement: "zigzag", isPhasing: false,
    radius: 13, drawSize: 40, alpha: 1, tint: "#9aa4bf",
    baseHp: 2, hpPerFloor: 0.3, baseSpeed: 96, speedPerFloor: 4, touchDamage: 1,
  },
  skeleton: {
    kind: "skeleton", sprite: "skeleton", movement: "chase", isPhasing: false,
    radius: 15, drawSize: 46, alpha: 1, tint: "#e8e0cf",
    baseHp: 6, hpPerFloor: 0.9, baseSpeed: 62, speedPerFloor: 3, touchDamage: 1,
  },
  ghost: {
    kind: "ghost", sprite: "ghost", movement: "drift", isPhasing: true,
    radius: 15, drawSize: 46, alpha: 0.62, tint: "#bfe9ff",
    baseHp: 4, hpPerFloor: 0.6, baseSpeed: 56, speedPerFloor: 3, touchDamage: 1,
  },
  boss: {
    kind: "boss", sprite: "boss", movement: "boss", isPhasing: false,
    radius: 34, drawSize: 100, alpha: 1, tint: "#ffb43b",
    baseHp: 42, hpPerFloor: 7, baseSpeed: 34, speedPerFloor: 1.5, touchDamage: 2,
  },
};

export const BOSS_EVERY = 5;
export function isBossFloor(floor: number): boolean {
  return floor % BOSS_EVERY === 0;
}

export function createEnemy(kind: EnemyKind, x: number, y: number, floor: number): Enemy {
  const a = ENEMY_ARCHETYPES[kind];
  const hp = Math.round(a.baseHp + a.hpPerFloor * (floor - 1));
  return {
    kind, x, y, vx: 0, vy: 0,
    radius: a.radius,
    hp, maxHp: hp, dead: false,
    speed: a.baseSpeed + a.speedPerFloor * (floor - 1),
    touchDamage: a.touchDamage,
    zig: Math.random() * Math.PI * 2,
    spawnTimer: 3,
    anim: createAnim(),
  };
}

function floorRoster(floor: number): Array<{ kind: EnemyKind; weight: number }> {
  const roster: Array<{ kind: EnemyKind; weight: number }> = [{ kind: "slime", weight: 5 }];
  if (floor >= 2) {
    roster.push({ kind: "bat", weight: 3 });
    roster.push({ kind: "skeleton", weight: 2 });
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
    enemies.push(createEnemy("boss", b.x, b.y, floor));
    const minions = 2 + Math.floor(floor / BOSS_EVERY);
    for (let i = 0; i < minions; i++) {
      const roomIndex = 1 + rng.int(0, roomCount - 2);
      const p = pointInRoom(rng, dungeon, roomIndex);
      enemies.push(createEnemy("slime", p.x, p.y, floor));
    }
    return enemies;
  }

  const roster = floorRoster(floor);
  const count = Math.min(3 + floor, 12);
  for (let i = 0; i < count; i++) {
    const roomIndex = 1 + rng.int(0, roomCount - 2);
    const p = pointInRoom(rng, dungeon, roomIndex);
    enemies.push(createEnemy(weightedPick(rng, roster), p.x, p.y, floor));
  }
  return enemies;
}
