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
import { createEnemy, spawnFloorEnemies, isBossKind, bossKindForFloor, ENEMY_ARCHETYPES, BOSS_KIN } from "../src/sim/enemies.js";
import { generateDungeon } from "../src/sim/dungeon.js";
import {
  MARROW, CHOIR, WEAVER, GILDED,
  marrowHpForFloor, choirHpForFloor, weaverHpForFloor, gildedHpForFloor,
} from "../src/sim/balance.js";
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

// `passedThrough` marks bodies this round has already struck (hitList), so a planted
// execution can slip past a boss standing over its target — the same state a real pierce
// round leaves behind.
function plantBullet(w: WorldState, x: number, y: number, damage: number, radius = 12, passedThrough: Enemy[] | null = null): void {
  const b: Bullet = {
    x, y, vx: 1, vy: 0, radius, life: 0.05, friendly: true, owner: LOCAL_ID,
    damage, color: "#fff", pierce: 0, hitList: passedThrough, isCrit: false,
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
  check("marrow is a boss kind (chest/interest/death machinery)", isBossKind("marrow") && !isBossKind("charger"));
  check("F10 Marrow HP matches its calibration anchor", marrowHpForFloor(10) === MARROW.baseHp, `hp=${marrowHpForFloor(10)}`);
  {
    // Find a seed whose F10 rolls MARROW, then confirm the natural floor spawns it with
    // its skeleton kin (the seeded deep roster is covered in its own section).
    let seed = 0;
    for (let s = 1; s < 200 && seed === 0; s++) {
      if (bossKindForFloor(s, 10) === "marrow") seed = s;
    }
    check("some seed rolls MARROW on floor 10", seed !== 0, `seed=${seed}`);
    const d = generateDungeon(seed, 10);
    const spawns = spawnFloorEnemies(d, seed, 10);
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
    // Execute the husks one per tick (they converge while chasing — simultaneous tiny
    // rounds could spend themselves on the same overlapping body).
    const beforeBreak = ev.filter((x) => x.t === "bossTransition" && !x.entering).length;
    for (const h of husks) {
      // A tiny round that already passed through the boss: husks converge on/behind its
      // body, and a spent round must never be soaked by the wrong target.
      plantBullet(w, h.x, h.y, 999, 2, [boss]);
      stepFor(w, 0.05, ev);
    }
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
    for (const h of w.enemies.filter((e) => e.isSummoned && !e.dead)) {
      plantBullet(w, h.x, h.y, 999, 2, [boss]);
      stepFor(w, 0.05);
    }
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

// ---- the orbiter: ring strafe + stop-to-fire ----

function orbiterTests(): void {
  section("orbiter: holds the ring, stops to fire");
  {
    const { w, p } = arena(0x0B17);
    p.x = 840; p.y = 600;
    const e = spawnReady(w, "orbiter", 840 + C.ORBITER_RING, 600);
    e.attack.cooldown = 3; // hold fire so the ring behavior is isolated first
    let minD = Infinity, maxD = -Infinity;
    for (let t = 0; t < 90; t++) {
      step(w, idle(w.tick + 1));
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      minD = Math.min(minD, d); maxD = Math.max(maxD, d);
    }
    check("it strafes the ring without collapsing in or fleeing out",
      minD > C.ORBITER_RING - C.ORBITER_RING_SLACK * 2.2 && maxD < C.ORBITER_RING + C.ORBITER_RING_SLACK * 2.2,
      `ring ${minD.toFixed(0)}–${maxD.toFixed(0)}px around ${C.ORBITER_RING}`);
    // Sideways coverage: it should sweep a real arc around the player, not sit still.
    e.attack.cooldown = 3;
    const a0 = Math.atan2(e.y - p.y, e.x - p.x);
    for (let t = 0; t < 60; t++) step(w, idle(w.tick + 1));
    const a1 = Math.atan2(e.y - p.y, e.x - p.x);
    let swept = Math.abs(a1 - a0);
    if (swept > Math.PI) swept = 2 * Math.PI - swept;
    check("the strafe sweeps a real arc around the target", swept > 0.35, `${swept.toFixed(2)} rad in 1s`);
  }
  {
    const { w, p } = arena(0x0B18);
    p.x = 840; p.y = 600;
    const e = spawnReady(w, "orbiter", 840 + C.ORBITER_RING, 600);
    let guard = 0;
    while (e.attack.move !== "spit" && guard++ < 300) step(w, idle(w.tick + 1));
    check("in-ring orbiter telegraphs its bolt", e.attack.move === "spit" && e.attack.phase === "windup");
    const x0 = e.x, y0 = e.y;
    stepFor(w, C.ORBITER_WINDUP * 0.8);
    check("the windup is stationary (stillness is the tell)", Math.hypot(e.x - x0, e.y - y0) < 2);
    stepFor(w, C.ORBITER_WINDUP * 0.3);
    check("the bolt is away and the orbiter recovers", w.bullets.some((b) => !b.friendly) && e.attack.phase === "recover");
  }
}

// ---- the shielder: the walking wall ----

function shielderTests(): void {
  section("shielder: front arc eats bullets; flanks, melee and blasts do not");
  {
    const { w, p } = arena(0x51E1);
    p.x = 700; p.y = 600;
    const e = spawnReady(w, "shielder", 900, 600);
    stepFor(w, 0.15); // let it face its chase direction (west, toward the player)
    const hp0 = e.hp;
    // A frontal shot: flies east, into the guard.
    w.bullets.push({ x: 830, y: 600, vx: 400, vy: 0, radius: 5, life: 1, friendly: true, owner: LOCAL_ID, damage: 3, color: "#fff", pierce: 0, hitList: null, isCrit: false });
    const ev: SimEvent[] = [];
    stepFor(w, 0.3, ev);
    check("the frontal round is absorbed (blocked event, no damage, round spent)",
      e.hp === hp0 && ev.some((x) => x.t === "bulletBlocked") && !w.bullets.some((b) => b.friendly));
    // The flank: a shot from behind connects.
    w.bullets.push({ x: e.x + 60, y: e.y, vx: -400, vy: 0, radius: 5, life: 1, friendly: true, owner: LOCAL_ID, damage: 3, color: "#fff", pierce: 0, hitList: null, isCrit: false });
    stepFor(w, 0.3);
    check("the flank shot lands full damage", e.hp === hp0 - 3, `hp ${hp0} -> ${e.hp}`);
  }
  {
    const { w, p } = arena(0x51E2);
    p.x = 760; p.y = 600;
    const e = spawnReady(w, "shielder", 812, 600); // inside sword reach (48 + its radius)
    e.attack.cooldown = 5; // hold the bash so the swing test is isolated
    stepFor(w, 0.1);
    const hp0 = e.hp;
    // Melee chops over the guard.
    acquireWeaponInWorld(w, LOCAL_ID, "sword");
    step(w, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false });
    stepFor(w, 0.25);
    check("melee ignores the guard entirely", e.hp < hp0, `hp ${hp0} -> ${e.hp}`);
  }
  {
    const { w, p } = arena(0x51E3);
    p.x = 700; p.y = 600;
    const e = spawnReady(w, "shielder", 940, 600);
    e.hp = e.maxHp = 40;
    stepFor(w, 0.15);
    acquireWeaponInWorld(w, LOCAL_ID, "mortar");
    step(w, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false });
    stepFor(w, 0.8);
    check("a mortar blast splashes straight past the guard", e.hp < 40, `hp=${e.hp}`);
  }
  {
    // The boomerang: an outbound blade thrown into the guard clinks off it into an early
    // return — spent against THIS body, but never lost like a plain bullet.
    const { w, p } = arena(0x51E4);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "boomerang");
    const e = spawnReady(w, "shielder", 880, 600);
    e.attack.cooldown = 9; // hold the bash: the guard geometry is what's under test
    e.hp = e.maxHp = 40;
    stepFor(w, 0.15);
    const ev: SimEvent[] = [];
    step(w, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false });
    stepFor(w, 1.2, ev);
    // The guard eats the outbound pass; the TURNED blade leaves past its back, where the
    // flank rule applies — so at most the single return slice ever lands.
    check("the outbound blade clinks off the guard (never a full punch-through)",
      ev.some((x) => x.t === "bulletBlocked") && e.hp >= 40 - WEAPONS.boomerang.damage,
      `hp=${e.hp}`);
    check("the clinked blade still came home (turned, not eaten)", w.bullets.length === 0);
  }
}

// ---- THE HOLLOW CHOIR ----

function choirSetup(seed: number): { w: WorldState; p: PlayerSim; boss: Enemy } {
  const w = createWorld(seed, 10, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 0;
  const boss = devSpawnEnemy(w, "choir", p.x + 220, p.y);
  return { w, p, boss };
}

function choirTests(): void {
  section("Hollow Choir: identity + anchors");
  check("choir is a boss kind", isBossKind("choir"));
  check("F10 Choir HP matches its calibration anchor", choirHpForFloor(10) === CHOIR.baseHp, `hp=${choirHpForFloor(10)}`);

  section("Hollow Choir: homing wails you juke by turning");
  {
    const { w, p, boss } = choirSetup(0xC401);
    let guard = 0;
    while (boss.attack.move !== "wail" && guard++ < 600) step(w, idle(w.tick + 1));
    check("the Choir telegraphs the wail volley", boss.attack.move === "wail" && boss.attack.phase === "windup");
    let released = false;
    let wails = 0;
    for (let i = 0; i < Math.round((CHOIR.wailWindup + 0.2) / DT) && !released; i++) {
      const out = step(w, idle(w.tick + 1));
      if (out.some((x) => x.t === "bossVolley")) {
        released = true;
        wails = w.bullets.filter((b) => !b.friendly && b.homing !== undefined).length;
      }
    }
    check("P1 releases a 2-wail volley of seekers", released && wails === CHOIR.wailCount[1], `wails=${wails}`);
    // The homing: move the player sideways; the wail's velocity must bend toward them.
    const wail = w.bullets.find((b) => !b.friendly && b.homing !== undefined);
    check("a wail exists to track", wail !== undefined);
    if (wail) {
      p.x = boss.x - 60; p.y = boss.y + 260;
      const dir0 = Math.atan2(wail.vy, wail.vx);
      stepFor(w, 0.5);
      const dir1 = Math.atan2(wail.vy, wail.vx);
      check("the wail bends toward the standing player (capped turn)", Math.abs(dir1 - dir0) > 0.2,
        `turned ${(dir1 - dir0).toFixed(2)} rad`);
    }
  }

  section("Hollow Choir: the fade — intangible, drifting, punishable on re-form");
  {
    const { w, p, boss } = choirSetup(0xC402);
    let guard = 0;
    while (!(boss.attack.move === "fade" && boss.attack.phase === "active") && guard++ < 1200) step(w, idle(w.tick + 1));
    check("the Choir fades on cadence", guard < 1200);
    const hp0 = boss.hp;
    plantBullet(w, boss.x, boss.y, 99);
    stepFor(w, 0.1);
    check("mid-fade it cannot be hit", boss.hp === hp0);
    const d0 = Math.hypot(p.x - boss.x, p.y - boss.y);
    stepFor(w, 0.6);
    const d1 = Math.hypot(p.x - boss.x, p.y - boss.y);
    check("the fade drifts through your position (keep moving)", d1 < d0 + 1, `${d0.toFixed(0)} -> ${d1.toFixed(0)}px`);
    stepFor(w, CHOIR.fadeDuration);
    check("it re-forms into a punishable recover", boss.attack.phase === "recover");
    const hp1 = boss.hp;
    plantBullet(w, boss.x, boss.y, 5);
    stepFor(w, 0.1);
    check("the re-formed Choir takes hits again", boss.hp === hp1 - 5);
  }

  section("Hollow Choir: the split beat — kill the wisps to force it back together");
  {
    const { w, boss } = choirSetup(0xC403);
    stepFor(w, 0.2);
    plantBullet(w, boss.x, boss.y, 1e6);
    stepFor(w, 0.1);
    check("a million-damage hit floors the Choir at 57%", Math.abs(boss.hp - CHOIR.phaseFloor[0] * boss.maxHp) < 1e-6,
      `hp=${boss.hp}/${boss.maxHp}`);
    check("the Choir scatters (split beat, boss out of play)", boss.attack.move === "split");
    const wisps = w.enemies.filter((e) => e.isSummoned && e.kind === "ghost" && !e.dead);
    check("three swarm ghost-wisps carry the beat", wisps.length === CHOIR.splitWisps && wisps.every((x) => x.tier === "swarm"));
    const hpMid = boss.hp;
    plantBullet(w, boss.x, boss.y, 500);
    stepFor(w, 0.1);
    check("the scattered Choir itself cannot be damaged", boss.hp === hpMid);
    stepFor(w, CHOIR.splitMinDuration);
    for (const wsp of wisps) {
      plantBullet(w, wsp.x, wsp.y, 999, 2);
      stepFor(w, 0.05);
    }
    stepFor(w, 0.3);
    // The overflow lands at the early re-form and double-crosses 30% — beat two begins
    // immediately with FRESH wisps (the machine resolved beat one well under its cap).
    const wisps2 = w.enemies.filter((e) => e.isSummoned && e.kind === "ghost" && !e.dead);
    check("killing every wisp re-forms it early (overflow lands: phase 3, fresh beat)",
      boss.boss !== null && boss.boss.phase === 3 && wisps2.length === CHOIR.splitWisps
      && wisps2.every((x) => wisps.indexOf(x) === -1),
      `phase=${boss.boss?.phase} wisps=${wisps2.length}`);
  }
}

// ---- THE WEAVER ----

function weaverSetup(seed: number): { w: WorldState; p: PlayerSim; boss: Enemy } {
  const w = createWorld(seed, 10, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 0;
  const boss = devSpawnEnemy(w, "weaver", p.x + 220, p.y);
  return { w, p, boss };
}

function weaverTests(): void {
  section("Weaver: identity + anchors");
  check("weaver is a boss kind", isBossKind("weaver"));
  check("F10 Weaver HP matches its calibration anchor", weaverHpForFloor(10) === WEAVER.baseHp, `hp=${weaverHpForFloor(10)}`);

  section("Weaver: webs — persistent slow-zones, never damage");
  {
    const { w, p, boss } = weaverSetup(0x3EA1);
    let guard = 0;
    while (boss.attack.move !== "weave" && guard++ < 900 && !boss.dead) step(w, idle(w.tick + 1));
    check("the Weaver telegraphs the weave", boss.attack.move === "weave");
    const websBefore = w.hazards.length;
    stepFor(w, WEAVER.weaveWindup + 0.1);
    check("the weave plants its P1 web pattern", w.hazards.length === websBefore + WEAVER.webCount[1],
      `webs=${w.hazards.length - websBefore}`);
    const web = w.hazards[w.hazards.length - 1];
    check("webs are authored hazards with a real lifetime", web.kind === "web" && web.life > WEAVER.webLife - 1);
    // The slow: walk the player through the web center and measure the stride.
    w.isGodMode = false;
    const hp0 = p.hp;
    p.invuln = 999; // webs must not damage on their own; enemy contact stays out of the reading
    p.x = web.x; p.y = web.y;
    const x0 = p.x;
    for (let t = 0; t < 30; t++) step(w, { seq: w.tick + 1, moveX: 1, moveY: 0, aim: 0, firing: false, dash: false });
    const snared = p.x - x0;
    p.x = 200; p.y = 200; // clear floor far from any web
    const x1 = p.x;
    for (let t = 0; t < 30; t++) step(w, { seq: w.tick + 1, moveX: 1, moveY: 0, aim: 0, firing: false, dash: false });
    const free = p.x - x1;
    check("a web slows the walk to ~55%", snared < free * (WEAVER.webSlow + 0.12) && snared > free * (WEAVER.webSlow - 0.12),
      `${snared.toFixed(0)}px vs ${free.toFixed(0)}px`);
    check("webs never damage (routing pressure only)", p.hp === hp0);
  }

  section("Weaver: the pounce — marked, airborne, web at the crater");
  {
    const { w, p, boss } = weaverSetup(0x3EA2);
    let guard = 0;
    while (boss.attack.move !== "pounce" && guard++ < 900 && !boss.dead) step(w, idle(w.tick + 1));
    check("the Weaver telegraphs the pounce", boss.attack.move === "pounce" && boss.attack.phase === "windup");
    stepFor(w, WEAVER.pounceLock + 0.05);
    const markX = boss.attack.markX, markY = boss.attack.markY;
    check("the mark locks on the target's position", Math.hypot(markX - p.x, markY - p.y) < 40);
    stepFor(w, WEAVER.pounceWindup - WEAVER.pounceLock);
    // Airborne now: untargetable, lerping onto the mark.
    const hpAir = boss.hp;
    plantBullet(w, boss.x, boss.y, 99);
    stepFor(w, 0.1);
    check("the airborne Weaver cannot be shot", boss.hp === hpAir);
    const websBefore = w.hazards.length;
    p.x = markX + 200; p.y = markY; // step off the mark
    p.invuln = 0;
    stepFor(w, WEAVER.pounceAir + 0.1);
    check("it lands ON the mark and leaves a web at the crater",
      Math.hypot(boss.x - markX, boss.y - markY) < 30 && w.hazards.length === websBefore + 1);
    check("stepping off the mark dodges the landing", p.hp === p.maxHp);
  }
  {
    // The landing hits when you hold your ground.
    const { w, p, boss } = weaverSetup(0x3EA3);
    let guard = 0;
    while (!(boss.attack.move === "pounce" && boss.attack.phase === "active") && guard++ < 900 && !boss.dead) {
      step(w, idle(w.tick + 1));
      p.invuln = 0;
    }
    w.isGodMode = false;
    p.invuln = 0;
    const hp0 = p.hp;
    p.x = boss.attack.markX; p.y = boss.attack.markY;
    stepFor(w, WEAVER.pounceAir + 0.1);
    check("holding the mark eats the landing hit", p.hp <= hp0 - WEAVER.pounceOuterDamage, `hp ${hp0} -> ${p.hp}`);
  }

  section("Weaver: the molt beat — fixed cocoon, web-bolt ring, broodlings");
  {
    const { w, boss } = weaverSetup(0x3EA4);
    stepFor(w, 0.2);
    const ev: SimEvent[] = [];
    plantBullet(w, boss.x, boss.y, boss.maxHp * 0.4);
    stepFor(w, 0.15, ev);
    check("a 65% cross raises the molt (roar semantics)", boss.attack.move === "roar");
    const brood = w.enemies.filter((e) => e.isSummoned && e.kind === "bat" && !e.dead);
    check("two swarm broodling bats spawn with the beat", brood.length === WEAVER.moltAdds && brood.every((x) => x.tier === "swarm"));
    const shotsBefore = w.bullets.filter((b) => !b.friendly).length;
    stepFor(w, WEAVER.moltDuration + 0.1, ev);
    const shotsAfter = w.bullets.filter((b) => !b.friendly).length;
    check("the molt bursts into the web-bolt ring on exit",
      shotsAfter >= shotsBefore + WEAVER.moltBoltCount - 2 && boss.boss !== null && boss.boss.phase === 2,
      `bolts=${shotsAfter - shotsBefore} phase=${boss.boss?.phase}`);
  }
}

// ---- THE GILDED WARDEN ----

function gildedSetup(seed: number): { w: WorldState; p: PlayerSim; boss: Enemy } {
  const w = createWorld(seed, 10, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 0;
  const boss = devSpawnEnemy(w, "gilded", p.x + 200, p.y);
  return { w, p, boss };
}

function gildedTests(): void {
  section("Gilded Warden: identity + anchors");
  check("gilded is a boss kind", isBossKind("gilded"));
  check("F10 Warden HP matches its calibration anchor", gildedHpForFloor(10) === GILDED.baseHp, `hp=${gildedHpForFloor(10)}`);

  section("Gilded Warden: the plate — chip while closed, full while EXPOSED");
  {
    const { w, boss } = gildedSetup(0x91D1);
    stepFor(w, 0.2);
    const hp0 = boss.hp;
    plantBullet(w, boss.x, boss.y, 10);
    stepFor(w, 0.1);
    check("closed plate chips a 10 hit to 3", Math.abs(hp0 - boss.hp - 10 * GILDED.armorChip) < 1e-6,
      `took ${(hp0 - boss.hp).toFixed(1)}`);
    // Ride to the exposed window: after the slam resolves it recovers, plate open.
    let guard = 0;
    while (!(boss.attack.phase === "recover" && (boss.attack.move === "slam" || boss.attack.move === "sweep")) && guard++ < 900) {
      step(w, idle(w.tick + 1));
    }
    check("the commitment resolves into the exposed recover", guard < 900, `move=${boss.attack.move}`);
    const hp1 = boss.hp;
    plantBullet(w, boss.x, boss.y, 10);
    stepFor(w, 0.1);
    check("the EXPOSED window takes the full 10", Math.abs(hp1 - boss.hp - 10) < 1e-6, `took ${(hp1 - boss.hp).toFixed(1)}`);
    check("the exposed window is long enough to matter", GILDED.slamRecover >= 2 && GILDED.sweepRecover >= 2);
  }

  section("Gilded Warden: quake marker + aftershock line; P3 double sweep");
  {
    const { w, p, boss } = gildedSetup(0x91D2);
    let guard = 0;
    while (boss.attack.move !== "slam" && guard++ < 900) step(w, idle(w.tick + 1));
    check("the Warden telegraphs the anvil slam", boss.attack.move === "slam" && boss.attack.phase === "windup");
    stepFor(w, 0.1);
    check("the quake is marked on its own feet", Math.hypot(boss.attack.markX - boss.x, boss.attack.markY - boss.y) < 4);
    // Hold inside the ring (outside the body, inside the 66px inner radius): it connects.
    w.isGodMode = false;
    p.x = boss.x + GILDED.slamInnerRadius - 5; p.y = boss.y;
    p.invuln = 0;
    const hp0 = p.hp;
    stepFor(w, GILDED.slamWindup + GILDED.slamActive + 0.1);
    check("standing in the ring eats a slam hit", p.hp < hp0, `hp ${hp0} -> ${p.hp}`);
    check("the aftershock line is away", w.bullets.filter((b) => !b.friendly).length >= GILDED.slamLineShards);
  }
  {
    const { w, boss } = gildedSetup(0x91D3);
    stepFor(w, 0.2);
    // Drive to P3 through both sanctify beats (the closed plate chips the hit, so it
    // must be heavy enough to cross 70% at 30% effect).
    plantBullet(w, boss.x, boss.y, boss.maxHp * 3);
    stepFor(w, GILDED.sanctifyDuration + 0.2);
    stepFor(w, GILDED.sanctifyDuration + 0.2);
    check("both sanctify beats resolve into phase 3", boss.boss !== null && boss.boss.phase === 3, `phase=${boss.boss?.phase}`);
    let guard = 0;
    while (boss.attack.move !== "sweep" && guard++ < 900 && !boss.dead) step(w, idle(w.tick + 1));
    // Ride the whole commitment (windup + active) and count everything it released.
    const before = w.bullets.filter((b) => !b.friendly).length;
    guard = 0;
    while (boss.attack.move === "sweep" && boss.attack.phase !== "recover" && guard++ < 300) step(w, idle(w.tick + 1));
    const released = w.bullets.filter((b) => !b.friendly).length - before;
    check("the P3 sweep releases both offset waves", released >= GILDED.sweepCount * 2 - 2,
      `released=${released} (2 waves of ${GILDED.sweepCount})`);
  }
}

// ---- the boss ladder: seeded rotation ----

function rotationTests(): void {
  section("boss ladder: F5 is the King; deeper floors rotate the seeded roster");
  {
    let f5Ok = true;
    for (let s = 0; s < 40; s++) {
      if (bossKindForFloor(0xAAA + s * 131, 5) !== "boss") f5Ok = false;
    }
    check("floor 5 is ALWAYS the Slime King (the telegraph tutor)", f5Ok);
  }
  {
    // Determinism + variety + no immediate repeats across the ladder.
    const seen = new Set<EnemyKind>();
    let deterministic = true;
    let noRepeats = true;
    for (let s = 0; s < 60; s++) {
      const seed = 0x5EED + s * 977;
      let prev: EnemyKind | null = null;
      for (let floor = 10; floor <= 40; floor += 5) {
        const a = bossKindForFloor(seed, floor);
        if (a !== bossKindForFloor(seed, floor)) deterministic = false;
        if (prev !== null && a === prev) noRepeats = false;
        seen.add(a);
        prev = a;
      }
    }
    check("the pick is a pure function of (seed, floor)", deterministic);
    check("no boss repeats back-to-back within a run", noRepeats);
    check("all five bosses appear across seeds", seen.size === 5, [...seen].join(","));
  }
  {
    // Every deep boss floor spawns its boss with the matching kin.
    let kinOk = true;
    for (let s = 0; s < 6; s++) {
      const seed = 0xFACE + s * 313;
      const d = generateDungeon(seed, 10);
      const spawns = spawnFloorEnemies(d, seed, 10);
      const boss = spawns.active.find((e) => isBossKind(e.kind));
      if (!boss) { kinOk = false; break; }
      const minions = spawns.active.filter((e) => !isBossKind(e.kind));
      if (minions.length === 0 || !minions.every((m) => m.kind === BOSS_KIN[boss.kind])) kinOk = false;
    }
    check("each deep floor spawns the rolled boss with its own kin", kinOk);
  }
}

// ---- the authored boss chests ----

function bossChestTests(): void {
  section("boss chests: each boss bakes its signature weapon");
  const expected: Array<[EnemyKind, string]> = [
    ["boss", "mortar"], ["marrow", "boomerang"], ["choir", "beam"], ["weaver", "vortex"], ["gilded", "cannon"],
  ];
  for (const [kind, weapon] of expected) {
    const w = createWorld(0xC4E57 ^ kind.length, 10, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, kind, p.x + 150, p.y);
    for (let t = 1; t <= 60 * 20 && !boss.dead; t++) {
      plantBullet(w, boss.x, boss.y, 5000, 30);
      step(w, idle(w.tick + 1));
    }
    const chest = w.chests.find((c) => c.kind === "boss");
    check(`${kind} chest carries ${weapon}`, boss.dead && chest !== undefined && chest.weapon === weapon,
      chest ? `weapon=${chest.weapon}` : "no chest");
  }
}

// ---- the weapons: Sunlance (beam) and Undertow (vortex) ----

function beamVortexTests(): void {
  section("Sunlance: a sustained melt with a hard range edge");
  {
    const { w, p } = arena(0x5311);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "beam");
    const near = spawnReady(w, "slime", 1050, 600); // ~350px: inside the ~480px lance
    near.hp = near.maxHp = 30;
    const start = w.tick;
    while (!near.dead && w.tick - start < 60 * 4) {
      step(w, { seq: w.tick + 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false });
    }
    const seconds = (w.tick - start) * DT;
    check("the lance melts a 30 HP body in a sustained hold (~2s)", near.dead && seconds > 1 && seconds < 3.2,
      `${seconds.toFixed(2)}s`);
  }
  {
    const { w, p } = arena(0x5312);
    p.x = TILE * 3; p.y = 600; // west side, room for a 700px lane
    acquireWeaponInWorld(w, LOCAL_ID, "beam");
    const far = spawnReady(w, "slime", p.x + 700, 600); // beyond the ~480px range
    far.hp = far.maxHp = 10;
    for (let t = 0; t < 90; t++) step(w, { seq: w.tick + 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false });
    check("beyond the lance's reach nothing lands (range is the trade)", far.hp === 10);
  }

  section("Undertow: gathers a scattered room into one clump");
  {
    const { w, p } = arena(0x5313);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "vortex");
    // Two flankers off the orb's line, one body dead ahead on its path.
    const a = spawnReady(w, "slime", 940, 510);
    const b = spawnReady(w, "slime", 940, 690);
    const c = spawnReady(w, "slime", 900, 600);
    a.hp = a.maxHp = 40; b.hp = b.maxHp = 40; c.hp = c.maxHp = 40;
    const gap0 = Math.hypot(a.x - b.x, a.y - b.y);
    step(w, { seq: 1, moveX: 0, moveY: 0, aim: 0, firing: true, dash: false });
    stepFor(w, 1.3);
    const gap1 = Math.hypot(a.x - b.x, a.y - b.y);
    check("the orb drags the flankers together", gap1 < gap0 - 60, `${gap0.toFixed(0)} -> ${gap1.toFixed(0)}px`);
    check("a body on the orb's path is tapped once (pass-through)",
      c.hp < 40 && c.hp >= 40 - WEAPONS.vortex.damage - 1, `c=${c.hp}`);
  }
  check("beam and vortex sit in the pickup pool", PICKUP_WEAPONS.includes("beam") && PICKUP_WEAPONS.includes("vortex"));
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
  orbiterTests();
  shielderTests();
  marrowTests();
  choirTests();
  weaverTests();
  gildedTests();
  rotationTests();
  bossChestTests();
  weaponTests();
  beamVortexTests();
  rosterTests();
  stabilityTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll content-wave assertions hold.\n");
}

main();
