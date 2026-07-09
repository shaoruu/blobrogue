#!/usr/bin/env node
// mapview — ASCII previewer for the dungeon generator + hazard layer. Level-design
// iteration without booting the client: prints rooms (shape letters), corridors, spawn/
// exit, and hazards for any seed/floor.
//   node tools/mapview.mjs [floor] [seed]      one floor
//   node tools/mapview.mjs --ladder [seed]     one floor per biome band
import { execSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";

const args = process.argv.slice(2);
const isLadder = args.includes("--ladder");
const rest = args.filter((a) => a !== "--ladder");
const floorArg = Number(rest[0] ?? 3);
const seedArg = Number(rest[1] ?? 12345);
const floors = isLadder ? [1, 3, 8, 13, 18, 23, 28, 33] : [floorArg];

const script = `
import { generateDungeon } from "../src/sim/dungeon.js";
import { placeHazards, hazardBudgetForFloor } from "../src/sim/hazards.js";
import { biomeForFloor } from "../src/sim/biomes.js";
import type { RoomShape } from "../src/sim/dungeon.js";
import type { HazardKind } from "../src/sim/types.js";

const SHAPE_CH: Record<RoomShape, string> = { rect: ".", cell: ".", hall: ".", pillars: ",", arena: "_", cavern: "~", vault: "'", gauntlet: "=" };
const HAZ_CH: Record<HazardKind, string> = { spikes: "^", toxic_pool: "o", fire_vent: "v", void_rift: "@" };

for (const floor of ${JSON.stringify(floors)}) {
  const seed = ${seedArg};
  const d = generateDungeon(seed, floor);
  const hz = placeHazards(d, seed, floor);
  const grid: string[][] = [];
  for (let y = 0; y < d.h; y++) {
    const row: string[] = [];
    for (let x = 0; x < d.w; x++) row.push(d.tiles[y * d.w + x] === 1 ? "#" : " ");
    grid.push(row);
  }
  for (const r of d.rooms) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      if (grid[y][x] === " ") grid[y][x] = SHAPE_CH[r.shape] ?? ".";
    }
  }
  for (const h of hz) grid[h.ty][h.tx] = HAZ_CH[h.kind];
  grid[d.spawn.y][d.spawn.x] = "S";
  grid[d.exit.y][d.exit.x] = "E";
  const b = biomeForFloor(floor);
  console.log("\\n=== floor " + floor + " — " + b.name + " (seed " + seed + ") — " + d.rooms.length + " rooms, " + hz.length + " hazard tiles (budget " + hazardBudgetForFloor(floor) + ") ===");
  console.log("shapes: " + d.rooms.map((r) => r.shape + (r.kind === "hazard" ? "!" : r.kind === "treasure" ? "$" : r.kind === "spawn" ? "+S" : r.kind === "exit" ? "+E" : "")).join(" "));
  console.log(grid.map((row) => row.join("")).join("\\n"));
}
`;

const tmp = new URL("./.mapview.tmp.ts", import.meta.url).pathname;
writeFileSync(tmp, script);
try {
  execSync(`npx tsx ${tmp}`, { stdio: "inherit", cwd: new URL("..", import.meta.url).pathname });
} finally {
  rmSync(tmp, { force: true });
}
