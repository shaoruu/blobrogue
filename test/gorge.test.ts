// GORGE (F50 GIANT #1 — the Sump cap; the AD-LOCKED shell-peel giant TEMPLATE for F75/F100).
// The encounter's determinism-critical authoritative-sim contract:
//  - F50 is ALWAYS the gorge giant (a FIXED set-piece, not the seeded deep rotation), and the
//    F55+ rotation stays deterministic + no-immediate-repeat behind the override.
//  - STATIONARY: it never chases (baseSpeed 0, ~immovable) — its threat is space-control.
//  - MULTI-PHASE SHELL-PEEL: the body is GUARDED behind its shell (guardMult 0.0 — a TRUE hard
//    gate); the ONLY damage path is PEELING (destroy the tectonic weak-points → openBossWindow).
//    The 3 shells advance ONLY through peel windows (rind → chitin → core).
//  - GIANT HP calibration HARD RULE: per-shell HP is a FRACTION of a standard boss, total
//    ~1.4-1.6x via PHASE COUNT — NEVER ~4x HP on one pool.
//  - PEEL debris chunks drop at the base as reusable cover; telegraphs precede every pattern.
//  - BEATABLE: a bot that opens windows (peels) kills it; one that can't → it NEVER dies (the
//    FAIL-LOUD gate, mirroring the multi-boss health-gate philosophy).
//
// Run: npm run test:gorge

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
  GORGE, gorgeHpForFloor, gorgeSeamCountFor, gorgeShellFracFor,
} from "../src/sim/balance.js";
import { bossKindForFloor, GORGE_FLOOR, isBossKind, ENEMY_ARCHETYPES } from "../src/sim/enemies.js";

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
function gorgeArena(seed: number): { w: WorldState; boss: Enemy } {
  const w = createWorld(seed, GORGE_FLOOR, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 0;
  const boss = devSpawnEnemy(w, "gorge", p.x + 220, p.y);
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  return { w, boss };
}

function liveSeams(w: WorldState): Enemy[] {
  return w.enemies.filter((e) => !e.dead && e.kind === "gorge_seam");
}
function liveDebris(w: WorldState): Prop[] {
  return w.props.filter((p) => !p.dead && p.breakT === undefined && p.kind === "gorge_debris");
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

// ---- 1. F50 pin + the seeded rotation behind it ----

function pinGates(): void {
  section("F50 is ALWAYS the gorge giant (a fixed set-piece); F55 Sever pin; F60 Choirmaster pin; F65+ rotation intact");
  check("GORGE_FLOOR is 50", GORGE_FLOOR === 50);
  check("gorge is a boss kind (HP bar, chest, danger-end, HP scaling)", isBossKind("gorge"));

  const deepRoster: EnemyKind[] = ["marrow", "choir", "weaver", "gilded", "boss", "jet", "tithe", "quorum"];
  const seen = new Set<EnemyKind>();
  let allGorge = true, f45Quorum = true, allSever = true, allChoir = true, deterministic = true, noRepeat = true, neverGorge = true;
  for (let s = 0; s < 80; s++) {
    const seed = 0x5EED + s * 977;
    if (bossKindForFloor(seed, 50) !== "gorge") allGorge = false;
    if (bossKindForFloor(seed, 45) !== "quorum") f45Quorum = false; // the authored chain up to F45 is untouched
    if (bossKindForFloor(seed, 55) !== "sever") allSever = false; // Batch1 Sever pin
    if (bossKindForFloor(seed, 60) !== "choirmaster") allChoir = false; // Batch2A Choirmaster pin
    // F50 gorge + F55 Sever + F60 Choirmaster are fixed; seeded rotation resumes at F65 and must
    // never repeat back-to-back (nor pick the pinned bosses, which are out of the pool).
    let prev: EnemyKind | null = "choirmaster";
    for (let floor = 65; floor <= 95; floor += 5) {
      if (floor === 75) continue; // Pale Throne pin
      const a = bossKindForFloor(seed, floor);
      if (a !== bossKindForFloor(seed, floor)) deterministic = false;
      if (a === null || a === prev) noRepeat = false;
      if (a === "gorge" || a === "sever" || a === "choirmaster" || a === "pale") neverGorge = false;
      if (a !== null) seen.add(a);
      prev = a;
    }
  }
  check("floor 50 returns gorge for every seed (never a seeded rotation pick)", allGorge);
  check("the authored chain up to F45 is untouched (F45 is still Quorum)", f45Quorum);
  check("floor 55 returns sever for every seed (Batch1 fixed hunt set-piece)", allSever);
  check("floor 60 returns choirmaster for every seed (Batch2A fixed split set-piece)", allChoir);
  check("F65+ deep rotation is a pure function of (seed, floor)", deterministic);
  check("F65+ has no immediate repeats (nor against the F60 Choirmaster pin)", noRepeat);
  check("the seeded rotation NEVER picks gorge/sever/choirmaster/pale (fixed set-pieces)", neverGorge);
  check("every seeded-roster boss still appears across F65-95 (variety survives the pins)",
    deepRoster.every((k) => seen.has(k)), [...seen].join(","));

  // The floor planner spawns the gorge (centered) at F50 with its full pool.
  const w = createWorld(0xF50A, GORGE_FLOOR, {});
  loadFloorIntoWorld(w, GORGE_FLOOR);
  const giant = w.enemies.find((e) => e.kind === "gorge");
  check("the F50 floor plan spawns the gorge giant", giant !== undefined);
  if (giant) {
    const room = w.dungeon.rooms[w.dungeon.rooms.length - 1];
    const cx = (room.cx + 0.5) * TILE, cy = (room.cy + 0.5) * TILE;
    check("the stationary giant anchors at the arena CENTER (symmetric ring space)",
      Math.hypot(giant.x - cx, giant.y - cy) < 1, `d=${Math.hypot(giant.x - cx, giant.y - cy).toFixed(2)}`);
    check("the giant carries its full per-floor pool at F50", giant.maxHp === gorgeHpForFloor(GORGE_FLOOR),
      `hp=${giant.maxHp}`);
  }
}

// ---- 2. STATIONARY set-piece ----

function stationaryGates(): void {
  section("the giant is a STATIONARY set-piece — it never chases (its threat is space-control)");
  const { w, boss } = gorgeArena(0x60A1);
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
  check("its archetype speed is 0 (a set-piece)", ENEMY_ARCHETYPES.gorge.baseSpeed === 0);
}

// ---- 3. GIANT HP calibration HARD RULE ----

function calibrationGates(): void {
  section("GIANT calibration (balancer F50 anchors): back-loaded per-shell HP, PER-PHASE banking, never a 4x pool");
  const shellHp = GORGE.shellHp;
  const total = shellHp.reduce((a, b) => a + b, 0);
  check("there are exactly 3 shells (rind / chitin / core)", shellHp.length === 3);
  check("the per-shell HP is the balancer's F50 anchor [260, 290, 380]",
    shellHp[0] === 260 && shellHp[1] === 290 && shellHp[2] === 380, `shellHp=[${shellHp.join(",")}]`);
  check("the total giant budget is 930 at F50 (gorgeHpForFloor sums the per-shell anchors)",
    gorgeHpForFloor(50) === 930, `total=${gorgeHpForFloor(50)}`);
  // BACK-LOADED: the fight escalates INTO its hardest/longest phase (the core reveal). Never
  // front-loaded (which would make the giant easiest exactly when its scariest form appears).
  check("the pool is BACK-LOADED — core is the heaviest phase (rind < chitin < core)",
    shellHp[2] > shellHp[1] && shellHp[1] > shellHp[0], `${shellHp[0]} < ${shellHp[1]} < ${shellHp[2]}`);
  // The GIANT calibration HARD RULE: ~1.5x a standard deep boss via PHASE COUNT, NEVER a ~4x pool
  // (a naive one-pool 4x giant would be ~2360 — the sponge this structure avoids).
  check("the total is ~1.5x a standard boss, NOT a ~4x single-pool sponge (well under ~2360)",
    total >= 800 && total <= 1100, `total=${total}`);
  check("NO single shell is ~a full pool (each is a FRACTION — never 4x on one pool)",
    shellHp.every((h) => h < total * 0.5), `max=${Math.max(...shellHp)} total=${total}`);
  // phaseAt = the cumulative-from-full complement of shellHp (a shell sloughs when its chunk spent).
  const expectPhaseAt = [(total - shellHp[0]) / total, (total - shellHp[0] - shellHp[1]) / total];
  check("phaseAt matches the cumulative complement of shellHp (thresholds in lockstep with the split)",
    Math.abs(GORGE.phaseAt[0] - expectPhaseAt[0]) < 5e-4 && Math.abs(GORGE.phaseAt[1] - expectPhaseAt[1]) < 5e-4,
    `phaseAt=[${GORGE.phaseAt.join(",")}] vs [${expectPhaseAt.map((x) => x.toFixed(4)).join(",")}]`);
  check("phase floors sit under each threshold (anti-burst overflow lands after the crack-off)",
    GORGE.phaseFloor[0] < GORGE.phaseAt[0] && GORGE.phaseFloor[1] < GORGE.phaseAt[1]);

  // PER-PHASE anti-burst: a single window caps at 0.22 × the CURRENT shell's HP (~57 / 64 / 84),
  // so each phase needs ~5 windows and no phase can be one-burst even at high roll — the K=3
  // structure enforces the anti-burst without a fat pool.
  const banks = [1, 2, 3].map((ph) => GORGE.windowBankFrac * gorgeShellFracFor(ph) * total);
  check("per-phase window bank is 0.22 × each shell's HP (~57 / 64 / 84 for rind/chitin/core)",
    Math.abs(banks[0] - 57.2) < 1 && Math.abs(banks[1] - 63.8) < 1 && Math.abs(banks[2] - 83.6) < 1,
    `banks=[${banks.map((b) => b.toFixed(0)).join(",")}]`);
  check("each phase needs ~5 earned windows to clear (never one-burst, incl. a 4-stack)",
    shellHp.every((h, i) => h / banks[i] >= 4), `windows/phase=[${shellHp.map((h, i) => (h / banks[i]).toFixed(1)).join(",")}]`);

  // Co-op scales the TASK (more seams), not the HP: seam count grows with players, per shell.
  check("weak-point count scales with the party (co-op = more seams = the TASK scales, not HP)",
    gorgeSeamCountFor(1, 1) < gorgeSeamCountFor(1, 4)
    && gorgeSeamCountFor(2, 1) < gorgeSeamCountFor(2, 4)
    && gorgeSeamCountFor(3, 1) < gorgeSeamCountFor(3, 4));
  check("the weak-point verb ESCALATES per shell (RIND few → CHITIN more → CORE most)",
    gorgeSeamCountFor(1, 1) < gorgeSeamCountFor(2, 1) && gorgeSeamCountFor(2, 1) < gorgeSeamCountFor(3, 1),
    `solo=[${gorgeSeamCountFor(1, 1)},${gorgeSeamCountFor(2, 1)},${gorgeSeamCountFor(3, 1)}]`);
  check("seam count is hard-capped for readability (disjoint lanes around the 192px body)",
    gorgeSeamCountFor(3, 4) <= GORGE.seamCap);
}

// ---- 4. the guard gate: the shell IS the wall (only peeling opens the body) ----

function guardGates(): void {
  section("GUARDED behind the shell: the body takes ZERO damage while sealed — only PEELING opens it");
  const { w, boss } = gorgeArena(0x60B2);
  check("the giant starts sealed (guarded, not exposed)", !isBossExposed(boss));
  check("the guard multiplier is 0.0 (ZERO body damage while shelled)", GORGE.guardMult === 0);
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
  // The PER-PHASE anti-burst: a single window caps at 0.22 × the CURRENT shell's HP chunk (not the
  // whole pool), so even an arbitrarily large burst removes at most one shell-phase's bank.
  const phaseBank = GORGE.windowBankFrac * gorgeShellFracFor(boss.boss!.phase) * boss.maxHp;
  check("a single burst can NEVER remove more than one PER-PHASE window bank (0.22 × the shell's HP)",
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
function peelPull(seed: number, canPeel: boolean, maxTicks = 60 * 120): PeelResult {
  const { w, boss } = gorgeArena(seed);
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
      if (e.t === "enemyKill" && e.kind === "gorge") killed = true;
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
  const r = peelPull(0x60C3, true);
  check("a bot that PEELS (opens windows) KILLS the giant (the fight is beatable)", r.killed,
    `ttk=${r.seconds.toFixed(1)}s`);
  check("it advanced through all THREE shell phases (rind → chitin → core)",
    r.phasesSeen.includes(1) && r.phasesSeen.includes(2) && r.phasesSeen.includes(3),
    `phases=${r.phasesSeen.join(",")}`);
  check("the shell sprite advanced to phase 3 (the core reveal)", r.spritePhaseMax >= 3);
  check("the PER-PHASE bank forces ~5 windows/phase (>=10 total — no phase one-burst, incl. a 4-stack)",
    r.peelWindows >= 10, `windows=${r.peelWindows}`);
  check("the peel PUNCTUATES (crack beats fired on the weak-point clears)", r.crackBeats >= 3, `cracks=${r.crackBeats}`);

  // FAIL LOUD: a bot that CANNOT open windows (never peels) can NEVER kill the giant — the shell
  // is a true hard gate, so the body never takes damage. (Mirrors the multi-boss health gate.)
  const stuck = peelPull(0x60C4, false, 60 * 60);
  check("a bot that CANNOT peel NEVER kills the giant (FAIL-LOUD: the shell is a true gate)", !stuck.killed,
    `killed=${stuck.killed} phasesSeen=${stuck.phasesSeen.join(",")}`);
  check("…and it never even leaves phase 1 (no body damage without a peel)", stuck.spritePhaseMax === 1,
    `maxPhase=${stuck.spritePhaseMax}`);
}

// ---- 6. peeled-shell DEBRIS spawns on peel and acts as cover ----

function debrisGates(): void {
  section("peeled-shell DEBRIS: chunks drop at the base on each shell slough and act as cover");
  const r = peelPull(0x60D5, true);
  check("shell debris chunks dropped during the fight (material evidence of the peel)", r.debrisMax > 0,
    `maxDebris=${r.debrisMax}`);

  // The debris is real cover: a body cannot occupy it (propBlocksPoint), unlike open floor.
  const { w, boss } = gorgeArena(0x60D6);
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
      Math.hypot(d.x - boss.x, d.y - boss.y) > ENEMY_ARCHETYPES.gorge.radius);
  }
}

// ---- 7. tectonic telegraphs precede every pattern; the authored safe pocket always exists ----

function telegraphGates(): void {
  section("tectonic telegraphs: every ring/zone/spoke has a >=0.6s tell, and always an authored safe pocket");
  check("every pattern's windup is >=0.6s (the readable rear/windup tell)",
    GORGE.ringWindup >= 0.6 && GORGE.zoneWindup >= 0.6 && GORGE.spokeWindup >= 0.6,
    `ring=${GORGE.ringWindup} zone=${GORGE.zoneWindup} spoke=${GORGE.spokeWindup}`);
  check("the P1 ring leaves an authored GAP (a stand-in-the-gap safe wedge)", GORGE.ringGap > 0 && GORGE.ringGap < GORGE.ringCount);
  check("the P3 spokes leave ONE moving safe wedge", GORGE.spokeGap > 0 && GORGE.spokeGap < GORGE.spokeCount);
  check("the P3 safe lane is rideable (< player walk speed 200px/s)",
    (GORGE.spokeStep / GORGE.spokeInterval) * GORGE.zoneRing < 200,
    `laneSpeed=${((GORGE.spokeStep / GORGE.spokeInterval) * GORGE.zoneRing).toFixed(0)}px/s`);
  check("the P2 slag zones are hard-capped (a shrinking pocket, never a sealed floor)", GORGE.zoneCap > 0);

  // Observe the P1 ring in-sim: a windup precedes the shockwave bullets, and the fired ring
  // carries a gap (fewer bullets than a full ring, leaving the safe wedge).
  const { w, boss } = gorgeArena(0x60E7);
  let sawWindup = false, ringShards = 0, bulletsBeforeActive = 0;
  for (let t = 0; t < 60 * 8 && ringShards === 0; t++) {
    const a = boss.attack;
    if (a.move === "slam" && a.phase === "windup") { sawWindup = true; bulletsBeforeActive = w.bullets.filter((b) => !b.friendly).length; }
    step(w, idle(t));
    if (a.move === "slam" && a.phase === "recover" && ringShards === 0) ringShards = w.bullets.filter((b) => !b.friendly).length;
  }
  check("the P1 ring telegraphs a windup BEFORE any shockwave fires", sawWindup && bulletsBeforeActive === 0);
  check("the fired ring omits a gap wedge (fewer shards than a full ring — the safe pocket)",
    ringShards > 0 && ringShards <= GORGE.ringCount - GORGE.ringGap, `shards=${ringShards} full=${GORGE.ringCount}`);
}

// ---- 8. determinism: the whole encounter replays byte-identically ----

function determinismGates(): void {
  section("determinism: the same seed replays the giant tick-for-tick (peels, patterns, debris, phases)");
  const run = (): string => {
    const { w, boss } = gorgeArena(0x60F8);
    const log: string[] = [];
    for (let t = 0; t < 60 * 40 && !boss.dead; t++) {
      for (const s of liveSeams(w)) plantBullet(w, s.x, s.y, 9999);
      if (isBossExposed(boss)) plantBullet(w, boss.x, boss.y, 100000);
      const evs = step(w, idle(t));
      for (const e of evs) {
        if (e.t === "enemySpawn" && e.kind === "gorge_seam") log.push(`${t}:seam@${e.x.toFixed(2)},${e.y.toFixed(2)}`);
        if (e.t === "bossPhase") log.push(`${t}:phase`);
      }
      if (t % 30 === 0) {
        log.push(`${t}:${boss.hp.toFixed(3)}:${boss.boss!.phase}:${isBossExposed(boss) ? 1 : 0}:${liveSeams(w).length}:${liveDebris(w).length}:${boss.x.toFixed(3)},${boss.y.toFixed(3)}`);
      }
    }
    return log.join("|");
  };
  const a = run(), b = run();
  check("two identical gorge pulls match tick-for-tick (seeded RNG only — no Date.now/Math.random)",
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
  process.stdout.write("\nThe F50 Gorge giant encounter holds.\n");
}

main();
