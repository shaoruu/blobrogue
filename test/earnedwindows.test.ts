// The EARNED WINDOWS contract (the game designer's anti-stack model, deep bosses):
//  - GUARDED by default: damage chips to guardMult (0.20–0.35) — reduction, NEVER immunity;
//  - EXPOSED windows are PLAYER-CREATED via each phase's mechanic, never timed gifts:
//      Weaver P1: break a lattice KNOT (and snag a mid-blink Weaver off its thread);
//      Weaver P2: destroy the egg-sac clutch to force her off the walls;
//      Weaver P3: bait the lane dash — a broken/empty lane overshoots into the wall;
//      MARROW:   bait the rush into a wall crash;
//      Choir:    silence every fragment of the current verse;
//      Warden:   dodge the committed quake/sweep, punish the open recover;
//  - per-window damage BANK (the ~40% phase chunk) closes a window early on overkill,
//    so a stacked party converts windows harder but can never one-shot a phase;
//  - transition beats always play (floor + queued overflow — the §5 plumbing, untouched);
//  - co-op scales the MECHANIC (task counts by the pull's snapshotted player count);
//  - the Slime King (tutorial) and the F10 gauntlet captains (the DPS/execution
//    contrast beat) deliberately have NO guard;
//  - boss death still ends danger; every path is deterministic.
//
// Run: npm run test:earnedwindows

import {
  createWorld, stepWorld, devSpawnEnemy, spawnPlayerInWorld, isBossExposed, isFloorCleared,
} from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, Enemy, EnemyKind } from "../src/sim/types.js";
import { createEnemy, ENEMY_ARCHETYPES } from "../src/sim/enemies.js";
import {
  MARROW, CHOIR, WEAVER, GILDED, GAUNTLET, gauntletCaptainHp,
  EARNED_GUARD_MIN, EARNED_GUARD_MAX, EXPOSE_WINDOW_CAP,
} from "../src/sim/balance.js";
import { Rng } from "../src/sim/rng.js";

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

function idle(seq: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
}
function step(w: WorldState, cmd: InputCmd = idle(0)): SimEvent[] {
  return stepWorld(w, new Map([[LOCAL_ID, cmd]]), DT);
}

// A friendly test bullet planted on a target (resolves through the ordinary strike
// path: guard chip, window bank, transition machinery, kill attribution).
function plantBullet(w: WorldState, x: number, y: number, damage: number, radius = 20): void {
  const b: Bullet = {
    x, y, vx: 1, vy: 0, radius, life: 0.05, friendly: true, owner: LOCAL_ID,
    damage, color: "#fff", pierce: 0, hitList: null, isCrit: false,
  };
  w.bullets.push(b);
}

function bossArena(seed: number, floor: number, kind: EnemyKind): { w: WorldState; boss: Enemy } {
  const w = createWorld(seed, floor, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  const boss = devSpawnEnemy(w, kind, p.x + 170, p.y);
  return { w, boss };
}

function liveOf(w: WorldState, kind: EnemyKind): Enemy[] {
  return w.enemies.filter((e) => !e.dead && e.kind === kind);
}

// ---- 1. guarded reduction (never immunity) + the tutorial/gauntlet exemptions ----

function guardGates(): void {
  section("guarded chip: every earned boss takes exactly guardMult damage while guarded");
  const rows: Array<[EnemyKind, number, number]> = [
    ["marrow", 15, MARROW.guardMult],
    ["weaver", 20, WEAVER.guardMult],
    ["gilded", 25, GILDED.armorChip],
    ["choir", 30, CHOIR.guardMult],
  ];
  for (const [kind, floor, guard] of rows) {
    const { w, boss } = bossArena(0xEA12 + floor, floor, kind);
    const hp0 = boss.hp;
    plantBullet(w, boss.x, boss.y, 100);
    step(w);
    const taken = hp0 - boss.hp;
    check(`${kind} guarded hit lands at ${(guard * 100).toFixed(0)}% (reduction, never immunity)`,
      Math.abs(taken - 100 * guard) < 1e-6 && taken > 0, `took ${taken.toFixed(1)}`);
    check(`${kind} guard sits inside the 0.20–0.35 fairness band`,
      guard >= EARNED_GUARD_MIN - 1e-9 && guard <= EARNED_GUARD_MAX + 1e-9, `guard=${guard}`);
  }

  section("no gating outside the deep roster: the Slime King and gauntlet captains take full damage");
  {
    const { w, boss } = bossArena(0xEA01, 5, "boss");
    const hp0 = boss.hp;
    plantBullet(w, boss.x, boss.y, 100);
    step(w);
    check("the F5 Slime King (tutorial boss) takes the full 100", Math.abs(hp0 - boss.hp - 100) < 1e-6,
      `took ${(hp0 - boss.hp).toFixed(1)}`);
  }
  {
    const w = createWorld(0xEA02, 10, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    const captain = devSpawnEnemy(w, GAUNTLET.rounds[0].kind, p.x + 170, p.y, GAUNTLET.rounds[0].tier);
    captain.hp = captain.maxHp = gauntletCaptainHp(GAUNTLET.rounds[0]);
    captain.captainPhase = 1;
    const hp0 = captain.hp;
    plantBullet(w, captain.x, captain.y, 60);
    step(w);
    check("an F10 gauntlet captain takes the full 60 (the deliberate DPS/execution beat)",
      Math.abs(hp0 - captain.hp - 60) < 1e-6, `took ${(hp0 - captain.hp).toFixed(1)}`);
  }
}

// ---- 2. windows only via the mechanic ----

function mechanicOnlyGates(): void {
  section("windows are PLAYER-CREATED: no exposure ever arrives as a timed gift (Weaver, 20s idle)");
  {
    const { w, boss } = bossArena(0xEA20, 20, "weaver");
    let isEverExposed = false;
    for (let t = 0; t < 60 * 20; t++) {
      step(w, idle(t));
      if (isBossExposed(boss)) isEverExposed = true;
    }
    check("20 untouched seconds never expose the Weaver", !isEverExposed && !boss.dead);
    check("its lattice stood for the taking the whole time (knots laid, none gifted a window)",
      liveOf(w, "knot").length > 0 || w.hazards.some((h) => h.kind === "web"));
  }

  section("Weaver P1 READ THE WEAVE: shooting the knot collapses the section and exposes");
  {
    const { w, boss } = bossArena(0xEA21, 20, "weaver");
    let knot: Enemy | undefined;
    for (let t = 0; t < 60 * 12 && !knot; t++) {
      step(w, idle(t));
      knot = liveOf(w, "knot")[0];
    }
    check("the weave lays a lattice knot", knot !== undefined);
    if (knot) {
      const p = w.players.get(LOCAL_ID)!;
      check("the knot is never where a player already stands (forced reposition)",
        Math.hypot(knot.x - p.x, knot.y - p.y) >= WEAVER.knotPlayerClear - 1e-6,
        `d=${Math.hypot(knot.x - p.x, knot.y - p.y).toFixed(0)}`);
      const kx = knot.x, ky = knot.y;
      const laneWebs0 = w.hazards.filter((h) => h.kind === "web").length;
      plantBullet(w, knot.x, knot.y, 500, 12);
      step(w);
      check("breaking the knot opens the EXPOSED window", isBossExposed(boss)
        && boss.boss!.exposed > WEAVER.knotBreakExpose - 0.1, `exposed=${boss.boss!.exposed.toFixed(2)}s`);
      check("the lane COLLAPSES with its anchor (silk crumbles) but loose debris remains at the break",
        w.hazards.filter((h) => h.kind === "web").length < laneWebs0
        && w.hazards.some((h) => h.kind === "web" && Math.hypot(h.x - kx, h.y - ky) < 8));
      const hp0 = boss.hp;
      plantBullet(w, boss.x, boss.y, 100);
      step(w);
      check("the open window takes FULL damage", Math.abs(hp0 - boss.hp - 100) < 1e-6,
        `took ${(hp0 - boss.hp).toFixed(1)}`);
    }
  }

  section("Weaver P2 SHE CLIMBS: untargetable with the clutch as the redirected target");
  {
    const { w, boss } = bossArena(0xEA22, 20, "weaver");
    boss.hp = boss.maxHp * 0.64; // into P2 territory…
    plantBullet(w, boss.x, boss.y, 1);
    step(w); // …via a damage event (transition machinery runs)
    for (let t = 0; t < 60 * 4; t++) step(w, idle(t)); // ride out the molt beat
    check("the molt transition played (P2)", boss.boss!.phase === 2);
    // Walk the machine into the climb.
    let isClimbing = false;
    for (let t = 0; t < 60 * 10 && !isClimbing; t++) {
      step(w, idle(t));
      isClimbing = boss.attack.move === "dive" && boss.attack.phase === "active";
    }
    check("she climbs the walls (dive grammar, untargetable)", isClimbing);
    const hp0 = boss.hp;
    plantBullet(w, boss.x, boss.y, 99);
    step(w);
    check("the climbing Weaver cannot be shot", boss.hp === hp0);
    // Alternate targets: the clutch blooms in on omen tells — never idle-punished.
    let sacs: Enemy[] = [];
    for (let t = 0; t < 60 * 3 && sacs.length < WEAVER.sacsFor[1]; t++) {
      step(w, idle(t));
      sacs = liveOf(w, "sac");
    }
    check(`the clutch gathered (${WEAVER.sacsFor[1]} sacs solo) while she is out of reach`,
      sacs.length >= WEAVER.sacsFor[1], `sacs=${sacs.length}`);
    // Destroy the whole clutch: she is FORCED DOWN — marked descent, crash, window.
    for (const sac of sacs) plantBullet(w, sac.x, sac.y, 500, 14);
    step(w);
    let isForced = false;
    for (let t = 0; t < 60 * 3 && !isForced; t++) {
      step(w, idle(t));
      isForced = boss.attack.move === "crash" && isBossExposed(boss);
    }
    check("silencing the last sac forces her down: crash stagger + the 4s window", isForced,
      `move=${boss.attack.move} exposed=${boss.boss!.exposed.toFixed(2)}s`);
  }
  {
    // The clutch IGNORED: she eventually descends on her own — with NO window.
    const { w, boss } = bossArena(0xEA23, 20, "weaver");
    boss.hp = boss.maxHp * 0.64;
    plantBullet(w, boss.x, boss.y, 1);
    step(w);
    for (let t = 0; t < 60 * 4; t++) step(w, idle(t));
    let sawClimb = false;
    let sawWindow = false;
    let isBackDown = false;
    for (let t = 0; t < 60 * (WEAVER.climbMax + 12) && !isBackDown; t++) {
      step(w, idle(t));
      const isUp = boss.attack.move === "dive" && boss.attack.phase === "active";
      if (isUp) sawClimb = true;
      if (isBossExposed(boss)) sawWindow = true;
      if (sawClimb && !isUp && boss.attack.move !== "dive" && boss.attack.move !== "pounce") isBackDown = true;
    }
    check("an ignored clutch only delays her: the voluntary descent opens NOTHING",
      sawClimb && isBackDown && !sawWindow);
    check("the climb is bounded (climbMax caps the untargetable stretch)", WEAVER.climbMax <= 12);
  }

  section("Weaver P1 snag: a knot shot out mid-blink drops the Weaver off its thread");
  {
    const { w, boss } = bossArena(0xEA24, 20, "weaver");
    // Walk the machine until it commits a blink (P1 weave→blink alternation).
    let isSnagged = false;
    for (let t = 0; t < 60 * 40 && !isSnagged; t++) {
      step(w, idle(t));
      if (boss.attack.move === "blink" && boss.attack.phase === "windup" && boss.boss!.laneKnotId > 0) {
        const lane = w.enemies.find((e) => !e.dead && e.id === boss.boss!.laneKnotId - 1);
        check("the committed lane names a live knot", lane !== undefined && lane.kind === "knot");
        if (lane) {
          plantBullet(w, lane.x, lane.y, 500, 12);
          step(w, idle(t + 1));
          isSnagged = boss.attack.move === "crash";
        }
        break;
      }
    }
    check("shooting the lane's knot snags the blink into a crash stagger + window",
      isSnagged && isBossExposed(boss));
  }

  section("Weaver P3 WALL-CRAWL DASH: intact lanes brake her; broken lanes overshoot");
  {
    const { w, boss } = bossArena(0xEA25, 20, "weaver");
    boss.hp = boss.maxHp * 0.29;
    plantBullet(w, boss.x, boss.y, 1);
    step(w);
    for (let t = 0; t < 60 * 4; t++) step(w, idle(t));
    check("P3 reached", boss.boss!.phase === 3);
    // First dash, lane left INTACT: she brakes at the far end — no window.
    let sawFlare = false;
    let isBraked = false;
    for (let t = 0; t < 60 * 30 && !isBraked; t++) {
      step(w, idle(t));
      const a = boss.attack;
      if (a.move === "rush" && a.phase === "windup") {
        sawFlare = true;
        check("the dash tell is locked for its whole ≥0.6s flare", a.isAimLocked && WEAVER.dashFlare >= 0.6);
        check("the committed lane is named (its silk is the flare)", boss.boss!.laneKnotId > 0);
        // Ride the whole commitment untouched.
        for (let k = 0; k < 60 * 4; k++) {
          step(w, idle(t + 1 + k));
          if (boss.attack.move === "rush" && boss.attack.phase === "recover") { isBraked = true; break; }
          if (boss.attack.move !== "rush") break;
        }
        break;
      }
    }
    check("an INTACT lane brakes the dash at its far end — no window",
      sawFlare && isBraked && !isBossExposed(boss));

    // Next dash: break the lane's knot DURING the flare — she overshoots into the wall.
    let isOvershot = false;
    let sawCrash = false;
    for (let t = 0; t < 60 * 40 && !isOvershot; t++) {
      step(w, idle(t));
      const a = boss.attack;
      if (a.move === "rush" && a.phase === "windup" && boss.boss!.laneKnotId > 0) {
        const lane = w.enemies.find((e) => !e.dead && e.id === boss.boss!.laneKnotId - 1);
        if (lane) plantBullet(w, lane.x, lane.y, 500, 12);
        for (let k = 0; k < 60 * 4; k++) {
          step(w, idle(t + 1 + k));
          if (boss.attack.move === "crash") { sawCrash = true; break; }
          if (boss.attack.move !== "rush") break;
        }
        isOvershot = sawCrash && isBossExposed(boss);
        break;
      }
    }
    check("a dash into the BROKEN lane overshoots into the wall: crash stagger + the 4s window",
      isOvershot);
  }

  section("MARROW: only the baited wall crash opens its window");
  {
    const { w, boss } = bossArena(0xEA26, 15, "marrow");
    // A rush that connects with a body: fast recover, no window.
    boss.attack.phase = "active";
    boss.attack.move = "rush";
    boss.attack.time = 0.02;
    boss.attack.lockedAngle = Math.PI; // toward the player standing right there
    step(w);
    check("a CONNECTING rush opens nothing", !isBossExposed(boss));
    // A rush into the wall: crash + window.
    boss.attack.phase = "active";
    boss.attack.move = "rush";
    boss.attack.time = 0.02;
    boss.x = 80; boss.y = 600; // pressed against the west arena wall
    boss.attack.lockedAngle = Math.PI;
    for (let t = 0; t < 4 && boss.attack.move === "rush"; t++) step(w, idle(t));
    check("the baited wall crash opens the exposed window",
      boss.attack.move === "crash" && isBossExposed(boss), `exposed=${boss.boss!.exposed.toFixed(2)}s`);
  }

  section("Hollow Choir: silence every fragment of the verse to expose");
  {
    const { w, boss } = bossArena(0xEA27, 30, "choir");
    let fragments: Enemy[] = [];
    for (let t = 0; t < 60 * 8 && fragments.length === 0; t++) {
      step(w, idle(t));
      fragments = w.enemies.filter((e) => !e.dead && e.isSummoned && boss.boss!.windowAddIds.includes(e.id));
    }
    check("a verse of fragments gathers", fragments.length >= CHOIR.fragmentsFor[1], `n=${fragments.length}`);
    plantBullet(w, fragments[0].x, fragments[0].y, 500, 14);
    step(w);
    check("a HALF-silenced verse exposes nothing", !isBossExposed(boss));
    for (const f of fragments) if (!f.dead) plantBullet(w, f.x, f.y, 500, 14);
    step(w);
    step(w, idle(1)); // silence lands on the Choir's next update (it precedes its fragments in the loop)
    check("silencing the LAST fragment opens the window", isBossExposed(boss),
      `exposed=${boss.boss!.exposed.toFixed(2)}s`);
  }

  section("Gilded Warden: the committed quake opens its recover as the window");
  {
    const { w, boss } = bossArena(0xEA28, 25, "gilded");
    let isOpened = false;
    for (let t = 0; t < 60 * 12 && !isOpened; t++) {
      step(w, idle(t));
      if (isBossExposed(boss)) isOpened = boss.attack.phase === "recover";
    }
    check("the slam/sweep recover IS the exposed window", isOpened);
  }
}

// ---- 3. the per-window damage bank ----

function bankGates(): void {
  section("per-window bank: a window can spend at most its phase chunk, then slams shut");
  const { w, boss } = bossArena(0xEA30, 20, "weaver");
  // The transition floors are the OTHER anti-burst layer (transitionGates below): spend
  // both beats up front so the bank binds in isolation here.
  boss.boss!.transitionsDone = 2;
  // Open a window via the real mechanic path.
  let knot: Enemy | undefined;
  for (let t = 0; t < 60 * 12 && !knot; t++) {
    step(w, idle(t));
    knot = liveOf(w, "knot")[0];
  }
  plantBullet(w, knot!.x, knot!.y, 500, 12);
  step(w);
  check("window open, bank armed at the phase chunk",
    isBossExposed(boss) && Math.abs(boss.boss!.windowBank - WEAVER.windowBankFrac * boss.maxHp) < 1e-6,
    `bank=${boss.boss!.windowBank.toFixed(0)}`);
  // A stacked party's overkill burst: far more than the bank in a single tick.
  const hpAtOpen = boss.hp;
  for (let i = 0; i < 12; i++) plantBullet(w, boss.x, boss.y, 60, 24);
  step(w);
  check("the bank closes the window early (overkill can't ride a spent window)",
    !isBossExposed(boss) && boss.boss!.windowBank === 0);
  // The window's applied damage is CLAMPED to its bank (overflow discarded — the true
  // anti-one-shot): the exposed hits remove exactly the bank, then every hit after the
  // window slams shut chips at guardMult.
  const bank = WEAVER.windowBankFrac * boss.maxHp;
  const exposedHits = Math.ceil(bank / 60);
  const expected = bank + (12 - exposedHits) * 60 * WEAVER.guardMult;
  const spent = hpAtOpen - boss.hp;
  check("the window's applied damage is clamped to the bank (overflow discarded), the rest chipped",
    Math.abs(spent - expected) < 1e-6, `spent=${spent.toFixed(0)} expected=${expected.toFixed(0)}`);
  const hp0 = boss.hp;
  plantBullet(w, boss.x, boss.y, 100);
  step(w);
  check("the very next hit is guarded again", Math.abs(hp0 - boss.hp - 100 * WEAVER.guardMult) < 1e-6);
  check("extending a live window never re-arms the bank (EXPOSE_WINDOW_CAP bounds stacking)",
    EXPOSE_WINDOW_CAP <= 8);
}

// ---- 4. phase transitions always play (the anti-burst floor, mid-window included) ----

function transitionGates(): void {
  section("phase transitions always play: bursts floor + queue at the threshold; a window can't skip a phase");
  const { w, boss } = bossArena(0xEA40, 20, "weaver");
  let knot: Enemy | undefined;
  for (let t = 0; t < 60 * 12 && !knot; t++) {
    step(w, idle(t));
    knot = liveOf(w, "knot")[0];
  }
  plantBullet(w, knot!.x, knot!.y, 500, 12);
  step(w);
  check("window open at full HP band", isBossExposed(boss) && boss.hp > boss.maxHp * 0.9);
  // A window's burst is CLAMPED to its bank (overflow discarded): even a million-damage hit
  // removes at most the phase chunk, so no single window can skip the 34%-wide P1 band.
  const hpBeforeBurst = boss.hp;
  plantBullet(w, boss.x, boss.y, 1e6, 30);
  step(w);
  check("an exposed burst is clamped to the window bank — it can never skip a phase",
    Math.abs((hpBeforeBurst - boss.hp) - WEAVER.windowBankFrac * boss.maxHp) < 1e-6
    && boss.hp > WEAVER.phaseAt[0] * boss.maxHp && !isBossExposed(boss),
    `removed=${(hpBeforeBurst - boss.hp).toFixed(0)} hp=${(boss.hp / boss.maxHp * 100).toFixed(0)}%`);
  // The transition floor + queued overflow is the second, phase-crossing guard: a guarded
  // burst that crosses a threshold floors at the phase floor and queues the overflow.
  plantBullet(w, boss.x, boss.y, 1e6, 30);
  const evs = step(w);
  const enter = evs.find((e) => e.t === "bossTransition" && e.entering);
  check("a guarded million-damage burst floors at 58% and queues the overflow",
    Math.abs(boss.hp - WEAVER.phaseFloor[0] * boss.maxHp) < 1e-6 && enter !== undefined
    && enter.t === "bossTransition" && enter.queued > 0,
    `hp=${(boss.hp / boss.maxHp * 100).toFixed(0)}%`);
  let ticks = 0;
  let isDead = false;
  while (!isDead && ticks < 60 * 20) {
    const e2 = step(w, idle(ticks + 1));
    if (e2.some((e) => e.t === "enemyKill" && e.kind === "weaver")) isDead = true;
    ticks++;
  }
  check("the boss dies only after BOTH molt beats resolve the queued overflow",
    isDead && ticks * DT >= 2 * WEAVER.moltDuration, `death at ${(ticks * DT).toFixed(2)}s`);
  check("boss death ends danger: knots/sacs/adds despawn and the floor clears", isFloorCleared(w),
    `enemies=${w.enemies.filter((e) => !e.dead).length}`);
}

// ---- 5. co-op scales the MECHANIC (snapshotted at the pull) ----

function coopMechanicGates(): void {
  section("co-op scales the tasks: knot/sac/fragment counts follow the snapshotted player count");
  const countTasks = (players: number): { knots: number; fragments: number } => {
    const w = createWorld(0xEA50, 20, { isSandbox: true, skipLocalPlayer: true });
    w.isGodMode = true;
    const ids: PlayerId[] = [];
    for (let i = 0; i < players; i++) { spawnPlayerInWorld(w, `p${i}`); ids.push(`p${i}`); }
    w.encounterPlayers = players; // the pull's snapshot (floor build does this in a run)
    const p0 = w.players.get(ids[0])!;
    // Spread the party so knot placement's player clearance can't starve the lattice.
    let k = 0;
    for (const pid of ids) {
      const pl = w.players.get(pid)!;
      pl.x = p0.x + (k % 2) * 500 - 250; pl.y = p0.y + Math.floor(k / 2) * 380 - 190; k++;
    }
    const weaver = devSpawnEnemy(w, "weaver", p0.x + 170, p0.y);
    let knots = 0;
    const cmds = new Map<PlayerId, InputCmd>([[ids[0], idle(0)]]);
    for (let t = 0; t < 60 * 12; t++) {
      stepWorld(w, cmds, DT);
      knots = Math.max(knots, w.enemies.filter((e) => !e.dead && e.kind === "knot").length);
    }
    weaver.dead = true;

    const w2 = createWorld(0xEA51, 30, { isSandbox: true, skipLocalPlayer: true });
    w2.isGodMode = true;
    for (let i = 0; i < players; i++) spawnPlayerInWorld(w2, `p${i}`);
    w2.encounterPlayers = players;
    const q0 = w2.players.get("p0")!;
    const choir = devSpawnEnemy(w2, "choir", q0.x + 170, q0.y);
    let fragments = 0;
    for (let t = 0; t < 60 * 8; t++) {
      stepWorld(w2, new Map([["p0", idle(t)]]), DT);
      // The verse draws varied voices now (fair surprise §1), so count the verse TASK
      // (the silence set), not the ghost kind — the co-op contract is the task COUNT.
      fragments = Math.max(fragments, w2.enemies.filter((e) => !e.dead && e.isSummoned && choir.boss!.windowAddIds.includes(e.id)).length);
    }
    return { knots, fragments };
  };
  const solo = countTasks(1);
  const four = countTasks(4);
  check(`solo pull: ${WEAVER.knotsFor[1]} knot / ${CHOIR.fragmentsFor[1]} fragments`,
    solo.knots === WEAVER.knotsFor[1] && solo.fragments === CHOIR.fragmentsFor[1],
    `knots=${solo.knots} fragments=${solo.fragments}`);
  check(`4-player pull: ${WEAVER.knotsFor[4]} knots / ${CHOIR.fragmentsFor[4]} fragments (more simultaneous tasks)`,
    four.knots === WEAVER.knotsFor[4] && four.fragments === CHOIR.fragmentsFor[4],
    `knots=${four.knots} fragments=${four.fragments}`);
  check("the egg-sac clutch scales too: 2 solo, +1 per extra player (table contract)",
    WEAVER.sacsFor[1] === 2 && WEAVER.sacsFor[2] === 3 && WEAVER.sacsFor[3] === 4 && WEAVER.sacsFor[4] === 5);
}

// ---- 6. no soft-lock: pure chip kills every earned boss without any mechanic ----

function noSoftLockGates(): void {
  section("no soft-lock: ignoring every mechanic still kills (chip is the slow way, never a wall)");
  const rows: Array<[EnemyKind, number]> = [["marrow", 15], ["weaver", 20], ["gilded", 25], ["choir", 30]];
  for (const [kind, floor] of rows) {
    const { w, boss } = bossArena(0xEA60 + floor, floor, kind);
    let ticks = 0;
    let isDead = false;
    while (!isDead && ticks < 60 * 60) {
      // Big flat chip planted straight on the boss — no knots, no baits, no reads.
      if (ticks % 6 === 0 && !boss.dead) plantBullet(w, boss.x, boss.y, 40, 26);
      const evs = step(w, idle(ticks));
      if (evs.some((e) => e.t === "enemyKill" && e.kind === kind)) isDead = true;
      ticks++;
    }
    check(`${kind} dies to pure guarded chip inside 60s of sustained fire`, isDead,
      isDead ? `at ${(ticks * DT).toFixed(1)}s` : `alive hp=${boss.hp.toFixed(0)}`);
  }
}

// ---- 7. determinism: byte-identical replay of a full mechanic-heavy fight ----

function determinismGates(): void {
  section("determinism: the same seeded fight replays byte-identically (windows, knots, feints)");
  const runFight = (): string => {
    const { w, boss } = bossArena(0xEA70, 20, "weaver");
    const p = w.players.get(LOCAL_ID)!;
    const log: string[] = [];
    for (let t = 0; t < 60 * 45 && !boss.dead; t++) {
      const knot = boss.boss!.exposed > 0 ? undefined : liveOf(w, "knot")[0];
      const aimAt = knot ?? boss;
      const aim = Math.atan2(aimAt.y - p.y, aimAt.x - p.x);
      step(w, { seq: t, moveX: 0, moveY: 0, aim, firing: true, dash: false });
      if (t % 30 === 0) {
        log.push(`${t}:${boss.hp.toFixed(4)}:${boss.boss!.phase}:${boss.boss!.exposed.toFixed(4)}:${boss.x.toFixed(4)},${boss.y.toFixed(4)}:${w.enemies.length}:${w.hazards.length}`);
      }
    }
    return log.join("|");
  };
  const a = runFight();
  const b = runFight();
  check("two full runs produce identical state traces", a === b, `trace=${a.length} chars`);
}

// ---- 8. wire/view surface: exposed rides aux; mechanic bodies are honest decoys ----

function surfaceGates(): void {
  section("surface: guard/exposed state rides the aux channel; knots/sacs pay threat, drop nothing");
  {
    const { w, boss } = bossArena(0xEA80, 25, "gilded");
    let isChecked = false;
    for (let t = 0; t < 60 * 12 && !isChecked; t++) {
      step(w, idle(t));
      if (isBossExposed(boss)) {
        step(w, idle(t + 1)); // aux mirrors on the next timer tick
        check("the boss's aux mirrors its exposed remainder (the client's render key)",
          boss.aux > 0 && Math.abs(boss.aux - boss.boss!.exposed) < 2 * DT, `aux=${boss.aux.toFixed(2)}`);
        isChecked = true;
      }
    }
    check("an exposed window was observed on the Warden", isChecked);
  }
  check("knots and sacs carry real threat cost (summons hold live budget)",
    ENEMY_ARCHETYPES.knot.threat > 0 && ENEMY_ARCHETYPES.sac.threat > 0);
  check("knots and sacs are harmless bodies (no touch damage)",
    ENEMY_ARCHETYPES.knot.touchDamage === 0 && ENEMY_ARCHETYPES.sac.touchDamage === 0);
  {
    // Breaking a knot grants no kill credit, no combo, no loot (a play, not an economy).
    const { w } = bossArena(0xEA81, 20, "weaver");
    const p = w.players.get(LOCAL_ID)!;
    let knot: Enemy | undefined;
    for (let t = 0; t < 60 * 12 && !knot; t++) {
      step(w, idle(t));
      knot = liveOf(w, "knot")[0];
    }
    const kills0 = p.kills, combo0 = p.combo, pickups0 = w.pickups.length;
    plantBullet(w, knot!.x, knot!.y, 500, 12);
    step(w);
    check("a broken knot yields no kills/combo/loot",
      p.kills === kills0 && p.combo === combo0 && w.pickups.length === pickups0);
  }
  {
    // A knot's fuse expiry crumbles into debris WITHOUT a window (only the shot earns it).
    const { w, boss } = bossArena(0xEA82, 20, "weaver");
    let knot: Enemy | undefined;
    for (let t = 0; t < 60 * 12 && !knot; t++) {
      step(w, idle(t));
      knot = liveOf(w, "knot")[0];
    }
    knot!.aux = 0.01;
    let isWindowFromExpiry = false;
    for (let t = 0; t < 30; t++) {
      step(w, idle(t));
      if (isBossExposed(boss)) isWindowFromExpiry = true;
    }
    check("an expired knot never opens a window (debris only)", !isWindowFromExpiry);
  }
}

function main(): void {
  guardGates();
  mechanicOnlyGates();
  bankGates();
  transitionGates();
  coopMechanicGates();
  noSoftLockGates();
  determinismGates();
  surfaceGates();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nThe earned-windows contract holds.\n");
}

main();
