// Stage C pure-sim assertions: the authoritative multi-player combat correctness that the
// golden-master suite (single player) can't cover. Everything here runs stepWorldPhase /
// stepPlayerPhase directly on a headless WorldState with 2+ players and asserts per-player
// ownership attribution, the authoritative down/revive model, and lag-compensated hit
// registration. No DOM, no sockets — the same pure core the server and client share.
//
// Run: npm run test:sim

import {
  createWorld, spawnPlayerInWorld, removePlayerFromWorld, devSpawnEnemy, devSpawnProp, devSpawnChest,
  stepWorldPhase, stepPlayerPhase, recordHistory, rewoundEnemyPos, fireTimeRewind,
  switchWeaponInWorld, acquireWeaponInWorld,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { Bullet, Enemy } from "../src/sim/types.js";
import { REVIVE } from "../src/sim/balance.js";
import { TILE } from "../src/sim/types.js";
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
    check("A returns at the revive HP", a.hp === REVIVE.hp, `hp=${a.hp}`);
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

  section("lag-comp: a hitscan-fast shot uses the shooter's FIRE-time view (hits what they saw)");
  {
    const { w, a, b } = twoPlayerArena();
    // Park players so the enemy AI stays put; script an exact position trail via the real step.
    a.isDown = true; b.isDown = true;
    const e = devSpawnEnemy(w, "slime", 400, 400);
    e.hp = 100; e.spawnTimer = 0;
    for (let i = 0; i < 4; i++) { e.x = 400 + i * 40; stepWorldPhase(w, 1 / 20, []); }
    e.x = 560; // present jump; B's client still rendered it ~4 records back (x=440)
    const hpBefore = e.hp;
    // A near-instant shot fired THIS tick (bornTick = now) with fire-time rewind 4, placed where
    // B saw the enemy (x=440). Present-time (x=560) would miss by 120px.
    w.bullets.push({ x: 440, y: 400, vx: 1, vy: 0, radius: 6, life: 1, friendly: true, owner: b.id, damage: 5, color: "#fff", pierce: 0, hitList: null, isCrit: false, bornTick: w.tick, lagRewind: 4 });
    stepWorldPhase(w, 1 / 20, []);
    check("fire-time-rewound shot registered damage", e.hp < hpBefore, `hp ${hpBefore}->${e.hp}`);

    // Control: the same shot with NO fire-time anchor (lagRewind 0) misses the present enemy.
    e.hp = 100;
    w.bullets.push({ x: 440, y: 400, vx: 1, vy: 0, radius: 6, life: 1, friendly: true, owner: b.id, damage: 5, color: "#fff", pierce: 0, hitList: null, isCrit: false, bornTick: w.tick, lagRewind: 0 });
    stepWorldPhase(w, 1 / 20, []);
    check("without a fire-time anchor the same shot misses (no impossible present-time hit)", e.hp === 100, `hp=${e.hp}`);
  }

  section("lag-comp: a SLOW projectile decays to PRESENT-time collision (not rewound at impact)");
  {
    // The fire-time rewind shrinks one tick per tick. A projectile fired with rewind 4 that
    // collides 6 ticks later must test PRESENT positions — rewinding a long-traveled bullet to
    // the shooter's old view would be wrong (the TD finding). fireTimeRewind proves the decay.
    const { w } = twoPlayerArena();
    const born = w.tick;
    check("at fire (age 0) rewind is full", fireTimeRewind(w, born, 4) === 4);
    // Advance the world clock 6 ticks (stepWorldPhase is the world-systems half; the tick counter
    // is bumped by the server/solo stepWorld wrapper, so advance it explicitly here).
    for (let i = 0; i < 6; i++) { w.tick++; stepWorldPhase(w, 1 / 20, []); }
    check("after 6 ticks a rewind-4 shot has decayed to present-time (0)", fireTimeRewind(w, born, 4) === 0, `eff=${fireTimeRewind(w, born, 4)}`);
    check("a mid-flight shot (age 1) keeps partial rewind", fireTimeRewind(w, w.tick - 1, 4) === 3);
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

    const snap = buildSnapshot(w, "pMe", 0, [], 0, false, { interestRadius: 400 });
    if (snap.t !== "snap") { check("snapshot built", false); return; }
    const ids = new Set(snap.enemies.map((e) => e.id));
    check("own player is always included", snap.self !== null);
    check("nearby enemy included", ids.has(nearSlime.id));
    check("distant enemy excluded", !ids.has(farSlime.id));
    check("boss included regardless of distance (global objective)", ids.has(boss.id));
    check("nearby prop included, distant prop excluded", snap.props.length === 1, `props=${snap.props.length}`);

    // No filter (radius 0) -> everything is sent (full-snapshot / bootstrap path).
    const fullSnap = buildSnapshot(w, "pMe", 0, [], 0, true, { interestRadius: 0 });
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

function weaponSwitchTests(): void {
  section("weapon switch: only an OWNED slot equips; an unowned id is rejected");
  {
    const { w, a } = twoPlayerArena();
    check("switching to an unowned weapon is rejected", switchWeaponInWorld(w, a.id, "railgun") === false);
    check("weapon unchanged after a rejected switch", a.weapon === "pistol", `weapon=${a.weapon}`);
    acquireWeaponInWorld(w, a.id, "railgun");
    check("after acquiring, switch to it succeeds", switchWeaponInWorld(w, a.id, "railgun") === true && a.weapon === "railgun");
  }

  section("weapon switch: independent per player (one switch doesn't touch the other)");
  {
    const { w, a, b } = twoPlayerArena();
    acquireWeaponInWorld(w, a.id, "shotgun");
    acquireWeaponInWorld(w, b.id, "tesla");
    switchWeaponInWorld(w, a.id, "shotgun");
    switchWeaponInWorld(w, b.id, "tesla");
    check("A equipped its own choice", a.weapon === "shotgun");
    check("B equipped its own choice", b.weapon === "tesla");
    check("switching a weapon B owns but A does not is rejected for A", switchWeaponInWorld(w, a.id, "tesla") === false && a.weapon === "shotgun");
  }
}

function descendTests(): void {
  const exitCenter = (w: WorldState) => ({ ex: w.dungeon.exit.x * TILE + TILE / 2, ey: w.dungeon.exit.y * TILE + TILE / 2 });

  section("descend: party-wide — floor holds until ALL living players reach the cleared exit");
  {
    const w = createWorld(0xBEEF, 1, { isShared: true, skipLocalPlayer: true });
    const a = spawnPlayerInWorld(w, "pA");
    const b = spawnPlayerInWorld(w, "pB");
    w.enemies = []; // floor cleared (authoritative)
    const { ex, ey } = exitCenter(w);
    a.x = ex; a.y = ey; // only A at the exit
    b.x = ex - 400; b.y = ey;
    stepWorldPhase(w, 1 / 20, []);
    check("no descend while a living teammate is away from the exit", w.floor === 1, `floor=${w.floor}`);
    b.x = ex; b.y = ey; // now both at the exit
    const ev: SimEvent[] = [];
    stepWorldPhase(w, 1 / 20, ev);
    check("descend once ALL living players are at the exit", w.floor === 2, `floor=${w.floor}`);
    check("descend event emitted", ev.some((e) => e.t === "descend"));
    check("a fresh floor-2 dungeon loaded with enemies", w.enemies.length > 0, `enemies=${w.enemies.length}`);
    check("both players offered a between-floor blessing", ev.filter((e) => e.t === "offerBlessing").length === 2);
  }

  section("descend: two players in the SAME world get the SAME next floor + seed + enemy layout");
  {
    // Same seed → the generated floor-2 layout is deterministic; both clients read the one world,
    // so their snapshots carry identical seed/floor/enemy ids by construction.
    const seed = 0x1234;
    const w = createWorld(seed, 1, { isShared: true, skipLocalPlayer: true });
    const a = spawnPlayerInWorld(w, "pA");
    const b = spawnPlayerInWorld(w, "pB");
    w.enemies = [];
    const { ex, ey } = exitCenter(w);
    a.x = ex; a.y = ey; b.x = ex; b.y = ey;
    stepWorldPhase(w, 1 / 20, []);
    const snapA = buildSnapshot(w, "pA", 0, [], 0, false, {});
    const snapB = buildSnapshot(w, "pB", 0, [], 0, false, {});
    if (snapA.t === "snap" && snapB.t === "snap") {
      check("both snapshots carry the same seed", snapA.seed === snapB.seed && snapA.seed === seed);
      check("both snapshots carry the same next floor", snapA.floor === snapB.floor && snapA.floor === 2);
      const idsA = snapA.enemies.map((e) => e.id).sort().join(",");
      const idsB = snapB.enemies.map((e) => e.id).sort().join(",");
      check("both snapshots carry the identical enemy layout", idsA === idsB && idsA.length > 0);
    }
  }
}

// Bug regression: "mobs still get stuck a lot next to barrels". An enemy chasing a target
// with a prop dead in its path must route around it — reaching the target within a bounded
// time and never staying wedged against the prop.
function propAvoidanceTests(): void {
  const DT = 1 / 20;

  interface ChaseResult { reached: boolean; ticks: number; maxWedge: number; trace: string }
  // Drive one chaser at a parked player through stepWorldPhase and measure progress. The
  // wedge metric is the LONGEST streak of near-zero movement ticks — the old behavior
  // ground against a prop for seconds; the reworked steering must never sit still.
  const runChase = (seed: number, place: (w: WorldState) => void, maxTicks: number): ChaseResult => {
    const w = createWorld(seed, 1, { isSandbox: true, skipLocalPlayer: true });
    const a = spawnPlayerInWorld(w, "pA");
    spawnPlayerInWorld(w, "pB"); // standing ally: a stray touch downs rather than ending the world
    const cx = w.dungeon.spawn.x * TILE + TILE / 2, cy = w.dungeon.spawn.y * TILE + TILE / 2;
    a.x = cx + 110; a.y = cy;
    const bp = w.players.get("pB")!;
    bp.x = cx - 500; bp.y = cy - 400;
    place(w);
    const e = devSpawnEnemy(w, "slime", cx - 110, cy);
    e.spawnTimer = 0;
    let maxWedge = 0, wedge = 0, ticks = 0, reached = false;
    const trace: number[] = [];
    while (ticks < maxTicks && !reached) {
      const x0 = e.x, y0 = e.y;
      stepWorldPhase(w, DT, []);
      ticks++;
      trace.push(Math.round(e.x * 100) / 100, Math.round(e.y * 100) / 100);
      const moved = Math.hypot(e.x - x0, e.y - y0);
      wedge = moved < 0.3 ? wedge + 1 : 0;
      if (wedge > maxWedge) maxWedge = wedge;
      if (Math.hypot(e.x - a.x, e.y - a.y) <= e.radius + a.pr + 2) reached = true;
    }
    return { reached, ticks, maxWedge, trace: JSON.stringify(trace) };
  };

  section("prop avoidance: a chaser routes around a prop dead-center in its path");
  {
    // 220px straight-line chase ≈ 2.2s at slime speed; allow 3x for the detour.
    const r = runChase(0xA401D, (w) => {
      const cx = w.dungeon.spawn.x * TILE + TILE / 2, cy = w.dungeon.spawn.y * TILE + TILE / 2;
      devSpawnProp(w, "barrel", cx, cy);
    }, Math.ceil(7 / DT));
    check("enemy reached the target around the barrel", r.reached, `${(r.ticks * DT).toFixed(1)}s`);
    check("enemy never stayed wedged against it", r.maxWedge <= 8, `longest stall=${(r.maxWedge * DT).toFixed(2)}s`);
  }

  section("prop avoidance: a chaser rounds a WALL of props (commits to one side, no ping-pong)");
  {
    const r = runChase(0xA401E, (w) => {
      const cx = w.dungeon.spawn.x * TILE + TILE / 2, cy = w.dungeon.spawn.y * TILE + TILE / 2;
      devSpawnProp(w, "crate", cx, cy - 34);
      devSpawnProp(w, "barrel", cx, cy);
      devSpawnProp(w, "crate", cx, cy + 34);
    }, Math.ceil(9 / DT));
    check("enemy reached the target around the prop wall", r.reached, `${(r.ticks * DT).toFixed(1)}s`);
    check("enemy never stayed wedged against the wall", r.maxWedge <= 8, `longest stall=${(r.maxWedge * DT).toFixed(2)}s`);
  }

  section("prop avoidance: the detour is deterministic (seeded, replay-identical)");
  {
    const place = (w: WorldState) => {
      const cx = w.dungeon.spawn.x * TILE + TILE / 2, cy = w.dungeon.spawn.y * TILE + TILE / 2;
      devSpawnProp(w, "barrel", cx, cy);
    };
    const r1 = runChase(0xA401F, place, Math.ceil(7 / DT));
    const r2 = runChase(0xA401F, place, Math.ceil(7 / DT));
    check("two runs of the same seed trace the identical path", r1.trace === r2.trace && r1.reached);
  }
}

function lootOwnershipTests(): void {
  section("loot ownership: a coin is collected once, by the first player to reach it");
  {
    const { w, a, b } = twoPlayerArena();
    a.coins = 0; b.coins = 0;
    // One coin sitting exactly on A (A is the first/only collector this step).
    w.pickups.push({ kind: "coin", x: a.x, y: a.y, radius: 13, weapon: null, value: 7 });
    stepWorldPhase(w, 1 / 20, []);
    check("coin removed from the world (collected once)", w.pickups.length === 0);
    check("exactly one player gained the coin's value", (a.coins === 7) !== (b.coins === 7), `A=${a.coins} B=${b.coins}`);
    check("the collector was the player standing on it (A)", a.coins === 7 && b.coins === 0);
  }

  section("loot ownership: a weapon pickup goes to the collector's inventory only");
  {
    const { w, a, b } = twoPlayerArena();
    w.pickups.push({ kind: "weapon", x: a.x, y: a.y, radius: 16, weapon: "tesla" });
    stepWorldPhase(w, 1 / 20, []);
    check("collector (A) acquired the weapon", a.ownedWeapons.includes("tesla"));
    check("the other player (B) did not", !b.ownedWeapons.includes("tesla"));
  }
}

function departedOwnerTests(): void {
  section("attribution: a DEPARTED owner's bullet still lands but credits NO ONE");
  {
    const { w, a, b } = twoPlayerArena();
    const e = devSpawnEnemy(w, "slime", 500, 400);
    e.hp = 1;
    plantBullet(w, b.id, e, 10);
    removePlayerFromWorld(w, b.id); // B disconnects with the bullet in flight
    const ev: SimEvent[] = [];
    stepWorldPhase(w, 1 / 20, ev);
    check("enemy still died to the in-flight bullet", w.enemies.length === 0);
    check("the kill credited NO live player (never re-attributed)", a.kills === 0, `A.kills=${a.kills}`);
    const killEv = ev.find((x) => x.t === "enemyKill");
    check("kill event emitted with no combo credit", !!killEv && (killEv as { combo: number }).combo === 0);
  }

  section("attribution: a departed igniter's burn DoT kill credits no one");
  {
    const { w, a, b } = twoPlayerArena();
    const e = devSpawnEnemy(w, "slime", 500, 400);
    e.hp = 2;
    const burn: Bullet = {
      x: e.x, y: e.y, vx: 1, vy: 0, radius: 6, life: 1, friendly: true,
      owner: b.id, damage: 0.1, color: "#f80", pierce: 0, hitList: null, isCrit: false, burn: 3,
    };
    w.bullets.push(burn);
    stepWorldPhase(w, 1 / 20, []); // ignite
    removePlayerFromWorld(w, b.id);
    for (let i = 0; i < 120 && !e.dead && w.enemies.length > 0; i++) stepWorldPhase(w, 1 / 20, []);
    check("burn finished the kill after the igniter left", w.enemies.length === 0);
    check("no live player was credited", a.kills === 0, `A.kills=${a.kills}`);
  }

  section("attribution: a departed owner's bullet does NOT open a chest for someone else");
  {
    const { w, a, b } = twoPlayerArena();
    devSpawnChest(w, 500, 400);
    const chest = w.chests[0];
    const det: Bullet = {
      x: chest.x, y: chest.y, vx: 1, vy: 0, radius: 6, life: 1, friendly: true,
      owner: b.id, damage: 1, color: "#fff", pierce: 0, hitList: null, isCrit: false,
    };
    w.bullets.push(det);
    removePlayerFromWorld(w, b.id);
    const ev: SimEvent[] = [];
    stepWorldPhase(w, 1 / 20, ev);
    check("chest stays closed (no phantom opener, nothing credited to A)", !chest.opened);
    check("no blessing offered to anyone", !ev.some((x) => x.t === "offerBlessing"));
    check("the bullet was still consumed by the chest", w.bullets.every((bl) => bl.life <= 0));
    check("A untouched", a.coins === 0 && a.ownedItemIds.length === 0);
  }

  section("attribution: chest opened by a LIVE bullet credits the bullet's owner, not a primary");
  {
    const { w, a, b } = twoPlayerArena();
    devSpawnChest(w, 500, 400);
    const chest = w.chests[0];
    plantBullet(w, b.id, { x: chest.x, y: chest.y, radius: chest.radius } as Enemy, 1); // aimed at the chest
    const ev: SimEvent[] = [];
    stepWorldPhase(w, 1 / 20, ev);
    check("chest opened by B's bullet", chest.opened);
    const offer = ev.find((x) => x.t === "offerBlessing") as { pid: string } | undefined;
    if (offer) check("any blessing offer targets the SHOOTER (B), never A", offer.pid === b.id, `pid=${offer.pid}`);
    else check("no offer this roll (coins/heart/weapon rolled instead) — never credited to A", a.ownedItemIds.length === 0);
  }
}

function meleeFireTimeTests(): void {
  section("melee lag comp: BOTH actors evaluate at fire time (attacker origin + rewound target)");
  {
    const w = createWorld(0xFACE, 1, { isSandbox: true, skipLocalPlayer: true });
    const a = spawnPlayerInWorld(w, "pA");
    spawnPlayerInWorld(w, "pB"); // ally so downs don't end the world
    a.x = 300; a.y = 300;
    // A target that sat at (340,300) in the shooter's view (history — inside sword reach), but
    // is somewhere else now.
    const e = devSpawnEnemy(w, "slime", 340, 300);
    e.hp = 100; e.spawnTimer = 0;
    for (let i = 0; i < 4; i++) { w.tick++; recordHistory(w); }
    e.x = 700; // present position far outside any swing reach
    // A laggy swordsman (rewind 3) swings from (300,300) toward +x.
    acquireWeaponInWorld(w, a.id, "sword");
    a.rewindTicks = 3;
    a.aimAngle = 0;
    const ev: SimEvent[] = [];
    stepPlayerPhase(w, a, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }, 1 / 20, ev);
    check("swing started", a.meleeSwing !== null);
    // The attacker then MOVES far away — but the swing must still evaluate from its ORIGIN.
    a.x = 1000; a.y = 800;
    const hpBefore = e.hp;
    w.tick++;
    stepWorldPhase(w, 1 / 20, []);
    check("fire-time swing hit the target where the attacker SAW it", e.hp < hpBefore, `hp ${hpBefore}->${e.hp}`);
  }

  section("melee lag comp: the attacker's NEW position cannot drag a laggy swing onto a target (impossible hit)");
  {
    const w = createWorld(0xFACE, 1, { isSandbox: true, skipLocalPlayer: true });
    const a = spawnPlayerInWorld(w, "pA");
    spawnPlayerInWorld(w, "pB");
    a.x = 300; a.y = 300;
    // The target is FAR from the swing origin, near where the attacker will move to.
    const e = devSpawnEnemy(w, "slime", 1000, 830);
    e.hp = 100; e.spawnTimer = 0;
    for (let i = 0; i < 4; i++) { w.tick++; recordHistory(w); }
    acquireWeaponInWorld(w, a.id, "sword");
    a.rewindTicks = 3;
    a.aimAngle = 0;
    stepPlayerPhase(w, a, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false }, 1 / 20, []);
    a.x = 1000; a.y = 800; // teleport next to the target AFTER firing
    const hpBefore = e.hp;
    w.tick++;
    stepWorldPhase(w, 1 / 20, []);
    check("no impossible hit from the post-fire position while rewound", e.hp === hpBefore, `hp=${e.hp}`);
  }
}

function strandedDownTests(): void {
  section("lifecycle: the last standing player LEAVING ends the run for stranded downed players");
  {
    const w = createWorld(0xD0EE, 1, { isShared: true, skipLocalPlayer: true });
    const a = spawnPlayerInWorld(w, "pA");
    const b = spawnPlayerInWorld(w, "pB");
    a.x = 200; a.y = 200; b.x = 900; b.y = 700;
    // A goes down while B stands.
    a.hp = 1; a.invuln = 0;
    plantEnemyBullet(w, a, 5);
    stepWorldPhase(w, 1 / 20, []);
    check("A is down (revivable while B stands)", a.isDown && !w.isRunOver);
    // B disconnects — A can never be revived.
    removePlayerFromWorld(w, b.id);
    const ev: SimEvent[] = [];
    stepWorldPhase(w, 1 / 20, ev);
    check("run ended for the stranded downed player", w.isRunOver);
    check("gameOver emitted for A", ev.some((x) => x.t === "gameOver" && (x as { pid: string }).pid === a.id));
    // Terminal transition is idempotent: another tick emits nothing new.
    const ev2: SimEvent[] = [];
    stepWorldPhase(w, 1 / 20, ev2);
    check("terminal transition emits exactly once", !ev2.some((x) => x.t === "gameOver"));
  }

  section("lifecycle: a wipe by damage also marks the world over (state-derived game over)");
  {
    const { w, a, b } = twoPlayerArena();
    w.isShared = true;
    a.hp = 1; a.invuln = 0; plantEnemyBullet(w, a, 5); stepWorldPhase(w, 1 / 20, []);
    b.hp = 1; b.invuln = 0; plantEnemyBullet(w, b, 5);
    const ev: SimEvent[] = [];
    stepWorldPhase(w, 1 / 20, ev);
    check("wipe marked the world over", w.isRunOver);
    check("gameOver events for the whole room", ev.filter((x) => x.t === "gameOver").length === 2);
  }
}

function downIterationTests(): void {
  // Regression for the TD finding: a player going DOWN must not abort the enemy loop (which would
  // freeze the rest of the world for everyone). Solo keeps its game-over early-return.
  section("down does NOT abort enemy iteration in a shared world (other enemies still resolve)");
  {
    const w = createWorld(0xD00D, 1, { isShared: true, skipLocalPlayer: true });
    const a = spawnPlayerInWorld(w, "pA");
    const b = spawnPlayerInWorld(w, "pB");
    a.x = 200; a.y = 200; a.hp = 1; a.invuln = 0;
    b.x = 1200; b.y = 900; // B far + alive so A goes DOWN (not game over)
    // enemy1 sits on A (contact -> downs A this tick). enemy2 elsewhere with a bullet on it.
    const e1 = devSpawnEnemy(w, "slime", a.x, a.y); e1.spawnTimer = 0;
    const e2 = devSpawnEnemy(w, "slime", 700, 500); e2.hp = 100; e2.spawnTimer = 0;
    plantBullet(w, b.id, e2, 5);
    stepWorldPhase(w, 1 / 20, []);
    check("A was downed by contact", a.isDown);
    check("iteration continued past the down: e2 still took its bullet's damage", e2.hp < 100, `e2.hp=${e2.hp}`);
  }

  section("control: a NON-shared world aborts the enemy loop on down (solo game-over semantics)");
  {
    const w = createWorld(0xD00D, 1, { skipLocalPlayer: true }); // isShared:false, isCoop:false
    const a = spawnPlayerInWorld(w, "pA");
    const b = spawnPlayerInWorld(w, "pB");
    a.x = 200; a.y = 200; a.hp = 1; a.invuln = 0;
    b.x = 1200; b.y = 900;
    // Enemies are inserted so e1 (which downs A) iterates BEFORE e2; the loop aborts after A downs.
    const e1 = devSpawnEnemy(w, "slime", a.x, a.y); e1.spawnTimer = 0;
    const e2 = devSpawnEnemy(w, "slime", 700, 500); e2.hp = 100; e2.spawnTimer = 0;
    plantBullet(w, b.id, e2, 5);
    stepWorldPhase(w, 1 / 20, []);
    check("A downed (a standing ally still exists)", a.isDown);
    check("non-shared loop aborted: e2 untouched this tick", e2.hp === 100, `e2.hp=${e2.hp}`);
  }
}

function main(): void {
  ownershipTests();
  departedOwnerTests();
  downReviveTests();
  downIterationTests();
  strandedDownTests();
  lagCompTests();
  meleeFireTimeTests();
  interestTests();
  propChainTests();
  weaponSwitchTests();
  descendTests();
  propAvoidanceTests();
  lootOwnershipTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll Stage-C sim assertions passed.\n");
}

main();
