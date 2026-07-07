// Golden-master ORACLE capture. Drives the CURRENT (pre-extraction) `Game` headlessly
// with fixed seed + fixed dt + scripted input (seeded sim RNG already in place) and dumps
// the canonical per-tick state stream to test/golden/<scenario>.jsonl. This encodes
// today's exact behavior; the refactored stepWorld must reproduce it tick-for-tick.
//
// Run: npm run golden:capture

import "./harness/domShim.js";
import { domCanvas, domMinimap, domOverlay } from "./harness/domShim.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Game } from "../src/game/game.js";
import { Rng } from "../src/sim/rng.js";
import { createEnemy } from "../src/sim/enemies.js";
import { createAnim } from "../src/game/anim.js";
import { ITEMS, createMods } from "../src/sim/items.js";
import { TILE } from "../src/sim/types.js";
import { Hud } from "../src/game/hud.js";
import { Minimap } from "../src/game/minimap.js";
import { BlessingOverlay } from "../src/ui/blessing.js";
import { audio } from "../src/game/audio.js";
import { SCENARIOS, DT, type Scenario, type FrameInput } from "./scenarios.js";
import { playerView, enemyView, bulletView, pickupView, propView, chestView, type TickSnapshot } from "./snapshot.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const PROP_RADIUS = 15;
const PROP_HP: Record<string, number> = { crate: 4, pot: 1, barrel: 3, barrel_explosive: 3, brazier: 0 };

// Neutralize per-frame DOM + audio so update() runs the pure sim only.
const noop = () => {};
audio.unlock = noop as any;
audio.setMusic = noop as any;
audio.sfx = noop as any;
for (const m of ["update", "setVisible", "showBanner", "tick", "showStats", "hideStats", "clear", "showControlsHint"] as const) {
  (Hud.prototype as any)[m] = noop;
}
(Minimap.prototype as any).render = noop;
(BlessingOverlay.prototype as any).show = noop; // oracle never picks a blessing

function spawnCenter(game: any): { x: number; y: number } {
  const d = game.dungeon;
  return { x: d.spawn.x * TILE + TILE / 2, y: d.spawn.y * TILE + TILE / 2 };
}

function resetScenario(game: any, s: Scenario): void {
  game.isSandbox = false;
  game.start({ mode: "solo", coop: null, profile: null });
  game.seed = s.seed;
  game.floor = s.floor;
  game.rng = new Rng(s.seed ^ 0x53696d21);
  game.kills = 0;
  game.coins = 0;
  game.combo = 0;
  game.comboTimer = 0;
  game.mods = createMods();
  game.ownedItems = [];
  game.maxHp = 6;
  game.hp = 6;
  game.weapon = "pistol";
  game.isDown = false;
  game.isAutoFiring = false;
  game.loadFloor();
}

function applyCommands(game: any, s: Scenario, tick: number): void {
  for (const c of s.commands) {
    if (c.tick !== tick) continue;
    if (c.t === "weapon") {
      game.weapon = c.weapon;
      game.fireCd = 0;
    } else if (c.t === "item") {
      const item = ITEMS.find((it) => it.id === c.itemId);
      if (item) game.applyItem(item);
    } else if (c.t === "spawnEnemy") {
      const p = spawnCenter(game);
      game.enemies.push(createEnemy(c.kind, p.x + c.dx, p.y + c.dy, game.floor, game.rng));
    } else if (c.t === "spawnProp") {
      const p = spawnCenter(game);
      game.props.push({ kind: c.kind, x: p.x + c.dx, y: p.y + c.dy, radius: PROP_RADIUS, hp: PROP_HP[c.kind], dead: false, anim: createAnim() });
    } else if (c.t === "spawnChest") {
      const p = spawnCenter(game);
      game.chests.push({ kind: "wood", x: p.x + c.dx, y: p.y + c.dy, radius: 16, opened: false, anim: createAnim() });
    }
  }
}

function applyInput(game: any, inp: FrameInput): void {
  const keys: Set<string> = game.keys;
  keys.clear();
  if (inp.moveX > 0) keys.add("d");
  else if (inp.moveX < 0) keys.add("a");
  if (inp.moveY > 0) keys.add("s");
  else if (inp.moveY < 0) keys.add("w");
  if (inp.dash) keys.add("shift");
  const cam = game.cam;
  const m = game.mouse;
  // Force the update()-computed aimAngle to exactly inp.aim regardless of the 1-frame cam.
  m.x = game.px - cam.x + Math.cos(inp.aim) * 100;
  m.y = game.py - cam.y + Math.sin(inp.aim) * 100;
  m.isDown = inp.firing;
}

function snapshot(game: any, tick: number): TickSnapshot {
  return {
    tick,
    player: playerView(
      { x: game.px, y: game.py, hp: game.hp, maxHp: game.maxHp, fireCd: game.fireCd, dashCd: game.dashCd, dashTime: game.dashTime, invuln: game.invuln, weapon: game.weapon, kills: game.kills, coins: game.coins, combo: game.combo, comboTimer: game.comboTimer, shotSeq: game.shotSeq, facing: game.facing },
      game.mods
    ),
    enemies: game.enemies.map(enemyView),
    bullets: game.bullets.map(bulletView),
    pickups: game.pickups.map(pickupView),
    props: game.props.map(propView),
    chests: game.chests.map(chestView),
  };
}

export function runOracle(s: Scenario): TickSnapshot[] {
  const game: any = new Game(domCanvas as any, domMinimap as any, domOverlay as any, noop, noop);
  resetScenario(game, s);
  const stream: TickSnapshot[] = [];
  for (let tick = 0; tick < s.ticks; tick++) {
    applyCommands(game, s, tick);
    applyInput(game, s.input(tick));
    game.update(DT);
    stream.push(snapshot(game, tick));
  }
  game.stop();
  return stream;
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, "golden");
  mkdirSync(outDir, { recursive: true });
  for (const s of SCENARIOS) {
    const stream = runOracle(s);
    const lines = stream.map((t) => JSON.stringify(t)).join("\n");
    writeFileSync(join(outDir, `${s.name}.jsonl`), lines + "\n");
    const enemies = stream[stream.length - 1].enemies.length;
    process.stdout.write(`captured ${s.name}: ${stream.length} ticks, final enemies=${enemies}, player.hp=${stream[stream.length - 1].player.hp}\n`);
  }
}

// Only capture when run directly (importing runOracle from a test must not re-capture).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
