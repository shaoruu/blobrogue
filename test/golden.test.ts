// Golden-master test: drive the REFACTORED sim + client (LocalTransport + handleSimEvents)
// headlessly through the same scenarios and assert it reproduces the pre-extraction oracle
// tick-for-tick — both the canonical STATE stream and the emitted-FX (event) stream.
// Also runs a determinism check (same scenario twice -> bit-stable).
//
// Run: npm test

import "./harness/domShim.js";
import { domCanvas, domMinimap, domOverlay } from "./harness/domShim.js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Game } from "../src/game/game.js";
import { LOCAL_ID } from "../src/sim/input.js";
import { devSpawnEnemy, devSpawnProp, devSpawnChest, applyItemToWorld, acquireWeaponInWorld } from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import { ITEMS } from "../src/sim/items.js";
import { TILE } from "../src/sim/types.js";
import { Hud } from "../src/game/hud.js";
import { Minimap } from "../src/game/minimap.js";
import { BlessingOverlay } from "../src/ui/blessing.js";
import { installFxCapture, beginTick, takeTick } from "./harness/fxCapture.js";
import { SCENARIOS, DT, type Scenario, type FrameInput } from "./scenarios.js";
import { playerView, enemyView, bulletView, effectView, pickupView, propView, chestView, diffStreams, type TickSnapshot } from "./snapshot.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const noop = () => {};
installFxCapture();
for (const m of ["update", "setVisible", "showBanner", "tick", "showStats", "hideStats", "clear", "showControlsHint"] as const) {
  (Hud.prototype as any)[m] = noop;
}
(Minimap.prototype as any).render = noop;
(BlessingOverlay.prototype as any).show = noop;

function spawnCenter(w: WorldState): { x: number; y: number } {
  return { x: w.dungeon.spawn.x * TILE + TILE / 2, y: w.dungeon.spawn.y * TILE + TILE / 2 };
}

function reset(game: any, s: Scenario): void {
  game.isSandbox = false;
  game.start({ mode: "solo", coop: null, profile: null });
  // Force the deterministic seed/floor by rebooting the transport's world.
  game.transport.start(s.seed, s.floor, { isSandbox: false, isCoop: false });
  game.world = game.transport.poll().state;
  game.seed = s.seed;
  game.ownedItemDefs = [];
  game.inputSeq = 0;
  game.loadFloorClient();
  game.cam.x = game.px - 1280 / 2;
  game.cam.y = game.py - 720 / 2;
}

function applyCommands(game: any, s: Scenario, tick: number): void {
  const w: WorldState = game.world;
  for (const c of s.commands) {
    if (c.tick !== tick) continue;
    if (c.t === "weapon") {
      acquireWeaponInWorld(w, LOCAL_ID, c.weapon);
    } else if (c.t === "item") {
      const item = ITEMS.find((it) => it.id === c.itemId);
      if (item) applyItemToWorld(w, LOCAL_ID, item);
    } else if (c.t === "spawnEnemy") {
      const p = spawnCenter(w);
      devSpawnEnemy(w, c.kind, p.x + c.dx, p.y + c.dy);
    } else if (c.t === "spawnProp") {
      const p = spawnCenter(w);
      devSpawnProp(w, c.kind, p.x + c.dx, p.y + c.dy);
    } else if (c.t === "spawnChest") {
      const p = spawnCenter(w);
      devSpawnChest(w, p.x + c.dx, p.y + c.dy);
    } else if (c.t === "godmode") {
      w.isGodMode = true;
    }
  }
}

function applyInput(game: any, inp: FrameInput): void {
  const input = game.input; // InputController (private internals reached for the harness)
  const keys: Set<string> = input.keys;
  keys.clear();
  if (inp.moveX > 0) keys.add("d");
  else if (inp.moveX < 0) keys.add("a");
  if (inp.moveY > 0) keys.add("s");
  else if (inp.moveY < 0) keys.add("w");
  if (inp.dash) keys.add("shift");
  const cam = game.cam;
  input.mouseX = game.px - cam.x + Math.cos(inp.aim) * 100;
  input.mouseY = game.py - cam.y + Math.sin(inp.aim) * 100;
  input.isMouseDown = inp.firing;
}

function snapshot(w: WorldState, tick: number): TickSnapshot {
  const p = w.players.get(LOCAL_ID) as unknown as Record<string, unknown>;
  const pl = w.players.get(LOCAL_ID) as PlayerSim;
  return {
    tick,
    player: playerView(p, pl.mods as unknown as Record<string, unknown>),
    enemies: w.enemies.map((e) => enemyView(e as unknown as Record<string, unknown>)),
    bullets: w.bullets.map((b) => bulletView(b as unknown as Record<string, unknown>)),
    effects: w.effects.map((x) => effectView(x as unknown as Record<string, unknown>)),
    pickups: w.pickups.map((x) => pickupView(x as unknown as Record<string, unknown>)),
    props: w.props.map((x) => propView(x as unknown as Record<string, unknown>)),
    chests: w.chests.map((x) => chestView(x as unknown as Record<string, unknown>)),
  };
}

interface Run { state: TickSnapshot[]; fx: string[][] }

function runRefactor(s: Scenario): Run {
  const game: any = new Game(domCanvas as any, domMinimap as any, domOverlay as any, noop, noop);
  reset(game, s);
  const state: TickSnapshot[] = [];
  const fx: string[][] = [];
  for (let tick = 0; tick < s.ticks; tick++) {
    applyCommands(game, s, tick);
    applyInput(game, s.input(tick));
    beginTick();
    game.tick(DT);
    fx.push(takeTick());
    state.push(snapshot(game.world, tick));
  }
  game.stop();
  return { state, fx };
}

function loadGolden(name: string): { state: TickSnapshot[]; fx: string[][] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "golden");
  const state = readFileSync(join(dir, `${name}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as TickSnapshot);
  const fx = readFileSync(join(dir, `${name}.fx.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  return { state, fx };
}

function diffFx(a: string[][], b: string[][]): string | null {
  if (a.length !== b.length) return `fx tick count differs: ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const sa = JSON.stringify(a[i]);
    const sb = JSON.stringify(b[i]);
    if (sa !== sb) {
      const setA = new Set(a[i]);
      const setB = new Set(b[i]);
      const onlyOracle = a[i].filter((x) => !setB.has(x));
      const onlyRefactor = b[i].filter((x) => !setA.has(x));
      return `fx divergence at tick ${i}:\n    only in oracle:   ${JSON.stringify(onlyOracle)}\n    only in refactor: ${JSON.stringify(onlyRefactor)}`;
    }
  }
  return null;
}

export function captureCurrent(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "golden");
  for (const scenario of SCENARIOS) {
    const run = runRefactor(scenario);
    const state = run.state.map((x) => JSON.stringify(x)).join("\n") + "\n";
    const fx = run.fx.map((x) => JSON.stringify(x)).join("\n") + "\n";
    writeFileSync(join(dir, `${scenario.name}.jsonl`), state);
    writeFileSync(join(dir, `${scenario.name}.fx.jsonl`), fx);
    process.stdout.write(`captured current ${scenario.name}: ${run.state.length} ticks\n`);
  }
}

function main(): void {
  let failed = 0;
  for (const s of SCENARIOS) {
    const golden = loadGolden(s.name);
    const run = runRefactor(s);

    const stateDiff = diffStreams(golden.state, run.state);
    const fxDiff = diffFx(golden.fx, run.fx);

    // Determinism: a second run must be byte-identical to the first.
    const run2 = runRefactor(s);
    const detState = diffStreams(run.state, run2.state);
    const detFx = diffFx(run.fx, run2.fx);

    const ok = !stateDiff && !fxDiff && !detState && !detFx;
    if (ok) {
      process.stdout.write(`PASS ${s.name}: ${run.state.length} ticks, state + fx match oracle, deterministic\n`);
    } else {
      failed++;
      process.stdout.write(`FAIL ${s.name}:\n`);
      if (stateDiff) process.stdout.write(`  [state vs oracle] ${stateDiff}\n`);
      if (fxDiff) process.stdout.write(`  [fx vs oracle] ${fxDiff}\n`);
      if (detState) process.stdout.write(`  [state nondeterministic] ${detState}\n`);
      if (detFx) process.stdout.write(`  [fx nondeterministic] ${detFx}\n`);
    }
  }
  if (failed > 0) {
    process.stdout.write(`\n${failed}/${SCENARIOS.length} scenarios FAILED\n`);
    process.exit(1);
  }
  process.stdout.write(`\nAll ${SCENARIOS.length} golden-master scenarios pass (state + events tick-for-tick, deterministic)\n`);
}

if (process.argv.includes("--capture-current")) captureCurrent(); else main();
