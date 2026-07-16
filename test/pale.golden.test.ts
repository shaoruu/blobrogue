import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PALE } from "../src/sim/balance.js";
import type { SimEvent } from "../src/sim/events.js";
import { PALE_FLOOR } from "../src/sim/enemies.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, Enemy } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import {
  createWorld,
  isBossExposed,
  loadFloorIntoWorld,
  stepWorld,
} from "../src/sim/world.js";

const DT = 1 / 60;
const SEED = 0xF75A;
const MAX_TICKS = 60 * 150;
const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), "golden", "pale-authoritative.json");

interface PhaseEntry {
  phase: number;
  tick: number;
  hp: number;
}

interface SweepEmission {
  tick: number;
  count: number;
  angles: number[];
}

interface PaleGolden {
  schema: 1;
  seed: number;
  floor: number;
  playerCount: number;
  ticks: number;
  spawn: {
    kind: "pale";
    count: number;
    maxHp: number;
    x: number;
    y: number;
  };
  phaseAt: number[];
  phaseFloor: number[];
  phaseEntries: PhaseEntry[];
  earnedWindowsByPhase: number[];
  peelEvents: number;
  debrisMax: number;
  dualSweep: {
    windupTick: number;
    recoverTick: number;
    emissions: number;
    bulletsPerEmission: number[];
    hash: string;
  };
  warmth: {
    activeTick: number;
    chilledTick: number;
    clearedTick: number;
    chilledPerTick: number;
    freePerTick: number;
    speedRatio: number;
    hpBefore: number;
    hpAfter: number;
  };
  completion: {
    deathTick: number;
    bossKillEvents: number;
    bossPhaseEvents: number;
    bossTransitionEvents: number;
    chestCount: number;
    isBossDead: boolean;
  };
  stateHash: string;
  eventHash: string;
}

interface ScenarioRun {
  golden: PaleGolden;
  stateBytes: string;
  eventBytes: string;
}

type WarmthStage = "waiting" | "idling" | "chilledSample" | "clearing" | "freeSample" | "done";

function r(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function input(seq: number, moveX: number): InputCmd {
  return { seq, moveX, moveY: 0, aim: 0, firing: false, dash: false };
}

function plantBullet(x: number, y: number, damage: number): Bullet {
  return {
    x,
    y,
    vx: 1,
    vy: 0,
    radius: 18,
    life: 0.05,
    friendly: true,
    owner: LOCAL_ID,
    damage,
    color: "#fff",
    pierce: 0,
    hitList: null,
    isCrit: false,
  };
}

function relevantEvent(tick: number, event: SimEvent, boss: Enemy): string | null {
  if (event.t === "bossTransition" && event.eid === boss.id) {
    return `${tick}:transition:${event.phase}:${event.entering ? 1 : 0}:${event.queued}:${r(event.hpFrac)}`;
  }
  if (event.t === "bossPhase" && event.eid === boss.id) return `${tick}:phase:${boss.boss?.phase ?? 0}`;
  if (event.t === "enemySpawn" && event.kind === "pale_seam") {
    return `${tick}:seam:${event.eid}:${r(event.x)}:${r(event.y)}`;
  }
  if (event.t === "enemyKill" && (event.kind === "pale" || event.kind === "pale_seam")) {
    return `${tick}:kill:${event.kind}:${event.eid}`;
  }
  if (event.t === "chargeCrash") return `${tick}:peel:${r(event.x)}:${r(event.y)}`;
  if (event.t === "radialBurst" && boss.attack.move === "sweep") return `${tick}:sweep-release`;
  return null;
}

function runScenario(): ScenarioRun {
  const world = createWorld(SEED, PALE_FLOOR, {});
  loadFloorIntoWorld(world, PALE_FLOOR);
  const naturalPale = world.enemies.filter((enemy) => enemy.kind === "pale");
  const boss = naturalPale[0];
  const player = world.players.get(LOCAL_ID);
  if (naturalPale.length !== 1 || boss === undefined || player === undefined) {
    throw new Error(`expected one natural F75 Pale boss and one player; pale=${naturalPale.length} player=${player === undefined ? 0 : 1}`);
  }

  const spawn = {
    kind: "pale" as const,
    count: naturalPale.length,
    maxHp: boss.maxHp,
    x: r(boss.x),
    y: r(boss.y),
  };
  const arena = world.dungeon.rooms[world.dungeon.rooms.length - 1];
  const centerX = (arena.cx + 0.5) * TILE;
  const centerY = (arena.cy + 0.5) * TILE;
  if (Math.hypot(boss.x - centerX, boss.y - centerY) >= 1) {
    throw new Error("natural Pale boss is not anchored at the F75 arena center");
  }

  world.enemies = [boss];
  world.bullets = [];
  world.hazards = [];
  world.isGodMode = true;
  player.x = boss.x - 220;
  player.y = boss.y;
  player.invuln = 0;
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;

  const phaseEntries: PhaseEntry[] = [{ phase: 1, tick: 0, hp: r(boss.hp) }];
  const earnedWindowsByPhase = [0, 0, 0];
  const sweepEmissions: SweepEmission[] = [];
  const chilledSteps: number[] = [];
  const freeSteps: number[] = [];
  const stateTrace: string[] = [];
  const eventTrace: string[] = [];
  let previousPhase = 1;
  let isPreviouslyExposed = false;
  let warmthStage: WarmthStage = "waiting";
  let warmthActiveTick = -1;
  let chilledTick = -1;
  let clearedTick = -1;
  let warmthHpBefore = player.hp;
  let warmthHpAfter = player.hp;
  let sweepWindupTick = -1;
  let sweepRecoverTick = -1;
  let deathTick = -1;
  let bossKillEvents = 0;
  let bossPhaseEvents = 0;
  let bossTransitionEvents = 0;
  let peelEvents = 0;
  let debrisMax = 0;
  let finalTick = MAX_TICKS;

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    const isSweepObserved = sweepRecoverTick >= 0;
    const isWarmthObserved = warmthStage === "done";
    const isFinishing = boss.boss?.phase !== 3 || (isSweepObserved && isWarmthObserved);
    if (!boss.dead && isFinishing) {
      if (isBossExposed(boss)) {
        world.bullets.push(plantBullet(boss.x, boss.y, 100000));
      } else {
        for (const seam of world.enemies) {
          if (!seam.dead && seam.kind === "pale_seam") {
            world.bullets.push(plantBullet(seam.x, seam.y, 9999));
          }
        }
      }
    }

    const isChilledSample = warmthStage === "chilledSample";
    const isClearing = warmthStage === "clearing";
    const isFreeSample = warmthStage === "freeSample";
    const moveX = isChilledSample || isClearing || isFreeSample ? -1 : 0;
    const xBefore = player.x;
    const bulletsBefore = new Set(world.bullets);
    const events = stepWorld(world, new Map([[LOCAL_ID, input(tick, moveX)]]), DT);
    const freshEnemyBullets = world.bullets.filter((bullet) => !bullet.friendly && !bulletsBefore.has(bullet));

    if (boss.boss !== null && boss.boss.phase !== previousPhase) {
      previousPhase = boss.boss.phase;
      phaseEntries.push({ phase: previousPhase, tick, hp: r(boss.hp) });
      if (previousPhase === 3) {
        warmthStage = "idling";
        warmthHpBefore = player.hp;
      }
    }

    const isExposed = isBossExposed(boss);
    if (isExposed && !isPreviouslyExposed && boss.boss !== null) {
      earnedWindowsByPhase[boss.boss.phase - 1]++;
    }
    isPreviouslyExposed = isExposed;

    if (boss.attack.move === "sweep" && boss.attack.phase === "windup" && sweepWindupTick < 0) {
      sweepWindupTick = tick;
    }
    if (boss.attack.move === "sweep" && freshEnemyBullets.length > 0) {
      sweepEmissions.push({
        tick,
        count: freshEnemyBullets.length,
        angles: freshEnemyBullets.map((bullet) => r(Math.atan2(bullet.vy, bullet.vx))),
      });
    }
    if (sweepEmissions.length > 0 && boss.attack.move === "sweep" && boss.attack.phase === "recover" && sweepRecoverTick < 0) {
      sweepRecoverTick = tick;
    }

    const warmthIdle = player.warmthIdleSec;
    if (world.warmthDrain !== null && warmthActiveTick < 0) warmthActiveTick = tick;
    if (warmthStage === "idling" && warmthIdle >= PALE.warmthDrainIdleSec) {
      warmthStage = "chilledSample";
      chilledTick = tick;
    } else if (isChilledSample) {
      chilledSteps.push(r(Math.abs(player.x - xBefore)));
      if (chilledSteps.length === 3) warmthStage = "clearing";
    } else if (isClearing && warmthIdle === 0) {
      warmthStage = "freeSample";
      clearedTick = tick;
      warmthHpAfter = player.hp;
    } else if (isFreeSample) {
      freeSteps.push(r(Math.abs(player.x - xBefore)));
      if (freeSteps.length === 3) warmthStage = "done";
    }

    for (const event of events) {
      const trace = relevantEvent(tick, event, boss);
      if (trace !== null) eventTrace.push(trace);
      if (event.t === "enemyKill" && event.kind === "pale") {
        bossKillEvents++;
        deathTick = tick;
      }
      if (event.t === "bossPhase" && event.eid === boss.id) bossPhaseEvents++;
      if (event.t === "bossTransition" && event.eid === boss.id) bossTransitionEvents++;
      if (event.t === "chargeCrash") peelEvents++;
    }

    debrisMax = Math.max(
      debrisMax,
      world.props.filter((prop) => !prop.dead && prop.kind === "pale_debris").length,
    );
    stateTrace.push(JSON.stringify({
      tick,
      boss: {
        hp: r(boss.hp),
        isDead: boss.dead,
        phase: boss.boss?.phase ?? 0,
        isExposed,
        move: boss.attack.move,
        attackPhase: boss.attack.phase,
        attackTime: r(boss.attack.time),
        cooldown: r(boss.attack.cooldown),
        burstParity: boss.boss?.burstParity ?? 0,
      },
      seams: world.enemies
        .filter((enemy) => !enemy.dead && enemy.kind === "pale_seam")
        .map((enemy) => ({ id: enemy.id, hp: r(enemy.hp), x: r(enemy.x), y: r(enemy.y) })),
      debris: world.props
        .filter((prop) => !prop.dead && prop.kind === "pale_debris")
        .map((prop) => ({ id: prop.id, hp: r(prop.hp), x: r(prop.x), y: r(prop.y) })),
      warmth: {
        isActive: world.warmthDrain !== null,
        idle: r(warmthIdle),
        playerX: r(player.x),
        playerY: r(player.y),
        playerHp: r(player.hp),
      },
      enemyBullets: world.bullets
        .filter((bullet) => !bullet.friendly)
        .map((bullet) => ({
          x: r(bullet.x),
          y: r(bullet.y),
          vx: r(bullet.vx),
          vy: r(bullet.vy),
          life: r(bullet.life),
        })),
      chests: world.chests.length,
    }));

    if (deathTick >= 0 && tick >= deathTick + 30) {
      finalTick = tick + 1;
      break;
    }
  }

  const chilledPerTick = r(chilledSteps.reduce((sum, step) => sum + step, 0) / chilledSteps.length);
  const freePerTick = r(freeSteps.reduce((sum, step) => sum + step, 0) / freeSteps.length);
  const stateBytes = stateTrace.join("\n");
  const eventBytes = eventTrace.join("\n");
  const sweepBytes = sweepEmissions.map((emission) => JSON.stringify(emission)).join("\n");
  return {
    golden: {
      schema: 1,
      seed: SEED,
      floor: PALE_FLOOR,
      playerCount: world.players.size,
      ticks: finalTick,
      spawn,
      phaseAt: [...PALE.phaseAt],
      phaseFloor: [...PALE.phaseFloor],
      phaseEntries,
      earnedWindowsByPhase,
      peelEvents,
      debrisMax,
      dualSweep: {
        windupTick: sweepWindupTick,
        recoverTick: sweepRecoverTick,
        emissions: sweepEmissions.length,
        bulletsPerEmission: sweepEmissions.map((emission) => emission.count),
        hash: hash(sweepBytes),
      },
      warmth: {
        activeTick: warmthActiveTick,
        chilledTick,
        clearedTick,
        chilledPerTick,
        freePerTick,
        speedRatio: r(chilledPerTick / freePerTick),
        hpBefore: r(warmthHpBefore),
        hpAfter: r(warmthHpAfter),
      },
      completion: {
        deathTick,
        bossKillEvents,
        bossPhaseEvents,
        bossTransitionEvents,
        chestCount: world.chests.length,
        isBossDead: boss.dead,
      },
      stateHash: hash(stateBytes),
      eventHash: hash(eventBytes),
    },
    stateBytes,
    eventBytes,
  };
}

function assertCoverage(golden: PaleGolden): void {
  if (golden.seed !== SEED || golden.floor !== 75 || golden.playerCount !== 1) {
    throw new Error("Pale golden must remain the deterministic F75 one-player baseline");
  }
  if (golden.spawn.count !== 1 || golden.spawn.kind !== "pale" || golden.spawn.maxHp !== 1220) {
    throw new Error("Pale golden did not naturally spawn the canonical 1220 HP boss");
  }
  if (golden.phaseEntries.map((entry) => entry.phase).join(",") !== "1,2,3") {
    throw new Error(`Pale golden missed shell progression: ${JSON.stringify({
      phaseEntries: golden.phaseEntries,
      earnedWindowsByPhase: golden.earnedWindowsByPhase,
      completion: golden.completion,
      ticks: golden.ticks,
    })}`);
  }
  for (let index = 1; index < golden.phaseEntries.length; index++) {
    const entry = golden.phaseEntries[index];
    const threshold = golden.spawn.maxHp * golden.phaseAt[index - 1];
    const floor = golden.spawn.maxHp * golden.phaseFloor[index - 1];
    if (entry.hp > threshold + 1 || entry.hp < floor - 1) {
      throw new Error(`Pale phase ${entry.phase} entered outside its threshold/floor band: hp=${entry.hp}`);
    }
  }
  if (golden.earnedWindowsByPhase.some((count) => count < 4) || golden.peelEvents < 3 || golden.debrisMax < 1) {
    throw new Error("Pale golden did not exercise the earned shell-peel windows and reveal debris");
  }
  const expectedSweepBullets = (PALE.spokeCount - PALE.spokeGap)
    + (PALE.spokeCount - (PALE.spoke2Gap ?? PALE.spokeGap));
  if (
    golden.dualSweep.windupTick < 0
    || golden.dualSweep.recoverTick <= golden.dualSweep.windupTick
    || golden.dualSweep.emissions < 2
    || golden.dualSweep.bulletsPerEmission.some((count) => count !== expectedSweepBullets)
  ) {
    throw new Error(`Pale golden did not exercise the full dual-sweep sequence: ${JSON.stringify(golden.dualSweep)}`);
  }
  if (
    golden.warmth.activeTick < 0
    || golden.warmth.chilledTick < golden.warmth.activeTick
    || golden.warmth.clearedTick <= golden.warmth.chilledTick
    || Math.abs(golden.warmth.speedRatio - PALE.warmthDrainSlow) > 0.08
    || golden.warmth.hpBefore !== golden.warmth.hpAfter
  ) {
    throw new Error(`Pale golden did not exercise warmth-drain and its movement counter: ${JSON.stringify(golden.warmth)}`);
  }
  if (
    !golden.completion.isBossDead
    || golden.completion.deathTick < 0
    || golden.completion.bossKillEvents !== 1
    || golden.completion.bossPhaseEvents < 2
    || golden.completion.bossTransitionEvents < 4
  ) {
    throw new Error(`Pale golden did not complete the authoritative boss arc: ${JSON.stringify(golden.completion)}`);
  }
}

function main(): void {
  const first = runScenario();
  const second = runScenario();
  assertCoverage(first.golden);
  if (
    JSON.stringify(first.golden) !== JSON.stringify(second.golden)
    || first.stateBytes !== second.stateBytes
    || first.eventBytes !== second.eventBytes
  ) {
    throw new Error("Pale authoritative scenario is not byte-identical across repeat runs");
  }

  if (process.argv.includes("--capture-current")) {
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(first.golden, null, 2)}\n`);
    process.stdout.write(`captured Pale authoritative golden: ${first.golden.ticks} ticks\n`);
    return;
  }

  const expected = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as PaleGolden;
  if (JSON.stringify(first.golden) !== JSON.stringify(expected)) {
    throw new Error(
      `Pale authoritative golden drifted\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(first.golden)}`,
    );
  }
  process.stdout.write(
    `PASS Pale authoritative golden: ${first.golden.ticks} ticks, state=${first.golden.stateHash}, events=${first.golden.eventHash}, byte-identical\n`,
  );
}

main();
