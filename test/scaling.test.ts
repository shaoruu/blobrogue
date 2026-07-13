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

// ---- the mechanic-playing bot: a shared driver + a per-boss window-opener ----
// KEY FINDING (spec §1): the exposed-window machinery is ALREADY universal —
// isBossExposed(e) = e.boss.exposed > 0, and every earned boss opens its window through the
// shared openBossWindow / EARNED_WINDOWS bank. So the bot's "deal damage while exposed, else
// attack the thing that OPENS the window" loop is boss-agnostic; only TARGET SELECTION while
// the boss is NOT exposed is per-boss. That per-boss part lives in WINDOW_OPENERS[kind]; the
// driver (aim, approach-to-range, fire, tally) is shared. Only Marrow needs a MOVE beyond aim
// (bait the rush into a wall crash) and Choir a small standoff strafe — both live in botMoveFor.
// This is the same bot the balance-suite §3 gate uses (dpsHarness.measureBossTtk), lifted into
// the party+gear harness so it runs at any R across N seeds.

type Vec = { readonly x: number; readonly y: number };

// The sandbox arena's inner bounds (buildArena: 34×24 tiles, 1-tile border) — the Marrow
// bait geometry holds a stride off the boss toward its nearest wall (dpsHarness parity).
const ARENA = { x0: 48, y0: 48, x1: 33 * TILE, y1: 23 * TILE };

// Quorum's highest-priority LIVING husk (shield → heal → dmg): the only husk that takes FULL
// pool damage (a lower one is chipped), so the bot must respect the kill-order or it stalls.
function quorumPriorityHusk(w: WorldState, coreId: number): Enemy | undefined {
  for (const kind of ["quorum_shield", "quorum_heal", "quorum_dmg"] as const) {
    const h = w.enemies.find((e) => !e.dead && e.kind === kind && e.seq === coreId + 1);
    if (h) return h;
  }
  return undefined;
}

// Is the boss taking FULL damage on its intended target right now? For the F15–35 roster + the
// Tithe this is exactly isBossExposed (boss.exposed > 0). Quorum's P1 pool is guarded by the
// husk trio (not a timed window): it is EXPOSED while the trio is cleared (huskGuardUp false)
// or during a merge-form window — so its exposed tally counts the pool-open + merge windows.
function bossExposedNow(e: Enemy): boolean {
  const boss = e.boss;
  if (!boss) return false;
  if (e.kind === "quorum") return boss.exposed > 0 || (boss.phase < 2 && boss.huskRaised && !boss.huskGuardUp);
  return isBossExposed(e);
}

// Per-boss TARGET SELECTION while the boss is NOT exposed (the only authored-per-boss part).
// Returns the aim target; the driver handles the shared "exposed → shoot the body" case.
type WindowOpener = (w: WorldState, boss: Enemy) => Vec;
const WINDOW_OPENERS: Readonly<Partial<Record<EnemyKind, WindowOpener>>> = {
  // Weaver (F20, reference): shoot the egg-SAC clutch (P2 forced-down), then a lattice KNOT
  // (P1 break / P3 lane denial), then the body. (Unchanged from the original harness.)
  weaver: (w, boss) => w.enemies.find((e) => !e.dead && e.kind === "sac")
    ?? w.enemies.find((e) => !e.dead && e.kind === "knot")
    ?? boss,
  // Choir (F30): silence the gathered voice fragments of the current verse (the summoner's
  // windowAddIds set — WHICH voice varies per fair-surprise §1, so target the TASK, not a kind).
  choir: (w, boss) => {
    const ids = boss.boss?.windowAddIds ?? [];
    return w.enemies.find((e) => !e.dead && e.isSummoned && ids.includes(e.id)) ?? boss;
  },
  // Tithe (F40): guardMult 0.0 — the body is pointless while armored; the ONLY damage path is
  // breaking the feeding SLAB(s) to interrupt the feed → EXPOSED. Aim slabs while armored.
  tithe: (w, boss) => w.enemies.find((e) => !e.dead && e.kind === "tithe_slab") ?? boss,
  // Quorum (F45): merge-form (phase ≥ 2) is fought directly; otherwise focus the priority husk
  // in KILL-ORDER (shield → heal → dmg) to drain the shared pool toward the merge / pool window.
  quorum: (w, boss) => {
    if ((boss.boss?.phase ?? 1) >= 2) return boss;
    return quorumPriorityHusk(w, boss.id) ?? boss;
  },
  // Gorge (F50 giant): guardMult 0.0 — the body is pointless while shelled; the ONLY damage path
  // is PEELING (destroy the tectonic weak-points → openBossWindow). This is the PER-PHASE opener:
  // the seams belong to whichever shell is current, so targeting the live seams peels rind → then
  // chitin → then core as the fight escalates. Target them in SPAWN order (= arc order — the sim
  // juts them across the shell arc from one end to the other), so a competent player sweeps the
  // arc one direction instead of zig-zagging; the shared driver bursts the body during the exposed
  // window. A bot that can't reach the seams never opens a window → FAILS LOUD via the (A) gate.
  gorge: (w, boss) => w.enemies.find((e) => !e.dead && e.kind === "gorge_seam") ?? boss,
  // Pale Throne (F75 giant): the SECOND giant — REUSES Gorge's per-phase opener wholesale (same
  // machinery), only the weak-point kind differs (cold pale_seam). Peel the live seams (stone →
  // cracked → core) in spawn/arc order; the shared driver bursts the bared body in the window.
  pale: (w, boss) => w.enemies.find((e) => !e.dead && e.kind === "pale_seam") ?? boss,
  // Marrow/Gilded/Jet/King: no not-exposed body — the driver just fires the boss (Marrow's
  // crash is baited by botMoveFor; Gilded/Jet windows ride their own commitment-recover cadence;
  // King has no guard at all). Absent from the map → the driver falls back to the boss body.
};

// The Marrow bait point: a stride off the boss toward its NEAREST wall. The bot holds here and
// freezes until the rush LOCKS, then sidesteps — the committed rush carries past into the wall
// (the crash that opens Marrow's ONLY window). Mirrors dpsHarness.measureBossTtk exactly.
function marrowBaitPoint(boss: Enemy): Vec {
  const dW = boss.x - ARENA.x0, dE = ARENA.x1 - boss.x, dN = boss.y - ARENA.y0, dS = ARENA.y1 - boss.y;
  const min = Math.min(dW, dE, dN, dS);
  const dir = min === dW ? [-1, 0] : min === dE ? [1, 0] : min === dN ? [0, -1] : [0, 1];
  return {
    x: Math.max(ARENA.x0 + 110, Math.min(ARENA.x1 - 110, boss.x + dir[0] * 130)),
    y: Math.max(ARENA.y0 + 110, Math.min(ARENA.y1 - 110, boss.y + dir[1] * 130)),
  };
}

// Per-boss MOVEMENT. Default: approach the aim target to firing range, then hold. Marrow baits
// the wall crash; Choir keeps a small standoff strafe. (Weaver/Gilded/Jet/Tithe/Quorum/King all
// use the shared approach, so the driver stays boss-agnostic outside these two.)
function botMoveFor(kind: EnemyKind, boss: Enemy, px: number, py: number, aimAt: Vec): Vec {
  if (kind === "marrow" && !boss.dead) {
    const a = boss.attack;
    if (a.move === "rush" && ((a.phase === "windup" && a.isAimLocked) || a.phase === "active")) {
      const side = a.lockedAngle + Math.PI / 2; // sidestep: the locked rush carries past into the wall
      return { x: Math.cos(side), y: Math.sin(side) };
    }
    const bait = marrowBaitPoint(boss);
    if (Math.hypot(bait.x - px, bait.y - py) > 24) {
      const back = Math.atan2(bait.y - py, bait.x - px);
      return { x: Math.cos(back), y: Math.sin(back) };
    }
    return { x: 0, y: 0 };
  }
  if (kind === "choir" && !boss.dead) {
    if (Math.hypot(boss.x - px, boss.y - py) < 170) {
      const away = Math.atan2(py - boss.y, px - boss.x) + 0.7;
      return { x: Math.cos(away), y: Math.sin(away) };
    }
    return { x: 0, y: 0 };
  }
  if ((kind === "gorge" || kind === "pale") && !boss.dead) {
    // The GIANTS (Gorge F50 / Pale Throne F75) are stationary set-pieces with a GUARDED body:
    // bullets must reach the tectonic seams (which jut out FACING the player, capped to a front arc
    // so each has clear LOS past it to the shell). A competent player holds a firing standoff facing
    // the giant and tracks the seam arc; only close in if too far. aimAt is the current target seam
    // (sealed) or the body (exposed) — approach it to a mid firing range, then hold and track the arc.
    const d = Math.hypot(aimAt.x - px, aimAt.y - py);
    if (d > 220) { const t = Math.atan2(aimAt.y - py, aimAt.x - px); return { x: Math.cos(t), y: Math.sin(t) }; }
    return { x: 0, y: 0 };
  }
  const d = Math.hypot(aimAt.x - px, aimAt.y - py);
  if (d > 280) { const t = Math.atan2(aimAt.y - py, aimAt.x - px); return { x: Math.cos(t), y: Math.sin(t) }; }
  return { x: 0, y: 0 };
}

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

// The shared driver + the per-boss window-opener hook (spec §3). Weaver's behaviour is
// byte-identical to the original runPull (same aim fallback, same approach movement), so the
// R-framework weaver gates below and the ship-gate report numbers are unchanged.
function runInstrumentedPull(seed: number, kind: EnemyKind, floor: number, party: readonly Loadout[]): PullResult {
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
  const opener = WINDOW_OPENERS[kind];
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
    const isExp = bossExposedNow(boss);
    if (isExp) exposedSeconds += DT;
    // Shared: exposed → shoot the body. Not exposed → the per-boss window-opener's target.
    const aimAt: Vec = isExp ? boss : (opener ? opener(w, boss) : boss);
    const cmds = new Map<PlayerId, InputCmd>();
    for (const pid of ids) {
      const p = w.players.get(pid)!;
      p.hp = p.maxHp; // damage-taken rides the hit counter, never a wipe
      const aim = Math.atan2(aimAt.y - p.y, aimAt.x - p.x);
      const mv = botMoveFor(kind, boss, p.x, p.y, aimAt);
      cmds.set(pid, { seq: ticks, moveX: mv.x, moveY: mv.y, aim, firing: true, dash: false });
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
  check("refDPS anchors: F5 20.7 / F15 36 / F20 36 / F25 43 / F30 46 / deep F35-45 46 (finale band; balancer FINAL)",
    refDpsForFloor(5) === 20.7 && refDpsForFloor(15) === 36 && refDpsForFloor(20) === 36
    && refDpsForFloor(25) === 43 && refDpsForFloor(30) === 46
    && refDpsForFloor(35) === 46 && refDpsForFloor(40) === 46 && refDpsForFloor(45) === 46);
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
  const runs = seeds.map((s) => runInstrumentedPull(s, "weaver", 20, four));
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
  const highRuns = [0xBA1A4CE, 0xBA1A4D0].map((s) => runInstrumentedPull(s, "weaver", 20, fourHigh));
  const highTtks = highRuns.map((r) => (r.killed ? r.seconds : Infinity));
  process.stdout.write(`  info: 4-high-roll — R=${highRuns[0].r.toFixed(2)} effHP=${highRuns[0].effHp} ttks=[${highTtks.map((t) => t.toFixed(1)).join(",")}]\n`);
  check("the high-roll 4-stack stays ≥22s too", highTtks.every((t) => Number.isFinite(t) && t >= 22));

  // 3 strong + 1 weak: the weak-player guard — still a real fight, never a spike.
  const mixed = [BUILDS.highRoll, BUILDS.highRoll, BUILDS.highRoll, BUILDS.naked];
  const mixedRuns = [0xBA1A4CE, 0xBA1A4D0].map((s) => runInstrumentedPull(s, "weaver", 20, mixed));
  const mixedTtks = mixedRuns.map((r) => (r.killed ? r.seconds : Infinity));
  process.stdout.write(`  info: 3-strong+1-weak — R=${mixedRuns[0].r.toFixed(2)} effHP=${mixedRuns[0].effHp} ttks=[${mixedTtks.map((t) => t.toFixed(1)).join(",")}]\n`);
  check("3-strong+1-weak stays in a fair band (22–60s: no spike from carrying a friend)",
    mixedTtks.every((t) => Number.isFinite(t) && t >= 22 && t <= 60));
  check("the weak fourth lowers R only mildly against its own strong-trio baseline",
    mixedRuns[0].r > highRuns[0].r * 0.8, `R=${mixedRuns[0].r.toFixed(2)} vs ${highRuns[0].r.toFixed(2)}`);

  // Duo median: the "if duo median > 45s, lower Khp" gate.
  const duo = [BUILDS.median, BUILDS.median];
  const duoRuns = [0xBA1A4CE, 0xBA1A4D1].map((s) => runInstrumentedPull(s, "weaver", 20, duo));
  const duoTtks = duoRuns.map((r) => (r.killed ? r.seconds : Infinity));
  process.stdout.write(`  info: duo median — R=${duoRuns[0].r.toFixed(2)} effHP=${duoRuns[0].effHp} ttks=[${duoTtks.map((t) => t.toFixed(1)).join(",")}]\n`);
  check("the median duo clears without sponging (≤55s)", duoTtks.every((t) => Number.isFinite(t) && t <= 55));
}

// ---- 8. determinism: seed + loadouts fully determine the pull ----

function determinismGates(): void {
  section("determinism: same seed + loadouts → identical R / HP / spawn schedule / timers");
  const four = [BUILDS.highRoll, BUILDS.highRoll, BUILDS.highRoll, BUILDS.god];
  const a = runInstrumentedPull(0x5CA9, "weaver", 20, four);
  const b = runInstrumentedPull(0x5CA9, "weaver", 20, four);
  check("two identical pulls agree on R and effective HP", a.r === b.r && a.effHp === b.effHp,
    `R=${a.r.toFixed(3)} hp=${a.effHp}`);
  check("…and on the whole spawn schedule", a.spawnTrace === b.spawnTrace,
    `${a.spawnTrace.length} chars`);
  check("…and on TTK + phase timers to the tick",
    a.seconds === b.seconds && JSON.stringify(a.phaseDurations) === JSON.stringify(b.phaseDurations));
  // The per-boss window-opener path is deterministic too: a deep boss (Quorum, the kill-order
  // bot) replays byte-identically — same seed + loadouts → identical TTK, exposed and spawns.
  const qa = runInstrumentedPull(0x5CAB, "quorum", 45, [BUILDS.median]);
  const qb = runInstrumentedPull(0x5CAB, "quorum", 45, [BUILDS.median]);
  check("a deep-boss window-opener pull replays identically (TTK, exposed, spawn schedule)",
    qa.seconds === qb.seconds && qa.exposedSeconds === qb.exposedSeconds && qa.spawnTrace === qb.spawnTrace,
    `ttk=${qa.seconds.toFixed(2)}s exposed=${qa.exposedSeconds.toFixed(2)}s`);
}

// ---- 9. the MULTI-BOSS instrumented health gate (all 9 shipped bosses) ----
// A STANDING gate: on every content wave, does the calibrated bot's TTK/exposed for ANY
// shipped boss drift out of its band? Each boss runs at ITS floor, N≥20 seeds, two asserted
// cells (solo/median + 4-strong) against the per-boss BOSS_BANDS. The 5 calibrated bosses
// (King/Marrow/Weaver/Gilded/Choir) gate HARD on the shipped balance.test.ts bands; the three
// Wave-1 bosses (Jet/Tithe/Quorum) are placeholders — MEASURED + SURFACED (never failed red)
// so the balancer can harden their real rows. A boss whose bot CANNOT open its window
// (NOKILL / exposed≈0) FAILS LOUD as "bot-can't-play-this-boss" — never a silent pass.

const CANT_PLAY_EXPOSED_EPS = 0.5; // a guarded boss under this much exposed = broken bot, not a fight
const CELL_SEEDS = Array.from({ length: 20 }, (_, i) => 0xBA1A000 + i * 7919); // N=20 per cell

interface BossBand {
  floor: number;
  // The solo/median cell's loadout. For the 5 calibrated bosses this is the EXACT
  // balance.test.ts §3 per-boss median build (so the shipped bands reproduce here); the three
  // placeholders pick a representative deep-roster build (balancer re-measures on build).
  weapon: WeaponId;
  build: string[];
  soloWall: readonly [number, number];        // solo/median wall-clock TTK band
  exposed: readonly [number, number] | null;  // solo/median EXPOSED-time band (King: no guard)
  minLegal: number;                           // 4-strong P10 floor (the anti-one-shot bound)
  party4: readonly [number, number];          // 4-strong P50 band
  calibrated: boolean;   // solo wall+exposed gate HARD (shipped balance.test.ts numbers)
  calibrated4: boolean;  // 4-strong P50 gates HARD (only Weaver's is independently validated)
}

// BOSS_BANDS — exposedBand values are the SHIPPED balance.test.ts per-boss gates (NOT a uniform
// 20–30). Jet/Tithe/Quorum's wall/exposed are Wave-1 PLACEHOLDERS ("re-measure on build"):
// gated soft (measured + surfaced), never failed red. The balancer owns every number here.
const BOSS_BANDS: Readonly<Record<string, BossBand>> = {
  boss: { floor: 5, weapon: "pistol", build: L3("hair_trigger"),
    soloWall: [35, 50], exposed: null, minLegal: 20, party4: [42, 58], calibrated: true, calibrated4: false }, // King: no guard, no exposed gate; a god-stack facerolls the tutorial (party4 surfaced)
  marrow: { floor: 15, weapon: "pistol", build: [...L3("hair_trigger"), "glass_cannon", "glass_cannon"],
    soloWall: [40, 63], exposed: [8, 20], minLegal: 20, party4: [42, 58], calibrated: true, calibrated4: false },
  weaver: { floor: 20, weapon: "pistol", build: [...L3("hair_trigger"), "glass_cannon", "glass_cannon"],
    soloWall: [38, 58], exposed: [16, 30], minLegal: 20, party4: [42, 58], calibrated: true, calibrated4: true }, // the earned-windows flagship (4-strong band = the existing scaling gate)
  gilded: { floor: 25, weapon: "pistol", build: [...L3("hair_trigger"), ...L3("glass_cannon")],
    soloWall: [40, 58], exposed: [20, 34], minLegal: 22, party4: [42, 58], calibrated: true, calibrated4: false },
  choir: { floor: 30, weapon: "pistol", build: [...L3("hair_trigger"), ...L3("glass_cannon")],
    soloWall: [40, 64], exposed: [12, 26], minLegal: 22, party4: [46, 62], calibrated: true, calibrated4: false }, // finale: longest wall; a 4-strong pull is window-count-bound (~2× solo), surfaced not gated
  jet: { floor: 35, weapon: "pistol", build: [...L3("hair_trigger"), "glass_cannon", "glass_cannon"],
    soloWall: [28, 48], exposed: [14, 26], minLegal: 22, party4: [42, 60], calibrated: true, calibrated4: true }, // Wave-1 CALIBRATED (balancer, from harness N=20): measured wall 33.6 / exp 19.7 / 4p P50 50.9. Lower wall floor (28) is correct — Jet's window is the mirror-salvo spent-recover CADENCE (no dash/body gate), so it's intentionally one of the faster deep bosses (mirror duel, not endurance).
  tithe: { floor: 40, weapon: "pistol", build: [...L3("hair_trigger"), ...L3("glass_cannon")],
    soloWall: [40, 60], exposed: [18, 30], minLegal: 22, party4: [40, 56], calibrated: true, calibrated4: true }, // Wave-1 CALIBRATED (balancer, from harness N=20): measured wall 48.3 / exp 24.3 / 4p P50 46.0.
  quorum: { floor: 45, weapon: "pistol", build: [...L3("hair_trigger"), ...L3("glass_cannon")],
    // Wave-1 CALIBRATED (balancer, from harness N=20): measured wall 44.1 / exp 8.2 / 4p P50 30.6.
    // NOTE: Quorum's exposed band [5,14] is INTENTIONALLY low, NOT a regression — most P1 damage
    // flows through the priority husk into the shared POOL (counted as mechanic-solving, not
    // "exposed"), so its exposed tally is structurally lower than the roster. For Quorum the WALL
    // band is the primary TTK gate; exposed is a secondary sanity check. Do NOT "fix" the low
    // exposed by widening it to the roster's [12,26] — that would defeat the gate.
    soloWall: [36, 54], exposed: [5, 14], minLegal: 22, party4: [26, 40], calibrated: true, calibrated4: true },
  // GORGE (F50 GIANT #1): a K=3 shell-peel giant, PROVISIONAL bands from the balancer (measured +
  // surfaced, never failed red — hardens when the harness bot measures it). The HARD gates STILL
  // apply: (A) the bot MUST open windows + kill it (peeling the tectonic seams — else it never
  // dies = FAIL LOUD), and (C) the 4-strong P10 must stay >= min-legal (a stack can't one-burst
  // the giant — the PER-PHASE window bank (0.22 × each shell's HP) + 3-phase structure hold it: a
  // 4-stack still needs ~5 windows/phase). The exposed tally is the sum of the peel windows. The
  // WINDOW_OPENERS.gorge opener peels whatever shell is current (rind → chitin → core).
  gorge: { floor: 50, weapon: "pistol", build: [...L3("hair_trigger"), ...L3("glass_cannon")],
    soloWall: [56, 78], exposed: [26, 40], minLegal: 22, party4: [40, 58], calibrated: false, calibrated4: false },
  // PALE THRONE (F75 GIANT #2): the region cap — the SAME K=3 shell-peel giant as Gorge, reusing its
  // machinery, with the region-cap calibration (total 1220 = 1.3× Gorge, a TIGHTER 0.20 per-phase
  // bank, and a higher min-legal). PROVISIONAL bands from the balancer (measured + surfaced, never
  // failed red — hardens when the harness bot measures it). The HARD gates STILL apply: (A) the bot
  // MUST open windows (peel the cold pale_seams) + kill it — else FAIL LOUD — and (C) the 4-strong
  // P10 must stay >= min-legal 25 (a stack can't one-burst the giant: the 0.20 per-phase bank + the
  // 3-phase structure hold it). The WINDOW_OPENERS.pale opener peels whatever shell is current.
  // (Balancer label "pale_throne" maps to the EnemyKind `pale` — the harness keys rows by kind.)
  pale: { floor: 75, weapon: "pistol", build: [...L3("hair_trigger"), ...L3("glass_cannon")],
    soloWall: [62, 86], exposed: [34, 50], minLegal: 25, party4: [44, 64], calibrated: false, calibrated4: false },
};

const GOD_PARTY: readonly Loadout[] = [BUILDS.god, BUILDS.god, BUILDS.god, BUILDS.god];

function inRange(v: number, band: readonly [number, number]): boolean {
  return v >= band[0] && v <= band[1];
}

function surface(msg: string): void {
  process.stdout.write(`  SURFACE  ${msg}\n`);
}

// A loud, greppable flag line (never a hard fail) — for measured signals the balancer must SEE at
// review even though the exact threshold isn't gated yet (e.g. the giant sponge-check below).
function warn(msg: string): void {
  process.stdout.write(`  WARN  ${msg}\n`);
}

function buildLabel(weapon: WeaponId, picks: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const p of picks) counts.set(p, (counts.get(p) ?? 0) + 1);
  const parts = [...counts.entries()].map(([k, n]) => (n > 1 ? `${k}×${n}` : k));
  return parts.length ? `${weapon}+${parts.join(",")}` : weapon;
}

interface CellStats {
  killedFrac: number;
  r: number;
  effHp: number;
  wallP10: number;
  wallP50: number;
  wallP90: number;
  exposedP50: number;
  // EXPOSED-EFFICIENCY: the per-run median of exposed-window time / total fight time — the fraction
  // of the fight the bot spends FREE-DPSing the exposed core vs. "in mechanic" (guarded/peeling/
  // dodging). The giant sponge-check reads this: at the same build, a HARDER giant (more mechanics)
  // has a LOWER exposed-efficiency; a SPONGE giant (just more HP) keeps the same efficiency.
  exposedEffP50: number;
  addsKilledP50: number;
  hitsTakenP50: number;
  maxLiveAdds: number;
}

function measureCell(kind: EnemyKind, floor: number, party: readonly Loadout[], seeds: readonly number[]): CellStats {
  const runs = seeds.map((s) => runInstrumentedPull(s, kind, floor, party));
  const killed = runs.filter((r) => r.killed);
  const ttks = killed.map((r) => r.seconds).sort((a, b) => a - b);
  const wallP10 = ttks.length ? quantile(ttks, 0.1) : Infinity;
  const wallP50 = ttks.length ? quantile(ttks, 0.5) : Infinity;
  const wallP90 = ttks.length ? quantile(ttks, 0.9) : Infinity;
  const sortedBy = (pick: (r: PullResult) => number): number[] => runs.map(pick).sort((a, b) => a - b);
  return {
    killedFrac: killed.length / runs.length,
    r: runs[0].r,
    effHp: runs[0].effHp,
    wallP10, wallP50, wallP90,
    exposedP50: quantile(sortedBy((r) => r.exposedSeconds), 0.5),
    exposedEffP50: quantile(sortedBy((r) => (r.seconds > 0 ? r.exposedSeconds / r.seconds : 0)), 0.5),
    addsKilledP50: quantile(sortedBy((r) => r.addsKilled), 0.5),
    hitsTakenP50: quantile(sortedBy((r) => r.hitsTaken), 0.5),
    maxLiveAdds: Math.max(...runs.map((r) => r.maxLiveAdds)),
  };
}

// The pure band verdict for a solo/median cell — shared by the gate AND the deliberate-drift
// self-test (so both read the identical pass/fail logic). Returns per-axis booleans + reasons.
function checkSoloBand(band: BossBand, solo: CellStats): { wallOk: boolean; exposedOk: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const wallOk = solo.killedFrac === 1 && inRange(solo.wallP50, band.soloWall);
  if (!wallOk) reasons.push(`wall P50 ${solo.wallP50.toFixed(1)}s vs [${band.soloWall}]`);
  const exposedOk = band.exposed === null || inRange(solo.exposedP50, band.exposed);
  if (!exposedOk) reasons.push(`exposed P50 ${solo.exposedP50.toFixed(1)}s vs [${band.exposed}]`);
  return { wallOk, exposedOk, reasons };
}

interface BossGateResult {
  floor: number;
  solo: CellStats;
  four: CellStats;
  band: BossBand;
  inBand: boolean;
}

function multiBossGate(): Map<string, BossGateResult> {
  section("multi-boss health gate: every shipped boss in its TTK/exposed band (calibrated hard, Wave-1 surfaced)");
  const out = new Map<string, BossGateResult>();
  for (const [kind, band] of Object.entries(BOSS_BANDS)) {
    const ek = kind as EnemyKind;
    const solo = measureCell(ek, band.floor, [{ weapon: band.weapon, picks: band.build }], CELL_SEEDS);
    const four = measureCell(ek, band.floor, GOD_PARTY, CELL_SEEDS);
    process.stdout.write(
      `  info: ${kind}@F${band.floor} — solo(${buildLabel(band.weapon, band.build)}) R=${solo.r.toFixed(2)} effHP=${solo.effHp} `
      + `wallP50=${solo.wallP50.toFixed(1)}s exposedP50=${solo.exposedP50.toFixed(1)}s killed=${(solo.killedFrac * 100).toFixed(0)}% | `
      + `4-strong R=${four.r.toFixed(2)} effHP=${four.effHp} P10=${four.wallP10.toFixed(1)}s P50=${four.wallP50.toFixed(1)}s exposedP50=${four.exposedP50.toFixed(1)}s\n`);

    // (A) bot-can't-play-this-boss — HARD for every boss (never a silent pass). A guarded boss
    // that never opens a window (exposed≈0) or that the bot cannot kill is a BROKEN BOT, the
    // false-positive class the per-boss window-opener exists to prevent — distinct from a drift.
    const isWindowOpen = band.exposed === null || solo.exposedP50 >= CANT_PLAY_EXPOSED_EPS;
    const isPlayable = solo.killedFrac === 1 && isWindowOpen;
    check(`${kind}: bot opens its window (NOT bot-can't-play-this-boss ${kind})`, isPlayable,
      `killed=${(solo.killedFrac * 100).toFixed(0)}% exposedP50=${solo.exposedP50.toFixed(1)}s`);

    // (B) solo/median wall + exposed bands.
    const verdict = checkSoloBand(band, solo);
    if (band.calibrated) {
      check(`${kind}: solo/median wall TTK in ${band.soloWall[0]}–${band.soloWall[1]}s`, verdict.wallOk,
        `wallP50=${solo.wallP50.toFixed(1)}s`);
      if (band.exposed !== null) {
        check(`${kind}: solo/median EXPOSED time in ${band.exposed[0]}–${band.exposed[1]}s`, verdict.exposedOk,
          `exposedP50=${solo.exposedP50.toFixed(1)}s`);
      }
    } else {
      surface(`${kind}@F${band.floor} PLACEHOLDER solo/median: measured wall ${solo.wallP50.toFixed(1)}s (placeholder [${band.soloWall}]), `
        + `exposed ${solo.exposedP50.toFixed(1)}s (placeholder [${band.exposed}]) — balancer to set the real gate row`);
    }

    // (C) 4-strong: P10 anti-one-shot floor (HARD, all bosses) + P50 party band.
    check(`${kind}: 4-strong P10 wall ≥ min-legal ${band.minLegal}s (a stack can't delete the fight)`,
      four.wallP10 >= band.minLegal, `P10=${four.wallP10.toFixed(1)}s`);
    if (band.calibrated4) {
      check(`${kind}: 4-strong P50 in the ${band.party4[0]}–${band.party4[1]}s party band`,
        Number.isFinite(four.wallP50) && inRange(four.wallP50, band.party4), `P50=${four.wallP50.toFixed(1)}s`);
    } else {
      surface(`${kind}@F${band.floor} 4-strong P50: measured ${four.wallP50.toFixed(1)}s (party band [${band.party4}] — validated only for Weaver) — balancer to set the real 4-strong row`);
    }

    const inBand = isPlayable && four.wallP10 >= band.minLegal
      && (!band.calibrated || (verdict.wallOk && verdict.exposedOk))
      && (!band.calibrated4 || (Number.isFinite(four.wallP50) && inRange(four.wallP50, band.party4)));
    out.set(kind, { floor: band.floor, solo, four, band, inBand });
  }
  return out;
}

// ---- 10. the deliberate-drift self-test: prove the gate catches real drift ----
// A buffed test loadout pushed past a boss's band must make its cell FAIL. King (no guard, pure
// DPS) is the clean lever: a heavier build drops its wall TTK below the 35s floor. We assert the
// SAME band-checker the gate uses (checkSoloBand) reports the drift — without failing the build.
function driftSelfTestGate(): void {
  section("deliberate-drift self-test: a buffed loadout over a boss ceiling makes its cell FAIL (the gate bites)");
  const king = BOSS_BANDS.boss;
  const clean = measureCell("boss", king.floor, [{ weapon: king.weapon, picks: king.build }], CELL_SEEDS);
  const cleanVerdict = checkSoloBand(king, clean);
  check("baseline: King's shipped median build sits IN its band (the gate is green on main)", cleanVerdict.wallOk,
    `wallP50=${clean.wallP50.toFixed(1)}s vs [${king.soloWall}]`);
  // The drift: a damage-stacked build (glass_cannon×2 over the shipped hair-trigger median).
  const buffed = measureCell("boss", king.floor, [{ weapon: "pistol", picks: [...L3("hair_trigger"), "glass_cannon", "glass_cannon"] }], CELL_SEEDS);
  const driftVerdict = checkSoloBand(king, buffed);
  check("drift: a deliberately-buffed loadout drops King below its band → the cell FAILS (drift is caught)",
    !driftVerdict.wallOk, `buffed wallP50=${buffed.wallP50.toFixed(1)}s vs [${king.soloWall}] → ${driftVerdict.reasons.join("; ") || "in band (self-test would not bite!)"}`);
}

// ---- the GIANT mechanics-step gate: F75 exposed-efficiency vs F50 (harder mechanics, not a sponge) ----
// The balancer's sponge-check. At the SAME build/DPS (both giant rows carry the identical
// hair_trigger×3 + glass_cannon×3 solo build), the region-cap giant (Pale F75) must make the bot
// spend a SMALLER fraction of the fight FREE-DPSing the exposed core — i.e. MORE time solving the
// peel/dodge patterns — than the first giant (Gorge F50). That lower exposed-efficiency is the
// signature of "harder mechanics." If F75's exposed-efficiency is NOT meaningfully below F50's, the
// F75 step is pure HP (a SPONGE), and we flag it LOUDLY. Measure-and-surface, NEVER a hard red-fail:
// the exact threshold needs the GD's F75 pattern variants landed first (they drop into the PALE
// block's variant slots), and TODAY F75 reuses the Gorge patterns — so this WARN is EXPECTED to
// fire until those variants land. The point is the NUMBER is in the gate output for the balancer.
const GIANT_EFF_MARGIN = 0.03; // F75 must sit >= this fraction (3pp) below F50 to read as "harder mechanics"
function giantMechanicsStepGate(gate: Map<string, BossGateResult>): void {
  section("giant mechanics step: F75 (pale) exposed-efficiency must sit BELOW F50 (gorge) — harder mechanics, not a sponge");
  const gorge = gate.get("gorge"), pale = gate.get("pale");
  // The instrumentation is wired (both giant cells measured) — the actual efficiency relationship is
  // SURFACED below, never gated, until the GD's F75 pattern variants land.
  check("giant mechanics step measured (F50 + F75 exposed-efficiency reported at the same build)",
    gorge !== undefined && pale !== undefined);
  if (!gorge || !pale) return;
  const gEff = gorge.solo.exposedEffP50, pEff = pale.solo.exposedEffP50;
  const deltaPP = (pEff - gEff) * 100;
  process.stdout.write(
    `  info: F50 gorge exposed-eff ${(gEff * 100).toFixed(1)}% (exposed ${gorge.solo.exposedP50.toFixed(1)}s / wall ${gorge.solo.wallP50.toFixed(1)}s) vs `
    + `F75 pale exposed-eff ${(pEff * 100).toFixed(1)}% (exposed ${pale.solo.exposedP50.toFixed(1)}s / wall ${pale.solo.wallP50.toFixed(1)}s) — same build\n`);
  process.stdout.write(`  info: exposed-efficiency delta (F75 − F50) = ${deltaPP.toFixed(1)}pp (want NEGATIVE: F75 spends more of the fight in mechanics)\n`);
  if (pEff <= gEff - GIANT_EFF_MARGIN) {
    surface(`giant mechanics step CONFIRMED: F75 exposed-eff ${(pEff * 100).toFixed(1)}% is >= ${(GIANT_EFF_MARGIN * 100).toFixed(0)}pp below F50 ${(gEff * 100).toFixed(1)}% `
      + `— the region-cap step is MECHANICS, not HP.`);
  } else {
    warn(`SPONGE failure mode: F75 exposed-eff ${(pEff * 100).toFixed(1)}% is NOT meaningfully below F50 ${(gEff * 100).toFixed(1)}% `
      + `(delta ${deltaPP.toFixed(1)}pp; need <= -${(GIANT_EFF_MARGIN * 100).toFixed(0)}pp). F75 currently REUSES the Gorge patterns, so the step is HP-only — `
      + `PENDING the GD's F75 pattern variants (tighter windows / denser telegraphs in disjoint lanes / a phase-3 wrinkle) that drop into the PALE block's variant slots.`);
  }
}

// ---- the full multi-boss ship-gate report (opt-in: npm run scaling:report) ----

interface ReportCell {
  build: string;
  r: number;
  effHp: number;
  killedFrac: number;
  wallP10: number;
  wallP50: number;
  wallP90: number;
  exposedP50: number;
  exposedEff: number; // exposed-window time / total fight time (the giant sponge-check metric)
  addsKilledP50: number;
  hitsTakenP50: number;
  maxLiveAdds: number;
}

interface BossReport {
  floor: number;
  cells: Record<string, ReportCell>;
  bands: { soloWall: readonly [number, number]; exposed: readonly [number, number] | null; minLegal: number; party4: readonly [number, number] };
  calibrated: boolean;
  inBand: boolean;
}

function cellReport(build: string, s: CellStats): ReportCell {
  const r1 = (n: number): number => (Number.isFinite(n) ? Math.round(n * 10) / 10 : -1);
  return {
    build,
    r: Math.round(s.r * 1000) / 1000,
    effHp: s.effHp,
    killedFrac: s.killedFrac,
    wallP10: r1(s.wallP10),
    wallP50: r1(s.wallP50),
    wallP90: r1(s.wallP90),
    exposedP50: r1(s.exposedP50),
    exposedEff: Math.round(s.exposedEffP50 * 1000) / 1000,
    addsKilledP50: s.addsKilledP50,
    hitsTakenP50: s.hitsTakenP50,
    maxLiveAdds: s.maxLiveAdds,
  };
}

function writeMultiBossReport(gate: Map<string, BossGateResult>): void {
  section("the multi-boss ship-gate report (deterministic sim harness)");
  const bosses: Record<string, BossReport> = {};
  let pulls = 0;
  for (const [kind, res] of gate) {
    const band = res.band;
    pulls += CELL_SEEDS.length * 2; // solo + 4-strong (already measured by the gate)
    const cells: Record<string, ReportCell> = {
      "solo/median": cellReport(buildLabel(band.weapon, band.build), res.solo),
      "4-strong": cellReport(buildLabel(BUILDS.god.weapon, BUILDS.god.picks), res.four),
    };
    // Drift-watch cells (report-only): solo/highRoll + solo/god — extra visibility, never gated.
    for (const [name, loadout] of [["solo/highRoll", BUILDS.highRoll], ["solo/god", BUILDS.god]] as const) {
      const s = measureCell(kind as EnemyKind, band.floor, [loadout], CELL_SEEDS);
      pulls += CELL_SEEDS.length;
      cells[name] = cellReport(buildLabel(loadout.weapon, loadout.picks), s);
    }
    bosses[kind] = {
      floor: band.floor,
      cells,
      bands: { soloWall: band.soloWall, exposed: band.exposed, minLegal: band.minLegal, party4: band.party4 },
      calibrated: band.calibrated,
      inBand: res.inBand,
    };
    process.stdout.write(`  ${kind}@F${band.floor}: solo wallP50=${cells["solo/median"].wallP50}s exposedP50=${cells["solo/median"].exposedP50}s exposedEff=${(cells["solo/median"].exposedEff * 100).toFixed(1)}% | 4-strong P50=${cells["4-strong"].wallP50}s — ${res.inBand ? "IN BAND" : "OUT"}${band.calibrated ? "" : " (placeholder)"}\n`);
  }
  writeFileSync(new URL("./fixtures/scaling_report.json", import.meta.url), JSON.stringify({
    note: "The R framework's MULTI-BOSS ship-gate report: deterministic sim-harness pulls (seeded worlds, scripted mechanic-playing parties) for all 10 shipped bosses, each at its floor across solo/median, 4-strong, and drift-watch (highRoll/god) cells. Calibrated bosses (King/Marrow/Weaver/Gilded/Choir) gate hard; Jet/Tithe/Quorum are Wave-1 placeholders and the giants Gorge (F50) / Pale Throne (F75) are placeholders too (measured + surfaced). exposedEff = the giant sponge-check metric (exposed-window time / total fight time). NOT live telemetry. Regenerate: npm run scaling:report",
    pulls,
    guards: {
      refDps: refDpsForFloor(20), hpFracCap: POWER.hpFracCap, addCapMax: POWER.addCapMax,
      soloGearCap: POWER.soloGearCap, weakFloorFrac: POWER.weakFloorFrac,
    },
    bosses,
  }, null, 2) + "\n");
  check(`multi-boss ship-gate report written (${pulls} pulls, ${Object.keys(bosses).length} bosses)`, Object.keys(bosses).length === 10);
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
  const gate = multiBossGate();
  giantMechanicsStepGate(gate);
  driftSelfTestGate();
  if (process.argv.includes("--report")) writeMultiBossReport(gate);
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nThe party+gear scaling framework holds.\n");
}

main();
