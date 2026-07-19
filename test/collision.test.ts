import { LOCAL_ID } from "../src/sim/input.js";
import { TILE } from "../src/sim/types.js";
import { createWorld, devSpawnEnemy, moveCircle } from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, isPassing: boolean, detail = ""): void {
  if (isPassing) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? ` — ${detail}` : ""}\n`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
  }
}

function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function collisionWorld(): WorldState {
  const world = createWorld(0xc0111510, 1, { isSandbox: true });
  world.enemies = [];
  world.props = [];
  for (let ty = 0; ty < world.dungeon.h; ty++) {
    for (let tx = 0; tx < world.dungeon.w; tx++) {
      const isBorder = tx === 0 || ty === 0 || tx === world.dungeon.w - 1 || ty === world.dungeon.h - 1;
      world.dungeon.tiles[ty * world.dungeon.w + tx] = isBorder ? 1 : 0;
    }
  }
  world.dungeon.tiles[3 * world.dungeon.w + 4] = 1;
  return world;
}

const wallLeft = 4 * TILE;
const wallRight = 5 * TILE;
const wallTop = 3 * TILE;
const wallBottom = 4 * TILE;
const wallCenterX = 4.5 * TILE;
const wallCenterY = 3.5 * TILE;

section("Embedded bodies eject instead of clipping through");
{
  const world = collisionWorld();
  const player = world.players.get(LOCAL_ID);
  if (player === undefined) throw new Error("Local player missing");
  player.x = wallLeft - player.pr + 6;
  player.y = wallCenterY;
  [player.x, player.y] = moveCircle(world, player.x, player.y, player.pr, 40, 0);
  check(
    "partially embedded player returns to the near face",
    player.x === wallLeft - player.pr && player.y === wallCenterY,
    `position=(${player.x}, ${player.y})`,
  );
}
{
  const world = collisionWorld();
  const enemy = devSpawnEnemy(world, "slime", wallRight, wallCenterY);
  enemy.x = wallRight + enemy.radius - 5;
  [enemy.x, enemy.y] = moveCircle(world, enemy.x, enemy.y, enemy.radius, -40, 0);
  check(
    "partially embedded enemy returns to the near face",
    enemy.x === wallRight + enemy.radius && enemy.y === wallCenterY,
    `position=(${enemy.x}, ${enemy.y})`,
  );
}
{
  const world = collisionWorld();
  const player = world.players.get(LOCAL_ID);
  if (player === undefined) throw new Error("Local player missing");
  player.x = wallCenterX;
  player.y = wallTop - player.pr + 6;
  [player.x, player.y] = moveCircle(world, player.x, player.y, player.pr, 0, 40);
  check(
    "partially embedded player ejects upward",
    player.x === wallCenterX && player.y === wallTop - player.pr,
    `position=(${player.x}, ${player.y})`,
  );
}
{
  const world = collisionWorld();
  const enemy = devSpawnEnemy(world, "slime", wallCenterX, wallBottom);
  enemy.y = wallBottom + enemy.radius - 5;
  [enemy.x, enemy.y] = moveCircle(world, enemy.x, enemy.y, enemy.radius, 0, -40);
  check(
    "partially embedded enemy ejects downward",
    enemy.x === wallCenterX && enemy.y === wallBottom + enemy.radius,
    `position=(${enemy.x}, ${enemy.y})`,
  );
}

section("Full body wall sampling");
{
  const world = collisionWorld();
  const player = world.players.get(LOCAL_ID);
  if (player === undefined) throw new Error("Local player missing");
  player.x = wallLeft - player.pr - 20;
  player.y = wallTop - player.pr + 6;
  [player.x, player.y] = moveCircle(world, player.x, player.y, player.pr, 30, 0);
  check(
    "perpendicular body overlap clamps entry when the center probe is clear",
    player.x === wallLeft - player.pr,
    `x=${player.x}`,
  );
}

section("Swept wall collision");
{
  const world = collisionWorld();
  const player = world.players.get(LOCAL_ID);
  if (player === undefined) throw new Error("Local player missing");
  player.x = wallLeft - player.pr - 20;
  player.y = wallCenterY;
  [player.x, player.y] = moveCircle(world, player.x, player.y, player.pr, 180, 0);
  check(
    "large knockback clamps at the first wall face",
    player.x === wallLeft - player.pr && player.y === wallCenterY,
    `position=(${player.x}, ${player.y})`,
  );
}

section("Axis-separated wall sliding");
{
  const world = collisionWorld();
  const player = world.players.get(LOCAL_ID);
  if (player === undefined) throw new Error("Local player missing");
  player.x = wallLeft - player.pr;
  player.y = wallCenterY;
  const startY = player.y;
  [player.x, player.y] = moveCircle(world, player.x, player.y, player.pr, 12, 10);
  check(
    "normal movement is blocked into the wall",
    player.x === wallLeft - player.pr,
    `x=${player.x}`,
  );
  check(
    "tangential movement continues along the wall",
    player.y === startY + 10,
    `y=${player.y}`,
  );
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
