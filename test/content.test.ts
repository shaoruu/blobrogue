// Content-wave sim assertions: the new regular enemies (charger, burrower, orbiter,
// shielder), the boss roster (MARROW, Hollow Choir, Weaver, Gilded Warden) and the new
// weapons (Thumper mortar, Sunlance beam), all exercised headlessly on the pure sim —
// behavior grammar, telegraphs, untargetable windows, phase machinery, weapon room-verbs.
//
// Run: npm run test:content

import {
  createWorld, stepWorld, devSpawnEnemy, devSpawnProp, devSpawnChest, acquireWeaponInWorld, isFloorCleared,
  bossChestWeaponFor, removePlayerFromWorld,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, Enemy, EnemyKind, WeaponId } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import {
  createEnemy, spawnFloorEnemies, isBossKind, bossKindForFloor, ENEMY_ARCHETYPES, BOSS_KIN,
  isGauntletFloor, isBossFloor, encounterDeckForFloor, FAMILY_INTRO_FLOOR,
} from "../src/sim/enemies.js";
import { generateDungeon } from "../src/sim/dungeon.js";
import {
  MARROW, CHOIR, WEAVER, GILDED, GAUNTLET, KING_REWARD_TABLE, bossWeaponChoices,
  marrowHpForFloor, choirHpForFloor, weaverHpForFloor, gildedHpForFloor, bossHpForFloor,
} from "../src/sim/balance.js";
import { WEAPONS, PICKUP_WEAPONS } from "../src/sim/weapons.js";
import { weaponDisplayStats } from "../src/sim/weaponStats.js";
import { createMods } from "../src/sim/items.js";
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
  check("F15 Marrow HP matches its calibration anchor", marrowHpForFloor(15) === MARROW.baseHp, `hp=${marrowHpForFloor(15)}`);
  {
    // The curriculum chain slots MARROW at F15: the natural floor spawns it with its
    // skeleton kin for every seed.
    const seed = 7;
    check("floor 15 is ALWAYS Marrow (curriculum chain)", bossKindForFloor(seed, 15) === "marrow");
    const d = generateDungeon(seed, 15);
    const spawns = spawnFloorEnemies(d, seed, 15);
    const boss = spawns.active.find((e) => isBossKind(e.kind));
    check("the natural floor-15 boss room holds a Marrow with skeleton kin",
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
    check("the crash stun is the corrected 1.6s punish window", MARROW.crashStun === 1.6, `${MARROW.crashStun}s`);
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
    // Earned windows: MARROW is GUARDED outside its baited crash — the drive must pay
    // the chip to land 40% real damage.
    plantBullet(w, boss.x, boss.y, (boss.maxHp * 0.4) / MARROW.guardMult);
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
    // Drive it to P3 through both beats (queued overflow crosses 65% then 30%); the
    // guarded chip applies before the threshold machinery, so the drive pays it.
    plantBullet(w, boss.x, boss.y, (boss.maxHp * 0.75) / MARROW.guardMult, 40);
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
  check("F30 Choir HP matches its calibration anchor", choirHpForFloor(30) === CHOIR.baseHp, `hp=${choirHpForFloor(30)}`);

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
    check("the re-formed Choir takes hits again (guarded chip — the window is the verse silence)",
      Math.abs(boss.hp - (hp1 - 5 * CHOIR.guardMult)) < 1e-6);
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
  check("F20 Weaver HP matches its calibration anchor", weaverHpForFloor(20) === WEAVER.baseHp, `hp=${weaverHpForFloor(20)}`);

  section("Weaver: lanes — sticky silk partitions, never damage; the dash clears them");
  {
    const { w, p, boss } = weaverSetup(0x3EA1);
    let guard = 0;
    while (boss.attack.move !== "weave" && guard++ < 900 && !boss.dead) step(w, idle(w.tick + 1));
    check("the Weaver telegraphs the weave", boss.attack.move === "weave");
    stepFor(w, WEAVER.weaveWindup + 0.1);
    const knots = w.enemies.filter((e) => !e.dead && e.kind === "knot");
    const silk = w.hazards.filter((h) => h.kind === "web");
    check("the weave strings a knot-anchored silk LANE (the arena partition)",
      knots.length === WEAVER.knotsFor[1] && silk.length >= 3,
      `knots=${knots.length} silk=${silk.length}`);
    const web = silk[silk.length - 1];
    check("silk rows are authored hazards with a real lifetime", web.kind === "web" && web.life > WEAVER.webLife - 1);
    // The sticky slow: walk the player through the silk and measure the stride.
    w.isGodMode = false;
    const hp0 = p.hp;
    p.invuln = 999; // silk must not damage on its own; enemy contact stays out of the reading
    p.x = web.x; p.y = web.y;
    const x0 = p.x;
    for (let t = 0; t < 30; t++) step(w, { seq: w.tick + 1, moveX: 1, moveY: 0, aim: 0, firing: false, dash: false });
    const snared = p.x - x0;
    p.x = 200; p.y = 200; // clear floor far from any web
    const x1 = p.x;
    for (let t = 0; t < 30; t++) step(w, { seq: w.tick + 1, moveX: 1, moveY: 0, aim: 0, firing: false, dash: false });
    const free = p.x - x1;
    check("sticky silk slows the walk to the designer's ×0.5", snared < free * (WEAVER.webSlow + 0.12) && snared > free * (WEAVER.webSlow - 0.12),
      `${snared.toFixed(0)}px vs ${free.toFixed(0)}px`);
    check("silk never damages (routing pressure only)", p.hp === hp0);
    // The dash clears the silk it crosses — at the dash's own cost.
    const target = w.hazards.find((h) => h.kind === "web")!;
    p.x = target.x - 30; p.y = target.y;
    p.dashCd = 0;
    step(w, { seq: w.tick + 1, moveX: 1, moveY: 0, aim: 0, firing: false, dash: true });
    stepFor(w, 0.2);
    check("a dash through the silk CLEARS it (the dash is the cost)",
      !w.hazards.some((h) => h === target), `websNow=${w.hazards.filter((h) => h.kind === "web").length}`);
  }

  section("Weaver: the descent — marked, airborne, the shared pounce read");
  {
    // Force her off the walls (P2 climb + broken clutch) and eat the landing when
    // holding the mark; dodge it by stepping off.
    const { w, p, boss } = weaverSetup(0x3EA2);
    stepFor(w, 0.2);
    plantBullet(w, boss.x, boss.y, (boss.maxHp * 0.37) / WEAVER.guardMult);
    stepFor(w, WEAVER.moltDuration + 0.3);
    check("into P2 for the climb kit", boss.boss !== null && boss.boss.phase === 2);
    let guard = 0;
    while (!(boss.attack.move === "dive" && boss.attack.phase === "active") && guard++ < 1200 && !boss.dead) {
      step(w, idle(w.tick + 1));
    }
    check("she climbs (dive grammar) and cannot be shot", (() => {
      const hpUp = boss.hp;
      plantBullet(w, boss.x, boss.y, 99);
      stepFor(w, 0.1);
      return boss.hp === hpUp;
    })());
    // Burst the clutch as it blooms: the forced descent commits a marked pounce.
    guard = 0;
    while (boss.attack.move !== "pounce" && guard++ < 60 * 20 && !boss.dead) {
      for (const sac of w.enemies) {
        if (!sac.dead && sac.kind === "sac") plantBullet(w, sac.x, sac.y, 500, 14);
      }
      step(w, idle(w.tick + 1));
    }
    check("the broken clutch forces the marked descent", boss.attack.move === "pounce",
      `move=${boss.attack.move}`);
    const markX = boss.attack.markX, markY = boss.attack.markY;
    p.x = markX + 200; p.y = markY; // step off the mark
    p.invuln = 0;
    w.isGodMode = false;
    stepFor(w, WEAVER.descendTell + WEAVER.descendAir + 0.1);
    check("she lands ON the mark, forced into the crash window",
      Math.hypot(boss.x - markX, boss.y - markY) < 30 && boss.attack.move === "crash",
      `d=${Math.hypot(boss.x - markX, boss.y - markY).toFixed(0)} move=${boss.attack.move}`);
    check("stepping off the mark dodges the landing", p.hp === p.maxHp);
  }

  section("Weaver: the molt beat — fixed cocoon, web-bolt ring, broodlings");
  {
    const { w, boss } = weaverSetup(0x3EA4);
    stepFor(w, 0.2);
    const ev: SimEvent[] = [];
    plantBullet(w, boss.x, boss.y, (boss.maxHp * 0.4) / WEAVER.guardMult);
    stepFor(w, 0.15, ev);
    check("a 66% cross raises the molt (roar semantics)", boss.attack.move === "roar");
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
  check("F25 Warden HP matches its calibration anchor", gildedHpForFloor(25) === GILDED.baseHp, `hp=${gildedHpForFloor(25)}`);

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

// ---- the encounter curriculum: cadence, deck, family intros, the F10 gauntlet ----

function curriculumTests(): void {
  section("corrected gate §2: the authored roster cadence (F1 slime -> F7 shielder)");
  {
    check("the corrected cadence table holds (bat/skeleton/spitter F2, ghost/charger F3, burrower F4, orbiter F6, shielder F7)",
      FAMILY_INTRO_FLOOR.slime === 1 && FAMILY_INTRO_FLOOR.bat === 2 && FAMILY_INTRO_FLOOR.skeleton === 2
      && FAMILY_INTRO_FLOOR.spitter === 2 && FAMILY_INTRO_FLOOR.ghost === 3 && FAMILY_INTRO_FLOOR.charger === 3
      && FAMILY_INTRO_FLOOR.burrower === 4 && FAMILY_INTRO_FLOOR.orbiter === 6 && FAMILY_INTRO_FLOOR.shielder === 7);
    // The plans respect the cadence live: no kind spawns before its intro floor, and F1
    // fields slimes only (the gate's teach floor).
    let introOk = true;
    let f1Ok = true;
    for (let i = 0; i < 10 && introOk; i++) {
      const seed = 0xC0DE + i * 4241;
      for (let floor = 1; floor <= 9 && introOk; floor++) {
        if (isBossFloor(floor)) continue;
        const d = generateDungeon(seed, floor);
        const spawns = spawnFloorEnemies(d, seed, floor);
        for (const e of [...spawns.active, ...spawns.pending]) {
          if (floor < (FAMILY_INTRO_FLOOR[e.kind] ?? 0)) introOk = false;
          if (floor === 1 && e.kind !== "slime") f1Ok = false;
        }
      }
    }
    check("no family ever spawns before its intro floor (10 seeds × F1–9)", introOk);
    check("floor 1 fields slimes only (the teach floor)", f1Ok);
  }

  section("curriculum §4: the deterministic anti-repeat encounter deck");
  {
    let deterministic = true;
    let noRepeat = true;
    let runOk = true;
    let quotaOk = true;
    let breatherOk = true;
    const isSimple = (c: string): boolean => c === "breather" || c === "pack" || c === "hunt";
    for (let i = 0; i < 24; i++) {
      const seed = 0xDECC + i * 769;
      for (let floor = 2; floor <= 24; floor++) {
        if (isBossFloor(floor)) continue;
        const a = encounterDeckForFloor(seed, floor, 5);
        const b = encounterDeckForFloor(seed, floor, 5);
        if (a.join() !== b.join()) deterministic = false;
        let run = 0;
        for (let k = 0; k < a.length; k++) {
          if (k > 0 && a[k] === a[k - 1]) noRepeat = false;
          run = isSimple(a[k]) ? 0 : run + 1;
          if (run > 2) runOk = false;
        }
        if (a.filter(isSimple).length < Math.ceil(a.length * 0.35)) quotaOk = false;
        if (floor > 1 && isBossFloor(floor - 1) && a[0] !== "breather") breatherOk = false;
      }
    }
    check("the deck is a pure function of (seed, floor, rooms)", deterministic);
    check("an exact card never repeats back-to-back (shuffle-bag anti-repetition)", noRepeat);
    check("never more than two complex cards consecutively", runOk);
    check("every floor keeps ≥35% simple/mastery rooms (envelope share)", quotaOk);
    check("the first room after a milestone floor is the authored breather", breatherOk);
  }

  section("corrected gate §3 F10: the sequential captain gauntlet");
  {
    const w = createWorld(0xF10A, 10);
    w.isGodMode = true;
    check("the F10 world arms the gauntlet machine", w.gauntlet !== null && w.gauntlet.stage === 0);
    check("the arena starts without a boss (non-boss milestone)", w.enemies.every((e) => !isBossKind(e.kind)));

    const entrances: Array<{ kind: EnemyKind; tier: string; at: number; maxHp: number }> = [];
    let lastClearAt = 0;
    let wasAnyAlive = false;
    const gaps: number[] = [];
    let maxCaptains = 0;
    let heartAtRoundThree = false;
    let clearedEarly = false;
    let sawTransition = false;
    for (let t = 0; t < 60 * 90 && !isFloorCleared(w); t++) {
      for (const e of w.enemies) {
        if (!e.dead) plantBullet(w, e.x, e.y, e.captainPhase !== undefined ? 60 : 5000, 18);
      }
      const evs = step(w, idle(t + 1));
      for (const e of evs) {
        if (e.t === "enemySpawn") {
          const spawned = w.enemies.find((x) => x.id === e.eid)!;
          if (spawned.captainPhase !== undefined) {
            gaps.push(t * DT - lastClearAt);
            entrances.push({ kind: spawned.kind, tier: spawned.tier, at: t * DT, maxHp: spawned.maxHp });
            if (entrances.length === 3) heartAtRoundThree = w.pickups.some((k) => k.kind === "heart");
          }
        }
        if (e.t === "bossPhase") sawTransition = true;
      }
      const anyAlive = w.enemies.some((e) => !e.dead);
      if (wasAnyAlive && !anyAlive) lastClearAt = t * DT;
      wasAnyAlive = anyAlive;
      const captains = w.enemies.filter((e) => !e.dead && e.captainPhase !== undefined).length;
      maxCaptains = Math.max(maxCaptains, captains);
      if (isFloorCleared(w) && w.gauntlet !== null && !w.gauntlet.isRewarded) clearedEarly = true;
    }
    check("the gauntlet stages the corrected sequence (Charger commander -> Shielder elite -> brute Burrower)",
      entrances.map((e) => `${e.kind}/${e.tier}`).join(" ") === "charger/elite shielder/elite burrower/brute",
      entrances.map((e) => `${e.kind}/${e.tier}`).join(" "));
    check("captains are NEVER simultaneous", maxCaptains === 1, `max=${maxCaptains}`);
    check("R2/R3 wait the authored 5s intermission after the prior full clear",
      gaps.length === 3 && gaps.slice(1).every((g) => g >= GAUNTLET.intermission - 2 * DT),
      gaps.map((g) => g.toFixed(2)).join(","));
    check("captain HP is the gate formula: 350 / 400 / 500 (round10 of .28/.32/.40 × Marrow)",
      entrances.map((e) => e.maxHp).join(",") === "350,400,500", entrances.map((e) => e.maxHp).join(","));
    check("every captain walks its 50% two-phase transition (logged, non-invulnerable)", sawTransition);
    check("the +1 heart lands only after round 2 clears", heartAtRoundThree);
    check("the floor never reads cleared before the sequence resolves", !clearedEarly);
    check("the final clear drops the premium boss chest with the gauntlet signature",
      isFloorCleared(w) && w.chests.some((c) => c.kind === "boss" && c.weapon === GAUNTLET.chestWeapon));

    // The premium chest behaves like every boss chest: the min(max(3,P+1),5) personal
    // choices + rare offer.
    const chest = w.chests.find((c) => c.kind === "boss")!;
    const p = w.players.get(LOCAL_ID)!;
    p.x = chest.x; p.y = chest.y;
    const evs = step(w, idle(9999));
    check("opening it raises the rare blessing offer and the boss choice set (no blessing before the full clear)",
      evs.some((e) => e.t === "offerBlessing" && e.rare)
      && w.pickups.filter((k) => k.isBossChoice).length === bossWeaponChoices(1)
      && w.pickups.some((k) => k.isBossChoice && k.weapon === GAUNTLET.chestWeapon));
  }

  section("corrected gate §3: the captain two-phase contract (no floor, non-invulnerable)");
  {
    const w = createWorld(0xF10C, 10, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const captain = devSpawnEnemy(w, "charger", p.x + 200, p.y);
    captain.hp = captain.maxHp = 350;
    captain.captainPhase = 1;
    // Chip to just above the split, then land a huge hit: no floor may catch it.
    plantBullet(w, captain.x, captain.y, 170, 18);
    stepFor(w, 0.1);
    check("the captain holds phase 1 above 50%", captain.captainPhase === 1 && captain.hp > 350 * 0.5);
    const ev: SimEvent[] = [];
    plantBullet(w, captain.x, captain.y, 10, 18);
    stepFor(w, 0.1, ev);
    check("crossing 50% flips phase 2 with ONE logged transition",
      captain.captainPhase === 2 && ev.some((x) => x.t === "bossPhase"));
    const hp0 = captain.hp;
    plantBullet(w, captain.x, captain.y, 50, 18);
    stepFor(w, 0.1);
    check("the 0.8s transition is non-invulnerable (full damage lands through it)",
      Math.abs(hp0 - captain.hp - 50) < 1e-6, `took ${(hp0 - captain.hp).toFixed(1)}`);
    const fresh = devSpawnEnemy(w, "charger", p.x + 400, p.y);
    fresh.hp = fresh.maxHp = 350;
    fresh.captainPhase = 1;
    plantBullet(w, fresh.x, fresh.y, 1e6, 18);
    stepFor(w, 0.1);
    check("no phase floor: a single huge hit carries straight through 50% to the kill", fresh.dead);
  }
}

// ---- the boss ladder: seeded rotation ----

function rotationTests(): void {
  section("the curriculum chain: King F5 / Gauntlet F10 / Marrow F15 / Weaver F20 / Warden F25 / Choir F30");
  {
    // Curriculum §0 (FINAL): the first-clear chain is locked for every seed.
    const ladder: Array<[number, EnemyKind | null]> = [
      [5, "boss"], [10, null], [15, "marrow"], [20, "weaver"], [25, "gilded"], [30, "choir"],
    ];
    let authoredOk = true;
    for (let s = 0; s < 40; s++) {
      for (const [floor, kind] of ladder) {
        if (bossKindForFloor(0xAAA + s * 131, floor) !== kind) authoredOk = false;
      }
    }
    check("the locked first-clear chain holds for every seed (F10 is the gauntlet, not a boss)", authoredOk);
    check("F10 is the authored Miniboss Gauntlet floor", isGauntletFloor(10) && !isGauntletFloor(15));
  }
  {
    // Beyond the authored chain (F35+ endgame): seeded, deterministic, varied, no
    // immediate repeats — including the F30 Choir finale boundary.
    const seen = new Set<EnemyKind>();
    let deterministic = true;
    let noRepeats = true;
    for (let s = 0; s < 60; s++) {
      const seed = 0x5EED + s * 977;
      let prev: EnemyKind | null = "choir";
      for (let floor = 35; floor <= 65; floor += 5) {
        const a = bossKindForFloor(seed, floor);
        if (a !== bossKindForFloor(seed, floor)) deterministic = false;
        if (a === null || a === prev) noRepeats = false;
        if (a !== null) seen.add(a);
        prev = a;
      }
    }
    check("the deep pick is a pure function of (seed, floor)", deterministic);
    check("no boss repeats back-to-back deep (nor against the F30 finale)", noRepeats);
    check("all five bosses appear across deep seeds", seen.size === 5, [...seen].join(","));
  }
  {
    // Every authored boss floor spawns its boss with the matching kin.
    let kinOk = true;
    for (const floor of [15, 20, 25, 30]) {
      const seed = 0xFACE + floor * 313;
      const d = generateDungeon(seed, floor);
      const spawns = spawnFloorEnemies(d, seed, floor);
      const boss = spawns.active.find((e) => isBossKind(e.kind));
      if (!boss) { kinOk = false; break; }
      const minions = spawns.active.filter((e) => !isBossKind(e.kind));
      if (minions.length === 0 || !minions.every((m) => m.kind === BOSS_KIN[boss.kind])) kinOk = false;
    }
    check("each authored boss floor spawns its boss with its own kin", kinOk);
  }
}

// ---- the authored boss chests ----

function bossChestTests(): void {
  section("boss chests: deep bosses bake their signature; the King rolls a seeded preference");
  // Deep bosses keep their single authored signature. The King's chest is the run's first
  // boss reward and rolls a seeded weighted preference (KING_REWARD_TABLE, mortar most
  // likely) so the post-boss gun varies run to run — pinned via bossChestWeaponFor.
  const expected: Array<[EnemyKind, string | null]> = [
    ["boss", null], ["marrow", "railgun"], ["choir", "beam"], ["weaver", "tesla"], ["gilded", "cannon"],
  ];
  for (const [kind, weapon] of expected) {
    const seed = 0xC4E57 ^ kind.length;
    const w = createWorld(seed, 10, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, kind, p.x + 150, p.y);

    for (let t = 1; t <= 60 * 20 && !boss.dead; t++) {
      plantBullet(w, boss.x, boss.y, 5000, 30);
      step(w, idle(w.tick + 1));
    }
    const chest = w.chests.find((c) => c.kind === "boss");
    const want = weapon ?? bossChestWeaponFor(seed, 10, kind);
    check(`${kind} chest carries ${want}`, boss.dead && chest !== undefined && chest.weapon === want,
      chest ? `weapon=${chest.weapon}` : "no chest");
  }
  check("the King's seeded preference always lands inside its authored table",
    [0x1, 0x22, 0x333, 0x4444, 0x55555].every((s) =>
      KING_REWARD_TABLE.some((row) => row.weapon === bossChestWeaponFor(s, 5, "boss"))));
}

// ---- the weapon: Sunlance (beam) ----

function beamTests(): void {
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

  check("the Sunlance sits in the pickup pool", PICKUP_WEAPONS.includes("beam"));
}

// ---- the weapon: Thumper (AoE mortar) ----

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

  check("the Thumper sits in the pickup pool", PICKUP_WEAPONS.includes("mortar"));
}

// ---- the effect wave: seven room verbs on four shared primitives ----

const fireCmd = (w: WorldState, aim = 0): InputCmd =>
  ({ seq: w.tick + 1, moveX: 0, moveY: 0, aim, firing: true, dash: false });

function stepFiring(w: WorldState, seconds: number, ev?: SimEvent[], aim = 0): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const out = step(w, fireCmd(w, aim));
    if (ev) ev.push(...out);
  }
}

function lastlightTests(): void {
  section("Lastlight: trade safety for a kill window (damage scales with missing HP)");
  {
    const { w, p } = arena(0x1A57);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "lastlight");
    const dummy = spawnReady(w, "slime", 850, 600);
    dummy.hp = dummy.maxHp = 100;
    dummy.speed = 0; // parked: the test isolates the risk curve, not the chase
    // Full HP: one shot, measure the bite (waiting out the full fire cooldown).
    step(w, fireCmd(w));
    stepFor(w, 0.6);
    const fullHpDmg = 100 - dummy.hp;
    // One heart left: same shot, far bigger bite.
    dummy.hp = 100;
    p.hp = 1;
    step(w, fireCmd(w));
    stepFor(w, 0.6);
    const lowHpDmg = 100 - dummy.hp;
    check("a full-health shot lands the base slug", fullHpDmg > 2 && fullHpDmg < 4, `dmg=${fullHpDmg.toFixed(1)}`);
    check("a one-heart shot lands ~2.8x harder (the risk curve)", lowHpDmg > fullHpDmg * 2.2 && lowHpDmg < fullHpDmg * 3.2,
      `full=${fullHpDmg.toFixed(1)} low=${lowHpDmg.toFixed(1)}`);
  }
}

function breachTests(): void {
  section("Breach: hold charges the landing point; the shell sails OVER the pack");
  {
    const { w, p } = arena(0xB4EA);
    p.x = 500; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "breach");
    const near = spawnReady(w, "slime", 660, 600);  // 160px out: under the shell's arc
    const far = spawnReady(w, "slime", 930, 600);   // ~430px out: at the full-charge landing
    near.hp = near.maxHp = 40;
    far.hp = far.maxHp = 40;
    near.speed = 0;
    far.speed = 0;
    // Hold the full charge, then release (firing false) and let the shell fly.
    stepFiring(w, 1.0);
    check("holding the trigger charges without firing", p.chargeT > 0.85 && w.bullets.length === 0,
      `chargeT=${p.chargeT.toFixed(2)}`);
    const ev: SimEvent[] = [];
    stepFor(w, 1.2, ev);
    check("release detonates at the charged landing point", ev.some((x) => x.t === "explosion"));
    check("the shell sailed OVER the near body (artillery, not contact)", near.hp === 40, `near=${near.hp}`);
    check("the far anchor took the blast", far.hp < 40, `far=${far.hp}`);
  }
  {
    // Tap: minimum charge lands close.
    const { w, p } = arena(0xB4EB);
    p.x = 500; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "breach");
    const near = spawnReady(w, "slime", 650, 600); // ~150px: at the tap landing distance
    near.hp = near.maxHp = 40;
    near.speed = 0;
    step(w, fireCmd(w)); // one held tick
    const ev: SimEvent[] = [];
    stepFor(w, 1.0, ev);
    check("a tap lobs to the minimum distance and still detonates", ev.some((x) => x.t === "explosion") && near.hp < 40,
      `near=${near.hp}`);
  }
  {
    // Charging slows the walk (the exposure tradeoff) — the dash still rips free.
    const { w, p } = arena(0xB4EC);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "breach");
    step(w, fireCmd(w)); // prime the charge
    const x0 = p.x;
    for (let i = 0; i < 30; i++) step(w, { seq: w.tick + 1, moveX: 1, moveY: 0, aim: 0, firing: true, dash: false });
    const charged = p.x - x0;
    p.chargeT = 0;
    const x1 = p.x;
    for (let i = 0; i < 30; i++) step(w, { seq: w.tick + 1, moveX: 1, moveY: 0, aim: 0, firing: false, dash: false });
    const free = p.x - x1;
    check("holding the charge slows the walk", charged < free * 0.7, `charged=${charged.toFixed(0)} free=${free.toFixed(0)}`);
  }
}

function snapwireTests(): void {
  section("Snapwire: an armed line trap that holds the doorway");
  {
    const { w, p } = arena(0x54A1);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "snapwire");
    const ev: SimEvent[] = [];
    ev.push(...step(w, fireCmd(w)));
    const wire = w.effects.find((e) => e.kind === "wire");
    check("planting strings a wire along the aim", wire !== undefined && ev.some((x) => x.t === "wirePlanted"));
    check("the wire arms after a beat, never instantly", wire !== undefined && wire.kind === "wire" && wire.arm > 0.5);
    // A body crossing DURING the arm delay is safe (planting is never a point-blank hit).
    const early = spawnReady(w, "slime", 760, 600);
    early.hp = early.maxHp = 30;
    stepFor(w, 0.2, ev);
    check("crossing while arming does not trigger", early.hp === 30 && !ev.some((x) => x.t === "wireSnap"));
    // Once armed, the same body springs it: damage + the snap event, wire consumed.
    stepFor(w, 1.0, ev);
    check("the armed wire snaps on the crosser", ev.some((x) => x.t === "wireSnap") && early.hp < 30,
      `hp=${early.hp}`);
    check("a snapped wire is spent", !w.effects.some((e) => e.kind === "wire"));
  }
  {
    // The snap strikes EVERY body in the band, not just the tripper.
    const { w, p } = arena(0x54A2);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "snapwire");
    step(w, fireCmd(w));
    stepFor(w, 0.8); // arm it
    const a = spawnReady(w, "slime", 750, 600);
    const b = spawnReady(w, "slime", 790, 604);
    a.hp = a.maxHp = 30; b.hp = b.maxHp = 30;
    stepFor(w, 0.3);
    check("the snap catches every body touching the wire", a.hp < 30 && b.hp < 30, `${a.hp}/${b.hp}`);
  }
  {
    // The cap: planting past max retires the OLDEST wire; pellets buy more wires.
    const { w, p } = arena(0x54A3);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "snapwire");
    for (let i = 0; i < 5; i++) {
      step(w, fireCmd(w, (i / 5) * Math.PI * 2));
      stepFor(w, 0.7);
    }
    check("at most the authored 3 wires stand", w.effects.filter((e) => e.kind === "wire").length === 3,
      `wires=${w.effects.filter((e) => e.kind === "wire").length}`);
    p.mods.extraPellets = 2;
    for (let i = 0; i < 3; i++) {
      step(w, fireCmd(w, (i / 3) * Math.PI));
      stepFor(w, 0.7);
    }
    check("the pellets mod buys extra concurrent wires (authored cap 5)",
      w.effects.filter((e) => e.kind === "wire").length === 5);
  }
}

function frostlineTests(): void {
  section("Frostline: paint a chill lane that cuts the room in two");
  {
    const { w, p } = arena(0xF057);
    p.x = 500; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "frostline");
    stepFiring(w, 0.6);
    stepFor(w, 0.6);
    const zones = w.effects.filter((e) => e.kind === "zone");
    check("firing paints ground zones along the lane", zones.length >= 3, `zones=${zones.length}`);
    check("zones spread outward along the flight line", zones.some((z) => z.x > p.x + 100));
    // Park a body on the lane: chill soaks until it freezes solid.
    const camper = spawnReady(w, "skeleton", zones[Math.min(2, zones.length - 1)].x, 600);
    camper.hp = camper.maxHp = 60;
    stepFor(w, 1.4);
    check("a camper on the lane freezes solid (chill past the freeze point)", camper.chill >= C.FREEZE_AT,
      `chill=${camper.chill.toFixed(1)}`);
    // Zones thaw on their own.
    stepFor(w, 4.5);
    check("the lane thaws (zones expire)", !w.effects.some((e) => e.kind === "zone"));
  }
  {
    // The world zone cap holds under sustained painting.
    const { w, p } = arena(0xF058);
    p.x = 300; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "frostline");
    p.mods.bulletLifeMult = 3; // long-lived zones stack up fast
    stepFiring(w, 6);
    const zones = w.effects.filter((e) => e.kind === "zone").length;
    check(`sustained painting never exceeds the hard zone cap (${C.MAX_ZONE_EFFECTS})`, zones <= C.MAX_ZONE_EFFECTS,
      `zones=${zones}`);
  }
}

function haloTests(): void {
  section("Razor Halo: own your personal space (orbit blades + flare active)");
  {
    const { w, p } = arena(0x4A10);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "halo");
    step(w, idle(w.tick + 1));
    const orbit = w.effects.find((e) => e.kind === "orbit");
    check("equipping conjures the orbit ring (no trigger needed)", orbit !== undefined);
    // A body pressing into the resting ring gets shredded on a readable cadence.
    const presser = spawnReady(w, "slime", p.x + 46, p.y);
    presser.hp = presser.maxHp = 60;
    presser.speed = 0; // park it inside the ring
    const hp0 = presser.hp;
    stepFor(w, 0.3);
    const afterFirst = presser.hp;
    stepFor(w, 1.2);
    const afterMore = presser.hp;
    check("a body inside the ring takes contact damage", afterFirst < hp0);
    check("hits land on the re-hit cadence, not per tick", hp0 - afterFirst <= 3 && afterMore < afterFirst,
      `first=${(hp0 - afterFirst).toFixed(1)} total=${(hp0 - afterMore).toFixed(1)}`);
    // Switching away dismisses the ring.
    acquireWeaponInWorld(w, LOCAL_ID, "pistol");
    step(w, idle(w.tick + 1));
    check("switching weapons dismisses the ring", !w.effects.some((e) => e.kind === "orbit"));
  }
  {
    // The active: a flare reaches a body the resting ring cannot touch.
    const { w, p } = arena(0x4A11);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "halo");
    const standoff = spawnReady(w, "spitter", p.x + 88, p.y); // outside ring 46, inside flare 96
    standoff.hp = standoff.maxHp = 40;
    standoff.speed = 0;
    stepFor(w, 0.8);
    const beforeFlare = standoff.hp;
    step(w, fireCmd(w));
    stepFor(w, 0.6);
    check("the resting ring cannot reach a standoff body", beforeFlare === 40);
    check("the flare expands the ring onto it", standoff.hp < 40, `hp=${standoff.hp}`);
  }
  {
    // Pellets map to authored extra blades, hard-capped.
    const { w, p } = arena(0x4A12);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "halo");
    p.mods.extraPellets = 9;
    step(w, idle(w.tick + 1));
    const orbit = w.effects.find((e) => e.kind === "orbit");
    check("the pellets mod adds blades up to the authored cap (6)",
      orbit !== undefined && orbit.kind === "orbit" && orbit.blades === 6,
      orbit && orbit.kind === "orbit" ? `blades=${orbit.blades}` : "no orbit");
  }
}

function sentryTests(): void {
  section("Prism Sentry: hold a second lane (destructible, owner-attributed)");
  {
    const { w, p } = arena(0x5E27);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "sentry");
    const ev: SimEvent[] = [];
    ev.push(...step(w, fireCmd(w)));
    const s = w.effects.find((e) => e.kind === "sentry");
    check("firing deploys the turret a step ahead", s !== undefined && ev.some((x) => x.t === "sentryPlaced")
      && s !== undefined && Math.abs(s.x - (p.x + 40)) < 2);
    const mark = spawnReady(w, "slime", 880, 600);
    mark.hp = mark.maxHp = 12;
    mark.speed = 0;
    const kills0 = p.kills;
    stepFor(w, 5, ev);
    check("the sentry acquires and kills the lane body on its own", mark.dead,
      `hp=${mark.hp}`);
    check("the kill credits the DEPLOYER (owner attribution)", p.kills === kills0 + 1);
    check("bolts announce themselves (sentryShot events)", ev.some((x) => x.t === "sentryShot"));
  }
  {
    // Out of range / no LOS: the turret holds its fire.
    const { w, p } = arena(0x5E28);
    p.x = 400; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "sentry");
    step(w, fireCmd(w));
    spawnReady(w, "slime", 400 + 40 + 300, 600).speed = 0; // beyond the 240px range
    const ev: SimEvent[] = [];
    stepFor(w, 1.5, ev);
    check("a body beyond the acquire range draws no fire", !ev.some((x) => x.t === "sentryShot"));
  }
  {
    // Destructible: contact chews it down; redeploying moves the ONE turret.
    const { w, p } = arena(0x5E29);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "sentry");
    step(w, fireCmd(w));
    const s = w.effects.find((e) => e.kind === "sentry")!;
    const chewer = spawnReady(w, "slime", s.x + 10, s.y); // parked: chews on the contact cadence
    chewer.hp = chewer.maxHp = 500;
    chewer.speed = 0;
    chewer.kbResist = 1e9; // bolt knockback must not walk it out of contact mid-test
    const ev: SimEvent[] = [];
    stepFor(w, 6, ev);
    check("enemy contact destroys the turret", !w.effects.some((e) => e.kind === "sentry")
      && ev.some((x) => x.t === "sentryDown"));
    // Redeploy: exactly one turret ever stands per owner.
    stepFor(w, 0.3);
    step(w, fireCmd(w, Math.PI));
    stepFor(w, 0.1);
    step(w, fireCmd(w, 0));
    for (let i = 0; i < 80; i++) step(w, fireCmd(w, 0));
    check("redeploying moves the single turret (never a farm)",
      w.effects.filter((e) => e.kind === "sentry").length === 1);
  }
  {
    // Attribution contract: the deployer leaving never re-credits (and never crashes).
    const { w, p } = arena(0x5E2A);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "sentry");
    step(w, fireCmd(w));
    const mark = spawnReady(w, "slime", 880, 600);
    mark.hp = mark.maxHp = 8;
    mark.speed = 0;
    removePlayerFromWorld(w, LOCAL_ID);
    for (let i = 0; i < 60 * 5 && !mark.dead; i++) stepWorld(w, new Map(), DT);
    check("a departed deployer's sentry keeps firing and still kills (credits no one)", mark.dead);
  }
}

function crookTests(): void {
  section("Crooked Chain: reposition the threat (pull, hold, sweep — heavies pull YOU)");
  {
    const { w, p } = arena(0xC401);
    p.x = 600; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "crook");
    const mark = spawnReady(w, "spitter", 780, 600); // in the 210px latch lane
    mark.hp = mark.maxHp = 40;
    const ev: SimEvent[] = [];
    ev.push(...step(w, fireCmd(w)));
    check("the first press latches the tether", w.effects.some((e) => e.kind === "tether")
      && ev.some((x) => x.t === "tetherLatch" && x.eid >= 0));
    stepFor(w, 0.6, ev);
    const pulled = Math.hypot(mark.x - p.x, mark.y - p.y);
    check("a standard body is reeled to the owner's feet", pulled < 110, `dist=${pulled.toFixed(0)}`);
    // Second press: the sweep strikes the held body and releases the chain.
    ev.length = 0;
    ev.push(...step(w, fireCmd(w)));
    stepFor(w, 0.2, ev);
    check("the second press sweeps (damage + release)", ev.some((x) => x.t === "tetherSweep")
      && mark.hp < 40 && !w.effects.some((e) => e.kind === "tether"),
      `hp=${mark.hp}`);
  }
  {
    // The risk half: a brute inverts the pull — the OWNER travels.
    const { w, p } = arena(0xC402);
    p.x = 600; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "crook");
    const brute = spawnReady(w, "skeleton", 790, 600);
    brute.tier = "brute";
    brute.hp = brute.maxHp = 200;
    brute.speed = 0;
    const px0 = p.x, bx0 = brute.x;
    step(w, fireCmd(w));
    stepFor(w, 0.5);
    check("a brute drags the OWNER in (the enemy holds its ground)",
      p.x - px0 > 60 && Math.abs(brute.x - bx0) < 30,
      `player+${(p.x - px0).toFixed(0)} brute+${(brute.x - bx0).toFixed(0)}`);
  }
  {
    // A whiffed lash costs the cooldown and reads out loud.
    const { w, p } = arena(0xC403);
    p.x = 600; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "crook");
    const ev: SimEvent[] = [];
    ev.push(...step(w, fireCmd(w)));
    check("a whiff raises the miss lash (eid -1) and no tether", ev.some((x) => x.t === "tetherLatch" && x.eid === -1)
      && !w.effects.some((e) => e.kind === "tether"));
  }
}

// Universal modifiers must map coherently onto the non-projectile archetypes.
function effectModsTests(): void {
  section("effect wave: universal mods map coherently (size/life/speed/pellets/status/crit)");
  {
    // size -> footprint: a doubled bulletSizeMult doubles the painted zone radius.
    const { w, p } = arena(0x30D1);
    p.x = 500; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "frostline");
    p.mods.bulletSizeMult = 2;
    stepFiring(w, 0.4);
    const zone = w.effects.find((e) => e.kind === "zone");
    check("size maps to zone footprint", zone !== undefined && zone.kind === "zone" && Math.abs(zone.radius - 52) < 1,
      zone && zone.kind === "zone" ? `r=${zone.radius}` : "none");
  }
  {
    // life -> duration; speed -> arm time (wires).
    const { w, p } = arena(0x30D2);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "snapwire");
    p.mods.bulletLifeMult = 2;
    p.mods.bulletSpeedMult = 2;
    step(w, fireCmd(w));
    const wire = w.effects.find((e) => e.kind === "wire");
    check("life maps to wire duration, speed to a faster arm",
      wire !== undefined && wire.kind === "wire" && wire.maxLife > 20 && wire.arm < 0.4,
      wire && wire.kind === "wire" ? `life=${wire.maxLife.toFixed(1)} arm=${wire.arm.toFixed(2)}` : "none");
  }
  {
    // speed -> orbit angular speed.
    const { w, p } = arena(0x30D3);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "halo");
    p.mods.bulletSpeedMult = 1.5;
    step(w, idle(w.tick + 1));
    const orbit = w.effects.find((e) => e.kind === "orbit");
    check("speed maps to orbit speed", orbit !== undefined && orbit.kind === "orbit" && Math.abs(orbit.speed - 5.4) < 0.01);
  }
  {
    // status blessings roll on authored damage events (a wire snap shocks with Static Charge).
    const { w, p } = arena(0x30D4);
    p.x = 700; p.y = 600;
    acquireWeaponInWorld(w, LOCAL_ID, "snapwire");
    p.mods.shockChance = 1;
    p.mods.critChance = 1;
    step(w, fireCmd(w));
    stepFor(w, 0.8);
    const mark = spawnReady(w, "slime", 760, 600);
    mark.hp = mark.maxHp = 60;
    const ev: SimEvent[] = [];
    stepFor(w, 0.3, ev);
    const hit = ev.find((x): x is Extract<SimEvent, { t: "enemyHit" }> => x.t === "enemyHit");
    check("a snapped body rolls the blessing statuses", mark.shock > 0, `shock=${mark.shock.toFixed(1)}`);
    check("a snap can crit (crit rides the authored damage event)", hit !== undefined && hit.crit);
  }
}

// Canonical tooltips: every weapon (incl. the effect wave) flows through the ONE shared
// weaponDisplayStats model (#46) — role verb, banded stats, and technique lines derived
// from canonical WeaponDef fields, never a bespoke second copy.
function tooltipTests(): void {
  section("tooltips: the shared weaponDisplayStats model covers every weapon");
  const allIds = Object.keys(WEAPONS) as Array<keyof typeof WEAPONS>;
  const base = createMods();
  check("every weapon resolves a role + banded core stats through the shared model",
    allIds.every((id) => {
      const c = weaponDisplayStats(id, base, 0);
      return c.role.length > 0 && c.impact.band.length > 0 && c.cadence.band.length > 0 && c.reach.band.length > 0;
    }));
  const wave: WeaponId[] = ["lastlight", "breach", "snapwire", "frostline", "halo", "sentry", "crook"];
  check("every effect-wave weapon carries at least one technique/tradeoff line",
    wave.every((id) => weaponDisplayStats(id, base, 0).mechanics.length >= 1));
  const wireCard = weaponDisplayStats("snapwire", base, 0);
  check("the trap reads as a TRAP (coverage) with an armed-wire mechanic, no pellet pattern",
    wireCard.coverage.kind === "TRAP" && wireCard.mechanics.some((mech) => mech.tag === "WIRE"));
  const breachCard = weaponDisplayStats("breach", base, 0);
  check("the charge lob reads as ARTILLERY with a charge mechanic",
    breachCard.coverage.kind === "ARTILLERY" && breachCard.mechanics.some((mech) => mech.tag === "CHARGE"));
  check("distinct room jobs read distinct role verbs", new Set(wave.map((id) => weaponDisplayStats(id, base, 0).role)).size >= 6);
  check("all seven sit in the pickup pool", wave.every((id) => PICKUP_WEAPONS.includes(id)));
}

// ---- roster integration ----

function rosterTests(): void {
  section("roster: the new enemies join the §4 floor plan");
  {
    // Across seeds, mid floors should actually field chargers and burrowers.
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
  // The bestiary balance envelope reprices the complex verbs at 2.0 (superseding the
  // corrected gate's in-flight 1.5 — see ENVELOPE.threatCost in balance.ts).
  check("charger/burrower carry the envelope's complex 2.0 threat cost",
    ENEMY_ARCHETYPES.charger.threat === 2.0 && ENEMY_ARCHETYPES.burrower.threat === 2.0);
  check("neither new enemy appears before its corrected intro floor (charger F3, burrower F4)",
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

// ---- enemy -> environment destruction (authoritative, ownerless) ----

function environmentTests(): void {
  section("environment: a charger's rush splinters the furniture in its lane");
  {
    const { w, p } = arena(0xE0B1);
    p.x = 1000; p.y = 600;
    const e = spawnReady(w, "charger", 700, 600);
    devSpawnProp(w, "crate", 850, 600);
    devSpawnProp(w, "pot", 920, 604);
    const ev: SimEvent[] = [];
    stepFor(w, C.CHARGER_WINDUP + C.CHARGER_RUSH_DUR + 0.2, ev);
    check("both props in the lane are splintered", w.props.every((pr) => pr.dead),
      `alive=${w.props.filter((pr) => !pr.dead).length}`);
    check("the wreckage emits ordinary break events", ev.filter((x) => x.t === "propBreak").length >= 2);
    check("the rush still connects with the player beyond the furniture", e.attack.move !== "none" || e.attack.cooldown > 0);
  }

  section("environment: enemy-chained barrels kill without crediting anyone");
  {
    const { w, p } = arena(0xE0B2);
    p.x = 1000; p.y = 600;
    spawnReady(w, "charger", 700, 600);
    devSpawnProp(w, "barrel_explosive", 860, 600);
    // A bystander inside the barrel's blast, OFF the charge lane.
    const bystander = spawnReady(w, "slime", 890, 660);
    const ev: SimEvent[] = [];
    stepFor(w, C.CHARGER_WINDUP + C.CHARGER_RUSH_DUR + 0.3, ev);
    check("the rushed barrel detonated", ev.some((x) => x.t === "explosion"));
    check("the blast killed the bystander slime", bystander.dead);
    check("the kill credits NO player (kills/combo untouched)", p.kills === 0 && p.combo === 0,
      `kills=${p.kills}`);
  }

  section("environment: the Gilded Warden's quake wrecks its ring and bursts chests");
  {
    const { w, boss } = gildedSetup(0xE0B3);
    devSpawnProp(w, "crate", boss.x + 40, boss.y);
    devSpawnChest(w, boss.x - 50, boss.y);
    const ev: SimEvent[] = [];
    let guard = 0;
    while (!ev.some((x) => x.t === "bossSlam") && guard++ < 60 * 8) stepFor(w, DT, ev);
    check("the quake resolves", guard < 60 * 8);
    check("the crate inside the ring is wrecked", w.props.every((pr) => pr.dead));
    const chest = w.chests.find((c) => c.kind === "wood");
    check("the wood chest bursts open with its contents spilled as world loot",
      chest !== undefined && chest.opened && w.pickups.length > 0, `pickups=${w.pickups.length}`);
    check("an enemy-burst chest never raises a blessing offer", !ev.some((x) => x.t === "offerBlessing"));
    const spill = w.pickups.every((k) => !isWall(wallProbe(w), k.x, k.y));
    check("everything it spilled landed on walkable floor", spill);
  }
}

// isWall is world-internal; probe the dungeon tiles directly for the loot-landing check.
function wallProbe(w: WorldState): WorldState { return w; }
function isWall(w: WorldState, px: number, py: number): boolean {
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  if (tx < 0 || ty < 0 || tx >= w.dungeon.w || ty >= w.dungeon.h) return true;
  return w.dungeon.tiles[ty * w.dungeon.w + tx] === 1;
}

// ---- the bat flock (deterministic boids) ----

function flockTests(): void {
  section("flock: separation — a stacked cluster spreads and never re-stacks");
  {
    const { w, p } = arena(0xF10C);
    p.x = 1400; p.y = 600;
    const bats: Enemy[] = [];
    for (let i = 0; i < 8; i++) bats.push(spawnReady(w, "bat", 400 + (i % 3) * 4, 600 + Math.floor(i / 3) * 4));
    stepFor(w, 4);
    let minPair = Infinity;
    for (let i = 0; i < bats.length; i++) {
      for (let j = i + 1; j < bats.length; j++) minPair = Math.min(minPair, Math.hypot(bats[i].x - bats[j].x, bats[i].y - bats[j].y));
    }
    check("no two bats overlap after 4s of flight (bodies are 13px radius)", minPair >= 14,
      `minPair=${minPair.toFixed(1)}px`);
  }

  section("flock: cohesion + alignment — one wheeling body that still hunts");
  {
    const { w, p } = arena(0xF10D);
    p.x = 1400; p.y = 600;
    const bats: Enemy[] = [];
    for (let i = 0; i < 6; i++) bats.push(spawnReady(w, "bat", 380 + (i % 3) * 55, 560 + Math.floor(i / 3) * 55));
    const cx0 = bats.reduce((s, b) => s + b.x, 0) / bats.length;
    stepFor(w, 3);
    const cx = bats.reduce((s, b) => s + b.x, 0) / bats.length;
    const cy = bats.reduce((s, b) => s + b.y, 0) / bats.length;
    const maxFromCentroid = Math.max(...bats.map((b) => Math.hypot(b.x - cx, b.y - cy)));
    const hx = bats.reduce((s, b) => s + Math.cos(b.zig), 0) / bats.length;
    const hy = bats.reduce((s, b) => s + Math.sin(b.zig), 0) / bats.length;
    check("the flock holds together while traveling (every bat near the centroid)",
      maxFromCentroid <= 110, `spread=${maxFromCentroid.toFixed(0)}px`);
    check("headings align — a flock, not independent beelines", Math.hypot(hx, hy) >= 0.8,
      `alignment=${Math.hypot(hx, hy).toFixed(2)}`);
    check("the flock still hunts (centroid advanced toward the target)", cx > cx0 + 150,
      `${cx0.toFixed(0)} -> ${cx.toFixed(0)}`);
  }

  section("flock: bounded neighborhood + replay determinism");
  check("social neighborhood is capped (O(n·k), small k)", C.FLOCK_MAX_NEIGHBORS <= 8 && C.FLOCK_RADIUS <= 120);
  {
    // Two identical seeded worlds, identical inputs, a big 24-bat swarm: bit-identical replay.
    const run = (): number[] => {
      const w = createWorld(0xD37, 1, { isSandbox: true });
      const p = w.players.get(LOCAL_ID)!;
      p.x = 1300; p.y = 700;
      for (let i = 0; i < 24; i++) spawnReady(w, "bat", 350 + (i % 6) * 9, 500 + Math.floor(i / 6) * 9);
      for (let t = 0; t < 300; t++) step(w, { seq: t, moveX: Math.sin(t / 20), moveY: 0, aim: 0, firing: t % 4 === 0, dash: false });
      return w.enemies.flatMap((e) => [e.x, e.y, e.zig]);
    };
    const a = run(), b = run();
    check("a 24-bat swarm replays bit-identically (pure, seeded, no wall-clock)",
      a.length === b.length && a.every((v, i) => v === b[i]), `${a.length / 3} bodies`);
    check("the swarm stayed finite and in-bounds", a.every((v) => Number.isFinite(v)));
  }
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
  curriculumTests();
rotationTests();
  bossChestTests();
  weaponTests();
  beamTests();
  lastlightTests();
  breachTests();
  snapwireTests();
  frostlineTests();
  haloTests();
  sentryTests();
  crookTests();
  effectModsTests();
  tooltipTests();
  environmentTests();
  flockTests();
  rosterTests();
  stabilityTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll content-wave assertions hold.\n");
}

main();
