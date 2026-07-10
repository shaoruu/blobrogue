// Pickups (coins, hearts) dropped by enemy deaths and prop breaks used to land at the raw
// source position — which can be inside a wall tile when a body dies flush against cover,
// leaving the drop visible but forever uncollectible. Every coin/heart now funnels through
// nudgePickupToWalkable in makePickup. This suite locks that shared clamp: a wall-ish point
// resolves to nearby walkable floor, a floor point is returned untouched (no golden churn),
// and the result is deterministic.
//
// Run: npm run test:pickupclamp

import { createWorld, nudgePickupToWalkable } from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import { TILE } from "../src/sim/types.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function isWallTile(w: WorldState, x: number, y: number): boolean {
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  if (tx < 0 || ty < 0 || tx >= w.dungeon.w || ty >= w.dungeon.h) return true;
  return w.dungeon.tiles[ty * w.dungeon.w + tx] === 1;
}

function wallResolvesToFloorSweep(): void {
  section("wall-ish drop points resolve to nearby walkable floor across real floors x seeds");
  let wallsChecked = 0;
  let stillInWall = 0;
  let tooFar = 0;
  for (let seedIdx = 0; seedIdx < 8; seedIdx++) {
    for (const floor of [1, 2, 3, 5, 6]) {
      const w = createWorld(0xD00D + seedIdx * 97, floor, { isShared: true, skipLocalPlayer: true });
      // Sample interior wall tiles adjacent to floor (the realistic "died against cover" case).
      for (let ty = 1; ty < w.dungeon.h - 1 && wallsChecked < 4000; ty++) {
        for (let tx = 1; tx < w.dungeon.w - 1; tx++) {
          if (w.dungeon.tiles[ty * w.dungeon.w + tx] !== 1) continue;
          const touchesFloor =
            w.dungeon.tiles[ty * w.dungeon.w + tx - 1] === 0 || w.dungeon.tiles[ty * w.dungeon.w + tx + 1] === 0 ||
            w.dungeon.tiles[(ty - 1) * w.dungeon.w + tx] === 0 || w.dungeon.tiles[(ty + 1) * w.dungeon.w + tx] === 0;
          if (!touchesFloor) continue;
          wallsChecked++;
          const src = { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
          const spot = nudgePickupToWalkable(w, src.x, src.y);
          if (isWallTile(w, spot.x, spot.y)) stillInWall++;
          if (Math.hypot(spot.x - src.x, spot.y - src.y) > TILE * 8) tooFar++;
        }
      }
    }
  }
  check(`wall-adjacent drops sampled (${wallsChecked})`, wallsChecked > 200, `n=${wallsChecked}`);
  check("no clamped drop remains inside a wall", stillInWall === 0, `stillInWall=${stillInWall}`);
  check("every clamp stays local (within 8 tiles of the source)", tooFar === 0, `tooFar=${tooFar}`);
}

function floorPointsUntouched(): void {
  section("drops already on floor are returned untouched (bit-identical — no golden churn)");
  const w = createWorld(0xF10, 2, { isShared: true, skipLocalPlayer: true });
  let checked = 0;
  let moved = 0;
  for (let ty = 1; ty < w.dungeon.h - 1 && checked < 500; ty++) {
    for (let tx = 1; tx < w.dungeon.w - 1; tx++) {
      if (w.dungeon.tiles[ty * w.dungeon.w + tx] !== 0) continue;
      // A few off-center points inside the floor tile — all must pass through unchanged.
      for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.8], [0.9, 0.1]] as const) {
        const x = (tx + fx) * TILE, y = (ty + fy) * TILE;
        const spot = nudgePickupToWalkable(w, x, y);
        checked++;
        if (spot.x !== x || spot.y !== y) moved++;
      }
    }
  }
  check(`floor points sampled (${checked})`, checked > 100);
  check("floor points are returned identical", moved === 0, `moved=${moved}`);
}

function deterministicClamp(): void {
  section("the clamp is deterministic (same input -> same output)");
  const w = createWorld(0xBEE5, 3, { isShared: true, skipLocalPlayer: true });
  let mismatches = 0;
  for (let ty = 1; ty < w.dungeon.h - 1; ty++) {
    for (let tx = 1; tx < w.dungeon.w - 1; tx++) {
      if (w.dungeon.tiles[ty * w.dungeon.w + tx] !== 1) continue;
      const x = (tx + 0.5) * TILE, y = (ty + 0.5) * TILE;
      const a = nudgePickupToWalkable(w, x, y);
      const b = nudgePickupToWalkable(w, x, y);
      if (a.x !== b.x || a.y !== b.y) mismatches++;
    }
  }
  check("repeat clamps agree", mismatches === 0, `mismatches=${mismatches}`);
}

function main(): void {
  wallResolvesToFloorSweep();
  floorPointsUntouched();
  deterministicClamp();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("\nPickup drops always resolve to walkable floor.\n");
}

main();
