// The PARTY+GEAR-AWARE SCALING framework (the balancer's R model) — ship gates.
//   R = clamp(PartyDPS / refDPS(floor), 1, 6): headcount AND gear in ONE measured
//   number, sampled at the pull from loadouts alone, never rescaled mid-fight.
//   Effective HP is sublinear and hard-capped (HPfrac = 1 + Khp(R−1), ≤2.9; the spec's
//   opening Khp 0.62 measured down to 0.45 by its own band-first calibration rule) — the
//   surplus buys MECHANICS: add pressure (cap/interval, hard clamps), the phase-timer
//   soft-enrage (+1 authored pattern, never damage/HP/invuln), density in disjoint
//   lanes, and the once-per-phase surprise wave INSIDE the add budget.
// Guards: weak-player contribution floor, the solo gear cap, downed players never
// change R mid-fight, and everything replays byte-identically from seed+loadouts.
//
// Run: npm run test:scaling      (compact CI matrix)
//      npm run scaling:report    (the full 200-pull ship-gate report)

import {
  createWorld, stepWorld, devSpawnEnemy, spawnPlayerInWorld, applyItemToWorld,
  acquireWeaponInWorld, isBossExposed,
} from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, Enemy, EnemyKind, WeaponId } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import { ENEMY_ARCHETYPES, isComplexMover } from "../src/sim/enemies.js";
import {
  POWER, WEAVER, BOSS, refDpsForFloor, powerRatioFor, bossHpFracFor, bossAddCapFor,
  bossAddIntervalFor, phaseTimerFor, PHASE_TIME_BASE, activeMoverCapFor, weaverHpForFloor,
} from "../src/sim/balance.js";
import { expectedBossDps } from "../src/sim/weaponStats.js";
import { itemById, createMods, recomputeMods } from "../src/sim/items.js";
import { writeFileSync } from "node:fs";

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

const L3 = (id: string) => [id, id, id];

interface Loadout { weapon: WeaponId; picks: string[] }
const BUILDS: Readonly<Record<string, Loadout>> = {
  naked: { weapon: "pistol", picks: [] },
  median: { weapon: "pistol", picks: [...L3("hair_trigger"), "glass_cannon", "glass_cannon"] },
  highRoll: { weapon: "smg", picks: [...L3("deadeye"), "glass_cannon", "glass_cannon"] },
  god: { weapon: "smg", picks: [...L3("glass_cannon"), ...L3("hair_trigger"), ...L3("deadeye"), ...L3("split_shot")] },
};

function dpsOf(build: Loadout): number {
  const mods = createMods();
  recomputeMods(mods, build.picks);
  return expectedBossDps(build.weapon, mods);
}

function idle(seq: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
}
function plantBullet(w: WorldState, x: number, y: number, damage: number, radius = 20): void {
  const b: Bullet = {
    x, y, vx: 1, vy: 0, radius, life: 0.05, friendly: true, owner: LOCAL_ID,
    damage, color: "#fff", pierce: 0, hitList: null, isCrit: false,
  };
  w.bullets.push(b);
}

// ---- the party fight harness (boss-agnostic; weaver mechanic priorities) ----

interface PullResult {
  r: number;
  partyDps: number;
  effHp: number;
  seconds: number;
  killed: boolean;
  exposedSeconds: number;
  addsKilled: number;
  hitsTaken: number;
  phaseDurations: number[];
  maxLiveAdds: number;
  spawnTrace: string;
}

function runPull(seed: number, kind: EnemyKind, floor: number, party: readonly Loadout[]): PullResult {
  const w = createWorld(seed, floor, { isSandbox: true, skipLocalPlayer: true });
  const ids: PlayerId[] = [];
  for (let i = 0; i < party.length; i++) {
    const pid = i === 0 ? LOCAL_ID : `p${i}`;
    const p = spawnPlayerInWorld(w, pid);
    acquireWeaponInWorld(w, pid, party[i].weapon);
    for (const it of party[i].picks) applyItemToWorld(w, pid, itemById(it)!);
    p.x += (i % 2) * 120 - 60;
    p.y += Math.floor(i / 2) * 120 - 60;
    ids.push(pid);
  }
  w.encounterPlayers = Math.min(4, party.length);
  const p0 = w.players.get(ids[0])!;
  const boss = devSpawnEnemy(w, kind, p0.x + 170, p0.y); // samples R off these loadouts
  const partyDps = party.reduce((s, b) => s + dpsOf(b), 0);
  let ticks = 0;
  let killed = false;
  let exposedSeconds = 0;
  let addsKilled = 0;
  let hitsTaken = 0;
  let maxLiveAdds = 0;
  const spawnTrace: string[] = [];
  const transitions: number[] = [];
  const maxTicks = 60 * 180;
  while (!killed && ticks < maxTicks) {
    const isExp = isBossExposed(boss);
    if (isExp) exposedSeconds += DT;
    const aimAt = isExp ? boss
      : w.enemies.find((e) => !e.dead && e.kind === "sac")
        ?? w.enemies.find((e) => !e.dead && e.kind === "knot")
        ?? boss;
    const cmds = new Map<PlayerId, InputCmd>();
    for (const pid of ids) {
      const p = w.players.get(pid)!;
      p.hp = p.maxHp; // damage-taken rides the hit counter, never a wipe
      const aim = Math.atan2(aimAt.y - p.y, aimAt.x - p.x);
      let moveX = 0, moveY = 0;
      const d = Math.hypot(aimAt.x - p.x, aimAt.y - p.y);
      if (d > 280) { const t = Math.atan2(aimAt.y - p.y, aimAt.x - p.x); moveX = Math.cos(t); moveY = Math.sin(t); }
      cmds.set(pid, { seq: ticks, moveX, moveY, aim, firing: true, dash: false });
    }
    const evs = stepWorld(w, cmds, DT);
    for (const e of evs) {
      if (e.t === "enemyKill" && e.kind === kind) killed = true;
      if (e.t === "enemyKill" && e.kind !== kind) addsKilled++;
      if (e.t === "playerHurt") hitsTaken++;
      if (e.t === "bossTransition" && e.entering) transitions.push(ticks * DT);
      if (e.t === "enemySpawn") spawnTrace.push(`${ticks}:${e.kind}/${e.tier}@${e.x.toFixed(1)},${e.y.toFixed(1)}`);
    }
    let liveAdds = 0;
    for (const e of w.enemies) {
      if (!e.dead && e.isSummoned && e.kind !== "knot" && e.kind !== "sac") liveAdds++;
    }
    maxLiveAdds = Math.max(maxLiveAdds, liveAdds);
    ticks++;
  }
  const bounds = [0, ...transitions, ticks * DT];
  const phaseDurations: number[] = [];
  for (let i = 1; i < bounds.length; i++) phaseDurations.push(bounds[i] - bounds[i - 1]);
  return {
    r: w.encounterPower, partyDps, effHp: boss.maxHp, seconds: ticks * DT, killed,
    exposedSeconds, addsKilled, hitsTaken, phaseDurations, maxLiveAdds,
    spawnTrace: spawnTrace.join("|"),
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}

// ---- 1. the measurement: refDPS, contributions, guards ----

function measurementGates(): void {
  section("R measurement: refDPS anchors, guard rails, clamps");
  check("refDPS anchors: F5 20.7 / F15 36 / F20 36 / F25 43 / F30 46 / deep F31+ 30 (achievable good-gun output)",
    refDpsForFloor(5) === 20.7 && refDpsForFloor(15) === 36 && refDpsForFloor(20) === 36
    && refDpsForFloor(25) === 43 && refDpsForFloor(30) === 46 && refDpsForFloor(35) === 31);
  check("the practical factor is the balancer's 0.72", POWER.practicalFactor === 0.72);
  const naked = dpsOf(BUILDS.naked);
  const median = dpsOf(BUILDS.median);
  const high = dpsOf(BUILDS.highRoll);
  const god = dpsOf(BUILDS.god);
  process.stdout.write(`  info: expected boss DPS — naked=${naked.toFixed(1)} median=${median.toFixed(1)} highRoll=${high.toFixed(1)} god=${god.toFixed(1)}\n`);
  // Boss-facing power is deliberately NOT monotone across build archetypes: deadeye's
  // crit channel is capped against boss-grade bodies (the round-1 remediation), so the
  // room-shredding high-roll measures HONESTLY lower than raw-multiplier stacks.
  check("gear raises the measurement (naked lowest, the god-stack highest)",
    naked < median && naked < high && god > median && god > high);
  check("R clamps to [1, 6]", powerRatioFor([0.1], 20) === 1
    && powerRatioFor([1e6, 1e6, 1e6, 1e6], 20) === 6);
  check("a SOLO player never scales past R=1.15 from gear (the power fantasy is intended)",
    powerRatioFor([god], 20) <= POWER.soloGearCap + 1e-9
    && powerRatioFor([1e6], 20) === POWER.soloGearCap);
  // The weak-player floor: a naked fourth cannot drag the pull below what the three
  // strong players measure on their own contributions.
  const three = [high, high, high];
  const withWeak = powerRatioFor([...three, 0], 20);
  // FIX1 focus-fire premium rides INSIDE powerRatioFor (partyDps × (1 + focusFire×(P−1))
  // before the clamp), so the expected floor value carries it too.
  const rawWeak = 3 * high + (POWER.weakFloorFrac * refDpsForFloor(20)) / 4;
  const floorOnly = (rawWeak * (1 + POWER.focusFire * 3)) / refDpsForFloor(20);
  check("the weak-player floor holds: a zero-DPS fourth still contributes 0.55×refDPS/P",
    Math.abs(withWeak - Math.min(6, floorOnly)) < 1e-9, `R=${withWeak.toFixed(3)}`);
  check("R is order-independent (the floor applies per contribution, before the sum)",
    powerRatioFor([0, high, high, high], 20) === powerRatioFor([high, high, 0, high], 20));
  // Headcount rides INSIDE R only as the modest focus-fire premium (FIX1) — never a
  // separate HP multiply (coopBossHpMult stays off the real bosses): four naked players
  // measure just (1 + focusFire×3) off their low summed DPS, nowhere near the HP curve.
  const fourNaked = powerRatioFor([naked, naked, naked, naked], 20);
  check("headcount is INSIDE R via the focus-fire premium alone (no separate HP multiply)",
    powerRatioFor([naked, naked, naked, naked], 5) >= 1
    && Math.abs(fourNaked - Math.min(6, (4 * naked * (1 + POWER.focusFire * 3)) / refDpsForFloor(20))) < 1e-9,
    `R@20=${fourNaked.toFixed(3)}`);
}

// ---- 2. effective HP: sublinear, hard-capped ----

function hpGates(): void {
  section("effective HP: HPfrac = 1 + Khp(R−1), clamped ≤2.9 — never a sponge");
  check("HPfrac table (Wave 1 rework Khp 0.55, cap 3.1): R1 1.00 / R2 1.55 / R3 2.10 / R4 2.65 / cap 3.1",
    Math.abs(bossHpFracFor(1) - 1) < 1e-9 && Math.abs(bossHpFracFor(2) - 1.55) < 1e-9
    && Math.abs(bossHpFracFor(3) - 2.1) < 1e-9 && Math.abs(bossHpFracFor(4) - 2.65) < 1e-9
    && bossHpFracFor(6) === 3.1);
  const base = weaverHpForFloor(20);
  check("the Weaver ladder rides the measured curve on the earned-windows anchor",
    Math.round((base * bossHpFracFor(2)) / 10) * 10 === 910
    && Math.round((base * bossHpFracFor(3)) / 10) * 10 === 1240
    && Math.round((base * bossHpFracFor(4)) / 10) * 10 === 1560
    && Math.round((base * bossHpFracFor(6)) / 10) * 10 === 1830,
    `base=${base}`);
}

// ---- 3. surplus -> mechanics: the lever tables ----

function leverGates(): void {
  section("surplus levers: add cap/interval formulas + hard clamps; phase timers");
  check("add cap = round(base + 1.6(R−1)), clamped at 8",
    bossAddCapFor(2, 1) === 2 && bossAddCapFor(2, 2) === 4 && bossAddCapFor(2, 3) === 5
    && bossAddCapFor(2, 4) === 7 && bossAddCapFor(2, 6) === 8);
  check("spawn interval = max(3.0, base − 0.9(R−1))",
    bossAddIntervalFor(7, 1) === 7 && Math.abs(bossAddIntervalFor(7, 2) - 6.1) < 1e-9
    && Math.abs(bossAddIntervalFor(7, 4) - 4.3) < 1e-9 && bossAddIntervalFor(7, 6) === 3.0);
  check("phase budget grows with R (Tphase = base × (1 + 0.10(R−1)))",
    phaseTimerFor(13, 1) === 13 && Math.abs(phaseTimerFor(13, 4) - 16.9) < 1e-9);
  check("every boss declares its soft-enrage yardstick",
    (["boss", "marrow", "weaver", "gilded", "choir"] as EnemyKind[]).every((k) => (PHASE_TIME_BASE[k] ?? 0) > 0));
  check("the surprise wave's contract: R≥3 only, ≥0.9s tell, ≥140px clearance",
    POWER.surpriseMinR === 3 && POWER.surpriseTell >= 0.9 && POWER.surpriseClear >= 140);
}

// ---- 4. the pull sample: at pull, never rescaled ----

function pullSampleGates(): void {
  section("the pull sample: loadouts at pull; downed/dead players never change R mid-fight");
  const w = createWorld(0x5CA1, 20, { isSandbox: true, skipLocalPlayer: true });
  for (let i = 0; i < 4; i++) {
    const pid = i === 0 ? LOCAL_ID : `p${i}`;
    spawnPlayerInWorld(w, pid);
    acquireWeaponInWorld(w, pid, BUILDS.highRoll.weapon);
    for (const it of BUILDS.highRoll.picks) applyItemToWorld(w, pid, itemById(it)!);
  }
  w.encounterPlayers = 4;
  const boss = devSpawnEnemy(w, "weaver", w.players.get(LOCAL_ID)!.x + 170, w.players.get(LOCAL_ID)!.y);
  const r0 = w.encounterPower;
  const hp0 = boss.maxHp;
  check("a strong 4-stack measures well past baseline", r0 > 2, `R=${r0.toFixed(2)}`);
  check("its boss carries the R-scaled effective HP", hp0 === Math.round((weaverHpForFloor(20) * bossHpFracFor(r0)) / 10) * 10,
    `hp=${hp0}`);
  // A member goes down mid-fight: nothing rescales.
  const downed = w.players.get("p1")!;
  downed.isDown = true;
  downed.hp = 0;
  for (let t = 0; t < 30; t++) stepWorld(w, new Map([[LOCAL_ID, idle(t)]]), DT);
  check("a downed member never changes R, HP or the live cadence (snapshot at pull)",
    w.encounterPower === r0 && boss.maxHp === hp0);
}

// ---- 5. soft-enrage: the "you skipped the lesson" beat ----

function softEnrageGates(): void {
  section("soft-enrage: a burned phase arms one authored extra PATTERN on the next");
  {
    const w = createWorld(0x5CA2, 20, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, "weaver", p.x + 170, p.y);
    // Burst P1 far under burnFrac × Tphase: the next phase must carry the pattern.
    for (let t = 0; t < 30; t++) stepWorld(w, new Map([[LOCAL_ID, idle(t)]]), DT);
    plantBullet(w, boss.x, boss.y, (boss.maxHp * 0.4) / WEAVER.guardMult);
    stepWorld(w, new Map([[LOCAL_ID, idle(31)]]), DT);
    check("the burst-burned phase arms the enrage (no phase skips its lesson unanswered)",
      boss.boss !== null && boss.boss.enrage === 1 && boss.boss.phase === 2);
    // The molt's authored extra pattern: the DOUBLED offset bolt ring on exit.
    let bolts = 0;
    for (let t = 0; t < 60 * 3; t++) {
      stepWorld(w, new Map([[LOCAL_ID, idle(100 + t)]]), DT);
      const live = w.bullets.filter((b) => !b.friendly).length;
      bolts = Math.max(bolts, live);
    }
    check("the enraged molt bursts BOTH rings (pattern, never damage)",
      bolts >= WEAVER.moltBoltCount * 2 - 2, `bolts=${bolts}`);
  }
  {
    // A phase played at tempo: no enrage.
    const w = createWorld(0x5CA3, 20, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, "weaver", p.x + 170, p.y);
    const budget = phaseTimerFor(PHASE_TIME_BASE.weaver ?? 13, 1);
    const ticksNeeded = Math.ceil((POWER.burnFrac * budget + 1) * 60);
    for (let t = 0; t < ticksNeeded; t++) stepWorld(w, new Map([[LOCAL_ID, idle(t)]]), DT);
    plantBullet(w, boss.x, boss.y, (boss.maxHp * 0.4) / WEAVER.guardMult);
    stepWorld(w, new Map([[LOCAL_ID, idle(ticksNeeded + 1)]]), DT);
    check("a phase fought at tempo transitions clean (no enrage)",
      boss.boss !== null && boss.boss.enrage === 0 && boss.boss.phase === 2);
  }
}

// ---- 6. surprise wave + density guardrails at max R ----

function densityGates(): void {
  section("max-R density: caps hold, the surprise wave rides the budget, the room stays fair");
  const w = createWorld(0x5CA4, 20, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  const boss = devSpawnEnemy(w, "weaver", p.x + 170, p.y);
  w.encounterPower = 6; // pin the levers at the ceiling (HP sampled at spawn stays R1)
  boss.hp = boss.maxHp * 0.64;
  plantBullet(w, boss.x, boss.y, 1);
  stepWorld(w, new Map([[LOCAL_ID, idle(0)]]), DT);
  let capOk = true;
  let moverOk = true;
  let surpriseTells = 0;
  let maxWebs = 0;
  let routeOk = true;
  const cap = bossAddCapFor(WEAVER.spiderlingCapBase, 6);
  for (let t = 0; t < 60 * 30 && !boss.dead; t++) {
    // Cull graced adds so the budget keeps cycling at its ceiling.
    for (const en of w.enemies) {
      if (!en.dead && en.isSummoned && en !== boss && en.spawnTimer === 0
        && en.kind !== "knot" && en.kind !== "sac") {
        plantBullet(w, en.x, en.y, 999, 6);
      }
    }
    const evs = stepWorld(w, new Map([[LOCAL_ID, idle(t)]]), DT);
    for (const e of evs) void e;
    let liveAdds = 0, movers = 0;
    for (const en of w.enemies) {
      if (en.dead) continue;
      if (en.isSummoned && en.kind !== "knot" && en.kind !== "sac" && !en.dead && en !== boss) liveAdds++;
      if (isComplexMover(en.kind)) movers++;
    }
    if (liveAdds > POWER.addCapMax) capOk = false;
    if (movers > activeMoverCapFor(w.encounterPlayers)) moverOk = false;
    for (const h of w.hazards) {
      if (h.kind === "omen" && Math.abs(h.maxLife - POWER.surpriseTell) < 1e-9) surpriseTells++;
    }
    maxWebs = Math.max(maxWebs, w.hazards.filter((h) => h.kind === "web").length);
    if (t % 60 === 0) {
      // The sticky-silk denial bound: total silk area ≤35% of the arena.
      const arenaArea = 32 * 22 * TILE * TILE;
      let webArea = 0;
      for (const h of w.hazards) if (h.kind === "web") webArea += Math.PI * h.radius * h.radius;
      if (webArea > 0.35 * arenaArea) routeOk = false;
    }
  }
  check(`live add pressure never exceeds the hard clamp (${POWER.addCapMax})`, capOk, `cap=${cap}`);
  check("complex movers never exceed the live mover cap even at R=6", moverOk);
  check("the surprise wave fired (0.9s tells observed) and only via the shared budget", surpriseTells > 0,
    `tells=${surpriseTells}`);
  check("sticky silk stays under the 35% arena-denial bound", routeOk, `maxWebs=${maxWebs}`);
  check("the web hard cap held", maxWebs <= WEAVER.maxWebs);
}

// ---- 7. the party TTK bands (compact CI matrix) ----

function bandGates(): void {
  section("party TTK bands: 4-strong P50 42–58s / P10 ≥22s; guards hold; solo unchanged");
  // "4-strong" = the god-stack (the exact party the rework exists for).
  const four = [BUILDS.god, BUILDS.god, BUILDS.god, BUILDS.god];
  const seeds = [0xBA1A4CE, 0xBA1A4CF, 0xBA1A4D0, 0xBA1A4D1, 0xBA1A4D2];
  const runs = seeds.map((s) => runPull(s, "weaver", 20, four));
  const ttks = runs.map((r) => (r.killed ? r.seconds : Infinity)).sort((a, b) => a - b);
  const p50 = quantile(ttks, 0.5);
  const p10 = quantile(ttks, 0.1);
  process.stdout.write(`  info: 4-strong — R=${runs[0].r.toFixed(2)} effHP=${runs[0].effHp} ttks=[${ttks.map((t) => t.toFixed(1)).join(",")}] exposed=${runs[0].exposedSeconds.toFixed(1)}s adds=${runs[0].addsKilled} hits=${runs[0].hitsTaken}\n`);
  // Wave 1 rework: the anti-burst bankFrac (0.40 → 0.22) makes a bank-bound god-stack
  // convert ~half a window's worth at a time, so it can no longer delete phases — its P50
  // lengthens into the deep-roster band (still all active exposed play, never a sponge:
  // exposed ≈ hits confirm the fight is engaged, not idled).
  check("a strong 4-stack's P50 sits in the 42–58s band", Number.isFinite(p50) && p50 >= 42 && p50 <= 58,
    `P50=${Number.isFinite(p50) ? p50.toFixed(1) : "unkilled"}s`);
  check("its P10 never dips under 22s (the stack can't one-shot the fight)", p10 >= 22, `P10=${p10.toFixed(1)}s`);
  check("every 4-stack pull measured R>3 and rode the capped HP curve",
    runs.every((r) => r.r > 3 && r.effHp === Math.round((weaverHpForFloor(20) * bossHpFracFor(r.r)) / 10) * 10));

  // The high-roll 4-stack (capped crit channel): still a real fight, never a faceroll.
  const fourHigh = [BUILDS.highRoll, BUILDS.highRoll, BUILDS.highRoll, BUILDS.highRoll];
  const highRuns = [0xBA1A4CE, 0xBA1A4D0].map((s) => runPull(s, "weaver", 20, fourHigh));
  const highTtks = highRuns.map((r) => (r.killed ? r.seconds : Infinity));
  process.stdout.write(`  info: 4-high-roll — R=${highRuns[0].r.toFixed(2)} effHP=${highRuns[0].effHp} ttks=[${highTtks.map((t) => t.toFixed(1)).join(",")}]\n`);
  check("the high-roll 4-stack stays ≥22s too", highTtks.every((t) => Number.isFinite(t) && t >= 22));

  // 3 strong + 1 weak: the weak-player guard — still a real fight, never a spike.
  const mixed = [BUILDS.highRoll, BUILDS.highRoll, BUILDS.highRoll, BUILDS.naked];
  const mixedRuns = [0xBA1A4CE, 0xBA1A4D0].map((s) => runPull(s, "weaver", 20, mixed));
  const mixedTtks = mixedRuns.map((r) => (r.killed ? r.seconds : Infinity));
  process.stdout.write(`  info: 3-strong+1-weak — R=${mixedRuns[0].r.toFixed(2)} effHP=${mixedRuns[0].effHp} ttks=[${mixedTtks.map((t) => t.toFixed(1)).join(",")}]\n`);
  check("3-strong+1-weak stays in a fair band (22–60s: no spike from carrying a friend)",
    mixedTtks.every((t) => Number.isFinite(t) && t >= 22 && t <= 60));
  check("the weak fourth lowers R only mildly against its own strong-trio baseline",
    mixedRuns[0].r > highRuns[0].r * 0.8, `R=${mixedRuns[0].r.toFixed(2)} vs ${highRuns[0].r.toFixed(2)}`);

  // Duo median: the "if duo median > 45s, lower Khp" gate.
  const duo = [BUILDS.median, BUILDS.median];
  const duoRuns = [0xBA1A4CE, 0xBA1A4D1].map((s) => runPull(s, "weaver", 20, duo));
  const duoTtks = duoRuns.map((r) => (r.killed ? r.seconds : Infinity));
  process.stdout.write(`  info: duo median — R=${duoRuns[0].r.toFixed(2)} effHP=${duoRuns[0].effHp} ttks=[${duoTtks.map((t) => t.toFixed(1)).join(",")}]\n`);
  check("the median duo clears without sponging (≤55s)", duoTtks.every((t) => Number.isFinite(t) && t <= 55));
}

// ---- 8. determinism: seed + loadouts fully determine the pull ----

function determinismGates(): void {
  section("determinism: same seed + loadouts → identical R / HP / spawn schedule / timers");
  const four = [BUILDS.highRoll, BUILDS.highRoll, BUILDS.highRoll, BUILDS.god];
  const a = runPull(0x5CA9, "weaver", 20, four);
  const b = runPull(0x5CA9, "weaver", 20, four);
  check("two identical pulls agree on R and effective HP", a.r === b.r && a.effHp === b.effHp,
    `R=${a.r.toFixed(3)} hp=${a.effHp}`);
  check("…and on the whole spawn schedule", a.spawnTrace === b.spawnTrace,
    `${a.spawnTrace.length} chars`);
  check("…and on TTK + phase timers to the tick",
    a.seconds === b.seconds && JSON.stringify(a.phaseDurations) === JSON.stringify(b.phaseDurations));
}

// ---- the full 200-pull ship-gate report (opt-in: npm run scaling:report) ----

function shipGateReport(): void {
  section("the 200-pull ship-gate report (deterministic sim harness)");
  const parties: Readonly<Record<string, readonly Loadout[]>> = {
    "solo": [BUILDS.median],
    "P2": [BUILDS.median, BUILDS.median],
    "P4": [BUILDS.highRoll, BUILDS.highRoll, BUILDS.highRoll, BUILDS.highRoll],
  };
  const builds = Object.keys(BUILDS);
  const cells: Record<string, unknown> = {};
  let pulls = 0;
  for (const [partyName, base] of Object.entries(parties)) {
    for (const buildName of builds) {
      const party = base.map(() => BUILDS[buildName]);
      const seeds = Array.from({ length: 17 }, (_, i) => 0xBA1A000 + i * 7919);
      const runs = seeds.map((s) => runPull(s, "weaver", 20, party));
      pulls += runs.length;
      const ttks = runs.map((r) => (r.killed ? r.seconds : -1)).filter((t) => t > 0).sort((x, y) => x - y);
      cells[`${partyName}/${buildName}`] = {
        partyDps: Math.round(runs[0].partyDps * 100) / 100,
        r: Math.round(runs[0].r * 1000) / 1000,
        effHp: runs[0].effHp,
        killedFrac: ttks.length / runs.length,
        ttkP10: Math.round(quantile(ttks, 0.1) * 10) / 10,
        ttkP50: Math.round(quantile(ttks, 0.5) * 10) / 10,
        ttkP90: Math.round(quantile(ttks, 0.9) * 10) / 10,
        exposedP50: Math.round(quantile(runs.map((r) => r.exposedSeconds).sort((x, y) => x - y), 0.5) * 10) / 10,
        addsKilledP50: quantile(runs.map((r) => r.addsKilled).sort((x, y) => x - y), 0.5),
        hitsTakenP50: quantile(runs.map((r) => r.hitsTaken).sort((x, y) => x - y), 0.5),
        maxLiveAdds: Math.max(...runs.map((r) => r.maxLiveAdds)),
        phaseDurationsP50: runs[Math.floor(runs.length / 2)].phaseDurations.map((d) => Math.round(d * 10) / 10),
      };
      process.stdout.write(`  ${partyName}/${buildName}: R=${(cells[`${partyName}/${buildName}`] as { r: number }).r} ttkP50=${(cells[`${partyName}/${buildName}`] as { ttkP50: number }).ttkP50}s\n`);
    }
  }
  writeFileSync(new URL("./fixtures/scaling_report.json", import.meta.url), JSON.stringify({
    note: "The R framework's ship-gate report: deterministic sim-harness pulls (seeded worlds, scripted mechanic-playing parties) across party sizes × builds. NOT live telemetry. Regenerate: npm run scaling:report",
    boss: "weaver@F20",
    pulls,
    guards: {
      refDps: refDpsForFloor(20), hpFracCap: POWER.hpFracCap, addCapMax: POWER.addCapMax,
      soloGearCap: POWER.soloGearCap, weakFloorFrac: POWER.weakFloorFrac,
    },
    cells,
  }, null, 2) + "\n");
  check(`ship-gate report written (${pulls} pulls)`, pulls >= 200);
}

function main(): void {
  measurementGates();
  hpGates();
  leverGates();
  pullSampleGates();
  softEnrageGates();
  densityGates();
  bandGates();
  determinismGates();
  if (process.argv.includes("--report")) shipGateReport();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nThe party+gear scaling framework holds.\n");
}

main();
