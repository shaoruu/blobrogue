// Headless PR/docs screenshots of the AO + lighting layer: boots the REAL renderer
// (node-canvas, real art) over real generated floors and captures the mandated bands
// (Amberwild / Deep / Emberreach / Null), before/after pairs, a fire-vent eruption and
// a projectile-light combat beat.
//
// Not part of any test gate. Run: npm run screens:lighting [outDir]

import { bootGame, loadDeterministicFloor, settleAt, privates, ROOT } from "../test/harness/raster.js";
import type { HarnessGame, Canvas } from "../test/harness/raster.js";
import { TILE } from "../src/sim/types.js";
import { floorHazardPhaseAt } from "../src/sim/hazards.js";
import type { FloorHazard } from "../src/sim/types.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SEED = 0x11c817;
const VIEW_W = 1280;
const VIEW_H = 720;
const OUT = process.argv[2] ?? join(ROOT, "artifacts", "screenshots", "lighting");

function save(name: string, canvas: Canvas): void {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, canvas.toBuffer("image/png"));
  process.stdout.write(`wrote ${file}\n`);
}

function isFloorTile(d: { w: number; h: number; tiles: number[] }, tx: number, ty: number): boolean {
  return tx >= 0 && ty >= 0 && tx < d.w && ty < d.h && d.tiles[ty * d.w + tx] === 0;
}

// A torch with an open floor apron, preferring one with a second torch on screen.
function findStand(game: HarnessGame): { x: number; y: number } {
  const p = privates(game);
  const d = game.devWorld().dungeon;
  let best: { x: number; y: number } | null = null;
  let bestScore = -1;
  for (const t of p.torches) {
    let isOpen = true;
    for (let oy = 1; oy <= 3 && isOpen; oy++) {
      for (let ox = -1; ox <= 1 && isOpen; ox++) {
        if (!isFloorTile(d, t.tx + ox, t.ty + oy)) isOpen = false;
      }
    }
    if (!isOpen) continue;
    const near = p.torches.filter((o) => Math.abs((o.tx - t.tx) * TILE) < VIEW_W / 2 - 80 && Math.abs((o.ty - t.ty) * TILE) < VIEW_H / 2 - 80).length;
    if (near > bestScore) {
      bestScore = near;
      best = { x: (t.tx + 0.5) * TILE, y: (t.ty + 3.2) * TILE };
    }
  }
  if (best) return best;
  const spawn = game.devWorld().dungeon.spawn;
  return { x: (spawn.x + 0.5) * TILE, y: (spawn.y + 0.5) * TILE };
}

async function main(): Promise<void> {
  const { game, canvas } = await bootGame(VIEW_W, VIEW_H);
  game.devStartSandbox();

  const bands: { name: string; floor: number; isPair: boolean }[] = [
    { name: "amberwild-f3", floor: 3, isPair: true },
    { name: "sunless-f13", floor: 13, isPair: false },
    { name: "deep-f18", floor: 18, isPair: true },
    { name: "gilded-f23", floor: 23, isPair: false },
    { name: "ember-f28", floor: 28, isPair: false },
    { name: "null-f33", floor: 33, isPair: true },
  ];
  for (const band of bands) {
    loadDeterministicFloor(game, SEED, band.floor);
    const stand = findStand(game);
    settleAt(game, stand.x, stand.y, VIEW_W, VIEW_H);
    game.render();
    save(band.name, canvas);
    if (band.isPair) {
      game.devToggleLighting();
      game.render();
      save(`${band.name}-lighting-off`, canvas);
      game.devToggleLighting();
    }
  }

  // Fire-vent eruption on an Emberreach floor: light IS the pressure tell.
  {
    loadDeterministicFloor(game, SEED, 28);
    const w = game.devWorld();
    const vent = w.floorHazards.find((h) => h.kind === "fire_vent");
    if (vent) {
      const ventX = (vent.tx + 0.5) * TILE;
      const ventY = (vent.ty + 0.5) * TILE;
      settleAt(game, ventX - 150, ventY, VIEW_W, VIEW_H, 10);
      const hazard = vent as object as FloorHazard;
      for (let i = 0; i < 60 * 8; i++) {
        if (floorHazardPhaseAt(hazard, w.floorHazardClock) === "active") break;
        game.tick(1 / 60);
      }
      for (let i = 0; i < 8; i++) game.tick(1 / 60);
      const p = privates(game);
      p.cam.x = ventX - VIEW_W / 2 + 60;
      p.cam.y = ventY - VIEW_H / 2;
      game.render();
      save("ember-vent-eruption", canvas);
    }
  }

  // Projectile light: the Sunlance's line of light through a dark Deep corridor.
  {
    loadDeterministicFloor(game, SEED, 18);
    const stand = findStand(game);
    settleAt(game, stand.x, stand.y, VIEW_W, VIEW_H);
    const input = privates(game).input;
    game.devGiveWeapon("beam");
    input.mouseX = VIEW_W / 2 + 300;
    input.mouseY = VIEW_H / 2 - 40;
    input.isMouseDown = true;
    for (let i = 0; i < 14; i++) game.tick(1 / 60);
    input.isMouseDown = false;
    game.render();
    save("deep-sunlance-light", canvas);
  }

  game.stop();
  process.stdout.write("lighting screenshots complete\n");
}

main().catch((err: Error) => {
  process.stdout.write(`lightingScreens crashed: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
