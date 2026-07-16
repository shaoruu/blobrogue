// Scene construction for the readability gates: real generated floors rendered at
// production resolution through the exact production tile pass (src/game/tileRender.ts),
// plus hand-authored micro-grids that pin every wall arrangement the autotiler and the
// boundary outline must handle (straight runs, concave/convex corners, 1x1 pillars,
// thin walls, corridor mouths, map-edge tiles).

import { createCanvas } from "@napi-rs/canvas";
import type { Canvas } from "@napi-rs/canvas";
import { generateDungeon } from "../../src/sim/dungeon.js";
import type { Dungeon } from "../../src/sim/dungeon.js";
import { TILE } from "../../src/sim/types.js";
import type { TileKind } from "../../src/sim/types.js";
import { BIOMES, biomeForFloor, biomeIndexForFloor } from "../../src/sim/biomes.js";
import type { Biome } from "../../src/sim/biomes.js";
import { renderDungeonTiles, buildWallSideGradients } from "../../src/game/tileRender.js";
import type { HeadlessTileArt } from "./tileArt.js";

// Production resolution: the common 1080p full-viewport canvas (Game.resize fills the
// window, capped at 2560x1440).
export const VIEW_W = 1920;
export const VIEW_H = 1080;

export interface Scene {
  id: string;
  label: string;
  kind: "generated" | "synthetic";
  dungeon: Dungeon;
  biome: Biome;
  biomeIdx: number;
  camX: number;
  camY: number;
  viewW: number;
  viewH: number;
}

export function generatedScene(seed: number, floor: number): Scene {
  const dungeon = generateDungeon(seed, floor);
  const biome = biomeForFloor(floor);
  const biomeIdx = biomeIndexForFloor(floor);
  const mapW = dungeon.w * TILE;
  const mapH = dungeon.h * TILE;
  const viewW = Math.min(VIEW_W, mapW);
  const viewH = Math.min(VIEW_H, mapH);
  // Deterministic representative viewport: the map center shows the most rooms,
  // corridors and doorways at once.
  const camX = Math.max(0, Math.min(mapW - viewW, Math.round((mapW - viewW) / 2)));
  const camY = Math.max(0, Math.min(mapH - viewH, Math.round((mapH - viewH) / 2)));
  return {
    id: `f${floor}-${biome.tileKey}-s${seed}`,
    label: `${biome.name} — floor ${floor}, seed ${seed}`,
    kind: "generated",
    dungeon, biome, biomeIdx, camX, camY, viewW, viewH,
  };
}

// ---- synthetic arrangement grids ----

function gridDungeon(rows: readonly string[]): Dungeon {
  const h = rows.length;
  const w = rows[0].length;
  const tiles: TileKind[] = new Array(w * h);
  for (let y = 0; y < h; y++) {
    if (rows[y].length !== w) throw new Error(`ragged grid row ${y}`);
    for (let x = 0; x < w; x++) tiles[y * w + x] = rows[y][x] === "#" ? 1 : 0;
  }
  return { w, h, tiles, rooms: [], edges: [], blueprint: null, spawn: { x: 1, y: 1 }, exit: { x: w - 2, y: h - 2 } };
}

// A plain room: straight N/S/E/W boundary runs + the four concave corners.
const GRID_EDGES: readonly string[] = [
  "############",
  "#..........#",
  "#..........#",
  "#..........#",
  "#..........#",
  "#..........#",
  "############",
];

// Pillars, thin walls, stubs, a walled pocket and a 1-wide slot: every exotic autotile
// piece (wf_NESW, wf_EW, wf_NS, three-open stubs) and convex-corner outline case.
const GRID_BLOCKS: readonly string[] = [
  "################",
  "#..............#",
  "#..#...##......#",
  "#.......#......#",
  "#..............#",
  "#..###..#..#...#",
  "#..............#",
  "#....#.#.......#",
  "#....#.#..###..#",
  "#....#.#.......#",
  "#..............#",
  "################",
];

// Two rooms joined through wall columns by a crossing corridor: real doorway mouths
// (pinch cells) plus long interior wall faces.
const GRID_CORRIDORS: readonly string[] = [
  "####################",
  "#.....#......#.....#",
  "#.....#......#.....#",
  "#.....#......#.....#",
  "#..................#",
  "#.....#......#.....#",
  "#.....########.....#",
  "#.....#......#.....#",
  "#.....#......#.....#",
  "####################",
];

const SYNTHETIC_GRIDS: ReadonlyArray<{ name: string; rows: readonly string[] }> = [
  { name: "edges", rows: GRID_EDGES },
  { name: "blocks", rows: GRID_BLOCKS },
  { name: "corridors", rows: GRID_CORRIDORS },
];

export function syntheticScenes(): Scene[] {
  const scenes: Scene[] = [];
  for (const grid of SYNTHETIC_GRIDS) {
    for (let biomeIdx = 0; biomeIdx < BIOMES.length; biomeIdx++) {
      const biome = BIOMES[biomeIdx];
      const dungeon = gridDungeon(grid.rows);
      scenes.push({
        id: `${grid.name}-${biome.tileKey}`,
        label: `${biome.name} — ${grid.name} arrangement`,
        kind: "synthetic",
        dungeon, biome, biomeIdx,
        camX: 0, camY: 0,
        viewW: dungeon.w * TILE, viewH: dungeon.h * TILE,
      });
    }
  }
  return scenes;
}

// Renders exactly what the client's tile pass puts on screen for this scene: biome
// background fill (Game.render), then the extracted production tile pass. animClock is
// pinned to 0 so every ambient pulse term is deterministic.
export function renderScene(scene: Scene, art: HeadlessTileArt): Canvas {
  const canvas = createCanvas(scene.viewW, scene.viewH);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = scene.biome.bgColor;
  ctx.fillRect(0, 0, scene.viewW, scene.viewH);
  renderDungeonTiles(ctx, {
    dungeon: scene.dungeon,
    biome: scene.biome,
    biomeIdx: scene.biomeIdx,
    camX: scene.camX,
    camY: scene.camY,
    viewW: scene.viewW,
    viewH: scene.viewH,
    art,
    wallSide: buildWallSideGradients(ctx, scene.biome),
    animClock: 0,
  });
  return canvas;
}

// Ground truth: per-pixel walkability from the collision grid itself (0 floor, 1 wall).
export function pixelClassMask(scene: Scene): Uint8Array {
  const { dungeon: d } = scene;
  const mask = new Uint8Array(scene.viewW * scene.viewH);
  for (let py = 0; py < scene.viewH; py++) {
    const ty = Math.min(d.h - 1, Math.max(0, Math.floor((py + scene.camY) / TILE)));
    const rowBase = ty * d.w;
    const outBase = py * scene.viewW;
    for (let px = 0; px < scene.viewW; px++) {
      const tx = Math.min(d.w - 1, Math.max(0, Math.floor((px + scene.camX) / TILE)));
      mask[outBase + px] = d.tiles[rowBase + tx] === 1 ? 1 : 0;
    }
  }
  return mask;
}
