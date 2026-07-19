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
import { WAKE_FLOOR, CLAIMANT_FLOOR, UNDERTOW_FLOOR } from "../src/sim/enemies.js";
import { TILE } from "../src/sim/types.js";
import type { FloorHazardKind } from "../src/sim/types.js";
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

// The deep-boss ULTIMATE arenas (Helix TD hunches): load the REAL boss floor, activate the
// encounter, camera-lock on the boss, equip a pet, and force the boss to keep casting so the
// timed window sits mid-ultimate — the actual lit boss room with its telegraph layer
// (river_comes_back / all_things_owed / last_procession), boss aura/earned-window FX, a Wave C
// full-auto gun, and the client pet path all stacked in the same frames the lighting grade runs.
// Solo (the harness has no co-op transport), so it under-counts a true 4p room by the extra
// hero glows + teammate pets — still the closest reproducible boss-room-local worst case.
type EncounterWorld = WorldState & { encounter: { active: boolean } | null };
async function measureBossArena(floor: number): Promise<Stat> {
  const { game } = await bootGame(VIEW_W, VIEW_H);
  game.devStartSandbox();
  loadDeterministicFloor(game, SEED, floor);
  const w = realWorld(game);
  w.isGodMode = true;
  game.devGiveWeapon("faultlink");
  (game as object as { devSetPet(petId: string | null): void }).devSetPet("doggie");
  const enc = (w as EncounterWorld).encounter;
  if (enc) enc.active = true;
  const boss = w.enemies.find((e) => e.boss);
  if (boss) { boss.spawnTimer = 0; boss.attack.cooldown = 0; }
  const focus = boss ? { x: boss.x, y: boss.y } : spawnCenter(w);
  settleAt(game, focus.x, focus.y, VIEW_W, VIEW_H);
  aimAndFire(game, focus.x, focus.y);
  // Never let the boss rest for long, so most frames carry a live telegraph/ultimate.
  const drive = (): void => { if (boss && boss.attack.cooldown > 1.5) boss.attack.cooldown = 0.2; };
  for (let i = 0; i < WARMUP; i++) { drive(); game.tick(1 / 60); game.render(); }
  const times: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    drive();
    const t0 = performance.now();
    game.tick(1 / 60);
    game.render();
    times.push(performance.now() - t0);
  }
  game.stop();
  return stat(times);
}

const BOSS_ARENAS: Record<string, number> = {
  "boss-arena-wake": WAKE_FLOOR,
  "boss-arena-claimant": CLAIMANT_FLOOR,
  "boss-arena-undertow": UNDERTOW_FLOOR,
};

// ODDSMAKER sustained full-auto into a tight cluster — the confirmed playtest FPS killer. The
// legendary gambles ricochet/seeker/blast/pierce each shot; blast rolls chain multi-kills in the
// packed cluster, so the explosion + kill FX bursts (particles/gibs/decals/shockwaves) reach the
// steady-state volume Ian hit. Because it fires only ~2.5/s, the normal 90-frame window would see
// ~4 shots and miss the build-up — so this refills the cluster every few frames AND pre-warms the
// FX pool to steady state before timing, reproducing the sustained-spam load rather than a cold
// opening burst.
async function measureOddsmakerSpam(): Promise<Stat> {
  const { game } = await bootGame(VIEW_W, VIEW_H);
  game.devStartSandbox();
  loadDeterministicFloor(game, SEED, FLOOR);
  const w = realWorld(game);
  w.isGodMode = true;
  const c = spawnCenter(w);
  settleAt(game, c.x, c.y, VIEW_W, VIEW_H);
  game.devGiveWeapon("oddsmaker");
  const kinds = ["slime", "bat", "skeleton", "spitter"] as const;
  const refill = (): void => {
    let alive = 0;
    for (const e of w.enemies) if (!e.dead) alive++;
    for (let i = alive; i < 40; i++) {
      devSpawnEnemy(w, kinds[i % kinds.length], c.x + 150 + (i % 8) * 26, c.y - 90 + Math.floor(i / 8) * 28);
    }
  };
  refill();
  aimAndFire(game, c.x + 260, c.y);
  for (let i = 0; i < WARMUP + 60; i++) { if (i % 4 === 0) refill(); game.tick(1 / 60); game.render(); }
  const times: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    if (i % 4 === 0) refill();
    const t0 = performance.now();
    game.tick(1 / 60);
    game.render();
    times.push(performance.now() - t0);
  }
  game.stop();
  return stat(times);
}

async function measureHaloDensePack(): Promise<Stat> {
  const { game } = await bootGame(VIEW_W, VIEW_H);
  game.devStartSandbox();
  loadDeterministicFloor(game, SEED, FLOOR);
  const w = realWorld(game);
  w.isGodMode = true;
  const c = spawnCenter(w);
  settleAt(game, c.x, c.y, VIEW_W, VIEW_H);
  game.devGiveWeapon("halo");
  const packStart = w.enemies.length;
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const enemy = devSpawnEnemy(w, "slime", c.x + Math.cos(a) * 48, c.y + Math.sin(a) * 48);
    enemy.hp = 1_000_000;
    enemy.maxHp = 1_000_000;
  }
  const parkPack = (): void => {
    for (let i = 0; i < 20; i++) {
      const enemy = w.enemies[packStart + i];
      const a = (i / 20) * Math.PI * 2;
      enemy.x = c.x + Math.cos(a) * 48;
      enemy.y = c.y + Math.sin(a) * 48;
      enemy.vx = 0;
      enemy.vy = 0;
    }
  };
  for (let i = 0; i < WARMUP + 60; i++) {
    parkPack();
    game.tick(1 / 60);
    game.render();
  }
  const times: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    parkPack();
    const t0 = performance.now();
    game.tick(1 / 60);
    game.render();
    times.push(performance.now() - t0);
  }
  game.stop();
  return stat(times);
}

async function measureClaymoreCleave(): Promise<Stat> {
  const { game } = await bootGame(VIEW_W, VIEW_H);
  game.devStartSandbox();
  loadDeterministicFloor(game, SEED, FLOOR);
  const w = realWorld(game);
  w.isGodMode = true;
  const c = spawnCenter(w);
  settleAt(game, c.x, c.y, VIEW_W, VIEW_H);
  game.devGiveWeapon("longsword");
  game.devSetCombo(20);
  const kinds = ["slime", "bat", "skeleton", "spitter"] as const;
  const refill = (): void => {
    let nearby = 0;
    for (const e of w.enemies) {
      if (!e.dead && Math.hypot(e.x - c.x, e.y - c.y) < 120) nearby++;
    }
    for (let i = nearby; i < 36; i++) {
      devSpawnEnemy(w, kinds[i % kinds.length], c.x + 38 + (i % 6) * 11, c.y - 45 + Math.floor(i / 6) * 18);
    }
  };
  refill();
  aimAndFire(game, c.x + 180, c.y);
  for (let i = 0; i < WARMUP + 60; i++) {
    if (i % 4 === 0) refill();
    game.tick(1 / 60);
    game.render();
  }
  const times: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    if (i % 4 === 0) refill();
    const t0 = performance.now();
    game.tick(1 / 60);
    game.render();
    times.push(performance.now() - t0);
  }
  game.stop();
  return stat(times);
}

async function measureArenaUltParty(): Promise<Stat> {
  const { game } = await bootGame(VIEW_W, VIEW_H);
  game.devStartSandbox();
  loadDeterministicFloor(game, SEED, FLOOR);
  const w = realWorld(game);
  w.isGodMode = true;
  const c = spawnCenter(w);
  settleAt(game, c.x, c.y, VIEW_W, VIEW_H);
  const events: SimEvent[] = [
    { t: "ultArena", pid: "arena-gunner", kind: "salvo", x: c.x - 70, y: c.y, aim: 0, tellTicks: 8 },
    { t: "ultArena", pid: "arena-mender", kind: "triage", x: c.x, y: c.y - 55, aim: Math.PI / 2, tellTicks: 8 },
    { t: "ultArena", pid: "arena-bulwark", kind: "shove", x: c.x + 70, y: c.y, aim: Math.PI, tellTicks: 8 },
    { t: "ultArena", pid: "arena-phantom", kind: "slip", x: c.x, y: c.y + 55, aim: -Math.PI / 2, tellTicks: 8 },
  ];
  const replay = (): void => {
    (game as object as { handleSimEvents(events: SimEvent[]): void }).handleSimEvents(events);
  };
  replay();
  for (let i = 0; i < WARMUP + 60; i++) {
    if (i > 0 && i % 45 === 0) replay();
    game.tick(1 / 60);
    game.render();
  }
  const times: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    if (i % 45 === 0) replay();
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
  // A deep-floor GIANT set-piece (F50 Gorge: shell body + boss aura + phase-3 core glow +
  // seam weak-points) fought over a DENSE floor-hazard field (spikes/pools/vents/rifts —
  // vents and rifts also push per-frame occlusion-shaped lights), with a Wave C full-auto
  // gun raining luminous bullets and a companion pet trotting along. This is the shape of
  // the Anson playtest the shallow scenarios above never exercised: deep boss VFX + a
  // hazard telegraph field + full-auto FX + the client pet render path, all at once.
  "deep-giant-hazard-field": (game) => {
    game.devGiveWeapon("faultlink"); // a Wave C full-auto gun (dense luminous projectiles)
    const w = realWorld(game);
    const c = spawnCenter(w);
    devSpawnEnemy(w, "gorge", c.x + 260, c.y);
    for (let i = 0; i < 18; i++) {
      devSpawnEnemy(w, i % 2 === 0 ? "slime" : "skeleton", c.x + 120 + (i % 6) * 34, c.y - 90 + Math.floor(i / 6) * 36);
    }
    const kinds: FloorHazardKind[] = ["spikes", "toxic_pool", "fire_vent", "void_rift"];
    const stx = w.dungeon.spawn.x, sty = w.dungeon.spawn.y;
    let id = 1;
    for (let gx = -5; gx <= 5; gx++) {
      for (let gy = -3; gy <= 3; gy++) {
        w.floorHazards.push({ id: id++, kind: kinds[(gx + gy + 20) % 4], tx: stx + gx, ty: sty + gy, phase: (gx + gy) * 0.2, group: 0 });
      }
    }
    (game as object as { devSetPet(petId: string | null): void }).devSetPet("doggie");
    aimAndFire(game, c.x + 300, c.y);
  },
  // A dense-telegraph swarm: a ring of 40 bodies packed at melee range around the player —
  // so many are simultaneously in a windup/attack telegraph (tier rings, danger discs, aura
  // lines, elemental status overlays) — plus a second GIANT (F75 Pale) casting its own
  // telegraphs, under a held beam. The worst-case for the per-enemy overlay + telegraph
  // render path the density controller is meant to keep readable.
  "dense-telegraph-swarm": (game) => {
    game.devGiveWeapon("beam");
    const w = realWorld(game);
    const c = spawnCenter(w);
    devSpawnEnemy(w, "pale", c.x, c.y - 220);
    const kinds = ["skeleton", "spitter", "charger", "bat"] as const;
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2, r = 70 + (i % 4) * 26;
      devSpawnEnemy(w, kinds[i % kinds.length], c.x + Math.cos(a) * r, c.y + Math.sin(a) * r);
    }
    aimAndFire(game, c.x, c.y - 220);
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
  for (const [name, floor] of Object.entries(BOSS_ARENAS)) {
    const s = await measureBossArena(floor);
    scenarios[name] = s;
    process.stdout.write(`    ${name} (F${floor}): median ${s.median.toFixed(2)}ms, p95 ${s.p95.toFixed(2)}ms\n`);
  }
  {
    const s = await measureOddsmakerSpam();
    scenarios["oddsmaker-full-auto"] = s;
    process.stdout.write(`    oddsmaker-full-auto: median ${s.median.toFixed(2)}ms, p95 ${s.p95.toFixed(2)}ms\n`);
  }
  {
    const s = await measureHaloDensePack();
    scenarios["halo-dense-pack"] = s;
    process.stdout.write(`    halo-dense-pack: median ${s.median.toFixed(2)}ms, p95 ${s.p95.toFixed(2)}ms\n`);
  }
  {
    const s = await measureClaymoreCleave();
    scenarios["claymore-cleave"] = s;
    process.stdout.write(`    claymore-cleave: median ${s.median.toFixed(2)}ms, p95 ${s.p95.toFixed(2)}ms\n`);
  }
  {
    const s = await measureArenaUltParty();
    scenarios["arena-ult-party"] = s;
    process.stdout.write(`    arena-ult-party: median ${s.median.toFixed(2)}ms, p95 ${s.p95.toFixed(2)}ms\n`);
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
  for (const name of Object.keys(scenarios)) {
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
