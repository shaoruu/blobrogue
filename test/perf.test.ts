// Standing performance gate. Times the REAL client tick()+render() over N frames for the
// worst-case combat scenarios that used to spike the frame (a thumper into an explosive-
// barrel cluster, a max swarm, full-auto beam/flamer, a boss with its FX), plus a sim-only
// stepWorldPhase gate at LIVE_CAPS.bodies. Results are asserted against a committed baseline
// (test/fixtures/perf_baseline.json), scaled by a per-run hardware calibration so the gate
// catches real regressions without flaking across machines.
//
// Regenerate the baseline (after an intended perf change): npm run perf:baseline
// Run the gate: npm run test:perf

import "./harness/domShim.js";
import { bootGame, loadDeterministicFloor, privates, settleAt, type HarnessGame } from "./harness/raster.js";
import { createWorld, stepWorldPhase, devSpawnEnemy, devSpawnProp } from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import { LIVE_CAPS } from "../src/sim/balance.js";
import { TILE } from "../src/sim/types.js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, "fixtures", "perf_baseline.json");
const VIEW_W = 1280, VIEW_H = 720;
const SEED = 0x9E4F, FLOOR = 1;
const WARMUP = 20, FRAMES = 90;
// The gate flags a scenario whose calibrated cost exceeds the committed baseline by this
// factor — generous enough to absorb machine + measurement noise, tight enough to catch a
// real regression (a doubling always trips it).
const TOLERANCE = 2.2;

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

interface Stat { median: number; p95: number; }
interface Baseline { note: string; calib: number; sim: Stat; scenarios: Record<string, Stat>; }

function stat(times: number[]): Stat {
  const s = times.slice().sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)] };
}

// A fixed synthetic workload timed once per run: its cost is a proxy for this machine's
// speed, so the committed baseline (measured elsewhere) can be scaled to local hardware.
function calibrate(): number {
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < 6_000_000; i++) acc += Math.sqrt(i * 1.0001 + 1);
  const dt = performance.now() - t0;
  if (acc < 0) throw new Error("unreachable"); // keep the loop from being optimized away
  return dt;
}

function realWorld(game: HarnessGame): WorldState {
  return (game as object as { devWorld(): WorldState }).devWorld();
}

function spawnCenter(w: WorldState): { x: number; y: number } {
  return { x: (w.dungeon.spawn.x + 0.5) * TILE, y: (w.dungeon.spawn.y + 0.5) * TILE };
}

// Point the player's aim (mouse) at a world spot and hold fire.
function aimAndFire(game: HarnessGame, wx: number, wy: number): void {
  const p = privates(game);
  p.input.mouseX = wx - p.cam.x;
  p.input.mouseY = wy - p.cam.y;
  p.input.isMouseDown = true;
}

type Setup = (game: HarnessGame) => void;

async function measureScenario(setup: Setup): Promise<Stat> {
  const { game } = await bootGame(VIEW_W, VIEW_H);
  game.devStartSandbox();
  loadDeterministicFloor(game, SEED, FLOOR);
  const w = realWorld(game);
  w.isGodMode = true; // the timed player must survive the whole run
  const c = spawnCenter(w);
  settleAt(game, c.x, c.y, VIEW_W, VIEW_H);
  setup(game);
  for (let i = 0; i < WARMUP; i++) { game.tick(1 / 60); game.render(); }
  const times: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const t0 = performance.now();
    game.tick(1 / 60);
    game.render();
    times.push(performance.now() - t0);
  }
  game.stop();
  return stat(times);
}

// Worst-case scenarios. Each builds a heavy live world around the settled player.
const SCENARIOS: Record<string, Setup> = {
  "thumper-into-barrels": (game) => {
    game.devGiveWeapon("mortar"); // the Thumper
    const w = realWorld(game);
    const c = spawnCenter(w);
    // A tight explosive-barrel cluster a lob away, packed among bodies — the chain + kill
    // burst this fix bounds. Placed directly (deterministic cluster, not the random dev spot).
    for (let gx = 0; gx < 5; gx++) {
      for (let gy = 0; gy < 4; gy++) {
        devSpawnProp(w, "barrel_explosive", c.x + 220 + gx * 34, c.y - 60 + gy * 34);
      }
    }
    for (let i = 0; i < 24; i++) devSpawnEnemy(w, i % 2 === 0 ? "slime" : "bat", c.x + 200 + (i % 6) * 30, c.y - 40 + Math.floor(i / 6) * 30);
    aimAndFire(game, c.x + 280, c.y);
  },
  "swarm-max-enemies": (game) => {
    game.devGiveWeapon("smg");
    const w = realWorld(game);
    const c = spawnCenter(w);
    const kinds = ["slime", "bat", "skeleton", "spitter"] as const;
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2, r = 120 + (i % 5) * 40;
      devSpawnEnemy(w, kinds[i % kinds.length], c.x + Math.cos(a) * r, c.y + Math.sin(a) * r);
    }
    aimAndFire(game, c.x + 200, c.y);
  },
  "full-auto-beam": (game) => {
    game.devGiveWeapon("beam"); // the Sunlance
    const w = realWorld(game);
    const c = spawnCenter(w);
    for (let i = 0; i < 40; i++) devSpawnEnemy(w, i % 2 === 0 ? "slime" : "skeleton", c.x + 120 + (i % 8) * 26, c.y - 90 + Math.floor(i / 8) * 30);
    aimAndFire(game, c.x + 300, c.y);
  },
  "full-auto-flamer": (game) => {
    game.devGiveWeapon("flamer");
    const w = realWorld(game);
    const c = spawnCenter(w);
    for (let i = 0; i < 40; i++) devSpawnEnemy(w, i % 2 === 0 ? "slime" : "bat", c.x + 100 + (i % 8) * 26, c.y - 90 + Math.floor(i / 8) * 30);
    aimAndFire(game, c.x + 260, c.y);
  },
  "boss-plus-fx": (game) => {
    game.devGiveWeapon("smg");
    const w = realWorld(game);
    const c = spawnCenter(w);
    devSpawnEnemy(w, "boss", c.x + 240, c.y);
    for (let i = 0; i < 16; i++) devSpawnEnemy(w, "slime", c.x + 160 + (i % 8) * 24, c.y - 60 + Math.floor(i / 8) * 30);
    aimAndFire(game, c.x + 240, c.y);
  },
};

// Sim-only world-systems gate: stepWorldPhase alone (no render, no player phase) at the live
// body cap, the authoritative per-tick budget the server actually runs.
function measureSimOnly(): Stat {
  const w = createWorld(0x50FACE, 1, { isSandbox: true });
  const c = spawnCenter(w);
  const kinds = ["slime", "bat", "skeleton", "spitter"] as const;
  for (let i = 0; i < LIVE_CAPS.bodies; i++) {
    const a = (i / LIVE_CAPS.bodies) * Math.PI * 2, r = 120 + (i % 4) * 36;
    devSpawnEnemy(w, kinds[i % kinds.length], c.x + Math.cos(a) * r, c.y + Math.sin(a) * r);
  }
  const ev: SimEvent[] = [];
  for (let i = 0; i < 60; i++) { ev.length = 0; stepWorldPhase(w, 1 / 20, ev); }
  const times: number[] = [];
  for (let i = 0; i < 400; i++) {
    ev.length = 0;
    const t0 = performance.now();
    stepWorldPhase(w, 1 / 20, ev);
    times.push(performance.now() - t0);
  }
  return stat(times);
}

async function main(): Promise<void> {
  const isWrite = process.argv.includes("--write-baseline");
  const calib = calibrate();

  section("sim-only stepWorldPhase gate (LIVE_CAPS.bodies)");
  const sim = measureSimOnly();
  process.stdout.write(`    ${LIVE_CAPS.bodies} bodies: median ${sim.median.toFixed(3)}ms, p95 ${sim.p95.toFixed(3)}ms (50ms budget @20Hz)\n`);

  section("client tick()+render() worst-case scenarios");
  const scenarios: Record<string, Stat> = {};
  for (const [name, setup] of Object.entries(SCENARIOS)) {
    const s = await measureScenario(setup);
    scenarios[name] = s;
    process.stdout.write(`    ${name}: median ${s.median.toFixed(2)}ms, p95 ${s.p95.toFixed(2)}ms\n`);
  }

  if (isWrite) {
    const baseline: Baseline = {
      note: "Perf baseline for test/perf.test.ts. tick()+render() (client scenarios) and stepWorldPhase (sim) frame times in ms. `calib` normalizes for hardware. Regenerate: npm run perf:baseline",
      calib, sim, scenarios,
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
    process.stdout.write(`\nWrote baseline (calib ${calib.toFixed(1)}ms) to ${BASELINE_PATH}\n`);
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  // Scale the committed thresholds to THIS machine: a slower box (bigger calib) gets a
  // proportionally larger budget, so the gate measures regressions, not hardware. The
  // absolute floor keeps a sub-millisecond baseline (the sim gate) from flaking on noise.
  const scale = Math.max(1, calib / baseline.calib);
  const limit = (base: number, floorMs: number): number => Math.max(base * scale * TOLERANCE, floorMs);
  const SIM_FLOOR = 3; // ms — well under the 50ms @20Hz budget; absorbs GC/first-build noise

  section("gate: calibrated frame times vs committed baseline");
  process.stdout.write(`    calib ${calib.toFixed(1)}ms vs baseline ${baseline.calib.toFixed(1)}ms -> scale ${scale.toFixed(2)}, tolerance ${TOLERANCE}x\n`);
  check("sim stepWorldPhase median within budget", sim.median <= limit(baseline.sim.median, SIM_FLOOR),
    `${sim.median.toFixed(3)} <= ${limit(baseline.sim.median, SIM_FLOOR).toFixed(3)}`);
  check("sim stepWorldPhase p95 within budget", sim.p95 <= limit(baseline.sim.p95, SIM_FLOOR),
    `${sim.p95.toFixed(3)} <= ${limit(baseline.sim.p95, SIM_FLOOR).toFixed(3)}`);
  for (const name of Object.keys(SCENARIOS)) {
    const base = baseline.scenarios[name];
    const cur = scenarios[name];
    if (!base) { check(`${name} has a committed baseline`, false); continue; }
    check(`${name} median within budget`, cur.median <= limit(base.median, 0),
      `${cur.median.toFixed(2)} <= ${limit(base.median, 0).toFixed(2)}`);
    check(`${name} p95 within budget`, cur.p95 <= limit(base.p95, 0),
      `${cur.p95.toFixed(2)} <= ${limit(base.p95, 0).toFixed(2)}`);
  }

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nPerformance gate holds (worst-case tick+render + sim-only budget).\n");
}

void main();
