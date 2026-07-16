import { parseGenerationWorldId } from "./runReceipt.js";
import { validatePvpRoomPolicy, type PvpPolicyId } from "./pvpPolicy.js";

export const GENERATION_ADMISSION_VERSION = 2;
export const GENERATION_ADMISSION_PREFIX = "a2";
export const GENERATION_ADMISSION_TTL_MS = 5_000;

export interface GenerationAdmissionPayload {
  version: number;
  jti: string;
  playerId: string;
  worldId: string;
  roomCode: string;
  generation: number;
  mode: "coop" | "pvp";
  pvpPolicy: PvpPolicyId | null;
  kitId: string;
  petId: string | null;
  isPetChoiceMade: boolean;
  issuedAt: number;
  expiresAt: number;
}

export interface GenerationAdmissionDecision {
  isAllowed: boolean;
  code: string;
}

export function isGenerationAdmissionPayload(payload: GenerationAdmissionPayload): boolean {
  const world = parseGenerationWorldId(payload.worldId);
  return world !== null
    && payload.version === GENERATION_ADMISSION_VERSION
    && /^[a-f0-9]{32,64}$/.test(payload.jti)
    && payload.playerId.length > 0
    && payload.playerId.length <= 64
    && payload.roomCode === world.roomCode
    && payload.generation === world.generation
    && payload.mode === (world.isPvp ? "pvp" : "coop")
    && validatePvpRoomPolicy(payload.mode, false, payload.pvpPolicy) === null
    && /^[a-z0-9_]{1,24}$/.test(payload.kitId)
    && (payload.petId === null || /^[a-z0-9_]{1,24}$/.test(payload.petId))
    && payload.isPetChoiceMade === true
    && Number.isSafeInteger(payload.issuedAt)
    && Number.isSafeInteger(payload.expiresAt)
    && payload.expiresAt > payload.issuedAt;
}
