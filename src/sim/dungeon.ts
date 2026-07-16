// Depth-progressive dungeon generator. Floors are built as a JOURNEY: rooms are placed,
// then chained nearest-first from the spawn so corridors read as a route (the exit lands
// far from the start), with loop shortcuts layered on top. Every room carries a shape
// archetype — the deeper the floor, the more dramatic the draw: plain cells give way to
// pillared halls, arenas, organic caverns, gauntlets and sealed vaults, and boss floors
// stage the fight in a purpose-built grand arena. Deep floors also erode (rubble columns
// pock the open rooms). Fully deterministic from (seed, floor).
//
// Hard invariants the rest of the game leans on (test/depth.test.ts locks them):
//   - Every room's center tile is open floor (chests, corridor anchors, the shop layout,
//     enemy-spawn fallback all target centers).
//   - Every floor tile is reachable from the spawn (a final flood-fill pass converts any
//     sealed pocket back to wall, so the invariant holds by construction).
//   - The map border ring stays solid wall.

import type { TileKind } from "./types.js";
import { Rng } from "./rng.js";
import { isBossFloor } from "./enemies.js";
import { hasShopRoomOnFloor } from "./shop.js";

// "shop": Patch's waystation — the dedicated safe room on every shop floor (3/6/9, …).
// The whole content pipeline treats it as sanctuary ground: no enemies, no hazards, no
// props, no chests ever place inside it (world.ts / enemies.ts / hazards.ts all filter on
// this kind), and the shop layout itself is authored by src/sim/shop.ts off its geometry.
export type RoomKind = "spawn" | "normal" | "large" | "treasure" | "exit" | "hazard" | "shop";

// Visual/architectural archetype. The sim reads it for hazard set-dressing ("hazard"
// rooms host dense formations); the client reads it for per-room presentation.
export type RoomShape = "rect" | "cell" | "hall" | "pillars" | "arena" | "cavern" | "vault" | "gauntlet";

// Explicit corridor / door / shortcut edge retained from generation (Batch0). Shortcuts are
// invisible to rooms[] adjacency alone — never infer them later from tiles.
export interface RoomEdge {
  a: number;          // room id
  b: number;          // room id
  path: { x: number; y: number }[]; // corridor centerline tiles (dense)
  doorA: { x: number; y: number };  // mouth tile in room A
  doorB: { x: number; y: number };  // mouth tile in room B
  width: number;      // corridor width in tiles
  isShortcut: boolean;
  locked?: boolean;   // encounter may lock/unlock
}

// Boss-floor encounter blueprint plumbing (Batch0). 'arena' preserves Gorge F50; later
// batches author hunt/split/escape/escort without rewriting the dungeon graph.
export type EncounterStructureKind = "arena" | "hunt" | "split" | "escape" | "escort";

export interface EncounterBlueprint {
  structureKind: EncounterStructureKind;
  spawnRoomId: number;           // boss / encounter spawn room (not always rooms[last])
  objectiveRoomIds: number[];    // reserved objective rooms
  chaseEdgeIds: number[];        // authored chase/escape path; width guaranteed >= 3
}

export interface Dungeon {
  w: number;
  h: number;
  tiles: TileKind[]; // row-major, 0 = floor, 1 = wall, 2 = walkable lethal void
  rooms: Room[];
  edges: RoomEdge[]; // authoritative graph (chain + shortcuts); never inferred later
  blueprint: EncounterBlueprint | null;
  spawn: { x: number; y: number }; // tile coords
  exit: { x: number; y: number };  // tile coords
}

export interface Room {
  id: number; // index-stable for the floor seed (equals rooms[] index after journey order)
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  kind: RoomKind;
  shape: RoomShape;
}

function roomContains(room: Room, tx: number, ty: number): boolean {
  return tx >= room.x && ty >= room.y && tx < room.x + room.w && ty < room.y + room.h;
}

// Tile -> room id. Room rects win; corridor tiles resolve to the nearer door-endpoint among
// edges whose path contains the tile (Manhattan). Returns -1 when neither applies.
export function roomIdAt(d: Dungeon, tx: number, ty: number): number {
  for (const room of d.rooms) {
    if (roomContains(room, tx, ty)) return room.id;
  }
  let bestId = -1;
  let bestD = Infinity;
  for (const edge of d.edges) {
    let onPath = false;
    for (const p of edge.path) {
      if (p.x === tx && p.y === ty) { onPath = true; break; }
    }
    if (!onPath) continue;
    const da = Math.abs(tx - edge.doorA.x) + Math.abs(ty - edge.doorA.y);
    const db = Math.abs(tx - edge.doorB.x) + Math.abs(ty - edge.doorB.y);
    if (da <= db) {
      if (da < bestD) { bestD = da; bestId = edge.a; }
    } else if (db < bestD) {
      bestD = db; bestId = edge.b;
    }
  }
  return bestId;
}

export function neighbors(d: Dungeon, roomId: number): RoomEdge[] {
  return d.edges.filter((e) => e.a === roomId || e.b === roomId);
}

export function edgeBetween(d: Dungeon, a: number, b: number): RoomEdge | null {
  for (const e of d.edges) {
    if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return e;
  }
  return null;
}

// Overall run depth 0..1 (floor 26+ = 1): the master escalation dial for shape drama,
// corridor character and erosion.
function depthFactor(floor: number): number {
  return Math.min(1, Math.max(0, (floor - 1) / 25));
}

// ---- shape selection ----

interface ShapeSpec {
  shape: RoomShape;
  minW: number; maxW: number;
  minH: number; maxH: number;
}

const SHAPE_SPECS: Record<RoomShape, ShapeSpec> = {
  cell: { shape: "cell", minW: 4, maxW: 6, minH: 4, maxH: 6 },
  rect: { shape: "rect", minW: 5, maxW: 10, minH: 5, maxH: 9 },
  hall: { shape: "hall", minW: 9, maxW: 13, minH: 8, maxH: 11 },
  pillars: { shape: "pillars", minW: 9, maxW: 14, minH: 8, maxH: 11 },
  arena: { shape: "arena", minW: 11, maxW: 16, minH: 9, maxH: 13 },
  cavern: { shape: "cavern", minW: 9, maxW: 15, minH: 8, maxH: 12 },
  vault: { shape: "vault", minW: 8, maxW: 10, minH: 8, maxH: 10 },
  gauntlet: { shape: "gauntlet", minW: 10, maxW: 16, minH: 4, maxH: 6 },
};

// Within-band curriculum slot (blobrogue_ENCOUNTER_CURRICULUM_spec.md §2): every band
// runs Arrive(0) -> Discover(1) -> Decide(2) -> Synthesize(3) -> Prove(4, the milestone).
// The LEVEL expresses the same cadence the encounters do: Arrive floors breathe after a
// milestone, drama completes by the Synthesize floor, and the Prove floor stages its
// arena. Repeats every band, including past floor 30.
export function floorSlot(floor: number): number {
  return (Math.max(1, Math.floor(floor)) - 1) % 5;
}

// How hard this floor's architecture leans dramatic: the curriculum cadence dial.
const SLOT_DRAMA: readonly number[] = [0.65, 0.95, 1.1, 1.3, 0.8];

// Depth-weighted shape table: floor 1 is almost all plain rooms; by the Gilded Archive
// and Emberreach most rooms are dramatic. The within-band slot modulates the drama so an
// Arrive floor reads calmer than its band's Synthesize floor. Gate floors keep early
// runs readable.
function rollShape(rand: Rng, floor: number): RoomShape {
  const d = depthFactor(floor);
  const drama = SLOT_DRAMA[floorSlot(floor)];
  const weights: Array<{ shape: RoomShape; w: number }> = [
    { shape: "rect", w: (3.0 - 1.8 * d) / drama },
    { shape: "cell", w: (1.2 - 0.4 * d) / drama },
    { shape: "hall", w: 1.0 + 0.6 * d },
    { shape: "pillars", w: floor >= 4 ? (0.7 + 1.3 * d) * drama : 0 },
    { shape: "arena", w: floor >= 6 ? (0.4 + 1.2 * d) * drama : 0 },
    { shape: "cavern", w: floor >= 8 ? (0.6 + 1.7 * d) * drama : 0 },
    { shape: "gauntlet", w: floor >= 3 ? (0.5 + 0.9 * d) * drama : 0 },
  ];
  const total = weights.reduce((s, x) => s + x.w, 0);
  let roll = rand.next() * total;
  for (const x of weights) {
    roll -= x.w;
    if (roll <= 0) return x.shape;
  }
  return "rect";
}

// ---- the anti-repeat deck (curriculum §4, level-architecture rows) ----

const DRAMATIC_SHAPES: ReadonlySet<RoomShape> = new Set(["pillars", "arena", "cavern", "gauntlet"]);
const MIN_SIMPLE_SHARE = 0.3;

function isDemotable(room: Room): boolean {
  return room.shape !== "vault" && DRAMATIC_SHAPES.has(room.shape);
}

function demote(room: Room): void {
  room.shape = room.w >= 9 && room.h >= 8 ? "hall" : room.w >= 5 && room.h >= 5 ? "rect" : "cell";
}

// Walked along the JOURNEY chain (the order the player experiences rooms), before
// carving: no archetype three times in a row, a simple breather always follows an
// arena, and at least 30% of the floor stays simple/mastery ground. Deterministic —
// pure demotions in fixed order, no rng.
function applyAntiRepeatDeck(chain: Room[], protectedRoom: Room | null): void {
  for (let i = 2; i < chain.length; i++) {
    if (chain[i].shape !== chain[i - 1].shape || chain[i].shape !== chain[i - 2].shape || !DRAMATIC_SHAPES.has(chain[i].shape)) continue;
    // Break the triple by demoting the newest card — or the middle one when the newest
    // is the protected milestone arena (which is never touched).
    if (chain[i] !== protectedRoom && isDemotable(chain[i])) demote(chain[i]);
    else if (chain[i - 1] !== protectedRoom && isDemotable(chain[i - 1])) demote(chain[i - 1]);
  }
  for (let i = 1; i < chain.length; i++) {
    if (chain[i] === protectedRoom) continue;
    if (chain[i - 1].shape === "arena" && isDemotable(chain[i])) demote(chain[i]);
  }
  const isSimple = (r: Room) => r.shape === "rect" || r.shape === "cell" || r.shape === "hall";
  let simple = chain.filter(isSimple).length;
  for (let i = chain.length - 1; i >= 0 && simple < Math.ceil(chain.length * MIN_SIMPLE_SHARE); i--) {
    if (chain[i] === protectedRoom || !isDemotable(chain[i])) continue;
    demote(chain[i]);
    simple++;
  }
}

function rollSize(rand: Rng, shape: RoomShape): { w: number; h: number } {
  const spec = SHAPE_SPECS[shape];
  let w = spec.minW + rand.int(0, spec.maxW - spec.minW);
  let h = spec.minH + rand.int(0, spec.maxH - spec.minH);
  // Gauntlets are corridors-with-a-purpose: half of them run vertical.
  if (shape === "gauntlet" && rand.chance(0.5)) { const t = w; w = h; h = t; }
  return { w, h };
}

// ---- carving ----

interface Carver {
  tiles: TileKind[];
  w: number;
  h: number;
  corridor: Set<number>; // corridor-carved tile indices (erosion avoids them)
}

function open(c: Carver, tx: number, ty: number): void {
  if (tx <= 0 || ty <= 0 || tx >= c.w - 1 || ty >= c.h - 1) return; // border stays wall
  c.tiles[ty * c.w + tx] = 0;
}

function wall(c: Carver, tx: number, ty: number): void {
  c.tiles[ty * c.w + tx] = 1;
}

function carveRoom(c: Carver, rand: Rng, room: Room): void {
  const { x, y, w, h } = room;
  switch (room.shape) {
    case "cavern": {
      // Star-shaped organic blob: a per-angle radius limit built from two low-frequency
      // harmonics. Star-shaped domains stay connected; the final flood pass guarantees it.
      const a1 = rand.range(0.06, 0.16);
      const a2 = rand.range(0.04, 0.12);
      const k1 = rand.int(2, 3);
      const k2 = rand.int(4, 5);
      const p1 = rand.range(0, Math.PI * 2);
      const p2 = rand.range(0, Math.PI * 2);
      const rx = (w - 1) / 2, ry = (h - 1) / 2;
      for (let ty = 0; ty < h; ty++) {
        for (let tx = 0; tx < w; tx++) {
          const nx = (tx - rx) / rx, ny = (ty - ry) / ry;
          const r = Math.hypot(nx, ny);
          const ang = Math.atan2(ny, nx);
          const limit = 1 - a1 * Math.sin(k1 * ang + p1) - a2 * Math.sin(k2 * ang + p2);
          if (r <= limit) open(c, x + tx, y + ty);
        }
      }
      break;
    }
    case "arena": {
      // Rounded fighting pit: corner steps cut off, reading as an octagon.
      const cut = Math.min(3, Math.floor(Math.min(w, h) / 4));
      for (let ty = 0; ty < h; ty++) {
        for (let tx = 0; tx < w; tx++) {
          const dx = Math.min(tx, w - 1 - tx);
          const dy = Math.min(ty, h - 1 - ty);
          if (dx + dy < cut) continue;
          open(c, x + tx, y + ty);
        }
      }
      break;
    }
    default: {
      for (let ty = 0; ty < h; ty++) for (let tx = 0; tx < w; tx++) open(c, x + tx, y + ty);
      break;
    }
  }
  // Center cross invariant (skipped for vaults, whose ring hugs the center by design —
  // the ring pass runs later and manages its own openings).
  open(c, room.cx, room.cy);
  if (room.shape !== "vault") {
    open(c, room.cx + 1, room.cy);
    open(c, room.cx - 1, room.cy);
    open(c, room.cx, room.cy + 1);
    open(c, room.cx, room.cy - 1);
  }
}

// Pillars punched back into a carved hall: a grid of 1x1 (deep floors sometimes 2x2)
// columns with 2-wide lanes, kept off the center cross so the room's anchor stays open.
function carvePillars(c: Carver, rand: Rng, room: Room, floor: number): void {
  const big = floor >= 14 && room.w >= 12 && room.h >= 10 && rand.chance(0.5);
  const size = big ? 2 : 1;
  const step = size + 2;
  for (let py = room.y + 2; py + size <= room.y + room.h - 2; py += step) {
    for (let px = room.x + 2; px + size <= room.x + room.w - 2; px += step) {
      let isClear = true;
      for (let dy = 0; dy < size && isClear; dy++) {
        for (let dx = 0; dx < size && isClear; dx++) {
          if (Math.abs(px + dx - room.cx) + Math.abs(py + dy - room.cy) <= 1) isClear = false;
        }
      }
      if (!isClear) continue;
      for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) wall(c, px + dx, py + dy);
    }
  }
}

// Arena centerpiece (deep floors): four column nubs in a diamond around the center —
// cover that shapes the fight without hiding the boss.
function carveArenaPiece(c: Carver, rand: Rng, room: Room, floor: number): void {
  if (floor < 12 || room.w < 12 || room.h < 10 || !rand.chance(0.6)) return;
  const r = 3;
  wall(c, room.cx - r, room.cy);
  wall(c, room.cx + r, room.cy);
  wall(c, room.cx, room.cy - Math.min(r, Math.floor(room.h / 2) - 2));
  wall(c, room.cx, room.cy + Math.min(r, Math.floor(room.h / 2) - 2));
}

// The treasure vault ring: a sealed inner sanctum. Shallow floors leave all four mid-side
// doors; floor 11+ seals it down to two (a real vault run). Runs AFTER corridors so a
// corridor punched through the ring is re-walled — entry is only ever through the doors.
function carveVaultRing(c: Carver, rand: Rng, room: Room, floor: number): void {
  if (room.w < 7 || room.h < 7) return;
  const inset = 2;
  const ix0 = room.x + inset;
  const iy0 = room.y + inset;
  const ix1 = room.x + room.w - inset - 1;
  const iy1 = room.y + room.h - inset - 1;
  for (let x = ix0; x <= ix1; x++) { wall(c, x, iy0); wall(c, x, iy1); }
  for (let y = iy0; y <= iy1; y++) { wall(c, ix0, y); wall(c, ix1, y); }
  open(c, room.cx, room.cy);
  if (floor >= 11) {
    if (rand.chance(0.5)) { open(c, room.cx, iy0); open(c, room.cx, iy1); }
    else { open(c, ix0, room.cy); open(c, ix1, room.cy); }
  } else {
    open(c, room.cx, iy0);
    open(c, room.cx, iy1);
    open(c, ix0, room.cy);
    open(c, ix1, room.cy);
  }
}

// ---- corridors ----

function carveH(c: Carver, x0: number, x1: number, y: number, width: number): void {
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
    for (let i = 0; i < width; i++) {
      open(c, x, y + i);
      c.corridor.add((y + i) * c.w + x);
    }
  }
}

function carveV(c: Carver, y0: number, y1: number, x: number, width: number): void {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let i = 0; i < width; i++) {
      open(c, x + i, y);
      c.corridor.add(y * c.w + x + i);
    }
  }
}

// Corridor personality by depth: shallow floors dig plain 2-wide L-halls; deeper floors
// mix cramped 1-wide crawls, broad 3-wide galleries, and Z-jogs that break sightlines.
function rollCorridorWidth(rand: Rng, floor: number): number {
  if (floor <= 2) return 2;
  const d = depthFactor(floor);
  const r = rand.next();
  if (r < 0.18 + 0.14 * d) return 1;
  if (r < 0.30 + 0.24 * d) return 3;
  return 2;
}

function pushPathUnique(path: { x: number; y: number }[], x: number, y: number): void {
  const last = path[path.length - 1];
  if (last && last.x === x && last.y === y) return;
  path.push({ x, y });
}

function pathH(path: { x: number; y: number }[], x0: number, x1: number, y: number): void {
  const step = x0 <= x1 ? 1 : -1;
  for (let x = x0; ; x += step) {
    pushPathUnique(path, x, y);
    if (x === x1) break;
  }
}

function pathV(path: { x: number; y: number }[], y0: number, y1: number, x: number): void {
  const step = y0 <= y1 ? 1 : -1;
  for (let y = y0; ; y += step) {
    pushPathUnique(path, x, y);
    if (y === y1) break;
  }
}

function doorMouth(room: Room, path: { x: number; y: number }[], fromStart: boolean): { x: number; y: number } {
  if (path.length === 0) return { x: room.cx, y: room.cy };
  if (fromStart) {
    let last = path[0];
    for (const p of path) {
      if (!roomContains(room, p.x, p.y)) break;
      last = p;
    }
    return { x: last.x, y: last.y };
  }
  let last = path[path.length - 1];
  for (let i = path.length - 1; i >= 0; i--) {
    const p = path[i];
    if (!roomContains(room, p.x, p.y)) break;
    last = p;
  }
  return { x: last.x, y: last.y };
}

// Carve a corridor and RETURN the authoritative RoomEdge (Batch0). RNG draws stay in the
// same order/count as the pre-graph generator so existing dungeon tiles stay bit-identical.
function connectRooms(
  c: Carver,
  rand: Rng,
  a: Room,
  b: Room,
  floor: number,
  forceWidth: number | undefined,
  isShortcut: boolean,
): RoomEdge {
  const width = forceWidth ?? rollCorridorWidth(rand, floor);
  const isZ = floor >= 4 && rand.chance(0.25 + 0.35 * depthFactor(floor));
  const path: { x: number; y: number }[] = [];
  if (isZ && Math.abs(a.cx - b.cx) >= 6) {
    // Z-jog on the horizontal run: two bends read as a dug passage, not a ruler line.
    const mx = Math.min(a.cx, b.cx) + 2 + rand.int(0, Math.abs(a.cx - b.cx) - 4);
    carveH(c, a.cx, mx, a.cy, width);
    carveV(c, a.cy, b.cy, mx, width);
    carveH(c, mx, b.cx, b.cy, width);
    pathH(path, a.cx, mx, a.cy);
    pathV(path, a.cy, b.cy, mx);
    pathH(path, mx, b.cx, b.cy);
  } else if (rand.chance(0.5)) {
    carveH(c, a.cx, b.cx, a.cy, width);
    carveV(c, a.cy, b.cy, b.cx, width);
    pathH(path, a.cx, b.cx, a.cy);
    pathV(path, a.cy, b.cy, b.cx);
  } else {
    carveV(c, a.cy, b.cy, a.cx, width);
    carveH(c, a.cx, b.cx, b.cy, width);
    pathV(path, a.cy, b.cy, a.cx);
    pathH(path, a.cx, b.cx, b.cy);
  }
  return {
    a: a.id,
    b: b.id,
    path,
    doorA: doorMouth(a, path, true),
    doorB: doorMouth(b, path, false),
    width,
    isShortcut,
  };
}

// ---- erosion (deep-floor decay) ----

// Rubble columns pocking the deep floors: single wall nubs dropped onto open room floor.
// The all-8-neighbors-open rule means a nub can never pinch a passage shut, and corridor
// tiles are never touched — connectivity is provably preserved.
function erodeRubble(c: Carver, rand: Rng, rooms: Room[], floor: number): void {
  if (floor < 9) return;
  const count = Math.min(9, 1 + Math.floor((floor - 9) / 2)) + rand.int(0, 2);
  let placed = 0;
  let guard = 0;
  while (placed < count && guard++ < count * 12) {
    const room = rooms[rand.int(0, rooms.length - 1)];
    // Spawn, exit and shop rooms stay clear (the descend gathering; on boss floors the
    // exit room IS the fight arena — the squeeze needs clean lanes to the safe radius;
    // and Patch's waystation keeps its authored floor plan).
    if (room.kind === "spawn" || room.kind === "exit" || room.kind === "shop" || room.shape === "vault" || room.shape === "cell") continue;
    const tx = room.x + 2 + rand.int(0, Math.max(0, room.w - 5));
    const ty = room.y + 2 + rand.int(0, Math.max(0, room.h - 5));
    if (Math.abs(tx - room.cx) + Math.abs(ty - room.cy) <= 2) continue;
    if (c.corridor.has(ty * c.w + tx)) continue;
    let isClear = true;
    for (let dy = -1; dy <= 1 && isClear; dy++) {
      for (let dx = -1; dx <= 1 && isClear; dx++) {
        if (c.tiles[(ty + dy) * c.w + tx + dx] !== 0) isClear = false;
        if (c.corridor.has((ty + dy) * c.w + tx + dx)) isClear = false;
      }
    }
    if (!isClear) continue;
    wall(c, tx, ty);
    placed++;
  }
}

// ---- connectivity guarantee ----

// Flood from the spawn and convert unreachable floor pockets back to wall. With chained
// center-anchored corridors this is nearly always a no-op, but it turns "should be
// connected" into "is connected" for every seed, forever.
function sealUnreachable(c: Carver, spawn: { x: number; y: number }): void {
  const dist = new Int32Array(c.w * c.h).fill(-1);
  const queue: number[] = [];
  const start = spawn.y * c.w + spawn.x;
  if (c.tiles[start] !== 0) return;
  dist[start] = 0;
  queue.push(start);
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const cx = cur % c.w;
    const cy = (cur / c.w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= c.w || ny >= c.h) continue;
      const ni = ny * c.w + nx;
      if (c.tiles[ni] !== 0 || dist[ni] !== -1) continue;
      dist[ni] = 1;
      queue.push(ni);
    }
  }
  for (let i = 0; i < c.tiles.length; i++) {
    if (c.tiles[i] === 0 && dist[i] === -1) c.tiles[i] = 1;
  }
}

// ---- role assignment ----

function assignKinds(rand: Rng, rooms: Room[], floor: number, shopRoom: Room | null): void {
  for (const room of rooms) {
    room.kind = room.shape === "vault" ? "treasure"
      : (room.w >= 9 || room.h >= 8) ? "large"
      : "normal";
  }
  rooms[0].kind = "spawn";
  rooms[rooms.length - 1].kind = "exit";
  // The shop room's kind is claimed before the hazard pass so a shop can never double as
  // an authored danger room (the caller only passes a mid-chain room, never spawn/exit).
  if (shopRoom !== null) shopRoom.kind = "shop";
  // Hazard set-piece rooms (floor 6+): up to two mid-chain rooms become authored danger
  // — gauntlets first (spike lanes down a long hall are the classic), then any large room.
  if (floor >= 6 && rooms.length >= 5) {
    const want = floor >= 16 ? 2 : 1;
    let marked = 0;
    const candidates = rooms.slice(1, rooms.length - 1).filter((r) => r.kind !== "treasure" && r.kind !== "shop");
    candidates.sort((a, b) => (a.shape === "gauntlet" ? -1 : 0) - (b.shape === "gauntlet" ? -1 : 0));
    for (const room of candidates) {
      if (marked >= want) break;
      if (room.shape === "gauntlet" || ((room.kind === "large") && rand.chance(0.5))) {
        room.kind = "hazard";
        marked++;
      }
    }
  }
}

// ---- the generator ----

function overlaps(rooms: Room[], rx: number, ry: number, rw: number, rh: number): boolean {
  return rooms.some((r) => rx < r.x + r.w + 1 && rx + rw + 1 > r.x && ry < r.y + r.h + 1 && ry + rh + 1 > r.y);
}

function makeRoom(rx: number, ry: number, rw: number, rh: number, shape: RoomShape): Room {
  return {
    id: -1,
    x: rx, y: ry, w: rw, h: rh,
    cx: Math.floor(rx + rw / 2),
    cy: Math.floor(ry + rh / 2),
    kind: "normal",
    shape,
  };
}

// Order rooms into a journey: start from the room nearest a seeded corner, then greedily
// hop to the nearest unvisited room. The chain END becomes the exit — naturally far from
// the spawn, and every floor reads as a route instead of a scatter.
function chainRooms(rand: Rng, rooms: Room[]): Room[] {
  if (rooms.length <= 2) return rooms.slice();
  const cornerX = rand.chance(0.5) ? 0 : 1;
  const cornerY = rand.chance(0.5) ? 0 : 1;
  const remaining = rooms.slice();
  let bestIdx = 0;
  let bestD = Infinity;
  for (let i = 0; i < remaining.length; i++) {
    const r = remaining[i];
    const d = Math.abs(r.cx - cornerX * 1000) + Math.abs(r.cy - cornerY * 1000);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  const chain: Room[] = remaining.splice(bestIdx, 1);
  while (remaining.length > 0) {
    const last = chain[chain.length - 1];
    let nearIdx = 0;
    let nearD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const r = remaining[i];
      const d = Math.abs(r.cx - last.cx) + Math.abs(r.cy - last.cy);
      if (d < nearD) { nearD = d; nearIdx = i; }
    }
    chain.push(remaining.splice(nearIdx, 1)[0]);
  }
  return chain;
}

export function generateDungeon(seed: number, floor: number): Dungeon {
  const rand = new Rng(seed + floor * 1013904223);
  const w = 40 + Math.min(floor * 2, 26);
  const h = 30 + Math.min(floor * 2, 20);
  const c: Carver = { tiles: new Array<TileKind>(w * h).fill(1), w, h, corridor: new Set() };
  const isBoss = isBossFloor(floor);

  // ---- place rooms ----
  const rooms: Room[] = [];
  let bossArena: Room | null = null;
  if (isBoss) {
    // The band's capstone: a purpose-built grand arena, placed first so it always fits.
    const aw = 13 + rand.int(0, 4);
    const ah = 11 + rand.int(0, 3);
    for (let attempt = 0; attempt < 80 && !bossArena; attempt++) {
      const rx = 2 + rand.int(0, w - aw - 4);
      const ry = 2 + rand.int(0, h - ah - 4);
      if (overlaps(rooms, rx, ry, aw, ah)) continue;
      bossArena = makeRoom(rx, ry, aw, ah, "arena");
      rooms.push(bossArena);
    }
  }
  // Shop floors host Patch's waystation (the Dealer cadence, or a premium landing —
  // hasShopRoomOnFloor): a dedicated LARGER room, placed first (like the arena) so it
  // always fits, on plain rect floor — the shop layout needs clean ground and the
  // safe-room read needs a calm silhouette. Boss floors never carry one, so the arena
  // and the shop never compete for first placement.
  let shopRoom: Room | null = null;
  if (hasShopRoomOnFloor(floor)) {
    const sw = 11 + rand.int(0, 2);
    const sh = 8 + rand.int(0, 2);
    for (let attempt = 0; attempt < 80 && !shopRoom; attempt++) {
      const rx = 2 + rand.int(0, w - sw - 4);
      const ry = 2 + rand.int(0, h - sh - 4);
      if (overlaps(rooms, rx, ry, sw, sh)) continue;
      shopRoom = makeRoom(rx, ry, sw, sh, "rect");
      rooms.push(shopRoom);
    }
  }

  const wantRooms = isBoss ? 4 + rand.int(0, 2) : 6 + rand.int(0, 3) + Math.min(floor, 6);
  const isVaultWanted = !isBoss && floor >= 2;
  let isVaultPlaced = false;
  let attempts = 0;
  while (rooms.length < wantRooms + (bossArena ? 1 : 0) && attempts < 400) {
    attempts++;
    const isVaultTry = isVaultWanted && !isVaultPlaced && rooms.length >= 2;
    const shape = isVaultTry ? "vault" : rollShape(rand, floor);
    const { w: rw, h: rh } = rollSize(rand, shape);
    const rx = 1 + rand.int(0, w - rw - 3);
    const ry = 1 + rand.int(0, h - rh - 3);
    if (overlaps(rooms, rx, ry, rw, rh)) continue;
    rooms.push(makeRoom(rx, ry, rw, rh, shape));
    if (shape === "vault") isVaultPlaced = true;
  }

  // ---- order into a journey ----
  let chain: Room[];
  if (bossArena) {
    // The arena is always the FINAL room: chain everything else, then approach the boss.
    chain = chainRooms(rand, rooms.filter((r) => r !== bossArena));
    chain.push(bossArena);
  } else {
    chain = chainRooms(rand, rooms);
    // A vault must never be the spawn or the exit (its ring would cage the stairs).
    for (let i = 0; i < chain.length; i++) {
      if (chain[i].shape !== "vault") continue;
      if (i === 0 || i === chain.length - 1) {
        const j = Math.floor(chain.length / 2);
        const t = chain[i]; chain[i] = chain[j]; chain[j] = t;
      }
    }
    // The shop is a mid-journey stop, never the spawn or the exit room: the descend
    // gathering and the stairs both need their ground, and sanctuary hosting the exit
    // would break the fight-to-the-stairs cadence. Swapped toward the middle, walking
    // outward past any slot the vault already claimed.
    if (shopRoom !== null) {
      const at = chain.indexOf(shopRoom);
      if (at === 0 || at === chain.length - 1) {
        const mid = Math.floor(chain.length / 2);
        for (let off = 0; off < chain.length; off++) {
          const j = mid + (off % 2 === 0 ? off / 2 : -(off + 1) / 2);
          if (j <= 0 || j >= chain.length - 1 || chain[j].shape === "vault") continue;
          const t = chain[at]; chain[at] = chain[j]; chain[j] = t;
          break;
        }
      }
    }
  }

  // ---- the anti-repeat deck, then carve ----
  applyAntiRepeatDeck(chain, bossArena);
  for (const room of chain) carveRoom(c, rand, room);
  for (const room of chain) {
    if (room.shape === "pillars") carvePillars(c, rand, room, floor);
    if (room.shape === "arena" && room !== bossArena) carveArenaPiece(c, rand, room, floor);
  }

  // Stable room ids = journey index (Batch0). Assigned BEFORE edges so RoomEdge.a/b are final.
  for (let i = 0; i < chain.length; i++) chain[i].id = i;

  // ---- corridors: the chain, then loop shortcuts (edges retained authoritatively) ----
  const edges: RoomEdge[] = [];
  for (let i = 1; i < chain.length; i++) {
    const isBossApproach = bossArena !== null && i === chain.length - 1;
    edges.push(connectRooms(c, rand, chain[i - 1], chain[i], floor, isBossApproach ? 3 : undefined, false));
  }
  const extraCount = chain.length >= 4 ? rand.int(1, Math.min(3, Math.max(1, Math.floor(chain.length / 3)))) : 0;
  const linked = new Set<string>();
  for (let n = 0; n < extraCount; n++) {
    let pickI = -1;
    let pickJ = -1;
    let pickDist = Infinity;
    for (let t = 0; t < 12; t++) {
      const i = rand.int(0, chain.length - 3);
      const j = rand.int(i + 2, chain.length - 1);
      if (bossArena && j === chain.length - 1) continue; // one grand entrance, no back door
      const key = `${i}:${j}`;
      if (linked.has(key)) continue;
      const dist = Math.abs(chain[i].cx - chain[j].cx) + Math.abs(chain[i].cy - chain[j].cy);
      if (dist < pickDist) { pickDist = dist; pickI = i; pickJ = j; }
    }
    if (pickI < 0) continue;
    linked.add(`${pickI}:${pickJ}`);
    edges.push(connectRooms(c, rand, chain[pickI], chain[pickJ], floor, undefined, true));
  }

  // ---- set dressing: vault ring (re-seals corridor punctures), erosion, sealing ----
  // Degenerate guard: should the tiny-chain fallback have left the shop pinned at an end
  // (placement starved the floor down to almost nothing), the floor simply hosts no shop
  // rather than a shop-spawn or shop-exit hybrid.
  const shopMid = shopRoom !== null && chain.indexOf(shopRoom) > 0 && chain.indexOf(shopRoom) < chain.length - 1
    ? shopRoom
    : null;
  assignKinds(rand, chain, floor, shopMid);
  for (const room of chain) {
    if (room.kind === "treasure" && room.shape === "vault") carveVaultRing(c, rand, room, floor);
  }
  erodeRubble(c, rand, chain, floor);

  const first = chain[0];
  const last = chain[chain.length - 1];
  sealUnreachable(c, { x: first.cx, y: first.cy });

  // Boss-floor 'arena' blueprint: spawn/objective = final arena room; the grand approach
  // edge (last chain edge) is the chase path and already carved at width 3.
  let blueprint: EncounterBlueprint | null = null;
  if (bossArena !== null) {
    const spawnRoomId = last.id;
    const approachIdx = edges.length > 0 ? chain.length - 2 : -1; // chain edge index == rooms-1-1
    // Chain edges were pushed first (indices 0..chain.length-2); the approach is the last of those.
    const chaseEdgeIds: number[] = [];
    if (chain.length >= 2) {
      const approachEdge = edges.find((e) => !e.isShortcut && e.a === chain[chain.length - 2].id && e.b === last.id)
        ?? edges.find((e) => !e.isShortcut && e.b === chain[chain.length - 2].id && e.a === last.id);
      if (approachEdge) chaseEdgeIds.push(edges.indexOf(approachEdge));
    }
    blueprint = {
      structureKind: "arena",
      spawnRoomId,
      objectiveRoomIds: [spawnRoomId],
      chaseEdgeIds,
    };
    void approachIdx;
  }

  return {
    w,
    h,
    tiles: c.tiles,
    rooms: chain,
    edges,
    blueprint,
    spawn: { x: first.cx, y: first.cy },
    exit: { x: last.cx, y: last.cy },
  };
}
