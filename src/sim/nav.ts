// Dynamic-obstacle navigation. Walls live in the dungeon tile grid, but the things that
// actually wedge enemies in live rooms — barrels, crates, pots — are PROPS: dynamic
// (they break), placed after generation, and invisible to the plain wall flow field.
// Local tangent steering alone cannot solve them (a row, an L against a wall or a concave
// pocket defeats any greedy detour), so this module gives every ground enemy a real ROUTE:
//
//  - a per-tile CLEARANCE grid derived from live prop collision rings (the exact rings
//    moveCircle blocks on, PROP_BLOCK_RING × radius), rebuilt only when the obstacle
//    revision moves — i.e. when a prop breaks or a floor builds;
//  - prop-aware chase flow fields (multi-source BFS from the live targets) per CLEARANCE
//    CLASS, so a swarm bat may thread a gap a brute must route around. Fields rebuild
//    lazily, keyed to (target tiles generation, obstacle revision), and only for classes
//    an enemy actually queried — never per enemy, never per tick;
//  - reachability fields anchored at the floor spawn tile (where players enter), used to
//    validate every spawn/reinforcement/split/add position: full body clearance AND a
//    route to the playable region, so nothing spawns in a wall, inside a prop ring, on a
//    chest, or walled into a pocket no player can reach.
//
// Chests deliberately do NOT enter the clearance grid: they never block movement
// (moveCircle tests walls + props only), so routing around them would add fake detours.
// They matter to navigation only as spawn-footprint exclusions (world.isBodyClear).
//
// Everything here is pure deterministic data derived from (dungeon, props, obstacle
// revision, target tiles) — identical on the server and every replaying client — and
// allocation is bounded: grids/fields are sized once per dungeon and reused; steering
// writes into a shared scratch point, mirroring FlowField.step.

import { FlowField, DX, DY, UNREACHED } from "./pathfind.js";
import type { Dungeon } from "./dungeon.js";
import type { Prop } from "./types.js";
import { TILE } from "./types.js";
import { PROP_BLOCK_RING } from "./constants.js";

// Clearance classes: an enemy routes with the smallest class radius that contains its
// body. Three buckets cover the ground roster tightly (swarm ~10–12.5 / standard 13–16 /
// brute+elite ~16.2–20.8); a fourth, wide bucket carries the bosses (radius 26–36) so
// they route around walls and cover like everything else instead of beaching on them.
// Anything larger than the widest bucket clamps to it and leans on collision + steering.
export const NAV_CLASS_RADII = [13, 16, 21, 36] as const;

export function navClassFor(radius: number): number {
  for (let i = 0; i < NAV_CLASS_RADII.length; i++) {
    if (radius <= NAV_CLASS_RADII[i]) return i;
  }
  return NAV_CLASS_RADII.length - 1;
}

// Open clearance for a tile no prop constrains. Any value above the largest class radius
// is equivalent, so the stamp window below only needs local accuracy.
const CLEARANCE_OPEN = 1e6;

// Tile window a single prop's stamp covers. Centers up to 2 tiles away (96px) are
// further than any (class radius + prop ring) the roster can produce, so the min-combine
// never misses a tile whose blocked/free verdict the prop could change.
const STAMP_WINDOW = 2;

export interface NavRuntime {
  w: number;
  h: number;
  // px: the largest body radius that can stand at this tile's center without touching a
  // live prop's collision ring. Walls are not folded in — the tile grid carries them.
  clearance: Float32Array;
  clearanceRev: number; // obstacle revision the clearance grid reflects
  // Prop-aware chase fields (sources = live target tiles), one per clearance class,
  // rebuilt lazily when `stamp` moves past the class's last build.
  chase: FlowField[];
  chaseStamp: number[];
  // Reachability fields anchored at the floor spawn tile, one per class, keyed by
  // (obstacle revision, anchor tile) — floor builds move the anchor, prop breaks only
  // ever OPEN routes, so a key hit is always still valid.
  reach: FlowField[];
  reachRev: number[];
  reachAnchor: number[];
  anchorScratch: number[];
  // Current chase target tiles + the generation counter that invalidates chase fields.
  sources: number[];
  stamp: number;
}

export function createNav(): NavRuntime {
  const classes = NAV_CLASS_RADII.length;
  return {
    w: 0,
    h: 0,
    clearance: new Float32Array(0),
    clearanceRev: -1,
    chase: Array.from({ length: classes }, () => new FlowField()),
    chaseStamp: new Array<number>(classes).fill(-1),
    reach: Array.from({ length: classes }, () => new FlowField()),
    reachRev: new Array<number>(classes).fill(-1),
    reachAnchor: new Array<number>(classes).fill(-1),
    anchorScratch: [0],
    sources: [],
    stamp: 0,
  };
}

function ensureSize(nav: NavRuntime, dungeon: Dungeon): void {
  if (nav.w === dungeon.w && nav.h === dungeon.h) return;
  nav.w = dungeon.w;
  nav.h = dungeon.h;
  nav.clearance = new Float32Array(dungeon.w * dungeon.h);
  nav.clearanceRev = -1;
}

// Bring the clearance grid up to the given obstacle revision. O(live props) with a small
// constant stamp window per prop; a no-op while the revision holds. A revision move also
// bumps `stamp` so chase fields routed through the old prop set rebuild on next query.
export function syncNavClearance(nav: NavRuntime, dungeon: Dungeon, props: readonly Prop[], rev: number): void {
  ensureSize(nav, dungeon);
  if (nav.clearanceRev === rev) return;
  nav.clearanceRev = rev;
  nav.stamp++;
  nav.clearance.fill(CLEARANCE_OPEN);
  for (const p of props) {
    if (p.dead) continue;
    const ring = p.radius * PROP_BLOCK_RING;
    const ptx = Math.floor(p.x / TILE);
    const pty = Math.floor(p.y / TILE);
    for (let ty = pty - STAMP_WINDOW; ty <= pty + STAMP_WINDOW; ty++) {
      if (ty < 0 || ty >= nav.h) continue;
      for (let tx = ptx - STAMP_WINDOW; tx <= ptx + STAMP_WINDOW; tx++) {
        if (tx < 0 || tx >= nav.w) continue;
        const dx = (tx + 0.5) * TILE - p.x;
        const dy = (ty + 0.5) * TILE - p.y;
        const c = Math.hypot(dx, dy) - ring;
        const i = ty * nav.w + tx;
        if (c < nav.clearance[i]) nav.clearance[i] = c;
      }
    }
  }
}

// Record the current chase target tiles and invalidate the chase fields (they rebuild
// lazily, per class, on next query). Wall-tile sources are skipped by the flood itself;
// prop-blocked tiles are deliberately legal sources — a player hugging a barrel is still
// the tile to walk toward.
export function markNavTargets(nav: NavRuntime, sources: readonly number[]): void {
  nav.sources.length = 0;
  for (const s of sources) nav.sources.push(s);
  nav.stamp++;
}

export function navChaseField(nav: NavRuntime, dungeon: Dungeon, props: readonly Prop[], rev: number, classIdx: number): FlowField {
  syncNavClearance(nav, dungeon, props, rev);
  if (nav.chaseStamp[classIdx] !== nav.stamp) {
    nav.chaseStamp[classIdx] = nav.stamp;
    nav.chase[classIdx].build(dungeon, nav.sources, nav.clearance, NAV_CLASS_RADII[classIdx]);
  }
  return nav.chase[classIdx];
}

export function navReachField(nav: NavRuntime, dungeon: Dungeon, props: readonly Prop[], rev: number, classIdx: number, anchorIdx: number): FlowField {
  syncNavClearance(nav, dungeon, props, rev);
  if (nav.reachRev[classIdx] !== rev || nav.reachAnchor[classIdx] !== anchorIdx) {
    nav.reachRev[classIdx] = rev;
    nav.reachAnchor[classIdx] = anchorIdx;
    nav.anchorScratch[0] = anchorIdx;
    nav.reach[classIdx].build(dungeon, nav.anchorScratch, nav.clearance, NAV_CLASS_RADII[classIdx]);
  }
  return nav.reach[classIdx];
}

// Shared scratch for navStepPoint (callers read immediately; never stored).
export const navPoint = { x: 0, y: 0 };

// Resolve the next waypoint for a body at (x, y): the center of the downhill neighbor
// tile when the field knows one. A body standing INSIDE a blocked tile (legal — its
// center can sit in a tile whose own center a prop ring covers) first steps to the
// reachable neighbor tile nearest the targets, back onto the routable grid. Returns
// false on a source tile, in an unreachable pocket, or before any build — callers fall
// back to the direct line there.
export function navStepPoint(field: FlowField, x: number, y: number): boolean {
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  const here = field.distAt(tx, ty);
  if (here === 0) return false;
  if (here > 0) {
    if (!field.sampleStep(tx, ty)) return false;
    navPoint.x = (tx + field.step.dx + 0.5) * TILE;
    navPoint.y = (ty + field.step.dy + 0.5) * TILE;
    return true;
  }
  let best = Infinity;
  let bestX = 0;
  let bestY = 0;
  for (let k = 0; k < 8; k++) {
    const nx = tx + DX[k];
    const ny = ty + DY[k];
    const nd = field.distAt(nx, ny);
    if (nd === UNREACHED || nd >= best) continue; // fixed neighbor order breaks ties
    best = nd;
    bestX = nx;
    bestY = ny;
  }
  if (best === Infinity) return false;
  navPoint.x = (bestX + 0.5) * TILE;
  navPoint.y = (bestY + 0.5) * TILE;
  return true;
}
