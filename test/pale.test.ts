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
  PALE, paleHpForFloor, paleSeamCountFor, paleShellFracFor, gorgeHpForFloor,
} from "../src/sim/balance.js";
import { bossKindForFloor, PALE_FLOOR, isBossKind, ENEMY_ARCHETYPES } from "../src/sim/enemies.js";

const DT = 1 / 60;

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
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
function propBlocksPoint(w: WorldState, x: number, y: number, r: number): boolean {
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
  let allPale = true, f50Gorge = true, f45Quorum = true, deterministic = true, noRepeat = true, neverGiant = true;
  for (let s = 0; s < 80; s++) {
    const seed = 0x5EED + s * 977;
    if (bossKindForFloor(seed, 75) !== "pale") allPale = false;
    if (bossKindForFloor(seed, 50) !== "gorge") f50Gorge = false; // the F50 gorge pin is untouched
    if (bossKindForFloor(seed, 45) !== "quorum") f45Quorum = false; // the authored chain up to F45 is untouched
    // Both giants (F50 gorge, F75 pale) are fixed set-pieces OUT of the seeded pool; the rotation
    // must stay deterministic and never repeat back-to-back (nor pick either giant).
    let prev: EnemyKind | null = "gorge";
    for (let floor = 55; floor <= 95; floor += 5) {
      const a = bossKindForFloor(seed, floor);
      if (a !== bossKindForFloor(seed, floor)) deterministic = false;
      if (a === null || a === prev) noRepeat = false;
      if (floor !== PALE_FLOOR && (a === "gorge" || a === "pale")) neverGiant = false;
      if (a !== null) seen.add(a);
      prev = a;
    }
  }
  check("floor 75 returns pale for every seed (never a seeded rotation pick)", allPale);
  check("the F50 gorge pin is unchanged (still gorge for every seed)", f50Gorge);
  check("the authored chain up to F45 is untouched (F45 is still Quorum)", f45Quorum);
  check("the deep rotation is a pure function of (seed, floor)", deterministic);
  check("the deep rotation has no immediate repeats (nor against the giant pins)", noRepeat);
  check("the seeded rotation NEVER picks a giant (both are fixed set-pieces, out of the pool)", neverGiant);
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
  let opened = false;
  for (let t = 0; t < 60 * 12 && !opened; t++) {
    for (const s of liveSeams(w)) plantBullet(w, s.x, s.y, 9999);
    step(w, idle(t));
    if (isBossExposed(boss)) opened = true;
  }
  check("destroying the whole weak-point set PEELS the shell → opens the EXPOSED window", opened);
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
  killed: boolean;
  seconds: number;
  phasesSeen: number[];
  spritePhaseMax: number;
  peelWindows: number;
  debrisMax: number;
  crackBeats: number;
}
function peelPull(seed: number, canPeel: boolean, maxTicks = 60 * 150): PeelResult {
  const { w, boss } = paleArena(seed);
  let killed = false;
  const phasesSeen = new Set<number>();
  let peelWindows = 0, wasExposed = false, debrisMax = 0, crackBeats = 0, ticks = 0;
  for (; ticks < maxTicks && !killed; ticks++) {
    if (canPeel) {
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
      if (e.t === "enemyKill" && e.kind === "pale") killed = true;
      if (e.t === "chargeCrash") crackBeats++; // the peel crack cue
    }
    if (boss.boss) phasesSeen.add(boss.boss.phase);
    if (isBossExposed(boss) && !wasExposed) peelWindows++;
    wasExposed = isBossExposed(boss);
    debrisMax = Math.max(debrisMax, liveDebris(w).length);
  }
  return {
    killed, seconds: ticks * DT, phasesSeen: [...phasesSeen].sort((a, b) => a - b),
    spritePhaseMax: phasesSeen.size ? Math.max(...phasesSeen) : 0, peelWindows, debrisMax, crackBeats,
  };
}

// ---- 5. multi-phase shell-peel: phases advance ONLY via the peel + BEATABLE / FAIL-LOUD ----

function peelPhaseGates(): void {
  section("multi-phase SHELL-PEEL: the 3 shells advance ONLY through peel windows; the fight is beatable");
  const r = peelPull(0x70C3, true);
  check("a bot that PEELS (opens windows) KILLS the giant (the fight is beatable)", r.killed,
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
  check("a bot that CANNOT peel NEVER kills the giant (FAIL-LOUD: the shell is a true gate)", !stuck.killed,
    `killed=${stuck.killed} phasesSeen=${stuck.phasesSeen.join(",")}`);
  check("…and it never even leaves phase 1 (no body damage without a peel)", stuck.spritePhaseMax === 1,
    `maxPhase=${stuck.spritePhaseMax}`);
}

// ---- 6. peeled-shell DEBRIS spawns on peel and acts as cover ----

function debrisGates(): void {
  section("peeled-shell DEBRIS: chunks drop at the base on each shell slough and act as cover");
  const r = peelPull(0x70D5, true);
  check("shell debris chunks dropped during the fight (material evidence of the peel)", r.debrisMax > 0,
    `maxDebris=${r.debrisMax}`);

  // The debris is real cover: a body cannot occupy it (propBlocksPoint), unlike open floor.
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
      propBlocksPoint(w, d.x, d.y, 12) && !propBlocksPoint(w, d.x + 500, d.y + 500, 12));
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
  check("the P3 safe lane is rideable (< player walk speed 200px/s)",
    (PALE.spokeStep / PALE.spokeInterval) * PALE.zoneRing < 200,
    `laneSpeed=${((PALE.spokeStep / PALE.spokeInterval) * PALE.zoneRing).toFixed(0)}px/s`);
  check("the P2 slag zones are hard-capped (a shrinking pocket, never a sealed floor)", PALE.zoneCap > 0);

  // Observe the P1 ring in-sim: a windup precedes the shockwave bullets, and the fired ring
  // carries a gap (fewer bullets than a full ring, leaving the safe wedge).
  const { w, boss } = paleArena(0x70E7);
  let sawWindup = false, ringShards = 0, bulletsBeforeActive = 0;
  for (let t = 0; t < 60 * 8 && ringShards === 0; t++) {
    const a = boss.attack;
    if (a.move === "slam" && a.phase === "windup") { sawWindup = true; bulletsBeforeActive = w.bullets.filter((b) => !b.friendly).length; }
    step(w, idle(t));
    if (a.move === "slam" && a.phase === "recover" && ringShards === 0) ringShards = w.bullets.filter((b) => !b.friendly).length;
  }
  check("the P1 ring telegraphs a windup BEFORE any shockwave fires", sawWindup && bulletsBeforeActive === 0);
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

function main(): void {
  pinGates();
  stationaryGates();
  calibrationGates();
  guardGates();
  peelPhaseGates();
  debrisGates();
  telegraphGates();
  determinismGates();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nThe F75 Pale Throne giant encounter holds.\n");
}

main();
