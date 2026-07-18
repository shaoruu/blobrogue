// PALE THRONE (F75 GIANT #2 — the Pale region cap; the SECOND giant, reusing the AD-LOCKED Gorge
// shell-peel TEMPLATE via the shared giant-encounter core). The determinism-critical contract,
// mirroring test/gorge.test.ts (the giant grammar F75 inherits) with the F75 material + calibration:
//  - F75 is ALWAYS the pale giant (a FIXED set-piece, not the seeded deep rotation), and the deep
//    rotation stays deterministic + no-immediate-repeat behind BOTH pins (F50 gorge, F75 pale).
//  - STATIONARY: it never chases (baseSpeed 0, ~immovable) — its threat is space-control.
//  - MULTI-PHASE SHELL-PEEL: GUARDED behind its shell (guardMult 0.0 — a TRUE hard gate); the ONLY
//    damage path is PEELING (destroy the cold tectonic weak-points → openBossWindow). The 3 shells
//    advance ONLY through peel windows (stone → cracked → core).
//  - GIANT HP calibration (balancer F75 EXPLICIT anchor, NOT the §3 floor curve): total 1220 (a
//    modest 1.3× Gorge, NOT a sponge), back-loaded per-shell [340,380,500], and a TIGHTER per-phase
//    window bank (0.20 vs Gorge 0.22) — the region-cap step is carried by MECHANICS, not HP.
//  - PEEL debris chunks drop at the base as reusable cover; telegraphs precede every pattern.
//  - BEATABLE: a bot that peels kills it; one that can't → it NEVER dies (the FAIL-LOUD gate).
//
// Run: npm run test:pale

import {
  createWorld, stepWorld, devSpawnEnemy, isBossExposed, loadFloorIntoWorld,
} from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, Enemy, EnemyKind, Prop } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import {
  PALE, GORGE, PLAYER, paleHpForFloor, paleSeamCountFor, paleShellFracFor, gorgeHpForFloor,
} from "../src/sim/balance.js";
import { CHILL_SLOW } from "../src/sim/constants.js";
import { bossKindForFloor, PALE_FLOOR, isBossKind, ENEMY_ARCHETYPES } from "../src/sim/enemies.js";
import { ENEMY_MOVESET } from "../src/sim/bestiary.js";
import { FIXED_DT, TICK_HZ, PROTOCOL_VERSION } from "../src/net/protocol.js";

const DT = 1 / 60;

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, isPassing: boolean, detail = ""): void {
  if (isPassing) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

function idle(seq: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
}
function step(w: WorldState, cmd: InputCmd = idle(0)): SimEvent[] {
  return stepWorld(w, new Map([[LOCAL_ID, cmd]]), DT);
}
function plantBullet(w: WorldState, x: number, y: number, damage: number, radius = 18): void {
  w.bullets.push({
    x, y, vx: 1, vy: 0, radius, life: 0.05, friendly: true, owner: LOCAL_ID,
    damage, color: "#fff", pierce: 0, hitList: null, isCrit: false,
  } as Bullet);
}

// A ready-to-fight arena: the giant spawned, grace cleared, so its loops run immediately.
function paleArena(seed: number): { w: WorldState; boss: Enemy } {
  const w = createWorld(seed, PALE_FLOOR, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 0;
  const boss = devSpawnEnemy(w, "pale", p.x + 220, p.y);
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  return { w, boss };
}

function liveSeams(w: WorldState): Enemy[] {
  return w.enemies.filter((e) => !e.dead && e.kind === "pale_seam");
}
function liveDebris(w: WorldState): Prop[] {
  return w.props.filter((p) => !p.dead && p.breakT === undefined && p.kind === "pale_debris");
}
// The cover predicate (mirrors the sim's blockedByProp): a body of radius r cannot occupy a
// point overlapping a standing prop — so a debris chunk BLOCKS movement where open floor would not.
function isPointBlockedByProp(w: WorldState, x: number, y: number, r: number): boolean {
  for (const p of w.props) {
    if (p.dead || p.breakT !== undefined || p.kind === "brazier") continue;
    if (Math.hypot(p.x - x, p.y - y) < p.radius + r) return true;
  }
  return false;
}

// ---- 1. F75 pin + the seeded rotation behind BOTH giant pins ----

function pinGates(): void {
  section("F75 is ALWAYS the pale giant (a fixed set-piece), the deep rotation intact behind both giant pins");
  check("PALE_FLOOR is 75", PALE_FLOOR === 75);
  check("pale is a boss kind (HP bar, chest, danger-end, HP scaling)", isBossKind("pale"));

  const deepRoster: EnemyKind[] = ["marrow", "choir", "weaver", "gilded", "boss", "jet", "tithe", "quorum"];
  const seen = new Set<EnemyKind>();
  let isAllPale = true, isF50Gorge = true, isF45Quorum = true, isDeterministic = true;
  let isWithoutRepeat = true, isGiantExcluded = true;
  for (let s = 0; s < 80; s++) {
    const seed = 0x5EED + s * 977;
    if (bossKindForFloor(seed, 75) !== "pale") isAllPale = false;
    if (bossKindForFloor(seed, 50) !== "gorge") isF50Gorge = false; // the F50 gorge pin is untouched
    if (bossKindForFloor(seed, 45) !== "quorum") isF45Quorum = false; // the authored chain up to F45 is untouched
    // Both giants (F50 gorge, F75 pale) are fixed set-pieces OUT of the seeded pool; the rotation
    // must stay deterministic and never repeat back-to-back (nor pick either giant).
    let prev: EnemyKind | null = "gorge";
    for (let floor = 55; floor <= 95; floor += 5) {
      const a = bossKindForFloor(seed, floor);
      if (a !== bossKindForFloor(seed, floor)) isDeterministic = false;
      if (a === null || a === prev) isWithoutRepeat = false;
      if (floor !== PALE_FLOOR && (a === "gorge" || a === "pale")) isGiantExcluded = false;
      if (a !== null) seen.add(a);
      prev = a;
    }
  }
  check("floor 75 returns pale for every seed (never a seeded rotation pick)", isAllPale);
  check("the F50 gorge pin is unchanged (still gorge for every seed)", isF50Gorge);
  check("the authored chain up to F45 is untouched (F45 is still Quorum)", isF45Quorum);
  check("the deep rotation is a pure function of (seed, floor)", isDeterministic);
  check("the deep rotation has no immediate repeats (nor against the giant pins)", isWithoutRepeat);
  check("the seeded rotation NEVER picks a giant (both are fixed set-pieces, out of the pool)", isGiantExcluded);
  check("every seeded-roster boss still appears across F55-95 (variety survives the F75 pin)",
    deepRoster.every((k) => seen.has(k)), [...seen].join(","));

  // The floor planner spawns the pale giant (centered) at F75 with its full pool.
  const w = createWorld(0xF75A, PALE_FLOOR, {});
  loadFloorIntoWorld(w, PALE_FLOOR);
  const giant = w.enemies.find((e) => e.kind === "pale");
  check("the F75 floor plan spawns the pale giant", giant !== undefined);
  if (giant) {
    const room = w.dungeon.rooms[w.dungeon.rooms.length - 1];
    const cx = (room.cx + 0.5) * TILE, cy = (room.cy + 0.5) * TILE;
    check("the stationary giant anchors at the arena CENTER (symmetric ring space)",
      Math.hypot(giant.x - cx, giant.y - cy) < 1, `d=${Math.hypot(giant.x - cx, giant.y - cy).toFixed(2)}`);
    check("the giant carries its full per-floor pool at F75", giant.maxHp === paleHpForFloor(),
      `hp=${giant.maxHp}`);
  }
}

// ---- 2. STATIONARY set-piece ----

function stationaryGates(): void {
  section("the giant is a STATIONARY set-piece — it never chases (its threat is space-control)");
  const { w, boss } = paleArena(0x70A1);
  const x0 = boss.x, y0 = boss.y;
  let maxDrift = 0;
  for (let t = 0; t < 60 * 6; t++) {
    // Pepper the (guarded) body + any seams — prove even sustained fire never budges it.
    plantBullet(w, boss.x, boss.y, 50);
    for (const s of liveSeams(w)) plantBullet(w, s.x, s.y, 5);
    step(w, idle(t));
    maxDrift = Math.max(maxDrift, Math.hypot(boss.x - x0, boss.y - y0));
  }
  check("the giant never moves from its anchor (baseSpeed 0, ~immovable, no chase step)",
    maxDrift < 1, `drift=${maxDrift.toFixed(3)}px`);
  check("its archetype speed is 0 (a set-piece)", ENEMY_ARCHETYPES.pale.baseSpeed === 0);
}

// ---- 3. GIANT HP calibration (balancer F75 EXPLICIT anchor — NOT the floor curve) ----

function calibrationGates(): void {
  section("GIANT calibration (balancer F75 EXPLICIT anchor): back-loaded per-shell HP, TIGHTER banking, never a floor-curve ride");
  const shellHp = PALE.shellHp;
  const total = shellHp.reduce((a, b) => a + b, 0);
  check("there are exactly 3 shells (stone / cracked / core)", shellHp.length === 3);
  check("the per-shell HP is the balancer's F75 anchor [340, 380, 500]",
    shellHp[0] === 340 && shellHp[1] === 380 && shellHp[2] === 500, `shellHp=[${shellHp.join(",")}]`);
  check("the total giant budget is 1220 at F75 (paleHpForFloor sums the explicit per-shell anchors)",
    paleHpForFloor() === 1220, `total=${paleHpForFloor()}`);
  // F75 is a FRESH EXPLICIT anchor, NOT the §3 floor curve: the curve CLAMPS flat past F10, so
  // riding it from Gorge's F50 would give F75 the SAME 930 (no increase). Pale is an explicit 1.3×.
  check("paleHpForFloor is floor-INDEPENDENT (the F75 fixed anchor, not the clamped floor curve)",
    paleHpForFloor() === total, `paleHpForFloor=${paleHpForFloor()} total=${total}`);
  // BACK-LOADED: the fight escalates INTO its hardest/longest phase (the cold core reveal).
  check("the pool is BACK-LOADED — core is the heaviest phase (stone < cracked < core)",
    shellHp[2] > shellHp[1] && shellHp[1] > shellHp[0], `${shellHp[0]} < ${shellHp[1]} < ${shellHp[2]}`);
  // The region-cap PRESTIGE step: a modest 1.3× Gorge's 930 (NOT sponge), under the ~1.35× ceiling.
  check("the total is ~1.3× Gorge (a prestige step, NOT a sponge), under the 1260 hard ceiling",
    total >= 1150 && total <= 1260 && total / gorgeHpForFloor(50) >= 1.25 && total / gorgeHpForFloor(50) <= 1.35,
    `total=${total} ratio=${(total / gorgeHpForFloor(50)).toFixed(3)}`);
  check("NO single shell is ~a full pool (each is a FRACTION — never 4x on one pool)",
    shellHp.every((h) => h < total * 0.5), `max=${Math.max(...shellHp)} total=${total}`);
  // phaseAt = the cumulative-from-full complement of shellHp (a shell sloughs when its chunk spent).
  const expectPhaseAt = [(total - shellHp[0]) / total, (total - shellHp[0] - shellHp[1]) / total];
  check("phaseAt matches the cumulative complement of shellHp (thresholds in lockstep with the split)",
    Math.abs(PALE.phaseAt[0] - expectPhaseAt[0]) < 5e-4 && Math.abs(PALE.phaseAt[1] - expectPhaseAt[1]) < 5e-4,
    `phaseAt=[${PALE.phaseAt.join(",")}] vs [${expectPhaseAt.map((x) => x.toFixed(4)).join(",")}]`);
  check("phase floors sit under each threshold (anti-burst overflow lands after the crack-off)",
    PALE.phaseFloor[0] < PALE.phaseAt[0] && PALE.phaseFloor[1] < PALE.phaseAt[1]);

  // PER-PHASE anti-burst, TIGHTENED for the region cap: a single window caps at 0.20 × the CURRENT
  // shell's HP (68 / 76 / 100), so each phase needs ~5 windows with NO slack even at a high roll.
  check("the per-phase bank is TIGHTER than Gorge (0.20 vs 0.22 — the region-cap step, no slack)",
    PALE.windowBankFrac === 0.20);
  const banks = [1, 2, 3].map((ph) => PALE.windowBankFrac * paleShellFracFor(ph) * total);
  check("per-phase window bank is 0.20 × each shell's HP (68 / 76 / 100 for stone/cracked/core)",
    Math.abs(banks[0] - 68) < 1 && Math.abs(banks[1] - 76) < 1 && Math.abs(banks[2] - 100) < 1,
    `banks=[${banks.map((b) => b.toFixed(0)).join(",")}]`);
  check("each phase needs ~5 earned windows to clear (never one-burst, incl. a 4-stack)",
    shellHp.every((h, i) => h / banks[i] >= 4), `windows/phase=[${shellHp.map((h, i) => (h / banks[i]).toFixed(1)).join(",")}]`);

  // Co-op scales the TASK (more seams), not the HP: seam count grows with players, per shell.
  check("weak-point count scales with the party (co-op = more seams = the TASK scales, not HP)",
    paleSeamCountFor(1, 1) < paleSeamCountFor(1, 4)
    && paleSeamCountFor(2, 1) < paleSeamCountFor(2, 4)
    && paleSeamCountFor(3, 1) < paleSeamCountFor(3, 4));
  check("the weak-point verb ESCALATES per shell (STONE few → CRACKED more → CORE most)",
    paleSeamCountFor(1, 1) < paleSeamCountFor(2, 1) && paleSeamCountFor(2, 1) < paleSeamCountFor(3, 1),
    `solo=[${paleSeamCountFor(1, 1)},${paleSeamCountFor(2, 1)},${paleSeamCountFor(3, 1)}]`);
  check("seam count is hard-capped for readability (disjoint lanes around the 192px body)",
    paleSeamCountFor(3, 4) <= PALE.seamCap);
}

// ---- 4. the guard gate: the shell IS the wall (only peeling opens the body) ----

function guardGates(): void {
  section("GUARDED behind the shell: the body takes ZERO damage while sealed — only PEELING opens it");
  const { w, boss } = paleArena(0x70B2);
  check("the giant starts sealed (guarded, not exposed)", !isBossExposed(boss));
  check("the guard multiplier is 0.0 (ZERO body damage while shelled)", PALE.guardMult === 0);
  const hp0 = boss.hp;
  for (let t = 0; t < 6; t++) { plantBullet(w, boss.x, boss.y, 100000); step(w, idle(t)); }
  check("a huge hit on the SEALED body removes nothing (the shell is a true hard gate)",
    boss.hp === hp0, `hp ${boss.hp}/${hp0}`);

  // Drive to the first seam exposure, destroy the whole set → the shell CRACKS → EXPOSED window.
  let isWindowOpened = false;
  for (let t = 0; t < 60 * 12 && !isWindowOpened; t++) {
    for (const s of liveSeams(w)) plantBullet(w, s.x, s.y, 9999);
    step(w, idle(t));
    if (isBossExposed(boss)) isWindowOpened = true;
  }
  check("destroying the whole weak-point set PEELS the shell → opens the EXPOSED window", isWindowOpened);
  const hpBefore = boss.hp;
  plantBullet(w, boss.x, boss.y, 100000);
  step(w);
  check("during the EXPOSED window the body takes damage (the peel is the only damage path)",
    boss.hp < hpBefore, `hp ${boss.hp}/${hpBefore}`);
  const removed = hpBefore - boss.hp;
  // The PER-PHASE anti-burst: a single window caps at 0.20 × the CURRENT shell's HP chunk (not the
  // whole pool), so even an arbitrarily large burst removes at most one shell-phase's bank.
  const phaseBank = PALE.windowBankFrac * paleShellFracFor(boss.boss!.phase) * boss.maxHp;
  check("a single burst can NEVER remove more than one PER-PHASE window bank (0.20 × the shell's HP)",
    removed <= phaseBank + 1e-6, `removed=${removed.toFixed(0)} phaseBank=${phaseBank.toFixed(0)} (phase ${boss.boss!.phase})`);
}

// ---- the peeler driver: destroy seams (open windows) + burst the bared body ----

interface PeelResult {
  isKilled: boolean;
  seconds: number;
  phasesSeen: number[];
  spritePhaseMax: number;
  peelWindows: number;
  debrisMax: number;
  crackBeats: number;
}
function peelPull(seed: number, isPeelingEnabled: boolean, maxTicks = 60 * 150): PeelResult {
  const { w, boss } = paleArena(seed);
  let isKilled = false;
  const phasesSeen = new Set<number>();
  let peelWindows = 0, wasExposed = false, debrisMax = 0, crackBeats = 0, ticks = 0;
  for (; ticks < maxTicks && !isKilled; ticks++) {
    if (isPeelingEnabled) {
      // The peel verb: destroy every exposed weak-point (this opens the window).
      for (const s of liveSeams(w)) plantBullet(w, s.x, s.y, 9999);
      // The bared body: burst it during the exposed window (bank-clamps per window).
      if (isBossExposed(boss)) plantBullet(w, boss.x, boss.y, 100000);
    } else {
      // The "can't open windows" bot: only ever hits the body, never the seams.
      plantBullet(w, boss.x, boss.y, 100000);
    }
    const evs = step(w, idle(ticks));
    for (const e of evs) {
      if (e.t === "enemyKill" && e.kind === "pale") isKilled = true;
      if (e.t === "chargeCrash") crackBeats++; // the peel crack cue
    }
    if (boss.boss) phasesSeen.add(boss.boss.phase);
    if (isBossExposed(boss) && !wasExposed) peelWindows++;
    wasExposed = isBossExposed(boss);
    debrisMax = Math.max(debrisMax, liveDebris(w).length);
  }
  return {
    isKilled, seconds: ticks * DT, phasesSeen: [...phasesSeen].sort((a, b) => a - b),
    spritePhaseMax: phasesSeen.size ? Math.max(...phasesSeen) : 0, peelWindows, debrisMax, crackBeats,
  };
}

// ---- 5. multi-phase shell-peel: phases advance ONLY via the peel + BEATABLE / FAIL-LOUD ----

function peelPhaseGates(): void {
  section("multi-phase SHELL-PEEL: the 3 shells advance ONLY through peel windows; the fight is beatable");
  const r = peelPull(0x70C3, true);
  check("a bot that PEELS (opens windows) KILLS the giant (the fight is beatable)", r.isKilled,
    `ttk=${r.seconds.toFixed(1)}s`);
  check("it advanced through all THREE shell phases (stone → cracked → core)",
    r.phasesSeen.includes(1) && r.phasesSeen.includes(2) && r.phasesSeen.includes(3),
    `phases=${r.phasesSeen.join(",")}`);
  check("the shell sprite advanced to phase 3 (the cold core reveal)", r.spritePhaseMax >= 3);
  check("the PER-PHASE bank forces ~5 windows/phase (>=10 total — no phase one-burst, incl. a 4-stack)",
    r.peelWindows >= 10, `windows=${r.peelWindows}`);
  check("the peel PUNCTUATES (crack beats fired on the weak-point clears)", r.crackBeats >= 3, `cracks=${r.crackBeats}`);

  // FAIL LOUD: a bot that CANNOT open windows (never peels) can NEVER kill the giant — the shell
  // is a true hard gate, so the body never takes damage. (Mirrors the multi-boss health gate.)
  const stuck = peelPull(0x70C4, false, 60 * 60);
  check("a bot that CANNOT peel NEVER kills the giant (FAIL-LOUD: the shell is a true gate)", !stuck.isKilled,
    `killed=${stuck.isKilled} phasesSeen=${stuck.phasesSeen.join(",")}`);
  check("…and it never even leaves phase 1 (no body damage without a peel)", stuck.spritePhaseMax === 1,
    `maxPhase=${stuck.spritePhaseMax}`);
}

// ---- 6. peeled-shell DEBRIS spawns on peel and acts as cover ----

function debrisGates(): void {
  section("peeled-shell DEBRIS: chunks drop at the base on each shell slough and act as cover");
  const r = peelPull(0x70D5, true);
  check("shell debris chunks dropped during the fight (material evidence of the peel)", r.debrisMax > 0,
    `maxDebris=${r.debrisMax}`);

  // The debris is real cover: a body cannot occupy it, unlike open floor.
  const { w, boss } = paleArena(0x70D6);
  let debris = liveDebris(w);
  for (let t = 0; t < 60 * 40 && debris.length === 0 && !boss.dead; t++) {
    for (const s of liveSeams(w)) plantBullet(w, s.x, s.y, 9999);
    if (isBossExposed(boss)) plantBullet(w, boss.x, boss.y, 100000);
    step(w, idle(t));
    debris = liveDebris(w);
  }
  check("debris spawned at the giant's base on the shell slough (the crack-off drop)", debris.length > 0);
  if (debris.length > 0) {
    const d = debris[0];
    check("the debris is a destructible chunk (real HP — breakable cover)", d.hp > 0 && d.breakT === undefined);
    check("the debris BLOCKS movement (line-of-sight / movement cover) where open floor would not",
      isPointBlockedByProp(w, d.x, d.y, 12) && !isPointBlockedByProp(w, d.x + 500, d.y + 500, 12));
    check("the debris sits at the base, clear of the giant's hittable body",
      Math.hypot(d.x - boss.x, d.y - boss.y) > ENEMY_ARCHETYPES.pale.radius);
  }
}

// ---- 7. tectonic telegraphs precede every pattern; the authored safe pocket always exists ----

function telegraphGates(): void {
  section("tectonic telegraphs: every ring/zone/spoke has a >=0.6s tell, and always an authored safe pocket");
  check("every pattern's windup is >=0.6s (the readable rear/windup tell)",
    PALE.ringWindup >= 0.6 && PALE.zoneWindup >= 0.6 && PALE.spokeWindup >= 0.6,
    `ring=${PALE.ringWindup} zone=${PALE.zoneWindup} spoke=${PALE.spokeWindup}`);
  check("the P1 ring leaves an authored GAP (a stand-in-the-gap safe wedge)", PALE.ringGap > 0 && PALE.ringGap < PALE.ringCount);
  check("the P3 spokes leave ONE moving safe wedge", PALE.spokeGap > 0 && PALE.spokeGap < PALE.spokeCount);
  check("the P3 safe lane is rideable under worst warmth slow (<100px/s)",
    (PALE.spokeStep / PALE.spokeInterval) * PALE.zoneRing < 100,
    `laneSpeed=${((PALE.spokeStep / PALE.spokeInterval) * PALE.zoneRing).toFixed(0)}px/s`);
  check("the P2 slag zones are hard-capped (a shrinking pocket, never a sealed floor)", PALE.zoneCap > 0);

  // Observe the P1 ring in-sim: a windup precedes the shockwave bullets, and the fired ring
  // carries a gap (fewer bullets than a full ring, leaving the safe wedge).
  const { w, boss } = paleArena(0x70E7);
  // Capture the PRIMARY ring's shards on the first 0→>0 enemy-bullet transition (Pale fires a
  // SECOND ring ~0.45s later — see axisRingGates — so counting at recover would double it).
  let isWindupSeen = false, ringShards = 0, bulletsBeforeActive = 0, prevEnemy = 0;
  for (let t = 0; t < 60 * 8 && ringShards === 0; t++) {
    const a = boss.attack;
    if (a.move === "slam" && a.phase === "windup") { isWindupSeen = true; bulletsBeforeActive = w.bullets.filter((b) => !b.friendly).length; }
    step(w, idle(t));
    const enemyNow = w.bullets.filter((b) => !b.friendly).length;
    if (a.move === "slam" && ringShards === 0 && prevEnemy === 0 && enemyNow > 0) ringShards = enemyNow;
    prevEnemy = enemyNow;
  }
  check("the P1 ring telegraphs a windup BEFORE any shockwave fires", isWindupSeen && bulletsBeforeActive === 0);
  check("the fired ring omits a gap wedge (fewer shards than a full ring — the safe pocket)",
    ringShards > 0 && ringShards <= PALE.ringCount - PALE.ringGap, `shards=${ringShards} full=${PALE.ringCount}`);
}

// ---- 8. determinism: the whole encounter replays byte-identically ----

function determinismGates(): void {
  section("determinism: the same seed replays the giant tick-for-tick (peels, patterns, debris, phases)");
  const run = (): string => {
    const { w, boss } = paleArena(0x70F8);
    const log: string[] = [];
    for (let t = 0; t < 60 * 40 && !boss.dead; t++) {
      for (const s of liveSeams(w)) plantBullet(w, s.x, s.y, 9999);
      if (isBossExposed(boss)) plantBullet(w, boss.x, boss.y, 100000);
      const evs = step(w, idle(t));
      for (const e of evs) {
        if (e.t === "enemySpawn" && e.kind === "pale_seam") log.push(`${t}:seam@${e.x.toFixed(2)},${e.y.toFixed(2)}`);
        if (e.t === "bossPhase") log.push(`${t}:phase`);
      }
      if (t % 30 === 0) {
        log.push(`${t}:${boss.hp.toFixed(3)}:${boss.boss!.phase}:${isBossExposed(boss) ? 1 : 0}:${liveSeams(w).length}:${liveDebris(w).length}:${boss.x.toFixed(3)},${boss.y.toFixed(3)}`);
      }
    }
    return log.join("|");
  };
  const a = run(), b = run();
  check("two identical pale pulls match tick-for-tick (seeded RNG only — no Date.now/Math.random)",
    a === b, `trace=${a.length} chars`);
}

function moveCmd(seq: number, mx: number, my: number): InputCmd {
  return { seq, moveX: mx, moveY: my, aim: 0, firing: false, dash: false };
}

// The widest angular gap (safe wedge) in a set of spoke/ring angles: sort, scan cyclic gaps.
function widestGap(anglesRad: number[]): { centerDeg: number; widthDeg: number } {
  const TAU = Math.PI * 2;
  const norm = anglesRad.map((a) => ((a % TAU) + TAU) % TAU).sort((x, y) => x - y);
  let maxGap = -1, center = 0;
  for (let i = 0; i < norm.length; i++) {
    const a = norm[i], b = i + 1 < norm.length ? norm[i + 1] : norm[0] + TAU;
    if (b - a > maxGap) { maxGap = b - a; center = (a + b) / 2; }
  }
  return { centerDeg: ((center * 180) / Math.PI) % 360, widthDeg: (maxGap * 180) / Math.PI };
}
function angleDiffDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ---- 9. P1 SEQUENCING axis: a SECOND counter-offset ring (the "new read", not a tighter gap) ----

function axisRingGates(): void {
  section("P1 axis — a SECOND counter-offset ring: sequence (dash gap A → gap B), each gap Gorge-width, never closes");
  check("the second-ring axis is configured for a walkable adjacent transition (1 slot, 1.1s behind)",
    PALE.ring2GapOffsetSlots === 1 && PALE.ring2DelaySec === 1.1);
  check("each ring KEEPS Gorge's gap width/count/speed (the 2nd ring is the difficulty, NOT a narrower gap)",
    PALE.ringGap === GORGE.ringGap && PALE.ringCount === GORGE.ringCount && PALE.ringSpeed === GORGE.ringSpeed);
  check("the windup/recover TIGHTEN but hold the guardrails (windup 0.7 > 0.6, recover 0.5 > 0.35)",
    PALE.ringWindup === 0.7 && PALE.ringRecover === 0.5);

  // Observe a single P1 slam in-sim: the primary ring, then the counter-offset second ring ~0.45s
  // behind. Each must leave a full-width gap (a standable wedge — never fully closes), the gaps offset.
  const { w, boss } = paleArena(0x7A11);
  // Fire angle rides the bullet VELOCITY (a fresh shard sits at the giant center, so a position
  // angle is degenerate) — the robust read of each ring's gap.
  let ring0: number[] = [];
  const wave0 = new Set<Bullet>();
  for (let t = 0; t < 60 * 10 && ring0.length === 0; t++) {
    const before = w.bullets.filter((b) => !b.friendly).length;
    step(w, idle(t));
    const enemy = w.bullets.filter((b) => !b.friendly);
    if (boss.attack.move === "slam" && before === 0 && enemy.length > 0) {
      for (const b of enemy) wave0.add(b);
      ring0 = enemy.map((b) => Math.atan2(b.vy, b.vx));
    }
  }
  let ring1: number[] = [];
  const ticks = Math.ceil((PALE.ring2DelaySec! + 0.15) / DT);
  for (let t = 0; t < ticks && ring1.length === 0; t++) {
    step(w, idle(2000 + t));
    const fresh = w.bullets.filter((b) => !b.friendly && !wave0.has(b));
    if (fresh.length > 0) ring1 = fresh.map((b) => Math.atan2(b.vy, b.vx));
  }
  const full = PALE.ringCount - PALE.ringGap;
  check("the PRIMARY ring fires with a full-width gap (a standable wedge)", ring0.length === full,
    `shards=${ring0.length} full=${full}`);
  check("the SECOND ring fires (the sequencing axis is live), also with a full-width gap",
    ring1.length === full, `shards=${ring1.length} full=${full}`);
  if (ring0.length > 0 && ring1.length > 0) {
    const g0 = widestGap(ring0), g1 = widestGap(ring1);
    const offset = angleDiffDeg(g0.centerDeg, g1.centerDeg);
    check("the two gaps are distinctly offset while retaining a walkable overlap margin",
      offset >= 20 && offset <= 25, `offset=${offset.toFixed(0)}° (want ~22.5°)`);
    check("each ring leaves a genuinely standable wedge (never fully closes)",
      g0.widthDeg > 40 && g1.widthDeg > 40, `gaps=${g0.widthDeg.toFixed(0)}°/${g1.widthDeg.toFixed(0)}°`);
  }
}

// ---- 10. P2 POSITIONING-OVER-TIME axis: the denial MIGRATES + stays capped (safe pocket holds) ----

function axisPoolGates(): void {
  section("P2 axis — MIGRATING pools: creep + churn so the safe floor drifts, capped ≤ ⅓ arena (never seals)");
  check("the pool-migration axis is configured (creep 0.67 tiles/s + churn)",
    PALE.zoneSpreadTilesPerSec === 0.67 && PALE.isZoneChurnEnabled === true);
  check("zoneCap stays 10 + zoneCount 3 (the DRIFT is the difficulty, not more pools); windup/recover tighten",
    PALE.zoneCap === 10 && PALE.zoneCount === 3 && PALE.zoneWindup === 0.7 && PALE.zoneRecover === 0.5);

  // Drive the peeling bot; while the giant is in phase 2 (the zoning shell), sample the pool field.
  const { w, boss } = paleArena(0x7A22);
  // The arena = the room the giant occupies; the ⅓-denial cap is measured against it.
  const room = w.dungeon.rooms.find((r) => boss.x >= r.x * TILE && boss.x < (r.x + r.w) * TILE && boss.y >= r.y * TILE && boss.y < (r.y + r.h) * TILE)
    ?? w.dungeon.rooms.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
  const arenaArea = room.w * TILE * room.h * TILE;
  let maxCinders = 0, maxDist = 0, maxDeniedArea = 0, sawPhase2 = false, everMoved = false;
  const prevPos = new Map<number, { x: number; y: number }>();
  for (let t = 0; t < 60 * 120 && !boss.dead; t++) {
    for (const s of liveSeams(w)) plantBullet(w, s.x, s.y, 9999);
    if (isBossExposed(boss)) plantBullet(w, boss.x, boss.y, 100000);
    step(w, idle(t));
    if (boss.boss?.phase === 2) {
      sawPhase2 = true;
      const cinders = w.hazards.filter((h) => h.kind === "cinder" && h.life > 0);
      maxCinders = Math.max(maxCinders, cinders.length);
      maxDeniedArea = Math.max(maxDeniedArea, cinders.length * Math.PI * PALE.zoneRadius * PALE.zoneRadius);
      for (const c of cinders) {
        maxDist = Math.max(maxDist, Math.hypot(c.x - boss.x, c.y - boss.y));
        const prev = prevPos.get(c.id);
        if (prev && (Math.abs(prev.x - c.x) > 1e-6 || Math.abs(prev.y - c.y) > 1e-6)) everMoved = true; // a pool CREPT this tick
        prevPos.set(c.id, { x: c.x, y: c.y });
      }
    }
  }
  check("reached the P2 zoning shell", sawPhase2);
  check("the denial is CAPPED at zoneCap (live pools never exceed 10 — the safe pocket always holds)",
    maxCinders <= PALE.zoneCap, `maxPools=${maxCinders} cap=${PALE.zoneCap}`);
  check("total denied area ≤ ⅓ arena (the HARD fairness cap — never seals the pocket)",
    maxDeniedArea <= arenaArea / 3, `denied=${(maxDeniedArea / 1000).toFixed(0)}k ≤ ⅓ arena ${(arenaArea / 3000).toFixed(0)}k px²`);
  check("pools CREEP (each drifts outward tick-to-tick — the motion-under-denial spread)", everMoved);
  check("the denial MIGRATES outward (the field creeps/churns past the initial ring — a corner can't be camped)",
    maxDist > PALE.zoneRing + TILE, `maxDist=${maxDist.toFixed(0)} vs ring=${PALE.zoneRing}`);
}

// ---- 11. P3 DUAL-READ axis: a SPARSE counter-rotating second sweep — the wedge NEVER fully closes ----

function axisSweepGates(): void {
  section("P3 axis — a COUNTER-ROTATING second sweep: the safe intersection drifts but NEVER fully closes (fairness)");
  check("the second-sweep axis is configured (counter-rotate = -spokeStep, opposite sign / same magnitude)",
    PALE.spoke2Step === -PALE.spokeStep);
  check("projectile speed stays fixed while angular motion is slowed for worst-warmth navigation",
    PALE.spokeSpeed === GORGE.spokeSpeed && PALE.spokeStep === 0.03 && PALE.spokeInterval === 0.2
    && PALE.spokeWindup === 0.7 && PALE.spokeRecover === 0.4);
  check("the counter-sweep reuses the FULL SWEEP_ARC (gap = spokeGap; no widening needed — see below)",
    (PALE.spoke2Gap ?? PALE.spokeGap) === PALE.spokeGap);

  // Replicate the sim's per-emission spoke angles (both FULL wheels) over the whole sweep, for BOTH
  // burst-parity phases, and take the narrowest standable wedge — the CRITICAL fairness assert: the
  // two counter-rotating wedges' intersection must NEVER fully close. It holds at spokeGap 2 because
  // the spokes are discrete lines (40° apart), so inter-spoke lanes always leave a standable spot.
  const TAU = Math.PI * 2;
  const emissions = Math.ceil(PALE.spokeDuration / PALE.spokeInterval);
  const gap2 = PALE.spoke2Gap ?? PALE.spokeGap;
  let minWedge = 360;
  for (const parity of [0, 1]) {
    for (let em = 0; em <= emissions; em++) {
      const angles: number[] = [];
      const wheel = em * PALE.spokeStep + parity;
      for (let i = PALE.spokeGap; i < PALE.spokeCount; i++) angles.push(wheel + (i / PALE.spokeCount) * TAU);
      const wheel2 = em * PALE.spoke2Step! + parity; // spoke2Step negative = counter-rotating
      for (let i = gap2; i < PALE.spokeCount; i++) angles.push(wheel2 + (i / PALE.spokeCount) * TAU);
      minWedge = Math.min(minWedge, widestGap(angles).widthDeg);
    }
  }
  check("a standable safe wedge PERSISTS at every emission (the dual-sweep intersection NEVER fully closes)",
    minWedge >= 18, `minWedge=${minWedge.toFixed(1)}° over the whole sweep (both parities), spokeGap=${PALE.spokeGap}`);
}

// ---- 12. THE PALE SIGNATURE — WARMTH-DRAIN: camping chills the walk (a slow, never damage, clears on move) ----

function warmthDrainGates(): void {
  section("PALE signature — WARMTH-DRAIN (P3-ONLY): idle → ×0.5 walk (never damage, never stacks, clears on move, deterministic)");
  const clearDist = PALE.warmthDrainMoveClearTiles! * TILE;
  check("warmth-drain is configured (idle 1.5s, slow = CHILL_SLOW 0.5, clear 1.0 tile)",
    PALE.warmthDrainIdleSec === 1.5 && PALE.warmthDrainSlow === CHILL_SLOW && PALE.warmthDrainMoveClearTiles === 1.0);

  // Force the giant to its CORE-REVEAL phase (warmth is P3-ONLY), park the player in open floor,
  // then STAND STILL past the idle threshold. God mode isolates the slow (patterns deal no damage).
  const chillRun = (): { chilledPerTick: number; freePerTick: number; hp0: number; hp1: number; clearedT: number } => {
    const { w, boss } = paleArena(0x7A33);
    boss.boss!.phase = 3; // the prestige P3 reveal — where warmth-drain lives
    const p = w.players.get(LOCAL_ID)!;
    const hp0 = p.hp;
    for (let t = 0; t < Math.ceil((PALE.warmthDrainIdleSec! + 0.5) / DT); t++) step(w, idle(t));
    const hp1 = p.hp;
    // Move AWAY from the giant (−x). Measure the first few (still-chilled) ticks' displacement.
    let x0 = p.x;
    for (let t = 0; t < 3; t++) step(w, moveCmd(1000 + t, -1, 0));
    const chilledPerTick = Math.abs(p.x - x0) / 3;
    // Keep moving until the idle timer clears (displaced ≥ clearDist), then measure free-speed ticks.
    let clearedT = -1;
    for (let t = 0; t < 200; t++) {
      step(w, moveCmd(2000 + t, -1, 0));
      if (p.warmthIdleSec === 0) { clearedT = t; break; }
    }
    x0 = p.x;
    for (let t = 0; t < 3; t++) step(w, moveCmd(3000 + t, -1, 0));
    const freePerTick = Math.abs(p.x - x0) / 3;
    return { chilledPerTick, freePerTick, hp0, hp1, clearedT };
  };
  const r = chillRun();
  check("standing still past the idle threshold CHILLS the walk to ×warmthDrainSlow (a ×0.5 slow)",
    r.chilledPerTick > 0 && Math.abs(r.chilledPerTick / r.freePerTick - PALE.warmthDrainSlow!) < 0.08,
    `chilled=${r.chilledPerTick.toFixed(3)} free=${r.freePerTick.toFixed(3)} ratio=${(r.chilledPerTick / r.freePerTick).toFixed(2)} want=${PALE.warmthDrainSlow}`);
  check("warmth-drain is NEVER damage (idling under god mode costs no HP — it is a slow only)", r.hp0 === r.hp1,
    `hp ${r.hp1}/${r.hp0}`);
  check("it NEVER stacks past one ×0.5 (a single chill, not a compounding stun — ratio ~0.5, not ~0.25)",
    r.chilledPerTick / r.freePerTick > PALE.warmthDrainSlow! - 0.08, `ratio=${(r.chilledPerTick / r.freePerTick).toFixed(2)}`);
  check("it CLEARS the instant the player moves ~1 tile (a genuine dodge always thaws)",
    r.clearedT >= 0, `clearedAfter=${r.clearedT} ticks (clearDist=${clearDist}px)`);

  // Deterministic: two identical warmth-drain runs match.
  const a = chillRun(), b = chillRun();
  check("warmth-drain is deterministic (seeded, tick-based idle timer — same run twice matches)",
    a.chilledPerTick === b.chilledPerTick && a.freePerTick === b.freePerTick && a.clearedT === b.clearedT);

  // P3-ONLY: in the P1/P2 shells there is NO warmth-drain (w.warmthDrain null even while idle).
  {
    const { w, boss } = paleArena(0x7A55);
    boss.boss!.phase = 1;
    for (let t = 0; t < Math.ceil((PALE.warmthDrainIdleSec! + 0.5) / DT); t++) step(w, idle(t));
    check("warmth-drain is INACTIVE in P1/P2 (P3-ONLY — the prestige finale beat)",
      w.warmthDrain === null && w.players.get(LOCAL_ID)!.warmthIdleSec === 0);
  }

  // Off a giant floor, warmth-drain is INERT (no pale giant → no chill → byte-identical movement).
  const w2 = createWorld(0x7A44, 12, { isSandbox: true });
  w2.isGodMode = true;
  for (let t = 0; t < Math.ceil((PALE.warmthDrainIdleSec! + 0.5) / DT); t++) stepWorld(w2, new Map([[LOCAL_ID, idle(t)]]), DT);
  check("warmth-drain is INERT off a giant floor (no warmth-drain giant → w.warmthDrain null)",
    w2.warmthDrain === null && w2.players.get(LOCAL_ID)!.warmthIdleSec === 0);
}


function lastLightGates(): void {
  section("THE LAST LIGHT FALLS — owner-locked signature (1.8 / 3×0.65 / 1.0 / 4.0, ±1 tick @20Hz)");
  check("timings locked",
    PALE.lastLightTell === 1.8 && PALE.lastLightScarCommit === 0.65
    && PALE.lastLightScarCount === 3 && PALE.lastLightFall === 1.0 && PALE.lastLightPunish === 4.0);
  check("AttackMove last_light is on Pale moveset",
    ENEMY_MOVESET.pale.includes("last_light"));
  check("PROTOCOL is 46 after the pet abilities roster (Pale last_light still fits)", PROTOCOL_VERSION === 46);
  const near = (seconds: number) => {
    const exact = Math.round(seconds * TICK_HZ);
    return { lo: exact - 1, hi: exact + 1, exact };
  };

  // Force-commit helper: begin the signature and step at authoritative 20Hz.
  function beginLastLight(seed: number) {
    const { w, boss } = paleArena(seed);
    boss.boss!.lastAddPick = 0;
    boss.attack.cooldown = 0;
    boss.spawnTimer = 0;
    // Drive one tick so updateGiant may begin; if not, force beginWindup path via cooldown gate.
    stepWorld(w, new Map([[LOCAL_ID, idle(0)]]), FIXED_DT);
    if (boss.attack.move !== "last_light") {
      // Force: clear cadence and call through a step after manually arming windup.
      boss.boss!.lastAddPick = 0;
      boss.attack.phase = "none";
      boss.attack.move = "none";
      boss.attack.cooldown = 0;
      // Manually mirror paleLastLightMaybeBegin for the test harness.
      boss.attack.phase = "windup";
      boss.attack.move = "last_light";
      boss.attack.time = 0;
      boss.attack.windup = 0;
      boss.attack.isAimLocked = false;
      boss.boss!.spinCount = 0;
      boss.boss!.huskReformTimer = 0;
      boss.boss!.mirrorLastFamily = 0;
      boss.boss!.mirrorFamily = 0;
    }
    return { w, boss };
  }

  // Timing: tell duration
  {
    const { w, boss } = beginLastLight(0x11A11);
    let tellTicks = 0;
    for (let i = 0; i < 200; i++) {
      if (boss.attack.move === "last_light" && boss.attack.phase === "windup") tellTicks++;
      else if (boss.attack.move === "last_light" && boss.attack.phase === "active") break;
      stepWorld(w, new Map([[LOCAL_ID, idle(i)]]), FIXED_DT);
    }
    const n = near(PALE.lastLightTell);
    check(`tell lasts ~1.8s (±1 tick) got=${tellTicks}`, tellTicks >= n.lo && tellTicks <= n.hi + 1,
      `ticks=${tellTicks} want ${n.lo}..${n.hi}`);
  }

  // Success path: relight all three scars in sequence → 4.0s window
  {
    const { w, boss } = beginLastLight(0x11A22);
    // Advance through tell
    for (let i = 0; i < Math.ceil(PALE.lastLightTell / FIXED_DT) + 2; i++) {
      stepWorld(w, new Map([[LOCAL_ID, idle(i)]]), FIXED_DT);
    }
    check("scar phase arms after tell", boss.attack.phase === "active" && boss.attack.move === "last_light");
    let scarsSeen = 0;
    for (let i = 0; i < 400; i++) {
      const scar = w.enemies.find((e) => !e.dead && e.kind === "pale_seam" && e.aux >= 10);
      if (scar) {
        scarsSeen++;
        scar.hp = 0;
        scar.dead = true;
      }
      stepWorld(w, new Map([[LOCAL_ID, idle(i)]]), FIXED_DT);
      if (boss.boss!.mirrorLastFamily === 1 || (boss.boss!.exposed ?? 0) > 0) break;
    }
    check("three scars were presented in sequence", scarsSeen >= 3, `scarsSeen=${scarsSeen}`);
    check("success opens punish window", (boss.boss!.exposed ?? 0) > 0,
      `exposed=${boss.boss!.exposed} outcome=${boss.boss!.mirrorLastFamily}`);
    check("punish ~4.0s", (boss.boss!.exposed ?? 0) >= PALE.lastLightPunish - FIXED_DT * 2,
      `exposed=${boss.boss!.exposed}`);
    check("outcome success", boss.boss!.mirrorLastFamily === 1);
  }

  // Survival: abandon chain (let scar expire) → no window
  {
    const { w, boss } = beginLastLight(0x11A33);
    for (let i = 0; i < Math.ceil(PALE.lastLightTell / FIXED_DT) + 2; i++) {
      stepWorld(w, new Map([[LOCAL_ID, idle(i)]]), FIXED_DT);
    }
    // Wait out scar commit + fall without breaking scars; stand on warm route (north), not dead-space.
    const p = w.players.get(LOCAL_ID)!;
    p.x = boss.x;
    p.y = boss.y - 140;
    p.invuln = 10;
    for (let i = 0; i < 200; i++) {
      stepWorld(w, new Map([[LOCAL_ID, idle(i)]]), FIXED_DT);
      if (boss.boss!.mirrorLastFamily === 2 || boss.boss!.mirrorLastFamily === 3 || boss.boss!.mirrorLastFamily === 1) break;
    }
    check("survival/failure does NOT open window",
      boss.boss!.mirrorLastFamily !== 1 && (boss.boss!.exposed ?? 0) === 0,
      `outcome=${boss.boss!.mirrorLastFamily} exposed=${boss.boss!.exposed}`);
    check("outcome is survival when on warm route",
      boss.boss!.mirrorLastFamily === 2 || boss.boss!.mirrorLastFamily === 3,
      `outcome=${boss.boss!.mirrorLastFamily}`);
  }

  // Failure: stand in dead-space south → soft fail, still no wipe / no success window
  {
    const { w, boss } = beginLastLight(0x11A44);
    for (let i = 0; i < Math.ceil(PALE.lastLightTell / FIXED_DT) + 2; i++) {
      stepWorld(w, new Map([[LOCAL_ID, idle(i)]]), FIXED_DT);
    }
    const p = w.players.get(LOCAL_ID)!;
    w.isGodMode = false;
    p.invuln = 0;
    p.hp = p.maxHp = 6;
    p.x = boss.x;
    p.y = boss.y + 96; // dead-space
    for (let i = 0; i < 200; i++) {
      stepWorld(w, new Map([[LOCAL_ID, idle(i)]]), FIXED_DT);
      if (boss.boss!.mirrorLastFamily === 2 || boss.boss!.mirrorLastFamily === 3 || boss.boss!.mirrorLastFamily === 1) break;
    }
    check("failure never grants success window",
      boss.boss!.mirrorLastFamily !== 1 && (boss.boss!.exposed ?? 0) === 0);
    check("player not wiped (anti-one-shot)", p.hp > 0, `hp=${p.hp}`);
  }

  // Scar serialize index advances 0→1→2
  {
    const { w, boss } = beginLastLight(0x11A55);
    for (let i = 0; i < Math.ceil(PALE.lastLightTell / FIXED_DT) + 2; i++) {
      stepWorld(w, new Map([[LOCAL_ID, idle(i)]]), FIXED_DT);
    }
    const idxs: number[] = [];
    for (let i = 0; i < 300; i++) {
      const scar = w.enemies.find((e) => !e.dead && e.kind === "pale_seam" && e.aux >= 10);
      if (scar) {
        idxs.push(scar.aux - 10);
        scar.hp = 0; scar.dead = true;
      }
      stepWorld(w, new Map([[LOCAL_ID, idle(i)]]), FIXED_DT);
      if (boss.boss!.mirrorLastFamily === 1) break;
    }
    check("scar indices are sequential 0,1,2", idxs[0] === 0 && idxs[1] === 1 && idxs[2] === 2,
      `idxs=${idxs.join(",")}`);
  }
}

function main(): void {
  pinGates();
  stationaryGates();
  calibrationGates();
  guardGates();
  peelPhaseGates();
  debrisGates();
  telegraphGates();
  axisRingGates();
  axisPoolGates();
  axisSweepGates();
  warmthDrainGates();
  lastLightGates();
  determinismGates();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nThe F75 Pale Throne giant encounter holds.\n");
}

main();
