// Effect-wave weapons must destroy cover like every other offensive weapon. Snapwire's
// snap, the Razor Halo's blades, and the Crooked Chain's sweep resolve in the effect
// resolvers (updateWireEffect / updateOrbitEffect / sweepTether), which used to iterate
// ONLY w.enemies and left barrels/crates standing. Umbra (phase) must STILL pass through
// props by design. This suite drives each weapon through the real sim and asserts the
// prop-break outcome.
//
// Run: npm run test:propbreak

import { createWorld, stepWorld, devSpawnProp, devSpawnEnemy, acquireWeaponInWorld } from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { Prop } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";

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

const DT = 1 / 20;
function inputs(aim: number, firing: boolean): Map<PlayerId, InputCmd> {
  return new Map<PlayerId, InputCmd>([[LOCAL_ID, { seq: 0, moveX: 0, moveY: 0, aim, firing, dash: false }]]);
}
function tc(tx: number, ty: number): { x: number; y: number } {
  return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
}
function sandbox(seed: number): WorldState {
  const w = createWorld(seed, 1, { isSandbox: true });
  w.isGodMode = true; // the wielder must survive the whole run
  return w;
}
function place(w: WorldState, x: number, y: number): void {
  const p = w.players.get(LOCAL_ID)!;
  p.x = x; p.y = y;
}
function isBroken(p: Prop): boolean {
  return p.dead || p.breakT !== undefined;
}

// ---- Razor Halo: the orbiting blades exist while the weapon is equipped ----
function haloCase(): void {
  section("Razor Halo: the blade ring shreds cover pressed into it");
  const w = sandbox(0x4A10);
  const c = tc(15, 12);
  place(w, c.x, c.y);
  acquireWeaponInWorld(w, LOCAL_ID, "halo");
  const p = w.players.get(LOCAL_ID)!;
  const barrel = devSpawnProp(w, "barrel", p.x + 46, p.y); // dead on the base blade ring
  let broke = false;
  for (let t = 0; t < 200 && !broke; t++) {
    stepWorld(w, inputs(0, false), DT); // equipped orbit chews it with no firing needed
    if (isBroken(barrel)) broke = true;
  }
  check("halo broke the barrel in its ring", broke);
}

// ---- Snapwire: an enemy trips the armed wire, the snap chews the band ----
function snapwireCase(): void {
  section("Snapwire: the snap destroys a barrel standing in the wire band");
  const w = sandbox(0x5217E);
  const start = tc(10, 12);
  place(w, start.x, start.y);
  acquireWeaponInWorld(w, LOCAL_ID, "snapwire");
  const band = tc(12, 12);
  const barrel = devSpawnProp(w, "barrel", band.x, band.y); // inside the wire span
  // A chaser crossing the wire from above trips it once armed.
  devSpawnEnemy(w, "slime", tc(12, 9).x, tc(12, 9).y);
  let broke = false;
  for (let t = 0; t < 400 && !broke; t++) {
    // Plant on the first tick (aim +x), then let the trap arm and the chaser cross.
    stepWorld(w, inputs(0, t === 0), DT);
    if (isBroken(barrel)) broke = true;
  }
  check("snapwire snap broke the barrel in the band", broke);
}

// ---- Crooked Chain: latch an enemy, then sweep — the sweep smashes nearby cover ----
function crookCase(): void {
  section("Crooked Chain: the sweep smashes cover in its arc");
  const w = sandbox(0xC200C);
  const c = tc(15, 12);
  place(w, c.x, c.y);
  acquireWeaponInWorld(w, LOCAL_ID, "crook");
  const p = w.players.get(LOCAL_ID)!;
  devSpawnEnemy(w, "slime", p.x + 120, p.y); // in tether range with a clear line to latch
  const barrel = devSpawnProp(w, "barrel", p.x + 60, p.y); // inside the sweep reach (105)
  let broke = false;
  for (let t = 0; t < 120 && !broke; t++) {
    stepWorld(w, inputs(0, true), DT); // hold: latch, then sweep on the next unlock
    if (isBroken(barrel)) broke = true;
  }
  check("crook sweep broke the barrel in reach", broke);
}

// ---- Umbra (phase): rounds pass through props — cover must SURVIVE ----
function umbraCase(): void {
  section("Umbra (phase): rounds pass through cover — the barrel must survive (intentional)");
  const w = sandbox(0x0110B4);
  const start = tc(10, 12);
  place(w, start.x, start.y);
  acquireWeaponInWorld(w, LOCAL_ID, "phase");
  const band = tc(12, 12);
  const barrel = devSpawnProp(w, "barrel", band.x, band.y);
  for (let t = 0; t < 120; t++) stepWorld(w, inputs(0, true), DT);
  check("umbra left the barrel intact (phase rounds ignore cover)", !isBroken(barrel));
}

function main(): void {
  haloCase();
  snapwireCase();
  crookCase();
  umbraCase();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("\nEffect-wave weapons break cover (Umbra still phases through it).\n");
}

main();
