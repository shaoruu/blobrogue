// Content-wave sim assertions: the two new regular enemies (charger, burrower), the
// second boss (MARROW) and the two new weapons (Thumper mortar, Swallow
// boomerang), all exercised headlessly on the pure sim — behavior grammar, telegraphs,
// untargetable windows, phase machinery, and weapon room-verbs.
//
// Run: npm run test:content

import {
  createWorld, stepWorld, devSpawnEnemy, devSpawnProp, acquireWeaponInWorld, isFloorCleared,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, Enemy, EnemyKind } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import { createEnemy, spawnFloorEnemies, isBossKind, bossKindForFloor, ENEMY_ARCHETYPES } from "../src/sim/enemies.js";
import { generateDungeon } from "../src/sim/dungeon.js";
import { MARROW, marrowHpForFloor } from "../src/sim/balance.js";
import { WEAPONS, PICKUP_WEAPONS } from "../src/sim/weapons.js";
import { Rng } from "../src/sim/rng.js";
import * as C from "../src/sim/constants.js";

const DT = 1 / 60;

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function idle(seq: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
}

function step(w: WorldState, cmd: InputCmd): SimEvent[] {
  return stepWorld(w, new Map([[LOCAL_ID, cmd]]), DT);
}

function stepFor(w: WorldState, seconds: number, ev?: SimEvent[]): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const out = step(w, idle(w.tick + 1));
    if (ev) ev.push(...out);
  }
}

// A fresh sandbox arena with the local player parked at an exact spot, spawn grace cleared.
function arena(seed: number, floor = 1): { w: WorldState; p: PlayerSim } {
  const w = createWorld(seed, floor, { isSandbox: true });
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 0;
  return { w, p };
}

// A combat-ready enemy: spawn grace cleared so triggers/telegraphs can be timed exactly.
function spawnReady(w: WorldState, kind: EnemyKind, x: number, y: number): Enemy {
  const e = devSpawnEnemy(w, kind, x, y);
  e.spawnTimer = 0;
  return e;
}

function plantBullet(w: WorldState, x: number, y: number, damage: number, radius = 12): void {
  const b: Bullet = {
    x, y, vx: 1, vy: 0, radius, life: 0.05, friendly: true, owner: LOCAL_ID,
    damage, color: "#fff", pierce: 0, hitList: null, isCrit: false,
  };
  w.bullets.push(b);
}

// ---- the charger: telegraphed line rush + wall-crash stun ----

function chargerTests(): void {
  section("charger: trigger, aim lock, lane speed");
  {
    const { w, p } = arena(0xC4A6);
    p.x = 900; p.y = 600;
    const e = spawnReady(w, "charger", 640, 600); // 260px away, inside the 320 trigger
    stepFor(w, 0.1);
    check("in-range charger begins the rush windup", e.attack.phase === "windup" && e.attack.move === "rush",
      `phase=${e.attack.phase} move=${e.attack.move}`);
    stepFor(w, C.CHARGER_LOCK);
    check("aim locks partway through the windup", e.attack.isAimLocked);
    const locked = e.attack.lockedAngle;
    // The dodge: sidestep AFTER the lock — the lane must not follow.
    p.y = 300;
    stepFor(w, C.CHARGER_WINDUP - C.CHARGER_LOCK + 0.05);
    check("rush commits along the LOCKED angle (the sidestep wins)", e.attack.phase === "active"
      && Math.abs(e.attack.lockedAngle - locked) < 1e-9);
    const x0 = e.x;
    stepFor(w, 0.2);
    const traveled = e.x - x0;
    check("rush crosses the room at rush speed (~480px/s east)", traveled > 480 * 0.2 * 0.85 && Math.abs(e.y - 600) < 1,
      `traveled=${traveled.toFixed(0)}px in 0.2s`);
  }

  section("charger: wall crash = the authored punish window");
  {
    const { w, p } = arena(0xC4A7);
    p.x = 1400; p.y = 600;
    const e = spawnReady(w, "charger", 1180, 600);
    // Wait out the windup, then step aside so the rush runs into the east wall.
    stepFor(w, C.CHARGER_WINDUP + 0.05);
    p.x = 900; p.y = 300;
    const ev: SimEvent[] = [];
    stepFor(w, 1.0, ev);
    check("the rush crashes into the wall", ev.some((x) => x.t === "chargeCrash"));
    check("crash swaps the move to 'crash' in recover (the stun)", e.attack.move === "crash" && e.attack.phase === "recover");
    // Well past the ordinary 0.5s recover the crash stun still holds…
    check("crash stun outlasts the ordinary recover", e.attack.phase === "recover" && C.CHARGER_CRASH_STUN > C.CHARGER_RECOVER,
      `t=${e.attack.time.toFixed(2)}s of ${C.CHARGER_CRASH_STUN}s`);
    stepFor(w, C.CHARGER_CRASH_STUN);
    check("…and releases after the full stun", e.attack.phase === "none");
  }

  section("charger: a connecting rush hits once, shoves, and ends");
  {
    const { w, p } = arena(0xC4A8);
    p.x = 900; p.y = 600;
    const e = spawnReady(w, "charger", 700, 600);
    stepFor(w, C.CHARGER_WINDUP + 0.05);
    const hpBefore = p.hp;
    const pxBefore = p.x;
    stepFor(w, 0.6);
    check("the rush connects for 1 contact damage", p.hp === hpBefore - 1, `hp ${hpBefore} -> ${p.hp}`);
    check("the impact shoves the player along the lane", p.x > pxBefore + 10, `shoved ${(p.x - pxBefore).toFixed(0)}px`);
    check("a connecting rush ends (hit-and-stop, never a drag)", e.attack.phase !== "active");
  }

  section("charger: brute tier carries the heavy authored commitment");
  {
    const { w, p } = arena(0xC4A9, 4);
    p.x = 900; p.y = 600;
    const e = createEnemy("charger", 700, 600, 4, w.rng, w.nextEnemyId++, { tier: "brute" });
    e.spawnTimer = 0;
    w.enemies.push(e);
    const hpBefore = p.hp;
    stepFor(w, C.CHARGER_WINDUP + 0.6);
    check("a brute charger's rush deals 2 (contact elsewhere stays 1)", p.hp === hpBefore - 2, `hp ${hpBefore} -> ${p.hp}`);
  }
}

// ---- the burrower: dive -> tunnel (untargetable) -> marked eruption ----

function burrowerTests(): void {
  section("burrower: dive cycle and the untargetable window");
  {
    const { w, p } = arena(0xB0B0);
    p.x = 1100; p.y = 600;
    const e = spawnReady(w, "burrower", 800, 600); // 300px away, inside the 380 trigger
    const ev: SimEvent[] = [];
    stepFor(w, 0.1, ev);
    check("in-range burrower telegraphs the dive", e.attack.phase === "windup" && e.attack.move === "dive");
    stepFor(w, C.BURROW_DIVE_WINDUP, ev);
    check("dive submerges after the telegraph (burrowDive fired)", ev.some((x) => x.t === "burrowDive")
      && e.attack.move === "dive" && e.attack.phase === "active");

    // Underground: a point-blank bullet must pass over it.
    const hpBefore = e.hp;
    plantBullet(w, e.x, e.y, 99);
    stepFor(w, 0.1, ev);
    check("bullets pass over the tunneling burrower", e.hp === hpBefore && !e.dead);

    const dist0 = Math.hypot(p.x - e.x, p.y - e.y);
    stepFor(w, 0.5, ev);
    const dist1 = Math.hypot(p.x - e.x, p.y - e.y);
    check("the mound tunnels toward the target", dist1 < dist0 - 80, `${dist0.toFixed(0)}px -> ${dist1.toFixed(0)}px`);

    stepFor(w, 1.2, ev);
    check("it resurfaces near the target on a marked eruption", e.attack.move === "erupt"
      && Math.hypot(p.x - e.attack.markX, p.y - e.attack.markY) <= C.BURROW_EMERGE_DIST + 40,
      `mark ${Math.hypot(p.x - e.attack.markX, p.y - e.attack.markY).toFixed(0)}px from player`);
  }

  section("burrower: the eruption marker is dodgeable and the surfacing is punishable");
  {
    const { w, p } = arena(0xB0B1);
    p.x = 1000; p.y = 600;
    const e = spawnReady(w, "burrower", 760, 600);
    // Ride the cycle to the eruption windup.
    let guard = 0;
    while (!(e.attack.move === "erupt" && e.attack.phase === "windup") && guard++ < 600) step(w, idle(w.tick + 1));
    check("reached the eruption windup", guard < 600);
    // Stand ON the marker: the eruption connects.
    p.x = e.attack.markX + 10; p.y = e.attack.markY;
    p.invuln = 0;
    const hpBefore = p.hp;
    const ev: SimEvent[] = [];
    stepFor(w, C.BURROW_ERUPT_WINDUP + 0.05, ev);
    check("standing on the marker eats the eruption (1 damage)", p.hp === hpBefore - 1 && ev.some((x) => x.t === "burrowErupt"));
    // Surfaced now: bullets connect again (the punish window).
    const surfacedHp = e.hp;
    plantBullet(w, e.x, e.y, 2);
    stepFor(w, 0.1);
    check("the surfaced burrower is hittable again", e.hp === surfacedHp - 2, `hp ${surfacedHp} -> ${e.hp}`);
  }
  {
    const { w, p } = arena(0xB0B2);
    p.x = 1000; p.y = 600;
    const e = spawnReady(w, "burrower", 760, 600);
    let guard = 0;
    while (!(e.attack.move === "erupt" && e.attack.phase === "windup") && guard++ < 600) step(w, idle(w.tick + 1));
    // Step OFF the marker inside the windup: the eruption whiffs.
    p.x = e.attack.markX + C.BURROW_ERUPT_RADIUS + 30; p.y = e.attack.markY;
    p.invuln = 0;
    const hpBefore = p.hp;
    stepFor(w, C.BURROW_ERUPT_WINDUP + 0.05);
    check("stepping off the marker dodges the eruption entirely", p.hp === hpBefore);
  }
}

// ---- MARROW: phases, shield beats, charges, volleys, spiral ----

function marrowSetup(seed: number): { w: WorldState; p: PlayerSim; boss: Enemy } {
  const w = createWorld(seed, 10, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 0;
  const boss = devSpawnEnemy(w, "marrow", p.x + 200, p.y);
  return { w, p, boss };
}

function marrowTests(): void {
  section("Marrow: identity, slotting, calibration anchors");
  check("floor 10 slots MARROW (and 15 goes back to the King)",
    bossKindForFloor(10) === "marrow" && bossKindForFloor(15) === "boss" && bossKindForFloor(20) === "marrow");
  check("marrow is a boss kind (chest/interest/death machinery)", isBossKind("marrow") && !isBossKind("charger"));
  check("F10 Marrow HP matches its calibration anchor", marrowHpForFloor(10) === MARROW.baseHp, `hp=${marrowHpForFloor(10)}`);
  {
    const d = generateDungeon(0x51ED, 10);
    const spawns = spawnFloorEnemies(d, 0x51ED, 10);
    const boss = spawns.active.find((e) => isBossKind(e.kind));
    check("the natural floor-10 boss room holds a Marrow with skeleton kin",
      boss !== undefined && boss.kind === "marrow" && spawns.active.some((e) => e.kind === "skeleton"),
      boss ? `boss=${boss.kind}` : "no boss spawned");
  }

  section("Marrow: the opening line charge and its wall-crash stun");
  {
    const { w, p, boss } = marrowSetup(0xAD01);
    // Park the pair so the charge lane points into the east wall (wall face ~x=1584).
    boss.x = 1150; boss.y = 600;
    p.x = 1400; p.y = 600;
    // Entrance grace, then the first commitment is the line charge.
    let guard = 0;
    while (boss.attack.move !== "rush" && guard++ < 300) step(w, idle(w.tick + 1));
    check("the Marrow opens with the rush windup", boss.attack.move === "rush" && boss.attack.phase === "windup");
    stepFor(w, MARROW.chargeWindup + 0.05);
    // Step out of the lane: the charge runs into the east wall.
    p.x = 900; p.y = 300;
    const ev: SimEvent[] = [];
    stepFor(w, 1.2, ev);
    check("the missed charge crashes and stuns", ev.some((x) => x.t === "chargeCrash")
      && boss.attack.move === "crash" && boss.attack.phase === "recover");
    check("P1 crash bursts no shard ring yet (that is P2+)", w.bullets.every((b) => b.friendly));
    check("the crash stun is a real punish window", MARROW.crashStun >= 1.5, `${MARROW.crashStun}s`);
  }

  section("Marrow: bone-shard volley");
  {
    const { w, boss } = marrowSetup(0xAD02);
    let guard = 0;
    while (boss.attack.move !== "volley" && guard++ < 600) step(w, idle(w.tick + 1));
    check("the second commitment alternates to the volley", boss.attack.move === "volley");
    // Count the fan on its release tick (shards start flying — and dying — immediately).
    let released = false;
    let shards = 0;
    for (let i = 0; i < Math.round((MARROW.volleyWindup + 0.2) / DT) && !released; i++) {
      const out = step(w, idle(w.tick + 1));
      if (out.some((x) => x.t === "bossVolley")) {
        released = true;
        shards = w.bullets.filter((b) => !b.friendly).length;
      }
    }
    check("P1 volley releases a 3-shard fan", released && shards === MARROW.volleyShards[1], `shards=${shards}`);
  }

  section("Marrow: shield transition — floors, husks, interactive early break");
  {
    const { w, boss } = marrowSetup(0xAD03);
    stepFor(w, 0.2);
    const ev: SimEvent[] = [];
    // A precise center hit (small radius: it must not clip the husks spawning 50px out).
    plantBullet(w, boss.x, boss.y, 1e6);
    stepFor(w, 0.1, ev);
    const enter = ev.find((x) => x.t === "bossTransition" && x.entering);
    check("a million-damage hit floors the Marrow at 57%", Math.abs(boss.hp - MARROW.phaseFloor[0] * boss.maxHp) < 1e-6,
      `hp=${boss.hp}/${boss.maxHp}`);
    check("the overflow is queued and the shield beat raised", enter !== undefined && boss.attack.move === "shield");
    const husks = w.enemies.filter((e) => e.isSummoned && e.kind === "skeleton" && !e.dead);
    check("two swarm-skeleton husks anchor the shield", husks.length === MARROW.shieldHusks
      && husks.every((h) => h.tier === "swarm"));

    // Kill both husks right after the minimum readable beat: the shield breaks EARLY, and
    // the queued overflow lands — here it double-crosses 30% too, raising beat two.
    stepFor(w, MARROW.shieldMinDuration, ev);
    check("the shield holds through its minimum beat while husks stand", boss.attack.move === "shield");
    for (const h of husks) plantBullet(w, h.x, h.y, 999, 2); // tiny radius: executes the husk, never splashes the boss
    const beforeBreak = ev.filter((x) => x.t === "bossTransition" && !x.entering).length;
    stepFor(w, 0.3, ev);
    const exits = ev.filter((x) => x.t === "bossTransition" && !x.entering).length;
    check("killing both husks collapses the beat well before its 2.6s cap (overflow lands at the break)",
      exits > beforeBreak && boss.boss !== null && boss.boss.phase === 3
      && MARROW.shieldMinDuration + 0.4 < MARROW.shieldDuration,
      `beat ended ~${(MARROW.shieldMinDuration + 0.3).toFixed(1)}s in; phase=${boss.boss?.phase}`);
  }
  {
    // The same break in isolation: a threshold cross WITHOUT overflow — the early husk
    // kill releases the Marrow straight back into the fight, still in phase 2.
    const { w, boss } = marrowSetup(0xAD06);
    stepFor(w, 0.2);
    plantBullet(w, boss.x, boss.y, boss.maxHp * 0.4);
    stepFor(w, 0.1);
    check("a clean 65% cross shields without queueing", boss.attack.move === "shield"
      && Math.abs(boss.hp - 0.6 * boss.maxHp) < 1);
    stepFor(w, MARROW.shieldMinDuration);
    for (const h of w.enemies.filter((e) => e.isSummoned && !e.dead)) plantBullet(w, h.x, h.y, 999, 2);
    stepFor(w, 0.3);
    check("the interactive break returns it to the fight early (no queued damage, phase 2)",
      boss.attack.move !== "shield" && boss.boss !== null && boss.boss.phase === 2 && !boss.dead,
      `move=${boss.attack.move} phase=${boss.boss?.phase}`);
  }
  {
    // Ignoring the husks: the beat holds for its full cap, then the queued overflow lands
    // (it immediately crosses the second threshold — the double-cross resolves as two beats).
    const { w, boss } = marrowSetup(0xAD04);
    stepFor(w, 0.2);
    plantBullet(w, boss.x, boss.y, 1e6, 40);
    let dead = false;
    let ticks = 0;
    while (!dead && ticks < 60 * 12) {
      const out = step(w, idle(w.tick + 1));
      if (out.some((x) => x.t === "enemyKill" && x.kind === "marrow")) dead = true;
      ticks++;
    }
    const seconds = ticks * DT;
    check("an extreme burst still rides out BOTH full shield beats before the kill",
      dead && seconds >= 2 * MARROW.shieldDuration,
      `death at ${seconds.toFixed(2)}s (beats cap at ${MARROW.shieldDuration}s each)`);
    check("Marrow death ends danger: husks despawn, floor clears, boss chest drops",
      isFloorCleared(w) && w.chests.some((c) => c.kind === "boss"));
  }

  section("Marrow: P3 spiral barrage");
  {
    const { w, boss } = marrowSetup(0xAD05);
    stepFor(w, 0.2);
    // Drive it to P3 through both beats (queued overflow crosses 65% then 30%).
    plantBullet(w, boss.x, boss.y, boss.maxHp * 0.75, 40);
    stepFor(w, MARROW.shieldDuration + 0.2);
    stepFor(w, MARROW.shieldDuration + 0.2);
    check("both transitions resolved into phase 3", boss.boss !== null && boss.boss.phase === 3, `phase=${boss.boss?.phase}`);
    let guard = 0;
    while (boss.attack.move !== "spin" && guard++ < 60 * 15 && !boss.dead) step(w, idle(w.tick + 1));
    check("every 3rd P3 attack winds up the spiral", boss.attack.move === "spin", `guard=${guard}`);
    stepFor(w, MARROW.spinWindup + 0.05);
    const before = w.bullets.filter((b) => !b.friendly).length;
    stepFor(w, MARROW.spinDuration);
    const fired = boss.boss !== null ? boss.boss.spinCount * 2 : 0;
    check("the spiral emits rotating shard pairs across its whole active window",
      fired >= 16 && w.bullets.filter((b) => !b.friendly).length > before,
      `${fired} shards over ${MARROW.spinDuration}s`);
  }
}

// ---- the weapons: Thumper (AoE mortar) and Swallow (returning boomerang) ----

function weaponTests(): void {
  section("Thumper: one shell converts a pack into a blast (and chains barrels)");
  {
    const { w, p } = arena(0x1107);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "mortar");
    // A pack: three tough slimes bunched at the shell's landing zone, a barrel alongside.
    const pack = [
      spawnReady(w, "slime", 920, 580),
      spawnReady(w, "slime", 950, 610),
      spawnReady(w, "slime", 900, 630),
    ];
    for (const s of pack) s.hp = s.maxHp = 50;
    devSpawnProp(w, "barrel_explosive", 940, 560);
    const ev: SimEvent[] = [];
    // One trigger pull toward the pack (life 0.6 x speed 380 lands the shell ~230px out).
    step(w, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false });
    stepFor(w, 1.0, ev);
    check("the shell detonated (explosion event)", ev.some((x) => x.t === "explosion"));
    check("every slime in the pack took blast damage from ONE shell", pack.every((s) => s.hp < 50),
      pack.map((s) => s.hp).join("/"));
    check("the blast chains the explosive barrel", w.props.every((pr) => pr.kind !== "barrel_explosive" || pr.dead));
    check("the blast never hurts the thrower (a verb, not a hazard)", p.hp === p.maxHp);
  }
  {
    // A shell into the wall bursts ON the wall face instead of vanishing.
    const { w, p } = arena(0x1108);
    p.x = 1450; p.y = 600; // ~85px from the east wall: the shell hits it mid-flight
    acquireWeaponInWorld(w, LOCAL_ID, "mortar");
    const ev: SimEvent[] = [];
    step(w, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false });
    stepFor(w, 0.6, ev);
    check("a wall impact detonates the shell (no dud bulletWall)", ev.some((x) => x.t === "explosion")
      && !ev.some((x) => x.t === "bulletWall"));
  }

  section("Swallow: the line, twice — outbound and return passes");
  {
    const { w, p } = arena(0x5A11);
    p.x = 800; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "boomerang");
    const e = spawnReady(w, "slime", 950, 600);
    e.hp = e.maxHp = 50;
    step(w, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false });
    stepFor(w, 0.3);
    const afterOut = e.hp;
    check("the outbound pass hits once", afterOut < 50 && afterOut > 50 - 2 * WEAPONS.boomerang.damage,
      `hp=${afterOut}`);
    stepFor(w, 1.2);
    check("the return pass hits the same body again", e.hp < afterOut, `hp=${e.hp}`);
    check("the blade returned to the hand and despawned", w.bullets.length === 0, `bullets=${w.bullets.length}`);
  }
  {
    // A wall clink turns the blade instead of killing it.
    const { w, p } = arena(0x5A12);
    p.x = 1480; p.y = 600; // the east wall is inside the outbound leg
    acquireWeaponInWorld(w, LOCAL_ID, "boomerang");
    const ev: SimEvent[] = [];
    step(w, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false });
    stepFor(w, 1.2, ev);
    check("the wall clink turns the blade (bounce, not death)", ev.some((x) => x.t === "bulletBounce"));
    check("the turned blade still made it home", w.bullets.length === 0);
  }
  check("both new weapons sit in the pickup pool", PICKUP_WEAPONS.includes("mortar") && PICKUP_WEAPONS.includes("boomerang"));
}

// ---- roster integration ----

function rosterTests(): void {
  section("roster: the new enemies join the §4 floor plan");
  {
    // Across seeds, deep floors should actually field chargers and burrowers.
    let sawCharger = false, sawBurrower = false;
    for (let i = 0; i < 12 && !(sawCharger && sawBurrower); i++) {
      const seed = 0xF00 + i * 131;
      for (const floor of [4, 6, 7]) {
        const d = generateDungeon(seed, floor);
        const spawns = spawnFloorEnemies(d, seed, floor);
        for (const e of [...spawns.active, ...spawns.pending]) {
          if (e.kind === "charger") sawCharger = true;
          if (e.kind === "burrower") sawBurrower = true;
        }
      }
    }
    check("floor plans field chargers and burrowers", sawCharger && sawBurrower,
      `charger=${sawCharger} burrower=${sawBurrower}`);
  }
  check("charger/burrower are complex (threat 1.5) so the room-readability guards apply",
    ENEMY_ARCHETYPES.charger.threat === 1.5 && ENEMY_ARCHETYPES.burrower.threat === 1.5);
  check("neither new enemy appears before its intro floor",
    (() => {
      for (let i = 0; i < 8; i++) {
        const seed = 0xABC + i * 977;
        for (const floor of [1, 2, 3]) {
          const d = generateDungeon(seed, floor);
          const spawns = spawnFloorEnemies(d, seed, floor);
          for (const e of [...spawns.active, ...spawns.pending]) {
            if (e.kind === "burrower") return false;
            if (e.kind === "charger" && floor < 3) return false;
          }
        }
      }
      return true;
    })());
}

// Long-run stability on REAL generated floors: the new enemies dive/charge/crash around
// real geometry (walls, props, flow-field corners) for sim-minutes without the world going
// bad (every position stays finite, no enemy escapes the dungeon bounds).
function stabilityTests(): void {
  section("stability: new content on real generated floors");
  for (const floor of [4, 7, 10]) {
    const w = createWorld(0xD1CE + floor, floor);
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    let ok = true;
    for (let t = 0; t < 60 * 25 && ok; t++) {
      // A pacing bot: strafe in a loop and fire outward so bullets/blasts fly too.
      const angle = (t / 60) * 1.3;
      step(w, { seq: t, moveX: Math.cos(angle), moveY: Math.sin(angle), aim: angle, firing: t % 3 === 0, dash: t % 90 === 0 });
      for (const e of w.enemies) {
        if (!Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.hp)) ok = false;
        if (e.x < 0 || e.y < 0 || e.x > w.dungeon.w * TILE || e.y > w.dungeon.h * TILE) ok = false;
      }
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) ok = false;
    }
    check(`floor ${floor} runs 25 sim-seconds with every entity finite and in-bounds`, ok,
      `enemies=${w.enemies.length} pending=${w.pendingSpawns.length}`);
  }
}

function main(): void {
  chargerTests();
  burrowerTests();
  marrowTests();
  weaponTests();
  rosterTests();
  stabilityTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll content-wave assertions hold.\n");
}

main();
