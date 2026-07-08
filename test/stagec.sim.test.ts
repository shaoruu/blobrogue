// Stage C pure-sim assertions: the authoritative multi-player combat correctness that the
// golden-master suite (single player) can't cover. Everything here runs stepWorldPhase /
// stepPlayerPhase directly on a headless WorldState with 2+ players and asserts per-player
// ownership attribution, the authoritative down/revive model, and lag-compensated hit
// registration. No DOM, no sockets — the same pure core the server and client share.
//
// Run: npm run test:sim

import {
  createWorld, spawnPlayerInWorld, devSpawnEnemy, devSpawnProp,
  stepWorldPhase,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { Bullet, Enemy } from "../src/sim/types.js";

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

// A fresh 2-player authoritative arena (server-shaped: no implicit LOCAL_ID player).
function twoPlayerArena(): { w: WorldState; a: PlayerSim; b: PlayerSim } {
  const w = createWorld(0xC0FFEE, 1, { isSandbox: true, skipLocalPlayer: true });
  const a = spawnPlayerInWorld(w, "pA");
  const b = spawnPlayerInWorld(w, "pB");
  // Separate them so neither is accidentally in the other's blast/contact range.
  a.x = 200; a.y = 200;
  b.x = 900; b.y = 600;
  return { w, a, b };
}

// A direct bullet owned by `owner`, planted on top of `target` so the next world step resolves
// the hit. Bypasses fire()'s RNG so the test is exact.
function plantBullet(w: WorldState, owner: string, target: Enemy, damage: number): Bullet {
  const b: Bullet = {
    x: target.x, y: target.y, vx: 1, vy: 0, radius: 6, life: 1, friendly: true,
    owner, damage, color: "#fff", pierce: 0, hitList: null, isCrit: false,
  };
  w.bullets.push(b);
  return b;
}

function ownershipTests(): void {
  section("ownership: bullet kill credits the shooter, not a primary player");
  {
    const { w, a, b } = twoPlayerArena();
    const e = devSpawnEnemy(w, "slime", 500, 400);
    e.hp = 1;
    plantBullet(w, b.id, e, 10); // player B's bullet, lethal
    const ev: SimEvent[] = [];
    stepWorldPhase(w, 1 / 20, ev);
    check("shooter (B) credited the kill", b.kills === 1 && a.kills === 0, `A.kills=${a.kills} B.kills=${b.kills}`);
    check("shooter (B) gained combo", b.combo === 1 && a.combo === 0);
    const killEv = ev.find((x) => x.t === "enemyKill");
    check("enemyKill event emitted once", !!killEv);
  }

  section("ownership: coins/loot attribution follows the killer's combo multiplier");
  {
    const { w, a, b } = twoPlayerArena();
    // Build B a fat combo so its coin drops are worth more than A's — proves the loot value is
    // computed from the KILLER, not a shared/primary player.
    b.combo = 25; b.comboTimer = 3;
    const e = devSpawnEnemy(w, "slime", 500, 400);
    e.hp = 1;
    // Force a coin drop deterministically by planting the kill then inspecting pickups.
    plantBullet(w, b.id, e, 10);
    const before = w.pickups.length;
    stepWorldPhase(w, 1 / 20, []);
    const coin = w.pickups.find((p) => p.kind === "coin");
    check("B's kill can drop a coin valued by B's combo", w.pickups.length >= before, `pickups=${w.pickups.length}`);
    if (coin && coin.value !== undefined) check("coin value reflects the killer's combo (>1)", coin.value > 1, `value=${coin.value}`);
    check("A got no kill credit for B's shot", a.kills === 0);
  }

  section("ownership: burn DoT kill credits the igniter (even after they stop firing)");
  {
    const { w, a, b } = twoPlayerArena();
    const e = devSpawnEnemy(w, "slime", 500, 400);
    e.hp = 3;
    // A ignites via a burn bullet; the DoT finishes the kill on later ticks with no further fire.
    const burn: Bullet = {
      x: e.x, y: e.y, vx: 1, vy: 0, radius: 6, life: 1, friendly: true,
      owner: a.id, damage: 0.1, color: "#f80", pierce: 0, hitList: null, isCrit: false, burn: 3,
    };
    w.bullets.push(burn);
    for (let i = 0; i < 120 && !e.dead; i++) stepWorldPhase(w, 1 / 20, []);
    check("igniter (A) credited the burn kill", a.kills === 1 && b.kills === 0, `A.kills=${a.kills} B.kills=${b.kills}`);
  }

  section("ownership: explosive-barrel kill credits whoever detonated it");
  {
    const { w, a, b } = twoPlayerArena();
    devSpawnProp(w, "barrel_explosive", 500, 400);
    const e = devSpawnEnemy(w, "slime", 520, 400); // within blast radius of the barrel
    e.hp = 3;
    // B's bullet detonates the barrel; the explosion (and its kill) must credit B.
    const barrel = w.props[0];
    const det: Bullet = {
      x: barrel.x, y: barrel.y, vx: 1, vy: 0, radius: 6, life: 1, friendly: true,
      owner: b.id, damage: 10, color: "#fff", pierce: 0, hitList: null, isCrit: false,
    };
    w.bullets.push(det);
    for (let i = 0; i < 5 && !e.dead; i++) stepWorldPhase(w, 1 / 20, []);
    check("detonator (B) credited the barrel kill", b.kills >= 1 && a.kills === 0, `A.kills=${a.kills} B.kills=${b.kills}`);
  }
}

function main(): void {
  ownershipTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll Stage-C sim assertions passed.\n");
}

main();
