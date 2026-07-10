// Environmental hazards — the floor itself fighting back, ramping with depth. Pure and
// deterministic: placement is a seeded function of (dungeon, seed, floor, difficulty) so
// solo clients, online clients (which rebuild geometry from the snapshot seed) and the
// authoritative server all derive the SAME layout with zero wire cost; pulse timing is a
// pure function of the sim's hazardClock (seconds of stepped world time), never wall-clock.
//
// Fairness contract (docs/specs/blobrogue_STUDIO_BALANCE_GATE.md §1-2, hazard rows):
//   - Every pulse hazard telegraphs for >= 0.9s before it can hurt (gate minimum 0.65s);
//     pools are static and always visible (no surprise damage, ever).
//   - Damage is always 1 (difficulty != HP), respects dash iframes + post-hit protection.
//   - Difficulty scales DENSITY and CONCURRENCY, never tells: Casual 0.65x budget / 1
//     simultaneous unit / 25% denial; Standard 1.00x / 2 (3 in arenas) / 35%; Brutal
//     1.30x / 3 / 45% (HAZARD_DIFFICULTY in balance.ts).
//   - The room OVERLAP ARBITER schedules every pulse group's release at placement time:
//     within a room, active envelopes never exceed the mode's simultaneity cap and no two
//     group releases land within 0.30s of each other. All pulse kinds share ONE 4.8s
//     cycle, so the schedule that holds for one cycle holds forever — the arbitration is
//     provable by sampling a single period (test/depth.test.ts does exactly that). Mob
//     commitments join the same arbiter after the content integration via
//     floorHazardOnsetsInRoom().
//   - Boss floors carry NO generator hazards (gate: boss-authored only); floor 1 carries
//     none, floor 2 a half-unit taste.
//   - Placement keeps a clean radius around the spawn, the exit, and every room center
//     (chests land on centers), and never touches the shop room (sanctuary contract).
//   - Static pools never seal a path: the no-hazard floor graph must keep spawn->exit
//     connected — placement enforces it, test/depth.test.ts proves it per seed batch.
//
// The damage/pull loop itself lives in world.ts (it owns damagePlayer + events); this
// module is placement + cycle math + data, mirroring the enemies.ts split.

import type { Dungeon, Room } from "./dungeon.js";
import type { FloorHazard, FloorHazardKind } from "./types.js";
import { Rng } from "./rng.js";
import { biomeIndexForFloor, biomeDepthForFloor } from "./biomes.js";
import { HAZARD_DIFFICULTY } from "./balance.js";
import type { Difficulty } from "./balance.js";
import { isBossFloor } from "./enemies.js";

// ---- cycle timing (seconds) ----

export interface HazardTiming {
  readonly idle: number;      // dormant, harmless
  readonly telegraph: number; // visibly arming, still harmless
  readonly active: number;    // damaging window
}

// One shared pulse period — the overlap arbiter's precondition. Every pulse kind's
// idle+telegraph+active sums to HAZARD_PERIOD, so per-room release schedules repeat
// exactly and a one-cycle proof holds for the whole run.
export const HAZARD_PERIOD = 4.8;

// Pools are static (always dangerous, always visible): timing is null.
export const HAZARD_TIMING: Record<FloorHazardKind, HazardTiming | null> = {
  spikes: { idle: 3.2, telegraph: 0.9, active: 0.7 },
  toxic_pool: null,
  fire_vent: { idle: 2.4, telegraph: 1.0, active: 1.4 },
  void_rift: { idle: 2.1, telegraph: 1.1, active: 1.6 },
};

export const FLOOR_HAZARD_DAMAGE = 1;

// The gate's release-spacing rule: no two damage releases within 0.30s on the same
// escape lane. Room-scoped groups are conservatively treated as sharing lanes.
export const HAZARD_RELEASE_GAP = 0.30;

// Void-rift pull: active-phase drag toward the core. Well under the 200px/s player walk —
// pressure that forces movement, never an inescapable vortex.
export const RIFT_PULL_RADIUS = 92;   // px
export const RIFT_PULL_SPEED = 85;    // px/s

export type FloorHazardPhase = "idle" | "telegraph" | "active";

export function floorHazardPeriod(kind: FloorHazardKind): number {
  const t = HAZARD_TIMING[kind];
  return t ? t.idle + t.telegraph + t.active : 0;
}

// Where hazard `h` sits in its cycle at sim-time `clock`. Pools are always active.
export function floorHazardPhaseAt(h: FloorHazard, clock: number): FloorHazardPhase {
  const t = HAZARD_TIMING[h.kind];
  if (!t) return "active";
  const period = t.idle + t.telegraph + t.active;
  const c = (clock + h.phase) % period;
  if (c < t.idle) return "idle";
  if (c < t.idle + t.telegraph) return "telegraph";
  return "active";
}

// Progress 0..1 through the current phase (client telegraph/eruption animation curve).
export function floorHazardPhaseFrac(h: FloorHazard, clock: number): number {
  const t = HAZARD_TIMING[h.kind];
  if (!t) return 1;
  const period = t.idle + t.telegraph + t.active;
  const c = (clock + h.phase) % period;
  if (c < t.idle) return c / t.idle;
  if (c < t.idle + t.telegraph) return (c - t.idle) / t.telegraph;
  return (c - t.idle - t.telegraph) / t.active;
}

export function isFloorHazardDamaging(h: FloorHazard, clock: number): boolean {
  return floorHazardPhaseAt(h, clock) === "active";
}

// A pulse hazard's release instant (active-window start) within the shared cycle.
export function floorHazardOnset(h: FloorHazard): number {
  const t = HAZARD_TIMING[h.kind];
  if (!t) return 0;
  return (((t.idle + t.telegraph - h.phase) % HAZARD_PERIOD) + HAZARD_PERIOD) % HAZARD_PERIOD;
}

// Every distinct release instant of a room's placed hazards, sorted, cycle-relative —
// the integration point for the gate's SHARED overlap arbiter: when the difficulty
// system lands, mob commitment schedulers read this to keep their own damage releases
// >= 0.30s away from the floor's (same rule the placement arbiter already enforces
// among hazards themselves).
export function floorHazardOnsetsInRoom(hazards: readonly FloorHazard[], room: { x: number; y: number; w: number; h: number }): number[] {
  const out: number[] = [];
  for (const h of hazards) {
    if (HAZARD_TIMING[h.kind] === null) continue;
    if (h.tx < room.x || h.tx >= room.x + room.w || h.ty < room.y || h.ty >= room.y + room.h) continue;
    const r = floorHazardOnset(h);
    if (!out.some((x) => Math.abs(x - r) < 1e-6)) out.push(r);
  }
  return out.sort((a, b) => a - b);
}

// ---- per-biome hazard identity ----

// Which kinds a biome fields, by weight, and how many hazard TILES it budgets. Density is
// the depth ramp (timing stays fixed for learnable rhythm): the budget grows both across
// biomes and within a biome band as its boss floor approaches.
interface BiomeHazardProfile {
  readonly weights: ReadonlyArray<{ kind: FloorHazardKind; weight: number }>;
  readonly base: number;  // hazard tiles at the top of the band
  readonly ramp: number;  // extra tiles by the bottom of the band
}

// One row per curriculum band (§10 material grammar): Amberwild Snaproot thorns;
// Rootbound's denser root traps over wet ground; Sunless bone spikes + murky pools;
// the Deep's jet-resin basins and load-seam tears; the Gilded Archive's dead-prism
// rifts and gilded spears; Emberreach pressure vents; the Null stacking everything.
const BIOME_HAZARDS: readonly BiomeHazardProfile[] = [
  { weights: [{ kind: "spikes", weight: 1 }], base: 2, ramp: 3 },
  { weights: [{ kind: "spikes", weight: 0.8 }, { kind: "toxic_pool", weight: 0.2 }], base: 4, ramp: 4 },
  { weights: [{ kind: "spikes", weight: 0.55 }, { kind: "toxic_pool", weight: 0.45 }], base: 6, ramp: 5 },
  { weights: [{ kind: "toxic_pool", weight: 0.45 }, { kind: "spikes", weight: 0.3 }, { kind: "void_rift", weight: 0.25 }], base: 8, ramp: 6 },
  { weights: [{ kind: "void_rift", weight: 0.4 }, { kind: "spikes", weight: 0.35 }, { kind: "toxic_pool", weight: 0.25 }], base: 10, ramp: 7 },
  { weights: [{ kind: "fire_vent", weight: 0.65 }, { kind: "spikes", weight: 0.35 }], base: 12, ramp: 8 },
  // THE UNMAKING (post-F30): the four corrupted regions, hazard density ramping region over region.
  // The Sump — the mixed drain (warm/cold melt together).
  { weights: [{ kind: "void_rift", weight: 0.3 }, { kind: "fire_vent", weight: 0.3 }, { kind: "spikes", weight: 0.2 }, { kind: "toxic_pool", weight: 0.2 }], base: 14, ramp: 8 },
  // The Veinworks — resin/amber arteries; fire + fracture environmental.
  { weights: [{ kind: "fire_vent", weight: 0.4 }, { kind: "void_rift", weight: 0.35 }, { kind: "spikes", weight: 0.25 }], base: 16, ramp: 8 },
  // The Pale — warmth draining; cold void + toxic subtraction.
  { weights: [{ kind: "void_rift", weight: 0.45 }, { kind: "toxic_pool", weight: 0.3 }, { kind: "spikes", weight: 0.25 }], base: 18, ramp: 8 },
  // Null Core — the source; void-dominant.
  { weights: [{ kind: "void_rift", weight: 0.6 }, { kind: "spikes", weight: 0.4 }], base: 20, ramp: 8 },
];

// Hazard-tile budget for a floor, scaled by the difficulty's gate multiplier (0.65x /
// 1.00x / 1.30x). Cadence per the studio gate §2: floor 1 teaches with zero hazards,
// floor 2 carries the half-unit taste, boss floors are boss-authored ONLY (the generator
// places nothing), and everything else ramps band over band toward the Ember/Null peak.
export function floorHazardBudgetFor(floor: number, difficulty: Difficulty = "standard"): number {
  const f = Math.max(1, Math.floor(floor));
  const mult = HAZARD_DIFFICULTY[difficulty].budgetMult;
  if (f <= 1 || isBossFloor(f)) return 0;
  if (f === 2) return Math.max(1, Math.round(2 * mult)); // the 0.5-unit teaching taste
  const profile = BIOME_HAZARDS[biomeIndexForFloor(f)];
  return Math.round((profile.base + profile.ramp * biomeDepthForFloor(f)) * mult);
}

function pickKind(rng: Rng, profile: BiomeHazardProfile): FloorHazardKind {
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

// Per-room arbitration state (see scheduleGroup / fitsDenialCap).
interface RoomSchedule {
  lanes: number[];      // per concurrency lane: the time its current occupant frees it
  releases: number[];   // every scheduled release (active-start) time, unrotated
  offset: number;       // seeded whole-room cycle rotation (rooms don't fire in lockstep)
  hazardTiles: number;  // tiles claimed in this room so far (denial accounting)
  openArea: number;     // walkable tiles in the room (computed once)
}

interface PlacementCtx {
  d: Dungeon;
  rng: Rng;
  taken: Set<number>;    // tile index -> hazard already there
  list: FloorHazard[];
  nextId: number;
  nextGroup: number;
  simultaneousCap: number;  // mode cap on concurrently-active pulse groups per room
  denialCap: number;        // mode cap on the walkable fraction a room's hazards claim
  schedules: Map<Room, RoomSchedule>;
}

function scheduleOf(ctx: PlacementCtx, room: Room): RoomSchedule {
  let s = ctx.schedules.get(room);
  if (!s) {
    let open = 0;
    for (let ty = room.y; ty < room.y + room.h; ty++) {
      for (let tx = room.x; tx < room.x + room.w; tx++) {
        if (isOpenFloor(ctx.d, tx, ty)) open++;
      }
    }
    // The rotation shifts a room's whole timeline: intra-room spacing/concurrency are
    // rotation-invariant (proven circularly by the gate test), but neighboring rooms
    // stop erupting in eerie global sync.
    s = { lanes: [], releases: [], offset: ctx.rng.range(0, HAZARD_PERIOD), hazardTiles: 0, openArea: Math.max(1, open) };
    ctx.schedules.set(room, s);
  }
  return s;
}

// Denial cap (gate §2): the room must keep (1 - cap) of its walkable floor hazard-free.
// Checked before any claim, for every kind — pools are permanent denial, pulse groups
// deny their footprint while cycling. Chebyshev-conservative: the tile count IS the
// denied area (danger areas are tile-bound).
function fitsDenialCap(ctx: PlacementCtx, room: Room, newTiles: number): boolean {
  const s = scheduleOf(ctx, room);
  return s.hazardTiles + newTiles <= ctx.denialCap * s.openArea;
}

function chargeDenial(ctx: PlacementCtx, room: Room, tiles: number): void {
  scheduleOf(ctx, room).hazardTiles += tiles;
}

// The OVERLAP ARBITER (gate §2). Every pulse group in a room is scheduled onto one of
// `cap` concurrency lanes of the shared 4.8s cycle: within a lane, one group's active
// envelope must fully end (plus the release gap) before the next begins, so at any
// instant at most `cap` groups are active; across the whole room, no two RELEASES —
// including a spike wave's internal ripple steps (`offsets`) — land within
// HAZARD_RELEASE_GAP of each other (room groups conservatively share escape lanes).
// Greedy earliest-fit over deterministic iteration order — reproducible everywhere.
// Returns the group's rotated active-start time, or null when the room's cycle is
// saturated (the caller then leaves the room alone: caps are ceilings, never targets).
function scheduleGroup(ctx: PlacementCtx, room: Room, envelope: number, offsets: readonly number[]): number | null {
  const s = scheduleOf(ctx, room);
  // Arena rooms host staged fights: Standard's cap rises by one there (max 3 — the
  // gate's boss/Arena allowance). Casual keeps its flat 1; Brutal is already at ceiling.
  const cap = ctx.simultaneousCap >= 2 && room.shape === "arena"
    ? Math.min(3, ctx.simultaneousCap + 1)
    : ctx.simultaneousCap;
  let bestLane = -1;
  let bestStart = Infinity;
  for (let lane = 0; lane < cap; lane++) {
    let candidate = s.lanes[lane] ?? 0;
    // Step past every existing release that would violate the 0.30s spacing rule for
    // ANY of this group's release offsets. Monotone stepping converges within the guard.
    for (let guard = 0; guard < 32; guard++) {
      const isClashing = s.releases.some((r) => offsets.some((o) => Math.abs(r - (candidate + o)) < HAZARD_RELEASE_GAP));
      if (!isClashing) break;
      candidate += HAZARD_RELEASE_GAP;
    }
    if (candidate + envelope > HAZARD_PERIOD) continue;
    if (candidate < bestStart) { bestStart = candidate; bestLane = lane; }
  }
  if (bestLane < 0) return null;
  s.lanes[bestLane] = bestStart + envelope + HAZARD_RELEASE_GAP;
  for (const o of offsets) s.releases.push(bestStart + o);
  return bestStart + s.offset;
}

// The cycle phase that makes `kind`'s ACTIVE window open exactly at time `start`
// (floorHazardPhaseAt computes (clock + phase) % period against idle -> telegraph -> active).
function phaseForActiveStart(kind: FloorHazardKind, start: number): number {
  const t = HAZARD_TIMING[kind];
  if (!t) return 0;
  const activeAt = t.idle + t.telegraph;
  return ((activeAt - start) % HAZARD_PERIOD + HAZARD_PERIOD) % HAZARD_PERIOD;
}

function tileIdx(d: Dungeon, tx: number, ty: number): number {
  return ty * d.w + tx;
}

function isOpenFloor(d: Dungeon, tx: number, ty: number): boolean {
  return tx >= 0 && ty >= 0 && tx < d.w && ty < d.h && d.tiles[tileIdx(d, tx, ty)] === 0;
}

// A tile a hazard may claim: open floor, unclaimed, outside the spawn/exit safety radii,
// off every room center's 2-tile neighborhood (chests land on that ground), and never
// inside the shop room — Patch's waystation is sanctuary by contract (shopping must
// never hurt; the shop suite stands a full party on every station). Boss floors never
// reach placement at all (their budget is zero: boss-authored only).
function isPlaceable(ctx: PlacementCtx, tx: number, ty: number): boolean {
  const { d } = ctx;
  if (!isOpenFloor(d, tx, ty)) return false;
  if (ctx.taken.has(tileIdx(d, tx, ty))) return false;
  if (Math.max(Math.abs(tx - d.spawn.x), Math.abs(ty - d.spawn.y)) <= SPAWN_CLEAR) return false;
  if (Math.max(Math.abs(tx - d.exit.x), Math.abs(ty - d.exit.y)) <= EXIT_CLEAR) return false;
  for (const room of d.rooms) {
    if (Math.abs(tx - room.cx) + Math.abs(ty - room.cy) <= 2) return false;
    if (room.kind === "shop" && tx >= room.x && tx < room.x + room.w && ty >= room.y && ty < room.y + room.h) return false;
  }
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

function hazardAtTile(list: FloorHazard[], tx: number, ty: number): FloorHazard | null {
  for (const h of list) if (h.tx === tx && h.ty === ty) return h;
  return null;
}

function claim(ctx: PlacementCtx, room: Room, kind: FloorHazardKind, tx: number, ty: number, phase: number, group: number): void {
  ctx.taken.add(tileIdx(ctx.d, tx, ty));
  chargeDenial(ctx, room, 1);
  ctx.list.push({ id: ctx.nextId++, kind, tx, ty, phase, group });
}

// A row of pulse tiles firing as a travelling wave (spikes) or in unison (vents).
// The row's release slot comes from the room's overlap arbiter; the wave's internal
// releases (ROW_WAVE_STEP apart, wider than the 0.30s rule) register with it too, so
// no OTHER group may release between two ripple steps on the shared escape lanes.
function placeRow(ctx: PlacementCtx, kind: FloorHazardKind, room: Room, maxLen: number): number {
  const { rng } = ctx;
  const isHorizontal = rng.chance(0.5);
  const len = Math.min(maxLen, 3 + rng.int(0, 3));
  for (let attempt = 0; attempt < 8; attempt++) {
    const tx0 = room.x + rng.int(0, Math.max(0, room.w - 1));
    const ty0 = room.y + rng.int(0, Math.max(0, room.h - 1));
    const cells: Array<[number, number]> = [];
    for (let i = 0; i < len; i++) {
      const tx = tx0 + (isHorizontal ? i : 0);
      const ty = ty0 + (isHorizontal ? 0 : i);
      // A row never runs past its room: every cell must stay under the room's own
      // overlap arbiter — a tail bleeding into the neighbor room (or a corridor) would
      // be pressure that room's schedule never arbitrated.
      if (tx >= room.x + room.w || ty >= room.y + room.h) break;
      if (!isPlaceable(ctx, tx, ty)) break;
      cells.push([tx, ty]);
    }
    if (cells.length < 2) continue;
    if (!fitsDenialCap(ctx, room, cells.length)) return 0;
    // Vents erupt as one channel (one release); spikes ripple down the row.
    const step = kind === "fire_vent" ? 0 : ROW_WAVE_STEP;
    const timing = HAZARD_TIMING[kind]!;
    const envelope = timing.active + (cells.length - 1) * step;
    const offsets = step === 0 ? [0] : cells.map((_, i) => i * step);
    const start = scheduleGroup(ctx, room, envelope, offsets);
    if (start === null) return 0;
    const group = ctx.nextGroup++;
    cells.forEach(([tx, ty], i) => claim(ctx, room, kind, tx, ty, phaseForActiveStart(kind, start + i * step), group));
    return cells.length;
  }
  return 0;
}

// An organic pool blob grown from a seed tile, wall-hugging by preference so the room
// keeps its open lanes. Pools are static (no release to arbitrate) but they are
// PERMANENT denial, so every tile still charges the room's denial budget. Every tile
// passes the local articulation test.
function placeBlob(ctx: PlacementCtx, room: Room, maxLen: number): number {
  const { rng } = ctx;
  const target = Math.min(maxLen, 3 + rng.int(0, 4));
  for (let attempt = 0; attempt < 8; attempt++) {
    const tx0 = room.x + rng.int(0, Math.max(0, room.w - 1));
    const ty0 = room.y + rng.int(0, Math.max(0, room.h - 1));
    if (!isPlaceable(ctx, tx0, ty0) || !poolKeepsPathOpen(ctx, tx0, ty0)) continue;
    if (!fitsDenialCap(ctx, room, 1)) return 0;
    const group = ctx.nextGroup++;
    claim(ctx, room, "toxic_pool", tx0, ty0, 0, group);
    let placed = 1;
    const frontier: Array<[number, number]> = [[tx0, ty0]];
    let guard = 0;
    while (placed < target && frontier.length > 0 && guard++ < 40) {
      const [fx, fy] = frontier[rng.int(0, frontier.length - 1)];
      const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const [dx, dy] = dirs[rng.int(0, 3)];
      const nx = fx + dx, ny = fy + dy;
      if (!isPlaceable(ctx, nx, ny) || !poolKeepsPathOpen(ctx, nx, ny)) continue;
      if (!fitsDenialCap(ctx, room, 1)) break;
      claim(ctx, room, "toxic_pool", nx, ny, 0, group);
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
    if (!fitsDenialCap(ctx, room, 1)) return 0;
    const timing = HAZARD_TIMING.void_rift!;
    const start = scheduleGroup(ctx, room, timing.active, [0]);
    if (start === null) return 0;
    claim(ctx, room, "void_rift", tx, ty, phaseForActiveStart("void_rift", start), ctx.nextGroup++);
    return 1;
  }
  return 0;
}

// Deterministic per-floor hazard layout, parameterized by difficulty (studio gate §1-2:
// Casual 0.65x / Standard 1.00x / Brutal 1.30x budgets, with per-room simultaneity and
// denial caps enforced by the shared arbiter above). Own seeded stream (like props/
// chests) so it never perturbs enemy/loot rolls, and the stream is difficulty-INVARIANT
// in shape: the mode changes budgets and caps, never the draw pattern semantics. Rooms
// marked "hazard" by the generator are dressed first and densest — authored set pieces;
// the remaining budget scatters smaller formations through ordinary combat rooms.
export function placeFloorHazards(d: Dungeon, seed: number, floor: number, difficulty: Difficulty = "standard"): FloorHazard[] {
  let budget = floorHazardBudgetFor(floor, difficulty);
  if (budget <= 0 || d.rooms.length < 2) return [];
  const rng = new Rng((seed ^ 0x6a2d9b4f) + floor * 79241);
  const profile = BIOME_HAZARDS[biomeIndexForFloor(floor)];
  const rules = HAZARD_DIFFICULTY[difficulty];
  const ctx: PlacementCtx = {
    d, rng,
    taken: new Set<number>(),
    list: [],
    nextId: 0,
    nextGroup: 0,
    simultaneousCap: rules.roomSimultaneousCap,
    denialCap: rules.roomDenialCap,
    schedules: new Map<Room, RoomSchedule>(),
  };

  const place = (kind: FloorHazardKind, room: Room, cap: number): number => {
    if (kind === "toxic_pool") return placeBlob(ctx, room, cap);
    if (kind === "void_rift") return placeRift(ctx, room);
    return placeRow(ctx, kind, room, cap);
  };

  // Set-piece pass: hazard rooms burn ~half the budget in dense formations.
  const hazardRooms = d.rooms.filter((r) => r.kind === "hazard");
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

  // Scatter pass: everything else, spread across eligible rooms (never spawn/treasure/
  // shop). Rooms whose arbiter or denial budget is saturated simply absorb no more — the
  // caps are ceilings, never targets, so a floor may land under budget on Casual.
  const eligible = d.rooms.filter((r) => r.kind !== "spawn" && r.kind !== "treasure" && r.kind !== "shop");
  let guard = 0;
  while (budget > 0 && eligible.length > 0 && guard++ < 40) {
    const room = eligible[rng.int(0, eligible.length - 1)];
    budget -= place(pickKind(rng, profile), room, budget) || 0;
  }
  return ctx.list;
}
