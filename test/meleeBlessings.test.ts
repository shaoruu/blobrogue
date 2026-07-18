import {
  acquireWeaponInWorld,
  applyItemToWorld,
  createWorld,
  devSpawnEnemy,
  stepWorld,
  switchWeaponInWorld,
} from "../src/sim/world.js";
import type { PlayerSim, WorldState } from "../src/sim/world.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Enemy, WeaponId } from "../src/sim/types.js";
import { createMods, itemById, ITEMS, recomputeMods } from "../src/sim/items.js";
import { WEAPONS } from "../src/sim/weapons.js";
import {
  CURRENT_CONTENT_CATALOG_VERSION,
  WAVE_B_CONTENT_CATALOG_VERSION,
  WAVE_C_CONTENT_CATALOG_VERSION,
  contentCatalogFor,
} from "../src/sim/contentCatalog.js";
import { STACK_CATEGORY } from "../src/sim/antiDegenerate.js";
import { isPvpBlessingId } from "../src/sim/items.js";
import { pvpBlessingBlacklist } from "../src/sim/pvp.js";

const DT = 1 / 60;
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, isPassing: boolean, detail = ""): void {
  if (isPassing) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? ` — ${detail}` : ""}\n`);
    return;
  }
  failed++;
  failures.push(name);
  process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function arena(seed: number): { world: WorldState; player: PlayerSim } {
  const world = createWorld(seed, 1, { isSandbox: true });
  world.enemies = [];
  world.pendingSpawns = [];
  const player = world.players.get(LOCAL_ID)!;
  player.x = 400;
  player.y = 400;
  player.invuln = 0;
  return { world, player };
}

function input(world: WorldState, overrides: Partial<InputCmd> = {}): InputCmd {
  return {
    seq: world.tick + 1,
    moveX: 0,
    moveY: 0,
    aim: 0,
    firing: false,
    dash: false,
    ...overrides,
  };
}

function step(world: WorldState, player: PlayerSim, overrides: Partial<InputCmd> = {}) {
  return stepWorld(world, new Map([[player.id, input(world, overrides)]]), DT);
}

function applyRank(world: WorldState, player: PlayerSim, id: string, rank: number): void {
  const item = itemById(id)!;
  for (let level = 0; level < rank; level++) applyItemToWorld(world, player.id, item);
}

function equip(world: WorldState, player: PlayerSim, weapon: WeaponId): void {
  acquireWeaponInWorld(world, player.id, weapon);
  switchWeaponInWorld(world, player.id, weapon);
}

function ready(player: PlayerSim): void {
  player.fireCd = 0;
  player.weaponFireCooldowns[player.weapon] = 0;
}

function swing(world: WorldState, player: PlayerSim) {
  ready(player);
  return step(world, player, { aim: 0, firing: true });
}

function parked(
  world: WorldState,
  kind: Enemy["kind"],
  x: number,
  y: number,
  hp = 100,
  tier?: Enemy["tier"],
): Enemy {
  const enemy = devSpawnEnemy(world, kind, x, y, tier);
  enemy.spawnTimer = 0;
  enemy.speed = 0;
  enemy.hp = hp;
  enemy.maxHp = hp;
  return enemy;
}

function hostileHit(world: WorldState, player: PlayerSim, damage: number): void {
  world.bullets.push({
    x: player.x,
    y: player.y,
    vx: 0,
    vy: 0,
    radius: 5,
    life: 1,
    friendly: false,
    owner: null,
    damage,
    color: "#fff",
    pierce: 0,
    hitList: null,
    isCrit: false,
  });
  step(world, player);
}

section("catalog, copy, categories, and private draft");
{
  const ids = ["stagger_pulse", "blade_ward", "cleave_crit", "momentum_charge", "finisher"];
  const catalog = contentCatalogFor(WAVE_C_CONTENT_CATALOG_VERSION);
  check("melee blessings are in the current additive catalog",
    CURRENT_CONTENT_CATALOG_VERSION === WAVE_C_CONTENT_CATALOG_VERSION
    && ids.every((id) => catalog.normalBlessingIds.includes(id))
    && contentCatalogFor(WAVE_B_CONTENT_CATALOG_VERSION).normalBlessingIds.length === 39);
  check("all five have locked rarities",
    itemById("stagger_pulse")?.rarity === "uncommon"
    && ids.slice(1).every((id) => itemById(id)?.rarity === "rare"));
  check("all five have canonical stack categories",
    STACK_CATEGORY.stagger_pulse === "melee_stagger"
    && STACK_CATEGORY.blade_ward === "melee_ward"
    && STACK_CATEGORY.cleave_crit === "melee_cleave"
    && STACK_CATEGORY.momentum_charge === "melee_momentum"
    && STACK_CATEGORY.finisher === "melee_execute");
  check("new blessing copy contains no raw pixel units",
    ITEMS.filter((item) => ids.includes(item.id))
      .every((item) => item.descs.every((desc) => !/\d+\s*px\b/i.test(desc))));
  check("Blade Ward and Finisher are blacklisted from private_draft_v1",
    pvpBlessingBlacklist.includes("blade_ward")
    && pvpBlessingBlacklist.includes("finisher")
    && !isPvpBlessingId("blade_ward")
    && !isPvpBlessingId("finisher"));
  const modsAt = (id: string, rank: number) => {
    const mods = createMods();
    recomputeMods(mods, Array.from({ length: rank }, () => id));
    return mods;
  };
  check("Stagger Pulse ranks pin radius and slow",
    [1, 2, 3].every((rank) => {
      const mods = modsAt("stagger_pulse", rank);
      return mods.staggerPulseRadius === [60, 68, 76][rank - 1]
        && mods.staggerPulseSlowMult === [0.72, 0.68, 0.64][rank - 1];
    }));
  check("Blade Ward ranks pin absorb and refresh window",
    [1, 2, 3].every((rank) => {
      const mods = modsAt("blade_ward", rank);
      return mods.bladeWardAbsorb === [4, 6, 8][rank - 1]
        && mods.bladeWardWindow === [1.5, 1.8, 2.1][rank - 1];
    }));
  check("Cleave Crit ranks pin arc and flat reach multipliers",
    [1, 2, 3].every((rank) => {
      const mods = modsAt("cleave_crit", rank);
      return mods.cleaveCritArcMult === [1.4, 1.5, 1.6][rank - 1]
        && mods.cleaveCritReachMult === 1.15;
    }));
  check("Momentum Charge ranks pin damage and flat knockback behavior",
    [1, 2, 3].every((rank) =>
      modsAt("momentum_charge", rank).momentumDamageBonus === [0.40, 0.55, 0.70][rank - 1]));
  check("Finisher ranks pin regular and elite thresholds",
    [1, 2, 3].every((rank) => {
      const mods = modsAt("finisher", rank);
      return mods.finisherThreshold === [0.15, 0.20, 0.25][rank - 1]
        && mods.finisherEliteThreshold === [0, 0, 0.25][rank - 1];
    }));
}

section("Stagger Pulse");
{
  const { world, player } = arena(0x5101);
  applyRank(world, player, "stagger_pulse", 1);
  equip(world, player, "sword");
  const impact = parked(world, "skeleton", 450, 400);
  const nearby = [
    parked(world, "skeleton", 450, 455),
    parked(world, "skeleton", 450, 345),
    parked(world, "skeleton", 495, 438),
    parked(world, "skeleton", 495, 362),
    parked(world, "skeleton", 505, 400),
  ];
  const hpBefore = nearby.map((enemy) => enemy.hp);
  const firstEvents = swing(world, player);
  const slowed = [impact, ...nearby].filter((enemy) => enemy.meleeSlowT > 0);
  check("pulse deals zero damage to ring targets",
    nearby.every((enemy, index) => enemy.hp === hpBefore[index]));
  check("pulse controls at most four targets", slowed.length === 4, `slowed=${slowed.length}`);
  check("rank 1 applies 0.72 move for 0.4s and 0.8s owner ICD",
    slowed.every((enemy) => enemy.meleeSlowMult === 0.72 && enemy.meleeSlowT === 0.4)
    && player.staggerPulseIcdT === 0.8);
  check("one melee hit emits one coalesced pulse read",
    firstEvents.filter((event) => event.t === "blessingProc"
      && event.item === "stagger_pulse"
      && event.phase === "pulse").length === 1);

  for (let tick = 0; tick < 12; tick++) step(world, player);
  const secondEvents = swing(world, player);
  check("owner ICD blocks another pulse on a different body",
    !secondEvents.some((event) => event.t === "blessingProc" && event.item === "stagger_pulse"));

  const pike = arena(0x5102);
  applyRank(pike.world, pike.player, "stagger_pulse", 3);
  equip(pike.world, pike.player, "spear");
  parked(pike.world, "skeleton", 470, 400);
  const outsidePikeFile = parked(pike.world, "skeleton", 470, 450);
  swing(pike.world, pike.player);
  check("Pike uses the locked 40-radius single-file pulse",
    outsidePikeFile.meleeSlowT === 0);
}

section("Blade Ward");
{
  const windows = [1.5, 1.8, 2.1];
  const absorbs = [4, 6, 8];
  for (let rank = 1; rank <= 3; rank++) {
    const { world, player } = arena(0x5200 + rank);
    applyRank(world, player, "blade_ward", rank);
    equip(world, player, "sword");
    parked(world, "skeleton", 450, 400);
    swing(world, player);
    check(`rank ${rank} refreshes the exact absorb and window`,
      player.bladeWardAbsorb === absorbs[rank - 1]
      && Math.abs(player.bladeWardT - windows[rank - 1]) < 1e-9);
  }

  const small = arena(0x5210);
  applyRank(small.world, small.player, "blade_ward", 1);
  equip(small.world, small.player, "sword");
  parked(small.world, "skeleton", 450, 400);
  swing(small.world, small.player);
  const hpBefore = small.player.hp;
  hostileHit(small.world, small.player, 3);
  check("one small hit is fully absorbed and spends the ward",
    small.player.hp === hpBefore
    && small.player.bladeWardAbsorb === 0
    && small.player.bladeWardT === 0);

  const large = arena(0x5211);
  applyRank(large.world, large.player, "blade_ward", 1);
  equip(large.world, large.player, "sword");
  parked(large.world, "skeleton", 450, 400);
  swing(large.world, large.player);
  const largeHp = large.player.hp;
  hostileHit(large.world, large.player, 6);
  check("a large hit consumes four absorb and passes only the remainder",
    large.player.hp === largeHp - 2);

  const downed = arena(0x5212);
  applyRank(downed.world, downed.player, "blade_ward", 1);
  equip(downed.world, downed.player, "sword");
  parked(downed.world, "skeleton", 450, 400);
  swing(downed.world, downed.player);
  downed.player.isDown = true;
  step(downed.world, downed.player);
  check("downed clears Blade Ward", downed.player.bladeWardT === 0 && downed.player.bladeWardAbsorb === 0);
}

section("Cleave Crit");
{
  const { world, player } = arena(0x5301);
  applyRank(world, player, "cleave_crit", 3);
  equip(world, player, "longsword");
  player.mods.critChance = 1;
  swing(world, player);
  check("rank 3 crit swing widens arc 1.6x and reach 1.15x",
    player.meleeSwing !== null
    && Math.abs(player.meleeSwing.arc - WEAPONS.longsword.melee!.arc * 1.6) < 1e-9
    && Math.abs(player.meleeSwing.reach - WEAPONS.longsword.melee!.reach * 1.15) < 1e-9);

  const bossDamage = (isCleave: boolean): number => {
    const sample = arena(isCleave ? 0x5302 : 0x5303);
    if (isCleave) applyRank(sample.world, sample.player, "cleave_crit", 3);
    equip(sample.world, sample.player, "longsword");
    sample.player.mods.critChance = 1;
    const boss = parked(sample.world, "boss", 450, 400, 1000);
    boss.boss = null;
    const before = boss.hp;
    swing(sample.world, sample.player);
    return before - boss.hp;
  };
  const baseBossDamage = bossDamage(false);
  const cleaveBossDamage = bossDamage(true);
  check("Cleave Crit adds no boss-facing damage",
    Math.abs(baseBossDamage - cleaveBossDamage) < 1e-9,
    `base=${baseBossDamage} cleave=${cleaveBossDamage}`);
}

section("Momentum Charge");
{
  const { world, player } = arena(0x5401);
  applyRank(world, player, "momentum_charge", 1);
  equip(world, player, "sword");
  step(world, player, { moveX: 1, dash: true });
  for (let tick = 0; tick < 20 && !player.isMomentumArmed; tick++) {
    step(world, player, { moveX: 1 });
  }
  check("dash end arms exactly one charge", player.isMomentumArmed);

  const first = parked(world, "skeleton", player.x + 45, player.y, 100);
  const second = parked(world, "skeleton", player.x + 50, player.y + 8, 100);
  const firstHp = first.hp;
  const secondHp = second.hp;
  swing(world, player);
  const damage = [firstHp - first.hp, secondHp - second.hp].sort((a, b) => a - b);
  check("only the next melee hit receives +40% damage",
    Math.abs(damage[0] - WEAPONS.sword.damage) < 1e-9
    && Math.abs(damage[1] - WEAPONS.sword.damage * 1.4) < 1e-9,
    `damage=${damage.join(",")}`);
  check("Momentum payoff applies exactly 1.5x knockback to one hit",
    Math.abs(first.vx / second.vx - 1.5) < 1e-9,
    `ratio=${first.vx / second.vx}`);
  check("payoff consumes the one charge and starts the 2.5s ICD",
    !player.isMomentumArmed && player.momentumIcdT > 2.48);

  player.dashCd = 0;
  player.meleeSwing = null;
  step(world, player, { moveX: 1, dash: true });
  for (let tick = 0; tick < 20; tick++) step(world, player, { moveX: 1 });
  check("ICD prevents dash re-arm and perma-uptime", !player.isMomentumArmed);

  for (let tick = 0; tick < 160; tick++) step(world, player);
  player.mods.moveSpeedMult = 2;
  for (let tick = 0; tick < 55 && !player.isMomentumArmed; tick++) {
    step(world, player, { moveX: 1 });
  }
  check("moving 200 within one second arms after the ICD", player.isMomentumArmed);
}

section("Crooked Chain eligibility");
{
  const { world, player } = arena(0x5501);
  applyRank(world, player, "stagger_pulse", 1);
  applyRank(world, player, "blade_ward", 1);
  applyRank(world, player, "cleave_crit", 3);
  applyRank(world, player, "momentum_charge", 1);
  equip(world, player, "crook");
  player.mods.critChance = 1;
  player.isMomentumArmed = true;
  parked(world, "skeleton", 480, 400, 100);
  swing(world, player);
  ready(player);
  const sweepEvents = step(world, player, { aim: 0, firing: true });
  check("Crook sweep fires Stagger Pulse and Blade Ward",
    sweepEvents.some((event) => event.t === "blessingProc" && event.item === "stagger_pulse")
    && sweepEvents.some((event) => event.t === "blessingProc" && event.item === "blade_ward")
    && player.bladeWardAbsorb === 4);
  check("Crook procs retain their full authored timers",
    player.staggerPulseIcdT === 0.8
    && player.bladeWardT === 1.5
    && world.enemies.some((enemy) => enemy.meleeSlowT === 0.4));
  check("Crook sweep does not consume Momentum Charge", player.isMomentumArmed);
  check("Crook has no swing arc for Cleave Crit", player.meleeSwing === null);
}

section("Razor Halo exclusions");
{
  const { world, player } = arena(0x5510);
  applyRank(world, player, "stagger_pulse", 1);
  applyRank(world, player, "blade_ward", 1);
  applyRank(world, player, "cleave_crit", 3);
  applyRank(world, player, "momentum_charge", 1);
  equip(world, player, "halo");
  player.isMomentumArmed = true;
  parked(world, "skeleton", 448, 400, 100);
  const events = swing(world, player);
  check("Halo contact fires no melee-native pulse or ward",
    !events.some((event) => event.t === "blessingProc"
      && (event.item === "stagger_pulse" || event.item === "blade_ward"))
    && player.bladeWardAbsorb === 0);
  check("Halo contact consumes neither Cleave Crit nor Momentum Charge",
    player.meleeSwing === null && player.isMomentumArmed);
}

section("Finisher");
{
  const eliteExpectations = [
    { rank: 1, threshold: 0.15, isExecuted: false },
    { rank: 2, threshold: 0.20, isExecuted: false },
    { rank: 3, threshold: 0.25, isExecuted: true },
  ];
  for (const expectation of eliteExpectations) {
    const { world, player } = arena(0x5600 + expectation.rank);
    applyRank(world, player, "finisher", expectation.rank);
    equip(world, player, "sword");
    const elite = parked(world, "skeleton", 450, 400, 100, "elite");
    elite.hp = elite.maxHp * expectation.threshold;
    const events = swing(world, player);
    const isExecuted = events.some((event) =>
      event.t === "blessingProc" && event.item === "finisher" && event.phase === "execute"
    );
    check(`elite rank ${expectation.rank} execute eligibility is exact`,
      isExecuted === expectation.isExecuted
      && elite.dead === expectation.isExecuted);
  }

  for (let rank = 1; rank <= 3; rank++) {
    const { world, player } = arena(0x5610 + rank);
    applyRank(world, player, "finisher", rank);
    equip(world, player, "sword");
    const boss = parked(world, "boss", 450, 400, 100);
    boss.hp = 1;
    const events = swing(world, player);
    check(`boss never executes at rank ${rank}, even at 1%`,
      !events.some((event) => event.t === "blessingProc" && event.item === "finisher"));
  }

  const phased = arena(0x5620);
  applyRank(phased.world, phased.player, "finisher", 3);
  equip(phased.world, phased.player, "sword");
  const captain = parked(phased.world, "skeleton", 450, 400, 100);
  captain.captainPhase = 1;
  captain.hp = 25;
  const phaseEvents = swing(phased.world, phased.player);
  check("phase-transition bodies never execute",
    !phaseEvents.some((event) => event.t === "blessingProc" && event.item === "finisher")
    && !captain.dead);

  const regular = arena(0x5621);
  applyRank(regular.world, regular.player, "finisher", 1);
  equip(regular.world, regular.player, "sword");
  const target = parked(regular.world, "skeleton", 450, 400, 100);
  target.hp = 15;
  const executeEvents = swing(regular.world, regular.player);
  check("rank 1 executes a regular enemy at exactly 15%",
    target.dead
    && executeEvents.some((event) =>
      event.t === "blessingProc" && event.item === "finisher" && event.phase === "execute"
    ));
}

process.stdout.write(`\nmelee blessings: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const failure of failures) process.stdout.write(`  FAIL ${failure}\n`);
  process.exit(1);
}
