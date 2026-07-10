// Balance ship gates (docs/specs/blobrogue_BALANCE_FINAL_impl.md §7) as deterministic,
// CI-runnable assertions against the authoritative sim. Where a gate is a live-telemetry
// target (median hearts collected per floor, damage events suffered), the test pins the
// generating rates/mechanisms it derives from; everything else is measured by actually
// running the simulation.
//
// Run: npm run test:balance

import {
  createWorld, stepWorld, descend, devSpawnEnemy, acquireWeaponInWorld,
  spawnPlayerInWorld, isFloorCleared, buyFromShopInWorld,
} from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { EnemyKind, WeaponId } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import {
  ENEMY_ARCHETYPES, enemyHpForFloor, enemySpeedForFloor, createEnemy, spawnFloorEnemies,
  threatCostOf, isBossFloor, isComplexMover,
} from "../src/sim/enemies.js";
import { generateDungeon } from "../src/sim/dungeon.js";
import { WEAPONS } from "../src/sim/weapons.js";
import {
  PLAYER, SUSTAIN, SHOP, REVIVE, FANG_PROC_COOLDOWN, BOSS, MARROW, CHOIR, WEAVER, GILDED,
  GAUNTLET, gauntletCaptainHp, CAPS, TIERS,
  CAPTAIN_HP_BASE, EARNED_GUARD_MIN, EARNED_GUARD_MAX, EXPOSE_WINDOW_CAP,
  PERMANENT_ADVANTAGE_CEILING, bossHpForFloor, marrowHpForFloor, choirHpForFloor,
  weaverHpForFloor, gildedHpForFloor, floorThreat, activeThreatCap,
  coopMobHpMult, coopBossHpMult, coopThreatMult, coopHeartRateMult, BIOME_PRESSURE,
  pedestalWeaponRolls, bossWeaponChoices, BOSS_MIN_LEGAL_TTK,
  BOSS_DPS_CEILING, ELITE_BRACE,
} from "../src/sim/balance.js";
import { itemById, recomputeMods, createMods, rollItemChoicesWith, ITEMS, MAX_ITEM_LEVEL } from "../src/sim/items.js";
import { shopWeaponPrice } from "../src/sim/shop.js";
import type { EnemyTier } from "../src/sim/balance.js";
import { biomeIndexForFloor } from "../src/sim/biomes.js";
import { readFileSync, writeFileSync } from "node:fs";
import { Rng } from "../src/sim/rng.js";
import * as C from "../src/sim/constants.js";
// The practical-DPS + boss-TTK harness is shared with the kit balance gates (one model, one
// sim measurement) — see test/dpsHarness.ts.
import {
  DT, L3, plantBullet, idle, step, grant, measureBossTtk, practicalBossDps, forEachLegalBuild,
} from "./dpsHarness.js";

// Measured-build fixtures: every TTK number the gates measure is recorded here and pinned
// against test/fixtures/boss_ttk.fixtures.json. These are DETERMINISTIC SIM-HARNESS
// measurements (seeded worlds, scripted aggression) — NOT live playtest telemetry — and
// the fixture file says so. Regenerate after intentional balance changes with
// `npm run fixtures:ttk`.
const FIXTURES_PATH = new URL("./fixtures/boss_ttk.fixtures.json", import.meta.url);
const MEASURED: Record<string, number> = {};
function record(key: string, seconds: number): void {
  MEASURED[key] = Math.round(seconds * 1000) / 1000;
}

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

// ---- gate 3 + §3: the exact per-floor HP/speed tables ----

function enemyTableGates(): void {
  section("§3 exact enemy tables (HP + speed per floor, round-half-to-even)");
  type RegularKind = Exclude<EnemyKind, "boss" | "marrow" | "choir" | "weaver" | "gilded">;
  const HP: Record<RegularKind, number[]> = {
    slime: [5, 6, 8, 9, 10, 11, 12, 12, 13, 14],
    bat: [4, 5, 6, 7, 8, 8, 9, 10, 10, 11],
    skeleton: [6, 8, 9, 10, 12, 13, 14, 15, 16, 16],
    ghost: [4, 5, 6, 7, 8, 8, 9, 10, 10, 11],
    spitter: [5, 6, 8, 9, 10, 11, 12, 12, 13, 14],
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

// ---- studio gate §3: the five-boss ladder, each at its authored floor ----
// Boss HP is the gate's initial Standard-solo calibration, recalibrated by measured
// telemetry whenever the legal arsenal changes (the gate's own §3 rule): median TTK at
// the floor's median build must sit in the boss's band, and the representative high-roll
// builds must respect the band's minimum. The "no legal build below high-roll minimum"
// clause is NOT enforceable against stacked-multiplier god builds (9+ picks) without
// HP-sponging the median band — that deviation is reported in the PR, and these tests pin
// the representative high-roll builds instead.

interface BossGateRow {
  kind: EnemyKind;
  floor: number;
  medianWeapon: WeaponId;
  medianBuild: string[];
  medianBand: [number, number];
  // Earned-window bosses gate their TTK in EXPOSED time (the designer's currency —
  // wall-clock can be walked up by ignoring mechanics, exposed time cannot). null for
  // the Slime King, the roster's deliberate no-guard tutorial boss.
  exposedBand: [number, number] | null;
  highRollBuild: string[];
  highRollMin: number;
  // The unbreakable forced transition time (gate §3 "phases + forced time") and the beat's
  // hard cap (fixed beats: cap === forced; interactive beats stay ATTACKABLE past the
  // minimum and break early when their adds die).
  forcedEach: number;
  beatCap: number;
}

// The corrected gate §3 rows at the locked first-clear chain (King F5 / Gauntlet F10 /
// Marrow F15 / Weaver F20 / Warden F25 / Choir F30 — Jet stays post-F30 content).
// Median builds model expected power at each depth; high-roll = the representative
// aggressive build (smg + Deadeye Lv3 + the depth's Glass Cannon stack). Under earned
// windows the high-roll/median gap narrows by design: firepower converts windows
// harder, it can no longer out-DPS the mechanics.
const BOSS_GATE_ROWS: readonly BossGateRow[] = [
  {
    kind: "boss", floor: 5, medianWeapon: "pistol", medianBuild: L3("hair_trigger"),
    medianBand: [35, 50], exposedBand: null,
    highRollBuild: [...L3("deadeye"), "glass_cannon"], highRollMin: 20,
    forcedEach: BOSS.roarDuration, beatCap: BOSS.roarDuration,
  },
  {
    kind: "marrow", floor: 15, medianWeapon: "pistol", medianBuild: [...L3("hair_trigger"), "glass_cannon", "glass_cannon"],
    medianBand: [35, 50], exposedBand: [8, 20], // the light-touch retrofit: crash-gated windows
    highRollBuild: [...L3("deadeye"), "glass_cannon", "glass_cannon"], highRollMin: 20,
    forcedEach: MARROW.shieldMinDuration, beatCap: MARROW.shieldDuration,
  },
  {
    kind: "weaver", floor: 20, medianWeapon: "pistol", medianBuild: [...L3("hair_trigger"), "glass_cannon", "glass_cannon"],
    medianBand: [38, 55], exposedBand: [20, 30], // the earned-windows flagship gate
    highRollBuild: [...L3("deadeye"), "glass_cannon", "glass_cannon"], highRollMin: 20,
    forcedEach: WEAVER.moltDuration, beatCap: WEAVER.moltDuration,
  },
  {
    kind: "gilded", floor: 25, medianWeapon: "pistol", medianBuild: [...L3("hair_trigger"), ...L3("glass_cannon")],
    medianBand: [40, 58], exposedBand: [20, 34], // every commitment opens a recover window
    highRollBuild: [...L3("deadeye"), ...L3("glass_cannon")], highRollMin: 22,
    forcedEach: GILDED.sanctifyDuration, beatCap: GILDED.sanctifyDuration,
  },
  {
    kind: "choir", floor: 30, medianWeapon: "pistol", medianBuild: [...L3("hair_trigger"), ...L3("glass_cannon")],
    medianBand: [40, 58], exposedBand: [12, 26], // verse-silence windows
    highRollBuild: [...L3("deadeye"), ...L3("glass_cannon")], highRollMin: 22,
    forcedEach: CHOIR.splitMinDuration, beatCap: CHOIR.splitDuration,
  },
];

function bossLadderGates(): void {
  section("gate §3 HP anchors at the locked chain floors (earned-windows recalibration)");
  check("F5 King HP is 950 (the tutorial boss keeps its full-uptime calibration)",
    bossHpForFloor(5) === BOSS.baseHp && BOSS.baseHp === 950, `hp=${bossHpForFloor(5)}`);
  check("F15 Marrow anchor recalibrated onto crash-window damage (730)",
    marrowHpForFloor(15) === MARROW.baseHp && MARROW.baseHp === 730, `hp=${marrowHpForFloor(15)}`);
  check("F20 Weaver anchor recalibrated onto exposed damage (590)",
    weaverHpForFloor(20) === WEAVER.baseHp && WEAVER.baseHp === 590, `hp=${weaverHpForFloor(20)}`);
  check("F25 Warden anchor holds (its commit windows were already the calibration)",
    gildedHpForFloor(25) === GILDED.baseHp && GILDED.baseHp === 1280, `hp=${gildedHpForFloor(25)}`);
  check("F30 Choir anchor recalibrated onto verse-silence damage (750)",
    choirHpForFloor(30) === CHOIR.baseHp && CHOIR.baseHp === 750, `hp=${choirHpForFloor(30)}`);
  check("the gauntlet/miniboss captains keep the FULL-UPTIME anchor (no guard, no shrink)",
    CAPTAIN_HP_BASE === 1250, `captainBase=${CAPTAIN_HP_BASE}`);
  check("every boss deals 2 contact damage (authored integer, never scales)",
    (["boss", "marrow", "choir", "weaver", "gilded"] as EnemyKind[]).every((k) => ENEMY_ARCHETYPES[k].touchDamage === 2));
  // "Equal HP all modes": the sim ships one difficulty; boss HP is a single authored
  // anchor — solo createEnemy must land the anchor EXACTLY (party scaling is a separate,
  // documented co-op multiplier).
  check("boss HP at the anchor is mode-independent (solo spawn = the authored anchor)",
    ([["boss", 5, 950], ["marrow", 15, 730], ["weaver", 20, 590], ["gilded", 25, 1280], ["choir", 30, 750]] as Array<[EnemyKind, number, number]>)
      .every(([k, f, hp]) => createEnemy(k, 0, 0, f, new Rng(1), 0, {}).hp === hp));
  check("deep reappearances stay within the ≤1.5x later-boss effective ceiling",
    bossHpForFloor(35) <= BOSS.baseHp * 1.5 && marrowHpForFloor(35) <= MARROW.baseHp * 1.5,
    `king@35=${bossHpForFloor(35)} marrow@35=${marrowHpForFloor(35)}`);

  section("earned windows: the guarded/exposed fairness bounds (never immunity)");
  check("every guarded chip sits in the 0.20–0.35 band (reduction, never immunity)",
    [MARROW.guardMult, WEAVER.guardMult, GILDED.armorChip, CHOIR.guardMult]
      .every((g) => g >= EARNED_GUARD_MIN - 1e-9 && g <= EARNED_GUARD_MAX + 1e-9));
  check("every earned window is the authored 3–4s (combined exposure hard-capped)",
    [MARROW.crashExpose, WEAVER.knotBreakExpose, WEAVER.forcedownExpose, WEAVER.overshootExpose, CHOIR.silenceExpose]
      .every((s) => s >= 3 && s <= 4) && EXPOSE_WINDOW_CAP <= 8);
  check("per-window banks are the ~40% phase chunk on every earned boss",
    [MARROW.windowBankFrac, WEAVER.windowBankFrac, GILDED.windowBankFrac, CHOIR.windowBankFrac]
      .every((f) => f === 0.40));
  check("co-op scales the MECHANIC: task counts grow with the snapshotted party",
    WEAVER.knotsFor[1] < WEAVER.knotsFor[4] && WEAVER.sacsFor[1] < WEAVER.sacsFor[4]
    && CHOIR.fragmentsFor[1] < CHOIR.fragmentsFor[4]);

  for (const row of BOSS_GATE_ROWS) {
    section(`gate §3 ${row.kind} @F${row.floor}: median ${row.medianBand[0]}–${row.medianBand[1]}s, high-roll ≥${row.highRollMin}s, forced ${row.forcedEach}s×2`);
    const median = measureBossTtk(row.medianWeapon, row.medianBuild, { kind: row.kind, floor: row.floor });
    record(`${row.kind}.median`, median.seconds);
    check(`median build kills in ${row.medianBand[0]}–${row.medianBand[1]}s`,
      median.killed && median.seconds >= row.medianBand[0] && median.seconds <= row.medianBand[1],
      `ttk=${median.seconds.toFixed(1)}s`);
    if (row.exposedBand !== null) {
      // The earned-windows gate currency: the median kill converts its mechanics into
      // this much EXPOSED time — wall-clock can be stalled, exposed time cannot.
      record(`${row.kind}.medianExposed`, median.exposedSeconds);
      check(`median kill's EXPOSED time sits in the ${row.exposedBand[0]}–${row.exposedBand[1]}s earned-window band`,
        median.exposedSeconds >= row.exposedBand[0] && median.exposedSeconds <= row.exposedBand[1],
        `exposed=${median.exposedSeconds.toFixed(1)}s of ${median.seconds.toFixed(1)}s wall`);
    }
    const highRoll = measureBossTtk("smg", row.highRollBuild, { kind: row.kind, floor: row.floor });
    record(`${row.kind}.highRoll`, highRoll.seconds);
    check(`representative high-roll stays ≥${row.highRollMin}s`,
      highRoll.killed && highRoll.seconds >= row.highRollMin, `ttk=${highRoll.seconds.toFixed(1)}s`);

    // The balancer's percentile report: a nine-build deterministic ladder from
    // under-median to the 12-pick god build. P10 (fastest decile) must respect the
    // high-roll minimum; P50 must sit in the median band. Transition time (and the
    // Warden's closed-plate time) are logged as separate channels, per the directive.
    const ladder: Array<[WeaponId, string[]]> = [
      ["pistol", row.medianBuild.slice(0, -1)],
      ["pistol", row.medianBuild],
      ["pistol", [...row.medianBuild, "deadeye"]],
      ["smg", row.medianBuild],
      ["smg", [...row.medianBuild, "deadeye"]],
      ["smg", row.highRollBuild],
      ["smg", [...row.highRollBuild, ...L3("hair_trigger")]],
      ["beam", row.highRollBuild],
      ["smg", [...L3("glass_cannon"), ...L3("hair_trigger"), ...L3("deadeye"), ...L3("split_shot")]],
    ];
    const runs = ladder.map(([wpn, picks]) => measureBossTtk(wpn, picks, { kind: row.kind, floor: row.floor }));
    const sortedTtk = runs.map((r) => (r.killed ? r.seconds : Infinity)).sort((a, b) => a - b);
    const p10 = sortedTtk[0];
    const p50 = sortedTtk[4];
    const p90 = sortedTtk[8];
    record(`${row.kind}.p10`, p10);
    record(`${row.kind}.p50`, Number.isFinite(p50) ? p50 : -1);
    record(`${row.kind}.p90`, Number.isFinite(p90) ? p90 : -1);
    record(`${row.kind}.transitionSeconds`, Math.round(median.transitionSeconds * 1000) / 1000);
    if (row.kind === "gilded") record(`${row.kind}.closedArmorSeconds`, Math.round(median.closedArmorSeconds * 1000) / 1000);
    check(`P50 of the ladder sits in the ${row.medianBand[0]}–${row.medianBand[1]}s median band`,
      Number.isFinite(p50) && p50 >= row.medianBand[0] && p50 <= row.medianBand[1], `P50=${Number.isFinite(p50) ? p50.toFixed(1) : "unkilled"}s`);
    check(`P10 (fastest decile) stays ≥ the ${row.highRollMin}s high-roll minimum`,
      p10 >= row.highRollMin, `P10=${p10.toFixed(1)}s`);
    process.stdout.write(`  info: ${row.kind} P10/P50/P90 = ${p10.toFixed(1)}/${Number.isFinite(p50) ? p50.toFixed(1) : "∞"}/${Number.isFinite(p90) ? p90.toFixed(1) : "∞"}s, transition=${median.transitionSeconds.toFixed(1)}s${row.kind === "gilded" ? `, closedArmor=${median.closedArmorSeconds.toFixed(1)}s` : ""}\n`);

    const enters = median.transitions.filter((t) => t.entering);
    const exits = median.transitions.filter((t) => !t.entering);
    check("exactly two transition beats fire across the fight (enter/exit logged)",
      enters.length === 2 && exits.length === 2, `enters=${enters.length} exits=${exits.length}`);
    let capOk = true;
    let minOk = true;
    for (let i = 0; i < Math.min(enters.length, exits.length); i++) {
      const dur = exits[i].at - enters[i].at;
      if (dur > row.beatCap + 2 * DT) capOk = false;
      if (dur < row.forcedEach - 2 * DT) minOk = false;
    }
    check(`no beat exceeds its ${row.beatCap}s cap`, capOk);
    check(`every beat holds its ${row.forcedEach}s forced minimum (the gate's transition time)`, minOk);
    process.stdout.write(`  info: ${row.kind} median=${median.seconds.toFixed(1)}s high-roll=${highRoll.seconds.toFixed(1)}s\n`);
  }

  section("gate §3 mechanism: fixed beats ≤1.2s; interactive beats attackable throughout");
  check("fixed roar beats are ≤1.2s (approved spec: forced transitions never exceed 1.2s)",
    BOSS.roarDuration <= 1.2 && WEAVER.moltDuration <= 1.2 && GILDED.sanctifyDuration <= 1.2);
  check("interactive beats (Marrow shield, Choir split) hold forced minima ≤1.2s",
    MARROW.shieldMinDuration <= 1.2 && CHOIR.splitMinDuration <= 1.2);
  check("the Marrow shield is reduction (65% damage still lands), never immunity",
    MARROW.shieldDamageReduction < 1 && MARROW.shieldDamageReduction === BOSS.roarDamageReduction);
  check("the Warden's plate is tempo, never immunity (chip is 30%, exposed windows ≥2s)",
    GILDED.armorChip > 0 && GILDED.slamRecover >= 2 && GILDED.sweepRecover >= 2);
  check("corrected §3 charge contract: tell .9 / lock .5 / 520 for 1.1s / recover .7 or crash 1.6",
    MARROW.chargeWindup === 0.9 && MARROW.chargeLock === 0.5 && MARROW.chargeDur === 1.1
    && MARROW.chargeSpeed === 520 && MARROW.chargeRecover === 0.7 && MARROW.crashStun === 1.6);
  check("descent contract: marked tell + air ≥.6s combined, staggers/recovers ≥.35s",
    WEAVER.descendTell + WEAVER.descendAir >= 0.6 && WEAVER.descendStagger >= 0.35
    && WEAVER.unforcedRecover >= 0.35);
  check("blink/dash contracts: whole ≥.6s tells post-lock, ≥.35s recovers, staggers real",
    WEAVER.blinkWindup >= 0.6 && WEAVER.blinkRecover >= 0.35 && WEAVER.snagStagger >= 0.35
    && WEAVER.dashFlare >= 0.6 && WEAVER.dashRecover >= 0.35 && WEAVER.dashStagger >= 0.35);
  check("corrected §3 Choir contract: fade tell .6 / drift 1.8×1.6 / recover .8; split 1–3.2s",
    CHOIR.fadeWindup === 0.6 && CHOIR.fadeDuration === 1.8 && CHOIR.fadeSpeedMult === 1.6
    && CHOIR.fadeRecover === 0.8 && CHOIR.splitMinDuration === 1.0 && CHOIR.splitDuration === 3.2);
}

// The anti-burst floor as a hard mechanism: even an absurd single hit cannot delete the
// boss — damage floors at 62%/27%, the overflow queues, and applies only after each full
// 1.2s roar. Kill time under an extreme hit is still ≥ 2×1.2s.
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

function measureFocusedTtk(kind: EnemyKind, floor: number, weapon: WeaponId, picks: string[], tier: EnemyTier = "standard"): number {
  const w = createWorld(0xF0C05, floor, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  acquireWeaponInWorld(w, LOCAL_ID, weapon);
  grant(w, LOCAL_ID, picks);
  const target = tier === "standard"
    ? devSpawnEnemy(w, kind, p.x + 140, p.y)
    : (() => {
      const e = createEnemy(kind, p.x + 140, p.y, floor, new Rng(9), w.nextEnemyId++, { tier });
      w.enemies.push(e);
      return e;
    })();
  let ticks = 0;
  while (!target.dead && ticks < 60 * 20) {
    const aim = Math.atan2(target.y - p.y, target.x - p.x);
    step(w, { seq: ticks, moveX: 0, moveY: 0, aim, firing: true, dash: false });
    ticks++;
  }
  return ticks * DT;
}

// Playtest durability finding: fodder melts (unchanged bands below), but the visually
// tougher classes must demand SUSTAINED focus with a legible tier ladder — no
// indiscriminate HP inflation (swarm/standard untouched; tough tiers repriced in threat
// so floor totals stay budget-shaped).
function normalTtkGates(): void {
  section("gate 3 + durability pass: focused TTK bands (normals fast, elite ~2.8s, brute ~3.2s)");
  const f1 = measureFocusedTtk("slime", 1, "pistol", []);
  check("F1 slime focused TTK ≤ 0.9s (no picks)", f1 <= 0.9, `ttk=${f1.toFixed(2)}s`);
  const f2 = measureFocusedTtk("skeleton", 2, "pistol", []);
  check("F2 skeleton focused TTK ≤ 0.9s (no picks)", f2 <= 0.9, `ttk=${f2.toFixed(2)}s`);
  // Late-floor median build ≈ Hair Trigger Lv3 + Glass Cannon Lv2 (~7 picks by F9).
  const late = measureFocusedTtk("skeleton", 9, "pistol", [...L3("hair_trigger"), "glass_cannon", "glass_cannon"]);
  check("F9 skeleton focused TTK ≤ 1.4s at a late median build (HP never sponges)", late <= 1.4, `ttk=${late.toFixed(2)}s`);

  // Tier bands, measured against the same late median build on their first-eligible floors.
  const bruteHp = createEnemy("skeleton", 0, 0, 4, new Rng(1), 0, { tier: "brute" }).hp;
  check("brute = 3.80x scaled HP (6 x 1.72 x 3.8 -> 39)", bruteHp === 39, `hp=${bruteHp}`);
  // Durability pass: the brute is the floor's committed fight — starter-pistol focused
  // TTK ~3.2s at its F4 debut, roughly 4x a standard body and above every other tier.
  const bruteTtk = measureFocusedTtk("skeleton", 4, "pistol", [], "brute");
  record("brute.f4", bruteTtk);
  check("F4 brute focused TTK sits in the 2.6-4.2s sustained-focus band (starter build)",
    bruteTtk >= 2.6 && bruteTtk <= 4.2, `ttk=${bruteTtk.toFixed(2)}s`);
  // Elite = 2.6x chassis: ~3.4x a standard body's focused burn at the F6 median build,
  // deliberately UNDER the brute so the two tough tiers stay distinguishable; the elite
  // identity is still the visible BRACE commitment, not an HP wall.
  const eliteHp = createEnemy("skeleton", 0, 0, 6, new Rng(1), 0, { tier: "elite" }).hp;
  check("elite = 2.6x scaled HP (6 x 2.12 x 2.6 -> 33)", eliteHp === 33, `hp=${eliteHp}`);
  const eliteEntry = measureFocusedTtk("skeleton", 6, "pistol", L3("hair_trigger"), "elite");
  record("elite.f6.focused", eliteEntry);
  check("F6 elite focused TTK sits in the 2.4-4.0s sustained-focus band (F6 median build)",
    eliteEntry >= 2.4 && eliteEntry <= 4.0, `ttk=${eliteEntry.toFixed(2)}s`);
  const swarm = createEnemy("slime", 0, 0, 1, new Rng(1), 0, { tier: "swarm" });
  check("swarm = 0.55x HP / 1.15x speed / 0.78x radius", swarm.hp === 3 && swarm.speed === 48
    && Math.abs(swarm.radius - 16 * 0.78) < 1e-9, `hp=${swarm.hp} speed=${swarm.speed}`);

  // The legible durability ladder itself, on a floor where every tier is legal (F8):
  // swarm << standard < elite < brute, with real separation between the tough tiers —
  // and the toughness is PRICED (threat cost rises with the multiplier) so raising
  // durability never inflated the floor's budgeted total.
  const at8 = (tier: EnemyTier) => createEnemy("skeleton", 0, 0, 8, new Rng(1), 0, { tier }).hp;
  check("tier durability ladder at F8: swarm < standard < elite < brute",
    at8("swarm") < at8("standard") && at8("standard") < at8("elite") && at8("elite") < at8("brute"),
    `${at8("swarm")}/${at8("standard")}/${at8("elite")}/${at8("brute")}`);
  check("tough tiers are clearly separated (elite ≥ 2.4x standard, brute ≥ 1.3x elite)",
    at8("elite") >= at8("standard") * 2.4 && at8("brute") >= at8("elite") * 1.3);
  check("tier threat costs track the envelope ladder (swarm .5 < std 1 < brute 3.0 < elite 4.0)",
    TIERS.swarm.threatCost === 0.5 && TIERS.standard.threatCost === 1.0
    && TIERS.brute.threatCost === 3.0 && TIERS.elite.threatCost === 4.0);
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

  // Patch's heart station (the Dealer's heart, now behind the explicit shop buy): floors
  // 3/6/9 sell +1 HP at 6 coins — never a full heal, never free, and NEVER by touch.
  {
    const w = createWorld(0xDEA1, 3);
    const heart = w.shop?.slots.find((s) => s.kind === "heart");
    check("floor 3's shop stocks the heart station at 6 coins", heart !== undefined && heart.price === SHOP.heartPrice);
    if (heart) {
      const p = w.players.get(LOCAL_ID)!;
      p.hp = 3; p.coins = 5;
      p.x = heart.x; p.y = heart.y;
      step(w, idle(1));
      check("standing on the station never buys (the touch-purchase is gone)", p.hp === 3 && p.coins === 5);
      check("a broke buy command is rejected without consuming", buyFromShopInWorld(w, LOCAL_ID, heart.id, []) === "broke" && p.coins === 5 && p.hp === 3);
      p.coins = 7;
      check("6 coins buys exactly +1 HP through the explicit command",
        buyFromShopInWorld(w, LOCAL_ID, heart.id, []) === "ok" && p.hp === 4 && p.coins === 1);
    }
    check("no shop on non-interval floors", createWorld(0xDEA1, 4).shop === null);
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
  check("captain/miniboss HP mult 1.00/1.65/2.30/2.95 (headcount-only, boss-grade non-bosses)",
    [1, 2, 3, 4].every((p) => Math.abs(coopBossHpMult(p) - (1 + 0.65 * (p - 1))) < 1e-9));
  check("threat mult 1.00/1.35/1.70/2.05", [1, 2, 3, 4].every((p) => Math.abs(coopThreatMult(p) - (1 + 0.35 * (p - 1))) < 1e-9));
  check("heart rate mult 1.00/1.30/1.60/1.90", [1, 2, 3, 4].every((p) => Math.abs(coopHeartRateMult(p) - (1 + 0.30 * (p - 1))) < 1e-9));

  const rng = new Rng(3);
  const duoSkeleton = createEnemy("skeleton", 0, 0, 3, rng, 0, { players: 2 });
  check("duo F3 skeleton HP = round(9 x 1.55)", duoSkeleton.hp === 14, `hp=${duoSkeleton.hp}`);
  // Bosses ride the R framework: a naked duo measures R=1 (the weak-player floor +
  // clamp) — the boss holds its solo anchor; the party's GEAR is what raises it.
  const duoBoss = createEnemy("boss", 0, 0, 5, rng, 1, { players: 2, power: 1 });
  check("a naked duo's F5 boss holds the solo anchor (R=1 — gear, not headcount, scales bosses)",
    duoBoss.hp === 950, `hp=${duoBoss.hp}`);
  const strongPull = createEnemy("boss", 0, 0, 5, rng, 2, { players: 4, power: 4 });
  check("an R=4 pull rides the measured HPfrac 1+0.45(R−1) — round10(950 × 2.35)",
    strongPull.hp === Math.round((950 * (1 + 0.45 * 3)) / 10) * 10, `hp=${strongPull.hp}`);

  // Snapshot at encounter creation: the floor build carries P; later loads re-snapshot.
  const w = createWorld(0xC0093, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(w, "pA");
  spawnPlayerInWorld(w, "pB");
  check("pre-join world built at P=1", w.encounterPlayers === 1);
  descend(w, 2, []);
  check("post-descend floor snapshots P=2", w.encounterPlayers === 2);
  const someMob = w.enemies.find((e) => e.kind !== "boss" && e.tier === "standard");
  check("the new floor's enemies carry the duo HP scale",
    someMob !== undefined && someMob.hp === createEnemy(someMob.kind, 0, 0, 2, new Rng(1), 0, { players: 2 }).hp,
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
  // The channel is an explicit HOLD: B's input carries the interact intent every tick.
  const hold = new Map<PlayerId, InputCmd>([["pB", { seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false, interact: true }]]);
  // 1.2s of channel is not enough at the 1.5s requirement.
  for (let t = 0; t < Math.round(1.2 / DT); t++) stepWorld(w, hold, DT);
  check("1.2s of channel does not revive (1.5s required)", a.isDown, `progress=${a.reviveProgress.toFixed(2)}`);
  // Damage to the channeler restarts the whole channel from zero.
  w.bullets.push({ x: b.x, y: b.y, vx: 1, vy: 0, radius: 10, life: 0.05, friendly: false, owner: null, damage: 1, color: "#fff", pierce: 0, hitList: null, isCrit: false });
  stepWorld(w, hold, DT);
  check("damage to the reviver cancels the channel (progress restarts from zero)",
    a.reviveProgress <= 2 * DT, `progress=${a.reviveProgress.toFixed(3)}`);
  // A full uninterrupted hold completes; assert the revive-instant state via the event.
  b.invuln = 10;
  let revived = false;
  for (let t = 0; t < Math.round(1.8 / DT) && !revived; t++) {
    const evs = stepWorld(w, hold, DT);
    if (evs.some((e) => e.t === "revive")) revived = true;
  }
  check("a full 1.5s hold revives at 2 HP with 1.0s protection and the attack lockout",
    revived && !a.isDown && a.hp === REVIVE.hp && a.invuln >= REVIVE.invuln - 2 * DT && a.fireCd >= REVIVE.fireLockout - 2 * DT,
    `hp=${a.hp} invuln=${a.invuln.toFixed(2)} fireCd=${a.fireCd.toFixed(2)}`);
}

// ---- studio gate §7.1: the early-melt gate ----
// Standard normal (standard-tier) focused TTK never <0.45s median at the archetype's
// entry floor with the starter pistol, and never >1.40s (the §1 Standard band). Swarm-tier
// bodies are the deliberate 0.55x melt chaff and sit outside the "normal" band.

function earlyMeltGates(): void {
  section("studio gate §7.1 early-melt: entry-floor focused TTK in the 0.45–1.40s Standard band");
  const entries: Array<[EnemyKind, number]> = [
    ["slime", 1], ["bat", 2], ["skeleton", 2], ["spitter", 2], ["ghost", 3],
    ["charger", 3], ["burrower", 4], ["orbiter", 6],
  ];
  for (const [kind, floor] of entries) {
    const t = measureFocusedTtk(kind, floor, "pistol", []);
    check(`${kind} F${floor} starter-pistol focused TTK in [0.45, 1.40]s`, t >= 0.45 && t <= 1.40,
      `ttk=${t.toFixed(2)}s`);
  }
  // The shielder's front arc eats frontal focus by DESIGN (the flank is the answer), so a
  // straight-line measure never lands: assert its unblocked burn-down instead — landed
  // hits at the base pistol's cadence keep it inside the same band.
  {
    const shots = Math.ceil(enemyHpForFloor("shielder", 7) / WEAPONS.pistol.damage);
    const burn = (shots - 1) * WEAPONS.pistol.fireCd + 0.25; // cadence + ~140px flight
    check("shielder F7 unblocked burn-down sits in [0.45, 1.40]s (front arc adds the rest)",
      burn >= 0.45 && burn <= 1.40, `burn=${burn.toFixed(2)}s (${shots} landed rounds)`);
  }
}

// ---- studio gate §1/§2 composition caps: complex movers, burrowers, flock spend ----

function compositionCapGates(): void {
  section("studio gate §1/§2: ≤2 complex movers live, ≤1 burrower/room, flock spend ≤35%");
  check("charge/burrow are the complex movers; the bestiary envelope prices them at 2.0",
    isComplexMover("charger") && isComplexMover("burrower") && !isComplexMover("orbiter")
    && ENEMY_ARCHETYPES.charger.threat === 2.0 && ENEMY_ARCHETYPES.burrower.threat === 2.0);

  // Static plans across seeds and the F11–24 late band: burrower room cap + pack spend.
  let burrowRoomOk = true;
  let packSpendOk = true;
  let splitMoverOk = true;
  for (let seedIdx = 0; seedIdx < 30; seedIdx++) {
    const seed = 0xCA9E + seedIdx * 6151;
    for (let floor = 5; floor <= 24; floor++) {
      if (isBossFloor(floor)) continue;
      const d = generateDungeon(seed, floor);
      const spawns = spawnFloorEnemies(d, seed, floor);
      const all = [...spawns.active, ...spawns.pending];
      for (const room of d.rooms) {
        const burrowers = all.filter((e) => e.kind === "burrower"
          && e.x >= room.x * TILE && e.x < (room.x + room.w) * TILE
          && e.y >= room.y * TILE && e.y < (room.y + room.h) * TILE).length;
        if (burrowers > 1) burrowRoomOk = false;
      }
      // The initially-active set must already respect the live mover cap.
      const movers = spawns.active.filter((e) => isComplexMover(e.kind)).length;
      if (movers > 2) splitMoverOk = false;
      // No swarm pack (contiguous same-room swarm run in the plan) outspends 35% of the budget.
      const cap = 0.35 * floorThreat(floor) * BIOME_PRESSURE[biomeIndexForFloor(floor)].budgetMult;
      let run = 0;
      let prevKey = "";
      for (const e of all) {
        if (e.tier !== "swarm") { run = 0; prevKey = ""; continue; }
        const key = `${e.kind}:${Math.round(e.x / TILE / 4)}:${Math.round(e.y / TILE / 4)}`;
        run = key === prevKey ? run + threatCostOf(e.kind, "swarm") : threatCostOf(e.kind, "swarm");
        prevKey = key;
        if (run > cap + 1e-9) packSpendOk = false;
      }
    }
  }
  check("never more than one burrower planned into a room", burrowRoomOk);
  check("the spawn split never activates more than 2 complex movers", splitMoverOk);
  check("no swarm pack consumes more than 35% of the floor's threat spend", packSpendOk);

  // Live: on a mover-heavy deep floor, the released set never exceeds 2 complex movers.
  {
    const w = createWorld(0xCA9E, 16);
    w.isGodMode = true;
    let liveOk = true;
    for (let t = 0; t < 60 * 30; t++) {
      step(w, idle(t));
      const movers = w.enemies.filter((e) => !e.dead && isComplexMover(e.kind)).length;
      if (movers > 2) liveOk = false;
    }
    check("30 live seconds on F16 never field >2 complex movers at once", liveOk);
  }
}

// ---- studio gate §4/§7.6: party weapon opportunities ----

function partyRewardGates(): void {
  section("studio gate §4: pedestal rolls max(1, ceil(P/2)), distinct ids");
  check("formulas: pedestals 1/1/2/2, boss choices 3/3/4/5 (P+1 floored at 3 for early variety)",
    [1, 2, 3, 4].every((p) => pedestalWeaponRolls(p) === Math.max(1, Math.ceil(p / 2)))
    && [1, 2, 3, 4].every((p) => bossWeaponChoices(p) === Math.min(5, Math.max(3, p + 1))));
  for (let players = 1; players <= 4; players++) {
    const w = createWorld(0x9ED5, 1, { skipLocalPlayer: true });
    for (let i = 0; i < players; i++) spawnPlayerInWorld(w, `p${i}`);
    descend(w, 3, []);
    const stocked = w.chests.filter((c) => c.weapon !== undefined).map((c) => c.weapon!);
    check(`P${players} floor stocks exactly ${pedestalWeaponRolls(players)} pedestal weapon(s), distinct`,
      stocked.length === pedestalWeaponRolls(players) && new Set(stocked).size === stocked.length,
      stocked.join(","));
    const shopWeapons = w.shop?.slots.filter((s) => s.kind === "weapon") ?? [];
    const prices = shopWeapons.map((s) => s.price);
    check(`P${players} shop stalls two DISTINCT weapons, rarity-priced off the unchanged ladder base`,
      shopWeapons.length === SHOP.weaponPedestals
      && new Set(shopWeapons.map((s) => s.weapon)).size === shopWeapons.length
      && shopWeapons.every((s, i) => s.price === shopWeaponPrice(SHOP.pedestalPrices[i], s.weapon!, s.isMystery)),
      `prices=${prices.join("/")}`);
  }

  section("shop ownership (accepted studio UX call): shared weapons claim once; personal slots never deplete");
  {
    const w = createWorld(0x9ED6, 1, { skipLocalPlayer: true });
    const a = spawnPlayerInWorld(w, "a");
    const b = spawnPlayerInWorld(w, "b");
    descend(w, 3, []);
    w.pendingBlessings.clear(); // the descend's blessing offers pause players; resolve them
    const weapon = w.shop!.slots.find((s) => s.kind === "weapon")!;
    a.coins = weapon.price - 1; a.x = weapon.x; a.y = weapon.y;
    check("a broke buy is rejected without consuming",
      buyFromShopInWorld(w, "a", weapon.id, []) === "broke" && a.coins === weapon.price - 1 && weapon.soldTo === null);
    a.coins = weapon.price;
    check("a funded buy claims the SHARED pedestal: weapon granted, coins paid, slot SOLD",
      buyFromShopInWorld(w, "a", weapon.id, []) === "ok" && a.ownedWeapons.includes(weapon.weapon!) && a.coins === 0
      && weapon.soldTo === "a");
    b.coins = weapon.price; b.x = weapon.x; b.y = weapon.y;
    check("the teammate's late buy reads the honest SOLD and consumes nothing",
      buyFromShopInWorld(w, "b", weapon.id, []) === "sold" && b.coins === weapon.price
      && !b.ownedWeapons.includes(weapon.weapon!));
    const blessing = w.shop!.slots.find((s) => s.kind === "blessing")!;
    a.coins = blessing.price; b.coins = blessing.price;
    a.x = blessing.x; a.y = blessing.y; b.x = blessing.x; b.y = blessing.y;
    check("the FOR-YOU blessing pedestal serves BOTH buyers (personal, never depletes)",
      buyFromShopInWorld(w, "a", blessing.id, []) === "ok" && buyFromShopInWorld(w, "b", blessing.id, []) === "ok"
      && a.ownedItemIds.includes(blessing.itemId!) && b.ownedItemIds.includes(blessing.itemId!));
  }

  section("studio gate §4: boss reward = P+1 personal choices; claims never starve teammates");
  {
    const w = createWorld(0xB0553, 5, { isSandbox: true, skipLocalPlayer: true });
    w.isGodMode = true;
    const a = spawnPlayerInWorld(w, "a");
    const b = spawnPlayerInWorld(w, "b");
    w.encounterPlayers = 2; // the encounter snapshot (a real run sets this at floor build)
    b.x = 60; b.y = 60;
    const boss = devSpawnEnemy(w, "boss", a.x + 130, a.y);
    for (let t = 1; t <= 60 * 10 && !boss.dead; t++) {
      plantBullet(w, boss.x, boss.y, 1000, 30);
      step(w, idle(t));
    }
    const chest = w.chests.find((c) => c.kind === "boss")!;
    check("boss chest spawned", chest !== undefined && boss.dead);
    a.x = chest.x; a.y = chest.y;
    step(w, idle(1));
    a.x = 60; a.y = 120; // step OFF the pedestals before examining the choice set
    const choices = w.pickups.filter((k) => k.isBossChoice);
    const ids = choices.map((k) => k.weapon!);
    check("duo chest offers exactly P+1 = 3 DISTINCT choices incl. the signature",
      choices.length === 3 && new Set(ids).size === 3 && ids.includes("mortar"), ids.join(","));

    // Player A claims one: the pedestal set stays intact for B.
    const pick = choices[0];
    a.x = pick.x; a.y = pick.y;
    step(w, idle(2));
    check("A's claim grants the weapon and spends A's ONE claim",
      a.ownedWeapons.includes(pick.weapon!) && a.hasClaimedBossChoice);
    check("the claim removes NOTHING for teammates", w.pickups.filter((k) => k.isBossChoice).length === 3);
    const other = choices[1];
    a.x = other.x; a.y = other.y;
    step(w, idle(3));
    check("A cannot claim a second choice", !a.ownedWeapons.includes(other.weapon!));

    // B claims a weapon B already owns: the claim rerolls (never coins/raw damage).
    b.ownedWeapons.push(other.weapon!);
    const ownedBefore = b.ownedWeapons.length;
    b.x = other.x; b.y = other.y;
    step(w, idle(4));
    check("B's duplicate claim rerolls into a weapon B does not own",
      b.hasClaimedBossChoice && b.ownedWeapons.length === ownedBefore + 1
      && new Set(b.ownedWeapons).size === b.ownedWeapons.length);
    check("all living players claimed -> the pedestals clear", w.pickups.every((k) => !k.isBossChoice));
  }

  section("studio gate §4: no player goes >2 consecutive non-boss floors without an opportunity");
  {
    // Pedestals stock EVERY non-boss floor, floor 1 included (the early-variety fix:
    // F1 used to carry only the starter pistol), so there is no dry floor at all.
    let ok = true;
    for (let f = 1; f <= 9; f++) {
      if (isBossFloor(f)) continue;
      const w = createWorld(0x9ED7, 1);
      if (f > 1) descend(w, f, []);
      if (!w.chests.some((c) => c.weapon !== undefined)) ok = false;
    }
    check("every non-boss floor F1+ stocks at least one weapon pedestal", ok);
  }
}

// ---- corrected gate §3/§7.4: the F10 gauntlet TTK gates ----
// A deterministic maximally-aggressive harness (point-blank focus, flanking the shielder
// captain's guard arc — its front is a block loop by design) drives the natural floor-10
// world through the whole sequence and measures each ROUND (captain spawn -> captain,
// summons and hazards all cleared) plus the arena total.

function measureGauntlet(weapon: WeaponId, picks: string[]): { total: number; rounds: number[]; captains: string[] } {
  const w = createWorld(0xF10B, 10);
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  acquireWeaponInWorld(w, LOCAL_ID, weapon);
  grant(w, LOCAL_ID, picks);
  const roundStart: number[] = [];
  const roundEnd: number[] = [];
  const captains: string[] = [];
  let isInRound = false;
  let firstCaptainTick = -1;
  let ticks = 0;
  for (; ticks < 60 * 240 && !isFloorCleared(w); ticks++) {
    const captain = w.enemies.find((e) => !e.dead && e.captainPhase !== undefined);
    if (captain && !isInRound) {
      isInRound = true;
      roundStart.push(ticks * DT);
      captains.push(`${captain.kind}/${captain.tier}`);
      if (firstCaptainTick < 0) firstCaptainTick = ticks;
    }
    if (isInRound && !w.enemies.some((e) => !e.dead)) {
      isInRound = false;
      roundEnd.push(ticks * DT);
    }
    const target = captain ?? w.enemies.find((e) => !e.dead);
    if (target) {
      const behind = target.kind === "shielder" ? target.attack.lockedAngle + Math.PI : Math.PI;
      p.x = target.x + Math.cos(behind) * 34;
      p.y = target.y + Math.sin(behind) * 34;
    }
    const aim = target ? Math.atan2(target.y - p.y, target.x - p.x) : 0;
    step(w, { seq: ticks, moveX: 0, moveY: 0, aim, firing: true, dash: false });
  }
  // The final round's clear coincides with the floor clear: close it from the loop exit.
  if (roundEnd.length < roundStart.length) roundEnd.push(ticks * DT);
  const rounds = roundEnd.map((end, i) => end - roundStart[i]);
  return { total: firstCaptainTick >= 0 ? (ticks - firstCaptainTick) * DT : -1, rounds, captains };
}

function gauntletGates(): void {
  section("corrected gate §3: gauntlet captains at round10(.28/.32/.40 × Marrow HP)");
  check("captain HP derives from calibrated Marrow HP: 350 / 400 / 500 (sums to 1.00×)",
    gauntletCaptainHp(GAUNTLET.rounds[0]) === 350 && gauntletCaptainHp(GAUNTLET.rounds[1]) === 400
    && gauntletCaptainHp(GAUNTLET.rounds[2]) === 500
    && Math.abs(GAUNTLET.rounds.reduce((s, r) => s + r.hpFrac, 0) - 1.0) < 1e-9);
  check("the round order is the gate's commander -> elite -> brute",
    GAUNTLET.rounds[0].kind === "charger" && GAUNTLET.rounds[1].kind === "shielder" && GAUNTLET.rounds[2].kind === "burrower"
    && GAUNTLET.rounds[2].addCount === 0);
  check("intermissions are the authored 5s and the captain transition is 0.8s (≤1.2s cap)",
    GAUNTLET.intermission === 5 && GAUNTLET.captainTransition === 0.8 && GAUNTLET.captainTransition <= 1.2);

  section("corrected gate §7.4: gauntlet TTK — total 55–80s median, ≥35s high-roll, rounds ≥10s");
  const median = measureGauntlet("pistol", [...L3("hair_trigger"), "glass_cannon", "glass_cannon"]);
  record("gauntlet.median.total", median.total);
  median.rounds.forEach((r, i) => record(`gauntlet.median.round${i + 1}`, r));
  check("three ordered captain rounds, never overlapping",
    median.captains.join(" ") === "charger/elite shielder/elite burrower/brute", median.captains.join(" "));
  check("median-build total sits in the 55–80s gate", median.total >= 55 && median.total <= 80,
    `total=${median.total.toFixed(1)}s`);
  check("every median round runs ≥10s", median.rounds.every((r) => r >= 10),
    median.rounds.map((r) => r.toFixed(1)).join("/"));
  const highRoll = measureGauntlet("smg", [...L3("deadeye"), "glass_cannon", "glass_cannon"]);
  record("gauntlet.highRoll.total", highRoll.total);
  check("high-roll total stays ≥35s", highRoll.total >= 35, `total=${highRoll.total.toFixed(1)}s`);
  check("every high-roll round runs ≥10s", highRoll.rounds.every((r) => r >= 10),
    highRoll.rounds.map((r) => r.toFixed(1)).join("/"));
  process.stdout.write(`  info: gauntlet median=${median.total.toFixed(1)}s (${median.rounds.map((r) => r.toFixed(1)).join("/")}), high-roll=${highRoll.total.toFixed(1)}s\n`);
}

// ---- the balancer's elite contract: brace commitment, encounter band, room-clear cost ----

function eliteContractGates(): void {
  section("balancer elite contract: the visible BRACE commitment");
  check("brace numbers: 0.6-1.2s duration, DR ≤25%, recover ≥0.5s, duty ≤35%",
    ELITE_BRACE.duration >= 0.6 && ELITE_BRACE.duration <= 1.2
    && ELITE_BRACE.damageReduction <= 0.25
    && ELITE_BRACE.recover >= 0.5
    && ELITE_BRACE.duration / (ELITE_BRACE.duration + ELITE_BRACE.recover + ELITE_BRACE.cooldown) <= 0.35);
  {
    // The DR window is a reduction, never immunity — measured through a live brace.
    const w = createWorld(0xE11B, 6, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const elite = createEnemy("skeleton", p.x + 200, p.y, 6, new Rng(3), w.nextEnemyId++, { tier: "elite" });
    w.enemies.push(elite);
    elite.hp = elite.maxHp * 0.6; // bloodied: the next idle tick commits the brace
    step(w, idle(1));
    check("a bloodied idle elite commits the brace", elite.attack.move === "brace" && elite.attack.phase === "windup");
    const hp0 = elite.hp;
    plantBullet(w, elite.x, elite.y, 10, 24);
    for (let i = 0; i < 6; i++) step(w, idle(i + 2));
    const taken = hp0 - elite.hp;
    check("braced damage lands at exactly 75% (reduction, never immunity)",
      Math.abs(taken - 10 * (1 - ELITE_BRACE.damageReduction)) < 1e-6, `took ${taken.toFixed(2)}`);
  }
  {
    // Encounter band (aggro → death) + ≥70% commitment execution across seeds.
    let commits = 0;
    let survivors = 0;
    const times: number[] = [];
    for (let s = 0; s < 10; s++) {
      const w = createWorld(0xE17E + s * 131, 6, { isSandbox: true });
      w.isGodMode = true;
      const p = w.players.get(LOCAL_ID)!;
      acquireWeaponInWorld(w, LOCAL_ID, "pistol");
      grant(w, LOCAL_ID, L3("hair_trigger"));
      const elite = createEnemy("skeleton", p.x + 400, p.y + (s % 3) * 40 - 40, 6, new Rng(s + 1), w.nextEnemyId++, { tier: "elite" });
      elite.spawnTimer = 0;
      w.enemies.push(elite);
      let braced = false;
      let ticks = 0;
      while (!elite.dead && ticks < 60 * 10) {
        const aim = Math.atan2(elite.y - p.y, elite.x - p.x);
        step(w, { seq: ticks, moveX: 0, moveY: 0, aim, firing: true, dash: false });
        if (elite.attack.move === "brace") braced = true;
        ticks++;
      }
      const seconds = ticks * DT;
      times.push(seconds);
      if (seconds > 1.5) { survivors++; if (braced) commits++; }
    }
    const worst = Math.max(...times);
    const best = Math.min(...times);
    record("elite.f6.aggroToDeath.min", best);
    record("elite.f6.aggroToDeath.max", worst);
    check("elite aggro→death sits in the durability pass's 3.0-7.0s band across 10 seeds",
      best >= 3.0 && worst <= 7.0, `range=${best.toFixed(2)}-${worst.toFixed(2)}s`);
    check("≥70% of elites surviving >1.5s execute the brace commitment",
      survivors > 0 && commits / survivors >= 0.7, `${commits}/${survivors}`);
  }
  {
    // Room-clear cost at EQUAL THREAT (the envelope prices an elite at 4 threat — it
    // replaces several standard bodies in the director's budget): an elite-led room may
    // cost at most a third more clear time than comparable threat spent on standard
    // bodies — the durability pass explicitly buys "sustained focus" on the big
    // silhouettes, and the higher threat price is what keeps the floor's TOTAL pressure
    // budget-shaped.
    const clearTime = (isEliteRoom: boolean): number => {
      const w = createWorld(0xE17F, 6, { isSandbox: true });
      w.isGodMode = true;
      const p = w.players.get(LOCAL_ID)!;
      acquireWeaponInWorld(w, LOCAL_ID, "pistol");
      grant(w, LOCAL_ID, L3("hair_trigger"));
      // Elite room: skeleton elite (3.0) + 3 slimes = 6.0 threat.
      // Standard room: skeleton + 4 slimes + bat = 6.0 threat.
      const pack = isEliteRoom
        ? [
          createEnemy("skeleton", p.x + 300, p.y - 60, 6, new Rng(5), w.nextEnemyId++, { tier: "elite" }),
          createEnemy("slime", p.x + 340, p.y, 6, new Rng(6), w.nextEnemyId++, {}),
          createEnemy("slime", p.x + 300, p.y + 60, 6, new Rng(7), w.nextEnemyId++, {}),
          createEnemy("slime", p.x + 380, p.y + 30, 6, new Rng(8), w.nextEnemyId++, {}),
        ]
        : [
          createEnemy("skeleton", p.x + 300, p.y - 60, 6, new Rng(5), w.nextEnemyId++, {}),
          createEnemy("slime", p.x + 340, p.y, 6, new Rng(6), w.nextEnemyId++, {}),
          createEnemy("slime", p.x + 300, p.y + 60, 6, new Rng(7), w.nextEnemyId++, {}),
          createEnemy("slime", p.x + 380, p.y + 30, 6, new Rng(8), w.nextEnemyId++, {}),
          createEnemy("slime", p.x + 260, p.y + 90, 6, new Rng(9), w.nextEnemyId++, {}),
          createEnemy("bat", p.x + 380, p.y - 30, 6, new Rng(10), w.nextEnemyId++, {}),
        ];
      for (const e of pack) { e.spawnTimer = 0; w.enemies.push(e); }
      let ticks = 0;
      while (w.enemies.some((e) => !e.dead) && ticks < 60 * 30) {
        const target = w.enemies.find((e) => !e.dead)!;
        const aim = Math.atan2(target.y - p.y, target.x - p.x);
        step(w, { seq: ticks, moveX: 0, moveY: 0, aim, firing: true, dash: false });
        ticks++;
      }
      return ticks * DT;
    };
    const standard = clearTime(false);
    const withElite = clearTime(true);
    record("elite.roomClear.standardThreat", standard);
    record("elite.roomClear.eliteThreat", withElite);
    check("an elite-led room costs ≤35% extra clear time at equal threat (never a sponge room)",
      withElite <= standard * 1.35, `${standard.toFixed(2)}s -> ${withElite.toFixed(2)}s (${(((withElite / standard) - 1) * 100).toFixed(0)}%)`);
  }
}

// ---- the balancer's god-build gate: 100k-build practical-DPS ceilings + sim floors ----
// A deterministic PRACTICAL-DPS ESTIMATOR (documented model, not live telemetry) scores
// every generated legal build against a 12s moving-target window: per-weapon accuracy
// (spread/projectile-speed/family), the boss-facing coefficients (added pellets at 5%,
// crit capped 1.6×, status vulnerability additive-capped 1.35), damage/fire-rate mods.
// 100,000 seeded builds × the pickup arsenal must stay under every per-boss DPS ceiling
// (King 53 binds), the top-100 builds are attributed to fixtures, and the single
// strongest build is then run in the REAL sim against every boss to prove the absolute
// high-roll minimum — no runtime clamp anywhere.

function godBuildGates(): void {
  section("balancer god-build gate: 100k legal builds under the per-boss practical-DPS ceilings");
  let maxDps = 0;
  let maxBuild = "";
  const top: Array<{ dps: number; build: string }> = [];
  forEachLegalBuild(({ weapon, owned, mods }) => {
    const dps = practicalBossDps(weapon, mods);
    if (dps > maxDps) { maxDps = dps; maxBuild = `${weapon} + [${owned.join(",")}]`; }
    if (top.length < 100 || dps > top[top.length - 1].dps) {
      top.push({ dps, build: `${weapon} + [${owned.sort().join(",")}]` });
      top.sort((a, b) => b.dps - a.dps);
      if (top.length > 100) top.pop();
    }
  });
  record("godBuild.maxPracticalDps", maxDps);
  for (const [kind, ceiling] of Object.entries(BOSS_DPS_CEILING) as Array<[EnemyKind, number]>) {
    check(`100k-build max practical DPS ${maxDps.toFixed(1)} ≤ the ${kind} ceiling ${ceiling}`,
      maxDps <= ceiling, maxBuild);
  }
  writeFileSync(new URL("./fixtures/god_build_report.json", import.meta.url), JSON.stringify({
    note: "Top-100 legal builds by ESTIMATED practical boss DPS (deterministic 12s moving-target model — documented in test/balance.test.ts practicalBossDps — not live telemetry).",
    ceilings: BOSS_DPS_CEILING,
    maxPracticalDps: Math.round(maxDps * 100) / 100,
    top100: top.map((x) => ({ dps: Math.round(x.dps * 100) / 100, build: x.build })),
  }, null, 2) + "\n");
  check("top-100 attribution written to test/fixtures/god_build_report.json", top.length === 100);

  section("balancer god-build gate: the strongest estimator build proves every sim floor");
  // The top family from the report: smg carrying max fire-rate/damage/crit stacking.
  const godPicks = [...L3("hair_trigger"), ...L3("glass_cannon"), ...L3("deadeye"), ...L3("split_shot")];
  for (const [kind, floor] of [["boss", 5], ["marrow", 15], ["weaver", 20], ["gilded", 25], ["choir", 30]] as Array<[EnemyKind, number]>) {
    const r = measureBossTtk("smg", godPicks, { kind, floor });
    record(`${kind}.godBuild`, r.seconds);
    const min = BOSS_MIN_LEGAL_TTK[kind] ?? 20;
    // Outlasting the harness window without a kill proves the floor a fortiori (the
    // Warden's plate walks the god build far past the cap).
    check(`the 12-pick god build cannot kill the ${kind} under its ${min}s minimum`,
      !(r.killed && r.seconds < min), r.killed ? `ttk=${r.seconds.toFixed(1)}s` : `unkilled after ${r.seconds.toFixed(0)}s`);
  }
}

// ---- studio gate §2: the mob overlap arbiter ----

function arbiterGates(): void {
  section("studio gate §2 arbiter: no two mob damage releases within 0.30s on one escape lane");
  {
    const w = createWorld(0xA9B1, 7, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    // Two burrowers armed onto the SAME eruption mark, staggered a single tick apart.
    const mkErupt = (e: ReturnType<typeof devSpawnEnemy>, lead: number) => {
      e.attack.phase = "windup";
      e.attack.move = "erupt";
      e.attack.time = lead;
      e.attack.markX = p.x; e.attack.markY = p.y;
      e.spawnTimer = 0;
    };
    const e1 = devSpawnEnemy(w, "burrower", p.x + 60, p.y);
    const e2 = devSpawnEnemy(w, "burrower", p.x - 60, p.y);
    mkErupt(e1, 0.05);
    mkErupt(e2, 0);
    const eruptAt: number[] = [];
    for (let t = 0; t < 120; t++) {
      const evs = step(w, idle(t + 1));
      for (const e of evs) if (e.t === "burrowErupt") eruptAt.push(t * DT);
    }
    check("both eruptions resolve", eruptAt.length === 2, `releases=${eruptAt.length}`);
    check("the second HOLDS until the 0.30s window clears (no same-lane pincer)",
      eruptAt.length === 2 && eruptAt[1] - eruptAt[0] >= 0.30 - 2 * DT,
      `gap=${eruptAt.length === 2 ? (eruptAt[1] - eruptAt[0]).toFixed(2) : "?"}s`);
  }
  {
    // Far-apart releases (different escape lanes) do NOT hold each other.
    const w = createWorld(0xA9B2, 7, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const e1 = devSpawnEnemy(w, "burrower", p.x + 60, p.y);
    const e2 = devSpawnEnemy(w, "burrower", p.x + 700, p.y + 300);
    e1.attack.phase = "windup"; e1.attack.move = "erupt"; e1.attack.time = 0;
    e1.attack.markX = p.x; e1.attack.markY = p.y;
    e2.attack.phase = "windup"; e2.attack.move = "erupt"; e2.attack.time = 0;
    e2.attack.markX = p.x + 700; e2.attack.markY = p.y + 300;
    e1.spawnTimer = 0; e2.spawnTimer = 0;
    const eruptAt: number[] = [];
    for (let t = 0; t < 120; t++) {
      const evs = step(w, idle(t + 1));
      for (const e of evs) if (e.t === "burrowErupt") eruptAt.push(t * DT);
    }
    check("disjoint lanes release independently (same tick allowed)",
      eruptAt.length === 2 && Math.abs(eruptAt[1] - eruptAt[0]) <= 2 * DT,
      `gap=${eruptAt.length === 2 ? Math.abs(eruptAt[1] - eruptAt[0]).toFixed(3) : "?"}s`);
  }
}

// Pin every measurement against the checked-in fixture file — deterministic sim, exact
// equality. `--write-fixtures` regenerates the file after intentional balance changes.
function fixtureGates(): void {
  section("measured-build fixtures (deterministic sim harness — NOT live telemetry)");
  if (process.argv.includes("--write-fixtures")) {
    const payload = {
      note: "Deterministic sim-harness TTK measurements (seeded worlds, scripted aggression). NOT live playtest telemetry. Regenerate: npm run fixtures:ttk",
      builds: {
        median: "pistol + Hair Trigger Lv3 (+ Glass Cannon stack at depth)",
        highRoll: "smg + Deadeye Lv3 + Glass Cannon stack",
        percentiles: "nine-build deterministic ladder per boss (see percentile ladder in bossLadderGates); P10 = fastest decile",
        godBuild: "smg + Glass Cannon/Hair Trigger/Deadeye/Split Shot all Lv3 (12 picks) through the remediated boss-facing damage model",
      },
      measurements: MEASURED,
    };
    writeFileSync(FIXTURES_PATH, JSON.stringify(payload, null, 2) + "\n");
    check(`fixtures written (${Object.keys(MEASURED).length} measurements)`, true);
    return;
  }
  const fixture = JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as { measurements: Record<string, number> };
  let allMatch = true;
  for (const [key, value] of Object.entries(fixture.measurements)) {
    if (MEASURED[key] === undefined || Math.abs(MEASURED[key] - value) > 1e-9) {
      allMatch = false;
      process.stdout.write(`  MISMATCH ${key}: fixture=${value} measured=${MEASURED[key]}\n`);
    }
  }
  check(`every measurement matches the checked-in fixture exactly (${Object.keys(fixture.measurements).length} pins)`,
    allMatch && Object.keys(fixture.measurements).length === Object.keys(MEASURED).length,
    `fixture=${Object.keys(fixture.measurements).length} measured=${Object.keys(MEASURED).length}`);
}

function main(): void {
  enemyTableGates();
  pistolBaselineGates();
  earlyMeltGates();
  bossLadderGates();
  bossOverflowGates();
  normalTtkGates();
  threatBudgetGates();
  compositionCapGates();
  gauntletGates();
  eliteContractGates();
  godBuildGates();
  partyRewardGates();
  arbiterGates();
  sustainGates();
  dashIframeGates();
  powerBudgetGates();
  coopScalingGates();
  reviveGates();
  fixtureGates();
  check("no ITEMS entry exceeds three authored levels", ITEMS.every((it) => it.descs.length === 3));
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll balance ship gates hold.\n");
}

main();
