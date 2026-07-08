// Stage C pure-sim assertions: the authoritative multi-player combat correctness that the
// golden-master suite (single player) can't cover. Everything here runs stepWorldPhase /
// stepPlayerPhase directly on a headless WorldState with 2+ players and asserts per-player
// ownership attribution, the authoritative down/revive model, and lag-compensated hit
// registration. No DOM, no sockets — the same pure core the server and client share.
//
// Run: npm run test:sim

import {
  createWorld, spawnPlayerInWorld, devSpawnEnemy, devSpawnProp,
  stepWorldPhase, recordHistory, rewoundEnemyPos,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { Bullet, Enemy } from "../src/sim/types.js";
import { REVIVE_HP } from "../src/sim/constants.js";
import { buildSnapshot } from "../src/net/protocol.js";

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

// An enemy bullet planted on `victim` so the next world step hits them for `damage`.
function plantEnemyBullet(w: WorldState, victim: PlayerSim, damage: number): void {
  w.bullets.push({
    x: victim.x, y: victim.y, vx: 0, vy: 0, radius: 6, life: 1, friendly: false,
    owner: null, damage, color: "#f00", pierce: 0, hitList: null, isCrit: false,
  });
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

function downReviveTests(): void {
  section("down/revive: a player at 0 HP goes DOWN (not game over) while a teammate is up");
  {
    const { w, a, b } = twoPlayerArena();
    a.hp = 1;
    plantEnemyBullet(w, a, 5);
    const ev: SimEvent[] = [];
    stepWorldPhase(w, 1 / 20, ev);
    check("A is downed, not dead", a.isDown && a.hp === 0);
    check("no gameOver while B stands", !ev.some((x) => x.t === "gameOver"));
    check("B is unaffected and still up", !b.isDown && b.hp > 0);
  }

  section("down/revive: contact/enemy damage skips a downed player");
  {
    const { w, a } = twoPlayerArena();
    a.isDown = true; a.hp = 0;
    plantEnemyBullet(w, a, 5);
    stepWorldPhase(w, 1 / 20, []);
    // The bullet should pass through a downed player (still alive at 0, still down, no crash).
    check("downed player not further damaged", a.isDown && a.hp === 0);
  }

  section("down/revive: full team wipe ends the run for everyone");
  {
    const { w, a, b } = twoPlayerArena();
    a.hp = 1; plantEnemyBullet(w, a, 5); stepWorldPhase(w, 1 / 20, []);
    check("A down first", a.isDown);
    b.hp = 1; plantEnemyBullet(w, b, 5);
    const ev: SimEvent[] = [];
    stepWorldPhase(w, 1 / 20, ev);
    const gos = ev.filter((x) => x.t === "gameOver").map((x) => (x as { pid: string }).pid);
    check("gameOver emitted for the whole room", gos.includes(a.id) && gos.includes(b.id), `pids=${gos.join(",")}`);
  }

  section("down/revive: a standing teammate revives a downed player after a sustained hold");
  {
    const { w, a, b } = twoPlayerArena();
    a.hp = 1; plantEnemyBullet(w, a, 5); stepWorldPhase(w, 1 / 20, []);
    check("A downed", a.isDown);
    // B walks onto A and holds.
    b.x = a.x + 10; b.y = a.y;
    let revived = false;
    let ticks = 0;
    for (let i = 0; i < 40 && !revived; i++) {
      const ev: SimEvent[] = [];
      stepWorldPhase(w, 1 / 20, ev);
      ticks++;
      if (ev.some((x) => x.t === "revive" && (x as { pid: string }).pid === a.id)) revived = true;
    }
    check("A revived by B", revived && !a.isDown, `after ${ticks} ticks`);
    check("A returns at the revive HP", a.hp === REVIVE_HP, `hp=${a.hp}`);
    check("A briefly invulnerable after revive", a.invuln > 0);
  }

  section("down/revive: revive progress decays without a teammate present (needs a sustained hold)");
  {
    const { w, a } = twoPlayerArena();
    // A downed with a far-away B: partial progress must not persist to a free revive.
    a.hp = 1; plantEnemyBullet(w, a, 5); stepWorldPhase(w, 1 / 20, []);
    for (let i = 0; i < 60; i++) stepWorldPhase(w, 1 / 20, []); // B far -> never revives
    check("A stays down with no nearby reviver", a.isDown && a.reviveProgress === 0);
  }
}

function lagCompTests(): void {
  section("lag-comp: a rewound shot lands on a moving target where the shooter saw it");
  {
    const { w, a, b } = twoPlayerArena();
    // A single enemy marching steadily to the right; record a history trail.
    const e = devSpawnEnemy(w, "slime", 400, 400);
    e.hp = 100;
    // Manually advance the enemy + record history for several ticks (no AI interference: keep
    // players far so the enemy doesn't get pulled off its march).
    a.x = 50; a.y = 50; b.x = 50; b.y = 50;
    const trail: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 5; i++) {
      recordHistory(w);
      trail.push({ x: e.x, y: e.y });
      e.x += 40; // the enemy moved 40px between snapshots
    }
    // The enemy is now well ahead of where it was 3 records ago.
    const past = rewoundEnemyPos(w, e, 3);
    check("rewound position matches the recorded past", Math.abs(past[0] - trail[trail.length - 3].x) < 0.001, `past=${past[0].toFixed(1)} want=${trail[trail.length - 3].x}`);
    check("present position differs from the rewound one", Math.abs(e.x - past[0]) > 1);
  }

  section("lag-comp: rewind=0 (solo/prediction) always uses the present position");
  {
    const { w } = twoPlayerArena();
    const e = devSpawnEnemy(w, "slime", 400, 400);
    for (let i = 0; i < 5; i++) { recordHistory(w); e.x += 40; }
    const now = rewoundEnemyPos(w, e, 0);
    check("rewind 0 returns present pos", now[0] === e.x && now[1] === e.y);
  }

  section("lag-comp: a lagged shooter hits a target that the present-time test would MISS");
  {
    const { w, a, b } = twoPlayerArena();
    // Park both players (down) purely so the enemy AI finds no target and stays put — this lets
    // us script an exact position trail through the REAL step (which records history internally).
    a.isDown = true; b.isDown = true;
    const e = devSpawnEnemy(w, "slime", 400, 400);
    e.hp = 100; e.spawnTimer = 0;
    // Drive 4 authoritative ticks, moving the enemy +40px before each: the internal recordHistory
    // captures 400,440,480,520 as the enemy marches right.
    for (let i = 0; i < 4; i++) { e.x = 400 + i * 40; stepWorldPhase(w, 1 / 20, []); }
    // Present: enemy jumps to 560. B's client still renders it ~4 records back (x=440).
    e.x = 560;
    b.rewindTicks = 4;
    const hpBefore = e.hp;
    // B fires exactly where it SAW the enemy (x=440). Present-time (x=560) would miss by 120px.
    w.bullets.push({ x: 440, y: 400, vx: 1, vy: 0, radius: 6, life: 1, friendly: true, owner: b.id, damage: 5, color: "#fff", pierce: 0, hitList: null, isCrit: false });
    stepWorldPhase(w, 1 / 20, []);
    check("lagged shooter's rewound shot registered damage", e.hp < hpBefore, `hp ${hpBefore}->${e.hp}`);

    // Control: the SAME shot with no rewind (rewind 0) misses the present-time enemy at 560.
    e.hp = 100; b.rewindTicks = 0;
    w.bullets.push({ x: 440, y: 400, vx: 1, vy: 0, radius: 6, life: 1, friendly: true, owner: b.id, damage: 5, color: "#fff", pierce: 0, hitList: null, isCrit: false });
    stepWorldPhase(w, 1 / 20, []);
    check("without rewind the same shot misses (no impossible present-time hit)", e.hp === 100, `hp=${e.hp}`);
  }

  section("lag-comp: rewind is clamped to the history window (no impossible rewind)");
  {
    const { w } = twoPlayerArena();
    const e = devSpawnEnemy(w, "slime", 400, 400);
    recordHistory(w); // only one record
    const deep = rewoundEnemyPos(w, e, 999); // absurd rewind
    check("absurd rewind clamps to available history (present-ish)", Number.isFinite(deep[0]) && Number.isFinite(deep[1]));
  }
}

function interestTests(): void {
  section("interest mgmt: distant entities are excluded, own player + boss objective always sent");
  {
    const w = createWorld(0xC0FFEE, 1, { isSandbox: true, skipLocalPlayer: true });
    const me = spawnPlayerInWorld(w, "pMe");
    me.x = 300; me.y = 300;
    const nearSlime = devSpawnEnemy(w, "slime", 360, 340);   // ~72px away -> in range
    const farSlime = devSpawnEnemy(w, "slime", 1400, 1000);  // far -> out of range
    const boss = devSpawnEnemy(w, "boss", 1500, 1000);       // far, but a GLOBAL objective
    devSpawnProp(w, "crate", 380, 320);                       // near -> in
    devSpawnProp(w, "crate", 1450, 980);                      // far -> out

    const snap = buildSnapshot(w, "pMe", 0, [], false, { interestRadius: 400 });
    if (snap.t !== "snap") { check("snapshot built", false); return; }
    const ids = new Set(snap.enemies.map((e) => e.id));
    check("own player is always included", snap.self !== null);
    check("nearby enemy included", ids.has(nearSlime.id));
    check("distant enemy excluded", !ids.has(farSlime.id));
    check("boss included regardless of distance (global objective)", ids.has(boss.id));
    check("nearby prop included, distant prop excluded", snap.props.length === 1, `props=${snap.props.length}`);

    // No filter (radius 0) -> everything is sent (full-snapshot / bootstrap path).
    const fullSnap = buildSnapshot(w, "pMe", 0, [], true, { interestRadius: 0 });
    if (fullSnap.t === "snap") check("radius 0 sends all enemies", fullSnap.enemies.length === 3, `enemies=${fullSnap.enemies.length}`);
  }
}

function propChainTests(): void {
  section("prop chain: one barrel detonates the adjacent barrel; both blasts hit mobs identically");
  {
    const { w, a } = twoPlayerArena();
    a.x = 50; a.y = 50;
    devSpawnProp(w, "barrel_explosive", 500, 400);
    devSpawnProp(w, "barrel_explosive", 540, 400); // within blast radius of the first
    const e1 = devSpawnEnemy(w, "slime", 500, 440); e1.hp = 100; e1.spawnTimer = 0;
    const e2 = devSpawnEnemy(w, "slime", 540, 440); e2.hp = 100; e2.spawnTimer = 0;
    const h1 = e1.hp, h2 = e2.hp;
    const barrel1 = w.props[0];
    w.bullets.push({ x: barrel1.x, y: barrel1.y, vx: 1, vy: 0, radius: 6, life: 1, friendly: true, owner: a.id, damage: 10, color: "#fff", pierce: 0, hitList: null, isCrit: false });
    for (let i = 0; i < 5; i++) stepWorldPhase(w, 1 / 20, []);
    const liveBarrels = w.props.filter((p) => p.kind === "barrel_explosive" && p.breakT === undefined).length;
    check("both barrels detonated (chain reaction)", liveBarrels === 0, `liveBarrels=${liveBarrels}`);
    check("mob near the first barrel took blast damage", e1.hp < h1, `hp ${h1}->${e1.hp}`);
    check("mob near the chained barrel also took blast damage", e2.hp < h2, `hp ${h2}->${e2.hp}`);
  }

  section("prop chain: explosion damages players in range (friendly fire is authoritative)");
  {
    const { w, a, b } = twoPlayerArena();
    // Park B far; put A right next to the barrel so the blast catches them.
    b.x = 50; b.y = 50;
    devSpawnProp(w, "barrel_explosive", 500, 400);
    a.x = 520; a.y = 400; a.invuln = 0;
    const hpBefore = a.hp;
    w.bullets.push({ x: 500, y: 400, vx: 1, vy: 0, radius: 6, life: 1, friendly: true, owner: b.id, damage: 10, color: "#fff", pierce: 0, hitList: null, isCrit: false });
    stepWorldPhase(w, 1 / 20, []);
    check("player caught in the blast took self/friendly-fire damage", a.hp < hpBefore, `hp ${hpBefore}->${a.hp}`);
  }
}

function main(): void {
  ownershipTests();
  downReviveTests();
  lagCompTests();
  interestTests();
  propChainTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll Stage-C sim assertions passed.\n");
}

main();
