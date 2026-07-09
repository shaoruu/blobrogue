// Environmental hazards — the floor itself fighting back, ramping with depth. Pure and
// deterministic: placement is a seeded function of (dungeon, seed, floor) so solo clients,
// online clients (which rebuild geometry from the snapshot seed) and the authoritative
// server all derive the SAME layout with zero wire cost; pulse timing is a pure function
// of the sim's hazardClock (seconds of stepped world time), never wall-clock.
//
// Fairness contract (the difficulty framework applies to the floor too):
//   - Every pulse hazard telegraphs for >= 0.9s before it can hurt; pools are static and
//     always visible (no surprise damage, ever).
//   - Damage is always 1 (difficulty != HP), respects dash iframes + post-hit protection.
//   - Placement keeps a clean radius around the spawn, the exit, and every room center
//     (chests/dealer stock land on centers), and never on boss floors' boss room.
//   - Static pools never seal a path: the no-hazard floor graph must keep spawn->exit
//     connected — placement enforces it, test/depth.test.ts proves it per seed batch.
//
// The damage/pull loop itself lives in world.ts (it owns damagePlayer + events); this
// module is placement + cycle math + data, mirroring the enemies.ts split.

import type { Dungeon, Room } from "./dungeon.js";
import type { Hazard, HazardKind } from "./types.js";
import { Rng } from "./rng.js";
import { biomeIndexForFloor, biomeDepthForFloor } from "./biomes.js";
import { isBossFloor } from "./enemies.js";

// ---- cycle timing (seconds) ----

export interface HazardTiming {
  readonly idle: number;      // dormant, harmless
  readonly telegraph: number; // visibly arming, still harmless
  readonly active: number;    // damaging window
}

// Pools are static (always dangerous, always visible): timing is null.
export const HAZARD_TIMING: Record<HazardKind, HazardTiming | null> = {
  spikes: { idle: 2.2, telegraph: 0.9, active: 0.7 },
  toxic_pool: null,
  fire_vent: { idle: 2.6, telegraph: 1.0, active: 1.4 },
  void_rift: { idle: 3.2, telegraph: 1.1, active: 1.6 },
};

export const HAZARD_DAMAGE = 1;

// Void-rift pull: active-phase drag toward the core. Well under the 200px/s player walk —
// pressure that forces movement, never an inescapable vortex.
export const RIFT_PULL_RADIUS = 92;   // px
export const RIFT_PULL_SPEED = 85;    // px/s

export type HazardPhase = "idle" | "telegraph" | "active";

export function hazardPeriod(kind: HazardKind): number {
  const t = HAZARD_TIMING[kind];
  return t ? t.idle + t.telegraph + t.active : 0;
}

// Where hazard `h` sits in its cycle at sim-time `clock`. Pools are always active.
export function hazardPhaseAt(h: Hazard, clock: number): HazardPhase {
  const t = HAZARD_TIMING[h.kind];
  if (!t) return "active";
  const period = t.idle + t.telegraph + t.active;
  const c = (clock + h.phase) % period;
  if (c < t.idle) return "idle";
  if (c < t.idle + t.telegraph) return "telegraph";
  return "active";
}

// Progress 0..1 through the current phase (client telegraph/eruption animation curve).
export function hazardPhaseFrac(h: Hazard, clock: number): number {
  const t = HAZARD_TIMING[h.kind];
  if (!t) return 1;
  const period = t.idle + t.telegraph + t.active;
  const c = (clock + h.phase) % period;
  if (c < t.idle) return c / t.idle;
  if (c < t.idle + t.telegraph) return (c - t.idle) / t.telegraph;
  return (c - t.idle - t.telegraph) / t.active;
}

export function isHazardDamaging(h: Hazard, clock: number): boolean {
  return hazardPhaseAt(h, clock) === "active";
}

// ---- per-biome hazard identity ----

// Which kinds a biome fields, by weight, and how many hazard TILES it budgets. Density is
// the depth ramp (timing stays fixed for learnable rhythm): the budget grows both across
// biomes and within a biome band as its boss floor approaches.
interface BiomeHazardProfile {
  readonly weights: ReadonlyArray<{ kind: HazardKind; weight: number }>;
  readonly base: number;  // hazard tiles at the top of the band
  readonly ramp: number;  // extra tiles by the bottom of the band
}

const BIOME_HAZARDS: readonly BiomeHazardProfile[] = [
  // Verdant Hollow: safe-ish home. Nothing on floors 1-2 (see budget gate); a few root
  // thorns after.
  { weights: [{ kind: "spikes", weight: 1 }], base: 2, ramp: 3 },
  // Sunless Caves: bone-spike rows, first murky pools.
  { weights: [{ kind: "spikes", weight: 0.8 }, { kind: "toxic_pool", weight: 0.2 }], base: 4, ramp: 4 },
  // The Deep: resin venom basins, fracture spikes.
  { weights: [{ kind: "toxic_pool", weight: 0.55 }, { kind: "spikes", weight: 0.45 }], base: 6, ramp: 5 },
  // Emberreach: vent channels under everything.
  { weights: [{ kind: "fire_vent", weight: 0.65 }, { kind: "spikes", weight: 0.35 }], base: 8, ramp: 6 },
  // The Fracture: reality tears open.
  { weights: [{ kind: "void_rift", weight: 0.4 }, { kind: "spikes", weight: 0.35 }, { kind: "toxic_pool", weight: 0.25 }], base: 10, ramp: 7 },
  // The Null: everything at once.
  { weights: [{ kind: "void_rift", weight: 0.35 }, { kind: "fire_vent", weight: 0.3 }, { kind: "spikes", weight: 0.2 }, { kind: "toxic_pool", weight: 0.15 }], base: 13, ramp: 8 },
];

// Hazard-tile budget for a floor. Floors 1-2 are the safe teach-the-controls band; boss
// floors carry a light approach only (the boss IS the floor's danger).
export function hazardBudgetForFloor(floor: number): number {
  const f = Math.max(1, Math.floor(floor));
  if (f <= 2) return 0;
  const profile = BIOME_HAZARDS[biomeIndexForFloor(f)];
  const budget = Math.round(profile.base + profile.ramp * biomeDepthForFloor(f));
  return isBossFloor(f) ? Math.floor(budget / 2) : budget;
}

function pickKind(rng: Rng, profile: BiomeHazardProfile): HazardKind {
  const total = profile.weights.reduce((s, w) => s + w.weight, 0);
  let roll = rng.next() * total;
  for (const w of profile.weights) {
    roll -= w.weight;
    if (roll <= 0) return w.kind;
  }
  return profile.weights[profile.weights.length - 1].kind;
}

// ---- placement ----

// Wave step between tiles of one spike row (a travelling ripple you can read and race).
const ROW_WAVE_STEP = 0.35;
const SPAWN_CLEAR = 3;  // Chebyshev tiles kept clean around the spawn
const EXIT_CLEAR = 2;   // and around the exit

interface PlacementCtx {
  d: Dungeon;
  rng: Rng;
  taken: Set<number>;    // tile index -> hazard already there
  list: Hazard[];
  nextId: number;
  nextGroup: number;
  blockedRoom: Room | null; // boss room: no hazards at all
}

function tileIdx(d: Dungeon, tx: number, ty: number): number {
  return ty * d.w + tx;
}

function isOpenFloor(d: Dungeon, tx: number, ty: number): boolean {
  return tx >= 0 && ty >= 0 && tx < d.w && ty < d.h && d.tiles[tileIdx(d, tx, ty)] === 0;
}

// A tile a hazard may claim: open floor, unclaimed, outside the spawn/exit safety radii,
// off every room center (+ its 4-neighborhood — chest/dealer stock lands there), and
// outside the blocked (boss) room.
function isPlaceable(ctx: PlacementCtx, tx: number, ty: number): boolean {
  const { d } = ctx;
  if (!isOpenFloor(d, tx, ty)) return false;
  if (ctx.taken.has(tileIdx(d, tx, ty))) return false;
  if (Math.max(Math.abs(tx - d.spawn.x), Math.abs(ty - d.spawn.y)) <= SPAWN_CLEAR) return false;
  if (Math.max(Math.abs(tx - d.exit.x), Math.abs(ty - d.exit.y)) <= EXIT_CLEAR) return false;
  for (const room of d.rooms) {
    if (Math.abs(tx - room.cx) + Math.abs(ty - room.cy) <= 1) return false;
  }
  const b = ctx.blockedRoom;
  if (b && tx >= b.x - 1 && tx < b.x + b.w + 1 && ty >= b.y - 1 && ty < b.y + b.h + 1) return false;
  return true;
}

// Static pools must never seal a path (a pulse hazard is crossable by timing; a pool is
// not). A pool tile is only legal if, with it filled, its open neighbors all remain
// mutually connected within a local window — the cheap articulation test: flood the
// 7x7 window without the candidate and require every open neighbor reachable from one.
function poolKeepsPathOpen(ctx: PlacementCtx, tx: number, ty: number): boolean {
  const { d } = ctx;
  const blocked = (x: number, y: number): boolean => {
    if (!isOpenFloor(d, x, y)) return true;
    if (x === tx && y === ty) return true;
    const h = hazardAtTile(ctx.list, x, y);
    return h !== null && h.kind === "toxic_pool";
  };
  const neighbors: Array<[number, number]> = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    if (!blocked(tx + dx, ty + dy)) neighbors.push([tx + dx, ty + dy]);
  }
  if (neighbors.length <= 1) return true;
  const R = 3;
  const seen = new Set<number>();
  const queue: Array<[number, number]> = [neighbors[0]];
  seen.add(tileIdx(d, neighbors[0][0], neighbors[0][1]));
  while (queue.length > 0) {
    const [cx, cy] = queue.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx, ny = cy + dy;
      if (Math.abs(nx - tx) > R || Math.abs(ny - ty) > R) continue;
      if (blocked(nx, ny)) continue;
      const key = tileIdx(d, nx, ny);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push([nx, ny]);
    }
  }
  return neighbors.every(([nx, ny]) => seen.has(tileIdx(d, nx, ny)));
}

function hazardAtTile(list: Hazard[], tx: number, ty: number): Hazard | null {
  for (const h of list) if (h.tx === tx && h.ty === ty) return h;
  return null;
}

function claim(ctx: PlacementCtx, kind: HazardKind, tx: number, ty: number, phase: number, group: number): void {
  ctx.taken.add(tileIdx(ctx.d, tx, ty));
  ctx.list.push({ id: ctx.nextId++, kind, tx, ty, phase, group });
}

// A row of pulse tiles firing as a travelling wave (spikes) or in unison (vents).
function placeRow(ctx: PlacementCtx, kind: HazardKind, room: Room, maxLen: number): number {
  const { rng } = ctx;
  const isHorizontal = rng.chance(0.5);
  const len = Math.min(maxLen, 3 + rng.int(0, 3));
  const basePhase = rng.range(0, hazardPeriod(kind));
  const group = ctx.nextGroup++;
  for (let attempt = 0; attempt < 8; attempt++) {
    const tx0 = room.x + rng.int(0, Math.max(0, room.w - 1));
    const ty0 = room.y + rng.int(0, Math.max(0, room.h - 1));
    const cells: Array<[number, number]> = [];
    for (let i = 0; i < len; i++) {
      const tx = tx0 + (isHorizontal ? i : 0);
      const ty = ty0 + (isHorizontal ? 0 : i);
      if (!isPlaceable(ctx, tx, ty)) break;
      cells.push([tx, ty]);
    }
    if (cells.length < 2) continue;
    // Vents erupt as one channel; spikes ripple down the row.
    const step = kind === "fire_vent" ? 0 : ROW_WAVE_STEP;
    cells.forEach(([tx, ty], i) => claim(ctx, kind, tx, ty, basePhase + i * step, group));
    return cells.length;
  }
  return 0;
}

// An organic pool blob grown from a seed tile, wall-hugging by preference so the room
// keeps its open lanes. Every tile passes the local articulation test.
function placeBlob(ctx: PlacementCtx, room: Room, maxLen: number): number {
  const { rng } = ctx;
  const target = Math.min(maxLen, 3 + rng.int(0, 4));
  for (let attempt = 0; attempt < 8; attempt++) {
    const tx0 = room.x + rng.int(0, Math.max(0, room.w - 1));
    const ty0 = room.y + rng.int(0, Math.max(0, room.h - 1));
    if (!isPlaceable(ctx, tx0, ty0) || !poolKeepsPathOpen(ctx, tx0, ty0)) continue;
    const group = ctx.nextGroup++;
    claim(ctx, "toxic_pool", tx0, ty0, 0, group);
    let placed = 1;
    let frontier: Array<[number, number]> = [[tx0, ty0]];
    let guard = 0;
    while (placed < target && frontier.length > 0 && guard++ < 40) {
      const [fx, fy] = frontier[rng.int(0, frontier.length - 1)];
      const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const [dx, dy] = dirs[rng.int(0, 3)];
      const nx = fx + dx, ny = fy + dy;
      if (!isPlaceable(ctx, nx, ny) || !poolKeepsPathOpen(ctx, nx, ny)) continue;
      claim(ctx, "toxic_pool", nx, ny, 0, group);
      frontier.push([nx, ny]);
      placed++;
    }
    return placed;
  }
  return 0;
}

// A lone rift on open ground — needs breathing room (its pull radius is the threat).
function placeRift(ctx: PlacementCtx, room: Room): number {
  const { rng } = ctx;
  for (let attempt = 0; attempt < 10; attempt++) {
    const tx = room.x + 1 + rng.int(0, Math.max(0, room.w - 3));
    const ty = room.y + 1 + rng.int(0, Math.max(0, room.h - 3));
    if (!isPlaceable(ctx, tx, ty)) continue;
    let isClear = true;
    for (const h of ctx.list) {
      if (Math.abs(h.tx - tx) <= 1 && Math.abs(h.ty - ty) <= 1) { isClear = false; break; }
    }
    if (!isClear) continue;
    claim(ctx, "void_rift", tx, ty, rng.range(0, hazardPeriod("void_rift")), ctx.nextGroup++);
    return 1;
  }
  return 0;
}

// Deterministic per-floor hazard layout. Own seeded stream (like props/chests) so it
// never perturbs enemy/loot rolls. Rooms marked "hazard" by the generator are dressed
// first and densest — they read as authored set pieces; the remaining budget scatters
// smaller formations through ordinary combat rooms.
export function placeHazards(d: Dungeon, seed: number, floor: number): Hazard[] {
  let budget = hazardBudgetForFloor(floor);
  if (budget <= 0 || d.rooms.length < 2) return [];
  const rng = new Rng((seed ^ 0x6a2d9b4f) + floor * 79241);
  const profile = BIOME_HAZARDS[biomeIndexForFloor(floor)];
  const ctx: PlacementCtx = {
    d, rng,
    taken: new Set<number>(),
    list: [],
    nextId: 0,
    nextGroup: 0,
    blockedRoom: isBossFloor(floor) ? d.rooms[d.rooms.length - 1] : null,
  };

  const place = (kind: HazardKind, room: Room, cap: number): number => {
    if (kind === "toxic_pool") return placeBlob(ctx, room, cap);
    if (kind === "void_rift") return placeRift(ctx, room);
    return placeRow(ctx, kind, room, cap);
  };

  // Set-piece pass: hazard rooms burn ~half the budget in dense formations.
  const hazardRooms = d.rooms.filter((r) => r.kind === "hazard" && r !== ctx.blockedRoom);
  for (const room of hazardRooms) {
    let share = Math.max(3, Math.floor(budget * 0.5 / Math.max(1, hazardRooms.length)));
    let guard = 0;
    while (share > 0 && budget > 0 && guard++ < 12) {
      const n = place(pickKind(rng, profile), room, Math.min(share, budget));
      if (n === 0) break;
      share -= n;
      budget -= n;
    }
  }

  // Scatter pass: everything else, spread across eligible rooms (never spawn/treasure).
  const eligible = d.rooms.filter((r) =>
    r.kind !== "spawn" && r.kind !== "treasure" && r !== ctx.blockedRoom);
  let guard = 0;
  while (budget > 0 && eligible.length > 0 && guard++ < 40) {
    const room = eligible[rng.int(0, eligible.length - 1)];
    budget -= place(pickKind(rng, profile), room, budget) || 0;
  }
  return ctx.list;
}
