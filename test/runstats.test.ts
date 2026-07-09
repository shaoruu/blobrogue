// Per-run stat accumulation (PlayerSim.runStats): the counters behind the profile panel and
// the authoritative run-result submission. Asserts attribution (damage/kills/coins credit
// the right player), boss tracking incl. the roar floor's deferred overflow, wallet
// earned/spent, the authoritative run clock, and mid-run-join startFloor stamping — all on
// the same headless sim the server runs.
//
// Run: npx tsx test/runstats.test.ts

import {
  createWorld, spawnPlayerInWorld, removePlayerFromWorld, devSpawnEnemy, stepWorldPhase,
  stepPlayerPhase, acquireWeaponInWorld, loadFloorIntoWorld,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { Bullet, Enemy } from "../src/sim/types.js";
import type { InputCmd } from "../src/sim/input.js";
import { BOSS } from "../src/sim/balance.js";

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

function twoPlayerArena(): { w: WorldState; a: PlayerSim; b: PlayerSim } {
  const w = createWorld(0xC0FFEE, 1, { isSandbox: true, skipLocalPlayer: true });
  const a = spawnPlayerInWorld(w, "pA");
  const b = spawnPlayerInWorld(w, "pB");
  a.x = 200; a.y = 200;
  b.x = 900; b.y = 600;
  return { w, a, b };
}

function plantBullet(w: WorldState, owner: string, target: Enemy, damage: number): Bullet {
  const b: Bullet = {
    x: target.x, y: target.y, vx: 1, vy: 0, radius: 6, life: 1, friendly: true,
    owner, damage, color: "#fff", pierce: 0, hitList: null, isCrit: false,
  };
  w.bullets.push(b);
  return b;
}

function plantEnemyBullet(w: WorldState, victim: PlayerSim, damage: number): void {
  w.bullets.push({
    x: victim.x, y: victim.y, vx: 0, vy: 0, radius: 6, life: 1, friendly: false,
    owner: null, damage, color: "#f00", pierce: 0, hitList: null, isCrit: false,
  });
}

const IDLE: InputCmd = { seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };

function damageAttributionTests(): void {
  section("damage dealt: credited to the striking player only, by the applied amount");
  {
    const { w, a, b } = twoPlayerArena();
    const e = devSpawnEnemy(w, "slime", 500, 400);
    e.hp = 100;
    plantBullet(w, b.id, e, 7);
    stepWorldPhase(w, 1 / 20, []);
    check("shooter B credited 7 damage", b.runStats.damageDealt === 7, `B=${b.runStats.damageDealt}`);
    check("bystander A credited nothing", a.runStats.damageDealt === 0);
  }

  section("damage dealt: overkill counts what was applied to the enemy pool");
  {
    const { w, b } = twoPlayerArena();
    const e = devSpawnEnemy(w, "slime", 500, 400);
    e.hp = 2;
    plantBullet(w, b.id, e, 50);
    stepWorldPhase(w, 1 / 20, []);
    check("full hit amount applied (hp went 2 -> -48)", b.runStats.damageDealt === 50, `dealt=${b.runStats.damageDealt}`);
  }

  section("damage taken: the victim's counter, exact amount");
  {
    const { w, a, b } = twoPlayerArena();
    plantEnemyBullet(w, a, 2);
    stepWorldPhase(w, 1 / 20, []);
    check("victim A took 2", a.runStats.damageTaken === 2, `A=${a.runStats.damageTaken}`);
    check("B took nothing", b.runStats.damageTaken === 0);
  }

  section("death cause: the blow that dropped the player is named");
  {
    const { w, a } = twoPlayerArena();
    check("unharmed player has no cause", a.runStats.deathCause === null);
    plantEnemyBullet(w, a, 1);
    stepWorldPhase(w, 1 / 20, []);
    check("a non-lethal hit records no cause", a.runStats.deathCause === null);
    a.invuln = 0;
    plantEnemyBullet(w, a, 99);
    stepWorldPhase(w, 1 / 20, []);
    check("a lethal projectile records 'shot'", a.runStats.deathCause === "shot",
      `cause=${a.runStats.deathCause}`);
  }
  {
    const { w, a } = twoPlayerArena();
    const e = devSpawnEnemy(w, "slime", a.x, a.y); // on top: contact damage next tick
    e.spawnTimer = 0;
    a.hp = 1;
    a.invuln = 0;
    stepWorldPhase(w, 1 / 20, []);
    check("a lethal contact hit records the enemy kind", a.runStats.deathCause === "slime",
      `cause=${a.runStats.deathCause} hp=${a.hp}`);
  }
}

function bossTests(): void {
  section("boss: kill records bossKills, floor, and the first-boss time");
  {
    const { w, b } = twoPlayerArena();
    w.floor = 5;
    const e = devSpawnEnemy(w, "boss", 500, 400);
    if (e.boss) e.boss.transitionsDone = BOSS.phaseAt.length; // both roar beats already spent
    e.hp = 1;
    // Advance the run clock a known amount before the kill.
    for (let i = 0; i < 40; i++) stepWorldPhase(w, 1 / 20, []); // 2.0s
    plantBullet(w, b.id, e, 10);
    stepWorldPhase(w, 1 / 20, []);
    check("bossKills = 1", b.runStats.bossKills === 1);
    check("boss kill floor recorded", b.runStats.bossKillFloors.length === 1 && b.runStats.bossKillFloors[0] === 5,
      `floors=${JSON.stringify(b.runStats.bossKillFloors)}`);
    check("first-boss time stamped from the run clock (~2s)",
      b.runStats.firstBossKillSecs >= 2 && b.runStats.firstBossKillSecs <= 2.2,
      `t=${b.runStats.firstBossKillSecs.toFixed(3)}`);
  }

  section("boss: roar floor credits only APPLIED damage; queued overflow credits on release");
  {
    const { w, b } = twoPlayerArena();
    const e = devSpawnEnemy(w, "boss", 500, 400);
    e.hp = e.maxHp; // full: first threshold at 70%, floor at 62%
    const hpBefore = e.hp;
    const floorHp = BOSS.phaseFloor[0] * e.maxHp;
    // The crossing hit: applied damage stops at the phase floor (its own overflow is
    // uncredited by design — checkBossTransition queues it with no owner).
    plantBullet(w, b.id, e, e.maxHp * 0.5);
    stepWorldPhase(w, 1 / 20, []);
    const appliedNow = hpBefore - floorHp;
    check("crossing hit credited exactly down to the floor",
      Math.abs(b.runStats.damageDealt - appliedNow) < 1e-6,
      `dealt=${b.runStats.damageDealt.toFixed(1)} expected=${appliedNow.toFixed(1)}`);
    // A hit DURING the roar: the boss sits on the floor, so the whole reduced amount is
    // queued (credited to the shooter only when the roar exits and it actually applies).
    plantBullet(w, b.id, e, 20);
    stepWorldPhase(w, 1 / 20, []);
    check("mid-roar hit not credited while fully queued",
      Math.abs(b.runStats.damageDealt - appliedNow) < 1e-6,
      `dealt=${b.runStats.damageDealt.toFixed(1)}`);
    // Ride out the 1.2s roar. The WHOLE queued pool (the crossing hit's overflow + the
    // reduced mid-roar hit) applies as one damage event credited to the last damaging
    // actor (BossRoar.queuedBy) — which is B on both counts here.
    for (let i = 0; i < 60; i++) stepWorldPhase(w, 1 / 20, []);
    const crossingQueued = floorHp - (hpBefore - e.maxHp * 0.5);
    const reduced = 20 * (1 - BOSS.roarDamageReduction);
    check("released overflow credited to the last damaging actor",
      Math.abs(b.runStats.damageDealt - (appliedNow + crossingQueued + reduced)) < 1e-6,
      `dealt=${b.runStats.damageDealt.toFixed(1)} expected=${(appliedNow + crossingQueued + reduced).toFixed(1)}`);
  }
}

function comboAndWeaponTests(): void {
  section("best combo: tracks the high-water mark across decays");
  {
    const { w, b } = twoPlayerArena();
    for (let n = 0; n < 3; n++) {
      const e = devSpawnEnemy(w, "slime", 500, 400);
      e.hp = 1;
      plantBullet(w, b.id, e, 10);
      stepWorldPhase(w, 1 / 20, []);
    }
    check("bestCombo reached 3", b.runStats.bestCombo === 3, `best=${b.runStats.bestCombo}`);
    // Let the combo window lapse fully, then kill once more: combo resets to 1, best stays 3.
    for (let i = 0; i < 80; i++) stepWorldPhase(w, 1 / 20, []);
    const e = devSpawnEnemy(w, "slime", 500, 400);
    e.hp = 1;
    plantBullet(w, b.id, e, 10);
    stepWorldPhase(w, 1 / 20, []);
    check("combo decayed to 1 but bestCombo held", b.combo === 1 && b.runStats.bestCombo === 3,
      `combo=${b.combo} best=${b.runStats.bestCombo}`);
  }

  section("kills by weapon: killing blows attribute to the equipped weapon");
  {
    const { w, b } = twoPlayerArena();
    const e1 = devSpawnEnemy(w, "slime", 500, 400);
    e1.hp = 1;
    plantBullet(w, b.id, e1, 10);
    stepWorldPhase(w, 1 / 20, []);
    acquireWeaponInWorld(w, b.id, "shotgun");
    const e2 = devSpawnEnemy(w, "slime", 500, 400);
    e2.hp = 1;
    plantBullet(w, b.id, e2, 10);
    stepWorldPhase(w, 1 / 20, []);
    check("pistol then shotgun each credited one",
      b.runStats.killsByWeapon.pistol === 1 && b.runStats.killsByWeapon.shotgun === 1,
      JSON.stringify(b.runStats.killsByWeapon));
  }

  section("kills by weapon: a real melee swing kill lands on the melee weapon");
  {
    const { w, b } = twoPlayerArena();
    acquireWeaponInWorld(w, b.id, "sword");
    const e = devSpawnEnemy(w, "slime", b.x + 30, b.y); // inside the cutlass's 48px reach
    e.hp = 1;
    e.spawnTimer = 0;
    stepPlayerPhase(w, b, { ...IDLE, aim: 0, firing: true }, 1 / 20, []);
    stepWorldPhase(w, 1 / 20, []);
    check("sword swing killed and attributed", e.dead && b.runStats.killsByWeapon.sword === 1,
      `dead=${e.dead} byWeapon=${JSON.stringify(b.runStats.killsByWeapon)}`);
    check("melee damage counted as damage dealt", b.runStats.damageDealt > 0);
  }
}

function walletTests(): void {
  section("wallet: coin pickups add to coinsEarned; dealer hearts add to coinsSpent");
  {
    const { w, a } = twoPlayerArena();
    w.pickups.push({ id: 9001, kind: "coin", x: a.x, y: a.y, radius: 13, weapon: null, value: 7 });
    stepWorldPhase(w, 1 / 20, []);
    check("coin value earned", a.coins === 7 && a.runStats.coinsEarned === 7,
      `coins=${a.coins} earned=${a.runStats.coinsEarned}`);
    a.hp = a.maxHp - 1; // eligible to buy
    w.pickups.push({ id: 9002, kind: "dealer_heart", x: a.x, y: a.y, radius: 13, weapon: null, value: 5 });
    stepWorldPhase(w, 1 / 20, []);
    check("dealer purchase spent 5", a.coins === 2 && a.runStats.coinsSpent === 5,
      `coins=${a.coins} spent=${a.runStats.coinsSpent}`);
    check("earned untouched by spending", a.runStats.coinsEarned === 7);
  }

  section("wallet: a full-HP heart converts to coins and counts as earned");
  {
    const { w, a } = twoPlayerArena();
    w.pickups.push({ id: 9003, kind: "heart", x: a.x, y: a.y, radius: 13, weapon: null });
    stepWorldPhase(w, 1 / 20, []);
    check("full-HP heart became earned coins", a.coins > 0 && a.runStats.coinsEarned === a.coins,
      `coins=${a.coins} earned=${a.runStats.coinsEarned}`);
  }
}

function clockAndJoinTests(): void {
  section("run clock: timeAliveSecs advances with the authoritative world step");
  {
    const { w, a } = twoPlayerArena();
    for (let i = 0; i < 20; i++) stepWorldPhase(w, 1 / 20, []);
    check("1 second after 20 fixed ticks", Math.abs(a.runStats.timeAliveSecs - 1) < 1e-9,
      `t=${a.runStats.timeAliveSecs}`);
  }

  section("startFloor: a mid-run joiner is stamped with the floor they entered on");
  {
    const w = createWorld(0xBEEF, 1, { isShared: true, skipLocalPlayer: true });
    const a = spawnPlayerInWorld(w, "pA");
    loadFloorIntoWorld(w, 4);
    const late = spawnPlayerInWorld(w, "pLate");
    check("founder joined on floor 1", a.runStats.startFloor === 1, `a=${a.runStats.startFloor}`);
    check("late joiner stamped floor 4", late.runStats.startFloor === 4, `late=${late.runStats.startFloor}`);
  }

  section("run stats persist across a descend (per-run, not per-floor)");
  {
    const { w, b } = twoPlayerArena();
    const e = devSpawnEnemy(w, "slime", 500, 400);
    e.hp = 1;
    plantBullet(w, b.id, e, 10);
    stepWorldPhase(w, 1 / 20, []);
    const before = b.runStats.bestCombo;
    loadFloorIntoWorld(w, 2);
    check("bestCombo survived the floor build", b.runStats.bestCombo === before && before === 1);
  }

  section("party size: authoritative high-water mark of co-present players");
  {
    const solo = createWorld(0xBEEF, 1, { isShared: true, skipLocalPlayer: true });
    const lone = spawnPlayerInWorld(solo, "pLone");
    stepWorldPhase(solo, 1 / 20, []);
    check("a lone run stays party 1", lone.runStats.maxParty === 1);

    const { w, a, b } = twoPlayerArena();
    stepWorldPhase(w, 1 / 20, []);
    check("both players see party 2", a.runStats.maxParty === 2 && b.runStats.maxParty === 2);
    const c = spawnPlayerInWorld(w, "pC");
    stepWorldPhase(w, 1 / 20, []);
    check("a third joiner raises everyone to 3", a.runStats.maxParty === 3 && c.runStats.maxParty === 3);
    removePlayerFromWorld(w, c.id);
    removePlayerFromWorld(w, b.id);
    stepWorldPhase(w, 1 / 20, []);
    check("the high-water mark never recedes after leavers", a.runStats.maxParty === 3,
      `maxParty=${a.runStats.maxParty}`);
  }
}

damageAttributionTests();
bossTests();
comboAndWeaponTests();
walletTests();
clockAndJoinTests();

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(failures.map((f) => "  FAILED: " + f).join("\n") + "\n");
  process.exit(1);
}
process.stdout.write("\nAll run-stat assertions passed.\n");
