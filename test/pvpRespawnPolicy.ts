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

export type RespawnBotProfile = "conformanceBot" | "playtestBot";

export interface RespawnPolicyEpisode {
  seed: number;
  spawnTick: number;
  isInitialSpawn: boolean;
  threatFlags: number;
  chosenIndex: number;
  safeCount: number;
  waitSafeMs: number;
  timeToFirstInputMs: number | null;
  shieldBreakMs: number | null;
  firstDamageMs: number | null;
  firstDamageSec: number | null;
  deathSec: number | null;
  isShieldBrokenByAttack: boolean;
  isDeathWithin3s: boolean;
  isRepeatedIndex: boolean;
  killerDistance: number | null;
  isDashedBeforeDamage: boolean;
  aimTurnDegBeforeDamage: number;
  tilesMovedBeforeDamage: number;
  isFiredBeforeDeath: boolean;
}

export interface RespawnPolicySeedReport {
  seed: number;
  profile: RespawnBotProfile;
  episodes: RespawnPolicyEpisode[];
  botFrags: number;
  victimFrags: number;
  respawnOnlyFragTimesSec: number[];
  maxRespawnOnlyFragsPer20Sec: number;
  timeToEightSec: number | null;
  shieldFireAttempts: number;
  reactionMs: number[];
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
  waitSafeRespawnCount: number;
  threatenedSpawnCount: number;
  repeatedSpawnCount: number;
  shieldFireAttempts: number;
  playtestReactionMinMs: number | null;
  playtestReactionMaxMs: number | null;
  intentionalFireWithin500msRate: number;
  armingFeedbackCoverageRate: number;
  heldFireAutoFireCount: number;
}

export interface RespawnPolicyReport {
  profile: RespawnBotProfile;
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

interface PlaytestBotState {
  aim: number;
  observedSpawnTick: number;
  shieldEndedTick: number | null;
}

function idle(aim = 0): InputCmd {
  return { seq: 0, moveX: 0, moveY: 0, aim, firing: false, dash: false };
}

function clearProtection(player: PlayerSim): void {
  player.invuln = 0;
  player.spawnGraceT = 0;
  player.spawnShieldT = 0;
  player.spawnProtectionStartedTick = 0;
  player.spawnHardGraceEndsAtTick = 0;
  player.spawnShieldEndsAtTick = 0;
  player.isSpawnOffenseLatched = false;
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

function conformanceBotInput(world: WorldState, bot: PlayerSim, victim: PlayerSim, seed: number): InputCmd {
  if (bot.hp <= 0 || bot.respawnT > 0) return idle(bot.aimAngle);
  const dx = victim.x - bot.x;
  const dy = victim.y - bot.y;
  const distance = Math.hypot(dx, dy);
  const [towardX, towardY] = normalized(dx, dy);
  const strafeSign = ((world.tick + seed) % 160) < 80 ? 1 : -1;
  const strafeWeight = distance < 260 ? 0.55 : 0.2;
  const moveX = towardX - towardY * strafeSign * strafeWeight;
  const moveY = towardY + towardX * strafeSign * strafeWeight;
  const command: InputCmd = {
    seq: 0,
    moveX,
    moveY,
    aim: Math.atan2(dy, dx),
    firing: victim.hp > 0 && victim.respawnT === 0,
    dash: bot.dashCd === 0 && distance > 260,
  };
  return bot.spawnGraceT === 0 && bot.isSpawnOffenseLatched
    ? { ...command, firing: false }
    : command;
}

function createPlaytestBotState(bot: PlayerSim): PlaytestBotState {
  return {
    aim: bot.aimAngle,
    observedSpawnTick: -1,
    shieldEndedTick: null,
  };
}

function stepAim(current: number, target: number, maxTurn: number): number {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + Math.max(-maxTurn, Math.min(maxTurn, delta));
}

function playtestBotInput(
  world: WorldState,
  bot: PlayerSim,
  victim: PlayerSim,
  seed: number,
  state: PlaytestBotState,
): InputCmd {
  if (bot.hp <= 0 || bot.respawnT > 0) return idle(state.aim);
  if (bot.spawnGraceT > 0 || bot.isSpawnOffenseLatched) return idle(state.aim);
  const spawnTick = victim.pvpRespawnTelemetry?.spawnTick ?? -1;
  if (spawnTick !== state.observedSpawnTick) {
    state.observedSpawnTick = spawnTick;
    state.shieldEndedTick = null;
  }
  if (victim.hp <= 0 || victim.respawnT > 0 || victim.spawnShieldT > 0) {
    return idle(state.aim);
  }
  if (state.shieldEndedTick === null) state.shieldEndedTick = world.tick;
  const reactionTicks = 4 + ((seed ^ Math.max(0, spawnTick)) >>> 0) % 3;
  const reactedTicks = world.tick - state.shieldEndedTick;
  if (reactedTicks < reactionTicks) return idle(state.aim);
  const dx = victim.x - bot.x;
  const dy = victim.y - bot.y;
  const distance = Math.hypot(dx, dy);
  const aimError = Math.sin((world.tick + seed) * 0.17) * (Math.PI / 45);
  state.aim = stepAim(state.aim, Math.atan2(dy, dx) + aimError, Math.PI / 18);
  const [towardX, towardY] = normalized(dx, dy);
  const strafe = ((world.tick + seed) % 120) < 60 ? 0.35 : -0.35;
  const cadenceTick = reactedTicks - reactionTicks;
  return {
    seq: 0,
    moveX: towardX - towardY * strafe,
    moveY: towardY + towardX * strafe,
    aim: state.aim,
    firing: cadenceTick % 9 < 5,
    dash: bot.dashCd === 0 && distance > 360 && cadenceTick % 20 === 0,
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

function openEpisode(
  world: WorldState,
  seed: number,
  victim: PlayerSim,
  tick: number,
  isInitialSpawn: boolean,
): ActiveEpisode {
  const telemetry = victim.pvpRespawnTelemetry;
  const chosenIndex = telemetry?.chosenIndex
    ?? (world.match?.spawns.findIndex((spawn) => spawn.x === victim.x && spawn.y === victim.y) ?? -1);
  return {
    metric: {
      seed,
      spawnTick: tick,
      isInitialSpawn,
      threatFlags: telemetry?.threatFlags ?? 0,
      chosenIndex,
      safeCount: telemetry?.safeCount ?? 0,
      waitSafeMs: telemetry?.waitSafeMs ?? 0,
      timeToFirstInputMs: telemetry?.timeToFirstInputMs ?? null,
      shieldBreakMs: telemetry?.shieldBreakMs ?? null,
      firstDamageMs: telemetry?.firstDamageMs ?? null,
      firstDamageSec: null,
      deathSec: null,
      isShieldBrokenByAttack: telemetry?.isShieldBrokenByAttack ?? false,
      isDeathWithin3s: telemetry?.isDeathWithin3s ?? false,
      isRepeatedIndex: telemetry?.isRepeatedIndex ?? false,
      killerDistance: telemetry?.killerDistance ?? null,
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

function syncEpisodeTelemetry(active: ActiveEpisode, victim: PlayerSim): void {
  const telemetry = victim.pvpRespawnTelemetry;
  if (telemetry === null || telemetry.spawnTick !== active.metric.spawnTick) return;
  active.metric.threatFlags = telemetry.threatFlags;
  active.metric.chosenIndex = telemetry.chosenIndex;
  active.metric.safeCount = telemetry.safeCount;
  active.metric.waitSafeMs = telemetry.waitSafeMs;
  active.metric.timeToFirstInputMs = telemetry.timeToFirstInputMs;
  active.metric.shieldBreakMs = telemetry.shieldBreakMs;
  active.metric.firstDamageMs = telemetry.firstDamageMs;
  active.metric.isShieldBrokenByAttack = telemetry.isShieldBrokenByAttack;
  active.metric.isDeathWithin3s = telemetry.isDeathWithin3s;
  active.metric.isRepeatedIndex = telemetry.isRepeatedIndex;
  active.metric.killerDistance = telemetry.killerDistance;
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

export function runRespawnPolicySeed(
  seed: number,
  profile: RespawnBotProfile = "conformanceBot",
): RespawnPolicySeedReport {
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
  bot.weapon = profile === "conformanceBot" ? "rapid" : "pistol";
  bot.ownedWeapons = [bot.weapon];
  victim.weapon = "pistol";
  victim.ownedWeapons = ["pistol"];
  const liveStartTick = world.tick;
  let active = openEpisode(world, seed, victim, world.tick, true);
  const episodes: RespawnPolicyEpisode[] = [];
  const respawnOnlyFragTimesSec: number[] = [];
  let previousRespawnT = victim.respawnT;
  let timeToEightSec: number | null = null;
  let shieldFireAttempts = 0;
  const playtestState = createPlaytestBotState(bot);
  const reactionMs: number[] = [];
  let previousVictimShieldT = victim.spawnShieldT;
  let shieldEndedTick: number | null = null;

  for (let i = 0; i < MAX_SECONDS / DT; i++) {
    const botCommand = profile === "conformanceBot"
      ? conformanceBotInput(world, bot, victim, seed)
      : playtestBotInput(world, bot, victim, seed, playtestState);
    if (botCommand.firing && victim.spawnShieldT > 0) shieldFireAttempts++;
    const inputs = new Map<string, InputCmd>([
      [bot.id, botCommand],
      [victim.id, victimInput(world, victim, bot, active)],
    ]);
    const events = stepWorld(world, inputs, DT);
    const elapsedSec = (world.tick - liveStartTick) * DT;
    if (previousVictimShieldT > 0 && victim.spawnShieldT === 0 && victim.hp > 0) {
      shieldEndedTick = world.tick;
    }
    if (profile === "playtestBot" && shieldEndedTick !== null
      && events.some((event) => event.t === "shot" && event.pid === bot.id)) {
      reactionMs.push((world.tick - shieldEndedTick) * 1000 * DT);
      shieldEndedTick = null;
    }
    if (victim.hp <= 0) shieldEndedTick = null;
    previousVictimShieldT = victim.spawnShieldT;

    if (previousRespawnT > 0 && victim.respawnT === 0 && victim.hp > 0) {
      active = openEpisode(world, seed, victim, world.tick, false);
    }
    previousRespawnT = victim.respawnT;

    if (active !== null) {
      syncEpisodeTelemetry(active, victim);
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
        syncEpisodeTelemetry(active, victim);
        if (!active.metric.isFiredBeforeDeath && active.metric.killerDistance !== null) {
          respawnOnlyFragTimesSec.push(elapsedSec);
        }
        episodes.push(active.metric);
        active = null;
      }
    }

    if (Math.max(
      world.match?.scores.get(bot.id) ?? 0,
      world.match?.scores.get(victim.id) ?? 0,
    ) >= 8) {
      timeToEightSec = elapsedSec;
      break;
    }
    if (world.match?.phase === "over") break;
  }

  return {
    seed,
    profile,
    episodes,
    botFrags: world.match?.scores.get(bot.id) ?? 0,
    victimFrags: world.match?.scores.get(victim.id) ?? 0,
    respawnOnlyFragTimesSec,
    maxRespawnOnlyFragsPer20Sec: maxEventsInWindow(respawnOnlyFragTimesSec, 20),
    timeToEightSec,
    shieldFireAttempts,
    reactionMs,
  };
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.floor((sorted.length - 1) * percentileValue);
  return sorted[index];
}

function runArmingUxProbe(seedCount: number): {
  intentionalFireWithin500msRate: number;
  armingFeedbackCoverageRate: number;
  heldFireAutoFireCount: number;
} {
  let within500 = 0;
  let feedback = 0;
  let heldFireAutoFireCount = 0;
  for (let seed = 0; seed < seedCount; seed++) {
    const world = createWorld(0x61726d00 + seed, 1, {
      mode: "pvp",
      isShared: true,
      skipLocalPlayer: true,
    });
    spawnPlayerInWorld(world, "actor");
    spawnPlayerInWorld(world, "observer");
    advanceToLive(world);
    const actor = world.players.get("actor")!;
    const graceEndsAtTick = actor.spawnHardGraceEndsAtTick;
    const repressAtTick = graceEndsAtTick + 1 + seed % 8;
    let isReleaseSent = false;
    let isShotObserved = false;
    for (let guard = 0; guard < 50 && !isShotObserved; guard++) {
      let isFiring = true;
      if (actor.spawnGraceT === 0) {
        if (!isReleaseSent) {
          isFiring = false;
          isReleaseSent = true;
        } else {
          isFiring = world.tick + 1 >= repressAtTick;
        }
      }
      const events = stepWorld(world, new Map([
        [actor.id, {
          ...idle(actor.aimAngle),
          firing: isFiring,
        }],
      ]), DT);
      feedback += events.filter((event) => event.t === "pvpSpawnAttackBlocked").length;
      const isShot = events.some((event) => event.t === "shot" && event.pid === actor.id);
      if (isShot && (!isReleaseSent || world.tick < repressAtTick)) heldFireAutoFireCount++;
      if (isShot) {
        isShotObserved = true;
        if ((world.tick - graceEndsAtTick) * 1000 * DT <= 500) within500++;
      }
    }
  }
  return {
    intentionalFireWithin500msRate: seedCount > 0 ? within500 / seedCount : 0,
    armingFeedbackCoverageRate: seedCount > 0 ? Math.min(seedCount, feedback) / seedCount : 0,
    heldFireAutoFireCount,
  };
}

export function runRespawnPolicyReport(
  seedCount = 20,
  profile: RespawnBotProfile = "conformanceBot",
): RespawnPolicyReport {
  const seeds = Array.from({ length: seedCount }, (_, index) =>
    runRespawnPolicySeed(0x5eed0000 + index, profile)
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
  const reactionMs = seeds.flatMap((seed) => seed.reactionMs);
  const armingUx = runArmingUxProbe(seedCount);
  const established = episodes.filter((episode) =>
    episode.isDashedBeforeDamage
    && episode.aimTurnDegBeforeDamage >= 90
    && episode.tilesMovedBeforeDamage >= 2
  ).length;
  return {
    profile,
    policy: profile === "conformanceBot"
      ? "Conformance bot continuously tracks, strafes, dashes, and fires a Rapid; victim holds fire through shield, establishes control, then returns fire."
      : "Playtest bot waits 250–350ms after shield, turns with bounded aim error, never pre-aims pending spawns or fires into shields, and uses a human burst cadence.",
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
      waitSafeRespawnCount: episodes.filter((episode) => episode.waitSafeMs > 0).length,
      threatenedSpawnCount: episodes.filter((episode) => episode.threatFlags !== 0).length,
      repeatedSpawnCount: episodes.filter((episode) => episode.isRepeatedIndex).length,
      shieldFireAttempts: seeds.reduce((total, seed) => total + seed.shieldFireAttempts, 0),
      playtestReactionMinMs: reactionMs.length > 0 ? Math.min(...reactionMs) : null,
      playtestReactionMaxMs: reactionMs.length > 0 ? Math.max(...reactionMs) : null,
      ...armingUx,
    },
  };
}
