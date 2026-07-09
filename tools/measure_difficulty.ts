// Difficulty-mode measurement report: the exact modifier table plus MEASURED boss TTK,
// focused regular TTK, threat budget/density, sustain (heart) rates, and spawn grace for
// every mode, all on the deterministic sim. This is the evidence behind the difficulty
// bands the balance suite gates on — rerun it whenever DIFFICULTIES changes.
//
// Run: npx tsx tools/measure_difficulty.ts

import { createWorld, stepWorld, devSpawnEnemy, applyItemToWorld, acquireWeaponInWorld } from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, EnemyKind, WeaponId } from "../src/sim/types.js";
import { DIFFICULTIES, DIFFICULTY_IDS, bossHpForFloor, floorThreat, activeThreatCap, BIOME_PRESSURE } from "../src/sim/balance.js";
import type { Difficulty } from "../src/sim/balance.js";
import { createEnemy, spawnFloorEnemies, threatCostOf, enemyHpForFloor } from "../src/sim/enemies.js";
import { generateDungeon } from "../src/sim/dungeon.js";
import { itemById } from "../src/sim/items.js";
import { biomeIndexForFloor } from "../src/sim/biomes.js";
import { Rng } from "../src/sim/rng.js";

const DT = 1 / 60;
const L3 = (id: string) => [id, id, id];

function grant(w: WorldState, ids: string[]): void {
  for (const id of ids) applyItemToWorld(w, LOCAL_ID, itemById(id)!);
}

function step(w: WorldState, cmd: InputCmd): ReturnType<typeof stepWorld> {
  return stepWorld(w, new Map([[LOCAL_ID, cmd]]), DT);
}

function measureBossTtk(difficulty: Difficulty, weapon: WeaponId, picks: string[]): number {
  const w = createWorld(0xBA1A4CE, 5, { isSandbox: true, difficulty });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  acquireWeaponInWorld(w, LOCAL_ID, weapon);
  grant(w, picks);
  const boss = devSpawnEnemy(w, "boss", p.x + 170, p.y);
  let ticks = 0;
  let isKilled = false;
  while (!isKilled && ticks < 60 * 120) {
    const aim = Math.atan2(boss.y - p.y, boss.x - p.x);
    const evs = step(w, { seq: ticks, moveX: 0, moveY: 0, aim, firing: true, dash: false });
    if (evs.some((e) => e.t === "enemyKill" && e.kind === "boss")) isKilled = true;
    ticks++;
  }
  return isKilled ? ticks * DT : Number.NaN;
}

function measureFocusedTtk(difficulty: Difficulty, kind: EnemyKind, floor: number, weapon: WeaponId, picks: string[]): number {
  const w = createWorld(0xF0C05, floor, { isSandbox: true, difficulty });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  acquireWeaponInWorld(w, LOCAL_ID, weapon);
  grant(w, picks);
  const target = devSpawnEnemy(w, kind, p.x + 140, p.y);
  let ticks = 0;
  while (!target.dead && ticks < 60 * 20) {
    const aim = Math.atan2(target.y - p.y, target.x - p.x);
    step(w, { seq: ticks, moveX: 0, moveY: 0, aim, firing: true, dash: false });
    ticks++;
  }
  return ticks * DT;
}

interface ThreatStats { cost: number; bodies: number; active: number }

function measureThreat(difficulty: Difficulty, floor: number, seeds: number): ThreatStats {
  let cost = 0, bodies = 0, active = 0;
  for (let i = 0; i < seeds; i++) {
    const seed = 0x5eed + i * 7919;
    const d = generateDungeon(seed, floor);
    const spawns = spawnFloorEnemies(d, seed, floor, 1, difficulty);
    const all = [...spawns.active, ...spawns.pending];
    cost += all.reduce((s, e) => s + threatCostOf(e.kind, e.tier), 0);
    bodies += all.length;
    active += spawns.active.length;
  }
  return { cost: cost / seeds, bodies: bodies / seeds, active: active / seeds };
}

function measureHearts(difficulty: Difficulty, kills: number): number {
  // Same seed + same kill order for every mode: the unconditional drop rolls consume the
  // identical rng stream, so counts differ ONLY by each mode's threshold (a strict superset).
  const w = createWorld(0x5EED5, 2, { isSandbox: true, difficulty });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  for (let i = 0; i < kills; i++) {
    const e = devSpawnEnemy(w, "slime", p.x + 300, p.y);
    const b: Bullet = {
      x: e.x, y: e.y, vx: 1, vy: 0, radius: 20, life: 0.05, friendly: true, owner: LOCAL_ID,
      damage: 999, color: "#fff", pierce: 0, hitList: null, isCrit: false,
    };
    w.bullets.push(b);
    step(w, { seq: i, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false });
  }
  return w.pickups.filter((k) => k.kind === "heart").length;
}

function fmt(n: number, digits = 1): string {
  return Number.isNaN(n) ? "unkilled" : n.toFixed(digits);
}

function main(): void {
  process.stdout.write("== difficulty modifier table ==\n");
  for (const id of DIFFICULTY_IDS) {
    const d = DIFFICULTIES[id];
    process.stdout.write(
      `${id.padEnd(9)} enemyHp x${d.enemyHpMult.toFixed(2)}  bossHp x${d.bossHpMult.toFixed(2)}  threat x${d.threatMult.toFixed(2)}  hearts x${d.heartMult.toFixed(2)}  spawnGrace ${d.playerSpawnGrace.toFixed(2)}s\n`,
    );
  }

  process.stdout.write("\n== boss (Slime King, F5): HP + measured TTK ==\n");
  for (const id of DIFFICULTY_IDS) {
    const hp = createEnemy("boss", 0, 0, 5, new Rng(1), 0, { difficulty: id }).hp;
    const median = measureBossTtk(id, "pistol", L3("hair_trigger"));
    const highSawnoff = measureBossTtk(id, "sawnoff", [...L3("deadeye"), "glass_cannon"]);
    const highSmg = measureBossTtk(id, "smg", [...L3("deadeye"), "glass_cannon"]);
    process.stdout.write(
      `${id.padEnd(9)} hp=${hp}  medianBuildTTK=${fmt(median)}s  highRoll(sawnoff)=${fmt(highSawnoff)}s  highRoll(smg)=${fmt(highSmg)}s\n`,
    );
  }

  process.stdout.write("\n== regular enemies: HP + focused TTK ==\n");
  for (const id of DIFFICULTY_IDS) {
    const dif = { difficulty: id } as const;
    const slime1 = createEnemy("slime", 0, 0, 1, new Rng(1), 0, dif).hp;
    const skel5 = createEnemy("skeleton", 0, 0, 5, new Rng(1), 0, dif).hp;
    const brute4 = createEnemy("skeleton", 0, 0, 4, new Rng(1), 0, { tier: "brute", difficulty: id }).hp;
    const elite6 = createEnemy("spitter", 0, 0, 6, new Rng(1), 0, { tier: "elite", difficulty: id }).hp;
    const t1 = measureFocusedTtk(id, "slime", 1, "pistol", []);
    const t9 = measureFocusedTtk(id, "skeleton", 9, "pistol", [...L3("hair_trigger"), "glass_cannon", "glass_cannon"]);
    process.stdout.write(
      `${id.padEnd(9)} slimeF1=${slime1}hp  skelF5=${skel5}hp  bruteF4=${brute4}hp  eliteF6=${elite6}hp  F1slimeTTK=${fmt(t1, 2)}s  F9skelTTK=${fmt(t9, 2)}s\n`,
    );
  }
  process.stdout.write(`baseline tables (x1.0): slimeF1=${enemyHpForFloor("slime", 1)} skelF5=${enemyHpForFloor("skeleton", 5)} bossF5=${bossHpForFloor(5)}\n`);

  process.stdout.write("\n== threat budget / density (avg over 20 seeds) ==\n");
  for (const floor of [1, 3, 4, 7, 9]) {
    const parts: string[] = [];
    for (const id of DIFFICULTY_IDS) {
      const s = measureThreat(id, floor, 20);
      parts.push(`${id}: cost=${s.cost.toFixed(1)} bodies=${s.bodies.toFixed(1)} active=${s.active.toFixed(1)}`);
    }
    const budget = floorThreat(floor) * BIOME_PRESSURE[biomeIndexForFloor(floor)].budgetMult;
    process.stdout.write(`F${floor} (budget ${budget.toFixed(1)}, cap ${activeThreatCap(floor)})  ${parts.join("  |  ")}\n`);
  }
  for (const floor of [5, 10]) {
    const parts: string[] = [];
    for (const id of DIFFICULTY_IDS) {
      const d = generateDungeon(0x5eed, floor);
      const spawns = spawnFloorEnemies(d, 0x5eed, floor, 1, id);
      parts.push(`${id}: boss+${spawns.active.length - 1} minions`);
    }
    process.stdout.write(`F${floor} (boss floor)  ${parts.join("  |  ")}\n`);
  }

  process.stdout.write("\n== sustain: ambient heart chances + measured drops over 1000 kills ==\n");
  for (const id of DIFFICULTY_IDS) {
    const mult = DIFFICULTIES[id].heartMult;
    const drops = measureHearts(id, 1000);
    process.stdout.write(
      `${id.padEnd(9)} enemy=${(6 * mult).toFixed(1)}%  crate=${(6 * mult).toFixed(1)}%  woodChest=${(15 * mult).toFixed(2)}%  measured=${drops} hearts/1000 kills\n`,
    );
  }

  process.stdout.write("\n== spawn grace (floor-entry mercy invuln) ==\n");
  for (const id of DIFFICULTY_IDS) {
    const w = createWorld(0x6ACE, 1, { difficulty: id });
    process.stdout.write(`${id.padEnd(9)} ${w.players.get(LOCAL_ID)!.invuln.toFixed(2)}s\n`);
  }

  if (!isDifficultyOrderSane()) {
    process.stdout.write("\nWARNING: difficulty ordering violated (casual should be the softest)\n");
    process.exit(1);
  }
}

function isDifficultyOrderSane(): boolean {
  const c = DIFFICULTIES.casual, s = DIFFICULTIES.standard, b = DIFFICULTIES.brutal;
  return c.enemyHpMult <= s.enemyHpMult && s.enemyHpMult <= b.enemyHpMult
    && c.threatMult <= s.threatMult && s.threatMult <= b.threatMult
    && c.heartMult >= s.heartMult && s.heartMult >= b.heartMult;
}

main();
