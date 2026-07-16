export const RUN_RECEIPT_VERSION = 1;
export const RUN_RECEIPT_PREFIX = "r1";
export const RUN_RECEIPT_TTL_MS = 10 * 60_000;

export type RunCompletionStatus = "completed" | "abandoned" | "server_restart";

export interface RunReceiptItem {
  id: string;
  count: number;
}

export interface RunReceiptParticipant {
  playerId: string;
  floor: number;
  kills: number;
  coins: number;
  floorsCleared: number;
  bossKills: string[];
  isCacheArmed: boolean;
  amberWindfall: number;
  durationMs: number;
  weapons: string[];
  items: RunReceiptItem[];
}

export interface RunCompletionPayload {
  version: number;
  jti: string;
  runId: string;
  worldId: string;
  roomCode: string;
  generation: number;
  status: RunCompletionStatus;
  issuedAt: number;
  expiresAt: number;
  isNoActiveSeat: boolean;
  participants: RunReceiptParticipant[];
}

export interface GenerationWorld {
  roomCode: string;
  generation: number;
  isPvp: boolean;
}

export function parseGenerationWorldId(worldId: string): GenerationWorld | null {
  const match = /^(pvp:)?room:([A-Z2-9]+):g([1-9]\d*)$/.exec(worldId);
  if (!match) return null;
  const generation = Number(match[3]);
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  return {
    roomCode: match[2],
    generation,
    isPvp: match[1] !== undefined,
  };
}

export function isRunCompletionPayload(payload: RunCompletionPayload): boolean {
  const world = parseGenerationWorldId(payload.worldId);
  if (!world || world.isPvp) return false;
  if (payload.version !== RUN_RECEIPT_VERSION) return false;
  if (!/^[a-f0-9]{32,64}$/.test(payload.jti)) return false;
  if (payload.runId.length < 1 || payload.runId.length > 160) return false;
  if (!payload.runId.startsWith(`${payload.worldId}:`)) return false;
  if (payload.roomCode !== world.roomCode || payload.generation !== world.generation) return false;
  if (!["completed", "abandoned", "server_restart"].includes(payload.status)) return false;
  if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)) return false;
  if (payload.expiresAt <= payload.issuedAt || payload.isNoActiveSeat !== true) return false;
  if (!Array.isArray(payload.participants) || payload.participants.length > 6) return false;
  if (payload.status === "completed" && payload.participants.length === 0) return false;
  if (payload.status !== "completed" && payload.participants.length > 0) return false;
  const playerIds = new Set<string>();
  return payload.participants.every((participant) => {
    if (playerIds.has(participant.playerId)) return false;
    playerIds.add(participant.playerId);
    return typeof participant.playerId === "string"
    && participant.playerId.length > 0
    && participant.playerId.length <= 64
    && Number.isSafeInteger(participant.floor)
    && participant.floor >= 1
    && participant.floor <= 10_000
    && Number.isSafeInteger(participant.kills)
    && participant.kills >= 0
    && participant.kills <= 10_000_000
    && Number.isSafeInteger(participant.coins)
    && participant.coins >= 0
    && participant.coins <= 10_000_000
    && Number.isSafeInteger(participant.floorsCleared)
    && participant.floorsCleared >= 0
    && participant.floorsCleared <= participant.floor
    && Array.isArray(participant.bossKills)
    && participant.bossKills.length <= 32
    && participant.bossKills.every((boss) => typeof boss === "string" && boss.length <= 32)
    && typeof participant.isCacheArmed === "boolean"
    && Number.isSafeInteger(participant.amberWindfall)
    && participant.amberWindfall >= 0
    && participant.amberWindfall <= 10_000
    && Number.isSafeInteger(participant.durationMs)
    && participant.durationMs >= 0
    && participant.durationMs <= 24 * 60 * 60_000
    && Array.isArray(participant.weapons)
    && participant.weapons.length <= 12
    && participant.weapons.every((weapon) => typeof weapon === "string" && weapon.length <= 32)
    && Array.isArray(participant.items)
    && participant.items.length <= 64
    && participant.items.every((item) => (
      typeof item.id === "string"
      && item.id.length <= 32
      && Number.isSafeInteger(item.count)
      && item.count >= 1
      && item.count <= 100
    ));
  });
}
