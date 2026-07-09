// Balance ship gates (docs/specs/blobrogue_BALANCE_FINAL_impl.md §7) as deterministic,
// CI-runnable assertions against the authoritative sim. Where a gate is a live-telemetry
// target (median hearts collected per floor, damage events suffered), the test pins the
// generating rates/mechanisms it derives from; everything else is measured by actually
// running the simulation.
//
// Run: npm run test:balance

import {
  createWorld, stepWorld, descend, devSpawnEnemy, applyItemToWorld, acquireWeaponInWorld,
  spawnPlayerInWorld, isFloorCleared,
} from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, EnemyKind, WeaponId } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import {
  ENEMY_ARCHETYPES, enemyHpForFloor, enemySpeedForFloor, createEnemy, spawnFloorEnemies,
  threatCostOf, isBossFloor,
} from "../src/sim/enemies.js";
import { generateDungeon } from "../src/sim/dungeon.js";
import { WEAPONS } from "../src/sim/weapons.js";
import {
  PLAYER, SUSTAIN, DEALER, REVIVE, FANG_PROC_COOLDOWN, BOSS, MARROW, CHOIR, WEAVER, GILDED,
  CAPS, TIERS,
  PERMANENT_ADVANTAGE_CEILING, bossHpForFloor, marrowHpForFloor, choirHpForFloor,
  weaverHpForFloor, gildedHpForFloor, floorThreat, activeThreatCap,
  coopMobHpMult, coopBossHpMult, coopThreatMult, coopHeartRateMult, BIOME_PRESSURE,
} from "../src/sim/balance.js";
import { itemById, recomputeMods, createMods, rollItemChoicesWith, ITEMS, MAX_ITEM_LEVEL } from "../src/sim/items.js";
import { biomeIndexForFloor } from "../src/sim/biomes.js";
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

function grant(w: WorldState, pid: PlayerId, ids: string[]): void {
  for (const id of ids) {
    const def = itemById(id);
    if (!def) throw new Error(`unknown item ${id}`);
    applyItemToWorld(w, pid, def);
  }
}

const L3 = (id: string) => [id, id, id];

// A friendly test bullet planted directly on a target (resolves through the ordinary
// strike path: attribution, boss transition machinery, kill, loot).
function plantBullet(w: WorldState, x: number, y: number, damage: number, radius = 20): void {
  const b: Bullet = {
    x, y, vx: 1, vy: 0, radius, life: 0.05, friendly: true, owner: LOCAL_ID,
    damage, color: "#fff", pierce: 0, hitList: null, isCrit: false,
  };
  w.bullets.push(b);
}

function idle(seq: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
}

function step(w: WorldState, cmd: InputCmd): SimEvent[] {
  return stepWorld(w, new Map([[LOCAL_ID, cmd]]), DT);
}

// ---- gate 3 + §3: the exact per-floor HP/speed tables ----

function enemyTableGates(): void {
  section("§3 exact enemy tables (HP + speed per floor, round-half-to-even)");
  type RegularKind = Exclude<EnemyKind, "boss" | "marrow" | "choir" | "weaver" | "gilded">;
  const HP: Record<RegularKind, number[]> = {
    slime: [3, 4, 4, 5, 6, 6, 7, 7, 8, 8],
    bat: [2, 2, 3, 3, 4, 4, 5, 5, 5, 5],
    skeleton: [6, 8, 9, 10, 12, 13, 14, 15, 16, 16],
    ghost: [4, 5, 6, 7, 8, 8, 9, 10, 10, 11],
    spitter: [3, 4, 4, 5, 6, 6, 7, 7, 8, 8],
    charger: [5, 6, 8, 9, 10, 11, 12, 12, 13, 14],
    burrower: [4, 5, 6, 7, 8, 8, 9, 10, 10, 11],
    orbiter: [3, 4, 4, 5, 6, 6, 7, 7, 8, 8],
    shielder: [5, 6, 8, 9, 10, 11, 12, 12, 13, 14],
  };
  const SPEED: Record<RegularKind, number[]> = {
    slime: [42, 43, 44, 45, 45, 46, 47, 47, 48, 49],
    bat: [96, 98, 100, 102, 103, 105, 107, 108, 109, 111],
    skeleton: [62, 63, 64, 66, 66, 68, 69, 70, 71, 72],
    ghost: [56, 57, 58, 59, 60, 61, 62, 63, 64, 65],
    spitter: [30, 31, 31, 32, 32, 33, 33, 34, 34, 35],
    charger: [46, 47, 48, 49, 49, 50, 51, 52, 52, 53],
    burrower: [40, 41, 42, 42, 43, 44, 44, 45, 46, 46],
    orbiter: [95, 97, 99, 101, 102, 104, 105, 107, 108, 110],
    shielder: [50, 51, 52, 53, 54, 55, 56, 56, 57, 58],
  };
  for (const kind of Object.keys(HP) as RegularKind[]) {
    let hpOk = true, spOk = true;
    for (let f = 1; f <= 10; f++) {
      if (enemyHpForFloor(kind, f) !== HP[kind][f - 1]) hpOk = false;
      if (enemySpeedForFloor(kind, f) !== SPEED[kind][f - 1]) spOk = false;
    }
    check(`${kind} HP table matches spec §3`, hpOk);
    check(`${kind} speed table matches spec §3`, spOk);
  }
  check("damage never scales with floor (all archetypes deal 1 contact)",
    (Object.keys(HP) as EnemyKind[]).every((k) => ENEMY_ARCHETYPES[k].touchDamage === 1));
  check("floors beyond 10 clamp to the F10 envelope", enemyHpForFloor("skeleton", 14) === 16);
}

// ---- gate 1: Slime King TTK (median 35–50s, high-roll ≥20s, floor calibrated at 950) ----

interface TtkResult { seconds: number; killed: boolean; transitions: Array<{ entering: boolean; at: number; queued: number }> }

function measureBossTtk(weapon: WeaponId, picks: string[], boss: { kind: EnemyKind; floor: number } = { kind: "boss", floor: 5 }): TtkResult {
  const w = createWorld(0xBA1A4CE, boss.floor, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  acquireWeaponInWorld(w, LOCAL_ID, weapon);
  grant(w, LOCAL_ID, picks);
  const target = devSpawnEnemy(w, boss.kind, p.x + 170, p.y);
  const transitions: TtkResult["transitions"] = [];
  let ticks = 0;
  let killed = false;
  const maxTicks = 60 * 120;
  while (!killed && ticks < maxTicks) {
    const aim = Math.atan2(target.y - p.y, target.x - p.x);
    const evs = step(w, { seq: ticks, moveX: 0, moveY: 0, aim, firing: true, dash: false });
    for (const e of evs) {
      if (e.t === "bossTransition") transitions.push({ entering: e.entering, at: ticks * DT, queued: e.queued });
      if (e.t === "enemyKill" && e.kind === boss.kind) killed = true;
    }
    ticks++;
  }
  return { seconds: ticks * DT, killed, transitions };
}

function bossTtkGates(): void {
  section("gate 1: Slime King solo TTK (950 HP at F5, post spent-round-fix calibration)");
  check("F5 boss HP is exactly 950", bossHpForFloor(5) === 950, `hp=${bossHpForFloor(5)}`);
  check("F10 boss stays within the ≤1.5x later-boss ceiling", bossHpForFloor(10) <= 950 * 1.5, `hp=${bossHpForFloor(10)}`);
  check("boss contact damage is 2 (was 3)", ENEMY_ARCHETYPES.boss.touchDamage === 2);

  const median = measureBossTtk("pistol", L3("hair_trigger"));
  check("median legal build (pistol + Hair Trigger Lv3) kills in 35–50s",
    median.killed && median.seconds >= 35 && median.seconds <= 50, `ttk=${median.seconds.toFixed(1)}s`);

  const highRolls: Array<[string, TtkResult]> = [
    ["smg + Deadeye Lv3 + Glass Cannon", measureBossTtk("smg", [...L3("deadeye"), "glass_cannon"])],
    ["point-blank shotgun + Deadeye Lv3 + Glass Cannon", measureBossTtk("shotgun", [...L3("deadeye"), "glass_cannon"])],
    ["point-blank sawnoff + Deadeye Lv3 + Glass Cannon", measureBossTtk("sawnoff", [...L3("deadeye"), "glass_cannon"])],
  ];
  for (const [label, r] of highRolls) {
    check(`high-roll ${label} stays ≥20s`, r.killed && r.seconds >= 20, `ttk=${r.seconds.toFixed(1)}s`);
  }
  const fastest = Math.min(...highRolls.map(([, r]) => r.seconds));
  process.stdout.write(`  info: median=${median.seconds.toFixed(1)}s, fastest legal high-roll=${fastest.toFixed(1)}s (old model: 154 HP ≈ 3s)\n`);

  section("gate 2: transition beats ≤1.2s each, ≤2.4s total, queued-overflow logging present");
  const enters = median.transitions.filter((t) => t.entering);
  const exits = median.transitions.filter((t) => !t.entering);
  check("exactly two transition beats fire across the fight", enters.length === 2 && exits.length === 2,
    `enters=${enters.length} exits=${exits.length}`);
  let total = 0;
  let eachOk = true;
  for (let i = 0; i < Math.min(enters.length, exits.length); i++) {
    const dur = exits[i].at - enters[i].at;
    total += dur;
    if (dur > BOSS.roarDuration + 2 * DT) eachOk = false;
  }
  check("no reduction beat exceeds 1.2s", eachOk);
  check("total forced transition time ≤ 2.4s", total <= 2 * BOSS.roarDuration + 4 * DT, `total=${total.toFixed(2)}s`);
}

// ---- §5b MARROW: same TTK band and anti-burst contract, deeper anchor ----

function marrowGates(): void {
  section("§5b MARROW TTK (calibrated at F10, same 30–45s median band)");
  check("F10 Marrow HP matches its calibration anchor", marrowHpForFloor(10) === MARROW.baseHp, `hp=${marrowHpForFloor(10)}`);
  check("deeper Marrows stay within the ≤1.5x later-boss ceiling", marrowHpForFloor(20) <= MARROW.baseHp * 1.5,
    `hp=${marrowHpForFloor(20)}`);
  check("Marrow contact damage is 2 (like the King — never scales)", ENEMY_ARCHETYPES.marrow.touchDamage === 2);

  // F10 median build ≈ Hair Trigger Lv3 + Glass Cannon Lv2 on the pistol (~39 sustained DPS).
  const median = measureBossTtk("pistol", [...L3("hair_trigger"), "glass_cannon", "glass_cannon"], { kind: "marrow", floor: 10 });
  check("F10 median build kills MARROW in 30–45s",
    median.killed && median.seconds >= 30 && median.seconds <= 45, `ttk=${median.seconds.toFixed(1)}s`);
  const highRoll = measureBossTtk("smg", [...L3("deadeye"), "glass_cannon", "glass_cannon"], { kind: "marrow", floor: 10 });
  check("high-roll (smg + Deadeye Lv3 + Glass Cannon Lv2) stays ≥20s",
    highRoll.killed && highRoll.seconds >= 20, `ttk=${highRoll.seconds.toFixed(1)}s`);
  process.stdout.write(`  info: marrow median=${median.seconds.toFixed(1)}s, high-roll=${highRoll.seconds.toFixed(1)}s (band 30–45s)\n`);

  section("§5b shield beats: two per fight, bounded, interactive");
  const enters = median.transitions.filter((t) => t.entering);
  const exits = median.transitions.filter((t) => !t.entering);
  check("exactly two shield beats fire across the fight", enters.length === 2 && exits.length === 2,
    `enters=${enters.length} exits=${exits.length}`);
  let eachOk = true;
  let total = 0;
  for (let i = 0; i < Math.min(enters.length, exits.length); i++) {
    const dur = exits[i].at - enters[i].at;
    total += dur;
    if (dur > MARROW.shieldDuration + 2 * DT) eachOk = false;
  }
  check("no shield beat exceeds its 2.6s cap", eachOk);
  check("worst-case forced downtime ≤ 2×2.6s (and breakable early via the husks)",
    total <= 2 * MARROW.shieldDuration + 4 * DT, `total=${total.toFixed(2)}s`);
  check("the beat always reads: minimum duration under the cap",
    MARROW.shieldMinDuration > 0 && MARROW.shieldMinDuration < MARROW.shieldDuration);
  check("shield is reduction, not immunity", MARROW.shieldDamageReduction < 1 && MARROW.shieldDamageReduction === BOSS.roarDamageReduction);
}

// ---- §5c–§5e the deep roster: every boss lands in the same F10 TTK band ----

function deepRosterGates(): void {
  section("§5c–§5e deep-roster TTK (Hollow Choir / Weaver / Gilded Warden, 30–45s median band)");
  check("F10 anchors match", choirHpForFloor(10) === CHOIR.baseHp && weaverHpForFloor(10) === WEAVER.baseHp
    && gildedHpForFloor(10) === GILDED.baseHp,
    `choir=${choirHpForFloor(10)} weaver=${weaverHpForFloor(10)} gilded=${gildedHpForFloor(10)}`);
  check("every deep boss deals 2 contact (never scales)",
    ENEMY_ARCHETYPES.choir.touchDamage === 2 && ENEMY_ARCHETYPES.weaver.touchDamage === 2 && ENEMY_ARCHETYPES.gilded.touchDamage === 2);

  const build = [...L3("hair_trigger"), "glass_cannon", "glass_cannon"];
  const bands: Array<[EnemyKind, TtkResult]> = [
    ["choir", measureBossTtk("pistol", build, { kind: "choir", floor: 10 })],
    ["weaver", measureBossTtk("pistol", build, { kind: "weaver", floor: 10 })],
    ["gilded", measureBossTtk("pistol", build, { kind: "gilded", floor: 10 })],
  ];
  for (const [kind, r] of bands) {
    check(`F10 median build kills the ${kind} in 30–45s`, r.killed && r.seconds >= 30 && r.seconds <= 45,
      `ttk=${r.seconds.toFixed(1)}s`);
    const enters = r.transitions.filter((t) => t.entering).length;
    const exits = r.transitions.filter((t) => !t.entering).length;
    check(`the ${kind} fight walks both transition beats`, enters === 2 && exits === 2,
      `enters=${enters} exits=${exits}`);
  }
  process.stdout.write(`  info: ${bands.map(([k, r]) => `${k}=${r.seconds.toFixed(1)}s`).join(", ")}\n`);

  // Beat caps per boss: the Choir's split (its longest allowed beat) still caps under 3.2s
  // each; the Weaver's molt and Warden's sanctify are fixed short beats.
  for (const [kind, r] of bands) {
    const enters = r.transitions.filter((t) => t.entering);
    const exits = r.transitions.filter((t) => !t.entering);
    const cap = kind === "choir" ? CHOIR.splitDuration : kind === "weaver" ? WEAVER.moltDuration : GILDED.sanctifyDuration;
    let ok = true;
    for (let i = 0; i < Math.min(enters.length, exits.length); i++) {
      if (exits[i].at - enters[i].at > cap + 2 * DT) ok = false;
    }
    check(`no ${kind} beat exceeds its ${cap}s cap`, ok);
  }
  check("the Warden's plate is tempo, never immunity (chip is 30%, exposed windows ≥2s)",
    GILDED.armorChip > 0 && GILDED.slamRecover >= 2 && GILDED.sweepRecover >= 2);
}

// The anti-burst floor as a hard mechanism: even an absurd single hit cannot delete the
// boss — damage floors at 62%/27%, the overflow queues, and applies only after each full
// 1.2s roar. Kill time under INFINITE damage is still ≥ 2×1.2s.
function bossOverflowGates(): void {
  section("gate 2 mechanism: phase floors + queued overflow under extreme burst");
  const w = createWorld(0x0DDBA11, 5, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  const boss = devSpawnEnemy(w, "boss", p.x + 100, p.y);

  plantBullet(w, boss.x, boss.y, 1e6, 40);
  let events = step(w, idle(1));
  const enter1 = events.find((e) => e.t === "bossTransition" && e.entering);
  check("a million-damage hit floors the boss at 62%", Math.abs(boss.hp - 0.62 * boss.maxHp) < 1e-6, `hp=${boss.hp}`);
  check("the overflow is queued and logged", enter1 !== undefined && enter1.t === "bossTransition" && enter1.queued > 0,
    enter1 && enter1.t === "bossTransition" ? `queued=${enter1.queued.toFixed(0)}` : "no event");

  let ticks = 1;
  let dead = false;
  while (!dead && ticks < 60 * 10) {
    events = step(w, idle(ticks + 1));
    if (events.some((e) => e.t === "enemyKill" && e.kind === "boss")) dead = true;
    ticks++;
  }
  const seconds = ticks * DT;
  check("boss dies only after BOTH full roars resolve the queued overflow", dead && seconds >= 2 * BOSS.roarDuration,
    `death at ${seconds.toFixed(2)}s (was ~1 tick pre-reset)`);
  check("boss death ends danger: all adds despawn and the exit opens", isFloorCleared(w),
    `enemies=${w.enemies.length} pending=${w.pendingSpawns.length}`);
}

// ---- gate 3: normal/brute/elite focused TTK at representative legal builds ----

function measureFocusedTtk(kind: EnemyKind, floor: number, weapon: WeaponId, picks: string[]): number {
  const w = createWorld(0xF0C05, floor, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  acquireWeaponInWorld(w, LOCAL_ID, weapon);
  grant(w, LOCAL_ID, picks);
  const target = devSpawnEnemy(w, kind, p.x + 140, p.y);
  let ticks = 0;
  while (!target.dead && ticks < 60 * 20) {
    const aim = Math.atan2(target.y - p.y, target.x - p.x);
    step(w, { seq: ticks, moveX: 0, moveY: 0, aim, firing: true, dash: false });
    ticks++;
  }
  return ticks * DT;
}

function normalTtkGates(): void {
  section("gate 3: focused TTK bands (normals fast, brutes 1.8–3.2s, elites 3–6s)");
  const f1 = measureFocusedTtk("slime", 1, "pistol", []);
  check("F1 slime focused TTK ≤ 0.9s (no picks)", f1 <= 0.9, `ttk=${f1.toFixed(2)}s`);
  const f2 = measureFocusedTtk("skeleton", 2, "pistol", []);
  check("F2 skeleton focused TTK ≤ 0.9s (no picks)", f2 <= 0.9, `ttk=${f2.toFixed(2)}s`);
  // Late-floor median build ≈ Hair Trigger Lv3 + Glass Cannon Lv2 (~7 picks by F9).
  const late = measureFocusedTtk("skeleton", 9, "pistol", [...L3("hair_trigger"), "glass_cannon", "glass_cannon"]);
  check("F9 skeleton focused TTK ≤ 1.4s at a late median build (HP never sponges)", late <= 1.4, `ttk=${late.toFixed(2)}s`);

  // Tier bands, measured against the same late median build on their first-eligible floors.
  const bruteHp = createEnemy("skeleton", 0, 0, 4, new Rng(1), 0, { tier: "brute" }).hp;
  check("brute = 2.40x scaled HP (6 x 1.72 x 2.4 -> 25)", bruteHp === 25, `hp=${bruteHp}`);
  const eliteHp = createEnemy("spitter", 0, 0, 6, new Rng(1), 0, { tier: "elite" }).hp;
  check("elite = 1.70x scaled HP (3 x 2.12 x 1.7 -> 11; one affix, never doubled stats)", eliteHp === 11, `hp=${eliteHp}`);
  const swarm = createEnemy("slime", 0, 0, 1, new Rng(1), 0, { tier: "swarm" });
  check("swarm = 0.55x HP / 1.15x speed / 0.78x radius", swarm.hp === 2 && swarm.speed === 48
    && Math.abs(swarm.radius - 16 * 0.78) < 1e-9, `hp=${swarm.hp} speed=${swarm.speed}`);
}

// ---- base-pistol reality check: the tables must actually hold up in live autofire ----
// Regression net for the "packs melt instantly" bug: a spent pierce-0 round could strike
// every body overlapping its final segment in the same tick (phantom pierce), so clumped
// enemies took far more damage than the §3 tables authorize. These gates measure LIVE
// solo autofire against the sim, so neither that bug nor an HP-table wiring break can
// come back silently.

function measurePackTtk(kind: EnemyKind, count: number, floor: number): number {
  const w = createWorld(0x9ACC0, floor, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  const pack: ReturnType<typeof devSpawnEnemy>[] = [];
  for (let i = 0; i < count; i++) {
    const e = devSpawnEnemy(w, kind, p.x + 140 + i * 8, p.y + (i % 3) * 6 - 6);
    pack.push(e);
  }
  let ticks = 0;
  while (pack.some((e) => !e.dead) && ticks < 60 * 30) {
    const target = pack.find((e) => !e.dead)!;
    const aim = Math.atan2(target.y - p.y, target.x - p.x);
    step(w, { seq: ticks, moveX: 0, moveY: 0, aim, firing: true, dash: false });
    ticks++;
  }
  return ticks * DT;
}

function pistolBaselineGates(): void {
  section("base-pistol baseline: early enemies are a fight, never an instant delete");
  // Mechanism: one pierce-0 round through a PERFECT stack strikes exactly one body.
  {
    const w = createWorld(0x57ACC, 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    const stack = [
      devSpawnEnemy(w, "slime", p.x + 80, p.y),
      devSpawnEnemy(w, "slime", p.x + 80, p.y),
      devSpawnEnemy(w, "slime", p.x + 80, p.y),
    ];
    w.bullets.push({
      x: p.x + 40, y: p.y, vx: 560, vy: 0, radius: 6, life: 1.1, friendly: true,
      owner: LOCAL_ID, damage: 2, color: "#fff", pierce: 0, hitList: null, isCrit: false,
    });
    // Fly the round into the stack: the tick it lands, it must stop at the FIRST body
    // (with the phantom-pierce bug, that same tick struck all three).
    for (let t = 0; t < 10 && stack.every((e) => e.hp === e.maxHp); t++) stepWorld(w, new Map(), DT);
    const struck = stack.filter((e) => e.hp < e.maxHp).length;
    check("a spent pierce-0 round strikes exactly ONE body in a perfect stack (no phantom pierce)",
      struck === 1, `struck=${struck}/3`);
  }

  // Table wiring: the starting pistol can never one-shot the tutorial bodies.
  check("a single base-pistol round never deletes a full-HP F1 slime",
    enemyHpForFloor("slime", 1) > WEAPONS.pistol.damage,
    `hp=${enemyHpForFloor("slime", 1)} vs dmg=${WEAPONS.pistol.damage}`);
  check("an F1 skeleton takes at least three base-pistol rounds",
    enemyHpForFloor("skeleton", 1) > 2 * WEAPONS.pistol.damage,
    `hp=${enemyHpForFloor("skeleton", 1)}`);

  // Live autofire TTKs (base pistol, no picks): a beat, not an instant — and still fast
  // (gate 3's ≤0.9s ceilings hold above). Tick floors per the ship-gate contract.
  const slime = measureFocusedTtk("slime", 1, "pistol", []);
  check("F1 slime vs base pistol lives ≥ 20 ticks (0.33s) of live autofire",
    slime >= 20 * DT, `ttk=${slime.toFixed(2)}s (${Math.round(slime / DT)} ticks)`);
  const skeleton = measureFocusedTtk("skeleton", 2, "pistol", []);
  check("F2 skeleton vs base pistol lives ≥ 0.4s of live autofire",
    skeleton >= 0.4, `ttk=${skeleton.toFixed(2)}s`);
  const pack = measurePackTtk("skeleton", 10, 2);
  check("a 10-skeleton F2 pack vs base pistol is a real fight (≥ 5s, ~40 rounds)",
    pack >= 5, `ttk=${pack.toFixed(2)}s`);
  process.stdout.write(`  info: base pistol — F1 slime=${slime.toFixed(2)}s, F2 skeleton=${skeleton.toFixed(2)}s, 10-pack=${pack.toFixed(2)}s\n`);
}

// ---- §4: threat budgets, tier gates, composition guards ----

function threatBudgetGates(): void {
  section("§4 threat budget: spend by cost, cap actives, respect tier/composition gates");
  check("FloorThreat formula", floorThreat(1) === 6 && floorThreat(5) === 14 && floorThreat(10) === 24 && floorThreat(30) === 30);
  check("ActiveThreatCap formula", activeThreatCap(1) === 9 && activeThreatCap(8) === 16 && activeThreatCap(20) === 16);

  let budgetOk = true, capOk = true, tierGateOk = true, comboGateOk = true, complexGateOk = true;
  for (let seedIdx = 0; seedIdx < 20; seedIdx++) {
    const seed = 0x5eed + seedIdx * 7919;
    for (let floor = 1; floor <= 10; floor++) {
      if (isBossFloor(floor)) continue;
      const d = generateDungeon(seed, floor);
      const spawns = spawnFloorEnemies(d, seed, floor);
      const all = [...spawns.active, ...spawns.pending];
      const totalCost = all.reduce((s, e) => s + threatCostOf(e.kind, e.tier), 0);
      const budget = floorThreat(floor) * BIOME_PRESSURE[biomeIndexForFloor(floor)].budgetMult;
      if (totalCost > budget + 1e-9) budgetOk = false;
      const activeCost = spawns.active.reduce((s, e) => s + threatCostOf(e.kind, e.tier), 0);
      if (activeCost > activeThreatCap(floor) + 1e-9) capOk = false;
      for (const e of all) {
        if (TIERS[e.tier].minFloor > floor) tierGateOk = false;
      }
      // Per-room guards: ≤2 complex archetypes; no brute+elite combo before floor 8.
      for (const room of d.rooms) {
        const inRoom = all.filter((e) =>
          e.x >= room.x * TILE && e.x < (room.x + room.w) * TILE &&
          e.y >= room.y * TILE && e.y < (room.y + room.h) * TILE);
        const complex = inRoom.filter((e) => ENEMY_ARCHETYPES[e.kind].threat > 1).length;
        if (complex > 2) complexGateOk = false;
        if (floor < 8 && inRoom.some((e) => e.tier === "brute") && inRoom.some((e) => e.tier === "elite")) comboGateOk = false;
      }
    }
  }
  check("total planned cost never exceeds FloorThreat x biome budget", budgetOk);
  check("initially-active cost never exceeds ActiveThreatCap", capOk);
  check("no tier appears before its first floor (brute F4, elite F6)", tierGateOk);
  check("≤2 complex archetypes per room", complexGateOk);
  check("no brute+elite room combo before floor 8", comboGateOk);
  const EPS = 1e-9;
  check("every commitment leaves ≥0.30s post-lock dodge and ≥0.35s recovery",
    C.SKELETON_WINDUP - C.SKELETON_LOCK >= 0.30 - EPS && C.SKELETON_RECOVER >= 0.35 - EPS
    && C.SPITTER_WINDUP - C.SPITTER_LOCK >= 0.30 - EPS && C.SPITTER_RECOVER >= 0.35 - EPS
    && BOSS.hopWindup - BOSS.hopLock >= 0.30 - EPS && BOSS.hopRecover >= 0.35 - EPS && BOSS.radialRecover >= 0.35 - EPS
    && C.CHARGER_WINDUP - C.CHARGER_LOCK >= 0.30 - EPS && C.CHARGER_RECOVER >= 0.35 - EPS
    // The burrower's eruption mark is frozen from the windup's first tick, so the whole
    // windup is the post-lock dodge window.
    && C.BURROW_ERUPT_WINDUP >= 0.30 - EPS && C.BURROW_RECOVER >= 0.35 - EPS
    && MARROW.chargeWindup - MARROW.chargeLock >= 0.30 - EPS && MARROW.chargeRecover >= 0.35 - EPS
    && MARROW.volleyWindup - MARROW.volleyLock >= 0.30 - EPS && MARROW.volleyRecover >= 0.35 - EPS
    && MARROW.spinRecover >= 0.35 - EPS);

  // The cap holds LIVE too: on a deep floor the reinforcement queue only releases into room
  // under the cap.
  const w = createWorld(0xCA9, 8);
  w.isGodMode = true;
  let liveOk = true;
  let released = false;
  for (let t = 0; t < 60 * 30; t++) {
    const evs = step(w, idle(t));
    if (evs.some((e) => e.t === "enemySpawn")) released = true;
    const living = w.enemies.reduce((s, e) => s + (e.dead || e.kind === "boss" ? 0 : threatCostOf(e.kind, e.tier)), 0);
    if (living > activeThreatCap(8) + 1e-9) liveOk = false;
  }
  check("living threat stays under the cap for 30 simulated seconds on F8", liveOk);
  check("F8 exceeds the cap at spawn, so reinforcements released over time", released || w.pendingSpawns.length > 0);
}

// ---- gate 4 + §2: heart economy rates and mechanisms ----

function sustainGates(): void {
  section("gate 4 + §2: heart economy (rates halved, conversions, pity, Fang cooldown)");
  check("enemy heart drop 6% (was 12%)", SUSTAIN.enemyHeartDrop === 0.06);
  check("crate heart 6% (was 15%)", SUSTAIN.crateHeartDrop === 0.06);
  check("wood chest heart 15% (was 20%)", SUSTAIN.woodChestHeart === 0.15);
  check("normal-descent heal removed (was +2)", SUSTAIN.descentHeal === 0);
  check("Fang Lv3 expectation ≤1.7 hearts / 10 eligible kills",
    (itemById("vampire_fang") !== undefined) && (() => {
      const m = createMods();
      recomputeMods(m, L3("vampire_fang"));
      return m.lifestealChance * 10 <= 1.7 + 1e-9;
    })());

  // Descent heals nothing.
  {
    const w = createWorld(0xD5C, 1);
    const p = w.players.get(LOCAL_ID)!;
    p.hp = 3;
    descend(w, 2, []);
    check("descend leaves HP untouched", p.hp === 3, `hp=${p.hp}`);
  }

  // A loose heart at full HP converts to 2 coins.
  {
    const w = createWorld(0xF00D, 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    w.pickups.push({ id: 99, kind: "heart", x: p.x, y: p.y, radius: 13, weapon: null });
    const evs = step(w, idle(1));
    check("full-HP heart consumed and converted to 2 coins", p.coins === 2 && p.hp === p.maxHp
      && !w.pickups.some((k) => k.id === 99) && evs.some((e) => e.t === "pickup" && e.kind === "coin"));
  }

  // Fang: shared 1.25s proc cooldown; summoned adds are excluded entirely.
  {
    const w = createWorld(0xFA46, 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    p.mods.lifestealChance = 1;
    p.hp = 1;
    const a = devSpawnEnemy(w, "slime", p.x + 300, p.y);
    const b = devSpawnEnemy(w, "slime", p.x + 340, p.y);
    plantBullet(w, a.x, a.y, 99, 10);
    plantBullet(w, b.x, b.y, 99, 10);
    step(w, idle(1));
    check("two same-window kills at 100% Fang heal exactly once (1.25s shared cooldown)",
      p.hp === 2 && p.fangCd > 0, `hp=${p.hp} fangCd=${p.fangCd.toFixed(2)}`);
    const summoned = createEnemy("slime", p.x + 300, p.y, 1, w.rng, w.nextEnemyId++, { isSummoned: true });
    w.enemies.push(summoned);
    p.fangCd = 0;
    plantBullet(w, summoned.x, summoned.y, 99, 10);
    step(w, idle(2));
    check("summoned adds never proc Fang or drop hearts", p.hp === 2 && !w.pickups.some((k) => k.kind === "heart"));
  }

  // Recovery pity: two consecutive dry sub-50% floors force a heart into the next wood chest.
  {
    const w = createWorld(0x917, 1);
    const p = w.players.get(LOCAL_ID)!;
    p.hp = 2;
    w.isFloorEnteredLow = true; // entered floor 1 low (createWorld snapshotted full HP)
    w.heartsThisFloor = 0;
    descend(w, 2, []);
    w.heartsThisFloor = 0;
    descend(w, 3, []);
    check("pity armed after two dry low-entry floors", w.isPityHeartArmed);
    const chest = w.chests.find((c) => c.kind === "wood");
    check("floor has a wood chest to receive the pity heart", chest !== undefined);
    if (chest) {
      p.x = chest.x; p.y = chest.y;
      step(w, idle(1));
      check("the next wood chest is forced to hold a heart", w.heartsThisFloor === 1 && !w.isPityHeartArmed,
        `heartsGenerated=${w.heartsThisFloor}`);
    }
  }

  // Dealer: floors 3/6/9 stock a +1 heart at 6 coins; never a full heal, never free.
  {
    const w = createWorld(0xDEA1, 3);
    const dealer = w.pickups.find((k) => k.kind === "dealer_heart");
    check("floor 3 stocks a dealer heart priced at 6 coins", dealer !== undefined && dealer.value === DEALER.price);
    if (dealer) {
      const p = w.players.get(LOCAL_ID)!;
      p.hp = 3; p.coins = 5;
      p.x = dealer.x; p.y = dealer.y;
      step(w, idle(1));
      check("a broke player cannot buy", p.hp === 3 && w.pickups.includes(dealer));
      p.coins = 7;
      step(w, idle(2));
      check("6 coins buys exactly +1 HP", p.hp === 4 && p.coins === 1 && !w.pickups.includes(dealer));
    }
    check("no dealer on non-interval floors", createWorld(0xDEA1, 4).pickups.every((k) => k.kind !== "dealer_heart"));
  }
}

// ---- gate 6: Second Wind Lv3 dash iframe uptime 50–52%, non-refreshing, separate windows ----

function dashIframeGates(): void {
  section("gate 6: dash iframe (0.18s) uptime + separation from post-hit protection");
  {
    const m = createMods();
    recomputeMods(m, ["second_wind"]);
    const lv1 = m.dashCdMult;
    recomputeMods(m, ["second_wind", "second_wind"]);
    const lv2 = m.dashCdMult;
    recomputeMods(m, L3("second_wind"));
    const lv3 = m.dashCdMult;
    check("Second Wind is a level LOOKUP (0.65/0.55/0.50), never multiplied copy-over-copy",
      lv1 === 0.65 && lv2 === 0.55 && lv3 === 0.50, `got ${lv1}/${lv2}/${lv3}`);
  }
  const w = createWorld(0xDA51, 1, { isSandbox: true });
  w.isGodMode = true;
  grant(w, LOCAL_ID, L3("second_wind"));
  const p = w.players.get(LOCAL_ID)!;
  // Continuous-optimal-dash: hold dash+move every tick for 60 seconds and integrate the
  // TIME the dash iframe is live. A dash tick is fully covered (the iframe is set before
  // any damage check); afterwards each tick consumes min(remaining, dt).
  // Theoretical: 0.18 / 0.35 = 51.4%.
  let protectedTime = 0;
  let prevInvuln = 0;
  const N = 60 * 60;
  for (let t = 0; t < N; t++) {
    const evs = step(w, { seq: t, moveX: (t % 40) < 20 ? 1 : -1, moveY: 0, aim: 0, firing: false, dash: true });
    protectedTime += evs.some((e) => e.t === "dashStart") ? DT : Math.min(prevInvuln, DT);
    prevInvuln = p.dashInvuln;
  }
  const uptime = protectedTime / (N * DT);
  check("continuous-optimal-dash iframe uptime is 50–52%", uptime >= 0.50 && uptime <= 0.52, `uptime=${(uptime * 100).toFixed(1)}%`);
  check("the iframe never overlaps/refreshes: it always expires before the next dash",
    PLAYER.dashIframe < PLAYER.dashCooldown * 0.50);
  check("post-hit protection is 0.80s and never extends the dash window",
    PLAYER.postHitInvuln === 0.80 && PLAYER.dashIframe === 0.18);
}

// ---- gate 7: reward cadence + zero raw-cap violations across 100,000 legal builds ----

function powerBudgetGates(): void {
  section("gate 7: pick cadence (4 by F5, 8–9 by F10) and raw caps over 100k builds");
  {
    const w = createWorld(0xCAD3, 1);
    let offers = 0;
    let rareOffers = 0;
    for (let f = 2; f <= 10; f++) {
      const ev: SimEvent[] = [];
      descend(w, f, ev);
      for (const e of ev) {
        if (e.t === "offerBlessing") { offers++; if (e.rare) rareOffers++; }
      }
    }
    // Descents into 2,3,4,5 offer (leaving 1–4); leaving boss floor 5 offers nothing; into
    // 7..10 offer again. Boss chests (F5/F10) add the rare picks on top.
    check("4 blessing offers by F5 entry (descents alone)", offers >= 4 && rareOffers === 0, `offers=${offers}`);
    check("8 descent offers by F10 + boss chest covers the 9th", offers === 8, `offers=${offers}`);
  }
  {
    // Boss chest replaces the boss floor's reward with a Rare-pool offer. Even a scripted
    // burst kill has to ride out both transition roars (the anti-burst floor), so hammer
    // the boss until it actually dies.
    const w = createWorld(0xB0552, 5, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, "boss", p.x + 120, p.y);
    for (let t = 1; t <= 60 * 8 && !boss.dead; t++) {
      plantBullet(w, boss.x, boss.y, 1000, 30);
      step(w, idle(t));
    }
    const chest = w.chests.find((c) => c.kind === "boss");
    check("boss chest spawned", chest !== undefined);
    if (chest) {
      p.x = chest.x; p.y = chest.y;
      const evs = step(w, idle(2));
      const offer = evs.find((e) => e.t === "offerBlessing");
      check("boss chest offer is the Rare pick", offer !== undefined && offer.t === "offerBlessing" && offer.rare);
      const rng = new Rng(7);
      const rares = rollItemChoicesWith(3, () => rng.next(), [], { rareOnly: true });
      check("rare pool rolls only rare blessings", rares.length > 0 && rares.every((it) => it.rarity === "rare"));
    }
  }
  {
    // 100,000 seeded legal builds (random offer -> random pick, up to 12 picks): recompute
    // must never exceed a raw cap, and maxed blessings must leave the offer pool.
    const rng = new Rng(0xCAB5);
    const mods = createMods();
    let violations = 0;
    let maxedOffered = 0;
    const BUILDS = 100_000;
    for (let i = 0; i < BUILDS; i++) {
      const owned: string[] = [];
      const picks = 1 + rng.int(0, 11);
      for (let n = 0; n < picks; n++) {
        const choices = rollItemChoicesWith(3, () => rng.next(), owned);
        if (choices.length === 0) break;
        const levels = new Map<string, number>();
        for (const id of owned) levels.set(id, (levels.get(id) ?? 0) + 1);
        if (choices.some((c) => (levels.get(c.id) ?? 0) >= MAX_ITEM_LEVEL)) maxedOffered++;
        owned.push(choices[rng.int(0, choices.length - 1)].id);
      }
      recomputeMods(mods, owned);
      if (mods.damageMult > CAPS.damageMult || mods.fireRateMult > CAPS.fireRateMult
        || mods.moveSpeedMult > CAPS.moveSpeedMult || mods.maxHpBonus > CAPS.maxHpBonus
        || mods.pierce > CAPS.pierce || mods.burnChance > CAPS.elementalChance
        || mods.chillChance > CAPS.elementalChance || mods.shockChance > CAPS.elementalChance) violations++;
    }
    check(`zero raw-cap violations across ${BUILDS.toLocaleString()} legal builds`, violations === 0, `violations=${violations}`);
    check("maxed (Lv3) blessings never re-enter an offer", maxedOffered === 0, `offered=${maxedOffered}`);
  }
  {
    const w = createWorld(0x11FE, 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    p.hp = 3;
    grant(w, LOCAL_ID, ["vitality"]);
    check("Vitality Lv1 heals exactly 1 heart, never the capacity delta", p.maxHp === 8 && p.hp === 4, `hp=${p.hp}/${p.maxHp}`);
    grant(w, LOCAL_ID, ["vitality", "vitality", "vitality"]);
    check("Vitality caps at Lv3 (+4) and further picks no-op", p.maxHp === 10 && p.ownedItemIds.length === 3);
  }
  check("permanent (Foundation) power ceiling stays <30% when that system lands",
    PERMANENT_ADVANTAGE_CEILING <= 0.30);
}

// ---- §8 co-op scaling (Stage C authoritative combat) ----

function coopScalingGates(): void {
  section("§8 co-op scaling: HP/threat/hearts by snapshotted player count");
  check("mob HP mult 1.00/1.55/2.10/2.65", [1, 2, 3, 4].every((p) => Math.abs(coopMobHpMult(p) - (1 + 0.55 * (p - 1))) < 1e-9));
  check("boss HP mult 1.00/1.65/2.30/2.95", [1, 2, 3, 4].every((p) => Math.abs(coopBossHpMult(p) - (1 + 0.65 * (p - 1))) < 1e-9));
  check("threat mult 1.00/1.35/1.70/2.05", [1, 2, 3, 4].every((p) => Math.abs(coopThreatMult(p) - (1 + 0.35 * (p - 1))) < 1e-9));
  check("heart rate mult 1.00/1.30/1.60/1.90", [1, 2, 3, 4].every((p) => Math.abs(coopHeartRateMult(p) - (1 + 0.30 * (p - 1))) < 1e-9));

  const rng = new Rng(3);
  const duoSkeleton = createEnemy("skeleton", 0, 0, 3, rng, 0, { players: 2 });
  check("duo F3 skeleton HP = round(9 x 1.55)", duoSkeleton.hp === 14, `hp=${duoSkeleton.hp}`);
  const duoBoss = createEnemy("boss", 0, 0, 5, rng, 1, { players: 2 });
  check("duo F5 boss HP = round10(950 x 1.65)", duoBoss.hp === 1570, `hp=${duoBoss.hp}`);

  // Snapshot at encounter creation: the floor build carries P; later loads re-snapshot.
  const w = createWorld(0xC0093, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(w, "pA");
  spawnPlayerInWorld(w, "pB");
  check("pre-join world built at P=1", w.encounterPlayers === 1);
  descend(w, 2, []);
  check("post-descend floor snapshots P=2", w.encounterPlayers === 2);
  const someMob = w.enemies.find((e) => e.kind !== "boss" && e.tier === "standard");
  check("the new floor's enemies carry the duo HP scale",
    someMob !== undefined && someMob.hp === Math.max(1, Math.round(enemyHpForFloor(someMob.kind, 2) * 1.55)),
    someMob ? `${someMob.kind} hp=${someMob.hp}` : "no standard mob spawned");
}

// ---- §2 revive: 1.5s channel, damage cancels, 2 HP + 1.0s protection + 0.35s lockout ----

function reviveGates(): void {
  section("§2 revive: channel/cancel/lockout");
  check("revive constants: 2 HP / 1.5s channel / 1.0s protection / 0.35s lockout",
    REVIVE.hp === 2 && REVIVE.channel === 1.5 && REVIVE.invuln === 1.0 && REVIVE.fireLockout === 0.35);
  check("Fang shared proc cooldown is 1.25s", FANG_PROC_COOLDOWN === 1.25);

  const w = createWorld(0x4E1BE, 1, { isShared: true, skipLocalPlayer: true });
  const a = spawnPlayerInWorld(w, "pA");
  const b = spawnPlayerInWorld(w, "pB");
  w.enemies = []; w.pendingSpawns = [];
  a.hp = 1;
  // Down A through an enemy bullet.
  w.bullets.push({ x: a.x, y: a.y, vx: 1, vy: 0, radius: 10, life: 0.05, friendly: false, owner: null, damage: 5, color: "#fff", pierce: 0, hitList: null, isCrit: false });
  stepWorld(w, new Map(), DT);
  check("A goes down with a standing ally", a.isDown);
  b.x = a.x; b.y = a.y + 10;
  // 1.2s of channel is not enough at the 1.5s requirement.
  for (let t = 0; t < Math.round(1.2 / DT); t++) stepWorld(w, new Map(), DT);
  check("1.2s of channel does not revive (1.5s required)", a.isDown, `progress=${a.reviveProgress.toFixed(2)}`);
  // Damage to the channeler restarts the whole channel from zero.
  w.bullets.push({ x: b.x, y: b.y, vx: 1, vy: 0, radius: 10, life: 0.05, friendly: false, owner: null, damage: 1, color: "#fff", pierce: 0, hitList: null, isCrit: false });
  stepWorld(w, new Map(), DT);
  check("damage to the reviver cancels the channel (progress restarts from zero)",
    a.reviveProgress <= 2 * DT, `progress=${a.reviveProgress.toFixed(3)}`);
  // A full uninterrupted hold completes; assert the revive-instant state via the event.
  b.invuln = 10;
  let revived = false;
  for (let t = 0; t < Math.round(1.8 / DT) && !revived; t++) {
    const evs = stepWorld(w, new Map(), DT);
    if (evs.some((e) => e.t === "revive")) revived = true;
  }
  check("a full 1.5s hold revives at 2 HP with 1.0s protection and the attack lockout",
    revived && !a.isDown && a.hp === REVIVE.hp && a.invuln >= REVIVE.invuln - 2 * DT && a.fireCd >= REVIVE.fireLockout - 2 * DT,
    `hp=${a.hp} invuln=${a.invuln.toFixed(2)} fireCd=${a.fireCd.toFixed(2)}`);
}

function main(): void {
  enemyTableGates();
  pistolBaselineGates();
  bossTtkGates();
  marrowGates();
  deepRosterGates();
  bossOverflowGates();
  normalTtkGates();
  threatBudgetGates();
  sustainGates();
  dashIframeGates();
  powerBudgetGates();
  coopScalingGates();
  reviveGates();
  check("no ITEMS entry exceeds three authored levels", ITEMS.every((it) => it.descs.length === 3));
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll balance ship gates hold.\n");
}

main();
