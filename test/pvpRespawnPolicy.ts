import {
  createWorld,
  spawnPlayerInWorld,
  stepWorld,
} from "../src/sim/world.js";
import type { PlayerSim, WorldState } from "../src/sim/world.js";
import { PVP } from "../src/sim/pvp.js";
import { TILE } from "../src/sim/types.js";
import type { InputCmd } from "../src/sim/input.js";

const DT = 1 / 20;
const MAX_SECONDS = 150;

export interface RespawnPolicyEpisode {
  seed: number;
  spawnTick: number;
  isInitialSpawn: boolean;
  firstDamageSec: number | null;
  deathSec: number | null;
  isDashedBeforeDamage: boolean;
  aimTurnDegBeforeDamage: number;
  tilesMovedBeforeDamage: number;
  isFiredBeforeDeath: boolean;
}

export interface RespawnPolicySeedReport {
  seed: number;
  episodes: RespawnPolicyEpisode[];
  botFrags: number;
  victimFrags: number;
  respawnOnlyFragTimesSec: number[];
  maxRespawnOnlyFragsPer20Sec: number;
  timeToEightSec: number | null;
}

export interface RespawnPolicyAggregate {
  seedCount: number;
  episodeCount: number;
  postRespawnEpisodeCount: number;
  damagedEpisodeCount: number;
  deathEpisodeCount: number;
  spawnToFirstDamageP10Sec: number;
  spawnToFirstDamageMedianSec: number;
  spawnToDeathP10Sec: number;
  spawnToDeathMedianSec: number;
  maxRespawnOnlyFragsPer20Sec: number;
  timeToEightReachedCount: number;
  timeToEightMinSec: number | null;
  controlEstablishedRate: number;
}

export interface RespawnPolicyReport {
  policy: string;
  seeds: RespawnPolicySeedReport[];
  aggregate: RespawnPolicyAggregate;
}

interface ActiveEpisode {
  metric: RespawnPolicyEpisode;
  spawnX: number;
  spawnY: number;
  initialAim: number;
  hp: number;
  shotSeq: number;
}

function idle(aim = 0): InputCmd {
  return { seq: 0, moveX: 0, moveY: 0, aim, firing: false, dash: false };
}

function clearProtection(player: PlayerSim): void {
  player.invuln = 0;
  player.spawnGraceT = 0;
  player.spawnShieldT = 0;
}

function advanceToLive(world: WorldState): void {
  let guard = 0;
  while (world.match?.phase !== "live" && guard++ < 200) stepWorld(world, new Map(), DT);
}

function normalized(dx: number, dy: number): [number, number] {
  const magnitude = Math.hypot(dx, dy) || 1;
  return [dx / magnitude, dy / magnitude];
}

function angularDistance(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

function botInput(world: WorldState, bot: PlayerSim, victim: PlayerSim, seed: number): InputCmd {
  if (bot.hp <= 0 || bot.respawnT > 0) return idle(bot.aimAngle);
  const dx = victim.x - bot.x;
  const dy = victim.y - bot.y;
  const distance = Math.hypot(dx, dy);
  const [towardX, towardY] = normalized(dx, dy);
  const strafeSign = ((world.tick + seed) % 160) < 80 ? 1 : -1;
  const strafeWeight = distance < 260 ? 0.55 : 0.2;
  const moveX = towardX - towardY * strafeSign * strafeWeight;
  const moveY = towardY + towardX * strafeSign * strafeWeight;
  return {
    seq: 0,
    moveX,
    moveY,
    aim: Math.atan2(dy, dx),
    firing: victim.hp > 0 && victim.respawnT === 0,
    dash: bot.dashCd === 0 && distance > 260,
  };
}

function victimInput(
  world: WorldState,
  victim: PlayerSim,
  bot: PlayerSim,
  episode: ActiveEpisode | null,
): InputCmd {
  if (victim.hp <= 0 || victim.respawnT > 0) return idle(victim.aimAngle);
  const centerX = world.dungeon.spawn.x * TILE + TILE / 2;
  const centerY = world.dungeon.spawn.y * TILE + TILE / 2;
  if (victim.spawnShieldT > 0) {
    const [moveX, moveY] = normalized(centerX - victim.x, centerY - victim.y);
    return {
      seq: 0,
      moveX,
      moveY,
      aim: (episode?.initialAim ?? victim.aimAngle) + Math.PI / 2,
      firing: false,
      dash: victim.dashCd === 0,
    };
  }
  const botDx = bot.x - victim.x;
  const botDy = bot.y - victim.y;
  const centerDx = centerX - victim.x;
  const centerDy = centerY - victim.y;
  const [inwardX, inwardY] = normalized(centerDx, centerDy);
  const [awayX, awayY] = normalized(-botDx, -botDy);
  const orbitSign = world.tick % 180 < 90 ? 1 : -1;
  const moveX = inwardX * 0.35 + awayX * 0.35 - inwardY * orbitSign;
  const moveY = inwardY * 0.35 + awayY * 0.35 + inwardX * orbitSign;
  return {
    seq: 0,
    moveX,
    moveY,
    aim: Math.atan2(botDy, botDx),
    firing: bot.hp > 0 && bot.respawnT === 0,
    dash: victim.dashCd === 0 && Math.hypot(botDx, botDy) < 300,
  };
}

function openEpisode(seed: number, victim: PlayerSim, tick: number, isInitialSpawn: boolean): ActiveEpisode {
  return {
    metric: {
      seed,
      spawnTick: tick,
      isInitialSpawn,
      firstDamageSec: null,
      deathSec: null,
      isDashedBeforeDamage: false,
      aimTurnDegBeforeDamage: 0,
      tilesMovedBeforeDamage: 0,
      isFiredBeforeDeath: false,
    },
    spawnX: victim.x,
    spawnY: victim.y,
    initialAim: victim.aimAngle,
    hp: victim.hp,
    shotSeq: victim.shotSeq,
  };
}

function maxEventsInWindow(times: readonly number[], windowSec: number): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end++) {
    while (times[end] - times[start] > windowSec) start++;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

export function runRespawnPolicySeed(seed: number): RespawnPolicySeedReport {
  const world = createWorld(seed, 1, {
    mode: "pvp",
    isShared: true,
    skipLocalPlayer: true,
  });
  spawnPlayerInWorld(world, "bot");
  spawnPlayerInWorld(world, "victim");
  advanceToLive(world);
  const bot = world.players.get("bot")!;
  const victim = world.players.get("victim")!;
  bot.weapon = "rapid";
  bot.ownedWeapons = ["rapid"];
  victim.weapon = "pistol";
  victim.ownedWeapons = ["pistol"];
  const liveStartTick = world.tick;
  let active = openEpisode(seed, victim, world.tick, true);
  const episodes: RespawnPolicyEpisode[] = [];
  const respawnOnlyFragTimesSec: number[] = [];
  let previousRespawnT = victim.respawnT;
  let timeToEightSec: number | null = null;

  for (let i = 0; i < MAX_SECONDS / DT; i++) {
    const inputs = new Map<string, InputCmd>([
      [bot.id, botInput(world, bot, victim, seed)],
      [victim.id, victimInput(world, victim, bot, active)],
    ]);
    stepWorld(world, inputs, DT);
    const elapsedSec = (world.tick - liveStartTick) * DT;

    if (previousRespawnT > 0 && victim.respawnT === 0 && victim.hp > 0) {
      active = openEpisode(seed, victim, world.tick, false);
    }
    previousRespawnT = victim.respawnT;

    if (active !== null) {
      if (active.metric.firstDamageSec === null) {
        active.metric.isDashedBeforeDamage ||= victim.dashTime > 0;
        active.metric.aimTurnDegBeforeDamage = Math.max(
          active.metric.aimTurnDegBeforeDamage,
          angularDistance(victim.aimAngle, active.initialAim) * 180 / Math.PI,
        );
        active.metric.tilesMovedBeforeDamage = Math.max(
          active.metric.tilesMovedBeforeDamage,
          Math.hypot(victim.x - active.spawnX, victim.y - active.spawnY) / TILE,
        );
      }
      if (victim.shotSeq > active.shotSeq) {
        active.metric.isFiredBeforeDeath = true;
        active.shotSeq = victim.shotSeq;
      }
      if (victim.hp < active.hp && active.metric.firstDamageSec === null) {
        active.metric.firstDamageSec = (world.tick - active.metric.spawnTick) * DT;
      }
      active.hp = victim.hp;
      if (victim.respawnT > 0) {
        active.metric.deathSec = (world.tick - active.metric.spawnTick) * DT;
        if (!active.metric.isFiredBeforeDeath) respawnOnlyFragTimesSec.push(elapsedSec);
        episodes.push(active.metric);
        active = null;
      }
    }

    if ((world.match?.scores.get(bot.id) ?? 0) >= 8) {
      timeToEightSec = elapsedSec;
      break;
    }
    if (world.match?.phase === "over") break;
  }

  return {
    seed,
    episodes,
    botFrags: world.match?.scores.get(bot.id) ?? 0,
    victimFrags: world.match?.scores.get(victim.id) ?? 0,
    respawnOnlyFragTimesSec,
    maxRespawnOnlyFragsPer20Sec: maxEventsInWindow(respawnOnlyFragTimesSec, 20),
    timeToEightSec,
  };
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.floor((sorted.length - 1) * percentileValue);
  return sorted[index];
}

export function runRespawnPolicyReport(seedCount = 20): RespawnPolicyReport {
  const seeds = Array.from({ length: seedCount }, (_, index) =>
    runRespawnPolicySeed(0x5eed0000 + index)
  );
  const episodes = seeds.flatMap((seed) => seed.episodes);
  const postRespawns = episodes.filter((episode) => !episode.isInitialSpawn);
  const firstDamage = episodes.flatMap((episode) =>
    episode.firstDamageSec === null ? [] : [episode.firstDamageSec]
  );
  const deaths = episodes.flatMap((episode) =>
    episode.deathSec === null ? [] : [episode.deathSec]
  );
  const timeToEight = seeds.flatMap((seed) =>
    seed.timeToEightSec === null ? [] : [seed.timeToEightSec]
  );
  const established = episodes.filter((episode) =>
    episode.isDashedBeforeDamage
    && episode.aimTurnDegBeforeDamage >= 90
    && episode.tilesMovedBeforeDamage >= 2
  ).length;
  return {
    policy: "Victim holds fire through shield, dashes inward, turns aim 90°, then circles cover and returns fire; rapid bot chases, strafes, dashes, and continuously tracks fire.",
    seeds,
    aggregate: {
      seedCount,
      episodeCount: episodes.length,
      postRespawnEpisodeCount: postRespawns.length,
      damagedEpisodeCount: firstDamage.length,
      deathEpisodeCount: deaths.length,
      spawnToFirstDamageP10Sec: percentile(firstDamage, 0.1),
      spawnToFirstDamageMedianSec: percentile(firstDamage, 0.5),
      spawnToDeathP10Sec: percentile(deaths, 0.1),
      spawnToDeathMedianSec: percentile(deaths, 0.5),
      maxRespawnOnlyFragsPer20Sec: Math.max(...seeds.map((seed) => seed.maxRespawnOnlyFragsPer20Sec)),
      timeToEightReachedCount: timeToEight.length,
      timeToEightMinSec: timeToEight.length > 0 ? Math.min(...timeToEight) : null,
      controlEstablishedRate: episodes.length > 0 ? established / episodes.length : 0,
    },
  };
}
