import type { Enemy, EnemyKind, SpriteName } from "./types.js";
import type { Dungeon } from "./dungeon.js";
import { TILE } from "./types.js";
import { Rng } from "./rng.js";
import { biomeIndexForFloor } from "./biomes.js";
import {
  TIERS, BIOME_PRESSURE, BOSS, MARROW, CHOIR, WEAVER, GILDED,
  floorHpMult, floorSpeedMult, floorThreat, activeThreatCap, roundHalfToEven,
  bossHpForFloor, marrowHpForFloor, choirHpForFloor, weaverHpForFloor, gildedHpForFloor,
  coopMobHpMult, coopBossHpMult, coopThreatMult, coopKbResistMult,
  MAX_COMPLEX_PER_ROOM, BRUTE_ELITE_COMBO_FLOOR,
} from "./balance.js";
import type { EnemyTier } from "./balance.js";

export type Movement = "chase" | "flock" | "drift" | "kite" | "charge" | "burrow" | "orbit" | "boss";

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
  // Bats fly as a FLOCK (deterministic boids: separation/alignment/cohesion + target
  // attraction) — a wheeling, readable swarm instead of independent zigzag beelines.
  bat: {
    kind: "bat", sprite: "bat", movement: "flock", isPhasing: false,
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
  // Line-rush bruiser: a slow stalker whose telegraphed straight charge crosses most of a
  // room — sidestep it, then punish the wall-crash stun. Heavy on its feet (high kbResist),
  // so the answer is footwork, not knockback.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: charger).
  charger: {
    kind: "charger", sprite: "charger", movement: "charge", isPhasing: false,
    radius: 17, drawSize: 48, alpha: 1, tint: "#d9a066", kbResist: 1.8,
    baseHp: 5, baseSpeed: 46, touchDamage: 1, threat: 1.5,
  },
  // Kite-denial: dives underground (untargetable, bounded), tunnels to the target, and
  // erupts on a marked, telegraphed circle. You cannot outrange it — you dodge its marker
  // and punish the surfaced recover window.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: burrower).
  burrower: {
    kind: "burrower", sprite: "burrower", movement: "burrow", isPhasing: false,
    radius: 15, drawSize: 44, alpha: 1, tint: "#caa27e", kbResist: 1.2,
    baseHp: 4, baseSpeed: 40, touchDamage: 1, threat: 1.5,
  },
  // Ring strafer: circles the target at mid range (rotational tracking — a different aim
  // problem from the spitter's straight kiting) and stops to fire a quick telegraphed bolt.
  // The stop IS the tell: an orbiter standing still is an orbiter about to shoot.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: orbiter).
  orbiter: {
    kind: "orbiter", sprite: "orbiter", movement: "orbit", isPhasing: false,
    radius: 13, drawSize: 40, alpha: 1, tint: "#8fb8ff", kbResist: 0.8,
    baseHp: 3, baseSpeed: 95, touchDamage: 1, threat: 1.5,
  },
  // Walking wall: absorbs bullets arriving inside its front arc — the answer is the flank,
  // melee over the top, or splash. Its bash is an ordinary short telegraphed lunge; the
  // enemy itself is a POSITIONING problem, not a stat problem.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: shielder).
  shielder: {
    kind: "shielder", sprite: "shielder", movement: "chase", isPhasing: false,
    radius: 16, drawSize: 46, alpha: 1, tint: "#9fb4a8", kbResist: 2.2,
    baseHp: 5, baseSpeed: 50, touchDamage: 1, threat: 1.5,
  },
  boss: {
    kind: "boss", sprite: "boss", movement: "boss", isPhasing: false,
    radius: 34, drawSize: 100, alpha: 1, tint: "#ffb43b", kbResist: 6,
    baseHp: BOSS.baseHp, baseSpeed: 40, touchDamage: BOSS.contactDamage, threat: 0,
  },
  // MARROW (the boss-roster spec's blind charger, deep roster): line charges with a
  // wall-crash daze, bone-shard volleys, a P3 spiral barrage, and an interactive shield
  // transition beat (§5b). Eyeless — it commits to where it HEARD you (the aim lock),
  // which is why the last stretch of every windup is un-tracked and sidesteppable.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: marrow).
  marrow: {
    kind: "marrow", sprite: "marrow", movement: "boss", isPhasing: false,
    radius: 30, drawSize: 92, alpha: 1, tint: "#bfd8e0", kbResist: 6,
    baseHp: MARROW.baseHp, baseSpeed: 46, touchDamage: MARROW.contactDamage, threat: 0,
  },
  // THE HOLLOW CHOIR (deep roster): the grieving ghost mass — fades intangible on cadence,
  // sings slow homing wails you juke by turning, and SPLITS into wisps at its transition
  // beats (kill them to force it back together early). §5c.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: choir).
  choir: {
    kind: "choir", sprite: "choir", movement: "boss", isPhasing: true,
    radius: 30, drawSize: 96, alpha: 0.85, tint: "#bfe9ff", kbResist: 6,
    baseHp: CHOIR.baseHp, baseSpeed: 44, touchDamage: CHOIR.contactDamage, threat: 0,
  },
  // THE WEAVER (deep roster): the duelist that fights the floor — plants persistent web
  // slow-zones that shrink your dance space and pounces from above onto a locked marker,
  // chaining leaps in later phases. Small, fast, lower HP. §5d.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: weaver).
  weaver: {
    kind: "weaver", sprite: "weaver", movement: "boss", isPhasing: false,
    radius: 26, drawSize: 76, alpha: 1, tint: "#c98bff", kbResist: 4,
    baseHp: WEAVER.baseHp, baseSpeed: 120, touchDamage: WEAVER.contactDamage, threat: 0,
  },
  // THE GILDED WARDEN (deep roster): the armored tempo boss — its plate chips damage to
  // 30% except during the EXPOSED recover after each committed quake/sweep. The only
  // warm-angular body in the bestiary (amber is the one friendly-angular thing). §5e.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: gilded).
  gilded: {
    kind: "gilded", sprite: "gilded", movement: "boss", isPhasing: false,
    radius: 36, drawSize: 108, alpha: 1, tint: "#ffd166", kbResist: 8,
    baseHp: GILDED.baseHp, baseSpeed: 26, touchDamage: GILDED.contactDamage, threat: 0,
  },
};

// Which archetypes each tier may inhabit: swarms are small fast bodies, brutes are the
// bulky telegraph-hitters (only an authored commitment — the skeleton's lunge or the
// charger's rush — carries the heavy +1).
const SWARM_KINDS: readonly EnemyKind[] = ["slime", "bat"];
const BRUTE_KINDS: readonly EnemyKind[] = ["slime", "skeleton", "charger"];

export const BOSS_EVERY = 5;
export function isBossFloor(floor: number): boolean {
  return floor % BOSS_EVERY === 0;
}

const BOSS_KINDS: readonly EnemyKind[] = ["boss", "marrow", "choir", "weaver", "gilded"];

export function isBossKind(kind: EnemyKind): boolean {
  return BOSS_KINDS.indexOf(kind) !== -1;
}

// The deep rotation: every boss floor past the first draws from the full roster, seeded
// per run — variety between runs, identical across a run's clients/restarts. The King is
// in the pool too (it scales on the same clamped curve), so deep runs still meet him.
const DEEP_BOSS_ROSTER: readonly EnemyKind[] = ["marrow", "choir", "weaver", "gilded", "boss"];

// Each boss floor's kin — the floor's ambient minions and its cadence/beat adds.
export const BOSS_KIN: Readonly<Partial<Record<EnemyKind, EnemyKind>>> = {
  boss: "slime", marrow: "skeleton", choir: "ghost", weaver: "bat", gilded: "shielder",
};

// Which boss holds each boss floor. F5 is ALWAYS the Slime King — the tutorial boss that
// teaches the telegraph language. Deeper boss floors (10, 15, 20, …) roll the seeded deep
// roster with no immediate repeats, so every run's boss ladder is its own.
export function bossKindForFloor(seed: number, floor: number): EnemyKind {
  const ladder = Math.floor(floor / BOSS_EVERY);
  if (ladder <= 1) return "boss";
  return DEEP_BOSS_ROSTER[deepBossIndex(seed, ladder - 2)];
}

// Walk the seeded ladder from the top so "no immediate repeats" is well-defined and
// deterministic at any depth (each step rerolls, shifting off the previous pick).
function deepBossIndex(seed: number, step: number): number {
  let prev = -1;
  for (let s = 0; ; s++) {
    let pick = new Rng((seed ^ 0xB055ED) + s * 2654435761).int(0, DEEP_BOSS_ROSTER.length - 1);
    if (pick === prev) pick = (pick + 1) % DEEP_BOSS_ROSTER.length;
    if (s === step) return pick;
    prev = pick;
  }
}

// §3 exact tables: HP(f) = roundHalfToEven(baseHP × HPmult(f)), same for speed. Damage
// never scales with floor.
export function enemyHpForFloor(kind: EnemyKind, floor: number): number {
  switch (kind) {
    case "boss": return bossHpForFloor(floor);
    case "marrow": return marrowHpForFloor(floor);
    case "choir": return choirHpForFloor(floor);
    case "weaver": return weaverHpForFloor(floor);
    case "gilded": return gildedHpForFloor(floor);
    default: return roundHalfToEven(ENEMY_ARCHETYPES[kind].baseHp * floorHpMult(floor));
  }
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
  const isBoss = isBossKind(kind);
  const hp = isBoss
    ? Math.round((enemyHpForFloor(kind, floor) * coopBossHpMult(players)) / 10) * 10
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
      // Bosses wait a beat after their dramatic entrance before the first commitment.
      cooldown: BOSS_ENTRANCE_GRACE[kind] ?? 0,
      lockedAngle: 0, isAimLocked: false, markX: 0, markY: 0,
    },
    boss: isBoss
      ? {
        phase: 1, transitionsDone: 0, roar: null,
        addTimer: BOSS_ADD_FIRST_AT[kind] ?? 0,
        attackCount: 0, isNextRadial: false, burstParity: 0,
        beatAddIds: [], spinCount: 0,
      }
      : null,
  };
}

const BOSS_ENTRANCE_GRACE: Readonly<Partial<Record<EnemyKind, number>>> = {
  boss: BOSS.entranceGrace, marrow: MARROW.entranceGrace, choir: CHOIR.entranceGrace,
  weaver: WEAVER.entranceGrace, gilded: GILDED.entranceGrace,
};

// Only the summoner bosses run a cadence add drip (the Choir's wisps and the Weaver's
// broodlings arrive on their transition beats instead; the Warden fights alone).
const BOSS_ADD_FIRST_AT: Readonly<Partial<Record<EnemyKind, number>>> = {
  boss: BOSS.addFirstAt, marrow: MARROW.addFirstAt,
};

function floorRoster(floor: number, complexShare: number): Array<{ kind: EnemyKind; weight: number }> {
  const roster: Array<{ kind: EnemyKind; weight: number }> = [{ kind: "slime", weight: 5 }];
  if (floor >= 2) {
    roster.push({ kind: "bat", weight: 3 });
    roster.push({ kind: "skeleton", weight: 2 });
    // Ranged threat: rare on floor 2 (a gentle intro) and a bit more common from floor 3
    // once the player has learned to dodge the melee lunge. Sunless raises the complex share.
    roster.push({ kind: "spitter", weight: (floor >= 3 ? 2 : 1) * complexShare });
  }
  if (floor >= 3) {
    roster.push({ kind: "ghost", weight: 2 * complexShare });
    // The charger arrives once the skeleton has taught the short lunge — its long lane is
    // the graduate version of the same read.
    roster.push({ kind: "charger", weight: 2 });
  }
  // The burrower lands after the ranged/kite lessons: it exists to deny the "stand at
  // range" answer, so it enters once that answer has formed.
  if (floor >= 4) roster.push({ kind: "burrower", weight: 2 * complexShare });
  // The orbiter joins once dodging straight shots is learned — its circling bolt asks for
  // rotational tracking instead. The shielder arrives last: by floor 7 the player owns
  // flanking/melee/splash answers, so a walking wall is a puzzle, not a stonewall.
  if (floor >= 6) roster.push({ kind: "orbiter", weight: 2 * complexShare });
  if (floor >= 7) roster.push({ kind: "shielder", weight: 2 });
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

// Deterministic threat-budget floor composition (§4): spend FloorThreat on a tiered unit
// mix instead of counting bodies. Elites/brutes are planned first (they anchor the opening
// wave); swarm packs and standards fill the remainder and overflow into reinforcements.
function planFloorUnits(rng: Rng, floor: number, roomCount: number, players: number): PlannedUnit[] {
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

  const add = (kind: EnemyKind, tier: EnemyTier): boolean => {
    const cost = threatCostOf(kind, tier);
    if (cost > budget) return false;
    budget -= cost;
    plan.push({ kind, tier, room: pickRoom({ kind, tier }) });
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
      const room = pickRoom({ kind, tier: "swarm" });
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
    // The floor's boss lives in the last room (next to the exit), with a few of its own
    // kin for company (slimes under the King, skeletons under MARROW, ghosts under the
    // Choir, bats under the Weaver, shielders under the Gilded Warden).
    const active: Enemy[] = [];
    const bossKind = bossKindForFloor(seed, floor);
    const minionKind: EnemyKind = BOSS_KIN[bossKind] ?? "slime";
    const bossRoom = roomCount - 1;
    const b = pointInRoom(rng, dungeon, bossRoom);
    active.push(createEnemy(bossKind, b.x, b.y, floor, rng, active.length, { players }));
    const minions = 2 + Math.floor(floor / BOSS_EVERY);
    for (let i = 0; i < minions; i++) {
      const roomIndex = 1 + rng.int(0, roomCount - 2);
      const p = pointInRoom(rng, dungeon, roomIndex);
      active.push(createEnemy(minionKind, p.x, p.y, floor, rng, active.length, { players }));
    }
    return { active, pending: [] };
  }

  const plan = planFloorUnits(rng, floor, roomCount, players);
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
