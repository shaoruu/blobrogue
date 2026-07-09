import type { Enemy, EnemyKind, SpriteName } from "./types.js";
import type { Dungeon } from "./dungeon.js";
import { TILE } from "./types.js";
import { Rng } from "./rng.js";
import { biomeIndexForFloor } from "./biomes.js";
import {
  TIERS, BIOME_PRESSURE, BOSS,
  floorHpMult, floorSpeedMult, floorThreat, activeThreatCap, roundHalfToEven,
  bossHpForFloor, coopMobHpMult, coopBossHpMult, coopThreatMult, coopKbResistMult,
  MAX_COMPLEX_PER_ROOM, BRUTE_ELITE_COMBO_FLOOR,
} from "./balance.js";
import type { EnemyTier } from "./balance.js";

export type Movement = "chase" | "zigzag" | "drift" | "kite" | "boss";

// Seconds a freshly-spawned enemy stays passive before it may start a windup, so
// boss-spat adds (or a room's mob on entry) never telegraph-and-hit on frame one.
// Reinforcement releases get the same grace (the timer only ticks once active).
export const SPAWN_GRACE = 0.8;

export interface EnemyArchetype {
  kind: EnemyKind;
  sprite: SpriteName;
  movement: Movement;
  isPhasing: boolean; // ghosts drift through geometry
  radius: number;
  drawSize: number;     // sprite draw size in px (standard tier; tiers scale it)
  alpha: number;        // render opacity (ghost is semi-transparent)
  tint: string;         // gib / impact-puff color for this enemy
  kbResist: number;     // knockback divisor — heavier things budge less (boss ~unmovable)
  baseHp: number;       // floor-1 baseline; per-floor tables in balance.ts scale it
  baseSpeed: number;    // floor-1 baseline px/s
  touchDamage: number;
  threat: number;       // §4 threat-budget cost (simple chaser 1.0, ranged/kiter 1.5)
}

export const ENEMY_ARCHETYPES: Record<EnemyKind, EnemyArchetype> = {
  slime: {
    kind: "slime", sprite: "slime", movement: "chase", isPhasing: false,
    radius: 16, drawSize: 44, alpha: 1, tint: "#a855f7", kbResist: 1,
    baseHp: 3, baseSpeed: 42, touchDamage: 1, threat: 1.0,
  },
  bat: {
    kind: "bat", sprite: "bat", movement: "zigzag", isPhasing: false,
    radius: 13, drawSize: 40, alpha: 1, tint: "#9aa4bf", kbResist: 0.7,
    baseHp: 2, baseSpeed: 96, touchDamage: 1, threat: 1.0,
  },
  skeleton: {
    kind: "skeleton", sprite: "skeleton", movement: "chase", isPhasing: false,
    radius: 15, drawSize: 46, alpha: 1, tint: "#e8e0cf", kbResist: 1.6,
    baseHp: 6, baseSpeed: 62, touchDamage: 1, threat: 1.0,
  },
  ghost: {
    kind: "ghost", sprite: "ghost", movement: "drift", isPhasing: true,
    radius: 15, drawSize: 46, alpha: 0.62, tint: "#bfe9ff", kbResist: 1.1,
    baseHp: 4, baseSpeed: 56, touchDamage: 1, threat: 1.0,
  },
  // Glass-cannon ranged caster. Kites the player and lobs projectiles on a telegraph.
  // TODO(art): using beetle.png as a placeholder body — the art director is making a
  // dedicated bright-caster Spitter sprite (distinct from the purple boss).
  spitter: {
    kind: "spitter", sprite: "spitter", movement: "kite", isPhasing: false,
    radius: 15, drawSize: 42, alpha: 1, tint: "#ff5a7a", kbResist: 0.8,
    baseHp: 3, baseSpeed: 30, touchDamage: 1, threat: 1.5,
  },
  boss: {
    kind: "boss", sprite: "boss", movement: "boss", isPhasing: false,
    radius: 34, drawSize: 100, alpha: 1, tint: "#ffb43b", kbResist: 6,
    baseHp: BOSS.baseHp, baseSpeed: 40, touchDamage: BOSS.contactDamage, threat: 0,
  },
};

// Which archetypes each tier may inhabit: swarms are small fast bodies, brutes are the
// bulky telegraph-hitters (only the skeleton's authored lunge carries the heavy +1).
const SWARM_KINDS: readonly EnemyKind[] = ["slime", "bat"];
const BRUTE_KINDS: readonly EnemyKind[] = ["slime", "skeleton"];

export const BOSS_EVERY = 5;
export function isBossFloor(floor: number): boolean {
  return floor % BOSS_EVERY === 0;
}

// §3 exact tables: HP(f) = roundHalfToEven(baseHP × HPmult(f)), same for speed. Damage
// never scales with floor.
export function enemyHpForFloor(kind: EnemyKind, floor: number): number {
  if (kind === "boss") return bossHpForFloor(floor);
  return roundHalfToEven(ENEMY_ARCHETYPES[kind].baseHp * floorHpMult(floor));
}

export function enemySpeedForFloor(kind: EnemyKind, floor: number): number {
  return roundHalfToEven(ENEMY_ARCHETYPES[kind].baseSpeed * floorSpeedMult(floor));
}

// §4 threat-budget cost of one unit: archetype cost × tier cost.
export function threatCostOf(kind: EnemyKind, tier: EnemyTier): number {
  return ENEMY_ARCHETYPES[kind].threat * TIERS[tier].threatCost;
}

export interface CreateEnemyOpts {
  tier?: EnemyTier;
  isSummoned?: boolean;
  players?: number; // encounter player snapshot (co-op HP/KB scaling); 1 = solo
}

// The seeded sim Rng supplies the bat's initial `zig` heading so enemy creation is
// deterministic (golden-master oracle + later prediction). spawnFloorEnemies passes its
// own per-floor Rng; runtime spawns (boss adds, elite splits, dev) pass the live world Rng.
export function createEnemy(kind: EnemyKind, x: number, y: number, floor: number, rng: Rng, id: number, opts: CreateEnemyOpts = {}): Enemy {
  const a = ENEMY_ARCHETYPES[kind];
  const tier = opts.tier ?? "standard";
  const tierDef = TIERS[tier];
  const players = opts.players ?? 1;
  const isBoss = kind === "boss";
  const hp = isBoss
    ? Math.round((bossHpForFloor(floor) * coopBossHpMult(players)) / 10) * 10
    : Math.max(1, roundHalfToEven(a.baseHp * floorHpMult(floor) * tierDef.hpMult * coopMobHpMult(players)));
  const speed = isBoss
    ? a.baseSpeed
    : roundHalfToEven(a.baseSpeed * floorSpeedMult(floor) * tierDef.speedMult);
  // Seed the slime hop clock from the sim Rng (not Math.random): the slime's hop-cadence
  // reads it, so it must be deterministic. Drawn BEFORE zig to match the historical rng
  // stream order. Still desyncs each enemy, but reproducibly.
  const hopClock = rng.next() * 10;
  return {
    id,
    kind, x, y, vx: 0, vy: 0,
    tier,
    isSummoned: opts.isSummoned ?? false,
    radius: a.radius * tierDef.radiusMult,
    hp, maxHp: hp, dead: false,
    speed,
    touchDamage: a.touchDamage,
    kbResist: a.kbResist * (tier === "brute" ? 2 : 1) * coopKbResistMult(players),
    surgeDelay: 0, surgeTime: 0,
    zig: rng.next() * Math.PI * 2,
    hopClock, hopMove: 0,
    spawnTimer: SPAWN_GRACE,
    stuckTimer: 0,
    avoidSide: 0,
    avoidTime: 0,
    burn: 0, burnDmg: 0, chill: 0, shock: 0, statusTick: 0, burnOwner: null,
    attack: {
      phase: "none", time: 0, move: "none", windup: 0,
      // The boss waits a beat after its dramatic entrance before its first slam.
      cooldown: isBoss ? BOSS.entranceGrace : 0,
      lockedAngle: 0, isAimLocked: false, markX: 0, markY: 0,
    },
    boss: isBoss
      ? { phase: 1, transitionsDone: 0, roar: null, addTimer: BOSS.addFirstAt, attackCount: 0, isNextRadial: false, burstParity: 0 }
      : null,
  };
}

function floorRoster(floor: number, complexShare: number): Array<{ kind: EnemyKind; weight: number }> {
  const roster: Array<{ kind: EnemyKind; weight: number }> = [{ kind: "slime", weight: 5 }];
  if (floor >= 2) {
    roster.push({ kind: "bat", weight: 3 });
    roster.push({ kind: "skeleton", weight: 2 });
    // Ranged threat: rare on floor 2 (a gentle intro) and a bit more common from floor 3
    // once the player has learned to dodge the melee lunge. Sunless raises the complex share.
    roster.push({ kind: "spitter", weight: (floor >= 3 ? 2 : 1) * complexShare });
  }
  if (floor >= 3) roster.push({ kind: "ghost", weight: 2 * complexShare });
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

// A spawn point on OPEN FLOOR inside the room. Rooms carry interior walls now (pillared
// halls, cavern edges, vault rings), so a raw rect sample can land inside geometry;
// resample a few times and fall back to the room center, which the generator guarantees
// open. Deterministic: same seed -> same draw sequence.
function pointInRoom(rng: Rng, dungeon: Dungeon, roomIndex: number): { x: number; y: number } {
  const room = dungeon.rooms[roomIndex];
  for (let attempt = 0; attempt < 12; attempt++) {
    const x = (room.x + 1 + rng.next() * Math.max(1, room.w - 2)) * TILE;
    const y = (room.y + 1 + rng.next() * Math.max(1, room.h - 2)) * TILE;
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (dungeon.tiles[ty * dungeon.w + tx] === 0) return { x, y };
  }
  return { x: (room.cx + 0.5) * TILE, y: (room.cy + 0.5) * TILE };
}

// The floor's spawn set, split into the immediately-active wave and the pending
// reinforcement queue (released by the world when the living threat drops under the cap).
export interface FloorSpawns {
  active: Enemy[];
  pending: Enemy[];
}

interface PlannedUnit {
  kind: EnemyKind;
  tier: EnemyTier;
  room: number;
}

// Per-room composition bookkeeping for the §4 readability guards.
interface RoomLoad {
  complex: number;
  hasBrute: boolean;
  hasElite: boolean;
}

// Flock spacing: swarm-tier units (the boid packs — see flock.ts) need open air to move
// as a flock, so their placement prefers rooms with at least this many open floor tiles.
// Exported so the depth suite can assert the invariant.
export const SWARM_ROOM_MIN_AREA = 30;

function roomOpenArea(dungeon: Dungeon, roomIndex: number): number {
  const room = dungeon.rooms[roomIndex];
  let open = 0;
  for (let ty = room.y; ty < room.y + room.h; ty++) {
    for (let tx = room.x; tx < room.x + room.w; tx++) {
      if (dungeon.tiles[ty * dungeon.w + tx] === 0) open++;
    }
  }
  return open;
}

// Deterministic threat-budget floor composition (§4): spend FloorThreat on a tiered unit
// mix instead of counting bodies. Elites/brutes are planned first (they anchor the opening
// wave); swarm packs and standards fill the remainder and overflow into reinforcements.
function planFloorUnits(rng: Rng, dungeon: Dungeon, floor: number, players: number): PlannedUnit[] {
  const roomCount = dungeon.rooms.length;
  const pressure = BIOME_PRESSURE[biomeIndexForFloor(floor)];
  let budget = floorThreat(floor) * pressure.budgetMult * coopThreatMult(players);
  const roster = floorRoster(floor, pressure.complexShare);
  const plan: PlannedUnit[] = [];

  // Combat rooms: 3–5 of the non-spawn rooms carry the floor's threat.
  const candidates: number[] = [];
  for (let i = 1; i < roomCount; i++) candidates.push(i);
  const combatRoomCount = Math.min(5, Math.max(Math.min(3, candidates.length), Math.floor(candidates.length * 0.75)));
  const combatRooms: number[] = [];
  while (combatRooms.length < combatRoomCount && candidates.length > 0) {
    combatRooms.push(candidates.splice(rng.int(0, candidates.length - 1), 1)[0]);
  }
  const load = new Map<number, RoomLoad>();
  for (const r of combatRooms) load.set(r, { complex: 0, hasBrute: false, hasElite: false });

  // Swarm placement (flock spacing): a boid pack in a cramped cell just grinds the walls.
  // Prefer combat rooms with real open air; fall back to ANY roomy non-spawn room, and
  // only then to the ordinary draw. Room shapes get roomier with depth (halls, arenas,
  // caverns), so deep flocks reliably get their theater.
  const roomyCombat = combatRooms.filter((r) => roomOpenArea(dungeon, r) >= SWARM_ROOM_MIN_AREA);
  const roomyAny: number[] = [];
  for (let i = 1; i < roomCount; i++) if (roomOpenArea(dungeon, i) >= SWARM_ROOM_MIN_AREA) roomyAny.push(i);

  const pickRoom = (unit: { kind: EnemyKind; tier: EnemyTier }): number => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const room = combatRooms[rng.int(0, combatRooms.length - 1)];
      const l = load.get(room)!;
      const isComplex = ENEMY_ARCHETYPES[unit.kind].threat > 1;
      if (isComplex && l.complex >= MAX_COMPLEX_PER_ROOM) continue;
      if (floor < BRUTE_ELITE_COMBO_FLOOR) {
        if (unit.tier === "brute" && l.hasElite) continue;
        if (unit.tier === "elite" && l.hasBrute) continue;
      }
      if (isComplex) l.complex++;
      if (unit.tier === "brute") l.hasBrute = true;
      if (unit.tier === "elite") l.hasElite = true;
      return room;
    }
    return combatRooms[rng.int(0, combatRooms.length - 1)];
  };

  const swarmRoom = (): number => {
    if (roomyCombat.length > 0) return roomyCombat[rng.int(0, roomyCombat.length - 1)];
    if (roomyAny.length > 0) return roomyAny[rng.int(0, roomyAny.length - 1)];
    return combatRooms[rng.int(0, combatRooms.length - 1)];
  };

  const add = (kind: EnemyKind, tier: EnemyTier): boolean => {
    const cost = threatCostOf(kind, tier);
    if (cost > budget) return false;
    budget -= cost;
    plan.push({ kind, tier, room: tier === "swarm" ? swarmRoom() : pickRoom({ kind, tier }) });
    return true;
  };

  if (floor >= TIERS.elite.minFloor) {
    const elites = floor >= 9 ? 2 : 1;
    for (let i = 0; i < elites; i++) add(weightedPick(rng, roster), "elite");
  }
  if (floor >= TIERS.brute.minFloor) {
    const brutes = floor >= 7 ? 2 : 1;
    for (let i = 0; i < brutes; i++) add(BRUTE_KINDS[rng.int(0, BRUTE_KINDS.length - 1)], "brute");
  }

  const minCost = threatCostOf("slime", "swarm");
  let guard = 0;
  while (budget >= minCost && guard++ < 200) {
    const kind = weightedPick(rng, roster);
    const isSwarmable = SWARM_KINDS.includes(kind);
    if (isSwarmable && rng.chance(0.3 * pressure.packBias)) {
      const pack = rng.int(2, 3);
      const room = swarmRoom();
      for (let i = 0; i < pack; i++) {
        const cost = threatCostOf(kind, "swarm");
        if (cost > budget) break;
        budget -= cost;
        plan.push({ kind, tier: "swarm", room });
      }
    } else if (!add(kind, "standard")) {
      // Too expensive for the remainder — a swarm unit may still fit.
      if (!isSwarmable || !add(kind, "swarm")) break;
    }
  }
  return plan;
}

export function spawnFloorEnemies(dungeon: Dungeon, seed: number, floor: number, players = 1): FloorSpawns {
  const rng = new Rng((seed ^ 0x9e3779b9) + floor * 2654435761);
  const roomCount = dungeon.rooms.length;
  if (roomCount <= 1) return { active: [], pending: [] };

  if (isBossFloor(floor)) {
    // Boss lives in the last room (next to the exit). A few slimes for company.
    const active: Enemy[] = [];
    const bossRoom = roomCount - 1;
    const b = pointInRoom(rng, dungeon, bossRoom);
    active.push(createEnemy("boss", b.x, b.y, floor, rng, active.length, { players }));
    const minions = 2 + Math.floor(floor / BOSS_EVERY);
    for (let i = 0; i < minions; i++) {
      const roomIndex = 1 + rng.int(0, roomCount - 2);
      const p = pointInRoom(rng, dungeon, roomIndex);
      active.push(createEnemy("slime", p.x, p.y, floor, rng, active.length, { players }));
    }
    return { active, pending: [] };
  }

  const plan = planFloorUnits(rng, dungeon, floor, players);
  const cap = activeThreatCap(floor) * coopThreatMult(players);
  const active: Enemy[] = [];
  const pending: Enemy[] = [];
  let activeThreat = 0;
  let id = 0;
  for (const unit of plan) {
    const p = pointInRoom(rng, dungeon, unit.room);
    const enemy = createEnemy(unit.kind, p.x, p.y, floor, rng, id++, { tier: unit.tier, players });
    const cost = threatCostOf(unit.kind, unit.tier);
    // Never exceed the ActiveThreatCap simultaneously: overflow becomes reinforcements.
    if (activeThreat + cost <= cap) {
      activeThreat += cost;
      active.push(enemy);
    } else {
      pending.push(enemy);
    }
  }
  return { active, pending };
}
