import { FIXED_DT, type MatchWire } from "../net/protocol.js";
import type { PlayerId } from "../sim/input.js";
import { pvpSpawnHardGraceTicks, pvpSpawnShieldTicks } from "../sim/pvp.js";
import type { MatchPhase } from "../sim/pvp.js";

export interface ArenaScoreRow {
  id: PlayerId;
  name: string;
  frags: number;
  isAlive: boolean;
  isSelf: boolean;
  isLeader: boolean;
}

export interface ArenaMatchHudState {
  phase: MatchPhase;
  scores: ArenaScoreRow[];
  secondsLeft: number;
  selfFrags: number;
  isSelfWinner: boolean | null;
  respawnSeconds: number;
  spawnProtection: "grace" | "shield" | null;
  spawnProtectionFill: number;
  isSpawnProtectionFinalPulse: boolean;
}

export interface ArenaMatchHudSource {
  match: MatchWire;
  tick: number;
  selfId: PlayerId | null;
  respawnTicks: number;
  spawnProtectionStartedTick: number;
  spawnHardGraceEndsAtTick: number;
  spawnShieldEndsAtTick: number;
  nameOf: (id: PlayerId, isSelf: boolean) => string;
}

export interface ArenaCenterCopy {
  title: string;
  detail: string | null;
  tone: "countdown" | "victory" | "defeat" | "result" | "respawn" | "spawn-safe" | "spawn-shield";
}

export interface ArenaHpView {
  fill: number;
  text: string;
}

export function ticksLeftSeconds(args: { endTick: number; tick: number }): number {
  return Math.max(0, Math.ceil((args.endTick - args.tick) * FIXED_DT));
}

export function pvpMaterializeFraction(args: {
  startedTick: number;
  tick: number;
  shieldEndsAtTick: number;
}): number {
  if (args.startedTick <= 0 || args.shieldEndsAtTick <= args.tick) return 1;
  return Math.max(0, Math.min(1, (args.tick - args.startedTick) / 5));
}

export function buildArenaMatchHud(source: ArenaMatchHudSource): ArenaMatchHudState {
  const leaderId = source.match.sc
    .slice()
    .sort((a, b) => b.f - a.f || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]?.id ?? null;
  const scores = source.match.sc
    .map((score): ArenaScoreRow => {
      const isSelf = source.selfId !== null && score.id === source.selfId;
      return {
        id: score.id,
        name: source.nameOf(score.id, isSelf),
        frags: score.f,
        isAlive: score.a,
        isSelf,
        isLeader: score.id === leaderId,
      };
    })
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const selfScore = scores.find((score) => score.isSelf);
  const isTimed = source.match.ph === "countdown" || source.match.ph === "live";
  const isResultKnown = source.match.ph === "over"
    && source.selfId !== null
    && source.match.win !== null;
  const spawnGraceTicks = Math.max(0, source.spawnHardGraceEndsAtTick - source.tick);
  const spawnShieldTicks = Math.max(0, source.spawnShieldEndsAtTick - source.tick);
  const spawnProtection = source.match.ph !== "live"
    ? null
    : spawnGraceTicks > 0
      ? "grace"
      : spawnShieldTicks > 0
        ? "shield"
        : null;
  const protectionTicks = spawnProtection === "grace"
    ? spawnGraceTicks
    : spawnProtection === "shield"
      ? spawnShieldTicks
      : 0;

  return {
    phase: source.match.ph,
    scores,
    secondsLeft: isTimed
      ? ticksLeftSeconds({ endTick: source.match.end, tick: source.tick })
      : 0,
    selfFrags: selfScore?.frags ?? 0,
    isSelfWinner: isResultKnown ? source.match.win === source.selfId : null,
    respawnSeconds: source.match.ph === "live"
      ? Math.max(0, Math.ceil(source.respawnTicks * FIXED_DT))
      : 0,
    spawnProtection,
    spawnProtectionFill: spawnProtection === "grace"
      ? Math.max(0, Math.min(1, protectionTicks / pvpSpawnHardGraceTicks()))
      : spawnProtection === "shield"
        ? Math.max(0, Math.min(1, protectionTicks / pvpSpawnShieldTicks()))
        : 0,
    isSpawnProtectionFinalPulse: spawnProtection !== null && protectionTicks <= Math.round(0.5 / FIXED_DT),
  };
}

export function formatArenaClock(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

export function arenaLaneCopy(match: ArenaMatchHudState | null): string {
  if (match === null) return "ARENA \u00b7 CONNECTING";
  if (match.phase === "lobby") return "ARENA \u00b7 WAITING FOR PLAYERS";
  if (match.phase === "countdown") return "ARENA \u00b7 MATCH STARTING";
  if (match.phase === "over") return "ARENA \u00b7 MATCH OVER";
  const fragLabel = match.selfFrags === 1 ? "FRAG" : "FRAGS";
  return `ARENA \u00b7 ${formatArenaClock(match.secondsLeft)} \u00b7 ${match.selfFrags} ${fragLabel}`;
}

export function arenaCenterCopy(match: ArenaMatchHudState | null): ArenaCenterCopy | null {
  if (match === null) return null;
  if (match.phase === "countdown") {
    return {
      title: String(Math.max(1, match.secondsLeft)),
      detail: "GET READY",
      tone: "countdown",
    };
  }
  if (match.phase === "over") {
    if (match.isSelfWinner === true) return { title: "VICTORY", detail: null, tone: "victory" };
    if (match.isSelfWinner === false) return { title: "DEFEAT", detail: null, tone: "defeat" };
    return { title: "MATCH OVER", detail: null, tone: "result" };
  }
  if (match.respawnSeconds > 0) {
    return {
      title: "YOU WERE FRAGGED",
      detail: `RESPAWNING IN ${match.respawnSeconds}`,
      tone: "respawn",
    };
  }
  if (match.spawnProtection === "grace") {
    return {
      title: "SPAWN SAFE",
      detail: "MOVE \u00b7 AIM \u00b7 DASH  |  WEAPON ARMING",
      tone: "spawn-safe",
    };
  }
  if (match.spawnProtection === "shield") {
    return {
      title: "SPAWN SHIELD \u00b7 FIRE TO ENGAGE",
      detail: null,
      tone: "spawn-shield",
    };
  }
  return null;
}

export function arenaHpView(args: { hp: number; maxHp: number }): ArenaHpView {
  const maxHp = Math.max(0, args.maxHp);
  const hp = Math.max(0, Math.min(maxHp, args.hp));
  return {
    fill: maxHp > 0 ? hp / maxHp : 0,
    text: `${Math.ceil(hp)}/${Math.ceil(maxHp)}`,
  };
}
